import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  computeCoverage,
  projectNameViolations,
  type SuggestionArtifact,
} from "../src/core/subagents.js";
import {
  type RenderOptions,
  renderSubagentTree,
  SUBAGENT_TARGETS,
} from "../src/core/subagents-render.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "subagents");
const GOLDEN = path.join(FIXTURES, "golden");

function sample(): SuggestionArtifact {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURES, "suggestion.sample.json"), "utf8"),
  ) as SuggestionArtifact;
}

function readTree(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else
        files.set(
          path.relative(dir, full).split(path.sep).join("/"),
          fs.readFileSync(full, "utf8"),
        );
    }
  };
  walk(dir);
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Compare with the committed golden tree. `HINDSIGHT_UPDATE_GOLDEN=1` rewrites
 * it; review the diff before committing.
 */
function expectGolden(name: string, opts: RenderOptions) {
  const rendered = renderSubagentTree(sample(), opts);
  const dir = path.join(GOLDEN, name);
  if (process.env.HINDSIGHT_UPDATE_GOLDEN === "1") {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [file, content] of rendered) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), content);
    }
  }
  expect([...rendered.keys()]).toEqual([...readTree(dir).keys()]);
  expect(rendered).toEqual(readTree(dir));
}

const ALL_PATHS = [
  "HANDOFF.md",
  "README.md",
  "claude/CLAUDE.routing.md",
  "claude/agents/docs-editor.md",
  "claude/agents/evidence-analyst.md",
  "claude/agents/release-engineer.md",
  "codex/AGENTS.routing.md",
  "codex/agents/docs-editor.toml",
  "codex/agents/evidence-analyst.toml",
  "codex/agents/release-engineer.toml",
  "kiro/agents/docs-editor.json",
  "kiro/agents/evidence-analyst.json",
  "kiro/agents/release-engineer.json",
  "kiro/steering/hindsight-routing.md",
  "kirocrew/create-bots.sh",
  "kirocrew/skills/docs-editor/SKILL.md",
  "kirocrew/skills/evidence-analyst/SKILL.md",
  "kirocrew/skills/release-engineer/SKILL.md",
  "kirocrew/steering/hindsight-routing.md",
  "knowledge/coverage.json",
  "knowledge/lessons.json",
  "knowledge/playbooks/settings-panel-review.md",
  "knowledge/roles/docs-editor.md",
  "knowledge/roles/evidence-analyst.md",
  "knowledge/roles/release-engineer.md",
  "knowledge/shared.md",
];

function frontmatterOf(content: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (!match?.[1]) throw new Error("no frontmatter");
  return Object.fromEntries(
    match[1].split("\n").map((line) => {
      const at = line.indexOf(": ");
      const value = line.slice(at + 2);
      return [line.slice(0, at), value.startsWith('"') ? JSON.parse(value) : value];
    }),
  );
}

describe("subagent tree render", () => {
  it("matches the golden tree for every target", () => {
    expectGolden("all", { target: "all" });
  });

  it("matches the golden Kiro Crew tree with a pinned model", () => {
    expectGolden("kirocrew-pinned", { target: "kirocrew", pinModel: "opus-5.5" });
  });

  it("labels older saved preference results in the README and keeps their original provenance", () => {
    const artifact = sample();
    artifact.resolved = [
      { stage: "generalize", unit: "saved agreements", runner: "codex", model: "saved-model" },
    ];
    const tree = renderSubagentTree(artifact, { target: "codex" });
    expect(tree.get("README.md")).toContain(
      "| generalize | codex | saved-model | saved preferences |",
    );
    expect(artifact.resolved[0]?.unit).toBe("saved agreements");
  });
  it("renders exactly the tree of plan section 4, sorted", () => {
    expect([...renderSubagentTree(sample(), { target: "all" }).keys()]).toEqual(ALL_PATHS);
  });

  it.each(SUBAGENT_TARGETS)("limits --target %s to its folder plus the shared files", (target) => {
    const all = renderSubagentTree(sample(), { target: "all" });
    const one = renderSubagentTree(sample(), { target });
    const expected = ALL_PATHS.filter(
      (file) =>
        file === "README.md" ||
        file === "HANDOFF.md" ||
        file.startsWith("knowledge/") ||
        file.startsWith(`${target}/`),
    );
    expect([...one.keys()]).toEqual(expected);
    for (const [file, content] of one) expect(content).toBe(all.get(file));
  });

  it("is deterministic and keeps every path inside the tree", () => {
    const first = renderSubagentTree(sample(), { target: "all" });
    expect(renderSubagentTree(sample(), { target: "all" })).toEqual(first);
    for (const file of first.keys()) {
      expect(file.startsWith("/")).toBe(false);
      expect(file.split("/")).not.toContain("..");
    }
  });

  it("writes no project name or absolute path into role, routing or shared text", () => {
    const artifact = sample();
    const tree = renderSubagentTree(artifact, { target: "all" });
    for (const [file, content] of tree) {
      if (file.startsWith("knowledge/playbooks/") || file === "knowledge/lessons.json") continue;
      expect([file, projectNameViolations(content, artifact.projects)]).toEqual([file, []]);
    }
    expect(tree.get("knowledge/playbooks/settings-panel-review.md")).toContain("webapp");
  });

  it("routes from role fields only and repeats the same table for every harness", () => {
    const tree = renderSubagentTree(sample(), { target: "all" });
    const table = (file: string) => (tree.get(file) ?? "").split("\n").slice(1).join("\n");
    expect(table("codex/AGENTS.routing.md")).toBe(table("claude/CLAUDE.routing.md"));
    expect(table("kiro/steering/hindsight-routing.md")).toBe(table("claude/CLAUDE.routing.md"));
    expect(tree.get("claude/CLAUDE.routing.md")).toContain(
      "| evidence-analyst | The task needs a number, a comparison or a conclusion drawn from data, records or experiments. | Changing production data, or writing the final prose of a document. |",
    );
  });

  it("inherits the model by default and pins it only when asked", () => {
    const inherit = renderSubagentTree(sample(), { target: "all" });
    expect(frontmatterOf(inherit.get("claude/agents/evidence-analyst.md") ?? "")).toEqual({
      name: "evidence-analyst",
      description: sample().roles[0]?.description,
      model: "inherit",
    });
    expect(JSON.parse(inherit.get("kiro/agents/evidence-analyst.json") ?? "")).not.toHaveProperty(
      "model",
    );
    expect(inherit.get("kirocrew/create-bots.sh")).not.toContain("--model");
    const pinned = renderSubagentTree(sample(), { target: "all", pinModel: "opus-5.5" });
    expect(frontmatterOf(pinned.get("claude/agents/evidence-analyst.md") ?? "").model).toBe(
      "opus-5.5",
    );
    expect(JSON.parse(pinned.get("kiro/agents/evidence-analyst.json") ?? "").model).toBe(
      "opus-5.5",
    );
    expect(pinned.get("kirocrew/create-bots.sh")).toContain(
      "--kiro-agent kirocrew --model 'opus-5.5'",
    );
    expect(parseToml(pinned.get("codex/agents/evidence-analyst.toml") ?? "")).not.toHaveProperty(
      "model",
    );
  });

  it("writes Codex custom agents as TOML with name, description and instructions only", () => {
    const tree = renderSubagentTree(sample(), { target: "codex" });
    const claude = renderSubagentTree(sample(), { target: "claude" });
    for (const role of sample().roles) {
      const agent = parseToml(tree.get(`codex/agents/${role.name}.toml`) ?? "");
      expect(Object.keys(agent)).toEqual(["name", "description", "developer_instructions"]);
      expect(agent.name).toBe(role.name);
      expect(agent.description).toBe(role.description);
      // The same body the Claude Code agent carries after its frontmatter.
      const body = (claude.get(`claude/agents/${role.name}.md`) ?? "").replace(
        /^---\n[\s\S]*?\n---\n\n/,
        "",
      );
      expect(agent.developer_instructions).toBe(body);
      expect(agent.developer_instructions).toContain(`knowledge/roles/${role.name}.md`);
    }
  });

  it("escapes quotes, backslashes and control characters in Codex TOML", () => {
    const artifact = sample();
    const role = artifact.roles[0];
    if (!role) throw new Error("Expected a sample role.");
    role.description = 'Says "hi" \\ back\tand \u0007 bells';
    role.prompt = `${role.prompt}\nA """triple""" quote, """" four, a \\path\\, a tab\there, a CR\r and DEL \u007f.\n"`;
    const text = renderSubagentTree(artifact, { target: "codex" }).get(
      `codex/agents/${role.name}.toml`,
    );
    const agent = parseToml(text ?? "");
    expect(agent.description).toBe(role.description);
    expect(agent.developer_instructions).toContain(role.prompt.trim());
    expect(text).not.toMatch(/"{3}[^\n]/);
  });

  it("refuses a pinned model with spaces or quotes", () => {
    expect(() => renderSubagentTree(sample(), { target: "all", pinModel: "a b" })).toThrow(
      /--pin-model/,
    );
    expect(() => renderSubagentTree(sample(), { target: "all", pinModel: "x'y" })).toThrow();
  });

  it("writes valid Kiro agent specs with name, description and prompt only", () => {
    const tree = renderSubagentTree(sample(), { target: "kiro" });
    for (const role of sample().roles) {
      const spec = JSON.parse(tree.get(`kiro/agents/${role.name}.json`) ?? "");
      expect(Object.keys(spec)).toEqual(["name", "description", "prompt"]);
      expect(spec.name).toBe(role.name);
      expect(spec.prompt).toContain(`knowledge/roles/${role.name}.md`);
    }
  });

  it("writes Kiro Crew skills with triggers, prompt and the role's lessons", () => {
    const tree = renderSubagentTree(sample(), { target: "kirocrew" });
    const skill = tree.get("kirocrew/skills/evidence-analyst/SKILL.md") ?? "";
    expect(frontmatterOf(skill)).toEqual({
      name: "evidence-analyst",
      description: sample().roles[0]?.description,
      triggers: "analyze data, compare results, where is this number, evaluation",
    });
    expect(skill).toContain(sample().roles[0]?.prompt?.slice(0, 60));
    expect(skill).toContain(
      "## Trace every reported number to its source (trace-numbers-to-source)",
    );
    expect(skill).toContain(
      "## Match the answer's length to the question (match-length-to-question)",
    );
    const noTriggers = tree.get("kirocrew/skills/docs-editor/SKILL.md") ?? "";
    expect(Object.keys(frontmatterOf(noTriggers))).toEqual(["name", "description"]);
  });

  it("falls back to a placeholder prompt built from role fields when stage C has not run", () => {
    const tree = renderSubagentTree(sample(), { target: "claude" });
    const agent = tree.get("claude/agents/docs-editor.md") ?? "";
    expect(agent).toContain("You are the Docs editor specialist.");
    expect(agent).toContain(`Take a task when: ${sample().roles[2]?.delegate_when}`);
  });

  it("single-quotes names in create-bots.sh and escapes embedded quotes", () => {
    const artifact = sample();
    const role = artifact.roles[0];
    if (role) role.display_name = "Ana's analyst $(rm)";
    artifact.coverage = computeCoverage(artifact);
    const script = renderSubagentTree(artifact, { target: "kirocrew" }).get(
      "kirocrew/create-bots.sh",
    );
    expect(script?.split("\n").slice(0, 1)).toEqual(["#!/usr/bin/env sh"]);
    expect(script).toContain("\nset -eu\n");
    expect(script).toContain(
      "kirocrew agent create --name 'evidence-analyst' --display-name 'Ana'\\''s analyst $(rm)' --kiro-agent kirocrew\n",
    );
  });

  it("quotes a YAML-ambiguous description", () => {
    const artifact = sample();
    const role = artifact.roles[0];
    if (role) role.description = "Reviews: data, #numbers and 'quotes'";
    const agent = renderSubagentTree(artifact, { target: "claude" }).get(
      "claude/agents/evidence-analyst.md",
    );
    expect(agent).toContain(`description: "Reviews: data, #numbers and 'quotes'"`);
    expect(frontmatterOf(agent ?? "").description).toBe("Reviews: data, #numbers and 'quotes'");
  });

  it("renders the canonical lessons and coverage as JSON", () => {
    const artifact = sample();
    const tree = renderSubagentTree(artifact, { target: "knowledge" });
    expect(JSON.parse(tree.get("knowledge/lessons.json") ?? "")).toEqual({
      lessons: artifact.lessons,
      set_aside: artifact.set_aside,
      shared: artifact.shared,
      playbooks: artifact.playbooks,
    });
    expect(JSON.parse(tree.get("knowledge/coverage.json") ?? "")).toEqual(artifact.coverage);
  });
});
