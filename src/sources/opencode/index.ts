import type { DatabaseSync } from "node:sqlite";
import { SourceReadError } from "../read.js";
import type { SessionInfo, SessionSource } from "../types.js";
import { extractOpenCodeMessages, extractOpenCodeTimeline } from "./extract.js";
import {
  discoverOpenCode,
  isOpenCodeAutomation,
  type OpenCodeSession,
  openOpenCodeDatabase,
  readLegacyOpenCode,
  readOpenCodeSession,
} from "./store.js";

function assertSession(session: SessionInfo): asserts session is OpenCodeSession {
  if (
    !("storedId" in session) ||
    typeof session.storedId !== "string" ||
    !("format" in session) ||
    !["v1", "v2", "json"].includes(String(session.format))
  ) {
    throw new SourceReadError("Invalid OpenCode session locator. Existing exports were preserved.");
  }
}

export function opencodeSource(dir: string, file: string): SessionSource {
  const handles = new Map<string, DatabaseSync>();
  return {
    name: "opencode",
    discover: (opts) => discoverOpenCode(dir, file, opts?.countEntries ?? true),
    read(info) {
      assertSession(info);
      const session = info;
      if (session.format === "json") return readLegacyOpenCode(dir, session);
      let db = handles.get(session.path);
      if (!db) {
        db = openOpenCodeDatabase(session.path);
        handles.set(session.path, db);
      }
      return readOpenCodeSession(db, session);
    },
    dispose() {
      for (const db of handles.values()) db.close();
      handles.clear();
    },
    classify(session) {
      assertSession(session);
      return isOpenCodeAutomation(session) ? "automation" : "interactive";
    },
    extract: extractOpenCodeMessages,
    timeline: extractOpenCodeTimeline,
  };
}
