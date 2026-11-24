import type { z } from "zod";
import type { AuthorRoleOutput } from "../distill/prompts/author-role.js";
import type { GeneralizeOutput } from "../distill/prompts/generalize.js";
import type { ProposedRole, ProposeOutput, RoleBounds } from "../distill/prompts/propose.js";
import {
  type Lesson,
  LessonSchema,
  MAX_LESSON_FAN_OUT,
  MAX_ROLE_LESSONS,
  MAX_SHARED,
  PlaybookSchema,
  projectNameViolations,
  RoleSchema,
  SetAsideSchema,
  type SuggestionArtifact,
  type SuggestionInput,
  suggestionProblems,
} from "./subagents.js";

/**
 * core/subagent-checks.ts: the deterministic checks between the three
 * suggest-subagents model stages.
 *
 * Each stage's response is checked here BEFORE anything is assembled, so a
 * violation can go back to the model as one targeted correction naming the
 * exact rule, instead of surfacing later as a schema failure on the saved
 * artifact. Every check is a pure function returning plain messages, each
 * prefixed with its rule id; an empty list means the response is usable.
 *
 *   G1  every window input id appears exactly once across the window's lessons
 *       and set-asides, and no other id appears
 *   G2  `generalized` lesson text (title, instruction, applies_when, exceptions)
 *       names no project from the library and no absolute path
 *   G3  lesson and set-aside fields are within the saved-artifact bounds
 *       (`LessonSchema` without its id, `SetAsideSchema`)
 *   P1  the role count is within the bounds for this call
 *   P2  role names and playbook names are unique and kebab-case
 *   P3  every lesson id named by a role, `shared` or a playbook exists
 *   P4  every `generalized` lesson is placed in a role, in `shared` or in a playbook
 *   P5  no `contextual` or `historical` lesson is in a role or in `shared`
 *   P6  at most 40 lessons per role, at most 3 roles per lesson, at most 12 shared
 *   P7  role text (name, display name, description, delegate when, not for)
 *       names no project and no absolute path
 *   P8  the other role and playbook fields are within the saved-artifact bounds,
 *       and no list names the same lesson twice
 *   A1  the role prompt and triggers are within the saved-artifact bounds
 *   A2  the prompt and triggers name no project and no absolute path
 *   A3  every lesson id the prompt mentions, as `(id)` or as a backticked id,
 *       belongs to the role or to `shared`
 *
 * The assembled artifact is checked once more by {@link assembledProblems},
 * which is the saved-artifact rule set SA1 to SA12 from `core/subagents.ts`.
 */

/** What a broken rule means, in plain words, for the person (never the rule id). */
const RULE_WORDS: Record<string, string> = {
  G1: "it did not place every preference exactly once",
  G2: "it named a project or a file path in a portable lesson",
  G3: "a lesson or a set-aside was longer or shorter than allowed",
  P1: "it proposed too few or too many roles",
  P2: "two roles or playbooks had the same name, or a name was not in kebab-case",
  P3: "it named a lesson that does not exist",
  P4: "it left a portable lesson out of every role and playbook",
  P5: "it put a project-specific lesson in a role",
  P6: "a role held too many lessons, or a lesson was in too many roles",
  P7: "it named a project or a file path in a role",
  P8: "a role or playbook field was longer or shorter than allowed",
  A1: "the role prompt was longer or shorter than allowed",
  A2: "it named a project or a file path in the role prompt",
  A3: "the role prompt cited a lesson that does not belong to the role",
};

/**
 * The problems of a rejected answer in plain words, without rule ids or the
 * identifiers they quote. The full messages still go back to the model and
 * into the saved failure record; this is what a person reads.
 */
export function describeProblems(problems: readonly string[]): string {
  const phrases = new Set<string>();
  for (const problem of problems) {
    const rule = /^([GPA]\d+) /.exec(problem)?.[1];
    phrases.add((rule && RULE_WORDS[rule]) ?? "the answer was not in the shape the step needs");
  }
  return [...phrases].join("; ");
}

function quoted(value: string, max = 60): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return JSON.stringify(flat.length > max ? `${flat.slice(0, max)}...` : flat);
}

function violationText(hits: string[]): string {
  return hits.map((hit) => JSON.stringify(hit)).join(", ");
}

const WindowLessonSchema = LessonSchema.omit({ id: true });

/** G1 to G3 for one generalize window. */
export function generalizeProblems(
  output: GeneralizeOutput,
  window: SuggestionInput[],
  projects: string[],
): string[] {
  const problems: string[] = [];
  const expected = new Set(window.map((input) => input.id));
  const seen = new Map<string, number>();
  const groups = [
    ...output.lessons.map((lesson, index) => ({
      where: `lesson ${index + 1} ${quoted(lesson.title)}`,
      ids: lesson.source_ids,
    })),
    ...output.set_aside.map((item, index) => ({
      where: `set-aside ${index + 1}`,
      ids: item.source_ids,
    })),
  ];
  for (const { where, ids } of groups) {
    for (const id of ids) {
      if (!expected.has(id)) problems.push(`G1 ${where} names unknown input id "${id}"`);
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
  }
  for (const id of expected) {
    const times = seen.get(id) ?? 0;
    if (times !== 1)
      problems.push(
        `G1 input "${id}" appears ${times} times across lessons and set-asides (expected exactly 1)`,
      );
  }

  for (const [index, lesson] of output.lessons.entries()) {
    const where = `lesson ${index + 1} ${quoted(lesson.title)}`;
    if (lesson.disposition === "generalized") {
      for (const field of ["title", "instruction", "applies_when", "exceptions"] as const) {
        const hits = projectNameViolations(lesson[field], projects);
        if (hits.length)
          problems.push(
            `G2 generalized ${where} ${field} names ${violationText(hits)}; remove it or mark the lesson contextual`,
          );
      }
    }
    const parsed = WindowLessonSchema.safeParse(lesson);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        problems.push(`G3 ${where} ${issue.path.join(".") || "lesson"}: ${issue.message}`);
    }
  }
  for (const [index, item] of output.set_aside.entries()) {
    const parsed = SetAsideSchema.safeParse(item);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        problems.push(`G3 set-aside ${index + 1} ${issue.path.join(".")}: ${issue.message}`);
    }
  }
  return problems;
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  return [...repeated];
}

function fieldIssues(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

const ROLE_TEXT_FIELDS = [
  "name",
  "display_name",
  "description",
  "delegate_when",
  "not_for",
] as const;
const ROLE_BOUNDED_FIELDS = ["display_name", "description", "delegate_when", "not_for"] as const;

/**
 * P1 to P8 for one propose or merge response. `lessons` are the lessons this
 * call was shown: one window's for a windowed call, all of them otherwise.
 */
export function proposeProblems(
  output: ProposeOutput,
  lessons: Lesson[],
  projects: string[],
  bounds: RoleBounds,
): string[] {
  const problems: string[] = [];
  const byId = new Map(lessons.map((lesson) => [lesson.id, lesson]));

  const count = output.roles.length;
  if (count < bounds.minRoles || count > bounds.maxRoles)
    problems.push(
      `P1 ${count} roles proposed; expected ${
        bounds.minRoles === 0
          ? `at most ${bounds.maxRoles}`
          : `${bounds.minRoles} to ${bounds.maxRoles}`
      }`,
    );

  const roleNames = new Set<string>();
  for (const role of output.roles) {
    for (const message of fieldIssues(RoleSchema.shape.name, role.name))
      problems.push(`P2 role name "${role.name}" ${message}`);
    if (roleNames.has(role.name)) problems.push(`P2 duplicate role name "${role.name}"`);
    roleNames.add(role.name);
  }
  const playbookNames = new Set<string>();
  for (const playbook of output.playbooks) {
    for (const message of fieldIssues(PlaybookSchema.shape.name, playbook.name))
      problems.push(`P2 playbook name "${playbook.name}" ${message}`);
    if (playbookNames.has(playbook.name))
      problems.push(`P2 duplicate playbook name "${playbook.name}"`);
    playbookNames.add(playbook.name);
  }

  const placed = new Set<string>();
  const fanOut = new Map<string, number>();
  const exists = (id: string, where: string) => {
    if (!byId.has(id)) problems.push(`P3 ${where} names unknown lesson "${id}"`);
    placed.add(id);
  };
  const portableOnly = (id: string, where: string) => {
    const disposition = byId.get(id)?.disposition;
    if (disposition && disposition !== "generalized")
      problems.push(`P5 ${where} carries ${disposition} lesson "${id}"; move it to a playbook`);
  };
  for (const role of output.roles) {
    const where = `role "${role.name}"`;
    for (const id of new Set(role.lesson_ids)) {
      exists(id, where);
      portableOnly(id, where);
      fanOut.set(id, (fanOut.get(id) ?? 0) + 1);
    }
  }
  for (const id of new Set(output.shared)) {
    exists(id, "shared");
    portableOnly(id, "shared");
  }
  for (const playbook of output.playbooks) {
    for (const id of new Set(playbook.lesson_ids)) exists(id, `playbook "${playbook.name}"`);
  }
  for (const lesson of lessons) {
    if (lesson.disposition === "generalized" && !placed.has(lesson.id))
      problems.push(`P4 generalized lesson "${lesson.id}" is in no role, shared or playbook`);
  }

  for (const role of output.roles) {
    if (role.lesson_ids.length > MAX_ROLE_LESSONS)
      problems.push(
        `P6 role "${role.name}" has ${role.lesson_ids.length} lessons (at most ${MAX_ROLE_LESSONS})`,
      );
  }
  for (const [id, roles] of fanOut) {
    if (roles > MAX_LESSON_FAN_OUT)
      problems.push(`P6 lesson "${id}" is in ${roles} roles (at most ${MAX_LESSON_FAN_OUT})`);
  }
  if (output.shared.length > MAX_SHARED)
    problems.push(`P6 shared has ${output.shared.length} lessons (at most ${MAX_SHARED})`);

  for (const role of output.roles) {
    for (const field of ROLE_TEXT_FIELDS) {
      const hits = projectNameViolations(role[field], projects);
      if (hits.length)
        problems.push(`P7 role "${role.name}" ${field} names ${violationText(hits)}`);
    }
  }

  for (const role of output.roles) {
    for (const field of ROLE_BOUNDED_FIELDS) {
      for (const message of fieldIssues(RoleSchema.shape[field], role[field]))
        problems.push(`P8 role "${role.name}" ${field}: ${message}`);
    }
    if (role.lesson_ids.length === 0) problems.push(`P8 role "${role.name}" has no lessons`);
    for (const id of duplicates(role.lesson_ids))
      problems.push(`P8 role "${role.name}" lists lesson "${id}" twice`);
  }
  for (const playbook of output.playbooks) {
    for (const message of fieldIssues(PlaybookSchema.shape.purpose, playbook.purpose))
      problems.push(`P8 playbook "${playbook.name}" purpose: ${message}`);
    if (playbook.lesson_ids.length === 0)
      problems.push(`P8 playbook "${playbook.name}" has no lessons`);
    for (const id of duplicates(playbook.lesson_ids))
      problems.push(`P8 playbook "${playbook.name}" lists lesson "${id}" twice`);
  }
  for (const id of duplicates(output.shared)) problems.push(`P8 shared lists lesson "${id}" twice`);
  return problems;
}

const PromptSchema = RoleSchema.shape.prompt.unwrap();
const TriggersSchema = RoleSchema.shape.triggers.unwrap();
const KEBAB_TOKEN = /[a-z0-9]+(?:-[a-z0-9]+)*/g;

/** Lesson-id-shaped tokens inside `(...)` and inside backticks, in text order. */
function mentionedTokens(prompt: string): string[] {
  const tokens: string[] = [];
  for (const match of prompt.matchAll(/\(([^()\n]*)\)|`([^`\n]+)`/g)) {
    const inner = match[1] ?? match[2] ?? "";
    for (const token of inner.matchAll(KEBAB_TOKEN)) tokens.push(token[0]);
  }
  return tokens;
}

/**
 * A1 to A3 for one role's stage C response. `lessons` is the full lesson list,
 * so an id that belongs to another role can be recognized.
 */
export function authorProblems(
  output: AuthorRoleOutput,
  role: Pick<ProposedRole, "name" | "lesson_ids">,
  lessons: Lesson[],
  shared: string[],
  projects: string[],
): string[] {
  const problems: string[] = [];
  for (const message of fieldIssues(PromptSchema, output.prompt))
    problems.push(`A1 prompt (${output.prompt.length} characters): ${message}`);
  const triggers = TriggersSchema.safeParse(output.triggers);
  if (!triggers.success) {
    for (const issue of triggers.error.issues) {
      const index = typeof issue.path[0] === "number" ? issue.path[0] : undefined;
      problems.push(
        `A1 ${index === undefined ? "triggers" : `trigger ${quoted(output.triggers[index] ?? "")}`}: ${issue.message}`,
      );
    }
  }

  const promptHits = projectNameViolations(output.prompt, projects);
  if (promptHits.length) problems.push(`A2 prompt names ${violationText(promptHits)}`);
  for (const trigger of output.triggers) {
    const hits = projectNameViolations(trigger, projects);
    if (hits.length) problems.push(`A2 trigger ${quoted(trigger)} names ${violationText(hits)}`);
  }

  const known = new Set(lessons.map((lesson) => lesson.id));
  const allowed = new Set([...role.lesson_ids, ...shared]);
  const reported = new Set<string>();
  for (const token of mentionedTokens(output.prompt)) {
    if (known.has(token) && !allowed.has(token) && !reported.has(token)) {
      reported.add(token);
      problems.push(
        `A3 prompt mentions lesson "${token}", which belongs to neither role "${role.name}" nor shared`,
      );
    }
  }
  return problems;
}

/** SA1 to SA12 on the assembled artifact (the saved-artifact rules). */
export function assembledProblems(artifact: SuggestionArtifact): string[] {
  return suggestionProblems(artifact);
}
