import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderFoundBanner, runScan } from "../src/commands/scan.js";

// Always drive scan with the synthetic fixture claude dir, never real ~/.claude.
const CLAUDE_HOME = path.join(import.meta.dirname, "fixtures", "claude-home");
const NO_PROJECTS_HOME = path.join(import.meta.dirname, "fixtures", "claude-home-noprojects");
const PROJECTS = path.join(CLAUDE_HOME, "projects");

const MTIMES: Record<string, string> = {
  "-Users-alice-projects-webapp/s1.jsonl": "2026-07-10T10:00:00Z",
  "-Users-alice-projects-webapp/s2.jsonl": "2026-07-11T09:30:00Z",
  "-Users-alice-projects-api/main.jsonl": "2026-07-12T14:00:00Z",
  "-Users-alice-my-cool-app/session.jsonl": "2026-07-09T08:00:00Z",
  "-Users-bob-webapp/session.jsonl": "2026-07-08T12:00:00Z",
};

beforeAll(() => {
  for (const [rel, iso] of Object.entries(MTIMES)) {
    const when = new Date(iso);
    fs.utimesSync(path.join(PROJECTS, rel), when, when);
  }
});

/**
 * Run `scan` and capture its (VT-stripped) stdout. Pins `source: "claude"` so a
 * test machine's real ~/.kiro store can never leak into these fixture-scoped
 * assertions (the "tests never read the real store" rule extends to kiro).
 */
function captureScan(args: { "claude-dir"?: string; source?: string }): string {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    logs.push(parts.map(String).join(" "));
  });
  try {
    runScan({ source: "claude", ...args });
  } finally {
    spy.mockRestore();
  }
  return stripVTControlCharacters(logs.join("\n"));
}

describe("scan command", () => {
  it("renders the inventory table with the documented columns", () => {
    const out = captureScan({ "claude-dir": CLAUDE_HOME });
    expect(out).toContain("Project");
    expect(out).toContain("Sessions");
    expect(out).toContain("Entries");
    expect(out).toContain("Latest");
    // Human date format.
    expect(out).toContain("2026-07-12");
  });

  it("lists every project including disambiguated short names", () => {
    const out = captureScan({ "claude-dir": CLAUDE_HOME });
    for (const name of ["webapp", "api", "app", "webapp-2", "empty"]) {
      expect(out).toContain(name);
    }
  });

  it("sorts projects by latest activity, most recent first", () => {
    const out = captureScan({ "claude-dir": CLAUDE_HOME });
    const names = ["api", "webapp", "app", "webapp-2", "empty"];
    // First table column holds the project short name; read them in row order.
    const order = out
      .split("\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI styling
      .map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""))
      .map((line) => line.split("  ")[0]?.trim() ?? "")
      .filter((name) => names.includes(name));
    expect(order).toEqual(["api", "webapp", "app", "webapp-2", "empty"]);
  });

  it("prints a totals line and the export funnel hint", () => {
    const out = captureScan({ "claude-dir": CLAUDE_HOME });
    expect(out).toContain("5 projects, 5 sessions");
    expect(out).toContain("→ next: human-hindsight export");
  });

  it("counts one project and one session in the singular", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-scan-one-"));
    try {
      const project = path.join(dir, "projects", "-work-solo-app");
      fs.mkdirSync(project, { recursive: true });
      fs.copyFileSync(
        path.join(PROJECTS, "-Users-alice-my-cool-app", "session.jsonl"),
        path.join(project, "only.jsonl"),
      );
      const out = captureScan({ "claude-dir": dir });
      expect(out).toContain("1 project, 1 session");
      expect(out).not.toMatch(/\b1 (projects|sessions)\b/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shows a friendly message pointing at --claude-dir when nothing is found", () => {
    const out = captureScan({ "claude-dir": NO_PROJECTS_HOME });
    expect(out).toContain("No Claude Code projects found");
    expect(out).toContain("--claude-dir");
  });

  it("inventories kiro sessions grouped by cwd under --source kiro", () => {
    const KIRO_HOME = path.join(import.meta.dirname, "fixtures", "kiro-home");
    const out = captureScanKiro({ "kiro-dir": KIRO_HOME });
    expect(out).toContain("webapp");
    expect(out).toContain("api");
    // The orphan .history (transcript deleted) is surfaced, not silently absent.
    expect(out).toContain("1 Kiro CLI session left out: the transcript was deleted");
    expect(out).toContain("→ next: human-hindsight export");
  });

  it("shows a kiro-specific message pointing at --kiro-dir when nothing is found", () => {
    const out = captureScanKiro({ "kiro-dir": NO_PROJECTS_HOME });
    expect(out).toContain("No kiro-cli sessions found");
    expect(out).toContain("--kiro-dir");
  });
});

/** Run `scan --source kiro` and capture its (VT-stripped) stdout. */
function captureScanKiro(args: { "kiro-dir"?: string }): string {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    logs.push(parts.map(String).join(" "));
  });
  try {
    runScan({ source: "kiro", ...args });
  } finally {
    spy.mockRestore();
  }
  return stripVTControlCharacters(logs.join("\n"));
}

// ---- the Found banner -------------------------------------------------------

const KIRO_CREW_V3_HOME = path.join(import.meta.dirname, "fixtures", "kiro-home-v3-crew");
const KIROCREW_HOME = path.join(import.meta.dirname, "fixtures", "kirocrew-home");

/** Run `scan` with arbitrary args (no pinned source) and capture VT-stripped stdout. */
function captureScanWith(args: Parameters<typeof runScan>[0]): string {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    logs.push(parts.map(String).join(" "));
  });
  try {
    runScan(args);
  } finally {
    spy.mockRestore();
  }
  return stripVTControlCharacters(logs.join("\n"));
}

describe("renderFoundBanner", () => {
  it("names each backend by product name with plural counts; Kiro Crew counts chats", () => {
    expect(
      renderFoundBanner([
        { name: "claude", projects: 12, sessions: 489 },
        { name: "codex", projects: 1, sessions: 3 },
        { name: "kiro", projects: 164, sessions: 748, kirocrewRuns: 272 },
        { name: "kirocrew", projects: 5, sessions: 75 },
      ]),
    ).toBe(
      "Found Claude Code (12 projects, 489 sessions), Codex (1 project, 3 sessions), " +
        "Kiro CLI (164 projects, 748 sessions; 272 are Kiro Crew runs, read from the Kiro Crew store), " +
        "Kiro Crew (5 projects, 75 chats)",
    );
  });

  it("uses singular forms for one project, session, chat or Crew run", () => {
    expect(
      renderFoundBanner([
        { name: "kiro", projects: 1, sessions: 1, kirocrewRuns: 1 },
        { name: "kirocrew", projects: 1, sessions: 1 },
        { name: "opencode", projects: 2, sessions: 1 },
      ]),
    ).toBe(
      "Found Kiro CLI (1 project, 1 session; 1 is a Kiro Crew run, read from the Kiro Crew store), " +
        "Kiro Crew (1 project, 1 chat), OpenCode (2 projects, 1 session)",
    );
  });

  it("writes a count of a thousand or more with a thousands separator, as every screen does", () => {
    expect(
      renderFoundBanner([
        { name: "claude", projects: 1200, sessions: 34567 },
        { name: "kiro", projects: 2, sessions: 3000, kirocrewRuns: 1500 },
      ]),
    ).toBe(
      "Found Claude Code (1,200 projects, 34,567 sessions), " +
        "Kiro CLI (2 projects, 3,000 sessions; 1,500 are Kiro Crew runs, read from the Kiro Crew store)",
    );
  });

  it("leaves the K15 clause out when no kiro session is a Crew run", () => {
    expect(renderFoundBanner([{ name: "kiro", projects: 2, sessions: 3, kirocrewRuns: 0 }])).toBe(
      "Found Kiro CLI (2 projects, 3 sessions)",
    );
  });

  it("returns null when nothing contributed", () => {
    expect(renderFoundBanner([])).toBeNull();
  });
});

describe("scan: Found banner", () => {
  it("auto: one line before the table, registry order, K15 count from the kiro classifier", () => {
    const out = captureScanWith({
      source: "auto",
      "claude-dir": CLAUDE_HOME,
      "kiro-dir": KIRO_CREW_V3_HOME,
      "kirocrew-dir": KIROCREW_HOME,
    });
    const lines = out.split("\n");
    const banner = lines[0] ?? "";
    expect(banner).toBe(
      "Found Claude Code (5 projects, 5 sessions), " +
        "Kiro CLI (5 projects, 12 sessions; 8 are Kiro Crew runs, read from the Kiro Crew store), " +
        "Kiro Crew (2 projects, 5 chats)",
    );
    // A blank line separates the banner from the table header.
    expect(lines[1]).toBe("");
    expect(lines[2]).toContain("Project");
  });

  it("an explicit --source prints only that backend's entry", () => {
    const out = captureScanWith({
      source: "kirocrew",
      "claude-dir": CLAUDE_HOME,
      "kiro-dir": KIRO_CREW_V3_HOME,
      "kirocrew-dir": KIROCREW_HOME,
    });
    expect(out.split("\n")[0]).toBe("Found Kiro Crew (2 projects, 5 chats)");
    expect(out).not.toContain("Claude Code (");
    expect(out).not.toContain("Kiro CLI (");
  });

  it("--source kiro: the Kiro CLI entry carries the K15 clause", () => {
    const out = captureScanWith({ source: "kiro", "kiro-dir": KIRO_CREW_V3_HOME });
    expect(out.split("\n")[0]).toBe(
      "Found Kiro CLI (5 projects, 12 sessions; 8 are Kiro Crew runs, read from the Kiro Crew store)",
    );
  });

  it("--source kiro on a store with no Crew runs has no K15 clause", () => {
    const out = captureScanWith({
      source: "kiro",
      "kiro-dir": path.join(import.meta.dirname, "fixtures", "kiro-home"),
    });
    expect(out.split("\n")[0]).toBe("Found Kiro CLI (2 projects, 5 sessions)");
  });

  it("counts follow the --project filter", () => {
    const out = captureScanWith({
      source: "claude",
      "claude-dir": CLAUDE_HOME,
      project: "api",
    });
    expect(out.split("\n")[0]).toBe("Found Claude Code (1 project, 1 session)");
  });
});

describe("scan: no-results messages name Kiro Crew", () => {
  it("--source kirocrew points at <dir>/sessions and --kirocrew-dir", () => {
    const out = captureScanWith({ source: "kirocrew", "kirocrew-dir": NO_PROJECTS_HOME });
    expect(out).toContain(`No Kiro Crew chats found under ${NO_PROJECTS_HOME}/sessions`);
    expect(out).toContain("--kirocrew-dir");
    expect(out).toContain("HUMAN_HINDSIGHT_KIROCREW_DIR");
    expect(out).not.toContain("Found ");
  });

  it("auto with no stores names Kiro Crew and its flag", () => {
    const out = captureScanWith({ source: "auto" });
    expect(out).toContain(
      "No Claude Code, Codex, kiro-cli, Kiro Crew, or OpenCode sessions found.",
    );
    expect(out).toContain("--kirocrew-dir");
  });
});
