import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { domainPath } from "./domains.js";
import { contentFingerprint } from "./fingerprint.js";
import { atomicWriteFilePrivate } from "./fsutil.js";
import {
  type PreferenceReviews,
  preferenceReview,
  readPreferenceReviews,
} from "./preference-review.js";
import { type AggregatedPreference, preferenceId, readObservedPreferences } from "./preferences.js";

/**
 * core/subagents.ts: the saved suggested-subagents artifact,
 * `<home>/library/subagents/suggestion.json`.
 *
 * `suggest-subagents` turns preference candidates into portable lessons
 * (stage A), groups the lessons into 2 to 15 specialist roles plus shared
 * preferences and playbooks (stage B), and writes a prompt per role (stage C).
 * This module owns the shape of that result and nothing that calls a model:
 * the zod schema, the coverage ledger, the input fingerprint, input selection,
 * and the atomic read and write. The renderer (`subagents-render.ts`), the GUI
 * and `--export` all start from what {@link readSuggestion} returns.
 *
 * It mirrors `consolidated-preferences.ts`: the artifact records exactly which
 * inputs the stages saw and a sha256 over them, so a later change to the
 * accepted set marks the saved result stale instead of silently disagreeing
 * with the library.
 *
 * Structural rules, checked by {@link SuggestionArtifactSchema} on every read
 * and write. Each issue message starts with its rule id so a stage check or a
 * test can name the rule it hit:
 *
 *   SA1  lesson ids are unique
 *   SA2  role names are unique (each is kebab-case by the field schema)
 *   SA3  every lesson id named by a role, `shared` or a playbook exists
 *   SA4  every lesson and set-aside `source_ids` entry is an input id
 *   SA5  every input id appears exactly once across lessons and set-asides
 *   SA6  every `generalized` lesson is placed in a role, in `shared` or in a playbook
 *   SA7  no `contextual` or `historical` lesson is placed in a role or in `shared`
 *   SA8  2 to 15 roles (field bound)
 *   SA9  at most 12 shared lessons (field bound)
 *   SA10 a lesson appears in at most 3 roles
 *   SA11 `coverage` equals {@link computeCoverage} over the artifact
 *   SA12 input ids and playbook names are unique (playbook names are kebab-case,
 *        because each becomes a file name in the rendered tree)
 *
 * Bounds on single fields (lengths, counts, trigger word counts) live on the
 * field schemas. `projectNameViolations` is a separate pure check used by the
 * stage validators; the saved artifact does not enforce it, so a person can
 * still read back a result whose wording a newer check would reject.
 */

export const SUBAGENTS_DIR = "subagents";
const SUGGESTION_FILE = "suggestion.json";
export const SUGGESTION_VERSION = 1;
export const SUGGEST_PROMPT_VERSIONS = { generalize: 1, propose: 1, author: 2 } as const;

export const MIN_ROLES = 2;
export const MAX_ROLES = 15;
export const MAX_ROLE_LESSONS = 40;
export const MAX_SHARED = 12;
export const MAX_LESSON_FAN_OUT = 3;

export type LessonDisposition = "generalized" | "contextual" | "historical";
const DISPOSITIONS = ["generalized", "contextual", "historical"] as const;

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ONE_LINE = /^[^\r\n]*$/;
const kebab = (max: number, min = 1) =>
  z.string().min(min).max(max).regex(KEBAB, "must be kebab-case");
/**
 * A bounded text field whose failure message names the bound and the actual
 * length. zod's default for `.max()` is the bare "Invalid input", which told a
 * model nothing when a title came back 81 characters long and the correction
 * retry carried only that word.
 */
const lengthOf = (input: unknown) => (typeof input === "string" ? input.length : 0);
const atMost = (max: number) => ({
  error: (issue: { input?: unknown }) => `at most ${max} characters (got ${lengthOf(issue.input)})`,
});
const atLeast = (min: number) => ({
  error: (issue: { input?: unknown }) =>
    `at least ${min} character${min === 1 ? "" : "s"} (got ${lengthOf(issue.input)})`,
});
const text = (max: number, min = 1) => z.string().min(min, atLeast(min)).max(max, atMost(max));

export const LessonSchema = z.object({
  id: kebab(80),
  title: text(80).regex(ONE_LINE, "must be one line"),
  instruction: text(900, 40),
  applies_when: z.string().max(300, atMost(300)),
  exceptions: z.string().max(300, atMost(300)),
  disposition: z.enum(DISPOSITIONS),
  source_ids: z
    .array(z.string().min(1))
    .min(1, { error: "needs at least one source id (got none)" }),
});
export type Lesson = z.infer<typeof LessonSchema>;

export const SetAsideSchema = z.object({
  source_ids: z
    .array(z.string().min(1))
    .min(1, { error: "needs at least one source id (got none)" }),
  reason: text(500),
});
export type SetAside = z.infer<typeof SetAsideSchema>;

/**
 * 1 to 4 words on one line. No comma (Kiro Crew joins triggers with commas)
 * and no `:` or `#` (the joined list is a plain YAML frontmatter value).
 */
const TriggerSchema = z
  .string()
  .regex(/^[^,:#\r\n]+$/, "must be one line with no comma, colon or #")
  .refine((value) => {
    const words = value.trim().split(/\s+/).filter(Boolean);
    return words.length >= 1 && words.length <= 4;
  }, "must be 1 to 4 words");

export const RoleSchema = z.object({
  name: kebab(40, 3),
  display_name: text(60).regex(ONE_LINE, "must be one line"),
  description: text(200).regex(ONE_LINE, "must be one line"),
  delegate_when: text(400),
  not_for: text(400),
  lesson_ids: z.array(z.string().min(1)).min(1).max(MAX_ROLE_LESSONS),
  prompt: z.string().min(2000, atLeast(2000)).max(6000, atMost(6000)).optional(),
  triggers: z.array(TriggerSchema).min(3).max(8).optional(),
});
export type Role = z.infer<typeof RoleSchema>;

export const PlaybookSchema = z.object({
  name: kebab(60),
  purpose: text(600),
  lesson_ids: z.array(z.string().min(1)).min(1),
});
export type Playbook = z.infer<typeof PlaybookSchema>;

export const SuggestionInputSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  count: z.number().int().nonnegative(),
  scope: z.enum(["global", "project", "task"]).optional(),
  project: z.string().optional(),
  domain: z.string().optional(),
  quote: z.string().optional(),
  review: z.enum(["accepted", "pending"]),
});
export type SuggestionInput = z.infer<typeof SuggestionInputSchema>;

const count = z.number().int().nonnegative();
export const CoverageSchema = z.object({
  source_candidates: count,
  mapped: count,
  set_aside: count,
  disposition_counts: z.object({ generalized: count, contextual: count, historical: count }),
  roles: z.record(z.string(), z.object({ lesson_count: count })),
  shared_count: count,
  playbook_count: count,
});
export type Coverage = z.infer<typeof CoverageSchema>;

const RUNNERS = ["claude", "codex", "kiro", "opencode"] as const;

const SuggestionResultSourceSchema = z.object({
  stage: z.enum(["generalize", "propose", "author"]),
  unit: z.string().min(1),
  runner: z.enum(RUNNERS),
  model: z.string().optional(),
});
export type SuggestionResultSource = z.infer<typeof SuggestionResultSourceSchema>;

const BaseArtifactSchema = z.object({
  version: z.literal(SUGGESTION_VERSION),
  generated_at: z.iso.datetime(),
  // Integers rather than literals: a saved result from an older prompt stays
  // readable after a prompt version bump.
  prompt_versions: z.object({
    generalize: z.number().int().positive(),
    propose: z.number().int().positive(),
    author: z.number().int().positive(),
  }),
  runner: z.enum(RUNNERS),
  models: z.object({
    generalize: z.string().optional(),
    propose: z.string().optional(),
    author: z.string().optional(),
  }),
  /** Concrete successful calls, including results reused from generalized preference windows. */
  resolved: z.array(SuggestionResultSourceSchema).optional(),
  source_hash: z.string().regex(/^[a-f0-9]{64}$/),
  selection: z.enum(["accepted", "all-candidates"]),
  projects: z.array(z.string()),
  inputs: z.array(SuggestionInputSchema),
  lessons: z.array(LessonSchema),
  set_aside: z.array(SetAsideSchema),
  roles: z.array(RoleSchema).min(MIN_ROLES).max(MAX_ROLES),
  shared: z.array(z.string().min(1)).max(MAX_SHARED),
  playbooks: z.array(PlaybookSchema),
  coverage: CoverageSchema,
});

/** The parts of an artifact the coverage ledger is computed from. */
export type CoverageParts = Pick<
  SuggestionArtifact,
  "inputs" | "lessons" | "set_aside" | "roles" | "shared" | "playbooks"
>;

/** Pure: the coverage ledger the artifact must carry (rule SA11). */
export function computeCoverage(parts: CoverageParts): Coverage {
  const mapped = new Set(parts.lessons.flatMap((lesson) => lesson.source_ids));
  const setAside = new Set(parts.set_aside.flatMap((item) => item.source_ids));
  const disposition_counts: Record<LessonDisposition, number> = {
    generalized: 0,
    contextual: 0,
    historical: 0,
  };
  for (const lesson of parts.lessons) disposition_counts[lesson.disposition]++;
  const roles: Record<string, { lesson_count: number }> = {};
  for (const role of parts.roles) roles[role.name] = { lesson_count: role.lesson_ids.length };
  return {
    source_candidates: parts.inputs.length,
    mapped: mapped.size,
    set_aside: setAside.size,
    disposition_counts,
    roles,
    shared_count: parts.shared.length,
    playbook_count: parts.playbooks.length,
  };
}

/** Cross-field rules SA1 to SA12; returns plain messages, each prefixed with its rule id. */
export function suggestionProblems(artifact: z.infer<typeof BaseArtifactSchema>): string[] {
  const problems: string[] = [];
  const lessons = new Map<string, Lesson>();
  for (const lesson of artifact.lessons) {
    if (lessons.has(lesson.id)) problems.push(`SA1 duplicate lesson id "${lesson.id}"`);
    lessons.set(lesson.id, lesson);
  }
  const roleNames = new Set<string>();
  for (const role of artifact.roles) {
    if (roleNames.has(role.name)) problems.push(`SA2 duplicate role name "${role.name}"`);
    roleNames.add(role.name);
  }
  const inputIds = new Set<string>();
  for (const input of artifact.inputs) {
    if (inputIds.has(input.id)) problems.push(`SA12 duplicate input id "${input.id}"`);
    inputIds.add(input.id);
  }
  const playbookNames = new Set<string>();
  for (const playbook of artifact.playbooks) {
    if (playbookNames.has(playbook.name))
      problems.push(`SA12 duplicate playbook name "${playbook.name}"`);
    playbookNames.add(playbook.name);
  }

  const placed = new Set<string>();
  const fanOut = new Map<string, number>();
  const known = (id: string, where: string) => {
    if (!lessons.has(id)) problems.push(`SA3 ${where} names unknown lesson "${id}"`);
    placed.add(id);
  };
  for (const role of artifact.roles) {
    for (const id of new Set(role.lesson_ids)) {
      known(id, `role "${role.name}"`);
      fanOut.set(id, (fanOut.get(id) ?? 0) + 1);
      const disposition = lessons.get(id)?.disposition;
      if (disposition && disposition !== "generalized")
        problems.push(`SA7 role "${role.name}" carries ${disposition} lesson "${id}"`);
    }
  }
  for (const id of artifact.shared) {
    known(id, "shared");
    const disposition = lessons.get(id)?.disposition;
    if (disposition && disposition !== "generalized")
      problems.push(`SA7 shared carries ${disposition} lesson "${id}"`);
  }
  for (const playbook of artifact.playbooks) {
    for (const id of playbook.lesson_ids) known(id, `playbook "${playbook.name}"`);
  }
  for (const [id, roles] of fanOut) {
    if (roles > MAX_LESSON_FAN_OUT)
      problems.push(`SA10 lesson "${id}" is in ${roles} roles (at most ${MAX_LESSON_FAN_OUT})`);
  }
  for (const lesson of artifact.lessons) {
    if (lesson.disposition === "generalized" && !placed.has(lesson.id))
      problems.push(`SA6 generalized lesson "${lesson.id}" is in no role, shared or playbook`);
  }

  const seen = new Map<string, number>();
  const sources = [
    ...artifact.lessons.map((lesson) => ({
      where: `lesson "${lesson.id}"`,
      ids: lesson.source_ids,
    })),
    ...artifact.set_aside.map((item, index) => ({
      where: `set-aside ${index + 1}`,
      ids: item.source_ids,
    })),
  ];
  for (const { where, ids } of sources) {
    for (const id of ids) {
      if (!inputIds.has(id)) problems.push(`SA4 ${where} names unknown input "${id}"`);
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
  }
  for (const id of inputIds) {
    const times = seen.get(id) ?? 0;
    if (times !== 1) problems.push(`SA5 input "${id}" appears ${times} times (expected exactly 1)`);
  }

  if (!isDeepStrictEqual(artifact.coverage, computeCoverage(artifact)))
    problems.push("SA11 coverage does not match the recomputed coverage");
  return problems;
}

export const SuggestionArtifactSchema = BaseArtifactSchema.superRefine((artifact, ctx) => {
  for (const message of suggestionProblems(artifact)) ctx.addIssue({ code: "custom", message });
});
export type SuggestionArtifact = z.infer<typeof BaseArtifactSchema>;

/**
 * sha256 over exactly what the stages saw: each input's id, text, count, scope
 * and project identity, plus its review status and the stored review revision
 * (the `source_fingerprint` the human accepted, "" when never reviewed).
 * Sorted, so input order does not matter. Modeled on `preferencesFingerprint`.
 */
export function suggestionFingerprint(
  inputs: SuggestionInput[],
  reviews: PreferenceReviews,
): string {
  const rows = inputs
    .map((input) => ({
      id: input.id,
      text: input.text,
      count: input.count,
      scope: input.scope ?? "global",
      project: input.scope && input.scope !== "global" ? (input.project ?? "") : "",
      review: input.review,
      revision: reviews[input.id]?.source_fingerprint ?? "",
    }))
    .sort((a, b) => a.id.localeCompare(b.id) || a.count - b.count || a.text.localeCompare(b.text));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

/**
 * The domain path shown to the stages: the evidence domains first (as the GUI
 * does), then the preference's own. Several domains collapse to the first in
 * sorted order; the type holds one path.
 */
function inputDomain(preference: AggregatedPreference): string | undefined {
  const evidence = preference.occurrences.flatMap((occurrence) => occurrence.domains ?? []);
  const values = evidence.length ? evidence : (preference.domains ?? []);
  const paths = values.map((value) => domainPath(value).join(" > ")).filter(Boolean);
  return paths.sort((a, b) => a.localeCompare(b))[0];
}

/**
 * Pick the stage inputs. Accepted preferences only, with the
 * accepted wording, scope and project. When none is accepted, or when
 * `includeUnreviewed` is set, every candidate that is not dismissed is used and
 * `selection` says so, so the consent preview can print the fallback line.
 * A review whose evidence changed since acceptance reads as pending, exactly as
 * the GUI shows it.
 */
export function selectSuggestionInputs(
  prefs: AggregatedPreference[],
  reviews: PreferenceReviews,
  opts: { includeUnreviewed: boolean },
): { inputs: SuggestionInput[]; selection: "accepted" | "all-candidates" } {
  const reviewed = prefs.map((preference) => ({
    preference,
    // The home argument is unused when the reviews are passed in.
    review: preferenceReview("", preference, reviews),
  }));
  const accepted = reviewed.filter(({ review }) => review.status === "accepted");
  const allCandidates = opts.includeUnreviewed || accepted.length === 0;
  const chosen = allCandidates
    ? reviewed.filter(({ review }) => review.status !== "dismissed")
    : accepted;
  const inputs = chosen.map(({ preference, review }): SuggestionInput => {
    const quote =
      preference.occurrences.find((occurrence) => occurrence.quote)?.quote ??
      preference.occurrences.find((occurrence) => occurrence.evidence)?.evidence;
    const domain = inputDomain(preference);
    return {
      id: preferenceId(preference),
      text: review.text,
      count: preference.count,
      scope: review.scope,
      ...(review.scope !== "global" && review.project ? { project: review.project } : {}),
      ...(domain ? { domain } : {}),
      ...(quote ? { quote } : {}),
      review: review.status === "accepted" ? "accepted" : "pending",
    };
  });
  return { inputs, selection: allCandidates ? "all-candidates" : "accepted" };
}

/** `<home>/library/subagents/suggestion.json`. */
export function suggestionPath(home: string): string {
  return path.join(home, "library", SUBAGENTS_DIR, SUGGESTION_FILE);
}

export const SUGGESTION_PARTIAL_FILE = "suggestion.partial.json";
/**
 * Where a stopped run records its failure when `suggestion.partial.json`
 * holds a role proposal that is still being written: that proposal was paid
 * for and `--author-only` finishes it, so a failure record never replaces it.
 */
export const SUGGESTION_FAILURE_FILE = "suggestion.failure.json";

/** A resumed proposal may replace only the copy that existed when it was started. */
export function savedSuggestionKey(home: string): string | null {
  try {
    return contentFingerprint(fs.readFileSync(suggestionPath(home), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function pendingAuthorProposal(
  home: string,
  baseKey: string | null,
): SuggestionArtifact | null {
  const partial = path.join(home, "library", SUBAGENTS_DIR, SUGGESTION_PARTIAL_FILE);
  try {
    const record = JSON.parse(fs.readFileSync(partial, "utf8"));
    if (record?.stage !== "author" || record.base_key !== baseKey) return null;
    const result = SuggestionArtifactSchema.safeParse(record.artifact);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Does `suggestion.partial.json` hold a role proposal (resumable or not), rather than a failure record? */
export function hasAuthorProgress(home: string): boolean {
  const partial = path.join(home, "library", SUBAGENTS_DIR, SUGGESTION_PARTIAL_FILE);
  try {
    const record = JSON.parse(fs.readFileSync(partial, "utf8"));
    return (
      record?.stage === "author" && SuggestionArtifactSchema.safeParse(record.artifact).success
    );
  } catch {
    return false;
  }
}

export function saveAuthorProgress(
  home: string,
  baseKey: string | null,
  artifact: SuggestionArtifact,
): void {
  const partial = path.join(home, "library", SUBAGENTS_DIR, SUGGESTION_PARTIAL_FILE);
  const record = {
    stage: "author",
    base_key: baseKey,
    artifact: SuggestionArtifactSchema.parse(artifact),
  };
  atomicWriteFilePrivate(partial, `${JSON.stringify(record, null, 2)}\n`);
}

export function clearAuthorProgress(home: string): void {
  const partial = path.join(home, "library", SUBAGENTS_DIR, SUGGESTION_PARTIAL_FILE);
  try {
    fs.rmSync(partial, { force: true });
  } catch {
    // A leftover checkpoint cannot supersede the newly published proposal's key.
  }
}

/** Validate, then replace the saved suggestion atomically (owner-only). Returns the path. */
export function writeSuggestion(home: string, artifact: SuggestionArtifact): string {
  const result = SuggestionArtifactSchema.safeParse(artifact);
  if (!result.success) {
    throw new Error(
      `Invalid subagent suggestion: ${result.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const file = suggestionPath(home);
  atomicWriteFilePrivate(file, `${JSON.stringify(result.data, null, 2)}\n`);
  return file;
}

/**
 * A saved suggestion that exists but cannot be used: not JSON, unreadable, or
 * failing the schema. `reason` is a short, printable explanation. The file is
 * never modified on a failed read.
 */
export class SuggestionReadError extends Error {
  constructor(readonly reason: string) {
    super(`The saved subagent suggestion could not be read: ${reason}`);
    this.name = "SuggestionReadError";
  }
}

export function isSuggestionStale(
  home: string,
  artifact: SuggestionArtifact,
  current?: { prefs: AggregatedPreference[]; reviews: PreferenceReviews },
): boolean {
  const prefs = current?.prefs ?? readObservedPreferences(home);
  const reviews = current?.reviews ?? readPreferenceReviews(home).reviews;
  const { inputs } = selectSuggestionInputs(prefs, reviews, {
    includeUnreviewed: artifact.selection === "all-candidates",
  });
  return suggestionFingerprint(inputs, reviews) !== artifact.source_hash;
}

/**
 * Read and validate the saved suggestion.
 *
 * - No file: returns null (normal before the first run).
 * - Damaged file: throws {@link SuggestionReadError} with the reason, so the
 *   caller can say the result is damaged instead of acting as if none exists.
 * - Otherwise `stale` is true when the fingerprint of the CURRENT selection,
 *   picked with the artifact's own `selection` rule, differs from
 *   `source_hash`. `current` lets a caller that already read the library and
 *   reviews (the GUI) pass them in; by default they are read from `home`.
 */
export function readSuggestion(
  home: string,
  current?: { prefs: AggregatedPreference[]; reviews: PreferenceReviews },
): { artifact: SuggestionArtifact; stale: boolean } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(suggestionPath(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SuggestionReadError((error as Error).message);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SuggestionReadError("the file is not valid JSON");
  }
  const result = SuggestionArtifactSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.length ? `${first.path.join(".")}: ` : "";
    throw new SuggestionReadError(`${where}${first?.message ?? "schema validation failed"}`);
  }
  const artifact = result.data;
  return { artifact, stale: isSuggestionStale(home, artifact, current) };
}

const IGNORED_PROJECT_WORDS = new Set(["unknown", "workspace", "src", "tmp"]);
// A drive letter must stand alone, so `coordinator:\n` in JSON-escaped text is
// not read as `r:\`.
const ABSOLUTE_PATH =
  /(?:\/Users\/|\/home\/|\/workplace\/|(?<![\p{L}\p{N}_])[A-Za-z]:\\)[^\s`'")\]]*/gu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pure: the project names and absolute paths that make `text` non-portable.
 * Project names match case-insensitively as whole words (letters, digits, `_`
 * and `-` count as word characters, so `web` does not match `webapp`). Names
 * shorter than 4 characters and the generic words `unknown`, `workspace`,
 * `src` and `tmp` are ignored. Each hit is reported once, project names first
 * in the order given, then paths in text order.
 */
export function projectNameViolations(text: string, projects: string[]): string[] {
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const project of projects) {
    const name = project.trim();
    const key = name.toLowerCase();
    if (name.length < 4 || IGNORED_PROJECT_WORDS.has(key) || seen.has(key)) continue;
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_-])${escapeRegExp(name)}(?![\\p{L}\\p{N}_-])`,
      "iu",
    );
    if (pattern.test(text)) {
      seen.add(key);
      hits.push(name);
    }
  }
  for (const match of text.matchAll(ABSOLUTE_PATH)) {
    // Sentence punctuation after a path is not part of it.
    const hit = match[0].replace(/[.,;:!?]+$/, "");
    if (!seen.has(hit)) {
      seen.add(hit);
      hits.push(hit);
    }
  }
  return hits;
}
