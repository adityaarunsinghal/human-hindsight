import type { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { bold, cyan, dim, magenta } from "./style.js";

export interface Progress {
  update(label: string): void;
  clear(): void;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wideCharacter =
  /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]|\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: labels must not move the cursor or ring the terminal bell
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/g;

/** Labels can contain Unicode task names; never split a character or wrap the live line. */
function truncateLabel(label: string, columns: number): string {
  if (columns <= 0) return "";
  const clean = stripVTControlCharacters(label).replace(/\s+/g, " ").replace(controlCharacters, "");
  const parts = [...graphemes.segment(clean)];
  const widths = parts.map(({ segment }) =>
    /^\p{Mark}+$/u.test(segment) ? 0 : wideCharacter.test(segment) ? 2 : 1,
  );
  if (widths.reduce<number>((sum, width) => sum + width, 0) <= columns)
    return parts.map(({ segment }) => segment).join("");
  let text = "";
  let used = 0;
  for (const [index, part] of parts.entries()) {
    const width = widths[index] ?? 0;
    if (used + width > columns - 1) break;
    text += part.segment;
    used += width;
  }
  return `${text}…`;
}

/** Draw immediately; synchronous work can advance the animation between stages. */
export function startProgress(out: Writable, label: string): Progress {
  const terminal = out as Writable & { isTTY?: boolean; columns?: number };
  if (!terminal.isTTY || process.env.TERM === "dumb") {
    return { update() {}, clear() {} };
  }
  const started = Date.now();
  let lastDraw = 0;
  let frame = 0;
  let stopped = false;
  let message = label;
  const draw = () => {
    if (stopped) return;
    lastDraw = Date.now();
    const elapsed = `${((lastDraw - started) / 1000).toFixed(1)}s`;
    const glyph = ["◐", "◓", "◑", "◒"][frame++ % 4] ?? "◐";
    const dots = Array.from({ length: 5 }, (_, index) =>
      index === frame % 5 ? magenta("●") : cyan("─"),
    ).join("");
    const columns = Math.max(
      1,
      Number.isFinite(terminal.columns) && (terminal.columns ?? 0) > 0
        ? Math.floor(terminal.columns ?? 80) - 1
        : 79,
    );
    const prefix =
      columns >= 50
        ? `${magenta(glyph)} ${bold("human-hindsight")} ${dim("←")}${dots} `
        : columns >= 12
          ? `${magenta(glyph)} ${cyan("←")} `
          : magenta(glyph);
    const suffix = columns >= 12 ? ` ${dim(elapsed)}` : "";
    const available =
      columns - stripVTControlCharacters(prefix).length - stripVTControlCharacters(suffix).length;
    out.write(`\r\u001b[2K${prefix}${truncateLabel(message, available)}${suffix}`);
  };
  draw();
  const timer = setInterval(draw, 100);
  timer.unref();
  const progress: Progress = {
    update(next) {
      message = next;
      if (Date.now() - lastDraw >= 80) draw();
    },
    clear() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      process.removeListener("exit", progress.clear);
      out.write("\r\u001b[2K");
    },
  };
  process.once("exit", progress.clear);
  return progress;
}

/** Animated, elapsed-time feedback; pipes and ordinary test sinks stay unchanged. */
export async function withSpinner<T>(
  out: Writable,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const progress = startProgress(out, label);
  try {
    return await fn();
  } finally {
    progress.clear();
  }
}
