import { defineCommand } from "citty";
import { countOrphanHistories } from "../sources/kiro/discover.js";
import { SOURCE_PRODUCT_NAMES } from "../sources/labels.js";
import { parseSourceMode, resolveSources } from "../sources/registry.js";
import type { ProjectInfo, SessionSource, SourceName } from "../sources/types.js";
import { lineWidth } from "../ui/mode.js";
import { startProgress } from "../ui/progress.js";
import { counted, cyan, dim, green, hint, table } from "../ui/style.js";
import { fitLines, sayThenRun } from "../ui/wrap.js";
import { resolvePaths, sharedArgs } from "./_shared.js";
import { flowArgs, nextCommandText, offerNext } from "./next.js";

/** One backend's contribution to a scan, for the `Found` banner. */
export interface FoundBackend {
  name: SourceName;
  projects: number;
  sessions: number;
  /** kiro only: sessions rule K15 recognises as Kiro Crew runs. */
  kirocrewRuns?: number;
}

/**
 * The line printed before the project table, naming each backend that
 * contributed at least one project (in registry order) by its product name:
 *
 *   Found Claude Code (12 projects, 489 sessions), Kiro CLI (164 projects,
 *   748 sessions; 272 are Kiro Crew runs, read from the Kiro Crew store),
 *   Kiro Crew (5 projects, 75 chats)
 *
 * Kiro Crew counts say `chats` because that is what Kiro Crew calls them. The
 * Kiro CLI entry names its K15 count only when it is above zero. Returns null
 * when nothing contributed.
 */
export function renderFoundBanner(found: readonly FoundBackend[]): string | null {
  if (found.length === 0) return null;
  const entries = found.map((b) => {
    const units =
      b.name === "kirocrew"
        ? counted(b.sessions, "chat", "chats")
        : counted(b.sessions, "session", "sessions");
    let entry = `${SOURCE_PRODUCT_NAMES[b.name]} (${counted(b.projects, "project", "projects")}, ${units}`;
    if (b.name === "kiro" && b.kirocrewRuns && b.kirocrewRuns > 0) {
      entry +=
        b.kirocrewRuns === 1
          ? "; 1 is a Kiro Crew run, read from the Kiro Crew store"
          : `; ${b.kirocrewRuns.toLocaleString("en-US")} are Kiro Crew runs, read from the Kiro Crew store`;
    }
    return `${entry})`;
  });
  return `Found ${entries.join(", ")}`;
}

/** Format a Date as a human, sortable day stamp: `2026-07-13`. */
function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Detailed inventory for `scan` and the home menu's project list. */
export function runScan(args: {
  home?: string;
  "claude-dir"?: string;
  "codex-dir"?: string;
  "kiro-dir"?: string;
  "kirocrew-dir"?: string;
  "opencode-dir"?: string;
  "opencode-db"?: string;
  source?: string;
  project?: string;
  "follow-up"?: boolean;
}): number {
  args = flowArgs(args);
  const paths = resolvePaths(args);
  const { claudeDir, codexDir, kiroDir, kirocrewDir, opencodeDir } = paths;
  const mode = parseSourceMode(args.source);
  const progress = startProgress(process.stdout, "Scanning agent history");
  const found: FoundBackend[] = [];
  let projects: ProjectInfo[];
  let sources: SessionSource[] = [];
  try {
    sources = resolveSources(mode, paths);
    // Each active backend's projects, kept per backend for the Found banner and
    // merged for the table, with discovery feedback visible.
    projects = sources.flatMap((source) => {
      progress.update(`Scanning ${source.name} sessions`);
      const own = source
        .discover()
        .filter(
          (project) =>
            !args.project || project.shortName.toLowerCase().includes(args.project.toLowerCase()),
        );
      if (own.length > 0) {
        const backend: FoundBackend = {
          name: source.name,
          projects: own.length,
          sessions: own.reduce((sum, p) => sum + p.sessions.length, 0),
        };
        // K15: how many kiro sessions are Kiro Crew runs. This runs the kiro
        // classifier over every listed session, which reads each session file
        // once more (discovery above already read them to count entries), so it
        // happens only when the kiro backend is active in this scan.
        if (source.name === "kiro" && source.classify) {
          progress.update("Checking kiro sessions for Kiro Crew runs");
          let runs = 0;
          for (const project of own) {
            for (const session of project.sessions) {
              if (source.classify({ ...session, project: project.shortName }) === "kirocrew") {
                runs++;
              }
            }
          }
          backend.kirocrewRuns = runs;
        }
        found.push(backend);
      }
      return own;
    });
  } finally {
    for (const source of sources) source.dispose?.();
    progress.clear();
  }

  if (projects.length === 0) {
    if (mode === "kirocrew") {
      console.log(`No Kiro Crew chats found under ${kirocrewDir}/sessions`);
      console.log(
        dim(
          "Point at a different location with --kirocrew-dir <path> (or HUMAN_HINDSIGHT_KIROCREW_DIR).",
        ),
      );
    } else if (mode === "kiro") {
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
      console.log("No Claude Code, Codex, kiro-cli, Kiro Crew, or OpenCode sessions found.");
      console.log(
        dim(
          "Use --claude-dir, --codex-dir, --kiro-dir, --kirocrew-dir, or --opencode-dir to select a different store.",
        ),
      );
    }
    for (const line of sayThenRun(
      "To review local history retention settings, run",
      nextCommandText("retention", args),
      lineWidth() ?? Number.POSITIVE_INFINITY,
    ))
      console.log(dim(line));
    return 0;
  }

  // Sort by latest activity, most recent first. Empty projects (no mtime) sink.
  const sorted = [...projects].sort(
    (a, b) => (b.latestMtime?.getTime() ?? 0) - (a.latestMtime?.getTime() ?? 0),
  );

  const banner = renderFoundBanner(found);
  if (banner) {
    const bannerWidth = lineWidth();
    console.log(fitLines([banner], bannerWidth).join("\n"));
    console.log("");
  }

  const rows = sorted.map((p) => [
    cyan(p.shortName),
    String(p.sessions.length),
    String(p.entryTotal),
    p.latestMtime ? dim(formatDate(p.latestMtime)) : dim("-"),
  ]);

  console.log(table(rows, { header: ["Project", "Sessions", "Entries", "Latest"] }));

  const sessionTotal = projects.reduce((sum, p) => sum + p.sessions.length, 0);
  console.log("");
  console.log(
    green(
      `${counted(projects.length, "project", "projects")}, ${counted(sessionTotal, "session", "sessions")}`,
    ),
  );
  // Kiro `.history` files whose transcript was deleted: a person typed in these
  // sessions, so keep the inventory honest about what cannot be exported.
  if (mode === "auto" || mode === "kiro") {
    const orphans = countOrphanHistories(kiroDir);
    if (orphans > 0) {
      console.log(
        dim(
          `${counted(orphans, "Kiro CLI session", "Kiro CLI sessions")} left out: the transcript was deleted, only the typed history remains`,
        ),
      );
    }
  }
  console.log(hint(nextCommandText("export", args)));
  for (const line of sayThenRun(
    "To keep more history for future exports, review your retention settings",
    nextCommandText("retention", args),
    lineWidth() ?? Number.POSITIVE_INFINITY,
  ))
    console.log(dim(line));
  return sessionTotal;
}

export async function runScanAndNext(args: Parameters<typeof runScan>[0]): Promise<void> {
  const count = runScan(args);
  if (count > 0) await offerNext("export", args, { hintPrinted: true });
}

export default defineCommand({
  meta: {
    name: "scan",
  },
  args: { ...sharedArgs },
  async run({ args }) {
    await runScanAndNext(args);
  },
});
