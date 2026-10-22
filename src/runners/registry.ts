import type { SourceName } from "../sources/types.js";
import { CLAUDE_INSTALL_HINT, claudeRunner } from "./claude.js";
import { CODEX_INSTALL_HINT, codexRunner } from "./codex.js";
import { KIRO_INSTALL_HINT, kiroRunner, makeKiroRunner } from "./kiro.js";
import { makeOpenCodeRunner, OPENCODE_INSTALL_HINT } from "./opencode.js";
import { AgentRunnerError, defaultIo, type RunnerIo } from "./shared.js";
import type { AgentRunner } from "./types.js";

/**
 * runners/registry.ts — resolve which agent CLI distills.
 *
 * The runner (which CLI produces digests/clusters/oneshots) is orthogonal to
 * the source (where transcripts are read): a user can mine kiro history but
 * distill with claude, or vice-versa. `--runner` defaults to `auto`, which
 * prefers the CLI matching the active source and falls back to whichever binary
 * is installed — so a kiro-only machine works out of the box.
 */

export type RunnerMode = SourceName | "auto";

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

/** Options for {@link resolveRunner}. */
export interface ResolveRunnerOptions {
  /** Prefer the runner matching the active source under `auto`. */
  preferSource?: SourceName;
  /** Injectable binary lookup/spawn (testing). */
  io?: RunnerIo;
  /**
   * Base directory for the kiro runner's per-run scratch cwd (the distill
   * home's `runner-scratch/`); absent falls back to the OS temp dir.
   */
  scratchBase?: string;
}

/**
 * Resolve the runner. EXPLICIT modes require that binary: a missing one throws
 * a typed `missing-binary` {@link AgentRunnerError} with the backend's install
 * hint at RESOLVE time — before any consent prompt, so the user learns the CLI
 * is absent before being asked to approve spending. `auto` prefers the runner
 * whose name matches `preferSource` when installed, else the first installed of
 * claude→codex→kiro; if neither binary is found it returns the claude runner so the
 * standard missing-binary hint surfaces on first use.
 */
export async function resolveRunner(
  mode: RunnerMode,
  opts: ResolveRunnerOptions = {},
): Promise<AgentRunner> {
  const io = opts.io ?? defaultIo;
  const has = async (bin: string) => (await io.which(bin)) !== null;
  const kiro = () => (opts.scratchBase ? makeKiroRunner(undefined, opts.scratchBase) : kiroRunner);

  if (mode === "claude") {
    if (!(await has("claude"))) throw new AgentRunnerError("missing-binary", CLAUDE_INSTALL_HINT);
    return claudeRunner;
  }
  if (mode === "codex") {
    if (!(await has("codex"))) throw new AgentRunnerError("missing-binary", CODEX_INSTALL_HINT);
    return codexRunner;
  }
  if (mode === "kiro") {
    if (!(await has("kiro-cli"))) throw new AgentRunnerError("missing-binary", KIRO_INSTALL_HINT);
    return kiro();
  }
  if (mode === "opencode") {
    if (!(await has("opencode")))
      throw new AgentRunnerError("missing-binary", OPENCODE_INSTALL_HINT);
    return makeOpenCodeRunner(io, opts.scratchBase);
  }

  // auto — prefer the runner matching the active source when it is installed.
  if (opts.preferSource === "kiro" && (await has("kiro-cli"))) return kiro();
  if (opts.preferSource === "claude" && (await has("claude"))) return claudeRunner;
  if (opts.preferSource === "codex" && (await has("codex"))) return codexRunner;
  if (opts.preferSource === "opencode" && (await has("opencode")))
    return makeOpenCodeRunner(io, opts.scratchBase);
  // Otherwise first installed of claude → codex → kiro.
  if (await has("claude")) return claudeRunner;
  if (await has("codex")) return codexRunner;
  if (await has("kiro-cli")) return kiro();
  if (await has("opencode")) return makeOpenCodeRunner(io, opts.scratchBase);
  // Neither found: return claude so its install hint surfaces on use.
  return claudeRunner;
}
