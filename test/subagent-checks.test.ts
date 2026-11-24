import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assembledProblems,
  authorProblems,
  generalizeProblems,
  proposeProblems,
} from "../src/core/subagent-checks.js";
import type { SuggestionArtifact } from "../src/core/subagents.js";
import type { AuthorRoleOutput } from "../src/distill/prompts/author-role.js";
import type { GeneralizeOutput } from "../src/distill/prompts/generalize.js";
import type { ProposeOutput } from "../src/distill/prompts/propose.js";

const SAMPLE = path.join(import.meta.dirname, "fixtures", "subagents", "suggestion.sample.json");

function sample(): SuggestionArtifact {
  return JSON.parse(fs.readFileSync(SAMPLE, "utf8")) as SuggestionArtifact;
}

/** The sample's stage A result, as one window over every sample input. */
function generalized(change: (output: GeneralizeOutput) => void = () => {}) {
  const artifact = sample();
  const output: GeneralizeOutput = {
    lessons: artifact.lessons.map(({ id: _id, ...lesson }) => lesson),
    set_aside: artifact.set_aside,
  };
  change(output);
  return generalizeProblems(output, artifact.inputs, artifact.projects);
}

/** The sample's stage B result over the sample lessons. */
function proposed(change: (output: ProposeOutput) => void = () => {}, minRoles = 2) {
  const artifact = sample();
  const output: ProposeOutput = {
    roles: artifact.roles.map(({ prompt: _p, triggers: _t, ...role }) => role),
    shared: artifact.shared,
    playbooks: artifact.playbooks,
  };
  change(output);
  return proposeProblems(output, artifact.lessons, artifact.projects, { minRoles, maxRoles: 15 });
}

/** The sample's stage C result for its first role. */
function authored(change: (output: AuthorRoleOutput) => void = () => {}) {
  const artifact = sample();
  const role = artifact.roles[0];
  if (!role?.prompt || !role.triggers) throw new Error("fixture role 0 has a prompt");
  const output: AuthorRoleOutput = { prompt: role.prompt, triggers: [...role.triggers] };
  change(output);
  return authorProblems(output, role, artifact.lessons, artifact.shared, artifact.projects);
}

const rules = (problems: string[]) => [...new Set(problems.map((p) => p.split(" ")[0]))];

describe("stage checks accept the sample", () => {
  it("passes generalize, propose, author and the assembled artifact", () => {
    expect(generalized()).toEqual([]);
    expect(proposed()).toEqual([]);
    expect(authored()).toEqual([]);
    expect(assembledProblems(sample())).toEqual([]);
  });
});

describe("generalize checks", () => {
  it("G1 flags an input that is missing, repeated, or unknown", () => {
    const problems = generalized((output) => {
      const [first, second] = output.lessons;
      if (!first || !second) throw new Error("fixture");
      first.source_ids = ["p01", "p99"]; // drops p02, invents p99
      second.source_ids = ["p03", "p01"]; // repeats p01
    });
    expect(rules(problems)).toEqual(["G1"]);
    expect(problems).toContain(
      'G1 input "p02" appears 0 times across lessons and set-asides (expected exactly 1)',
    );
    expect(problems).toContain(
      'G1 input "p01" appears 2 times across lessons and set-asides (expected exactly 1)',
    );
    expect(problems.some((p) => p.includes('unknown input id "p99"'))).toBe(true);
  });

  it("G2 flags a project name or a path in generalized text only", () => {
    const problems = generalized((output) => {
      const [first, second] = output.lessons;
      if (!first || !second) throw new Error("fixture");
      first.instruction += " This came up in atlas-billing first.";
      second.exceptions = "Not for /home/someone/notes.md.";
    });
    expect(rules(problems)).toEqual(["G2"]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('instruction names "atlas-billing"');
    expect(problems[1]).toContain('exceptions names "/home/someone/notes.md"');
    // The contextual lesson in the sample names "webapp" and is accepted.
    expect(generalized()).toEqual([]);
  });

  it("G3 flags a field outside the saved-artifact bounds", () => {
    const problems = generalized((output) => {
      const [first] = output.lessons;
      if (!first) throw new Error("fixture");
      first.instruction = "Too short.";
      first.title = "Two\nlines";
      const [aside] = output.set_aside;
      if (aside) aside.reason = "";
    });
    expect(rules(problems)).toEqual(["G3"]);
    expect(problems.some((p) => p.includes("instruction:"))).toBe(true);
    expect(problems.some((p) => p.includes("title: must be one line"))).toBe(true);
    expect(problems.some((p) => p.startsWith("G3 set-aside 1 reason"))).toBe(true);
  });

  it("G3 names the bound and the actual length, so a correction can act on it", () => {
    const problems = generalized((output) => {
      const [first] = output.lessons;
      if (!first) throw new Error("fixture");
      first.title = "t".repeat(81);
      first.instruction = "short";
      first.applies_when = "a".repeat(301);
    });
    expect(problems).toHaveLength(3);
    expect(
      problems.some(
        (p) => p.startsWith("G3 lesson 1 ") && p.endsWith("title: at most 80 characters (got 81)"),
      ),
    ).toBe(true);
    expect(problems.some((p) => p.includes("instruction: at least 40 characters (got 5)"))).toBe(
      true,
    );
    expect(problems.some((p) => p.includes("applies_when: at most 300 characters (got 301)"))).toBe(
      true,
    );
    expect(problems.some((p) => p.includes("Invalid input"))).toBe(false);
  });

  it("G3 names an empty source_ids list plainly", () => {
    const problems = generalized((output) => {
      const [first] = output.lessons;
      if (!first) throw new Error("fixture");
      first.source_ids = [];
    });
    expect(
      problems.some(
        (p) =>
          p.startsWith("G3 lesson 1 ") &&
          p.endsWith("source_ids: needs at least one source id (got none)"),
      ),
    ).toBe(true);
    expect(problems.some((p) => p.includes("Invalid input"))).toBe(false);
  });
});

describe("propose checks", () => {
  it("P1 enforces the role-count bounds for the call", () => {
    const problems = proposed((output) => {
      output.roles = output.roles.slice(0, 1);
      output.shared.push(
        "show-the-baseline",
        "dry-run-before-writes",
        "back-up-before-migrating",
        "plain-register-for-shared-docs",
      );
    });
    expect(problems).toEqual(["P1 1 roles proposed; expected 2 to 15"]);
    // A window may propose none.
    expect(
      proposed((output) => {
        output.roles = [];
        output.playbooks[0]?.lesson_ids.push(
          "separate-verified-from-inferred",
          "match-length-to-question",
          "trace-numbers-to-source",
          "show-the-baseline",
          "dry-run-before-writes",
          "back-up-before-migrating",
          "plain-register-for-shared-docs",
        );
        output.shared = [];
      }, 0),
    ).toEqual([]);
  });

  it("P2 flags duplicate and non-kebab names", () => {
    const problems = proposed((output) => {
      const [first, second] = output.roles;
      if (!first || !second) throw new Error("fixture");
      second.name = first.name;
      output.playbooks.push({
        name: "Settings Notes",
        purpose: "x",
        lesson_ids: ["settings-panel-chevron"],
      });
    });
    expect(rules(problems)).toEqual(["P2"]);
    expect(problems).toContain('P2 duplicate role name "evidence-analyst"');
    expect(problems.some((p) => p.startsWith('P2 playbook name "Settings Notes"'))).toBe(true);
  });

  it("P3 flags an unknown lesson id", () => {
    const problems = proposed((output) => {
      output.roles[0]?.lesson_ids.push("no-such-lesson");
      output.shared.push("also-missing");
    });
    expect(problems).toEqual([
      'P3 role "evidence-analyst" names unknown lesson "no-such-lesson"',
      'P3 shared names unknown lesson "also-missing"',
    ]);
  });

  it("P4 flags a generalized lesson placed nowhere", () => {
    const problems = proposed((output) => {
      const analyst = output.roles[0];
      if (analyst) analyst.lesson_ids = ["trace-numbers-to-source"];
    });
    expect(problems).toEqual([
      'P4 generalized lesson "show-the-baseline" is in no role, shared or playbook',
    ]);
  });

  it("P5 flags a contextual or historical lesson in a role or in shared", () => {
    const problems = proposed((output) => {
      output.roles[1]?.lesson_ids.push("settings-panel-chevron");
      output.shared.push("staging-endpoint-moved");
    });
    expect(problems).toEqual([
      'P5 role "release-engineer" carries contextual lesson "settings-panel-chevron"; move it to a playbook',
      'P5 shared carries historical lesson "staging-endpoint-moved"; move it to a playbook',
    ]);
  });

  it("P6 caps role size, fan-out and shared size", () => {
    const problems = proposed((output) => {
      const extra = output.roles.map((role, index) => ({
        ...role,
        name: `extra-role-${index + 1}`,
        lesson_ids: ["trace-numbers-to-source"],
      }));
      output.roles.push(...extra);
      const big = output.roles[0];
      if (big) big.lesson_ids = Array.from({ length: 41 }, () => "show-the-baseline");
      output.shared = Array.from({ length: 13 }, () => "match-length-to-question");
    });
    expect(problems).toContain('P6 role "evidence-analyst" has 41 lessons (at most 40)');
    expect(problems).toContain('P6 lesson "trace-numbers-to-source" is in 4 roles (at most 3)');
    expect(problems).toContain("P6 shared has 13 lessons (at most 12)");
  });

  it("P7 flags a project name or a path in role text", () => {
    const problems = proposed((output) => {
      const role = output.roles[2];
      if (role) role.delegate_when = "Docs for the webapp settings panel.";
    });
    expect(problems).toEqual(['P7 role "docs-editor" delegate_when names "webapp"']);
  });

  it("P8 flags other field bounds and repeated lesson ids", () => {
    const problems = proposed((output) => {
      const [first, second, third] = output.roles;
      if (!first || !second || !third) throw new Error("fixture");
      first.description = "x".repeat(201);
      second.lesson_ids.push("dry-run-before-writes");
      third.display_name = "Two\nlines";
      const playbook = output.playbooks[0];
      if (playbook) playbook.purpose = "";
    });
    expect(rules(problems)).toEqual(["P8"]);
    expect(problems.some((p) => p.startsWith('P8 role "evidence-analyst" description'))).toBe(true);
    expect(problems).toContain(
      'P8 role "release-engineer" lists lesson "dry-run-before-writes" twice',
    );
    expect(problems).toContain('P8 role "docs-editor" display_name: must be one line');
    expect(problems.some((p) => p.startsWith('P8 playbook "settings-panel-review" purpose'))).toBe(
      true,
    );
  });
});

describe("author checks", () => {
  it("A1 flags prompt and trigger bounds", () => {
    const problems = authored((output) => {
      output.prompt = "Too short.";
      output.triggers = ["one, two", "fine"];
    });
    expect(rules(problems)).toEqual(["A1"]);
    expect(problems[0]).toMatch(/^A1 prompt \(10 characters\)/);
    expect(problems.some((p) => p.includes('trigger "one, two"'))).toBe(true);
    expect(problems.some((p) => p.startsWith("A1 triggers"))).toBe(true);
  });

  it("A2 flags a project name or a path in the prompt or a trigger", () => {
    const problems = authored((output) => {
      output.prompt += "\n\nStart from /workplace/someone/repo.";
      output.triggers.push("webapp numbers");
    });
    expect(problems).toEqual([
      'A2 prompt names "/workplace/someone/repo"',
      'A2 trigger "webapp numbers" names "webapp"',
    ]);
  });

  it("A3 flags a mentioned lesson id that belongs to another role", () => {
    const problems = authored((output) => {
      output.prompt +=
        "\n\nBack up first (back-up-before-migrating), report as `separate-verified-from-inferred` says, and keep `trace-numbers-to-source`.";
    });
    expect(problems).toEqual([
      'A3 prompt mentions lesson "back-up-before-migrating", which belongs to neither role "evidence-analyst" nor shared',
    ]);
  });
});
