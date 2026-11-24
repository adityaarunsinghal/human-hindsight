import fs from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import type { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import type { ManifestEntry } from "../commands/export.js";
import { nextCommandText } from "../commands/next.js";
import type { AnaphoraRecord } from "../core/anaphora.js";
import { parseAnaphoraMap, parseSourcesJson, type SourcesJson } from "../core/artifacts.js";
import {
  allocateMemberBudgets,
  DEFAULT_CONCURRENCY,
  DEFAULT_INPUT_BUDGET,
  middleCut,
  type TruncatePolicy,
} from "../core/budget.js";
import {
  contentFingerprint,
  fingerprint,
  reusableLineage,
  type StageLineage,
  stageLineage,
} from "../core/fingerprint.js";
import { atomicWriteFilePrivate, mkdirPrivate } from "../core/fsutil.js";
import {
  isOutcomeVerified,
  OUTCOME_NOT_VERIFIED,
  oneshotHash,
  PUBLISH_INTENT_FILE,
  readLibrary,
  readPublishIntent,
} from "../core/library.js";
import { isPlanLabel } from "../core/model-plan.js";
import { type GroupOutcome, groupOutcome } from "../core/outcome.js";
import { damagedFile } from "../core/plain-failure.js";
import { exportMessages, validatePreferenceCandidates } from "../core/preference-evidence.js";
import { DEFAULT_TIMEOUT_MS } from "../runners/shared.js";
import type { ResolvedCall, RunnerName } from "../runners/types.js";
import { glyph } from "../ui/mode.js";
import { counted, fail, nounFor, skip as skipGlyph } from "../ui/style.js";
import { loadDigests, loadTasks, newGeneration } from "./checkpoints.js";
import {
  type AttemptSettings,
  guardedPath,
  type OperationInput,
  OperationStore,
  type PreparedRequest,
  type QueueOperation,
} from "./operations.js";
import {
  AUTHOR_PROMPT_VERSION,
  type AuthorMemberInput,
  buildAuthorPrompt,
} from "./prompts/author.js";
import type { RetryHandler } from "./retry.js";
import { AuthorSchema, type ClusterTask, type Digest, toJsonSchema } from "./schemas.js";
import type { StageProgressSink } from "./stage-events.js";
import {
  defaultResolution,
  executeOperation,
  FailureBreaker,
  operationSettings,
  type RunnerFn,
  reusableOperation,
  runItems,
  SLUG_PATTERN,
  type StageFailure,
  sourceReference,
  stageReporter,
  stageRunner,
  truncate,
} from "./stage-support.js";

export type { SourcesJson };

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
  /** Tasks skipped because every member session was abandoned. */
  skipped: SkippedTask[];
  /**
   * Tasks authored or resumed by this run whose prompt is marked "outcome not
   * verified" (`outcome_verified: false` in `sources.json`), in task order.
   */
  unverified: string[];
  /** Prompts the person edited by hand, kept as they are (`--force` replaces them). */
  kept: SkippedTask[];
  /**
   * Prompts this run wrote from part of their group: the whole group did not
   * fit one call, so the whole sessions that fit were used and the rest left out.
   */
  fitted: { slug: string; used: number; sessions: number }[];
  failed: StageFailure[];
  notAttempted: string[];
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
  runnerName?: RunnerName;
  identityRunner?: RunnerName | null;
  progress?: StageProgressSink;
  breaker?: boolean;
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
  /** Max author calls in flight at once (default 10). */
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

/** Which of {@link groupOutcome}'s three cases a task is in, from its members' digests. */
function taskOutcome(members: string[], digests: Record<string, Digest>): GroupOutcome {
  return groupOutcome(members.map((member) => digests[member]?.outcome));
}

/** The plain reason a task whose every session was abandoned gets no prompt. */
function abandonedReason(sessions: number): string {
  return sessions === 1
    ? "its 1 session was abandoned"
    : `all ${counted(sessions, "session")} were abandoned`;
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
    ...(sources.outcome_verified === false ? ["  outcome: not verified"] : []),
    ...(sources.runner ? [`  runner: ${sources.runner}`] : []),
    `  model: ${sources.model ?? "runner default"}; prompt v${sources.prompt_version}; ${sources.authored_at}`,
    "-->",
  ].join("\n");
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

/** Fields the generator owns; every other key in `sources.json` is the person's (a rating, say). */
const GENERATED_KEYS = new Set([
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
  "runner",
  "prompt_version",
  "tool_version",
  "generation",
  "lineage",
  "input_coverage",
  "truncations",
  "oneshot_hash",
  "outcome_verified",
]);

/** The provenance on disk as a plain object; {} when absent, an error when unreadable. */
function latestProvenance(sourcesPath: string): Record<string, unknown> {
  const raw = readOptional(sourcesPath);
  if (raw === null) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Existing provenance cannot be read safely");
  return parsed as Record<string, unknown>;
}

/**
 * Only generator-owned fields may replace the latest human metadata. A
 * generator-owned field the new provenance leaves out is removed, so a prompt
 * written again once a session reached a result loses its "not verified" mark.
 */
function mergeProvenance(
  latest: Record<string, unknown>,
  generated: SourcesJson,
): Record<string, unknown> {
  const sources: Record<string, unknown> = { ...generated, ...latest };
  for (const key of GENERATED_KEYS) {
    if (key in generated) sources[key] = (generated as Record<string, unknown>)[key];
    else delete sources[key];
  }
  return sources;
}

function entryPaths(home: string, slug: string) {
  if (!SLUG_PATTERN.test(slug)) throw new Error("Unsafe author task slug");
  const dir = guardedPath(home, `library/${slug}`);
  return {
    dir,
    oneshotPath: path.join(dir, `${slug}.oneshot.md`),
    sourcesPath: path.join(dir, "sources.json"),
    intentPath: path.join(dir, PUBLISH_INTENT_FILE),
  };
}

/**
 * Finish or drop a publication that a crash interrupted (see
 * {@link PUBLISH_INTENT_FILE}). When the prompt on disk is exactly the one the
 * intent names, its provenance is written now, merged with whatever the
 * person changed in `sources.json` since. Any other prompt content means the
 * crash came before the prompt was replaced, or the person edited it after:
 * either way the provenance on disk already describes the situation, so the
 * intent is dropped and a hand edit stays protected. Runs under the writer lock.
 */
function settleInterruptedPublication(
  home: string,
  slug: string,
): "none" | "completed" | "dropped" {
  const paths = entryPaths(home, slug);
  if (!fs.existsSync(paths.intentPath)) return "none";
  const intent = readPublishIntent(paths.dir, slug);
  const current = readOptional(paths.oneshotPath);
  if (intent && current !== null && oneshotHash(current) === intent.oneshot_hash) {
    const merged = mergeProvenance(latestProvenance(paths.sourcesPath), intent.sources);
    atomicWriteFilePrivate(paths.sourcesPath, `${JSON.stringify(merged, null, 2)}\n`);
    fs.rmSync(paths.intentPath, { force: true });
    return "completed";
  }
  fs.rmSync(paths.intentPath, { force: true });
  return "dropped";
}

/**
 * The person edited the prompt while its call was in flight: the edit stays,
 * the generated result is saved, and `--force` replaces the edit without a
 * new call.
 */
class EditKeptError extends Error {
  constructor(home: string) {
    super(
      `Prompt changed while authoring; generated result saved, human edit kept. Run ${nextCommandText("reflect", { home })} --force to replace the edit with it`,
    );
    this.name = "EditKeptError";
  }
}

/**
 * Publish a saved author result. The prompt is replaced only when it still
 * has the content this run planned against (`planned`, a hash or null for
 * "no file"; a strict retry uses the hash recorded when the operation was
 * queued), or already is this result. With `--force` the plan saw the edited
 * file and chose to replace it, so the same check lets the replacement land;
 * an edit made while the call was in flight is still kept. Recoverable from a
 * crash between the two writes (see {@link settleInterruptedPublication}).
 */
function publishAuthorResult(
  home: string,
  value: AuthorResult,
  input: OperationInput,
  planned?: string | null,
) {
  const slug = (input.logicalInput as AuthorLogicalInput).task.slug;
  const paths = entryPaths(home, slug);
  settleInterruptedPublication(home, slug);
  const current = readOptional(paths.oneshotPath);
  const expected =
    planned !== undefined ? planned : (input.publication?.expectedOneshotHash ?? null);
  const hash = current === null ? null : contentFingerprint(current);
  if (hash !== expected && hash !== contentFingerprint(value.oneshot)) {
    throw new EditKeptError(home);
  }
  const sources = mergeProvenance(latestProvenance(paths.sourcesPath), value.sources);
  mkdirPrivate(paths.dir);
  const intent = {
    version: 1,
    slug,
    oneshot_hash: oneshotHash(value.oneshot),
    sources: value.sources,
  };
  atomicWriteFilePrivate(paths.intentPath, `${JSON.stringify(intent, null, 2)}\n`);
  atomicWriteFilePrivate(paths.oneshotPath, value.oneshot);
  atomicWriteFilePrivate(paths.sourcesPath, `${JSON.stringify(sources, null, 2)}\n`);
  fs.rmSync(paths.intentPath, { force: true });
  return {
    kind: "author",
    oneshotHash: contentFingerprint(value.oneshot),
    sourcesHash: fingerprint(sources),
  };
}

function prepareAuthorRequest(
  home: string,
  logical: AuthorLogicalInput,
  settings: AttemptSettings,
  contents?: Map<string, string>,
): PreparedRequest {
  const members: AuthorMemberInput[] = logical.members
    .map(({ contentHash: _hash, ...member }) => {
      const entry = logical.entries.find((entry) => entry.export === member.exportName);
      return {
        ...member,
        origin: member.origin ?? (entry ? (entry.origin ?? "claude") : undefined),
        content:
          contents?.get(member.exportName) ??
          fs.readFileSync(guardedPath(home, `exports/${member.exportName}`), "utf8"),
      };
    })
    .sort((a, b) => a.exportName.localeCompare(b.exportName));
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
  let included = members;
  const truncations: { export: string; block: number; dropped_chars: number }[] = [];
  if (total > settings.budget && settings.truncate === "never") {
    // Nothing is shortened. The prompt is written from the whole sessions
    // that fit, and each session left out is recorded with the prompt.
    const lastActive = (name: string) =>
      logical.entries.find((entry) => entry.export === name)?.last_ts ?? "";
    const fitted = fitWholeMembers(members, settings.budget, lastActive);
    if (!fitted.kept.length)
      throw new Error(
        `The group's input is ${total.toLocaleString("en-US")} characters, over the size limit per call of ${settings.budget.toLocaleString("en-US")}`,
      );
    included = fitted.kept;
    for (const member of fitted.left)
      truncations.push({
        export: member.exportName,
        block: 0,
        dropped_chars: member.content.length,
      });
    const left = fitted.left.reduce((sum, member) => sum + member.content.length, 0);
    inputCoverage = total ? (total - left) / total : 1;
  } else if (total > settings.budget) {
    const shares = allocateMemberBudgets(
      members.map((member) => member.content.length),
      settings.budget,
    );
    let dropped = 0;
    for (const [index, member] of members.entries()) {
      const cut = middleCut(member.content, shares[index] ?? 0);
      member.content = cut.text;
      dropped += cut.dropped;
      if (cut.dropped)
        truncations.push({ export: member.exportName, block: 0, dropped_chars: cut.dropped });
    }
    inputCoverage = total ? (total - dropped) / total : 1;
  }
  const prompt = buildAuthorPrompt({ task: logical.task, members: included });
  const lineage = stageLineage({
    stage: "author",
    promptVersion: AUTHOR_PROMPT_VERSION,
    schema: toJsonSchema(AuthorSchema),
    model: settings.model ?? undefined,
    runnerName: settings.automatic ? null : settings.runner,
    inputs: {
      prompt,
      task: { ...logical.task, members: [...logical.task.members].sort() },
      originalMembers: originals,
      upstream: logical.upstream,
    },
  });
  // The sessions the prompt was written from: what it records as its evidence.
  const written = included.map((member) => member.exportName);
  return { prompt, inputCoverage, truncations, lineage, written };
}

/** Sessions that ended with a result come first when a group does not fit one call. */
const OUTCOME_RANK: Record<string, number> = { completed: 0, partial: 1, unclear: 2, abandoned: 3 };

/**
 * The whole sessions of a group that fit one call. Nothing is cut: a session
 * is used entire or left out. Sessions that reached a result come first, then
 * the newest; one that does not fit is passed over for a smaller one.
 */
export function fitWholeMembers<M extends { exportName: string; content: string; digest?: Digest }>(
  members: M[],
  budget: number,
  lastActive: (exportName: string) => string = () => "",
): { kept: M[]; left: M[] } {
  const rank = (member: M) => OUTCOME_RANK[member.digest?.outcome ?? "unclear"] ?? 2;
  const order = [...members].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      lastActive(b.exportName).localeCompare(lastActive(a.exportName)) ||
      a.exportName.localeCompare(b.exportName),
  );
  const kept = new Set<M>();
  let used = 0;
  for (const member of order) {
    if (used + member.content.length > budget) continue;
    kept.add(member);
    used += member.content.length;
  }
  // The order the prompt has always listed its sessions in.
  return {
    kept: members.filter((member) => kept.has(member)),
    left: members.filter((member) => !kept.has(member)),
  };
}

function authorResult(
  authored: z.infer<typeof AuthorSchema>,
  request: PreparedRequest,
  input: OperationInput,
  resolved: ResolvedCall,
  toolVersion: string,
): AuthorResult {
  const logical = input.logicalInput as AuthorLogicalInput;
  const digests = Object.fromEntries(
    logical.members.map((member) => [member.exportName, member.digest as Digest]),
  ) as Record<string, Digest>;
  const entries = new Map(logical.entries.map((entry) => [entry.export, entry]));
  // A prompt written from part of its group answers only for those sessions:
  // their outcomes, and the preferences quoted from them. A request saved
  // before this was recorded used every session.
  const written = new Set((request.written as string[] | undefined) ?? logical.task.members);
  const used = logical.task.members.filter((id) => written.has(id));
  // No session it was written from reached a result that could be verified:
  // the prompt is kept but marked, at the lowest confidence, whatever the writer claimed.
  const verified = taskOutcome(used, digests) === "verified";
  const sources: SourcesJson = {
    slug: logical.task.slug,
    title: authored.title,
    members: logical.task.members,
    sessionIds: logical.task.members.map((id) => entries.get(id)?.sessionId ?? "unknown"),
    preferences: logical.members
      .filter((member) => written.has(member.exportName))
      .flatMap((member) =>
        (member.digest?.preferences ?? []).map((candidate) => ({
          ...candidate,
          ...(candidate.scope === "global"
            ? {}
            : { project: entries.get(member.exportName)?.project ?? "" }),
        })),
      ),
    outcome_summary: summarizeOutcomes(used, digests),
    domains: [
      ...new Set(
        logical.task.members
          .map((id) => digests[id]?.domain.trim().toLowerCase())
          .filter((domain): domain is string => Boolean(domain)),
      ),
    ],
    confidence: verified ? authored.confidence : "low",
    ...(verified ? {} : { outcome_verified: false as const }),
    authored_at: new Date().toISOString(),
    model: resolved.model ?? null,
    runner: resolved.runner,
    prompt_version: AUTHOR_PROMPT_VERSION,
    tool_version: toolVersion,
    generation: logical.generation,
    lineage: { ...(request.lineage as StageLineage), resolved },
    input_coverage: request.inputCoverage as number,
    truncations: request.truncations as SourcesJson["truncations"],
  };
  const oneshot = `${provenanceComment(sources)}\n\n# ${authored.title}\n\n${authored.oneshot_markdown.trim()}\n`;
  sources.oneshot_hash = oneshotHash(oneshot);
  return { authored, sources, oneshot };
}
function protectedRecoveryOutput(home: string, slug: string): boolean {
  if (readOptional(guardedPath(home, `library/${slug}/${slug}.oneshot.md`)) !== null) return true;
  const raw = readOptional(guardedPath(home, `library/${slug}/sources.json`));
  if (raw === null) return false;
  const sources = parseSourcesJson(JSON.parse(raw));
  if (!sources || sources.slug !== slug)
    throw new Error(`Existing provenance cannot be verified safely: ${slug}`);
  return true;
}

/**
 * The model the normal author stage used for this generation, so a named
 * recovery has the same identity as a normal run. Evidence, in order: other
 * author records of the generation in the ledger, then library entries of the
 * generation. Without either, the grouping's own model is used only when it
 * is a plan label or the CLI default (grouping and writing share the "major"
 * role, so the label is the same); a concrete grouping model may have come
 * from `--cluster-model`, which never applied to writing, so it proves nothing
 * and `undefined` is returned.
 */
function recordedAuthorModel(
  home: string,
  tasks: NonNullable<ReturnType<typeof loadTasks>>,
  ledger: OperationStore | null,
): string | null | undefined {
  const agreed = (models: (string | null)[]) => {
    const distinct = [...new Set(models)];
    return distinct.length === 1 ? distinct[0] : undefined;
  };
  const fromLedger = agreed(
    (ledger?.list() ?? [])
      .filter((op) => op.kind === "author" && op.generation === tasks.generation)
      .map(
        (op) =>
          (op.attempts.at(-1)?.settings ?? (ledger as OperationStore).loadInput(op.id).settings)
            .model,
      ),
  );
  if (fromLedger !== undefined) return fromLedger;
  const fromLibrary = agreed(
    readLibrary(home)
      .filter((entry) => entry.sources.generation === tasks.generation)
      .flatMap((entry) => {
        const lineage = (entry.sources as { lineage?: Partial<StageLineage> }).lineage;
        return lineage?.version === 1 && lineage.model !== undefined ? [lineage.model] : [];
      }),
  );
  if (fromLibrary !== undefined) return fromLibrary;
  const grouping = tasks.lineage?.model ?? null;
  return grouping === null || isPlanLabel(grouping) ? grouping : undefined;
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
  if (missing.length)
    throw new Error(`Unknown recovery ${nounFor(missing.length, "task")}: ${missing.join(", ")}`);
  const eligibleSlugs = slugs.filter((slug) => !protectedRecoveryOutput(home, slug));
  if (!eligibleSlugs.length) return [];
  const manifestFile = path.join(home, "exports", "manifest.json");
  let raw: { entries?: ManifestEntry[] } | ManifestEntry[];
  try {
    raw = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw damagedFile(manifestFile, "not valid JSON", "export");
  }
  const entries = Array.isArray(raw) ? raw : (raw?.entries ?? []);
  const anaphora = readAnaphora(home);
  const runId = newGeneration();
  const recordedRunner = tasks.ledger_runner ?? tasks.lineage?.runner;
  const ledger = fs.existsSync(guardedPath(home, "distill/operations.json"))
    ? new OperationStore(home)
    : null;
  const recordedAuthors = new Map(
    ledger
      ?.list()
      .filter(
        (op) =>
          op.kind === "author" && op.generation === tasks.generation && op.state !== "superseded",
      )
      .map((op) => [op.unitId, op]),
  );
  const authorModel = recordedAuthorModel(home, tasks, ledger);
  return eligibleSlugs.map((slug) => {
    const task = tasks.tasks.find((task) => task.slug === slug) as ClusterTask;
    if (readOptional(path.join(home, "library", slug, `${slug}.oneshot.md`)) !== null)
      throw new Error(`Existing prompt is protected: ${slug}`);
    if (taskOutcome(task.members, digests.digests) === "abandoned")
      throw new Error(`${slug}: ${abandonedReason(task.members.length)}, so it gets no prompt`);
    const prior = recordedAuthors.get(slug);
    const previous =
      prior && ledger
        ? (prior.attempts.at(-1)?.settings ?? ledger.loadInput(prior.id).settings)
        : undefined;
    if (!overrides.runner && !previous && !recordedRunner)
      throw new Error(
        "Saved tasks do not record a runner; supply --runner for explicit named recovery",
      );
    if (!previous && overrides.model === undefined && authorModel === undefined)
      throw new Error(
        `The saved grouping does not say which model writes prompts (grouping used ${tasks.lineage?.model}); pass --author-model, --model, or --quality to choose it`,
      );
    const settings: AttemptSettings = {
      runner: recordedRunner ?? "claude",
      ...(!previous && tasks.lineage?.runner === null && recordedRunner ? { automatic: true } : {}),
      model: authorModel ?? null,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      timeoutExplicit: false,
      budget: DEFAULT_INPUT_BUDGET,
      truncate: "never",
      ...previous,
      ...overrides,
    };
    if (
      overrides.automatic === undefined &&
      (overrides.runner || (overrides.model && !isPlanLabel(overrides.model)))
    )
      delete settings.automatic;
    const { logical: logicalInput, sources } = collectAuthorInput({
      home,
      task,
      entries,
      digests: digests.digests,
      lineage: digests.lineage,
      anaphora,
      generation: tasks.generation,
      toolVersion: pkg.version,
    });
    return {
      kind: "author",
      unitId: slug,
      generation: tasks.generation,
      runId,
      source: "explicit-task-recovery",
      recoveryOverrides: overrides,
      promptVersion: AUTHOR_PROMPT_VERSION,
      schema: toJsonSchema(AuthorSchema),
      logicalInput,
      settings,
      sources,
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

/**
 * `planned` holds, per slug, the prompt hash a normal run saw when it planned
 * the task (null: no file). Publication compares against it, not against the
 * hash stored when a reused record was first queued, which may be from an
 * earlier run.
 */
export function authorHandler(
  home: string,
  toolVersion: string = pkg.version,
  planned?: ReadonlyMap<string, string | null>,
): RetryHandler {
  const reflect = nextCommandText("reflect", { home });
  return {
    guard(input, operation, store) {
      const logical = input.logicalInput as AuthorLogicalInput;
      const currentTasks = loadTasks(home);
      const currentTask = currentTasks?.tasks.find((task) => task.slug === logical.task.slug);
      if (
        !currentTasks ||
        currentTasks.generation !== input.generation ||
        !currentTask ||
        fingerprint(currentTask) !== fingerprint(logical.task)
      )
        throw new Error(
          `Its group changed since it failed; run ${reflect} without --retry-failed to prepare it again`,
        );
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
            `The summary of ${member.exportName} changed since it failed; run ${reflect} without --retry-failed to prepare it again`,
          );
      }
      const slug = (input.logicalInput as AuthorLogicalInput).task.slug;
      const current = readOptional(guardedPath(home, `library/${slug}/${slug}.oneshot.md`));
      if (current === null) {
        if (readOptional(guardedPath(home, `library/${slug}/sources.json`)) !== null)
          throw new Error(
            `Its prompt file is missing but its sources are kept; run ${reflect} without --retry-failed to write it again`,
          );
        return;
      }
      const saved = store?.find(operation.id) ? store.readResult(operation.id) : null;
      if (saved && (saved.value as AuthorResult).oneshot === current) return;
      throw new Error(
        `A prompt is already saved for it; run ${reflect} without --retry-failed to refresh it`,
      );
    },
    prepare(input, settings) {
      const logical = input.logicalInput as AuthorLogicalInput;
      if (!SLUG_PATTERN.test(logical.task.slug)) throw new Error("Unsafe author task slug");
      const current = readOptional(
        path.join(home, "library", logical.task.slug, `${logical.task.slug}.oneshot.md`),
      );
      // A strict retry cannot overwrite any previously committed prompt version.
      if (current !== null)
        throw new Error(
          `A prompt is already saved for it; run ${reflect} without --retry-failed to refresh it`,
        );
      return prepareAuthorRequest(home, logical, settings);
    },
    validate(value, input, source = "ledger") {
      const result = value as AuthorResult;
      // The stage runner enforces the schema on its answer; anything read back, or
      // returned through strict retry's adapter, is parsed again here.
      if (source === "ledger") AuthorSchema.parse(result.authored);
      const sources = parseSourcesJson(result.sources);
      if (
        !sources ||
        sources.slug !== (input.logicalInput as AuthorLogicalInput).task.slug ||
        sources.oneshot_hash !== oneshotHash(result.oneshot)
      )
        throw new Error("Saved author publication is invalid");
    },
    async run(request, settings, input, invoke) {
      let resolved = defaultResolution(settings);
      const authored = await invoke({
        prompt: request.prompt,
        schema: AuthorSchema,
        model: settings.model ?? undefined,
        timeoutMs: settings.timeoutMs,
        onResolved(actual) {
          resolved = actual;
        },
      });
      return authorResult(authored, request, input, resolved, toolVersion);
    },
    publish(value, input) {
      const slug = (input.logicalInput as AuthorLogicalInput).task.slug;
      return publishAuthorResult(home, value as AuthorResult, input, planned?.get(slug));
    },
  };
}

function collectAuthorInput(o: {
  home: string;
  task: ClusterTask;
  entries: ManifestEntry[];
  digests: Record<string, Digest>;
  lineage?: Record<string, StageLineage>;
  anaphora: Record<string, AnaphoraRecord[]>;
  generation: string;
  toolVersion: string;
}) {
  const entries = o.entries.filter((entry) => o.task.members.includes(entry.export));
  const contents = new Map<string, string>();
  const members = o.task.members.map((name) => {
    let content: string;
    try {
      content = fs.readFileSync(guardedPath(o.home, `exports/${name}`), "utf8");
    } catch {
      throw new Error(`member export unreadable: ${name}`);
    }
    contents.set(name, content);
    const entry = entries.find((entry) => entry.export === name);
    return {
      exportName: name,
      contentHash: contentFingerprint(content),
      digest: o.digests[name],
      anaphora: o.anaphora[name],
      origin: entry ? (entry.origin ?? "claude") : undefined,
    };
  });
  const logical: AuthorLogicalInput = {
    task: o.task,
    entries,
    members,
    toolVersion: o.toolVersion,
    generation: o.generation,
    upstream: Object.fromEntries(
      o.task.members.map((id) => [id, o.lineage?.[id]?.fingerprint ?? null]),
    ),
  };
  const sources = [...contents].map(([name, content]) => sourceReference(name, content));
  return { logical, contents, sources };
}

/**
 * The saved author result whose prompt has the hash `sources.json` records:
 * the tool's own version of a prompt the person has since edited. Null when
 * the ledger no longer holds it (or holds it damaged).
 */
function savedAuthorResult(
  store: OperationStore,
  slug: string,
  oneshotHashRecorded: string,
): { id: string; value: AuthorResult } | null {
  for (const record of store.unit("author", slug).reverse()) {
    if (!["committed", "result-saved"].includes(record.state)) continue;
    try {
      const value = store.readResult(record.id)?.value as AuthorResult | undefined;
      if (value?.sources?.oneshot_hash === oneshotHashRecorded) return { id: record.id, value };
    } catch {
      // A damaged saved result is not the tool's version; keep looking.
    }
  }
  return null;
}

/** Author viable tasks. Each result is durable before publication, and edits are checked again at publication. */
export async function runAuthorStage(opts: AuthorStageOptions): Promise<AuthorStageResult> {
  const reflect = nextCommandText("reflect", { home: opts.home });
  const settings = operationSettings(opts);
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY));
  const reporter = stageReporter(opts, concurrency);
  const breaker = new FailureBreaker(opts.breaker !== false);
  const store = new OperationStore(opts.home, opts.generation);
  const runId = newGeneration();
  const planned = new Map<string, string | null>();
  /** The reason prompts are written again is said once for the stage. */
  let explained = false;
  const handler = authorHandler(opts.home, opts.toolVersion, planned);
  const run = stageRunner(opts.runner);
  const anaphora = readAnaphora(opts.home);
  const lineage = loadDigests(opts.home)?.lineage;
  const result: AuthorStageResult = {
    generation: opts.generation,
    authored: [],
    resumed: [],
    skipped: [],
    unverified: [],
    kept: [],
    fitted: [],
    failed: [],
    notAttempted: [],
  };
  reporter.start(opts.tasks.length);
  try {
    const unattempted = await runItems(opts.tasks, concurrency, breaker, async (task, index) => {
      const id = task.slug;
      const label = `[${index + 1}/${opts.tasks.length}] ${id}`;
      let called = false;
      try {
        if (!SLUG_PATTERN.test(id)) throw new Error("Unsafe author task slug");
        const outcome = taskOutcome(task.members, opts.digests);
        if (outcome === "abandoned") {
          // Its preferences are kept by the digest stage; only the prompt is skipped.
          const reason = abandonedReason(task.members.length);
          result.skipped.push({ slug: id, reason });
          reporter.item(id, "skipped", `  ${label}: skipped (${reason})`);
          return;
        }
        // A crash between the two publication writes is finished (or
        // dropped) first, so our own prompt is never judged a hand edit.
        settleInterruptedPublication(opts.home, id);
        const oneshotPath = `library/${id}/${id}.oneshot.md`;
        const sourcesPath = `library/${id}/sources.json`;
        // Unreadable provenance counts as absent here. Publication refuses to
        // replace it, so a hand-broken file is never overwritten.
        let existing: SourcesJson | null = null;
        try {
          const raw = readOptional(guardedPath(opts.home, sourcesPath));
          existing = raw === null ? null : parseSourcesJson(JSON.parse(raw));
        } catch {
          existing = null;
        }
        let current: string | null;
        try {
          current = readOptional(guardedPath(opts.home, oneshotPath));
        } catch {
          throw new Error("existing prompt cannot be read safely; kept");
        }
        const { logical, contents, sources } = collectAuthorInput({
          ...opts,
          task,
          anaphora,
          lineage,
        });
        const queue = (prompt: string) =>
          store.queue({
            kind: "author",
            unitId: id,
            generation: opts.generation,
            runId,
            promptVersion: AUTHOR_PROMPT_VERSION,
            schema: toJsonSchema(AuthorSchema),
            logicalInput: logical,
            sources,
            settings,
            request: { prompt },
            publication: {
              kind: "author",
              slug: id,
              oneshotPath,
              sourcesPath,
              expectedOneshotHash: current === null ? null : contentFingerprint(current),
            },
          });
        const members = logical.members.map(({ contentHash: _hash, ...member }) => ({
          ...member,
          content: contents.get(member.exportName) ?? "",
        }));
        const stale = members.find(
          (member) =>
            validatePreferenceCandidates(
              member.digest?.preferences ?? [],
              exportMessages(member.exportName, member.content),
            ).length > 0,
        );
        if (stale)
          throw new Error(
            `member preference evidence is stale (${stale.exportName}); run ${reflect} to refresh the session summary`,
          );
        const total = members.reduce((sum, member) => sum + member.content.length, 0);
        // A group too long for one call is written from the whole sessions
        // that fit. It is blocked only when no single session of it fits.
        const fits =
          total <= settings.budget ||
          settings.truncate !== "never" ||
          fitWholeMembers(members, settings.budget).kept.length > 0;
        if (!fits) {
          // Recorded with the full prompt it would have sent; a blocked unit is never dispatched.
          store.block(
            queue(buildAuthorPrompt({ task, members })).id,
            `task input ${total} exceeds budget ${settings.budget}`,
          );
          result.failed.push({
            export: id,
            error: `task input (${total} chars across ${counted(members.length, "session")}) exceeds the input budget (${settings.budget}). Run ${reflect} --truncate=extreme or increase --input-budget.`,
          });
          reporter.item(
            id,
            "blocked",
            `  ${label}: ${skipGlyph(`blocked: ${total} chars exceed the input budget (${settings.budget}).`)} Run ${reflect} --truncate=extreme or increase --input-budget.`,
            true,
            `${id}: ${counted(total, "character")}, over the size limit per call of ${settings.budget.toLocaleString("en-US")}. Run ${reflect} --truncate=extreme or increase --input-budget.`,
          );
          return;
        }
        const request = prepareAuthorRequest(opts.home, logical, settings, contents);
        // Written from part of its group: said after the stage, by name.
        const leftOut =
          settings.truncate === "never" ? (request.truncations as unknown[]).length : 0;
        const noteFitted = () => {
          if (leftOut)
            result.fitted.push({
              slug: id,
              used: members.length - leftOut,
              sessions: members.length,
            });
        };
        const unchanged =
          existing?.generation === opts.generation &&
          current !== null &&
          reusableLineage(
            existing.lineage,
            request.lineage as StageLineage,
            (runner) =>
              prepareAuthorRequest(
                opts.home,
                logical,
                { ...settings, automatic: false, runner },
                contents,
              ).lineage as StageLineage,
          );
        // The file is not the prompt its provenance records: edited by hand,
        // or written by a version that recorded no hash.
        const differs =
          current !== null &&
          (!existing?.oneshot_hash || oneshotHash(current) !== existing.oneshot_hash);
        // The prompt an unfinished publication of ours left is no edit.
        const ourOwn =
          current !== null &&
          readPublishIntent(path.dirname(oneshotPath), id)?.oneshot_hash === oneshotHash(current);
        if (unchanged && existing && differs && !ourOwn && !opts.force) {
          // Counted as what it is, the same as when a run that writes meets it.
          const reason = existing.oneshot_hash
            ? `oneshot was edited by hand; run ${reflect} --force to overwrite`
            : `existing oneshot has no verified generation hash; run ${reflect} --force to overwrite`;
          result.kept.push({ slug: id, reason });
          reporter.item(id, "skipped", `  ${label}: ${reason}; kept`);
          return;
        }
        if (unchanged && existing && !(opts.force && differs)) {
          result.resumed.push(id);
          if (!isOutcomeVerified(existing)) result.unverified.push(id);
          reporter.item(id, "skipped", `  ${label}: already authored (inputs unchanged; skipped)`);
          return;
        }
        if (unchanged && existing?.oneshot_hash && current !== null) {
          // --force on an edited prompt whose inputs are unchanged: the tool's
          // own version is the saved result its provenance names, so it goes
          // back without a new call. Without that result it is written again.
          const saved = savedAuthorResult(store, id, existing.oneshot_hash);
          if (saved) {
            // Planned against the edited file, so an edit made since is still kept.
            store.commit(
              saved.id,
              publishAuthorResult(
                opts.home,
                saved.value,
                store.loadInput(saved.id),
                contentFingerprint(current),
              ),
            );
            result.authored.push(id);
            noteFitted();
            if (!isOutcomeVerified(saved.value.sources)) result.unverified.push(id);
            reporter.item(
              id,
              "done",
              `  ${label}: your edit replaced by the saved prompt (inputs unchanged; no new call)`,
            );
            return;
          }
        }
        const reusable = reusableOperation(store, "author", id, logical, settings, {
          promptVersion: AUTHOR_PROMPT_VERSION,
          schema: toJsonSchema(AuthorSchema),
          prompt: request.prompt,
        });
        // A prompt file equal to this unit's saved result is an interrupted
        // publication of our own output, not a hand edit.
        const ownOutput =
          current !== null &&
          !!reusable &&
          (store.readResult(reusable.id)?.value as AuthorResult | undefined)?.oneshot === current;
        if (
          !opts.force &&
          !ownOutput &&
          current !== null &&
          (!existing?.oneshot_hash || oneshotHash(current) !== existing.oneshot_hash)
        ) {
          const reason = existing?.oneshot_hash
            ? `oneshot was edited by hand; run ${reflect} --force to overwrite`
            : `existing oneshot has no verified generation hash; run ${reflect} --force to overwrite`;
          result.kept.push({ slug: id, reason });
          reporter.item(id, "skipped", `  ${label}: ${reason}; kept`);
          return;
        }
        const dropped = (request.truncations as NonNullable<SourcesJson["truncations"]>).reduce(
          (sum, cut) => sum + cut.dropped_chars,
          0,
        );
        if (dropped)
          reporter.detail(
            `  ${id}: shortened by ${counted(dropped, "character")} to fit the size limit per call`,
          );
        if (existing && current === null)
          reporter.detail(`  ${id}: the prompt file is missing, so it is written again`);
        else if (existing && !explained) {
          explained = true;
          reporter.note(
            "  Writing prompts again for groups whose sessions or settings changed since they were written.",
          );
        }
        const operation = reusable ?? queue(request.prompt);
        planned.set(id, current === null ? null : contentFingerprint(current));
        called = true;
        reporter.running(id, `writing ${id}`);
        const value = (await reporter.until(`writing ${id}`, () =>
          executeOperation({ store, operation, settings, request, run, handler, publish: true }),
        )) as AuthorResult;
        result.authored.push(id);
        noteFitted();
        const verified = isOutcomeVerified(value.sources);
        if (!verified) result.unverified.push(id);
        breaker.success();
        reporter.item(
          id,
          "done",
          `      ${glyph("→", "->")} ${value.sources.confidence} confidence, ${verified ? "" : `${OUTCOME_NOT_VERIFIED}, `}${counted(value.sources.preferences.length, "preference")}`,
        );
      } catch (error) {
        if (error instanceof EditKeptError) {
          // The call succeeded; the person's edit wins until --force.
          breaker.success();
          const reason = `edited by hand while it was being written; run ${reflect} --force to overwrite`;
          result.kept.push({ slug: id, reason });
          reporter.item(id, "skipped", `  ${label}: ${reason}; kept`);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        result.failed.push({ export: id, error: message });
        reporter.item(
          id,
          "failed",
          `  ${label} ${fail(`failed: ${truncate(message, 120)}`)}`,
          true,
          `${id}: ${truncate(message, 120)}`,
        );
        if (called) breaker.failure(error);
      }
    });
    result.notAttempted = unattempted.map((task) => task.slug);
    if (result.notAttempted.length)
      reporter.note(
        `  ${breaker.reason}. ${counted(result.notAttempted.length, "task")} not attempted. Fix the cause and run ${reflect} to resume. Add --no-breaker to continue past repeated failures.`,
      );
  } finally {
    store.flush();
    reporter.end();
  }
  const order = new Map(opts.tasks.map((task, index) => [task.slug, index]));
  const compare = (a: string, b: string) => (order.get(a) ?? 0) - (order.get(b) ?? 0);
  result.authored.sort(compare);
  result.resumed.sort(compare);
  result.skipped.sort((a, b) => compare(a.slug, b.slug));
  result.unverified.sort(compare);
  result.kept.sort((a, b) => compare(a.slug, b.slug));
  result.failed.sort((a, b) => compare(a.export, b.export));
  return result;
}
