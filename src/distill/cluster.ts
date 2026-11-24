import type { Writable } from "node:stream";
import { nextCommandText } from "../commands/next.js";
import { fingerprint, reusableLineage, stageLineage } from "../core/fingerprint.js";
import type { ResolvedCall, RunnerName } from "../runners/types.js";
import type { SourceName } from "../sources/types.js";
import { glyph } from "../ui/mode.js";
import { counted, nounFor } from "../ui/style.js";
import {
  loadDigests,
  loadTasks,
  newGeneration,
  saveTasks,
  type TasksCheckpoint,
} from "./checkpoints.js";
import { type OperationRecord, OperationStore } from "./operations.js";
import { buildClusterPrompt, buildMergePrompt, CLUSTER_PROMPT_VERSION } from "./prompts/cluster.js";
import type { RetryHandler } from "./retry.js";
import {
  type Cluster,
  type ClusterMerge,
  ClusterMergeSchema,
  ClusterSchema,
  type ClusterTask,
  type Digest,
  toJsonSchema,
} from "./schemas.js";
import type { StageProgressSink } from "./stage-events.js";
import {
  CLUSTER_TIMEOUT_PER_DIGEST_MS,
  executeOperation,
  operationSettings,
  type RunnerFn,
  reusableOperation,
  SLUG_PATTERN,
  stageReporter,
  stageRunner,
} from "./stage-support.js";

export { CLUSTER_TIMEOUT_PER_DIGEST_MS };

/**
 * Canonicalize member ids in a cluster response against the known input ids.
 *
 * Real-model failure mode (observed with sonnet on the first real run): every
 * id returned without its `.md` extension, semantically perfect grouping,
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
 * Validate a clustering against the input ids, fail loudly:
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
 * `--no-group`: synthesize a 1 session = 1 task clustering deterministically,
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
      notes.push(`merge skipped: unknown ${nounFor(missing.length, "slug")} ${missing.join(", ")}`);
      continue;
    }
    if (entry.slugs.length < 2) {
      notes.push(`merge skipped: fewer than two slugs (${entry.slugs.join(", ") || "none"})`);
      continue;
    }
    const doubly = entry.slugs.filter((s) => consumed.has(s));
    if (doubly.length > 0) {
      notes.push(
        `merge skipped: ${nounFor(doubly.length, "slug")} already merged ${doubly.join(", ")}`,
      );
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
  /** Backend per export name (absent entries ⇒ claude), names the corpus in the prompt. */
  origins?: Record<string, SourceName>;
  generation: string;
  noGroup?: boolean;
  model?: string;
  runnerName?: RunnerName;
  identityRunner?: RunnerName | null;
  progress?: StageProgressSink;
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
 * Stage 2, cluster all digests into semantic tasks. One call when the corpus
 * fits the input budget and optional batch size; otherwise one call per window
 * plus one best-effort merge call that unifies cross-window duplicates.
 *
 * Resumable: a tasks.json from the same generation covering the same input set
 * is reused without a call. Semantic validation failures (duplicate slugs,
 * dropped sessions, invented ids) get ONE corrective retry with the problems
 * spelled out; a second failure throws, progress stays checkpointed,
 * the command reports and exits non-zero, re-running resumes.
 */
export async function runClusterStage(opts: ClusterStageOptions): Promise<ClusterStageResult> {
  const reporter = stageReporter(opts, 1);
  try {
    return await groupDigests(opts, reporter);
  } finally {
    reporter.end();
  }
}

async function groupDigests(
  opts: ClusterStageOptions,
  reporter: ReturnType<typeof stageReporter>,
): Promise<ClusterStageResult> {
  const write = reporter.note;
  const settings = operationSettings(opts);
  const windows = opts.noGroup
    ? []
    : planClusterWindows(opts.digests, opts.origins, settings.budget, opts.batchSize);
  const inputIds = Object.keys(opts.digests).sort();
  const sortedDigests = Object.fromEntries(inputIds.map((id) => [id, opts.digests[id] as Digest]));
  const upstream = loadDigests(opts.home)?.lineage;
  const lineageFor = (runnerName: RunnerName | null) =>
    stageLineage({
      stage: "cluster",
      promptVersion: CLUSTER_PROMPT_VERSION,
      schema: {
        cluster: toJsonSchema(ClusterSchema),
        merge: toJsonSchema(ClusterMergeSchema),
      },
      inputs: {
        digests: sortedDigests,
        origins: Object.fromEntries(inputIds.map((id) => [id, opts.origins?.[id] ?? "claude"])),
        upstream: Object.fromEntries(
          inputIds.map((id) => [id, upstream?.[id]?.fingerprint ?? null]),
        ),
        mode: opts.noGroup ? "one-session-per-task" : "grouped",
        windows,
        prompt: buildClusterPrompt(sortedDigests, opts.origins),
        mergePrompt: buildMergePrompt([]),
      },
      model: opts.model,
      runnerName,
    });
  const lineage = lineageFor(settings.automatic ? null : settings.runner);

  // Matching names alone cannot prove freshness: content, grouping mode,
  // instructions, or the selected runner can all have changed.
  const existing = loadTasks(opts.home);
  if (existing && existing.generation === opts.generation) {
    if (
      reusableLineage(existing.lineage, lineage, lineageFor) &&
      validateCluster(existing, inputIds).length === 0
    ) {
      if (existing.operation_ids)
        reconcileGroupingOperations(new OperationStore(opts.home, opts.generation), existing);
      reporter.start(1);
      reporter.item("group", "skipped", "  clustering already done (checkpoint reused)");
      return {
        generation: existing.generation,
        tasks: existing.tasks,
        misc: existing.misc,
        resumed: true,
      };
    }
  }

  const store = new OperationStore(opts.home, opts.generation);
  const runId = newGeneration();
  reporter.start(opts.noGroup ? 1 : windows.length + Number(windows.length > 1));
  if (existing?.generation === opts.generation)
    write("  Grouping the sessions again because they or the settings changed.");
  const operationIds: string[] = [];
  let fallbackMergeId: string | undefined;
  let cluster: Cluster;
  if (opts.noGroup) {
    cluster = synthesizeNoGroupTasks(opts.digests);
    reporter.item(
      "group",
      "done",
      `  --no-group: made ${counted(cluster.tasks.length, "task")}, one per session, without a model call`,
    );
  } else {
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
      const contract = {
        promptVersion: CLUSTER_PROMPT_VERSION,
        schema: toJsonSchema(ClusterSchema),
        prompt: buildClusterPrompt(digests as Record<string, Digest>, opts.origins),
      };
      const operation =
        reusableOperation(store, "cluster-window", unitId, logicalInput, settings, contract) ??
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
            prompt: contract.prompt,
            timeoutUnits: windowIds.length,
          },
        });
      operationIds.push(operation.id);
      return operation;
    });
    if (windows.length === 1) {
      reporter.detail(
        `  grouping ${counted(inputIds.length, "session summary", "session summaries")}${glyph("…", "...")}`,
      );
      cluster = await clusterWindow(
        windows[0] as string[],
        opts,
        reporter,
        "",
        store,
        windowOperations[0] as OperationRecord,
      );
    } else {
      // Cluster each bounded window independently, then unify cross-window
      // duplicates with one merge call over the task identities.
      const limits = [
        ...(opts.batchSize === undefined
          ? []
          : [`up to ${counted(opts.batchSize, "session summary", "session summaries")} per batch`]),
        ...(opts.budget === undefined
          ? []
          : [`size limit per call ${opts.budget.toLocaleString("en-US")} characters`]),
      ];
      reporter.detail(
        `  grouping ${counted(inputIds.length, "session summary", "session summaries")} in ${windows.length} batches ` +
          `(${limits.join("; ")})${glyph("…", "...")}`,
      );
      const combined: ClusterTask[] = [];
      const misc: string[] = [];
      const usedSlugs = new Set<string>();
      for (const [i, windowIds] of windows.entries()) {
        const label = `, batch ${i + 1} of ${windows.length}`;
        const windowCluster = await clusterWindow(
          windowIds,
          opts,
          reporter,
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
        reporter.item("merge", "skipped", "  fewer than two window tasks; no merge needed", false);
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
        const contract = {
          promptVersion: CLUSTER_PROMPT_VERSION,
          schema: toJsonSchema(ClusterMergeSchema),
          prompt: buildMergePrompt(combined),
        };
        const operation =
          reusableOperation(store, "cluster-merge", "merge", logicalInput, settings, contract) ??
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
            request: { prompt: contract.prompt, timeoutUnits: combined.length },
          });
        operationIds.push(operation.id);
        cluster = await mergeWindowTasks(combined, misc, opts, reporter, store, operation);
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

  const resolved = store
    .list()
    .filter((op) => operationIds.includes(op.id))
    .map((op) => op.attempts.at(-1)?.invocations.at(-1)?.resolved)
    .filter((call): call is ResolvedCall => call !== undefined);
  const checkpoint: TasksCheckpoint = {
    generation: opts.generation,
    prompt_version: CLUSTER_PROMPT_VERSION,
    tasks: cluster.tasks,
    misc: cluster.misc,
    lineage,
    ledger_runner: settings.runner,
    ...(resolved.length ? { resolved } : {}),
    operation_ids: operationIds,
    ...(fallbackMergeId ? { fallback_merge_id: fallbackMergeId } : {}),
    grouping_hash: fingerprint({ tasks: cluster.tasks, misc: cluster.misc }),
  };
  store.flush();
  saveTasks(opts.home, checkpoint);
  reconcileGroupingOperations(store, checkpoint);

  reporter.detail(
    `      ${glyph("→", "->")} ${counted(cluster.tasks.length, "group")}` +
      (cluster.misc.length
        ? `; ${counted(cluster.misc.length, "session")} did not fit a group`
        : ""),
  );
  return { generation: opts.generation, tasks: cluster.tasks, misc: cluster.misc, resumed: false };
}

/**
 * Finish publication after the grouping is durable, including an interrupted
 * prior run. One index save: the grouping is already on disk, so a crash here
 * only repeats this idempotent bookkeeping on the next run.
 */
function reconcileGroupingOperations(store: OperationStore, checkpoint: TasksCheckpoint): void {
  store.group(() => reconcileGrouping(store, checkpoint));
}
function reconcileGrouping(store: OperationStore, checkpoint: TasksCheckpoint): void {
  const operationIds = checkpoint.operation_ids ?? [];
  // A completed normal grouping replaces the active task and clustering scope.
  for (const previous of store.list()) {
    if (previous.state === "superseded") continue;
    if (previous.kind.startsWith("cluster-") && !operationIds.includes(previous.id)) {
      store.setState(previous.id, "superseded");
    } else if (previous.kind === "author") {
      const oldTask = (store.loadInput(previous.id).logicalInput as { task: ClusterTask }).task;
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

class InvalidMerge extends Error {
  constructor(
    readonly result: ClusterMerge,
    readonly notes: string[],
  ) {
    super(`Invalid merge: ${notes.join("; ")}`);
  }
}

export function clusterHandlers(home: string) {
  const reflect = nextCommandText("reflect", { home });
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
            `The summary of ${id} changed since grouping failed; run ${reflect} without --retry-failed to prepare it again`,
          );
      }
    },
    prepare(input, settings) {
      if (input.request.prompt.length > settings.budget)
        throw new Error(
          `This grouping batch is over the size limit per call of ${settings.budget.toLocaleString("en-US")} characters, and its sessions are fixed; run ${reflect} without --retry-failed to group again`,
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
          throw new Error(`grouping failed its checks after one more try: ${problems.join("; ")}`);
        prompt = `${request.prompt}\n\nYour previous grouping had these problems:\n${problems.map((problem) => `- ${problem}`).join("\n")}\nProduce a corrected grouping that fixes every problem. Remember: every id in at least one task or misc, unique 2-5-word kebab-case slugs, only the listed ids.`;
      }
      throw new Error("Grouping failed its checks");
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
      if (notes.length) throw new InvalidMerge(result, notes);
    },
    async run(request, settings, _input, invoke) {
      return ClusterMergeSchema.parse(
        await invoke({
          prompt: request.prompt,
          schema: ClusterMergeSchema,
          model: settings.model ?? undefined,
          timeoutMs: settings.timeoutMs,
        }),
      );
    },
    publish: window.publish,
  };
  return { "cluster-window": window, "cluster-merge": merge };
}

type ClusterReporter = ReturnType<typeof stageReporter>;
async function callGroupingOperation(
  opts: ClusterStageOptions,
  reporter: ClusterReporter,
  store: OperationStore,
  operation: OperationRecord,
  label: string,
) {
  const input = store.loadInput(operation.id);
  const kind = operation.kind as "cluster-window" | "cluster-merge";
  const handler = clusterHandlers(opts.home)[kind];
  const settings = operationSettings(opts, Number(input.request.timeoutUnits ?? 0));
  const saved = store.readResult(operation.id);
  let request = input.request;
  if (!saved) {
    const size = request.prompt.length;
    if (size > settings.budget) {
      // Recorded before any spend; the fixed partition cannot shrink this call.
      const what = kind === "cluster-window" ? "cluster" : "merge";
      store.block(operation.id, `${what} prompt ${size} exceeds budget ${settings.budget}`);
      throw new Error(
        kind === "cluster-window"
          ? `cluster prompt exceeds the input budget (${settings.budget}); increase --input-budget`
          : `merge prompt exceeds the input budget (${settings.budget})`,
      );
    }
    request = handler.prepare(input, settings, operation);
  }
  if (!saved) reporter.running(operation.unitId, label);
  const result = await reporter.until(label, () =>
    executeOperation({
      store,
      operation,
      handler,
      settings,
      request,
      run: stageRunner(opts.runner),
      publish: false,
    }),
  );
  reporter.item(
    operation.unitId,
    saved ? "skipped" : "done",
    `  ${label}${saved ? " (saved result reused)" : " (done)"}`,
    false,
  );
  return result;
}

async function clusterWindow(
  ids: string[],
  opts: ClusterStageOptions,
  reporter: ClusterReporter,
  suffix: string,
  store: OperationStore,
  operation: OperationRecord,
): Promise<Cluster> {
  try {
    const value = await callGroupingOperation(
      opts,
      reporter,
      store,
      operation,
      `grouping ${counted(ids.length, "session summary", "session summaries")}${suffix}`,
    );
    return value as Cluster;
  } catch (error) {
    reporter.item(
      operation.unitId,
      "failed",
      `  ${operation.unitId} failed: ${(error as Error).message}`,
    );
    throw error;
  }
}

/** Keep the validated window union when merging fails. Individually valid merge entries can still be applied. */
async function mergeWindowTasks(
  combined: ClusterTask[],
  misc: string[],
  opts: ClusterStageOptions,
  reporter: ClusterReporter,
  store: OperationStore,
  operation: OperationRecord,
): Promise<Cluster> {
  let merge: ClusterMerge;
  try {
    merge = (await callGroupingOperation(
      opts,
      reporter,
      store,
      operation,
      `merging ${counted(combined.length, "group")} from the batches into one grouping`,
    )) as ClusterMerge;
  } catch (error) {
    if (error instanceof InvalidMerge) {
      merge = error.result;
      reporter.item(operation.unitId, "failed", `      ${error.notes.join("; ")}`);
    } else {
      reporter.item(
        operation.unitId,
        "failed",
        `      merge call failed (${error instanceof Error ? error.message : String(error)}); keeping the per-window tasks unmerged.`,
      );
      return { tasks: combined, misc: [...new Set(misc)] };
    }
  }
  const { tasks, notes } = applyClusterMerges(combined, merge.merges);
  if (merge.merges.length > notes.length)
    reporter.detail(
      `      merged ${counted(combined.length, "group")} from the batches ${glyph("→", "->")} ${counted(tasks.length, "group")}`,
    );
  return { tasks, misc: [...new Set(misc)] };
}
