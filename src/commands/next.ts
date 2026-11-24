import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { type ArgsDef, type CommandDef, runCommand } from "citty";
import { isPlanLabel } from "../core/model-plan.js";
import { askYesNoAnswer } from "../distill/consent.js";
import { resolveOpenCodePaths } from "../sources/opencode/paths.js";
import type { TerminalHost } from "../ui/live.js";
import { canPrompt } from "../ui/mode.js";
import { chooseMenuAnswer, type MenuIo } from "../ui/prompt.js";
import { hint } from "../ui/style.js";
import { flagEnvironments, ownEnvironment, resolveDataHome, resolvePaths } from "./_shared.js";

export type NextCommand =
  | "scan"
  | "doctor"
  | "export"
  | "reflect"
  | "distill"
  | "gui"
  | "list"
  | "show"
  | "copy"
  | "preferences"
  | "suggest-subagents"
  | "prune"
  | "retention"
  | "status";
function canonicalCommand(command: NextCommand) {
  return command === "distill" ? "reflect" : command;
}

function route<T extends ArgsDef>(load: () => Promise<{ default: CommandDef<T> }>) {
  return async (rawArgs: string[]) => {
    const command = await load();
    await runCommand(command.default, { rawArgs });
  };
}
const routes = {
  scan: route(() => import("./scan.js")),
  doctor: route(() => import("./doctor.js")),
  export: route(() => import("./export.js")),
  reflect: route(() => import("./distill.js")),
  gui: route(() => import("./gui.js")),
  list: route(() => import("./list.js")),
  show: route(() => import("./show.js")),
  copy: route(() => import("./copy.js")),
  preferences: route(() => import("./preferences.js")),
  "suggest-subagents": route(() => import("./suggest-subagents.js")),
  prune: route(() => import("./prune.js")),
  retention: route(() => import("./retention.js")),
  status: route(() => import("./status.js")),
};
type FlowOptions = {
  runner?: string;
  model?: string;
  "cluster-model"?: string;
  "author-model"?: string;
  project?: string;
  source?: string;
  quality?: string;
  recent?: string;
  plain?: boolean;
  "follow-up"?: boolean;
};

export function flowArgs<T extends object>(input: T): T & FlowOptions {
  const args = { ...input } as Record<string, unknown>;
  for (const key of [
    "runner",
    "model",
    "cluster-model",
    "author-model",
    "project",
    "quality",
    "recent",
  ]) {
    args[key] ??= process.env[flagEnvironments[key] ?? ""];
  }
  if (args.plain === undefined && process.env.HUMAN_HINDSIGHT_PLAIN === "1") args.plain = true;
  if (args["follow-up"] === undefined && process.env.HUMAN_HINDSIGHT_FOLLOW_UP === "0")
    args["follow-up"] = false;
  return args as T & FlowOptions;
}

/** A stage of distill that strict retry can run again. */
export type RetryStage = "digest" | "cluster" | "author";

export interface NextOptions {
  /** Strict retry of this distill stage instead of the command. */
  retry?: RetryStage;
  /**
   * The arguments of a command run in this process for the person, not
   * printed: they keep the follow-up opt-out and every folder as given.
   */
  dispatch?: boolean;
  /**
   * The command whose run prints the hint, when its options mean something of
   * its own. From suggest-subagents, its model, size, and time options are
   * kept for suggest-subagents and left out of every other command.
   */
  from?: "suggest-subagents";
}

/** The options suggest-subagents reads for its own stages, under names distill also uses. */
const SUBAGENT_SELECTIONS = [
  "model",
  "cluster-model",
  "propose-model",
  "author-model",
  "concurrency",
  "timeout",
  "min-roles",
  "max-roles",
  "input-budget",
  "window-size",
] as const;

/**
 * The arguments of a command printed for the person to run next, or run for
 * them: every hint, the whole-plan command, the line after Ctrl-C, and strict
 * retry are built here, so each reproduces the choices of this run (quick
 * start, quality, the pinned CLI and models, the folders, the distill
 * switches). Selections only, never action or approval flags such as --yes,
 * --fresh, or --apply.
 *
 * `retry` builds strict retry for a stage instead. Strict retry reads the
 * run's recorded settings itself and ignores the environment, so its hint
 * carries only what was given explicitly, and only the options valid for it.
 */
export function nextArguments(name: NextCommand, input: object, o: NextOptions = {}): string[] {
  const command = canonicalCommand(name);
  if (o.retry) return retryArguments(o.retry, input as Record<string, unknown>);
  const args = flowArgs(input) as Record<string, unknown>;
  const own: string[] = [];
  if (o.from === "suggest-subagents") {
    // Its own selections reach only its own command. Elsewhere they are
    // blanked, which also keeps the variables a shared --model set from
    // filling them in.
    for (const key of SUBAGENT_SELECTIONS) {
      const value = args[key];
      if (command === "suggest-subagents" && typeof value === "string" && value)
        if (!(key.endsWith("model") && isPlanLabel(value))) own.push(`--${key}=${value}`);
      args[key] = "";
    }
    if (command === "suggest-subagents" && args["include-unreviewed"] === true)
      own.push("--include-unreviewed");
  }
  const keys = ["home"];
  if (
    ["scan", "doctor", "export", "reflect", "preferences", "status", "retention"].includes(command)
  ) {
    keys.push(
      "claude-dir",
      "codex-dir",
      "kiro-dir",
      "kirocrew-dir",
      "opencode-dir",
      "opencode-db",
      "source",
    );
    if (command !== "retention") keys.push("project");
  }
  if (["export", "reflect", "preferences"].includes(command)) keys.push("runner", "model");
  if (["export", "reflect", "preferences", "suggest-subagents"].includes(command)) {
    keys.push("quality");
  }
  if (["export", "reflect"].includes(command)) keys.push("recent");
  // Its --model selects the generalize stage, not distillation, so only the
  // runner carries over.
  if (command === "suggest-subagents" || command === "doctor") keys.push("runner");
  if (command === "gui") keys.push("tab");
  if (["reflect", "preferences"].includes(command)) keys.push("timeout");
  if (command === "reflect")
    keys.push(
      "min-substance",
      "input-budget",
      "truncate",
      "concurrency",
      "cluster-model",
      "author-model",
      "cluster-batch-size",
    );
  const result: string[] = [];
  const defaults = o.dispatch ? undefined : defaultFolders();
  for (const key of keys) {
    const value = args[key] ?? process.env[flagEnvironments[key] ?? ""];
    if (
      typeof value === "string" &&
      value &&
      !(key.endsWith("model") && isPlanLabel(value)) &&
      // An explicit --runner=auto on reflect selects automatic fallback instead of the CLI chooser.
      !(value === "auto" && (key === "source" || (key === "runner" && command !== "reflect"))) &&
      // A printed command names a folder only when leaving it out would change it.
      !(defaults && isDefaultFolder(key, value, args, defaults))
    ) {
      result.push(`--${key}=${value}`);
    }
  }
  // The distill switches that change what a run does, as typed.
  if (command === "reflect") {
    if (args.group === false) result.push("--no-group");
    if (args.prompts === false) result.push("--no-prompts");
    if (args.subagents === true) result.push("--subagents");
    if (args.generalize === false) result.push("--no-generalize");
    if (args.breaker === false) result.push("--no-breaker");
  }
  result.push(...own);
  if (args.plain === true) result.push("--plain");
  // A printed command is one the person runs by choice: no opt-out on it.
  if (o.dispatch && args["follow-up"] === false) result.push("--no-follow-up");
  if ((command === "show" || command === "copy") && typeof args.slug === "string")
    result.push("--", args.slug);
  return result;
}

/** The folders a command would use with none of them given, in the person's own environment. */
function defaultFolders(): Record<string, string> {
  const env = ownEnvironment();
  const paths = resolvePaths({}, env);
  return {
    home: resolveDataHome(undefined, { env }),
    "claude-dir": paths.claudeDir,
    "codex-dir": paths.codexDir,
    "kiro-dir": paths.kiroDir,
    "kirocrew-dir": paths.kirocrewDir,
    "opencode-dir": paths.opencodeDir,
    "opencode-db": paths.opencodeDb,
  };
}

/**
 * `--home=<dir>` for a command printed outside {@link nextArguments} (the
 * prune hint, the line after Ctrl-C in a retry), by the same rule: left out
 * when the person's own environment already selects that folder.
 */
export function printedHome(home: string): string[] {
  return isDefaultFolder("home", home, {}, defaultFolders()) ? [] : [`--home=${home}`];
}

function isDefaultFolder(
  key: string,
  value: string,
  args: Record<string, unknown>,
  defaults: Record<string, string>,
): boolean {
  const fallback = defaults[key];
  if (fallback === undefined) return false;
  // The database file is named relative to the OpenCode folder.
  const resolved =
    key === "opencode-db"
      ? resolveOpenCodePaths(
          {
            dir: typeof args["opencode-dir"] === "string" ? args["opencode-dir"] : undefined,
            db: value,
          },
          ownEnvironment(),
        ).opencodeDb
      : path.resolve(value);
  return resolved === path.resolve(fallback);
}

function retryArguments(stage: RetryStage, input: Record<string, unknown>): string[] {
  const selected = [
    "home",
    "runner",
    "quality",
    "model",
    "timeout",
    "input-budget",
    "truncate",
    "concurrency",
  ];
  if (stage === "cluster") selected.push("cluster-model");
  if (stage === "author") selected.push("author-model");
  const result: string[] = [];
  for (const key of selected) {
    const value = input[key];
    if (typeof value !== "string" || !value) continue;
    if (key.endsWith("model") && isPlanLabel(value)) continue;
    if (key !== "runner" || value !== "auto") result.push(`--${key}=${value}`);
  }
  if (input.plain === true) result.push("--plain");
  result.push("--retry-failed", `--retry-stage=${stage}`);
  return result;
}

const isControl = (c: string) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f;

/**
 * One shell word. A value with a control character (a newline in a folder
 * name) uses `$'...'` escapes, so the printed command stays on one line and
 * can be copied whole, and nothing in it reaches the terminal as a control code.
 */
export const shellWord = (value: string) => {
  if (/^[\w./:=+-]+$/.test(value)) return value;
  if (![...value].some(isControl)) return `'${value.replaceAll("'", "'\\''")}'`;
  const named: Record<string, string> = { "\n": "\\n", "\t": "\\t", "\r": "\\r" };
  const escaped = [...value]
    .map((c) => {
      if (c === "\\" || c === "'") return `\\${c}`;
      if (!isControl(c)) return c;
      return named[c] ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;
    })
    .join("");
  return `$'${escaped}'`;
};
export function nextCommandText(command: NextCommand, args: object, o: NextOptions = {}): string {
  return [
    "npx",
    "human-hindsight",
    canonicalCommand(command),
    ...nextArguments(command, args, o).map(shellWord),
  ].join(" ");
}

/** Strict retry of one stage: {@link nextCommandText} in its retry form. */
export function retryCommandText(stage: RetryStage, input: object): string {
  return nextCommandText("reflect", input, { retry: stage });
}

/** Dispatch an action the person already selected, keeping each command's own consent gate. */
export async function runNextCommand(command: NextCommand, args: object): Promise<number> {
  process.exitCode = undefined;
  await routes[canonicalCommand(command)](nextArguments(command, args, { dispatch: true }));
  return Number(process.exitCode ?? 0);
}

function allowsFollowUp(args: Record<string, unknown>): boolean {
  return args["follow-up"] !== false && args.yes !== true && args["dry-run"] !== true;
}

/** Run one command; tests pass their own so nothing real is started. */
export type CommandRunner = (command: NextCommand, args: object) => Promise<number>;

/**
 * Generate subagents through that command's own plan and consent. The command
 * ends with its own closing menu (open the Subagents view, export, done), so
 * nothing else is opened from here. A generation that is declined, fails, or
 * finds no preferences ends at its own result and exit code.
 */
export async function generateSubagents(
  input: { home?: string },
  run: CommandRunner = runNextCommand,
): Promise<number> {
  return run("suggest-subagents", input);
}

/**
 * The closing menu after a successful distill: open the library, generate
 * subagents, or finish. Returns the exit code: 130 after Ctrl-C (the menu
 * printed its one line), otherwise that of the chosen command.
 */
export async function offerLibraryNext(
  input: object,
  io: MenuIo = {},
  run: CommandRunner = runNextCommand,
): Promise<number> {
  const args = flowArgs(input) as Record<string, unknown> & { home?: string };
  const output = io.output ?? process.stdout;
  const browser = { ...args, tab: "preferences" };
  // Check the flags before the streams: `--yes` and `--dry-run` must never touch stdin.
  if (!allowsFollowUp(args) || !canPrompt(io)) {
    output.write(`${hint(nextCommandText("gui", browser))}\n`);
    // The suggested next step is the free preview, as in preferences and help.
    output.write(`${hint(`${nextCommandText("suggest-subagents", args)} --dry-run`)}\n`);
    return 0;
  }
  const choice = await chooseMenuAnswer(
    {
      title: "What next?",
      choices: [
        {
          key: "gui",
          label: "Open my reflections",
          detail: "in the browser",
          recommended: true,
        },
        {
          key: "suggest",
          label: "Suggest subagents",
          detail: "roles from my preferences",
        },
        { key: "done", label: "Done for now" },
      ],
    },
    io,
  );
  if (choice === "interrupt") return 130;
  if (choice === "gui") return run("gui", browser);
  if (choice === "suggest") return generateSubagents(args, run);
  return 0;
}

export async function offerNext(
  name: NextCommand,
  input: object,
  deps: {
    input?: Readable;
    output?: Writable;
    interactive?: boolean;
    hintPrinted?: boolean;
    /** Where Ctrl-C arrives (default `process`). */
    host?: TerminalHost;
    run?: (command: NextCommand, args: string[]) => Promise<void>;
  } = {},
): Promise<boolean> {
  const args = flowArgs(input) as Record<string, unknown>;
  const command = canonicalCommand(name);
  const output = deps.output ?? process.stdout;
  if (!deps.hintPrinted) output.write(`${hint(nextCommandText(command, args))}\n`);
  // Check the flags before the streams: `--yes` and `--dry-run` must never touch stdin.
  if (!allowsFollowUp(args)) return false;
  if (!(deps.interactive ?? canPrompt(deps))) return false;
  const question =
    command === "reflect" || command === "suggest-subagents"
      ? `Run ${command} now? You will review the model-call plan before it spends anything.`
      : command === "gui"
        ? "Open your reflections in the browser now?"
        : `Run ${command} now?`;
  const answer = await askYesNoAnswer(question, {
    input: deps.input,
    output,
    host: deps.host,
    defaultYes: false,
  });
  if (answer === "interrupt") {
    // Ctrl-C means 130 everywhere. The calling command has finished its own
    // work, so the code is left for the process to exit with.
    output.write("Interrupted.\n");
    process.exitCode = 130;
    return false;
  }
  if (answer !== "yes") return false;
  output.write("\n");
  if (deps.run) await deps.run(command, nextArguments(command, args));
  else await runNextCommand(command, args);
  return true;
}
