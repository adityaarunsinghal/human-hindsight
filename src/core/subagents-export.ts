import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIR_MODE, FILE_MODE, generatedFileMode, mkdirPrivate } from "./fsutil.js";

/**
 * core/subagents-export.ts: write a rendered subagent tree to a directory.
 *
 * `suggest-subagents --export <dir>` is the one command that writes the
 * rendered tree to disk, and it writes only under the directory the person
 * named. Existing files are kept unless `force` is set, so a person's edits to
 * an earlier export are not lost by a re-run. Files are owner-only like the
 * rest of human-hindsight's output; `create-bots.sh` is owner-executable.
 *
 * The directory itself may be a symlink (the person chose it). Inside it, no
 * write may land outside the resolved directory: a symlinked subdirectory or a
 * symlinked file that points elsewhere is refused with an error, never
 * followed.
 *
 * Exporting straight into a harness's own config directory would make the
 * files live immediately, so {@link harnessRootWarning} names that case for the
 * caller to print. It is a warning, not a refusal: the person may mean it.
 */

/** Harness config roots, relative to the user's home directory. */
export const HARNESS_ROOTS: readonly string[] = [".claude", ".codex", ".kiro", ".kiro/crew"];

function within(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** The history folders a person can point the tool at, by flag. */
export interface HarnessDirs {
  claude?: string;
  codex?: string;
  kiro?: string;
  kirocrew?: string;
}

/**
 * Where each harness's folder can be configured, in the order `resolvePaths`
 * reads it: the flag, the private name carried between commands, the coding
 * tool's own variable. The default under the home folder comes last.
 */
const HARNESS_SOURCES: readonly {
  dir: keyof HarnessDirs;
  env: readonly string[];
  fallback: string;
}[] = [
  { dir: "claude", env: ["HUMAN_HINDSIGHT_CLAUDE_DIR", "CLAUDE_CONFIG_DIR"], fallback: ".claude" },
  { dir: "codex", env: ["HUMAN_HINDSIGHT_CODEX_DIR", "CODEX_HOME"], fallback: ".codex" },
  { dir: "kiro", env: ["HUMAN_HINDSIGHT_KIRO_DIR", "KIRO_CONFIG_DIR"], fallback: ".kiro" },
  { dir: "kirocrew", env: ["HUMAN_HINDSIGHT_KIROCREW_DIR"], fallback: ".kiro/crew" },
];

/**
 * The harness roots for `home`: every place in each harness's resolution
 * order that is set, plus its default. A warning covers each of them, because
 * a folder the tool reads history from may be the one the harness reads its
 * configuration from, and the default stays live for a shell without the
 * variable.
 */
function harnessRoots(home: string, env: NodeJS.ProcessEnv, dirs: HarnessDirs): string[] {
  const roots: string[] = [];
  for (const source of HARNESS_SOURCES) {
    for (const value of [dirs[source.dir], ...source.env.map((key) => env[key])]) {
      if (value) roots.push(path.resolve(value));
    }
    roots.push(path.resolve(home, source.fallback));
  }
  return roots;
}

/**
 * A warning when `dir` is a harness config root or inside one, else null.
 * The most specific root wins, so `~/.kiro/crew/x` names `~/.kiro/crew`.
 */
export function harnessRootWarning(
  dir: string,
  home: string = os.homedir(),
  opts: { env?: NodeJS.ProcessEnv; dirs?: HarnessDirs } = {},
): string | null {
  const target = path.resolve(dir);
  const hit = harnessRoots(home, opts.env ?? process.env, opts.dirs ?? {})
    .filter((root) => within(target, root))
    .sort((a, b) => b.length - a.length)[0];
  if (!hit) return null;
  return `${target} is inside ${hit}, a directory a coding agent reads its configuration from. Files written there may take effect immediately. Export to a separate folder and copy the files you want, unless that is what you intend.`;
}

function checkRelative(file: string): void {
  if (
    !file ||
    path.isAbsolute(file) ||
    file.includes("\\") ||
    file.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Refusing to write a path outside the export folder: ${JSON.stringify(file)}`);
  }
}

/** Create each missing parent under `root` and refuse any that resolves outside it. */
function ensureParents(root: string, file: string): string {
  let current = root;
  for (const part of file.split("/").slice(0, -1)) {
    current = path.join(current, part);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!stat) mkdirPrivate(current);
    else if (stat.isSymbolicLink()) {
      if (!within(fs.realpathSync(current), root)) {
        throw new Error(`Refusing to follow ${current}: it links outside the export folder.`);
      }
    } else if (!stat.isDirectory()) {
      throw new Error(`Cannot export into ${current}: it exists and is not a directory.`);
    }
  }
  const parent = fs.realpathSync(current);
  if (!within(parent, root)) {
    throw new Error(`Refusing to write under ${current}: it resolves outside the export folder.`);
  }
  return parent;
}

/**
 * Replace one file through a same-directory temporary and a rename, so a
 * reader never sees a half-written file. No disk flush: the tree is rendered
 * again from the saved suggestion whenever it is needed.
 */
function replaceFile(target: string, data: string): void {
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, data, { mode: FILE_MODE, flag: "wx" });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * Write `files` (relative path to content) under `dir`. Returns the relative
 * paths written and the ones skipped because they already existed (without
 * `force`), both in sorted order.
 */
export function writeSubagentTree(
  dir: string,
  files: ReadonlyMap<string, string>,
  opts: { force: boolean },
): { written: string[]; skipped: string[] } {
  const names = [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) checkRelative(name);
  // A folder the person already has keeps its permissions (it may be a shared
  // project folder); a missing one is created owner-only.
  fs.mkdirSync(path.resolve(dir), { recursive: true, mode: DIR_MODE });
  const root = fs.realpathSync(path.resolve(dir));
  const written: string[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    const parent = ensureParents(root, name);
    const target = path.join(parent, path.basename(name));
    let existing: fs.Stats | undefined;
    try {
      existing = fs.lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing?.isSymbolicLink()) {
      throw new Error(`Refusing to replace ${target}: it is a symbolic link.`);
    }
    if (existing && !existing.isFile()) {
      throw new Error(`Cannot write ${target}: it exists and is not a regular file.`);
    }
    if (existing && !opts.force) {
      skipped.push(name);
      continue;
    }
    const data = files.get(name) ?? "";
    replaceFile(target, data);
    // The same rule as the zip download: a script is owner-executable.
    const mode = generatedFileMode(data);
    if (mode !== FILE_MODE) fs.chmodSync(target, mode);
    written.push(name);
  }
  return { written, skipped };
}
