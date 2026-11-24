import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractMessages, extractTimeline } from "../src/sources/claude/extract.js";

/** Load a synthetic fixture as raw JSONL lines (never the real ~/.claude). */
function load(name: string): string[] {
  const url = new URL(`./fixtures/extract/${name}`, import.meta.url);
  return readFileSync(url, "utf8").split(/\r?\n/);
}

/**
 * One row per rule fixture: the human text that must survive and the drop
 * reasons that must be recorded, in order. Every row is also checked against
 * the SessionSource law (extract and timeline give identical human turns). Wrapper
 * shapes beyond these fixtures are covered row by row in test/wrappers.test.ts.
 */
const RULES: { rule: string; fixture: string; kept: string[]; drops: string[] }[] = [
  {
    rule: "R1: user and attachment are candidates; an assistant turn is not a drop",
    fixture: "r1-admission.jsonl",
    kept: ["Please add a health check endpoint.", "Also add structured logging."],
    drops: [],
  },
  {
    rule: "R2: isMeta is rejected",
    fixture: "r2-meta.jsonl",
    kept: ["Real human message."],
    drops: ["R2: isMeta"],
  },
  {
    rule: "R2: a subagent thread is rejected",
    fixture: "r2-sidechain.jsonl",
    kept: [],
    drops: ["R2: isSidechain"],
  },
  {
    rule: "R2: compact summaries and transcript-only entries are rejected",
    fixture: "r2-compact-summary.jsonl",
    kept: [],
    drops: ["R2: isCompactSummary", "R2: isVisibleInTranscriptOnly"],
  },
  {
    rule: "R2: an sdk entrypoint is automation",
    fixture: "r2-sdk-entrypoint.jsonl",
    kept: [],
    drops: ["R2: sdk entrypoint"],
  },
  {
    // VS Code sets promptSource "sdk" on genuine typing; only entrypoint counts.
    rule: "R2 guard: promptSource sdk with a non-sdk entrypoint is kept",
    fixture: "r2-promptsource-guard.jsonl",
    kept: ["Typed by a human in VS Code — keep me."],
    drops: [],
  },
  {
    rule: "R3: only human queued prompts are admitted (legacy text field)",
    fixture: "r3-queued-command.jsonl",
    kept: ["Run the tests again."],
    drops: ["R3: non-human or non-prompt attachment", "R3: non-human or non-prompt attachment"],
  },
  {
    // Real transcripts carry the queued text in `prompt`; reading only `text`
    // once dropped every queued human message. A task-notification commandMode
    // and an assistant origin in the same file stay machine text.
    rule: "R3: the queued text is read from the real prompt field",
    fixture: "r3-queued-command-prompt-field.jsonl",
    kept: ["its ok let it cook"],
    drops: ["R3: non-human or non-prompt attachment", "R3: non-human or non-prompt attachment"],
  },
  {
    rule: "R4: string content is trimmed; a whitespace-only piece is dropped",
    fixture: "r4-string-content.jsonl",
    kept: ["Fix the flaky test in auth.spec.ts"],
    drops: ["R6: empty piece"],
  },
  {
    // Plain tool_result is machine output: ignored, not a drop.
    rule: "R5: only the follow-up after 'the user said:' is recovered",
    fixture: "r5-tool-rejection.jsonl",
    kept: ["Use a migration instead of editing the schema directly."],
    drops: [],
  },
  {
    rule: "R6: prose beside an IDE block survives; a reminder-only entry emits nothing",
    fixture: "r6-ide-block-survival.jsonl",
    kept: ["Refactor this file to use async/await."],
    drops: ["R6: machine block (leading <)", "R6: machine block (leading <)"],
  },
  {
    rule: "R6: interruption markers are dropped per piece",
    fixture: "r6-interruption.jsonl",
    kept: ["Stop and just show me the diff."],
    drops: ["R6: interruption marker", "R6: interruption marker"],
  },
  {
    rule: 'R7: decisions render as [decision] "Q" → A, multi-select joined',
    fixture: "r7-decision.jsonl",
    kept: [
      '[decision] "Which database should we use?" → PostgreSQL',
      '[decision] "Which features to include?" → Auth, Billing',
    ],
    drops: [],
  },
  {
    rule: "R10: slash commands with and without args; command output still drops",
    fixture: "r10-command.jsonl",
    kept: ["[command] /review src/", "[command] /deploy"],
    drops: ["R6: machine block (leading <)"],
  },
  {
    rule: "R11: an image becomes [image pasted] in position",
    fixture: "r11-image.jsonl",
    kept: ["Here's the screenshot of the error:\n\n[image pasted]", "[image pasted]"],
    drops: [],
  },
  {
    rule: "tolerant parsing: corrupt and non-object lines are skipped",
    fixture: "corrupt-lines.jsonl",
    kept: ["First valid message.", "Second valid message."],
    drops: [],
  },
];

describe("claude extract rules, one fixture each", () => {
  it.each(RULES)("$rule", ({ fixture, kept, drops }) => {
    const lines = load(fixture);
    const res = extractMessages(lines);
    expect(res.messages.map((m) => m.text)).toEqual(kept);
    expect(res.drops.map((d) => d.reason)).toEqual(drops);
    // SessionSource law: identical (timestamp, text) human turns, in file order.
    const human = extractTimeline(lines)
      .filter((e) => e.kind === "human")
      .map(({ timestamp, text }) => ({ timestamp, text }));
    expect(human).toEqual(res.messages.map(({ timestamp, text }) => ({ timestamp, text })));
  });
});

describe("tolerant parsing", () => {
  it("counts corrupt / non-object lines, never aborting (kept text: rules table)", () => {
    expect(extractMessages(load("corrupt-lines.jsonl")).badLines).toBe(3); // broken JSON, bare `42`, truncated object
  });

  it("tolerates entries missing a timestamp, preserving order with ts=''", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: "No timestamp here." } }),
    ];
    expect(extractMessages(lines).messages).toEqual([
      { timestamp: "", text: "No timestamp here." },
    ]);
  });

  it("ignores blank lines without counting them as corrupt", () => {
    const res = extractMessages(["", "   ", ""]);
    expect(res.messages).toEqual([]);
    expect(res.badLines).toBe(0);
  });
});

describe("mixed-session: the regression wall (exact output, in order)", () => {
  it("yields exactly the human messages, nothing else, with drops recorded", () => {
    const res = extractMessages(load("mixed-session.jsonl"));
    expect(res.messages.map((m) => m.text)).toEqual([
      "Set up a CI pipeline for this repo.",
      "Also run it on macOS.",
      "Use GitHub Actions, Node 22.",
      '[decision] "Which test runner?" → vitest',
      "[command] /review ci.yml",
      "See the failing run:\n\n[image pasted]",
      "Pin the action versions.",
    ]);
    expect(res.drops.map((d) => d.reason)).toEqual([
      "R2: isMeta",
      "R6: machine block (leading <)",
      "R6: interruption marker",
      "R6: empty piece",
    ]);
    expect(res.badLines).toBe(0);
    // Snippets are bounded for --verbose reporting.
    for (const drop of res.drops) expect(drop.snippet.length).toBeLessThanOrEqual(120);
  });

  it("preserves timestamps and agrees with the timeline (SessionSource law)", () => {
    const lines = load("mixed-session.jsonl");
    const res = extractMessages(lines);
    expect(res.messages[0]?.timestamp).toBe("2026-02-01T00:00:00.000Z");
    expect(res.messages.at(-1)?.timestamp).toBe("2026-02-01T00:00:08.000Z");
    const human = extractTimeline(lines)
      .filter((e) => e.kind === "human")
      .map(({ timestamp, text }) => ({ timestamp, text }));
    expect(human).toEqual(res.messages.map(({ timestamp, text }) => ({ timestamp, text })));
  });
});
