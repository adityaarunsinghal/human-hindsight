import fs from "node:fs";
import {
  type CurrentPreferences,
  type GeneralizedGap,
  inspectGeneralized,
} from "../core/generalized.js";
import { fromEarlierGrouping, isEdited, isOutcomeVerified, readLibrary } from "../core/library.js";
import { preferenceReview, readPreferenceReviews } from "../core/preference-review.js";
import {
  type AggregatedPreference,
  preferenceId,
  readObservedPreferences,
} from "../core/preferences.js";
import { type Lesson, readSuggestion, SuggestionReadError } from "../core/subagents.js";
import { loadTasks } from "../distill/checkpoints.js";
import type { LiveAgreements } from "./live-batches.js";
import {
  type AgreementFacts,
  type AgreementSource,
  agreementFacts,
  agreementHighlights,
  OUTCOME_NOT_VERIFIED_LABEL,
  organizeAgreements,
  supportLabel,
} from "./overview.js";
import { countLabel, roleKey } from "./subagents-view.js";

/**
 * The saved working agreements as the page shows them:
 * - `none`: nothing generated yet;
 * - `ready`: readable, with `stale` set when the preferences or reviews they
 *   were made from changed since;
 * - `damaged`: the file exists but cannot be read, and the page offers the
 *   candidates instead. The reason can name a file path, so it is not sent.
 */
export interface GuiAgreements {
  live?: LiveAgreements;
  /** A reflection is still running and adding to this library. */
  running?: boolean;
  state: "none" | "ready" | "damaged";
  generatedAt: string | null;
  stale: boolean;
  lessons: Lesson[];
  /** One entry per lesson, in the same order: its group and its support (see overview.ts). */
  facts: AgreementFacts[];
  /** How many preferences the set was made from. */
  preferenceCount: number;
  /** Set when the saved set covers only part of the preferences; its agreements still show. */
  incomplete: GeneralizedGap | null;
}

const EMPTY = { lessons: [], facts: [], preferenceCount: 0, incomplete: null };

/** What each preference contributes to the agreements made from it, keyed by preference ID. */
export function agreementSources(
  prefs: readonly AggregatedPreference[],
): Map<string, AgreementSource> {
  const unique = (values: (string | undefined)[]) =>
    [...new Set(values)].filter((value): value is string => Boolean(value));
  return new Map(
    prefs.map((pref) => {
      // The same domains the Preferences list shows: the evidence first, then its own.
      const evidence = pref.occurrences.flatMap((occurrence) => occurrence.domains ?? []);
      return [
        preferenceId(pref),
        {
          domains: evidence.length ? evidence : (pref.domains ?? []),
          projects:
            pref.scope === "project" && pref.project
              ? [pref.project]
              : unique(pref.occurrences.map((occurrence) => occurrence.project)),
          sessions: unique(
            pref.occurrences.map((occurrence) =>
              occurrence.quote ? occurrence.exportName : undefined,
            ),
          ),
        },
      ];
    }),
  );
}

/** The one reader of the saved agreements for the page: the agreements route and the highlights. */
export function savedAgreements(home: string, current?: CurrentPreferences): GuiAgreements {
  const saved = inspectGeneralized(home, current);
  switch (saved.state) {
    case "absent":
      return { state: "none", generatedAt: null, stale: false, ...EMPTY };
    case "damaged":
      return { state: "damaged", generatedAt: null, stale: false, ...EMPTY };
    case "ok": {
      const { artifact } = saved;
      const sources = agreementSources(current?.prefs ?? readObservedPreferences(home));
      return {
        state: "ready",
        generatedAt: artifact.generated_at,
        stale: saved.stale,
        lessons: artifact.lessons,
        facts: artifact.lessons.map((lesson) => agreementFacts(lesson, sources)),
        preferenceCount: new Set(
          Object.values(artifact.windows).flatMap((window) => window.input_ids),
        ).size,
        incomplete: saved.incomplete ?? null,
      };
    }
  }
}

export interface Highlight {
  id: string;
  /** Why this item comes first, from the same count or review decision that ranked it. */
  reason: string;
  /** Set when the saved result it belongs to no longer matches its sources. */
  stale?: true;
}

export interface GuiHighlights {
  prompts: Highlight[];
  agreements: Highlight[];
  candidates: Highlight[];
  subagents: Highlight[];
}

/** Each reason uses the same count or review decision that put the item first. */
export function readHighlights(home: string): GuiHighlights {
  const grouping = loadTasks(home);
  // Never a prompt left behind by a regrouping: the newcomer starts with current ones.
  const offered = readLibrary(home).filter(
    (entry) =>
      entry.sources.rating !== "down" &&
      !fromEarlierGrouping(entry, grouping, { edited: isEdited(entry) }) &&
      fs.existsSync(entry.oneshotPath),
  );
  // A prompt whose outcome was not verified is offered only when no verified one is.
  const verified = offered.filter((entry) => isOutcomeVerified(entry.sources));
  const prompts = (verified.length ? verified : offered)
    .sort(
      (a, b) =>
        Number(b.sources.rating === "up") - Number(a.sources.rating === "up") ||
        b.sources.members.length - a.sources.members.length ||
        b.sources.authored_at.localeCompare(a.sources.authored_at) ||
        a.slug.localeCompare(b.slug),
    )
    .slice(0, 3)
    .map(({ slug, sources }) => ({
      id: slug,
      reason: `${sources.rating === "up" ? "Liked · " : ""}Based on ${countLabel(sources.members.length, "session")}${isOutcomeVerified(sources) ? "" : ` · ${OUTCOME_NOT_VERIFIED_LABEL}`}`,
    }));
  const current = {
    prefs: readObservedPreferences(home),
    reviews: readPreferenceReviews(home).reviews,
  };
  // Strongly supported preferences come first. A saved review adds context.
  const candidates = current.prefs
    .map((pref) => ({ pref, status: preferenceReview(home, pref, current.reviews).status }))
    .filter(({ status }) => status !== "dismissed")
    .sort(
      (a, b) =>
        b.pref.count - a.pref.count ||
        b.pref.lastAuthoredAt.localeCompare(a.pref.lastAuthoredAt) ||
        preferenceId(a.pref).localeCompare(preferenceId(b.pref)),
    )
    .slice(0, 3)
    .map(({ pref, status }) => ({
      id: preferenceId(pref),
      reason: `${supportLabel(pref.count, pref.verified === true, "long")}${status === "accepted" ? " · Accepted" : ""}`,
    }));
  const saved = savedAgreements(home, current);
  // Only general agreements, by the same grouping and order the page shows.
  const agreements: Highlight[] = agreementHighlights(organizeAgreements(saved.facts)).map(
    (highlight) => (saved.stale ? { ...highlight, stale: true as const } : highlight),
  );
  const subagents: Highlight[] = [];
  try {
    const saved = readSuggestion(home, current);
    const artifact = saved?.artifact;
    if (artifact) {
      subagents.push(
        ...[...artifact.roles]
          .sort((a, b) => b.lesson_ids.length - a.lesson_ids.length)
          .slice(0, 3)
          .map((role) => ({
            id: roleKey(role.name),
            reason: `Brings together ${countLabel(role.lesson_ids.length, "preference")}`,
          })),
      );
      if (subagents.length < 3 && artifact.shared.length) {
        subagents.push({ id: "shared", reason: "Applies to every suggested role" });
      }
      if (subagents.length < 2) {
        subagents.push({
          id: "coverage",
          reason: `Shows where ${countLabel(artifact.coverage.source_candidates, "preference")} went`,
        });
      }
      if (saved.stale) for (const highlight of subagents) highlight.stale = true;
    }
  } catch (error) {
    if (!(error instanceof SuggestionReadError)) throw error;
  }
  return { prompts, agreements, candidates, subagents };
}
