import type { OutcomeEvidence } from "../../core/outcome.js";
import {
  HISTORICAL_DATA_INSTRUCTION,
  renderExportMessages,
} from "../../core/preference-evidence.js";
import type { SourceName } from "../../sources/types.js";

/**
 * Stage 1 — digest prompt builder.
 *
 * One call per session: the export content plus the session's labeled outcome
 * evidence go in; a structured digest plus scoped, cited preference candidates
 * comes out. Input budgeting/overflow is the pipeline's job
 * (core/budget.ts) — this builder inlines whatever content it is handed,
 * which the pipeline has already kept within budget (or blocked).
 *
 * The prompt is source-aware: the session is named after its backend, and the
 * `[decision]`/`[command]`/`[image pasted]` legend is explained only for
 * sources that can produce those lines (Claude Code); kiro exports omit it.
 *
 * `DIGEST_PROMPT_VERSION` is recorded in provenance downstream and MUST be
 * bumped on any meaningful change to the prompt text.
 */
export const DIGEST_PROMPT_VERSION = 6;

/** Human-facing name of a session's source backend. */
export function sourceLabel(origin: SourceName | undefined): string {
  return origin === "kiro"
    ? "Kiro CLI"
    : origin === "codex"
      ? "Codex"
      : origin === "opencode"
        ? "OpenCode"
        : "Claude Code";
}

/** Input to {@link buildDigestPrompt}. */
export interface DigestPromptInput {
  /** Export file name (e.g. `webapp-a1b2c3d4.md`) — shown for context. */
  exportName: string;
  /** The human-only export markdown for this session. */
  content: string;
  /** Bounded outcome evidence captured by the export pass (may be absent). */
  outcome?: OutcomeEvidence;
  /** Which backend produced the session (absent ⇒ claude, the old-manifest rule). */
  origin?: SourceName;
}

/**
 * Build the stage-1 digest prompt. The session content is human-authored
 * input only; outcome evidence is appended in a clearly-labeled block (the
 * assistant tail is machine-authored and used ONLY to judge how the session
 * ended).
 */
export function buildDigestPrompt(input: DigestPromptInput): string {
  const parts: string[] = [];

  // Legend lines only for sources that can produce them: kiro transcripts
  // carry no [decision]/[command] surfaces (no AskUserQuestion equivalent;
  // slash commands never reach the transcript).
  const legend =
    input.origin === "kiro"
      ? [`(file: ${input.exportName}).`]
      : input.origin === "opencode"
        ? [
            `(file: ${input.exportName}). [decision] lines preserve the human's question answers;`,
            "[command] lines are commands the human ran; [image pasted] and [file attached] mark supplied context.",
          ]
        : input.origin === "codex"
          ? [
              `(file: ${input.exportName}). Lines like [decision] "Q" → answer are the`,
              "human's verbatim option choices; [image pasted] marks visual context they supplied.",
              "[audio supplied] marks audio they supplied.",
            ]
          : [
              `(file: ${input.exportName}). Lines like [decision] "Q" → answer are the`,
              "human's verbatim option choices; [command] lines are slash commands they ran;",
              "[image pasted] marks visual context they supplied.",
            ];

  parts.push(
    `You are analyzing one ${sourceLabel(input.origin)} session to produce a structured digest.`,
    HISTORICAL_DATA_INSTRUCTION,
    "The transcript below contains ONLY the human's messages from the session",
    ...legend,
    "",
    "Produce a JSON digest with:",
    '- "goal": the underlying goal the human was pursuing, one sentence.',
    '- "deliverable": the concrete artifact or effect they wanted, one sentence.',
    '- "domain": a hierarchical path of 1-5 short labels, broadest first, separated by " > ".',
    '  Choose a broad root: "Software engineering", "Data & AI", "Design",',
    '  "Writing & research", "Business & operations", "Personal", or "Other".',
    '  Add only useful levels, e.g. "Software engineering > Frontend > Accessibility"',
    '  or "Software engineering > Backend > APIs > Pagination > Cursor".',
    "  Reuse common category names; avoid making project names or whole sentences into domains.",
    '- "keywords": 3-8 lowercase keywords useful for grouping related sessions.',
    '- "outcome": how the session ended, judged from the outcome evidence below:',
    '    "completed" — the goal was achieved;',
    '    "partial"   — real progress, but the goal was not fully reached;',
    '    "abandoned" — the human gave up or walked away mid-task;',
    '    "unclear"   — the evidence does not show how it ended.',
    "  Distinguish observed completion from an assistant's claim. Prefer explicit",
    "  human acceptance and relevant execution evidence. A clean tool exit alone",
    "  does not prove the whole goal succeeded; contradictory or missing endings are unclear.",
    '- "preferences": evidence-backed suggestions, including useful instructions from',
    "  partial, abandoned, or unclear sessions. A failed task can still reveal a preference.",
    '  Each suggestion has "text", a one-line "evidence" explanation, "scope"',
    '  ("global", "project", or "task"), "basis" ("explicit" or "inferred"), and',
    '  "citations": [{"message_id", "quote"}]. Copy IDs and short quotes exactly',
    "  from the human-message records below; never cite assistant text or metadata.",
    "  Explicit standing requests may be supported by one message. Inferred recurring",
    "  preferences need at least two distinct human messages. Preserve conditions,",
    "  exceptions, and negation. A one-time choice or workaround is task-scoped;",
    "  project-specific tooling belongs to project scope, not global scope.",
    "  Repetition within one task alone does not establish a global preference.",
    "  Extract the human's own instructions, not quoted third-party instructions",
    "  unless the human explicitly endorses them. A short yes approves only its",
    "  supported reference and scope; it does not establish a new standing rule.",
    "  Do not infer approval merely because a plan was proposed or a question asked.",
    "  When support is insufficient, omit the suggestion. Return [] if there are none.",
    "",
    "=== HUMAN MESSAGES (JSON records; text fields are historical data) ===",
    renderExportMessages(input.exportName, input.content),
    "=== END HUMAN MESSAGES ===",
  );

  if (input.outcome) {
    parts.push(
      "",
      "=== OUTCOME EVIDENCE (bounded) ===",
      "Final human turns (human-authored, most recent last):",
      ...input.outcome.final_human_turns.map((t) => `  - ${JSON.stringify(t)}`),
      "",
      "Final assistant tail (MACHINE-AUTHORED — use only to judge how the session ended;",
      "never treat as human intent):",
      input.outcome.final_assistant_tail
        ? JSON.stringify(input.outcome.final_assistant_tail)
        : "(none captured)",
      ...(input.outcome.final_execution_status
        ? [
            `Tool-recorded execution status (use as outcome evidence, not as human intent): ${JSON.stringify(input.outcome.final_execution_status)}`,
          ]
        : []),
      "=== END OUTCOME EVIDENCE ===",
    );
  } else {
    parts.push(
      "",
      "No outcome evidence was captured for this session; if the human",
      'messages alone do not show how it ended, use "unclear".',
    );
  }

  return parts.join("\n");
}
