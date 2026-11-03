import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  type Consolidated,
  ConsolidateSchema,
  PreferenceCitationSchema,
  PreferenceScopeSchema,
} from "../claude/schemas.js";
import { FILE_MODE, mkdirPrivate } from "./fsutil.js";
import { type AggregatedPreference, type PreferencesTarget, preferenceId } from "./preferences.js";

export const CONSOLIDATED_PREFERENCES_FILE = "preferences.consolidated.json";

const SavedPreferencesSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    generated_at: z.iso.datetime(),
    source_hash: z.string().regex(/^[a-f0-9]{64}$/),
    source_preferences: z.array(
      z.object({
        id: z.string().optional(),
        text: z.string(),
        count: z.number(),
        scope: PreferenceScopeSchema.optional(),
        project: z.string().optional(),
        citations: z.array(PreferenceCitationSchema).optional(),
        occurrences: z
          .array(
            z.object({
              slug: z.string(),
              evidence: z.string(),
              exportName: z.string().optional(),
              messageId: z.string().optional(),
              quote: z.string().optional(),
              timestamp: z.string().optional(),
              project: z.string().optional(),
              sourceRevision: z.string().optional(),
            }),
          )
          .optional(),
      }),
    ),
    task_count: z.number().int().nonnegative(),
    target: z.enum(["claude", "kiro", "agents"]),
    project: z.string().optional(),
    include_unreviewed: z.boolean().optional(),
    // Version 1 artifacts used a model-reported count; preserve them for reading.
    preferences: z.array(
      z
        .object({
          text: z.string(),
          source_ids: z.array(z.string()).optional(),
          merged_from: z.number().int().positive().optional(),
        })
        .refine((p) => Boolean(p.source_ids?.length || p.merged_from), "Missing source mapping"),
    ),
    markdown: z.string(),
  })
  .superRefine((artifact, ctx) => {
    if (artifact.version !== 2) return;
    const ids = new Set(artifact.source_preferences.map((p) => p.id));
    const covered = new Set<string>();
    for (const preference of artifact.preferences) {
      if (!preference.source_ids?.length) {
        ctx.addIssue({ code: "custom", message: "Version 2 requires source IDs" });
        continue;
      }
      for (const id of preference.source_ids) {
        if (!ids.has(id) || covered.has(id))
          ctx.addIssue({ code: "custom", message: "Invalid source mapping" });
        covered.add(id);
      }
    }
    if (
      ids.has(undefined) ||
      ids.size !== artifact.source_preferences.length ||
      covered.size !== ids.size ||
      !artifact.preferences.length
    ) {
      ctx.addIssue({ code: "custom", message: "Incomplete consolidation coverage" });
    }
  });
export type SavedPreferences = z.infer<typeof SavedPreferencesSchema>;

/** Fingerprint exactly the preference text and frequencies sent to the model. */
export function preferencesFingerprint(
  prefs: Pick<AggregatedPreference, "text" | "count" | "id" | "scope" | "project">[],
): string {
  const inputs = prefs
    .map((p) => ({
      id: preferenceId(p),
      text: p.text,
      count: p.count,
      scope: p.scope ?? "global",
      project: p.scope && p.scope !== "global" ? (p.project ?? "") : "",
    }))
    .sort((a, b) => a.id.localeCompare(b.id) || a.count - b.count || a.text.localeCompare(b.text));
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
}

function literalRule(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "");
}

/** Preserve explicit English condition clauses; this is not semantic equivalence. */
function conditions(text: string): string[] {
  return [
    ...literalRule(text).matchAll(
      /\b(?:unless|only when|except(?: when| if| for)?|if)\b[^,;.!?\n]*/g,
    ),
  ]
    .map((match) => match[0].trim())
    .sort();
}

function polarity(text: string): { negative: boolean; predicate: string } {
  const normalized = literalRule(text).replace(/^please\s+/, "");
  const negative = /^(?:never|do not|don't|must not)\s+/.test(normalized);
  return {
    negative,
    predicate: normalized.replace(/^(?:never|do not|don't|must not|always|must)\s+/, ""),
  };
}

/** Narrow safeguards for literal contradictions and lost qualifiers. */
function validateQualifiers(originals: AggregatedPreference[], text: string): string[] {
  const problems: string[] = [];
  const output = literalRule(text);
  const conditionSets = new Set(originals.map((p) => JSON.stringify(conditions(p.text))));
  if (conditionSets.size > 1) {
    problems.push("combines different explicit conditions; keep those rules separate");
  }
  const predicates = new Map<string, Set<boolean>>();
  for (const original of originals) {
    const source = literalRule(original.text);
    for (const condition of conditions(original.text)) {
      if (!output.includes(condition)) problems.push(`removed or changed condition "${condition}"`);
    }
    if (/\bprefer\b/.test(source) && !/\bprefer\b/.test(output)) {
      problems.push('removed the "prefer" qualifier');
    }
    const sourcePolarity = polarity(source);
    const outputPolarity = polarity(output);
    if (
      sourcePolarity.predicate === outputPolarity.predicate &&
      sourcePolarity.negative !== outputPolarity.negative
    ) {
      problems.push("reversed an explicit instruction's polarity");
    }
    const signs = predicates.get(sourcePolarity.predicate) ?? new Set<boolean>();
    signs.add(sourcePolarity.negative);
    predicates.set(sourcePolarity.predicate, signs);
  }
  if ([...predicates.values()].some((signs) => signs.size > 1)) {
    problems.push("combines explicitly opposing instructions; keep those rules separate");
  }
  for (const qualifier of ["always", "must", "never", "required", "mandatory"]) {
    const pattern = new RegExp(`\\b${qualifier}\\b`);
    if (pattern.test(output) && !originals.some((p) => pattern.test(literalRule(p.text)))) {
      problems.push(`introduced stronger qualifier "${qualifier}"`);
    }
  }
  return problems;
}

/** Structural and scope checks complement the model's semantic grouping judgment. */
export function validateConsolidation(
  source: AggregatedPreference[],
  consolidated: Consolidated,
): string[] {
  const problems: string[] = [];
  const known = new Map(source.map((p) => [preferenceId(p), p]));
  const covered = new Set<string>();
  if (source.length && !consolidated.preferences.length)
    problems.push("nonempty input needs a nonempty result");
  for (const [index, preference] of consolidated.preferences.entries()) {
    if (!preference.text.trim()) problems.push(`item ${index + 1} has empty text`);
    if (!preference.source_ids?.length) {
      problems.push(`item ${index + 1} must name its source_ids`);
      continue;
    }
    const scopes = new Set<string>();
    const originals: AggregatedPreference[] = [];
    for (const id of preference.source_ids) {
      const original = known.get(id);
      if (!original) problems.push(`item ${index + 1} references unknown source "${id}"`);
      else {
        originals.push(original);
        scopes.add(
          JSON.stringify([
            original.scope ?? "global",
            original.scope && original.scope !== "global" ? (original.project ?? "") : "",
          ]),
        );
      }
      if (covered.has(id)) problems.push(`source "${id}" appears more than once`);
      covered.add(id);
    }
    if (scopes.size > 1) problems.push(`item ${index + 1} merges incompatible scopes or projects`);
    for (const issue of validateQualifiers(originals, preference.text)) {
      problems.push(`item ${index + 1} ${issue}`);
    }
  }
  for (const id of known.keys()) {
    if (!covered.has(id)) problems.push(`source "${id}" was omitted`);
  }
  return problems;
}

/** Recover evidence and counts from source data instead of trusting generated totals. */
export function materializeConsolidation(
  source: AggregatedPreference[],
  consolidated: Consolidated,
): AggregatedPreference[] {
  const known = new Map(source.map((p) => [preferenceId(p), p]));
  return consolidated.preferences.map((preference) => {
    const originals = preference.source_ids
      .map((id) => known.get(id))
      .filter((p): p is AggregatedPreference => Boolean(p));
    const occurrences = [
      ...new Map(
        originals
          .flatMap((p) => p.occurrences)
          .map((o) => [
            JSON.stringify([o.exportName, o.messageId, o.quote, o.slug, o.evidence]),
            o,
          ]),
      ).values(),
    ];
    const evidenceSources = new Set(occurrences.map((o) => o.exportName || o.slug).filter(Boolean));
    const citations = [
      ...new Map(
        originals
          .flatMap((p) => p.citations ?? [])
          .map((citation) => [JSON.stringify(citation), citation]),
      ).values(),
    ];
    return {
      text: preference.text,
      count: evidenceSources.size || originals.length,
      occurrences,
      lastAuthoredAt:
        originals
          .map((p) => p.lastAuthoredAt)
          .sort()
          .at(-1) ?? "",
      scope: originals[0]?.scope ?? "global",
      project: originals[0]?.project,
      basis: originals.every((p) => p.basis === "explicit") ? "explicit" : "inferred",
      verified: originals.every((p) => p.verified === true),
      citations,
    };
  });
}

/** Keep the last successful result intact until its replacement is fully written. */
export function saveConsolidatedPreferences(
  home: string,
  opts: {
    source: AggregatedPreference[];
    consolidated: Consolidated;
    taskCount: number;
    target: PreferencesTarget;
    markdown: string;
    now: Date;
    project?: string;
    includeUnreviewed?: boolean;
  },
): string {
  const parsed = ConsolidateSchema.parse(opts.consolidated);
  const problems = validateConsolidation(opts.source, parsed);
  if (problems.length) throw new Error(`Invalid consolidated preferences: ${problems.join("; ")}`);
  const dir = path.join(home, "library");
  mkdirPrivate(dir);
  const file = path.join(dir, CONSOLIDATED_PREFERENCES_FILE);
  const temp = `${file}.${randomUUID()}.tmp`;
  const artifact: SavedPreferences = {
    version: 2,
    generated_at: opts.now.toISOString(),
    source_hash: preferencesFingerprint(opts.source),
    source_preferences: opts.source.map((p) => ({
      id: preferenceId(p),
      text: p.text,
      count: p.count,
      scope: p.scope ?? "global",
      project: p.project,
      citations: p.citations,
      occurrences: p.occurrences,
    })),
    task_count: opts.taskCount,
    target: opts.target,
    project: opts.project,
    include_unreviewed: opts.includeUnreviewed ?? false,
    preferences: parsed.preferences,
    markdown: opts.markdown,
  };
  try {
    fs.writeFileSync(temp, `${JSON.stringify(artifact, null, 2)}\n`, {
      flag: "wx",
      mode: FILE_MODE,
    });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return file;
}

/** A missing result is normal; a damaged result is surfaced without hiding the library. */
export function readConsolidatedPreferences(home: string): {
  artifact: SavedPreferences | null;
  invalid: boolean;
} {
  try {
    const file = path.join(home, "library", CONSOLIDATED_PREFERENCES_FILE);
    const result = SavedPreferencesSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    return result.success
      ? { artifact: result.data, invalid: false }
      : { artifact: null, invalid: true };
  } catch (err) {
    return {
      artifact: null,
      invalid: (err as NodeJS.ErrnoException).code !== "ENOENT",
    };
  }
}
