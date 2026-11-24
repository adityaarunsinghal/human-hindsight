import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicWriteFilePrivate } from "../core/fsutil.js";
import { GeneralizedCallSchema } from "../core/generalized.js";
import { SUBAGENTS_DIR } from "../core/subagents.js";
import { GeneralizeSchema } from "./prompts/generalize.js";

export const GENERALIZE_CHECKPOINT_FILE = "generalize.checkpoint.json";
export const GENERALIZE_CHECKPOINT_VERSION = 1;
const entrySchema = z.object({
  window: z.number().int().positive(),
  inputs: z.number().int().positive(),
  saved_at: z.iso.datetime(),
  result: GeneralizeSchema,
  resolved: GeneralizedCallSchema.optional(),
});
type Entry = z.infer<typeof entrySchema>;

function checkpointPath(home: string): string {
  return path.join(home, "library", SUBAGENTS_DIR, GENERALIZE_CHECKPOINT_FILE);
}

/** A bad window is discarded independently of other completed calls. */
export function readGeneralizeCheckpoints(home: string): Record<string, Entry> {
  try {
    const raw = JSON.parse(fs.readFileSync(checkpointPath(home), "utf8"));
    if (raw?.version !== GENERALIZE_CHECKPOINT_VERSION || !raw.windows) return {};
    const entries: Record<string, Entry> = {};
    for (const [key, value] of Object.entries(raw.windows)) {
      const parsed = entrySchema.safeParse(value);
      if (/^[a-f0-9]{64}$/.test(key) && parsed.success) entries[key] = parsed.data;
    }
    return entries;
  } catch {
    return {};
  }
}

function writeCheckpoints(home: string, windows: Record<string, Entry>): void {
  const contents = { version: GENERALIZE_CHECKPOINT_VERSION, windows };
  atomicWriteFilePrivate(checkpointPath(home), `${JSON.stringify(contents, null, 2)}\n`);
}

/** Synchronous read/modify/replace while the command holds the data-home writer lock. */
export function saveGeneralizeCheckpoint(home: string, key: string, entry: Entry): void {
  writeCheckpoints(home, { ...readGeneralizeCheckpoints(home), [key]: entry });
}

/** Remove only windows promoted to the complete artifact, leaving other partial runs resumable. */
export function clearGeneralizeCheckpoints(home: string, keys?: readonly string[]): void {
  try {
    if (keys) {
      const windows = readGeneralizeCheckpoints(home);
      if (!keys.some((key) => Object.hasOwn(windows, key))) return;
      for (const key of keys) delete windows[key];
      if (Object.keys(windows).length) {
        writeCheckpoints(home, windows);
        return;
      }
    }
    fs.rmSync(checkpointPath(home), { force: true });
    // The folder is shared with saved subagents. When the checkpoint was the
    // only thing in it, it goes too, so a library with no subagents has no
    // empty `subagents` folder. A folder that holds anything else stays.
    fs.rmdirSync(path.dirname(checkpointPath(home)));
  } catch {
    // A matching leftover checkpoint still has to pass the current checks.
  }
}
