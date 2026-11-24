import { z } from "zod";
import { HISTORICAL_DATA_INSTRUCTION } from "../../core/preference-evidence.js";
import type { Lesson } from "../../core/subagents.js";
import type { ProposedRole } from "./propose.js";

/**
 * suggest-subagents stage C: role prompt builder.
 *
 * One call per proposed role. The role card, its lessons in full and the
 * shared lessons go in; a harness-neutral standing prompt and 3 to 8 trigger
 * phrases come out. The renderer turns these into Claude Code, Codex, Kiro CLI
 * and Kiro Crew files, so the prompt must not assume any one of them.
 *
 * The bounds stated here are the saved-artifact bounds on `Role.prompt` and
 * `Role.triggers` in `core/subagents.ts`. Rules A1 to A3 in
 * `core/subagent-checks.ts` enforce them, together with the project-name check
 * and the rule that a lesson id named in the prompt belongs to this role or to
 * the shared agreements.
 *
 * `AUTHOR_ROLE_PROMPT_VERSION` is saved in `suggestion.json` as
 * `prompt_versions.author` and must equal `SUGGEST_PROMPT_VERSIONS.author` in
 * `core/subagents.ts`. Bump both on any meaningful change to the prompt text.
 */
export const AUTHOR_ROLE_PROMPT_VERSION = 2;

export const AuthorRoleSchema = z.object({
  prompt: z.string(),
  triggers: z.array(z.string()),
});
export type AuthorRoleOutput = z.infer<typeof AuthorRoleSchema>;

/** Input to {@link buildAuthorRolePrompt}. */
export interface AuthorRoleInput {
  role: ProposedRole;
  /** The role's own lessons, in full. */
  lessons: Lesson[];
  /** The lessons every role carries, in full. */
  shared: Lesson[];
  projects: string[];
}

function lessonLine(lesson: Lesson): string {
  return JSON.stringify({
    id: lesson.id,
    title: lesson.title,
    instruction: lesson.instruction,
    applies_when: lesson.applies_when,
    exceptions: lesson.exceptions,
  });
}

/** Build the stage C prompt for one role. */
export function buildAuthorRolePrompt(input: AuthorRoleInput): string {
  const { role } = input;
  return [
    "You are writing the standing prompt for one specialist coding agent. A coordinating",
    "agent delegates bounded pieces of work to it and integrates what it returns.",
    HISTORICAL_DATA_INSTRUCTION,
    "",
    "Write:",
    '- "prompt": about 4000 characters of Markdown, never more than 5500 (the hard limit is',
    '  6000 and anything past it is cut), addressed to the specialist as "you",',
    "  usable in any coding-agent product. Use these sections, in order:",
    "  - What you own.",
    "  - Boundary: what you do not do, and when to stop and report back instead.",
    "  - Method: numbered steps.",
    "  - Handoff format: what you return to the coordinator.",
    "  Build the method from the lessons below. Where a lesson shapes a step, put its id",
    "  in parentheses after the step, for example (lesson-id). Mention only the ids listed",
    "  below. Keep each lesson's conditions and exceptions.",
    "  Do not name projects, products, people, file paths, dates, or a specific coding-agent",
    "  product or model.",
    '- "triggers": 3 to 8 short phrases a person might use when asking for this kind of',
    '  work, each 1 to 4 words, with no commas, colons or "#".',
    `- Project names in this library (keep them out): ${
      input.projects.length ? input.projects.join(", ") : "none recorded"
    }`,
    "",
    "=== ROLE ===",
    JSON.stringify({
      name: role.name,
      display_name: role.display_name,
      description: role.description,
      delegate_when: role.delegate_when,
      not_for: role.not_for,
    }),
    "=== END ROLE ===",
    "",
    `=== ROLE LESSONS (${input.lessons.length}) ===`,
    ...input.lessons.map(lessonLine),
    "=== END ROLE LESSONS ===",
    "",
    `=== SHARED LESSONS (${input.shared.length}) ===`,
    ...input.shared.map(lessonLine),
    "=== END SHARED LESSONS ===",
  ].join("\n");
}
