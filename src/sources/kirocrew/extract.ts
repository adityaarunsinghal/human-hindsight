import type { Drop, ExtractedMessage, ExtractResult, TimelineEvent } from "../types.js";

/**
 * sources/kirocrew/extract.ts: the Kiro Crew chat extractor (rules C1 to C7).
 *
 * A Crew chat file is one JSON object per line. Line 1 is a `_type: "metadata"`
 * record; every other line is `{role, content, ts, source_thread, source_user,
 * meta}`. Kiro Crew keeps harness traffic off the `user` role: injected context,
 * nudges, subagent briefs, cards and tool output each have their own role
 * (`inject`, `nudge`, `subagent`, `card`, `tool`, ...), so the person's words are
 * exactly the `user` records. That makes this extractor much simpler than the
 * kiro-cli one, which has to recognise the same traffic inside one assembled
 * prompt.
 *
 *   C1  only `role: "user"` records are candidates; every other role is machine.
 *   C2  `_type: "metadata"` and `_type: "archive"` lines are not messages (not drops).
 *   C3  `meta.human === false` drops the record. An absent flag keeps it: older
 *       records predate the flag and are human.
 *   C4  `meta.steer` records (typed while the agent was mid-turn) are kept
 *       verbatim, with no marker added.
 *   C5  empty or whitespace-only content is an observable drop.
 *   C6  a user record opening with a known harness envelope
 *       ({@link KIROCREW_USER_ENVELOPES}) is an observable drop, so a future Crew
 *       release that moves such traffic onto the user role cannot poison the
 *       corpus silently.
 *   C7  a corrupt line counts in `badLines`; nothing throws.
 *
 * `meta` may arrive as an object or as a JSON string; an unparseable string is
 * treated as `{}`. Text is the content with surrounding whitespace trimmed, as on
 * the kiro v3 path. Timestamp is the record's ISO-8601 `ts` ("" when missing).
 *
 * Messages and the timeline's `human` events both come from {@link userTurn},
 * one per-record function, which is how this source keeps the SessionSource law.
 */

/** Opening strings of harness envelopes that must never count as a human turn (C6). */
export const KIROCREW_USER_ENVELOPES: readonly string[] = [
  "[Subagent completion event",
  "[auto-nudge",
  "[Cron notification",
  "[Kiro Crew host notice]",
];

/** `_type` values that mark a line as store bookkeeping rather than a message (C2). */
const NON_MESSAGE_TYPES = new Set(["metadata", "archive"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collapse whitespace and cap at 120 chars for a Drop snippet. */
function snippet(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

/** A record's `meta` as an object: object as-is, JSON string parsed, else {}. */
function metaOf(record: Record<string, unknown>): Record<string, unknown> {
  const meta = record.meta;
  if (isRecord(meta)) return meta;
  if (typeof meta === "string") {
    try {
      const parsed: unknown = JSON.parse(meta);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** One parsed line: a message record, a bookkeeping line, or a corrupt line. */
type ParsedLine =
  | { kind: "record"; record: Record<string, unknown>; ts: string }
  | { kind: "skip" }
  | { kind: "bad" };

/** Parse one raw line. Blank and C2 lines are skips; unparseable or non-object lines are bad (C7). */
function parseLine(line: string): ParsedLine {
  if (line.trim() === "") return { kind: "skip" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "bad" };
  }
  if (!isRecord(parsed)) return { kind: "bad" };
  if (typeof parsed._type === "string" && NON_MESSAGE_TYPES.has(parsed._type)) {
    return { kind: "skip" };
  }
  return { kind: "record", record: parsed, ts: typeof parsed.ts === "string" ? parsed.ts : "" };
}

/** The verdict on one record as a human turn. */
type UserTurn = { keep: true; text: string } | { keep: false; reason: string; raw: string } | null;

/**
 * The shared per-record function behind both extract and timeline. Returns null
 * for a non-user record (C1, not a drop), a kept turn, or a drop with its rule.
 */
function userTurn(record: Record<string, unknown>): UserTurn {
  if (record.role !== "user") return null;
  const raw = typeof record.content === "string" ? record.content : "";
  if (metaOf(record).human === false) {
    return { keep: false, reason: "C3: harness-marked non-human", raw };
  }
  const text = raw.trim();
  if (text === "") return { keep: false, reason: "C5: empty user content", raw };
  if (KIROCREW_USER_ENVELOPES.some((marker) => text.startsWith(marker))) {
    return { keep: false, reason: "C6: harness envelope on user role", raw };
  }
  // C4: a steer (`meta.steer`) is an ordinary kept turn; its text is already
  // exactly what the person typed, so no marker is added.
  return { keep: true, text };
}

/** Spoken text of an `assistant` or `error` record; "" when there is none. */
function plainText(record: Record<string, unknown>): string {
  return typeof record.content === "string" ? record.content.trim() : "";
}

/** Extract the person's messages from one Crew chat's raw JSONL lines. */
export function extractKirocrewMessages(lines: string[]): ExtractResult {
  const messages: ExtractedMessage[] = [];
  const drops: Drop[] = [];
  let badLines = 0;

  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed.kind === "bad") {
      badLines++;
      continue;
    }
    if (parsed.kind === "skip") continue;
    const turn = userTurn(parsed.record);
    if (turn === null) continue;
    if (turn.keep) {
      messages.push({ timestamp: parsed.ts, text: turn.text });
    } else {
      drops.push({
        reason: turn.reason,
        snippet: snippet(turn.raw),
        timestamp: parsed.ts || undefined,
      });
    }
  }
  return { messages, drops, badLines };
}

/**
 * Build a Crew chat's timeline: `human` from kept user records (through the same
 * {@link userTurn}), `assistant` from `role: "assistant"` text, `status` from
 * `role: "error"` text (throttling and retry notices the outcome pass reads).
 * Every other role is omitted. No `boundary` is emitted: Crew compaction keeps
 * the transcript and no hard-reset record has been observed.
 */
export function kirocrewTimeline(lines: string[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed.kind !== "record") continue;
    const { record, ts } = parsed;
    if (record.role === "user") {
      const turn = userTurn(record);
      if (turn?.keep) events.push({ kind: "human", timestamp: ts, text: turn.text });
    } else if (record.role === "assistant") {
      const text = plainText(record);
      if (text !== "") events.push({ kind: "assistant", timestamp: ts, text });
    } else if (record.role === "error") {
      const text = plainText(record);
      if (text !== "") events.push({ kind: "status", timestamp: ts, text });
    }
  }
  return events;
}
