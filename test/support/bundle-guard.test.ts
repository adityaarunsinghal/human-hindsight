import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundleSources,
  bundleVerdict,
  checkGuiBundle,
  GENERATED,
  relativeImports,
} from "./bundle-guard.js";

describe("bundleVerdict", () => {
  const sources = [
    { file: "src/gui/client.ts", mtimeMs: 100 },
    { file: "src/gui/icons.ts", mtimeMs: 90 },
  ];
  it.each([
    ["missing bundle", null, sources, `${GENERATED} is missing: run \`npm run build\`.`],
    ["bundle newer than every source", 200, sources, null],
    ["bundle as new as the newest source", 100, sources, null],
    [
      "one source newer",
      95,
      sources,
      `${GENERATED} is older than src/gui/client.ts: run \`npm run build\`.`,
    ],
    [
      "two sources newer",
      50,
      sources,
      `${GENERATED} is older than src/gui/client.ts and 1 more: run \`npm run build\`.`,
    ],
    ["no sources", 1, [], null],
  ])("%s", (_name, generatedMtimeMs, list, message) => {
    const verdict = bundleVerdict({ generatedMtimeMs, sources: list });
    expect(verdict).toEqual(message === null ? { ok: true } : { ok: false, message });
  });

  it("the message is one line", () => {
    const verdict = bundleVerdict({ generatedMtimeMs: 1, sources });
    expect(verdict.ok ? "" : verdict.message).not.toContain("\n");
  });
});

describe("relativeImports", () => {
  it("keeps code imports and skips type-only ones and packages", () => {
    const text = [
      'import { a } from "./a.js";',
      'import type { B } from "./b.js";',
      "import {",
      "  type C,",
      "  d,",
      '} from "../core/d.js";',
      'export { e } from "./e.js";',
      'export type { F } from "./f.js";',
      'import "./side-effect.js";',
      'const lazy = await import("./lazy.js");',
      'import { marked } from "marked";',
    ].join("\n");
    expect(relativeImports(text).sort()).toEqual(
      ["../core/d.js", "./a.js", "./e.js", "./lazy.js", "./side-effect.js"].sort(),
    );
  });
});

describe("bundleSources and checkGuiBundle on a synthetic checkout", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function checkout(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-guard-"));
    const write = (file: string, text: string, mtime: number) => {
      const full = path.join(dir, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text);
      fs.utimesSync(full, mtime, mtime);
    };
    write(
      "src/gui/client.ts",
      'import { x } from "./x.js";\nimport type { T } from "../core/t.js";\n',
      1000,
    );
    write("src/gui/x.ts", 'import { y } from "../core/y.js";\n', 1000);
    write("src/core/y.ts", "export const y = 1;\n", 1000);
    write("src/core/t.ts", "export type T = 1;\n", 5000);
    write(GENERATED, "export const GUI_JS = '';\n", 2000);
    return dir;
  }

  it("follows code imports across folders and ignores type-only ones", () => {
    root = checkout();
    expect(bundleSources(root)).toEqual(["src/core/y.ts", "src/gui/client.ts", "src/gui/x.ts"]);
  });

  it("passes a fresh bundle, fails a stale one, and fails a missing one", () => {
    root = checkout();
    expect(() => checkGuiBundle(root as string)).not.toThrow();
    fs.utimesSync(path.join(root, "src/core/y.ts"), 3000, 3000);
    expect(() => checkGuiBundle(root as string)).toThrow(
      `${GENERATED} is older than src/core/y.ts: run \`npm run build\`.`,
    );
    fs.rmSync(path.join(root, GENERATED));
    expect(() => checkGuiBundle(root as string)).toThrow(/is missing/);
  });
});
