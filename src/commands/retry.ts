import type { ConsentOptions, ConsentResult, DistillPlan } from "../claude/consent.js";
import { confirm as defaultConfirm } from "../claude/consent.js";
import { resolveInputBudget, resolveTimeoutMs, resolveTruncatePolicy } from "../core/budget.js";
import type { AttemptSettings } from "../distill/operations.js";
import { createRetryHandlers, prepareTaskRecoveryInputs } from "../distill/pipeline.js";
import {
  executeRetry,
  prepareRecovery,
  prepareRetry,
  type RetryPlan,
  type RetryStage,
} from "../distill/retry.js";
import { parseRunnerMode, resolveRunner } from "../runners/registry.js";
import type { AgentRunner } from "../runners/types.js";
import { terminalPrivacyReminder } from "../ui/privacy.js";
import { parseClampedInt, resolvePaths } from "./_shared.js";
import type { DistillArgs, DistillDeps } from "./distill.js";

/** Validate before workflow defaults or any runner/export activity. */
export function validateRetryArguments(args: DistillArgs): void {
  const retry = args["retry-failed"] === true;
  const recovery = args["recover-tasks"] !== undefined;
  if (args["retry-stage"] !== undefined && !retry) {
    throw new Error("--retry-stage requires --retry-failed");
  }
  if (!retry && !recovery) return;
  if (retry && recovery)
    throw new Error("--retry-failed and --recover-tasks are mutually exclusive");
  for (const key of [
    "fresh",
    "force",
    "group",
    "project",
    "source",
    "min-substance",
    "cluster-batch-size",
  ] as const) {
    if (args[key] !== undefined && args[key] !== false)
      throw new Error(`--${key} cannot be combined with strict retry or recovery`);
    if (key === "group" && args[key] === false)
      throw new Error("--no-group cannot be combined with strict retry or recovery");
  }
  if (
    args["retry-stage"] &&
    !["all", "digest", "cluster", "author"].includes(args["retry-stage"])
  ) {
    throw new Error("--retry-stage must be all, digest, cluster, or author");
  }
  if (args.runner !== undefined && parseRunnerMode(args.runner) === "auto") {
    throw new Error(
      "Strict retry requires an explicit runner name; omit --runner to inherit recorded settings",
    );
  }
}

/** This route deliberately never enters normal digest/cluster/author orchestration. */
export async function runStrictRetry(args: DistillArgs, deps: DistillDeps): Promise<number> {
  const output = deps.output ?? process.stdout;
  const write = (message = "") => output.write(`${message}\n`);
  const { home } = resolvePaths(args);
  write(terminalPrivacyReminder(output));
  write();
  try {
    validateRetryArguments(args);
    const handlers = createRetryHandlers(home);
    const overrides: Partial<AttemptSettings> = {};
    if (args.model !== undefined) overrides.model = args.model;
    if (args.runner !== undefined) {
      const runner = parseRunnerMode(args.runner);
      if (runner !== "auto") overrides.runner = runner;
    }
    if (args.timeout !== undefined) {
      const timeout = resolveTimeoutMs(args.timeout);
      if (timeout === undefined) throw new Error("--timeout must be a positive number of seconds");
      overrides.timeoutMs = timeout;
      overrides.timeoutExplicit = true;
    }
    if (args["input-budget"] !== undefined)
      overrides.budget = resolveInputBudget(args["input-budget"]);
    if (args.truncate !== undefined) overrides.truncate = resolveTruncatePolicy(args.truncate);
    let plan: RetryPlan;
    let protectedTasks: string[] = [];
    if (args["recover-tasks"] !== undefined) {
      const slugs = args["recover-tasks"].split(",").map((slug) => slug.trim());
      if (slugs.some((slug) => !slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))) {
        throw new Error("--recover-tasks must contain comma-separated task slugs");
      }
      if (new Set(slugs).size !== slugs.length)
        throw new Error("--recover-tasks contains duplicate slugs");
      const operations = prepareTaskRecoveryInputs(home, slugs, overrides);
      const prepared = new Set(operations.map((operation) => operation.unitId));
      protectedTasks = slugs.filter((slug) => !prepared.has(slug));
      plan = prepareRecovery({ home, operations, handlers });
    } else {
      plan = prepareRetry({
        home,
        stage: (args["retry-stage"] ?? "all") as RetryStage,
        overrides,
        clusterModel: args["cluster-model"],
        handlers,
      });
    }
    const consentPlan: DistillPlan = {
      digests: 0,
      cluster: 0,
      authorEstimate: 0,
      retry: {
        mode: plan.mode,
        operations: plan.modelOperations.map(({ operation, settings }) => ({
          kind: operation.kind,
          unitId: operation.unitId,
          ...settings,
        })),
        repairs: plan.localRepairs.map(({ operation }) => operation),
        excluded: [
          ...plan.excluded,
          ...protectedTasks.map((unitId) => ({
            kind: "author",
            unitId,
            reason: "existing or previously successful prompt is protected",
          })),
        ],
        blocked: plan.blocked,
      },
    };
    // Even zero-work previews show dispositions, without prompting or touching a runner.
    const empty = !plan.modelOperations.length && !plan.localRepairs.length;
    const decision = (await (deps.confirm ?? defaultConfirm)(consentPlan, {
      yes: Boolean(args.yes),
      dryRun: Boolean(args["dry-run"]) || empty,
      input: deps.input,
      output,
    } satisfies ConsentOptions)) as ConsentResult;
    if (args["dry-run"]) return 0;
    if (empty) return plan.blocked.length ? 1 : 0;
    if (decision === "declined") {
      write("declined; nothing was invoked.");
      return 2;
    }
    if (decision === "dry-run") return 0;
    const result = await executeRetry(plan, {
      handlers,
      concurrency: parseClampedInt(args.concurrency, { fallback: 3, min: 1 }),
      noBreaker: args.breaker === false,
      output,
      getRunner: async (settings): Promise<AgentRunner> => {
        if (deps.runner) return { name: settings.runner, installHint: "", run: deps.runner };
        return resolveRunner(settings.runner, { scratchBase: `${home}/runner-scratch` });
      },
    });
    write(
      `Completed ${result.succeeded.length} operation(s); repaired ${result.repaired.length} locally; failed ${result.failed.length}; blocked ${result.blocked.length}; not attempted ${result.unattempted.length}.`,
    );
    for (const item of [...result.failed, ...result.blocked])
      write(`  ${item.kind} ${item.unitId}: ${item.reason}`);
    if (result.pendingAdoption.length)
      write(
        "Recovered clustering results saved. Existing task grouping is unchanged; normal distill can adopt matching results.",
      );
    return result.failed.length || result.blocked.length || result.unattempted.length ? 1 : 0;
  } catch (error) {
    write(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
