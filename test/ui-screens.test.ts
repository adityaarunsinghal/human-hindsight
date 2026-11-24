import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StageProgressSink } from "../src/distill/stage-events.js";
import type { TerminalHost } from "../src/ui/live.js";
import {
  batchProjectLine,
  type SetupRow,
  setupTable,
  startStageProgress,
  summary,
} from "../src/ui/screen.js";
import { createClock } from "./support/clock.js";
import { escapeSequences, goldenText } from "./support/text.js";
import { fakeOutput } from "./support/tty.js";
import { terminalModel } from "./ui-vt.js";

// Synthetic rows in the shapes the environment model produces.
const ROWS: SetupRow[] = [
  {
    tool: "Claude Code",
    history: "4 projects · 128 sessions",
    command: "✓ claude 9.9.9",
    signIn: "✓ ready",
  },
  {
    tool: "Codex",
    history: "1 project · 3 sessions",
    command: "✓ codex 0.0.1",
    signIn: "checking",
  },
  {
    tool: "Kiro",
    history: "2 projects · 40 sessions (checking Crew)",
    command: "✓ kiro-cli (checking)",
    signIn: "! run kiro-cli login --use-device-flow",
  },
  { tool: "Kiro Crew", history: "counting", command: "uses kiro-cli" },
  { tool: "OpenCode", history: "no history yet", command: "! missing" },
];

const UTF8 = { LANG: "en_US.UTF-8", LC_ALL: "", LC_CTYPE: "" };
const ASCII = { LANG: "C", LC_ALL: "", LC_CTYPE: "" };

function stubEnv(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

beforeEach(() => {
  stubEnv({ ...UTF8, NO_COLOR: "", FORCE_COLOR: "", TERM: "xterm-256color" });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("setup table", () => {
  it.each([
    80, 60, 40,
  ])("matches the golden file at %i columns, with color and without", async (width) => {
    stubEnv({ FORCE_COLOR: "1" });
    const colored = setupTable(ROWS, width).join("\n");
    stubEnv({ FORCE_COLOR: "", NO_COLOR: "1" });
    const plain = setupTable(ROWS, width).join("\n");
    // Color changes no character a person reads, and NO_COLOR removes every style.
    expect(escapeSequences(colored).some((code) => /^.\[3\dm$/.test(code))).toBe(true);
    expect(plain).not.toContain("\u001b");
    expect(goldenText(colored)).toBe(plain);
    await expect(`${plain}\n`).toMatchFileSnapshot(`golden/ui/setup-table-${width}.txt`);
    for (const line of plain.split("\n")) expect(line.length).toBeLessThanOrEqual(width);
    // Every status keeps its symbol or word without color.
    expect(plain).toContain("✓ ready");
    expect(plain).toContain("! missing");
  });

  it("uses only ASCII when the locale is not UTF-8", async () => {
    stubEnv({ ...ASCII, NO_COLOR: "1" });
    const text = setupTable(ROWS, 80).join("\n");
    expect(text).toMatch(/^[ -~\n]*$/);
    expect(text).toContain("+ ready");
    await expect(`${text}\n`).toMatchFileSnapshot("golden/ui/setup-table-80-ascii.txt");
  });

  it("colors statuses only with the 16 terminal colors", () => {
    stubEnv({ FORCE_COLOR: "1" });
    const codes = escapeSequences(setupTable(ROWS, 80).join("\n"));
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) expect(code.slice(1)).toMatch(/^\[(1|2|22|3[0-7]|39|9[0-7])m$/);
  });
});

describe("closing summary", () => {
  it("matches the golden file", async () => {
    stubEnv({ NO_COLOR: "1" });
    const lines = summary("Your library is ready", [
      "12 prompts from 40 sessions",
      "Read by claude-sonnet-5.5, grouped and written by claude-opus-5",
      "Next: npx human-hindsight gui",
    ]);
    await expect(`${lines.join("\n")}\n`).toMatchFileSnapshot("golden/ui/closing-summary.txt");
    expect(lines).toHaveLength(4);
  });
});

/** Drive a stage the way the pipeline does, with a clock that moves 2 s per finished call. */
function stage(
  o: {
    columns?: number;
    isTTY?: boolean;
    env?: Record<string, string>;
    readProjects?: string[];
    reusableReads?: Set<string>;
    host?: TerminalHost;
  } = {},
) {
  const out = fakeOutput({ columns: o.columns ?? 80, rows: 24, isTTY: o.isTTY ?? true });
  const clock = createClock();
  const env = { TERM: "xterm-256color", NO_COLOR: "1", ...UTF8, ...o.env };
  const ticks: (() => void)[] = [];
  const sink: StageProgressSink = startStageProgress(out, "Reading sessions", {
    now: clock.nowMs,
    env,
    host: o.host,
    readProjects: o.readProjects,
    reusableReads: o.reusableReads,
    every: (tick) => {
      ticks.push(tick);
      return () => ticks.splice(0);
    },
  });
  const screen = () => {
    const vt = terminalModel(o.columns ?? 80);
    vt.apply(out.raw());
    return `${vt.rows().join("\n")}\n`;
  };
  return { out, clock, sink, screen, ticks };
}

function finish(s: ReturnType<typeof stage>, ids: number[], status: "done" | "failed" = "done") {
  for (const id of ids) {
    s.clock.advance(2000);
    s.sink.item({ id: `s${id}`, status, line: `session-${id}` });
  }
}

describe("stage progress", () => {
  it("previews the most represented projects from the actual selection in stable order", () => {
    const output = fakeOutput({ isTTY: false });
    expect(batchProjectLine([], output)).toBeUndefined();
    expect(
      batchProjectLine(
        ["Field notes", "Guides", "Widgets", "Reference", "Guides", "Widgets"],
        output,
        UTF8,
      ),
    ).toBe("Most represented  Guides ×2 · Widgets ×2 · Field notes");
  });

  it("shows active projects, then retains each saved goal and preference in completion order after Ctrl-C", async () => {
    const host = Object.assign(new EventEmitter(), { pid: 1, kill: vi.fn() });
    host.once("SIGINT", () => {});
    const s = stage({
      readProjects: ["Field notes", "Reference", "Field notes"],
      env: { FORCE_COLOR: "1" },
      host,
    });
    s.sink.start(3, 3);
    for (const [i, project] of ["Field notes", "Reference", "Field notes"].entries())
      s.sink.running?.(`s${i}`, `export-${i}.md`, project);
    s.clock.advance(1_000);
    for (const tick of s.ticks) tick();
    expect(s.screen()).toContain("Reading Field notes ×2 · Reference");
    expect(s.screen()).toMatch(
      /estimating\n│ Reading Field notes ×2 · Reference\n│ The first summary/,
    );
    const firstFrameRows = s.screen().split("\n").length;
    s.clock.advance(100);
    for (const tick of s.ticks) tick();
    expect(s.screen().split("\n")).toHaveLength(firstFrameRows);
    expect(s.out.raw()).toContain("\x1b[34mField notes");
    expect(s.out.raw()).toContain("\x1b[36mReference");

    s.sink.item({
      id: "s1",
      status: "done",
      line: "",
      read: {
        project: "Reference",
        outcome: "completed",
        goal: "Explain the new option.",
        preference: "Lead with one example.",
      },
    });
    expect(s.screen()).toContain("Preference Lead with one example.");
    expect(s.sink.savedReads?.()).toBe(1);
    s.sink.item({
      id: "s2",
      status: "done",
      line: "",
      read: {
        project: "Field notes",
        outcome: "partial",
        goal: "Organize the field notes.",
      },
    });
    host.emit("SIGINT");
    const stopped = s.screen();
    expect(stopped.indexOf("Explain the new option.")).toBeLessThan(
      stopped.indexOf("Organize the field notes."),
    );
    expect(stopped).not.toMatch(/estimating|first summary|Reading Field notes|export-\d/);
    await expect(stopped).toMatchFileSnapshot("golden/ui/saved-reads-after-interrupt.txt");
    s.sink.end();
  });

  it("keeps a long reused result readable on narrow terminals and counts only saved results", () => {
    const s = stage({
      columns: 32,
      readProjects: ["Reference", "Guides", "Reference"],
      reusableReads: new Set(["cached", "later"]),
    });
    s.sink.start(3, 1);
    s.sink.item({
      id: "cached",
      status: "skipped",
      line: "",
      read: {
        project: "Reference",
        outcome: "unclear",
        goal: "Document widget sizing for small screens.",
        preference: "Explain defaults before alternatives.",
      },
    });
    s.sink.item({ id: "missing", status: "failed", line: "missing file" });
    const active = s.screen();
    expect(active).toContain("1/3 read");
    expect(active).toContain("1 failed");
    expect(active).toContain("1 reused");
    // The stop notice also includes the saved read later in this batch.
    expect(s.sink.savedReads?.()).toBe(2);
    s.sink.end();
    const text = s.screen();
    expect(text).toContain("Reused Reference · unclear");
    expect(text.replace(/\n│\s*/g, " ")).toContain("Explain defaults before alternatives.");
    expect(text).not.toContain("estimating");
    for (const line of text.split("\n")) expect(line.length).toBeLessThan(32);
  });

  it("reads estimating before five results and folds finished items into the count", async () => {
    const s = stage();
    s.sink.start(40, 10);
    for (let i = 1; i <= 6; i++) s.sink.running?.(`s${i}`, `session-${i}`);
    finish(s, [1, 2, 3, 4]);
    const text = s.screen();
    expect(text).toContain("4/40");
    expect(text).toContain("estimating");
    expect(text).not.toContain("session-1");
    await expect(text).toMatchFileSnapshot("golden/ui/stage-progress-before-five.txt");
  });

  it("estimates from the moving average after five results", async () => {
    const s = stage();
    s.sink.start(40, 10);
    for (let i = 1; i <= 12; i++) s.sink.running?.(`s${i}`, `session-${i}`);
    finish(s, [1, 2, 3, 4, 5]);
    // 5 calls in 10 s: 35 left at 0.5 per second is 70 s.
    expect(s.screen()).toContain("about 2 min left");
    finish(s, [6]);
    const text = s.screen();
    expect(text).toContain("6/40");
    // 6 calls in 12 s: 34 left is 68 s.
    expect(text).toContain("about 2 min left");
    expect(text).toContain("and 3 more running");
    await expect(text).toMatchFileSnapshot("golden/ui/stage-progress-after-five.txt");
  });

  it("keeps the estimate on recent calls only", () => {
    const s = stage();
    s.sink.start(100, 10);
    finish(
      s,
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    // Twenty slow calls, then twenty fast ones: only the fast ones count.
    for (let i = 21; i <= 40; i++) {
      s.clock.advance(100);
      s.sink.item({ id: `s${i}`, status: "done", line: "" });
    }
    // 20 calls in 2 s: 60 left at 10 per second is 6 s.
    expect(s.screen()).toContain("about 6s left");
  });

  it("does not count cached items toward the rate", () => {
    const s = stage();
    s.sink.start(20, 10);
    for (let i = 1; i <= 8; i++) {
      s.clock.advance(100);
      s.sink.item({ id: `c${i}`, status: "skipped", line: "" });
    }
    expect(s.screen()).toContain("8/20");
    expect(s.screen()).toContain("estimating");
  });

  it("prints failures permanently above the region and the final count at the end", async () => {
    const s = stage();
    s.sink.start(6, 10);
    finish(s, [1, 2]);
    finish(s, [3], "failed");
    s.sink.item({ id: "s4", status: "blocked", line: "session-4 waits for a retry" });
    finish(s, [5, 6]);
    s.sink.end();
    const text = s.screen();
    expect(text.split("\n")[0]).toBe("failed: session-3");
    expect(text).toContain("6/6 · 1 failed · 1 blocked · 10s");
    expect(text).not.toContain("estimating");
    await expect(text).toMatchFileSnapshot("golden/ui/stage-progress-failures.txt");
    expect(s.ticks).toHaveLength(0);
  });

  it("keeps elapsed time moving between results", () => {
    const s = stage();
    s.sink.start(3, 1);
    s.clock.advance(65_000);
    for (const tick of s.ticks) tick();
    expect(s.screen()).toContain("1m 5s");
    s.sink.end();
  });

  it("says how much work there is at once without a terminal, with no estimate", () => {
    const s = stage({ isTTY: false });
    s.sink.start(25, 10);
    // A piped or logged run must not sit silent until the tenth result.
    expect(goldenText(s.out.raw())).toBe("Reading sessions  0/25\n");
    s.sink.end();
  });

  it("prints nothing at the start of an empty stage without a terminal", () => {
    const s = stage({ isTTY: false });
    s.sink.start(0, 10);
    expect(s.out.raw()).toBe("");
    s.sink.end();
  });

  it("a slow step without a terminal still prints a line every ten results and one at the end", async () => {
    const s = stage({ isTTY: false });
    s.sink.start(25, 10);
    finish(
      s,
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    finish(s, [13], "failed");
    finish(
      s,
      Array.from({ length: 12 }, (_, i) => i + 14),
    );
    s.sink.end();
    const text = goldenText(s.out.raw());
    expect(s.out.raw()).not.toContain("\u001b");
    expect(text.trim().split("\n")).toHaveLength(5);
    await expect(text).toMatchFileSnapshot("golden/ui/stage-progress-no-terminal.txt");
  });

  it("a fast step without a terminal prints at most one line a second, ten results apart", () => {
    const s = stage({ isTTY: false });
    s.sink.start(286, 10);
    // 286 sessions in 2 s.
    for (let id = 1; id <= 286; id++) {
      s.clock.advance(7);
      s.sink.item({ id: `s${id}`, status: "done", line: `session-${id}` });
    }
    s.sink.end();
    const lines = goldenText(s.out.raw()).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("Reading sessions  0/286");
    expect(lines[1]).toMatch(/^Reading sessions {2}143\/286 /);
    expect(lines[2]).toMatch(/^Reading sessions {2}286\/286 /);
  });

  it("never prints two lines within a second, nor for fewer than ten new results", () => {
    const s = stage({ isTTY: false });
    s.sink.start(100, 10);
    const lines = () => goldenText(s.out.raw()).trim().split("\n").length;
    const results = (from: number, to: number, ms: number) => {
      for (let id = from; id <= to; id++) {
        s.clock.advance(ms);
        s.sink.item({ id: `s${id}`, status: "done", line: "" });
      }
    };
    results(1, 10, 10); // ten results in 0.1 s: too soon
    expect(lines()).toBe(1);
    results(11, 11, 1000); // a second later, eleven new results
    expect(lines()).toBe(2);
    s.clock.advance(5000);
    results(12, 14, 0); // a long pause alone is not enough: three new results
    expect(lines()).toBe(2);
    results(15, 21, 0); // ten new results since the last line
    expect(lines()).toBe(3);
    s.sink.end();
  });

  it("uses ASCII marks when the locale is not UTF-8", () => {
    const s = stage({ env: ASCII });
    s.sink.start(6, 10);
    s.sink.running?.("s1", "session-1");
    finish(s, [2]);
    expect(s.screen()).toMatch(/^[ -~\n]*$/);
    expect(s.screen()).toContain("| Reading sessions  1/6, 2s, estimating");
    // The rail is "|", so no other "|" appears inside it.
    for (const row of s.screen().split("\n")) expect(row.slice(1)).not.toContain("|");
  });

  it("splits the aggregate line on a narrow terminal and cuts running lines at the width", () => {
    const s = stage({ columns: 40 });
    s.sink.start(400, 10);
    s.sink.running?.("s1", "a-very-long-session-name-that-goes-past-forty-columns");
    for (const line of s.screen().trimEnd().split("\n")) expect(line.length).toBeLessThan(40);
    expect(s.screen()).toContain("estimating");
  });
});
