import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SourceName } from "../sources/types.js";
import { atomicWriteFilePrivate } from "./fsutil.js";

/**
 * core/export-stats.ts: the summary counts of the last export, saved next to
 * `manifest.json` as `exports/export-stats.json`.
 *
 * Why it exists: `status` reports how many kiro sessions rule K15 handed to the
 * Kiro Crew store. Counting that live means classifying every kiro session,
 * which reads every file under `~/.kiro/sessions` (1.3 GB on the machine this
 * was built on) on every `status` call. Export already computed the count, so
 * it saves it here and `status` reads it back. An export from before this file
 * existed simply has none, and `status` then prints nothing for K15.
 *
 * `manifest.json` stays a plain array, unchanged, because readers in distill,
 * preferences and the GUI parse it as one.
 *
 * The file holds counts only (no session text, no paths), carries a schema
 * version, and is written atomically. It holds no timestamp, so re-running
 * export on unchanged input stays byte-identical. `export` is the only writer
 * of `exports/`; nothing else rewrites the directory.
 */

export const EXPORT_STATS_FILE = "export-stats.json";
export const EXPORT_STATS_VERSION = 1;

const SOURCE_NAMES = ["claude", "codex", "kiro", "kirocrew", "opencode"] as const;
const count = z.number().int().nonnegative();

export const SavedExportStatsSchema = z.object({
  version: z.literal(EXPORT_STATS_VERSION),
  /** The `--source` the export ran with (`auto` or one backend). */
  source: z.enum([...SOURCE_NAMES, "auto"]),
  /** The `--project` filter, or null for an unfiltered run. */
  project: z.string().nullable(),
  exported_sessions: count,
  sessions_by_origin: z.partialRecord(z.enum(SOURCE_NAMES), count),
  /** Sessions a source's classifier excluded as automation. */
  automation_skipped: count,
  /** kiro sessions excluded as Kiro Crew runs (rule K15). */
  kirocrew_handed_off: count,
});

export type SavedExportStats = z.infer<typeof SavedExportStatsSchema>;

/**
 * The counts export hands to {@link writeExportStats}: the session-level
 * accounting `status` reports. Per-message counts stay in the export summary.
 */
export interface ExportStatsCounts {
  exportedSessions: number;
  sessionsByOrigin: Partial<Record<SourceName, number>>;
  automationSkipped: number;
  kirocrewHandedOff: number;
}

/** Atomically write `<exportsDir>/export-stats.json` (owner-only). */
export function writeExportStats(
  exportsDir: string,
  run: { source: SavedExportStats["source"]; project?: string },
  stats: ExportStatsCounts,
): void {
  // Sorted origin keys so the bytes do not depend on discovery order.
  const byOrigin: Partial<Record<SourceName, number>> = {};
  for (const origin of (Object.keys(stats.sessionsByOrigin) as SourceName[]).sort()) {
    byOrigin[origin] = stats.sessionsByOrigin[origin];
  }
  const saved: SavedExportStats = {
    version: EXPORT_STATS_VERSION,
    source: run.source,
    project: run.project ?? null,
    exported_sessions: stats.exportedSessions,
    sessions_by_origin: byOrigin,
    automation_skipped: stats.automationSkipped,
    kirocrew_handed_off: stats.kirocrewHandedOff,
  };
  atomicWriteFilePrivate(
    path.join(exportsDir, EXPORT_STATS_FILE),
    `${JSON.stringify(saved, null, 2)}\n`,
  );
}

/**
 * Read `<home>/exports/export-stats.json`. Missing, unreadable, corrupt or
 * from an unknown schema version all yield null: the caller then reports
 * nothing rather than guessing or rescanning the stores.
 */
export function readExportStats(home: string): SavedExportStats | null {
  try {
    const raw = fs.readFileSync(path.join(home, "exports", EXPORT_STATS_FILE), "utf8");
    const parsed = SavedExportStatsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
