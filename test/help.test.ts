import { type ArgsDef, type CommandDef, type CommandMeta, runCommand } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "../package.json" with { type: "json" };
import helpCommand, {
  createShowUsage,
  findInputProblem,
  helpText,
  helpTopics,
} from "../src/commands/help.js";
import { main } from "../src/main.js";
import { resolveDefinition, valuePlaceholder } from "../src/ui/help.js";
import { goldenText } from "./support/text.js";

/**
 * Help pages: one friendly root screen, examples-first command pages, and a
 * full reference generated from the argument definitions. Unknown commands and
 * flags are errors that suggest the closest real one and run nothing.
 */

type Entry = CommandDef | (() => Promise<CommandDef>);

async function registered(): Promise<{ name: string; def: CommandDef; meta: CommandMeta }[]> {
  const commands = main.subCommands as Record<string, Entry>;
  return Promise.all(
    Object.entries(commands).map(async ([name, entry]) => {
      const def = await resolveDefinition<CommandDef>(entry);
      return { name, def, meta: await resolveDefinition<CommandMeta>(def.meta ?? {}) };
    }),
  );
}

/** Help wraps to `process.stdout.columns`; pin it for a golden. */
function withColumns<T>(columns: number, run: () => Promise<T>): Promise<T> {
  const saved = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
  return run().finally(() => {
    if (saved) Object.defineProperty(process.stdout, "columns", saved);
    else delete (process.stdout as { columns?: number }).columns;
  });
}

async function page(target: string | undefined, o: { all?: boolean; columns?: number } = {}) {
  const result = await withColumns(o.columns ?? 80, () =>
    helpText(main, target, { all: o.all ?? false, plain: false }),
  );
  if ("error" in result) throw new Error(result.error);
  return result.text;
}

describe("root help", () => {
  it("is one short screen with no path flags and no escapes when piped", async () => {
    const text = await page(undefined);
    const lines = text.split("\n");
    expect(lines.length).toBeLessThanOrEqual(24);
    expect(text).not.toMatch(/--[a-z]+-dir/);
    expect(text).not.toContain("\u001b");
    // The footer points at doctor, the full reference, and the project page.
    expect(text).toContain("npx human-hindsight doctor");
    expect(text).toContain("npx human-hindsight help --all");
    expect(text).toContain(pkg.homepage);
    // Start here names the bare command.
    expect(text).toMatch(/Start here\n\s+npx human-hindsight/);
  });

  it.each([80, 60])("matches its golden at %i columns", async (columns) => {
    const text = await page(undefined, { columns });
    await expect(goldenText(text)).toMatchFileSnapshot(`golden/help/root-${columns}.txt`);
  });

  it("is written to stdout with exit code 0 through --help and through `help`", async () => {
    let written = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: unknown,
      callback?: unknown,
    ) => {
      written += String(chunk);
      if (typeof callback === "function") callback();
      return true;
    }) as typeof process.stdout.write);
    const errors = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = undefined;
    try {
      await createShowUsage(main, ["--help"])(main as CommandDef);
      const viaFlag = written;
      written = "";
      await runCommand(helpCommand, { rawArgs: [] });
      expect(written).toBe(viaFlag);
      expect(viaFlag).toContain("Everyday commands");
      expect(errors).not.toHaveBeenCalled();
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      spy.mockRestore();
      errors.mockRestore();
    }
  });
});

describe("command help", () => {
  it("shows the same reflection examples and options under the earlier command name", async () => {
    for (const all of [false, true]) {
      const canonical = await page("reflect", { all });
      expect(await page("distill", { all })).toBe(canonical);
      expect(canonical).toContain("The earlier name distill still works.");
      expect(canonical).toContain("npx human-hindsight reflect --recent 10");
    }
  });

  it("every registered command has a topic with a summary, an example, and real common flags", async () => {
    const shared = (await resolveDefinition<ArgsDef>(main.args ?? {})) as ArgsDef;
    for (const { name, def } of await registered()) {
      const topic = helpTopics.find((item) => item.name === name);
      expect(topic, `help topic for ${name}`).toBeDefined();
      if (!topic) continue;
      expect(topic.summary, name).toMatch(/^[A-Z].+\.$/);
      expect(topic.examples.length, name).toBeGreaterThan(0);
      for (const example of topic.examples) {
        expect(example.run.startsWith(`npx human-hindsight ${name}`), example.run).toBe(true);
      }
      const args = { ...shared, ...(await resolveDefinition<ArgsDef>(def.args ?? {})) };
      for (const flag of topic.common) {
        expect(args[flag], `${name} --${flag}`).toBeDefined();
        expect(args[flag]?.type, `${name} --${flag}`).not.toBe("positional");
      }
    }
  });

  it("each summary lives in one place: the topic, read by short help, command help, and the reference", async () => {
    const reference = await page(undefined, { all: true });
    for (const { name, meta } of await registered()) {
      const topic = helpTopics.find((item) => item.name === name);
      if (!topic) throw new Error(`no topic for ${name}`);
      expect(meta.description, name).toBe(topic.summary);
      expect(reference, name).toContain(`npx human-hindsight ${name}\n${topic.summary}\n`);
      expect(await page(name), name).toContain(`npx human-hindsight ${name}\n${topic.summary}\n`);
    }
  });

  it("leads with examples, then common options, then a pointer to the full list", async () => {
    const text = await page("reflect");
    const at = (label: string) => text.indexOf(label);
    expect(at("Examples")).toBeGreaterThan(0);
    expect(at("Examples")).toBeLessThan(at("Common options"));
    expect(at("Common options")).toBeLessThan(at("npx human-hindsight reflect --help --all"));
  });

  it("placeholders name real values on every flag of every command", async () => {
    const shared = (await resolveDefinition<ArgsDef>(main.args ?? {})) as ArgsDef;
    const rows: [string, string, string][] = [];
    for (const { name, def } of await registered()) {
      const args = { ...shared, ...(await resolveDefinition<ArgsDef>(def.args ?? {})) };
      for (const [flag, arg] of Object.entries(args)) {
        if (arg.type === "boolean" || arg.type === "positional") continue;
        rows.push([name, flag, valuePlaceholder(flag, arg)]);
      }
    }
    expect(rows.length).toBeGreaterThan(40);
    for (const [command, flag, placeholder] of rows) {
      const bare = placeholder.replace(/^<|>$/g, "");
      expect(bare, `${command} --${flag}`).not.toBe("");
      expect(
        [flag, flag.replaceAll("-", "_")],
        `${command} --${flag} ${placeholder}`,
      ).not.toContain(bare);
      // A real value or a list of choices is shown as typed; a kind of value is bracketed.
      if (/^\d+$|\|/.test(bare)) expect(placeholder, `${command} --${flag}`).toBe(bare);
      else expect(placeholder, `${command} --${flag}`).toBe(`<${bare}>`);
    }
    // Every page prints the same labels, in the form a person types.
    const reference = await page(undefined, { all: true });
    expect(reference).not.toContain("=<");
    for (const [command, flag, placeholder] of rows) {
      expect(reference, `${command} --${flag}`).toContain(`--${flag} ${placeholder}`);
    }
    const reflect = await page("reflect", { all: true });
    for (const label of [
      "--recent 25",
      "--quality fast|balanced|best",
      "--timeout <seconds>",
      "--truncate never|extreme",
      "--model <name>",
      "--cluster-model <name>",
      "--author-model <name>",
      "--cluster-batch-size <n>",
      "--project <name>",
    ])
      expect(reflect).toContain(label);
    expect(await page("distill")).toContain("--recent 25 ");
    expect(await page("export")).toMatch(/--source <tool> +History to read: claude, codex/);
  });

  it("matches the golden for every command at 80 and 60 columns", async () => {
    for (const { name } of await registered()) {
      for (const columns of [80, 60]) {
        const text = await page(name, { columns });
        await expect(goldenText(text)).toMatchFileSnapshot(`golden/help/${name}-${columns}.txt`);
      }
    }
  });
});

describe("full reference", () => {
  it("contains every flag of every command, generated from the argument definitions", async () => {
    const reference = await page(undefined, { all: true });
    const shared = (await resolveDefinition<ArgsDef>(main.args ?? {})) as ArgsDef;
    for (const name of Object.keys(shared)) expect(reference, name).toContain(`--${name}`);
    for (const { name, def } of await registered()) {
      const args = await resolveDefinition<ArgsDef>(def.args ?? {});
      for (const [flag, arg] of Object.entries(args)) {
        if (arg.type === "positional")
          expect(reference, `${name} ${flag}`).toContain(flag.toUpperCase());
        else expect(reference, `${name} --${flag}`).toContain(`--${flag}`);
      }
    }
  });

  it("matches its golden", async () => {
    await expect(goldenText(await page(undefined, { all: true }))).toMatchFileSnapshot(
      "golden/help/reference-80.txt",
    );
  });

  it("describes every option, including the negation of one that is on by default", async () => {
    const reference = await page(undefined, { all: true });
    const bare = reference.split("\n").filter((line) => /^ {2}(-\w, )?--[\w-]+( \S+)?$/.test(line));
    expect(bare).toEqual([]);
    expect(reference).toMatch(/--no-breaker +Turn off --breaker/);
  });

  it("wraps every line of prose to a 60-column terminal; only a whole command or address is wider", async () => {
    const pages = [
      await page(undefined, { columns: 60 }),
      await page(undefined, { all: true, columns: 60 }),
      ...(await Promise.all((await registered()).map(({ name }) => page(name, { columns: 60 })))),
    ];
    for (const text of pages) {
      const wide = text
        .split("\n")
        .filter((line) => line.length > 60)
        .filter((line) => !/^ {2}npx human-hindsight \S|^ {2}https:\/\/\S+$/.test(line));
      expect(wide).toEqual([]);
    }
  });

  it("uses plain words in every summary and description", async () => {
    const reference = await page(undefined, { all: true });
    expect(reference).not.toMatch(
      /oneshot|\bLLM\b|harness|middle-out|orphan|re-cluster|funnel|readiness call|\w\(s\)/i,
    );
    expect(reference).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("mistyped input runs nothing", () => {
  const cases: [string, string[], RegExp][] = [
    [
      "an unknown command",
      ["exprot"],
      /Unknown command "exprot"\. Did you mean `npx human-hindsight export`\?/,
    ],
    [
      "an unknown help target",
      ["help", "distil"],
      /Unknown command "distil"\. Did you mean `npx human-hindsight help reflect`\?/,
    ],
    [
      "a near-miss flag on the bare command",
      ["--plian"],
      /Unknown option --plian\. Did you mean --plain\?/,
    ],
    [
      "a near-miss flag on a command",
      ["distill", "--dryrun"],
      /Unknown option --dryrun for `npx human-hindsight reflect`\. Did you mean --dry-run\?/,
    ],
    [
      "a flag that belongs to another command",
      ["status", "--dry-run"],
      /Unknown option --dry-run for `npx human-hindsight status`/,
    ],
    [
      "an unrelated flag",
      ["--bogus"],
      /Unknown option --bogus\. See `npx human-hindsight --help --all`/,
    ],
    [
      "a misspelled negation",
      ["--no-folow-up"],
      /Unknown option --no-folow-up\. Did you mean --no-follow-up\?/,
    ],
    ["a negated flag that takes a value", ["--no-home"], /Unknown option --no-home/],
    ["an unknown short flag", ["export", "-x"], /Unknown option -x/],
    [
      "a reflect option on the bare command",
      ["--fresh"],
      /^That option belongs to reflect: npx human-hindsight reflect --fresh$/,
    ],
    [
      "a reflect option with a value on the bare command",
      ["--concurrency", "4"],
      /^That option belongs to reflect: npx human-hindsight reflect --concurrency 4$/,
    ],
    [
      "a word that resembles no command",
      ["frobnicate"],
      /^Unknown command "frobnicate"\. See `npx human-hindsight --help` for the commands\.$/,
    ],
    [
      "a help target that resembles no command",
      ["help", "frob"],
      /^Unknown command "frob"\. See `npx human-hindsight --help` for the commands\.$/,
    ],
    ["a home screen option on a command", ["status", "--yes"], /Unknown option --yes for/],
  ];
  it.each(cases)("%s is an error with a suggestion", async (_label, rawArgs, message) => {
    const problem = await findInputProblem(main, rawArgs);
    expect(problem).toMatch(message);
  });

  it("every command rejects an unknown flag and suggests its own near miss", async () => {
    const shared = (await resolveDefinition<ArgsDef>(main.args ?? {})) as ArgsDef;
    const commands = await registered();
    expect(commands.length).toBeGreaterThan(15);
    for (const { name, def } of commands) {
      expect(await findInputProblem(main, [name, "--bogus-flag"]), name).toMatch(
        new RegExp(`^Unknown option --bogus-flag for \`npx human-hindsight ${name}\``),
      );
      const args = { ...shared, ...(await resolveDefinition<ArgsDef>(def.args ?? {})) };
      for (const flag of Object.keys(args)) {
        if (args[flag]?.type === "positional" || flag.length < 5) continue;
        // Swap two letters in the middle: the typo a person makes.
        const at = Math.floor(flag.length / 2);
        const typo = `${flag.slice(0, at - 1)}${flag[at]}${flag[at - 1]}${flag.slice(at + 1)}`;
        if (typo === flag || Object.hasOwn(args, typo)) continue;
        expect(await findInputProblem(main, [name, `--${typo}`]), `${name} --${typo}`).toContain(
          `Did you mean --${flag}?`,
        );
      }
    }
    expect(await findInputProblem(main, ["export", "--porject", "alpha-app"])).toBe(
      "Unknown option --porject for `npx human-hindsight export`. Did you mean --project?",
    );
  });

  it("a word after a flag is never swallowed: every command takes only its own arguments", async () => {
    const shared = (await resolveDefinition<ArgsDef>(main.args ?? {})) as ArgsDef;
    const commands = await registered();
    let none = 0;
    for (const { name, def } of commands) {
      const own = await resolveDefinition<ArgsDef>(def.args ?? {});
      const positionals = Object.values(own).filter((arg) => arg.type === "positional");
      // A real value for each argument the command takes: a command name for `help`.
      const filled = positionals.map(() => (name === "help" ? "distill" : "review-changes"));
      expect(await findInputProblem(main, [name, ...filled]), name).toBeUndefined();
      const extra = await findInputProblem(main, [name, ...filled, "no"]);
      expect(extra, `${name} with one word too many`).toMatch(/^Unexpected argument: no\. /);
      expect(extra).toContain(`\`npx human-hindsight ${name}\``);
      if (positionals.length === 0) {
        none++;
        expect(extra).toContain("takes no arguments");
      }
      // `--yes no` and the like: the word after a boolean flag is not its value.
      const args = { ...shared, ...own };
      const boolean = Object.keys(args).find((flag) => args[flag]?.type === "boolean");
      if (boolean) {
        expect(
          await findInputProblem(main, [name, ...filled, `--${boolean}`, "no"]),
          `${name} --${boolean} no`,
        ).toMatch(/^Unexpected argument: no\. /);
      }
      // A word after `--` is an argument too.
      expect(await findInputProblem(main, [name, ...filled, "--", "no"])).toMatch(
        /^Unexpected argument: no\. /,
      );
    }
    expect(none).toBeGreaterThan(10);
    expect(await findInputProblem(main, ["distill", "--yes", "no"])).toBe(
      "Unexpected argument: no. `npx human-hindsight reflect` takes no arguments; see `npx human-hindsight reflect --help`.",
    );
    expect(await findInputProblem(main, ["show", "a", "b"])).toBe(
      "Unexpected argument: b. `npx human-hindsight show` takes NAME; see `npx human-hindsight show --help`.",
    );
    expect(await findInputProblem(main, ["rate", "a", "up", "now"])).toBe(
      "Unexpected argument: now. `npx human-hindsight rate` takes NAME RATING; see `npx human-hindsight rate --help`.",
    );
    // A value flag still takes the next word, and the bare command treats a word as a command.
    expect(await findInputProblem(main, ["distill", "--project", "no"])).toBeUndefined();
    expect(await findInputProblem(main, ["--yes", "no"])).toMatch(/^Unknown command "no"/);
  });

  const accepted: [string, string[]][] = [
    ["the bare command", []],
    ["the bare command's own options", ["--dry-run", "--yes", "--no-follow-up", "--plain"]],
    ["root flags with values that look like commands", ["--project", "status", "--home", "/tmp/x"]],
    ["root flags before a command", ["--home", "/tmp/x", "export", "--project", "app"]],
    ["the equals form", ["reflect", "--quality=best", "--recent=25"]],
    ["camel case, as the parser accepts it", ["distill", "--dryRun"]],
    ["a negated boolean", ["gui", "--no-open", "--no-follow-up"]],
    ["help and version flags", ["export", "--help", "--all"]],
    ["short help and version", ["-h"]],
    ["a value that starts with a dash", ["distill", "--model", "-odd-model-name"]],
    ["anything after --", ["show", "--", "--odd-slug"]],
    ["a positional slug", ["rate", "review-changes", "up"]],
    ["help for a command", ["help", "suggest-subagents", "--all"]],
  ];
  it.each(accepted)("%s is accepted", async (_label, rawArgs) => {
    expect(await findInputProblem(main, rawArgs)).toBeUndefined();
  });

  it("every boolean flag of every command means only what it says", async () => {
    const shared = (await resolveDefinition<ArgsDef>(main.args ?? {})) as ArgsDef;
    const commands = await registered();
    let checked = 0;
    for (const { name, def } of commands) {
      const args = { ...shared, ...(await resolveDefinition<ArgsDef>(def.args ?? {})) };
      for (const [flag, arg] of Object.entries(args)) {
        if (arg.type !== "boolean") continue;
        checked++;
        for (const ok of [`--${flag}`, `--no-${flag}`, `--${flag}=true`, `--${flag}=false`]) {
          expect(await findInputProblem(main, [name, ok]), `${name} ${ok}`).toBeUndefined();
        }
        // `--yes=no` would otherwise be read as yes.
        for (const value of ["no", "0", "1", "yes", "off", ""]) {
          expect(await findInputProblem(main, [name, `--${flag}=${value}`])).toBe(
            `--${flag} takes no value; use --${flag} or leave it out.`,
          );
        }
        expect(await findInputProblem(main, [name, `--no-${flag}=false`])).toBe(
          `--no-${flag} takes no value; use --no-${flag} or leave it out.`,
        );
      }
    }
    // The bare command's own options follow the same rule.
    expect(await findInputProblem(main, ["--yes=no"])).toBe(
      "--yes takes no value; use --yes or leave it out.",
    );
    expect(await findInputProblem(main, ["--dry-run=false"])).toBeUndefined();
    expect(checked).toBeGreaterThan(40);
  });

  it("a wrong value for a shared choice is one line naming the option, the choices, and the value", async () => {
    const says: Record<string, string> = {
      source: "claude, codex, kiro, kirocrew, opencode, or auto",
      runner: "claude, codex, kiro, opencode, or auto, or several CLIs separated by commas",
      quality: "fast, balanced, or best",
      recent: "a whole number of sessions, such as 25",
    };
    const commands = await registered();
    for (const command of [undefined, ...commands.map((entry) => entry.name)]) {
      for (const [name, choices] of Object.entries(says)) {
        for (const form of ["spaced", "equals"]) {
          const flag = form === "equals" ? [`--${name}=bogus`] : [`--${name}`, "bogus"];
          const rawArgs = command ? [command, ...flag] : flag;
          expect(await findInputProblem(main, rawArgs, {}), rawArgs.join(" ")).toBe(
            `--${name} takes ${choices}, not "bogus".`,
          );
        }
      }
    }
    // Good values pass, in any case the parsers accept.
    for (const rawArgs of [
      ["distill", "--source", "Claude", "--runner=codex", "--quality", "best", "--recent=25"],
      ["status", "--source=auto", "--runner", "auto"],
    ]) {
      expect(await findInputProblem(main, rawArgs, {})).toBeUndefined();
    }
    for (const bad of ["0", "-3", "2.5", ""]) {
      expect(await findInputProblem(main, ["distill", `--recent=${bad}`], {})).toMatch(/^--recent/);
    }
    // Help stays readable beside a wrong value.
    expect(await findInputProblem(main, ["distill", "--quality", "bogus", "--help"], {})).toBe(
      undefined,
    );
  });

  // A wrong number was once read as the default without a word. Each is now
  // one line naming the option, what it takes, and the value given.
  const numbers: [command: string, option: string, says: string, bad: string[], good: string[]][] =
    [
      [
        "export",
        "min-messages",
        "a whole number of messages, 0 or more",
        ["-1", "two", "2.5"],
        ["0", "3"],
      ],
      [
        "distill",
        "min-substance",
        "a whole number of messages, 0 or more",
        ["-1", "x"],
        ["0", "2"],
      ],
      ...(["reflect", "distill", "suggest-subagents"] as const).flatMap((command) => [
        [
          command,
          "concurrency",
          "a whole number of calls at a time, 1 or more",
          ["0", "-2", "four", "1.5"],
          ["1", "10"],
        ] as [string, string, string, string[], string[]],
        [
          command,
          "timeout",
          "a whole number of seconds, 1 or more",
          ["0", "90s", "1.5", ""],
          ["120"],
        ] as [string, string, string, string[], string[]],
        [
          command,
          "input-budget",
          "a whole number of characters, 1000 or more",
          ["999", "lots", "-5"],
          ["1000", "250000"],
        ] as [string, string, string, string[], string[]],
      ]),
      ["preferences", "timeout", "a whole number of seconds, 1 or more", ["0", "abc"], ["60"]],
      [
        "suggest-subagents",
        "window-size",
        "a whole number of preferences, 1 or more",
        ["0", "1e2", "x"],
        ["30"],
      ],
      [
        "distill",
        "cluster-batch-size",
        "a whole number of sessions, 1 or more",
        ["0", "1e2", "9007199254740992"],
        ["50"],
      ],
      ["distill", "truncate", "never or extreme", ["extrem", ""], ["never", "extreme"]],
      ["distill", "recent", "a whole number of sessions, such as 25", ["0", "ten"], ["25"]],
      [
        "gui",
        "port",
        "a whole number from 0 to 65535",
        ["-1", "65536", "12px", "1.5", ""],
        ["0", "8765"],
      ],
      [
        "gui",
        "tab",
        "prompts, preferences, or subagents",
        ["Prompts", "subagent", ""],
        ["preferences"],
      ],
    ];
  it.each(
    numbers,
  )("%s --%s: a wrong value is one line with the value given; nothing runs", async (command, option, says, bad, good) => {
    for (const value of bad) {
      for (const flag of [[`--${option}`, value], [`--${option}=${value}`]]) {
        expect(await findInputProblem(main, [command, ...flag], {}), flag.join(" ")).toBe(
          `--${option} takes ${says}, not ${JSON.stringify(value)}.`,
        );
      }
    }
    for (const value of good) {
      expect(await findInputProblem(main, [command, `--${option}=${value}`], {})).toBeUndefined();
    }
  });

  // An empty folder would mean the current one, which may be a project repository.
  const folders: [option: string, says: string][] = [
    ["home", "a folder"],
    ["claude-dir", "a folder"],
    ["codex-dir", "a folder"],
    ["kiro-dir", "a folder"],
    ["kirocrew-dir", "a folder"],
    ["opencode-dir", "a folder"],
    ["opencode-db", "a file"],
  ];
  it.each(
    folders,
  )("--%s with no value or an empty one is refused before anything runs", async (option, says) => {
    for (const command of ["export", "distill", "status", undefined]) {
      const at = command ? [command] : [];
      expect(await findInputProblem(main, [...at, `--${option}`], {})).toBe(
        `--${option} takes ${says}; none was given.`,
      );
      for (const flag of [[`--${option}=`], [`--${option}`, ""], [`--${option}`, "  "]]) {
        expect(await findInputProblem(main, [...at, ...flag], {}), flag.join(" ")).toBe(
          `--${option} takes ${says}, not ${JSON.stringify(flag.at(-1)?.replace(/^--[\w-]+=/, ""))}.`,
        );
      }
      expect(await findInputProblem(main, [...at, `--${option}=./x`], {})).toBeUndefined();
    }
  });

  it("any option that takes a value refuses to be given none", async () => {
    expect(await findInputProblem(main, ["distill", "--concurrency"], {})).toBe(
      "--concurrency takes a whole number of calls at a time, 1 or more; none was given.",
    );
    expect(await findInputProblem(main, ["distill", "--model"], {})).toBe(
      "--model takes a value; none was given.",
    );
    // Help is still readable.
    expect(await findInputProblem(main, ["distill", "--model", "--help"], {})).toBeUndefined();
  });

  it.each([
    ["HUMAN_HINDSIGHT_QUALITY", "quality", "fast, balanced, or best"],
    [
      "HUMAN_HINDSIGHT_RUNNER",
      "runner",
      "claude, codex, kiro, opencode, or auto, or several CLIs separated by commas",
    ],
    ["HUMAN_HINDSIGHT_RECENT", "recent", "a whole number of sessions, such as 25"],
  ])("%s with a wrong value is named, unless the flag gives one", async (variable, name, says) => {
    const env = { [variable]: "bogus" };
    expect(await findInputProblem(main, ["distill"], env)).toBe(
      `${variable} takes ${says}, not "bogus".`,
    );
    const good = name === "recent" ? "25" : name === "quality" ? "best" : "claude";
    expect(await findInputProblem(main, ["distill", `--${name}=${good}`], env)).toBeUndefined();
  });

  it.each([
    [["--", "distill", "--dry-run"]],
    [["--", "status", "--bogus"]],
    [["--home", "/tmp/x", "--", "distill"]],
    [["--"]],
  ])("%j: a leading -- is an error that points at --help", async (rawArgs) => {
    expect(await findInputProblem(main, rawArgs)).toBe(
      "Nothing runs after a leading --. Put the command first; see `npx human-hindsight --help`.",
    );
  });
});

describe("help --plain", () => {
  beforeEach(() => {
    vi.stubEnv("FORCE_COLOR", "1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prints headings without escapes even when color is forced", async () => {
    const result = await helpText(main, "export", { all: false, plain: true });
    if ("error" in result) throw new Error(result.error);
    expect(result.text).not.toContain("\u001b");
  });
});
