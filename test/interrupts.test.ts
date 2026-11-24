import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPreferences } from "../src/commands/preferences.js";
import { runPrune } from "../src/commands/prune.js";
import { runRetention } from "../src/commands/retention.js";
import type { TerminalHost } from "../src/ui/live.js";
import { type BuiltHome, homeBuilder } from "./support/home.js";
import { type FakeOutput, fakeInput, fakeOutput } from "./support/tty.js";

/**
 * Ctrl-C means one thing at every question: one line, exit code 130, and
 * nothing changed. End of input still declines quietly.
 */

const homes: BuiltHome[] = [];
afterEach(() => {
  while (homes.length) homes.pop()?.remove();
  vi.unstubAllEnvs();
});

/** A terminal whose Ctrl-C arrives as soon as a `[y/N]` or `[Y/n]` question is asked. */
function terminal() {
  const host = new EventEmitter() as TerminalHost & EventEmitter;
  Object.assign(host, { pid: 4242, kill: () => true });
  const input = fakeInput({ isTTY: true });
  const output: FakeOutput = fakeOutput({ isTTY: true, columns: 80 });
  const write = output.write.bind(output);
  output.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (/\[[yY]\/[nN]\]/.test(String(chunk))) setImmediate(() => host.emit("SIGINT"));
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof output.write;
  return { host, input, output };
}

function library(): BuiltHome {
  const home = homeBuilder()
    .session({
      project: "alpha",
      sessionId: "a1111111-0000-4000-8000-000000000001",
      messages: ["Keep the change small."],
    })
    .digest(0, { preferences: [{ text: "Keep changes small.", quote: "Keep the change small" }] })
    .task({ slug: "small-change", members: [0] })
    .task({ slug: "left-behind", members: [0] })
    .library("small-change")
    .library("left-behind")
    .review("Keep changes small.", "accepted")
    .build();
  homes.push(home);
  // A later grouping dropped one task, so its prompt is left behind for prune.
  const tasks = home.json<{ tasks: { slug: string }[] }>("distill/tasks.json");
  const kept = tasks.tasks.filter((task) => task.slug !== "left-behind");
  fs.writeFileSync(home.path("distill/tasks.json"), JSON.stringify({ ...tasks, tasks: kept }));
  return home;
}

/** Every file under a folder with its content. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (at: string) => {
    for (const item of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, item.name);
      if (item.isDirectory()) walk(full);
      else files[path.relative(dir, full)] = fs.readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return files;
}

type Question = (home: BuiltHome, t: ReturnType<typeof terminal>) => Promise<number>;

const QUESTIONS: [string, Question][] = [
  [
    "prune: Remove left-behind entries?",
    (home, { host, input, output }) => runPrune({ home: home.dir }, { input, output, host }),
  ],
  [
    "retention --apply: Apply these settings?",
    (home, { host, input, output }) => {
      fs.mkdirSync(home.path("claude"), { recursive: true });
      fs.writeFileSync(home.path("claude/settings.json"), "{}");
      return runRetention(
        { home: home.dir, "claude-dir": home.path("claude"), source: "claude", apply: true },
        { input, output, host },
      );
    },
  ],
  [
    "preferences: Copy block to clipboard?",
    (home, { host, input, output }) =>
      runPreferences(
        { home: home.dir },
        {
          input,
          output,
          host,
          clipboard: async () => {
            throw new Error("nothing is copied after Ctrl-C");
          },
        },
      ),
  ],
];

describe("Ctrl-C at a question", () => {
  it.each(QUESTIONS)("%s exits 130 after one line and changes nothing", async (_name, ask) => {
    vi.stubEnv("CI", "");
    const home = library();
    const t = terminal();
    const before = snapshot(home.dir);
    const code = await ask(home, t);
    expect(code).toBe(130);
    expect(t.output.text().match(/Interrupted/g)?.length).toBe(1);
    // A file the question set up before asking is allowed; nothing it guards changed.
    const after = snapshot(home.dir);
    for (const [file, text] of Object.entries(before)) expect(after[file], file).toBe(text);
    expect(t.host.listenerCount("SIGINT")).toBe(0);
  });
});
