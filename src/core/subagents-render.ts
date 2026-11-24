import { counted } from "../ui/style.js";
import { isPlanLabel } from "./model-plan.js";
import type { Lesson, Role, SuggestionArtifact } from "./subagents.js";
import { rolePaths, type SubagentTarget } from "./subagents-paths.js";

export { rolePaths, SUBAGENT_TARGETS, type SubagentTarget } from "./subagents-paths.js";

/**
 * core/subagents-render.ts: render a saved suggestion to a file tree.
 *
 * A pure function from `suggestion.json` to a map of relative path to UTF-8
 * text. The GUI zips this map in memory,
 * `suggest-subagents --export` writes it to a directory the person names, and
 * the tests compare it with committed golden files. Nothing here touches the
 * filesystem or a model.
 *
 * Every target gets `README.md`, `HANDOFF.md` and `knowledge/`, because the
 * harness files point back into `knowledge/` and the handoff explains all of
 * it. `--target` then adds one harness directory, or all of them.
 *
 * Routing text (the delegate table) is generated from role fields only, so no
 * dated incident or project detail can reach it except through those fields.
 * Model is a render setting: harness files inherit the session model unless
 * `pinModel` is given.
 *
 * Output is deterministic: paths sorted by code point, fixed formatting, and
 * the only date is the artifact's own `generated_at`. Every path is checked to
 * stay inside the tree.
 */

export interface RenderOptions {
  target: SubagentTarget | "all";
  pinModel?: string;
}

const REFRESH_COMMAND = "human-hindsight suggest-subagents";

/** YAML scalar: plain when unambiguous, else a JSON string (valid YAML double-quoted). */
function yamlScalar(value: string): string {
  const plain =
    /^[A-Za-z0-9(][^\r\n]*$/.test(value) &&
    !/: |\s#|:$/.test(value) &&
    !/^(?:true|false|null|yes|no|on|off|~)$/i.test(value);
  return plain ? value : JSON.stringify(value);
}

/** POSIX single-quote a shell word. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Markdown table cell: one line, pipes escaped. */
function cell(value: string): string {
  return value
    .replace(/\s*[\r\n]+\s*/g, " ")
    .replaceAll("|", "\\|")
    .trim();
}

function date(artifact: SuggestionArtifact): string {
  return artifact.generated_at.slice(0, 10);
}

function lessonBlock(lesson: Lesson): string {
  const lines = [`## ${lesson.title} (${lesson.id})`, "", lesson.instruction.trim()];
  if (lesson.applies_when.trim()) lines.push("", `Applies when: ${lesson.applies_when.trim()}`);
  if (lesson.exceptions.trim()) lines.push("", `Exceptions: ${lesson.exceptions.trim()}`);
  return lines.join("\n");
}

function lessonBlocks(ids: string[], lessons: Map<string, Lesson>): string {
  return ids
    .map((id) => lessons.get(id))
    .filter((lesson): lesson is Lesson => Boolean(lesson))
    .map(lessonBlock)
    .join("\n\n");
}

/** Stage C output, or a plain paragraph built from role fields when stage C has not run. */
function rolePrompt(role: Role): string {
  if (role.prompt?.trim()) return role.prompt.trim();
  return [
    `You are the ${role.display_name} specialist. ${role.description}`,
    "",
    `Take a task when: ${role.delegate_when}`,
    "",
    `Do not take: ${role.not_for}`,
    "",
    "Read the lessons for this role before starting and follow them, including their conditions and exceptions. The current request and the project's own instructions take precedence over them.",
    "",
    "When you finish, return a short handoff to the coordinator: what you did, what you verified and how, and what remains open.",
  ].join("\n");
}

function agentBody(role: Role): string {
  return [
    rolePrompt(role),
    "",
    `The lessons for this role are in \`knowledge/roles/${role.name}.md\`, and the agreements every specialist shares are in \`knowledge/shared.md\`, both relative to the folder these files were exported to.`,
  ].join("\n");
}

/** YAML frontmatter; the role name is kebab-case and always plain. */
function frontmatter(fields: [string, string][]): string {
  return ["---", ...fields.map(([key, value]) => `${key}: ${yamlScalar(value)}`), "---"].join("\n");
}

function routingTable(artifact: SuggestionArtifact): string {
  const rows = artifact.roles.map(
    (role) => `| ${role.name} | ${cell(role.delegate_when)} | ${cell(role.not_for)} |`,
  );
  return [
    "For substantial work, delegate a well-defined, independent part to the specialist whose row matches it, and handle small edits and simple lookups directly.",
    "The coordinating assistant stays responsible for the user's goal, the decisions made along the way, and the final integration of delegated work.",
    "A specialist does not route work to another specialist; it returns its result to the coordinator.",
    "",
    "| Specialist | Delegate when | Not for |",
    "| --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function routingBlock(artifact: SuggestionArtifact, destination: string): string {
  return [
    `<!-- human-hindsight suggested subagents · generated ${date(artifact)} · ${destination} -->`,
    "## Specialist routing",
    "",
    routingTable(artifact),
    "",
  ].join("\n");
}

function readme(artifact: SuggestionArtifact): string {
  const { coverage } = artifact;
  const models = (["generalize", "propose", "author"] as const)
    .map((stage) => `${stage} ${artifact.models[stage] ?? "runner default"}`)
    .join(", ");
  const selection =
    artifact.selection === "accepted"
      ? "the preferences accepted in review"
      : "every preference candidate that was not dismissed";
  const provenance = new Map<string, { columns: string[]; units: string[] }>();
  for (const result of artifact.resolved ?? []) {
    const columns = [result.stage, result.runner, result.model ?? "CLI default"];
    const key = JSON.stringify(columns);
    const row = provenance.get(key) ?? { columns, units: [] };
    row.units.push(result.unit);
    provenance.set(key, row);
  }
  const generation = provenance.size
    ? [
        `Generated ${artifact.generated_at} from ${selection}.`,
        "",
        "| Stage | CLI | Model | Results |",
        "| --- | --- | --- | --- |",
        ...[...provenance.values()].map(
          ({ columns, units }) => `| ${[...columns, units.join(", ")].map(cell).join(" | ")} |`,
        ),
      ]
    : [
        `Generated ${artifact.generated_at} with the ${artifact.runner} runner (${models}) from ${selection}.`,
      ];
  return [
    "# Suggested subagents",
    "",
    "This folder holds specialist roles suggested by human-hindsight from your own coding-agent sessions, rendered for Claude Code, Codex, Kiro CLI and Kiro Crew. Each role owns a set of lessons, written as an instruction with the conditions it applies under and its exceptions. Nothing here is installed; you decide which files to copy and where.",
    "",
    ...generation,
    "",
    `- ${counted(coverage.source_candidates, "input")}: ${coverage.mapped} became lessons, ${coverage.set_aside} were set aside`,
    `- ${counted(artifact.lessons.length, "lesson")}: ${coverage.disposition_counts.generalized} generalized, ${coverage.disposition_counts.contextual} contextual, ${coverage.disposition_counts.historical} historical`,
    `- ${counted(artifact.roles.length, "role")}, ${counted(coverage.shared_count, "shared lesson")}, ${counted(coverage.playbook_count, "playbook")}`,
    "",
    "## Layout",
    "",
    "- `HANDOFF.md`: a request you can paste to a coding agent to create these specialists.",
    "- `knowledge/`: the lessons (`lessons.json`), shared agreements, playbooks, one file per role, and the coverage ledger.",
    "- `claude/`, `codex/`, `kiro/`, `kirocrew/`: the same roles in each harness's format, when exported.",
    "",
    "## Refreshing",
    "",
    `Run \`${REFRESH_COMMAND}\` again after reviewing more preferences. The saved suggestion is marked stale when the reviewed set changes, and the GUI shows that. This folder is a copy and is not updated in place.`,
    "",
  ].join("\n");
}

function handoff(artifact: SuggestionArtifact, opts: RenderOptions): string {
  const roles = artifact.roles.map(
    (role) => `- \`${role.name}\` (${role.display_name}): ${role.description}`,
  );
  const model = opts.pinModel
    ? `The files pin the model \`${opts.pinModel}\`.`
    : "The files do not pin a model, so each specialist uses the session's model.";
  return [
    "# Create these specialists",
    "",
    "Paste this file to a coding agent, together with the folder it sits in.",
    "",
    "---",
    "",
    `Please create the following ${counted(artifact.roles.length, "specialist")} for the harness I choose, from the files in this folder. Ask me which harness, and where the files should go, before writing anything. ${model}`,
    "",
    ...roles,
    "",
    "Every specialist carries the agreements in `knowledge/shared.md`. Its own lessons are in `knowledge/roles/<name>.md`.",
    "",
    "## Claude Code",
    "",
    "Copy `claude/agents/*.md` into the agents directory I choose (`~/.claude/agents/` for every project, or `.claude/agents/` in one repository). Add the block in `claude/CLAUDE.routing.md` to the matching `CLAUDE.md`. Keep `knowledge/` where the agent files can reach it, and update the path in each agent file if it moves.",
    "",
    "## Codex",
    "",
    "Copy `codex/agents/*.toml` into `~/.codex/agents/` (the `agents/` folder under `CODEX_HOME` when that is set). Each file is a Codex custom agent with `name`, `description` and `developer_instructions`, which Codex offers as a role when it spawns a subagent. The Codex files set no model, so each agent uses the session's model. Add the block in `codex/AGENTS.routing.md` to the matching `AGENTS.md`. Keep `knowledge/` where the agents can reach it, and update the path in each file if it moves.",
    "",
    "## Kiro CLI",
    "",
    "Copy `kiro/agents/*.json` into `~/.kiro/agents/` (or `.kiro/agents/` in one repository) and `kiro/steering/hindsight-routing.md` into the matching `steering/` directory.",
    "",
    "## Kiro Crew",
    "",
    "1. Run `kirocrew/create-bots.sh` to create one Bot per role.",
    "2. For each Bot, open its editor and set the description and triggers from the frontmatter of the matching `kirocrew/skills/<name>/SKILL.md`.",
    "3. Copy the `kirocrew/skills/` directories into `~/.kiro/crew/skills/`.",
    "4. Copy `kirocrew/steering/hindsight-routing.md` into `~/.kiro/steering/`.",
    "",
    "---",
    "",
    "You decide where these files go. human-hindsight wrote nothing outside this folder.",
    "",
  ].join("\n");
}

function sharedDoc(artifact: SuggestionArtifact, lessons: Map<string, Lesson>): string {
  const body = lessonBlocks(artifact.shared, lessons);
  return [
    "# Shared agreements",
    "",
    `Every specialist carries these ${counted(artifact.shared.length, "lesson")}. The current request and the project's own instructions take precedence over them.`,
    ...(body ? ["", body] : []),
    "",
  ].join("\n");
}

function roleDoc(role: Role, lessons: Map<string, Lesson>): string {
  return [
    `# ${role.display_name} (${role.name}): ${counted(role.lesson_ids.length, "lesson")}`,
    "",
    role.description,
    "",
    `Delegate when: ${role.delegate_when}`,
    "",
    `Not for: ${role.not_for}`,
    "",
    lessonBlocks(role.lesson_ids, lessons),
    "",
  ].join("\n");
}

function playbookDoc(
  playbook: SuggestionArtifact["playbooks"][number],
  lessons: Map<string, Lesson>,
): string {
  return [
    `# Playbook: ${playbook.name}`,
    "",
    playbook.purpose,
    "",
    lessonBlocks(playbook.lesson_ids, lessons),
    "",
  ].join("\n");
}

function claudeAgent(role: Role, pinModel?: string): string {
  return [
    frontmatter([
      ["name", role.name],
      ["description", role.description],
      ["model", pinModel ?? "inherit"],
    ]),
    "",
    agentBody(role),
    "",
  ].join("\n");
}

/**
 * Escape text for a TOML basic string. In the multi-line form, newlines and
 * tabs stay literal and a quote is escaped only where it would make a third in
 * a row, so prose reads naturally; every backslash and other control character
 * is escaped in both forms.
 */
function tomlEscape(value: string, multiline: boolean): string {
  let out = "";
  let quotes = 0;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char === '"') {
      if (multiline && quotes < 2) {
        out += char;
        quotes++;
      } else {
        out += '\\"';
        quotes = 0;
      }
      continue;
    }
    quotes = 0;
    if (char === "\\") out += "\\\\";
    else if (multiline && (char === "\n" || char === "\t")) out += char;
    else if (char === "\n") out += "\\n";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f)
      out += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    else out += char;
  }
  return out;
}

/**
 * Codex custom agent: a standalone TOML file with `name`, `description` and
 * `developer_instructions`, read from `~/.codex/agents/` (the `agents/` folder
 * under `CODEX_HOME`). Checked against Codex CLI 0.171.0 on 2026-11-21: a file
 * of this shape in `$CODEX_HOME/agents/` was listed under "Available roles" in
 * the `spawn_agent` tool by `codex debug prompt-input`, which makes no model
 * call, and the role took its name from the `name` key, not the file name. The
 * binary also rejects a role file without a non-blank `developer_instructions`.
 * No model is written, so the agent uses the session's model; `--pin-model`
 * ids are meant for the other targets.
 */
function codexAgent(role: Role, artifact: SuggestionArtifact): string {
  return [
    `# human-hindsight suggested subagent · generated ${date(artifact)}`,
    `# Codex custom agent: copy to ~/.codex/agents/${role.name}.toml`,
    `name = "${tomlEscape(role.name, false)}"`,
    `description = "${tomlEscape(role.description, false)}"`,
    `developer_instructions = """\n${tomlEscape(agentBody(role), true)}\n"""`,
    "",
  ].join("\n");
}

/** Same key order and style as the runner's `writeNoToolsAgent`; tools omitted so defaults apply. */
function kiroAgent(role: Role, pinModel?: string): string {
  const config = {
    name: role.name,
    description: role.description,
    prompt: agentBody(role),
    ...(pinModel ? { model: pinModel } : {}),
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

function createBots(artifact: SuggestionArtifact, pinModel?: string): string {
  const lines = artifact.roles.map(
    (role) =>
      `kirocrew agent create --name ${shellQuote(role.name)} --display-name ${shellQuote(role.display_name)} --kiro-agent kirocrew${pinModel ? ` --model ${shellQuote(pinModel)}` : ""}`,
  );
  return [
    "#!/usr/bin/env sh",
    `# human-hindsight suggested subagents · generated ${date(artifact)}`,
    "# Creates one Kiro Crew Bot per suggested role. Read it before running it.",
    "# Then set each Bot's description and triggers from kirocrew/skills/<name>/SKILL.md.",
    "set -eu",
    ...lines,
    "",
  ].join("\n");
}

function kirocrewSkill(
  role: Role,
  artifact: SuggestionArtifact,
  lessons: Map<string, Lesson>,
): string {
  const triggers = role.triggers?.map((trigger) => trigger.trim()).filter(Boolean) ?? [];
  const shared = lessonBlocks(artifact.shared, lessons);
  return [
    "---",
    `name: ${role.name}`,
    `description: ${yamlScalar(role.description)}`,
    // A plain comma list, the form the existing Kiro Crew skills use. The
    // schema forbids commas inside a trigger, so the join is unambiguous.
    ...(triggers.length ? [`triggers: ${triggers.join(", ")}`] : []),
    "---",
    "",
    rolePrompt(role),
    "",
    `# Lessons for ${role.name}`,
    "",
    lessonBlocks(role.lesson_ids, lessons),
    ...(shared ? ["", "# Shared agreements", "", shared] : []),
    "",
  ].join("\n");
}

function assertInsideTree(file: string): void {
  if (
    !file ||
    file.startsWith("/") ||
    file.includes("\\") ||
    file.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Refusing to render a path outside the tree: ${JSON.stringify(file)}`);
  }
}

function inTarget(file: string, target: RenderOptions["target"]): boolean {
  if (target === "all") return true;
  const top = file.split("/")[0];
  if (top === "README.md" || top === "HANDOFF.md" || top === "knowledge") return true;
  return top === target;
}

/** Render the suggestion as a sorted map of relative path to file content. */
export function renderSubagentTree(
  artifact: SuggestionArtifact,
  opts: RenderOptions,
): Map<string, string> {
  if (opts.pinModel !== undefined && !/^[^\s'"`]+$/.test(opts.pinModel)) {
    throw new Error("--pin-model must be a single model id with no spaces or quotes.");
  }
  if (isPlanLabel(opts.pinModel?.toLowerCase())) {
    throw new Error("Use a concrete model id for --pin-model.");
  }
  const lessons = new Map(artifact.lessons.map((lesson) => [lesson.id, lesson]));
  const files = new Map<string, string>();
  files.set("README.md", readme(artifact));
  files.set("HANDOFF.md", handoff(artifact, opts));
  files.set(
    "knowledge/lessons.json",
    `${JSON.stringify(
      {
        lessons: artifact.lessons,
        set_aside: artifact.set_aside,
        shared: artifact.shared,
        playbooks: artifact.playbooks,
      },
      null,
      2,
    )}\n`,
  );
  files.set("knowledge/shared.md", sharedDoc(artifact, lessons));
  files.set("knowledge/coverage.json", `${JSON.stringify(artifact.coverage, null, 2)}\n`);
  for (const playbook of artifact.playbooks) {
    files.set(`knowledge/playbooks/${playbook.name}.md`, playbookDoc(playbook, lessons));
  }
  for (const role of artifact.roles) {
    const paths = rolePaths(role.name);
    files.set(paths.knowledge, roleDoc(role, lessons));
    files.set(paths.claude, claudeAgent(role, opts.pinModel));
    files.set(paths.codex, codexAgent(role, artifact));
    files.set(paths.kiro, kiroAgent(role, opts.pinModel));
    files.set(paths.kirocrew, kirocrewSkill(role, artifact, lessons));
  }
  files.set("claude/CLAUDE.routing.md", routingBlock(artifact, "add to CLAUDE.md"));
  files.set("codex/AGENTS.routing.md", routingBlock(artifact, "add to AGENTS.md"));
  files.set(
    "kiro/steering/hindsight-routing.md",
    routingBlock(artifact, "save as ~/.kiro/steering/hindsight-routing.md"),
  );
  files.set(
    "kirocrew/steering/hindsight-routing.md",
    routingBlock(artifact, "save as ~/.kiro/steering/hindsight-routing.md; Kiro Crew reads it too"),
  );
  files.set("kirocrew/create-bots.sh", createBots(artifact, opts.pinModel));

  const sorted = new Map<string, string>();
  for (const file of [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    assertInsideTree(file);
    if (inTarget(file, opts.target)) sorted.set(file, files.get(file) ?? "");
  }
  return sorted;
}
