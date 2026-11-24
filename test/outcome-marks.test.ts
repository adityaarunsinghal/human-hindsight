import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ManifestEntry } from "../src/commands/distill.js";
import { renderStatus } from "../src/commands/status.js";
import { setFileWriter, unflushedWriter } from "../src/core/fsutil.js";
import { isEdited, PUBLISH_INTENT_FILE, readLibrary } from "../src/core/library.js";
import { type RunnerFn, runAuthorStage, saveDigests, saveTasks } from "../src/distill/pipeline.js";
import type { Author, ClusterTask, Digest } from "../src/distill/schemas.js";
import { renderLibraryTable } from "../src/ui/library-table.js";

/**
 * `status` and `list` say what the prompt file says: a prompt kept from an
 * earlier run for a group whose sessions are now all abandoned, and the mark
 * of a prompt whose publication was interrupted. Synthetic homes only; the
 * runner is a function, so no CLI or model is ever called.
 */

setFileWriter(unflushedWriter);

const temps: string[] = [];
function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-outcome-marks-"));
  temps.push(dir);
  fs.mkdirSync(path.join(dir, "exports"), { recursive: true });
  fs.writeFileSync(path.join(dir, "exports", "a.md"), "### t\n\ncontent of a.md\n");
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const SLUG = "auth-feature-work";
const digest = (outcome: Digest["outcome"]): Digest => ({
  goal: "ship it",
  deliverable: "d",
  domain: "dom",
  keywords: ["k"],
  outcome,
});
const task: ClusterTask = { slug: SLUG, title: "Auth", rationale: "same goal", members: ["a.md"] };
const entry: ManifestEntry = {
  export: "a.md",
  source: "/x/a.md.jsonl",
  project: "x",
  sessionId: "sid-a",
  messages: 3,
  first_ts: "2026-01-01T00:00:00Z",
  last_ts: "2026-01-01T01:00:00Z",
};
const AUTHORED: Author = {
  slug: SLUG,
  title: "Auth feature",
  oneshot_markdown: "Build the auth flow. Keep it simple, test it properly.",
  confidence: "high",
  preferences: [],
};
const runner = (async () => AUTHORED) as RunnerFn;
const quiet = () =>
  new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
const author = (home: string, outcome: Digest["outcome"]) =>
  runAuthorStage({
    home,
    entries: [entry],
    generation: "g1",
    toolVersion: "0.1.0",
    output: quiet(),
    tasks: [task],
    digests: { "a.md": digest(outcome) },
    runner,
  });
const entryDir = (home: string) => path.join(home, "library", SLUG);

describe("status and list agree with the prompt file", () => {
  it("status says a prompt is kept from an earlier run when every session in its group is now abandoned", async () => {
    const home = tmpHome();
    // The session reached a result: its prompt is written.
    expect((await author(home, "completed")).authored).toEqual([SLUG]);
    // The same session, continued and then given up, is read again in the same generation.
    const skipped = await author(home, "abandoned");
    expect(skipped.skipped.map((s) => s.slug)).toEqual([SLUG]);
    saveDigests(home, {
      generation: "g1",
      prompt_version: 1,
      digests: { "a.md": digest("abandoned") },
    });
    saveTasks(home, { generation: "g1", prompt_version: 1, tasks: [task], misc: [] });
    fs.writeFileSync(path.join(home, "exports", "manifest.json"), JSON.stringify([entry]));
    const status = stripVTControlCharacters(
      renderStatus({ home, claudeDir: path.join(home, "no-claude"), source: "claude" }),
    );
    const line = status.split("\n").find((l) => l.includes(SLUG)) ?? "";
    expect(line).toContain(
      "kept from an earlier run; no longer rewritten because every session in its group was abandoned",
    );
    expect(line).not.toMatch(/✓|OK/);
    // Not counted as written by this grouping, and nothing is pending.
    expect(status).toMatch(/written\s+0 of 1 prompt, 1 kept from an earlier run/);
    expect(status).not.toContain("pending");
  });

  it("list shows the mark of a prompt whose publication was interrupted before sources.json", async () => {
    const home = tmpHome();
    await author(home, "completed");
    // The unverified rewrite of the same group, as the author stage would publish it.
    const other = tmpHome();
    await author(other, "unclear");
    const intentLike = JSON.parse(
      fs.readFileSync(path.join(entryDir(other), "sources.json"), "utf8"),
    );
    const prompt = fs.readFileSync(path.join(entryDir(other), `${SLUG}.oneshot.md`), "utf8");
    // Publication order: intent, prompt, then sources.json. It stopped before the last write.
    fs.writeFileSync(
      path.join(entryDir(home), PUBLISH_INTENT_FILE),
      JSON.stringify({
        version: 1,
        slug: SLUG,
        oneshot_hash: intentLike.oneshot_hash,
        sources: intentLike,
      }),
    );
    fs.writeFileSync(path.join(entryDir(home), `${SLUG}.oneshot.md`), prompt);
    expect(prompt).toContain("outcome: not verified");
    const table = stripVTControlCharacters(renderLibraryTable(readLibrary(home)));
    expect(table).toContain("outcome not verified");
    // The same publication record the edit check reads: not an edit.
    const [published] = readLibrary(home);
    expect(published?.sources.outcome_verified).toBe(false);
    expect(published && isEdited(published)).toBe(false);
  });
});
