import type { Drop, ExtractResult, TimelineEvent } from "../types.js";
import { isCodexAutomation } from "./discover.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

/**
 * Only known Codex context wrappers are removed. Human HTML/XML survives.
 * The IDE prepends context before "## My request for Codex:"; the protocol's
 * own strip_user_message_prefix uses the same marker.
 */
function humanText(raw: string, drops: Drop[], timestamp: string): string {
  let text = raw.trim();
  const request = "## My request for Codex:";
  if (text.startsWith("# Context from my IDE setup:") || text.startsWith(request)) {
    const start = text.indexOf(request);
    if (start >= 0) text = text.slice(start + request.length).trim();
  }
  const before = text;
  text = text
    .replace(
      /^# AGENTS\.md instructions for [^\n]*\n+\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/i,
      "",
    )
    .replace(
      /<(environment_context|user_instructions|permissions|collaboration_mode|turn_aborted|subagent_notification|skill)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/gi,
      "",
    )
    .replace(/<\/?image(?:\s[^>]*)?>/gi, "")
    .replace(/^\[Image #\d+\]\s*$/gm, "")
    .trim();
  if (text !== before) {
    drops.push({ reason: "C2: injected context", snippet: excerpt(before), timestamp });
  }
  return text;
}

function contentText(content: unknown, human: boolean, drops: Drop[], timestamp: string): string {
  if (typeof content === "string") {
    return human ? humanText(content, drops, timestamp) : content.trim();
  }
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!record(part)) return [];
      if (
        (part.type === "input_text" || part.type === "output_text" || part.type === "text") &&
        typeof part.text === "string"
      ) {
        return [human ? humanText(part.text, drops, timestamp) : part.text.trim()];
      }
      if (human && part.type === "input_image") return ["[image pasted]"];
      if (human && part.type === "input_audio") return ["[audio supplied]"];
      return [];
    })
    .filter(Boolean)
    .join("\n\n");
}

function objectValue(value: unknown): Record<string, unknown> | null {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return record(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface Question {
  id: string;
  text: string;
  labels: string[];
}

function questionsFrom(args: Record<string, unknown>): Question[] {
  if (!Array.isArray(args.questions)) return [];
  return args.questions.flatMap((q) => {
    if (!record(q)) return [];
    const text = typeof q.question === "string" ? q.question : q.title;
    if (typeof text !== "string" || !text.trim()) return [];
    const labels = Array.isArray(q.options)
      ? q.options.flatMap((o) =>
          typeof o === "string" ? [o] : record(o) && typeof o.label === "string" ? [o.label] : [],
        )
      : [];
    return [{ id: typeof q.id === "string" ? q.id : text, text, labels }];
  });
}

type Surface = "response" | "event";

/**
 * C1: admit user messages, never developer/system/reasoning/tool output.
 * C2: remove known injected context, retaining user prose in the same entry.
 * C3: pair response_item and event_msg copies once per turn. Repeated user
 *     replies ("yes", "yes") on the SAME surface remain distinct.
 * C4: recover decisions only from outputs paired to request_user_input calls.
 * C5: compaction is a context boundary; its replacement_history isn't input.
 *
 * One parser produces both exports and their timeline, preserving the source law.
 */
function parse(lines: string[]): ExtractResult & { events: TimelineEvent[] } {
  const drops: Drop[] = [];
  const entries: Record<string, unknown>[] = [];
  let badLines = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (record(entry)) entries.push(entry);
      else badLines++;
    } catch {
      badLines++;
    }
  }
  if (
    entries.some(
      (e) => e.type === "session_meta" && record(e.payload) && isCodexAutomation(e.payload),
    )
  ) {
    return {
      messages: [],
      events: [],
      drops: [{ reason: "C1: automation session", snippet: "Codex subagent/internal session" }],
      badLines,
    };
  }

  const events: TimelineEvent[] = [];
  let last: { event: TimelineEvent; surface: Surface; paired: boolean } | undefined;
  const questions = new Map<string, Question[]>();
  const emit = (event: TimelineEvent, surface: Surface) => {
    if (!event.text.trim()) return;
    if (
      last &&
      !last.paired &&
      last.surface !== surface &&
      last.event.kind === event.kind &&
      last.event.text === event.text
    ) {
      last.paired = true;
      if (event.kind === "human") {
        drops.push({
          reason: "C3: mirrored user message",
          snippet: excerpt(event.text),
          timestamp: event.timestamp,
        });
      }
      return;
    }
    events.push(event);
    last = { event, surface, paired: false };
  };

  for (const entry of entries) {
    const payload = entry.payload;
    if (!record(payload)) continue;
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
    if (
      entry.type === "compacted" ||
      (entry.type === "event_msg" && payload.type === "context_compacted")
    ) {
      events.push({ kind: "boundary", timestamp, text: "" });
      last = undefined;
      questions.clear();
      continue;
    }
    if (entry.type === "event_msg") {
      if (payload.type === "task_started" || payload.type === "turn_started") {
        last = undefined;
      } else if (payload.type === "user_message" && typeof payload.message === "string") {
        const parts = [humanText(payload.message, drops, timestamp)];
        for (const key of ["images", "local_images", "file_ids"]) {
          if (Array.isArray(payload[key])) {
            parts.push(...payload[key].map(() => "[image pasted]"));
          }
        }
        emit({ kind: "human", timestamp, text: parts.filter(Boolean).join("\n\n") }, "event");
      } else if (payload.type === "agent_message" && typeof payload.message === "string") {
        emit({ kind: "assistant", timestamp, text: payload.message.trim() }, "event");
      }
      continue;
    }
    if (entry.type !== "response_item") continue;
    if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
      const human = payload.role === "user";
      emit(
        {
          kind: human ? "human" : "assistant",
          timestamp,
          text: contentText(payload.content, human, drops, timestamp),
        },
        "response",
      );
    } else if (payload.type === "function_call" && typeof payload.name === "string") {
      const args = objectValue(payload.arguments);
      if (!args) continue;
      const name = payload.name.split(".").at(-1);
      if (name === "request_user_input" || name === "request_user_input_async") {
        const qs = questionsFrom(args);
        if (typeof payload.call_id === "string") questions.set(payload.call_id, qs);
        events.push({
          kind: "question",
          timestamp,
          text: qs
            .map((q) => `${q.text}${q.labels.length ? ` [${q.labels.join(", ")}]` : ""}`)
            .join("\n"),
        });
        last = undefined;
      } else if (name === "update_plan" && Array.isArray(args.plan)) {
        const steps = args.plan.flatMap((p) =>
          record(p) && typeof p.step === "string" ? [p.step] : [],
        );
        events.push({ kind: "plan", timestamp, text: steps.join("\n") });
        last = undefined;
      }
    } else if (payload.type === "function_call_output" && typeof payload.call_id === "string") {
      const qs = questions.get(payload.call_id);
      questions.delete(payload.call_id);
      const output = objectValue(payload.output);
      if (!qs || !record(output?.answers)) continue;
      const answers = output.answers;
      const decisions = qs.flatMap((q) => {
        const answer = answers[q.id];
        const values = record(answer) ? answer.answers : answer;
        const text =
          typeof values === "string"
            ? values
            : Array.isArray(values)
              ? values.filter((v) => typeof v === "string").join(", ")
              : "";
        return text.trim() ? [`[decision] "${q.text}" → ${text.trim()}`] : [];
      });
      emit({ kind: "human", timestamp, text: decisions.join("\n") }, "response");
    }
  }
  return {
    messages: events
      .filter((e) => e.kind === "human")
      .map(({ timestamp, text }) => ({ timestamp, text })),
    drops,
    badLines,
    events,
  };
}

export function extractCodexMessages(lines: string[]): ExtractResult {
  const { messages, drops, badLines } = parse(lines);
  return { messages, drops, badLines };
}

export function extractCodexTimeline(lines: string[]): TimelineEvent[] {
  return parse(lines).events;
}
