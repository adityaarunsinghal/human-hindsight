import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SuggestionArtifact } from "../src/core/subagents.js";
import { renderSubagentTree, rolePaths, SUBAGENT_TARGETS } from "../src/core/subagents-render.js";
import { GUI_HTML } from "../src/gui/assets.js";
import {
  changedAgreements,
  coverageRoleRows,
  coverageRows,
  exportFilename,
  exportHref,
  exportLabel,
  firstSource,
  knowledgeFile,
  playbookPath,
  roleFiles,
  roleKey,
  roleSearchText,
  splitFrontmatter,
  staleSuggestionText,
  subagentsHash,
  subagentsKeyFromHash,
  TARGET_LABELS,
} from "../src/gui/subagents-view.js";

const artifact = JSON.parse(
  fs.readFileSync(
    path.join(import.meta.dirname, "fixtures", "subagents", "suggestion.sample.json"),
    "utf8",
  ),
) as SuggestionArtifact;
const files = Object.fromEntries(renderSubagentTree(artifact, { target: "all" }));

describe("suggested subagents routes", () => {
  it.each([
    ["", "#subagents"],
    [roleKey("evidence-analyst"), "#subagents/evidence-analyst"],
    ["shared", "#subagents/shared"],
    ["playbooks", "#subagents/playbooks"],
    ["coverage", "#subagents/coverage"],
    // A role named like a view keeps its own address.
    [roleKey("coverage"), "#subagents/role/coverage"],
    [roleKey("shared"), "#subagents/role/shared"],
  ])("maps %j to %s and back", (key, hash) => {
    expect(subagentsHash(key)).toBe(hash);
    expect(subagentsKeyFromHash(hash.slice(1))).toBe(key);
  });

  it("reads plain role bookmarks and ignores other tabs", () => {
    expect(subagentsKeyFromHash("subagents/")).toBe("");
    expect(subagentsKeyFromHash("subagents/role/docs-editor")).toBe(roleKey("docs-editor"));
    for (const hash of ["", "prompts", "preferences", "preferences/abc", "subagentsx", "x"]) {
      expect(subagentsKeyFromHash(hash)).toBeNull();
    }
    expect(() => subagentsKeyFromHash("subagents/%E0%A4%A")).toThrow();
  });

  it("links Export all to the fixed zip route with an optional target", () => {
    expect(exportHref("all")).toBe("/api/subagents/export.zip");
    expect(exportHref("kirocrew")).toBe("/api/subagents/export.zip?target=kirocrew");
    expect(exportFilename(artifact.generated_at, "all")).toBe("hindsight-subagents-2026-11-20.zip");
    expect(exportFilename(artifact.generated_at, "codex")).toBe(
      "hindsight-subagents-2026-11-20-codex.zip",
    );
  });
});

describe("suggested subagents detail helpers", () => {
  it("groups every per-role rendered file under its role, in target order", () => {
    const owned = new Set<string>();
    for (const role of artifact.roles) {
      const grouped = roleFiles(files, role.name);
      expect(grouped.map((file) => file.target)).toEqual([...SUBAGENT_TARGETS]);
      const paths = rolePaths(role.name);
      expect(grouped.map((file) => file.path)).toEqual(
        SUBAGENT_TARGETS.map((target) => paths[target]),
      );
      for (const file of grouped) {
        expect(file.content).toBe(files[file.path]);
        owned.add(file.path);
      }
      const mentions = Object.keys(files).filter((file) => file.split(/[/.]/).includes(role.name));
      expect(grouped.map((file) => file.path).sort()).toEqual(mentions.sort());
    }
    const rest = Object.keys(files).filter((file) => !owned.has(file));
    expect(rest).toEqual([
      "HANDOFF.md",
      "README.md",
      "claude/CLAUDE.routing.md",
      "codex/AGENTS.routing.md",
      "kiro/steering/hindsight-routing.md",
      "kirocrew/create-bots.sh",
      "kirocrew/steering/hindsight-routing.md",
      "knowledge/coverage.json",
      "knowledge/lessons.json",
      "knowledge/playbooks/settings-panel-review.md",
      "knowledge/shared.md",
    ]);
  });

  it("shows only the files a narrower tree has", () => {
    const narrow = Object.fromEntries(renderSubagentTree(artifact, { target: "kirocrew" }));
    expect(roleFiles(narrow, "docs-editor").map((file) => file.target)).toEqual([
      "kirocrew",
      "knowledge",
    ]);
    expect(roleFiles(files, "no-such-role")).toEqual([]);
  });

  it("finds the shared, playbook and coverage files", () => {
    expect(knowledgeFile(files, "knowledge/shared.md")?.content).toContain("# Shared preferences");
    expect(knowledgeFile(files, playbookPath("settings-panel-review"))?.content).toContain(
      "# Playbook: settings-panel-review",
    );
    expect(knowledgeFile(files, "knowledge/missing.md")).toBeUndefined();
    expect(knowledgeFile(files, "toString")).toBeUndefined();
  });

  it("searches roles by name, display name, description and delegate when", () => {
    for (const role of artifact.roles) {
      const text = roleSearchText(role);
      for (const field of [role.name, role.display_name, role.description, role.delegate_when]) {
        expect(text).toContain(field.toLocaleLowerCase());
      }
    }
  });

  it("separates frontmatter from the Markdown preview", () => {
    const agent = files["claude/agents/evidence-analyst.md"] ?? "";
    const { frontmatter, body } = splitFrontmatter(agent);
    expect(frontmatter).toMatch(/^name: evidence-analyst\n/);
    expect(frontmatter).toContain("model: inherit");
    expect(body.startsWith("---")).toBe(false);
    expect(`---\n${frontmatter}\n---\n${body}`).toBe(agent);
    expect(splitFrontmatter("# Title\n\nText")).toEqual({
      frontmatter: "",
      body: "# Title\n\nText",
    });
  });

  it("links a lesson to its first source preference", () => {
    const lesson = artifact.lessons.find((value) => value.id === "separate-verified-from-inferred");
    if (!lesson) throw new Error("Expected the sample lesson.");
    expect(firstSource(artifact, lesson)).toEqual({
      id: "p01",
      text: "Say what you actually ran versus what you assumed.",
      more: 1,
    });
  });

  it("lays out the coverage ledger from the saved counts", () => {
    expect(coverageRows(artifact.coverage)).toEqual([
      ["Preferences considered", 14],
      ["Source preferences used", 12],
      ["Preferences left out", 2],
      ["General preferences", 7],
      ["Project-specific preferences", 1],
      ["One-time notes", 1],
      ["Preferences shared by every role", 2],
      ["Playbooks", 1],
    ]);
    expect(coverageRoleRows(artifact)).toEqual([
      ["Evidence analyst (evidence-analyst)", 2],
      ["Release engineer (release-engineer)", 2],
      ["Docs editor (docs-editor)", 2],
    ]);
  });
});

describe("an out-of-date suggestion", () => {
  it("finds the agreements whose source preferences were dismissed or left the library", () => {
    const [first, second] = artifact.lessons;
    if (!first || !second) throw new Error("The sample has two agreements.");
    const dismissed = new Set(first.source_ids);
    const missing = new Set(second.source_ids.slice(0, 1));
    const changed = changedAgreements(artifact, (id) =>
      dismissed.has(id) ? "dismissed" : missing.has(id) ? "missing" : "current",
    );
    expect(changed.get(first.id)).toEqual({
      dismissed: new Set(first.source_ids).size,
      missing: 0,
    });
    expect(changed.get(second.id)?.missing).toBe(1);
    // Exactly the agreements with at least one changed source, and no others.
    const touched = artifact.lessons.filter((lesson) =>
      lesson.source_ids.some((id) => dismissed.has(id) || missing.has(id)),
    );
    expect([...changed.keys()].sort()).toEqual(touched.map((lesson) => lesson.id).sort());
    expect(changedAgreements(artifact, () => "current").size).toBe(0);
  });

  it("says what exporting now would include", () => {
    expect(staleSuggestionText(2)).toBe(
      "The preferences these roles were made from changed since they were made. Exporting now gives the roles as shown, including 2 preferences whose source preferences you dismissed or that left the library (marked below). Run this to make them again:",
    );
    expect(staleSuggestionText(0)).toContain("Exporting now gives the roles as shown.");
  });
});

describe("suggested subagents markup", () => {
  it.each([
    ["all", "Download all targets (zip)"],
    ["claude", "Download Claude Code (zip)"],
    ["knowledge", "Download Knowledge only (zip)"],
  ] as const)("the export button for %s reads %j", (target, label) => {
    expect(exportLabel(target)).toBe(label);
  });

  it("offers one download button and one option per target in a native select", () => {
    expect(GUI_HTML).toContain('<button id="export-all" class="button-link primary" type="button"');
    const options = [...GUI_HTML.matchAll(/<option value="([a-z]+)">([^<]+)<\/option>/g)]
      .map((match) => match[1])
      .filter((value) => value === "all" || SUBAGENT_TARGETS.some((target) => target === value));
    expect(options).toEqual(["all", ...SUBAGENT_TARGETS]);
    expect(Object.keys(TARGET_LABELS).sort()).toEqual([...SUBAGENT_TARGETS].sort());
    expect(GUI_HTML).toContain('id="subagents-tab"');
  });
});
