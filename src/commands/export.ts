import fs from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import { defineCommand } from "citty";
import {
  type AnaphoraRecord,
  buildAnaphora,
  SHORT_TURN_MAX_WORDS,
  TAIL_CHARS,
} from "../core/anaphora.js";
import { buildCorpus, type Corpus, type CorpusSession, type DedupeInput } from "../core/dedupe.js";
import { writeExportStats } from "../core/export-stats.js";
import { atomicWriteFilePrivate, mkdirPrivate, writeFilePrivate } from "../core/fsutil.js";
import { buildOutcome, FINAL_TURNS, OUTCOME_NOTE, type OutcomeEvidence } from "../core/outcome.js";
import { exportFileName, renderExport } from "../core/render.js";
import { acquireWriterLock, WriterBusyError } from "../distill/operations.js";
import type { StageProgressSink } from "../distill/stage-events.js";
import { SOURCE_PRODUCT_NAMES } from "../sources/labels.js";
import { readSession, SourceReadError } from "../sources/read.js";
import { parseSourceMode, resolveSources } from "../sources/registry.js";
import type {
  ProjectInfo,
  SessionInfo,
  SessionSource,
  SourceName,
  TimelineEvent,
} from "../sources/types.js";
import { glyph, lineWidth } from "../ui/mode.js";
import { terminalPrivacyReminder } from "../ui/privacy.js";
import { type Progress, startProgress } from "../ui/progress.js";
import { startStageProgress } from "../ui/screen.js";
import { counted, dim, hint } from "../ui/style.js";
import { fitLines } from "../ui/wrap.js";
import { parseMessageCount, resolvePaths, sharedArgs } from "./_shared.js";
import { flowArgs, nextCommandText, offerNext } from "./next.js";

/** One entry of `exports/manifest.json`. */
export interface ManifestEntry {
  export: string;
  /** Absolute path to the source transcript (provenance). */
  source: string;
  /**
   * Which backend produced this session. Absent in manifests written before the
   * multi-backend seam ⇒ treat as "claude" (the old-manifest rule); writers
   * always emit it.
   */
  origin?: SourceName;
  project: string;
  sessionId: string;
  messages: number;
  first_ts: string;
  last_ts: string;
}

/** Normalized args the export core reads. */
export interface ExportArgs {
  home?: string;
  "claude-dir"?: string;
  "codex-dir"?: string;
  "kiro-dir"?: string;
  "kirocrew-dir"?: string;
  "opencode-dir"?: string;
  "opencode-db"?: string;
  /** Which backend(s) to read: claude, codex, kiro, kirocrew, opencode, or auto (default auto). */
  source?: string;
  /** Case-insensitive substring filter on project short name. */
  project?: string;
  /** Minimum surviving human messages for a session to be exported (default 1). */
  "min-messages"?: string;
  verbose?: boolean;
  /** Use the live read count and a compact summary in the guided flow. */
  guided?: boolean;
  progress?: StageProgressSink;
  /** The stores to read; defaults to the ones `--source` and the path flags select. */
  sources?: SessionSource[];
  /** Injectable sink for testing; defaults to process.stdout. */
  output?: Writable;
}

/** What a run did, returned for tests and used to print the summary. */
export interface ExportStats {
  /** Sessions written to disk (messages ≥ min-messages). */
  exportedSessions: number;
  /** Total surviving messages across exported sessions. */
  totalMessages: number;
  /** Messages dropped as cross-file fork copies (dedupe rule R8). */
  duplicatesDropped: number;
  /** Sessions excluded by the `--project` filter. */
  skippedByFilter: number;
  /** Sessions with zero surviving human messages (skipped naturally). */
  zeroMessageSessions: number;
  /** Sessions excluded by a source's session-level classifier (kiro automation). */
  automationSkipped: number;
  /**
   * kiro sessions excluded as Kiro Crew runs (rule K15). Their human side is
   * read from the Kiro Crew store, so they are counted apart from automation.
   */
  kirocrewHandedOff: number;
  /** Exported session count broken down by backend (for the merged-store summary). */
  sessionsByOrigin: Partial<Record<SourceName, number>>;
  /** Sessions with some messages but fewer than `--min-messages`. */
  belowMinMessages: number;
  /** Session files that could not be read (skipped, tolerated). */
  readErrors: number;
  /**
   * Of those, how many had an earlier export that was kept as it was: a
   * session that was found but could not be read this time is never pruned.
   */
  keptAfterReadError: number;
  /** Corrupt JSONL lines skipped across all sessions. */
  badLines: number;
  /** Short human turns (≤15 words) attached with anaphora context. */
  shortTurns: number;
  /** Of those, how many had a pending plan/question decision surface. */
  shortTurnsWithDecision: number;
  /** Sessions that captured a non-empty final assistant tail (real outcome evidence). */
  outcomeSessions: number;
  /** Absolute path to the exports directory that was written. */
  exportsDir: string;
  /** Stale `.md` files pruned (unfiltered runs only) because their session is gone. */
  prunedExports: number;
  /** Written markdown basenames, sorted (manifest.json excluded). */
  files: string[];
  /** Set when another command held the writer lock: nothing was read or written. */
  busy?: string;
}

/**
 * The K15 summary line (without indent), shared by export and status so both
 * tell the person, in the same words, where the Kiro Crew runs' text went.
 */
export function kirocrewHandedOffLine(count: number): string {
  return (
    `${count === 1 ? "1 Kiro CLI session was a Kiro Crew run" : `${count} Kiro CLI sessions were Kiro Crew runs`}; ` +
    "their messages are read from the Kiro Crew store (--source kirocrew)"
  );
}

/** The summary line for earlier exports kept because their session could not be read. */
function keptAfterReadErrorLine(count: number): string {
  return `${counted(count, "earlier export")} kept unchanged because ${count === 1 ? "its session" : "their sessions"} could not be read`;
}

/** Whitespace-collapse and cap a short human turn for a one-line verbose row. */
function snippetOneLine(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
}

/** True when a project short name matches the (case-insensitive) filter. */
function projectMatches(shortName: string, filter: string): boolean {
  return shortName.toLowerCase().includes(filter.toLowerCase());
}

/** Recover the source locator from markdown left behind by a filtered export. */
function exportHeaderSource(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const header = Buffer.allocUnsafe(8192);
    const bytes = fs.readSync(fd, header, 0, header.length, 0);
    return /^<!-- source: ([^\r\n]+)\r?\n/.exec(header.toString("utf8", 0, bytes))?.[1];
  } catch {
    return;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** What an earlier manifest recorded for one session, as far as it is valid. */
interface PriorRow {
  export: string;
  source: string;
  origin: SourceName;
  project?: string;
  sessionId?: string;
  /** The whole earlier row, when it came from the manifest (not a file header). */
  entry?: ManifestEntry;
  /** True when the row is in the last export's manifest, not only in the name index. */
  listed?: boolean;
}

const SOURCE_NAMES: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "kiro",
  "kirocrew",
  "opencode",
]);

/**
 * What earlier exports recorded per source: file name, project name and
 * session id. All three are kept on re-export. File names are used by digests,
 * citations and hand-edited library entries; the session id is part of digest
 * identity; the project name feeds project-scoped preference ids and digest
 * source hashes, so a project renamed by a newer discovery rule (for example
 * `app` becoming `my-cool-app`) would otherwise orphan saved reviews and redo
 * every digest. Markdown left without a manifest row still keeps its file
 * name, recovered from its header.
 */
function priorExports(exportsDir: string, index: NameIndex) {
  const rows = new Map<string, PriorRow>();
  const used = new Set<string>();
  const assign = (row: PriorRow) => {
    if (!/^[\w.-]+\.md$/.test(row.export) || used.has(row.export) || rows.has(row.source)) {
      return;
    }
    rows.set(row.source, row);
    used.add(row.export);
  };
  const assignRows = (parsed: unknown, listed: boolean) => {
    if (!Array.isArray(parsed)) return;
    for (const row of parsed) {
      if (typeof row?.source !== "string" || typeof row?.export !== "string") continue;
      assign({
        export: row.export,
        source: row.source,
        // Rows from before the multi-backend seam carry no origin: claude.
        origin: SOURCE_NAMES.has(row.origin) ? row.origin : "claude",
        project: typeof row.project === "string" && row.project ? row.project : undefined,
        sessionId: typeof row.sessionId === "string" && row.sessionId ? row.sessionId : undefined,
        entry: row as ManifestEntry,
        listed,
      });
    }
  };
  try {
    assignRows(JSON.parse(fs.readFileSync(path.join(exportsDir, "manifest.json"), "utf8")), true);
  } catch {
    // An absent or damaged manifest can still have readable markdown exports.
  }
  // Sessions an earlier, narrower export left out of the manifest.
  assignRows(index.sessions, false);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(exportsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { rows, used };
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith(".md") || used.has(entry.name)) continue;
    const source = entry.isFile()
      ? exportHeaderSource(path.join(exportsDir, entry.name))
      : undefined;
    if (source !== undefined) assign({ export: entry.name, source, origin: "claude" });
    used.add(entry.name);
  }
  return { rows, used };
}

/** An earlier JSON index (`anaphora.json`, `outcomes.json`), or {} when absent or damaged. */
function priorIndex(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * `exports/project-names.json`: what every export so far has named. The
 * manifest lists only what the last export covered, so after `--project` or
 * `--source` it no longer holds the other folders' names; this index keeps,
 * for every project folder ever exported, the name it was given, and every
 * session row ever exported, so names, file names, and session ids survive
 * any sequence of filtered and full exports. Read first and updated by every
 * export; a home without it starts from the manifest.
 */
export const NAME_INDEX_FILE = "project-names.json";

interface NameIndex {
  /** Folder key (`<origin>` NUL `<dirName>`) to the name it was given. */
  folders: Map<string, string>;
  /** Manifest rows of every session exported so far, last write wins. */
  sessions: ManifestEntry[];
}

const folderKey = (origin: SourceName, project: ProjectInfo) => `${origin}\u0000${project.dirName}`;

/** The index, or an empty one when it is absent or damaged. */
function readNameIndex(exportsDir: string): NameIndex {
  const index: NameIndex = { folders: new Map(), sessions: [] };
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(exportsDir, NAME_INDEX_FILE), "utf8"),
    );
    if (!parsed || typeof parsed !== "object") return index;
    const { projects, sessions } = parsed as { projects?: unknown; sessions?: unknown };
    if (Array.isArray(projects)) {
      for (const row of projects) {
        if (
          SOURCE_NAMES.has(row?.origin) &&
          typeof row?.folder === "string" &&
          typeof row?.name === "string" &&
          row.name
        ) {
          index.folders.set(`${row.origin}\u0000${row.folder}`, row.name);
        }
      }
    }
    if (Array.isArray(sessions)) index.sessions = sessions as ManifestEntry[];
  } catch {
    // Rebuilt from the manifest by this run.
  }
  return index;
}

/**
 * The index after this run. Folders keep every name ever given, with this
 * run's names on top. Sessions: a complete run (every source, every project,
 * default threshold) lists every session that still exists, so its manifest
 * is the whole list; a narrower run keeps the earlier rows it did not cover
 * (`earlier`: the last manifest's rows first, then the index's).
 */
function nextNameIndex(
  folders: ReadonlyMap<string, string>,
  earlier: readonly ManifestEntry[],
  manifest: readonly ManifestEntry[],
  complete: boolean,
): string {
  const sessions = new Map<string, ManifestEntry>();
  if (!complete) for (const row of earlier) sessions.set(row.source, row);
  for (const row of manifest) sessions.set(row.source, row);
  const projects = [...folders]
    .map(([key, name]) => {
      const [origin, folder] = key.split("\u0000");
      return { origin, folder, name };
    })
    .sort((a, b) => `${a.origin}/${a.folder}`.localeCompare(`${b.origin}/${b.folder}`));
  const rows = [...sessions.values()].sort((a, b) => a.export.localeCompare(b.export));
  return `${JSON.stringify({ version: 1, projects, sessions: rows }, null, 2)}\n`;
}

/**
 * Project names, stable per project folder. The rule, within one backend:
 *   1. A folder keeps the name its earlier exports in the last manifest have
 *      (when its sessions carry several, the one most of them carry, then the
 *      first in sort order). The current manifest always wins.
 *   2. Two folders never share a name: when two folders claim the same earlier
 *      name, the one more earlier exports carry keeps it (then the first by
 *      folder), and the other is treated as new.
 *   3. A folder none of whose sessions the last manifest lists (a returning
 *      folder) gets the name the name index recorded for it
 *      ({@link NAME_INDEX_FILE}), unless a folder above already holds it.
 *   4. A new folder takes the name discovery gives it, unless another folder
 *      already holds that name; then it gets the first free `<name>-N`. A
 *      returning folder whose old name is held now is treated the same way.
 * So no folder has two names and no two folders share one, whatever order
 * discovery sorts folders in from one run to the next.
 */
export function stableProjectNames(
  projects: readonly ProjectInfo[],
  earlierNames: (project: ProjectInfo) => readonly string[],
  keptName: (project: ProjectInfo) => string | undefined = () => undefined,
): Map<ProjectInfo, string> {
  const names = new Map<ProjectInfo, string>();
  const taken = new Set<string>();
  const claims = projects.flatMap((project) => {
    const counts = new Map<string, number>();
    for (const name of earlierNames(project)) counts.set(name, (counts.get(name) ?? 0) + 1);
    const [best] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return best ? [{ project, name: best[0], weight: best[1] }] : [];
  });
  claims.sort((a, b) => b.weight - a.weight || a.project.dirName.localeCompare(b.project.dirName));
  for (const { project, name } of claims) {
    if (taken.has(name)) continue;
    names.set(project, name);
    taken.add(name);
  }
  // 3. A returning folder gets the name the index kept for it, if it is still free.
  for (const project of [...projects].sort((a, b) => a.dirName.localeCompare(b.dirName))) {
    if (names.has(project)) continue;
    const name = keptName(project);
    if (!name || taken.has(name)) continue;
    names.set(project, name);
    taken.add(name);
  }
  for (const project of projects) {
    if (names.has(project)) continue;
    let name = project.shortName;
    if (taken.has(name)) {
      // Discovery's own suffix is dropped first so the result reads `app-3`,
      // never `app-2-2`.
      const base = name.replace(/-\d+$/, "") || name;
      for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    }
    names.set(project, name);
    taken.add(name);
  }
  return names;
}

/**
 * The namer for new export files: {@link exportFileName} with every name in
 * use (from the manifest and the folder) taken. Names already in a manifest
 * never come here.
 */
function exportNamer(used: Set<string>): (project: string, sessionId: string) => string {
  return (project, sessionId) => exportFileName(project, sessionId, used);
}

/**
 * The export command core. Reads the selected agent stores; writes only under
 * `<home>/exports`. Returns stats; individual bad files/lines are tolerated
 * and counted, never thrown. Deterministic and idempotent: same input →
 * byte-identical output.
 */
export function runExport(opts: ExportArgs): ExportStats {
  opts = flowArgs(opts);
  // A wrong threshold is an error before anything is read or locked.
  parseMessageCount("min-messages", opts["min-messages"], 1);
  const out = opts.output ?? process.stdout;
  const { home } = resolvePaths(opts);
  // Export rewrites the files distill reads, so it takes the same writer lock
  // as every other command that changes the data home. While another command
  // holds it, nothing is read or written and the refusal names that command.
  let writer: ReturnType<typeof acquireWriterLock>;
  try {
    writer = acquireWriterLock(home, "export");
  } catch (error) {
    if (!(error instanceof WriterBusyError)) throw error;
    out.write(`${error.message}\n`);
    return { ...emptyStats(path.join(home, "exports")), busy: error.message };
  }
  try {
    return exportLocked(opts, out);
  } finally {
    writer.release();
  }
}

/** The counts of an export that read and wrote nothing. */
function emptyStats(exportsDir: string): ExportStats {
  return {
    exportedSessions: 0,
    totalMessages: 0,
    duplicatesDropped: 0,
    skippedByFilter: 0,
    zeroMessageSessions: 0,
    automationSkipped: 0,
    kirocrewHandedOff: 0,
    sessionsByOrigin: {},
    belowMinMessages: 0,
    readErrors: 0,
    keptAfterReadError: 0,
    badLines: 0,
    shortTurns: 0,
    shortTurnsWithDecision: 0,
    outcomeSessions: 0,
    exportsDir,
    prunedExports: 0,
    files: [],
  };
}

function exportLocked(opts: ExportArgs, out: Writable): ExportStats {
  let progress = startProgress(out, "Discovering session history");
  const reading =
    opts.progress ?? (opts.guided ? startStageProgress(out, "Scanning your history") : undefined);
  let readingActive = false;
  try {
    return exportWithProgress(opts, out, {
      update: (label) => progress.update(label),
      clear: () => progress.clear(),
      startReading(total) {
        if (!reading) return;
        progress.clear();
        readingActive = true;
        reading.start(total, 1);
      },
      readItem(status, line) {
        reading?.item({ status, line });
      },
      finishReading() {
        if (!readingActive) return;
        readingActive = false;
        reading?.end();
        progress = startProgress(out, "Preparing exports");
      },
    });
  } finally {
    if (readingActive) reading?.end();
    progress.clear();
  }
}

interface ExportProgress extends Progress {
  startReading(total: number): void;
  readItem(status: "done" | "skipped" | "failed", line: string): void;
  finishReading(): void;
}

function exportWithProgress(
  opts: ExportArgs,
  out: Writable,
  progress: ExportProgress,
): ExportStats {
  // Every active backend as a SessionSource. Extraction and timeline run through
  // each source, so the seam is uniform; a single-active-source run (the common
  // claude-only machine) is byte-identical to the pre-multi-backend behavior.
  const sources = opts.sources ?? resolveSources(parseSourceMode(opts.source), resolvePaths(opts));
  // Each source is released right after it is read. The finally also covers a
  // discovery that throws before reading starts, so no store handle is left open.
  const released = new Set<SessionSource>();
  const release = (source: SessionSource) => {
    if (released.has(source)) return;
    released.add(source);
    source.dispose?.();
  };
  try {
    return exportSources(opts, out, progress, sources, release);
  } finally {
    for (const source of sources) release(source);
  }
}

function exportSources(
  opts: ExportArgs,
  out: Writable,
  progress: ExportProgress,
  sources: SessionSource[],
  release: (source: SessionSource) => void,
): ExportStats {
  const write = (line = "") => out.write(`${fitLines([line], lineWidth(out)).join("\n")}\n`);
  const paths = resolvePaths(opts);
  const { home } = paths;
  const minMessages = parseMessageCount("min-messages", opts["min-messages"], 1);
  const exportsDir = path.join(home, "exports");
  const sourceMode = parseSourceMode(opts.source);

  // Read every selected session into the corpus input, tolerating read errors.
  // Extraction runs through the OWNING source, and so does the timeline, built
  // at read time so the raw lines can be released before the next session is
  // read (holding every session's lines until rendering kept a whole store in
  // memory). The anaphora/outcome passes below walk that timeline: the
  // SessionSource law (extract and timeline agree) keeps index alignment exact.
  // `origin` is tracked by source path.
  const inputs: DedupeInput[] = [];
  // Terminal labels only; nothing written to a file uses this.
  const dot = ` ${glyph("·", "|")} `;
  const timelineOf = new Map<string, TimelineEvent[]>();
  const originOf = new Map<string, SourceName>();
  const earlierOf = new Map<string, PriorRow>();
  let skippedByFilter = 0;
  let automationSkipped = 0;
  let kirocrewHandedOff = 0;
  let readErrors = 0;
  const readErrorPaths: string[] = [];
  // Earlier exports of sessions that were found but could not be read: kept.
  const keptRows: PriorRow[] = [];
  let sessionsToRead = 0;
  // What earlier exports recorded per source: file, project and session id.
  const nameIndex = readNameIndex(exportsDir);
  const { rows, used } = priorExports(exportsDir, nameIndex);
  const discovered = sources.map((source) => {
    progress.update(`Discovering ${source.name} sessions`);
    return { source, projects: source.discover({ countEntries: false }) };
  });
  // The earlier row of each discovered session: by its source locator, else
  // (a session the backend moved to another file) by its stable id, among rows
  // of the same origin whose locator was not discovered this run. Each earlier
  // row goes to one session at most.
  const locators = new Set(
    discovered.flatMap(({ projects }) =>
      projects.flatMap((p) => p.sessions.map((s) => s.key ?? s.path)),
    ),
  );
  const movedRows = new Map<string, PriorRow>();
  for (const row of rows.values()) {
    const id = `${row.origin}\u0000${row.sessionId}`;
    if (row.sessionId && !locators.has(row.source) && !movedRows.has(id)) movedRows.set(id, row);
  }
  const earlierByKey = new Map<string, PriorRow>();
  for (const { source, projects } of discovered) {
    for (const session of projects.flatMap((p) => p.sessions)) {
      const key = session.key ?? session.path;
      const id = `${source.name}\u0000${session.stableId}`;
      const row = rows.get(key) ?? (session.stableId ? movedRows.get(id) : undefined);
      if (!row) continue;
      if (row.source !== key) movedRows.delete(id);
      earlierByKey.set(key, row);
    }
  }
  const earlierRow = (session: SessionInfo) => earlierByKey.get(session.key ?? session.path);
  const filter = opts.project;
  const folderOf = new Map<ProjectInfo, string>();
  /** Every folder's name this run, where the folder has a history or is exported. */
  const folderNames = new Map(nameIndex.folders);
  /** Folder key of each session read, for the name index. */
  const folderOfSource = new Map<string, string>();
  const inventory = discovered.map(({ source, projects: all }) => {
    // One name per project folder, kept from earlier exports (stableProjectNames).
    const names = stableProjectNames(
      all,
      (project) =>
        // A session discovery could not read has no known folder: it names nothing.
        project.sessions.flatMap((session) =>
          session.unreadable ? [] : (earlierRow(session)?.project ?? []),
        ),
      // The manifest is the last export's own record: where it lists a
      // folder's sessions, their names stand; the index names the rest.
      (project) =>
        project.sessions.some((session) => earlierRow(session)?.listed)
          ? undefined
          : nameIndex.folders.get(folderKey(source.name, project)),
    );
    const projects = all.flatMap((project) => {
      const name = names.get(project) ?? project.shortName;
      const key = folderKey(source.name, project);
      folderOf.set(project, key);
      if (folderNames.has(key) || project.sessions.some((session) => earlierRow(session))) {
        folderNames.set(key, name);
      }
      // After an upgrade a folder keeps its earlier project name, which can
      // differ from the name discovery gives it now. Either selects it.
      if (filter && !projectMatches(project.shortName, filter) && !projectMatches(name, filter)) {
        skippedByFilter += project.sessions.length;
        return [];
      }
      sessionsToRead += project.sessions.length;
      return [{ project, name }];
    });
    return { source, projects };
  });
  progress.startReading(sessionsToRead);
  for (const { source, projects } of inventory) {
    try {
      for (const { project, name } of projects) {
        for (const session of project.sessions) {
          progress.update(`Reading ${source.name} history${dot}${inputs.length + 1} sessions`);
          const label = `${source.name}${dot}${project.shortName}`;
          // Session-level classification (kiro: exclude subagent/automation
          // sessions, and hand Kiro Crew runs to the Crew store, rule K15).
          // Claude classifies per-entry inside extract and has none.
          const verdict = source.classify?.({ ...session, project: project.shortName });
          if (verdict === "automation") {
            automationSkipped++;
            progress.readItem("skipped", `${label}${dot}automated session`);
            continue;
          }
          if (verdict === "kirocrew") {
            kirocrewHandedOff++;
            progress.readItem("skipped", `${label}${dot}read from Kiro Crew`);
            continue;
          }
          const earlier = earlierRow(session);
          let lines: string[];
          try {
            lines = readSession(source, session);
          } catch (error) {
            if (error instanceof SourceReadError) throw error;
            // The session still exists; only this read failed (a permission
            // change, a file too large to read). Its earlier export stays.
            readErrors++;
            readErrorPaths.push(session.path);
            if (earlier) keptRows.push(earlier);
            progress.readItem("failed", `${label}${dot}could not read ${session.file}`);
            continue;
          }
          const key = session.key ?? session.path;
          inputs.push({
            project: name,
            // Digest identity: the id an earlier export recorded is kept.
            sessionId: earlier?.sessionId ?? session.id ?? session.file.replace(/\.jsonl$/, ""),
            sourcePath: key,
            extracted: source.extract(lines),
          });
          timelineOf.set(key, source.timeline(lines));
          folderOfSource.set(key, folderOf.get(project) ?? folderKey(source.name, project));
          if (earlier) earlierOf.set(key, earlier);
          originOf.set(key, source.name);
          progress.readItem("done", label);
        }
      }
    } finally {
      release(source);
    }
  }
  progress.finishReading();

  // ONE shared dedupe pass (rule R8): anaphora/outcome reuse this exact
  // corpus so their record indices align with the rendered export exactly.
  // The pass is a single union over all backends: cross-source (timestamp,text)
  // collisions are exactly the fork-copy semantics dedupe already handles, and
  // in practice never occur across different tools.
  progress.update(`Deduplicating ${inputs.length} sessions`);
  const corpus = buildCorpus(inputs);

  // Partition sessions by the min-messages threshold.
  let zeroMessageSessions = 0;
  let belowMinMessages = 0;
  let badLines = 0;
  const eligible: CorpusSession[] = [];
  for (const session of corpus.sessions) {
    badLines += session.badLines;
    const count = session.messages.length;
    if (count === 0) {
      zeroMessageSessions++;
    } else if (count < minMessages) {
      belowMinMessages++;
    } else {
      eligible.push(session);
    }
  }

  // Allocate filenames, render, and run the anaphora + outcome passes per
  // exported session (deterministic corpus order → stable names).
  const manifest: ManifestEntry[] = [];
  const writes: { file: string; content: string }[] = [];
  const anaphoraByFile: Record<string, AnaphoraRecord[]> = {};
  const outcomesByFile: Record<string, OutcomeEvidence> = {};
  const attached: AttachedSession[] = [];
  const sessionsByOrigin: Partial<Record<SourceName, number>> = {};
  let totalMessages = 0;
  let shortTurns = 0;
  let shortTurnsWithDecision = 0;
  let outcomeSessions = 0;
  const newName = exportNamer(used);
  for (const session of eligible) {
    progress.update(`Rendering ${writes.length + 1}/${eligible.length} sessions`);
    const origin = originOf.get(session.sourcePath) ?? "claude";
    // A session exported before keeps its earlier file name.
    const file =
      earlierOf.get(session.sourcePath)?.export ?? newName(session.project, session.sessionId);
    writes.push({ file, content: renderExport(session) });
    manifest.push({
      export: file,
      source: session.sourcePath,
      origin,
      project: session.project,
      sessionId: session.sessionId,
      messages: session.messages.length,
      first_ts: session.firstTs,
      last_ts: session.lastTs,
    });
    sessionsByOrigin[origin] = (sessionsByOrigin[origin] ?? 0) + 1;
    totalMessages += session.messages.length;

    const timeline = timelineOf.get(session.sourcePath) ?? [];
    const records = buildAnaphora(session, timeline);
    anaphoraByFile[file] = records;
    const outcome = buildOutcome(session, timeline);
    outcomesByFile[file] = outcome;
    if (outcome.final_assistant_tail !== "") outcomeSessions++;
    shortTurns += records.length;
    shortTurnsWithDecision += records.filter((r) => r.decision_kind !== null).length;
    attached.push({ file, project: session.project, sessionId: session.sessionId, records });
  }

  // A session that could not be read keeps its earlier export: file, manifest
  // row, and anaphora and outcome entries, exactly as the earlier run wrote them.
  const written = new Set(writes.map((w) => w.file));
  const kept = keptRows.filter(
    (row) => !written.has(row.export) && fs.existsSync(path.join(exportsDir, row.export)),
  );
  const keptFiles = new Set(kept.map((row) => row.export));
  if (kept.length) {
    const earlierAnaphora = priorIndex(path.join(exportsDir, "anaphora.json"));
    const earlierOutcomes = priorIndex(path.join(exportsDir, "outcomes.json"));
    for (const row of kept) {
      if (row.entry) manifest.push(row.entry);
      const records = earlierAnaphora[row.export];
      if (Array.isArray(records)) anaphoraByFile[row.export] = records as AnaphoraRecord[];
      const outcome = earlierOutcomes[row.export];
      if (outcome !== undefined) outcomesByFile[row.export] = outcome as OutcomeEvidence;
    }
  }

  // Deterministic manifest ordering, rewritten wholesale each run.
  manifest.sort((a, b) => a.export.localeCompare(b.export));

  // Deterministic (sorted-by-export-name) anaphora + outcome objects. outcomes
  // gets a leading `_note` labeling the assistant text as machine-authored.
  const anaphoraOut: Record<string, AnaphoraRecord[]> = {};
  for (const file of Object.keys(anaphoraByFile).sort()) {
    anaphoraOut[file] = anaphoraByFile[file] ?? [];
  }
  const outcomesOut: Record<string, unknown> = { _note: OUTCOME_NOTE };
  for (const file of Object.keys(outcomesByFile).sort()) {
    outcomesOut[file] = outcomesByFile[file];
  }

  // Write to disk, owner-only (exports can contain secrets). The per-session
  // markdown is written plainly: one flush per file made large exports slow,
  // and every file is regenerated from the stores on the next run. The JSON
  // indexes are replaced atomically, manifest last, so the manifest is never
  // newer than the indexes it points into.
  // Only an unfiltered, default-threshold, every-source run covers every session.
  const complete = !opts.project && minMessages === 1 && sourceMode === "auto";
  mkdirPrivate(exportsDir);
  for (const [index, { file, content }] of writes.entries()) {
    progress.update(`Saving ${index + 1}/${writes.length} exports`);
    writeFilePrivate(path.join(exportsDir, file), content);
  }
  atomicWriteFilePrivate(
    path.join(exportsDir, "anaphora.json"),
    `${JSON.stringify(anaphoraOut, null, 2)}\n`,
  );
  atomicWriteFilePrivate(
    path.join(exportsDir, "outcomes.json"),
    `${JSON.stringify(outcomesOut, null, 2)}\n`,
  );
  atomicWriteFilePrivate(
    path.join(exportsDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  // The folders this run exported, under the names they were given.
  for (const row of manifest) {
    const folder = folderOfSource.get(row.source);
    if (folder) folderNames.set(folder, row.project);
  }
  const earlierRows = [...rows.values()].flatMap((row) => (row.entry ? [row.entry] : []));
  atomicWriteFilePrivate(
    path.join(exportsDir, NAME_INDEX_FILE),
    nextNameIndex(folderNames, earlierRows, manifest, complete),
  );

  // Prune stale exports: `.md` files from a previous run whose session no
  // longer exists (deleted/renamed in the store). ONLY on an unfiltered,
  // default-threshold, ALL-SOURCES run; otherwise the current write set is a
  // deliberate subset and the "missing" files are valid entries from other
  // scopes (a different --project, or the OTHER backend under --source claude).
  let prunedExports = 0;
  if (complete) {
    for (const f of fs.readdirSync(exportsDir)) {
      if (f.endsWith(".md") && !written.has(f) && !keptFiles.has(f)) {
        fs.rmSync(path.join(exportsDir, f), { force: true });
        prunedExports++;
      }
    }
  }

  const files = writes.map((w) => w.file).sort();
  const stats: ExportStats = {
    exportedSessions: eligible.length,
    totalMessages,
    duplicatesDropped: corpus.duplicatesDropped,
    skippedByFilter,
    zeroMessageSessions,
    automationSkipped,
    kirocrewHandedOff,
    sessionsByOrigin,
    belowMinMessages,
    readErrors,
    keptAfterReadError: kept.length,
    badLines,
    shortTurns,
    shortTurnsWithDecision,
    outcomeSessions,
    exportsDir,
    prunedExports,
    files,
  };
  // The summary counts, saved for `status` so it never has to re-classify the
  // kiro store to report the K15 hand-off (core/export-stats.ts).
  writeExportStats(exportsDir, { source: sourceMode, project: opts.project }, stats);

  progress.clear();
  if (opts.guided && !opts.verbose) {
    for (const line of exportClosingLines(stats, { minMessages, project: opts.project }))
      write(line);
    write(`Saved in ${stats.exportsDir}`);
    if (stats.kirocrewHandedOff) write(dim(kirocrewHandedOffLine(stats.kirocrewHandedOff)));
    if (stats.badLines) write(dim(`Skipped ${counted(stats.badLines, "damaged line")}.`));
    if (stats.keptAfterReadError) write(dim(keptAfterReadErrorLine(stats.keptAfterReadError)));
  } else {
    reportExport(write, opts, corpus, eligible, stats, minMessages, readErrorPaths, attached);
  }
  return stats;
}

/** Per-exported-session anaphora attachment info, for the summary + --verbose. */
interface AttachedSession {
  file: string;
  project: string;
  sessionId: string;
  records: AnaphoraRecord[];
}

/** Print the summary, the skip/error accounting, and (opt-in) verbose detail. */
function reportExport(
  write: (line?: string) => void,
  opts: ExportArgs,
  corpus: Corpus,
  eligible: CorpusSession[],
  stats: ExportStats,
  minMessages: number,
  readErrorPaths: string[],
  attached: AttachedSession[],
): void {
  for (const line of exportClosingLines(stats, { minMessages, project: opts.project })) write(line);
  write(`Saved in ${stats.exportsDir}`);
  const origins = (Object.keys(stats.sessionsByOrigin) as SourceName[]).sort();

  // Merged-corpus notice (§ accepted-risk register): `--source auto` silently
  // widens a dual-tool user's default corpus. Say so once, with the escape.
  if (origins.length > 1) {
    const others = origins
      .filter((origin) => origin !== origins[0])
      .map((origin) =>
        counted(stats.sessionsByOrigin[origin] ?? 0, `${SOURCE_PRODUCT_NAMES[origin]} session`),
      )
      .join(" and ");
    write(dim(`  Including ${others}; use --source ${origins[0]} to read one tool at a time.`));
  }

  // The rest of what did not get exported (the sessions left out are counted
  // above), zero counts left out.
  const skipped = (line: string) => write(dim(`  ${line}`));
  if (stats.kirocrewHandedOff > 0) skipped(kirocrewHandedOffLine(stats.kirocrewHandedOff));
  if (stats.keptAfterReadError > 0) skipped(keptAfterReadErrorLine(stats.keptAfterReadError));
  if (stats.badLines > 0) skipped(`${counted(stats.badLines, "damaged line")} skipped`);
  if (stats.prunedExports > 0) {
    skipped(
      `${counted(stats.prunedExports, "earlier export")} removed because ${stats.prunedExports === 1 ? "its session no longer exists" : "their sessions no longer exist"}`,
    );
  }

  if (opts.verbose) {
    write();
    // How the evidence beside each export was gathered; internal, so --verbose only.
    if (origins.length > 1) {
      write(
        dim(`by origin: ${origins.map((o) => `${stats.sessionsByOrigin[o]} ${o}`).join(" + ")}`),
      );
    }
    write(
      dim(
        `${counted(stats.duplicatesDropped, "duplicate message")} dropped (copies in forked sessions)`,
      ),
    );
    write(
      dim(
        `${stats.shortTurns} short turns attached ` +
          `(${stats.shortTurnsWithDecision} had a pending plan/question); ` +
          `outcome evidence captured for ${stats.outcomeSessions} sessions`,
      ),
    );
    write(
      dim(
        `bounded evidence: short turns ${glyph("≤", "<=")} ${SHORT_TURN_MAX_WORDS} words get context; ` +
          `antecedent/assistant tails ${glyph("≤", "<=")} ${TAIL_CHARS} chars; last ${FINAL_TURNS} human turns captured per session.`,
      ),
    );
    // Every session the corpus saw, with its extractor drops and dedupe count.
    const exportedIds = new Set(eligible.map((s) => s.sessionId));
    for (const session of corpus.sessions) {
      const status = exportedIds.has(session.sessionId)
        ? "exported"
        : session.messages.length === 0
          ? "skipped (no messages)"
          : `skipped (< ${minMessages} messages)`;
      write(
        dim(
          `${session.project}/${session.sessionId}: ${session.messages.length} msg, ` +
            `${session.dedupeDropped} fork-copy dropped, ${counted(session.drops.length, "piece")} dropped ` +
            `[${status}]`,
        ),
      );
      for (const drop of session.drops) {
        write(dim(`    drop ${drop.reason}: ${drop.snippet}`));
      }
    }
    for (const p of readErrorPaths) {
      write(dim(`read error: ${p}`));
    }

    // Attached short turns per exported session (index, text, plan/question).
    for (const session of attached) {
      if (session.records.length === 0) continue;
      write(
        dim(
          `${session.project}/${session.sessionId}: ${counted(session.records.length, "short turn")} attached`,
        ),
      );
      for (const record of session.records) {
        const decision = record.decision_kind ? ` +${record.decision_kind}` : "";
        const antecedent = record.antecedent ? " +antecedent" : "";
        write(
          dim(
            `    #${record.index} "${snippetOneLine(record.human_text)}"${antecedent}${decision}`,
          ),
        );
      }
    }
  }

  write(hint(nextCommandText("distill", opts), lineWidth(opts.output ?? process.stdout)));
}

/**
 * The closing lines of an export: what was exported, the count per tool on a
 * line of its own when there are several, and one line for the sessions left
 * out and why, in plain words. Zero counts are left out.
 */
export function exportClosingLines(
  stats: ExportStats,
  o: { minMessages: number; project?: string },
): string[] {
  const lines = [
    `Exported ${counted(stats.exportedSessions, "session")} with ${stats.totalMessages.toLocaleString("en-US")} of your messages.`,
  ];
  const origins = (Object.keys(stats.sessionsByOrigin) as SourceName[]).sort();
  if (origins.length > 1)
    lines.push(
      `By tool: ${origins.map((origin) => `${(stats.sessionsByOrigin[origin] ?? 0).toLocaleString("en-US")} ${SOURCE_PRODUCT_NAMES[origin]}`).join(", ")}.`,
    );
  // Each reason: the clause alone when it is the only one, and after its count otherwise.
  const reasons: [number, string, string][] = [
    [
      stats.automationSkipped,
      "runs started by a tool, not typed by you",
      "started by a tool, not typed by you",
    ],
    [
      stats.zeroMessageSessions,
      stats.zeroMessageSessions === 1
        ? "none of its messages were yours"
        : "none of their messages were yours",
      "with none of your messages",
    ],
    [
      stats.belowMinMessages,
      `fewer than ${o.minMessages} of your messages`,
      `with fewer than ${o.minMessages} of your messages`,
    ],
    [
      stats.skippedByFilter,
      `outside --project ${o.project ?? ""}`,
      `outside --project ${o.project ?? ""}`,
    ],
    [
      stats.readErrors,
      stats.readErrors === 1 ? "its file could not be read" : "their files could not be read",
      "that could not be read",
    ],
  ];
  const present = reasons.filter(([n]) => n > 0);
  const total = present.reduce((sum, [n]) => sum + n, 0);
  if (total) {
    const why =
      present.length === 1
        ? (present[0] as [number, string, string])[1]
        : present.map(([n, , after]) => `${n.toLocaleString("en-US")} ${after}`).join("; ");
    lines.push(`${counted(total, "session was", "sessions were")} left out: ${why}.`);
  }
  return lines;
}

export default defineCommand({
  meta: {
    name: "export",
    description: "Export human-only session markdown + manifest",
  },
  args: {
    ...sharedArgs,
    project: { type: "string", description: "Only export sessions from this project" },
    "min-messages": {
      type: "string",
      default: "1",
      description: "Minimum human messages for a session to be exported",
    },
    verbose: {
      type: "boolean",
      description: "Also show what was left out of each session and how its evidence was gathered",
    },
  },
  async run({ args }) {
    console.log(`${dim(terminalPrivacyReminder(process.stdout))}\n`);
    const result = runExport(args as unknown as ExportArgs);
    if (result.busy) process.exitCode = 1;
    else if (result.exportedSessions > 0) await offerNext("distill", args, { hintPrinted: true });
  },
});
