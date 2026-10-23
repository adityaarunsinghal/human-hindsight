#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
/**
 * scripts/check-pack.mjs — assert the npm tarball contains exactly what we
 * intend to ship. Trust story: a user auditing the package should find
 * dist + metadata, never source, tests, fixtures, or CI config.
 *
 * Usage: node scripts/pack-release.mjs (packs and checks both staged packages).
 */
import fs from "node:fs";
import path from "node:path";

const input = process.argv[2];
if (!input) {
  console.error("usage: check-pack.mjs <pack-json-file>");
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(input, "utf8"));
const files = report[0].files.map((f) => f.path).sort();
const compat = process.argv[3] === "--compat";

// Everything shipped must match one of these.
const allowed = compat
  ? [/^cli\.js$/, /^package\.json$/, /^README\.md$/, /^LICENSE$/]
  : [
      /^dist\/(?:cli\.js|cli\.d\.ts|THIRD_PARTY_NOTICES\.txt)$/,
      /^package\.json$/,
      /^README\.md$/,
      /^LICENSE$/,
    ];
// These must be present for the package to work / be trustworthy.
const required = compat
  ? ["cli.js", "package.json", "README.md", "LICENSE"]
  : ["dist/cli.js", "package.json", "dist/THIRD_PARTY_NOTICES.txt", "README.md", "LICENSE"];

const unexpected = files.filter((f) => !allowed.some((re) => re.test(f)));
const missing = required.filter((r) => !files.includes(r));

if (unexpected.length > 0) {
  console.error(`unexpected files in package:\n  ${unexpected.join("\n  ")}`);
}
if (missing.length > 0) {
  console.error(`required files missing from package:\n  ${missing.join("\n  ")}`);
}
if (unexpected.length > 0 || missing.length > 0) process.exit(1);

// Checking filenames alone missed the 1.7 shrinkwrap bringing build tools into
// npx installs. Inspect the actual published manifest, not the source manifest.
const tarball = path.resolve(path.dirname(input), report[0].filename);
assert(fs.existsSync(tarball), "Check an actual packed tarball, not --dry-run output.");
const manifest = JSON.parse(
  execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }),
);
assert.deepEqual(
  manifest.dependencies ?? {},
  compat ? { "human-hindsight": manifest.version } : {},
);
for (const field of [
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundledDependencies",
  "bundleDependencies",
  "scripts",
]) {
  assert(
    !manifest[field] || Object.keys(manifest[field]).length === 0,
    `Release contains ${field}`,
  );
}
if (!compat)
  assert(report[0].size < 600_000, "The bundled CLI exceeded its compressed size budget.");
console.log(`package contents OK (${files.length} files, all expected).`);
