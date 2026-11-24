import { renderDecisionLine, renderQuestionLine } from "../questions.js";
import { isRecord, snippet } from "../read.js";
import type { Drop, ExtractResult, TimelineEvent } from "../types.js";
import { leadingWrappers } from "../wrappers.js";
import { isCodexAutomation } from "./discover.js";

/**
 * C2: the context blocks Codex itself writes into a user message. Exact names,
 * case-sensitive, and only as complete blocks at the start of the message
 * (repeated): that is the only place the harness puts them. The same tags
 * inside what the person wrote (a question about `<skill>`, a pasted XML
 * `<permissions>` element) are the person's words and survive.
 */
const CODEX_CONTEXT_TAGS: ReadonlySet<string> = new Set([
  "environment_context",
  "user_instructions",
  "permissions",
  "collaboration_mode",
  "turn_aborted",
  "subagent_notification",
  "skill",
]);

/**
 * The AGENTS.md block Codex writes at the start of a message. Its heading names
 * the folder the instructions came from, or no folder for instructions that
 * apply everywhere.
 */
const AGENTS_BLOCK =
  /^# AGENTS\.md instructions(?: for [^\n]*)?\n+\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/;

/**
 * The image markers Codex writes around an attached image, each as a text part
 * of its own: `<image>`, `<image name=[Image #1]>`, the same with the local
 * file it came from (`path="..."`), and `</image>`. Removed only
 * when a part is made of nothing else, so an `<image>` element the person
 * pasted (SVG, HTML) survives.
 */
const IMAGE_MARKERS_ONLY =
  /^(?:\s*(?:<image(?: name=\[Image #\d+\])?(?: path="[^"\n]*")?>|<\/image>))+\s*$/;

/** The placeholder line the composer leaves where an image was attached. */
const IMAGE_PLACEHOLDER_LINE = /^\[Image #\d+\]\s*$/gm;

const IDE_CONTEXT = "# Context from my IDE setup:";
const IDE_REQUEST = "## My request for Codex:";

/**
 * C2: a shell command the person typed after `!` in Codex. Codex records it as
 * a user message of its own: `<user_shell_command>` holding `<command>` (what
 * was typed) and `<result>` (exit code, duration, output). The command is kept
 * as `[command] !the command`, the same rule as Claude Code's shell commands;
 * the result is machine text. Its output may print the closing tag, so the
 * last closer ends the block.
 */
const SHELL_COMMAND_TAG = "user_shell_command";
const SHELL_COMMAND_RULES = { output: new Set([SHELL_COMMAND_TAG]) } as const;
const SHELL_COMMAND_TEXT = /^\s*<command>\n?([\s\S]*?)\n?<\/command>/;

interface LeadingContext {
  /** `[command] !...` lines for the shell commands found, in order. */
  commands: string[];
  /** The person's words after the context. */
  rest: string;
}

/** Remove the leading context blocks (C2), repeatedly, until the person's words. */
function withoutLeadingContext(text: string): LeadingContext {
  let rest = text;
  const commands: string[] = [];
  for (;;) {
    const agents = AGENTS_BLOCK.exec(rest);
    if (agents) {
      rest = rest.slice(agents[0].length);
      continue;
    }
    const shell = leadingWrappers(rest, new Set([SHELL_COMMAND_TAG]), {
      ...SHELL_COMMAND_RULES,
      shape: false,
      unclosedIsMachine: false,
    });
    const [block] = shell.blocks;
    if (block?.tag === SHELL_COMMAND_TAG) {
      const command = SHELL_COMMAND_TEXT.exec(block.body)?.[1]?.trim();
      if (command) commands.push(`[command] !${command}`);
      rest = rest.trim().slice(block.raw.length).trim();
      continue;
    }
    const { blocks, text: after } = leadingWrappers(rest, CODEX_CONTEXT_TAGS, {
      shape: false,
      unclosedIsMachine: false,
    });
    if (!blocks.length) return { commands, rest };
    rest = after;
  }
}

/**
 * Only what Codex wrote is removed; human HTML/XML survives (see C2 above).
 * The IDE writes its context, then "## My request for Codex:" on its own line,
 * then the request. A selection inside the context can contain that same line,
 * so the request starts after the last heading that begins a line, which is
 * how Codex's own transcript view reads it (`rsplit_once` on the heading).
 * IDE context with no request heading at all holds no request: it is machine
 * text whole and is dropped with a record.
 */
function humanText(raw: string, drops: Drop[], timestamp: string): string {
  let text = raw.trim();
  if (text.startsWith(IDE_CONTEXT) || text.startsWith(IDE_REQUEST)) {
    const lastLine = text.lastIndexOf(`\n${IDE_REQUEST}`);
    // No heading at the start of a line: fall back to the first one anywhere.
    const start = lastLine >= 0 ? lastLine + 1 : text.indexOf(IDE_REQUEST);
    if (start < 0) {
      drops.push({
        reason: "C2: IDE context without a request",
        snippet: snippet(text),
        timestamp,
      });
      return "";
    }
    text = text.slice(start + IDE_REQUEST.length).trim();
  }
  const before = text;
  const context = IMAGE_MARKERS_ONLY.test(text)
    ? { commands: [], rest: "" }
    : withoutLeadingContext(text);
  text = context.rest.replace(IMAGE_PLACEHOLDER_LINE, "").trim();
  if (text !== before) {
    const reason = context.commands.length ? "C2: shell command result" : "C2: injected context";
    drops.push({ reason, snippet: snippet(before), timestamp });
  }
  return [...context.commands, text].filter(Boolean).join("\n\n");
}

function contentText(content: unknown, human: boolean, drops: Drop[], timestamp: string): string {
  if (typeof content === "string") {
    return human ? humanText(content, drops, timestamp) : content.trim();
  }
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!isRecord(part)) return [];
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
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface Question {
  id: string;
  text: string;
  surface: string;
}

function questionsFrom(args: Record<string, unknown>): Question[] {
  if (!Array.isArray(args.questions)) return [];
  return args.questions.flatMap((q) => {
    if (!isRecord(q)) return [];
    const text = typeof q.question === "string" ? q.question : q.title;
    if (typeof text !== "string" || !text.trim()) return [];
    return [
      {
        id: typeof q.id === "string" ? q.id : text,
        text,
        surface: renderQuestionLine(text, q.options, q.multiSelect === true),
      },
    ];
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
      if (isRecord(entry)) entries.push(entry);
      else badLines++;
    } catch {
      badLines++;
    }
  }
  if (
    entries.some(
      (e) => e.type === "session_meta" && isRecord(e.payload) && isCodexAutomation(e.payload),
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
          snippet: snippet(event.text),
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
    if (!isRecord(payload)) continue;
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
          text: qs.map((q) => q.surface).join("\n"),
        });
        last = undefined;
      } else if (name === "update_plan" && Array.isArray(args.plan)) {
        const steps = args.plan.flatMap((p) =>
          isRecord(p) && typeof p.step === "string" ? [p.step] : [],
        );
        events.push({ kind: "plan", timestamp, text: steps.join("\n") });
        last = undefined;
      }
    } else if (payload.type === "function_call_output" && typeof payload.call_id === "string") {
      const qs = questions.get(payload.call_id);
      questions.delete(payload.call_id);
      const output = objectValue(payload.output);
      if (!qs || !isRecord(output?.answers)) continue;
      const answers = output.answers;
      const decisions = qs.flatMap((q) => {
        const answer = answers[q.id];
        const values = isRecord(answer) ? answer.answers : answer;
        const line = renderDecisionLine(q.text, values);
        return line ? [line] : [];
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
