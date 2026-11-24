import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Words a person reads in the tree (comments, test titles, printed text) use
 * no em dash or en dash. Text sent to a model keeps its exact bytes, and
 * recorded tool output stays as recorded, so those places are left alone.
 */

const root = path.resolve(import.meta.dirname, "..");
const FOLDERS = ["src", "test", "scripts", "launcher", ".github"];
/** Text sent to a model, recorded tool output, and a source owned elsewhere. */
const LEFT_ALONE = ["src/distill/prompts/", "src/eval/", "src/sources/kirocrew/", "test/fixtures/"];
/** Single lines that carry model-facing text or recorded transcript text. */
const MODEL_OR_RECORDED_LINES: [string, string][] = [
  ["src/runners/shared.ts", "Your previous response could not be used"],
  ["test/author.test.ts", "verbatim choices"],
  ["test/pipeline.test.ts", "All done"],
  ["test/extract.test.ts", "Typed by a human in VS Code"],
];

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(full);
    return /\.(ts|mjs|cjs|js|py|yml|yaml)$/.test(entry.name) ? [full] : [];
  });
}

describe("text a person reads in the tree", () => {
  it("has no em dash or en dash outside model-facing and recorded text", () => {
    const found: string[] = [];
    for (const folder of FOLDERS) {
      const start = path.join(root, folder);
      if (!fs.existsSync(start)) continue;
      for (const file of files(start)) {
        const relative = path.relative(root, file).split(path.sep).join("/");
        if (LEFT_ALONE.some((prefix) => relative.startsWith(prefix))) continue;
        fs.readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, index) => {
            if (!/[\u2013\u2014]/.test(line)) return;
            const allowed = MODEL_OR_RECORDED_LINES.some(
              ([where, marker]) => where === relative && line.includes(marker),
            );
            if (!allowed) found.push(`${relative}:${index + 1}`);
          });
      }
    }
    expect(found).toEqual([]);
  });
});
