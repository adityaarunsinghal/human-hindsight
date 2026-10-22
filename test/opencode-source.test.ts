import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";
import { runMain } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderPlan } from "../src/claude/consent.js";
import { runExport } from "../src/commands/export.js";
import { resolveTarget } from "../src/commands/preferences.js";
import { runRetention } from "../src/commands/retention.js";
import { main } from "../src/main.js";
import { opencodeSource } from "../src/sources/opencode/index.js";
import { resolveOpenCodePaths } from "../src/sources/opencode/paths.js";
import { discoverOpenCode, openOpenCodeDatabase } from "../src/sources/opencode/store.js";
import { parseSourceMode, resolveSources } from "../src/sources/registry.js";

let root: string;
let file: string;
let db: DatabaseSync;
const output = new Writable({
  write(_chunk, _encoding, next) {
    next();
  },
});
const now = Date.UTC(2026, 9, 20, 10);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-opencode-source-"));
  file = path.join(root, "opencode.db");
  db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, title TEXT, parent_id TEXT, time_updated INTEGER, revert TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT);
    CREATE TABLE session_v2(id TEXT PRIMARY KEY, directory TEXT, title TEXT, parent_id TEXT, time_updated INTEGER, revert TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER, type TEXT, time_created INTEGER, data TEXT);
  `);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function session(
  id: string,
  version: 1 | 2,
  parent: string | null = null,
  directory = "/work/project",
) {
  db.prepare(
    `INSERT INTO ${version === 1 ? "session" : "session_v2"} VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(id, directory, "Human task", parent, now);
}
function user(id: string, sessionID: string, version: 1 | 2, text: string, offset = 0) {
  const time = now + offset;
  if (version === 1) {
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
      id,
      sessionID,
      time,
      JSON.stringify({ role: "user", time: { created: time } }),
    );
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run(
      `prt_${id}`,
      sessionID,
      id,
      JSON.stringify({ type: "text", text }),
    );
  } else {
    db.prepare("INSERT INTO session_message VALUES (?, ?, ?, 'user', ?, ?)").run(
      id,
      sessionID,
      offset,
      time,
      JSON.stringify({ text, time: { created: time } }),
    );
  }
}
function exportedHome() {
  return path.join(root, "hindsight");
}

describe("OpenCode source stores", () => {
  it("honors directory and database flags before or after the subcommand", async () => {
    session("ses_cli", 2);
    user("msg_cli", "ses_cli", 2, "CLI fixture");
    vi.stubEnv("HUMAN_HINDSIGHT_HOME", "");
    vi.stubEnv("HUMAN_HINDSIGHT_OPENCODE_DIR", "");
    vi.stubEnv("HUMAN_HINDSIGHT_OPENCODE_DB", "");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const rawArgs = [
      "--home",
      exportedHome(),
      "--opencode-dir",
      root,
      "--opencode-db",
      "opencode.db",
    ];
    for (const args of [
      [...rawArgs, "scan", "--source", "opencode"],
      ["scan", ...rawArgs, "--source", "opencode"],
    ]) {
      await runMain(main, { rawArgs: args });
      expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain("1 sessions");
    }
  });

  it("keeps retention advisory and targets AGENTS.md for OpenCode", async () => {
    const config = path.join(root, "config");
    fs.mkdirSync(config);
    const text = '{"compaction":{"auto":true,"prune":true},"private":"do-not-print"}';
    fs.writeFileSync(path.join(config, "opencode.json"), text);
    vi.stubEnv("OPENCODE_CONFIG_DIR", config);
    let stdout = "";
    const sink = new Writable({
      write(chunk, _enc, next) {
        stdout += chunk.toString();
        next();
      },
    });
    expect(
      await runRetention(
        { source: "opencode", "opencode-dir": root, apply: true, yes: true },
        { output: sink },
      ),
    ).toBe(0);
    expect(fs.readFileSync(path.join(config, "opencode.json"), "utf8")).toBe(text);
    expect(fs.readdirSync(config)).toEqual(["opencode.json"]);
    expect(stdout).toContain("no supported full-session");
    expect(stdout).not.toContain("do-not-print");
    expect(resolveTarget("opencode", "auto")).toBe("agents");
    expect(resolveTarget(undefined, "opencode")).toBe("agents");
    expect(
      renderPlan({ digests: 1, cluster: 0, authorEstimate: 1, runnerName: "opencode" }),
    ).toContain("your configured provider account");
  });

  it("reads both schemas without a CLI, uses stored ordering, and separates database session identities", () => {
    session("ses_v1", 1);
    user("msg_b", "ses_v1", 1, "second", 2);
    user("msg_a", "ses_v1", 1, "first", 1);
    session("ses_v2", 2, null, "/work/another/project");
    user("msg_new2", "ses_v2", 2, "new second", 4);
    user("msg_new1", "ses_v2", 2, "new first", 3);
    const source = opencodeSource(root, file);
    try {
      const projects = source.discover();
      expect(projects.map((p) => p.shortName)).toEqual(["project", "project-2"]);
      expect(projects.reduce((sum, p) => sum + p.entryTotal, 0)).toBe(4);
      const sessions = projects.flatMap((p) => p.sessions);
      expect(new Set(sessions.map((s) => s.key)).size).toBe(2);
      for (const item of sessions) {
        const lines = source.read?.(item) ?? [];
        const messages = source.extract(lines).messages;
        expect(
          source
            .timeline(lines)
            .filter((e) => e.kind === "human")
            .map(({ timestamp, text }) => ({ timestamp, text })),
        ).toEqual(messages);
        expect(messages.map((m) => m.text)).toEqual(
          item.id === "ses_v1" ? ["first", "second"] : ["new first", "new second"],
        );
      }
    } finally {
      source.dispose?.();
    }
    expect(parseSourceMode("OPENCODE")).toBe("opencode");
    expect(
      resolveSources("auto", {
        claudeDir: path.join(root, "absent-claude"),
        codexDir: path.join(root, "absent-codex"),
        kiroDir: path.join(root, "absent-kiro"),
        opencodeDir: root,
      }).map((s) => s.name),
    ).toEqual(["opencode"]);
  });

  it("exports multiple sessions from one database with their own timelines and origin", () => {
    session("ses_one", 2);
    user("msg_one", "ses_one", 2, "Build a parser", 1);
    session("ses_two", 2);
    user("msg_two", "ses_two", 2, "Build a viewer", 2);
    const stats = runExport({
      home: exportedHome(),
      "opencode-dir": root,
      source: "opencode",
      output,
    });
    expect(stats.exportedSessions).toBe(2);
    expect(stats.sessionsByOrigin).toEqual({ opencode: 2 });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(exportedHome(), "exports/manifest.json"), "utf8"),
    );
    expect(manifest.every((e: { origin: string }) => e.origin === "opencode")).toBe(true);
    expect(new Set(manifest.map((e: { source: string }) => e.source)).size).toBe(2);
  });

  it("deduplicates migrated messages while preserving divergent legacy turns and interactive forks", () => {
    session("ses_migrated", 1);
    session("ses_migrated", 2);
    user("msg_copy", "ses_migrated", 1, "Shared prompt", 1);
    user("msg_copy", "ses_migrated", 2, "Shared prompt", 1);
    user("msg_legacy", "ses_migrated", 1, "Later legacy input", 2);
    session("ses_fork", 2);
    user("msg_fork", "ses_fork", 2, "Fork follow-up", 3);
    session("ses_child", 2, "ses_fork");
    user("msg_child", "ses_child", 2, "Generated subagent prompt", 4);
    const stats = runExport({
      home: exportedHome(),
      "opencode-dir": root,
      source: "opencode",
      output,
    });
    expect(stats.totalMessages).toBe(3);
    expect(stats.duplicatesDropped).toBe(1);
    expect(stats.automationSkipped).toBe(1);
  });

  it("reads committed WAL data and never permits database writes", () => {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    session("ses_wal", 2);
    user("msg_wal", "ses_wal", 2, "Still running", 1);
    expect(fs.existsSync(`${file}-wal`)).toBe(true);
    expect(discoverOpenCode(root, file)[0]?.entryTotal).toBe(1);
    const reader = openOpenCodeDatabase(file);
    try {
      expect(() => reader.exec("DELETE FROM session_v2")).toThrow();
    } finally {
      reader.close();
    }
    expect(db.prepare("SELECT count(*) n FROM session_v2").get()?.n).toBe(1);
  });

  it.each([
    "unknown-schema",
    "migration",
    "locked",
  ] as const)("preserves previous exports when the store is %s", (failure) => {
    const dir = path.join(exportedHome(), "exports");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "keep.md"), "previous prompts");
    fs.writeFileSync(path.join(dir, "manifest.json"), '[{"export":"keep.md"}]\n');
    if (failure === "unknown-schema") db.exec("DROP TABLE session_message");
    if (failure === "migration")
      db.exec(
        `CREATE TABLE kv(key TEXT, value TEXT); INSERT INTO kv VALUES ('migration.v1-v2', '{"phase":"sessions"}')`,
      );
    if (failure === "locked") db.exec("BEGIN EXCLUSIVE");
    try {
      expect(() =>
        runExport({ home: exportedHome(), "opencode-dir": root, source: "auto", output }),
      ).toThrow(/Cannot read OpenCode store/);
    } finally {
      if (failure === "locked") db.exec("ROLLBACK");
    }
    expect(fs.readFileSync(path.join(dir, "keep.md"), "utf8")).toBe("previous prompts");
    expect(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).toBe(
      '[{"export":"keep.md"}]\n',
    );
  });

  it("tolerates corrupt record payloads and respects revert boundaries", () => {
    session("ses_corrupt", 2);
    user("msg_ok", "ses_corrupt", 2, "Keep this", 1);
    db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)").run(
      "msg_bad",
      "ses_corrupt",
      2,
      "user",
      now + 2,
      "{private malformed data",
    );
    user("msg_undo", "ses_corrupt", 2, "Undone", 3);
    db.prepare("UPDATE session_v2 SET revert=? WHERE id=?").run(
      '{"messageID":"msg_undo"}',
      "ses_corrupt",
    );
    const stats = runExport({
      home: exportedHome(),
      "opencode-dir": root,
      source: "opencode",
      output,
    });
    expect(stats.badLines).toBe(1);
    expect(stats.totalMessages).toBe(1);
  });

  it("recovers the older JSON layout and ignores symlinked transcript files", () => {
    const write = (relative: string, value: unknown) => {
      const target = path.join(root, "storage", relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(value));
    };
    write("session/project/ses_json.json", {
      id: "ses_json",
      directory: "/work/old",
      time: { updated: now },
    });
    write("message/ses_json/msg_1.json", { id: "msg_1", role: "user", time: { created: now } });
    write("part/msg_1/prt_1.json", { id: "prt_1", type: "text", text: "Legacy request" });
    fs.symlinkSync("ses_json.json", path.join(root, "storage/session/project/duplicate.json"));
    const stats = runExport({
      home: exportedHome(),
      "opencode-dir": root,
      source: "opencode",
      output,
    });
    expect(stats.totalMessages).toBe(1);
  });

  it("does not create missing stores or try to read in-memory history", () => {
    expect(
      discoverOpenCode(path.join(root, "absent"), path.join(root, "absent/opencode.db")),
    ).toEqual([]);
    expect(fs.existsSync(path.join(root, "absent"))).toBe(false);
    expect(discoverOpenCode(root, ":memory:")).toEqual([]);
  });
});

describe("OpenCode path resolution", () => {
  it("separates config and data and respects explicit database paths", () => {
    expect(resolveOpenCodePaths({}, {}, "/person")).toEqual({
      opencodeDir: "/person/.local/share/opencode",
      opencodeDb: "/person/.local/share/opencode/opencode.db",
      opencodeConfigDir: "/person/.config/opencode",
    });
    expect(
      resolveOpenCodePaths(
        { dir: "/custom", db: "other.db" },
        {
          XDG_DATA_HOME: "/xdg",
          OPENCODE_DB: "/ignored.db",
          OPENCODE_CONFIG_DIR: "/settings",
        },
      ).opencodeDb,
    ).toBe("/custom/other.db");
    expect(
      resolveOpenCodePaths({}, { XDG_DATA_HOME: "/xdg", OPENCODE_DB: "next.db" }).opencodeDb,
    ).toBe("/xdg/opencode/next.db");
  });
});
