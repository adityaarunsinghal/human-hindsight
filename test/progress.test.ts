import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminalPrivacyReminder } from "../src/ui/privacy.js";
import { startProgress, withSpinner } from "../src/ui/progress.js";

function output(tty = false, columns = 80) {
  let text = "";
  const stream = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        text += chunk.toString();
        done();
      },
    }),
    { isTTY: tty, columns },
  );
  return { stream, text: () => text };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("terminal progress", () => {
  it("draws before starting the work and clears after successful asynchronous work", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TERM", "xterm-256color");
    const cap = output(true);
    let started = false;
    const work = withSpinner(cap.stream, "Preparing exports", async () => {
      started = true;
      expect(cap.text()).toContain("Preparing exports");
      await new Promise((resolve) => setTimeout(resolve, 250));
      return "ready";
    });
    expect(started).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    await expect(work).resolves.toBe("ready");
    expect(cap.text()).toContain("0.2s");
    expect(cap.text().endsWith("\r\u001b[2K")).toBe(true);
  });

  it("appears immediately, animates, updates its stage, and cleans up once", () => {
    vi.useFakeTimers();
    vi.stubEnv("TERM", "xterm-256color");
    const cap = output(true);
    const before = process.listenerCount("exit");
    const progress = startProgress(cap.stream, "Reading session history");
    expect(cap.text()).toContain("human-hindsight");
    expect(cap.text()).toContain("Reading session history");
    vi.advanceTimersByTime(200);
    progress.update("Saving 2/3 exports");
    vi.advanceTimersByTime(100);
    expect(cap.text()).toContain("Saving 2/3 exports");
    expect(cap.text()).toContain("0.3s");
    progress.clear();
    const cleared = cap.text();
    expect(cleared.endsWith("\r\u001b[2K")).toBe(true);
    progress.clear();
    vi.advanceTimersByTime(1000);
    expect(cap.text()).toBe(cleared);
    expect(process.listenerCount("exit")).toBe(before);
  });

  it("does not write progress to a pipe or a dumb terminal", async () => {
    const pipe = output();
    expect(await withSpinner(pipe.stream, "Working", async () => 42)).toBe(42);
    expect(pipe.text()).toBe("");
    vi.stubEnv("TERM", "dumb");
    const dumb = output(true);
    await withSpinner(dumb.stream, "Working", async () => {});
    expect(dumb.text()).toBe("");
  });

  it.each([
    1, 8, 12, 20, 40, 80,
  ])("does not wrap a long label at %i terminal columns", (columns) => {
    vi.stubEnv("TERM", "xterm-256color");
    const cap = output(true, columns);
    const progress = startProgress(cap.stream, "Reading a very long session label ".repeat(10));
    try {
      const line = stripVTControlCharacters(cap.text()).replace("\r", "");
      expect(line.length).toBeLessThanOrEqual(Math.max(1, columns - 1));
      expect(line).not.toContain("\n");
    } finally {
      progress.clear();
    }
  });

  it("clips Unicode labels by terminal width without splitting graphemes", () => {
    vi.stubEnv("TERM", "xterm-256color");
    const cap = output(true, 20);
    const progress = startProgress(cap.stream, "👩‍💻".repeat(20));
    try {
      const line = stripVTControlCharacters(cap.text());
      expect(line).toContain("👩‍💻".repeat(4));
      expect(line).not.toContain("👩‍💻".repeat(5));
      expect(line).toContain("…");
      expect(line.replaceAll("👩‍💻", "")).not.toMatch(/[👩💻\u200d]/u);
    } finally {
      progress.clear();
    }
  });

  it("removes terminal control sequences and line breaks from labels", () => {
    vi.stubEnv("TERM", "xterm-256color");
    const cap = output(true);
    const progress = startProgress(cap.stream, "\u001b[2JReading\n\tnew\u0007 ses\u0008sion");
    try {
      expect(cap.text()).not.toContain("\u001b[2J");
      expect(cap.text()).toContain("Reading new session");
      expect(cap.text()).not.toContain("\n");
      expect(cap.text()).not.toContain("\u0007");
      expect(cap.text()).not.toContain("\u0008");
    } finally {
      progress.clear();
    }
  });

  it("clears progress on failure and keeps an open-source link in the privacy reminder", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const cap = output(true);
    await expect(
      withSpinner(cap.stream, "Working", async () => {
        throw new Error("Failed");
      }),
    ).rejects.toThrow("Failed");
    expect(cap.text().endsWith("\r\u001b[2K")).toBe(true);
    const reminder = terminalPrivacyReminder(cap.stream);
    expect(reminder).toContain("\u001b]8;;https://github.com/");
    expect(stripVTControlCharacters(reminder)).toContain("fully open source");
    expect(reminder).toContain("configured provider");
    expect(terminalPrivacyReminder(output().stream)).toContain(
      "https://github.com/adityaarunsinghal/human-hindsight",
    );
  });

  it("keeps the repository URL readable without terminal escape sequences in plain output", () => {
    const plain = terminalPrivacyReminder(output().stream);
    expect(plain).toContain("fully open source (https://github.com/");
    expect(plain).not.toContain("\u001b");
    vi.stubEnv("TERM", "dumb");
    expect(terminalPrivacyReminder(output(true).stream)).toBe(plain);
  });
});
