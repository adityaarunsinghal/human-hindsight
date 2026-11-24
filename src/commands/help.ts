import type { Writable } from "node:stream";
import {
  type ArgDef,
  type ArgsDef,
  type CommandMeta,
  defineCommand,
  type RunMainOptions,
  type SubCommandsDef,
} from "citty";
import { INPUT_BUDGET_RULE, TIMEOUT_RULE, TRUNCATE_RULE } from "../core/budget.js";
import { parseQuality } from "../core/model-plan.js";
import { type ValueRule, valueProblem } from "../core/value-rule.js";
import { WINDOW_SIZE_RULE } from "../distill/generalize.js";
import { RUNNER_INFO } from "../runners/capabilities.js";
import { parseRunnerMode } from "../runners/registry.js";
import { SOURCE_PRODUCT_NAMES } from "../sources/labels.js";
import { parseSourceMode } from "../sources/registry.js";
import {
  fullHelpArg,
  type HelpDefinition,
  type HelpTopic,
  renderCommandHelp,
  renderFullHelp,
  renderShortHelp,
  resolveDefinition,
} from "../ui/help.js";
import { closestMatch } from "../ui/suggest.js";
import {
  CLUSTER_BATCH_RULE,
  CONCURRENCY_RULE,
  FILE_RULE,
  FOLDER_RULE,
  flagEnvironments,
  homeArgs,
  MIN_MESSAGES_RULE,
  RECENT_RULE,
  sharedArgs,
} from "./_shared.js";
import { PORT_RULE, TAB_RULE } from "./gui.js";
import { ROLE_COUNT_RULE } from "./suggest-subagents.js";

function example(command: string, note: string): { run: string; note: string } {
  return { run: `human-hindsight ${command}`, note };
}

export const helpTopics: HelpTopic[] = [
  {
    name: "scan",
    summary: "Find projects and sessions on this machine.",
    group: "everyday",
    examples: [
      example("scan", "List projects across the tools you use."),
      example("scan --source codex", "Read only Codex history."),
    ],
    common: ["source", "follow-up"],
  },
  {
    name: "export",
    summary: "Save your messages from coding sessions as Markdown.",
    group: "everyday",
    examples: [
      example("export", "Export your messages from all available histories on this machine."),
      example("export --project my-app", "Export one project. Use its name from scan."),
    ],
    common: ["project", "source", "min-messages"],
  },
  {
    name: "distill",
    summary: "Build a prompt library from your exported sessions.",
    group: "everyday",
    examples: [
      example("distill --dry-run", "Preview the plan before sending any session text."),
      example("distill --recent 10", "Start with your ten most recent eligible sessions."),
      example("distill --quality best", "Review the plan using the most capable available models."),
    ],
    common: ["dry-run", "recent", "quality", "project"],
  },
  {
    name: "gui",
    summary: "Open your library in a browser.",
    group: "everyday",
    examples: [
      example("gui", "Browse prompts, working preferences, and suggested subagents."),
      example("gui --tab preferences", "Open directly to your working preferences."),
      example("gui --no-open --port 8765", "Print the address and use a specific port."),
    ],
    common: ["tab", "open", "port"],
  },
  {
    name: "status",
    summary: "See what has finished and what to run next.",
    group: "everyday",
    examples: [
      example("status", "See how many sessions have become library prompts."),
      example("status --home ./hindsight-data", "Check a library in a different data directory."),
    ],
    common: ["home", "follow-up"],
  },
  {
    name: "doctor",
    summary: "Check your history, installed tools, and sign-in hints.",
    group: "start",
    examples: [
      example("doctor", "See which tools are installed and how to fix setup problems."),
      example("doctor --home ./hindsight-data", "Check the data directory you plan to use."),
    ],
    common: ["home"],
  },
  {
    name: "list",
    summary: "List saved prompts and the names you can use to open them.",
    group: "step",
    examples: [
      example("list", "Find a prompt by title and the name that opens it."),
      example("list --no-follow-up", "Print the library table and finish."),
    ],
    common: ["home", "follow-up"],
  },
  {
    name: "show",
    summary: "Read a saved prompt in your terminal.",
    group: "step",
    examples: [
      example("show review-changes", "Replace review-changes with a name from list."),
      example("show review-changes --raw", "Print the prompt body as Markdown."),
    ],
    common: ["raw", "follow-up"],
  },
  {
    name: "copy",
    summary: "Copy a prompt to paste into a new coding session.",
    group: "step",
    examples: [
      example("copy review-changes", "Copy the prompt body. Use a name from list."),
      example("copy review-changes --no-follow-up", "Copy the prompt and return to the shell."),
    ],
    common: ["home", "follow-up"],
  },
  {
    name: "edit",
    summary: "Edit a saved prompt in your preferred text editor.",
    group: "more",
    examples: [
      example(
        "edit review-changes",
        "Use a name from list. Later runs keep your edits by default.",
      ),
      example("edit review-changes --no-follow-up", "Return to the shell when the editor closes."),
    ],
    common: ["home", "follow-up"],
  },
  {
    name: "rate",
    summary: "Record whether a saved prompt worked for you.",
    group: "more",
    examples: [
      example("rate review-changes up", "Give a positive rating. Use a name from list."),
      example("rate review-changes down", "Record a negative rating for that prompt."),
    ],
    common: ["home", "follow-up"],
  },
  {
    name: "preferences",
    summary: "Print accepted working preferences for your instruction file.",
    group: "step",
    examples: [
      example("preferences --target codex", "Format your accepted instructions for AGENTS.md."),
      example("preferences --project my-app", "Include accepted rules for this project."),
    ],
    common: ["target", "project", "include-unreviewed"],
  },
  {
    name: "suggest-subagents",
    summary: "Generate specialist subagents from your working preferences.",
    group: "step",
    examples: [
      example(
        "suggest-subagents --dry-run",
        "Preview the preferences and model calls in the plan.",
      ),
      example("suggest-subagents", "Review the plan and generate a set of specialist roles."),
      example("suggest-subagents --export ./my-subagents", "Write the saved roles to a directory."),
    ],
    common: ["dry-run", "quality", "export", "target"],
  },
  {
    name: "prune",
    summary: "Remove library entries left behind when sessions were regrouped.",
    group: "more",
    examples: [
      example("prune --dry-run", "Preview the entries eligible for removal."),
      example("prune", "Review the list and confirm before anything is removed."),
    ],
    common: ["dry-run", "force"],
  },
  {
    name: "retention",
    summary: "Preview or apply settings that keep local session history longer.",
    group: "more",
    examples: [
      example("retention", "See the settings available for your installed tools."),
      example("retention --source claude --apply", "Review and confirm changes for Claude Code."),
    ],
    common: ["source", "apply", "dry-run"],
  },
  {
    name: "help",
    summary: "Read examples or look up every command and option.",
    group: "start",
    examples: [
      example("help distill", "See examples and common options for building your library."),
      example("help --all", "Read the complete command reference."),
    ],
    common: ["all"],
  },
];

/**
 * Each command's one-line summary lives in its help topic. Registration copies
 * it into the command's own description, so the short help, the command page,
 * the full reference, and citty all read the same words. Commands outside the
 * first-run and everyday groups are hidden from citty's short listing but stay
 * routable and present in the full reference.
 */
export function withHelpVisibility(commands: SubCommandsDef): SubCommandsDef {
  const result = { ...commands };
  for (const [name, entry] of Object.entries(commands)) {
    const topic = helpTopics.find((item) => item.name === name);
    if (!topic) continue;
    const hidden = topic.group === "step" || topic.group === "more";
    result[name] = async () => {
      const def = await resolveDefinition(entry);
      const meta = await resolveDefinition<CommandMeta>(def.meta ?? {});
      return { ...def, meta: { ...meta, description: topic.summary, ...(hidden && { hidden }) } };
    };
  }
  return result;
}

async function findCommand(commands: SubCommandsDef, name: string) {
  const entry = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (entry) return { name, def: await resolveDefinition(entry) };
  for (const [key, entry] of Object.entries(commands)) {
    const def = await resolveDefinition(entry);
    const { alias } = await resolveDefinition<CommandMeta>(def.meta ?? {});
    if (alias === name || (Array.isArray(alias) && alias.includes(name))) return { name: key, def };
  }
  return undefined;
}

function unknownCommand(name: string, commands: SubCommandsDef, helpOnly: boolean): string {
  const match = closestMatch(name.toLowerCase(), Object.keys(commands));
  const invocation = helpOnly ? "human-hindsight help" : "human-hindsight";
  const hint = match
    ? ` Did you mean \`${invocation} ${match}\`?`
    : " See `human-hindsight --help` for the commands.";
  return `Unknown command ${JSON.stringify(name)}.${hint}`;
}

/** Find the command in the same position citty dispatches, skipping option values. */
export function commandIndex(rawArgs: string[], defs: ArgsDef): number {
  const normalize = (name: string) => name.replaceAll("-", "").toLowerCase();
  const valueFlags = new Set<string>();
  for (const [name, arg] of Object.entries(defs)) {
    if (arg.type !== "string" && arg.type !== "enum") continue;
    valueFlags.add(normalize(name));
    const aliases = arg.alias == null ? [] : Array.isArray(arg.alias) ? arg.alias : [arg.alias];
    for (const alias of aliases) valueFlags.add(normalize(alias));
  }
  for (let index = 0; index < rawArgs.length; index++) {
    const token = rawArgs[index] ?? "";
    if (token === "--") return -1;
    if (!token.startsWith("-")) return index;
    if (!token.includes("=") && valueFlags.has(normalize(token))) index++;
  }
  return -1;
}

/** Flags citty handles itself, plus the reference switch read beside `--help`. */
const builtinArgs: ArgsDef = {
  help: { type: "boolean", alias: "h" },
  version: { type: "boolean", alias: "v" },
  all: { type: "boolean" },
};

const camelCase = (name: string) => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * Every spelling the argument parser accepts for these definitions: the
 * kebab name, its camelCase form, each alias, and `no-` forms of booleans.
 * `--dryrun` is not one of them: the parser would keep it under its own name
 * and the command would never see it.
 */
function spellings(defs: ArgsDef): {
  accepted: Map<string, ArgDef>;
  names: Map<string, string>;
  suggested: string[];
} {
  const accepted = new Map<string, ArgDef>();
  const names = new Map<string, string>();
  const suggested: string[] = [];
  for (const [name, arg] of Object.entries(defs)) {
    if (arg.type === "positional") continue;
    const { alias } = arg as { alias?: string | string[] };
    const aliases = alias == null ? [] : Array.isArray(alias) ? alias : [alias];
    const forms = [name, camelCase(name), ...aliases];
    for (const spelling of forms) {
      accepted.set(spelling, arg);
      names.set(spelling, name);
    }
    if (name.length > 1) suggested.push(name);
    if (arg.type === "boolean") {
      for (const spelling of forms) accepted.set(`no-${spelling}`, arg);
      if (name.length > 1) suggested.push(`no-${name}`);
    }
  }
  return { accepted, names, suggested };
}

const choiceList = (values: readonly string[]) =>
  `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`;

/**
 * Shared options whose value must be one of a fixed set, checked once for
 * every command before anything runs. The parser each command uses is the
 * judge of a value; the list is what the person is told.
 */
const VALUE_RULES: Record<string, ValueRule> = {
  source: {
    accepts: (value) => passes(() => parseSourceMode(value)),
    says: choiceList([...Object.keys(SOURCE_PRODUCT_NAMES), "auto"]),
  },
  runner: {
    accepts: (value) => passes(() => parseRunnerMode(value)),
    says: choiceList([...Object.keys(RUNNER_INFO), "auto"]),
  },
  quality: { accepts: (value) => passes(() => parseQuality(value)), says: "balanced or best" },
  recent: RECENT_RULE,
};

/**
 * Options of one or more commands whose value must be a number or a word from
 * a list. Each name means the same in every command that has it, and each
 * rule is the one that command reads its value with.
 */
const COMMAND_VALUE_RULES: Record<string, ValueRule> = {
  home: FOLDER_RULE,
  "claude-dir": FOLDER_RULE,
  "codex-dir": FOLDER_RULE,
  "kiro-dir": FOLDER_RULE,
  "kirocrew-dir": FOLDER_RULE,
  "opencode-dir": FOLDER_RULE,
  "opencode-db": FILE_RULE,
  "min-messages": MIN_MESSAGES_RULE,
  "min-substance": MIN_MESSAGES_RULE,
  concurrency: CONCURRENCY_RULE,
  timeout: TIMEOUT_RULE,
  "input-budget": INPUT_BUDGET_RULE,
  truncate: TRUNCATE_RULE,
  "window-size": WINDOW_SIZE_RULE,
  "cluster-batch-size": CLUSTER_BATCH_RULE,
  "min-roles": ROLE_COUNT_RULE,
  "max-roles": ROLE_COUNT_RULE,
  port: PORT_RULE,
  tab: TAB_RULE,
};

function passes(parse: () => unknown): boolean {
  try {
    parse();
    return true;
  } catch {
    return false;
  }
}

/** One plain line naming the option, its accepted values, and the value given. */
function optionProblem(name: string, value: string, via = `--${name}`): string | undefined {
  const rule = VALUE_RULES[name] ?? COMMAND_VALUE_RULES[name];
  return rule ? valueProblem(rule, name, value, via) : undefined;
}

/** One plain line for a value option given no value at all. */
function missingValue(name: string): string {
  const rule = VALUE_RULES[name] ?? COMMAND_VALUE_RULES[name];
  return `--${name} takes ${rule?.says ?? "a value"}; none was given.`;
}

/** The same check for a value carried in an environment variable, when no flag gave one. */
function environmentProblem(
  given: ReadonlySet<string>,
  env: NodeJS.ProcessEnv,
): string | undefined {
  for (const name of Object.keys(VALUE_RULES)) {
    const variable = flagEnvironments[name];
    const value = variable ? env[variable] : undefined;
    if (given.has(name) || value === undefined || value === "") continue;
    const problem = optionProblem(name, value, variable);
    if (problem) return problem;
  }
  return undefined;
}

function unknownOption(token: string, command: string | undefined, suggested: string[]): string {
  const name = token.replace(/^-+/, "");
  const where = command ? ` for \`human-hindsight ${command}\`` : "";
  const match = token.startsWith("--") ? closestMatch(name, suggested) : undefined;
  if (match) return `Unknown option ${token}${where}. Did you mean --${match}?`;
  const reference = command
    ? `human-hindsight ${command} --help --all`
    : "human-hindsight --help --all";
  return `Unknown option ${token}${where}. See \`${reference}\` for every option.`;
}

function belongsTo(command: string, typed: string): string {
  return `That option belongs to ${command}: human-hindsight ${command} ${typed}`;
}

/**
 * The command that takes a flag the bare command does not, distill first:
 * `human-hindsight --fresh` is pointed at `human-hindsight distill --fresh`.
 */
async function commandOwning(
  commands: SubCommandsDef,
  spelling: string,
): Promise<{ name: string; boolean: boolean } | undefined> {
  const names = ["distill", ...Object.keys(commands).filter((name) => name !== "distill")];
  for (const name of names) {
    const entry = Object.hasOwn(commands, name) ? commands[name] : undefined;
    if (!entry) continue;
    const def = await resolveDefinition(entry);
    const arg = spellings(await resolveDefinition<ArgsDef>(def.args ?? {})).accepted.get(spelling);
    if (arg) return { name, boolean: arg.type === "boolean" };
  }
  return undefined;
}

/**
 * What is wrong with the command line, or nothing. An unknown command, an
 * unknown `help` target, and an unknown flag are each reported with the
 * closest real name; the caller runs nothing when this returns a message.
 */
export async function findInputProblem(
  root: HelpDefinition,
  rawArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const rootArgs = await resolveDefinition<ArgsDef>(root.args ?? {});
  const index = commandIndex(rawArgs, rootArgs);
  const name = index >= 0 ? rawArgs[index] : undefined;
  // Everything after `--` is left alone by the parser, so a command there never runs.
  if (index < 0 && rawArgs.includes("--")) return LEADING_SEPARATOR;
  const commands = await resolveDefinition<SubCommandsDef>(root.subCommands ?? {});
  // The bare command also takes the options of the home screen.
  let defs: ArgsDef = { ...builtinArgs, ...rootArgs, ...(name ? {} : homeArgs) };
  let command: string | undefined;
  if (name) {
    const known = await findCommand(commands, name);
    if (!known) {
      // `--concurrency 4` on the bare command: "4" is the value of a flag that
      // belongs to another command, not a mistyped command.
      const before = rawArgs[index - 1] ?? "";
      const spelling = before.replace(/^-{1,2}/, "");
      const owner = before.startsWith("--") ? await commandOwning(commands, spelling) : undefined;
      if (owner && !owner.boolean) return belongsTo(owner.name, `${before} ${name}`);
      return unknownCommand(name, commands, false);
    }
    command = known.name;
    const ownArgs = await resolveDefinition<ArgsDef>(known.def.args ?? {});
    defs = { ...defs, ...ownArgs };
    if (known.name === "help") {
      const rest = rawArgs.slice(index + 1);
      const target = rest[commandIndex(rest, ownArgs)];
      if (target && !(await findCommand(commands, target))) {
        return unknownCommand(target, commands, true);
      }
    }
  }
  const { accepted, names, suggested } = spellings(defs);
  const given = new Set<string>();
  // Words that are not flags or flag values are the command's own arguments.
  const takes = Object.entries(defs).filter(([, arg]) => arg.type === "positional");
  let words = 0;
  const extraWord = (word: string): string | undefined =>
    command && ++words > takes.length ? unexpectedArgument(word, command, takes) : undefined;
  // Help is always readable, even beside a wrong value: it may be the reason for asking.
  const end = rawArgs.indexOf("--");
  const helpAsked = (end < 0 ? rawArgs : rawArgs.slice(0, end)).some((token) =>
    ["--help", "-h"].includes(token),
  );
  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i] ?? "";
    if (token === "--") {
      // Everything after it is an argument, even a word that starts with a dash.
      for (const word of rawArgs.slice(i + 1)) {
        const problem = extraWord(word);
        if (problem) return problem;
      }
      break;
    }
    if (i === index) continue;
    if (!token.startsWith("-") || token === "-") {
      const problem = extraWord(token);
      if (problem) return problem;
      continue;
    }
    const [spelling = ""] = token.replace(/^-{1,2}/, "").split("=", 1);
    const arg = accepted.get(spelling);
    const negated = spelling.startsWith("no-") && arg?.type === "boolean";
    if (!arg || (spelling.startsWith("no-") && !negated && !accepted.has(spelling))) {
      const flag = token.split("=", 1)[0] ?? token;
      if (!command) {
        const owner = await commandOwning(commands, spelling);
        if (owner) {
          const value = token.includes("=") || owner.boolean ? "" : ` ${rawArgs[i + 1] ?? ""}`;
          return belongsTo(owner.name, `${token}${value}`.trimEnd());
        }
      }
      return unknownOption(flag, command, suggested);
    }
    if (arg.type === "boolean" && token.includes("=")) {
      const problem = booleanValueProblem(token, negated);
      if (problem) return problem;
    }
    if (arg.type !== "boolean" && !negated) {
      const name = names.get(spelling) ?? spelling;
      // A value flag takes the next token, even one that starts with a dash.
      const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : rawArgs[++i];
      given.add(name);
      if (helpAsked) continue;
      // A value flag at the end of the line was given nothing; the parser would read "".
      if (value === undefined) return missingValue(name);
      const problem = optionProblem(name, value);
      if (problem) return problem;
    }
  }
  return helpAsked ? undefined : environmentProblem(given, env);
}

/**
 * A word the command has no place for. The parser would keep it as an unused
 * argument, so `distill --yes no` would run as yes; nothing runs instead.
 */
function unexpectedArgument(word: string, command: string, takes: [string, ArgDef][]): string {
  const shape = takes
    .map(([name, arg]) => (arg.required === false ? `[${name.toUpperCase()}]` : name.toUpperCase()))
    .join(" ");
  const what = shape ? `takes ${shape}` : "takes no arguments";
  return `Unexpected argument: ${word}. \`human-hindsight ${command}\` ${what}; see \`human-hindsight ${command} --help\`.`;
}

const LEADING_SEPARATOR =
  "Nothing runs after a leading --. Put the command first; see `human-hindsight --help`.";

/**
 * A boolean flag is on or off and takes no value. The parser would read any
 * value but `false` as on, so `--yes=no` would approve a plan; only the
 * spellings that say what they mean are accepted: `--flag`, `--no-flag`,
 * `--flag=true`, and `--flag=false`.
 */
function booleanValueProblem(token: string, negated: boolean): string | undefined {
  const [flag = token, value] = token.split(/=(.*)/s, 2);
  if (!negated && (value === "true" || value === "false")) return undefined;
  return `${flag} takes no value; use ${flag} or leave it out.`;
}

/** Report a problem on stderr with exit code 1. True when the command must not run. */
export async function rejectUnknownInput(
  root: HelpDefinition,
  rawArgs: string[],
  stderr: Writable = process.stderr,
): Promise<boolean> {
  const problem = await findInputProblem(root, rawArgs);
  if (!problem) return false;
  stderr.write(`${problem}\n`);
  process.exitCode = 1;
  return true;
}

/** The help page for the root (no target) or one command, or why there is none. */
export async function helpText(
  root: HelpDefinition,
  name: string | undefined,
  o: { all: boolean; plain: boolean },
): Promise<{ text: string } | { error: string }> {
  const commands = await resolveDefinition<SubCommandsDef>(root.subCommands ?? {});
  if (!name) {
    const meta = await resolveDefinition<CommandMeta>(root.meta ?? {});
    return {
      text: o.all
        ? await renderFullHelp(root, o.plain, homeArgs)
        : renderShortHelp(
            helpTopics.filter((topic) => Object.hasOwn(commands, topic.name)),
            meta.version ?? "",
            o.plain,
          ),
    };
  }
  const match = await findCommand(commands, name);
  if (!match) return { error: unknownCommand(name, commands, true) };
  const meta = await resolveDefinition<CommandMeta>(match.def.meta ?? {});
  const topic: HelpTopic = helpTopics.find((item) => item.name === match.name) ?? {
    name: match.name,
    summary: meta.description ?? "",
    examples: [example(`${match.name} --help --all`, "Read the command reference.")],
    common: [],
    group: "more",
  };
  const globalArgs = await resolveDefinition(root.args ?? {});
  const args = await resolveDefinition(match.def.args ?? {});
  return {
    text: await renderCommandHelp(topic, { args: { ...globalArgs, ...args } }, o.all, o.plain),
  };
}

async function writeHelp(
  root: HelpDefinition,
  name: string | undefined,
  all: boolean,
  plain: boolean,
): Promise<void> {
  const result = await helpText(root, name, { all, plain });
  if ("error" in result) {
    process.stderr.write(`${result.error}\n`);
    process.exitCode = 1;
    return;
  }
  // runMain exits immediately after its usage hook. Drain even a long piped reference.
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${result.text}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

export function createShowUsage(
  root: HelpDefinition,
  rawArgs: string[],
): NonNullable<RunMainOptions["showUsage"]> {
  return async (cmd, parent) => {
    const { name } = await resolveDefinition<CommandMeta>(cmd.meta ?? {});
    let target = parent ? name : undefined;
    if (target === "help") {
      const index = commandIndex(rawArgs, await resolveDefinition(root.args ?? {}));
      const rest = rawArgs.slice(index + 1);
      target = rest[commandIndex(rest, await resolveDefinition(cmd.args ?? {}))] ?? target;
    }
    await writeHelp(root, target, rawArgs.includes("--all"), rawArgs.includes("--plain"));
  };
}

export default defineCommand({
  meta: { name: "help" },
  args: {
    ...sharedArgs,
    command: { type: "positional", required: false, description: "Command to look up" },
    all: fullHelpArg,
  },
  async run({ args, rawArgs }) {
    const { main } = await import("../main.js");
    await writeHelp(main, args.command, Boolean(args.all), rawArgs.includes("--plain"));
  },
});
