import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataHomeSource, resolveDataHome, resolvePaths } from "../src/commands/_shared.js";
import { classifyKiroSession } from "../src/sources/kiro/extract.js";
import { classifyKiroV3Session } from "../src/sources/kiro/extract-v3.js";

let userHome: string;
beforeEach(() => {
  userHome = fs.mkdtempSync(path.join(os.tmpdir(), "human-hindsight-rename-"));
});
afterEach(() => fs.rmSync(userHome, { recursive: true, force: true }));

describe("renamed data directory", () => {
  it("uses the new name for a fresh installation without creating any files", () => {
    expect(resolveDataHome(undefined, { env: {}, homedir: userHome })).toBe(
      path.join(userHome, ".human-hindsight"),
    );
    expect(fs.readdirSync(userHome)).toEqual([]);
  });

  it("reuses the old library without moving, copying, or rewriting it", () => {
    const legacy = path.join(userHome, ".cc-hindsight");
    fs.mkdirSync(path.join(legacy, "library"), { recursive: true });
    const marker = path.join(legacy, "library", "saved-prompt.md");
    fs.writeFileSync(marker, "My existing prompt and edits.");
    expect(resolveDataHome(undefined, { env: {}, homedir: userHome })).toBe(legacy);
    expect(fs.readFileSync(marker, "utf8")).toBe("My existing prompt and edits.");
    expect(fs.readdirSync(userHome)).toEqual([".cc-hindsight"]);
  });

  it("prefers an existing new directory and does not merge two libraries", () => {
    const preferred = path.join(userHome, ".human-hindsight");
    fs.mkdirSync(preferred);
    fs.mkdirSync(path.join(userHome, ".cc-hindsight"));
    expect(resolveDataHome(undefined, { env: {}, homedir: userHome })).toBe(preferred);
    expect(fs.readdirSync(preferred)).toEqual([]);
  });

  it("honors --home, then the new environment variable, then the legacy alias", () => {
    const env = { HUMAN_HINDSIGHT_HOME: "/new/explicit", CC_HINDSIGHT_HOME: "/old/explicit" };
    expect(resolveDataHome("/flag", { env, homedir: userHome })).toBe("/flag");
    expect(resolveDataHome(undefined, { env, homedir: userHome })).toBe("/new/explicit");
    expect(
      resolveDataHome(undefined, {
        env: { CC_HINDSIGHT_HOME: "/old/explicit" },
        homedir: userHome,
      }),
    ).toBe("/old/explicit");
  });

  it("an empty variable counts as unset, and an empty --home is refused: never the current folder", () => {
    const preferred = path.join(userHome, ".human-hindsight");
    for (const env of [
      { HUMAN_HINDSIGHT_HOME: "" },
      { CC_HINDSIGHT_HOME: "" },
      { HUMAN_HINDSIGHT_HOME: "", CC_HINDSIGHT_HOME: "" },
      { HUMAN_HINDSIGHT_HOME: "  " },
    ]) {
      expect(resolveDataHome(undefined, { env, homedir: userHome }), JSON.stringify(env)).toBe(
        preferred,
      );
      expect(dataHomeSource(undefined, env)).toBe("default");
    }
    expect(
      resolveDataHome(undefined, {
        env: { HUMAN_HINDSIGHT_HOME: "", CC_HINDSIGHT_HOME: "/old/explicit" },
        homedir: userHome,
      }),
    ).toBe("/old/explicit");
    expect(() => resolveDataHome("", { env: {}, homedir: userHome })).toThrow(
      '--home takes a folder, not "".',
    );
    // The same rule for every history folder's variable.
    const paths = resolvePaths(
      {},
      {
        HUMAN_HINDSIGHT_CLAUDE_DIR: "",
        HUMAN_HINDSIGHT_CODEX_DIR: " ",
        HUMAN_HINDSIGHT_KIRO_DIR: "",
        HUMAN_HINDSIGHT_KIROCREW_DIR: "",
      },
    );
    for (const dir of [paths.claudeDir, paths.codexDir, paths.kiroDir, paths.kirocrewDir])
      expect(path.isAbsolute(dir), dir).toBe(true);
  });
});

describe("historical automation markers", () => {
  it.each([
    "[cc-hindsight distill]",
    "[human-hindsight distill]",
  ])("excludes %s sessions in both Kiro formats", (marker) => {
    const meta = { hasHistory: true, cwd: "/fixture" };
    const prompt = `${marker}\nSummarize these human messages.`;
    expect(classifyKiroSession(meta, prompt).include).toBe(false);
    expect(classifyKiroV3Session(meta, prompt).include).toBe(false);
  });
});

// The compatibility command's forwarding through the launcher is a smoke test:
// test/rename.smoke.test.ts.
