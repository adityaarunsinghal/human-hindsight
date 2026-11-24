import { Readable, Writable } from "node:stream";
import { escapeSequences, stripEscapes } from "./text.js";

/**
 * test/support/tty.ts: fake terminal streams.
 *
 * `fakeOutput()` stands in for stdout or stderr. It records every write as a
 * raw chunk and lets a test set `isTTY`, `columns`, and `rows`, and fire a
 * resize the way a real terminal does.
 *
 *   const out = fakeOutput({ columns: 60, rows: 12 });
 *   render(out);
 *   out.text();        // visible text, escapes stripped
 *   out.escapes();     // ["\x1b[?25l", "\x1b[2K", ...] in order
 *   out.resize(40, 10) // sets the size and emits "resize"
 *
 * `fakeInput()` stands in for stdin. A test pushes key bytes and ends the
 * stream; every `setRawMode` call is recorded, and `isRaw` follows it like a
 * real TTY.
 *
 *   const input = fakeInput();
 *   input.press("\x1b[B", "\r");  // down arrow, then Enter
 *   input.end();                  // Ctrl-D or a closed pipe
 *   input.rawModeCalls;           // [true, false]
 *
 * Neither stream touches the real terminal.
 */

export interface FakeOutputOptions {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

export interface FakeOutput extends Writable {
  isTTY: boolean;
  columns: number;
  rows: number;
  /** Every write, as written. */
  readonly chunks: string[];
  /** All writes joined, escapes included. */
  raw(): string;
  /** All writes joined, escapes stripped. */
  text(): string;
  /** Every escape sequence written, in order. */
  escapes(): string[];
  /** Forget everything written so far. */
  clear(): void;
  /** Set the size and emit `resize`, as a terminal does. */
  resize(columns: number, rows: number): void;
}

export function fakeOutput(options: FakeOutputOptions = {}): FakeOutput {
  const chunks: string[] = [];
  const stream = new Writable({
    decodeStrings: false,
    write(chunk: unknown, _encoding, callback) {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString());
      callback();
    },
  }) as FakeOutput;
  stream.isTTY = options.isTTY ?? true;
  stream.columns = options.columns ?? 80;
  stream.rows = options.rows ?? 24;
  Object.defineProperty(stream, "chunks", { value: chunks });
  stream.raw = () => chunks.join("");
  stream.text = () => stripEscapes(stream.raw());
  stream.escapes = () => escapeSequences(stream.raw());
  stream.clear = () => {
    chunks.length = 0;
  };
  stream.resize = (columns, rows) => {
    stream.columns = columns;
    stream.rows = rows;
    stream.emit("resize");
  };
  return stream;
}

export interface FakeInputOptions {
  isTTY?: boolean;
  /** Start in raw mode, as when a caller already enabled it. */
  isRaw?: boolean;
}

export interface FakeInput extends Readable {
  isTTY: boolean;
  isRaw: boolean;
  /** Arguments of every `setRawMode` call, in order. */
  readonly rawModeCalls: boolean[];
  setRawMode(enabled: boolean): FakeInput;
  /** Push key bytes, one chunk per argument (a keypress per chunk). */
  press(...keys: string[]): void;
  /** End the stream, like Ctrl-D on an empty line or a closed pipe. */
  end(): void;
}

/** Named key bytes for {@link FakeInput.press}. */
export const KEYS = {
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  left: "\u001b[D",
  enter: "\r",
  escape: "\u001b",
  ctrlC: "\u0003",
  ctrlD: "\u0004",
  backspace: "\u007f",
  tab: "\t",
} as const;

export function fakeInput(options: FakeInputOptions = {}): FakeInput {
  const rawModeCalls: boolean[] = [];
  const stream = new Readable({ read() {} }) as FakeInput;
  stream.isTTY = options.isTTY ?? true;
  stream.isRaw = options.isRaw ?? false;
  Object.defineProperty(stream, "rawModeCalls", { value: rawModeCalls });
  stream.setRawMode = (enabled: boolean) => {
    rawModeCalls.push(enabled);
    stream.isRaw = enabled;
    return stream;
  };
  stream.press = (...keys: string[]) => {
    for (const key of keys) stream.push(key);
  };
  stream.end = () => {
    stream.push(null);
  };
  return stream;
}
