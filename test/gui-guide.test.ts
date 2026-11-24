import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  currentGeneralizeInputs,
  GENERALIZED_PATH,
  type GeneralizedArtifact,
  generalizedInputsHash,
  writeGeneralized,
} from "../src/core/generalized.js";
import { OUTCOME_NOT_VERIFIED } from "../src/core/library.js";
import { savePreferenceReview } from "../src/core/preference-review.js";
import { preferenceId, readObservedPreferences } from "../src/core/preferences.js";
import { suggestionPath } from "../src/core/subagents.js";
import { GENERALIZE_PROMPT_VERSION } from "../src/distill/prompts/generalize.js";
import type { GuiHighlights } from "../src/gui/highlights.js";
import { landingTab } from "../src/gui/landing.js";
import { OUTCOME_NOT_VERIFIED_LABEL, promptsGuideSentence } from "../src/gui/overview.js";
import { latestReflection } from "../src/gui/reflection.js";
import type { GuiAgreements, GuiSnapshot, GuiSubagents } from "../src/gui/server.js";
import { getJson, guiHarness } from "./gui-harness.js";
import { type BuiltHome, homeBuilder, sampleHome } from "./support/home.js";

/**
 * What the guided overviews are built from: the highlights route, the saved
 * working agreements route, the empty-library command, and the rule for the
 * tab a first visit opens on.
 */

const homes: BuiltHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.remove();
});
function sample(): BuiltHome {
  const home = sampleHome().build();
  homes.push(home);
  return home;
}

/**
 * Save one agreement over every current candidate, fresh for the home as it is
 * now. With `incomplete`, the set records that more preferences were left for a
 * later run, as a run with failed batches does.
 */
function saveAgreements(
  home: string,
  incomplete?: GeneralizedArtifact["incomplete"],
): GeneralizedArtifact {
  const { inputs, projects } = currentGeneralizeInputs(home, "all-candidates");
  const ids = inputs.map((input) => input.id);
  const draft = {
    title: "Keep changes small and reviewable",
    instruction: "Keep each change small and focused so that it is easy to review and test.",
    applies_when: "Any code change.",
    exceptions: "",
    disposition: "generalized" as const,
    source_ids: ids,
  };
  const artifact: GeneralizedArtifact = {
    version: 1,
    generated_at: "2026-01-02T03:04:05.000Z",
    prompt_version: GENERALIZE_PROMPT_VERSION,
    inputs_hash: generalizedInputsHash(inputs, projects),
    selection: "all-candidates",
    model: "synthetic-model",
    windows: { ["a".repeat(64)]: { input_ids: ids, result: { lessons: [draft], set_aside: [] } } },
    lessons: [{ id: "keep-changes-small-and-reviewable", ...draft }],
    set_aside: [],
    ...(incomplete ? { incomplete } : {}),
  };
  writeGeneralized(home, artifact);
  return artifact;
}

/** Put the home's saved working agreements in one of the states the page shows. */
const AGREEMENT_STATES = {
  none: () => {},
  ready: (home: BuiltHome) => void saveAgreements(home.dir),
  incomplete: (home: BuiltHome) =>
    void saveAgreements(home.dir, { windows_failed: 1, candidates_not_covered: 14 }),
  stale: (home: BuiltHome) => {
    saveAgreements(home.dir);
    const first = readObservedPreferences(home.dir)[0];
    if (!first) throw new Error("The sample home has candidates.");
    savePreferenceReview(home.dir, first, { status: "dismissed" });
  },
  "damaged: not JSON": (home: BuiltHome) =>
    fs.writeFileSync(home.path(GENERALIZED_PATH), "{ this is not json"),
  "damaged: the wrong shape": (home: BuiltHome) =>
    fs.writeFileSync(home.path(GENERALIZED_PATH), JSON.stringify({ version: 1, lessons: "none" })),
} satisfies Record<string, (home: BuiltHome) => void>;

describe("saved working agreements, through the agreements and highlights routes", () => {
  it.each([
    // [state, route answer, highlight count, highlights marked stale]
    ["none", { state: "none", generatedAt: null, stale: false, incomplete: null }, 0, false],
    [
      "ready",
      { state: "ready", generatedAt: "2026-01-02T03:04:05.000Z", stale: false, incomplete: null },
      1,
      false,
    ],
    [
      "stale",
      { state: "ready", generatedAt: "2026-01-02T03:04:05.000Z", stale: true, incomplete: null },
      1,
      true,
    ],
    // Part of the work is done: the agreements that exist still show, with the gap.
    [
      "incomplete",
      {
        state: "ready",
        generatedAt: "2026-01-02T03:04:05.000Z",
        stale: false,
        incomplete: { summarized: 2, total: 16, windowsFailed: 1 },
      },
      1,
      false,
    ],
    [
      "damaged: not JSON",
      { state: "damaged", generatedAt: null, stale: false, incomplete: null },
      0,
      false,
    ],
    [
      "damaged: the wrong shape",
      { state: "damaged", generatedAt: null, stale: false, incomplete: null },
      0,
      false,
    ],
  ] as const)("%s", async (state, expected, count, stale) => {
    const home = sample();
    AGREEMENT_STATES[state](home);
    const before = fs.existsSync(home.path(GENERALIZED_PATH))
      ? fs.readFileSync(home.path(GENERALIZED_PATH), "utf8")
      : null;
    const gui = guiHarness(home.dir);
    const agreements = await getJson<GuiAgreements>(gui, "/api/preferences/generalized");
    expect(agreements).toEqual({
      ...expected,
      lessons: count ? [expect.objectContaining({ id: "keep-changes-small-and-reviewable" })] : [],
      // Where the page groups each agreement and how well it is supported.
      facts: count
        ? [
            {
              id: "keep-changes-small-and-reviewable",
              title: "Keep changes small and reviewable",
              kind: "general",
              group: expect.any(String),
              sessions: expect.any(Number),
              preferences: expect.any(Number),
            },
          ]
        : [],
      // The sample's two preferences, not its one agreement.
      preferenceCount: count ? 2 : 0,
    });
    // The highlights read the same saved set, so they agree with the route.
    const highlights = await getJson<GuiHighlights>(gui, "/api/highlights");
    expect(highlights.agreements.map((highlight) => highlight.id)).toEqual(
      agreements.lessons.map((lesson) => `agreement/${lesson.id}`),
    );
    expect(highlights.agreements.length).toBe(count);
    for (const highlight of highlights.agreements) expect(Boolean(highlight.stale)).toBe(stale);
    // No reason or path leaks, the library still loads, and the file is left alone.
    expect(JSON.stringify(agreements)).not.toContain(home.dir);
    await getJson<GuiSnapshot>(gui, "/api/library");
    expect(
      fs.existsSync(home.path(GENERALIZED_PATH))
        ? fs.readFileSync(home.path(GENERALIZED_PATH), "utf8")
        : null,
    ).toBe(before);
  });
});

describe("GET /api/highlights", () => {
  it("names items by ID with a reason, and carries no file path and no session text", async () => {
    const home = sample();
    saveAgreements(home.dir);
    const text = JSON.stringify(
      await getJson<GuiHighlights>(guiHarness(home.dir), "/api/highlights"),
    );
    expect(text).not.toContain(home.dir);
    expect(text).not.toContain(os.tmpdir());
    expect(text).not.toMatch(/(?:^|["\s])\/(?:Users|home|tmp|var|private)\//);
    expect(text).not.toMatch(/\.(?:md|json|jsonl)\b/);
    // Words that exist only in the synthetic sessions and their quotations.
    for (const phrase of [
      "keep the change small",
      "ship it",
      "flaky build step",
      "no marketing tone",
    ]) {
      expect(text.toLowerCase()).not.toContain(phrase);
    }
  });

  it("gives each highlight a reason computed from the data", async () => {
    const home = sample();
    saveAgreements(home.dir);
    const highlights = await getJson<GuiHighlights>(guiHarness(home.dir), "/api/highlights");
    expect(highlights.prompts.length).toBeGreaterThanOrEqual(2);
    for (const highlight of highlights.prompts)
      expect(highlight.reason).toMatch(/^(Liked · )?Based on \d+ sessions?$/);
    expect(highlights.agreements).toEqual([
      { id: "agreement/keep-changes-small-and-reviewable", reason: "Seen in 3 sessions" },
    ]);
    expect(highlights.subagents.length).toBeGreaterThanOrEqual(2);
    expect(highlights.subagents.length).toBeLessThanOrEqual(3);
    expect(highlights.subagents.every((highlight) => !highlight.stale)).toBe(true);
  });

  it("labels highlights from out-of-date agreements and an out-of-date suggestion as stale", async () => {
    const home = sample();
    saveAgreements(home.dir);
    const first = readObservedPreferences(home.dir)[0];
    if (!first) throw new Error("The sample home has candidates.");
    savePreferenceReview(home.dir, first, { status: "dismissed" });
    const gui = guiHarness(home.dir);
    const highlights = await getJson<GuiHighlights>(gui, "/api/highlights");
    expect((await getJson<GuiSubagents>(gui, "/api/subagents")).stale).toBe(true);
    expect(highlights.agreements.length).toBeGreaterThan(0);
    expect(highlights.agreements.every((highlight) => highlight.stale)).toBe(true);
    expect(highlights.subagents.length).toBeGreaterThan(0);
    expect(highlights.subagents.every((highlight) => highlight.stale)).toBe(true);
  });
});

describe("how the saved agreements are grouped and ranked", () => {
  it("puts a project agreement under its project and counts the preferences the set was made from", async () => {
    const home = sample();
    const artifact = saveAgreements(home.dir);
    const prefs = readObservedPreferences(home.dir);
    const projectPref = prefs.find((pref) => pref.scope === "project");
    if (!projectPref) throw new Error("The sample home has a project preference.");
    const projectId = preferenceId(projectPref);
    // Each preference feeds exactly one agreement: the general one keeps the
    // rest, and the project preference becomes a project agreement.
    const [general] = artifact.lessons;
    if (!general) throw new Error("The saved set has an agreement.");
    const lessons = [
      { ...general, source_ids: general.source_ids.filter((id) => id !== projectId) },
      {
        id: "plain-release-notes-for-beta",
        title: "Plain release notes for beta",
        instruction: "Write the beta release notes in plain words, without marketing tone.",
        applies_when: "",
        exceptions: "",
        disposition: "contextual" as const,
        source_ids: [projectId],
      },
    ];
    const window = Object.values(artifact.windows)[0];
    if (!window) throw new Error("The saved set has a window.");
    writeGeneralized(home.dir, {
      ...artifact,
      lessons,
      windows: {
        ["a".repeat(64)]: {
          ...window,
          result: { ...window.result, lessons: lessons.map(({ id: _id, ...draft }) => draft) },
        },
      },
    });
    const gui = guiHarness(home.dir);
    const agreements = await getJson<GuiAgreements>(gui, "/api/preferences/generalized");
    expect(agreements.state).toBe("ready");
    expect(agreements.preferenceCount).toBe(prefs.length);
    expect(agreements.facts.map(({ id, kind, group }) => [id, kind, group])).toEqual([
      ["keep-changes-small-and-reviewable", "general", expect.any(String)],
      ["plain-release-notes-for-beta", "project", "beta"],
    ]);
    // Only the general agreement is worth reading first.
    const highlights = await getJson<GuiHighlights>(gui, "/api/highlights");
    expect(highlights.agreements.map((highlight) => highlight.id)).toEqual([
      "agreement/keep-changes-small-and-reviewable",
    ]);
  });

  it("highlights the strongest support first and retains the saved review label", async () => {
    const home = sample();
    const highlights = await getJson<GuiHighlights>(guiHarness(home.dir), "/api/highlights");
    const prefs = new Map(
      readObservedPreferences(home.dir).map((pref) => [preferenceId(pref), pref]),
    );
    expect(
      highlights.candidates.map((highlight) => [prefs.get(highlight.id)?.text, highlight.reason]),
    ).toEqual([
      ["Keep changes small.", "Seen in 2 sessions · Accepted"],
      ["Write release notes in plain words.", "Seen in 1 session"],
    ]);
  });
});

/** Regroup the sample's sessions so one task disappears, as an upgrade does. */
function regroupWithout(home: BuiltHome, slug: string): void {
  const tasks = home.json<{ tasks: { slug: string }[] }>("distill/tasks.json");
  fs.writeFileSync(
    home.path("distill/tasks.json"),
    JSON.stringify({ ...tasks, tasks: tasks.tasks.filter((task) => task.slug !== slug) }),
  );
}

describe("prompts left behind by a regrouping", () => {
  it("marks each library entry as current or from an earlier grouping", async () => {
    const home = sample();
    const gui = guiHarness(home.dir);
    const before = await getJson<GuiSnapshot>(gui, "/api/library");
    expect(before.entries.map((entry) => [entry.slug, entry.earlier]).sort()).toEqual([
      ["fix-build-step", false],
      ["write-release-notes", false],
    ]);
    regroupWithout(home, "write-release-notes");
    const after = await getJson<GuiSnapshot>(gui, "/api/library");
    expect(after.entries.map((entry) => [entry.slug, entry.earlier]).sort()).toEqual([
      ["fix-build-step", false],
      ["write-release-notes", true],
    ]);
  });

  it("never highlights an earlier prompt", async () => {
    const home = sample();
    regroupWithout(home, "fix-build-step");
    const highlights = await getJson<GuiHighlights>(guiHarness(home.dir), "/api/highlights");
    expect(highlights.prompts.map((highlight) => highlight.id)).toEqual(["write-release-notes"]);
  });
});

describe("empty library", () => {
  it("offers the bare command, which starts the guided first run", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-gui-empty-"));
    try {
      const snapshot = await getJson<GuiSnapshot>(guiHarness(dir), "/api/library");
      expect(snapshot.entries).toEqual([]);
      expect(snapshot.commands.start).toBe(`npx human-hindsight@latest --home '${dir}'`);
      // What a tab whose key was refused shows: it reopens this same library.
      expect(snapshot.commands.gui).toBe(`npx human-hindsight@latest gui --home '${dir}'`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the tab a first visit opens on", () => {
  it.each([
    ["no route and a saved suggestion", "", true, "subagents"],
    ["no route and no suggestion", "", false, "prompts"],
    ["#preferences with a suggestion", "preferences", true, null],
    ["#preferences without a suggestion", "preferences", false, null],
    ["a prompt bookmark", "prompts/some-task", true, null],
  ] as const)("%s", (_label, route, saved, tab) => {
    expect(landingTab(route, { preferences: false, saved })).toBe(tab);
    expect(landingTab(route, { preferences: true, saved })).toBe(route ? null : "preferences");
  });

  it("counts a stale suggestion as saved and an unreadable one as missing", async () => {
    const home = sample();
    const first = readObservedPreferences(home.dir)[0];
    if (!first) throw new Error("The sample home has candidates.");
    savePreferenceReview(home.dir, first, { status: "dismissed" });
    const gui = guiHarness(home.dir);
    const stale = await getJson<GuiSubagents>(gui, "/api/subagents");
    expect(stale.stale).toBe(true);
    expect(landingTab("", { preferences: false, saved: Boolean(stale.suggestion) })).toBe(
      "subagents",
    );
    fs.writeFileSync(suggestionPath(home.dir), "{ damaged");
    const damaged = await getJson<GuiSubagents>(gui, "/api/subagents");
    expect(damaged.error).toBeTruthy();
    expect(landingTab("", { preferences: false, saved: Boolean(damaged.suggestion) })).toBe(
      "prompts",
    );
  });

  it("an empty home has no suggestion, so it opens on Prompts", async () => {
    const home = homeBuilder().build();
    homes.push(home);
    const data = await getJson<GuiSubagents>(guiHarness(home.dir), "/api/subagents");
    expect(landingTab("", { preferences: false, saved: Boolean(data.suggestion) })).toBe("prompts");
  });
});

describe("the reflection read from saved observations", () => {
  it("uses current human wording in scoped copy and keeps the cited observation intact", async () => {
    const home = sample();
    const original = readObservedPreferences(home.dir).find((pref) => pref.scope === "project");
    if (!original) throw new Error("The sample has a project preference.");
    savePreferenceReview(home.dir, original, {
      status: "accepted",
      text: "Keep beta release notes factual.",
      scope: "project",
      project: "beta",
    });
    const { preferences } = await getJson<GuiSnapshot>(guiHarness(home.dir), "/api/library");
    const project = preferences.find((pref) => pref.id === preferenceId(original));
    if (!project) throw new Error("The observation is still available.");
    const reading = latestReflection([project], [], new Map());
    expect(reading?.observation).toContain("Write release notes in plain words.");
    expect(reading?.markdown).toBe("- Keep beta release notes factual.\n  Scope: For beta");
    expect(reading?.sources.map((source) => source.quote)).toEqual([
      "plain words, no marketing tone",
    ]);
    const dismissed = { ...project, review: { ...project.review, status: "dismissed" as const } };
    expect(latestReflection([dismissed], [], new Map())).toBeUndefined();
  });

  it("features reusable observations first and keeps a one-time permission scoped when it stands alone", async () => {
    const home = sample();
    const { preferences } = await getJson<GuiSnapshot>(guiHarness(home.dir), "/api/library");
    const [first, second] = preferences;
    if (!first || !second) throw new Error("The sample has two preferences.");
    const [saved] = saveAgreements(home.dir).lessons;
    if (!saved) throw new Error("The sample has a generated preference.");
    const historical = {
      ...saved,
      disposition: "historical" as const,
      source_ids: [first.id],
    };
    expect(latestReflection([first, second], [historical], new Map())?.preference.id).toBe(
      second.id,
    );
    const onlyNote = latestReflection([first], [historical], new Map());
    expect(onlyNote?.markdown).toContain("Scope: One-time note");
    expect(onlyNote?.sources.length).toBe(first.occurrences.length);
  });
});

describe("prompts whose outcome was not verified", () => {
  /** Mark a prompt of the sample home the way the author stage does. */
  function markUnverified(home: BuiltHome, slug: string) {
    const file = home.path(`library/${slug}/sources.json`);
    const sources = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...sources, outcome_verified: false }));
  }

  it("/api/library says so per prompt, and an older file without the mark reads as verified", async () => {
    const home = sample();
    markUnverified(home, "write-release-notes");
    const { entries } = await getJson<GuiSnapshot>(guiHarness(home.dir), "/api/library");
    expect(Object.fromEntries(entries.map((entry) => [entry.slug, entry.outcomeVerified]))).toEqual(
      { "fix-build-step": true, "write-release-notes": false },
    );
  });

  it("Start here never offers one while a verified prompt exists", async () => {
    const home = sample();
    // The prompt that would come first, with the most sessions.
    markUnverified(home, "fix-build-step");
    const some = await getJson<GuiHighlights>(guiHarness(home.dir), "/api/highlights");
    expect(some.prompts).toEqual([{ id: "write-release-notes", reason: "Based on 1 session" }]);
    // With nothing verified, they are offered, and the reason says what they are.
    markUnverified(home, "write-release-notes");
    const none = await getJson<GuiHighlights>(guiHarness(home.dir), "/api/highlights");
    expect(none.prompts).toEqual([
      { id: "fix-build-step", reason: "Based on 2 sessions · Outcome not verified" },
      { id: "write-release-notes", reason: "Based on 1 session · Outcome not verified" },
    ]);
  });

  it("the Prompts guide's one sentence says how many when there are any", () => {
    const plain = promptsGuideSentence(4, 0);
    expect(plain).not.toContain("verified");
    expect(promptsGuideSentence(4, 1)).toBe(
      `${plain.slice(0, -1)}; 1 of 4 is marked outcome not verified, because no session behind it was seen to reach a result.`,
    );
    expect(promptsGuideSentence(5, 2)).toContain(
      "; 2 of 5 are marked outcome not verified, because no session behind them was seen",
    );
    for (const sentence of [plain, promptsGuideSentence(5, 2)])
      expect(sentence.split(". ")).toHaveLength(1);
    // The same words in the browser view as in the terminal.
    expect(OUTCOME_NOT_VERIFIED_LABEL.toLowerCase()).toBe(OUTCOME_NOT_VERIFIED);
  });
});
