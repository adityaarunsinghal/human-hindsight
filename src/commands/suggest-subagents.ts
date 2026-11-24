import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { defineCommand } from "citty";
import { DEFAULT_CONCURRENCY, resolveInputBudget, resolveTimeoutMs } from "../core/budget.js";
import { fingerprint } from "../core/fingerprint.js";
import { atomicWriteFilePrivate } from "../core/fsutil.js";
import { parseQuality, type Quality } from "../core/model-plan.js";
import { PREFERENCE_REVIEW_FILE, readPreferenceReviews } from "../core/preference-review.js";
import { readObservedPreferences } from "../core/preferences.js";
import { openRunSession, type RunSession, type StageKey } from "../core/run-session.js";
import { authorProblems, proposeProblems } from "../core/subagent-checks.js";
import {
  clearAuthorProgress,
  computeCoverage,
  hasAuthorProgress,
  isSuggestionStale,
  type Lesson,
  MAX_ROLES,
  MIN_ROLES,
  pendingAuthorProposal,
  readSuggestion,
  SUBAGENTS_DIR,
  SUGGESTION_FAILURE_FILE,
  SUGGESTION_PARTIAL_FILE,
  SUGGESTION_VERSION,
  type SuggestionArtifact,
  SuggestionReadError,
  type SuggestionResultSource,
  saveAuthorProgress,
  savedSuggestionKey,
  selectSuggestionInputs,
  suggestionFingerprint,
  suggestionPath,
  writeSuggestion,
} from "../core/subagents.js";
import { type CheckedResult, mapConcurrent, runChecked } from "../core/subagents-call.js";
import { harnessRootWarning, writeSubagentTree } from "../core/subagents-export.js";
import {
  renderSubagentTree,
  SUBAGENT_TARGETS,
  type SubagentTarget,
} from "../core/subagents-render.js";
import { wholeNumber, wholeOption } from "../core/value-rule.js";
import { aliasesFor, realProposal, withAliases } from "../distill/aliases.js";
import {
  type ConsentOptions,
  type ConsentResult,
  confirmPlan,
  type DistillPlan,
  type SubagentsChoice,
  type SubagentsPlan,
  screenWidth,
} from "../distill/consent.js";
import {
  DEFAULT_WINDOW_SIZE,
  type GeneralizePlan,
  planGeneralize,
  planWindows,
  resolveWindowSize,
  runGeneralizeStage,
  SUGGEST_TIMEOUT_PER_ITEM_MS,
} from "../distill/generalize.js";
import { acquireWriterLock, WriterBusyError } from "../distill/operations.js";
import type { RunnerFn } from "../distill/pipeline.js";
import {
  AUTHOR_ROLE_PROMPT_VERSION,
  type AuthorRoleOutput,
  AuthorRoleSchema,
  buildAuthorRolePrompt,
} from "../distill/prompts/author-role.js";
import { buildGeneralizePrompt, GENERALIZE_PROMPT_VERSION } from "../distill/prompts/generalize.js";
import {
  buildProposeMergePrompt,
  buildProposePrompt,
  PROPOSE_PROMPT_VERSION,
  type ProposeOutput,
  ProposeSchema,
  type RoleBounds,
  renderLessonCard,
} from "../distill/prompts/propose.js";
import { guardRun, mutableOutput, pinSourcesFrom } from "../distill/run-guard.js";
import { startStageProgress } from "../distill/stage-events.js";
import { DEFAULT_TIMEOUT_MS } from "../runners/shared.js";
import type { AgentRunner, RunnerName } from "../runners/types.js";
import type { TerminalHost } from "../ui/live.js";
import { canPrompt, glyph } from "../ui/mode.js";
import { withSpinner } from "../ui/progress.js";
import { chooseMenuAnswer, readLine } from "../ui/prompt.js";
import { banner, counted, dim, fail, green, hint, yellow } from "../ui/style.js";
import { wrapText } from "../ui/wrap.js";
import { parseConcurrency, resolvePaths, sharedArgs } from "./_shared.js";
import { type NextCommand, nextCommandText, runNextCommand } from "./next.js";

export { SUGGESTION_FAILURE_FILE, SUGGESTION_PARTIAL_FILE } from "../core/subagents.js";
export {
  assignLessonIds,
  clearGeneralizeCheckpoints,
  DEFAULT_WINDOW_SIZE,
  GENERALIZE_CHECKPOINT_FILE,
  GENERALIZE_CHECKPOINT_VERSION,
  generalizeWindowKey,
  libraryProjects,
  planWindows,
  readGeneralizeCheckpoints,
  repairGeneralize,
  resolveWindowSize,
  SUGGEST_TIMEOUT_PER_ITEM_MS,
  saveGeneralizeCheckpoint,
  trimTitle,
} from "../distill/generalize.js";

export const SUBAGENT_MODEL_ENV = "HUMAN_HINDSIGHT_SUBAGENT_MODEL";

/** Normalized args the command core reads. */
export interface SuggestSubagentsArgs {
  home?: string;
  "claude-dir"?: string;
  "codex-dir"?: string;
  "kiro-dir"?: string;
  "kirocrew-dir"?: string;
  runner?: string;
  model?: string;
  quality?: string;
  concurrency?: string;
  "cluster-model"?: string;
  "propose-model"?: string;
  "author-model"?: string;
  "include-unreviewed"?: boolean;
  "min-roles"?: string;
  "max-roles"?: string;
  "input-budget"?: string;
  "window-size"?: string;
  "fresh-generalize"?: boolean;
  "author-only"?: boolean;
  timeout?: string;
  "dry-run"?: boolean;
  yes?: boolean;
  export?: string;
  target?: string;
  force?: boolean;
  "pin-model"?: string;
  "follow-up"?: boolean;
  /** Show which items are running and the per-item detail. */
  verbose?: boolean;
}

/** Injectable dependencies (testing). */
export interface SuggestSubagentsDeps {
  /** Stage runner; bypasses runner resolution. */
  runner?: RunnerFn;
  /** Runner name recorded in the artifact when `runner` is injected (default claude). */
  runnerName?: RunnerName;
  /** Ready-made CLIs in priority order, used instead of looking for installed ones. */
  runners?: AgentRunner[];
  confirm?: (plan: DistillPlan, opts: ConsentOptions) => Promise<ConsentResult | "interrupted">;
  /** Silences the command's output once Ctrl-C has printed its line (set by the command). */
  mute?(): void;
  /** Runs a command the closing menu offers (default: the real command). */
  runNext?: (command: NextCommand, args: object) => Promise<number>;
  input?: Readable;
  output?: Writable;
  now?: () => Date;
  /** Home directory for the harness-root warning (default the OS home). */
  userHome?: string;
  /** Where Ctrl-C arrives and how the process ends (tests). */
  host?: TerminalHost;
  exit?(code: number): void;
}

const GENERATE_ONLY = [
  "model",
  "propose-model",
  "concurrency",
  "author-model",
  "include-unreviewed",
  "min-roles",
  "max-roles",
  "input-budget",
  "window-size",
  "fresh-generalize",
  "author-only",
  "timeout",
  "dry-run",
] as const;
const EXPORT_ONLY = ["target", "force", "pin-model"] as const;

function given(value: unknown): boolean {
  return value !== undefined && value !== false;
}

export const ROLE_COUNT_RULE = wholeNumber(
  MIN_ROLES,
  `a whole number from ${MIN_ROLES} to ${MAX_ROLES}`,
  MAX_ROLES,
);

function parseRoleCount(raw: string | undefined, flag: string, fallback: number): number {
  return wholeOption(ROLE_COUNT_RULE, flag.replace(/^--/, ""), raw, fallback);
}

/**
 * Every number the generating paths read, checked before anything is read or
 * asked. A wrong value throws its one line; none is read as the default.
 */
function checkNumbers(args: SuggestSubagentsArgs): void {
  parseRoleBounds(args);
  resolveWindowSize(args["window-size"]);
  resolveInputBudget(args["input-budget"]);
  resolveTimeoutMs(args.timeout);
  parseConcurrency(args.concurrency);
}

/** Resolve `--min-roles` and `--max-roles` (defaults 2 and 15); throws on a bad value. */
export function parseRoleBounds(args: SuggestSubagentsArgs): RoleBounds {
  const minRoles = parseRoleCount(args["min-roles"], "--min-roles", MIN_ROLES);
  const maxRoles = parseRoleCount(args["max-roles"], "--max-roles", MAX_ROLES);
  if (minRoles > maxRoles)
    throw new Error(`--min-roles (${minRoles}) is larger than --max-roles (${maxRoles})`);
  return { minRoles, maxRoles };
}

/**
 * Models per stage. `--model` (or the workflow default in
 * `HUMAN_HINDSIGHT_SUBAGENT_MODEL`) selects generalize; propose and author use
 * their own flags and otherwise follow it. Unset means the runner's default.
 */
export function resolveModels(args: SuggestSubagentsArgs): {
  generalize?: string;
  propose?: string;
  author?: string;
} {
  const generalize = args.model || process.env[SUBAGENT_MODEL_ENV] || undefined;
  return {
    generalize,
    propose: args["propose-model"] || generalize,
    author: args["author-model"] || generalize,
  };
}

const number = (n: number) => n.toLocaleString("en-US");

/** The saved-artifact cap on a role prompt (`RoleSchema`). */
const PROMPT_MAX = 6000;

/**
 * Cut an over-long role prompt to the cap at the last paragraph break before
 * it, or the last line break, or the last space, in that order. The prompt's
 * sections run ownership, boundary, method, handoff; a cut lands in the tail,
 * never in the opening sections. Returns the input when it already fits.
 */
export function trimPrompt(prompt: string): string {
  if (prompt.length <= PROMPT_MAX) return prompt;
  const head = prompt.slice(0, PROMPT_MAX);
  const floor = Math.floor(PROMPT_MAX * 0.7);
  for (const breaker of ["\n\n", "\n", " "]) {
    const at = head.lastIndexOf(breaker);
    if (at >= floor) return head.slice(0, at).trimEnd();
  }
  return head.trimEnd();
}

/**
 * The author stage's local repair: an over-long prompt is cut to the cap and
 * noted. On the first real library run opus wrote 5 of 13 prompts between
 * 6,003 and 7,469 characters, twice each, and those roles were kept with no
 * prompt at all; a prompt cut at a paragraph break is worth far more than none.
 * The author prompt also now asks for about 4,000 characters, so this is a
 * backstop. Triggers are not repaired: a bad trigger list is a real defect.
 */
export function repairAuthor(output: AuthorRoleOutput): {
  value: AuthorRoleOutput;
  notes: string[];
} {
  if (output.prompt.length <= PROMPT_MAX) return { value: output, notes: [] };
  const prompt = trimPrompt(output.prompt);
  return {
    value: { ...output, prompt },
    notes: [`prompt cut from ${output.prompt.length} to ${prompt.length} characters at a break`],
  };
}

/** The playbook that receives generalized lessons the proposer left unplaced. */
export const UNPLACED_PLAYBOOK = "unplaced-lessons";

/**
 * The propose stage's local repair for a FINAL proposal (the single call, or
 * the merge): a generalized lesson that is in no role, in `shared` and in no
 * playbook is filed into the `unplaced-lessons` playbook and noted. Rule P4
 * exists so that no portable lesson is silently lost; filing it where the
 * person can see it in the exported tree keeps that intent without stopping
 * the run. On the first real library run opus placed 266 of 267 generalized
 * lessons and the one it skipped had five near-duplicate siblings from other
 * generalize windows (a documented limitation: windows are not merged with
 * each other); the whole run stopped for it, twice. Per-window proposals are
 * not repaired this way, since a window may rightly leave lessons to others.
 */
export function repairProposal(
  output: ProposeOutput,
  lessons: readonly Lesson[],
): { value: ProposeOutput; notes: string[] } {
  const placed = new Set<string>(output.shared);
  for (const role of output.roles) for (const id of role.lesson_ids) placed.add(id);
  for (const playbook of output.playbooks) for (const id of playbook.lesson_ids) placed.add(id);
  const unplaced = lessons
    .filter((lesson) => lesson.disposition === "generalized" && !placed.has(lesson.id))
    .map((lesson) => lesson.id);
  if (unplaced.length === 0) return { value: output, notes: [] };
  const existing = output.playbooks.find((playbook) => playbook.name === UNPLACED_PLAYBOOK);
  const playbooks = existing
    ? output.playbooks.map((playbook) =>
        playbook === existing
          ? { ...playbook, lesson_ids: [...new Set([...playbook.lesson_ids, ...unplaced])] }
          : playbook,
      )
    : [
        ...output.playbooks,
        {
          name: UNPLACED_PLAYBOOK,
          purpose:
            "Portable lessons the proposer left out of every role. Read them and file each one where it belongs, or drop it.",
          lesson_ids: unplaced,
        },
      ];
  return {
    value: { ...output, playbooks },
    notes: unplaced.map(
      (id) => `lesson ${JSON.stringify(id)}: unplaced, filed in the ${UNPLACED_PLAYBOOK} playbook`,
    ),
  };
}

/**
 * Write the free-form record of a stopped run. It goes to
 * `suggestion.partial.json`, unless that file holds an interrupted role
 * proposal: then the proposal stays and the record goes beside it, in
 * `suggestion.failure.json`. Returns the path and whether a proposal was kept.
 */
function writePartial(
  home: string,
  record: Record<string, unknown>,
  now: Date,
): { file: string; keptProposal: boolean } {
  const keptProposal = hasAuthorProgress(home);
  const file = path.join(
    home,
    "library",
    SUBAGENTS_DIR,
    keptProposal ? SUGGESTION_FAILURE_FILE : SUGGESTION_PARTIAL_FILE,
  );
  atomicWriteFilePrivate(
    file,
    `${JSON.stringify({ written_at: now.toISOString(), ...record }, null, 2)}\n`,
  );
  return { file, keptProposal };
}

/** The suggest-subagents command core; returns the intended exit code. */
export async function runSuggestSubagents(
  args: SuggestSubagentsArgs,
  deps: SuggestSubagentsDeps = {},
): Promise<number> {
  // After Ctrl-C has printed its line, the stopping run prints nothing more.
  const quiet = mutableOutput(deps.output ?? process.stdout);
  deps = { ...deps, output: quiet.output, mute: quiet.mute };
  const out = quiet.output;
  const write = (s = "") => out.write(`${s}\n`);
  const { home } = resolvePaths(args);
  const exporting = args.export !== undefined;
  const conflicting = (exporting ? GENERATE_ONLY : EXPORT_ONLY).filter((key) => given(args[key]));
  if (conflicting.length) {
    write(
      exporting
        ? `error: --export renders the saved suggestion and makes no model calls; drop ${conflicting.map((key) => `--${key}`).join(", ")}.`
        : `error: ${conflicting.map((key) => `--${key}`).join(", ")} only applies with --export <dir>.`,
    );
    return 1;
  }
  if (exporting) return runExport(args, home, deps, write);
  try {
    checkNumbers(args);
    return args["author-only"]
      ? await runAuthorOnly(args, home, deps, out, write)
      : await runGenerate(args, home, deps, out, write);
  } catch (error) {
    write(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function runExport(
  args: SuggestSubagentsArgs,
  home: string,
  deps: SuggestSubagentsDeps,
  write: (s?: string) => void,
): Promise<number> {
  const raw = args.export?.trim() ?? "";
  if (!raw) {
    write("error: --export needs a directory.");
    return 1;
  }
  const target = (args.target ?? "all").toLowerCase();
  if (target !== "all" && !SUBAGENT_TARGETS.includes(target as SubagentTarget)) {
    write(
      `error: unknown --target "${args.target}" (expected ${SUBAGENT_TARGETS.join(", ")} or all)`,
    );
    return 1;
  }
  let saved: ReturnType<typeof readSuggestion>;
  try {
    saved = readSuggestion(home);
  } catch (error) {
    write(
      `error: ${error instanceof SuggestionReadError ? error.message : (error as Error).message}`,
    );
    write(hint(hintCommand("suggest-subagents", args)));
    return 1;
  }
  if (!saved) {
    write(`No saved suggestion at ${suggestionPath(home)}. Create one first:`);
    write(hint(hintCommand("suggest-subagents", args)));
    return 1;
  }
  if (saved.stale) {
    write(
      yellow(
        "warning: the saved suggestion is stale; the reviewed preferences changed since it was generated. Exporting it as saved.",
      ),
    );
    write(dim(`refresh it with: ${hintCommand("suggest-subagents", args)}`));
  }
  const dir = path.resolve(raw);
  let files: Map<string, string>;
  let result: { written: string[]; skipped: string[] };
  try {
    files = renderSubagentTree(saved.artifact, {
      target: target as SubagentTarget | "all",
      pinModel: args["pin-model"],
    });
    const warning = harnessRootWarning(dir, deps.userHome, {
      dirs: {
        claude: args["claude-dir"],
        codex: args["codex-dir"],
        kiro: args["kiro-dir"],
        kirocrew: args["kirocrew-dir"],
      },
    });
    if (warning) write(yellow(`warning: ${warning}`));
    result = writeSubagentTree(dir, files, { force: args.force === true });
  } catch (error) {
    write(`error: ${(error as Error).message}`);
    return 1;
  }
  write(
    green(`wrote ${result.written.length} of ${counted(files.size, "file")} to ${dir}`) +
      (result.skipped.length ? `; kept ${counted(result.skipped.length, "existing file")}` : ""),
  );
  if (result.skipped.length) write(dim("re-run with --force to overwrite the kept files."));
  write(hint(`read ${path.join(dir, "HANDOFF.md")}`));
  return 0;
}

type Writer = (line?: string) => void;

function modelDisplay(session: RunSession, quality = session.quality) {
  return {
    generalize: session.displayModelFor("generalize", quality),
    propose: session.displayModelFor("propose", quality),
    author: session.displayModelFor("roles", quality),
  };
}

async function withSuggestionSession(
  args: SuggestSubagentsArgs,
  home: string,
  deps: SuggestSubagentsDeps,
  out: Writable,
  use: (session: RunSession) => Promise<number>,
): Promise<number> {
  const quality = parseQuality(args.quality);
  const session = await withSpinner(out, "Finding your coding CLI", () =>
    openRunSession({
      home,
      runner: args.runner ?? process.env.HUMAN_HINDSIGHT_RUNNER,
      quality,
      explicit: {
        model: args.model,
        cluster: args["cluster-model"],
        propose: args["propose-model"],
        author: args["author-model"],
      },
      pinSources: pinSourcesFrom(args as Record<string, unknown>, {
        ...args,
        runner: args.runner ?? process.env.HUMAN_HINDSIGHT_RUNNER,
      }),
      output: out,
      injectedRunner: deps.runner,
      injectedRunnerName: deps.runnerName,
      runners: deps.runners,
      purposes: { bulk: "preference summaries", major: "choosing and writing roles" },
    }),
  );
  try {
    return await use(session);
  } finally {
    await session.finalize();
  }
}

/**
 * A command for the person to run next, built by the shared builder from this
 * run's choices: the folders, the pinned CLI, quality, and the models and
 * sizes chosen for these stages (which only suggest-subagents itself keeps).
 */
function hintCommand(command: NextCommand, args: SuggestSubagentsArgs): string {
  return nextCommandText(command, args, { from: "suggest-subagents" });
}

/** The same selections for a command that renders the saved suggestion, which refuses these. */
function withoutGenerateOnly(args: SuggestSubagentsArgs): SuggestSubagentsArgs {
  const kept = { ...args };
  for (const key of GENERATE_ONLY) delete kept[key];
  return kept;
}

/** Retain flags that select the work. A fresh generalization can resume its completed windows. */
function resumeCommand(args: SuggestSubagentsArgs, quality: Quality, authorOnly: boolean): string {
  const selected: SuggestSubagentsArgs = { ...args, quality };
  if (authorOnly) {
    // Only the role prompts are left: the proposal's size options no longer apply.
    for (const key of ["min-roles", "max-roles", "input-budget", "window-size"] as const)
      delete selected[key];
    delete selected["include-unreviewed"];
  }
  const command = hintCommand("suggest-subagents", selected);
  return authorOnly ? `${command} --author-only` : command;
}

async function withApproval(opts: {
  args: SuggestSubagentsArgs;
  home: string;
  deps: SuggestSubagentsDeps;
  out: Writable;
  session: RunSession;
  plan: SubagentsPlan;
  concurrency: number;
  preview?: () => void;
  beforeCheck?: () => void;
  /** What Ctrl-C says was saved, at the moment it arrives. */
  saved: () => string;
  run: (guard: ApprovedRun) => Promise<number>;
}): Promise<number> {
  const { args, session, deps, out } = opts;
  const decision = await (deps.confirm ?? confirmPlan)(
    {
      digests: 0,
      cluster: 0,
      authorEstimate: 0,
      runnerName: session.ledgerRunner,
      session: session.describe(),
      quality: session.quality,
      qualityFixed: Boolean(args.quality || process.env.HUMAN_HINDSIGHT_QUALITY),
      concurrency: opts.concurrency,
      subagents: opts.plan,
      fullPlan: `${resumeCommand(args, session.quality, !!args["author-only"])} --dry-run`,
    },
    {
      yes: args.yes === true,
      dryRun: args["dry-run"] === true,
      input: deps.input,
      output: out,
      host: deps.host,
      onQuality: (quality: Quality) => {
        session.quality = quality;
      },
    },
  );
  if (decision === "dry-run") {
    opts.preview?.();
    return 0;
  }
  // The question printed its one line for Ctrl-C.
  if (decision === "interrupted") return 130;
  if (decision === "declined") {
    out.write("Declined. Nothing was sent.\n");
    return 2;
  }
  // The lock is taken after consent; Ctrl-C releases it and says how to resume.
  const guard = guardRun({
    home: opts.home,
    command: "suggest-subagents",
    output: out,
    resume: resumeCommand(args, session.quality, !!args["author-only"]),
    saved: opts.saved,
    mute: deps.mute,
    interrupt: () => session.interrupt(),
    cleanup: () => session.finalize(),
    host: deps.host,
    exit: deps.exit,
  });
  if ("busy" in guard) {
    out.write(`${guard.busy}\n`);
    return 1;
  }
  // The readiness check runs once, just before the first call this run makes.
  let checked: Promise<boolean> | undefined;
  const ready = (stages: readonly StageKey[]) =>
    (checked ??= session.liveCheck(stages).then((result) => {
      if (!result.ok) out.write(`${result.line}\n`);
      return result.ok;
    }));
  try {
    opts.beforeCheck?.();
    return await opts.run({
      resumeAuthor: () => guard.resume(resumeCommand(args, session.quality, true)),
      ready,
    });
  } finally {
    guard.end();
    for (const line of session.summaryLines()) out.write(`${dim(line)}\n`);
  }
}

/** What an approved run gets: the author-only resume hint, and the readiness check. */
interface ApprovedRun {
  resumeAuthor: () => void;
  /**
   * Check the CLI before the first call, with every stage the run will still
   * call; false after printing why it is not ready.
   */
  ready: (stages: readonly StageKey[]) => Promise<boolean>;
}

type CallFailure = Extract<CheckedResult<unknown>, { ok: false }>;

/**
 * Corrections and local repairs are not printed; only an outcome the person
 * should act on is: lessons the proposal left out, filed in a playbook.
 */
function unplacedNote(result: CheckedResult<ProposeOutput>, note: Writer): void {
  if (!result.ok || !result.repairs.length) return;
  note(
    `    ${counted(result.repairs.length, "working agreement")} fit no role, so ${result.repairs.length === 1 ? "it is" : "they are"} kept in the ${UNPLACED_PLAYBOOK} notes; review ${result.repairs.length === 1 ? "it" : "them"} in the exported files.`,
  );
}

/**
 * The propose stage, with each lesson shown under a short alias (`L1`, ...)
 * instead of its id of up to 80 characters. Checks and the unplaced-lesson
 * repair run on the answers as written; the proposal and any window results
 * come back with the real lesson ids.
 */
async function proposeRoles(opts: Parameters<typeof proposeShown>[0]) {
  const aliases = aliasesFor(
    opts.lessons.map((lesson) => lesson.id),
    "L",
  );
  const proposed = await proposeShown({ ...opts, lessons: withAliases(opts.lessons, aliases) });
  return proposed.ok
    ? { ...proposed, proposal: realProposal(proposed.proposal, aliases) }
    : { ...proposed, windows: proposed.windows.map((window) => realProposal(window, aliases)) };
}

/** Checked independent proposals may finish in any order. The merge always receives window order. */
async function proposeShown(opts: {
  lessons: Lesson[];
  projects: string[];
  bounds: RoleBounds;
  session: RunSession;
  budget: number;
  concurrency: number;
  timeoutMs?: number;
  out: Writable;
  verbose?: boolean;
}): Promise<
  | { ok: true; proposal: ProposeOutput; sources: SuggestionResultSource[] }
  | { ok: false; stage: string; failure: CallFailure; windows: ProposeOutput[] }
> {
  const { lessons, bounds, projects, session } = opts;
  const windows = planWindows(lessons, (lesson) => renderLessonCard(lesson).length, opts.budget);
  const split = windows.length > 1;
  const perWindow = split ? { minRoles: 0, maxRoles: bounds.maxRoles } : bounds;
  const progress = startStageProgress(opts.out, "Choosing roles", { verbose: opts.verbose });
  const timeoutFor = (n: number) =>
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS + SUGGEST_TIMEOUT_PER_ITEM_MS * n;
  progress.start(windows.length + Number(split), opts.concurrency);
  try {
    let stopped = false;
    const results = await mapConcurrent(windows, opts.concurrency, async (window, index) => {
      const unit = split ? `batch ${index + 1}` : "proposal";
      if (stopped) {
        progress.item({
          id: unit,
          status: "blocked",
          line: `${unit}: not started after a failure`,
        });
        return;
      }
      progress.running?.(unit, split ? `choosing roles, ${unit}` : "choosing roles");
      const result = await runChecked({
        runner: session.run,
        prompt: buildProposePrompt(window, perWindow, projects),
        schema: ProposeSchema,
        model: session.modelFor("propose"),
        timeoutMs: timeoutFor(window.length),
        repair: split ? undefined : (value) => repairProposal(value, window),
        check: (value) => proposeProblems(value, window, projects, perWindow),
      });
      progress.item({
        id: unit,
        status: result.ok ? "done" : "failed",
        line: `${unit}: ${result.ok ? counted(result.value.roles.length, "role") : result.error}`,
      });
      unplacedNote(result, (line = "") => progress.note(line));
      if (!result.ok) {
        stopped = true;
        return {
          ok: false as const,
          stage: split ? `propose (window ${index + 1})` : "propose",
          result,
        };
      }
      return {
        ok: true as const,
        value: result.value,
        source: result.resolved && { stage: "propose" as const, unit, ...result.resolved },
      };
    });
    const values = results.flatMap((r) => (r?.ok ? [r.value] : []));
    const sources = results.flatMap((r) => (r?.ok && r.source ? [r.source] : []));
    const failure = results.find((r) => r?.ok === false);
    if (failure && !failure.ok) {
      if (split)
        progress.item({
          id: "merge",
          status: "blocked",
          line: "Combining the roles waits for every batch.",
        });
      return { ok: false, stage: failure.stage, failure: failure.result, windows: values };
    }
    if (!split) {
      const [proposal] = values;
      if (!proposal) throw new Error("The propose call finished without a result.");
      return { ok: true, proposal, sources };
    }

    progress.running?.("merge", "combining the batches' roles");
    const merged = await runChecked({
      runner: session.run,
      prompt: buildProposeMergePrompt(values, lessons, bounds, projects),
      schema: ProposeSchema,
      model: session.modelFor("propose"),
      timeoutMs: timeoutFor(lessons.length),
      repair: (value) => repairProposal(value, lessons),
      check: (value) => proposeProblems(value, lessons, projects, bounds),
    });
    progress.item({
      id: "merge",
      status: merged.ok ? "done" : "failed",
      line: merged.ok ? counted(merged.value.roles.length, "role") : `combining: ${merged.error}`,
    });
    unplacedNote(merged, (line = "") => progress.note(line));
    if (!merged.ok)
      return { ok: false, stage: "propose (merge)", failure: merged, windows: values };
    if (merged.resolved) sources.push({ stage: "propose", unit: "merge", ...merged.resolved });
    return { ok: true, proposal: merged.value, sources };
  } finally {
    progress.end();
  }
}

function concreteModels(sources: SuggestionResultSource[]): SuggestionArtifact["models"] {
  const models: SuggestionArtifact["models"] = {};
  for (const stage of ["generalize", "propose", "author"] as const) {
    const used = new Set(sources.filter((r) => r.stage === stage).map((r) => r.model));
    if (used.size === 1) models[stage] = [...used][0];
  }
  return models;
}

/** Preserve the original attribution when adding prompts to a suggestion from an older release. */
function originalSources(artifact: SuggestionArtifact): SuggestionResultSource[] {
  if (artifact.resolved) return artifact.resolved;
  return [
    {
      stage: "generalize",
      unit: "saved agreements",
      runner: artifact.runner,
      model: artifact.models.generalize,
    },
    {
      stage: "propose",
      unit: "saved proposal",
      runner: artifact.runner,
      model: artifact.models.propose,
    },
    ...artifact.roles
      .filter((role) => role.prompt)
      .map((role) => ({
        stage: "author" as const,
        unit: role.name,
        runner: artifact.runner,
        model: artifact.models.author,
      })),
  ];
}

/** Keep the published artifact available until the new proposal and all in-flight calls have joined. */
async function authorAndPublish(opts: {
  home: string;
  baseKey: string | null;
  artifact: SuggestionArtifact;
  session: RunSession;
  out: Writable;
  concurrency: number;
  timeoutMs: number;
  resumeAuthor: () => void;
  verbose?: boolean;
}): Promise<SuggestionArtifact> {
  const { artifact, session, home, baseKey } = opts;
  const roles = [...artifact.roles];
  const prior = originalSources(artifact);
  const sources = prior.filter((source) => source.stage !== "author");
  const authors = new Map(
    prior.filter((source) => source.stage === "author").map((source) => [source.unit, source]),
  );
  const byId = new Map(artifact.lessons.map((lesson) => [lesson.id, lesson]));
  const pick = (ids: string[]) =>
    ids.map((id) => {
      const lesson = byId.get(id);
      if (!lesson)
        throw new Error(
          `The saved suggestion names a working agreement it does not hold ("${id}").`,
        );
      return lesson;
    });
  const shared = pick(artifact.shared);
  const snapshot = (): SuggestionArtifact => {
    const resolved = [
      ...sources,
      ...roles.flatMap((role) => {
        const source = authors.get(role.name);
        return source ? [source] : [];
      }),
    ];
    return { ...artifact, resolved, models: concreteModels(resolved), roles };
  };
  const pending = roles.map((role, index) => ({ role, index })).filter(({ role }) => !role.prompt);
  saveAuthorProgress(home, baseKey, snapshot());
  opts.resumeAuthor();
  const progress = startStageProgress(opts.out, "Writing role prompts", { verbose: opts.verbose });
  progress.start(pending.length, opts.concurrency);
  try {
    await mapConcurrent(pending, opts.concurrency, async ({ role, index }) => {
      progress.running?.(role.name, role.display_name);
      const result = await runChecked({
        runner: session.run,
        prompt: buildAuthorRolePrompt({
          role,
          lessons: pick(role.lesson_ids),
          shared,
          projects: artifact.projects,
        }),
        schema: AuthorRoleSchema,
        model: session.modelFor("roles"),
        timeoutMs: opts.timeoutMs,
        repair: repairAuthor,
        check: (value) =>
          authorProblems(value, role, artifact.lessons, artifact.shared, artifact.projects),
      });
      if (!result.ok) {
        progress.item({
          id: role.name,
          status: "failed",
          line: `${role.name}: ${result.error}. Kept without a written prompt.`,
        });
        return;
      }
      roles[index] = {
        ...role,
        prompt: result.value.prompt,
        triggers: result.value.triggers.map((value) => value.trim()),
      };
      if (result.resolved)
        authors.set(role.name, { stage: "author", unit: role.name, ...result.resolved });
      saveAuthorProgress(home, baseKey, snapshot());
      progress.item({
        id: role.name,
        status: "done",
        line: role.name,
      });
    });
  } finally {
    progress.end();
  }
  if (savedSuggestionKey(home) !== baseKey)
    throw new Error(
      "The saved suggestion changed while roles were being written. The new proposal is in suggestion.partial.json.",
    );
  const completed = snapshot();
  writeSuggestion(home, completed);
  clearAuthorProgress(home);
  return completed;
}

/**
 * A stage as the person reads it. The saved failure record keeps the stage's
 * own name ("generalize (window 2/3)"); the screen says "summarizing
 * preferences (batch 2 of 3)".
 */
export function plainStage(stage: string): string {
  return stage
    .replace(/^generalize/, "summarizing preferences")
    .replace(/^propose/, "choosing roles")
    .replace(/\(window (\d+)\/(\d+)\)/, "(batch $1 of $2)")
    .replace(/\(window (\d+)\)/, "(batch $1)")
    .replace("(merge)", "(combining the batches)");
}

/** What is saved when Ctrl-C lands in each step of a suggest-subagents run. */
const SAVED_AT = {
  start: "Nothing was saved yet.",
  summarize: "Preference batches that finished are saved; the rest are summarized next time.",
  choose: "The preference summaries are saved; choosing roles starts again next time.",
  write: "The chosen roles and the role prompts written so far are saved.",
} as const;

/** "1 call to choose roles", and so on, with the plan per quality. */
function planChoice(
  session: RunSession,
  quality: Quality,
  plan: GeneralizePlan | undefined,
  notes: string[],
): SubagentsChoice {
  const models = modelDisplay(session, quality);
  return {
    summarize: models.generalize,
    choose: models.propose,
    write: models.author,
    batches: plan?.windows.length ?? 0,
    reused: plan?.reusable ?? 0,
    notes,
  };
}

/** The summary of a finished suggestion: zero counts are left out. */
function suggestionSummary(result: SuggestionArtifact, lessons: number, width: number): string {
  const parts = [`${counted(lessons, "working agreement")} in all`];
  if (result.shared.length) parts.push(`${number(result.shared.length)} shared by every role`);
  if (result.playbooks.length)
    parts.push(`${counted(result.playbooks.length, "group")} of project-specific notes`);
  if (result.coverage.set_aside)
    parts.push(
      `${counted(result.coverage.set_aside, "preference")} left out (no reusable instruction)`,
    );
  return wrapText(`${parts.join("; ")}.`, width, { indent: "  " }).join("\n");
}

async function runGenerate(
  args: SuggestSubagentsArgs,
  home: string,
  deps: SuggestSubagentsDeps,
  out: Writable,
  write: Writer,
): Promise<number> {
  const now = () => deps.now?.() ?? new Date();
  const bounds = parseRoleBounds(args);
  const windowSize = resolveWindowSize(args["window-size"]);
  const budget = resolveInputBudget(args["input-budget"]);
  const timeoutMs = resolveTimeoutMs(args.timeout);
  const concurrency = parseConcurrency(args.concurrency);
  const prefs = await withSpinner(out, "Reading preference evidence", async () =>
    readObservedPreferences(home),
  );
  const reviewState = readPreferenceReviews(home);
  if (reviewState.invalid) {
    write(
      `error: the saved reviews in ${path.join(home, "library", PREFERENCE_REVIEW_FILE)} could not be read.`,
    );
    return 1;
  }
  if (!prefs.length) {
    write("No preferences yet. Distill your sessions first.");
    write(hint(hintCommand("distill", args)));
    return 0;
  }
  const includeUnreviewed = args["include-unreviewed"] === true;
  const { inputs, selection } = selectSuggestionInputs(prefs, reviewState.reviews, {
    includeUnreviewed,
  });
  if (!inputs.length) {
    write("Every preference is dismissed. There is nothing to suggest subagents from.");
    write(hint(hintCommand("gui", args)));
    return 0;
  }
  const baseKey = savedSuggestionKey(home);
  return withSuggestionSession(args, home, deps, out, async (session) => {
    // Each plan has its own models, so its own saved batches: both are
    // planned before the screen, so its numbers hold whichever is picked.
    const plans = {} as Record<Quality, GeneralizePlan>;
    const selectedQuality = session.quality;
    for (const quality of ["balanced", "best"] as const) {
      session.quality = quality;
      const plan = planGeneralize({
        home,
        budget,
        windowSize,
        selection: includeUnreviewed ? "all-candidates" : "auto",
        identityRunner: session.identityRunner,
        model: session.modelFor("generalize"),
        fresh: args["fresh-generalize"],
        current: { prefs, reviews: reviewState.reviews },
      });
      if (!plan) throw new Error("The selected preferences are unavailable.");
      plans[quality] = plan;
    }
    session.quality = selectedQuality;
    const shown = plans[selectedQuality];
    if (shown.damaged)
      write(
        yellow(
          `The saved working agreements could not be read (${shown.damaged}). This run replaces them.`,
        ),
      );
    const candidates = selectSuggestionInputs(prefs, reviewState.reviews, {
      includeUnreviewed: true,
    }).inputs.length;
    const description = session.describe();
    let phase: keyof typeof SAVED_AT = "start";
    let published = false;
    let needsAuthor = false;
    const code = await withApproval({
      args,
      home,
      deps,
      out,
      session,
      concurrency,
      saved: () => SAVED_AT[phase],
      plan: {
        inputs: inputs.length,
        accepted: inputs.filter((input) => input.review === "accepted").length,
        selection,
        includeUnreviewed,
        ...(selection === "accepted" && inputs.length < candidates ? { candidates } : {}),
        ...bounds,
        choices: {
          balanced: planChoice(
            session,
            "balanced",
            plans.balanced,
            description.plans.balanced.notes,
          ),
          best: planChoice(session, "best", plans.best, description.plans.best.notes),
        },
      },
      preview: () => {
        write();
        write(banner("preference batches", counted(shown.windows.length, "batch", "batches")));
        for (const [index, window] of shown.windows.entries()) {
          const key = shown.keys[index];
          const reused = key !== undefined && Object.hasOwn(shown.saved, key);
          write(
            `  ${glyph("•", "-")} batch ${index + 1}: ${counted(window.length, "preference")}, ${counted(buildGeneralizePrompt(window, shown.projects).length, "character")}${reused ? " (reused)" : ""}`,
          );
        }
      },
      beforeCheck: () => {
        if (savedSuggestionKey(home) !== baseKey)
          throw new Error(
            "The saved suggestion changed while you reviewed the plan. Run suggest-subagents again.",
          );
      },
      run: async ({ resumeAuthor, ready }) => {
        const plan = plans[session.quality];
        const stop = (
          stage: string,
          failure: { error: string; problems: string[]; raw: unknown },
          details: Record<string, unknown>,
        ): number => {
          write(`  ${fail(`${plainStage(stage)} failed: ${failure.error}`)}`);
          const { file, keptProposal } = writePartial(
            home,
            { stage, problems: failure.problems, raw_output: failure.raw, ...details },
            now(),
          );
          write(`Saved the problems and the results so far in ${file}.`);
          if (keptProposal) {
            write("The interrupted role proposal from an earlier run is kept. To finish it, run:");
            write(`  ${resumeCommand(args, session.quality, true)}`);
          }
          if (baseKey) write(dim(`Your previous suggestion is still at ${suggestionPath(home)}.`));
          return 1;
        };
        // A batch to summarize makes a call certain: check now. Otherwise the
        // first call is the one that chooses roles, checked just before it.
        if (
          plan.windows.length > plan.reusable &&
          !(await ready(["generalize", "propose", "roles"]))
        )
          return 1;
        phase = "summarize";
        const generalized = await runGeneralizeStage({
          home,
          plan,
          runner: session.run,
          model: plan.model,
          concurrency,
          timeoutMs,
          output: out,
          now,
          progress: startStageProgress(out, "Summarizing preferences", { verbose: args.verbose }),
        });
        const lessons = generalized.lessonList;
        const setAside = generalized.setAside;
        if (generalized.status !== "done" || !generalized.artifact) {
          const failure = generalized.failure ?? {
            error: generalized.errors.join(". "),
            problems: generalized.errors,
            raw: null,
          };
          const stage = generalized.failure?.window
            ? `generalize (window ${generalized.failure.window}/${plan.windows.length})`
            : "generalize";
          return stop(stage, failure, {
            lessons,
            set_aside: setAside,
            checkpointed_windows: generalized.completedWindows,
            resume_hint: resumeCommand(args, session.quality, false),
          });
        }
        if (!lessons.some((lesson) => lesson.disposition === "generalized")) {
          return stop(
            "generalize",
            {
              error: "There are no portable agreements to group into roles.",
              problems: ["no generalized lesson"],
              raw: null,
            },
            { lessons, set_aside: setAside },
          );
        }
        if (!(await ready(["propose", "roles"]))) return 1;
        phase = "choose";
        const proposed = await proposeRoles({
          lessons,
          projects: plan.projects,
          bounds,
          session,
          budget,
          concurrency,
          timeoutMs,
          out,
          verbose: args.verbose,
        });
        if (!proposed.ok)
          return stop(proposed.stage, proposed.failure, {
            lessons,
            set_aside: setAside,
            window_results: proposed.windows,
          });
        const sources: SuggestionResultSource[] = [];
        for (const [index, key] of plan.keys.entries()) {
          const call = generalized.artifact.windows[key]?.resolved;
          if (call) sources.push({ stage: "generalize", unit: `window ${index + 1}`, ...call });
        }
        sources.push(...proposed.sources);
        const parts = { ...proposed.proposal, inputs, lessons, set_aside: setAside };
        const artifact: SuggestionArtifact = {
          version: SUGGESTION_VERSION,
          generated_at: now().toISOString(),
          prompt_versions: {
            generalize: GENERALIZE_PROMPT_VERSION,
            propose: PROPOSE_PROMPT_VERSION,
            author: AUTHOR_ROLE_PROMPT_VERSION,
          },
          runner: proposed.sources.at(-1)?.runner ?? session.ledgerRunner,
          models: concreteModels(sources),
          resolved: sources,
          source_hash: suggestionFingerprint(inputs, reviewState.reviews),
          projects: plan.projects,
          selection,
          ...parts,
          coverage: computeCoverage(parts),
        };
        phase = "write";
        const result = await authorAndPublish({
          home,
          baseKey,
          artifact,
          session,
          out,
          concurrency,
          timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
          resumeAuthor,
          verbose: args.verbose,
        });
        published = true;
        needsAuthor = result.roles.some((role) => !role.prompt);
        write();
        write(
          green(
            `Suggested ${counted(result.roles.length, "role")} from ${counted(inputs.length, "preference")}.`,
          ),
        );
        for (const role of result.roles) {
          write(
            `  ${glyph("•", "-")} ${role.display_name} (${role.name}): ${counted(role.lesson_ids.length, "working agreement")}${role.prompt ? "" : yellow(", using the role description as its prompt")}`,
          );
        }
        write(suggestionSummary(result, lessons.length, screenWidth(out)));
        write(dim(`Saved to ${suggestionPath(home)}`));
        return 0;
      },
    });
    if (!published) return code;
    if (needsAuthor) {
      write("Some roles have no written prompt yet. To write them, run:");
      write(`  ${resumeCommand(args, session.quality, true)}`);
    }
    const next = await closingMenu(args, home, deps, out);
    return next === 0 ? code : next;
  });
}

/** Where the closing menu offers to export the subagents by default. */
export const DEFAULT_EXPORT_DIR = "human-hindsight-subagents";

/**
 * After a suggestion is saved: at a terminal, the same kind of closing menu
 * distill has (open the Subagents view, export the files, or finish); without
 * one, or with `--yes`, `--dry-run`, or `--no-follow-up`, the two next
 * commands. Returns 130 after Ctrl-C, else the chosen command's code.
 */
async function closingMenu(
  args: SuggestSubagentsArgs,
  home: string,
  deps: SuggestSubagentsDeps,
  out: Writable,
): Promise<number> {
  const io = { input: deps.input, output: out, host: deps.host };
  const followUp =
    args["follow-up"] !== false &&
    process.env.HUMAN_HINDSIGHT_FOLLOW_UP !== "0" &&
    args.yes !== true &&
    args["dry-run"] !== true;
  if (!followUp || !canPrompt(io)) {
    out.write(`${hint(`${hintCommand("gui", args)} --tab=subagents`)}\n`);
    out.write(
      `${hint(`${hintCommand("suggest-subagents", withoutGenerateOnly(args))} --export <dir>`)}\n`,
    );
    return 0;
  }
  out.write("\n");
  const choice = await chooseMenuAnswer(
    {
      title: "What next?",
      choices: [
        {
          key: "gui",
          label: "Open my subagents",
          detail: "read each role in the browser view",
          recommended: true,
        },
        { key: "export", label: "Export them as files", detail: "for your coding tools" },
        { key: "done", label: "Done for now" },
      ],
    },
    io,
  );
  if (choice === "interrupt") return 130;
  if (choice === "gui")
    return (deps.runNext ?? runNextCommand)("gui", { ...args, tab: "subagents" });
  if (choice !== "export") return 0;
  const answer = await readLine(`  Folder to write them to [${DEFAULT_EXPORT_DIR}]: `, io);
  if (answer === null) return 0;
  const dir = answer.trim() || DEFAULT_EXPORT_DIR;
  out.write("\n");
  return runExport({ ...args, export: dir }, home, deps, (line = "") => out.write(`${line}\n`));
}

async function runAuthorOnly(
  args: SuggestSubagentsArgs,
  home: string,
  deps: SuggestSubagentsDeps,
  out: Writable,
  write: Writer,
): Promise<number> {
  const baseKey = savedSuggestionKey(home);
  const pending = pendingAuthorProposal(home, baseKey);
  const saved = pending ? null : readSuggestion(home);
  const artifact = pending ?? saved?.artifact;
  if (!artifact) {
    write("No saved suggestion to write role prompts for. Run suggest-subagents first.");
    write(hint(hintCommand("suggest-subagents", args)));
    return 1;
  }
  if (pending)
    write(`Resuming the interrupted proposal of ${counted(pending.roles.length, "role")}.`);
  if (saved?.stale || (pending && isSuggestionStale(home, pending))) {
    write(
      yellow(
        "The reviewed preferences changed. Role prompts will use this proposal's saved agreements.",
      ),
    );
  }
  const bare = artifact.roles.filter((role) => !role.prompt);
  function checkSnapshot(): void {
    if (
      savedSuggestionKey(home) !== baseKey ||
      fingerprint(pendingAuthorProposal(home, baseKey)) !== fingerprint(pending)
    ) {
      throw new Error(
        "The role proposal changed while you reviewed the plan. Run suggest-subagents --author-only again.",
      );
    }
  }
  if (!bare.length) {
    if (!pending) {
      write("Every role in the saved suggestion already has a prompt.");
      return 0;
    }
    if (args["dry-run"]) {
      write("The completed role prompts are ready to save. No model calls are needed.");
    } else {
      let writer: ReturnType<typeof acquireWriterLock>;
      try {
        writer = acquireWriterLock(home, "suggest-subagents");
      } catch (error) {
        if (!(error instanceof WriterBusyError)) throw error;
        write(error.message);
        return 1;
      }
      try {
        checkSnapshot();
        writeSuggestion(home, pending);
        clearAuthorProgress(home);
        write(`Saved the completed suggestion to ${suggestionPath(home)}.`);
      } finally {
        writer.release();
      }
    }
    return 0;
  }
  const concurrency = parseConcurrency(args.concurrency);
  const timeoutMs = resolveTimeoutMs(args.timeout);
  return withSuggestionSession(args, home, deps, out, (session) => {
    const description = session.describe();
    return withApproval({
      args,
      home,
      deps,
      session,
      out,
      concurrency,
      saved: () => SAVED_AT.write,
      plan: {
        inputs: artifact.inputs.length,
        accepted: artifact.inputs.filter((input) => input.review === "accepted").length,
        selection: artifact.selection,
        minRoles: bare.length,
        maxRoles: bare.length,
        choices: {
          balanced: planChoice(session, "balanced", undefined, description.plans.balanced.notes),
          best: planChoice(session, "best", undefined, description.plans.best.notes),
        },
        authorOnly: { names: bare.map((role) => role.name), roles: artifact.roles.length },
      },
      beforeCheck: checkSnapshot,
      run: async ({ resumeAuthor, ready }) => {
        // Every saved role without a prompt is one call, so a call is certain.
        if (!(await ready(["roles"]))) return 1;
        const updated = await authorAndPublish({
          home,
          baseKey,
          session,
          concurrency,
          timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
          out,
          resumeAuthor,
          verbose: args.verbose,
          artifact: {
            ...artifact,
            generated_at: (deps.now?.() ?? new Date()).toISOString(),
            prompt_versions: { ...artifact.prompt_versions, author: AUTHOR_ROLE_PROMPT_VERSION },
          },
        });
        const remaining = updated.roles.filter((role) => !role.prompt);
        write(
          green(
            `Wrote ${bare.length - remaining.length} of ${counted(bare.length, "role prompt")}.`,
          ),
        );
        write(dim(`Saved to ${suggestionPath(home)}`));
        if (remaining.length) {
          write(
            yellow(`Still missing prompts for ${remaining.map((role) => role.name).join(", ")}.`),
          );
          write("To write them, run:");
          write(`  ${resumeCommand(args, session.quality, true)}`);
        }
        write(hint(`${hintCommand("gui", args)} --tab=subagents`));
        return remaining.length ? 1 : 0;
      },
    });
  });
}

export default defineCommand({
  meta: {
    name: "suggest-subagents",
    description:
      "Suggest specialist subagents from your preferences (shows the plan first), or export them",
  },
  args: {
    ...sharedArgs,
    runner: {
      type: "string",
      description:
        "Which local CLI runs the stages: claude, codex, kiro, opencode, or auto (default: auto)",
    },
    model: {
      type: "string",
      description: `Model for summarizing preferences (env ${SUBAGENT_MODEL_ENV}; default: the selected plan)`,
    },
    "propose-model": {
      type: "string",
      description: "Model for choosing roles (default: --model, else the selected plan)",
    },
    "author-model": {
      type: "string",
      description: "Model for writing role prompts (default: --model, else the selected plan)",
    },
    "include-unreviewed": {
      type: "boolean",
      description: "Use every preference you have not dismissed, even when some are accepted",
    },
    "min-roles": { type: "string", description: "Fewest roles to propose (2 to 15, default 2)" },
    "max-roles": { type: "string", description: "Most roles to propose (2 to 15, default 15)" },
    concurrency: {
      type: "string",
      description: `Most preference batches or role prompts at a time (default ${DEFAULT_CONCURRENCY})`,
    },
    "input-budget": {
      type: "string",
      description: "Size limit per call, in characters of preferences (default 400000)",
    },
    "window-size": {
      type: "string",
      description: `Most preferences per summary call (default ${DEFAULT_WINDOW_SIZE})`,
    },
    "fresh-generalize": {
      type: "boolean",
      description: "Summarize every preference again, replacing the saved working agreements",
    },
    "author-only": {
      type: "boolean",
      description: "Finish unwritten role prompts in the interrupted or saved suggestion",
    },
    timeout: {
      type: "string",
      description: "Time limit per call in seconds (default 900, plus 5 per preference)",
    },
    "dry-run": { type: "boolean", description: "Print the call plan and the inputs; run nothing" },
    yes: { type: "boolean", description: "Approve the plan without asking (for scripting)" },
    verbose: {
      type: "boolean",
      description: "Show which batches and roles are being worked on",
    },
    export: {
      type: "string",
      description: "Write the saved suggestion as files under this directory (no model calls)",
    },
    target: {
      type: "string",
      description: `With --export: ${SUBAGENT_TARGETS.join(", ")}, or all (default: all)`,
    },
    force: { type: "boolean", description: "With --export: overwrite files that already exist" },
    "pin-model": {
      type: "string",
      description:
        "With --export: write this model id into the Claude Code, Kiro CLI and Kiro Crew files (default: inherit)",
    },
  },
  async run({ args }) {
    const code = await runSuggestSubagents(args as unknown as SuggestSubagentsArgs);
    if (code !== 0) process.exitCode = code;
  },
});
