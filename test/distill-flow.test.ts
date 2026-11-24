/**
 * The distill command end to end (`src/commands/distill.ts`): the plan screen
 * in each state, the consent promises, the run, interrupts, and quick start.
 *
 * Coding CLIs are faked: either ready-made runner objects handed to the run
 * session (`runners`), or the real Claude adapter over a scripted process
 * boundary (`io`). Nothing spawns a process and no model is called. Every
 * output this file captures is checked for plan labels when its test ends.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computePlan,
  type DistillArgs,
  type DistillDeps,
  keptLine,
  librarySentence,
  type ManifestEntry,
  preferencesLine,
  runDistill,
  unverifiedLine,
} from "../src/commands/distill.js";
import { runExport } from "../src/commands/export.js";
import { preferenceStory, preferenceStoryText } from "../src/commands/preferences.js";
import { renderStatus } from "../src/commands/status.js";
import { GENERALIZED_PATH } from "../src/core/generalized.js";
import { PlainFailure } from "../src/core/plain-failure.js";
import type { ConsentResult, DistillPlan } from "../src/distill/consent.js";
import type { GeneralizeResult } from "../src/distill/generalize.js";
import type { RunnerFn } from "../src/distill/pipeline.js";
import type { AgentRunner, ModelCatalog, RunnerName, RunOptions } from "../src/runners/types.js";
import type { TerminalHost } from "../src/ui/live.js";
import { homeBuilder } from "./support/home.js";
import { fakeRunnerIo } from "./support/runner-io.js";
import { goldenText } from "./support/text.js";
import { fakeInput, fakeOutput } from "./support/tty.js";

// --- fakes -------------------------------------------------------------------

const PLAN_LABEL = /\b(balanced|best)\/(bulk|major)\b/;
const ALIASES: ModelCatalog = { ids: ["sonnet", "opus", "fable"], source: "aliases" };
const CODEX: ModelCatalog = {
  ids: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-astra"],
  source: "catalog",
};
const NONE: ModelCatalog = { ids: [], source: "none" };
const LISTING_LINE = "Checking available coding CLIs…";
const FIXED_NOW = () => 1_800_000_000_000;

type Stage = "check" | "digest" | "window" | "merge" | "author" | "generalize";
/** By the shape the call must answer in, so a fresh module graph is recognized too. */
function stageOf(opts: RunOptions<unknown>): Stage {
  const keys = Object.keys((opts.schema as unknown as { shape?: object }).shape ?? {});
  if (opts.prompt.includes('{"ok":true}')) return "check";
  if (keys.includes("tasks")) return "window";
  if (keys.includes("merges")) return "merge";
  if (keys.includes("oneshot_markdown")) return "author";
  if (opts.prompt.includes("=== INPUTS (")) return "generalize";
  return "digest";
}

const BODY = "Build the requested feature, keep the change small, and verify it with the tests. ";
/** A working preference cited verbatim from the session the prompt carries. */
function citedPreference(prompt: string) {
  const id = prompt.match(/"message_id":"([^"]+)"/)?.[1] ?? "missing#m0";
  const citations = [{ message_id: id, quote: "Build the" }];
  return [
    {
      text: "Keep each change small.",
      evidence: "asked",
      scope: "global",
      basis: "explicit",
      citations,
    },
  ];
}

/** A valid answer for every stage; generalize has no default answer. */
function answer(opts: RunOptions<unknown>, o: { preferences?: boolean } = {}) {
  switch (stageOf(opts)) {
    case "check":
      return { ok: true };
    case "window": {
      const members = [...opts.prompt.matchAll(/^- id: (.+)$/gm)].map((m) => m[1] as string);
      return {
        tasks: [
          {
            slug: `task-${members[0]?.replace(/[^a-z0-9]+/g, "-")}`,
            title: "T",
            rationale: "r",
            members,
          },
        ],
        misc: [],
      };
    }
    case "merge":
      return { merges: [] };
    case "author":
      return {
        slug: "x",
        title: "T",
        oneshot_markdown: BODY.repeat(3),
        confidence: "high",
        preferences: [],
      };
    case "generalize":
      throw new Error("synthetic summary failure");
    default:
      return {
        goal: "g",
        deliverable: "d",
        domain: "dom",
        keywords: ["k"],
        outcome: "completed",
        preferences: o.preferences ? citedPreference(opts.prompt) : [],
      };
  }
}

interface FakeCli extends AgentRunner {
  calls: { stage: Stage; model?: string }[];
}
const clis: FakeCli[] = [];
function fakeCli(
  name: RunnerName,
  catalog: ModelCatalog,
  reply: (opts: RunOptions<unknown>) => unknown = (opts) => answer(opts),
): FakeCli {
  const cli: FakeCli = {
    name,
    installHint: "",
    calls: [],
    listModels: async () => catalog,
    version: async () => "9.9.9",
    run: async <T>(opts: RunOptions<T>) => {
      cli.calls.push({ stage: stageOf(opts as RunOptions<unknown>), model: opts.model });
      return (await reply(opts as RunOptions<unknown>)) as T;
    },
  };
  clis.push(cli);
  return cli;
}
const modelCalls = (cli: FakeCli, stage?: Stage) =>
  cli.calls.filter((call) => (stage ? call.stage === stage : true)).length;

function fakeHost(): TerminalHost & EventEmitter {
  const host = new EventEmitter() as TerminalHost & EventEmitter;
  Object.assign(host, { pid: 4242, kill: () => true });
  return host;
}

/** Answers each question once its prompt has been written. Nothing waits on a timer. */
function scripted(answers: [prompt: string, reply: string | "SIGINT"][], host?: EventEmitter) {
  const input = fakeInput();
  const output = fakeOutput();
  const original = output.write.bind(output);
  let seen = "";
  output.write = ((chunk: unknown, ...rest: unknown[]) => {
    seen += String(chunk);
    const next = answers[0];
    if (next && seen.includes(next[0])) {
      answers.shift();
      seen = "";
      setImmediate(() => {
        if (next[1] === "SIGINT") host?.emit("SIGINT");
        else input.push(next[1]);
      });
    }
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof output.write;
  return { input, output, remaining: answers };
}

// --- homes -------------------------------------------------------------------

function entry(name: string, project: string, messages: number, minute = 0): ManifestEntry {
  const ts = new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
  return {
    export: name,
    source: `/x/${name}.jsonl`,
    project,
    sessionId: name,
    messages,
    first_ts: ts,
    last_ts: ts,
  };
}

const tmpDirs: string[] = [];
function tmpHome(entries: ManifestEntry[] | null, withContent = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-distill-flow-"));
  tmpDirs.push(dir);
  if (entries) {
    fs.mkdirSync(path.join(dir, "exports"), { recursive: true });
    fs.writeFileSync(path.join(dir, "exports", "manifest.json"), JSON.stringify(entries));
    if (withContent)
      for (const e of entries)
        fs.writeFileSync(
          path.join(dir, "exports", e.export),
          `### 2026-01-01\n\nBuild the ${e.export} feature.\n`,
        );
  }
  return dir;
}
const sessions = (n: number) =>
  Array.from({ length: n }, (_, i) => entry(`s${String(i).padStart(2, "0")}`, "alpha", 3, i));

/** Every file and folder under the home, with content, mode, and modification time. */
function snapshot(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of fs.readdirSync(home, { recursive: true }) as string[]) {
    const full = path.join(home, rel);
    const info = fs.lstatSync(full);
    out[rel] = info.isDirectory()
      ? `dir ${info.mode} ${info.mtimeMs}`
      : `${info.mode} ${info.mtimeMs} ${fs.readFileSync(full, "utf8")}`;
  }
  return out;
}

// --- running -----------------------------------------------------------------

const outputs: string[] = [];
function capture(): Writable & { text(): string } {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  }) as Writable & { text(): string };
  out.text = () => chunks.join("");
  return out;
}
async function run(args: DistillArgs, deps: DistillDeps = {}) {
  const output = (deps.output as (Writable & { text(): string }) | undefined) ?? capture();
  const code = await runDistill(args, { now: FIXED_NOW, ...deps, output });
  const text = goldenText((output as { text(): string }).text(), {
    roots: args.home ? { [args.home]: "<HOME>" } : {},
  });
  outputs.push(text);
  return { code, text };
}
const golden = (name: string) => `golden/flow/${name}.txt`;
/** Screen text with its wrapping undone, for assertions on phrases. */
const flat = (text: string) => text.replace(/\s+/g, " ");

beforeEach(() => {
  vi.stubEnv("LC_ALL", "en_US.UTF-8");
  vi.stubEnv("CI", "");
  vi.stubEnv("HUMAN_HINDSIGHT_QUALITY", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // No plan label reaches the person on any path, and none reaches a CLI.
  for (const text of outputs.splice(0)) expect(flat(text)).not.toMatch(PLAN_LABEL);
  for (const cli of clis.splice(0))
    for (const call of cli.calls) expect(call.model ?? "").not.toMatch(PLAN_LABEL);
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

// --- count math --------------------------------------------------------------

describe("computePlan", () => {
  it("filters by --min-substance and estimates prompts at round(eligible/3)", () => {
    const entries = [5, 3, 1, 4, 2, 10].map((m, i) => entry(`e${i}`, i < 3 ? "alpha" : "beta", m));
    expect(computePlan(entries, { minSubstance: 2, noGroup: false })).toMatchObject({
      digests: 5,
      cluster: 1,
      authorEstimate: 2,
    });
    expect(computePlan(entries, { minSubstance: 2, noGroup: true })).toMatchObject({
      cluster: 0,
      authorEstimate: 5,
    });
    expect(computePlan([entry("a", "x", 1)], { minSubstance: 2, noGroup: false })).toMatchObject({
      digests: 0,
      cluster: 0,
      authorEstimate: 0,
    });
  });

  it("applies --project (case-insensitive substring), origins, and --recent (newest first)", () => {
    const entries = [
      entry("a", "alpha", 5, 1),
      entry("b", "beta", 4, 3),
      { ...entry("c", "beta", 2, 2), origin: "kiro" as const },
    ];
    expect(
      computePlan(entries, { project: "BET", minSubstance: 2, noGroup: false }).eligible.map(
        (e) => e.export,
      ),
    ).toEqual(["b", "c"]);
    expect(
      computePlan(entries, { minSubstance: 2, noGroup: false, activeOrigins: new Set(["claude"]) })
        .digests,
    ).toBe(2);
    expect(
      computePlan(entries, { minSubstance: 2, noGroup: false, activeOrigins: new Set(["kiro"]) })
        .eligible[0]?.export,
    ).toBe("c");
    expect(
      computePlan(entries, { minSubstance: 2, noGroup: false, recent: 2 }).eligible.map(
        (e) => e.export,
      ),
    ).toEqual(["b", "c"]);
  });

  it("estimates count-limited grouping windows plus a merge after filtering", () => {
    const entries = Array.from({ length: 301 }, (_, i) => entry(`session-${i}`, "x", i ? 3 : 1));
    expect(
      computePlan(entries, { minSubstance: 2, noGroup: false, clusterBatchSize: 50 }),
    ).toMatchObject({
      digests: 300,
      cluster: 7,
      clusterWindowsEstimate: 6,
      clusterMergeEstimate: 1,
      authorEstimate: 100,
    });
    expect(
      computePlan(entries, { minSubstance: 2, noGroup: true, clusterBatchSize: 50 }),
    ).toMatchObject({ cluster: 0, clusterWindowsEstimate: undefined });
    expect(
      computePlan([entry("a", "x", 3)], { minSubstance: 2, noGroup: false, clusterBatchSize: 50 }),
    ).toMatchObject({ cluster: 1, clusterWindowsEstimate: 1, clusterMergeEstimate: 0 });
  });
});

// --- the plan screen, one golden per state -------------------------------------

describe("the plan screen", () => {
  it("fresh library, one CLI ready (golden)", async () => {
    const home = tmpHome(sessions(5));
    const claude = fakeCli("claude", ALIASES);
    const { code, text } = await run({ home, "dry-run": true }, { runners: [claude] });
    expect(code).toBe(0);
    await expect(text).toMatchFileSnapshot(golden("distill-fresh"));
    expect(flat(text)).toContain("5 sessions, about 2 prompts, plus your working preferences");
    expect(flat(text)).toContain(
      "1 Balanced (selected): sonnet for session reads, opus for grouping and writing",
    );
    expect(flat(text)).toContain("2 Best: opus for session reads, fable for grouping and writing");
    expect(flat(text)).not.toContain("Also ready");
    expect(flat(text)).not.toContain("Library");
    // One line says what happens before the CLIs are asked, and it makes no
    // claim about the network: the run session says so itself when a model
    // list really comes from a service.
    expect(text.split(LISTING_LINE)).toHaveLength(2);
    expect(flat(text).indexOf(LISTING_LINE)).toBeLessThan(
      flat(text).indexOf("Reflect on your history"),
    );
    expect(flat(text)).not.toMatch(/contact your provider|contacts its service/);
    expect(modelCalls(claude)).toBe(0);
  });

  it("several CLIs ready (golden)", async () => {
    const home = tmpHome(sessions(4));
    const runners = [
      fakeCli("claude", ALIASES),
      fakeCli("codex", CODEX),
      fakeCli("opencode", NONE),
    ];
    const { text } = await run({ home, "dry-run": true }, { runners });
    await expect(text).toMatchFileSnapshot(golden("distill-several-ready"));
    expect(flat(text)).toContain("Also ready if needed: Codex, OpenCode.");
    expect(flat(text)).toContain("through Claude Code (or the CLI the run moves to)");
    for (const cli of runners) expect(modelCalls(cli)).toBe(0);
  });

  it("existing library: earlier results regenerated, edits kept (golden)", async () => {
    const built = homeBuilder()
      .session({
        project: "alpha",
        sessionId: "a1111111-0000-4000-8000-000000000001",
        messages: ["Please keep the change small.", "Then run the tests."],
      })
      .session({
        project: "alpha",
        sessionId: "a2222222-0000-4000-8000-000000000002",
        messages: ["Add a short changelog entry.", "Use plain words."],
      })
      .digestAll()
      .task({ slug: "small-change", members: [0, 1] })
      .library("small-change")
      .build();
    tmpDirs.push(built.dir);
    const claude = fakeCli("claude", ALIASES);
    const { text } = await run({ home: built.dir, "dry-run": true }, { runners: [claude] });
    await expect(text).toMatchFileSnapshot(golden("distill-existing-library"));
    expect(flat(text)).toContain("1 saved prompt. 2 earlier results will be regenerated.");
    expect(flat(text)).toContain("Hand-edited prompts, ratings, and reviews are kept.");
  });

  it("a CLI with no model list: no Balanced or Best, one note (golden)", async () => {
    const home = tmpHome(sessions(3));
    const kiro = fakeCli("kiro", NONE);
    const { text } = await run({ home, "dry-run": true }, { runners: [kiro] });
    await expect(text).toMatchFileSnapshot(golden("distill-no-model-list"));
    expect(flat(text)).not.toMatch(/Balanced|Best/);
    expect(flat(text).split("did not list its models").length - 1).toBe(1);
  });

  it("explicit --runner stays on that CLI (golden)", async () => {
    const home = tmpHome(sessions(3));
    const runners = [fakeCli("claude", ALIASES), fakeCli("codex", CODEX)];
    const { text } = await run({ home, runner: "codex", "dry-run": true }, { runners });
    await expect(text).toMatchFileSnapshot(golden("distill-explicit-runner"));
    expect(flat(text)).toContain("Runs on Codex (codex 9.9.9)");
    expect(flat(text)).toContain("This run stays on this CLI.");
    expect(flat(text)).toContain(
      "gpt-5.6-terra for session reads, gpt-5.6-sol for grouping and writing",
    );
    expect(flat(text)).not.toContain("Also ready");
  });

  it("explicit --model: one model, no choice (golden)", async () => {
    const home = tmpHome(sessions(3));
    const runners = [fakeCli("claude", ALIASES), fakeCli("codex", CODEX)];
    const { text } = await run({ home, model: "model-x", "dry-run": true }, { runners });
    await expect(text).toMatchFileSnapshot(golden("distill-explicit-model"));
    expect(flat(text)).toContain("Models model-x for every step.");
    expect(flat(text)).not.toMatch(/Balanced|Best/);
  });

  it("quick start offered for a large history, then declined (golden)", async () => {
    vi.stubEnv("HUMAN_HINDSIGHT_PLAIN", "1");
    const home = tmpHome(sessions(30));
    const claude = fakeCli("claude", ALIASES);
    const io = scripted([
      ["Choose [", "1\n"],
      // The Start question is a menu too: q declines.
      ["Choose [", "q\n"],
    ]);
    const { code, text } = await run(
      { home },
      { runners: [claude], input: io.input, output: io.output as unknown as Writable },
    );
    expect(code).toBe(2);
    expect(io.remaining).toEqual([]);
    await expect(text).toMatchFileSnapshot(golden("distill-quick-start"));
    expect(flat(text)).toContain("25 most recent sessions");
    expect(flat(text)).toContain("All 30 eligible sessions");
    expect(flat(text)).toContain("25 recent sessions across 1 project · 30 eligible");
    expect(modelCalls(claude)).toBe(0);
    // One line says what is being checked before the plan; no line per step of it.
    expect(text).toContain("Checking available coding CLIs…");
    expect(text).not.toMatch(/Finding ready CLIs|Checking session sizes/);
  });

  it("a batch limit and the environment's models: window estimate and stage models, nothing written", async () => {
    const home = tmpHome(sessions(5));
    vi.stubEnv("HUMAN_HINDSIGHT_MODEL", "session-model");
    vi.stubEnv("HUMAN_HINDSIGHT_CLUSTER_MODEL", "grouping-model");
    const claude = fakeCli("claude", ALIASES);
    const { code, text } = await run(
      { home, "cluster-batch-size": "2", "dry-run": true },
      { runners: [claude] },
    );
    expect(code).toBe(0);
    expect(flat(text)).toContain("about 4 grouping calls (estimated 3 batches and 1 merge)");
    expect(flat(text)).toContain(
      "session-model for session reads, grouping-model for grouping, session-model for writing",
    );
    expect(fs.existsSync(path.join(home, "distill"))).toBe(false);
    expect(modelCalls(claude)).toBe(0);
  });

  it("never offers quick start without a terminal, and names the flag instead", async () => {
    const home = tmpHome(sessions(30));
    const { text } = await run(
      { home, "dry-run": true },
      { runners: [fakeCli("claude", ALIASES)] },
    );
    expect(flat(text)).not.toContain("Choose [");
    expect(flat(text)).toContain("To start smaller, run with --recent 25");
  });
});

// --- consent promises ----------------------------------------------------------

describe("consent", () => {
  it("an explicit automatic runner keeps its disclosed fallback order", async () => {
    const home = tmpHome(sessions(1));
    const claude = fakeCli("claude", ALIASES, () => {
      throw Object.assign(new Error("Signed out."), { kind: "sign-in" });
    });
    const codex = fakeCli("codex", CODEX);
    const { code, text } = await run(
      { home, runner: "auto", generalize: false },
      {
        runners: [claude, codex],
        input: PassThrough.from(["s\n"]),
      },
    );
    expect(code).toBe(0);
    expect(text).not.toContain("Which coding CLI should run this reflection?");
    expect(flat(text)).toContain("If this CLI stops working, the run can move to Codex.");
    expect(flat(text)).toContain("through Claude Code (or the CLI the run moves to)");
    expect(modelCalls(codex, "digest")).toBe(1);
  });

  it("switches the displayed models and cache identity with the CLI, then runs only the pinned Best plan", async () => {
    const home = tmpHome(sessions(2));
    const claude = fakeCli("claude", ALIASES);
    const codex = fakeCli("codex", CODEX);
    const input = PassThrough.from(["s\nc\n2\nx\n\ns\n"]);
    const result = await run({ home, generalize: false }, { runners: [claude, codex], input });
    expect(result.code).toBe(0);
    expect(result.text).toContain("Which coding CLI should run this reflection?");
    expect(result.text).toContain("Choose a coding CLI before pressing s to start.");
    expect(flat(result.text)).toContain("fable for grouping and writing");
    expect(flat(result.text)).toContain("gpt-5.6-astra for grouping and writing");
    expect(flat(result.text)).toContain("This run stays on this CLI.");
    expect(claude.calls).toEqual([]);
    expect(
      codex.calls
        .filter((call) => call.stage === "check")
        .map((call) => call.model)
        .sort(),
    ).toEqual(["gpt-5.6-astra", "gpt-5.6-sol"]);
    expect(codex.calls.filter((call) => call.stage === "digest").map((call) => call.model)).toEqual(
      ["gpt-5.6-sol", "gpt-5.6-sol"],
    );
    const resume = await run(
      { home, runner: "codex", quality: "best", "dry-run": true },
      { runners: [claude, codex] },
    );
    expect(flat(resume.text)).toContain("no new session reads (2 reused from saved work)");
    expect(resume.text).not.toContain("Which coding CLI");
  });

  it.each([
    { name: "a no", input: () => PassThrough.from(["n\n"]) as Readable },
    { name: "end of input", input: () => PassThrough.from([]) as Readable },
  ])("declining with $name exits 2 and makes no model call", async ({ input }) => {
    const home = tmpHome(sessions(3));
    const runners = [fakeCli("claude", ALIASES), fakeCli("codex", CODEX)];
    const { code, text } = await run({ home }, { runners, input: input() });
    expect(code).toBe(2);
    expect(flat(text)).toContain("Declined. Nothing was sent.");
    for (const cli of runners) expect(modelCalls(cli)).toBe(0);
    expect(fs.existsSync(path.join(home, "distill"))).toBe(false);
  });

  it.each([
    {
      name: "a no",
      args: {},
      input: (): Readable | undefined => PassThrough.from(["n\n"]),
      code: 2,
    },
    {
      name: "end of input",
      args: {},
      input: (): Readable | undefined => PassThrough.from([]),
      code: 2,
    },
    {
      name: "--dry-run",
      args: { "dry-run": true },
      input: (): Readable | undefined => undefined,
      code: 0,
    },
  ])("after an export into a fresh data home, $name leaves the home as the export left it", async ({
    args,
    input,
    code,
  }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-distill-fresh-"));
    tmpDirs.push(root);
    const home = path.join(root, "data");
    const fixture = path.join(import.meta.dirname, "fixtures", "export-home");
    runExport({
      home,
      source: "claude",
      "claude-dir": fixture,
      output: new Writable({ write: (_c, _e, done) => done() }),
    });
    const exported = snapshot(home);
    // Export writes its own folder and nothing else, not even an empty one.
    expect(Object.keys(exported).every((rel) => rel.startsWith("exports"))).toBe(true);
    const runners = [fakeCli("claude", ALIASES)];
    const result = await run({ home, source: "claude", ...args }, { runners, input: input() });
    expect(result.code).toBe(code);
    expect(modelCalls(runners[0] as ReturnType<typeof fakeCli>)).toBe(0);
    expect(snapshot(home)).toEqual(exported);
  });

  it("the real Claude adapter: declining spawns local probes only, never a model call", async () => {
    const home = tmpHome(sessions(3));
    const io = fakeRunnerIo()
      .script(
        "claude",
        { has: ["--help"] },
        {
          stdout:
            "--output-format --json-schema --tools --safe-mode --system-prompt --strict-mcp-config --mcp-config --settings --disable-slash-commands --no-chrome --no-session-persistence",
        },
      )
      .script("claude", { has: ["--version"] }, { stdout: "9.9.9 (Claude Code)" })
      .failOnUnscripted();
    const { code, text } = await run(
      { home, runner: "claude" },
      { io, input: PassThrough.from([]) as Readable },
    );
    expect(code).toBe(2);
    expect(flat(text)).toContain("Runs on Claude Code (claude 9.9.9)");
    expect(io.callsOf("claude", { has: ["-p"] })).toEqual([]);
  });

  it("--dry-run writes nothing under the data home and makes no model call", async () => {
    const built = homeBuilder()
      .session({
        project: "alpha",
        sessionId: "a1111111-0000-4000-8000-000000000001",
        messages: ["Keep it small.", "Run the tests."],
      })
      .digestAll()
      .task({ slug: "small-change", members: [0] })
      .library("small-change")
      .build();
    tmpDirs.push(built.dir);
    const io = fakeRunnerIo()
      .script(
        "claude",
        { has: ["--help"] },
        {
          stdout:
            "--output-format --json-schema --tools --safe-mode --system-prompt --strict-mcp-config --mcp-config --settings --disable-slash-commands --no-chrome --no-session-persistence",
        },
      )
      .script("claude", { has: ["--version"] }, { stdout: "9.9.9 (Claude Code)" })
      .failOnUnscripted();
    const before = snapshot(built.dir);
    const { code } = await run({ home: built.dir, fresh: true, "dry-run": true }, { io });
    expect(code).toBe(0);
    expect(snapshot(built.dir)).toEqual(before);
    expect(io.callsOf("claude", { has: ["-p"] })).toEqual([]);
  });

  it("--yes never reads stdin, before or after the run, and prints the other CLIs as text", async () => {
    const reads = [
      "on",
      "once",
      "addListener",
      "prependListener",
      "prependOnceListener",
      "read",
      "resume",
      "pipe",
    ] as const;
    const spies = reads.map((method) => vi.spyOn(process.stdin, method));
    const home = tmpHome(sessions(2));
    const runners = [fakeCli("claude", ALIASES), fakeCli("codex", CODEX)];
    const { code, text } = await run({ home, yes: true }, { runners });
    expect(code).toBe(0);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(flat(text)).toContain("Also ready if needed: Codex.");
    expect(flat(text)).toContain("human-hindsight gui");
  });

  it("--yes on a terminal with a large history never offers quick start or reads input", async () => {
    vi.stubEnv("HUMAN_HINDSIGHT_PLAIN", "1");
    const home = tmpHome(sessions(26));
    const input = fakeInput();
    const touched: string[] = [];
    for (const method of ["on", "once", "read", "resume", "setRawMode"] as const) {
      const original = input[method].bind(input) as (...a: unknown[]) => unknown;
      (input as unknown as Record<string, unknown>)[method] = (...a: unknown[]) => {
        touched.push(method);
        return original(...a);
      };
    }
    const claude = fakeCli("claude", ALIASES);
    const output = fakeOutput();
    // The plan is reached with every session; the run itself is covered elsewhere.
    let reached: DistillPlan | undefined;
    const confirm = async (plan: DistillPlan): Promise<ConsentResult> => {
      reached = plan;
      return "declined";
    };
    const { code, text } = await run(
      { home, yes: true },
      { runners: [claude], input, output: output as unknown as Writable, confirm },
    );
    expect(code).toBe(2);
    expect(reached?.sessions).toBe(26);
    expect(touched).toEqual([]);
    expect(flat(text)).not.toContain("Which history do you want to reflect on?");
    expect(modelCalls(claude)).toBe(0);
  });

  it("Ctrl-C while the CLIs are checked exits 130 with one line and sends nothing", async () => {
    const home = tmpHome(sessions(3));
    const host = fakeHost();
    const slow = fakeCli("claude", ALIASES);
    slow.listModels = () => {
      host.emit("SIGINT");
      return new Promise(() => {}); // the process ends before the list arrives
    };
    const output = capture();
    const code = await new Promise<number>((resolve) => {
      void runDistill({ home }, { runners: [slow], host, output, exit: resolve, now: FIXED_NOW });
    });
    const text = goldenText(output.text());
    outputs.push(text);
    expect(code).toBe(130);
    expect(text.trim().split("\n").at(-1)).toBe("Interrupted. Nothing was sent.");
    expect(modelCalls(slow)).toBe(0);
    expect(host.listenerCount("SIGINT")).toBe(0);
  });

  it("Ctrl-C at the question exits 130 with one line and sends nothing", async () => {
    vi.stubEnv("HUMAN_HINDSIGHT_PLAIN", "1");
    const home = tmpHome(sessions(3));
    const claude = fakeCli("claude", ALIASES);
    const host = fakeHost();
    const io = scripted([["Choose [", "SIGINT"]], host);
    const { code, text } = await run(
      { home },
      { runners: [claude], input: io.input, output: io.output as unknown as Writable, host },
    );
    expect(code).toBe(130);
    expect(text.trim().split("\n").at(-1)).toBe("Interrupted.");
    expect(text.match(/Interrupted/g)).toHaveLength(1);
    expect(modelCalls(claude)).toBe(0);
  });

  it("Ctrl-C in the quick-start menu exits 130 after the menu's own line", async () => {
    vi.stubEnv("HUMAN_HINDSIGHT_PLAIN", "1");
    const home = tmpHome(sessions(30));
    const claude = fakeCli("claude", ALIASES);
    const host = fakeHost();
    const io = scripted([["Choose [", "SIGINT"]], host);
    const { code, text } = await run(
      { home },
      { runners: [claude], input: io.input, output: io.output as unknown as Writable, host },
    );
    expect(code).toBe(130);
    expect(text.match(/Interrupted\./g)).toHaveLength(1);
    expect(modelCalls(claude)).toBe(0);
  });

  it("passes the computed plan to the consent gate", async () => {
    const home = tmpHome([entry("a", "x", 5), entry("b", "x", 3), entry("c", "x", 1)]);
    let captured: DistillPlan | undefined;
    const confirm = async (plan: DistillPlan): Promise<ConsentResult> => {
      captured = plan;
      return "dry-run";
    };
    const { code, text } = await run({ home }, { confirm, runners: [fakeCli("claude", ALIASES)] });
    expect(code).toBe(0);
    expect(captured).toMatchObject({ sessions: 2, digests: 2, cluster: 1, authorEstimate: 1 });
    expect(flat(text)).toContain("Sessions that would be read:");
  });

  it.each([
    {
      name: "refuses a session over the budget before consent",
      args: { "input-budget": "1000" },
      big: true,
      code: 1,
      says: "longer than the size limit per call",
    },
    {
      name: "exits 0 when nothing meets the substance threshold",
      args: { "min-substance": "9" },
      big: false,
      code: 0,
      says: "Nothing to reflect on",
    },
  ])("$name", async ({ args, big, code, says }) => {
    const home = tmpHome([entry("big", "x", 5)]);
    if (big) fs.writeFileSync(path.join(home, "exports", "big"), "z".repeat(5_000));
    const confirm = vi.fn();
    const claude = fakeCli("claude", ALIASES);
    const result = await run({ home, ...args }, { confirm, runners: [claude] });
    expect(result.code).toBe(code);
    expect(flat(result.text)).toContain(says);
    expect(confirm).not.toHaveBeenCalled();
    expect(modelCalls(claude)).toBe(0);
  });

  it.each([
    ["not valid JSON", "{ damaged"],
    ["not a list of sessions", '{"entries": 3}'],
  ])("a damaged manifest (%s) is one plain failure naming the file and the fix; nothing runs", async (reason, body) => {
    const home = tmpHome(sessions(2));
    fs.writeFileSync(path.join(home, "exports", "manifest.json"), body);
    const confirm = vi.fn();
    const runner = vi.fn();
    const output = capture();
    const failure = await runDistill(
      { home, yes: true },
      { confirm, runner: runner as RunnerFn, output },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlainFailure);
    expect((failure as Error).message).toBe(
      `${path.join(home, "exports", "manifest.json")} is damaged (${reason}). Run \`npx human-hindsight export\` again to rebuild it.`,
    );
    // Nothing about it on stdout; the guard writes the line to stderr.
    expect(output.text()).not.toMatch(/manifest|error/);
    expect(confirm).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it.each([
    "0",
    "-1",
    "1.5",
    "abc",
    "",
    "1e2",
    "9007199254740992",
  ])("rejects cluster batch size %j before exporting, prompting, or spending", async (batchSize) => {
    const home = tmpHome(null);
    const confirm = vi.fn();
    const runner = vi.fn();
    const { code, text } = await run(
      { home, source: "claude", "cluster-batch-size": batchSize, yes: true },
      { confirm, runner: runner as RunnerFn },
    );
    expect(code).toBe(1);
    expect(flat(text)).toContain(
      `error: --cluster-batch-size takes a whole number of sessions, 1 or more, not ${JSON.stringify(batchSize)}.`,
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it.each([
    // Strict retry reads the first four as well, so it is checked there too.
    ["concurrency", "0", "a whole number of calls at a time, 1 or more", true],
    ["timeout", "90s", "a whole number of seconds, 1 or more", true],
    ["input-budget", "999", "a whole number of characters, 1000 or more", true],
    ["truncate", "extrem", "never or extreme", true],
    ["min-substance", "-1", "a whole number of messages, 0 or more", false],
    ["recent", "ten", "a whole number of sessions, such as 25", false],
  ])("a wrong --%s is an error naming the value, before anything is read or sent", async (option, value, says, retried) => {
    const home = tmpHome(null);
    const confirm = vi.fn();
    const runner = vi.fn();
    for (const retry of retried
      ? [{ source: "claude" }, { "retry-failed": true }]
      : [{ source: "claude" }]) {
      const { code, text } = await run(
        { home, [option]: value, yes: true, ...retry },
        { confirm, runner: runner as RunnerFn },
      );
      expect(code).toBe(1);
      expect(flat(text)).toContain(
        `error: --${option} takes ${says}, not ${JSON.stringify(value)}.`,
      );
    }
    expect(confirm).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(fs.readdirSync(home)).toEqual([]);
  });
});

// --- --fresh -------------------------------------------------------------------

describe("--fresh", () => {
  function withCheckpoint(generation: string): { home: string; cp: string } {
    const home = tmpHome(sessions(1));
    fs.mkdirSync(path.join(home, "distill"), { recursive: true });
    const cp = path.join(home, "distill", "digests.json");
    fs.writeFileSync(cp, JSON.stringify({ generation, prompt_version: 1, digests: { s00: {} } }));
    return { home, cp };
  }

  it.each([
    { name: "declined at its own question", input: "n\n", confirm: undefined, code: 2 },
    {
      name: "confirmed but the plan declined",
      input: "y\n",
      confirm: async () => "declined" as const,
      code: 2,
    },
  ])("keeps checkpoints when $name", async ({ input, confirm, code }) => {
    const { home, cp } = withCheckpoint("keep-me");
    const claude = fakeCli("claude", ALIASES);
    const result = await run(
      { home, fresh: true },
      { input: PassThrough.from([input]) as Readable, confirm, runners: [claude] },
    );
    expect(result.code).toBe(code);
    expect(JSON.parse(fs.readFileSync(cp, "utf8")).generation).toBe("keep-me");
    expect(modelCalls(claude)).toBe(0);
  });

  it("keeps checkpoints when the readiness check fails, and clears them only after it passes", async () => {
    const { home, cp } = withCheckpoint("old");
    const signedOut = fakeCli("claude", ALIASES, () => {
      throw Object.assign(new Error("Not signed in."), { kind: "sign-in" });
    });
    const failed = await run({ home, fresh: true, yes: true }, { runners: [signedOut] });
    expect(failed.code).toBe(1);
    expect(flat(failed.text)).toContain("Claude Code is not signed in.");
    expect(JSON.parse(fs.readFileSync(cp, "utf8")).generation).toBe("old");

    const ready = await run(
      { home, fresh: true, yes: true },
      { runners: [fakeCli("claude", ALIASES)] },
    );
    expect(ready.code).toBe(0);
    expect(flat(ready.text)).toContain("Saved work cleared.");
    expect(JSON.parse(fs.readFileSync(cp, "utf8")).generation).not.toBe("old");
  });
});

// --- the run -------------------------------------------------------------------

describe("the run", () => {
  it("says how many earlier prompts the new grouping left behind, and the command that removes them", async () => {
    const built = homeBuilder()
      .session({
        project: "alpha",
        sessionId: "a1111111-0000-4000-8000-000000000001",
        messages: ["Please keep the change small.", "Then run the tests."],
      })
      .session({
        project: "alpha",
        sessionId: "a2222222-0000-4000-8000-000000000002",
        messages: ["Add a short changelog entry.", "Use plain words."],
      })
      .digestAll()
      // The grouping an earlier version made; this run groups the sessions anew.
      .task({ slug: "earlier-prompt-one", members: [0] })
      .task({ slug: "earlier-prompt-two", members: [1] })
      .library("earlier-prompt-one")
      .library("earlier-prompt-two")
      .build();
    tmpDirs.push(built.dir);
    const { code, text } = await run(
      { home: built.dir, yes: true, generalize: false },
      { runners: [fakeCli("claude", ALIASES)] },
    );
    expect(code).toBe(0);
    const lines = text.split("\n");
    const at = lines.findIndex((line) => line.startsWith("2 earlier prompts are no longer part"));
    // Wrapped to the 80 columns at a word boundary...
    expect(flat(lines.slice(at, at + 2).join(" "))).toBe(
      "2 earlier prompts are no longer part of the grouping. They are kept; remove them with:",
    );
    // ...and the command alone on its own line, for this home.
    expect(lines[at + 2]).toBe("  npx human-hindsight prune --home=<HOME>");
    expect(text.split("no longer part of the grouping").length - 1).toBe(1);
  });

  it("names the prompts it kept because you edited them, on their own line, with how to replace them", async () => {
    const home = tmpHome(sessions(3));
    expect((await run({ home, yes: true }, { runners: [fakeCli("claude", ALIASES)] })).code).toBe(
      0,
    );
    const [slug] = fs
      .readdirSync(path.join(home, "library"))
      .filter((name) => name.startsWith("task-"));
    fs.writeFileSync(
      path.join(home, "library", slug as string, `${slug}.oneshot.md`),
      "my own words\n",
    );
    // Another plan changes every input, so the prompt would be written again.
    const { text } = await run(
      { home, yes: true, quality: "best" },
      { runners: [fakeCli("claude", ALIASES)] },
    );
    expect(flat(text)).toContain(
      `Kept 1 prompt you edited, as you wrote it: ${slug}. To replace it with the new version, run npx human-hindsight reflect --force.`,
    );
    expect(
      fs.readFileSync(path.join(home, "library", slug as string, `${slug}.oneshot.md`), "utf8"),
    ).toBe("my own words\n");
    expect(text).not.toMatch(/no completed\/partial|skipped task/);
  });

  it.each([
    [
      { status: "done", lessons: 2, reused: 1, errors: [] },
      "Working preferences: 2 preferences summarized from 3 observations (1 batch reused).",
    ],
    [
      {
        status: "partial",
        lessons: 1,
        reused: 0,
        errors: ["Batch 2: boom"],
        artifact: {
          windows: { a: { input_ids: ["p1", "p2"] } },
          incomplete: { windows_failed: 1, candidates_not_covered: 1 },
        },
      },
      "Working preferences: 2 of 3 preferences summarized; run npx human-hindsight reflect to finish (finished work is reused).",
    ],
    [
      { status: "failed", lessons: 0, reused: 0, errors: ["Batch 1: boom"] },
      "Working preferences could not be summarized this time (Batch 1: boom). Your prompts are saved; run npx human-hindsight reflect to finish them.",
    ],
  ] as const)("the working preferences line for a run that is %s", (result, line) => {
    expect(preferencesLine(result as unknown as GeneralizeResult, 3)).toBe(line);
  });

  it("--dry-run after earlier work lists only the sessions it would really read", async () => {
    const home = tmpHome(sessions(2));
    expect((await run({ home, yes: true }, { runners: [fakeCli("claude", ALIASES)] })).code).toBe(
      0,
    );
    const again = await run({ home, "dry-run": true }, { runners: [fakeCli("claude", ALIASES)] });
    expect(again.text).toContain(
      "No session needs reading again; 2 sessions are reused from saved work.",
    );
    expect(again.text).not.toContain("Sessions that would be read");
    // One new session: only it is listed, and the rest are said to be reused.
    const three = sessions(3);
    fs.writeFileSync(path.join(home, "exports", "manifest.json"), JSON.stringify(three));
    fs.writeFileSync(
      path.join(home, "exports", "s02"),
      "### 2026-01-01\n\nBuild the s02 feature.\n",
    );
    const more = await run({ home, "dry-run": true }, { runners: [fakeCli("claude", ALIASES)] });
    const listed = more.text.split("Sessions that would be read:")[1] ?? "";
    expect(listed).toContain("s02");
    expect(listed).not.toMatch(/s00|s01/);
    expect(more.text).toContain("The other 2 sessions are reused from saved work.");
  });

  it("says nothing about earlier prompts when the library has none", async () => {
    const home = tmpHome(sessions(3));
    const { code, text } = await run(
      { home, yes: true },
      { runners: [fakeCli("claude", ALIASES)] },
    );
    expect(code).toBe(0);
    expect(text).not.toMatch(/earlier prompt|prune/);
  });

  it("runs every stage without a terminal: plain progress lines and a summary (golden)", async () => {
    const home = tmpHome(sessions(3));
    const claude = fakeCli("claude", ALIASES);
    const { code, text } = await run({ home, yes: true }, { runners: [claude] });
    expect(code).toBe(0);
    await expect(text).toMatchFileSnapshot(golden("distill-run-no-terminal"));
    expect(flat(text)).toContain("Reading sessions 3/3");
    expect(flat(text)).toContain("Read 3 of 3 sessions.");
    expect(flat(text)).toContain("Library: 1 prompt written.");
    expect(flat(text)).toContain("Claude Code: 7 CLI calls (sonnet, opus).");
    expect(flat(text)).not.toMatch(/digest stage|oneshot|middle-out|no LLM/);
    expect(fs.readdirSync(path.join(home, "library"))).toContain("task-s00");
  });

  it("a readiness check that cannot confirm prints its line once and the run continues", async () => {
    const home = tmpHome(sessions(1));
    const slow = fakeCli("claude", ALIASES, (opts) => {
      if (stageOf(opts) === "check")
        throw Object.assign(new Error("timed out"), { kind: "timeout" });
      return answer(opts);
    });
    const { code, text } = await run({ home, yes: true }, { runners: [slow] });
    expect(code).toBe(0);
    expect(text.split("Could not confirm that Claude Code is ready").length - 1).toBe(1);
    expect(modelCalls(slow, "digest")).toBe(1);
  });

  it("a rerun with everything reused makes no call at all, not even the readiness check", async () => {
    const home = tmpHome(sessions(2));
    const first = await run({ home, yes: true }, { runners: [fakeCli("claude", ALIASES)] });
    expect(first.code).toBe(0);
    const again = fakeCli("claude", ALIASES);
    const { code, text } = await run({ home, yes: true }, { runners: [again] });
    expect(code).toBe(0);
    expect(again.calls).toEqual([]);
    expect(flat(text)).not.toContain("Checking that Claude Code is ready");
    expect(text.match(/Everything was already up to date/g)).toHaveLength(1);
  });

  it("a rerun with one new session checks readiness before its first call", async () => {
    const home = tmpHome(sessions(1));
    await run({ home, yes: true }, { runners: [fakeCli("claude", ALIASES)] });
    const grown = sessions(2);
    fs.writeFileSync(path.join(home, "exports", "manifest.json"), JSON.stringify(grown));
    fs.writeFileSync(
      path.join(home, "exports", "s01"),
      "### 2026-01-01\n\nBuild the s01 feature.\n",
    );
    const again = fakeCli("claude", ALIASES);
    const { code, text } = await run({ home, yes: true }, { runners: [again] });
    expect(code).toBe(0);
    // One tiny request per plan model (sonnet reads, opus groups and writes), then the read.
    expect(again.calls.map((call) => call.stage).slice(0, 3)).toEqual(["check", "check", "digest"]);
    expect(modelCalls(again, "check")).toBe(2);
    expect(flat(text)).not.toContain("Everything was already up to date");
  });

  it.each([
    [
      { authored: 3, resumed: 12, kept: 1, skipped: 0 },
      "Library: 3 prompts written, 12 already up to date, 1 kept (edited by you).",
    ],
    [
      { authored: 0, resumed: 13, kept: 0, skipped: 0 },
      "Library: all 13 prompts were already up to date.",
    ],
    [
      { authored: 0, resumed: 1, kept: 0, skipped: 0 },
      "Library: the prompt was already up to date.",
    ],
    [
      { authored: 0, resumed: 2, kept: 1, skipped: 0 },
      "Library: 2 prompts already up to date, 1 kept (edited by you).",
    ],
    [
      { authored: 6, resumed: 0, kept: 0, skipped: 9 },
      "Library: 6 prompts written, 9 groups skipped because every session in them was abandoned.",
    ],
    [
      { authored: 2, resumed: 0, kept: 0, skipped: 1 },
      "Library: 2 prompts written, 1 group skipped because every session in it was abandoned.",
    ],
    [{ authored: 0, resumed: 0, kept: 0, skipped: 0 }, "Library: 0 prompts written."],
  ])("the Library sentence for %o", (counts, sentence) => {
    const of = (n: number) => Array.from({ length: n }, (_, i) => i);
    expect(
      librarySentence({
        authored: of(counts.authored),
        resumed: of(counts.resumed),
        kept: of(counts.kept),
        skipped: of(counts.skipped),
      }),
    ).toBe(sentence);
  });

  it("names the kept prompts up to three, and the rest only with --verbose", () => {
    expect(keptLine(["a", "b", "c"])).toContain(": a, b, c.");
    expect(keptLine(["a", "b", "c", "d"])).toBe(
      "Kept 4 prompts you edited, as you wrote them. To replace them with the new version, run npx human-hindsight reflect --force.",
    );
    expect(keptLine(["a", "b", "c", "d"], true)).toContain(": a, b, c, d.");
  });

  it("the Library sentence counts a fully reused run as up to date, not as written", async () => {
    const home = tmpHome(sessions(2));
    await run({ home, yes: true }, { runners: [fakeCli("claude", ALIASES)] });
    const { code, text } = await run(
      { home, yes: true },
      { runners: [fakeCli("claude", ALIASES)] },
    );
    expect(code).toBe(0);
    expect(flat(text)).toContain("Library: the prompt was already up to date.");
    expect(text).not.toMatch(/prompts? written/);
  });

  it("a prompt edited while it is being written is counted as kept, not written or failed", async () => {
    const home = tmpHome(sessions(2));
    await run({ home, yes: true }, { runners: [fakeCli("claude", ALIASES)] });
    const [slug] = fs.readdirSync(path.join(home, "library")).filter((n) => n.startsWith("task-"));
    const file = path.join(home, "library", slug as string, `${slug}.oneshot.md`);
    const editing = fakeCli("claude", ALIASES, (opts) => {
      if (stageOf(opts) === "author") fs.appendFileSync(file, "\nMy own addition.\n");
      return answer(opts);
    });
    // Another plan changes every input, so the prompt is written again.
    const { code, text } = await run({ home, yes: true, quality: "best" }, { runners: [editing] });
    expect(code).toBe(0);
    expect(flat(text)).toContain("Library: 1 prompt kept (edited by you).");
    expect(flat(text)).toContain("run npx human-hindsight reflect --force");
    expect(text).not.toMatch(/could not be written|prompts? written/);
    expect(fs.readFileSync(file, "utf8")).toContain("My own addition.");
  });

  it("groups whose sessions were all abandoned: one summary and one plain line, the list only with --verbose", async () => {
    const abandoned = (opts: RunOptions<unknown>) =>
      stageOf(opts) === "digest"
        ? { ...(answer(opts) as object), outcome: "abandoned" }
        : answer(opts);
    const home = tmpHome(sessions(2));
    const plain = await run(
      { home, yes: true },
      { runners: [fakeCli("claude", ALIASES, abandoned)] },
    );
    expect(flat(plain.text)).toContain(
      "Library: 1 group skipped because every session in it was abandoned.",
    );
    expect(flat(plain.text)).toContain(
      "A prompt is not written for work that was abandoned. Preferences from those sessions are still kept.",
    );
    expect(plain.text).not.toMatch(/were abandoned|outcomes:|Unclear means/);
    const again = tmpHome(sessions(2));
    const verbose = await run(
      { home: again, yes: true, verbose: true },
      { runners: [fakeCli("claude", ALIASES, abandoned)] },
    );
    expect(flat(verbose.text)).toMatch(/task-\S+: all 2 sessions were abandoned/);
  });

  it.each([
    80, 60,
  ])("every sentence of the closing summary wraps at %i columns", async (columns) => {
    // Two groups: one written, one whose sessions were all abandoned.
    const someAbandoned = (opts: RunOptions<unknown>) =>
      stageOf(opts) === "digest" && /Build the s0[01] feature/.test(opts.prompt)
        ? { ...(answer(opts) as object), outcome: "abandoned" }
        : answer(opts);
    const home = tmpHome(sessions(4));
    const output = columns === 80 ? capture() : fakeOutput({ columns, rows: 40 });
    const { code } = await run(
      { home, yes: true, "cluster-batch-size": "2" },
      { runners: [fakeCli("claude", ALIASES, someAbandoned)], output },
    );
    expect(code).toBe(0);
    const raw = (output as { text(): string }).text();
    const lines = goldenText(raw)
      .split("\n")
      .map((line) => line.split("\r").at(-1) ?? "");
    const from = lines.findIndex((line) => line.startsWith("Library: "));
    expect(flat(lines.slice(from).join(" "))).toContain(
      "Library: 1 prompt written, 1 group skipped because every session in it was abandoned.",
    );
    // A command or a path is alone on its line and may be wider; prose never is.
    const prose = lines
      .slice(from)
      .filter(
        (line) =>
          !/^\s+npx human-hindsight\s|^→ next: npx human-hindsight\s|^Library: .*\/library$/.test(
            line,
          ),
      );
    expect(prose.filter((line) => line.length > columns)).toEqual([]);
  });

  it("a group whose endings could not be judged still gets its prompt, marked as not verified", async () => {
    const unclear = (opts: RunOptions<unknown>) =>
      stageOf(opts) === "digest"
        ? { ...(answer(opts) as object), outcome: "unclear" }
        : answer(opts);
    const home = tmpHome(sessions(2));
    const { code, text } = await run(
      { home, yes: true },
      { runners: [fakeCli("claude", ALIASES, unclear)] },
    );
    expect(code).toBe(0);
    expect(text).not.toMatch(/skipped because/);
    const [slug] = fs.readdirSync(path.join(home, "library")).filter((n) => n.startsWith("task-"));
    const dir = path.join(home, "library", slug as string);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "sources.json"), "utf8"))).toMatchObject({
      outcome_verified: false,
      confidence: "low",
    });
    expect(fs.readFileSync(path.join(dir, `${slug}.oneshot.md`), "utf8")).toContain(
      "outcome: not verified",
    );
  });

  it("ends with the preferences sentence status and preferences use, and the review command alone", async () => {
    const home = tmpHome(sessions(2));
    const claude = fakeCli("claude", ALIASES, (opts) => answer(opts, { preferences: true }));
    const { code, text } = await run({ home, yes: true }, { runners: [claude] });
    expect(code).toBe(0);
    const story = preferenceStoryText(preferenceStory(home));
    expect(story).toMatch(
      /preferences? observed: \d+ waiting for your review, none accepted yet\./,
    );
    const lines = text.split("\n");
    const at = lines.findIndex((line) => line.includes(story));
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe("Review them in your browser:");
    expect(lines[at + 2]).toMatch(/^ {2}npx human-hindsight gui --home=\S+ --tab=preferences$/);
    expect(text.split(story).length - 1).toBe(1);
    expect(flat(text)).toContain("What you care about Keep each change small.");
    expect(text).toContain("Reflection finished with incomplete preference summaries");
  });

  it("when only the working preferences need a call, the check runs just before it", async () => {
    const home = tmpHome(sessions(1));
    // The first run saves reads, grouping, and the prompt; its summary fails.
    const first = fakeCli("claude", ALIASES, (opts) => answer(opts, { preferences: true }));
    await run({ home, yes: true }, { runners: [first] });
    expect(modelCalls(first, "generalize")).toBeGreaterThan(0);
    const again = fakeCli("claude", ALIASES, (opts) => answer(opts, { preferences: true }));
    const { code, text } = await run({ home, yes: true }, { runners: [again] });
    expect(code).toBe(0);
    expect(again.calls.map((call) => call.stage)).toEqual(["check", "check", "generalize"]);
    expect(flat(text)).not.toContain("Everything was already up to date");
  });

  it("a lazy readiness check that fails stops the run with its line and exit 1", async () => {
    const home = tmpHome(sessions(1));
    await run(
      { home, yes: true },
      { runners: [fakeCli("claude", ALIASES, (opts) => answer(opts, { preferences: true }))] },
    );
    const signedOut = fakeCli("claude", ALIASES, () => {
      throw Object.assign(new Error("Not signed in."), { kind: "sign-in" });
    });
    const { code, text } = await run({ home, yes: true }, { runners: [signedOut] });
    expect(code).toBe(1);
    expect(new Set(signedOut.calls.map((call) => call.stage))).toEqual(new Set(["check"]));
    // One line says what happened and the one thing to do; failures below it say it short.
    const lines = text.split("\n");
    expect(lines.filter((line) => line.startsWith("Claude Code is not signed in."))).toEqual([
      "Claude Code is not signed in. No other coding CLI is ready on this machine.",
    ]);
    expect(lines.filter((line) => line === "Run: claude auth login")).toHaveLength(1);
    expect(flat(text)).not.toMatch(/readiness check|\/login|consent plan|Window 1/);
    expect(flat(text)).not.toContain("Everything was already up to date");
  });

  it.each([
    {
      name: "a typed --model, with the variable set to the same value",
      args: { model: "model-x" },
      says: "To allow another CLI, remove --model and unset HUMAN_HINDSIGHT_MODEL.",
    },
    {
      name: "the variable alone",
      args: {},
      says: "To allow another CLI, unset HUMAN_HINDSIGHT_MODEL.",
    },
  ])("a pinned run that cannot start names what pinned it: $name", async ({ args, says }) => {
    vi.stubEnv("HUMAN_HINDSIGHT_MODEL", "model-x");
    const home = tmpHome(sessions(1));
    const limited = fakeCli("claude", ALIASES, () => {
      throw Object.assign(new Error("Usage limit reached."), { kind: "quota" });
    });
    const { code, text } = await run({ home, yes: true, ...args }, { runners: [limited] });
    expect(code).toBe(1);
    expect(flat(text)).toContain(`Claude Code has reached its usage limit. ${says}`);
  });

  it("goes on past a failed session read, writes the rest, and exits 1", async () => {
    const home = tmpHome([entry("a", "x", 5), entry("b", "x", 4)]);
    const claude = fakeCli("claude", ALIASES, (opts) => {
      if (stageOf(opts) === "digest" && opts.prompt.includes("Build the b feature"))
        throw new Error("boom-b");
      return answer(opts);
    });
    const { code, text } = await run({ home, yes: true }, { runners: [claude] });
    expect(code).toBe(1);
    expect(flat(text)).toContain("Sessions that could not be read");
    expect(flat(text)).toContain(
      "npx human-hindsight reflect --home=<HOME> --retry-failed --retry-stage=digest",
    );
    expect(flat(text)).toContain("Library: 1 prompt written.");
  });

  it("--no-group writes one prompt per session and makes no grouping call", async () => {
    const home = tmpHome([entry("a", "x", 5), entry("b", "x", 4)]);
    const claude = fakeCli("claude", ALIASES);
    const { code } = await run(
      {
        home,
        yes: true,
        group: false,
        model: "session-model",
        "cluster-model": "ignored",
        // Read and checked, but grouping-only: it changes nothing here.
        "cluster-batch-size": "7",
      },
      { runners: [claude] },
    );
    expect(code).toBe(0);
    expect(modelCalls(claude, "window")).toBe(0);
    expect(fs.readdirSync(path.join(home, "library")).length).toBe(2);
    expect(
      claude.calls.filter((c) => c.stage !== "check").every((c) => c.model === "session-model"),
    ).toBe(true);
  });

  it("routes grouping windows and merge to their model and reuses session reads after a grouping-only change", async () => {
    const home = tmpHome(["a", "b", "c"].map((name) => entry(name, "x", 3)));
    vi.stubEnv("HUMAN_HINDSIGHT_CLUSTER_MODEL", "ambient-grouping");
    const args = {
      home,
      yes: true,
      model: "session-model",
      "cluster-model": "grouping-model",
      "cluster-batch-size": "1",
    };
    const first = fakeCli("claude", ALIASES);
    expect((await run(args, { runners: [first] })).code).toBe(0);
    const by = (cli: FakeCli, stage: Stage) =>
      cli.calls.filter((c) => c.stage === stage).map((c) => c.model);
    expect(by(first, "digest")).toEqual(["session-model", "session-model", "session-model"]);
    expect(by(first, "window")).toEqual(["grouping-model", "grouping-model", "grouping-model"]);
    expect(by(first, "merge")).toEqual(["grouping-model"]);
    expect(by(first, "author")).toEqual(["session-model", "session-model", "session-model"]);

    let plan: DistillPlan | undefined;
    const second = fakeCli("claude", ALIASES);
    const confirm = async (p: DistillPlan): Promise<ConsentResult> => {
      plan = p;
      return "proceed";
    };
    expect(
      (await run({ ...args, "cluster-model": "new-grouping" }, { runners: [second], confirm }))
        .code,
    ).toBe(0);
    expect(plan?.digests).toBe(0);
    expect(by(second, "digest")).toEqual([]);
    expect(by(second, "window")).toEqual(["new-grouping", "new-grouping", "new-grouping"]);
    expect(
      JSON.parse(fs.readFileSync(path.join(home, "distill/tasks.json"), "utf8")).lineage.model,
    ).toBe("new-grouping");
  });

  it("counts only verified reusable reads, inside the eligible set, for each plan", async () => {
    const home = tmpHome([entry("a", "alpha", 5), entry("b", "beta", 4), entry("c", "beta", 3)]);
    // A legacy checkpoint for "a" and a changed export for "b" promise no reuse.
    fs.mkdirSync(path.join(home, "distill"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "distill", "digests.json"),
      JSON.stringify({ generation: 1, digests: { a: {}, b: { goal: "old" } } }),
    );
    let plan: DistillPlan | undefined;
    const confirm = async (p: DistillPlan): Promise<ConsentResult> => {
      plan = p;
      return "dry-run";
    };
    await run({ home, project: "beta" }, { confirm, runners: [fakeCli("claude", ALIASES)] });
    expect(plan?.digests).toBe(2);
    expect(plan?.choices?.balanced.reusable).toBe(0);
    expect(plan?.choices?.best.reusable).toBe(0);
  });

  it("quick start, then the full run reads only the sessions not read yet; both reuse counts are on screen", async () => {
    const home = tmpHome(sessions(4));
    const first = fakeCli("claude", ALIASES);
    expect((await run({ home, recent: "2", yes: true }, { runners: [first] })).code).toBe(0);
    expect(modelCalls(first, "digest")).toBe(2);

    const preview = await run({ home, "dry-run": true }, { runners: [fakeCli("claude", ALIASES)] });
    expect(flat(preview.text)).toContain(
      "Balanced (selected): sonnet for session reads, opus for grouping and writing. 2 new session reads, 2 reused.",
    );
    expect(flat(preview.text)).toContain(
      "Best: opus for session reads, fable for grouping and writing. 4 new session reads, 2 earlier results regenerated.",
    );

    const full = fakeCli("claude", ALIASES);
    expect((await run({ home, yes: true }, { runners: [full] })).code).toBe(0);
    expect(modelCalls(full, "digest")).toBe(2);
  });

  it.each([
    { damaged: false, lines: [] as string[] },
    {
      damaged: true,
      lines: ["Your saved preference summaries could not be read and will be rebuilt."],
    },
  ])("a failed preference summary leaves the library, prints one notice, exits 0 (damaged set: $damaged)", async ({
    damaged,
    lines,
  }) => {
    const home = tmpHome(sessions(2));
    if (damaged) {
      fs.mkdirSync(path.join(home, "library"), { recursive: true });
      fs.writeFileSync(path.join(home, GENERALIZED_PATH), "{ not json");
    }
    const claude = fakeCli("claude", ALIASES, (opts) => answer(opts, { preferences: true }));
    const { code, text } = await run({ home, yes: true }, { runners: [claude] });
    expect(code).toBe(0);
    expect(modelCalls(claude, "generalize")).toBeGreaterThan(0);
    expect(fs.readdirSync(path.join(home, "library"))).toContain("task-s00");
    for (const line of lines) expect(flat(text)).toContain(line);
    const notices = text
      .split("\n")
      .filter((line) => line.includes("Working preferences could not be summarized"));
    expect(notices).toHaveLength(1);
    // The progress display's own failure line, then the one notice; nothing else repeats the error.
    expect(flat(text).split("synthetic summary failure").length - 1).toBe(2);
  });

  it("Ctrl-C during the session reads: ends promptly with 130, aborts the call in flight, says what is saved, and a rerun reuses finished reads", async () => {
    const home = tmpHome(sessions(4));
    const host = fakeHost();
    let reads = 0;
    let exitCode: number | undefined;
    let inFlight: AbortSignal | undefined;
    let cleaned = false;
    const exited = new Promise<void>((resolve) => {
      const claude = fakeCli("claude", ALIASES, (opts) => {
        if (stageOf(opts) === "digest" && ++reads === 3) {
          inFlight = opts.signal;
          host.emit("SIGINT");
          // A CLI that ignores its signal: this call never returns.
          return new Promise(() => {});
        }
        return answer(opts);
      });
      claude.finalize = async () => {
        cleaned = true;
      };
      const output = capture();
      void runDistill(
        { home, yes: true, concurrency: "1" },
        {
          runners: [claude],
          host,
          output,
          now: FIXED_NOW,
          // The short wait for aborted calls ends at once; the overall cleanup
          // bound never fires, so the exit below shows the cleanup finished
          // although the hung call never returned.
          sleep: (ms) => (ms < 3_000 ? Promise.resolve() : new Promise(() => {})),
          exit: (code) => {
            exitCode = code;
            outputs.push(goldenText(output.text(), { roots: { [home]: "<HOME>" } }));
            resolve();
          },
        },
      );
    });
    await exited;
    expect(exitCode).toBe(130);
    // The call in flight was told to stop (its CLI process group ends), and the
    // runner still got its chance to remove the sessions it saved.
    expect(inFlight?.aborted).toBe(true);
    expect(cleaned).toBe(true);
    const text = outputs.at(-1) ?? "";
    const lines = text.trim().split("\n");
    const said = flat(
      lines
        .slice(
          lines.findIndex((line) => line.startsWith("Interrupted.")),
          -1,
        )
        .join(" "),
    );
    expect(said).toBe("Interrupted. 2 of 4 session reads saved. To continue, run:");
    // The command is alone on its own line, whole.
    const last = lines.at(-1) ?? "";
    expect(last).toMatch(/^ {2}npx human-hindsight reflect --home=<HOME> /);
    expect(last).toContain("--quality=balanced --concurrency=1");
    expect(last).not.toContain("--yes");
    // The stopping run printed nothing after its line.
    expect(text).not.toMatch(/Finished with failures|failed:/);
    expect(fs.existsSync(path.join(home, "library"))).toBe(false);
    expect(fs.existsSync(path.join(home, "distill", "writer.lock"))).toBe(false);

    // A new process: fresh module state, so the abandoned call counts as dead.
    vi.resetModules();
    const fsutil = await import("../src/core/fsutil.js");
    fsutil.setFileWriter(fsutil.unflushedWriter);
    const again = await import("../src/commands/distill.js");
    const rerun = fakeCli("claude", ALIASES);
    const output = capture();
    const rerunCode = await again.runDistill(
      { home, yes: true },
      { runners: [rerun], output, now: FIXED_NOW },
    );
    expect(rerunCode).toBe(0);
    outputs.push(goldenText(output.text()));
    expect(modelCalls(rerun, "digest")).toBe(2);
    expect(flat(output.text())).toContain("2 reused from saved work");
  });
});

// --- no exports yet ----------------------------------------------------------------

describe("no exports yet", () => {
  const EXPORT_FIXTURE = path.join(import.meta.dirname, "fixtures", "export-home");

  it.each([
    {
      name: "a terminal answer of yes exports, then reaches the plan",
      args: {},
      input: "y\n",
      code: 2,
      manifest: true,
    },
    {
      name: "no way to ask: exits 1 and exports nothing",
      args: {},
      input: undefined,
      code: 1,
      manifest: false,
    },
    {
      name: "--dry-run never exports",
      args: { "dry-run": true },
      input: undefined,
      code: 1,
      manifest: false,
    },
    {
      name: "--yes exports and runs through",
      args: { yes: true },
      input: undefined,
      code: 0,
      manifest: true,
    },
  ])("$name", async ({ args, input, code, manifest }) => {
    const home = tmpHome(null);
    const claude = fakeCli("claude", ALIASES);
    const result = await run(
      // source "claude" keeps the offered export to the fixture.
      { home, "claude-dir": EXPORT_FIXTURE, source: "claude", ...args },
      {
        runners: [claude],
        input: input === undefined ? undefined : (PassThrough.from([input]) as Readable),
      },
    );
    expect(result.code).toBe(code);
    expect(fs.existsSync(path.join(home, "exports", "manifest.json"))).toBe(manifest);
    if (!manifest) expect(flat(result.text)).toContain("human-hindsight export");
    if (code === 2) expect(modelCalls(claude)).toBe(0);
  });
});

// --- follow-up -------------------------------------------------------------------

describe("after the run", () => {
  it.each([
    { name: "--yes", args: { yes: true }, input: undefined },
    { name: "a pipe without --yes", args: {}, input: "s\n" },
  ])("$name ends with hints and opens nothing else", async ({ args, input }) => {
    const home = tmpHome(sessions(1));
    const claude = fakeCli("claude", ALIASES, (opts) => answer(opts, { preferences: true }));
    const clipboard = vi.fn();
    const { code, text } = await run(
      { home, ...args },
      {
        runners: [claude],
        clipboard,
        input: input === undefined ? undefined : (PassThrough.from([input]) as Readable),
      },
    );
    expect(code).toBe(0);
    expect(flat(text)).toContain("human-hindsight gui");
    expect(flat(text)).toContain(
      "human-hindsight suggest-subagents --home=<HOME> --quality=balanced --dry-run",
    );
    expect(flat(text)).not.toMatch(/Show your library now\?|What next\?|consolidat/i);
    expect(clipboard).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, "library", "preferences.consolidated.json"))).toBe(false);
  });

  it("status prints the same next command the end of distill printed, with no noise", async () => {
    const home = tmpHome(sessions(1));
    const claude = fakeCli("claude", ALIASES, (opts) => answer(opts, { preferences: true }));
    const args = { home, yes: true, "follow-up": false };
    const { code, text } = await run(args, { runners: [claude] });
    expect(code).toBe(0);
    const gui = (lines: string) =>
      lines.split("\n").find((line) => /^→ next: npx human-hindsight gui\b/.test(line));
    const printed = gui(text);
    expect(printed).toBeDefined();
    const status = goldenText(
      renderStatus({ home, claudeDir: path.join(home, "no-claude"), flow: args }),
      { roots: { [home]: "<HOME>" } },
    );
    expect(gui(status)).toBe(printed);
    expect(printed).not.toMatch(/--no-follow-up|--yes|--kirocrew-dir|--opencode-dir/);
  });

  it("Ctrl-C at the closing menu after a successful run exits 130", async () => {
    vi.stubEnv("HUMAN_HINDSIGHT_PLAIN", "1");
    const home = tmpHome(sessions(1));
    const claude = fakeCli("claude", ALIASES, (opts) => answer(opts, { preferences: true }));
    const host = fakeHost();
    const io = scripted(
      [
        // s starts the selected plan.
        ["Choose [1/2/s/q]", "s\n"],
        ["What next?", "SIGINT"],
      ],
      host,
    );
    const { code, text } = await run(
      { home },
      {
        runners: [claude],
        input: io.input,
        output: io.output as unknown as Writable,
        host,
      },
    );
    expect(io.remaining).toEqual([]);
    expect(modelCalls(claude, "author")).toBeGreaterThan(0);
    expect(text.match(/Interrupted\./g)).toHaveLength(1);
    expect(code).toBe(130);
  });
});

describe("what distill prints around its plan", () => {
  it("after quick start, the whole-plan command shows the 25 sessions being approved", async () => {
    vi.stubEnv("HUMAN_HINDSIGHT_PLAIN", "1");
    const home = tmpHome(sessions(30));
    const claude = fakeCli("claude", ALIASES);
    // Quick start answered "25 most recent sessions".
    const io = scripted([["Choose [", "1\n"]]);
    let seen: DistillPlan | undefined;
    const code = await runDistill(
      { home },
      {
        runners: [claude],
        input: io.input,
        output: io.output,
        now: FIXED_NOW,
        confirm: async (plan) => {
          seen = plan;
          return "declined";
        },
      },
    );
    expect(code).toBe(2);
    expect(claude.calls).toEqual([]);
    expect(seen?.sessions).toBe(25);
    expect(seen?.fullPlan).toMatch(/ --recent=25 .*--dry-run$/);
  });

  it("no line of dry-run prose is wider than a 60-column terminal", async () => {
    const home = tmpHome(sessions(3));
    const output = fakeOutput({ columns: 60, rows: 40 });
    const code = await runDistill(
      { home, "dry-run": true },
      { runners: [fakeCli("claude", ALIASES)], output, now: FIXED_NOW },
    );
    expect(code).toBe(0);
    const lines = output
      .text()
      .split(/\r?\n/)
      .flatMap((line) => line.split("\r").slice(-1));
    // A single command may be wider: it is alone, indented, and starts with the program name.
    const prose = lines.filter((line) => !/^\s+human-hindsight\s/.test(line));
    expect(prose.filter((line) => line.length > 60)).toEqual([]);
    expect(flat(output.text())).toContain("Run the same command without --dry-run to start.");
  });
});

describe("the readiness check before the first call", () => {
  const checked = (cli: FakeCli) =>
    cli.calls.filter((call) => call.stage === "check").map((call) => call.model);

  it.each([
    {
      name: "--no-group: the grouping model is not checked",
      args: { model: "m", "cluster-model": "grouping-only", group: false },
      env: {},
      models: ["m"],
    },
    {
      name: "grouping on: the grouping model is checked",
      args: { model: "m", "cluster-model": "grouping-only" },
      env: {},
      models: ["m", "grouping-only"],
    },
    {
      name: "--no-generalize: the summary model is not checked",
      args: { generalize: false },
      env: { HUMAN_HINDSIGHT_SUBAGENT_MODEL: "summary-only" },
      models: ["sonnet", "opus"],
    },
    {
      name: "summaries on: the summary model is checked",
      args: {},
      env: { HUMAN_HINDSIGHT_SUBAGENT_MODEL: "summary-only" },
      models: ["sonnet", "opus", "summary-only"],
    },
  ])("$name", async ({ args, env, models }) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const home = tmpHome(sessions(2));
    const cli = fakeCli("claude", ALIASES);
    const { code } = await run({ home, yes: true, ...args }, { runners: [cli] });
    expect(code).toBe(0);
    expect(new Set(checked(cli))).toEqual(new Set(models));
  });
});

describe("the plan screen and the check agree", () => {
  it("--no-group with its own grouping model: the screen counts the one model checked", async () => {
    const home = tmpHome(sessions(2));
    const cli = fakeCli("claude", ALIASES);
    const { text } = await run(
      { home, yes: true, model: "m", "cluster-model": "grouping-only", group: false },
      { runners: [cli] },
    );
    expect(flat(text)).toContain("one tiny request checks that Claude Code is ready");
    expect(cli.calls.filter((call) => call.stage === "check")).toHaveLength(1);
  });
});

describe("the closing summary names prompts whose outcome was not verified", () => {
  it.each([
    [0, undefined],
    [
      1,
      "1 prompt is marked outcome not verified: none of its sessions was seen to reach a result.",
    ],
    [
      3,
      "3 prompts are marked outcome not verified: none of their sessions was seen to reach a result.",
    ],
  ])("%i unverified: %s", (n, line) => {
    expect(unverifiedLine(n)).toBe(line);
  });

  it.each([
    [
      "unclear",
      ["1 prompt is marked outcome not verified: none of its sessions was seen to reach a result."],
      ["skipped"],
    ],
    [
      "abandoned",
      [
        "1 group skipped because every session in it was abandoned.",
        "A prompt is not written for work that was abandoned. Preferences from those sessions are still kept.",
      ],
      ["not verified"],
    ],
    ["completed", ["Library: 1 prompt written."], ["not verified", "skipped"]],
  ])("every session %s", async (outcome, said, unsaid) => {
    const home = tmpHome(sessions(1));
    const cli = fakeCli("claude", ALIASES, (opts) => {
      const value = answer(opts) as Record<string, unknown>;
      return stageOf(opts) === "digest" ? { ...value, outcome } : value;
    });
    const { code, text } = await run({ home, yes: true }, { runners: [cli] });
    expect(code).toBe(0);
    for (const line of said) expect(flat(text)).toContain(line);
    for (const words of unsaid) expect(flat(text)).not.toContain(words);
  });
});
