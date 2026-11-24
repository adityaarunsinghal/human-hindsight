/**
 * Question and decision lines are one format across sources. The same question,
 * options, multi-select flag and answers, written in each CLI's own transcript
 * shape, must give byte-equal question surfaces (timeline) and decision lines
 * (human text).
 */
import { describe, expect, it } from "vitest";
import { extractMessages, extractTimeline } from "../src/sources/claude/extract.js";
import { extractCodexMessages, extractCodexTimeline } from "../src/sources/codex/extract.js";
import {
  extractOpenCodeMessages,
  extractOpenCodeTimeline,
} from "../src/sources/opencode/extract.js";
import type { ExtractResult, TimelineEvent } from "../src/sources/types.js";

interface Case {
  name: string;
  question: string;
  options: string[];
  multi: boolean;
  answers: string[];
  surface: string;
  decision: string;
}

const CASES: Case[] = [
  {
    name: "single choice",
    question: "Which database?",
    options: ["SQLite", "Postgres"],
    multi: false,
    answers: ["SQLite"],
    surface: "Which database? [SQLite, Postgres]",
    decision: '[decision] "Which database?" → SQLite',
  },
  {
    name: "multi-select",
    question: "Which checks?",
    options: ["Lint", "Typecheck", "Build"],
    multi: true,
    answers: ["Lint", "Typecheck"],
    surface: "Which checks? [Lint, Typecheck, Build] (multi-select)",
    decision: '[decision] "Which checks?" → Lint, Typecheck',
  },
  {
    name: "free answer with no options",
    question: "Ship where?",
    options: [],
    multi: false,
    answers: ["Staging"],
    surface: "Ship where?",
    decision: '[decision] "Ship where?" → Staging',
  },
];

type Reader = {
  lines(c: Case): string[];
  extract(lines: string[]): ExtractResult;
  timeline(lines: string[]): TimelineEvent[];
};

const READERS: Record<string, Reader> = {
  claude: {
    lines: (c) => [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-10-20T10:00:00Z",
        message: {
          content: [
            {
              type: "tool_use",
              name: "AskUserQuestion",
              input: {
                questions: [
                  {
                    question: c.question,
                    options: c.options.map((label) => ({ label })),
                    multiSelect: c.multi,
                  },
                ],
              },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-10-20T10:00:01Z",
        message: { content: [{ type: "tool_result", content: "Answers received" }] },
        toolUseResult: {
          questions: [{ question: c.question }],
          answers: { [c.question]: c.multi ? c.answers : c.answers[0] },
        },
      }),
    ],
    extract: extractMessages,
    timeline: extractTimeline,
  },
  codex: {
    lines: (c) => [
      JSON.stringify({
        timestamp: "2026-10-20T10:00:00Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "functions.request_user_input",
          call_id: "q1",
          arguments: JSON.stringify({
            questions: [
              {
                id: "q",
                question: c.question,
                options: c.options.map((label) => ({ label })),
                multiSelect: c.multi,
              },
            ],
          }),
        },
      }),
      JSON.stringify({
        timestamp: "2026-10-20T10:00:01Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "q1",
          output: JSON.stringify({ answers: { q: { answers: c.answers } } }),
        },
      }),
    ],
    extract: extractCodexMessages,
    timeline: extractCodexTimeline,
  },
  opencode: {
    lines: (c) => [
      JSON.stringify({
        format: "v1",
        info: { id: "m1", role: "assistant", time: { created: 1792490400000 } },
        parts: [
          {
            type: "tool",
            tool: "question",
            state: {
              status: "completed",
              time: { end: 1792490401000 },
              input: {
                questions: [
                  {
                    question: c.question,
                    options: c.options.map((label) => ({ label })),
                    multiple: c.multi,
                  },
                ],
              },
              metadata: { answers: [c.answers] },
            },
          },
        ],
      }),
    ],
    extract: extractOpenCodeMessages,
    timeline: extractOpenCodeTimeline,
  },
};

describe("question and decision lines across sources", () => {
  it.each(CASES)("$name", (c) => {
    for (const [name, reader] of Object.entries(READERS)) {
      const lines = reader.lines(c);
      const surfaces = reader
        .timeline(lines)
        .filter((e) => e.kind === "question")
        .map((e) => e.text);
      const human = reader.extract(lines).messages.map((m) => m.text);
      expect({ name, surfaces, human }).toEqual({
        name,
        surfaces: [c.surface],
        human: [c.decision],
      });
    }
  });
});
