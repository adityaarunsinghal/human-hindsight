import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { setFileWriter, unflushedWriter } from "../src/core/fsutil.js";

// Tests do not wait on real disk flushes: the profile put most of the suite's
// time there. The durable path has its own test, which installs the durable
// writer for its duration; every other test starts on this one.
setFileWriter(unflushedWriter);
beforeEach(() => {
  setFileWriter(unflushedWriter);
});

// No test may reach a real coding CLI by accident. PATH is a fresh empty folder
// per test plus system folders that hold none of the agent commands. A test that
// needs a fake command adds its own folder to PATH or injects a RunnerIo.
const AGENT_BINARIES = ["claude", "codex", "kiro-cli", "opencode"];
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter(
  (dir) => !AGENT_BINARIES.some((name) => fs.existsSync(path.join(dir, name))),
);
let emptyPath: string | undefined;

function isolatePath(): void {
  emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-path-"));
  process.env.PATH = [emptyPath, ...SYSTEM_PATH].join(path.delimiter);
}

// Module-level code in a test file runs before its first hook.
isolatePath();
beforeEach(() => {
  if (emptyPath) fs.rmSync(emptyPath, { recursive: true, force: true });
  isolatePath();
});
afterEach(() => {
  if (emptyPath) fs.rmSync(emptyPath, { recursive: true, force: true });
  emptyPath = undefined;
});

beforeEach(() => {
  for (const key of [
    "HUMAN_HINDSIGHT_RUNNER",
    "HUMAN_HINDSIGHT_MODEL",
    "HUMAN_HINDSIGHT_PROJECT",
    "HUMAN_HINDSIGHT_FOLLOW_UP",
    "HUMAN_HINDSIGHT_SUBAGENT_MODEL",
    // History folder selections carried between commands in one process.
    "HUMAN_HINDSIGHT_CLAUDE_DIR",
    "HUMAN_HINDSIGHT_CODEX_DIR",
    "HUMAN_HINDSIGHT_KIRO_DIR",
  ])
    delete process.env[key];
});

// Tests that exercise auto-discovery must never find the developer's real stores.
// Each test file gets a nonexistent default root; explicit fixtures still win.
const root = path.join(os.tmpdir(), `hindsight-unpopulated-${randomUUID()}`);
process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
process.env.CODEX_HOME = path.join(root, "codex");
process.env.KIRO_CONFIG_DIR = path.join(root, "kiro");
process.env.HUMAN_HINDSIGHT_KIROCREW_DIR = path.join(root, "kirocrew");
process.env.HUMAN_HINDSIGHT_OPENCODE_DIR = path.join(root, "opencode");
delete process.env.HUMAN_HINDSIGHT_OPENCODE_DB;
process.env.OPENCODE_CONFIG_DIR = path.join(root, "opencode-config");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.XDG_DATA_HOME = path.join(root, "data");
delete process.env.OPENCODE_DB;
delete process.env.OPENCODE_CONFIG;
delete process.env.OPENCODE_CONFIG_CONTENT;
