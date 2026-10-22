#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// A resumed workflow can finish the wrapper after the main package was
// published. Only skip an existing version when it came from this exact commit.
assert.equal(
  process.env.GITHUB_ACTIONS,
  "true",
  "Release publications run through GitHub Actions.",
);
const commit = process.env.GITHUB_SHA;
assert.ok(commit, "Missing publishing commit.");
const dir = path.resolve(process.argv[2] ?? ".");
const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
assert.ok(["human-hindsight", "cc-hindsight"].includes(pkg.name), "Unexpected package name.");
assert.equal(
  path.basename(path.dirname(dir)),
  ".release",
  "Publish only the staged release package.",
);
assert.ok(!pkg.scripts && !pkg.devDependencies, "Development metadata must not be published.");
assert.equal(pkg.gitHead, commit, "The staged package must come from the publishing commit.");
if (pkg.name === "human-hindsight")
  assert.deepEqual(pkg.dependencies ?? {}, {}, "The CLI must be self-contained.");
const url = new URL(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`);
url.searchParams.set("release", commit);
const response = await fetch(url, {
  headers: { "Cache-Control": "no-cache", Accept: "application/json" },
});

if (response.ok) {
  const published = await response.json();
  assert.equal(published.gitHead, commit, `${pkg.name}@${pkg.version} belongs to another commit.`);
  assert.equal(
    published.repository?.url,
    pkg.repository.url,
    "Published repository does not match.",
  );
  console.log(`${pkg.name}@${pkg.version} is already published from this commit; continuing.`);
} else {
  assert.equal(
    response.status,
    404,
    `Cannot check the registry (${response.status}); not publishing.`,
  );
  const result = spawnSync("npm", ["publish", "--provenance", "--access", "public"], {
    cwd: dir,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
