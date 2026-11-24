import fs from "node:fs";
import os from "node:os";

/**
 * test/support/text.ts: make terminal text comparable.
 *
 * `stripEscapes` removes ANSI control sequences (CSI such as colors, cursor
 * moves and private modes, OSC such as hyperlinks and window titles, and the
 * short two-byte escapes such as save and restore cursor, `ESC 7` and `ESC 8`).
 *
 * `normalizeText` replaces values that change from run to run with stable
 * placeholders so a golden file only changes when the meaning changes:
 *
 *   generation ids  20260102T030405Z-ab12      -> <GENERATION>
 *   ISO timestamps  2026-01-02T03:04:05.678Z    -> <TIMESTAMP>
 *   UUIDs           0b5c1c8e-....-............  -> <UUID>
 *   temp paths      /var/folders/../T/hh-x1/a   -> <TMP>/a
 *   extra roots     any path passed in `roots`  -> its placeholder
 *
 * Usage in a golden test:
 *
 *   const text = normalizeText(stripEscapes(out.text()), { roots: { [home]: "<HOME>" } });
 *   await expect(text).toMatchFileSnapshot("../golden/area/name.txt");
 */

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI8 = String.fromCharCode(0x9b);
/** CSI, OSC, and short ESC sequences, in that order of precedence. */
const ESCAPES = new RegExp(
  [
    `${ESC}\\[[0-?]*[ -/]*[@-~]`,
    `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
    `${ESC}[0-?@-Z\\\\-_]`,
    `${CSI8}[0-?]*[ -/]*[@-~]`,
  ].join("|"),
  "g",
);

/** Remove every terminal escape sequence, keeping the visible text. */
export function stripEscapes(text: string): string {
  return text.replace(ESCAPES, "");
}

/** Every escape sequence in `text`, in order of appearance. */
export function escapeSequences(text: string): string[] {
  return text.match(ESCAPES) ?? [];
}

export interface NormalizeOptions {
  /**
   * Extra literal prefixes to replace, longest first. Map value is the
   * placeholder, for example `{ [home]: "<HOME>" }`.
   */
  roots?: Record<string, string>;
  /** Also replace the system temp folder (default true). */
  tempPaths?: boolean;
}

const GENERATION = /\b\d{8}T\d{6}Z-[0-9a-f]{4}\b/g;
const TIMESTAMP = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The system temp folder, both as configured and as resolved through symlinks. */
function tempRoots(): string[] {
  const configured = os.tmpdir().replace(/\/+$/, "");
  const roots = new Set([configured]);
  try {
    roots.add(fs.realpathSync(configured));
  } catch {
    // An unreadable temp folder still has its configured spelling.
  }
  return [...roots].sort((a, b) => b.length - a.length);
}

/** Replace run-specific values with placeholders (see the header for the list). */
export function normalizeText(text: string, options: NormalizeOptions = {}): string {
  let out = text;
  const roots = Object.entries(options.roots ?? {}).sort(([a], [b]) => b.length - a.length);
  for (const [root, placeholder] of roots) {
    if (root) out = out.split(root).join(placeholder);
  }
  if (options.tempPaths !== false) {
    for (const root of tempRoots()) {
      // The first segment under the temp folder is a random mkdtemp name.
      out = out.replace(new RegExp(`${escapeRegExp(root)}/[^/\\s"'\`]+`, "g"), "<TMP>");
    }
  }
  return out
    .replace(GENERATION, "<GENERATION>")
    .replace(TIMESTAMP, "<TIMESTAMP>")
    .replace(UUID, "<UUID>");
}

/** Strip escapes, normalize, and trim trailing spaces on every line. */
export function goldenText(text: string, options: NormalizeOptions = {}): string {
  return normalizeText(stripEscapes(text), options)
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
}
