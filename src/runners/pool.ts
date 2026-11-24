import {
  isPlanLabel,
  type ModelRole,
  type PlanLabel,
  planLabel,
  type Quality,
  type ResolvedRole,
  type RunnerModelPlan,
  stepDown,
} from "../core/model-plan.js";
import { SOURCE_PRODUCT_NAMES } from "../sources/labels.js";
import { RUNNER_INFO } from "./capabilities.js";
import { classifyFailure, type FailureClass } from "./failures.js";
import { AgentRunnerError } from "./shared.js";
import type { AgentRunner, ModelCatalog, RunnerName, RunOptions } from "./types.js";

type RunnerFn = AgentRunner["run"];
type Usage = { runner: RunnerName; calls: number; models: string[] };

export interface PoolEvent {
  kind: "switch" | "step-down" | "exhausted";
  runner: RunnerName;
  to?: RunnerName;
  reason: FailureClass;
  line: string;
}

export interface Candidate {
  runner: AgentRunner;
  plans: Record<Quality, RunnerModelPlan>;
  /** Retain the local catalog used at consent time, including the configured default. */
  catalog?: ModelCatalog;
}

export interface RunnerPool {
  readonly run: RunnerFn;
  readonly adapter: AgentRunner;
  readonly check: RunnerFn;
  active(): RunnerName;
  roleFor(role: ModelRole, quality?: Quality): ResolvedRole;
  /**
   * Move to the next eligible CLI after repeated failures seen by the caller
   * (the readiness check). Returns false when pinned, undisclosed, or last.
   */
  switchAfterFailures(reason: FailureClass): boolean;
  used(): Usage[];
  costSummary(): string | undefined;
  /**
   * Ctrl-C: stop at once. Calls in flight are aborted (their CLI processes are
   * terminated), none is retried or moved to another CLI, an answer that still
   * arrives is discarded, and no new call starts. `finalize` then waits only briefly for them before the runners
   * remove the sessions they saved.
   */
  interrupt(): void;
  finalize(): Promise<void>;
}

/** After Ctrl-C, how long `finalize` waits for aborted calls before the runners clean up. */
const INTERRUPT_SETTLE_MS = 1_000;

export function orderCandidates(
  installed: RunnerName[],
  sessionShare: Partial<Record<RunnerName, number>>,
  explicit?: RunnerName,
): RunnerName[] {
  const byPriority: RunnerName[] = ["claude", "codex", "kiro", "opencode"];
  const available = byPriority.filter((name) => installed.includes(name));
  const preferred =
    explicit ??
    available.reduce<RunnerName | undefined>((best, name) => {
      return !best || (sessionShare[name] ?? 0) > (sessionShare[best] ?? 0) ? name : best;
    }, undefined);
  if (!preferred || !available.includes(preferred)) return available;
  return [preferred, ...available.filter((name) => name !== preferred)];
}

const REASONS: Record<FailureClass, string> = {
  "sign-in": "not signed in",
  "missing-binary": "could not be started",
  quota: "usage limit reached",
  "model-unavailable": "your provider refused the model",
  transient: "temporary service errors",
  timeout: "timed out",
  validation: "answers that could not be used",
  "cli-error": "failed twice in a row",
};

/** The reason for a switch or stop, in plain words. */
export function describeReason(reason: FailureClass): string {
  return REASONS[reason];
}

/** What happened to a CLI, as the first sentence of a switch or stop line. */
const HAPPENED: Record<FailureClass, (cli: string) => string> = {
  "sign-in": (cli) => `${cli} is not signed in.`,
  "missing-binary": (cli) => `${cli} could not be started.`,
  quota: (cli) => `${cli} has reached its usage limit.`,
  "model-unavailable": (cli) =>
    `${cli} cannot use the plan's models here (your provider refused them).`,
  transient: (cli) => `${cli} kept failing with temporary service errors.`,
  timeout: (cli) => `${cli} timed out.`,
  validation: (cli) => `${cli} gave answers that could not be used.`,
  "cli-error": (cli) => `${cli} failed twice in a row.`,
};

/** "Claude Code is not signed in." */
function whatHappened(runner: RunnerName, reason: FailureClass): string {
  return HAPPENED[reason](SOURCE_PRODUCT_NAMES[runner]);
}

interface CandidateState {
  candidate: Candidate;
  changes: Map<PlanLabel, ResolvedRole>;
  calls: number;
  /** Concrete models that produced a result. */
  models: Set<string>;
  /** Counted failures of calls that started after the last success. */
  streak: number;
  /** Attempt number current when the last success landed. */
  lastSuccess: number;
  /** Calls in flight on this CLI, never above its `maxConcurrency`. */
  running: number;
  /** Calls waiting for a free slot, first come first served. */
  waiting: (() => void)[];
}

/** Wait for a free slot on this CLI. */
function acquire(state: CandidateState): Promise<void> {
  const limit = state.candidate.runner.maxConcurrency;
  if (limit === undefined || state.running < Math.max(1, limit)) {
    state.running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => state.waiting.push(resolve));
}

/** Hand the slot to the next waiting call, or free it. */
function release(state: CandidateState): void {
  const next = state.waiting.shift();
  if (next) next();
  else state.running--;
}

/** What a role is used for, in the words of the plan screen. */
const PURPOSE: Record<ModelRole, string> = {
  bulk: "session reads",
  major: "grouping and writing",
};

function stepDownLine(
  runner: RunnerName,
  label: PlanLabel,
  from: ResolvedRole,
  to: ResolvedRole,
  purposes: Record<ModelRole, string> = PURPOSE,
) {
  const using =
    to.tier !== "default"
      ? to.display
      : to.display === "CLI default"
        ? "the CLI default"
        : `${to.display} (the CLI default)`;
  const purpose = purposes[label.endsWith("/major") ? "major" : "bulk"];
  return `${SOURCE_PRODUCT_NAMES[runner]} cannot use ${from.display} here (your provider refused it). Using ${using} for ${purpose}.`;
}

/** Failures that move to the next CLI at once: the CLI cannot serve any call. */
const SWITCH_NOW: ReadonlySet<FailureClass> = new Set([
  "sign-in",
  "missing-binary",
  "quota",
  "model-unavailable",
]);
/** With no next CLI, these end the run: no later call can succeed either. */
const ENDS_RUN: ReadonlySet<FailureClass> = new Set(["sign-in", "missing-binary", "quota"]);
/** Failures that count toward the switch streak. Timeouts and invalid answers never do. */
const COUNTED: ReadonlySet<FailureClass> = new Set(["cli-error", "transient"]);
const SWITCH_STREAK = 2;
const TRANSIENT_RETRIES = 3;

function selectedRole(state: CandidateState, label: PlanLabel): ResolvedRole {
  const quality = label.startsWith("best/") ? "best" : "balanced";
  const key = label.endsWith("/major") ? "major" : "bulk";
  return state.changes.get(label) ?? state.candidate.plans[quality].roles[key];
}

function catalogFromPlans(candidate: Candidate): ModelCatalog {
  const roles = Object.values(candidate.plans).flatMap((plan) => Object.values(plan.roles));
  const defaultRole = roles.find(
    (role) => role.tier === "default" && role.display !== "CLI default",
  );
  return {
    source: "catalog",
    ids: roles.flatMap((role) => (role.model ? [role.model] : [])),
    defaultModel: defaultRole?.display,
  };
}

function withPinHint(error: unknown, hint: string | undefined): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  if (!hint) return original;
  const message = `${original.message} ${hint}`;
  return error instanceof AgentRunnerError
    ? new AgentRunnerError(error.kind, message, { stderr: error.stderr, output: error.output })
    : new Error(message, { cause: original });
}

export function createRunnerPool(o: {
  candidates: Candidate[];
  pinned: boolean;
  quality: () => Quality;
  onEvent(e: PoolEvent): void;
  pinHint?: string;
  fallbackDisclosed?(): boolean;
  injected?: boolean;
  sleep?(ms: number): Promise<void>;
  random?(): number;
  /** What each role is used for, in the command's words (default: distill's). */
  purposes?: Record<ModelRole, string>;
}): RunnerPool {
  const seen = new Set<RunnerName>();
  const states: CandidateState[] = [];
  for (const candidate of o.candidates) {
    if (seen.has(candidate.runner.name)) continue;
    seen.add(candidate.runner.name);
    states.push({
      candidate,
      changes: new Map(),
      calls: 0,
      models: new Set(),
      streak: 0,
      lastSuccess: 0,
      running: 0,
      waiting: [],
    });
  }
  if (!states.length) throw new Error("No runner is available. Run human-hindsight doctor.");
  let index = 0;
  let attempts = 0;
  const current = () => states[index] as CandidateState;
  const active = () => current().candidate.runner.name;
  const sleep =
    o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = o.random ?? Math.random;
  const pinHint = o.pinned ? (o.pinHint ?? "Remove --runner to allow another CLI.") : undefined;
  let exhausted: Error | undefined;
  const inFlight = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const aborted = new AbortController();
  const stopped = () => aborted.signal.aborted;

  /** Move to the next eligible CLI. Returns false when there is none. */
  function advance(reason: FailureClass): boolean {
    // After Ctrl-C nothing failed: the run is stopping.
    if (stopped()) return false;
    const disclosed = o.fallbackDisclosed?.() ?? true;
    const next = o.pinned || !disclosed ? undefined : states[index + 1];
    if (!next) return false;
    const runner = active();
    index++;
    const to = next.candidate.runner.name;
    const line = `${whatHappened(runner, reason)} Continuing with ${SOURCE_PRODUCT_NAMES[to]}.`;
    o.onEvent({ kind: "switch", reason, runner, to, line });
    return true;
  }

  /**
   * No CLI can go on: one line says what happened and the one thing to do.
   * Signed out: the CLI's own sign-in command. Otherwise, a pinned run names
   * the setting to change, and an unpinned one says no other CLI can take
   * over. Every later call fails with the first sentence alone.
   */
  function endRun(reason: FailureClass, error: unknown): Error {
    const runner = active();
    const disclosed = o.fallbackDisclosed?.() ?? true;
    const happened = whatHappened(runner, reason);
    const kind = error instanceof AgentRunnerError ? error.kind : "cli-error";
    exhausted = new AgentRunnerError(kind, happened, {
      stderr: error instanceof AgentRunnerError ? error.stderr : undefined,
      output: error instanceof AgentRunnerError ? error.output : undefined,
    });
    const others = o.pinned
      ? undefined
      : disclosed
        ? "No other ready CLI could take over."
        : "No other coding CLI is ready on this machine.";
    const line =
      reason === "sign-in"
        ? `${[happened, others].filter(Boolean).join(" ")}\nRun: ${RUNNER_INFO[runner].loginCommand}`
        : `${happened} ${others ?? pinHint ?? ""}`.trim();
    o.onEvent({ kind: "exhausted", reason, runner, line });
    return exhausted;
  }

  async function dispatch<T>(opts: RunOptions<T>, checking: boolean): Promise<T> {
    const label = isPlanLabel(opts.model) ? opts.model : undefined;
    let previous: CandidateState | undefined;
    let previousRole: ResolvedRole | undefined;
    let retries = 0;
    for (;;) {
      if (exhausted) throw exhausted;
      if (stopped()) throw new Error("The run was interrupted.");
      const state = current();
      await acquire(state);
      // While this call waited for a slot, a sibling may have moved the run on.
      if (exhausted || stopped() || current() !== state) {
        release(state);
        continue;
      }
      const { candidate } = state;
      const { runner } = candidate;
      const role = label ? selectedRole(state, label) : undefined;
      const model = label ? role?.model : opts.model;
      if (isPlanLabel(model)) throw new Error("A model plan must resolve to a CLI model first.");
      if (state !== previous || role !== previousRole) retries = 0;
      previous = state;
      previousRole = role;
      let reported: string | undefined;
      const started = ++attempts;
      state.calls++;
      const outcome = await runner
        .run({
          ...opts,
          model,
          signal: aborted.signal,
          onResolved: (result) => {
            reported = result.model;
          },
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        )
        .finally(() => release(state));
      if (!outcome.ok) {
        const { error } = outcome;
        // After Ctrl-C a failure is the abort itself: never retried or moved.
        if (o.injected || stopped()) throw error;
        // A sibling already moved this request to another CLI or model.
        if (exhausted || current() !== state || (label && selectedRole(state, label) !== role))
          continue;
        const reason = classifyFailure(runner.name, error);
        if (reason === "transient" && retries < TRANSIENT_RETRIES) {
          const delay = 500 * 2 ** retries * (0.5 + random());
          retries++;
          await sleep(Math.round(delay));
          continue;
        }
        if (reason === "model-unavailable" && role && label && role.tier !== "default") {
          const catalog = candidate.catalog ?? catalogFromPlans(candidate);
          const next = stepDown(role, catalog, runner.name);
          if (next) {
            state.changes.set(label, next);
            const line = stepDownLine(runner.name, label, role, next, o.purposes);
            o.onEvent({ kind: "step-down", runner: runner.name, reason, line });
            continue;
          }
        }
        if (reason === "model-unavailable" && !label && model) throw withPinHint(error, pinHint);
        let switching = SWITCH_NOW.has(reason);
        if (!switching && COUNTED.has(reason) && !checking) {
          // Only calls started after the last success show that the CLI stopped working.
          if (started > state.lastSuccess) state.streak++;
          switching = state.streak >= SWITCH_STREAK;
        }
        if (!switching) throw error;
        if (advance(reason)) continue;
        if (ENDS_RUN.has(reason)) throw endRun(reason, error);
        // No next CLI: this call fails, later calls still run. Only a failure
        // that would have switched names the pin to remove; an ordinary
        // failure keeps the CLI's own message.
        throw SWITCH_NOW.has(reason) ? withPinHint(error, pinHint) : error;
      }
      const { value } = outcome;
      // An answer that lands after Ctrl-C is never used: the stopping run
      // saves, prints, and copies nothing more.
      if (stopped()) throw new Error("The run was interrupted.");

      // A success is kept whichever CLI is active now.
      state.streak = 0;
      state.lastSuccess = attempts;
      const configured = candidate.catalog?.defaultModel;
      const defaultModel =
        configured && !/^(auto|default)$/i.test(configured)
          ? configured
          : role?.tier === "default" && role.display !== "CLI default"
            ? role.display
            : undefined;
      const concrete = reported || model || defaultModel;
      const recorded = concrete && !isPlanLabel(concrete) ? concrete : undefined;
      if (recorded) state.models.add(recorded);
      opts.onResolved?.({ runner: runner.name, model: recorded });
      return value;
    }
  }

  function tracked<T>(opts: RunOptions<T>, checking: boolean): Promise<T> {
    if (closing || stopped()) return Promise.reject(new Error("This runner session has ended."));
    const pending = dispatch(opts, checking);
    inFlight.add(pending);
    return pending.finally(() => inFlight.delete(pending));
  }
  const run: RunnerFn = (opts) => tracked(opts, false);
  const check: RunnerFn = (opts) => tracked(opts, true);
  const costSummary = (): string | undefined => {
    const lines = states
      .filter((state) => state.calls)
      .flatMap(({ candidate }) => {
        const line = candidate.runner.costSummary?.();
        return line ? [line] : [];
      });
    return lines.length ? lines.join("\n") : undefined;
  };
  const finalize = (): Promise<void> => {
    closing ??= Promise.resolve().then(async () => {
      const settled = Promise.allSettled(inFlight);
      // After Ctrl-C the aborted calls get a short time to end; a CLI that
      // ignores its signal never holds the cleanup back.
      if (stopped()) await Promise.race([settled, sleep(INTERRUPT_SETTLE_MS)]);
      else await settled;
      await Promise.allSettled(
        states
          .filter((state) => state.calls)
          .map(async ({ candidate }) => {
            await candidate.runner.finalize?.();
          }),
      );
    });
    return closing;
  };
  const adapter: AgentRunner = {
    get name() {
      return active();
    },
    get installHint() {
      return current().candidate.runner.installHint;
    },
    get maxConcurrency() {
      return current().candidate.runner.maxConcurrency;
    },
    run,
    costSummary,
    finalize,
  };
  return {
    run,
    check,
    adapter,
    active,
    finalize,
    costSummary,
    interrupt: () => aborted.abort(),
    switchAfterFailures: (reason) => !exhausted && advance(reason),
    roleFor: (role, quality = o.quality()) => selectedRole(current(), planLabel(quality, role)),
    used: () =>
      states
        .filter((state) => state.calls)
        .map(({ candidate, calls, models }) => ({
          runner: candidate.runner.name,
          calls,
          models: [...models],
        })),
  };
}
