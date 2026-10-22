import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toJsonSchema } from "../claude/schemas.js";
import { mkdirPrivate } from "../core/fsutil.js";
import { OPENCODE_DISTILL_MARKER, object } from "../sources/opencode/extract.js";
import { resolveOpenCodePaths } from "../sources/opencode/paths.js";
import { openOpenCodeDatabase } from "../sources/opencode/store.js";
import { configureOpenCode, OPENCODE_AGENT, providerConfig } from "./opencode-config.js";
import {
  AgentRunnerError,
  DEFAULT_TIMEOUT_MS,
  defaultIo,
  embedSchema,
  RetryableError,
  type RunnerIo,
  runWithCorrectiveRetry,
  type SpawnOptions,
  type SpawnResult,
  snippet,
  stripFence,
} from "./shared.js";
import type { AgentRunner, RunOptions } from "./types.js";

export const OPENCODE_INSTALL_HINT =
  "`opencode` CLI not found on PATH. Install with `npm install -g @opencode/cli`, then configure a provider in OpenCode. Scan/export work without the CLI.";

interface Capabilities {
  major: 1 | 2;
}
const probes = new WeakMap<RunnerIo, Map<string, Promise<Capabilities>>>();
function probe(io: RunnerIo, bin: string): Promise<Capabilities> {
  let cache = probes.get(io);
  if (!cache) {
    cache = new Map();
    probes.set(io, cache);
  }
  const existing = cache.get(bin);
  if (existing) return existing;
  const pending = (async () => {
    const opts = { input: "", timeoutMs: 10_000 };
    const version = await io.spawn(bin, ["--version"], opts);
    const match = version.stdout.match(/\bv?(\d+)\.(\d+)\.(\d+)\b/);
    const major = Number(match?.[1]);
    if (version.code !== 0 || !match || (major !== 1 && major !== 2)) {
      throw new AgentRunnerError(
        "cli-error",
        "Cannot identify a supported OpenCode 1.x/2.x CLI version.",
      );
    }
    const help = await io.spawn(bin, ["run", "--help"], opts);
    const flags = help.stdout + help.stderr;
    if (
      help.code !== 0 ||
      !["--format", "--agent", "--title", major === 1 ? "--pure" : "--standalone"].every((flag) =>
        flags.includes(flag),
      )
    ) {
      throw new AgentRunnerError(
        "cli-error",
        "This OpenCode CLI lacks required runner options. Update OpenCode (tested with 1.19 and 2.1).",
      );
    }
    return { major: major as 1 | 2 };
  })().catch((error: unknown) => {
    if (error instanceof AgentRunnerError) throw error;
    throw new AgentRunnerError("cli-error", "Could not inspect the installed OpenCode CLI.");
  });
  cache.set(bin, pending);
  return pending;
}

/** Completed text parts only; JSON events themselves are never model answers. */
export function parseOpenCodeOutput(stdout: string): {
  text: string;
  error: string;
  sessions: string[];
  cost: number;
} {
  const messages = new Map<string, Map<string, string>>();
  const sessions = new Set<string>();
  const finished = new Set<string>();
  let lastMessage = "";
  let error = "";
  let cost = 0;
  for (const line of stdout.split(/\r?\n/)) {
    let event: Record<string, unknown> | undefined;
    try {
      event = object(JSON.parse(line));
    } catch {
      continue;
    }
    if (!event) continue;
    if (typeof event.sessionID === "string" && /^ses_[\w-]+$/.test(event.sessionID))
      sessions.add(event.sessionID);
    const part = object(event.part);
    if (event.type === "text" && part && typeof part.text === "string") {
      const message = typeof part.messageID === "string" ? part.messageID : "answer";
      const key =
        typeof part.id === "string"
          ? part.id
          : typeof part.partID === "string"
            ? part.partID
            : String(messages.get(message)?.size ?? 0);
      const parts = messages.get(message) ?? new Map<string, string>();
      parts.set(key, part.text);
      messages.set(message, parts);
      lastMessage = message;
    }
    if (event.type === "error") {
      const detail = object(event.error);
      error =
        typeof detail?.message === "string"
          ? detail.message
          : typeof object(detail?.data)?.message === "string"
            ? String(object(detail?.data)?.message)
            : typeof detail?.name === "string"
              ? detail.name
              : "OpenCode reported an error";
    }
    if (event.type === "step_finish" && part) {
      const id = String(part.id ?? part.messageID ?? line);
      if (
        !finished.has(id) &&
        typeof part.cost === "number" &&
        Number.isFinite(part.cost) &&
        part.cost >= 0
      )
        cost += part.cost;
      finished.add(id);
    }
  }
  return {
    text: [...(messages.get(lastMessage)?.values() ?? [])].join(""),
    error,
    sessions: [...sessions],
    cost,
  };
}

interface Context {
  bin: string;
  major: 1 | 2;
  scratch: string;
  title: string;
  db: string;
  sessions: Set<string>;
  options: SpawnOptions;
}

/** Cleanup is scoped by ID AND our exact scratch directory/title, never a title search. */
function ownedSession(context: Context, id: string): boolean {
  if (context.db === ":memory:" || !fs.existsSync(context.db)) return false;
  const db = openOpenCodeDatabase(context.db);
  try {
    const table = context.major === 1 ? "session" : "session_v2";
    const row = db.prepare(`SELECT title, directory, parent_id FROM ${table} WHERE id=?`).get(id);
    return (
      row?.title === context.title &&
      typeof row.directory === "string" &&
      fs.realpathSync(row.directory) === fs.realpathSync(context.scratch) &&
      !row.parent_id
    );
  } finally {
    db.close();
  }
}

export function makeOpenCodeRunner(io: RunnerIo = defaultIo, scratchBase?: string): AgentRunner {
  const contexts: Context[] = [];
  let cost = 0;
  return {
    name: "opencode",
    installHint: OPENCODE_INSTALL_HINT,
    async run<T>(opts: RunOptions<T>): Promise<T> {
      const bin = await io.which("opencode");
      if (!bin) throw new AgentRunnerError("missing-binary", OPENCODE_INSTALL_HINT);
      const { major } = await probe(io, bin);
      const settings = providerConfig(major);
      const base = scratchBase ?? os.tmpdir();
      if (scratchBase) mkdirPrivate(scratchBase);
      const scratch = fs.mkdtempSync(path.join(base, "human-hindsight-opencode-"));
      const title = `${OPENCODE_DISTILL_MARKER} ${randomUUID()}`;
      let env: NodeJS.ProcessEnv;
      try {
        env = configureOpenCode(scratch, major, settings);
      } catch {
        fs.rmSync(scratch, { recursive: true, force: true });
        throw new AgentRunnerError(
          "cli-error",
          "Could not prepare the private OpenCode runner configuration.",
        );
      }
      const dataEnv = {
        ...process.env,
        HUMAN_HINDSIGHT_OPENCODE_DIR: undefined,
        HUMAN_HINDSIGHT_OPENCODE_DB: undefined,
      };
      const context: Context = {
        bin,
        major,
        scratch,
        title,
        db: resolveOpenCodePaths({}, dataEnv).opencodeDb,
        sessions: new Set(),
        options: {
          cwd: scratch,
          env,
          processGroup: true,
          input: "",
          timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        },
      };
      contexts.push(context);
      const args = [
        "run",
        "--format",
        "json",
        "--agent",
        OPENCODE_AGENT,
        "--title",
        title,
        major === 1 ? "--pure" : "--standalone",
      ];
      if (opts.model) args.push("--model", opts.model);
      const input = embedSchema(
        `${OPENCODE_DISTILL_MARKER}\n${opts.prompt}`,
        JSON.stringify(toJsonSchema(opts.schema)),
      );
      return runWithCorrectiveRetry(
        input,
        opts.schema,
        async (prompt) => {
          let result: SpawnResult;
          try {
            result = await io.spawn(bin, args, { ...context.options, input: prompt });
          } catch {
            throw new AgentRunnerError("cli-error", "Could not start the OpenCode CLI.");
          }
          const parsed = parseOpenCodeOutput(result.stdout);
          for (const id of parsed.sessions) context.sessions.add(id);
          cost += parsed.cost;
          if (result.timedOut)
            throw new AgentRunnerError(
              "timeout",
              "OpenCode timed out; its owned processes were terminated.",
            );
          if (result.code !== 0 || parsed.error) {
            throw new AgentRunnerError(
              "cli-error",
              `OpenCode failed: ${snippet(parsed.error || result.stderr || "no error detail")}`,
            );
          }
          try {
            return JSON.parse(stripFence(parsed.text));
          } catch {
            throw new RetryableError("OpenCode final answer was not valid JSON");
          }
        },
        (detail) =>
          new AgentRunnerError(
            "validation",
            `OpenCode response failed validation after one retry: ${detail}`,
          ),
      );
    },
    costSummary: () => (cost > 0 ? `OpenCode reported cost: $${cost.toFixed(4)}` : undefined),
    async finalize() {
      for (const context of contexts.splice(0)) {
        try {
          for (const id of context.sessions) {
            if (!ownedSession(context, id)) continue;
            const args = [
              "session",
              "delete",
              id,
              ...(context.major === 2 ? ["--standalone"] : ["--pure"]),
            ];
            const result = await io.spawn(context.bin, args, {
              ...context.options,
              input: "",
              timeoutMs: 10_000,
            });
            if (result.code !== 0 || result.timedOut) {
              process.stderr.write(
                "OpenCode could not remove a generated distillation session; Human Hindsight excludes it from exports.\n",
              );
            }
          }
        } catch {
          process.stderr.write(
            "OpenCode session cleanup was unavailable; generated sessions remain excluded from exports.\n",
          );
        } finally {
          try {
            fs.rmSync(context.scratch, { recursive: true, force: true });
          } catch {
            process.stderr.write(
              `Could not remove the private OpenCode scratch directory: ${context.scratch}\n`,
            );
          }
        }
      }
    },
  };
}

export async function runOpenCode<T>(opts: RunOptions<T>, io: RunnerIo = defaultIo): Promise<T> {
  const runner = makeOpenCodeRunner(io);
  try {
    return await runner.run(opts);
  } finally {
    await runner.finalize?.();
  }
}
