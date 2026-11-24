import type { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import type { SavedSessionRead, StageItem, StageProgressSink } from "../distill/stage-events.js";
import { type LiveRegion, liveRegion, type TerminalHost, writeAbove } from "./live.js";
import { canColor, glyph, lineWidth, type TerminalEnv, terminalWidth } from "./mode.js";
import {
  bold,
  cyan,
  dim,
  green,
  palette,
  safeLine,
  table,
  terminalExcerpt,
  terminalText,
  visibleWidth,
  yellow,
} from "./style.js";
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
  /** Projects of the selected session reads, in batch order (including repeats). */
  readProjects?: readonly string[];
  /** Reads already saved for the selected inputs, including entries this stage has yet to visit. */
  reusableReads?: ReadonlySet<string>;
  /** Repeat `tick` every `ms` until the returned function is called. Keeps elapsed time moving. */
  every?(tick: () => void, ms: number): () => void;
}

function everySecond(tick: () => void, ms: number): () => void {
  const timer = setInterval(tick, ms);
  timer.unref();
  return () => clearInterval(timer);
}

/** Keep a project's color from batch selection through dispatch and its saved read. */
function projectColors(style: ReturnType<typeof palette>, names: readonly string[]) {
  const colors = [
    style.blue,
    style.cyan,
    style.magenta,
    style.magentaBright,
    style.yellow,
    style.green,
  ];
  const assigned = new Map<string, (text: string) => string>();
  const colorFor = (name: string) => {
    const known = assigned.get(name);
    if (known) return known;
    const color = colors[assigned.size % colors.length] ?? style.blue;
    assigned.set(name, color);
    return color;
  };
  for (const name of names) colorFor(name);
  return colorFor;
}

/** Name the selected projects while the runner is checking its models. */
export function batchProjectLine(
  projects: readonly string[],
  out: Writable,
  env: TerminalEnv = process.env,
): string | undefined {
  const style = palette(canColor({ output: out, env }));
  const clean = projects
    .map((name) => terminalText(typeof name === "string" ? name : ""))
    .filter(Boolean);
  if (!clean.length) return undefined;
  const colors = projectColors(style, clean);
  const counts = new Map<string, number>();
  for (const name of clean) counts.set(name, (counts.get(name) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const label = counts.size === 1 ? "Project" : counts.size <= 3 ? "Projects" : "Most represented";
  const limit = Math.max(8, terminalWidth(out) - 12);
  const names = ranked.map(([name, count]) => {
    const project = colors(name)(terminalExcerpt(name, limit));
    return count === 1 ? project : `${project} ${style.dim(`${glyph("×", "x", env)}${count}`)}`;
  });
  return `${style.dim(label)}  ${names.join(style.dim(glyph(" · ", ", ", env)))}`;
}

/**
 * A live count and active projects while a stage runs. Each checkpointed
 * session read goes straight into scrollback in completion order, so Ctrl-C
 * can clear the active work without losing any finished reads. Other stages
 * fold successes into the count. Logged runs also receive the saved reads.
 * The time estimate excludes cached and blocked results.
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
  const projectName = (name: string) =>
    terminalText(typeof name === "string" ? name : "") || "Unknown project";
  const projectColor = projectColors(
    style,
    (o.readProjects ?? []).map((name) => projectName(name ?? "")),
  );
  const announced = new Set<string>();
  let reading = o.readProjects !== undefined;
  let saved = 0;
  let pendingSaved = new Set<string>();
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

  function aggregate(final: boolean, live = false): { count: string[]; timing: string[] } {
    const time = now();
    const count = [
      reading && live
        ? style.green(`${saved}/${total} read`)
        : `${label}  ${reading ? saved : completed}/${total}`,
    ];
    if (failed) count.push(style.red(`${failed} failed`));
    if (blocked) count.push(style.yellow(`${blocked} blocked`));
    if (skipped) count.push(style.dim(`${skipped} ${reading ? "reused" : "skipped"}`));
    const timing = [live ? style.yellow(duration(time - started)) : duration(time - started)];
    if (!final && completed < total) timing.push(style.dim(estimate(time)));
    return { count, timing };
  }

  function staticLine(final: boolean): void {
    const { count, timing } = aggregate(final);
    const line = [...count, ...timing].join(separator);
    if (line === lastStatic) return;
    writeAbove(out, line, o.env);
    lastStatic = line;
    lastStaticAt = now();
    lastStaticCount = completed;
  }

  function draw(final = false): void {
    if (!active || !region) return;
    const { count, timing } = aggregate(final, true);
    const width = Math.max(1, terminalWidth(out) - 3);
    const lines: string[] = [];
    let row = "";
    for (const fact of [...count, ...timing]) {
      if (row && visibleWidth(`${row}${separator}${fact}`) > width) {
        lines.push(rail(row));
        row = "";
      }
      row = row ? `${row}${separator}${fact}` : fact;
    }
    lines.push(rail(row));
    if (!final) {
      const labels = [...running.values()];
      if (reading) {
        const counts = new Map<string, number>();
        for (const project of labels) counts.set(project, (counts.get(project) ?? 0) + 1);
        const projects = [...counts].map(([project, count]) => {
          const name = projectColor(project)(project);
          return count > 1 ? `${name} ${style.dim(`${mark("×", "x")}${count}`)}` : name;
        });
        if (projects.length) {
          const activity = `${style.magenta("Reading")}  ${projects.join(style.dim(separator))}`;
          lines.push(...wrapText(activity, width).map(rail));
          if (saved === 0)
            lines.push(
              ...wrapText("The first summary appears as soon as a read finishes.", width).map(
                (line) => rail(style.dim(line)),
              ),
            );
        }
      } else {
        for (const name of labels.slice(0, RUNNING_LINES))
          lines.push(rail(style.dim(`Running  ${name}`)));
        if (labels.length > RUNNING_LINES)
          lines.push(rail(style.dim(`and ${labels.length - RUNNING_LINES} more running`)));
      }
    }
    region.render(lines);
  }

  function printRead(read: SavedSessionRead, reused: boolean): void {
    const project = projectName(read.project);
    const outcomeColor = read.outcome === "completed" ? style.green : style.yellow;
    const width = lineWidth(out);
    const timestamp =
      region && (width ?? 80) >= 45 ? style.dim(`${separator}${duration(now() - started)}`) : "";
    const name =
      width === undefined ? project : wrapCell(project, Math.max(1, width - 3)).join(" ");
    const header = `${style.bold(reused ? "Reused" : "Read")}  ${projectColor(project)(name)}${style.dim(separator)}${outcomeColor(read.outcome)}${timestamp}`;
    const lines = width ? wrapText(header, Math.max(1, width - 3)).map(rail) : [rail(header)];
    const append = (label: string, value: string, color: (text: string) => string) => {
      if (!value) return;
      const prefix = `${label} `;
      const gutter = visibleWidth(prefix);
      const size = width === undefined ? undefined : Math.max(1, width - 3);
      // On narrow terminals give the label its own line to leave room for the prose.
      if (size !== undefined && size - gutter < 16) {
        lines.push(rail(label), ...wrapCell(value, size).map((line) => rail(color(line))));
        return;
      }
      const body = size === undefined ? [value] : wrapCell(value, size - gutter);
      lines.push(
        ...body.map((line, index) => rail(`${index ? " ".repeat(gutter) : prefix}${color(line)}`)),
      );
    };
    append(
      style.cyan(mark("›", ">")),
      terminalExcerpt(read.goal, 160, mark("…", "...")),
      (text) => text,
    );
    if (read.preference)
      append(
        style.magentaBright("Preference"),
        terminalExcerpt(read.preference, 160, mark("…", "...")),
        style.green,
      );
    if (region && saved > 1) lines.unshift(style.dim(mark("│", "|")));
    writeAbove(out, lines.join("\n"), o.env);
  }

  function end(): void {
    if (!active) return;
    stopTicking();
    if (region && reading) region.stop();
    else if (region) {
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
      saved = 0;
      pendingSaved = new Set(o.reusableReads);
      reading = o.readProjects !== undefined;
      announced.clear();
      finishes.length = 0;
      lastStatic = "";
      lastStaticAt = started;
      lastStaticCount = 0;
      region = liveRegion(out, { env: o.env, now, host: o.host, onResize: () => draw() });
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
    running(id, name = id, project) {
      if (!active) return;
      const first = running.size === 0;
      if (project !== undefined) {
        reading = true;
        pendingSaved.delete(id);
        const value = projectName(project);
        running.set(id, value);
        if (!region && !announced.has(value)) {
          announced.add(value);
          writeAbove(out, `Reading  ${projectColor(value)(value)}`, o.env);
        }
      } else running.set(id, safeLine(name));
      draw();
      if (first && project !== undefined) region?.flush();
    },
    item(event: StageItem) {
      if (!active) return;
      if (event.id !== undefined) {
        running.delete(event.id);
        pendingSaved.delete(event.id);
      }
      completed++;
      if (event.status === "skipped") skipped++;
      if (event.status === "blocked") blocked++;
      if (event.status === "failed") failed++;
      if (event.read && (event.status === "done" || event.status === "skipped")) {
        reading = true;
        saved++;
      }
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
      if (event.read && (event.status === "done" || event.status === "skipped"))
        printRead(event.read, event.status === "skipped");
      if (event.status === "failed" || event.status === "blocked") {
        const message = `${event.status}: ${terminalExcerpt(event.line, 500)}`;
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
    savedReads: () => saved + pendingSaved.size,
    end,
  };
}
