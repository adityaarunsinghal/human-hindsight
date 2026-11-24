import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { DEFAULT_CONCURRENCY } from "../core/budget.js";
import type { Quality } from "../core/model-plan.js";
import type { SessionDescription } from "../core/run-session.js";
import { RUNNER_INFO } from "../runners/capabilities.js";
import type { RunnerName } from "../runners/types.js";
import { persistLiveRegion, type TerminalHost } from "../ui/live.js";
import {
  canColor,
  canPrompt,
  glyph,
  type PromptIo,
  type TerminalOutput,
  terminalWidth,
} from "../ui/mode.js";
import { readLine } from "../ui/prompt.js";
import { askStart, START_HINT, type StartQuestion, startTakesKeys } from "../ui/start.js";
import {
  bold,
  choicePill,
  counted,
  cyan,
  dim,
  palette,
  visibleWidth,
  yellow,
} from "../ui/style.js";
import { sayThenRun, wrapText } from "../ui/wrap.js";
import { DEFAULT_WINDOW_SIZE } from "./generalize.js";

/** Model operations are disclosed before any provider call, including the readiness check. */
/** The invocation plan disclosed to the user. */
export interface DistillPlan {
  /** Number of per-session digest calls. */
  digests: number;
  /** Estimated clustering calls, including a merge when multiple windows are expected. */
  cluster: number;
  /** Count-based estimates when the user explicitly limits clustering batch size. */
  clusterWindowsEstimate?: number;
  clusterMergeEstimate?: number;
  /** Estimated authoring calls (one per task; exact count known post-cluster). */
  authorEstimate: number;
  runnerName?: RunnerName;
  session?: SessionDescription;
  quality?: Quality;
  concurrency?: number;
  sessions?: number;
  projects?: number;
  /** Eligible sessions before `--recent` narrowed them. */
  eligible?: number;
  /** The `--recent` count in effect, if any. */
  recent?: number;
  /** A large history run without a menu: the `--recent` value to suggest. */
  quickStart?: number;
  /** Prompts already in the library. */
  library?: number;
  /** The plan was fixed by `--quality` or its environment variable, so no choice is offered. */
  qualityFixed?: boolean;
  generalize?: boolean;
  /** False with `--no-group`: no grouping call is made, so its model is not checked either. */
  grouping?: boolean;
  /** Costs and concrete models for each choice, computed against its own cache identity. */
  choices?: Record<
    Quality,
    {
      digest: string;
      cluster: string;
      author: string;
      generalize: string;
      reusable: number;
      regenerating: number;
      /** Notes about this plan's models, when they need one. */
      notes?: string[];
    }
  >;
  force?: boolean;
  /** Normal model selection for digest and author; clustering uses it as the fallback. */
  model?: string;
  /** Optional override for clustering windows and their merge. */
  clusterModel?: string;
  /** Optional override for the author stage. */
  authorModel?: string;
  /** Optional resume line shown when checkpoints already exist. */
  resumeNote?: string;
  /** Input budget in chars: when set, a coverage disclosure line is shown. */
  budget?: number;
  /** Overflow policy in effect. */
  truncate?: "never" | "extreme";
  /** Eligible sessions whose content exceeds the budget (consent-time estimate). */
  oversized?: { export: string; chars: number }[];
  /** Exact immutable strict-retry selection; counts are logical operations. */
  retry?: {
    mode: "retry-failed" | "recover-tasks";
    sessions?: SessionDescription[];
    operations: {
      kind: string;
      unitId: string;
      runner: string;
      model: string | null;
      timeoutMs: number;
      budget: number;
      truncate: string;
    }[];
    repairs: { kind: string; unitId: string }[];
    excluded: { kind: string; unitId: string; reason: string }[];
    blocked: { kind: string; unitId: string; reason: string }[];
  };
  /**
   * `suggest-subagents`: its own disclosure block. The distill counts above are
   * zero when this is set. Author calls are a range because the role count is
   * known only after propose.
   */
  subagents?: SubagentsPlan;
  /** The command that prints this whole plan without starting, for the short form. */
  fullPlan?: string;
  consolidation?: { inputs: number; models: Record<Quality, string> };
}

/** One plan's models and preference batches on the subagent plan screen. */
export interface SubagentsChoice {
  /** The model that summarizes preferences, by real name ("CLI default" for none). */
  summarize: string;
  /** The model that chooses roles. */
  choose: string;
  /** The model that writes role prompts. */
  write: string;
  /** Preference batches in this plan, and how many are reused from saved work. */
  batches: number;
  reused: number;
  notes?: string[];
}

/** The `suggest-subagents` plan disclosed before consent. */
export interface SubagentsPlan {
  /** Preference candidates the run reads. */
  inputs: number;
  /** How many of them the person accepted. */
  accepted: number;
  /** `accepted`: only accepted ones; `all-candidates`: every one not dismissed. */
  selection: "accepted" | "all-candidates";
  /** Every candidate was asked for with `--include-unreviewed`. */
  includeUnreviewed?: boolean;
  /** Candidates before accepted preferences narrowed the set, when narrower. */
  candidates?: number;
  minRoles: number;
  maxRoles: number;
  /** Per plan, computed against its own saved work. */
  choices: Record<Quality, SubagentsChoice>;
  /** `--author-only`: the saved roles still without a prompt, out of all saved roles. */
  authorOnly?: { names: string[]; roles: number };
}

/** A count with thousands separators, as everywhere else on screen. */
const count = (n: number): string => n.toLocaleString("en-US");

/** Up to three of the sessions left out for their size, by export name. */
function leftOutNames(sessions: { export: string; chars: number }[]): string {
  const shown = sessions
    .slice(0, 3)
    .map((entry) => `${entry.export} (${count(entry.chars)} characters)`);
  const more = sessions.length - shown.length;
  return more > 0 ? `${shown.join(", ")}, and ${count(more)} more` : shown.join(", ");
}

/** Human-facing CLI name + the cost noun, per runner (for consent copy). */
function runnerCopy(name: DistillPlan["runnerName"]): { cli: string; cost: string } {
  return name === "kiro"
    ? { cli: "kiro-cli", cost: "your Kiro credits" }
    : name === "opencode"
      ? { cli: "opencode", cost: "your configured provider account" }
      : { cli: name ?? "claude", cost: "your subscription/credits" };
}

export interface ConsentOptions {
  /** Skip the prompt and proceed (still prints the plan). */
  yes?: boolean;
  /** Enables the quality choice on the distill approval prompt. */
  onQuality?(quality: Quality): void;
  /** `reflect` provides the CLIs discovered for this command. Selecting one uses its own model and reuse plan. */
  runners?: readonly { name: RunnerName; select(): DistillPlan }[];
  /** Print the plan and exit without prompting or invoking anything. */
  dryRun?: boolean;
  /** Injected input stream (default process.stdin). */
  input?: Readable;
  /** Injected output stream (default process.stdout). */
  output?: Writable;
  /** Where Ctrl-C arrives (default `process`). Tests pass a fake. */
  host?: TerminalHost;
}

export type ConsentResult = "proceed" | "declined" | "dry-run";

function renderRunnerDisclosure(session: SessionDescription): string[] {
  const lines = [`  Runs on  ${session.runnerLine}`];
  if (session.alsoReady.length) {
    lines.push(`           Also ready if needed: ${session.alsoReady.join(", ")}`);
  }
  if (session.pinned) lines.push("           This run stays on this CLI.");
  return lines;
}

const qualityName = (value: Quality) => (value === "balanced" ? "Balanced" : "Best");

/** The left column of the distill plan screen. */
const LABEL_WIDTH = 9;

/**
 * Word-wrap one labeled row to the width, with a hanging indent so every
 * continuation line starts under the text. Color is added by the caller to
 * whole lines, so wrapping never splits an escape sequence.
 */
function wrapRow(label: string, text: string, width: number, indent = 0): string[] {
  const lead = `  ${label.padEnd(LABEL_WIDTH)}${" ".repeat(indent)}`;
  // The text keeps at least 20 columns, however narrow the terminal.
  return wrapText(text, Math.max(lead.length + 20, width), {
    indent: lead,
    hang: " ".repeat(lead.length),
  }).map((line) => line.replace(/\s+$/, ""));
}

/** The width to wrap printed lines to: the terminal's, or 80 without one. */
export function screenWidth(output: Writable): number {
  const terminal: TerminalOutput = output;
  return terminal.isTTY ? terminalWidth(terminal) : 80;
}

type Choice = NonNullable<DistillPlan["choices"]>[Quality];

/** "sonnet for session reads, opus for grouping and writing", or one model named once. */
function stageModels(plan: DistillPlan, choice: Choice): string {
  const name = (model: string) => (model === "CLI default" ? "the CLI's default model" : model);
  const grouping = plan.cluster > 0;
  const used = [choice.digest, choice.author, ...(grouping ? [choice.cluster] : [])];
  if (plan.generalize) used.push(choice.generalize);
  if (used.every((model) => model === choice.digest))
    return `${name(choice.digest)} for every step`;
  const parts = [`${name(choice.digest)} for session reads`];
  if (grouping && choice.cluster === choice.author)
    parts.push(`${name(choice.author)} for grouping and writing`);
  else {
    if (grouping) parts.push(`${name(choice.cluster)} for grouping`);
    parts.push(`${name(choice.author)} for writing`);
  }
  if (plan.generalize && choice.generalize !== choice.digest)
    parts.push(`${name(choice.generalize)} for preference summaries`);
  return parts.join(", ");
}

/** Balanced and Best are offered only when they differ and the person did not fix one. */
function offersChoice(plan: DistillPlan): boolean {
  return Boolean(
    (plan.choices || plan.subagents) && plan.session?.qualityChoice !== false && !plan.qualityFixed,
  );
}

/** The CLI's name without its version: "Claude Code (claude 2.1)" reads "Claude Code". */
const cliName = (session: SessionDescription) => session.runnerLine.replace(/ \(.*\)$/, "");

/**
 * How many calls run at once: the stage's number, or the CLI's own lower
 * limit when it declares one (OpenCode takes 2 at a time).
 */
function pace(concurrency: number, session: SessionDescription): string {
  const limit = session.maxConcurrency;
  return limit !== undefined && limit < concurrency
    ? `Up to ${count(limit)} at a time (${cliName(session)}'s limit)`
    : `Up to ${count(concurrency)} at a time`;
}

/** One labeled row of a plan screen; an empty label continues the row above. */
interface Row {
  label: string;
  text: string;
  /** Extra indent under the label, for notes that belong to the line above. */
  indent?: number;
}

/**
 * Every plan screen has one layout: a bold title, then labeled rows (Reads,
 * Runs on, Calls, Models, Library, Sending) wrapped to the terminal's width
 * with the text under the text. Distill and suggest-subagents build their rows
 * and share this and the row builders below.
 */
function planScreen(title: string, rows: Row[], width: number, color: boolean): string {
  const s = palette(color);
  const lines = [s.bold(`  ${title}`), ""];
  let section = "";
  for (const row of rows) {
    if (row.label) section = row.label;
    const ink =
      section === "Models"
        ? s.yellow
        : section === "Reads"
          ? s.cyan
          : section === "Runs on"
            ? s.blue
            : section === "Sending"
              ? s.magenta
              : (line: string) => line;
    lines.push(...wrapRow(row.label, row.text, width, row.indent).map(ink));
  }
  return lines.join("\n");
}

/** Which CLI runs the plan, which others would take over, and whether it is pinned. */
function runsOnRows(session: SessionDescription): Row[] {
  const cli = cliName(session);
  const rows: Row[] = [{ label: "Runs on", text: session.runnerLine }];
  if (session.alsoReady.length)
    rows.push({
      label: "",
      text: `Also ready if needed: ${session.alsoReady.join(", ")}. If ${cli} stops working during the run, the work moves on and the screen says so.`,
    });
  if (session.pinned) rows.push({ label: "", text: "This run stays on this CLI." });
  return rows;
}

/** One plan's line on the Models row: its models, then anything that differs per plan. */
interface TierLine {
  models: string;
  extra: string[];
  notes: string[];
}

/**
 * The Models row. With a choice, one line per plan ("1  Balanced (selected):
 * ..."); without one, the selected plan's models, named only when the person
 * fixed the plan; when every step uses the CLI's own default, one sentence.
 */
function modelRows(o: {
  offer: boolean;
  quality: Quality;
  tiers: Record<Quality, TierLine>;
  allDefault: boolean;
  named: boolean;
  cli: string;
}): Row[] {
  const rows: Row[] = [];
  if (o.offer) {
    for (const tier of ["balanced", "best"] as const) {
      const line = o.tiers[tier];
      rows.push({
        label: rows.length ? "" : "Models",
        text: `${tier === "balanced" ? 1 : 2}  ${qualityName(tier)}${tier === o.quality ? " (selected)" : ""}: ${line.models}${line.extra.length ? `. ${sentence(line.extra.join(", "))}.` : ""}`,
      });
      for (const note of line.notes) rows.push({ label: "", text: note, indent: 3 });
    }
    return rows;
  }
  const selected = o.tiers[o.quality];
  const notes = [...new Set([...o.tiers.balanced.notes, ...o.tiers.best.notes])];
  if (o.allDefault) {
    rows.push({
      label: "Models",
      text: notes[0] ?? `${o.cli} uses its own default model for every step.`,
    });
    for (const note of notes.slice(1)) rows.push({ label: "", text: note });
    return rows;
  }
  rows.push({
    label: "Models",
    text: `${o.named ? `${qualityName(o.quality)}: ` : ""}${selected.models}.`,
  });
  for (const note of selected.notes) rows.push({ label: "", text: note });
  return rows;
}

const NUMBER_WORDS = ["", "one", "two", "three", "four", "five", "six"];

/**
 * How the readiness check is described: one tiny request for each distinct
 * model among the stages the run will call, as the run session sends them.
 * `models` holds that list for each plan on offer.
 */
function checkSentence(cli: string, models: readonly (readonly string[])[]): string {
  const requests = new Set(models.map((list) => new Set(list).size));
  const [n = 1] = requests;
  if (requests.size > 1) return `one tiny request for each model checks that ${cli} is ready`;
  if (n <= 1) return `one tiny request checks that ${cli} is ready`;
  return `${NUMBER_WORDS[n] ?? n} tiny requests, one for each model, check that ${cli} is ready`;
}

/** Where the text goes, and the readiness check before the first call. */
function sendingRow(session: SessionDescription, what: string, check: string, after = ""): Row {
  const moved = session.alsoReady.length ? " (or the CLI the run moves to)" : "";
  return {
    label: "Sending",
    // The calls are made on the person's own account with that provider. The
    // tool knows no prices or amounts, so it claims none.
    text: `${what} to your provider through ${cliName(session)}${moved}, the same way your normal sessions do, and the calls use your tokens there. Before the first model call, ${check}${after}.`,
  };
}

/** The text with its first letter capitalized. */
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "a, b, and c". */
function listed(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

/** A model name as the plan screen says it. */
const modelName = (model: string) => (model === "CLI default" ? "the CLI's default model" : model);

/**
 * The distill plan screen: what is read, which CLI runs it and which are ready
 * if it fails, the call counts, the pace, the models by real name, what happens
 * to an existing library, and where the text goes. No time estimate.
 */
function distillRows(plan: DistillPlan, session: SessionDescription): Row[] {
  const rows: Row[] = [];
  const row = (label: string, text: string, indent = 0) => rows.push({ label, text, indent });
  const quality = plan.quality ?? "balanced";
  const sessions = plan.sessions ?? plan.digests;
  const choices = plan.choices;
  const selected = choices?.[quality];
  const offer = offersChoice(plan);
  const cli = cliName(session);

  // What will be read.
  const scope =
    plan.recent !== undefined && plan.eligible !== undefined && plan.eligible > sessions
      ? `your ${counted(sessions, "most recent session", "most recent sessions")} (of ${count(plan.eligible)} eligible)`
      : counted(sessions, "session");
  row(
    "Reads",
    `${scope}, about ${counted(plan.authorEstimate, "prompt")}${plan.generalize ? ", plus your working preferences" : ""}.`,
  );
  if (plan.recent !== undefined && plan.eligible !== undefined && plan.eligible > sessions)
    row("", "The rest can follow in a later run, which reuses this saved work.");
  else if (plan.quickStart !== undefined)
    row(
      "",
      `To start smaller, run with --recent ${plan.quickStart}. A later full run reuses that saved work.`,
    );

  rows.push(...runsOnRows(session));

  // How many calls. Reads differ per plan when only one plan has saved reads.
  const newReads = (choice: Choice | undefined) => sessions - (choice?.reusable ?? 0);
  const sameReads = !offer || !choices || choices.balanced.reusable === choices.best.reusable;
  // A count is printed only when it is not zero.
  const readsFor = (fresh: number, reused: number) =>
    fresh > 0
      ? `${counted(fresh, "session read")}${reused ? ` (${count(reused)} more reused from saved work)` : ""}`
      : reused
        ? `no new session reads (${count(reused)} reused from saved work)`
        : "no session reads";
  const reads = sameReads
    ? readsFor(selected ? newReads(selected) : plan.digests, selected?.reusable ?? 0)
    : "session reads as listed under each plan below";
  const windows = plan.clusterWindowsEstimate;
  const grouping =
    plan.cluster === 0
      ? "no grouping"
      : `about ${counted(plan.cluster, "grouping call")}${
          windows === undefined
            ? ""
            : ` (estimated ${counted(windows, "batch", "batches")}${plan.clusterMergeEstimate ? ` and ${count(plan.clusterMergeEstimate)} merge` : ""})`
        }`;
  row("Calls", `${reads}, ${grouping}, and about ${counted(plan.authorEstimate, "writing call")}.`);
  if (plan.generalize)
    row(
      "",
      `Then summarize preferences across your saved library, up to ${DEFAULT_WINDOW_SIZE} observations per call. Finished batches are reused.`,
    );
  row(
    "",
    `${pace(plan.concurrency ?? DEFAULT_CONCURRENCY, session)}. Grouping runs one call at a time.`,
  );

  // Models, by real name.
  const regenDiffers = Boolean(
    offer && choices && choices.balanced.regenerating !== choices.best.regenerating,
  );
  if (choices) {
    const tierLine = (choice: Choice): TierLine => {
      const extra: string[] = [];
      if (!sameReads) {
        const fresh = newReads(choice);
        extra.push(
          fresh === 0
            ? `${counted(choice.reusable, "session read")} reused`
            : `${counted(fresh, "new session read")}${choice.reusable ? `, ${count(choice.reusable)} reused` : ""}`,
        );
      }
      if (regenDiffers && choice.regenerating)
        extra.push(`${counted(choice.regenerating, "earlier result")} regenerated`);
      return { models: stageModels(plan, choice), extra, notes: choice.notes ?? [] };
    };
    rows.push(
      ...modelRows({
        offer,
        quality,
        tiers: { balanced: tierLine(choices.balanced), best: tierLine(choices.best) },
        allDefault: [
          choices[quality].digest,
          choices[quality].cluster,
          choices[quality].author,
        ].every((model) => model === "CLI default"),
        named: Boolean(plan.qualityFixed && plan.session?.qualityChoice !== false),
        cli,
      }),
    );
  }

  // An existing library.
  const regenerating = regenDiffers ? 0 : (selected?.regenerating ?? 0);
  if ((plan.library ?? 0) > 0 || regenerating > 0 || regenDiffers) {
    const parts: string[] = [];
    if (plan.library) parts.push(`${counted(plan.library, "saved prompt")}.`);
    if (regenerating) parts.push(`${counted(regenerating, "earlier result")} will be regenerated.`);
    parts.push(
      plan.force
        ? "--force is on, so prompts you edited by hand may be rewritten. Ratings and reviews are kept."
        : "Hand-edited prompts, ratings, and reviews are kept.",
    );
    row("Library", parts.join(" "));
  }

  // Sessions longer than the size limit per call: shortened when asked for,
  // otherwise left out of this run, which goes on with the rest.
  if (plan.oversized?.length && plan.budget !== undefined) {
    const n = plan.oversized.length;
    const what = `${counted(n, "session is", "sessions are")} longer than the size limit per call of ${count(plan.budget)} characters`;
    row(
      "Size",
      plan.truncate === "extreme"
        ? `${what} and will be shortened to fit.`
        : `${what} and ${n === 1 ? "is" : "are"} left out of this run: ${leftOutNames(plan.oversized)}. To include ${n === 1 ? "it" : "them"}, shortened to fit, add --truncate=extreme.`,
    );
  }

  // Where the text goes. The check sends one tiny request per distinct model
  // of the stages this run calls: grouping only with grouping on, the
  // preference summary only when it runs.
  const requests = (offer && choices ? [choices.balanced, choices.best] : [selected]).map(
    (choice) =>
      choice
        ? [
            choice.digest,
            ...(plan.grouping === false ? [] : [choice.cluster]),
            choice.author,
            ...(plan.generalize ? [choice.generalize] : []),
          ]
        : [],
  );
  rows.push(
    sendingRow(
      session,
      `The selected session text${plan.generalize ? " and your working preferences go" : " goes"}`,
      checkSentence(cli, requests),
      "; when everything is reused, nothing is sent",
    ),
  );
  return rows;
}

/** "sonnet for preference summaries, opus for choosing and writing roles". */
function subagentModels(choice: SubagentsChoice, authorOnly: boolean): string {
  if (authorOnly) return `${modelName(choice.write)} for writing roles`;
  if (choice.summarize === choice.choose && choice.choose === choice.write)
    return `${modelName(choice.summarize)} for every step`;
  if (choice.summarize === choice.choose)
    return `${modelName(choice.summarize)} for preference summaries and choosing roles, ${modelName(choice.write)} for writing roles`;
  const parts = [`${modelName(choice.summarize)} for preference summaries`];
  if (choice.choose === choice.write)
    parts.push(`${modelName(choice.choose)} for choosing and writing roles`);
  else
    parts.push(
      `${modelName(choice.choose)} for choosing roles`,
      `${modelName(choice.write)} for writing roles`,
    );
  return parts.join(", ");
}

/**
 * The suggest-subagents plan screen, in the distill layout: which preferences
 * are read, which CLI runs it, the calls in plain words, the models by real
 * name, and where the text goes. Zero counts are left out.
 */
function subagentRows(plan: DistillPlan, sub: SubagentsPlan, session: SessionDescription): Row[] {
  const rows: Row[] = [];
  const row = (label: string, text: string) => rows.push({ label, text });
  const quality = plan.quality ?? "balanced";
  const offer = offersChoice(plan);
  const cli = cliName(session);
  const selected = sub.choices[quality];
  const authorOnly = sub.authorOnly;

  // What will be read.
  if (authorOnly) {
    const n = authorOnly.names.length;
    row(
      "Reads",
      `Your saved roles: ${count(n)} of ${count(authorOnly.roles)} ${n === 1 ? "needs" : "need"} a written prompt (${authorOnly.names.join(", ")}).`,
    );
  } else if (sub.selection === "accepted") {
    row(
      "Reads",
      `${counted(sub.inputs, "working preference")} you accepted${sub.candidates ? `, of ${count(sub.candidates)} observed` : ""}.`,
    );
  } else if (sub.includeUnreviewed) {
    row(
      "Reads",
      `${counted(sub.inputs, "preference")}, ${count(sub.accepted)} of them accepted. Every one is used, as asked; dismissed ones are left out.`,
    );
  } else {
    row(
      "Reads",
      `${counted(sub.inputs, "preference")}. None is accepted yet, so every one is used except dismissed ones. To narrow this, review them in the library view first.`,
    );
  }

  rows.push(...runsOnRows(session));

  // How many calls, in plain words.
  const fresh = (choice: SubagentsChoice) => choice.batches - choice.reused;
  const sameBatches =
    !offer ||
    (fresh(sub.choices.balanced) === fresh(sub.choices.best) &&
      sub.choices.balanced.reused === sub.choices.best.reused);
  const writes =
    sub.minRoles === sub.maxRoles
      ? `${counted(sub.maxRoles, "call")} to write ${sub.maxRoles === 1 ? "a role prompt" : "role prompts"}`
      : `${count(sub.minRoles)} to ${count(sub.maxRoles)} calls to write role prompts, one per role`;
  if (authorOnly) row("Calls", `${writes}.`);
  else {
    const parts: string[] = [];
    let after = "";
    if (!sameBatches) parts.push("preference summary calls as listed under each plan below");
    else if (fresh(selected) > 0)
      parts.push(
        `${counted(fresh(selected), "call")} to summarize preferences${selected.reused ? ` (${counted(selected.reused, "batch", "batches")} reused from saved work)` : ""}`,
      );
    else after = " The preference summaries are reused from saved work.";
    parts.push("1 call to choose roles", writes);
    row("Calls", `${listed(parts)}.${after}`);
    row("", "A large set of preferences can need more calls to choose roles.");
  }
  row(
    "",
    `An answer that fails its checks gets one more try. ${pace(plan.concurrency ?? 1, session)}.`,
  );

  // Models, by real name.
  const tierLine = (choice: SubagentsChoice): TierLine => {
    const extra: string[] = [];
    if (!sameBatches) {
      const n = fresh(choice);
      extra.push(
        n === 0
          ? "summaries reused from saved work"
          : `${counted(n, "summary call")}${choice.reused ? `, ${counted(choice.reused, "batch", "batches")} reused` : ""}`,
      );
    }
    return {
      models: subagentModels(choice, Boolean(authorOnly)),
      extra,
      notes: choice.notes ?? [],
    };
  };
  rows.push(
    ...modelRows({
      offer,
      quality,
      tiers: { balanced: tierLine(sub.choices.balanced), best: tierLine(sub.choices.best) },
      allDefault: [selected.summarize, selected.choose, selected.write].every(
        (model) => model === "CLI default",
      ),
      named: Boolean(plan.qualityFixed && session.qualityChoice !== false),
      cli,
    }),
  );

  // Where the text goes. The check sends one tiny request per distinct model
  // of the stages this run calls: summaries only when some are not reused,
  // and only role writing with --author-only.
  const requests = (offer ? [sub.choices.balanced, sub.choices.best] : [selected]).map((choice) =>
    authorOnly
      ? [choice.write]
      : [...(fresh(choice) > 0 ? [choice.summarize] : []), choice.choose, choice.write],
  );
  rows.push(
    sendingRow(
      session,
      authorOnly
        ? "The saved roles and their working preferences go"
        : "Your working preferences and the evidence quoted for them go",
      checkSentence(cli, requests),
    ),
  );
  return rows;
}

/** Lines the Start question needs below the plan: a blank line, the title, two choices, start, quit, one note. */
const QUESTION_LINES = 7;

/**
 * The plan in four lines, for a terminal too short to show the whole plan and
 * the question together: what is read and where, the models, where the text
 * goes, and the command that prints the whole plan without starting.
 */
function shortScreen(plan: DistillPlan, session: SessionDescription, width: number): string {
  const cli = cliName(session);
  const quality = plan.quality ?? "balanced";
  const wrap = (text: string) => wrapRow("", text, width).map((line) => line.replace(/^ {9}/, ""));
  const lines: string[] = [];
  // With a choice, both plans' models in one line: "sonnet and opus (Balanced), ...".
  const both = (models: (tier: Quality) => string[]) =>
    (["balanced", "best"] as const)
      .map((tier) => `${listed([...new Set(models(tier))].map(modelName))} (${qualityName(tier)})`)
      .join(", ");
  if (plan.subagents) {
    const sub = plan.subagents;
    const choice = sub.choices[quality];
    const roles =
      sub.minRoles === sub.maxRoles
        ? counted(sub.maxRoles, "role")
        : `${count(sub.minRoles)} to ${count(sub.maxRoles)} roles`;
    const what = sub.authorOnly
      ? counted(sub.authorOnly.names.length, "role prompt")
      : `${counted(sub.inputs, "preference")} into ${roles}`;
    lines.push(...wrap(bold(`Subagent plan: ${what}, through ${cli}.`)));
    lines.push(
      ...wrap(
        offersChoice(plan)
          ? `Models: ${both((tier) => {
              const c = sub.choices[tier];
              return sub.authorOnly ? [c.write] : [c.summarize, c.choose, c.write];
            })}.`
          : `Models: ${subagentModels(choice, Boolean(sub.authorOnly))}.`,
      ),
    );
    lines.push(...wrap(`Your preferences go to your provider through ${cli}.`));
  } else {
    const sessions = plan.sessions ?? plan.digests;
    lines.push(
      ...wrap(bold(`Reflect on your history: ${counted(sessions, "session")}, through ${cli}.`)),
    );
    const choices = plan.choices;
    const choice = choices?.[quality];
    if (choices && offersChoice(plan))
      lines.push(
        ...wrap(
          `Models: ${both((tier) => [choices[tier].digest, choices[tier].cluster, choices[tier].author])}.`,
        ),
      );
    else if (choice) lines.push(...wrap(`Models: ${stageModels(plan, choice)}.`));
    lines.push(...wrap(`The selected session text goes to your provider through ${cli}.`));
  }
  if (plan.fullPlan) lines.push("  To see the whole plan first, run:", `    ${plan.fullPlan}`);
  return lines.join("\n");
}

export interface RenderOptions {
  /** Columns to wrap the plan screen to (default 80). */
  width?: number;
  color?: boolean;
  /**
   * Rows of the terminal. When the plan and the Start question would not fit,
   * the short form is shown with the command that prints the whole plan.
   */
  height?: number;
}

/** Render the exact selection without reading stdin or invoking a provider. */
export function renderPlan(plan: DistillPlan, options: RenderOptions = {}): string {
  const width = options.width ?? 80;
  const bullet = dim(glyph("•", "-"));
  if (plan.consolidation && plan.session) {
    return [
      bold("  Consolidate working preferences"),
      ...renderRunnerDisclosure(plan.session),
      `  ${counted(plan.consolidation.inputs, "preference")}, one consolidation call, plus bounded validation retries.`,
      `  1  Balanced  ${plan.consolidation.models.balanced}`,
      `  2  Best      ${plan.consolidation.models.best}`,
      `  Selected plan: ${qualityName(plan.quality ?? "balanced")}.`,
      "  Approval includes a small readiness check. The selected preferences go to your provider through the listed CLIs.",
    ].join("\n");
  }
  if (plan.retry) return renderRetryPlan(plan.retry, bullet);
  if (!plan.session) return renderBarePlan(plan, bullet);
  const full = plan.subagents
    ? planScreen(
        "Subagent plan",
        subagentRows(plan, plan.subagents, plan.session),
        width,
        options.color ?? canColor(),
      )
    : planScreen(
        "Reflect on your history",
        distillRows(plan, plan.session),
        width,
        options.color ?? canColor(),
      );
  if (options.height !== undefined && full.split("\n").length + QUESTION_LINES > options.height)
    return shortScreen(plan, plan.session, width);
  return full;
}

/** A saved call's kind, as the person reads it. */
const CALL_KIND: Record<string, string> = {
  digest: "session read",
  "cluster-window": "grouping",
  "cluster-merge": "grouping merge",
  author: "prompt writing",
};

/**
 * The plan of `distill --retry-failed` and `--recover-tasks`: the saved calls
 * made again, each with its CLI and model, the results finished from saved
 * answers without a call, and what is left out and why. Zero counts are left out.
 */
function renderRetryPlan(retry: NonNullable<DistillPlan["retry"]>, bullet: string): string {
  const kind = (value: string) => CALL_KIND[value] ?? value;
  const calls = retry.operations.length;
  const repairs = retry.repairs.length;
  const what = [
    calls ? `${counted(calls, "saved call")} to make again` : "",
    repairs ? `${counted(repairs, "result")} to finish from saved answers, with no call` : "",
  ].filter(Boolean);
  const lines = [
    bold(`  ${retry.mode === "retry-failed" ? "Retry plan" : "Recovery plan"}`),
    "",
    `  ${sentence(what.join("; ") || "nothing to do")}.`,
    "  Saved grouping and results that finished are kept.",
  ];
  for (const session of retry.sessions ?? []) lines.push(...renderRunnerDisclosure(session));
  if (retry.sessions?.length)
    lines.push(
      `  Before the first call, ${retry.sessions.length === 1 ? "a tiny request checks" : `${count(retry.sessions.length)} tiny requests check`} that the CLI is ready. An answer that fails its checks gets one more try.`,
    );
  for (const item of retry.operations)
    lines.push(
      `    ${bullet} ${kind(item.kind)} ${item.unitId}: ${item.runner}, ${item.model ?? "CLI default"}, up to ${item.timeoutMs / 1000}s`,
    );
  for (const item of retry.repairs)
    lines.push(`    ${bullet} ${kind(item.kind)} ${item.unitId}: from its saved answer`);
  for (const item of retry.blocked)
    lines.push(`    ${bullet} ${kind(item.kind)} ${item.unitId}: cannot run, ${item.reason}`);
  if (retry.excluded.length) {
    lines.push(`  Left out: ${counted(retry.excluded.length, "saved call")}.`);
    for (const item of retry.excluded)
      lines.push(`    ${bullet} ${kind(item.kind)} ${item.unitId}: ${item.reason}`);
  }
  return lines.join("\n");
}

/** The plan for a caller that has no run session: counts, the CLI, and any chosen models. */
function renderBarePlan(plan: DistillPlan, bullet: string): string {
  const digestStr = count(plan.digests);
  const clusterStr = `${plan.cluster > 0 ? "~" : ""}${count(plan.cluster)}`;
  const authorStr = `~${count(plan.authorEstimate)}`;
  const width = Math.max(digestStr.length, clusterStr.length, authorStr.length);
  const total = plan.digests + plan.cluster + plan.authorEstimate;
  const strong = (s: string) => bold(cyan(s.padStart(width)));
  const { cli, cost } = runnerCopy(plan.runnerName);
  const windows = plan.clusterWindowsEstimate;

  const lines = [
    `  Reflection will call your local \`${cli}\` CLI (${cost}):`,
    `    ${bullet} ${strong(digestStr)} session read${plan.digests === 1 ? "" : "s"}`,
    `    ${bullet} ${strong(clusterStr)} grouping call${plan.cluster === 1 ? "" : "s"}${
      windows !== undefined
        ? ` (estimated ${counted(windows, "batch", "batches")} and ${count(plan.clusterMergeEstimate ?? 0)} merge; the size limit per call may need more batches)`
        : plan.cluster > 0
          ? " (estimated; the size limit per call may need batches and a merge)"
          : ""
    }`,
    `    ${bullet} ${strong(authorStr)} prompt writing call${plan.authorEstimate === 1 ? "" : "s"} (one per task; the exact count is known after grouping)`,
    `  Approximately ${bold(cyan(count(total)))} call${total === 1 ? "" : "s"} in total.${dim(` Nothing is sent anywhere except through your own ${cli} CLI.`)}`,
  ];
  if (
    plan.model !== undefined ||
    (plan.cluster > 0 && plan.clusterModel !== undefined) ||
    plan.authorModel !== undefined
  ) {
    const readModel = plan.model ?? "CLI default";
    const writeModel = plan.authorModel ?? plan.model ?? "CLI default";
    const readAndWrite =
      writeModel === readModel
        ? `reads and writing: ${readModel}`
        : `reads: ${readModel}; writing: ${writeModel}`;
    lines.push(
      `  Models: ${readAndWrite}${
        plan.cluster > 0 ? `; grouping: ${plan.clusterModel ?? plan.model ?? "CLI default"}` : ""
      }.`,
    );
  }
  if (plan.budget !== undefined) {
    const oversized = plan.oversized ?? [];
    if (oversized.length > 0) {
      const what = `${counted(oversized.length, "session is", "sessions are")} longer than the ${count(plan.budget)}-character budget`;
      const then =
        plan.truncate === "extreme"
          ? "will be shortened to fit."
          : `${oversized.length === 1 ? "is" : "are"} left out of this run: ${leftOutNames(oversized)}.`;
      lines.push(`  ${yellow(`${glyph("⚠", "!")} ${what} and ${then}`)}`);
    } else {
      lines.push(
        `  ${dim(`Every eligible session fits the ${count(plan.budget)}-character budget.`)}`,
      );
    }
  }
  if (plan.resumeNote) lines.push(`  ${yellow(plan.resumeNote)}`);
  return lines.join("\n");
}

type Answer = { line: string } | { end: "eof" | "interrupt" };

/**
 * One answer line. On a terminal the UI kit reads it, and Ctrl-C is told apart
 * from the end of input. A supplied non-terminal stream (scripts and tests)
 * is read directly. Nothing is read when there is neither.
 */
async function readAnswer(
  question: string,
  io: PromptIo & { host?: TerminalHost },
): Promise<Answer> {
  if (canPrompt(io)) {
    const host = io.host ?? (process as unknown as TerminalHost);
    let interrupted = false;
    const mark = () => {
      interrupted = true;
    };
    host.once("SIGINT", mark);
    try {
      const line = await readLine(question, io);
      if (line !== null) return { line };
      return { end: interrupted ? "interrupt" : "eof" };
    } finally {
      host.off("SIGINT", mark);
    }
  }
  const input = io.input;
  if (!input || input === process.stdin || input.readableEnded || input.destroyed) {
    return { end: "eof" };
  }
  return new Promise((resolve) => {
    const lines = createInterface({ input, terminal: false });
    lines.once("line", (line) => {
      resolve({ line });
      lines.close();
    });
    lines.once("close", () => resolve({ end: "eof" }));
    (io.output ?? process.stdout).write(question);
  });
}

/**
 * A yes or no question that also reports Ctrl-C. An empty line takes the
 * default; end of input declines. A supplied stream supports scripted
 * interaction; otherwise only a terminal is asked.
 */
export async function askYesNoAnswer(
  question: string,
  opts: YesNoOptions = {},
): Promise<"yes" | "no" | "interrupt"> {
  if (!opts.input && !canPrompt(opts)) return "no";
  const answer = await readAnswer(`${question} ${opts.defaultYes ? "[Y/n]" : "[y/N]"} `, opts);
  if ("end" in answer) return answer.end === "interrupt" ? "interrupt" : "no";
  const norm = answer.line.trim().toLowerCase();
  return norm === "y" || norm === "yes" || (norm === "" && opts.defaultYes === true) ? "yes" : "no";
}

/**
 * A yes or no question. Never one that starts model calls: that is the Start
 * question (`askStart`), which takes only `s`.
 */
export interface YesNoOptions extends PromptIo {
  defaultYes?: boolean;
  host?: TerminalHost;
}

/** A supplied stream supports scripted interaction. CLI use prompts only on a terminal. */
export async function askYesNo(question: string, opts: YesNoOptions = {}): Promise<boolean> {
  return (await askYesNoAnswer(question, opts)) === "yes";
}

const RUNNER_KEY: Record<RunnerName, string> = {
  claude: "c",
  codex: "x",
  kiro: "k",
  opencode: "o",
};
export const RUNNER_INK = {
  claude: "yellow",
  codex: "blue",
  kiro: "cyan",
  opencode: "magenta",
} as const;

/** Keep a key beside its label when a row of choices spans two terminal lines. */
function optionRows(options: string[], width: number): string[] {
  const rows: string[] = [];
  let row = "";
  for (const option of options) {
    if (row && visibleWidth(`${row}   ${option}`) > width) {
      rows.push(row);
      row = "";
    }
    row += `${row ? "   " : ""}${option}`;
  }
  if (row) rows.push(row);
  return rows;
}

/** The reflection question uses the same deliberate Start key and input protection as every paid operation. */
async function confirmReflection(
  initial: DistillPlan,
  opts: ConsentOptions,
): Promise<ConsentResult | "interrupted"> {
  const runners = opts.runners ?? [];
  let plan = initial;
  let quality = plan.quality ?? "balanced";
  let ready = runners.length === 0;
  const offerQuality = () => !plan.qualityFixed && (!ready || offersChoice(plan));
  const controls: NonNullable<StartQuestion<Quality>["controls"]> = {
    ready: () => ready,
    previewCommand: () =>
      ready && !plan.qualityFixed && quality !== plan.quality
        ? plan.fullPlan?.replace(/ --dry-run$/, ` --quality=${quality} --dry-run`)
        : ready
          ? plan.fullPlan
          : undefined,
    hint: () => (ready ? START_HINT : "Choose a coding CLI before pressing s to start."),
    keys: () => [
      ...runners.map((runner) => RUNNER_KEY[runner.name]),
      ...(offerQuality() ? ["1", "2"] : []),
    ],
    choose(key) {
      const runner = runners.find((item) => RUNNER_KEY[item.name] === key);
      if (runner) {
        plan = runner.select();
        ready = true;
        return true;
      }
      if (offerQuality() && (key === "1" || key === "2")) {
        quality = key === "1" ? "balanced" : "best";
        return true;
      }
      return false;
    },
    lines(width, color) {
      const s = palette(color);
      const sessions = plan.sessions ?? plan.digests;
      const recent = plan.recent !== undefined && (plan.eligible ?? sessions) > sessions;
      const scope = s.cyan(counted(sessions, recent ? "recent session" : "session"));
      const projects = plan.projects
        ? ` across ${s.magenta(counted(plan.projects, "project"))}`
        : "";
      const eligible = recent
        ? ` ${glyph("·", "-")} ${s.dim(`${count(plan.eligible ?? sessions)} eligible`)}`
        : "";
      const lines = [
        s.bold("Reflect on your history"),
        ...wrapText(`${scope}${projects}${eligible}`, width),
        "",
      ];
      const runnerInk = {
        claude: "255;186;142",
        codex: "137;185;255",
        kiro: "141;227;228",
        opencode: "207;173;255",
      };
      if (runners.length) {
        lines.push(
          s.bold("Which coding CLI should run this reflection?"),
          ...optionRows(
            runners.map(({ name }) =>
              choicePill(
                ready && name === plan.runnerName,
                RUNNER_KEY[name],
                RUNNER_INFO[name].displayName,
                runnerInk[name],
                color,
              ),
            ),
            width,
          ),
        );
      } else if (plan.runnerName && plan.session) {
        lines.push(`Runs on  ${s[RUNNER_INK[plan.runnerName]](plan.session.runnerLine)}`);
        if (plan.session.alsoReady.length)
          lines.push(
            ...wrapText(
              `If this CLI stops working, the run can move to ${listed(plan.session.alsoReady)}.`,
              width,
              { indent: "  " },
            ),
          );
      }
      if (runners.length || plan.runnerName) lines.push("");
      if (offerQuality()) {
        lines.push(
          s.bold("Quality"),
          ...optionRows(
            [
              choicePill(quality === "balanced", "1", "Balanced", "141;227;228", color),
              choicePill(quality === "best", "2", "Best", "246;161;199", color),
            ],
            width,
          ),
        );
      } else if (plan.qualityFixed) lines.push(`Quality  ${s.cyan(qualityName(quality))}`);
      const cli = ready && plan.session ? cliName(plan.session) : "the CLI you choose";
      const selected = ready ? plan.choices?.[quality] : undefined;
      if (selected) {
        lines.push(...wrapText(stageModels(plan, selected), width, { indent: "  " }).map(s.yellow));
        for (const note of selected.notes ?? [])
          lines.push(...wrapText(note, width, { indent: "  " }));
      } else
        lines.push(
          ...wrapText("Choose a CLI to see its models and call counts.", width, { indent: "  " }),
        );
      lines.push("");
      if (ready && plan.session) {
        // The full plan already accounts for each runner's cache identity,
        // concurrency limit, batching, edit protection and size policy.
        const rows = distillRows({ ...plan, quality, qualityFixed: true }, plan.session);
        let section = "";
        for (const row of rows) {
          if (row.label) section = row.label;
          if (!["Calls", "Library", "Size"].includes(section)) continue;
          const label = row.label === "Calls" ? "Plan" : row.label;
          const ink = section === "Calls" ? s.blue : section === "Library" ? s.cyan : s.yellow;
          const lead = label ? `${ink(label)}  ` : "  ";
          lines.push(...wrapText(row.text, width, { indent: lead, hang: "  " }));
        }
      }
      const route =
        ready && plan.session?.alsoReady.length ? `${cli} (or the CLI the run moves to)` : cli;
      const sending = `Selected session text${plan.generalize ? " and working preferences go" : " goes"} through ${route} to its provider, using your tokens.`;
      lines.push(...wrapText(sending, width, { indent: `${s.magenta("Sending")}  `, hang: "  " }));
      if (ready) {
        lines.push(
          ...wrapText(
            `${plan.session?.pinned ? "This run stays on this CLI. " : ""}Before the first model call, a tiny request checks each planned model. If all work is reused, nothing is sent.`,
            width,
            { indent: "  " },
          ),
        );
      }
      lines.push(
        "",
        `  ${s.yellow("s")}  ${ready ? s.green(s.bold("Start reflection")) : s.dim("Start reflection (choose a CLI first)")}`,
        `  ${s.yellow("q")}  Not now`,
      );
      return lines;
    },
  };
  const answer = await askStart<Quality>({ controls }, opts);
  if (answer === "interrupt") return "interrupted";
  if (answer === "quit") return "declined";
  opts.onQuality?.(quality);
  return "proceed";
}

/**
 * Print the plan, then ask the Start question (`askStart`). `--dry-run` and
 * `--yes` never read input.
 *
 * Only `s` starts. When the plan offers a choice of quality, `1` and `2`
 * select Balanced or Best first and never start. `q`, Escape, and the end of
 * input decline; Ctrl-C prints one line and is an interrupt. On a terminal
 * too short for a distill or subagent plan and the question together, the
 * plan's short form is printed instead.
 *
 * A supplied stream that is not a terminal (scripts and tests) answers in
 * lines with the same letters: `s` starts, `1` or `2` selects, `q` or the end
 * of input declines.
 */
export async function confirmPlan(
  plan: DistillPlan,
  opts: ConsentOptions,
): Promise<ConsentResult | "interrupted"> {
  const output = opts.output ?? process.stdout;
  const terminal: TerminalOutput = output;
  const width = terminal.isTTY ? Math.min(terminalWidth(terminal), 100) : 80;
  const screen = Boolean(plan.session && !plan.consolidation && !plan.retry);
  const asks = !opts.dryRun && !opts.yes && (Boolean(opts.input) || canPrompt(opts));
  if (asks && opts.runners && plan.session && plan.choices) return confirmReflection(plan, opts);
  // The short form is for a single-key question on a short terminal; printed lines scroll.
  const keys = asks && startTakesKeys({ input: opts.input, output: opts.output });
  const height = screen && keys && terminal.isTTY && terminal.rows ? terminal.rows : undefined;
  output.write(`${renderPlan(plan, { width, height, color: canColor({ output }) })}\n`);
  if (opts.dryRun) return "dry-run";
  if (opts.yes) return "proceed";
  if (!asks) return "declined";
  const quality = plan.quality ?? "balanced";
  const choose = Boolean(opts.onQuality && (screen ? offersChoice(plan) : true));
  output.write("\n");
  const answer = await askStart<Quality>(
    {
      title: "Start?",
      ...(choose && {
        options: (["balanced", "best"] as const).map((tier) => ({
          key: tier,
          label: qualityName(tier),
          detail: startDetail(plan, tier),
        })),
        selected: quality,
      }),
    },
    { input: opts.input, output: opts.output, host: opts.host },
  );
  if (answer === "interrupt") return "interrupted";
  if (answer === "quit") return "declined";
  if (choose && answer.selected) opts.onQuality?.(answer.selected);
  return "proceed";
}

/** What a plan's models do, in a few words, beside its name in the Start question. */
function startDetail(plan: DistillPlan, tier: Quality): string | undefined {
  if (plan.subagents) {
    const choice = plan.subagents.choices[tier];
    return choice ? subagentModels(choice, Boolean(plan.subagents.authorOnly)) : undefined;
  }
  const choice = plan.choices?.[tier];
  return choice ? stageModels(plan, choice) : undefined;
}

/** {@link confirmPlan} for callers that read Ctrl-C at the question as a decline. */
export async function confirm(plan: DistillPlan, opts: ConsentOptions): Promise<ConsentResult> {
  const result = await confirmPlan(plan, opts);
  return result === "interrupted" ? "declined" : result;
}

export interface InterruptOptions {
  /** Where Ctrl-C arrives (default `process`). */
  host?: TerminalHost;
  /** How the process ends (default `process.exit`). */
  exit?(code: number): void;
  /** Synchronous cleanup before the process ends, such as releasing the writer lock. */
  onInterrupt?(): void;
  /**
   * What is true about saved work at the moment Ctrl-C arrives, as one
   * sentence ("Sessions read so far are saved."). The default says only that
   * finished work is kept, which is true of every step.
   */
  saved?(): string;
  /**
   * The whole line before the command, for a step where "To continue" is not
   * the right story (a single call saves nothing until it returns). Replaces
   * the usual `Interrupted. <saved> To continue, run:`.
   */
  says?: string;
  /** Called once the line is written: later output of the stopping run is dropped. */
  mute?(): void;
}

/** True of every step: a result is saved when it finishes, and a rerun reuses it. */
const FINISHED_WORK_SAVED = "Finished work is saved and reused.";

/**
 * Ctrl-C during a run: one line says what was saved, the command that
 * continues follows alone on its own line, and the process exits with the
 * shell's code for Ctrl-C, 130. Returns a function that stops listening.
 */
export function reportRunInterrupt(
  output: Writable,
  resumeCommand: string,
  o: InterruptOptions = {},
): () => void {
  const host = o.host ?? (process as unknown as TerminalHost);
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const interrupt = () => {
    try {
      o.onInterrupt?.();
    } finally {
      // Keep any progress frame on screen, then exit once the lines are out, so
      // a pipe still receives them.
      persistLiveRegion(output);
      const says = o.says ?? `Interrupted. ${o.saved?.() ?? FINISHED_WORK_SAVED} To continue, run:`;
      const lines = sayThenRun(says, resumeCommand, screenWidth(output));
      output.write(`${lines.join("\n")}\n`, () => exit(130));
      o.mute?.();
    }
  };
  host.once("SIGINT", interrupt);
  return () => host.off("SIGINT", interrupt);
}
