import type { Readable, Writable } from "node:stream";
import { defineCommand } from "citty";
import { resolveTimeoutMs } from "../core/budget.js";
import {
  materializeConsolidation,
  saveConsolidatedPreferences,
  validateConsolidation,
} from "../core/consolidated-preferences.js";
import { readExportSessionShare } from "../core/environment.js";
import { readLibrary } from "../core/library.js";
import { parseQuality, QUALITIES, type Quality } from "../core/model-plan.js";
import { HISTORICAL_DATA_INSTRUCTION } from "../core/preference-evidence.js";
import {
  preferenceReview,
  readPreferenceReviews,
  reviewedPreferences,
} from "../core/preference-review.js";
import {
  type AggregatedPreference,
  type PreferencesTarget,
  preferenceId,
  readObservedPreferences,
  renderPreferencesBlock,
} from "../core/preferences.js";
import { openRunSession, type RunSession } from "../core/run-session.js";
import { askYesNoAnswer, confirmPlan } from "../distill/consent.js";
import type { RunnerFn } from "../distill/pipeline.js";
import { guardRun, mutableOutput, pinSourcesFrom, type RunGuard } from "../distill/run-guard.js";
import { type Consolidated, ConsolidateSchema } from "../distill/schemas.js";
import { DEFAULT_TIMEOUT_MS } from "../runners/shared.js";
import type { ResolvedCall } from "../runners/types.js";
import { parseSourceMode, type SourceMode } from "../sources/registry.js";
import { type ClipboardResult, copyToClipboard } from "../ui/clipboard.js";
import type { TerminalHost } from "../ui/live.js";
import { canPrompt, lineWidth } from "../ui/mode.js";
import { withSpinner } from "../ui/progress.js";
import { counted, cyan, dim, green, hint, ok } from "../ui/style.js";
import { fitLines, sayThenRun } from "../ui/wrap.js";
import { resolvePaths, sharedArgs } from "./_shared.js";
import { flowArgs, nextCommandText, offerNext, shellWord } from "./next.js";

/** Injectable dependencies (testing). */
export interface PreferencesDeps {
  runner?: RunnerFn;
  input?: Readable;
  /** Where the instruction block goes (stdout), so `preferences > CLAUDE.md` is a clean file. */
  output?: Writable;
  /**
   * Every other line: counts, notes, hints, questions, the plan (stderr).
   * Defaults to `output` when only that is given, else to stderr.
   */
  errorOutput?: Writable;
  /**
   * Clipboard sink; injectable so tests never touch a real clipboard. Shape
   * matches copyToClipboard's return (tool is reported even on failure).
   */
  clipboard?: (text: string) => Promise<ClipboardResult>;
  /** Where Ctrl-C arrives and how the process ends (tests). */
  host?: TerminalHost;
  exit?(code: number): void;
}

export const CONSOLIDATE_PROMPT_VERSION = 2;

/** How many preferences were observed, and where each stands in the person's review. */
export interface PreferenceStory {
  observed: number;
  waiting: number;
  accepted: number;
  dismissed: number;
}

/** Count the observed preferences by review status. A review of older evidence counts as waiting. */
export function preferenceStory(
  home: string,
  observed: AggregatedPreference[] = readObservedPreferences(home),
): PreferenceStory {
  const { reviews } = readPreferenceReviews(home);
  const story = { observed: observed.length, waiting: 0, accepted: 0, dismissed: 0 };
  for (const preference of observed) {
    const { status } = preferenceReview(home, preference, reviews);
    if (status === "accepted") story.accepted++;
    else if (status === "dismissed") story.dismissed++;
    else story.waiting++;
  }
  return story;
}

/**
 * The one sentence every screen uses for the preferences: "3 preferences
 * observed: 2 waiting for your review, 1 accepted." Zero counts are left out,
 * except that nothing accepted is said when some are waiting.
 */
export function preferenceStoryText(story: PreferenceStory): string {
  const parts: string[] = [];
  if (story.waiting) parts.push(`${story.waiting} waiting for your review`);
  if (story.accepted) parts.push(`${story.accepted} accepted`);
  else if (story.waiting) parts.push("none accepted yet");
  if (story.dismissed) parts.push(`${story.dismissed} dismissed`);
  const observed = `${story.observed} ${story.observed === 1 ? "preference" : "preferences"} observed`;
  return parts.length ? `${observed}: ${parts.join(", ")}.` : `${observed}.`;
}

/** Where a person reviews the observed preferences. */
export function reviewCommand(args: object): string {
  return nextCommandText("gui", { ...args, tab: "preferences" });
}

function consolidationCommand(args: Parameters<typeof runPreferences>[0]): string {
  return [
    nextCommandText("preferences", args),
    ...(args.target ? [shellWord(`--target=${args.target}`)] : []),
    ...(args["include-unreviewed"] ? ["--include-unreviewed"] : []),
    "--consolidate",
  ].join(" ");
}

/**
 * The preferences story as `status` and a finished distill run print it: the
 * one sentence, then, while some wait, where to review them with the command
 * alone on its own line. Nothing when none were observed or the review file
 * cannot be read.
 */
export function preferenceStoryLines(
  home: string,
  flow: object,
  o: { lead?: string; indent?: string; width?: number } = {},
): string[] {
  let story: PreferenceStory;
  try {
    story = preferenceStory(home);
  } catch {
    return [];
  }
  if (!story.observed) return [];
  const lines = [`${o.lead ?? ""}${preferenceStoryText(story)}`];
  if (story.waiting)
    lines.push(
      ...sayThenRun(
        `${o.indent ?? ""}Review them in your browser:`,
        reviewCommand(flow),
        o.width ?? Number.POSITIVE_INFINITY,
      ),
    );
  return lines;
}

/** Build the consolidation prompt with a verifiable source mapping. */
export function buildConsolidatePrompt(prefs: AggregatedPreference[]): string {
  return [
    HISTORICAL_DATA_INSTRUCTION,
    "Below are supplied working preferences and their source IDs.",
    "Merge semantic duplicates only when meaning, scope, project, conditions, and",
    "exceptions are equivalent. Keep every distinct preference; never invent new ones.",
    'Do not strengthen "prefer" into "always", remove exceptions, or combine',
    "contradictory instructions. Keep conflicting rules separate for human review.",
    'Retain explicit condition clauses ("unless", "only when", "except", "if")',
    "verbatim. Rules with different conditions must remain separate. Preserve",
    '"prefer" and do not introduce stronger always/must/never requirements.',
    "Keep each item a single imperative line in the author's plain register.",
    "",
    'Respond with JSON: {"preferences": [{"text", "source_ids"}]} where',
    '"source_ids" lists the exact IDs of the input rules represented by that item.',
    "Every input ID must occur exactly once across the output; use no unknown IDs.",
    "A nonempty input requires a nonempty result. Counts will be computed in code.",
    "",
    "=== PREFERENCES ===",
    ...prefs.map((p) =>
      JSON.stringify({
        id: preferenceId(p),
        text: p.text,
        scope: p.scope ?? "global",
        project: p.scope && p.scope !== "global" ? (p.project ?? "") : "",
        count: p.count,
      }),
    ),
    "=== END PREFERENCES ===",
  ].join("\n");
}

/** The preferences command core; returns the intended exit code. */
export async function runPreferences(
  args: {
    home?: string;
    "claude-dir"?: string;
    "codex-dir"?: string;
    "kiro-dir"?: string;
    "opencode-dir"?: string;
    "opencode-db"?: string;
    source?: string;
    runner?: string;
    target?: string;
    consolidate?: boolean;
    timeout?: string;
    yes?: boolean;
    model?: string;
    quality?: string;
    project?: string;
    "include-unreviewed"?: boolean;
  },
  deps: PreferencesDeps = {},
): Promise<number> {
  const typed = args;
  args = flowArgs(args);
  // The block alone goes to `block`; everything a person reads about it goes to `out`.
  // Both fall silent after Ctrl-C, so the interrupt line is the last thing printed.
  const rawBlock = deps.output ?? process.stdout;
  const rawOut = deps.errorOutput ?? deps.output ?? process.stderr;
  const quietOut = mutableOutput(rawOut);
  const quietBlock = rawBlock === rawOut ? quietOut : mutableOutput(rawBlock);
  const out = quietOut.output;
  const block = quietBlock.output;
  const mute = () => {
    quietOut.mute();
    quietBlock.mute();
  };
  const write = (s = "") => out.write(`${fitLines([s], lineWidth(out)).join("\n")}\n`);
  const writeBlock = (s: string) => block.write(`${s}\n`);
  const target = resolveTarget(args.target, parseSourceMode(args.source));
  // A wrong time limit is an error before anything is read, not the default later.
  const timeoutMs = resolveTimeoutMs(args.timeout);

  const { home } = resolvePaths(args);
  const observed = await withSpinner(out, "Reading preference evidence", async () =>
    readObservedPreferences(home),
  );
  const entries = readLibrary(home);
  if (entries.length === 0 && observed.length === 0) {
    write("Your library is empty. Reflect on your sessions to see your preferences.");
    write(hint(nextCommandText("reflect", args), lineWidth(out)));
    return 1;
  }

  const prefs = args["include-unreviewed"]
    ? observed.filter(
        (p) =>
          (p.scope ?? "global") === "global" ||
          (args.project && p.scope === "project" && p.project === args.project),
      )
    : reviewedPreferences(home, observed, args.project);
  if (prefs.length === 0) {
    if (!observed.length) {
      write("No preferences were observed across the library.");
      return 0;
    }
    const story = preferenceStory(home, observed);
    const width = lineWidth(out) ?? Number.POSITIVE_INFINITY;
    write(
      story.accepted
        ? `${preferenceStoryText(story)} None of the accepted ones apply here; a project's own rules need --project <name>.`
        : `No accepted preferences yet. ${preferenceStoryText(story)}`,
    );
    if (story.waiting) {
      for (const line of sayThenRun("Review them in your browser:", reviewCommand(args), width)) {
        write(line);
      }
      const unreviewed = `${nextCommandText("preferences", args)} --include-unreviewed`;
      for (const line of sayThenRun("Or print them without a review:", unreviewed, width)) {
        write(line);
      }
    }
    return 0;
  }
  if (args["include-unreviewed"]) {
    write("Including suggestions you have not reviewed, as asked. Check their scope and evidence.");
  }

  const recurring = prefs.filter((p) => p.count > 1).length;
  write(
    green(`${counted(prefs.length, "preference")} across ${counted(entries.length, "task")}`) +
      (recurring ? cyan(` (${recurring} stated more than once)`) : ""),
  );
  write();

  if (!args.consolidate) {
    const rendered = renderPreferencesBlock(prefs, entries.length, target);
    const merge = consolidationCommand(args);
    writeBlock(rendered);
    write();
    // Offer the copy first; on a successful copy the guidance prints after the
    // confirmation. When no copy happens (declined, failure, or pipe/CI), fall
    // back to the footer in its original position so guidance prints exactly
    // once either way.
    const { copied, interrupted } = await offerCopyBlock({
      block: rendered,
      count: prefs.length,
      target,
      yes: Boolean(args.yes),
      deps: { ...deps, output: out },
      output: out,
      blockOutput: block,
      merge,
    });
    if (interrupted) return 130;
    if (!copied) for (const line of targetFooter(target, merge)) write(line);
    write(hint(`${nextCommandText("suggest-subagents", args)} --dry-run`, lineWidth(out)));
    return 0;
  }

  let session: RunSession;
  try {
    session = await openRunSession({
      home,
      runner: args.runner,
      quality: parseQuality(args.quality),
      explicit: { model: args.model },
      pinSources: pinSourcesFrom(typed, args),
      sessionShare: readExportSessionShare(home, { project: args.project, source: args.source }),
      output: out,
      injectedRunner: deps.runner,
    });
  } catch (error) {
    write(error instanceof Error ? error.message : String(error));
    return 1;
  }
  let guard: RunGuard | undefined;
  try {
    const decision = await confirmPlan(
      {
        digests: 0,
        cluster: 0,
        authorEstimate: 0,
        runnerName: session.ledgerRunner,
        session: session.describe(),
        quality: session.quality,
        consolidation: {
          inputs: prefs.length,
          models: Object.fromEntries(
            QUALITIES.map((quality) => [quality, session.displayModelFor("consolidate", quality)]),
          ) as Record<Quality, string>,
        },
      },
      {
        yes: args.yes,
        input: deps.input,
        output: out,
        host: deps.host,
        onQuality:
          args.quality || process.env.HUMAN_HINDSIGHT_QUALITY
            ? undefined
            : (quality) => {
                session.quality = quality;
              },
      },
    );
    // Ctrl-C at the question means what it means everywhere: one line, exit 130.
    // The question printed its one line for Ctrl-C; nothing was sent.
    if (decision === "interrupted") return 130;
    if (decision !== "proceed") {
      write("Declined. Nothing was sent.");
      return 2;
    }
    // The saved consolidation is part of the library: take the writer lock
    // after consent, and release it on Ctrl-C.
    // Consolidation saves nothing until its single call returns, and the line says so.
    const guarded = guardRun({
      home,
      command: "preferences",
      output: out,
      resume: consolidationCommand({ ...args, quality: session.quality }),
      says: "Interrupted. Nothing was saved; run the same command again:",
      interrupt: () => session.interrupt(),
      mute,
      cleanup: () => session.finalize(),
      host: deps.host,
      exit: deps.exit,
    });
    if ("busy" in guarded) {
      write(guarded.busy);
      return 1;
    }
    guard = guarded;
    // The one call below is certain from here, so readiness is checked now and only now.
    const ready = await session.liveCheck("consolidate");
    if (!ready.ok) {
      write(ready.line);
      writeBlock(renderPreferencesBlock(prefs, entries.length, target));
      return 1;
    }
    const {
      merged,
      block: rendered,
      saved,
    } = await runConsolidation({
      home,
      prefs,
      taskCount: entries.length,
      target,
      runner: session.run,
      model: session.modelFor("consolidate"),
      timeoutMs,
      output: out,
      blockOutput: block,
      project: args.project,
      includeUnreviewed: args["include-unreviewed"],
    });
    guard.end();
    if (merged !== null && rendered !== null) {
      const { interrupted } = await offerCopyBlock({
        block: rendered,
        count: merged.length,
        target,
        yes: Boolean(args.yes),
        deps: { ...deps, output: out },
        output: out,
        blockOutput: block,
      });
      if (interrupted) return saved ? 130 : 1;
      write(
        hint(
          `${nextCommandText("suggest-subagents", { ...args, quality: session.quality })} --dry-run`,
          lineWidth(out),
        ),
      );
    }
    return merged === null || !saved ? 1 : 0;
  } finally {
    guard?.end();
    for (const line of session.summaryLines()) write(line);
    await session.finalize();
  }
}

/**
 * Result of a consolidation pass; `merged` is null when the runner call failed.
 * `block` is the exact rendered string that was written on success (so callers
 * can offer to copy the very same bytes), null on failure.
 */
export interface ConsolidationOutcome {
  merged: AggregatedPreference[] | null;
  block: string | null;
  saved: boolean;
}

/**
 * Extra timeout allowance per aggregated preference for the consolidation
 * call, mirroring the cluster stage's per-digest scaling: one call over the
 * whole set, so the flat default only fits small stores.
 */
export const CONSOLIDATE_TIMEOUT_PER_PREFERENCE_MS = 5_000;

/**
 * The one-call consolidation + rendering, extracted so callers can reuse it
 * (and wrap it with a copy offer). Runs the runner once in a spinner; on
 * failure emits the deterministic unconsolidated block and returns null, on
 * success renders the merged block. Teardown stays with the caller.
 */
export async function runConsolidation(opts: {
  home: string;
  prefs: AggregatedPreference[];
  taskCount: number;
  target: PreferencesTarget;
  runner: RunnerFn;
  model?: string;
  /** Per-call timeout (ms); default scales with the preference count. */
  timeoutMs?: number;
  /** Notes, progress, and errors. */
  output: Writable;
  /** The block itself; defaults to `output`. */
  blockOutput?: Writable;
  project?: string;
  includeUnreviewed?: boolean;
}): Promise<ConsolidationOutcome> {
  const { prefs, taskCount, target, runner, model, output } = opts;
  const write = (s = "") => output.write(`${s}\n`);
  const writeBlock = (s: string) => (opts.blockOutput ?? output).write(`${s}\n`);

  // Consolidation is one call over EVERY aggregated preference, so like the
  // cluster stage its wall-clock cost grows with input size; the flat per-call
  // default timed out on a real 80+ preference store (at exactly 300000ms,
  // twice). Scale the default with the preference count; an explicit
  // --timeout passes through unscaled.
  const timeoutMs =
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS + CONSOLIDATE_TIMEOUT_PER_PREFERENCE_MS * prefs.length;

  let consolidated: Consolidated;
  let resolved: ResolvedCall | undefined;
  try {
    const basePrompt = buildConsolidatePrompt(prefs);
    let prompt = basePrompt;
    let result: Consolidated | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await withSpinner(
        output,
        `consolidating ${counted(prefs.length, "preference")}`,
        () =>
          runner({
            prompt,
            schema: ConsolidateSchema,
            model,
            timeoutMs,
            onResolved: (call) => {
              resolved = call;
            },
          }),
      );
      const parsed = ConsolidateSchema.safeParse(response);
      const problems = parsed.success
        ? validateConsolidation(prefs, parsed.data)
        : [parsed.error.message];
      if (!problems.length && parsed.success) {
        result = parsed.data;
        break;
      }
      if (attempt === 1)
        throw new Error(`Consolidation failed source coverage validation: ${problems.join("; ")}`);
      prompt = `${basePrompt}\n\nThe previous result failed validation:\n${problems.map((p) => `- ${p}`).join("\n")}\nReturn a corrected complete mapping.`;
    }
    if (!result) throw new Error("Consolidation returned no validated result");
    consolidated = result;
  } catch (err) {
    // Keep the deterministic block available when the provider or model fails.
    write(`consolidation failed: ${err instanceof Error ? err.message : String(err)}`);
    write(
      dim(
        "Printing the block without merging. To try another model, add --model to your preferences command.",
      ),
    );
    write();
    writeBlock(renderPreferencesBlock(prefs, taskCount, target));
    return { merged: null, block: null, saved: false };
  }

  const merged = materializeConsolidation(prefs, consolidated);
  const now = new Date();
  const block = renderPreferencesBlock(merged, taskCount, target, now);
  write();
  writeBlock(block);
  write();
  write(dim(`consolidated ${prefs.length} → ${counted(merged.length, "preference")}.`));
  try {
    const file = saveConsolidatedPreferences(opts.home, {
      source: prefs,
      consolidated,
      resolved,
      taskCount,
      target,
      markdown: block,
      now,
      project: opts.project,
      includeUnreviewed: opts.includeUnreviewed,
    });
    write(dim(`saved to ${file}. Refresh the browser view to see the result.`));
    return { merged, block, saved: true };
  } catch (err) {
    write(`Could not save consolidated preferences: ${err instanceof Error ? err.message : err}`);
    write("The block above is still available to copy.");
    return { merged, block, saved: false };
  }
}

/**
 * Resolve the preferences target: explicit `--target`, else infer from the
 * active source (kiro source ⇒ kiro steering; kirocrew source ⇒ the same
 * steering block, with a footer naming Kiro Crew; codex/opencode ⇒ AGENTS.md;
 * else claude). Exported for the distill cascade, which infers the target the
 * same way.
 */
export function resolveTarget(raw: string | undefined, sourceMode: SourceMode): PreferencesTarget {
  if (raw) {
    const v = raw.toLowerCase();
    if (v === "codex" || v === "opencode") return "agents";
    if (v === "claude" || v === "kiro" || v === "kirocrew" || v === "agents") return v;
    throw new Error(
      `unknown --target "${raw}" (expected claude, codex, kiro, kirocrew, opencode, or agents)`,
    );
  }
  return sourceMode === "kiro" || sourceMode === "kirocrew"
    ? sourceMode
    : sourceMode === "codex" || sourceMode === "opencode"
      ? "agents"
      : "claude";
}

/** Footer line for the kiro and kirocrew targets: one steering file reaches both. */
export const KIRO_CREW_STEERING_NOTE =
  "Kiro Crew agents load every file in ~/.kiro/steering/, so the same file reaches them.";

/**
 * Per-target paste instructions shown under the rendered block. The destination
 * filename is colored cyan (it is the actionable bit); the rest stays dim, so
 * these lines are pre-styled and written verbatim (no outer dim() at the call
 * site). A block that was just merged is not offered the merge again.
 */
function targetFooter(target: PreferencesTarget, merge?: string): string[] {
  const paste =
    target === "kiro" || target === "kirocrew"
      ? [
          dim("paste the block into ") +
            cyan("~/.kiro/steering/hindsight-preferences.md") +
            dim(" (global) or"),
          cyan(".kiro/steering/") + dim(" (workspace)."),
          dim(KIRO_CREW_STEERING_NOTE),
        ]
      : target === "agents"
        ? [
            dim("add the block to your ") +
              cyan("AGENTS.md") +
              dim(". Codex, Kiro, OpenCode, and other agent CLIs inherit it."),
          ]
        : [dim("paste the block into your ") + cyan("CLAUDE.md") + dim(".")];
  if (merge)
    paste.push(dim("To merge near-duplicates with one model call, run"), dim(`  ${merge}`));
  return paste;
}

/**
 * End-of-run clipboard offer, shared by both modes. Copies the exact rendered
 * `block` bytes. Offer policy mirrors distill: --yes copies without prompting;
 * otherwise prompt only when there is a stream to prompt on (injected input or
 * a real TTY); a pipe/CI without --yes skips the offer entirely. On a successful
 * copy the paste guidance follows the confirmation. Returns whether the block
 * was copied, so the plain path can still print its footer when no copy landed.
 */
export async function offerCopyBlock(opts: {
  block: string;
  count: number;
  target: PreferencesTarget;
  yes: boolean;
  deps: PreferencesDeps;
  output: Writable;
  /**
   * Where the block was written. When that is not a terminal (`preferences >
   * CLAUDE.md`), nothing is asked: the block already went where it was sent.
   */
  blockOutput?: Writable;
  /** Command that merges the printed block's inputs, when they are still unmerged. */
  merge?: string;
}): Promise<{ copied: boolean; interrupted?: boolean }> {
  const { block, count, target, yes, deps, output } = opts;
  const write = (s = "") => output.write(`${s}\n`);
  const canAsk = Boolean(deps.input) || canPrompt({ output: opts.blockOutput ?? output });

  let doCopy: boolean;
  if (yes) doCopy = true;
  else if (canAsk) {
    const answer = await askYesNoAnswer("Copy block to clipboard?", {
      input: deps.input,
      output: deps.output,
      host: deps.host,
      defaultYes: true, // empty input (plain enter) means yes
    });
    // Ctrl-C means one thing everywhere: one line, exit 130.
    if (answer === "interrupt") {
      write("Interrupted.");
      return { copied: false, interrupted: true };
    }
    doCopy = answer === "yes";
  } else return { copied: false }; // pipe/CI without --yes: no offer, output unchanged

  if (!doCopy) return { copied: false };

  const result = deps.clipboard
    ? await deps.clipboard(block)
    : await copyToClipboard(block, { output });
  if (result.terminalAttempted) {
    write(dim("Terminal clipboard request sent. The block above is available for manual copying."));
    return { copied: false };
  }
  if (!result.ok) {
    // best-effort: the block is still on screen, so keep the exit code and
    // point the user at manual selection.
    write(dim(`could not copy (${result.error}); select the block above manually.`));
    return { copied: false };
  }
  write(`  ${ok(`copied (${counted(count, "preference")}, via ${result.tool})`)}`);
  for (const line of targetFooter(target, opts.merge)) write(line);
  return { copied: true };
}

export default defineCommand({
  meta: {
    name: "preferences",
    description: "Aggregate recurring preferences into a CLAUDE.md / steering / AGENTS.md block",
  },
  args: {
    ...sharedArgs,
    project: {
      type: "string",
      description:
        "Include accepted instructions for this exact project, alongside global instructions",
    },
    "include-unreviewed": {
      type: "boolean",
      description:
        "Explicitly include unreviewed suggestions instead of only accepted instructions",
    },
    target: {
      type: "string",
      description:
        "Output target: claude (CLAUDE.md), codex/opencode/agents (AGENTS.md), or kiro/kirocrew (steering file, also loaded by Kiro Crew). Default: inferred from --source",
    },
    consolidate: {
      type: "boolean",
      description:
        "Merge near-duplicates with one model call through your CLI and save in the library (asks first)",
    },
    runner: {
      type: "string",
      description:
        "Which local CLI consolidates: claude, codex, kiro, opencode, or auto (default: auto)",
    },
    model: {
      type: "string",
      description: "Model for --consolidate, passed to the CLI's --model",
    },
    timeout: {
      type: "string",
      description:
        "Consolidation call timeout in seconds (default scales with the preference count)",
    },
    yes: { type: "boolean", description: "Approve the plan without asking (for scripting)" },
  },
  async run({ args }) {
    const code = await runPreferences(args);
    if (code !== 0) process.exitCode = code;
    if (code === 1 && readLibrary(resolvePaths(args).home).length === 0) {
      // Only the block belongs on stdout; the follow-up question goes with the notes.
      await offerNext("reflect", args, { hintPrinted: true, output: process.stderr });
    }
  },
});
