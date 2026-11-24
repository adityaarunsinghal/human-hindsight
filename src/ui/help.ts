import { stripVTControlCharacters } from "node:util";
import {
  type ArgDef,
  type ArgsDef,
  type CommandDef,
  type CommandMeta,
  type Resolvable,
  renderUsage,
} from "citty";
import pkg from "../../package.json" with { type: "json" };
import { bold } from "./style.js";
import { wrapText } from "./wrap.js";

export interface HelpTopic {
  name: string;
  summary: string;
  examples: { run: string; note: string }[];
  common: string[];
  group: "start" | "everyday" | "step" | "more";
}

export type HelpDefinition = Pick<CommandDef, "args" | "meta" | "subCommands">;

export async function resolveDefinition<T>(value: Resolvable<T>): Promise<T> {
  return typeof value === "function" ? (value as () => T | Promise<T>)() : value;
}

export function commandAliases(meta: CommandMeta): string[] {
  return meta.alias ? [meta.alias].flat() : [];
}

export const fullHelpArg = {
  type: "boolean",
  description: "Show the full reference when requesting help",
} as const;

const helpArgs: ArgsDef = {
  help: { type: "boolean", alias: "h", description: "Show examples and common options" },
  all: fullHelpArg,
};

const purpose = "Understand how you work. Codify your taste.";

function title(text: string, plain: boolean): string {
  // bold() already applies the color rules for this output.
  return plain ? text : bold(text);
}

/** Help is written for the terminal it is read in; a pipe reads as 80 columns. */
const helpColumns = () => process.stdout.columns || 80;

/** A sentence of help, wrapped at word boundaries to the width. A command is never passed here. */
function prose(text: string, indent = ""): string {
  return wrapText(text, helpColumns(), { indent }).join("\n");
}

function rows(entries: [string, string][]): string[] {
  const width = Math.max(...entries.map(([label]) => label.length), 0);
  const columns = helpColumns();
  // Descriptions go under their labels when the label column takes most of the
  // width, or when a word (a variable name) could not fit beside it.
  const longestWord = Math.max(
    0,
    ...entries.flatMap(([, description]) => description.split(/\s+/).map((word) => word.length)),
  );
  const stacked = width + 4 > columns * 0.6 || width + 4 + longestWord > columns;
  const indent = stacked ? "    " : " ".repeat(width + 4);
  return entries.flatMap(([label, description]) => {
    if (!description) return [`  ${label}`];
    const lines: string[] = [];
    if (stacked) lines.push(`  ${label}`);
    let line = stacked ? indent : `  ${label.padEnd(width)}  `;
    let hasWords = false;
    for (const word of description.split(/\s+/)) {
      if (hasWords && line.length + word.length + 1 > columns) {
        lines.push(line);
        line = indent;
        hasWords = false;
      }
      line += (hasWords ? " " : "") + word;
      hasWords = true;
    }
    return [...lines, line.trimEnd()];
  });
}

function footer(plain: boolean, command?: string): string {
  const links: [string, string][] = command
    ? [[`npx human-hindsight ${command} --help --all`, "Every option for this command"]]
    : [["npx human-hindsight help <command>", "Examples and common options"]];
  links.push(
    ["npx human-hindsight doctor", "Check your setup"],
    ["npx human-hindsight help --all", "All commands and options"],
  );
  return [title("More help", plain), ...rows(links), `  ${pkg.homepage}`].join("\n");
}

/** The bare command, then two first commands a newcomer can copy. */
const START_HERE: [string, string][] = [
  ["npx human-hindsight", "Reflect on your history or browse past reflections"],
  ["npx human-hindsight --dry-run", "See your setup and the next step"],
  ["npx human-hindsight reflect --dry-run", "Preview the reflection plan"],
];

export function renderShortHelp(topics: HelpTopic[], version: string, plain = false): string {
  const commands = topics.filter((topic) => topic.group === "everyday");
  return [
    title(`Human Hindsight ${version}`, plain),
    prose(purpose),
    "",
    title("Start here", plain),
    ...rows(START_HERE),
    "",
    title("Everyday commands", plain),
    ...rows(commands.map((topic) => [`npx human-hindsight ${topic.name}`, topic.summary])),
    "",
    footer(plain),
  ].join("\n");
}

/**
 * Placeholders for flags whose definitions carry no `valueHint`. A flag name
 * means the same kind of value on every command that has it.
 */
const PLACEHOLDERS: Readonly<Record<string, string>> = {
  project: "name",
  runner: "cli",
  model: "name",
  "author-model": "name",
  "propose-model": "name",
  "pin-model": "name",
  target: "tool",
  timeout: "seconds",
  concurrency: "n",
  "input-budget": "characters",
  "min-messages": "n",
  "min-roles": "n",
  "max-roles": "n",
  "window-size": "n",
  export: "dir",
};

/**
 * What help prints after a flag that takes a value. A real value (`25`) or a
 * list of choices (`fast|balanced|best`) is shown as typed; a kind of value is
 * bracketed (`<seconds>`). Never the flag's own name.
 */
export function valuePlaceholder(name: string, arg: ArgDef): string {
  const hint =
    (arg.type === "enum" && arg.options?.join("|")) ||
    arg.valueHint ||
    PLACEHOLDERS[name] ||
    "value";
  return /^\d+$|\|/.test(hint) ? hint : `<${hint}>`;
}

function optionLabel(name: string, arg: ArgDef): string {
  if (arg.type === "boolean") return `--${name}`;
  return `--${name} ${valuePlaceholder(name, arg)}`;
}

/** Citty renders aliases, positionals, required values, enum choices and defaults. */
async function reference(
  name: string,
  args: ArgsDef,
  plain: boolean,
  parent?: HelpDefinition,
): Promise<string> {
  const output = await renderUsage({ meta: { name, description: "" }, args }, parent);
  // Citty colors piped output and pads table rows to the longest description.
  // Keep its generated usage, suppress the repeated title and style our headings.
  return stripVTControlCharacters(output)
    .trimEnd()
    .split("\n\n")
    .slice(1)
    .map((block) => {
      if (block.startsWith("USAGE ")) return `${title("Usage", plain)}\n  ${block.slice(6).trim()}`;
      if (block === "OPTIONS") return title("Options", plain);
      if (block === "ARGUMENTS") return title("Arguments", plain);
      const entries: [string, string][] = block.split("\n").map((line) => {
        const text = line.trim();
        const match = /^(.*?) {2,}(.+)$/.exec(text);
        // Citty prints `--name=<hint>`; show the same label as the short page.
        const label = (match?.[1] ?? text).replace(/--([\w-]+)=<[^>]*>/, (whole, flag: string) => {
          const arg = args[flag];
          return arg ? optionLabel(flag, arg) : whole;
        });
        let description = match?.[2] ?? "";
        // Citty lists the negation of a boolean that defaults to on with no words.
        const negation = /^--no-([\w-]+)$/.exec(label)?.[1];
        if (!description && negation && args[negation]?.type === "boolean") {
          description = `Turn off --${negation}`;
        }
        return [label, description];
      });
      return rows(entries).join("\n");
    })
    .join("\n\n");
}

export async function renderCommandHelp(
  topic: HelpTopic,
  def: HelpDefinition,
  all: boolean,
  plain = false,
): Promise<string> {
  const args = await resolveDefinition<ArgsDef>(def.args ?? {});
  const meta = await resolveDefinition<CommandMeta>(def.meta ?? {});
  // Each example's command stays whole on its line; its note wraps under it.
  const examples = topic.examples.map(({ run, note }) => `  ${run}\n${prose(note, "    ")}`);
  const sections = [
    [
      title(`npx human-hindsight ${topic.name}`, plain),
      prose(topic.summary),
      ...commandAliases(meta).map((alias) => prose(`The earlier name ${alias} still works.`)),
    ].join("\n"),
    `${title("Examples", plain)}\n${examples.join("\n\n")}`,
  ];
  if (all) {
    const parent = { meta: { name: "npx human-hindsight" } };
    sections.push(await reference(topic.name, { ...helpArgs, ...args }, plain, parent));
  } else {
    const options: [string, string][] = [];
    for (const name of topic.common) {
      const arg = args[name];
      if (arg && arg.type !== "positional") {
        options.push([optionLabel(name, arg), arg.description ?? ""]);
      }
    }
    if (options.length) {
      sections.push([title("Common options", plain), ...rows(options)].join("\n"));
    }
  }
  sections.push(footer(plain, all ? undefined : topic.name));
  return sections.join("\n\n");
}

/**
 * Every command and option. `home` holds the options only the bare command
 * takes; they get a section of their own after the global options.
 */
export async function renderFullHelp(
  root: HelpDefinition,
  plain = false,
  home: ArgsDef = {},
): Promise<string> {
  const meta = await resolveDefinition<CommandMeta>(root.meta ?? {});
  const rootName = `npx ${meta.name ?? "human-hindsight"}`;
  const shared = await resolveDefinition<ArgsDef>(root.args ?? {});
  const registered = await resolveDefinition(root.subCommands ?? {});
  const globalArgs = {
    ...shared,
    ...helpArgs,
    version: { type: "boolean", alias: "v", description: "Print the installed version" },
  } satisfies ArgsDef;
  const sections = [
    `${title(`Human Hindsight ${meta.version ?? pkg.version}`, plain)}\n${prose(purpose)}`,
    `${title("Global options", plain)}\n${await reference(rootName, globalArgs, plain)}`,
  ];
  if (Object.keys(home).length) {
    sections.push(
      [
        title(`${rootName} (no command)`, plain),
        prose("Show your setup and a menu of next steps."),
        await reference(rootName, home, plain),
      ].join("\n"),
    );
  }
  for (const [name, entry] of Object.entries(registered)) {
    const def = await resolveDefinition(entry);
    const commandMeta = await resolveDefinition<CommandMeta>(def.meta ?? {});
    const args = await resolveDefinition<ArgsDef>(def.args ?? {});
    // Global definitions appear once. Keep local overrides, even under the same name.
    const local = Object.fromEntries(
      Object.entries(args).filter(([key, arg]) => shared[key] !== arg),
    );
    sections.push(
      [
        title(`${rootName} ${name}`, plain),
        prose(commandMeta.description ?? ""),
        ...commandAliases(commandMeta).map((alias) =>
          prose(`The earlier name ${alias} still works.`),
        ),
        await reference(name, local, plain, { meta: { name: rootName } }),
      ].join("\n"),
    );
  }
  sections.push(footer(plain));
  return sections.join("\n\n");
}
