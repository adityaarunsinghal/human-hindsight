import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { ManifestEntry } from "../src/commands/distill.js";
import { type FileWriter, setFileWriter, unflushedWriter } from "../src/core/fsutil.js";
import { findEntry, isEdited, PUBLISH_INTENT_FILE } from "../src/core/library.js";
import { type RunnerFn, runAuthorStage } from "../src/distill/pipeline.js";
import type { Author, ClusterTask, Digest } from "../src/distill/schemas.js";

/**
 * Publication of an authored prompt: the person's edits are kept, `--force`
 * is a way out of every refusal, and a crash between the prompt and its
 * provenance never turns our own output into a "hand edit", or the reverse.
 */

setFileWriter(unflushedWriter);

const dirs: string[] = [];
function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-author-publish-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "exports"), { recursive: true });
  for (const name of ["a.md", "b.md", "c.md"])
    fs.writeFileSync(path.join(dir, "exports", name), `### t\n\ncontent of ${name}\n`);
  return dir;
}
afterEach(() => {
  setFileWriter(unflushedWriter);
  while (dirs.length) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const SLUG = "auth-feature-work";
const digest = (): Digest => ({
  goal: "ship it",
  deliverable: "d",
  domain: "dom",
  keywords: ["k"],
  outcome: "completed",
});
const task = (members: string[]): ClusterTask => ({
  slug: SLUG,
  title: "Task",
  rationale: "same goal",
  members,
});
const entry = (name: string): ManifestEntry => ({
  export: name,
  source: `/x/${name}.jsonl`,
  project: "x",
  sessionId: `sid-${name}`,
  messages: 3,
  first_ts: "2026-01-01T00:00:00Z",
  last_ts: "2026-01-01T01:00:00Z",
});
const sink = () =>
  new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
const authored = (body: string): Author => ({
  slug: SLUG,
  title: "Auth feature",
  oneshot_markdown: `${body} ${"Build the flow, keep every change small, explain each decision, and verify it with the tests. ".repeat(2)}`,
  confidence: "high",
  preferences: [],
});

/** A runner that answers "Generated body N." for its Nth call, after an optional hook. */
function counting(dir: string, during?: (call: number, dir: string) => void) {
  let calls = 0;
  const runner = (async () => {
    calls++;
    during?.(calls, dir);
    return authored(`Generated body ${calls}.`);
  }) as RunnerFn;
  return { runner, calls: () => calls };
}

function stage(dir: string, members: string[], runner: RunnerFn, extra: { force?: boolean } = {}) {
  return runAuthorStage({
    home: dir,
    entries: members.map(entry),
    generation: "g1",
    toolVersion: "0.1.0",
    output: sink(),
    tasks: [task(members)],
    digests: Object.fromEntries(members.map((m) => [m, digest()])),
    runner,
    ...extra,
  });
}

const entryDir = (dir: string) => path.join(dir, "library", SLUG);
const oneshotFile = (dir: string) => path.join(entryDir(dir), `${SLUG}.oneshot.md`);
const sourcesFile = (dir: string) => path.join(entryDir(dir), "sources.json");
const intentFile = (dir: string) => path.join(entryDir(dir), PUBLISH_INTENT_FILE);
const prompt = (dir: string) => fs.readFileSync(oneshotFile(dir), "utf8");

/** Install a writer that dies once on the named file of a publication. */
function crashOn(name: string) {
  let armed = true;
  const crashing: FileWriter = {
    replace(file, data) {
      if (armed && path.basename(file) === name) {
        armed = false;
        throw new Error(`simulated crash before writing ${name}`);
      }
      unflushedWriter.replace(file, data);
    },
  };
  setFileWriter(crashing);
}

describe("an edit made while the prompt is being authored", () => {
  it("is kept and the result saved; --force then replaces it without a new call", async () => {
    const dir = home();
    const { runner, calls } = counting(dir, (call, at) => {
      // The person edits the prompt while the second call is in flight.
      if (call === 2) fs.appendFileSync(oneshotFile(at), "\nMy own addition.\n");
    });
    await stage(dir, ["a.md"], runner);
    const second = await stage(dir, ["a.md", "b.md"], runner);
    expect(second.failed).toEqual([]);
    expect(second.kept[0]?.reason).toContain("edited by hand while it was being written");
    expect(second.kept[0]?.reason).toContain("--force");
    expect(prompt(dir)).toContain("My own addition.");

    // Without --force the edit stays and is reported under its real reason.
    const kept = await stage(dir, ["a.md", "b.md"], runner);
    expect(kept.kept.map((task) => task.reason)).toEqual([
      "oneshot was edited by hand; re-run with --force to overwrite",
    ]);
    expect(kept.skipped).toEqual([]);
    expect(prompt(dir)).toContain("My own addition.");

    // With --force the paid result replaces the edit, and the record completes.
    const forced = await stage(dir, ["a.md", "b.md"], runner, { force: true });
    expect(forced.failed).toEqual([]);
    expect(forced.authored).toEqual([SLUG]);
    expect(prompt(dir)).toContain("Generated body 2.");
    expect(calls()).toBe(2);
    const again = await stage(dir, ["a.md", "b.md"], runner);
    expect(again.resumed).toEqual([SLUG]);
  });

  it("is still kept when it lands during a --force run", async () => {
    const dir = home();
    const { runner } = counting(dir, (call, at) => {
      if (call === 2) fs.appendFileSync(oneshotFile(at), "\nTyped during the forced run.\n");
    });
    await stage(dir, ["a.md"], runner);
    const forced = await stage(dir, ["a.md", "b.md"], runner, { force: true });
    expect(forced.kept[0]?.reason).toContain("edited by hand while it was being written");
    expect(prompt(dir)).toContain("Typed during the forced run.");
  });
});

describe("a crash between the two publication writes", () => {
  it("after the prompt landed: the prompt is our output, not a hand edit", async () => {
    const dir = home();
    const { runner } = counting(dir);
    await stage(dir, ["a.md"], runner);
    crashOn("sources.json");
    await stage(dir, ["a.md", "b.md"], runner);
    setFileWriter(unflushedWriter);
    expect(prompt(dir)).toContain("Generated body 2.");
    // Between runs, list and prune read it as unedited too.
    const listed = findEntry(dir, SLUG);
    expect(listed && isEdited(listed)).toBe(false);

    // The next run has new inputs, and nobody touched the prompt file.
    const next = await stage(dir, ["a.md", "b.md", "c.md"], runner);
    expect(next.kept).toEqual([]);
    expect(next.authored).toEqual([SLUG]);
    expect(prompt(dir)).toContain("Generated body 3.");
    expect(fs.existsSync(intentFile(dir))).toBe(false);
  });

  it("after the prompt landed and the person then edited it: the edit is protected", async () => {
    const dir = home();
    const { runner, calls } = counting(dir);
    await stage(dir, ["a.md"], runner);
    crashOn("sources.json");
    await stage(dir, ["a.md", "b.md"], runner);
    setFileWriter(unflushedWriter);
    fs.appendFileSync(oneshotFile(dir), "\nEdited after the crash.\n");
    const listed = findEntry(dir, SLUG);
    expect(listed && isEdited(listed)).toBe(true);

    const next = await stage(dir, ["a.md", "b.md", "c.md"], runner);
    expect(next.authored).toEqual([]);
    expect(next.kept.map((task) => task.slug)).toEqual([SLUG]);
    expect(prompt(dir)).toContain("Edited after the crash.");
    expect(calls()).toBe(2);
  });

  it("before the prompt landed: the previous prompt is unedited and is regenerated", async () => {
    const dir = home();
    const { runner } = counting(dir);
    await stage(dir, ["a.md"], runner);
    crashOn(`${SLUG}.oneshot.md`);
    await stage(dir, ["a.md", "b.md"], runner);
    setFileWriter(unflushedWriter);
    expect(prompt(dir)).toContain("Generated body 1.");
    expect(fs.existsSync(intentFile(dir))).toBe(true);

    const next = await stage(dir, ["a.md", "b.md"], runner);
    expect(next.kept).toEqual([]);
    expect(next.failed).toEqual([]);
    // The saved result is published without paying for it again.
    expect(prompt(dir)).toContain("Generated body 2.");
    expect(fs.existsSync(intentFile(dir))).toBe(false);
  });

  it("finishing the provenance keeps what the person added to sources.json since", async () => {
    const dir = home();
    const { runner } = counting(dir);
    await stage(dir, ["a.md"], runner);
    crashOn("sources.json");
    await stage(dir, ["a.md", "b.md"], runner);
    setFileWriter(unflushedWriter);
    const old = JSON.parse(fs.readFileSync(sourcesFile(dir), "utf8"));
    fs.writeFileSync(sourcesFile(dir), JSON.stringify({ ...old, rating: "up" }));

    const next = await stage(dir, ["a.md", "b.md"], runner);
    expect(next.resumed).toEqual([SLUG]);
    const sources = JSON.parse(fs.readFileSync(sourcesFile(dir), "utf8"));
    expect(sources.rating).toBe("up");
    expect(sources.members).toEqual(["a.md", "b.md"]);
  });

  it("a damaged intent proves nothing: the prompt is judged against sources.json", async () => {
    const dir = home();
    const { runner } = counting(dir);
    await stage(dir, ["a.md"], runner);
    crashOn("sources.json");
    await stage(dir, ["a.md", "b.md"], runner);
    setFileWriter(unflushedWriter);
    fs.writeFileSync(intentFile(dir), "{ not json");
    const next = await stage(dir, ["a.md", "b.md", "c.md"], runner);
    expect(next.authored).toEqual([]);
    expect(next.kept.map((task) => task.slug)).toEqual([SLUG]);
  });
});
