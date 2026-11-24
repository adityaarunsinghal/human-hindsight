import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };

// Smoke tier: both published entry points, installed from the real files, run
// as processes. The application is a fixture that echoes what it received.
//
// HUMAN_HINDSIGHT_OLDEST_NODE names a Node 18 binary (CI always sets it).
const oldest = process.env.HUMAN_HINDSIGHT_OLDEST_NODE;

let prefix: string;
beforeEach(() => {
  prefix = fs.mkdtempSync(path.join(os.tmpdir(), "human-hindsight-forward-"));
  const modules = path.join(prefix, "node_modules");
  const app = path.join(modules, "human-hindsight");
  const wrapper = path.join(modules, "cc-hindsight");
  const compat = path.join(import.meta.dirname, "../compat/cc-hindsight");
  fs.mkdirSync(path.join(app, "dist"), { recursive: true });
  fs.mkdirSync(path.join(app, "launcher"), { recursive: true });
  fs.mkdirSync(wrapper, { recursive: true });
  // The real published files: the wrapper with its own package type, and the
  // version guard it enters before the application bundle.
  for (const file of ["cli.js", "package.json"]) {
    fs.copyFileSync(path.join(compat, file), path.join(wrapper, file));
  }
  fs.copyFileSync(
    path.join(import.meta.dirname, "../launcher/cli.cjs"),
    path.join(app, "launcher", "cli.cjs"),
  );
  fs.writeFileSync(
    path.join(app, "package.json"),
    JSON.stringify({ name: pkg.name, type: "module", bin: pkg.bin, exports: pkg.exports }),
  );
  fs.writeFileSync(
    path.join(app, "dist", "cli.js"),
    `
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input, pid: process.pid }));
    process.stderr.write("fixture stderr");
    process.exitCode = 17;
  `,
  );
});
afterEach(() => fs.rmSync(prefix, { recursive: true, force: true }));

const entries = {
  "human-hindsight": () => path.join(prefix, "node_modules/human-hindsight/launcher/cli.cjs"),
  "cc-hindsight": () => path.join(prefix, "node_modules/cc-hindsight/cli.js"),
};

function run(node: string, entry: string, args: string[], input: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; pid?: number }>(
    (resolve, reject) => {
      const child = spawn(node, [entry, ...args], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (text) => {
        stdout += text;
      });
      child.stderr.setEncoding("utf8").on("data", (text) => {
        stderr += text;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr, pid: child.pid }));
      child.stdin.end(input);
    },
  );
}

describe.each(Object.keys(entries) as (keyof typeof entries)[])("the %s command", (name) => {
  it("forwards arguments, stdin, stdout, stderr, and exit status in the same process", async () => {
    const result = await run(
      process.execPath,
      entries[name](),
      ["gui", "--home", "/a path"],
      "fixture stdin",
    );
    expect(result.code).toBe(17);
    expect(JSON.parse(result.stdout)).toEqual({
      args: ["gui", "--home", "/a path"],
      input: "fixture stdin",
      // The application runs in the command's own process, not a child.
      pid: result.pid,
    });
    expect(result.stderr).toBe("fixture stderr");
  });

  it.skipIf(!oldest && !process.env.CI)(
    "stops on Node 18 with the short message and never loads the application",
    async () => {
      const result = await run(oldest ?? "missing-node", entries[name](), ["--version"], "");
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.split("\n")[0]).toMatch(
        /^Human Hindsight needs Node\.js 22\.13 or newer in the 22 line, or 23\.4 or newer; you have 18\.\d+\.\d+\.$/,
      );
      expect(result.stderr).not.toContain("fixture");
    },
  );
});
