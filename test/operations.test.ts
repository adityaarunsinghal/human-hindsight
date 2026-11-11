import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIGEST_PROMPT_VERSION } from "../src/claude/prompts/digest.js";
import { DigestResponseSchema, toJsonSchema } from "../src/claude/schemas.js";
import { contentFingerprint } from "../src/core/fingerprint.js";
import {
  acquireWriterLock,
  OperationStore,
  type QueueOperation,
  readWriterLock,
} from "../src/distill/operations.js";

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
    expect(() => new OperationStore(root)).toThrow(/Corrupt saved result/);
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
    expect(new OperationStore(root).generation).toBe("g2");
  });
  it("refuses simultaneous writers and leaves read-only lock inspection unchanged", () => {
    const root = home();
    expect(readWriterLock(root).status).toBe("absent");
    expect(fs.existsSync(path.join(root, "distill"))).toBe(false);
    const lock = acquireWriterLock(root);
    expect(readWriterLock(root).status).toBe("alive");
    expect(() => acquireWriterLock(root)).toThrow(/writer/);
    lock.release();
    expect(readWriterLock(root).status).toBe("absent");
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
    const inputFile = path.join(root, op.inputPath);
    const original = fs.readFileSync(inputFile, "utf8");
    for (const key of ["request", "settings", "publication"]) {
      const input = JSON.parse(original);
      if (key === "request") input.request.prompt = "silently changed request";
      if (key === "settings") input.settings.model = "silently changed model";
      if (key === "publication") input.publication = { outputPath: "library/other" };
      fs.writeFileSync(inputFile, JSON.stringify(input));
      expect(() => new OperationStore(root)).toThrow(/Corrupt immutable input/);
      fs.writeFileSync(inputFile, original);
    }
    const attempt = store.start(op.id, undefined, { prompt: "override request" });
    fs.writeFileSync(
      path.join(root, attempt.requestPath),
      JSON.stringify({ prompt: "changed attempt" }),
    );
    expect(() => new OperationStore(root)).toThrow(/Corrupt attempt request/);
  });
  it("reclaims a provably dead writer and refuses an ambiguous reclaim", () => {
    const root = home();
    const lock = acquireWriterLock(root);
    lock.release();
    const lockDir = path.join(root, "distill/writer.lock");
    fs.mkdirSync(lockDir);
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
    expect(() => acquireWriterLock(root)).toThrow(/ownership cannot be verified/);
  });
  it("blocks another acquisition while stale lock reclamation has moved the canonical directory", () => {
    const root = home();
    const first = acquireWriterLock(root);
    first.release();
    const lockDir = path.join(root, "distill/writer.lock");
    fs.mkdirSync(lockDir);
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
        expect(() => acquireWriterLock(root)).toThrow(/acquiring the lock/);
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
