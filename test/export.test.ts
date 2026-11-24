import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ExportArgs,
  type ExportStats,
  exportClosingLines,
  type ManifestEntry,
  runExport,
} from "../src/commands/export.js";
import type { ProjectInfo, SessionSource, SourceName } from "../src/sources/types.js";

const realRename = fs.renameSync;

// Drive export with the synthetic fixture claude dir, never the real one;
// every home directory is a fresh mkdtemp, never a real ~/.human-hindsight.
const CLAUDE_HOME = path.join(import.meta.dirname, "fixtures", "export-home");
const ALPHA_DIR = path.join(CLAUDE_HOME, "projects", "-Users-dev-alpha");
// A kiro dir that does not exist, so `--source auto` collapses to claude-only:
// a test machine's real ~/.kiro can never leak in (the "never read the real
// store" rule extends to kiro), while auto-mode behavior (e.g. prune) still runs.
const NO_KIRO = path.join(CLAUDE_HOME, "no-kiro-here");
const NO_CODEX = path.join(CLAUDE_HOME, "no-codex-here");

const tmpHomes: string[] = [];

function freshHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "human-hindsight-export-"));
  tmpHomes.push(home);
  return home;
}

afterEach(() => {
  for (const home of tmpHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/** A Writable that accumulates output, VT-stripped on read. */
function makeSink(): { sink: Writable; text: () => string } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { sink, text: () => stripVTControlCharacters(chunks.join("")) };
}

/** Run export against the fixture into a fresh tmp home. */
function run(extra: Partial<ExportArgs> = {}): {
  home: string;
  stats: ReturnType<typeof runExport>;
  out: string;
} {
  const home = freshHome();
  const { sink, text } = makeSink();
  const stats = runExport({
    home,
    "claude-dir": CLAUDE_HOME,
    "kiro-dir": NO_KIRO,
    "codex-dir": NO_CODEX,
    output: sink,
    ...extra,
  });
  return { home, stats, out: text() };
}

function readManifest(home: string): ManifestEntry[] {
  const raw = fs.readFileSync(path.join(home, "exports", "manifest.json"), "utf8");
  return JSON.parse(raw) as ManifestEntry[];
}

describe("export: default run", () => {
  it("writes one markdown per exported session plus a manifest", () => {
    const { home, stats } = run();
    const files = fs.readdirSync(path.join(home, "exports")).sort();
    expect(files).toEqual([
      "alpha-a1111111.md",
      "alpha-b2222222.md",
      "alpha-c3333333.md",
      "anaphora.json",
      "export-stats.json",
      "manifest.json",
      "outcomes.json",
      "project-names.json",
    ]);
    expect(stats.files).toEqual(["alpha-a1111111.md", "alpha-b2222222.md", "alpha-c3333333.md"]);
    expect(stats.exportedSessions).toBe(3);
    expect(stats.totalMessages).toBe(7);
    expect(stats.duplicatesDropped).toBe(3);
  });

  it("skips the zero-human-message session (R9) and counts it", () => {
    const { home, stats } = run();
    expect(fs.existsSync(path.join(home, "exports", "beta-d4444444.md"))).toBe(false);
    expect(stats.zeroMessageSessions).toBe(1);
    expect(readManifest(home).some((e) => e.project === "beta")).toBe(false);
  });

  it("renders the forked export with fork copies removed, re-send kept, exact bytes", () => {
    const { home } = run();
    const source = path.join(ALPHA_DIR, "b2222222-2222-2222-2222-222222222222.jsonl");
    const expected =
      `<!-- source: ${source}\n     messages: 3 -->\n` +
      "\n### 2026-03-01T11:00:00.000Z\n\nAlso add a release workflow.\n" +
      "\n### 2026-03-01T11:01:00.000Z\n\nPin all action versions.\n" +
      "\n### 2026-03-01T11:02:00.000Z\n\nUse TypeScript and vitest.\n";
    const actual = fs.readFileSync(path.join(home, "exports", "alpha-b2222222.md"), "utf8");
    expect(actual).toBe(expected);
  });

  it("produces a well-formed, deterministically sorted manifest", () => {
    const { home } = run();
    const manifest = readManifest(home);
    expect(manifest.map((e) => e.export)).toEqual([
      "alpha-a1111111.md",
      "alpha-b2222222.md",
      "alpha-c3333333.md",
    ]);

    const forked = manifest.find((e) => e.export === "alpha-b2222222.md");
    expect(forked).toEqual({
      export: "alpha-b2222222.md",
      source: path.join(ALPHA_DIR, "b2222222-2222-2222-2222-222222222222.jsonl"),
      origin: "claude",
      project: "alpha",
      sessionId: "b2222222-2222-2222-2222-222222222222",
      messages: 3,
      first_ts: "2026-03-01T11:00:00.000Z",
      last_ts: "2026-03-01T11:02:00.000Z",
    });

    const original = manifest.find((e) => e.export === "alpha-a1111111.md");
    expect(original?.messages).toBe(3);
    expect(original?.first_ts).toBe("2026-03-01T10:00:00.000Z");
    expect(original?.last_ts).toBe("2026-03-01T10:02:00.000Z");
  });

  it("prints the summary line and the distill funnel hint", () => {
    const { out } = run();
    expect(out).toContain("Exported 3 sessions with 7 of your messages.");
    expect(out).toContain("→ next: npx human-hindsight reflect");
    expect(out).toContain("1 session was left out: none of its messages were yours.");
    // How the evidence was gathered is internal: only --verbose shows it.
    expect(out).not.toMatch(/short turns|outcome evidence|duplicate|\(s\)/);
    const verbose = run({ verbose: true }).out;
    expect(verbose).toContain("3 duplicate messages dropped");
    expect(verbose).toContain("short turns attached (0 had a pending plan/question)");
    expect(verbose).toContain("outcome evidence captured for 3 sessions");
  });
});

describe("export: idempotency", () => {
  it("re-running against the same input produces byte-identical files", () => {
    const home = freshHome();
    const { sink } = makeSink();
    runExport({
      home,
      "claude-dir": CLAUDE_HOME,
      "kiro-dir": NO_KIRO,
      "codex-dir": NO_CODEX,
      output: sink,
    });

    const dir = path.join(home, "exports");
    const first = new Map<string, Buffer>();
    for (const f of fs.readdirSync(dir)) first.set(f, fs.readFileSync(path.join(dir, f)));

    // Run a second time into the same home.
    const { sink: sink2 } = makeSink();
    runExport({
      home,
      "claude-dir": CLAUDE_HOME,
      "kiro-dir": NO_KIRO,
      "codex-dir": NO_CODEX,
      output: sink2,
    });

    const second = new Map<string, Buffer>();
    for (const f of fs.readdirSync(dir)) second.set(f, fs.readFileSync(path.join(dir, f)));

    expect([...second.keys()].sort()).toEqual([...first.keys()].sort());
    for (const [name, buf] of first) {
      expect(second.get(name)?.equals(buf)).toBe(true);
    }
  });
});

describe("export: hygiene & permissions", () => {
  it("prunes a stale export whose session vanished, on an unfiltered run", () => {
    const home = freshHome();
    const { sink } = makeSink();
    runExport({
      home,
      "claude-dir": CLAUDE_HOME,
      "kiro-dir": NO_KIRO,
      "codex-dir": NO_CODEX,
      output: sink,
    });
    const stale = path.join(home, "exports", "ghost-deadbeef.md");
    fs.writeFileSync(stale, "# stale");

    const { sink: sink2 } = makeSink();
    const stats = runExport({
      home,
      "claude-dir": CLAUDE_HOME,
      "kiro-dir": NO_KIRO,
      "codex-dir": NO_CODEX,
      output: sink2,
    });
    expect(fs.existsSync(stale)).toBe(false);
    expect(stats.prunedExports).toBe(1);
  });

  it("does NOT prune under a --project filter (subset run)", () => {
    const home = freshHome();
    const { sink } = makeSink();
    runExport({
      home,
      "claude-dir": CLAUDE_HOME,
      "kiro-dir": NO_KIRO,
      "codex-dir": NO_CODEX,
      output: sink,
    });
    const other = path.join(home, "exports", "other-project.md");
    fs.writeFileSync(other, "# from another scope");

    const { sink: sink2 } = makeSink();
    const stats = runExport({
      home,
      "claude-dir": CLAUDE_HOME,
      "kiro-dir": NO_KIRO,
      "codex-dir": NO_CODEX,
      project: "alpha",
      output: sink2,
    });
    expect(fs.existsSync(other)).toBe(true);
    expect(stats.prunedExports).toBe(0);
  });

  it.skipIf(process.platform === "win32")("writes owner-only exports (0600) in a 0700 dir", () => {
    const { home } = run();
    expect(fs.statSync(path.join(home, "exports")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(home, "exports", "alpha-a1111111.md")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(home, "exports", "manifest.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(home, "exports", "project-names.json")).mode & 0o777).toBe(0o600);
  });
});

describe("export: filters", () => {
  it.each([
    "-1",
    "two",
    "2.5",
    "",
  ])("--min-messages %j is an error before anything is read or written", (value) => {
    const home = freshHome();
    const { sink, text } = makeSink();
    expect(() =>
      runExport({ home, "claude-dir": CLAUDE_HOME, output: sink, "min-messages": value }),
    ).toThrow(
      `--min-messages takes a whole number of messages, 0 or more, not ${JSON.stringify(value)}.`,
    );
    expect(text()).toBe("");
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("the guided export says it is scanning your history, not reading sessions as distill does", () => {
    const { out, stats } = run({ guided: true });
    expect(stats.exportedSessions).toBeGreaterThan(0);
    expect(out).toMatch(/^Scanning your history {2}0\/\d+$/m);
    expect(out).not.toContain("Reading sessions");
    // The closing lines are unchanged.
    expect(out).toContain(`Exported ${stats.exportedSessions}`);
  });

  it("--min-messages 2 excludes the single-message session", () => {
    const { home, stats } = run({ "min-messages": "2" });
    const files = fs.readdirSync(path.join(home, "exports")).sort();
    expect(files).toEqual([
      "alpha-a1111111.md",
      "alpha-b2222222.md",
      "anaphora.json",
      "export-stats.json",
      "manifest.json",
      "outcomes.json",
      "project-names.json",
    ]);
    expect(stats.exportedSessions).toBe(2);
    expect(stats.belowMinMessages).toBe(1);
    expect(stats.totalMessages).toBe(6);
  });

  it("--project alpha exports only alpha and reports the filtered project", () => {
    const { home, stats } = run({ project: "alpha" });
    expect(stats.exportedSessions).toBe(3);
    expect(stats.skippedByFilter).toBe(1); // beta's one session
    expect(stats.zeroMessageSessions).toBe(0); // beta was never read
    expect(readManifest(home).every((e) => e.project === "alpha")).toBe(true);
  });

  it("--project beta yields no exports (its only session has no human messages)", () => {
    const { home, stats } = run({ project: "beta" });
    expect(stats.exportedSessions).toBe(0);
    expect(stats.zeroMessageSessions).toBe(1);
    expect(stats.skippedByFilter).toBe(3); // alpha's three sessions
    expect(readManifest(home)).toEqual([]);
    expect(fs.readdirSync(path.join(home, "exports")).sort()).toEqual([
      "anaphora.json",
      "export-stats.json",
      "manifest.json",
      "outcomes.json",
      "project-names.json",
    ]);
  });
});

describe("export: verbose observability", () => {
  it("reports dedupe drops and every extractor drop under --verbose", () => {
    const { out } = run({ verbose: true });
    // Fork copies dropped for the forked session (s2 copied s1's 3 messages).
    expect(out).toContain("3 fork-copy dropped");
    // The <ide_opened_file> machine block from the original session.
    expect(out).toContain("R6: machine block (leading <)");
    // Zero-message session flagged, not exported.
    expect(out).toContain("skipped (no messages)");
  });

  it("returns a complete stats object shape", () => {
    const { stats } = run({ verbose: true });
    expect(Object.keys(stats).sort()).toEqual(
      [
        "automationSkipped",
        "badLines",
        "belowMinMessages",
        "duplicatesDropped",
        "exportedSessions",
        "exportsDir",
        "files",
        "keptAfterReadError",
        "kirocrewHandedOff",
        "outcomeSessions",
        "prunedExports",
        "readErrors",
        "sessionsByOrigin",
        "shortTurns",
        "shortTurnsWithDecision",
        "skippedByFilter",
        "totalMessages",
        "zeroMessageSessions",
      ].sort(),
    );
  });
});

// ---- anaphora.json + outcomes.json integration (anaphora-home) ------

const ANAPHORA_HOME = path.join(import.meta.dirname, "fixtures", "anaphora-home");

/** Run export against the anaphora fixture into a fresh tmp home. */
function runAnaphora(extra: Partial<ExportArgs> = {}): {
  home: string;
  stats: ReturnType<typeof runExport>;
  out: string;
} {
  const home = freshHome();
  const { sink, text } = makeSink();
  const stats = runExport({
    home,
    "claude-dir": ANAPHORA_HOME,
    "kiro-dir": NO_KIRO,
    "codex-dir": NO_CODEX,
    output: sink,
    ...extra,
  });
  return { home, stats, out: text() };
}

// biome-ignore lint/suspicious/noExplicitAny: reading arbitrary parsed JSON in tests.
function readJson(home: string, name: string): any {
  return JSON.parse(fs.readFileSync(path.join(home, "exports", name), "utf8"));
}

/** Parse a rendered export markdown into ordered { timestamp, text } blocks. */
function parseBlocks(markdown: string): { timestamp: string; text: string }[] {
  return markdown
    .split("\n### ")
    .slice(1)
    .map((part) => {
      const nl = part.indexOf("\n");
      return {
        timestamp: part.slice(0, nl),
        text: part
          .slice(nl + 1)
          .replace(/^\n/, "")
          .replace(/\n$/, ""),
      };
    });
}

describe("export: anaphora + outcome artifacts", () => {
  it("writes anaphora.json and outcomes.json with the expected counts", () => {
    const { home, stats } = runAnaphora();
    expect(stats.exportedSessions).toBe(2);
    expect(stats.shortTurns).toBe(8);
    expect(stats.shortTurnsWithDecision).toBe(2);
    expect(stats.outcomeSessions).toBe(2);
    expect(fs.existsSync(path.join(home, "exports", "anaphora.json"))).toBe(true);
    expect(fs.existsSync(path.join(home, "exports", "outcomes.json"))).toBe(true);
  });

  it("surfaces the approved plan, the answered question, and skips the long turn", () => {
    const { home } = runAnaphora();
    const anaphora = readJson(home, "anaphora.json");

    const s1 = anaphora["work-aaaa1111.md"];
    const yes = s1.find((r: { human_text: string }) => r.human_text === "yes");
    expect(yes.decision_kind).toBe("plan");
    expect(yes.decision_text).toContain("## Plan");
    expect(yes.antecedent).toContain("proposed plan");

    // Long (>15-word) human turn gets NO record.
    expect(
      s1.some((r: { human_text: string }) => r.human_text.startsWith("This is a deliberately")),
    ).toBe(false);

    const s2 = anaphora["work-bbbb2222.md"];
    const opt = s2.find((r: { human_text: string }) => r.human_text === "option 2");
    expect(opt.decision_kind).toBe("question");
    expect(opt.decision_text).toContain("Which database?");
    expect(opt.decision_text).toContain("MySQL");
  });

  it("bounds the antecedent to the 1600-char TAIL and excludes sidechain turns", () => {
    const { home } = runAnaphora();
    const s1 = readJson(home, "anaphora.json")["work-aaaa1111.md"];

    // Antecedent-only turn after a >1600-char assistant essay.
    const looksGood = s1.find(
      (r: { human_text: string }) => r.human_text === "Looks good, proceed.",
    );
    expect(looksGood.antecedent.length).toBe(1600);
    expect(looksGood.antecedent.endsWith("ESSAY_END")).toBe(true);
    expect(looksGood.antecedent.includes("ESSAY_START")).toBe(false);
    expect(looksGood.decision_kind).toBeNull();

    // The sidechain assistant turn immediately before "ok" must NOT be its antecedent.
    const ok = s1.find((r: { human_text: string }) => r.human_text === "ok");
    expect(ok.antecedent).not.toContain("SIDECHAIN");
    expect(ok.antecedent.endsWith("ESSAY_END")).toBe(true);
  });

  it("captures bounded, labeled outcome evidence per session", () => {
    const { home } = runAnaphora();
    const outcomes = readJson(home, "outcomes.json");

    expect(outcomes._note).toContain("machine-authored");

    const o1 = outcomes["work-aaaa1111.md"];
    expect(o1.final_human_turns).toHaveLength(3);
    expect(o1.final_human_turns[0]).toBe("ok");
    expect(o1.final_human_turns[2]).toBe("done for now");
    expect(o1.final_assistant_tail.length).toBeLessThanOrEqual(1600);
    expect(o1.final_assistant_tail.endsWith("ESSAY_END")).toBe(true);

    const o2 = outcomes["work-bbbb2222.md"];
    expect(o2.final_human_turns).toEqual([
      "Set up the database layer.",
      "option 2",
      "great thanks",
    ]);
    expect(o2.final_assistant_tail).toBe("Using MySQL then.");
  });

  it("aligns every anaphora index with the actual rendered export markdown", () => {
    const { home } = runAnaphora();
    const anaphora = readJson(home, "anaphora.json");
    for (const file of ["work-aaaa1111.md", "work-bbbb2222.md"]) {
      const markdown = fs.readFileSync(path.join(home, "exports", file), "utf8");
      const blocks = parseBlocks(markdown);
      for (const record of anaphora[file]) {
        expect(blocks[record.index]?.timestamp).toBe(record.timestamp);
        expect(blocks[record.index]?.text).toBe(record.human_text);
      }
    }
  });

  it("re-running is byte-identical for the JSON artifacts (idempotent)", () => {
    const home = freshHome();
    const { sink } = makeSink();
    runExport({
      home,
      "claude-dir": ANAPHORA_HOME,
      "kiro-dir": NO_KIRO,
      "codex-dir": NO_CODEX,
      output: sink,
    });
    const dir = path.join(home, "exports");
    const first = new Map<string, Buffer>();
    for (const f of fs.readdirSync(dir)) first.set(f, fs.readFileSync(path.join(dir, f)));

    const { sink: sink2 } = makeSink();
    runExport({
      home,
      "claude-dir": ANAPHORA_HOME,
      "kiro-dir": NO_KIRO,
      "codex-dir": NO_CODEX,
      output: sink2,
    });
    for (const f of fs.readdirSync(dir)) {
      expect(fs.readFileSync(path.join(dir, f)).equals(first.get(f) as Buffer)).toBe(true);
    }
  });

  it("prints the attachment summary line and per-session attachments under --verbose", () => {
    const { out } = runAnaphora({ verbose: true });
    expect(out).toContain(
      "8 short turns attached (2 had a pending plan/question); outcome evidence captured for 2 sessions",
    );
    expect(out).toMatch(/\d+ short turns? attached/);
    expect(out).toContain("+plan");
    expect(out).toContain("+question");
  });
});

// ---- kiro backend integration (kiro-home) ----------------------------------

const KIRO_HOME = path.join(import.meta.dirname, "fixtures", "kiro-home");

describe("export: kiro source", () => {
  it("exports interactive kiro sessions, tagging manifest origin=kiro", () => {
    const home = freshHome();
    const { sink, text } = makeSink();
    const stats = runExport({ home, "kiro-dir": KIRO_HOME, source: "kiro", output: sink });

    // The three .history (interactive) sessions export, including the HYBRID
    // parent-linked one a human steered (K2 step-1 precedence); the [AGENT
    // SYSTEM PROMPT] automation session and the parent-linked child without
    // history are classified out.
    expect(stats.exportedSessions).toBe(3);
    expect(stats.automationSkipped).toBe(2);
    expect(stats.sessionsByOrigin).toEqual({ kiro: 3 });

    const manifest = readManifest(home);
    expect(manifest.length).toBe(3);
    for (const e of manifest) expect(e.origin).toBe("kiro");
    // The dark-mode session's first prompt survived to the export markdown.
    const md = fs.readFileSync(path.join(home, "exports", manifest[0]?.export ?? ""), "utf8");
    expect(md).toContain("###"); // has at least one timestamped block
    // Single-source run: no merged-corpus notice.
    expect(text()).not.toContain("including");
  });

  it("merges claude + kiro under --source auto with a per-origin breakdown and a one-time notice", () => {
    const home = freshHome();
    const { sink, text } = makeSink();
    const stats = runExport({
      home,
      "claude-dir": CLAUDE_HOME,
      "kiro-dir": KIRO_HOME,
      "codex-dir": path.join(home, "no-codex"),
      source: "auto",
      output: sink,
    });
    // 3 claude (export-home alpha) + 3 interactive kiro.
    expect(stats.sessionsByOrigin).toEqual({ claude: 3, kiro: 3 });
    expect(text()).toContain("Exported 6 sessions with ");
    // The breakdown by tool is a line of its own.
    expect(text()).toMatch(/\nBy tool: 3 Claude Code, 3 Kiro CLI\.\n/);
    // The merged-corpus notice names the kiro count and the escape hatch.
    expect(text()).toContain("Including 3 Kiro CLI sessions");
    expect(text()).toContain("--source claude");
    const origins = new Set(readManifest(home).map((e) => e.origin));
    expect([...origins].sort()).toEqual(["claude", "kiro"]);
  });

  it("dedupes a /chat load-imported copy: the original owns the shared keys", () => {
    // kiro-home-dedupe: s-restored was created by `/chat load` from s-original:
    // a NEW uuid with the log entries copied verbatim (imported_from set) plus
    // one new human prompt. The copied (timestamp, text) pairs must be dropped
    // as fork copies; the new prompt survives in the restored session.
    const home = freshHome();
    const { sink } = makeSink();
    const DEDUPE_HOME = path.join(import.meta.dirname, "fixtures", "kiro-home-dedupe");
    const stats = runExport({ home, "kiro-dir": DEDUPE_HOME, source: "kiro", output: sink });

    expect(stats.exportedSessions).toBe(2);
    expect(stats.duplicatesDropped).toBe(2); // both copied prompts dropped once
    const manifest = readManifest(home);
    const original = manifest.find((e) => e.sessionId === "s-original");
    const restored = manifest.find((e) => e.sessionId === "s-restored");
    expect(original?.messages).toBe(2); // owns both shared keys
    expect(restored?.messages).toBe(1); // keeps only its genuinely new prompt
  });
});

describe("export: upgrades and cleanup", () => {
  it("re-export over a 1.8.5-shaped manifest keeps export and project for every source", () => {
    const home = freshHome();
    const args = {
      home,
      "claude-dir": CLAUDE_HOME,
      "kiro-dir": KIRO_HOME,
      "codex-dir": NO_CODEX,
      output: makeSink().sink,
    };
    runExport(args);
    const dir = path.join(home, "exports");
    // Rewrite it as an earlier release would have left it: other project names
    // (one per project folder) and other file names (the 1.8.5 rows carry the
    // same fields).
    const earlier = readManifest(home).map((entry, i) => {
      const renamed = `old${i}-${entry.export}`;
      fs.renameSync(path.join(dir, entry.export), path.join(dir, renamed));
      return { ...entry, export: renamed, project: `old-${entry.origin}-${entry.project}` };
    });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(earlier, null, 2));
    expect(new Set(earlier.map((e) => e.origin))).toEqual(new Set(["claude", "kiro"]));

    runExport({ ...args, output: makeSink().sink });
    const after = new Map(readManifest(home).map((e) => [e.source, e]));
    for (const entry of earlier) {
      expect(after.get(entry.source)).toMatchObject({
        export: entry.export,
        project: entry.project,
      });
      expect(fs.existsSync(path.join(dir, entry.export))).toBe(true);
    }
  });

  it("disposes every source when a later source's discovery throws", () => {
    const disposed: string[] = [];
    const source = (name: SourceName, discover: () => ProjectInfo[]): SessionSource => ({
      name,
      discover,
      dispose: () => disposed.push(name),
      extract: () => ({ messages: [], drops: [], badLines: 0 }),
      timeline: () => [],
    });
    const sources = [
      source("opencode", () => []),
      source("kiro", () => {
        throw new Error("store unreadable");
      }),
    ];
    expect(() => run({ sources })).toThrow("store unreadable");
    expect(disposed.sort()).toEqual(["kiro", "opencode"]);
  });

  it("disposes each source once on a normal run", () => {
    const disposed: string[] = [];
    const sources: SessionSource[] = [
      {
        name: "opencode",
        discover: () => [],
        dispose: () => disposed.push("opencode"),
        extract: () => ({ messages: [], drops: [], badLines: 0 }),
        timeline: () => [],
      },
    ];
    run({ sources });
    expect(disposed).toEqual(["opencode"]);
  });

  it("writes session markdown plainly and the JSON indexes atomically, manifest last", () => {
    const renamed: string[] = [];
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(function (this: unknown, ...a) {
      renamed.push(path.basename(String(a[1])));
      return Reflect.apply(realRename, fs, a);
    });
    try {
      const { stats } = run();
      expect(stats.exportedSessions).toBe(3);
    } finally {
      spy.mockRestore();
    }
    expect(renamed.filter((f) => f.endsWith(".md"))).toEqual([]);
    const indexes = renamed.filter((f) =>
      ["anaphora.json", "outcomes.json", "manifest.json"].includes(f),
    );
    expect(indexes).toEqual(["anaphora.json", "outcomes.json", "manifest.json"]);
  });
});

describe("export: closing lines", () => {
  const stats = (o: Partial<ExportStats>): ExportStats =>
    ({
      exportedSessions: 128,
      totalMessages: 832,
      sessionsByOrigin: { claude: 128 },
      skippedByFilter: 0,
      zeroMessageSessions: 0,
      automationSkipped: 0,
      belowMinMessages: 0,
      readErrors: 0,
      ...o,
    }) as ExportStats;

  it.each([
    ["one tool, nothing left out", {}, ["Exported 128 sessions with 832 of your messages."]],
    [
      "several tools and one reason",
      {
        sessionsByOrigin: { claude: 4, codex: 76, kiro: 33, opencode: 15 },
        automationSkipped: 158,
      },
      [
        "Exported 128 sessions with 832 of your messages.",
        "By tool: 4 Claude Code, 76 Codex, 33 Kiro CLI, 15 OpenCode.",
        "158 sessions were left out: runs started by a tool, not typed by you.",
      ],
    ],
    [
      "several reasons",
      { automationSkipped: 151, zeroMessageSessions: 6, readErrors: 1 },
      [
        "Exported 128 sessions with 832 of your messages.",
        "158 sessions were left out: 151 started by a tool, not typed by you; 6 with none of your messages; 1 that could not be read.",
      ],
    ],
  ] as const)("%s", (_name, o, lines) => {
    expect(exportClosingLines(stats(o as Partial<ExportStats>), { minMessages: 1 })).toEqual(lines);
  });
});
