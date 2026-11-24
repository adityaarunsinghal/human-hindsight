import type { Writable } from "node:stream";
import { DEFAULT_CONCURRENCY } from "../core/budget.js";
import { fingerprint } from "../core/fingerprint.js";
import {
  assignLessonIds,
  type CurrentPreferences,
  currentGeneralizeInputs,
  type GeneralizedArtifact,
  GeneralizedArtifactSchema,
  type GeneralizedWindow,
  generalizedInputsHash,
  loadGeneralizedArtifact,
  referencedProjects,
  writeGeneralized,
} from "../core/generalized.js";
import { isPlanLabel } from "../core/model-plan.js";
import { generalizeProblems } from "../core/subagent-checks.js";
import type { Lesson, SetAside, SuggestionInput } from "../core/subagents.js";
import { mapConcurrent, runChecked } from "../core/subagents-call.js";
import { wholeNumber, wholeOption } from "../core/value-rule.js";
import { DEFAULT_TIMEOUT_MS } from "../runners/shared.js";
import type { ResolvedCall, RunnerName } from "../runners/types.js";
import { counted } from "../ui/style.js";
import { aliasesFor, realGeneralize, withAliases } from "./aliases.js";
import {
  clearGeneralizeCheckpoints,
  readGeneralizeCheckpoints,
  saveGeneralizeCheckpoint,
} from "./generalize-checkpoints.js";
import type { RunnerFn } from "./pipeline.js";
import {
  buildGeneralizePrompt,
  GENERALIZE_PROMPT_VERSION,
  type GeneralizeOutput,
  GeneralizeSchema,
  renderGeneralizeInput,
} from "./prompts/generalize.js";
import type { StageProgressSink } from "./stage-events.js";

export { assignLessonIds, libraryProjects } from "../core/generalized.js";
export {
  clearGeneralizeCheckpoints,
  GENERALIZE_CHECKPOINT_FILE,
  GENERALIZE_CHECKPOINT_VERSION,
  readGeneralizeCheckpoints,
  saveGeneralizeCheckpoint,
} from "./generalize-checkpoints.js";

/** Bound both prompt size and the number of source ids a response must reproduce. */
export const DEFAULT_WINDOW_SIZE = 20;
export const SUGGEST_TIMEOUT_PER_ITEM_MS = 5_000;

export const WINDOW_SIZE_RULE = wholeNumber(1, "a whole number of preferences, 1 or more");

/** Resolve `--window-size`, the default when absent. A wrong value throws its one line. */
export function resolveWindowSize(raw: string | undefined): number {
  return wholeOption(WINDOW_SIZE_RULE, "window-size", raw, DEFAULT_WINDOW_SIZE);
}

/** Keep an oversized input intact in its own window. */
export function planWindows<T>(
  items: T[],
  size: (item: T) => number,
  budget: number,
  maxItems = Number.POSITIVE_INFINITY,
): T[][] {
  const windows: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const item of items) {
    const cost = size(item) + 1;
    if (current.length > 0 && (used + cost > budget || current.length >= maxItems)) {
      windows.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += cost;
  }
  if (current.length) windows.push(current);
  return windows;
}

/** Titles are display text. Keep the instruction and its sources intact. */
export function trimTitle(title: string, max = 80): string {
  if (title.length <= max) return title;
  const cut = title.slice(0, max);
  const atWord = cut.lastIndexOf(" ");
  return (atWord >= Math.floor(max / 2) ? cut.slice(0, atWord) : cut).replace(/[\s,;:.-]+$/, "");
}

export function repairGeneralize(output: GeneralizeOutput): {
  value: GeneralizeOutput;
  notes: string[];
} {
  const notes: string[] = [];
  const lessons: GeneralizeOutput["lessons"] = [];
  for (const [index, lesson] of output.lessons.entries()) {
    if (!Array.isArray(lesson.source_ids) || !lesson.source_ids.length) {
      notes.push(
        `lesson ${index + 1} ${JSON.stringify(trimTitle(lesson.title, 50))}: dropped, no source ids`,
      );
      continue;
    }
    const title = trimTitle(lesson.title);
    if (title !== lesson.title) {
      notes.push(
        `lesson ${index + 1}: title trimmed from ${lesson.title.length} to ${title.length} characters`,
      );
    }
    lessons.push(title === lesson.title ? lesson : { ...lesson, title });
  }
  return { value: { ...output, lessons }, notes };
}

/**
 * The identity of one window: prompt template and version, every input as the
 * model sees it (wording edits, scope, evidence), the model and the runner.
 * `projects` is the list the window's inputs refer to, not the whole library's.
 * The call itself names every library project, and a saved result is checked
 * against the current full list again before it is reused, so a project added
 * elsewhere neither forces a new call nor lets a leaked name through.
 */
export function generalizeWindowKey(
  window: readonly SuggestionInput[],
  model: string | undefined,
  projects: readonly string[] = [],
  identityRunner: RunnerName | null = null,
): string {
  return fingerprint({
    stage: "generalize",
    prompt_version: GENERALIZE_PROMPT_VERSION,
    prompt: buildGeneralizePrompt([...window], [...projects]),
    model: model ?? null,
    runner: identityRunner,
  });
}

interface SavedWindow {
  source: "checkpoint" | "artifact";
  window: GeneralizedWindow;
}

export interface GeneralizePlan {
  inputs: SuggestionInput[];
  selection: GeneralizedArtifact["selection"];
  projects: string[];
  windows: SuggestionInput[][];
  keys: string[];
  reusable: number;
  reusableKeys: string[];
  inputChars: number;
  model?: string;
  identityRunner: RunnerName | null;
  saved: Record<string, SavedWindow>;
  /** The projects the inputs refer to; part of the saved set's inputs hash. */
  referencedProjects: string[];
  /** Set when the saved set could not be read; this run replaces it. */
  damaged?: string;
}

/** A preview may read the library and checkpoints. Writes and calls begin only in the stage. */
export function planGeneralize(opts: {
  home: string;
  budget: number;
  model?: string;
  identityRunner?: RunnerName | null;
  selection?: "all-candidates" | "auto";
  windowSize?: number;
  fresh?: boolean;
  current?: CurrentPreferences;
}): GeneralizePlan | null {
  const {
    inputs,
    selection,
    projects,
    inputProjects: byInput,
  } = currentGeneralizeInputs(opts.home, opts.selection ?? "all-candidates", opts.current);
  if (!inputs.length) return null;
  const ordered = [...inputs].sort(
    (a, b) =>
      (a.domain ?? "").localeCompare(b.domain ?? "") ||
      a.text.localeCompare(b.text) ||
      a.id.localeCompare(b.id),
  );
  const windows = planWindows(
    ordered,
    (input) => renderGeneralizeInput(input).length,
    opts.budget,
    opts.windowSize ?? DEFAULT_WINDOW_SIZE,
  );
  const identityRunner = opts.identityRunner ?? null;
  const keys: string[] = [];
  const saved: Record<string, SavedWindow> = {};
  let inputChars = 0;
  // A damaged saved set is reported in the plan and replaced by this run.
  const savedSet = loadGeneralizedArtifact(opts.home);
  const artifact = !opts.fresh && savedSet.state === "ok" ? savedSet.artifact : null;
  const checkpoints: ReturnType<typeof readGeneralizeCheckpoints> = opts.fresh
    ? {}
    : readGeneralizeCheckpoints(opts.home);
  for (const window of windows) {
    const key = generalizeWindowKey(
      window,
      opts.model,
      referencedProjects(window, byInput),
      identityRunner,
    );
    keys.push(key);
    const checkpoint = checkpoints[key];
    const prior = artifact?.windows[key];
    if (checkpoint && !generalizeProblems(checkpoint.result, window, projects).length) {
      saved[key] = {
        source: "checkpoint",
        window: {
          input_ids: window.map((input) => input.id),
          result: checkpoint.result,
          resolved: checkpoint.resolved,
        },
      };
    } else if (prior && !generalizeProblems(prior.result, window, projects).length) {
      saved[key] = { source: "artifact", window: prior };
    } else {
      inputChars += buildGeneralizePrompt(window, projects).length;
    }
  }
  const reusableKeys = Object.keys(saved);
  return {
    inputs,
    selection,
    projects,
    windows,
    keys,
    reusable: reusableKeys.length,
    reusableKeys,
    inputChars,
    model: opts.model,
    identityRunner,
    saved,
    referencedProjects: referencedProjects(inputs, byInput),
    ...(savedSet.state === "damaged" ? { damaged: savedSet.reason } : {}),
  };
}

/**
 * The concrete model for the artifact's `model` field: the one model every
 * answering call reported, else an explicit model name the run was given.
 * A plan label is never a model name; mixed models record null and `resolved`
 * lists each.
 */
function concreteModel(resolved: readonly ResolvedCall[], requested: string | undefined) {
  const models = new Set(resolved.map((call) => call.model ?? null));
  if (models.size === 1) {
    const [only] = models;
    if (only) return only;
  }
  if (models.size === 0 && requested && !isPlanLabel(requested)) return requested;
  return null;
}

interface WindowFailure {
  window?: number;
  error: string;
  problems: string[];
  raw: unknown;
}
export interface GeneralizeResult {
  status: "done" | "partial" | "failed";
  lessons: number;
  reused: number;
  errors: string[];
  lessonList: Lesson[];
  setAside: SetAside[];
  completedWindows: number;
  artifact?: GeneralizedArtifact;
  failure?: WindowFailure;
}

interface GeneralizeStageOptions {
  home: string;
  plan: GeneralizePlan;
  runner: RunnerFn;
  model?: string;
  concurrency?: number;
  timeoutMs?: number;
  output?: Writable;
  progress?: StageProgressSink;
  now?: () => Date;
}

type WindowOutcome =
  | {
      kind: "success";
      key: string;
      window: GeneralizedWindow;
      source: "call" | SavedWindow["source"];
    }
  | { kind: "failed"; failure: WindowFailure }
  | { kind: "blocked" };

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Stop scheduling new calls after a failure. Join in-flight calls and checkpoint their results. */
async function processWindows(opts: GeneralizeStageOptions): Promise<WindowOutcome[]> {
  const { plan, progress } = opts;
  const output = opts.output ?? process.stdout;
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY) || 1);
  const now = opts.now ?? (() => new Date());
  const item = (id: string, status: "done" | "skipped" | "failed" | "blocked", line: string) =>
    progress ? progress.item({ id, status, line }) : output.write(`  ${line}\n`);

  let stopped = false;
  async function runWindow(window: SuggestionInput[], index: number): Promise<WindowOutcome> {
    const key = plan.keys[index];
    if (!key) throw new Error(`Missing identity for preference batch ${index + 1}.`);
    const label = `batch ${index + 1} of ${plan.windows.length}`;
    const counts = (value: GeneralizeOutput) =>
      `${counted(value.lessons.length, "preference")}${value.set_aside.length ? `, ${value.set_aside.length} left out (no reusable instruction)` : ""}`;
    const cached = plan.saved[key];
    if (cached) {
      const why =
        cached.source === "checkpoint"
          ? "resumed from checkpoint"
          : "reused saved preference summaries";
      item(key, "skipped", `${label}: ${counts(cached.window.result)} (${why})`);
      return { kind: "success", key, window: cached.window, source: cached.source };
    }
    if (stopped) {
      item(key, "blocked", `${label}: waiting for a retry`);
      return { kind: "blocked" };
    }
    // The call shows short aliases for the 64-character input ids; checks run
    // on the answer as written, and the saved result has the real ids.
    const aliases = aliasesFor(
      window.map((input) => input.id),
      "p",
    );
    const shown = withAliases(window, aliases);
    try {
      progress?.running?.(key, `summarizing preferences, ${label}`);
      const checked = await runChecked({
        runner: opts.runner,
        out: output,
        spinner:
          !progress && concurrency === 1
            ? `summarizing ${counted(window.length, "preference")}, ${label}`
            : undefined,
        prompt: buildGeneralizePrompt(shown, plan.projects),
        schema: GeneralizeSchema,
        model: plan.model,
        timeoutMs:
          opts.timeoutMs ?? DEFAULT_TIMEOUT_MS + SUGGEST_TIMEOUT_PER_ITEM_MS * window.length,
        repair: repairGeneralize,
        check: (value) => generalizeProblems(value, shown, plan.projects),
      });
      if (!checked.ok) {
        stopped = true;
        item(key, "failed", `${label}: ${checked.error}`);
        return {
          kind: "failed",
          failure: {
            window: index + 1,
            error: checked.error,
            problems: checked.problems,
            raw: checked.raw,
          },
        };
      }
      const resolved = checked.resolved;
      const result = realGeneralize(checked.value, aliases);
      saveGeneralizeCheckpoint(opts.home, key, {
        window: index + 1,
        inputs: window.length,
        saved_at: now().toISOString(),
        result,
        resolved,
      });
      // Corrections and local repairs are not printed: only the outcome is.
      item(key, "done", `${label}: ${counts(result)}`);
      return {
        kind: "success",
        key,
        source: "call",
        window: { input_ids: window.map((input) => input.id), result, resolved },
      };
    } catch (error) {
      stopped = true;
      const message = errorMessage(error);
      item(key, "failed", `${label}: ${message}`);
      return {
        kind: "failed",
        failure: { window: index + 1, error: message, problems: [message], raw: null },
      };
    }
  }
  progress?.start(plan.windows.length, concurrency);
  return mapConcurrent(plan.windows, concurrency, runWindow);
}

function buildArtifact(
  opts: GeneralizeStageOptions,
  resolved: ResolvedCall[],
  windows: Record<string, GeneralizedWindow>,
  result: GeneralizeResult,
  incomplete?: GeneralizedArtifact["incomplete"],
): GeneralizedArtifact {
  const { plan } = opts;
  return {
    version: 1,
    generated_at: (opts.now?.() ?? new Date()).toISOString(),
    prompt_version: GENERALIZE_PROMPT_VERSION,
    inputs_hash: generalizedInputsHash(plan.inputs, plan.referencedProjects),
    selection: plan.selection,
    model: concreteModel(resolved, plan.model),
    ...(isPlanLabel(plan.model) ? { model_plan: plan.model } : {}),
    ...(resolved.length ? { resolved } : {}),
    windows,
    lessons: result.lessonList,
    set_aside: result.setAside,
    ...(incomplete ? { incomplete } : {}),
  };
}

/**
 * A failed window never fails the library. The finished windows are saved as
 * an incomplete set (`incomplete`), unless a complete set is already saved,
 * which stays available until a run finishes every window.
 */
export async function runGeneralizeStage(opts: GeneralizeStageOptions): Promise<GeneralizeResult> {
  const { plan, progress } = opts;
  const result: GeneralizeResult = {
    status: "failed",
    lessons: 0,
    reused: 0,
    errors: [],
    lessonList: [],
    setAside: [],
    completedWindows: 0,
  };
  try {
    if (opts.model !== undefined && opts.model !== plan.model)
      throw new Error("The model choice changed. Prepare a new plan to summarize preferences.");
    const outcomes = await processWindows(opts);
    const windows: Record<string, GeneralizedWindow> = {};
    const producers = new Map<string, ResolvedCall>();
    let checkpointCount = 0;
    let blocked = 0;
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.kind === "blocked") {
        blocked++;
      } else if (outcome.kind === "failed") {
        result.failure ??= outcome.failure;
        result.errors.push(`Batch ${index + 1}: ${outcome.failure.error}`);
      } else {
        windows[outcome.key] = outcome.window;
        if (outcome.window.resolved) {
          const call = outcome.window.resolved;
          producers.set(JSON.stringify([call.runner, call.model ?? null]), call);
        }
        if (outcome.source !== "call") result.reused++;
        if (outcome.source === "checkpoint") checkpointCount++;
        result.completedWindows++;
      }
    }
    if (checkpointCount)
      progress?.detail?.(
        `  ${counted(checkpointCount, "batch", "batches")} reused from saved work.`,
      );
    const ordered = Object.values(windows);
    result.lessonList = assignLessonIds(ordered.flatMap(({ result: window }) => window.lessons));
    result.lessons = result.lessonList.length;
    result.setAside = ordered.flatMap(({ result: window }) => window.set_aside);
    const resolved = [...producers.values()];
    const saved = loadGeneralizedArtifact(opts.home);
    const previous = saved.state === "ok" ? saved.artifact : null;
    // A narrower proposal may consume the full library. Keep its own new windows
    // in the checkpoint so it can also resume without replacing the library view.
    // A damaged saved set has no view worth keeping and is replaced.
    const keepWiderSet = plan.selection === "accepted" && previous?.selection === "all-candidates";
    if (result.failure) {
      if (blocked)
        result.errors.push(
          `${counted(blocked, "batch", "batches")} ${blocked === 1 ? "was" : "were"} not started after the failure.`,
        );
      result.status = result.completedWindows ? "partial" : "failed";
      // The finished windows are still worth showing: save them as an
      // incomplete set, unless that would replace a complete one (which stays
      // until a run finishes every window). Their checkpoints stay for reuse.
      if (result.completedWindows && !keepWiderSet && (!previous || previous.incomplete)) {
        const covered = Object.values(windows).reduce((sum, w) => sum + w.input_ids.length, 0);
        const partial = buildArtifact(opts, resolved, windows, result, {
          windows_failed: plan.windows.length - result.completedWindows,
          candidates_not_covered: plan.inputs.length - covered,
        });
        writeGeneralized(opts.home, partial);
        result.artifact = partial;
      }
      return result;
    }
    const artifact = buildArtifact(opts, resolved, windows, result);
    const priorWindows = previous?.windows ?? {};
    const unchanged =
      previous &&
      !previous.incomplete &&
      previous.selection === artifact.selection &&
      previous.inputs_hash === artifact.inputs_hash &&
      previous.model === artifact.model &&
      previous.model_plan === artifact.model_plan &&
      previous.prompt_version === artifact.prompt_version &&
      plan.keys.length === Object.keys(priorWindows).length &&
      plan.keys.every(
        (key) => plan.saved[key]?.source === "artifact" && Object.hasOwn(priorWindows, key),
      );
    if (previous && unchanged) {
      result.artifact = previous;
      result.lessonList = previous.lessons;
      result.lessons = previous.lessons.length;
      result.setAside = previous.set_aside;
    } else {
      if (keepWiderSet) {
        result.artifact = GeneralizedArtifactSchema.parse(artifact);
      } else {
        writeGeneralized(opts.home, artifact);
        result.artifact = artifact;
      }
    }
    if (!keepWiderSet) clearGeneralizeCheckpoints(opts.home, plan.keys);
    result.status = "done";
    return result;
  } catch (error) {
    const message = errorMessage(error);
    result.failure ??= { error: message, problems: [message], raw: null };
    result.errors.push(message);
    result.status = result.completedWindows ? "partial" : "failed";
    return result;
  } finally {
    try {
      progress?.end();
    } catch (error) {
      result.errors.push(
        `Could not close the preference summary progress display: ${errorMessage(error)}`,
      );
    }
  }
}
