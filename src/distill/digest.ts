import fs from "node:fs";
import type { Writable } from "node:stream";
import type { ManifestEntry } from "../commands/export.js";
import { DEFAULT_CONCURRENCY, middleCut, type TruncatePolicy } from "../core/budget.js";
import {
  contentFingerprint,
  digestSourceFingerprint,
  fingerprint,
  sameLineage,
  stageLineage,
} from "../core/fingerprint.js";
import type { OutcomeEvidence } from "../core/outcome.js";
import {
  type ExportMessage,
  exportMessages,
  validatePreferenceCandidates,
} from "../core/preference-evidence.js";
import type { ResolvedCall, RunnerName } from "../runners/types.js";
import { glyph } from "../ui/mode.js";
import {
  counted,
  dim,
  fail,
  green,
  skip as skipGlyph,
  terminalExcerpt,
  terminalText,
} from "../ui/style.js";
import {
  type DigestLineage,
  type DigestsCheckpoint,
  loadDigests,
  newGeneration,
  saveDigests,
} from "./checkpoints.js";
import { type AttemptSettings, guardedPath, OperationStore } from "./operations.js";
import { buildDigestPrompt, DIGEST_PROMPT_VERSION } from "./prompts/digest.js";
import type { RetryHandler } from "./retry.js";
import {
  type Digest,
  DigestResponseSchema,
  DigestSchema,
  type PreferenceCandidate,
  toJsonSchema,
} from "./schemas.js";
import type { SavedSessionRead, StageProgressSink } from "./stage-events.js";
import {
  executeOperation,
  FailureBreaker,
  operationSettings,
  type RunnerFn,
  reusableOperation,
  runItems,
  type StageFailure,
  sourceReference,
  stageReporter,
  stageRunner,
} from "./stage-support.js";

/** Read `exports/outcomes.json` ({export → evidence}, `_note` ignored). */
function readOutcomes(home: string): Record<string, OutcomeEvidence> {
  try {
    const raw = fs.readFileSync(guardedPath(home, "exports/outcomes.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, OutcomeEvidence> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key === "_note" || typeof value !== "object" || value === null) continue;
      out[key] = value as OutcomeEvidence;
    }
    return out;
  } catch {
    return {};
  }
}
/** A session blocked because its content exceeds the input budget (--truncate=never). */
export interface BlockedSession {
  export: string;
  chars: number;
}

/** Result of the digest stage. */
export interface DigestStageResult {
  generation: string;
  /** Sessions digested by THIS run. */
  completed: number;
  /** Sessions reused from the checkpoint or a saved operation (resume). */
  skipped: number;
  failed: StageFailure[];
  /** Sessions blocked for exceeding the input budget under --truncate=never. */
  blocked: BlockedSession[];
  /** True when the systemic-failure breaker stopped the stage early. */
  aborted?: boolean;
  /** Why the breaker tripped (shown to the user). */
  abortReason?: string;
  /**
   * Sessions never attempted because the breaker tripped first. Reported so an
   * aborted run still accounts for every eligible session (never a silent drop).
   */
  notAttempted: string[];
}

/** Options for {@link runDigestStage}. */
export interface DigestStageOptions {
  home: string;
  /** Eligible manifest entries (post `--project` / `--min-substance`). */
  entries: ManifestEntry[];
  model?: string;
  /** Concrete CLI recorded for a retry. identityRunner is null for automatic selection. */
  runnerName?: RunnerName;
  identityRunner?: RunnerName | null;
  progress?: StageProgressSink;
  /** Injectable stage runner (default: the Claude adapter). */
  runner?: RunnerFn;
  /** Progress stream (default: process.stdout). */
  output?: Writable;
  /** Generation for a brand-new checkpoint (default: minted). */
  generation?: string;
  /** Max chars of content per digest call (default {@link DEFAULT_INPUT_BUDGET}). */
  budget?: number;
  /** Overflow policy when content exceeds the budget (default "never"). */
  truncate?: TruncatePolicy;
  /** Per-call timeout (ms) passed through to the runner. */
  timeoutMs?: number;
  /** Max digest calls in flight at once (default 10). */
  concurrency?: number;
  /**
   * Systemic-failure breaker (default true): stop after
   * {@link SYSTEMIC_FAILURE_STREAK} consecutive identical failures. `false`
   * (`--no-breaker`) attempts every session regardless.
   */
  breaker?: boolean;
}

/**
 * Quotes must occur in the exact input shown to the model. When an explicitly
 * truncated export renumbers visible messages, map them back to the original
 * source IDs only when the timestamp and quoted text identify one message.
 */
function validateDigestEvidence(
  digest: Digest,
  exportName: string,
  content: string,
  originalContent: string,
): { digest: Digest; problems: string[] } {
  const candidates = digest.preferences ?? [];
  const visibleMessages = exportMessages(exportName, content);
  const problems = validatePreferenceCandidates(candidates, visibleMessages);
  if (problems.length || content === originalContent) return { digest, problems };

  const originals = exportMessages(exportName, originalContent);
  const visibleById = new Map(visibleMessages.map((message) => [message.id, message]));
  const preferences: PreferenceCandidate[] = candidates.map((candidate) => ({
    ...candidate,
    citations: candidate.citations.map((citation) => {
      const visible = visibleById.get(citation.message_id);
      const matches = originals.filter(
        (message) =>
          message.timestamp === visible?.timestamp && message.text.includes(citation.quote),
      );
      if (matches.length !== 1) {
        problems.push(
          `quote in "${citation.message_id}" does not identify one original human message; omit this suggestion`,
        );
        return citation;
      }
      return { ...citation, message_id: matches[0]?.id ?? citation.message_id };
    }),
  }));
  if (!problems.length) {
    problems.push(...validatePreferenceCandidates(preferences, originals));
  }
  return { digest: { ...digest, preferences }, problems };
}

/**
 * The read with only the preferences whose evidence checks out. A quote the
 * model cannot ground after its one correction is its mistake about one
 * suggestion, so that suggestion is left out and the rest of the read is kept:
 * the goal, how the session ended, and every preference that does check out.
 * No preference is ever saved on evidence that was not verified.
 */
function keepVerifiedPreferences(
  digest: Digest,
  exportName: string,
  content: string,
  originalContent: string,
): { digest: Digest; dropped: number } {
  const kept: PreferenceCandidate[] = [];
  for (const candidate of digest.preferences ?? []) {
    const checked = validateDigestEvidence(
      { ...digest, preferences: [candidate] },
      exportName,
      content,
      originalContent,
    );
    if (!checked.problems.length) kept.push(...(checked.digest.preferences ?? []));
  }
  return {
    digest: { ...digest, preferences: kept },
    dropped: (digest.preferences ?? []).length - kept.length,
  };
}

/** One implementation serves both the read-only plan and the paid stage. */
function prepareDigest(
  entry: ManifestEntry,
  originalContent: string,
  content: string,
  outcome: OutcomeEvidence | undefined,
  opts: AttemptSettings,
): { prompt: string; lineage: DigestLineage } {
  const prompt = buildDigestPrompt({
    exportName: entry.export,
    content,
    outcome,
    origin: entry.origin,
  });
  const lineage: DigestLineage = {
    ...stageLineage({
      stage: "digest",
      promptVersion: DIGEST_PROMPT_VERSION,
      schema: toJsonSchema(DigestResponseSchema),
      inputs: {
        prompt,
        originalContent,
        outcome,
        project: entry.project,
        sessionId: entry.sessionId,
        origin: entry.origin ?? "claude",
      },
      model: opts.model ?? undefined,
      runnerName: opts.automatic ? null : opts.runner,
    }),
    project: entry.project,
    session_id: entry.sessionId,
    origin: entry.origin ?? "claude",
    observed_at: entry.last_ts,
    content_hash: contentFingerprint(originalContent),
    source_hash: digestSourceFingerprint({
      content: originalContent,
      outcome,
      project: entry.project,
      sessionId: entry.sessionId,
      origin: entry.origin,
    }),
  };
  return { prompt, lineage };
}

interface DigestInput {
  entry: ManifestEntry;
  outcome: OutcomeEvidence | null;
  contentHash: string;
}
interface DigestResult {
  digest: Digest;
  lineage: DigestLineage;
  /** Preferences left out of this read: their quoted words were not in the session. */
  droppedPreferences?: number;
}

function readSummary(
  project: string,
  digest: Digest,
  messages?: ExportMessage[],
): SavedSessionRead {
  const goal = terminalExcerpt(digest.goal, 160);
  const read = { project, goal, outcome: digest.outcome };
  for (const candidate of digest.preferences ?? []) {
    // A checkpoint loaded from disk can have been edited since publication.
    if (messages && validatePreferenceCandidates([candidate], messages).length) continue;
    const preference = terminalExcerpt(candidate.text, 160);
    if (preference) return { ...read, preference };
  }
  return read;
}

function prepareDigestRequest(logical: DigestInput, original: string, settings: AttemptSettings) {
  if (original.length > settings.budget && settings.truncate === "never")
    throw new Error(
      `The session is ${original.length.toLocaleString("en-US")} characters, over the size limit per call of ${settings.budget.toLocaleString("en-US")}`,
    );
  const cut = middleCut(original, settings.budget);
  return {
    ...prepareDigest(logical.entry, original, cut.text, logical.outcome ?? undefined, settings),
    originalContent: original,
    content: cut.text,
    dropped: cut.dropped,
  };
}

function readExport(home: string, name: string) {
  try {
    return fs.readFileSync(guardedPath(home, `exports/${name}`), "utf8");
  } catch (error) {
    throw new Error(`could not read export: ${(error as Error).message}`);
  }
}

type ReuseOptions = Pick<
  DigestStageOptions,
  "home" | "entries" | "model" | "runnerName" | "identityRunner" | "budget" | "truncate"
> & { fresh?: boolean };

/** Count previous results that are reusable or will actually be regenerated in the selected scope. */
export function planDigestReuse(opts: ReuseOptions): {
  reusable: number;
  regenerating: number;
  /** The exports whose saved read is reused, so the plan lists only real reads. */
  reused: string[];
} {
  const counts = { reusable: 0, regenerating: 0, reused: [] as string[] };
  const checkpoint = loadDigests(opts.home);
  if (!checkpoint) return counts;
  const outcomes = readOutcomes(opts.home);
  const settings = operationSettings(opts);
  for (const entry of opts.entries) {
    if (!checkpoint.digests[entry.export]) continue;
    try {
      const original = readExport(opts.home, entry.export);
      const logical = {
        entry,
        outcome: outcomes[entry.export] ?? null,
        contentHash: contentFingerprint(original),
      };
      const request = prepareDigestRequest(logical, original, settings);
      if (!opts.fresh && sameLineage(checkpoint.lineage?.[entry.export], request.lineage)) {
        counts.reusable++;
        counts.reused.push(entry.export);
      } else counts.regenerating++;
    } catch {
      /* Blocked or missing inputs cannot be regenerated. */
    }
  }
  return counts;
}
export function countReusableDigests(opts: ReuseOptions): number {
  return planDigestReuse(opts).reusable;
}

export function digestHandler(home: string, active?: DigestsCheckpoint): RetryHandler {
  return {
    guard(input) {
      const logical = input.logicalInput as DigestInput;
      if (
        fingerprint(readOutcomes(home)[logical.entry.export] ?? null) !==
        fingerprint(logical.outcome)
      )
        throw new Error(
          "Its export changed since it failed. Run npx human-hindsight reflect without --retry-failed to read it again.",
        );
    },
    prepare(input, settings) {
      const logical = input.logicalInput as DigestInput;
      // Strict attempts record this request whole; keep the shape it has always had.
      const { dropped: _dropped, ...request } = prepareDigestRequest(
        logical,
        readExport(home, logical.entry.export),
        settings,
      );
      return request;
    },
    async run(request, settings, input, invoke) {
      const logical = input.logicalInput as DigestInput;
      let prompt = request.prompt;
      let resolved: ResolvedCall | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await invoke({
          prompt,
          schema: DigestResponseSchema,
          model: settings.model ?? undefined,
          timeoutMs: settings.timeoutMs,
          onResolved(actual) {
            resolved = actual;
          },
        });
        const { digest, problems } = validateDigestEvidence(
          response,
          logical.entry.export,
          request.content as string,
          request.originalContent as string,
        );
        if (!problems.length)
          return { digest, lineage: { ...(request.lineage as DigestLineage), resolved } };
        if (attempt === 1) {
          // The correction did not fix it. The read is kept without the
          // preferences that could not be verified.
          const verified = keepVerifiedPreferences(
            response,
            logical.entry.export,
            request.content as string,
            request.originalContent as string,
          );
          return {
            digest: verified.digest,
            lineage: { ...(request.lineage as DigestLineage), resolved },
            droppedPreferences: verified.dropped,
          };
        }
        // The corrective retry is not printed: a person needs only the outcome.
        prompt = `${request.prompt}\n\nYour previous preference evidence had these problems:\n${problems.map((problem) => `- ${problem}`).join("\n")}\nCorrect every citation using the supplied human messages. Omit any unsupported suggestion.`;
      }
      throw new Error("The session summary's evidence could not be checked");
    },
    validate(value, input) {
      const result = value as DigestResult;
      DigestSchema.parse(result.digest);
      if (result.lineage?.version !== 1) throw new Error("Invalid saved digest lineage");
      const name = (input.logicalInput as DigestInput).entry.export;
      const problems = validatePreferenceCandidates(
        result.digest.preferences ?? [],
        exportMessages(name, readExport(home, name)),
      );
      if (problems.length)
        throw new Error(`The saved session summary's evidence is invalid: ${problems.join("; ")}`);
    },
    publish(value, input) {
      const result = value as DigestResult;
      const checkpoint = active ?? loadDigests(home);
      if (!checkpoint || checkpoint.generation !== input.generation)
        throw new Error("The saved session summaries changed while this ran");
      const id = (input.logicalInput as DigestInput).entry.export;
      checkpoint.digests[id] = result.digest;
      checkpoint.lineage ??= {};
      checkpoint.lineage[id] = result.lineage;
      checkpoint.invalidated = checkpoint.invalidated?.filter((key) => key !== id);
      if (!checkpoint.invalidated?.length) delete checkpoint.invalidated;
      saveDigests(home, checkpoint);
      return { kind: "digest", exportName: id, hash: fingerprint(result) };
    },
  };
}

/** Digest selected exports, checkpointing each completed call and containing individual failures. */
export async function runDigestStage(opts: DigestStageOptions): Promise<DigestStageResult> {
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY));
  const reporter = stageReporter(opts, concurrency);
  const state: DigestsCheckpoint = loadDigests(opts.home) ?? {
    generation: opts.generation ?? newGeneration(),
    prompt_version: DIGEST_PROMPT_VERSION,
    digests: {},
  };
  const previousVersion = state.prompt_version;
  state.prompt_version = DIGEST_PROMPT_VERSION;
  state.lineage ??= {};
  const outcomes = readOutcomes(opts.home);
  const store = new OperationStore(opts.home, state.generation);
  const handler = digestHandler(opts.home, state);
  const settings = operationSettings(opts);
  const run = stageRunner(opts.runner);
  const runId = newGeneration();
  const breaker = new FailureBreaker(opts.breaker !== false);
  const result: DigestStageResult = {
    generation: state.generation,
    completed: 0,
    skipped: 0,
    failed: [],
    blocked: [],
    notAttempted: [],
  };
  function invalidate(id: string) {
    if (!state.digests[id] && state.invalidated?.includes(id)) return;
    delete state.digests[id];
    delete state.lineage?.[id];
    state.invalidated = [...new Set([...(state.invalidated ?? []), id])].sort();
    saveDigests(opts.home, state);
  }
  reporter.start(opts.entries.length);
  try {
    // One plain line for the stage says why saved sessions are read again;
    // never one line per session.
    const versionChanged = previousVersion !== DIGEST_PROMPT_VERSION;
    let explained = false;
    const explainReread = () => {
      if (explained) return;
      explained = true;
      reporter.note(
        versionChanged
          ? "  Reading saved sessions again because this version reads them differently."
          : "  Reading sessions again whose text or settings changed since they were last read.",
      );
    };
    const unattempted = await runItems(opts.entries, concurrency, breaker, async (entry, index) => {
      const id = entry.export;
      const project =
        terminalText(typeof entry.project === "string" ? entry.project : "") || "Unknown project";
      const exportLabel = terminalExcerpt(id, 120);
      const label = `[${index + 1}/${opts.entries.length}] ${exportLabel}`;
      let called = false;
      try {
        const original = readExport(opts.home, id);
        const logical: DigestInput = {
          entry,
          outcome: outcomes[id] ?? null,
          contentHash: contentFingerprint(original),
        };
        const queue = (prompt: string) =>
          store.queue({
            kind: "digest",
            unitId: id,
            runId,
            generation: state.generation,
            promptVersion: DIGEST_PROMPT_VERSION,
            schema: toJsonSchema(DigestResponseSchema),
            logicalInput: logical,
            sources: [sourceReference(id, original)],
            settings,
            request: { prompt },
            publication: { kind: "digest", exportName: id },
          });
        if (original.length > settings.budget && settings.truncate === "never") {
          invalidate(id);
          const prompt = buildDigestPrompt({
            exportName: id,
            content: original,
            outcome: outcomes[id],
            origin: entry.origin,
          });
          store.block(
            queue(prompt).id,
            `input ${original.length} exceeds budget ${settings.budget}`,
          );
          result.blocked.push({ export: id, chars: original.length });
          reporter.item(
            id,
            "blocked",
            `  ${label}: ${skipGlyph(`blocked: ${original.length} chars exceed the input budget (${settings.budget}).`)} Use npx human-hindsight reflect --truncate=extreme to shorten it, or raise --input-budget.`,
            true,
            `${exportLabel}: ${counted(original.length, "character")}, over the size limit per call of ${settings.budget.toLocaleString("en-US")}. Use npx human-hindsight reflect --truncate=extreme to shorten it, or raise --input-budget.`,
          );
          return;
        }
        const request = prepareDigestRequest(logical, original, settings);
        const cached = state.digests[id];
        if (cached && sameLineage(state.lineage?.[id], request.lineage)) {
          result.skipped++;
          reporter.read(
            id,
            "skipped",
            readSummary(
              project,
              cached,
              cached.preferences?.length ? exportMessages(id, original) : undefined,
            ),
            `  ${label}: already read (unchanged; skipped)`,
          );
          return;
        }
        if (state.digests[id]) explainReread();
        if (request.dropped)
          reporter.detail(
            `  ${exportLabel}: shortened by ${counted(request.dropped, "character")} to fit the size limit per call`,
          );
        const saved = reusableOperation(store, "digest", id, logical, settings, {
          promptVersion: DIGEST_PROMPT_VERSION,
          schema: toJsonSchema(DigestResponseSchema),
          prompt: request.prompt,
        });
        const operation = saved ?? queue(request.prompt);
        invalidate(id);
        called = !saved;
        if (called) reporter.running(id, exportLabel, project);
        const value = (await reporter.until(`${label}: reading`, () =>
          executeOperation({ store, operation, request, settings, handler, run, publish: true }),
        )) as DigestResult;
        if (saved) result.skipped++;
        else result.completed++;
        breaker.success();
        if (value.droppedPreferences)
          reporter.detail(
            `  ${exportLabel}: left out ${counted(value.droppedPreferences, "preference")} whose quoted words were not found in the session`,
          );
        const read = readSummary(project, value.digest);
        reporter.read(
          id,
          saved ? "skipped" : "done",
          read,
          `  ${label} ${glyph("→", "->")} ${green(read.outcome)}: ${read.goal}`,
        );
      } catch (error) {
        invalidate(id);
        const message = error instanceof Error ? error.message : String(error);
        result.failed.push({ export: id, error: message });
        reporter.item(
          id,
          "failed",
          `  ${label} ${fail(`failed: ${terminalExcerpt(message, 120)}`)}`,
          true,
          `${exportLabel}: ${terminalExcerpt(message, 120)}`,
        );
        if (called) breaker.failure(error);
      }
    });
    result.notAttempted = unattempted.map((entry) => entry.export);
    if (result.notAttempted.length && breaker.reason) {
      result.aborted = true;
      result.abortReason = breaker.reason;
      reporter.note(
        dim(
          `  ${terminalExcerpt(breaker.reason, 220)}. ${counted(result.notAttempted.length, "session")} not attempted. Fix the cause and resume with npx human-hindsight reflect, or use --no-breaker.`,
        ),
      );
    }
    return result;
  } finally {
    // Anything still held (a queued unit that never dispatched) reaches the disk.
    store.flush();
    reporter.end();
  }
}
