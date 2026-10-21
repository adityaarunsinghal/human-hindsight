import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractCodexMessages, extractCodexTimeline } from "../src/sources/codex/extract.js";

const fixture = fs
  .readFileSync(
    path.join(
      import.meta.dirname,
      "fixtures/codex-home/sessions/2026/10/20",
      "rollout-2026-10-20T10-00-00-11111111-1111-1111-1111-111111111111.jsonl",
    ),
    "utf8",
  )
  .split("\n");
const entry = (type: string, payload: unknown, timestamp = "2026-10-21T10:00:00Z") =>
  JSON.stringify({ timestamp, type, payload });
const user = (text: string) =>
  entry("response_item", {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  });
const eventUser = (message: string) => entry("event_msg", { type: "user_message", message });

describe("Codex extraction fidelity", () => {
  it("recovers human input exactly once across CLI/IDE event mirrors", () => {
    const result = extractCodexMessages(fixture);
    expect(result.messages.map((m) => m.text)).toEqual([
      "Build a settings page.\n\n[image pasted]",
      '[decision] "Choose a layout" → Tabs',
      "yes",
      "Keep the old layout too.",
    ]);
    expect(result.drops.filter((d) => d.reason.startsWith("C3"))).toHaveLength(3);
    expect(result.drops.some((d) => d.reason.startsWith("C2"))).toBe(true);
    expect(result.badLines).toBe(0);
  });

  it("satisfies the source law and deduplicates assistant context too", () => {
    const timeline = extractCodexTimeline(fixture);
    expect(
      timeline
        .filter((e) => e.kind === "human")
        .map(({ timestamp, text }) => ({ timestamp, text })),
    ).toEqual(extractCodexMessages(fixture).messages);
    expect(timeline.filter((e) => e.kind === "assistant").map((e) => e.text)).toEqual([
      "Which layout should I use?",
      "The settings page is ready.",
      "Both layouts are available.",
    ]);
    expect(timeline.filter((e) => e.kind === "question").map((e) => e.text)).toEqual([
      "Choose a layout [Tabs, Sidebar]",
    ]);
    expect(timeline.filter((e) => e.kind === "boundary")).toHaveLength(1);
  });

  it("supports old response-only and event-only rollouts, including missing timestamps", () => {
    expect(
      extractCodexMessages([user("first"), user("second")]).messages.map((m) => m.text),
    ).toEqual(["first", "second"]);
    expect(
      extractCodexMessages([
        JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: "keep me" },
        }),
      ]).messages,
    ).toEqual([{ timestamp: "", text: "keep me" }]);
  });

  it("does not lose repeated identical replies, even across representation changes", () => {
    const lines = [user("yes"), eventUser("yes"), eventUser("yes"), user("yes")];
    expect(extractCodexMessages(lines).messages.map((m) => m.text)).toEqual(["yes", "yes"]);
    expect(extractCodexMessages([user("yes"), user("yes")]).messages).toHaveLength(2);
  });

  it("does not pair separate turns just because their text matches", () => {
    expect(
      extractCodexMessages([
        user("yes"),
        entry("event_msg", { type: "task_started" }),
        eventUser("yes"),
      ]).messages,
    ).toHaveLength(2);
  });

  it("retains human HTML and prose accompanying injected context", () => {
    expect(
      extractCodexMessages([
        user("<div>please fix this</div>"),
        user("<environment_context>machine context</environment_context>\nUse tabs."),
      ]).messages.map((m) => m.text),
    ).toEqual(["<div>please fix this</div>", "Use tabs."]);
  });

  it("counts bad lines without admitting tool, developer, or summary output", () => {
    const result = extractCodexMessages([
      "",
      "{bad",
      "null",
      "[]",
      user("real"),
      entry("response_item", { type: "function_call_output", output: "machine" }),
      entry("response_item", { type: "message", role: "developer", content: "machine" }),
      entry("compacted", { message: "machine summary" }),
    ]);
    expect(result.badLines).toBe(3);
    expect(result.messages.map((m) => m.text)).toEqual(["real"]);
  });

  it("rejects subagent/internal sessions without rejecting manually invoked exec", () => {
    for (const source of [{ subagent: "review" }, { internal: "memory" }, "subagent_review"]) {
      const lines = [entry("session_meta", { source }), user("generated")];
      expect(extractCodexMessages(lines).messages).toEqual([]);
      expect(extractCodexTimeline(lines)).toEqual([]);
    }
    expect(
      extractCodexMessages([entry("session_meta", { source: "exec" }), user("manual exec request")])
        .messages,
    ).toHaveLength(1);
  });
});
