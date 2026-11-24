import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONSOLIDATED_PREFERENCES_FILE,
  saveConsolidatedPreferences,
} from "../src/core/consolidated-preferences.js";
import { digestSourceFingerprint } from "../src/core/fingerprint.js";
import { oneshotHash, readLibrary } from "../src/core/library.js";
import { preferenceReview, savePreferenceReview } from "../src/core/preference-review.js";
import {
  aggregatePreferences,
  preferenceId,
  readObservedPreferences,
} from "../src/core/preferences.js";
import { acquireWriterLock, readWriterLock } from "../src/distill/operations.js";
import type { GuiSnapshot } from "../src/gui/server.js";
import { guiHarness, type Harness, request } from "./gui-harness.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cch-gui-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function prompt(slug: string, text: string, extra: Record<string, unknown> = {}): string {
  const dir = path.join(home, "library", slug);
  fs.mkdirSync(dir, { recursive: true });
  const content = `<!-- private provenance -->\n# Title of ${slug}\n\n${text}\n`;
  fs.writeFileSync(
    path.join(dir, "sources.json"),
    JSON.stringify({
      slug,
      title: "Original title",
      members: ["private-session.md"],
      domains: ["testing"],
      confidence: "high",
      authored_at: "2026-10-21T10:00:00Z",
      oneshot_hash: oneshotHash(content),
      source_paths: ["/private/transcript.jsonl"],
      ...extra,
    }),
  );
  const file = path.join(dir, `${slug}.oneshot.md`);
  fs.writeFileSync(file, content);
  return file;
}

/** The library handler for `home`, called in process (see gui-harness.ts). */
function start(): Harness {
  return guiHarness(home);
}

describe("local GUI server", () => {
  it("changes the revision when a prompt is published or edited or preferences arrive", async () => {
    const server = start();
    const revision = async () =>
      JSON.parse((await request(server, "/api/library/revision")).text).revision;
    const empty = await revision();
    const file = prompt("test", "Initial body");
    const published = await revision();
    expect(published).not.toBe(empty);
    expect(await revision()).toBe(published);
    fs.appendFileSync(file, " More.");
    const edited = await revision();
    expect(edited).not.toBe(published);
    fs.writeFileSync(path.join(home, "library", "preferences.generalized.json"), "{}");
    expect(await revision()).not.toBe(edited);
  });

  it("serves only the small built-in UI assets, with restrictive browser headers", async () => {
    const server = start();
    for (const [route, type] of [
      ["/", "text/html"],
      ["/app.css", "text/css"],
      ["/app.js", "text/javascript"],
    ]) {
      const response = await request(server, route ?? "");
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain(type);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
      expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    }
    const head = await request(server, "/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.text).toBe("");
    expect(Number(head.headers["content-length"])).toBeGreaterThan(0);
  });

  it("returns the exact copyable body and browsing metadata without private provenance", async () => {
    const text = 'Keep this <script>alert("not executable")</script> text.\n\n- Match my wording.';
    const file = prompt("example-task", text, { rating: "up" });
    const server = start();
    const response = await request(server, "/api/library");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({
      entries: [
        {
          slug: "example-task",
          title: "Title of example-task",
          body: text,
          domains: ["testing"],
          confidence: "high",
          sessions: 1,
          authoredAt: "2026-10-21T10:00:00Z",
          rating: "up",
          edited: false,
          preferenceIds: [],
        },
      ],
      preferences: [],
      preferencesMarkdown: "",
      skipped: 0,
    });
    expect(response.text).not.toContain("private");
    expect(response.text).not.toContain(file);
    expect((await request(server, "/")).text).not.toContain('alert("not executable")');
  });

  it("picks up local edits on refresh without rewriting anything", async () => {
    const file = prompt("editable-task", "Original body.");
    const server = start();
    await request(server, "/api/library");
    fs.writeFileSync(file, "# My revised title\n\nMy revised prompt.");
    const response = JSON.parse((await request(server, "/api/library")).text);
    expect(response.entries[0]).toMatchObject({
      title: "My revised title",
      body: "My revised prompt.",
      edited: true,
    });
    expect(fs.readFileSync(file, "utf8")).toBe("# My revised title\n\nMy revised prompt.");
  });

  it("handles empty libraries and missing prompt files", async () => {
    const server = start();
    expect(JSON.parse((await request(server, "/api/library")).text)).toMatchObject({
      entries: [],
      preferences: [],
      preferencesMarkdown: "",
      skipped: 0,
    });
    const file = prompt("missing-task", "Will be removed.");
    fs.unlinkSync(file);
    expect(JSON.parse((await request(server, "/api/library")).text)).toMatchObject({
      entries: [],
      preferences: [],
      preferencesMarkdown: "",
      skipped: 1,
    });
  });

  it("aggregates preferences with evidence, domains, and links in both directions", async () => {
    prompt("older-task", "Older prompt.", {
      title: "Old metadata title",
      authored_at: "2026-10-20T10:00:00Z",
      domains: ["documentation"],
      preferences: [
        { text: "Use focused tests.", evidence: "Cover the behavior." },
        { text: "Use focused tests!", evidence: "Repeated in the same task." },
        { text: "Keep documentation concise.", evidence: "Use short instructions." },
      ],
    });
    const newer = prompt("newer-task", "Newer prompt.", {
      domains: ["testing"],
      preferences: [{ text: "use focused tests", evidence: "Test the **edge cases**." }],
    });
    fs.writeFileSync(newer, "# A locally edited title\n\nNewer prompt.");
    const server = start();
    const response = await request(server, "/api/library");
    const snapshot = JSON.parse(response.text) as GuiSnapshot;
    expect(snapshot.preferences).toHaveLength(2);
    const recurring = snapshot.preferences[0];
    expect(recurring).toEqual({
      id: expect.stringMatching(/^[a-f0-9]{64}$/),
      text: "use focused tests",
      scope: "global",
      verified: false,
      review: expect.objectContaining({
        status: "pending",
        scope: "global",
        stale: false,
        revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      count: 2,
      domains: ["Software engineering > Testing", "Writing & research > documentation"],
      lastAuthoredAt: "2026-10-21T10:00:00Z",
      occurrences: [
        {
          slug: "newer-task",
          title: "A locally edited title",
          evidence: "Test the **edge cases**.",
          available: true,
        },
        {
          slug: "older-task",
          title: "Title of older-task",
          evidence: "Cover the behavior.",
          available: true,
        },
      ],
    });
    expect(snapshot.entries.find((entry) => entry.slug === "newer-task")?.preferenceIds).toEqual([
      recurring?.id,
    ]);
    expect(snapshot.entries.find((entry) => entry.slug === "older-task")?.preferenceIds).toEqual(
      snapshot.preferences.map((preference) => preference.id),
    );
    expect(snapshot.preferencesMarkdown).toContain("## Working preferences");
    expect(snapshot.preferencesMarkdown).toContain("<!-- stated in 2 of 2 tasks -->");
    expect(snapshot.preferencesMarkdown.match(/^- use focused tests$/gm)).toHaveLength(1);
    expect(snapshot.preferencesMarkdown).toContain("- Keep documentation concise.");
    expect(response.text).not.toContain("private");
    expect(response.text).not.toContain("Old metadata title");
    expect(response.text).not.toContain("Repeated in the same task.");
  });

  it("uses only supporting session domains instead of the grouped prompt's full domain union", async () => {
    const text = "Check keyboard navigation and accessible labels.";
    const sessions = [
      { export: "first.md", domain: "Software engineering > Frontend > Accessibility" },
      { export: "second.md", domain: "software engineering → frontend → accessibility" },
    ];
    fs.mkdirSync(path.join(home, "exports"));
    fs.mkdirSync(path.join(home, "distill"));
    const digests: Record<string, unknown> = {};
    const lineage: Record<string, unknown> = {};
    const manifest = sessions.map((session) => {
      const content = `### 2026-11-01T12:00:00Z\n\n${text}\n`;
      const metadata = {
        export: session.export,
        project: "sample",
        sessionId: session.export,
        origin: "codex" as const,
      };
      fs.writeFileSync(path.join(home, "exports", session.export), content);
      digests[session.export] = {
        goal: "Improve accessibility.",
        deliverable: "Accessible controls.",
        domain: session.domain,
        keywords: ["accessibility"],
        outcome: "completed",
        preferences: [
          {
            text,
            evidence: "Explicit human request.",
            scope: "global",
            basis: "explicit",
            citations: [{ message_id: `${session.export}#m0`, quote: text }],
          },
        ],
      };
      lineage[session.export] = {
        source_hash: digestSourceFingerprint({ content, ...metadata }),
      };
      return metadata;
    });
    fs.writeFileSync(path.join(home, "exports", "manifest.json"), JSON.stringify(manifest));
    fs.writeFileSync(
      path.join(home, "distill", "digests.json"),
      JSON.stringify({ digests, lineage }),
    );
    prompt("grouped-work", "A task spanning several kinds of work.", {
      members: ["first.md", "second.md", "unrelated.md"],
      domains: [
        "software engineering > frontend > accessibility",
        "Data & AI > Data pipelines",
        "Software engineering > Infrastructure > Deployment",
      ],
    });

    const server = start();
    const snapshot = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    expect(snapshot.preferences).toHaveLength(1);
    expect(snapshot.preferences[0]?.domains).toEqual([
      "Software engineering > Frontend > Accessibility",
    ]);
    expect(snapshot.preferences[0]?.occurrences).toHaveLength(2);
    expect(snapshot.entries[0]?.domains).toContain("Data & AI > Data pipelines");
  });

  it("normalizes duplicate legacy domains without changing their source metadata", async () => {
    const domains = [
      "Software engineering > Frontend > Accessibility",
      "software engineering → frontend → accessibility",
      "  Software engineering  /  Frontend  /  Accessibility  ",
    ];
    const file = prompt("legacy-work", "Legacy prompt.", {
      domains,
      preferences: [{ text: "Keep labels accessible.", evidence: "Check the labels." }],
    });
    const server = start();
    const snapshot = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    expect(snapshot.preferences[0]?.domains).toEqual([
      "Software engineering > Frontend > Accessibility",
    ]);
    const saved = JSON.parse(
      fs.readFileSync(path.join(path.dirname(file), "sources.json"), "utf8"),
    );
    expect(saved.domains).toEqual(domains);
  });

  it("keeps preferences available when their source prompt file is missing", async () => {
    const file = prompt("missing-source", "Removed prompt.", {
      title: "Missing source title",
      preferences: [{ text: "Keep useful evidence.", evidence: "An observed instruction." }],
    });
    fs.unlinkSync(file);
    const server = start();
    const snapshot = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.skipped).toBe(1);
    expect(snapshot.preferences[0]).toMatchObject({
      text: "Keep useful evidence.",
      count: 1,
      occurrences: [
        {
          slug: "missing-source",
          title: "Missing source title",
          evidence: "An observed instruction.",
          available: false,
        },
      ],
    });
    expect(snapshot.preferencesMarkdown).toContain("- Keep useful evidence.");
  });

  it("keeps available and missing source evidence in one deduplicated preference", async () => {
    prompt("available-source", "Still available.", {
      domains: ["Software engineering > Backend > APIs > Pagination > Cursor"],
      authored_at: "2026-10-22T12:00:00Z",
      preferences: [
        { text: "Keep contracts stable.", evidence: "Preserve existing callers." },
        { text: "Keep contracts stable!", evidence: "Repeated within the same task." },
      ],
    });
    const missing = prompt("missing-source", "Removed prompt.", {
      domains: ["release engineering"],
      authored_at: "2026-10-21T12:00:00Z",
      preferences: [{ text: "keep contracts stable", evidence: "Do not break the release." }],
    });
    fs.unlinkSync(missing);
    const server = start();
    const snapshot = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.preferences).toHaveLength(1);
    expect(snapshot.preferences[0]).toMatchObject({
      text: "Keep contracts stable.",
      count: 2,
      domains: [
        "Software engineering > Infrastructure > release engineering",
        "Software engineering > Backend > APIs > Pagination > Cursor",
      ].sort((a, b) => a.localeCompare(b)),
      occurrences: [
        {
          slug: "available-source",
          available: true,
          evidence: "Preserve existing callers.",
        },
        {
          slug: "missing-source",
          available: false,
          evidence: "Do not break the release.",
        },
      ],
    });
    expect(snapshot.entries[0]?.preferenceIds).toEqual([snapshot.preferences[0]?.id]);
    expect(snapshot.skipped).toBe(1);
  });

  it("refreshes preferences without invalidating bookmarks for equivalent wording", async () => {
    const file = prompt("updated-task", "Prompt.", {
      preferences: [{ text: "Use focused tests.", evidence: "Original evidence." }],
    });
    const server = start();
    const before = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    const metadataPath = path.join(path.dirname(file), "sources.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    metadata.preferences = [
      { text: "USE focused tests!", evidence: "Updated **evidence**." },
      { text: "Keep the layout readable.", evidence: "Check narrow screens." },
    ];
    const updated = JSON.stringify(metadata);
    fs.writeFileSync(metadataPath, updated);
    const after = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    expect(after.preferences).toHaveLength(2);
    const preference = after.preferences.find((item) => item.text === "USE focused tests!");
    expect(preference?.id).toBe(before.preferences[0]?.id);
    expect(preference?.occurrences[0]?.evidence).toBe("Updated **evidence**.");
    expect(fs.readFileSync(metadataPath, "utf8")).toBe(updated);
    expect(after.preferencesMarkdown).toContain("- Keep the layout readable.");
  });

  it("offers saved consolidation without a model call and flags changed inputs", async () => {
    const file = prompt("source-task", "Prompt.", {
      preferences: [{ text: "Keep answers short.", evidence: "Be concise." }],
    });
    const source = aggregatePreferences(readLibrary(home));
    const markdown = "## Working preferences\n\n- Keep answers concise.";
    const savedPath = saveConsolidatedPreferences(home, {
      source,
      consolidated: {
        preferences: [{ text: "Keep answers concise.", source_ids: source.map(preferenceId) }],
      },
      markdown,
      taskCount: 1,
      target: "agents",
      now: new Date("2026-11-01T12:00:00Z"),
      includeUnreviewed: true,
    });
    const saved = fs.readFileSync(savedPath, "utf8");
    const server = start();
    const before = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    expect(before.consolidation).toEqual({
      markdown,
      texts: ["Keep answers concise."],
      generatedAt: "2026-11-01T12:00:00.000Z",
      sourcePreferenceIds: before.preferences.map((preference) => preference.id),
      items: [{ text: "Keep answers concise.", sourceIds: source.map(preferenceId) }],
      stale: false,
      reviewed: false,
    });
    const metadataPath = path.join(path.dirname(file), "sources.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    metadata.preferences.push({ text: "Use focused tests.", evidence: "Check edge cases." });
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    const after = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    expect(after.consolidation?.stale).toBe(true);
    expect(after.consolidation?.markdown).toBe(markdown);
    expect(fs.readFileSync(savedPath, "utf8")).toBe(saved);
    fs.writeFileSync(savedPath, "invalid JSON");
    const invalid = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    expect(invalid.consolidation).toBeNull();
    expect(invalid.consolidationInvalid).toBe(true);
    expect(invalid.preferences).toHaveLength(2);
  });

  it("does not stale a saved result for title or evidence edits, but detects frequency changes", async () => {
    const file = prompt("source-task", "Original prompt.", {
      preferences: [{ text: "Keep answers short.", evidence: "Original evidence." }],
    });
    const source = aggregatePreferences(readLibrary(home));
    const savedPath = saveConsolidatedPreferences(home, {
      source,
      consolidated: {
        preferences: [{ text: "Keep answers concise.", source_ids: source.map(preferenceId) }],
      },
      markdown: "## Working preferences\n\n- Keep answers concise.",
      taskCount: 1,
      target: "agents",
      now: new Date("2026-11-01T12:00:00Z"),
      includeUnreviewed: true,
    });
    const saved = fs.readFileSync(savedPath, "utf8");
    const metadataPath = path.join(path.dirname(file), "sources.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    metadata.preferences[0].evidence = "Edited **evidence**.";
    metadata.authored_at = "2026-11-02T12:00:00Z";
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    fs.writeFileSync(file, "# Edited prompt title\n\nEdited prompt body.");
    const server = start();
    const edited = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    expect(edited.consolidation?.stale).toBe(false);
    expect(edited.preferences[0]?.occurrences[0]).toMatchObject({
      title: "Edited prompt title",
      evidence: "Edited **evidence**.",
    });
    prompt("another-source", "Another prompt.", {
      preferences: [{ text: "Keep answers short.", evidence: "Again, be concise." }],
    });
    const repeated = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    expect(repeated.preferences[0]?.count).toBe(2);
    expect(repeated.consolidation?.stale).toBe(true);
    expect(fs.readFileSync(savedPath, "utf8")).toBe(saved);
  });

  it("keeps a saved result readable after all original prompt entries are removed", async () => {
    prompt("source-task", "Original prompt.", {
      preferences: [{ text: "Keep answers short.", evidence: "Be concise." }],
    });
    const source = aggregatePreferences(readLibrary(home));
    const savedPath = saveConsolidatedPreferences(home, {
      source,
      consolidated: {
        preferences: [{ text: "Keep answers concise.", source_ids: source.map(preferenceId) }],
      },
      markdown: "Saved Markdown is still available.",
      taskCount: 1,
      target: "agents",
      now: new Date("2026-11-01T12:00:00Z"),
      includeUnreviewed: true,
    });
    fs.rmSync(path.join(home, "library", "source-task"), { recursive: true });
    const server = start();
    const snapshot = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.preferences).toEqual([]);
    expect(snapshot.consolidation).toMatchObject({
      markdown: "Saved Markdown is still available.",
      stale: true,
    });
    expect(snapshot.consolidationInvalid).toBe(false);
    expect(fs.existsSync(savedPath)).toBe(true);
    const head = await request(server, "/api/library", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.text).toBe("");
    expect(Number(head.headers["content-length"])).toBeGreaterThan(0);
  });

  it("provides npx command hints for the selected home with safe shell quoting", async () => {
    const customHome = path.join(home, "a library's $(literal) path");
    const server = guiHarness(customHome);
    const snapshot = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    expect(snapshot.consolidation).toBeNull();
    expect(snapshot.consolidationInvalid).toBe(false);
    for (const command of Object.values(snapshot.commands)) {
      expect(command).toMatch(/^npx human-hindsight@latest /);
      expect(command).toContain("--home '");
      expect(command).toContain("a library'\\''s $(literal) path'");
      expect(command).not.toContain("--yes");
    }
    expect(snapshot.commands.consolidate).toContain("preferences --consolidate");
    expect(fs.existsSync(path.join(customHome, "library", CONSOLIDATED_PREFERENCES_FILE))).toBe(
      false,
    );
  });

  it("saves no review while another command holds the writer lock, and names that command", async () => {
    prompt("locked-task", "Prompt.", {
      preferences: [{ text: "Use focused tests.", evidence: "Test just the changed behavior." }],
    });
    const server = start();
    const before = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    const candidate = before.preferences[0];
    const lock = acquireWriterLock(home, "distill");
    try {
      const response = await request(server, "/api/preferences/review", {
        method: "POST",
        headers: {
          Origin: server.url,
          "Content-Type": "application/json",
          "X-Hindsight-Token": before.reviewToken,
        },
        body: { id: candidate?.id, revision: candidate?.review.revision, status: "accepted" },
      });
      expect(response.status).toBe(423);
      expect(response.text).toContain("human-hindsight reflect is changing this library");
    } finally {
      lock.release();
    }
    const after = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    expect(after.preferences[0]?.review.status).toBe("pending");
    expect(readWriterLock(home).status).toBe("absent");
  });

  it("keeps candidates pending until an explicit browser review and persists scope edits", async () => {
    const file = prompt("review-task", "Prompt.", {
      preferences: [{ text: "Use focused tests.", evidence: "Test just the changed behavior." }],
    });
    const original = fs.readFileSync(file, "utf8");
    const server = start();
    const before = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    const candidate = before.preferences[0];
    expect(candidate?.review.status).toBe("pending");
    expect(before.acceptedMarkdown).toBe("");
    const response = await request(server, "/api/preferences/review", {
      method: "POST",
      headers: {
        Origin: server.url,
        "Content-Type": "application/json",
        "X-Hindsight-Token": before.reviewToken,
      },
      body: {
        id: candidate?.id,
        revision: candidate?.review.revision,
        status: "accepted",
        text: "Use focused tests for changed behavior.",
        scope: "project",
        project: "sample-app",
      },
    });
    expect(response.status).toBe(200);
    const after = JSON.parse(response.text) as GuiSnapshot;
    expect(after.acceptedMarkdown).toBe("");
    expect(after.projectInstructions).toEqual([
      expect.objectContaining({
        project: "sample-app",
        markdown: expect.stringContaining("- Use focused tests for changed behavior."),
      }),
    ]);
    expect(after.preferences[0]?.review).toMatchObject({
      status: "accepted",
      scope: "project",
      project: "sample-app",
    });
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    const restarted = guiHarness(home, "f".repeat(64));
    const persisted = JSON.parse((await request(restarted, "/api/library")).text) as GuiSnapshot;
    expect(persisted.preferences[0]?.review.status).toBe("accepted");
    expect(persisted.reviewToken).toBe(restarted.token);
  });

  it("requires same-origin JSON and the server token for preference mutations", async () => {
    prompt("review-task", "Prompt.", {
      preferences: [{ text: "Be concise.", evidence: "Keep answers short." }],
    });
    const server = start();
    const snapshot = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    const preference = snapshot.preferences[0];
    const body = {
      id: preference?.id,
      revision: preference?.review.revision,
      status: "accepted",
    };
    const json = "application/json";
    const forbidden: { headers: Record<string, string>; token?: string | false }[] = [
      { headers: {}, token: false },
      { headers: { Origin: server.url, "Content-Type": json }, token: false },
      { headers: { Origin: server.url, "Content-Type": json }, token: "f".repeat(64) },
      { headers: { Origin: "https://unrelated.example", "Content-Type": json } },
      { headers: { "Content-Type": json } },
      { headers: { Origin: server.url } },
    ];
    for (const { headers, token } of forbidden) {
      expect(
        (
          await request(server, "/api/preferences/review", {
            method: "POST",
            headers,
            body,
            ...(token === undefined ? {} : { token }),
          })
        ).status,
      ).toBe(403);
    }
    const unchanged = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    expect(unchanged.acceptedMarkdown).toBe("");
    expect(unchanged.preferences[0]?.review.status).toBe("pending");
  });

  it("rejects stale reviews, unknown candidates, and oversized payloads without changing rules", async () => {
    const file = prompt("review-task", "Prompt.", {
      preferences: [{ text: "Be concise.", evidence: "Keep answers short." }],
    });
    const server = start();
    const snapshot = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    const candidate = snapshot.preferences[0];
    const headers = {
      Origin: server.url,
      "Content-Type": "application/json",
      "X-Hindsight-Token": snapshot.reviewToken,
    };
    const body = {
      id: candidate?.id,
      revision: candidate?.review.revision,
      status: "accepted",
    };
    const metadataFile = path.join(path.dirname(file), "sources.json");
    const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
    metadata.preferences[0].evidence = "A different observation.";
    fs.writeFileSync(metadataFile, JSON.stringify(metadata));
    expect(
      (await request(server, "/api/preferences/review", { method: "POST", headers, body })).status,
    ).toBe(409);
    expect(
      (
        await request(server, "/api/preferences/review", {
          method: "POST",
          headers,
          body: { ...body, id: "0".repeat(64) },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(server, "/api/preferences/review", {
          method: "POST",
          headers,
          body: "x".repeat(20_000),
        })
      ).status,
    ).toBe(413);
    expect(
      readObservedPreferences(home).map((pref) => preferenceReview(home, pref).status),
    ).toEqual(["pending"]);
  });

  it("shows an accepted consolidation as stale when its supporting review is withdrawn", async () => {
    prompt("review-task", "Prompt.", {
      preferences: [{ text: "Be concise.", evidence: "Keep answers short." }],
    });
    const source = readObservedPreferences(home);
    const pref = source[0];
    if (!pref) throw new Error("Expected the fixture preference.");
    savePreferenceReview(home, pref, { status: "accepted" });
    saveConsolidatedPreferences(home, {
      source,
      consolidated: {
        preferences: [{ text: "Be concise.", source_ids: source.map(preferenceId) }],
      },
      markdown: "## Working preferences\n\n- Be concise.",
      taskCount: 1,
      target: "agents",
      now: new Date("2026-11-03T00:00:00Z"),
    });
    const server = start();
    const before = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    expect(before.consolidation).toMatchObject({ reviewed: true, stale: false });
    savePreferenceReview(home, pref, { status: "dismissed" });
    const after = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    expect(after.consolidation?.stale).toBe(true);
    expect(after.acceptedMarkdown).toBe("");
  });

  it.each([
    undefined,
    "Atlas",
  ])("checks unreviewed consolidation freshness against only its requested scope (%s)", async (project) => {
    const file = prompt("scoped-source", "A synthetic prompt.", {
      preferences: [
        { text: "Use focused tests.", evidence: "Test changed behavior.", scope: "global" },
        {
          text: "Use pnpm in Atlas.",
          evidence: "This repository uses pnpm.",
          scope: "project",
          project: "Atlas",
        },
        {
          text: "Skip screenshots for this task.",
          evidence: "Only this task needs text output.",
          scope: "task",
          project: "Atlas",
        },
        {
          text: "Use npm in Borealis.",
          evidence: "This other repository uses npm.",
          scope: "project",
          project: "Borealis",
        },
      ],
    });
    const observed = readObservedPreferences(home);
    const source = observed.filter(
      (preference) =>
        preference.scope === "global" ||
        (project && preference.scope === "project" && preference.project === project),
    );
    expect(source).toHaveLength(project ? 2 : 1);
    saveConsolidatedPreferences(home, {
      source,
      consolidated: {
        preferences: source.map((preference) => ({
          text: preference.text,
          source_ids: [preferenceId(preference)],
        })),
      },
      markdown: "## Working preferences\n\n- Selected rules only.",
      taskCount: 1,
      target: "agents",
      now: new Date("2026-11-03T00:00:00Z"),
      includeUnreviewed: true,
      project,
    });
    const server = start();
    const initial = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    expect(initial.preferences).toHaveLength(4);
    expect(initial.consolidation).toMatchObject({ stale: false, reviewed: false });

    const metadataPath = path.join(path.dirname(file), "sources.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    metadata.preferences[2].text = "Include one screenshot for this task.";
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    const taskChanged = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    expect(taskChanged.consolidation?.stale).toBe(false);

    metadata.preferences[0].text = "Use focused tests and check boundary cases.";
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    const globalChanged = JSON.parse((await request(server, "/api/library")).text) as GuiSnapshot;
    expect(globalChanged.consolidation?.stale).toBe(true);
  });

  it("has no mutation or arbitrary file routes", async () => {
    fs.writeFileSync(path.join(home, "private.txt"), "not part of the library");
    const server = start();
    for (const route of [
      "/private.txt",
      "/../private.txt",
      "/%2e%2e/private.txt",
      "/api/library/private.txt",
    ]) {
      expect((await request(server, route)).status).toBe(404);
    }
    const response = await request(server, "/api/library", { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe("GET, HEAD");
  });
});
