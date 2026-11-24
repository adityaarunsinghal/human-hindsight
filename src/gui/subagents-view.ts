import type { Coverage, Lesson, Role, SuggestionArtifact } from "../core/subagents.js";
import { rolePaths, SUBAGENT_TARGETS, type SubagentTarget } from "../core/subagents-paths.js";

/**
 * gui/subagents-view.ts: the DOM-free part of the Suggested subagents tab.
 *
 * Routes, the per-role file grouping, search text and the coverage rows are
 * plain functions so they can be tested in Node; `subagents-panel.ts` turns
 * them into elements. The tab only reads what `GET /api/subagents` returns:
 * the saved artifact and its rendered file tree.
 *
 * List and route keys. A role is `role/<name>`; the fixed views are `shared`,
 * `playbooks` and `coverage`. A role's address is `#subagents/<name>`, except
 * that a role whose name equals a view name is addressed as
 * `#subagents/role/<name>`, so both stay reachable and bookmarkable.
 */

const SUBAGENT_VIEWS = ["shared", "playbooks", "coverage"] as const;
export type SubagentView = (typeof SUBAGENT_VIEWS)[number];

export const TARGET_LABELS: Record<SubagentTarget, string> = {
  claude: "Claude Code",
  codex: "Codex",
  kiro: "Kiro CLI",
  kirocrew: "Kiro Crew",
  knowledge: "Knowledge",
};

/** The label of each choice in the export select. */
export function targetChoiceLabel(target: SubagentTarget | "all"): string {
  if (target === "all") return "All targets";
  return target === "knowledge" ? "Knowledge only" : TARGET_LABELS[target];
}

/** The export button says exactly what it downloads. */
export function exportLabel(target: SubagentTarget | "all"): string {
  return target === "all"
    ? "Download all targets (zip)"
    : `Download ${targetChoiceLabel(target)} (zip)`;
}

const EXPORT_ROUTE = "/api/subagents/export.zip";
const isView = (value: string): value is SubagentView =>
  (SUBAGENT_VIEWS as readonly string[]).includes(value);

export function roleKey(name: string): string {
  return `role/${name}`;
}

/** The location hash for a list key; an empty key is the tab itself. */
export function subagentsHash(key: string): string {
  if (!key) return "#subagents";
  if (!key.startsWith("role/")) return `#subagents/${encodeURIComponent(key)}`;
  const name = key.slice("role/".length);
  return isView(name) ? `#subagents/role/${name}` : `#subagents/${encodeURIComponent(name)}`;
}

/**
 * The list key for a hash without its leading `#`, or null when the hash
 * belongs to another tab. May throw on a malformed escape, like the other
 * tabs' bookmarks; the caller ignores those.
 */
export function subagentsKeyFromHash(hash: string): string | null {
  if (hash === "subagents") return "";
  if (!hash.startsWith("subagents/")) return null;
  const rest = decodeURIComponent(hash.slice("subagents/".length));
  if (rest.startsWith("role/")) return rest;
  return isView(rest) ? rest : rest ? roleKey(rest) : "";
}

export function exportHref(target: SubagentTarget | "all"): string {
  return target === "all" ? EXPORT_ROUTE : `${EXPORT_ROUTE}?target=${encodeURIComponent(target)}`;
}

/**
 * The download name for an export, from the artifact's own date. The server
 * sends it in Content-Disposition and the link carries it in `download`, so
 * the name holds even where a browser ignores one of them.
 */
export function exportFilename(generatedAt: string, target: SubagentTarget | "all"): string {
  return `hindsight-subagents-${generatedAt.slice(0, 10)}${target === "all" ? "" : `-${target}`}.zip`;
}

/** Search covers a role's name, display name, description and delegate-when text. */
export function roleSearchText(role: Role): string {
  return [role.name, role.display_name, role.description, role.delegate_when]
    .join(" ")
    .toLocaleLowerCase();
}

export interface RenderedFile {
  target: SubagentTarget;
  path: string;
  content: string;
}

/**
 * The rendered files that belong to one role, in `SUBAGENT_TARGETS` order.
 * The paths come from `rolePaths`, the same list `renderSubagentTree` writes;
 * the browser and renderer share only the path definitions.
 */
export function roleFiles(files: Record<string, string>, name: string): RenderedFile[] {
  const paths = rolePaths(name);
  return SUBAGENT_TARGETS.flatMap((target) => {
    const path = paths[target];
    const content = Object.hasOwn(files, path) ? files[path] : undefined;
    return content === undefined ? [] : [{ target, path, content }];
  });
}

/** One rendered knowledge file, when the tree has it. */
export function knowledgeFile(
  files: Record<string, string>,
  path: string,
): RenderedFile | undefined {
  const content = Object.hasOwn(files, path) ? files[path] : undefined;
  return content === undefined ? undefined : { target: "knowledge", path, content };
}

export function playbookPath(name: string): string {
  return `knowledge/playbooks/${name}.md`;
}

/** Leading YAML frontmatter, shown as source above the Markdown preview. */
export function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  return match
    ? { frontmatter: match[1] ?? "", body: text.slice(match[0].length) }
    : { frontmatter: "", body: text };
}

export function lessonLookup(artifact: SuggestionArtifact): Map<string, Lesson> {
  return new Map(artifact.lessons.map((lesson) => [lesson.id, lesson]));
}

/** The first source preference of a lesson and the text the stages saw for it. */
export function firstSource(
  artifact: SuggestionArtifact,
  lesson: Lesson,
): { id: string; text: string; more: number } | undefined {
  const id = lesson.source_ids[0];
  if (!id) return undefined;
  const input = artifact.inputs.find((candidate) => candidate.id === id);
  return { id, text: input?.text ?? id, more: lesson.source_ids.length - 1 };
}

export function countLabel(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The coverage ledger as table rows, in reading order. */
export function coverageRows(coverage: Coverage): [string, number][] {
  return [
    ["Preferences considered", coverage.source_candidates],
    ["Preferences used in agreements", coverage.mapped],
    ["Preferences left out", coverage.set_aside],
    ["General agreements", coverage.disposition_counts.generalized],
    ["Project-specific agreements", coverage.disposition_counts.contextual],
    ["One-time notes", coverage.disposition_counts.historical],
    ["Agreements shared by every role", coverage.shared_count],
    ["Playbooks", coverage.playbook_count],
  ];
}

/** Where a saved suggestion's source preference stands in the library now. */
export type SourceStatus = "current" | "dismissed" | "missing";

/**
 * The agreements whose source preferences were dismissed or left the library
 * since the suggestion was made, with how many of each. An export made now
 * still contains them, so the page marks them.
 */
export function changedAgreements(
  artifact: Pick<SuggestionArtifact, "lessons">,
  statusOf: (id: string) => SourceStatus,
): Map<string, { dismissed: number; missing: number }> {
  const changed = new Map<string, { dismissed: number; missing: number }>();
  for (const lesson of artifact.lessons) {
    const counts = { dismissed: 0, missing: 0 };
    for (const id of new Set(lesson.source_ids)) {
      const status = statusOf(id);
      if (status !== "current") counts[status]++;
    }
    if (counts.dismissed || counts.missing) changed.set(lesson.id, counts);
  }
  return changed;
}

/** The out-of-date banner: what changed, and what exporting now would include. */
export function staleSuggestionText(changed: number): string {
  const now = changed
    ? `Exporting now gives the roles as shown, including ${countLabel(changed, "agreement")} whose source preferences you dismissed or that left the library (marked below).`
    : "Exporting now gives the roles as shown.";
  return `The preferences these roles were made from changed since they were made. ${now} Run this to make them again:`;
}

/** Per-role lesson counts from the ledger, labeled with each role's display name. */
export function coverageRoleRows(artifact: SuggestionArtifact): [string, number][] {
  return artifact.roles.map((role) => [
    `${role.display_name} (${role.name})`,
    artifact.coverage.roles[role.name]?.lesson_count ?? 0,
  ]);
}
