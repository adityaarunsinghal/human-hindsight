import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultIo,
  endChildProcesses,
  KILL_GRACE_MS,
  type SpawnOptions,
} from "../src/runners/shared.js";

/**
 * Smoke tier: these tests start real child processes (node and /bin/sh, never
 * a coding CLI) to prove what the default process runner promises: a timeout
 * kills the child and its process group, a child that exits early never
 * crashes the writer, a lingering grandchild never holds a run open, and
 * output is captured whole. Unit tests fake this layer through RunnerIo.
 */

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-process-smoke-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("defaultIo.spawn: timeouts and early exits", () => {
  it("defaultIo.spawn actually kills a process that exceeds the timeout", async () => {
    const start = Date.now();
    // Portable long-running child (no POSIX `sleep`, so the suite runs on Windows
    // too, L12). SIGTERM should stop it well before the SIGKILL grace elapses.
    const res = await defaultIo.spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      input: "",
      timeoutMs: 150,
    });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - start).toBeLessThan(4000);
  });

  it("swallows EPIPE when the child exits before the prompt is fully written", async () => {
    // A child that exits immediately without reading stdin; writing a large
    // prompt to its closed stdin must NOT crash the process.
    const big = "x".repeat(2_000_000);
    const res = await defaultIo.spawn(process.execPath, ["-e", "process.exit(1)"], {
      input: big,
      timeoutMs: 5_000,
    });
    // We only require that the promise resolves (no uncaught EPIPE). Exit code is
    // reported for the caller to classify.
    expect(res.timedOut).toBe(false);
    expect(res.code).toBe(1);
  });
});

describe("defaultIo.spawn: a child that outlives its stdout pipe", () => {
  // Root cause of an observed end-of-run hang: `close` fires when the stdio
  // pipes close, NOT when the direct child exits. A CLI that execs a wrapper or
  // starts background helpers (an observed wrapper launches MCP servers) can exit
  // while a grandchild still holds the inherited stdout pipe. The runner then
  // waits on that grandchild, and the timeout is powerless because its SIGTERM
  // goes to a process that is already gone. Observed live: a distill run sat
  // idle for 10+ minutes after its last output with no child of its own.
  it("resolves on child exit instead of waiting for a lingering grandchild", async () => {
    const t0 = Date.now();
    const res = await defaultIo.spawn("/bin/sh", ["-c", "sleep 30 & echo done; exit 0"], {
      input: "",
      timeoutMs: 20_000,
    });
    // Must return as soon as the child exits, not 30s later when `sleep` ends.
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(res.timedOut).toBe(false);
    expect(res.code).toBe(0);
    // The output the child DID write is still captured.
    expect(res.stdout).toContain("done");
  }, 40_000);

  it("still captures full output from a normal child", async () => {
    // Guard: the exit-based path must not truncate a well-behaved child that
    // flushes and exits without lingering helpers.
    const res = await defaultIo.spawn(
      process.execPath,
      ["-e", "process.stdout.write('a'.repeat(200000)); process.stdout.end()"],
      { input: "", timeoutMs: 20_000 },
    );
    expect(res.stdout.length).toBe(200000);
    expect(res.timedOut).toBe(false);
  }, 40_000);

  it("still reports a non-zero exit code", async () => {
    const res = await defaultIo.spawn(process.execPath, ["-e", "process.exit(3)"], {
      input: "",
      timeoutMs: 20_000,
    });
    expect(res.code).toBe(3);
  }, 40_000);

  it("releases the child's stdio handles on settle so the process can exit", async () => {
    // Sequel to the resolve-on-exit fix: settling early leaves the child's
    // stdio streams OPEN whenever a grandchild inherited the pipes (or the
    // child was killed mid-write). Those streams are ref'd libuv handles, so
    // even though every promise resolved, the process cannot exit. Observed
    // live: a finished distill run lingered 20+ minutes holding exactly two
    // orphaned child-stdio sockets; destroying them made it exit immediately.
    type HandleCarrier = { _getActiveHandles?: () => unknown[] };
    const getHandles = () =>
      new Set(((process as HandleCarrier)._getActiveHandles?.() ?? []) as object[]);
    const before = getHandles();
    const res = await defaultIo.spawn("/bin/sh", ["-c", "sleep 20 & echo held; exit 0"], {
      input: "",
      timeoutMs: 15_000,
    });
    expect(res.stdout).toContain("held");
    // One macrotask for any destroy() teardown to complete.
    await new Promise((r) => setImmediate(r));
    const leaked = [...getHandles()].filter(
      (h) => !before.has(h) && h?.constructor?.name === "Socket",
    );
    // While the grandchild `sleep` is STILL alive (it holds the pipe write
    // ends for ~20s), our side of those pipes must already be gone.
    expect(leaked).toEqual([]);
  }, 40_000);
});

describe("owned process cleanup", () => {
  it("preserves UTF-8 characters split across process-output chunks", async () => {
    const code =
      "process.stdout.write(Buffer.from([0xe2])); setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac])), 30);";
    const result = await defaultIo.spawn(process.execPath, ["-e", code], {
      input: "",
      timeoutMs: 2000,
    });
    expect(result.stdout).toBe("€");
  });
  it("terminates an owned CLI and its descendant on timeout", async () => {
    const pidFile = path.join(root, "descendant.pid");
    const childCode = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const parentCode = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], {stdio:"ignore"}); setInterval(() => {}, 1000);`;
    const opts: SpawnOptions = { input: "", timeoutMs: 800 };
    const result = await defaultIo.spawn(process.execPath, ["-e", parentCode], opts);
    expect(result.timedOut).toBe(true);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    const dead = () => {
      try {
        process.kill(pid, 0);
        // Linux can retain an exited orphan briefly until init reaps it.
        return (
          process.platform === "linux" && /\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"))
        );
      } catch {
        return true;
      }
    };
    for (let n = 0; n < 20 && !dead(); n++) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(dead()).toBe(true);
  });

  it("an abort (Ctrl-C) ends an owned CLI and its descendant at once, long before the timeout", async () => {
    const pidFile = path.join(root, "aborted.pid");
    const childCode = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const parentCode = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], {stdio:"ignore"}); setInterval(() => {}, 1000);`;
    const controller = new AbortController();
    const started = Date.now();
    const pending = defaultIo
      .spawn(process.execPath, ["-e", parentCode], {
        input: "",
        timeoutMs: 60_000,
        signal: controller.signal,
      })
      .catch((error: unknown) => error);
    for (let n = 0; n < 200 && !fs.existsSync(pidFile); n++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await pending;
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return !(
          process.platform === "linux" && /\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"))
        );
      } catch {
        return false;
      }
    };
    for (let n = 0; n < 40 && alive(); n++) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(alive()).toBe(false);
  });
});

/**
 * A fake CLI that ignores SIGTERM and starts a child that ignores it too, the
 * way a CLI that traps signals and launches helpers behaves. Every runner goes
 * through this one spawn, so these cases cover Claude Code, Codex, Kiro, and
 * OpenCode alike.
 */
describe.skipIf(process.platform === "win32")("a CLI that ignores SIGTERM", () => {
  const stubborn = (dir: string) => {
    const pids = path.join(dir, "pids");
    const script = [
      'trap "" TERM',
      `sh -c 'trap "" TERM; echo $$ >> "${pids}"; while true; do sleep 1; done' &`,
      `echo $$ >> "${pids}"`,
      "while true; do sleep 1; done",
    ].join("\n");
    return { pids, args: ["-c", script] };
  };
  const started = async (file: string): Promise<number[]> => {
    for (let n = 0; n < 200; n++) {
      const ids = fs.existsSync(file)
        ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number)
        : [];
      if (ids.length === 2) return ids;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("the fake CLI did not start");
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const leftover: number[] = [];
  afterEach(() => {
    for (const pid of leftover.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
  const settle = async (pids: number[]) => {
    for (let n = 0; n < 100 && pids.some(alive); n++)
      await new Promise((resolve) => setTimeout(resolve, 25));
  };

  it("is ended with its child after an abort, once the grace period passes", async () => {
    const fake = stubborn(root);
    const controller = new AbortController();
    const call = defaultIo
      .spawn("/bin/sh", fake.args, { input: "", timeoutMs: 60_000, signal: controller.signal })
      .catch((error: unknown) => error);
    const pids = await started(fake.pids);
    leftover.push(...pids);
    const at = Date.now();
    controller.abort();
    // The call itself ends at once; the processes get the grace period.
    expect(((await call) as Error).name).toBe("AbortError");
    expect(Date.now() - at).toBeLessThan(KILL_GRACE_MS);
    await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS));
    await settle(pids);
    expect(pids.filter(alive)).toEqual([]);
  }, 10_000);

  it("is ended with its child after a timeout", async () => {
    const fake = stubborn(root);
    const call = defaultIo.spawn("/bin/sh", fake.args, { input: "", timeoutMs: 300 });
    const pids = await started(fake.pids);
    leftover.push(...pids);
    const result = await call;
    expect(result.timedOut).toBe(true);
    await settle(pids);
    expect(pids.filter(alive)).toEqual([]);
  }, 10_000);

  it("is ended with its child when this process exits", async () => {
    const fake = stubborn(root);
    const call = defaultIo.spawn("/bin/sh", fake.args, { input: "", timeoutMs: 60_000 });
    const pids = await started(fake.pids);
    leftover.push(...pids);
    // The handler that runs on exit is installed while a child runs.
    expect(process.listeners("exit")).toContain(endChildProcesses);
    endChildProcesses();
    await call;
    await settle(pids);
    expect(pids.filter(alive)).toEqual([]);
    expect(process.listeners("exit")).not.toContain(endChildProcesses);
  }, 10_000);
});
