import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { StageLineage } from "../core/fingerprint.js";
import { atomicWriteFilePrivate, mkdirPrivate } from "../core/fsutil.js";
import type { ResolvedCall, RunnerName } from "../runners/types.js";
import type { SourceName } from "../sources/types.js";
import { DIGEST_PROMPT_VERSION } from "./prompts/digest.js";
import { ClusterSchema, type ClusterTask, type Digest, DigestSchema } from "./schemas.js";

/** The `distill/digests.json` checkpoint. */
export interface DigestsCheckpoint {
  generation: string;
  prompt_version: number;
  digests: Record<string, Digest>;
  /** Missing on legacy checkpoints, whose freshness cannot be established. */
  lineage?: Record<string, DigestLineage>;
  /** Failed/interrupted refreshes must not resurrect old library preferences. */
  invalidated?: string[];
}

/** The source identity accompanies the digest even when no prompt is authored. */
export interface DigestLineage extends StageLineage {
  project: string;
  session_id: string;
  origin: SourceName;
  observed_at: string;
  content_hash: string;
  source_hash: string;
}

/** Mint a new generation id: compact UTC stamp + short random suffix. */
export function newGeneration(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${crypto.randomBytes(2).toString("hex")}`;
}

function digestsPath(home: string): string {
  return path.join(home, "distill", "digests.json");
}

/** Load the digests checkpoint; absent or unreadable → null (never throws). */
export function loadDigests(home: string): DigestsCheckpoint | null {
  try {
    const raw = fs.readFileSync(digestsPath(home), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.generation !== "string") return null;
    // Validate each digest independently and keep the valid ones: a single
    // corrupt entry must not discard the whole (paid) checkpoint. A dropped
    // key simply gets re-digested on the next run.
    const invalidated = Array.isArray(obj.invalidated)
      ? obj.invalidated.filter((value): value is string => typeof value === "string")
      : [];
    const digests: Record<string, Digest> = {};
    if (obj.digests && typeof obj.digests === "object") {
      for (const [key, value] of Object.entries(obj.digests as Record<string, unknown>)) {
        if (invalidated.includes(key)) continue;
        const d = DigestSchema.safeParse(value);
        if (d.success) digests[key] = d.data;
      }
    }
    const prompt_version =
      typeof obj.prompt_version === "number" ? obj.prompt_version : DIGEST_PROMPT_VERSION;
    const lineage: Record<string, DigestLineage> = {};
    if (obj.lineage && typeof obj.lineage === "object") {
      for (const [key, value] of Object.entries(obj.lineage)) {
        if (
          key in digests &&
          value !== null &&
          typeof value === "object" &&
          (value as Partial<DigestLineage>).version === 1 &&
          typeof (value as Partial<DigestLineage>).fingerprint === "string"
        ) {
          lineage[key] = value as DigestLineage;
        }
      }
    }
    return {
      generation: obj.generation,
      prompt_version,
      digests,
      ...(Object.keys(lineage).length ? { lineage } : {}),
      ...(invalidated.length ? { invalidated } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Persist the digests checkpoint atomically (tmp file + rename) so a Ctrl-C
 * mid-write can never corrupt previously saved progress.
 */
export function saveDigests(home: string, checkpoint: DigestsCheckpoint): void {
  const target = digestsPath(home);
  mkdirPrivate(path.dirname(target));
  atomicWriteFilePrivate(target, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

/** Delete distill checkpoints (used by `distill --fresh`). */
export function clearCheckpoints(home: string): void {
  for (const file of ["digests.json", "tasks.json"]) {
    fs.rmSync(path.join(home, "distill", file), { force: true });
  }
}

/** The `distill/tasks.json` checkpoint. */
export interface TasksCheckpoint {
  generation: string;
  prompt_version: number;
  tasks: ClusterTask[];
  misc: string[];
  lineage?: StageLineage;
  ledger_runner?: RunnerName;
  resolved?: ResolvedCall[];
  operation_ids?: string[];
  fallback_merge_id?: string;
  grouping_hash?: string;
}

function tasksPath(home: string): string {
  return path.join(home, "distill", "tasks.json");
}

/** Zod shape for the tasks checkpoint; task shape reused from ClusterSchema. */
const TasksCheckpointSchema = z.looseObject({
  generation: z.string(),
  prompt_version: z.number().catch(0),
  tasks: ClusterSchema.shape.tasks,
  misc: z.array(z.string()).catch([]),
});

/** Load the tasks checkpoint; absent, unreadable, or malformed → null (never throws). */
export function loadTasks(home: string): TasksCheckpoint | null {
  try {
    const raw = fs.readFileSync(tasksPath(home), "utf8");
    const parsed = TasksCheckpointSchema.safeParse(JSON.parse(raw));
    // A malformed grouping must not corrupt coverage math, reject wholesale so
    // the cluster stage re-runs (one call) rather than trusting bad tasks.
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Persist the tasks checkpoint atomically (tmp + rename). */
export function saveTasks(home: string, checkpoint: TasksCheckpoint): void {
  const target = tasksPath(home);
  mkdirPrivate(path.dirname(target));
  atomicWriteFilePrivate(target, `${JSON.stringify(checkpoint, null, 2)}\n`);
}
