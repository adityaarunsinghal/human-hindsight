import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { type ManifestEntry, runExport, stableProjectNames } from "../src/commands/export.js";
import { exportFileName } from "../src/core/render.js";
import { extractMessages, extractTimeline } from "../src/sources/claude/extract.js";
import { claudeSource } from "../src/sources/claude/index.js";
import type { ProjectInfo, SessionInfo, SessionSource } from "../src/sources/types.js";

/**
 * A re-export never loses what an earlier export established: a session that
 * cannot be read this time keeps its earlier export, every project folder
 * keeps one name, a session the backend moved keeps its file name and id, and
 * new file names stay readable. Synthetic stores and temporary homes only.
 */

const temps: string[] = [];
function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sink(): { output: Writable; text: () => string } {
  let text = "";
  const output = new Writable({
    write(chunk, _e, next) {
      text += chunk.toString();
      next();
    },
  });
  return { output, text: () => stripVTControlCharacters(text) };
}
const quiet = () => sink().output;

function manifest(home: string): ManifestEntry[] {
  return JSON.parse(fs.readFileSync(path.join(home, "exports", "manifest.json"), "utf8"));
}
const index = (home: string, name: string) =>
  JSON.parse(fs.readFileSync(path.join(home, "exports", name), "utf8"));

const claudeLine = (cwd: string, ts: string, text: string) =>
  JSON.stringify({
    type: "user",
    timestamp: ts,
    cwd,
    sessionId: "synthetic",
    message: { role: "user", content: text },
  });

function project(sessions: SessionInfo[], shortName = "app"): ProjectInfo {
  return {
    dirName: "-work-app",
    decodedPath: "/work/app",
    shortName,
    sessions,
    entryTotal: sessions.length,
    latestMtime: new Date(0),
  };
}
const sessionAt = (file: string): SessionInfo => ({
  file,
  path: `/synthetic/claude/projects/-work-app/${file}`,
  entryCount: 1,
  mtime: new Date(0),
});

describe("export: a session that cannot be read this time", () => {
  it("keeps its earlier export, manifest row and index entries, and says so", () => {
    const home = temp("hindsight-continuity-home-");
    const failing = new Set<string>();
    const source: SessionSource = {
      name: "claude",
      discover: () => [project([sessionAt("s1.jsonl"), sessionAt("s2.jsonl")])],
      read: (session) => {
        if (failing.has(session.file)) {
          // A permission change, or a file too large for one string.
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        }
        return [
          JSON.stringify({ type: "assistant", message: { content: "Shall I start?" } }),
          claudeLine("/work/app", "2026-10-21T10:00:00Z", `yes (${session.file})`),
        ];
      },
      extract: extractMessages,
      timeline: extractTimeline,
    };
    runExport({ home, sources: [source], output: quiet() });
    const first = manifest(home);
    const s1 = first.find((e) => e.source.endsWith("s1.jsonl"));
    if (!s1) throw new Error("s1 was not exported");
    const file = path.join(home, "exports", s1.export);
    const before = fs.readFileSync(file, "utf8");
    const anaphoraBefore = index(home, "anaphora.json")[s1.export];
    const outcomeBefore = index(home, "outcomes.json")[s1.export];
    expect(anaphoraBefore).toHaveLength(1);

    failing.add("s1.jsonl");
    const out = sink();
    const stats = runExport({ home, sources: [source], output: out.output });
    expect(stats.readErrors).toBe(1);
    expect(stats.keptAfterReadError).toBe(1);
    expect(stats.prunedExports).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(manifest(home)).toEqual(first);
    expect(index(home, "anaphora.json")[s1.export]).toEqual(anaphoraBefore);
    expect(index(home, "outcomes.json")[s1.export]).toEqual(outcomeBefore);
    expect(out.text()).toContain(
      "1 earlier export kept unchanged because its session could not be read",
    );
  });

  it("still prunes the export of a session that no longer exists", () => {
    const home = temp("hindsight-continuity-home-");
    let sessions = [sessionAt("s1.jsonl"), sessionAt("s2.jsonl")];
    const source: SessionSource = {
      name: "claude",
      discover: () => [project(sessions)],
      read: (session) => [claudeLine("/work/app", "2026-10-21T10:00:00Z", session.file)],
      extract: extractMessages,
      timeline: extractTimeline,
    };
    runExport({ home, sources: [source], output: quiet() });
    sessions = [sessionAt("s2.jsonl")];
    const stats = runExport({ home, sources: [source], output: quiet() });
    expect(stats.prunedExports).toBe(1);
    expect(stats.keptAfterReadError).toBe(0);
    expect(manifest(home)).toHaveLength(1);
  });
});

describe("export: a Codex rollout that can no longer be opened", () => {
  const canChmod = process.platform !== "win32" && process.getuid?.() !== 0;
  it.skipIf(!canChmod)("keeps its earlier export instead of pruning it", () => {
    const codex = temp("hindsight-continuity-codex-");
    const home = temp("hindsight-continuity-home-");
    const empty = path.join(codex, "none");
    const day = path.join(codex, "sessions", "2026", "10", "20");
    fs.mkdirSync(day, { recursive: true });
    const rollout = (id: string, text: string) => {
      const file = path.join(day, `rollout-2026-10-20T10-00-00-${id}.jsonl`);
      fs.writeFileSync(
        file,
        [
          { type: "session_meta", payload: { id, cwd: "/work/web", source: "cli" } },
          { type: "event_msg", payload: { type: "user_message", message: text } },
        ]
          .map((entry) => JSON.stringify({ timestamp: "2026-10-20T10:00:00Z", ...entry }))
          .concat("")
          .join("\n"),
      );
      return file;
    };
    const locked = rollout("11111111-1111-4111-8111-111111111111", "first rollout");
    rollout("22222222-2222-4222-8222-222222222222", "second rollout");
    const args = {
      home,
      "codex-dir": codex,
      "claude-dir": empty,
      "kiro-dir": empty,
      "kirocrew-dir": empty,
      "opencode-dir": empty,
    };
    runExport({ ...args, output: quiet() });
    const before = manifest(home);
    expect(before.map((e) => e.project)).toEqual(["web", "web"]);

    fs.chmodSync(locked, 0o000);
    try {
      const stats = runExport({ ...args, output: quiet() });
      expect(stats.readErrors).toBe(1);
      expect(stats.keptAfterReadError).toBe(1);
      expect(stats.prunedExports).toBe(0);
      expect(manifest(home)).toEqual(before);
    } finally {
      fs.chmodSync(locked, 0o600);
    }
  });
});

describe("export: a Codex rollout moved to the archive", () => {
  it("keeps its export name and session id", () => {
    const codex = temp("hindsight-continuity-codex-");
    const home = temp("hindsight-continuity-home-");
    const id = "33333333-3333-4333-8333-333333333333";
    const name = `rollout-2026-10-20T10-00-00-${id}.jsonl`;
    const active = path.join(codex, "sessions", "2026", "10", "20");
    const archived = path.join(codex, "archived_sessions");
    fs.mkdirSync(active, { recursive: true });
    fs.mkdirSync(archived, { recursive: true });
    fs.writeFileSync(
      path.join(active, name),
      [
        { type: "session_meta", payload: { id, cwd: "/work/web", source: "cli" } },
        { type: "event_msg", payload: { type: "user_message", message: "ship the page" } },
      ]
        .map((entry) => JSON.stringify({ timestamp: "2026-10-20T10:00:00Z", ...entry }))
        .join("\n"),
    );
    const empty = path.join(codex, "none");
    const args = { home, "codex-dir": codex, "claude-dir": empty, "kiro-dir": empty };
    runExport({ ...args, output: quiet() });
    const [before] = manifest(home);
    fs.renameSync(path.join(active, name), path.join(archived, name));
    const stats = runExport({ ...args, output: quiet() });
    expect(stats.prunedExports).toBe(0);
    expect(manifest(home)).toEqual([{ ...before, source: path.join(archived, name) }]);
  });
});

describe("export: one stable name per project folder", () => {
  it("keeps the old project's name when a new folder with the same name sorts first", () => {
    const claudeDir = temp("hindsight-continuity-claude-");
    const home = temp("hindsight-continuity-home-");
    const write = (dir: string, file: string, cwd: string, ts: string, text: string) => {
      const folder = path.join(claudeDir, "projects", dir);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, file), `${claudeLine(cwd, ts, text)}\n`);
    };
    const projects = () => new Map(manifest(home).map((e) => [path.basename(e.source), e.project]));

    // 1. One project, named `app`.
    write("-work-zed-app", "s1.jsonl", "/work/zed/app", "2026-10-01T10:00:00Z", "first task");
    runExport({ home, sources: [claudeSource(claudeDir)], output: quiet() });
    expect([...projects().values()]).toEqual(["app"]);

    // 2. A second folder also named `app` sorts first, and the old project
    //    gains a session. Discovery alone would now call the old one `app-2`.
    write("-work-amy-app", "s2.jsonl", "/work/amy/app", "2026-10-02T10:00:00Z", "other project");
    write("-work-zed-app", "s3.jsonl", "/work/zed/app", "2026-10-03T10:00:00Z", "second task");
    runExport({ home, sources: [claudeSource(claudeDir)], output: quiet() });
    expect(Object.fromEntries(projects())).toEqual({
      "s1.jsonl": "app",
      "s2.jsonl": "app-2",
      "s3.jsonl": "app",
    });

    // 3. Both folders keep their names on every later run.
    write("-work-amy-app", "s4.jsonl", "/work/amy/app", "2026-10-04T10:00:00Z", "more work");
    runExport({ home, sources: [claudeSource(claudeDir)], output: quiet() });
    expect(Object.fromEntries(projects())).toEqual({
      "s1.jsonl": "app",
      "s2.jsonl": "app-2",
      "s3.jsonl": "app",
      "s4.jsonl": "app-2",
    });
  });

  const folder = (dirName: string, shortName: string): ProjectInfo => ({
    dirName,
    decodedPath: dirName,
    shortName,
    sessions: [],
    entryTotal: 0,
    latestMtime: undefined,
  });

  it.each([
    {
      name: "a new folder whose discovery name is held gets the next free suffix",
      folders: [folder("/a/app", "app"), folder("/b/app", "app-2")],
      earlier: { "/b/app": ["app"] },
      want: { "/a/app": "app-2", "/b/app": "app" },
    },
    {
      name: "a folder whose sessions carry several earlier names converges on the common one",
      folders: [folder("/a/app", "app")],
      earlier: { "/a/app": ["old", "app", "old"] },
      want: { "/a/app": "old" },
    },
    {
      name: "two folders claiming one earlier name: the one more exports carry keeps it",
      folders: [folder("/a/app", "app"), folder("/b/app", "app-2")],
      earlier: { "/a/app": ["app"], "/b/app": ["app", "app"] },
      want: { "/a/app": "app-2", "/b/app": "app" },
    },
    {
      name: "a suffixed discovery name is not suffixed twice",
      folders: [folder("/a/x", "web"), folder("/b/x", "web-2"), folder("/c/x", "web-3")],
      earlier: { "/a/x": ["web-2"], "/b/x": ["web"] },
      want: { "/a/x": "web-2", "/b/x": "web", "/c/x": "web-3" },
    },
    {
      name: "a new folder whose suffixed discovery name is held reads app-3, not app-2-2",
      folders: [folder("/a/app", "app"), folder("/b/app", "app-2"), folder("/z/app", "app-3")],
      earlier: { "/a/app": ["app-2"], "/z/app": ["app"] },
      want: { "/a/app": "app-2", "/b/app": "app-3", "/z/app": "app" },
    },
    {
      name: "without earlier exports discovery names stand",
      folders: [folder("/a/app", "app"), folder("/b/app", "app-2")],
      earlier: {},
      want: { "/a/app": "app", "/b/app": "app-2" },
    },
  ])("$name", ({ folders, earlier, want }) => {
    const names = stableProjectNames(
      folders,
      (p) => (earlier as Record<string, string[]>)[p.dirName] ?? [],
    );
    expect(Object.fromEntries(folders.map((p) => [p.dirName, names.get(p)]))).toEqual(want);
    expect(new Set(names.values()).size).toBe(folders.length);
  });
});

describe("export: a kiro session that moved from the flat store into the v3 store", () => {
  // kiro-cli copies a flat v2 session into its v3 store as `cli_<uuid>_<suffix>`
  // and leaves the flat file behind; discovery keeps only the v3 copy.
  const UUID = "0a1b2c3d-1111-4222-8333-944445555666";

  it("keeps its earlier export name and session id, on that run and the next", () => {
    const kiro = temp("hindsight-continuity-kiro-");
    const home = temp("hindsight-continuity-home-");
    const flat = path.join(kiro, "sessions", "cli");
    fs.mkdirSync(flat, { recursive: true });
    const prompt = JSON.stringify({
      version: 1,
      kind: "Prompt",
      data: {
        message_id: "m1",
        content: [{ kind: "text", data: "plan the schema change" }],
        meta: { timestamp: 1790000000 },
      },
    });
    fs.writeFileSync(path.join(flat, `${UUID}.jsonl`), `${prompt}\n`);
    fs.writeFileSync(path.join(flat, `${UUID}.json`), JSON.stringify({ cwd: "/work/svc" }));
    fs.writeFileSync(path.join(flat, `${UUID}.history`), "plan the schema change\n");
    runExport({ home, "kiro-dir": kiro, source: "kiro", output: quiet() });
    const [before] = manifest(home);
    expect(before?.sessionId).toBe(UUID);

    const v3 = path.join(kiro, "sessions", "workspacehash", `cli_${UUID}_abc123`);
    fs.mkdirSync(v3, { recursive: true });
    fs.writeFileSync(
      path.join(v3, "session.json"),
      JSON.stringify({ id: UUID, workspacePaths: ["/work/svc"], agentMode: "vibe" }),
    );
    fs.writeFileSync(
      path.join(v3, "messages.jsonl"),
      `${JSON.stringify({
        id: "e1",
        timestamp: new Date(1790000000 * 1000).toISOString(),
        payload: { type: "user", content: "plan the schema change" },
      })}\n`,
    );
    for (let run = 0; run < 2; run++) {
      runExport({ home, "kiro-dir": kiro, output: quiet() });
      const after = manifest(home);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        export: before?.export,
        sessionId: UUID,
        project: before?.project,
        source: path.join(v3, "messages.jsonl"),
      });
      expect(fs.readdirSync(path.join(home, "exports")).filter((f) => f.endsWith(".md"))).toEqual([
        before?.export,
      ]);
    }
  });
});

describe("export: file names", () => {
  const twoIds = ["aaaaaaaa-1111-4111-8111-111111111111", "aaaaaaaa-2222-4222-8222-222222222222"];
  const source = (ids: string[]): SessionSource => ({
    name: "claude",
    discover: () => [project(ids.map((id) => sessionAt(`${id}.jsonl`)))],
    read: (session) => [claudeLine("/work/app", "2026-10-21T10:00:00Z", session.file)],
    extract: extractMessages,
    timeline: extractTimeline,
  });

  it("gives two ids that share eight characters clean, stable names", () => {
    const home = temp("hindsight-continuity-home-");
    const first = runExport({ home, sources: [source(twoIds)], output: quiet() });
    expect(first.files).toEqual(["app-aaaaaaaa-2.md", "app-aaaaaaaa.md"]);
    expect(first.files.some((f) => f.endsWith("-.md"))).toBe(false);
    const again = runExport({ home, sources: [source(twoIds)], output: quiet() });
    expect(again.files).toEqual(first.files);
  });

  it.each([
    ["a shared prefix", "app", "aaaaaaaa-2222", ["app-aaaaaaaa.md"], "app-aaaaaaaa-2.md"],
    ["a first prefix that ends in a dash", "app", "abcdefg-hijk", [], "app-abcdefg-h.md"],
    ["a whole id that is taken", "app", "ab-", ["app-ab.md"], "app-ab-2.md"],
  ] as const)("the name rule lives in exportFileName, for every caller: %s", (_name, project, id, used, name) => {
    expect(exportFileName(project, id, new Set(used))).toBe(name);
  });

  it("keeps a name an earlier manifest already holds, even one ending in a dash", () => {
    const home = temp("hindsight-continuity-home-");
    runExport({ home, sources: [source(twoIds)], output: quiet() });
    const dir = path.join(home, "exports");
    const rows = manifest(home).map((row) => {
      if (row.export !== "app-aaaaaaaa-2.md") return row;
      fs.renameSync(path.join(dir, row.export), path.join(dir, "app-aaaaaaaa-.md"));
      return { ...row, export: "app-aaaaaaaa-.md" };
    });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(rows));
    const stats = runExport({ home, sources: [source(twoIds)], output: quiet() });
    expect(stats.files).toEqual(["app-aaaaaaaa-.md", "app-aaaaaaaa.md"]);
  });
});

describe("export: memory while reading", () => {
  it("builds each session's timeline while it is read, before the next read", () => {
    const calls: string[] = [];
    const source: SessionSource = {
      name: "claude",
      discover: () => [project([sessionAt("s1.jsonl"), sessionAt("s2.jsonl")])],
      read: (session) => {
        calls.push(`read ${session.file}`);
        return [claudeLine("/work/app", "2026-10-21T10:00:00Z", session.file)];
      },
      extract: extractMessages,
      timeline: (lines) => {
        calls.push(`timeline ${lines.length}`);
        return extractTimeline(lines);
      },
    };
    runExport({ home: temp("hindsight-continuity-home-"), sources: [source], output: quiet() });
    expect(calls).toEqual(["read s1.jsonl", "timeline 1", "read s2.jsonl", "timeline 1"]);
  });
});

describe("export: project names across filtered and full exports", () => {
  const CLAUDE_HOME = path.join(import.meta.dirname, "fixtures", "export-home");
  const CODEX_HOME = path.join(import.meta.dirname, "fixtures", "codex-home");
  const NO_KIRO = path.join(CLAUDE_HOME, "no-kiro-here");
  const NO_OPENCODE = path.join(CLAUDE_HOME, "no-opencode-here");
  const base = (home: string) => ({
    home,
    "claude-dir": CLAUDE_HOME,
    "codex-dir": CODEX_HOME,
    "kiro-dir": NO_KIRO,
    "opencode-dir": NO_OPENCODE,
    output: quiet(),
  });
  /** A home whose manifest an earlier release wrote: alpha under another name and id. */
  function upgradedHome(dropIndex: boolean) {
    const home = temp("hindsight-export-names-");
    runExport(base(home));
    const rows = manifest(home).map((row) =>
      row.project === "alpha"
        ? { ...row, project: "alpha-before-upgrade", sessionId: `old-${row.sessionId}` }
        : row,
    );
    fs.writeFileSync(path.join(home, "exports", "manifest.json"), JSON.stringify(rows, null, 2));
    // A release before the name index wrote no index.
    if (dropIndex) fs.renameSync(path.join(home, "exports", "project-names.json"), `${home}/aside`);
    const alpha = rows.filter((row) => row.project === "alpha-before-upgrade");
    expect(alpha.length).toBeGreaterThan(0);
    return { home, alpha };
  }
  const alphaAfter = (home: string, alpha: ManifestEntry[]) =>
    manifest(home)
      .filter((row) => alpha.some((a) => a.source === row.source))
      .map(({ export: file, project, sessionId }) => ({ export: file, project, sessionId }));
  const kept = (alpha: ManifestEntry[]) =>
    alpha.map(({ export: file, project, sessionId }) => ({ export: file, project, sessionId }));

  it.each([
    { name: "--project, then a full export", filter: { project: "beta" }, dropIndex: true },
    { name: "--source, then a full export", filter: { source: "codex" }, dropIndex: true },
    {
      name: "--project, with the index already there",
      filter: { project: "beta" },
      dropIndex: false,
    },
  ])("$name keeps every other project's name, file and session id", ({ filter, dropIndex }) => {
    const { home, alpha } = upgradedHome(dropIndex);
    runExport({ ...base(home), ...filter });
    // The filtered run's manifest lists only what it covered.
    expect(manifest(home).some((row) => row.project === "alpha-before-upgrade")).toBe(false);
    runExport(base(home));
    expect(alphaAfter(home, alpha)).toEqual(kept(alpha));
    // And on the run after that.
    runExport(base(home));
    expect(alphaAfter(home, alpha)).toEqual(kept(alpha));
  });

  it("names a folder from the index when none of its sessions is in the manifest", () => {
    const { home, alpha } = upgradedHome(true);
    runExport({ ...base(home), project: "beta" });
    const names = index(home, "project-names.json");
    expect(names.projects).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "alpha-before-upgrade" })]),
    );
    // Even with the session rows gone from the index, the folder keeps its name.
    fs.writeFileSync(
      path.join(home, "exports", "project-names.json"),
      JSON.stringify({ ...names, sessions: [] }),
    );
    runExport(base(home));
    expect(new Set(alphaAfter(home, alpha).map((row) => row.project))).toEqual(
      new Set(["alpha-before-upgrade"]),
    );
  });
});

describe("export: a project folder that comes back", () => {
  /** A folder whose discovery name is `app`, with the given session files. */
  function appFolder(dirName: string, files: string[]): ProjectInfo {
    return {
      dirName,
      decodedPath: dirName,
      shortName: "app",
      sessions: files.map(
        (file): SessionInfo => ({
          file,
          path: `/synthetic/claude/projects/${dirName}/${file}`,
          entryCount: 1,
          mtime: new Date(0),
        }),
      ),
      entryTotal: files.length,
      latestMtime: new Date(0),
    };
  }

  it("does not take the name the last manifest gives another folder; it gets the next free one", () => {
    const home = temp("hh-returning-home-");
    let folders: ProjectInfo[] = [];
    const source: SessionSource = {
      name: "claude",
      discover: () => folders,
      read: (session) => [
        claudeLine("/work/app", "2026-10-21T10:00:00Z", `work in ${session.path}`),
      ],
      extract: extractMessages,
      timeline: extractTimeline,
    };
    const projectOf = (file: string) =>
      manifest(home).find((row) => row.source.endsWith(`/${file}`))?.project;

    // 1. One folder, named `app`.
    folders = [appFolder("-work-zed-app", ["a1.jsonl"])];
    runExport({ home, sources: [source], output: quiet() });
    expect(projectOf("a1.jsonl")).toBe("app");

    // 2. Its folder is gone; another folder with the same discovery name is exported as `app`.
    folders = [appFolder("-work-amy-app", ["b1.jsonl"])];
    runExport({ home, sources: [source], output: quiet() });
    expect(projectOf("b1.jsonl")).toBe("app");

    // 3. The first folder comes back. The folder the last manifest names `app` keeps it.
    folders = [appFolder("-work-amy-app", ["b1.jsonl"]), appFolder("-work-zed-app", ["a2.jsonl"])];
    runExport({ home, sources: [source], output: quiet() });
    expect(projectOf("b1.jsonl")).toBe("app");
    expect(projectOf("a2.jsonl")).toBe("app-2");
    // And it stays that way on the next run.
    runExport({ home, sources: [source], output: quiet() });
    expect(projectOf("b1.jsonl")).toBe("app");
    expect(projectOf("a2.jsonl")).toBe("app-2");
  });
});
