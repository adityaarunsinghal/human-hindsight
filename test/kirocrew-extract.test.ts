import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractKirocrewMessages,
  KIROCREW_USER_ENVELOPES,
  kirocrewTimeline,
} from "../src/sources/kirocrew/extract.js";

const FIX = path.join(import.meta.dirname, "fixtures", "kirocrew-extract");
const CHAT = path.join(
  import.meta.dirname,
  "fixtures",
  "kirocrew-home",
  "sessions",
  "dashboard_chat-1-1760000000.jsonl",
);
function lines(name: string): string[] {
  return fs.readFileSync(path.join(FIX, name), "utf8").split(/\r?\n/);
}
const texts = (name: string) => extractKirocrewMessages(lines(name)).messages.map((m) => m.text);
const reasons = (name: string) => extractKirocrewMessages(lines(name)).drops.map((d) => d.reason);

describe("kirocrew extract: rules C1 to C7", () => {
  it("C1: only role user records are candidates; other roles are neither messages nor drops", () => {
    const { messages, drops, badLines } = extractKirocrewMessages(lines("c1-non-user-roles.jsonl"));
    expect(messages).toEqual([
      { timestamp: "2026-02-01T10:00:00.000000+00:00", text: "the only human line" },
    ]);
    expect(drops).toEqual([]);
    expect(badLines).toBe(0);
  });

  it("C2: metadata and archive lines are not messages and not drops", () => {
    const { messages, drops, badLines } = extractKirocrewMessages(lines("c2-bookkeeping.jsonl"));
    expect(messages.map((m) => m.text)).toEqual([
      "before the archive marker",
      "after the archive marker",
    ]);
    expect(drops).toEqual([]);
    expect(badLines).toBe(0);
  });

  it("C3: meta.human === false drops the record; an absent flag keeps it", () => {
    expect(texts("c3-human-false.jsonl")).toEqual([
      "flag true",
      "flag absent",
      "no meta at all",
      "unparseable string meta",
    ]);
    const { drops } = extractKirocrewMessages(lines("c3-human-false.jsonl"));
    expect(drops.map((d) => [d.reason, d.snippet])).toEqual([
      ["C3: harness-marked non-human", "relayed by the harness"],
      ["C3: harness-marked non-human", "relayed with string meta"],
    ]);
  });

  it("C4: a steer is kept verbatim with no marker", () => {
    expect(extractKirocrewMessages(lines("c4-steer.jsonl")).messages).toEqual([
      { timestamp: "2026-02-01T10:00:00.000000+00:00", text: "start the migration" },
      {
        timestamp: "2026-02-01T10:00:02.000000+00:00",
        text: "wait, use the staging table instead",
      },
    ]);
  });

  it("C5: empty, whitespace-only and missing content are observable drops", () => {
    expect(texts("c5-empty.jsonl")).toEqual(["the real turn"]);
    const { drops } = extractKirocrewMessages(lines("c5-empty.jsonl"));
    expect(drops.map((d) => d.reason)).toEqual([
      "C5: empty user content",
      "C5: empty user content",
      "C5: empty user content",
    ]);
    expect(drops[0]?.timestamp).toBe("2026-02-01T10:00:00.000000+00:00");
  });

  it("C6: a user record opening with a harness envelope is an observable drop", () => {
    expect(KIROCREW_USER_ENVELOPES).toEqual([
      "[Subagent completion event",
      "[auto-nudge",
      "[Cron notification",
      "[Kiro Crew host notice]",
    ]);
    expect(reasons("c6-envelope.jsonl")).toEqual(
      Array(4).fill("C6: harness envelope on user role"),
    );
    // A marker mid-sentence is the person talking about it, not an envelope.
    expect(texts("c6-envelope.jsonl")).toEqual(["why did [auto-nudge] fire twice?"]);
  });

  it("C7: corrupt lines count in badLines without aborting", () => {
    const { messages, badLines } = extractKirocrewMessages(lines("c7-corrupt.jsonl"));
    expect(messages.map((m) => m.text)).toEqual(["good line", "still read after the bad lines"]);
    expect(badLines).toBe(3);
  });

  it("tolerates a missing ts as an empty timestamp", () => {
    const result = extractKirocrewMessages(['{"role":"user","content":"no ts","meta":{}}']);
    expect(result.messages).toEqual([{ timestamp: "", text: "no ts" }]);
  });
});

describe("kirocrew extract: the full synthetic chat", () => {
  const raw = fs.readFileSync(CHAT, "utf8").split(/\r?\n/);
  const result = extractKirocrewMessages(raw);

  it("keeps exactly the human turns, in file order", () => {
    expect(result.messages.map((m) => m.text)).toEqual([
      "please refactor the widget parser",
      "go with option two",
      "actually skip the tests for now",
      "meta arrived as a string",
      "thanks, ship it",
    ]);
  });

  it("records every drop with its rule id", () => {
    expect(result.drops.map((d) => d.reason)).toEqual([
      "C5: empty user content",
      "C6: harness envelope on user role",
      "C3: harness-marked non-human",
    ]);
    expect(result.badLines).toBe(1);
  });
});

describe("kirocrew timeline", () => {
  it("emits human, assistant and status events only", () => {
    const events = kirocrewTimeline(lines("c1-non-user-roles.jsonl"));
    expect(events.map((e) => [e.kind, e.text])).toEqual([
      ["human", "the only human line"],
      ["assistant", "assistant reply"],
      ["status", "throttled, retrying"],
    ]);
  });

  it("never emits a boundary and never surfaces non-user roles as human", () => {
    const events = kirocrewTimeline(fs.readFileSync(CHAT, "utf8").split(/\r?\n/));
    expect(new Set(events.map((e) => e.kind))).toEqual(new Set(["human", "assistant", "status"]));
    expect(events.filter((e) => e.kind === "status").map((e) => e.text)).toEqual([
      "Throttled by the model provider, retrying in 5s",
    ]);
    expect(events.filter((e) => e.kind === "assistant").map((e) => e.text)).toEqual([
      "Here is a plan with two options.",
      "Done.",
    ]);
  });
});

describe("kirocrew: SessionSource law (extract and timeline agree)", () => {
  const fixtures: [string, string[]][] = [
    ...fs
      .readdirSync(FIX)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f): [string, string[]] => [f, lines(f)]),
    ["dashboard_chat-1-1760000000.jsonl", fs.readFileSync(CHAT, "utf8").split(/\r?\n/)],
  ];
  for (const [name, raw] of fixtures) {
    it(`holds for ${name}`, () => {
      const msgs = extractKirocrewMessages(raw).messages;
      const human = kirocrewTimeline(raw).filter((e) => e.kind === "human");
      expect(human.map((e) => ({ timestamp: e.timestamp, text: e.text }))).toEqual(
        msgs.map((m) => ({ timestamp: m.timestamp, text: m.text })),
      );
    });
  }
});
