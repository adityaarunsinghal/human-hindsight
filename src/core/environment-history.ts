import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import type { ResolvedPaths } from "../commands/_shared.js";
import { resolveSources } from "../sources/registry.js";
import type { ProjectInfo, SessionSource, SourceName } from "../sources/types.js";

export interface HistoryCounts {
  projects: number;
  sessions: number;
  newest?: Date;
  newSessions: number;
  /** Kiro's preliminary count includes runs whose chat belongs to Kiro Crew. */
  exact: boolean;
}

interface HistoryRequest {
  kind: "human-hindsight-history";
  paths: ResolvedPaths;
  names: SourceName[];
  project?: string;
  newerThan?: Date;
}

type HistoryUpdate =
  | { name: SourceName; history: HistoryCounts }
  | { name: SourceName; historyError: string };

export function isEnvironmentWorker(): boolean {
  return !isMainThread && workerData?.kind === "human-hindsight-history";
}

function countProjects(
  projects: ProjectInfo[],
  newerThan: Date | undefined,
  classifyCrew?: SessionSource["classify"],
): HistoryCounts {
  const counts: HistoryCounts = { projects: 0, sessions: 0, newSessions: 0, exact: true };
  for (const project of projects) {
    let count = 0;
    for (const session of project.sessions) {
      if (classifyCrew) {
        const kind = classifyCrew({ ...session, project: project.shortName });
        if (!kind)
          throw new Error("A Kiro CLI transcript could not be checked for Kiro Crew runs.");
        if (kind === "kirocrew") continue;
      }
      count++;
      if (!counts.newest || session.mtime > counts.newest) counts.newest = session.mtime;
      if (newerThan && session.mtime > newerThan) counts.newSessions++;
    }
    if (count > 0) counts.projects++;
    counts.sessions += count;
  }
  return counts;
}

function discoverHistory(request: HistoryRequest, publish: (message: HistoryUpdate) => void): void {
  const needle = request.project?.toLowerCase();
  // Count the independent stores before reading Kiro transcripts for rule K15.
  const ordered: SourceName[] = request.names.filter((name) => name !== "kiro");
  if (request.names.includes("kiro")) ordered.push("kiro");
  for (const name of ordered) {
    let source: SessionSource | undefined;
    try {
      [source] = resolveSources(name, request.paths);
      if (!source) throw new Error("History source is unavailable.");
      const projects = source
        .discover({ countEntries: false, readProjectPaths: Boolean(needle) })
        .filter((p) => !needle || p.shortName.toLowerCase().includes(needle));
      const counts = countProjects(projects, request.newerThan);
      if (name === "kiro" && counts.sessions && source.classify) {
        publish({ name, history: { ...counts, exact: false } });
        publish({ name, history: countProjects(projects, request.newerThan, source.classify) });
      } else {
        publish({ name, history: counts });
      }
    } catch (error) {
      publish({
        name,
        historyError: error instanceof Error ? error.message : "History is unreadable.",
      });
    } finally {
      source?.dispose?.();
    }
  }
}

if (isEnvironmentWorker() && parentPort) {
  const port = parentPort;
  discoverHistory(workerData as HistoryRequest, (update) => port.postMessage(update));
}

/** Use this module's URL in source builds and the existing CLI entry in the single-file package. */
export function startHistoryCount(
  request: Omit<HistoryRequest, "kind">,
  publish: (message: HistoryUpdate) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!request.names.length || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const waiting = new Set(request.names);
    const unavailable = () => {
      if (!signal.aborted) {
        for (const name of waiting) {
          publish({ name, historyError: "The background reader stopped." });
        }
      }
      waiting.clear();
    };
    let worker: Worker;
    try {
      worker = new Worker(new URL(import.meta.url), {
        workerData: { kind: "human-hindsight-history", ...request } satisfies HistoryRequest,
        stdout: true,
        stderr: true,
      });
    } catch {
      unavailable();
      resolve();
      return;
    }
    // SQLite warnings from the background reader must not interrupt the terminal menu.
    worker.stdout.resume();
    worker.stderr.resume();
    const abort = () => void worker.terminate();
    signal.addEventListener("abort", abort, { once: true });
    worker.on("message", (update: HistoryUpdate) => {
      if (signal.aborted) return;
      if ("historyError" in update || update.history.exact) waiting.delete(update.name);
      publish(update);
    });
    worker.once("error", unavailable);
    worker.once("exit", () => {
      signal.removeEventListener("abort", abort);
      unavailable();
      resolve();
    });
  });
}
