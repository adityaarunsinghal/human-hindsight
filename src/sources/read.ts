import fs from "node:fs";
import type { SessionInfo, SessionSource } from "./types.js";

/** A failed store read must never become an empty corpus that prunes old exports. */
export class SourceReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceReadError";
  }
}

export function readSession(source: SessionSource, session: SessionInfo): string[] {
  return source.read ? source.read(session) : fs.readFileSync(session.path, "utf8").split(/\r?\n/);
}
