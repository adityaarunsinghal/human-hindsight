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
assert.equal(pkg.exports["./cli"], "./dist/cli.js", "Keep the public CLI module available.");
assert.equal(
  pkg.bin["human-hindsight"],
  "launcher/cli.cjs",
  "Install the command through the launcher.",
);
assert.equal(
  pkg.exports["./launcher/cli.cjs"],
  "./launcher/cli.cjs",
  "The wrapper enters the launcher.",
);

// .node-version pins the exact Node used to build, test, and publish. It stays
// exact because asdf reads only exact versions from it by default, and it must
// satisfy the build tools: tsdown needs ^22.18.0 || >=24.11.0. Checking tsdown's
// own field catches a tool upgrade that raises the floor.
const devNode = fs.readFileSync(".node-version", "utf8").trim();
const devRelease = /^(\d+)\.(\d+)\.(\d+)$/.exec(devNode);
assert.ok(devRelease, `.node-version must pin an exact version, not ${JSON.stringify(devNode)}.`);
const [devMajor, devMinor] = [Number(devRelease[1]), Number(devRelease[2])];
assert.equal(
  JSON.parse(fs.readFileSync("node_modules/tsdown/package.json", "utf8")).engines.node,
  "^22.18.0 || >=24.11.0",
  "The build tool's Node requirement changed; update this check and .node-version together.",
);
assert.ok(
  (devMajor === 22 && devMinor >= 18) || (devMajor === 24 && devMinor >= 11) || devMajor > 24,
  `.node-version ${devNode} is older than the build tools need (22.18+ or 24.11+).`,
);

const tag = process.argv[2];
if (tag) assert.equal(tag, `v${pkg.version}`, "The release tag must match both package versions.");
if (process.env.GITHUB_REPOSITORY) {
  const expected = `git+https://github.com/${process.env.GITHUB_REPOSITORY}.git`;
  assert.equal(pkg.repository.url, expected, "Package provenance must name the publishing repo.");
  assert.equal(compat.repository.url, expected);
}
console.log(
  `Release metadata OK: human-hindsight@${pkg.version} and cc-hindsight@${compat.version}; build Node ${devNode}.`,
);
