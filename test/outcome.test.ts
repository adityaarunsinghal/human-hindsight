import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCorpus, type CorpusSession } from "../src/core/dedupe.js";
import {
  buildOutcome,
  FINAL_TURNS,
  groupOutcome,
  OUTCOME_NOTE,
  TAIL_CHARS,
} from "../src/core/outcome.js";
import { extractMessages, extractTimeline } from "../src/sources/claude/extract.js";
import { extractCodexMessages, extractCodexTimeline } from "../src/sources/codex/extract.js";
import { extractKiroMessages, kiroTimeline } from "../src/sources/kiro/extract.js";
import { extractKiroV3Messages, kiroV3Timeline } from "../src/sources/kiro/extract-v3.js";
import { extractKirocrewMessages, kirocrewTimeline } from "../src/sources/kirocrew/extract.js";
import {
  extractOpenCodeMessages,
  extractOpenCodeTimeline,
} from "../src/sources/opencode/extract.js";
import type { ExtractResult, TimelineEvent } from "../src/sources/types.js";

function userLine(timestamp: string, text: string): string {
  return JSON.stringify({ type: "user", timestamp, message: { role: "user", content: text } });
}

function assistantText(timestamp: string, text: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function sidechainAssistant(timestamp: string, text: string): string {
  return JSON.stringify({
    type: "assistant",
    isSidechain: true,
    timestamp,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

const T1 = "2026-02-01T00:01:00.000Z";
const T2 = "2026-02-01T00:02:00.000Z";
const T3 = "2026-02-01T00:03:00.000Z";
const T4 = "2026-02-01T00:04:00.000Z";
const T5 = "2026-02-01T00:05:00.000Z";

function sessionOf(lines: string[]): CorpusSession {
  const corpus = buildCorpus([
    { project: "p", sessionId: "s", sourcePath: "/s", extracted: extractMessages(lines) },
  ]);
  const session = corpus.sessions[0];
  if (!session) throw new Error("no session built");
  return session;
}

describe("outcome: constants (exported for tests)", () => {
  it("pins the documented bounds", () => {
    expect(FINAL_TURNS).toBe(3);
    expect(TAIL_CHARS).toBe(1600);
    expect(OUTCOME_NOTE).toContain("distillation only");
  });
});

describe("outcome: final_human_turns", () => {
  it("keeps the last 3 deduped human turns, most recent last", () => {
    const outcome = buildOutcome(
      sessionOf([
        userLine(T1, "one"),
        userLine(T2, "two"),
        userLine(T3, "three"),
        userLine(T4, "four"),
      ]),
      [],
    );
    expect(outcome.final_human_turns).toEqual(["two", "three", "four"]);
  });

  it("returns all human turns when fewer than 3 exist", () => {
    const outcome = buildOutcome(
      sessionOf([userLine(T1, "only one"), userLine(T2, "and two")]),
      [],
    );
    expect(outcome.final_human_turns).toEqual(["only one", "and two"]);
  });
});

describe("outcome: final_assistant_tail", () => {
  it("captures the tail of the LAST assistant text turn, bounded and end-anchored", () => {
    const big = `HEAD_MARK${"z".repeat(2000)}TAIL_MARK`;
    const lines = [
      assistantText(T1, "first assistant"),
      userLine(T2, "go"),
      assistantText(T3, big),
    ];
    const outcome = buildOutcome(sessionOf(lines), extractTimeline(lines));
    expect(outcome.final_assistant_tail.length).toBe(TAIL_CHARS);
    expect(outcome.final_assistant_tail.endsWith("TAIL_MARK")).toBe(true);
    expect(outcome.final_assistant_tail.includes("HEAD_MARK")).toBe(false);
  });

  it("uses the last assistant text turn, not an earlier one", () => {
    const lines = [
      assistantText(T1, "first assistant"),
      userLine(T2, "go"),
      assistantText(T3, "LAST assistant"),
    ];
    const outcome = buildOutcome(sessionOf(lines), extractTimeline(lines));
    expect(outcome.final_assistant_tail).toBe("LAST assistant");
  });

  it("is '' when the session has no assistant text turn", () => {
    const lines = [userLine(T1, "hello"), userLine(T2, "there")];
    const outcome = buildOutcome(sessionOf(lines), extractTimeline(lines));
    expect(outcome.final_assistant_tail).toBe("");
  });

  it("ignores sidechain assistant turns (R2 reuse)", () => {
    const lines = [
      assistantText(T4, "REAL final assistant"),
      sidechainAssistant(T5, "SIDECHAIN must not surface"),
      userLine(T5, "ok"),
    ];
    const outcome = buildOutcome(sessionOf(lines), extractTimeline(lines));
    expect(outcome.final_assistant_tail).toBe("REAL final assistant");
  });
});

describe("outcome: human_spoke_last", () => {
  const at = (kind: TimelineEvent["kind"], text = "x"): TimelineEvent =>
    ({ kind, timestamp: T1, text }) as TimelineEvent;
  const session = sessionOf([userLine(T1, "hi")]);

  it.each<[string, TimelineEvent[], boolean | undefined]>([
    ["the assistant's message came last", [at("human"), at("assistant")], false],
    ["the person wrote after it", [at("human"), at("assistant"), at("human")], true],
    ["only the person wrote", [at("human"), at("human")], true],
    ["only the assistant wrote", [at("assistant")], false],
    [
      "a status or boundary after the assistant is not the person",
      [at("human"), at("assistant"), at("status"), at("boundary")],
      false,
    ],
    ["an empty human turn is not the person writing", [at("assistant"), at("human", "  ")], false],
    [
      "a question or plan after the person does not count as the assistant",
      [at("assistant"), at("human"), at("question"), at("plan")],
      true,
    ],
    ["no turns at all", [], undefined],
  ])("%s", (_name, timeline, expected) => {
    const outcome = buildOutcome(session, timeline);
    expect(outcome.human_spoke_last).toBe(expected);
    expect("human_spoke_last" in outcome).toBe(expected !== undefined);
  });

  // Each source's own timeline, so the field holds for what each one emits.
  const fixtures = path.join(import.meta.dirname, "fixtures");
  const read = (file: string) => fs.readFileSync(path.join(fixtures, file), "utf8").split(/\r?\n/);
  const opencodeRow = (info: unknown) => JSON.stringify({ format: "v2", info });
  const opencode = (lastUser: boolean) => [
    opencodeRow({ id: "m1", type: "user", text: "Ship it", time: { created: 1792490400000 } }),
    opencodeRow({ id: "m2", type: "assistant", content: [{ type: "text", text: "Shipped." }] }),
    ...(lastUser
      ? [
          opencodeRow({
            id: "m3",
            type: "user",
            text: "It still fails",
            time: { created: 1792490400001 },
          }),
        ]
      : []),
  ];
  const claude = (lastUser: boolean) => [
    userLine(T1, "ship it"),
    assistantText(T2, "Shipped."),
    ...(lastUser ? [userLine(T3, "it still fails")] : []),
  ];
  it.each<
    [
      string,
      string[],
      (lines: string[]) => ExtractResult,
      (lines: string[]) => TimelineEvent[],
      boolean,
    ]
  >([
    ["claude, assistant last", claude(false), extractMessages, extractTimeline, false],
    ["claude, person last", claude(true), extractMessages, extractTimeline, true],
    [
      "codex, assistant last",
      read(
        "codex-home/sessions/2026/10/20/rollout-2026-10-20T10-00-00-11111111-1111-1111-1111-111111111111.jsonl",
      ),
      extractCodexMessages,
      extractCodexTimeline,
      false,
    ],
    [
      "kiro, assistant last",
      read("kiro-extract/k1-prompt.jsonl"),
      extractKiroMessages,
      kiroTimeline,
      false,
    ],
    [
      "kiro, person last after a clear",
      read("kiro-extract/k12-boundaries.jsonl"),
      extractKiroMessages,
      kiroTimeline,
      true,
    ],
    [
      "kiro v3, assistant last",
      read("kiro-v3/user-assistant.jsonl"),
      extractKiroV3Messages,
      kiroV3Timeline,
      false,
    ],
    [
      "kiro crew, person last",
      read("kirocrew-extract/c4-steer.jsonl"),
      extractKirocrewMessages,
      kirocrewTimeline,
      true,
    ],
    [
      "kiro crew, a status after the assistant",
      read("kirocrew-extract/c1-non-user-roles.jsonl"),
      extractKirocrewMessages,
      kirocrewTimeline,
      false,
    ],
    [
      "opencode, assistant last",
      opencode(false),
      extractOpenCodeMessages,
      extractOpenCodeTimeline,
      false,
    ],
    [
      "opencode, person last",
      opencode(true),
      extractOpenCodeMessages,
      extractOpenCodeTimeline,
      true,
    ],
  ])("%s", (_name, lines, extract, timeline, expected) => {
    const built = buildCorpus([
      { project: "p", sessionId: "s", sourcePath: "/s", extracted: extract(lines) },
    ]).sessions[0];
    if (!built) throw new Error("no session built");
    expect(buildOutcome(built, timeline(lines)).human_spoke_last).toBe(expected);
  });
});

describe("groupOutcome: which groups get a prompt", () => {
  type Label = "completed" | "partial" | "abandoned" | "unclear" | undefined;
  it.each<[string, Label[], ReturnType<typeof groupOutcome>]>([
    ["one completed", ["completed"], "verified"],
    ["one partial", ["partial"], "verified"],
    ["one unclear", ["unclear"], "unverified"],
    ["one abandoned", ["abandoned"], "abandoned"],
    ["one member with no digest", [undefined], "unverified"],
    ["completed beside abandoned and unclear", ["abandoned", "unclear", "completed"], "verified"],
    ["partial beside abandoned", ["abandoned", "partial"], "verified"],
    ["all unclear", ["unclear", "unclear"], "unverified"],
    ["unclear beside abandoned", ["abandoned", "unclear"], "unverified"],
    ["a missing digest beside abandoned", ["abandoned", undefined], "unverified"],
    ["all abandoned", ["abandoned", "abandoned", "abandoned"], "abandoned"],
    ["no members", [], "abandoned"],
  ])("%s", (_name, labels, expected) => {
    expect(groupOutcome(labels)).toBe(expected);
  });
});
