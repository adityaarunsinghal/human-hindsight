/**
 * The plan screen and the approval question (`src/distill/consent.ts`).
 *
 * Pure rendering is checked against golden files plus a few assertions on
 * meaning; the question is checked as a table of answers. The distill command
 * that builds these plans is covered end to end in `distill-flow.test.ts`.
 */
import { EventEmitter } from "node:events";
import { PassThrough, type Readable, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseMessageCount } from "../src/commands/_shared.js";
import { offerLibraryNext, offerNext } from "../src/commands/next.js";
import {
  askYesNo,
  askYesNoAnswer,
  confirm,
  confirmPlan,
  type DistillPlan,
  renderPlan,
  reportRunInterrupt,
} from "../src/distill/consent.js";
import type { TerminalHost } from "../src/ui/live.js";
import { fakeInput, fakeOutput } from "./support/tty.js";

// --- helpers ---------------------------------------------------------------

/** Captured text is ANSI-stripped: this file pins the disclosure copy, not the color. */
function captureOutput(): { out: Writable; text: () => string } {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { out, text: () => stripVTControlCharacters(chunks.join("")) };
}

function inputWith(line: string): Readable {
  const pt = new PassThrough();
  pt.end(line);
  return pt;
}

/** An input stream that ends immediately with no data (EOF, e.g. `< /dev/null`). */
function eofInput(): Readable {
  const pt = new PassThrough();
  pt.end();
  return pt;
}

/** An input stream that throws if anything ever touches it. */
function forbiddenInput(): Readable {
  return new Proxy({} as Readable, {
    get() {
      throw new Error("stdin was accessed but must not be");
    },
  });
}

/** A stand-in for `process` that receives signals only when a test emits them. */
function fakeHost(): TerminalHost & EventEmitter {
  const host = new EventEmitter() as TerminalHost & EventEmitter;
  Object.assign(host, { pid: 4242, kill: () => true });
  return host;
}

/** Let pending stream callbacks run. No timer is involved. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const strip = (s: string) => stripVTControlCharacters(s);
const golden = (name: string) => `golden/flow/${name}.txt`;
/** Plan labels are internal; the person always sees concrete model names. */
const PLAN_LABEL = /\b(balanced|best)\/(bulk|major)\b/;

beforeEach(() => {
  // Bullets depend on the locale; pin a UTF-8 one so the golden files are stable.
  vi.stubEnv("LC_ALL", "en_US.UTF-8");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// --- renderPlan without a run session (direct callers) -----------------------

describe("renderPlan without a run session", () => {
  it("matches the disclosure block with right-aligned counts (golden)", async () => {
    const out = strip(renderPlan({ digests: 14, cluster: 1, authorEstimate: 5 }));
    await expect(out).toMatchFileSnapshot(golden("plan-basic"));
    expect(out).toContain("14 session reads");
    expect(out).toContain("~5 prompt writing calls");
    expect(out).toMatch(/Approximately 20 calls in total/);
    expect(out).not.toMatch(/oneshot|harness|middle-out/);
  });

  // One promise: the CLI and what it is paid with are named; claude is the default.
  it.each([
    { runnerName: undefined, cli: "`claude` CLI (your subscription/credits)", own: "claude" },
    { runnerName: "kiro", cli: "`kiro-cli` CLI (your Kiro credits)", own: "kiro-cli" },
    {
      runnerName: "opencode",
      cli: "`opencode` CLI (your configured provider account)",
      own: "opencode",
    },
  ] as const)("names the $own CLI and its cost", ({ runnerName, cli, own }) => {
    const out = strip(renderPlan({ digests: 3, cluster: 1, authorEstimate: 1, runnerName }));
    expect(out).toContain(`Reflection will call your local ${cli}:`);
    expect(out).toContain(`through your own ${own} CLI.`);
  });

  it("discloses the estimated window count, merge, and stage-specific models (golden)", async () => {
    const out = strip(
      renderPlan({
        digests: 3000,
        cluster: 61,
        clusterWindowsEstimate: 60,
        clusterMergeEstimate: 1,
        authorEstimate: 1000,
        model: "session-model",
        clusterModel: "grouping-model",
      }),
    );
    await expect(out).toMatchFileSnapshot(golden("plan-windows-and-models"));
    expect(out).toContain("~61 grouping calls");
    expect(out).toContain("estimated 60 batches and 1 merge");
    // Counts carry thousands separators.
    expect(out).toMatch(/Approximately 4,061 calls in total/);
  });

  // One promise: the Models line names the model each stage will use, and only
  // when at least one stage was chosen explicitly.
  it.each([
    {
      name: "only grouping overridden",
      plan: { cluster: 1, clusterModel: "grouping-model" },
      models: "reads and writing: CLI default; grouping: grouping-model",
    },
    {
      name: "writing differs from reads",
      plan: {
        cluster: 1,
        model: "digest-model",
        clusterModel: "grouping-model",
        authorModel: "writing-model",
      },
      models: "reads: digest-model; writing: writing-model; grouping: grouping-model",
    },
    {
      name: "writing equals reads",
      plan: { cluster: 0, model: "same-model", authorModel: "same-model" },
      models: "reads and writing: same-model",
    },
    {
      name: "only writing overridden",
      plan: { cluster: 0, authorModel: "writing-model" },
      models: "reads: CLI default; writing: writing-model",
    },
    { name: "no stage model chosen", plan: { cluster: 1 }, models: undefined },
  ])("names each stage's model ($name)", ({ plan, models }) => {
    const out = strip(renderPlan({ digests: 3, authorEstimate: 1, ...plan }));
    const line = out.split("\n").find((l) => l.startsWith("  Models: "));
    expect(line).toBe(models === undefined ? undefined : `  Models: ${models}.`);
  });

  // One promise: the budget line says what happens to long sessions, and only
  // when the caller supplied a budget.
  it.each([
    {
      name: "oversized and shortened",
      extra: { budget: 1000, truncate: "extreme", oversized: [{ export: "big.md", chars: 5000 }] },
      line: "1 session is longer than the 1,000-character budget and will be shortened to fit.",
    },
    {
      name: "everything fits",
      extra: { budget: 400_000, truncate: "never", oversized: [] },
      line: "Every eligible session fits the 400,000-character budget.",
    },
    { name: "no budget given", extra: {}, line: undefined },
    {
      name: "saved progress note",
      extra: { resumeNote: "9 of 14 sessions already read" },
      line: "9 of 14 sessions already read",
    },
  ] as const)("$name", ({ extra, line }) => {
    const plan = { digests: 3, cluster: 1, authorEstimate: 1, ...extra } as DistillPlan;
    const out = strip(renderPlan(plan));
    const last = out.split("\n").at(-1)?.trim();
    if (line === undefined) expect(last).toMatch(/^Approximately/);
    else expect(last?.endsWith(line)).toBe(true);
  });
});

// One promise: the other plan screens count in plain words, singular for one.
describe("the subagents, consolidation, and retry plan screens", () => {
  const session = sessionPlan().session as NonNullable<DistillPlan["session"]>;
  const op = { runner: "claude", model: "m", timeoutMs: 900_000, budget: 1000, truncate: "never" };
  it.each([
    {
      name: "consolidation of one preference",
      plan: { consolidation: { inputs: 1, models: { balanced: "a", best: "b" } }, session },
      says: ["1 preference, one consolidation call", "a small readiness check"],
    },
    {
      name: "subagents with one reused batch",
      plan: { session, subagents: subagentsPlan({ reused: 1, batches: 2 }) },
      says: [
        "1 call to summarize preferences (1 batch reused from saved work)",
        "1 call to choose roles",
      ],
    },
    {
      name: "a retry of one operation in one session",
      plan: {
        retry: {
          mode: "retry-failed",
          sessions: [session],
          operations: [{ kind: "digest", unitId: "s1", ...op }],
          repairs: [{ kind: "cluster", unitId: "w1" }],
          excluded: [{ kind: "author", unitId: "t1", reason: "edited by hand" }],
          blocked: [],
        },
      },
      says: [
        "1 saved call to make again; 1 result to finish from saved answers, with no call.",
        "Before the first call, a tiny request checks that the CLI is ready.",
        "Left out: 1 saved call.",
      ],
    },
    {
      name: "a retry of two operations in two sessions",
      plan: {
        retry: {
          mode: "recover-tasks",
          sessions: [session, session],
          operations: [
            { kind: "author", unitId: "t1", ...op },
            { kind: "author", unitId: "t2", ...op },
          ],
          repairs: [],
          excluded: [],
          blocked: [],
        },
      },
      says: ["Recovery plan", "2 saved calls to make again.", "2 tiny requests check"],
    },
  ] as const)("$name", ({ plan, says }) => {
    const out = strip(
      renderPlan({ digests: 0, cluster: 0, authorEstimate: 0, ...plan } as DistillPlan),
    ).replace(/\s+/g, " ");
    for (const phrase of says) expect(out).toContain(phrase);
    expect(out).not.toMatch(
      /\w\(s\)|readiness call|oneshot|middle-out|local repair|\b0 \w|truncate=/i,
    );
  });
});

// --- the distill plan screen -------------------------------------------------

/** A suggest-subagents plan: three accepted preferences, two plans that differ. */
function subagentsPlan(
  over: { batches?: number; reused?: number } & Partial<NonNullable<DistillPlan["subagents"]>> = {},
): NonNullable<DistillPlan["subagents"]> {
  const { batches = 1, reused = 0, ...rest } = over;
  return {
    inputs: 3,
    accepted: 3,
    selection: "accepted",
    minRoles: 2,
    maxRoles: 15,
    choices: {
      balanced: {
        summarize: "fast-model",
        choose: "strong-model",
        write: "strong-model",
        batches,
        reused,
      },
      best: { summarize: "strong-model", choose: "top-model", write: "top-model", batches, reused },
    },
    ...rest,
  };
}

/** A plan in the shape distill builds from a run session. */
function sessionPlan(over: Partial<DistillPlan> = {}): DistillPlan {
  return {
    sessions: 5,
    digests: 5,
    cluster: 4,
    clusterWindowsEstimate: 3,
    clusterMergeEstimate: 1,
    authorEstimate: 2,
    runnerName: "claude",
    session: {
      runnerLine: "Claude Code (claude 9.9.9)",
      alsoReady: ["Codex"],
      pinned: false,
      qualityChoice: true,
      plans: {
        balanced: { bulk: "fast-model", major: "strong-model", notes: [] },
        best: { bulk: "strong-model", major: "top-model", notes: [] },
      },
    },
    quality: "balanced",
    concurrency: 10,
    generalize: true,
    choices: {
      balanced: {
        digest: "fast-model",
        cluster: "strong-model",
        author: "strong-model",
        generalize: "fast-model",
        reusable: 0,
        regenerating: 0,
      },
      best: {
        digest: "strong-model",
        cluster: "top-model",
        author: "top-model",
        generalize: "strong-model",
        reusable: 0,
        regenerating: 0,
      },
    },
    ...over,
  };
}

describe("the distill plan screen", () => {
  it("wraps to the terminal width with a hanging indent and shows the window estimate (60 columns, golden)", async () => {
    const out = strip(renderPlan(sessionPlan(), { width: 60 }));
    await expect(out).toMatchFileSnapshot(golden("distill-plan-windows"));
    for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(60);
    // The same words as at 80 columns, only wrapped differently.
    const words = (text: string) => text.split(/\s+/).filter(Boolean);
    expect(words(out)).toEqual(words(strip(renderPlan(sessionPlan(), { width: 80 }))));
  });

  it("reads in the designed order and never names a plan label or a time estimate", () => {
    const out = strip(renderPlan(sessionPlan())).replace(/\s+/g, " ");
    const order = ["Reads", "Runs on", "Also ready", "Calls", "at a time", "Models", "Sending"];
    const positions = order.map((word) => out.indexOf(word));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(out).not.toMatch(PLAN_LABEL);
    expect(out).not.toMatch(/\b(minutes?|hours?|seconds?)\b|readiness call|harness|oneshot/i);
    expect(out).toContain(
      "1 Balanced (selected): fast-model for session reads, strong-model for grouping and writing",
    );
    expect(out).toContain(
      "2 Best: strong-model for session reads, top-model for grouping and writing",
    );
  });

  // Counts read as words: singular for one, thousands separators above 999.
  it.each([
    {
      over: {
        sessions: 1,
        digests: 1,
        cluster: 1,
        authorEstimate: 1,
        clusterWindowsEstimate: 1,
        clusterMergeEstimate: 0,
      },
      has: [
        "1 session, about 1 prompt",
        "1 session read",
        "about 1 grouping call",
        "about 1 writing call",
      ],
    },
    {
      over: { sessions: 2400, digests: 2400, cluster: 0, authorEstimate: 2400, concurrency: 1000 },
      has: [
        "2,400 sessions",
        "2,400 session reads",
        "no grouping",
        "2,400 writing calls",
        "Up to 1,000 at a time",
      ],
    },
  ])("counts read as words ($has.0)", ({ over, has }) => {
    const out = strip(renderPlan(sessionPlan(over as Partial<DistillPlan>)).replace(/\s+/g, " "));
    for (const phrase of has) expect(out).toContain(phrase);
  });

  // The two reuse counts are both shown whenever they differ, so the number on
  // screen is right whichever plan is picked.
  it("shows each plan's own reuse and regeneration when they differ", () => {
    const plan = sessionPlan({ library: 4 });
    if (!plan.choices) throw new Error("choices expected");
    plan.choices.balanced = { ...plan.choices.balanced, reusable: 3, regenerating: 0 };
    plan.choices.best = { ...plan.choices.best, reusable: 0, regenerating: 3 };
    const out = strip(renderPlan(plan)).replace(/\s+/g, " ");
    expect(out).toContain(
      "Balanced (selected): fast-model for session reads, strong-model for grouping and writing. 2 new session reads, 3 reused.",
    );
    expect(out).toContain(
      "Best: strong-model for session reads, top-model for grouping and writing. 5 new session reads, 3 earlier results regenerated.",
    );
    expect(out).toContain("4 saved prompts. Hand-edited prompts, ratings, and reviews are kept.");
  });

  it.each([
    {
      name: "a fresh library",
      balanced: { reusable: 0, regenerating: 0 },
      best: { reusable: 0, regenerating: 0 },
      has: ["Calls 5 session reads,"],
    },
    {
      name: "every read reused by the selected plan",
      balanced: { reusable: 5, regenerating: 0 },
      best: { reusable: 0, regenerating: 5 },
      has: ["grouping and writing. 5 session reads reused.", "5 new session reads, 5 earlier"],
    },
    {
      name: "every read reused by both plans",
      balanced: { reusable: 5, regenerating: 0 },
      best: { reusable: 5, regenerating: 0 },
      has: ["Calls no new session reads (5 reused from saved work),"],
    },
  ])("prints a reuse or regeneration count only when it is not zero ($name)", ({
    balanced,
    best,
    has,
  }) => {
    const plan = sessionPlan();
    if (!plan.choices) throw new Error("choices expected");
    plan.choices.balanced = { ...plan.choices.balanced, ...balanced };
    plan.choices.best = { ...plan.choices.best, ...best };
    const out = strip(renderPlan(plan)).replace(/\s+/g, " ");
    for (const phrase of has) expect(out).toContain(phrase);
    expect(out).not.toMatch(/\b0 (new )?session reads?\b|\b0 reused|\b0 earlier result/);
  });

  it.each([
    { name: "no CLI limit", limit: undefined, concurrency: 10, says: "Up to 10 at a time." },
    {
      name: "a CLI that takes fewer",
      limit: 2,
      concurrency: 10,
      says: "Up to 2 at a time (Claude Code's limit).",
    },
    { name: "a limit above the stage's", limit: 4, concurrency: 3, says: "Up to 3 at a time." },
  ])("the pace line shows the real number at once ($name)", ({ limit, concurrency, says }) => {
    const base = sessionPlan();
    const session = { ...(base.session as NonNullable<DistillPlan["session"]>) };
    if (limit !== undefined) session.maxConcurrency = limit;
    const out = strip(renderPlan(sessionPlan({ session, concurrency }))).replace(/\s+/g, " ");
    expect(out).toContain(says);
  });

  it.each([
    {
      name: "two models in every plan",
      balanced: { digest: "fast-model", cluster: "strong-model" },
      best: { digest: "strong-model", cluster: "top-model" },
      says: "two tiny requests, one for each model, check that Claude Code is ready",
    },
    {
      name: "one model in every plan",
      balanced: { digest: "m", cluster: "m", author: "m", generalize: "m" },
      best: { digest: "o", cluster: "o", author: "o", generalize: "o" },
      says: "one tiny request checks that Claude Code is ready",
    },
    {
      name: "one plan with one model, the other with two",
      balanced: { digest: "m", cluster: "m", author: "m", generalize: "m" },
      best: { digest: "strong-model", cluster: "top-model" },
      says: "one tiny request for each model checks that Claude Code is ready",
    },
    {
      name: "--author-model beside the plan's two",
      balanced: { author: "pinned-writer" },
      best: { author: "pinned-writer" },
      says: "three tiny requests, one for each model, check that Claude Code is ready",
    },
    {
      name: "--no-group: the grouping model is not called, so not checked",
      balanced: { digest: "m", cluster: "grouping-only", author: "m", generalize: "m" },
      best: { digest: "o", cluster: "grouping-only", author: "o", generalize: "o" },
      over: { grouping: false },
      says: "one tiny request checks that Claude Code is ready",
    },
    {
      name: "--no-generalize: the summary model is not called, so not checked",
      balanced: { digest: "m", cluster: "m", author: "m", generalize: "summary-only" },
      best: { digest: "o", cluster: "o", author: "o", generalize: "summary-only" },
      over: { generalize: false },
      says: "one tiny request checks that Claude Code is ready",
    },
  ])("says how many readiness requests there are ($name)", ({ balanced, best, says, ...rest }) => {
    const plan = sessionPlan((rest as { over?: Partial<DistillPlan> }).over);
    if (!plan.choices) throw new Error("choices expected");
    plan.choices.balanced = { ...plan.choices.balanced, ...balanced };
    plan.choices.best = { ...plan.choices.best, ...best };
    expect(strip(renderPlan(plan)).replace(/\s+/g, " ")).toContain(says);
  });

  it("a pinned one-model run with no choice: one tiny request", () => {
    const one = {
      digest: "m",
      cluster: "m",
      author: "m",
      generalize: "m",
      reusable: 0,
      regenerating: 0,
    };
    const plan = sessionPlan({ qualityFixed: true, choices: { balanced: one, best: one } });
    expect(strip(renderPlan(plan)).replace(/\s+/g, " ")).toContain(
      "one tiny request checks that Claude Code is ready",
    );
  });

  it("offers no choice and prints the CLI's note once when the models are the same", () => {
    const note = "This CLI did not list its models, so every step uses its own default model";
    const same = { bulk: "CLI default", major: "CLI default", notes: [note] };
    const base = sessionPlan();
    const plan = sessionPlan({
      session: {
        ...(base.session as NonNullable<DistillPlan["session"]>),
        qualityChoice: false,
        plans: { balanced: same, best: same },
      },
      choices: Object.fromEntries(
        (["balanced", "best"] as const).map((q) => [
          q,
          {
            digest: "CLI default",
            cluster: "CLI default",
            author: "CLI default",
            generalize: "CLI default",
            reusable: 0,
            regenerating: 0,
            notes: [note],
          },
        ]),
      ) as DistillPlan["choices"],
    });
    const out = strip(renderPlan(plan)).replace(/\s+/g, " ");
    expect(out).not.toMatch(/Balanced|Best/);
    expect(out.split(note).length - 1).toBe(1);
  });
});

// --- the approval question ------------------------------------------------------

const PLAN: DistillPlan = { digests: 14, cluster: 1, authorEstimate: 5 };

// --- the subagent plan screen ----------------------------------------------

/** A distill-shaped plan carrying a subagent plan. */
function subagentScreen(sub = subagentsPlan(), over: Partial<DistillPlan> = {}): DistillPlan {
  return { ...sessionPlan(), subagents: sub, ...over };
}

/** Words a first-time reader should never meet on a plan screen. */
const JARGON =
  /generalize|propose|invocation|window|input budget|lesson|playbook|corrective|consent plan|digest|\(s\)|\bRunner {2}/i;

describe("the subagent plan screen", () => {
  it.each([
    { name: "accepted preferences", sub: subagentsPlan() },
    {
      name: "nothing accepted yet, one batch reused",
      sub: subagentsPlan({ accepted: 0, selection: "all-candidates", batches: 2, reused: 1 }),
    },
    {
      name: "every candidate by request",
      sub: subagentsPlan({ accepted: 1, selection: "all-candidates", includeUnreviewed: true }),
    },
    { name: "accepted ones narrow the set", sub: subagentsPlan({ candidates: 14 }) },
    {
      name: "only role prompts",
      sub: subagentsPlan({
        minRoles: 1,
        maxRoles: 1,
        authorOnly: { names: ["test-runner"], roles: 2 },
      }),
    },
  ])("$name: the distill layout, plain words, no zero counts (golden)", async ({ name, sub }) => {
    const out = strip(renderPlan(subagentScreen(sub)));
    await expect(out).toMatchFileSnapshot(
      `golden/suggest-subagents/screen-${name.replaceAll(/[^a-z]+/g, "-")}.txt`,
    );
    const flat = out.replace(/\s+/g, " ");
    // The same rows, in the same order, as the distill screen.
    const order = ["Subagent plan", "Reads", "Runs on", "Calls", "Models", "Sending"];
    const positions = order.map((word) => flat.indexOf(word));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(flat).not.toMatch(JARGON);
    expect(flat).not.toMatch(/\b0 \w|Approximately|Timeout|Quality/);
    for (const width of [80, 60])
      for (const line of strip(renderPlan(subagentScreen(sub), { width })).split("\n"))
        expect(line.length).toBeLessThanOrEqual(width);
  });

  it("names the models of both plans by their real names, as the distill screen does", () => {
    const flat = strip(renderPlan(subagentScreen())).replace(/\s+/g, " ");
    expect(flat).toContain(
      "1 Balanced (selected): fast-model for preference summaries, strong-model for choosing and writing roles",
    );
    expect(flat).toContain("2 Best: strong-model for preference summaries, top-model for choosing");
    // Two models are checked, so the check is two tiny requests.
    expect(flat).toContain(
      "two tiny requests, one for each model, check that Claude Code is ready",
    );
  });

  it.each([
    [
      "three models: summary, choosing, writing",
      { summarize: "a", choose: "b", write: "c" },
      {},
      "three tiny requests, one for each model",
    ],
    [
      "summaries reused: only choosing and writing are called",
      { summarize: "summary-only", choose: "b", write: "b", batches: 3, reused: 3 },
      {},
      "one tiny request checks",
    ],
    [
      "--author-only: only writing is called",
      { summarize: "a", choose: "b", write: "c" },
      { authorOnly: { names: ["reviewer"], roles: 2 } },
      "one tiny request checks",
    ],
  ])("a subagent plan counts the models it will call (%s)", (_name, models, extra, says) => {
    const base = subagentsPlan();
    const choice = { ...base.choices.balanced, ...models };
    const sub = { ...base, ...extra, choices: { balanced: choice, best: choice } };
    const flat = strip(renderPlan(subagentScreen(sub, { qualityFixed: true }))).replace(
      /\s+/g,
      " ",
    );
    expect(flat).toContain(says);
  });

  it("shares the distill screen's layout: the same label column and wrapping", () => {
    const rows = (text: string) =>
      strip(text)
        .split("\n")
        .filter(
          (line) =>
            /^ {2}\S/.test(line) &&
            !line.includes(" plan") &&
            !line.includes("Reflect on your history"),
        )
        .map((line) => line.slice(0, 11));
    const labels = ["Reads    ", "Runs on  ", "Calls    ", "Models   ", "Sending  "].map(
      (label) => `  ${label}`,
    );
    for (const screen of [renderPlan(sessionPlan()), renderPlan(subagentScreen())])
      expect(rows(screen)).toEqual(labels);
  });

  it("says per plan what it summarizes when only one plan has saved batches", () => {
    const sub = subagentsPlan();
    sub.choices.balanced = { ...sub.choices.balanced, reused: 1 };
    const flat = strip(renderPlan(subagentScreen(sub))).replace(/\s+/g, " ");
    expect(flat).toContain("preference summary calls as listed under each plan below");
    expect(flat).toContain("Summaries reused from saved work.");
    expect(flat).toContain("1 summary call.");
  });
});

describe("the short form for a short terminal", () => {
  it.each([
    { name: "distill", plan: sessionPlan({ fullPlan: "npx human-hindsight reflect --dry-run" }) },
    {
      name: "subagents",
      plan: subagentScreen(subagentsPlan(), {
        fullPlan: "human-hindsight suggest-subagents --dry-run",
      }),
    },
  ])("$name: fits 12 rows with the question, and says how to see the whole plan", ({ plan }) => {
    const out = strip(renderPlan(plan, { width: 80, height: 12 }));
    const lines = out.split("\n");
    // The question takes six more rows; the first line stays on screen.
    expect(lines.length + 6).toBeLessThanOrEqual(12);
    expect(lines.at(-2)).toBe("  To see the whole plan first, run:");
    expect(lines.at(-1)?.trim()).toBe(plan.fullPlan);
    // A tall terminal gets the whole plan.
    expect(strip(renderPlan(plan, { width: 80, height: 50 }))).toContain("Sending");
  });
});

describe("the Start question on a terminal", () => {
  /** Press the keys one read at a time once the question is drawn; leave with q if still open. */
  async function answerWith(keys: string[], plan = sessionPlan()) {
    vi.stubEnv("CI", "");
    vi.stubEnv("TERM", "xterm-256color");
    vi.stubEnv("HUMAN_HINDSIGHT_PLAIN", "");
    const host = fakeHost();
    const input = fakeInput();
    const output = fakeOutput({ columns: 80, rows: 50 });
    const chosen: string[] = [];
    let answered = false;
    const pending = confirmPlan(plan, {
      input,
      output,
      host,
      onQuality: (quality) => chosen.push(quality),
    }).finally(() => {
      answered = true;
    });
    await flush();
    for (const key of keys) {
      if (key === "SIGINT") host.emit("SIGINT");
      else input.push(key);
      await flush();
    }
    const stillOpen = !answered;
    if (stillOpen) input.push("q");
    return { answer: await pending, chosen, text: output.text(), stillOpen };
  }

  it.each([
    { keys: ["s"], answer: "proceed", chosen: ["balanced"] },
    { keys: ["2", "s"], answer: "proceed", chosen: ["best"] },
    { keys: ["2", "1", "s"], answer: "proceed", chosen: ["balanced"] },
    { keys: ["q"], answer: "declined", chosen: [] },
    { keys: ["\u001b"], answer: "declined", chosen: [] },
    { keys: ["\u0004"], answer: "declined", chosen: [] },
    { keys: ["SIGINT"], answer: "interrupted", chosen: [] },
    { keys: ["\u0003"], answer: "interrupted", chosen: [] },
  ])("keys $keys: $answer", async ({ keys, answer, chosen }) => {
    const result = await answerWith(keys);
    expect(result.stillOpen).toBe(false);
    expect(result.answer).toBe(answer);
    expect(result.chosen).toEqual(chosen);
    // The plans, the selected one marked, and the start line naming it.
    const text = strip(result.text);
    expect(text).toContain("1 Balanced (selected)");
    expect(text).toContain("s  Start with Balanced");
    expect(text).toContain("q  Not now");
    if (keys[0] === "2") expect(text).toContain("s  Start with Best");
    // Ctrl-C: one line, and nothing else.
    if (answer === "interrupted") expect(text.split("Interrupted.").length - 1).toBe(1);
  });

  it.each([
    ["Enter", ["\r"]],
    ["space", [" "]],
    ["an arrow, then Enter", ["\u001b[B", "\r"]],
    ["1 or 2 alone", ["1", "2"]],
    ["y", ["y"]],
  ])("%s never starts; another key says once how to start", async (_name, keys) => {
    const result = await answerWith(keys);
    expect(result.stillOpen).toBe(true);
    expect(result.answer).toBe("declined");
    expect(result.chosen).toEqual([]);
    const said = strip(result.text).split("Press s to start, or q to leave.").length - 1;
    expect(said).toBe(keys.every((key) => /^[12]$/.test(key)) ? 0 : 1);
  });

  it("the subagent screen asks the same question", async () => {
    const result = await answerWith(["2", "s"], subagentScreen());
    expect(result.answer).toBe("proceed");
    expect(result.chosen).toEqual(["best"]);
    expect(strip(result.text)).toContain("s  Start with Best");
  });

  it("a plan without a choice starts with s alone", async () => {
    const result = await answerWith(["1", "s"], sessionPlan({ qualityFixed: true }));
    expect(result.answer).toBe("proceed");
    expect(result.chosen).toEqual([]);
    const text = strip(result.text);
    expect(text).toContain("s  Start");
    expect(text).not.toMatch(/Start with|2 {2}Best/);
  });
});

describe("the approval question", () => {
  it.each([
    { name: "dry-run", opts: { dryRun: true }, result: "dry-run" },
    { name: "--yes", opts: { yes: true }, result: "proceed" },
  ])("$name prints the plan and never touches stdin", async ({ opts, result }) => {
    const cap = captureOutput();
    expect(await confirm(PLAN, { ...opts, input: forbiddenInput(), output: cap.out })).toBe(result);
    expect(cap.text()).toMatch(/Approximately 20 calls in total/);
  });

  // In lines, the same letters: a line that is exactly s starts; anything else
  // is the hint and the question again; the end of input declines. An answer
  // typed without a trailing newline still counts.
  it.each([
    { input: "s\n", result: "proceed" },
    { input: "s", result: "proceed" },
    { input: "  s  ", result: "proceed" },
    { input: "y\ns\n", result: "proceed" },
    { input: "y\n", result: "declined" },
    { input: "yes\n", result: "declined" },
    { input: "Y", result: "declined" },
    { input: "n\n", result: "declined" },
    { input: "q\ns\n", result: "declined" },
    { input: "maybe", result: "declined" },
    { input: "\n", result: "declined" },
    { input: "", result: "declined" },
  ])("answer %j is $result", async ({ input, result }) => {
    const cap = captureOutput();
    const stream = input ? inputWith(input) : eofInput();
    expect(await confirm(PLAN, { input: stream, output: cap.out })).toBe(result);
    if (/^[yYnm\n]/.test(input) && result === "declined")
      expect(cap.text()).toContain("Press s to start, or q to leave.");
  });

  // With a choice offered: 1 and 2 select a plan and ask again; s starts the
  // selected one; an empty line or the end of input declines.
  it.each([
    { input: "s\n", result: "proceed", picked: "balanced" },
    { input: "1\ns\n", result: "proceed", picked: "balanced" },
    { input: "2\ns\n", result: "proceed", picked: "best" },
    { input: "2\n", result: "declined", picked: undefined },
    { input: "best\n", result: "declined", picked: undefined },
    { input: "y\n", result: "declined", picked: undefined },
    { input: "\n", result: "declined", picked: undefined },
    { input: "", result: "declined", picked: undefined },
  ])("with a choice, answer %j is $result", async ({ input, result, picked }) => {
    const cap = captureOutput();
    const chosen: string[] = [];
    const answer = await confirmPlan(sessionPlan(), {
      input: input ? inputWith(input) : eofInput(),
      output: cap.out,
      onQuality: (q) => chosen.push(q),
    });
    expect(answer).toBe(result);
    expect(chosen).toEqual(picked ? [picked] : []);
    expect(cap.text()).toContain("Choose [1/2/s/q]");
    if (input.startsWith("2"))
      expect(cap.text()).toContain("Best is selected. Press s to start with Best, or q to leave.");
  });

  it("asks only s or q when there is no choice to make", async () => {
    const cap = captureOutput();
    const chosen: string[] = [];
    const answer = await confirmPlan(sessionPlan({ qualityFixed: true }), {
      input: inputWith("2\n"),
      output: cap.out,
      onQuality: (q) => chosen.push(q),
    });
    expect(answer).toBe("declined");
    expect(chosen).toEqual([]);
    expect(cap.text()).toContain("Choose [s/q]");
    expect(cap.text()).not.toContain("2 Best");
  });

  it("declines at once with no terminal and no input stream", async () => {
    const out = fakeOutput({ isTTY: false });
    expect(await confirm(PLAN, { output: out })).toBe("declined");
  });

  it("Ctrl-C at the question is an interrupt, which older callers read as a decline", async () => {
    vi.stubEnv("CI", "");
    vi.stubEnv("HUMAN_HINDSIGHT_PLAIN", "1");
    for (const [ask, expected] of [
      [confirmPlan, "interrupted"],
      [confirm, "declined"],
    ] as const) {
      const host = fakeHost();
      const input = fakeInput();
      const output = fakeOutput();
      const pending = ask(PLAN, { input, output, host });
      await flush();
      expect(output.text()).toContain("Choose [s/q]");
      host.emit("SIGINT");
      expect(await pending).toBe(expected);
      expect(host.listenerCount("SIGINT")).toBe(0);
    }
  });
});

describe("askYesNo", () => {
  // Input rule: an empty line takes the default; end of input (Ctrl-D or a
  // closed stream) declines, whatever the default is; an explicit answer wins.
  it.each([
    { input: "\n", defaultYes: true, expected: true },
    { input: "\n", defaultYes: false, expected: false },
    { input: "", defaultYes: true, expected: false },
    { input: "", defaultYes: false, expected: false },
    { input: "y", defaultYes: false, expected: true },
    { input: "n", defaultYes: true, expected: false },
  ])("%j answers $expected", async ({ input, defaultYes, expected }) => {
    const cap = captureOutput();
    const answer = await askYesNo("Show your library now?", {
      input: input ? inputWith(input) : eofInput(),
      output: cap.out,
      defaultYes,
    });
    expect(answer).toBe(expected);
    expect(cap.text()).toContain(defaultYes ? "[Y/n]" : "[y/N]");
  });

  it("tells an interrupt apart from a no", async () => {
    vi.stubEnv("CI", "");
    vi.stubEnv("HUMAN_HINDSIGHT_PLAIN", "1");
    const host = fakeHost();
    const output = fakeOutput();
    const pending = askYesNoAnswer("Continue?", { input: fakeInput(), output, host });
    await flush();
    expect(output.text()).toContain("Continue? [y/N]");
    host.emit("SIGINT");
    expect(await pending).toBe("interrupt");
  });
});

describe("reportRunInterrupt", () => {
  it("says what the step saved, puts the command alone on its own line, then exits 130", async () => {
    const host = fakeHost();
    const out = fakeOutput({ isTTY: false });
    const order: string[] = [];
    const exited = new Promise<number>((resolve) => {
      reportRunInterrupt(
        out,
        "human-hindsight preferences --consolidate --home=/a/rather/long/data/home",
        {
          host,
          saved: () => "Nothing was saved.",
          mute: () => order.push("mute"),
          exit: resolve,
        },
      );
    });
    host.emit("SIGINT");
    expect(await exited).toBe(130);
    expect(out.text().trimEnd().split("\n")).toEqual([
      "Interrupted. Nothing was saved. To continue, run:",
      "  human-hindsight preferences --consolidate --home=/a/rather/long/data/home",
    ]);
    // The stopping run is silenced only after its line is out.
    expect(order).toEqual(["mute"]);
  });

  it("prints one line, runs the cleanup, exits 130, and can be switched off", async () => {
    const host = fakeHost();
    const cap = captureOutput();
    const events: string[] = [];
    const exited = new Promise<number>((resolve) => {
      const stop = reportRunInterrupt(cap.out, "npx human-hindsight reflect --home=/h", {
        host,
        exit: (code) => {
          events.push("exit");
          resolve(code);
        },
        onInterrupt: () => events.push("cleanup"),
      });
      expect(host.listenerCount("SIGINT")).toBe(1);
      host.emit("SIGINT");
      stop();
    });
    expect(await exited).toBe(130);
    expect(events).toEqual(["cleanup", "exit"]);
    expect(cap.text().trim().split("\n")).toEqual([
      "Interrupted. Finished work is saved and reused. To continue, run:",
      "  npx human-hindsight reflect --home=/h",
    ]);
    expect(host.listenerCount("SIGINT")).toBe(0);
  });
});

// --- follow-up offers -------------------------------------------------------

describe("follow-up offers never read stdin under --yes or --dry-run", () => {
  it.each([{ yes: true }, { "dry-run": true }])("offerNext with %j", async (flags) => {
    const cap = captureOutput();
    const ran = await offerNext(
      "gui",
      { home: "/tmp/h", ...flags },
      { input: forbiddenInput(), output: cap.out },
    );
    expect(ran).toBe(false);
    expect(cap.text()).toContain("human-hindsight gui --home=/tmp/h");
  });

  it.each([{ yes: true }, { "dry-run": true }])("offerLibraryNext with %j", async (flags) => {
    const cap = captureOutput();
    await offerLibraryNext(
      { home: "/tmp/h", ...flags },
      { input: forbiddenInput(), output: cap.out },
    );
    expect(cap.text()).toContain("human-hindsight gui --home=/tmp/h");
    expect(cap.text()).toContain("human-hindsight suggest-subagents --home=/tmp/h --dry-run");
  });
});

describe("parseMessageCount (shared --min-messages and --min-substance parser)", () => {
  it.each([
    { raw: undefined, fallback: 1, expected: 1 },
    { raw: "3", fallback: 1, expected: 3 },
    { raw: "0", fallback: 1, expected: 1 },
    { raw: undefined, fallback: 2, expected: 2 },
    { raw: "0", fallback: 2, expected: 1 },
    { raw: "5", fallback: 2, expected: 5 },
  ])("$raw with fallback $fallback is $expected", ({ raw, fallback, expected }) => {
    expect(parseMessageCount("min-substance", raw, fallback)).toBe(expected);
  });

  it.each(["abc", "-1", "2.5", ""])("%j is an error naming the value, never the default", (raw) => {
    expect(() => parseMessageCount("min-messages", raw, 2)).toThrow(
      `--min-messages takes a whole number of messages, 0 or more, not ${JSON.stringify(raw)}.`,
    );
  });
});
