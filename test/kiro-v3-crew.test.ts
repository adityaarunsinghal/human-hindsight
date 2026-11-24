import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type ManifestEntry, runExport } from "../src/commands/export.js";
import { renderStatus } from "../src/commands/status.js";
import { collectKiroV3Sessions } from "../src/sources/kiro/discover-v3.js";
import {
  classifyKiroV3Lines,
  isKirocrewDrivenV3,
  KIRO_CREW_K15_REASON,
} from "../src/sources/kiro/extract-v3.js";
import { kiroSource } from "../src/sources/kiro/index.js";

/**
 * K15: Kiro Crew runs copied into the kiro-cli v3 store are excluded from the
 * kiro source and counted as handed off to the Kiro Crew store. Every session
 * under kiro-home-v3-crew is synthetic; c15000NN is the session number below.
 */
const KIRO_HOME = path.join(import.meta.dirname, "fixtures", "kiro-home-v3-crew");

const sess = (n: string) => `sess_c15000${n}-0000-4000-8000-0000000000${n}`;

/** One fixture per K15 trigger. */
const TRIGGERS: Record<string, string> = {
  "request marker line in a later user turn (beats .history)": sess("01"),
  "[SESSION CONTEXT first prompt": sess("02"),
  "[SESSION RESUMED first prompt": sess("03"),
  "[RUNTIME] first prompt": sess("04"),
  "[AGENT SYSTEM PROMPT] first prompt": sess("05"),
  "subagent_ cwd under kirocrew-workspace": sess("06"),
  "cron_ cwd under kirocrew-workspace": sess("07"),
  "Crew agentMode plus a harness envelope turn": sess("08"),
};

/** Negative controls: each must stay an ordinary human session. */
const CONTROLS: Record<string, string> = {
  "marker only in an assistant entry or mid-sentence": sess("11"),
  "Crew agentMode with no other signal": sess("12"),
  "ordinary human session with a .history companion": sess("13"),
  "subagent_ cwd outside kirocrew-workspace": sess("14"),
};

const byStem = new Map(
  collectKiroV3Sessions(KIRO_HOME, { countEntries: false }).map((s) => [
    s.file.replace(/\.jsonl$/, ""),
    s,
  ]),
);

function fixture(stem: string) {
  const s = byStem.get(stem);
  if (!s) throw new Error(`missing fixture ${stem}`);
  return { meta: s.meta, lines: fs.readFileSync(s.path, "utf8").split(/\r?\n/) };
}

describe("K15 discovery: agentMode is read from session.json", () => {
  it("surfaces agentMode on the v3 meta", () => {
    expect(fixture(sess("12")).meta.agentMode).toBe("kirocrew");
    expect(fixture(sess("08")).meta.agentMode).toBe("kirocrew-worker");
    expect(fixture(sess("13")).meta.agentMode).toBe("vibe");
  });
});

describe("K15 classify: each trigger excludes the session", () => {
  for (const [name, stem] of Object.entries(TRIGGERS)) {
    it(`excludes on ${name}`, () => {
      const { meta, lines } = fixture(stem);
      expect(isKirocrewDrivenV3(meta, lines)).toBe(true);
      expect(classifyKiroV3Lines(meta, lines)).toEqual({
        include: false,
        reason: KIRO_CREW_K15_REASON,
        kind: "kirocrew",
      });
    });
  }

  it("uses the exact reason text from the plan", () => {
    expect(KIRO_CREW_K15_REASON).toBe("K15: Kiro Crew run (read it with --source kirocrew)");
  });

  it("the request-marker fixture really has a .history companion (precedence proof)", () => {
    expect(fixture(sess("01")).meta.hasHistory).toBe(true);
  });
});

describe("K15 classify: negative controls stay included", () => {
  for (const [name, stem] of Object.entries(CONTROLS)) {
    it(`includes ${name}`, () => {
      const { meta, lines } = fixture(stem);
      expect(isKirocrewDrivenV3(meta, lines)).toBe(false);
      const verdict = classifyKiroV3Lines(meta, lines);
      expect(verdict.include).toBe(true);
      expect(verdict.kind).toBeUndefined();
    });
  }
});

describe("K15 via kiroSource.classify", () => {
  const source = kiroSource(KIRO_HOME);
  const sessions = source
    .discover({ countEntries: false })
    .flatMap((p) => p.sessions.map((s) => ({ ...s, project: p.shortName })));
  const verdictOf = (stem: string) => {
    const s = sessions.find((x) => x.file === `${stem}.jsonl`);
    if (!s) throw new Error(`missing fixture ${stem}`);
    return source.classify?.(s);
  };

  it("maps every trigger to the kirocrew verdict", () => {
    for (const stem of Object.values(TRIGGERS)) expect(verdictOf(stem)).toBe("kirocrew");
  });

  it("maps every control to interactive", () => {
    for (const stem of Object.values(CONTROLS)) expect(verdictOf(stem)).toBe("interactive");
  });
});

// ---- export + status over the fixture home ---------------------------------

const tmpHomes: string[] = [];
afterAll(() => {
  for (const h of tmpHomes) fs.rmSync(h, { recursive: true, force: true });
});

function freshHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "human-hindsight-k15-"));
  tmpHomes.push(home);
  return home;
}

function makeSink(): { sink: Writable; text: () => string } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI colour codes
  return { sink, text: () => chunks.join("").replace(/\u001b\[[0-9;]*m/g, "") };
}

const HANDED_OFF_LINE =
  "  8 Kiro CLI sessions were Kiro Crew runs; their messages are read from the Kiro Crew store (--source kirocrew)";

describe("K15 export", () => {
  for (const source of ["kiro", "auto"] as const) {
    it(`--source ${source}: excludes Crew runs, counts them, prints the handed-off line`, () => {
      const home = freshHome();
      const { sink, text } = makeSink();
      const stats = runExport({
        home,
        "kiro-dir": KIRO_HOME,
        "claude-dir": path.join(home, "no-claude"),
        "codex-dir": path.join(home, "no-codex"),
        source,
        output: sink,
      });

      expect(stats.kirocrewHandedOff).toBe(8);
      expect(stats.automationSkipped).toBe(0);
      expect(stats.exportedSessions).toBe(4);
      expect(text()).toContain(HANDED_OFF_LINE);

      // The handed-off line follows the automation slot in the summary block.
      const out = text().split("\n");
      expect(out.findIndex((l) => l.includes("Kiro Crew runs"))).toBeGreaterThan(
        out.findIndex((l) => l.startsWith("Saved in ")),
      );

      // No file for any excluded session; one per control.
      const manifest = JSON.parse(
        fs.readFileSync(path.join(home, "exports", "manifest.json"), "utf8"),
      ) as ManifestEntry[];
      const ids = manifest.map((e) => e.sessionId).sort();
      expect(ids).toEqual(Object.values(CONTROLS).sort());
      const mdFiles = fs.readdirSync(path.join(home, "exports")).filter((f) => f.endsWith(".md"));
      // Export names truncate the id, so match the written files to the manifest.
      expect(mdFiles.sort()).toEqual(manifest.map((e) => e.export).sort());
      expect(stats.files).toEqual(mdFiles.sort());
      // No injected context reached any export.
      for (const f of mdFiles) {
        const md = fs.readFileSync(path.join(home, "exports", f), "utf8");
        expect(md).not.toMatch(/^\[CURRENT USER REQUEST -- respond to this\]$/m);
        expect(md).not.toContain("[SESSION CONTEXT");
      }
    });
  }

  it("prints no handed-off line when nothing was handed off", () => {
    const home = freshHome();
    const { sink, text } = makeSink();
    const stats = runExport({
      home,
      "kiro-dir": path.join(import.meta.dirname, "fixtures", "kiro-v3-home"),
      source: "kiro",
      output: sink,
    });
    expect(stats.kirocrewHandedOff).toBe(0);
    expect(text()).not.toContain("Kiro Crew runs");
  });
});

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI colour codes
const plainText = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

describe("K15 status", () => {
  for (const source of ["kiro", "auto"] as const) {
    it(`--source ${source}: shows the handed-off count saved by the last export`, () => {
      const home = freshHome();
      const dirs = {
        claudeDir: path.join(home, "no-claude"),
        codexDir: path.join(home, "no-codex"),
        kiroDir: KIRO_HOME,
      };
      runExport({
        home,
        "kiro-dir": dirs.kiroDir,
        "claude-dir": dirs.claudeDir,
        "codex-dir": dirs.codexDir,
        source,
        output: makeSink().sink,
      });
      const plain = plainText(renderStatus({ home, ...dirs, source }));
      expect(plain).toContain("discovered  12 sessions");
      expect(plain).toContain(HANDED_OFF_LINE);
      // The line sits under the exported count it came from.
      const lines = plain.split("\n");
      expect(lines.findIndex((l) => l.includes("Kiro Crew runs"))).toBe(
        lines.findIndex((l) => l.startsWith("exported ")) + 1,
      );
    });
  }

  it("reads the count from export-stats.json, not the store: it survives the store going away", () => {
    const home = freshHome();
    runExport({
      home,
      "kiro-dir": KIRO_HOME,
      "claude-dir": path.join(home, "no-claude"),
      "codex-dir": path.join(home, "no-codex"),
      source: "kiro",
      output: makeSink().sink,
    });
    const plain = plainText(
      renderStatus({
        home,
        claudeDir: path.join(home, "no-claude"),
        codexDir: path.join(home, "no-codex"),
        kiroDir: path.join(home, "kiro-store-gone"),
        source: "kiro",
      }),
    );
    expect(plain).toContain(HANDED_OFF_LINE);
  });

  it("with no export-stats.json (an older export) it prints nothing for K15 and does not scan", () => {
    const home = freshHome();
    const read = vi.spyOn(fs, "readFileSync");
    let plain: string;
    try {
      plain = plainText(
        renderStatus({
          home,
          claudeDir: path.join(home, "no-claude"),
          codexDir: path.join(home, "no-codex"),
          kiroDir: KIRO_HOME,
          source: "kiro",
        }),
      );
      // No session transcript was read: discovery lists the store, it does not classify it.
      const transcripts = read.mock.calls.filter((call) => String(call[0]).endsWith(".jsonl"));
      expect(transcripts).toEqual([]);
    } finally {
      read.mockRestore();
    }
    // The store holds 8 Crew runs, but status never classifies it.
    expect(plain).toContain("discovered  12 sessions");
    expect(plain).not.toContain("Kiro Crew runs");
  });
});
