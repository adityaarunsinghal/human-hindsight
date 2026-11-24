import fs from "node:fs";
import path from "node:path";
import { countFileEntries, groupKiroSessionsByCwd } from "../kiro/discover.js";
import type { ProjectInfo, SessionInfo } from "../types.js";

/**
 * sources/kirocrew/discover.ts: enumerate Kiro Crew chats.
 *
 * Kiro Crew is a layer on top of kiro-cli. It keeps its own chat store, one JSONL
 * file per chat, flat under `<dir>/sessions/` (default `<dir>` is `~/.kiro/crew`):
 *
 *   dashboard_chat-<n>-<epoch>.jsonl       a chat the person typed in
 *   cron_<id>.jsonl, dashboard_cron-*      scheduled-job transcripts (automation)
 *   dashboard_setup-recovery-*, dashboard_member-mate*   other automation
 *   archive/<stem>__<stamp>.jsonl          a snapshot copy of a live chat
 *   *.lock, *.attachments/, .index/, .page-index/, .msg-count   sidecars
 *
 * A session is any `*.jsonl` file directly under `sessions/` or `sessions/archive/`.
 * Directories, dotfiles and anything not ending in `.jsonl` are skipped without
 * recursing. Archive snapshots are kept as ordinary sessions: they are literal
 * copies, so the global R8 dedupe (identical `(ts, text)`, earliest session owns
 * it) attributes each copied turn once and no special casing is needed here.
 *
 * Session metadata comes from line 1 only (a `_type: "metadata"` record with
 * `title`, `agent`, `model`, `project`, `created_at`), read without parsing the
 * rest of the file. Project identity is `project`, exact like the kiro cwd; a
 * missing or corrupt metadata line yields empty meta and the `unknown` project.
 * Grouping reuses the kiro source's {@link groupKiroSessionsByCwd}.
 */

/** Where Kiro Crew keeps chat transcripts, relative to its data directory. */
export const KIROCREW_SESSIONS_SUBDIR = "sessions";
/** Snapshot copies of live chats, relative to the sessions directory. */
export const KIROCREW_ARCHIVE_SUBDIR = "archive";

/** Cap on how far discovery reads to find the end of the metadata line. */
const METADATA_LINE_MAX_BYTES = 1024 * 1024;

/** Provenance read from a chat's metadata line. Every field is optional. */
export interface KirocrewSessionMeta {
  /** The chat's working directory (`project`): the project identity. */
  cwd?: string;
  title?: string;
  agent?: string;
  model?: string;
  /** ISO-8601 `created_at`. */
  createdAt?: string;
}

/** A Kiro Crew chat enriched with its metadata-line provenance. */
export interface KirocrewSessionInfo extends SessionInfo {
  meta: KirocrewSessionMeta;
}

/** A Kiro Crew "project": every chat sharing one metadata `project`. */
export interface KirocrewProjectInfo extends ProjectInfo {
  sessions: KirocrewSessionInfo[];
}

/**
 * Read the first line of a file without loading the rest. Stops at the first
 * newline or at {@link METADATA_LINE_MAX_BYTES}; returns "" when unreadable or
 * when the line is longer than the cap (treated as missing metadata).
 */
function readFirstLine(filePath: string): string {
  const CHUNK = 64 * 1024;
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return "";
  }
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.allocUnsafe(CHUNK);
    let bytesRead: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard readSync loop
    while ((bytesRead = fs.readSync(fd, buffer, 0, CHUNK, null)) > 0) {
      const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
      if (newline !== -1) {
        chunks.push(Buffer.from(buffer.subarray(0, newline)));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      total += bytesRead;
      if (total > METADATA_LINE_MAX_BYTES) return "";
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return "";
  } finally {
    fs.closeSync(fd);
  }
}

/** Parse a metadata line; tolerant, anything other than a metadata record yields {}. */
export function parseKirocrewMetadataLine(line: string): KirocrewSessionMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  if (record._type !== "metadata") return {};
  const str = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  return {
    cwd: str("project"),
    title: str("title"),
    agent: str("agent"),
    model: str("model"),
    createdAt: str("created_at"),
  };
}

/** The `*.jsonl` session files directly inside one directory; missing dir yields []. */
function jsonlFilesIn(dir: string): string[] {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return dirents
    .filter((d) => d.isFile() && !d.name.startsWith(".") && d.name.endsWith(".jsonl"))
    .map((d) => path.join(dir, d.name));
}

/** Every candidate session path: live chats first, then archive snapshots. */
function sessionPaths(kirocrewDir: string): string[] {
  const root = path.join(kirocrewDir, KIROCREW_SESSIONS_SUBDIR);
  return [...jsonlFilesIn(root), ...jsonlFilesIn(path.join(root, KIROCREW_ARCHIVE_SUBDIR))];
}

/**
 * Collect every Kiro Crew chat as an ungrouped list. A missing store yields [];
 * a file that cannot be stat'ed is skipped, never fatal.
 */
export function collectKirocrewSessions(
  kirocrewDir: string,
  opts: { countEntries?: boolean } = {},
): KirocrewSessionInfo[] {
  const countEntries = opts.countEntries ?? true;
  const sessions: KirocrewSessionInfo[] = [];
  for (const filePath of sessionPaths(kirocrewDir)) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    sessions.push({
      file: path.basename(filePath),
      path: filePath,
      entryCount: countEntries ? countFileEntries(filePath) : 0,
      mtime: stat.mtime,
      meta: parseKirocrewMetadataLine(readFirstLine(filePath)),
    });
  }
  return sessions;
}

/**
 * Enumerate Kiro Crew chats grouped into projects by metadata `project`, with
 * the kiro source's ordering (projects by short name, sessions newest first)
 * and short-name collision handling.
 */
export function discoverKirocrewSessions(
  kirocrewDir: string,
  opts: { countEntries?: boolean } = {},
): KirocrewProjectInfo[] {
  return groupKiroSessionsByCwd(collectKirocrewSessions(kirocrewDir, opts));
}

/** True when `<dir>/sessions` is a directory holding at least one chat (archive counts). */
export function kirocrewStoreExists(kirocrewDir: string): boolean {
  try {
    if (!fs.statSync(path.join(kirocrewDir, KIROCREW_SESSIONS_SUBDIR)).isDirectory()) return false;
  } catch {
    return false;
  }
  return sessionPaths(kirocrewDir).length > 0;
}
