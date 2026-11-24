import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dataHomeSource, type ResolvedPaths } from "../src/commands/_shared.js";
import {
  dataHomeFixFor,
  type EnvironmentSnapshot,
  environmentFixes,
  environmentSetupRows,
  startEnvironment,
} from "../src/core/environment.js";
import type { HistoryCounts } from "../src/core/environment-history.js";
import { PROBES, RUNNER_INFO } from "../src/runners/capabilities.js";
import type { RunnerName } from "../src/runners/types.js";
import type { SourceName } from "../src/sources/types.js";
import { type FakeRunnerIo, fakeRunnerIo } from "./support/runner-io.js";

/**
 * The environment model behind the home screen and `doctor`. History counting
 * is injected (the background reader is proven through the built bundle), and
 * every command probe goes through a scripted fake process runner.
 */

const missing = path.join(os.tmpdir(), `hindsight-environment-${process.pid}-absent`);
const claudeStore = path.join(import.meta.dirname, "fixtures", "claude-home");
/** No credential variables, and a Codex home that does not exist. */
const ISOLATED_ENV: NodeJS.ProcessEnv = { CODEX_HOME: path.join(missing, "codex") };
const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function paths(over: Partial<ResolvedPaths> = {}): ResolvedPaths {
  return {
    home: path.join(os.tmpdir(), "hindsight-environment-home"),
    claudeDir: path.join(missing, "claude"),
    codexDir: path.join(missing, "codex"),
    kiroDir: path.join(missing, "kiro"),
    kirocrewDir: path.join(missing, "kirocrew"),
    opencodeDir: path.join(missing, "opencode"),
    opencodeDb: path.join(missing, "opencode", "opencode.db"),
    opencodeConfigDir: path.join(missing, "opencode-config"),
    ...over,
  };
}

/** Publish fixed counts the way the background reader does. */
function counts(by: Partial<Record<SourceName, HistoryCounts>>) {
  return async (
    request: { names: SourceName[] },
    publish: (message: { name: SourceName; history: HistoryCounts }) => void,
  ) => {
    for (const name of request.names) {
      publish({
        name,
        history: by[name] ?? { projects: 0, sessions: 0, newSessions: 0, exact: true },
      });
    }
  };
}

const FIVE: HistoryCounts = { projects: 4, sessions: 5, newSessions: 0, exact: true };

function claudeIo(status: { loggedIn: boolean }): FakeRunnerIo {
  return fakeRunnerIo()
    .script("claude", { args: ["--version"] }, { stdout: "9.9.9 (Claude Code)\n" })
    .script(
      "claude",
      { args: ["auth", "status"] },
      { code: status.loggedIn ? 0 : 1, stdout: JSON.stringify(status) },
    )
    .failOnUnscripted();
}

async function settledSnapshot(
  resolved: ResolvedPaths,
  io: FakeRunnerIo,
  history: ReturnType<typeof counts> = counts({}),
): Promise<EnvironmentSnapshot> {
  const discovery = await startEnvironment(resolved, {
    io,
    countHistory: history,
    env: ISOLATED_ENV,
  });
  try {
    await discovery.settled;
    return discovery.snapshot();
  } finally {
    discovery.close();
  }
}

/** The probes that answer with networking unavailable: never one that needs a provider. */
function firstScreenProbeArgs(name: RunnerName): string[] {
  return Object.values(PROBES[name])
    .filter((spec) => spec !== undefined && spec.scope !== "network")
    .map((spec) => spec?.args.join(" ") ?? "");
}

describe("environment fixes: exactly one line per situation", () => {
  it("history without a command: install and sign in", async () => {
    const snapshot = await settledSnapshot(
      paths({ claudeDir: claudeStore }),
      fakeRunnerIo().failOnUnscripted(),
      counts({ claude: FIVE }),
    );
    const fixes = environmentFixes(snapshot);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toContain("Claude Code has a local history store");
    expect(fixes[0]).toContain(`${RUNNER_INFO.claude.installCommand} && claude auth login`);
  });

  it("a command without history: start a session", async () => {
    const snapshot = await settledSnapshot(paths(), claudeIo({ loggedIn: true }));
    expect(environmentFixes(snapshot)).toEqual([
      "Claude Code has no history in this selection. Run claude",
    ]);
  });

  it("a command needing sign-in: the sign-in command", async () => {
    const snapshot = await settledSnapshot(
      paths({ claudeDir: claudeStore }),
      claudeIo({ loggedIn: false }),
      counts({ claude: FIVE }),
    );
    expect(environmentFixes(snapshot)).toEqual([
      "Claude Code suggests signing in. Run claude auth login",
    ]);
    const row = environmentSetupRows(snapshot).find((r) => r.tool === "Claude Code");
    expect(row?.signIn).toBe("! run claude auth login");
  });

  it("nothing found: one line naming every install command", async () => {
    const snapshot = await settledSnapshot(paths(), fakeRunnerIo().failOnUnscripted());
    const fixes = environmentFixes(snapshot);
    expect(fixes).toHaveLength(1);
    for (const name of ["claude", "codex", "kiro", "opencode"] as const)
      expect(fixes[0]).toContain(RUNNER_INFO[name].installCommand);
  });

  it.each([
    // --home wins over the variable, so exporting it would change nothing.
    ["flag", undefined, 'human-hindsight --home "$HOME/.human-hindsight"'],
    ["flag", "doctor", 'human-hindsight doctor --home "$HOME/.human-hindsight"'],
    ["environment", undefined, 'export HUMAN_HINDSIGHT_HOME="$HOME/.human-hindsight"'],
    ["default", undefined, 'export HUMAN_HINDSIGHT_HOME="$HOME/.human-hindsight"'],
  ] as const)("a data home chosen by %s (%s) is fixed with the setting that wins", (by, command, fix) => {
    expect(dataHomeFixFor("$HOME/.human-hindsight", by, command)).toBe(fix);
  });

  it.each([
    ["/locked", {}, "flag"],
    [undefined, { HUMAN_HINDSIGHT_HOME: "/locked" }, "environment"],
    [undefined, { CC_HINDSIGHT_HOME: "/locked" }, "environment"],
    [undefined, {}, "default"],
  ] as const)("--home %s with %j was chosen by %s", (flag, env, source) => {
    expect(dataHomeSource(flag, env)).toBe(source);
  });

  it("a locked --home: the fix changes the flag", async () => {
    const locked = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-locked-"));
    cleanup.push(locked);
    fs.chmodSync(locked, 0o500);
    const snapshot = await settledSnapshot(
      paths({ home: path.join(locked, "data"), homeSource: "flag", claudeDir: claudeStore }),
      claudeIo({ loggedIn: true }),
      counts({ claude: FIVE }),
    );
    expect(snapshot.dataHomeFix).toMatch(/^human-hindsight --home "/);
    expect(environmentFixes(snapshot)[0]).not.toContain("export HUMAN_HINDSIGHT_HOME");
  });

  it("data home not writable: one exported variable", async () => {
    const locked = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-locked-"));
    cleanup.push(locked);
    fs.chmodSync(locked, 0o500);
    const snapshot = await settledSnapshot(
      paths({ home: path.join(locked, "data"), claudeDir: claudeStore }),
      claudeIo({ loggedIn: true }),
      counts({ claude: FIVE }),
    );
    expect(snapshot.dataHomeWritable).toBe(false);
    const fixes = environmentFixes(snapshot);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatch(
      /^Choose a (temporary )?writable data home\. Run export HUMAN_HINDSIGHT_HOME=/,
    );
  });
});

describe("environment probes", () => {
  it("run only version and sign-in status commands, never one that needs a provider, all through the injected runner", async () => {
    const io = fakeRunnerIo()
      .script("claude", { args: ["--version"] }, { stdout: "2.0.0 (Claude Code)\n" })
      .script("claude", { args: ["auth", "status"] }, { stdout: '{"loggedIn": true}' })
      .script("codex", { args: ["--version"] }, { stdout: "codex-cli 0.1.0\n" })
      .script("codex", { args: ["login", "status"] }, { code: 1, stderr: "Not logged in\n" })
      .script("kiro-cli", { args: ["--version"] }, { stdout: "kiro-cli 3.5.0\n" })
      .script("kiro-cli", { args: ["whoami"] }, { stdout: "Logged in\n" })
      .script("opencode", { args: ["--version"] }, { stdout: "1.18.15\n" })
      .script("opencode", { args: ["auth", "list"] }, { stdout: "1 credential\n" })
      .failOnUnscripted();
    const snapshot = await settledSnapshot(paths(), io);
    expect([...new Set(io.lookups)].sort()).toEqual(["claude", "codex", "kiro-cli", "opencode"]);
    for (const call of io.calls) {
      const name = (Object.keys(RUNNER_INFO) as RunnerName[]).find(
        (key) => RUNNER_INFO[key].binary === path.basename(call.bin),
      ) as RunnerName;
      expect(firstScreenProbeArgs(name)).toContain(call.args.join(" "));
      expect(call.stdin).toBe("");
    }
    // Kiro CLI's sign-in status answers offline but may contact Kiro's own
    // service when it can; the model list needs a provider.
    expect(PROBES.kiro["sign-in"]?.scope).toBe("own-service");
    expect(PROBES.kiro.models?.scope).toBe("network");
    // No model list is fetched here: that belongs to preparing a run.
    expect(io.calls.some((call) => call.args.includes("models"))).toBe(false);
    expect(io.calls.some((call) => call.args.includes("--list-models"))).toBe(false);
    const states = Object.fromEntries(snapshot.rows.map((row) => [row.name, row.signIn?.state]));
    expect(states).toMatchObject({
      claude: "ready",
      codex: "needs-sign-in",
      kiro: "ready",
      kirocrew: "ready",
      opencode: "ready",
    });
    expect(snapshot.pending).toEqual([]);
  });

  it("an unreadable version stays unknown and the row still settles", async () => {
    const io = fakeRunnerIo()
      .script("codex", { args: ["--version"] }, { timedOut: true })
      .script("codex", { args: ["login", "status"] }, { timedOut: true })
      .failOnUnscripted();
    const snapshot = await settledSnapshot(paths(), io);
    const row = snapshot.rows.find((r) => r.name === "codex");
    expect(row).toMatchObject({ installed: true, versionPending: false, signInPending: false });
    expect(row?.version).toBeUndefined();
    expect(row?.signIn).toEqual({ state: "unknown" });
  });
});
