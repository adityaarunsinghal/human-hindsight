import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { makeClaudeRunner } from "../src/runners/claude.js";
import { makeCodexRunner } from "../src/runners/codex.js";
import { classifyFailure, type FailureClass } from "../src/runners/failures.js";
import { type KiroEnv, makeKiroRunner, runKiro } from "../src/runners/kiro.js";
import { makeOpenCodeRunner } from "../src/runners/opencode.js";
import { AgentRunnerError } from "../src/runners/shared.js";
import type { AgentRunner, Capabilities, RunnerName } from "../src/runners/types.js";
import { type FakeRunnerIo, fakeRunnerIo } from "./support/runner-io.js";

/**
 * The failure class decides whether the pool retries, steps down a model, or
 * switches CLI. It is read from the runner's typed error kind and from stderr,
 * never from the model's answer. Every text rule is backed by a real capture in
 * test/fixtures/runner-errors/cases.json.
 */

interface CapturedCase {
  id: string;
  runner: RunnerName;
  version: string;
  expected: FailureClass;
  exitCode: number;
  stdout: string;
  stderr: string;
}

const cases: CapturedCase[] = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures/runner-errors/cases.json"), "utf8"),
);

const schema = z.object({ ok: z.boolean() });
const FULL_CLAUDE: Capabilities = {
  jsonSchema: true,
  disableTools: "tools-empty",
  noSessionPersistence: true,
  isolation: "safe-mode",
};

function kiroEnv(io: FakeRunnerIo, version: string): KiroEnv {
  return {
    io,
    sleep: async () => {},
    makeScratch: () => "/tmp/human-hindsight-kiro-fixture",
    removeScratch: () => {},
    writeAgent: () => {},
    listSessions: async () => [],
    deleteSession: async () => {},
    version: async () => `kiro-cli ${version}`,
  };
}

/** The runner under test, with the captured output returned for its model call. */
function runnerFor(item: CapturedCase): { runner: AgentRunner; io: FakeRunnerIo } {
  const failed = { code: item.exitCode, stdout: item.stdout, stderr: item.stderr };
  const io = fakeRunnerIo().failOnUnscripted();
  switch (item.runner) {
    case "claude":
      io.script("claude", { has: ["-p"] }, failed);
      return { runner: makeClaudeRunner(io), io };
    case "codex":
      io.script("codex", { has: ["mcp", "list", "--json"] }, { stdout: "[]" }).script(
        "codex",
        { has: ["exec", "--json"] },
        failed,
      );
      return { runner: makeCodexRunner(io), io };
    case "kiro":
      io.script("kiro-cli", { has: ["--no-interactive"] }, failed);
      return { runner: makeKiroRunner(kiroEnv(io, item.version)), io };
    case "opencode":
      io.script("opencode", { args: ["--version"] }, { stdout: `${item.version}\n` })
        .script(
          "opencode",
          { args: ["run", "--help"] },
          { stderr: "--format --agent --title --pure --model" },
        )
        .script("opencode", { has: ["run", "--format"] }, failed);
      return { runner: makeOpenCodeRunner(io), io };
  }
}

async function failure(runner: AgentRunner): Promise<unknown> {
  try {
    await runner.run({
      prompt: "Reply with the single word ok",
      schema,
      capabilities: FULL_CLAUDE,
    });
  } catch (error) {
    return error;
  } finally {
    await runner.finalize?.();
  }
  throw new Error("expected the runner to fail");
}

describe("classifyFailure over real captured CLI errors", () => {
  it.each(cases.map((item) => [item.id, item] as const))("%s", async (_id, item) => {
    const { runner, io } = runnerFor(item);
    const error = await failure(runner);
    expect(error).toBeInstanceOf(AgentRunnerError);
    expect(classifyFailure(item.runner, error)).toBe(item.expected);
    // One model call: a CLI error is never retried with a corrective note.
    expect(io.calls.filter((call) => call.stdin.includes("single word ok"))).toHaveLength(1);
  });

  it("covers every runner with a signed-out and an unknown-model capture", () => {
    for (const name of ["claude", "codex", "kiro", "opencode"] as const) {
      const ids = cases.filter((item) => item.runner === name).map((item) => item.id);
      expect(ids).toContain(`${name}-unknown-model`);
      expect(ids).toContain(`${name}-signed-out`);
    }
  });
});

describe("classifyFailure inputs", () => {
  it("keeps typed kinds", () => {
    const table: [AgentRunnerError, FailureClass][] = [
      [new AgentRunnerError("timeout", "claude invocation timed out after 10ms"), "timeout"],
      [new AgentRunnerError("validation", "response failed schema validation"), "validation"],
      [new AgentRunnerError("missing-binary", "`codex` was not found on PATH"), "missing-binary"],
      [new AgentRunnerError("transient", "kiro-cli produced no output"), "transient"],
      [new AgentRunnerError("sign-in", "Not logged in"), "sign-in"],
    ];
    for (const [error, expected] of table) expect(classifyFailure("claude", error)).toBe(expected);
  });

  it("never reads the model's answer or stdout, even with a zero exit", () => {
    const answer = "HTTP 500 unauthorized: 401 quota exceeded, rate limit, model not found";
    for (const runner of ["claude", "codex", "kiro", "opencode"] as const) {
      expect(
        classifyFailure(runner, new AgentRunnerError("cli-error", "exit 0", { output: answer })),
      ).toBe("cli-error");
      expect(classifyFailure(runner, { code: 0, stdout: answer, stderr: "" })).toBe("cli-error");
      expect(classifyFailure(runner, new Error(answer))).toBe("cli-error");
      expect(classifyFailure(runner, answer)).toBe("cli-error");
    }
  });

  it("reads captured wording from stderr only", () => {
    const kiroSignedOut =
      "Not logged in. Set the KIRO_API_KEY environment variable or run `kiro-cli login` first.\n";
    expect(
      classifyFailure("kiro", new AgentRunnerError("cli-error", "x", { stderr: kiroSignedOut })),
    ).toBe("sign-in");
    expect(
      classifyFailure(
        "kiro",
        new AgentRunnerError("cli-error", kiroSignedOut, { output: kiroSignedOut }),
      ),
    ).toBe("cli-error");
    const tag = '[claude-code:unrecognized_model] {"model":"example"}\n';
    expect(classifyFailure("claude", new AgentRunnerError("cli-error", "x", { stderr: tag }))).toBe(
      "model-unavailable",
    );
    // A rule belongs to the CLI it was captured from.
    expect(classifyFailure("codex", new AgentRunnerError("cli-error", "x", { stderr: tag }))).toBe(
      "cli-error",
    );
  });

  it("treats a spawn that could not find the binary as missing-binary", () => {
    const error = Object.assign(new Error("spawn kiro-cli ENOENT"), {
      code: "ENOENT",
      syscall: "spawn kiro-cli",
    });
    expect(classifyFailure("kiro", error)).toBe("missing-binary");
    expect(classifyFailure("kiro", Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(
      "cli-error",
    );
  });

  it("does not trust an unknown kind", () => {
    expect(classifyFailure("claude", { kind: "rate-limited" })).toBe("cli-error");
    expect(classifyFailure("claude", undefined)).toBe("cli-error");
  });
});

/** A captured case with its output changed, for typed fields no capture has shown yet. */
function variant(id: string, change: (item: CapturedCase) => Partial<CapturedCase>): CapturedCase {
  const item = cases.find((c) => c.id === id);
  if (!item) throw new Error(`no captured case ${id}`);
  return { ...item, ...change(item) };
}

function claudeApiError(status: number | null, result: string): Partial<CapturedCase> {
  const envelope = JSON.parse(cases.find((c) => c.id === "claude-unknown-model")?.stdout ?? "{}");
  return { stdout: JSON.stringify({ ...envelope, api_error_status: status, result }), stderr: "" };
}

describe("typed statuses and codes in a CLI's own error report", () => {
  const table: [string, CapturedCase][] = [
    [
      "Claude 529 overloaded",
      variant("claude-unknown-model", () => ({
        expected: "transient",
        ...claudeApiError(529, "API Error: 529 Overloaded"),
      })),
    ],
    [
      "Claude 429 rate limit",
      variant("claude-unknown-model", () => ({
        expected: "transient",
        ...claudeApiError(429, "API Error: 429 Too many requests"),
      })),
    ],
    [
      "Claude 500",
      variant("claude-unknown-model", () => ({
        expected: "transient",
        ...claudeApiError(500, "API Error: 500 Internal server error"),
      })),
    ],
    [
      "Claude 402 billing",
      variant("claude-unknown-model", () => ({
        expected: "quota",
        ...claudeApiError(402, "API Error: 402 Payment required"),
      })),
    ],
    // Only the refused-model wording with a 400 steps a model down.
    [
      "Claude other 400",
      variant("claude-unknown-model", () => ({
        expected: "cli-error",
        ...claudeApiError(400, "API Error: 400 prompt is too long"),
      })),
    ],
    [
      "Claude refused wording without a 400",
      variant("claude-unknown-model", () => ({
        expected: "cli-error",
        ...claudeApiError(
          null,
          "API Error: data retention mode 'none' is not available for this model",
        ),
      })),
    ],
    [
      "Codex 503 in its error event",
      variant("codex-signed-out", (item) => ({
        expected: "transient",
        stdout: item.stdout.replaceAll("401 Unauthorized", "503 Service Unavailable"),
        stderr: "",
      })),
    ],
    [
      "Codex provider code insufficient_quota",
      variant("codex-unknown-model", (item) => ({
        expected: "quota",
        stdout: item.stdout.replaceAll("validation_error", "insufficient_quota"),
      })),
    ],
    [
      "Codex provider code rate_limit_exceeded",
      variant("codex-unknown-model", (item) => ({
        expected: "transient",
        stdout: item.stdout
          .replaceAll("validation_error", "rate_limit_exceeded")
          .replaceAll("The provided model identifier is invalid.", "Slow down."),
      })),
    ],
    [
      "Codex provider code that is an object key",
      variant("codex-unknown-model", (item) => ({
        expected: "cli-error",
        stdout: item.stdout
          .replaceAll("validation_error", "constructor")
          .replaceAll("The provided model identifier is invalid.", "x"),
      })),
    ],
    [
      "OpenCode statusCode 429",
      variant("opencode-unknown-model", (item) => ({
        expected: "transient",
        stdout: item.stdout
          .replace('"name":"UnknownError"', '"name":"APIError"')
          .replace('"ref":', '"statusCode":429,"ref":'),
      })),
    ],
  ];

  it.each(table)("%s", async (_name, item) => {
    const { runner } = runnerFor(item);
    const error = await failure(runner);
    expect(error).toBeInstanceOf(AgentRunnerError);
    expect(classifyFailure(item.runner, error)).toBe(item.expected);
  });

  it("a status in an answer that is not an API error envelope is not read", async () => {
    const answer = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      api_error_status: 529,
      result: "database is locked",
    });
    const { runner } = runnerFor({
      ...variant("claude-unknown-model", () => ({})),
      stdout: answer,
      stderr: "",
    });
    expect(classifyFailure("claude", await failure(runner))).toBe("cli-error");
  });

  it("a failed Kiro run without an error object is a plain CLI error with a fixed message", async () => {
    // The model quoted an error from the session it was reading before the run stopped.
    const partial = "The user hit: The model 'example-model' is not available in this region";
    const stdout = `${JSON.stringify({ type: "runFinished", data: { status: "failed", finalText: partial } })}\n`;
    const io = fakeRunnerIo().script("kiro-cli", { has: ["--no-interactive"] }, { stdout });
    const error = await runKiro(
      { prompt: "digest", schema },
      "/tmp/human-hindsight-kiro-fixture",
      kiroEnv(io, "3.5.0"),
      undefined,
      0,
    ).catch((e: unknown) => e);
    expect(classifyFailure("kiro", error)).toBe("cli-error");
    expect((error as Error).message).toBe(
      "kiro-cli reported an error: Kiro stopped before completing the request",
    );
  });

  it("Kiro names stderr, never the answer, when it exits non-zero after printing one", async () => {
    const io = fakeRunnerIo().script(
      "kiro-cli",
      { has: ["--no-interactive"] },
      { code: 1, stdout: "The model 'x' is not available", stderr: "" },
    );
    const error = await runKiro(
      { prompt: "digest", schema },
      "/tmp/human-hindsight-kiro-fixture",
      kiroEnv(io, "2.12.1"),
      undefined,
      0,
    ).catch((e: unknown) => e);
    expect(classifyFailure("kiro", error)).toBe("cli-error");
    expect((error as Error).message).toBe("kiro-cli exited 1: no error detail");
  });
});
