import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { beforeEach } from "vitest";

beforeEach(() => {
  for (const key of [
    "HUMAN_HINDSIGHT_RUNNER",
    "HUMAN_HINDSIGHT_MODEL",
    "HUMAN_HINDSIGHT_PROJECT",
    "HUMAN_HINDSIGHT_FOLLOW_UP",
  ])
    delete process.env[key];
});

// Tests that exercise auto-discovery must never find the developer's real stores.
// Each test file gets a nonexistent default root; explicit fixtures still win.
const root = path.join(os.tmpdir(), `hindsight-unpopulated-${randomUUID()}`);
process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
process.env.CODEX_HOME = path.join(root, "codex");
process.env.KIRO_CONFIG_DIR = path.join(root, "kiro");
process.env.HUMAN_HINDSIGHT_OPENCODE_DIR = path.join(root, "opencode");
delete process.env.HUMAN_HINDSIGHT_OPENCODE_DB;
process.env.OPENCODE_CONFIG_DIR = path.join(root, "opencode-config");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.XDG_DATA_HOME = path.join(root, "data");
delete process.env.OPENCODE_DB;
delete process.env.OPENCODE_CONFIG;
delete process.env.OPENCODE_CONFIG_CONTENT;
