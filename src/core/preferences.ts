import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DigestSchema, type PreferenceCitation, type PreferenceScope } from "../claude/schemas.js";
import type { SourceName } from "../sources/types.js";
import { digestSourceFingerprint } from "./fingerprint.js";
import { type LibraryEntry, readLibrary } from "./library.js";
import { exportMessages, validatePreferenceCandidates } from "./preference-evidence.js";

/**
 * core/preferences.ts — deterministic preference aggregation.
 *
 * Collect `preferences[]` from every library entry's `sources.json`,
 * normalize, dedupe near-identical strings, rank by frequency × recency, and
 * emit a paste-ready `CLAUDE.md` block with evidence counts. No LLM here —
 * the optional `--consolidate` pass lives behind the consent gate in the
 * preferences command.
 */

/** One aggregated preference across the library. */
export interface AggregatedPreference {
  /** Canonical text (the most recently authored phrasing). */
  text: string;
  /** Independent source sessions; legacy unverified records count source tasks. */
  count: number;
  /** Which tasks, with their one-line evidence. */
  occurrences: {
    slug: string;
    evidence: string;
    exportName?: string;
    messageId?: string;
    quote?: string;
    timestamp?: string;
    project?: string;
    origin?: SourceName;
    domains?: string[];
    sourceRevision?: string;
  }[];
  /** Most recent authored_at among the occurrences (recency tiebreak). */
  lastAuthoredAt: string;
  id?: string;
  scope?: PreferenceScope;
  basis?: "explicit" | "inferred";
  project?: string;
  citations?: PreferenceCitation[];
  verified?: boolean;
  domains?: string[];
}

/** Text, scope, and project identify a candidate; an accepted edit keeps its original ID. */
export function preferenceId<
  T extends Pick<AggregatedPreference, "text" | "scope" | "project" | "id">,
>(pref: T): string {
  if (pref.id) return pref.id;
  const normalized = normalizeKey(pref.text);
  // Global IDs retain bookmarks created before scoped candidates existed.
  const identity =
    !pref.scope || pref.scope === "global"
      ? normalized
      : JSON.stringify([normalized, pref.scope, pref.project ?? ""]);
  return createHash("sha256").update(identity).digest("hex");
}

/**
 * Normalization key for near-identical dedupe: trim, case-fold, collapse
 * whitespace, strip punctuation. "Diagnose before acting." and "diagnose
 * before acting" are the same preference.
 */
export function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Aggregate preferences from library entries: dedupe by normalized key, count
 * per-task occurrences (a task stating the same thing twice counts once),
 * rank by frequency desc, then recency desc, then text asc (determinism).
 */
export function aggregatePreferences(entries: LibraryEntry[]): AggregatedPreference[] {
  const byKey = new Map<string, AggregatedPreference>();

  for (const entry of entries) {
    const seenInTask = new Set<string>();
    for (const pref of entry.sources.preferences ?? []) {
      if (!normalizeKey(pref.text)) continue;
      const key = preferenceId(pref);
      if (seenInTask.has(key)) continue;
      seenInTask.add(key);

      const authoredAt = entry.sources.authored_at ?? "";
      const existing = byKey.get(key);
      if (existing) {
        existing.count++;
        existing.occurrences.push({ slug: entry.slug, evidence: pref.evidence });
        if (authoredAt > existing.lastAuthoredAt) {
          existing.lastAuthoredAt = authoredAt;
          existing.text = pref.text.trim(); // newest phrasing wins
        }
      } else {
        byKey.set(key, {
          text: pref.text.trim(),
          count: 1,
          occurrences: [{ slug: entry.slug, evidence: pref.evidence }],
          lastAuthoredAt: authoredAt,
          ...(pref.scope ? { scope: pref.scope } : {}),
          ...(pref.project ? { project: pref.project } : {}),
          ...(pref.basis ? { basis: pref.basis } : {}),
          ...(pref.citations ? { citations: pref.citations } : {}),
        });
      }
    }
  }

  return [...byKey.values()].sort(
    (a, b) =>
      b.count - a.count ||
      b.lastAuthoredAt.localeCompare(a.lastAuthoredAt) ||
      a.text.localeCompare(b.text),
  );
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Read candidates from all current digests, including failed and misc tasks.
 * Validate stored quotes again against exports. Old library-only observations
 * remain available for explicit review, clearly marked as unverified.
 */
export function readObservedPreferences(home: string): AggregatedPreference[] {
  const library = readLibrary(home);
  const checkpoint = record(readJson(path.join(home, "distill", "digests.json")));
  const digestRecords = record(checkpoint?.digests) ?? {};
  const lineage = record(checkpoint?.lineage) ?? {};
  const outcomes = record(readJson(path.join(home, "exports", "outcomes.json"))) ?? {};
  const rawManifest = readJson(path.join(home, "exports", "manifest.json"));
  const manifest = new Map<string, Record<string, unknown>>();
  if (Array.isArray(rawManifest)) {
    for (const item of rawManifest) {
      const row = record(item);
      if (typeof row?.export === "string") manifest.set(row.export, row);
    }
  }
  const tasks = record(readJson(path.join(home, "distill", "tasks.json")));
  const currentTasks = Array.isArray(tasks?.tasks)
    ? new Set(
        tasks.tasks.flatMap((value) => {
          const task = record(value);
          return typeof task?.slug === "string" ? [task.slug] : [];
        }),
      )
    : null;
  const currentLibrary = library.filter(
    (entry) =>
      entry.sources.rating !== "down" &&
      (!currentTasks ||
        (currentTasks.has(entry.slug) && entry.sources.generation === tasks?.generation)),
  );
  const represented = new Set<string>(
    Array.isArray(checkpoint?.invalidated)
      ? checkpoint.invalidated.filter((value): value is string => typeof value === "string")
      : [],
  );
  const byId = new Map<string, AggregatedPreference>();
  const sessionsById = new Map<string, Set<string>>();

  for (const [exportName, value] of Object.entries(digestRecords)) {
    if (path.basename(exportName) !== exportName) continue;
    if (Array.isArray(rawManifest) && !manifest.has(exportName)) continue;
    if (Object.hasOwn(record(value) ?? {}, "preferences")) represented.add(exportName);
    const parsed = DigestSchema.safeParse(value);
    if (!parsed.success || parsed.data.preferences === undefined) continue;
    represented.add(exportName);
    let content: string;
    try {
      content = fs.readFileSync(path.join(home, "exports", exportName), "utf8");
    } catch {
      continue;
    }
    const messages = exportMessages(exportName, content);
    const byMessage = new Map(messages.map((message) => [message.id, message]));
    const metadata = manifest.get(exportName) ?? record(lineage[exportName]) ?? {};
    const project = typeof metadata.project === "string" ? metadata.project : "";
    const origin =
      typeof metadata.origin === "string" ? (metadata.origin as SourceName) : undefined;
    const sourceLineage = record(lineage[exportName]);
    const sourceHash = digestSourceFingerprint({
      content,
      outcome: outcomes[exportName],
      project,
      sessionId:
        typeof metadata.sessionId === "string"
          ? metadata.sessionId
          : typeof metadata.session_id === "string"
            ? metadata.session_id
            : "",
      origin,
    });
    // Quote matching alone is insufficient: an appended human correction may
    // reverse an earlier instruction while leaving its quoted text intact.
    if (sourceLineage?.source_hash !== sourceHash) continue;
    const observedAt =
      typeof metadata.last_ts === "string"
        ? metadata.last_ts
        : typeof metadata.observed_at === "string"
          ? metadata.observed_at
          : "";
    const source = currentLibrary.find((entry) => entry.sources.members.includes(exportName));
    const domain = parsed.data.domain.trim();
    for (const candidate of parsed.data.preferences) {
      if (validatePreferenceCandidates([candidate], messages).length) continue;
      const identity = {
        text: candidate.text,
        scope: candidate.scope,
        ...(candidate.scope === "global" ? {} : { project }),
      };
      const id = preferenceId(identity);
      const existing = byId.get(id);
      const preference: AggregatedPreference = existing ?? {
        ...identity,
        id,
        basis: candidate.basis,
        verified: true,
        count: 0,
        occurrences: [],
        citations: [],
        domains: [],
        lastAuthoredAt: observedAt,
      };
      const sessions = sessionsById.get(id) ?? new Set<string>();
      sessions.add(exportName);
      sessionsById.set(id, sessions);
      preference.count = sessions.size;
      if (candidate.basis === "explicit") preference.basis = "explicit";
      if (observedAt > preference.lastAuthoredAt) {
        preference.lastAuthoredAt = observedAt;
        preference.text = candidate.text;
      }
      if (domain && !preference.domains?.includes(domain)) preference.domains?.push(domain);
      for (const citation of candidate.citations) {
        if (
          preference.citations?.some(
            (other) => other.message_id === citation.message_id && other.quote === citation.quote,
          )
        )
          continue;
        preference.citations?.push(citation);
        preference.occurrences.push({
          slug: source?.slug ?? "",
          evidence: candidate.evidence,
          exportName,
          messageId: citation.message_id,
          quote: citation.quote,
          timestamp: byMessage.get(citation.message_id)?.timestamp || observedAt,
          project,
          origin,
          domains: domain ? [domain] : [],
          sourceRevision: sourceHash,
        });
      }
      byId.set(id, preference);
    }
  }

  // Once a session has digest candidates, its old authored observations must not
  // re-enter through a second path, even if the new candidate list is empty.
  const legacy = currentLibrary.filter(
    (entry) => !entry.sources.members.some((member) => represented.has(member)),
  );
  for (const preference of aggregatePreferences(legacy)) {
    const item: AggregatedPreference = {
      ...preference,
      scope: preference.scope ?? "global",
      verified: false,
      domains: [
        ...new Set(
          preference.occurrences.flatMap(
            ({ slug }) => library.find((entry) => entry.slug === slug)?.sources.domains ?? [],
          ),
        ),
      ],
    };
    item.id = preferenceId(item);
    const existing = byId.get(item.id);
    if (!existing) byId.set(item.id, item);
    // Verified current evidence wins over ambiguous generated legacy notes.
  }
  return [...byId.values()].sort(
    (a, b) =>
      b.count - a.count ||
      b.lastAuthoredAt.localeCompare(a.lastAuthoredAt) ||
      a.text.localeCompare(b.text),
  );
}

/** Where a preferences block is destined to be pasted. */
export type PreferencesTarget = "claude" | "kiro" | "agents";

/** Per-target leading comment + section heading. */
function targetHeader(
  target: PreferencesTarget,
  date: string,
): { comment: string; heading: string } {
  switch (target) {
    case "kiro":
      // A kiro steering file (~/.kiro/steering/*.md) — auto-loaded by the agent.
      return {
        comment: `<!-- human-hindsight preferences · generated ${date} · paste into ~/.kiro/steering/hindsight-preferences.md -->`,
        heading: "## Working preferences",
      };
    case "agents":
      // An AGENTS.md section — portable across kiro and other agent CLIs.
      return {
        comment: `<!-- human-hindsight preferences · generated ${date} · add to AGENTS.md -->`,
        heading: "## Working preferences",
      };
    default:
      // claude: the original CLAUDE.md block — byte-identical to before.
      return {
        comment: `<!-- human-hindsight preferences · generated ${date} -->`,
        heading: "## Working preferences",
      };
  }
}

/**
 * Render the paste-ready preferences block for a given target. Preferences are
 * grouped by how many tasks stated them, one comment header per group
 * (most-stated first) — repeating the count on every line drowned the signal
 * when most items occur once. Consolidated items (no per-task occurrences)
 * render as a flat list. The BODY is identical across targets; only the leading
 * provenance comment names the destination file.
 */
export function renderPreferencesBlock(
  prefs: AggregatedPreference[],
  taskCount: number,
  target: PreferencesTarget = "claude",
  now = new Date(),
): string {
  const { comment, heading } = targetHeader(target, now.toISOString().slice(0, 10));
  const lines = [comment, heading];
  const grouped = taskCount > 1 && prefs.every((p) => p.occurrences.length > 0);
  let currentCount: number | null = null;
  for (const p of prefs) {
    if (grouped && p.count !== currentCount) {
      currentCount = p.count;
      lines.push(
        "",
        p.verified || p.occurrences.some((o) => o.exportName)
          ? `<!-- observed in ${p.count} source${p.count === 1 ? "" : "s"} -->`
          : `<!-- stated in ${p.count} of ${taskCount} tasks -->`,
      );
    } else if (!grouped && lines.length === 2) {
      lines.push("");
    }
    lines.push(`- ${p.text}`);
  }
  return lines.join("\n");
}

/**
 * The original `CLAUDE.md` block. Kept as a thin, byte-identical wrapper over
 * {@link renderPreferencesBlock} with the claude target, for existing callers.
 * @deprecated Prefer `renderPreferencesBlock(prefs, taskCount, target, now)`.
 */
export function renderClaudeMdBlock(
  prefs: AggregatedPreference[],
  taskCount: number,
  now = new Date(),
): string {
  return renderPreferencesBlock(prefs, taskCount, "claude", now);
}
