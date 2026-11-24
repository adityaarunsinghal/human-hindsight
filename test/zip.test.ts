import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SuggestionArtifact } from "../src/core/subagents.js";
import { renderSubagentTree } from "../src/core/subagents-render.js";
import { unzipStore, zipStore } from "../src/core/zip.js";

const decoder = new TextDecoder();
const SAMPLE = path.join(import.meta.dirname, "fixtures", "subagents", "suggestion.sample.json");

/** Unix mode bits of one entry from the central directory (upper 16 bits of the external attributes). */
function unixMode(zip: Uint8Array, name: string): number {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let at = 0; at + 46 <= zip.length; at++) {
    if (view.getUint32(at, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(at + 28, true);
    if (decoder.decode(zip.subarray(at + 46, at + 46 + nameLength)) !== name) continue;
    const madeBy = view.getUint16(at + 4, true) >> 8; // 3 = Unix
    return madeBy === 3 ? view.getUint32(at + 38, true) >>> 16 : 0;
  }
  throw new Error(`no central entry for ${name}`);
}

function texts(files: Map<string, Uint8Array>): Record<string, string> {
  return Object.fromEntries([...files].map(([name, data]) => [name, decoder.decode(data)]));
}

describe("store-only zip", () => {
  it("round-trips text and bytes, in sorted name order", () => {
    const bytes = zipStore(
      new Map<string, string | Uint8Array>([
        ["b/second.md", "second\n"],
        ["a.txt", "first"],
        ["c/bin.dat", new Uint8Array([0, 255, 10, 13])],
      ]),
    );
    const files = unzipStore(bytes);
    expect([...files.keys()]).toEqual(["a.txt", "b/second.md", "c/bin.dat"]);
    expect(decoder.decode(files.get("b/second.md"))).toBe("second\n");
    expect([...(files.get("c/bin.dat") ?? [])]).toEqual([0, 255, 10, 13]);
  });

  it("writes a valid empty archive", () => {
    const bytes = zipStore(new Map());
    expect(bytes.length).toBe(22);
    expect(unzipStore(bytes).size).toBe(0);
  });

  it("keeps non-ASCII names and sets the UTF-8 flag", () => {
    const bytes = zipStore(new Map([["résumé/日本語.md", "ok"]]));
    expect(texts(unzipStore(bytes))).toEqual({ "résumé/日本語.md": "ok" });
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
    expect(view.getUint16(8, true)).toBe(0);
  });

  it("is byte-identical for identical input and changes with mtime", () => {
    const files = new Map([["x.md", "same"]]);
    expect(zipStore(files)).toEqual(zipStore(new Map([["x.md", "same"]])));
    expect(zipStore(files, { mtime: new Date("2026-11-21T12:00:00Z") })).not.toEqual(
      zipStore(files),
    );
  });

  it("refuses more than 65535 entries and files of 4 GiB or more", () => {
    const many = new Map(Array.from({ length: 65536 }, (_, i): [string, string] => [`f${i}`, ""]));
    expect(() => zipStore(many)).toThrow(/at most 65535 entries/);
    const huge = { length: 2 ** 32 } as unknown as Uint8Array;
    expect(() => zipStore(new Map([["huge.bin", huge]]))).toThrow(/4 GiB/);
  });

  it("refuses unsafe entry names", () => {
    for (const name of ["/abs.txt", "../up.txt", "a/../b", "a//b", "a\\b", ""]) {
      expect(() => zipStore(new Map([[name, "x"]]))).toThrow(/unsafe zip entry/);
    }
  });

  it("keeps each entry's file mode: the exported tree's create-bots.sh unzips executable", () => {
    // `--export` writes the script owner-executable and HANDOFF says to run
    // it; the Export all zip of the same tree must carry the same mode.
    const artifact = JSON.parse(fs.readFileSync(SAMPLE, "utf8")) as SuggestionArtifact;
    const files = renderSubagentTree(artifact, { target: "all" });
    const zip = zipStore(files);
    expect(unixMode(zip, "kirocrew/create-bots.sh")).toBe(0o100700);
    expect(unixMode(zip, "README.md")).toBe(0o100600);
    expect(unixMode(zipStore(files, { mode: () => 0o644 }), "README.md")).toBe(0o100644);
  });

  it("detects a damaged entry", () => {
    const bytes = zipStore(new Map([["x.md", "content"]]));
    const damaged = bytes.slice();
    const at = 30 + "x.md".length;
    damaged[at] = (damaged[at] ?? 0) ^ 0xff;
    expect(() => unzipStore(damaged)).toThrow(/CRC mismatch/);
    expect(() => unzipStore(new Uint8Array(10))).toThrow(/Not a zip/);
  });
});
