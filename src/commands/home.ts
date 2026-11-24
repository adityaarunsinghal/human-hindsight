import fs from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import pkg from "../../package.json" with { type: "json" };
import {
  type EnvironmentOptions,
  type EnvironmentRow,
  type EnvironmentSnapshot,
  environmentSetupRows,
  readExportSessionShare,
  startEnvironment,
} from "../core/environment.js";
import { suggestionPath } from "../core/subagents.js";
import { writerBusyReason } from "../distill/operations.js";
import type { RunnerIo } from "../runners/shared.js";
import { SOURCE_PRODUCT_NAMES } from "../sources/labels.js";
import { frameHeight } from "../ui/live.js";
import {
  canPrompt,
  isInteractive,
  lineWidth,
  type TerminalOutput,
  terminalWidth,
} from "../ui/mode.js";
import { chooseMenuAnswer, type MenuChoice, type MenuIo } from "../ui/prompt.js";
import { heading, railLine, setupTable } from "../ui/screen.js";
import { counted, dim, hint, visibleWidth } from "../ui/style.js";
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
  plain?: boolean;
  yes?: boolean;
  "dry-run"?: boolean;
};

export type HomeAction =
  | "build"
  | "distill"
  | "gui"
  | "subagents"
  | "prompts"
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
  suggested: boolean;
  /** A distill run stopped before it finished (Ctrl-C, a closed terminal), and no command is running now. */
  interrupted?: boolean;
}

/**
 * A distill run stopped part way: its ledger still lists work as running or
 * waiting, and no command holds the writer lock (a live run is not
 * interrupted). Reads one small file; a damaged ledger counts as no run.
 */
function interruptedRun(home: string): boolean {
  let operations: unknown;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(home, "distill", "operations.json"), "utf8"),
    ) as { operations?: unknown };
    operations = parsed.operations;
  } catch {
    return false;
  }
  if (!Array.isArray(operations)) return false;
  const unfinished = operations.some(
    (op) => op && typeof op === "object" && ["running", "queued"].includes(op.state),
  );
  return unfinished && writerBusyReason(home) === null;
}

/** The menu needs file presence and recency. Opening an artifact performs its full validation. */
function savedWork(home: string, args: HomeArgs): SavedWork {
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
  const suggested = fs.existsSync(suggestionPath(home));
  let library = suggested || fs.existsSync(path.join(dir, "preferences.generalized.json"));
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
    suggested,
    interrupted: exported && interruptedRun(home),
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

function canDistill(snapshot: EnvironmentSnapshot, args: HomeArgs): boolean {
  return snapshot.rows.some(
    (row) =>
      row.name !== "kirocrew" &&
      row.installed &&
      (!args.runner || args.runner === "auto" || args.runner === row.name),
  );
}

function refreshDetail(snapshot: EnvironmentSnapshot): string {
  const fresh = snapshot.totals?.newSessions;
  if (fresh === undefined) return "checking for sessions since your last export";
  if (fresh === 0) return "nothing new since your last export";
  return `${counted(fresh, "new session")} since your last export`;
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
  const ready = writable && canDistill(snapshot, args);
  const refresh: MenuChoice<HomeAction> = {
    key: "refresh",
    label: "Refresh my library",
    detail: refreshDetail(snapshot),
  };
  const finish: MenuChoice<HomeAction> = {
    key: "distill",
    label: "Finish the last run",
    detail: "reuses the work already saved",
  };
  const doctor: MenuChoice<HomeAction> = {
    key: "doctor",
    label: "Check my setup",
    detail: "versions, sign-in, fixes",
  };
  // An interrupted run comes first: finishing it is the one step that keeps its work.
  if (ready && saved.interrupted) choices.push(finish);
  if (saved.suggested) {
    choices.push(
      {
        key: "subagents",
        label: "Open my subagents",
        detail: "in your browser",
      },
      {
        key: "prompts",
        label: "Open my prompt library",
        detail: "in your browser",
      },
    );
    if (ready && saved.exported) choices.push(refresh);
  } else if (saved.library) {
    choices.push({
      key: "gui",
      label: "Open my library",
      detail: "in your browser",
    });
    if (ready) {
      choices.push({
        key: "suggest",
        label: "Generate my subagents",
        detail: "roles from your preferences",
      });
    }
    if (ready && saved.exported) choices.push(refresh);
  } else if (saved.exported) {
    // Without a ready CLI the exported sessions wait on setup, so that comes first.
    if (ready && !saved.interrupted) {
      choices.push({
        key: "distill",
        label: "Distill my exported sessions",
        detail: "review the plan, then build",
      });
    } else if (!ready) {
      choices.push(doctor);
    }
  } else if (ready && history) {
    choices.push({
      key: "build",
      label: "Build my prompt library",
      detail: "export, then a plan you approve",
    });
  }
  if (writable && history) {
    choices.push({
      key: "export",
      label: "Export my prompts only",
      detail: "Markdown, no model calls",
    });
  }
  if (history) {
    choices.push({
      key: "scan",
      label: args.project ? "Show matching projects" : "Show every project",
      detail: "the full inventory",
    });
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

function lastActive(date: Date, now: Date): string {
  return date.toDateString() === now.toDateString()
    ? "today"
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const TAGLINE = "The prompt you'd write if you knew then what you know now.";
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
  if (!canDistill(snapshot, args)) {
    const named = runners.find((row) => row.name === args.runner);
    if (named?.fix)
      return { says: `To build a library through ${named.tool}, run:`, run: named.fix };
    const row = busiestRow(included(snapshot).filter((item) => item.fix && !item.installed));
    const run = row?.fix ?? runners.find((item) => item.fix)?.fix;
    return { says: "Export works now. To build a library, install a coding CLI:", run };
  }
  const installed = runners.filter(
    (row) => row.installed && (!args.runner || args.runner === "auto" || args.runner === row.name),
  );
  const signedOut = installed.filter((row) => row.signIn?.state === "needs-sign-in");
  if (signedOut.length && signedOut.length === installed.length) {
    const row = busiestRow(signedOut.filter((item) => item.included)) ?? signedOut[0];
    if (row?.fix) return { says: "Sign in before building a library:", run: row.fix };
  }
  return undefined;
}

/**
 * A tool row with nothing to say: no command installed and no history (its
 * store is absent, or counted and empty). Such tools are named together on
 * one line instead. A row still being counted, or that could not be read,
 * stays.
 */
function quietRow(row: EnvironmentRow): boolean {
  if (row.historyError) return false;
  const empty = !row.storePresent || (row.history?.exact === true && row.history.sessions === 0);
  // Kiro Crew has no command of its own: it runs through kiro-cli.
  return empty && (row.name === "kirocrew" || !row.installed);
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

/**
 * Lines that leave first when the terminal is short: the tagline, then blank
 * spacers (and the note on what is still being checked, which holds a
 * spacer's place), then sub-headings.
 */
const DROP = { tagline: 1, spacer: 3, heading: 4 } as const;

/**
 * The lines above the menu: heading, the setup table, what is known, one fix,
 * privacy. With `height`, optional lines (the tagline, blank spacers, the
 * section headings) are left out until the lines fit, so the title and the
 * live menu stay on one screen.
 */
function homeLines(
  snapshot: EnvironmentSnapshot,
  args: HomeArgs,
  width: number,
  now: Date = new Date(),
  o: { saved?: SavedWork; height?: number } = {},
): string[] {
  // A live region leaves the last column free, so prose wraps one column early.
  const usable = Math.max(20, width - 1);
  // The tagline is left out where it would be cut off; the rail adds two columns.
  const tagline = visibleWidth(TAGLINE) + 2 <= usable ? TAGLINE : undefined;
  const [title = "", subtitle] = heading(`Human Hindsight ${pkg.version}`, tagline).split("\n");
  const lines: HomeLine[] = [{ text: title }];
  if (subtitle) lines.push({ text: subtitle, drop: DROP.tagline });
  // The rail runs unbroken down the card: headings, the table, prose, and the
  // blank lines between them all carry it. The menu below stands apart.
  lines.push({ text: railLine(), drop: DROP.spacer });
  lines.push({ text: heading("Your coding tools on this machine"), drop: DROP.heading });
  const shown = snapshot.rows.filter((row) => !quietRow(row));
  const quiet = snapshot.rows.filter((row) => quietRow(row) && row.name !== "kirocrew");
  const empty = noHistory(snapshot);
  if (shown.length) {
    // Room for facts still to come matters only to a frame that is redrawn;
    // a table printed once, after the facts settle, is measured as it is.
    let cells = environmentSetupRows(
      { ...snapshot, rows: shown },
      { live: o.height !== undefined },
    );
    // Narrower than 80 columns a cell holding both counts would wrap; the
    // total below still gives the projects.
    if (width < 80) {
      const sessionsOnly = (text: string) => text.replace(/^[\d,]+ projects? · /, "");
      cells = cells.map((cell) => ({
        ...cell,
        history: sessionsOnly(cell.history),
        reserve: cell.reserve && {
          ...cell.reserve,
          history: cell.reserve.history && sessionsOnly(cell.reserve.history),
        },
      }));
    }
    const table = setupTable(cells, width);
    lines.push(...table.map((text) => ({ text })));
  }
  // The rail and its space take two columns.
  const inner = Math.max(18, usable - 2);
  const prose = (text: string, style: (s: string) => string = (s) => s, drop?: number) =>
    lines.push(...wrapText(text, inner).map((line) => ({ text: railLine(style(line)), drop })));
  // The empty state names every tool itself; elsewhere the quiet ones share a line.
  if (quiet.length && shown.length && !empty) {
    const names = quiet.map((row) => row.tool);
    const list =
      names.length > 2
        ? `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`
        : names.join(" or ");
    prose(`No history or command found for ${list}.`, dim);
  }
  const total = snapshot.totals;
  if (empty) {
    if (args.project || (args.source && args.source !== "auto")) {
      prose("No history matches this selection.");
      prose("To see every project, run human-hindsight scan");
    } else {
      prose("No session history found on this machine yet.");
      prose(`Looked for ${toolList.replace(/, or ([^,]+)$/, ", and $1")}.`);
      prose("Kept somewhere else? Pass its folder, for example --claude-dir <dir>.");
      prose("Every folder option: human-hindsight help --all");
    }
  } else if (total && total.sessions > 0) {
    const latest = total.newest ? ` Newest activity: ${lastActive(total.newest, now)}.` : "";
    prose(
      `${counted(total.sessions, "session")} across ${counted(total.projects, "project")}.${latest}`,
    );
  }
  if (o.saved?.interrupted) {
    prose("The last distill run stopped before it finished. Its progress is saved.");
  }
  const fix = homeFix(snapshot, args);
  if (fix) {
    // The command is alone on its own line, whole, so it can be copied. A
    // live frame cuts a row at the width, so `a && b` that does not fit is
    // shown as its two commands, one per line, each still whole.
    const steps =
      fix.run && visibleWidth(fix.run) + 2 > inner
        ? fix.run.split(" && ")
        : fix.run
          ? [fix.run]
          : [];
    // The command lines carry no rail: a line picked up whole with the mouse
    // must be the command and nothing else.
    lines.push(...wrapText(fix.says, inner).map((text) => ({ text: railLine(text) })));
    lines.push(...steps.map((step) => ({ text: `  ${step}` })));
  }
  // What is still being checked takes the place of the blank line above the
  // next heading, so the frame does not move up when it is done.
  if (snapshot.pending.length)
    prose(`Still checking ${snapshot.pending.join(", ")}.`, dim, DROP.spacer);
  else lines.push({ text: railLine(), drop: DROP.spacer });
  lines.push({ text: heading("Private by default"), drop: DROP.heading });
  prose("No session text leaves this machine until you approve a plan.");
  // Exactly what this screen runs. What those status commands do is up to
  // each tool: Kiro CLI's may also contact its own service when it can.
  prose("This screen only asks your coding tools for their version and sign-in status.");
  return fitLines(lines, o.height);
}

/** The command behind an action, with the tab it opens on. */
function actionCommand(action: HomeAction): { command: NextCommand; tab?: string } {
  if (action === "build" || action === "refresh") return { command: "export" };
  if (action === "suggest") return { command: "suggest-subagents" };
  if (action === "subagents") return { command: "gui", tab: "subagents" };
  if (action === "prompts") return { command: "gui", tab: "prompts" };
  return { command: action };
}

/** Probes, history counting, the clock, and dispatch are injected so tests run no command. */
export interface HomeIo extends MenuIo {
  processes?: RunnerIo;
  countHistory?: EnvironmentOptions["countHistory"];
  now?: () => Date;
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
 * The bare command. With a terminal: the setup table and a single-key menu in
 * one live region, painted from cheap facts at once and refreshed in place as
 * slower facts land. Without one, or with `--yes`, `--dry-run`, or
 * `--no-follow-up`: the settled summary and the next command, and stdin is
 * never read. Returns the exit code: 130 after Ctrl-C, 0 after `q`.
 */
export async function runHome(input: HomeArgs = {}, io: HomeIo = {}): Promise<number> {
  const args = flowArgs(input);
  const paths = resolvePaths(args);
  const saved = savedWork(paths.home, args);
  const output = io.output ?? process.stdout;
  const now = io.now ?? (() => new Date());
  const discovery = await startEnvironment(paths, {
    source: args.source,
    project: args.project,
    newerThan: saved.exportedAt,
    io: io.processes,
    countHistory: io.countHistory,
  });
  const choices = openingChoices(discovery.snapshot(), saved, args);
  const recommended = choices[0]?.key ?? "doctor";
  const terminal = output as TerminalOutput;
  // In a live menu the frame must fit the window: the menu's own rows (a
  // blank, the title, each item, quit, the key hint) come off the height.
  const live = isInteractive(io);
  const above = () =>
    homeLines(discovery.snapshot(), args, terminalWidth(terminal), now(), {
      saved,
      height: live ? frameHeight(terminal) - (choices.length + 4) : undefined,
    });
  let unsubscribe: (() => void) | undefined;
  let answer: HomeAction | "quit" | "interrupt";
  let runnerAvailable: boolean;
  try {
    // The flags are checked before the streams: these modes never touch stdin.
    if (args["follow-up"] === false || args.yes || args["dry-run"] || !canPrompt(io)) {
      await waitForSummary(discovery.settled, io);
      const { command, tab } = actionCommand(recommended);
      const next = nextCommandText(command, tab ? { ...args, tab } : args);
      output.write(`${above().join("\n")}\n\n${hint(next, lineWidth(terminal))}\n`);
      return 0;
    }
    let redraw: (() => void) | undefined;
    unsubscribe = discovery.subscribe(() => {
      const next = updatedChoices(choices, discovery.snapshot(), saved, args);
      choices.splice(0, choices.length, ...next);
      redraw?.();
    });
    answer = await chooseMenuAnswer(
      {
        title: "What would you like to do?",
        choices,
        above,
        onRedraw: (render) => {
          redraw = render;
        },
        settled: discovery.settled,
      },
      io,
    );
    runnerAvailable = canDistill(discovery.snapshot(), args);
  } finally {
    unsubscribe?.();
    discovery.close();
  }

  // The menu already printed its one line for Ctrl-C.
  if (answer === "interrupt") return 130;
  if (answer === "quit") return 0;
  if (io.dispatch) return io.dispatch(answer, args);
  return runAction(answer, args, { output, runnerAvailable });
}

async function runAction(
  action: HomeAction,
  args: HomeArgs,
  o: { output: Writable; runnerAvailable: boolean },
): Promise<number> {
  if (action === "scan") {
    runScan(args);
    return 0;
  }
  if (action === "suggest") return generateSubagents(args);
  if (action === "export" || action === "build" || action === "refresh") {
    const stats = runExport({ ...args, guided: true, output: o.output });
    if (stats.exportedSessions === 0) {
      o.output.write(`${hint(nextCommandText("scan", args))}\n`);
      return 0;
    }
    if (action === "export") {
      o.output.write(`${hint(nextCommandText(o.runnerAvailable ? "distill" : "doctor", args))}\n`);
      return 0;
    }
    return runNextCommand("distill", args);
  }
  const { command, tab } = actionCommand(action);
  return runNextCommand(command, tab ? { ...args, tab } : args);
}
