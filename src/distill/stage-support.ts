import type { Writable } from "node:stream";
import { DEFAULT_CONCURRENCY, DEFAULT_INPUT_BUDGET, type TruncatePolicy } from "../core/budget.js";
import { contentFingerprint, fingerprint } from "../core/fingerprint.js";
import { isPlanLabel } from "../core/model-plan.js";
import { runClaude } from "../runners/claude.js";
import { SYSTEMIC_FAILURE_STREAK } from "../runners/failures.js";
import { DEFAULT_TIMEOUT_MS } from "../runners/shared.js";
import type { ResolvedCall, RunnerName, RunOptions } from "../runners/types.js";
import { glyph } from "../ui/mode.js";
import { withSpinner } from "../ui/progress.js";
import {
  type AttemptSettings,
  checkSourceGuards,
  type OperationRecord,
  type OperationStore,
  type PreparedRequest,
} from "./operations.js";
import type { RetryHandler } from "./retry.js";
import { toJsonSchema } from "./schemas.js";
import type { SavedSessionRead, StageProgressSink } from "./stage-events.js";

export type RunnerFn = <T>(opts: RunOptions<T>) => Promise<T>;
export interface StageFailure {
  export: string;
  error: string;
}
export const stageRunner = (runner?: RunnerFn): RunnerFn => runner ?? runClaude;
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+){1,4}$/;
export const CLUSTER_TIMEOUT_PER_DIGEST_MS = 5_000;

export function operationSettings(
  opts: {
    runnerName?: RunnerName;
    identityRunner?: RunnerName | null;
    model?: string;
    timeoutMs?: number;
    budget?: number;
    truncate?: TruncatePolicy;
  },
  timeoutUnits = 0,
): AttemptSettings {
  return {
    runner: opts.runnerName ?? opts.identityRunner ?? "claude",
    ...(opts.identityRunner === null ? { automatic: true } : {}),
    model: opts.model ?? null,
    timeoutExplicit: opts.timeoutMs !== undefined,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS + CLUSTER_TIMEOUT_PER_DIGEST_MS * timeoutUnits,
    budget: opts.budget ?? DEFAULT_INPUT_BUDGET,
    truncate: opts.truncate ?? "never",
  };
}

export function sourceReference(exportName: string, content: string) {
  return {
    path: `exports/${exportName}`,
    hash: contentFingerprint(content),
    length: content.length,
  };
}

function settingsIdentity(settings: AttemptSettings) {
  return {
    ...settings,
    runner: settings.automatic ? null : settings.runner,
    automatic: !!settings.automatic,
  };
}

/**
 * A saved inference can be adopted across CLI switches only for an automatic
 * selection. Reuse needs the same prompt version, schema, logical input,
 * settings identity, and exact prompt text. A result whose save was
 * interrupted (index still says running, owner gone) is adopted too, so a
 * crash after the result reached the disk never buys the call again.
 */
export function reusableOperation(
  store: OperationStore,
  kind: OperationRecord["kind"],
  unitId: string,
  logicalInput: unknown,
  settings: AttemptSettings,
  contract: { promptVersion: number; schema: unknown; prompt: string },
): OperationRecord | undefined {
  const schemaHash = fingerprint(contract.schema);
  const wanted = fingerprint(logicalInput);
  const identity = fingerprint(settingsIdentity(settings));
  const match = store.unit(kind, unitId).find((record) => {
    if (
      !["result-saved", "running", "failed"].includes(record.state) ||
      record.promptVersion !== contract.promptVersion ||
      record.schemaHash !== schemaHash
    )
      return false;
    const last = record.attempts.at(-1);
    if (
      !last ||
      fingerprint(store.loadInput(record.id).logicalInput) !== wanted ||
      fingerprint(settingsIdentity(last.settings)) !== identity ||
      store.readAttemptRequest(record.id, last.id).prompt !== contract.prompt
    )
      return false;
    return record.state === "result-saved"
      ? !!store.readResult(record.id)
      : !!store.reconcileResult(record.id);
  });
  return match ? store.find(match.id) : undefined;
}

export function defaultResolution(settings: AttemptSettings): ResolvedCall {
  return {
    runner: settings.runner,
    ...(settings.model && !isPlanLabel(settings.model) ? { model: settings.model } : {}),
  };
}

/** Both normal and strict calls save validated inference before attempting publication. */
export async function executeOperation(o: {
  store: OperationStore;
  operation: OperationRecord;
  handler: RetryHandler;
  settings: AttemptSettings;
  request: PreparedRequest;
  run: RunnerFn;
  publish: boolean;
  strict?: boolean;
}): Promise<unknown> {
  const { store, operation, handler, settings, request } = o;
  const input = store.loadInput(operation.id);
  const guard = () => {
    checkSourceGuards(store.home, input.sources);
    if (o.strict) handler.guard?.(input, operation, store);
  };
  guard();
  const saved = store.readResult(operation.id);
  let value: unknown;
  if (saved) {
    value = saved.value;
    handler.validate(value, input);
  } else {
    // A placeholder request (a blocked unit, a recovery not yet prepared) is never sent.
    if (!request.prompt.trim())
      throw new Error(
        "Operation has no prepared request. Run npx human-hindsight reflect to prepare it.",
      );
    // A normal attempt records the model request; strict retry records its whole prepared request.
    const attempt = store.start(
      operation.id,
      settings,
      o.strict ? request : { ...input.request, prompt: request.prompt },
    );
    try {
      value = await handler.run(request, settings, input, async (args) => {
        const invocation = store.recordInvocation(operation.id, attempt.id, {
          prompt: args.prompt,
          schema: toJsonSchema(args.schema),
          model: settings.model,
          timeoutMs: settings.timeoutMs,
        });
        let actual = defaultResolution(settings);
        const result = await o.run({
          ...args,
          model: settings.model ?? undefined,
          timeoutMs: args.timeoutMs ?? settings.timeoutMs,
          onResolved(resolved) {
            actual = resolved;
          },
        });
        store.recordResolved(operation.id, attempt.id, invocation.index, actual);
        args.onResolved?.(actual);
        return result;
      });
      handler.validate(value, input, o.strict ? "ledger" : "runner");
      store.saveResult(operation.id, attempt.id, value);
    } catch (error) {
      store.fail(operation.id, error);
      throw error;
    }
  }
  if (o.publish) {
    guard();
    const receipt = handler.publish(value, input, operation);
    store.commit(operation.id, receipt);
  }
  return value;
}

/** A single breaker implementation serves digest, author and strict retry. */
export class FailureBreaker {
  private previous = "";
  private count = 0;
  reason?: string;
  constructor(private readonly enabled: boolean) {}
  success() {
    this.count = 0;
    this.previous = "";
  }
  /**
   * Count one failure. Only an unbroken run of byte-identical messages trips
   * the breaker. Transient errors count like any other: the runner has already
   * retried them, so a streak of them is an outage worth stopping for.
   */
  failure(error: unknown) {
    if (!this.enabled || this.reason) return;
    const message = error instanceof Error ? error.message : String(error);
    this.count = message === this.previous ? this.count + 1 : 1;
    this.previous = message;
    if (this.count >= SYSTEMIC_FAILURE_STREAK)
      this.reason = `${this.count} consecutive calls failed with the identical error: ${truncate(message, 160)}`;
  }
}

export function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}${glyph("…", "...")}` : text;
}

export function stageReporter(
  opts: { progress?: StageProgressSink; output?: Writable },
  concurrency: number,
) {
  const out = opts.output ?? process.stdout;
  const sink = opts.progress;
  const write = (line: string) => {
    out.write(`${line}\n`);
  };
  return {
    start(total: number) {
      sink?.start(total, concurrency);
    },
    note(line: string) {
      if (sink) sink.note(line);
      else write(line);
    },
    /** Per-call detail: the progress display shows it only under `--verbose`. */
    detail(line: string) {
      sink?.detail?.(line);
    },
    running(id: string, label: string, project?: string) {
      sink?.running?.(id, label, project);
    },
    read(id: string, status: "done" | "skipped", read: SavedSessionRead, line: string) {
      if (sink) sink.item({ id, status, read, line });
      else write(line);
    },
    /** `brief` is the sink's line: the sink names the status itself. */
    item(
      id: string,
      status: "done" | "skipped" | "failed" | "blocked",
      line: string,
      announce = true,
      brief = line,
    ) {
      if (sink) sink.item({ id, status, line: brief });
      else if (announce) write(line);
    },
    until<T>(label: string, call: () => Promise<T>) {
      return sink || concurrency !== 1 ? call() : withSpinner(out, label, call);
    },
    end() {
      sink?.end();
    },
  };
}

/** Stop drawing new work when the breaker opens, and join every in-flight call. */
export async function runItems<T>(
  items: readonly T[],
  concurrency: number | undefined,
  breaker: FailureBreaker,
  work: (item: T, index: number) => Promise<void>,
): Promise<T[]> {
  let next = 0;
  const pull = async () => {
    while (next < items.length && !breaker.reason) {
      const index = next++;
      await work(items[index] as T, index);
    }
  };
  const count = Math.min(items.length, Math.max(1, Math.floor(concurrency ?? DEFAULT_CONCURRENCY)));
  const settled = await Promise.allSettled(Array.from({ length: count }, pull));
  for (const worker of settled) if (worker.status === "rejected") throw worker.reason;
  return items.slice(next);
}
