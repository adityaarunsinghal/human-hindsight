import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

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
      // A desktop session, so `gui` picks its own port as it does on a laptop.
      SSH_CONNECTION: "",
      SSH_CLIENT: "",
      SSH_TTY: "",
      DISPLAY: ":0",
    };
    const run = (args) =>
      execFileSync(process.execPath, [binary, ...args], { env, encoding: "utf8", timeout: 10000 });
    // `preferences` writes only the instruction block to stdout and every note
    // to stderr, so a redirect gives a clean file. Read the two apart.
    const streams = (args) => {
      const result = spawnSync(process.execPath, [binary, ...args], {
        env,
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(result.status, 0, result.stderr);
      return result;
    };
    const installed = JSON.parse(
      fs.readFileSync(path.resolve(prefix, "node_modules/human-hindsight/package.json"), "utf8"),
    );
    assert(run(["--version"]).includes(installed.version));
    const source = ["--source", "opencode", "--opencode-dir", root, "--opencode-db", file];
    assert(run(["scan", ...source]).includes("1 project, 1 session\n"));
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
    const none = streams(["preferences", "--target", "opencode"]);
    assert.equal(none.stdout, "");
    assert(none.stderr.includes("No accepted preferences"));
    const unreviewed = streams(["preferences", "--target", "opencode", "--include-unreviewed"]);
    assert(unreviewed.stdout.includes("Keep changes focused."));
    assert(unreviewed.stderr.includes("AGENTS.md"));
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
      // The printed address carries the session key in its fragment. Every
      // /api route needs that key in a header, so read both from the output.
      const { url, key } = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("GUI startup timed out")), 10000);
        let stdout = "";
        processHandle.stdout.setEncoding("utf8");
        processHandle.stdout.on("data", (text) => {
          stdout += text;
          const printed = stdout.match(
            /(http:\/\/127\.0\.0\.1:\d+)\/?#(?:[^\s]*&)?token=([0-9a-f]{64})/,
          );
          if (printed) {
            clearTimeout(timer);
            resolve({ url: printed[1], key: printed[2] });
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
      // Without the key the library is refused, so another local user on a
      // shared machine cannot read it through the port.
      assert.equal((await fetch(`${url}/api/library`)).status, 403);
      const data = await (
        await fetch(`${url}/api/library`, { headers: { "X-Hindsight-Token": key } })
      ).json();
      assert.equal(data.entries[0].body, prompt);
      assert.equal(data.preferences[0].review.status, "pending");
      assert.equal(data.acceptedMarkdown, "");
      const reviewed = await fetch(`${url}/api/preferences/review`, {
        method: "POST",
        headers: {
          Origin: url,
          "Content-Type": "application/json",
          "X-Hindsight-Token": data.reviewToken,
        },
        body: JSON.stringify({
          id: data.preferences[0].id,
          revision: data.preferences[0].review.revision,
          status: "accepted",
        }),
      });
      assert.equal(reviewed.status, 200);
      const accepted = await reviewed.json();
      assert.equal(accepted.preferences[0].review.status, "accepted");
      assert(accepted.acceptedMarkdown.includes("Keep changes focused."));
      const afterReview = streams(["preferences", "--target", "opencode"]);
      assert(afterReview.stdout.includes("Keep changes focused."));
      assert(afterReview.stderr.includes("AGENTS.md"));
      const stopped = new Promise((resolve) => processHandle.once("exit", resolve));
      processHandle.kill("SIGTERM");
      await stopped;
      gui = undefined;
      console.log(
        `GUI review, accepted instruction export, and shutdown passed on ${process.version}.`,
      );
    }
  }
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("./smoke-retry.mjs", import.meta.url)),
      ...["human-hindsight", "cc-hindsight"].map((name) =>
        path.resolve(prefix, "node_modules/.bin", name),
      ),
    ],
    { stdio: "inherit", timeout: 180_000 },
  );
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("./smoke-cluster.mjs", import.meta.url)),
      ...["human-hindsight", "cc-hindsight"].map((name) =>
        path.resolve(prefix, "node_modules/.bin", name),
      ),
    ],
    { stdio: "inherit", timeout: 180_000 },
  );
} finally {
  gui?.kill("SIGKILL");
  fs.rmSync(root, { recursive: true, force: true });
}
