import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { SourceReadError } from "../read.js";
import type { ProjectInfo, SessionInfo } from "../types.js";
import { OPENCODE_DISTILL_MARKER, object } from "./extract.js";

type Format = "v1" | "v2" | "json";
export interface OpenCodeSession extends SessionInfo {
  id: string;
  storedId: string;
  format: Format;
  directory: string;
  title: string;
  parentId: string | null;
  revert?: string;
}

const require = createRequire(import.meta.url);

function failure(file: string, detail: string): SourceReadError {
  return new SourceReadError(
    `Cannot read OpenCode store ${file}: ${detail}. Existing exports were preserved.`,
  );
}

/** Lazy import keeps SQLite (and its experimental warning on Node 22) out of other commands. */
export function openOpenCodeDatabase(file: string): DatabaseSync {
  let database: DatabaseSync | undefined;
  try {
    const sqlite = require("node:sqlite") as typeof import("node:sqlite");
    database = new sqlite.DatabaseSync(file, { readOnly: true, allowExtension: false });
    database.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000;");
    return database;
  } catch (error) {
    database?.close();
    const code = (error as NodeJS.ErrnoException).code;
    throw failure(
      file,
      code === "ERR_UNKNOWN_BUILTIN_MODULE"
        ? "Node SQLite is unavailable; upgrade Node"
        : (code ?? "database unavailable"),
    );
  }
}

function columns(db: DatabaseSync, table: string): Set<string> {
  // Table names here are internal constants, never user input.
  return new Set(
    db
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((row) => String(row.name)),
  );
}

function requireColumns(
  db: DatabaseSync,
  table: string,
  expected: string[],
  file: string,
): Set<string> {
  const found = columns(db, table);
  if (expected.some((column) => !found.has(column))) {
    throw failure(file, `unsupported ${table} schema; update Human Hindsight`);
  }
  return found;
}

function formats(db: DatabaseSync, file: string): ("v1" | "v2")[] {
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => String(row.name)),
  );
  const result: ("v1" | "v2")[] = [];
  if (tables.has("session_v2")) {
    requireColumns(
      db,
      "session_message",
      ["id", "session_id", "seq", "type", "data", "time_created"],
      file,
    );
    result.push("v2");
  }
  if (tables.has("session")) {
    requireColumns(db, "message", ["id", "session_id", "data", "time_created"], file);
    requireColumns(db, "part", ["id", "session_id", "message_id", "data"], file);
    result.push("v1");
  }
  if (!result.length) throw failure(file, "unrecognized or uninitialized database");
  if (tables.has("session_v2") && tables.has("kv")) {
    const state = db.prepare("SELECT value FROM kv WHERE key=?").get("migration.v1-v2");
    if (state) {
      const value = payload(state.value);
      if (value?.phase !== "completed") {
        throw failure(file, "OpenCode migration is incomplete; finish it in OpenCode first");
      }
    }
  }
  return result;
}

function payload(value: unknown): Record<string, unknown> | undefined {
  try {
    return object(typeof value === "string" ? JSON.parse(value) : value);
  } catch {
    return undefined;
  }
}

function persistedFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) throw failure(file, "expected a database file");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if (error instanceof SourceReadError) throw error;
    throw failure(file, "file is inaccessible");
  }
}

function readInventory(db: DatabaseSync, file: string, count: boolean): OpenCodeSession[] {
  const sessions: OpenCodeSession[] = [];
  for (const format of formats(db, file)) {
    const table = format === "v2" ? "session_v2" : "session";
    const message = format === "v2" ? "session_message" : "message";
    const fields = requireColumns(db, table, ["id", "directory", "time_updated"], file);
    const optional = (key: string) => (fields.has(key) ? `s.${key}` : `NULL AS ${key}`);
    const query = `SELECT s.id, s.directory, s.time_updated, ${optional("title")}, ${optional("parent_id")}, ${optional("revert")},
      ${count ? "coalesce(n.entries, 0)" : "0"} AS entries FROM ${table} s
      ${count ? `LEFT JOIN (SELECT session_id, count(*) AS entries FROM ${message} GROUP BY session_id) n ON n.session_id=s.id` : ""}
      ORDER BY s.id`;
    for (const row of db.prepare(query).all()) {
      if (typeof row.id !== "string" || typeof row.directory !== "string") {
        throw failure(file, "invalid session metadata");
      }
      sessions.push({
        id: row.id,
        storedId: row.id,
        file: row.id,
        path: file,
        key: `${pathToFileURL(file).href}#${format}/${encodeURIComponent(row.id)}`,
        format,
        directory: row.directory || "(unknown)",
        title: typeof row.title === "string" ? row.title : "",
        parentId: typeof row.parent_id === "string" ? row.parent_id : null,
        revert: typeof row.revert === "string" ? row.revert : undefined,
        entryCount: Number(row.entries),
        mtime: new Date(Number(row.time_updated) || 0),
      });
    }
  }
  return sessions;
}

function files(dir: string): fs.Dirent[] {
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) throw failure(dir, "symlinked history directory");
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw failure(dir, "directory is inaccessible");
  }
}

function jsonFile(file: string): Record<string, unknown> {
  try {
    const value = payload(fs.readFileSync(file, "utf8"));
    if (value) return value;
  } catch {
    // Do not print JSON parser errors, which can contain private prompt text.
  }
  throw failure(file, "unreadable or malformed session JSON");
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
}

function legacySessions(dir: string, count: boolean): OpenCodeSession[] {
  const sessions: OpenCodeSession[] = [];
  for (const project of files(path.join(dir, "storage", "session"))) {
    if (!project.isDirectory()) continue;
    const root = path.join(dir, "storage", "session", project.name);
    for (const entry of files(root)) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const file = path.join(root, entry.name);
      const info = jsonFile(file);
      if (!safeId(info.id) || typeof info.directory !== "string")
        throw failure(file, "invalid session metadata");
      sessions.push({
        id: info.id,
        storedId: info.id,
        file: entry.name,
        path: file,
        key: `${pathToFileURL(file).href}#json/${encodeURIComponent(info.id)}`,
        format: "json",
        directory: info.directory || "(unknown)",
        title: typeof info.title === "string" ? info.title : "",
        parentId: typeof info.parentID === "string" ? info.parentID : null,
        revert: info.revert ? JSON.stringify(info.revert) : undefined,
        entryCount: count
          ? files(path.join(dir, "storage", "message", info.id)).filter(
              (p) => p.isFile() && p.name.endsWith(".json"),
            ).length
          : 0,
        mtime: new Date(Number(object(info.time)?.updated) || fs.statSync(file).mtimeMs),
      });
    }
  }
  return sessions;
}

/** Inventory includes archives; parent sessions and automation are classified separately. */
export function discoverOpenCode(dir: string, file: string, count = true): ProjectInfo[] {
  if (file === ":memory:") return [];
  let sessions: OpenCodeSession[] = [];
  if (persistedFile(file)) {
    const db = openOpenCodeDatabase(file);
    try {
      db.exec("BEGIN");
      sessions = readInventory(db, file, count);
    } catch (error) {
      if (error instanceof SourceReadError) throw error;
      throw failure(file, "database query failed or the store is busy");
    } finally {
      db.close();
    }
  }
  sessions.push(...legacySessions(dir, count));
  // V2 is canonical for migrated IDs. Divergent v1/JSON copies keep distinct
  // export names; the shared corpus deduper removes only identical human turns.
  const usedIds = new Set<string>();
  for (const session of sessions) {
    if (usedIds.has(session.id)) session.id = `${session.id}-${session.format}`;
    usedIds.add(session.id);
  }
  const grouped = new Map<string, OpenCodeSession[]>();
  for (const session of sessions) {
    const group = grouped.get(session.directory) ?? [];
    group.push(session);
    grouped.set(session.directory, group);
  }
  const usedNames = new Set<string>();
  return [...grouped]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([directory, entries]) => {
      entries.sort((a, b) => b.mtime.getTime() - a.mtime.getTime() || a.id.localeCompare(b.id));
      const base = path.posix.basename(directory.replaceAll("\\", "/")) || "opencode";
      let shortName = base;
      for (let suffix = 2; usedNames.has(shortName); suffix++) shortName = `${base}-${suffix}`;
      usedNames.add(shortName);
      return {
        dirName: directory,
        decodedPath: directory,
        shortName,
        sessions: entries,
        entryTotal: entries.reduce((sum, session) => sum + session.entryCount, 0),
        latestMtime: entries[0]?.mtime,
      };
    });
}

function beforeRevert<T>(entries: T[], revert: string | undefined, id: (entry: T) => unknown): T[] {
  const boundary = payload(revert)?.messageID;
  if (typeof boundary !== "string") return entries;
  const index = entries.findIndex((entry) => id(entry) === boundary);
  return index < 0 ? entries : entries.slice(0, index);
}

export function readOpenCodeSession(db: DatabaseSync, session: OpenCodeSession): string[] {
  const file = session.path;
  let began = false;
  try {
    db.exec("BEGIN");
    began = true;
    formats(db, file);
    const table = session.format === "v2" ? "session_v2" : "session";
    const fields = columns(db, table);
    const current = db
      .prepare(
        `SELECT id, ${fields.has("revert") ? "revert" : "NULL AS revert"} FROM ${table} WHERE id=?`,
      )
      .get(session.storedId);
    if (!current) throw failure(file, "a session changed during export; retry with a stable store");
    const revert = typeof current.revert === "string" ? current.revert : undefined;
    if (session.format === "v2") {
      const rows = db
        .prepare(
          "SELECT id, type, data, time_created FROM session_message WHERE session_id=? ORDER BY seq",
        )
        .all(session.storedId);
      return beforeRevert(rows, revert, (row) => row.id).map((row) => {
        const data = payload(row.data);
        return data
          ? JSON.stringify({
              format: "v2",
              info: { ...data, id: row.id, type: row.type },
              time: row.time_created,
            })
          : "{";
      });
    }
    const rows = db
      .prepare(
        "SELECT id, data, time_created FROM message WHERE session_id=? ORDER BY time_created, id",
      )
      .all(session.storedId);
    const parts = new Map<string, unknown[]>();
    const bad = new Map<string, number>();
    for (const row of db
      .prepare("SELECT id, message_id, data FROM part WHERE session_id=? ORDER BY id")
      .all(session.storedId)) {
      const key = String(row.message_id);
      const data = payload(row.data);
      if (!data) {
        bad.set(key, (bad.get(key) ?? 0) + 1);
        continue;
      }
      const list = parts.get(key) ?? [];
      list.push({ ...data, id: row.id });
      parts.set(key, list);
    }
    return beforeRevert(rows, revert, (row) => row.id).map((row) => {
      const data = payload(row.data);
      return data
        ? JSON.stringify({
            format: "v1",
            info: { ...data, id: row.id },
            time: row.time_created,
            parts: parts.get(String(row.id)) ?? [],
            badParts: bad.get(String(row.id)) ?? 0,
          })
        : "{";
    });
  } catch (error) {
    if (error instanceof SourceReadError) throw error;
    throw failure(file, "session query failed or the store is busy");
  } finally {
    if (began) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Source disposal closes the handle even if the connection has failed.
      }
    }
  }
}

export function readLegacyOpenCode(dir: string, session: OpenCodeSession): string[] {
  const root = path.join(dir, "storage", "message", session.storedId);
  const messages = files(root)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => jsonFile(path.join(root, entry.name)))
    .sort(
      (a, b) =>
        Number(object(a.time)?.created ?? 0) - Number(object(b.time)?.created ?? 0) ||
        String(a.id).localeCompare(String(b.id)),
    );
  return beforeRevert(messages, session.revert, (message) => message.id).map((info) => {
    if (!safeId(info.id)) throw failure(root, "invalid message ID");
    const partsRoot = path.join(dir, "storage", "part", info.id);
    const parts = files(partsRoot)
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => jsonFile(path.join(partsRoot, entry.name)));
    return JSON.stringify({ format: "v1", info, parts });
  });
}

export function isOpenCodeAutomation(session: OpenCodeSession): boolean {
  return (
    Boolean(session.parentId) ||
    /^\[(?:human|cc)-hindsight distill\]/.test(session.title) ||
    session.title.startsWith(OPENCODE_DISTILL_MARKER)
  );
}
