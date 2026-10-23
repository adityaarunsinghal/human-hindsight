import type { Readable, Writable } from "node:stream";
import { type ArgsDef, type CommandDef, runCommand } from "citty";
import { askYesNo } from "../claude/consent.js";
import { hint } from "../ui/style.js";

export type NextCommand =
  | "export"
  | "distill"
  | "gui"
  | "list"
  | "show"
  | "copy"
  | "preferences"
  | "status";
function route<T extends ArgsDef>(load: () => Promise<{ default: CommandDef<T> }>) {
  return async (rawArgs: string[]) => {
    const command = await load();
    await runCommand(command.default, { rawArgs });
  };
}
const routes = {
  export: route(() => import("./export.js")),
  distill: route(() => import("./distill.js")),
  gui: route(() => import("./gui.js")),
  list: route(() => import("./list.js")),
  show: route(() => import("./show.js")),
  copy: route(() => import("./copy.js")),
  preferences: route(() => import("./preferences.js")),
  status: route(() => import("./status.js")),
};
const environments: Record<string, string> = {
  home: "HUMAN_HINDSIGHT_HOME",
  "claude-dir": "CLAUDE_CONFIG_DIR",
  "codex-dir": "CODEX_HOME",
  "kiro-dir": "KIRO_CONFIG_DIR",
  "opencode-dir": "HUMAN_HINDSIGHT_OPENCODE_DIR",
  "opencode-db": "HUMAN_HINDSIGHT_OPENCODE_DB",
  runner: "HUMAN_HINDSIGHT_RUNNER",
  model: "HUMAN_HINDSIGHT_MODEL",
  project: "HUMAN_HINDSIGHT_PROJECT",
};
type FlowOptions = { runner?: string; model?: string; project?: string; "follow-up"?: boolean };

export function flowArgs<T extends object>(input: T): T & FlowOptions {
  const args = { ...input } as Record<string, unknown>;
  for (const key of ["runner", "model", "project"])
    args[key] ??= process.env[environments[key] ?? ""];
  if (args["follow-up"] === undefined && process.env.HUMAN_HINDSIGHT_FOLLOW_UP === "0")
    args["follow-up"] = false;
  return args as T & FlowOptions;
}

/** Forward selection, never action/approval flags such as --yes, --fresh or --apply. */
export function nextArguments(command: NextCommand, input: object): string[] {
  const args = flowArgs(input) as Record<string, unknown>;
  const keys = ["home"];
  if (["export", "distill", "preferences", "status"].includes(command)) {
    keys.push(
      "claude-dir",
      "codex-dir",
      "kiro-dir",
      "opencode-dir",
      "opencode-db",
      "source",
      "project",
    );
  }
  if (["export", "distill", "preferences"].includes(command)) keys.push("runner", "model");
  if (["distill", "preferences"].includes(command)) keys.push("timeout");
  if (command === "distill") keys.push("min-substance", "input-budget", "truncate", "concurrency");
  const result: string[] = [];
  for (const key of keys) {
    const value = args[key] ?? process.env[environments[key] ?? ""];
    if (
      typeof value === "string" &&
      value &&
      !(value === "auto" && (key === "source" || key === "runner"))
    ) {
      result.push(`--${key}=${value}`);
    }
  }
  if (args["follow-up"] === false) result.push("--no-follow-up");
  if ((command === "show" || command === "copy") && typeof args.slug === "string")
    result.push("--", args.slug);
  return result;
}

const quote = (value: string) =>
  /^[\w./:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
export function nextCommandText(command: NextCommand, args: object): string {
  return ["human-hindsight", command, ...nextArguments(command, args).map(quote)].join(" ");
}

export async function offerNext(
  command: NextCommand,
  input: object,
  deps: {
    input?: Readable;
    output?: Writable;
    interactive?: boolean;
    hintPrinted?: boolean;
    run?: (command: NextCommand, args: string[]) => Promise<void>;
  } = {},
): Promise<boolean> {
  const args = flowArgs(input) as Record<string, unknown>;
  const output = deps.output ?? process.stdout;
  if (!deps.hintPrinted) output.write(`${hint(nextCommandText(command, args))}\n`);
  const interactive =
    deps.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!interactive || args["follow-up"] === false || args.yes === true || args["dry-run"] === true)
    return false;
  const question =
    command === "distill"
      ? "Run distill now? You will review the model-call plan before it spends anything."
      : command === "gui"
        ? "Open your prompt library in the browser now?"
        : `Run ${command} now?`;
  if (!(await askYesNo(question, { input: deps.input, output, defaultYes: false }))) return false;
  output.write("\n");
  const argv = nextArguments(command, args);
  if (deps.run) await deps.run(command, argv);
  else {
    process.exitCode = undefined;
    await routes[command](argv);
  }
  return true;
}
