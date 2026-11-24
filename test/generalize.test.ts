/**
 * The working agreements stage (`src/distill/generalize.ts`) and its saved
 * artifact (`src/core/generalized.ts`): concurrency, checkpoints, lesson ids,
 * staleness, damage, and model provenance. Every runner here is an in-process
 * fake; nothing spawns a process.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { GENERALIZED_PATH, inspectGeneralized } from "../src/core/generalized.js";
import { isPlanLabel } from "../src/core/model-plan.js";
import { savePreferenceReview } from "../src/core/preference-review.js";
import { readObservedPreferences } from "../src/core/preferences.js";
import {
  planGeneralize,
  readGeneralizeCheckpoints,
  runGeneralizeStage,
} from "../src/distill/generalize.js";
import type { RunnerFn } from "../src/distill/pipeline.js";
import { LiveBatches } from "../src/gui/live-batches.js";
import type { ResolvedCall } from "../src/runners/types.js";
import { guiHarness, request } from "./gui-harness.js";

const NOW = new Date("2026-11-21T12:00:00.000Z");
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Pref {
  text: string;
  scope?: "global" | "project" | "task";
  project?: string;
}

/** Synthetic preference texts; sorted order is the window order with one input per window. */
const PREFS: Pref[] = [
  { text: "Alpha: keep each change small and explain it in plain words." },
  { text: "Bravo: run the existing tests before reporting a change as done." },
  { text: "Charlie: name the command that reproduces a result." },
  {
    text: "Delta: in the billing service, prefer the shared retry helper.",
    scope: "project",
    project: "harbor-ledger",
  },
];

/** A data home with legacy library entries (one preference each) and an export manifest. */
/** The manifest also names a project no preference was seen in. */
function agreementsHome(
  prefs: Pref[] = PREFS,
  manifestProjects = ["harbor-ledger", "spare-project"],
): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hh-generalize-"));
  tmpDirs.push(home);
  for (const [index, pref] of prefs.entries()) {
    const slug = `task-p${index + 1}`;
    const dir = path.join(home, "library", slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "sources.json"),
      JSON.stringify({
        slug,
        title: slug,
        members: [`p${index + 1}.md`],
        sessionIds: [`p${index + 1}`],
        preferences: [
          {
            text: pref.text,
            evidence: `quoted evidence ${index + 1}`,
            scope: pref.scope ?? "global",
            ...(pref.project ? { project: pref.project } : {}),
          },
        ],
        outcome_summary: "1 completed",
        domains: [],
        confidence: "high",
        authored_at: `2026-11-0${index + 1}T00:00:00.000Z`,
        model: null,
        prompt_version: 1,
        tool_version: "1.9.0",
        generation: "g1",
      }),
    );
  }
  setManifest(home, manifestProjects);
  return home;
}

function setManifest(home: string, projects: string[]): void {
  fs.mkdirSync(path.join(home, "exports"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "exports", "manifest.json"),
    JSON.stringify(projects.map((project, i) => ({ export: `x${i}.md`, project, messages: 3 }))),
  );
}

function review(home: string, startsWith: string, status: "accepted" | "dismissed"): void {
  const pref = readObservedPreferences(home).find((p) => p.text.startsWith(startsWith));
  if (!pref) throw new Error(`no preference starting with ${startsWith}`);
  savePreferenceReview(home, pref, { status });
}

function sink(): Writable {
  return new Writable({ write: (_chunk, _encoding, done) => done() });
}

function inputsOf(prompt: string): { id: string; text: string; scope: string }[] {
  const from = prompt.indexOf("=== INPUTS (");
  const to = prompt.indexOf("=== END INPUTS ===");
  return prompt
    .slice(prompt.indexOf("\n", from) + 1, to)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * A cooperative generalize fake. Every lesson gets the same title, so lesson ids
 * carry a numeric suffix that depends on window order. `gate` lets a test hold a
 * call (by the first letter of its input text) and settle it later.
 */
function fakeGeneralize(
  opts: {
    resolved?: ResolvedCall;
    gate?: (letter: string) => Promise<void> | undefined;
    failing?: Set<string>;
  } = {},
) {
  const calls: string[] = [];
  const runner = (async (call: {
    prompt: string;
    model?: string;
    onResolved?: (r: ResolvedCall) => void;
  }) => {
    const inputs = inputsOf(call.prompt);
    const letter = inputs[0]?.text[0] ?? "?";
    calls.push(letter);
    await opts.gate?.(letter);
    if (opts.failing?.has(letter)) throw new Error(`synthetic failure for window ${letter}`);
    call.onResolved?.(opts.resolved ?? { runner: "claude", model: "synthetic-model-1" });
    return {
      lessons: inputs.map((input) => ({
        title: "Shared working agreement",
        instruction: `${input.text} Apply it consistently and say when it does not fit.`,
        applies_when: "Whenever it applies.",
        exceptions: "",
        disposition: input.scope === "global" ? "generalized" : "contextual",
        source_ids: [input.id],
      })),
      set_aside: [],
    };
  }) as unknown as RunnerFn;
  return { runner, calls };
}

/** A promise a test settles by hand, so call completion order is explicit. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function generalize(
  home: string,
  runner: RunnerFn,
  extra: { concurrency?: number; model?: string; windowSize?: number } = {},
) {
  const plan = planGeneralize({
    home,
    budget: 400_000,
    windowSize: extra.windowSize ?? 1,
    model: extra.model,
    selection: "all-candidates",
  });
  if (!plan) throw new Error("expected a plan");
  const result = await runGeneralizeStage({
    home,
    plan,
    runner,
    model: extra.model,
    concurrency: extra.concurrency ?? 10,
    output: sink(),
    now: () => NOW,
  });
  return { plan, result };
}

describe("default preference batches", () => {
  it.each([
    [94, [94]],
    [205, [100, 100, 5]],
  ] as const)("summarizes %i signals", async (count, sizes) => {
    const home = agreementsHome(
      Array.from({ length: count }, (_, i) => ({
        text: `Working preference ${i}: document the outcome.`,
      })),
    );
    const plan = planGeneralize({ home, budget: 400_000 });
    if (!plan) throw new Error("expected a plan");
    expect(plan.windows.map((window) => window.length)).toEqual(sizes);
    const fake = fakeGeneralize();
    const result = await runGeneralizeStage({ home, plan, runner: fake.runner, output: sink() });
    expect(result.status).toBe("done");
    expect(fake.calls).toHaveLength(sizes.length);
    expect(result.lessonList.flatMap((lesson) => lesson.source_ids).sort()).toEqual(
      plan.inputs.map((input) => input.id).sort(),
    );
    expect(planGeneralize({ home, budget: 400_000 })?.reusable).toBe(sizes.length);
  });

  it("packs across interleaved checkpoints and reuses the exact completed work on retry", async () => {
    const home = agreementsHome(
      Array.from({ length: 160 }, (_, i) => ({
        text: `${String.fromCharCode(65 + Math.floor(i / 20))} preference ${String(i).padStart(3, "0")}: document the outcome.`,
      })),
    );
    const legacy = fakeGeneralize({ failing: new Set(["A", "C", "E", "F", "G", "H"]) });
    await generalize(home, legacy.runner, { windowSize: 20, concurrency: 8 });
    const plan = planGeneralize({ home, budget: 400_000 });
    if (!plan) throw new Error("expected a plan");
    expect(
      plan.windows.filter((_, i) => !plan.saved[plan.keys[i] as string]).map((w) => w.length),
    ).toEqual([100, 20]);
    expect(plan.reusable).toBe(2);
    const interrupted = fakeGeneralize({ failing: new Set(["H"]) });
    await runGeneralizeStage({
      home,
      plan,
      runner: interrupted.runner,
      concurrency: 1,
      output: sink(),
    });
    expect(interrupted.calls).toEqual(["A", "H"]);
    const retry = planGeneralize({ home, budget: 400_000 });
    if (!retry) throw new Error("expected a retry");
    expect(retry.reusable).toBe(3);
    const final = fakeGeneralize();
    const result = await runGeneralizeStage({
      home,
      plan: retry,
      runner: final.runner,
      output: sink(),
    });
    expect(final.calls).toEqual(["H"]);
    expect(result.lessonList.flatMap((l) => l.source_ids).sort()).toEqual(
      plan.inputs.map((row) => row.id).sort(),
    );
    const unchanged = planGeneralize({ home, budget: 400_000 });
    if (!unchanged) throw new Error("expected a plan");
    expect(unchanged.keys).toEqual(retry.keys);
    expect(unchanged.reusable).toBe(4);
    const noOp = await runGeneralizeStage({
      home,
      plan: unchanged,
      runner: final.runner,
      output: sink(),
    });
    expect(noOp.artifact).toEqual(result.artifact);
    expect(final.calls).toEqual(["H"]);
    const edited = readObservedPreferences(home).find((row) => row.text.startsWith("E"));
    if (!edited) throw new Error("expected source candidate");
    const wording = "Updated preference: explain the outcome in plain English.";
    savePreferenceReview(home, edited, { status: "accepted", text: wording });
    const updated = planGeneralize({ home, budget: 400_000 });
    if (!updated) throw new Error("expected a changed plan");
    expect(updated.reusable).toBe(3);
    expect(
      updated.windows
        .filter((_, i) => !updated.saved[updated.keys[i] as string])
        .flat()
        .map((row) => row.text),
    ).toContain(wording);
  });

  it("keeps completed smaller windows when resuming with the larger default", async () => {
    const home = agreementsHome();
    const first = fakeGeneralize({ failing: new Set(["C"]) });
    await generalize(home, first.runner, { windowSize: 2, concurrency: 1 });
    const plan = planGeneralize({ home, budget: 400_000 });
    if (!plan) throw new Error("expected a plan");
    expect(plan.reusable).toBe(1);
    const next = fakeGeneralize();
    const result = await runGeneralizeStage({ home, plan, runner: next.runner, output: sink() });
    expect(result.status).toBe("done");
    expect(next.calls).toEqual(["C"]);
    expect(result.lessonList).toHaveLength(4);
  });
});

describe("working agreements stage, many calls in flight", () => {
  it("a failed window starts nothing new, lets running windows finish and checkpoints them; a rerun calls only the failed window", async () => {
    const home = agreementsHome();
    const gates = new Map(["A", "B", "C", "D"].map((letter) => [letter, deferred()]));
    const fake = fakeGeneralize({
      gate: (letter) => gates.get(letter)?.promise,
      failing: new Set(["B"]),
    });
    const plan = planGeneralize({
      home,
      budget: 400_000,
      windowSize: 1,
      selection: "all-candidates",
    });
    if (!plan) throw new Error("expected a plan");
    expect(plan.windows).toHaveLength(4);
    const running = runGeneralizeStage({
      home,
      plan,
      runner: fake.runner,
      concurrency: 3,
      output: sink(),
      now: () => NOW,
    });
    await flush();
    // Windows 1 to 3 are in flight; window 4 waits for a free slot.
    expect(fake.calls).toEqual(["A", "B", "C"]);
    gates.get("B")?.resolve();
    await flush();
    gates.get("C")?.resolve();
    await flush();
    gates.get("A")?.resolve();
    await flush();
    // Window 4 never started after window 2 failed. Its gate is opened anyway so
    // a regression fails here instead of hanging.
    expect(fake.calls).toEqual(["A", "B", "C"]);
    gates.get("D")?.resolve();
    const result = await running;
    expect(result.status).toBe("partial");
    expect(result.completedWindows).toBe(2);
    expect(result.failure?.window).toBe(2);
    expect(result.errors.join("\n")).toContain("1 batch was not started after the failure");
    const checkpoints = readGeneralizeCheckpoints(home);
    expect(Object.keys(checkpoints).sort()).toEqual(
      [plan.keys[0], plan.keys[2]].map(String).sort(),
    );
    // The finished windows are saved as an incomplete set, so they can be shown.
    const partial = inspectGeneralized(home);
    expect(partial.state === "ok" && partial.artifact.lessons.length).toBe(2);
    expect(partial.state === "ok" && partial.incomplete).toEqual({
      summarized: 2,
      total: 4,
      windowsFailed: 2,
    });

    // The rerun reuses windows 1 and 3, calls 2 and 4, and saves the complete set.
    const rerun = fakeGeneralize();
    const again = await generalize(home, rerun.runner);
    expect(rerun.calls).toEqual(["B", "D"]);
    expect(again.result.status).toBe("done");
    expect(again.result.reused).toBe(2);
    expect(Object.keys(readGeneralizeCheckpoints(home))).toEqual([]);
    // The checkpoint was alone in the folder it shares with saved subagents, so the folder is gone.
    expect(fs.existsSync(path.join(home, "library", "subagents"))).toBe(false);
    const complete = inspectGeneralized(home);
    expect(complete.state === "ok" && complete.artifact.lessons.length).toBe(4);
    expect(complete.state === "ok" && "incomplete" in complete).toBe(false);
    expect(complete.state === "ok" && complete.artifact.incomplete).toBeUndefined();
  });

  it("the live API exposes only completed windows in this run while keeping a previous complete set", async () => {
    const home = agreementsHome();
    await generalize(home, fakeGeneralize().runner);
    const oldSet = fs.readFileSync(path.join(home, GENERALIZED_PATH));
    review(home, "Charlie", "dismissed");
    const plan = planGeneralize({
      home,
      budget: 400_000,
      windowSize: 1,
      selection: "all-candidates",
      fresh: true,
    });
    if (!plan) throw new Error("expected plan");
    const liveBatches = new LiveBatches();
    const server = guiHarness(home, undefined, liveBatches);
    const fetchView = async () =>
      JSON.parse((await request(server, "/api/preferences/generalized")).text);
    const untouched = await fetchView();
    // The view says a reflection is still adding to the library until it ends.
    expect(untouched.running).toBe(true);
    const pending = deferred();
    liveBatches.update({ kind: "begin", total: plan.windows.length });
    const running = runGeneralizeStage({
      home,
      plan,
      concurrency: 1,
      output: sink(),
      runner: fakeGeneralize({
        gate: (letter) => (letter === "B" ? pending.promise : undefined),
        failing: new Set(["B"]),
      }).runner,
      onBatch: (index, lessons) => liveBatches.update({ kind: "batch", index, lessons }),
    });
    await flush();
    const midway = await fetchView();
    expect(midway.lessons).toEqual(untouched.lessons);
    expect(midway.live).toMatchObject({
      status: "running",
      completedBatches: 1,
      totalBatches: 3,
      lessons: [
        { instruction: expect.stringContaining("Alpha"), source_ids: [plan.windows[0]?.[0]?.id] },
      ],
    });
    expect((await request(server, "/api/preferences/generalized", { token: false })).status).toBe(
      403,
    );
    pending.resolve();
    expect((await running).status).toBe("partial");
    liveBatches.update({ kind: "interrupted" });
    expect((await fetchView()).live.status).toBe("interrupted");
    expect(fs.readFileSync(path.join(home, GENERALIZED_PATH))).toEqual(oldSet);
    const before = liveBatches.revision;
    liveBatches.update({ kind: "finished" });
    expect((await fetchView()).running).toBe(false);
    // The page learns of it through the revision, once.
    expect(liveBatches.revision).toBe(before + 1);
    liveBatches.update({ kind: "finished" });
    expect(liveBatches.revision).toBe(before + 1);
    // The plain browser view has no reflection behind it and says nothing of one.
    const plain = (await request(guiHarness(home), "/api/preferences/generalized")).text;
    expect(plain).not.toContain('"live":');
    expect(plain).not.toContain('"running":');
  });

  it("a failed window never replaces a complete saved set; a run with no window finished saves nothing", async () => {
    const home = agreementsHome();
    const first = await generalize(home, fakeGeneralize().runner);
    expect(first.result.status).toBe("done");
    const before = fs.readFileSync(path.join(home, GENERALIZED_PATH), "utf8");
    // A fresh run calls every window again, and one of them fails.
    const plan = planGeneralize({
      home,
      budget: 400_000,
      windowSize: 1,
      selection: "all-candidates",
      fresh: true,
    });
    if (!plan) throw new Error("expected a plan");
    const failed = await runGeneralizeStage({
      home,
      plan,
      runner: fakeGeneralize({ failing: new Set(["B"]) }).runner,
      concurrency: 1,
      output: sink(),
      now: () => NOW,
    });
    expect(failed.status).toBe("partial");
    expect(fs.readFileSync(path.join(home, GENERALIZED_PATH), "utf8")).toBe(before);

    const empty = agreementsHome();
    const none = await generalize(
      empty,
      fakeGeneralize({ failing: new Set(["A", "B", "C", "D"]) }).runner,
      { concurrency: 1 },
    );
    expect(none.result.status).toBe("failed");
    expect(fs.existsSync(path.join(empty, GENERALIZED_PATH))).toBe(false);
  });

  it("gives the same lesson ids and the same artifact bytes whatever order the calls finish in", async () => {
    const inOrder = agreementsHome(PREFS.slice(0, 3));
    await generalize(inOrder, fakeGeneralize().runner, { concurrency: 1 });

    const shuffled = agreementsHome(PREFS.slice(0, 3));
    const gates = new Map(["A", "B", "C"].map((letter) => [letter, deferred()]));
    const fake = fakeGeneralize({ gate: (letter) => gates.get(letter)?.promise });
    const running = generalize(shuffled, fake.runner, { concurrency: 10 });
    await flush();
    expect(fake.calls).toEqual(["A", "B", "C"]);
    for (const letter of ["C", "A", "B"]) {
      gates.get(letter)?.resolve();
      await flush();
    }
    const { result } = await running;
    expect(result.status).toBe("done");
    expect(result.lessonList.map((lesson) => lesson.id)).toEqual([
      "shared-working-agreement",
      "shared-working-agreement-2",
      "shared-working-agreement-3",
    ]);
    expect(result.lessonList[0]?.source_ids).toEqual(
      inspectOk(inOrder).artifact.lessons[0]?.source_ids,
    );
    expect(fs.readFileSync(path.join(shuffled, GENERALIZED_PATH), "utf8")).toBe(
      fs.readFileSync(path.join(inOrder, GENERALIZED_PATH), "utf8"),
    );
  });
});

function inspectOk(home: string) {
  const state = inspectGeneralized(home);
  if (state.state !== "ok") throw new Error(`expected saved agreements, got ${state.state}`);
  return state;
}

describe("saved working agreements", () => {
  it("stay fresh when a preference is accepted or an unrelated project appears; dismissal and a new prompt version make them stale", async () => {
    const home = agreementsHome();
    expect(inspectGeneralized(home)).toEqual({ state: "absent" });
    await generalize(home, fakeGeneralize().runner);
    expect(inspectOk(home).stale).toBe(false);

    review(home, "Alpha", "accepted");
    expect(inspectOk(home).stale).toBe(false);

    // A new project, and a project renamed, that no preference was seen in.
    setManifest(home, ["harbor-ledger", "spare-project", "quiet-orchard"]);
    expect(inspectOk(home).stale).toBe(false);
    setManifest(home, ["harbor-ledger", "spare-project-renamed", "quiet-orchard"]);
    expect(inspectOk(home).stale).toBe(false);
    // The rerun reuses every window: identity follows the projects the inputs name.
    const rerun = fakeGeneralize();
    await generalize(home, rerun.runner);
    expect(rerun.calls).toEqual([]);

    review(home, "Bravo", "dismissed");
    expect(inspectOk(home).stale).toBe(true);
  });

  it("a saved set from another prompt version is stale", async () => {
    const home = agreementsHome();
    await generalize(home, fakeGeneralize().runner);
    const file = path.join(home, GENERALIZED_PATH);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.prompt_version += 1;
    fs.writeFileSync(file, JSON.stringify(saved));
    expect(inspectOk(home).stale).toBe(true);
  });

  it("a referenced project renamed makes them stale", async () => {
    const home = agreementsHome();
    await generalize(home, fakeGeneralize().runner);
    // Rename the project the project-scoped preference names.
    const file = path.join(home, "library", "task-p4", "sources.json");
    fs.writeFileSync(
      file,
      fs.readFileSync(file, "utf8").replaceAll("harbor-ledger", "harbor-ledger-two"),
    );
    expect(inspectOk(home).stale).toBe(true);
  });

  it.each([
    ["not JSON", "{not json", "not valid JSON"],
    ["the wrong shape", JSON.stringify({ version: 1 }), ""],
  ])("a damaged file (%s) is reported as damaged, never thrown, and the next run rebuilds it", async (_name, body, reason) => {
    const home = agreementsHome();
    const file = path.join(home, GENERALIZED_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    const state = inspectGeneralized(home);
    expect(state.state).toBe("damaged");
    if (state.state === "damaged") expect(state.reason).toContain(reason);

    const { plan, result } = await generalize(home, fakeGeneralize().runner);
    expect(plan.damaged).toBeTruthy();
    expect(result.status).toBe("done");
    expect(inspectOk(home).stale).toBe(false);
  });

  it("a narrower accepted run replaces a damaged set, and keeps a readable all-candidates set", async () => {
    const run = async (home: string) => {
      const plan = planGeneralize({ home, budget: 400_000, windowSize: 1, selection: "auto" });
      if (!plan) throw new Error("expected a plan");
      expect(plan.selection).toBe("accepted");
      return runGeneralizeStage({
        home,
        plan,
        runner: fakeGeneralize().runner,
        output: sink(),
        now: () => NOW,
      });
    };
    const damaged = agreementsHome();
    fs.mkdirSync(path.join(damaged, "library"), { recursive: true });
    fs.writeFileSync(path.join(damaged, GENERALIZED_PATH), "{not json");
    review(damaged, "Alpha", "accepted");
    expect((await run(damaged)).status).toBe("done");
    expect(inspectOk(damaged).artifact.selection).toBe("accepted");

    const wider = agreementsHome();
    await generalize(wider, fakeGeneralize().runner);
    review(wider, "Alpha", "accepted");
    expect((await run(wider)).status).toBe("done");
    expect(inspectOk(wider).artifact.selection).toBe("all-candidates");
  });

  it("records the concrete model that answered, keeps the plan label apart, and writes no label where a model belongs", async () => {
    const home = agreementsHome();
    const fake = fakeGeneralize({ resolved: { runner: "codex", model: "synthetic-sol-2" } });
    const { result } = await generalize(home, fake.runner, { model: "balanced/major" });
    expect(result.status).toBe("done");
    const { artifact } = inspectOk(home);
    expect(artifact.model).toBe("synthetic-sol-2");
    expect(artifact.model_plan).toBe("balanced/major");
    expect(artifact.resolved).toEqual([{ runner: "codex", model: "synthetic-sol-2" }]);

    // Search every JSON file written under the data home.
    const offending: string[] = [];
    const visit = (value: unknown, where: string) => {
      if (Array.isArray(value)) {
        for (const [i, v] of value.entries()) visit(v, `${where}[${i}]`);
      } else if (value && typeof value === "object")
        for (const [key, v] of Object.entries(value)) {
          if (key === "model" && typeof v === "string" && isPlanLabel(v)) offending.push(where);
          visit(v, `${where}.${key}`);
        }
    };
    for (const file of fs.readdirSync(home, { recursive: true }) as string[]) {
      if (!file.endsWith(".json")) continue;
      visit(JSON.parse(fs.readFileSync(path.join(home, file), "utf8")), file);
    }
    expect(offending).toEqual([]);
  });

  it("an explicit model with no provenance from the runner is recorded as given; several models record none", async () => {
    const explicit = agreementsHome(PREFS.slice(0, 2));
    const quiet = (async (call: { prompt: string }) => {
      const inputs = inputsOf(call.prompt);
      return {
        lessons: inputs.map((input) => ({
          title: input.text.slice(0, 40),
          instruction: `${input.text} Apply it consistently.`,
          applies_when: "",
          exceptions: "",
          disposition: "generalized",
          source_ids: [input.id],
        })),
        set_aside: [],
      };
    }) as unknown as RunnerFn;
    await generalize(explicit, quiet, { model: "given-model" });
    expect(inspectOk(explicit).artifact.model).toBe("given-model");
    expect(inspectOk(explicit).artifact.model_plan).toBeUndefined();

    const mixed = agreementsHome(PREFS.slice(0, 2));
    let n = 0;
    const alternating = (async (call: Parameters<RunnerFn>[0]) => {
      n++;
      return fakeGeneralize({
        resolved: { runner: "claude", model: n === 1 ? "synthetic-a" : "synthetic-b" },
      }).runner(call);
    }) as RunnerFn;
    await generalize(mixed, alternating, { model: "best/major", concurrency: 1 });
    const { artifact } = inspectOk(mixed);
    expect(artifact.model).toBeNull();
    expect(artifact.model_plan).toBe("best/major");
    expect(artifact.resolved?.map((call) => call.model)).toEqual(["synthetic-a", "synthetic-b"]);
  });
});

describe("identifiers the model hands back", () => {
  it("are short aliases in the call, and the real ids everywhere they are saved", async () => {
    const home = agreementsHome();
    const prompts: string[] = [];
    const fake = fakeGeneralize();
    const runner = (async (call: { prompt: string }) => {
      prompts.push(call.prompt);
      return (fake.runner as unknown as (c: unknown) => Promise<unknown>)(call);
    }) as unknown as RunnerFn;
    const { plan, result } = await generalize(home, runner, { windowSize: 4 });
    expect(result.status).toBe("done");
    const [prompt] = prompts;
    expect(inputsOf(prompt ?? "").map((input) => input.id)).toEqual(["p1", "p2", "p3", "p4"]);
    const realIds = plan.inputs.map((input) => input.id);
    for (const id of realIds) expect(prompt).not.toContain(id);
    // The saved set names the real ids; reuse keys are those of the real inputs.
    const saved = JSON.parse(fs.readFileSync(path.join(home, GENERALIZED_PATH), "utf8"));
    const window = saved.windows[plan.keys[0] as string];
    expect(window.input_ids.sort()).toEqual([...realIds].sort());
    expect(
      window.result.lessons.flatMap((lesson: { source_ids: string[] }) => lesson.source_ids).sort(),
    ).toEqual([...realIds].sort());
    const again = planGeneralize({
      home,
      budget: 400_000,
      windowSize: 4,
      selection: "all-candidates",
    });
    expect(again?.reusable).toBe(1);
  });

  it("a window that fails its checks twice is reported in plain words", async () => {
    const home = agreementsHome();
    const runner = (async () => ({ lessons: [], set_aside: [] })) as unknown as RunnerFn;
    const lines: string[] = [];
    const plan = planGeneralize({
      home,
      budget: 400_000,
      windowSize: 4,
      selection: "all-candidates",
    });
    if (!plan) throw new Error("expected a plan");
    const result = await runGeneralizeStage({
      home,
      plan,
      runner,
      output: new Writable({
        write(chunk, _e, cb) {
          lines.push(chunk.toString());
          cb();
        },
      }),
      now: () => NOW,
    });
    expect(result.failure?.error).toBe(
      "the answer failed its checks twice: it did not place every preference exactly once",
    );
    // The exact rule messages stay in the record, not on screen.
    expect(result.failure?.problems[0]).toMatch(/^G1 /);
    expect(lines.join("")).not.toMatch(/\bG\d\b|\bp\d+\b/);
  });

  it("an alias the window did not contain fails the window's checks", async () => {
    const home = agreementsHome();
    const prompts: string[] = [];
    const runner = (async (call: { prompt: string }) => {
      prompts.push(call.prompt);
      const inputs = inputsOf(call.prompt);
      return {
        lessons: inputs.map((input, index) => ({
          title: "Shared working agreement",
          instruction: `${input.text} Apply it consistently and say when it does not fit.`,
          applies_when: "Whenever it applies.",
          exceptions: "",
          disposition: "contextual",
          source_ids: [index === 0 ? "p99" : input.id],
        })),
        set_aside: [],
      };
    }) as unknown as RunnerFn;
    const { result } = await generalize(home, runner, { windowSize: 4 });
    expect(result.status).toBe("failed");
    // The correction names the alias the model wrote, never a real id.
    expect(prompts[1]).toContain("p99");
    expect(fs.existsSync(path.join(home, GENERALIZED_PATH))).toBe(false);
    expect(readGeneralizeCheckpoints(home)).toEqual({});
  });
});
