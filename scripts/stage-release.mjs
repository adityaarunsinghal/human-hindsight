import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Publish a projection of the package, never the development workspace.
// The resulting app has no dependency resolution or lifecycle scripts at install.
const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
assert.equal(pkg.name, "human-hindsight", "Stage releases from the Human Hindsight repository.");
const staging = path.join(root, ".release");
const app = path.join(staging, "human-hindsight");
const compat = path.join(staging, "cc-hindsight");
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(app, { recursive: true });
fs.mkdirSync(compat, { recursive: true });
const fields = [
  "name",
  "version",
  "description",
  "type",
  "author",
  "license",
  "keywords",
  "repository",
  "homepage",
  "bugs",
  "bin",
  "engines",
  "exports",
];
const manifest = Object.fromEntries(
  fields.filter((field) => pkg[field] !== undefined).map((field) => [field, pkg[field]]),
);
manifest.gitHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
manifest.bin = { "human-hindsight": "dist/cli.js" };
manifest.files = ["dist"];
for (const file of ["cli.js", "cli.d.ts", "THIRD_PARTY_NOTICES.txt"]) {
  assert(
    fs.existsSync(path.join("dist", file)),
    `Run npm run build before staging (${file} missing).`,
  );
}
fs.cpSync("dist", path.join(app, "dist"), { recursive: true });
fs.writeFileSync(path.join(app, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
for (const file of ["README.md", "LICENSE"]) fs.copyFileSync(file, path.join(app, file));
for (const file of ["package.json", "cli.js", "README.md", "LICENSE"]) {
  fs.copyFileSync(path.join("compat/cc-hindsight", file), path.join(compat, file));
}
const wrapper = JSON.parse(fs.readFileSync(path.join(compat, "package.json"), "utf8"));
wrapper.bin = { "cc-hindsight": "cli.js" };
wrapper.gitHead = manifest.gitHead;
assert.equal(wrapper.version, pkg.version);
assert.equal(wrapper.dependencies["human-hindsight"], pkg.version);
fs.writeFileSync(path.join(compat, "package.json"), `${JSON.stringify(wrapper, null, 2)}\n`);
console.log(`Staged ${pkg.name}@${pkg.version} with zero npm dependencies and no install scripts.`);
