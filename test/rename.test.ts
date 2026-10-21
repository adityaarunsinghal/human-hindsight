import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { resolveDataHome } from "../src/commands/_shared.js";
import { classifyKiroSession } from "../src/sources/kiro/extract.js";
import { classifyKiroV3Session } from "../src/sources/kiro/extract-v3.js";

let userHome: string;
beforeEach(() => {
  userHome = fs.mkdtempSync(path.join(os.tmpdir(), "human-hindsight-rename-"));
});
afterEach(() => fs.rmSync(userHome, { recursive: true, force: true }));
const exec = promisify(execFile);

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

describe("deprecated compatibility command", () => {
  it("forwards arguments, stdin, stdout, stderr, and exit status in the same process", async () => {
    const wrapperDir = path.join(userHome, "wrapper");
    const appDir = path.join(wrapperDir, "node_modules", "human-hindsight");
    fs.mkdirSync(path.join(appDir, "dist"), { recursive: true });
    fs.copyFileSync(
      path.join(import.meta.dirname, "../compat/cc-hindsight/cli.js"),
      path.join(wrapperDir, "cli.js"),
    );
    fs.writeFileSync(path.join(wrapperDir, "package.json"), JSON.stringify({ type: "module" }));
    fs.writeFileSync(
      path.join(appDir, "package.json"),
      JSON.stringify({
        name: pkg.name,
        type: "module",
        exports: pkg.exports,
      }),
    );
    fs.writeFileSync(
      path.join(appDir, "dist", "cli.js"),
      `
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input }));
      process.stderr.write("fixture stderr");
      process.exitCode = 17;
    `,
    );
    const child = exec(process.execPath, [
      path.join(wrapperDir, "cli.js"),
      "gui",
      "--home",
      "/a path",
    ]);
    child.child.stdin?.end("fixture stdin");
    try {
      await child;
      throw new Error("The fixture must return its nonzero exit status.");
    } catch (error) {
      const result = error as { code: number; stdout: string; stderr: string };
      expect(result.code).toBe(17);
      expect(JSON.parse(result.stdout)).toEqual({
        args: ["gui", "--home", "/a path"],
        input: "fixture stdin",
      });
      expect(result.stderr).toBe("fixture stderr");
    }
  });
});
