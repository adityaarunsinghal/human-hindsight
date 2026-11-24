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
const OperationStateSchema = z.enum([
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
const Runner = z.enum(["claude", "codex", "kiro", "opencode"]);
const Resolved = z.object({ runner: Runner, model: z.string().optional() });
export const AttemptSettingsSchema = z
  .object({
    runner: Runner,
    automatic: z.boolean().optional(),
    model: z.string().nullable(),
    timeoutMs: z.number().int().positive(),
    timeoutExplicit: z.boolean(),
    budget: z.number().int().positive(),
    truncate: z.enum(["never", "extreme"]),
  })
  .strict();
export type AttemptSettings = z.infer<typeof AttemptSettingsSchema>;
const SourceGuardSchema = z
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
/** The writer lock's owner also names the command holding it, so a refusal can say which. */
const LockOwnerSchema = z
  .object({
    ...OwnerSchema.shape,
    command: z
      .string()
      .regex(/^[a-z][a-z -]{0,39}$/)
      .optional(),
  })
  .strict();
export type WriterLockOwner = z.infer<typeof LockOwnerSchema>;
const InvocationSchema = z
  .object({
    index: z.number().int().positive(),
    requestPath: RelativePath,
    requestHash: Hash,
    startedAt: z.string(),
    resolved: Resolved.optional(),
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
  /** Explicit choices used when named recovery adopts an existing attempt. */
  recoveryOverrides?: Partial<AttemptSettings>;
}

/** Unique same-directory writes; fsync the file and directory before returning. */
function atomicOperationWrite(file: string, value: unknown): void {
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
/** Owner tokens of attempts this process has started and not yet finished. */
const liveAttempts = new Set<string>();
/**
 * An attempt owned by this process is alive only while it is in flight here.
 * A recorded attempt with this process id but an unknown token was left by an
 * interrupted sequence (or a reused process id), so it is dead.
 */
export function attemptOwnerStatus(owner: WriterOwner): "alive" | "dead" | "unknown" {
  if (owner.host === os.hostname() && owner.pid === process.pid)
    return liveAttempts.has(owner.token) ? "alive" : "dead";
  return ownerStatus(owner);
}
function ownerStatus(owner: WriterOwner): "alive" | "dead" | "unknown" {
  if (owner.host !== os.hostname()) return "unknown";
  try {
    process.kill(owner.pid, 0);
    return "alive";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
}
type WriterLockState = {
  status: "absent" | "alive" | "dead" | "unknown";
  owner?: WriterLockOwner;
};

/**
 * How long a lock whose holder cannot be checked on this machine is honored
 * after its last sign of life: two minutes.
 *
 * A holder on this machine is checked by its process id, so this bound only
 * applies when the recorded machine name differs (macOS renames the machine
 * when it joins another network) or the lock's files are leftovers with no
 * readable owner. A running holder refreshes its lock every
 * {@link LOCK_HEARTBEAT_MS}, so two minutes is six missed refreshes: long
 * enough that a busy holder is never taken over, short enough that a person
 * who meets a lock left by a crash waits about two minutes, never forever.
 */
export const STALE_LOCK_MS = 120_000;
/** How often the holder refreshes its lock's time stamp. */
export const LOCK_HEARTBEAT_MS = 20_000;

const LOCK_DIR = "distill/writer.lock";
const GATE_DIR = "distill/writer.acquire.lock";

function readCanonicalWriterLock(home: string): WriterLockState {
  const dir = guardedPath(home, LOCK_DIR);
  if (!fs.existsSync(dir)) return { status: "absent" };
  try {
    const owner = LockOwnerSchema.parse(
      JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8")),
    );
    return { status: ownerStatus(owner), owner };
  } catch {
    return { status: "unknown" };
  }
}
/** A pending acquisition is also a writer conflict, including an abandoned gate. */
export function readWriterLock(home: string): WriterLockState {
  if (fs.existsSync(guardedPath(home, GATE_DIR))) return { status: "unknown" };
  return readCanonicalWriterLock(home);
}

/** Another command holds the data home's writer lock; nothing was changed. */
export class WriterBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriterBusyError";
  }
}

const TRY_AGAIN = "Nothing was changed. Run this again when it finishes.";

/** What to do with a lock (or the acquisition gate) found in place. */
type LockVerdict =
  | { kind: "absent" }
  | { kind: "reclaim"; token?: string }
  | { kind: "busy"; line: string };

/** Is this process id running on this machine? A process of another user counts. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Milliseconds since the lock last showed its holder was alive. */
function lockAge(dir: string, now: number): number {
  for (const file of [path.join(dir, "owner.json"), dir]) {
    try {
      return now - fs.statSync(file).mtimeMs;
    } catch {
      // try the next
    }
  }
  return 0;
}

/**
 * The rules, for the lock and for the gate that serializes taking it:
 * - recorded on this machine's name: the recorded process decides; running
 *   (even a reused process id) is busy, gone is reclaimed at once;
 * - recorded under another machine name, or no readable owner (a leftover):
 *   a process with that id running here is busy; otherwise the lock is
 *   reclaimed once its last sign of life is older than {@link STALE_LOCK_MS},
 *   and refused before that.
 * Every refusal is one line naming the holder, the file, and the way out.
 */
function judgeLock(home: string, relative: string, now = Date.now()): LockVerdict {
  const dir = guardedPath(home, relative);
  if (!fs.existsSync(dir)) return { kind: "absent" };
  let owner: WriterLockOwner | undefined;
  try {
    owner = LockOwnerSchema.parse(
      JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8")),
    );
  } catch {
    owner = undefined;
  }
  const who = owner?.command
    ? `human-hindsight ${owner.command}`
    : "Another human-hindsight command";
  const remove = `If no human-hindsight command is running, remove ${dir} and run this again.`;
  if (owner && owner.host === os.hostname()) {
    if (!processAlive(owner.pid)) return { kind: "reclaim", token: owner.token };
    return {
      kind: "busy",
      line: `${who} is changing this library (process ${owner.pid}, started ${owner.startedAt}). ${TRY_AGAIN} ${remove}`,
    };
  }
  if (owner && processAlive(owner.pid)) {
    return {
      kind: "busy",
      line: `${who} may be changing this library (process ${owner.pid} on ${owner.host}, started ${owner.startedAt}). ${TRY_AGAIN} ${remove}`,
    };
  }
  if (lockAge(dir, now) >= STALE_LOCK_MS) return { kind: "reclaim", token: owner?.token };
  const holder = owner
    ? `${who} on ${owner.host} (process ${owner.pid}, started ${owner.startedAt})`
    : who;
  const wait = Math.ceil(STALE_LOCK_MS / 60_000);
  return {
    kind: "busy",
    line: `${holder} holds this library's writer lock (${dir}). Nothing was changed. If it is not running, the lock is released ${wait} minutes after its last update; run this again then, or remove ${dir} now.`,
  };
}

/** Move a judged lock directory aside and delete it; false when it changed meanwhile. */
function reclaimDir(dir: string, token: string | undefined): boolean {
  const stale = `${dir}.stale-${crypto.randomUUID()}`;
  try {
    fs.renameSync(dir, stale);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  if (token !== undefined) {
    let moved: string | undefined;
    try {
      moved = LockOwnerSchema.parse(
        JSON.parse(fs.readFileSync(path.join(stale, "owner.json"), "utf8")),
      ).token;
    } catch {
      moved = undefined;
    }
    if (moved !== token) {
      // Another command replaced it between the check and the move: put it back.
      if (!fs.existsSync(dir)) fs.renameSync(stale, dir);
      return false;
    }
  }
  fs.rmSync(stale, { recursive: true, force: true });
  return true;
}

/**
 * Why a command that changes the library or the ledger must not start now,
 * or null when no other writer holds the lock (or the lock would be
 * reclaimed). Read-only: previews and dry runs use it; a command that writes
 * takes the lock with {@link acquireWriterLock}.
 */
export function writerBusyReason(home: string): string | null {
  for (const relative of [GATE_DIR, LOCK_DIR]) {
    const verdict = judgeLock(home, relative);
    if (verdict.kind === "busy") return verdict.line;
  }
  return null;
}

const CHANGED = `Another human-hindsight command took the writer lock at the same moment. ${TRY_AGAIN}`;

/**
 * Serialize every acquisition, including the interval where a stale lock moves.
 * `command` names the holder (for example "distill") in other commands' refusals.
 * Every refusal is a {@link WriterBusyError} with one plain line.
 */
export function acquireWriterLock(
  home: string,
  command?: string,
): { owner: WriterLockOwner; release(): void } {
  // The folders the lock needs that are not there yet. A release takes them
  // away again while they are empty, so a command that ends up changing
  // nothing (a declined plan, a refusal) leaves the data home as it was.
  const created = missingFolders(guardedPath(home, "distill"));
  try {
    const lock = acquireGatedWriterLock(home, command);
    return {
      owner: lock.owner,
      release() {
        lock.release();
        removeEmpty(created);
      },
    };
  } catch (error) {
    removeEmpty(created);
    throw error;
  }
}

/** `dir` and each parent that does not exist yet, deepest first. */
function missingFolders(dir: string): string[] {
  const missing: string[] = [];
  for (let current = dir; !fs.existsSync(current); current = path.dirname(current)) {
    missing.push(current);
    if (path.dirname(current) === current) break;
  }
  return missing;
}

/** Remove these folders, deepest first, stopping at the first that is not empty. */
function removeEmpty(dirs: string[]): void {
  for (const dir of dirs) {
    try {
      fs.rmdirSync(dir);
    } catch {
      return;
    }
  }
}

/**
 * Make a lock folder. Another command may remove the empty `distill` folder
 * above it at the same moment (see {@link acquireWriterLock}); then the
 * folder is made again once.
 */
function mkdirLock(home: string, dir: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new WriterBusyError(CHANGED);
      if (code !== "ENOENT" || attempt > 0) throw error;
      mkdirPrivate(guardedPath(home, "distill"));
    }
  }
}

function acquireGatedWriterLock(
  home: string,
  command?: string,
): { owner: WriterLockOwner; release(): void } {
  mkdirPrivate(guardedPath(home, "distill"));
  const gate = guardedPath(home, GATE_DIR);
  const gateVerdict = judgeLock(home, GATE_DIR);
  if (gateVerdict.kind === "busy") throw new WriterBusyError(gateVerdict.line);
  if (gateVerdict.kind === "reclaim" && !reclaimDir(gate, gateVerdict.token))
    throw new WriterBusyError(CHANGED);
  mkdirLock(home, gate);
  const gateOwner = ownProcess();
  try {
    atomicOperationWrite(path.join(gate, "owner.json"), gateOwner);
    return acquireCanonicalWriterLock(home, command);
  } finally {
    // Only this process's own gate is removed.
    const current = (() => {
      try {
        return OwnerSchema.parse(JSON.parse(fs.readFileSync(path.join(gate, "owner.json"), "utf8")))
          .token;
      } catch {
        return undefined;
      }
    })();
    if (current === undefined || current === gateOwner.token)
      fs.rmSync(gate, { recursive: true, force: true });
  }
}
/** Runs inside the gate: take a free lock, or reclaim a stale one (see {@link judgeLock}). */
function acquireCanonicalWriterLock(
  home: string,
  command?: string,
): { owner: WriterLockOwner; release(): void } {
  mkdirPrivate(guardedPath(home, "distill"));
  const dir = guardedPath(home, LOCK_DIR);
  const verdict = judgeLock(home, LOCK_DIR);
  if (verdict.kind === "busy") throw new WriterBusyError(verdict.line);
  if (verdict.kind === "reclaim" && !reclaimDir(dir, verdict.token))
    throw new WriterBusyError(CHANGED);
  mkdirLock(home, dir);
  const owner: WriterLockOwner = { ...ownProcess(), ...(command ? { command } : {}) };
  const ownerFile = path.join(dir, "owner.json");
  try {
    atomicOperationWrite(ownerFile, owner);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  // The sign of life another machine name or a leftover check is judged by.
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(ownerFile, now, now);
    } catch {
      // released or removed by hand
    }
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();
  return {
    owner,
    release() {
      clearInterval(heartbeat);
      const current = readCanonicalWriterLock(home);
      if (current.owner?.token === owner.token) fs.rmSync(dir, { recursive: true });
    },
  };
}

/**
 * Durable operation index. Read paths never create directories or migrate state.
 *
 * Opening the store checks the index structure only. Each recorded file is
 * validated when it is first used (`loadInput`, `readResult`,
 * `readAttemptRequest`) and the validated copy is kept for this instance;
 * `verifyAll` checks every recorded file at once for strict previews.
 *
 * Index saves are grouped by operation transition. Dispatch (`queue`, `start`)
 * and the reported producer (`recordResolved`) are held in memory and become
 * durable at the next barrier: the invocation record that precedes every model
 * call, a saved result, a failure, a block, or a commit. Every file the index
 * refers to is written before the index that refers to it. A crash therefore
 * leaves either an earlier index state or a saved result that a later run
 * adopts without a model call.
 */
export class OperationStore {
  readonly home: string;
  private index: OperationIndex;
  /** The in-memory index has changes that are not on disk yet. */
  private dirty = false;
  /** Depth of {@link group} calls; barriers inside a group wait for its end. */
  private holds = 0;
  private readonly inputs = new Map<string, OperationInput>();
  private readonly results = new Map<string, SavedResult>();
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
        for (const attempt of operation.attempts) {
          if (
            attempt.requestPath !==
            `distill/operations/${operation.id}/attempts/${attempt.id}/request.json`
          )
            throw new Error("Invalid attempt request path");
          for (const [index, invocation] of attempt.invocations.entries()) {
            if (
              invocation.index !== index + 1 ||
              invocation.requestPath !==
                `distill/operations/${operation.id}/attempts/${attempt.id}/invocations/${invocation.index}.json`
            )
              throw new Error("Invalid invocation request path");
          }
        }
      }
      for (const operation of this.index.operations) {
        if (operation.dependencyIds.some((id) => !ids.has(id)))
          throw new Error("Dangling operation dependency");
      }
      if (generation && generation !== this.index.generation) {
        // A new normal generation retains history but excludes all older operations.
        for (const operation of this.index.operations) operation.state = "superseded";
        this.index.generation = Id.parse(generation);
        this.dirty = true;
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
  /** Records of one unit, newest last, without copying the whole index. */
  unit(kind: OperationKind, unitId: string): OperationRecord[] {
    return structuredClone(
      this.index.operations.filter(
        (operation) => operation.kind === kind && operation.unitId === unitId,
      ),
    );
  }
  /** One record by id, or undefined. */
  find(id: string): OperationRecord | undefined {
    const value = this.index.operations.find((operation) => operation.id === id);
    return value ? structuredClone(value) : undefined;
  }
  snapshot(): string {
    return fingerprint(this.index);
  }
  /** Read and check every file the index records (strict previews use this). */
  verifyAll(): void {
    for (const operation of this.index.operations) {
      this.loadInput(operation.id);
      for (const attempt of operation.attempts) {
        this.readAttemptRequest(operation.id, attempt.id);
        for (const invocation of attempt.invocations) {
          const request = JSON.parse(
            fs.readFileSync(guardedPath(this.home, invocation.requestPath), "utf8"),
          );
          if (fingerprint(request) !== invocation.requestHash)
            throw new Error(`Corrupt invocation request for operation ${operation.id}`);
        }
      }
      this.readResult(operation.id);
    }
  }
  private record(id: string): OperationRecord {
    const value = this.index.operations.find((operation) => operation.id === id);
    if (!value) throw new Error(`Unknown operation: ${id}`);
    return value;
  }
  /** Write the index now, with every change held in memory. */
  flush(): void {
    if (!this.dirty) return;
    IndexSchema.parse(this.index);
    atomicOperationWrite(guardedPath(this.home, "distill/operations.json"), this.index);
    this.dirty = false;
  }
  /** Record a change; a barrier writes it (and everything held) unless a group is open. */
  private save(barrier = true): void {
    this.dirty = true;
    if (barrier && this.holds === 0) this.flush();
  }
  /**
   * Run synchronous bookkeeping as one index save. A crash inside leaves the
   * state from before the group, which was already a valid state.
   */
  group<T>(work: () => T): T {
    this.holds++;
    try {
      return work();
    } finally {
      this.holds--;
      if (this.holds === 0) this.flush();
    }
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
    this.inputs.set(id, structuredClone(input));
    for (const previous of prior) previous.state = "superseded";
    this.index.operations.push(record);
    // Durable with the next barrier: nothing is spent on a queued operation.
    this.save(false);
    return structuredClone(record);
  }
  loadInput(id: string): OperationInput {
    const record = this.record(id);
    const cached = this.inputs.get(id);
    if (cached) return structuredClone(cached);
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
    this.inputs.set(id, structuredClone(input));
    return input;
  }
  /** The request recorded for one attempt, checked against its recorded hash. */
  readAttemptRequest(id: string, attemptId: string): PreparedRequest {
    const attempt = this.record(id).attempts.find((item) => item.id === attemptId);
    if (!attempt) throw new Error(`Unknown attempt for operation ${id}`);
    const request = RequestSchema.parse(
      JSON.parse(fs.readFileSync(guardedPath(this.home, attempt.requestPath), "utf8")),
    );
    if (fingerprint(request) !== attempt.requestHash)
      throw new Error(`Corrupt attempt request for operation ${id}`);
    return request;
  }
  /**
   * Open a new attempt. Held in memory until the attempt's first invocation
   * record, which is written before the model call it describes.
   */
  start(id: string, settings?: AttemptSettings, request?: PreparedRequest): AttemptRecord {
    const record = this.record(id);
    if (!["queued", "failed", "blocked", "running"].includes(record.state))
      throw new Error(`Cannot dispatch ${record.state} operation ${id}`);
    if (record.state === "running") {
      const prior = record.attempts.at(-1);
      if (!prior || attemptOwnerStatus(prior.owner) !== "dead")
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
    liveAttempts.add(attempt.owner.token);
    this.save(false);
    return structuredClone(attempt);
  }
  /** Barrier: the attempt and this invocation are on disk before the call is made. */
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
  /** The concrete CLI and model that answered; durable with the result or failure. */
  recordResolved(
    id: string,
    attemptId: string,
    index: number,
    resolved: z.infer<typeof Resolved>,
  ): void {
    const attempt = this.record(id).attempts.at(-1);
    const invocation = attempt?.invocations[index - 1];
    if (attempt?.id !== attemptId || !invocation || invocation.index !== index)
      throw new Error("Resolved model does not belong to this invocation");
    invocation.resolved = Resolved.parse(resolved);
    this.save(false);
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
    // The result file is durable before the index says so, and before any publication.
    atomicOperationWrite(guardedPath(this.home, `distill/operations/${id}/result.json`), result);
    this.results.set(id, structuredClone(result));
    liveAttempts.delete(attempt.owner.token);
    record.resultHash = result.valueHash;
    record.state = "result-saved";
    attempt.outcome = "result-saved";
    attempt.endedAt = result.savedAt;
    this.save();
    return structuredClone(result);
  }
  readResult(id: string): SavedResult | null {
    const record = this.record(id);
    const cached = this.results.get(id);
    if (cached) return structuredClone(cached);
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
    this.results.set(id, structuredClone(result));
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
      liveAttempts.delete(attempt.owner.token);
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
  /**
   * Adopt a result whose save was interrupted before the index recorded it.
   * Only a finished or provably dead attempt qualifies; a live writer's result
   * is left alone.
   */
  reconcileResult(id: string): SavedResult | null {
    const record = this.record(id);
    if (record.state === "running") {
      const owner = record.attempts.at(-1)?.owner;
      if (!owner || attemptOwnerStatus(owner) !== "dead") return null;
    }
    const result = this.readResult(id);
    if (result) {
      if (!["committed", "superseded", "resolved-by-fallback", "skipped"].includes(record.state)) {
        record.state = "result-saved";
        record.resultHash = result.valueHash;
        const attempt = record.attempts.find((item) => item.id === result.attemptId);
        if (attempt) {
          attempt.outcome = "result-saved";
          attempt.endedAt ??= result.savedAt;
        }
        this.save();
      }
    }
    return result;
  }
}
