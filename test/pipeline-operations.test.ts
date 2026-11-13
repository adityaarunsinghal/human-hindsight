import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildClusterPrompt } from "../src/claude/prompts/cluster.js";
import type { Digest } from "../src/claude/schemas.js";
import type { ManifestEntry } from "../src/commands/distill.js";
import { OperationStore } from "../src/distill/operations.js";
import {
  createRetryHandlers,
  loadDigests,
  loadTasks,
  planClusterWindows,
  prepareTaskRecoveryInputs,
  type RunnerFn,
  runAuthorStage,
  runClusterStage,
  runDigestStage,
  saveDigests,
  saveTasks,
} from "../src/distill/pipeline.js";
import { executeRetry, prepareRetry } from "../src/distill/retry.js";

const homes: string[] = [];
const output = new Writable({
  write(_chunk, _encoding, next) {
    next();
  },
});
const digest: Digest = {
  goal: "Build the requested feature",
  deliverable: "a feature",
  domain: "code",
  keywords: [],
  outcome: "completed",
  preferences: [],
};
const entry = (name: string): ManifestEntry => ({
  export: name,
  source: `/fixture/${name}`,
  project: "project",
  sessionId: name,
  messages: 2,
  first_ts: "2026-01-01",
  last_ts: "2026-01-01",
});
const task = { slug: "feature-work", title: "Feature", rationale: "same task", members: ["a.md"] };
function home() {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), "hh-operations-"));
  homes.push(result);
  fs.mkdirSync(path.join(result, "exports"));
  fs.writeFileSync(path.join(result, "exports", "a.md"), "### Human\n\nBuild a feature");
  return result;
}
function runner(value: unknown): RunnerFn {
  return (async () => value) as RunnerFn;
}
function execution(home: string, value: unknown) {
  const run = vi.fn(runner(value));
  const handlers = createRetryHandlers(home);
  return {
    handlers,
    run,
    getRunner: () => ({
      name: "claude" as const,
      installHint: "",
      run: run as unknown as RunnerFn,
    }),
  };
}
async function seedAuthoredGrouping(dir: string, fail = false) {
  const generation = "regroup-test";
  const digests = { "a.md": digest };
  saveDigests(dir, { generation, prompt_version: 1, digests });
  await runClusterStage({
    home: dir,
    generation,
    digests,
    runner: runner({ tasks: [task], misc: [] }),
    output,
  });
  await runAuthorStage({
    home: dir,
    generation,
    digests,
    tasks: [task],
    entries: [entry("a.md")],
    toolVersion: "1.8.4",
    runner: fail
      ? ((async () => {
          throw new Error("author unavailable");
        }) as RunnerFn)
      : runner({
          slug: task.slug,
          title: task.title,
          oneshot_markdown:
            "Build the requested feature with clear implementation, meaningful tests, and a complete explanation of the result for future maintainers.",
          confidence: "high",
          preferences: [],
        }),
    output,
  });
  return { generation, digests };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("durable pipeline operations", () => {
  it.each([
    "renamed",
    "misc",
  ] as const)("finishes corrected regrouping when an authored task is %s and preserves its files", async (destination) => {
    const dir = home();
    const { generation, digests } = await seedAuthoredGrouping(dir);
    const library = path.join(dir, "library", task.slug);
    const files = fs.readdirSync(library);
    const before = files.map((file) => fs.readFileSync(path.join(library, file)));
    const regrouped =
      destination === "misc"
        ? { tasks: [], misc: ["a.md"] }
        : { tasks: [{ ...task, slug: "regrouped-feature" }], misc: [] };
    const run = vi
      .fn()
      .mockResolvedValueOnce({ tasks: [], misc: [] })
      .mockResolvedValueOnce(regrouped);

    const result = await runClusterStage({
      home: dir,
      generation,
      digests,
      model: "cluster-upgrade",
      runner: run as RunnerFn,
      output,
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(result.tasks).toEqual(regrouped.tasks);
    expect(result.misc).toEqual(regrouped.misc);
    expect(new OperationStore(dir).list().map((operation) => operation.state)).toEqual([
      "superseded",
      "superseded",
      "committed",
    ]);
    expect(files.map((file) => fs.readFileSync(path.join(library, file)))).toEqual(before);
    expect(prepareRetry({ home: dir, handlers: createRetryHandlers(dir) }).modelOperations).toEqual(
      [],
    );
  });

  it("repairs grouping bookkeeping after publication without repeating a model call", async () => {
    const dir = home();
    const { generation, digests } = await seedAuthoredGrouping(dir);
    const regrouped = { tasks: [{ ...task, slug: "regrouped-feature" }], misc: [] };
    const options = {
      home: dir,
      generation,
      digests,
      model: "cluster-upgrade",
      output,
    };
    const fault = vi.spyOn(OperationStore.prototype, "setState").mockImplementationOnce(() => {
      throw new Error("interrupted after grouping was saved");
    });
    await expect(runClusterStage({ ...options, runner: runner(regrouped) })).rejects.toThrow(
      "interrupted after grouping was saved",
    );
    fault.mockRestore();
    expect(loadTasks(dir)?.tasks).toEqual(regrouped.tasks);

    const run = vi.fn(runner(regrouped));
    const result = await runClusterStage({ ...options, runner: run as RunnerFn });
    expect(result.resumed).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(new OperationStore(dir).list().map((operation) => operation.state)).toEqual([
      "superseded",
      "superseded",
      "committed",
    ]);
  });

  it("reports a removed task clearly when previewing a saved author failure", async () => {
    const dir = home();
    const { generation } = await seedAuthoredGrouping(dir, true);
    saveTasks(dir, {
      generation,
      prompt_version: 1,
      tasks: [{ ...task, slug: "regrouped-feature" }],
      misc: [],
    });
    const plan = prepareRetry({ home: dir, stage: "author", handlers: createRetryHandlers(dir) });
    expect(plan.modelOperations).toEqual([]);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]?.reason).toContain("Saved task definition changed");
  });

  it("records actual failure and strict digest repair never touches the grouping", async () => {
    const dir = home();
    await runDigestStage({
      home: dir,
      entries: [entry("a.md")],
      runnerName: "claude",
      runner: (async () => {
        throw new Error("timeout");
      }) as RunnerFn,
      output,
    });
    const generation = loadDigests(dir)?.generation as string;
    saveTasks(dir, { generation, prompt_version: 1, tasks: [task], misc: [] });
    const before = fs.readFileSync(path.join(dir, "distill", "tasks.json"));
    const options = execution(dir, digest);
    const plan = prepareRetry({
      home: dir,
      handlers: options.handlers,
      overrides: { model: "changed-model" },
    });
    expect(plan.modelOperations.map((item) => item.operation.kind)).toEqual(["digest"]);
    expect(plan.modelOperations[0]?.settings.model).toBe("changed-model");
    await executeRetry(plan, { ...options, output });
    expect(options.run).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(dir, "distill", "tasks.json"))).toEqual(before);
    expect(loadDigests(dir)?.digests["a.md"]).toEqual(digest);
    expect(prepareRetry({ home: dir, handlers: options.handlers }).modelOperations).toHaveLength(0);
  });

  it("records budget blockers without an attempt and makes them runnable only after a larger budget", async () => {
    const dir = home();
    const run = vi.fn(runner(digest));
    await runDigestStage({
      home: dir,
      entries: [entry("a.md")],
      budget: 3,
      runner: run as unknown as RunnerFn,
      output,
    });
    const operation = new OperationStore(dir).list()[0];
    expect(operation?.state).toBe("blocked");
    expect(operation?.attempts).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
    const handlers = createRetryHandlers(dir);
    expect(prepareRetry({ home: dir, handlers }).blocked).toHaveLength(1);
    expect(
      prepareRetry({ home: dir, handlers, overrides: { budget: 1000 } }).modelOperations,
    ).toHaveLength(1);
  });

  it("keeps successful cluster windows, excludes queued windows, and adopts repaired results on a normal run", async () => {
    const dir = home();
    const digests = Object.fromEntries(
      ["a.md", "b.md", "c.md"].map((id) => [id, { ...digest, goal: id + "x".repeat(220) }]),
    );
    const generation = "window-test";
    saveDigests(dir, { generation, prompt_version: 1, digests });
    const budget = buildClusterPrompt({ "a.md": digests["a.md"] as Digest }).length + 30;
    expect(planClusterWindows(digests, undefined, budget).length).toBeGreaterThan(1);
    let calls = 0;
    const firstRunner = (async (options) => {
      calls++;
      if (calls === 2) throw new Error("interrupted window");
      const id = options.prompt.includes("a.md")
        ? "a.md"
        : options.prompt.includes("b.md")
          ? "b.md"
          : "c.md";
      return { tasks: [{ ...task, members: [id] }], misc: [] };
    }) as RunnerFn;
    await expect(
      runClusterStage({
        home: dir,
        generation,
        digests,
        budget,
        runnerName: "claude",
        runner: firstRunner,
        output,
      }),
    ).rejects.toThrow("interrupted window");
    const records = new OperationStore(dir).list();
    expect(records.map((record) => record.state)).toEqual(["result-saved", "failed", "queued"]);
    const options = execution(dir, { tasks: [{ ...task, members: ["b.md"] }], misc: [] });
    const plan = prepareRetry({ home: dir, stage: "cluster", handlers: options.handlers });
    expect(plan.modelOperations).toHaveLength(1);
    await executeRetry(plan, { ...options, output });
    expect(options.run).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(dir, "distill", "tasks.json"))).toBe(false);
    let normalCalls = 0;
    await runClusterStage({
      home: dir,
      generation,
      digests,
      budget,
      runnerName: "claude",
      runner: (async () => {
        normalCalls++;
        return normalCalls === 1
          ? { tasks: [{ ...task, members: ["c.md"] }], misc: [] }
          : { merges: [] };
      }) as RunnerFn,
      output,
    });
    expect(normalCalls).toBe(2); // third window and merge only
  });

  it("saves an author result before publication and repairs a partial write without another call", async () => {
    const dir = home();
    const generation = "author-test";
    saveDigests(dir, { generation, prompt_version: 1, digests: { "a.md": digest } });
    saveTasks(dir, { generation, prompt_version: 1, tasks: [task], misc: [] });
    const authored = {
      slug: task.slug,
      title: "Feature",
      oneshot_markdown:
        "Build the requested feature with clear implementation, meaningful tests, and a complete explanation of the result for future maintainers.",
      confidence: "high",
      preferences: [],
    };
    const rename = fs.renameSync;
    let failPublication = true;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (failPublication && String(to).endsWith("sources.json")) {
        failPublication = false;
        throw new Error("disk unavailable");
      }
      return rename(from, to);
    });
    const result = await runAuthorStage({
      home: dir,
      generation,
      tasks: [task],
      digests: { "a.md": digest },
      entries: [entry("a.md")],
      toolVersion: "1.8.4",
      runnerName: "claude",
      runner: runner(authored),
      output,
    });
    expect(result.failed).toHaveLength(1);
    expect(new OperationStore(dir).list()[0]?.state).toBe("result-saved");
    const options = execution(dir, authored);
    const plan = prepareRetry({ home: dir, handlers: options.handlers });
    expect(plan.localRepairs).toHaveLength(1);
    await executeRetry(plan, { ...options, output });
    expect(options.run).not.toHaveBeenCalled();
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, "library", task.slug, "sources.json"), "utf8"))
        .oneshot_hash,
    ).toBeTruthy();
  });

  it("retains an edit made during authoring", async () => {
    const dir = home();
    const library = path.join(dir, "library", task.slug);
    fs.mkdirSync(library, { recursive: true });
    const authored = {
      slug: task.slug,
      title: "Feature",
      oneshot_markdown:
        "Build the requested feature with clear implementation, meaningful tests, and a complete explanation of the result for future maintainers.",
      confidence: "high",
      preferences: [],
    };
    const first = await runAuthorStage({
      home: dir,
      generation: "author-test",
      tasks: [task],
      digests: { "a.md": digest },
      entries: [entry("a.md")],
      toolVersion: "1.8.4",
      runner: (async () => {
        fs.writeFileSync(
          path.join(library, `${task.slug}.oneshot.md`),
          "human edit during inference",
        );
        return authored;
      }) as RunnerFn,
      output,
    });
    expect(first.failed[0]?.error).toMatch(/human edit kept/);
    expect(fs.readFileSync(path.join(library, `${task.slug}.oneshot.md`), "utf8")).toBe(
      "human edit during inference",
    );
    expect(new OperationStore(dir).list()[0]?.state).toBe("result-saved");
  });

  it("protects provenance-only legacy successes after a prompt was deleted", () => {
    const dir = home();
    saveDigests(dir, { generation: "legacy", prompt_version: 1, digests: { "a.md": digest } });
    saveTasks(dir, { generation: "legacy", prompt_version: 1, tasks: [task], misc: [] });
    const library = path.join(dir, "library", task.slug);
    fs.mkdirSync(library, { recursive: true });
    fs.writeFileSync(
      path.join(library, "sources.json"),
      JSON.stringify({ slug: task.slug, oneshot_hash: "known-success", generation: "legacy" }),
    );
    expect(prepareTaskRecoveryInputs(dir, [task.slug])).toEqual([]);
  });

  it.each([
    ["new-model", 0],
    ["old-model", 1],
  ] as const)("adopts recovered clustering only for its actual latest model (%s)", async (model, expectedCalls) => {
    const dir = home();
    const digests = { "a.md": digest };
    saveDigests(dir, { generation: "model-test", prompt_version: 1, digests });
    await expect(
      runClusterStage({
        home: dir,
        generation: "model-test",
        digests,
        model: "old-model",
        runnerName: "claude",
        output,
        runner: (async () => {
          throw new Error("timeout");
        }) as RunnerFn,
      }),
    ).rejects.toThrow("timeout");
    const cluster = { tasks: [task], misc: [] };
    const options = execution(dir, cluster);
    await executeRetry(
      prepareRetry({ home: dir, handlers: options.handlers, overrides: { model: "new-model" } }),
      { ...options, output },
    );
    const run = vi.fn(runner(cluster));
    await runClusterStage({
      home: dir,
      generation: "model-test",
      digests,
      model,
      runnerName: "claude",
      output,
      runner: run as unknown as RunnerFn,
    });
    expect(run).toHaveBeenCalledTimes(expectedCalls);
  });
});
