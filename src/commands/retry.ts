import { resolveInputBudget, resolveTimeoutMs, resolveTruncatePolicy } from "../core/budget.js";
import { isPlanLabel, parseQuality, planLabel } from "../core/model-plan.js";
import { openRunSession, type RunSession, type StageKey } from "../core/run-session.js";
import type { ConsentOptions, DistillPlan } from "../distill/consent.js";
import { confirmPlan } from "../distill/consent.js";
import type { AttemptSettings } from "../distill/operations.js";
import { createRetryHandlers, prepareTaskRecoveryInputs } from "../distill/pipeline.js";
import {
  executeRetry,
  prepareRecovery,
  prepareRetry,
  type RetryPlan,
  type RetryStage,
} from "../distill/retry.js";
import { guardRun, mutableOutput, pinSourcesFrom, type RunGuard } from "../distill/run-guard.js";
import { startStageProgress } from "../distill/stage-events.js";
import { parseRunnerMode } from "../runners/registry.js";
import type { AgentRunner } from "../runners/types.js";
import { terminalPrivacyReminder } from "../ui/privacy.js";
import { counted } from "../ui/style.js";
import { parseConcurrency, resolvePaths } from "./_shared.js";
import type { DistillArgs, DistillDeps } from "./distill.js";
import { nextCommandText, printedHome, shellWord } from "./next.js";

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
    "recent",
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

/** Retain recorded plan quality and overrides. A plan label is never sent to a CLI as a model. */
function sessionKey(settings: AttemptSettings): string {
  const model = settings.model ?? undefined;
  const selection = isPlanLabel(model) ? model.split("/")[0] : model;
  return JSON.stringify([
    settings.automatic ? "auto" : settings.runner,
    selection ?? null,
    isPlanLabel(model),
  ]);
}

function resumeRetryCommand(home: string, args: DistillArgs): string {
  const parts = ["npx", "human-hindsight", "reflect", ...printedHome(home)];
  if (args["recover-tasks"] !== undefined) parts.push(`--recover-tasks=${args["recover-tasks"]}`);
  else parts.push("--retry-failed", `--retry-stage=${args["retry-stage"] ?? "all"}`);
  for (const key of [
    "runner",
    "quality",
    "model",
    "cluster-model",
    "author-model",
    "input-budget",
    "truncate",
    "concurrency",
    "timeout",
  ] as const) {
    if (args[key]) parts.push(`--${key}=${args[key]}`);
  }
  if (args.breaker === false) parts.push("--no-breaker");
  return parts.map(shellWord).join(" ");
}

/** The outcome of a retry in one line: what finished, what did not; zero counts are left out. */
export function retrySummary(result: {
  succeeded: unknown[];
  repaired: unknown[];
  failed: unknown[];
  blocked: unknown[];
  unattempted: unknown[];
}): string {
  const parts = [
    `${counted(result.succeeded.length, "saved call")} made again`,
    result.repaired.length
      ? `${counted(result.repaired.length, "result")} finished from saved answers`
      : "",
    result.failed.length ? `${result.failed.length.toLocaleString("en-US")} failed` : "",
    result.blocked.length ? `${result.blocked.length.toLocaleString("en-US")} could not run` : "",
    result.unattempted.length
      ? `${result.unattempted.length.toLocaleString("en-US")} not started after repeated failures`
      : "",
  ].filter(Boolean);
  return `${parts.join("; ")}.`;
}

/** This route deliberately never enters normal digest/cluster/author orchestration. */
export async function runStrictRetry(args: DistillArgs, deps: DistillDeps): Promise<number> {
  // After Ctrl-C has printed its line, the stopping run prints nothing more.
  const quiet = mutableOutput(deps.output ?? process.stdout);
  const output = quiet.output;
  const write = (message = "") => output.write(`${message}\n`);
  const { home } = resolvePaths(args);
  const sessions = new Map<string, RunSession>();
  let guard: RunGuard | undefined;
  write(terminalPrivacyReminder(output));
  write();
  try {
    validateRetryArguments(args);
    const quality = args.quality === undefined ? undefined : parseQuality(args.quality);
    for (const key of ["model", "cluster-model", "author-model"] as const) {
      const model = args[key]?.trim();
      if (model !== undefined && (!model || isPlanLabel(model.toLowerCase())))
        throw new Error(`Use a concrete model with --${key}, or choose a plan with --quality.`);
    }
    const explicitPin = Boolean(
      args.runner || args.model || args["cluster-model"] || args["author-model"],
    );
    const handlers = createRetryHandlers(home);
    const overrides: Partial<AttemptSettings> = {};
    if (args.model !== undefined) overrides.model = args.model.trim();
    if (explicitPin) overrides.automatic = false;
    if (args.runner !== undefined) {
      const runner = parseRunnerMode(args.runner);
      if (runner !== "auto") overrides.runner = runner;
    }
    if (args.timeout !== undefined) {
      overrides.timeoutMs = resolveTimeoutMs(args.timeout);
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
        throw new Error("--recover-tasks must contain comma-separated task names");
      }
      if (new Set(slugs).size !== slugs.length)
        throw new Error("--recover-tasks contains a name twice");
      const recoveryModel =
        args["author-model"]?.trim() ??
        overrides.model ??
        (quality ? planLabel(quality, "major") : undefined);
      const operations = prepareTaskRecoveryInputs(
        home,
        slugs,
        recoveryModel === undefined ? overrides : { ...overrides, model: recoveryModel },
      );
      const prepared = new Set(operations.map((operation) => operation.unitId));
      protectedTasks = slugs.filter((slug) => !prepared.has(slug));
      plan = prepareRecovery({ home, operations, handlers });
    } else {
      plan = prepareRetry({
        home,
        stage: (args["retry-stage"] ?? "all") as RetryStage,
        overrides,
        clusterModel: args["cluster-model"]?.trim(),
        authorModel: args["author-model"]?.trim(),
        quality,
        handlers,
      });
    }
    // Discovery is local. Pure repairs can run without any installed CLI.
    for (const { settings } of plan.modelOperations) {
      const key = sessionKey(settings);
      if (sessions.has(key)) continue;
      const model = settings.model ?? undefined;
      const recordedQuality = isPlanLabel(model)
        ? parseQuality(model.split("/")[0])
        : (quality ?? "balanced");
      sessions.set(
        key,
        await openRunSession({
          home,
          runner: settings.automatic ? undefined : settings.runner,
          quality: recordedQuality,
          explicit: { model: isPlanLabel(model) ? undefined : model },
          // Strict retry reads no variables: a pin is a flag it was given or a
          // setting the saved operation recorded (named by `pinHint`).
          pinSources: pinSourcesFrom(
            args as Record<string, unknown>,
            args as Record<string, unknown>,
          ),
          ignoreWorkflowDefaults: true,
          pinHint:
            !explicitPin && !settings.automatic
              ? `This retry inherits its saved CLI and model. Run ${nextCommandText("reflect", { home })} for automatic CLI selection.`
              : undefined,
          injectedRunner: deps.runner,
          injectedRunnerName: settings.runner,
          output,
        }),
      );
    }
    const sessionFor = (settings: AttemptSettings) => {
      const session = sessions.get(sessionKey(settings));
      if (!session) throw new Error("The recorded operation was outside the approved runner plan.");
      return session;
    };
    const consentPlan: DistillPlan = {
      digests: 0,
      cluster: 0,
      authorEstimate: 0,
      retry: {
        mode: plan.mode,
        sessions: [...sessions.values()].map((session) => session.describe()),
        operations: plan.modelOperations.map(({ operation, settings }) => {
          const session = sessionFor(settings);
          const model = settings.model ?? undefined;
          return {
            ...settings,
            kind: operation.kind,
            unitId: operation.unitId,
            runner: session.ledgerRunner,
            model: isPlanLabel(model)
              ? session.displayModelFor(model.endsWith("/bulk") ? "digest" : "author")
              : (model ?? null),
          };
        }),
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
    const decision = await (deps.confirm ?? confirmPlan)(consentPlan, {
      yes: Boolean(args.yes),
      dryRun: Boolean(args["dry-run"]) || empty,
      input: deps.input,
      output,
      host: deps.host,
    } satisfies ConsentOptions);
    if (args["dry-run"]) return 0;
    if (empty) return plan.blocked.length ? 1 : 0;
    // The question printed its one line for Ctrl-C.
    if (decision === "interrupted") return 130;
    if (decision === "declined") {
      write("Declined. Nothing was sent.");
      return 2;
    }
    if (decision === "dry-run") return 0;
    // The lock is taken after consent, like distill, so Ctrl-C can release it.
    const guarded = guardRun({
      home,
      command: "distill",
      output,
      mute: quiet.mute,
      saved: () => "Calls that finished are saved and reused.",
      resume: resumeRetryCommand(home, args),
      interrupt: () => {
        for (const session of sessions.values()) session.interrupt();
      },
      cleanup: async () => {
        await Promise.allSettled([...sessions.values()].map((session) => session.finalize()));
      },
      host: deps.host,
      exit: deps.exit,
    });
    if ("busy" in guarded) {
      write(guarded.busy);
      return 1;
    }
    guard = guarded;
    // Each CLI is checked just before its first call; one whose saved results
    // need no call is never checked. A failed check prints its line once, and
    // the calls it stops fail with its first sentence.
    const checks = new Map<RunSession, Promise<{ ok: true } | { ok: false; line: string }>>();
    // The models each CLI will be asked for: a reading label, a grouping and
    // writing label, or the concrete model the operation recorded.
    const planned = new Map<RunSession, Set<StageKey>>();
    for (const { settings } of plan.modelOperations) {
      const session = sessionFor(settings);
      const model = settings.model ?? undefined;
      const stage: StageKey = isPlanLabel(model) && model.endsWith("/major") ? "cluster" : "digest";
      const stages = planned.get(session) ?? new Set<StageKey>();
      stages.add(stage);
      planned.set(session, stages);
    }
    const ready = (session: RunSession) => {
      let check = checks.get(session);
      if (!check) {
        check = session.liveCheck([...(planned.get(session) ?? ["digest"])]).then((result) => {
          if (!result.ok) write(result.line);
          return result.ok ? { ok: true as const } : { ok: false as const, line: result.line };
        });
        checks.set(session, check);
      }
      return check;
    };
    const gated = (session: RunSession): AgentRunner => {
      const adapter = session.adapter;
      return {
        get name() {
          return adapter.name;
        },
        get installHint() {
          return adapter.installHint;
        },
        get maxConcurrency() {
          return adapter.maxConcurrency;
        },
        costSummary: () => adapter.costSummary?.(),
        finalize: () => adapter.finalize?.() ?? Promise.resolve(),
        run: async (options) => {
          const checked = await ready(session);
          if (!checked.ok) throw new Error(checked.line.split("\n")[0]);
          return adapter.run(options);
        },
      };
    };
    const progress = startStageProgress(output, "Trying saved calls again", {
      verbose: args.verbose === true,
    });
    const result = await executeRetry(plan, {
      handlers,
      concurrency: parseConcurrency(args.concurrency),
      progress,
      noBreaker: args.breaker === false,
      output,
      getRunner: (settings) => gated(sessionFor(settings)),
      lockHeld: true,
    }).finally(() => progress.end());
    write(retrySummary(result));
    for (const item of [...result.failed, ...result.blocked])
      write(`  ${item.kind} ${item.unitId}: ${item.reason}`);
    if (result.pendingAdoption.length)
      write(
        "The recovered grouping is saved; the current grouping is unchanged. The next reflection can use it.",
      );
    return result.failed.length || result.blocked.length || result.unattempted.length ? 1 : 0;
  } catch (error) {
    write(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    guard?.end();
    for (const session of sessions.values()) {
      for (const line of session.summaryLines()) write(line);
      await session.finalize();
    }
  }
}
