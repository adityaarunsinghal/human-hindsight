import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONSOLIDATED_PREFERENCES_FILE,
  materializeConsolidation,
  preferencesFingerprint,
  readConsolidatedPreferences,
  saveConsolidatedPreferences,
  validateConsolidation,
} from "../src/core/consolidated-preferences.js";
import { type AggregatedPreference, preferenceId } from "../src/core/preferences.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-consolidated-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function inputs(): AggregatedPreference[] {
  return [
    {
      text: "Keep replies concise.",
      count: 2,
      occurrences: [
        { slug: "first-task", evidence: "A short answer, please." },
        { slug: "second-task", evidence: "Keep it brief." },
      ],
      lastAuthoredAt: "2026-10-20T12:00:00Z",
    },
    {
      text: "Use focused tests.",
      count: 1,
      occurrences: [{ slug: "first-task", evidence: "Cover the edge cases." }],
      lastAuthoredAt: "2026-10-19T12:00:00Z",
    },
  ];
}

function save(markdown = "## Working preferences\n\n- Keep replies concise.") {
  return saveConsolidatedPreferences(home, {
    source: inputs(),
    consolidated: {
      preferences: [{ text: "Keep replies concise.", source_ids: inputs().map(preferenceId) }],
    },
    taskCount: 2,
    target: "agents",
    markdown,
    now: new Date("2026-11-01T12:00:00Z"),
  });
}

describe("saved preference fingerprints", () => {
  it("ignores ordering and evidence changes while detecting model-input changes", () => {
    const source = inputs();
    const originalOrder = source.map((preference) => preference.text);
    const fingerprint = preferencesFingerprint(source);
    const reordered = source.toReversed().map((preference) => ({
      ...preference,
      occurrences: [],
      lastAuthoredAt: "2026-11-02T12:00:00Z",
    }));
    expect(preferencesFingerprint(reordered)).toBe(fingerprint);
    expect(source.map((preference) => preference.text)).toEqual(originalOrder);
    expect(
      preferencesFingerprint(source.map((preference) => ({ ...preference, count: 3 }))),
    ).not.toBe(fingerprint);
    expect(
      preferencesFingerprint(
        source.map((preference) => ({ ...preference, text: `${preference.text} Updated.` })),
      ),
    ).not.toBe(fingerprint);
  });

  it("does not confuse text boundaries or omit duplicate inputs", () => {
    expect(
      preferencesFingerprint([
        { text: "a", count: 1 },
        { text: "b", count: 2 },
      ]),
    ).not.toBe(preferencesFingerprint([{ text: "a1b", count: 2 }]));
    expect(
      preferencesFingerprint([
        { text: "same", count: 1 },
        { text: "same", count: 1 },
      ]),
    ).not.toBe(preferencesFingerprint([{ text: "same", count: 1 }]));
  });

  it("includes scope and project identity in the model-input fingerprint", () => {
    const source = inputs();
    expect(preferencesFingerprint(source)).not.toBe(
      preferencesFingerprint(
        source.map((p) => ({ ...p, scope: "project" as const, project: "webapp" })),
      ),
    );
  });
});

describe("consolidation source coverage", () => {
  const rule = (text: string) => ({ text, count: 1, occurrences: [], lastAuthoredAt: "" });

  it("rejects empty, unknown, duplicate, and omitted source mappings", () => {
    const source = inputs();
    const ids = source.map(preferenceId);
    const [first, second] = ids;
    if (!first || !second) throw new Error("Missing fixture source IDs");
    expect(validateConsolidation(source, { preferences: [] })).not.toEqual([]);
    expect(
      validateConsolidation(source, {
        preferences: [{ text: "Concise.", source_ids: ["unknown"] }],
      }),
    ).not.toEqual([]);
    expect(
      validateConsolidation(source, {
        preferences: [{ text: "Concise.", source_ids: [first, first, second] }],
      }),
    ).not.toEqual([]);
    expect(
      validateConsolidation(source, { preferences: [{ text: "Concise.", source_ids: [first] }] }),
    ).not.toEqual([]);
  });

  it("refuses to merge rules from incompatible scopes or different projects", () => {
    const source = inputs().map((p, index) => ({
      ...p,
      scope: "project" as const,
      project: index ? "mobile" : "web",
    }));
    expect(
      validateConsolidation(source, {
        preferences: [{ text: "Do both.", source_ids: source.map(preferenceId) }],
      }),
    ).toContain("item 1 merges incompatible scopes or projects");
  });

  it("keeps every source occurrence and derives unique-source counts", () => {
    const source = inputs();
    const merged = materializeConsolidation(source, {
      preferences: [{ text: "Use concise, focused checks.", source_ids: source.map(preferenceId) }],
    });
    expect(merged[0]?.count).toBe(2);
    expect(merged[0]?.occurrences).toHaveLength(3);
    expect(merged[0]?.occurrences.map((o) => o.evidence)).toContain("Cover the edge cases.");
  });

  it("rejects directly opposing instructions in the same merge", () => {
    const source = [rule("Always run tests."), rule("Never run tests.")];
    const problems = validateConsolidation(source, {
      preferences: [{ text: "Always run tests.", source_ids: source.map(preferenceId) }],
    });
    expect(problems).toContain(
      "item 1 combines explicitly opposing instructions; keep those rules separate",
    );
    expect(
      validateConsolidation(source, {
        preferences: source.map((p) => ({ text: p.text, source_ids: [preferenceId(p)] })),
      }),
    ).toEqual([]);
  });

  it("preserves preference strength and an explicit condition clause", () => {
    const source = [rule("Prefer small changes unless this is a migration.")];
    expect(
      validateConsolidation(source, {
        preferences: [{ text: "Always make small changes.", source_ids: source.map(preferenceId) }],
      }),
    ).toEqual(
      expect.arrayContaining([
        'item 1 removed the "prefer" qualifier',
        'item 1 removed or changed condition "unless this is a migration"',
        'item 1 introduced stronger qualifier "always"',
      ]),
    );
    expect(
      validateConsolidation(source, {
        preferences: [
          {
            text: "Prefer focused changes unless this is a migration.",
            source_ids: source.map(preferenceId),
          },
        ],
      }),
    ).toEqual([]);
  });

  it("keeps differently conditional rules separate", () => {
    const source = [
      rule("Run checks only when changing code."),
      rule("Run checks if dependencies changed."),
    ];
    expect(
      validateConsolidation(source, {
        preferences: [
          {
            text: "Run checks only when changing code, and if dependencies changed.",
            source_ids: source.map(preferenceId),
          },
        ],
      }),
    ).toContain("item 1 combines different explicit conditions; keep those rules separate");
  });
});

describe("saved preference artifacts", () => {
  it("treats a missing artifact as normal without creating a library directory", () => {
    expect(readConsolidatedPreferences(home)).toEqual({ artifact: null, invalid: false });
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("stores exact Markdown with source mapping and original evidence", () => {
    const markdown =
      "<!-- generated result -->\n## Working preferences\n\n- Keep **replies** concise.\n";
    const file = save(markdown);
    const result = readConsolidatedPreferences(home);
    expect(result.invalid).toBe(false);
    expect(result.artifact).toMatchObject({
      version: 2,
      generated_at: "2026-11-01T12:00:00.000Z",
      task_count: 2,
      target: "agents",
      source_hash: preferencesFingerprint(inputs()),
      source_preferences: inputs().map(({ text, count }) => ({ text, count })),
      markdown,
    });
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).toContain("first-task");
    expect(raw).toContain("Cover the edge cases.");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it("replaces a successful artifact without disturbing prompt files", () => {
    const file = save("First result");
    const promptDirectory = path.join(home, "library", "task-one");
    fs.mkdirSync(promptDirectory);
    fs.writeFileSync(path.join(promptDirectory, "task-one.oneshot.md"), "Original prompt.");
    expect(save("Second result")).toBe(file);
    expect(readConsolidatedPreferences(home).artifact?.markdown).toBe("Second result");
    expect(fs.readFileSync(path.join(promptDirectory, "task-one.oneshot.md"), "utf8")).toBe(
      "Original prompt.",
    );
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual([
      CONSOLIDATED_PREFERENCES_FILE,
      "task-one",
    ]);
  });

  it("preserves the prior artifact and removes its temporary file if replacement fails", () => {
    const file = save("Prior successful result");
    const before = fs.readFileSync(file, "utf8");
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("Simulated replacement failure");
    });
    expect(() => save("Replacement result")).toThrow("Simulated replacement failure");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readdirSync(path.dirname(file))).toEqual([CONSOLIDATED_PREFERENCES_FILE]);
  });

  it("cleans up a partially written temporary file after a write error", () => {
    const file = save("Prior successful result");
    const before = fs.readFileSync(file, "utf8");
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce((target, _data, options) => {
      write(target, '{"partial":', options);
      throw new Error("Simulated full disk");
    });
    expect(() => save("Replacement result")).toThrow("Simulated full disk");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readdirSync(path.dirname(file))).toEqual([CONSOLIDATED_PREFERENCES_FILE]);
  });

  it.each([
    ["non-object", null],
    ["unsupported version", { version: 99 }],
    ["invalid timestamp", { generated_at: "yesterday" }],
    ["invalid hash", { source_hash: "not-a-hash" }],
    ["invalid source input", { source_preferences: [{ text: 42, count: "two" }] }],
    ["invalid task count", { task_count: -1 }],
    ["unknown target", { target: "external" }],
    ["invalid consolidated preference", { preferences: [{ text: "Use tests." }] }],
    ["missing Markdown", { markdown: null }],
  ])("flags %s without overwriting the file", (_label, invalid) => {
    const file = save();
    const artifact = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const raw = JSON.stringify(invalid === null ? invalid : { ...artifact, ...invalid });
    fs.writeFileSync(file, raw);
    expect(readConsolidatedPreferences(home)).toEqual({ artifact: null, invalid: true });
    expect(fs.readFileSync(file, "utf8")).toBe(raw);
  });

  it("tolerates unknown future metadata without rewriting a valid saved result", () => {
    const file = save();
    const artifact = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const raw = JSON.stringify({ ...artifact, future_metadata: { model: "synthetic-model" } });
    fs.writeFileSync(file, raw);
    expect(readConsolidatedPreferences(home).invalid).toBe(false);
    expect(readConsolidatedPreferences(home).artifact?.markdown).toBe(artifact.markdown);
    expect(fs.readFileSync(file, "utf8")).toBe(raw);
  });

  it("keeps a legacy version-1 result readable without claiming traceable sources", () => {
    const file = save();
    const old = JSON.parse(fs.readFileSync(file, "utf8"));
    old.version = 1;
    old.preferences = [{ text: "Keep replies concise.", merged_from: 2 }];
    old.source_preferences = inputs().map(({ text, count }) => ({ text, count }));
    fs.writeFileSync(file, JSON.stringify(old));
    expect(readConsolidatedPreferences(home).artifact).toMatchObject({
      version: 1,
      preferences: [{ text: "Keep replies concise.", merged_from: 2 }],
    });
  });
});
