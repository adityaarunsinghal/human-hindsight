import { z } from "zod";
import { HISTORICAL_DATA_INSTRUCTION } from "../../core/preference-evidence.js";
import {
  type Lesson,
  MAX_LESSON_FAN_OUT,
  MAX_ROLE_LESSONS,
  MAX_SHARED,
} from "../../core/subagents.js";

/**
 * suggest-subagents stage B: propose prompt builder.
 *
 * One call over the compact lesson list (id, title, one-line instruction,
 * disposition, source count) groups the lessons into functional roles, shared
 * agreements and playbooks. When the list exceeds the input budget the command
 * proposes per window and reconciles the window results with one merge call
 * ({@link buildProposeMergePrompt}), mirroring windowed clustering.
 *
 * The caps (role count, lessons per role, fan-out, shared size) are stated in
 * the prompt so the model can meet them, and enforced afterwards by rules P1 to
 * P8 in `core/subagent-checks.ts`. The response schema is structural only.
 * Roles carry no prompt or triggers here; stage C writes those.
 *
 * `PROPOSE_PROMPT_VERSION` is saved in `suggestion.json` as
 * `prompt_versions.propose` and must equal `SUGGEST_PROMPT_VERSIONS.propose` in
 * `core/subagents.ts`. Bump both on any meaningful change to either prompt.
 */
export const PROPOSE_PROMPT_VERSION = 1;

export const ProposedRoleSchema = z.object({
  name: z.string(),
  display_name: z.string(),
  description: z.string(),
  delegate_when: z.string(),
  not_for: z.string(),
  lesson_ids: z.array(z.string()),
});
export type ProposedRole = z.infer<typeof ProposedRoleSchema>;

export const ProposeSchema = z.object({
  roles: z.array(ProposedRoleSchema),
  shared: z.array(z.string()),
  playbooks: z.array(
    z.object({ name: z.string(), purpose: z.string(), lesson_ids: z.array(z.string()) }),
  ),
});
export type ProposeOutput = z.infer<typeof ProposeSchema>;

/** Role-count bounds for one call. A window may propose none; the final result may not. */
export interface RoleBounds {
  minRoles: number;
  maxRoles: number;
}

/** One lesson as the propose stage sees it: a JSON line. Also the unit the window budget measures. */
export function renderLessonCard(lesson: Lesson): string {
  return JSON.stringify({
    id: lesson.id,
    title: lesson.title,
    instruction: lesson.instruction.replace(/\s+/g, " ").trim(),
    disposition: lesson.disposition,
    sources: lesson.source_ids.length,
  });
}

function roleCountRule(bounds: RoleBounds): string {
  return bounds.minRoles === 0
    ? `- Propose at most ${bounds.maxRoles} roles, or none if no lesson below needs one.`
    : `- Propose between ${bounds.minRoles} and ${bounds.maxRoles} roles.`;
}

/** The grouping rules shared by the propose and merge prompts. */
function groupingRules(bounds: RoleBounds, projects: string[]): string[] {
  return [
    "- A role is a functional specialty, such as reviewing changes, analyzing data or",
    "  editing documents. Never name a role after a project, product, team or person.",
    roleCountRule(bounds),
    "- Each role has:",
    '  - "name": unique kebab-case, 3 to 40 characters.',
    '  - "display_name": one line, at most 60 characters.',
    '  - "description": one line, at most 200 characters.',
    '  - "delegate_when": when a coordinator should hand work to it, at most 400 characters.',
    '  - "not_for": work it should not take, at most 400 characters.',
    `  - "lesson_ids": the lessons it owns, 1 to ${MAX_ROLE_LESSONS}.`,
    `- Put a generalized lesson in "shared" only if every role needs it; at most ${MAX_SHARED}.`,
    "  A shared lesson does not also need to be listed in a role.",
    `- A lesson may be in at most ${MAX_LESSON_FAN_OUT} roles. Prefer exactly one.`,
    "- Contextual and historical lessons go only in playbooks, never in a role or in",
    '  "shared". They may also be left out.',
    '- A playbook has "name" (unique kebab-case, at most 60 characters), "purpose"',
    '  (at most 600 characters) and "lesson_ids". Use playbooks for related lessons',
    "  that do not justify a role.",
    '- Every generalized lesson is in at least one role, in "shared" or in a playbook.',
    "- Use only the lesson ids listed below and copy them verbatim.",
    `- Keep project names out of role text. Project names in this library: ${
      projects.length ? projects.join(", ") : "none recorded"
    }`,
  ];
}

/** Build the stage B prompt over the compact cards of `lessons`. */
export function buildProposePrompt(
  lessons: Lesson[],
  bounds: RoleBounds,
  projects: string[],
): string {
  return [
    "You are proposing specialist roles that a coordinating coding agent can delegate",
    "bounded work to. The lessons below were generalized from one person's working",
    "preferences.",
    HISTORICAL_DATA_INSTRUCTION,
    "",
    'Group the lessons into "roles", "shared" agreements and "playbooks":',
    ...groupingRules(bounds, projects),
    "",
    `=== LESSONS (${lessons.length}) ===`,
    ...lessons.map(renderLessonCard),
    "=== END LESSONS ===",
  ].join("\n");
}

/**
 * Build the stage B merge prompt (windowed propose only). Each window proposed
 * roles without seeing the other windows' lessons, so the same specialty can
 * appear twice under different names. The model returns one combined result
 * over every lesson the windows placed.
 */
export function buildProposeMergePrompt(
  windowResults: ProposeOutput[],
  lessons: Lesson[],
  bounds: RoleBounds,
  projects: string[],
): string {
  const notPortable = lessons
    .filter((lesson) => lesson.disposition !== "generalized")
    .map((lesson) => lesson.id);
  return [
    "You are reconciling specialist-role proposals made over separate windows of one",
    "lesson list. Different windows may propose the same specialty under different",
    "names, and a lesson shared in one window may belong to a role in the combined result.",
    HISTORICAL_DATA_INSTRUCTION,
    "",
    'Return one combined "roles", "shared" and "playbooks":',
    "- Merge roles that cover the same specialty and take the union of their lesson ids.",
    "- Merge playbooks with the same purpose the same way.",
    "- Keep every lesson id that a window placed somewhere.",
    ...groupingRules(bounds, projects),
    `- Contextual and historical lesson ids: ${notPortable.length ? notPortable.join(", ") : "none"}.`,
    "",
    `=== PROPOSALS (${windowResults.length}) ===`,
    ...windowResults.map((result, index) => `window ${index + 1}: ${JSON.stringify(result)}`),
    "=== END PROPOSALS ===",
  ].join("\n");
}
