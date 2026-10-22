import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Built-ins only: exercise installed packages on the minimum supported Node,
// independently of the development toolchain's own Node requirement.
const prefix = process.argv[2];
if (!prefix) throw new Error("Usage: node scripts/smoke-runtime.mjs /installed/package/prefix");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-runtime-"));
const prompt = "Please improve our build workflow. Keep the café example readable.";
let gui;
try {
  const file = path.join(root, "opencode.db");
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE session_v2(id TEXT, directory TEXT, title TEXT, parent_id TEXT, time_updated INTEGER, revert TEXT);
      CREATE TABLE session_message(id TEXT, session_id TEXT, seq INTEGER, type TEXT, time_created INTEGER, data TEXT);
    `);
    db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, NULL, ?, NULL)").run(
      "ses_package",
      "/synthetic/project",
      "Package fixture",
      1792670400000,
    );
    db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)").run(
      "msg_package",
      "ses_package",
      1,
      "user",
      1792670400000,
      JSON.stringify({ text: prompt, time: { created: 1792670400000 } }),
    );
  } finally {
    db.close();
  }
  for (const name of ["human-hindsight", "cc-hindsight"]) {
    const binary = path.resolve(prefix, "node_modules/.bin", name);
    const libraryHome = path.join(root, name);
    const env = {
      ...process.env,
      HUMAN_HINDSIGHT_HOME: undefined,
      CC_HINDSIGHT_HOME: libraryHome,
    };
    const run = (args) =>
      execFileSync(process.execPath, [binary, ...args], { env, encoding: "utf8", timeout: 10000 });
    const installed = JSON.parse(
      fs.readFileSync(path.resolve(prefix, "node_modules/human-hindsight/package.json"), "utf8"),
    );
    assert(run(["--version"]).includes(installed.version));
    const source = ["--source", "opencode", "--opencode-dir", root, "--opencode-db", file];
    assert(run(["scan", ...source]).includes("1 sessions"));
    run(["export", ...source]);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(libraryHome, "exports/manifest.json"), "utf8"),
    );
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].origin, "opencode");
    assert(
      fs
        .readFileSync(path.join(libraryHome, "exports", manifest[0].export), "utf8")
        .includes(prompt),
    );
    const entry = path.join(libraryHome, "library/packaged-prompt");
    fs.mkdirSync(entry, { recursive: true });
    fs.writeFileSync(
      path.join(entry, "sources.json"),
      JSON.stringify({
        slug: "packaged-prompt",
        title: "Packaged prompt",
        domains: ["Infrastructure"],
        members: [manifest[0].export],
        confidence: "high",
        authored_at: "2026-10-22T12:00:00Z",
        preferences: [{ text: "Keep changes focused.", evidence: "Synthetic fixture" }],
      }),
    );
    fs.writeFileSync(
      path.join(entry, "packaged-prompt.oneshot.md"),
      `# Packaged prompt\n\n${prompt}\n`,
    );
    assert(run(["show", "packaged-prompt", "--raw"]).includes(prompt));
    assert(run(["preferences", "--target", "opencode"]).includes("AGENTS.md"));
    const before = fs.readFileSync(file);
    assert(run(["retention", ...source, "--apply", "--yes"]).includes("No changes needed"));
    assert.deepEqual(fs.readFileSync(file), before);
    console.log(
      `${name}: version, SQLite export, legacy home, library and retention passed on ${process.version}.`,
    );

    if (name === "human-hindsight") {
      gui = spawn(process.execPath, [binary, "gui", "--no-open"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const processHandle = gui;
      const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("GUI startup timed out")), 10000);
        let stdout = "";
        processHandle.stdout.setEncoding("utf8");
        processHandle.stdout.on("data", (text) => {
          stdout += text;
          const url = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
          if (url) {
            clearTimeout(timer);
            resolve(url);
          }
        });
        processHandle.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("GUI exited before startup"));
        });
        processHandle.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      const data = await (await fetch(`${url}/api/library`)).json();
      assert.equal(data.entries[0].body, prompt);
      const stopped = new Promise((resolve) => processHandle.once("exit", resolve));
      processHandle.kill("SIGTERM");
      await stopped;
      gui = undefined;
      console.log(`GUI library API and shutdown passed on ${process.version}.`);
    }
  }
} finally {
  gui?.kill("SIGKILL");
  fs.rmSync(root, { recursive: true, force: true });
}
