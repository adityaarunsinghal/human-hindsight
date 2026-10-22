import os from "node:os";
import path from "node:path";

export interface OpenCodePaths {
  opencodeDir: string;
  opencodeDb: string;
  opencodeConfigDir: string;
}

/** OpenCode uses XDG roots on both macOS and Linux; config and data are separate. */
export function resolveOpenCodePaths(
  opts: { dir?: string; db?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = os.homedir(),
): OpenCodePaths {
  const opencodeDir = path.resolve(
    opts.dir ??
      env.HUMAN_HINDSIGHT_OPENCODE_DIR ??
      path.join(env.XDG_DATA_HOME || path.join(userHome, ".local", "share"), "opencode"),
  );
  const file = opts.db ?? (env.HUMAN_HINDSIGHT_OPENCODE_DB || env.OPENCODE_DB || "opencode.db");
  return {
    opencodeDir,
    opencodeDb: file === ":memory:" ? file : path.resolve(opencodeDir, file),
    opencodeConfigDir:
      env.OPENCODE_CONFIG_DIR ||
      path.join(env.XDG_CONFIG_HOME || path.join(userHome, ".config"), "opencode"),
  };
}
