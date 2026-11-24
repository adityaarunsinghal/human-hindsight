import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "./style.js";

/**
 * ui/wrap.ts: the one word wrapper for prose on screen. It measures visible
 * width (colors and hyperlinks take no room, wide characters take two), breaks
 * only between words, and never cuts a word: a word longer than the line (a
 * URL, a path, a command) stays whole on a line of its own.
 *
 * A command a person may copy is never wrapped with the prose around it: see
 * {@link sayThenRun}, which puts it alone on its own line.
 */

export interface WrapOptions {
  /** Put before the first line. Defaults to the text's own leading spaces. */
  indent?: string;
  /** Put before every later line. Defaults to the indent. */
  hang?: string;
}

/** Word-wrap one paragraph to `width` columns. Pure. */
export function wrapText(text: string, width: number, o: WrapOptions = {}): string[] {
  // Leading spaces count even after an opening color code (`dim("  note")`).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: color codes start with an escape
  const [opening = "", styles = "", own = ""] = /^((?:\u001b\[[0-9;]*m)*)( *)/.exec(text) ?? [];
  const indent = o.indent ?? own;
  const hang = o.hang ?? indent;
  // Spaces, tabs, and line breaks separate words; a no-break space joins them.
  const words = (styles + text.slice(opening.length)).split(/[ \t\r\n]+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  let lead = indent;
  for (const word of words) {
    if (line && visibleWidth(`${lead}${line} ${word}`) > width) {
      lines.push(lead + line);
      lead = hang;
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  lines.push(lead + line);
  return lines;
}

/**
 * A sentence and the command it introduces. The sentence wraps at word
 * boundaries; the command starts its own line, two spaces further in, and is
 * never broken, even when it is wider than the terminal, so it can be copied
 * whole.
 */
export function sayThenRun(says: string, command: string, width: number): string[] {
  const indent = /^ */.exec(says)?.[0] ?? "";
  return [...wrapText(says, width), `${indent}  ${command}`];
}

/** A line that is a command to copy: it is never wrapped. */
function isCommand(line: string): boolean {
  return /^(human-hindsight|npx) /.test(stripVTControlCharacters(line).trim());
}

/**
 * Fit finished output lines to a terminal `width` (a pipe passes none and
 * keeps every line whole). A wider line wraps at word boundaries, its later
 * lines two columns in from where it starts; a command line is left whole.
 */
export function fitLines(lines: readonly string[], width: number | undefined): string[] {
  const all = lines.flatMap((line) => line.split("\n"));
  if (width === undefined) return all;
  return all.flatMap((line) => {
    if (visibleWidth(line) <= width || isCommand(line)) return [line];
    const indent = /^ */.exec(stripVTControlCharacters(line))?.[0] ?? "";
    return wrapText(line, width, { hang: `${indent}  ` });
  });
}
