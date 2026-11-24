import type { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import type { StageItem, StageProgressSink } from "../distill/stage-events.js";
import { type LiveRegion, liveRegion, type TerminalHost, writeAbove } from "./live.js";
import { canColor, glyph, type TerminalEnv, terminalWidth } from "./mode.js";
import { bold, cyan, dim, green, palette, safeLine, table, visibleWidth, yellow } from "./style.js";
import { wrapText } from "./wrap.js";

const rail = (line: string): string => `${dim(glyph("│", "|"))} ${line}`;

/**
 * One line of a card: the left rail, then the text. A blank line keeps the
 * rail and nothing after it, so the rail runs unbroken down the card.
 */
export function railLine(line = ""): string {
  return line ? rail(line) : dim(glyph("│", "|"));
}

export function heading(title: string, subtitle?: string): string {
  const lines = [rail(bold(title))];
  if (subtitle) lines.push(rail(dim(subtitle)));
  return lines.join("\n");
}

export function summary(title: string, lines: string[]): string[] {
  return [heading(title), ...lines.map(rail)];
}

export interface SetupRow {
  tool: string;
  history: string;
  command: string;
  signIn?: string;
  /** A sentence about this tool, printed under its row and wrapped to the width. */
  note?: string;
  /**
   * The widest text each cell can take while its facts arrive (pending or
   * settled). Columns and row heights are measured on it too, so a live
   * table keeps its height from the first paint on.
   */
  reserve?: { history?: string; command?: string; signIn?: string };
}

function status(text: string): string {
  if (/^[✓✔]/u.test(text)) return green(text.replace(/^[✓✔]/u, glyph("✓", "+")));
  if (text.startsWith("!")) return yellow(text);
  if (text.startsWith("?") || /checking|counting|no history|uses /i.test(text)) return dim(text);
  return text;
}

function wrapCell(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (current && visibleWidth(`${current} ${word}`) > width) {
      lines.push(current);
      current = "";
    }
    if (current) current += " ";
    for (const c of word) {
      if (current && visibleWidth(current + c) > width) {
        lines.push(current);
        current = "";
      }
      current += c;
    }
  }
  return [...lines, current];
}

/** Wrap the cells before painting so a long sign-in command remains readable. */
export function setupTable(rows: SetupRow[], width: number): string[] {
  const header = ["Tool", "History on disk", "Command", "Sign-in"];
  const usable = Math.max(1, Math.floor(width) - 3);
  const clean = (value: string) =>
    // Without Unicode the rail is "|", so the dot between two facts becomes a comma.
    safeLine(stripVTControlCharacters(value))
      .replaceAll(" · ", glyph(" · ", ", "))
      .replaceAll("…", glyph("…", "..."));
  const records = rows.map((row) =>
    [row.tool, row.history, row.command, row.signIn ?? ""].map(clean),
  );
  // The widest each cell can be; without a reserve, the cell as it is.
  const reserved = rows.map((row, index) =>
    [row.tool, row.reserve?.history, row.reserve?.command, row.reserve?.signIn].map((value, i) =>
      value === undefined ? (records[index]?.[i] ?? "") : clean(value),
    ),
  );
  /** Lines a cell takes at `width`: its own or its widest text's, whichever is more. */
  const cellHeight = (index: number, i: number, width: number) =>
    Math.max(
      wrapCell(records[index]?.[i] ?? "", width).length,
      wrapCell(reserved[index]?.[i] ?? "", width).length,
    );
  // One tool per block, each fact on its own indented line.
  const notes = rows.map((row) => (row.note ? safeLine(stripVTControlCharacters(row.note)) : ""));
  const noteLines = (index: number, indent: number) =>
    notes[index]
      ? wrapText(notes[index] ?? "", Math.max(10, usable - indent)).map((line) =>
          rail(`${" ".repeat(indent)}${dim(line)}`),
        )
      : [];
  const stacked = () =>
    records.flatMap(([tool, ...cells], index) => [
      rail(cyan(tool ?? "")),
      ...cells.flatMap((cell, at) => {
        const i = at + 1;
        if (!cell && !reserved[index]?.[i]) return [];
        const width = Math.max(1, usable - 2);
        const lines = wrapCell(cell ?? "", width);
        while (lines.length < cellHeight(index, i, width)) lines.push("");
        return lines.map((line) => (line ? rail(`  ${status(line)}`) : railLine()));
      }),
      ...noteLines(index, 2),
    ]);
  if (usable < 44) return stacked();
  const measure = () =>
    header.map((label, i) =>
      Math.max(
        visibleWidth(label),
        ...records.map((row) => visibleWidth(row[i] ?? "")),
        ...reserved.map((row) => visibleWidth(row[i] ?? "")),
      ),
    );
  let widths = measure();
  // A long heading gives way before any cell has to wrap.
  if (widths.reduce((sum, n) => sum + n, 6) > usable) {
    header[1] = "History";
    widths = measure();
  }
  const floor = [Math.min(widths[0] ?? 10, 12), 8, 8, 7];
  let total = widths.reduce((sum, n) => sum + n, 6);
  while (total > usable) {
    let widest = -1;
    for (const [index, size] of widths.entries()) {
      if (size > (floor[index] ?? 0) && size > (widths[widest] ?? 0)) widest = index;
    }
    if (widest < 0) break;
    widths[widest] = (widths[widest] ?? 1) - 1;
    total--;
  }
  // A word cut across rows (a sign-in command, a flag) could not be copied. Stack instead.
  const cutsAWord = [...records, ...reserved].some((row) =>
    row.some((cell, i) => cell.split(/\s+/).some((word) => visibleWidth(word) > (widths[i] ?? 0))),
  );
  if (cutsAWord) return stacked();
  const heights: number[] = [];
  const expanded = records.flatMap((row, index) => {
    const cells = row.map((value, i) => wrapCell(value, widths[i] ?? usable));
    const height = Math.max(...row.map((_, i) => cellHeight(index, i, widths[i] ?? usable)));
    heights.push(height);
    return Array.from({ length: height }, (_, index) =>
      cells.map((lines, i) => (i === 0 ? cyan(lines[index] ?? "") : status(lines[index] ?? ""))),
    );
  });
  if ((widths[1] ?? 0) < visibleWidth(header[1] ?? "")) header[1] = "History";
  const lines = table(expanded, { header, maxWidth: usable, divider: false }).split("\n").map(rail);
  // A tool's note goes under its own row, starting under the History column.
  const out = [lines[0] ?? ""];
  let at = 1;
  heights.forEach((height, index) => {
    out.push(...lines.slice(at, at + height), ...noteLines(index, (widths[0] ?? 0) + 2));
    at += height;
  });
  return out;
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Results needed before the remaining time is estimated. */
const ESTIMATE_AFTER = 5;
/** Finished calls the moving average looks back over. */
const ESTIMATE_WINDOW = 20;
/** Without a terminal, one line per this many finished items, and one at the end. */
const STATIC_EVERY = 10;
/** Without a drawing terminal, plain lines are at least this far apart. */
const STATIC_MIN_MS = 1000;
const RUNNING_LINES = 3;

export interface StageProgressOptions {
  /** Clock in milliseconds. */
  now?(): number;
  env?: TerminalEnv;
  host?: TerminalHost;
  /** Repeat `tick` every `ms` until the returned function is called. Keeps elapsed time moving. */
  every?(tick: () => void, ms: number): () => void;
}

function everySecond(tick: () => void, ms: number): () => void {
  const timer = setInterval(tick, ms);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Progress for a stage of many concurrent calls, in the manner of cargo and
 * Docker BuildKit: one aggregate line (`done/total · failed · elapsed ·
 * estimate`), a few "running now" lines, finished items folded into the
 * count, and failures printed permanently above the region. The estimate is a
 * moving average of the last finished calls and reads "estimating" until
 * {@link ESTIMATE_AFTER} results are in. Cached and skipped items count as
 * done but not toward the rate.
 *
 * Without a drawing terminal it prints the total at once, then a plain line
 * only when a second has passed and ten more results are in since the last
 * one (a slow step still reports every ten results; a fast one prints a line
 * or two), one at the end, and failures as they happen.
 */
export function startStageProgress(
  out: Writable,
  label: string,
  o: StageProgressOptions = {},
): StageProgressSink {
  const now = o.now ?? Date.now;
  const every = o.every ?? everySecond;
  const style = palette(canColor({ output: out, env: o.env }));
  const mark = (unicode: string, ascii: string) => glyph(unicode, ascii, o.env ?? process.env);
  // Without Unicode the rail is "|", so the separator must not be one too.
  const separator = mark(" · ", ", ");
  const rail = (line: string): string => `${style.dim(mark("│", "|"))} ${line}`;
  const running = new Map<string, string>();
  // Times at which a real call finished, newest last, for the moving average.
  const finishes: number[] = [];
  let region: LiveRegion | null = null;
  let stopTicking = () => {};
  let active = false;
  let total = 0;
  let started = 0;
  let completed = 0;
  let failed = 0;
  let blocked = 0;
  let skipped = 0;
  let lastStatic = "";
  // When the last plain line was written, and the count it showed.
  let lastStaticAt = 0;
  let lastStaticCount = 0;

  function estimate(time: number): string {
    if (finishes.length < ESTIMATE_AFTER) return "estimating";
    const window = finishes.slice(-ESTIMATE_WINDOW);
    // The window opens at the finish before it, or at the start of the stage.
    const opened = finishes[finishes.length - window.length - 1] ?? started;
    const period = (window.at(-1) ?? time) - opened;
    if (period <= 0) return "estimating";
    const perMs = window.length / period;
    const seconds = Math.ceil((total - completed) / perMs / 1000);
    return seconds < 60 ? `about ${seconds}s left` : `about ${Math.ceil(seconds / 60)} min left`;
  }

  function aggregate(final: boolean): { count: string; timing: string } {
    const time = now();
    const count = [`${label}  ${completed}/${total}`];
    if (failed) count.push(`${failed} failed`);
    if (blocked) count.push(`${blocked} blocked`);
    if (skipped) count.push(`${skipped} skipped`);
    const timing = [duration(time - started)];
    if (!final && completed < total) timing.push(estimate(time));
    return { count: count.join(separator), timing: timing.join(separator) };
  }

  function staticLine(final: boolean): void {
    const { count, timing } = aggregate(final);
    const line = `${count}${separator}${timing}`;
    if (line === lastStatic) return;
    writeAbove(out, line, o.env);
    lastStatic = line;
    lastStaticAt = now();
    lastStaticCount = completed;
  }

  function draw(final = false): void {
    if (!active || !region) return;
    const { count, timing } = aggregate(final);
    const line = `${count}${separator}${timing}`;
    const lines =
      visibleWidth(line) <= terminalWidth(out) - 3
        ? [rail(line)]
        : [rail(count), rail(style.dim(timing))];
    if (!final) {
      const labels = [...running.values()];
      for (const name of labels.slice(0, RUNNING_LINES)) {
        lines.push(rail(style.dim(`Running  ${name}`)));
      }
      if (labels.length > RUNNING_LINES) {
        lines.push(rail(style.dim(`and ${labels.length - RUNNING_LINES} more running`)));
      }
    }
    region.render(lines);
  }

  function end(): void {
    if (!active) return;
    stopTicking();
    if (region) {
      draw(true);
      region.persist();
    } else staticLine(true);
    region = null;
    running.clear();
    active = false;
  }

  return {
    start(n) {
      end();
      active = true;
      total = n;
      started = now();
      completed = 0;
      failed = 0;
      blocked = 0;
      skipped = 0;
      finishes.length = 0;
      lastStatic = "";
      lastStaticAt = started;
      lastStaticCount = 0;
      region = liveRegion(out, { env: o.env, now, host: o.host });
      if (region) {
        draw();
        stopTicking = every(() => draw(), 1000);
      } else if (n > 0) {
        // A piped or logged run says how much work there is at once, so it
        // never sits silent until the tenth result. No timing yet: an
        // estimate in a static log line would only read "estimating".
        lastStatic = `${label}  0/${n}`;
        writeAbove(out, lastStatic, o.env);
      }
    },
    running(id, name = id) {
      if (!active) return;
      running.set(id, safeLine(name));
      draw();
    },
    item(event: StageItem) {
      if (!active) return;
      if (event.id !== undefined) running.delete(event.id);
      completed++;
      if (event.status === "skipped") skipped++;
      if (event.status === "blocked") blocked++;
      if (event.status === "failed") failed++;
      if (event.status === "done" || event.status === "failed") {
        finishes.push(now());
        if (finishes.length > ESTIMATE_WINDOW + 1) finishes.shift();
      }
      // Draw first, so the line written above repaints the region with the new count.
      if (region) draw();
      else if (
        completed < total &&
        completed - lastStaticCount >= STATIC_EVERY &&
        now() - lastStaticAt >= STATIC_MIN_MS
      )
        staticLine(false);
      if (event.status === "failed" || event.status === "blocked") {
        const message = `${event.status}: ${safeLine(event.line)}`;
        writeAbove(
          out,
          event.status === "failed" ? style.red(message) : style.yellow(message),
          o.env,
        );
      }
    },
    note(line) {
      writeAbove(out, line, o.env);
    },
    end,
  };
}
