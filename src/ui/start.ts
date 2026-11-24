/**
 * The Start question: the one kind of question whose answer authorizes model
 * calls (the distill plan, the subagent plan, the retry plan, the preferences
 * consolidation plan, and the evaluation's live run).
 *
 * Approval never depends on timing. Enter dismisses every earlier menu, so a
 * held or repeated Enter, a paste, or a key typed ahead could otherwise reach
 * this question. Here only one deliberate key starts: `s`, which no earlier
 * question uses. On a terminal:
 *
 * - `s` starts with the selected plan. `1` and `2` only select a plan and
 *   redraw; they never start.
 * - `q`, Escape, Ctrl-D, and the end of input leave. Ctrl-C interrupts.
 * - `S` and `Q` count as `s` and `q`, so Caps Lock does not leave a person
 *   pressing the key the screen names and getting only the hint. No menu may
 *   use either letter in either case.
 * - Enter, space, arrows, and every other key do nothing but show, once, the
 *   dim line "Press s to start, or q to leave."
 * - Keys waiting when the question opens are thrown away (as at every
 *   question). Everything inside a bracketed paste is ignored, and so is a
 *   key that arrives in the same read as any other byte (a paste on a
 *   terminal without bracketed paste). Either way the typed-ahead note shows.
 *
 * In line mode (plain mode, `TERM=dumb`, a terminal too short for the menu, a
 * scripted stream) the same letters are typed and entered: a line that is
 * exactly `s` starts, `1` or `2` selects and asks again, `q` leaves, anything
 * else (an empty line, `y`, `yes`) prints the hint and asks again, and the end
 * of input leaves. Standard input that is a pipe leaves at once.
 */
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { frameHeight, liveRegion, onTerminalExit, persistLiveRegion } from "./live.js";
import {
  canColor,
  canPrompt,
  isInteractive,
  type TerminalInput,
  type TerminalOutput,
  terminalWidth,
} from "./mode.js";
import {
  discardTypeAhead,
  hasPasteMarker,
  type MenuIo,
  pasteMode,
  readAnswerLine,
  START_KEY,
  TYPED_AHEAD,
} from "./prompt.js";
import { palette, safeLine, visibleWidth } from "./style.js";
import { wrapText } from "./wrap.js";

export { START_KEY };

/** Said once, under the question, after a key that does not start. */
export const START_HINT = "Press s to start, or q to leave.";

const INTERRUPTED_LINE = "Interrupted.";

/** A plan the person can select with its number before starting. */
export interface StartOption<Q extends string> {
  key: Q;
  label: string;
  detail?: string;
}

export interface StartQuestion<Q extends string> {
  title?: string;
  /** Plans to choose between with `1` and `2`. None: `s` starts the one plan. */
  options?: readonly StartOption<Q>[];
  /** The option selected when the question opens. */
  selected?: Q;
}

/** Started with the selected option, left, or interrupted (Ctrl-C). */
export type StartAnswer<Q extends string> = { start: true; selected?: Q } | "quit" | "interrupt";

/**
 * The question as lines. Pure: the title, the options with the selected one
 * marked, the start line naming the plan that will run, the way out, and any
 * notes. Where an option's row with its detail would be wider than `width`,
 * the details are left out (`wrap: false`, a live frame of fixed height) or
 * each goes under its option, wrapped (`wrap: true`, printed lines).
 */
export function startLines<Q extends string>(
  q: StartQuestion<Q>,
  o: { selected?: Q; color?: boolean; width?: number; notes?: string[]; wrap?: boolean } = {},
): string[] {
  const s = palette(o.color === true);
  const width = o.width ?? Number.POSITIVE_INFINITY;
  const options = q.options ?? [];
  const selected = options.find((option) => option.key === (o.selected ?? q.selected));
  const named = options.map(
    (option) => `${option.label}${option === selected ? " (selected)" : ""}`,
  );
  const column = Math.max(0, ...named.map((label) => visibleWidth(label)));
  const rows = options.map((option, i) => {
    const label = named[i] ?? option.label;
    return `  ${i + 1}  ${option === selected ? s.bold(label) : label}`;
  });
  const besides = options.map((option, i) =>
    option.detail
      ? `${" ".repeat(column - visibleWidth(named[i] ?? ""))}  ${s.dim(option.detail)}`
      : "",
  );
  // One layout for every option, so the details line up or none is shown beside its row.
  const fits = rows.every((row, i) => visibleWidth(row + (besides[i] ?? "")) <= width);
  const lines = [s.bold(q.title ?? "Start?")];
  options.forEach((option, i) => {
    const row = rows[i] ?? "";
    if (fits) lines.push(row + (besides[i] ?? ""));
    else {
      lines.push(row);
      if (o.wrap && option.detail)
        lines.push(
          ...wrapText(option.detail, width, { indent: "     " }).map((line) => s.dim(line)),
        );
    }
  });
  lines.push(`  ${START_KEY}  ${s.bold(selected ? `Start with ${selected.label}` : "Start")}`);
  lines.push("  q  Not now");
  for (const note of o.notes ?? []) lines.push(s.dim(`  ${note}`));
  return lines;
}

/** True when the Start question will take single keys on this terminal (not lines). */
export function startTakesKeys(io: MenuIo = {}): boolean {
  const input: TerminalInput = io.input ?? process.stdin;
  return isInteractive(io) && typeof input.setRawMode === "function";
}

/** One escape sequence, as an arrow or function key sends it: a single key. */
const oneKey = (text: string) =>
  text.startsWith("\u001b") && /^(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])$/.test(text.slice(1));
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

/**
 * Ask the Start question. See the module comment for every key. Never reads
 * standard input that is not a terminal.
 */
export async function askStart<Q extends string>(
  q: StartQuestion<Q>,
  io: MenuIo = {},
): Promise<StartAnswer<Q>> {
  const input: TerminalInput = io.input ?? process.stdin;
  const output: TerminalOutput = io.output ?? process.stdout;
  if (input.readableEnded || input.destroyed) return "quit";
  const opening = startLines(q, { notes: [START_HINT] });
  if (startTakesKeys(io) && opening.length <= frameHeight(output)) {
    const answer = await keyStart(q, io, input, output);
    if (answer !== RAW_MODE_REFUSED) return answer;
  }
  if (canPrompt(io)) return lineStart(q, io, terminalLines(io));
  // A stream supplied by a script or a test, never a piped standard input.
  if (io.input && input !== process.stdin && input.isTTY !== true)
    return lineStart(q, io, scriptLines(input, output));
  return "quit";
}

const RAW_MODE_REFUSED = Symbol("rawModeRefused");

function keyStart<Q extends string>(
  q: StartQuestion<Q>,
  io: MenuIo,
  input: TerminalInput,
  output: TerminalOutput,
): Promise<StartAnswer<Q> | typeof RAW_MODE_REFUSED> {
  const host = io.host ?? (process as unknown as NonNullable<MenuIo["host"]>);
  const resize = { handler: () => {} };
  const region = liveRegion(output, { env: io.env, host, onResize: () => resize.handler() });
  if (!region) return Promise.resolve(RAW_MODE_REFUSED);
  const color = canColor(io);
  const options = q.options ?? [];
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw === true;
    const wasFlowing = input.readableFlowing === true;
    let restoreRaw = false;
    let finished = false;
    let selected = q.selected ?? options[0]?.key;
    let typedAhead = false;
    let hinted = false;
    let inPaste = false;
    const paste = pasteMode(io);

    function draw(): void {
      if (finished) return;
      const notes = [...(typedAhead ? [TYPED_AHEAD] : []), ...(hinted ? [START_HINT] : [])];
      // A live region leaves the last column free.
      const width = terminalWidth(output) - 1;
      region?.render(startLines(q, { selected, color, width, notes }));
      region?.flush();
    }
    function detach(): void {
      input.off("data", onData);
      input.off("end", quit);
      input.off("close", quit);
      host.off("SIGINT", interrupt);
      resize.handler = () => {};
      unregister();
      paste.off();
      if (restoreRaw) {
        try {
          input.setRawMode?.(wasRaw);
        } catch {
          // A disconnected terminal can no longer accept a mode change.
        }
      }
      if (!wasFlowing) input.pause();
    }
    function finish(result: StartAnswer<Q>, keepScreen = true): void {
      if (finished) return;
      finished = true;
      detach();
      if (keepScreen) region?.persist();
      else region?.stop();
      if (result === "interrupt") output.write(`${INTERRUPTED_LINE}\n`);
      resolve(result);
    }
    function quit(): void {
      finish("quit");
    }
    function interrupt(): void {
      finish("interrupt");
    }
    function setAside(): void {
      typedAhead = true;
      draw();
    }
    function onData(chunk: unknown): void {
      if (finished) return;
      try {
        read(typeof chunk === "string" ? chunk : String(chunk));
      } catch (error) {
        if (finished) return;
        finished = true;
        detach();
        region?.stop();
        reject(error);
      }
    }
    /** One read from the terminal: what it may answer, and what it may not. */
    function read(chunk: string): void {
      let text = chunk;
      // Ctrl-C always interrupts, wherever it is in the read.
      if (text.includes("\u0003")) {
        interrupt();
        return;
      }
      // Everything inside a bracketed paste is ignored, markers included.
      if (inPaste || text.includes(PASTE_START)) {
        for (;;) {
          if (inPaste) {
            const end = text.indexOf(PASTE_END);
            if (end < 0) break;
            inPaste = false;
            text = text.slice(end + PASTE_END.length);
          }
          const start = text.indexOf(PASTE_START);
          if (start < 0) break;
          inPaste = true;
          text = text.slice(start + PASTE_START.length);
        }
        setAside();
        return;
      }
      // More than one key in one read is a paste or keys typed ahead: none of it counts.
      if (text.length > 1 && !oneKey(text)) {
        setAside();
        return;
      }
      // One key from here on. Its lowercase form, so Caps Lock changes nothing.
      const key = text.toLowerCase();
      if (text === "\u0004" || key === "q" || text === "\u001b") {
        quit();
        return;
      }
      if (key === START_KEY) {
        finish({ start: true, ...(selected && { selected }) });
        return;
      }
      const option = /^[1-9]$/.test(text) ? options[Number(text) - 1] : undefined;
      if (option) {
        selected = option.key;
        draw();
      } else if (!hinted) {
        hinted = true;
        draw();
      }
    }
    // Process exit erases the question; a SIGINT from outside the terminal is an interrupt.
    const unregister = onTerminalExit(
      (signal) => finish(signal === "SIGINT" ? "interrupt" : "quit", false),
      host,
    );
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
    resize.handler = draw;
    input.on("data", onData);
    input.once("end", quit);
    input.once("close", quit);
    host.once("SIGINT", interrupt);
    paste.on();
    // On screen first, then what was waiting is thrown away, then listening starts.
    draw();
    if (discardTypeAhead(input) > 0) setAside();
    input.resume();
  });
}

/** The next line of an answer, or the end of input, or Ctrl-C. */
type NextLine = ((question: string) => Promise<{ line: string } | { end: "eof" | "interrupt" }>) & {
  /** Stop reading, so a later question on the same input gets the lines after this answer. */
  close?(): void;
};

/** Lines from a terminal: each question opens with the type-ahead drain. */
function terminalLines(io: MenuIo): NextLine {
  return (question) => readAnswerLine(question, io);
}

/** Lines from a supplied stream, kept in order across questions; its end leaves. */
function scriptLines(input: Readable, output: Writable): NextLine {
  let lines: Interface | undefined;
  const next: NextLine = (question) => ask(question);
  next.close = () => lines?.close();
  const queue: string[] = [];
  let ended = false;
  let waiting: ((value: { line: string } | { end: "eof" }) => void) | undefined;
  return next;
  function ask(question: string): Promise<{ line: string } | { end: "eof" }> {
    if (!lines) {
      lines = createInterface({ input, terminal: false });
      lines.on("line", (line) => {
        if (waiting) {
          const resolve = waiting;
          waiting = undefined;
          resolve({ line });
        } else queue.push(line);
      });
      lines.once("close", () => {
        ended = true;
        waiting?.({ end: "eof" });
        waiting = undefined;
      });
    }
    output.write(question);
    // Nothing echoes a scripted line, so its end of line is written here.
    const answered = (line: string) => {
      output.write("\n");
      return { line };
    };
    const line = queue.shift();
    if (line !== undefined) return Promise.resolve(answered(line));
    if (ended) return Promise.resolve({ end: "eof" });
    return new Promise((resolve) => {
      waiting = (value) => resolve("line" in value ? answered(value.line) : value);
    });
  }
}

async function lineStart<Q extends string>(
  q: StartQuestion<Q>,
  io: MenuIo,
  next: NextLine,
): Promise<StartAnswer<Q>> {
  const output: Writable & TerminalOutput = io.output ?? process.stdout;
  persistLiveRegion(output);
  const options = q.options ?? [];
  let selected = q.selected ?? options[0]?.key;
  const width = output.isTTY ? terminalWidth(output) : undefined;
  const plain = (lines: string[]) =>
    lines.map((line) => stripVTControlCharacters(safeLine(line))).join("\n");
  output.write(`${plain(startLines(q, { selected, width, wrap: true }))}\n`);
  const keys = [...options.map((_, i) => String(i + 1)), START_KEY, "q"].join("/");
  const prompt = `  Choose [${keys}]: `;
  const paste = pasteMode(io);
  paste.on();
  let inPaste = false;
  let noted = false;
  try {
    for (;;) {
      const answer = await next(prompt);
      if ("end" in answer) {
        if (answer.end === "interrupt") {
          output.write(`${INTERRUPTED_LINE}\n`);
          return "interrupt";
        }
        return "quit";
      }
      // A pasted line, or any line of a paste, never answers.
      if (inPaste || hasPasteMarker(answer.line)) {
        inPaste = answer.line.lastIndexOf(PASTE_START) > answer.line.lastIndexOf(PASTE_END);
        if (!noted) output.write(`  ${TYPED_AHEAD}\n`);
        noted = true;
        continue;
      }
      const value = answer.line.trim().toLowerCase();
      if (value === START_KEY) return { start: true, ...(selected && { selected }) };
      if (value === "q" || value === "quit") return "quit";
      const option = /^[1-9]$/.test(value) ? options[Number(value) - 1] : undefined;
      if (option) {
        selected = option.key;
        output.write(
          `  ${option.label} is selected. Press ${START_KEY} to start with ${option.label}, or q to leave.\n`,
        );
        continue;
      }
      output.write(`  ${START_HINT}\n`);
    }
  } finally {
    paste.off();
    next.close?.();
  }
}
