import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import { z } from "zod";
import {
  AUTHOR_PROMPT_VERSION,
  type AuthorMemberInput,
  buildAuthorPrompt,
} from "../claude/prompts/author.js";
import {
  buildClusterPrompt,
  buildMergePrompt,
  CLUSTER_PROMPT_VERSION,
} from "../claude/prompts/cluster.js";
import { buildDigestPrompt, DIGEST_PROMPT_VERSION } from "../claude/prompts/digest.js";
import { DEFAULT_TIMEOUT_MS, type RunClaudeOptions, runClaude } from "../claude/runner.js";
import {
  AuthorSchema,
  type Cluster,
  type ClusterMerge,
  ClusterMergeSchema,
  ClusterSchema,
  type ClusterTask,
  type Digest,
  DigestResponseSchema,
  DigestSchema,
  type PreferenceCandidate,
  toJsonSchema,
} from "../claude/schemas.js";
import type { ManifestEntry } from "../commands/distill.js";
import type { AnaphoraRecord } from "../core/anaphora.js";
import { parseAnaphoraMap, parseSourcesJson } from "../core/artifacts.js";
import { DEFAULT_INPUT_BUDGET, middleCut, type TruncatePolicy } from "../core/budget.js";
import {
  contentFingerprint,
  digestSourceFingerprint,
  fingerprint,
  type StageLineage,
  sameLineage,
  stageLineage,
} from "../core/fingerprint.js";
import { atomicWriteFilePrivate, mkdirPrivate } from "../core/fsutil.js";
import { oneshotHash } from "../core/library.js";
import type { OutcomeEvidence } from "../core/outcome.js";
import { exportMessages, validatePreferenceCandidates } from "../core/preference-evidence.js";
import type { SourceName } from "../sources/types.js";
import { withSpinner } from "../ui/progress.js";
import { dim, fail, green, skip as skipGlyph } from "../ui/style.js";
import {
  type AttemptSettings,
  checkSourceGuards,
  guardedPath,
  type OperationInput,
  type OperationRecord,
  OperationStore,
  type PreparedRequest,
  type QueueOperation,
} from "./operations.js";
import type { RetryHandler } from "./retry.js";

/**
 * distill/pipeline.ts — stage orchestration, checkpoints, generations.
 *
 * Every LLM stage checkpoints to `<home>/distill/` after EACH unit of work, so
 * Ctrl-C never loses paid progress and re-running skips completed work.
 * Checkpoints carry a generation id minted when a fresh pipeline starts;
 * downstream stages and `sources.json` copy it so `status` can flag artifacts
 * orphaned by re-clustering (`distill --fresh` resets deliberately).
 */

/** Signature of the stage runner — {@link runClaude} or a test double. */
export type RunnerFn = <T>(opts: RunClaudeOptions<T>) => Promise<T>;

/** Attempt settings are durable independently of normal cache lineage. */
function operationSettings(
  opts: {
    model?: string;
    runnerName?: SourceName;
    timeoutMs?: number;
    budget?: number;
    truncate?: TruncatePolicy;
  },
  timeoutUnits = 0,
): AttemptSettings {
  return {
    runner: opts.runnerName ?? "claude",
    model: opts.model ?? null,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS + CLUSTER_TIMEOUT_PER_DIGEST_MS * timeoutUnits,
    timeoutExplicit: opts.timeoutMs !== undefined,
    budget: opts.budget ?? DEFAULT_INPUT_BUDGET,
    truncate: opts.truncate ?? "never",
  };
}

function sourceReference(exportName: string, content: string) {
  return {
    path: `exports/${exportName}`,
    hash: contentFingerprint(content),
    length: content.length,
  };
}

/** A normal run can adopt an exact saved inference result without buying it again. */
function reusableOperation(
  store: OperationStore,
  kind: OperationRecord["kind"],
  unitId: string,
  logicalInput: unknown,
  settings: AttemptSettings,
): OperationRecord | undefined {
  return store.list().find((record) => {
    if (record.kind !== kind || record.unitId !== unitId || record.state !== "result-saved")
      return false;
    const input = store.loadInput(record.id);
    return (
      fingerprint(input.logicalInput) === fingerprint(logicalInput) &&
      fingerprint(record.attempts.at(-1)?.settings ?? input.settings) === fingerprint(settings) &&
      Boolean(store.readResult(record.id))
    );
  });
}

/** The `distill/digests.json` checkpoint. */
export interface DigestsCheckpoint {
  generation: string;
  prompt_version: number;
  digests: Record<string, Digest>;
  /** Missing on legacy checkpoints, whose freshness cannot be established. */
  lineage?: Record<string, DigestLineage>;
  /** Failed/interrupted refreshes must not resurrect old library preferences. */
  invalidated?: string[];
}

/** The source identity accompanies the digest even when no prompt is authored. */
export interface DigestLineage extends StageLineage {
  project: string;
  session_id: string;
  origin: SourceName;
  observed_at: string;
  content_hash: string;
  source_hash: string;
}

/** Mint a new generation id: compact UTC stamp + short random suffix. */
export function newGeneration(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${crypto.randomBytes(2).toString("hex")}`;
}

function digestsPath(home: string): string {
  return path.join(home, "distill", "digests.json");
}

/** Load the digests checkpoint; absent or unreadable → null (never throws). */
export function loadDigests(home: string): DigestsCheckpoint | null {
  try {
    const raw = fs.readFileSync(digestsPath(home), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.generation !== "string") return null;
    // Validate each digest independently and keep the valid ones: a single
    // corrupt entry must not discard the whole (paid) checkpoint. A dropped
    // key simply gets re-digested on the next run.
    const invalidated = Array.isArray(obj.invalidated)
      ? obj.invalidated.filter((value): value is string => typeof value === "string")
      : [];
    const digests: Record<string, Digest> = {};
    if (obj.digests && typeof obj.digests === "object") {
      for (const [key, value] of Object.entries(obj.digests as Record<string, unknown>)) {
        if (invalidated.includes(key)) continue;
        const d = DigestSchema.safeParse(value);
        if (d.success) digests[key] = d.data;
      }
    }
    const prompt_version =
      typeof obj.prompt_version === "number" ? obj.prompt_version : DIGEST_PROMPT_VERSION;
    const lineage: Record<string, DigestLineage> = {};
    if (obj.lineage && typeof obj.lineage === "object") {
      for (const [key, value] of Object.entries(obj.lineage)) {
        if (
          key in digests &&
          value !== null &&
          typeof value === "object" &&
          (value as Partial<DigestLineage>).version === 1 &&
          typeof (value as Partial<DigestLineage>).fingerprint === "string"
        ) {
          lineage[key] = value as DigestLineage;
        }
      }
    }
    return {
      generation: obj.generation,
      prompt_version,
      digests,
      ...(Object.keys(lineage).length ? { lineage } : {}),
      ...(invalidated.length ? { invalidated } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Persist the digests checkpoint atomically (tmp file + rename) so a Ctrl-C
 * mid-write can never corrupt previously saved progress.
 */
export function saveDigests(home: string, checkpoint: DigestsCheckpoint): void {
  const target = digestsPath(home);
  mkdirPrivate(path.dirname(target));
  atomicWriteFilePrivate(target, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

/** Delete distill checkpoints (used by `distill --fresh`). */
export function clearCheckpoints(home: string): void {
  for (const file of ["digests.json", "tasks.json"]) {
    fs.rmSync(path.join(home, "distill", file), { force: true });
  }
}

/** Read `exports/outcomes.json` ({export → evidence}, `_note` ignored). */
function readOutcomes(home: string): Record<string, OutcomeEvidence> {
  try {
    const raw = fs.readFileSync(path.join(home, "exports", "outcomes.json"), "utf8");
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

/** One session that could not be digested this run. */
export interface StageFailure {
  export: string;
  error: string;
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
  /** Sessions already present in the checkpoint (resume). */
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

/**
 * Consecutive identical failures that trip the systemic-failure breaker.
 *
 * Per-session containment is right for a session-specific problem, but an
 * unbroken run of byte-identical errors is an environment problem (a reshaped
 * CLI envelope, a revoked credential, a missing binary), and every further
 * session pays for it twice over because each failure also burns the runner's
 * one corrective retry. Five is comfortably past any plausible coincidence of
 * distinct sessions failing the same way, and small enough to stop a 92-session
 * run while it is still cheap.
 */
export const SYSTEMIC_FAILURE_STREAK = 5;

/** Options for {@link runDigestStage}. */
export interface DigestStageOptions {
  home: string;
  /** Eligible manifest entries (post `--project` / `--min-substance`). */
  entries: ManifestEntry[];
  model?: string;
  /** Runner identity is part of the checkpoint, independently of the source. */
  runnerName?: SourceName;
  /** Injectable stage runner (default: real {@link runClaude}). */
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
  /** Max digest calls in flight at once (default 1 — sequential). */
  concurrency?: number;
  /**
   * Systemic-failure breaker (default true): stop after
   * {@link SYSTEMIC_FAILURE_STREAK} consecutive identical failures. `false`
   * (`--no-breaker`) attempts every session regardless.
   */
  breaker?: boolean;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
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

/** One implementation serves both the read-only plan and the paid stage. */
function prepareDigest(
  entry: ManifestEntry,
  originalContent: string,
  content: string,
  outcome: OutcomeEvidence | undefined,
  opts: Pick<DigestStageOptions, "model" | "runnerName">,
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
      model: opts.model,
      runnerName: opts.runnerName,
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

/**
 * Report genuinely reusable digests before consent. This does not rewrite
 * legacy checkpoints or mark stale records; the paid stage owns mutations.
 */
export function countReusableDigests(
  opts: Pick<
    DigestStageOptions,
    "home" | "entries" | "model" | "runnerName" | "budget" | "truncate"
  >,
): number {
  const checkpoint = loadDigests(opts.home);
  if (!checkpoint) return 0;
  const outcomes = readOutcomes(opts.home);
  const budget = opts.budget ?? DEFAULT_INPUT_BUDGET;
  let reusable = 0;
  for (const entry of opts.entries) {
    if (!checkpoint.digests[entry.export]) continue;
    try {
      const originalContent = fs.readFileSync(
        path.join(opts.home, "exports", entry.export),
        "utf8",
      );
      if (originalContent.length > budget && opts.truncate !== "extreme") continue;
      const content =
        originalContent.length > budget ? middleCut(originalContent, budget).text : originalContent;
      const { lineage } = prepareDigest(
        entry,
        originalContent,
        content,
        outcomes[entry.export],
        opts,
      );
      if (sameLineage(checkpoint.lineage?.[entry.export], lineage)) reusable++;
    } catch {
      // Missing exports and malformed evidence cannot establish freshness.
    }
  }
  return reusable;
}

/**
 * Stage 1 — digest every eligible session (one `claude` call each).
 *
 * Resumable: sessions already in the checkpoint are skipped; the checkpoint is
 * saved after EVERY successful digest; one session's failure never aborts the
 * rest — progress is kept, failures are reported, re-running resumes.
 */
export async function runDigestStage(opts: DigestStageOptions): Promise<DigestStageResult> {
  const runner: RunnerFn = opts.runner ?? runClaude;
  const out = opts.output ?? process.stdout;
  const write = (s: string) => out.write(`${s}\n`);

  const loaded = loadDigests(opts.home);
  const checkpoint: DigestsCheckpoint = loaded ?? {
    generation: opts.generation ?? newGeneration(),
    prompt_version: DIGEST_PROMPT_VERSION,
    digests: {},
  };
  checkpoint.lineage ??= {};
  if (loaded && loaded.prompt_version !== DIGEST_PROMPT_VERSION) {
    write(
      `  ⚠ existing digests were produced by prompt v${loaded.prompt_version}; current is v${DIGEST_PROMPT_VERSION}. Changed inputs will be regenerated.`,
    );
  }
  checkpoint.prompt_version = DIGEST_PROMPT_VERSION;

  const store = new OperationStore(opts.home, checkpoint.generation);
  const runId = newGeneration();
  const outcomes = readOutcomes(opts.home);
  const failed: StageFailure[] = [];
  const blocked: BlockedSession[] = [];
  const budget = opts.budget ?? DEFAULT_INPUT_BUDGET;
  const truncatePolicy: TruncatePolicy = opts.truncate ?? "never";
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
  let completed = 0;
  let skipped = 0;
  const total = opts.entries.length;

  // --- systemic-failure breaker (see SYSTEMIC_FAILURE_STREAK) ---------------
  // Tracks the current run of byte-identical failure messages. Any success, or
  // any differently-worded failure, resets it: only an unbroken streak looks
  // like a broken environment rather than a set of unlucky sessions.
  const breakerEnabled = opts.breaker !== false;
  let streakMessage: string | null = null;
  let streakCount = 0;
  let aborted = false;
  let abortReason: string | undefined;
  const attempted = new Set<string>();

  /** Digest one session end-to-end (skip / read / budget / call / checkpoint). */
  const digestOne = async (entry: ManifestEntry, i: number): Promise<void> => {
    const label = `[${i + 1}/${total}] ${entry.export}`;
    const previous = checkpoint.digests[entry.export];
    const invalidate = () => {
      if (!checkpoint.digests[entry.export] && checkpoint.invalidated?.includes(entry.export))
        return;
      delete checkpoint.digests[entry.export];
      delete checkpoint.lineage?.[entry.export];
      checkpoint.invalidated = [
        ...new Set([...(checkpoint.invalidated ?? []), entry.export]),
      ].sort();
      saveDigests(opts.home, checkpoint);
    };

    let content: string;
    try {
      content = fs.readFileSync(path.join(opts.home, "exports", entry.export), "utf8");
    } catch (err) {
      invalidate();
      failed.push({
        export: entry.export,
        error: `could not read export: ${(err as Error).message}`,
      });
      write(`  ${label} — ${fail("unreadable export")}`);
      return;
    }
    const originalContent = content;
    let operation: OperationRecord | undefined;
    const logicalInput = {
      entry,
      outcome: outcomes[entry.export] ?? null,
      contentHash: contentFingerprint(originalContent),
    };
    const settings = operationSettings(opts);
    const queueDigest = (prompt: string) =>
      store.queue({
        kind: "digest",
        unitId: entry.export,
        generation: checkpoint.generation,
        runId,
        promptVersion: DIGEST_PROMPT_VERSION,
        schema: toJsonSchema(DigestResponseSchema),
        logicalInput,
        sources: [sourceReference(entry.export, originalContent)],
        settings,
        request: { prompt },
        publication: { kind: "digest", exportName: entry.export },
      });

    // Input budget / overflow policy. Nothing is cut silently.
    if (content.length > budget) {
      if (truncatePolicy === "never") {
        invalidate();
        operation = queueDigest(
          buildDigestPrompt({
            exportName: entry.export,
            content,
            outcome: outcomes[entry.export],
            origin: entry.origin,
          }),
        );
        store.block(operation.id, `input ${content.length} exceeds budget ${budget}`);
        blocked.push({ export: entry.export, chars: content.length });
        write(
          `  ${label} — ${skipGlyph(`blocked: ${content.length} chars exceed the input budget (${budget}).`)} ` +
            "Re-run with --truncate=extreme or a larger --input-budget.",
        );
        return; // pre-spend block — no claude call
      }
      const cut = middleCut(content, budget);
      content = cut.text;
      write(`  ${label} — ✂ cut ${cut.dropped} chars to fit the input budget (--truncate=extreme)`);
    }

    try {
      const { prompt, lineage } = prepareDigest(
        entry,
        originalContent,
        content,
        outcomes[entry.export],
        opts,
      );
      if (previous && sameLineage(checkpoint.lineage?.[entry.export], lineage)) {
        skipped++;
        write(`  ${label} — already digested (inputs unchanged; skipped)`);
        return;
      }
      if (previous) {
        write(`  ${label} — input, model, or prompt changed; regenerating stale digest`);
      }
      // A failed refresh must not let downstream stages consume the old digest.
      operation =
        reusableOperation(store, "digest", entry.export, logicalInput, settings) ??
        queueDigest(prompt);
      invalidate();
      write(`  ${label} — digesting…`);
      const saved = store.readResult(operation.id);
      checkSourceGuards(opts.home, store.loadInput(operation.id).sources);
      const attempt = saved ? undefined : store.start(operation.id, settings, { prompt });
      const call = async (): Promise<Digest> => {
        let currentPrompt = prompt;
        for (let attempt = 0; attempt < 2; attempt++) {
          const currentAttempt = store
            .list()
            .find((record) => record.id === operation?.id)
            ?.attempts.at(-1);
          if (operation && currentAttempt)
            store.recordInvocation(operation.id, currentAttempt.id, {
              prompt: currentPrompt,
              schema: toJsonSchema(DigestResponseSchema),
              model: opts.model ?? null,
              timeoutMs: settings.timeoutMs,
            });
          const response = await runner({
            prompt: currentPrompt,
            schema: DigestResponseSchema,
            model: opts.model,
            timeoutMs: opts.timeoutMs,
          });
          const { digest, problems } = validateDigestEvidence(
            response,
            entry.export,
            content,
            originalContent,
          );
          if (!problems.length) return digest;
          if (attempt === 1) {
            throw new Error(
              `digest evidence failed validation after one retry: ${problems.join("; ")}`,
            );
          }
          write(`  ${label} — preference evidence failed validation; retrying once…`);
          currentPrompt =
            `${prompt}\n\nYour previous preference evidence had these problems:\n` +
            `${problems.map((problem) => `- ${problem}`).join("\n")}\n` +
            "Correct every citation using the supplied human messages. Omit any unsupported suggestion.";
        }
        throw new Error("digest evidence could not be validated");
      };
      // A spinner is a single-line UI; with parallel calls in flight the lines
      // would fight over the cursor — plain progress lines instead.
      const digest = saved
        ? DigestSchema.parse((saved.value as { digest: unknown }).digest)
        : concurrency === 1
          ? await withSpinner(out, `${label} — digesting`, call)
          : await call();
      if (!saved && attempt) store.saveResult(operation.id, attempt.id, { digest, lineage });
      checkSourceGuards(opts.home, store.loadInput(operation.id).sources);
      // Mutation + save are synchronous (single JS tick), so concurrent
      // workers can never interleave a checkpoint write — saves stay serialized.
      checkpoint.digests[entry.export] = digest;
      checkpoint.lineage ??= {};
      checkpoint.lineage[entry.export] = lineage;
      checkpoint.invalidated = checkpoint.invalidated?.filter((id) => id !== entry.export);
      if (!checkpoint.invalidated?.length) delete checkpoint.invalidated;
      saveDigests(opts.home, checkpoint); // after each — Ctrl-C safe
      store.commit(operation.id, {
        kind: "digest",
        exportName: entry.export,
        hash: fingerprint({ digest, lineage }),
      });
      completed++;
      // A success proves the environment works: the streak is not systemic.
      streakMessage = null;
      streakCount = 0;
      write(`  ${label} → ${green(digest.outcome)}: ${truncate(digest.goal, 70)}`);
    } catch (err) {
      invalidate();
      const message = err instanceof Error ? err.message : String(err);
      if (operation && !store.readResult(operation.id)) store.fail(operation.id, message);
      failed.push({ export: entry.export, error: message });
      write(`  ${label} ${fail(`failed: ${truncate(message, 120)}`)}`);
      // continue — one failure doesn't abort the rest (per-session containment).
      // But an unbroken run of IDENTICAL failures is an environment problem, and
      // continuing just buys the same error N more times at two calls each.
      if (message === streakMessage) {
        streakCount++;
      } else {
        streakMessage = message;
        streakCount = 1;
      }
      if (
        breakerEnabled &&
        !aborted &&
        streakCount >= SYSTEMIC_FAILURE_STREAK &&
        total > SYSTEMIC_FAILURE_STREAK
      ) {
        aborted = true;
        abortReason =
          `${streakCount} consecutive sessions failed with the identical error, which points at ` +
          "the environment rather than these sessions. Stopping before spending more calls";
        write("");
        write(fail(`  ⚠ ${abortReason}:`));
        write(`      ${truncate(message, 160)}`);
        write(
          dim(
            "      Nothing already digested is lost; fix the cause and re-run to resume.\n" +
              "      Re-run with --no-breaker to attempt every session anyway.",
          ),
        );
      }
    }
  };

  // Bounded worker pool: N workers pull the next un-started entry until none
  // remain. concurrency=1 degrades to the exact sequential behavior.
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < opts.entries.length) {
      // Stop pulling new work once the breaker trips. In-flight siblings finish
      // naturally, so nothing is abandoned mid-write and the checkpoint stays
      // consistent.
      if (aborted) return;
      const i = nextIndex++;
      const entry = opts.entries[i];
      if (entry) {
        attempted.add(entry.export);
        await digestOne(entry, i);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(total, 1)) }, () => worker()),
  );

  // Account for every eligible session: an aborted run reports what it never
  // reached rather than leaving the count silently short.
  const notAttempted = opts.entries.map((e) => e.export).filter((name) => !attempted.has(name));
  if (aborted && notAttempted.length > 0) {
    write(dim(`      ${notAttempted.length} session(s) not attempted.`));
  }

  return {
    generation: checkpoint.generation,
    completed,
    skipped,
    failed,
    blocked,
    notAttempted,
    ...(aborted ? { aborted, abortReason } : {}),
  };
}

// --- stage 2: cluster --------------------------------------------------------

/** The `distill/tasks.json` checkpoint. */
export interface TasksCheckpoint {
  generation: string;
  prompt_version: number;
  tasks: ClusterTask[];
  misc: string[];
  lineage?: StageLineage;
  operation_ids?: string[];
  fallback_merge_id?: string;
  grouping_hash?: string;
}

function tasksPath(home: string): string {
  return path.join(home, "distill", "tasks.json");
}

/** Zod shape for the tasks checkpoint; task shape reused from ClusterSchema. */
const TasksCheckpointSchema = z.looseObject({
  generation: z.string(),
  prompt_version: z.number().catch(0),
  tasks: ClusterSchema.shape.tasks,
  misc: z.array(z.string()).catch([]),
});

/** Load the tasks checkpoint; absent, unreadable, or malformed → null (never throws). */
export function loadTasks(home: string): TasksCheckpoint | null {
  try {
    const raw = fs.readFileSync(tasksPath(home), "utf8");
    const parsed = TasksCheckpointSchema.safeParse(JSON.parse(raw));
    // A malformed grouping must not corrupt coverage math — reject wholesale so
    // the cluster stage re-runs (one call) rather than trusting bad tasks.
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Persist the tasks checkpoint atomically (tmp + rename). */
export function saveTasks(home: string, checkpoint: TasksCheckpoint): void {
  const target = tasksPath(home);
  mkdirPrivate(path.dirname(target));
  atomicWriteFilePrivate(target, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

/** Unique kebab slug of 2–5 words (1–4 dashes). */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+){1,4}$/;

/**
 * Canonicalize member ids in a cluster response against the known input ids.
 *
 * Real-model failure mode (observed with sonnet on the first real run): every
 * id returned without its `.md` extension — semantically perfect grouping,
 * rejected by exact-string validation, one wasted retry. Repair is strictly
 * lossless: an unknown id is replaced only when exactly one known id matches
 * it after stripping the extension; anything else is left for validation to
 * report. Returns a new Cluster; the original is not mutated.
 */
export function canonicalizeClusterIds(cluster: Cluster, inputIds: string[]): Cluster {
  const known = new Set(inputIds);
  const byStem = new Map<string, string[]>();
  for (const id of inputIds) {
    const stem = id.replace(/\.md$/, "");
    byStem.set(stem, [...(byStem.get(stem) ?? []), id]);
  }
  const repair = (member: string): string => {
    if (known.has(member)) return member;
    const candidates = byStem.get(member.replace(/\.md$/, ""));
    return candidates?.length === 1 && candidates[0] ? candidates[0] : member;
  };
  return {
    tasks: cluster.tasks.map((t) => ({ ...t, members: t.members.map(repair) })),
    misc: cluster.misc.map(repair),
  };
}

/**
 * Validate a clustering against the input ids — fail loudly:
 * slug format + uniqueness, full coverage (every id lands in a task or misc),
 * and no invented ids. Returns a list of problems; empty means valid.
 */
export function validateCluster(cluster: Cluster, inputIds: string[]): string[] {
  const problems: string[] = [];
  const known = new Set(inputIds);
  const seenSlugs = new Set<string>();

  for (const task of cluster.tasks) {
    if (!SLUG_PATTERN.test(task.slug)) {
      problems.push(`slug "${task.slug}" is not 2-5 kebab-case words`);
    }
    if (seenSlugs.has(task.slug)) {
      problems.push(`duplicate slug "${task.slug}"`);
    }
    seenSlugs.add(task.slug);
    if (task.members.length === 0) {
      problems.push(`task "${task.slug}" has no members`);
    }
    for (const member of task.members) {
      if (!known.has(member)) {
        problems.push(`task "${task.slug}" references unknown session "${member}"`);
      }
    }
  }
  for (const member of cluster.misc) {
    if (!known.has(member)) {
      problems.push(`misc references unknown session "${member}"`);
    }
  }

  const covered = new Set<string>(cluster.misc);
  for (const task of cluster.tasks) {
    for (const member of task.members) covered.add(member);
  }
  for (const id of inputIds) {
    if (!covered.has(id)) {
      problems.push(`session "${id}" was dropped (not in any task or misc)`);
    }
  }

  return problems;
}

/** Deterministic slug from an export file name (for `--no-group`). */
function slugFromExportName(exportName: string, used: Set<string>): string {
  const stem = exportName.replace(/\.md$/, "");
  let segments = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 5);
  if (segments.length === 0) segments = ["session"];
  if (segments.length === 1) segments.push("session"); // pattern needs ≥2 words
  let slug = segments.join("-");
  // Collisions: bump a numeric final segment (stays within the 5-word cap).
  for (let n = 2; used.has(slug); n++) {
    slug = [...segments.slice(0, 4), String(n)].join("-");
  }
  used.add(slug);
  return slug;
}

/**
 * `--no-group`: synthesize a 1 session = 1 task clustering deterministically —
 * no LLM call, no misc routing (the substance pre-filter already ran).
 */
export function synthesizeNoGroupTasks(digests: Record<string, Digest>): Cluster {
  const used = new Set<string>();
  const tasks: ClusterTask[] = Object.keys(digests)
    .sort()
    .map((exportName) => ({
      slug: slugFromExportName(exportName, used),
      title: digests[exportName]?.goal || exportName,
      rationale: "1 session = 1 task (--no-group)",
      members: [exportName],
    }));
  return { tasks, misc: [] };
}

/** Result of the cluster stage. */
export interface ClusterStageResult {
  generation: string;
  tasks: ClusterTask[];
  misc: string[];
  /** True when the checkpoint already covered this input (no call made). */
  resumed: boolean;
}

/**
 * Extra timeout allowance per digest for the cluster call. Clustering is a
 * SINGLE call over ALL digests, so unlike digest/author calls its wall-clock
 * cost grows with corpus size; the flat {@link DEFAULT_TIMEOUT_MS} that suits
 * per-session calls times out on large runs (observed at 84 digests). An
 * explicit `--timeout` still wins over the scaled default.
 */
export const CLUSTER_TIMEOUT_PER_DIGEST_MS = 5_000;

/**
 * Split the corpus into windows bounded by prompt size and, when requested,
 * digest count. A single oversized digest gets its own window rather than
 * being dropped. Sorted, deterministic, order-preserving: re-running the same
 * corpus plans the same windows.
 */
export function planClusterWindows(
  digests: Record<string, Digest>,
  origins: Record<string, SourceName> | undefined,
  budget: number | undefined,
  batchSize?: number,
): string[][] {
  if (batchSize !== undefined && (!Number.isSafeInteger(batchSize) || batchSize < 1))
    throw new Error("Cluster batch size must be a positive integer");
  const ids = Object.keys(digests).sort();
  if (
    (batchSize === undefined || ids.length <= batchSize) &&
    (budget === undefined || buildClusterPrompt(digests, origins).length <= budget)
  )
    return [ids];

  const windows: string[][] = [];
  let current: string[] = [];
  for (const id of ids) {
    // Measure the actual candidate prompt: its count and source label can
    // change as a window grows, so summing singleton sizes can exceed budget.
    const candidate = [...current, id];
    const overBudget =
      budget !== undefined &&
      buildClusterPrompt(
        Object.fromEntries(candidate.map((key) => [key, digests[key] as Digest])),
        origins,
      ).length > budget;
    if (
      current.length > 0 &&
      (overBudget || (batchSize !== undefined && current.length >= batchSize))
    ) {
      windows.push(current);
      current = [];
    }
    current.push(id);
  }
  if (current.length > 0) windows.push(current);
  return windows;
}

/**
 * Suffix a slug for uniqueness WITHOUT breaking the 2-5 word slug rule.
 *
 * Appending to a 5-word slug would produce a 6-word slug, which
 * {@link validateCluster} rejects; since a slug is also a path component, the
 * task would be unwritable. So append only while there is room, and otherwise
 * replace the final word with the counter, keeping the word count fixed.
 */
function suffixSlug(slug: string, n: number): string {
  const words = slug.split("-");
  return words.length < 5 ? `${slug}-${n}` : [...words.slice(0, 4), String(n)].join("-");
}

/**
 * Apply a merge response to the combined window tasks. Deterministic and
 * defensive: an entry is applied only when every referenced slug exists, it
 * names at least two tasks, no slug was already consumed by an earlier entry,
 * and its replacement slug is well-formed; anything else is skipped with a note
 * (the unmerged union is still a fully valid grouping). Members of merged tasks
 * are unioned and deduped.
 *
 * The slug check is what keeps this path safe to write. Every other cluster
 * response passes {@link validateCluster} before anything is saved, but the
 * merge call runs AFTER per-window validation and `ClusterMergeSchema` types
 * the replacement slug as a bare string. A task slug is also a path component
 * (`library/<slug>/…`), so a response of `"Payments Work"` or `"../../escaped"`
 * would otherwise become a directory name.
 */
export function applyClusterMerges(
  tasks: ClusterTask[],
  merges: ClusterMerge["merges"],
): { tasks: ClusterTask[]; notes: string[] } {
  const bySlug = new Map(tasks.map((t) => [t.slug, t]));
  const consumed = new Set<string>();
  const merged: ClusterTask[] = [];
  const notes: string[] = [];

  for (const entry of merges) {
    const missing = entry.slugs.filter((s) => !bySlug.has(s));
    if (missing.length > 0) {
      notes.push(`merge skipped: unknown slug(s) ${missing.join(", ")}`);
      continue;
    }
    if (entry.slugs.length < 2) {
      notes.push(`merge skipped: fewer than two slugs (${entry.slugs.join(", ") || "none"})`);
      continue;
    }
    const doubly = entry.slugs.filter((s) => consumed.has(s));
    if (doubly.length > 0) {
      notes.push(`merge skipped: slug(s) already merged ${doubly.join(", ")}`);
      continue;
    }
    if (!SLUG_PATTERN.test(entry.slug)) {
      notes.push(`merge skipped: slug "${entry.slug}" is not 2-5 kebab-case words`);
      continue;
    }
    for (const s of entry.slugs) consumed.add(s);
    const members = [
      ...new Set(entry.slugs.flatMap((s) => (bySlug.get(s) as ClusterTask).members)),
    ];
    merged.push({ slug: entry.slug, title: entry.title, rationale: entry.rationale, members });
  }

  const kept = tasks.filter((t) => !consumed.has(t.slug));
  // A merged slug may collide with a kept task's slug; suffix deterministically.
  const finalTasks = [...kept];
  const seen = new Set(kept.map((t) => t.slug));
  for (const m of merged) {
    let slug = m.slug;
    for (let n = 2; seen.has(slug); n++) slug = suffixSlug(m.slug, n);
    seen.add(slug);
    finalTasks.push(slug === m.slug ? m : { ...m, slug });
  }
  return { tasks: finalTasks, notes };
}

/** Options for {@link runClusterStage}. */
export interface ClusterStageOptions {
  home: string;
  /** Digests for the CURRENT eligible sessions (input to the clusterer). */
  digests: Record<string, Digest>;
  /** Backend per export name (absent entries ⇒ claude) — names the corpus in the prompt. */
  origins?: Record<string, SourceName>;
  generation: string;
  noGroup?: boolean;
  model?: string;
  runnerName?: SourceName;
  runner?: RunnerFn;
  output?: Writable;
  /** Maximum prompt characters per clustering window or merge call. */
  budget?: number;
  /** Maximum number of digests per clustering window, in addition to the input budget. */
  batchSize?: number;
  /** Per-call timeout (ms) passed through to the runner. */
  timeoutMs?: number;
}

/**
 * Stage 2 — cluster all digests into semantic tasks. One call when the corpus
 * fits the input budget and optional batch size; otherwise one call per window
 * plus one best-effort merge call that unifies cross-window duplicates.
 *
 * Resumable: a tasks.json from the same generation covering the same input set
 * is reused without a call. Semantic validation failures (duplicate slugs,
 * dropped sessions, invented ids) get ONE corrective retry with the problems
 * spelled out; a second failure throws — progress stays checkpointed,
 * the command reports and exits non-zero, re-running resumes.
 */
export async function runClusterStage(opts: ClusterStageOptions): Promise<ClusterStageResult> {
  const out = opts.output ?? process.stdout;
  const write = (s: string) => out.write(`${s}\n`);
  const inputIds = Object.keys(opts.digests).sort();
  const sortedDigests = Object.fromEntries(inputIds.map((id) => [id, opts.digests[id] as Digest]));
  const upstream = loadDigests(opts.home)?.lineage;
  const lineage = stageLineage({
    stage: "cluster",
    promptVersion: CLUSTER_PROMPT_VERSION,
    schema: {
      cluster: toJsonSchema(ClusterSchema),
      merge: toJsonSchema(ClusterMergeSchema),
    },
    inputs: {
      digests: sortedDigests,
      origins: Object.fromEntries(inputIds.map((id) => [id, opts.origins?.[id] ?? "claude"])),
      upstream: Object.fromEntries(inputIds.map((id) => [id, upstream?.[id]?.fingerprint ?? null])),
      mode: opts.noGroup ? "one-session-per-task" : "grouped",
      windows: opts.noGroup
        ? []
        : planClusterWindows(opts.digests, opts.origins, opts.budget, opts.batchSize),
      prompt: buildClusterPrompt(sortedDigests, opts.origins),
      mergePrompt: buildMergePrompt([]),
    },
    model: opts.model,
    runnerName: opts.runnerName,
  });

  // Matching names alone cannot prove freshness: content, grouping mode,
  // instructions, or the selected runner can all have changed.
  const existing = loadTasks(opts.home);
  if (existing && existing.generation === opts.generation) {
    if (
      sameLineage(existing.lineage, lineage) &&
      validateCluster(existing, inputIds).length === 0
    ) {
      if (existing.operation_ids)
        reconcileGroupingOperations(new OperationStore(opts.home, opts.generation), existing);
      write("  clustering already done (checkpoint reused)");
      return {
        generation: existing.generation,
        tasks: existing.tasks,
        misc: existing.misc,
        resumed: true,
      };
    }
    write("  clustering inputs or settings changed; regenerating stale grouping");
  }

  const store = new OperationStore(opts.home, opts.generation);
  const runId = newGeneration();
  const operationIds: string[] = [];
  let fallbackMergeId: string | undefined;
  let cluster: Cluster;
  if (opts.noGroup) {
    cluster = synthesizeNoGroupTasks(opts.digests);
    write(
      `  --no-group: synthesized ${cluster.tasks.length} task(s) deterministically (no claude call)`,
    );
  } else {
    const windows = planClusterWindows(opts.digests, opts.origins, opts.budget, opts.batchSize);
    // Persist the entire fixed partition before spending on its first window.
    const windowOperations = windows.map((windowIds, index) => {
      const digests = Object.fromEntries(windowIds.map((id) => [id, opts.digests[id]]));
      const logicalInput = {
        windowIds,
        digests,
        origins: opts.origins ?? {},
        windows,
        upstream: Object.fromEntries(
          windowIds.map((id) => [id, upstream?.[id]?.fingerprint ?? null]),
        ),
      };
      const settings = operationSettings(opts, windowIds.length);
      const unitId = `window-${index + 1}`;
      const operation =
        reusableOperation(store, "cluster-window", unitId, logicalInput, settings) ??
        store.queue({
          kind: "cluster-window",
          unitId,
          generation: opts.generation,
          runId,
          promptVersion: CLUSTER_PROMPT_VERSION,
          schema: toJsonSchema(ClusterSchema),
          logicalInput,
          sources: [],
          settings,
          request: {
            prompt: buildClusterPrompt(digests as Record<string, Digest>, opts.origins),
            timeoutUnits: windowIds.length,
          },
        });
      operationIds.push(operation.id);
      return operation;
    });
    if (windows.length === 1) {
      write(`  clustering ${inputIds.length} digest(s)…`);
      cluster = await clusterWindow(
        windows[0] as string[],
        opts,
        out,
        "",
        store,
        windowOperations[0] as OperationRecord,
      );
    } else {
      // Cluster each bounded window independently, then unify cross-window
      // duplicates with one merge call over the task identities.
      const limits = [
        ...(opts.batchSize === undefined ? [] : [`up to ${opts.batchSize} digests per window`]),
        ...(opts.budget === undefined ? [] : [`input budget ${opts.budget} chars`]),
      ];
      write(
        `  clustering ${inputIds.length} digest(s) in ${windows.length} windows ` +
          `(${limits.join("; ")})…`,
      );
      const combined: ClusterTask[] = [];
      const misc: string[] = [];
      const usedSlugs = new Set<string>();
      for (const [i, windowIds] of windows.entries()) {
        const label = ` [window ${i + 1}/${windows.length}]`;
        const windowCluster = await clusterWindow(
          windowIds,
          opts,
          out,
          label,
          store,
          windowOperations[i] as OperationRecord,
        );
        for (const task of windowCluster.tasks) {
          // The same slug can legitimately appear in two windows; suffix the
          // later one so the merge call can still address both. The suffix keeps
          // the 2-5 word rule, since a slug is also a library path component.
          let slug = task.slug;
          for (let n = 2; usedSlugs.has(slug); n++) slug = suffixSlug(task.slug, n);
          usedSlugs.add(slug);
          combined.push(slug === task.slug ? task : { ...task, slug });
        }
        misc.push(...windowCluster.misc);
      }

      if (combined.length < 2) {
        cluster = { tasks: combined, misc: [...new Set(misc)] };
      } else {
        const logicalInput = {
          combined,
          misc: [...new Set(misc)],
          digests: sortedDigests,
          windowIds: inputIds,
          upstream: Object.fromEntries(
            inputIds.map((id) => [id, upstream?.[id]?.fingerprint ?? null]),
          ),
        };
        const settings = operationSettings(opts, combined.length);
        const operation =
          reusableOperation(store, "cluster-merge", "merge", logicalInput, settings) ??
          store.queue({
            kind: "cluster-merge",
            unitId: "merge",
            generation: opts.generation,
            runId,
            promptVersion: CLUSTER_PROMPT_VERSION,
            schema: toJsonSchema(ClusterMergeSchema),
            logicalInput,
            sources: [],
            settings,
            dependencyIds: windowOperations.map((op) => op.id),
            request: { prompt: buildMergePrompt(combined), timeoutUnits: combined.length },
          });
        operationIds.push(operation.id);
        cluster = await mergeWindowTasks(combined, misc, opts, out, store, operation);
        if (
          store
            .list()
            .find((op) => op.id === operation.id)
            ?.state.match(/^(failed|blocked)$/)
        )
          fallbackMergeId = operation.id;
      }
    }
  }

  const checkpoint: TasksCheckpoint = {
    generation: opts.generation,
    prompt_version: CLUSTER_PROMPT_VERSION,
    tasks: cluster.tasks,
    misc: cluster.misc,
    lineage,
    operation_ids: operationIds,
    ...(fallbackMergeId ? { fallback_merge_id: fallbackMergeId } : {}),
    grouping_hash: fingerprint({ tasks: cluster.tasks, misc: cluster.misc }),
  };
  saveTasks(opts.home, checkpoint);
  reconcileGroupingOperations(store, checkpoint);

  write(
    `      → ${cluster.tasks.length} task(s), ${cluster.misc.length} session(s) routed to misc`,
  );
  return { generation: opts.generation, tasks: cluster.tasks, misc: cluster.misc, resumed: false };
}

/** Finish publication after the grouping is durable, including an interrupted prior run. */
function reconcileGroupingOperations(store: OperationStore, checkpoint: TasksCheckpoint): void {
  const operationIds = checkpoint.operation_ids ?? [];
  // A completed normal grouping replaces the active task and clustering scope.
  for (const previous of store.list()) {
    if (previous.state === "superseded") continue;
    if (previous.kind.startsWith("cluster-") && !operationIds.includes(previous.id)) {
      store.setState(previous.id, "superseded");
    } else if (previous.kind === "author") {
      const oldTask = (store.loadInput(previous.id).logicalInput as AuthorLogicalInput).task;
      const currentTask = checkpoint.tasks.find((task) => task.slug === oldTask.slug);
      if (!currentTask || fingerprint(currentTask) !== fingerprint(oldTask))
        store.setState(previous.id, "superseded");
    }
  }
  const states = new Map(store.list().map((operation) => [operation.id, operation.state]));
  for (const id of operationIds) {
    if (id === checkpoint.fallback_merge_id) {
      if (states.get(id) !== "resolved-by-fallback") store.setState(id, "resolved-by-fallback");
    } else if (states.get(id) !== "committed") {
      store.commit(id, { kind: "cluster", groupingHash: fingerprint(checkpoint) });
    }
  }
}

/**
 * Cluster one window of ids: one call plus one corrective retry when the
 * response fails semantic validation (against THIS window's ids). The default
 * timeout scales with the window's digest count; an explicit --timeout wins.
 */
async function clusterWindow(
  windowIds: string[],
  opts: ClusterStageOptions,
  out: Writable,
  label: string,
  store: OperationStore,
  operation: OperationRecord,
): Promise<Cluster> {
  const runner: RunnerFn = opts.runner ?? runClaude;
  const write = (s: string) => out.write(`${s}\n`);
  const digests: Record<string, Digest> = {};
  for (const id of windowIds) {
    const d = opts.digests[id];
    if (d) digests[id] = d;
  }
  const timeoutMs =
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS + CLUSTER_TIMEOUT_PER_DIGEST_MS * windowIds.length;
  const basePrompt = buildClusterPrompt(digests, opts.origins);

  const saved = store.readResult(operation.id);
  if (saved) return ClusterSchema.parse(saved.value);
  if (opts.budget !== undefined && basePrompt.length > opts.budget) {
    store.block(operation.id, `cluster prompt ${basePrompt.length} exceeds budget ${opts.budget}`);
    throw new Error(
      `cluster prompt exceeds the input budget (${opts.budget}); increase --input-budget`,
    );
  }
  const attempt = store.start(operation.id);
  const invoke = (prompt: string) => {
    store.recordInvocation(operation.id, attempt.id, {
      prompt,
      schema: toJsonSchema(ClusterSchema),
      model: opts.model ?? null,
      timeoutMs,
    });
    return runner({ prompt, schema: ClusterSchema, model: opts.model, timeoutMs });
  };
  try {
    let cluster = canonicalizeClusterIds(
      await withSpinner(out, `clustering ${windowIds.length} digest(s)${label}`, () =>
        invoke(basePrompt),
      ),
      windowIds,
    );

    let problems = validateCluster(cluster, windowIds);
    if (problems.length > 0) {
      write(`      response failed validation (${problems.length} problem(s)); retrying once…`);
      const corrective =
        `${basePrompt}\n\nYour previous grouping had these problems:\n` +
        `${problems.map((p) => `- ${p}`).join("\n")}\n` +
        "Produce a corrected grouping that fixes every problem. Remember: every id in at " +
        "least one task or misc, unique 2-5-word kebab-case slugs, only the listed ids.";
      cluster = canonicalizeClusterIds(
        await withSpinner(out, `retrying with corrections${label}`, () => invoke(corrective)),
        windowIds,
      );
      problems = validateCluster(cluster, windowIds);
      if (problems.length > 0) {
        throw new Error(`clustering failed validation after one retry: ${problems.join("; ")}`);
      }
    }
    store.saveResult(operation.id, attempt.id, cluster);
    return cluster;
  } catch (error) {
    if (!store.readResult(operation.id))
      store.fail(operation.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/**
 * Unify cross-window duplicate tasks with one merge call over the combined
 * task identities. Best-effort by design: window clustering already produced
 * a fully valid grouping, so a failed or partially invalid merge response
 * degrades to (parts of) the unmerged union with a note instead of failing
 * the stage.
 */
async function mergeWindowTasks(
  combined: ClusterTask[],
  misc: string[],
  opts: ClusterStageOptions,
  out: Writable,
  store: OperationStore,
  operation: OperationRecord,
): Promise<Cluster> {
  const runner: RunnerFn = opts.runner ?? runClaude;
  const write = (s: string) => out.write(`${s}\n`);
  const uniqueMisc = [...new Set(misc)];
  if (combined.length < 2) return { tasks: combined, misc: uniqueMisc };

  const timeoutMs =
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS + CLUSTER_TIMEOUT_PER_DIGEST_MS * combined.length;
  let merge: ClusterMerge;
  const saved = store.readResult(operation.id);
  let attempt: ReturnType<OperationStore["start"]> | undefined;
  try {
    const prompt = buildMergePrompt(combined);
    if (!saved && opts.budget !== undefined && prompt.length > opts.budget) {
      store.block(operation.id, `merge prompt ${prompt.length} exceeds budget ${opts.budget}`);
      throw new Error(`merge prompt exceeds the input budget (${opts.budget})`);
    }
    if (!saved) attempt = store.start(operation.id);
    merge = saved
      ? ClusterMergeSchema.parse(saved.value)
      : await withSpinner(
          out,
          `merging ${combined.length} window task(s) into a unified grouping`,
          () => {
            if (attempt)
              store.recordInvocation(operation.id, attempt.id, {
                prompt,
                schema: toJsonSchema(ClusterMergeSchema),
                model: opts.model ?? null,
                timeoutMs,
              });
            return runner({ prompt, schema: ClusterMergeSchema, model: opts.model, timeoutMs });
          },
        );
  } catch (err) {
    if (attempt && !store.readResult(operation.id))
      store.fail(operation.id, err instanceof Error ? err.message : String(err));
    write(
      `      merge call failed (${err instanceof Error ? err.message : String(err)}); ` +
        "keeping the per-window tasks unmerged.",
    );
    return { tasks: combined, misc: uniqueMisc };
  }

  const { tasks, notes } = applyClusterMerges(combined, merge.merges);
  for (const note of notes) write(`      ⚠ ${note}`);
  if (!saved && attempt) {
    if (notes.length)
      store.fail(operation.id, `merge response had invalid entries: ${notes.join("; ")}`);
    else store.saveResult(operation.id, attempt.id, merge);
  }
  const applied = merge.merges.length - notes.length;
  if (applied > 0) write(`      merged ${combined.length} window task(s) → ${tasks.length}`);
  return { tasks, misc: uniqueMisc };
}

// --- stage 3: author ---------------------------------------------------------

/**
 * `library/<slug>/sources.json` — full provenance for one entry.
 *
 * The type is derived from the read-validation schema in core/artifacts.ts and
 * re-exported here for existing importers, so the write shape (what the author
 * stage produces below) and the read validation (what browsing commands trust)
 * are one source of truth and cannot drift.
 */
export type { SourcesJson } from "../core/artifacts.js";

import type { SourcesJson } from "../core/artifacts.js";

/** A task skipped by the author stage, with the reason (reported by status). */
export interface SkippedTask {
  slug: string;
  reason: string;
}

/** Result of the author stage. */
export interface AuthorStageResult {
  generation: string;
  /** Tasks authored by THIS run. */
  authored: string[];
  /** Tasks already authored in this generation (resume). */
  resumed: string[];
  /** Tasks skipped (no completed/partial member session). */
  skipped: SkippedTask[];
  failed: StageFailure[];
}

/** Options for {@link runAuthorStage}. */
export interface AuthorStageOptions {
  home: string;
  tasks: ClusterTask[];
  /** Digests for outcome classification and prompt context. */
  digests: Record<string, Digest>;
  /** Manifest entries to map export names → session ids. */
  entries: ManifestEntry[];
  generation: string;
  toolVersion: string;
  model?: string;
  runnerName?: SourceName;
  runner?: RunnerFn;
  output?: Writable;
  /** Max chars of aggregate member content per author call (default {@link DEFAULT_INPUT_BUDGET}). */
  budget?: number;
  /** Overflow policy when a task's members exceed the budget (default "never"). */
  truncate?: TruncatePolicy;
  /** Per-call timeout (ms) passed through to the runner. */
  timeoutMs?: number;
  /** Overwrite oneshots the user edited by hand (default: keep them). */
  force?: boolean;
  /** Max author calls in flight at once (default 1 — sequential). */
  concurrency?: number;
}

/** Read `exports/anaphora.json` ({export → records}); absent/invalid → {}. */
function readAnaphora(home: string): Record<string, AnaphoraRecord[]> {
  try {
    const raw = fs.readFileSync(path.join(home, "exports", "anaphora.json"), "utf8");
    // Validate + drop malformed per-export record arrays.
    return parseAnaphoraMap(JSON.parse(raw)) as Record<string, AnaphoraRecord[]>;
  } catch {
    return {};
  }
}

/** Summarize member outcomes, e.g. "2 completed, 1 partial". */
export function summarizeOutcomes(members: string[], digests: Record<string, Digest>): string {
  const counts = new Map<string, number>();
  for (const m of members) {
    const outcome = digests[m]?.outcome ?? "unclear";
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  return ["completed", "partial", "abandoned", "unclear"]
    .filter((o) => counts.has(o))
    .map((o) => `${counts.get(o)} ${o}`)
    .join(", ");
}

/** The provenance header comment written at the top of every oneshot file. */
function provenanceComment(sources: SourcesJson): string {
  return [
    "<!--",
    `  generated by human-hindsight v${sources.tool_version}`,
    `  task: ${sources.slug} (generation ${sources.generation})`,
    `  sources: ${sources.members.join(", ")}`,
    `  outcomes: ${sources.outcome_summary}; confidence: ${sources.confidence}`,
    `  model: ${sources.model ?? "runner default"}; prompt v${sources.prompt_version}; ${sources.authored_at}`,
    "-->",
  ].join("\n");
}

/**
 * Stage 3 — author one oneshot per task (one call each): the heart of the tool.
 *
 * Skip rule: tasks with NO completed/partial member session are skipped
 * and reported — never distilled into confident prompts that reproduce failure
 * paths. Resume: a task whose `sources.json` already carries this generation is
 * done (the library files ARE the checkpoint). One task's failure never aborts
 * the rest.
 */
export async function runAuthorStage(opts: AuthorStageOptions): Promise<AuthorStageResult> {
  const runner: RunnerFn = opts.runner ?? runClaude;
  const out = opts.output ?? process.stdout;
  const write = (s: string) => out.write(`${s}\n`);

  const anaphora = readAnaphora(opts.home);
  const sessionIdByExport = new Map(opts.entries.map((e) => [e.export, e.sessionId]));
  const originByExport = new Map(opts.entries.map((e) => [e.export, e.origin ?? "claude"]));
  const projectByExport = new Map(opts.entries.map((e) => [e.export, e.project]));
  const upstream = loadDigests(opts.home)?.lineage;
  const store = new OperationStore(opts.home, opts.generation);
  const runId = newGeneration();

  const result: AuthorStageResult = {
    generation: opts.generation,
    authored: [],
    resumed: [],
    skipped: [],
    failed: [],
  };
  const total = opts.tasks.length;
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));

  /** Author one task end-to-end (skip / resume / budget / call / write). */
  const authorOne = async (task: ClusterTask, i: number): Promise<void> => {
    const label = `[${i + 1}/${total}] ${task.slug}`;
    const dir = path.join(opts.home, "library", task.slug);
    const sourcesPath = path.join(dir, "sources.json");

    // Skip: no member with a completed or partial outcome.
    const viable = task.members.some((m) => {
      const outcome = opts.digests[m]?.outcome;
      return outcome === "completed" || outcome === "partial";
    });
    if (!viable) {
      result.skipped.push({
        slug: task.slug,
        reason:
          "no completed/partial member session (outcomes: " +
          `${summarizeOutcomes(task.members, opts.digests) || "none"})`,
      });
      write(`  ${label} — skipped (no completed/partial member session)`);
      return;
    }

    let existing: SourcesJson | null = null;
    try {
      existing = parseSourcesJson(JSON.parse(fs.readFileSync(sourcesPath, "utf8")));
    } catch {
      // no prior entry (or unreadable) — author it
    }
    const oneshotPath = path.join(dir, `${task.slug}.oneshot.md`);
    let currentContent: string | null = null;
    try {
      currentContent = fs.readFileSync(oneshotPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        result.failed.push({ export: task.slug, error: "existing prompt cannot be read safely" });
        write(`  ${label} — ${fail("existing prompt cannot be read safely; kept")}`);
        return;
      }
    }

    const members: AuthorMemberInput[] = [];
    let unreadableMember: string | null = null;
    for (const m of task.members) {
      try {
        const content = fs.readFileSync(path.join(opts.home, "exports", m), "utf8");
        members.push({
          exportName: m,
          content,
          digest: opts.digests[m],
          anaphora: anaphora[m],
          origin: originByExport.get(m),
        });
      } catch {
        unreadableMember = m;
        break;
      }
    }
    // Authoring a "realistic ideal prompt" from a placeholder silently
    // degrades quality — the digest stage already treats an unreadable export as
    // a failure, so the author stage must too. Fail the task; re-running retries.
    if (unreadableMember) {
      result.failed.push({
        export: task.slug,
        error: `member export unreadable: ${unreadableMember}`,
      });
      write(`  ${label} — ${fail(`member export unreadable: ${unreadableMember}`)}`);
      return;
    }
    const originalMembers = members.map((member) => ({ ...member }));
    const logicalInput: AuthorLogicalInput = {
      task,
      members: originalMembers.map(({ content, ...member }) => ({
        ...member,
        contentHash: contentFingerprint(content),
      })),
      entries: opts.entries.filter((entry) => task.members.includes(entry.export)),
      generation: opts.generation,
      toolVersion: opts.toolVersion,
      upstream: Object.fromEntries(
        [...task.members].sort().map((id) => [id, upstream?.[id]?.fingerprint ?? null]),
      ),
    };
    const settings = operationSettings(opts);
    const publication = {
      kind: "author",
      slug: task.slug,
      oneshotPath: `library/${task.slug}/${task.slug}.oneshot.md`,
      sourcesPath: `library/${task.slug}/sources.json`,
      expectedOneshotHash: currentContent === null ? null : contentFingerprint(currentContent),
    };
    let operation: OperationRecord | undefined;
    const queueAuthor = (prompt: string) =>
      store.queue({
        kind: "author",
        unitId: task.slug,
        generation: opts.generation,
        runId,
        promptVersion: AUTHOR_PROMPT_VERSION,
        schema: toJsonSchema(AuthorSchema),
        logicalInput,
        sources: originalMembers.map((member) =>
          sourceReference(member.exportName, member.content),
        ),
        settings,
        request: { prompt },
        publication,
      });
    for (const member of originalMembers) {
      const problems = validatePreferenceCandidates(
        member.digest?.preferences ?? [],
        exportMessages(member.exportName, member.content),
      );
      if (problems.length) {
        const error = `member preference evidence is stale (${member.exportName}); re-run distill to refresh the digest`;
        result.failed.push({ export: task.slug, error });
        write(`  ${label} — ${fail(error)}`);
        return;
      }
    }

    // Input budget / overflow policy for the aggregate of all member content.
    // Bounds by BLOCKING (never) or middle-cutting each member (extreme) —
    // never silently. Lossless chunking (draft→refine) is a roadmap item.
    const budget = opts.budget ?? DEFAULT_INPUT_BUDGET;
    const truncatePolicy: TruncatePolicy = opts.truncate ?? "never";
    const totalChars = members.reduce((n, m) => n + m.content.length, 0);
    let inputCoverage = 1;
    const truncations: { export: string; block: number; dropped_chars: number }[] = [];
    if (totalChars > budget) {
      if (truncatePolicy === "never") {
        operation = queueAuthor(buildAuthorPrompt({ task, members: originalMembers }));
        store.block(operation.id, `task input ${totalChars} exceeds budget ${budget}`);
        result.failed.push({
          export: task.slug,
          error:
            `task input (${totalChars} chars across ${members.length} member(s)) exceeds the input ` +
            `budget (${budget}). Re-run with --truncate=extreme or a larger --input-budget.`,
        });
        write(
          `  ${label} — ${skipGlyph(`blocked: ${totalChars} chars exceed the input budget (${budget}).`)} ` +
            "Re-run with --truncate=extreme or a larger --input-budget.",
        );
        return; // pre-spend block
      }
      // extreme: give each member an equal slice of the budget, cut middle-out,
      // and record exactly what was dropped for provenance.
      const perMember = Math.max(1, Math.floor(budget / members.length));
      let totalDropped = 0;
      for (const m of members) {
        const cut = middleCut(m.content, perMember);
        if (cut.dropped > 0) {
          truncations.push({ export: m.exportName, block: 0, dropped_chars: cut.dropped });
        }
        m.content = cut.text;
        totalDropped += cut.dropped;
      }
      inputCoverage = totalChars > 0 ? (totalChars - totalDropped) / totalChars : 1;
      write(
        `  ${label} — ✂ cut ${totalDropped} chars to fit the input budget (--truncate=extreme)`,
      );
    }

    // Canonical session order avoids spending another call when a cluster
    // simply returns the same membership in a different order.
    const sortedMembers = [...members].sort((a, b) => a.exportName.localeCompare(b.exportName));
    const prompt = buildAuthorPrompt({ task, members: sortedMembers });
    const lineage = stageLineage({
      stage: "author",
      promptVersion: AUTHOR_PROMPT_VERSION,
      schema: toJsonSchema(AuthorSchema),
      inputs: {
        prompt,
        task: { ...task, members: [...task.members].sort() },
        originalMembers: originalMembers.sort((a, b) => a.exportName.localeCompare(b.exportName)),
        upstream: Object.fromEntries(
          [...task.members].sort().map((id) => [id, upstream?.[id]?.fingerprint ?? null]),
        ),
      },
      model: opts.model,
      runnerName: opts.runnerName,
    });
    if (
      existing?.generation === opts.generation &&
      currentContent !== null &&
      sameLineage(existing.lineage, lineage)
    ) {
      result.resumed.push(task.slug);
      write(`  ${label} — already authored (inputs unchanged; skipped)`);
      return;
    }

    // Old files without a recorded generation hash may also contain manual
    // work. A missing output is repairable, but an unverified existing one is
    // kept until the user explicitly requests --force.
    if (
      !opts.force &&
      currentContent !== null &&
      (!existing?.oneshot_hash || oneshotHash(currentContent) !== existing.oneshot_hash)
    ) {
      const reason = existing?.oneshot_hash
        ? "oneshot was edited by hand — re-run with --force to overwrite"
        : "existing oneshot has no verified generation hash — re-run with --force to overwrite";
      result.skipped.push({ slug: task.slug, reason });
      write(`  ${label} — ✋ ${reason}; kept`);
      return;
    }
    if (existing) {
      write(
        `  ${label} — ${currentContent === null ? "prompt file missing; repairing" : "inputs or prompt changed; regenerating"}`,
      );
    }

    operation =
      reusableOperation(store, "author", task.slug, logicalInput, settings) ?? queueAuthor(prompt);
    write(`  ${label} — authoring…`);
    try {
      const saved = store.readResult(operation.id);
      checkSourceGuards(opts.home, store.loadInput(operation.id).sources);
      const attempt = saved ? undefined : store.start(operation.id, settings, { prompt });
      const call = () => {
        if (attempt)
          store.recordInvocation(operation.id, attempt.id, {
            prompt,
            schema: toJsonSchema(AuthorSchema),
            model: opts.model ?? null,
            timeoutMs: settings.timeoutMs,
          });
        return runner({
          prompt,
          schema: AuthorSchema,
          model: opts.model,
          timeoutMs: opts.timeoutMs,
        });
      };
      // A spinner is a single-line UI; with parallel calls in flight the lines
      // would fight over the cursor — plain progress lines instead (mirrors the
      // digest stage).
      const authored = saved
        ? AuthorSchema.parse((saved.value as AuthorResult).authored)
        : concurrency === 1
          ? await withSpinner(out, `${label} — authoring`, call)
          : await call();

      // Our code writes the files; the TASK slug is authoritative for paths.
      const sources: SourcesJson = {
        ...existing,
        slug: task.slug,
        title: authored.title,
        members: task.members,
        sessionIds: task.members.map((m) => sessionIdByExport.get(m) ?? "unknown"),
        preferences: originalMembers.flatMap((member) =>
          (member.digest?.preferences ?? []).map((candidate) => ({
            ...candidate,
            ...(candidate.scope === "global"
              ? {}
              : { project: projectByExport.get(member.exportName) ?? "" }),
          })),
        ),
        outcome_summary: summarizeOutcomes(task.members, opts.digests),
        domains: [
          ...new Set(
            task.members
              .map((m) => opts.digests[m]?.domain.trim().toLowerCase())
              .filter((d): d is string => Boolean(d)),
          ),
        ],
        confidence: authored.confidence,
        authored_at: new Date().toISOString(),
        model: opts.model ?? null,
        prompt_version: AUTHOR_PROMPT_VERSION,
        tool_version: opts.toolVersion,
        generation: opts.generation,
        lineage,
        // Coverage provenance: 1 when every member byte reached the model;
        // < 1 with the exact cuts listed when --truncate=extreme trimmed input.
        input_coverage: inputCoverage,
        truncations,
      };

      mkdirPrivate(dir);
      const oneshot = `${provenanceComment(sources)}\n\n# ${authored.title}\n\n${authored.oneshot_markdown.trim()}\n`;
      // Hash of the exact bytes written — the anchor for detecting user edits
      // (overwrite protection). Recorded in sources.json, not the file.
      sources.oneshot_hash = oneshotHash(oneshot);
      const value: AuthorResult = saved
        ? (saved.value as AuthorResult)
        : { authored, sources, oneshot };
      if (!saved && attempt) store.saveResult(operation.id, attempt.id, value);
      checkSourceGuards(opts.home, store.loadInput(operation.id).sources);
      const receipt = publishAuthorResult(opts.home, value, store.loadInput(operation.id));
      store.commit(operation.id, receipt);

      result.authored.push(task.slug);
      write(
        `      → ${authored.confidence} confidence, ${sources.preferences.length} preference(s)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (operation && !store.readResult(operation.id)) store.fail(operation.id, message);
      result.failed.push({ export: task.slug, error: message });
      write(`      ${fail(`failed: ${truncate(message, 120)}`)}`);
      // one task's failure doesn't abort the rest
    }
  };

  // Bounded worker pool: N workers pull the next un-started task until none
  // remain. concurrency=1 degrades to the exact sequential behavior. Each task
  // writes its own library/<slug>/ dir and the runner is stateless per call, so
  // parallel authoring is race-free; result.* pushes are synchronous (single JS
  // tick) so concurrent workers never interleave a mutation.
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < opts.tasks.length) {
      const i = nextIndex++;
      const task = opts.tasks[i];
      if (task) await authorOne(task, i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(total, 1)) }, () => worker()),
  );

  // Determinism: workers finish in nondeterministic order under concurrency > 1,
  // so re-order every result list by the task's original position. The report
  // (and any downstream consumer) then reads identically regardless of timing.
  const order = new Map(opts.tasks.map((t, i) => [t.slug, i]));
  const bySlug = (a: { slug: string }, b: { slug: string }) =>
    (order.get(a.slug) ?? 0) - (order.get(b.slug) ?? 0);
  const byExport = (a: { export: string }, b: { export: string }) =>
    (order.get(a.export) ?? 0) - (order.get(b.export) ?? 0);
  result.authored.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  result.resumed.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  result.skipped.sort(bySlug);
  result.failed.sort(byExport);

  return result;
}

interface AuthorLogicalInput {
  task: ClusterTask;
  members: (Omit<AuthorMemberInput, "content"> & { contentHash?: string })[];
  entries: ManifestEntry[];
  generation: string;
  toolVersion: string;
  upstream: Record<string, string | null>;
}
interface AuthorResult {
  authored: z.infer<typeof AuthorSchema>;
  sources: SourcesJson;
  oneshot: string;
}

function readOptional(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Publication can resume after either rename; a changed human prompt is never replaced. */
function publishAuthorResult(home: string, value: AuthorResult, input: OperationInput) {
  const slug = (input.logicalInput as AuthorLogicalInput).task.slug;
  if (!SLUG_PATTERN.test(slug)) throw new Error("Unsafe author task slug");
  const dir = guardedPath(home, `library/${slug}`);
  const oneshotPath = path.join(dir, `${slug}.oneshot.md`);
  const sourcesPath = path.join(dir, "sources.json");
  const current = readOptional(oneshotPath);
  const expected = input.publication?.expectedOneshotHash ?? null;
  const hash = current === null ? null : contentFingerprint(current);
  if (hash !== expected && hash !== contentFingerprint(value.oneshot)) {
    throw new Error("Prompt changed while authoring; generated result saved, human edit kept");
  }
  let latest: Record<string, unknown> = {};
  const raw = readOptional(sourcesPath);
  if (raw !== null) {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Existing provenance cannot be read safely");
    latest = parsed as Record<string, unknown>;
  }
  // Only generator-owned fields may replace the latest human metadata.
  const generatedKeys = new Set([
    "slug",
    "title",
    "members",
    "sessionIds",
    "preferences",
    "outcome_summary",
    "domains",
    "confidence",
    "authored_at",
    "model",
    "prompt_version",
    "tool_version",
    "generation",
    "lineage",
    "input_coverage",
    "truncations",
    "oneshot_hash",
  ]);
  const sources: Record<string, unknown> = { ...value.sources, ...latest };
  for (const [key, generated] of Object.entries(value.sources)) {
    if (generatedKeys.has(key)) sources[key] = generated;
  }
  mkdirPrivate(dir);
  atomicWriteFilePrivate(oneshotPath, value.oneshot);
  atomicWriteFilePrivate(sourcesPath, `${JSON.stringify(sources, null, 2)}\n`);
  return {
    kind: "author",
    oneshotHash: contentFingerprint(value.oneshot),
    sourcesHash: fingerprint(sources),
  };
}

function prepareAuthorRequest(
  home: string,
  input: OperationInput,
  settings: AttemptSettings,
): PreparedRequest {
  const logical = input.logicalInput as AuthorLogicalInput;
  const members: AuthorMemberInput[] = logical.members.map(({ contentHash: _hash, ...member }) => ({
    ...member,
    content: fs.readFileSync(path.join(home, "exports", member.exportName), "utf8"),
  }));
  for (const member of members) {
    const problems = validatePreferenceCandidates(
      member.digest?.preferences ?? [],
      exportMessages(member.exportName, member.content),
    );
    if (problems.length)
      throw new Error(`Member preference evidence is stale: ${member.exportName}`);
  }
  const originals = members.map((member) => ({ ...member }));
  const total = members.reduce((sum, member) => sum + member.content.length, 0);
  let inputCoverage = 1;
  const truncations: { export: string; block: number; dropped_chars: number }[] = [];
  if (total > settings.budget) {
    if (settings.truncate === "never")
      throw new Error(`Task input ${total} exceeds input budget ${settings.budget}`);
    const slice = Math.max(1, Math.floor(settings.budget / members.length));
    let dropped = 0;
    for (const member of members) {
      const cut = middleCut(member.content, slice);
      member.content = cut.text;
      dropped += cut.dropped;
      if (cut.dropped)
        truncations.push({ export: member.exportName, block: 0, dropped_chars: cut.dropped });
    }
    inputCoverage = total ? (total - dropped) / total : 1;
  }
  members.sort((a, b) => a.exportName.localeCompare(b.exportName));
  const prompt = buildAuthorPrompt({ task: logical.task, members });
  const lineage = stageLineage({
    stage: "author",
    promptVersion: AUTHOR_PROMPT_VERSION,
    schema: toJsonSchema(AuthorSchema),
    model: settings.model ?? undefined,
    runnerName: settings.runner,
    inputs: {
      prompt,
      task: { ...logical.task, members: [...logical.task.members].sort() },
      originalMembers: originals.sort((a, b) => a.exportName.localeCompare(b.exportName)),
      upstream: logical.upstream,
    },
  });
  return { prompt, inputCoverage, truncations, lineage };
}

function authorResult(
  authored: z.infer<typeof AuthorSchema>,
  request: PreparedRequest,
  input: OperationInput,
  settings: AttemptSettings,
): AuthorResult {
  const logical = input.logicalInput as AuthorLogicalInput;
  const digests = Object.fromEntries(
    logical.members.map((member) => [member.exportName, member.digest as Digest]),
  ) as Record<string, Digest>;
  const entries = new Map(logical.entries.map((entry) => [entry.export, entry]));
  const sources: SourcesJson = {
    slug: logical.task.slug,
    title: authored.title,
    members: logical.task.members,
    sessionIds: logical.task.members.map((id) => entries.get(id)?.sessionId ?? "unknown"),
    preferences: logical.members.flatMap((member) =>
      (member.digest?.preferences ?? []).map((candidate) => ({
        ...candidate,
        ...(candidate.scope === "global"
          ? {}
          : { project: entries.get(member.exportName)?.project ?? "" }),
      })),
    ),
    outcome_summary: summarizeOutcomes(logical.task.members, digests),
    domains: [
      ...new Set(
        logical.task.members
          .map((id) => digests[id]?.domain.trim().toLowerCase())
          .filter((domain): domain is string => Boolean(domain)),
      ),
    ],
    confidence: authored.confidence,
    authored_at: new Date().toISOString(),
    model: settings.model,
    prompt_version: AUTHOR_PROMPT_VERSION,
    tool_version: logical.toolVersion,
    generation: logical.generation,
    lineage: request.lineage as StageLineage,
    input_coverage: request.inputCoverage as number,
    truncations: request.truncations as SourcesJson["truncations"],
  };
  const oneshot = `${provenanceComment(sources)}\n\n# ${authored.title}\n\n${authored.oneshot_markdown.trim()}\n`;
  sources.oneshot_hash = oneshotHash(oneshot);
  return { authored, sources, oneshot };
}

/** Strict execution reuses stage validation but never invokes downstream stages. */
export function createRetryHandlers(
  home: string,
): Partial<Record<OperationRecord["kind"], RetryHandler>> {
  const digest: RetryHandler = {
    guard(input) {
      const logical = input.logicalInput as {
        entry: ManifestEntry;
        outcome: OutcomeEvidence | null;
      };
      if (
        fingerprint(readOutcomes(home)[logical.entry.export] ?? null) !==
        fingerprint(logical.outcome)
      )
        throw new Error("Outcome evidence changed; use normal distill to prepare new inputs");
    },
    prepare(input, settings) {
      const logical = input.logicalInput as {
        entry: ManifestEntry;
        outcome: OutcomeEvidence | null;
      };
      const original = fs.readFileSync(path.join(home, "exports", logical.entry.export), "utf8");
      if (original.length > settings.budget && settings.truncate === "never")
        throw new Error(`Input ${original.length} exceeds input budget ${settings.budget}`);
      const content =
        original.length > settings.budget ? middleCut(original, settings.budget).text : original;
      const prepared = prepareDigest(
        logical.entry,
        original,
        content,
        logical.outcome ?? undefined,
        { model: settings.model ?? undefined, runnerName: settings.runner },
      );
      return { ...prepared, originalContent: original, content };
    },
    validate(value, input) {
      const result = value as { digest: Digest; lineage: DigestLineage };
      DigestSchema.parse(result.digest);
      if (result.lineage?.version !== 1) throw new Error("Invalid saved digest lineage");
      const logical = input.logicalInput as { entry: ManifestEntry };
      const original = fs.readFileSync(path.join(home, "exports", logical.entry.export), "utf8");
      const problems = validatePreferenceCandidates(
        result.digest.preferences ?? [],
        exportMessages(logical.entry.export, original),
      );
      if (problems.length)
        throw new Error(`Saved digest evidence is invalid: ${problems.join("; ")}`);
    },
    async run(request, settings, input, invoke) {
      const logical = input.logicalInput as { entry: ManifestEntry };
      let prompt = request.prompt;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = DigestResponseSchema.parse(
          await invoke({
            prompt,
            schema: DigestResponseSchema,
            model: settings.model ?? undefined,
            timeoutMs: settings.timeoutMs,
          }),
        );
        const { digest: value, problems } = validateDigestEvidence(
          response,
          logical.entry.export,
          request.content as string,
          request.originalContent as string,
        );
        if (!problems.length) return { digest: value, lineage: request.lineage };
        if (attempt === 1)
          throw new Error(
            `digest evidence failed validation after one retry: ${problems.join("; ")}`,
          );
        prompt = `${request.prompt}\n\nYour previous preference evidence had these problems:\n${problems.map((problem) => `- ${problem}`).join("\n")}\nCorrect every citation using the supplied human messages. Omit any unsupported suggestion.`;
      }
      throw new Error("Digest evidence could not be validated");
    },
    publish(value, input) {
      const result = value as { digest: Digest; lineage: DigestLineage };
      const checkpoint = loadDigests(home);
      if (!checkpoint || checkpoint.generation !== input.generation)
        throw new Error("Digest checkpoint generation changed");
      const id = (input.logicalInput as { entry: ManifestEntry }).entry.export;
      checkpoint.digests[id] = result.digest;
      checkpoint.lineage ??= {};
      checkpoint.lineage[id] = result.lineage;
      checkpoint.invalidated = checkpoint.invalidated?.filter((key) => key !== id);
      if (!checkpoint.invalidated?.length) delete checkpoint.invalidated;
      saveDigests(home, checkpoint);
      return { kind: "digest", exportName: id, hash: fingerprint(result) };
    },
  };
  const author: RetryHandler = {
    guard(input, operation) {
      const logical = input.logicalInput as AuthorLogicalInput;
      const currentTasks = loadTasks(home);
      const currentTask = currentTasks?.tasks.find((task) => task.slug === logical.task.slug);
      if (
        !currentTasks ||
        currentTasks.generation !== input.generation ||
        !currentTask ||
        fingerprint(currentTask) !== fingerprint(logical.task)
      )
        throw new Error("Saved task definition changed; use normal distill to prepare new inputs");
      const currentDigests = loadDigests(home);
      const currentAnaphora = readAnaphora(home);
      for (const member of logical.members) {
        if (
          fingerprint(currentDigests?.digests[member.exportName] ?? null) !==
            fingerprint(member.digest ?? null) ||
          (currentDigests?.lineage?.[member.exportName]?.fingerprint ?? null) !==
            logical.upstream[member.exportName] ||
          fingerprint(currentAnaphora[member.exportName] ?? null) !==
            fingerprint(member.anaphora ?? null)
        )
          throw new Error(
            `Author evidence changed for ${member.exportName}; use normal distill to prepare new inputs`,
          );
      }
      const slug = (input.logicalInput as AuthorLogicalInput).task.slug;
      const current = readOptional(guardedPath(home, `library/${slug}/${slug}.oneshot.md`));
      if (current === null) {
        if (readOptional(guardedPath(home, `library/${slug}/sources.json`)) !== null)
          throw new Error(
            "Previous author provenance is protected; use normal distill to repair the missing prompt",
          );
        return;
      }
      const store = new OperationStore(home);
      const saved = store.list().some((record) => record.id === operation.id)
        ? store.readResult(operation.id)
        : null;
      if (saved && (saved.value as AuthorResult).oneshot === current) return;
      throw new Error("Existing prompt is protected; use normal distill to refresh it");
    },
    prepare(input, settings) {
      const logical = input.logicalInput as AuthorLogicalInput;
      if (!SLUG_PATTERN.test(logical.task.slug)) throw new Error("Unsafe author task slug");
      const current = readOptional(
        path.join(home, "library", logical.task.slug, `${logical.task.slug}.oneshot.md`),
      );
      // A strict retry cannot overwrite any previously committed prompt version.
      if (current !== null)
        throw new Error("Existing prompt is protected; use normal distill to refresh it");
      return prepareAuthorRequest(home, input, settings);
    },
    validate(value, input) {
      const result = value as AuthorResult;
      AuthorSchema.parse(result.authored);
      const sources = parseSourcesJson(result.sources);
      if (
        !sources ||
        sources.slug !== (input.logicalInput as AuthorLogicalInput).task.slug ||
        sources.oneshot_hash !== oneshotHash(result.oneshot)
      )
        throw new Error("Saved author publication is invalid");
    },
    async run(request, settings, input, invoke) {
      const authored = AuthorSchema.parse(
        await invoke({
          prompt: request.prompt,
          schema: AuthorSchema,
          model: settings.model ?? undefined,
          timeoutMs: settings.timeoutMs,
        }),
      );
      return authorResult(authored, request, input, settings);
    },
    publish(value, input) {
      return publishAuthorResult(home, value as AuthorResult, input);
    },
  };
  const window: RetryHandler = {
    guard(input) {
      const logical = input.logicalInput as {
        windowIds: string[];
        digests: Record<string, Digest>;
        upstream: Record<string, string | null>;
      };
      const current = loadDigests(home);
      for (const id of logical.windowIds) {
        if (
          fingerprint(current?.digests[id] ?? null) !== fingerprint(logical.digests[id]) ||
          (current?.lineage?.[id]?.fingerprint ?? null) !== logical.upstream[id]
        )
          throw new Error(
            `Clustering input changed for ${id}; use normal distill to prepare new inputs`,
          );
      }
    },
    prepare(input, settings) {
      if (input.request.prompt.length > settings.budget)
        throw new Error(
          `Cluster window prompt exceeds input budget ${settings.budget}; saved membership is fixed`,
        );
      return input.request;
    },
    validate(value, input) {
      const cluster = ClusterSchema.parse(value);
      const problems = validateCluster(
        cluster,
        (input.logicalInput as { windowIds: string[] }).windowIds,
      );
      if (problems.length) throw new Error(`Invalid saved cluster: ${problems.join("; ")}`);
    },
    async run(request, settings, input, invoke) {
      const ids = (input.logicalInput as { windowIds: string[] }).windowIds;
      let prompt = request.prompt;
      for (let attempt = 0; attempt < 2; attempt++) {
        const value = canonicalizeClusterIds(
          ClusterSchema.parse(
            await invoke({
              prompt,
              schema: ClusterSchema,
              model: settings.model ?? undefined,
              timeoutMs: settings.timeoutMs,
            }),
          ),
          ids,
        );
        const problems = validateCluster(value, ids);
        if (!problems.length) return value;
        if (attempt === 1)
          throw new Error(`clustering failed validation after one retry: ${problems.join("; ")}`);
        prompt = `${request.prompt}\n\nYour previous grouping had these problems:\n${problems.map((problem) => `- ${problem}`).join("\n")}\nProduce a corrected grouping that fixes every problem. Remember: every id in at least one task or misc, unique 2-5-word kebab-case slugs, only the listed ids.`;
      }
      throw new Error("Cluster validation failed");
    },
    publish() {
      throw new Error("Strict cluster retry cannot publish grouping");
    },
  };
  const merge: RetryHandler = {
    guard: window.guard,
    prepare: window.prepare,
    validate(value, input) {
      const result = ClusterMergeSchema.parse(value);
      const { notes } = applyClusterMerges(
        (input.logicalInput as { combined: ClusterTask[] }).combined,
        result.merges,
      );
      if (notes.length) throw new Error(`Invalid merge: ${notes.join("; ")}`);
    },
    async run(request, settings, input, invoke) {
      const result = ClusterMergeSchema.parse(
        await invoke({
          prompt: request.prompt,
          schema: ClusterMergeSchema,
          model: settings.model ?? undefined,
          timeoutMs: settings.timeoutMs,
        }),
      );
      merge.validate(result, input);
      return result;
    },
    publish: window.publish,
  };
  return { digest, author, "cluster-window": window, "cluster-merge": merge };
}

/** Provenance is also evidence of previous success when the prompt was deleted. */
function protectedRecoveryOutput(home: string, slug: string): boolean {
  if (readOptional(guardedPath(home, `library/${slug}/${slug}.oneshot.md`)) !== null) return true;
  const raw = readOptional(guardedPath(home, `library/${slug}/sources.json`));
  if (raw === null) return false;
  const sources = parseSourcesJson(JSON.parse(raw));
  if (!sources || sources.slug !== slug)
    throw new Error(`Existing provenance cannot be verified safely: ${slug}`);
  return true;
}

/** Exact named legacy author recovery; this preparation is entirely read-only. */
export function prepareTaskRecoveryInputs(
  home: string,
  slugs: string[],
  overrides: Partial<AttemptSettings> = {},
): QueueOperation[] {
  const tasks = loadTasks(home);
  const digests = loadDigests(home);
  if (!tasks || !digests || tasks.generation !== digests.generation)
    throw new Error("Named recovery requires matching saved tasks and digests");
  if (
    !slugs.length ||
    slugs.some((slug) => !SLUG_PATTERN.test(slug)) ||
    new Set(slugs).size !== slugs.length
  )
    throw new Error("Recovery task list is empty, malformed, or contains duplicates");
  const missing = slugs.filter((slug) => !tasks.tasks.some((task) => task.slug === slug));
  if (missing.length) throw new Error(`Unknown recovery task(s): ${missing.join(", ")}`);
  const eligibleSlugs = slugs.filter((slug) => !protectedRecoveryOutput(home, slug));
  if (!eligibleSlugs.length) return [];
  const raw = JSON.parse(fs.readFileSync(path.join(home, "exports", "manifest.json"), "utf8")) as
    | { entries?: ManifestEntry[] }
    | ManifestEntry[];
  const entries = Array.isArray(raw) ? raw : (raw.entries ?? []);
  const anaphora = readAnaphora(home);
  const runId = newGeneration();
  const recordedRunner = tasks.lineage?.runner;
  if (!overrides.runner && !recordedRunner)
    throw new Error(
      "Saved tasks do not record a runner; supply --runner for explicit named recovery",
    );
  return eligibleSlugs.map((slug) => {
    const task = tasks.tasks.find((task) => task.slug === slug) as ClusterTask;
    if (readOptional(path.join(home, "library", slug, `${slug}.oneshot.md`)) !== null)
      throw new Error(`Existing prompt is protected: ${slug}`);
    if (
      !task.members.some((id) =>
        ["completed", "partial"].includes(digests.digests[id]?.outcome ?? ""),
      )
    )
      throw new Error(`Task has no completed/partial member: ${slug}`);
    const settings: AttemptSettings = {
      runner: recordedRunner ?? "claude",
      model: tasks.lineage?.model ?? null,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      timeoutExplicit: false,
      budget: DEFAULT_INPUT_BUDGET,
      truncate: "never",
      ...overrides,
    };
    const logicalInput: AuthorLogicalInput = {
      task,
      generation: tasks.generation,
      toolVersion: "1.8.4",
      entries: entries.filter((entry) => task.members.includes(entry.export)),
      members: task.members.map((id) => ({
        contentHash: contentFingerprint(fs.readFileSync(path.join(home, "exports", id), "utf8")),
        exportName: id,
        digest: digests.digests[id],
        anaphora: anaphora[id],
        origin: entries.find((entry) => entry.export === id)?.origin,
      })),
      upstream: Object.fromEntries(
        [...task.members].sort().map((id) => [id, digests.lineage?.[id]?.fingerprint ?? null]),
      ),
    };
    return {
      kind: "author",
      unitId: slug,
      generation: tasks.generation,
      runId,
      source: "explicit-task-recovery",
      promptVersion: AUTHOR_PROMPT_VERSION,
      schema: toJsonSchema(AuthorSchema),
      logicalInput,
      settings,
      sources: task.members.map((id) =>
        sourceReference(id, fs.readFileSync(path.join(home, "exports", id), "utf8")),
      ),
      request: { prompt: "" },
      publication: {
        kind: "author",
        slug,
        expectedOneshotHash: null,
        oneshotPath: `library/${slug}/${slug}.oneshot.md`,
        sourcesPath: `library/${slug}/sources.json`,
      },
    };
  });
}

export function createRecoveryOperations(options: {
  home: string;
  slugs: string[];
  overrides?: Partial<AttemptSettings>;
}): QueueOperation[] {
  return prepareTaskRecoveryInputs(options.home, options.slugs, options.overrides);
}
