import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTHOR_PROMPT_VERSION } from "../src/claude/prompts/author.js";
import { CLUSTER_PROMPT_VERSION } from "../src/claude/prompts/cluster.js";
import { DIGEST_PROMPT_VERSION } from "../src/claude/prompts/digest.js";
import {
  AuthorSchema,
  ClusterSchema,
  DigestResponseSchema,
  toJsonSchema,
} from "../src/claude/schemas.js";
import { contentFingerprint, fingerprint } from "../src/core/fingerprint.js";
import {
  type OperationKind,
  OperationStore,
  type QueueOperation,
} from "../src/distill/operations.js";
import {
  executeRetry,
  prepareRecovery,
  prepareRetry,
  type RetryHandler,
} from "../src/distill/retry.js";

const homes: string[] = [];
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hh-retry-"));
  homes.push(home);
  fs.mkdirSync(path.join(home, "exports"));
  fs.writeFileSync(path.join(home, "exports/a.md"), "source");
  const store = new OperationStore(home, "g1");
  const queue = (unitId: string, kind: OperationKind = "digest") =>
    store.queue({
      kind,
      unitId,
      generation: "g1",
      runId: "r1",
      promptVersion: kind === "digest" ? DIGEST_PROMPT_VERSION : CLUSTER_PROMPT_VERSION,
      schema: toJsonSchema(kind === "digest" ? DigestResponseSchema : ClusterSchema),
      logicalInput: { unitId },
      sources: [{ path: "exports/a.md", hash: contentFingerprint("source"), length: 6 }],
      settings: {
        runner: "claude",
        model: "old",
        timeoutMs: 300_000,
        timeoutExplicit: false,
        budget: 400_000,
        truncate: "never",
      },
      request: { prompt: "saved request", timeoutUnits: 2 },
    } satisfies QueueOperation);
  const run = vi.fn(async () => ({ saved: true }));
  const publish = vi.fn();
  const finalize = vi.fn(async () => undefined);
  const handler: RetryHandler = {
    prepare: (input) => input.request,
    validate: () => undefined,
    run: (_request, _settings, _input, invoke) =>
      invoke({ prompt: "saved request", schema: DigestResponseSchema }),
    publish,
  };
  const handlers = { digest: handler, "cluster-window": handler };
  const getRunner = vi.fn(() => ({
    name: "claude" as const,
    installHint: "",
    run: run as never,
    finalize,
  }));
  return { home, store, queue, run, publish, finalize, handler, handlers, getRunner };
}
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
describe("strict retry selection and execution", () => {
  it("retries failures only, preserving committed and queued operations under overrides", async () => {
    const f = fixture();
    const success = f.queue("success");
    const a = f.store.start(success.id);
    f.store.saveResult(success.id, a.id, { saved: true });
    f.store.commit(success.id);
    const failed = f.queue("failed");
    f.store.start(failed.id);
    f.store.fail(failed.id, "timeout");
    const queued = f.queue("queued");
    const plan = prepareRetry({
      home: f.home,
      handlers: f.handlers,
      overrides: { model: "new", budget: 600_000 },
    });
    expect(plan.modelOperations.map((item) => item.operation.id)).toEqual([failed.id]);
    expect(plan.excluded.map((item) => item.id)).toEqual([success.id, queued.id]);
    expect(plan.modelOperations[0]?.settings.timeoutMs).toBe(900_000);
    const done = await executeRetry(plan, { handlers: f.handlers, getRunner: f.getRunner });
    expect(done.succeeded).toEqual([failed.id]);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.finalize).toHaveBeenCalledOnce();
    const repeat = prepareRetry({ home: f.home, handlers: f.handlers });
    await executeRetry(repeat, { handlers: f.handlers, getRunner: f.getRunner });
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it("makes zero calls on drift and dry run performs no writes", () => {
    const f = fixture();
    const failed = f.queue("failed");
    f.store.start(failed.id);
    f.store.fail(failed.id, "timeout");
    fs.writeFileSync(path.join(f.home, "exports/a.md"), "changed");
    const before = fs.readFileSync(path.join(f.home, "distill/operations.json"), "utf8");
    const plan = prepareRetry({ home: f.home, handlers: f.handlers });
    expect(plan.modelOperations).toHaveLength(0);
    expect(plan.blocked[0]?.reason).toMatch(/Source changed/);
    expect(f.run).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(f.home, "distill/operations.json"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(f.home, "distill/writer.lock"))).toBe(false);
  });
  it("recovers local results without invoking a model or applying budget overrides", async () => {
    const f = fixture();
    const op = f.queue("saved");
    const attempt = f.store.start(op.id);
    f.store.saveResult(op.id, attempt.id, { saved: true });
    f.handler.prepare = () => {
      throw new Error("budget too small");
    };
    const plan = prepareRetry({ home: f.home, handlers: f.handlers, overrides: { budget: 1 } });
    expect(plan.localRepairs).toHaveLength(1);
    const done = await executeRetry(plan, { handlers: f.handlers, getRunner: f.getRunner });
    expect(done.repaired).toEqual([op.id]);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenCalledOnce();
  });
  it("does not publish clustering results or schedule queued stages", async () => {
    const f = fixture();
    const op = f.queue("window", "cluster-window");
    f.store.start(op.id);
    f.store.fail(op.id, "timeout");
    f.queue("second-window", "cluster-window");
    fs.mkdirSync(path.join(f.home, "distill"), { recursive: true });
    fs.writeFileSync(path.join(f.home, "distill/tasks.json"), '"grouping untouched"');
    const plan = prepareRetry({ home: f.home, handlers: f.handlers });
    expect(plan.modelOperations[0]?.settings.timeoutMs).toBe(910_000);
    const done = await executeRetry(plan, { handlers: f.handlers, getRunner: f.getRunner });
    expect(done.pendingAdoption).toEqual([op.id]);
    expect(f.publish).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(f.home, "distill/tasks.json"), "utf8")).toBe(
      '"grouping untouched"',
    );
    expect(prepareRetry({ home: f.home, handlers: f.handlers }).modelOperations).toHaveLength(0);
  });
  it("rejects changed consented plans before spending", async () => {
    const f = fixture();
    const op = f.queue("failed");
    f.store.start(op.id);
    f.store.fail(op.id, "timeout");
    const plan = prepareRetry({ home: f.home, handlers: f.handlers });
    fs.writeFileSync(path.join(f.home, "exports/a.md"), "edit");
    await expect(
      executeRetry(plan, { handlers: f.handlers, getRunner: f.getRunner }),
    ).rejects.toThrow(/plan changed/);
    expect(f.run).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.home, "distill/writer.lock"))).toBe(false);
  });
  it("inherits retry overrides after failure and preserves explicit timeout", async () => {
    const f = fixture();
    const op = f.queue("failed");
    f.store.start(op.id);
    f.store.fail(op.id, "timeout");
    f.run.mockRejectedValueOnce(new Error("still broken"));
    const plan = prepareRetry({
      home: f.home,
      handlers: f.handlers,
      overrides: { model: "new", timeoutMs: 123_000, budget: 600_000 },
    });
    await executeRetry(plan, { handlers: f.handlers, getRunner: f.getRunner });
    const next = prepareRetry({ home: f.home, handlers: f.handlers });
    expect(next.modelOperations[0]?.settings).toMatchObject({
      model: "new",
      timeoutMs: 123_000,
      timeoutExplicit: true,
      budget: 600_000,
    });
  });
  it("blocks unsupported prompt versions and distinguishes malformed ledgers", () => {
    const f = fixture();
    const op = f.queue("failed");
    f.store.start(op.id);
    f.store.fail(op.id, "timeout");
    const noHistory = fs.mkdtempSync(path.join(os.tmpdir(), "hh-retry-"));
    homes.push(noHistory);
    expect(() => prepareRetry({ home: noHistory, handlers: f.handlers })).toThrow(
      /no recorded failure history/,
    );
    fs.writeFileSync(path.join(f.home, "distill/operations.json"), "{}");
    expect(() => prepareRetry({ home: f.home, handlers: f.handlers })).toThrow();
  });
  it("resolves recorded blockers only after the disclosed budget is sufficient", async () => {
    const f = fixture();
    const op = f.queue("blocked");
    f.store.block(op.id, "over budget");
    f.handler.prepare = (input, settings) => {
      if (settings.budget < 500_000) throw new Error("over budget");
      return input.request;
    };
    expect(prepareRetry({ home: f.home, handlers: f.handlers }).blocked).toHaveLength(1);
    const plan = prepareRetry({
      home: f.home,
      handlers: f.handlers,
      overrides: { budget: 600_000 },
    });
    expect(plan.modelOperations).toHaveLength(1);
    await executeRetry(plan, { handlers: f.handlers, getRunner: f.getRunner });
    expect(f.run).toHaveBeenCalledOnce();
  });
  it("does not dispatch if output ownership changes during runner preparation", async () => {
    const f = fixture();
    const op = f.queue("failed");
    f.store.start(op.id);
    f.store.fail(op.id, "failure");
    let protectedOutput = false;
    f.handler.guard = () => {
      if (protectedOutput) throw new Error("protected output");
    };
    const plan = prepareRetry({ home: f.home, handlers: f.handlers });
    const getRunner = () => {
      protectedOutput = true;
      return f.getRunner();
    };
    const result = await executeRetry(plan, { handlers: f.handlers, getRunner });
    expect(f.run).not.toHaveBeenCalled();
    expect(result.failed[0]?.reason).toBe("protected output");
  });
  it("rejects changed checkpoints under an existing consented preview", async () => {
    const f = fixture();
    const op = f.queue("failed");
    f.store.start(op.id);
    f.store.fail(op.id, "failure");
    const plan = prepareRetry({ home: f.home, handlers: f.handlers });
    fs.writeFileSync(path.join(f.home, "distill/tasks.json"), "{}");
    await expect(
      executeRetry(plan, { handlers: f.handlers, getRunner: f.getRunner }),
    ).rejects.toThrow(/plan changed/);
    expect(f.run).not.toHaveBeenCalled();
  });
  it("recognizes fallback publication if the index update was interrupted", () => {
    const f = fixture();
    const op = f.queue("merge", "cluster-window");
    f.store.start(op.id);
    f.store.fail(op.id, "merge failed");
    const grouping = { tasks: [], misc: [] };
    fs.writeFileSync(
      path.join(f.home, "distill/tasks.json"),
      JSON.stringify({
        ...grouping,
        generation: "g1",
        fallback_merge_id: op.id,
        grouping_hash: fingerprint(grouping),
      }),
    );
    const plan = prepareRetry({ home: f.home, handlers: f.handlers });
    expect(plan.modelOperations).toHaveLength(0);
    expect(plan.excluded[0]?.reason).toMatch(/published fallback/);
  });
  it("does not purchase committed named recovery even when its output is missing", async () => {
    const f = fixture();
    const seed = f.queue("seed");
    const original = f.store.loadInput(seed.id);
    const input: QueueOperation = {
      kind: "author",
      unitId: "author",
      generation: "g1",
      runId: "r1",
      promptVersion: AUTHOR_PROMPT_VERSION,
      schema: toJsonSchema(AuthorSchema),
      logicalInput: { unitId: "author" },
      sources: original.sources,
      settings: original.settings,
      request: original.request,
    };
    const op = f.store.queue(input);
    const attempt = f.store.start(op.id);
    f.store.saveResult(op.id, attempt.id, { saved: true });
    f.store.commit(op.id);
    const handlers = { ...f.handlers, author: f.handler };
    const plan = prepareRecovery({ home: f.home, operations: [input], handlers });
    expect(plan.modelOperations).toHaveLength(0);
    expect(plan.excluded[0]?.reason).toBe("committed");
    await executeRetry(plan, { handlers, getRunner: f.getRunner });
    expect(f.run).not.toHaveBeenCalled();
  });
  it("reuses a named recovery's already saved result without making a new operation", async () => {
    const f = fixture();
    const seed = f.queue("seed");
    const original = f.store.loadInput(seed.id);
    const input: QueueOperation = {
      kind: "author",
      unitId: "author",
      generation: "g1",
      runId: "r1",
      promptVersion: AUTHOR_PROMPT_VERSION,
      schema: toJsonSchema(AuthorSchema),
      logicalInput: { unitId: "author" },
      sources: original.sources,
      settings: original.settings,
      request: original.request,
    };
    const op = f.store.queue(input);
    const attempt = f.store.start(op.id);
    f.store.saveResult(op.id, attempt.id, { saved: true });
    const handlers = { ...f.handlers, author: f.handler };
    const plan = prepareRecovery({ home: f.home, operations: [input], handlers });
    expect(plan.localRepairs.map((item) => item.operation.id)).toEqual([op.id]);
    await executeRetry(plan, { handlers, getRunner: f.getRunner });
    expect(f.run).not.toHaveBeenCalled();
    expect(new OperationStore(f.home).list()).toHaveLength(2);
  });
  it("maps mixed existing and new named recovery by task identity", async () => {
    const f = fixture();
    const seed = f.queue("seed");
    const original = f.store.loadInput(seed.id);
    const make = (unitId: string): QueueOperation => ({
      kind: "author",
      unitId,
      generation: "g1",
      runId: "r1",
      promptVersion: AUTHOR_PROMPT_VERSION,
      schema: toJsonSchema(AuthorSchema),
      logicalInput: { unitId },
      sources: original.sources,
      settings: original.settings,
      request: { prompt: unitId },
    });
    const priorInput = make("prior");
    const prior = f.store.queue(priorInput);
    f.store.start(prior.id);
    f.store.fail(prior.id, "retry me");
    const newInput = make("new");
    const handlers = { ...f.handlers, author: f.handler };
    const plan = prepareRecovery({ home: f.home, operations: [priorInput, newInput], handlers });
    expect(plan.modelOperations.map((item) => item.operation.unitId)).toEqual(["prior", "new"]);
    await executeRetry(plan, { handlers, getRunner: f.getRunner });
    const records = new OperationStore(f.home).list();
    expect(records.filter((record) => record.unitId === "prior")).toHaveLength(1);
    expect(records.find((record) => record.id === prior.id)?.state).toBe("committed");
    expect(records.filter((record) => record.unitId === "new")).toHaveLength(1);
    expect(records.find((record) => record.unitId === "new")?.state).toBe("committed");
  });
  it("records bounded correction prompts against the same operation attempt", async () => {
    const f = fixture();
    const op = f.queue("correction");
    f.store.start(op.id);
    f.store.fail(op.id, "failed");
    f.handler.run = async (_request, _settings, _input, invoke) => {
      await invoke({ prompt: "first request", schema: DigestResponseSchema });
      return invoke({ prompt: "corrected request", schema: DigestResponseSchema });
    };
    const plan = prepareRetry({ home: f.home, handlers: f.handlers });
    await executeRetry(plan, { handlers: f.handlers, getRunner: f.getRunner });
    const attempt = new OperationStore(f.home)
      .list()
      .find((record) => record.id === op.id)
      ?.attempts.at(-1);
    expect(attempt?.invocations).toHaveLength(2);
    expect(
      attempt?.invocations.map(
        (invocation) =>
          JSON.parse(fs.readFileSync(path.join(f.home, invocation.requestPath), "utf8")).prompt,
      ),
    ).toEqual(["first request", "corrected request"]);
  });
});
