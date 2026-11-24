/**
 * Leading machine wrappers (rules R6 and K6), one table per source.
 *
 * Each row is one human-side piece as the CLI stores it. The row states the
 * text that must survive and the drop reasons that must be recorded, so a
 * regression in either direction fails: machine text admitted as human, or
 * human text dropped. Every row is also checked against the SessionSource law
 * (extract and timeline give identical human text in the same order).
 */
import { describe, expect, it } from "vitest";
import { extractMessages, extractTimeline } from "../src/sources/claude/extract.js";
import { extractKiroMessages, kiroTimeline } from "../src/sources/kiro/extract.js";
import { isMachineTag, leadingWrappers } from "../src/sources/wrappers.js";

const TS = "2026-05-01T10:00:00.000Z";

interface Row {
  name: string;
  piece: string;
  kept: string[];
  drops: string[];
}

const R6_BLOCK = "R6: machine block (leading <)";
const R6_UNCLOSED = "R6: unclosed machine block";
const K6_BLOCK = "K6: machine block (leading <)";
const K6_UNCLOSED = "K6: unclosed machine block";

const CLAUDE_ROWS: Row[] = [
  {
    name: "a PascalCase component name is the person's words",
    piece: "<Button> is not rendering on the settings page, fix it",
    kept: ["<Button> is not rendering on the settings page, fix it"],
    drops: [],
  },
  {
    name: "a reminder block, a blank line, then prose keeps the prose",
    piece: "<system-reminder>Keep answers short.</system-reminder>\n\nplease also add tests",
    kept: ["please also add tests"],
    drops: [R6_BLOCK],
  },
  {
    name: "a task notification",
    piece:
      "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>",
    kept: [],
    drops: [R6_BLOCK],
  },
  {
    name: "a shell command typed after ! is kept as a command",
    piece: "<bash-input>ls -la</bash-input>",
    kept: ["[command] !ls -la"],
    drops: [],
  },
  {
    name: "an empty shell input block is dropped with a record",
    piece: "<bash-input> </bash-input>",
    kept: [],
    drops: [R6_BLOCK],
  },
  {
    name: "shell output",
    piece: "<bash-stdout>total 0</bash-stdout>",
    kept: [],
    drops: [R6_BLOCK],
  },
  {
    name: "shell output and error output each record a drop",
    piece: "<bash-stdout>total 0</bash-stdout><bash-stderr>warning</bash-stderr>",
    kept: [],
    drops: [R6_BLOCK, R6_BLOCK],
  },
  {
    name: "shell output that prints its own closing tag ends at the last closer",
    piece:
      "<bash-stdout>a.ts: </bash-stdout> one\nb.ts: </bash-stdout> two\nlast line</bash-stdout>",
    kept: [],
    drops: [R6_BLOCK],
  },
  {
    name: "shell output that prints an opening and a closing tag stays one block",
    piece: "<bash-stdout>x <bash-stdout> y </bash-stdout> z</bash-stdout>",
    kept: [],
    drops: [R6_BLOCK],
  },
  {
    name: "error output that prints the closer of the output block is still output",
    piece:
      "<bash-stdout>out</bash-stdout><bash-stderr>grep: </bash-stdout> leaked\nrest</bash-stderr>",
    kept: [],
    drops: [R6_BLOCK],
  },
  {
    name: "output whose last line holds a sibling closer is cut through it",
    piece: "<bash-stdout>a</bash-stdout> b </bash-stderr> c",
    kept: ["c"],
    drops: [R6_BLOCK],
  },
  {
    name: "a command's output that prints its own closer",
    piece: "<local-command-stdout>see </local-command-stdout> in logs</local-command-stdout>",
    kept: [],
    drops: [R6_BLOCK],
  },
  {
    name: "prose after a closed output block is kept",
    piece: "<bash-stdout>total 0</bash-stdout>\nwhy is it empty?",
    kept: ["why is it empty?"],
    drops: [R6_BLOCK],
  },
  {
    name: "an unclosed shell output drops the whole piece",
    piece: "<bash-stdout>partial output\nmore",
    kept: [],
    drops: [R6_UNCLOSED],
  },
  {
    name: "an IDE selection",
    piece: "<ide_selection>The user selected lines 3 to 9 of app.ts</ide_selection>",
    kept: [],
    drops: [R6_BLOCK],
  },
  {
    name: "hook output",
    piece: "<user-prompt-submit-hook>checks passed</user-prompt-submit-hook>",
    kept: [],
    drops: [R6_BLOCK],
  },
  {
    name: "an unknown hyphenated harness tag",
    piece: "<new-harness-tag>payload</new-harness-tag>",
    kept: [],
    drops: [R6_BLOCK],
  },
  {
    name: "an unclosed known reminder drops the whole piece",
    piece: "<system-reminder>Keep answers short.\n\nplease also add tests",
    kept: [],
    drops: [R6_UNCLOSED],
  },
  {
    name: "nested same-tag blocks then text keep the text",
    piece: "<system-reminder>a<system-reminder>b</system-reminder>c</system-reminder>tail",
    kept: ["tail"],
    drops: [R6_BLOCK],
  },
  {
    name: "a plain HTML element alone is the person's words",
    piece: '<div class="a">hi</div>',
    kept: ['<div class="a">hi</div>'],
    drops: [],
  },
  {
    name: "a PascalCase block that is not on the list is kept",
    piece: "<Widget>x</Widget> renders twice",
    kept: ["<Widget>x</Widget> renders twice"],
    drops: [],
  },
  {
    name: "an unclosed unknown tag is the person's words",
    piece: "<new-tag> should be allowed in the parser",
    kept: ["<new-tag> should be allowed in the parser"],
    drops: [],
  },
  {
    name: "a known tag is matched case-sensitively",
    piece: "<System-Reminder>x</System-Reminder> is a component name",
    kept: ["<System-Reminder>x</System-Reminder> is a component name"],
    drops: [],
  },
  {
    name: "several leading blocks each record a drop",
    piece:
      "<ide_opened_file>The user opened app.ts</ide_opened_file>\n<system-reminder>x</system-reminder>\nrefactor this",
    kept: ["refactor this"],
    drops: [R6_BLOCK, R6_BLOCK],
  },
  {
    name: "a self-closing machine tag",
    piece: "<system-reminder/>do it",
    kept: ["do it"],
    drops: [R6_BLOCK],
  },
  {
    name: "a slash command renders without a drop",
    piece:
      "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>",
    kept: ["[command] /clear"],
    drops: [],
  },
  {
    name: "command output after a slash command is dropped with a record",
    piece:
      "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>\n<local-command-stdout></local-command-stdout>",
    kept: ["[command] /clear"],
    drops: [R6_BLOCK],
  },
  {
    name: "a block quoted later in the prose is not a leading wrapper",
    piece: "why does <system-reminder>x</system-reminder> show up?",
    kept: ["why does <system-reminder>x</system-reminder> show up?"],
    drops: [],
  },
];

const KIRO_ROWS: Row[] = [
  {
    name: "an agent SOP block then prose keeps the prose",
    piece: "<agent-sop>x</agent-sop>\nfix the bug",
    kept: ["fix the bug"],
    drops: [K6_BLOCK],
  },
  {
    name: "a steering block",
    piece: "<steering>\nUse tabs.\n</steering>",
    kept: [],
    drops: [K6_BLOCK],
  },
  {
    name: "an environment context block",
    piece: "<EnvironmentContext>\nno files open\n</EnvironmentContext>",
    kept: [],
    drops: [K6_BLOCK],
  },
  {
    name: "an unclosed known tag drops the whole piece",
    piece: "<agent-sop>never closed\nfix the bug",
    kept: [],
    drops: [K6_UNCLOSED],
  },
  {
    name: "an unknown hyphenated harness tag",
    piece: "<new-harness-tag>payload</new-harness-tag>",
    kept: [],
    drops: [K6_BLOCK],
  },
  {
    name: "a PascalCase component name is the person's words",
    piece: "<Button> is not rendering on the settings page, fix it",
    kept: ["<Button> is not rendering on the settings page, fix it"],
    drops: [],
  },
  {
    name: "a plain HTML element alone is the person's words",
    piece: '<div class="a">hi</div>',
    kept: ['<div class="a">hi</div>'],
    drops: [],
  },
];

function claudeLines(piece: string): string[] {
  return [
    JSON.stringify({ type: "user", timestamp: TS, message: { role: "user", content: piece } }),
  ];
}

function kiroLines(piece: string): string[] {
  return [
    JSON.stringify({
      version: "v1",
      kind: "Prompt",
      data: {
        message_id: "m1",
        content: [{ kind: "text", data: piece }],
        // kiro v2 records unix seconds; the extractor normalizes them to ISO.
        meta: { timestamp: Date.parse(TS) / 1000 },
      },
    }),
  ];
}

const SOURCES = [
  {
    name: "claude",
    rows: CLAUDE_ROWS,
    lines: claudeLines,
    extract: extractMessages,
    timeline: extractTimeline,
  },
  {
    name: "kiro v2",
    rows: KIRO_ROWS,
    lines: kiroLines,
    extract: extractKiroMessages,
    timeline: kiroTimeline,
  },
];

for (const source of SOURCES) {
  describe(`${source.name} leading wrappers`, () => {
    it.each(source.rows)("$name", (row) => {
      const lines = source.lines(row.piece);
      const result = source.extract(lines);
      expect(result.messages.map((m) => m.text)).toEqual(row.kept);
      expect(result.drops.map((d) => d.reason)).toEqual(row.drops);
      for (const drop of result.drops) {
        // A visible, bounded record of what was removed and when.
        expect(drop.snippet.startsWith("<")).toBe(true);
        expect(drop.snippet.length).toBeLessThanOrEqual(120);
        expect(drop.timestamp).toBe(TS);
      }
      // SessionSource law over the same lines.
      const human = source
        .timeline(lines)
        .filter((e) => e.kind === "human")
        .map(({ timestamp, text }) => ({ timestamp, text }));
      expect(human).toEqual(result.messages.map(({ timestamp, text }) => ({ timestamp, text })));
    });
  });
}

describe("claude: a shell command and output that prints its own closing tag", () => {
  // `!grep -rn "</bash-stdout>" test/` prints lines holding the closing tag
  // without its opening tag; none of the output is the person's words.
  const user = (content: string) =>
    JSON.stringify({ type: "user", timestamp: TS, message: { role: "user", content } });
  const lines = [
    user("<bash-input>grep -rn closer test/</bash-input>"),
    user(
      "<bash-stdout>test/wrappers.test.ts:57: piece: </bash-stdout> sample\n" +
        "test/other.test.ts:9: more machine output lines</bash-stdout>",
    ),
  ];

  it("keeps the command and none of the output, in extract and timeline", () => {
    const result = extractMessages(lines);
    expect(result.messages.map((m) => m.text)).toEqual(["[command] !grep -rn closer test/"]);
    expect(result.drops.map((d) => d.reason)).toEqual([R6_BLOCK]);
    expect(
      extractTimeline(lines)
        .filter((e) => e.kind === "human")
        .map((e) => e.text),
    ).toEqual(["[command] !grep -rn closer test/"]);
  });
});

describe("isMachineTag", () => {
  const known = new Set(["system-reminder", "EnvironmentContext"]);
  it.each([
    ["system-reminder", true],
    ["EnvironmentContext", true],
    ["environmentcontext", false],
    ["task-notification", true],
    ["ide_selection", true],
    ["bash-stdout2", true],
    ["Button", false],
    ["NewHarness-Tag", false],
    ["div", false],
    ["p", false],
  ] as const)("%s → %s", (tag, expected) => {
    expect(isMachineTag(tag, known)).toBe(expected);
  });
});

describe("leadingWrappers", () => {
  const known = new Set(["system-reminder"]);
  it("returns the removed blocks with their raw text and the remaining prose", () => {
    const res = leadingWrappers(
      '  <system-reminder a="1">x</system-reminder>\n<my-tag/>\nhello ',
      known,
    );
    expect(res.blocks.map((b) => [b.tag, b.body, b.raw])).toEqual([
      ["system-reminder", "x", '<system-reminder a="1">x</system-reminder>'],
      ["my-tag", "", "<my-tag/>"],
    ]);
    expect(res.text).toBe("hello");
    expect(res.unclosed).toBeUndefined();
  });

  it("reports an unclosed known tag and keeps nothing", () => {
    const res = leadingWrappers("<system-reminder>x\nhello", known);
    expect(res.text).toBe("");
    expect(res.unclosed).toBe("<system-reminder>x\nhello");
  });

  it("stops at an unclosed unknown tag and keeps it as text", () => {
    const res = leadingWrappers("<other-tag>hello", known);
    expect(res.blocks).toEqual([]);
    expect(res.text).toBe("<other-tag>hello");
    expect(res.unclosed).toBeUndefined();
  });
});

describe("leadingWrappers: narrowed rules", () => {
  const known = new Set(["permissions"]);
  it("uses only the exact list when the shape rule is off", () => {
    expect(leadingWrappers("<my-tag>x</my-tag> hi", known, { shape: false }).text).toBe(
      "<my-tag>x</my-tag> hi",
    );
    expect(leadingWrappers("<permissions>x</permissions> hi", known, { shape: false }).text).toBe(
      "hi",
    );
  });

  it("keeps an unclosed known tag as text when unclosed blocks are not machine", () => {
    const res = leadingWrappers("<permissions> is the root", known, { unclosedIsMachine: false });
    expect(res).toEqual({ blocks: [], text: "<permissions> is the root" });
  });

  it("extends an output block through a later sibling closer", () => {
    const res = leadingWrappers("<out-a>1</out-a> 2 </out-b> 3", new Set(), {
      output: new Set(["out-a", "out-b"]),
    });
    expect(res.blocks.map((b) => [b.tag, b.raw])).toEqual([
      ["out-a", "<out-a>1</out-a> 2 </out-b>"],
    ]);
    expect(res.text).toBe("3");
  });
});
