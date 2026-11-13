import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Built-ins only: exercise the installed CLI with synthetic histories and a
// fake model runner, including the minimum supported Node version.
// Usage: node scripts/smoke-cluster.mjs /absolute/bin/human-hindsight [...binaries]
const binaries = process.argv.slice(2).map((file) => path.resolve(file));
if (!binaries.length) throw new Error("Provide at least one installed CLI path.");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-cluster-"));
const bin = path.join(root, "bin");
fs.mkdirSync(bin);
const fake = path.join(bin, "claude.mjs");
fs.writeFileSync(
  fake,
  `#!${process.execPath}\n` +
    String.raw`import fs from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("--claude-help")) {
  console.log("--output-format --json-schema --tools --safe-mode --system-prompt --strict-mcp-config --mcp-config --settings --disable-slash-commands --no-chrome --no-session-persistence");
  process.exit(0);
}
const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
const prompt = fs.readFileSync(0, "utf8");
const modelIndex = args.indexOf("--model");
const model = modelIndex < 0 ? null : args[modelIndex + 1];
const properties = schema.properties;
const kind = properties.goal ? "digest"
  : properties.oneshot_markdown ? "author"
  : properties.tasks ? "cluster-window"
  : properties.merges ? "cluster-merge" : "unexpected";
const ids = [...prompt.matchAll(/^- id: (.+)$/gm)].map((match) => match[1]);
const slugs = [...prompt.matchAll(/^- slug: (.+)$/gm)].map((match) => match[1]);
const unit = kind === "digest" ? prompt.match(/\(file: ([^)]+)\)/)?.[1]
  : kind === "author" ? prompt.match(/\(slug: ([^)]+)\)/)?.[1]
  : kind === "cluster-window" ? ids.join(",") : slugs.join(",");
fs.appendFileSync(process.env.HH_CLUSTER_LOG, JSON.stringify({kind, model, unit, ids}) + "\n");
if (kind === "unexpected" || !unit) throw new Error("Unexpected synthetic model request");
const label = model === "cluster-first" ? "original"
  : model === "cluster-second" ? "revised"
  : model === "cluster-retry" ? "recovered" : "attempt";
let value;
if (kind === "digest") {
  value = {goal: "Improve " + unit, deliverable: "A reviewed patch", domain: "development",
    keywords: ["build"], outcome: "completed", preferences: []};
} else if (kind === "author") {
  value = {slug: unit, title: "Improve the synthetic build", confidence: "high", preferences: [],
    oneshot_markdown: "Please improve this synthetic build workflow while preserving the existing behavior. Keep the implementation focused, explain the material changes, and verify the result with the relevant tests."};
} else if (kind === "cluster-window") {
  value = process.env.HH_CLUSTER_FAIL_WINDOW && ids.includes(process.env.HH_CLUSTER_FAIL_WINDOW)
    ? {tasks: [], misc: []}
    : {tasks: [{slug: label + "-window-" + ids[0].match(/\d+/)[0],
        title: "Improve the synthetic build", rationale: "These sessions share the same build goal.",
        members: ids}], misc: []};
} else {
  value = {merges: [{slugs, slug: label + "-combined", title: "Improve the synthetic build",
    rationale: "The windows describe the same synthetic build goal."}]};
}
console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, structured_output: value}));
`,
  { mode: 0o755 },
);
fs.symlinkSync("claude.mjs", path.join(bin, "claude"));

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

function seed(home) {
  fs.mkdirSync(path.join(home, "exports"), { recursive: true });
  const entries = Array.from({ length: 4 }, (_, index) => {
    const name = `session-${String(index + 1).padStart(2, "0")}`;
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

function assertModels(calls, clusterModel) {
  for (const call of calls) {
    assert.equal(
      call.model,
      call.kind.startsWith("cluster-") ? clusterModel : "task-default",
      `Wrong model for ${call.kind}: ${JSON.stringify(call)}`,
    );
  }
}

try {
  for (const [index, binary] of binaries.entries()) {
    const scope = path.join(root, String(index));
    const home = path.join(scope, "library");
    const user = path.join(scope, "user");
    const log = path.join(scope, "calls.jsonl");
    seed(home);
    for (const name of [".human-hindsight", ".cc-hindsight"]) {
      fs.mkdirSync(path.join(user, name), { recursive: true });
      fs.writeFileSync(path.join(user, name, "keep.txt"), "Unselected synthetic store.\n");
    }
    const unselected = snapshot(user);
    const env = {
      ...process.env,
      HOME: user,
      USERPROFILE: user,
      XDG_CONFIG_HOME: path.join(scope, "config"),
      XDG_DATA_HOME: path.join(scope, "data"),
      XDG_STATE_HOME: path.join(scope, "state"),
      XDG_CACHE_HOME: path.join(scope, "cache"),
      CLAUDE_CONFIG_DIR: path.join(scope, "claude"),
      CODEX_HOME: path.join(scope, "codex"),
      KIRO_CONFIG_DIR: path.join(scope, "kiro"),
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      NODE_OPTIONS: "",
      NODE_PATH: "",
      HH_CLUSTER_LOG: log,
      HH_CLUSTER_FAIL_WINDOW: "",
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
      const result = spawnSync(process.execPath, [binary, ...args], {
        cwd: scope,
        env: { ...env, ...options.env },
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 2_000_000,
      });
      if (result.error) throw result.error;
      const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      assert.equal(result.status, options.status ?? 0, text);
      assert.doesNotMatch(text, /TypeError|The ["']data["'] argument must be/, text);
      return text;
    };
    const common = ["--home", home, "--no-follow-up"];
    const normal = (model) => [
      "distill",
      ...common,
      "--source=claude",
      "--runner=claude",
      "--model=task-default",
      `--cluster-model=${model}`,
      "--cluster-batch-size=2",
      "--yes",
    ];
    const help = run(["distill", "--help"]);
    assert.match(help, /cluster-model/);
    assert.match(help, /cluster-batch-size/);

    const beforePreview = snapshot(home);
    run([...normal("cluster-first"), "--dry-run"]);
    assert.deepEqual(snapshot(home), beforePreview, "Preview changed the selected library");
    assert.equal(calls().length, 0, "Preview invoked a model");

    run(normal("cluster-first"));
    const first = calls();
    assertModels(first, "cluster-first");
    assert.equal(first.filter((call) => call.kind === "digest").length, 4);
    const windows = first.filter((call) => call.kind === "cluster-window");
    assert.equal(windows.length, 2, "--cluster-batch-size=2 did not split four digests");
    assert(windows.every((call) => call.ids.length === 2));
    assert.deepEqual(windows.flatMap((call) => call.ids).sort(), [
      "session-01.md",
      "session-02.md",
      "session-03.md",
      "session-04.md",
    ]);
    assert.equal(first.filter((call) => call.kind === "cluster-merge").length, 1);
    assert.equal(first.filter((call) => call.kind === "author").length, 1);
    const digests = fs.readFileSync(path.join(home, "distill/digests.json"));
    const oldEntry = path.join(home, "library/original-combined");
    fs.appendFileSync(
      path.join(oldEntry, "original-combined.oneshot.md"),
      "\n\nHuman-edited note: preserve this original prompt.\n",
    );
    fs.writeFileSync(path.join(oldEntry, "notes.md"), "Keep these local notes.\n");
    const oldFiles = snapshot(oldEntry);

    run(normal("cluster-second"));
    const changed = calls().slice(first.length);
    assertModels(changed, "cluster-second");
    assert.equal(changed.filter((call) => call.kind === "digest").length, 0);
    assert.equal(changed.filter((call) => call.kind === "cluster-window").length, 2);
    assert.equal(changed.filter((call) => call.kind === "cluster-merge").length, 1);
    assert.equal(changed.filter((call) => call.kind === "author").length, 1);
    assert.deepEqual(fs.readFileSync(path.join(home, "distill/digests.json")), digests);
    assert.deepEqual(snapshot(oldEntry), oldFiles, "Regrouping changed the old edited entry");
    const revised = path.join(home, "library/revised-combined");
    assert(fs.existsSync(path.join(revised, "revised-combined.oneshot.md")));
    const revisedFiles = snapshot(revised);
    const grouping = fs.readFileSync(path.join(home, "distill/tasks.json"));
    assert.equal(JSON.parse(grouping).tasks[0].slug, "revised-combined");

    const beforeRepeat = calls().length;
    run(normal("cluster-second"));
    assert.equal(calls().length, beforeRepeat, "An unchanged run invoked a model");

    run(normal("cluster-failing"), {
      env: { HH_CLUSTER_FAIL_WINDOW: "session-03.md" },
      status: 1,
    });
    const failed = calls().slice(beforeRepeat);
    assertModels(failed, "cluster-failing");
    assert.deepEqual(
      failed.map((call) => call.kind),
      ["cluster-window", "cluster-window", "cluster-window"],
      "Expected one successful window and one failed window with a corrective retry",
    );
    assert.deepEqual(fs.readFileSync(path.join(home, "distill/tasks.json")), grouping);
    const operationsFile = path.join(home, "distill/operations.json");
    const operation = JSON.parse(fs.readFileSync(operationsFile, "utf8")).operations.find(
      (item) => item.kind === "cluster-window" && item.state === "failed",
    );
    assert(operation, "The invalid window was not recorded for strict retry");

    const retry = [
      "distill",
      ...common,
      "--retry-failed",
      "--retry-stage=cluster",
      "--runner=claude",
      "--model=unused-general-override",
      "--cluster-model=cluster-retry",
      "--yes",
    ];
    const beforeRetry = calls().length;
    const retryPreview = snapshot(home);
    run([...retry, "--dry-run"]);
    assert.deepEqual(snapshot(home), retryPreview, "Retry preview changed the selected library");
    assert.equal(calls().length, beforeRetry, "Retry preview invoked a model");

    run(retry);
    const recovered = calls().slice(beforeRetry);
    assert.equal(recovered.length, 1, "Strict retry did not isolate the failed window");
    assert.equal(recovered[0].kind, "cluster-window");
    assert.equal(recovered[0].model, "cluster-retry");
    assert.deepEqual(recovered[0].ids, ["session-03.md", "session-04.md"]);
    const saved = JSON.parse(fs.readFileSync(operationsFile, "utf8")).operations.find(
      (item) => item.id === operation.id,
    );
    assert.equal(saved.state, "result-saved");
    assert.equal(saved.attempts.at(-1).settings.model, "cluster-retry");
    assert.deepEqual(fs.readFileSync(path.join(home, "distill/tasks.json")), grouping);
    assert.deepEqual(fs.readFileSync(path.join(home, "distill/digests.json")), digests);
    assert.deepEqual(snapshot(oldEntry), oldFiles);
    assert.deepEqual(snapshot(revised), revisedFiles);

    const beforeRetryRepeat = calls().length;
    run(retry);
    assert.equal(calls().length, beforeRetryRepeat, "Completed retry invoked a model again");
    assert.deepEqual(snapshot(user), unselected, "An unselected synthetic store was changed");
    console.log(
      `${path.basename(binary)}: installed cluster models, bounded windows and merge, digest reuse, edited old-task preservation, and strict cluster retry passed.`,
    );
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
