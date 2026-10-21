import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractMessages, extractTimeline } from "../src/sources/claude/extract.js";

const lines = fs
  .readFileSync(
    path.join(import.meta.dirname, "fixtures/extract/modern-decisions-and-compaction.jsonl"),
    "utf8",
  )
  .split("\n");

describe("current Claude transcript surfaces", () => {
  it("recovers decisions from the answers map and retains the source law", () => {
    const messages = extractMessages(lines).messages;
    expect(messages.map((m) => m.text)).toEqual([
      '[decision] "Which database?" → SQLite\n\n[decision] "Which checks?" → Lint, Typecheck',
      "Build the migration.",
    ]);
    expect(
      extractTimeline(lines)
        .filter((e) => e.kind === "human")
        .map(({ timestamp, text }) => ({ timestamp, text })),
    ).toEqual(messages);
  });

  it("marks compaction as a boundary without treating summaries as human input", () => {
    expect(extractTimeline(lines).map((e) => e.kind)).toEqual([
      "question",
      "human",
      "boundary",
      "human",
    ]);
    expect(extractMessages(lines).drops.some((d) => d.reason.includes("isCompactSummary"))).toBe(
      true,
    );
  });
});
