import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  codexDefaults,
  installAndSignIn,
  missingBinaryHint,
  PROBE_TIMEOUT_MS,
  PROBES,
  parseCodexConfig,
  RUNNER_INFO,
  readCatalog,
  readSignInHint,
  readVersion,
  versionNumber,
} from "../src/runners/capabilities.js";
import { resetCapabilityCache } from "../src/runners/claude.js";
import { type KiroEnv, makeKiroRunner } from "../src/runners/kiro.js";
import { makeRunner } from "../src/runners/registry.js";
import { AgentRunnerError } from "../src/runners/shared.js";
import type { RunnerName } from "../src/runners/types.js";
import { type FakeRunnerIo, fakeRunnerIo } from "./support/runner-io.js";

const RUNNERS: RunnerName[] = ["claude", "codex", "kiro", "opencode"];
const fixture = (name: string) =>
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8");

const CLAUDE_HELP =
  "--output-format --json-schema --tools --safe-mode --system-prompt --strict-mcp-config " +
  "--mcp-config --settings --disable-slash-commands --no-chrome --no-session-persistence";

describe("versionNumber", () => {
  it.each([
    ["2.1.330 (Claude Code)\n", "2.1.330"],
    ["codex-cli 0.171.0\n", "0.171.0"],
    ["\u001b[1mkiro-cli\u001b[0m \u001b[32m3.5.0\u001b[0m\n", "3.5.0"],
    ["opencode v2.1.3\n", "2.1.3"],
    ["1.18.15", "1.18.15"],
    ["3.6.0-beta.2\n", "3.6.0-beta.2"],
    // A launcher may print notices before the CLI's own line.
    ["Waiting for an agent to start...\nWarning: not ready within 10s.\nkiro-cli 3.5.0\n", "3.5.0"],
    ["A newer release, 9.9.9, is available\nkiro-cli 3.5.0\n", "3.5.0"],
    ["no version here\n", undefined],
  ])("%j gives %s", (text, expected) => {
    const binary = text.includes("kiro") ? "kiro-cli" : undefined;
    expect(versionNumber(text, binary)).toBe(expected);
  });
});

describe("probe timeouts and scopes", () => {
  it("gives help probes 15 s, sign-in 10 s, and --version 5 s", () => {
    expect(PROBE_TIMEOUT_MS.version).toBe(5_000);
    expect(PROBE_TIMEOUT_MS.help).toBe(15_000);
    expect(PROBE_TIMEOUT_MS["sign-in"]).toBe(10_000);
    for (const name of RUNNERS) {
      expect(PROBES[name].version?.timeoutMs).toBe(5_000);
      expect(PROBES[name].help?.timeoutMs).toBe(15_000);
    }
  });

  it("marks only the Kiro model list as a network probe", () => {
    const network = RUNNERS.flatMap((name) =>
      Object.entries(PROBES[name])
        .filter(([, spec]) => spec?.scope === "network")
        .map(([kind]) => `${name} ${kind}`),
    );
    expect(network).toEqual(["kiro models"]);
  });

  it("a version probe that exceeds its timeout is reported as unknown", async () => {
    const io = fakeRunnerIo()
      .script("codex", { args: ["--version"] }, { timedOut: true, signal: "SIGKILL" })
      .failOnUnscripted();
    expect(await readVersion(io, "codex")).toBeUndefined();
    const [call] = io.calls;
    expect(call?.options).toMatchObject({ input: "", timeoutMs: 5_000 });
  });

  it("a probe that cannot start is unknown, never a throw", async () => {
    const io = fakeRunnerIo().binary("opencode", "/fake/bin/opencode");
    expect(await readVersion(io, "opencode")).toBeUndefined();
    expect(await readSignInHint(io, "opencode")).toEqual({ state: "unknown" });
  });
});

describe("model catalogs", () => {
  const catalog = (stdout: string, configured?: string, name: RunnerName = "kiro") =>
    readCatalog(
      fakeRunnerIo().script(RUNNER_INFO[name].binary, {}, { stdout }),
      name,
      {},
      configured,
    );

  it("skips a leading notice line", async () => {
    const out =
      'Notice: a launcher message\n{"models":[{"model_id":"a-1"},{"model_id":"b-2"}],"default_model":"auto"}';
    expect(await catalog(out)).toEqual({
      ids: ["a-1", "b-2"],
      defaultModel: "auto",
      source: "catalog",
    });
  });

  it("reads an object-keyed catalog", async () => {
    const out = '{"models":{"x-1":{"name":"X"},"y-2":{"isDefault":true}}}';
    expect(await catalog(out)).toEqual({
      ids: ["x-1", "y-2"],
      defaultModel: "y-2",
      source: "catalog",
    });
  });

  it("reports an empty list as no catalog", async () => {
    expect(await catalog('{"models":[]}')).toEqual({ ids: [], source: "none" });
    expect(await catalog("[]")).toEqual({ ids: [], source: "none" });
    expect(await catalog("")).toEqual({ ids: [], source: "none" });
  });

  it("prefers the CLI's configured default over the catalog's own default", async () => {
    const out =
      '{"models":[{"slug":"global.example.m-2","isDefault":true},{"slug":"us.example.m-2"}]}';
    expect(await catalog(out, "us.example.m-2", "codex")).toEqual({
      ids: ["global.example.m-2", "us.example.m-2"],
      defaultModel: "us.example.m-2",
      source: "catalog",
    });
  });

  it("reads OpenCode's provider/model lines and ignores other text", async () => {
    const out = "Notice\nexample/model-a\nexample/region.model-b:1\n\nnot a model\n";
    expect(await catalog(out, undefined, "opencode")).toEqual({
      ids: ["example/model-a", "example/region.model-b:1"],
      source: "catalog",
    });
  });
});

describe("Codex configuration", () => {
  it("reads the top-level model and provider, and a selected profile over them", () => {
    const text = [
      "# comment",
      'model_provider = "example"',
      "model = 'us.example.model-6'",
      "",
      "[model_providers.example]",
      'model = "not-a-default"',
      "[profiles.fast]",
      'model = "global.example.model-5"',
    ].join("\n");
    expect(parseCodexConfig(text)).toEqual({ model: "us.example.model-6", provider: "example" });
    expect(parseCodexConfig(`profile = "fast"\n${text}`)).toEqual({
      model: "global.example.model-5",
      provider: "example",
    });
    expect(parseCodexConfig("not = [toml")).toEqual({});
  });

  it("finds the file under CODEX_HOME and never throws", () => {
    const read = (file: string) => {
      if (file !== path.join("/codex-home", "config.toml")) throw new Error("ENOENT");
      return 'model = "us.example.model-6"\n';
    };
    expect(codexDefaults({ CODEX_HOME: "/codex-home" }, read).model).toBe("us.example.model-6");
    expect(codexDefaults({ CODEX_HOME: "/elsewhere" }, read)).toEqual({});
  });

  it("the Codex runner lists models with the configured default", async () => {
    const io = fakeRunnerIo()
      .script(
        "codex",
        { args: ["debug", "models"] },
        {
          stdout: '{"models":[{"slug":"global.example.model-6"},{"slug":"us.example.model-6"}]}',
        },
      )
      .failOnUnscripted();
    const runner = makeRunner("codex", {
      io,
      env: { CODEX_HOME: "/codex-home" },
      readFile: () => 'model = "us.example.model-6"\n',
    });
    expect((await runner.listModels?.())?.defaultModel).toBe("us.example.model-6");
  });
});

describe("sign-in hints", () => {
  const hint = (
    name: RunnerName,
    result: { code?: number; stdout?: string; stderr?: string },
    configured = false,
  ) =>
    readSignInHint(
      fakeRunnerIo().script(RUNNER_INFO[name].binary, {}, result),
      name,
      {},
      configured,
    );

  it.each([
    [
      "claude",
      { code: 0, stdout: '{"loggedIn": true, "authMethod": "third_party"}' },
      false,
      "ready",
    ],
    [
      "claude",
      { code: 1, stdout: '{"loggedIn": false, "authMethod": "none"}' },
      false,
      "needs-sign-in",
    ],
    ["claude", { code: 1, stdout: '{"loggedIn": false}' }, true, "unknown"],
    ["codex", { code: 1, stderr: "Not logged in\n" }, false, "needs-sign-in"],
    // Codex exits 1 here even when a custom provider makes it work.
    ["codex", { code: 1, stderr: "Not logged in\n" }, true, "unknown"],
    ["codex", { code: 0, stdout: "Logged in using an API key\n" }, false, "ready"],
    ["kiro", { code: 0, stdout: "Logged in with a builder account\n" }, false, "ready"],
    ["kiro", { code: 1, stdout: "Not logged in\n" }, false, "needs-sign-in"],
    ["kiro", { code: 1, stdout: "Not logged in\n" }, true, "unknown"],
    ["kiro", { code: 2, stdout: "" }, false, "unknown"],
    [
      "opencode",
      { code: 0, stdout: "Credentials\n0 credentials\nEnvironment\n1 environment variable\n" },
      false,
      "ready",
    ],
    ["opencode", { code: 0, stdout: "Credentials\n└  0 credentials\n" }, false, "needs-sign-in"],
    ["opencode", { code: 0, stdout: "Credentials\n└  0 credentials\n" }, true, "unknown"],
  ] as const)("%s %j configured=%s gives %s", async (name, result, configured, state) => {
    const out = await hint(name, result, configured);
    expect(out.state).toBe(state);
    if (state === "needs-sign-in") expect(out.fix).toBe(RUNNER_INFO[name].loginCommand);
  });

  it("Codex with a custom provider in its config is unknown, never needs-sign-in", async () => {
    const io = fakeRunnerIo()
      .script("codex", { args: ["login", "status"] }, { code: 1, stderr: "Not logged in\n" })
      .failOnUnscripted();
    const runner = makeRunner("codex", {
      io,
      env: { CODEX_HOME: "/codex-home" },
      readFile: () => 'model_provider = "example"\n',
    });
    expect(await runner.signInHint?.()).toEqual({ state: "unknown" });
    const plain = makeRunner("codex", {
      io,
      env: { CODEX_HOME: "/codex-home" },
      readFile: () => "",
    });
    expect((await plain.signInHint?.())?.state).toBe("needs-sign-in");
  });
});

describe("install and sign-in hints", () => {
  const PUBLIC_HOSTS = ["cli.kiro.dev"];
  const PUBLIC_PROGRAMS = ["npm", "curl", "bash", "claude", "codex", "kiro-cli", "opencode"];

  it.each(RUNNERS)("%s names its install command and its sign-in step", (name) => {
    const { binary, installCommand, loginCommand } = RUNNER_INFO[name];
    const hint = missingBinaryHint(name);
    expect(hint).toContain(`\`${binary}\``);
    expect(hint).toContain(installCommand);
    expect(hint).toContain(loginCommand);
    expect(installAndSignIn(name)).toBe(`${installCommand} && ${loginCommand}`);
    expect(hint).not.toMatch(/\u2014|\u2013/);
    // Every address is a public host, and every command (each step of a
    // pipeline or a chain) starts with a public program.
    for (const url of hint.match(/https?:\/\/[^\s`]+/g) ?? []) {
      expect(PUBLIC_HOSTS).toContain(new URL(url).hostname);
    }
    const commands = [...hint.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
    for (const command of [...commands, installCommand, loginCommand]) {
      for (const step of command.split(/\s*(?:\||&&)\s*/)) {
        expect(PUBLIC_PROGRAMS).toContain(step.split(" ")[0]);
      }
    }
  });

  it("names only the commands verified on real installs", () => {
    // Each was checked against the real CLI or package registry (see the report).
    expect(
      Object.values(RUNNER_INFO).map((info) => [info.installCommand, info.loginCommand]),
    ).toEqual([
      ["npm install -g @anthropic-ai/claude-code", "claude auth login"],
      ["npm install -g @openai/codex", "codex login"],
      ["curl -fsSL https://cli.kiro.dev/install | bash", "kiro-cli login"],
      ["npm install -g @opencode/cli", "opencode auth login"],
    ]);
  });
});

function kiroEnv(io: FakeRunnerIo): KiroEnv {
  return {
    io,
    sleep: async () => {},
    makeScratch: () => "/tmp/human-hindsight-kiro-test",
    removeScratch: () => {},
    writeAgent: () => {},
    listSessions: async () => [],
    deleteSession: async () => {},
    async version() {
      return (await readVersion(io, "kiro")) ?? "";
    },
  };
}

describe("every runner", () => {
  it.each(RUNNERS)("%s rejects a plan label as a model and spawns nothing", async (name) => {
    const io = fakeRunnerIo().failOnUnscripted();
    for (const binary of ["claude", "codex", "kiro-cli", "opencode"])
      io.binary(binary, `/fake/bin/${binary}`);
    const runner = name === "kiro" ? makeKiroRunner(kiroEnv(io)) : makeRunner(name, { io });
    for (const model of ["balanced/bulk", "best/major", " Balanced/Major "]) {
      const error = await runner
        .run({ prompt: "p", schema: z.object({}), model })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AgentRunnerError);
      expect((error as AgentRunnerError).kind).toBe("validation");
    }
    expect(io.calls).toEqual([]);
  });
});

describe("preflight runs only local commands", () => {
  const preflightCalls = async (name: RunnerName, io: FakeRunnerIo) => {
    resetCapabilityCache();
    const runner = name === "kiro" ? makeKiroRunner(kiroEnv(io)) : makeRunner(name, { io });
    await runner.preflight?.();
    return io.calls.map((call) => {
      expect(call.stdin).toBe("");
      return call.args;
    });
  };

  it("Claude reads its help once", async () => {
    const io = fakeRunnerIo()
      .script("claude", { args: ["--help"] }, { stdout: CLAUDE_HELP })
      .failOnUnscripted();
    expect(await preflightCalls("claude", io)).toEqual([["--help"]]);
    expect(io.calls[0]?.options.timeoutMs).toBe(15_000);
  });

  it("Codex reads exec help and accepts the captured 0.171.0 help", async () => {
    const io = fakeRunnerIo()
      .script(
        "codex",
        { args: ["exec", "--help"] },
        {
          stdout: fixture("runner-errors/codex-exec-help-0.171.0.txt"),
        },
      )
      .failOnUnscripted();
    expect(await preflightCalls("codex", io)).toEqual([["exec", "--help"]]);
    expect(io.calls[0]?.options.timeoutMs).toBe(15_000);
  });

  it("Kiro 3.5.0 reads its version and chat help and accepts the captured help", async () => {
    const io = fakeRunnerIo()
      .script("kiro-cli", { args: ["--version"] }, { stdout: "kiro-cli 3.5.0\n" })
      .script(
        "kiro-cli",
        { args: ["chat", "--help"] },
        {
          stdout: fixture("kiro-runner/chat-help-3.5.0.txt"),
        },
      )
      .failOnUnscripted();
    expect(await preflightCalls("kiro", io)).toEqual([["--version"], ["chat", "--help"]]);
    expect(io.calls.map((call) => call.options.timeoutMs)).toEqual([15_000, 15_000]);
  });

  it("Kiro 3.x without a flag its model call needs is blocked before consent", async () => {
    const help = fixture("kiro-runner/chat-help-3.5.0.txt").replaceAll("--agent-engine", "--x");
    const io = fakeRunnerIo()
      .script("kiro-cli", { args: ["--version"] }, { stdout: "kiro-cli 3.9.0\n" })
      .script("kiro-cli", { args: ["chat", "--help"] }, { stdout: help });
    await expect(preflightCalls("kiro", io)).rejects.toThrow(/--agent-engine/);
  });

  it.each([
    ["an unknown version", { timedOut: true }],
    ["a generation with no captured help", { stdout: "kiro-cli 2.12.1\n" }],
  ])("Kiro with %s does not block", async (_label, version) => {
    const io = fakeRunnerIo()
      .script("kiro-cli", { args: ["--version"] }, version)
      .failOnUnscripted();
    expect(await preflightCalls("kiro", io)).toEqual([["--version"]]);
  });

  it("OpenCode reads its version and run help", async () => {
    const io = fakeRunnerIo()
      .script("opencode", { args: ["--version"] }, { stdout: "1.18.15\n" })
      .script(
        "opencode",
        { args: ["run", "--help"] },
        { stderr: "--format --agent --title --pure" },
      )
      .failOnUnscripted();
    expect(await preflightCalls("opencode", io)).toEqual([["--version"], ["run", "--help"]]);
    expect(io.calls.map((call) => call.options.timeoutMs)).toEqual([15_000, 15_000]);
  });

  it.each(RUNNERS)("%s preflight spawns only local probes", async (name) => {
    const local = new Set(
      Object.values(PROBES[name])
        .filter((spec) => spec?.scope === "local")
        .map((spec) => spec?.args.join(" ")),
    );
    if (name === "claude") local.add("--claude-help");
    const io = fakeRunnerIo();
    for (const binary of ["claude", "codex", "kiro-cli", "opencode"])
      io.script(binary, {}, { code: 1, stderr: "unavailable" });
    const runner = name === "kiro" ? makeKiroRunner(kiroEnv(io)) : makeRunner(name, { io });
    resetCapabilityCache();
    await runner.preflight?.().catch(() => {});
    expect(io.calls.length).toBeGreaterThan(0);
    for (const call of io.calls) expect(local).toContain(call.args.join(" "));
  });
});
