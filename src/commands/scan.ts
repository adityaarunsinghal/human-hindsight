import { defineCommand } from "citty";
import { countOrphanHistories } from "../sources/kiro/discover.js";
import { parseSourceMode, resolveSources } from "../sources/registry.js";
import type { ProjectInfo } from "../sources/types.js";
import { cyan, dim, green, hint, table } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";

/** Format a Date as a human, sortable day stamp: `2026-07-13`. */
function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Scan behavior, shared with the root command (running with no args = scan). */
export function runScan(args: {
  home?: string;
  "claude-dir"?: string;
  "codex-dir"?: string;
  "kiro-dir"?: string;
  source?: string;
}): void {
  const { claudeDir, codexDir, kiroDir } = resolvePaths(args);
  const mode = parseSourceMode(args.source);
  const sources = resolveSources(mode, { claudeDir, codexDir, kiroDir });
  // Merge every active backend's projects. With a single active source (the
  // common claude-only machine) this is exactly the old single-store list.
  const projects: ProjectInfo[] = sources.flatMap((s) => s.discover());

  if (projects.length === 0) {
    if (mode === "kiro") {
      console.log(`No kiro-cli sessions found under ${kiroDir}/sessions/cli`);
      console.log(
        dim("Point at a different location with --kiro-dir <path> (or KIRO_CONFIG_DIR)."),
      );
    } else if (mode === "codex") {
      console.log(`No Codex sessions found under ${codexDir}/sessions or archived_sessions`);
      console.log(dim("Point at a different location with --codex-dir <path> (or CODEX_HOME)."));
    } else if (mode === "claude") {
      console.log(`No Claude Code projects found under ${claudeDir}/projects`);
      console.log(
        dim("Point at a different location with --claude-dir <path> (or set CLAUDE_CONFIG_DIR)."),
      );
    } else {
      console.log("No Claude Code, Codex, or kiro-cli sessions found.");
      console.log(dim("Use --claude-dir, --codex-dir, or --kiro-dir to select a different store."));
    }
    console.log(
      dim("Optional: human-hindsight retention — review local history retention settings."),
    );
    return;
  }

  // Sort by latest activity, most recent first. Empty projects (no mtime) sink.
  const sorted = [...projects].sort(
    (a, b) => (b.latestMtime?.getTime() ?? 0) - (a.latestMtime?.getTime() ?? 0),
  );

  const rows = sorted.map((p) => [
    cyan(p.shortName),
    String(p.sessions.length),
    String(p.entryTotal),
    p.latestMtime ? dim(formatDate(p.latestMtime)) : dim("-"),
  ]);

  console.log(table(rows, { header: ["Project", "Sessions", "Entries", "Latest"] }));

  const sessionTotal = projects.reduce((sum, p) => sum + p.sessions.length, 0);
  console.log("");
  console.log(green(`${projects.length} projects, ${sessionTotal} sessions`));
  // Orphan .history files: a human typed in these sessions but the transcript
  // was deleted — keep the inventory honest about what can't be exported.
  if (mode === "auto" || mode === "kiro") {
    const orphans = countOrphanHistories(kiroDir);
    if (orphans > 0) {
      console.log(
        dim(`${orphans} kiro session(s) whose transcript is gone (orphan .history) — not counted`),
      );
    }
  }
  console.log(hint("human-hindsight export"));
  console.log(dim("Optional: human-hindsight retention — keep more history for future exports."));
}

export default defineCommand({
  meta: {
    name: "scan",
    description: "Inventory Claude Code, Codex, and kiro-cli projects and sessions",
  },
  args: { ...sharedArgs },
  run({ args }) {
    runScan(args);
  },
});
