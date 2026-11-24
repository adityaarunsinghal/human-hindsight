export type SubagentTarget = "claude" | "codex" | "kiro" | "kirocrew" | "knowledge";
export const SUBAGENT_TARGETS: readonly SubagentTarget[] = [
  "claude",
  "codex",
  "kiro",
  "kirocrew",
  "knowledge",
];
/**
 * The per-role files of the tree, by target. The renderer writes exactly these
 * paths and the GUI groups a role's files by them, so the two cannot drift.
 */
export function rolePaths(name: string): Record<SubagentTarget, string> {
  return {
    claude: `claude/agents/${name}.md`,
    codex: `codex/agents/${name}.toml`,
    kiro: `kiro/agents/${name}.json`,
    kirocrew: `kirocrew/skills/${name}/SKILL.md`,
    knowledge: `knowledge/roles/${name}.md`,
  };
}
