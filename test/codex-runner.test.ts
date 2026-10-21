import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runCodex } from "../src/runners/codex.js";
import type { RunnerIo, SpawnOptions, SpawnResult } from "../src/runners/shared.js";

const schema = z.object({ answer: z.string() });
const success: SpawnResult = { code: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
const argsFile = (args: string[], flag: string) => {
  const file = args[args.indexOf(flag) + 1];
  if (!file) throw new Error(`missing ${flag}`);
  return file;
};
const ioFor = (spawn: RunnerIo["spawn"]): RunnerIo => ({ which: () => "/usr/bin/codex", spawn });

describe("Codex runner", () => {
  it("passes schema/model, uses stdin and private scratch space, and cleans up", async () => {
    let scratch = "";
    let calls = 0;
    const io = ioFor(async (_bin, args, opts) => {
      calls++;
      scratch = opts.cwd ?? "";
      expect(args[0]).toBe("exec");
      expect(args.at(-1)).toBe("-");
      expect(args).toContain("--ephemeral");
      expect(args).toContain("read-only");
      expect(args).toContain('approval_policy="never"');
      expect(args).toContain("features.shell_tool=false");
      expect(args).toContain("requested-model");
      expect(opts.input).toContain("source content");
      const file = argsFile(args, "--output-schema");
      expect(JSON.parse(fs.readFileSync(file, "utf8")).properties.answer.type).toBe("string");
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      fs.writeFileSync(argsFile(args, "--output-last-message"), '{"answer":"ready"}');
      return { ...success, stdout: "progress chatter should never become the answer" };
    });
    await expect(
      runCodex({ prompt: "source content", schema, model: "requested-model" }, io),
    ).resolves.toEqual({ answer: "ready" });
    expect(calls).toBe(1);
    expect(path.basename(scratch)).toMatch(/^cc-hindsight-codex-/);
    expect(fs.existsSync(scratch)).toBe(false);
  });

  it("accepts completed JSONL agent messages when a wrapper omits the output file", async () => {
    const stdout = [
      { type: "thread.started", thread_id: "t1" },
      { type: "item.completed", item: { type: "command_execution", aggregated_output: "noise" } },
      { type: "item.completed", item: { type: "agent_message", text: '{"answer":"ready"}' } },
      { type: "turn.completed", usage: {} },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    await expect(
      runCodex(
        { prompt: "p", schema },
        ioFor(async () => ({ ...success, stdout })),
      ),
    ).resolves.toEqual({ answer: "ready" });
  });

  it("retries malformed model output once with a corrective note", async () => {
    const inputs: string[] = [];
    const io = ioFor(async (_bin, args, opts) => {
      inputs.push(opts.input);
      fs.writeFileSync(
        argsFile(args, "--output-last-message"),
        inputs.length === 1 ? '{"answer":12}' : '{"answer":"fixed"}',
      );
      return success;
    });
    await expect(runCodex({ prompt: "p", schema }, io)).resolves.toEqual({ answer: "fixed" });
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toContain("Your previous response could not be used");
  });

  it("exhausts one retry and clears stale answer files between attempts", async () => {
    let calls = 0;
    let scratch = "";
    const io = ioFor(async (_bin, args, opts) => {
      scratch = opts.cwd ?? "";
      const file = argsFile(args, "--output-last-message");
      expect(fs.existsSync(file)).toBe(false);
      if (calls++ === 0) fs.writeFileSync(file, '{"wrong":"shape"}');
      return success;
    });
    await expect(runCodex({ prompt: "p", schema }, io)).rejects.toMatchObject({
      kind: "validation",
    });
    expect(calls).toBe(2);
    expect(fs.existsSync(scratch)).toBe(false);
  });

  it.each([
    { result: { ...success, code: 1, stderr: "not authenticated" }, kind: "cli-error" },
    { result: { ...success, timedOut: true }, kind: "timeout" },
    {
      result: {
        ...success,
        stdout: '{"type":"turn.failed","error":{"message":"quota exhausted"}}',
      },
      kind: "cli-error",
    },
  ])("does not retry $kind process failures", async ({ result, kind }) => {
    const calls: SpawnOptions[] = [];
    const io = ioFor(async (_bin, _args, opts) => {
      calls.push(opts);
      return result;
    });
    await expect(runCodex({ prompt: "p", schema, timeoutMs: 100 }, io)).rejects.toMatchObject({
      kind,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.timeoutMs).toBe(100);
    expect(fs.existsSync(calls[0]?.cwd ?? "")).toBe(false);
  });

  it("reports a missing binary without trying to spawn", async () => {
    await expect(
      runCodex(
        { prompt: "p", schema },
        {
          which: () => null,
          spawn: async () => {
            throw new Error("must not spawn");
          },
        },
      ),
    ).rejects.toMatchObject({
      kind: "missing-binary",
      message: expect.stringContaining("codex login"),
    });
  });
});
