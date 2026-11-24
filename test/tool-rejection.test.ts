/**
 * R5: a rejected tool use carries the person's follow-up after a fixed
 * one-line boilerplate. Only that exact shape is human text; any other tool
 * result that merely contains the marker (a file read, grep output, a diff) is
 * machine output and yields no message and no drop. Every row also checks the
 * SessionSource law.
 */
import { describe, expect, it } from "vitest";
import {
  extractMessages,
  extractTimeline,
  toolRejectionFollowUp,
} from "../src/sources/claude/extract.js";

const TS = "2026-05-02T10:00:00.000Z";
const LONG_LEAD =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";

const ROWS: { name: string; content: string; kept: string[] }[] = [
  {
    name: "the real long form with a reason gives exactly the reason",
    content: `${LONG_LEAD} To tell you how to proceed, the user said:\nkeep the old schema and add a view`,
    kept: ["keep the old schema and add a view"],
  },
  {
    name: "the short fixture shape still gives its follow-up",
    content: "The tool use was rejected. the user said: Use a migration instead.",
    kept: ["Use a migration instead."],
  },
  {
    name: "a rejection with no reason gives nothing",
    content: LONG_LEAD,
    kept: [],
  },
  {
    name: "a file read that contains the marker gives nothing",
    content:
      '     1\timport fs from "node:fs";\n    45\tconst TOOL_REJECTION_MARKER = "the user said:";\n    46\t\n    47\tfunction isRecord(value) {\n    48\t  return true;\n',
    kept: [],
  },
  {
    name: "grep output that contains the marker gives nothing",
    content: 'src/x.ts:45:const M = "the user said:";',
    kept: [],
  },
  {
    name: "a lead followed by the marker on a later line gives nothing",
    content:
      "The tool use was rejected by a hook.\nhook output line 2\nthe user said: this is hook text",
    kept: [],
  },
  {
    name: "the marker beyond offset 320 gives nothing",
    content: `The tool use was rejected ${"x".repeat(320)} the user said: too far away`,
    kept: [],
  },
];

function lines(content: string): string[] {
  return [
    JSON.stringify({
      type: "user",
      timestamp: TS,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content }] },
    }),
  ];
}

describe("R5 tool-rejection recovery", () => {
  it.each(ROWS)("$name", ({ content, kept }) => {
    for (const shape of [content, [{ type: "text", text: content }]]) {
      const input = lines("").map((l) => {
        const entry = JSON.parse(l);
        entry.message.content[0].content = shape;
        return JSON.stringify(entry);
      });
      const result = extractMessages(input);
      expect(result.messages.map((m) => m.text)).toEqual(kept);
      expect(result.drops).toEqual([]);
      const human = extractTimeline(input)
        .filter((e) => e.kind === "human")
        .map(({ timestamp, text }) => ({ timestamp, text }));
      expect(human).toEqual(result.messages.map(({ timestamp, text }) => ({ timestamp, text })));
    }
  });
});

describe("toolRejectionFollowUp", () => {
  it.each([
    ["  The tool use was rejected. the user said: go on", " go on"],
    [`The tool use was rejected${" ".repeat(295)}the user said:x`, "x"],
    [`The tool use was rejected${" ".repeat(296)}the user said:x`, null],
    ["Error: The tool use was rejected. the user said: x", null],
    ["The tool use was rejected.\nthe user said: x", null],
  ])("%j", (text, expected) => {
    expect(toolRejectionFollowUp(text)).toBe(expected);
  });
});
