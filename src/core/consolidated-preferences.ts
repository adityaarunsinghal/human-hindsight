import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { type Consolidated, ConsolidateSchema } from "../claude/schemas.js";
import { FILE_MODE, mkdirPrivate } from "./fsutil.js";
import type { AggregatedPreference, PreferencesTarget } from "./preferences.js";

export const CONSOLIDATED_PREFERENCES_FILE = "preferences.consolidated.json";

const SavedPreferencesSchema = z.object({
  version: z.literal(1),
  generated_at: z.iso.datetime(),
  source_hash: z.string().regex(/^[a-f0-9]{64}$/),
  source_preferences: z.array(z.object({ text: z.string(), count: z.number() })),
  task_count: z.number().int().nonnegative(),
  target: z.enum(["claude", "kiro", "agents"]),
  preferences: ConsolidateSchema.shape.preferences,
  markdown: z.string(),
});
export type SavedPreferences = z.infer<typeof SavedPreferencesSchema>;

/** Fingerprint exactly the preference text and frequencies sent to the model. */
export function preferencesFingerprint(prefs: { text: string; count: number }[]): string {
  const inputs = prefs
    .map(({ text, count }) => ({ text, count }))
    .sort((a, b) => a.text.localeCompare(b.text) || a.count - b.count);
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
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
  },
): string {
  const dir = path.join(home, "library");
  mkdirPrivate(dir);
  const file = path.join(dir, CONSOLIDATED_PREFERENCES_FILE);
  const temp = `${file}.${randomUUID()}.tmp`;
  const artifact: SavedPreferences = {
    version: 1,
    generated_at: opts.now.toISOString(),
    source_hash: preferencesFingerprint(opts.source),
    source_preferences: opts.source.map(({ text, count }) => ({ text, count })),
    task_count: opts.taskCount,
    target: opts.target,
    preferences: opts.consolidated.preferences,
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
