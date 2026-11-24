import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { format } from "node:util";
import { type CommandDef, runMain } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { resolvePaths } from "../src/commands/_shared.js";
import { runDoctor } from "../src/commands/doctor.js";
import { createShowUsage } from "../src/commands/help.js";
import { nextArguments } from "../src/commands/next.js";
import { damagedFile } from "../src/core/plain-failure.js";
import { main, reportFailure } from "../src/main.js";
import type { RunnerIo, SpawnOptions } from "../src/runners/shared.js";
import { epipeHandler } from "../src/ui/epipe.js";

const EXPECTED = [
  "scan",
  "doctor",
  "help",
  "export",
  "reflect",
  "list",
  "show",
  "copy",
  "edit",
  "rate",
  "prune",
  "status",
  "preferences",
  "suggest-subagents",
  "retention",
  "gui",
];

describe("human-hindsight root command", () => {
  it("has the right name and reports the package version", () => {
    const meta = main.meta as { name: string; version: string };
    expect(meta.name).toBe("human-hindsight");
    // Read from package.json so a version bump can never silently drift this
    // assertion (the CLI's contract is "report the package version", not a
    // hardcoded literal).
    expect(meta.version).toBe(pkg.version);
  });

  it("registers all subcommands", () => {
    const subCommands = main.subCommands as Record<string, unknown>;
    expect(Object.keys(subCommands).sort()).toEqual([...EXPECTED].sort());
  });

  // Commands hidden from the short help are resolved lazily, but every one
  // stays routable under its own name.
  it("each subcommand is a citty command with matching meta.name", async () => {
    const subCommands = main.subCommands as Record<
      string,
      CommandDef | (() => Promise<CommandDef>)
    >;
    const hidden: string[] = [];
    for (const name of EXPECTED) {
      const entry = subCommands[name];
      expect(entry, `subcommand ${name}`).toBeDefined();
      const cmd = typeof entry === "function" ? await entry() : entry;
      const meta = cmd?.meta as { name?: string; hidden?: boolean } | undefined;
      expect(meta?.name).toBe(name);
      expect(typeof cmd?.run).toBe("function");
      if (meta?.hidden) hidden.push(name);
    }
    // The short help keeps the first-run and everyday commands visible.
    for (const name of ["scan", "export", "reflect", "gui", "status", "doctor", "help"]) {
      expect(hidden).not.toContain(name);
    }
    expect(hidden.length).toBeGreaterThan(0);
  });
});

// --- dispatch through citty: the heuristic that decides the bare home screen
// vs. a subcommand must survive flag VALUES that look like tokens. ---------

describe("root dispatch", () => {
  // A bare invocation opens the home screen. Without a terminal it prints the
  // setup summary once and the next command. We watch stdout for its heading.
  // test/setup.ts gives PATH no coding CLI, so no real command can be probed.
  let logs: string[];
  let written: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let emptyClaudeDir: string;
  const tmp: string[] = [];

  beforeEach(() => {
    logs = [];
    written = "";
    logSpy = vi.spyOn(console, "log").mockImplementation((...p: unknown[]) => {
      logs.push(p.map(String).join(" "));
    });
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written += String(chunk);
      return true;
    });
    emptyClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cch-dispatch-"));
    tmp.push(emptyClaudeDir);
  });

  afterEach(() => {
    logSpy.mockRestore();
    writeSpy.mockRestore();
    for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  const ranHome = () => written.includes("Understand how you work. Codify your taste.");

  // `--source claude` keeps these dispatch tests hermetic: without it, `auto`
  // would also read the machine's real ~/.kiro store (the "never read the real
  // store" rule extends to kiro).
  it("opens the home screen on a bare invocation", async () => {
    await runMain(main, {
      rawArgs: ["--home", emptyClaudeDir, "--claude-dir", emptyClaudeDir, "--source", "claude"],
    });
    expect(ranHome()).toBe(true);
    expect(written).toContain("next:");
  });

  it("opens the home screen when the only args are flags WITH values", async () => {
    // A naive raw-args heuristic ("first non-dash token = subcommand") would
    // mistake the VALUE `emptyClaudeDir` for a subcommand and skip the home
    // screen. Dispatch must rely on parsed positionals instead.
    await runMain(main, {
      rawArgs: [
        "--home",
        emptyClaudeDir,
        "--claude-dir",
        emptyClaudeDir,
        "--source",
        "claude",
        "--project",
        "status",
      ],
    });
    expect(ranHome()).toBe(true);
    expect(logs.join("\n")).not.toContain("discovered");
  });

  it("does NOT open the home screen when an explicit subcommand is given", async () => {
    // `status` against a home with nothing → prints funnel, never the home screen.
    await runMain(main, {
      rawArgs: [
        "status",
        "--home",
        emptyClaudeDir,
        "--claude-dir",
        emptyClaudeDir,
        "--source",
        "claude",
      ],
    });
    expect(ranHome()).toBe(false);
    expect(logs.join("\n")).toContain("discovered");
  });
});

describe("a command that fails", () => {
  function sink() {
    let text = "";
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        text += String(chunk);
        callback();
      },
    });
    return { stderr, text: () => text };
  }

  afterEach(() => {
    process.exitCode = undefined;
  });

  it.each([
    [
      "a wrong option value",
      new Error('unknown --target "bogus" (expected claude, codex, or agents)'),
      'error: unknown --target "bogus" (expected claude, codex, or agents)\n',
    ],
    [
      "a value rule",
      new Error("--cluster-batch-size must be a positive integer"),
      "error: --cluster-batch-size must be a positive integer\n",
    ],
    [
      "a damaged file the person can rebuild",
      damagedFile("/data/exports/manifest.json", "not valid JSON", "export"),
      "error: /data/exports/manifest.json is damaged (not valid JSON). Run `npx human-hindsight export` again to rebuild it.\n",
    ],
    [
      "anything else",
      new TypeError("Cannot read properties of undefined\n    at somewhere (file.js:1:1)"),
      "error: Cannot read properties of undefined\nRun with HUMAN_HINDSIGHT_DEBUG=1 for details.\n",
    ],
  ])("%s is reported without a stack trace, exit 1", (_name, error, expected) => {
    const out = sink();
    reportFailure(error, { env: {}, stderr: out.stderr });
    expect(out.text()).toBe(expected);
    expect(process.exitCode).toBe(1);
  });

  it("HUMAN_HINDSIGHT_DEBUG=1 prints the whole error", () => {
    const out = sink();
    const error = new Error("boom");
    reportFailure(error, { env: { HUMAN_HINDSIGHT_DEBUG: "1" }, stderr: out.stderr });
    expect(out.text()).toContain("Error: boom\n    at ");
  });

  // Run through the argument parser itself, which would print a thrown error
  // with its stack: every command is dispatched through the guard.
  it.each([
    [["scan", "--source", "bogus"]],
    [["reflect", "--source", "bogus", "--dry-run"]],
    [["distill", "--source", "bogus", "--dry-run"]],
    [["preferences", "--target", "bogus", "--include-unreviewed"]],
  ])("%j: a wrong value is one plain line and no stack trace", async (rawArgs) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-cli-failure-"));
    fs.mkdirSync(path.join(dir, "home"));
    vi.stubEnv("HOME", path.join(dir, "home"));
    vi.stubEnv("HUMAN_HINDSIGHT_HOME", path.join(dir, "data"));
    const printed: string[] = [];
    const record = (...args: unknown[]) => {
      printed.push(format(...args));
    };
    vi.spyOn(console, "error").mockImplementation(record);
    vi.spyOn(console, "log").mockImplementation(record);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      printed.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      printed.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await runMain(main, { rawArgs, showUsage: createShowUsage(main, rawArgs) });
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const text = printed.join("");
    expect(text).toMatch(/error: unknown --(source|target) "bogus" \(expected [a-z, ]+\)\n/);
    expect(text).not.toMatch(/\n\s+at /);
    expect(text).not.toContain("HUMAN_HINDSIGHT_DEBUG");
    expect(process.exitCode).toBe(1);
  });
});

// --- the home screen probes coding CLIs only through an injected runner ----

describe("doctor through an injected runner", () => {
  const tmp: string[] = [];
  afterEach(() => {
    for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  // The home screen's own probe cases (an injected runner, local probes only)
  // live in test/home.test.ts.
  it("doctor checks a faked CLI through the same injected runner", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cch-doctor-"));
    tmp.push(home);
    const calls: string[] = [];
    const help =
      "--output-format --json-schema --tools --safe-mode --system-prompt --strict-mcp-config " +
      "--mcp-config --settings --disable-slash-commands --no-chrome --no-session-persistence";
    const processes: RunnerIo = {
      which: (bin) => (bin === "claude" ? "/fake/bin/claude" : null),
      async spawn(bin: string, args: string[], opts: SpawnOptions) {
        calls.push([bin, ...args].join(" "));
        expect(opts.input ?? "").toBe("");
        const stdout =
          args[0] === "--version"
            ? "9.9.9 (Claude Code)\n"
            : args[0] === "auth"
              ? "Logged in\n"
              : help;
        return { code: 0, signal: null, stdout, stderr: "", timedOut: false };
      },
    };
    let text = "";
    const output = new Writable({
      write(chunk, _encoding, done) {
        text += chunk.toString();
        done();
      },
    });
    const code = await runDoctor(
      { home, "claude-dir": home, source: "claude" },
      { output, io: processes },
    );
    expect(code).toBe(0);
    expect(text).toContain("claude 9.9.9");
    expect(text).toContain("Reflection would use Claude Code");
    // Every probe went to the fake; none is a model call.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls)
      expect(call).toMatch(/^\/fake\/bin\/claude (--version|auth status|--help|--\S*help)$/);
  });
});

// --- root-level path flags must reach the subcommand ----------------------
//
// `--help` documents --home/--claude-dir/--kiro-dir as ROOT options, but citty
// does not thread a parent's parsed args into a subcommand: the subcommand
// re-declares the same names and sees only its own. So `human-hindsight --home X
// export` parsed --home, discarded it, and wrote to the DEFAULT store instead.
// Silent, and aimed squarely at the flags that redirect where data is read and
// written. Observed for real: an `export` meant for a scratch dir ran against
// the live store.

describe("root-level path flags reach the subcommand", () => {
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  const tmp: string[] = [];
  const savedEnv = { ...process.env };

  const mkdir = (tag: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `cch-rootflag-${tag}-`));
    tmp.push(d);
    return d;
  };

  beforeEach(() => {
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...p: unknown[]) => {
      logs.push(p.map(String).join(" "));
    });
    for (const k of [
      "HUMAN_HINDSIGHT_HOME",
      "CC_HINDSIGHT_HOME",
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "KIRO_CONFIG_DIR",
      "HUMAN_HINDSIGHT_CLAUDE_DIR",
      "HUMAN_HINDSIGHT_CODEX_DIR",
      "HUMAN_HINDSIGHT_KIRO_DIR",
      "HUMAN_HINDSIGHT_KIROCREW_DIR",
      "HUMAN_HINDSIGHT_CLUSTER_MODEL",
    ]) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    logSpy.mockRestore();
    for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    for (const k of [
      "HUMAN_HINDSIGHT_HOME",
      "CC_HINDSIGHT_HOME",
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "KIRO_CONFIG_DIR",
      "HUMAN_HINDSIGHT_CLAUDE_DIR",
      "HUMAN_HINDSIGHT_CODEX_DIR",
      "HUMAN_HINDSIGHT_KIRO_DIR",
      "HUMAN_HINDSIGHT_KIROCREW_DIR",
      "HUMAN_HINDSIGHT_CLUSTER_MODEL",
    ]) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("honors --home given BEFORE the subcommand", async () => {
    const home = mkdir("home");
    const claudeDir = mkdir("claude");
    // `status` reads the home's library/exports; a fresh dir reports a zeroed
    // funnel. If the root --home were dropped we would read the real store.
    await runMain(main, {
      rawArgs: ["--home", home, "--claude-dir", claudeDir, "status", "--source", "claude"],
    });
    expect(process.env.HUMAN_HINDSIGHT_HOME).toBe(home);
    expect(logs.join("\n")).toContain("exported    0 sessions");
  });

  it("honors all tool directories given BEFORE the subcommand", async () => {
    const home = mkdir("home2");
    const claudeDir = mkdir("claude2");
    const kiroDir = mkdir("kiro2");
    const codexDir = mkdir("codex2");
    const kirocrewDir = mkdir("kirocrew2");
    await runMain(main, {
      rawArgs: [
        "--home",
        home,
        "--claude-dir",
        claudeDir,
        "--kiro-dir",
        kiroDir,
        "--codex-dir",
        codexDir,
        "--kirocrew-dir",
        kirocrewDir,
        "status",
        "--source",
        "claude",
      ],
    });
    // A nested command in the same process still reads the selections.
    const nested = resolvePaths({});
    expect(nested.claudeDir).toBe(claudeDir);
    expect(nested.kiroDir).toBe(kiroDir);
    expect(nested.codexDir).toBe(codexDir);
    expect(nested.kirocrewDir).toBe(kirocrewDir);
    expect(nextArguments("scan", {})).toEqual(
      expect.arrayContaining([
        `--claude-dir=${claudeDir}`,
        `--codex-dir=${codexDir}`,
        `--kiro-dir=${kiroDir}`,
      ]),
    );
    // An empty claude dir has no sessions to discover.
    expect(logs.join("\n")).toContain("discovered  0 sessions");
  });

  // Reading history from a copied folder must not become the config folder of
  // the CLI that makes model calls: it would run with that folder and look signed out.
  it("keeps --claude-dir, --codex-dir, and --kiro-dir out of the coding CLIs' environment", async () => {
    const home = mkdir("leak-home");
    const claudeDir = mkdir("leak-claude");
    const codexDir = mkdir("leak-codex");
    const kiroDir = mkdir("leak-kiro");
    process.env.CLAUDE_CONFIG_DIR = "/person/own/claude";
    await runMain(main, {
      rawArgs: [
        "--home",
        home,
        "--claude-dir",
        claudeDir,
        "--codex-dir",
        codexDir,
        "--kiro-dir",
        kiroDir,
        "status",
        "--source",
        "claude",
      ],
    });
    expect(process.env.CLAUDE_CONFIG_DIR).toBe("/person/own/claude");
    expect(process.env.CODEX_HOME).toBeUndefined();
    expect(process.env.KIRO_CONFIG_DIR).toBeUndefined();
    expect(resolvePaths({}).claudeDir).toBe(claudeDir);
  });

  it("uses a person's own CLAUDE_CONFIG_DIR, CODEX_HOME, and KIRO_CONFIG_DIR as defaults", () => {
    process.env.CLAUDE_CONFIG_DIR = "/person/claude";
    process.env.CODEX_HOME = "/person/codex";
    process.env.KIRO_CONFIG_DIR = "/person/kiro";
    const paths = resolvePaths({});
    expect([paths.claudeDir, paths.codexDir, paths.kiroDir]).toEqual([
      "/person/claude",
      "/person/codex",
      "/person/kiro",
    ]);
    // A flag still wins.
    expect(resolvePaths({ "claude-dir": "/flag/claude" }).claudeDir).toBe("/flag/claude");
  });

  it("preserves a clustering model selected before the subcommand", async () => {
    const home = mkdir("cluster-model");
    const claudeDir = mkdir("cluster-model-claude");
    await runMain(main, {
      rawArgs: [
        "--home",
        home,
        "--claude-dir",
        claudeDir,
        "--cluster-model",
        "selected-grouping-model",
        "status",
        "--source",
        "claude",
      ],
    });
    expect(process.env.HUMAN_HINDSIGHT_CLUSTER_MODEL).toBe("selected-grouping-model");
  });

  it("lets a subcommand-level flag win over the root-level one", async () => {
    const rootHome = mkdir("root");
    const subHome = mkdir("sub");
    const claudeDir = mkdir("claude3");
    // The more specific flag is the one the user typed closest to the command.
    await runMain(main, {
      rawArgs: [
        "--home",
        rootHome,
        "--claude-dir",
        claudeDir,
        "status",
        "--source",
        "claude",
        "--home",
        subHome,
      ],
    });
    expect(process.env.HUMAN_HINDSIGHT_HOME).toBe(subHome);
  });

  it("leaves an existing env var alone when no root flag is given", async () => {
    const envHome = mkdir("env");
    const claudeDir = mkdir("claude4");
    process.env.HUMAN_HINDSIGHT_HOME = envHome;
    await runMain(main, {
      rawArgs: ["--claude-dir", claudeDir, "status", "--source", "claude"],
    });
    expect(process.env.HUMAN_HINDSIGHT_HOME).toBe(envHome);
  });

  it("reads an explicitly configured legacy home through the renamed command", async () => {
    const legacyHome = mkdir("legacy-env");
    const claudeDir = mkdir("legacy-claude");
    fs.mkdirSync(path.join(legacyHome, "exports"));
    fs.writeFileSync(path.join(legacyHome, "exports", "manifest.json"), '[{"export":"old.md"}]');
    process.env.CC_HINDSIGHT_HOME = legacyHome;
    await runMain(main, {
      rawArgs: ["--claude-dir", claudeDir, "status", "--source", "claude"],
    });
    expect(process.env.HUMAN_HINDSIGHT_HOME).toBeUndefined();
    expect(logs.join("\n")).toContain("exported    1 session\n");
  });
});

// --- EPIPE helper (extracted from cli.ts for testability) -------------------

describe("epipeHandler", () => {
  it("exits 0 on EPIPE", () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    const err = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    epipeHandler(exit)(err);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("re-throws any non-EPIPE error", () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    const err = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    expect(() => epipeHandler(exit)(err)).toThrow("disk full");
    expect(exit).not.toHaveBeenCalled();
  });
});
