import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Built-ins only: run against real installed commands, including minimum Node.
// Usage: node scripts/smoke-retry.mjs /absolute/bin/human-hindsight [...binaries]
const binaries = process.argv.slice(2).map((file) => path.resolve(file));
if (!binaries.length) throw new Error("Provide at least one installed CLI path.");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-retry-"));
const bin = path.join(root, "bin");
fs.mkdirSync(bin);
const fake = path.join(bin, "claude");
fs.writeFileSync(
  fake,
  `#!${process.execPath}
import fs from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("--claude-help")) {
  console.log("--output-format --json-schema --tools --safe-mode --system-prompt --strict-mcp-config --mcp-config --settings --disable-slash-commands --no-chrome --no-session-persistence");
  process.exit(0);
}
const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
const prompt = fs.readFileSync(0, "utf8");
const kind = schema.properties.goal ? "digest" : schema.properties.oneshot_markdown ? "author" : "unexpected";
const unit = kind === "digest" ? prompt.match(/\\(file: ([^)]+)\\)/)?.[1] : prompt.match(/\\(slug: ([^)]+)\\)/)?.[1];
fs.appendFileSync(process.env.HH_RETRY_LOG, JSON.stringify({kind, unit}) + "\\n");
if (kind === "unexpected" || !unit) throw new Error("Unexpected synthetic model request");
if (process.env.HH_RETRY_FAIL === "initial" &&
    ((kind === "digest" && unit === "digest-fail.md") || (kind === "author" && unit === "author-fail"))) {
  console.error("Synthetic failed operation");
  process.exit(1);
}
const value = kind === "digest"
  ? {goal: "Improve " + unit, deliverable: "A reviewed patch", domain: "development", keywords: ["test"], outcome: "completed", preferences: []}
  : {slug: unit, title: "Improve " + unit, confidence: "high", preferences: [],
     oneshot_markdown: "Please improve this synthetic build workflow while preserving its existing behavior. Keep the implementation focused, explain the changes, and verify the result with the relevant tests."};
console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, structured_output: value}));
`,
  { mode: 0o755 },
);
// The .mjs target gives an executable without depending on package discovery.
fs.renameSync(fake, `${fake}.mjs`);
fs.symlinkSync("claude.mjs", fake);
const fault = path.join(root, "crash-after-result.mjs");
fs.writeFileSync(
  fault,
  `import fs from "node:fs";
const rename = fs.renameSync;
fs.renameSync = function (from, to) {
  const result = rename.apply(this, arguments);
  if (String(to).endsWith("/result.json")) process.kill(process.pid, "SIGKILL");
  return result;
};
`,
);

function snapshot(directory) {
  if (!fs.existsSync(directory)) return {};
  const result = {};
  for (const file of fs.readdirSync(directory, { recursive: true }).sort()) {
    const full = path.join(directory, file);
    const info = fs.lstatSync(full);
    result[file] = info.isDirectory()
      ? { directory: true, mode: info.mode }
      : {
          hash: createHash("sha256").update(fs.readFileSync(full)).digest("hex"),
          mtime: info.mtimeMs,
          mode: info.mode,
        };
  }
  return result;
}
function seed(home, names) {
  fs.mkdirSync(path.join(home, "exports"), { recursive: true });
  const entries = names.map((name) => {
    const file = `${name}.md`;
    fs.writeFileSync(
      path.join(home, "exports", file),
      `# Synthetic ${name}\n\n### 2026-11-01T12:00:00Z\n\nPlease improve the build workflow, preserve existing behavior, and verify the patch with focused tests.\n`,
    );
    return {
      export: file,
      source: `/synthetic/${name}.jsonl`,
      project: "synthetic",
      sessionId: name,
      messages: 3,
      first_ts: "2026-11-01T12:00:00Z",
      last_ts: "2026-11-01T12:01:00Z",
      origin: "claude",
    };
  });
  fs.writeFileSync(path.join(home, "exports/manifest.json"), JSON.stringify(entries));
}
try {
  for (const [index, binary] of binaries.entries()) {
    const scope = path.join(root, String(index));
    const home = path.join(scope, "home");
    const log = path.join(scope, "calls.jsonl");
    fs.mkdirSync(scope);
    seed(home, ["saved-success", "digest-fail", "author-fail"]);
    const env = {
      ...process.env,
      HOME: path.join(scope, "user"),
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      HH_RETRY_LOG: log,
      NO_COLOR: "1",
    };
    for (const key of Object.keys(env)) {
      if (key.startsWith("HUMAN_HINDSIGHT_") || key.startsWith("CC_HINDSIGHT_")) delete env[key];
    }
    const calls = () =>
      fs.existsSync(log)
        ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
        : [];
    const run = (args, options = {}) => {
      const result = spawnSync(
        process.execPath,
        [...(options.crash ? ["--import", pathToFileURL(fault).href] : []), binary, ...args],
        {
          cwd: scope,
          env: { ...env, ...options.env },
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 2_000_000,
        },
      );
      const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      if (options.crash) assert.equal(result.signal, "SIGKILL", text);
      else assert.equal(result.status, options.status ?? 0, text);
      return text;
    };
    const common = ["--home", home, "--no-follow-up"];
    const retry = ["distill", "--retry-failed", ...common];
    assert.match(run(["distill", "--help"]), /retry-failed/);
    assert.match(run(["distill", "--help"]), /recover-tasks/);
    run(["distill", "--retry-stage=author", ...common], { status: 1 });
    run(["distill", "--runner=claude", "--no-group", "--yes", ...common], {
      env: { HH_RETRY_FAIL: "initial" },
      status: 1,
    });
    const ledger = JSON.parse(fs.readFileSync(path.join(home, "distill/operations.json")));
    assert(ledger.operations.some((op) => op.kind === "digest" && op.state === "failed"));
    assert(ledger.operations.some((op) => op.kind === "author" && op.state === "failed"));
    const grouping = fs.readFileSync(path.join(home, "distill/tasks.json"));
    const successful = snapshot(path.join(home, "library/saved-success"));
    assert(Object.keys(successful).length > 0);
    const beforeDry = snapshot(home);
    const beforeCalls = calls().length;
    run([...retry, "--dry-run"]);
    assert.deepEqual(snapshot(home), beforeDry, "Dry run changed the data home");
    assert.equal(calls().length, beforeCalls);
    const lock = path.join(home, "distill/writer.lock");
    fs.mkdirSync(lock);
    fs.writeFileSync(
      path.join(lock, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        host: os.hostname(),
        token: "synthetic-live-writer",
        startedAt: new Date().toISOString(),
      }),
    );
    const withLock = snapshot(home);
    run([...retry, "--yes"], { status: 1 });
    assert.deepEqual(snapshot(home), withLock, "Retry changed a live writer's files");
    assert.equal(calls().length, beforeCalls);
    fs.rmSync(lock, { recursive: true });
    run([...retry, "--retry-stage=digest", "--yes"]);
    assert.deepEqual(calls().slice(beforeCalls), [{ kind: "digest", unit: "digest-fail.md" }]);
    assert.deepEqual(fs.readFileSync(path.join(home, "distill/tasks.json")), grouping);
    assert.deepEqual(snapshot(path.join(home, "library/saved-success")), successful);
    const beforeAuthor = calls().length;
    run([...retry, "--retry-stage=author", "--yes"]);
    assert.deepEqual(calls().slice(beforeAuthor), [{ kind: "author", unit: "author-fail" }]);
    assert.deepEqual(fs.readFileSync(path.join(home, "distill/tasks.json")), grouping);
    assert.deepEqual(snapshot(path.join(home, "library/saved-success")), successful);
    const beforeRepeat = calls().length;
    run([...retry, "--yes"]);
    assert.equal(calls().length, beforeRepeat, "Completed retry invoked a model again");

    const legacy = path.join(scope, "legacy");
    fs.cpSync(home, legacy, { recursive: true });
    fs.rmSync(path.join(legacy, "distill/operations.json"));
    fs.rmSync(path.join(legacy, "distill/operations"), { recursive: true });
    fs.rmSync(path.join(legacy, "library/author-fail"), { recursive: true });
    fs.appendFileSync(
      path.join(legacy, "exports/author-fail.md"),
      "Synthetic input. ".repeat(27_000),
    );
    const legacyArgs = ["distill", "--home", legacy, "--no-follow-up", "--runner=claude"];
    const beforeUnknown = snapshot(legacy);
    run([...legacyArgs, "--recover-tasks=author-fail,unknown-task", "--yes"], { status: 1 });
    assert.deepEqual(snapshot(legacy), beforeUnknown);
    assert.equal(calls().length, beforeRepeat);
    run([...legacyArgs, "--recover-tasks=author-fail", "--dry-run"]);
    assert.deepEqual(snapshot(legacy), beforeUnknown);
    run([...legacyArgs, "--recover-tasks=author-fail", "--yes"], { status: 1 });
    assert.deepEqual(snapshot(legacy), beforeUnknown, "Budget refusal changed the legacy home");
    assert.equal(calls().length, beforeRepeat);
    const legacyGrouping = fs.readFileSync(path.join(legacy, "distill/tasks.json"));
    run([...legacyArgs, "--recover-tasks=author-fail", "--yes", "--input-budget=600000"]);
    assert.deepEqual(calls().slice(beforeRepeat), [{ kind: "author", unit: "author-fail" }]);
    assert.deepEqual(fs.readFileSync(path.join(legacy, "distill/tasks.json")), legacyGrouping);

    const interrupted = path.join(scope, "interrupted");
    seed(interrupted, ["crash-task"]);
    run(
      [
        "distill",
        "--home",
        interrupted,
        "--runner=claude",
        "--no-group",
        "--yes",
        "--no-follow-up",
      ],
      {
        crash: true,
      },
    );
    const crashCalls = calls().length;
    const crashBefore = snapshot(interrupted);
    run(["distill", "--home", interrupted, "--retry-failed", "--retry-stage=digest", "--dry-run"]);
    assert.deepEqual(snapshot(interrupted), crashBefore);
    run(["distill", "--home", interrupted, "--retry-failed", "--retry-stage=digest", "--yes"]);
    assert.equal(calls().length, crashCalls, "Saved crash result caused duplicate inference");
    assert(!fs.existsSync(path.join(interrupted, "distill/tasks.json")));
    assert(
      JSON.parse(fs.readFileSync(path.join(interrupted, "distill/digests.json"))).digests[
        "crash-task.md"
      ],
    );
    console.log(
      `${path.basename(binary)}: installed strict retry, stage isolation, read-only preview, named recovery and crash-result repair passed.`,
    );
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
