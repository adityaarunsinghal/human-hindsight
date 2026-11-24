import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeProjectDir, discoverProjects } from "../src/sources/claude/discover.js";
import type { ProjectInfo } from "../src/sources/types.js";

// Tests NEVER read the real `~/.claude`. Everything below points at the
// synthetic fixture tree committed under test/fixtures/claude-home.
const CLAUDE_HOME = path.join(import.meta.dirname, "fixtures", "claude-home");
const NO_PROJECTS_HOME = path.join(import.meta.dirname, "fixtures", "claude-home-noprojects");
const PROJECTS = path.join(CLAUDE_HOME, "projects");

const byDir = (projects: ProjectInfo[], dirName: string): ProjectInfo => {
  const found = projects.find((p) => p.dirName === dirName);
  if (!found) throw new Error(`fixture project not found: ${dirName}`);
  return found;
};

// Pin session mtimes so "latest activity" and scan ordering are deterministic
// regardless of when the fixtures were checked out.
const MTIMES: Record<string, string> = {
  "-Users-alice-projects-webapp/s1.jsonl": "2026-07-10T10:00:00Z",
  "-Users-alice-projects-webapp/s2.jsonl": "2026-07-11T09:30:00Z", // webapp latest
  "-Users-alice-projects-api/main.jsonl": "2026-07-12T14:00:00Z", // newest overall
  "-Users-alice-my-cool-app/session.jsonl": "2026-07-09T08:00:00Z",
  "-Users-bob-webapp/session.jsonl": "2026-07-08T12:00:00Z",
};

beforeAll(() => {
  for (const [rel, iso] of Object.entries(MTIMES)) {
    const when = new Date(iso);
    fs.utimesSync(path.join(PROJECTS, rel), when, when);
  }
});

describe("decodeProjectDir", () => {
  it("decodes a leading dash as root and dashes as separators", () => {
    expect(decodeProjectDir("-Users-alice-projects-webapp")).toBe("/Users/alice/projects/webapp");
  });

  it("cannot invert real dashes in a name (documented lossy heuristic)", () => {
    // A directory literally named `my-cool-app` is indistinguishable from the
    // nested path `my/cool/app`; best-effort decode yields the latter.
    expect(decodeProjectDir("-Users-alice-my-cool-app")).toBe("/Users/alice/my/cool/app");
  });

  it("handles a non-rooted name without a leading slash", () => {
    expect(decodeProjectDir("relative-path")).toBe("relative/path");
  });
});

describe("discoverProjects", () => {
  it("returns an empty array when the projects directory is missing", () => {
    expect(discoverProjects(NO_PROJECTS_HOME)).toEqual([]);
  });

  it("returns an empty array for a non-existent claude dir (never throws)", () => {
    expect(discoverProjects(path.join(import.meta.dirname, "does-not-exist"))).toEqual([]);
  });

  it("discovers every project directory", () => {
    const projects = discoverProjects(CLAUDE_HOME);
    expect(projects.map((p) => p.dirName)).toEqual([
      "-Users-alice-empty",
      "-Users-alice-my-cool-app",
      "-Users-alice-projects-api",
      "-Users-alice-projects-webapp",
      "-Users-bob-webapp",
    ]);
  });

  it("lists exactly the top-level sessions with cheap entry counts", () => {
    const webapp = byDir(discoverProjects(CLAUDE_HOME), "-Users-alice-projects-webapp");
    expect(webapp.decodedPath).toBe("/Users/alice/projects/webapp");
    expect(webapp.shortName).toBe("webapp");
    expect(webapp.sessions.map((s) => s.file).sort()).toEqual(["s1.jsonl", "s2.jsonl"]);
    const counts = Object.fromEntries(webapp.sessions.map((s) => [s.file, s.entryCount]));
    expect(counts).toEqual({ "s1.jsonl": 3, "s2.jsonl": 2 });
    expect(webapp.entryTotal).toBe(5);
  });

  it("EXCLUDES nested subdirectory sessions (subagent threads)", () => {
    const api = byDir(discoverProjects(CLAUDE_HOME), "-Users-alice-projects-api");
    expect(api.sessions).toHaveLength(1);
    expect(api.sessions[0]?.file).toBe("main.jsonl");
    expect(api.entryTotal).toBe(4);
    // The nested subagents/nested.jsonl must not appear anywhere.
    expect(api.sessions.some((s) => s.file === "nested.jsonl")).toBe(false);
    expect(api.sessions.some((s) => s.path.includes("subagents"))).toBe(false);
  });

  it("handles an empty project directory gracefully", () => {
    const empty = byDir(discoverProjects(CLAUDE_HOME), "-Users-alice-empty");
    expect(empty.sessions).toEqual([]);
    expect(empty.entryTotal).toBe(0);
    expect(empty.latestMtime).toBeUndefined();
    expect(empty.shortName).toBe("empty");
  });

  it("derives short names from the decoded path's last segment", () => {
    const app = byDir(discoverProjects(CLAUDE_HOME), "-Users-alice-my-cool-app");
    expect(app.decodedPath).toBe("/Users/alice/my/cool/app");
    expect(app.shortName).toBe("app");
  });

  it("disambiguates duplicate short names deterministically", () => {
    const projects = discoverProjects(CLAUDE_HOME);
    // Both alice's and bob's dirs decode to a `webapp` last segment. The first
    // by sorted dirName keeps the bare name; the later collides to `webapp-2`.
    expect(byDir(projects, "-Users-alice-projects-webapp").shortName).toBe("webapp");
    expect(byDir(projects, "-Users-bob-webapp").shortName).toBe("webapp-2");
  });

  it("reports latest activity as the max session mtime", () => {
    const webapp = byDir(discoverProjects(CLAUDE_HOME), "-Users-alice-projects-webapp");
    // s2 (2026-07-11) is newer than s1 (2026-07-10).
    expect(webapp.latestMtime?.toISOString()).toBe(new Date("2026-07-11T09:30:00Z").toISOString());
    // Sessions are sorted newest-first.
    expect(webapp.sessions[0]?.file).toBe("s2.jsonl");
  });

  it("skips entry counting when countEntries:false (avoids the double read)", () => {
    const projects = discoverProjects(CLAUDE_HOME, { countEntries: false });
    // Sessions are still discovered; only the count is elided.
    const webapp = byDir(projects, "-Users-alice-projects-webapp");
    expect(webapp.sessions.map((s) => s.file).sort()).toEqual(["s1.jsonl", "s2.jsonl"]);
    expect(webapp.entryTotal).toBe(0);
    expect(webapp.sessions.every((s) => s.entryCount === 0)).toBe(true);
  });

  it("chunk-counts entries exactly, incl. no trailing newline and blank lines", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cch-count-"));
    try {
      const projDir = path.join(home, "projects", "-tmp-p");
      fs.mkdirSync(projDir, { recursive: true });
      // 3 non-empty lines, a blank line, and NO trailing newline on the last.
      fs.writeFileSync(path.join(projDir, "s.jsonl"), '{"a":1}\n{"b":2}\n\n{"c":3}');
      const proj = discoverProjects(home).find((p) => p.dirName === "-tmp-p");
      expect(proj?.sessions[0]?.entryCount).toBe(3);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("discoverProjects: project name from the recorded working directory", () => {
  const homes: string[] = [];
  afterAll(() => {
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  });

  /** A synthetic claude dir: one project folder, sessions as file → [cwd, mtime]. */
  function store(dirName: string, sessions: Record<string, [string | undefined, string]>) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "hh-discover-"));
    homes.push(home);
    const dir = path.join(home, "projects", dirName);
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, [cwd, mtime]] of Object.entries(sessions)) {
      const entry = { type: "user", ...(cwd ? { cwd } : {}), message: { content: "hi" } };
      const target = path.join(dir, file);
      fs.writeFileSync(target, `{"type":"summary"}\n${JSON.stringify(entry)}\n`);
      fs.utimesSync(target, new Date(mtime), new Date(mtime));
    }
    return home;
  }
  const only = (home: string) => discoverProjects(home, { countEntries: false })[0];

  it("names the project after the recorded directory, dashes included", () => {
    const home = store("-w-human-hindsight", { "a.jsonl": ["/w/human-hindsight", "2026-01-01"] });
    expect(only(home)?.shortName).toBe("human-hindsight");
    expect(only(home)?.decodedPath).toBe("/w/human-hindsight");
  });

  it("falls back to decoding the folder name when no directory is recorded", () => {
    const home = store("-w-human-hindsight", { "a.jsonl": [undefined, "2026-01-01"] });
    expect(only(home)?.shortName).toBe("hindsight");
    expect(only(home)?.decodedPath).toBe("/w/human/hindsight");
  });

  it("skips the transcript read when asked to", () => {
    const home = store("-w-human-hindsight", { "a.jsonl": ["/w/human-hindsight", "2026-01-01"] });
    const [project] = discoverProjects(home, { countEntries: false, readProjectPaths: false });
    expect(project?.shortName).toBe("hindsight");
  });

  it.each([
    ["the folder's own directory wins", "-w-two", "two"],
    ["neither matches: the choice is still stable", "-w-other", "one"],
  ])("two sessions with different directories: %s, whatever their times", (_, dir, name) => {
    for (const [older, newer] of [
      ["2026-01-01", "2026-02-01"],
      ["2026-02-01", "2026-01-01"],
    ]) {
      const home = store(dir, {
        "a.jsonl": ["/w/one", older as string],
        "b.jsonl": ["/w/two", newer as string],
      });
      expect(only(home)?.shortName).toBe(name);
    }
  });

  it("reads at most 64 KB from at most three sessions", () => {
    const sessions: Record<string, [undefined, string]> = {};
    for (const n of [1, 2, 3, 4, 5]) sessions[`s${n}.jsonl`] = [undefined, "2026-01-01"];
    const home = store("-w-big", sessions);
    // Every file pretends to be 50 MB of one long line with no recorded directory.
    const reads: { file: string; bytes: number }[] = [];
    const readChunk = (file: string, position: number, length: number) => {
      const bytes = Math.max(0, Math.min(length, 50 * 1024 * 1024 - position));
      reads.push({ file: path.basename(file), bytes });
      return Buffer.alloc(bytes, "x");
    };
    const [project] = discoverProjects(home, { countEntries: false, readChunk });
    expect(project?.shortName).toBe("big");
    const perFile = new Map<string, number>();
    for (const r of reads) perFile.set(r.file, (perFile.get(r.file) ?? 0) + r.bytes);
    expect([...perFile.keys()].sort()).toEqual(["s1.jsonl", "s2.jsonl", "s3.jsonl"]);
    for (const bytes of perFile.values()) expect(bytes).toBeLessThanOrEqual(64 * 1024);
  });

  it("finds a directory recorded after a long first line inside the cap", () => {
    const home = store("-w-x", {});
    const file = path.join(home, "projects", "-w-x", "a.jsonl");
    const long = JSON.stringify({ type: "summary", text: "y".repeat(40 * 1024) });
    fs.writeFileSync(file, `${long}\n${JSON.stringify({ type: "user", cwd: "/w/x-y" })}\n`);
    expect(only(home)?.shortName).toBe("x-y");
  });
});
