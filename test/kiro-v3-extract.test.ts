import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { KiroSessionMeta } from "../src/sources/kiro/discover.js";
import {
  classifyKiroV3Lines,
  classifyKiroV3Session,
  detectKiroFormat,
  extractKiroV3Messages,
  kiroV3Timeline,
} from "../src/sources/kiro/extract-v3.js";

const FIX = path.join(import.meta.dirname, "fixtures", "kiro-v3");
function lines(name: string): string[] {
  return fs.readFileSync(path.join(FIX, name), "utf8").split(/\r?\n/);
}
function v2Lines(name: string): string[] {
  return fs
    .readFileSync(path.join(import.meta.dirname, "fixtures", "kiro-extract", name), "utf8")
    .split(/\r?\n/);
}

describe("kiro v3 extract: user admission", () => {
  it("extracts only `user` text with the in-band ISO timestamp", () => {
    const { messages, badLines } = extractKiroV3Messages(lines("user-assistant.jsonl"));
    expect(messages).toEqual([{ timestamp: "2026-08-01T10:00:01.000Z", text: "do the thing" }]);
    // assistant (Say/Reasoning), tool_call/result, session_start, turn_end are machine.
    expect(badLines).toBe(0);
  });

  it("records an empty user body as an observable Drop, never silently", () => {
    const { messages, drops } = extractKiroV3Messages(lines("empty-user.jsonl"));
    expect(messages.map((m) => m.text)).toEqual(["real message"]);
    expect(drops.map((d) => d.reason)).toContain("V3: empty user content");
  });

  it("counts a corrupt line in badLines without aborting", () => {
    const { messages, badLines } = extractKiroV3Messages(lines("badline.jsonl"));
    expect(messages.map((m) => m.text)).toEqual(["good line"]);
    expect(badLines).toBe(1);
  });
});

describe("kiro v3 timeline: human + assistant Say, reasoning omitted", () => {
  it("emits a human turn and an assistant Say turn, skipping Reasoning and tools", () => {
    const timeline = kiroV3Timeline(lines("user-assistant.jsonl"));
    expect(timeline.map((e) => e.kind)).toEqual(["human", "assistant"]);
    expect(timeline.map((e) => e.text)).toEqual(["do the thing", "done, here is the result"]);
  });
});

describe("kiro v3: SessionSource law (extract ↔ timeline agreement)", () => {
  for (const fixture of [
    "user-assistant.jsonl",
    "empty-user.jsonl",
    "badline.jsonl",
    "classify-plain.jsonl",
  ]) {
    it(`holds for ${fixture}`, () => {
      const msgs = extractKiroV3Messages(lines(fixture)).messages;
      const human = kiroV3Timeline(lines(fixture)).filter((e) => e.kind === "human");
      expect(human.map((e) => ({ timestamp: e.timestamp, text: e.text }))).toEqual(
        msgs.map((m) => ({ timestamp: m.timestamp, text: m.text })),
      );
    });
  }
});

describe("kiro v3: harness envelopes on a user entry (V4)", () => {
  // Synthetic copies of the envelope shapes the v2 store carries (K14, K6).
  const TS = "2026-10-21T10:00:00.000Z";
  const v3 = (content: string, id: string) =>
    JSON.stringify({ id, timestamp: TS, payload: { type: "user", content } });
  const steering =
    "[LIVE STEERING - New message from user]\n\n" +
    "The user sent a new message while you are working. As the currently active agent, adjust your approach if necessary based on this guidance.\n\n" +
    '<user_message id="steer-1">\nuse offset pagination instead\n</user_message>\n\n' +
    "IMPORTANT: After completing your work, include a brief note about how you handled this steering message.";

  it.each([
    {
      name: "a live-steering envelope keeps only the typed words",
      content: steering,
      kept: ["use offset pagination instead"],
      drops: [],
    },
    {
      name: "a subagent completion event is dropped with a record",
      content: "[Subagent completion event]\nThe worker finished: 3 files changed.",
      kept: [],
      drops: ["K6: bracket marker"],
    },
    {
      name: "a steering envelope with no message body is dropped with a record",
      content: "[LIVE STEERING - New message from user]\nno body here",
      kept: [],
      drops: ["K6: bracket marker"],
    },
    {
      name: "a harness nudge is dropped with a record",
      content: "You took too long to respond. Continue.",
      kept: [],
      drops: ["K6: harness nudge"],
    },
    {
      name: "a person quoting the marker mid-message is kept whole",
      content: "why does [Subagent completion event] show up in my log?",
      kept: ["why does [Subagent completion event] show up in my log?"],
      drops: [],
    },
  ])("$name, in extract and timeline", ({ content, kept, drops }) => {
    const input = [v3("start the migration", "a"), v3(content, "b")];
    const result = extractKiroV3Messages(input);
    expect(result.messages.map((m) => m.text)).toEqual(["start the migration", ...kept]);
    expect(result.drops.map((d) => d.reason)).toEqual(drops);
    expect(
      kiroV3Timeline(input)
        .filter((e) => e.kind === "human")
        .map(({ timestamp, text }) => ({ timestamp, text })),
    ).toEqual(result.messages);
  });

  it("leaves classification on the raw body: a lone nudge session is still automation", () => {
    const meta: KiroSessionMeta = { hasHistory: false };
    expect(classifyKiroV3Lines(meta, [v3("You took too long to respond", "a")]).include).toBe(
      false,
    );
  });
});

describe("detectKiroFormat: v2 vs v3 sniffing", () => {
  it("classifies a payload-shaped line as v3", () => {
    expect(detectKiroFormat(lines("user-assistant.jsonl"))).toBe("v3");
  });
  it("classifies a {version,kind,data} line as v2", () => {
    expect(detectKiroFormat(v2Lines("k1-prompt.jsonl"))).toBe("v2");
  });
  it("defaults to v2 on an empty/unparseable file (harmless)", () => {
    expect(detectKiroFormat(["", "   ", "{not json"])).toBe("v2");
  });
});

describe("kiro v3 classify: recall-oriented precedence", () => {
  const noHistory: KiroSessionMeta = { hasHistory: false };

  it("EXCLUDES a human-hindsight distill session (K13 self-recognition)", () => {
    const verdict = classifyKiroV3Lines(noHistory, lines("classify-distill.jsonl"));
    expect(verdict.include).toBe(false);
    expect(verdict.reason).toContain("K13");
  });

  it("K13 is absolute: a distill session is excluded even with .history", () => {
    const withHistory: KiroSessionMeta = { hasHistory: true };
    expect(classifyKiroV3Lines(withHistory, lines("classify-distill.jsonl")).include).toBe(false);
  });

  it("INCLUDES a session with .history over an automation-marker first prompt", () => {
    const withHistory: KiroSessionMeta = { hasHistory: true };
    const verdict = classifyKiroV3Lines(withHistory, lines("classify-boilerplate.jsonl"));
    expect(verdict.include).toBe(true);
    expect(verdict.reason).toContain(".history present");
  });

  it("EXCLUDES an automation-agent boilerplate first prompt with no .history", () => {
    const verdict = classifyKiroV3Lines(noHistory, lines("classify-boilerplate.jsonl"));
    expect(verdict.include).toBe(false);
    expect(verdict.kind).toBeUndefined();
  });

  it("EXCLUDES an [AGENT SYSTEM PROMPT] first prompt as K15, even with .history", () => {
    // K15 runs before the .history check: the Kiro Crew store owns these runs.
    for (const meta of [noHistory, { hasHistory: true }]) {
      const verdict = classifyKiroV3Lines(meta, lines("classify-agent-prompt.jsonl"));
      expect(verdict.include).toBe(false);
      expect(verdict.kind).toBe("kirocrew");
    }
  });

  it("INCLUDES a plain interactive session (recall default) with no .history", () => {
    const verdict = classifyKiroV3Lines(noHistory, lines("classify-plain.jsonl"));
    expect(verdict.include).toBe(true);
    expect(verdict.reason).toContain("recall-oriented default");
  });

  it("does NOT exclude on parentSessionId: a top-level v3 fork is human", () => {
    // Unlike v2 K2 step 2, a parent-linked v3 session with a plain prompt is kept
    // (true subagents live under sub-executions/ and are never enumerated).
    const fork: KiroSessionMeta = { hasHistory: false, parentSessionId: "sess_parent" };
    expect(classifyKiroV3Session(fork, "continue from the fork please").include).toBe(true);
  });
});
