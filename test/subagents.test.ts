import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPreferenceReviews, savePreferenceReview } from "../src/core/preference-review.js";
import { type AggregatedPreference, preferenceId } from "../src/core/preferences.js";
import {
  computeCoverage,
  projectNameViolations,
  readSuggestion,
  type SuggestionArtifact,
  SuggestionArtifactSchema,
  type SuggestionInput,
  SuggestionReadError,
  selectSuggestionInputs,
  suggestionFingerprint,
  suggestionPath,
  writeSuggestion,
} from "../src/core/subagents.js";

const SAMPLE = path.join(import.meta.dirname, "fixtures", "subagents", "suggestion.sample.json");

function sample(): SuggestionArtifact {
  return JSON.parse(fs.readFileSync(SAMPLE, "utf8")) as SuggestionArtifact;
}

/** Mutate a copy and keep coverage consistent unless the test is about coverage. */
function mutated(change: (a: SuggestionArtifact) => void, recompute = true): SuggestionArtifact {
  const artifact = sample();
  change(artifact);
  if (recompute) artifact.coverage = computeCoverage(artifact);
  return artifact;
}

function messages(artifact: unknown): string[] {
  const result = SuggestionArtifactSchema.safeParse(artifact);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-subagents-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("suggestion schema", () => {
  it("accepts the sample artifact", () => {
    expect(messages(sample())).toEqual([]);
  });

  type Change = (a: SuggestionArtifact) => void;
  const role = (a: SuggestionArtifact, index: number) => {
    const found = a.roles[index];
    if (!found) throw new Error(`sample role ${index}`);
    return found;
  };
  // One row per way to break a rule; `expected` is the exact message, or its rule prefix.
  it.each<[string, Change, string, boolean?]>([
    [
      "SA1 a duplicate lesson id",
      (a) => {
        a.lessons.push({
          ...a.lessons[0],
          source_ids: ["p13"],
        } as SuggestionArtifact["lessons"][0]);
        a.set_aside = a.set_aside.filter((item) => !item.source_ids.includes("p13"));
      },
      "SA1 ",
    ],
    [
      "SA2 a duplicate role name",
      (a) => {
        role(a, 2).name = "evidence-analyst";
      },
      "SA2 ",
    ],
    [
      "SA2 a role name that is not kebab-case",
      (a) => {
        role(a, 0).name = "Evidence Analyst";
      },
      "must be kebab-case",
    ],
    [
      "SA3 an unknown lesson id in a role",
      (a) => void role(a, 0).lesson_ids.push("no-such"),
      "SA3 ",
    ],
    ["SA3 an unknown lesson id in shared", (a) => void a.shared.push("no-such"), "SA3 "],
    [
      "SA3 an unknown lesson id in a playbook",
      (a) => void a.playbooks[0]?.lesson_ids.push("no-such"),
      "SA3 ",
    ],
    [
      "SA4 a source id that is not an input",
      (a) => void a.lessons[0]?.source_ids.push("p99"),
      "SA4 ",
    ],
    [
      "SA5 an unmapped input",
      (a) => {
        a.set_aside = a.set_aside.filter((item) => !item.source_ids.includes("p14"));
      },
      'SA5 input "p14" appears 0 times (expected exactly 1)',
    ],
    [
      "SA5 an input mapped twice",
      (a) => void a.lessons[1]?.source_ids.push("p13"),
      'SA5 input "p13" appears 2 times (expected exactly 1)',
    ],
    [
      "SA6 a generalized lesson placed nowhere",
      (a) => {
        role(a, 0).lesson_ids = ["trace-numbers-to-source"];
      },
      'SA6 generalized lesson "show-the-baseline" is in no role, shared or playbook',
    ],
    [
      "SA7 a contextual lesson in a role",
      (a) => void role(a, 0).lesson_ids.push("settings-panel-chevron"),
      'SA7 role "evidence-analyst" carries contextual lesson "settings-panel-chevron"',
    ],
    [
      "SA7 a historical lesson in shared",
      (a) => void a.shared.push("staging-endpoint-moved"),
      'SA7 shared carries historical lesson "staging-endpoint-moved"',
    ],
    [
      "SA8 fewer than 2 roles",
      (a) => {
        a.roles = a.roles.slice(0, 1);
        a.playbooks[0]?.lesson_ids.push(
          "dry-run-before-writes",
          "back-up-before-migrating",
          "plain-register-for-shared-docs",
        );
      },
      "",
    ],
    [
      "SA8 more than 15 roles",
      (a) => {
        for (let i = 0; i < 13; i++) a.roles.push({ ...role(a, 2), name: `extra-role-${i}` });
      },
      "",
    ],
    [
      "SA9 more than 12 shared lessons",
      (a) => {
        a.shared = Array.from({ length: 13 }, () => "match-length-to-question");
      },
      "",
    ],
    [
      "SA10 a lesson in more than 3 roles",
      (a) => {
        a.roles.push({ ...role(a, 2), name: "fourth-role" });
        role(a, 0).lesson_ids.push("plain-register-for-shared-docs");
        role(a, 1).lesson_ids.push("plain-register-for-shared-docs");
      },
      'SA10 lesson "plain-register-for-shared-docs" is in 4 roles (at most 3)',
    ],
    [
      "SA11 coverage that does not match the recomputed ledger",
      (a) => {
        a.coverage.mapped = 99;
      },
      "SA11 coverage does not match the recomputed coverage",
      false,
    ],
    [
      "SA12 a duplicate input id",
      (a) => {
        const first = a.inputs[0];
        if (first) a.inputs.push({ ...first });
      },
      'SA12 duplicate input id "p01"',
    ],
    [
      "SA12 a duplicate playbook name",
      (a) => {
        const first = a.playbooks[0];
        if (first) a.playbooks.push({ ...first, lesson_ids: ["staging-endpoint-moved"] });
      },
      'SA12 duplicate playbook name "settings-panel-review"',
    ],
  ])("rejects %s", (_name, change, expected, recompute = true) => {
    const found = messages(mutated(change, recompute));
    expect(found.length).toBeGreaterThan(0);
    if (expected.endsWith(" ")) expect(found.some((m) => m.startsWith(expected))).toBe(true);
    else if (expected) expect(found).toContain(expected);
  });

  it("SA6 accepts a generalized lesson placed only in a playbook", () => {
    const artifact = mutated((a) => {
      role(a, 0).lesson_ids = ["trace-numbers-to-source"];
      a.playbooks[0]?.lesson_ids.push("show-the-baseline");
    });
    expect(messages(artifact)).toEqual([]);
  });

  it.each([
    [
      "a role with more than 40 lessons",
      (a: SuggestionArtifact) => {
        const role = a.roles[0];
        if (role) role.lesson_ids = Array.from({ length: 41 }, () => "show-the-baseline");
      },
    ],
    [
      "a prompt shorter than 2000 characters",
      (a: SuggestionArtifact) => {
        const role = a.roles[0];
        if (role) role.prompt = "Too short.";
      },
    ],
    [
      "a trigger of five words",
      (a: SuggestionArtifact) => {
        const role = a.roles[0];
        if (role) role.triggers = ["one two three four five", "b", "c"];
      },
    ],
    [
      "a trigger with a comma",
      (a: SuggestionArtifact) => {
        const role = a.roles[0];
        if (role) role.triggers = ["data, numbers", "b", "c"];
      },
    ],
    [
      "fewer than 3 triggers",
      (a: SuggestionArtifact) => {
        const role = a.roles[0];
        if (role) role.triggers = ["data"];
      },
    ],
    [
      "an instruction under 40 characters",
      (a: SuggestionArtifact) => {
        const lesson = a.lessons[0];
        if (lesson) lesson.instruction = "Be careful.";
      },
    ],
    [
      "a description over one line",
      (a: SuggestionArtifact) => {
        const role = a.roles[0];
        if (role) role.description = "First line\nsecond line";
      },
    ],
    [
      "an unknown runner",
      (a: SuggestionArtifact) => {
        (a as { runner: string }).runner = "external";
      },
    ],
  ])("rejects %s", (_label, change) => {
    expect(messages(mutated(change)).length).toBeGreaterThan(0);
  });
});

describe("coverage", () => {
  it("recomputes the sample's ledger", () => {
    const artifact = sample();
    expect(computeCoverage(artifact)).toEqual(artifact.coverage);
    expect(artifact.coverage).toEqual({
      source_candidates: 14,
      mapped: 12,
      set_aside: 2,
      disposition_counts: { generalized: 7, contextual: 1, historical: 1 },
      roles: {
        "evidence-analyst": { lesson_count: 2 },
        "release-engineer": { lesson_count: 2 },
        "docs-editor": { lesson_count: 2 },
      },
      shared_count: 2,
      playbook_count: 1,
    });
  });
});

function pref(text: string, extra: Partial<AggregatedPreference> = {}): AggregatedPreference {
  return {
    text,
    count: 1,
    occurrences: [{ slug: `task-${text.length}`, evidence: `${text} (evidence)` }],
    lastAuthoredAt: "2026-11-01T00:00:00Z",
    scope: "global",
    ...extra,
  };
}

const PREFS = (): AggregatedPreference[] => [
  pref("Verify before claiming done.", {
    count: 3,
    domains: ["testing"],
    occurrences: [
      {
        slug: "a",
        evidence: "checked it",
        quote: "did you run it?",
        domains: ["Software engineering > Testing"],
      },
    ],
  }),
  pref("Keep answers short."),
  pref("Use the project's own lint config.", { scope: "project", project: "webapp" }),
];

describe("input selection", () => {
  it("uses only accepted preferences when some are accepted, with the accepted wording", () => {
    const prefs = PREFS();
    const [first] = prefs;
    if (!first) throw new Error("fixture");
    savePreferenceReview(home, first, { status: "accepted", text: "Verify before saying done." });
    const { reviews } = readPreferenceReviews(home);
    const result = selectSuggestionInputs(prefs, reviews, { includeUnreviewed: false });
    expect(result.selection).toBe("accepted");
    expect(result.inputs).toEqual([
      {
        id: preferenceId(first),
        text: "Verify before saying done.",
        count: 3,
        scope: "global",
        domain: "Software engineering > Testing",
        quote: "did you run it?",
        review: "accepted",
      },
    ]);
  });

  it("falls back to every non-dismissed candidate when none is accepted", () => {
    const prefs = PREFS();
    const [, second, third] = prefs;
    if (!second || !third) throw new Error("fixture");
    savePreferenceReview(home, second, { status: "dismissed" });
    const { reviews } = readPreferenceReviews(home);
    const result = selectSuggestionInputs(prefs, reviews, { includeUnreviewed: false });
    expect(result.selection).toBe("all-candidates");
    expect(result.inputs.map((input) => input.id)).toEqual(
      [prefs[0], third].map((p) => preferenceId(p as AggregatedPreference)),
    );
    expect(result.inputs.every((input) => input.review === "pending")).toBe(true);
    expect(result.inputs[1]).toMatchObject({ scope: "project", project: "webapp" });
    expect(result.inputs[1]?.quote).toBe("Use the project's own lint config. (evidence)");
  });

  it("includes unreviewed candidates with the flag even when some are accepted", () => {
    const prefs = PREFS();
    const [first, second] = prefs;
    if (!first || !second) throw new Error("fixture");
    savePreferenceReview(home, first, { status: "accepted" });
    savePreferenceReview(home, second, { status: "dismissed" });
    const { reviews } = readPreferenceReviews(home);
    const result = selectSuggestionInputs(prefs, reviews, { includeUnreviewed: true });
    expect(result.selection).toBe("all-candidates");
    expect(result.inputs.map((input) => input.review)).toEqual(["accepted", "pending"]);
  });

  it("treats an acceptance whose evidence changed as pending", () => {
    const prefs = PREFS();
    const [first] = prefs;
    if (!first) throw new Error("fixture");
    savePreferenceReview(home, first, { status: "accepted" });
    const { reviews } = readPreferenceReviews(home);
    first.occurrences.push({ slug: "b", evidence: "new evidence" });
    const result = selectSuggestionInputs(prefs, reviews, { includeUnreviewed: false });
    expect(result.selection).toBe("all-candidates");
  });
});

describe("suggestion fingerprint", () => {
  const inputs = (): SuggestionInput[] => sample().inputs;

  it("ignores input order and fields the stages do not depend on for identity", () => {
    const fingerprint = suggestionFingerprint(inputs(), {});
    expect(suggestionFingerprint(inputs().toReversed(), {})).toBe(fingerprint);
    expect(fingerprint).toBe(sample().source_hash);
    expect(
      suggestionFingerprint(
        inputs().map((input) => ({ ...input, quote: "different quote" })),
        {},
      ),
    ).toBe(fingerprint);
  });

  it("changes when a review flips, a revision changes, or text changes", () => {
    const fingerprint = suggestionFingerprint(inputs(), {});
    const flipped = inputs().map((input, index) =>
      index === 0 ? { ...input, review: "pending" as const } : input,
    );
    expect(suggestionFingerprint(flipped, {})).not.toBe(fingerprint);
    const revision = {
      p01: {
        status: "accepted" as const,
        source_fingerprint: "a".repeat(64),
        updated_at: "2026-11-01T00:00:00.000Z",
        text: "x",
        scope: "global" as const,
      },
    };
    expect(suggestionFingerprint(inputs(), revision)).not.toBe(fingerprint);
    expect(
      suggestionFingerprint(
        inputs().map((input, index) => (index === 0 ? { ...input, text: "Changed." } : input)),
        {},
      ),
    ).not.toBe(fingerprint);
  });
});

/** A minimal valid artifact over the given inputs: one lesson per input, two roles. */
function artifactFor(
  inputs: SuggestionInput[],
  selection: SuggestionArtifact["selection"],
  hash: string,
): SuggestionArtifact {
  const lessons = inputs.map((input, index) => ({
    id: `lesson-${index + 1}`,
    title: `Lesson ${index + 1}`,
    instruction: `${input.text} This instruction is long enough for the schema.`,
    applies_when: "Always.",
    exceptions: "",
    disposition: "generalized" as const,
    source_ids: [input.id],
  }));
  const role = (name: string) => ({
    name,
    display_name: name,
    description: `The ${name} role.`,
    delegate_when: "When needed.",
    not_for: "Anything else.",
    lesson_ids: lessons.map((lesson) => lesson.id),
  });
  const parts = {
    inputs,
    lessons,
    set_aside: [],
    roles: [role("first-role"), role("second-role")],
    shared: [],
    playbooks: [],
  };
  return {
    ...sample(),
    selection,
    source_hash: hash,
    ...parts,
    coverage: computeCoverage(parts),
  };
}

describe("saved suggestion", () => {
  it("returns null for a missing file without creating directories", () => {
    expect(readSuggestion(home, { prefs: [], reviews: {} })).toBeNull();
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("round-trips through an owner-only file", () => {
    const artifact = sample();
    const file = writeSuggestion(home, artifact);
    expect(file).toBe(path.join(home, "library", "subagents", "suggestion.json"));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const read = readSuggestion(home, { prefs: [], reviews: {} });
    expect(read?.artifact).toEqual(artifact);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["suggestion.json"]);
  });

  it("refuses to write an invalid artifact and leaves the prior one", () => {
    const file = writeSuggestion(home, sample());
    const before = fs.readFileSync(file, "utf8");
    const bad = mutated((a) => {
      a.shared.push("staging-endpoint-moved");
    });
    expect(() => writeSuggestion(home, bad)).toThrow(/SA7/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it.each([
    ["not JSON", "{ nope", /not valid JSON/],
    ["a schema failure", JSON.stringify({ version: 2 }), /version/],
  ])("throws SuggestionReadError for %s and keeps the file", (_label, raw, reason) => {
    const file = suggestionPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, raw);
    let caught: unknown;
    try {
      readSuggestion(home, { prefs: [], reviews: {} });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SuggestionReadError);
    expect((caught as SuggestionReadError).reason).toMatch(reason);
    expect(fs.readFileSync(file, "utf8")).toBe(raw);
  });

  it("flags stale when the accepted set changes and not before", () => {
    const prefs = PREFS();
    const [first, second] = prefs;
    if (!first || !second) throw new Error("fixture");
    savePreferenceReview(home, first, { status: "accepted" });
    let { reviews } = readPreferenceReviews(home);
    const picked = selectSuggestionInputs(prefs, reviews, { includeUnreviewed: false });
    writeSuggestion(
      home,
      artifactFor(picked.inputs, picked.selection, suggestionFingerprint(picked.inputs, reviews)),
    );
    expect(readSuggestion(home, { prefs, reviews })?.stale).toBe(false);
    savePreferenceReview(home, second, { status: "accepted" });
    ({ reviews } = readPreferenceReviews(home));
    expect(readSuggestion(home, { prefs, reviews })?.stale).toBe(true);
  });

  it("flags an all-candidates result stale when a review flips", () => {
    const prefs = PREFS();
    const [first] = prefs;
    if (!first) throw new Error("fixture");
    const picked = selectSuggestionInputs(prefs, {}, { includeUnreviewed: false });
    expect(picked.selection).toBe("all-candidates");
    writeSuggestion(
      home,
      artifactFor(picked.inputs, picked.selection, suggestionFingerprint(picked.inputs, {})),
    );
    expect(readSuggestion(home, { prefs, reviews: {} })?.stale).toBe(false);
    savePreferenceReview(home, first, { status: "accepted" });
    const { reviews } = readPreferenceReviews(home);
    expect(readSuggestion(home, { prefs, reviews })?.stale).toBe(true);
  });

  it("reads the library and reviews from home by default", () => {
    const dir = path.join(home, "library", "first-task");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "sources.json"),
      JSON.stringify({
        slug: "first-task",
        preferences: [{ text: "Keep answers short.", evidence: "short please" }],
        authored_at: "2026-11-01T00:00:00Z",
      }),
    );
    const picked = selectSuggestionInputs(
      [
        pref("Keep answers short.", {
          occurrences: [{ slug: "first-task", evidence: "short please" }],
        }),
      ],
      {},
      { includeUnreviewed: false },
    );
    writeSuggestion(
      home,
      artifactFor(picked.inputs, picked.selection, suggestionFingerprint(picked.inputs, {})),
    );
    expect(readSuggestion(home)?.stale).toBe(false);
    fs.writeFileSync(
      path.join(dir, "sources.json"),
      JSON.stringify({
        slug: "first-task",
        preferences: [{ text: "Keep answers very short.", evidence: "short please" }],
        authored_at: "2026-11-01T00:00:00Z",
      }),
    );
    expect(readSuggestion(home)?.stale).toBe(true);
  });
});

describe("project name violations", () => {
  const projects = ["webapp", "atlas-billing", "src", "api", "unknown", "Workspace"];

  it("finds whole-word project names case-insensitively, and absolute paths", () => {
    expect(
      projectNameViolations(
        "Check the WebApp panel, then atlas-billing totals in /home/someone/repo/file.ts.",
        projects,
      ),
    ).toEqual(["webapp", "atlas-billing", "/home/someone/repo/file.ts"]);
    expect(projectNameViolations("Open C:\\Users\\me\\x.txt and /Users/me", projects)).toEqual([
      "C:\\Users\\me\\x.txt",
      "/Users/me",
    ]);
    expect(projectNameViolations("See /workplace/team/pkg", [])).toEqual(["/workplace/team/pkg"]);
  });

  it("does not read a JSON-escaped newline after a word as a drive path", () => {
    expect(projectNameViolations('{"prompt":"to the coordinator:\\n\\n- done"}', [])).toEqual([]);
    expect(projectNameViolations("copy D:\\data\\x.csv", [])).toEqual(["D:\\data\\x.csv"]);
  });

  it("ignores short names, generic words and partial-word matches", () => {
    expect(
      projectNameViolations(
        "Use the api from src in the workspace; unknown webapps and atlas-billing2 are fine.",
        projects,
      ),
    ).toEqual([]);
  });

  it("finds none in the sample's role, shared and generalized lesson text", () => {
    const artifact = sample();
    const generalized = artifact.lessons.filter((l) => l.disposition === "generalized");
    const texts = [
      ...artifact.roles.flatMap((role) => [
        role.description,
        role.delegate_when,
        role.not_for,
        role.prompt ?? "",
      ]),
      ...generalized.flatMap((l) => [l.title, l.instruction, l.applies_when, l.exceptions]),
    ];
    for (const text of texts) expect(projectNameViolations(text, artifact.projects)).toEqual([]);
    const contextual = artifact.lessons.find((l) => l.disposition === "contextual");
    expect(projectNameViolations(contextual?.instruction ?? "", artifact.projects)).toEqual([
      "webapp",
    ]);
  });
});
