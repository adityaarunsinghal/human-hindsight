import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAnaphoraMap } from "../../src/core/artifacts.js";
import { isEdited, readLibrary, readLibraryIssues } from "../../src/core/library.js";
import { exportMessages } from "../../src/core/preference-evidence.js";
import { preferenceReview, readPreferenceReviews } from "../../src/core/preference-review.js";
import { readObservedPreferences } from "../../src/core/preferences.js";
import { readSuggestion } from "../../src/core/subagents.js";
import { loadDigests, loadTasks } from "../../src/distill/checkpoints.js";
import { createClock } from "./clock.js";
import { type BuiltHome, homeBuilder, SAMPLE_GENERATION, sampleHome } from "./home.js";

let built: BuiltHome | undefined;
afterEach(() => {
  built?.remove();
  built = undefined;
});

describe("sampleHome", () => {
  it("writes exports the project's readers accept", () => {
    built = sampleHome().build();
    expect(built.exports).toEqual(["alpha-a1111111.md", "alpha-a2222222.md", "beta-b3333333.md"]);
    const manifest = built.json<{ export: string; messages: number }[]>("exports/manifest.json");
    expect(manifest.map((row) => row.export)).toEqual(built.exports);
    const messages = exportMessages("alpha-a1111111.md", built.read("exports/alpha-a1111111.md"));
    expect(messages.map((message) => message.id)).toEqual([
      "alpha-a1111111.md#m0",
      "alpha-a1111111.md#m1",
    ]);
    expect(manifest[0]?.messages).toBe(2);
    const anaphora = parseAnaphoraMap(built.json("exports/anaphora.json"));
    expect(anaphora["alpha-a1111111.md"]?.map((record) => record.human_text)).toEqual([
      "Looks good, ship it.",
    ]);
    expect(built.json<Record<string, unknown>>("exports/outcomes.json")._note).toMatch(
      /machine-authored/,
    );
  });

  it("writes digests, tasks, and library entries that load cleanly", () => {
    built = sampleHome().build();
    const digests = loadDigests(built.dir);
    expect(Object.keys(digests?.digests ?? {})).toHaveLength(3);
    expect(Object.keys(digests?.lineage ?? {})).toHaveLength(3);
    const tasks = loadTasks(built.dir);
    expect(tasks?.generation).toBe(SAMPLE_GENERATION);
    expect(tasks?.tasks.map((task) => task.slug)).toEqual([
      "fix-build-step",
      "write-release-notes",
    ]);
    const library = readLibrary(built.dir);
    expect(library.map((entry) => entry.slug).sort()).toEqual([
      "fix-build-step",
      "write-release-notes",
    ]);
    expect(readLibraryIssues(built.dir)).toEqual([]);
    expect(library.every((entry) => !isEdited(entry))).toBe(true);
  });

  it("produces verified preferences, a valid review, and a fresh suggestion", () => {
    built = sampleHome().build();
    const prefs = readObservedPreferences(built.dir);
    const small = prefs.find((pref) => pref.text === "Keep changes small.");
    expect(small?.verified).toBe(true);
    expect(small?.count).toBe(2);
    const notes = prefs.find((pref) => pref.text === "Write release notes in plain words.");
    expect([notes?.scope, notes?.project]).toEqual(["project", "beta"]);
    const reviews = readPreferenceReviews(built.dir);
    expect(reviews.invalid).toBe(false);
    expect(small && preferenceReview(built.dir, small, reviews.reviews).status).toBe("accepted");
    const suggestion = readSuggestion(built.dir);
    expect(suggestion?.stale).toBe(false);
    expect(suggestion?.artifact.selection).toBe("accepted");
    expect(suggestion?.artifact.inputs.map((input) => input.text)).toEqual(["Keep changes small."]);
  });

  it("uses the injected clock for written times", () => {
    const clock = createClock("2030-03-04T05:06:07.000Z");
    built = sampleHome({ now: clock.now }).build();
    expect(
      built.json<{ authored_at: string }>("library/fix-build-step/sources.json").authored_at,
    ).toBe("2030-03-04T05:06:07.000Z");
    expect(readSuggestion(built.dir)?.artifact.generated_at).toBe("2030-03-04T05:06:07.000Z");
  });
});

describe("homeBuilder", () => {
  it("builds only what was asked for", () => {
    built = homeBuilder()
      .session({
        project: "gamma",
        sessionId: "c4444444-0000-4000-8000-000000000004",
        messages: ["One message only."],
      })
      .build();
    expect(fs.readdirSync(built.dir)).toEqual(["exports"]);
    expect(loadDigests(built.dir)).toBeNull();
  });

  it("a dismissed review keeps the suggestion inputs empty, so a suggestion is refused", () => {
    const builder = homeBuilder()
      .session({
        project: "gamma",
        sessionId: "c5555555-0000-4000-8000-000000000005",
        messages: ["Always run the linter first."],
      })
      .digest(0, {
        preferences: [{ text: "Run the linter first.", quote: "run the linter first" }],
      })
      .review("Run the linter first.", "dismissed")
      .suggestion();
    expect(() => builder.build()).toThrow(/at least one preference/);
  });

  it.each([
    [
      "a quote that is not in the session",
      (b: ReturnType<typeof homeBuilder>) =>
        b.digest(0, { preferences: [{ text: "x", quote: "not present" }] }),
      /is not in/,
    ],
    [
      "a library entry without a task",
      (b: ReturnType<typeof homeBuilder>) => b.library("no-such-task"),
      /has no task/,
    ],
    [
      "a review of an unknown preference",
      (b: ReturnType<typeof homeBuilder>) => b.review("Unknown.", "accepted"),
      /No observed preference/,
    ],
  ])("refuses %s", (_name, extend, message) => {
    const builder = homeBuilder().session({
      project: "delta",
      sessionId: "d6666666-0000-4000-8000-000000000006",
      messages: ["Plain request."],
    });
    expect(() => extend(builder).build()).toThrow(message);
  });

  it("writes into a given folder and leaves it in place on remove", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-given-"));
    const home = homeBuilder()
      .session({
        project: "eps",
        sessionId: "e7777777-0000-4000-8000-000000000007",
        messages: ["Hi there."],
      })
      .build(dir);
    home.remove();
    expect(fs.existsSync(home.path("exports/manifest.json"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
