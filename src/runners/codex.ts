import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFilePrivate } from "../core/fsutil.js";
import { toJsonSchema } from "../distill/schemas.js";
import {
  codexDefaults,
  hasOutsideCredentials,
  missingBinaryHint,
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
  RetryableError,
  type RunnerEnv,
  type RunnerIo,
  requireConcreteModel,
  runWithCorrectiveRetry,
  snippet,
  stripFence,
  TOOL_BAN_LINE,
} from "./shared.js";
import type { AgentRunner, RunOptions } from "./types.js";

const CODEX_INSTALL_HINT = missingBinaryHint("codex");

/**
 * Provider error codes and types inside a Codex error message. Codex passes a
 * provider's JSON error body through as the message (captured:
 * `{"error":{"message":...,"type":...,"code":...}}`); only those two typed
 * fields are read, never the wording.
 */
function errorCodes(message: string): string[] {
  try {
    const body: unknown = JSON.parse(message);
    const error =
      body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
    if (!error || typeof error !== "object") return [];
    const { code, type } = error as { code?: unknown; type?: unknown };
    return [code, type].filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

/** Parse only completed agent messages; progress and tool output aren't answers. */
function eventResult(stdout: string): { text: string; error: string; model?: string } {
  let text = "";
  let error = "";
  let model: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === "item.completed" && event.item?.type === "agent_message") {
        if (typeof event.item.text === "string") text = event.item.text;
        if (typeof event.item.model === "string") model = event.item.model;
      } else if (
        event?.type === "turn.started" ||
        event?.type === "turn.completed" ||
        event?.type === "thread.started"
      ) {
        if (typeof event.model === "string") model = event.model;
        if (event.type === "turn.completed") error = "";
      } else if (event?.type === "turn.failed") {
        error = typeof event.error?.message === "string" ? event.error.message : "turn failed";
      } else if (event?.type === "error" && typeof event.message === "string") {
        error = event.message;
      }
    } catch {
      // A wrapper's progress line is not a model answer.
    }
  }
  return { text, error, model };
}

/** Flags every model call passes; all are present in `codex exec --help` of 0.171.0. */
const EXEC_FLAGS = [
  "--json",
  "--ephemeral",
  "--sandbox",
  "--output-schema",
  "--output-last-message",
  "--skip-git-repo-check",
  "--color",
  "--model",
  "--config",
] as const;

/** An empty MCP table merges with user configuration. Disable each enabled entry explicitly. */
function mcpDisableArgs(io: RunnerIo) {
  let cached: Promise<string[]> | undefined;
  async function discover(bin: string, cwd: string): Promise<string[]> {
    try {
      const result = await io.spawn(
        bin,
        ["mcp", "list", "--json", "-c", "plugins={}", "-c", "apps._default.enabled=false"],
        {
          input: "",
          cwd,
          timeoutMs: 5_000,
        },
      );
      if (result.code !== 0 || result.timedOut) return [];
      const servers: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(servers)) return [];
      // Dotted CLI overrides accept bare key segments. Never copy server config, command, or env.
      const names = new Set<string>();
      for (const server of servers) {
        if (
          server?.enabled === true &&
          typeof server.name === "string" &&
          /^[A-Za-z0-9_-]+$/.test(server.name)
        ) {
          names.add(server.name);
        }
      }
      return [...names].flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]);
    } catch {
      // Wrappers and older CLIs may support exec without a machine-readable MCP catalog.
      return [];
    }
  }
  return (bin: string, cwd: string) => (cached ??= discover(bin, cwd));
}

/**
 * codex exec provides schema-constrained JSON in a final-message file. Each call
 * gets a private scratch cwd and an ephemeral session so distilling history
 * doesn't generate more history to mine. Auth and model defaults stay with the
 * user's CLI; nothing here calls an API directly.
 */
export async function runCodex<T>(
  opts: RunOptions<T>,
  io: RunnerIo = defaultIo,
  disableMcp = mcpDisableArgs(io),
): Promise<T> {
  requireConcreteModel(opts.model);
  const bin = await requireBinary("codex", io);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "human-hindsight-codex-"));
  const schemaFile = path.join(scratch, "schema.json");
  const outputFile = path.join(scratch, "answer.json");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastOutput = "";
  let lastStderr = "";
  try {
    writeFilePrivate(schemaFile, JSON.stringify(toJsonSchema(opts.schema)));
    const args = [
      "exec",
      "--json",
      "--color",
      "never",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "-c",
      'approval_policy="never"',
      "--output-schema",
      schemaFile,
      "--output-last-message",
      outputFile,
      "-c",
      "project_doc_max_bytes=0",
      // Accepted by Codex 0.171.0 even with --strict-config, which rejects an
      // unknown -c key. Older versions ignore keys they do not know.
      "-c",
      `developer_instructions=${JSON.stringify(DISTILL_SYSTEM)}`,
    ];
    if (opts.disableTools ?? true) {
      args.push(
        "-c",
        "features.shell_tool=false",
        "-c",
        'web_search="disabled"',
        "-c",
        "mcp_servers={}",
        "-c",
        "apps._default.enabled=false",
        "-c",
        "plugins={}",
        ...(await disableMcp(bin, scratch)),
      );
    }
    if (opts.model) args.push("--model", opts.model);
    // Without this a call inherits the person's own setting for interactive work.
    if (opts.effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(opts.effort)}`);
    args.push("-"); // large prompts go through stdin, never the process argument list
    const prompt =
      (opts.disableTools ?? true) ? `${opts.prompt}${TOOL_BAN_LINE.codex}` : opts.prompt;
    let model = opts.model;
    const value = await runWithCorrectiveRetry(
      prompt,
      opts.schema,
      async (input) => {
        fs.rmSync(outputFile, { force: true }); // a retry must never read a stale answer
        const result = await io.spawn(bin, args, {
          input,
          timeoutMs,
          cwd: scratch,
          signal: opts.signal,
        });
        lastOutput = result.stdout;
        lastStderr = result.stderr;
        if (result.timedOut) {
          throw new AgentRunnerError("timeout", `codex call timed out after ${timeoutMs}ms`, {
            stderr: result.stderr,
            output: result.stdout,
          });
        }
        const events = eventResult(result.stdout);
        model = events.model ?? opts.model;
        if (result.code !== 0 || events.error) {
          throw new AgentRunnerError(
            cliErrorKind("codex", {
              message: events.error,
              codes: errorCodes(events.error),
              stderr: result.stderr,
            }),
            `codex exited ${result.code}: ${snippet(events.error || result.stderr || result.stdout) || "no output"}`,
            { stderr: result.stderr, output: result.stdout },
          );
        }
        let text = events.text;
        try {
          text = fs.readFileSync(outputFile, "utf8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        lastOutput = text || result.stdout;
        try {
          return JSON.parse(stripFence(text));
        } catch {
          throw new RetryableError(
            `codex final response was not valid JSON: ${snippet(text) || "empty response"}`,
          );
        }
      },
      (detail) =>
        new AgentRunnerError(
          "validation",
          `codex response failed schema validation after one retry: ${detail}`,
          { stderr: lastStderr, output: lastOutput },
        ),
    );
    opts.onResolved?.({ runner: "codex", model });
    return value;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * `deps.env` and `deps.readFile` locate the Codex config the CLI itself loads:
 * its default model keeps chosen models on the same region prefix, and a custom
 * provider makes a negative `codex login status` only a hint.
 */
export function makeCodexRunner(io: RunnerIo = defaultIo, deps: RunnerEnv = {}): AgentRunner {
  const env = deps.env ?? process.env;
  const disableMcp = mcpDisableArgs(io);
  const config = () => codexDefaults(env, deps.readFile);
  return {
    name: "codex",
    displayName: RUNNER_INFO.codex.displayName,
    binary: RUNNER_INFO.codex.binary,
    installHint: CODEX_INSTALL_HINT,
    version: () => readVersion(io, "codex"),
    signInHint: () =>
      readSignInHint(
        io,
        "codex",
        {},
        hasOutsideCredentials("codex", env) || Boolean(config().provider),
      ),
    listModels: () => readCatalog(io, "codex", {}, config().model),
    // `model_reasoning_effort` is a configuration key every supported version reads.
    acceptsEffort: () => true,
    async preflight() {
      // The version is shown, not required: no flag or output shape depends on it.
      await requireFlags(io, await requireBinary("codex", io), "codex", EXEC_FLAGS);
    },
    run: (opts) => runCodex(opts, io, disableMcp),
  };
}
