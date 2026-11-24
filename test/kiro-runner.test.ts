import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ClaudeRunnerError } from "../src/runners/claude.js";
import {
  cleanupScratchSessions,
  KIRO_NO_TOOLS_AGENT,
  type KiroEnv,
  kiroChatArgs,
  makeKiroRunner,
  parseKiroMajor,
  parseKiroSessionListing,
  parseKiroStream,
  runKiro,
} from "../src/runners/kiro.js";
import type { RunnerIo, SpawnResult } from "../src/runners/shared.js";
import type { RunOptions } from "../src/runners/types.js";

const Schema = z.object({ ok: z.boolean(), note: z.string() });
type Out = z.infer<typeof Schema>;

const SCRATCH = "/tmp/scratch-run-1";

function spawnResult(over: Partial<SpawnResult> = {}): SpawnResult {
  return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, ...over };
}

/** A KiroEnv whose spawn returns a scripted queue of results; records calls. */
function makeEnv(
  results: SpawnResult[],
  opts: {
    listSessions?: KiroEnv["listSessions"];
    deleteSession?: (id: string) => Promise<void>;
    which?: string | null;
  } = {},
): {
  env: KiroEnv;
  calls: { args: string[]; input: string; cwd?: string }[];
  agentsWritten: { cwd: string; name: string }[];
  deleted: string[];
  sleeps: number[];
} {
  const calls: { args: string[]; input: string; cwd?: string }[] = [];
  const agentsWritten: { cwd: string; name: string }[] = [];
  const deleted: string[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const io: RunnerIo = {
    which: () => (opts.which === undefined ? "/usr/bin/kiro-cli" : opts.which),
    spawn: async (_bin, args, o) => {
      calls.push({ args, input: o.input, cwd: o.cwd });
      return results[i++] ?? spawnResult();
    },
  };
  const env: KiroEnv = {
    io,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    makeScratch: () => SCRATCH,
    removeScratch: () => {},
    writeAgent: (cwd, name) => agentsWritten.push({ cwd, name }),
    listSessions: opts.listSessions ?? (async () => []),
    deleteSession:
      opts.deleteSession ??
      (async (id) => {
        deleted.push(id);
      }),
  };
  return { env, calls, agentsWritten, deleted, sleeps };
}

const OPTS: RunOptions<Out> = { prompt: "digest this", schema: Schema };

describe("runKiro: happy path", () => {
  it("parses ANSI-decorated, fenced JSON from stdout", async () => {
    // Leading `> ` glyph + ANSI color + a ```json fence: all must be stripped.
    const stdout = '[38;5;141m> [0m```json\n{"ok":true,"note":"hi"}\n```';
    const { env, agentsWritten } = makeEnv([spawnResult({ stdout })]);
    const out = await runKiro(OPTS, SCRATCH, env);
    expect(out).toEqual({ ok: true, note: "hi" });
    // The no-tools agent is written into the scratch cwd before the call.
    expect(agentsWritten).toEqual([{ cwd: SCRATCH, name: KIRO_NO_TOOLS_AGENT }]);
  });

  it("spawns with the no-interactive + agent args and the scratch cwd", async () => {
    const { env, calls } = makeEnv([spawnResult({ stdout: '{"ok":true,"note":"x"}' })]);
    await runKiro(OPTS, SCRATCH, env);
    expect(calls[0]?.args).toEqual(["chat", "--no-interactive", "--agent", KIRO_NO_TOOLS_AGENT]);
    expect(calls[0]?.cwd).toBe(SCRATCH);
    // Prompt carries the self-recognition sentinel as its first line, then the
    // same tool ban as earlier releases, then the schema.
    expect(calls[0]?.input).toMatch(
      /^\[human-hindsight distill\]\ndigest this\n\nDo not use any tools; answer directly from the content provided\.\n\nRespond ONLY with JSON matching this schema:\n\{/,
    );
  });
});

describe("runKiro: empty-stdout transient backoff (below corrective retry)", () => {
  it("retries the SAME input on empty stdout + exit 0, then succeeds", async () => {
    const { env, calls, sleeps } = makeEnv([
      spawnResult({ stdout: "" }), // transient failure 1
      spawnResult({ stdout: "" }), // transient failure 2
      spawnResult({ stdout: '{"ok":true,"note":"recovered"}' }), // success
    ]);
    const out = await runKiro(OPTS, SCRATCH, env);
    expect(out.note).toBe("recovered");
    // 3 spawns, 2 backoff sleeps, and NO corrective note (same input each time).
    expect(calls.length).toBe(3);
    expect(sleeps.length).toBe(2);
    expect(calls[0]?.input).toBe(calls[2]?.input);
  });

  it("throws transient after exhausting empty-stdout retries", async () => {
    const { env } = makeEnv([
      spawnResult({ stdout: "" }),
      spawnResult({ stdout: "" }),
      spawnResult({ stdout: "" }),
    ]);
    await expect(runKiro(OPTS, SCRATCH, env)).rejects.toMatchObject({
      kind: "transient",
    });
  });

  it("an adapter keeps the backoff unless the pool wraps it", async () => {
    const empty = () => [spawnResult({ stdout: "" }), spawnResult({ stdout: "" })];
    const standalone = makeEnv([...empty(), spawnResult({ stdout: '{"ok":true,"note":"x"}' })]);
    expect((await makeKiroRunner(standalone.env).run(OPTS)).note).toBe("x");
    expect(standalone.sleeps).toEqual([500, 2000]);

    const pooled = makeEnv(empty());
    await expect(
      makeKiroRunner(pooled.env, undefined, { emptyRetries: 0 }).run(OPTS),
    ).rejects.toMatchObject({ kind: "transient" });
    expect(pooled.calls).toHaveLength(1);
    expect(pooled.sleeps).toEqual([]);
  });
});

describe("runKiro: corrective retry on bad JSON (above transport retry)", () => {
  it("retries once with a corrective note when stdout is non-empty but unparseable", async () => {
    const { env, calls } = makeEnv([
      spawnResult({ stdout: "here you go: not json at all" }),
      spawnResult({ stdout: '{"ok":true,"note":"fixed"}' }),
    ]);
    const out = await runKiro(OPTS, SCRATCH, env);
    expect(out.note).toBe("fixed");
    // Second attempt carries the corrective note.
    expect(calls[1]?.input).toContain("previous response could not be used");
  });

  it("throws validation after a second unparseable response", async () => {
    const { env } = makeEnv([
      spawnResult({ stdout: "garbage one" }),
      spawnResult({ stdout: "garbage two" }),
    ]);
    await expect(runKiro(OPTS, SCRATCH, env)).rejects.toMatchObject({ kind: "validation" });
  });
});

describe("runKiro: errors", () => {
  it("throws missing-binary when kiro-cli is absent", async () => {
    const { env } = makeEnv([], { which: null });
    await expect(runKiro(OPTS, SCRATCH, env)).rejects.toMatchObject({ kind: "missing-binary" });
  });

  it("throws cli-error on a non-zero exit", async () => {
    const { env } = makeEnv([spawnResult({ code: 1, stderr: "auth expired" })]);
    await expect(runKiro(OPTS, SCRATCH, env)).rejects.toMatchObject({ kind: "cli-error" });
  });

  it("throws timeout when the spawn times out", async () => {
    const { env } = makeEnv([spawnResult({ timedOut: true })]);
    await expect(runKiro(OPTS, SCRATCH, env)).rejects.toMatchObject({ kind: "timeout" });
  });

  it("errors are AgentRunnerError instances (ClaudeRunnerError alias)", async () => {
    const { env } = makeEnv([spawnResult({ code: 1 })]);
    await expect(runKiro(OPTS, SCRATCH, env)).rejects.toBeInstanceOf(ClaudeRunnerError);
  });
});

describe("kiro runner: session-store cleanup via finalize (deletion-safety invariant)", () => {
  const LISTING = [
    {
      cwd: SCRATCH,
      sessions: [
        { sessionId: "mine-1", title: "[human-hindsight distill] digest this" },
        { sessionId: "not-mine", title: "some human session that happened to share cwd" },
      ],
    },
    {
      cwd: "/home/user/real-project",
      sessions: [{ sessionId: "REAL", title: "[human-hindsight distill] looks like ours" }],
    },
  ];

  it("finalize deletes ONLY sentinel-titled sessions in the scratch cwd group, and only ONCE per run, never mid-call", async () => {
    const deleted: string[] = [];
    const { env } = makeEnv([spawnResult({ stdout: '{"ok":true,"note":"x"}' })], {
      listSessions: async () => LISTING,
      deleteSession: async (id) => {
        deleted.push(id);
      },
    });
    const runner = makeKiroRunner(env);
    await runner.run(OPTS);
    // No cleanup mid-run: a concurrent sibling's in-flight session can never be
    // list-and-deleted by a worker that finished earlier.
    expect(deleted).toEqual([]);
    await runner.finalize?.();
    // Only the scratch-cwd sentinel session is deleted; the other cwd group and
    // the non-sentinel session in-scope both survive.
    expect(deleted).toEqual(["mine-1"]);
  });

  it("finalize cleans up after a failed run too and never throws", async () => {
    const deleted: string[] = [];
    const { env } = makeEnv([spawnResult({ code: 1, stderr: "boom" })], {
      listSessions: async () => [
        { cwd: SCRATCH, sessions: [{ sessionId: "s1", title: "[human-hindsight distill] x" }] },
      ],
      deleteSession: async (id) => {
        deleted.push(id);
      },
    });
    const runner = makeKiroRunner(env);
    await expect(runner.run(OPTS)).rejects.toMatchObject({ kind: "cli-error" });
    await runner.finalize?.();
    expect(deleted).toEqual(["s1"]); // cleanup still happened, once, at run end
  });

  it("finalize before any call is a no-op (no scratch dir was ever created)", async () => {
    let listed = 0;
    const { env } = makeEnv([], {
      listSessions: async () => {
        listed++;
        return [];
      },
    });
    const runner = makeKiroRunner(env);
    await runner.finalize?.();
    expect(listed).toBe(0);
  });
});

describe("kiro runner: cost accounting (Credits stderr footer)", () => {
  it("accumulates per-call credits into costSummary", async () => {
    const { env } = makeEnv([
      spawnResult({ stdout: '{"ok":true,"note":"a"}', stderr: "▸ Credits: 0.32 • Time: 4s" }),
      spawnResult({ stdout: '{"ok":true,"note":"b"}', stderr: "▸ Credits: 0.5 • Time: 2s" }),
    ]);
    const runner = makeKiroRunner(env);
    expect(runner.costSummary?.()).toBeUndefined(); // nothing spent yet
    await runner.run(OPTS);
    await runner.run(OPTS);
    expect(runner.costSummary?.()).toBe("≈ 0.82 Kiro credits used this run");
  });

  it("stays undefined when stderr carries no credits line", async () => {
    const { env } = makeEnv([spawnResult({ stdout: '{"ok":true,"note":"a"}' })]);
    const runner = makeKiroRunner(env);
    await runner.run(OPTS);
    expect(runner.costSummary?.()).toBeUndefined();
  });
});

describe("kiro runner: scratch cwd location", () => {
  it("threads the home-scoped scratchBase into env.makeScratch", async () => {
    const bases: (string | undefined)[] = [];
    const { env } = makeEnv([spawnResult({ stdout: '{"ok":true,"note":"x"}' })]);
    const recordingEnv: KiroEnv = {
      ...env,
      makeScratch: (base?: string) => {
        bases.push(base);
        return SCRATCH;
      },
    };
    const runner = makeKiroRunner(recordingEnv, "/home/u/.human-hindsight/runner-scratch");
    await runner.run(OPTS);
    expect(bases).toEqual(["/home/u/.human-hindsight/runner-scratch"]);
  });
});

describe("runKiro: sentinel echo in output (negative fixture)", () => {
  it("a sentinel-echoing non-JSON response feeds the corrective retry, never store corruption", async () => {
    // The model parrots the K13 sentinel back: the line is not valid JSON, so
    // it must land in the corrective retry; the store is untouched either way
    // (cleanup scope + K13 protect it).
    const { env, calls } = makeEnv([
      spawnResult({ stdout: '> [human-hindsight distill] {"ok":true,"note":"echoed"}' }),
      spawnResult({ stdout: '{"ok":true,"note":"clean"}' }),
    ]);
    const out = await runKiro(OPTS, SCRATCH, env);
    expect(out.note).toBe("clean");
    expect(calls[1]?.input).toContain("previous response could not be used");
  });
});

// --- kiro-cli 3.x ------------------------------------------------------------

const FIX = path.join(import.meta.dirname, "fixtures", "kiro-runner");
const fixture = (name: string) => fs.readFileSync(path.join(FIX, name), "utf8");

/** makeEnv plus a `--version` answer, so runKiro takes the 3.x path. */
function makeEnv3(results: SpawnResult[], version = "kiro-cli 3.5.0\n") {
  const made = makeEnv(results);
  let versionCalls = 0;
  made.env.version = async () => {
    versionCalls++;
    return version;
  };
  return { ...made, versionCalls: () => versionCalls };
}

describe("kiro-cli version detection", () => {
  it("reads the major from `kiro-cli --version` output", () => {
    expect(parseKiroMajor("kiro-cli 3.5.0\n")).toBe(3);
    expect(parseKiroMajor("kiro-cli 2.12.1")).toBe(2);
    expect(parseKiroMajor("")).toBeNull();
    expect(parseKiroMajor("kiro-cli unknown")).toBeNull();
  });

  it("3.x args pin the v2 engine and stream-json; 2.x and unknown keep the old args", () => {
    expect(kiroChatArgs(3, "claude-sonnet-5.5")).toEqual([
      "chat",
      "--no-interactive",
      "--agent",
      KIRO_NO_TOOLS_AGENT,
      "--agent-engine",
      "v2",
      "--output-format",
      "stream-json",
      "--model",
      "claude-sonnet-5.5",
    ]);
    const old = ["chat", "--no-interactive", "--agent", KIRO_NO_TOOLS_AGENT];
    expect(kiroChatArgs(2)).toEqual(old);
    expect(kiroChatArgs(null)).toEqual(old);
  });

  it("probes the version once per environment, not once per call", async () => {
    const out = fixture("stream-json-v2-engine-3.5.0.jsonl");
    const { env, calls, versionCalls } = makeEnv3([
      spawnResult({ stdout: out }),
      spawnResult({ stdout: out }),
    ]);
    const opts: RunOptions<unknown> = {
      prompt: "p",
      schema: z.object({ ok: z.boolean(), tools: z.string() }),
    };
    await runKiro(opts, SCRATCH, env);
    await runKiro(opts, SCRATCH, env);
    expect(versionCalls()).toBe(1);
    expect(calls[0]?.args).toContain("stream-json");
  });

  it("a failing version probe falls back to the 2.x invocation", async () => {
    const { env, calls } = makeEnv([spawnResult({ stdout: '{"ok":true,"note":"x"}' })]);
    env.version = async () => {
      throw new Error("spawn failed");
    };
    await runKiro(OPTS, SCRATCH, env);
    expect(calls[0]?.args).toEqual(["chat", "--no-interactive", "--agent", KIRO_NO_TOOLS_AGENT]);
  });
});

describe("kiro-cli 3.x stream-json output", () => {
  const ToolsSchema = z.object({ ok: z.boolean(), tools: z.string() });
  const TOOLS_OPTS: RunOptions<z.infer<typeof ToolsSchema>> = {
    prompt: "probe",
    schema: ToolsSchema,
    model: "claude-sonnet-5.5",
  };

  it("parses the real v2-engine capture: finalText and meteringUsage credits", () => {
    const r = parseKiroStream(fixture("stream-json-v2-engine-3.5.0.jsonl"));
    expect(r.text).toBe('{"ok":true,"tools":"<NONE>"}');
    expect(r.credits).toBeCloseTo(0.012161389402985074, 12);
  });

  it("parses the real v3-engine capture: finalText and session_usage credits, thoughts ignored", () => {
    const r = parseKiroStream(fixture("stream-json-v3-engine-3.5.0.jsonl"));
    expect(r.text).toBe('{"ok":true,"tools":"load_resource"}');
    expect(r.credits).toBeCloseTo(0.0831343797512438, 12);
  });

  it("joins message chunks when finalText is truncated, and never includes thought chunks", () => {
    const stdout = fixture("stream-json-v3-engine-3.5.0.jsonl").replace(
      '"finalTextTruncated":false',
      '"finalTextTruncated":true',
    );
    expect(parseKiroStream(stdout).text).toBe('{"ok":true,"tools":"load_resource"}');
  });

  it("falls back to the raw stdout when nothing parses as an event", () => {
    expect(parseKiroStream('> {"ok":true}')).toEqual({ text: '> {"ok":true}', credits: 0 });
  });

  it("runKiro on 3.x returns the validated answer and adds the streamed credits", async () => {
    const { env } = makeEnv3([
      spawnResult({ stdout: fixture("stream-json-v2-engine-3.5.0.jsonl") }),
    ]);
    const runner = makeKiroRunner(env);
    const out = await runner.run(TOOLS_OPTS);
    expect(out).toEqual({ ok: true, tools: "<NONE>" });
    expect(runner.costSummary?.()).toBe("≈ 0.01 Kiro credits used this run");
  });

  it("an empty stream (runStarted only, exit 0) is the transient path: same input retried", async () => {
    const started = '{"type":"runStarted","data":{"payloadSchema":"acp","engine":"v2"}}\n';
    const { env, calls, sleeps } = makeEnv3([
      spawnResult({ stdout: started }),
      spawnResult({ stdout: fixture("stream-json-v2-engine-3.5.0.jsonl") }),
    ]);
    const out = await runKiro(TOOLS_OPTS, SCRATCH, env);
    expect(out.tools).toBe("<NONE>");
    expect(calls.length).toBe(2);
    expect(sleeps.length).toBe(1);
    expect(calls[0]?.input).toBe(calls[1]?.input);
  });

  it("a timeout on 3.x is still a timeout", async () => {
    const { env } = makeEnv3([spawnResult({ timedOut: true })]);
    await expect(runKiro(TOOLS_OPTS, SCRATCH, env)).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("kiro-cli 3.x session listing and cleanup scope", () => {
  it("parses the 3.5.0 array-of-envelopes shape, dropping extra fields", () => {
    const groups = parseKiroSessionListing(fixture("list-sessions-3.5.0.json"));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.cwd).toBe("/mnt/users/u/.human-hindsight/runner-scratch/run-AbC123");
    expect(groups[0]?.sessions.map((s) => s.sessionId)).toEqual([
      "4c888695-6fb3-428b-8f5d-55227239a2f4",
      "sess_fe33fc26-98bf-47c3-8bbe-d8f9a98fd455",
      "sess_00000000-0000-4000-8000-000000000001",
    ]);
  });

  it("still parses the 2.12.1 shape, a single envelope, and one envelope per line", () => {
    const v2 = '[{"cwd":"/s","sessions":[{"sessionId":"a","title":"t"}]}]';
    expect(parseKiroSessionListing(v2)).toEqual([
      { cwd: "/s", sessions: [{ sessionId: "a", title: "t" }] },
    ]);
    expect(parseKiroSessionListing('{"cwd":"/s","sessions":[]}')).toEqual([
      { cwd: "/s", sessions: [] },
    ]);
    const lines = '{"cwd":"/a","sessions":[]}\n{"cwd":"/b","sessions":[{"sessionId":"x"}]}\n';
    expect(parseKiroSessionListing(lines).map((g) => g.cwd)).toEqual(["/a", "/b"]);
  });

  it("is tolerant: garbage, non-envelopes and id-less sessions yield nothing, never a throw", () => {
    expect(parseKiroSessionListing("")).toEqual([]);
    expect(parseKiroSessionListing("not json")).toEqual([]);
    expect(parseKiroSessionListing('[1,"x",{"cwd":3,"sessions":[]}]')).toEqual([]);
    expect(
      parseKiroSessionListing('[{"cwd":"/s","sessions":[{"title":"no id"},null,{"sessionId":7}]}]'),
    ).toEqual([{ cwd: "/s", sessions: [] }]);
  });

  it("matches a symlinked scratch path against the real cwd 3.x lists, sentinel titles only", async () => {
    // The listing reports /mnt/users/u/... for this /home/u/... scratch dir.
    const symlinked = "/home/u/.human-hindsight/runner-scratch/run-AbC123";
    const { env, deleted } = makeEnv([], {
      listSessions: async () => [
        ...parseKiroSessionListing(fixture("list-sessions-3.5.0.json")),
        // A different run's scratch dir, sentinel title and all: never touched.
        {
          cwd: "/mnt/users/u/.human-hindsight/runner-scratch/run-Other",
          sessions: [{ sessionId: "OTHER-RUN", title: "[human-hindsight distill] x" }],
        },
        // A parent directory: exact match only, never a prefix match.
        {
          cwd: "/mnt/users/u/.human-hindsight/runner-scratch",
          sessions: [{ sessionId: "PARENT", title: "[human-hindsight distill] x" }],
        },
      ],
    });
    env.realpath = (p) => p.replace(/^\/home\//, "/mnt/users/");
    await cleanupScratchSessions(symlinked, env);
    expect(deleted).toEqual([
      "4c888695-6fb3-428b-8f5d-55227239a2f4",
      "sess_fe33fc26-98bf-47c3-8bbe-d8f9a98fd455",
    ]);
  });

  it("without realpath, a symlinked scratch path deletes nothing (fails safe)", async () => {
    const { env, deleted } = makeEnv([], {
      listSessions: async () => parseKiroSessionListing(fixture("list-sessions-3.5.0.json")),
    });
    await cleanupScratchSessions("/home/u/.human-hindsight/runner-scratch/run-AbC123", env);
    expect(deleted).toEqual([]);
  });

  it("a throwing realpath is treated as the path itself", async () => {
    const { env, deleted } = makeEnv([], {
      listSessions: async () => [
        { cwd: SCRATCH, sessions: [{ sessionId: "mine", title: "[human-hindsight distill] y" }] },
      ],
    });
    env.realpath = () => {
      throw new Error("ENOENT");
    };
    await cleanupScratchSessions(SCRATCH, env);
    expect(deleted).toEqual(["mine"]);
  });
});
