import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { oneshotHash } from "../src/core/library.js";
import { readPreferenceReviews, savePreferenceReview } from "../src/core/preference-review.js";
import { readObservedPreferences } from "../src/core/preferences.js";
import {
  type SuggestionArtifact,
  selectSuggestionInputs,
  suggestionFingerprint,
  suggestionPath,
} from "../src/core/subagents.js";
import { renderSubagentTree } from "../src/core/subagents-render.js";
import { unzipStore } from "../src/core/zip.js";
import type { GuiSubagents } from "../src/gui/server.js";
import { guiHarness, type Harness, request } from "./gui-harness.js";

const SAMPLE = path.join(import.meta.dirname, "fixtures", "subagents", "suggestion.sample.json");

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-gui-subagents-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function sample(): SuggestionArtifact {
  return JSON.parse(fs.readFileSync(SAMPLE, "utf8")) as SuggestionArtifact;
}

/** Save the sample with the fingerprint of the home's current selection, so it reads as fresh. */
function saveFresh(artifact = sample()): SuggestionArtifact {
  const reviews = readPreferenceReviews(home).reviews;
  const { inputs } = selectSuggestionInputs(readObservedPreferences(home), reviews, {
    includeUnreviewed: artifact.selection === "all-candidates",
  });
  const saved = { ...artifact, source_hash: suggestionFingerprint(inputs, reviews) };
  fs.mkdirSync(path.dirname(suggestionPath(home)), { recursive: true });
  fs.writeFileSync(suggestionPath(home), JSON.stringify(saved, null, 2));
  return saved;
}

function prompt(slug: string, preferences: { text: string; evidence: string }[]): void {
  const dir = path.join(home, "library", slug);
  fs.mkdirSync(dir, { recursive: true });
  const content = `# Title of ${slug}\n\nA synthetic prompt.\n`;
  fs.writeFileSync(
    path.join(dir, "sources.json"),
    JSON.stringify({
      slug,
      title: slug,
      members: ["synthetic-session.md"],
      domains: ["testing"],
      confidence: "high",
      authored_at: "2026-10-21T10:00:00Z",
      oneshot_hash: oneshotHash(content),
      preferences,
    }),
  );
  fs.writeFileSync(path.join(dir, `${slug}.oneshot.md`), content);
}

/** The library handler for `home`, called in process (see gui-harness.ts). */
function start(): Harness {
  return guiHarness(home);
}

async function subagents(server: Harness): Promise<GuiSubagents> {
  const response = await request(server, "/api/subagents");
  expect(response.status).toBe(200);
  expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
  return JSON.parse(response.text) as GuiSubagents;
}

function listTree(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((file) => file.split(path.sep).join("/"))
    .sort();
}

describe("GET /api/subagents", () => {
  it("returns no suggestion and the command to create one when no file exists", async () => {
    const server = start();
    const data = await subagents(server);
    expect(data).toEqual({
      suggestion: null,
      stale: false,
      command: `npx human-hindsight@latest suggest-subagents --home '${path.resolve(home)}'`,
      files: {},
    });
    expect(fs.existsSync(path.join(home, "library"))).toBe(false);
  });

  it("returns a valid suggestion with its rendered files and a fresh flag", async () => {
    const saved = saveFresh();
    const server = start();
    const data = await subagents(server);
    expect(data.error).toBeUndefined();
    expect(data.stale).toBe(false);
    expect(data.suggestion).toEqual(saved);
    expect(data.files).toEqual(Object.fromEntries(renderSubagentTree(saved, { target: "all" })));
  });

  it("marks the suggestion stale from the same reviews the Preferences tab reads", async () => {
    prompt("review-task", [{ text: "Use focused tests.", evidence: "Test the change." }]);
    saveFresh();
    const server = start();
    expect((await subagents(server)).stale).toBe(false);
    const [preference] = readObservedPreferences(home);
    if (!preference) throw new Error("Expected the fixture preference.");
    savePreferenceReview(home, preference, { status: "accepted" });
    expect((await subagents(server)).stale).toBe(true);
  });

  it("reports a corrupt file without treating it as absent or rewriting it", async () => {
    fs.mkdirSync(path.dirname(suggestionPath(home)), { recursive: true });
    fs.writeFileSync(suggestionPath(home), "{not json");
    const server = start();
    const data = await subagents(server);
    expect(data).toMatchObject({
      suggestion: null,
      stale: false,
      error: "the file is not valid JSON",
      files: {},
    });
    expect(data.command).toContain("suggest-subagents --home");
    expect(fs.readFileSync(suggestionPath(home), "utf8")).toBe("{not json");
  });

  it("reports a file that fails the schema with the rule it hit", async () => {
    saveFresh({ ...sample(), shared: ["no-such-lesson"] });
    const server = start();
    const data = await subagents(server);
    expect(data.suggestion).toBeNull();
    expect(data.error).toMatch(/SA3/);
  });

  it("leaves /api/library byte-identical whether or not a suggestion exists", async () => {
    prompt("library-task", [{ text: "Be concise.", evidence: "Keep answers short." }]);
    prompt("unverified-task", []);
    const marked = path.join(home, "library", "unverified-task", "sources.json");
    fs.writeFileSync(
      marked,
      JSON.stringify({ ...JSON.parse(fs.readFileSync(marked, "utf8")), outcome_verified: false }),
    );
    const server = start();
    const before = (await request(server, "/api/library")).text;
    expect(before).toContain('"outcomeVerified":false');
    saveFresh();
    const after = (await request(server, "/api/library")).text;
    expect(after).toBe(before);
    expect(after).not.toContain("suggestion");
  });
});

describe("GET /api/subagents/export.zip", () => {
  it("is 404 when there is no suggestion", async () => {
    const server = start();
    const response = await request(server, "/api/subagents/export.zip");
    expect(response.status).toBe(404);
    expect(response.headers["content-disposition"]).toBeUndefined();
  });

  it("serves every target as one parseable zip built in memory", async () => {
    const saved = saveFresh();
    const before = listTree(home);
    const server = start();
    const response = await request(server, "/api/subagents/export.zip");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/zip");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="hindsight-subagents-2026-11-20.zip"',
    );
    expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(Number(response.headers["content-length"])).toBe(response.body.byteLength);
    const tree = renderSubagentTree(saved, { target: "all" });
    const entries = unzipStore(new Uint8Array(response.body));
    expect([...entries.keys()]).toEqual([...tree.keys()]);
    for (const [file, content] of tree) {
      expect(Buffer.from(entries.get(file) ?? new Uint8Array()).toString("utf8")).toBe(content);
    }
    expect(listTree(home)).toEqual(before);
  });

  it("exports one target with the shared knowledge when ?target= names it", async () => {
    const saved = saveFresh();
    const server = start();
    const response = await request(server, "/api/subagents/export.zip?target=kirocrew");
    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="hindsight-subagents-2026-11-20-kirocrew.zip"',
    );
    const paths = [...unzipStore(new Uint8Array(response.body)).keys()];
    expect(paths).toEqual([...renderSubagentTree(saved, { target: "kirocrew" }).keys()]);
    expect(paths.some((file) => file.startsWith("claude/"))).toBe(false);
    expect(paths).toContain("kirocrew/create-bots.sh");
    const all = await request(server, "/api/subagents/export.zip?target=all");
    expect([...unzipStore(new Uint8Array(all.body)).keys()]).toEqual([
      ...renderSubagentTree(saved, { target: "all" }).keys(),
    ]);
  });

  it.each([
    "?target=evil",
    "?target=",
    "?target=..%2Fsuggestion.json",
    "?target=KIROCREW",
    "?target=claude&target=codex",
    "?path=suggestion.json",
    "?target=claude&file=x",
  ])("refuses the query %s with 400", async (query) => {
    saveFresh();
    const server = start();
    const response = await request(server, `/api/subagents/export.zip${query}`);
    expect(response.status).toBe(400);
    expect(response.headers["content-type"]).toContain("text/plain");
  });

  it("answers HEAD with headers only", async () => {
    saveFresh();
    const server = start();
    const response = await request(server, "/api/subagents/export.zip", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.body.byteLength).toBe(0);
    expect(Number(response.headers["content-length"])).toBeGreaterThan(0);
  });

  it("refuses to export a damaged suggestion", async () => {
    fs.mkdirSync(path.dirname(suggestionPath(home)), { recursive: true });
    fs.writeFileSync(suggestionPath(home), "[]");
    const server = start();
    const response = await request(server, "/api/subagents/export.zip");
    expect(response.status).toBe(500);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.text).toContain("could not be read");
  });
});

describe("suggested subagents routes stay read-only and same-origin", () => {
  it.each([
    "/api/subagents",
    "/api/subagents/export.zip",
  ])("rejects POST, PUT and DELETE on %s", async (route) => {
    saveFresh();
    const server = start();
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await request(server, route, { method });
      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe("GET, HEAD");
    }
    expect(JSON.parse(fs.readFileSync(suggestionPath(home), "utf8")).version).toBe(1);
  });

  it("maps no other path under /api/subagents to a file", async () => {
    saveFresh();
    const server = start();
    for (const route of [
      "/api/subagents/suggestion.json",
      "/api/subagents/export.zip/README.md",
      "/api/subagents/../subagents/suggestion.json",
      "/api/subagents/%2e%2e/library",
    ]) {
      expect((await request(server, route)).status).toBe(404);
    }
  });
});
