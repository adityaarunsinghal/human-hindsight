import { isRecord, snippet } from "../read.js";
import type { Drop, ExtractedMessage, ExtractResult, TimelineEvent } from "../types.js";
import type { KiroSessionMeta } from "./discover.js";
import {
  harnessEnvelope,
  isHindsightDistillPrompt,
  KIRO_AUTOMATION_FIRST_LINES,
  KIRO_HARNESS_NUDGES,
} from "./extract.js";

/**
 * sources/kiro/extract-v3.ts: the kiro-cli v3 ("Sol" harness) extractor.
 *
 * v3's `messages.jsonl` is one `{id, timestamp, payload}` JSON object per line;
 * `payload.type` discriminates. Only `user` entries carry the human's verbatim
 * text; `assistant` entries are the machine side (`operationType` "Say" is spoken
 * dialogue, "Reasoning" is internal thinking). Everything else (`tool_call`,
 * `tool_result`, `turn_start`/`turn_end`, `usage_summary`, `session_metadata`,
 * `session_event`, `session_start`, `steering_inclusion`, `sub_agent_*`) is
 * machine bookkeeping.
 *
 * Contrast the v2 extractor (extract.ts): v2 lines are `{version, kind, data}`
 * with `Prompt`/`AssistantMessage`/`ToolResults`, unix-seconds timestamps, and
 * `Prompt.data.content[]` text blocks. v3 is simpler: `user.content` is a
 * single string and the timestamp is ISO-8601 in-band. The harness still opens
 * some `user` turns with its own envelope, though: a message typed mid-run
 * arrives as `[LIVE STEERING - New message from user]` around a
 * `<user_message>` body, and a finished subagent reports back as
 * `[Subagent completion event]`. Those get the v2 treatment (V4 below).
 *
 * As everywhere, parsing is tolerant: unknown `payload.type`s and fields are
 * ignored, and a corrupt line is counted in `badLines` rather than aborting.
 * The session-level human-vs-automation gate is {@link classifyKiroV3Session}.
 *
 * Rules in this module:
 *
 *   V3   an empty `user` body is an observable Drop;
 *   V4   a harness envelope on a `user` entry is read like K14/K6 in the v2
 *        store: a live-steering envelope keeps only the person's
 *        `<user_message>` body, and a subagent completion event (or another
 *        bracket marker or harness nudge) is dropped with a record. Extraction
 *        and timeline share {@link humanTextV3}, so they agree. K15 reads the
 *        raw content, not this text, so its verdicts are unchanged;
 *   K13  the distill sentinel excludes the session (shared with extract.ts);
 *   K15  a Kiro Crew run is excluded and handed to the Kiro Crew store.
 *
 * Why K15 exists. Kiro Crew runs kiro-cli underneath, so every Crew chat,
 * subagent and cron is also written here as a v3 session. In those copies
 * `user.content` is the whole prompt Crew assembled (memory, lessons, runtime
 * blocks), and the person's words sit buried between the line
 * `[CURRENT USER REQUEST -- respond to this]` and `<EnvironmentContext>`. Kept
 * as human sessions they would put injected context into the corpus, and a
 * distill would mine it back out as the person's preferences. The Kiro Crew
 * store (`--source kirocrew`) holds the clean human side of the same runs, so
 * these copies are excluded rather than unwrapped. The count is reported by
 * `export` and `status`, so nothing disappears silently.
 *
 * K15 applies under an explicit `--source kiro` too. The kiro corpus must never
 * contain injected context whichever sources are active; the summary line is
 * what tells the person where those runs went.
 */

/** The payload of one v3 line, or undefined when the line is not a v3 record. */
function payloadOf(parsed: unknown): Record<string, unknown> | undefined {
  if (!isRecord(parsed)) return undefined;
  const p = parsed.payload;
  return isRecord(p) ? p : undefined;
}

/**
 * Detect whether a session's lines are the v3 store format. A v3 line is a
 * record with a `payload` object; a v2 line has top-level `kind`/`data` and no
 * `payload`. Decided on the FIRST parseable line (the stores never interleave),
 * defaulting to v2 when nothing parses (harmless: the v2 extractor is equally
 * tolerant of an empty/corrupt file).
 */
export function detectKiroFormat(lines: string[]): "v2" | "v3" {
  for (const line of lines) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    return isRecord(parsed.payload) ? "v3" : "v2";
  }
  return "v2";
}

/** The verbatim human text of a `user` entry, or null when its body is empty. */
function userText(payload: Record<string, unknown>): string | null {
  const content = payload.content;
  if (typeof content !== "string") return null;
  const text = content.trim();
  return text === "" ? null : text;
}

/**
 * V3/V4: the person's words in a `user` entry, or null when there are none. An
 * empty body is a V3 drop; a harness envelope is read by V4 (its drop, if any,
 * is recorded by {@link harnessEnvelope}). Used by extraction and timeline
 * alike. Classification (K13, K15, automation markers) keeps reading the raw
 * body through {@link userText}.
 */
function humanTextV3(payload: Record<string, unknown>, drops: Drop[], ts: string): string | null {
  const text = userText(payload);
  if (text === null) {
    const raw = typeof payload.content === "string" ? payload.content : "";
    drops.push({
      reason: "V3: empty user content",
      snippet: snippet(raw),
      timestamp: ts || undefined,
    });
    return null;
  }
  return harnessEnvelope(text, drops, ts);
}

/** The spoken text of an `assistant` `Say` entry (buffered as one timeline turn). */
function assistantSay(payload: Record<string, unknown>): string {
  if (payload.operationType !== "Say") return "";
  return typeof payload.content === "string" ? payload.content.trim() : "";
}

/**
 * Extract human-authored messages from one v3 session's raw JSONL lines. Only
 * `user` entries are candidates; an empty body or a harness envelope with no
 * human words is recorded as an observable Drop (fidelity contract) rather than
 * vanishing. Timestamps are the line's in-band
 * ISO-8601 `timestamp` ("" when absent, tolerated as on the v2 path).
 */
export function extractKiroV3Messages(lines: string[]): ExtractResult {
  const messages: ExtractedMessage[] = [];
  const drops: Drop[] = [];
  let badLines = 0;

  for (const line of lines) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      badLines++;
      continue;
    }
    const payload = payloadOf(parsed);
    if (payload === undefined || payload.type !== "user") continue;

    const ts = isRecord(parsed) && typeof parsed.timestamp === "string" ? parsed.timestamp : "";
    const text = humanTextV3(payload, drops, ts);
    if (text !== null) messages.push({ timestamp: ts, text });
  }

  return { messages, drops, badLines };
}

/**
 * Build a v3 session's linear timeline: `human` turns from `user` entries (via
 * the SAME {@link humanTextV3} the exporter uses, so human turns align 1:1 with the
 * corpus, the SessionSource law), and `assistant` turns from `Say` entries.
 * `Reasoning` is omitted (parity with the v2 timeline skipping thinking blocks).
 *
 * No `boundary` event is emitted: no compaction/clear entry has been observed in
 * the v3 store. If kiro adds one, extend this with a fixture first rather than
 * guessing its shape.
 */
export function kiroV3Timeline(lines: string[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const scratchDrops: Drop[] = []; // timeline callers do not consume drops.
  for (const line of lines) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = payloadOf(parsed);
    if (!payload) continue;
    const ts = isRecord(parsed) && typeof parsed.timestamp === "string" ? parsed.timestamp : "";
    if (payload.type === "user") {
      const text = humanTextV3(payload, scratchDrops, ts);
      if (text !== null) events.push({ kind: "human", timestamp: ts, text });
    } else if (payload.type === "assistant") {
      const text = assistantSay(payload);
      if (text !== "") events.push({ kind: "assistant", timestamp: ts, text });
    }
  }
  return events;
}

/** First non-empty `user` text of a v3 session, for the automation-marker checks. */
function firstUserPromptV3(lines: string[]): string | null {
  for (const line of lines) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = payloadOf(parsed);
    if (payload === undefined || payload.type !== "user") continue;
    const text = userText(payload);
    if (text !== null) return text;
  }
  return null;
}

/** Every `user` entry's raw content string, in file order (empty ones included). */
function userContentsV3(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = payloadOf(parsed);
    if (payload === undefined || payload.type !== "user") continue;
    if (typeof payload.content === "string") out.push(payload.content);
  }
  return out;
}

// --- K15: Kiro Crew runs ---------------------------------------------------

/**
 * K15: the line Kiro Crew puts directly above the person's words in every
 * assembled prompt. Matched as a whole line (surrounding whitespace ignored),
 * so prose that merely quotes it mid-sentence does not trigger.
 */
const KIRO_CREW_REQUEST_MARKER = "[CURRENT USER REQUEST -- respond to this]";

/**
 * K15: prefixes of a first user prompt that only Kiro Crew writes: its session
 * context block, its resume block, its runtime block, and its agent system
 * prompt. `[AGENT SYSTEM PROMPT]` was already an exclusion before K15; it moved
 * here, ahead of the `.history` check, because the Crew store owns those runs.
 */
const KIRO_CREW_FIRST_PROMPT_MARKERS: readonly string[] = [
  "[SESSION CONTEXT",
  "[SESSION RESUMED",
  "[RUNTIME]",
  "[AGENT SYSTEM PROMPT]",
];

/**
 * K15: the directory Kiro Crew creates worker and cron working directories in.
 * A session whose cwd is `<...>/kirocrew-workspace/subagent_<id>` or
 * `<...>/kirocrew-workspace/cron_<id>` is a Crew worker or cron.
 */
const KIRO_CREW_WORKSPACE_DIR = "kirocrew-workspace";

/** K15: cwd basename prefixes of Crew worker and cron directories. */
const KIRO_CREW_WORKSPACE_PREFIXES: readonly string[] = ["subagent_", "cron_"];

/**
 * K15: Crew harness envelopes that open a `user` turn. Each is weak evidence on
 * its own (a `[LIVE STEERING` envelope also appears in plain kiro-cli use), so
 * they only count together with a Crew `agentMode`.
 */
const KIRO_CREW_ENVELOPE_PREFIXES: readonly string[] = [
  "[LIVE STEERING - New message from user]",
  "<user_message",
  "[Subagent completion event",
  "[auto-nudge cycle",
];

/** True when `agentMode` names a Kiro Crew agent (`kirocrew`, `kirocrew-<variant>`). */
function isCrewAgentMode(agentMode: string | undefined): boolean {
  return agentMode === "kirocrew" || Boolean(agentMode?.startsWith("kirocrew-"));
}

/** True when `cwd` is a Crew worker or cron directory under `kirocrew-workspace`. */
function isCrewWorkspaceCwd(cwd: string | undefined): boolean {
  if (!cwd) return false;
  // Split on both separators so a Windows-style path is read the same way.
  const parts = cwd.split(/[\\/]+/).filter((p) => p !== "");
  const base = parts.at(-1);
  const parent = parts.at(-2);
  if (base === undefined || parent !== KIRO_CREW_WORKSPACE_DIR) return false;
  return KIRO_CREW_WORKSPACE_PREFIXES.some((p) => base.startsWith(p));
}

/** True when some line of `text`, trimmed, is exactly the Crew request marker. */
function hasRequestMarkerLine(text: string): boolean {
  if (!text.includes(KIRO_CREW_REQUEST_MARKER)) return false;
  return text.split(/\r?\n/).some((line) => line.trim() === KIRO_CREW_REQUEST_MARKER);
}

/**
 * K15 over pre-read inputs: the session metadata, the first non-empty user
 * prompt (trimmed), and every user entry's raw content. Any one of these is a
 * Crew run:
 *
 *   - some user turn has the line {@link KIRO_CREW_REQUEST_MARKER};
 *   - the first user prompt starts with one of {@link KIRO_CREW_FIRST_PROMPT_MARKERS};
 *   - the cwd is a `subagent_` or `cron_` directory under {@link KIRO_CREW_WORKSPACE_DIR}.
 *
 * `agentMode` naming a Crew agent is NOT sufficient alone: a person can run a
 * Crew agent template directly in kiro-cli and type into it. It counts only
 * together with a user turn that opens with a Crew harness envelope
 * ({@link KIRO_CREW_ENVELOPE_PREFIXES}), which is weak evidence by itself too.
 */
function kirocrewSignals(
  meta: KiroSessionMeta,
  firstPrompt: string | null,
  userContents: readonly string[],
): boolean {
  if (userContents.some(hasRequestMarkerLine)) return true;
  if (firstPrompt && KIRO_CREW_FIRST_PROMPT_MARKERS.some((m) => firstPrompt.startsWith(m))) {
    return true;
  }
  if (isCrewWorkspaceCwd(meta.cwd)) return true;
  if (isCrewAgentMode(meta.agentMode)) {
    return userContents.some((c) => {
      const t = c.trim();
      return KIRO_CREW_ENVELOPE_PREFIXES.some((p) => t.startsWith(p));
    });
  }
  return false;
}

/**
 * K15: true when a v3 session is a Kiro Crew run (a Crew chat, worker or cron
 * copied into the kiro-cli store). Reads the metadata discovery gathered
 * (`meta.cwd` is `session.json.workspacePaths[0]`, `meta.agentMode` is
 * `session.json.agentMode`) and the session's raw lines. See
 * {@link kirocrewSignals} for the exact signals and why `agentMode` never
 * decides alone.
 */
export function isKirocrewDrivenV3(meta: KiroSessionMeta, lines: string[]): boolean {
  return kirocrewSignals(meta, firstUserPromptV3(lines), userContentsV3(lines));
}

/** The K15 exclusion reason; also the hint that tells the person where the text went. */
export const KIRO_CREW_K15_REASON = "K15: Kiro Crew run (read it with --source kirocrew)";

/**
 * A v3 classification verdict. `kind: "kirocrew"` marks a K15 exclusion, so the
 * source can report it apart from ordinary automation; every other verdict
 * leaves `kind` unset.
 */
export interface KiroV3Verdict {
  include: boolean;
  reason: string;
  kind?: "kirocrew";
}

/**
 * V3 session-level human-vs-automation classification, recall-oriented, mirroring
 * the v2 K2 precedence with v3-appropriate signals:
 *
 *   1. first user prompt begins with the human-hindsight distill sentinel → EXCLUDE
 *      (self-recognition, absolute; see K13);
 *   2. the session is a Kiro Crew run → EXCLUDE with `kind: "kirocrew"` (K15).
 *      This runs BEFORE the `.history` check: a Crew chat can have a `.history`
 *      companion, and the Crew store still owns its human side;
 *   3. a `.history` companion exists (a human typed here) → INCLUDE;
 *   4. first user prompt is an automation marker (an automation-agent
 *      boilerplate first line, or a lone harness nudge) → EXCLUDE;
 *   5. else INCLUDE (recall-oriented default).
 *
 * `userContents` is every user entry's raw content, for the K15 any-turn
 * checks. When omitted, only the first prompt is consulted (enough for callers
 * that hold just the first prompt; {@link classifyKiroV3Lines} passes them all).
 *
 * Unlike v2, `parentSessionId` is NOT an exclusion signal: a top-level v3 session
 * dir with a parent link is a human FORK, and true subagents live under
 * `sub-executions/` and are never enumerated as sessions.
 */
export function classifyKiroV3Session(
  meta: KiroSessionMeta,
  firstPrompt: string | null,
  userContents: readonly string[] = firstPrompt ? [firstPrompt] : [],
): KiroV3Verdict {
  if (isHindsightDistillPrompt(firstPrompt)) {
    return { include: false, reason: "K13: human-hindsight distill session (self-recognition)" };
  }
  if (kirocrewSignals(meta, firstPrompt, userContents)) {
    return { include: false, reason: KIRO_CREW_K15_REASON, kind: "kirocrew" };
  }
  if (meta.hasHistory) {
    return { include: true, reason: "V3: .history present (human typed here)" };
  }
  if (firstPrompt) {
    if (KIRO_AUTOMATION_FIRST_LINES.some((m) => firstPrompt.startsWith(m))) {
      return { include: false, reason: "V3: automation-agent boilerplate first prompt" };
    }
    if (KIRO_HARNESS_NUDGES.some((m) => firstPrompt.startsWith(m))) {
      return { include: false, reason: "V3: harness-nudge-only session" };
    }
  }
  return { include: true, reason: "V3: recall-oriented default (no automation markers)" };
}

/** Classify from raw lines (reads the first user prompt itself). */
export function classifyKiroV3Lines(meta: KiroSessionMeta, lines: string[]): KiroV3Verdict {
  return classifyKiroV3Session(meta, firstUserPromptV3(lines), userContentsV3(lines));
}
