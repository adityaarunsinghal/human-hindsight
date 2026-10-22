import { defineCommand } from "citty";
import { countOrphanHistories } from "../sources/kiro/discover.js";
import { parseSourceMode, resolveSources } from "../sources/registry.js";
import type { ProjectInfo } from "../sources/types.js";
import { cyan, dim, green, hint, table } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";
import { flowArgs, nextCommandText, offerNext } from "./next.js";

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
  "opencode-dir"?: string;
  "opencode-db"?: string;
  source?: string;
  project?: string;
  "follow-up"?: boolean;
}): number {
  args = flowArgs(args);
  const paths = resolvePaths(args);
  const { claudeDir, codexDir, kiroDir, opencodeDir } = paths;
  const mode = parseSourceMode(args.source);
  const sources = resolveSources(mode, paths);
  // Merge every active backend's projects. With a single active source (the
  // common claude-only machine) this is exactly the old single-store list.
  const projects: ProjectInfo[] = sources
    .flatMap((s) => s.discover())
    .filter(
      (project) =>
        !args.project || project.shortName.toLowerCase().includes(args.project.toLowerCase()),
    );

  if (projects.length === 0) {
    if (mode === "kiro") {
      console.log(`No kiro-cli sessions found under ${kiroDir}/sessions/cli`);
      console.log(
        dim("Point at a different location with --kiro-dir <path> (or KIRO_CONFIG_DIR)."),
      );
    } else if (mode === "codex") {
      console.log(`No Codex sessions found under ${codexDir}/sessions or archived_sessions`);
      console.log(dim("Point at a different location with --codex-dir <path> (or CODEX_HOME)."));
    } else if (mode === "opencode") {
      console.log(`No OpenCode sessions found under ${opencodeDir}`);
      console.log(
        dim("Use --opencode-dir <path> or --opencode-db <file> to select a different store."),
      );
    } else if (mode === "claude") {
      console.log(`No Claude Code projects found under ${claudeDir}/projects`);
      console.log(
        dim("Point at a different location with --claude-dir <path> (or set CLAUDE_CONFIG_DIR)."),
      );
    } else {
      console.log("No Claude Code, Codex, kiro-cli, or OpenCode sessions found.");
      console.log(
        dim(
          "Use --claude-dir, --codex-dir, --kiro-dir, or --opencode-dir to select a different store.",
        ),
      );
    }
    console.log(
      dim("Optional: human-hindsight retention — review local history retention settings."),
    );
    return 0;
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
  console.log(hint(nextCommandText("export", args)));
  console.log(dim("Optional: human-hindsight retention — keep more history for future exports."));
  return sessionTotal;
}

export async function runScanAndNext(args: Parameters<typeof runScan>[0]): Promise<void> {
  if (runScan(args) > 0) await offerNext("export", args, { hintPrinted: true });
}

export default defineCommand({
  meta: {
    name: "scan",
    description: "Inventory Claude Code, Codex, Kiro, and OpenCode projects and sessions",
  },
  args: { ...sharedArgs },
  async run({ args }) {
    await runScanAndNext(args);
  },
});
