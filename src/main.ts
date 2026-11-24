import type { Writable } from "node:stream";
import { type CommandDef, defineCommand, parseArgs, type SubCommandsDef } from "citty";
import pkg from "../package.json" with { type: "json" };
import { flagEnvironments, homeArgs, publishedVariables, sharedArgs } from "./commands/_shared.js";
import copy from "./commands/copy.js";
import reflect from "./commands/distill.js";
import doctor from "./commands/doctor.js";
import edit from "./commands/edit.js";
import exportCmd from "./commands/export.js";
import gui from "./commands/gui.js";
import help, { commandIndex, withHelpVisibility } from "./commands/help.js";
import { runHome } from "./commands/home.js";
import list from "./commands/list.js";
import preferences from "./commands/preferences.js";
import prune from "./commands/prune.js";
import rate from "./commands/rate.js";
import retention from "./commands/retention.js";
import scan from "./commands/scan.js";
import show from "./commands/show.js";
import status from "./commands/status.js";
import suggestSubagents from "./commands/suggest-subagents.js";
import { PlainFailure } from "./core/plain-failure.js";
import { resolveDefinition } from "./ui/help.js";

/** Nested commands resolve explicit selections before their usual environment defaults. */
function publishRootOptions(args: Record<string, unknown>): void {
  for (const [flag, envVar] of Object.entries(flagEnvironments)) {
    const value = args[flag];
    if (typeof value === "string" && value !== "") {
      process.env[envVar] = value;
      publishedVariables.add(envVar);
    }
  }
  if (typeof args["follow-up"] === "boolean")
    process.env.HUMAN_HINDSIGHT_FOLLOW_UP = args["follow-up"] ? "1" : "0";
  if (typeof args.plain === "boolean") process.env.HUMAN_HINDSIGHT_PLAIN = args.plain ? "1" : "0";
}

/**
 * Citty passes a child only the tokens following its name. Put leading shared
 * selections in that slice as well. This matters when a command interprets
 * --model for its own stage or reads --source directly from its parsed args.
 */
export function forwardRootFlags(raw: string[]): string[] {
  const index = commandIndex(raw, sharedArgs);
  const command = raw[index];
  if (index <= 0 || command === undefined) return raw;
  return [command, ...raw.slice(0, index), ...raw.slice(index + 1)];
}

/**
 * A message about what the person typed starts with the option it is about,
 * as `unknown --source "x" (expected claude, ...)` and `--recent must be ...`
 * do. Such a message is the whole story; anything else is a failure to report.
 */
const OPTION_PROBLEM = /^(?:unknown |invalid )?--[a-z][\w-]*\b/i;

/**
 * What the person sees when a command throws: never a stack trace. A wrong
 * option value or a {@link PlainFailure} (a damaged file, say) is one plain
 * line. Anything else is a crash: one line and how to see more, which
 * `HUMAN_HINDSIGHT_DEBUG=1` prints in full. The exit code is 1.
 */
export function reportFailure(
  error: unknown,
  o: { env?: NodeJS.ProcessEnv; stderr?: Writable } = {},
): void {
  const env = o.env ?? process.env;
  const stderr = o.stderr ?? process.stderr;
  process.exitCode = 1;
  if (env.HUMAN_HINDSIGHT_DEBUG === "1") {
    stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return;
  }
  const text = error instanceof Error ? error.message : String(error);
  const message =
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? "unexpected failure";
  if (error instanceof PlainFailure || OPTION_PROBLEM.test(message))
    stderr.write(`error: ${message}\n`);
  else stderr.write(`error: ${message}\nRun with HUMAN_HINDSIGHT_DEBUG=1 for details.\n`);
}

/** The same run, with its failures reported by {@link reportFailure}. */
function guardedRun<C>(run: (context: C) => unknown): (context: C) => Promise<unknown> {
  return async (context) => {
    try {
      return await run(context);
    } catch (error) {
      reportFailure(error);
    }
  };
}

/**
 * Every command is dispatched through here, so no command can let an error
 * reach the argument parser, which would print it with its stack.
 */
export function guardCommands(commands: SubCommandsDef): SubCommandsDef {
  const result: SubCommandsDef = {};
  for (const [name, entry] of Object.entries(commands)) {
    result[name] = async () => {
      const def = await resolveDefinition<CommandDef>(entry);
      return def.run ? { ...def, run: guardedRun(def.run) } : def;
    };
  }
  return result;
}

export const main = defineCommand({
  meta: {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
  },
  args: { ...sharedArgs },
  setup({ args }) {
    publishRootOptions(args);
  },
  subCommands: guardCommands(
    withHelpVisibility({
      scan,
      doctor,
      help,
      export: exportCmd,
      reflect,
      list,
      show,
      copy,
      edit,
      rate,
      prune,
      status,
      preferences,
      "suggest-subagents": suggestSubagents,
      retention,
      gui,
    }),
  ),
  run: guardedRun(async ({ args, rawArgs }) => {
    // citty invokes the root run() even after dispatching a subcommand, so we
    // must decide whether this invocation was bare. Use the PARSED positionals
    // (args._): a raw-args scan can't tell a subcommand token from an option
    // VALUE (`--claude-dir /path`: the value doesn't start with "-"), but the
    // parser is schema-aware and has already consumed string-flag values, so a
    // non-empty args._ means a real positional/subcommand was given.
    if (Array.isArray(args._) && args._.length > 0) return;
    // The home screen's own options are not shared with the commands, so they
    // are read here rather than declared on the root.
    const own = parseArgs(rawArgs, { ...sharedArgs, ...homeArgs });
    const code = await runHome({ ...args, yes: own.yes, "dry-run": own["dry-run"] });
    if (code !== 0) process.exitCode = code;
  }),
});
