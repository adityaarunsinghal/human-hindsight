import { stripVTControlCharacters } from "node:util";
import type { RunnerErrorKind, RunnerName } from "./types.js";

/**
 * runners/failures.ts: what kind of failure a runner call ended in.
 *
 * The class decides what the runner pool does next (retry, step down a model,
 * switch CLI) and whether a stage's breaker counts the failure. It is read from
 * two places only:
 *
 *   1. the typed kind a runner attached to its error. A runner sets a specific
 *      kind only from its CLI's own error report: Claude's error envelope with
 *      `terminal_reason: "api_error"` and its `api_error_status`, Codex's
 *      `error` and `turn.failed` events, Kiro's `runError` event, OpenCode's
 *      `error` event, or stderr. Never from the answer text.
 *   2. stderr, for wording a CLI prints there.
 *
 * Every text rule below was taken from a real capture, kept in
 * test/fixtures/runner-errors/cases.json; the one marked "same shape" applies
 * a captured wording to another status code. Typed fields map as follows:
 *
 *   - Claude: `api_error_status` 429, 529 and other 5xx are `transient`; 402
 *     (the API's documented billing error) is `quota`.
 *   - Codex: `unexpected status` 429 or 5xx in its error event, or the
 *     provider error code `rate_limit_exceeded` or type `server_error`, are
 *     `transient`; the provider error code `insufficient_quota` is `quota`.
 *   - Kiro: empty output with exit 0 is `transient` (kiro.ts). No typed quota.
 *   - OpenCode: `statusCode` 429 or 5xx in its error event, and "database is
 *     locked" on stderr, are `transient`. No typed quota.
 *
 * Kiro's `runError.stage` is captured only as `auth` (sign-in) and `prompt`
 * (any request failure), so Kiro has no typed transient or quota signal beyond
 * its empty output. Without a typed signal a failure stays `cli-error`, which
 * two in a row turn into a switch.
 */

export type FailureClass = RunnerErrorKind;

/** Identical consecutive failures after which a stage stops starting new calls. */
export const SYSTEMIC_FAILURE_STREAK = 5;

const CLASSES: ReadonlySet<string> = new Set<FailureClass>([
  "sign-in",
  "missing-binary",
  "quota",
  "model-unavailable",
  "transient",
  "timeout",
  "validation",
  "cli-error",
]);

interface Rule {
  failure: FailureClass;
  pattern: RegExp;
  /** The typed HTTP status the report must also carry, when the rule needs one. */
  status?: number;
  /** The captured case in test/fixtures/runner-errors/cases.json. */
  fixture: string;
}

/** Wording a CLI writes to stderr. */
const STDERR_RULES: Record<RunnerName, readonly Rule[]> = {
  claude: [
    {
      failure: "model-unavailable",
      pattern: /^\[claude-code:unrecognized_model\]/m,
      fixture: "claude-unknown-model",
    },
  ],
  codex: [],
  kiro: [
    {
      failure: "sign-in",
      pattern: /^Not logged in\. .*`kiro-cli login`/m,
      fixture: "kiro-signed-out",
    },
  ],
  opencode: [
    {
      // Several OpenCode processes at once: its own local database refused work.
      failure: "transient",
      pattern: /^database is locked$/m,
      fixture: "opencode-database-locked",
    },
  ],
};

/** Wording in a CLI's own typed error event or error envelope. */
const REPORT_RULES: Record<RunnerName, readonly Rule[]> = {
  claude: [
    { failure: "sign-in", pattern: /^Not logged in\b/, fixture: "claude-signed-out" },
    {
      failure: "sign-in",
      pattern: /\bCould not load credentials from any providers\b/,
      fixture: "claude-signed-out-cloud-credentials",
    },
    {
      failure: "model-unavailable",
      pattern: /\bThe provided model identifier is invalid\b/,
      fixture: "claude-unknown-model",
    },
    {
      // A cloud provider that refuses one model under the account's settings.
      failure: "model-unavailable",
      pattern: /\bis not available for this model\.?$/,
      status: 400,
      fixture: "claude-model-refused-by-provider",
    },
  ],
  codex: [
    {
      failure: "sign-in",
      pattern: /\bunexpected status 401 Unauthorized\b/,
      fixture: "codex-signed-out",
    },
    {
      // Same shape: the HTTP status Codex reports, as in the captured 401 above.
      failure: "transient",
      pattern: /\bunexpected status (?:429|5\d\d)\b/,
      fixture: "codex-signed-out",
    },
    {
      failure: "model-unavailable",
      pattern: /\bThe provided model identifier is invalid\b/,
      fixture: "codex-unknown-model",
    },
  ],
  kiro: [
    {
      failure: "model-unavailable",
      pattern: /\bThe model '[^'\n]+' is not available\b/,
      fixture: "kiro-unknown-model",
    },
    { failure: "sign-in", pattern: /^Not logged in\./, fixture: "kiro-signed-out" },
  ],
  opencode: [],
};

function match(
  rules: readonly Rule[],
  text: string | undefined,
  status?: number,
): FailureClass | undefined {
  if (!text) return undefined;
  const clean = stripVTControlCharacters(text).trim();
  return rules.find(
    (rule) => (rule.status === undefined || rule.status === status) && rule.pattern.test(clean),
  )?.failure;
}

/** A CLI's own error report, as a runner extracted it from the CLI's output. */
export interface CliErrorReport {
  /** Text of the CLI's typed error event or error envelope. Never the answer. */
  message?: string;
  /** A structured stage field, when the CLI has one (Kiro's `runError.stage`). */
  stage?: string;
  /** An HTTP status the CLI reported as a typed field (Claude's `api_error_status`). */
  status?: number;
  /** Provider error codes and types the CLI passed through as typed fields. */
  codes?: readonly string[];
  stderr?: string;
}

/** Typed HTTP statuses. 429 and 5xx (529 is "overloaded") are worth a retry. */
function statusKind(runner: RunnerName, status: number | undefined): FailureClass | undefined {
  if (status === undefined || !Number.isInteger(status)) return undefined;
  if (status === 429 || (status >= 500 && status <= 599)) return "transient";
  // Documented by the Claude API as its billing error.
  if (runner === "claude" && status === 402) return "quota";
  return undefined;
}

/** Typed provider error codes and types, as documented by the provider's API. */
const CODE_KINDS: Partial<Record<RunnerName, Readonly<Record<string, FailureClass>>>> = {
  codex: {
    insufficient_quota: "quota",
    rate_limit_exceeded: "transient",
    server_error: "transient",
  },
};

function codeKind(runner: RunnerName, codes: readonly string[] = []): FailureClass | undefined {
  const known = CODE_KINDS[runner] ?? {};
  const code = codes.find((value) => Object.hasOwn(known, value));
  return code === undefined ? undefined : known[code];
}

/**
 * The error kind a runner attaches when its CLI reported a failure. Used by the
 * runners at the point they build their error; the pool and the breakers then
 * read only that kind (and stderr) through {@link classifyFailure}.
 */
export function cliErrorKind(runner: RunnerName, report: CliErrorReport): FailureClass {
  if (runner === "kiro" && report.stage === "auth") return "sign-in";
  return (
    codeKind(runner, report.codes) ??
    statusKind(runner, report.status) ??
    match(REPORT_RULES[runner], report.message, report.status) ??
    match(STDERR_RULES[runner], report.stderr) ??
    "cli-error"
  );
}

/** Classify a runner failure from its typed kind and its stderr, nothing else. */
export function classifyFailure(runner: RunnerName, err: unknown): FailureClass {
  const failure = err && typeof err === "object" ? (err as Record<string, unknown>) : {};
  const kind = typeof failure.kind === "string" ? failure.kind : undefined;
  if (kind && kind !== "cli-error" && CLASSES.has(kind)) return kind as FailureClass;
  // Node's own report that the executable could not be started.
  if (
    failure.code === "ENOENT" &&
    typeof failure.syscall === "string" &&
    failure.syscall.startsWith("spawn")
  ) {
    return "missing-binary";
  }
  const stderr = typeof failure.stderr === "string" ? failure.stderr : undefined;
  return match(STDERR_RULES[runner], stderr) ?? "cli-error";
}
