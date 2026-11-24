import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONCURRENCY } from "../core/budget.js";
import { fromEarlierGrouping, isEdited, type LibraryEntry, readLibrary } from "../core/library.js";
import { checkedValue, type ValueRule, wholeNumber, wholeOption } from "../core/value-rule.js";
import { type OpenCodePaths, resolveOpenCodePaths } from "../sources/opencode/paths.js";
import { closestMatches } from "../ui/suggest.js";

/**
 * Global flags shared by every subcommand. `valueHint` is the placeholder help
 * prints after the flag, so each one shows a real value or the accepted choices.
 */
export const sharedArgs = {
  quality: {
    type: "string",
    valueHint: "balanced|best",
    description: "Model plan for reading and writing (default: balanced)",
  },
  recent: {
    type: "string",
    valueHint: "25",
    description: "Start with this many of your most recent sessions",
  },
  plain: {
    type: "boolean",
    description: "Use numbered prompts and static progress (env HUMAN_HINDSIGHT_PLAIN=1)",
  },
  "follow-up": {
    type: "boolean",
    description: "Offer next steps in a terminal (disable with --no-follow-up)",
  },
  runner: {
    type: "string",
    valueHint: "cli",
    description: "Coding CLI for model calls: claude, codex, kiro, opencode, or auto (default)",
  },
  model: {
    type: "string",
    valueHint: "name",
    description: "Model for every distill step, in place of the --quality plan",
  },
  "cluster-model": {
    type: "string",
    valueHint: "name",
    description: "Model for grouping sessions into tasks only (default: --model)",
  },
  "author-model": {
    type: "string",
    valueHint: "name",
    description: "Model for writing prompts only (default: --model)",
  },
  project: {
    type: "string",
    valueHint: "name",
    description: "Only projects whose name contains this text, kept through every step",
  },
  home: {
    type: "string",
    valueHint: "dir",
    description:
      "Data directory (env HUMAN_HINDSIGHT_HOME; legacy CC_HINDSIGHT_HOME is also supported)",
  },
  "claude-dir": {
    type: "string",
    valueHint: "dir",
    description: "Claude Code config directory (env CLAUDE_CONFIG_DIR; default ~/.claude)",
  },
  "codex-dir": {
    type: "string",
    valueHint: "dir",
    description: "Codex data directory (env CODEX_HOME; default ~/.codex)",
  },
  "kiro-dir": {
    type: "string",
    valueHint: "dir",
    description: "Kiro CLI config directory (env KIRO_CONFIG_DIR; default ~/.kiro)",
  },
  "kirocrew-dir": {
    type: "string",
    valueHint: "dir",
    description:
      "Kiro Crew data directory (env HUMAN_HINDSIGHT_KIROCREW_DIR; default ~/.kiro/crew)",
  },
  "opencode-dir": {
    type: "string",
    valueHint: "dir",
    description: "OpenCode data directory (env HUMAN_HINDSIGHT_OPENCODE_DIR; honors XDG_DATA_HOME)",
  },
  "opencode-db": {
    type: "string",
    valueHint: "file",
    description: "OpenCode database (env OPENCODE_DB; relative to --opencode-dir)",
  },
  source: {
    type: "string",
    valueHint: "tool",
    description: "History to read: claude, codex, kiro, kirocrew, opencode, or auto (default)",
  },
} as const;

/**
 * Options of the bare command only (the home screen). Each one prints the
 * setup summary and the next command instead of the menu, and stdin is never
 * read. They are not shared: `status --yes` stays an unknown option.
 */
export const homeArgs = {
  "dry-run": {
    type: "boolean",
    description: "Print the setup summary and the next command; nothing runs",
  },
  yes: {
    type: "boolean",
    description: "Print the setup summary and the next command without asking anything",
  },
} as const;

/**
 * Shared selections for commands dispatched in the same process. The three
 * history folders use private names: every coding CLI started later inherits
 * this environment, and `CLAUDE_CONFIG_DIR` pointed at a copied history folder
 * would make the `claude` that runs model calls look signed out.
 */
export const flagEnvironments: Readonly<Record<string, string>> = {
  home: "HUMAN_HINDSIGHT_HOME",
  "claude-dir": "HUMAN_HINDSIGHT_CLAUDE_DIR",
  "codex-dir": "HUMAN_HINDSIGHT_CODEX_DIR",
  "kiro-dir": "HUMAN_HINDSIGHT_KIRO_DIR",
  "kirocrew-dir": "HUMAN_HINDSIGHT_KIROCREW_DIR",
  "opencode-dir": "HUMAN_HINDSIGHT_OPENCODE_DIR",
  "opencode-db": "HUMAN_HINDSIGHT_OPENCODE_DB",
  runner: "HUMAN_HINDSIGHT_RUNNER",
  model: "HUMAN_HINDSIGHT_MODEL",
  "cluster-model": "HUMAN_HINDSIGHT_CLUSTER_MODEL",
  "author-model": "HUMAN_HINDSIGHT_AUTHOR_MODEL",
  project: "HUMAN_HINDSIGHT_PROJECT",
  quality: "HUMAN_HINDSIGHT_QUALITY",
  recent: "HUMAN_HINDSIGHT_RECENT",
};

/**
 * The variables this process set itself from a flag given before the command
 * (see `publishRootOptions` in `main.ts`). They are not the person's own
 * settings: a printed command still names those choices.
 */
export const publishedVariables = new Set<string>();

/** The person's own environment: without the variables this process published. */
export function ownEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const own = { ...env };
  for (const name of publishedVariables) delete own[name];
  return own;
}

/** How the data home was chosen, so a fix can name the setting that wins. */
export type DataHomeSource = "flag" | "environment" | "default";

export interface ResolvedPaths extends OpenCodePaths {
  home: string;
  /** How `home` was chosen. Unset means the default. */
  homeSource?: DataHomeSource;
  claudeDir: string;
  codexDir: string;
  kiroDir: string;
  kirocrewDir: string;
}

/**
 * Keep existing libraries in place. An explicit flag or environment variable
 * wins; otherwise prefer the new directory when present, then the old one.
 * Merely resolving a path never creates, moves, or merges directories.
 */
export function resolveDataHome(
  explicit?: string,
  opts: { env?: NodeJS.ProcessEnv; homedir?: string } = {},
): string {
  const env = opts.env ?? process.env;
  // An empty home would be the current folder, which may be a project
  // repository: refused from a flag, and unset in a variable.
  if (explicit !== undefined) return checkedValue(FOLDER_RULE, "home", explicit);
  const configured = firstSet(env.HUMAN_HINDSIGHT_HOME, env.CC_HINDSIGHT_HOME);
  if (configured !== undefined) return configured;
  const userHome = opts.homedir ?? os.homedir();
  const preferred = path.join(userHome, ".human-hindsight");
  const legacy = path.join(userHome, ".cc-hindsight");
  const isDirectory = (dir: string) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  };
  return !isDirectory(preferred) && isDirectory(legacy) ? legacy : preferred;
}

/** `--home` wins over the variables, which win over the default; see {@link resolveDataHome}. */
export function dataHomeSource(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): DataHomeSource {
  if (explicit !== undefined) return "flag";
  if (firstSet(env.HUMAN_HINDSIGHT_HOME, env.CC_HINDSIGHT_HOME) !== undefined) return "environment";
  return "default";
}

/** The first value that is set and not empty (blank counts as empty). */
export function firstSet(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "");
}

/** A folder or file option: an empty value would mean the current folder. */
export const FOLDER_RULE: ValueRule = { accepts: (value) => value.trim() !== "", says: "a folder" };
export const FILE_RULE: ValueRule = { accepts: (value) => value.trim() !== "", says: "a file" };

/**
 * Resolve data directories. For the three history folders the order is: the
 * flag, the private name carried between commands in this process, the CLI's
 * own variable, then the default under the home folder. The `kiro-dir` points
 * at the kiro CONFIG root (sessions are read from `<kiroDir>/sessions/cli`),
 * parallel to `--claude-dir`. The `kirocrew-dir` points at Kiro Crew's data
 * directory (chats are read from `<dir>/sessions`).
 */
export function resolvePaths(
  args: {
    home?: string;
    "claude-dir"?: string;
    "codex-dir"?: string;
    "kiro-dir"?: string;
    "kirocrew-dir"?: string;
    "opencode-dir"?: string;
    "opencode-db"?: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPaths {
  const home = resolveDataHome(args.home);
  const claudeDir =
    firstSet(args["claude-dir"], env.HUMAN_HINDSIGHT_CLAUDE_DIR, env.CLAUDE_CONFIG_DIR) ??
    path.join(os.homedir(), ".claude");
  const codexDir =
    firstSet(args["codex-dir"], env.HUMAN_HINDSIGHT_CODEX_DIR, env.CODEX_HOME) ??
    path.join(os.homedir(), ".codex");
  const kiroDir =
    firstSet(args["kiro-dir"], env.HUMAN_HINDSIGHT_KIRO_DIR, env.KIRO_CONFIG_DIR) ??
    path.join(os.homedir(), ".kiro");
  const kirocrewDir =
    firstSet(args["kirocrew-dir"], env.HUMAN_HINDSIGHT_KIROCREW_DIR) ??
    path.join(os.homedir(), ".kiro", "crew");
  return {
    home,
    homeSource: dataHomeSource(args.home, env),
    claudeDir,
    codexDir,
    kiroDir,
    kirocrewDir,
    ...resolveOpenCodePaths({ dir: args["opencode-dir"], db: args["opencode-db"] }),
  };
}

export const MIN_MESSAGES_RULE = wholeNumber(0, "a whole number of messages, 0 or more");
export const CONCURRENCY_RULE = wholeNumber(1, "a whole number of calls at a time, 1 or more");
export const CLUSTER_BATCH_RULE = wholeNumber(1, "a whole number of sessions, 1 or more");
/** `--recent` and `HUMAN_HINDSIGHT_RECENT`. */
export const RECENT_RULE = wholeNumber(1, "a whole number of sessions, such as 25");

/**
 * A message-count threshold: `export --min-messages` and `distill
 * --min-substance`, one rule so the two never diverge. 0 and 1 both mean every
 * session with a message. A wrong value throws its one line; it is never read
 * as the default.
 */
export function parseMessageCount(
  name: "min-messages" | "min-substance",
  raw: string | undefined,
  fallback: number,
): number {
  return Math.max(1, wholeOption(MIN_MESSAGES_RULE, name, raw, fallback));
}

/** `--concurrency`, the default when absent. A wrong value throws its one line. */
export function parseConcurrency(raw: string | undefined): number {
  return wholeOption(CONCURRENCY_RULE, "concurrency", raw, DEFAULT_CONCURRENCY);
}

/** The prompt-name argument of `show`, `copy`, `edit`, and `rate`. */
export const promptNameArg = {
  type: "positional",
  description: "Prompt name, as `list` shows it in the Name column",
  required: true,
} as const;

/**
 * Why a prompt name found nothing, with the closest names in the library as
 * suggestions, so `show landing-polish` points at `landing-page-polish`.
 */
export function unknownPromptMessage(home: string, name: string): string {
  let names: string[] = [];
  try {
    names = readLibrary(home).map((entry) => entry.slug);
  } catch {
    // An unreadable library has no names to suggest.
  }
  const close = closestMatches(name, names);
  const suggestion = close.length ? ` Did you mean ${close.join(", ")}?` : "";
  return `No prompt named "${name}".${suggestion} See every name with \`human-hindsight list\`.`;
}

/**
 * Library entries no current task accounts for: the slug left the grouping,
 * or the entry is from an older generation. A prompt the person edited for a
 * task that still exists is not left behind: later runs keep it on purpose.
 * One rule for `status` and `prune`.
 */
export function leftBehindEntries(
  library: LibraryEntry[],
  tasks: { generation: string; tasks: { slug: string }[] },
): LibraryEntry[] {
  return library.filter((entry) => fromEarlierGrouping(entry, tasks, { edited: isEdited(entry) }));
}
