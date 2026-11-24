import fs from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { defineCommand } from "citty";
import pkg from "../../package.json" with { type: "json" };
import {
  resolveInputBudget,
  resolveTimeoutMs,
  resolveTruncatePolicy,
  type TruncatePolicy,
} from "../core/budget.js";
import { runnerSessionShare } from "../core/environment.js";
import { generalizedGap } from "../core/generalized.js";
import { OUTCOME_NOT_VERIFIED, readLibrary } from "../core/library.js";
import { parseQuality, type Quality } from "../core/model-plan.js";
import { damagedFile } from "../core/plain-failure.js";
import { readObservedPreferences } from "../core/preferences.js";
import {
  openRunSession,
  type PinKey,
  type PinSource,
  type RunSession,
  type StageKey,
} from "../core/run-session.js";
import { checkedValue, valueProblem, wholeOption } from "../core/value-rule.js";
import {
  askYesNoAnswer,
  type ConsentOptions,
  type ConsentResult,
  confirmPlan,
  type DistillPlan,
  screenWidth,
} from "../distill/consent.js";
import {
  type GeneralizeResult,
  planGeneralize,
  runGeneralizeStage,
} from "../distill/generalize.js";
import {
  clearCheckpoints,
  loadDigests,
  loadTasks,
  planDigestReuse,
  type RunnerFn,
  runAuthorStage,
  runClusterStage,
  runDigestStage,
} from "../distill/pipeline.js";
import { guardRun, mutableOutput } from "../distill/run-guard.js";
import type { Digest } from "../distill/schemas.js";
import { startStageProgress } from "../distill/stage-events.js";
import type { RunnerIo } from "../runners/shared.js";
import type { AgentRunner } from "../runners/types.js";
import { parseSourceMode } from "../sources/registry.js";
import type { SourceName } from "../sources/types.js";
import type { TerminalHost } from "../ui/live.js";
import { canPrompt, glyph } from "../ui/mode.js";
import { terminalPrivacyReminder } from "../ui/privacy.js";
import { withSpinner } from "../ui/progress.js";
import { chooseMenuAnswer } from "../ui/prompt.js";
import { counted, cyan, dim, fail, green, hint, skip } from "../ui/style.js";
import { fitLines, sayThenRun, wrapText } from "../ui/wrap.js";
import {
  CLUSTER_BATCH_RULE,
  leftBehindEntries,
  parseConcurrency,
  parseMessageCount,
  RECENT_RULE,
  resolvePaths,
  sharedArgs,
} from "./_shared.js";
import { type ExportArgs, runExport } from "./export.js";
import {
  flowArgs,
  nextCommandText,
  offerLibraryNext,
  printedHome,
  retryCommandText,
  shellWord,
} from "./next.js";
import { preferenceStoryLines } from "./preferences.js";
import { runStrictRetry, validateRetryArguments } from "./retry.js";

// One entry of `exports/manifest.json`. defined next to the code that writes
// it; re-exported here because the distill plan is computed from it.
export type { ManifestEntry } from "./export.js";

import type { ManifestEntry } from "./export.js";

/** Normalized args the distill core reads. */
export interface DistillArgs {
  home?: string;
  "claude-dir"?: string;
  "codex-dir"?: string;
  "kiro-dir"?: string;
  "kirocrew-dir"?: string;
  "opencode-dir"?: string;
  "opencode-db"?: string;
  /** Which backend(s) to distill from: claude, codex, kiro, or auto (default auto). */
  source?: string;
  /** Which local CLI distills: claude, codex, kiro, or auto (default auto). */
  runner?: string;
  quality?: string;
  recent?: string;
  generalize?: boolean;
  "follow-up"?: boolean;
  project?: string;
  /** citty maps `--no-group` to `group: false`; grouping is on by default. */
  group?: boolean;
  /**
   * citty maps `--no-breaker` to `breaker: false`. The systemic-failure breaker
   * is on by default; disabling it attempts every session even when they are all
   * failing identically.
   */
  breaker?: boolean;
  "min-substance"?: string;
  model?: string;
  "cluster-model"?: string;
  "author-model"?: string;
  "cluster-batch-size"?: string;
  fresh?: boolean;
  "dry-run"?: boolean;
  yes?: boolean;
  "input-budget"?: string;
  truncate?: string;
  timeout?: string;
  concurrency?: string;
  force?: boolean;
  "retry-failed"?: boolean;
  "retry-stage"?: string;
  "recover-tasks"?: string;
  /** Show which items are running and the per-item detail. */
  verbose?: boolean;
}

/** The count math derived from the manifest, before consent. */
export interface ComputedPlan {
  eligible: ManifestEntry[];
  digests: number;
  cluster: number;
  clusterWindowsEstimate?: number;
  clusterMergeEstimate?: number;
  authorEstimate: number;
}

/**
 * Compute the invocation plan from manifest entries: apply the `--project`
 * filter and `--min-substance` threshold, then derive digest / cluster /
 * author counts. Author estimate is `max(1, round(eligible/3))` when grouping
 * (exact count is only known after clustering), or exactly one per session
 * with `--no-group`.
 */
export function computePlan(
  entries: ManifestEntry[],
  inputs: {
    project?: string;
    minSubstance: number;
    noGroup: boolean;
    recent?: number;
    clusterBatchSize?: number;
    /** Origins to include; entries from other backends are filtered out. Absent means all. */
    activeOrigins?: Set<string>;
  },
): ComputedPlan {
  let eligible = entries;
  // Origin filter: a manifest written before the multi-backend seam has no
  // `origin`, which counts as "claude" (the old-manifest rule).
  if (inputs.activeOrigins) {
    eligible = eligible.filter((e) => inputs.activeOrigins?.has(e.origin ?? "claude"));
  }
  if (inputs.project) {
    const needle = inputs.project.toLowerCase();
    eligible = eligible.filter((e) => (e.project ?? "").toLowerCase().includes(needle));
  }
  eligible = eligible.filter((e) => (e.messages ?? 0) >= inputs.minSubstance);

  if (inputs.recent !== undefined) {
    const timestamp = (entry: ManifestEntry) => Date.parse(entry.last_ts) || 0;
    eligible = [...eligible]
      .sort(
        (left, right) =>
          timestamp(right) - timestamp(left) || left.export.localeCompare(right.export),
      )
      .slice(0, inputs.recent);
  }
  const digests = eligible.length;
  const grouping = !inputs.noGroup && digests > 0;
  const clusterWindowsEstimate =
    grouping && inputs.clusterBatchSize !== undefined
      ? Math.ceil(digests / inputs.clusterBatchSize)
      : undefined;
  const clusterMergeEstimate =
    clusterWindowsEstimate === undefined ? undefined : clusterWindowsEstimate > 1 ? 1 : 0;
  const cluster = grouping ? (clusterWindowsEstimate ?? 1) + (clusterMergeEstimate ?? 0) : 0;
  let authorEstimate: number;
  if (digests === 0) authorEstimate = 0;
  else if (inputs.noGroup) authorEstimate = digests;
  else authorEstimate = Math.max(1, Math.round(digests / 3));

  return {
    eligible,
    digests,
    cluster,
    clusterWindowsEstimate,
    clusterMergeEstimate,
    authorEstimate,
  };
}

/** Apply the same UTF-16 character count as the digest stage before spending anything. */
function computeOversized(
  home: string,
  eligible: ManifestEntry[],
  budget: number,
): { export: string; chars: number }[] {
  const out: { export: string; chars: number }[] = [];
  for (const e of eligible) {
    try {
      if (path.basename(e.export) !== e.export) continue;
      const chars = fs.readFileSync(path.join(home, "exports", e.export), "utf8").length;
      if (chars > budget) out.push({ export: e.export, chars });
    } catch {
      // missing/unreadable export. the digest stage reports it as a failure
    }
  }
  return out;
}

/** Injectable dependencies (testing). */
export interface DistillDeps {
  confirm?: (plan: DistillPlan, opts: ConsentOptions) => Promise<ConsentResult | "interrupted">;
  /** Stage runner passed to the pipeline (default: the CLIs found on this machine). */
  runner?: RunnerFn;
  /** Ready-made CLIs in priority order, used instead of looking for installed ones. */
  runners?: AgentRunner[];
  /** The process boundary the real CLIs are started through. */
  io?: RunnerIo;
  input?: Readable;
  output?: Writable;
  /** Where Ctrl-C arrives (default `process`). */
  host?: TerminalHost;
  /** How an interrupted run ends (default `process.exit`). */
  exit?(code: number): void;
  /** Clock in milliseconds, for elapsed times. */
  now?(): number;
  /**
   * The waits of a run: between retries of a temporary failure, and the
   * bounded cleanup after Ctrl-C (default: real timers). Tests pass one that
   * returns at once.
   */
  sleep?(ms: number): Promise<void>;
  /** Legacy test seam; distill no longer performs clipboard writes. */
  clipboard?: (text: string) => Promise<{ ok: boolean; tool: string; error?: string }>;
}

/** Large histories are offered this many of their newest sessions first. */
const QUICK_START = 25;
/**
 * Said before the CLIs are asked for their models. It makes no claim about the
 * network: the run session says so itself, naming the CLI, when a model list
 * really comes from a service.
 */
const LISTING_LINE = "Checking which coding CLIs are ready.";
const NOTHING_SENT = "Nothing was sent.";

/**
 * Where each setting that can pin the CLI came from, read from the arguments
 * as typed, before the environment is folded in: a value present there is a
 * flag, otherwise it came from its environment variable. A failure then names
 * the right thing to change.
 */
export function pinSourcesOf(raw: DistillArgs): Partial<Record<PinKey, PinSource>> {
  const typed = (value: string | undefined): PinSource =>
    value !== undefined && value !== "" ? "flag" : "environment";
  return {
    runner: typed(raw.runner),
    model: typed(raw.model),
    cluster: typed(raw["cluster-model"]),
    author: typed(raw["author-model"]),
  };
}

/**
 * The distill command core. Returns the intended process exit code
 * (0 success/dry-run, 1 nothing exported / bad manifest / stage failure,
 * 2 consent declined, 130 interrupted before anything was sent) so the caller
 * can set `process.exitCode` and tests can assert without exiting.
 */
export async function runDistill(args: DistillArgs, deps: DistillDeps = {}): Promise<number> {
  let clusterBatchSize: number | undefined;
  try {
    validateRetryArguments(args);
    // Every number is checked before anything is read, asked, or sent. A
    // wrong value is its one line, never the default.
    parseMessageCount("min-substance", args["min-substance"], 2);
    resolveInputBudget(args["input-budget"]);
    resolveTruncatePolicy(args.truncate);
    resolveTimeoutMs(args.timeout);
    parseConcurrency(args.concurrency);
    if (args.recent !== undefined) checkedValue(RECENT_RULE, "recent", args.recent);
    if (args["cluster-batch-size"] !== undefined) {
      const size = wholeOption(
        CLUSTER_BATCH_RULE,
        "cluster-batch-size",
        args["cluster-batch-size"],
        0,
      );
      if (args.group !== false) clusterBatchSize = size;
    }
  } catch (error) {
    (deps.output ?? process.stdout).write(`error: ${(error as Error).message}\n`);
    return 1;
  }
  if (args["retry-failed"] || args["recover-tasks"] !== undefined)
    return runStrictRetry(args, deps);
  // After Ctrl-C has printed its line, the stopping run prints nothing more.
  const quiet = mutableOutput(deps.output ?? process.stdout);
  deps = { ...deps, output: quiet.output };
  const explicitArgs = args;
  args = flowArgs(args);
  let recent: number | undefined;
  if (args.recent !== undefined) {
    // Also from HUMAN_HINDSIGHT_RECENT, which the flag check above does not see.
    const problem = valueProblem(RECENT_RULE, "recent", args.recent);
    if (problem) {
      (deps.output ?? process.stdout).write(`error: ${problem}\n`);
      return 1;
    }
    recent = Number(args.recent.trim());
  }
  const out = deps.output ?? process.stdout;
  const write = (s = "") => out.write(`${s}\n`);
  const ask = { input: deps.input, output: out, host: deps.host };
  write(dim(terminalPrivacyReminder(out)));
  write();

  const { home } = resolvePaths(args);
  const manifestPath = path.join(home, "exports", "manifest.json");
  const sourceMode = parseSourceMode(args.source);
  // Which origins the distill plan should consider. a --source claude/kiro run
  // narrows the (possibly merged) manifest to that backend; auto keeps both.
  const activeOrigins: Set<SourceName> | undefined =
    sourceMode === "auto" ? undefined : new Set<SourceName>([sourceMode]);

  // We can prompt when there's a stream to prompt on: an injected input (tests)
  // or a real interactive stdin. In a pipe/CI without --yes we deliberately do
  // NOT prompt. behavior stays exactly as before (no surprise export, no
  // library dump). --yes proceeds through every offer without reading stdin.
  const canAsk = deps.input !== undefined || canPrompt({ output: out });

  let raw: string;
  try {
    raw = await withSpinner(out, "Reading exported sessions", async () =>
      fs.readFileSync(manifestPath, "utf8"),
    );
  } catch {
    // No manifest yet. Offer to run export first (local, no model call) so a
    // first-time user can go from zero to a library in one command. Same read
    // surface as the default `scan`, so this is not a new trust boundary; the
    // model consent gate below is untouched.
    if (args["dry-run"]) {
      write("Nothing is exported yet. Run export first (free, local), then run this again.");
      write(hint(nextCommandText("export", args)));
      return 1;
    }
    // Name the store(s) the offered export will read, per --source.
    const paths = resolvePaths(args);
    const stores = {
      claude: paths.claudeDir,
      codex: paths.codexDir,
      kiro: paths.kiroDir,
      kirocrew: paths.kirocrewDir,
      opencode: paths.opencodeDir,
    };
    const reads =
      sourceMode === "auto"
        ? "your Claude Code, Codex, Kiro, Kiro Crew, and OpenCode stores"
        : stores[sourceMode];
    const offer = args.yes
      ? "yes"
      : canAsk
        ? await askYesNoAnswer(
            wrapText(
              `Nothing is exported yet. Export now? It reads ${reads} and writes ${home}, on this machine only; nothing is sent anywhere.`,
              screenWidth(out) - 6,
            ).join("\n"),
            { ...ask, defaultYes: true },
          )
        : "no";
    if (offer === "interrupt") {
      write(`Interrupted. ${NOTHING_SENT}`);
      return 130;
    }
    if (offer !== "yes") {
      write("Nothing is exported yet.");
      write(hint(nextCommandText("export", args)));
      return 1;
    }
    write();
    write("Reading session history for export...");
    runExport({
      home: args.home,
      "claude-dir": args["claude-dir"],
      "codex-dir": args["codex-dir"],
      "kiro-dir": args["kiro-dir"],
      "kirocrew-dir": args["kirocrew-dir"],
      "opencode-dir": args["opencode-dir"],
      "opencode-db": args["opencode-db"],
      source: args.source,
      project: args.project,
      output: deps.output,
    } satisfies ExportArgs);
    write();
    try {
      raw = fs.readFileSync(manifestPath, "utf8");
    } catch {
      write("Export found no sessions, so there is nothing to distill.");
      return 1;
    }
  }

  // A damaged manifest is one plain line on stderr, through the guard every command runs under.
  const entries = parseManifest(raw, manifestPath);

  const minSubstance = parseMessageCount("min-substance", args["min-substance"], 2);
  const noGroup = args.group === false;
  const budget = resolveInputBudget(args["input-budget"]);
  const truncate = resolveTruncatePolicy(args.truncate);
  const timeoutMs = resolveTimeoutMs(args.timeout);
  const planOptions = {
    project: args.project,
    minSubstance,
    noGroup,
    clusterBatchSize,
    activeOrigins,
  };
  const everything = computePlan(entries, planOptions);
  let plan = computePlan(entries, { ...planOptions, recent });
  // A large history can start with its newest sessions. Asked only on a
  // terminal, never under --yes or --dry-run; otherwise the plan names the flag.
  let quickStartHint: number | undefined;
  if (recent === undefined && plan.digests > QUICK_START) {
    if (!args.yes && !args["dry-run"] && canPrompt(ask)) {
      const choice = await chooseMenuAnswer(
        {
          title: "Which sessions would you like to start with?",
          choices: [
            {
              key: "recent",
              label: `My ${QUICK_START} most recent sessions`,
              detail: "A shorter first run. Saved reads are reused when you do the rest.",
              recommended: true,
            },
            {
              key: "all",
              label: `Everything (${counted(plan.digests, "eligible session")})`,
            },
          ],
        },
        ask,
      );
      // The kit has already printed its line for an interrupt.
      if (choice === "interrupt") return 130;
      if (choice === "quit") {
        write(`Declined. ${NOTHING_SENT}`);
        return 2;
      }
      if (choice === "recent") {
        recent = QUICK_START;
        args = { ...args, recent: String(QUICK_START) };
        plan = computePlan(entries, { ...planOptions, recent });
      }
      write();
    } else quickStartHint = QUICK_START;
  }

  if (plan.digests === 0) {
    const scope = args.project ? ` in project "${args.project}"` : "";
    write(`nothing to distill: no sessions with at least ${minSubstance} human messages${scope}.`);
    return 0;
  }

  // Say what happens next, in every mode including --dry-run. A model list
  // that needs the network gets its own line from the run session.
  write(dim(LISTING_LINE));
  let session: RunSession;
  const stopEarlyInterrupt = interruptBeforeConsent(out, deps);
  try {
    session = await withSpinner(
      out,
      "Finding ready CLIs and their models",
      () =>
        openRunSession({
          home,
          runner: args.runner,
          pinSources: pinSourcesOf(explicitArgs),
          quality: parseQuality(args.quality),
          explicit: {
            model: args.model,
            cluster: args["cluster-model"],
            author: args["author-model"],
          },
          sessionShare: runnerSessionShare(
            computePlan(entries, {
              project: args.project,
              activeOrigins,
              minSubstance: 0,
              noGroup: true,
            }).eligible,
          ),
          output: out,
          injectedRunner: deps.runner,
          runners: deps.runners,
          io: deps.io,
          sleep: deps.sleep,
        }),
      // The line above already says what this is; plain mode adds none.
      { plainLine: false },
    );
  } catch (error) {
    write(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    stopEarlyInterrupt();
  }
  write();

  let code: number;
  try {
    code = await distillSelectedSessions({
      home,
      args,
      explicitArgs,
      deps,
      session,
      plan,
      eligible: everything.digests,
      quickStart: quickStartHint,
      clusterBatchSize,
      budget,
      truncate,
      timeoutMs,
      mute: quiet.mute,
    });
  } finally {
    await session.finalize();
  }
  if (
    code === 0 &&
    !args["dry-run"] &&
    (readLibrary(home).length || readObservedPreferences(home).length)
  ) {
    // The closing menu has its own outcome: Ctrl-C there is 130, and a
    // follow-up command that fails keeps its own code.
    const next = await offerLibraryNext(
      { ...args, quality: session.quality },
      { input: deps.input, output: out, host: deps.host },
    );
    if (next !== 0) return next;
  }
  return code;
}

/**
 * The exported sessions `export` recorded. A file that is not a list of them
 * is damaged: the failure names it and the command that writes it again.
 */
export function parseManifest(raw: string, file: string): ManifestEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw damagedFile(file, "not valid JSON", "export");
  }
  if (!Array.isArray(parsed)) throw damagedFile(file, "not a list of sessions", "export");
  return parsed as ManifestEntry[];
}

/** What is saved when Ctrl-C lands in each step of a distill run. */
const SAVED_AT = {
  start: "No session was read yet.",
  reading: "Sessions read so far are saved; the rest are read next time.",
  grouping: "The session reads are saved; grouping starts again next time.",
  writing: "Prompts written so far are saved; the rest are written next time.",
  preferences: "Your prompts are saved, and so are the preference batches that finished.",
} as const;

/**
 * Prompts the person edited, which this run kept as they are: one plain line,
 * or undefined when there are none. More than three names are listed only
 * under `--verbose`.
 */
export function keptLine(names: string[], verbose = false): string | undefined {
  if (!names.length) return undefined;
  const one = names.length === 1;
  const listed = names.length <= 3 || verbose ? `: ${names.join(", ")}` : "";
  return `Kept ${counted(names.length, "prompt")} you edited, as you wrote ${one ? "it" : "them"}${listed}. To replace ${one ? "it" : "them"} with the new version, run distill again with --force.`;
}

/**
 * The closing library sentence. Each prompt is counted once, under what
 * happened to it in this run (written, already up to date, kept because the
 * person edited it), and the groups that reached no result are counted
 * after them; only the parts that are not zero are said.
 */
export function librarySentence(result: {
  authored: unknown[];
  resumed: unknown[];
  kept: unknown[];
  skipped: unknown[];
}): string {
  const written = result.authored.length;
  const upToDate = result.resumed.length;
  const kept = result.kept.length;
  const skipped = result.skipped.length;
  if (upToDate && !written && !kept && !skipped)
    return upToDate === 1
      ? "Library: the prompt was already up to date."
      : `Library: all ${upToDate.toLocaleString("en-US")} prompts were already up to date.`;
  const prompts: [number, string][] = [
    [written, "written"],
    [upToDate, "already up to date"],
    [kept, "kept (edited by you)"],
  ];
  const parts: string[] = [];
  for (const [n, what] of prompts) {
    if (!n) continue;
    // The noun goes with the first count only: "3 prompts written, 1 kept".
    parts.push(
      parts.length ? `${n.toLocaleString("en-US")} ${what}` : `${counted(n, "prompt")} ${what}`,
    );
  }
  if (skipped)
    parts.push(
      `${counted(skipped, "group")} skipped because every session in ${skipped === 1 ? "it" : "them"} was abandoned`,
    );
  return `Library: ${parts.length ? parts.join(", ") : "0 prompts written"}.`;
}

/**
 * Prompts written or reused in this run whose outcome nobody saw: one line,
 * or nothing when there are none. The words match what `list` and `show` say.
 */
export function unverifiedLine(n: number): string | undefined {
  if (n <= 0) return undefined;
  return n === 1
    ? `1 prompt is marked ${OUTCOME_NOT_VERIFIED}: none of its sessions was seen to reach a result.`
    : `${n.toLocaleString("en-US")} prompts are marked ${OUTCOME_NOT_VERIFIED}: none of their sessions was seen to reach a result.`;
}

/**
 * The working preferences line after a run: how many were summarized, or how
 * far a run that stopped part way got, or that none could be summarized.
 */
export function preferencesLine(result: GeneralizeResult, inputs: number): string {
  if (result.status === "done")
    return `Working preferences: ${counted(inputs, "preference")} summarized into ${counted(result.lessons, "working agreement")}${result.reused ? ` (${counted(result.reused, "batch", "batches")} reused)` : ""}.`;
  const gap = result.artifact ? generalizedGap(result.artifact) : undefined;
  if (gap)
    return `Working preferences: ${gap.summarized.toLocaleString("en-US")} of ${counted(gap.total, "preference")} summarized; run distill again to finish (finished work is reused).`;
  const first = result.errors[0] ? ` (${result.errors[0]})` : "";
  return `Working preferences could not be summarized this time${first}. Your prompts are saved; run distill again to finish them.`;
}

/**
 * The grouping result in one line: "Grouped 6 sessions into 3 prompts; 1 did
 * not fit a group." Which sessions went where is shown under `--verbose`.
 */
export function groupingLine(o: {
  sessions: number;
  groups: number;
  misc: number;
  noGroup: boolean;
  reused: boolean;
}): string {
  if (o.noGroup) return `One prompt per session: ${counted(o.groups, "prompt")}.`;
  const misc = o.misc ? `; ${o.misc.toLocaleString("en-US")} did not fit a group` : "";
  const reused = o.reused ? " (saved grouping reused)" : "";
  return `Grouped ${counted(o.sessions, "session")} into ${counted(o.groups, "prompt")}${misc}${reused}.`;
}

/**
 * Ctrl-C while the CLIs are being checked: nothing was sent yet, so say so
 * and exit 130. Questions and menus answer Ctrl-C themselves and are not
 * covered by this.
 */
function interruptBeforeConsent(out: Writable, deps: DistillDeps): () => void {
  const host = deps.host ?? (process as unknown as TerminalHost);
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const interrupt = () => {
    out.write(`\nInterrupted. ${NOTHING_SENT}\n`, () => exit(130));
  };
  host.once("SIGINT", interrupt);
  return () => host.off("SIGINT", interrupt);
}

async function distillSelectedSessions(opts: {
  home: string;
  args: DistillArgs;
  explicitArgs: DistillArgs;
  deps: DistillDeps;
  session: RunSession;
  plan: ComputedPlan;
  /** Eligible sessions before `--recent`. */
  eligible: number;
  quickStart?: number;
  clusterBatchSize?: number;
  budget: number;
  truncate: TruncatePolicy;
  timeoutMs?: number;
  /** Silence this run's output after Ctrl-C has printed its line. */
  mute?: () => void;
}): Promise<number> {
  const {
    home,
    args,
    explicitArgs,
    deps,
    session,
    plan,
    clusterBatchSize,
    budget,
    truncate,
    timeoutMs,
  } = opts;
  const out = deps.output ?? process.stdout;
  const write = (line = "") => out.write(`${line}\n`);
  // Long lines wrap at word boundaries; a command stays whole on its own line.
  const width = screenWidth(out);
  const say = (text: string, indent = "") => {
    for (const line of wrapText(text, width, { indent })) write(line);
  };
  const failure = (text: string) => {
    const [first = "", ...rest] = wrapText(text, width - 4, { indent: "" });
    write(`  ${fail(first)}`);
    for (const line of rest) write(`    ${line}`);
  };
  const command = (lead: string, text: string) => {
    for (const line of sayThenRun(lead, text, width)) write(line);
  };
  const now = deps.now ?? Date.now;
  const progressOptions = { now, verbose: args.verbose === true };
  const bullet = dim(glyph("•", "-"));
  const noGroup = args.group === false;
  const concurrency = parseConcurrency(args.concurrency);
  // The readiness check runs before the first real model call of the run and
  // never when nothing needs one. Every stage call goes through this gate.
  // A failed check prints its line once; the calls it stops fail with its
  // first sentence ("Claude Code is not signed in.").
  const gate: { result?: Promise<{ ok: true; line?: string } | { ok: false; line: string }> } = {};
  // Exactly the stages this run can call, so no model is checked that is never used.
  const stages: StageKey[] = [
    "digest",
    ...(noGroup ? [] : (["cluster"] as const)),
    "author",
    ...(args.generalize === false ? [] : (["generalize"] as const)),
  ];
  const ready = () =>
    (gate.result ??= session.liveCheck(stages).then((checked) => {
      if (!checked.ok) write(checked.line);
      return checked;
    }));
  const gatedRun: RunnerFn = async (options) => {
    const checked = await ready();
    if (!checked.ok) throw new Error(checked.line.split("\n")[0]);
    return session.run(options);
  };
  const common = {
    home,
    runner: gatedRun,
    get runnerName() {
      return session.ledgerRunner;
    },
    identityRunner: session.identityRunner,
    output: out,
    budget,
    timeoutMs,
  };

  // Consent-time (pre-spend) overflow estimate.
  const oversized = await withSpinner(
    out,
    "Checking session sizes",
    async () => computeOversized(home, plan.eligible, budget),
    { plainLine: false },
  );

  // Default (--truncate=never): refuse BEFORE spending anything if any session
  // exceeds the budget. Nothing is ever cut silently. the user chooses a flag.
  // (Dry-run still previews the plan below and notes the would-be block.)
  if (!args["dry-run"] && truncate === "never" && oversized.length > 0) {
    write();
    say(
      `${counted(oversized.length, "session is", "sessions are")} longer than the size limit per call of ${budget.toLocaleString("en-US")} characters, so nothing was sent:`,
    );
    for (const o of oversized) {
      write(
        `  ${skip(`${cyan(o.export)} ${dim(`(${o.chars.toLocaleString("en-US")} characters)`)}`)}`,
      );
    }
    say(
      "To include them, run again with --truncate=extreme to shorten them to fit, raise --input-budget, or narrow the scope with --project or --min-substance.",
    );
    return 1;
  }

  // --fresh intent is confirmed up front, but the checkpoints are NOT deleted
  // until the MAIN consent gate and the readiness check also pass: declining
  // after confirming --fresh must not have already destroyed paid progress
  // while running nothing. Dry-run never clears anything.
  let freshConfirmed = false;
  if (args.fresh && !args["dry-run"]) {
    const answer = args.yes
      ? "yes"
      : await askYesNoAnswer(
          wrapText(
            "--fresh discards saved session reads and grouping before rebuilding. Continue?",
            screenWidth(out) - 6,
          ).join("\n"),
          { input: deps.input, output: out, host: deps.host },
        );
    if (answer === "interrupt") {
      write(`Interrupted. ${NOTHING_SENT}`);
      return 130;
    }
    freshConfirmed = answer === "yes";
    if (!freshConfirmed) {
      write(`Declined. Saved work is kept. ${NOTHING_SENT}`);
      return 2;
    }
  }

  // Both reuse counts are computed before the screen is shown, so the numbers
  // on screen are right whichever plan is picked.
  const description = session.describe();
  const selectedQuality = session.quality;
  const choices = {} as NonNullable<DistillPlan["choices"]>;
  const reusedBy = {} as Record<Quality, Set<string>>;
  for (const quality of ["balanced", "best"] as const) {
    session.quality = quality;
    const { reused, ...reuse } = planDigestReuse({
      ...common,
      entries: plan.eligible,
      model: session.modelFor("digest"),
      truncate,
      fresh: args.fresh,
    });
    reusedBy[quality] = new Set(reused);
    choices[quality] = {
      ...reuse,
      digest: session.displayModelFor("digest"),
      cluster: session.displayModelFor("cluster"),
      author: session.displayModelFor("author"),
      generalize: session.displayModelFor("generalize"),
      notes: description.plans[quality].notes,
    };
  }
  session.quality = selectedQuality;
  const distillPlan: DistillPlan = {
    sessions: plan.digests,
    eligible: opts.eligible,
    recent: args.recent !== undefined ? Number(args.recent) : undefined,
    quickStart: opts.quickStart,
    library: readLibrary(home).length,
    qualityFixed: Boolean(args.quality),
    digests: plan.digests - choices[selectedQuality].reusable,
    cluster: plan.cluster,
    clusterWindowsEstimate: plan.clusterWindowsEstimate,
    clusterMergeEstimate: plan.clusterMergeEstimate,
    authorEstimate: plan.authorEstimate,
    runnerName: session.ledgerRunner,
    session: description,
    quality: selectedQuality,
    choices,
    generalize: args.generalize !== false,
    grouping: !noGroup,
    concurrency,
    force: args.force,
    model: session.displayModelFor("digest"),
    clusterModel: noGroup ? undefined : session.displayModelFor("cluster"),
    authorModel: session.displayModelFor("author"),
    budget,
    truncate,
    oversized,
    // What is being approved, quick start included: `args` holds the choices of this run.
    fullPlan: `${nextCommandText("distill", { ...args, home })} --dry-run`,
  };

  const decision = await (deps.confirm ?? confirmPlan)(distillPlan, {
    yes: Boolean(args.yes),
    dryRun: Boolean(args["dry-run"]),
    input: deps.input,
    output: out,
    host: deps.host,
    onQuality: (quality: Quality) => {
      session.quality = quality;
    },
  });

  if (decision === "dry-run") {
    // Only the sessions this plan would really read; the rest are reused.
    const reused = reusedBy[session.quality];
    const toRead = plan.eligible.filter((e) => !reused.has(e.export));
    write();
    if (toRead.length) {
      write("Sessions that would be read:");
      for (const e of toRead) {
        write(`  ${bullet} ${cyan(e.export)} ${dim(`(${counted(e.messages ?? 0, "message")})`)}`);
      }
      if (reused.size)
        say(
          `The other ${counted(reused.size, "session is", "sessions are")} reused from saved work.`,
        );
    } else {
      say(
        `No session needs reading again; ${counted(reused.size, "session is", "sessions are")} reused from saved work.`,
      );
    }
    write();
    say(`${NOTHING_SENT} Run the same command without --dry-run to start.`);
    return 0;
  }
  // The question printed its one line for Ctrl-C; nothing was sent.
  if (decision === "interrupted") return 130;
  if (decision === "declined") {
    write(`Declined. ${NOTHING_SENT}`);
    return 2;
  }

  // The quality chosen on the plan screen is part of what to continue with.
  const resume = nextCommandText("distill", { ...args, home, quality: session.quality });
  // What Ctrl-C can truthfully say is saved depends on the step it lands in.
  let phase: keyof typeof SAVED_AT = "start";
  // All writers share this lock; preview and declined consent never create it.
  // Ctrl-C releases it, ends the calls in flight, says what is saved, gives
  // the runners a bounded moment to clean up, and exits 130. The ledger and
  // every saved result stay as a crash would leave them; the next run reuses them.
  const guard = guardRun({
    home,
    command: "distill",
    output: out,
    resume,
    saved: () => SAVED_AT[phase],
    interrupt: () => session.interrupt(),
    cleanup: () => session.finalize(),
    mute: opts.mute,
    host: deps.host,
    exit: deps.exit,
    ...(deps.sleep
      ? { timer: (ms: number, fire: () => void) => void deps.sleep?.(ms).then(fire) }
      : {}),
  });
  if ("busy" in guard) {
    write(guard.busy);
    return 1;
  }
  const startedAt = now();
  try {
    // Sessions to read, or saved work to discard, mean a call is certain: check
    // now, so a CLI that is not ready stops the run before any stage starts.
    // Otherwise the gate checks before the first call a stage turns out to need.
    if (freshConfirmed || distillPlan.digests > 0) {
      if (!(await ready()).ok) return 1;
    }
    // An unconfirmed check (`line`) was already printed by the session.
    // Both gates passed. Only now is it safe to clear checkpoints.
    if (freshConfirmed) {
      clearCheckpoints(home);
      write("Saved work cleared.");
    }

    // Stage 1: read each session.
    phase = "reading";
    write();
    const digestProgress = startStageProgress(out, "Reading sessions", progressOptions);
    const digestResult = await runDigestStage({
      ...common,
      entries: plan.eligible,
      model: session.modelFor("digest"),
      progress: digestProgress,
      truncate,
      concurrency,
      // citty maps `--no-breaker` to breaker: false; on by default.
      breaker: args.breaker !== false,
    }).finally(() => digestProgress.end());

    const doneTotal = digestResult.completed + digestResult.skipped;
    const digestSummary =
      `Read ${doneTotal.toLocaleString("en-US")} of ${counted(plan.digests, "session")}` +
      (digestResult.skipped
        ? ` (${digestResult.skipped.toLocaleString("en-US")} reused from saved work)`
        : "") +
      (digestResult.failed.length ? `, ${digestResult.failed.length} failed` : "") +
      // Say the count is short BECAUSE the stage stopped early, so "0 of 92"
      // is never mistaken for "92 sessions were each tried and failed".
      (digestResult.aborted
        ? `, ${digestResult.notAttempted.length} not attempted because the stage stopped`
        : "") +
      ".";
    write(digestResult.failed.length ? digestSummary : green(digestSummary));

    if (digestResult.failed.length > 0) {
      write();
      write("Sessions that could not be read (everything else is saved):");
      for (const f of digestResult.failed) failure(`${f.export}: ${f.error}`);
      command(
        "To try only these again, run:",
        retryCommandText("digest", { ...explicitArgs, home }),
      );
      // Do NOT abort here. A reproducibly-failing session must not block the
      // whole pipeline forever. proceed to cluster/author with the digests that
      // DID succeed (the cluster input already tolerates absent digests), and
      // exit non-zero at the very end, after the useful work is done.
    }

    if (digestResult.blocked.length > 0) {
      write();
      say(
        `${counted(digestResult.blocked.length, "session was", "sessions were")} skipped for being longer than the size limit per call of ${budget.toLocaleString("en-US")} characters:`,
      );
      for (const b of digestResult.blocked) {
        write(`  ${skip(`${b.export}: ${b.chars.toLocaleString("en-US")} characters`)}`);
      }
      say("Run again with --truncate=extreme to shorten them, or raise --input-budget.", "  ");
    }

    // Stage 2: grouping. The input is the saved reads for the CURRENT eligible
    // set (sessions whose read failed are simply absent).
    const digestCheckpoint = loadDigests(home);
    const digestsForCluster: Record<string, Digest> = {};
    const unavailable = new Set([
      ...digestResult.notAttempted,
      ...digestResult.failed.map((entry) => entry.export),
      ...digestResult.blocked.map((entry) => entry.export),
    ]);
    for (const e of plan.eligible) {
      if (unavailable.has(e.export)) continue;
      const digest = digestCheckpoint?.digests[e.export];
      if (digest) digestsForCluster[e.export] = digest;
    }

    if (Object.keys(digestsForCluster).length === 0) {
      write();
      write("No session could be read, so there is nothing to group.");
      return 1;
    }

    // Track whether ANY failure occurred so the command exits non-zero after
    // completing the reachable work. Blocked-by-budget sessions count too.
    let hadFailure = digestResult.failed.length > 0 || digestResult.blocked.length > 0;

    write();
    let stage: "cluster" | "author" = "cluster";
    phase = "grouping";
    try {
      // Backend per export (absent means claude): names the corpus in the
      // grouping prompt (named single-source, neutral for merged corpora).
      const clusterOrigins: Record<string, SourceName> = {};
      for (const e of plan.eligible) clusterOrigins[e.export] = e.origin ?? "claude";
      const clusterProgress = startStageProgress(
        out,
        noGroup ? "Preparing one task per session" : "Grouping sessions",
        progressOptions,
      );
      const clusterResult = await runClusterStage({
        ...common,
        digests: digestsForCluster,
        origins: clusterOrigins,
        generation: digestResult.generation,
        noGroup,
        model: session.modelFor("cluster"),
        batchSize: clusterBatchSize,
        progress: clusterProgress,
      }).finally(() => clusterProgress.end());
      write(
        groupingLine({
          sessions: Object.keys(digestsForCluster).length,
          groups: clusterResult.tasks.length,
          misc: clusterResult.misc.length,
          noGroup,
          reused: clusterResult.resumed,
        }),
      );
      if (args.verbose)
        for (const t of clusterResult.tasks)
          write(`  ${bullet} ${t.slug} (${counted(t.members.length, "session")})`);

      stage = "author";
      phase = "writing";
      // The library checkpoints each successfully written prompt.
      write();
      const authorProgress = startStageProgress(out, "Writing prompts", progressOptions);
      const authorResult = await runAuthorStage({
        ...common,
        tasks: clusterResult.tasks,
        digests: digestsForCluster,
        entries: plan.eligible,
        generation: digestResult.generation,
        toolVersion: pkg.version,
        model: session.modelFor("author"),
        progress: authorProgress,
        breaker: args.breaker !== false,
        truncate,
        force: args.force === true,
        concurrency,
      }).finally(() => authorProgress.end());

      write();
      // Wrapped like every sentence around it; each line keeps the color.
      for (const line of wrapText(librarySentence(authorResult), width))
        write(authorResult.authored.length > 0 ? green(line) : line);
      if (authorResult.skipped.length) {
        say(
          "A prompt is not written for work that was abandoned. Preferences from those sessions are still kept.",
        );
        if (args.verbose)
          for (const s of authorResult.skipped)
            say(`${glyph("·", "-")} ${s.slug}: ${s.reason}`, "  ");
      }
      const unverified = unverifiedLine(authorResult.unverified.length);
      if (unverified) say(unverified);
      const keptNames = authorResult.kept.map((task) => task.slug);
      const kept = keptLine(keptNames, args.verbose === true);
      if (kept) say(kept);

      if (authorResult.failed.length > 0) {
        write();
        write("Prompts that could not be written (the others are saved):");
        for (const f of authorResult.failed) failure(`${f.export}: ${f.error}`);
        command(
          "To try only these again, run:",
          retryCommandText("author", { ...explicitArgs, home }),
        );
        hadFailure = true;
      }

      if (authorResult.notAttempted.length) {
        hadFailure = true;
        say(
          `${counted(authorResult.notAttempted.length, "remaining prompt was", "remaining prompts were")} not attempted. Run distill again to continue.`,
        );
      }
    } catch (err) {
      failure((err as Error).message);
      command(
        `Saved progress is kept. To try the ${stage === "cluster" ? "grouping" : "prompt writing"} again, run:`,
        retryCommandText(stage, { ...explicitArgs, home }),
      );
      hadFailure = true;
    }

    // Working preferences come last. A failure here never fails the library.
    if (args.generalize !== false) {
      phase = "preferences";
      const progress = startStageProgress(out, "Summarizing working preferences", progressOptions);
      try {
        const model = session.modelFor("generalize");
        const preferences = planGeneralize({
          home,
          budget,
          model,
          identityRunner: session.identityRunner,
          selection: "all-candidates",
        });
        if (preferences?.damaged)
          say("Your saved working agreements could not be read and will be rebuilt.");
        if (preferences) {
          const result = await runGeneralizeStage({
            home,
            plan: preferences,
            runner: gatedRun,
            model,
            concurrency,
            timeoutMs,
            output: out,
            progress,
          });
          progress.end();
          say(preferencesLine(result, preferences.inputs.length));
        } else {
          write("No working preferences to summarize yet.");
        }
      } catch (error) {
        progress.end();
        say(
          `Working preferences could not be summarized this time (${error instanceof Error ? error.message : String(error)}). Your prompts are saved; run distill again to finish them.`,
        );
      } finally {
        progress.end();
      }
    }
    // One story about the preferences, the same sentence `status` and
    // `preferences` print, with the review command alone on its own line.
    for (const line of fitLines(preferenceStoryLines(home, { ...args, home }), width)) write(line);
    // Earlier prompts outside the new grouping are kept (they may be edited or
    // rated); say how many, and the command that removes them.
    const grouping = loadTasks(home);
    const behind = grouping ? leftBehindEntries(readLibrary(home), grouping).length : 0;
    if (behind > 0) {
      command(
        `${counted(behind, "earlier prompt is", "earlier prompts are")} no longer part of the grouping. ${behind === 1 ? "It is" : "They are"} kept; remove ${behind === 1 ? "it" : "them"} with:`,
        ["human-hindsight", "prune", ...printedHome(home)].map(shellWord).join(" "),
      );
    }
    // A check that ran and failed inside a stage fails the run like an early one.
    const checked = gate.result ? await gate.result : undefined;
    if (checked && !checked.ok) hadFailure = true;
    if (!checked && !hadFailure)
      say("Everything was already up to date, so no model call was needed.");
    const elapsed = Math.floor((now() - startedAt) / 1000);
    write(
      `${hadFailure ? "Finished with failures" : "Done"} in ${Math.floor(elapsed / 60)}m ${elapsed % 60}s. Library: ${path.join(home, "library")}`,
    );
    return hadFailure ? 1 : 0;
  } finally {
    guard.end();
    for (const line of session.summaryLines()) write(line);
  }
}

export default defineCommand({
  meta: {
    name: "distill",
    description: "Build a prompt library from your exported sessions (shows the plan first)",
  },
  args: {
    ...sharedArgs,
    project: {
      type: "string",
      valueHint: "name",
      description: "Only distill sessions from this project",
    },
    group: {
      type: "boolean",
      description: "Group sessions into tasks (use --no-group for one prompt per session)",
    },
    breaker: {
      type: "boolean",
      default: true,
      description:
        "Stop a parallel stage after 5 consecutive identical failures (use --no-breaker to attempt every session)",
    },
    generalize: {
      type: "boolean",
      default: true,
      description:
        "Summarize working preferences after writing prompts (skip with --no-generalize)",
    },
    "min-substance": {
      type: "string",
      valueHint: "n",
      description: "Minimum human messages for a session to be eligible",
    },
    model: {
      type: "string",
      valueHint: "name",
      description: "Model for every step, as your CLI names it",
    },
    "cluster-model": {
      type: "string",
      valueHint: "name",
      description: "Model for grouping sessions only (defaults to --model)",
    },
    "author-model": {
      type: "string",
      valueHint: "name",
      description: "Model for writing prompts only (defaults to --model)",
    },
    "cluster-batch-size": {
      type: "string",
      valueHint: "n",
      description: "Maximum sessions per grouping call (positive integer; not with --retry-failed)",
    },
    runner: {
      type: "string",
      valueHint: "cli",
      description:
        "Which local CLI distills: claude, codex, kiro, opencode, or auto (default: auto)",
    },
    fresh: {
      type: "boolean",
      description: "Discard saved session reads and grouping, then rebuild",
    },
    "dry-run": { type: "boolean", description: "Print the plan and exit; nothing is sent" },
    yes: { type: "boolean", description: "Approve the plan without asking (for scripting)" },
    "input-budget": {
      type: "string",
      valueHint: "characters",
      description: "Max characters of session content per call (default 400000)",
    },
    truncate: {
      type: "string",
      valueHint: "never|extreme",
      description:
        "Sessions over the size limit per call: never (default, skip and report) or extreme (shorten to fit)",
    },
    timeout: {
      type: "string",
      valueHint: "seconds",
      description: "Per-call timeout in seconds (default 900; calls over many sessions scale)",
    },
    concurrency: {
      type: "string",
      valueHint: "n",
      description:
        "Session reads, prompt writes, and preference summaries run in parallel (default 10)",
    },
    force: {
      type: "boolean",
      description: "Rewrite prompts you edited by hand (default: keep your edits)",
    },
    "retry-failed": {
      type: "boolean",
      description:
        "Retry only the calls that failed; keep the saved grouping and every finished result",
    },
    "retry-stage": {
      type: "string",
      valueHint: "all|digest|cluster|author",
      description:
        "Retry one step only: digest (reading sessions), cluster (grouping), author (writing), or all (default)",
    },
    "recover-tasks": {
      type: "string",
      valueHint: "names",
      description: "Explicitly recover named saved tasks from older runs (comma-separated names)",
    },
    verbose: {
      type: "boolean",
      description: "Show which sessions and prompts are being worked on, and per-item detail",
    },
  },
  async run({ args }) {
    // --yes answers the requested pipeline's consent gate. Optional
    // consolidation and clipboard work remain separately requested actions.
    const code = await runDistill(args as unknown as DistillArgs);
    if (code !== 0) process.exitCode = code;
  },
});
