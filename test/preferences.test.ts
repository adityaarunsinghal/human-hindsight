import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { RunClaudeOptions } from "../src/claude/runner.js";
import { DEFAULT_TIMEOUT_MS } from "../src/claude/runner.js";
import {
  CONSOLIDATE_TIMEOUT_PER_PREFERENCE_MS,
  runPreferences,
} from "../src/commands/preferences.js";
import {
  CONSOLIDATED_PREFERENCES_FILE,
  readConsolidatedPreferences,
} from "../src/core/consolidated-preferences.js";
import type { LibraryEntry } from "../src/core/library.js";
import { savePreferenceReview } from "../src/core/preference-review.js";
import {
  aggregatePreferences,
  normalizeKey,
  preferenceId,
  readObservedPreferences,
  renderClaudeMdBlock,
  renderPreferencesBlock,
} from "../src/core/preferences.js";
import type { RunnerFn } from "../src/distill/pipeline.js";

// --- helpers ---------------------------------------------------------------

const tmpDirs: string[] = [];
function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cch-prefs-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function entry(
  slug: string,
  prefs: { text: string; evidence: string }[],
  authoredAt = "2026-07-01T00:00:00.000Z",
): LibraryEntry {
  return {
    slug,
    dir: `/x/${slug}`,
    oneshotPath: `/x/${slug}/${slug}.oneshot.md`,
    sources: {
      slug,
      title: slug,
      members: ["a.md"],
      sessionIds: ["s"],
      preferences: prefs,
      outcome_summary: "1 completed",
      domains: ["testing"],
      confidence: "high",
      authored_at: authoredAt,
      model: null,
      prompt_version: 1,
      tool_version: "0.1.0",
      generation: "g1",
    },
  };
}

function writeLibraryEntry(home: string, e: LibraryEntry): void {
  const dir = path.join(home, "library", e.slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "sources.json"), JSON.stringify(e.sources));
}

function capture(): { out: Writable; text: () => string } {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { out, text: () => chunks.join("") };
}

function inputWith(line: string): Readable {
  const pt = new PassThrough();
  pt.end(line);
  return pt;
}

/** Recording fake clipboard: captures the text and reports a fixed tool. */
function fakeClipboard(): {
  copy: (text: string) => Promise<{ ok: true; tool: string }>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    copy: async (text: string) => {
      calls.push(text);
      return { ok: true, tool: "pbcopy" };
    },
  };
}

// --- aggregation -------------------------------------------------------------

describe("normalizeKey", () => {
  it("folds case, whitespace, and punctuation", () => {
    expect(normalizeKey("Diagnose before acting.")).toBe("diagnose before acting");
    expect(normalizeKey("  diagnose   BEFORE acting ")).toBe("diagnose before acting");
    expect(normalizeKey("Don't guess!")).toBe("dont guess");
  });
});

describe("aggregatePreferences", () => {
  it("dedupes near-identical strings and ranks by frequency then recency", () => {
    const entries = [
      entry("task-one-here", [
        { text: "Diagnose before acting.", evidence: "e1" },
        { text: "pin versions", evidence: "e2" },
      ]),
      entry(
        "task-two-here",
        [{ text: "diagnose before acting", evidence: "e3" }],
        "2026-07-05T00:00:00.000Z",
      ),
      entry("task-three-here", [{ text: "Be terse", evidence: "e4" }], "2026-07-09T00:00:00.000Z"),
    ];
    const prefs = aggregatePreferences(entries);
    expect(prefs).toHaveLength(3);
    // frequency first: the duplicated one wins
    expect(prefs[0]?.count).toBe(2);
    expect(prefs[0]?.text).toBe("diagnose before acting"); // newest phrasing
    expect(prefs[0]?.occurrences.map((o) => o.slug)).toEqual(["task-one-here", "task-two-here"]);
    // recency tiebreak between the two count-1 items:
    expect(prefs[1]?.text).toBe("Be terse");
    expect(prefs[2]?.text).toBe("pin versions");
  });

  it("counts a preference once per task even if restated", () => {
    const prefs = aggregatePreferences([
      entry("task-one-here", [
        { text: "be terse", evidence: "a" },
        { text: "Be terse.", evidence: "b" },
      ]),
    ]);
    expect(prefs).toHaveLength(1);
    expect(prefs[0]?.count).toBe(1);
  });
});

describe("renderClaudeMdBlock", () => {
  it("groups the paste-ready block by occurrence count, most-stated first", () => {
    const entries = [
      entry("t-one-a", [{ text: "diagnose before acting", evidence: "e" }]),
      entry("t-two-b", [{ text: "diagnose before acting", evidence: "e" }]),
      entry("t-three-c", [{ text: "pin versions", evidence: "e" }]),
    ];
    const block = renderClaudeMdBlock(
      aggregatePreferences(entries),
      3,
      new Date("2026-07-13T00:00:00Z"),
    );
    expect(block.split("\n")).toEqual([
      "<!-- human-hindsight preferences · generated 2026-07-13 -->",
      "## Working preferences",
      "",
      "<!-- stated in 2 of 3 tasks -->",
      "- diagnose before acting",
      "",
      "<!-- stated in 1 of 3 tasks -->",
      "- pin versions",
    ]);
  });

  it("renders consolidated items (no occurrences) as a flat list without headers", () => {
    const merged = [
      { text: "be terse", count: 3, occurrences: [], lastAuthoredAt: "" },
      { text: "pin versions", count: 1, occurrences: [], lastAuthoredAt: "" },
    ];
    const block = renderClaudeMdBlock(merged, 5, new Date("2026-07-13T00:00:00Z"));
    expect(block).toContain("- be terse");
    expect(block).not.toContain("stated in");
  });
});

describe("renderPreferencesBlock — targets", () => {
  const prefs = [
    {
      text: "diagnose before acting",
      count: 1,
      occurrences: [{ slug: "t", evidence: "e" }],
      lastAuthoredAt: "",
    },
  ];
  const NOW = new Date("2026-07-13T00:00:00Z");

  it("claude target is byte-identical to renderClaudeMdBlock (deprecated wrapper)", () => {
    expect(renderPreferencesBlock(prefs, 1, "claude", NOW)).toBe(
      renderClaudeMdBlock(prefs, 1, NOW),
    );
  });

  it("kiro target names the steering file in the provenance comment; body unchanged", () => {
    const block = renderPreferencesBlock(prefs, 1, "kiro", NOW);
    expect(block).toContain("~/.kiro/steering/hindsight-preferences.md");
    expect(block).toContain("## Working preferences");
    expect(block).toContain("- diagnose before acting");
    // Same body as claude — only the leading comment differs.
    const claudeBody = renderClaudeMdBlock(prefs, 1, NOW).split("\n").slice(1).join("\n");
    expect(block.split("\n").slice(1).join("\n")).toBe(claudeBody);
  });

  it("agents target points at AGENTS.md; body unchanged", () => {
    const block = renderPreferencesBlock(prefs, 1, "agents", NOW);
    expect(block).toContain("add to AGENTS.md");
    const claudeBody = renderClaudeMdBlock(prefs, 1, NOW).split("\n").slice(1).join("\n");
    expect(block.split("\n").slice(1).join("\n")).toBe(claudeBody);
  });
});

// --- command -------------------------------------------------------------------

describe("runPreferences", () => {
  it("exits 1 with a hint when the library is empty", async () => {
    const cap = capture();
    const code = await runPreferences({ home: tmpHome() }, { output: cap.out });
    expect(code).toBe(1);
    expect(cap.text()).toContain("library is empty");
    expect(cap.text()).toContain("human-hindsight distill");
  });

  it("does not export or consolidate pending suggestions by default", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("one-task", [{ text: "Be terse.", evidence: "Keep it short." }]));
    let calls = 0;
    const cap = capture();
    const code = await runPreferences(
      { home, yes: true, consolidate: true },
      {
        output: cap.out,
        runner: (async () => {
          calls++;
          throw new Error("pending evidence must not run");
        }) as RunnerFn,
      },
    );
    expect(code).toBe(0);
    expect(calls).toBe(0);
    expect(cap.text()).toContain("No accepted preferences");
    expect(cap.text()).not.toContain("- Be terse.");
  });

  it("consolidates only accepted rules and preserves a reviewed edit", async () => {
    const home = tmpHome();
    writeLibraryEntry(
      home,
      entry("one-task", [
        { text: "Be terse.", evidence: "Keep it short." },
        { text: "Use tables.", evidence: "A table would help here." },
      ]),
    );
    const observed = readObservedPreferences(home);
    const accepted = observed.find((p) => p.text === "Be terse.");
    const dismissed = observed.find((p) => p.text === "Use tables.");
    if (!accepted || !dismissed) throw new Error("Missing fixture candidates");
    savePreferenceReview(home, accepted, { status: "accepted", text: "Keep replies concise." });
    savePreferenceReview(home, dismissed, { status: "dismissed" });
    const cap = capture();
    let prompt = "";
    const code = await runPreferences(
      { home, yes: true, consolidate: true },
      {
        output: cap.out,
        clipboard: fakeClipboard().copy,
        runner: (async (opts: RunClaudeOptions<unknown>) => {
          prompt = opts.prompt;
          return {
            preferences: [{ text: "Keep replies concise.", source_ids: [preferenceId(accepted)] }],
          };
        }) as RunnerFn,
      },
    );
    expect(code).toBe(0);
    expect(prompt).toContain("Keep replies concise.");
    expect(prompt).not.toContain("Use tables.");
    expect(readConsolidatedPreferences(home).artifact).toMatchObject({
      version: 2,
      include_unreviewed: false,
      preferences: [{ text: "Keep replies concise.", source_ids: [preferenceId(accepted)] }],
    });
  });

  it("rejects empty output after a correction and keeps the previous successful consolidation", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("one-task", [{ text: "Be terse.", evidence: "Keep it short." }]));
    const candidate = readObservedPreferences(home)[0];
    if (!candidate) throw new Error("Missing fixture candidate");
    savePreferenceReview(home, candidate, { status: "accepted" });
    await runPreferences(
      { home, yes: true, consolidate: true },
      {
        output: capture().out,
        clipboard: fakeClipboard().copy,
        runner: (async () => ({
          preferences: [{ text: "Be terse.", source_ids: [preferenceId(candidate)] }],
        })) as RunnerFn,
      },
    );
    const file = path.join(home, "library", CONSOLIDATED_PREFERENCES_FILE);
    const before = fs.readFileSync(file, "utf8");
    let calls = 0;
    const cap = capture();
    const code = await runPreferences(
      { home, yes: true, consolidate: true },
      {
        output: cap.out,
        runner: (async () => {
          calls++;
          return { preferences: [] };
        }) as RunnerFn,
      },
    );
    expect(code).toBe(1);
    expect(calls).toBe(2);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(cap.text()).toContain("consolidation failed");
  });

  it("prints the deterministic block without any claude involvement", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("t-one-a", [{ text: "be terse", evidence: "e" }]));
    writeLibraryEntry(home, entry("t-two-b", [{ text: "Be terse!", evidence: "e" }]));
    const cap = capture();
    const runner: RunnerFn = (async () => {
      throw new Error("must not be called");
    }) as RunnerFn;
    const code = await runPreferences(
      { home, "include-unreviewed": true },
      { output: cap.out, runner },
    );
    expect(code).toBe(0);
    expect(cap.text()).toContain("1 preference(s) across 2 task(s)");
    expect(cap.text()).toContain("- be terse");
    expect(cap.text()).toContain("stated in 2 of 2 tasks");
    expect(readConsolidatedPreferences(home)).toEqual({ artifact: null, invalid: false });
  });

  it("--target kiro renders the steering-file block and footer", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("t-one-a", [{ text: "be terse", evidence: "e" }]));
    const cap = capture();
    const code = await runPreferences(
      { home, "include-unreviewed": true, target: "kiro" },
      { output: cap.out },
    );
    expect(code).toBe(0);
    expect(cap.text()).toContain("~/.kiro/steering/hindsight-preferences.md");
    expect(cap.text()).toContain("- be terse");
  });

  it("--target agents renders an AGENTS.md block", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("t-one-a", [{ text: "be terse", evidence: "e" }]));
    const cap = capture();
    const code = await runPreferences(
      { home, "include-unreviewed": true, target: "agents" },
      { output: cap.out },
    );
    expect(code).toBe(0);
    expect(cap.text()).toContain("AGENTS.md");
  });

  it("--consolidate declined exits 2 and never invokes", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("t-one-a", [{ text: "be terse", evidence: "e" }]));
    const cap = capture();
    let called = false;
    const runner: RunnerFn = (async () => {
      called = true;
      return { preferences: [] };
    }) as RunnerFn;
    const code = await runPreferences(
      { home, "include-unreviewed": true, consolidate: true },
      { output: cap.out, input: inputWith("n\n"), runner },
    );
    expect(code).toBe(2);
    expect(called).toBe(false);
    expect(cap.text()).toContain("declined");
  });

  it("--consolidate with --yes runs one call and prints the merged block", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("t-one-a", [{ text: "be terse", evidence: "e" }]));
    writeLibraryEntry(home, entry("t-two-b", [{ text: "keep answers terse", evidence: "e" }]));
    const cap = capture();
    let prompt = "";
    let model: string | undefined;
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      prompt = opts.prompt;
      model = opts.model;
      return {
        preferences: [
          { text: "be terse", source_ids: readObservedPreferences(home).map(preferenceId) },
        ],
      };
    }) as RunnerFn;
    const code = await runPreferences(
      { home, "include-unreviewed": true, consolidate: true, yes: true, model: "sonnet" },
      { output: cap.out, runner, clipboard: fakeClipboard().copy },
    );
    expect(code).toBe(0);
    expect(model).toBe("sonnet"); // --model must reach the claude call
    expect(prompt).toContain("Merge semantic duplicates");
    expect(prompt).toContain('"text":"be terse"');
    expect(prompt).toContain('"count":1');
    expect(cap.text()).toContain("consolidated 2 → 1 preference(s).");
    expect(cap.text()).toContain("- be terse");
    // Counts are derived from the retained source occurrences.
    expect(cap.text()).toContain("stated in 2 of 2");
    const saved = readConsolidatedPreferences(home);
    expect(saved.invalid).toBe(false);
    expect(saved.artifact?.preferences).toEqual([
      { text: "be terse", source_ids: readObservedPreferences(home).map(preferenceId) },
    ]);
    expect(saved.artifact?.source_preferences).toHaveLength(2);
    expect(saved.artifact?.markdown).toContain("- be terse");
    expect(
      fs.statSync(path.join(home, "library", CONSOLIDATED_PREFERENCES_FILE)).mode & 0o777,
    ).toBe(0o600);
  });

  it("scales the consolidation call's default timeout with the preference count", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("t-one-a", [{ text: "be terse", evidence: "e" }]));
    writeLibraryEntry(home, entry("t-two-b", [{ text: "prefer tables", evidence: "e" }]));
    const cap = capture();
    let seen: number | undefined;
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      seen = opts.timeoutMs;
      return {
        preferences: readObservedPreferences(home).map((p) => ({
          text: p.text,
          source_ids: [preferenceId(p)],
        })),
      };
    }) as RunnerFn;
    const code = await runPreferences(
      { home, "include-unreviewed": true, consolidate: true, yes: true },
      { output: cap.out, runner, clipboard: fakeClipboard().copy },
    );
    expect(code).toBe(0);
    // 2 aggregated preferences → base + 2 × per-preference allowance.
    expect(seen).toBe(DEFAULT_TIMEOUT_MS + CONSOLIDATE_TIMEOUT_PER_PREFERENCE_MS * 2);
  });

  it("passes an explicit --timeout (seconds) through to the consolidation call unscaled", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("t-one-a", [{ text: "be terse", evidence: "e" }]));
    const cap = capture();
    let seen: number | undefined;
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      seen = opts.timeoutMs;
      return {
        preferences: [
          { text: "be terse", source_ids: readObservedPreferences(home).map(preferenceId) },
        ],
      };
    }) as RunnerFn;
    const code = await runPreferences(
      { home, "include-unreviewed": true, consolidate: true, yes: true, timeout: "900" },
      { output: cap.out, runner, clipboard: fakeClipboard().copy },
    );
    expect(code).toBe(0);
    expect(seen).toBe(900_000);
  });

  it("consolidation failure exits 1 with the reason and the deterministic fallback block", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("t-one-a", [{ text: "be terse", evidence: "e" }]));
    const cap = capture();
    const runner: RunnerFn = (async () => {
      throw new Error("claude reported an error: API Error: 400 data retention mode");
    }) as RunnerFn;
    const code = await runPreferences(
      { home, "include-unreviewed": true, consolidate: true, yes: true },
      { output: cap.out, runner },
    );
    expect(code).toBe(1);
    expect(cap.text()).toContain("consolidation failed: claude reported an error");
    expect(cap.text()).not.toContain("at runClaude"); // reason, not a stack trace
    // still yields the usable deterministic artifact:
    expect(cap.text()).toContain("## Working preferences");
    expect(cap.text()).toContain("- be terse");
    expect(readConsolidatedPreferences(home)).toEqual({ artifact: null, invalid: false });
  });

  it("retains the last saved consolidation when a later model call fails or is declined", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("one-task", [{ text: "be terse", evidence: "e" }]));
    const clipboard = fakeClipboard().copy;
    await runPreferences(
      { home, "include-unreviewed": true, consolidate: true, yes: true },
      {
        output: capture().out,
        clipboard,
        runner: (async () => ({
          preferences: [
            {
              text: "Keep replies concise.",
              source_ids: readObservedPreferences(home).map(preferenceId),
            },
          ],
        })) as RunnerFn,
      },
    );
    const file = path.join(home, "library", CONSOLIDATED_PREFERENCES_FILE);
    const before = fs.readFileSync(file, "utf8");
    const runner = (async () => {
      throw new Error("Unavailable");
    }) as RunnerFn;
    expect(
      await runPreferences(
        { home, "include-unreviewed": true, consolidate: true, yes: true },
        { runner, clipboard, output: capture().out },
      ),
    ).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(
      await runPreferences(
        { home, "include-unreviewed": true, consolidate: true },
        { runner, clipboard, output: capture().out, input: inputWith("n\n") },
      ),
    ).toBe(2);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("reports a failed save while keeping the generated block available to copy", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("one-task", [{ text: "be terse", evidence: "e" }]));
    fs.mkdirSync(path.join(home, "library", CONSOLIDATED_PREFERENCES_FILE));
    const cap = capture();
    const clipboard = fakeClipboard();
    const code = await runPreferences(
      { home, "include-unreviewed": true, consolidate: true, yes: true },
      {
        output: cap.out,
        clipboard: clipboard.copy,
        runner: (async () => ({
          preferences: [
            {
              text: "Keep replies concise.",
              source_ids: readObservedPreferences(home).map(preferenceId),
            },
          ],
        })) as RunnerFn,
      },
    );
    expect(code).toBe(1);
    expect(cap.text()).toContain("Could not save consolidated preferences");
    expect(clipboard.calls[0]).toContain("- Keep replies concise.");
    expect(fs.readdirSync(path.join(home, "library")).some((file) => file.endsWith(".tmp"))).toBe(
      false,
    );
  });

  it("plain mode: enter (default yes) copies the exact rendered block and shows the target", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("t-one-a", [{ text: "be terse", evidence: "e" }]));
    writeLibraryEntry(home, entry("t-two-b", [{ text: "Be terse!", evidence: "e" }]));
    const cap = capture();
    const clip = fakeClipboard();
    const code = await runPreferences(
      { home, "include-unreviewed": true },
      { output: cap.out, input: inputWith("\n"), clipboard: clip.copy },
    );
    expect(code).toBe(0);
    // clipboard received the exact rendered block (no trailing newline).
    const prefs = aggregatePreferences([
      entry("t-one-a", [{ text: "be terse", evidence: "e" }]),
      entry("t-two-b", [{ text: "Be terse!", evidence: "e" }]),
    ]);
    const expected = renderPreferencesBlock(prefs, 2, "claude");
    expect(clip.calls).toHaveLength(1);
    expect(clip.calls[0]?.replace(/generated \d{4}-\d{2}-\d{2}/, "generated DATE")).toBe(
      expected.replace(/generated \d{4}-\d{2}-\d{2}/, "generated DATE"),
    );
    expect(cap.text()).toContain("copied (");
    expect(cap.text()).toContain("CLAUDE.md");
  });

  it("plain mode: answering n skips the copy entirely", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("t-one-a", [{ text: "be terse", evidence: "e" }]));
    const cap = capture();
    const clip = fakeClipboard();
    const code = await runPreferences(
      { home, "include-unreviewed": true },
      { output: cap.out, input: inputWith("n\n"), clipboard: clip.copy },
    );
    expect(code).toBe(0);
    expect(clip.calls).toHaveLength(0);
    expect(cap.text()).not.toContain("copied (");
  });

  it("plain mode: no input stream (pipe/CI) never offers a copy", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("t-one-a", [{ text: "be terse", evidence: "e" }]));
    const cap = capture();
    const clip = fakeClipboard();
    const code = await runPreferences(
      { home, "include-unreviewed": true },
      { output: cap.out, clipboard: clip.copy },
    );
    expect(code).toBe(0);
    expect(clip.calls).toHaveLength(0);
    expect(cap.text()).not.toContain("copied (");
    expect(cap.text()).not.toContain("Copy block to clipboard?");
  });

  it("--consolidate with --yes copies the consolidated block", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("t-one-a", [{ text: "be terse", evidence: "e" }]));
    writeLibraryEntry(home, entry("t-two-b", [{ text: "keep answers terse", evidence: "e" }]));
    const cap = capture();
    const clip = fakeClipboard();
    const runner: RunnerFn = (async () => ({
      preferences: [
        { text: "be terse", source_ids: readObservedPreferences(home).map(preferenceId) },
      ],
    })) as RunnerFn;
    const code = await runPreferences(
      { home, "include-unreviewed": true, consolidate: true, yes: true },
      { output: cap.out, runner, clipboard: clip.copy },
    );
    expect(code).toBe(0);
    expect(clip.calls).toHaveLength(1);
    // The consolidated block retains source evidence counts.
    expect(clip.calls[0]).toContain("- be terse");
    expect(clip.calls[0]).toContain("stated in 2 of 2");
    expect(cap.text()).toContain("copied (1 preference(s)");
  });
});
