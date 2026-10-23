#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const compat = JSON.parse(fs.readFileSync("compat/cc-hindsight/package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));

assert.equal(pkg.name, "human-hindsight", "The main package must use the new name.");
assert.equal(compat.name, "cc-hindsight", "The compatibility package must keep the old name.");
assert.equal(compat.version, pkg.version, "Bump the compatibility package with the main package.");
assert.equal(
  compat.dependencies["human-hindsight"],
  pkg.version,
  "Pin the wrapper to this release.",
);
assert.equal(lock.name, pkg.name);
assert.equal(lock.version, pkg.version);
assert.equal(lock.packages[""].name, pkg.name);
assert.equal(lock.packages[""].version, pkg.version);
assert.deepEqual(
  lock.packages[""].engines,
  pkg.engines,
  "The development lockfile must match the runtime requirement.",
);
assert.deepEqual(
  compat.engines,
  pkg.engines,
  "The wrapper must advertise the same runtime requirement.",
);
assert.deepEqual(Object.keys(pkg.bin), ["human-hindsight"]);
assert.deepEqual(Object.keys(compat.bin), ["cc-hindsight"]);
assert.ok(
  compat.deprecated?.includes("human-hindsight"),
  "The wrapper needs a deprecation message.",
);
assert.equal(pkg.exports["./cli"], "./dist/cli.js", "The wrapper needs the public CLI entry.");

const tag = process.argv[2];
if (tag) assert.equal(tag, `v${pkg.version}`, "The release tag must match both package versions.");
if (process.env.GITHUB_REPOSITORY) {
  const expected = `git+https://github.com/${process.env.GITHUB_REPOSITORY}.git`;
  assert.equal(pkg.repository.url, expected, "Package provenance must name the publishing repo.");
  assert.equal(compat.repository.url, expected);
}
console.log(
  `Release metadata OK: human-hindsight@${pkg.version} and cc-hindsight@${compat.version}.`,
);
