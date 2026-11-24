import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { SessionInfo, SessionSource } from "./types.js";

/** A failed store read must never become an empty corpus that prunes old exports. */
export class SourceReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceReadError";
  }
}

/** True for a plain object (not null, not an array): a record read from a store. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whitespace collapsed and capped at 120 characters: the snippet a Drop carries. */
export function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

const CHUNK_BYTES = 1024 * 1024;

/**
 * The lines of a UTF-8 file, exactly as `readFileSync(file, "utf8").split(/\r?\n/)`
 * gives them, read in fixed-size chunks so a session larger than the longest
 * string the runtime allows is still read (only each line must fit). Throws on
 * an unreadable file, like `readFileSync`. `chunkBytes` exists for tests.
 */
export function readFileLines(file: string, chunkBytes = CHUNK_BYTES): string[] {
  const fd = fs.openSync(file, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(Math.max(1, chunkBytes));
    const lines: string[] = [];
    let partial = "";
    // Split each chunk on its own; a line that spans chunks is joined once.
    const take = (text: string) => {
      const pieces = text.split("\n");
      const last = pieces.pop() ?? "";
      for (const [i, piece] of pieces.entries()) {
        const line = i === 0 ? partial + piece : piece;
        lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
      }
      partial = pieces.length ? last : partial + last;
    };
    for (let bytes = fs.readSync(fd, buffer); bytes > 0; bytes = fs.readSync(fd, buffer)) {
      take(decoder.write(buffer.subarray(0, bytes)));
    }
    take(decoder.end());
    lines.push(partial);
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

export function readSession(source: SessionSource, session: SessionInfo): string[] {
  return source.read ? source.read(session) : readFileLines(session.path);
}
