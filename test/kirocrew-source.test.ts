import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { resolvePaths } from "../src/commands/_shared.js";
import { type ManifestEntry, runExport } from "../src/commands/export.js";
import { buildCorpus } from "../src/core/dedupe.js";
import {
  classifyKirocrewFile,
  KIROCREW_AUTOMATION_PREFIXES,
  KIROCREW_INTERACTIVE_PREFIXES,
  kirocrewSource,
} from "../src/sources/kirocrew/index.js";
import { parseSourceMode, resolveSources } from "../src/sources/registry.js";

// Every store here is the synthetic fixture or a fresh temp dir; the real
// ~/.kiro/crew is never read (test/setup.ts points the default elsewhere).
const HOME = path.join(import.meta.dirname, "fixtures", "kirocrew-home");
const SESSIONS = path.join(HOME, "sessions");
const LIVE = "dashboard_chat-1-1760000000.jsonl";
const ARCHIVE = "dashboard_chat-1-1760000000__20261101-120000.jsonl";

const tmp: string[] = [];
function tempDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hindsight-kirocrew-${tag}-`));
  tmp.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

/** Absent stores for every other backend, so `auto` sees only the Crew fixture. */
function otherDirsAbsent(root: string) {
  return {
    claudeDir: path.join(root, "no-claude"),
    codexDir: path.join(root, "no-codex"),
    kiroDir: path.join(root, "no-kiro"),
    opencodeDir: path.join(root, "no-opencode"),
  };
}

describe("kirocrew classify: session level, by file name", () => {
  it("exports the prefix lists as constants", () => {
    expect(KIROCREW_INTERACTIVE_PREFIXES).toEqual(["dashboard_chat-"]);
    expect(KIROCREW_AUTOMATION_PREFIXES).toEqual([
      "cron_",
      "dashboard_cron",
      "dashboard_setup-recovery",
      "dashboard_member-mate",
    ]);
  });

  it("dashboard chats are interactive", () => {
    expect(classifyKirocrewFile(LIVE)).toBe("interactive");
  });

  it("cron, dashboard cron, setup recovery and member memory runs are automation", () => {
    for (const file of [
      "cron_100251a5.jsonl",
      "cron_d8c8babd_e71dfa08.jsonl",
      "dashboard_cron-daily.jsonl",
      "dashboard_setup-recovery-20260101-000000.jsonl",
      "dashboard_member-mate.memory-member-mate-abc123.jsonl",
    ]) {
      expect(classifyKirocrewFile(file)).toBe("automation");
    }
  });

  it("an unknown prefix is interactive (recall-oriented default)", () => {
    expect(classifyKirocrewFile("slack_thread-1.jsonl")).toBe("interactive");
  });

  it("an archive snapshot classifies by the stem before __", () => {
    expect(classifyKirocrewFile(ARCHIVE)).toBe("interactive");
    expect(classifyKirocrewFile("cron_abc__20261101-120000.jsonl")).toBe("automation");
  });

  it("the source's classify uses the file name", () => {
    const source = kirocrewSource(HOME);
    const verdicts = Object.fromEntries(
      source
        .discover({ countEntries: false })
        .flatMap((p) =>
          p.sessions.map((s) => [s.file, source.classify?.({ ...s, project: p.shortName })]),
        ),
    );
    expect(verdicts).toEqual({
      [LIVE]: "interactive",
      [ARCHIVE]: "interactive",
      "dashboard_chat-2-1760000100.jsonl": "interactive",
      "cron_abc12345.jsonl": "automation",
      "dashboard_setup-recovery-20260101-000000.jsonl": "automation",
    });
  });
});

describe("kirocrew registry wiring", () => {
  it("parseSourceMode accepts kirocrew and names it in the error", () => {
    expect(parseSourceMode("kirocrew")).toBe("kirocrew");
    expect(parseSourceMode("KiroCrew")).toBe("kirocrew");
    expect(() => parseSourceMode("crew")).toThrow(
      /expected claude, codex, kiro, kirocrew, opencode, or auto/,
    );
  });

  it("explicit mode returns the one source even when its store is absent", () => {
    const root = tempDir("explicit");
    const sources = resolveSources("kirocrew", {
      ...otherDirsAbsent(root),
      kirocrewDir: path.join(root, "absent"),
    });
    expect(sources.map((s) => s.name)).toEqual(["kirocrew"]);
    expect(sources[0]?.discover()).toEqual([]);
  });

  it("auto includes kirocrew when the store holds a chat", () => {
    const root = tempDir("auto-present");
    const sources = resolveSources("auto", { ...otherDirsAbsent(root), kirocrewDir: HOME });
    expect(sources.map((s) => s.name)).toEqual(["kirocrew"]);
  });

  it("auto omits kirocrew when the store is absent", () => {
    const root = tempDir("auto-absent");
    const sources = resolveSources("auto", {
      ...otherDirsAbsent(root),
      kirocrewDir: path.join(root, "absent"),
    });
    expect(sources).toEqual([]);
  });

  it("auto omits kirocrew when sessions/ exists but holds no chat", () => {
    const root = tempDir("auto-empty");
    const crew = path.join(root, "crew");
    fs.mkdirSync(path.join(crew, "sessions", ".index"), { recursive: true });
    fs.writeFileSync(path.join(crew, "sessions", ".msg-count"), "0\n");
    const sources = resolveSources("auto", { ...otherDirsAbsent(root), kirocrewDir: crew });
    expect(sources).toEqual([]);
  });
});

describe("--kirocrew-dir through resolvePaths", () => {
  const saved = process.env.HUMAN_HINDSIGHT_KIROCREW_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.HUMAN_HINDSIGHT_KIROCREW_DIR;
    else process.env.HUMAN_HINDSIGHT_KIROCREW_DIR = saved;
  });

  it("the flag wins over the environment", () => {
    process.env.HUMAN_HINDSIGHT_KIROCREW_DIR = "/env/crew";
    expect(resolvePaths({ "kirocrew-dir": "/flag/crew" }).kirocrewDir).toBe("/flag/crew");
  });

  it("the environment wins over the default", () => {
    process.env.HUMAN_HINDSIGHT_KIROCREW_DIR = "/env/crew";
    expect(resolvePaths({}).kirocrewDir).toBe("/env/crew");
  });

  it("the default is ~/.kiro/crew", () => {
    delete process.env.HUMAN_HINDSIGHT_KIROCREW_DIR;
    expect(resolvePaths({}).kirocrewDir).toBe(path.join(os.homedir(), ".kiro", "crew"));
  });
});

describe("kirocrew archive snapshots: R8 dedupe attributes each turn once", () => {
  it("an archive copy plus its live chat yield each human turn once", () => {
    const source = kirocrewSource(HOME);
    const read = (file: string) =>
      fs
        .readFileSync(
          path.join(file === ARCHIVE ? path.join(SESSIONS, "archive") : SESSIONS, file),
          "utf8",
        )
        .split(/\r?\n/);
    const corpus = buildCorpus(
      [LIVE, ARCHIVE].map((file) => ({
        project: "widgets",
        sessionId: file.replace(/\.jsonl$/, ""),
        sourcePath: file,
        extracted: source.extract(read(file)),
      })),
    );
    const all = corpus.sessions.flatMap((s) => s.messages.map((m) => m.text));
    expect(all).toEqual([
      "please refactor the widget parser",
      "go with option two",
      "actually skip the tests for now",
      "meta arrived as a string",
      "thanks, ship it",
    ]);
    expect(new Set(all).size).toBe(all.length);
    expect(corpus.duplicatesDropped).toBe(3);
  });
});

describe("kirocrew export end to end", () => {
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

  function exportFixture(source?: string) {
    const root = tempDir("export");
    const home = path.join(root, "home");
    const { sink, text } = makeSink();
    const stats = runExport({
      home,
      "claude-dir": path.join(root, "no-claude"),
      "codex-dir": path.join(root, "no-codex"),
      "kiro-dir": path.join(root, "no-kiro"),
      "opencode-dir": path.join(root, "no-opencode"),
      "kirocrew-dir": HOME,
      source,
      output: sink,
    });
    const exportsDir = path.join(home, "exports");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(exportsDir, "manifest.json"), "utf8"),
    ) as ManifestEntry[];
    const markdown = stats.files
      .map((f) => fs.readFileSync(path.join(exportsDir, f), "utf8"))
      .join("\n");
    return { stats, manifest, markdown, out: text() };
  }

  for (const mode of ["auto", "kirocrew"]) {
    it(`--source ${mode}: writes the human turns and none of the machine side`, () => {
      const { stats, manifest, markdown } = exportFixture(mode);
      for (const turn of [
        "please refactor the widget parser",
        "go with option two",
        "actually skip the tests for now",
        "meta arrived as a string",
        "thanks, ship it",
        "a chat whose metadata line is missing",
      ]) {
        expect(markdown.split(turn).length - 1).toBe(1);
      }
      for (const machine of [
        "Here is a plan with two options.",
        "synthetic tool output",
        "SESSION CONTEXT",
        "auto-nudge",
        "Throttled by the model provider",
        "synthetic system notice",
        "synthetic subagent brief",
        "synthetic host notice",
        "synthetic-attachment.txt",
        "synthetic card payload",
        "Subagent completion event",
        "synthetic relayed machine text",
        "summarize yesterday's synthetic tickets",
        "synthetic recovery instructions",
        "index sidecar",
        "dotfile, never a session",
      ]) {
        expect(markdown).not.toContain(machine);
      }
      // cron + setup-recovery excluded at session level; the archive copy owns nothing.
      expect(stats.automationSkipped).toBe(2);
      expect(stats.exportedSessions).toBe(2);
      expect(stats.duplicatesDropped).toBe(3);
      expect(stats.badLines).toBe(1);
      expect(manifest.map((e) => e.origin)).toEqual(["kirocrew", "kirocrew"]);
      expect(stats.sessionsByOrigin).toEqual({ kirocrew: 2 });
      expect(manifest.map((e) => e.sessionId).sort()).toEqual([
        "dashboard_chat-1-1760000000",
        "dashboard_chat-2-1760000100",
      ]);
      expect(manifest.find((e) => e.sessionId === "dashboard_chat-1-1760000000")?.source).toBe(
        path.join(SESSIONS, LIVE),
      );
    });
  }
});
