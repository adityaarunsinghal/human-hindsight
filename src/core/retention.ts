import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml, stringify as stringifyToml, type TomlTable } from "smol-toml";
import type { ResolvedPaths } from "../commands/_shared.js";
import type { SourceMode } from "../sources/registry.js";
import type { SourceName } from "../sources/types.js";
import { DIR_MODE, FILE_MODE } from "./fsutil.js";

/** Claude has no supported "forever" value; 1,000 years avoids date overflow. */
export const LONG_RETENTION_DAYS = 365_000;

export interface RetentionPlan {
  tool: SourceName;
  file?: string;
  /** Resolve existing symlinks so dotfile-manager links survive atomic writes. */
  target?: string;
  before?: string | null;
  after?: string;
  changes: string[];
  notes: string[];
  error?: string;
}

function isTable(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

function readConfig(file: string): { target: string; before: string | null } {
  try {
    const target = fs.realpathSync(file);
    return { target, before: fs.readFileSync(target, "utf8") };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // A dangling symlink is not an absent config we may replace.
      if (fs.existsSync(path.dirname(file))) {
        try {
          if (fs.lstatSync(file).isSymbolicLink())
            throw new Error(`Dangling config symlink: ${file}`);
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
        }
      }
      return { target: path.resolve(file), before: null };
    }
    throw new Error(`Cannot read ${file} (${(err as NodeJS.ErrnoException).code ?? "I/O error"}).`);
  }
}

function claudePlan(file: string): RetentionPlan {
  const { target, before } = readConfig(file);
  let config: unknown;
  try {
    config = before === null ? {} : JSON.parse(before);
  } catch {
    throw new Error(`Invalid JSON in ${file}; repair it before applying retention settings.`);
  }
  if (!isTable(config)) throw new Error(`Expected a JSON object in ${file}.`);
  const days =
    typeof config.cleanupPeriodDays === "number" &&
    Number.isSafeInteger(config.cleanupPeriodDays) &&
    config.cleanupPeriodDays > LONG_RETENTION_DAYS
      ? config.cleanupPeriodDays
      : LONG_RETENTION_DAYS;
  const changes: string[] = [];
  if (config.cleanupPeriodDays !== days) {
    changes.push(`cleanupPeriodDays → ${days} days (about 1,000 years)`);
  }
  // Current Claude keeps Desktop/Cowork sessions indefinitely at 0. Don't add
  // the newer key unnecessarily on older installations where it's absent.
  if (
    config.desktopSessionCleanupPeriodDays !== undefined &&
    config.desktopSessionCleanupPeriodDays !== 0
  ) {
    changes.push("desktopSessionCleanupPeriodDays → 0 (no age limit)");
    config.desktopSessionCleanupPeriodDays = 0;
  }
  config.cleanupPeriodDays = days;
  return {
    tool: "claude",
    file,
    target,
    before,
    after: changes.length ? `${JSON.stringify(config, null, 2)}\n` : (before ?? ""),
    changes,
    notes: ["Claude requires cleanupPeriodDays ≥ 1; zero is not a keep-forever value."],
  };
}

/**
 * Preserve comments and layout for ordinary [history] tables/dotted keys.
 * Validate the edit against the parsed desired config; unusual TOML (inline
 * tables, quoted keys, multiline values) falls back to the TOML serializer.
 * This check prevents a table-looking line inside a string changing user data.
 */
export function maximizeCodexHistory(before: string): {
  after: string;
  changes: string[];
  reformatted: boolean;
} {
  const parsed = parseToml(before, { integersAsBigInt: "asNeeded" });
  const existing = parsed.history;
  if (existing !== undefined && !isTable(existing)) throw new Error("history must be a TOML table");
  // Keep the parser's null-prototype tables so semantic comparison doesn't
  // mistake a prototype difference for a changed configuration value.
  const history = (existing ?? Object.create(null)) as TomlTable;
  const changes: string[] = [];
  if (history.persistence !== "save-all") changes.push('history.persistence → "save-all"');
  if (history.max_bytes !== undefined) changes.push("history.max_bytes → unset (no size cap)");
  if (changes.length === 0) return { after: before, changes, reformatted: false };
  history.persistence = "save-all";
  delete history.max_bytes;
  const desired = parsed;
  desired.history = history;
  const newline = before.includes("\r\n") ? "\r\n" : "\n";
  const lines = before.split(/\r?\n/);
  let inHistory = false;
  let foundTable = false;
  const updated: string[] = [];
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      inHistory = /^\s*\[history\]\s*(?:#.*)?$/.test(line);
      if (inHistory) {
        foundTable = true;
        updated.push(line, 'persistence = "save-all"');
        continue;
      }
    }
    if (inHistory && /^\s*(persistence|max_bytes)\s*=/.test(line)) continue;
    if (/^\s*history\.(persistence|max_bytes)\s*=/.test(line)) continue;
    updated.push(line);
  }
  if (!foundTable) updated.push("", "[history]", 'persistence = "save-all"');
  const candidate = `${updated.join(newline).trimEnd()}${newline}`;
  try {
    if (isDeepStrictEqual(parseToml(candidate, { integersAsBigInt: "asNeeded" }), desired)) {
      return { after: candidate, changes, reformatted: false };
    }
  } catch {
    // A valid but less common TOML spelling needs structural serialization.
  }
  return { after: stringifyToml(desired), changes, reformatted: true };
}

function codexPlan(file: string): RetentionPlan {
  const { target, before } = readConfig(file);
  let edit: ReturnType<typeof maximizeCodexHistory>;
  try {
    edit = maximizeCodexHistory(before ?? "");
  } catch {
    // Parser errors can include source lines containing secrets; don't print them.
    throw new Error(
      `Invalid TOML/history settings in ${file}; repair them before applying retention settings.`,
    );
  }
  return {
    tool: "codex",
    file,
    target,
    before,
    after: edit.after,
    changes: edit.changes,
    notes: [
      "This uncaps history.jsonl. Full rollouts live separately in sessions/ and archived_sessions/.",
      "Sessions started with --ephemeral cannot be retained retroactively.",
      ...(edit.reformatted
        ? ["TOML formatting will be normalized; the original file will be backed up."]
        : []),
    ],
  };
}

/** Read-only preview. Auto selects existing tool directories, including fresh installs. */
export function planRetention(mode: SourceMode, dirs: ResolvedPaths): RetentionPlan[] {
  const tools: { name: SourceName; dir: string }[] = [
    { name: "claude", dir: dirs.claudeDir },
    { name: "codex", dir: dirs.codexDir },
    { name: "kiro", dir: dirs.kiroDir },
  ];
  return tools
    .filter((tool) => (mode === "auto" ? fs.existsSync(tool.dir) : mode === tool.name))
    .map(({ name, dir }) => {
      try {
        if (name === "claude") return claudePlan(path.join(dir, "settings.json"));
        if (name === "codex") return codexPlan(path.join(dir, "config.toml"));
        return {
          tool: name,
          changes: [],
          notes: [
            "Kiro saves sessions automatically; no documented retention-limit setting is available.",
            "Use /chat save <path> inside Kiro for an additional conversation copy.",
          ],
        };
      } catch (err) {
        return {
          tool: name,
          changes: [],
          notes: [],
          error: err instanceof Error ? err.message : "Could not read retention settings.",
        };
      }
    });
}

/** Check again at the point of use, so a preview cannot overwrite a newer edit. */
export function checkRetentionPlan(plan: RetentionPlan): void {
  if (!plan.file || !plan.target || plan.after === undefined) return;
  const current = readConfig(plan.file);
  if (current.target !== plan.target || current.before !== plan.before) {
    throw new Error(`${plan.file} changed since the preview; run retention again.`);
  }
}

/** Apply one reviewed change, with a unique owner-only backup and atomic replacement. */
export function applyRetentionPlan(plan: RetentionPlan): string | undefined {
  if (!plan.target || plan.after === undefined || plan.changes.length === 0) return;
  checkRetentionPlan(plan);
  fs.mkdirSync(path.dirname(plan.target), { recursive: true, mode: DIR_MODE });
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const backup = plan.before === null ? undefined : `${plan.target}.cc-hindsight-${stamp}.bak`;
  if (backup) fs.writeFileSync(backup, plan.before ?? "", { flag: "wx", mode: FILE_MODE });
  const temp = `${plan.target}.cc-hindsight-${stamp}.tmp`;
  try {
    fs.writeFileSync(temp, plan.after, { flag: "wx", mode: FILE_MODE });
    fs.renameSync(temp, plan.target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return backup;
}
