import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFileLines } from "../src/sources/read.js";

/**
 * Session files are read in chunks, so a session larger than the longest
 * string the runtime allows is still read. The lines must be exactly what
 * reading the whole file and splitting on `\r?\n` gives.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("readFileLines", () => {
  it.each([
    ["an empty file", ""],
    ["one line without a newline", '{"a":1}'],
    ["a trailing newline", "one\ntwo\n"],
    ["CRLF endings", "one\r\ntwo\r\n\r\nthree"],
    ["a lone carriage return kept inside a line", "a\rb\nc\r"],
    ["multi-byte characters", "naïve café ✓ 日本語\nsecond ✓\n"],
    ["a byte order mark", "\uFEFFfirst\nsecond"],
    ["blank lines", "\n\n\nx\n\n"],
  ])("matches a whole-file split for %s, at every chunk size", (_name, content) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-read-lines-"));
    dirs.push(dir);
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, content);
    const want = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const chunk of [1, 2, 3, 5, 64, 1024 * 1024]) {
      expect(readFileLines(file, chunk)).toEqual(want);
    }
  });

  it("throws on a file that cannot be read, like a whole-file read", () => {
    expect(() => readFileLines(path.join(os.tmpdir(), "hindsight-no-such-file.jsonl"))).toThrow();
  });
});
