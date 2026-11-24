/**
 * core/outcome.ts: the bounded outcome-evidence pass.
 *
 * Without any signal of whether a session succeeded, failed, or was abandoned,
 * the distill stages would confidently author "ideal" prompts that reproduce
 * failure paths. This deterministic pass captures a SMALL, clearly-labeled slice
 * of outcome evidence per session for the digest stage to classify:
 *
 *   - final_human_turns:    the last {@link FINAL_TURNS} deduped human turns,
 *                           most recent LAST (what the human ended up asking for);
 *   - final_assistant_tail: the ~{@link TAIL_CHARS}-char tail of the LAST
 *                           assistant text turn in the file ("" if none);
 *   - human_spoke_last:     whether the person wrote anything after that
 *                           assistant turn (absent when the timeline has
 *                           neither kind of turn).
 *
 * This is distill INPUT ONLY: the human-only export artifact is unaffected. The
 * assistant text is machine-authored and is never copied into a oneshot; the
 * `_note` written alongside the data (see the export command) states this.
 */

import type { TimelineEvent } from "../sources/types.js";
import { TAIL_CHARS } from "./anaphora.js";
import type { CorpusSession } from "./dedupe.js";

// TAIL_CHARS originates with the anaphora tail bound; re-export it so outcome
// tests can import the single source of truth from here too.
export { TAIL_CHARS };

/** How many trailing human turns to capture as outcome evidence. */
export const FINAL_TURNS = 3;

/**
 * A top-level `_note` for `outcomes.json` labeling the assistant text as
 * machine-authored context; it is never surfaced in an export or a
 * oneshot, only fed to the outcome-classification stage of distill.
 */
export const OUTCOME_NOTE =
  "final_assistant_tail is machine-authored assistant text, captured as bounded " +
  "outcome evidence for distillation only; it is never copied into an export or a oneshot.";

/** Bounded, labeled outcome evidence for one session (written to outcomes.json). */
export interface OutcomeEvidence {
  /** Last {@link FINAL_TURNS} deduped human turns, chronological (most recent last). */
  final_human_turns: string[];
  /** Tail of the last assistant text turn in the file; "" when there is none. */
  final_assistant_tail: string;
  /** Tool-recorded execution result, independent of the assistant's claims. */
  final_execution_status?: string;
  /**
   * True when the person wrote something after the assistant's last text
   * turn (or when the timeline has human turns and no assistant text turn);
   * false when the assistant's turn came last. Absent when the timeline has
   * neither, and in files written before this field existed.
   */
  human_spoke_last?: boolean;
}

/**
 * Whether a group of sessions can get a prompt, judged from each member's
 * outcome label (`undefined` for a member with no digest, which counts as
 * `unclear`: no ending was captured):
 * - `verified`: at least one member is `completed` or `partial`;
 * - `unverified`: none is, but at least one is `unclear` or has no label; the
 *   prompt is written and marked "outcome not verified";
 * - `abandoned`: every member was abandoned (or there are none); no prompt.
 */
export type GroupOutcome = "verified" | "unverified" | "abandoned";

export function groupOutcome(outcomes: readonly (string | undefined)[]): GroupOutcome {
  if (outcomes.some((outcome) => outcome === "completed" || outcome === "partial"))
    return "verified";
  if (outcomes.some((outcome) => outcome !== "abandoned")) return "unverified";
  return "abandoned";
}

/**
 * Capture bounded outcome evidence for ONE deduped session.
 *
 * `final_human_turns` come from the session's post-dedupe survivors (so they are
 * exactly what the export shows); `final_assistant_tail` is recovered from the
 * session `timeline` (assistant text is not part of the export corpus). Both are
 * bounded: at most {@link FINAL_TURNS} human turns and {@link TAIL_CHARS} chars.
 */
export function buildOutcome(session: CorpusSession, timeline: TimelineEvent[]): OutcomeEvidence {
  const final_human_turns = session.messages.slice(-FINAL_TURNS).map((message) => message.text);

  let final_assistant_tail = "";
  let lastAssistant = -1;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const event = timeline[i];
    if (event?.kind === "assistant") {
      final_assistant_tail =
        event.text.length > TAIL_CHARS ? event.text.slice(-TAIL_CHARS) : event.text;
      lastAssistant = i;
      break;
    }
  }
  // Which came last: the person's words or the assistant's closing message.
  // Only a human turn with text counts as the person writing something.
  const lastHuman = timeline.findLastIndex(
    (event) => event.kind === "human" && event.text.trim() !== "",
  );

  // A later human prompt starts another attempt; an earlier idle marker must
  // not label that new attempt as completed.
  let final_execution_status: string | undefined;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const event = timeline[i];
    if (event?.kind === "human" || event?.kind === "boundary") break;
    if (event?.kind === "status") {
      final_execution_status = event.text.slice(0, TAIL_CHARS);
      break;
    }
  }
  return {
    final_human_turns,
    final_assistant_tail,
    ...(final_execution_status ? { final_execution_status } : {}),
    ...(lastHuman >= 0 || lastAssistant >= 0
      ? { human_spoke_last: lastHuman > lastAssistant }
      : {}),
  };
}
