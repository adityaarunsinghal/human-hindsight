import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HomeAction, type HomeArgs, type HomeIo, runHome } from "../src/commands/home.js";
import type { HistoryCounts } from "../src/core/environment-history.js";
import { PRIVACY_REMINDER } from "../src/core/privacy.js";
import { PROBES } from "../src/runners/capabilities.js";
import type { RunnerName } from "../src/runners/types.js";
import type { SourceName } from "../src/sources/types.js";
import type { TerminalHost } from "../src/ui/live.js";
import { homeBuilder, sampleHome } from "./support/home.js";
import { type FakeRunnerIo, fakeRunnerIo } from "./support/runner-io.js";
import { goldenText } from "./support/text.js";
import { type FakeOutput, fakeInput, fakeOutput, KEYS } from "./support/tty.js";
import { terminalModel } from "./ui-vt.js";

/**
 * The bare command's first-run matrix, in process. Every coding CLI is a
 * scripted fake, history counts are injected (no background reader), the
 * clock is fixed, and the chosen action is captured instead of run. No test
 * starts a process or waits on a timer.
 */

const NOW = new Date("2026-11-20T10:00:00Z");
const BINARIES: Record<RunnerName, string> = {
  claude: "claude",
  codex: "codex",
  kiro: "kiro-cli",
  opencode: "opencode",
};
/** What each CLI's sign-in probe prints in each state; each runner's parser reads these. */
const SIGN_IN: Record<RunnerName, Record<"ready" | "signed-out", string>> = {
  claude: { ready: "Logged in\n", "signed-out": "Not logged in\n" },
  codex: { ready: "Logged in using ChatGPT\n", "signed-out": "Not logged in\n" },
  kiro: { ready: "Signed in with a synthetic account\n", "signed-out": "Not logged in\n" },
  opencode: { ready: "2 credentials\n", "signed-out": "0 credentials\n" },
};
const STORE: Record<SourceName, string[]> = {
  claude: ["claude", "projects"],
  codex: ["codex", "sessions"],
  kiro: ["kiro", "sessions"],
  kirocrew: ["kirocrew", "sessions"],
  opencode: ["opencode", "storage", "session"],
};

type Counts = Pick<HistoryCounts, "sessions" | "projects"> & { newSessions?: number };

interface Case {
  /** Stores present on disk, with what the counter reports for each. */
  history?: Partial<Record<SourceName, Counts>>;
  /** Installed CLIs and what their sign-in probe says. */
  installed?: Partial<Record<RunnerName, "ready" | "signed-out">>;
  saved?: "exported" | "library" | "subagents";
  args?: HomeArgs;
  /** Kiro is first counted with Kiro Crew runs included, then exactly. */
  kiroInexactFirst?: boolean;
  /** Hold the counts back until the test releases them. */
  slowCounts?: boolean;
  /** What each CLI's `--version` prints (default 1.2.3). */
  versions?: Partial<Record<RunnerName, string>>;
  /** Hold every version and sign-in probe back until the test releases it. */
  slowProbes?: boolean;
  terminal?: { tty?: boolean; columns?: number; rows?: number; env?: Record<string, string> };
}

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
beforeEach(() => {
  // A credential in the developer's environment would turn "signed out" into "unknown".
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "KIRO_API_KEY",
  ]) {
    vi.stubEnv(key, "");
  }
  vi.stubEnv("LANG", "en_US.UTF-8");
  vi.stubEnv("LC_ALL", "");
  vi.stubEnv("LC_CTYPE", "");
  vi.stubEnv("NO_COLOR", "");
  vi.stubEnv("FORCE_COLOR", "");
});

function fakeHost(): TerminalHost & EventEmitter {
  const host = new EventEmitter() as TerminalHost & EventEmitter;
  Object.assign(host, { pid: 4242, kill: () => true });
  return host;
}

/** Let pushed keys and published facts reach the menu: one turn of the event loop. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(c: Case) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-home-"));
  roots.push(root);
  const dirs = {
    "claude-dir": path.join(root, "claude"),
    "codex-dir": path.join(root, "codex"),
    "kiro-dir": path.join(root, "kiro"),
    "kirocrew-dir": path.join(root, "kirocrew"),
    "opencode-dir": path.join(root, "opencode"),
  };
  for (const name of Object.keys(c.history ?? {}) as SourceName[]) {
    fs.mkdirSync(path.join(root, ...STORE[name]), { recursive: true });
  }
  const home = path.join(root, "home");
  if (c.saved === "subagents") sampleHome().build(home);
  else if (c.saved === "library") {
    homeBuilder()
      .session({
        project: "alpha",
        sessionId: "a1111111-0000-4000-8000-000000000001",
        messages: ["Keep the change small and run the tests."],
      })
      .digestAll()
      .task({ slug: "small-change", members: [0] })
      .library("small-change")
      .build(home);
  } else if (c.saved === "exported") {
    homeBuilder()
      .session({
        project: "alpha",
        sessionId: "a1111111-0000-4000-8000-000000000001",
        messages: ["Keep the change small and run the tests."],
      })
      .build(home);
  }

  const processes: FakeRunnerIo = fakeRunnerIo();
  // Probes held back by `slowProbes`, released one at a time, oldest first.
  const held: (() => void)[] = [];
  for (const [name, state] of Object.entries(c.installed ?? {}) as [
    RunnerName,
    "ready" | "signed-out",
  ][]) {
    const bin = BINARIES[name];
    const answer = (stdout: string) =>
      c.slowProbes
        ? () => new Promise<{ stdout: string }>((resolve) => held.push(() => resolve({ stdout })))
        : { stdout };
    processes.script(bin, { args: ["--version"] }, answer(`${c.versions?.[name] ?? "1.2.3"}\n`));
    processes.script(
      bin,
      { args: [...(PROBES[name]["sign-in"]?.args ?? [])] },
      answer(SIGN_IN[name][state]),
    );
  }
  processes.failOnUnscripted();

  // Held-back counts are published synchronously by `release`, so a test can
  // order them exactly against a key press.
  let release = () => {};
  const countHistory: HomeIo["countHistory"] = (request, publish) => {
    const publishAll = () => {
      for (const name of request.names) {
        const counts = c.history?.[name] ?? { sessions: 0, projects: 0 };
        const history: HistoryCounts = { newSessions: 0, ...counts, newest: NOW, exact: true };
        if (name === "kiro" && c.kiroInexactFirst) {
          publish({ name, history: { ...history, sessions: history.sessions + 4, exact: false } });
        } else publish({ name, history });
      }
    };
    if (!c.slowCounts) {
      publishAll();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      release = () => {
        publishAll();
        resolve();
      };
    });
  };

  const t = c.terminal ?? {};
  const input = fakeInput({ isTTY: t.tty ?? true });
  const output = fakeOutput({ isTTY: t.tty ?? true, columns: t.columns ?? 80, rows: t.rows ?? 40 });
  const dispatched: HomeAction[] = [];
  const io: HomeIo = {
    input,
    output,
    env: { TERM: "xterm-256color", LANG: "en_US.UTF-8", ...t.env },
    host: fakeHost(),
    // The bounded wait for slow facts never runs out unless a test says so.
    wait: () => new Promise<void>(() => {}),
    now: () => NOW,
    processes,
    countHistory,
    dispatch: async (action) => {
      dispatched.push(action);
      return 0;
    },
  };
  const args: HomeArgs = { home, ...dirs, ...c.args };
  return {
    root,
    home,
    args,
    io,
    input,
    output,
    processes,
    dispatched,
    release: () => release(),
    held,
  };
}

/** What a person sees on the terminal after everything written so far. */
function screen(output: FakeOutput): string {
  const vt = terminalModel(output.columns);
  vt.apply(output.raw());
  return vt.rows().join("\n").replace(/\s+$/, "");
}

/** The numbered or key menu items as drawn, label only. */
function menuItems(text: string): string[] {
  const start = text.lastIndexOf("What would you like to do?");
  return text
    .slice(start)
    .split("\n")
    .slice(1)
    .map((line) => /^[ ›>] (\d) {2}(.+?)(?: \(recommended\))?(?: {2}.*)?$/.exec(line)?.[2])
    .filter((label): label is string => Boolean(label));
}

async function run(c: Case, keys: string[] = ["q"]) {
  const t = setup(c);
  const done = runHome(t.args, t.io);
  // First paint, then the cheap probes and the injected counts land.
  await settle();
  await settle();
  t.input.press(...keys);
  const code = await done;
  return { ...t, code, text: t.output.text(), shown: screen(t.output) };
}

const golden = (text: string, t: { root: string }) =>
  goldenText(text, { roots: { [t.root]: "<ROOT>" } });

const READY_HISTORY: Case = {
  history: { claude: { sessions: 12, projects: 3 } },
  installed: { claude: "ready" },
};

describe("first run, without a terminal", () => {
  const states: [string, Case][] = [
    ["no-history", {}],
    ["history-no-cli", { history: { claude: { sessions: 12, projects: 3 } } }],
    [
      "signed-out",
      { history: { claude: { sessions: 12, projects: 3 } }, installed: { claude: "signed-out" } },
    ],
    ["one-ready", READY_HISTORY],
    [
      "several-ready",
      {
        history: { claude: { sessions: 12, projects: 3 }, codex: { sessions: 5, projects: 2 } },
        installed: { claude: "ready", codex: "ready", opencode: "ready" },
      },
    ],
    ["exported", { ...READY_HISTORY, saved: "exported" }],
    ["library", { ...READY_HISTORY, saved: "library" }],
    ["subagents", { ...READY_HISTORY, saved: "subagents" }],
    [
      "new-sessions",
      {
        history: { claude: { sessions: 12, projects: 3, newSessions: 3 } },
        installed: { claude: "ready" },
        saved: "library",
      },
    ],
    [
      "selection-empty",
      { history: { claude: { sessions: 0, projects: 0 } }, args: { project: "nothing-matches" } },
    ],
  ];

  it.each(states)("%s: prints the settled summary and the next command", async (name, c) => {
    const t = await run({ ...c, terminal: { tty: false } }, []);
    expect(t.code).toBe(0);
    // A pipe gets no prompt and no escape codes.
    expect(t.output.raw()).not.toContain("\u001b");
    expect(t.text).not.toContain("What would you like to do?");
    expect(t.text).toMatch(/next: human-hindsight /);
    await expect(golden(t.text, t)).toMatchFileSnapshot(`golden/home/pipe-${name}.txt`);
  });

  it("an empty machine gets the friendly empty state, not an install command or a zero count", async () => {
    const t = await run({ terminal: { tty: false } }, []);
    expect(t.text).toContain("No session history found on this machine yet.");
    expect(t.text).toContain("Looked for Claude Code, Codex, Kiro CLI, Kiro Crew, and OpenCode.");
    expect(t.text).toContain("--claude-dir <dir>");
    expect(t.text).not.toMatch(/0 sessions|install|npm |curl /);
    expect(t.text).toMatch(/next:\s+human-hindsight doctor/);
  });

  it("history without a CLI shows one install command; a signed-out CLI shows its sign-in", async () => {
    const noCli = await run(
      { history: { claude: { sessions: 12, projects: 3 } }, terminal: { tty: false } },
      [],
    );
    expect(noCli.text).toContain(
      // The sentence sits on the card's rail; the command below it does not,
      // so the whole line can be copied as it is.
      "│ Export works now. To build a library, install a coding CLI:\n  npm install -g @anthropic-ai/claude-code && claude auth login\n",
    );
    expect(noCli.text).toMatch(/next:\s+human-hindsight export/);
    const signedOut = await run(
      {
        history: { claude: { sessions: 12, projects: 3 } },
        installed: { claude: "signed-out" },
        terminal: { tty: false },
      },
      [],
    );
    expect(signedOut.text).toContain("Sign in before building a library:\n  claude auth login\n");
    expect(signedOut.text).not.toContain("install a coding CLI");
    const ready = await run({ ...READY_HISTORY, terminal: { tty: false } }, []);
    expect(ready.text).not.toMatch(/Sign in before|install a coding CLI|Choose a writable/);
    expect(ready.text).toContain("12 sessions across 3 projects. Newest activity: today.");
  });

  it("a grand total appears only once every count is exact", async () => {
    const c: Case = {
      history: { claude: { sessions: 12, projects: 3 }, kiro: { sessions: 6, projects: 2 } },
      installed: { claude: "ready" },
      kiroInexactFirst: true,
      terminal: { tty: false },
    };
    const inexact = await run(c, []);
    expect(inexact.text).not.toMatch(/sessions across/);
    expect(inexact.text).toContain("Still checking Kiro Crew runs in Kiro CLI history.");
    const exact = await run({ ...c, kiroInexactFirst: false }, []);
    expect(exact.text).toContain("18 sessions across 5 projects.");
  });

  it("says exactly what stays private and asks the tools only for versions and sign-in status", async () => {
    const t = await run(
      {
        history: { claude: { sessions: 2, projects: 1 } },
        installed: { claude: "ready", codex: "ready", kiro: "ready", opencode: "signed-out" },
        terminal: { tty: false },
      },
      [],
    );
    // The card's privacy lines are exactly these two sentences: printed once,
    // and in a live frame at 80 and at 60 columns.
    const said = (text: string) => {
      const rows = text.split("\n");
      const at = rows.findIndex((row) => row.includes("Private by default"));
      const end = rows.findIndex((row, i) => i > at && !row.startsWith("│"));
      return rows
        .slice(at + 1, end < 0 ? undefined : end)
        .map((row) => row.replace(/^│ ?/, "").trim())
        .join(" ");
    };
    const exactly =
      "No session text leaves this machine until you approve a plan. This screen only asks your coding tools for their version and sign-in status.";
    expect(said(t.text)).toBe(exactly);
    for (const columns of [80, 60]) {
      const live = await run({ ...READY_HISTORY, terminal: { columns, rows: 24 } });
      expect(said(live.shown), `${columns} columns`).toBe(exactly);
    }
    expect(t.text).not.toMatch(/no network/i);
    // The reminder shown before model steps names the person's coding tool in plain words.
    expect(PRIVACY_REMINDER).toContain("your own coding tool and its configured provider");
    expect(PRIVACY_REMINDER).not.toMatch(/harness/i);
    const local = Object.entries(PROBES).flatMap(([name, probes]) =>
      Object.entries(probes)
        .filter(
          ([kind, probe]) =>
            probe.scope !== "network" && (kind === "version" || kind === "sign-in"),
        )
        .map(([, probe]) => `${BINARIES[name as RunnerName]} ${probe.args.join(" ")}`),
    );
    const spawned = t.processes.calls.map(
      (call) => `${path.basename(call.bin)} ${call.args.join(" ")}`,
    );
    expect(spawned.length).toBe(8);
    for (const call of spawned) expect(local).toContain(call);
    for (const call of t.processes.calls) expect(call.stdin).toBe("");
  });

  it("an unwritable data home gets that fix and nothing else, in the form that wins", async () => {
    const t = setup({ ...READY_HISTORY, terminal: { tty: false } });
    const blocker = path.join(t.root, "file");
    fs.writeFileSync(blocker, "");
    // Chosen with --home: only another --home changes it.
    const code = await runHome({ ...t.args, home: path.join(blocker, "home") }, t.io);
    expect(code).toBe(0);
    const text = t.output.text();
    expect(text).toMatch(/\n│ Choose a writable data home:\n {2}human-hindsight --home "\S+"\n/);
    expect(text).not.toMatch(/install a coding CLI|Sign in before|export HUMAN_HINDSIGHT_HOME/);
    // Chosen with the variable: change the variable.
    const viaVariable = setup({ ...READY_HISTORY, terminal: { tty: false } });
    vi.stubEnv("HUMAN_HINDSIGHT_HOME", path.join(blocker, "home"));
    await runHome({ ...viaVariable.args, home: undefined }, viaVariable.io);
    expect(viaVariable.output.text()).toMatch(
      /\n│ Choose a writable data home:\n {2}export HUMAN_HINDSIGHT_HOME=\S+\n/,
    );
  });

  it.each([
    ["--yes", { yes: true }],
    ["--dry-run", { "dry-run": true }],
    ["--no-follow-up", { "follow-up": false }],
  ] as [
    string,
    HomeArgs,
  ][])("%s in a terminal prints the summary and never reads stdin", async (_flag, flags) => {
    const t = setup({ ...READY_HISTORY, args: flags });
    const read = vi.spyOn(t.input, "read");
    const code = await runHome(t.args, t.io);
    expect(code).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(t.input.rawModeCalls).toEqual([]);
    expect(t.input.listenerCount("data") + t.input.listenerCount("keypress")).toBe(0);
    expect(t.output.text()).toMatch(/next:\s+human-hindsight export/);
    expect(t.output.text()).not.toContain("What would you like to do?");
  });
});

describe("first run, in a terminal", () => {
  it.each([
    ["no history", {}, ["Check my setup"]],
    [
      "history but no CLI",
      { history: { claude: { sessions: 12, projects: 3 } } },
      ["Export my prompts only", "Show every project", "Check my setup"],
    ],
    [
      "one CLI ready",
      READY_HISTORY,
      ["Build my prompt library", "Export my prompts only", "Show every project", "Check my setup"],
    ],
    [
      "exported only",
      { ...READY_HISTORY, saved: "exported" },
      [
        "Distill my exported sessions",
        "Export my prompts only",
        "Show every project",
        "Check my setup",
      ],
    ],
    [
      "exported, no CLI",
      { history: { claude: { sessions: 12, projects: 3 } }, saved: "exported" },
      ["Check my setup", "Export my prompts only", "Show every project"],
    ],
    [
      "library present",
      { ...READY_HISTORY, saved: "library" },
      [
        "Open my library",
        "Generate my subagents",
        "Refresh my library",
        "Export my prompts only",
        "Show every project",
        "Check my setup",
      ],
    ],
    [
      "subagents present",
      { ...READY_HISTORY, saved: "subagents" },
      [
        "Open my subagents",
        "Open my prompt library",
        "Refresh my library",
        "Export my prompts only",
        "Show every project",
        "Check my setup",
      ],
    ],
  ] as [
    string,
    Case,
    string[],
  ][])("%s: the first item is the recommended next step", async (_name, c, items) => {
    const t = await run(c);
    expect(t.code).toBe(0);
    expect(menuItems(t.shown)).toEqual(items);
    expect(t.shown).toContain(`1  ${items[0]} (recommended)`);
  });

  it.each([80, 60])("matches the golden frame at %i columns", async (columns) => {
    const t = await run({ ...READY_HISTORY, saved: "library", terminal: { columns } });
    await expect(golden(t.shown, t)).toMatchFileSnapshot(
      `golden/home/terminal-library-${columns}.txt`,
    );
  });

  it("a slow fact changes the table text, the items stay put, and a digit pressed as it lands selects what was on screen", async () => {
    const t = setup({
      history: { claude: { sessions: 12, projects: 3, newSessions: 3 } },
      installed: { claude: "ready" },
      saved: "library",
      slowCounts: true,
    });
    const done = runHome(t.args, t.io);
    await settle();
    // The first paint comes before any probe; a second turn lets the cheap probes land.
    expect(screen(t.output)).toContain("Still checking history counts, command versions");
    await settle();
    const before = screen(t.output);
    expect(before).toContain("claude 1.2.3");
    expect(before).toContain("Still checking history counts.");
    expect(before).toContain("checking for sessions since your last export");
    const shownBefore = menuItems(before);
    // The counts land and the frame is redrawn; the digit, aimed at the frame
    // the person was reading, arrives right after.
    t.release();
    t.input.press("2");
    const code = await done;
    expect(code).toBe(0);
    const after = screen(t.output);
    expect(after).toContain("12 sessions across 3 projects.");
    expect(after).toContain("3 new sessions since your last export");
    expect(menuItems(after)).toEqual(shownBefore);
    expect(t.dispatched).toEqual(["suggest"]);
    expect(shownBefore[1]).toBe("Generate my subagents");
  });

  it("a store that turns out empty keeps its items and is not recommended away", async () => {
    const t = setup({
      history: { claude: { sessions: 0, projects: 0 } },
      installed: { claude: "ready" },
      slowCounts: true,
    });
    const done = runHome(t.args, t.io);
    await settle();
    await settle();
    const before = menuItems(screen(t.output));
    t.release();
    await settle();
    const after = screen(t.output);
    expect(menuItems(after)).toEqual(before);
    expect(after).toContain(`1  ${before[0]} (recommended)`);
    expect(after).toContain("No session history found on this machine yet.");
    t.input.press("q");
    expect(await done).toBe(0);
  });

  it.each([
    ["q quits quietly with 0", ["q"], 0, false],
    ["end of input quits with 0", [KEYS.ctrlD], 0, false],
    ["Ctrl-C prints one line and exits 130", [KEYS.ctrlC], 130, true],
  ] as [string, string[], number, boolean][])("%s", async (_name, keys, expected, line) => {
    const t = await run(READY_HISTORY, keys);
    expect(t.code).toBe(expected);
    expect(t.text.split("\n").filter((row) => row === "Interrupted.").length).toBe(line ? 1 : 0);
    expect(t.dispatched).toEqual([]);
    expect(t.input.isRaw).toBe(false);
  });

  it.each([
    ["Enter takes the recommended item", [KEYS.enter], "build"],
    ["a digit takes that item", ["3"], "scan"],
    ["arrows move, Enter takes", [KEYS.down, KEYS.enter], "export"],
  ] as [string, string[], HomeAction][])("%s", async (_name, keys, action) => {
    const t = await run(READY_HISTORY, keys);
    expect(t.dispatched).toEqual([action]);
  });
});

describe("one screen at the default window size", () => {
  const states: [string, Case][] = [
    ["no history", {}],
    ["history, no CLI", { history: { claude: { sessions: 12, projects: 3 } } }],
    [
      "signed out",
      { history: { claude: { sessions: 12, projects: 3 } }, installed: { claude: "signed-out" } },
    ],
    ["one ready", READY_HISTORY],
    [
      "several ready",
      {
        history: { claude: { sessions: 12, projects: 3 }, codex: { sessions: 5, projects: 2 } },
        installed: { claude: "ready", codex: "ready", opencode: "ready" },
      },
    ],
    ["exported", { ...READY_HISTORY, saved: "exported" }],
    ["library", { ...READY_HISTORY, saved: "library" }],
    ["subagents", { ...READY_HISTORY, saved: "subagents" }],
    [
      "every tool with history",
      {
        history: {
          claude: { sessions: 12, projects: 3 },
          codex: { sessions: 5, projects: 2 },
          kiro: { sessions: 4, projects: 2 },
          kirocrew: { sessions: 2, projects: 1 },
          opencode: { sessions: 3, projects: 1 },
        },
        installed: { claude: "ready", codex: "signed-out", kiro: "ready", opencode: "ready" },
        saved: "library",
      },
    ],
  ];
  const sizes = [80, 60];
  it.each(
    states.flatMap(([name, c]) => sizes.map((columns) => [name, columns, c] as const)),
  )("%s at %i x 24: the title and the live menu fit, nothing is wider, no row is cut", async (_name, columns, c) => {
    const t = await run({ ...c, terminal: { columns, rows: 24 } });
    const rows = t.shown.split("\n");
    expect(rows.length).toBeLessThanOrEqual(23);
    expect(rows[0]).toContain("Human Hindsight");
    expect(t.shown).toContain("Use arrow keys and Enter");
    expect(t.text).not.toContain("Choose [");
    for (const row of rows) expect(row.length, row).toBeLessThan(columns);
    // A menu row is never cut in the middle of a word.
    expect(t.shown.slice(t.shown.indexOf("What would you like"))).not.toContain("…");
    // A blank line never follows another.
    expect(t.shown).not.toMatch(/\n\s*\n\s*\n/);
  });

  it.each([
    80, 60,
  ])("at %i columns the frame above the menu keeps its height while versions and sign-in land", async (columns) => {
    const t = setup({
      history: {
        claude: { sessions: 224, projects: 13 },
        codex: { sessions: 489, projects: 12 },
        kiro: { sessions: 748, projects: 164 },
        opencode: { sessions: 315, projects: 21 },
      },
      installed: { claude: "ready", codex: "ready", kiro: "ready", opencode: "ready" },
      versions: { claude: "2.1.207", codex: "0.171.0", kiro: "3.5.0", opencode: "1.18.15" },
      saved: "library",
      slowProbes: true,
      terminal: { columns, rows: 40 },
    });
    const above = () => {
      const rows = screen(t.output).split("\n");
      return rows.findIndex((row) => row.includes("What would you like to do?"));
    };
    const done = runHome(t.args, t.io);
    await settle();
    await settle();
    const first = above();
    expect(first).toBeGreaterThan(0);
    expect(screen(t.output)).toMatch(/kiro-cli…/);
    const heights = [first];
    while (t.held.length) {
      t.held.shift()?.();
      await settle();
      await settle();
      heights.push(above());
    }
    expect(screen(t.output)).toContain("opencode 1.18.15");
    expect(screen(t.output)).not.toContain("checking");
    expect(
      heights.every((height) => height === first),
      heights.join(","),
    ).toBe(true);
    t.input.press("q");
    expect(await done).toBe(0);
  });

  it("matches the golden for one ready CLI at 80 x 24", async () => {
    const t = await run({ ...READY_HISTORY, terminal: { columns: 80, rows: 24 } });
    await expect(golden(t.shown, t)).toMatchFileSnapshot(
      "golden/home/terminal-one-ready-80x24.txt",
    );
  });

  it("a fix command too wide for a narrow live frame is shown as its steps, each whole", async () => {
    const t = await run({
      history: { claude: { sessions: 12, projects: 3 } },
      terminal: { columns: 60, rows: 24 },
    });
    expect(t.shown).toContain(
      "\n  npm install -g @anthropic-ai/claude-code\n  claude auth login\n",
    );
    expect(t.shown).not.toContain("…");
  });

  it("a tool with nothing to say shares one line instead of a row each", async () => {
    const t = await run(READY_HISTORY);
    expect(t.shown).toContain("No history or command found for Codex, Kiro CLI, or OpenCode.");
    expect(t.shown).not.toMatch(/Kiro Crew|! missing/);
  });

  it("drops the tagline and spacers before the menu on a short window, and keeps the title", async () => {
    const t = await run({
      history: {
        claude: { sessions: 12, projects: 3 },
        codex: { sessions: 5, projects: 2 },
        kiro: { sessions: 4, projects: 2 },
        kirocrew: { sessions: 2, projects: 1 },
        opencode: { sessions: 3, projects: 1 },
      },
      installed: { claude: "ready", codex: "ready", kiro: "ready", opencode: "ready" },
      saved: "library",
      terminal: { columns: 80, rows: 21 },
    });
    expect(t.shown.split("\n")[0]).toContain("Human Hindsight");
    expect(t.shown).not.toContain("The prompt you'd write");
    expect(t.shown).toContain("Use arrow keys and Enter");
  });

  it("an interrupted run is said once and finishing it is recommended", async () => {
    const t = setup({ ...READY_HISTORY, saved: "exported" });
    fs.mkdirSync(path.join(t.home, "distill"), { recursive: true });
    fs.writeFileSync(
      path.join(t.home, "distill", "operations.json"),
      JSON.stringify({ version: 1, operations: [{ state: "committed" }, { state: "running" }] }),
    );
    const done = runHome(t.args, t.io);
    await settle();
    await settle();
    t.input.press(KEYS.enter);
    expect(await done).toBe(0);
    const shown = screen(t.output);
    expect(shown).toContain("The last distill run stopped before it finished.");
    expect(shown).toContain("1  Finish the last run (recommended)");
    expect(menuItems(shown)).not.toContain("Distill my exported sessions");
    expect(t.dispatched).toEqual(["distill"]);
  });

  it("a finished run is not called interrupted", async () => {
    const t = setup({ ...READY_HISTORY, saved: "exported" });
    fs.mkdirSync(path.join(t.home, "distill"), { recursive: true });
    fs.writeFileSync(
      path.join(t.home, "distill", "operations.json"),
      JSON.stringify({ version: 1, operations: [{ state: "committed" }, { state: "failed" }] }),
    );
    const done = runHome(t.args, t.io);
    await settle();
    await settle();
    t.input.press("q");
    await done;
    expect(screen(t.output)).not.toContain("stopped before it finished");
  });
});

describe("terminal modes", () => {
  const numbered: [string, Case["terminal"]][] = [
    ["plain mode", { env: { HUMAN_HINDSIGHT_PLAIN: "1" } }],
    ["TERM=dumb", { env: { TERM: "dumb" } }],
    ["a terminal too short for the frame", { rows: 10 }],
    ["a 12-row terminal", { rows: 12 }],
  ];
  it.each(numbered)("%s gets a numbered prompt that takes a number", async (_name, terminal) => {
    const t = setup({ ...READY_HISTORY, terminal });
    const done = runHome(t.args, t.io);
    await settle();
    await settle();
    expect(t.output.text()).toContain("Choose [1]:");
    t.input.press("3\n");
    expect(await done).toBe(0);
    expect(t.dispatched).toEqual(["scan"]);
    expect(t.input.rawModeCalls).toEqual([]);
  });

  it("plain mode matches its golden", async () => {
    const t = setup({ ...READY_HISTORY, terminal: { env: { HUMAN_HINDSIGHT_PLAIN: "1" } } });
    const done = runHome(t.args, t.io);
    await settle();
    await settle();
    t.input.press("q\n");
    await done;
    await expect(golden(t.output.text(), t)).toMatchFileSnapshot("golden/home/terminal-plain.txt");
  });

  it("NO_COLOR writes no color codes", async () => {
    vi.stubEnv("NO_COLOR", "1");
    const t = await run({ ...READY_HISTORY, terminal: { env: { NO_COLOR: "1" } } });
    // The escape character is built from its code so no control character sits in a pattern.
    expect(t.output.raw()).not.toMatch(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`));
    await expect(golden(t.shown, t)).toMatchFileSnapshot("golden/home/terminal-no-color.txt");
  });

  it("a non-UTF-8 locale: a version still being checked ends in three dots", async () => {
    vi.stubEnv("LANG", "C");
    const t = setup({
      ...READY_HISTORY,
      installed: { claude: "ready" },
      slowProbes: true,
      terminal: { columns: 80, rows: 40, env: { LANG: "C" } },
    });
    const done = runHome(t.args, t.io);
    await settle();
    await settle();
    const shown = screen(t.output);
    expect(shown).toMatch(/\+ claude\.\.\./);
    expect([...t.output.text()].every((char) => char.charCodeAt(0) < 128)).toBe(true);
    while (t.held.length) {
      t.held.shift()?.();
      await settle();
    }
    t.input.press("q");
    await done;
  });

  it("no golden of an ASCII screen holds a Unicode ellipsis", () => {
    const dir = path.join(import.meta.dirname, "golden");
    const ascii = (fs.readdirSync(dir, { recursive: true }) as string[]).filter((file) =>
      /ascii/.test(file),
    );
    expect(ascii.length).toBeGreaterThan(0);
    for (const file of ascii)
      expect(fs.readFileSync(path.join(dir, file), "utf8"), file).not.toContain("…");
  });

  it("a non-UTF-8 locale gets ASCII only", async () => {
    vi.stubEnv("LANG", "C");
    const t = await run({ ...READY_HISTORY, terminal: { env: { LANG: "C" } } });
    expect([...t.output.text()].every((char) => char.charCodeAt(0) < 128)).toBe(true);
    await expect(golden(t.shown, t)).toMatchFileSnapshot("golden/home/terminal-ascii.txt");
  });
});
