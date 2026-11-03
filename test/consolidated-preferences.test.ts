import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONSOLIDATED_PREFERENCES_FILE,
  preferencesFingerprint,
  readConsolidatedPreferences,
  saveConsolidatedPreferences,
} from "../src/core/consolidated-preferences.js";
import type { AggregatedPreference } from "../src/core/preferences.js";

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
      preferences: [{ text: "Keep replies concise.", merged_from: 2 }],
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
});

describe("saved preference artifacts", () => {
  it("treats a missing artifact as normal without creating a library directory", () => {
    expect(readConsolidatedPreferences(home)).toEqual({ artifact: null, invalid: false });
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("stores exact Markdown and provenance without retaining original evidence", () => {
    const markdown =
      "<!-- generated result -->\n## Working preferences\n\n- Keep **replies** concise.\n";
    const file = save(markdown);
    const result = readConsolidatedPreferences(home);
    expect(result.invalid).toBe(false);
    expect(result.artifact).toMatchObject({
      version: 1,
      generated_at: "2026-11-01T12:00:00.000Z",
      task_count: 2,
      target: "agents",
      source_hash: preferencesFingerprint(inputs()),
      source_preferences: inputs().map(({ text, count }) => ({ text, count })),
      markdown,
    });
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain("first-task");
    expect(raw).not.toContain("Cover the edge cases.");
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
});
