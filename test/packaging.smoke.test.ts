import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import compatPkg from "../compat/cc-hindsight/package.json" with { type: "json" };
import pkg from "../package.json" with { type: "json" };

// Smoke tier: runs scripts/check-pack.mjs as a process on real tarballs, so the
// syntax checks use a real `node --check`. The rules themselves are unit tested
// in test/packaging.test.ts.
//
// HUMAN_HINDSIGHT_OLDEST_NODE names a Node 18 binary. CI always sets it; a
// local run without it skips the cases that need it.
const oldest = process.env.HUMAN_HINDSIGHT_OLDEST_NODE;
const needsOldest = !oldest && !process.env.CI;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const SHEBANG = "#!/usr/bin/env node\n";

function check(
  o: {
    compat?: boolean;
    files?: Record<string, string>;
    env?: Record<string, string | undefined>;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-pack-check-"));
  roots.push(root);
  const directory = path.join(root, "package");
  const files: Record<string, string> = o.compat
    ? {
        "package.json": JSON.stringify(compatPkg),
        "cli.js": `${SHEBANG}require("human-hindsight/launcher/cli.cjs").run(process);\n`,
        "README.md": "Synthetic readme.",
        LICENSE: "Synthetic license.",
      }
    : {
        "package.json": JSON.stringify({
          name: pkg.name,
          version: pkg.version,
          type: pkg.type,
          bin: pkg.bin,
          files: pkg.files,
          exports: pkg.exports,
        }),
        "dist/cli.js": `${SHEBANG}console.log("fixture");\n`,
        "dist/THIRD_PARTY_NOTICES.txt": "Synthetic notices.",
        "launcher/cli.cjs": fs.readFileSync(path.resolve("launcher/cli.cjs"), "utf8"),
        "README.md": "Synthetic readme.",
        LICENSE: "Synthetic license.",
      };
  Object.assign(files, o.files);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    if (name === "launcher/cli.cjs" || name === "cli.js") fs.chmodSync(file, 0o755);
  }
  const archive = path.join(root, "package.tgz");
  const packed = spawnSync("tar", ["-czf", archive, "-C", root, "package"], {
    encoding: "utf8",
    // macOS tar would otherwise add AppleDouble files for extended attributes.
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (packed.status !== 0) throw new Error(`Could not create synthetic tarball: ${packed.stderr}`);
  const report = path.join(root, "pack.json");
  fs.writeFileSync(report, JSON.stringify([{ filename: "package.tgz" }]));
  return spawnSync(
    process.execPath,
    [path.resolve("scripts/check-pack.mjs"), report, ...(o.compat ? ["--compat"] : [])],
    {
      encoding: "utf8",
      env: { ...process.env, CI: "", HUMAN_HINDSIGHT_OLDEST_NODE: oldest, ...o.env },
    },
  );
}

describe("check-pack.mjs on real tarballs", () => {
  it("accepts the application with the real launcher, and the wrapper", () => {
    const app = check();
    expect(app.stderr).toBe("");
    expect(app.status).toBe(0);
    expect(app.stdout).toMatch(
      /package contents OK \(6 files, all expected; tarball \d+ of \d+ bytes/,
    );
    const wrapper = check({ compat: true });
    expect(wrapper.status).toBe(0);
  });

  it("rejects a bundle that does not parse, naming the SyntaxError", () => {
    const result = check({ files: { "dist/cli.js": `${SHEBANG}const broken = ;\n` } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dist/cli.js does not parse: SyntaxError");
  });

  it.skipIf(needsOldest)("rejects launcher syntax newer than Node 18 accepts", () => {
    // The `v` regular expression flag parses on current Node but not on Node 18.
    const result = check({ files: { "launcher/cli.cjs": `${SHEBANG}const pattern = /a/v;\n` } });
    expect(result.stderr).toContain("launcher/cli.cjs does not parse on old Node: SyntaxError");
    expect(result.status).toBe(1);
    expect(check().stdout).toMatch(/launcher parses on Node 18\./);
  });

  it("refuses an oldest-Node binary that is not old, and requires one in CI", () => {
    const tooNew = check({ env: { HUMAN_HINDSIGHT_OLDEST_NODE: process.execPath } });
    expect(tooNew.status).toBe(1);
    expect(tooNew.stderr).toContain("HUMAN_HINDSIGHT_OLDEST_NODE must be Node 18 or older");
    const missing = check({ env: { CI: "true", HUMAN_HINDSIGHT_OLDEST_NODE: undefined } });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("Set HUMAN_HINDSIGHT_OLDEST_NODE");
    const local = check({ env: { HUMAN_HINDSIGHT_OLDEST_NODE: undefined } });
    expect(local.status).toBe(0);
    expect(local.stdout).toContain("launcher not checked on old Node");
  });
});
