import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderStatus } from "../src/commands/status.js";
import {
  assignLessonIds,
  DEFAULT_WINDOW_SIZE,
  GENERALIZE_CHECKPOINT_FILE,
  planWindows,
  readGeneralizeCheckpoints,
  repairAuthor,
  repairGeneralize,
  repairProposal,
  resolveModels,
  resolveWindowSize,
  runSuggestSubagents,
  SUGGESTION_FAILURE_FILE,
  SUGGESTION_PARTIAL_FILE,
  type SuggestSubagentsArgs,
  trimPrompt,
  trimTitle,
  UNPLACED_PLAYBOOK,
} from "../src/commands/suggest-subagents.js";
import { readLibraryIssues } from "../src/core/library.js";
import { readPreferenceReviews, savePreferenceReview } from "../src/core/preference-review.js";
import { readObservedPreferences } from "../src/core/preferences.js";
import { generalizeProblems } from "../src/core/subagent-checks.js";
import {
  pendingAuthorProposal,
  RoleSchema,
  readSuggestion,
  SUGGEST_PROMPT_VERSIONS,
  type SuggestionArtifact,
  saveAuthorProgress,
  savedSuggestionKey,
  selectSuggestionInputs,
  suggestionPath,
  writeSuggestion,
} from "../src/core/subagents.js";
import { renderSubagentTree } from "../src/core/subagents-render.js";
import { planGeneralize, runGeneralizeStage } from "../src/distill/generalize.js";
import { acquireWriterLock } from "../src/distill/operations.js";
import type { RunnerFn } from "../src/distill/pipeline.js";
import {
  AUTHOR_ROLE_PROMPT_VERSION,
  buildAuthorRolePrompt,
} from "../src/distill/prompts/author-role.js";
import {
  GENERALIZE_PROMPT_VERSION,
  renderGeneralizeInput,
} from "../src/distill/prompts/generalize.js";
import { PROPOSE_PROMPT_VERSION } from "../src/distill/prompts/propose.js";
import { EVALUATION_VERSIONS } from "../src/eval/prompts.js";
import type { RunClaudeOptions } from "../src/runners/claude.js";
import type { AgentRunner, RunOptions } from "../src/runners/types.js";
import type { TerminalHost } from "../src/ui/live.js";
import { goldenText } from "./support/text.js";
import { fakeInput, fakeOutput } from "./support/tty.js";

const SAMPLE = path.join(import.meta.dirname, "fixtures", "subagents", "suggestion.sample.json");
const NOW = new Date("2026-11-21T12:00:00.000Z");

function sample(): SuggestionArtifact {
  return JSON.parse(fs.readFileSync(SAMPLE, "utf8")) as SuggestionArtifact;
}

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-suggest-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.unstubAllEnvs();
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Library homes are built once per review choice and copied, which is much cheaper than rebuilding. */
const templates = new Map<string, string>();
afterAll(() => {
  for (const dir of templates.values()) fs.rmSync(dir, { recursive: true, force: true });
  templates.clear();
});

/**
 * A synthetic library home holding the sample's 14 inputs as legacy library
 * entries (one task each), plus a manifest naming one more project. `accept`
 * picks which sample inputs (by their p-number) are accepted in review.
 */
function libraryHome(accept: "all" | "none" | string[] = "all"): string {
  const key = JSON.stringify(accept);
  let template = templates.get(key);
  if (!template) {
    template = buildLibraryHome(accept);
    templates.set(key, template);
  }
  const home = tmpDir();
  fs.cpSync(template, home, { recursive: true });
  return home;
}

function buildLibraryHome(accept: "all" | "none" | string[]): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hh-suggest-template-"));
  for (const input of sample().inputs) {
    const dir = path.join(home, "library", `task-${input.id}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "sources.json"),
      JSON.stringify({
        slug: `task-${input.id}`,
        title: input.id,
        members: [`${input.id}.md`],
        sessionIds: [input.id],
        preferences: [
          {
            text: input.text,
            evidence: input.quote,
            scope: input.scope,
            ...(input.project ? { project: input.project } : {}),
          },
        ],
        outcome_summary: "1 completed",
        domains: input.domain ? [input.domain] : [],
        confidence: "high",
        authored_at: `2026-11-${String(Number(input.id.slice(1))).padStart(2, "0")}T00:00:00.000Z`,
        model: null,
        prompt_version: 1,
        tool_version: "1.9.0",
        generation: "g1",
      }),
    );
  }
  fs.mkdirSync(path.join(home, "exports"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "exports", "manifest.json"),
    JSON.stringify([{ export: "x.md", project: "internal-tools", messages: 3 }]),
  );
  const texts = new Map(sample().inputs.map((input) => [input.text, input.id]));
  for (const preference of readObservedPreferences(home)) {
    const id = texts.get(preference.text) ?? "";
    if (accept === "all" || (Array.isArray(accept) && accept.includes(id)))
      savePreferenceReview(home, preference, { status: "accepted" });
  }
  return home;
}

function listing(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[]).sort();
}

function capture(): { out: Writable; text: () => string } {
  let text = "";
  const out = new Writable({
    write(chunk, _encoding, done) {
      text += chunk.toString();
      done();
    },
  });
  return { out, text: () => text };
}

type Stage = "generalize" | "propose" | "merge" | "author";
interface Call {
  stage: Stage;
  prompt: string;
  model?: string;
  timeoutMs?: number;
}

function stageOf(prompt: string): Stage {
  if (prompt.includes("=== INPUTS (")) return "generalize";
  if (prompt.includes("=== PROPOSALS (")) return "merge";
  if (prompt.includes("=== LESSONS (")) return "propose";
  if (prompt.includes("=== ROLE ===")) return "author";
  throw new Error(`unrecognized prompt: ${prompt.slice(0, 80)}`);
}

function block(prompt: string, start: string, end: string): string[] {
  const from = prompt.indexOf(start);
  const to = prompt.indexOf(end, from);
  return prompt
    .slice(prompt.indexOf("\n", from) + 1, to)
    .split("\n")
    .filter(Boolean);
}

const FILLER =
  "Work through the delegated request step by step, keep the coordinator informed of anything that changes the plan, and report what you checked. ";

function role(name: string, lessonIds: string[]) {
  return {
    name,
    display_name: name
      .split("-")
      .map((word) => word[0]?.toUpperCase() + word.slice(1))
      .join(" "),
    description: `Takes bounded ${name} work from the coordinator.`,
    delegate_when: "The task fits this specialty and can be done independently.",
    not_for: "Work outside this specialty.",
    lesson_ids: lessonIds,
  };
}

/**
 * A fake runner that answers each stage from the prompt it is given, the way a
 * cooperative model would. `faults[stage]` makes that many first calls of the
 * stage return a response that breaks one rule (G2, P5, A1). A boolean array
 * instead picks the faulty calls one by one (`[true, false, true, true]`), for
 * tests that need a window to pass before a later one fails.
 */
function fakeRunner(faults: Partial<Record<Stage, number | boolean[]>> & { omit?: boolean } = {}) {
  const calls: Call[] = [];
  const seen: Partial<Record<Stage, number>> = {};
  const runner = (async (opts: RunClaudeOptions<unknown>) => {
    const stage = stageOf(opts.prompt);
    calls.push({ stage, prompt: opts.prompt, model: opts.model, timeoutMs: opts.timeoutMs });
    seen[stage] = (seen[stage] ?? 0) + 1;
    const plan = faults[stage];
    const faulty = Array.isArray(plan)
      ? plan[(seen[stage] ?? 1) - 1] === true
      : (seen[stage] ?? 0) <= (plan ?? 0);
    if (stage === "generalize") {
      const inputs = block(opts.prompt, "=== INPUTS (", "=== END INPUTS ===").map(
        (line) => JSON.parse(line) as { id: string; text: string; scope: string },
      );
      const lessons = [];
      const set_aside = [];
      for (const input of inputs) {
        if (input.scope === "task" || input.text.startsWith("Thanks")) {
          set_aside.push({ source_ids: [input.id], reason: "No reusable instruction in it." });
          continue;
        }
        lessons.push({
          title: input.text.slice(0, 80),
          instruction: `${input.text} Apply it consistently and say when it does not fit the task.`,
          applies_when: "Whenever the situation it describes comes up.",
          exceptions: "",
          disposition: input.scope === "project" ? "contextual" : "generalized",
          source_ids: [input.id],
        });
      }
      const portable = lessons.find((lesson) => lesson.disposition === "generalized");
      if (faulty && portable) portable.instruction += " This was learned in atlas-billing.";
      return { lessons, set_aside };
    }
    if (stage === "propose") {
      const lessons = block(opts.prompt, "=== LESSONS (", "=== END LESSONS ===").map(
        (line) => JSON.parse(line) as { id: string; disposition: string },
      );
      const portable = lessons.filter((l) => l.disposition === "generalized").map((l) => l.id);
      const other = lessons.filter((l) => l.disposition !== "generalized").map((l) => l.id);
      const half = Math.ceil(portable.length / 2);
      const groups =
        portable.length > 1 ? [portable.slice(0, half), portable.slice(half)] : [portable];
      const roles = groups
        .filter((ids) => ids.length)
        .map((ids, index) => role(["evidence-checker", "change-runner"][index] ?? "x", ids));
      const contextual = other[0];
      if (faulty && contextual) roles[0]?.lesson_ids.push(contextual);
      // `omit` leaves the last portable lesson out of every role (the real
      // failure shape on the first library run); the stage must repair it.
      if (faults.omit)
        for (const r of roles) r.lesson_ids = r.lesson_ids.filter((id) => id !== portable.at(-1));
      return {
        roles,
        shared: [],
        playbooks: other.length
          ? [{ name: "project-notes", purpose: "Notes for one product area.", lesson_ids: other }]
          : [],
      };
    }
    if (stage === "merge") {
      const proposals = block(opts.prompt, "=== PROPOSALS (", "=== END PROPOSALS ===").map(
        (line) =>
          JSON.parse(line.slice(line.indexOf(":") + 1)) as {
            roles: ReturnType<typeof role>[];
            shared: string[];
            playbooks: { name: string; purpose: string; lesson_ids: string[] }[];
          },
      );
      const roles = new Map<string, ReturnType<typeof role>>();
      const playbooks = new Map<string, { name: string; purpose: string; lesson_ids: string[] }>();
      for (const proposal of proposals) {
        for (const r of proposal.roles) {
          const existing = roles.get(r.name);
          if (existing) existing.lesson_ids.push(...r.lesson_ids);
          else roles.set(r.name, { ...r, lesson_ids: [...r.lesson_ids] });
        }
        for (const p of proposal.playbooks) {
          const existing = playbooks.get(p.name);
          if (existing) existing.lesson_ids.push(...p.lesson_ids);
          else playbooks.set(p.name, { ...p, lesson_ids: [...p.lesson_ids] });
        }
      }
      return {
        roles: [...roles.values()],
        shared: proposals.flatMap((p) => p.shared),
        playbooks: [...playbooks.values()],
      };
    }
    const card = JSON.parse(block(opts.prompt, "=== ROLE ===", "=== END ROLE ===")[0] ?? "{}") as {
      name: string;
    };
    const ids = block(opts.prompt, "=== ROLE LESSONS (", "=== END ROLE LESSONS ===").map(
      (line) => (JSON.parse(line) as { id: string }).id,
    );
    const steps = ids.map((id, index) => `${index + 1}. Apply the lesson for this step (${id}).`);
    const prompt = [
      `## What you own\n\nYou are the ${card.name} specialist.`,
      "## Boundary\n\nStop and report back when the request leaves this specialty.",
      `## Method\n\n${steps.join("\n")}`,
      `## Handoff format\n\n${FILLER.repeat(16)}`,
    ].join("\n\n");
    return {
      prompt: faulty ? "Too short." : prompt,
      triggers: ["check this work", "run the change", "review results"],
    };
  }) as RunnerFn;
  return { runner, calls, count: (stage: Stage) => calls.filter((c) => c.stage === stage).length };
}

async function run(
  home: string,
  args: SuggestSubagentsArgs,
  extra: { runner?: RunnerFn; input?: string; userHome?: string } = {},
) {
  const cap = capture();
  let input: PassThrough | undefined;
  if (extra.input !== undefined) {
    input = new PassThrough();
    input.end(extra.input);
  }
  const code = await runSuggestSubagents(
    { home, ...args },
    {
      runner: extra.runner,
      runnerName: "kiro",
      output: cap.out,
      input,
      now: () => NOW,
      // A fresh home without harness roots, so the warning depends only on the
      // test (the OS temp dir can itself sit inside a real harness root).
      userHome: extra.userHome ?? tmpDir(),
    },
  );
  return { code, text: cap.text() };
}

/** A budget that splits the sample inputs into exactly two generalize windows. */
function twoWindowBudget(home: string): number {
  const { reviews } = readPreferenceReviews(home);
  const { inputs } = selectSuggestionInputs(readObservedPreferences(home), reviews, {
    includeUnreviewed: false,
  });
  const total = inputs.reduce((sum, input) => sum + renderGeneralizeInput(input).length + 1, 0);
  return Math.ceil(total * 0.6);
}

/** Screen text with its wrapping undone, for assertions on phrases. */
const flatText = (text: string) => strip(text).replace(/\s+/g, " ");

function strip(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI codes
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("suggest-subagents prompt versions", () => {
  it("match the versions the saved artifact records and are registered for evaluation", () => {
    expect(GENERALIZE_PROMPT_VERSION).toBe(SUGGEST_PROMPT_VERSIONS.generalize);
    expect(PROPOSE_PROMPT_VERSION).toBe(SUGGEST_PROMPT_VERSIONS.propose);
    expect(AUTHOR_ROLE_PROMPT_VERSION).toBe(SUGGEST_PROMPT_VERSIONS.author);
    expect(EVALUATION_VERSIONS).toMatchObject({
      subagent_generalize: GENERALIZE_PROMPT_VERSION,
      subagent_propose: PROPOSE_PROMPT_VERSION,
      subagent_author: AUTHOR_ROLE_PROMPT_VERSION,
    });
  });

  it("tell the author stage the trigger rules the saved artifact enforces", () => {
    const saved = sample().roles[0];
    if (!saved) throw new Error("Expected a sample role.");
    const prompt = buildAuthorRolePrompt({
      role: saved,
      lessons: [],
      shared: [],
      projects: [],
    });
    expect(prompt).toContain('"triggers": 3 to 8 short phrases');
    expect(prompt).toContain('each 1 to 4 words, with no commas, colons or "#"');
    // The same characters the schema refuses, so a model that follows the
    // prompt never trips the check.
    for (const bad of ["a, b", "a: b", "a #b"]) {
      expect(
        RoleSchema.safeParse({ ...saved, triggers: [bad, "plain one", "plain two"] }).success,
      ).toBe(false);
    }
    expect(
      RoleSchema.safeParse({ ...saved, triggers: ["one", "two words", "three more words"] })
        .success,
    ).toBe(true);
  });
});

describe("helpers", () => {
  it("planWindows keeps order, respects the budget and isolates an oversized item", () => {
    const sizes = [4, 4, 4, 30, 4];
    const windows = planWindows(sizes, (n) => n, 10);
    expect(windows).toEqual([[4, 4], [4], [30], [4]]);
    expect(planWindows([], (n: number) => n, 10)).toEqual([]);
  });

  it("planWindows also caps the item count per window, whichever limit comes first", () => {
    const sizes = [1, 1, 1, 1, 1, 1, 1];
    expect(planWindows(sizes, (n) => n, 1000, 3)).toEqual([[1, 1, 1], [1, 1, 1], [1]]);
    // the count cap never splits below one item, and an oversized item still stands alone
    expect(planWindows([50, 1, 1], (n) => n, 10, 2)).toEqual([[50], [1, 1]]);
    // the default cap is effectively unlimited
    expect(planWindows(sizes, (n) => n, 1000)).toEqual([sizes]);
  });

  it("trimTitle cuts an over-long title at a word boundary and leaves a fitting one alone", () => {
    const words = "keep stakeholder shareable documents clean of internal links and names";
    expect(trimTitle(words)).toBe(words);
    const long = `${words} and anything else that would push it over the cap`;
    const trimmed = trimTitle(long);
    expect(trimmed.length).toBeLessThanOrEqual(80);
    expect(long.startsWith(trimmed)).toBe(true);
    expect(trimmed.endsWith(" ")).toBe(false);
    expect(trimmed).not.toMatch(/[,;:.-]$/);
    // a single unbroken token is cut hard rather than emptied
    expect(trimTitle("x".repeat(90))).toHaveLength(80);
  });

  it("repairGeneralize trims over-long titles, notes each one, and touches nothing else", () => {
    const lesson = {
      title: "t".repeat(81),
      instruction: "i".repeat(60),
      applies_when: "",
      exceptions: "",
      disposition: "generalized" as const,
      source_ids: ["a"],
    };
    const fine = { ...lesson, title: "fits" };
    const { value, notes } = repairGeneralize({ lessons: [lesson, fine], set_aside: [] });
    expect(notes).toEqual(["lesson 1: title trimmed from 81 to 80 characters"]);
    expect(value.lessons[0]?.title).toHaveLength(80);
    expect(value.lessons[0]?.source_ids).toEqual(["a"]);
    expect(value.lessons[0]?.instruction).toBe(lesson.instruction);
    expect(value.lessons[1]).toEqual(fine);
    expect(repairGeneralize({ lessons: [fine], set_aside: [] }).notes).toEqual([]);
  });

  it("repairGeneralize drops a lesson with no source ids, and G1 still reports an input it was the only home of", () => {
    const base = {
      instruction: "i".repeat(60),
      applies_when: "",
      exceptions: "",
      disposition: "generalized" as const,
    };
    const sourced = { ...base, title: "Sourced", source_ids: ["a"] };
    const orphan = {
      ...base,
      title: "A duplicate the model wrote without its evidence",
      source_ids: [],
    };
    const { value, notes } = repairGeneralize({ lessons: [sourced, orphan], set_aside: [] });
    expect(value.lessons).toEqual([sourced]);
    expect(notes).toEqual([
      'lesson 2 "A duplicate the model wrote without its evidence": dropped, no source ids',
    ]);
    // Dropping never hides a missing input: with inputs a and b, b is now unplaced and G1 says so.
    const window = [
      { id: "a", text: "x", count: 1, review: "pending" as const },
      { id: "b", text: "y", count: 1, review: "pending" as const },
    ];
    const problems = generalizeProblems(value, window, []);
    expect(problems.some((p) => p.startsWith("G1") && p.includes('"b"'))).toBe(true);
    expect(problems.some((p) => p.startsWith("G3"))).toBe(false);
  });

  it("repairProposal files unplaced generalized lessons in the unplaced-lessons playbook and nothing else", () => {
    const lesson = (id: string, disposition: "generalized" | "contextual") => ({
      id,
      title: id,
      instruction: "i".repeat(60),
      applies_when: "",
      exceptions: "",
      disposition,
      source_ids: [id],
    });
    const lessons = [
      lesson("placed-in-role", "generalized"),
      lesson("placed-in-shared", "generalized"),
      lesson("left-out", "generalized"),
      lesson("also-left-out", "generalized"),
      lesson("contextual-left-out", "contextual"),
    ];
    const role = {
      name: "worker",
      display_name: "Worker",
      description: "d",
      delegate_when: "w",
      not_for: "n",
      lesson_ids: ["placed-in-role"],
    };
    const proposal = { roles: [role], shared: ["placed-in-shared"], playbooks: [] };
    const { value, notes } = repairProposal(proposal, lessons);
    expect(value.roles).toEqual([role]);
    expect(value.shared).toEqual(["placed-in-shared"]);
    expect(value.playbooks).toEqual([
      expect.objectContaining({
        name: UNPLACED_PLAYBOOK,
        lesson_ids: ["left-out", "also-left-out"],
      }),
    ]);
    // contextual lessons are not P4's concern and are not filed
    expect(value.playbooks[0]?.lesson_ids).not.toContain("contextual-left-out");
    expect(notes).toEqual([
      `lesson "left-out": unplaced, filed in the ${UNPLACED_PLAYBOOK} playbook`,
      `lesson "also-left-out": unplaced, filed in the ${UNPLACED_PLAYBOOK} playbook`,
    ]);
    // nothing to do leaves the proposal identical
    const full = {
      ...proposal,
      playbooks: [{ name: "misc", purpose: "p", lesson_ids: ["left-out", "also-left-out"] }],
    };
    expect(repairProposal(full, lessons)).toEqual({ value: full, notes: [] });
    // an existing unplaced-lessons playbook is extended, not duplicated
    const existing = {
      ...proposal,
      playbooks: [{ name: UNPLACED_PLAYBOOK, purpose: "p", lesson_ids: ["left-out"] }],
    };
    const extended = repairProposal(existing, lessons).value;
    expect(extended.playbooks).toHaveLength(1);
    expect(extended.playbooks[0]?.lesson_ids).toEqual(["left-out", "also-left-out"]);
  });

  it("trimPrompt cuts an over-long prompt at a paragraph break, then a line, then a space", () => {
    const para = `${"a".repeat(2500)}\n\n${"b".repeat(2500)}\n\n${"c".repeat(2500)}`;
    const cut = trimPrompt(para);
    expect(cut.length).toBeLessThanOrEqual(6000);
    expect(cut).toBe(`${"a".repeat(2500)}\n\n${"b".repeat(2500)}`);
    const lines = `${"a".repeat(4500)}\n${"b".repeat(1400)}\n${"c".repeat(1000)}`;
    expect(trimPrompt(lines)).toBe(`${"a".repeat(4500)}\n${"b".repeat(1400)}`);
    const words = Array.from({ length: 1300 }, () => "word").join(" ");
    const w = trimPrompt(words);
    expect(w.length).toBeLessThanOrEqual(6000);
    expect(w.endsWith("word")).toBe(true);
    expect(trimPrompt("x".repeat(7000))).toHaveLength(6000);
    expect(trimPrompt("short")).toBe("short");
  });

  it("repairAuthor cuts only an over-long prompt and leaves triggers alone", () => {
    const fits = { prompt: "p".repeat(3000), triggers: ["do it", "run it", "check it"] };
    expect(repairAuthor(fits)).toEqual({ value: fits, notes: [] });
    const long = { ...fits, prompt: `${"p".repeat(5990)}\n\n${"q".repeat(500)}` };
    const { value, notes } = repairAuthor(long);
    expect(value.prompt).toBe("p".repeat(5990));
    expect(value.triggers).toEqual(fits.triggers);
    expect(notes).toEqual(["prompt cut from 6492 to 5990 characters at a break"]);
  });

  it("resolveWindowSize defaults to 20 and rejects anything but a positive integer", () => {
    expect(resolveWindowSize(undefined)).toBe(DEFAULT_WINDOW_SIZE);
    expect(DEFAULT_WINDOW_SIZE).toBe(100);
    expect(resolveWindowSize("12")).toBe(12);
    for (const bad of ["0", "-3", "2.5", "many", ""]) {
      expect(() => resolveWindowSize(bad)).toThrow(
        `--window-size takes a whole number of preferences, 1 or more, not ${JSON.stringify(bad)}.`,
      );
    }
  });

  it("assignLessonIds slugifies titles and suffixes repeats within 80 characters", () => {
    const draft = (title: string) => ({
      title,
      instruction: "x".repeat(40),
      applies_when: "",
      exceptions: "",
      disposition: "generalized" as const,
      source_ids: ["a"],
    });
    const long = `Keep ${"very ".repeat(20)}long titles readable`;
    const ids = assignLessonIds([
      draft("Verify, then report!"),
      draft("verify then report"),
      draft("Café résumé"),
      draft("???"),
      draft(long),
      draft(long),
    ]).map((lesson) => lesson.id);
    expect(ids.slice(0, 4)).toEqual([
      "verify-then-report",
      "verify-then-report-2",
      "cafe-resume",
      "lesson",
    ]);
    expect(ids[4]?.length).toBeLessThanOrEqual(80);
    expect(ids[5]).toMatch(/-2$/);
    expect(ids[5]?.length).toBeLessThanOrEqual(80);
    expect(ids[4]?.endsWith("-")).toBe(false);
  });

  it("resolveModels uses --model, then the workflow env, for every stage without its own flag", () => {
    expect(resolveModels({})).toEqual({
      generalize: undefined,
      propose: undefined,
      author: undefined,
    });
    vi.stubEnv("HUMAN_HINDSIGHT_SUBAGENT_MODEL", "workflow-model");
    expect(resolveModels({ "propose-model": "big" })).toEqual({
      generalize: "workflow-model",
      propose: "big",
      author: "workflow-model",
    });
    expect(resolveModels({ model: "small", "author-model": "big" })).toEqual({
      generalize: "small",
      propose: "small",
      author: "big",
    });
  });
});

/** Plan screens are compared as golden text; the assertions beside each name what it must say. */
const golden = (name: string) => `golden/suggest-subagents/${name}.txt`;
/** Plan labels are internal; the person always sees concrete model names. */
const PLAN_LABEL = /\b(fast|balanced|best)\/(bulk|major)\b/;

describe("suggest-subagents plan and consent screens", () => {
  it.each([
    {
      name: "plan-nothing-accepted",
      accept: "none" as const,
      args: {},
      meaning: [
        "14 preferences. None is accepted yet, so every one is used except dismissed ones.",
        "1 call to summarize preferences, 1 call to choose roles",
        "batch 1: 14 preferences",
      ],
    },
    {
      name: "plan-window-size",
      accept: "none" as const,
      args: { "window-size": "5" },
      meaning: [
        "3 calls to summarize preferences",
        "batch 1: 5 preferences",
        "batch 3: 4 preferences",
      ],
    },
    {
      name: "plan-accepted-narrowed",
      accept: ["p01", "p02", "p03"],
      args: {},
      meaning: ["3 working preferences you accepted, of 14 observed.", "1 call to summarize"],
    },
    {
      name: "plan-include-unreviewed",
      accept: ["p01", "p02", "p03"],
      args: { "include-unreviewed": true },
      meaning: [
        "14 preferences, 3 of them accepted. Every one is used, as asked; dismissed ones are left out.",
      ],
    },
    {
      name: "plan-models-and-timeout",
      accept: "all" as const,
      args: {
        model: "fast-model",
        "author-model": "careful-model",
        timeout: "60",
        "min-roles": "3",
        "max-roles": "5",
      },
      meaning: [
        "Models fast-model for preference summaries and choosing roles, careful-model for writing roles.",
        "3 to 5 calls to write role prompts",
      ],
    },
  ])("--dry-run $name: prints the plan, writes nothing, calls nothing", async (row) => {
    const home = libraryHome(row.accept);
    const before = listing(home);
    const fake = fakeRunner();
    const { code, text } = await run(
      home,
      { "dry-run": true, ...row.args },
      { runner: fake.runner },
    );
    expect(code).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(listing(home)).toEqual(before);
    const out = goldenText(text, { roots: { [home]: "<HOME>" } });
    await expect(out).toMatchFileSnapshot(golden(row.name));
    for (const line of row.meaning) expect(flatText(out)).toContain(line);
    expect(out).not.toMatch(PLAN_LABEL);
    expect(out).not.toContain("Proceed?");
    // Plain words only, and nothing wider than the 80 columns it is wrapped to.
    expect(out).not.toMatch(/generalize|propose|window|invocation|input budget|\(s\)|Runner {2}/i);
    for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("a declined consent exits 2 with nothing written or called", async () => {
    const home = libraryHome();
    const before = listing(home);
    const fake = fakeRunner();
    const { code, text } = await run(home, {}, { runner: fake.runner, input: "n\n" });
    expect(code).toBe(2);
    expect(fake.calls).toEqual([]);
    expect(listing(home)).toEqual(before);
    const out = goldenText(text, { roots: { [home]: "<HOME>" } });
    await expect(out).toMatchFileSnapshot(golden("consent-declined"));
    expect(out).toMatch(/Declined\. Nothing was sent\./);
  });

  it("--author-only --dry-run prints the author-only plan and calls nothing", async () => {
    const home = libraryHome();
    await run(home, { yes: true, concurrency: "1" }, { runner: fakeRunner({ author: 2 }).runner });
    const fake = fakeRunner();
    const { code, text } = await run(
      home,
      { "dry-run": true, "author-only": true },
      { runner: fake.runner },
    );
    expect(code).toBe(0);
    expect(fake.calls).toEqual([]);
    const out = goldenText(text, { roots: { [home]: "<HOME>" } });
    await expect(out).toMatchFileSnapshot(golden("plan-author-only"));
    expect(flatText(out)).toContain("1 of 2 needs a written prompt (evidence-checker).");
    expect(flatText(out)).toContain("1 call to write a role prompt.");
    expect(out).not.toMatch(/summarize|choose roles/);
  });

  it("prints guidance and exits 0 when there is nothing to work from", async () => {
    const empty = await run(tmpDir(), { "dry-run": true });
    expect(empty.code).toBe(0);
    expect(empty.text).toMatch(/No preferences yet\. Reflect on your sessions first\./);
    expect(empty.text).toContain("npx human-hindsight reflect");
    // The hint keeps the folders, the pinned CLI, and the quality of this run.
    const pinned = await run(tmpDir(), {
      "dry-run": true,
      "claude-dir": "/history/claude",
      runner: "codex",
      quality: "best",
      model: "summary-model",
    });
    const hinted = pinned.text
      .split("\n")
      .find((line) => line.includes("npx human-hindsight reflect"));
    expect(hinted).toContain(" --claude-dir=/history/claude ");
    expect(hinted).toMatch(/ --runner=codex --quality=best$/);
    expect(pinned.text).not.toContain("--model");

    const home = libraryHome("none");
    for (const preference of readObservedPreferences(home))
      savePreferenceReview(home, preference, { status: "dismissed" });
    const dismissed = await run(home, { "dry-run": true });
    expect(dismissed.code).toBe(0);
    expect(dismissed.text).toContain("Every preference is dismissed");
  });

  it("refuses bad values and flags that belong to the other mode, before any call", async () => {
    const home = libraryHome();
    const fake = fakeRunner();
    for (const [args, message] of [
      [{ "min-roles": "1" }, 'error: --min-roles takes a whole number from 2 to 15, not "1".'],
      [{ "min-roles": "6", "max-roles": "4" }, "--min-roles (6) is larger than --max-roles (4)"],
      [
        { "dry-run": true, "window-size": "0" },
        'error: --window-size takes a whole number of preferences, 1 or more, not "0".',
      ],
      [
        { "dry-run": true, concurrency: "0" },
        'error: --concurrency takes a whole number of calls at a time, 1 or more, not "0".',
      ],
      [
        { "dry-run": true, timeout: "90s" },
        'error: --timeout takes a whole number of seconds, 1 or more, not "90s".',
      ],
      [
        { "dry-run": true, "input-budget": "lots" },
        'error: --input-budget takes a whole number of characters, 1000 or more, not "lots".',
      ],
      [
        { "author-only": true, concurrency: "many" },
        'error: --concurrency takes a whole number of calls at a time, 1 or more, not "many".',
      ],
      [{ export: tmpDir(), model: "x" }, "--export renders the saved suggestion"],
      [{ force: true }, "--force only applies with --export <dir>"],
    ] as [SuggestSubagentsArgs, string][]) {
      const result = await run(home, args, { runner: fake.runner });
      expect(result.code, message).toBe(1);
      expect(strip(result.text)).toContain(message);
    }
    expect(fake.calls).toEqual([]);
  });
});

describe("suggest-subagents stages", () => {
  it("runs generalize in two windows, propose per window plus a merge, and author per role", async () => {
    const home = libraryHome();
    const fake = fakeRunner();
    const { code, text } = await run(
      home,
      {
        yes: true,
        "input-budget": String(twoWindowBudget(home)),
        model: "gen-model",
        "propose-model": "plan-model",
      },
      { runner: fake.runner },
    );
    expect(code).toBe(0);
    expect(fake.count("generalize")).toBe(2);
    expect(fake.count("propose")).toBe(2);
    expect(fake.count("merge")).toBe(1);
    expect(fake.count("author")).toBe(2);
    expect(fake.calls.find((c) => c.stage === "generalize")?.model).toBe("gen-model");
    expect(fake.calls.find((c) => c.stage === "merge")?.model).toBe("plan-model");
    expect(fake.calls.find((c) => c.stage === "author")?.model).toBe("gen-model");

    const saved = readSuggestion(home);
    expect(saved?.stale).toBe(false);
    const artifact = saved?.artifact as SuggestionArtifact;
    expect(artifact.runner).toBe("kiro");
    expect(artifact.generated_at).toBe(NOW.toISOString());
    expect(artifact.prompt_versions).toEqual(SUGGEST_PROMPT_VERSIONS);
    expect(artifact.models).toEqual({
      generalize: "gen-model",
      propose: "plan-model",
      author: "gen-model",
    });
    expect(artifact.selection).toBe("accepted");
    expect(artifact.projects).toEqual(["atlas-billing", "internal-tools", "webapp"]);
    expect(artifact.coverage).toMatchObject({ source_candidates: 14, mapped: 12, set_aside: 2 });
    expect(artifact.roles.map((r) => r.name)).toEqual(["evidence-checker", "change-runner"]);
    expect(artifact.roles.every((r) => r.prompt && r.triggers?.length === 3)).toBe(true);
    expect(artifact.playbooks.map((p) => p.lesson_ids.length)).toEqual([3]);

    // Elapsed times on the progress lines come from the real clock.
    const out = goldenText(text, { roots: { [home]: "<HOME>" } }).replace(
      / · \d+(?:m \d+)?s\b/g,
      " · <elapsed>",
    );
    await expect(out).toMatchFileSnapshot(golden("run-two-windows"));
    // Meaning: role count, candidate count, lessons mapped, inputs set aside, and the next steps.
    expect(out).toMatch(/Suggested 2 roles from 14 preferences\./);
    expect(flatText(out)).toMatch(
      /\b12 preferences in all; 1 group of project-specific notes; 2 preferences left out\b/,
    );
    expect(out).toContain("<HOME>/library/subagents/suggestion.json");
    expect(out).toContain("--export human-hindsight-subagents");
    expect(
      fs.existsSync(path.join(path.dirname(suggestionPath(home)), SUGGESTION_PARTIAL_FILE)),
    ).toBe(false);

    const status = strip(
      renderStatus({ home, claudeDir: path.join(home, "no-claude"), source: "claude" }),
    );
    expect(status).toContain("suggested subagents: 2 roles, ready, generated 2026-11-21");
    // The subagents directory is not mistaken for a broken library entry.
    expect(readLibraryIssues(home)).toEqual([]);
    expect(status).not.toContain("unreadable librar");
  });

  it("runs ten generalize windows at a time by default and saves the same result in a stable order", async () => {
    // Reference: one window at a time.
    const sequentialHome = libraryHome();
    const sequential = await run(
      sequentialHome,
      { yes: true, "window-size": "1", concurrency: "1" },
      { runner: fakeRunner().runner },
    );
    expect(sequential.code).toBe(0);

    // Default concurrency: hold generalize calls until ten are in flight (or no
    // more can start), then answer them newest first, so completion order is
    // the reverse of start order. No timers are involved.
    const total = 14;
    const fake = fakeRunner();
    let inFlight = 0;
    let maxInFlight = 0;
    let started = 0;
    let waiting: (() => void)[] = [];
    const release = () => {
      const batch = waiting.reverse();
      waiting = [];
      for (const go of batch) go();
    };
    const runner = (async (opts: RunClaudeOptions<unknown>) => {
      if (stageOf(opts.prompt) !== "generalize") return fake.runner(opts);
      started++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (waiting.length === 10 || started === total) release();
      });
      inFlight--;
      return fake.runner(opts);
    }) as RunnerFn;
    const home = libraryHome();
    const parallel = await run(home, { yes: true, "window-size": "1" }, { runner });
    expect(parallel.code).toBe(0);
    expect(fake.count("generalize")).toBe(total);
    expect(maxInFlight).toBe(10);

    const a = readSuggestion(sequentialHome)?.artifact as SuggestionArtifact;
    const b = readSuggestion(home)?.artifact as SuggestionArtifact;
    expect(b.lessons.map((l) => l.id)).toEqual(a.lessons.map((l) => l.id));
    expect(b.roles).toEqual(a.roles);
    expect(b.playbooks).toEqual(a.playbooks);
    expect(b.resolved).toEqual(a.resolved);
  });

  it("status says none yet, then stale once the reviewed set changes", async () => {
    const home = libraryHome();
    const status = () =>
      strip(renderStatus({ home, claudeDir: path.join(home, "no-claude"), source: "claude" }));
    expect(status()).toContain("suggested subagents: none yet");
    await run(home, { yes: true }, { runner: fakeRunner().runner });
    expect(status()).toContain("2 roles, ready, generated");
    const [first] = readObservedPreferences(home);
    if (!first) throw new Error("fixture");
    savePreferenceReview(home, first, { status: "dismissed" });
    expect(status()).toContain("suggested subagents: 2 roles, out of date since 2026-11-21");
  });

  it("one violation per stage gets exactly one corrective retry naming the rule", async () => {
    const home = libraryHome();
    const fake = fakeRunner({ generalize: 1, propose: 1, author: 1 });
    // "The second author call" is the retry only when roles run one at a time.
    const { code, text } = await run(
      home,
      { yes: true, concurrency: "1" },
      { runner: fake.runner },
    );
    expect(code).toBe(0);
    expect(fake.count("generalize")).toBe(2);
    expect(fake.count("propose")).toBe(2);
    expect(fake.count("merge")).toBe(0);
    expect(fake.count("author")).toBe(3);
    const second = (stage: Stage) => fake.calls.filter((c) => c.stage === stage)[1]?.prompt ?? "";
    expect(second("generalize")).toContain("Your previous response could not be used (G2 ");
    expect(second("generalize")).toContain('names "atlas-billing"');
    expect(second("propose")).toContain('(P5 role "evidence-checker" carries contextual lesson');
    expect(second("author")).toContain("(A1 prompt (10 characters)");
    // The rules go back to the model; the person sees only the outcome, with no
    // rule ids and no corrective details.
    expect(strip(text)).not.toMatch(/corrected|repaired|\b[GPA]\d\b/);
    expect(readSuggestion(home)?.artifact.roles.every((r) => r.prompt)).toBe(true);
  });

  it("checkpoints each accepted generalize window and a rerun reuses them without model calls", async () => {
    const home = libraryHome();
    const budget = String(twoWindowBudget(home));
    // Call 1 (window 1) is faulty, call 2 corrects it; calls 3 and 4 (window 2) are both faulty and stop the run.
    const first = fakeRunner({ generalize: [true, false, true, true] });
    const stopped = await run(
      home,
      { yes: true, "input-budget": budget, model: "gen-model", concurrency: "1" },
      { runner: first.runner },
    );
    expect(stopped.code).toBe(1);
    expect(first.count("generalize")).toBe(4);
    expect(first.count("propose")).toBe(0);
    const checkpointFile = path.join(
      path.dirname(suggestionPath(home)),
      GENERALIZE_CHECKPOINT_FILE,
    );
    expect(fs.existsSync(checkpointFile)).toBe(true);
    expect(Object.keys(readGeneralizeCheckpoints(home))).toHaveLength(1);
    const partial = JSON.parse(
      fs.readFileSync(
        path.join(path.dirname(suggestionPath(home)), SUGGESTION_PARTIAL_FILE),
        "utf8",
      ),
    );
    expect(partial.checkpointed_windows).toBe(1);
    // The hint is the exact command to rerun with the same selection.
    expect(partial.resume_hint).toMatch(/^npx human-hindsight suggest-subagents /);
    expect(partial.resume_hint).toContain(`--input-budget=${budget}`);
    expect(partial.resume_hint).toContain("--model=gen-model");

    // Same selection, same model: window 1 is reused, only window 2 is called.
    const second = fakeRunner();
    const resumed = await run(
      home,
      { yes: true, "input-budget": budget, model: "gen-model", concurrency: "1" },
      { runner: second.runner },
    );
    expect(resumed.code).toBe(0);
    expect(second.count("generalize")).toBe(1);
    // The plan says before consent that one window is reused, and the run confirms it.
    expect(flatText(resumed.text)).toContain(
      "1 call to summarize preferences (1 batch reused from saved work)",
    );
    expect(readSuggestion(home)?.artifact.roles).toHaveLength(2);
    // A saved suggestion clears the checkpoints.
    expect(fs.existsSync(checkpointFile)).toBe(false);
  });

  it.each([
    ["a different model", { model: "other-model" }],
    ["--fresh-generalize", { model: "gen-model", "fresh-generalize": true }],
  ] as [string, SuggestSubagentsArgs][])("%s ignores the checkpoints", async (_name, args) => {
    const home = libraryHome();
    const budget = String(twoWindowBudget(home));
    await run(
      home,
      { yes: true, "input-budget": budget, model: "gen-model", concurrency: "1" },
      { runner: fakeRunner({ generalize: [true, false, true, true] }).runner },
    );
    expect(Object.keys(readGeneralizeCheckpoints(home))).toHaveLength(1);
    const rerun = fakeRunner();
    await run(home, { yes: true, "input-budget": budget, ...args }, { runner: rerun.runner });
    expect(rerun.count("generalize")).toBe(2);
  });

  it("ignores a checkpoint whose saved result no longer passes the checks for its window", async () => {
    const home = libraryHome();
    const budget = String(twoWindowBudget(home));
    await run(
      home,
      { yes: true, "input-budget": budget, model: "gen-model", concurrency: "1" },
      { runner: fakeRunner({ generalize: [true, false, true, true] }).runner },
    );
    const file = path.join(path.dirname(suggestionPath(home)), GENERALIZE_CHECKPOINT_FILE);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    const key = Object.keys(saved.windows)[0];
    if (!key) throw new Error("expected one checkpointed window");
    // Corrupt the saved window: drop one source id so G1 fails on reuse.
    saved.windows[key].result.lessons[0].source_ids = [];
    fs.writeFileSync(file, JSON.stringify(saved));
    // The failed run also saved its finished window in an incomplete set of
    // working agreements; remove that copy so only the damaged checkpoint is left.
    fs.rmSync(path.join(home, "library", "preferences.generalized.json"));
    const rerun = fakeRunner();
    const { code } = await run(
      home,
      { yes: true, "input-budget": budget, model: "gen-model", concurrency: "1" },
      { runner: rerun.runner },
    );
    expect(code).toBe(0);
    expect(rerun.count("generalize")).toBe(2);
  });

  it("a proposal that leaves a portable lesson out of every role is repaired, not retried", async () => {
    const home = libraryHome();
    const fake = fakeRunner({ omit: true });
    const { code, text } = await run(home, { yes: true }, { runner: fake.runner });
    expect(code).toBe(0);
    expect(fake.count("propose")).toBe(1);
    const out = strip(text);
    expect(out).toContain(
      `1 preference fit no role, so it is kept in the ${UNPLACED_PLAYBOOK} notes; review it in the exported files.`,
    );
    expect(out).not.toContain("propose: accepted after one correction");
    const artifact = readSuggestion(home)?.artifact as SuggestionArtifact;
    const filed = artifact.playbooks.find((p) => p.name === UNPLACED_PLAYBOOK);
    expect(filed?.lesson_ids).toHaveLength(1);
    // the saved artifact still satisfies every SA rule, including P4's twin SA6
    expect(artifact.coverage.mapped).toBe(12);
  });

  it("a second violation at propose writes the partial record and keeps suggestion.json", async () => {
    const home = libraryHome();
    const file = writeSuggestion(home, sample());
    const before = fs.readFileSync(file, "utf8");
    const fake = fakeRunner({ propose: 2 });
    const { code, text } = await run(home, { yes: true }, { runner: fake.runner });
    expect(code).toBe(1);
    expect(fake.count("propose")).toBe(2);
    expect(fake.count("author")).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    const partialFile = path.join(path.dirname(file), SUGGESTION_PARTIAL_FILE);
    const partial = JSON.parse(fs.readFileSync(partialFile, "utf8"));
    expect(partial.stage).toBe("propose");
    expect(partial.problems[0]).toMatch(/^P5 /);
    expect(partial.raw_output.roles[0].name).toBe("evidence-checker");
    expect(partial.lessons).toHaveLength(12);
    expect(fs.statSync(partialFile).mode & 0o777).toBe(0o600);
    // Meaning: the failed stage is named, the partial record is named, and the
    // earlier suggestion is still the saved one (its bytes are checked above).
    expect(strip(text)).toContain(
      "choosing roles failed: the answer failed its checks twice: it put a project-specific lesson in a role",
    );
    expect(strip(text)).not.toMatch(/\bP5\b/);
    expect(text).toContain(partialFile);
    expect(text).toMatch(
      new RegExp(`previous suggestion is still at ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
  });

  it("a second violation at author keeps that role without a prompt and succeeds", async () => {
    const home = libraryHome();
    const fake = fakeRunner({ author: 2 });
    // Faults go to the first two calls in order: both attempts of the first role.
    const { code, text } = await run(
      home,
      { yes: true, concurrency: "1" },
      { runner: fake.runner },
    );
    expect(code).toBe(0);
    expect(fake.count("author")).toBe(3);
    const roles = readSuggestion(home)?.artifact.roles ?? [];
    expect(roles[0]?.prompt).toBeUndefined();
    expect(roles[0]?.triggers).toBeUndefined();
    expect(roles[1]?.prompt).toBeDefined();
    const out = strip(text);
    // Meaning: the role is named as kept without a prompt, and the next step
    // is the author-only rerun.
    expect(out).toMatch(/evidence-checker: .*Kept without a written prompt\./);
    // The command is alone on its own line.
    expect(out).toMatch(/\n {2}npx human-hindsight suggest-subagents .*--author-only\n/);
  });
});

describe("suggest-subagents reuses the working agreements distill saved", () => {
  /** What distill does at its end: generalize every non-dismissed candidate. */
  async function distillAgreements(home: string, budget?: string) {
    const fake = fakeRunner();
    const plan = planGeneralize({
      home,
      budget: budget ? Number(budget) : 400_000,
      selection: "all-candidates",
      identityRunner: "kiro",
    });
    if (!plan) throw new Error("expected a plan");
    const result = await runGeneralizeStage({
      home,
      plan,
      runner: fake.runner,
      concurrency: 10,
      output: capture().out,
      now: () => NOW,
    });
    expect(result.status).toBe("done");
    return fake.count("generalize");
  }

  it.each([
    ["nothing is accepted", "none"],
    ["every candidate is accepted", "all"],
  ] as const)("makes no generalize call when %s", async (_name, accept) => {
    const home = libraryHome(accept);
    const budget = String(twoWindowBudget(home));
    expect(await distillAgreements(home, budget)).toBe(2);
    const fake = fakeRunner();
    const { code, text } = await run(
      home,
      { yes: true, "input-budget": budget },
      { runner: fake.runner },
    );
    expect(code).toBe(0);
    expect(fake.count("generalize")).toBe(0);
    expect(flatText(text)).toContain("The preference summaries are reused from saved work.");
    expect(flatText(text)).not.toContain("you accepted, of");
  });

  it("says how many windows are new when acceptance narrows the set", async () => {
    const home = libraryHome(["p01", "p02", "p03"]);
    await distillAgreements(home);
    const fake = fakeRunner();
    const { code, text } = await run(home, { "dry-run": true }, { runner: fake.runner });
    expect(code).toBe(0);
    const out = strip(text);
    expect(flatText(out)).toContain("3 working preferences you accepted, of 14 observed.");
    expect(flatText(out)).toContain("1 call to summarize preferences, 1 call to choose roles");
  });
});

describe("suggest-subagents --author-only", () => {
  it("authors only the saved roles without a prompt and keeps everything else byte for byte", async () => {
    const home = libraryHome();
    await run(
      home,
      { yes: true, model: "gen-model", concurrency: "1" },
      { runner: fakeRunner({ author: 2 }).runner },
    );
    const before = readSuggestion(home)?.artifact as SuggestionArtifact;
    expect(before.roles.filter((r) => !r.prompt).map((r) => r.name)).toEqual(["evidence-checker"]);

    const fake = fakeRunner();
    const { code, text } = await run(
      home,
      { yes: true, "author-only": true, "author-model": "writing-model" },
      { runner: fake.runner },
    );
    expect(code).toBe(0);
    expect(fake.count("author")).toBe(1);
    expect(fake.count("generalize")).toBe(0);
    expect(fake.count("propose")).toBe(0);
    const out = strip(text);
    expect(flatText(out)).toContain("1 of 2 needs a written prompt (evidence-checker).");
    expect(flatText(out)).toContain("1 call to write a role prompt.");
    // The untouched role is proven byte for byte below; the screen names only the bare one.
    expect(out).toContain("Wrote 1 of 1 role prompt.");

    const after = readSuggestion(home)?.artifact as SuggestionArtifact;
    expect(after.roles.every((r) => r.prompt && r.triggers?.length)).toBe(true);
    expect(after.roles[1]).toEqual(before.roles[1]);
    // Attribution is per result: the new prompt names writing-model, the kept one
    // its original model, and no single author model is claimed for a mixed set.
    const authorOf = (name: string) =>
      after.resolved?.find((r) => r.stage === "author" && r.unit === name)?.model;
    expect(authorOf("evidence-checker")).toBe("writing-model");
    expect(authorOf("change-runner")).toBe("gen-model");
    expect(after.models.author).toBeUndefined();
    expect(after.resolved?.filter((r) => r.stage !== "author")).toEqual(
      before.resolved?.filter((r) => r.stage !== "author"),
    );
    expect(after.prompt_versions.author).toBe(SUGGEST_PROMPT_VERSIONS.author);
    // Nothing but the bare role, the stamp and the author metadata changed.
    const strip2 = (a: SuggestionArtifact) => {
      const {
        generated_at: _g,
        models: _m,
        prompt_versions: _p,
        roles: _r,
        runner: _u,
        resolved: _s,
        ...rest
      } = a;
      return rest;
    };
    expect(strip2(after)).toEqual(strip2(before));
    expect(after.coverage).toEqual(before.coverage);
  });

  it("--author-only with nothing bare exits 0 without calls, and without a saved suggestion exits 1", async () => {
    const home = libraryHome();
    const missing = await run(home, { yes: true, "author-only": true });
    expect(missing.code).toBe(1);
    expect(missing.text).toContain("No saved suggestion to write role prompts for");
    await run(home, { yes: true }, { runner: fakeRunner().runner });
    const fake = fakeRunner();
    const full = await run(home, { yes: true, "author-only": true }, { runner: fake.runner });
    expect(full.code).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(full.text).toContain("Every role in the saved suggestion already has a prompt.");
  });

  it("--author-only saving a finished proposal while another command writes says so and changes nothing", async () => {
    const home = libraryHome();
    await run(home, { yes: true }, { runner: fakeRunner().runner });
    const saved = readSuggestion(home)?.artifact as SuggestionArtifact;
    saveAuthorProgress(home, savedSuggestionKey(home), saved);
    const before = fs.readFileSync(suggestionPath(home), "utf8");
    const lock = acquireWriterLock(home, "distill");
    try {
      const busy = await run(home, { yes: true, "author-only": true });
      expect(busy.code).toBe(1);
      expect(strip(busy.text)).toContain("npx human-hindsight reflect is changing this library");
      expect(fs.readFileSync(suggestionPath(home), "utf8")).toBe(before);
    } finally {
      lock.release();
    }
  });
});

describe("suggest-subagents shows short lesson aliases to the propose stage", () => {
  it("the propose prompt lists L1, L2, ... and the saved roles name the real lesson ids", async () => {
    const home = libraryHome();
    const fake = fakeRunner();
    const { code } = await run(home, { yes: true }, { runner: fake.runner });
    expect(code).toBe(0);
    const propose = fake.calls.find((call) => call.stage === "propose")?.prompt ?? "";
    const shown = block(propose, "=== LESSONS (", "=== END LESSONS ===").map(
      (line) => (JSON.parse(line) as { id: string }).id,
    );
    expect(shown).toEqual(shown.map((_id, index) => `L${index + 1}`));
    const saved = readSuggestion(home)?.artifact as SuggestionArtifact;
    const real = new Set(saved.lessons.map((lesson) => lesson.id));
    for (const id of real) expect(propose).not.toContain(`"${id}"`);
    const placed = [
      ...saved.roles.flatMap((r) => r.lesson_ids),
      ...saved.playbooks.flatMap((p) => p.lesson_ids),
      ...saved.shared,
    ];
    expect(placed.length).toBeGreaterThan(0);
    for (const id of placed) expect(real.has(id)).toBe(true);
  });
});

describe("suggest-subagents keeps an interrupted, paid role proposal", () => {
  it("a failed fresh run records its failure beside it, and --author-only still finishes it", async () => {
    const home = libraryHome();
    // An earlier run was interrupted while writing role prompts: its generalize
    // and propose calls are paid for and saved as author progress.
    const baseKey = savedSuggestionKey(home);
    saveAuthorProgress(home, baseKey, sample());
    const proposal = pendingAuthorProposal(home, baseKey);
    expect(proposal).not.toBeNull();

    // The person runs suggest-subagents again (not --author-only); the CLI fails.
    const failed = await run(
      home,
      { yes: true },
      {
        runner: (async () => {
          throw new Error("synthetic outage");
        }) as RunnerFn,
      },
    );
    expect(failed.code).toBe(1);
    expect(pendingAuthorProposal(home, baseKey)).toEqual(proposal);
    const dir = path.dirname(suggestionPath(home));
    const failure = JSON.parse(fs.readFileSync(path.join(dir, SUGGESTION_FAILURE_FILE), "utf8"));
    expect(failure.stage).toMatch(/^generalize/);
    const out = strip(failed.text);
    expect(out).toContain(
      `Saved the problems and the results so far in ${path.join(dir, SUGGESTION_FAILURE_FILE)}.`,
    );
    expect(out).toContain("The interrupted role proposal from an earlier run is kept.");
    expect(out).toContain("--author-only");

    // `--author-only` finishes the earlier proposal with one call per bare role.
    const fake = fakeRunner();
    const resumed = await run(home, { yes: true, "author-only": true }, { runner: fake.runner });
    expect(resumed.text).toContain(
      `Resuming the interrupted proposal of ${proposal?.roles.length} roles.`,
    );
    expect(fake.count("generalize")).toBe(0);
    expect(fake.count("propose")).toBe(0);
  });

  it("without an interrupted proposal, the failure record goes to suggestion.partial.json as before", async () => {
    const home = libraryHome();
    const failed = await run(
      home,
      { yes: true },
      {
        runner: (async () => {
          throw new Error("synthetic outage");
        }) as RunnerFn,
      },
    );
    expect(failed.code).toBe(1);
    const dir = path.dirname(suggestionPath(home));
    expect(fs.existsSync(path.join(dir, SUGGESTION_PARTIAL_FILE))).toBe(true);
    expect(fs.existsSync(path.join(dir, SUGGESTION_FAILURE_FILE))).toBe(false);
    expect(strip(failed.text)).not.toContain("interrupted role proposal");
  });
});

describe("suggest-subagents --export", () => {
  // One generated suggestion, copied into a fresh library home per test.
  let suggestion = "";
  beforeAll(async () => {
    const home = libraryHome();
    const result = await run(home, { yes: true }, { runner: fakeRunner().runner });
    expect(result.code).toBe(0);
    suggestion = fs.readFileSync(suggestionPath(home), "utf8");
  });
  async function generated(): Promise<string> {
    const home = libraryHome();
    fs.mkdirSync(path.dirname(suggestionPath(home)), { recursive: true });
    fs.writeFileSync(suggestionPath(home), suggestion);
    return home;
  }

  it("writes the rendered tree, keeps existing files, and overwrites them with --force", async () => {
    const home = await generated();
    const dir = path.join(tmpDir(), "agents");
    const expected = renderSubagentTree(readSuggestion(home)?.artifact as SuggestionArtifact, {
      target: "all",
    });
    const first = await run(home, { export: dir });
    expect(first.code).toBe(0);
    expect(strip(first.text)).toContain(
      `wrote ${expected.size} of ${expected.size} files to ${dir}`,
    );
    expect(first.text).not.toContain("stale");
    expect(first.text).not.toContain("warning:");
    for (const [file, content] of expected)
      expect(fs.readFileSync(path.join(dir, file), "utf8")).toBe(content);

    fs.writeFileSync(path.join(dir, "README.md"), "my edits\n");
    const again = await run(home, { export: dir });
    expect(strip(again.text)).toContain(`wrote 0 of ${expected.size} files`);
    expect(again.text).toContain(`kept ${expected.size} existing files`);
    expect(again.text).toContain("--force");
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toBe("my edits\n");

    const forced = await run(home, { export: dir, force: true });
    expect(strip(forced.text)).toContain(`wrote ${expected.size} of ${expected.size} files`);
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toBe(expected.get("README.md"));
  });

  it("limits the tree to one target and pins the model", async () => {
    const home = await generated();
    const dir = path.join(tmpDir(), "crew");
    const { code } = await run(home, { export: dir, target: "kirocrew", "pin-model": "big-model" });
    expect(code).toBe(0);
    const tops = new Set(listing(dir).map((file) => file.split(path.sep)[0]));
    expect([...tops].sort()).toEqual(["HANDOFF.md", "README.md", "kirocrew", "knowledge"]);
    expect(fs.readFileSync(path.join(dir, "kirocrew", "create-bots.sh"), "utf8")).toContain(
      "--model 'big-model'",
    );
    const bad = await run(home, { export: dir, target: "vscode" });
    expect(bad.code).toBe(1);
    expect(bad.text).toContain('unknown --target "vscode"');
  });

  it("warns, without refusing, when the folder is inside a harness root", async () => {
    const home = await generated();
    const userHome = tmpDir();
    const dir = path.join(userHome, ".claude", "hindsight-agents");
    const { code, text } = await run(home, { export: dir }, { userHome });
    expect(code).toBe(0);
    expect(text).toContain(`warning: ${dir} is inside ${path.join(userHome, ".claude")}`);
    expect(fs.existsSync(path.join(dir, "HANDOFF.md"))).toBe(true);
  });

  it("warns that a stale suggestion is stale and still exports it", async () => {
    const home = await generated();
    const [first] = readObservedPreferences(home);
    if (!first) throw new Error("fixture");
    savePreferenceReview(home, first, { status: "dismissed" });
    const dir = path.join(tmpDir(), "agents");
    const { code, text } = await run(home, { export: dir });
    expect(code).toBe(0);
    expect(text).toContain("warning: the saved suggestion is stale");
    expect(fs.existsSync(path.join(dir, "README.md"))).toBe(true);
  });

  it("exits 1 with the command to run when no suggestion is saved", async () => {
    const home = tmpDir();
    const dir = path.join(tmpDir(), "agents");
    const { code, text } = await run(home, { export: dir });
    expect(code).toBe(1);
    expect(text).toContain(`No saved suggestion at ${suggestionPath(home)}`);
    expect(text).toContain("npx human-hindsight suggest-subagents");
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("exits 1 and names the reason when the saved suggestion is damaged", async () => {
    const home = tmpDir();
    fs.mkdirSync(path.dirname(suggestionPath(home)), { recursive: true });
    fs.writeFileSync(suggestionPath(home), "{not json");
    const { code, text } = await run(home, { export: path.join(tmpDir(), "agents") });
    expect(code).toBe(1);
    expect(text).toContain("the file is not valid JSON");
  });
});

describe("suggest-subagents at a terminal", () => {
  /** A fake terminal that answers each prompt it sees with the next key. */
  function terminal(keys: [seen: string, key: string | "SIGINT"][]) {
    const host = new EventEmitter() as TerminalHost & EventEmitter;
    Object.assign(host, { pid: 4242, kill: () => true });
    const input = fakeInput();
    const output = fakeOutput({ columns: 80, rows: 50 });
    const original = output.write.bind(output);
    let seen = "";
    output.write = ((chunk: unknown, ...rest: unknown[]) => {
      seen += String(chunk);
      const next = keys[0];
      if (next && stripVTControlCharacters(seen).includes(next[0])) {
        keys.shift();
        seen = "";
        setImmediate(() => (next[1] === "SIGINT" ? host.emit("SIGINT") : input.push(next[1])));
      }
      return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof output.write;
    return { host, input, output, keys };
  }

  async function runAt(
    home: string,
    keys: [string, string][],
    args: SuggestSubagentsArgs = {},
    runNext = vi.fn(async () => 0),
  ) {
    vi.stubEnv("CI", "");
    vi.stubEnv("TERM", "xterm-256color");
    vi.stubEnv("HUMAN_HINDSIGHT_PLAIN", "");
    const t = terminal(keys);
    const fake = fakeRunner();
    const code = await runSuggestSubagents(
      { home, ...args },
      {
        runner: fake.runner,
        runnerName: "kiro",
        input: t.input,
        output: t.output,
        host: t.host,
        exit: () => {},
        now: () => NOW,
        userHome: tmpDir(),
        runNext,
      },
    );
    return { code, text: t.output.text(), fake, runNext, remaining: t.keys };
  }

  it("Ctrl-C at the Start question exits 130 after one line and sends nothing", async () => {
    const home = libraryHome();
    const result = await runAt(home, [["Start?", "SIGINT"]]);
    expect(result.code).toBe(130);
    expect(result.fake.calls).toEqual([]);
    expect(result.text.match(/Interrupted/g)).toHaveLength(1);
    expect(result.text).not.toMatch(/Declined|Model plan/);
  });

  it("asks one question only: the plan's Start menu, never a separate model menu", async () => {
    const home = libraryHome();
    const result = await runAt(home, [["Start?", "q"]]);
    expect(result.code).toBe(2);
    expect(result.text).toContain("Declined. Nothing was sent.");
    expect(result.text).not.toContain("Model plan");
    expect(result.fake.calls).toEqual([]);
  });

  it.each([
    { key: "1", opened: true, code: 0 },
    { key: "3", opened: false, code: 0 },
    { key: "SIGINT", opened: false, code: 130 },
  ])("ends with a closing menu, and opens the Subagents view only when chosen (key $key)", async ({
    key,
    opened,
    code,
  }) => {
    const home = libraryHome();
    const result = await runAt(home, [
      ["Start?", "s"],
      ["What next?", key],
    ]);
    expect(result.remaining).toEqual([]);
    expect(result.code).toBe(code);
    expect(result.text).toContain("Open my subagents");
    expect(result.text).toContain("Export them as files");
    expect(result.runNext).toHaveBeenCalledTimes(opened ? 1 : 0);
    if (opened) expect(result.runNext).toHaveBeenCalledWith("gui", { home, tab: "subagents" });
    expect(readSuggestion(home)?.artifact.roles).toHaveLength(2);
  });

  it("exports to the folder typed at the closing menu", async () => {
    const home = libraryHome();
    const dir = path.join(tmpDir(), "agents");
    const result = await runAt(home, [
      ["Start?", "s"],
      ["What next?", "2"],
      ["Folder to write them to", `${dir}\n`],
    ]);
    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(dir, "HANDOFF.md"))).toBe(true);
    expect(result.runNext).not.toHaveBeenCalled();
  });

  it("with --no-follow-up there is no menu: the two next commands", async () => {
    const home = libraryHome();
    const result = await runAt(home, [["Start?", "s"]], { "follow-up": false });
    expect(result.code).toBe(0);
    expect(result.text).not.toContain("What next?");
    expect(result.text).toContain("--tab=subagents");
    expect(result.text).toContain("--export human-hindsight-subagents");
    expect(result.runNext).not.toHaveBeenCalled();
  });
});

describe("suggest-subagents checks the CLI only before its first call", () => {
  /** A Claude Code that answers every stage; signed out, it fails its check. */
  function claudeCli(signedOut = true) {
    const fake = fakeRunner();
    const checks: string[] = [];
    const cli: AgentRunner = {
      name: "claude",
      installHint: "",
      listModels: async () => ({ ids: ["sonnet", "opus", "fable"], source: "aliases" }),
      version: async () => "9.9.9",
      run: async <T>(opts: RunOptions<T>) => {
        if (opts.prompt.includes('{"ok":true}')) {
          checks.push(String(opts.model));
          if (signedOut) throw Object.assign(new Error("Not signed in."), { kind: "sign-in" });
          return { ok: true } as T;
        }
        return fake.runner(opts as never) as Promise<T>;
      },
    };
    return { cli, fake, checks };
  }
  const signedOutClaude = () => claudeCli(true);

  it("with every batch reused, the check waits until roles are chosen, and a failed one stops cleanly", async () => {
    const home = libraryHome();
    // An earlier run summarized these preferences with the same plan.
    const ready = claudeCli(false);
    const deps = () => ({ output: capture().out, now: () => NOW, userHome: tmpDir() });
    expect(
      await runSuggestSubagents({ home, yes: true }, { ...deps(), runners: [ready.cli] }),
    ).toBe(0);
    const { cli, fake, checks } = signedOutClaude();
    const cap = capture();
    const code = await runSuggestSubagents(
      { home, yes: true },
      { runners: [cli], output: cap.out, now: () => NOW, userHome: tmpDir() },
    );
    expect(flatText(cap.text())).toContain(
      "Balanced (selected): sonnet for preference summaries, opus for choosing and writing roles. Summaries reused from saved work.",
    );
    expect(code).toBe(1);
    expect(checks.length).toBeGreaterThan(0);
    expect(fake.calls).toEqual([]);
    // The reused summaries came first; the check ran just before choosing roles.
    const text = cap.text();
    expect(text.indexOf("Summarizing preferences  1/1")).toBeGreaterThan(-1);
    expect(text.indexOf("Summarizing preferences  1/1")).toBeLessThan(
      text.indexOf("Checking that Claude Code is ready."),
    );
    const lines = cap.text().split("\n");
    expect(lines.filter((line) => line.includes("is not signed in"))).toEqual([
      "Claude Code is not signed in. No other coding CLI is ready on this machine.",
    ]);
    expect(lines).toContain("Run: claude auth login");
    // A CLI that is not ready is not a failed stage: no failure record is written.
    expect(
      fs.existsSync(path.join(path.dirname(suggestionPath(home)), SUGGESTION_PARTIAL_FILE)),
    ).toBe(false);
  });

  it("--dry-run never checks", async () => {
    const home = libraryHome();
    const { cli, checks } = signedOutClaude();
    const cap = capture();
    const code = await runSuggestSubagents(
      { home, "dry-run": true },
      { runners: [cli], output: cap.out, now: () => NOW, userHome: tmpDir() },
    );
    expect(code).toBe(0);
    expect(checks).toEqual([]);
  });
});
