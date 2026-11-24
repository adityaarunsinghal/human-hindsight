/**
 * The evaluation record and the retention config change are replaced through
 * the shared atomic helper (flushed temporary, then rename), so a crash never
 * leaves a half-written JSON file. `fsyncSync` is observed, not performed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePaths } from "../src/commands/_shared.js";
import { durableWriter, setFileWriter } from "../src/core/fsutil.js";
import { applyRetentionPlan, planRetention } from "../src/core/retention.js";
import { runEvaluationCli } from "../src/eval/cli.js";
import { evaluationCases } from "../src/eval/prompts.js";
import type { AgentRunner } from "../src/runners/types.js";

let root: string;
// Not the owner-only mode, so a test can see a folder being tightened.
const rootMode = 0o755;
let flushed: number;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-atomic-"));
  fs.chmodSync(root, rootMode);
  flushed = 0;
  // These tests are about the flush itself, so they run on the durable writer.
  // The shared setup puts every other test on the writer that skips it.
  setFileWriter(durableWriter);
  vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
    flushed++;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const quiet = () =>
  new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });

describe("atomic JSON writes", () => {
  it("retention flushes the backup and the replaced settings", () => {
    const dir = path.join(root, "claude");
    fs.mkdirSync(dir);
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, '{"cleanupPeriodDays":30}\n');
    const [plan] = planRetention("claude", resolvePaths({ home: root, "claude-dir": dir }));
    if (!plan) throw new Error("no plan");
    const backup = applyRetentionPlan(plan);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).cleanupPeriodDays).toBeGreaterThan(30);
    expect(fs.readFileSync(backup ?? "", "utf8")).toBe('{"cleanupPeriodDays":30}\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(flushed).toBeGreaterThanOrEqual(2);
  });

  it("retention leaves the permissions of the other tool's folder as they were", () => {
    // The folder belongs to the coding tool, not to us: writing its settings
    // must not tighten a folder the person or the tool set up as shared.
    const dir = path.join(root, "claude");
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o755);
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, '{"cleanupPeriodDays":30}\n');
    const [plan] = planRetention("claude", resolvePaths({ home: root, "claude-dir": dir }));
    if (!plan) throw new Error("no plan");
    applyRetentionPlan(plan);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("the evaluation record is flushed after each case", async () => {
    const fixture = evaluationCases[0];
    if (!fixture) throw new Error("no case");
    const file = path.join(root, "result.json");
    const runner: AgentRunner = {
      name: "claude",
      installHint: "",
      run: async (options) => options.schema.parse(fixture.reference),
    };
    const code = await runEvaluationCli(["--live", "--yes", "--out", file, "--case", fixture.id], {
      output: quiet(),
      resolve: async () => runner,
    });
    expect(code === 0 || code === 1).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).cases).toHaveLength(1);
    expect(fs.readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(flushed).toBeGreaterThanOrEqual(1);
    // `--out` points wherever the person likes; that folder keeps its permissions.
    expect(fs.statSync(root).mode & 0o777).toBe(rootMode);
  });
});
