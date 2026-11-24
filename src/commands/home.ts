import fs from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import pkg from "../../package.json" with { type: "json" };
import {
  type EnvironmentOptions,
  type EnvironmentRow,
  type EnvironmentSnapshot,
  readExportSessionShare,
  startEnvironment,
} from "../core/environment.js";
import { readObservedPreferences } from "../core/preferences.js";
import { suggestionPath } from "../core/subagents.js";
import { type OperationRecord, OperationStore, writerBusyReason } from "../distill/operations.js";
import type { RunnerIo } from "../runners/shared.js";
import { SOURCE_PRODUCT_NAMES } from "../sources/labels.js";
import { parseSourceMode } from "../sources/registry.js";
import { frameHeight } from "../ui/live.js";
import {
  canColor,
  canPrompt,
  glyph,
  isInteractive,
  lineWidth,
  type TerminalOutput,
  terminalWidth,
} from "../ui/mode.js";
import { chooseMenuAnswer, type MenuChoice, type MenuIo } from "../ui/prompt.js";
import { counted, hint, palette, visibleWidth } from "../ui/style.js";
import { wrapText } from "../ui/wrap.js";
import { resolvePaths } from "./_shared.js";
import { runExport } from "./export.js";
import {
  flowArgs,
  generateSubagents,
  type NextCommand,
  nextCommandText,
  runNextCommand,
} from "./next.js";
import { runScan } from "./scan.js";

export type HomeArgs = Parameters<typeof runScan>[0] & {
  runner?: string;
  recent?: string;
  plain?: boolean;
  yes?: boolean;
  "dry-run"?: boolean;
};

export type HomeAction =
  | "build"
  | "reflect"
  | "gui"
  | "preferences"
  | "refresh"
  | "suggest"
  | "export"
  | "scan"
  | "doctor";

/** What is already on disk in the data home. Known before the first paint. */
export interface SavedWork {
  exported: boolean;
  exportedAt?: Date;
  library: boolean;
  /** A reflection stopped before it finished (Ctrl-C, a closed terminal), and no command is running now. */
  interrupted?: boolean;
}

/**
 * A reflection stopped part way: its ledger still lists work as running or
 * waiting, and no command holds the writer lock. A filtered Home only
 * offers to resume work that belongs to the person's selected exports.
 */
async function interruptedRun(home: string, args: HomeArgs): Promise<boolean> {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(home, "distill", "operations.json"), "utf8"),
    ) as { operations?: unknown };
    if (!Array.isArray(parsed.operations)) return false;
    const unfinished: OperationRecord[] = parsed.operations.filter(
      (op) =>
        op &&
        op.source !== "explicit-task-recovery" &&
        ["running", "queued", "result-saved"].includes(op.state),
    );
    if (!unfinished.length || writerBusyReason(home)) return false;
    const source = parseSourceMode(args.source);
    if (!args.project && source === "auto" && !args.recent) return true;
    const { computePlan, parseManifest } = await import("./distill.js");
    const file = path.join(home, "exports", "manifest.json");
    const entries = parseManifest(fs.readFileSync(file, "utf8"), file);
    const selected = new Set(
      computePlan(entries, {
        project: args.project,
        activeOrigins: source === "auto" ? undefined : new Set([source]),
        recent: args.recent ? Number(args.recent) : undefined,
        minSubstance: 2,
        noGroup: false,
      }).eligible.map((entry) => entry.export),
    );
    if (!selected.size) return false;
    if (unfinished.some((op) => op.kind === "digest" && selected.has(op.unitId))) return true;
    const laterStages = unfinished.filter((op) =>
      ["cluster-window", "cluster-merge", "author"].includes(op.kind),
    );
    if (!laterStages.length) return false;
    const store = new OperationStore(home);
    return laterStages.some((op) => {
      const input = store.loadInput(op.id);
      if (op.kind === "author")
        return input.sources.some((ref) => selected.has(path.posix.basename(ref.path)));
      const grouping = input.logicalInput as { windowIds?: unknown };
      return (
        Array.isArray(grouping?.windowIds) && grouping.windowIds.some((id) => selected.has(id))
      );
    });
  } catch {
    return false;
  }
}

/** The menu needs file presence and recency. Opening an artifact performs its full validation. */
async function savedWork(home: string, args: HomeArgs): Promise<SavedWork> {
  const file = path.join(home, "exports", "manifest.json");
  let exported = false;
  let exportedAt: Date | undefined;
  try {
    exportedAt = fs.statSync(file).mtime;
    exported = Object.values(readExportSessionShare(home, args)).some((n) => n > 0);
  } catch {
    // Missing or unreadable exports can be rebuilt from history.
  }
  const dir = path.join(home, "library");
  let library =
    fs.existsSync(path.join(home, "distill", "digests.json")) ||
    fs.existsSync(suggestionPath(home)) ||
    fs.existsSync(path.join(dir, "preferences.generalized.json"));
  if (!library) {
    try {
      library = fs.readdirSync(dir, { withFileTypes: true }).some(
        (entry) =>
          entry.isDirectory() &&
          // A saved prompt is stored as `<slug>/<slug>.oneshot.md` beside its sources.
          fs.existsSync(path.join(dir, entry.name, `${entry.name}.oneshot.md`)) &&
          fs.existsSync(path.join(dir, entry.name, "sources.json")),
      );
    } catch {
      // Normal on the first visit.
    }
  }
  return {
    exported,
    exportedAt,
    library,
    interrupted: exported && (await interruptedRun(home, args)),
  };
}

const included = (snapshot: EnvironmentSnapshot) => snapshot.rows.filter((row) => row.included);

/** History may exist: counted above zero, or a store is present and still being counted. */
function hasHistory(snapshot: EnvironmentSnapshot): boolean {
  return included(snapshot).some((row) =>
    row.history ? row.history.sessions > 0 : row.storePresent && !row.historyError,
  );
}

/** Every selected store has been counted, and none holds a session. */
function noHistory(snapshot: EnvironmentSnapshot): boolean {
  return included(snapshot).every(
    (row) => !row.historyError && row.history?.exact === true && row.history.sessions === 0,
  );
}

/** Whether `--runner` lets this CLI run: no choice, `auto`, its name, or a list holding it. */
function runnerAllows(runner: string | undefined, name: string): boolean {
  if (!runner) return true;
  const named = runner.split(",").map((part) => part.trim().toLowerCase());
  return named.includes("auto") || named.includes(name);
}

function canReflect(snapshot: EnvironmentSnapshot, args: HomeArgs): boolean {
  return snapshot.rows.some(
    (row) => row.name !== "kirocrew" && row.installed && runnerAllows(args.runner, row.name),
  );
}

function refreshDetail(snapshot: EnvironmentSnapshot): string {
  const fresh = snapshot.totals?.newSessions;
  if (fresh === undefined) return "checking for sessions since my last export";
  if (fresh === 0) return "nothing new since my last export";
  return `${counted(fresh, "new session")} since my last export`;
}

/**
 * Every item the current facts allow, in order. The first is the recommended
 * next step for what is saved on disk: nothing exported, exported but not
 * distilled, a library, or saved subagents.
 */
function candidateChoices(
  snapshot: EnvironmentSnapshot,
  saved: SavedWork,
  args: HomeArgs,
): MenuChoice<HomeAction>[] {
  const choices: MenuChoice<HomeAction>[] = [];
  const history = hasHistory(snapshot);
  const writable = snapshot.dataHomeWritable;
  const ready = writable && canReflect(snapshot, args);
  const doctor: MenuChoice<HomeAction> = {
    key: "doctor",
    label: "Check setup",
    detail: "tools and sign-in",
  };
  if (ready && saved.interrupted) {
    choices.push({ key: "reflect", label: "Resume my reflection", detail: "reuses saved work" });
  } else if (ready && ((!saved.exported && history) || (!saved.library && saved.exported))) {
    choices.push({
      key: saved.exported ? "reflect" : "build",
      label: "Reflect on my history",
      detail: saved.exported ? "from my exported messages" : "export, then review the plan",
    });
  }
  if (saved.library) {
    choices.push(
      { key: "gui", label: "Open my reflections", detail: "in the browser" },
      { key: "preferences", label: "Read my preferences", detail: "guidance from my history" },
    );
  }
  if (ready && history && saved.exported && (saved.library || saved.interrupted)) {
    choices.push({
      key: "refresh",
      label: "Reflect on new sessions",
      detail: refreshDetail(snapshot),
    });
  }
  // Offered from the first run: without saved reads it makes them first.
  if (ready && (saved.library || history)) {
    choices.push({
      key: "suggest",
      label: "Suggest subagents",
      detail: saved.library
        ? "roles from my preferences"
        : "reads my sessions, then proposes roles",
    });
  }
  if (!ready && saved.exported && !saved.library) choices.push(doctor);
  if (writable && history) {
    choices.push({ key: "export", label: "Export my messages", detail: "local Markdown" });
  }
  if (history) {
    choices.push({ key: "scan", label: "Show projects", detail: "history inventory" });
  }
  if (!choices.includes(doctor)) choices.push(doctor);
  return choices;
}

/**
 * The menu as it first appears. The first item is recommended, decided from
 * what is on disk and the facts known at first paint; it never changes later.
 */
function openingChoices(
  snapshot: EnvironmentSnapshot,
  saved: SavedWork,
  args: HomeArgs,
): MenuChoice<HomeAction>[] {
  return candidateChoices(snapshot, saved, args).map((choice, index) =>
    index === 0 ? { ...choice, recommended: true } : choice,
  );
}

/**
 * The menu after a slower fact arrives. Items on screen keep their place, key,
 * label, and recommendation; only their detail text may change. An item the
 * new facts allow is added at the end. Nothing is removed, so a key pressed
 * during a refresh always selects what was on screen.
 */
function updatedChoices(
  current: readonly MenuChoice<HomeAction>[],
  snapshot: EnvironmentSnapshot,
  saved: SavedWork,
  args: HomeArgs,
): MenuChoice<HomeAction>[] {
  const latest = candidateChoices(snapshot, saved, args);
  const kept = current.map((choice) => {
    const now = latest.find((item) => item.key === choice.key);
    return now && now.detail !== choice.detail ? { ...choice, detail: now.detail } : choice;
  });
  const added = latest
    .filter((item) => !current.some((choice) => choice.key === item.key))
    .map(({ recommended: _ignored, ...choice }) => choice);
  return [...kept, ...added];
}

const TAGLINE = "Understand how you work. Codify your taste.";
export const PRIVACY_LINE = "No session text leaves this machine until you approve a plan.";
const toolNames = Object.values(SOURCE_PRODUCT_NAMES);
const toolList = `${toolNames.slice(0, -1).join(", ")}, or ${toolNames.at(-1)}`;

/** The selected row with the most history, for the one command worth suggesting. */
function busiestRow(rows: EnvironmentRow[]): EnvironmentRow | undefined {
  const size = (row: EnvironmentRow) => row.history?.sessions ?? (row.storePresent ? 0.5 : 0);
  return rows.reduce<EnvironmentRow | undefined>(
    (best, row) => (best && size(best) >= size(row) ? best : row),
    undefined,
  );
}

/** One problem worth fixing now, and the exact command that fixes it. */
export interface HomeFix {
  says: string;
  run?: string;
}

/**
 * At most one fix, and only for a problem that exists now: a data home that
 * cannot be written, no coding CLI to build with while history exists, or
 * every installed CLI asking for a sign-in. An empty machine gets the empty
 * state instead, never an install command.
 */
export function homeFix(snapshot: EnvironmentSnapshot, args: HomeArgs): HomeFix | undefined {
  if (!snapshot.dataHomeWritable && snapshot.dataHomeFix) {
    return { says: "Choose a writable data home:", run: snapshot.dataHomeFix };
  }
  if (noHistory(snapshot)) return undefined;
  const runners = snapshot.rows.filter((row) => row.name !== "kirocrew");
  if (!canReflect(snapshot, args)) {
    const named = runners.find((row) => args.runner && runnerAllows(args.runner, row.name));
    if (named?.fix) return { says: `To reflect through ${named.tool}, run:`, run: named.fix };
    const row = busiestRow(included(snapshot).filter((item) => item.fix && !item.installed));
    const run = row?.fix ?? runners.find((item) => item.fix)?.fix;
    return { says: "Export works now. To reflect on your history, install a coding CLI:", run };
  }
  const installed = runners.filter((row) => row.installed && runnerAllows(args.runner, row.name));
  const signedOut = installed.filter((row) => row.signIn?.state === "needs-sign-in");
  if (signedOut.length && signedOut.length === installed.length) {
    const row = busiestRow(signedOut.filter((item) => item.included)) ?? signedOut[0];
    if (row?.fix) return { says: "Sign in before reflecting:", run: row.fix };
  }
  return undefined;
}

/** Whether a session read has left a preference to suggest roles from. */
function hasSavedPreferences(home: string): boolean {
  try {
    return readObservedPreferences(home).length > 0;
  } catch {
    return false;
  }
}

/** One line of the frame above the menu. `drop` lines leave first, lowest first, when rows run short. */
interface HomeLine {
  text: string;
  drop?: number;
}

/** Leave out droppable lines, lowest `drop` first, until the frame fits `height` rows. */
function fitLines(lines: HomeLine[], height: number | undefined): string[] {
  const kept = [...lines];
  if (height !== undefined) {
    const order = [...new Set(kept.flatMap((line) => (line.drop ? [line.drop] : [])))].sort(
      (a, b) => a - b,
    );
    for (const level of order) {
      if (kept.length <= height) break;
      for (let i = kept.length - 1; i >= 0 && kept.length > height; i--) {
        if (kept[i]?.drop === level) kept.splice(i, 1);
      }
    }
  }
  return kept.map((line) => line.text);
}

/** The history inventory above the controls. Setup details live in Check setup. */
function homeLines(
  snapshot: EnvironmentSnapshot,
  args: HomeArgs,
  width: number,
  io: HomeIo,
  height?: number,
): string[] {
  const s = palette(canColor(io));
  const mark = (symbol: string, ascii: string) => glyph(symbol, ascii, io.env);
  const rail = s.dim(mark("│", "|"));
  // A live region reserves the last column. The rail and its space take two more.
  const inner = Math.max(1, width - 3);
  const lines: HomeLine[] = [
    { text: `${rail} ${s.bold("Human Hindsight")} ${s.magenta(pkg.version)}` },
  ];
  const prose = (
    text: string,
    style: (value: string) => string = (value) => value,
    drop?: number,
  ) =>
    lines.push(...wrapText(text, inner).map((line) => ({ text: `${rail} ${style(line)}`, drop })));
  prose(TAGLINE, s.dim);
  lines.push({ text: rail, drop: 1 });
  prose("Your history", s.bold, 3);
  const rows = included(snapshot).filter(
    (row) => row.historyError || row.storePresent || row.history?.sessions,
  );
  const toolWidth = Math.max(0, ...rows.map((row) => visibleWidth(row.tool)));
  const colors = {
    claude: s.yellow,
    codex: s.blue,
    kiro: s.green,
    kirocrew: s.green,
    opencode: s.magenta,
  };
  for (const row of rows) {
    const history = row.history;
    const tool = colors[row.name](row.tool.padEnd(toolWidth));
    let fact: string;
    if (row.historyError) fact = s.yellow("could not read history");
    else if (!history) fact = s.dim(mark("counting…", "counting..."));
    else {
      const count = counted(history.sessions, row.name === "kirocrew" ? "chat" : "session");
      fact = `${s.cyan(count + (history.exact ? "" : mark("…", "...")))}${s.dim(mark(" · ", ", "))}${counted(history.projects, "project")}`;
    }
    if (visibleWidth(`${tool}  ${fact}`) <= inner) lines.push({ text: `${rail} ${tool}  ${fact}` });
    else lines.push({ text: `${rail} ${tool.trimEnd()}` }, { text: `${rail}   ${fact}` });
  }
  if (noHistory(snapshot)) {
    if (args.project || (args.source && args.source !== "auto")) {
      prose("No history matches this selection.");
      prose("To see every project, run npx human-hindsight scan");
    } else {
      prose("No session history found on this machine yet.");
      prose(`Looked for ${toolList.replace(/, or ([^,]+)$/, ", and $1")}.`, s.dim);
      prose("Kept somewhere else? Pass its folder, for example --claude-dir <dir>.");
      prose("Every folder option: npx human-hindsight help --all", s.dim);
    }
  } else if (snapshot.totals?.sessions) {
    prose(
      `${counted(snapshot.totals.sessions, "session")} across ${counted(snapshot.totals.projects, "project")}`,
      s.yellow,
    );
  } else if (rows.some((row) => row.history?.exact === false)) {
    prose("Checking Kiro Crew runs in Kiro CLI history.", s.dim);
  }
  // The one promise this screen makes. Session text is sent only by a model
  // step, and every model step shows its plan and waits for approval first.
  prose(PRIVACY_LINE);
  const fix = homeFix(snapshot, args);
  if (fix) {
    prose(fix.says);
    const steps =
      fix.run && visibleWidth(fix.run) + 2 > inner
        ? fix.run.split(" && ")
        : fix.run
          ? [fix.run]
          : [];
    lines.push(...steps.map((step) => ({ text: `  ${step}` })));
  }
  lines.push({ text: s.dim(mark("─", "-").repeat(Math.max(1, Math.min(width - 1, 72)))) });
  return fitLines(lines, height);
}

/** The command behind an action, with the tab it opens on. */
function actionCommand(action: HomeAction): { command: NextCommand; tab?: string } {
  if (action === "build" || action === "refresh") return { command: "export" };
  if (action === "suggest") return { command: "suggest-subagents" };
  if (action === "gui") return { command: "gui", tab: "preferences" };
  return { command: action };
}

/** Probes, history counting, and dispatch are injected so tests run no command. */
export interface HomeIo extends MenuIo {
  processes?: RunnerIo;
  countHistory?: EnvironmentOptions["countHistory"];
  /** Run the chosen action. The default dispatches the real command. */
  dispatch?: (action: HomeAction, args: HomeArgs) => Promise<number>;
}

/** In a pipe a stalled version or sign-in check must not hold up the next command. */
const SUMMARY_WAIT_MS = 1_500;

async function waitForSummary(settled: Promise<void>, io: HomeIo): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = io.wait
    ? io.wait(SUMMARY_WAIT_MS)
    : new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SUMMARY_WAIT_MS);
      });
  try {
    await Promise.race([settled, bound]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The bare command. With a terminal: the history inventory and a single-key menu in
 * one live region, painted from cheap facts at once and refreshed in place as
 * slower facts land. Without one, or with `--yes`, `--dry-run`, or
 * `--no-follow-up`: the settled summary and the next command, and stdin is
 * never read. Returns the exit code: 130 after Ctrl-C, 0 after `q`.
 */
export async function runHome(input: HomeArgs = {}, io: HomeIo = {}): Promise<number> {
  const args = flowArgs(input);
  const paths = resolvePaths(args);
  const saved = await savedWork(paths.home, args);
  const output = io.output ?? process.stdout;
  const discovery = await startEnvironment(paths, {
    source: args.source,
    project: args.project,
    newerThan: saved.exportedAt,
    io: io.processes,
    countHistory: io.countHistory,
  });
  const choices = openingChoices(discovery.snapshot(), saved, args);
  const terminal = output as TerminalOutput;
  // In a live menu the frame must fit the window: the menu's own rows (a
  // blank, the title, each item, quit, the key hint) come off the height.
  const live = isInteractive(io) && args["follow-up"] !== false && !args.yes && !args["dry-run"];
  const above = () =>
    homeLines(
      discovery.snapshot(),
      args,
      terminalWidth(terminal),
      io,
      live ? frameHeight(terminal) - (choices.length + 4) : undefined,
    );
  let unsubscribe: (() => void) | undefined;
  let answer: HomeAction | "quit" | "interrupt";
  let runnerAvailable: boolean;
  try {
    // The flags are checked before the streams: these modes never touch stdin.
    if (args["follow-up"] === false || args.yes || args["dry-run"] || !canPrompt(io)) {
      await waitForSummary(discovery.settled, io);
      const recommended = candidateChoices(discovery.snapshot(), saved, args)[0]?.key ?? "doctor";
      const { command, tab } = actionCommand(recommended);
      const next = nextCommandText(command, tab ? { ...args, tab } : args);
      output.write(`${above().join("\n")}\n\n${hint(next, lineWidth(terminal))}\n`);
      return 0;
    }
    const quit = { key: "quit", label: "Quit", detail: "q" } as const;
    const menu: MenuChoice<HomeAction | "quit">[] = [...choices, quit];
    let redraw: (() => void) | undefined;
    unsubscribe = discovery.subscribe(() => {
      const next = updatedChoices(choices, discovery.snapshot(), saved, args);
      choices.splice(0, choices.length, ...next);
      menu.splice(0, menu.length, ...next, quit);
      redraw?.();
    });
    answer = await chooseMenuAnswer(
      {
        title: "What would you like to do?",
        choices: menu,
        above,
        onRedraw: (render) => {
          redraw = render;
        },
        settled: discovery.settled,
      },
      io,
    );
    runnerAvailable = canReflect(discovery.snapshot(), args);
  } finally {
    unsubscribe?.();
    discovery.close();
  }

  // The menu already printed its one line for Ctrl-C.
  if (answer === "interrupt") return 130;
  if (answer === "quit") return 0;
  if (io.dispatch) return io.dispatch(answer, args);
  return runAction(answer, args, { output, runnerAvailable, home: paths.home });
}

async function runAction(
  action: HomeAction,
  args: HomeArgs,
  o: { output: Writable; runnerAvailable: boolean; home: string },
): Promise<number> {
  if (action === "scan") {
    runScan(args);
    return 0;
  }
  // Subagents come from the preferences in the session reads. With some
  // saved, the command plans from them. Without any, one run makes them
  // first and writes no prompts: export if needed, read, summarize, then roles.
  const fromScratch = action === "suggest" && !hasSavedPreferences(o.home);
  if (action === "suggest" && !fromScratch) return generateSubagents(args);
  const exported = fs.existsSync(path.join(o.home, "exports", "manifest.json"));
  if (action === "export" || action === "build" || action === "refresh" || !exported) {
    const stats = runExport({ ...args, guided: true, output: o.output });
    if (stats.busy) return 1;
    if (stats.exportedSessions === 0) {
      o.output.write(`${hint(nextCommandText("scan", args))}\n`);
      return 0;
    }
    if (action === "export") {
      o.output.write(`${hint(nextCommandText(o.runnerAvailable ? "reflect" : "doctor", args))}\n`);
      return 0;
    }
  }
  if (fromScratch) return runNextCommand("reflect", { ...args, prompts: false, subagents: true });
  if (action === "build" || action === "refresh") return runNextCommand("reflect", args);
  const { command, tab } = actionCommand(action);
  return runNextCommand(command, tab ? { ...args, tab } : args);
}
