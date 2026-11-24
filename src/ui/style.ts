import { stripVTControlCharacters, styleText } from "node:util";
import { canColor, glyph, lineWidth } from "./mode.js";

type Format = Parameters<typeof styleText>[0];

/** "1 task", "1,234 tasks": a count with thousands separators and its noun, singular for one. */
export function counted(n: number, noun: string, many = `${noun}s`): string {
  return `${n.toLocaleString("en-US")} ${nounFor(n, noun, many)}`;
}

/** The noun alone, singular for one: "task" or "tasks". */
export function nounFor(n: number, noun: string, many = `${noun}s`): string {
  return n === 1 ? noun : many;
}

/**
 * Only the 16 terminal colors and bold or dim, through Node's own `styleText`.
 * The decision is made here (see `canColor`), so `styleText` must not decide
 * again from `process.stdout`, which may not be the stream being written.
 */
function paint(format: Format, text: string, enabled = canColor()): string {
  if (!enabled) return text;
  return styleText(format, text, { validateStream: false });
}

export const bold = (s: string): string => paint("bold", s);
export const dim = (s: string): string => paint("dim", s);
export const green = (s: string): string => paint("green", s);
export const yellow = (s: string): string => paint("yellow", s);
export const red = (s: string): string => paint("red", s);
export const cyan = (s: string): string => paint("cyan", s);
export const magenta = (s: string): string => paint("magenta", s);

/** The same styles, decided for a given output instead of `process.stdout`. */
export function palette(enabled: boolean) {
  const style = (format: Format) => (s: string) => paint(format, s, enabled);
  return {
    bold: style("bold"),
    dim: style("dim"),
    green: style("green"),
    yellow: style("yellow"),
    red: style("red"),
    blue: style("blue"),
    cyan: style("cyan"),
    magenta: style("magenta"),
    magentaBright: style("magentaBright"),
  };
}

/** Rounded terminal choices use ordinary Unicode half circles and keep their marker without color. */
export function choicePill(
  active: boolean,
  key: string,
  label: string,
  ink: string,
  color: boolean,
): string {
  const marker = active ? glyph("›", ">") : glyph("•", "-");
  if (!color) return `( ${marker} ${key} ${label} )`;
  const fill = active ? "164;220;202" : "33;39;55";
  const foreground = active ? "21;38;31" : ink;
  const keyInk = active ? foreground : "245;215;155";
  const markerInk = active ? foreground : "156;164;191";
  return `\x1b[38;2;${fill}m${glyph("◖", "(")}\x1b[48;2;${fill};38;2;${markerInk}m${marker} \x1b[1;38;2;${keyInk}m${key}\x1b[22;38;2;${foreground}m ${label}\x1b[49;38;2;${fill}m${glyph("◗", ")")}\x1b[39m`;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wideCharacter =
  /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]|\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: preserve SGR colors but remove cursor controls from text
const styles = /(\u001b\[[0-9;]*m)/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: foreign labels must not ring the bell or move the cursor
const controls = /[\u0000-\u001f\u007f-\u009f]/g;

export function safeLine(text: string): string {
  return text
    .split(styles)
    .map((part, i) => (i % 2 ? part : stripVTControlCharacters(part).replace(controls, " ")))
    .join("");
}

/**
 * A status label on one row: whitespace runs (including line breaks and tabs)
 * become one space and other control characters are dropped, so
 * "ses\bsion" reads as "session". Colors are kept.
 */
export function oneLine(text: string): string {
  return text
    .split(styles)
    .map((part, i) =>
      i % 2 ? part : stripVTControlCharacters(part).replace(/\s+/g, " ").replace(controls, ""),
    )
    .join("");
}

function graphemeWidth(s: string): number {
  if (/^\p{Mark}+$/u.test(s)) return 0;
  return wideCharacter.test(s) ? 2 : 1;
}

export function visibleWidth(s: string): number {
  const plain = stripVTControlCharacters(s);
  if (/^[ -~]*$/.test(plain)) return plain.length;
  let width = 0;
  for (const { segment } of graphemes.segment(plain)) width += graphemeWidth(segment);
  return width;
}

/** Keep complete graphemes and reset any style still open after a cut. */
export function truncateVisible(text: string, width: number, ellipsis = glyph("…", "...")): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const suffix = ellipsis.slice(0, width);
  const limit = width - visibleWidth(suffix);
  let line = "";
  let used = 0;
  for (const [index, part] of text.split(styles).entries()) {
    if (index % 2) {
      line += part;
      continue;
    }
    for (const { segment } of graphemes.segment(part)) {
      used += graphemeWidth(segment);
      if (used > limit) return `${line}${suffix}${line.includes("\u001b[") ? "\u001b[0m" : ""}`;
      line += segment;
    }
  }
  return line;
}

/** Strip terminal styles, cursor commands and directional controls from external text. */
export function terminalText(text: string): string {
  return oneLine(stripVTControlCharacters(text).replace(/\p{Bidi_Control}/gu, "")).trim();
}

/** Plain, bounded prose from a project or model result. Keep a complete sentence or word when cutting. */
export function terminalExcerpt(text: string, width: number, ellipsis = glyph("…", "...")): string {
  const clean = terminalText(text);
  if (visibleWidth(clean) <= width) return clean;
  const clipped = truncateVisible(clean, width, ellipsis).slice(0, -ellipsis.length);
  const sentence = clipped.match(/^.*[.!?。！？](?=\s)/u)?.[0];
  if (sentence) return sentence;
  const boundary = clipped.lastIndexOf(" ");
  return `${boundary > 0 ? clipped.slice(0, boundary) : clipped}${ellipsis}`;
}

/** Render aligned columns. An uncapped pipe preserves the complete content. */
export function table(
  rows: string[][],
  opts?: { header?: string[]; maxWidth?: number; divider?: boolean },
): string {
  const header = opts?.header?.map(bold);
  const all = header ? [header, ...rows] : rows;
  if (all.length === 0) return "";
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleWidth(cell));
    });
  }
  const maxWidth = opts?.maxWidth ?? (process.stdout.isTTY ? process.stdout.columns : undefined);
  if (maxWidth !== undefined) {
    let total = widths.reduce((sum, width) => sum + width, 2 * (widths.length - 1));
    while (total > maxWidth) {
      let widest = 0;
      for (let i = 1; i < widths.length; i++) {
        if ((widths[i] ?? 0) > (widths[widest] ?? 0)) widest = i;
      }
      if ((widths[widest] ?? 0) <= 6) break;
      widths[widest] = (widths[widest] ?? 0) - 1;
      total--;
    }
  }
  const lines = all.map((row) =>
    row
      .map((cell, i) => {
        const width = widths[i] ?? 0;
        const text = truncateVisible(cell, width);
        return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
      })
      .join("  ")
      .trimEnd(),
  );
  if (header && opts?.divider !== false) {
    lines.splice(1, 0, dim(widths.map((w) => "-".repeat(w)).join("  ")));
  }
  return lines.join("\n");
}

/**
 * The suggested next command. It reads `→ next: <command>` on one line when
 * that fits; otherwise the command moves to a line of its own, whole, so it
 * can be copied even when it is wider than the terminal.
 */
export function hint(text: string, width: number | undefined = lineWidth()): string {
  const lead = `${glyph("→", "->")} next:`;
  const line = `${lead} ${text}`;
  if (width === undefined || visibleWidth(line) <= width) return dim(line);
  return `${dim(lead)}\n${dim(`  ${text}`)}`;
}

export function banner(label: string, right?: string): string {
  const rule = glyph("─", "-");
  const head = `${rule.repeat(2)} ${label} `;
  const left = `${dim(rule.repeat(2))} ${bold(magenta(label))} ${dim(rule.repeat(Math.max(1, 28 - visibleWidth(head))))}`;
  return right === undefined ? left : `${left} ${cyan(right)}`;
}

export const ok = (s: string): string => `${green(glyph("✔", "[ok]"))} ${s}`;
export const fail = (s: string): string => `${red(glyph("✗", "[failed]"))} ${s}`;
export const skip = (s: string): string => `${yellow(glyph("⤬", "[skip]"))} ${s}`;
