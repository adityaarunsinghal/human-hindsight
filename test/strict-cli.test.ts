import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPlan } from "../src/claude/consent.js";
import { ClusterSchema, type Digest } from "../src/claude/schemas.js";
import { type DistillArgs, type ManifestEntry, runDistill } from "../src/commands/distill.js";
import { OperationStore } from "../src/distill/operations.js";
import {
  loadDigests,
  type RunnerFn,
  runClusterStage,
  runDigestStage,
} from "../src/distill/pipeline.js";

const homes: string[] = [];
const digest: Digest = {
  goal: "Improve the build",
  deliverable: "Tested build",
  domain: "tooling",
  keywords: ["build"],
  outcome: "completed",
  preferences: [],
};
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hh-strict-cli-"));
  homes.push(home);
  const entry: ManifestEntry = {
    export: "build-session.md",
    source: "/synthetic/session.jsonl",
    project: "tooling",
    sessionId: "build-session",
    messages: 3,
    first_ts: "2026-11-01T00:00:00Z",
    last_ts: "2026-11-01T00:10:00Z",
  };
  fs.mkdirSync(path.join(home, "exports"));
  fs.writeFileSync(
    path.join(home, "exports", entry.export),
    "### t\n\nImprove this build and verify it.\n",
  );
  let text = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { home, entry, output, text: () => text };
}
async function failedDigest() {
  const f = fixture();
  await runDigestStage({
    home: f.home,
    entries: [f.entry],
    output: f.output,
    runnerName: "claude",
    model: "recorded-model",
    runner: async () => {
      throw new Error("network disconnected");
    },
  });
  return f;
}
async function failedCluster() {
  const f = fixture();
  const result = await runDigestStage({
    home: f.home,
    entries: [f.entry],
    output: f.output,
    runnerName: "claude",
    model: "recorded-digest-model",
    runner: (async () => digest) as RunnerFn,
  });
  await expect(
    runClusterStage({
      home: f.home,
      digests: { [f.entry.export]: digest },
      generation: result.generation,
      output: f.output,
      runnerName: "claude",
      model: "recorded-cluster-model",
      runner: async () => {
        throw new Error("network disconnected");
      },
    }),
  ).rejects.toThrow("network disconnected");
  return f;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("strict retry command contract", () => {
  it.each([
    { "retry-failed": true, fresh: true },
    { "retry-failed": true, force: true },
    { "retry-failed": true, group: true },
    { "retry-failed": true, group: false },
    { "retry-failed": true, source: "claude" },
    { "retry-failed": true, project: "tooling" },
    { "retry-failed": true, "min-substance": "3" },
    { "retry-failed": true, "cluster-batch-size": "50" },
    { "recover-tasks": "build-work", "cluster-batch-size": "50" },
    { "retry-failed": true, "retry-stage": "typo" },
    { "retry-stage": "author" },
    { "retry-failed": true, "recover-tasks": "build-work" },
  ] satisfies DistillArgs[])("rejects incompatible options before reading or spending: %j", async (args) => {
    const f = fixture();
    const runner = vi.fn();
    expect(
      await runDistill({ home: f.home, ...args }, { runner: runner as RunnerFn, output: f.output }),
    ).toBe(1);
    expect(runner).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.home, "distill"))).toBe(false);
  });

  it("does not infer missing history or auto-export", async () => {
    const f = fixture();
    const runner = vi.fn();
    expect(
      await runDistill(
        { home: f.home, "retry-failed": true, yes: true },
        {
          runner: runner as RunnerFn,
          output: f.output,
        },
      ),
    ).toBe(1);
    expect(f.text()).toContain("no recorded failure history");
    expect(fs.existsSync(path.join(f.home, "distill"))).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it("previews without calling a runner, changing the ledger, or creating a lock", async () => {
    const f = await failedDigest();
    const before = fs.readFileSync(path.join(f.home, "distill/operations.json"), "utf8");
    const runner = vi.fn();
    expect(
      await runDistill(
        { home: f.home, "retry-failed": true, "dry-run": true },
        {
          runner: runner as RunnerFn,
          output: f.output,
        },
      ),
    ).toBe(0);
    expect(f.text()).toContain("1 model operation(s)");
    expect(f.text()).toContain("recorded-model");
    expect(f.text()).toContain("timeout 900s");
    expect(runner).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(f.home, "distill/operations.json"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(f.home, "distill/writer.lock"))).toBe(false);
  });

  it("ignores ambient workflow defaults, repairs only the digest, and repeats with zero calls", async () => {
    const f = await failedDigest();
    vi.stubEnv("HUMAN_HINDSIGHT_MODEL", "unexpected-model");
    vi.stubEnv("HUMAN_HINDSIGHT_CLUSTER_MODEL", "unexpected-cluster-model");
    vi.stubEnv("HUMAN_HINDSIGHT_RUNNER", "missing-runner");
    vi.stubEnv("HUMAN_HINDSIGHT_PROJECT", "different-project");
    const runner = vi.fn(async () => digest);
    expect(
      await runDistill(
        { home: f.home, "retry-failed": true, yes: true },
        {
          runner: runner as RunnerFn,
          output: f.output,
        },
      ),
    ).toBe(0);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]).toBeDefined();
    expect(loadDigests(f.home)?.digests[f.entry.export]?.goal).toBe(digest.goal);
    expect(fs.existsSync(path.join(f.home, "distill/tasks.json"))).toBe(false);
    expect(fs.existsSync(path.join(f.home, "library"))).toBe(false);
    expect(f.text()).toContain("recorded-model");
    expect(
      await runDistill(
        { home: f.home, "retry-failed": true, yes: true },
        {
          runner: runner as RunnerFn,
          output: f.output,
        },
      ),
    ).toBe(0);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("ignores ambient cluster model defaults and inherits the recorded cluster model", async () => {
    const f = await failedCluster();
    vi.stubEnv("HUMAN_HINDSIGHT_MODEL", "unexpected-model");
    vi.stubEnv("HUMAN_HINDSIGHT_CLUSTER_MODEL", "unexpected-cluster-model");
    const runner: RunnerFn = vi.fn(async (opts) => {
      expect(opts.schema).toBe(ClusterSchema);
      expect(opts.model).toBe("recorded-cluster-model");
      return {
        tasks: [
          {
            slug: "build-work",
            title: "Build work",
            rationale: "One task",
            members: [f.entry.export],
          },
        ],
        misc: [],
      } as never;
    });
    expect(
      await runDistill(
        { home: f.home, "retry-failed": true, "retry-stage": "cluster", yes: true },
        { runner, output: f.output },
      ),
    ).toBe(0);
    expect(runner).toHaveBeenCalledOnce();
    expect(f.text()).toContain("recorded-cluster-model");
    expect(fs.existsSync(path.join(f.home, "distill/tasks.json"))).toBe(false);
  });

  it("previews the explicit cluster model ahead of a generic override without changing history", async () => {
    const f = await failedCluster();
    const ledger = path.join(f.home, "distill/operations.json");
    const before = fs.readFileSync(ledger, "utf8");
    const runner = vi.fn();
    const confirm = vi.fn(async (plan) => {
      expect(plan.retry.operations).toHaveLength(1);
      expect(plan.retry.operations[0]).toMatchObject({
        kind: "cluster-window",
        model: "new-cluster-model",
      });
      return "dry-run" as const;
    });
    expect(
      await runDistill(
        {
          home: f.home,
          "retry-failed": true,
          model: "new-general-model",
          "cluster-model": "new-cluster-model",
          "dry-run": true,
        },
        { runner: runner as RunnerFn, output: f.output, confirm },
      ),
    ).toBe(0);
    expect(confirm).toHaveBeenCalledOnce();
    expect(runner).not.toHaveBeenCalled();
    expect(fs.readFileSync(ledger, "utf8")).toBe(before);
  });

  it("honors stage selection without starting a missing stage", async () => {
    const f = await failedDigest();
    const runner = vi.fn();
    expect(
      await runDistill(
        { home: f.home, "retry-failed": true, "retry-stage": "author", yes: true },
        {
          runner: runner as RunnerFn,
          output: f.output,
        },
      ),
    ).toBe(0);
    expect(runner).not.toHaveBeenCalled();
    expect(new OperationStore(f.home).list()[0]?.state).toBe("failed");
  });

  it("declines before mutation and reports the exact consented operation list", async () => {
    const f = await failedDigest();
    const before = fs.readFileSync(path.join(f.home, "distill/operations.json"), "utf8");
    const runner = vi.fn();
    const confirm = vi.fn(async (plan) => {
      expect(renderPlan(plan)).toContain("digest build-session.md");
      expect(plan.retry.operations).toHaveLength(1);
      expect(plan.retry.repairs).toHaveLength(0);
      return "declined" as const;
    });
    expect(
      await runDistill(
        { home: f.home, "retry-failed": true },
        {
          runner: runner as RunnerFn,
          output: f.output,
          confirm,
        },
      ),
    ).toBe(2);
    expect(fs.readFileSync(path.join(f.home, "distill/operations.json"), "utf8")).toBe(before);
    expect(runner).not.toHaveBeenCalled();
  });

  it("requires a new preview if the source changes during consent", async () => {
    const f = await failedDigest();
    const runner = vi.fn();
    expect(
      await runDistill(
        { home: f.home, "retry-failed": true },
        {
          runner: runner as RunnerFn,
          output: f.output,
          confirm: async () => {
            fs.writeFileSync(
              path.join(f.home, "exports", f.entry.export),
              "Changed during consent.",
            );
            return "proceed";
          },
        },
      ),
    ).toBe(1);
    expect(runner).not.toHaveBeenCalled();
    expect(f.text()).toContain("changed since preview");
  });
});
