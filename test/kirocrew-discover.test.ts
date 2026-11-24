import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  collectKirocrewSessions,
  discoverKirocrewSessions,
  kirocrewStoreExists,
  parseKirocrewMetadataLine,
} from "../src/sources/kirocrew/discover.js";

// Drive discovery with the synthetic Crew home, never the real ~/.kiro/crew.
const HOME = path.join(import.meta.dirname, "fixtures", "kirocrew-home");

const LIVE = "dashboard_chat-1-1760000000.jsonl";
const ARCHIVE = "dashboard_chat-1-1760000000__20261101-120000.jsonl";
const NO_META = "dashboard_chat-2-1760000100.jsonl";
const CRON = "cron_abc12345.jsonl";
const RECOVERY = "dashboard_setup-recovery-20260101-000000.jsonl";

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

describe("kirocrew discover: which files are sessions", () => {
  const sessions = collectKirocrewSessions(HOME);
  const files = sessions.map((s) => s.file).sort();

  it("collects every *.jsonl under sessions/ and sessions/archive/", () => {
    expect(files).toEqual([ARCHIVE, CRON, LIVE, NO_META, RECOVERY].sort());
  });

  it("skips .lock sidecars, .attachments dirs, dotfiles and the .index dir", () => {
    expect(files.some((f) => f.endsWith(".lock"))).toBe(false);
    expect(files.some((f) => f.startsWith("."))).toBe(false);
    expect(files).not.toContain("stale.jsonl");
    expect(files).not.toContain("dummy.txt");
  });

  it("records absolute paths, including the archive subdirectory", () => {
    const archive = sessions.find((s) => s.file === ARCHIVE);
    expect(archive?.path).toBe(path.join(HOME, "sessions", "archive", ARCHIVE));
    expect(sessions.every((s) => path.isAbsolute(s.path))).toBe(true);
  });

  it("counts entries as non-empty lines (the cheap counter)", () => {
    expect(sessions.find((s) => s.file === ARCHIVE)?.entryCount).toBe(5);
    expect(sessions.find((s) => s.file === LIVE)?.entryCount).toBe(22);
  });

  it("skips the entry count when asked", () => {
    expect(
      collectKirocrewSessions(HOME, { countEntries: false }).every((s) => s.entryCount === 0),
    ).toBe(true);
  });
});

describe("kirocrew discover: metadata line", () => {
  const sessions = collectKirocrewSessions(HOME, { countEntries: false });
  const meta = (file: string) => sessions.find((s) => s.file === file)?.meta;

  it("reads project, title, agent, model and created_at from line 1", () => {
    expect(meta(LIVE)).toEqual({
      cwd: "/proj/widgets",
      title: "Refactor the widget parser",
      agent: "kirocrew",
      model: "test-model",
      createdAt: "2026-01-01T10:00:00.000000+00:00",
    });
  });

  it("yields empty meta when line 1 is not a metadata record", () => {
    expect(meta(NO_META)).toEqual({});
  });

  it("tolerates a corrupt or non-object metadata line", () => {
    expect(parseKirocrewMetadataLine("{not json")).toEqual({});
    expect(parseKirocrewMetadataLine("[1,2]")).toEqual({});
    expect(parseKirocrewMetadataLine('{"_type":"metadata","project":""}')).toEqual({
      cwd: undefined,
      title: undefined,
      agent: undefined,
      model: undefined,
      createdAt: undefined,
    });
  });
});

describe("kirocrew discover: grouping into projects", () => {
  const projects = discoverKirocrewSessions(HOME);
  const byName = new Map(projects.map((p) => [p.shortName, p]));

  it("groups by metadata project, falling back to unknown", () => {
    expect(projects.map((p) => p.shortName).sort()).toEqual(["unknown", "widgets"]);
    expect(
      byName
        .get("widgets")
        ?.sessions.map((s) => s.file)
        .sort(),
    ).toEqual([ARCHIVE, CRON, LIVE].sort());
    expect(
      byName
        .get("unknown")
        ?.sessions.map((s) => s.file)
        .sort(),
    ).toEqual([NO_META, RECOVERY].sort());
  });

  it("keeps the exact project path as the decoded path", () => {
    expect(byName.get("widgets")?.decodedPath).toBe("/proj/widgets");
    expect(byName.get("unknown")?.decodedPath).toBe("unknown");
  });

  it("sums entry counts per project", () => {
    const widgets = byName.get("widgets");
    expect(widgets?.entryTotal).toBe(widgets?.sessions.reduce((n, s) => n + s.entryCount, 0));
    expect(widgets?.entryTotal).toBeGreaterThan(0);
  });
});

describe("kirocrew discover: missing and empty stores", () => {
  it("a missing store yields [] and does not exist", () => {
    const missing = path.join(os.tmpdir(), "hindsight-kirocrew-missing-store");
    expect(discoverKirocrewSessions(missing)).toEqual([]);
    expect(kirocrewStoreExists(missing)).toBe(false);
  });

  it("an empty sessions dir does not count as a store", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-kirocrew-empty-"));
    tmp.push(dir);
    fs.mkdirSync(path.join(dir, "sessions"));
    fs.writeFileSync(path.join(dir, "sessions", "x.jsonl.lock"), "");
    expect(kirocrewStoreExists(dir)).toBe(false);
    expect(discoverKirocrewSessions(dir)).toEqual([]);
  });

  it("an archive-only store counts as a store", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-kirocrew-archive-"));
    tmp.push(dir);
    fs.mkdirSync(path.join(dir, "sessions", "archive"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sessions", "archive", "dashboard_chat-9-1__x.jsonl"), "{}\n");
    expect(kirocrewStoreExists(dir)).toBe(true);
  });

  it("the fixture store exists", () => {
    expect(kirocrewStoreExists(HOME)).toBe(true);
  });
});
