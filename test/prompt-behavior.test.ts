import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { DigestResponseSchema } from "../src/claude/schemas.js";
import { exportMessages } from "../src/core/preference-evidence.js";
import { readObservedPreferences } from "../src/core/preferences.js";
import { type RunnerFn, runDigestStage } from "../src/distill/pipeline.js";
import { runEvaluationCli } from "../src/eval/cli.js";
import {
  evaluationCases,
  evaluationHash,
  evaluationRequest,
  runEvaluationCase,
  scoreEvaluation,
} from "../src/eval/prompts.js";
import type { AgentRunner } from "../src/runners/types.js";

const temporary: string[] = [];
function scratch() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-behavior-"));
  temporary.push(directory);
  return directory;
}
function sink() {
  let text = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      text += chunk.toString();
      done();
    },
  });
  return { output, text: () => text };
}
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("synthetic behavioral regression suite", () => {
  it("has distinct fixture IDs and at least one detected counterexample per case", () => {
    expect(new Set(evaluationCases.map((fixture) => fixture.id)).size).toBe(evaluationCases.length);
    for (const fixture of evaluationCases) {
      expect(fixture.regressions.length).toBeGreaterThan(0);
      expect(new Set(fixture.rules.map((rule) => rule.id)).size).toBe(fixture.rules.length);
    }
  });

  for (const fixture of evaluationCases) {
    it(`${fixture.id}: accepts the human-authored reference behavior`, () => {
      const failures = scoreEvaluation(fixture, fixture.reference).filter((check) => !check.passed);
      expect(failures).toEqual([]);
    });
    for (const regression of fixture.regressions) {
      it(`${fixture.id}: detects ${regression.label}`, () => {
        const failures = scoreEvaluation(fixture, regression.response)
          .filter((check) => !check.passed)
          .map((check) => check.id);
        for (const id of regression.fails) expect(failures).toContain(id);
      });
    }
  }

  it("executes the actual production prompt/schema and records reproducible inputs", async () => {
    for (const fixture of evaluationCases) {
      const expected = evaluationRequest(fixture);
      const calls: { prompt: string; model?: string }[] = [];
      const runner: RunnerFn = async (options) => {
        calls.push(options);
        expect(options.prompt).toBe(expected.prompt);
        expect(options.schema).toBe(expected.schema);
        return options.schema.parse(fixture.reference);
      };
      const result = await runEvaluationCase(fixture, runner, { model: "synthetic-model" });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.model).toBe("synthetic-model");
      expect(result.input_hash).toBe(evaluationHash(fixture.input));
      expect(result.prompt_hash).toBe(evaluationHash(expected.prompt));
      expect(result.prompt_version).toBe(expected.version);
      expect(result.response).toEqual(fixture.reference);
      expect(result.checks.every((check) => check.passed)).toBe(true);
    }
  });

  it("round-trips hostile transcript text as one JSON record rather than extra message structure", () => {
    const fixture = evaluationCases.find((candidate) => candidate.id === "quoted-injection");
    if (fixture?.stage !== "digest") throw new Error("Missing fixture");
    const prompt = evaluationRequest(fixture).prompt;
    const records = prompt
      .split("\n")
      .filter((line) => line.startsWith('{"message_id":'))
      .map((line) => JSON.parse(line));
    const messages = exportMessages(fixture.input.exportName, fixture.input.content);
    expect(records).toEqual(
      messages.map((message) => ({
        message_id: message.id,
        timestamp: message.timestamp,
        text: message.text,
      })),
    );
    expect(records).toHaveLength(2);
    expect(prompt.split("\n").filter((line) => line === "=== END HUMAN MESSAGES ===")).toHaveLength(
      1,
    );
  });

  it("preserves the full human evidence for authoring, including explicit rejection", () => {
    for (const fixture of evaluationCases.filter((candidate) => candidate.stage === "author")) {
      const prompt = evaluationRequest(fixture).prompt;
      for (const member of fixture.input.members) {
        const encoded = prompt.split("\n").find((line) => line === JSON.stringify(member.content));
        expect(encoded).toBeDefined();
        expect(JSON.parse(encoded as string)).toBe(member.content);
      }
    }
  });

  it("keeps cited preferences from abandoned work before any authoring stage exists", async () => {
    const fixture = evaluationCases.find((candidate) => candidate.id === "failed-preference");
    if (fixture?.stage !== "digest") throw new Error("Missing fixture");
    const home = scratch();
    fs.mkdirSync(path.join(home, "exports"));
    fs.writeFileSync(path.join(home, "exports", fixture.input.exportName), fixture.input.content);
    fs.writeFileSync(
      path.join(home, "exports", "outcomes.json"),
      JSON.stringify({ [fixture.input.exportName]: fixture.input.outcome }),
    );
    const entry = {
      export: fixture.input.exportName,
      source: "/synthetic/failed-session.jsonl",
      project: "synthetic-project",
      sessionId: "failed-session",
      messages: 2,
      first_ts: "2026-10-20T10:00:00Z",
      last_ts: "2026-10-20T10:01:00Z",
    };
    fs.writeFileSync(path.join(home, "exports", "manifest.json"), JSON.stringify([entry]));
    const digest = DigestResponseSchema.parse(fixture.reference);
    const runner: RunnerFn = async (options) => options.schema.parse(digest);
    const result = await runDigestStage({
      home,
      entries: [entry],
      runner,
      output: sink().output,
    });
    expect(result.completed).toBe(1);
    const observed = readObservedPreferences(home);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      scope: "global",
      verified: true,
      text: "Explain the diagnosis before making edits.",
    });
    expect(observed[0]?.occurrences[0]?.quote).toBe(
      "Always explain the diagnosis before making edits.",
    );
  });
});

describe("opt-in evaluation workflow", () => {
  it("lists cases without resolving a runner or making calls", async () => {
    const { output, text } = sink();
    const code = await runEvaluationCli([], {
      output,
      resolve: async () => {
        throw new Error("Must not resolve a runner");
      },
    });
    expect(code).toBe(0);
    expect(text()).toContain("No model calls.");
    expect(text()).toContain("reject-deployment");
  });

  it("requires live mode as well as explicit spending consent", async () => {
    const output = sink().output;
    expect(await runEvaluationCli(["--yes"], { output })).toBe(1);
    const file = path.join(scratch(), "result.json");
    let calls = 0;
    const runner: AgentRunner = {
      name: "claude",
      installHint: "",
      run: async () => {
        calls++;
        throw new Error("Must not make a model call");
      },
    };
    const code = await runEvaluationCli(["--live", "--out", file], {
      output,
      input: Readable.from(["n\n"]),
      resolve: async () => runner,
    });
    expect(code).toBe(2);
    expect(calls).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("records an explicitly requested case, then scores it offline without a runner", async () => {
    const fixture = evaluationCases.find((candidate) => candidate.id === "reject-deployment");
    if (!fixture) throw new Error("Missing fixture");
    const file = path.join(scratch(), "result.json");
    let calls = 0;
    let finalized = 0;
    const runner: AgentRunner = {
      name: "claude",
      installHint: "",
      run: async (options) => {
        calls++;
        return options.schema.parse(fixture.reference);
      },
      finalize: async () => {
        finalized++;
      },
    };
    const code = await runEvaluationCli(
      ["--live", "--yes", "--out", file, "--case", fixture.id, "--model", "test-model"],
      { output: sink().output, resolve: async () => runner },
    );
    expect(code).toBe(0);
    expect(calls).toBe(1);
    expect(finalized).toBe(1);
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(record).toMatchObject({
      format_version: 1,
      runner: "claude",
      requested_model: "test-model",
      cases: [{ id: fixture.id, response: fixture.reference }],
    });
    expect(record.versions.digest).toBeGreaterThan(0);
    expect(record.cases[0].prompt_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(
      await runEvaluationCli(["--score", file], {
        output: sink().output,
        resolve: async () => {
          throw new Error("Offline scoring cannot resolve a runner");
        },
      }),
    ).toBe(0);
    record.cases[0].fixture_hash = "changed";
    fs.writeFileSync(file, JSON.stringify(record));
    expect(await runEvaluationCli(["--score", file], { output: sink().output })).toBe(1);
  });

  it("refuses to overwrite an existing evaluation before resolving a runner", async () => {
    const file = path.join(scratch(), "result.json");
    fs.writeFileSync(file, "keep this result");
    const code = await runEvaluationCli(["--live", "--yes", "--out", file], {
      output: sink().output,
      resolve: async () => {
        throw new Error("Must not resolve a runner");
      },
    });
    expect(code).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe("keep this result");
  });
});
