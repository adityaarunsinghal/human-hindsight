import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseSourcesJson, type SourcesJson } from "./artifacts.js";

/**
 * core/library.ts: read access to `<home>/library`, shared by the
 * browsing commands (list/show/copy/status) and preference aggregation.
 */

/**
 * Directories under `library/` that are not task entries: `subagents/` holds
 * the saved suggest-subagents result (`SUBAGENTS_DIR` in `core/subagents.ts`,
 * not imported here to avoid an import cycle). A task slug has at least two
 * words, so it can never collide with these names.
 */
const RESERVED_LIBRARY_DIRS = new Set(["subagents"]);

/** One library entry on disk. */
export interface LibraryEntry {
  slug: string;
  dir: string;
  oneshotPath: string;
  sources: SourcesJson;
}

/**
 * Read every library entry that has a parseable, schema-valid `sources.json`,
 * sorted by `authored_at` descending (newest first). Directories whose
 * sources.json is missing, unreadable, or fails validation are skipped here;
 * `status` surfaces them via {@link readLibraryIssues}.
 */
export function readLibrary(home: string): LibraryEntry[] {
  const libraryDir = path.join(home, "library");
  let dirs: string[];
  try {
    dirs = fs
      .readdirSync(libraryDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const entries: LibraryEntry[] = [];
  for (const slug of dirs) {
    const dir = path.join(libraryDir, slug);
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, "sources.json"), "utf8");
    } catch {
      continue; // no sources.json: flagged by status
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // malformed JSON: flagged by status
    }
    const recorded = parseSourcesJson(parsed);
    if (!recorded) continue; // not a valid sources record: flagged by status
    const oneshotPath = path.join(dir, `${slug}.oneshot.md`);
    entries.push({
      slug,
      dir,
      oneshotPath,
      sources: publishedSources(dir, slug, oneshotPath, recorded),
    });
  }

  entries.sort((a, b) => (b.sources.authored_at ?? "").localeCompare(a.sources.authored_at ?? ""));
  return entries;
}

/**
 * The provenance that goes with the prompt on disk. A publication that stopped
 * between its two writes left the new prompt and its intent: when the prompt
 * is exactly the one the intent names, the intent's provenance is the
 * prompt's own, as {@link isEdited} also judges. Otherwise `sources.json`.
 */
function publishedSources(
  dir: string,
  slug: string,
  oneshotPath: string,
  recorded: SourcesJson,
): SourcesJson {
  const intent = readPublishIntent(dir, slug);
  if (!intent || intent.oneshot_hash === recorded.oneshot_hash) return recorded;
  try {
    return oneshotHash(fs.readFileSync(oneshotPath, "utf8")) === intent.oneshot_hash
      ? intent.sources
      : recorded;
  } catch {
    return recorded;
  }
}

/** A library directory whose sources.json could not be read/validated. */
export interface LibraryIssue {
  slug: string;
  reason: string;
}

/**
 * Report library directories that {@link readLibrary} skipped: missing,
 * unreadable, malformed, or schema-invalid `sources.json`. `status` surfaces
 * these so a broken entry is visible rather than silently absent.
 */
export function readLibraryIssues(home: string): LibraryIssue[] {
  const libraryDir = path.join(home, "library");
  let dirs: string[];
  try {
    dirs = fs
      .readdirSync(libraryDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !RESERVED_LIBRARY_DIRS.has(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }

  const issues: LibraryIssue[] = [];
  for (const slug of dirs) {
    const sourcesPath = path.join(libraryDir, slug, "sources.json");
    let raw: string;
    try {
      raw = fs.readFileSync(sourcesPath, "utf8");
    } catch {
      issues.push({ slug, reason: "missing sources.json" });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      issues.push({ slug, reason: "sources.json is not valid JSON" });
      continue;
    }
    if (!parseSourcesJson(parsed)) {
      issues.push({ slug, reason: "sources.json failed schema validation" });
    }
  }
  return issues.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Find one entry by slug; null when absent. */
export function findEntry(home: string, slug: string): LibraryEntry | null {
  return readLibrary(home).find((e) => e.slug === slug) ?? null;
}

/**
 * Content hash of a written oneshot file: the basis of overwrite protection.
 * The author stage records this in `sources.json` at write time; a later
 * mismatch means the USER edited the file, and re-authoring must not silently
 * destroy their work.
 */
export function oneshotHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Publication writes two files: the prompt, then `sources.json`. Before the
 * first write it records this intent beside them, and removes it after the
 * second. A process that dies in between leaves the intent, which names the
 * exact prompt it was publishing. A prompt file equal to it, byte for byte,
 * is the tool's own output whose provenance did not land yet, never a hand
 * edit; any other content is judged against `sources.json` as usual.
 */
export const PUBLISH_INTENT_FILE = ".publishing.json";

/** The recorded intent of a publication that has not finished. */
export interface PublishIntent {
  version: 1;
  slug: string;
  /** {@link oneshotHash} of the prompt being published. */
  oneshot_hash: string;
  /** The generated provenance that goes with it. */
  sources: SourcesJson;
}

/** The unfinished publication intent in an entry folder; null when absent or unreadable. */
export function readPublishIntent(dir: string, slug: string): PublishIntent | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, PUBLISH_INTENT_FILE), "utf8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<PublishIntent>;
    const sources = parseSourcesJson(value?.sources);
    if (
      value?.version !== 1 ||
      value.slug !== slug ||
      typeof value.oneshot_hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.oneshot_hash) ||
      !sources ||
      sources.slug !== slug ||
      sources.oneshot_hash !== value.oneshot_hash
    )
      return null;
    return { version: 1, slug, oneshot_hash: value.oneshot_hash, sources };
  } catch {
    return null;
  }
}

/**
 * Has the user modified this entry's oneshot since it was authored?
 * False for entries with no recorded hash (nothing to compare), for
 * unreadable files (missing files are a different failure, not an edit), and
 * for a prompt an interrupted publication wrote ({@link PUBLISH_INTENT_FILE}).
 */
export function isEdited(entry: LibraryEntry): boolean {
  const recorded = entry.sources.oneshot_hash;
  if (!recorded) return false;
  let hash: string;
  try {
    hash = oneshotHash(fs.readFileSync(entry.oneshotPath, "utf8"));
  } catch {
    return false;
  }
  if (hash === recorded) return false;
  return readPublishIntent(entry.dir, entry.slug)?.oneshot_hash !== hash;
}

/**
 * The words every place uses for a prompt whose group had no session that
 * reached a result that could be verified (see `groupOutcome` in
 * `core/outcome.ts`). Lowercase; a label starts it with a capital.
 */
export const OUTCOME_NOT_VERIFIED = "outcome not verified";

/**
 * Was this prompt written from at least one session that reached a result?
 * `sources.json` records the opposite only, as `outcome_verified: false`; an
 * absent field (every file written before the mark existed) reads as verified,
 * so nothing already in a library changes meaning.
 */
export function isOutcomeVerified(sources: SourcesJson): boolean {
  return (sources as { outcome_verified?: unknown }).outcome_verified !== false;
}

/** A parsed oneshot file: provenance comment, title heading, prompt body. */
export interface ParsedOneshot {
  provenance: string | null;
  title: string | null;
  /** The paste-able prompt itself (what `copy` puts on the clipboard). */
  body: string;
}

/**
 * Split a written oneshot file back into its three parts. The file format is
 * ours (provenance HTML comment + `# title` + body; see the author stage),
 * so plain string surgery is reliable.
 */
export function parseOneshot(content: string): ParsedOneshot {
  let rest = content;
  let provenance: string | null = null;
  const trimmed = rest.trimStart();
  if (trimmed.startsWith("<!--")) {
    const end = trimmed.indexOf("-->");
    if (end !== -1) {
      provenance = trimmed.slice(0, end + 3);
      rest = trimmed.slice(end + 3);
    }
  }
  rest = rest.trim();

  let title: string | null = null;
  if (rest.startsWith("# ")) {
    const nl = rest.indexOf("\n");
    title = (nl === -1 ? rest.slice(2) : rest.slice(2, nl)).trim();
    rest = nl === -1 ? "" : rest.slice(nl + 1);
  }

  return { provenance, title, body: rest.trim() };
}

/** The current grouping, as far as the left-behind rule needs it (`loadTasks` gives this shape). */
export interface CurrentGrouping {
  generation: string;
  tasks: readonly { slug: string }[];
}

/**
 * True for an entry left behind when sessions were regrouped: its task is not
 * in the current grouping, or it was written for another grouping run (same
 * slug, older generation). A prompt the person edited for a task that still
 * exists is not left behind: later runs keep it on purpose, so it is the
 * current prompt for that task. The entry stays on disk because it may be
 * edited or rated; `prune` removes it. Without a grouping file, every entry
 * counts as current. One rule for `status`, `prune`, and the browser view.
 */
export function fromEarlierGrouping(
  entry: { slug: string; sources: Pick<SourcesJson, "generation"> },
  grouping: CurrentGrouping | null,
  options: { edited?: boolean } = {},
): boolean {
  if (!grouping) return false;
  if (!grouping.tasks.some((task) => task.slug === entry.slug)) return true;
  return entry.sources.generation !== grouping.generation && !options.edited;
}
