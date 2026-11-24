import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { fittedLine, librarySentence, type ManifestEntry } from "../src/commands/distill.js";
import { setFileWriter, unflushedWriter } from "../src/core/fsutil.js";
import { oneshotHash } from "../src/core/library.js";
import { fitWholeMembers } from "../src/distill/author.js";
import {
  createRetryHandlers,
  prepareTaskRecoveryInputs,
  type RunnerFn,
  runAuthorStage,
  type SourcesJson,
  saveDigests,
  saveTasks,
  summarizeOutcomes,
} from "../src/distill/pipeline.js";
import { AUTHOR_PROMPT_VERSION, buildAuthorPrompt } from "../src/distill/prompts/author.js";
import { executeRetry, prepareRetry } from "../src/distill/retry.js";
import type { Author, ClusterTask, Digest } from "../src/distill/schemas.js";
import type { RunClaudeOptions } from "../src/runners/claude.js";

// Unit tests skip disk flushes; test/engine.test.ts proves the durable path.
setFileWriter(unflushedWriter);

// --- helpers ---------------------------------------------------------------

const tmpDirs: string[] = [];
function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cch-author-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "exports"), { recursive: true });
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function digest(outcome: Digest["outcome"], goal = "ship it"): Digest {
  return { goal, deliverable: "d", domain: "dom", keywords: ["k"], outcome };
}

function task(slug: string, members: string[]): ClusterTask {
  return { slug, title: `Task ${slug}`, rationale: "same goal", members };
}

function entry(name: string): ManifestEntry {
  return {
    export: name,
    source: `/x/${name}.jsonl`,
    project: "x",
    sessionId: `sid-${name}`,
    messages: 3,
    first_ts: "2026-01-01T00:00:00Z",
    last_ts: "2026-01-01T01:00:00Z",
  };
}

function sink(): Writable {
  return new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
}

const AUTHORED: Author = {
  slug: "auth-feature-work",
  title: "Auth feature",
  oneshot_markdown: "Build the auth flow. Keep it simple, test it properly.",
  confidence: "high",
  preferences: [{ text: "diagnose before acting", evidence: "said so twice" }],
};

const PROMPT = buildAuthorPrompt({
  task: task("auth-feature-work", ["a.md"]),
  members: [
    {
      exportName: "a.md",
      content: "### t\n\nbuild auth\n",
      digest: digest("completed"),
      anaphora: [
        {
          index: 1,
          timestamp: "t",
          human_text: "yes",
          antecedent: "Shall I use JWT?",
          decision_kind: "plan",
          decision_text: "## Plan\nUse JWT",
        },
      ],
    },
  ],
});

// --- prompt-contract tests: pin the realism instructions -----------

describe("author prompt contract", () => {
  it("pins the knowable-at-t=0 test", () => {
    expect(PROMPT).toContain('THE "KNOWABLE AT t=0" TEST');
    expect(PROMPT).toContain("BEFORE the session started");
  });

  it("pins the front-load list", () => {
    expect(PROMPT).toContain("the goal and the concrete deliverable");
    expect(PROMPT).toContain("output format and the quality bar");
    expect(PROMPT).toContain("standing preferences and working style");
    expect(PROMPT).toContain("constraints and things to avoid");
    expect(PROMPT).toContain("decisions the human resolved mid-session");
  });

  it("pins the never-front-load list", () => {
    expect(PROMPT).toContain("NEVER front-load");
    expect(PROMPT).toContain("file paths first seen mid-session");
    expect(PROMPT).toContain("root causes");
    expect(PROMPT).toContain("specific config values or mechanisms");
    expect(PROMPT).toContain("error messages");
    expect(PROMPT).toContain("visibly learned along the way");
  });

  it("pins transform-don't-leak", () => {
    expect(PROMPT).toContain("Transform, don't leak");
    expect(PROMPT).toContain("never the answer the investigation found");
  });

  it("pins the effort budget and structure cap", () => {
    expect(PROMPT).toContain("THE EFFORT BUDGET");
    expect(PROMPT).toContain("shortest prompt");
    expect(PROMPT).toContain("short task may need only a few sentences");
    expect(PROMPT).toContain("prose-first, minimal structure");
    expect(PROMPT).toContain("not a spec with nested");
  });

  it("pins the never-copy-assistant-prose rule and verbatim decisions", () => {
    expect(PROMPT).toContain("never copy assistant prose");
    expect(PROMPT).toContain("[decision] lines are the human's verbatim choices — honor them");
  });

  it("pins inferred voice (never an asserted persona)", () => {
    expect(PROMPT).toContain("first person");
    expect(PROMPT).toContain("terse if they're terse");
    expect(PROMPT).toContain("never an asserted persona");
  });

  it("pins outcome-aware confidence and preference evidence", () => {
    expect(PROMPT).toContain("CONFIDENCE");
    expect(PROMPT).toContain("rather than overclaim");
    expect(PROMPT).toContain("PREFERENCES");
    expect(PROMPT).toContain("independently of task success");
    expect(PROMPT).toContain("evidence");
  });

  it("includes task context, member content, outcomes, and anaphora", () => {
    expect(PROMPT).toContain("slug: auth-feature-work");
    expect(PROMPT).toContain("a.md: completed");
    expect(PROMPT).toContain("build auth");
    expect(PROMPT).toContain("the plan pending when the human replied was");
    expect(PROMPT).toContain("Use JWT");
    expect(PROMPT).toContain("MACHINE-AUTHORED");
  });

  it("preserves an explicit rejection without asserting approval", () => {
    const prompt = buildAuthorPrompt({
      task: task("release-work", ["a.md"]),
      members: [
        {
          exportName: "a.md",
          content: "No. Do not deploy this.",
          anaphora: [
            {
              index: 1,
              timestamp: "2026-11-01",
              human_text: "No. Do not deploy this.",
              antecedent: "Can I deploy now?",
              decision_kind: "plan",
              decision_text: "Deploy to production.",
            },
          ],
        },
      ],
    });
    expect(prompt).toContain('the human said: "No. Do not deploy this."');
    expect(prompt).toContain("the plan pending when the human replied was");
    expect(prompt).not.toContain("this approved");
    expect(prompt).toContain("accepts, rejects, changes, or defers");
  });

  it("does not turn discoveries into pre-existing standing rules", () => {
    expect(PROMPT).not.toContain("preferences all along");
    expect(PROMPT).toContain("pre-existing preference");
    expect(PROMPT).toContain("If a decision depended on a discovery");
    expect(PROMPT).toContain("task-specific conditions and exceptions");
    expect(PROMPT).not.toContain("human already\ncompleted");
  });

  it("tells the writer not to present an approach as proven when no member reached a result", () => {
    // One instruction, beside the outcomes it depends on; the rest of the prompt is unchanged.
    const lines = PROMPT.split("\n");
    const at = lines.findIndex((line) => line.startsWith("Member session outcomes:"));
    expect(lines.slice(at + 1, at + 3).join(" ")).toBe(
      "If no member is completed or partial, write the prompt from what the human asked for and decided, and do not present any approach from those sessions as proven.",
    );
  });

  it("has a version constant and inlines member content verbatim (budget is the pipeline's job)", () => {
    expect(AUTHOR_PROMPT_VERSION).toBeGreaterThanOrEqual(1);
    // The pipeline's budget system blocks or cuts oversized tasks BEFORE they
    // reach the builder, so the builder itself must inline content whole:
    // nothing is ever lost here without disclosure upstream.
    const content = "z".repeat(40_000);
    const big = buildAuthorPrompt({
      task: task("big-task-here", ["m.md"]),
      members: [{ exportName: "m.md", content }],
    });
    expect(big).toContain(content);
    expect(big).not.toContain("truncated");
  });
});

// --- outcome summary ----------------------------------------------------------

describe("summarizeOutcomes", () => {
  it("counts outcomes in a stable order", () => {
    const digests = {
      "a.md": digest("completed"),
      "b.md": digest("partial"),
      "c.md": digest("completed"),
      "d.md": digest("unclear"),
    };
    expect(summarizeOutcomes(["a.md", "b.md", "c.md", "d.md"], digests)).toBe(
      "2 completed, 1 partial, 1 unclear",
    );
    expect(summarizeOutcomes(["missing.md"], {})).toBe("1 unclear");
  });
});

// --- author stage ---------------------------------------------------------------

describe("runAuthorStage", () => {
  function writeExport(home: string, name: string): void {
    fs.writeFileSync(path.join(home, "exports", name), `### t\n\ncontent of ${name}\n`);
  }

  const baseOpts = (home: string) => ({
    home,
    entries: [entry("a.md"), entry("b.md")],
    generation: "g1",
    toolVersion: "0.1.0",
    output: sink(),
  });

  it("writes the oneshot file and sources.json with full provenance", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    const runner: RunnerFn = (async () => AUTHORED) as RunnerFn;

    const result = await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner,
    });

    expect(result.authored).toEqual(["auth-feature-work"]);
    const dir = path.join(home, "library", "auth-feature-work");
    const oneshot = fs.readFileSync(path.join(dir, "auth-feature-work.oneshot.md"), "utf8");
    expect(oneshot).toContain("generated by human-hindsight v0.1.0");
    expect(oneshot).toContain("generation g1");
    expect(oneshot).toContain("sources: a.md");
    expect(oneshot).toContain("# Auth feature");
    expect(oneshot).toContain("Build the auth flow.");

    const sources = JSON.parse(
      fs.readFileSync(path.join(dir, "sources.json"), "utf8"),
    ) as SourcesJson;
    expect(sources).toMatchObject({
      slug: "auth-feature-work",
      title: "Auth feature",
      members: ["a.md"],
      sessionIds: ["sid-a.md"],
      outcome_summary: "1 completed",
      domains: ["dom"],
      confidence: "high",
      model: null,
      prompt_version: AUTHOR_PROMPT_VERSION,
      tool_version: "0.1.0",
      generation: "g1",
    });
    // Author text is not a new source of standing rules; candidates come from
    // the digest's verified human-message citations.
    expect(sources.preferences).toEqual([]);
    expect(Date.parse(sources.authored_at)).not.toBeNaN();
  });

  it("records oneshot_hash of the exact written bytes", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    const runner: RunnerFn = (async () => AUTHORED) as RunnerFn;

    await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner,
    });

    const dir = path.join(home, "library", "auth-feature-work");
    const oneshot = fs.readFileSync(path.join(dir, "auth-feature-work.oneshot.md"), "utf8");
    const sources = JSON.parse(
      fs.readFileSync(path.join(dir, "sources.json"), "utf8"),
    ) as SourcesJson;
    expect(sources.oneshot_hash).toBe(oneshotHash(oneshot));
  });

  it("keeps a hand-edited oneshot on re-author (no claude call) unless --force", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    writeExport(home, "b.md");
    let calls = 0;
    const runner: RunnerFn = (async () => {
      calls++;
      return AUTHORED;
    }) as RunnerFn;

    // Author once with member a.md only.
    await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner,
    });
    expect(calls).toBe(1);

    // User hand-tunes the oneshot.
    const oneshotPath = path.join(
      home,
      "library",
      "auth-feature-work",
      "auth-feature-work.oneshot.md",
    );
    fs.appendFileSync(oneshotPath, "\nMy own hard-won addition.\n");
    const editedContent = fs.readFileSync(oneshotPath, "utf8");

    // Membership changed → would normally re-author. Edit protection wins.
    const r2 = await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md", "b.md"])],
      digests: { "a.md": digest("completed"), "b.md": digest("completed") },
      runner,
    });
    expect(calls).toBe(1); // no new claude call: protected pre-spend
    expect(r2.kept).toHaveLength(1);
    expect(r2.kept[0]?.reason).toContain("--force");
    expect(fs.readFileSync(oneshotPath, "utf8")).toBe(editedContent); // untouched

    // --force re-authors and overwrites.
    const r3 = await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md", "b.md"])],
      digests: { "a.md": digest("completed"), "b.md": digest("completed") },
      runner,
      force: true,
    });
    expect(calls).toBe(2);
    expect(r3.authored).toEqual(["auth-feature-work"]);
    expect(fs.readFileSync(oneshotPath, "utf8")).not.toBe(editedContent);
  });

  it("says once, in plain words, why prompts are written again", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    writeExport(home, "b.md");
    const runner: RunnerFn = (async () => AUTHORED) as RunnerFn;
    const tasks = [task("auth-feature-work", ["a.md"]), task("billing-fix-work", ["b.md"])];
    const digests = { "a.md": digest("completed"), "b.md": digest("completed") };
    await runAuthorStage({ ...baseOpts(home), tasks, digests, runner });
    const chunks: string[] = [];
    const output = new Writable({
      write(c, _e, cb) {
        chunks.push(c.toString());
        cb();
      },
    });
    // A different model makes both prompts out of date.
    await runAuthorStage({
      ...baseOpts(home),
      tasks,
      digests,
      runner,
      model: "another-model",
      output,
    });
    const lines = chunks.join("").split("\n");
    expect(lines.filter((line) => line.includes("again"))).toEqual([
      "  Writing prompts again for groups whose sessions or settings changed since they were written.",
    ]);
    expect(lines.join("\n")).not.toMatch(/regenerating/);
  });

  type Label = Digest["outcome"] | "no digest";
  it.each<[string, Label[], "verified" | "unverified" | "none"]>([
    ["one completed session: a prompt", ["completed"], "verified"],
    ["one partial session: a prompt", ["partial"], "verified"],
    ["one unclear session: a prompt marked not verified", ["unclear"], "unverified"],
    ["one abandoned session: no prompt", ["abandoned"], "none"],
    ["one session with no digest: a prompt marked not verified", ["no digest"], "unverified"],
    [
      "completed beside abandoned and unclear: a prompt",
      ["abandoned", "unclear", "completed"],
      "verified",
    ],
    ["partial beside abandoned: a prompt", ["abandoned", "partial"], "verified"],
    ["all unclear: a prompt marked not verified", ["unclear", "unclear"], "unverified"],
    [
      "unclear beside abandoned: a prompt marked not verified",
      ["abandoned", "unclear"],
      "unverified",
    ],
    [
      "no digest beside abandoned: a prompt marked not verified",
      ["abandoned", "no digest"],
      "unverified",
    ],
    ["all abandoned: no prompt", ["abandoned", "abandoned", "abandoned"], "none"],
  ])("a group with %s", async (_name, labels, expected) => {
    const home = tmpHome();
    const members = labels.map((_, index) => `m${index}.md`);
    for (const member of members) writeExport(home, member);
    let calls = 0;
    const output: string[] = [];
    const result = await runAuthorStage({
      ...baseOpts(home),
      entries: members.map(entry),
      tasks: [task("auth-feature-work", members)],
      digests: Object.fromEntries(
        labels.flatMap((label, index) =>
          label === "no digest" ? [] : [[`m${index}.md`, digest(label)]],
        ),
      ),
      runner: (async () => {
        calls++;
        return AUTHORED;
      }) as RunnerFn,
      output: new Writable({
        write(c, _e, cb) {
          output.push(c.toString());
          cb();
        },
      }),
    });
    const dir = path.join(home, "library", "auth-feature-work");
    if (expected === "none") {
      expect(calls).toBe(0);
      expect(result.authored).toEqual([]);
      expect(result.unverified).toEqual([]);
      // The plain reason says why: every session was abandoned.
      expect(result.skipped).toEqual([
        {
          slug: "auth-feature-work",
          reason:
            labels.length === 1
              ? "its 1 session was abandoned"
              : `all ${labels.length} sessions were abandoned`,
        },
      ]);
      expect(fs.existsSync(dir)).toBe(false);
      return;
    }
    expect(calls).toBe(1);
    expect(result.authored).toEqual(["auth-feature-work"]);
    expect(result.skipped).toEqual([]);
    const sources = JSON.parse(fs.readFileSync(path.join(dir, "sources.json"), "utf8"));
    const oneshot = fs.readFileSync(path.join(dir, "auth-feature-work.oneshot.md"), "utf8");
    if (expected === "verified") {
      expect("outcome_verified" in sources).toBe(false);
      expect(sources.confidence).toBe("high");
      expect(oneshot).not.toContain("outcome: not verified");
      expect(result.unverified).toEqual([]);
      expect(output.join("")).not.toContain("outcome not verified");
    } else {
      // Written only as false, at the lowest confidence, and said in the header.
      expect(sources.outcome_verified).toBe(false);
      expect(sources.confidence).toBe("low");
      expect(oneshot.split("-->")[0]).toContain("\n  outcome: not verified\n");
      expect(result.unverified).toEqual(["auth-feature-work"]);
      expect(output.join("")).toContain("low confidence, outcome not verified, 0 preferences");
    }
  });

  describe("the outcome-not-verified mark", () => {
    const opts = (home: string, outcome: Digest["outcome"], runner: RunnerFn) => ({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest(outcome) },
      runner,
    });
    const sourcesOf = (home: string) =>
      JSON.parse(
        fs.readFileSync(path.join(home, "library", "auth-feature-work", "sources.json"), "utf8"),
      );
    const promptFile = (home: string) =>
      path.join(home, "library", "auth-feature-work", "auth-feature-work.oneshot.md");

    it("is kept while nothing changes and cleared once a session reaches a result", async () => {
      const home = tmpHome();
      writeExport(home, "a.md");
      let calls = 0;
      const runner = (async () => {
        calls++;
        return AUTHORED;
      }) as RunnerFn;
      await runAuthorStage(opts(home, "unclear", runner));
      // The person rates it; a later rewrite keeps the rating.
      fs.writeFileSync(
        path.join(home, "library", "auth-feature-work", "sources.json"),
        JSON.stringify({ ...sourcesOf(home), rating: "up" }),
      );
      const again = await runAuthorStage(opts(home, "unclear", runner));
      expect(calls).toBe(1);
      expect(again.resumed).toEqual(["auth-feature-work"]);
      expect(again.unverified).toEqual(["auth-feature-work"]);
      expect(sourcesOf(home).outcome_verified).toBe(false);

      const reached = await runAuthorStage(opts(home, "completed", runner));
      expect(calls).toBe(2);
      expect(reached.authored).toEqual(["auth-feature-work"]);
      expect(reached.unverified).toEqual([]);
      const sources = sourcesOf(home);
      expect("outcome_verified" in sources).toBe(false);
      expect(sources.confidence).toBe("high");
      expect(sources.rating).toBe("up");
      expect(fs.readFileSync(promptFile(home), "utf8")).not.toContain("outcome: not verified");
    });

    it("on a prompt edited by hand, stays with the edit when a session later reaches a result", async () => {
      const home = tmpHome();
      writeExport(home, "a.md");
      let calls = 0;
      const runner = (async () => {
        calls++;
        return AUTHORED;
      }) as RunnerFn;
      await runAuthorStage(opts(home, "unclear", runner));
      fs.appendFileSync(promptFile(home), "\nMy own addition.\n");
      const edited = fs.readFileSync(promptFile(home), "utf8");
      const before = sourcesOf(home);
      const result = await runAuthorStage(opts(home, "completed", runner));
      expect(calls).toBe(1);
      expect(result.kept.map((kept) => kept.slug)).toEqual(["auth-feature-work"]);
      expect(fs.readFileSync(promptFile(home), "utf8")).toBe(edited);
      // A kept edit gets no provenance update, so the mark still describes what was written.
      expect(sourcesOf(home)).toEqual(before);
    });
  });

  describe("--force after a hand edit", () => {
    const opts = (home: string, runner: RunnerFn, force?: boolean) => ({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner,
      force,
    });
    const promptFile = (home: string) =>
      path.join(home, "library", "auth-feature-work", "auth-feature-work.oneshot.md");
    const sourcesFile = (home: string) =>
      path.join(home, "library", "auth-feature-work", "sources.json");

    it("with unchanged inputs puts back the saved prompt without a new call", async () => {
      const home = tmpHome();
      writeExport(home, "a.md");
      let calls = 0;
      const runner = (async () => {
        calls++;
        return AUTHORED;
      }) as RunnerFn;
      await runAuthorStage(opts(home, runner));
      const original = fs.readFileSync(promptFile(home), "utf8");
      const sources = JSON.parse(fs.readFileSync(sourcesFile(home), "utf8"));
      fs.writeFileSync(sourcesFile(home), JSON.stringify({ ...sources, rating: "down" }));
      fs.appendFileSync(promptFile(home), "\nMy own addition.\n");

      // Without --force nothing changes, and the prompt is counted once, as kept.
      const kept = await runAuthorStage(opts(home, runner));
      expect(kept.resumed).toEqual([]);
      expect(kept.kept.map((task) => task.slug)).toEqual(["auth-feature-work"]);
      expect(librarySentence(kept)).toBe("Library: 1 prompt kept (edited by you).");
      expect(fs.readFileSync(promptFile(home), "utf8")).toContain("My own addition.");

      const forced = await runAuthorStage(opts(home, runner, true));
      expect(calls).toBe(1);
      expect(forced.resumed).toEqual([]);
      expect(forced.authored).toEqual(["auth-feature-work"]);
      expect(fs.readFileSync(promptFile(home), "utf8")).toBe(original);
      const after = JSON.parse(fs.readFileSync(sourcesFile(home), "utf8"));
      expect(after.oneshot_hash).toBe(oneshotHash(original));
      expect(after.rating).toBe("down");
      // Now unedited: the next run resumes it.
      expect((await runAuthorStage(opts(home, runner, true))).resumed).toEqual([
        "auth-feature-work",
      ]);
      expect(calls).toBe(1);
    });

    it("with unchanged inputs but no saved result writes it again", async () => {
      const home = tmpHome();
      writeExport(home, "a.md");
      let calls = 0;
      const runner = (async () => {
        calls++;
        return { ...AUTHORED, oneshot_markdown: `Generated body ${calls}.` };
      }) as RunnerFn;
      await runAuthorStage(opts(home, runner));
      fs.appendFileSync(promptFile(home), "\nMy own addition.\n");
      fs.renameSync(path.join(home, "distill"), path.join(home, "distill-moved-aside"));
      const forced = await runAuthorStage(opts(home, runner, true));
      expect(calls).toBe(2);
      expect(forced.authored).toEqual(["auth-feature-work"]);
      expect(fs.readFileSync(promptFile(home), "utf8")).toContain("Generated body 2.");
    });
  });

  it("resumes only when inputs and output are current; stale generation re-authors", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    const dir = path.join(home, "library", "auth-feature-work");

    let calls = 0;
    const runner: RunnerFn = (async () => {
      calls++;
      return AUTHORED;
    }) as RunnerFn;

    const opts = {
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner,
    };
    await runAuthorStage(opts);
    // Same generation and identical evidence → resumed, no additional call.
    const r1 = await runAuthorStage(opts);
    expect(calls).toBe(1);
    expect(r1.resumed).toEqual(["auth-feature-work"]);

    // Stale generation → re-authored.
    const r2 = await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      generation: "g2",
      runner,
    });
    expect(calls).toBe(2);
    expect(r2.authored).toEqual(["auth-feature-work"]);
    const sources = JSON.parse(fs.readFileSync(path.join(dir, "sources.json"), "utf8"));
    expect(sources.generation).toBe("g2");
  });

  it("repairs a missing prompt file instead of resuming its metadata alone", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    let calls = 0;
    const opts = {
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner: (async () => {
        calls++;
        return AUTHORED;
      }) as RunnerFn,
    };
    await runAuthorStage(opts);
    const file = path.join(home, "library", "auth-feature-work", "auth-feature-work.oneshot.md");
    fs.rmSync(file);
    const result = await runAuthorStage(opts);
    expect(calls).toBe(2);
    expect(result.authored).toEqual(["auth-feature-work"]);
    expect(result.resumed).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toContain(AUTHORED.oneshot_markdown);
  });

  it("re-authors when source content changes and preserves ratings and other annotations", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    let calls = 0;
    const opts = {
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner: (async () => {
        calls++;
        return AUTHORED;
      }) as RunnerFn,
    };
    await runAuthorStage(opts);
    const metadata = path.join(home, "library", "auth-feature-work", "sources.json");
    const previous = JSON.parse(fs.readFileSync(metadata, "utf8"));
    fs.writeFileSync(
      metadata,
      JSON.stringify({
        ...previous,
        rating: "up",
        rated_at: "2026-01-01T00:00:00Z",
        user_note: "Keep this annotation.",
      }),
    );
    fs.appendFileSync(path.join(home, "exports", "a.md"), "\nAlso preserve keyboard navigation.");
    const result = await runAuthorStage(opts);
    expect(calls).toBe(2);
    expect(result.authored).toEqual(["auth-feature-work"]);
    const current = JSON.parse(fs.readFileSync(metadata, "utf8"));
    expect(current.lineage.fingerprint).not.toBe(previous.lineage.fingerprint);
    expect(current).toMatchObject({
      rating: "up",
      rated_at: "2026-01-01T00:00:00Z",
      user_note: "Keep this annotation.",
    });
  });

  it("re-authors when reference evidence changes with the same members", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    let calls = 0;
    const opts = {
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner: (async () => {
        calls++;
        return AUTHORED;
      }) as RunnerFn,
    };
    await runAuthorStage(opts);
    fs.writeFileSync(
      path.join(home, "exports", "anaphora.json"),
      JSON.stringify({
        "a.md": [
          {
            index: 1,
            timestamp: "2026-01-01T00:00:00Z",
            human_text: "No.",
            antecedent: "May I deploy?",
            decision_kind: "plan",
            decision_text: "Deploy to production.",
          },
        ],
      }),
    );
    expect((await runAuthorStage(opts)).authored).toEqual(["auth-feature-work"]);
    expect(calls).toBe(2);
  });

  it("regenerates a stale author-prompt version even if membership is unchanged", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    let calls = 0;
    const opts = {
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner: (async () => {
        calls++;
        return AUTHORED;
      }) as RunnerFn,
    };
    await runAuthorStage(opts);
    const metadata = path.join(home, "library", "auth-feature-work", "sources.json");
    const previous = JSON.parse(fs.readFileSync(metadata, "utf8"));
    previous.lineage.prompt_version--;
    previous.prompt_version--;
    fs.writeFileSync(metadata, JSON.stringify(previous));
    expect((await runAuthorStage(opts)).authored).toEqual(["auth-feature-work"]);
    expect(calls).toBe(2);
  });

  it("keeps legacy prompt files with no edit-detection hash unless forced", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    const dir = path.join(home, "library", "auth-feature-work");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "sources.json"),
      JSON.stringify({
        slug: "auth-feature-work",
        generation: "old",
        members: ["a.md"],
      }),
    );
    const file = path.join(dir, "auth-feature-work.oneshot.md");
    fs.writeFileSync(file, "My hand-edited legacy prompt.");
    let calls = 0;
    const opts = {
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner: (async () => {
        calls++;
        return AUTHORED;
      }) as RunnerFn,
    };
    const kept = await runAuthorStage(opts);
    expect(calls).toBe(0);
    expect(kept.kept[0]?.reason).toContain("no verified generation hash");
    expect(fs.readFileSync(file, "utf8")).toBe("My hand-edited legacy prompt.");
    expect((await runAuthorStage({ ...opts, force: true })).authored).toEqual([
      "auth-feature-work",
    ]);
    expect(calls).toBe(1);
  });

  it("copies only cited digest preferences into new library provenance", async () => {
    const home = tmpHome();
    const quote = "Prefer the existing project build tools.";
    fs.writeFileSync(path.join(home, "exports", "a.md"), quote);
    const candidate = {
      text: quote,
      evidence: "An explicit project instruction.",
      scope: "project" as const,
      basis: "explicit" as const,
      citations: [{ message_id: "a.md#m0", quote }],
    };
    await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": { ...digest("completed"), preferences: [candidate] } },
      runner: (async () => AUTHORED) as RunnerFn,
    });
    const sources = JSON.parse(
      fs.readFileSync(path.join(home, "library", "auth-feature-work", "sources.json"), "utf8"),
    );
    expect(sources.preferences).toEqual([{ ...candidate, project: "x" }]);
    expect(sources.preferences).not.toEqual(AUTHORED.preferences);
  });

  it("refuses stale preference evidence before paying for authoring", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    let called = false;
    const result = await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: {
        "a.md": {
          ...digest("completed"),
          preferences: [
            {
              text: "Always deploy.",
              evidence: "An unsupported old claim.",
              scope: "global",
              basis: "explicit",
              citations: [{ message_id: "a.md#m0", quote: "Always deploy." }],
            },
          ],
        },
      },
      runner: (async () => {
        called = true;
        return AUTHORED;
      }) as RunnerFn,
    });
    expect(called).toBe(false);
    expect(result.failed[0]?.error).toContain("preference evidence is stale");
  });

  it("does not regenerate for membership order alone", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    writeExport(home, "b.md");
    let calls = 0;
    const opts = {
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md", "b.md"])],
      digests: { "a.md": digest("completed"), "b.md": digest("partial") },
      runner: (async () => {
        calls++;
        return AUTHORED;
      }) as RunnerFn,
    };
    await runAuthorStage(opts);
    const result = await runAuthorStage({
      ...opts,
      tasks: [task("auth-feature-work", ["b.md", "a.md"])],
    });
    expect(calls).toBe(1);
    expect(result.resumed).toEqual(["auth-feature-work"]);
  });

  it("one task's failure doesn't abort the rest", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    writeExport(home, "b.md");
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      if (opts.prompt.includes("slug: failing-task-here")) throw new Error("boom");
      return AUTHORED;
    }) as RunnerFn;

    const result = await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("failing-task-here", ["a.md"]), task("auth-feature-work", ["b.md"])],
      digests: { "a.md": digest("completed"), "b.md": digest("partial") },
      runner,
    });

    expect(result.failed).toEqual([{ export: "failing-task-here", error: "boom" }]);
    expect(result.authored).toEqual(["auth-feature-work"]);
    expect(fs.existsSync(path.join(home, "library", "auth-feature-work", "sources.json"))).toBe(
      true,
    );
  });

  it("re-authors a same-generation task whose membership changed", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    writeExport(home, "b.md");
    const dir = path.join(home, "library", "auth-feature-work");
    fs.mkdirSync(dir, { recursive: true });
    // Previously authored in g1 with members [a.md].
    fs.writeFileSync(
      path.join(dir, "sources.json"),
      JSON.stringify({ slug: "auth-feature-work", generation: "g1", members: ["a.md"] }),
    );

    let calls = 0;
    const runner: RunnerFn = (async () => {
      calls++;
      return AUTHORED;
    }) as RunnerFn;

    // Same generation g1 but membership grew to [a.md, b.md] (incremental
    // re-cluster). Must re-author, not resume stale content.
    const result = await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md", "b.md"])],
      digests: { "a.md": digest("completed"), "b.md": digest("partial") },
      generation: "g1",
      runner,
    });

    expect(calls).toBe(1);
    expect(result.authored).toEqual(["auth-feature-work"]);
    const sources = JSON.parse(fs.readFileSync(path.join(dir, "sources.json"), "utf8"));
    expect(sources.members).toEqual(["a.md", "b.md"]);

    // Re-running with the SAME membership now resumes (no further call).
    const result2 = await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md", "b.md"])],
      digests: { "a.md": digest("completed"), "b.md": digest("partial") },
      generation: "g1",
      runner,
    });
    expect(calls).toBe(1);
    expect(result2.resumed).toEqual(["auth-feature-work"]);
  });

  it("fails a task whose member export is unreadable instead of authoring a placeholder", async () => {
    const home = tmpHome();
    // Deliberately do NOT write the export for a.md → unreadable member.
    let called = false;
    const runner: RunnerFn = (async () => {
      called = true;
      return AUTHORED;
    }) as RunnerFn;

    const result = await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner,
    });

    expect(called).toBe(false);
    expect(result.authored).toEqual([]);
    expect(result.failed[0]?.export).toBe("auth-feature-work");
    expect(result.failed[0]?.error).toContain("unreadable");
    expect(fs.existsSync(path.join(home, "library", "auth-feature-work"))).toBe(false);
  });

  it("fittedLine names the prompts written from part of their group", () => {
    expect(fittedLine([])).toBeUndefined();
    expect(fittedLine([{ slug: "extract-report", used: 9, sessions: 15 }])).toBe(
      "1 prompt was written from the whole sessions that fit the size limit per call, and the other sessions of its group were left out: extract-report (9 of 15 sessions). To use every session, each shortened to fit, run:",
    );
    const many = Array.from({ length: 5 }, (_, i) => ({ slug: `g${i}`, used: 1, sessions: 2 }));
    expect(fittedLine(many)).toContain(
      "5 prompts were written from the whole sessions that fit the size limit per call, and the other sessions of their groups were left out: g0 (1 of 2 sessions), g1 (1 of 2 sessions), g2 (1 of 2 sessions), and 2 more.",
    );
  });

  it("blocks a group of which no whole session fits, under --truncate=never, without a runner call", async () => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, "exports", "a.md"), "z".repeat(5_000));
    let called = false;
    const runner: RunnerFn = (async () => {
      called = true;
      return AUTHORED;
    }) as RunnerFn;

    const result = await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner,
      budget: 1_000,
      truncate: "never",
    });

    expect(called).toBe(false);
    expect(result.authored).toEqual([]);
    expect(result.failed[0]?.export).toBe("auth-feature-work");
    expect(result.failed[0]?.error).toContain("exceeds the input budget");
    expect(fs.existsSync(path.join(home, "library", "auth-feature-work"))).toBe(false);
  });

  it("writes a group too long for one call from the whole sessions that fit, and records the rest", async () => {
    const home = tmpHome();
    // 400 + 500 + 400 characters against 1,000: two whole sessions fit.
    fs.writeFileSync(path.join(home, "exports", "a.md"), "A".repeat(400));
    fs.writeFileSync(path.join(home, "exports", "b.md"), "B".repeat(500));
    fs.writeFileSync(path.join(home, "exports", "c.md"), "C".repeat(400));
    let prompt = "";
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      prompt = opts.prompt;
      return AUTHORED;
    }) as RunnerFn;
    const result = await runAuthorStage({
      ...baseOpts(home),
      entries: ["a.md", "b.md", "c.md"].map(entry),
      tasks: [task("auth-feature-work", ["a.md", "b.md", "c.md"])],
      // The session that ended with a result goes first; an abandoned one last.
      digests: {
        "a.md": digest("abandoned"),
        "b.md": digest("completed"),
        "c.md": digest("partial"),
      },
      runner,
      budget: 1_000,
      truncate: "never",
    });
    expect(result.failed).toEqual([]);
    expect(result.authored).toEqual(["auth-feature-work"]);
    expect(result.fitted).toEqual([{ slug: "auth-feature-work", used: 2, sessions: 3 }]);
    // Whole sessions only: b and c entire, nothing of a, and no cut marker.
    expect(prompt).toContain("B".repeat(500));
    expect(prompt).toContain("C".repeat(400));
    expect(prompt).not.toContain("AAAA");
    const sources = JSON.parse(
      fs.readFileSync(path.join(home, "library", "auth-feature-work", "sources.json"), "utf8"),
    );
    expect(sources.members).toEqual(["a.md", "b.md", "c.md"]);
    expect(sources.truncations).toEqual([{ export: "a.md", block: 0, dropped_chars: 400 }]);
    expect(sources.input_coverage).toBeCloseTo(900 / 1300, 5);
  });

  it("fitWholeMembers prefers sessions with a result, then the newest, and never cuts one", () => {
    const member = (exportName: string, size: number, outcome: Digest["outcome"]) => ({
      exportName,
      content: "x".repeat(size),
      digest: digest(outcome),
    });
    const members = [
      member("a.md", 600, "unclear"),
      member("b.md", 600, "completed"),
      member("c.md", 300, "partial"),
      member("d.md", 300, "partial"),
    ];
    const newest = (name: string) => ({ "c.md": "2026-01-01", "d.md": "2026-02-01" })[name] ?? "";
    const fitted = fitWholeMembers(members, 1_000, newest);
    // b first (completed), then the newer partial d; c and a no longer fit.
    expect(fitted.kept.map((m) => m.exportName)).toEqual(["b.md", "d.md"]);
    expect(fitted.left.map((m) => m.exportName)).toEqual(["a.md", "c.md"]);
    // A session too long by itself is passed over for one that fits.
    const mixed = fitWholeMembers(
      [member("big.md", 5_000, "completed"), member("small.md", 100, "abandoned")],
      1_000,
    );
    expect(mixed.kept.map((m) => m.exportName)).toEqual(["small.md"]);
    expect(fitWholeMembers([member("big.md", 5_000, "completed")], 1_000).kept).toEqual([]);
  });

  it("cuts an over-budget task under --truncate=extreme and authors it", async () => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, "exports", "a.md"), "z".repeat(5_000));
    let promptLen = Number.POSITIVE_INFINITY;
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      promptLen = opts.prompt.length;
      return AUTHORED;
    }) as RunnerFn;

    const result = await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner,
      budget: 1_000,
      truncate: "extreme",
    });

    expect(result.authored).toEqual(["auth-feature-work"]);
    const fullPrompt = buildAuthorPrompt({
      task: task("auth-feature-work", ["a.md"]),
      members: [
        {
          exportName: "a.md",
          content: "z".repeat(5_000),
          digest: digest("completed"),
        },
      ],
    });
    expect(promptLen).toBeLessThan(fullPrompt.length);
  });

  it("records input_coverage and truncations in sources.json under --truncate=extreme", async () => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, "exports", "a.md"), "z".repeat(5_000));
    const runner: RunnerFn = (async () => AUTHORED) as RunnerFn;

    await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner,
      budget: 1_000,
      truncate: "extreme",
    });

    const sources = JSON.parse(
      fs.readFileSync(path.join(home, "library", "auth-feature-work", "sources.json"), "utf8"),
    );
    expect(sources.input_coverage).toBeLessThan(1);
    expect(sources.input_coverage).toBeGreaterThan(0);
    expect(sources.truncations.length).toBeGreaterThan(0);
    expect(sources.truncations[0].export).toBe("a.md");
    expect(sources.truncations[0].dropped_chars).toBeGreaterThan(0);
  });

  it("records full coverage (input_coverage 1, no truncations) when nothing is cut", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    const runner: RunnerFn = (async () => AUTHORED) as RunnerFn;
    await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner,
    });
    const sources = JSON.parse(
      fs.readFileSync(path.join(home, "library", "auth-feature-work", "sources.json"), "utf8"),
    );
    expect(sources.input_coverage).toBe(1);
    expect(sources.truncations).toEqual([]);
  });

  it("uses the task slug for paths even when the response slug differs", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    const runner: RunnerFn = (async () => ({ ...AUTHORED, slug: "rogue-slug-name" })) as RunnerFn;

    await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("canonical-task-slug", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner,
    });

    expect(fs.existsSync(path.join(home, "library", "canonical-task-slug"))).toBe(true);
    expect(fs.existsSync(path.join(home, "library", "rogue-slug-name"))).toBe(false);
    const sources = JSON.parse(
      fs.readFileSync(path.join(home, "library", "canonical-task-slug", "sources.json"), "utf8"),
    );
    expect(sources.slug).toBe("canonical-task-slug");
  });

  it("feeds anaphora records from anaphora.json into the prompt", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    fs.writeFileSync(
      path.join(home, "exports", "anaphora.json"),
      JSON.stringify({
        "a.md": [
          {
            index: 0,
            timestamp: "t",
            human_text: "option 2",
            antecedent: null,
            decision_kind: "question",
            decision_text: "Which db? 1) postgres 2) sqlite",
          },
        ],
      }),
    );
    let prompt = "";
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      prompt = opts.prompt;
      return AUTHORED;
    }) as RunnerFn;

    await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner,
    });

    expect(prompt).toContain('"option 2"');
    expect(prompt).toContain("Which db?");
  });

  // --- concurrency -----------------------------------------------------------
  // A runner that records how many calls are in flight at once. Calls park
  // until `target` are parked together; a fallback opens the gate on the next
  // turn of the event loop, after every worker that can start has parked, so a
  // smaller bound fails by assertion instead of hanging. No wall-clock waits.
  function trackingRunner(target: number): {
    runner: RunnerFn;
    maxActive: () => number;
  } {
    let active = 0;
    let peak = 0;
    let waiting: (() => void)[] = [];
    const open = () => {
      for (const go of waiting) go();
      waiting = [];
    };
    const runner: RunnerFn = (async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (waiting.length >= target) open();
        else setImmediate(open);
      });
      active--;
      return AUTHORED;
    }) as RunnerFn;
    return { runner, maxActive: () => peak };
  }

  function manyTasks(home: string, n: number): ClusterTask[] {
    const tasks: ClusterTask[] = [];
    for (let i = 0; i < n; i++) {
      const name = `m${i}.md`;
      fs.writeFileSync(path.join(home, "exports", name), `### t\n\ncontent ${i}\n`);
      tasks.push(task(`task-number-${i}`, [name]));
    }
    return tasks;
  }

  const manyEntries = (n: number): ManifestEntry[] =>
    Array.from({ length: n }, (_, i) => entry(`m${i}.md`));
  const manyDigests = (n: number): Record<string, Digest> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`m${i}.md`, digest("completed")]));

  it("runs author calls in parallel up to --concurrency", async () => {
    const home = tmpHome();
    const tasks = manyTasks(home, 6);
    const { runner, maxActive } = trackingRunner(3);

    const result = await runAuthorStage({
      home,
      entries: manyEntries(6),
      generation: "g1",
      toolVersion: "0.1.0",
      output: sink(),
      tasks,
      digests: manyDigests(6),
      runner,
      concurrency: 3,
    });

    expect(result.authored).toHaveLength(6);
    expect(maxActive()).toBe(3); // three calls genuinely in flight at once
  });

  it("stays sequential at concurrency 1 (default)", async () => {
    const home = tmpHome();
    const tasks = manyTasks(home, 4);
    const { runner, maxActive } = trackingRunner(4);

    const result = await runAuthorStage({
      home,
      entries: manyEntries(4),
      generation: "g1",
      toolVersion: "0.1.0",
      output: sink(),
      tasks,
      digests: manyDigests(4),
      runner,
      concurrency: 1,
    });

    expect(result.authored).toHaveLength(4);
    expect(maxActive()).toBe(1); // never more than one call in flight
  });

  it("reports results in stable task order regardless of completion timing", async () => {
    const home = tmpHome();
    const tasks = manyTasks(home, 5);
    // Resolve in a jittered order so a naive push-on-finish would scramble it.
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      const m = /task-number-(\d+)/.exec(opts.prompt);
      const i = m ? Number(m[1]) : 0;
      // Later tasks finish first: each waits one more turn of the event loop than the next.
      for (let turn = 0; turn < 5 - i; turn++) await new Promise((r) => setImmediate(r));
      return AUTHORED;
    }) as RunnerFn;

    const result = await runAuthorStage({
      home,
      entries: manyEntries(5),
      generation: "g1",
      toolVersion: "0.1.0",
      output: sink(),
      tasks,
      digests: manyDigests(5),
      runner,
      concurrency: 5,
    });

    expect(result.authored).toEqual([
      "task-number-0",
      "task-number-1",
      "task-number-2",
      "task-number-3",
      "task-number-4",
    ]);
  });
});

// --- strict retry and named recovery --------------------------------------------

describe("strict retry and named recovery follow the same rule", () => {
  const SLUG = "auth-feature-work";
  /** A saved grouping of one task whose sessions ended as `outcomes`. */
  function saved(outcomes: Digest["outcome"][]) {
    const home = tmpHome();
    const members = outcomes.map((_, index) => `m${index}.md`);
    for (const member of members)
      fs.writeFileSync(path.join(home, "exports", member), `### t\n\ncontent of ${member}\n`);
    fs.writeFileSync(
      path.join(home, "exports", "manifest.json"),
      JSON.stringify(members.map(entry)),
    );
    const digests = Object.fromEntries(
      members.map((member, index) => [member, digest(outcomes[index] ?? "unclear")]),
    );
    const grouping = task(SLUG, members);
    saveDigests(home, { generation: "g1", prompt_version: 1, digests });
    saveTasks(home, { generation: "g1", prompt_version: 1, tasks: [grouping], misc: [] });
    return { home, members, digests, grouping };
  }
  const sourcesOf = (home: string) =>
    JSON.parse(fs.readFileSync(path.join(home, "library", SLUG, "sources.json"), "utf8"));

  it("a strict retry of an unverified group writes its prompt with the mark", async () => {
    const { home, members, digests, grouping } = saved(["unclear", "abandoned"]);
    const failed = await runAuthorStage({
      home,
      entries: members.map(entry),
      generation: "g1",
      toolVersion: "0.1.0",
      output: sink(),
      tasks: [grouping],
      digests,
      runner: (async () => {
        throw new Error("writer unavailable");
      }) as RunnerFn,
    });
    expect(failed.failed).toHaveLength(1);
    const handlers = createRetryHandlers(home);
    const plan = prepareRetry({ home, stage: "author", handlers });
    expect(plan.modelOperations).toHaveLength(1);
    // A saved answer is checked again in full, so it is a realistic length.
    const run = (async () => ({
      ...AUTHORED,
      oneshot_markdown: `${AUTHORED.oneshot_markdown} ${"Keep each change small and explain the decision behind it. ".repeat(2)}`,
    })) as RunnerFn;
    const outcome = await executeRetry(plan, {
      handlers,
      output: sink(),
      getRunner: () => ({ name: "claude" as const, installHint: "", run }),
    });
    expect(outcome.failed).toEqual([]);
    expect(sourcesOf(home)).toMatchObject({ outcome_verified: false, confidence: "low" });
  });

  it("named recovery prepares an unverified group and refuses one whose sessions were all abandoned", () => {
    const unverified = saved(["unclear"]);
    const [operation] = prepareTaskRecoveryInputs(unverified.home, [SLUG], { runner: "claude" });
    expect(operation?.unitId).toBe(SLUG);
    const abandoned = saved(["abandoned", "abandoned"]);
    expect(() => prepareTaskRecoveryInputs(abandoned.home, [SLUG], { runner: "claude" })).toThrow(
      `${SLUG}: all 2 sessions were abandoned, so it gets no prompt`,
    );
  });
});
