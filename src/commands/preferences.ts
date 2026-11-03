import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { defineCommand } from "citty";
import { askYesNo } from "../claude/consent.js";
import { DEFAULT_TIMEOUT_MS } from "../claude/runner.js";
import { type Consolidated, ConsolidateSchema } from "../claude/schemas.js";
import { resolveTimeoutMs } from "../core/budget.js";
import {
  materializeConsolidation,
  saveConsolidatedPreferences,
  validateConsolidation,
} from "../core/consolidated-preferences.js";
import { readLibrary } from "../core/library.js";
import { HISTORICAL_DATA_INSTRUCTION } from "../core/preference-evidence.js";
import { reviewedPreferences } from "../core/preference-review.js";
import {
  type AggregatedPreference,
  type PreferencesTarget,
  preferenceId,
  readObservedPreferences,
  renderPreferencesBlock,
} from "../core/preferences.js";
import type { RunnerFn } from "../distill/pipeline.js";
import { parseRunnerMode, resolveRunner } from "../runners/registry.js";
import type { AgentRunner } from "../runners/types.js";
import { parseSourceMode, type SourceMode } from "../sources/registry.js";
import { copyToClipboard } from "../ui/clipboard.js";
import { withSpinner } from "../ui/progress.js";
import { cyan, dim, green, hint, ok } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";
import { flowArgs, offerNext } from "./next.js";

/** Injectable dependencies (testing). */
export interface PreferencesDeps {
  runner?: RunnerFn;
  input?: Readable;
  output?: Writable;
  /**
   * Clipboard sink; injectable so tests never touch a real clipboard. Shape
   * matches copyToClipboard's return (tool is reported even on failure).
   */
  clipboard?: (text: string) => Promise<{ ok: boolean; tool: string; error?: string }>;
}

export const CONSOLIDATE_PROMPT_VERSION = 2;

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
    project?: string;
    "include-unreviewed"?: boolean;
  },
  deps: PreferencesDeps = {},
): Promise<number> {
  args = flowArgs(args);
  const out = deps.output ?? process.stdout;
  const write = (s = "") => out.write(`${s}\n`);
  const target = resolveTarget(args.target, parseSourceMode(args.source));

  const { home } = resolvePaths(args);
  const observed = await withSpinner(out, "Reading preference evidence", async () =>
    readObservedPreferences(home),
  );
  const entries = readLibrary(home);
  if (entries.length === 0 && observed.length === 0) {
    write("library is empty — nothing distilled yet.");
    write(hint("human-hindsight distill"));
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
    write(
      observed.length
        ? "No accepted preferences for this scope. Review suggestions in the GUI first."
        : "no preferences were observed across the library.",
    );
    if (observed.length) write(hint("human-hindsight gui"));
    return 0;
  }
  if (args["include-unreviewed"]) {
    write("Including unreviewed suggestions by explicit request; check their scope and evidence.");
  }

  const recurring = prefs.filter((p) => p.count > 1).length;
  write(
    green(`${prefs.length} preference(s) across ${entries.length} task(s)`) +
      (recurring ? cyan(` (${recurring} recur)`) : ""),
  );
  write();

  if (!args.consolidate) {
    const block = renderPreferencesBlock(prefs, entries.length, target);
    write(block);
    write();
    // Offer the copy first; on a successful copy the guidance prints after the
    // confirmation. When no copy happens (declined, failure, or pipe/CI), fall
    // back to the footer in its original position so guidance prints exactly
    // once either way.
    const { copied } = await offerCopyBlock({
      block,
      count: prefs.length,
      target,
      yes: Boolean(args.yes),
      deps,
      output: out,
    });
    if (!copied) for (const line of targetFooter(target)) write(line);
    return 0;
  }

  // --consolidate: one runner call, behind the same consent gate as distill.
  // Route through resolveRunner so a kiro-only machine works (and the copy names
  // whichever CLI will actually run); an explicit --runner with a missing
  // binary fails HERE, before the consent prompt. An injected deps.runner
  // (tests) bypasses it.
  const sourceMode = parseSourceMode(args.source);
  let resolved: AgentRunner | null = null;
  if (!deps.runner) {
    try {
      resolved = await resolveRunner(parseRunnerMode(args.runner), {
        preferSource: sourceMode === "auto" ? undefined : sourceMode,
        scratchBase: path.join(home, "runner-scratch"),
      });
      await resolved.preflight?.();
    } catch (err) {
      write((err as Error).message);
      return 1;
    }
  }
  const cli = resolved?.name === "kiro" ? "kiro-cli" : (resolved?.name ?? "claude");
  const cost = resolved?.name === "kiro" ? "your Kiro credits" : "your subscription/credits";
  write(
    `consolidate will invoke your local \`${cli}\` CLI (${cost}; one call plus bounded validation retries).`,
  );
  const confirmed =
    Boolean(args.yes) || (await askYesNo("Proceed?", { input: deps.input, output: deps.output }));
  if (!confirmed) {
    write("declined; nothing was invoked.");
    return 2;
  }

  const runner: RunnerFn = deps.runner ?? (resolved as NonNullable<typeof resolved>).run;
  const { merged, block, saved } = await runConsolidation({
    home,
    prefs,
    taskCount: entries.length,
    target,
    runner,
    model: args.model,
    timeoutMs: resolveTimeoutMs(args.timeout),
    output: out,
    project: args.project,
    includeUnreviewed: args["include-unreviewed"],
  });
  // Offer to copy the merged block (only on success; the failure path already
  // fell back to the deterministic block and returns 1 unchanged).
  if (merged !== null && block !== null) {
    await offerCopyBlock({
      block,
      count: merged.length,
      target,
      yes: Boolean(args.yes),
      deps,
      output: out,
    });
  }
  // Once-per-run teardown (kiro: delete this run's auto-saved session). Called
  // in both paths; finalize is idempotent-once-per-run and emits no output, so
  // moving it past the rendering keeps the byte stream identical.
  await resolved?.finalize?.();
  return merged === null || !saved ? 1 : 0;
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
  output: Writable;
  project?: string;
  includeUnreviewed?: boolean;
}): Promise<ConsolidationOutcome> {
  const { prefs, taskCount, target, runner, model, output } = opts;
  const write = (s = "") => output.write(`${s}\n`);

  // Consolidation is one call over EVERY aggregated preference, so like the
  // cluster stage its wall-clock cost grows with input size; the flat per-call
  // default timed out on a real 80+ preference store (at exactly 300000ms,
  // twice). Scale the default with the preference count; an explicit
  // --timeout passes through unscaled.
  const timeoutMs =
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS + CONSOLIDATE_TIMEOUT_PER_PREFERENCE_MS * prefs.length;

  let consolidated: Consolidated;
  try {
    const basePrompt = buildConsolidatePrompt(prefs);
    let prompt = basePrompt;
    let result: Consolidated | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await withSpinner(
        output,
        `consolidating ${prefs.length} preference(s)`,
        () => runner({ prompt, schema: ConsolidateSchema, model, timeoutMs }),
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
    // Real-world case: the account's default model can be rejected by policy
    // (e.g. Bedrock data-retention 400s) — fail with the reason, not a stack,
    // and still emit the deterministic block so the run yields a usable artifact.
    write(`consolidation failed: ${err instanceof Error ? err.message : String(err)}`);
    write(dim("falling back to the unconsolidated block; retry with --model <model>."));
    write();
    write(renderPreferencesBlock(prefs, taskCount, target));
    return { merged: null, block: null, saved: false };
  }

  const merged = materializeConsolidation(prefs, consolidated);
  const now = new Date();
  const block = renderPreferencesBlock(merged, taskCount, target, now);
  write();
  write(block);
  write();
  write(dim(`consolidated ${prefs.length} → ${merged.length} preference(s).`));
  try {
    const file = saveConsolidatedPreferences(opts.home, {
      source: prefs,
      consolidated,
      taskCount,
      target,
      markdown: block,
      now,
      project: opts.project,
      includeUnreviewed: opts.includeUnreviewed,
    });
    write(dim(`saved to ${file} — available in the GUI after Refresh.`));
    return { merged, block, saved: true };
  } catch (err) {
    write(`Could not save consolidated preferences: ${err instanceof Error ? err.message : err}`);
    write("The block above is still available to copy.");
    return { merged, block, saved: false };
  }
}

/**
 * Resolve the preferences target: explicit `--target`, else infer from the
 * active source (kiro source ⇒ kiro steering; else claude). Exported for the
 * distill cascade, which infers the target the same way.
 */
export function resolveTarget(raw: string | undefined, sourceMode: SourceMode): PreferencesTarget {
  if (raw) {
    const v = raw.toLowerCase();
    if (v === "codex" || v === "opencode") return "agents";
    if (v === "claude" || v === "kiro" || v === "agents") return v;
    throw new Error(
      `unknown --target "${raw}" (expected claude, codex, kiro, opencode, or agents)`,
    );
  }
  return sourceMode === "kiro"
    ? "kiro"
    : sourceMode === "codex" || sourceMode === "opencode"
      ? "agents"
      : "claude";
}

/**
 * Per-target paste instructions shown under the rendered block. The destination
 * filename is colored cyan (it is the actionable bit); the rest stays dim, so
 * these lines are pre-styled and written verbatim (no outer dim() at the call
 * site).
 */
function targetFooter(target: PreferencesTarget): string[] {
  switch (target) {
    case "kiro":
      return [
        dim("paste the block into ") +
          cyan("~/.kiro/steering/hindsight-preferences.md") +
          dim(" (global) or"),
        cyan(".kiro/steering/") +
          dim(" (workspace) — or run with --consolidate to merge near-duplicates."),
      ];
    case "agents":
      return [
        dim("add the block to your ") +
          cyan("AGENTS.md") +
          dim(" — Codex, Kiro, OpenCode, and other agent CLIs auto-inherit it."),
        dim("or run with --consolidate to merge near-duplicates with one runner call."),
      ];
    default:
      return [
        dim("paste the block into your ") + cyan("CLAUDE.md") + dim(" — or run with --consolidate"),
        dim("to merge near-duplicates with one runner call."),
      ];
  }
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
}): Promise<{ copied: boolean }> {
  const { block, count, target, yes, deps, output } = opts;
  const write = (s = "") => output.write(`${s}\n`);
  const canPrompt = Boolean(deps.input) || process.stdin.isTTY === true;

  let doCopy: boolean;
  if (yes) doCopy = true;
  else if (canPrompt)
    doCopy = await askYesNo("Copy block to clipboard?", {
      input: deps.input,
      output: deps.output,
      defaultYes: true, // empty input (plain enter) means yes
    });
  else return { copied: false }; // pipe/CI without --yes: no offer, output unchanged

  if (!doCopy) return { copied: false };

  const copy = deps.clipboard ?? copyToClipboard;
  const result = await copy(block);
  if (!result.ok) {
    // best-effort: the block is still on screen, so keep the exit code and
    // point the user at manual selection.
    write(dim(`could not copy (${result.error}); select the block above manually.`));
    return { copied: false };
  }
  write(`  ${ok(`copied (${count} preference(s), via ${result.tool})`)}`);
  for (const line of targetFooter(target)) write(line);
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
        "Output target: claude (CLAUDE.md), codex/opencode/agents (AGENTS.md), or kiro (steering file). Default: inferred from --source",
    },
    consolidate: {
      type: "boolean",
      description:
        "Merge semantic duplicates with one runner call and save in the library (consent-gated)",
    },
    runner: {
      type: "string",
      description:
        "Which local CLI consolidates: claude, codex, kiro, opencode, or auto (default: auto)",
    },
    model: {
      type: "string",
      description: "Model to pass through to the runner's --model for --consolidate",
    },
    timeout: {
      type: "string",
      description:
        "Consolidation call timeout in seconds (default scales with the preference count)",
    },
    yes: { type: "boolean", description: "Skip the consent prompt (for scripting)" },
  },
  async run({ args }) {
    const code = await runPreferences(args);
    if (code !== 0) process.exitCode = code;
    if (code === 1 && readLibrary(resolvePaths(args).home).length === 0) {
      await offerNext("distill", args, { hintPrinted: true });
    }
  },
});
