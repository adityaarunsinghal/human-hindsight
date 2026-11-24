import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { runCommand } from "citty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runEdit } from "../src/commands/edit.js";
import { runPrune } from "../src/commands/prune.js";
import { runRate } from "../src/commands/rate.js";
import show from "../src/commands/show.js";
import { isEdited, oneshotHash, readLibrary } from "../src/core/library.js";

// Library verbs. Fixtures only; library entries are synthetic.

const tmpDirs: string[] = [];
function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cch-verbs-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

/** Write a library entry; oneshot_hash matches the file unless overridden. */
function writeEntry(
  home: string,
  slug: string,
  opts: { generation?: string; edited?: boolean; verified?: boolean } = {},
): void {
  const dir = path.join(home, "library", slug);
  fs.mkdirSync(dir, { recursive: true });
  const oneshot = `<!-- prov -->\n\n# ${slug}\n\nDo the ${slug} thing.\n`;
  fs.writeFileSync(path.join(dir, `${slug}.oneshot.md`), oneshot);
  const hash = oneshotHash(oneshot);
  fs.writeFileSync(
    path.join(dir, "sources.json"),
    JSON.stringify({
      slug,
      title: slug,
      members: ["a.md"],
      sessionIds: ["s1"],
      preferences: [],
      outcome_summary: "1 completed",
      domains: ["x"],
      confidence: "high",
      authored_at: "2026-07-01T00:00:00Z",
      model: null,
      prompt_version: 1,
      tool_version: "0.1.1",
      generation: opts.generation ?? "g1",
      oneshot_hash: hash,
      ...(opts.verified === false ? { outcome_verified: false } : {}),
    }),
  );
  if (opts.edited) {
    fs.appendFileSync(path.join(dir, `${slug}.oneshot.md`), "\nhand edit\n");
  }
}

/** Write a tasks checkpoint anchoring the given slugs at generation g1. */
function writeTasks(home: string, slugs: string[]): void {
  fs.mkdirSync(path.join(home, "distill"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "distill", "tasks.json"),
    JSON.stringify({
      generation: "g1",
      prompt_version: 1,
      tasks: slugs.map((slug) => ({
        slug,
        title: slug,
        rationale: "r",
        members: ["a.md"],
      })),
      misc: [],
    }),
  );
}

function capture(): { out: Writable; text: () => string } {
  let buf = "";
  const out = new Writable({
    write(chunk, _enc, cb) {
      buf += String(chunk);
      cb();
    },
  });
  return { out, text: () => stripVTControlCharacters(buf) };
}

function inputWith(answer: string): Readable {
  return Readable.from([`${answer}\n`]);
}

describe("edit", () => {
  it("launches the editor on the oneshot and reports a detected edit", () => {
    const home = tmpHome();
    writeEntry(home, "my-task");
    const launched: string[] = [];
    const { out, text } = capture();

    const code = runEdit(
      { home, slug: "my-task" },
      {
        launch: (file) => {
          launched.push(file);
          fs.appendFileSync(file, "\nuser tweak\n"); // simulate an edit
          return 0;
        },
        output: out,
      },
    );

    expect(code).toBe(0);
    expect(launched).toEqual([path.join(home, "library", "my-task", "my-task.oneshot.md")]);
    expect(text()).toContain("my-task edited. Distill will keep your version");
    const entry = readLibrary(home).find((e) => e.slug === "my-task");
    expect(entry && isEdited(entry)).toBe(true);
  });

  it("reports unchanged when the editor made no changes", () => {
    const home = tmpHome();
    writeEntry(home, "my-task");
    const { out, text } = capture();
    const code = runEdit({ home, slug: "my-task" }, { launch: () => 0, output: out });
    expect(code).toBe(0);
    expect(text()).toContain("unchanged");
  });

  it("fails cleanly on a missing slug and a failing editor", () => {
    const home = tmpHome();
    const { out: out1, text: text1 } = capture();
    expect(runEdit({ home, slug: "nope" }, { launch: () => 0, output: out1 })).toBe(1);
    expect(text1()).toContain('No prompt named "nope".');

    writeEntry(home, "my-task");
    const { out: out2, text: text2 } = capture();
    expect(runEdit({ home, slug: "my-task" }, { launch: () => 3, output: out2 })).toBe(1);
    expect(text2()).toContain("editor exited with status 3");
  });
});

describe("rate", () => {
  it("records rating and rated_at in sources.json", () => {
    const home = tmpHome();
    writeEntry(home, "my-task");
    const { out, text } = capture();

    expect(runRate({ home, slug: "my-task", rating: "up" }, { output: out })).toBe(0);
    expect(text()).toContain("rated up");

    const sources = JSON.parse(
      fs.readFileSync(path.join(home, "library", "my-task", "sources.json"), "utf8"),
    );
    expect(sources.rating).toBe("up");
    expect(typeof sources.rated_at).toBe("string");
    // Rating must not disturb overwrite protection: the hash is unchanged.
    const entry = readLibrary(home).find((e) => e.slug === "my-task");
    expect(entry && isEdited(entry)).toBe(false);
  });

  it("rejects a rating that isn't up/down and a missing slug", () => {
    const home = tmpHome();
    writeEntry(home, "my-task");
    const { out: out1 } = capture();
    expect(runRate({ home, slug: "my-task", rating: "great" }, { output: out1 })).toBe(1);
    const { out: out2 } = capture();
    expect(runRate({ home, slug: "nope", rating: "up" }, { output: out2 })).toBe(1);
  });
});

describe("prune", () => {
  it("removes orphans after consent; keeps current entries", async () => {
    const home = tmpHome();
    writeEntry(home, "current-task");
    writeEntry(home, "orphan-task", { generation: "g0" }); // stale generation
    writeEntry(home, "zombie-task"); // same gen, slug not in tasks
    writeTasks(home, ["current-task"]);
    const { out, text } = capture();

    const code = await runPrune({ home }, { input: inputWith("y"), output: out });

    expect(code).toBe(0);
    expect(text()).toContain("2 library entries were left behind when sessions were regrouped");
    expect(fs.existsSync(path.join(home, "library", "current-task"))).toBe(true);
    expect(fs.existsSync(path.join(home, "library", "orphan-task"))).toBe(false);
    expect(fs.existsSync(path.join(home, "library", "zombie-task"))).toBe(false);
  });

  it("declining is exit 2 and removes nothing", async () => {
    const home = tmpHome();
    writeEntry(home, "orphan-task", { generation: "g0" });
    writeTasks(home, []);
    const { out } = capture();

    const code = await runPrune({ home }, { input: inputWith("n"), output: out });

    expect(code).toBe(2);
    expect(fs.existsSync(path.join(home, "library", "orphan-task"))).toBe(true);
  });

  it("keeps hand-edited orphans unless --force", async () => {
    const home = tmpHome();
    writeEntry(home, "edited-orphan", { generation: "g0", edited: true });
    writeTasks(home, []);
    const { out, text } = capture();

    const code = await runPrune({ home, yes: true }, { output: out });
    expect(code).toBe(0);
    expect(text()).toContain("Keep edited-orphan");
    expect(text()).toContain("edited by hand (use --force to remove)");
    expect(fs.existsSync(path.join(home, "library", "edited-orphan"))).toBe(true);

    const { out: out2 } = capture();
    const code2 = await runPrune({ home, yes: true, force: true }, { output: out2 });
    expect(code2).toBe(0);
    expect(fs.existsSync(path.join(home, "library", "edited-orphan"))).toBe(false);
  });

  it("dry-run lists but removes nothing; no checkpoint is exit 1", async () => {
    const home = tmpHome();
    writeEntry(home, "orphan-task", { generation: "g0" });
    const { out: out1, text: text1 } = capture();
    expect(await runPrune({ home }, { output: out1 })).toBe(1);
    expect(text1()).toContain("No distill checkpoint");

    writeTasks(home, []);
    const { out: out2, text: text2 } = capture();
    expect(await runPrune({ home, "dry-run": true }, { output: out2 })).toBe(0);
    expect(text2()).toContain("dry-run: would remove 1");
    expect(fs.existsSync(path.join(home, "library", "orphan-task"))).toBe(true);
  });
});

describe("show", () => {
  // The body is styled only where color is allowed; the menu check (stdin a
  // terminal) has nothing to do with it.
  it.each([
    ["no color allowed: raw Markdown", {}, false],
    ["FORCE_COLOR: styled even without a terminal", { FORCE_COLOR: "1" }, true],
    ["--raw wins over FORCE_COLOR", { FORCE_COLOR: "1" }, false, ["--raw"]],
  ] as [
    string,
    Record<string, string>,
    boolean,
    string[]?,
  ][])("%s", async (_name, env, styled, extra = []) => {
    const home = tmpHome();
    writeEntry(home, "review-changes");
    // Bold text renders differently styled and raw; a plain sentence would not.
    fs.writeFileSync(
      path.join(home, "library", "review-changes", "review-changes.oneshot.md"),
      "<!-- prov -->\n\n# review-changes\n\nDo the **review-changes** thing.\n",
    );
    vi.stubEnv("NO_COLOR", "");
    vi.stubEnv("FORCE_COLOR", "");
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      logs.push(parts.map(String).join(" "));
    });
    try {
      await runCommand(show, {
        rawArgs: ["review-changes", "--home", home, "--no-follow-up", ...extra],
      });
    } finally {
      log.mockRestore();
      vi.unstubAllEnvs();
    }
    const text = logs.join("\n");
    expect(text.includes("Do the **review-changes** thing.")).toBe(!styled);
    expect(stripVTControlCharacters(text)).toContain("review-changes");
    // The summary line counts its one session in the singular.
    expect(stripVTControlCharacters(text)).toMatch(/\b1 session\b(?!s)/);
    expect(text).not.toContain("(s)");
  });

  it.each([
    ["an unverified prompt says so under its title", false, [], true],
    ["--raw leaves the line out", false, ["--raw"], false],
    ["a verified prompt has no such line", true, [], false],
  ] as [string, boolean, string[], boolean][])("%s", async (_name, verified, extra, said) => {
    const home = tmpHome();
    writeEntry(home, "review-changes", { verified });
    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      logs.push(parts.map(String).join(" "));
    });
    try {
      await runCommand(show, {
        rawArgs: ["review-changes", "--home", home, "--no-follow-up", ...extra],
      });
    } finally {
      log.mockRestore();
    }
    const lines = stripVTControlCharacters(logs.join("\n")).split("\n");
    const at = lines.indexOf(
      "Outcome not verified: none of its sessions was seen to reach a result.",
    );
    expect(at >= 0).toBe(said);
    // Near the title: right under the facts line that follows it.
    if (said) expect(lines[0]).toMatch(/^# /);
    if (said) expect(at).toBeLessThanOrEqual(3);
  });
});
