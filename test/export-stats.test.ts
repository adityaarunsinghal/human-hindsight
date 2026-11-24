import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runExport } from "../src/commands/export.js";
import {
  EXPORT_STATS_FILE,
  EXPORT_STATS_VERSION,
  readExportStats,
  SavedExportStatsSchema,
} from "../src/core/export-stats.js";

/**
 * exports/export-stats.json: the last export's summary counts, saved so
 * `status` can report the K15 hand-off without re-reading the kiro store.
 * Every store here is a synthetic fixture.
 */
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const CLAUDE_HOME = path.join(FIXTURES, "export-home");
const KIRO_CREW_V3_HOME = path.join(FIXTURES, "kiro-home-v3-crew");
const KIROCREW_HOME = path.join(FIXTURES, "kirocrew-home");

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
function freshHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "human-hindsight-export-stats-"));
  homes.push(home);
  return home;
}
const sink = () =>
  new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
const statsFile = (home: string) => path.join(home, "exports", EXPORT_STATS_FILE);

describe("export writes export-stats.json", () => {
  it("records the summary counts of the run, matching the returned ExportStats", () => {
    const home = freshHome();
    const stats = runExport({
      home,
      "claude-dir": CLAUDE_HOME,
      "kiro-dir": KIRO_CREW_V3_HOME,
      "kirocrew-dir": KIROCREW_HOME,
      "codex-dir": path.join(home, "no-codex"),
      output: sink(),
    });
    const raw = JSON.parse(fs.readFileSync(statsFile(home), "utf8"));
    expect(SavedExportStatsSchema.safeParse(raw).success).toBe(true);
    expect(raw).toEqual({
      version: EXPORT_STATS_VERSION,
      source: "auto",
      project: null,
      exported_sessions: stats.exportedSessions,
      sessions_by_origin: stats.sessionsByOrigin,
      automation_skipped: stats.automationSkipped,
      kirocrew_handed_off: stats.kirocrewHandedOff,
    });
    expect(raw.kirocrew_handed_off).toBe(8);
    // Origin keys are sorted so the bytes do not depend on discovery order.
    expect(Object.keys(raw.sessions_by_origin)).toEqual(Object.keys(raw.sessions_by_origin).sort());
    expect(Object.keys(raw.sessions_by_origin)).toEqual(["claude", "kiro", "kirocrew"]);
  });

  it("records the source and project filter, and holds no paths or session text", () => {
    const home = freshHome();
    runExport({
      home,
      "claude-dir": CLAUDE_HOME,
      source: "claude",
      project: "alpha",
      output: sink(),
    });
    const text = fs.readFileSync(statsFile(home), "utf8");
    const saved = readExportStats(home);
    expect(saved?.source).toBe("claude");
    expect(saved?.project).toBe("alpha");
    expect(text).not.toContain(CLAUDE_HOME);
    expect(text).not.toContain(home);
  });

  it("is owner-only and leaves no temporary file behind", () => {
    const home = freshHome();
    runExport({ home, "claude-dir": CLAUDE_HOME, source: "claude", output: sink() });
    expect(fs.statSync(statsFile(home)).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.join(home, "exports")).filter((f) => f.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it("a later run replaces it with that run's counts", () => {
    const home = freshHome();
    const common = {
      home,
      "claude-dir": CLAUDE_HOME,
      "kiro-dir": KIRO_CREW_V3_HOME,
      "codex-dir": path.join(home, "no-codex"),
      output: sink(),
    };
    runExport({ ...common, source: "kiro" });
    expect(readExportStats(home)?.kirocrew_handed_off).toBe(8);
    runExport({ ...common, source: "claude" });
    expect(readExportStats(home)?.kirocrew_handed_off).toBe(0);
    expect(readExportStats(home)?.source).toBe("claude");
  });
});

describe("readExportStats", () => {
  it("is null when the file is missing (an export from an older version)", () => {
    expect(readExportStats(freshHome())).toBeNull();
  });

  it("is null for a corrupt file or an unknown schema version, never throwing", () => {
    const home = freshHome();
    fs.mkdirSync(path.join(home, "exports"), { recursive: true });
    fs.writeFileSync(statsFile(home), "{not json");
    expect(readExportStats(home)).toBeNull();
    fs.writeFileSync(statsFile(home), JSON.stringify({ version: 99, kirocrew_handed_off: 3 }));
    expect(readExportStats(home)).toBeNull();
  });
});
