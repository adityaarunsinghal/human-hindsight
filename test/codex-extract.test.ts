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

  // The IDE writes its context, then the request heading on its own line, then
  // the request. A selection inside the context can contain the same heading,
  // so the request starts after the LAST heading that begins a line (Codex's
  // own transcript view reads it the same way).
  it.each([
    {
      name: "plain IDE context",
      text: "# Context from my IDE setup:\n\n## Active file: src/a.ts\n\n## My request for Codex:\nrename the helper",
      want: "rename the helper",
    },
    {
      name: "a selection that contains the request heading",
      text: "# Context from my IDE setup:\n\n## Active selection of the file:\nconst marker = 1;\n## My request for Codex:\nselected file text\n\n## Open tabs:\n- a.ts\n\n## My request for Codex:\nexplain this selection",
      want: "explain this selection",
    },
    {
      name: "a message that is only the heading and a request",
      text: "## My request for Codex:\nrun the tests",
      want: "run the tests",
    },
    {
      name: "a heading quoted in the middle of a line stays part of the request",
      text: "# Context from my IDE setup:\n\n## Open tabs:\n- a.ts\n\n## My request for Codex:\nwhy does the text ## My request for Codex: appear twice?",
      want: "why does the text ## My request for Codex: appear twice?",
    },
    {
      name: "typed text without IDE context is left alone",
      text: "what does ## My request for Codex: mean in this log?",
      want: "what does ## My request for Codex: mean in this log?",
    },
  ])("takes the request after the IDE context: $name", ({ text, want }) => {
    for (const line of [user(text), eventUser(text)]) {
      const messages = extractCodexMessages([line]).messages.map((m) => m.text);
      expect(messages).toEqual([want]);
      expect(
        extractCodexTimeline([line])
          .filter((e) => e.kind === "human")
          .map((e) => e.text),
      ).toEqual(messages);
    }
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

  // C2: Codex writes its context blocks whole, at the start of a message. The
  // same tag names inside what the person typed are the person's words.
  it.each([
    [
      "a skill element in the middle of a question",
      "Why does my plugin manifest ignore <skill>retry-on-timeout</skill> after the upgrade?",
    ],
    [
      "a pasted SVG image element",
      'This SVG renders blank:\n<svg width="10" height="10"><image href="logo.png"/></svg>\nwhy?',
    ],
    [
      "an XML permissions block",
      "Is this valid?\n<permissions>\n  <allow>read</allow>\n</permissions>",
    ],
    ["a leading tag in another letter case", "<Skill>x</Skill> is my component, why is it blank?"],
    ["a leading context tag that is never closed", "<permissions> is the root element I need"],
    ["a leading image element with its own attributes", '<image href="a.png"/> is not shown'],
    ["IDE-like text that is not at the start", "see # Context from my IDE setup: in the log"],
  ])("keeps %s verbatim", (_name, typed) => {
    for (const line of [user(typed), eventUser(typed)]) {
      expect(extractCodexMessages([line]).messages.map((m) => m.text)).toEqual([typed]);
    }
  });

  it.each([
    [
      "one leading context block",
      "<permissions>\nsandbox: read-only\n</permissions>\nfix the test",
      "fix the test",
    ],
    [
      "repeated leading blocks and the AGENTS.md block",
      "<environment_context>cwd</environment_context>\n# AGENTS.md instructions for /work/app\n\n<INSTRUCTIONS>\nrules\n</INSTRUCTIONS>\n<skill>\n<name>x</name>\n</skill>\nrun the linter",
      "run the linter",
    ],
    [
      "a context block whose body holds the same tag",
      "<skill>a <skill>b</skill> c</skill>\nship it",
      "ship it",
    ],
    [
      // Shape seen in real rollouts for instructions that apply everywhere:
      // the heading names no folder.
      "the AGENTS.md block whose heading names no folder",
      "# AGENTS.md instructions\n\n<INSTRUCTIONS>\n<!-- generated -->\nAlways be brief.\n</INSTRUCTIONS>\nreview the delivery page",
      "review the delivery page",
    ],
  ])("removes %s with a record", (_name, raw, want) => {
    const result = extractCodexMessages([user(raw)]);
    expect(result.messages.map((m) => m.text)).toEqual([want]);
    expect(result.drops.map((d) => d.reason)).toEqual(["C2: injected context"]);
  });

  it("removes the image markers Codex writes, only in their exact shape", () => {
    const lines = [
      entry("response_item", {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "<image name=[Image #1]>" },
          { type: "input_image", image_url: "data:image/png;base64,fixture" },
          { type: "input_text", text: "</image>" },
          { type: "input_text", text: "what is in this screenshot?" },
        ],
      }),
    ];
    expect(extractCodexMessages(lines).messages.map((m) => m.text)).toEqual([
      "[image pasted]\n\nwhat is in this screenshot?",
    ]);
    expect(extractCodexMessages([user("<image> tags are deprecated?")]).messages).toHaveLength(1);
  });

  it("removes the marker of an image attached from a file, which carries the file's path", () => {
    // Shape seen in real rollouts: the opening marker names the image and the
    // local file it came from. The path must not reach the export.
    const lines = [
      entry("response_item", {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: '<image name=[Image #1] path="/tmp/shots/Screenshot 2026-01-01 at 1.00.00 PM.png">',
          },
          { type: "input_image", image_url: "data:image/png;base64,fixture" },
          { type: "input_text", text: "</image>" },
          { type: "input_text", text: "is the layout broken here? [Image #1]" },
        ],
      }),
    ];
    const texts = extractCodexMessages(lines).messages.map((m) => m.text);
    expect(texts).toEqual(["[image pasted]\n\nis the layout broken here? [Image #1]"]);
    expect(texts.join("\n")).not.toContain("/tmp/shots");
    expect(
      extractCodexTimeline(lines)
        .filter((e) => e.kind === "human")
        .map((e) => e.text),
    ).toEqual(texts);
  });

  it("a message that is only the AGENTS.md block, with or without a folder, is not a typed message", () => {
    for (const heading of ["# AGENTS.md instructions for /work/app", "# AGENTS.md instructions"]) {
      const raw = `${heading}\n\n<INSTRUCTIONS>\nAlways be brief.\n</INSTRUCTIONS>`;
      const result = extractCodexMessages([user(raw)]);
      expect(result.messages).toEqual([]);
      expect(result.drops.map((d) => d.reason)).toEqual(["C2: injected context"]);
      expect(extractCodexTimeline([user(raw)]).filter((e) => e.kind === "human")).toEqual([]);
    }
  });

  it("drops IDE context that has no request, with a record", () => {
    const text = "# Context from my IDE setup:\n\n## Open tabs:\n- a.ts\n- b.ts";
    for (const line of [user(text), eventUser(text)]) {
      const result = extractCodexMessages([line]);
      expect(result.messages).toEqual([]);
      expect(result.drops.map((d) => d.reason)).toEqual(["C2: IDE context without a request"]);
      expect(extractCodexTimeline([line]).filter((e) => e.kind === "human")).toEqual([]);
    }
  });
  it("keeps a shell command typed with ! as [command] and drops its exit code and output", () => {
    // Codex records `!git status` as a user message of its own; no
    // `user_message` event mirrors it. Its result is machine text.
    const shell = [
      "<user_shell_command>",
      "<command>",
      "git status",
      "</command>",
      "<result>",
      "Exit code: 0",
      "Duration: 0.1200 seconds",
      "Output:",
      "On branch main",
      "nothing to commit, working tree clean",
      "</result>",
      "</user_shell_command>",
    ].join("\n");
    // Output can print the closing tag itself; the last closer ends the block.
    const tricky = shell.replace("On branch main", "echo '</user_shell_command>'");
    for (const raw of [shell, tricky]) {
      const lines = [user(raw), user("now add a test for it")];
      const result = extractCodexMessages(lines);
      const texts = result.messages.map((m) => m.text);
      expect(texts).toEqual(["[command] !git status", "now add a test for it"]);
      expect(result.drops.map((d) => d.reason)).toEqual(["C2: shell command result"]);
      expect(result.drops[0]?.snippet).toContain("Exit code: 0");
      expect(
        extractCodexTimeline(lines)
          .filter((e) => e.kind === "human")
          .map((e) => e.text),
      ).toEqual(texts);
    }
    // The same words typed as prose are the person's.
    const typed = "what does <user_shell_command> mean in a rollout?";
    expect(extractCodexMessages([user(typed)]).messages.map((m) => m.text)).toEqual([typed]);
  });
});
