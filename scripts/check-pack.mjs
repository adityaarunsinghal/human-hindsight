#!/usr/bin/env node
// Check one packed release tarball before it can be installed or published.
//
//   node scripts/check-pack.mjs <npm-pack-json> [--compat]
//
// The rules read the tarball itself (paths, modes, contents), not npm's report,
// so they see exactly what a person downloads. The decisions are pure functions
// exported for test/packaging.test.ts; the shell at the bottom reads files and
// runs `node --check`.
//
// The launcher syntax check runs `node --check` with the Node binary named by
// HUMAN_HINDSIGHT_OLDEST_NODE, which must be Node 18 or older: launcher/cli.cjs
// promises to parse there and print its upgrade message. CI sets the variable
// and the check is then required; a local run without it says the check was
// skipped.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

// Uncompressed budget for dist/cli.js, in bytes, and the compressed budget for
// the whole tarball. Raise either one deliberately, with a row below.
//
//   release  dist/cli.js  budget   reason
//   1.8.5      490,584    500_000  baseline (budget set in 1.8.1)
//   2.0.0      774,220    790_000  Kiro Crew source and the kiro-cli 3.x runner;
//                                  suggest-subagents (prompts, checks, renderer,
//                                  zip writer, export, browser tab); guided
//                                  first run, doctor, help pages; runner pool
//                                  and model plans; working agreements and
//                                  overviews in the browser; the Start
//                                  question, outcome marks, option checks
//                                  (tarball about 272,060 of 280_000 bytes
//                                  compressed; it varies by a byte or two per pack)
//   2.1.0      ~793 kB    800_000  Runner selection, reflection reader and saved-read summaries.
//                                  Compressed package budget remains 280_000 bytes.
//   2.1.1      ~801 kB    805_000  Live local library, incremental preferences and terminal pills.
export const BUNDLE_BUDGET = 805_000;
export const TARBALL_BUDGET = 280_000;

// The oldest Node the launcher is checked against.
const OLDEST_NODE_MAJOR = 18;

const APP_FILES = [
  "dist/cli.js",
  "dist/cli.d.ts",
  "dist/THIRD_PARTY_NOTICES.txt",
  "launcher/cli.cjs",
  "package.json",
  "README.md",
  "LICENSE",
];
const APP_REQUIRED = APP_FILES.filter((file) => file !== "dist/cli.d.ts");
const COMPAT_FILES = ["cli.js", "package.json", "README.md", "LICENSE"];
const LAUNCHER = "launcher/cli.cjs";
const SHEBANG = "#!/usr/bin/env node\n";

/**
 * Read a gzipped npm tarball into entries `{ path, mode, type, data }`, with
 * the leading `package/` removed. Handles plain ustar headers, the pax
 * `path` records npm writes for long names, and GNU long names.
 */
export function readTarball(gzipped) {
  const tar = gunzipSync(gzipped);
  const entries = [];
  let offset = 0;
  let longPath;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1) || "0";
    const data = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    // Metadata records: a pax header for the next entry (npm), a GNU long
    // name, or a global pax header, which names no file.
    if (type === "x") {
      const match = /\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
      longPath = match ? match[1] : undefined;
      continue;
    }
    if (type === "L") {
      longPath = data.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (type === "g") continue;
    const prefix = field(345, 155);
    const name = longPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longPath = undefined;
    entries.push({
      path: name.replace(/^package\//, ""),
      mode: Number.parseInt(field(100, 8).trim() || "0", 8),
      type: type === "5" ? "directory" : "file",
      data: Buffer.from(data),
    });
  }
  return entries.filter((entry) => entry.type === "file");
}

/**
 * Every problem with one tarball, as plain sentences; an empty list passes.
 *
 * `entries` come from readTarball. `checkSyntax(kind, source)` returns an error
 * message or undefined: kind "bundle" is the ES module bundle on the running
 * Node, kind "launcher" is launcher/cli.cjs on the oldest Node.
 */
export function packageProblems({ entries, compressedSize, compat, checkSyntax }) {
  const problems = [];
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const text = (file) => byPath.get(file)?.data.toString("utf8");
  const manifestText = text("package.json");
  if (manifestText === undefined) return ["package.json missing from package."];
  const manifest = JSON.parse(manifestText);

  // Exactly the allowed files, and every required one.
  const allowed = compat ? COMPAT_FILES : APP_FILES;
  const required = compat ? COMPAT_FILES : APP_REQUIRED;
  const unexpected = [...byPath.keys()].filter((file) => !allowed.includes(file)).sort();
  const missing = required.filter((file) => !byPath.has(file));
  if (unexpected.length) problems.push(`unexpected files in package: ${unexpected.join(", ")}`);
  if (missing.length) problems.push(`required files missing from package: ${missing.join(", ")}`);

  // No install-time resolution or scripts. The wrapper pins the exact release.
  const expectedDependencies = compat ? { "human-hindsight": manifest.version } : {};
  if (JSON.stringify(manifest.dependencies ?? {}) !== JSON.stringify(expectedDependencies)) {
    problems.push(
      compat
        ? `The wrapper must depend on exactly human-hindsight ${manifest.version}.`
        : "Release contains dependencies; the application must be self-contained.",
    );
  }
  for (const field of [
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundledDependencies",
    "bundleDependencies",
    "scripts",
  ]) {
    const value = manifest[field];
    if (value && Object.keys(value).length > 0) problems.push(`Release contains ${field}.`);
  }

  // bin, files, and exports agree with each other and with the tarball.
  const expectedBin = compat ? { "cc-hindsight": "cli.js" } : { "human-hindsight": LAUNCHER };
  const bin = Object.fromEntries(
    Object.entries(manifest.bin ?? {}).map(([name, file]) => [name, file.replace(/^\.\//, "")]),
  );
  if (JSON.stringify(bin) !== JSON.stringify(expectedBin)) {
    problems.push(`bin must be ${JSON.stringify(expectedBin)}.`);
  }
  for (const file of Object.values(bin)) {
    const entry = byPath.get(file);
    if (!entry) continue;
    if ((entry.mode & 0o111) === 0) problems.push(`${file} is not executable in the tarball.`);
    if (!entry.data.toString("utf8").startsWith(SHEBANG)) {
      problems.push(`${file} lost its executable shebang.`);
    }
  }
  if (!compat) {
    const files = manifest.files ?? [];
    if (JSON.stringify(files) !== JSON.stringify(["dist", LAUNCHER])) {
      problems.push(`files must be ["dist", "${LAUNCHER}"].`);
    }
    const exportsField = manifest.exports ?? {};
    for (const [subpath, target] of Object.entries({
      "./cli": "./dist/cli.js",
      [`./${LAUNCHER}`]: `./${LAUNCHER}`,
      "./package.json": "./package.json",
    })) {
      if (exportsField[subpath] !== target)
        problems.push(`exports["${subpath}"] must be ${target}.`);
    }
    for (const target of Object.values(exportsField)) {
      if (typeof target === "string" && !byPath.has(target.replace(/^\.\//, ""))) {
        problems.push(`exports points at ${target}, which is not in the package.`);
      }
    }
  }

  // The runtime bundle: the module the launcher imports.
  if (!compat && byPath.has("dist/cli.js")) {
    const cli = text("dist/cli.js");
    if (!cli.startsWith(SHEBANG)) problems.push("The minified CLI lost its executable shebang.");
    if (cli.includes("sourceMappingURL=")) {
      problems.push("Do not ship development source maps in the CLI.");
    }
    const bundleError = checkSyntax("bundle", cli);
    if (bundleError) problems.push(`dist/cli.js does not parse: ${bundleError}`);
    if (Buffer.byteLength(cli) >= BUNDLE_BUDGET) {
      problems.push(
        `The minified runtime bundle exceeded its uncompressed size budget (${Buffer.byteLength(cli)} of ${BUNDLE_BUDGET} bytes).`,
      );
    }
  }
  if (!compat && byPath.has(LAUNCHER)) {
    const launcherError = checkSyntax("launcher", text(LAUNCHER));
    if (launcherError) problems.push(`${LAUNCHER} does not parse on old Node: ${launcherError}`);
  }
  if (
    compat &&
    byPath.has("cli.js") &&
    !text("cli.js").includes("human-hindsight/launcher/cli.cjs")
  ) {
    problems.push("The wrapper must enter human-hindsight/launcher/cli.cjs.");
  }
  if (compressedSize >= TARBALL_BUDGET) {
    problems.push(
      `The package exceeded its compressed size budget (${compressedSize} of ${TARBALL_BUDGET} bytes).`,
    );
  }
  return problems;
}

// ----- shell -----

/** First line of a failed `node --check`, such as "SyntaxError: Unexpected token". */
function syntaxError(result) {
  if (result.error) return result.error.message;
  if (result.status === 0) return undefined;
  const lines = `${result.stderr}`.split("\n").map((line) => line.trim());
  return (
    lines.find((line) => /^\w*Error\b/.test(line)) ?? (lines.find(Boolean) || "exit code nonzero")
  );
}

function nodeCheck(node, source, extension, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-check-"));
  try {
    const file = path.join(dir, `check${extension}`);
    fs.writeFileSync(file, source);
    return syntaxError(spawnSync(node, [...args, "--check", file], { encoding: "utf8" }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The oldest-Node binary to check the launcher with, after confirming its version. */
function oldestNode(env) {
  const node = env.HUMAN_HINDSIGHT_OLDEST_NODE;
  if (!node) {
    if (env.CI) {
      throw new Error(
        `Set HUMAN_HINDSIGHT_OLDEST_NODE to a Node ${OLDEST_NODE_MAJOR} binary to check the launcher.`,
      );
    }
    return undefined;
  }
  const result = spawnSync(node, ["-p", "process.versions.node"], { encoding: "utf8" });
  const major = Number(`${result.stdout}`.split(".")[0]);
  if (result.status !== 0 || !(major <= OLDEST_NODE_MAJOR)) {
    throw new Error(
      `HUMAN_HINDSIGHT_OLDEST_NODE must be Node ${OLDEST_NODE_MAJOR} or older; ${node} reported ${`${result.stdout}`.trim() || "nothing"}.`,
    );
  }
  return { node, version: `${result.stdout}`.trim() };
}

function main(argv, env) {
  const input = argv[0];
  if (!input) {
    console.error("usage: check-pack.mjs <npm-pack-json> [--compat]");
    return 1;
  }
  const compat = argv.includes("--compat");
  const report = JSON.parse(fs.readFileSync(input, "utf8"))[0];
  const tarball = path.resolve(path.dirname(input), report.filename);
  if (!fs.existsSync(tarball)) {
    console.error("Check an actual packed tarball, not --dry-run output.");
    return 1;
  }
  const gzipped = fs.readFileSync(tarball);
  const entries = readTarball(gzipped);
  const old = compat ? undefined : oldestNode(env);
  const problems = packageProblems({
    entries,
    compressedSize: gzipped.length,
    compat,
    checkSyntax(kind, source) {
      if (kind === "bundle") return nodeCheck(process.execPath, source, ".mjs");
      // Parse with the running Node too, so a local run without the oldest Node
      // still rejects a broken launcher.
      return (
        nodeCheck(process.execPath, source, ".cjs") ?? (old && nodeCheck(old.node, source, ".cjs"))
      );
    },
  });
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    return 1;
  }
  const launcherNote = compat
    ? ""
    : old
      ? `; launcher parses on Node ${old.version}`
      : "; launcher not checked on old Node (set HUMAN_HINDSIGHT_OLDEST_NODE)";
  const sizes = compat
    ? ""
    : `, bundle ${Buffer.byteLength(entries.find((e) => e.path === "dist/cli.js").data)} of ${BUNDLE_BUDGET} bytes`;
  console.log(
    `package contents OK (${entries.length} files, all expected; tarball ${gzipped.length} of ${TARBALL_BUDGET} bytes${sizes}${launcherNote}).`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
