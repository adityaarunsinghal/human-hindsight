/**
 * core/budget.ts, input budgeting & overflow policy.
 *
 * Session content is inlined into distill prompts verbatim, bounded by a
 * budget derived from real model capacity, and an explicit overflow policy
 * guarantees nothing is EVER cut silently:
 *
 *   - The budget defaults to ~400k chars (~100k tokens at ~4 chars/token, ample
 *     headroom under a 200k-token context) and is overridable with
 *     `--input-budget`.
 *   - When a unit (a session's content, or a task's aggregate member content)
 *     exceeds the budget, the `--truncate` policy decides:
 *       · "never" (default), BLOCK the unit; it is reported and skipped, never
 *         cut. No silent data loss; the user is told and can raise the budget,
 *         narrow scope, or opt into cutting.
 *       · "extreme", middle-cut the unit to the budget (head+tail kept), and
 *         record the exact cut for disclosure (consent plan, `sources.json`
 *         provenance, `show` coverage badge).
 *
 * Lossless chunking, splitting oversized work into MORE calls rather than
 * cutting, is a roadmap item; until it lands, "never" is the honest default
 * and "extreme" is the disclosed escape hatch.
 *
 * Pure module: no filesystem, no model, every decision is a function of character
 * counts and flags, so the whole plan is deterministic and unit-testable.
 */

import { checkedValue, oneOf, wholeNumber, wholeOption } from "./value-rule.js";

/** Default input budget in characters (~100k tokens with headroom). */
export const DEFAULT_INPUT_BUDGET = 400_000;

/** Maximum simultaneous calls when the command does not set a worker count. */
export const DEFAULT_CONCURRENCY = 10;

/** Keep short sessions whole and divide the remaining characters among longer ones. */
export function allocateMemberBudgets(lengths: number[], budget: number): number[] {
  const allocations = Array<number>(lengths.length).fill(0);
  const shortestFirst = lengths
    .map((length, index) => ({ length, index }))
    .sort((a, b) => a.length - b.length || a.index - b.index);
  let remaining = Math.max(0, Math.floor(budget));
  for (const [position, member] of shortestFirst.entries()) {
    const share = Math.floor(remaining / (lengths.length - position));
    const allocation = Math.min(share, member.length);
    allocations[member.index] = allocation;
    remaining -= allocation;
  }
  return allocations;
}

/** Floor for `--input-budget`; a smaller value is an error. */
export const MIN_INPUT_BUDGET = 1_000;

/** How to handle a unit that exceeds the budget. */
export type TruncatePolicy = "never" | "extreme";

export const INPUT_BUDGET_RULE = wholeNumber(
  MIN_INPUT_BUDGET,
  `a whole number of characters, ${MIN_INPUT_BUDGET} or more`,
);
export const TIMEOUT_RULE = wholeNumber(1, "a whole number of seconds, 1 or more");
export const TRUNCATE_RULE = oneOf(["never", "extreme"]);

/** Resolve `--input-budget` (chars), the default when absent. A wrong value throws its one line. */
export function resolveInputBudget(raw: string | undefined): number {
  return wholeOption(INPUT_BUDGET_RULE, "input-budget", raw, DEFAULT_INPUT_BUDGET);
}

/** Resolve `--truncate`: "never" when absent. A wrong value throws its one line. */
export function resolveTruncatePolicy(raw: string | undefined): TruncatePolicy {
  if (raw === undefined) return "never";
  return checkedValue(TRUNCATE_RULE, "truncate", raw) as TruncatePolicy;
}

/** Resolve `--timeout` (seconds) to milliseconds; absent is undefined (the runner default). A wrong value throws. */
export function resolveTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  return wholeOption(TIMEOUT_RULE, "timeout", raw, 0) * 1_000;
}

/** The inline truncation note (also seen by the model). Kept stable for tests. */
function truncationNote(dropped: number): string {
  return `\n\n[... human-hindsight truncated ${dropped} characters from the middle of this session ...]\n\n`;
}

/**
 * Middle-cut `content` to at most `budget` characters, keeping the head and the
 * tail (goal at the start, resolution at the end) with a truncation note in
 * between whose stated dropped-count is EXACT (fixed-point settled, the note's
 * length varies with the count's digits). Returns the cut text and the exact
 * number of characters dropped (0 when it already fits).
 */
export function middleCut(content: string, budget: number): { text: string; dropped: number } {
  if (content.length <= budget) return { text: content, dropped: 0 };

  // Settle `keep` (kept content chars) so `note(dropped)` reports the truth.
  let keep = budget - truncationNote(content.length - budget).length;
  for (let i = 0; i < 5; i++) {
    const settled = budget - truncationNote(content.length - keep).length;
    if (settled === keep) break;
    keep = settled;
  }

  // Degenerate: budget smaller than the note. Return a bounded note only.
  if (keep <= 0) {
    return { text: truncationNote(content.length).slice(0, budget), dropped: content.length };
  }

  const dropped = content.length - keep;
  const marker = truncationNote(dropped);
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return { text: content.slice(0, head) + marker + content.slice(content.length - tail), dropped };
}
