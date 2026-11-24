import type { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import {
  canAnimate,
  canColor,
  type TerminalEnv,
  type TerminalOutput,
  terminalWidth,
} from "./mode.js";
import { safeLine, truncateVisible, visibleWidth } from "./style.js";

/**
 * ui/live.ts: a region of the terminal that redraws in place.
 *
 * The techniques (log-update, Ink): erase exactly the rows written, cut rows at
 * the width, clip the frame to the height, repaint only the lines that changed,
 * wrap every frame in synchronized-output markers, hide the cursor while
 * drawing and show it again on stop, on process exit, and on a signal.
 */
export interface LiveRegion {
  render(lines: string[]): void;
  /** Paint a pending frame now instead of at the next frame tick. */
  flush(): void;
  persist(): void;
  stop(): void;
}

/** The part of `process` the terminal lifecycle needs. Tests pass a fake so no real signal is sent. */
export interface TerminalHost {
  readonly pid: number;
  once(event: "exit" | Signal, listener: () => void): unknown;
  prependListener(event: Signal, listener: () => void): unknown;
  off(event: "exit" | Signal, listener: () => void): unknown;
  listenerCount(event: Signal): number;
  kill(pid: number, signal: Signal): unknown;
}

export interface LiveRegionOptions {
  env?: TerminalEnv;
  /** Clock for the frame throttle, in milliseconds. */
  now?(): number;
  host?: TerminalHost;
  /**
   * Called on a terminal resize before the region repaints, so the owner can
   * render a frame for the new size. That frame is painted in the same write.
   */
  onResize?(): void;
}

const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
export type Signal = (typeof signals)[number];
const ESC = "\u001b[";
export const HIDE_CURSOR = `${ESC}?25l`;
export const SHOW_CURSOR = `${ESC}?25h`;
export const SYNC_START = `${ESC}?2026h`;
export const SYNC_END = `${ESC}?2026l`;
const synchronize = (frame: string) => `${SYNC_START}${frame}${SYNC_END}`;
const FRAME_MS = 100;

const active = new WeakMap<Writable, { print(line: string): void; persist(): void }>();

interface Lifecycle {
  cleanups: Set<(signal?: Signal) => void>;
  exit(): void;
  handlers: Record<Signal, () => void>;
}
const lifecycles = new WeakMap<TerminalHost, Lifecycle>();

function lifecycle(host: TerminalHost): Lifecycle {
  const known = lifecycles.get(host);
  if (known) return known;
  const cleanups = new Set<(signal?: Signal) => void>();
  const clean = (signal?: Signal) => {
    for (const cleanup of [...cleanups]) cleanup(signal);
  };
  function handle(signal: Signal): void {
    // A command may own Ctrl-C to report its saved progress. Otherwise deliver
    // the signal again with the default disposition after restoring the terminal.
    const hasCommandHandler = host.listenerCount(signal) > 1;
    clean(signal);
    if (!hasCommandHandler) host.kill(host.pid, signal);
  }
  const created: Lifecycle = {
    cleanups,
    exit: () => clean(),
    handlers: {
      SIGINT: () => handle("SIGINT"),
      SIGTERM: () => handle("SIGTERM"),
      SIGHUP: () => handle("SIGHUP"),
    },
  };
  lifecycles.set(host, created);
  return created;
}

/**
 * Couple raw input and live output to the same terminal cleanup lifecycle.
 * The cleanup learns which signal ended the process, or none for a normal exit.
 */
export function onTerminalExit(
  cleanup: (signal?: Signal) => void,
  host: TerminalHost = process as unknown as TerminalHost,
): () => void {
  const life = lifecycle(host);
  if (life.cleanups.size === 0) {
    host.once("exit", life.exit);
    for (const signal of signals) host.prependListener(signal, life.handlers[signal]);
  }
  life.cleanups.add(cleanup);
  return () => {
    if (!life.cleanups.delete(cleanup) || life.cleanups.size > 0) return;
    host.off("exit", life.exit);
    for (const signal of signals) host.off(signal, life.handlers[signal]);
  };
}

/** One row stays free so the cursor's resting row never scrolls the frame. */
export function frameHeight(output: TerminalOutput): number {
  return Math.max(1, Math.floor(output.rows || 24) - 1);
}

/** Keep a failure or announcement in scrollback, even while a stage is drawing. */
export function writeAbove(out: Writable, line: string, env?: TerminalEnv): void {
  const region = active.get(out);
  if (region) region.print(line);
  else {
    const text = line.replace(/\n$/, "");
    out.write(`${canColor({ output: out, env }) ? text : stripVTControlCharacters(text)}\n`);
  }
}

export function persistLiveRegion(out: Writable): void {
  active.get(out)?.persist();
}

/**
 * The cursor rests at column one on the last drawn row. Only one region owns an output.
 * Drawing depends on the output alone; a menu that also reads keys checks its input first.
 * Returns null when the output is not a drawing terminal.
 */
export function liveRegion(out: Writable, options: LiveRegionOptions = {}): LiveRegion | null {
  if (!canAnimate({ output: out, env: options.env }) || active.has(out)) return null;
  const now = options.now ?? Date.now;
  const terminal: TerminalOutput = out;
  let previous: string[] = [];
  let desired: string[] = [];
  let lastPaint = Number.NEGATIVE_INFINITY;
  let pending: NodeJS.Timeout | undefined;
  let closed = false;
  let resizing = false;

  function clearTimer(): void {
    clearTimeout(pending);
    pending = undefined;
  }

  function erase(): string {
    if (previous.length === 0) return "";
    // When a window narrows, a previously single row can occupy several rows.
    const cols = terminalWidth(terminal);
    const spans = previous.map((line) => Math.max(1, Math.ceil(visibleWidth(line) / cols)));
    const height = spans.reduce((total, span) => total + span, 0);
    const aboveCursor = height - (spans.at(-1) ?? 1);
    let bytes = aboveCursor ? `${ESC}${aboveCursor}A\r` : "\r";
    bytes += `${ESC}2K`;
    bytes += `${ESC}1B\r${ESC}2K`.repeat(height - 1);
    if (height > 1) bytes += `${ESC}${height - 1}A`;
    previous = [];
    return bytes;
  }

  function repaint(): string {
    const columns = Math.max(1, terminalWidth(terminal) - 1);
    const next = desired
      .slice(0, frameHeight(terminal))
      .map((line) => truncateVisible(line, columns));
    let cursor = Math.max(0, previous.length - 1);
    let bytes = "";
    function move(to: number): void {
      if (cursor !== to) bytes += `${ESC}${Math.abs(cursor - to)}${cursor > to ? "A" : "B"}`;
      bytes += "\r";
      cursor = to;
    }
    const common = Math.min(previous.length, next.length);
    for (let i = 0; i < common; i++) {
      if (previous[i] === next[i]) continue;
      move(i);
      bytes += `${ESC}2K${next[i]}`;
    }
    if (next.length > common) {
      move(Math.max(0, common - 1));
      for (let i = common; i < next.length; i++) {
        if (i > 0) bytes += "\r\n";
        bytes += `${ESC}2K${next[i]}`;
        cursor = i;
      }
    }
    for (let i = common; i < previous.length; i++) {
      move(i);
      bytes += `${ESC}2K`;
    }
    if (bytes) move(Math.max(0, next.length - 1));
    previous = next;
    return bytes;
  }

  function paint(): void {
    clearTimer();
    if (closed) return;
    const bytes = repaint();
    if (bytes) out.write(synchronize(bytes));
    lastPaint = now();
  }

  function resize(): void {
    if (closed) return;
    clearTimer();
    resizing = true;
    try {
      options.onResize?.();
    } finally {
      resizing = false;
    }
    if (closed) return;
    out.write(synchronize(erase() + repaint()));
    lastPaint = now();
  }

  function close(persist: boolean): void {
    if (closed) return;
    closed = true;
    clearTimer();
    out.off("resize", resize);
    unregister();
    active.delete(out);
    const bytes = persist ? repaint() + (previous.length ? "\r\n" : "") : erase();
    out.write(synchronize(`${bytes}${SHOW_CURSOR}`));
  }

  const region: LiveRegion = {
    render(lines) {
      if (closed) return;
      desired = lines.flatMap((line) => line.split("\n").map(safeLine));
      if (resizing) return;
      const wait = lastPaint + FRAME_MS - now();
      if (wait <= 0) paint();
      else if (!pending) {
        pending = setTimeout(paint, wait);
        pending.unref();
      }
    },
    flush() {
      if (pending) paint();
    },
    persist: () => close(true),
    stop: () => close(false),
  };
  const unregister = onTerminalExit(() => region.stop(), options.host);
  active.set(out, {
    persist: region.persist,
    print(line) {
      clearTimer();
      const message = line.replace(/\n$/, "").split("\n").map(safeLine).join("\r\n");
      out.write(synchronize(`${erase()}${message}\r\n${repaint()}`));
      lastPaint = now();
    },
  });
  out.on("resize", resize);
  out.write(HIDE_CURSOR);
  return region;
}
