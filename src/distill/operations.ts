import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { contentFingerprint, fingerprint } from "../core/fingerprint.js";
import { atomicWriteFilePrivate, mkdirPrivate } from "../core/fsutil.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/);
const RelativePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !path.isAbsolute(value) &&
      !value.includes("\\") &&
      value.split("/").every((part) => part !== ".." && part !== "." && part.length > 0),
    "unsafe relative path",
  );
export const OperationKindSchema = z.enum(["digest", "cluster-window", "cluster-merge", "author"]);
export type OperationKind = z.infer<typeof OperationKindSchema>;
export const OperationStateSchema = z.enum([
  "queued",
  "running",
  "failed",
  "blocked",
  "result-saved",
  "committed",
  "skipped",
  "superseded",
  "resolved-by-fallback",
]);
export type OperationState = z.infer<typeof OperationStateSchema>;
export const AttemptSettingsSchema = z
  .object({
    runner: z.enum(["claude", "codex", "kiro", "opencode"]),
    model: z.string().nullable(),
    timeoutMs: z.number().int().positive(),
    timeoutExplicit: z.boolean(),
    budget: z.number().int().positive(),
    truncate: z.enum(["never", "extreme"]),
  })
  .strict();
export type AttemptSettings = z.infer<typeof AttemptSettingsSchema>;
export const SourceGuardSchema = z
  .object({ path: RelativePath, hash: Hash, length: z.number().int().nonnegative() })
  .strict();
export type SourceGuard = z.infer<typeof SourceGuardSchema>;
const OwnerSchema = z
  .object({
    pid: z.number().int().positive(),
    host: z.string().min(1),
    token: Id,
    startedAt: z.string(),
  })
  .strict();
export type WriterOwner = z.infer<typeof OwnerSchema>;
const InvocationSchema = z
  .object({
    index: z.number().int().positive(),
    requestPath: RelativePath,
    requestHash: Hash,
    startedAt: z.string(),
  })
  .strict();
export type InvocationRecord = z.infer<typeof InvocationSchema>;
const AttemptSchema = z
  .object({
    id: Id,
    runId: Id,
    startedAt: z.string(),
    endedAt: z.string().optional(),
    owner: OwnerSchema,
    settings: AttemptSettingsSchema,
    requestHash: Hash,
    requestPath: RelativePath,
    invocations: z.array(InvocationSchema),
    outcome: z.enum(["running", "failed", "result-saved", "committed", "interrupted"]),
    error: z.string().max(2000).optional(),
  })
  .strict();
export type AttemptRecord = z.infer<typeof AttemptSchema>;
export interface PreparedRequest {
  prompt: string;
  [key: string]: unknown;
}
export interface PublicationReceipt {
  [key: string]: unknown;
}
const RequestSchema = z.object({ prompt: z.string() }).catchall(z.unknown());
const InputSchema = z
  .object({
    version: z.literal(1),
    operationId: Id,
    generation: Id,
    kind: OperationKindSchema,
    unitId: z.string().min(1),
    logicalInputHash: Hash,
    promptVersion: z.number().int().nonnegative(),
    schemaHash: Hash,
    schema: z.unknown(),
    logicalInput: z.unknown(),
    sources: z.array(SourceGuardSchema),
    settings: AttemptSettingsSchema,
    request: RequestSchema,
    publication: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type OperationInput = z.infer<typeof InputSchema>;
const RecordSchema = z
  .object({
    id: Id,
    revision: z.number().int().positive(),
    generation: Id,
    runId: Id,
    kind: OperationKindSchema,
    unitId: z.string().min(1),
    state: OperationStateSchema,
    source: z.enum(["normal-distill", "explicit-task-recovery"]),
    logicalInputHash: Hash,
    promptVersion: z.number().int().nonnegative(),
    schemaHash: Hash,
    dependencyIds: z.array(Id),
    inputPath: RelativePath,
    inputHash: Hash,
    attempts: z.array(AttemptSchema),
    resultHash: Hash.optional(),
    publication: z.record(z.string(), z.unknown()).optional(),
    blockedReason: z.string().max(2000).optional(),
  })
  .strict();
export type OperationRecord = z.infer<typeof RecordSchema>;
const IndexSchema = z
  .object({ version: z.literal(1), generation: Id, operations: z.array(RecordSchema) })
  .strict();
export type OperationIndex = z.infer<typeof IndexSchema>;
const ResultSchema = z
  .object({
    version: z.literal(1),
    operationId: Id,
    attemptId: Id,
    logicalInputHash: Hash,
    schemaHash: Hash,
    valueHash: Hash,
    savedAt: z.string(),
    value: z.unknown(),
  })
  .strict();
export type SavedResult = z.infer<typeof ResultSchema>;
export interface QueueOperation {
  kind: OperationKind;
  unitId: string;
  generation: string;
  runId: string;
  promptVersion: number;
  schema: unknown;
  logicalInput: unknown;
  sources: SourceGuard[];
  settings: AttemptSettings;
  request: PreparedRequest;
  publication?: PublicationReceipt;
  dependencyIds?: string[];
  source?: "normal-distill" | "explicit-task-recovery";
}

/** Unique same-directory writes; fsync the file and directory before returning. */
export function atomicOperationWrite(file: string, value: unknown): void {
  atomicWriteFilePrivate(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Resolve a data-home path without allowing traversal or symlink escape. */
export function guardedPath(home: string, relative: string): string {
  RelativePath.parse(relative);
  const root = path.resolve(home);
  const target = path.resolve(root, relative);
  let ancestor = target;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (fs.existsSync(root)) {
    const realRoot = fs.realpathSync(root);
    const realAncestor = fs.realpathSync(ancestor);
    if (realAncestor !== realRoot && !realAncestor.startsWith(`${realRoot}${path.sep}`))
      throw new Error(`Path escapes data home: ${relative}`);
  }
  return target;
}
export function checkSourceGuards(home: string, sources: readonly SourceGuard[]): void {
  for (const source of sources) {
    const content = fs.readFileSync(guardedPath(home, source.path), "utf8");
    if (content.length !== source.length || contentFingerprint(content) !== source.hash)
      throw new Error(`Source changed: ${source.path}; run normal distill to prepare new inputs`);
  }
}
function ownProcess(): WriterOwner {
  return {
    pid: process.pid,
    host: os.hostname(),
    token: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
  };
}
export function ownerStatus(owner: WriterOwner): "alive" | "dead" | "unknown" {
  if (owner.host !== os.hostname()) return "unknown";
  try {
    process.kill(owner.pid, 0);
    return "alive";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
}
function readCanonicalWriterLock(home: string): {
  status: "absent" | "alive" | "dead" | "unknown";
  owner?: WriterOwner;
} {
  const dir = guardedPath(home, "distill/writer.lock");
  if (!fs.existsSync(dir)) return { status: "absent" };
  try {
    const owner = OwnerSchema.parse(
      JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8")),
    );
    return { status: ownerStatus(owner), owner };
  } catch {
    return { status: "unknown" };
  }
}
/** A pending acquisition is also a writer conflict, including an abandoned gate. */
export function readWriterLock(home: string): {
  status: "absent" | "alive" | "dead" | "unknown";
  owner?: WriterOwner;
} {
  if (fs.existsSync(guardedPath(home, "distill/writer.acquire.lock"))) return { status: "unknown" };
  return readCanonicalWriterLock(home);
}
/** Serialize every acquisition, including the interval where a dead lock moves. */
export function acquireWriterLock(home: string): { owner: WriterOwner; release(): void } {
  mkdirPrivate(guardedPath(home, "distill"));
  const gate = guardedPath(home, "distill/writer.acquire.lock");
  try {
    fs.mkdirSync(gate, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "Another writer is acquiring the lock, or an interrupted acquisition needs inspection: distill/writer.acquire.lock",
      );
    throw error;
  }
  const gateOwner = ownProcess();
  try {
    atomicOperationWrite(path.join(gate, "owner.json"), gateOwner);
    return acquireCanonicalWriterLock(home);
  } finally {
    // Every contender uses the gate and nobody reclaims it automatically.
    // A crash leaves a bounded refusal, never a competing writer.
    fs.rmSync(gate, { recursive: true, force: true });
  }
}
/** A lock is reclaimed only for a provably dead local process and matching token. */
function acquireCanonicalWriterLock(home: string): { owner: WriterOwner; release(): void } {
  mkdirPrivate(guardedPath(home, "distill"));
  const dir = guardedPath(home, "distill/writer.lock");
  const before = readCanonicalWriterLock(home);
  if (before.status !== "absent") {
    if (before.status !== "dead" || !before.owner)
      throw new Error("Another distill writer is active or its ownership cannot be verified");
    // Serialize reclaimers inside the old directory. A process that dies
    // mid-reclaim leaves an explicit ambiguous claim rather than allowing a
    // second process to move a replacement writer's directory.
    const claimPath = path.join(dir, "reclaim.json");
    const claim = crypto.randomUUID();
    let claimFd: number;
    try {
      claimFd = fs.openSync(claimPath, "wx", 0o600);
    } catch {
      throw new Error(
        "Another process is reclaiming the stale writer lock; inspect it before retrying",
      );
    }
    try {
      fs.writeFileSync(claimFd, claim);
      fs.fsyncSync(claimFd);
    } finally {
      fs.closeSync(claimFd);
    }
    const again = readCanonicalWriterLock(home);
    if (again.status !== "dead" || again.owner?.token !== before.owner.token) {
      if (fs.readFileSync(claimPath, "utf8") === claim) fs.rmSync(claimPath);
      throw new Error("Writer ownership changed; retry with a new preview");
    }
    const stale = `${dir}.stale-${before.owner.token}`;
    fs.renameSync(dir, stale);
    const moved = OwnerSchema.parse(
      JSON.parse(fs.readFileSync(path.join(stale, "owner.json"), "utf8")),
    );
    if (moved.token !== before.owner.token) {
      if (!fs.existsSync(dir)) fs.renameSync(stale, dir);
      throw new Error("Writer ownership changed while reclaiming lock");
    }
    fs.rmSync(stale, { recursive: true });
  }
  fs.mkdirSync(dir, { mode: 0o700 });
  const owner = ownProcess();
  try {
    atomicOperationWrite(path.join(dir, "owner.json"), owner);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    owner,
    release() {
      const current = readCanonicalWriterLock(home);
      if (current.owner?.token === owner.token) fs.rmSync(dir, { recursive: true });
    },
  };
}

/** Durable operation index. Read paths never create directories or migrate state. */
export class OperationStore {
  readonly home: string;
  private index: OperationIndex;
  constructor(home: string, generation?: string) {
    this.home = home;
    const file = guardedPath(home, "distill/operations.json");
    if (fs.existsSync(file)) {
      this.index = IndexSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
      const ids = new Set<string>();
      for (const operation of this.index.operations) {
        if (ids.has(operation.id)) throw new Error("Duplicate operation identity in ledger");
        ids.add(operation.id);
        if (operation.inputPath !== `distill/operations/${operation.id}/input.json`)
          throw new Error("Invalid operation input path");
        if (operation.generation !== this.index.generation && operation.state !== "superseded")
          throw new Error("Mismatched operation generation");
        this.loadInput(operation.id);
        for (const attempt of operation.attempts) {
          if (
            attempt.requestPath !==
            `distill/operations/${operation.id}/attempts/${attempt.id}/request.json`
          )
            throw new Error("Invalid attempt request path");
          const request = JSON.parse(
            fs.readFileSync(guardedPath(this.home, attempt.requestPath), "utf8"),
          );
          if (fingerprint(request) !== attempt.requestHash)
            throw new Error(`Corrupt attempt request for operation ${operation.id}`);
          for (const [index, invocation] of attempt.invocations.entries()) {
            if (
              invocation.index !== index + 1 ||
              invocation.requestPath !==
                `distill/operations/${operation.id}/attempts/${attempt.id}/invocations/${invocation.index}.json`
            )
              throw new Error("Invalid invocation request path");
            const request = JSON.parse(
              fs.readFileSync(guardedPath(this.home, invocation.requestPath), "utf8"),
            );
            if (fingerprint(request) !== invocation.requestHash)
              throw new Error(`Corrupt invocation request for operation ${operation.id}`);
          }
        }
      }
      for (const operation of this.index.operations) {
        if (operation.dependencyIds.some((id) => !ids.has(id)))
          throw new Error("Dangling operation dependency");
        this.readResult(operation.id);
      }
      if (generation && generation !== this.index.generation) {
        // A new normal generation retains history but excludes all older operations.
        for (const operation of this.index.operations) operation.state = "superseded";
        this.index.generation = Id.parse(generation);
      }
    } else {
      if (!generation)
        throw new Error(
          "This run has no recorded failure history. Strict retry cannot infer failures from missing output. For specific saved tasks, use --recover-tasks=<slugs> --dry-run.",
        );
      this.index = { version: 1, generation: Id.parse(generation), operations: [] };
    }
  }
  get generation(): string {
    return this.index.generation;
  }
  list(): OperationRecord[] {
    return structuredClone(this.index.operations);
  }
  snapshot(): string {
    return fingerprint(this.index);
  }
  private record(id: string): OperationRecord {
    const value = this.index.operations.find((operation) => operation.id === id);
    if (!value) throw new Error(`Unknown operation: ${id}`);
    return value;
  }
  private save(): void {
    IndexSchema.parse(this.index);
    atomicOperationWrite(guardedPath(this.home, "distill/operations.json"), this.index);
  }
  queue(options: QueueOperation): OperationRecord {
    if (options.generation !== this.generation)
      throw new Error("Operation generation does not match ledger");
    const prior = this.index.operations.filter(
      (operation) => operation.kind === options.kind && operation.unitId === options.unitId,
    );
    const id = crypto.randomUUID();
    const logicalInputHash = fingerprint({
      kind: options.kind,
      logicalInput: options.logicalInput,
      sources: options.sources,
      promptVersion: options.promptVersion,
      schema: options.schema,
    });
    const schemaHash = fingerprint(options.schema);
    const input = InputSchema.parse({
      version: 1,
      operationId: id,
      generation: options.generation,
      kind: options.kind,
      unitId: options.unitId,
      logicalInputHash,
      promptVersion: options.promptVersion,
      schemaHash,
      schema: options.schema,
      logicalInput: options.logicalInput,
      sources: options.sources,
      settings: options.settings,
      request: options.request,
      ...(options.publication ? { publication: options.publication } : {}),
    });
    const record = RecordSchema.parse({
      id,
      revision: Math.max(0, ...prior.map((operation) => operation.revision)) + 1,
      generation: options.generation,
      runId: options.runId,
      kind: options.kind,
      unitId: options.unitId,
      state: "queued",
      source: options.source ?? "normal-distill",
      logicalInputHash,
      promptVersion: options.promptVersion,
      schemaHash,
      dependencyIds: options.dependencyIds ?? [],
      inputPath: `distill/operations/${id}/input.json`,
      inputHash: fingerprint(input),
      attempts: [],
    });
    for (const dependency of record.dependencyIds) this.record(dependency);
    atomicOperationWrite(guardedPath(this.home, record.inputPath), input);
    for (const previous of prior) previous.state = "superseded";
    this.index.operations.push(record);
    this.save();
    return structuredClone(record);
  }
  loadInput(id: string): OperationInput {
    const record = this.record(id);
    const input = InputSchema.parse(
      JSON.parse(fs.readFileSync(guardedPath(this.home, record.inputPath), "utf8")),
    );
    if (
      fingerprint(input) !== record.inputHash ||
      input.operationId !== id ||
      input.generation !== record.generation ||
      input.kind !== record.kind ||
      input.unitId !== record.unitId ||
      input.promptVersion !== record.promptVersion ||
      input.schemaHash !== record.schemaHash ||
      input.logicalInputHash !== record.logicalInputHash ||
      fingerprint(input.schema) !== input.schemaHash ||
      fingerprint({
        kind: input.kind,
        logicalInput: input.logicalInput,
        sources: input.sources,
        promptVersion: input.promptVersion,
        schema: input.schema,
      }) !== input.logicalInputHash
    )
      throw new Error(`Corrupt immutable input for operation ${id}`);
    return input;
  }
  start(id: string, settings?: AttemptSettings, request?: PreparedRequest): AttemptRecord {
    const record = this.record(id);
    if (!["queued", "failed", "blocked", "running"].includes(record.state))
      throw new Error(`Cannot dispatch ${record.state} operation ${id}`);
    if (record.state === "running") {
      const prior = record.attempts.at(-1);
      if (!prior || ownerStatus(prior.owner) !== "dead")
        throw new Error("Running operation has a live or ambiguous owner");
      prior.outcome = "interrupted";
      prior.endedAt = new Date().toISOString();
    }
    if (this.readResult(id))
      throw new Error("Operation already has a saved result; repair it without inference");
    const input = this.loadInput(id);
    const attemptId = crypto.randomUUID();
    const attempt = AttemptSchema.parse({
      id: attemptId,
      runId: record.runId,
      startedAt: new Date().toISOString(),
      owner: ownProcess(),
      settings: settings ?? input.settings,
      requestHash: fingerprint(request ?? input.request),
      requestPath: `distill/operations/${id}/attempts/${attemptId}/request.json`,
      invocations: [],
      outcome: "running",
    });
    atomicOperationWrite(guardedPath(this.home, attempt.requestPath), request ?? input.request);
    record.attempts.push(attempt);
    record.state = "running";
    delete record.blockedReason;
    this.save();
    return structuredClone(attempt);
  }
  recordInvocation(id: string, attemptId: string, request: PreparedRequest): InvocationRecord {
    const record = this.record(id);
    const attempt = record.attempts.at(-1);
    if (record.state !== "running" || attempt?.id !== attemptId)
      throw new Error("Invocation does not belong to the running attempt");
    const index = attempt.invocations.length + 1;
    const invocation = InvocationSchema.parse({
      index,
      requestHash: fingerprint(request),
      requestPath: `distill/operations/${id}/attempts/${attemptId}/invocations/${index}.json`,
      startedAt: new Date().toISOString(),
    });
    atomicOperationWrite(guardedPath(this.home, invocation.requestPath), request);
    attempt.invocations.push(invocation);
    this.save();
    return structuredClone(invocation);
  }
  saveResult(id: string, attemptId: string, value: unknown): SavedResult {
    const record = this.record(id);
    if (record.state !== "running")
      throw new Error("Only running operations can save a new result");
    const attempt = record.attempts.at(-1);
    if (!attempt || attempt.id !== attemptId)
      throw new Error("Result attempt does not match active operation");
    if (this.readResult(id)) throw new Error("Saved operation results are immutable");
    const result = ResultSchema.parse({
      version: 1,
      operationId: id,
      attemptId,
      logicalInputHash: record.logicalInputHash,
      schemaHash: record.schemaHash,
      valueHash: fingerprint(value),
      savedAt: new Date().toISOString(),
      value,
    });
    atomicOperationWrite(guardedPath(this.home, `distill/operations/${id}/result.json`), result);
    record.resultHash = result.valueHash;
    record.state = "result-saved";
    attempt.outcome = "result-saved";
    attempt.endedAt = result.savedAt;
    this.save();
    return structuredClone(result);
  }
  readResult(id: string): SavedResult | null {
    const record = this.record(id);
    const file = guardedPath(this.home, `distill/operations/${id}/result.json`);
    if (!fs.existsSync(file)) {
      if (record.resultHash || ["result-saved", "committed"].includes(record.state))
        throw new Error(`Saved result missing for operation ${id}`);
      return null;
    }
    const result = ResultSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (
      result.operationId !== id ||
      result.logicalInputHash !== record.logicalInputHash ||
      result.schemaHash !== record.schemaHash ||
      fingerprint(result.value) !== result.valueHash ||
      (record.resultHash && record.resultHash !== result.valueHash) ||
      !record.attempts.some((attempt) => attempt.id === result.attemptId)
    )
      throw new Error(`Corrupt saved result for operation ${id}`);
    return result;
  }
  fail(id: string, error: unknown): void {
    const record = this.record(id);
    if (["committed", "superseded", "skipped", "resolved-by-fallback"].includes(record.state))
      throw new Error("Completed operation cannot fail again");
    // A publication failure must retain the durable result for local recovery.
    const result = this.readResult(id);
    record.state = result ? "result-saved" : "failed";
    const attempt = record.attempts.at(-1);
    if (attempt) {
      attempt.outcome = result ? "result-saved" : "failed";
      attempt.endedAt = new Date().toISOString();
      attempt.error = String(error instanceof Error ? error.message : error).slice(0, 2000);
    }
    record.blockedReason = String(error instanceof Error ? error.message : error).slice(0, 2000);
    this.save();
  }
  block(id: string, reason: string): void {
    const record = this.record(id);
    if (["committed", "superseded", "skipped", "resolved-by-fallback"].includes(record.state))
      throw new Error("Cannot block completed operation");
    record.state = "blocked";
    record.blockedReason = reason.slice(0, 2000);
    this.save();
  }
  commit(id: string, publication?: PublicationReceipt): void {
    const record = this.record(id);
    const result = this.readResult(id);
    if (!result) throw new Error("Cannot commit an operation without a validated saved result");
    record.state = "committed";
    record.resultHash = result.valueHash;
    if (publication) record.publication = publication;
    delete record.blockedReason;
    const attempt = record.attempts.find((item) => item.id === result.attemptId);
    if (attempt) attempt.outcome = "committed";
    this.save();
  }
  setState(id: string, state: OperationState): void {
    const record = this.record(id);
    if (record.state === "committed" && state !== "superseded")
      throw new Error("Committed operation cannot be reopened");
    record.state = state;
    this.save();
  }
  reconcileResult(id: string): SavedResult | null {
    const result = this.readResult(id);
    if (result) {
      const record = this.record(id);
      if (!["committed", "superseded", "resolved-by-fallback", "skipped"].includes(record.state)) {
        record.state = "result-saved";
        record.resultHash = result.valueHash;
        this.save();
      }
    }
    return result;
  }
}
