/**
 * The distill engine's promises after the stage split: the ledger's write
 * grouping and crash recovery, reuse rules, the shared breaker, strict retry
 * identity, legacy matching, and the behavior decisions recorded for the
 * split (stage defaults, budgets, blocked units, plain-mode output).
 *
 * Every test runs on the unflushed writer except the one durable-path test.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import pkg from "../package.json" with { type: "json" };
import type { ManifestEntry } from "../src/commands/export.js";
import { allocateMemberBudgets, DEFAULT_INPUT_BUDGET } from "../src/core/budget.js";
import { contentFingerprint } from "../src/core/fingerprint.js";
import {
  durableWriter,
  type FileWriter,
  setFileWriter,
  unflushedWriter,
} from "../src/core/fsutil.js";
import { saveDigests } from "../src/distill/checkpoints.js";
import { runClusterStage } from "../src/distill/cluster.js";
import { runDigestStage } from "../src/distill/digest.js";
import {
  attemptOwnerStatus,
  OperationStore,
  type QueueOperation,
} from "../src/distill/operations.js";
import {
  createRetryHandlers,
  prepareTaskRecoveryInputs,
  type RunnerFn,
  runAuthorStage,
} from "../src/distill/pipeline.js";
import { AUTHOR_PROMPT_VERSION } from "../src/distill/prompts/author.js";
import { CLUSTER_PROMPT_VERSION } from "../src/distill/prompts/cluster.js";
import { DIGEST_PROMPT_VERSION } from "../src/distill/prompts/digest.js";
import {
  executeRetry,
  prepareRecovery,
  prepareRetry,
  type RetryHandler,
} from "../src/distill/retry.js";
import {
  type Author,
  AuthorSchema,
  type ClusterTask,
  type Digest,
  DigestResponseSchema,
  toJsonSchema,
} from "../src/distill/schemas.js";
import { startStageProgress } from "../src/distill/stage-events.js";
import {
  executeOperation,
  FailureBreaker,
  operationSettings,
  reusableOperation,
} from "../src/distill/stage-support.js";
import type { AgentRunner, RunOptions } from "../src/runners/types.js";
import { goldenText } from "./support/text.js";
import { fakeOutput } from "./support/tty.js";

let restoreWriter: FileWriter;
beforeAll(() => {
  restoreWriter = setFileWriter(unflushedWriter);
});
afterAll(() => {
  setFileWriter(restoreWriter);
});

const homes: string[] = [];
function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-engine-"));
  homes.push(dir);
  fs.mkdirSync(path.join(dir, "exports"), { recursive: true });
  return dir;
}
afterEach(() => {
  setFileWriter(unflushedWriter);
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function entry(name: string, origin?: ManifestEntry["origin"]): ManifestEntry {
  return {
    export: name,
    source: `/synthetic/${name}.jsonl`,
    project: "synthetic",
    sessionId: `sid-${name}`,
    messages: 2,
    first_ts: "2026-01-01T00:00:00Z",
    last_ts: "2026-01-01T01:00:00Z",
    ...(origin ? { origin } : {}),
  };
}
function writeExport(home: string, name: string, content = `### t\n\ncontent of ${name}\n`) {
  fs.writeFileSync(path.join(home, "exports", name), content);
}
function sink(): Writable {
  return new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
}
const DIGEST: Digest = {
  goal: "ship the synthetic change",
  deliverable: "a small patch",
  domain: "tooling",
  keywords: ["patch"],
  outcome: "completed",
};
const AUTHORED: Author = {
  slug: "build-fix-work",
  title: "Build fix",
  oneshot_markdown:
    "Fix the build. Keep the change small and verified, explain each decision in plain words, " +
    "and run the existing test suite before reporting back.",
  confidence: "high",
  preferences: [],
};
function digestRunner(calls: { prompts: string[] }): RunnerFn {
  return (async (opts: RunOptions<unknown>) => {
    calls.prompts.push(opts.prompt);
    return DIGEST;
  }) as RunnerFn;
}
function task(slug: string, members: string[]): ClusterTask {
  return { slug, title: `Task ${slug}`, rationale: "same goal", members };
}
function ledger(home: string) {
  return JSON.parse(fs.readFileSync(path.join(home, "distill/operations.json"), "utf8")) as {
    operations: { id: string; kind: string; unitId: string; state: string; attempts: unknown[] }[];
  };
}

/** Counts every replaced file by name and can stop writing at a given write, as a crash would. */
function recordingWriter(crashAt = Number.POSITIVE_INFINITY) {
  const files: string[] = [];
  const writer: FileWriter = {
    replace(file, data) {
      if (files.length >= crashAt) throw new Error("simulated crash");
      files.push(file);
      unflushedWriter.replace(file, data);
    },
  };
  return { writer, files };
}

describe("ledger writes", () => {
  it("saves the index once per transition group: dispatch, result, commit", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    const { writer, files } = recordingWriter();
    setFileWriter(writer);
    await runDigestStage({
      home,
      entries: [entry("a.md")],
      runner: digestRunner({ prompts: [] }),
      output: sink(),
      concurrency: 1,
    });
    const index = files.filter((file) => file.endsWith("distill/operations.json"));
    expect(index).toHaveLength(3);
    // Each file the index refers to is written before the index that refers to it.
    const names = files.map((file) => path.basename(file));
    expect(names.indexOf("input.json")).toBeLessThan(names.indexOf("operations.json"));
    expect(names.indexOf("request.json")).toBeLessThan(names.indexOf("operations.json"));
    expect(names.lastIndexOf("result.json")).toBeLessThan(names.lastIndexOf("digests.json"));
  });

  it("records a blocked unit with one index save and never dispatches it", async () => {
    const home = tmpHome();
    writeExport(home, "big.md", `### t\n\n${"x".repeat(2_000)}\n`);
    const { writer, files } = recordingWriter();
    setFileWriter(writer);
    const calls = { prompts: [] as string[] };
    const result = await runDigestStage({
      home,
      entries: [entry("big.md")],
      runner: digestRunner(calls),
      output: sink(),
      budget: 1_000,
    });
    expect(result.blocked).toEqual([{ export: "big.md", chars: expect.any(Number) }]);
    expect(calls.prompts).toEqual([]);
    expect(files.filter((file) => file.endsWith("operations.json"))).toHaveLength(1);
    expect(ledger(home).operations[0]?.state).toBe("blocked");
    // Same checkpoint shape as before the split: an empty lineage map, not a missing key.
    expect(
      JSON.parse(fs.readFileSync(path.join(home, "distill/digests.json"), "utf8")).lineage,
    ).toEqual({});
  });

  it("opens the ledger without reading recorded files and checks each file on use", () => {
    const home = tmpHome();
    writeExport(home, "a.md", "source");
    const store = new OperationStore(home, "g1");
    const op = store.queue(queued({ unitId: "a.md" }));
    store.flush();
    fs.writeFileSync(path.join(home, op.inputPath), "{ damaged");
    const reopened = new OperationStore(home);
    expect(reopened.list()).toHaveLength(1);
    expect(() => reopened.loadInput(op.id)).toThrow();
    expect(() => reopened.verifyAll()).toThrow();
  });

  it("stores the concrete model beside the plan label for every invocation", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    const runner = (async (opts: RunOptions<unknown>) => {
      opts.onResolved?.({ runner: "codex", model: "gpt-synthetic-terra" });
      return DIGEST;
    }) as RunnerFn;
    await runDigestStage({
      home,
      entries: [entry("a.md")],
      runner,
      runnerName: "claude",
      identityRunner: null,
      model: "balanced/bulk",
      output: sink(),
    });
    const op = new OperationStore(home).list()[0];
    const attempt = op?.attempts[0];
    expect(attempt?.settings).toMatchObject({ automatic: true, model: "balanced/bulk" });
    expect(attempt?.invocations[0]?.resolved).toEqual({
      runner: "codex",
      model: "gpt-synthetic-terra",
    });
    const request = JSON.parse(
      fs.readFileSync(path.join(home, attempt?.invocations[0]?.requestPath ?? ""), "utf8"),
    );
    expect(request.model).toBe("balanced/bulk");
    const lineage = JSON.parse(fs.readFileSync(path.join(home, "distill/digests.json"), "utf8"))
      .lineage["a.md"];
    expect(lineage).toMatchObject({ model: "balanced/bulk", runner: null });
    expect(lineage.resolved).toEqual({ runner: "codex", model: "gpt-synthetic-terra" });
  });

  it("treats an attempt of this process as dead once it is no longer in flight", () => {
    const home = tmpHome();
    writeExport(home, "a.md", "source");
    const store = new OperationStore(home, "g1");
    const op = store.queue(queued({ unitId: "a.md" }));
    const attempt = store.start(op.id);
    expect(attemptOwnerStatus(attempt.owner)).toBe("alive");
    store.fail(op.id, "stopped");
    expect(attemptOwnerStatus(attempt.owner)).toBe("dead");
    expect(attemptOwnerStatus({ ...attempt.owner, token: "never-started-here" })).toBe("dead");
    expect(attemptOwnerStatus({ ...attempt.owner, host: "another-host" })).toBe("unknown");
  });
});

describe("crash at every write", () => {
  // Kill the sequence at each write in turn, then run again normally. Once the
  // result file is on disk the next run must not buy the call again.
  it("digest: recovers to the uninterrupted state, without a model call once the result is saved", async () => {
    const reference = tmpHome();
    writeExport(reference, "a.md");
    const clean = recordingWriter();
    setFileWriter(clean.writer);
    await runDigestStage({
      home: reference,
      entries: [entry("a.md")],
      runner: digestRunner({ prompts: [] }),
      output: sink(),
      generation: "g1",
    });
    const total = clean.files.length;
    expect(total).toBeGreaterThan(6);
    for (let crashAt = 0; crashAt < total; crashAt++) {
      const home = tmpHome();
      writeExport(home, "a.md");
      const crash = recordingWriter(crashAt);
      setFileWriter(crash.writer);
      await runDigestStage({
        home,
        entries: [entry("a.md")],
        runner: digestRunner({ prompts: [] }),
        output: sink(),
        generation: "g1",
      }).catch(() => undefined);
      const resultSaved = crash.files.some((file) => file.endsWith("result.json"));
      setFileWriter(unflushedWriter);
      const calls = { prompts: [] as string[] };
      const again = await runDigestStage({
        home,
        entries: [entry("a.md")],
        runner: digestRunner(calls),
        output: sink(),
        generation: "g1",
      });
      expect({ crashAt, calls: calls.prompts.length }).toEqual({
        crashAt,
        calls: resultSaved ? 0 : 1,
      });
      expect(again.failed).toEqual([]);
      const digests = JSON.parse(fs.readFileSync(path.join(home, "distill/digests.json"), "utf8"));
      expect(digests.digests["a.md"]).toEqual(DIGEST);
      // Nothing left needs inference: strict retry would only repair locally.
      const plan = prepareRetry({ home, handlers: createRetryHandlers(home) });
      expect(plan.modelOperations).toEqual([]);
    }
  });

  it("author: an interrupted publication is finished from the saved result", async () => {
    const setup = (home: string) => {
      writeExport(home, "a.md");
      saveDigests(home, { generation: "g1", prompt_version: DIGEST_PROMPT_VERSION, digests: {} });
    };
    const options = (home: string, runner: RunnerFn) => ({
      home,
      tasks: [task("build-fix-work", ["a.md"])],
      digests: { "a.md": DIGEST },
      entries: [entry("a.md")],
      generation: "g1",
      toolVersion: "0.0.0-test",
      runner,
      output: sink(),
    });
    const authorRunner = (count: { n: number }) =>
      (async () => {
        count.n++;
        return AUTHORED;
      }) as RunnerFn;
    const reference = tmpHome();
    setup(reference);
    const clean = recordingWriter();
    setFileWriter(clean.writer);
    await runAuthorStage(options(reference, authorRunner({ n: 0 })));
    const total = clean.files.length;
    for (let crashAt = 0; crashAt < total; crashAt++) {
      const home = tmpHome();
      setFileWriter(unflushedWriter);
      setup(home);
      const crash = recordingWriter(crashAt);
      setFileWriter(crash.writer);
      await runAuthorStage(options(home, authorRunner({ n: 0 }))).catch(() => undefined);
      const resultSaved = crash.files.some((file) => file.endsWith("result.json"));
      setFileWriter(unflushedWriter);
      const count = { n: 0 };
      const again = await runAuthorStage(options(home, authorRunner(count)));
      expect({ crashAt, calls: count.n }).toEqual({ crashAt, calls: resultSaved ? 0 : 1 });
      expect(again.failed).toEqual([]);
      expect(again.skipped).toEqual([]);
      expect(again.kept).toEqual([]);
      const oneshot = fs.readFileSync(
        path.join(home, "library/build-fix-work/build-fix-work.oneshot.md"),
        "utf8",
      );
      const sources = JSON.parse(
        fs.readFileSync(path.join(home, "library/build-fix-work/sources.json"), "utf8"),
      );
      expect(oneshot).toContain("Fix the build.");
      expect(sources.oneshot_hash).toBeTruthy();
    }
  });
});

describe("durable path", () => {
  it("flushes every replaced file and its folder with the product writer", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    let replaced = 0;
    setFileWriter({
      replace(file, data) {
        replaced++;
        durableWriter.replace(file, data);
      },
    });
    const flush = vi.spyOn(fs, "fsyncSync");
    let flushes = 0;
    try {
      await runDigestStage({
        home,
        entries: [entry("a.md")],
        runner: digestRunner({ prompts: [] }),
        output: sink(),
      });
      flushes = flush.mock.calls.length;
    } finally {
      flush.mockRestore();
    }
    expect(replaced).toBeGreaterThan(0);
    // The file, then its folder, for every replaced file.
    expect(flushes).toBe(replaced * 2);
    const left = fs
      .readdirSync(home, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".tmp"));
    expect(left).toEqual([]);
    expect(fs.statSync(path.join(home, "distill/digests.json")).mode & 0o777).toBe(0o600);
    expect(new OperationStore(home).list()[0]?.state).toBe("committed");
  });
});

function queued(o: Partial<QueueOperation> & { unitId: string }): QueueOperation {
  return {
    kind: "digest",
    generation: "g1",
    runId: "r1",
    promptVersion: DIGEST_PROMPT_VERSION,
    schema: toJsonSchema(DigestResponseSchema),
    logicalInput: { unit: o.unitId },
    sources: [{ path: "exports/a.md", hash: contentFingerprint("source"), length: 6 }],
    settings: operationSettings({ runnerName: "claude", model: "pinned-model" }),
    request: { prompt: "the prompt" },
    ...o,
  };
}

describe("reuse of a saved result", () => {
  function savedOperation(settings = operationSettings({ runnerName: "claude", model: "m" })) {
    const home = tmpHome();
    writeExport(home, "a.md", "source");
    const store = new OperationStore(home, "g1");
    const op = store.queue(queued({ unitId: "a.md", settings }));
    const attempt = store.start(op.id, settings, { prompt: "the prompt" });
    store.recordInvocation(op.id, attempt.id, { prompt: "the prompt" });
    store.saveResult(op.id, attempt.id, { digest: DIGEST });
    return { home, store, op, settings };
  }
  const contract = {
    promptVersion: DIGEST_PROMPT_VERSION,
    schema: toJsonSchema(DigestResponseSchema),
    prompt: "the prompt",
  };

  it("reuses only an exact match of version, schema, prompt, input, and settings", () => {
    const { store, op, settings } = savedOperation();
    const find = (o: {
      contract?: Partial<typeof contract>;
      input?: unknown;
      settings?: typeof settings;
    }) =>
      reusableOperation(
        store,
        "digest",
        "a.md",
        o.input ?? { unit: "a.md" },
        o.settings ?? settings,
        { ...contract, ...o.contract },
      )?.id;
    expect(find({})).toBe(op.id);
    const misses = {
      "prompt version": find({ contract: { promptVersion: DIGEST_PROMPT_VERSION + 1 } }),
      schema: find({ contract: { schema: toJsonSchema(AuthorSchema) } }),
      "prompt text": find({ contract: { prompt: "a different prompt" } }),
      "logical input": find({ input: { unit: "other" } }),
      model: find({ settings: { ...settings, model: "another-model" } }),
      runner: find({ settings: { ...settings, runner: "codex" } }),
    };
    expect(misses).toEqual(Object.fromEntries(Object.keys(misses).map((key) => [key, undefined])));
  });

  it("adopts an automatic result after a CLI switch, but not a pinned one", () => {
    const automatic = operationSettings({
      runnerName: "claude",
      identityRunner: null,
      model: "balanced/bulk",
    });
    const { store, op } = savedOperation(automatic);
    const switched = { ...automatic, runner: "codex" as const };
    expect(
      reusableOperation(store, "digest", "a.md", { unit: "a.md" }, switched, contract)?.id,
    ).toBe(op.id);
    const pinned = { ...switched, automatic: undefined };
    expect(
      reusableOperation(store, "digest", "a.md", { unit: "a.md" }, pinned, contract),
    ).toBeUndefined();
  });

  it("adopts a result whose index save was interrupted, unless its writer is still running", () => {
    const home = tmpHome();
    writeExport(home, "a.md", "source");
    const settings = operationSettings({ runnerName: "claude", model: "m" });
    const store = new OperationStore(home, "g1");
    const op = store.queue(queued({ unitId: "a.md", settings }));
    const attempt = store.start(op.id, settings, { prompt: "the prompt" });
    store.recordInvocation(op.id, attempt.id, { prompt: "the prompt" });
    const index = fs.readFileSync(path.join(home, "distill/operations.json"), "utf8");
    store.saveResult(op.id, attempt.id, { digest: DIGEST });
    // The index never learned about the result, and the attempt is no longer in flight.
    fs.writeFileSync(path.join(home, "distill/operations.json"), index);
    const reopened = new OperationStore(home);
    expect(reopened.list()[0]?.state).toBe("running");
    expect(
      reusableOperation(reopened, "digest", "a.md", { unit: "a.md" }, settings, contract)?.state,
    ).toBe("result-saved");

    const live = tmpHome();
    writeExport(live, "a.md", "source");
    const liveStore = new OperationStore(live, "g1");
    const liveOp = liveStore.queue(queued({ unitId: "a.md", settings }));
    const running = liveStore.start(liveOp.id, settings, { prompt: "the prompt" });
    liveStore.recordInvocation(liveOp.id, running.id, { prompt: "the prompt" });
    fs.mkdirSync(path.join(live, `distill/operations/${liveOp.id}`), { recursive: true });
    fs.writeFileSync(
      path.join(live, `distill/operations/${liveOp.id}/result.json`),
      fs.readFileSync(path.join(home, `distill/operations/${op.id}/result.json`), "utf8"),
    );
    expect(
      reusableOperation(
        new OperationStore(live),
        "digest",
        "a.md",
        { unit: "a.md" },
        settings,
        contract,
      ),
    ).toBeUndefined();
  });
});

describe("one breaker for every stage", () => {
  const streak = (messages: string[]) => {
    const breaker = new FailureBreaker(true);
    for (const message of messages) {
      if (message === "ok") breaker.success();
      else breaker.failure(new Error(message));
    }
    return breaker.reason;
  };
  it.each([
    ["five identical failures", Array(5).fill("same"), true],
    ["four identical failures", Array(4).fill("same"), false],
    ["a success inside the streak", ["same", "same", "ok", "same", "same", "same"], false],
    ["differing messages", ["a", "b", "c", "d", "e", "f"], false],
    ["identical transient errors (already retried by the runner)", Array(5).fill("503"), true],
  ])("%s", (_name, messages, trips) => {
    expect(Boolean(streak(messages as string[]))).toBe(trips);
    const disabled = new FailureBreaker(false);
    for (const message of messages as string[]) disabled.failure(new Error(message));
    expect(disabled.reason).toBeUndefined();
  });

  it.each([
    [5, 5, 0, false],
    [6, 5, 1, true],
  ])("digest stage of %i identical failures: %i calls, %i not attempted", async (total, calls, notAttempted, aborted) => {
    const home = tmpHome();
    const names = Array.from({ length: total }, (_, i) => `s${i}.md`);
    for (const name of names) writeExport(home, name);
    let made = 0;
    const result = await runDigestStage({
      home,
      entries: names.map((name) => entry(name)),
      runner: (async () => {
        made++;
        throw new Error("identical environment failure");
      }) as RunnerFn,
      output: sink(),
      concurrency: 1,
    });
    // A run of five or fewer sessions is never cut short.
    expect(made).toBe(calls);
    expect(result.notAttempted).toHaveLength(notAttempted);
    expect(Boolean(result.aborted)).toBe(aborted);
  });

  it("author stage stops after the streak and lists the tasks it did not attempt", async () => {
    const home = tmpHome();
    const tasks: ClusterTask[] = [];
    for (let i = 0; i < 7; i++) {
      writeExport(home, `m${i}.md`);
      tasks.push(task(`task-number-${i}`, [`m${i}.md`]));
    }
    let made = 0;
    const result = await runAuthorStage({
      home,
      tasks,
      digests: Object.fromEntries(tasks.map((_, i) => [`m${i}.md`, DIGEST])),
      entries: tasks.map((_, i) => entry(`m${i}.md`)),
      generation: "g1",
      toolVersion: "0.0.0-test",
      runner: (async () => {
        made++;
        throw new Error("identical environment failure");
      }) as RunnerFn,
      output: sink(),
      concurrency: 1,
    });
    expect(made).toBe(5);
    expect(result.failed).toHaveLength(5);
    expect(result.notAttempted).toEqual(["task-number-5", "task-number-6"]);
  });
});

describe("strict retry identity", () => {
  /** A pool-like adapter: answers with a concrete CLI and model. */
  function adapter(prompts: string[], value: unknown = DIGEST): AgentRunner {
    return {
      name: "claude",
      installHint: "",
      run: (async (opts: RunOptions<unknown>) => {
        prompts.push(opts.prompt);
        if (opts.model === undefined || opts.model.includes("/"))
          opts.onResolved?.({ runner: "codex", model: "gpt-synthetic-sol" });
        return value;
      }) as AgentRunner["run"],
    } as AgentRunner;
  }
  async function failedDigest(home: string) {
    for (const name of ["a.md", "b.md"]) writeExport(home, name);
    await runDigestStage({
      home,
      entries: [entry("a.md"), entry("b.md")],
      runner: (async (opts: RunOptions<unknown>) => {
        if (opts.prompt.includes("b.md")) throw new Error("synthetic failure for one unit");
        return DIGEST;
      }) as RunnerFn,
      runnerName: "claude",
      identityRunner: null,
      model: "balanced/bulk",
      output: sink(),
    });
  }

  it("a digest written by strict retry in automatic mode is reused by the next normal run", async () => {
    const home = tmpHome();
    await failedDigest(home);
    const handlers = createRetryHandlers(home);
    const plan = prepareRetry({ home, handlers, stage: "digest" });
    expect(plan.modelOperations.map((item) => item.operation.unitId)).toEqual(["b.md"]);
    const prompts: string[] = [];
    const done = await executeRetry(plan, { handlers, getRunner: () => adapter(prompts) });
    expect(done.succeeded).toHaveLength(1);
    expect(prompts).toHaveLength(1);

    const calls = { prompts: [] as string[] };
    const normal = await runDigestStage({
      home,
      entries: [entry("a.md"), entry("b.md")],
      runner: digestRunner(calls),
      runnerName: "codex",
      identityRunner: null,
      model: "balanced/bulk",
      output: sink(),
    });
    expect(calls.prompts).toEqual([]);
    expect(normal.skipped).toBe(2);
    const lineage = JSON.parse(fs.readFileSync(path.join(home, "distill/digests.json"), "utf8"))
      .lineage["b.md"];
    expect(lineage).toMatchObject({ model: "balanced/bulk", runner: null });
    expect(lineage.resolved).toEqual({ runner: "codex", model: "gpt-synthetic-sol" });
  });

  it("--quality best gives best/* settings and a best/* lineage", async () => {
    const home = tmpHome();
    await failedDigest(home);
    const handlers = createRetryHandlers(home);
    const plan = prepareRetry({ home, handlers, quality: "best" });
    expect(plan.modelOperations.map((item) => item.settings.model)).toEqual(["best/bulk"]);
    expect(plan.modelOperations[0]?.settings.automatic).toBe(true);
    await executeRetry(plan, { handlers, getRunner: () => adapter([]) });
    const lineage = JSON.parse(fs.readFileSync(path.join(home, "distill/digests.json"), "utf8"))
      .lineage["b.md"];
    expect(lineage).toMatchObject({ model: "best/bulk", runner: null });
  });

  it("strict attempts record the whole prepared request, as before the split", async () => {
    const home = tmpHome();
    await failedDigest(home);
    const handlers = createRetryHandlers(home);
    const plan = prepareRetry({ home, handlers, stage: "digest" });
    await executeRetry(plan, { handlers, getRunner: () => adapter([]) });
    const op = new OperationStore(home).list().find((item) => item.unitId === "b.md");
    const strict = op?.attempts.at(-1);
    const request = JSON.parse(fs.readFileSync(path.join(home, strict?.requestPath ?? ""), "utf8"));
    expect(Object.keys(request).sort()).toEqual(
      ["content", "lineage", "originalContent", "prompt"].sort(),
    );
    const normal = op?.attempts[0];
    expect(
      Object.keys(JSON.parse(fs.readFileSync(path.join(home, normal?.requestPath ?? ""), "utf8"))),
    ).toEqual(["prompt"]);
  });
});

describe("legacy ledgers", () => {
  // Shapes recorded by 1.8.4: no origin in the manifest, the old tool version
  // in the logical input, no `automatic` marker, no resolved producer.
  function legacyHome(memberOrigin: "claude" | undefined) {
    const home = tmpHome();
    const content = "### t\n\nfix the synthetic build\n";
    writeExport(home, "a.md", content);
    const legacyEntry = entry("a.md");
    fs.writeFileSync(
      path.join(home, "exports/manifest.json"),
      JSON.stringify({ entries: [legacyEntry] }),
    );
    saveDigests(home, {
      generation: "g1",
      prompt_version: DIGEST_PROMPT_VERSION,
      digests: { "a.md": DIGEST },
    });
    const legacyTask = task("build-fix-work", ["a.md"]);
    fs.writeFileSync(
      path.join(home, "distill/tasks.json"),
      JSON.stringify({
        generation: "g1",
        prompt_version: CLUSTER_PROMPT_VERSION,
        tasks: [legacyTask],
        misc: [],
        lineage: { version: 1, fingerprint: "f", model: null, runner: "claude" },
      }),
    );
    const store = new OperationStore(home, "g1");
    const op = store.queue({
      kind: "author",
      unitId: "build-fix-work",
      generation: "g1",
      runId: "legacy-run",
      promptVersion: AUTHOR_PROMPT_VERSION,
      schema: toJsonSchema(AuthorSchema),
      logicalInput: {
        task: legacyTask,
        members: [
          {
            exportName: "a.md",
            digest: DIGEST,
            ...(memberOrigin ? { origin: memberOrigin } : {}),
            contentHash: contentFingerprint(content),
          },
        ],
        entries: [legacyEntry],
        generation: "g1",
        toolVersion: "1.8.4",
        upstream: { "a.md": null },
      },
      sources: [
        { path: "exports/a.md", hash: contentFingerprint(content), length: content.length },
      ],
      settings: {
        runner: "claude",
        model: null,
        timeoutMs: 900_000,
        timeoutExplicit: false,
        budget: DEFAULT_INPUT_BUDGET,
        truncate: "never",
      },
      request: { prompt: "legacy prompt" },
      publication: {
        kind: "author",
        slug: "build-fix-work",
        expectedOneshotHash: null,
        oneshotPath: "library/build-fix-work/build-fix-work.oneshot.md",
        sourcesPath: "library/build-fix-work/sources.json",
      },
    });
    store.start(op.id);
    store.fail(op.id, "interrupted by the old version");
    return { home, op };
  }

  it.each([
    ["a normal-run record", "claude" as const],
    ["a named-recovery record", undefined],
  ])("%s from 1.8.4 still matches and the result carries the running version", async (_name, origin) => {
    const { home, op } = legacyHome(origin);
    const handlers = createRetryHandlers(home);
    const plan = prepareRecovery({
      home,
      operations: prepareTaskRecoveryInputs(home, ["build-fix-work"]),
      handlers,
    });
    expect(plan.blocked).toEqual([]);
    expect(plan.modelOperations.map((item) => item.operation.id)).toEqual([op.id]);
    const prompts: string[] = [];
    await executeRetry(plan, {
      handlers,
      getRunner: () =>
        ({
          name: "claude",
          installHint: "",
          run: (async (opts: RunOptions<unknown>) => {
            prompts.push(opts.prompt);
            return AUTHORED;
          }) as AgentRunner["run"],
        }) as AgentRunner,
    });
    expect(prompts).toHaveLength(1);
    const dir = path.join(home, "library/build-fix-work");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "sources.json"), "utf8")).tool_version).toBe(
      pkg.version,
    );
    expect(fs.readFileSync(path.join(dir, "build-fix-work.oneshot.md"), "utf8")).toContain(
      `generated by human-hindsight v${pkg.version}`,
    );
    expect(new OperationStore(home).list().map((item) => item.id)).toEqual([op.id]);
  });
});

describe("budgets", () => {
  it.each([
    [[10, 10, 1000], 300, [10, 10, 280]],
    [[5, 5, 5], 2, [0, 1, 1]],
    [[10, 20, 30], 1000, [10, 20, 30]],
    [[1000], 300, [300]],
    [[400, 400], 300, [150, 150]],
    [[], 300, []],
  ])("allocateMemberBudgets(%j, %i) = %j", (lengths, budget, expected) => {
    const shares = allocateMemberBudgets(lengths, budget);
    expect(shares).toEqual(expected);
    expect(shares.reduce((sum, share) => sum + share, 0)).toBeLessThanOrEqual(budget);
    shares.forEach((share, i) => {
      expect(share).toBeLessThanOrEqual(lengths[i] ?? 0);
    });
  });

  it("the size gate counts characters, not bytes", async () => {
    const home = tmpHome();
    const content = `### t\n\n${"€".repeat(300_000)}\n`;
    expect(Buffer.byteLength(content)).toBeGreaterThan(DEFAULT_INPUT_BUDGET);
    writeExport(home, "wide.md", content);
    const calls = { prompts: [] as string[] };
    const result = await runDigestStage({
      home,
      entries: [entry("wide.md")],
      runner: digestRunner(calls),
      output: sink(),
      budget: DEFAULT_INPUT_BUDGET,
    });
    expect(result.blocked).toEqual([]);
    expect(result.completed).toBe(1);
    expect(calls.prompts[0]).toContain("€".repeat(1_000));
  });

  it("clustering without a budget plans and records exactly what the default budget does", async () => {
    const run = async (budget?: number) => {
      const home = tmpHome();
      let calls = 0;
      await runClusterStage({
        home,
        digests: { "a.md": DIGEST, "b.md": DIGEST },
        generation: "g1",
        ...(budget === undefined ? {} : { budget }),
        runner: (async () => {
          calls++;
          return {
            tasks: [
              { slug: "build-fix-work", title: "t", rationale: "r", members: ["a.md", "b.md"] },
            ],
            misc: [],
          };
        }) as RunnerFn,
        output: sink(),
      });
      const tasks = JSON.parse(fs.readFileSync(path.join(home, "distill/tasks.json"), "utf8"));
      return { calls, lineage: tasks.lineage, state: ledger(home).operations[0]?.state };
    };
    const omitted = await run();
    expect(omitted).toEqual(await run(DEFAULT_INPUT_BUDGET));
    expect(omitted).toMatchObject({ calls: 1, state: "committed" });
  });
});

describe("clustering over budget", () => {
  it("blocks a window that cannot fit before any call, with the input-budget hint", async () => {
    const home = tmpHome();
    let calls = 0;
    await expect(
      runClusterStage({
        home,
        digests: { "a.md": { ...DIGEST, goal: "g".repeat(3_000) } },
        generation: "g1",
        budget: 1_000,
        runner: (async () => {
          calls++;
          return { tasks: [], misc: ["a.md"] };
        }) as RunnerFn,
        output: sink(),
      }),
    ).rejects.toThrow("cluster prompt exceeds the input budget (1000); increase --input-budget");
    expect(calls).toBe(0);
    expect(ledger(home).operations[0]).toMatchObject({
      kind: "cluster-window",
      state: "blocked",
    });
  });
});

describe("--no-group identity", () => {
  it("records the plan label with a neutral runner, so a CLI switch keeps the grouping", async () => {
    const home = tmpHome();
    const group = (runnerName: "claude" | "codex", model: string) =>
      runClusterStage({
        home,
        digests: { "a.md": DIGEST },
        generation: "g1",
        noGroup: true,
        model,
        runnerName,
        identityRunner: null,
        runner: (async () => {
          throw new Error("--no-group never calls a model");
        }) as RunnerFn,
        output: sink(),
      });
    expect((await group("claude", "balanced/major")).resumed).toBe(false);
    const tasks = JSON.parse(fs.readFileSync(path.join(home, "distill/tasks.json"), "utf8"));
    expect(tasks.lineage).toMatchObject({ model: "balanced/major", runner: null });
    expect((await group("codex", "balanced/major")).resumed).toBe(true);
    expect((await group("codex", "best/major")).resumed).toBe(false);
  });
});

describe("author planning decisions", () => {
  function authorHome() {
    const home = tmpHome();
    writeExport(home, "a.md");
    return home;
  }
  const authorOptions = (home: string, runner: RunnerFn, extra = {}) => ({
    home,
    tasks: [task("build-fix-work", ["a.md"])],
    digests: { "a.md": DIGEST },
    entries: [entry("a.md")],
    generation: "g1",
    toolVersion: "0.0.0-test",
    runner,
    output: sink(),
    ...extra,
  });
  const counting = (count: { n: number }) =>
    (async () => {
      count.n++;
      return AUTHORED;
    }) as RunnerFn;

  it("unreadable provenance counts as absent: an existing prompt is kept, a missing one is never published over it", async () => {
    const kept = authorHome();
    const dir = path.join(kept, "library/build-fix-work");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "sources.json"), "{ hand-broken");
    fs.writeFileSync(path.join(dir, "build-fix-work.oneshot.md"), "my own prompt\n");
    const count = { n: 0 };
    const first = await runAuthorStage(authorOptions(kept, counting(count)));
    expect(count.n).toBe(0);
    expect(first.kept[0]?.reason).toMatch(/no verified generation hash/);
    expect(fs.readFileSync(path.join(dir, "sources.json"), "utf8")).toBe("{ hand-broken");

    const missing = authorHome();
    const other = path.join(missing, "library/build-fix-work");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "sources.json"), "{ hand-broken");
    const result = await runAuthorStage(authorOptions(missing, counting(count)));
    expect(count.n).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(fs.readFileSync(path.join(other, "sources.json"), "utf8")).toBe("{ hand-broken");
    expect(fs.existsSync(path.join(other, "build-fix-work.oneshot.md"))).toBe(false);
    // The paid result is kept for a local repair once the file is fixed.
    expect(ledger(missing).operations[0]?.state).toBe("result-saved");
  });

  it("a blocked task records the prompt it would have sent, and a placeholder prompt is never sent", async () => {
    const home = authorHome();
    writeExport(home, "a.md", `### t\n\n${"y".repeat(2_000)}\n`);
    const count = { n: 0 };
    const result = await runAuthorStage(authorOptions(home, counting(count), { budget: 1_000 }));
    expect(count.n).toBe(0);
    expect(result.failed[0]?.error).toMatch(/exceeds the input budget \(1000\)/);
    const store = new OperationStore(home);
    const op = store.list()[0];
    expect(op?.state).toBe("blocked");
    expect(store.loadInput(op?.id ?? "").request.prompt).toContain("y".repeat(1_500));

    const placeholder = tmpHome();
    writeExport(placeholder, "a.md", "source");
    const ledgerStore = new OperationStore(placeholder, "g1");
    const empty = ledgerStore.queue(queued({ unitId: "a.md", request: { prompt: "" } }));
    let sent = 0;
    const handler: RetryHandler = {
      prepare: (input) => input.request,
      validate: () => undefined,
      run: (request, _settings, _input, invoke) =>
        invoke({ prompt: request.prompt, schema: DigestResponseSchema }),
      publish: () => undefined,
    };
    await expect(
      executeOperation({
        store: ledgerStore,
        operation: empty,
        handler,
        settings: ledgerStore.loadInput(empty.id).settings,
        request: { prompt: "" },
        run: (async () => {
          sent++;
          return DIGEST;
        }) as RunnerFn,
        publish: true,
      }),
    ).rejects.toThrow(/no prepared request/);
    expect(sent).toBe(0);
    expect(ledgerStore.list()[0]?.attempts).toEqual([]);
  });

  it("stale member evidence fails the task before anything is queued", async () => {
    const home = authorHome();
    const stale: Digest = {
      ...DIGEST,
      preferences: [
        {
          text: "Keep changes small.",
          scope: "global",
          basis: "explicit",
          evidence: "said so",
          citations: [{ message_id: "m1", quote: "text that is not in the export" }],
        },
      ] as Digest["preferences"],
    };
    const count = { n: 0 };
    const result = await runAuthorStage({
      ...authorOptions(home, counting(count)),
      digests: { "a.md": stale },
    });
    expect(count.n).toBe(0);
    expect(result.failed[0]?.error).toBe(
      `member preference evidence is stale (a.md); run npx human-hindsight reflect --home=${home} to refresh the session summary`,
    );
    expect(fs.existsSync(path.join(home, "distill/operations.json"))).toBe(false);
  });
});

describe("strict local repair", () => {
  it("finishes a publication interrupted after the result was saved, with no model call", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    saveDigests(home, { generation: "g1", prompt_version: DIGEST_PROMPT_VERSION, digests: {} });
    fs.writeFileSync(
      path.join(home, "distill/tasks.json"),
      JSON.stringify({
        generation: "g1",
        prompt_version: CLUSTER_PROMPT_VERSION,
        tasks: [task("build-fix-work", ["a.md"])],
        misc: [],
      }),
    );
    saveDigests(home, {
      generation: "g1",
      prompt_version: DIGEST_PROMPT_VERSION,
      digests: { "a.md": DIGEST },
    });
    // Stop right after the prompt file is written, before its provenance.
    let crashed = false;
    setFileWriter({
      replace(file, data) {
        if (crashed || file.endsWith("sources.json")) {
          crashed = true;
          throw new Error("simulated crash");
        }
        unflushedWriter.replace(file, data);
      },
    });
    await runAuthorStage({
      home,
      tasks: [task("build-fix-work", ["a.md"])],
      digests: { "a.md": DIGEST },
      entries: [entry("a.md")],
      generation: "g1",
      toolVersion: "0.0.0-test",
      runner: (async () => AUTHORED) as RunnerFn,
      output: sink(),
    }).catch(() => undefined);
    setFileWriter(unflushedWriter);
    const handlers = createRetryHandlers(home);
    const plan = prepareRetry({ home, handlers, stage: "author" });
    expect(plan.modelOperations).toEqual([]);
    expect(plan.localRepairs).toHaveLength(1);
    const done = await executeRetry(plan, {
      handlers,
      getRunner: () => {
        throw new Error("a local repair never needs a runner");
      },
    });
    expect(done.repaired).toHaveLength(1);
    expect(new OperationStore(home).list()[0]?.state).toBe("committed");
    expect(
      JSON.parse(fs.readFileSync(path.join(home, "library/build-fix-work/sources.json"), "utf8"))
        .slug,
    ).toBe("build-fix-work");
  });
});

describe("plain-mode stage output", () => {
  it("prints saved reads, failures and blocks, and counts the reads actually saved", async () => {
    const home = tmpHome();
    for (const name of ["a.md", "b.md", "c.md"]) writeExport(home, name);
    writeExport(home, "big.md", `### t\n\n${"x".repeat(2_000)}\n`);
    const out = fakeOutput({ isTTY: false });
    let tick = 0;
    const progress = startStageProgress(out, "Reading sessions", { now: () => (tick += 250) });
    await runDigestStage({
      home,
      entries: ["a.md", "b.md", "big.md", "c.md"].map((name) => entry(name)),
      runner: (async (opts: RunOptions<unknown>) => {
        if (opts.prompt.includes("b.md")) throw new Error("synthetic failure for one unit");
        return DIGEST;
      }) as RunnerFn,
      output: out,
      progress,
      budget: 1_000,
      concurrency: 1,
    });
    progress.end();
    const text = goldenText(out.raw(), { roots: { [home]: "<HOME>" } });
    await expect(text).toMatchFileSnapshot("./golden/engine/digest-plain.txt");
    expect(text).toContain("2/4 · 1 failed · 1 blocked");
    expect(text).toContain("failed: b.md: synthetic failure for one unit");
    expect(text).not.toContain("a.md ->");
  });

  it("author stage: skips, hand-edit keeps, and failures in plain mode", async () => {
    const home = tmpHome();
    for (const name of ["a.md", "b.md", "c.md"]) writeExport(home, name);
    const edited = path.join(home, "library/task-number-two");
    fs.mkdirSync(edited, { recursive: true });
    fs.writeFileSync(path.join(edited, "task-number-two.oneshot.md"), "my own prompt\n");
    const out = fakeOutput({ isTTY: false });
    let tick = 0;
    const progress = startStageProgress(out, "Writing prompts", { now: () => (tick += 250) });
    await runAuthorStage({
      home,
      tasks: [
        task("task-number-one", ["a.md"]),
        task("task-number-two", ["b.md"]),
        task("task-number-three", ["c.md"]),
      ],
      digests: { "a.md": DIGEST, "b.md": DIGEST, "c.md": { ...DIGEST, outcome: "abandoned" } },
      entries: ["a.md", "b.md", "c.md"].map((name) => entry(name)),
      generation: "g1",
      toolVersion: "0.0.0-test",
      runner: (async () => {
        throw new Error("synthetic failure for one unit");
      }) as RunnerFn,
      output: out,
      progress,
      concurrency: 1,
    });
    progress.end();
    const text = goldenText(out.raw(), { roots: { [home]: "<HOME>" } });
    await expect(text).toMatchFileSnapshot("./golden/engine/author-plain.txt");
    expect(text).toContain("3/3 · 1 failed · 2 skipped");
    expect(text).toContain("failed: task-number-one: synthetic failure for one unit");
  });
});
