import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SuggestionArtifact } from "../src/core/subagents.js";
import {
  HARNESS_ROOTS,
  harnessRootWarning,
  writeSubagentTree,
} from "../src/core/subagents-export.js";
import { renderSubagentTree } from "../src/core/subagents-render.js";
import { unzipStore, zipStore } from "../src/core/zip.js";

let base: string;
beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-export-")));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function tree(): Map<string, string> {
  const artifact = JSON.parse(
    fs.readFileSync(
      path.join(import.meta.dirname, "fixtures", "subagents", "suggestion.sample.json"),
      "utf8",
    ),
  ) as SuggestionArtifact;
  return renderSubagentTree(artifact, { target: "all" });
}

const mode = (file: string) => fs.statSync(file).mode & 0o777;

describe("writeSubagentTree", () => {
  it("writes every file owner-only and makes create-bots.sh executable", () => {
    const dir = path.join(base, "out");
    const files = tree();
    const result = writeSubagentTree(dir, files, { force: false });
    expect(result).toEqual({ written: [...files.keys()], skipped: [] });
    for (const [file, content] of files) {
      expect(fs.readFileSync(path.join(dir, file), "utf8")).toBe(content);
    }
    expect(mode(path.join(dir, "kirocrew", "create-bots.sh"))).toBe(0o700);
    expect(mode(path.join(dir, "README.md"))).toBe(0o600);
    expect(mode(path.join(dir, "kirocrew", "skills"))).toBe(0o700);
  });

  it("keeps the permissions of an export folder that already exists", () => {
    // The person may export into a project folder that others can read.
    const dir = path.join(base, "shared");
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o755);
    writeSubagentTree(dir, new Map([["README.md", "hello\n"]]), { force: false });
    expect(mode(dir)).toBe(0o755);
    expect(mode(path.join(dir, "README.md"))).toBe(0o600);
  });

  it("creates a missing export folder owner-only", () => {
    const dir = path.join(base, "fresh", "nested");
    writeSubagentTree(dir, new Map([["README.md", "hello\n"]]), { force: false });
    expect(mode(dir)).toBe(0o700);
  });

  it("skips existing files without force and overwrites them with force", () => {
    const dir = path.join(base, "out");
    const files = new Map([
      ["README.md", "new readme"],
      ["knowledge/shared.md", "new shared"],
    ]);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "README.md"), "my edits");
    expect(writeSubagentTree(dir, files, { force: false })).toEqual({
      written: ["knowledge/shared.md"],
      skipped: ["README.md"],
    });
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toBe("my edits");
    expect(writeSubagentTree(dir, files, { force: true })).toEqual({
      written: ["README.md", "knowledge/shared.md"],
      skipped: [],
    });
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toBe("new readme");
  });

  it("refuses a symlinked subdirectory that points outside the folder", () => {
    const dir = path.join(base, "out");
    const outside = path.join(base, "outside");
    fs.mkdirSync(dir);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(dir, "knowledge"));
    expect(() =>
      writeSubagentTree(dir, new Map([["knowledge/shared.md", "x"]]), { force: true }),
    ).toThrow(/links outside the export folder/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("refuses to replace a symlinked file", () => {
    const dir = path.join(base, "out");
    const outside = path.join(base, "target.md");
    fs.mkdirSync(dir);
    fs.writeFileSync(outside, "keep");
    fs.symlinkSync(outside, path.join(dir, "README.md"));
    expect(() => writeSubagentTree(dir, new Map([["README.md", "x"]]), { force: true })).toThrow(
      /symbolic link/,
    );
    expect(fs.readFileSync(outside, "utf8")).toBe("keep");
  });

  it("follows a symlinked subdirectory that stays inside the folder", () => {
    const dir = path.join(base, "out");
    fs.mkdirSync(path.join(dir, "real"), { recursive: true });
    fs.symlinkSync(path.join(dir, "real"), path.join(dir, "knowledge"));
    writeSubagentTree(dir, new Map([["knowledge/shared.md", "x"]]), { force: false });
    expect(fs.readFileSync(path.join(dir, "real", "shared.md"), "utf8")).toBe("x");
  });

  it("accepts an export folder that is itself a symlink", () => {
    const real = path.join(base, "real-out");
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(base, "link-out"));
    writeSubagentTree(path.join(base, "link-out"), new Map([["a/b.md", "x"]]), { force: false });
    expect(fs.readFileSync(path.join(real, "a", "b.md"), "utf8")).toBe("x");
  });

  it("refuses paths that leave the folder before writing anything", () => {
    const dir = path.join(base, "out");
    for (const name of ["../escape.md", "/abs.md", "a/../../b.md", "a\\b.md"]) {
      expect(() =>
        writeSubagentTree(
          dir,
          new Map([
            ["ok.md", "x"],
            [name, "x"],
          ]),
          { force: false },
        ),
      ).toThrow(/outside the export folder/);
    }
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("round-trips the rendered tree through the zip writer", () => {
    const files = tree();
    expect(
      new Map([...unzipStore(zipStore(files))].map(([n, d]) => [n, new TextDecoder().decode(d)])),
    ).toEqual(files);
  });
});

describe("harnessRootWarning", () => {
  it("lists the harness roots relative to home", () => {
    expect(HARNESS_ROOTS).toEqual([".claude", ".codex", ".kiro", ".kiro/crew"]);
  });

  it("warns for a harness root or a folder inside one, naming the most specific root", () => {
    const home = path.join(base, "home");
    expect(harnessRootWarning(path.join(home, ".claude"), home)).toContain(
      `inside ${path.join(home, ".claude")},`,
    );
    expect(harnessRootWarning(path.join(home, ".claude", "agents"), home)).toContain(
      path.join(home, ".claude"),
    );
    expect(harnessRootWarning(path.join(home, ".kiro", "crew", "skills"), home)).toContain(
      `inside ${path.join(home, ".kiro", "crew")},`,
    );
    expect(harnessRootWarning(path.join(home, ".codex"), home)).not.toBeNull();
  });

  it("does not warn for an ordinary folder or a look-alike name", () => {
    const home = path.join(base, "home");
    expect(harnessRootWarning(path.join(home, "my-agents"), home)).toBeNull();
    expect(harnessRootWarning(path.join(home, ".claude-export"), home)).toBeNull();
    expect(harnessRootWarning(home, home)).toBeNull();
  });

  it.each([
    ["the flag", { dirs: { claude: "/flag/claude" }, env: {} }, "/flag/claude"],
    [
      "the private name",
      { env: { HUMAN_HINDSIGHT_CLAUDE_DIR: "/private/claude" } },
      "/private/claude",
    ],
    [
      "the private name",
      { env: { HUMAN_HINDSIGHT_CODEX_DIR: "/private/codex" } },
      "/private/codex",
    ],
    ["the private name", { env: { HUMAN_HINDSIGHT_KIRO_DIR: "/private/kiro" } }, "/private/kiro"],
    ["the tool's own variable", { env: { CLAUDE_CONFIG_DIR: "/tool/claude" } }, "/tool/claude"],
  ])("warns for a harness folder set by %s (%s)", (_how, opts, root) => {
    const home = path.join(base, "home");
    const resolved = path.resolve(root);
    expect(harnessRootWarning(path.join(resolved, "agents"), home, opts)).toContain(
      `inside ${resolved},`,
    );
    // Every place in the order is covered at once; the default stays covered too.
    expect(harnessRootWarning(path.join(home, ".claude"), home, opts)).not.toBeNull();
    expect(harnessRootWarning(path.join(base, "elsewhere"), home, opts)).toBeNull();
  });

  it("also warns for a harness root moved by its environment variable", () => {
    const home = path.join(base, "home");
    const moved = process.env.CODEX_HOME;
    if (!moved) throw new Error("test setup sets CODEX_HOME");
    expect(harnessRootWarning(path.join(moved, "agents"), home)).toContain(moved);
  });
});
