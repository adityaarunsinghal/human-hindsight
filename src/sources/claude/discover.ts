import fs from "node:fs";
import path from "node:path";
import { countFileEntries } from "../kiro/discover.js";
import type { ProjectInfo, SessionInfo } from "../types.js";

/**
 * sources/claude/discover.ts: enumerate Claude Code projects and sessions.
 * (`SessionInfo` and `ProjectInfo` live in sources/types.ts.)
 */

export type { ProjectInfo, SessionInfo } from "../types.js";

/**
 * Decode a dash-encoded Claude Code project directory name back into a path.
 *
 * Claude Code names each project directory after the project's absolute path,
 * replacing every path separator (and some other characters, like `.`) with a
 * dash, so `/Users/alice/projects/webapp` becomes
 * `-Users-alice-projects-webapp`.
 *
 * The transform is **lossy and cannot be perfectly inverted**: a directory
 * literally named `my-app` encodes to the exact same string as the nested path
 * `my/app`. This is therefore a *documented best-effort heuristic*:
 *
 *   - a leading dash denotes the filesystem root `/`;
 *   - every remaining dash becomes a path separator;
 *   - empty segments (from runs of dashes, e.g. an encoded `.`) are dropped.
 *
 * Discovery uses this as a fallback when the transcripts lack a working directory.
 */
export function decodeProjectDir(dirName: string): string {
  const rooted = dirName.startsWith("-");
  const body = rooted ? dirName.slice(1) : dirName;
  const segments = body.split("-").filter((s) => s.length > 0);
  const joined = segments.join("/");
  return rooted ? `/${joined}` : joined;
}

/** Bytes read from the start of a transcript when looking for its working directory. */
const PROJECT_PATH_READ_BYTES = 64 * 1024;
/** Sessions per project read when looking for the working directory. */
const PROJECT_PATH_SESSIONS = 3;

/**
 * Read up to `length` bytes of `file` starting at `position`; an empty buffer
 * means end of file. Injectable so tests can count what discovery reads.
 */
export type ChunkReader = (file: string, position: number, length: number) => Buffer;

const readFileChunk: ChunkReader = (file, position, length) => {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    return buffer.subarray(0, fs.readSync(fd, buffer, 0, length, position));
  } finally {
    fs.closeSync(fd);
  }
};

/** A cwd is record metadata. Never infer it from a path quoted in message text. */
function entryCwd(line: string): string | undefined {
  if (!line.includes('"cwd"')) return;
  try {
    const cwd: unknown = JSON.parse(line)?.cwd;
    if (
      typeof cwd === "string" &&
      !cwd.includes("\0") &&
      (path.posix.isAbsolute(cwd) || path.win32.isAbsolute(cwd))
    ) {
      return cwd;
    }
  } catch {
    // A malformed entry does not prevent a later one from naming the project.
  }
  return;
}

/** The first recorded cwd within the first {@link PROJECT_PATH_READ_BYTES} of a transcript. */
function transcriptCwd(file: string, read: ChunkReader): string | undefined {
  const chunks: Buffer[] = [];
  let total = 0;
  let ended = false;
  try {
    while (total < PROJECT_PATH_READ_BYTES) {
      const chunk = read(file, total, PROJECT_PATH_READ_BYTES - total);
      if (chunk.length === 0) {
        ended = true;
        break;
      }
      const kept = chunk.subarray(0, PROJECT_PATH_READ_BYTES - total);
      chunks.push(kept);
      total += kept.length;
    }
  } catch {
    return;
  }
  const lines = Buffer.concat(chunks).toString("utf8").split("\n");
  // A line cut off by the cap is not a complete record.
  if (!ended) lines.pop();
  for (const line of lines) {
    const cwd = entryCwd(line);
    if (cwd) return cwd;
  }
  return;
}

/** Claude Code's folder name for a working directory: every non-alphanumeric becomes `-`. */
function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * The project's working directory as recorded in its transcripts, or undefined.
 *
 * Reads at most {@link PROJECT_PATH_SESSIONS} sessions, chosen by file name,
 * and at most {@link PROJECT_PATH_READ_BYTES} of each, so a large history stays
 * cheap. The choice never depends on file modification times, so touching an
 * old session cannot rename a project (which would change preference ids and
 * digest source hashes):
 *   1. a recorded directory whose encoded form equals the folder name wins;
 *   2. otherwise the directory recorded by the most sampled sessions, ties
 *      broken by the smaller path.
 */
function recordedProjectPath(
  dirName: string,
  sessions: SessionInfo[],
  read: ChunkReader,
): string | undefined {
  const sample = [...sessions]
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .slice(0, PROJECT_PATH_SESSIONS);
  const counts = new Map<string, number>();
  for (const session of sample) {
    const cwd = transcriptCwd(session.path, read);
    if (cwd) counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
  }
  const ranked = [...counts].sort(([a, ca], [b, cb]) => cb - ca || (a < b ? -1 : a > b ? 1 : 0));
  return (ranked.find(([cwd]) => encodeProjectPath(cwd) === dirName) ?? ranked[0])?.[0];
}

/**
 * Enumerate every Claude Code project and its top-level sessions under
 * `<claudeDir>/projects`.
 *
 * - Only top-level `*.jsonl` files count as sessions; nested subdirectories
 *   (e.g. subagent/sidechain threads) are intentionally excluded.
 * - A missing or empty `projects` directory yields an empty array (never
 *   throws).
 * - Unreadable files/directories are skipped, not fatal.
 * - Short names come from the working directory recorded in the transcripts
 *   (see {@link recordedProjectPath}), so `my-cool-app` keeps its dashes;
 *   without one, from the decoded folder name's last segment. They are
 *   deduplicated deterministically (`name`, `name-2`, `name-3`, …).
 *
 * The result is sorted by `dirName` for a stable, deterministic ordering.
 */
export function discoverProjects(
  claudeDir: string,
  opts: { countEntries?: boolean; readProjectPaths?: boolean; readChunk?: ChunkReader } = {},
): ProjectInfo[] {
  const projectsRoot = path.join(claudeDir, "projects");
  const countEntriesOpt = opts.countEntries ?? true;

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    // Missing/unreadable projects directory → nothing to inventory.
    return [];
  }

  const projects: ProjectInfo[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const dirName = dirent.name;
    const projectDir = path.join(projectsRoot, dirName);
    const sessions = readSessions(projectDir, countEntriesOpt);
    const cwd =
      opts.readProjectPaths === false
        ? undefined
        : recordedProjectPath(dirName, sessions, opts.readChunk ?? readFileChunk);
    const decodedPath = cwd ?? decodeProjectDir(dirName);
    const shortName = path.posix.basename(decodedPath.replaceAll("\\", "/")) || dirName;
    const entryTotal = sessions.reduce((sum, s) => sum + s.entryCount, 0);
    const latestMtime = sessions.length > 0 ? sessions[0]?.mtime : undefined;
    projects.push({ dirName, decodedPath, shortName, sessions, entryTotal, latestMtime });
  }

  // Deterministic ordering, then deterministic short-name disambiguation.
  projects.sort((a, b) => a.dirName.localeCompare(b.dirName));
  disambiguateShortNames(projects);
  return projects;
}

/**
 * List top-level `*.jsonl` sessions in a project dir, newest first.
 *
 * `countEntries` controls whether each file is read to compute {@link
 * SessionInfo.entryCount}: `scan` wants the number (its inventory column), but
 * `export`/`status` never use it and would otherwise pay a full-file read here
 * AND again when reading content, a wasteful double read on large trees.
 * When disabled, `entryCount` is 0 and only cheap `stat` metadata is read.
 */
function readSessions(projectDir: string, countEntries: boolean): SessionInfo[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions: SessionInfo[] = [];
  for (const entry of entries) {
    // Top-level regular files only. Nested subdirectories (subagent threads)
    // are excluded by not recursing and by requiring isFile().
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".jsonl")) continue;

    const filePath = path.join(projectDir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      // Unreadable session file: skip it (do not abort the whole scan).
      continue;
    }

    sessions.push({
      file: entry.name,
      path: filePath,
      entryCount: countEntries ? countFileEntries(filePath) : 0,
      mtime: stat.mtime,
    });
  }

  // Newest first; tie-break on file name for determinism.
  sessions.sort((a, b) => {
    const diff = b.mtime.getTime() - a.mtime.getTime();
    return diff !== 0 ? diff : a.file.localeCompare(b.file);
  });
  return sessions;
}

/**
 * Ensure short names are unique. The first project (by sorted `dirName`) keeps
 * the bare name; subsequent collisions get `-2`, `-3`, … appended. Deterministic
 * because the input is pre-sorted by `dirName`.
 */
function disambiguateShortNames(projects: ProjectInfo[]): void {
  const used = new Set<string>();
  for (const project of projects) {
    const base = project.shortName;
    for (let suffix = 2; used.has(project.shortName); suffix++) {
      project.shortName = `${base}-${suffix}`;
    }
    used.add(project.shortName);
  }
}
