import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type OpenCodePaths, resolveOpenCodePaths } from "../sources/opencode/paths.js";

/** Global flags shared by every subcommand. */
export const sharedArgs = {
  "follow-up": {
    type: "boolean",
    description: "Offer next steps in a terminal (disable with --no-follow-up)",
  },
  runner: { type: "string", description: "Distillation engine, including optional next steps" },
  model: { type: "string", description: "Model for distillation, including optional next steps" },
  project: { type: "string", description: "Project filter to keep through the workflow" },
  home: {
    type: "string",
    description:
      "Data directory (env HUMAN_HINDSIGHT_HOME; legacy CC_HINDSIGHT_HOME is also supported)",
  },
  "claude-dir": {
    type: "string",
    description: "Claude Code config directory (env CLAUDE_CONFIG_DIR)",
  },
  "codex-dir": {
    type: "string",
    description: "Codex data directory (env CODEX_HOME; default ~/.codex)",
  },
  "kiro-dir": {
    type: "string",
    description: "kiro-cli config directory (env KIRO_CONFIG_DIR; default ~/.kiro)",
  },
  "opencode-dir": {
    type: "string",
    description: "OpenCode data directory (env HUMAN_HINDSIGHT_OPENCODE_DIR; honors XDG_DATA_HOME)",
  },
  "opencode-db": {
    type: "string",
    description: "OpenCode database (env OPENCODE_DB; relative to --opencode-dir)",
  },
  source: {
    type: "string",
    // Unlike the path flags above, this one has no environment variable, so the
    // root-level publish in main.ts cannot carry it into a subcommand: citty
    // gives a subcommand only its OWN parsed args. Say so rather than advertise
    // a placement that is silently ignored.
    description:
      "Which backend(s) to read: claude, codex, kiro, opencode, or auto (default: auto). Pass after the subcommand",
  },
} as const;

export interface ResolvedPaths extends OpenCodePaths {
  home: string;
  claudeDir: string;
  codexDir: string;
  kiroDir: string;
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
  const configured = explicit ?? env.HUMAN_HINDSIGHT_HOME ?? env.CC_HINDSIGHT_HOME;
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

/**
 * Resolve data directories: flag > env > default under os.homedir(). The
 * `kiro-dir` points at the kiro CONFIG root (sessions are read from
 * `<kiroDir>/sessions/cli`), parallel to `--claude-dir`.
 */
export function resolvePaths(args: {
  home?: string;
  "claude-dir"?: string;
  "codex-dir"?: string;
  "kiro-dir"?: string;
  "opencode-dir"?: string;
  "opencode-db"?: string;
}): ResolvedPaths {
  const home = resolveDataHome(args.home);
  const claudeDir =
    args["claude-dir"] ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const codexDir = args["codex-dir"] ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const kiroDir =
    args["kiro-dir"] ?? process.env.KIRO_CONFIG_DIR ?? path.join(os.homedir(), ".kiro");
  return {
    home,
    claudeDir,
    codexDir,
    kiroDir,
    ...resolveOpenCodePaths({ dir: args["opencode-dir"], db: args["opencode-db"] }),
  };
}

/**
 * Parse a non-negative integer CLI flag, clamping deterministically: a missing
 * or unparseable value yields `fallback`; a parsed value below `min` clamps up
 * to `min`. Shared by `export --min-messages` and `distill --min-substance` so
 * the two commands can never diverge. The naive `parseInt(...) || fallback`
 * has two traps this avoids: it maps a legitimate "0" to the fallback, and it
 * lets "-1" through as "everything is eligible".
 */
export function parseClampedInt(
  raw: string | undefined,
  opts: { fallback: number; min: number },
): number {
  if (raw === undefined) return opts.fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return opts.fallback;
  return parsed < opts.min ? opts.min : parsed;
}
