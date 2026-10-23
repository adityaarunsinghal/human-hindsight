import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// Reproduce the registry/npx path that the old local-tarball check missed.
// Any request for a transitive dependency is a test failure.
const directory = path.resolve(process.argv[2] ?? ".release/packages");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-npx-"));
const packages = new Map();
for (const file of fs.readdirSync(directory).filter((file) => file.endsWith(".tgz"))) {
  const archive = path.join(directory, file);
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" }),
  );
  const bytes = fs.readFileSync(archive);
  packages.set(manifest.name, {
    file,
    manifest,
    bytes,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  });
}
assert.equal(packages.size, 2);
const requests = [];
let url = "";
const server = http.createServer((req, res) => {
  const route = new URL(req.url, url).pathname;
  requests.push(route);
  for (const [name, pkg] of packages) {
    if (
      route === `/${name}` ||
      route === `/${name}/${pkg.manifest.version}` ||
      route === `/${name}/latest`
    ) {
      const version = {
        ...pkg.manifest,
        dist: { tarball: `${url}/${name}/-/${pkg.file}`, integrity: pkg.integrity },
      };
      const data =
        route === `/${name}`
          ? {
              name,
              "dist-tags": { latest: pkg.manifest.version },
              versions: { [pkg.manifest.version]: version },
            }
          : version;
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
      return;
    }
    if (route === `/${name}/-/${pkg.file}`) {
      res
        .writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": pkg.bytes.length,
        })
        .end(pkg.bytes);
      return;
    }
  }
  res
    .writeHead(404, { "Content-Type": "application/json" })
    .end('{"error":"Unexpected dependency request"}');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
url = `http://127.0.0.1:${server.address().port}`;
fs.writeFileSync(path.join(root, "npmrc"), "");
const env = {
  ...process.env,
  NPM_CONFIG_USERCONFIG: path.join(root, "npmrc"),
  NPM_CONFIG_REGISTRY: url,
  NPM_CONFIG_CACHE: path.join(root, "cache"),
  NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_FUND: "false",
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
  NODE_PATH: "",
};
function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.stdout.setEncoding("utf8").on("data", (text) => {
      stdout += text;
    });
    child.stderr.setEncoding("utf8").on("data", (text) => {
      stderr += text;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`${bin} exited ${code}: ${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
}
function installedNames(directory) {
  return fs
    .readdirSync(directory)
    .filter((name) => !name.startsWith("."))
    .sort();
}
try {
  const npx = await run("npm", [
    "exec",
    "--yes",
    "--package=human-hindsight@latest",
    "--",
    "human-hindsight",
    "--version",
  ]);
  assert.equal(npx.stdout.trim(), packages.get("human-hindsight").manifest.version);
  assert(!/tarball|corrupt|lightningcss|rolldown|biome/i.test(npx.stderr), npx.stderr);
  const npxDirectories = fs.readdirSync(path.join(root, "cache/_npx"));
  assert.equal(npxDirectories.length, 1);
  assert.deepEqual(
    installedNames(path.join(root, "cache/_npx", npxDirectories[0], "node_modules")),
    ["human-hindsight"],
  );
  const prefix = path.join(root, "installed");
  await run("npm", ["install", "--prefix", prefix, "cc-hindsight@latest"]);
  assert.deepEqual(installedNames(path.join(prefix, "node_modules")), [
    "cc-hindsight",
    "human-hindsight",
  ]);
  const smoke = await run(process.execPath, [path.resolve("scripts/smoke-runtime.mjs"), prefix]);
  console.log(smoke.stdout.trim());
  assert(
    requests.every(
      (route) => route.startsWith("/human-hindsight") || route.startsWith("/cc-hindsight"),
    ),
    JSON.stringify(requests),
  );
  console.log(
    `Registry-style npx install passed: one app package; compatibility install: two packages; no build-tool downloads.`,
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
