import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { FILE_MODE, mkdirPrivate } from "./fsutil.js";
import { type AggregatedPreference, preferenceId } from "./preferences.js";

export const PREFERENCE_REVIEW_FILE = "preferences.review.json";
export type PreferenceScope = "global" | "project" | "task";
export type ReviewStatus = "pending" | "accepted" | "dismissed";

const ReviewSchema = z.object({
  status: z.enum(["accepted", "dismissed"]),
  source_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  updated_at: z.iso.datetime(),
  text: z.string().trim().min(1).max(8000),
  scope: z.enum(["global", "project", "task"]),
  project: z.string().max(2000).optional(),
});
const ReviewFileSchema = z.object({
  version: z.literal(1),
  reviews: z.record(z.string().regex(/^[a-f0-9]{64}$/), ReviewSchema),
});
type StoredReview = z.infer<typeof ReviewSchema>;
export type PreferenceReviews = Record<string, StoredReview>;

export interface PreferenceReview {
  status: ReviewStatus;
  revision: string;
  stale: boolean;
  text: string;
  scope: PreferenceScope;
  project?: string;
}

/** Acceptance is tied to the exact rule and evidence the human reviewed. */
export function preferenceRevision(preference: AggregatedPreference): string {
  const evidence = preference.occurrences
    .map((occurrence) => ({
      export: occurrence.exportName ?? occurrence.slug,
      message: occurrence.messageId ?? "",
      quote: occurrence.quote ?? occurrence.evidence,
      sourceRevision: occurrence.sourceRevision ?? "",
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256")
    .update(
      JSON.stringify({
        text: preference.text.trim(),
        scope: preference.scope ?? "global",
        project: preference.project ?? "",
        verified: preference.verified === true,
        evidence,
      }),
    )
    .digest("hex");
}

export function readPreferenceReviews(home: string): {
  reviews: PreferenceReviews;
  invalid: boolean;
} {
  try {
    const file = path.join(home, "library", PREFERENCE_REVIEW_FILE);
    const parsed = ReviewFileSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    return parsed.success
      ? { reviews: parsed.data.reviews, invalid: false }
      : { reviews: {}, invalid: true };
  } catch (error) {
    return {
      reviews: {},
      invalid: (error as NodeJS.ErrnoException).code !== "ENOENT",
    };
  }
}

export function preferenceReview(
  home: string,
  preference: AggregatedPreference,
  reviews = readPreferenceReviews(home).reviews,
): PreferenceReview {
  const revision = preferenceRevision(preference);
  const stored = reviews[preferenceId(preference)];
  const stale = Boolean(stored && stored.source_fingerprint !== revision);
  const current = stored && !stale ? stored : undefined;
  return {
    status: current?.status ?? "pending",
    revision,
    stale,
    text: current?.text ?? preference.text,
    scope: current?.scope ?? preference.scope ?? "global",
    project: current ? current.project : preference.project,
  };
}

/** A single candidate review; never accepts an arbitrary path or a new rule. */
export function savePreferenceReview(
  home: string,
  preference: AggregatedPreference,
  update: {
    status: ReviewStatus;
    text?: string;
    scope?: PreferenceScope;
    project?: string;
  },
  expectedRevision = preferenceRevision(preference),
): PreferenceReview {
  if (expectedRevision !== preferenceRevision(preference)) {
    throw new Error("This preference changed. Refresh and review its current evidence.");
  }
  const state = readPreferenceReviews(home);
  if (state.invalid) {
    throw new Error("Saved preference reviews could not be read; the file was left untouched.");
  }
  const id = preferenceId(preference);
  if (update.status === "pending") {
    delete state.reviews[id];
  } else {
    const scope = update.scope ?? preference.scope ?? "global";
    const project = scope === "global" ? undefined : (update.project ?? preference.project)?.trim();
    if (scope === "project" && !project) {
      throw new Error("Choose a project for a project-scoped instruction.");
    }
    state.reviews[id] = ReviewSchema.parse({
      status: update.status,
      source_fingerprint: expectedRevision,
      updated_at: new Date().toISOString(),
      text: update.text ?? preference.text,
      scope,
      ...(project ? { project } : {}),
    });
  }
  const directory = path.join(home, "library");
  mkdirPrivate(directory);
  const target = path.join(directory, PREFERENCE_REVIEW_FILE);
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, reviews: state.reviews }, null, 2)}\n`, {
      flag: "wx",
      mode: FILE_MODE,
    });
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return preferenceReview(home, preference, state.reviews);
}

/** Only accepted global rules, plus accepted rules for an explicitly chosen project. */
export function reviewedPreferences(
  home: string,
  preferences: AggregatedPreference[],
  project?: string,
): AggregatedPreference[] {
  const { reviews } = readPreferenceReviews(home);
  return preferences.flatMap((preference) => {
    const review = preferenceReview(home, preference, reviews);
    if (
      review.status !== "accepted" ||
      review.scope === "task" ||
      (review.scope === "project" && (!project || review.project !== project))
    ) {
      return [];
    }
    return [
      {
        ...preference,
        id: preferenceId(preference),
        text: review.text,
        scope: review.scope,
        project: review.project,
      },
    ];
  });
}
