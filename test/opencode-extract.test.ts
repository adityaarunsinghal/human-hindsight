import { describe, expect, it } from "vitest";
import { buildDigestPrompt } from "../src/claude/prompts/digest.js";
import { buildCorpus } from "../src/core/dedupe.js";
import { buildOutcome } from "../src/core/outcome.js";
import {
  extractOpenCodeMessages,
  extractOpenCodeTimeline,
} from "../src/sources/opencode/extract.js";

const time = 1792490400000;
const row = (format: "v1" | "v2", info: unknown, parts?: unknown[]) =>
  JSON.stringify({ format, info, parts });

describe("OpenCode human-input fidelity", () => {
  it("recovers v1 answers and images while removing synthetic context", () => {
    const lines = [
      row("v1", { id: "msg1", role: "user", time: { created: time } }, [
        { type: "text", text: "Build the settings page" },
        { type: "text", text: "Injected file context", synthetic: true },
        { type: "text", text: "Ignored context", ignored: true },
        { type: "file", mime: "image/png", url: "data:image/png;base64,private" },
      ]),
      row("v1", { id: "msg2", role: "assistant" }, [
        {
          type: "tool",
          tool: "question",
          state: {
            status: "completed",
            time: { end: time + 1 },
            input: { questions: [{ question: "Which theme?", options: [{ label: "Dark" }] }] },
            metadata: { answers: [["Dark", "Follow system"]] },
          },
        },
      ]),
    ];
    const result = extractOpenCodeMessages(lines);
    expect(result.messages.map((m) => m.text)).toEqual([
      "Build the settings page\n\n[image pasted]",
      "[decision] Which theme? → Dark, Follow system",
    ]);
    expect(result.drops).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("base64");
    expect(
      extractOpenCodeTimeline(lines)
        .filter((e) => e.kind === "human")
        .map(({ text, timestamp }) => ({ text, timestamp })),
    ).toEqual(result.messages);
  });

  it("handles native v2 records, compaction boundaries, question answers, and execution failure", () => {
    const lines = [
      row("v2", {
        id: "m1",
        type: "user",
        text: "Ship it",
        time: { created: time },
        files: [{ mediaType: "image/png" }],
      }),
      row("v2", { id: "m2", type: "synthetic", text: "Continue automatically" }),
      row("v2", { id: "m3", type: "system", text: "Internal rules" }),
      row("v2", {
        id: "m4",
        type: "assistant",
        content: [
          {
            type: "tool",
            name: "question",
            time: { completed: time + 2 },
            state: {
              status: "completed",
              input: { questions: [{ question: "Ship where?" }] },
              metadata: { answers: [["Staging"]] },
            },
          },
          { type: "text", text: "Working on it." },
        ],
      }),
      row("v2", {
        id: "m5",
        type: "compaction",
        status: "completed",
        summary: "Generated summary",
      }),
      row("v2", { id: "m6", type: "user", text: "Retry deployment", time: { created: time + 3 } }),
      row("v2", { id: "m7", type: "idle", outcome: "failed" }),
    ];
    const extracted = extractOpenCodeMessages(lines);
    const timeline = extractOpenCodeTimeline(lines);
    expect(extracted.messages.map((m) => m.text)).toEqual([
      "Ship it\n\n[image pasted]",
      "[decision] Ship where? → Staging",
      "Retry deployment",
    ]);
    expect(timeline.some((e) => e.kind === "boundary")).toBe(true);
    const session = buildCorpus([{ project: "p", sessionId: "s", sourcePath: "db#s", extracted }])
      .sessions[0];
    if (!session) throw new Error("missing corpus");
    const outcome = buildOutcome(session, timeline);
    expect(outcome.final_execution_status).toBe("OpenCode execution failed");
    expect(
      buildDigestPrompt({ exportName: "p.md", content: "prompts", origin: "opencode", outcome }),
    ).toContain("OpenCode execution failed");
  });

  it("keeps repeated human replies but pairs duplicate persisted IDs only once", () => {
    const first = row("v2", { id: "m1", type: "user", text: "yes", time: { created: time } });
    const second = row("v2", { id: "m2", type: "user", text: "yes", time: { created: time + 1 } });
    expect(extractOpenCodeMessages([first, first, second]).messages.map((m) => m.text)).toEqual([
      "yes",
      "yes",
    ]);
  });

  it("does not invent answers for unanswered questions or boundaries for failed compaction", () => {
    const lines = [
      row("v2", { type: "compaction", status: "failed" }),
      row("v2", {
        type: "assistant",
        content: [
          {
            type: "tool",
            name: "question",
            state: { status: "error", input: { questions: [{ question: "Choose" }] } },
          },
        ],
      }),
    ];
    expect(extractOpenCodeMessages(lines).messages).toEqual([]);
    expect(extractOpenCodeTimeline(lines).map((e) => e.kind)).toEqual(["question"]);
  });

  it("recognizes v1 successful compaction, tolerates corrupt rows, and excludes generated prompts", () => {
    const lines = [
      "{bad",
      row("v1", { role: "assistant", summary: true }, [{ type: "text", text: "Machine summary" }]),
      row("v2", { type: "user", text: "[human-hindsight distill]\nGenerated request" }),
      row("v2", { type: "shell", command: "npm test", output: "large machine result" }),
    ];
    const result = extractOpenCodeMessages(lines);
    expect(result.badLines).toBe(1);
    expect(result.messages.map((m) => m.text)).toEqual(["[command] npm test"]);
    expect(extractOpenCodeTimeline(lines)[0]?.kind).toBe("boundary");
  });
});
