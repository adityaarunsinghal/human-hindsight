import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toJsonSchema } from "../claude/schemas.js";
import { writeFilePrivate } from "../core/fsutil.js";
import {
  AgentRunnerError,
  DEFAULT_TIMEOUT_MS,
  defaultIo,
  RetryableError,
  type RunnerIo,
  runWithCorrectiveRetry,
  snippet,
  stripFence,
} from "./shared.js";
import type { AgentRunner, RunOptions } from "./types.js";

export const CODEX_INSTALL_HINT =
  "`codex` CLI not found on PATH. Install it with `npm install -g @openai/codex`, " +
  "then run `codex login`. Deterministic commands (scan/export) work without it.";

/** Parse only completed agent messages; progress and tool output aren't answers. */
function eventResult(stdout: string): { text: string; error: string } {
  let text = "";
  let error = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === "item.completed" && event.item?.type === "agent_message") {
        if (typeof event.item.text === "string") text = event.item.text;
      } else if (event?.type === "turn.failed") {
        error = typeof event.error?.message === "string" ? event.error.message : "turn failed";
      } else if (event?.type === "error" && typeof event.message === "string") {
        error = event.message;
      }
    } catch {
      // A wrapper's progress line is not a model answer.
    }
  }
  return { text, error };
}

/**
 * codex exec provides schema-constrained JSON in a final-message file. Each call
 * gets a private scratch cwd and an ephemeral session so distilling history
 * doesn't generate more history to mine. Auth and model defaults stay with the
 * user's CLI; nothing here calls an API directly.
 */
export async function runCodex<T>(opts: RunOptions<T>, io: RunnerIo = defaultIo): Promise<T> {
  const bin = await io.which("codex");
  if (!bin) throw new AgentRunnerError("missing-binary", CODEX_INSTALL_HINT);
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
      );
    }
    if (opts.model) args.push("--model", opts.model);
    args.push("-"); // large prompts go through stdin, never the process argument list
    const prompt =
      (opts.disableTools ?? true)
        ? `${opts.prompt}\n\nDo not use any tools. Answer directly from the supplied content with JSON matching the output schema.`
        : opts.prompt;
    return await runWithCorrectiveRetry(
      prompt,
      opts.schema,
      async (input) => {
        fs.rmSync(outputFile, { force: true }); // a retry must never read a stale answer
        const result = await io.spawn(bin, args, { input, timeoutMs, cwd: scratch });
        lastOutput = result.stdout;
        lastStderr = result.stderr;
        if (result.timedOut) {
          throw new AgentRunnerError("timeout", `codex invocation timed out after ${timeoutMs}ms`, {
            stderr: result.stderr,
            output: result.stdout,
          });
        }
        const events = eventResult(result.stdout);
        if (result.code !== 0 || events.error) {
          throw new AgentRunnerError(
            "cli-error",
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
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export const codexRunner: AgentRunner = {
  name: "codex",
  installHint: CODEX_INSTALL_HINT,
  run: (opts) => runCodex(opts),
};
