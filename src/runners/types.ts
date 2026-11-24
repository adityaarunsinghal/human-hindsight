import type { ZodType } from "zod";
import type { SourceName } from "../sources/types.js";

/**
 * runners/types.ts: the backend-agnostic runner contract.
 *
 * A runner is the safe bridge to ONE local agent CLI (claude, codex, kiro-cli, opencode). It
 * takes a stage prompt + a zod schema and returns a validated object, hiding
 * all process interaction behind the injectable {@link RunnerIo} so tests never
 * spawn the real binary.
 */

/**
 * Kinds of failure a runner can raise, for typed handling upstream. A runner
 * sets the specific kinds only from its CLI's own error report (a typed error
 * event or stderr), never from the model's answer. See runners/failures.ts.
 */
export type RunnerErrorKind =
  | "sign-in"
  | "missing-binary"
  | "quota"
  | "model-unavailable"
  | "transient"
  | "timeout"
  | "validation"
  | "cli-error";

export type SignInState = "ready" | "needs-sign-in" | "unknown";

export interface SignInHint {
  state: SignInState;
  fix?: string;
  detail?: string;
}

export interface ModelCatalog {
  ids: string[];
  defaultModel?: string;
  source: "aliases" | "catalog" | "none";
}

export interface ResolvedCall {
  runner: RunnerName;
  model?: string;
}

/** How hard a model is asked to reason on one call. A model plan sets it. */
export type Effort = "low" | "high" | "xhigh";

/** Options for a single stage invocation (backend-agnostic). */
export interface RunOptions<T> {
  /** The stage prompt; delivered on stdin. */
  prompt: string;
  /** The zod schema the response must satisfy (source of truth). */
  schema: ZodType<T>;
  /** `--model` pass-through. */
  model?: string;
  /**
   * Reasoning effort for this call. A runner passes it only where its CLI is
   * known to take it; otherwise, and when absent, the CLI's own setting applies.
   */
  effort?: Effort;
  /** Per-invocation timeout in ms (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Disable tool use (default true: distill stages need no tools). */
  disableTools?: boolean;
  /** Skip the capability probe by supplying capabilities directly (testing). */
  capabilities?: Capabilities;
  /** Called with the concrete CLI and model that produced a successful result. */
  onResolved?(resolved: ResolvedCall): void;
  /**
   * Aborted when the person presses Ctrl-C: the CLI's process (its whole
   * group, where the runner owns one) is terminated at once.
   */
  signal?: AbortSignal;
}

/**
 * What the installed CLI supports, discovered once per process via probe.
 * (Claude-shaped today; kiro fills a fixed no-schema shape.)
 */
export interface Capabilities {
  /** Whether `--json-schema` is accepted (server-side structured output). */
  jsonSchema: boolean;
  /** How to disable tool use; Claude requires the enforced `tools-empty` form. */
  disableTools: "tools-empty" | "disallowed" | "none";
  /** Whether Claude can avoid saving generated distillation sessions. */
  noSessionPersistence?: boolean;
  /** All required Claude isolation flags were advertised by the installed CLI. */
  isolation?: "safe-mode";
  /** Whether `--effort` is accepted. */
  effort?: boolean;
}

/**
 * Which agent CLI distills. Every source has a matching runner except Kiro Crew,
 * which is a layer on top of kiro-cli and distills through the kiro runner.
 */
export type RunnerName = Exclude<SourceName, "kirocrew">;

/** A pluggable agent runner. */
export interface AgentRunner {
  readonly name: RunnerName;
  readonly displayName?: string;
  readonly binary?: string;
  /** One-line install hint shown when the binary is missing. */
  readonly installHint: string;
  /**
   * The most calls this CLI can take at once on one machine. The runner pool
   * never has more than this many in flight on it, whatever a stage asks for.
   * Unset: no limit of its own.
   */
  readonly maxConcurrency?: number;
  /** Local capability checks only; never makes a model call. */
  preflight?(): Promise<void>;
  /**
   * Whether this CLI takes a reasoning effort per call, known once `preflight`
   * has run. Absent or false: its calls run at the CLI's own setting.
   */
  acceptsEffort?(): boolean;
  version?(): Promise<string | undefined>;
  signInHint?(): Promise<SignInHint>;
  listModels?(): Promise<ModelCatalog>;
  /** Invoke one stage: prompt+schema in, validated object out. */
  run<T>(opts: RunOptions<T>): Promise<T>;
  /**
   * Best-effort cost summary accumulated across this runner's calls (e.g. the
   * kiro `Credits:` stderr footer), for the distill summary. Absent/undefined
   * when the backend exposes no cost signal.
   */
  costSummary?(): string | undefined;
  /**
   * Once-per-run teardown, called after ALL stage calls have joined (kiro:
   * delete the run's auto-saved sessions under the deletion-scope invariant).
   * Never called mid-run, so it can never race an in-flight sibling worker.
   * Best-effort: must not throw.
   */
  finalize?(): Promise<void>;
}
