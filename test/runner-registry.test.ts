import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { makeRunner, parseRunnerMode, resolveRunner } from "../src/runners/registry.js";
import type { RunnerIo } from "../src/runners/shared.js";
import type { RunnerName } from "../src/runners/types.js";
import type { SourceName } from "../src/sources/types.js";
import { fakeRunnerIo } from "./support/runner-io.js";

/** An IO whose PATH contains exactly the given binaries; spawn is never used. */
function ioWith(...bins: string[]): RunnerIo {
  return {
    which: (bin) => (bins.includes(bin) ? `/usr/bin/${bin}` : null),
    spawn: async () => {
      throw new Error("registry tests never spawn");
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("parseRunnerMode", () => {
  it("defaults to auto, accepts every runner in any case, and rejects others", () => {
    expect(parseRunnerMode(undefined)).toBe("auto");
    expect(parseRunnerMode("KIRO")).toBe("kiro");
    expect(parseRunnerMode("CODEX")).toBe("codex");
    expect(parseRunnerMode("OpenCode")).toBe("opencode");
    expect(() => parseRunnerMode("gpt")).toThrow(/unknown --runner/);
  });
});

describe("resolveRunner: explicit modes fail fast on a missing binary", () => {
  it.each([
    ["kiro", "kiro-cli", ["claude"]],
    ["claude", "claude", ["kiro-cli"]],
    ["codex", "codex", ["claude"]],
    ["opencode", "opencode", ["claude"]],
  ] as const)("%s without %s throws missing-binary before consent", async (mode, bin, others) => {
    await expect(resolveRunner(mode, { io: ioWith(...others) })).rejects.toMatchObject({
      kind: "missing-binary",
      message: expect.stringContaining(`\`${bin}\``),
    });
    expect((await resolveRunner(mode, { io: ioWith(bin) })).name).toBe(mode);
  });
});

describe("resolveRunner: auto", () => {
  it.each([
    [["claude", "kiro-cli"], "kiro", "kiro"],
    // Kiro Crew runs kiro-cli underneath.
    [["claude", "kiro-cli"], "kirocrew", "kiro"],
    [["kiro-cli"], undefined, "kiro"],
    [["codex"], undefined, "codex"],
    [["claude", "codex", "kiro-cli"], "codex", "codex"],
    [["claude", "kiro-cli"], undefined, "claude"],
    // Nothing installed: claude, so its install hint surfaces on first use.
    [[], undefined, "claude"],
  ] as [
    string[],
    SourceName | undefined,
    RunnerName,
  ][])("on %j preferring %s picks %s", async (bins, preferSource, expected) => {
    expect((await resolveRunner("auto", { io: ioWith(...bins), preferSource })).name).toBe(
      expected,
    );
  });
});

describe("Kiro empty-output retries follow who wraps the adapter", () => {
  async function chatCalls(build: (io: RunnerIo) => Promise<ReturnType<typeof makeRunner>>) {
    vi.useFakeTimers();
    const io = fakeRunnerIo()
      .script("kiro-cli", { args: ["--version"] }, { stdout: "kiro-cli 2.12.1\n" })
      .script("kiro-cli", { has: ["--no-interactive"] }, { stdout: "" })
      .script("kiro-cli", { has: ["--list-sessions"] }, { stdout: "[]" })
      .failOnUnscripted();
    const runner = await build(io);
    const result = runner.run({ prompt: "p", schema: z.object({}) }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ kind: "transient" });
    await runner.finalize?.();
    return io.callsOf("kiro-cli", { has: ["--no-interactive"] }).length;
  }

  it("the pool's adapter reports the first empty output; the pool retries it", async () => {
    expect(await chatCalls(async (io) => makeRunner("kiro", { io }))).toBe(1);
  });

  it("an adapter used outside the pool keeps its own backoff", async () => {
    expect(await chatCalls((io) => resolveRunner("kiro", { io }))).toBe(3);
  });
});
