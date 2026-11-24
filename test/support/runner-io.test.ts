import { describe, expect, it } from "vitest";
import type { defaultIo } from "../../src/runners/shared.js";
import { claudeEnvelope, fakeRunnerIo, matchesPattern, spawnResult } from "./runner-io.js";

const opts = (input = "") => ({ input, timeoutMs: 1_000 });

describe("fakeRunnerIo", () => {
  it("returns the first matching script and logs every call with its stdin", async () => {
    const io = fakeRunnerIo()
      .script("claude", { has: ["--help"] }, { stdout: "--output-format --json-schema" })
      .script(
        "claude",
        { has: ["-p"], stdin: /file: a\.md/ },
        { stdout: claudeEnvelope({ ok: 1 }) },
      )
      .script("claude", { has: ["-p"] }, { code: 1, stderr: "Synthetic failure" });
    const help = await io.spawn("claude", ["--help"], opts());
    const first = await io.spawn("/fake/bin/claude", ["-p", "--model", "m"], opts("(file: a.md)"));
    const second = await io.spawn("claude", ["-p"], opts("(file: b.md)"));
    expect(help.stdout).toContain("--json-schema");
    expect(JSON.parse(first.stdout).structured_output).toEqual({ ok: 1 });
    expect(second).toEqual(spawnResult({ code: 1, stderr: "Synthetic failure" }));
    expect(io.calls.map((call) => [call.args, call.stdin])).toEqual([
      [["--help"], ""],
      [["-p", "--model", "m"], "(file: a.md)"],
      [["-p"], "(file: b.md)"],
    ]);
    expect(io.callsOf("claude", { has: ["-p"] })).toHaveLength(2);
  });

  it("uses a limited script up, then falls through", async () => {
    const io = fakeRunnerIo()
      .script("codex", {}, { code: 1 }, 1)
      .script("codex", {}, { stdout: "second" });
    expect((await io.spawn("codex", [], opts())).code).toBe(1);
    expect((await io.spawn("codex", [], opts())).stdout).toBe("second");
  });

  it("computes a result from the call", async () => {
    const io = fakeRunnerIo().script("kiro-cli", {}, (call) => ({
      stdout: call.stdin.toUpperCase(),
    }));
    expect((await io.spawn("kiro-cli", ["chat"], opts("hi"))).stdout).toBe("HI");
  });

  it("resolves scripted binaries and reports others missing", async () => {
    const io = fakeRunnerIo()
      .script("claude", {}, {})
      .binary("codex", "/opt/codex")
      .binary("claude-old", null);
    expect(await io.which("claude")).toBe("/fake/bin/claude");
    expect(await io.which("codex")).toBe("/opt/codex");
    expect(await io.which("claude-old")).toBeNull();
    expect(await io.which("opencode")).toBeNull();
    expect(io.lookups).toEqual(["claude", "codex", "claude-old", "opencode"]);
  });

  it("rejects and records an unscripted spawn, and assertNoUnscripted reports it", async () => {
    const io = fakeRunnerIo().script("claude", { args: ["--version"] }, { stdout: "1.0.0" });
    await expect(io.spawn("claude", ["-p"], opts())).rejects.toThrow(/Unscripted spawn: claude -p/);
    expect(io.unscripted.map((call) => call.args)).toEqual([["-p"]]);
    expect(() => io.assertNoUnscripted()).toThrow(/Unscripted command\(s\) spawned: claude -p/);
  });

  it("failOnUnscripted passes a test that spawned only scripted commands", async () => {
    const io = fakeRunnerIo().script("claude", {}, {}).failOnUnscripted();
    await io.spawn("claude", ["--help"], opts());
  });

  it("is a RunnerIo", () => {
    const io: typeof defaultIo = fakeRunnerIo();
    expect(typeof io.spawn).toBe("function");
  });
});

describe("matchesPattern", () => {
  it.each([
    [{ args: ["-p", /^--m/] }, ["-p", "--model"], "", true],
    [{ args: ["-p"] }, ["-p", "--model"], "", false],
    [{ has: ["--model", /^opus/] }, ["-p", "--model", "opus-x"], "", true],
    [{ has: ["--json-schema"] }, ["-p"], "", false],
    [{ lacks: ["--resume"] }, ["-p"], "", true],
    [{ lacks: [/^--res/] }, ["--resume"], "", false],
    [{ stdin: "exact" }, [], "exact", true],
    [{ stdin: /needle/ }, [], "hay", false],
    [{}, ["anything"], "x", true],
  ])("%j against %j", (pattern, args, stdin, expected) => {
    expect(matchesPattern(pattern, args, stdin)).toBe(expected);
  });
});
