import type { Writable } from "node:stream";
import { liveRegion } from "./live.js";
import {
  canColor,
  glyph,
  isPlainMode,
  type TerminalEnv,
  type TerminalOutput,
  terminalWidth,
} from "./mode.js";
import { oneLine, palette, truncateVisible, visibleWidth } from "./style.js";

export interface Progress {
  update(label: string): void;
  clear(): void;
}

/**
 * One live row for an operation with no unit counts. Legacy pipes retain their
 * command output. `plainLine: false` is for a step another line already
 * announces: plain mode then prints nothing for it.
 */
export function startProgress(
  out: Writable,
  label: string,
  o: { env?: TerminalEnv; now?(): number; plainLine?: boolean } = {},
): Progress {
  const env = o.env ?? process.env;
  const now = o.now ?? Date.now;
  const region = liveRegion(out, { env, now });
  if (!region) {
    // Plain mode on a terminal still says what is happening, once, without redraws.
    const terminal: TerminalOutput = out;
    if (
      o.plainLine !== false &&
      terminal.isTTY === true &&
      env.TERM !== "dumb" &&
      isPlainMode(env)
    ) {
      out.write(`${oneLine(label)}\n`);
    }
    return { update() {}, clear() {} };
  }
  const { bold, cyan, dim, magenta } = palette(canColor({ output: out, env }));
  const mark = (unicode: string, ascii: string) => glyph(unicode, ascii, env);
  const started = now();
  const frames = mark("◐◓◑◒", "|/-\\");
  let frame = 0;
  let message = label;
  let stopped = false;
  function draw(): void {
    if (stopped) return;
    const columns = Math.max(1, terminalWidth(out) - 1);
    const spinner = magenta(frames[frame++ % frames.length] ?? "|");
    const trail = Array.from({ length: 5 }, (_, index) =>
      index === frame % 5 ? magenta(mark("●", "*")) : cyan(mark("─", "-")),
    ).join("");
    const prefix =
      columns >= 50
        ? `${spinner} ${bold("human-hindsight")} ${dim(mark("←", "<"))}${trail} `
        : columns >= 12
          ? `${spinner} ${cyan(mark("←", "<"))} `
          : spinner;
    const elapsed = `${((now() - started) / 1000).toFixed(1)}s`;
    const suffix = columns >= 12 ? ` ${dim(elapsed)}` : "";
    const available = Math.max(0, columns - visibleWidth(prefix) - visibleWidth(suffix));
    region?.render([`${prefix}${truncateVisible(oneLine(message), available)}${suffix}`]);
  }
  draw();
  const timer = setInterval(draw, 100);
  timer.unref();
  return {
    update(next) {
      message = next;
      draw();
    },
    clear() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      region.stop();
    },
  };
}

export async function withSpinner<T>(
  out: Writable,
  label: string,
  fn: () => Promise<T>,
  o: { plainLine?: boolean } = {},
): Promise<T> {
  const progress = startProgress(out, label, o);
  try {
    return await fn();
  } finally {
    progress.clear();
  }
}
