import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { toJsonSchema } from "../distill/schemas.js";
import { KIRO_DISTILL_SENTINEL } from "../sources/kiro/extract.js";
import {
  hasOutsideCredentials,
  missingBinaryHint,
  PROBE_TIMEOUT_MS,
  RUNNER_INFO,
  readCatalog,
  readSignInHint,
  readVersion,
  requireBinary,
  requireFlags,
} from "./capabilities.js";
import { cliErrorKind } from "./failures.js";
import {
  AgentRunnerError,
  DEFAULT_TIMEOUT_MS,
  DISTILL_SYSTEM,
  defaultIo,
  embedSchema,
  RetryableError,
  type RunnerIo,
  requireConcreteModel,
  runWithCorrectiveRetry,
  type SpawnResult,
  snippet,
  stripFence,
  TOOL_BAN_LINE,
} from "./shared.js";
import type { AgentRunner, Effort, RunOptions } from "./types.js";

/**
 * runners/kiro.ts: the kiro-cli runner.
 *
 * Drives `kiro-cli chat --no-interactive` for one distill stage. Unlike claude
 * there is no `--json-schema` and no `--tools` flag, so this runner:
 *   - embeds the JSON schema in the prompt (+ zod validation on our side);
 *   - disables tools via a local no-tools AGENT config discovered from the
 *     spawn cwd (verified: model reports TOOLS=NONE, no MCP startup);
 *   - treats EMPTY output with exit 0 as a transient transport failure (the
 *     observed "Kiro is having trouble responding" signature). A standalone
 *     runner retries it with bounded backoff BELOW the shared corrective retry;
 *     inside the runner pool the pool's own transient retry does that instead;
 *   - cleans up the sessions kiro auto-saves per run, with a hard deletion-scope
 *     invariant (only the run's own scratch-cwd group, sentinel-title matched).
 *
 * Two CLI generations, picked once per environment from `kiro-cli --version`:
 *
 *   2.x (and an unknown version): plain text on stdout. ANSI codes and a
 *   leading `> ` glyph are stripped before parsing; cost comes from the
 *   `Credits: <n>` footer on stderr.
 *
 *   3.x: adds `--agent-engine v2 --output-format stream-json`. The engine pin
 *   matters: a `chat.agentEngine = "v3"` user setting otherwise selects the v3
 *   engine even headless, and v3 ignores the agent's empty tool list (the model
 *   still gets `load_resource`), injects the user's global steering and memory
 *   index into every call, and runs with memory reflection on. None of that has
 *   a per-workspace off switch (`memory.mode` is global-only, and
 *   `chat.disableInheritingDefaultResources` did not drop steering on v3). The v2
 *   engine keeps the verified no-tools, no-steering behavior. Text mode on 3.x
 *   prints neither the glyph nor the credits footer on either engine, so the
 *   answer comes from the `runFinished.finalText` event and cost from the
 *   metering events. No trust flag is needed: neither engine prompted to trust
 *   the fresh scratch workspace under `--no-interactive`.
 *
 * Session listings on both generations are an array of `{cwd, sessions}`
 * envelopes, and 3.x reports `cwd` as the REAL path (symlinks resolved), so the
 * scratch-cwd match compares resolved paths.
 *
 * Verified against kiro-cli 3.5.0 (and the 2.12.1 shapes are still parsed).
 */

/** Pointer shown when the `kiro-cli` binary cannot be found on PATH. */
const KIRO_INSTALL_HINT = missingBinaryHint("kiro");

/** The local no-tools agent the runner writes into each scratch cwd. */
export const KIRO_NO_TOOLS_AGENT = "human-hindsight-distill";

/** Transient-failure retries (empty stdout, exit 0) below the corrective retry. */
export const KIRO_EMPTY_RETRIES = 2;

/**
 * Flags the model call passes, by CLI generation, as shown by a captured
 * `kiro-cli chat --help` (3.5.0: test/fixtures/kiro-runner/chat-help-3.5.0.txt).
 * A generation without a capture, or an unknown version, is not blocked.
 */
const KIRO_CHAT_FLAGS: Readonly<Record<number, readonly string[]>> = {
  3: ["--no-interactive", "--agent", "--model", "--agent-engine", "--output-format"],
};

/** Backoff (ms) between empty-stdout attempts; injectable for tests. */
const KIRO_EMPTY_BACKOFF_MS = [500, 2000];

/** Injectable sleep so tests don't actually wait. */
export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One envelope of `chat --list-sessions --format json`. 2.12.1 and 3.5.0 both
 * print an array of these for the current directory (3.x adds `complete` and a
 * per-session `source` of `v2`, `v3` or `classic`; `--all-cwds` prints one
 * envelope per cwd in the same array). Only the fields cleanup needs are kept.
 */
export interface KiroSessionListing {
  cwd: string;
  sessions: { sessionId: string; title?: string }[];
}

/**
 * Tolerant parse of a session listing: a JSON array of envelopes, a single
 * envelope object, or one envelope per line. Anything without a string `cwd`
 * and a `sessions` array is skipped, as is any session without a string id.
 * Bad input yields `[]`, never a throw.
 */
export function parseKiroSessionListing(raw: string): KiroSessionListing[] {
  const text = stripVTControlCharacters(raw).trim();
  if (text === "") return [];
  let values: unknown[];
  try {
    const parsed: unknown = JSON.parse(text);
    values = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    values = [];
    for (const line of text.split("\n")) {
      try {
        values.push(JSON.parse(line));
      } catch {
        // not an envelope line; skip
      }
    }
  }
  const out: KiroSessionListing[] = [];
  for (const v of values) {
    if (!v || typeof v !== "object") continue;
    const env = v as { cwd?: unknown; sessions?: unknown };
    if (typeof env.cwd !== "string" || !Array.isArray(env.sessions)) continue;
    const sessions: KiroSessionListing["sessions"] = [];
    for (const s of env.sessions) {
      if (!s || typeof s !== "object") continue;
      const { sessionId, title } = s as { sessionId?: unknown; title?: unknown };
      if (typeof sessionId !== "string") continue;
      sessions.push(typeof title === "string" ? { sessionId, title } : { sessionId });
    }
    out.push({ cwd: env.cwd, sessions });
  }
  return out;
}

/** Major version from `kiro-cli --version` output (`kiro-cli 3.5.0`), or null. */
export function parseKiroMajor(versionOutput: string): number | null {
  const m = stripVTControlCharacters(versionOutput).match(/(\d+)\.\d+(?:\.\d+)?/);
  const n = m?.[1] ? Number.parseInt(m[1], 10) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/** The error for a failed run whose event carried no error object of its own. */
const KIRO_STOPPED = "Kiro stopped before completing the request";

/** What one stream-json run produced: the answer text and the credits spent. */
export interface KiroStreamResult {
  text: string;
  credits: number;
  error?: string;
  /** The `stage` of a `runError` event (`auth` when signed out). */
  errorStage?: string;
  model?: string;
}

function streamError(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!value || typeof value !== "object") return undefined;
  const details = value as Record<string, unknown>;
  const rawCode = details.code ?? details.errorCode;
  const code = typeof rawCode === "string" || typeof rawCode === "number" ? rawCode : "";
  const message = streamError(details.message ?? details.errorMessage ?? details.error);
  return [code, message].filter(Boolean).join(" ") || undefined;
}

/** Sum the `usage`/`value` figures of a credits array from a stream event. */
function sumCredits(items: unknown): number {
  if (!Array.isArray(items)) return 0;
  let total = 0;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const { usage, value, unit } = item as { usage?: unknown; value?: unknown; unit?: unknown };
    if (unit !== undefined && unit !== "credit") continue;
    const n = typeof usage === "number" ? usage : typeof value === "number" ? value : Number.NaN;
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

/**
 * Parse `--output-format stream-json` stdout (kiro-cli 3.x, one ACP event per
 * line). The answer is `runFinished.finalText`; when that is missing or flagged
 * `finalTextTruncated`, the `agent_message_chunk` texts are joined instead
 * (thought chunks never count). Credits: the v3 engine reports a cumulative
 * `session_usage` event (the last one wins); the v2 engine reports per-turn
 * `metadata.meteringUsage` (summed). When no line parses as an event at all the
 * raw stdout is returned as text so the usual cleaning and JSON parse apply.
 */
export function parseKiroStream(stdout: string): KiroStreamResult {
  let finalText: string | undefined;
  let truncated = false;
  let chunks = "";
  let sessionUsage: number | undefined;
  let metering = 0;
  let events = 0;
  let error: string | undefined;
  let errorStage: string | undefined;
  let model: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let ev: { type?: unknown; data?: Record<string, unknown>; error?: unknown; message?: unknown };
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== "object" || typeof ev.type !== "string") continue;
    events++;
    const data = ev.data ?? {};
    if (ev.type === "runFinished") {
      if (typeof data.finalText === "string") finalText = data.finalText;
      truncated = data.finalTextTruncated === true;
      const failed = [data.status, data.stopReason].some((s) =>
        /^(?:error|failed|failure|cancelled|canceled)$/i.test(String(s)),
      );
      // Only the event's own error object describes the failure. `finalText`
      // is the model's (partial) answer and never becomes the error message.
      if (data.error || failed) {
        error = streamError(data.error) ?? KIRO_STOPPED;
      }
      if (typeof data.modelId === "string") model = data.modelId;
    } else if (["error", "runError", "runFailed"].includes(ev.type)) {
      if (typeof data.stage === "string") errorStage = data.stage;
      error =
        streamError(data.error) ??
        streamError(data) ??
        streamError(ev.error) ??
        streamError(ev.message) ??
        "Kiro reported a stream error";
    } else if (ev.type === "metadata") {
      metering += sumCredits(data.meteringUsage);
      if (typeof data.modelId === "string") model = data.modelId;
    } else if (ev.type === "sessionUpdate") {
      const update = (data.update ?? {}) as {
        sessionUpdate?: unknown;
        content?: { type?: unknown; text?: unknown };
        error?: unknown;
        _meta?: {
          kiro?: { kind?: unknown; credits?: unknown; error?: unknown; message?: unknown };
        };
      };
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        typeof update.content?.text === "string"
      )
        chunks += update.content.text;
      const kiro = update._meta?.kiro;
      if (kiro?.kind === "session_usage") sessionUsage = sumCredits(kiro.credits);
      // A message chunk's text is the model's answer, even when tagged as an error.
      const errorText = update.sessionUpdate === "error" ? update.content?.text : undefined;
      if (update.sessionUpdate === "error" || kiro?.kind === "error")
        error =
          streamError(kiro?.error ?? kiro?.message ?? update.error ?? errorText) ??
          "Kiro reported a session error";
    }
  }
  if (events === 0) return { text: stdout, credits: 0 };
  const text = finalText !== undefined && (!truncated || chunks === "") ? finalText : chunks;
  return {
    text,
    credits: sessionUsage ?? metering,
    ...(error ? { error } : {}),
    ...(errorStage ? { errorStage } : {}),
    ...(model ? { model } : {}),
  };
}

/** Filesystem + process seam for the kiro runner, injectable for testing. */
export interface KiroEnv {
  io: RunnerIo;
  sleep: Sleep;
  /**
   * Make the per-run scratch dir; returns its absolute path. When `base` is
   * given (the distill home's `runner-scratch/`), the dir is created under it
   * (owner-only); otherwise it falls back to the OS temp dir.
   */
  makeScratch(base?: string): string;
  /** Best-effort remove a directory tree (the scratch dir). */
  removeScratch(dir: string): void;
  /** Write the no-tools agent config into `<cwd>/.kiro/agents/<name>.json`. */
  writeAgent(cwd: string, name: string): void;
  /** List kiro sessions for a cwd (parsed `--list-sessions --format json`). */
  listSessions(cwd: string): Promise<KiroSessionListing[]>;
  /** Delete a kiro session by id. */
  deleteSession(sessionId: string): Promise<void>;
  /**
   * Raw `kiro-cli --version` output, used to pick the 2.x or 3.x invocation.
   * Absent (or failing, or unparseable) means the 2.x invocation.
   */
  version?(): Promise<string>;
  /**
   * Resolve symlinks in a path (3.x listings report real paths). Absent or
   * failing means the path is compared as given.
   */
  realpath?(p: string): string;
}

/** Per-environment cache of the detected kiro-cli major version. */
const majorCache = new WeakMap<KiroEnv, Promise<number | null>>();

/** Detect (once per env) the kiro-cli major version; null when unknown. */
function kiroMajor(env: KiroEnv): Promise<number | null> {
  let cached = majorCache.get(env);
  if (!cached) {
    const probe = env.version;
    cached = probe
      ? probe.call(env).then(parseKiroMajor, () => null)
      : Promise.resolve<number | null>(null);
    majorCache.set(env, cached);
  }
  return cached;
}

/** Per-environment: whether this CLI's own `chat --help` lists `--effort`. */
const effortFlag = new WeakMap<KiroEnv, boolean>();

/** The `chat` args for one stage call on the detected CLI generation. */
export function kiroChatArgs(major: number | null, model?: string, effort?: Effort): string[] {
  const args = ["chat", "--no-interactive", "--agent", KIRO_NO_TOOLS_AGENT];
  if (major !== null && major >= 3) {
    args.push("--agent-engine", "v2", "--output-format", "stream-json");
  }
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  return args;
}

/** Build the prompt with schema embedded and a self-recognition sentinel. */
function buildKiroPrompt(opts: RunOptions<unknown>): string {
  // The sentinel rides as the first line so the extractor's K13 rejects the
  // session this call auto-saves (self-recognition guard); echoing it into the
  // output is benign: it fails JSON.parse, then the corrective retry. The schema
  // is ALWAYS embedded (kiro has no --json-schema / envelope) via the same
  // shared wording the claude no-jsonSchema fallback uses.
  const base = `${KIRO_DISTILL_SENTINEL}\n${opts.prompt}${TOOL_BAN_LINE.kiro}`;
  return embedSchema(base, JSON.stringify(toJsonSchema(opts.schema)));
}

/** Strip ANSI escapes and a leading `> ` prompt glyph kiro prints on stdout. */
function cleanKiroStdout(stdout: string): string {
  let text = stripVTControlCharacters(stdout).trim();
  if (text.startsWith("> ")) text = text.slice(2).trim();
  else if (text.startsWith(">")) text = text.slice(1).trim();
  return text;
}

/** Mutable per-run cost accumulator (kiro prints `Credits: <n>` on stderr). */
export interface KiroCost {
  credits: number;
}

/** Best-effort: pull the `Credits: <n>` figure out of a stderr footer. */
function parseCredits(stderr: string): number {
  const m = stderr.match(/Credits:\s*([0-9]+(?:\.[0-9]+)?)/);
  const n = m?.[1] ? Number.parseFloat(m[1]) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * One spawn + parse-to-raw-JSON attempt, with empty-stdout transport-retry
 * INSIDE (below the shared corrective retry). Empty stdout + exit 0 is a
 * transient kiro backend failure: retrying the SAME input (no corrective note)
 * is correct; burning the single corrective retry on a transport blip would
 * waste it. With `emptyRetries` 0 it is reported as `transient` at once. Non-empty-but-unparseable stdout is a RetryableError (feeds the
 * corrective retry); a non-zero exit is a fatal cli-error.
 */
async function spawnAndParse(
  bin: string,
  args: string[],
  input: string,
  timeoutMs: number,
  cwd: string,
  env: KiroEnv,
  cost?: KiroCost,
  stream = false,
  emptyRetries = KIRO_EMPTY_RETRIES,
  onModel?: (id: string | undefined) => void,
  signal?: AbortSignal,
): Promise<unknown> {
  let last: SpawnResult | null = null;
  for (let attempt = 0; attempt <= emptyRetries; attempt++) {
    const result = await env.io.spawn(bin, args, { input, timeoutMs, cwd, signal });
    last = result;
    // 3.x stream-json carries both the answer and the credits; 2.x prints the
    // answer as text and the credits as a stderr footer.
    const streamed = stream ? parseKiroStream(result.stdout) : null;
    onModel?.(streamed?.model);
    if (cost) cost.credits += streamed ? streamed.credits : parseCredits(result.stderr);
    if (result.timedOut) {
      throw new AgentRunnerError("timeout", `kiro-cli call timed out after ${timeoutMs}ms`, {
        stderr: result.stderr,
        output: result.stdout,
      });
    }
    if (streamed?.error) {
      const kind = cliErrorKind("kiro", {
        message: streamed.error,
        stage: streamed.errorStage,
        stderr: result.stderr,
      });
      throw new AgentRunnerError(kind, `kiro-cli reported an error: ${snippet(streamed.error)}`, {
        stderr: result.stderr,
      });
    }
    const text = cleanKiroStdout(streamed ? streamed.text : result.stdout);
    if (text === "") {
      // Empty output. Exit 0 → transient transport failure: back off and retry
      // the same input. Non-zero exit → the CLI itself failed: fatal.
      if (result.code !== 0) {
        throw new AgentRunnerError(
          cliErrorKind("kiro", { stderr: result.stderr }),
          `kiro-cli exited ${result.code}: ${snippet(result.stderr) || "no output"}`,
          { stderr: result.stderr, output: result.stdout },
        );
      }
      if (attempt < emptyRetries) {
        await env.sleep(KIRO_EMPTY_BACKOFF_MS[attempt] ?? 2000);
        continue;
      }
      throw new AgentRunnerError(
        "transient",
        `kiro-cli produced no output${emptyRetries ? ` after ${emptyRetries + 1} attempts` : ""}`,
        { stderr: result.stderr, output: result.stdout },
      );
    }
    // Non-empty output: parse. A non-zero exit alongside real output is still an
    // error; otherwise strip a fence and JSON.parse (retryable if malformed).
    if (result.code !== 0) {
      // `text` is the model's answer here, so the message names stderr only.
      const kind = cliErrorKind("kiro", { stderr: result.stderr });
      const detail = snippet(result.stderr) || "no error detail";
      throw new AgentRunnerError(kind, `kiro-cli exited ${result.code}: ${detail}`, {
        stderr: result.stderr,
        output: result.stdout,
      });
    }
    try {
      return JSON.parse(stripFence(text));
    } catch {
      throw new RetryableError(`kiro-cli output was not valid JSON: ${snippet(text)}`);
    }
  }
  // Unreachable (loop either returns or throws), but keep the type checker happy.
  throw new AgentRunnerError("cli-error", "kiro-cli produced no usable output", {
    stderr: last?.stderr,
    output: last?.stdout,
  });
}

/**
 * Delete only the sessions this run auto-saved: the DELETION-SAFETY INVARIANT.
 * Parse the per-cwd listing, and delete a session ONLY when BOTH hold: its group
 * cwd is EXACTLY the run's scratch dir, AND its title starts with the sentinel.
 * Never touches any other cwd group even if the listing returns several.
 * Best-effort: failures are swallowed (K13 still protects the corpus).
 *
 * Runs ONCE per distill run (via {@link AgentRunner.finalize}, after all
 * concurrent workers join), never mid-run, so one worker's cleanup can never
 * list-and-delete a sibling worker's in-flight session.
 */
export async function cleanupScratchSessions(scratch: string, env: KiroEnv): Promise<void> {
  // 3.x lists the resolved cwd (`/mnt/users/u/...` for a `/home/u/...` scratch
  // when home is a symlink), so the scope test is "same directory once
  // symlinks are resolved", still an exact match, never a prefix match.
  const resolve = (p: string): string => {
    try {
      return env.realpath ? env.realpath(p) : p;
    } catch {
      return p;
    }
  };
  const scratchReal = resolve(scratch);
  try {
    const groups = await env.listSessions(scratch);
    for (const group of groups) {
      const inScope = group.cwd === scratch || resolve(group.cwd) === scratchReal;
      if (!inScope) continue; // hard scope: only the scratch cwd
      for (const s of group.sessions) {
        if (!s.title?.startsWith(KIRO_DISTILL_SENTINEL)) continue; // belt-and-braces
        try {
          await env.deleteSession(s.sessionId);
        } catch {
          // best-effort per session
        }
      }
    }
  } catch {
    // listing failed: leave it; K13 self-recognition still excludes these.
  }
}

/**
 * Run one distill stage through kiro-cli. Resolves the binary, writes the
 * no-tools agent into the (shared) scratch cwd, then runs the shared
 * corrective-retry loop (max 2) around {@link spawnAndParse} (which itself
 * absorbs transient empty-stdout failures). Auto-saved sessions are cleaned up
 * once per run by {@link cleanupScratchSessions} via the runner's `finalize`.
 */
export async function runKiro<T>(
  opts: RunOptions<T>,
  scratchCwd: string,
  env: KiroEnv = defaultKiroEnv,
  cost?: KiroCost,
  emptyRetries = KIRO_EMPTY_RETRIES,
): Promise<T> {
  requireConcreteModel(opts.model);
  const bin = await requireBinary("kiro", env.io);

  env.writeAgent(scratchCwd, KIRO_NO_TOOLS_AGENT);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const major = await kiroMajor(env);
  // The effort is passed only when preflight found the flag in this CLI's help.
  const args = kiroChatArgs(major, opts.model, effortFlag.get(env) ? opts.effort : undefined);
  const stream = major !== null && major >= 3;

  let model = opts.model;
  const value = await runWithCorrectiveRetry(
    buildKiroPrompt(opts),
    opts.schema,
    (input) =>
      spawnAndParse(
        bin,
        args,
        input,
        timeoutMs,
        scratchCwd,
        env,
        cost,
        stream,
        emptyRetries,
        (id) => {
          model = id ?? opts.model;
        },
        opts.signal,
      ),
    (lastDetail) =>
      new AgentRunnerError(
        "validation",
        `kiro-cli response failed schema validation after one retry: ${lastDetail}`,
      ),
  );
  opts.onResolved?.({ runner: "kiro", model });
  return value;
}

// --- default environment (real fs + kiro-cli via the shared IO) ------------

/** Write a `{tools:[], mcpServers:{}}` agent so the model runs with no tools. */
function writeNoToolsAgent(cwd: string, name: string): void {
  const dir = path.join(cwd, ".kiro", "agents");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = {
    name,
    description: "Human Hindsight reflection runner; no tools, answer from provided content only.",
    prompt: DISTILL_SYSTEM,
    tools: [],
    mcpServers: {},
  };
  fs.writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** Run a kiro-cli subcommand purely to capture stdout (cleanup helpers). */
async function kiroCapture(io: RunnerIo, args: string[], cwd: string): Promise<string> {
  const bin = await io.which("kiro-cli");
  if (!bin) return "";
  const result = await io.spawn(bin, args, { input: "", timeoutMs: 30_000, cwd });
  return result.stdout;
}

/** The default kiro environment: real filesystem + real kiro-cli via defaultIo. */
export const defaultKiroEnv: KiroEnv = {
  io: defaultIo,
  sleep: realSleep,
  makeScratch(base) {
    // Home-scoped (<home>/runner-scratch/run-*): owner-only, easy
    // to find/debug, and unique per run. OS tmpdir is the no-home fallback.
    // The returned path is resolved so it matches the real cwd kiro-cli 3.x
    // records for the run's sessions (home is often a symlink).
    if (base) {
      fs.mkdirSync(base, { recursive: true, mode: 0o700 });
      return fs.realpathSync(fs.mkdtempSync(path.join(base, "run-")));
    }
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "human-hindsight-kiro-")));
  },
  removeScratch(dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  },
  writeAgent: writeNoToolsAgent,
  async listSessions(cwd) {
    // NB: --list-sessions/--delete-session are flags of the `chat` subcommand
    // (verified against kiro-cli 2.12.1: the top-level spelling is rejected
    // with "may be valid in newer versions").
    // 3.5.0 keeps the flags and the array-of-envelopes shape (current dir only
    // unless `--all-cwds`, which this never passes).
    const raw = await kiroCapture(this.io, ["chat", "--list-sessions", "--format", "json"], cwd);
    return parseKiroSessionListing(raw);
  },
  async deleteSession(sessionId) {
    // 3.x `--session-source` would narrow this to one store; the default (both
    // stores) is what cleanup wants. On 3.5.0 it removed both a v2-engine and a
    // v3-engine session.
    await kiroCapture(this.io, ["chat", "--delete-session", sessionId], process.cwd());
  },
  async version() {
    // The invocation depends on the answer, so a slow cold start gets the long timeout.
    return (await readVersion(this.io, "kiro", PROBE_TIMEOUT_MS.help)) ?? "";
  },
  realpath(p) {
    return fs.realpathSync(p);
  },
};

/**
 * The kiro-cli backend as an {@link AgentRunner}. A single per-*run* scratch cwd
 * is created lazily on first use and reused by every stage call (unique per run
 * ⇒ per-cwd listing isolation), then removed when the process exits.
 * Session-store cleanup happens ONCE per run via `finalize`, after all
 * concurrent workers join, under the deletion-scope invariant.
 *
 * `options.emptyRetries` is 0 only when the runner pool wraps this runner: the
 * pool then retries the transient empty output itself. Every other caller keeps
 * the standalone backoff.
 */
export function makeKiroRunner(
  env: KiroEnv = defaultKiroEnv,
  scratchBase?: string,
  options: { emptyRetries?: number; processEnv?: NodeJS.ProcessEnv } = {},
): AgentRunner {
  const emptyRetries = options.emptyRetries ?? KIRO_EMPTY_RETRIES;
  const processEnv = options.processEnv ?? process.env;
  let scratch: string | null = null;
  let removeOnExit: (() => void) | undefined;
  const cost: KiroCost = { credits: 0 };
  const ensureScratch = (): string => {
    if (scratch === null) {
      scratch = env.makeScratch(scratchBase);
      // Best-effort remove the scratch dir on process exit (auto-saved sessions
      // are cleaned by finalize under the scope invariant; this just tidies the
      // local agent-config dir, never corpus safety).
      const dir = scratch;
      removeOnExit = () => env.removeScratch(dir);
      process.once("exit", removeOnExit);
    }
    return scratch;
  };
  return {
    name: "kiro",
    displayName: RUNNER_INFO.kiro.displayName,
    binary: RUNNER_INFO.kiro.binary,
    installHint: KIRO_INSTALL_HINT,
    version: () => readVersion(env.io, "kiro"),
    signInHint: () => readSignInHint(env.io, "kiro", {}, hasOutsideCredentials("kiro", processEnv)),
    listModels: () => readCatalog(env.io, "kiro"),
    acceptsEffort: () => effortFlag.get(env) === true,
    async preflight() {
      const bin = await requireBinary("kiro", env.io);
      const version = await readVersion(env.io, "kiro", PROBE_TIMEOUT_MS.help);
      const major = version ? parseKiroMajor(version) : null;
      const flags = major === null ? undefined : KIRO_CHAT_FLAGS[major];
      if (flags) {
        const advertised = await requireFlags(env.io, bin, "kiro", flags);
        effortFlag.set(env, advertised.has("--effort"));
      }
      // An unknown version is not cached, so the first call probes it again.
      if (major !== null) majorCache.set(env, Promise.resolve(major));
    },
    async run(opts) {
      requireConcreteModel(opts.model);
      return runKiro(opts, ensureScratch(), env, cost, emptyRetries);
    },
    costSummary: () =>
      cost.credits > 0 ? `≈ ${cost.credits.toFixed(2)} Kiro credits used this run` : undefined,
    finalize: async () => {
      if (scratch === null) return;
      const finished = scratch;
      scratch = null;
      if (removeOnExit) process.off("exit", removeOnExit);
      try {
        await cleanupScratchSessions(finished, env);
      } finally {
        try {
          env.removeScratch(finished);
        } catch {
          /* best effort */
        }
      }
    },
  };
}
