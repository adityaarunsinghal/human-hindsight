import { describe, expect, it } from "vitest";
import type { Lesson } from "../src/core/subagents.js";
import {
  type AgreementFacts,
  type AgreementSource,
  agreementFacts,
  agreementHighlights,
  agreementSummary,
  agreementsMarkdown,
  incompleteNotice,
  NO_PROJECT,
  organizeAgreements,
  supportLabel,
} from "../src/gui/overview.js";

/**
 * How the Preferences tab presents working agreements: general ones first,
 * grouped by a plain domain heading and ordered by how many sessions support
 * them; project-specific ones under their project; one-time notes last and
 * never among the highlights. Pure functions, no DOM.
 */

type Disposition = Lesson["disposition"];

function lesson(id: string, disposition: Disposition, sources: string[], title = id): Lesson {
  return {
    id,
    title,
    instruction: `Instruction for ${id}, written to be at least forty characters long.`,
    applies_when: "",
    exceptions: "",
    disposition,
    source_ids: sources,
  };
}

function source(domains: string[], sessions: string[], projects: string[] = []): AgreementSource {
  return { domains, sessions, projects };
}

function facts(
  id: string,
  kind: AgreementFacts["kind"],
  group: string,
  sessions: number,
  preferences = 1,
): AgreementFacts {
  return { id, title: id, kind, group, sessions, preferences };
}

describe("an agreement's group and support", () => {
  const sources = new Map<string, AgreementSource>([
    ["t1", source(["Software engineering > Testing > Unit tests"], ["s1", "s2"])],
    ["t2", source(["Software engineering > Testing", "Design"], ["s2", "s3"])],
    ["f1", source(["Software engineering > Frontend"], ["s4"])],
    ["w1", source(["Writing & research"], ["s5"], ["beta"])],
    ["n1", source([], [], ["alpha"])],
    ["n2", source([], ["s6"], ["alpha", "beta"])],
    ["o1", source(["Other > Gardening"], [])],
  ]);

  it.each([
    // [label, lesson, expected kind, expected group, sessions, preferences]
    [
      "the most common second-level heading among its preferences",
      lesson("a", "generalized", ["t1", "t2", "f1"]),
      "general",
      "Testing",
      4,
      3,
    ],
    [
      "a root without a deeper level is its own heading",
      lesson("b", "generalized", ["w1"]),
      "general",
      "Writing & research",
      1,
      1,
    ],
    ["no domain at all is Other", lesson("c", "generalized", ["n1"]), "general", "Other", 0, 1],
    ["the Other root stays Other", lesson("d", "generalized", ["o1"]), "general", "Other", 0, 1],
    [
      "a project agreement goes under its most common project",
      lesson("e", "contextual", ["n1", "n2", "w1"]),
      "project",
      "alpha",
      2,
      3,
    ],
    [
      "a project agreement with no known project",
      lesson("f", "contextual", ["t1"]),
      "project",
      NO_PROJECT,
      2,
      1,
    ],
    ["a one-time note has no group", lesson("g", "historical", ["t1"]), "one-time", "", 2, 1],
    [
      "a source that left the library still counts as a preference",
      lesson("h", "generalized", ["t1", "gone"]),
      "general",
      "Testing",
      2,
      2,
    ],
  ] as const)("%s", (_label, value, kind, group, sessions, preferences) => {
    expect(agreementFacts(value, sources)).toEqual({
      id: value.id,
      title: value.title,
      kind,
      group,
      sessions,
      preferences,
    });
  });

  it("breaks a tie between headings alphabetically, so the group never flips", () => {
    const tie = new Map([
      ["x", source(["Software engineering > Testing"], [])],
      ["y", source(["Software engineering > Frontend"], [])],
    ]);
    expect(agreementFacts(lesson("t", "generalized", ["y", "x"]), tie).group).toBe("Frontend");
    expect(agreementFacts(lesson("t", "generalized", ["x", "y"]), tie).group).toBe("Frontend");
  });
});

describe("organizing the saved set", () => {
  it.each([
    ["an empty set", [], [], [], [], { total: 0, general: 0, project: 0, oneTime: 0 }],
    [
      "zero general agreements",
      [facts("p1", "project", "alpha", 3), facts("h1", "one-time", "", 9)],
      [],
      [["alpha", ["p1"]]],
      ["h1"],
      { total: 2, general: 0, project: 1, oneTime: 1 },
    ],
    [
      "only one-time notes",
      [facts("h1", "one-time", "", 1), facts("h2", "one-time", "", 4)],
      [],
      [],
      ["h2", "h1"],
      { total: 2, general: 0, project: 0, oneTime: 2 },
    ],
    [
      "groups by size, Other and no project last, items by sessions",
      [
        facts("g1", "general", "Testing", 1),
        facts("g2", "general", "Other", 9),
        facts("g3", "general", "Testing", 5),
        facts("g4", "general", "Frontend", 2),
        facts("g5", "general", "Other", 1),
        facts("g6", "general", "Other", 1),
        facts("p1", "project", NO_PROJECT, 8),
        facts("p2", "project", "beta", 1),
        facts("p3", "project", "beta", 2),
        facts("p4", "project", "alpha", 3),
      ],
      [
        ["Testing", ["g3", "g1"]],
        ["Frontend", ["g4"]],
        ["Other", ["g2", "g5", "g6"]],
      ],
      [
        ["beta", ["p3", "p2"]],
        ["alpha", ["p4"]],
        [NO_PROJECT, ["p1"]],
      ],
      [],
      { total: 10, general: 6, project: 4, oneTime: 0 },
    ],
  ] as const)("%s", (_label, input, general, projects, oneTime, counts) => {
    const organized = organizeAgreements([...input]);
    expect(organized.general.map((group) => [group.label, group.items.map((i) => i.id)])).toEqual(
      general,
    );
    expect(organized.projects.map((group) => [group.label, group.items.map((i) => i.id)])).toEqual(
      projects,
    );
    expect(organized.oneTime.map((item) => item.id)).toEqual(oneTime);
    expect(organized.counts).toEqual(counts);
  });

  it("keeps every one of 150 agreements exactly once, in a stable order", () => {
    const kinds = ["general", "general", "project", "one-time"] as const;
    const headings = ["Testing", "Frontend", "Backend", "Security", "Other"];
    const all = Array.from({ length: 150 }, (_, index) => {
      const kind = kinds[index % kinds.length] ?? "general";
      return facts(
        `a${String(index).padStart(3, "0")}`,
        kind,
        kind === "general"
          ? (headings[index % headings.length] ?? "Other")
          : kind === "project"
            ? `project-${index % 3}`
            : "",
        (index * 7) % 11,
      );
    });
    const organized = organizeAgreements(all);
    const ids = [
      ...organized.general.flatMap((group) => group.items),
      ...organized.projects.flatMap((group) => group.items),
      ...organized.oneTime,
    ].map((item) => item.id);
    expect(ids.length).toBe(150);
    expect(new Set(ids).size).toBe(150);
    expect(organized.counts).toEqual({ total: 150, general: 76, project: 37, oneTime: 37 });
    expect(organizeAgreements([...all].reverse())).toEqual(organized);
    for (const group of [...organized.general, ...organized.projects]) {
      const sessions = group.items.map((item) => item.sessions);
      expect(sessions).toEqual([...sessions].sort((a, b) => b - a));
    }
  });
});

describe("the overview sentence", () => {
  it.each([
    [
      { total: 120, general: 62, project: 41, oneTime: 17 },
      139,
      "120 saved preferences drawn from 139 observations (62 general, 41 for specific projects, 17 one-time notes).",
    ],
    [
      { total: 1, general: 1, project: 0, oneTime: 0 },
      1,
      "1 saved preference drawn from 1 observation (1 general).",
    ],
    [
      { total: 2, general: 0, project: 1, oneTime: 1 },
      3,
      "2 saved preferences drawn from 3 observations (1 for a specific project, 1 one-time note).",
    ],
    [
      { total: 3, general: 0, project: 0, oneTime: 3 },
      0,
      "3 saved preferences (3 one-time notes).",
    ],
  ])("%o from %i preferences", (counts, preferences, sentence) => {
    expect(agreementSummary(counts, preferences)).toBe(sentence);
  });
});

describe("the agreements worth reading first", () => {
  it("come only from general agreements, best supported first, with the true reason", () => {
    const organized = organizeAgreements([
      facts("note", "one-time", "", 40),
      facts("project", "project", "alpha", 30),
      facts("low", "general", "Testing", 1),
      facts("high", "general", "Frontend", 5),
      facts("mid", "general", "Testing", 3),
      facts("none", "general", "Other", 0, 2),
    ]);
    expect(agreementHighlights(organized)).toEqual([
      { id: "agreement/high", reason: "Seen in 5 sessions" },
      { id: "agreement/mid", reason: "Seen in 3 sessions" },
      { id: "agreement/low", reason: "Seen in 1 session" },
    ]);
    expect(agreementHighlights(organized, 5).at(-1)).toEqual({
      id: "agreement/none",
      reason: "From 2 observations",
    });
  });

  it("are empty when there is no general agreement", () => {
    expect(
      agreementHighlights(
        organizeAgreements([facts("n", "one-time", "", 9), facts("p", "project", "a", 9)]),
      ),
    ).toEqual([]);
  });
});

describe("an unfinished set", () => {
  it.each([
    [null, null],
    [{ summarized: 139, total: 139 }, null],
    [
      { summarized: 120, total: 139 },
      "120 of 139 preferences are summarized so far. Run this to finish; finished work is reused:",
    ],
    [
      { summarized: 1, total: 2 },
      "1 of 2 preferences is summarized so far. Run this to finish; finished work is reused:",
    ],
    [
      { summarized: 0, total: 1 },
      "0 of 1 preference is summarized so far. Run this to finish; finished work is reused:",
    ],
  ])("%o", (incomplete, text) => {
    expect(incompleteNotice(incomplete)).toBe(text);
  });
});

describe("what a count is labelled as", () => {
  it.each([
    [3, true, "long", "Seen in 3 sessions"],
    [1, true, "long", "Seen in 1 session"],
    [2, false, "long", "Found in 2 tasks"],
    [3, true, "short", "3 sessions"],
    [1, false, "short", "1 task"],
  ] as const)("%i, verified %s, %s form", (count, verified, form, label) => {
    expect(supportLabel(count, verified, form)).toBe(label);
  });
});

describe("copying the general agreements", () => {
  it("gives every general agreement under its heading, and nothing else", () => {
    const lessons = [
      { ...lesson("a", "generalized", ["x"], "Keep changes small"), applies_when: "Any change." },
      { ...lesson("b", "generalized", ["x"], "Write plain release notes"), exceptions: "None." },
      lesson("c", "contextual", ["x"], "Use the alpha deploy script"),
      lesson("d", "historical", ["x"], "Allowed to skip the slow suite once"),
    ];
    const organized = organizeAgreements([
      facts("a", "general", "Testing", 2),
      facts("b", "general", "Writing & research", 1),
      facts("c", "project", "alpha", 4),
      facts("d", "one-time", "", 1),
    ]);
    const markdown = agreementsMarkdown(organized, lessons);
    expect(markdown).toBe(
      [
        "# Preferences",
        "",
        "## Testing",
        "",
        "- **Keep changes small.** Instruction for a, written to be at least forty characters long.",
        "  Applies when: Any change.",
        "",
        "## Writing & research",
        "",
        "- **Write plain release notes.** Instruction for b, written to be at least forty characters long.",
        "  Exceptions: None.",
        "",
      ].join("\n"),
    );
    expect(markdown).not.toContain("alpha deploy");
    expect(markdown).not.toContain("skip the slow suite");
  });
});
