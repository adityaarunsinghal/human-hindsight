import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  GENERALIZE_PROMPT_VERSION,
  type GeneralizedLesson,
  GeneralizeSchema,
  renderGeneralizeInput,
} from "../distill/prompts/generalize.js";
import { fingerprint } from "./fingerprint.js";
import { atomicWriteFilePrivate } from "./fsutil.js";
import { isPlanLabel } from "./model-plan.js";
import { type PreferenceReviews, readPreferenceReviews } from "./preference-review.js";
import { type AggregatedPreference, preferenceId, readObservedPreferences } from "./preferences.js";
import {
  type Lesson,
  LessonSchema,
  SetAsideSchema,
  type SuggestionInput,
  selectSuggestionInputs,
} from "./subagents.js";

export const GENERALIZED_PATH = "library/preferences.generalized.json";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const GeneralizedCallSchema = z.object({
  runner: z.enum(["claude", "codex", "kiro", "opencode"]),
  model: z.string().optional(),
});
const windowSchema = z.object({
  input_ids: z.array(z.string().min(1)).min(1),
  result: GeneralizeSchema,
  resolved: GeneralizedCallSchema.optional(),
});
const artifactSchema = z.object({
  version: z.literal(1),
  generated_at: z.iso.datetime(),
  prompt_version: z.number().int().positive(),
  inputs_hash: hash,
  selection: z.enum(["all-candidates", "accepted"]),
  /** The concrete model that produced the windows, or null when unknown or mixed. Never a plan label. */
  model: z
    .string()
    .refine((value) => !isPlanLabel(value), "A plan label is not a model name.")
    .nullable(),
  /** The quality plan role the run asked for (for example `balanced/major`), when it used one. */
  model_plan: z.string().refine(isPlanLabel, "Not a plan label.").optional(),
  resolved: z.array(GeneralizedCallSchema).optional(),
  windows: z.record(hash, windowSchema),
  lessons: z.array(LessonSchema),
  set_aside: z.array(SetAsideSchema),
  /**
   * Present when some windows failed: the set holds the finished windows only.
   * A reader treats a missing field as complete. The next run reuses the
   * finished windows and writes the complete set.
   */
  incomplete: z
    .object({
      windows_failed: z.number().int().positive(),
      candidates_not_covered: z.number().int().nonnegative(),
    })
    .optional(),
});

export type GeneralizedArtifact = z.infer<typeof artifactSchema>;
export type GeneralizedWindow = z.infer<typeof windowSchema>;
export interface CurrentPreferences {
  prefs: AggregatedPreference[];
  reviews: PreferenceReviews;
}

function trimKebab(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max + 1);
  const at = cut.lastIndexOf("-");
  return (at > 0 ? cut.slice(0, at) : value.slice(0, max)).replace(/-+$/, "");
}

/** Assign ids in planned window order, independently of the order calls finish. */
export function assignLessonIds(drafts: GeneralizedLesson[]): Lesson[] {
  const used = new Set<string>();
  return drafts.map((draft) => {
    const base =
      trimKebab(
        draft.title
          .normalize("NFKD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, ""),
        80,
      ) || "lesson";
    let id = base;
    for (let n = 2; used.has(id); n++) {
      const suffix = `-${n}`;
      id = `${trimKebab(base, 80 - suffix.length)}${suffix}`;
    }
    used.add(id);
    return { id, ...draft };
  });
}

function readManifestProjects(home: string): string[] {
  try {
    const manifest: unknown = JSON.parse(
      fs.readFileSync(path.join(home, "exports", "manifest.json"), "utf8"),
    );
    if (!Array.isArray(manifest)) return [];
    return manifest.flatMap((entry) => {
      const project =
        entry && typeof entry === "object" ? (entry as { project?: unknown }).project : undefined;
      return typeof project === "string" ? [project] : [];
    });
  } catch {
    // The preference evidence still supplies project names without a manifest.
    return [];
  }
}

function sortedNames(values: Iterable<string | undefined>): string[] {
  const names = new Set<string>();
  for (const value of values)
    if (typeof value === "string" && value.trim()) names.add(value.trim());
  return [...names].sort((a, b) => a.localeCompare(b));
}

function preferenceProjects(preference: AggregatedPreference): (string | undefined)[] {
  return [preference.project, ...preference.occurrences.map((occurrence) => occurrence.project)];
}

/** Project names included in the prompt and checked on portable lessons. */
export function libraryProjects(home: string, prefs: AggregatedPreference[]): string[] {
  return sortedNames([...readManifestProjects(home), ...prefs.flatMap(preferenceProjects)]);
}

/**
 * Project names each input refers to: its own project and the projects its
 * evidence was observed in. Other library projects are only a check list, so a
 * new or renamed project elsewhere leaves saved windows and the set current.
 */
export function inputProjects(
  inputs: readonly SuggestionInput[],
  prefs: AggregatedPreference[],
): Record<string, string[]> {
  const byId = new Map(prefs.map((preference) => [preferenceId(preference), preference]));
  const projects: Record<string, string[]> = {};
  for (const input of inputs) {
    const preference = byId.get(input.id);
    projects[input.id] = sortedNames([
      input.project,
      ...(preference ? preferenceProjects(preference) : []),
    ]);
  }
  return projects;
}

/** The projects a group of inputs refers to, from {@link inputProjects}. */
export function referencedProjects(
  inputs: readonly SuggestionInput[],
  byInput: Record<string, string[]>,
): string[] {
  return sortedNames(inputs.flatMap((input) => byInput[input.id] ?? []));
}

export function currentGeneralizeInputs(
  home: string,
  selection: "auto" | "all-candidates",
  current?: CurrentPreferences,
) {
  if (!current) {
    const { reviews, invalid } = readPreferenceReviews(home);
    if (invalid) throw new Error("The saved preference reviews could not be read.");
    current = { prefs: readObservedPreferences(home), reviews };
  }
  const picked = selectSuggestionInputs(current.prefs, current.reviews, {
    includeUnreviewed: selection === "all-candidates",
  });
  return {
    ...picked,
    projects: libraryProjects(home, current.prefs),
    inputProjects: inputProjects(picked.inputs, current.prefs),
  };
}

/**
 * Acceptance alone leaves the wording, scope, evidence and project guidance
 * unchanged. `projects` is the list the inputs refer to ({@link referencedProjects}).
 */
export function generalizedInputsHash(inputs: readonly SuggestionInput[], projects: string[]) {
  const rows = inputs.map(renderGeneralizeInput).sort();
  return fingerprint({ inputs: rows, projects });
}

export const GeneralizedArtifactSchema = artifactSchema.superRefine((artifact, ctx) => {
  const windows = Object.values(artifact.windows);
  const expectedIds = new Set<string>();
  for (const window of windows) {
    const covered = [...window.result.lessons, ...window.result.set_aside]
      .flatMap((group) => group.source_ids)
      .sort();
    if (!isDeepStrictEqual(covered, [...window.input_ids].sort())) {
      ctx.addIssue({ code: "custom", message: "A window does not cover its source ids." });
    }
    for (const id of window.input_ids) {
      if (expectedIds.has(id))
        ctx.addIssue({ code: "custom", message: `Repeated source id "${id}".` });
      expectedIds.add(id);
    }
  }
  const lessons = assignLessonIds(windows.flatMap((window) => window.result.lessons));
  const setAside = windows.flatMap((window) => window.result.set_aside);
  if (
    !isDeepStrictEqual(lessons, artifact.lessons) ||
    !isDeepStrictEqual(setAside, artifact.set_aside)
  )
    ctx.addIssue({
      code: "custom",
      message: "The preference summaries differ from their saved batches.",
    });
});

/** The saved set as a reader sees it. Readers never throw. */
export type SavedGeneralized =
  | { state: "absent" }
  | { state: "ok"; artifact: GeneralizedArtifact }
  | { state: "damaged"; reason: string };

/** Read the saved set without reading every source a second time while planning a stage. */
export function loadGeneralizedArtifact(home: string): SavedGeneralized {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(home, GENERALIZED_PATH), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    return { state: "damaged", reason: (error as Error).message };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "damaged", reason: "the file is not valid JSON" };
  }
  const result = GeneralizedArtifactSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.length ? `${first.path.join(".")}: ` : "";
    return { state: "damaged", reason: `${where}${first?.message ?? "invalid artifact"}` };
  }
  return { state: "ok", artifact: result.data };
}

/** How much of the candidate set an incomplete saved set covers. */
export interface GeneralizedGap {
  /** Preference candidates the finished windows summarized. */
  summarized: number;
  /** Every candidate the run set out to summarize. */
  total: number;
  windowsFailed: number;
}

/**
 * `incomplete` is set when the saved set holds only the windows that finished
 * (say "N of M preferences summarized; run distill again to finish, finished
 * work is reused"). It is a field of the readable state rather than a state of
 * its own, so a reader that only knows ready, stale and damaged still shows
 * the agreements that exist.
 */
export type GeneralizedState =
  | { state: "absent" }
  | { state: "ok"; artifact: GeneralizedArtifact; stale: boolean; incomplete?: GeneralizedGap }
  | { state: "damaged"; reason: string };

/** The gap an incomplete saved set records, or undefined for a complete one. */
export function generalizedGap(artifact: GeneralizedArtifact): GeneralizedGap | undefined {
  if (!artifact.incomplete) return undefined;
  const summarized = Object.values(artifact.windows).reduce(
    (sum, window) => sum + window.input_ids.length,
    0,
  );
  return {
    summarized,
    total: summarized + artifact.incomplete.candidates_not_covered,
    windowsFailed: artifact.incomplete.windows_failed,
  };
}

/**
 * The saved set and whether it is stale, as one result. Stale means the
 * selection rule, the prompt version, or the inputs and the projects they refer
 * to changed. Review state alone (accepting a candidate) does not count.
 */
export function inspectGeneralized(home: string, current?: CurrentPreferences): GeneralizedState {
  const saved = loadGeneralizedArtifact(home);
  if (saved.state !== "ok") return saved;
  const { artifact } = saved;
  try {
    const now = currentGeneralizeInputs(
      home,
      artifact.selection === "accepted" ? "auto" : "all-candidates",
      current,
    );
    const hash = generalizedInputsHash(
      now.inputs,
      referencedProjects(now.inputs, now.inputProjects),
    );
    const incomplete = generalizedGap(artifact);
    return {
      state: "ok",
      artifact,
      stale:
        now.selection !== artifact.selection ||
        artifact.prompt_version !== GENERALIZE_PROMPT_VERSION ||
        artifact.inputs_hash !== hash,
      ...(incomplete ? { incomplete } : {}),
    };
  } catch (error) {
    return { state: "damaged", reason: error instanceof Error ? error.message : String(error) };
  }
}

export function writeGeneralized(home: string, artifact: GeneralizedArtifact): void {
  const saved = GeneralizedArtifactSchema.parse(artifact);
  atomicWriteFilePrivate(path.join(home, GENERALIZED_PATH), `${JSON.stringify(saved, null, 2)}\n`);
}
