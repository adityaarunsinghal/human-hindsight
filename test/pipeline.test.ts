import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { ManifestEntry } from "../src/commands/distill.js";
import { setFileWriter, unflushedWriter } from "../src/core/fsutil.js";
import {
  clearCheckpoints,
  countReusableDigests,
  loadDigests,
  newGeneration,
  type RunnerFn,
  runDigestStage,
  saveDigests,
} from "../src/distill/pipeline.js";
import { buildDigestPrompt, DIGEST_PROMPT_VERSION } from "../src/distill/prompts/digest.js";
import {
  type Digest,
  DigestResponseSchema,
  type PreferenceCandidate,
} from "../src/distill/schemas.js";
import type { StageItem, StageProgressSink } from "../src/distill/stage-events.js";
import type { RunClaudeOptions } from "../src/runners/claude.js";

// Unit tests skip disk flushes; test/engine.test.ts proves the durable path.
setFileWriter(unflushedWriter);

// --- helpers ---------------------------------------------------------------

const tmpDirs: string[] = [];
function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cch-pipeline-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "exports"), { recursive: true });
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function entry(name: string): ManifestEntry {
  return {
    export: name,
    source: `/x/${name}.jsonl`,
    project: "x",
    sessionId: name,
    messages: 3,
    first_ts: "2026-01-01T00:00:00Z",
    last_ts: "2026-01-01T01:00:00Z",
  };
}

function writeExport(home: string, name: string, content = `### t\n\ncontent of ${name}\n`): void {
  fs.writeFileSync(path.join(home, "exports", name), content);
}

function sink(): Writable {
  return new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
}

const DIGEST: Digest = {
  goal: "ship the feature",
  deliverable: "a PR",
  domain: "webapp",
  keywords: ["feature"],
  outcome: "completed",
};

// --- prompt builder ----------------------------------------------------------

describe("buildDigestPrompt", () => {
  it("labels outcome evidence and marks the assistant tail machine-authored", () => {
    const prompt = buildDigestPrompt({
      exportName: "webapp-a1b2c3d4.md",
      content: "### t\n\ndo the thing\n",
      outcome: {
        final_human_turns: ["do the thing", "yes", "thanks"],
        final_assistant_tail: "All done — tests pass.",
      },
    });
    expect(prompt).toContain("=== OUTCOME EVIDENCE (bounded) ===");
    expect(prompt).toContain("MACHINE-AUTHORED");
    expect(prompt).toContain("All done — tests pass.");
    expect(prompt).toContain('"do the thing"');
    expect(prompt).toContain("webapp-a1b2c3d4.md");
    expect(prompt).toContain('"completed"');
    expect(prompt).toContain('"abandoned"');
  });

  it("falls back to an explicit no-evidence note", () => {
    const prompt = buildDigestPrompt({ exportName: "a.md", content: "hi" });
    expect(prompt).toContain("No outcome evidence was captured");
  });

  it("has a version constant for provenance", () => {
    expect(DIGEST_PROMPT_VERSION).toBeGreaterThanOrEqual(1);
  });
});

// --- checkpoint plumbing -----------------------------------------------------

describe("checkpoints", () => {
  it("save/load round-trips and clearCheckpoints removes them", () => {
    const home = tmpHome();
    const cp = { generation: "g1", prompt_version: 1, digests: { "a.md": DIGEST } };
    saveDigests(home, cp);
    expect(loadDigests(home)).toEqual(cp);
    clearCheckpoints(home);
    expect(loadDigests(home)).toBeNull();
  });

  it("loadDigests returns null for absent or malformed files", () => {
    const home = tmpHome();
    expect(loadDigests(home)).toBeNull();
    fs.mkdirSync(path.join(home, "distill"), { recursive: true });
    fs.writeFileSync(path.join(home, "distill", "digests.json"), "not json");
    expect(loadDigests(home)).toBeNull();
  });

  it("mints distinct, sortable generation ids", () => {
    const g1 = newGeneration(new Date("2026-07-13T10:00:00Z"));
    expect(g1).toMatch(/^20260713T100000Z-[0-9a-f]{4}$/);
    expect(newGeneration()).not.toBe(newGeneration());
  });
});

// --- digest stage -------------------------------------------------------------

describe("runDigestStage", () => {
  it("emits a sanitized summary only after publication and emits it again when reused", async () => {
    const home = tmpHome();
    const name = "reference.md";
    writeExport(
      home,
      name,
      [
        "### 2026-01-01T00:00:00Z\n\nStart with a worked example.",
        "### 2026-01-01T00:01:00Z\n\nPut the example first again.",
      ].join("\n"),
    );
    const entries = [{ ...entry(name), project: "\x1b[34mReference\x1b[0m" }];
    const response = {
      ...DIGEST,
      goal: `Explain widget sizing. ${"More detail. ".repeat(30)}`,
      preferences: [
        {
          text: "Start with\n\x1b[31ma worked example.\x1b[0m\u202e",
          basis: "inferred",
          scope: "project",
          evidence: "Two requests lead with examples.",
          citations: [
            { message_id: `${name}#m0`, quote: "Start with a worked example" },
            { message_id: `${name}#m1`, quote: "example first" },
          ],
        },
      ],
    };
    const dispatches: (string | undefined)[] = [];
    const events: StageItem[] = [];
    const progress: StageProgressSink = {
      start() {},
      end() {},
      note() {},
      running(_id, _label, project) {
        dispatches.push(project);
      },
      item(event) {
        // Check the on-disk checkpoint at the exact moment the card would be printed.
        expect(loadDigests(home)?.digests[name]?.goal).toBe(response.goal);
        events.push(event);
      },
    };
    await runDigestStage({ home, entries, progress, runner: (async () => response) as RunnerFn });
    const reuse = () =>
      runDigestStage({
        home,
        entries,
        progress,
        runner: async () => {
          throw Error("unexpected call");
        },
      });
    await reuse();
    expect(dispatches).toEqual(["Reference"]);
    expect(events.map((event) => event.status)).toEqual(["done", "skipped"]);
    expect(events[0]?.read).toEqual(events[1]?.read);
    expect(events[0]?.read?.outcome).toBe("completed");
    expect(events[0]?.read?.preference).toBe("Start with a worked example.");
    expect(events[0]?.read?.goal?.length).toBeLessThanOrEqual(160);
    const checkpoint = loadDigests(home);
    const citation = checkpoint?.digests[name]?.preferences?.[0]?.citations[0];
    if (!checkpoint || !citation) throw Error("missing fixture citation");
    citation.quote = "Text absent from this session";
    saveDigests(home, checkpoint);
    await reuse();
    expect(events.at(-1)?.status).toBe("skipped");
    expect(events.at(-1)?.read?.preference).toBeUndefined();
  });

  it("digests every entry, saving the checkpoint incrementally", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    writeExport(home, "b.md");

    const checkpointSizesAtCallTime: number[] = [];
    const runner: RunnerFn = (async () => {
      const cp = loadDigests(home);
      checkpointSizesAtCallTime.push(cp ? Object.keys(cp.digests).length : 0);
      return DIGEST;
    }) as RunnerFn;

    const result = await runDigestStage({
      home,
      entries: [entry("a.md"), entry("b.md")],
      runner,
      output: sink(),
      // Call order matters here: one in flight, so the second call sees the first save.
      concurrency: 1,
    });

    expect(result.completed).toBe(2);
    expect(result.failed).toEqual([]);
    // First call: nothing saved yet; second call: a.md already checkpointed.
    expect(checkpointSizesAtCallTime).toEqual([0, 1]);
    const cp = loadDigests(home);
    expect(cp?.prompt_version).toBe(DIGEST_PROMPT_VERSION);
    expect(Object.keys(cp?.digests ?? {}).sort()).toEqual(["a.md", "b.md"]);
  });

  it("bounds in-flight calls to --concurrency and checkpoints everything", async () => {
    const home = tmpHome();
    const names = ["a.md", "b.md", "c.md", "d.md", "e.md"];
    for (const n of names) writeExport(home, n);

    let inFlight = 0;
    let maxInFlight = 0;
    const runner: RunnerFn = (async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return DIGEST;
    }) as RunnerFn;

    const result = await runDigestStage({
      home,
      entries: names.map((n) => entry(n)),
      runner,
      output: sink(),
      concurrency: 2,
    });

    expect(result.completed).toBe(5);
    expect(result.failed).toEqual([]);
    expect(maxInFlight).toBe(2); // pool actually parallelizes, and never exceeds the bound
    expect(Object.keys(loadDigests(home)?.digests ?? {}).sort()).toEqual(names);
  });

  it("stage default runs up to 10 at a time (concurrency omitted)", async () => {
    const home = tmpHome();
    const total = 11;
    const names = Array.from({ length: total }, (_, i) => `s${i}.md`);
    for (const n of names) writeExport(home, n);

    // Hold each call until ten are in flight (or every call has started), so the
    // count does not depend on timing. A default below ten never releases and
    // the test times out.
    let inFlight = 0;
    let maxInFlight = 0;
    let started = 0;
    let waiting: (() => void)[] = [];
    const runner: RunnerFn = (async () => {
      started++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (waiting.length === 10 || started === total) {
          for (const go of waiting) go();
          waiting = [];
        }
      });
      inFlight--;
      return DIGEST;
    }) as RunnerFn;

    const result = await runDigestStage({
      home,
      entries: names.map((n) => entry(n)),
      runner,
      output: sink(),
    });
    expect(maxInFlight).toBe(10);
    expect(result.completed).toBe(total);
  });

  it("resumes: checkpointed sessions are skipped and never re-run", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    writeExport(home, "b.md");
    await runDigestStage({
      home,
      entries: [entry("a.md")],
      generation: "g1",
      runner: (async () => DIGEST) as RunnerFn,
      output: sink(),
    });

    const calls: string[] = [];
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      calls.push(opts.prompt.includes("content of b.md") ? "b.md" : "other");
      return DIGEST;
    }) as RunnerFn;

    const result = await runDigestStage({
      home,
      entries: [entry("a.md"), entry("b.md")],
      runner,
      output: sink(),
    });

    expect(result.skipped).toBe(1);
    expect(result.completed).toBe(1);
    expect(result.generation).toBe("g1"); // resume keeps the generation
    expect(calls).toEqual(["b.md"]);
  });

  it("regenerates only the session whose content changed under the same filename", async () => {
    const home = tmpHome();
    writeExport(home, "a.md", "Build a CSV export.");
    writeExport(home, "b.md", "Leave this task unchanged.");
    const calls: string[] = [];
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      calls.push(opts.prompt);
      return {
        ...DIGEST,
        deliverable: opts.prompt.includes("JSON export") ? "JSON file" : "CSV file",
      };
    }) as RunnerFn;
    const opts = { home, entries: [entry("a.md"), entry("b.md")], runner, output: sink() };
    await runDigestStage(opts);
    const previous = loadDigests(home)?.lineage?.["a.md"]?.fingerprint;

    writeExport(home, "a.md", "Change this task to a JSON export.");
    const result = await runDigestStage(opts);
    expect(result.completed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(calls).toHaveLength(3);
    expect(loadDigests(home)?.digests["a.md"]?.deliverable).toBe("JSON file");
    expect(loadDigests(home)?.lineage?.["a.md"]?.fingerprint).not.toBe(previous);
  });

  it("uses the same input checks in the read-only consent plan", async () => {
    const home = tmpHome();
    writeExport(home, "a.md", "Keep this session.");
    writeExport(home, "b.md", "This session will change.");
    const opts = {
      home,
      entries: [entry("a.md"), entry("b.md")],
      runner: (async () => DIGEST) as RunnerFn,
      output: sink(),
    };
    await runDigestStage(opts);
    const checkpointPath = path.join(home, "distill", "digests.json");
    const before = fs.readFileSync(checkpointPath, "utf8");
    expect(countReusableDigests(opts)).toBe(2);
    writeExport(home, "b.md", "A new task.");
    expect(countReusableDigests(opts)).toBe(1);
    expect(countReusableDigests({ ...opts, model: "new-model" })).toBe(0);
    expect(fs.readFileSync(checkpointPath, "utf8")).toBe(before);
  });

  it("refreshes a digest when outcome evidence changes without new human text", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    let calls = 0;
    const runner: RunnerFn = (async () => {
      calls++;
      return DIGEST;
    }) as RunnerFn;
    const opts = { home, entries: [entry("a.md")], runner, output: sink() };
    await runDigestStage(opts);
    fs.writeFileSync(
      path.join(home, "exports", "outcomes.json"),
      JSON.stringify({
        "a.md": { final_human_turns: [], final_assistant_tail: "The final verification failed." },
      }),
    );
    expect((await runDigestStage(opts)).completed).toBe(1);
    expect(calls).toBe(2);
  });

  it.each([
    { model: "different-model" },
    { runnerName: "codex" as const },
  ])("regenerates when the selected generation configuration changes: %j", async (change) => {
    const home = tmpHome();
    writeExport(home, "a.md");
    let calls = 0;
    const runner: RunnerFn = (async () => {
      calls++;
      return DIGEST;
    }) as RunnerFn;
    const opts = { home, entries: [entry("a.md")], runner, output: sink() };
    await runDigestStage(opts);
    await runDigestStage({ ...opts, ...change });
    expect(calls).toBe(2);
  });

  it("upgrades legacy checkpoints after consent and records source identity", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    saveDigests(home, { generation: "g1", prompt_version: 1, digests: { "a.md": DIGEST } });
    const result = await runDigestStage({
      home,
      entries: [entry("a.md")],
      runner: (async () => DIGEST) as RunnerFn,
      output: sink(),
    });
    expect(result.completed).toBe(1);
    expect(result.generation).toBe("g1");
    expect(loadDigests(home)?.lineage?.["a.md"]).toMatchObject({
      version: 1,
      prompt_version: DIGEST_PROMPT_VERSION,
      project: "x",
      session_id: "a.md",
      origin: "claude",
      observed_at: "2026-01-01T01:00:00Z",
    });
  });

  it("does not expose an obsolete digest when its refresh fails", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    await runDigestStage({
      home,
      entries: [entry("a.md")],
      runner: (async () => DIGEST) as RunnerFn,
      output: sink(),
    });
    writeExport(home, "a.md", "A new requirement.");
    const result = await runDigestStage({
      home,
      entries: [entry("a.md")],
      runner: (async () => {
        throw new Error("provider unavailable");
      }) as RunnerFn,
      output: sink(),
    });
    expect(result.failed).toHaveLength(1);
    expect(loadDigests(home)?.digests["a.md"]).toBeUndefined();
    expect(loadDigests(home)?.lineage?.["a.md"]).toBeUndefined();
    expect(loadDigests(home)?.invalidated).toEqual(["a.md"]);
  });

  it("invalidates a cached digest when its export disappears", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    const opts = {
      home,
      entries: [entry("a.md")],
      runner: (async () => DIGEST) as RunnerFn,
      output: sink(),
    };
    await runDigestStage(opts);
    fs.rmSync(path.join(home, "exports", "a.md"));
    const result = await runDigestStage(opts);
    expect(result.failed).toHaveLength(1);
    expect(loadDigests(home)?.digests["a.md"]).toBeUndefined();
  });

  it("requires current prompt and schema metadata before reusing a fingerprint", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    let calls = 0;
    const opts = {
      home,
      entries: [entry("a.md")],
      runner: (async () => {
        calls++;
        return DIGEST;
      }) as RunnerFn,
      output: sink(),
    };
    await runDigestStage(opts);
    const checkpoint = loadDigests(home);
    const lineage = checkpoint?.lineage?.["a.md"];
    if (!checkpoint || !lineage) throw new Error("Expected the generated checkpoint.");
    lineage.prompt_version--;
    saveDigests(home, checkpoint);
    await runDigestStage(opts);
    expect(calls).toBe(2);
  });

  it("keeps evidence-backed preferences from abandoned sessions in the digest checkpoint", async () => {
    const home = tmpHome();
    const quote = "Always diagnose before making edits.";
    writeExport(home, "a.md", quote);
    const preference: PreferenceCandidate = {
      text: quote,
      evidence: "An explicit standing instruction.",
      scope: "global",
      basis: "explicit",
      citations: [{ message_id: "a.md#m0", quote }],
    };
    const result = await runDigestStage({
      home,
      entries: [entry("a.md")],
      runner: (async (opts: RunClaudeOptions<unknown>) => {
        expect(opts.schema).toBe(DigestResponseSchema);
        return opts.schema.parse({ ...DIGEST, outcome: "abandoned", preferences: [preference] });
      }) as RunnerFn,
      output: sink(),
    });
    expect(result.completed).toBe(1);
    expect(loadDigests(home)?.digests["a.md"]?.preferences).toEqual([preference]);
  });

  it("retries fabricated evidence once and checkpoints only the corrected citations", async () => {
    const home = tmpHome();
    writeExport(home, "a.md", "Always diagnose before making edits.");
    let calls = 0;
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      calls++;
      if (calls === 2) expect(opts.prompt).toContain("quote is not verbatim");
      return {
        ...DIGEST,
        preferences: [
          {
            text: "Diagnose first.",
            evidence: "The human asked for diagnosis before edits.",
            scope: "global",
            basis: "explicit",
            citations: [
              {
                message_id: "a.md#m0",
                quote: calls === 1 ? "invented quotation" : "Always diagnose before making edits.",
              },
            ],
          },
        ],
      };
    }) as RunnerFn;
    const result = await runDigestStage({ home, entries: [entry("a.md")], runner, output: sink() });
    expect(result.completed).toBe(1);
    expect(calls).toBe(2);
    expect(loadDigests(home)?.digests["a.md"]?.preferences?.[0]?.citations[0]?.quote).toBe(
      "Always diagnose before making edits.",
    );
  });

  it("keeps the read and leaves out a preference whose evidence stays unverified after the correction", async () => {
    const home = tmpHome();
    writeExport(home, "a.md", "Always diagnose before making edits.");
    let calls = 0;
    const result = await runDigestStage({
      home,
      entries: [entry("a.md")],
      output: sink(),
      runner: (async () => {
        calls++;
        return {
          ...DIGEST,
          preferences: [
            {
              text: "Diagnose first.",
              evidence: "The human asked for diagnosis before edits.",
              scope: "global",
              basis: "explicit",
              citations: [{ message_id: "a.md#m0", quote: "Always diagnose before making edits." }],
            },
            {
              text: "Invented preference.",
              evidence: "Unsupported.",
              scope: "global",
              basis: "explicit",
              citations: [{ message_id: "a.md#m0", quote: "Invented evidence." }],
            },
          ],
        };
      }) as RunnerFn,
    });
    // One correction is asked for, as before; then the session is not lost over one quote.
    expect(calls).toBe(2);
    expect(result.failed).toEqual([]);
    expect(result.completed).toBe(1);
    const saved = loadDigests(home)?.digests["a.md"];
    expect(saved?.goal).toBe(DIGEST.goal);
    expect(saved?.preferences?.map((preference) => preference.text)).toEqual(["Diagnose first."]);
  });

  it("never saves an invented preference: a read whose every preference is unverified keeps none", async () => {
    const home = tmpHome();
    writeExport(home, "a.md", "The real human text.");
    let calls = 0;
    const result = await runDigestStage({
      home,
      entries: [entry("a.md")],
      output: sink(),
      runner: (async () => {
        calls++;
        return {
          ...DIGEST,
          preferences: [
            {
              text: "Invented preference.",
              evidence: "Unsupported.",
              scope: "global",
              basis: "explicit",
              citations: [{ message_id: "a.md#m0", quote: "Invented evidence." }],
            },
          ],
        };
      }) as RunnerFn,
    });
    expect(calls).toBe(2);
    expect(result.failed).toEqual([]);
    expect(result.completed).toBe(1);
    expect(loadDigests(home)?.digests["a.md"]?.preferences).toEqual([]);
  });

  it("maps truncated-message citations back to their original source IDs", async () => {
    const home = tmpHome();
    const quote = "Always diagnose before making edits.";
    const content = [
      `### 2026-01-01T00:00:00Z\n\n${"z".repeat(3000)}`,
      `### 2026-01-01T00:01:00Z\n\n${"k".repeat(500)}`,
      `### 2026-01-01T00:02:00Z\n\n${"l".repeat(500)}`,
      `### 2026-01-01T00:03:00Z\n\n${quote}`,
    ].join("\n\n");
    writeExport(home, "a.md", content);
    const result = await runDigestStage({
      home,
      entries: [entry("a.md")],
      output: sink(),
      budget: 300,
      truncate: "extreme",
      runner: (async (opts: RunClaudeOptions<unknown>) => {
        expect(opts.prompt).toContain('"message_id":"a.md#m1","timestamp":"2026-01-01T00:03:00Z"');
        return {
          ...DIGEST,
          preferences: [
            {
              text: quote,
              evidence: "An explicit standing instruction.",
              scope: "global",
              basis: "explicit",
              citations: [{ message_id: "a.md#m1", quote }],
            },
          ],
        };
      }) as RunnerFn,
    });
    expect(result.completed).toBe(1);
    expect(loadDigests(home)?.digests["a.md"]?.preferences?.[0]?.citations).toEqual([
      { message_id: "a.md#m3", quote },
    ]);
  });

  it("one failure doesn't abort the rest; progress is kept", async () => {
    const home = tmpHome();
    for (const n of ["a.md", "b.md", "c.md"]) writeExport(home, n);

    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      if (opts.prompt.includes("content of b.md")) throw new Error("boom");
      return DIGEST;
    }) as RunnerFn;

    const result = await runDigestStage({
      home,
      entries: [entry("a.md"), entry("b.md"), entry("c.md")],
      runner,
      output: sink(),
    });

    expect(result.completed).toBe(2);
    expect(result.failed).toEqual([{ export: "b.md", error: "boom" }]);
    expect(Object.keys(loadDigests(home)?.digests ?? {}).sort()).toEqual(["a.md", "c.md"]);
  });

  // Incident replay: a machine-wide misconfiguration (verbose mode reshaping the
  // CLI envelope) made EVERY call fail identically. The stage kept going through
  // all 92 sessions, and because each failure burns the runner's one corrective
  // retry that was ~2 doomed API calls per session before the run collapsed at
  // the clustering stage with nothing to show. Per-session containment is right
  // for a session-specific problem, but an unbroken streak of identical failures
  // is an environment problem: stop and say so while it is still cheap.
  describe("systemic-failure circuit breaker", () => {
    // One table for the stage wiring of the shared breaker. The unit rules and
    // the five-session boundary are in test/engine.test.ts ("one breaker for every stage").
    const IDENTICAL = "claude envelope missing a 'result' field";
    it.each([
      {
        name: "stops after a streak of identical failures and accounts for every session",
        total: 20,
        fail: (_call: number) => IDENTICAL as string | null,
        breaker: true,
        aborted: true,
      },
      {
        name: "does NOT trip on failures with differing messages",
        total: 12,
        fail: (call: number) => `unique failure #${call}`,
        breaker: true,
        aborted: false,
      },
      {
        name: "does NOT trip when a success interrupts the streak",
        total: 15,
        fail: (call: number) => (call % 3 === 0 ? null : "same message every time"),
        breaker: true,
        aborted: false,
      },
      {
        name: "keeps successful digests checkpointed when it does trip",
        total: 20,
        fail: (call: number) => (call === 1 ? null : IDENTICAL),
        breaker: true,
        aborted: true,
      },
      {
        name: "breaker:false (--no-breaker) attempts every session anyway",
        total: 20,
        fail: (_call: number) => IDENTICAL,
        breaker: false,
        aborted: false,
      },
    ])("$name", async ({ total, fail, breaker, aborted }) => {
      const home = tmpHome();
      const names = Array.from({ length: total }, (_, i) => `s${i}.md`);
      for (const n of names) writeExport(home, n);
      let calls = 0;
      let succeeded = 0;
      const runner: RunnerFn = (async () => {
        calls++;
        const message = fail(calls);
        if (message === null) {
          succeeded++;
          return DIGEST;
        }
        throw new Error(message);
      }) as RunnerFn;

      const result = await runDigestStage({
        home,
        entries: names.map(entry),
        runner,
        output: sink(),
        concurrency: 1,
        breaker,
      });

      expect(Boolean(result.aborted)).toBe(aborted);
      // Never a silent drop: every session is done, failed, or listed as not attempted.
      expect(result.completed + result.failed.length + result.notAttempted.length).toBe(total);
      expect(result.completed).toBe(succeeded);
      expect(Object.keys(loadDigests(home)?.digests ?? {})).toHaveLength(succeeded);
      if (aborted) {
        expect(calls).toBeLessThan(total);
        expect(result.abortReason).toContain("identical");
        expect(result.notAttempted.length).toBeGreaterThan(0);
      } else {
        expect(calls).toBe(total);
        expect(result.notAttempted).toHaveLength(0);
      }
    });
  });

  it("passes the DigestSchema through to the runner (outcome validated)", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");

    // A runner that validates its input the way the real runClaude does:
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) =>
      opts.schema.parse({ ...DIGEST, outcome: "not-a-valid-outcome" })) as RunnerFn;

    const result = await runDigestStage({
      home,
      entries: [entry("a.md")],
      runner,
      output: sink(),
    });

    expect(result.completed).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error).toContain("outcome");
  });

  it("feeds outcome evidence from outcomes.json into the prompt", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    fs.writeFileSync(
      path.join(home, "exports", "outcomes.json"),
      JSON.stringify({
        _note: "label",
        "a.md": { final_human_turns: ["looks great"], final_assistant_tail: "Shipped v2." },
      }),
    );

    let prompt = "";
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      prompt = opts.prompt;
      return DIGEST;
    }) as RunnerFn;

    await runDigestStage({ home, entries: [entry("a.md")], runner, output: sink() });
    expect(prompt).toContain("Shipped v2.");
    expect(prompt).toContain('"looks great"');
  });

  it("warns when the digests checkpoint was written by a different prompt version", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    saveDigests(home, {
      generation: "g1",
      prompt_version: DIGEST_PROMPT_VERSION + 99,
      digests: { "a.md": DIGEST },
    });
    const chunks: string[] = [];
    const out = new Writable({
      write(c, _e, cb) {
        chunks.push(c.toString());
        cb();
      },
    });
    const runner: RunnerFn = (async () => DIGEST) as RunnerFn;
    await runDigestStage({ home, entries: [entry("a.md")], runner, output: out });
    // One plain line for the stage says why, with no version numbers or per-session lines.
    const lines = chunks.join("").split("\n");
    const why = lines.filter((line) => line.includes("this version reads them differently"));
    expect(why).toEqual([
      "  Reading saved sessions again because this version reads them differently.",
    ]);
    expect(lines.join("\n")).not.toMatch(/\bv\d+\b|stale|regenerat/);
  });

  it("says once, in plain words, why changed sessions are read again", async () => {
    const home = tmpHome();
    for (const name of ["a.md", "b.md", "c.md"]) writeExport(home, name);
    const entries = ["a.md", "b.md", "c.md"].map(entry);
    const runner: RunnerFn = (async () => DIGEST) as RunnerFn;
    await runDigestStage({
      home,
      entries,
      runner,
      output: new Writable({ write: (_c, _e, cb) => cb() }),
    });
    const chunks: string[] = [];
    const out = new Writable({
      write(c, _e, cb) {
        chunks.push(c.toString());
        cb();
      },
    });
    // A different model makes every saved read stale.
    await runDigestStage({ home, entries, runner, model: "another-model", output: out });
    const lines = chunks.join("").split("\n");
    expect(lines.filter((line) => line.includes("again"))).toEqual([
      "  Reading sessions again whose text or settings changed since they were last read.",
    ]);
    expect(lines.join("\n")).not.toMatch(/stale|regenerat|digest/);
  });

  it("blocks an over-budget session under --truncate=never without a runner call", async () => {
    const home = tmpHome();
    writeExport(home, "big.md", "z".repeat(5_000));
    let called = false;
    const runner: RunnerFn = (async () => {
      called = true;
      return DIGEST;
    }) as RunnerFn;

    const chunks: string[] = [];
    const out = new Writable({
      write(c, _e, cb) {
        chunks.push(c.toString());
        cb();
      },
    });

    const result = await runDigestStage({
      home,
      entries: [entry("big.md")],
      runner,
      output: out,
      budget: 1_000,
      truncate: "never",
    });

    expect(called).toBe(false); // pre-spend block
    expect(result.completed).toBe(0);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]?.export).toBe("big.md");
    expect(chunks.join("")).toContain("blocked");
    // Nothing was checkpointed for the blocked session.
    expect(loadDigests(home)?.digests["big.md"]).toBeUndefined();
  });

  it("cuts an over-budget session under --truncate=extreme and digests it", async () => {
    const home = tmpHome();
    writeExport(home, "big.md", "z".repeat(5_000));
    let promptLen = 0;
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      promptLen = opts.prompt.length;
      return DIGEST;
    }) as RunnerFn;

    const result = await runDigestStage({
      home,
      entries: [entry("big.md")],
      runner,
      output: sink(),
      budget: 1_000,
      truncate: "extreme",
    });

    expect(result.completed).toBe(1);
    expect(result.blocked).toHaveLength(0);
    // The prompt carried the cut content, not all 5,000 characters: its length
    // is the fixed instructions plus about the 1,000-character budget.
    const instructions = buildDigestPrompt({ exportName: "big.md", content: "" }).length;
    expect(promptLen).toBeLessThan(instructions + 1_500);
    expect(loadDigests(home)?.digests["big.md"]).toBeDefined();
  });

  it("records unreadable exports as failures without invoking the runner", async () => {
    const home = tmpHome();
    let called = false;
    const runner: RunnerFn = (async () => {
      called = true;
      return DIGEST;
    }) as RunnerFn;

    const result = await runDigestStage({
      home,
      entries: [entry("missing.md")],
      runner,
      output: sink(),
    });

    expect(called).toBe(false);
    expect(result.failed[0]?.error).toContain("could not read export");
  });
});
