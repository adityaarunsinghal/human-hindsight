import os from "node:os";
import { describe, expect, it } from "vitest";
import { escapeSequences, goldenText, normalizeText, stripEscapes } from "./text.js";

const ESC = "\u001b";

describe("stripEscapes and escapeSequences", () => {
  it.each([
    ["color", `${ESC}[1;32mok${ESC}[0m`, "ok", [`${ESC}[1;32m`, `${ESC}[0m`]],
    ["cursor and erase", `a${ESC}[2K${ESC}[1Ab`, "ab", [`${ESC}[2K`, `${ESC}[1A`]],
    [
      "private mode",
      `${ESC}[?2026h${ESC}[?25lx${ESC}[?25h`,
      "x",
      [`${ESC}[?2026h`, `${ESC}[?25l`, `${ESC}[?25h`],
    ],
    [
      "hyperlink",
      `${ESC}]8;;https://example.test${ESC}\\link${ESC}]8;;${ESC}\\`,
      "link",
      [`${ESC}]8;;https://example.test${ESC}\\`, `${ESC}]8;;${ESC}\\`],
    ],
    ["title with bell", `${ESC}]0;title\u0007text`, "text", [`${ESC}]0;title\u0007`]],
    ["save and restore", `${ESC}7mid${ESC}8`, "mid", [`${ESC}7`, `${ESC}8`]],
    ["plain", "no escapes here", "no escapes here", []],
  ])("%s", (_name, input, visible, sequences) => {
    expect(stripEscapes(input)).toBe(visible);
    expect(escapeSequences(input)).toEqual(sequences);
  });
});

describe("normalizeText", () => {
  it("replaces generation ids, timestamps, and UUIDs", () => {
    const text =
      "generation 20260102T030405Z-ab12 at 2026-01-02T03:04:05.678Z " +
      "and 2026-01-02T03:04:05+01:00, op 0b5c1c8e-1d2f-4a3b-8c4d-5e6f7a8b9c0d";
    expect(normalizeText(text)).toBe(
      "generation <GENERATION> at <TIMESTAMP> and <TIMESTAMP>, op <UUID>",
    );
  });

  it("replaces the temp folder and its random first segment", () => {
    const text = `saved in ${os.tmpdir()}/hh-home-x1y2z3/exports/a.md`;
    expect(normalizeText(text)).toBe("saved in <TMP>/exports/a.md");
    expect(normalizeText(text, { tempPaths: false })).toBe(text);
  });

  it("replaces explicit roots, longest first", () => {
    const text = "/data/home/library and /data/other";
    expect(normalizeText(text, { roots: { "/data": "<DATA>", "/data/home": "<HOME>" } })).toBe(
      "<HOME>/library and <DATA>/other",
    );
  });

  it("leaves dates without a time and short hex alone", () => {
    expect(normalizeText("released 2026-01-02, commit ab12cd3")).toBe(
      "released 2026-01-02, commit ab12cd3",
    );
  });
});

describe("goldenText", () => {
  it("strips escapes, normalizes, and trims trailing spaces", () => {
    expect(goldenText(`${ESC}[1mdone${ESC}[0m   \nat 2026-01-02T03:04:05Z  \n`)).toBe(
      "done\nat <TIMESTAMP>\n",
    );
  });
});
