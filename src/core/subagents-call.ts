import type { Writable } from "node:stream";
import type { ZodType } from "zod";
import type { RunnerFn } from "../distill/pipeline.js";
import { AgentRunnerError, RetryableError, runWithCorrectiveRetry } from "../runners/shared.js";
import type { ResolvedCall } from "../runners/types.js";
import { withSpinner } from "../ui/progress.js";
import { describeProblems } from "./subagent-checks.js";

export type CheckedResult<T> =
  | {
      ok: true;
      value: T;
      corrected: boolean;
      repairs: string[];
      firstProblems: string[];
      resolved?: ResolvedCall;
    }
  | { ok: false; error: string; problems: string[]; raw: unknown };

/** Validate the structure and the stage rules. Only the accepted response supplies provenance. */
export async function runChecked<T>(opts: {
  runner: RunnerFn;
  out?: Writable;
  spinner?: string;
  prompt: string;
  schema: ZodType<T>;
  model?: string;
  timeoutMs: number;
  onResolved?: (call: ResolvedCall) => void;
  check: (value: T) => string[];
  repair?: (value: T) => { value: T; notes: string[] };
}): Promise<CheckedResult<T>> {
  let attempts = 0;
  let raw: unknown = null;
  let problems: string[] = [];
  let firstProblems: string[] = [];
  let repairs: string[] = [];
  let resolved: ResolvedCall | undefined;
  try {
    const value = await runWithCorrectiveRetry(
      opts.prompt,
      opts.schema,
      async (prompt) => {
        attempts++;
        raw = null;
        problems = [];
        resolved = undefined;
        const invoke = () =>
          opts.runner({
            prompt,
            schema: opts.schema,
            model: opts.model,
            timeoutMs: opts.timeoutMs,
            onResolved: (call) => {
              resolved = call;
            },
          });
        raw =
          opts.out && opts.spinner
            ? await withSpinner(
                opts.out,
                attempts > 1 ? `${opts.spinner} (correction)` : opts.spinner,
                invoke,
              )
            : await invoke();
        const parsed = opts.schema.safeParse(raw);
        if (!parsed.success) {
          problems = [parsed.error.message];
        } else {
          const repaired = opts.repair?.(parsed.data);
          const data = repaired ? repaired.value : parsed.data;
          repairs = repaired?.notes ?? [];
          problems = opts.check(data);
          if (problems.length === 0) return data;
        }
        if (attempts === 1) firstProblems = problems;
        throw new RetryableError(problems.join("; "));
      },
      // The person reads what went wrong in plain words; the exact messages
      // stay in `problems` for the saved failure record.
      () =>
        new AgentRunnerError(
          "validation",
          `the answer failed its checks twice: ${describeProblems(problems)}`,
        ),
    );
    if (resolved) opts.onResolved?.(resolved);
    return { ok: true, value, corrected: attempts > 1, repairs, firstProblems, resolved };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, problems: problems.length ? problems : [message], raw };
  }
}

/** Bound in-flight calls and preserve input order, including when workers finish out of order. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  call: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const entries = items.entries();
  let stopped = false;
  async function worker(): Promise<void> {
    for (const [index, item] of entries) {
      if (stopped) return;
      try {
        results[index] = await call(item, index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  }
  const slots = Math.min(items.length, Math.max(1, Math.floor(limit) || 1));
  const joined = await Promise.allSettled(Array.from({ length: slots }, worker));
  for (const result of joined) if (result.status === "rejected") throw result.reason;
  return results;
}
