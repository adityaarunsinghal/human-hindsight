import fs from "node:fs";
import path from "node:path";
import type { ProjectInfo, SessionInfo } from "../types.js";

/** Codex CLI, IDE, and app rollouts share the session_meta / response_item log. */
export interface CodexSession extends SessionInfo {
  meta: Record<string, unknown>;
}

function rolloutFiles(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) return rolloutFiles(file);
      // Never follow symlinks, or read history.jsonl / unrelated JSON sidecars.
      return entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name) ? [file] : [];
    });
}

/**
 * Inventory with bounded memory. In metadata-only mode stop after session_meta
 * (normally the first line); scan counts the remaining lines without parsing
 * their potentially large tool output.
 */
function inspect(file: string, countEntries: boolean): CodexSession | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    const buffer = Buffer.alloc(64 * 1024);
    let pending = "";
    let meta: Record<string, unknown> = {};
    let entryCount = 0;
    let searchedBytes = 0;
    let found = false;
    let lineHasContent = false;
    let size: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: chunked file reader
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      for (const byte of buffer.subarray(0, size)) {
        if (byte === 10) {
          if (lineHasContent) entryCount++;
          lineHasContent = false;
        } else if (byte !== 32 && byte !== 9 && byte !== 13) {
          lineHasContent = true;
        }
      }
      if (!found && searchedBytes < 1024 * 1024) {
        // Decode complete lines together so UTF-8 split across chunks survives.
        pending += buffer.subarray(0, size).toString("latin1");
        searchedBytes += size;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const entry = JSON.parse(Buffer.from(line, "latin1").toString("utf8"));
            if (
              entry?.type === "session_meta" &&
              entry.payload &&
              typeof entry.payload === "object" &&
              !Array.isArray(entry.payload)
            ) {
              meta = entry.payload;
              found = true;
              pending = "";
              break;
            }
          } catch {
            // A partial/corrupt metadata line never makes inventory fatal.
          }
        }
      }
      if (!countEntries && (found || searchedBytes >= 1024 * 1024)) break;
    }
    if (lineHasContent) entryCount++;
    if (!found && pending.trim()) {
      try {
        const entry = JSON.parse(Buffer.from(pending, "latin1").toString("utf8"));
        if (entry?.type === "session_meta" && entry.payload && typeof entry.payload === "object") {
          meta = entry.payload;
        }
      } catch {
        // Truncated final line.
      }
    }
    const basename = path.basename(file);
    const filenameId = basename.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
    )?.[1];
    return {
      id: typeof meta.id === "string" ? meta.id : (filenameId ?? basename.replace(/\.jsonl$/, "")),
      file: basename,
      path: file,
      entryCount: countEntries ? entryCount : 0,
      mtime: stat.mtime,
      meta,
    };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Active and archived rollouts, grouped by the actual cwd (which preserves hyphens). */
export function discoverCodexProjects(
  codexDir: string,
  opts: { countEntries?: boolean } = {},
): ProjectInfo[] {
  const byCwd = new Map<string, CodexSession[]>();
  const seen = new Set<string>();
  for (const store of ["sessions", "archived_sessions"]) {
    for (const file of rolloutFiles(path.join(codexDir, store))) {
      const session = inspect(file, opts.countEntries ?? true);
      if (!session || seen.has(session.id ?? session.path)) continue;
      seen.add(session.id ?? session.path); // prefer the active copy if both exist
      const cwd = typeof session.meta.cwd === "string" ? session.meta.cwd : "(unknown)";
      const sessions = byCwd.get(cwd) ?? [];
      sessions.push(session);
      byCwd.set(cwd, sessions);
    }
  }
  const usedNames = new Set<string>();
  return [...byCwd.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cwd, sessions]) => {
      sessions.sort(
        (a, b) => b.mtime.getTime() - a.mtime.getTime() || a.path.localeCompare(b.path),
      );
      const base = path.posix.basename(cwd.replaceAll("\\", "/")) || "codex";
      let shortName = base;
      for (let suffix = 2; usedNames.has(shortName); suffix++) shortName = `${base}-${suffix}`;
      usedNames.add(shortName);
      return {
        dirName: cwd,
        decodedPath: cwd,
        shortName,
        sessions,
        entryTotal: sessions.reduce((sum, s) => sum + s.entryCount, 0),
        latestMtime: sessions[0]?.mtime,
      };
    });
}

/** Spawned/internal agents carry generated prompts, not a human's task history. */
export function isCodexAutomation(meta: Record<string, unknown>): boolean {
  const source = meta.source;
  return (
    (typeof source === "string" && /^(subagent|internal)(?:_|$)/i.test(source)) ||
    (typeof source === "object" &&
      source !== null &&
      (Object.hasOwn(source, "subagent") || Object.hasOwn(source, "internal"))) ||
    typeof meta.parent_thread_id === "string" ||
    (typeof meta.thread_source === "string" && meta.thread_source !== "user")
  );
}
