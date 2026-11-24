import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { publishedVariables } from "../src/commands/_shared.js";
import {
  type CommandRunner,
  flowArgs,
  generateSubagents,
  type NextCommand,
  nextArguments,
  nextCommandText,
  offerLibraryNext,
  offerNext,
  printedHome,
  retryCommandText,
} from "../src/commands/next.js";
import { suggestionPath } from "../src/core/subagents.js";
import type { TerminalHost } from "../src/ui/live.js";
import { sampleHome } from "./support/home.js";
import { fakeInput, fakeOutput, KEYS } from "./support/tty.js";
import { terminalModel } from "./ui-vt.js";

afterEach(() => vi.unstubAllEnvs());
function sink() {
  let text = "";
  return {
    output: new Writable({
      write(chunk, _encoding, done) {
        text += chunk.toString();
        done();
      },
    }),
    text: () => text,
  };
}

describe("interactive next commands", () => {
  it("runs the suggested command only after y and retains selection", async () => {
    const output = sink();
    const run = vi.fn(async (_command: NextCommand, _args: string[]) => {});
    expect(
      await offerNext(
        "distill",
        {
          home: "/library with spaces",
          source: "opencode",
          "opencode-db": "/history/store.db",
          project: "dashboard",
          runner: "codex",
          model: "chosen-model",
          "cluster-model": "grouping-model",
          "cluster-batch-size": "50",
        },
        { input: Readable.from(["y\n"]), output: output.output, interactive: true, run },
      ),
    ).toBe(true);
    expect(run).toHaveBeenCalledWith(
      "reflect",
      expect.arrayContaining([
        "--home=/library with spaces",
        "--source=opencode",
        "--opencode-db=/history/store.db",
        "--project=dashboard",
        "--runner=codex",
        "--model=chosen-model",
        "--cluster-model=grouping-model",
        "--cluster-batch-size=50",
      ]),
    );
    expect(output.text()).toContain("review the model-call plan");
    expect(output.text()).toContain("[y/N]");
    expect(run.mock.calls[0]?.[1]).not.toContain("--yes");
  });

  it("a printed or dispatched reflect keeps the switches that change what the run does", () => {
    const args = { home: "/h", prompts: false, subagents: true, generalize: true };
    expect(nextArguments("reflect", args)).toEqual(
      expect.arrayContaining(["--no-prompts", "--subagents"]),
    );
    expect(nextCommandText("reflect", args)).toContain(" --no-prompts --subagents");
    // The defaults are never spelled out.
    expect(nextArguments("reflect", { home: "/h", prompts: true }).join(" ")).not.toMatch(
      /prompts|subagents/,
    );
  });

  it.each(["n\n", "\n", ""])("declining or EOF does not run a command (%j)", async (answer) => {
    const output = sink();
    const run = vi.fn(async () => {});
    expect(
      await offerNext(
        "export",
        {},
        {
          input: Readable.from(answer ? [answer] : []),
          output: output.output,
          interactive: true,
          run,
        },
      ),
    ).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("Ctrl-C at the follow-up question runs nothing and leaves exit code 130", async () => {
    vi.stubEnv("CI", "");
    const input = fakeInput();
    const output = fakeOutput();
    const host = new EventEmitter() as TerminalHost & EventEmitter;
    Object.assign(host, { pid: 4242, kill: () => true });
    const run = vi.fn(async () => {});
    const original = output.write.bind(output);
    output.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (String(chunk).includes("[y/N]")) setImmediate(() => host.emit("SIGINT"));
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof output.write;
    const before = process.exitCode;
    try {
      expect(await offerNext("export", {}, { input, output, host, run })).toBe(false);
      expect(process.exitCode).toBe(130);
    } finally {
      process.exitCode = before;
    }
    expect(run).not.toHaveBeenCalled();
    expect(output.text().trim().split("\n").at(-1)).toBe("Interrupted.");
  });

  it.each([
    { args: {}, interactive: false },
    { args: { "follow-up": false }, interactive: true },
    { args: { "dry-run": true }, interactive: true },
    { args: { yes: true }, interactive: true },
  ])("does not prompt scripts, dry runs, or opted-out callers: %j", async ({
    args,
    interactive,
  }) => {
    const output = sink();
    const run = vi.fn(async () => {});
    expect(await offerNext("gui", args, { output: output.output, interactive, run })).toBe(false);
    expect(output.text()).not.toContain("[y/N]");
    expect(run).not.toHaveBeenCalled();
  });

  it("never carries destructive or approval flags into another command", () => {
    const args = nextArguments("distill", {
      home: "/library",
      source: "claude",
      yes: true,
      fresh: true,
      force: true,
      apply: true,
      "dry-run": true,
      raw: true,
    });
    expect(args).not.toEqual(
      expect.arrayContaining(["--yes", "--fresh", "--force", "--apply", "--raw"]),
    );
    expect(args.some((value) => /--(?:yes|fresh|force|apply|raw|dry-run)(?:=|$)/.test(value))).toBe(
      false,
    );
  });

  it("forwards root-level settings and safely represents paths in the hint", () => {
    // As `publishRootOptions` does for `human-hindsight --home /root-selected distill`.
    vi.stubEnv("HUMAN_HINDSIGHT_HOME", "/root-selected");
    publishedVariables.add("HUMAN_HINDSIGHT_HOME");
    onTestFinished(() => {
      publishedVariables.delete("HUMAN_HINDSIGHT_HOME");
    });
    vi.stubEnv("HUMAN_HINDSIGHT_MODEL", "from-root");
    vi.stubEnv("HUMAN_HINDSIGHT_CLUSTER_MODEL", "grouping-from-root");
    vi.stubEnv("HUMAN_HINDSIGHT_FOLLOW_UP", "0");
    expect(flowArgs({}).model).toBe("from-root");
    expect(flowArgs({})["cluster-model"]).toBe("grouping-from-root");
    expect(flowArgs({})["follow-up"]).toBe(false);
    expect(nextArguments("distill", {})).toContain("--home=/root-selected");
    expect(nextArguments("distill", {})).toContain("--cluster-model=grouping-from-root");
    expect(nextArguments("distill", { "cluster-model": "explicit-grouping" })).toContain(
      "--cluster-model=explicit-grouping",
    );
    expect(nextCommandText("gui", { home: "/a user's library" })).toContain(
      "'--home=/a user'\\''s library'",
    );
    expect(nextArguments("copy", { slug: "-unusual" }).slice(-2)).toEqual(["--", "-unusual"]);
  });

  it("the follow-up after export is one line that can be copied whole, folder flags included", () => {
    const text = nextCommandText("distill", {
      home: "/data/hindsight",
      "claude-dir": "/history/two\nlines",
      "codex-dir": "/history/with\ttab and space",
      "kiro-dir": "/history/plain",
    });
    expect([...text].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)).toBe(true);
    expect(
      text.startsWith(
        "npx human-hindsight reflect --home=/data/hindsight $'--claude-dir=/history/two\\nlines' " +
          "$'--codex-dir=/history/with\\ttab and space' --kiro-dir=/history/plain",
      ),
    ).toBe(true);
  });

  it("keeps clustering options scoped to a distill handoff", () => {
    const input = { "cluster-model": "grouping", "cluster-batch-size": "50" };
    for (const command of ["export", "preferences", "gui"] as const) {
      expect(nextArguments(command, input).join(" ")).not.toContain("--cluster-");
    }
  });

  it("keeps the history selection for retention and only the library folder for prune", () => {
    const chosen = {
      home: "/another library",
      source: "claude",
      "claude-dir": "/copied history",
      project: "one-project",
      runner: "codex",
      plain: true,
      apply: true,
      force: true,
    };
    expect(nextCommandText("retention", chosen)).toBe(
      "npx human-hindsight retention '--home=/another library' '--claude-dir=/copied history' --source=claude --plain",
    );
    expect(nextCommandText("prune", chosen)).toBe(
      "npx human-hindsight prune '--home=/another library' --plain",
    );
  });

  it("preserves explicit automatic runner selection for reflection handoffs", () => {
    vi.stubEnv("HUMAN_HINDSIGHT_RUNNER", undefined);
    expect(nextArguments("reflect", {})).not.toContain("--runner=auto");
    expect(nextCommandText("distill", { runner: "auto" })).toBe(
      "npx human-hindsight reflect --runner=auto",
    );
    vi.stubEnv("HUMAN_HINDSIGHT_RUNNER", "auto");
    expect(nextArguments("reflect", {}, { dispatch: true })).toContain("--runner=auto");
  });

  it("forwards --author-model to a distill handoff only, and reads its env default", () => {
    vi.stubEnv("HUMAN_HINDSIGHT_AUTHOR_MODEL", "writing-from-root");
    expect(flowArgs({})["author-model"]).toBe("writing-from-root");
    expect(nextArguments("distill", {})).toContain("--author-model=writing-from-root");
    expect(nextArguments("distill", { "author-model": "explicit-writing" })).toContain(
      "--author-model=explicit-writing",
    );
    for (const command of ["export", "preferences", "gui"] as const) {
      expect(nextArguments(command, { "author-model": "writing" }).join(" ")).not.toContain(
        "--author-model",
      );
    }
  });

  // Every command printed for the person to run next comes from one builder,
  // so each reproduces this run's choices: quick start, quality, the pinned CLI
  // and models, the folders, and the distill switches.
  const run = {
    home: "/data",
    "claude-dir": "/history/claude",
    source: "claude",
    project: "alpha",
    recent: "25",
    quality: "best",
    runner: "codex",
    model: "model-a",
    "cluster-model": "model-b",
    "author-model": "model-c",
    group: false,
    generalize: false,
    breaker: false,
    plain: true,
    yes: true,
    fresh: true,
  };
  const everything = [
    "--home=/data",
    "--claude-dir=/history/claude",
    "--source=claude",
    "--project=alpha",
    "--recent=25",
    "--quality=best",
    "--runner=codex",
    "--model=model-a",
    "--cluster-model=model-b",
    "--author-model=model-c",
    "--no-group",
    "--no-generalize",
    "--no-breaker",
    "--plain",
  ];
  it.each([
    ["the whole-plan command", `${nextCommandText("distill", run)} --dry-run`, everything, []],
    ["the line after Ctrl-C", nextCommandText("distill", run), everything, []],
    [
      "the export hint",
      nextCommandText("export", run),
      ["--home=/data", "--claude-dir=/history/claude", "--recent=25", "--quality=best"],
      ["--no-group", "--cluster-model"],
    ],
    [
      "strict retry of the reads",
      retryCommandText("digest", run),
      ["--home=/data", "--runner=codex", "--quality=best", "--model=model-a", "--plain"],
      ["--recent", "--claude-dir", "--project", "--no-group", "--cluster-model", "--author-model"],
    ],
    [
      "strict retry of the writing",
      retryCommandText("author", run),
      ["--author-model=model-c", "--retry-stage=author"],
      ["--cluster-model"],
    ],
    ["the library hint", nextCommandText("gui", run), ["--home=/data", "--plain"], ["--quality"]],
    [
      "the subagents hint",
      nextCommandText("suggest-subagents", run),
      ["--home=/data", "--quality=best", "--runner=codex"],
      ["--recent", "--model="],
    ],
  ])("%s keeps the choices it can use", (_what, text, kept, left) => {
    const words = text.split(" ");
    expect(words.slice(0, 2)).toEqual(["npx", "human-hindsight"]);
    for (const flag of kept) expect(words, flag).toContain(flag);
    for (const flag of left) expect(text, flag).not.toContain(flag);
    // Never an action or approval flag.
    expect(text).not.toMatch(/--(?:yes|fresh)\b/);
  });

  // suggest-subagents gives --model, --author-model, --concurrency, and the
  // like its own meaning: they select its stages. Its hints keep them for its
  // own command and never hand them to distill, even through the variables a
  // shared --model sets.
  const subagentRun = {
    home: "/data",
    "claude-dir": "/history/claude",
    source: "claude",
    project: "alpha",
    quality: "best",
    runner: "codex",
    model: "summary-model",
    "propose-model": "roles-model",
    "author-model": "writer-model",
    concurrency: "4",
    timeout: "120",
    "input-budget": "90000",
    "window-size": "30",
    "min-roles": "3",
    "max-roles": "6",
    "include-unreviewed": true,
    plain: true,
    yes: true,
  };
  const ownSelections = [
    "--model=summary-model",
    "--propose-model=roles-model",
    "--author-model=writer-model",
    "--concurrency=4",
    "--timeout=120",
    "--input-budget=90000",
    "--window-size=30",
    "--min-roles=3",
    "--max-roles=6",
    "--include-unreviewed",
  ];
  it.each([
    [
      "its own command again",
      "suggest-subagents",
      ["--home=/data", "--quality=best", "--runner=codex", "--plain", ...ownSelections],
      ["--yes", "--claude-dir"],
    ],
    [
      "distill, when no preference exists yet",
      "distill",
      [
        "--home=/data",
        "--claude-dir=/history/claude",
        "--source=claude",
        "--project=alpha",
        "--quality=best",
        "--runner=codex",
        "--plain",
      ],
      ["--model", "--author-model", "--concurrency", "--timeout", "--input-budget", "--yes"],
    ],
    ["the library", "gui", ["--home=/data", "--plain"], ["--model", "--quality", "--runner"]],
  ] as const)("a hint from suggest-subagents to %s keeps the choices it can use", (_what, command, kept, left) => {
    vi.stubEnv("HUMAN_HINDSIGHT_MODEL", "summary-model");
    vi.stubEnv("HUMAN_HINDSIGHT_AUTHOR_MODEL", "writer-model");
    const words = nextArguments(command, subagentRun, { from: "suggest-subagents" });
    for (const flag of kept) expect(words, flag).toContain(flag);
    for (const flag of left)
      expect(
        words.some((word) => word.startsWith(flag)),
        flag,
      ).toBe(false);
  });

  it("a printed command names a folder only when leaving it out would change it", () => {
    vi.stubEnv("HUMAN_HINDSIGHT_HOME", "/data");
    vi.stubEnv("HUMAN_HINDSIGHT_CLAUDE_DIR", undefined);
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/history/claude");
    // The same folders this person's shell already selects: left out.
    expect(nextCommandText("distill", { home: "/data", "claude-dir": "/history/claude" })).toBe(
      "npx human-hindsight reflect",
    );
    // Others are kept.
    expect(nextArguments("distill", { home: "/other", "claude-dir": "/elsewhere" })).toEqual([
      "--home=/other",
      "--claude-dir=/elsewhere",
    ]);
    // The prune hint and the retry line after Ctrl-C follow the same rule.
    expect(printedHome("/data")).toEqual([]);
    expect(printedHome("/other")).toEqual(["--home=/other"]);
    // A value this process published from a root flag is not this person's default.
    publishedVariables.add("HUMAN_HINDSIGHT_HOME");
    try {
      expect(nextArguments("gui", { home: "/data" })).toEqual(["--home=/data"]);
      expect(printedHome("/data")).toEqual(["--home=/data"]);
    } finally {
      publishedVariables.delete("HUMAN_HINDSIGHT_HOME");
    }
  });

  it("a printed command never carries --no-follow-up or --yes; a dispatched one keeps the opt-out", () => {
    const input = { home: "/other", "follow-up": false, yes: true };
    for (const command of ["gui", "distill", "suggest-subagents", "list"] as const) {
      const text = nextCommandText(command, input);
      expect(text, command).not.toMatch(/--no-follow-up|--yes/);
      expect(nextArguments(command, input, { dispatch: true }), command).toContain(
        "--no-follow-up",
      );
    }
  });

  it("limits strict retry hints to explicit options valid for the selected stage", () => {
    vi.stubEnv("HUMAN_HINDSIGHT_MODEL", "ambient-model");
    vi.stubEnv("HUMAN_HINDSIGHT_CLUSTER_MODEL", "ambient-grouping");
    vi.stubEnv("HUMAN_HINDSIGHT_PROJECT", "ambient-project");
    const input = {
      home: "/selected library",
      model: "explicit-model",
      "cluster-model": "explicit-grouping",
      "cluster-batch-size": "50",
      project: "not-a-retry-option",
      yes: true,
      fresh: true,
    };
    const clustering = retryCommandText("cluster", input);
    expect(clustering).toContain("'--home=/selected library'");
    expect(clustering).toContain("--model=explicit-model");
    expect(clustering).toContain("--cluster-model=explicit-grouping");
    expect(clustering).toContain("--retry-failed --retry-stage=cluster");
    expect(clustering).not.toMatch(/ambient|--(?:project|cluster-batch-size|yes|fresh)/);
    for (const stage of ["digest", "author"] as const) {
      expect(retryCommandText(stage, input)).not.toContain("--cluster-model");
    }
    expect(retryCommandText("cluster", {})).not.toContain("--model");
    expect(retryCommandText("cluster", {})).not.toContain("--cluster-model");
  });
});

describe("the closing menu after a distill", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function terminal() {
    const host = new EventEmitter() as TerminalHost & EventEmitter;
    Object.assign(host, { pid: 4242, kill: () => true });
    const input = fakeInput();
    const output = fakeOutput({ columns: 100, rows: 30 });
    return { input, output, io: { input, output, host, env: { TERM: "xterm-256color" } } };
  }

  /** A fake command runner. suggest-subagents saves a suggestion, as the real one does. */
  function runner(home: string, codes: Partial<Record<NextCommand, number>> = {}) {
    const calls: { command: NextCommand; args: string[] }[] = [];
    const run: CommandRunner = async (command, args) => {
      calls.push({ command, args: nextArguments(command, args) });
      if (command === "suggest-subagents" && !codes[command]) {
        const built = sampleHome().build();
        fs.mkdirSync(path.dirname(suggestionPath(home)), { recursive: true });
        fs.copyFileSync(suggestionPath(built.dir), suggestionPath(home));
        built.remove();
      }
      return codes[command] ?? 0;
    };
    return { run, calls };
  }

  const tempHome = () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-next-"));
    homes.push(home);
    return home;
  };
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  async function choose(keys: string[], codes: Partial<Record<NextCommand, number>> = {}) {
    const home = tempHome();
    const t = terminal();
    const fake = runner(home, codes);
    const done = offerLibraryNext({ home }, t.io, fake.run);
    await settle();
    t.input.press(...keys);
    const code = await done;
    const vt = terminalModel(100);
    vt.apply(t.output.raw());
    return { code, calls: fake.calls, screen: vt.rows().join("\n"), text: t.output.text() };
  }

  it("offers the library, subagents, and done, in that order", async () => {
    const t = await choose(["3"]);
    expect(t.screen).toContain("• Open my reflections (recommended)  in the browser");
    expect(t.screen).toContain("• Suggest subagents");
    expect(t.screen).toContain("› Done for now");
    expect(t.code).toBe(0);
    expect(t.calls).toEqual([]);
  });

  it("opens the Preferences overview in the browser", async () => {
    const t = await choose([KEYS.enter]);
    expect(t.calls).toEqual([
      { command: "gui", args: expect.arrayContaining(["--tab=preferences"]) },
    ]);
  });

  it("subagents runs that command, which ends with its own closing menu; nothing else opens here", async () => {
    const t = await choose(["2"]);
    expect(t.calls.map((call) => call.command)).toEqual(["suggest-subagents"]);
    expect(t.code).toBe(0);
  });

  it("a declined or failed generation ends with its own exit code and opens nothing", async () => {
    const t = await choose(["2"], { "suggest-subagents": 2 });
    expect(t.calls.map((call) => call.command)).toEqual(["suggest-subagents"]);
    expect(t.code).toBe(2);
  });

  it.each([
    ["Ctrl-C exits 130 after one line", [KEYS.ctrlC], 130, 1],
    ["q exits 0 quietly", ["q"], 0, 0],
    ["end of input exits 0 quietly", [KEYS.ctrlD], 0, 0],
  ] as [string, string[], number, number][])("%s", async (_name, keys, code, lines) => {
    const t = await choose(keys);
    expect(t.code).toBe(code);
    expect(t.text.split("\n").filter((line) => line === "Interrupted.")).toHaveLength(lines);
    expect(t.calls).toEqual([]);
  });

  it("--yes prints the next commands and never reads stdin", async () => {
    const home = tempHome();
    const t = terminal();
    const read = vi.spyOn(t.input, "read");
    const fake = runner(home);
    expect(await offerLibraryNext({ home, yes: true }, t.io, fake.run)).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(t.input.rawModeCalls).toEqual([]);
    expect(t.output.text()).toContain("next: npx human-hindsight gui");
    expect(t.output.text()).toContain("suggest-subagents");
    expect(fake.calls).toEqual([]);
  });

  it("generating subagents returns that command's own exit code", async () => {
    const home = tempHome();
    const calls: NextCommand[] = [];
    const code = await generateSubagents({ home }, async (command) => {
      calls.push(command);
      return 2;
    });
    expect(code).toBe(2);
    expect(calls).toEqual(["suggest-subagents"]);
  });
});
