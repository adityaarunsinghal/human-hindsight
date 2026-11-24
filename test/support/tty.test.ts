import { emitKeypressEvents } from "node:readline";
import { describe, expect, it } from "vitest";
import type { TerminalInput, TerminalOutput } from "../../src/ui/mode.js";
import { fakeInput, fakeOutput, KEYS } from "./tty.js";

describe("fakeOutput", () => {
  it("defaults to an 80 by 24 terminal and fits the project's terminal type", () => {
    const out: TerminalOutput = fakeOutput();
    expect([out.isTTY, out.columns, out.rows]).toEqual([true, 80, 24]);
  });

  it("records raw chunks and exposes text and escapes", () => {
    const out = fakeOutput({ isTTY: false, columns: 60, rows: 12 });
    out.write("\u001b[?25l");
    out.write("\u001b[1mhello\u001b[0m\n");
    out.write(Buffer.from("bytes too"));
    expect(out.chunks).toEqual(["\u001b[?25l", "\u001b[1mhello\u001b[0m\n", "bytes too"]);
    expect(out.text()).toBe("hello\nbytes too");
    expect(out.escapes()).toEqual(["\u001b[?25l", "\u001b[1m", "\u001b[0m"]);
    expect([out.isTTY, out.columns, out.rows]).toEqual([false, 60, 12]);
    out.clear();
    expect(out.raw()).toBe("");
  });

  it("resize sets the size and emits resize", () => {
    const out = fakeOutput();
    const seen: number[][] = [];
    out.on("resize", () => seen.push([out.columns, out.rows]));
    out.resize(40, 10);
    expect(seen).toEqual([[40, 10]]);
  });
});

describe("fakeInput", () => {
  it("records setRawMode and keeps isRaw in step", () => {
    const input: TerminalInput = fakeInput();
    input.setRawMode?.(true);
    expect(input.isRaw).toBe(true);
    input.setRawMode?.(false);
    expect(fakeInput({ isRaw: true }).isRaw).toBe(true);
    expect((input as ReturnType<typeof fakeInput>).rawModeCalls).toEqual([true, false]);
  });

  it("delivers pressed keys as keypress events and then ends", async () => {
    const input = fakeInput();
    emitKeypressEvents(input);
    const names: string[] = [];
    input.on("keypress", (_text: string, key: { name?: string }) => names.push(key?.name ?? ""));
    const ended = new Promise<void>((resolve) => input.once("end", () => resolve()));
    input.resume();
    input.press(KEYS.down, KEYS.up, "2", KEYS.enter);
    input.end();
    await ended;
    expect(names).toEqual(["down", "up", "2", "return"]);
  });

  it("can be a pipe instead of a terminal", () => {
    expect(fakeInput({ isTTY: false }).isTTY).toBe(false);
  });
});
