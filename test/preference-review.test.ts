import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PREFERENCE_REVIEW_FILE,
  preferenceReview,
  preferenceRevision,
  readPreferenceReviews,
  reviewedPreferences,
  savePreferenceReview,
} from "../src/core/preference-review.js";
import type { AggregatedPreference } from "../src/core/preferences.js";

const dirs: string[] = [];
function home() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-review-"));
  dirs.push(directory);
  return directory;
}
function candidate(overrides: Partial<AggregatedPreference> = {}): AggregatedPreference {
  return {
    text: "Use focused tests.",
    count: 1,
    lastAuthoredAt: "2026-11-03T00:00:00Z",
    scope: "global",
    basis: "explicit",
    verified: true,
    occurrences: [
      {
        slug: "testing-task",
        evidence: "Always use focused tests.",
        exportName: "session.md",
        messageId: "session.md#m0",
        quote: "Always use focused tests.",
      },
    ],
    ...overrides,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("reviewed preference instructions", () => {
  it("keeps new and legacy observations out of exported instructions until accepted", () => {
    const directory = home();
    const prefs = [candidate(), candidate({ text: "Be terse.", verified: false })];
    expect(reviewedPreferences(directory, prefs)).toEqual([]);
    expect(preferenceReview(directory, prefs[0] as AggregatedPreference).status).toBe("pending");
    expect(fs.existsSync(path.join(directory, "library"))).toBe(false);
  });

  it("persists edited wording and acceptance without changing the original evidence", () => {
    const directory = home();
    const pref = candidate();
    savePreferenceReview(directory, pref, {
      status: "accepted",
      text: "Test changed behavior with focused cases.",
    });
    expect(reviewedPreferences(directory, [pref])[0]).toMatchObject({
      text: "Test changed behavior with focused cases.",
      occurrences: pref.occurrences,
    });
    expect(pref.text).toBe("Use focused tests.");
    expect(readPreferenceReviews(directory).invalid).toBe(false);
    expect(fs.statSync(path.join(directory, "library", PREFERENCE_REVIEW_FILE)).mode & 0o777).toBe(
      0o600,
    );
    savePreferenceReview(directory, pref, { status: "dismissed" });
    expect(reviewedPreferences(directory, [pref])).toEqual([]);
    savePreferenceReview(directory, pref, { status: "pending" });
    expect(preferenceReview(directory, pref).status).toBe("pending");
  });

  it("exports global rules by default and only the explicitly selected project's rules", () => {
    const directory = home();
    const global = candidate();
    const scoped = candidate({ text: "Use pnpm.", scope: "project", project: "app" });
    const task = candidate({ text: "Create this report.", scope: "task", project: "app" });
    for (const pref of [global, scoped, task])
      savePreferenceReview(directory, pref, { status: "accepted" });
    expect(reviewedPreferences(directory, [global, scoped, task]).map((p) => p.text)).toEqual([
      global.text,
    ]);
    expect(
      reviewedPreferences(directory, [global, scoped, task], "app").map((p) => p.text),
    ).toEqual([global.text, scoped.text]);
    expect(
      reviewedPreferences(directory, [global, scoped, task], "other").map((p) => p.text),
    ).toEqual([global.text]);
  });

  it("allows an explicit scope correction and requires a project for project rules", () => {
    const directory = home();
    const pref = candidate({ scope: "project", project: "app" });
    savePreferenceReview(directory, pref, { status: "accepted", scope: "global" });
    expect(preferenceReview(directory, pref)).toMatchObject({
      status: "accepted",
      scope: "global",
      project: undefined,
    });
    expect(reviewedPreferences(directory, [pref])).toHaveLength(1);
    expect(() =>
      savePreferenceReview(directory, candidate(), { status: "accepted", scope: "project" }),
    ).toThrow("Choose a project");
  });

  it("requires a fresh review when evidence changes and rejects a stale browser revision", () => {
    const directory = home();
    const pref = candidate();
    const oldRevision = preferenceRevision(pref);
    savePreferenceReview(directory, pref, { status: "accepted" });
    const changed = candidate({
      occurrences: [{ slug: "testing-task", evidence: "Actually, skip those tests." }],
    });
    expect(preferenceReview(directory, changed)).toMatchObject({
      status: "pending",
      stale: true,
    });
    expect(reviewedPreferences(directory, [changed])).toEqual([]);
    expect(() =>
      savePreferenceReview(directory, changed, { status: "accepted" }, oldRevision),
    ).toThrow("changed");
  });

  it("leaves a damaged review file untouched", () => {
    const directory = home();
    fs.mkdirSync(path.join(directory, "library"));
    const file = path.join(directory, "library", PREFERENCE_REVIEW_FILE);
    fs.writeFileSync(file, "{broken");
    expect(readPreferenceReviews(directory).invalid).toBe(true);
    expect(() => savePreferenceReview(directory, candidate(), { status: "accepted" })).toThrow(
      "left untouched",
    );
    expect(fs.readFileSync(file, "utf8")).toBe("{broken");
  });

  it("preserves the previous reviews if atomic replacement fails", () => {
    const directory = home();
    const pref = candidate();
    savePreferenceReview(directory, pref, { status: "accepted" });
    const file = path.join(directory, "library", PREFERENCE_REVIEW_FILE);
    const original = fs.readFileSync(file, "utf8");
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("replacement failed");
    });
    expect(() => savePreferenceReview(directory, pref, { status: "dismissed" })).toThrow(
      "replacement failed",
    );
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    expect(fs.readdirSync(path.join(directory, "library"))).toEqual([PREFERENCE_REVIEW_FILE]);
  });
});
