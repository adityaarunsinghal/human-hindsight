import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  HIDE_CURSOR,
  liveRegion,
  SHOW_CURSOR,
  SYNC_END,
  SYNC_START,
  type TerminalHost,
  writeAbove,
} from "../src/ui/live.js";
import { createClock } from "./support/clock.js";
import { fakeOutput } from "./support/tty.js";
import { terminalModel } from "./ui-vt.js";

const ENV = { TERM: "xterm-256color" };
const ESC = "\u001b[";

/** A process stand-in: signals are events, and `kill` is recorded instead of sent. */
function fakeHost(): TerminalHost & EventEmitter & { kills: string[] } {
  const host = new EventEmitter() as TerminalHost & EventEmitter & { kills: string[] };
  Object.assign(host, { pid: 4242, kills: [] });
  host.kill = (_pid, signal) => host.kills.push(signal);
  return host;
}

function setup(o: { columns?: number; rows?: number; isTTY?: boolean; env?: object } = {}) {
  const out = fakeOutput({ columns: o.columns ?? 80, rows: o.rows ?? 24, isTTY: o.isTTY });
  const clock = createClock();
  const host = fakeHost();
  const region = liveRegion(out, { env: { ...ENV, ...o.env }, now: clock.nowMs, host });
  // Each frame is painted at once: every render comes a full frame interval later.
  const render = (lines: string[]) => {
    clock.advance(100);
    region?.render(lines);
  };
  return { out, clock, host, region, render };
}

const count = (text: string, part: string) => text.split(part).length - 1;

describe("live region", () => {
  it("rewrites only the one line that changed in a three-line frame", () => {
    const { out, render } = setup();
    render(["alpha", "bravo", "charlie"]);
    out.clear();
    render(["alpha", "BRAVO", "charlie"]);
    // Up one row, erase it, write it, back down to the resting row.
    expect(out.raw()).toBe(`${SYNC_START}${ESC}1A\r${ESC}2KBRAVO${ESC}1B\r${SYNC_END}`);
  });

  it("repaints nothing when the frame is unchanged", () => {
    const { out, render } = setup();
    render(["alpha", "bravo"]);
    out.clear();
    render(["alpha", "bravo"]);
    expect(out.raw()).toBe("");
  });

  it("cuts a 120-character line to 79 visible characters at 80 columns", () => {
    const { out, render } = setup({ columns: 80 });
    render(["x".repeat(120)]);
    const vt = terminalModel(80);
    vt.apply(out.raw());
    expect(vt.rows()).toEqual([`${"x".repeat(78)}…`]);
    expect(vt.rows()[0]).toHaveLength(79);
  });

  it("clips 40 lines to a 24-row terminal, keeping one row free", () => {
    const { out, render } = setup({ rows: 24 });
    render(Array.from({ length: 40 }, (_, i) => `line ${i + 1}`));
    const vt = terminalModel(80);
    vt.apply(out.raw());
    expect(vt.rows()).toHaveLength(23);
    expect(vt.rows().at(-1)).toBe("line 23");
  });

  it("clears the two rows left over when a five-line frame shrinks to three", () => {
    const { out, render } = setup();
    const vt = terminalModel(80);
    render(["one", "two", "three", "four", "five"]);
    vt.apply(out.raw());
    out.clear();
    render(["one", "two", "three"]);
    expect(count(out.raw(), `${ESC}2K`)).toBe(2);
    vt.apply(out.raw());
    expect(vt.rows()).toEqual(["one", "two", "three"]);
    expect(vt.cursor).toEqual({ row: 2, column: 0 });
  });

  it("erases every wrapped row after a resize to a narrower width", () => {
    const { out, region, render } = setup({ columns: 80 });
    render(["a".repeat(70), "b".repeat(70)]);
    out.clear();
    out.resize(40, 24);
    // Each 70-column row now wraps onto two rows: four rows in all. The cursor
    // sits on the first row of the last line, so erasing starts two rows up.
    const erase = `${ESC}2A\r${ESC}2K${`${ESC}1B\r${ESC}2K`.repeat(3)}${ESC}3A`;
    const repaint = `\r${ESC}2K${"a".repeat(38)}…\r\n${ESC}2K${"b".repeat(38)}…\r`;
    expect(out.raw()).toBe(`${SYNC_START}${erase}${repaint}${SYNC_END}`);
    region?.stop();
  });

  it("wraps every frame in synchronized-output markers", () => {
    const { out, region, render } = setup();
    render(["one"]);
    render(["one", "two"]);
    writeAbove(out, "a note");
    out.resize(60, 20);
    region?.persist();
    const [hide, ...frames] = out.chunks;
    expect(hide).toBe(HIDE_CURSOR);
    expect(frames.length).toBe(5);
    for (const frame of frames) {
      expect(frame.startsWith(SYNC_START)).toBe(true);
      expect(frame.endsWith(SYNC_END)).toBe(true);
    }
  });

  it.each([
    ["stop", (s: ReturnType<typeof setup>) => s.region?.stop()],
    ["persist", (s: ReturnType<typeof setup>) => s.region?.persist()],
    ["process exit", (s: ReturnType<typeof setup>) => s.host.emit("exit")],
    ["a signal", (s: ReturnType<typeof setup>) => s.host.emit("SIGTERM")],
  ])("hides the cursor once and shows it once on %s", (_name, end) => {
    const s = setup();
    s.render(["working"]);
    end(s);
    // A later stop, exit, or signal does nothing more.
    s.region?.stop();
    s.host.emit("exit");
    const raw = s.out.raw();
    expect(count(raw, HIDE_CURSOR)).toBe(1);
    expect(count(raw, SHOW_CURSOR)).toBe(1);
    expect(raw.lastIndexOf(SHOW_CURSOR)).toBeGreaterThan(raw.indexOf(HIDE_CURSOR));
    expect(s.host.listenerCount("exit")).toBe(0);
    expect(s.host.listenerCount("SIGINT")).toBe(0);
  });

  it("delivers a signal again after restoring the terminal, unless a command handles it", () => {
    const alone = setup();
    alone.host.emit("SIGINT");
    expect(alone.host.kills).toEqual(["SIGINT"]);
    expect(alone.out.raw().endsWith(`${SHOW_CURSOR}${SYNC_END}`)).toBe(true);

    const handled = setup();
    let reported = 0;
    handled.host.on("SIGINT", () => reported++);
    handled.host.emit("SIGINT");
    expect(handled.host.kills).toEqual([]);
    expect(reported).toBe(1);
    expect(count(handled.out.raw(), SHOW_CURSOR)).toBe(1);
  });

  it("keeps the region intact below a line written above it", () => {
    const { out, render, region } = setup();
    const vt = terminalModel(80);
    render(["Reading 1/3", "Running  alpha"]);
    writeAbove(out, "failed: beta");
    vt.apply(out.raw());
    expect(vt.rows()).toEqual(["failed: beta", "Reading 1/3", "Running  alpha"]);
    out.clear();
    render(["Reading 2/3", "Running  alpha"]);
    vt.apply(out.raw());
    expect(vt.rows()).toEqual(["failed: beta", "Reading 2/3", "Running  alpha"]);
    region?.persist();
    vt.apply(out.raw());
    expect(vt.rows()).toEqual(["failed: beta", "Reading 2/3", "Running  alpha"]);
    expect(vt.cursor.row).toBe(3);
  });

  it("holds a frame that comes too soon and paints it on flush or at the next tick", () => {
    const out = fakeOutput();
    const clock = createClock();
    const region = liveRegion(out, { env: ENV, now: clock.nowMs, host: fakeHost() });
    region?.render(["first"]);
    out.clear();
    region?.render(["second"]);
    expect(out.raw()).toBe("");
    region?.flush();
    expect(out.text()).toContain("second");
    region?.stop();
  });

  it.each([
    ["a pipe", { isTTY: false }],
    ["TERM=dumb", { env: { TERM: "dumb" } }],
    ["plain mode", { env: { HUMAN_HINDSIGHT_PLAIN: "1" } }],
  ])("draws no region into %s", (_name, o) => {
    const { out, region, host } = setup(o);
    expect(region).toBeNull();
    expect(out.raw()).toBe("");
    expect(host.listenerCount("exit")).toBe(0);
    writeAbove(out, "failed: beta", { ...ENV, ...("env" in o ? o.env : {}) });
    expect(out.raw()).toBe("failed: beta\n");
  });

  it("strips color from a line written above nothing into a pipe", () => {
    const out = fakeOutput({ isTTY: false });
    writeAbove(out, "\u001b[31mfailed: beta\u001b[39m\n", ENV);
    expect(out.raw()).toBe("failed: beta\n");
  });

  it("lets only one region own an output at a time", () => {
    const { out, region } = setup();
    expect(liveRegion(out, { env: ENV, host: fakeHost() })).toBeNull();
    region?.stop();
    const next = liveRegion(out, { env: ENV, host: fakeHost() });
    expect(next).not.toBeNull();
    next?.stop();
  });
});
