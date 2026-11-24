import fs from "node:fs";
import { createInterface, emitKeypressEvents, type Key } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import {
  frameHeight,
  type LiveRegion,
  liveRegion,
  onTerminalExit,
  persistLiveRegion,
  type TerminalHost,
} from "./live.js";
import {
  canColor,
  canPrompt,
  glyph,
  isInteractive,
  type PromptIo,
  type TerminalInput,
  type TerminalOutput,
  terminalWidth,
} from "./mode.js";
import { palette, safeLine, visibleWidth } from "./style.js";
import { wrapText } from "./wrap.js";

export type { PromptIo } from "./mode.js";

/** What a menu or a line question needs beyond its streams. Tests inject a fake host and wait. */
export interface MenuIo extends PromptIo {
  host?: TerminalHost;
  /** Bounded wait for facts still arriving before a numbered menu is printed. */
  wait?(ms: number): Promise<void>;
}

const INTERRUPTED_LINE = "Interrupted.";
const FACTS_WAIT_MS = 1200;

/*
 * Type-ahead. Keys typed before a question is on screen must never answer it:
 * an Enter pressed twice on the home menu would otherwise answer the next
 * screen before the person saw it. Every question and menu below opens the
 * same way, so no caller can leave this out:
 *
 * 1. The question is written in full (terminal writes are synchronous).
 * 2. Everything already waiting on the input is thrown away: what the stream
 *    has read and holds, and on a terminal or pseudo-terminal what the
 *    terminal itself still queues (read through the stream's own
 *    non-blocking descriptor until nothing is left; raw mode for that moment
 *    makes a line still being typed readable too).
 * 3. Only then does listening start.
 *
 * Pastes. While a question is open on a terminal, bracketed paste is on, and
 * everything inside a paste is ignored with the same note. It is turned off
 * again on every way out.
 *
 * The question that starts model calls (`askStart` in `start.ts`) does not
 * rely on timing at all: it starts only on `s`, a key no question here takes.
 *
 * A pipe or a file as stdin is not a terminal: its lines are the script and
 * are kept, and its end declines.
 */

/** The only key that starts model calls (see `start.ts`). No menu or question here may take it. */
export const START_KEY = "s";

/** Shown when keys typed ahead or pasted were thrown away. */
export const TYPED_AHEAD = "Ignored keys typed ahead. Choose when you are ready.";

const PASTE_ON = "\u001b[?2004h";
const PASTE_OFF = "\u001b[?2004l";

/** True when a line read from a terminal holds a bracketed-paste marker. */
export function hasPasteMarker(line: string): boolean {
  return line.includes("\u001b[200~") || line.includes("\u001b[201~");
}

/**
 * Bracketed paste for one open question, on a terminal that is asked
 * questions (not `TERM=dumb`). `off` is safe to call more than once, and runs
 * on process exit and signals too, so the terminal is never left in it.
 */
export function pasteMode(io: MenuIo): { on(): void; off(): void } {
  const output: TerminalOutput = io.output ?? process.stdout;
  const env = io.env ?? process.env;
  const usable = canPrompt(io) && output.isTTY === true && env.TERM !== "dumb";
  let enabled = false;
  let unregister = () => {};
  const off = () => {
    if (!enabled) return;
    enabled = false;
    unregister();
    try {
      output.write(PASTE_OFF);
    } catch {
      // A closed terminal has no paste mode left to restore.
    }
  };
  return {
    on() {
      if (!usable || enabled) return;
      enabled = true;
      output.write(PASTE_ON);
      unregister = onTerminalExit(off, hostOf(io));
    },
    off,
  };
}

type LineAnswer = { line: string } | { end: "eof" | "interrupt" };

function hostOf(io: MenuIo): TerminalHost {
  return io.host ?? (process as unknown as TerminalHost);
}

/**
 * Throw away everything waiting on a terminal's input, and say how many bytes
 * that was. A stream that is not a terminal is left alone: its lines are a
 * script. Exported for its own tests; questions call it themselves.
 */
export function discardTypeAhead(input: TerminalInput): number {
  if (input.isTTY !== true) return 0;
  let discarded = 0;
  // What the stream has already read. Reading emits `data`, so no listener may
  // see these bytes on the way out, including a keypress decoder left from an
  // earlier menu. The flowing state is left as it was: reading works in both,
  // and a stream marked paused here would never be started by readline.
  const listeners = input.rawListeners("data") as ((chunk: unknown) => void)[];
  input.removeAllListeners("data");
  try {
    while (input.readableLength > 0) {
      const chunk = input.read() as { length: number } | null;
      if (chunk === null) break;
      discarded += chunk.length;
    }
  } finally {
    for (const listener of listeners) input.on("data", listener);
  }
  // What the terminal still queues. A terminal stream reads through its own
  // non-blocking descriptor, so this read returns at once when nothing is left.
  const fd = (input as { _handle?: { fd?: unknown } })._handle?.fd;
  if (typeof fd === "number" && fd >= 0 && input.setRawMode) {
    const wasRaw = input.isRaw === true;
    try {
      if (!wasRaw) input.setRawMode(true);
      const buffer = Buffer.alloc(4096);
      // Bounded, in case a terminal keeps producing input as fast as it is read.
      for (let i = 0; i < 256; i++) {
        const n = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (n <= 0) break;
        discarded += n;
      }
    } catch {
      // EAGAIN: nothing more is waiting. Any other error: nothing can be read.
    } finally {
      if (!wasRaw) {
        try {
          input.setRawMode(false);
        } catch {
          // A disconnected terminal can no longer accept a mode change.
        }
      }
    }
  }
  return discarded;
}

/** One line from the input, or why there is none. Input typed before the question is thrown away. */
function askLine(q: string, io: MenuIo): Promise<LineAnswer> {
  const input: TerminalInput = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const host = hostOf(io);
  if (!canPrompt(io) || input.readableEnded || input.destroyed) {
    return Promise.resolve({ end: "eof" });
  }
  persistLiveRegion(output);
  output.write(q);
  const discarded = discardTypeAhead(input);
  if (discarded > 0) {
    // The question is asked again under the note, so the cursor is where the answer goes.
    const last = q.slice(q.lastIndexOf("\n") + 1);
    output.write(`\n  ${TYPED_AHEAD}\n${last}`);
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input, terminal: false });
    let finished = false;
    function finish(answer: LineAnswer): void {
      if (finished) return;
      finished = true;
      host.off("SIGINT", cancel);
      input.off("end", eof);
      rl.close();
      resolve(answer);
    }
    function eof(): void {
      finish({ end: "eof" });
    }
    function cancel(): void {
      output.write("\n");
      finish({ end: "interrupt" });
    }
    host.once("SIGINT", cancel);
    rl.once("SIGINT", cancel);
    rl.once("close", eof);
    input.prependOnceListener("end", eof);
    rl.once("line", (line) => {
      // A terminal in raw mode passes the control bytes through as text.
      if (line.includes("\u0003")) finish({ end: "interrupt" });
      else if (line.includes("\u0004")) finish({ end: "eof" });
      else finish({ line });
    });
  });
}

/**
 * A line question, asked until it is answered. A line from a paste is set
 * aside with one note, and the question is asked again.
 */
async function askLineSkippingPastes(q: string, io: MenuIo): Promise<LineAnswer> {
  const paste = pasteMode(io);
  paste.on();
  let question = q;
  let inPaste = false;
  try {
    for (;;) {
      const answer = await askLine(question, io);
      if (!("line" in answer)) return answer;
      if (!inPaste && !hasPasteMarker(answer.line)) return answer;
      inPaste =
        answer.line.lastIndexOf("\u001b[200~") > answer.line.lastIndexOf("\u001b[201~") ||
        (inPaste && !answer.line.includes("\u001b[201~"));
      // Ask again with only the prompt line, under the note.
      const prompt = q.slice(q.lastIndexOf("\n") + 1);
      question = `  ${TYPED_AHEAD}\n${prompt}`;
    }
  } finally {
    paste.off();
  }
}

/**
 * One line answer to a question that handles pastes itself (`askStart`).
 * What was typed before the question appeared is thrown away.
 */
export function readAnswerLine(q: string, io: MenuIo = {}): Promise<LineAnswer> {
  return askLine(q, io);
}

/**
 * In plain mode the terminal handles typing and echo; readline emits no
 * cursor controls. Input typed before the question appeared is thrown away,
 * and so is a pasted line.
 */
export async function readLine(q: string, io: MenuIo = {}): Promise<string | null> {
  const answer = await askLineSkippingPastes(q, io);
  return "line" in answer ? answer.line : null;
}

export interface MenuChoice<K extends string> {
  key: K;
  label: string;
  detail?: string;
  recommended?: boolean;
}

interface MenuOptions<K extends string> {
  title: string;
  choices: MenuChoice<K>[];
  above?: () => string[];
  onRedraw?(redraw: () => void): void;
  settled?: Promise<void>;
}

/** A choice, `quit` for `q`, Ctrl-D, or the end of input, and `interrupt` for Ctrl-C. */
export type MenuAnswer<K extends string> = K | "quit" | "interrupt";

function defaultChoice<K extends string>(
  choices: readonly MenuChoice<K>[],
): MenuChoice<K> | undefined {
  return choices.find((choice) => choice.recommended) ?? choices[0];
}

/** At most nine choices, so every one has a single digit. */
const MAX_KEYED_CHOICES = 9;

/**
 * Wrap long labels and recommendations inside the marker gutter. A live
 * menu leaves out detail that would wrap; a numbered menu prints it below.
 */
function menuLines<K extends string>(
  o: { title: string; above: string[]; choices: readonly MenuChoice<K>[] },
  color: boolean,
  selected?: K,
  width = Number.POSITIVE_INFINITY,
  numbered = false,
  notice?: string,
): string[] {
  const s = palette(color);
  const lines = [...o.above, ...(o.above.length ? [""] : []), s.bold(o.title)];
  const arrow = glyph("›", ">");
  const dot = glyph("•", "*");
  o.choices.forEach((choice, i) => {
    const active = choice.key === selected;
    const cursor = active ? s.green(arrow) : s.dim(dot);
    const label = active ? s.bold(s.green(choice.label)) : choice.label;
    const recommendation = choice.recommended ? s.dim(" (recommended)") : "";
    const prefix = numbered ? `${cursor} ${choice.key === "quit" ? "q" : i + 1}  ` : `${cursor} `;
    const row = `${prefix}${label}${recommendation}`;
    const detail =
      choice.detail && !(numbered && choice.key === "quit") ? `  ${s.dim(choice.detail)}` : "";
    if (visibleWidth(row + detail) <= width) {
      lines.push(row + detail);
    } else {
      const gutter = " ".repeat(visibleWidth(prefix));
      if (visibleWidth(row) <= width) lines.push(row);
      else {
        const parts = wrapText(choice.label, Math.max(1, width - gutter.length));
        const labelLines = parts.map(
          (part, index) => (index ? gutter : prefix) + (active ? s.bold(s.green(part)) : part),
        );
        if (choice.recommended) {
          const last = labelLines.at(-1) ?? "";
          if (visibleWidth(last + recommendation) <= width)
            labelLines[labelLines.length - 1] = last + recommendation;
          else labelLines.push(gutter + s.dim("(recommended)"));
        }
        lines.push(...labelLines);
      }
      if (numbered && choice.detail)
        lines.push(...wrapText(choice.detail, width, { indent: gutter }).map(s.dim));
    }
  });
  if (!o.choices.some((choice) => choice.key === "quit")) {
    lines.push(numbered ? `${dot} q  Quit` : `${s.dim(dot)} Quit  ${s.dim("q")}`);
  }
  if (selected !== undefined && !numbered)
    lines.push(
      s.dim(glyph("  ↑ ↓ to move · Enter to choose", "  Up/Down to move, Enter to choose")),
    );
  if (notice) lines.push(...wrapText(notice, width, { indent: "  " }).map(s.dim));
  return lines;
}

function aboveLines(o: MenuOptions<string>): string[] {
  return (o.above?.() ?? []).flatMap((line) => line.split("\n"));
}

/** Give cheap status probes time to finish. Unsettled cells retain their checking labels. */
async function waitForFacts(
  settled: Promise<void> | undefined,
  io: MenuIo,
  interruptible: boolean,
): Promise<"settled" | "interrupt"> {
  if (!settled) return "settled";
  const host = hostOf(io);
  let cancel = () => {};
  let timer: NodeJS.Timeout | undefined;
  const elapsed = io.wait
    ? io.wait(FACTS_WAIT_MS)
    : new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FACTS_WAIT_MS);
      });
  try {
    return await Promise.race([
      settled.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      elapsed.then(() => "settled" as const),
      new Promise<"interrupt">((resolve) => {
        if (!interruptible) return;
        cancel = () => resolve("interrupt");
        host.once("SIGINT", cancel);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    host.off("SIGINT", cancel);
  }
}

/** The frame printed once as plain lines, then a numbered line prompt. */
async function numberedMenu<K extends string>(
  o: MenuOptions<K>,
  io: MenuIo,
): Promise<MenuAnswer<K>> {
  const output = io.output ?? process.stdout;
  persistLiveRegion(output);
  const promptable = canPrompt(io);
  if ((await waitForFacts(o.settled, io, promptable)) === "interrupt") {
    output.write(`\n${INTERRUPTED_LINE}\n`);
    return "interrupt";
  }
  if (!promptable) {
    const above = o.above?.() ?? [];
    if (above.length) output.write(`${above.join("\n")}\n`);
    return "quit";
  }

  // Freeze both the labels and their keys, so a late probe cannot change what
  // typing a displayed number will do.
  const choices = [...o.choices];
  const recommendation = defaultChoice(choices);
  const width = terminalWidth(output as TerminalOutput);
  const lines = menuLines(
    { title: o.title, above: aboveLines(o), choices },
    false,
    recommendation?.key,
    width,
    true,
  ).map((line) => stripVTControlCharacters(safeLine(line)));
  output.write(`${lines.join("\n")}\n`);
  if (!recommendation) return "quit";
  const index = choices.indexOf(recommendation) + 1;
  for (;;) {
    const answer = await askLineSkippingPastes(`  Choose [${index}]: `, io);
    if ("end" in answer) {
      if (answer.end === "interrupt") {
        output.write(`${INTERRUPTED_LINE}\n`);
        return "interrupt";
      }
      return "quit";
    }
    const value = answer.line.trim().toLowerCase();
    if (value === "q" || value === "quit") return "quit";
    if (value === "") return recommendation.key;
    const chosen = /^\d+$/.test(value)
      ? choices[Number(value) - 1]
      : choices.find((choice) => choice.key.toLowerCase() === value);
    if (chosen) return chosen.key;
    output.write(`  Enter a number from 1 to ${choices.length}, or q to quit.\n`);
  }
}

/** Trim the lines above the menu, oldest first after the title, so the choices stay on screen. */
function fitFrame<K extends string>(
  o: { title: string; above: string[]; choices: readonly MenuChoice<K>[] },
  color: boolean,
  selected: K | undefined,
  output: TerminalOutput,
  notice?: string,
): string[] {
  const height = frameHeight(output);
  // A live region leaves the last column free.
  const width = terminalWidth(output) - 1;
  const full = menuLines(o, color, selected, width, false, notice);
  if (full.length <= height || o.above.length === 0) return full;
  // The first line above is the screen's title: it stays while there is room for it.
  const [first = "", ...rest] = o.above;
  const keep = Math.max(0, rest.length - (full.length - height));
  const above = keep
    ? [first, ...rest.slice(-keep)]
    : full.length - rest.length <= height
      ? [first]
      : [];
  return menuLines({ ...o, above }, color, selected, width, false, notice);
}

/**
 * A single-key menu inside a live region, or a numbered prompt where that
 * cannot work. The choice of the two is made once, when the menu opens:
 * numbered when the terminal cannot take single keys (a pipe, CI, plain mode,
 * `TERM=dumb`), when there are ten or more choices, or when the terminal has
 * fewer rows than the frame needs.
 *
 * Keys act on the choices as they were last drawn: a digit, Enter, or an arrow
 * never reaches an item that is not on screen. Arrows wrap. Enter takes the
 * highlighted item, which starts on the recommended one. `q`, Ctrl-D, and the
 * end of input quit quietly; Ctrl-C prints one line and returns `interrupt`
 * so the caller can exit with code 130.
 *
 * Raw mode and the cursor are restored on every way out, including when a
 * caller's `above` function throws.
 */
export async function chooseMenuAnswer<K extends string>(
  o: MenuOptions<K>,
  io: MenuIo = {},
): Promise<MenuAnswer<K>> {
  // `s` starts model calls at the Start question; no menu may answer to it.
  if (o.choices.some((choice) => choice.key.toLowerCase() === START_KEY))
    throw new Error(`A menu choice may not use the key "${START_KEY}": it starts model calls.`);
  const input: TerminalInput = io.input ?? process.stdin;
  const output: Writable & { rows?: number } = io.output ?? process.stdout;
  const color = canColor(io);
  const host = hostOf(io);
  const initial = { title: o.title, above: aboveLines(o), choices: o.choices };
  const opening = menuLines(
    initial,
    color,
    defaultChoice(o.choices)?.key,
    terminalWidth(output) - 1,
  );
  if (
    !isInteractive(io) ||
    !input.setRawMode ||
    o.choices.length > MAX_KEYED_CHOICES ||
    opening.length > frameHeight(output)
  ) {
    return numberedMenu(o, io);
  }
  if (input.readableEnded || input.destroyed) return "quit";
  const resize = { handler: () => {} };
  const region = liveRegion(output, { env: io.env, host, onResize: () => resize.handler() });
  if (!region) return numberedMenu(o, io);
  const paste = pasteMode(io);
  const answer = await keyMenu(o, { input, output, region, host, color, resize, paste });
  return answer === RAW_MODE_REFUSED ? numberedMenu(o, io) : answer;
}

/** The same menu for callers that treat Ctrl-C like `q`. */
export async function chooseMenu<K extends string>(
  o: MenuOptions<K>,
  io: MenuIo = {},
): Promise<K | "quit"> {
  const answer = await chooseMenuAnswer(o, io);
  return answer === "interrupt" ? "quit" : answer;
}

/** The terminal would not enter raw mode; the numbered prompt still works. */
const RAW_MODE_REFUSED = Symbol("rawModeRefused");

function keyMenu<K extends string>(
  o: MenuOptions<K>,
  t: {
    input: TerminalInput;
    output: Writable & { rows?: number };
    region: LiveRegion;
    host: TerminalHost;
    color: boolean;
    /** The region calls this on a resize and paints the result in the same write. */
    resize: { handler: () => void };
    paste: { on(): void; off(): void };
  },
): Promise<MenuAnswer<K> | typeof RAW_MODE_REFUSED> {
  const { input, output, region, host, color } = t;
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw === true;
    const wasFlowing = input.readableFlowing === true;
    let restoreRaw = false;
    let inPaste = false;
    let moved = false;
    let finished = false;
    // Said under the menu once keys typed ahead were set aside.
    let notice: string | undefined;
    // What is on screen. Keys read only this, never `o.choices` directly.
    let drawn: readonly MenuChoice<K>[] = [];
    let selected: K | undefined;

    function detach(): void {
      input.off("keypress", press);
      input.off("end", quit);
      input.off("close", quit);
      t.resize.handler = () => {};
      host.off("SIGINT", interrupt);
      unregister();
      t.paste.off();
      if (restoreRaw) {
        try {
          input.setRawMode?.(wasRaw);
        } catch {
          // A disconnected terminal can no longer accept a mode change.
        }
      }
      if (!wasFlowing) input.pause();
    }
    function finish(result: MenuAnswer<K>, keepScreen = true): void {
      if (finished) return;
      finished = true;
      detach();
      if (keepScreen) region.persist();
      else region.stop();
      if (result === "interrupt") output.write(`${INTERRUPTED_LINE}\n`);
      resolve(result);
    }
    function fail(error: unknown): void {
      if (finished) return;
      finished = true;
      detach();
      region.stop();
      reject(error);
    }
    function quit(): void {
      finish("quit");
    }
    function interrupt(): void {
      finish("interrupt");
    }
    function draw(): void {
      const choices = [...o.choices];
      if (!moved || !choices.some((choice) => choice.key === selected)) {
        selected = defaultChoice(choices)?.key;
      }
      const frame = { title: o.title, above: aboveLines(o), choices };
      region.render(fitFrame(frame, color, selected, output, notice));
      region.flush();
      drawn = choices;
    }
    function redraw(): void {
      if (finished) return;
      try {
        draw();
      } catch (error) {
        fail(error);
      }
    }
    function choose(choice: MenuChoice<K>): void {
      selected = choice.key;
      moved = true;
      const frame = { title: o.title, above: aboveLines(o), choices: drawn };
      region.render(fitFrame(frame, color, selected, output, notice));
      region.flush();
      finish(choice.key);
    }
    function press(text: string | undefined, key: Key | undefined): void {
      if (finished) return;
      try {
        const name = key?.name ?? text;
        if (key?.ctrl && name === "c") {
          interrupt();
          return;
        }
        // Nothing inside a paste answers; the note says it was set aside.
        if (name === "paste-start" || name === "paste-end" || inPaste) {
          inPaste = name === "paste-start" || (inPaste && name !== "paste-end");
          if (notice !== TYPED_AHEAD) {
            notice = TYPED_AHEAD;
            draw();
          }
          return;
        }
        if ((key?.ctrl && name === "d") || name === "q") {
          quit();
          return;
        }
        const index = drawn.findIndex((choice) => choice.key === selected);
        if (name === "up" || name === "down") {
          if (!drawn.length) return;
          const step = name === "up" ? -1 : 1;
          const next = (Math.max(0, index) + step + drawn.length) % drawn.length;
          selected = drawn[next]?.key;
          moved = true;
          draw();
          return;
        }
        const choice =
          name === "return" || name === "enter"
            ? (drawn[index] ?? defaultChoice(drawn))
            : text && /^[1-9]$/.test(text)
              ? drawn[Number(text) - 1]
              : drawn.find((candidate) => candidate.key.length === 1 && candidate.key === name);
        if (choice) choose(choice);
      } catch (error) {
        fail(error);
      }
    }
    // Process exit erases the menu; a SIGINT from outside the terminal is an interrupt.
    const unregister = onTerminalExit(
      (signal) => finish(signal === "SIGINT" ? "interrupt" : "quit", false),
      host,
    );
    try {
      emitKeypressEvents(input as Readable);
      input.on("keypress", press);
      input.once("end", quit);
      input.once("close", quit);
      host.once("SIGINT", interrupt);
      t.resize.handler = redraw;
      if (!wasRaw) {
        try {
          input.setRawMode?.(true);
          restoreRaw = true;
        } catch {
          finished = true;
          detach();
          region.stop();
          resolve(RAW_MODE_REFUSED);
          return;
        }
      }
      // The menu is on screen before anything waiting is thrown away, and both
      // happen before the stream delivers a single key (it flows on a later tick).
      t.paste.on();
      draw();
      if (discardTypeAhead(input) > 0) {
        notice = TYPED_AHEAD;
        draw();
      }
      input.resume();
      o.onRedraw?.(redraw);
      o.settled?.then(redraw, redraw);
    } catch (error) {
      fail(error);
    }
  });
}
