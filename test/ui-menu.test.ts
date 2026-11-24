import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { HIDE_CURSOR, SHOW_CURSOR, type TerminalHost } from "../src/ui/live.js";
import { chooseMenu, chooseMenuAnswer, type MenuChoice, readLine } from "../src/ui/prompt.js";
import { type FakeInput, type FakeOutput, fakeInput, fakeOutput, KEYS } from "./support/tty.js";
import { terminalModel } from "./ui-vt.js";

const ENV = { TERM: "xterm-256color" };

function fakeHost(): TerminalHost & EventEmitter & { kills: string[] } {
  const host = new EventEmitter() as TerminalHost & EventEmitter & { kills: string[] };
  Object.assign(host, { pid: 4242, kills: [] });
  host.kill = (_pid, signal) => host.kills.push(signal);
  return host;
}

/** Let pushed key bytes reach the menu. No timer: one turn of the event loop. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function choices(n: number, recommended = 0): MenuChoice<string>[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `k${i + 1}`,
    label: `Choice ${i + 1}`,
    ...(i === recommended ? { recommended: true } : {}),
  }));
}

type Env = Record<string, string | undefined>;

function terminal(o: { rows?: number; env?: Env; inputTTY?: boolean } = {}) {
  const input = fakeInput({ isTTY: o.inputTTY ?? true });
  const output = fakeOutput({ columns: 80, rows: o.rows ?? 24 });
  const host = fakeHost();
  const env: Env = { ...ENV, ...o.env };
  const io = { input, output, host, env, wait: async () => {} };
  return { input, output, host, io };
}

/** The terminal is as it was: raw mode off, the cursor visible, nothing left listening. */
function expectRestored(input: FakeInput, output: FakeOutput, host: EventEmitter): void {
  expect(input.isRaw).toBe(false);
  if (input.rawModeCalls.length) expect(input.rawModeCalls.at(-1)).toBe(false);
  const raw = output.raw();
  expect(raw.lastIndexOf(SHOW_CURSOR)).toBeGreaterThanOrEqual(raw.lastIndexOf(HIDE_CURSOR));
  expect(input.listenerCount("keypress")).toBe(0);
  expect(host.listenerCount("SIGINT")).toBe(0);
  expect(host.listenerCount("exit")).toBe(0);
}

describe("single-key menu", () => {
  it.each([
    ["up from the first item wraps to the last", [KEYS.up, KEYS.enter], "k3"],
    ["down from the last item wraps to the first", [KEYS.up, KEYS.down, KEYS.enter], "k1"],
    ["down then Enter takes the next item", [KEYS.down, KEYS.enter], "k2"],
    ["a digit takes that item at once", ["2"], "k2"],
    ["a digit past the list is ignored", ["7", "3"], "k3"],
    ["Enter takes the recommended item", [KEYS.enter], "k1"],
    ["q quits quietly", ["q"], "quit"],
    ["Ctrl-D quits quietly", [KEYS.ctrlD], "quit"],
    ["Ctrl-C is an interrupt", [KEYS.ctrlC], "interrupt"],
  ])("%s", async (_name, keys, expected) => {
    const { input, output, host, io } = terminal();
    const answer = chooseMenuAnswer({ title: "Pick one", choices: choices(3) }, io);
    input.press(...keys);
    expect(await answer).toBe(expected);
    expect(input.rawModeCalls).toEqual([true, false]);
    expectRestored(input, output, host);
    const interruptLines = output.text().split("Interrupted.").length - 1;
    expect(interruptLines).toBe(expected === "interrupt" ? 1 : 0);
  });

  it("starts on the recommended item and Enter takes it", async () => {
    const { input, io } = terminal();
    const answer = chooseMenuAnswer({ title: "Pick", choices: choices(3, 1) }, io);
    input.press(KEYS.enter);
    expect(await answer).toBe("k2");
  });

  it("keeps a wrapped recommendation inside the arrow gutter when the cursor moves", async () => {
    const { input, output, io } = terminal();
    output.resize(32, 24);
    const answer = chooseMenuAnswer(
      {
        title: "Pick",
        choices: [
          { key: "resume", label: "Resume my reflection", recommended: true },
          { key: "read", label: "Read my preferences" },
          { key: "quit", label: "Quit", detail: "q" },
        ],
      },
      io,
    );
    input.press(KEYS.down);
    await settle();
    const vt = terminalModel(32);
    vt.apply(output.raw());
    const frame = vt.rows().join("\n");
    expect(frame).toContain(
      "Pick\n\n• Resume my reflection\n  (recommended)\n\n› Read my preferences",
    );
    expect(frame.match(/^› /gm)).toHaveLength(1);
    expect(frame.match(/^• /gm)).toHaveLength(2);
    input.press(KEYS.down, KEYS.enter);
    expect(await answer).toBe("quit");
  });

  it("quits at the end of input", async () => {
    const { input, output, host, io } = terminal();
    const answer = chooseMenuAnswer({ title: "Pick", choices: choices(3) }, io);
    input.end();
    expect(await answer).toBe("quit");
    expectRestored(input, output, host);
  });

  it("returns interrupt on a SIGINT from outside the terminal", async () => {
    const { input, output, host, io } = terminal();
    const answer = chooseMenuAnswer({ title: "Pick", choices: choices(3) }, io);
    await settle();
    host.emit("SIGINT");
    expect(await answer).toBe("interrupt");
    expect(host.kills).toEqual([]);
    expectRestored(input, output, host);
  });

  it("treats Ctrl-C as quit for callers of chooseMenu", async () => {
    const { input, io } = terminal();
    const answer = chooseMenu({ title: "Pick", choices: choices(3) }, io);
    input.press(KEYS.ctrlC);
    expect(await answer).toBe("quit");
  });

  it("selects from the items as last drawn, not from a list changed since", async () => {
    const { input, io } = terminal();
    const list = choices(3);
    const answer = chooseMenuAnswer({ title: "Pick", choices: list }, io);
    await settle();
    // A late fact replaces the list, but the screen has not been redrawn yet.
    list.splice(0, list.length, { key: "late", label: "Late item", recommended: true });
    input.press("2");
    input.end(); // a key that selected nothing would otherwise wait forever
    expect(await answer).toBe("k2");
  });

  it("moves to the new default when the highlighted item is removed", async () => {
    const { input, output, host, io } = terminal();
    const list = choices(3, 1);
    let redraw = () => {};
    const answer = chooseMenuAnswer(
      { title: "Pick", choices: list, onRedraw: (r) => (redraw = r) },
      io,
    );
    input.press(KEYS.down);
    await settle();
    list.splice(2, 1); // the highlighted third item disappears
    redraw();
    expect(output.text()).not.toMatch(/Choice 3\s*$/);
    input.press("3", KEYS.enter);
    expect(await answer).toBe("k2");
    expectRestored(input, output, host);
  });

  it("redraws when facts settle and keeps the items on screen", async () => {
    const { input, output, io } = terminal();
    let state = "checking";
    let resolveFacts = () => {};
    const settled = new Promise<void>((resolve) => {
      resolveFacts = resolve;
    });
    const answer = chooseMenuAnswer(
      { title: "Pick", choices: choices(2), above: () => [`Sign-in ${state}`], settled },
      io,
    );
    state = "ready";
    resolveFacts();
    await settle();
    expect(output.text()).toContain("Sign-in ready");
    input.press("q");
    expect(await answer).toBe("quit");
  });

  it.each([
    ["the first draw", 2],
    ["a later redraw", 3],
  ])("restores the terminal when the frame function throws during %s", async (_name, failOn) => {
    const { input, output, host, io } = terminal();
    let calls = 0;
    let redraw = () => {};
    const answer = chooseMenuAnswer(
      {
        title: "Pick",
        choices: choices(2),
        above: () => {
          calls++;
          if (calls === failOn) throw new Error("render failed");
          return ["table"];
        },
        onRedraw: (r) => (redraw = r),
      },
      io,
    );
    redraw();
    await expect(answer).rejects.toThrow("render failed");
    expectRestored(input, output, host);
  });

  it("restores the terminal on process exit while waiting for a key", async () => {
    const { input, output, host, io } = terminal();
    const answer = chooseMenuAnswer({ title: "Pick", choices: choices(2) }, io);
    await settle();
    host.emit("exit");
    expect(await answer).toBe("quit");
    expectRestored(input, output, host);
  });

  it("trims the lines above the menu when the terminal gets shorter, keeping the first", async () => {
    const { input, output, io } = terminal({ rows: 12 });
    const above = () => Array.from({ length: 5 }, (_, i) => `row ${i + 1}`);
    const answer = chooseMenuAnswer({ title: "Pick", choices: choices(2), above }, io);
    await settle();
    output.clear();
    output.resize(80, 8);
    const text = output.text();
    expect(text).toContain("Choice 2");
    // The first line is the screen's title; the oldest lines after it go first.
    expect(text).toContain("row 1");
    expect(text).not.toContain("row 2");
    input.press("1");
    expect(await answer).toBe("k1");
  });
});

describe("numbered menu fallback", () => {
  it.each([
    ["ten or more choices", { n: 10 }],
    ["a terminal shorter than the frame", { n: 3, rows: 4 }],
    ["TERM=dumb", { n: 3, env: { TERM: "dumb" } }],
    ["plain mode", { n: 3, env: { HUMAN_HINDSIGHT_PLAIN: "1" } }],
    ["no way to read single keys", { n: 3, noRaw: true }],
  ])("prints the frame once and reads a numbered line for %s", async (_name, o) => {
    const { input, output, host, io } = terminal({
      rows: "rows" in o ? o.rows : 24,
      env: "env" in o ? o.env : {},
    });
    if ("noRaw" in o) Object.assign(input, { setRawMode: undefined });
    const answer = chooseMenuAnswer({ title: "Pick", choices: choices(o.n) }, io);
    await settle();
    input.press(`${o.n}\n`);
    expect(await answer).toBe(`k${o.n}`);
    expect(input.rawModeCalls).toEqual([]);
    expect(output.raw()).not.toContain(HIDE_CURSOR);
    expect(output.text()).toContain(`${o.n}  Choice ${o.n}`);
    expect(output.text().match(/Pick/g)).toHaveLength(1);
    expectRestored(input, output, host);
  });

  it.each([
    ["an empty line takes the recommended item", "\n", "k2"],
    ["q quits", "q\n", "quit"],
    ["a choice key works", "k3\n", "k3"],
    ["a wrong answer asks again", "x\n1\n", "k1"],
  ])("%s", async (_name, typed, expected) => {
    const { input, output, io } = terminal({ env: { HUMAN_HINDSIGHT_PLAIN: "1" } });
    const answer = chooseMenuAnswer({ title: "Pick", choices: choices(3, 1) }, io);
    // One line at a time, as a person types, each once the question is asked.
    for (const line of typed.split(/(?<=\n)/)) {
      await settle();
      input.press(line);
      await settle();
    }
    expect(await answer).toBe(expected);
    if (typed.startsWith("x")) expect(output.text()).toContain("Enter a number from 1 to 3");
  });

  it("quits at the end of input and on Ctrl-D", async () => {
    for (const finish of [(i: FakeInput) => i.end(), (i: FakeInput) => i.press("\u0004\n")]) {
      const { input, io } = terminal({ env: { HUMAN_HINDSIGHT_PLAIN: "1" } });
      const answer = chooseMenuAnswer({ title: "Pick", choices: choices(3) }, io);
      await settle();
      finish(input);
      expect(await answer).toBe("quit");
    }
  });

  it("returns interrupt with one line on Ctrl-C", async () => {
    const { output, host, io } = terminal({ env: { HUMAN_HINDSIGHT_PLAIN: "1" } });
    const answer = chooseMenuAnswer({ title: "Pick", choices: choices(3) }, io);
    await settle();
    host.emit("SIGINT");
    expect(await answer).toBe("interrupt");
    expect(output.text().match(/Interrupted\./g)).toHaveLength(1);
    expect(host.listenerCount("SIGINT")).toBe(0);
  });

  it("prints only the lines above and asks nothing in CI or a pipe", async () => {
    for (const env of [{ CI: "true" }, {}] as Env[]) {
      const { input, output, io } = terminal({ env, inputTTY: "CI" in env });
      const answer = await chooseMenuAnswer(
        { title: "Pick", choices: choices(3), above: () => ["Setup table"] },
        io,
      );
      expect(answer).toBe("quit");
      expect(output.text()).toBe("Setup table\n");
      expect(input.rawModeCalls).toEqual([]);
    }
  });

  it("freezes the numbered list as printed", async () => {
    const { input, io } = terminal({ env: { HUMAN_HINDSIGHT_PLAIN: "1" } });
    const list = choices(3);
    const answer = chooseMenuAnswer({ title: "Pick", choices: list }, io);
    await settle();
    list.splice(0, list.length, { key: "late", label: "Late" });
    input.press("2\n");
    expect(await answer).toBe("k2");
  });
});

describe("readLine", () => {
  it("returns the line, or null at the end of input and on Ctrl-C", async () => {
    const typed = terminal();
    const line = readLine("Name? ", typed.io);
    await settle();
    typed.input.press("value\n");
    expect(await line).toBe("value");

    const ended = terminal();
    const none = readLine("Name? ", ended.io);
    ended.input.end();
    expect(await none).toBeNull();

    const interrupted = terminal();
    const cancelled = readLine("Name? ", interrupted.io);
    await settle();
    interrupted.host.emit("SIGINT");
    expect(await cancelled).toBeNull();
    expect(interrupted.host.listenerCount("SIGINT")).toBe(0);
  });
});
