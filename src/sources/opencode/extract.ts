import type { Drop, ExtractResult, TimelineEvent } from "../types.js";

type ObjectValue = Record<string, unknown>;
export const OPENCODE_DISTILL_MARKER = "[human-hindsight distill]";

export function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
}

function objects(value: unknown): ObjectValue[] {
  return Array.isArray(value)
    ? value.map(object).filter((item): item is ObjectValue => item !== undefined)
    : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function timestamp(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  if (typeof value === "string" && value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  return "";
}

function attachment(file: ObjectValue): string {
  const mime = text(file.mime) || text(file.mediaType);
  if (mime.startsWith("image/")) return "[image pasted]";
  const name = text(file.filename) || text(file.name);
  return name ? `[file attached: ${name}]` : "[file attached]";
}

/**
 * Both stores normalize into {format, info, parts?} records. One pass produces
 * human extraction and the timeline, so decision/timestamp alignment cannot drift.
 */
function parse(lines: string[]): { result: ExtractResult; timeline: TimelineEvent[] } {
  const result: ExtractResult = { messages: [], drops: [], badLines: 0 };
  const timeline: TimelineEvent[] = [];
  const seen = new Set<string>();
  const drop = (reason: string, value: string, time = "") => {
    const record: Drop = {
      reason: `O: ${reason}`,
      snippet: value.replace(/\s+/g, " ").slice(0, 120),
      ...(time ? { timestamp: time } : {}),
    };
    result.drops.push(record);
  };
  const event = (kind: TimelineEvent["kind"], value: string, time: string) => {
    if (!value.trim()) return;
    timeline.push({ kind, text: value, timestamp: time });
    if (kind === "human") result.messages.push({ text: value, timestamp: time });
  };
  const question = (tool: ObjectValue, time: string) => {
    const state = object(tool.state);
    const input = object(state?.input);
    const questions = objects(input?.questions);
    if (questions.length === 0) return;
    event(
      "question",
      questions
        .map((q) => {
          const choices = objects(q.options).map((option) => text(option.label));
          return `${text(q.question)}${choices.length ? ` (${choices.join(" | ")})` : ""}`;
        })
        .join("\n"),
      time,
    );
    const answers = object(state?.metadata)?.answers;
    if (state?.status !== "completed" || !Array.isArray(answers)) return;
    const decisions = questions.flatMap((q, i) => {
      const answer = answers[i];
      const values = Array.isArray(answer) ? answer.filter((v) => typeof v === "string") : [];
      return values.length ? [`[decision] ${text(q.question)} → ${values.join(", ")}`] : [];
    });
    const answeredAt =
      timestamp(object(tool.time)?.completed) || timestamp(object(state.time)?.end) || time;
    event("human", decisions.join("\n"), answeredAt);
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let row: ObjectValue | undefined;
    try {
      row = object(JSON.parse(line));
    } catch {
      result.badLines++;
      continue;
    }
    const info = object(row?.info);
    if (!row || !info || (row.format !== "v1" && row.format !== "v2")) {
      result.badLines++;
      continue;
    }
    if (
      typeof row.badParts === "number" &&
      Number.isSafeInteger(row.badParts) &&
      row.badParts > 0
    ) {
      result.badLines += row.badParts;
    }
    const id = text(info.id);
    // Duplicate persisted records are different from a human repeating their text.
    if (id && seen.has(`${row.format}:${id}`)) continue;
    if (id) seen.add(`${row.format}:${id}`);
    const time = timestamp(object(info.time)?.created) || timestamp(row.time);
    if (row.format === "v2") {
      switch (info.type) {
        case "user": {
          if (typeof info.text !== "string") {
            result.badLines++;
            drop("malformed human record", "", time);
            break;
          }
          const pieces = [text(info.text), ...objects(info.files).map(attachment)].filter(Boolean);
          if (text(info.text).startsWith(OPENCODE_DISTILL_MARKER)) {
            drop("generated distillation prompt", text(info.text), time);
          } else {
            event("human", pieces.join("\n\n"), time);
          }
          break;
        }
        case "assistant":
          for (const content of objects(info.content)) {
            if (content.type === "text") event("assistant", text(content.text), time);
            if (content.type === "tool" && content.name === "question") question(content, time);
          }
          if (info.error)
            event("status", `OpenCode error: ${text(object(info.error)?.message)}`, time);
          break;
        case "shell":
          event("human", text(info.command) ? `[command] ${text(info.command)}` : "", time);
          break;
        case "compaction":
          if (info.status === "completed") event("boundary", "OpenCode compaction", time);
          break;
        case "idle":
          event("status", `OpenCode execution ${text(info.outcome)}`, time);
          break;
        default:
          drop(`non-human ${text(info.type) || "unknown"} record`, text(info.text), time);
      }
      continue;
    }

    const parts = objects(row.parts);
    const human: string[] = [];
    for (const part of parts) {
      if (info.role === "user") {
        if (part.type === "compaction") {
          // A v1 compaction request is a machine user message. Its successful
          // assistant summary below marks the actual boundary.
          drop("compaction request", "", time);
        } else if (part.synthetic === true || part.ignored === true) {
          drop("synthetic or ignored part", text(part.text), time);
        } else if (part.type === "text") {
          if (text(part.text).startsWith(OPENCODE_DISTILL_MARKER)) {
            drop("generated distillation prompt", text(part.text), time);
          } else if (text(part.text).trim()) human.push(text(part.text));
        } else if (part.type === "file") {
          human.push(attachment(part));
        } else if (part.type !== "agent") {
          drop(`non-human ${text(part.type) || "unknown"} part`, "", time);
        }
      } else if (info.role === "assistant") {
        if (info.summary === true) continue;
        if (part.type === "text") event("assistant", text(part.text), time);
        if (part.type === "tool" && part.tool === "question") question(part, time);
      }
    }
    if (info.role === "user") event("human", human.join("\n\n"), time);
    if (info.role === "assistant" && info.summary === true && !info.error) {
      event("boundary", "OpenCode compaction", time);
    }
    if (info.error) {
      const error = object(info.error);
      event(
        "status",
        `OpenCode error: ${text(object(error?.data)?.message) || text(error?.name)}`,
        time,
      );
    }
  }
  return { result, timeline };
}

export function extractOpenCodeMessages(lines: string[]): ExtractResult {
  return parse(lines).result;
}

export function extractOpenCodeTimeline(lines: string[]): TimelineEvent[] {
  return parse(lines).timeline;
}
