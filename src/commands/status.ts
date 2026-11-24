import fs from "node:fs";
import path from "node:path";
import { defineCommand } from "citty";
import { readExportStats } from "../core/export-stats.js";
import { type GeneralizedState, inspectGeneralized } from "../core/generalized.js";
import {
  isEdited,
  isOutcomeVerified,
  type LibraryIssue,
  OUTCOME_NOT_VERIFIED,
  readLibrary,
  readLibraryIssues,
} from "../core/library.js";
import { groupOutcome } from "../core/outcome.js";
import { readSuggestion, SuggestionReadError } from "../core/subagents.js";
import {
  createRetryHandlers,
  loadDigests,
  loadTasks,
  summarizeOutcomes,
} from "../distill/pipeline.js";
import { prepareRetry } from "../distill/retry.js";
import { countOrphanHistories } from "../sources/kiro/discover.js";
import { parseSourceMode, resolveSources, type SourceMode } from "../sources/registry.js";
import { glyph, lineWidth } from "../ui/mode.js";
import { withSpinner } from "../ui/progress.js";
import { bold, dim, green, hint, nounFor, yellow } from "../ui/style.js";
import { fitLines, sayThenRun } from "../ui/wrap.js";
import { leftBehindEntries, resolvePaths, sharedArgs } from "./_shared.js";
import type { ManifestEntry } from "./distill.js";
import { kirocrewHandedOffLine } from "./export.js";
import { type NextCommand, nextCommandText, offerNext } from "./next.js";
import { preferenceStoryLines } from "./preferences.js";

/** "1 session", "3 sessions": the count in bold, the noun in the singular for one. */
function counted(n: number, noun: string, plural = `${noun}s`): string {
  return `${bold(n.toLocaleString("en-US"))} ${nounFor(n, noun, plural)}`;
}

/** Render the "unreadable library entries" warning block; empty when clean. */
function renderLibraryIssues(issues: LibraryIssue[]): string[] {
  if (issues.length === 0) return [];
  const lines = [
    "",
    yellow(
      `${issues.length} unreadable librar${issues.length === 1 ? "y entry" : "y entries"} (skipped, fix or remove):`,
    ),
  ];
  for (const issue of issues) {
    lines.push(`  ${glyph("⚠", "!")} ${issue.slug} ${dim(`(${issue.reason})`)}`);
  }
  return lines;
}

/** Render the "summaries of sessions no longer exported" warning block; empty when clean. */
function renderStaleDigests(keys: string[], flow: object): string[] {
  if (keys.length === 0) return [];
  const lines = [
    "",
    yellow(
      `${keys.length} session ${keys.length === 1 ? "summary is" : "summaries are"} for a session no longer exported (deleted or renamed; ${nextCommandText("reflect", flow)} --fresh clears them):`,
    ),
  ];
  for (const key of keys) {
    lines.push(`  ${glyph("⚠", "!")} ${dim(key)}`);
  }
  return lines;
}

/** What `readSuggestion` found, reduced to what the status line says. */
export type SuggestionState =
  | { state: "absent" }
  | { state: "saved"; roles: number; generatedAt: string; stale: boolean }
  | { state: "damaged"; reason: string };

/**
 * The saved subagent suggestion in plain words: none yet, ready, out of date
 * (the reviewed preferences changed since it was generated), or unreadable.
 */
export function suggestionStatusText(saved: SuggestionState, flow: object = {}): string {
  const label = "suggested subagents:";
  if (saved.state === "absent") return `${label} ${dim("none yet")}`;
  if (saved.state === "damaged") return `${label} ${yellow(`unreadable (${saved.reason})`)}`;
  const roles = `${bold(String(saved.roles))} ${saved.roles === 1 ? "role" : "roles"}`;
  const day = saved.generatedAt.slice(0, 10);
  return saved.stale
    ? `${label} ${roles}, ${yellow(`out of date since ${day}; run ${nextCommandText("suggest-subagents", flow)} to refresh them`)}`
    : `${label} ${roles}, ready, generated ${day}`;
}

/**
 * The saved suggest-subagents result, read through `readSuggestion` (which
 * validates it and compares its fingerprint with the current reviewed set).
 */
export function suggestionStatusLine(home: string): string {
  let saved: SuggestionState;
  try {
    const found = readSuggestion(home);
    saved = found
      ? {
          state: "saved",
          roles: found.artifact.roles.length,
          generatedAt: found.artifact.generated_at,
          stale: found.stale,
        }
      : { state: "absent" };
  } catch (error) {
    const reason = error instanceof SuggestionReadError ? error.reason : (error as Error).message;
    saved = { state: "damaged", reason };
  }
  return suggestionStatusText(saved, { home });
}

/**
 * The saved preference summaries in plain words, for each state the reader
 * reports: none yet, ready, out of date (stale), or damaged.
 */
export function agreementStatusText(saved: GeneralizedState, flow: object = {}): string {
  const label = "preference summaries:";
  if (saved.state === "absent") return `${label} ${dim("none yet")}`;
  if (saved.state === "damaged") {
    return `${label} ${yellow(`damaged (${saved.reason}); the next reflection rebuilds them`)}`;
  }
  const { artifact, stale, incomplete } = saved;
  const count = bold(String(artifact.lessons.length));
  const day = artifact.generated_at.slice(0, 10);
  if (incomplete) {
    const of = `${incomplete.summarized} of ${incomplete.total} ${incomplete.total === 1 ? "preference" : "preferences"} summarized`;
    return `${label} ${count}, ${yellow(`${of}; run ${nextCommandText("reflect", flow)} again to finish`)}`;
  }
  return stale
    ? `${label} ${count}, ${yellow(`out of date since ${day}; the next reflection refreshes them`)}`
    : `${label} ${count}, ready, generated ${day}`;
}

/** Preference summary status follows its saved inputs, including current wording and evidence. */
export function agreementStatusLine(home: string): string {
  return agreementStatusText(inspectGeneralized(home), { home });
}

/** Build the status report: each stage's count, per-task marks, left-behind entries, skipped tasks. */
export function renderStatus(opts: {
  home: string;
  claudeDir: string;
  codexDir?: string;
  kiroDir?: string;
  kirocrewDir?: string;
  opencodeDir?: string;
  opencodeDb?: string;
  source?: SourceMode;
  next?: (command: NextCommand, flow: object) => void;
  flow?: object;
  /** Add the generation ids and the ledger's own bookkeeping. */
  verbose?: boolean;
}): string {
  const lines: string[] = [];

  // Discovered: the sum over every active backend, tolerating missing stores.
  // With two active stores the line gains a per-source breakdown.
  let discovered: number | null = null;
  let discoveredBreakdown = "";
  let orphanHistories = 0;
  try {
    const mode = opts.source ?? "auto";
    const defaults = resolvePaths({});
    const kiroDir = opts.kiroDir ?? defaults.kiroDir;
    const codexDir = opts.codexDir ?? defaults.codexDir;
    const sources = resolveSources(mode, {
      claudeDir: opts.claudeDir,
      codexDir,
      kiroDir,
      kirocrewDir: opts.kirocrewDir ?? defaults.kirocrewDir,
      opencodeDir: opts.opencodeDir,
      opencodeDb: opts.opencodeDb,
    });
    // A directory listing only. The K15 hand-off count is NOT computed here:
    // that needs the kiro classifier over every session file, so it comes from
    // the last export's saved counts instead (core/export-stats.ts).
    const bySource = sources.map((src) => {
      const projects = src.discover({ countEntries: false });
      return { name: src.name, count: projects.reduce((m, p) => m + p.sessions.length, 0) };
    });
    discovered = bySource.reduce((n, s) => n + s.count, 0);
    if (bySource.length > 1) {
      discoveredBreakdown = ` (${bySource.map((s) => `${s.count} ${s.name}`).join(", ")})`;
    }
    // Kiro `.history` files left after their transcript was deleted.
    if (mode === "auto" || mode === "kiro") orphanHistories = countOrphanHistories(kiroDir);
  } catch {
    discovered = null;
  }

  let exported = 0;
  const manifestExports = new Set<string>();
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(opts.home, "exports", "manifest.json"), "utf8"),
    ) as ManifestEntry[];
    if (Array.isArray(manifest)) {
      exported = manifest.length;
      for (const e of manifest) if (e?.export) manifestExports.add(e.export);
    }
  } catch {
    // Nothing exported yet.
  }

  const digests = loadDigests(opts.home);
  const tasks = loadTasks(opts.home);
  const library = readLibrary(opts.home);
  const libraryIssues = readLibraryIssues(opts.home);
  const digested = digests ? Object.keys(digests.digests).length : 0;

  // Digest-checkpoint keys whose export is gone from the manifest (a session
  // deleted or renamed since it was digested): stale, flagged for cleanup.
  const staleDigestKeys =
    digests && manifestExports.size > 0
      ? Object.keys(digests.digests).filter((k) => !manifestExports.has(k))
      : [];

  lines.push(
    `discovered  ${discovered === null ? `${bold("?")} sessions (store scan failed)` : `${counted(discovered, "session")}${discoveredBreakdown}`}`,
  );
  if (orphanHistories > 0) {
    lines.push(
      dim(
        `  ${orphanHistories} Kiro CLI ${orphanHistories === 1 ? "session" : "sessions"} left out: the transcript was deleted, only the typed history remains`,
      ),
    );
  }
  lines.push(`exported    ${counted(exported, "session")}`);
  // K15, from the last export's saved counts. An export written before
  // export-stats.json existed has none, and nothing is printed for K15.
  const exportStats = readExportStats(opts.home);
  if (exportStats && exportStats.kirocrew_handed_off > 0) {
    lines.push(dim(`  ${kirocrewHandedOffLine(exportStats.kirocrew_handed_off)}`));
  }
  const generation = (id: string) => (opts.verbose ? dim(`  (generation ${id})`) : "");
  lines.push(
    `read        ${counted(digested, "session")}${digests ? generation(digests.generation) : ""}`,
  );
  lines.push(...unfinishedLines(opts.home, Boolean(opts.verbose)));

  const flow = opts.flow ?? { home: opts.home };
  if (!tasks) {
    lines.push("grouped     none yet");
    lines.push("written     none yet");
    lines.push(...preferenceStoryLines(opts.home, flow, { lead: "preferences: ", indent: "  " }));
    lines.push(agreementStatusLine(opts.home), suggestionStatusLine(opts.home));
    lines.push(...renderStaleDigests(staleDigestKeys, flow));
    lines.push(...renderLibraryIssues(libraryIssues));
    lines.push("");
    const next = exported === 0 ? "export" : "reflect";
    opts.next?.(next, flow);
    lines.push(hint(nextCommandText(next, flow)));
    return lines.join("\n");
  }

  const unfit = tasks.misc.length
    ? `, ${counted(tasks.misc.length, "session")} did not fit a group`
    : "";
  lines.push(
    `grouped     ${counted(tasks.tasks.length, "task")}${unfit}${generation(tasks.generation)}`,
  );

  const bySlug = new Map(library.map((e) => [e.slug, e]));
  // The rule the author stage uses: a group gets no prompt only when every
  // session in it was abandoned. One not judged yet is still to be written.
  const abandoned = (task: { members: string[] }) =>
    groupOutcome(task.members.map((member) => digests?.digests[member]?.outcome)) === "abandoned";
  // A group the author stage now skips keeps a prompt an earlier run wrote,
  // unchanged: it is kept, not written by this grouping.
  const abandonedSlugs = new Set(tasks.tasks.filter(abandoned).map((t) => t.slug));
  const currentSlugs = new Set(
    tasks.tasks.filter((t) => !abandonedSlugs.has(t.slug)).map((t) => t.slug),
  );
  // "written" = entries for a CURRENT task, written in the current generation.
  // Requiring the slug to still be in tasks.json stops a left-behind entry (a
  // slug dropped by a later grouping in the same generation) from inflating it.
  const current = library.filter(
    (e) => currentSlugs.has(e.slug) && e.sources.generation === tasks.generation,
  );
  // A prompt the person edited is kept as it is by later runs; it is theirs, not pending.
  const keptEdits = library.filter(
    (e) =>
      ((currentSlugs.has(e.slug) && e.sources.generation !== tasks.generation) ||
        abandonedSlugs.has(e.slug)) &&
      isEdited(e),
  );
  const keptEarlier = library.filter((e) => abandonedSlugs.has(e.slug) && !keptEdits.includes(e));
  const keptParts = [
    ...(keptEdits.length
      ? [`${keptEdits.length} kept as you edited ${keptEdits.length === 1 ? "it" : "them"}`]
      : []),
    ...(keptEarlier.length ? [`${keptEarlier.length} kept from an earlier run`] : []),
  ];
  const kept = keptParts.map((part) => `, ${part}`).join("");
  lines.push(
    `written     ${bold(String(current.length))} of ${tasks.tasks.length} ${tasks.tasks.length === 1 ? "prompt" : "prompts"}${kept}`,
  );

  for (const task of tasks.tasks) {
    const entry = bySlug.get(task.slug);
    // The same words `list` uses for a prompt nobody saw reach a result.
    const unverified =
      entry && !isOutcomeVerified(entry.sources) ? ` ${dim(OUTCOME_NOT_VERIFIED)}` : "";
    if (entry && current.includes(entry)) {
      lines.push(`  ${green(glyph("✓", "OK"))} ${task.slug}${unverified}`);
    } else if (entry && keptEdits.includes(entry)) {
      lines.push(
        `  ${green(glyph("✓", "OK"))} ${task.slug} ${dim("kept (edited by you)")}${unverified}`,
      );
    } else if (entry && keptEarlier.includes(entry)) {
      lines.push(
        `  ${glyph("·", "-")} ${task.slug} ${yellow("kept from an earlier run; no longer rewritten because every session in its group was abandoned")}${unverified}`,
      );
    } else {
      // Not written in this generation: skipped, or still to be written.
      const outcomes = digests ? summarizeOutcomes(task.members, digests.digests) : "";
      if (abandoned(task)) {
        lines.push(
          `  ${glyph("·", "-")} ${task.slug} ${yellow(`skipped: every session in it was abandoned${outcomes ? ` (${outcomes})` : ""}`)}`,
        );
      } else {
        lines.push(`  ${glyph("·", "-")} ${task.slug} ${dim("pending")}`);
      }
    }
  }
  const preferences = preferenceStoryLines(opts.home, flow, {
    lead: "preferences: ",
    indent: "  ",
  });
  lines.push(...preferences);
  lines.push(agreementStatusLine(opts.home), suggestionStatusLine(opts.home));

  // Left-behind entries: library entries with no matching current task. Covers
  // BOTH the stale-generation case (after --fresh) AND same-generation entries
  // whose slug was dropped when a later grouping merged or renamed tasks; those
  // keep the current generation id and would pass a generation-only check.
  const orphans = leftBehindEntries(library, tasks);
  if (orphans.length > 0) {
    lines.push("");
    lines.push(
      yellow(
        `${orphans.length} librar${orphans.length === 1 ? "y entry was" : "y entries were"} left behind when sessions were regrouped (remove with ${nextCommandText("prune", flow)}):`,
      ),
    );
    for (const o of orphans) {
      lines.push(`  ${glyph("⚠", "!")} ${o.slug}${generation(o.sources.generation)}`);
    }
  }

  lines.push(...renderStaleDigests(staleDigestKeys, flow));
  lines.push(...renderLibraryIssues(libraryIssues));
  lines.push("");
  const pending = tasks.tasks.some(
    (task) =>
      !current.some((entry) => entry.slug === task.slug) &&
      !keptEdits.some((entry) => entry.slug === task.slug) &&
      !abandoned(task),
  );
  const next = pending
    ? "reflect"
    : current.length + keptEdits.length + keptEarlier.length > 0
      ? "gui"
      : "export";
  const nextFlow = next === "gui" && preferences.length ? { ...flow, tab: "preferences" } : flow;
  opts.next?.(next, nextFlow);
  lines.push(hint(nextCommandText(next, nextFlow)));
  return lines.join("\n");
}

/** What one kind of saved call is called on screen, singular and plural. */
const CALL_NAMES: Record<string, [string, string]> = {
  digest: ["session read", "session reads"],
  "cluster-window": ["grouping call", "grouping calls"],
  "cluster-merge": ["grouping call", "grouping calls"],
  author: ["prompt write", "prompt writes"],
};

/**
 * Work the last runs left unfinished, in plain counts: calls that failed or
 * were interrupted, and calls that cannot run as they are. Nothing when
 * everything finished. `verbose` adds the ledger's own detail per operation.
 */
function unfinishedLines(home: string, verbose: boolean): string[] {
  if (!fs.existsSync(path.join(home, "distill", "operations.json"))) {
    return verbose
      ? ["retry       no recorded failure history; older saved tasks require --recover-tasks"]
      : [];
  }
  const lines: string[] = [];
  try {
    const retry = prepareRetry({ home, handlers: createRetryHandlers(home) });
    const open = [...retry.modelOperations, ...retry.localRepairs];
    const byKind = new Map<string, number>();
    for (const item of open) {
      const [one, many] = CALL_NAMES[item.operation.kind] ?? ["call", "calls"];
      const key = `${one}\u0000${many}`;
      byKind.set(key, (byKind.get(key) ?? 0) + 1);
    }
    const parts = [...byKind].map(([key, n]) => {
      const [one, many] = key.split("\u0000");
      return `${n} ${n === 1 ? one : many}`;
    });
    if (parts.length) lines.push(`unfinished  ${parts.join(", ")} did not finish`);
    if (retry.blocked.length) {
      lines.push(
        `blocked     ${retry.blocked.length} ${retry.blocked.length === 1 ? "call cannot" : "calls cannot"} run as saved${verbose ? "" : `; see ${nextCommandText("status", { home })} --verbose`}`,
      );
    }
    if (verbose) {
      lines.push(
        dim(
          `  ledger: ${retry.modelOperations.length} retryable, ${retry.localRepairs.length} ${retry.localRepairs.length === 1 ? "local repair" : "local repairs"}, ${retry.blocked.length} blocked`,
        ),
      );
      for (const item of open) {
        lines.push(
          dim(
            `  ${item.operation.kind} ${item.operation.unitId}: ${retry.localRepairs.includes(item) ? "saved result: local repair" : item.operation.state === "running" ? "interrupted" : item.operation.state}`,
          ),
        );
      }
      for (const item of retry.blocked)
        lines.push(dim(`  ${item.kind} ${item.unitId}: blocked, ${item.reason}`));
      const queued = retry.excluded.filter((item) => item.reason === "not attempted").length;
      const pending = retry.excluded.filter((item) =>
        item.reason.includes("adoption pending"),
      ).length;
      if (queued) {
        lines.push(
          dim(
            `  ${queued} queued ${queued === 1 ? "operation was" : "operations were"} never attempted; excluded from strict retry`,
          ),
        );
      }
      if (pending) {
        lines.push(
          dim(
            `  ${pending} recovered grouping ${pending === 1 ? "result awaits" : "results await"} adoption by the next reflection`,
          ),
        );
      }
    }
    if (parts.length || retry.blocked.length) {
      lines.push(
        ...sayThenRun(
          "  To try them again:",
          `${nextCommandText("reflect", { home })} --retry-failed --dry-run`,
          Number.POSITIVE_INFINITY,
        ),
      );
    }
  } catch (error) {
    lines.push(`unfinished  could not be read: ${(error as Error).message}`);
  }
  return lines;
}

export default defineCommand({
  meta: {
    name: "status",
  },
  args: {
    ...sharedArgs,
    verbose: {
      type: "boolean",
      description: "Also show generation ids and the bookkeeping of unfinished calls",
    },
  },
  async run({ args }) {
    const paths = resolvePaths(args);
    let next: NextCommand | undefined;
    let nextFlow: object = args;
    const report = await withSpinner(process.stdout, "Reading library status", async () =>
      renderStatus({
        ...paths,
        source: parseSourceMode(args.source),
        flow: args,
        verbose: args.verbose,
        next: (command, flow) => {
          next = command;
          nextFlow = flow;
        },
      }),
    );
    const width = lineWidth();
    console.log(fitLines([report], width).join("\n"));
    if (next) await offerNext(next, nextFlow, { hintPrinted: true });
  },
});
