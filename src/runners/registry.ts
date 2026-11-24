import type { SourceName } from "../sources/types.js";
import { RUNNER_INFO, requireBinary } from "./capabilities.js";
import { makeClaudeRunner } from "./claude.js";
import { makeCodexRunner } from "./codex.js";
import { defaultKiroEnv, KIRO_EMPTY_RETRIES, makeKiroRunner } from "./kiro.js";
import { makeOpenCodeRunner } from "./opencode.js";
import { defaultIo, type RunnerEnv, type RunnerIo } from "./shared.js";
import type { AgentRunner, RunnerName } from "./types.js";

/**
 * runners/registry.ts: resolve which agent CLI distills.
 *
 * The runner (which CLI produces digests/clusters/oneshots) is orthogonal to
 * the source (where transcripts are read): a user can mine kiro history but
 * distill with claude, or vice-versa. `--runner` defaults to `auto`, which
 * prefers the CLI matching the active source and falls back to whichever binary
 * is installed, so a kiro-only machine works out of the box.
 */

export type RunnerMode = RunnerName | "auto";

/** Parse/validate a raw `--runner` value; defaults to `auto`. */
export function parseRunnerMode(raw: string | undefined): RunnerMode {
  const value = (raw ?? "auto").toLowerCase();
  if (
    value === "auto" ||
    value === "claude" ||
    value === "codex" ||
    value === "kiro" ||
    value === "opencode"
  )
    return value;
  throw new Error(`unknown --runner "${raw}" (expected claude, codex, kiro, opencode, or auto)`);
}

/**
 * Parse `--runner` where it may name several CLIs: `auto`, one CLI (the run
 * stays on it), or a comma-separated list tried in that order.
 */
export function parseRunnerList(raw: string | undefined): RunnerName[] | "auto" {
  const names = (raw ?? "auto").split(",").map((name) => name.trim());
  if (names.length === 1) {
    const mode = parseRunnerMode(names[0]);
    return mode === "auto" ? "auto" : [mode];
  }
  const order: RunnerName[] = [];
  for (const name of names) {
    const mode = name ? parseRunnerMode(name) : "auto";
    if (mode === "auto" || order.includes(mode))
      throw new Error(
        `unknown --runner "${raw}" (a list names each CLI once: claude, codex, kiro, opencode)`,
      );
    order.push(mode);
  }
  return order;
}

/** Options for {@link resolveRunner}. */
export interface ResolveRunnerOptions extends RunnerEnv {
  /** Prefer the runner matching the active source under `auto`. */
  preferSource?: SourceName;
  /** Injectable binary lookup/spawn (testing). */
  io?: RunnerIo;
  /**
   * Base directory for the kiro runner's per-run scratch cwd (the distill
   * home's `runner-scratch/`); absent falls back to the OS temp dir.
   */
  scratchBase?: string;
  /**
   * True (the default for {@link makeRunner}) when the runner pool wraps the
   * adapter and retries transient failures itself. {@link resolveRunner}, the
   * path for callers outside the pool, sets it to false.
   */
  pooled?: boolean;
}

export { RUNNER_INFO };

/**
 * A fresh adapter with one IO binding for discovery, model calls and teardown.
 * Built for the runner pool unless `pooled` is false.
 */
export function makeRunner(name: RunnerName, opts: ResolveRunnerOptions = {}): AgentRunner {
  const io = opts.io ?? defaultIo;
  const deps: RunnerEnv = { env: opts.env, readFile: opts.readFile };
  switch (name) {
    case "claude":
      return makeClaudeRunner(io, deps);
    case "codex":
      return makeCodexRunner(io, deps);
    // Inside the pool, the pool retries Kiro's empty successful exit itself.
    case "kiro":
      return makeKiroRunner({ ...defaultKiroEnv, io }, opts.scratchBase, {
        emptyRetries: (opts.pooled ?? true) ? 0 : KIRO_EMPTY_RETRIES,
        processEnv: opts.env,
      });
    case "opencode":
      return makeOpenCodeRunner(io, opts.scratchBase);
  }
}

/** Explicit selections fail before consent. Auto prefers the active source's CLI. */
export async function resolveRunner(
  mode: RunnerMode,
  opts: ResolveRunnerOptions = {},
): Promise<AgentRunner> {
  const io = opts.io ?? defaultIo;
  // Callers of resolveRunner use the adapter directly, outside the pool.
  const standalone: ResolveRunnerOptions = { ...opts, pooled: false };
  if (mode !== "auto") {
    await requireBinary(mode, io);
    return makeRunner(mode, standalone);
  }
  const preferred = opts.preferSource === "kirocrew" ? "kiro" : opts.preferSource;
  const order = new Set<RunnerName>(preferred ? [preferred] : []);
  for (const name of ["claude", "codex", "kiro", "opencode"] as const) order.add(name);
  for (const name of order) {
    if (await io.which(RUNNER_INFO[name].binary)) return makeRunner(name, standalone);
  }
  return makeRunner("claude", standalone);
}
