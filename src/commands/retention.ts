import type { Readable, Writable } from "node:stream";
import { defineCommand } from "citty";
import { applyRetentionPlan, checkRetentionPlan, planRetention } from "../core/retention.js";
import { askYesNoAnswer } from "../distill/consent.js";
import { parseSourceMode } from "../sources/registry.js";
import type { TerminalHost } from "../ui/live.js";
import { resolvePaths, sharedArgs } from "./_shared.js";
import { nextCommandText } from "./next.js";

export interface RetentionArgs {
  home?: string;
  "claude-dir"?: string;
  "codex-dir"?: string;
  "kiro-dir"?: string;
  "kirocrew-dir"?: string;
  "opencode-dir"?: string;
  "opencode-db"?: string;
  source?: string;
  apply?: boolean;
  "dry-run"?: boolean;
  yes?: boolean;
}

/** Always previews first. Only --apply plus confirmation (or --yes) writes. */
export async function runRetention(
  args: RetentionArgs,
  deps: { input?: Readable; output?: Writable; host?: TerminalHost } = {},
): Promise<number> {
  const out = deps.output ?? process.stdout;
  const write = (text = "") => out.write(`${text}\n`);
  const mode = parseSourceMode(args.source);
  const plans = planRetention(mode, resolvePaths(args));
  write("Local data retention (optional)");
  if (!plans.length) {
    write(
      "No tool directories found. Select --source claude|codex|kiro|kirocrew|opencode or set a tool directory.",
    );
    return 0;
  }
  for (const plan of plans) {
    write();
    write(`${plan.tool}${plan.file ? ` (${plan.file})` : ""}`);
    if (plan.error) write(`  ${plan.error}`);
    else if (plan.changes.length) for (const change of plan.changes) write(`  ${change}`);
    else if (plan.file) write("  Already configured for long retention.");
    for (const note of plan.notes) write(`  ${note}`);
  }
  write();
  write("Longer retention keeps prompt contents on disk longer and can use more disk space.");
  write(
    "Project settings, profiles, managed policy, or startup flags may override these defaults.",
  );
  if (plans.some((p) => p.error)) {
    write("No changes applied. Fix the configuration errors above and preview again.");
    write(`  ${nextCommandText("retention", args)}`);
    return 1;
  }
  const changed = plans.filter((p) => p.changes.length > 0);
  if (!args.apply || args["dry-run"]) {
    write("Preview only. To apply these settings, run");
    write(`  ${nextCommandText("retention", args)} --apply`);
    write("Add --yes to confirm in a script.");
    return 0;
  }
  if (changed.length === 0) {
    write("No changes needed.");
    return 0;
  }
  if (!args.yes && !deps.input && process.stdin.isTTY !== true) {
    write("No changes applied. To confirm without an interactive prompt, run");
    write(`  ${nextCommandText("retention", args)} --apply --yes`);
    return 2;
  }
  if (!args.yes) {
    const answer = await askYesNoAnswer(
      "Apply these retention settings and back up existing files?",
      { input: deps.input, output: out, host: deps.host },
    );
    // Ctrl-C means one thing everywhere: one line, exit 130.
    if (answer === "interrupt") {
      write("Interrupted; no changes applied.");
      return 130;
    }
    if (answer !== "yes") {
      write("Declined; no changes applied.");
      return 2;
    }
  }
  try {
    for (const plan of changed) checkRetentionPlan(plan); // preflight the whole selection
    for (const plan of changed) {
      const backup = applyRetentionPlan(plan);
      write(`Updated ${plan.file}${backup ? `; backup: ${backup}` : " (new file)"}`);
    }
  } catch (err) {
    write(
      `Could not finish applying retention settings: ${err instanceof Error ? err.message : "I/O error"}`,
    );
    write("To preview the current settings, run");
    write(`  ${nextCommandText("retention", args)}`);
    return 1;
  }
  write(
    "Retention settings saved. Restart running tools to pick them up; deleted history cannot be recovered.",
  );
  return 0;
}

export default defineCommand({
  meta: {
    name: "retention",
  },
  args: {
    ...sharedArgs,
    apply: { type: "boolean", description: "Apply the previewed settings after confirmation" },
    "dry-run": { type: "boolean", description: "Preview only, even when --apply is present" },
    yes: { type: "boolean", description: "With --apply, opt in without a confirmation prompt" },
  },
  async run({ args }) {
    const code = await runRetention(args);
    if (code !== 0) process.exitCode = code;
  },
});
