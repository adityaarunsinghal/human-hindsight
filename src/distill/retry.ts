import fs from "node:fs";
import type { Writable } from "node:stream";
import { AUTHOR_PROMPT_VERSION } from "../claude/prompts/author.js";
import { CLUSTER_PROMPT_VERSION } from "../claude/prompts/cluster.js";
import { DIGEST_PROMPT_VERSION } from "../claude/prompts/digest.js";
import {
  AuthorSchema,
  ClusterMergeSchema,
  ClusterSchema,
  DigestResponseSchema,
  toJsonSchema,
} from "../claude/schemas.js";
import { contentFingerprint, fingerprint } from "../core/fingerprint.js";
import { DEFAULT_TIMEOUT_MS } from "../runners/shared.js";
import type { AgentRunner, RunOptions } from "../runners/types.js";
import {
  type AttemptSettings,
  AttemptSettingsSchema,
  acquireWriterLock,
  checkSourceGuards,
  guardedPath,
  type OperationInput,
  type OperationKind,
  type OperationRecord,
  OperationStore,
  ownerStatus,
  type PreparedRequest,
  type PublicationReceipt,
  type QueueOperation,
  readWriterLock,
} from "./operations.js";

export type RetryStage = "all" | "digest" | "cluster" | "author";
export interface RetryHandler {
  guard?(input: OperationInput, operation: OperationRecord): void;
  prepare(
    input: OperationInput,
    settings: AttemptSettings,
    operation: OperationRecord,
  ): PreparedRequest;
  validate(value: unknown, input: OperationInput): void;
  run(
    request: PreparedRequest,
    settings: AttemptSettings,
    input: OperationInput,
    invoke: (options: RunOptions<unknown>) => Promise<unknown>,
  ): Promise<unknown>;
  publish(
    value: unknown,
    input: OperationInput,
    operation: OperationRecord,
  ): PublicationReceipt | undefined;
}
export type RetryHandlers = Partial<Record<OperationKind, RetryHandler>>;
export interface PreparedOperation {
  operation: OperationRecord;
  input: OperationInput;
  settings: AttemptSettings;
  request: PreparedRequest;
}
export interface OperationDisposition {
  id: string;
  kind: OperationKind;
  unitId: string;
  reason: string;
}
export interface RetryPlan {
  mode: "retry-failed" | "recover-tasks";
  home: string;
  generation: string;
  fingerprint: string;
  modelOperations: PreparedOperation[];
  localRepairs: PreparedOperation[];
  excluded: OperationDisposition[];
  blocked: OperationDisposition[];
}
interface PlanContext {
  snapshot: string;
  files: string[];
  recovery?: QueueOperation[];
}
const contexts = new WeakMap<RetryPlan, PlanContext>();
const SUPPORTED = {
  digest: { version: DIGEST_PROMPT_VERSION, schema: DigestResponseSchema },
  author: { version: AUTHOR_PROMPT_VERSION, schema: AuthorSchema },
  "cluster-window": { version: CLUSTER_PROMPT_VERSION, schema: ClusterSchema },
  "cluster-merge": { version: CLUSTER_PROMPT_VERSION, schema: ClusterMergeSchema },
};
function disposition(operation: OperationRecord, reason: string): OperationDisposition {
  return { id: operation.id, kind: operation.kind, unitId: operation.unitId, reason };
}
function matchesStage(kind: OperationKind, stage: RetryStage): boolean {
  return stage === "all" || kind === stage || (stage === "cluster" && kind.startsWith("cluster-"));
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function settingsFor(
  operation: OperationRecord,
  input: OperationInput,
  overrides: Partial<AttemptSettings>,
): AttemptSettings {
  const previous = operation.attempts.at(-1)?.settings ?? input.settings;
  const definedOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  );
  const settings = { ...previous, ...definedOverrides };
  if (overrides.timeoutMs !== undefined)
    settings.timeoutExplicit = overrides.timeoutExplicit ?? true;
  if (!settings.timeoutExplicit) {
    const units = typeof input.request.timeoutUnits === "number" ? input.request.timeoutUnits : 0;
    settings.timeoutMs =
      DEFAULT_TIMEOUT_MS + (operation.kind.startsWith("cluster-") ? 5_000 * units : 0);
  }
  return AttemptSettingsSchema.parse(settings);
}
function compatibility(input: OperationInput): void {
  const supported = SUPPORTED[input.kind];
  if (
    input.promptVersion !== supported.version ||
    input.schemaHash !== fingerprint(toJsonSchema(supported.schema))
  )
    throw new Error(
      "Recorded prompt/schema version is unsupported; use normal distill to prepare new work",
    );
}
function filesFor(items: PreparedOperation[]): string[] {
  return [
    ...new Set([
      "distill/tasks.json",
      "distill/digests.json",
      ...items.flatMap(({ input }) => [
        ...input.sources.map((source) => source.path),
        ...Object.entries(input.publication ?? {})
          .filter(([key, value]) => /Path$/.test(key) && typeof value === "string")
          .map(([, value]) => value as string),
      ]),
    ]),
  ].sort();
}
function publishedGrouping(
  home: string,
  generation: string,
): { operationIds: string[]; fallbackId?: string } | null {
  const file = guardedPath(home, "distill/tasks.json");
  if (!fs.existsSync(file)) return null;
  const checkpoint = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  if (checkpoint.generation !== generation || typeof checkpoint.grouping_hash !== "string")
    return null;
  if (checkpoint.grouping_hash !== fingerprint({ tasks: checkpoint.tasks, misc: checkpoint.misc }))
    throw new Error("Saved grouping publication hash is corrupt");
  return {
    operationIds: Array.isArray(checkpoint.operation_ids)
      ? checkpoint.operation_ids.filter((id): id is string => typeof id === "string")
      : [],
    fallbackId:
      typeof checkpoint.fallback_merge_id === "string" ? checkpoint.fallback_merge_id : undefined,
  };
}
function fileSnapshot(home: string, files: string[]): unknown[] {
  return files.map((file) => {
    try {
      return [file, contentFingerprint(fs.readFileSync(guardedPath(home, file), "utf8"))];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [file, null];
      throw error;
    }
  });
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function finishPlan(plan: RetryPlan, context: PlanContext): RetryPlan {
  plan.fingerprint = fingerprint({
    snapshot: context.snapshot,
    files: fileSnapshot(plan.home, context.files),
    plan,
  });
  contexts.set(plan, context);
  return freeze(plan);
}
export interface PrepareRetryOptions {
  home: string;
  stage?: RetryStage;
  overrides?: Partial<AttemptSettings>;
  handlers: RetryHandlers;
}

/** Read-only strict selection. It never discovers work from a new corpus scan. */
export function prepareRetry(options: PrepareRetryOptions): RetryPlan {
  const stage = options.stage ?? "all";
  if (!["all", "digest", "cluster", "author"].includes(stage))
    throw new Error(`Unknown retry stage: ${stage}`);
  const lock = readWriterLock(options.home);
  if (lock.status === "alive" || lock.status === "unknown")
    throw new Error("Another distill writer is active or its ownership cannot be verified");
  const store = new OperationStore(options.home);
  const plan: RetryPlan = {
    mode: "retry-failed",
    home: options.home,
    generation: store.generation,
    fingerprint: "",
    modelOperations: [],
    localRepairs: [],
    excluded: [],
    blocked: [],
  };
  const published = publishedGrouping(options.home, store.generation);
  for (const operation of store.list()) {
    if (!matchesStage(operation.kind, stage)) {
      plan.excluded.push(disposition(operation, "outside selected stage"));
      continue;
    }
    if (["committed", "skipped", "superseded", "resolved-by-fallback"].includes(operation.state)) {
      plan.excluded.push(disposition(operation, operation.state));
      continue;
    }
    if (
      operation.kind.startsWith("cluster-") &&
      (published?.fallbackId === operation.id || published?.operationIds.includes(operation.id))
    ) {
      plan.excluded.push(
        disposition(
          operation,
          published.fallbackId === operation.id
            ? "resolved by published fallback grouping"
            : "already adopted in saved grouping",
        ),
      );
      continue;
    }
    if (operation.state === "queued") {
      plan.excluded.push(disposition(operation, "not attempted"));
      continue;
    }
    if (operation.state === "running") {
      const attempt = operation.attempts.at(-1);
      if (!attempt || ownerStatus(attempt.owner) !== "dead")
        throw new Error(`Operation ${operation.id} has a live or unverifiable owner`);
    }
    const input = store.loadInput(operation.id);
    try {
      compatibility(input);
      checkSourceGuards(options.home, input.sources);
      const handler = options.handlers[operation.kind];
      if (!handler) throw new Error(`No handler for ${operation.kind}`);
      handler.guard?.(input, operation);
      const settings = settingsFor(operation, input, options.overrides ?? {});
      // Results are checked before request preparation: a saved result never
      // needs another model call because the new budget would block preparation.
      const result = store.readResult(operation.id);
      if (result) {
        handler.validate(result.value, input);
        if (operation.kind.startsWith("cluster-")) {
          plan.excluded.push(
            disposition(operation, "validated result saved; adoption pending normal distill"),
          );
        } else {
          plan.localRepairs.push({ operation, input, settings, request: input.request });
        }
      } else {
        const request = handler.prepare(input, settings, operation);
        plan.modelOperations.push({ operation, input, settings, request });
      }
    } catch (error) {
      plan.blocked.push(disposition(operation, errorMessage(error)));
    }
  }
  const files = filesFor([...plan.modelOperations, ...plan.localRepairs]);
  return finishPlan(plan, { snapshot: store.snapshot(), files });
}

export interface PrepareRecoveryOptions {
  home: string;
  operations: QueueOperation[];
  handlers: RetryHandlers;
  generation?: string;
}
/** Named legacy recovery inputs are prepared by the pipeline without writes. */
export function prepareRecovery(options: PrepareRecoveryOptions): RetryPlan {
  const savedGeneration: unknown =
    options.generation ??
    options.operations[0]?.generation ??
    JSON.parse(fs.readFileSync(guardedPath(options.home, "distill/tasks.json"), "utf8")).generation;
  if (typeof savedGeneration !== "string" || !savedGeneration)
    throw new Error("Saved recovery generation is missing");
  const generation = savedGeneration;
  if (
    options.operations.some(
      (operation) => operation.kind !== "author" || operation.generation !== generation,
    )
  )
    throw new Error("Recovery requires author operations from one saved generation");
  if (
    new Set(options.operations.map((operation) => operation.unitId)).size !==
    options.operations.length
  )
    throw new Error("Duplicate recovery task");
  const lock = readWriterLock(options.home);
  if (lock.status === "alive" || lock.status === "unknown")
    throw new Error("Another distill writer is active or its ownership cannot be verified");
  const ledgerPath = guardedPath(options.home, "distill/operations.json");
  const existing = fs.existsSync(ledgerPath) ? new OperationStore(options.home) : null;
  if (existing && existing.generation !== generation)
    throw new Error("Saved task generation differs from the active operation ledger");
  const newOperations: QueueOperation[] = [];
  const plan: RetryPlan = {
    mode: "recover-tasks",
    home: options.home,
    generation,
    fingerprint: "",
    modelOperations: [],
    localRepairs: [],
    excluded: [],
    blocked: [],
  };
  for (const [index, optionsInput] of options.operations.entries()) {
    const id = `recovery-${index}`;
    const schemaHash = fingerprint(optionsInput.schema);
    const logicalInputHash = fingerprint({
      kind: optionsInput.kind,
      logicalInput: optionsInput.logicalInput,
      sources: optionsInput.sources,
      promptVersion: optionsInput.promptVersion,
      schema: optionsInput.schema,
    });
    let input: OperationInput = {
      version: 1,
      operationId: id,
      generation,
      kind: "author",
      unitId: optionsInput.unitId,
      logicalInputHash,
      promptVersion: optionsInput.promptVersion,
      schemaHash,
      schema: optionsInput.schema,
      logicalInput: optionsInput.logicalInput,
      sources: optionsInput.sources,
      settings: optionsInput.settings,
      request: optionsInput.request,
      publication: optionsInput.publication,
    };
    let operation: OperationRecord = {
      id,
      revision: 1,
      generation,
      runId: optionsInput.runId,
      kind: "author",
      unitId: optionsInput.unitId,
      state: "queued",
      source: "explicit-task-recovery",
      logicalInputHash,
      promptVersion: input.promptVersion,
      schemaHash,
      dependencyIds: [],
      inputPath: `distill/operations/${id}/input.json`,
      inputHash: fingerprint(input),
      attempts: [],
    };
    const prior = existing
      ?.list()
      .find(
        (record) =>
          record.kind === "author" &&
          record.unitId === optionsInput.unitId &&
          record.state !== "superseded",
      );
    if (prior && ["committed", "skipped", "resolved-by-fallback"].includes(prior.state)) {
      plan.excluded.push(disposition(prior, prior.state));
      continue;
    }
    if (prior && existing && prior.logicalInputHash === logicalInputHash) {
      operation = prior;
      input = existing.loadInput(prior.id);
      if (prior.state === "running") {
        const last = prior.attempts.at(-1);
        if (!last || ownerStatus(last.owner) !== "dead")
          throw new Error(`Operation ${prior.id} has a live or unverifiable owner`);
      }
    }
    const handler = options.handlers.author;
    if (!handler) throw new Error("No author recovery handler");
    try {
      compatibility(input);
      checkSourceGuards(options.home, input.sources);
      handler.guard?.(input, operation);
      const settings = settingsFor(operation, input, optionsInput.settings);
      const saved =
        existing && prior?.id === operation.id ? existing.readResult(operation.id) : null;
      if (saved) {
        handler.validate(saved.value, input);
        plan.localRepairs.push({ operation, input, settings, request: input.request });
      } else {
        const request = handler.prepare(input, settings, operation);
        plan.modelOperations.push({ operation, input, settings, request });
        if (operation.id === id) newOperations.push(optionsInput);
      }
    } catch (error) {
      plan.blocked.push(disposition(operation, errorMessage(error)));
    }
  }
  return finishPlan(plan, {
    snapshot: existing?.snapshot() ?? "missing",
    files: filesFor([...plan.modelOperations, ...plan.localRepairs]),
    recovery: newOperations,
  });
}
export interface ExecuteRetryOptions {
  handlers: RetryHandlers;
  getRunner(settings: AttemptSettings): AgentRunner | Promise<AgentRunner>;
  concurrency?: number;
  noBreaker?: boolean;
  output?: Writable;
}
export interface RetryExecutionResult {
  succeeded: string[];
  repaired: string[];
  failed: OperationDisposition[];
  blocked: OperationDisposition[];
  unattempted: string[];
  pendingAdoption: string[];
}

/** Execute the exact consented selection under a data-home writer lock. */
export async function executeRetry(
  plan: RetryPlan,
  options: ExecuteRetryOptions,
): Promise<RetryExecutionResult> {
  const context = contexts.get(plan);
  if (!context) throw new Error("Retry plan must be the original prepared plan");
  const lock = acquireWriterLock(plan.home);
  const runners = new Map<string, Promise<AgentRunner>>();
  const result: RetryExecutionResult = {
    succeeded: [],
    repaired: [],
    failed: [],
    blocked: [...plan.blocked],
    unattempted: [],
    pendingAdoption: [],
  };
  try {
    const ledgerPath = guardedPath(plan.home, "distill/operations.json");
    const current = fs.existsSync(ledgerPath) ? new OperationStore(plan.home) : null;
    const snapshot = current?.snapshot() ?? "missing";
    const emptyFingerprintPlan = { ...plan, fingerprint: "" };
    const currentFingerprint = fingerprint({
      snapshot,
      files: fileSnapshot(plan.home, context.files),
      plan: emptyFingerprintPlan,
    });
    if (currentFingerprint !== plan.fingerprint)
      throw new Error("Retry plan changed since preview; run a new preview before execution");
    const store = current ?? new OperationStore(plan.home, plan.generation);
    const prepared = new Map(plan.modelOperations.map((item) => [item.operation.id, item]));
    if (context.recovery) {
      for (const input of context.recovery) {
        const old = plan.modelOperations.find((item) => item.operation.unitId === input.unitId);
        if (!old) continue;
        const operation = store.queue({ ...input, source: "explicit-task-recovery" });
        prepared.set(old.operation.id, { ...old, operation, input: store.loadInput(operation.id) });
      }
    }
    for (const item of plan.localRepairs) {
      const handler = options.handlers[item.operation.kind];
      if (!handler) throw new Error(`No handler for ${item.operation.kind}`);
      try {
        checkSourceGuards(plan.home, item.input.sources);
        handler.guard?.(item.input, item.operation);
        const saved = store.reconcileResult(item.operation.id);
        if (!saved) throw new Error("Saved result disappeared after preview");
        handler.validate(saved.value, item.input);
        const receipt = handler.publish(saved.value, item.input, item.operation);
        store.commit(item.operation.id, receipt ?? undefined);
        result.repaired.push(item.operation.id);
      } catch (error) {
        store.fail(item.operation.id, error);
        result.failed.push(disposition(item.operation, errorMessage(error)));
      }
    }
    let next = 0;
    let failedStreak = 0;
    let priorFailure = "";
    let stopped = false;
    const runnerFor = (settings: AttemptSettings): Promise<AgentRunner> => {
      const key = settings.runner;
      let runner = runners.get(key);
      if (!runner) {
        runner = Promise.resolve(options.getRunner(settings)).then(async (adapter) => {
          await adapter.preflight?.();
          return adapter;
        });
        runners.set(key, runner);
      }
      return runner;
    };
    // Construct and preflight only selected adapters, before dispatching work.
    await Promise.all(
      [
        ...new Map(
          plan.modelOperations.map((item) => [item.settings.runner, item.settings]),
        ).values(),
      ].map(runnerFor),
    );
    const work = async (): Promise<void> => {
      while (!stopped && next < plan.modelOperations.length) {
        const original = plan.modelOperations[next++];
        if (!original) continue;
        const item = prepared.get(original.operation.id) as PreparedOperation;
        const handler = options.handlers[item.operation.kind];
        if (!handler) throw new Error(`No handler for ${item.operation.kind}`);
        let dispatched = false;
        try {
          checkSourceGuards(plan.home, item.input.sources);
          handler.guard?.(item.input, item.operation);
          const runner = await runnerFor(item.settings);
          const attempt = store.start(item.operation.id, item.settings, item.request);
          dispatched = true;
          options.output?.write(`  ${item.operation.kind} ${item.operation.unitId} — retrying\n`);
          const value = await handler.run(item.request, item.settings, item.input, (args) => {
            store.recordInvocation(item.operation.id, attempt.id, {
              prompt: args.prompt,
              schema: toJsonSchema(args.schema),
              model: item.settings.model,
              timeoutMs: item.settings.timeoutMs,
            });
            return runner.run({
              ...args,
              model: item.settings.model ?? undefined,
              timeoutMs: item.settings.timeoutMs,
            });
          });
          handler.validate(value, item.input);
          store.saveResult(item.operation.id, attempt.id, value);
          checkSourceGuards(plan.home, item.input.sources);
          handler.guard?.(item.input, item.operation);
          if (item.operation.kind.startsWith("cluster-"))
            result.pendingAdoption.push(item.operation.id);
          else {
            const receipt = handler.publish(value, item.input, item.operation);
            store.commit(item.operation.id, receipt ?? undefined);
          }
          result.succeeded.push(item.operation.id);
          failedStreak = 0;
          priorFailure = "";
        } catch (error) {
          const message = errorMessage(error);
          if (dispatched) store.fail(item.operation.id, error);
          result.failed.push(disposition(item.operation, message));
          failedStreak = message === priorFailure ? failedStreak + 1 : 1;
          priorFailure = message;
          if (!options.noBreaker && failedStreak >= 5) stopped = true;
        }
      }
    };
    const concurrency = Math.max(1, Math.floor(options.concurrency ?? 3));
    await Promise.all(
      Array.from({ length: Math.min(concurrency, plan.modelOperations.length) }, work),
    );
    result.unattempted = plan.modelOperations.slice(next).map((item) => item.operation.id);
    const order = new Map(
      [...plan.localRepairs, ...plan.modelOperations].map((item, index) => [
        item.operation.id,
        index,
      ]),
    );
    const sort = (a: string, b: string) => (order.get(a) ?? 0) - (order.get(b) ?? 0);
    result.succeeded.sort(sort);
    result.repaired.sort(sort);
    result.failed.sort((a, b) => sort(a.id, b.id));
    return result;
  } finally {
    await Promise.allSettled(
      [...runners.values()].map(async (runner) => (await runner).finalize?.()),
    );
    lock.release();
  }
}
