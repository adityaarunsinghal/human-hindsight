import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDistill } from "../src/commands/distill.js";
import { runEdit } from "../src/commands/edit.js";
import { runExport } from "../src/commands/export.js";
import { runPreferences } from "../src/commands/preferences.js";
import { runPrune } from "../src/commands/prune.js";
import { runRate } from "../src/commands/rate.js";
import { runSuggestSubagents } from "../src/commands/suggest-subagents.js";
import { readConsolidatedPreferences } from "../src/core/consolidated-preferences.js";
import { setFileWriter, unflushedWriter } from "../src/core/fsutil.js";
import { preferenceId, readObservedPreferences } from "../src/core/preferences.js";
import { acquireWriterLock, readWriterLock, writerBusyReason } from "../src/distill/operations.js";
import { type RunnerFn, runDigestStage } from "../src/distill/pipeline.js";
import { bounded, guardRun } from "../src/distill/run-guard.js";
import type { RunOptions } from "../src/runners/types.js";
import type { TerminalHost } from "../src/ui/live.js";
import { type BuiltHome, homeBuilder } from "./support/home.js";

/**
 * Every command that changes the library or the operation ledger takes the
 * data home's writer lock. While another command holds it, each one says which
 * command is running and exits without changing anything or calling a model.
 * A run that holds it keeps it through Ctrl-C until the process exits, and
 * prints how to continue.
 */

setFileWriter(unflushedWriter);

const homes: BuiltHome[] = [];
afterEach(() => {
  while (homes.length) homes.pop()?.remove();
});

function capture() {
  let text = "";
  const out = new Writable({
    write(chunk, _e, cb) {
      text += chunk.toString();
      cb();
    },
  });
  return { out, text: () => stripVTControlCharacters(text) };
}

const SLUG = "build-the-thing";

/**
 * A library with one prompt, one accepted preference, and a failed digest in
 * the ledger (work for a strict retry). `midRun` is the state in the middle
 * of a distill run: clustering has published a new generation and the author
 * stage has not reached the entry, so prune would take it for left behind.
 */
async function libraryHome(midRun = false): Promise<BuiltHome> {
  const home = homeBuilder()
    .session({
      project: "synthetic-app",
      sessionId: "s-0001",
      messages: ["Please build the thing and keep the change small."],
    })
    .session({
      project: "synthetic-app",
      sessionId: "s-0002",
      messages: ["Please read this session again later."],
    })
    .digest(0, { preferences: [{ text: "Keep changes small.", quote: "keep the change small" }] })
    .task({ slug: SLUG, members: [0] })
    .library(SLUG)
    .review("Keep changes small.", "accepted")
    .build();
  homes.push(home);
  // A failed digest in the ledger, so a strict retry has work to do.
  type Entries = Parameters<typeof runDigestStage>[0]["entries"];
  const manifest = home.json<Entries | { entries: Entries }>("exports/manifest.json");
  await runDigestStage({
    home: home.dir,
    entries: (Array.isArray(manifest) ? manifest : manifest.entries).filter(
      (entry) => entry.export === home.exports[1],
    ),
    output: capture().out,
    runnerName: "claude",
    model: "recorded-model",
    runner: async () => {
      throw new Error("network disconnected");
    },
  });
  if (midRun) {
    const tasks = home.json<Record<string, unknown>>("distill/tasks.json");
    fs.writeFileSync(
      home.path("distill/tasks.json"),
      JSON.stringify({ ...tasks, generation: "20260202T030405Z-0c0d" }),
    );
  }
  return home;
}

/** Every file under the home except the lock itself, with its content. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (at: string) => {
    for (const item of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, item.name);
      const relative = path.relative(dir, full);
      if (relative.startsWith(path.join("distill", "writer"))) continue;
      if (item.isDirectory()) walk(full);
      else files[relative] = fs.readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return files;
}

type Run = (home: string, runner: RunnerFn, out: Writable) => Promise<number> | number;

const COMMANDS: [string, Run][] = [
  ["prune", (home, _r, output) => runPrune({ home, yes: true, force: true }, { output })],
  ["prune --dry-run", (home, _r, output) => runPrune({ home, "dry-run": true }, { output })],
  ["rate", (home, _r, output) => runRate({ home, slug: SLUG, rating: "up" }, { output })],
  [
    "edit",
    (home, _r, output) =>
      runEdit(
        { home, slug: SLUG },
        {
          output,
          launch: () => {
            throw new Error("the editor must not open");
          },
        },
      ),
  ],
  [
    "preferences --consolidate",
    (home, runner, output) =>
      runPreferences({ home, yes: true, consolidate: true }, { output, runner }),
  ],
  [
    "suggest-subagents",
    (home, runner, output) =>
      runSuggestSubagents({ home, yes: true }, { output, runner, userHome: home }),
  ],
  [
    "distill --retry-failed",
    (home, runner, output) =>
      runDistill({ home, "retry-failed": true, yes: true }, { output, runner }),
  ],
  [
    "export",
    (home, _r, output) =>
      runExport({ home, output, source: "claude", "claude-dir": path.join(home, "no-history") })
        .busy
        ? 1
        : 0,
  ],
];

describe("while distill holds the writer lock", () => {
  it.each(COMMANDS)("%s says distill is running and changes nothing", async (name, run) => {
    const home = await libraryHome(name.startsWith("prune"));
    const lock = acquireWriterLock(home.dir, "distill");
    try {
      const before = snapshot(home.dir);
      const runner = vi.fn(async () => {
        throw new Error("no model call while another command writes");
      });
      const cap = capture();
      const code = await run(home.dir, runner as RunnerFn, cap.out);
      expect(cap.text()).toContain("human-hindsight distill is changing this library");
      expect(code).toBe(1);
      expect(runner).not.toHaveBeenCalled();
      expect(snapshot(home.dir)).toEqual(before);
      expect(readWriterLock(home.dir).owner?.token).toBe(lock.owner.token);
    } finally {
      lock.release();
    }
  });
});

describe("with a lock left by a run under an earlier machine name", () => {
  // macOS renames the machine when it joins another network; the run that
  // left this lock is gone, but its process cannot be checked by name.
  it.each(
    COMMANDS,
  )("%s gives one plain line with the way out and changes nothing", async (name, run) => {
    const home = await libraryHome(name.startsWith("prune"));
    const dir = home.path("distill/writer.lock");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "owner.json"),
      JSON.stringify({
        pid: 2147483647,
        host: "laptop-on-another-network",
        token: "11111111-1111-4111-8111-111111111111",
        startedAt: "2026-11-20T10:00:00.000Z",
        command: "distill",
      }),
    );
    const before = snapshot(home.dir);
    const runner = vi.fn(async () => {
      throw new Error("no model call while the lock is held");
    });
    const cap = capture();
    const code = await run(home.dir, runner as RunnerFn, cap.out);
    expect(code).toBe(1);
    expect(runner).not.toHaveBeenCalled();
    expect(snapshot(home.dir)).toEqual(before);
    const lines = cap
      .text()
      .split("\n")
      .filter((line) => line.includes("writer lock"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("human-hindsight distill on laptop-on-another-network");
    expect(lines[0]).toContain(`remove ${dir}`);
  });
});

describe("a command that changes the library", () => {
  it("holds the lock under its own name while it works, and releases it after", async () => {
    const home = await libraryHome();
    const seen: (string | undefined)[] = [];
    runEdit(
      { home: home.dir, slug: SLUG },
      {
        output: capture().out,
        launch: () => {
          seen.push(readWriterLock(home.dir).owner?.command);
          return 0;
        },
      },
    );
    expect(seen).toEqual(["edit"]);
    expect(runRate({ home: home.dir, slug: SLUG, rating: "down" }, { output: capture().out })).toBe(
      0,
    );
    expect(readWriterLock(home.dir).status).toBe("absent");
  });

  it("rate changes only the rating fields, keeping every other field as written", async () => {
    const home = await libraryHome();
    const file = home.path(`library/${SLUG}/sources.json`);
    const original = JSON.parse(fs.readFileSync(file, "utf8"));
    // A value the reader would replace with a default, and a field it does not know.
    fs.writeFileSync(
      file,
      JSON.stringify({ ...original, confidence: "certain", note: { kept: true } }),
    );
    expect(runRate({ home: home.dir, slug: SLUG, rating: "up" }, { output: capture().out })).toBe(
      0,
    );
    const { rating, rated_at, ...rest } = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(rating).toBe("up");
    expect(typeof rated_at).toBe("string");
    expect(rest).toEqual({ ...original, confidence: "certain", note: { kept: true } });
  });
});

/** A fake `process` for Ctrl-C: tests emit SIGINT and see the exit code instead of exiting. */
function fakeHost(): TerminalHost & EventEmitter {
  const host = new EventEmitter() as TerminalHost & EventEmitter;
  Object.assign(host, { pid: 4242, kill: () => true });
  return host;
}

type Interrupted = (
  home: string,
  runner: RunnerFn,
  out: Writable,
  host: TerminalHost,
  exit: (code: number) => void,
) => Promise<number>;

// The third column is the exact line for a step that saves nothing; null means
// the usual shape: one sentence on what is saved, then "To continue, run:".
const INTERRUPTIBLE: [string, string, string | null, Interrupted][] = [
  [
    "distill --retry-failed",
    "--retry-failed",
    null,
    (home, runner, output, host, exit) =>
      runDistill({ home, "retry-failed": true, yes: true }, { output, runner, host, exit }),
  ],
  [
    "preferences --consolidate",
    "--consolidate",
    // One call saves nothing until it returns, so the line says so.
    "Interrupted. Nothing was saved; run the same command again:",
    (home, runner, output, host, exit) =>
      runPreferences({ home, yes: true, consolidate: true }, { output, runner, host, exit }),
  ],
  [
    "suggest-subagents",
    "suggest-subagents",
    null,
    (home, runner, output, host, exit) =>
      runSuggestSubagents({ home, yes: true }, { output, runner, host, exit, userHome: home }),
  ],
];

describe("Ctrl-C during a run", () => {
  it.each(
    INTERRUPTIBLE,
  )("%s holds the lock until it exits, prints how to continue, and exits 130", async (_name, resume, line, run) => {
    const home = await libraryHome();
    const host = fakeHost();
    const cap = capture();
    let exited: (code: number) => void = () => {};
    let lockAtExit: string | undefined;
    const exitCode = new Promise<number>((resolve) => {
      exited = (code) => {
        lockAtExit = readWriterLock(home.dir).status;
        resolve(code);
      };
    });
    let lockDuringCall: string | undefined;
    let lockAfterInterrupt: string | undefined;
    const runner = (async () => {
      lockDuringCall = readWriterLock(home.dir).status;
      host.emit("SIGINT");
      lockAfterInterrupt = readWriterLock(home.dir).status;
      throw new Error("stopped by the interrupt");
    }) as RunnerFn;
    await run(home.dir, runner, cap.out, host, exited);
    expect(await exitCode).toBe(130);
    expect(lockDuringCall).toBe("alive");
    // The stopping run may still record what it was doing: no other command
    // can take the lock until the process exits.
    expect(lockAfterInterrupt).toBe("alive");
    expect(lockAtExit).toBe("absent");
    const said = cap.text().replace(/\s+/g, " ");
    // One sentence says what is saved; the command follows alone on its own line.
    if (line) expect(said).toContain(line);
    else expect(said).toMatch(/Interrupted\. [^.]+\. To continue, run: /);
    expect(said).not.toContain("Your progress is saved");
    // The stopping run prints nothing after its line and the command.
    const after = said.split(line ?? "To continue, run:")[1] ?? "";
    expect(after.trim()).toMatch(/^human-hindsight \S+( \S+)*$/);
    expect(after).not.toMatch(/stopped by the interrupt|failed:|CLI call/);
    expect(
      cap
        .text()
        .split("\n")
        .find((printed) => printed.includes(resume))
        ?.trim(),
    ).toMatch(/^human-hindsight /);
    expect(host.listenerCount("SIGINT")).toBe(0);
  });
});

describe("an answer that lands after Ctrl-C", () => {
  it("preferences --consolidate aborts the call and saves, prints, and copies nothing after the line", async () => {
    const home = await libraryHome();
    const host = fakeHost();
    const cap = capture();
    let exited: (code: number) => void = () => {};
    const exitCode = new Promise<number>((resolve) => {
      exited = resolve;
    });
    let abortedAtInterrupt: boolean | undefined;
    const runner = (async (opts: RunOptions<unknown>) => {
      host.emit("SIGINT");
      abortedAtInterrupt = opts.signal?.aborted ?? false;
      // The CLI answers anyway, inside the cleanup window.
      return {
        preferences: [
          {
            text: "Keep changes small.",
            source_ids: readObservedPreferences(home.dir).map(preferenceId),
          },
        ],
      };
    }) as unknown as RunnerFn;
    const clipboard = vi.fn(async () => ({ ok: true as const, tool: "fake" }));
    await runPreferences(
      { home: home.dir, consolidate: true, yes: true },
      { output: cap.out, runner, host, exit: exited, clipboard },
    );
    expect(await exitCode).toBe(130);
    expect(abortedAtInterrupt).toBe(true);
    const line = "Interrupted. Nothing was saved; run the same command again:";
    const after = cap.text().split(line)[1] ?? "";
    expect(after.trim()).toMatch(/^human-hindsight preferences( \S+)*$/);
    expect(readConsolidatedPreferences(home.dir).artifact ?? undefined).toBeUndefined();
    expect(clipboard).not.toHaveBeenCalled();
  });
});

describe("the writer lock on Ctrl-C", () => {
  it("is held until the stopping run's cleanup has finished, then released just before the exit", async () => {
    const home = await libraryHome();
    const host = fakeHost();
    let finishCleanup: () => void = () => {};
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    let exitedWith: number | undefined;
    let lockAtExit: string | null | undefined;
    const guard = guardRun({
      home: home.dir,
      command: "distill",
      output: capture().out,
      resume: "human-hindsight distill",
      cleanup: () => cleanup,
      interrupt: () => {},
      host,
      exit: (code) => {
        exitedWith = code;
        lockAtExit = writerBusyReason(home.dir);
      },
      timer: () => {},
    });
    if ("busy" in guard) throw new Error(guard.busy);
    host.emit("SIGINT");
    await new Promise((resolve) => setImmediate(resolve));
    // Still stopping: the run's own end does not let the lock go either.
    guard.end();
    expect(exitedWith).toBeUndefined();
    expect(writerBusyReason(home.dir)).toContain(
      "human-hindsight distill is changing this library",
    );
    finishCleanup();
    await cleanup;
    await new Promise((resolve) => setImmediate(resolve));
    expect(exitedWith).toBe(130);
    expect(lockAtExit).toBeNull();
    expect(host.listenerCount("SIGINT")).toBe(0);
  });

  it("a second Ctrl-C while the run stops leaves at once, releasing the lock", async () => {
    const home = await libraryHome();
    const host = fakeHost();
    const codes: number[] = [];
    const guard = guardRun({
      home: home.dir,
      command: "distill",
      output: capture().out,
      resume: "human-hindsight distill",
      cleanup: () => new Promise<void>(() => {}),
      host,
      exit: (code) => codes.push(code),
      timer: () => {},
    });
    if ("busy" in guard) throw new Error(guard.busy);
    host.emit("SIGINT");
    host.emit("SIGINT");
    expect(codes).toEqual([130]);
    expect(readWriterLock(home.dir).status).toBe("absent");
  });
});

describe("bounded cleanup on Ctrl-C", () => {
  it("waits for a cleanup that finishes, and not for one that hangs", async () => {
    const events: string[] = [];
    await bounded(
      async () => {
        events.push("cleaned");
      },
      3_000,
      () => {},
    );
    expect(events).toEqual(["cleaned"]);
    let fire: () => void = () => {};
    const hanging = bounded(
      () => new Promise<void>(() => {}),
      3_000,
      (ms, done) => {
        events.push(`timer ${ms}`);
        fire = done;
      },
    );
    fire();
    await hanging;
    expect(events).toEqual(["cleaned", "timer 3000"]);
    // A cleanup that fails still lets the exit happen.
    await bounded(
      async () => {
        throw new Error("cleanup failed");
      },
      3_000,
      () => {},
    );
  });
});
