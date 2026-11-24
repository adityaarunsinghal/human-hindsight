/**
 * Keys typed before a question appears never answer it, and nothing but a
 * deliberate `s` starts model calls.
 *
 * A person who presses Enter twice on the home menu, or holds it down, has
 * keys waiting on the terminal while export and the CLI listing run. Every
 * menu and line question throws away what is waiting when it opens and
 * ignores pastes. The Start question takes only `s`, which no earlier
 * question uses, so no held key, repeat, or paste can approve a plan,
 * whatever its timing.
 *
 * These tests drive fake streams in process. The same rule on a real
 * pseudo-terminal, where the terminal itself queues the keys, is covered by
 * `scripts/smoke-flow.py` and `scripts/smoke-menu.py`.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ManifestEntry, runDistill } from "../src/commands/distill.js";
import { runHome } from "../src/commands/home.js";
import { offerLibraryNext } from "../src/commands/next.js";
import { confirmPlan, type DistillPlan } from "../src/distill/consent.js";
import { runEvaluationCli } from "../src/eval/cli.js";
import type { AgentRunner, ModelCatalog, RunOptions } from "../src/runners/types.js";
import type { TerminalHost } from "../src/ui/live.js";
import {
  chooseMenuAnswer,
  discardTypeAhead,
  type MenuChoice,
  readLine,
  TYPED_AHEAD,
} from "../src/ui/prompt.js";
import { askStart, START_HINT, type StartQuestion } from "../src/ui/start.js";
import { fakeRunnerIo } from "./support/runner-io.js";
import { type FakeOutput, fakeInput, fakeOutput, KEYS } from "./support/tty.js";

const ENV = { TERM: "xterm-256color" };
const PLAIN = { ...ENV, HUMAN_HINDSIGHT_PLAIN: "1" };

function fakeHost(): TerminalHost & EventEmitter {
  const host = new EventEmitter() as TerminalHost & EventEmitter;
  Object.assign(host, { pid: 4242, kill: () => true });
  return host;
}

/** One turn of the event loop: pushed bytes reach whoever is listening. No timer. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const CHOICES: MenuChoice<string>[] = [
  { key: "a", label: "First", recommended: true },
  { key: "b", label: "Second" },
  { key: "c", label: "Third" },
];

/** Run `then` once `text` has been written, as a person answers what they see. */
function onScreen(output: FakeOutput, steps: [text: string, then: () => void][]): void {
  const original = output.write.bind(output);
  let seen = "";
  output.write = ((chunk: unknown, ...rest: unknown[]) => {
    seen += String(chunk);
    const next = steps[0];
    if (next && seen.includes(next[0])) {
      steps.shift();
      seen = "";
      setImmediate(next[1]);
    }
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof output.write;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("throwing away what is waiting", () => {
  it("a terminal stream loses what it holds, and no listener sees it", () => {
    const input = fakeInput();
    const seen: unknown[] = [];
    input.on("data", (chunk) => seen.push(chunk));
    input.pause();
    input.press("2", KEYS.enter);
    expect(discardTypeAhead(input)).toBe(2);
    expect(input.readableLength).toBe(0);
    expect(seen).toEqual([]);
    // The listener is still there for what comes next.
    expect(input.listenerCount("data")).toBe(1);
  });

  it("a pipe keeps its lines: they are the script", () => {
    const input = fakeInput({ isTTY: false });
    input.press("y\n");
    expect(discardTypeAhead(input)).toBe(0);
    expect(input.readableLength).toBe(2);
  });
});

describe("a menu or question never takes keys typed before it opened", () => {
  it.each([
    ["Enter", KEYS.enter],
    ["a digit", "2"],
    ["several Enters", `${KEYS.enter}${KEYS.enter}${KEYS.enter}`],
  ])("single-key menu: %s typed ahead is ignored and said so", async (_name, early) => {
    const input = fakeInput();
    const output = fakeOutput({ columns: 80, rows: 24 });
    input.press(early);
    const answer = chooseMenuAnswer(
      { title: "Pick", choices: CHOICES },
      { input, output, host: fakeHost(), env: ENV },
    );
    await flush();
    expect(output.text()).toContain(TYPED_AHEAD);
    input.press("3");
    expect(await answer).toBe("c");
  });

  it.each([
    ["Enter", "\n"],
    ["a digit", "2\n"],
  ])("numbered prompt: %s typed ahead is ignored and said so", async (_name, early) => {
    const input = fakeInput();
    const output = fakeOutput({ columns: 80, rows: 24 });
    input.press(early);
    const answer = chooseMenuAnswer(
      { title: "Pick", choices: CHOICES },
      { input, output, host: fakeHost(), env: PLAIN, wait: async () => {} },
    );
    await flush();
    expect(output.text()).toContain(TYPED_AHEAD);
    input.press("3\n");
    expect(await answer).toBe("c");
  });

  it("line question: a line typed ahead is ignored", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    input.press("yes\n");
    const answer = readLine("Continue? [y/N] ", { input, output, host: fakeHost(), env: ENV });
    await flush();
    input.press("no\n");
    expect(await answer).toBe("no");
    expect(output.text()).toContain(TYPED_AHEAD);
  });

  it("a person who waits sees no note and no delay", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const answer = chooseMenuAnswer(
      { title: "Pick", choices: CHOICES },
      { input, output, host: fakeHost(), env: ENV },
    );
    await flush();
    input.press(KEYS.enter);
    expect(await answer).toBe("a");
    expect(output.text()).not.toContain(TYPED_AHEAD);
  });
});

const START: StartQuestion<"balanced" | "best"> = {
  options: [
    { key: "balanced", label: "Balanced", detail: "fast-model reads, strong-model writes" },
    { key: "best", label: "Best", detail: "strong-model reads, top-model writes" },
  ],
  selected: "balanced",
};
const HOME: MenuChoice<string>[] = [
  { key: "build", label: "Build my prompt library", recommended: true },
  { key: "scan", label: "Show matching projects" },
];

/** The answer if the question already answered, else "pending". */
async function settledOrPending<T>(answer: Promise<T>): Promise<T | "pending"> {
  return Promise.race([answer, flush().then(() => "pending" as const)]);
}

describe("the Start question starts only on s", () => {
  it.each([
    ["single-key", ENV, KEYS.enter],
    ["plain mode", PLAIN, "\n"],
  ])("%s: a held Enter from the home menu never starts, whatever the repeat delay", async (_name, env, enter) => {
    const input = fakeInput();
    const output = fakeOutput({ columns: 100, rows: 40 });
    const io = { input, output, host: fakeHost(), env, wait: async () => {} };
    const home = chooseMenuAnswer({ title: "What would you like to do?", choices: HOME }, io);
    await flush();
    input.press(enter); // pressed, and held
    expect(await home).toBe("build");
    const start = askStart(START, io);
    await flush();
    // The first repeat after the plan is drawn, then one every 40 ms for two seconds.
    for (let i = 0; i < 50; i++) {
      input.press(enter);
      await flush();
    }
    expect(await settledOrPending(start)).toBe("pending");
    input.press(env === PLAIN ? "q\n" : "q");
    expect(await start).toBe("quit");
  });

  it("held from the shell prompt: the first repeat does not start a plan drawn on launch", async () => {
    const input = fakeInput();
    const output = fakeOutput({ columns: 100, rows: 40 });
    const start = askStart(START, { input, output, host: fakeHost(), env: ENV });
    await flush();
    input.press(KEYS.enter);
    await flush();
    expect(await settledOrPending(start)).toBe("pending");
    expect(output.text()).toContain(START_HINT);
    input.press("q");
    expect(await start).toBe("quit");
  });

  it.each([
    ["a shell line with a newline", "echo done\r"],
    ["two lines", "cd ../other\rls\r"],
    ["a command with a digit and no newline", "git log -2"],
    ["a word with an s in it", "yes"],
    ["a bracketed paste holding s", "\u001b[200~s\u001b[201~"],
    ["a bracketed paste in pieces", "\u001b[200~ls -la\r", "s\r\u001b[201~"],
    ["split bracketed-paste markers", "\u001b[20", "0~", "s", "\u001b[201", "~"],
  ])("%s pasted at the question does not start", async (_name, ...chunks) => {
    const input = fakeInput();
    const output = fakeOutput({ columns: 100, rows: 40 });
    const start = askStart(START, { input, output, host: fakeHost(), env: ENV });
    await flush();
    for (const chunk of chunks) {
      input.press(chunk); // one read each, as a terminal delivers a paste
      await flush();
    }
    expect(await settledOrPending(start)).toBe("pending");
    expect(output.text()).toContain(TYPED_AHEAD);
    input.press("q");
    expect(await start).toBe("quit");
  });

  it("plain mode ignores each line until a multiline paste ends", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const pending = askStart(START, { input, output, host: fakeHost(), env: PLAIN });
    await flush();
    for (const key of ["\u001b[200~\n", "another line\n", "s\n", "\u001b[201~\n"]) {
      input.press(key);
      await flush();
    }
    expect(await settledOrPending(pending)).toBe("pending");
    input.press("q\n");
    expect(await pending).toBe("quit");
  });

  it.each([
    ["1", "balanced"],
    ["2", "best"],
  ])("held %s only selects, never starts; s then starts that plan", async (key, plan) => {
    const input = fakeInput();
    const output = fakeOutput({ columns: 100, rows: 40 });
    const start = askStart(START, { input, output, host: fakeHost(), env: ENV });
    await flush();
    for (let i = 0; i < 50; i++) {
      input.press(key);
      await flush();
    }
    expect(await settledOrPending(start)).toBe("pending");
    expect(output.text()).not.toContain(START_HINT);
    input.press("s");
    expect(await start).toEqual({ start: true, selected: plan });
  });

  it("a held q leaves at its first press", async () => {
    const input = fakeInput();
    const output = fakeOutput({ columns: 100, rows: 40 });
    const start = askStart(START, { input, output, host: fakeHost(), env: ENV });
    await flush();
    input.press("q");
    input.press("q");
    expect(await start).toBe("quit");
  });

  it.each([
    ["single-key", ENV, "s", "q"],
    ["plain mode", PLAIN, "s\n", "q\n"],
  ])("%s: an s typed before the plan appeared is thrown away and said so", async (_name, env, early, quit) => {
    const input = fakeInput();
    const output = fakeOutput({ columns: 100, rows: 40 });
    input.press(early);
    const start = askStart(START, { input, output, host: fakeHost(), env });
    await flush();
    expect(await settledOrPending(start)).toBe("pending");
    expect(output.text()).toContain(TYPED_AHEAD);
    input.press(quit);
    expect(await start).toBe("quit");
  });

  it.each([
    ["a normal terminal", ENV, 40, "s"],
    ["a 12-row terminal", ENV, 12, "s"],
    ["plain mode", PLAIN, 40, "s\n"],
  ])("on %s, a person who waits and presses s once starts at once, with no note", async (_name, env, rows, s) => {
    const input = fakeInput();
    const output = fakeOutput({ columns: 80, rows });
    const start = askStart(START, { input, output, host: fakeHost(), env });
    await flush();
    input.press(s);
    expect(await start).toEqual({ start: true, selected: "balanced" });
    expect(output.text()).not.toContain(TYPED_AHEAD);
    expect(output.text()).not.toContain(START_HINT);
  });

  it.each([
    ["single-key", ENV, "S", "Q"],
    ["plain mode", PLAIN, "S\n", "Q\n"],
  ])("%s: with Caps Lock on, S starts and Q leaves, as the letters on screen do", async (_name, env, start, quit) => {
    const started = fakeInput();
    const starting = askStart(START, {
      input: started,
      output: fakeOutput({ columns: 100, rows: 40 }),
      host: fakeHost(),
      env,
    });
    await flush();
    started.press(start);
    expect(await starting).toEqual({ start: true, selected: "balanced" });
    const left = fakeInput();
    const output = fakeOutput({ columns: 100, rows: 40 });
    const leaving = askStart(START, { input: left, output, host: fakeHost(), env });
    await flush();
    left.press(quit);
    expect(await leaving).toBe("quit");
    expect(output.text()).not.toContain(START_HINT);
  });

  it("Enter, then s: the hint once, then the start", async () => {
    const input = fakeInput();
    const output = fakeOutput({ columns: 100, rows: 40 });
    const start = askStart(START, { input, output, host: fakeHost(), env: ENV });
    await flush();
    input.press(KEYS.enter);
    await flush();
    input.press(" ");
    await flush();
    input.press("s");
    expect(await start).toEqual({ start: true, selected: "balanced" });
    expect(output.text().split(START_HINT).length - 1).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ["s", { start: true, selected: "balanced" }],
    ["q", "quit"],
    [KEYS.ctrlC, "interrupt"],
    [KEYS.escape, "quit"],
  ] as const)("bracketed paste is on while the question is open and off after %j", async (key, answer) => {
    const input = fakeInput();
    const output = fakeOutput({ columns: 100, rows: 40 });
    const start = askStart(START, { input, output, host: fakeHost(), env: ENV });
    await flush();
    expect(output.raw()).toContain("\u001b[?2004h");
    input.press(key);
    expect(await start).toEqual(answer);
    expect(output.raw().lastIndexOf("\u001b[?2004l")).toBeGreaterThan(
      output.raw().lastIndexOf("\u001b[?2004h"),
    );
    expect(input.isRaw).toBe(false);
  });

  it("the end of input leaves, and a pipe as standard input is never read", async () => {
    const input = fakeInput();
    const output = fakeOutput({ columns: 100, rows: 40 });
    const start = askStart(START, { input, output, host: fakeHost(), env: ENV });
    await flush();
    input.end();
    expect(await start).toBe("quit");
    expect(await askStart(START, { output: fakeOutput({ isTTY: false }), env: ENV })).toBe("quit");
  });
});

describe("no earlier question takes s", () => {
  it("a menu cannot be given a choice keyed s", async () => {
    const io = { input: fakeInput(), output: fakeOutput(), host: fakeHost(), env: ENV };
    await expect(
      chooseMenuAnswer({ title: "Pick", choices: [{ key: "s", label: "Something" }] }, io),
    ).rejects.toThrow(/may not use the key "s"/);
  });

  it.each([
    ["single-key", ENV, "s", "q"],
    ["numbered", PLAIN, "s\n", "q\n"],
  ])("%s: s at a menu answers nothing", async (_name, env, s, quit) => {
    const input = fakeInput();
    const output = fakeOutput({ columns: 100, rows: 40 });
    const io = { input, output, host: fakeHost(), env, wait: async () => {} };
    const answer = chooseMenuAnswer({ title: "What would you like to do?", choices: HOME }, io);
    await flush();
    input.press(s);
    await flush();
    expect(await settledOrPending(answer)).toBe("pending");
    input.press(quit);
    expect(await answer).toBe("quit");
  });

  it("no menu in the source is defined with the key s", () => {
    const root = path.join(import.meta.dirname, "..", "src");
    const files = (fs.readdirSync(root, { recursive: true }) as string[]).filter((file) =>
      file.endsWith(".ts"),
    );
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      expect(text, file).not.toMatch(/\bkey:\s*"s"/);
    }
  });
});

function plan(): DistillPlan {
  return {
    sessions: 5,
    digests: 5,
    cluster: 1,
    authorEstimate: 2,
    runnerName: "claude",
    session: {
      runnerLine: "Claude Code (claude 9.9.9)",
      alsoReady: [],
      pinned: false,
      qualityChoice: true,
      plans: {
        balanced: { bulk: "fast-model", major: "strong-model", notes: [] },
        best: { bulk: "strong-model", major: "top-model", notes: [] },
      },
    },
    quality: "balanced",
    concurrency: 10,
    generalize: true,
    choices: {
      balanced: {
        digest: "fast-model",
        cluster: "strong-model",
        author: "strong-model",
        generalize: "fast-model",
        reusable: 0,
        regenerating: 0,
      },
      best: {
        digest: "strong-model",
        cluster: "top-model",
        author: "top-model",
        generalize: "strong-model",
        reusable: 0,
        regenerating: 0,
      },
    },
  };
}

describe("the plan's Start question", () => {
  it.each([
    { mode: "single-key menu", plain: "", early: "\r", decline: "q" },
    { mode: "numbered prompt (plain mode)", plain: "1", early: "\n", decline: "q\n" },
    { mode: "a digit, single-key menu", plain: "", early: "2", decline: "q" },
    { mode: "s, single-key menu", plain: "", early: "s", decline: "q" },
    { mode: "s, numbered prompt (plain mode)", plain: "1", early: "s\n", decline: "q\n" },
  ])("$mode: a key already waiting when the plan appears does not start the run", async ({
    plain,
    early,
    decline,
  }) => {
    vi.stubEnv("CI", "");
    vi.stubEnv("TERM", "xterm-256color");
    vi.stubEnv("HUMAN_HINDSIGHT_PLAIN", plain);
    const input = fakeInput();
    const output = fakeOutput({ columns: 80, rows: 50 });
    // Typed during export, before any plan existed.
    input.push(early);
    const chosen: string[] = [];
    const pending = confirmPlan(plan(), {
      input,
      output,
      host: fakeHost(),
      onQuality: (quality) => chosen.push(quality),
    });
    await flush();
    await flush();
    // The person now reads the plan and declines.
    input.push(decline);
    expect(await pending).toBe("declined");
    expect(chosen).toEqual([]);
    expect(output.text()).toContain(TYPED_AHEAD);
  });

  it("without a plan screen: an s typed ahead does not start, and y never does", async () => {
    vi.stubEnv("CI", "");
    vi.stubEnv("TERM", "xterm-256color");
    vi.stubEnv("HUMAN_HINDSIGHT_PLAIN", "1");
    const input = fakeInput();
    const output = fakeOutput({ columns: 80, rows: 50 });
    input.push("s\n");
    const { session: _session, ...bare } = plan();
    const pending = confirmPlan(bare, { input, output, host: fakeHost() });
    await flush();
    input.push("y\n");
    await flush();
    input.push("q\n");
    expect(await pending).toBe("declined");
    expect(output.text()).toContain(TYPED_AHEAD);
    expect(output.text()).toContain(START_HINT);
  });
});

describe("the evaluation's Run question", () => {
  function evaluation() {
    const input = fakeInput();
    const output = fakeOutput({ columns: 80, rows: 30 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-type-ahead-eval-"));
    dirs.push(dir);
    const file = path.join(dir, "result.json");
    const runner = {
      name: "claude" as const,
      installHint: "",
      calls: 0,
      run: async () => {
        runner.calls++;
        throw new Error("a synthetic failure; no model is called");
      },
    };
    const run = () =>
      runEvaluationCli(["--live", "--out", file, "--case", "reject-deployment"], {
        input,
        output,
        host: fakeHost(),
        env: ENV,
        resolve: async () => runner as AgentRunner,
      });
    return { input, output, file, runner, run };
  }

  it("is the Start question: an s typed ahead, y, and Enter never start; q leaves", async () => {
    const t = evaluation();
    // Typed while the runner was being found, before the question existed.
    t.input.press("s");
    const pending = t.run();
    await flush();
    await flush();
    for (const key of ["y", KEYS.enter]) {
      t.input.press(key);
      await flush();
    }
    expect(t.output.text()).toContain(TYPED_AHEAD);
    expect(t.output.text()).toContain(START_HINT);
    expect(t.runner.calls).toBe(0);
    t.input.press("q");
    expect(await pending).toBe(2);
    expect(t.runner.calls).toBe(0);
    expect(fs.existsSync(t.file)).toBe(false);
  });

  it("starts on s pressed after the question is on screen", async () => {
    const t = evaluation();
    const pending = t.run();
    await flush();
    await flush();
    t.input.press("s");
    await pending;
    expect(t.runner.calls).toBeGreaterThan(0);
  });
});

// --- across screens ------------------------------------------------------------

const ALIASES: ModelCatalog = { ids: ["sonnet", "opus", "fable"], source: "aliases" };
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function exportedHome(n: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-type-ahead-"));
  dirs.push(dir);
  const entries: ManifestEntry[] = Array.from({ length: n }, (_, i) => {
    const ts = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    const name = `s${String(i).padStart(2, "0")}`;
    return {
      export: name,
      source: `/x/${name}.jsonl`,
      project: "alpha",
      sessionId: name,
      messages: 3,
      first_ts: ts,
      last_ts: ts,
    };
  });
  fs.mkdirSync(path.join(dir, "exports"), { recursive: true });
  fs.writeFileSync(path.join(dir, "exports", "manifest.json"), JSON.stringify(entries));
  for (const e of entries)
    fs.writeFileSync(path.join(dir, "exports", e.export), `### 2026-01-01\n\nBuild ${e.export}.\n`);
  return dir;
}

function cli(): AgentRunner & { calls: number } {
  const runner = {
    name: "claude" as const,
    installHint: "",
    calls: 0,
    listModels: async () => ALIASES,
    version: async () => "9.9.9",
    run: async <T>(_opts: RunOptions<T>): Promise<T> => {
      runner.calls++;
      throw new Error("no model call is expected in this test");
    },
  };
  return runner;
}

describe("Enters typed ahead across the home menu, quick start, and the plan", () => {
  it("answer nothing, and nothing is sent", async () => {
    vi.stubEnv("CI", "");
    vi.stubEnv("TERM", "xterm-256color");
    vi.stubEnv("HUMAN_HINDSIGHT_PLAIN", "");
    vi.stubEnv("HUMAN_HINDSIGHT_QUALITY", undefined);
    const home = exportedHome(30);
    const input = fakeInput();
    const output = fakeOutput({ columns: 100, rows: 60 });
    const host = fakeHost();
    const runner = cli();
    let distillCode: number | undefined;
    onScreen(output, [
      // The person presses Enter on the home menu, twice: the second is typed ahead.
      ["What would you like to do?", () => input.press(KEYS.enter)],
      // Quick start: the person picks "My 25 most recent", then Enter twice more
      // before the plan appears.
      [
        "Which history do you want to reflect on?",
        () => {
          input.press("1");
          input.press(KEYS.enter, KEYS.enter);
        },
      ],
      // Only now does the person see the plan, and declines.
      ["Start reflection", () => input.press("q")],
    ]);
    const code = await runHome(
      { home },
      {
        input,
        output,
        host,
        env: ENV,
        processes: fakeRunnerIo(),
        countHistory: async () => {},
        dispatch: async () => {
          input.press(KEYS.enter);
          distillCode = await runDistill({ home }, { input, output, host, runners: [runner] });
          return distillCode;
        },
      },
    );
    expect(code).toBe(2);
    expect(distillCode).toBe(2);
    expect(runner.calls).toBe(0);
    const text = output.text();
    expect(text).toContain("Declined. Nothing was sent.");
    // Said at quick start and at the plan, each time keys were set aside.
    expect(text.split(TYPED_AHEAD).length - 1).toBeGreaterThanOrEqual(2);
  });
});

describe("the closing menu", () => {
  it("an Enter typed ahead does not open the library", async () => {
    const input = fakeInput();
    const output = fakeOutput({ columns: 80, rows: 30 });
    const run = vi.fn(async () => 0);
    input.press(KEYS.enter);
    const done = offerLibraryNext({}, { input, output, host: fakeHost(), env: ENV }, run);
    await flush();
    input.press("3");
    expect(await done).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(output.text()).toContain(TYPED_AHEAD);
  });
});
