import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentFingerprint } from "../src/core/fingerprint.js";
import { setFileWriter, unflushedWriter } from "../src/core/fsutil.js";
import {
  acquireWriterLock,
  LOCK_HEARTBEAT_MS,
  OperationStore,
  type QueueOperation,
  readWriterLock,
  STALE_LOCK_MS,
  WriterBusyError,
  writerBusyReason,
} from "../src/distill/operations.js";
import { DIGEST_PROMPT_VERSION } from "../src/distill/prompts/digest.js";
import { DigestResponseSchema, toJsonSchema } from "../src/distill/schemas.js";

// Unit tests skip disk flushes; test/engine.test.ts proves the durable path.
setFileWriter(unflushedWriter);

const homes: string[] = [];
function home(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "hh-operations-"));
  homes.push(value);
  fs.mkdirSync(path.join(value, "exports"));
  fs.writeFileSync(path.join(value, "exports/a.md"), "original source");
  return value;
}
afterEach(() => {
  for (const value of homes.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});
function fixtureOperation(): QueueOperation {
  return {
    kind: "digest",
    unitId: "a.md",
    generation: "g1",
    runId: "run1",
    promptVersion: DIGEST_PROMPT_VERSION,
    schema: toJsonSchema(DigestResponseSchema),
    logicalInput: { export: "a.md" },
    sources: [{ path: "exports/a.md", hash: contentFingerprint("original source"), length: 15 }],
    settings: {
      runner: "claude",
      model: null,
      timeoutMs: 900_000,
      timeoutExplicit: false,
      budget: 400_000,
      truncate: "never",
    },
    request: { prompt: "original prompt" },
  };
}
describe("durable operation store", () => {
  it("keeps immutable inputs and results and never reopens committed work", () => {
    const root = home();
    const store = new OperationStore(root, "g1");
    const op = store.queue(fixtureOperation());
    const attempt = store.start(op.id);
    store.saveResult(op.id, attempt.id, { paid: "result" });
    store.commit(op.id);
    expect(new OperationStore(root).readResult(op.id)?.value).toEqual({ paid: "result" });
    expect(() => store.start(op.id)).toThrow(/Cannot dispatch committed/);
    expect(() => store.setState(op.id, "failed")).toThrow(/cannot be reopened/);
    expect(fs.statSync(path.join(root, op.inputPath)).mode & 0o777).toBe(0o600);
    const revised = store.queue({
      ...fixtureOperation(),
      settings: { ...fixtureOperation().settings, model: "new" },
    });
    expect(revised.revision).toBe(2);
    expect(store.list().find((item) => item.id === op.id)?.state).toBe("superseded");
    expect(store.readResult(op.id)?.value).toEqual({ paid: "result" });
  });
  it("recovers a valid saved result despite a stale running index", () => {
    const root = home();
    const store = new OperationStore(root, "g1");
    const op = store.queue(fixtureOperation());
    const attempt = store.start(op.id);
    // Dispatch becomes durable at the first invocation record, before any call.
    store.recordInvocation(op.id, attempt.id, { prompt: "original prompt" });
    const indexFile = path.join(root, "distill/operations.json");
    const stale = fs.readFileSync(indexFile, "utf8");
    store.saveResult(op.id, attempt.id, { paid: true });
    fs.writeFileSync(indexFile, stale);
    const reopened = new OperationStore(root);
    expect(reopened.readResult(op.id)?.value).toEqual({ paid: true });
    expect(() => reopened.start(op.id)).toThrow();
    reopened.reconcileResult(op.id);
    expect(reopened.list()[0]?.state).toBe("result-saved");
  });
  it("rejects corrupt and future ledgers and tampered result contents", () => {
    const root = home();
    const store = new OperationStore(root, "g1");
    const op = store.queue(fixtureOperation());
    const attempt = store.start(op.id);
    store.saveResult(op.id, attempt.id, { paid: true });
    const resultPath = path.join(root, `distill/operations/${op.id}/result.json`);
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    result.value = { paid: false };
    fs.writeFileSync(resultPath, JSON.stringify(result));
    // Opening checks structure only; the tampered file is refused on use and by a full check.
    expect(() => new OperationStore(root).readResult(op.id)).toThrow(/Corrupt saved result/);
    expect(() => new OperationStore(root).verifyAll()).toThrow(/Corrupt saved result/);
    const indexPath = path.join(root, "distill/operations.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    index.version = 99;
    fs.writeFileSync(indexPath, JSON.stringify(index));
    expect(() => new OperationStore(root)).toThrow();
  });
  it("excludes prior generations while retaining their results", () => {
    const root = home();
    const store = new OperationStore(root, "g1");
    const op = store.queue(fixtureOperation());
    store.start(op.id);
    store.fail(op.id, "timeout");
    const next = new OperationStore(root, "g2");
    next.queue({ ...fixtureOperation(), generation: "g2" });
    expect(next.list()[0]?.state).toBe("superseded");
    // A queued operation is held until the next barrier; flush is that barrier here.
    expect(new OperationStore(root).generation).toBe("g1");
    next.flush();
    expect(new OperationStore(root).generation).toBe("g2");
  });
  it("refuses simultaneous writers and leaves read-only lock inspection unchanged", () => {
    const root = home();
    expect(readWriterLock(root).status).toBe("absent");
    expect(fs.existsSync(path.join(root, "distill"))).toBe(false);
    const lock = acquireWriterLock(root, "distill");
    expect(readWriterLock(root).status).toBe("alive");
    // The refusal names the command holding the lock and says nothing changed.
    expect(() => acquireWriterLock(root, "prune")).toThrow(WriterBusyError);
    expect(() => acquireWriterLock(root)).toThrow(
      /^npx human-hindsight reflect is changing this library \(process \d+, .*\)\. Nothing was changed/,
    );
    expect(writerBusyReason(root)).toMatch(/^npx human-hindsight reflect is changing this library/);
    lock.release();
    expect(readWriterLock(root).status).toBe("absent");
    expect(writerBusyReason(root)).toBeNull();
    // A lock written by an earlier release, without a command name, still refuses.
    const legacy = acquireWriterLock(root);
    expect(writerBusyReason(root)).toMatch(/^Another human-hindsight command is changing/);
    legacy.release();
  });
  it("refuses traversing source paths and malformed operation ownership", () => {
    const root = home();
    const store = new OperationStore(root, "g1");
    expect(() =>
      store.queue({
        ...fixtureOperation(),
        sources: [{ path: "../private", hash: contentFingerprint("x"), length: 1 }],
      }),
    ).toThrow();
  });
  it("rejects changed immutable request, settings, publication and attempt requests", () => {
    const root = home();
    const store = new OperationStore(root, "g1");
    const op = store.queue(fixtureOperation());
    store.flush();
    const inputFile = path.join(root, op.inputPath);
    const original = fs.readFileSync(inputFile, "utf8");
    for (const key of ["request", "settings", "publication"]) {
      const input = JSON.parse(original);
      if (key === "request") input.request.prompt = "silently changed request";
      if (key === "settings") input.settings.model = "silently changed model";
      if (key === "publication") input.publication = { outputPath: "library/other" };
      fs.writeFileSync(inputFile, JSON.stringify(input));
      expect(() => new OperationStore(root).loadInput(op.id)).toThrow(/Corrupt immutable input/);
      expect(() => new OperationStore(root).verifyAll()).toThrow(/Corrupt immutable input/);
      fs.writeFileSync(inputFile, original);
    }
    const attempt = store.start(op.id, undefined, { prompt: "override request" });
    store.flush();
    fs.writeFileSync(
      path.join(root, attempt.requestPath),
      JSON.stringify({ prompt: "changed attempt" }),
    );
    expect(() => new OperationStore(root).readAttemptRequest(op.id, attempt.id)).toThrow(
      /Corrupt attempt request/,
    );
    expect(() => new OperationStore(root).verifyAll()).toThrow(/Corrupt attempt request/);
  });
  it("reclaims a provably dead writer and refuses an ambiguous reclaim", () => {
    const root = home();
    const lock = acquireWriterLock(root);
    lock.release();
    const lockDir = path.join(root, "distill/writer.lock");
    // The release took the empty distill folder away with the lock.
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({
        pid: 2147483647,
        host: os.hostname(),
        token: "dead-owner",
        startedAt: new Date().toISOString(),
      }),
    );
    const reclaimed = acquireWriterLock(root);
    expect(readWriterLock(root).owner?.token).toBe(reclaimed.owner.token);
    reclaimed.release();
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "owner.json"), "{}");
    expect(() => acquireWriterLock(root)).toThrow(/holds this library's writer lock/);
  });
  it("blocks another acquisition while stale lock reclamation has moved the canonical directory", () => {
    const root = home();
    const first = acquireWriterLock(root);
    first.release();
    const lockDir = path.join(root, "distill/writer.lock");
    // The release took the empty distill folder away with the lock.
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({
        pid: 2147483647,
        host: os.hostname(),
        token: "dead-race-owner",
        startedAt: new Date().toISOString(),
      }),
    );
    const rename = fs.renameSync;
    let checked = false;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (String(from) === lockDir) {
        checked = true;
        expect(fs.existsSync(lockDir)).toBe(false);
        // The reclaiming command still holds the gate, and it is alive.
        expect(() => acquireWriterLock(root)).toThrow(/is changing this library/);
      }
    });
    try {
      const recovered = acquireWriterLock(root);
      expect(checked).toBe(true);
      expect(readWriterLock(root).owner?.token).toBe(recovered.owner.token);
      recovered.release();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the writer lock leaves no trace", () => {
  it("taken and released in a fresh data home, it leaves no folder behind", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-lock-fresh-"));
    try {
      const home = path.join(root, "data");
      const lock = acquireWriterLock(home, "distill");
      expect(fs.existsSync(path.join(home, "distill", "writer.lock"))).toBe(true);
      lock.release();
      expect(fs.existsSync(home)).toBe(false);
      // A home that holds something keeps it, and keeps a distill folder with work in it.
      fs.mkdirSync(path.join(home, "distill"), { recursive: true });
      fs.writeFileSync(path.join(home, "distill", "operations.json"), "{}");
      acquireWriterLock(home).release();
      expect(fs.readdirSync(path.join(home, "distill"))).toEqual(["operations.json"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a refusal leaves no folder behind either", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-lock-fresh-"));
    try {
      const home = path.join(root, "data");
      fs.mkdirSync(home);
      const held = acquireWriterLock(home, "export");
      // A second command in the same home is refused; the holder's folders stay.
      expect(() => acquireWriterLock(home, "distill")).toThrow(WriterBusyError);
      expect(fs.existsSync(path.join(home, "distill", "writer.lock"))).toBe(true);
      held.release();
      expect(fs.readdirSync(home)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a writer lock that nothing will release", () => {
  const DEAD_PID = 2147483647;
  const OTHER_HOST = `${os.hostname()}-on-another-network`;
  type Owner = { pid: number; host: string; command?: string } | "damaged" | "none";
  function place(root: string, relative: string, owner: Owner, ageMs: number) {
    const dir = path.join(root, relative);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "owner.json");
    if (owner === "damaged") fs.writeFileSync(file, "{");
    else if (owner !== "none")
      fs.writeFileSync(
        file,
        JSON.stringify({
          ...owner,
          token: "11111111-1111-4111-8111-111111111111",
          startedAt: "2026-11-20T10:00:00.000Z",
        }),
      );
    const then = new Date(Date.now() - ageMs);
    if (owner !== "none") fs.utimesSync(file, then, then);
    fs.utimesSync(dir, then, then);
    return dir;
  }
  const OLD = STALE_LOCK_MS + 1_000;
  const YOUNG = 1_000;
  const LOCK = "distill/writer.lock";
  const GATE = "distill/writer.acquire.lock";
  it.each([
    // On this machine's name the recorded process decides.
    {
      name: "this machine, process gone",
      at: LOCK,
      owner: { pid: DEAD_PID, host: os.hostname() },
      age: YOUNG,
      reclaimed: true,
    },
    {
      name: "this machine, process running (even a reused id)",
      at: LOCK,
      owner: { pid: process.ppid, host: os.hostname(), command: "distill" },
      age: OLD,
      reclaimed: false,
    },
    // Another machine name: the age since the holder's last update decides.
    {
      name: "another machine name, recent",
      at: LOCK,
      owner: { pid: DEAD_PID, host: OTHER_HOST, command: "distill" },
      age: YOUNG,
      reclaimed: false,
    },
    {
      name: "another machine name, older than the bound",
      at: LOCK,
      owner: { pid: DEAD_PID, host: OTHER_HOST },
      age: OLD,
      reclaimed: true,
    },
    {
      name: "another machine name, but its process runs here",
      at: LOCK,
      owner: { pid: process.ppid, host: OTHER_HOST },
      age: OLD,
      reclaimed: false,
    },
    {
      name: "an unreadable owner, recent",
      at: LOCK,
      owner: "damaged" as const,
      age: YOUNG,
      reclaimed: false,
    },
    {
      name: "an unreadable owner, older than the bound",
      at: LOCK,
      owner: "damaged" as const,
      age: OLD,
      reclaimed: true,
    },
    // A leftover acquisition gate follows the same rules.
    {
      name: "a leftover gate, process gone",
      at: GATE,
      owner: { pid: DEAD_PID, host: os.hostname() },
      age: YOUNG,
      reclaimed: true,
    },
    {
      name: "a leftover gate from another machine name, recent",
      at: GATE,
      owner: { pid: DEAD_PID, host: OTHER_HOST },
      age: YOUNG,
      reclaimed: false,
    },
    {
      name: "an empty leftover gate, older than the bound",
      at: GATE,
      owner: "none" as const,
      age: OLD,
      reclaimed: true,
    },
  ])("$name", ({ at, owner, age, reclaimed }) => {
    const root = home();
    const dir = place(root, at, owner as Owner, age);
    let line = "";
    try {
      acquireWriterLock(root, "rate").release();
    } catch (error) {
      expect(error).toBeInstanceOf(WriterBusyError);
      line = (error as Error).message;
    }
    expect(line === "").toBe(reclaimed);
    if (reclaimed) {
      expect(fs.existsSync(dir)).toBe(false);
      expect(writerBusyReason(root)).toBeNull();
      expect(fs.readdirSync(path.join(root, "distill"))).toEqual([]);
      return;
    }
    // One plain line: the holder, the file, and the way out if nothing runs.
    expect(line).not.toContain("\n");
    expect(line).toContain("Nothing was changed.");
    expect(line).toContain(`remove ${dir}`);
    if (typeof owner === "object") expect(line).toContain(`process ${owner.pid}`);
    if (typeof owner === "object" && owner.command)
      expect(line).toContain(
        `npx human-hindsight ${owner.command === "distill" ? "reflect" : owner.command}`,
      );
    if (typeof owner === "object" && owner.host === OTHER_HOST && age === YOUNG)
      expect(line).toContain(`on ${OTHER_HOST}`);
    // Read-only previews give the same answer and change nothing.
    expect(writerBusyReason(root)).toBe(line);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("reclaims a dead lock that a crashed reclaim left a claim file in", () => {
    const root = home();
    const dir = place(root, LOCK, { pid: DEAD_PID, host: os.hostname() }, YOUNG);
    fs.writeFileSync(path.join(dir, "reclaim.json"), "leftover");
    const lock = acquireWriterLock(root, "edit");
    expect(readWriterLock(root).owner?.command).toBe("edit");
    lock.release();
  });

  it("the holder refreshes its lock, so a running holder never looks stale", () => {
    vi.useFakeTimers();
    try {
      const root = home();
      const lock = acquireWriterLock(root, "distill");
      const file = path.join(root, LOCK, "owner.json");
      const old = new Date(Date.now() - OLD);
      fs.utimesSync(file, old, old);
      vi.advanceTimersByTime(LOCK_HEARTBEAT_MS);
      expect(Date.now() - fs.statSync(file).mtimeMs).toBeLessThan(STALE_LOCK_MS);
      lock.release();
      expect(readWriterLock(root).status).toBe("absent");
    } finally {
      vi.useRealTimers();
    }
  });
});
