import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import compatPkg from "../compat/cc-hindsight/package.json" with { type: "json" };
import pkg from "../package.json" with { type: "json" };
// @ts-expect-error The release scripts are plain JavaScript modules without types.
import * as checks from "../scripts/check-pack.mjs";

interface Entry {
  path: string;
  mode: number;
  data: Buffer;
}
const { packageProblems, readTarball, BUNDLE_BUDGET, TARBALL_BUDGET } = checks as {
  packageProblems(o: {
    entries: Entry[];
    compressedSize: number;
    compat: boolean;
    checkSyntax(kind: "bundle" | "launcher", source: string): string | undefined;
  }): string[];
  readTarball(gzipped: Buffer): Entry[];
  BUNDLE_BUDGET: number;
  TARBALL_BUDGET: number;
};

const root = path.join(import.meta.dirname, "..");
const SHEBANG = "#!/usr/bin/env node\n";

// The manifest as stage-release.mjs projects it from package.json.
const appManifest = {
  name: pkg.name,
  version: pkg.version,
  type: pkg.type,
  bin: pkg.bin,
  files: pkg.files,
  engines: pkg.engines,
  exports: pkg.exports,
};

function appEntries(
  o: {
    manifest?: Record<string, unknown>;
    files?: Record<string, string>;
    modes?: Record<string, number>;
  } = {},
): Entry[] {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ ...appManifest, ...o.manifest }),
    "README.md": "Synthetic readme.",
    LICENSE: "Synthetic license.",
    "dist/cli.js": `${SHEBANG}console.log("fixture");\n`,
    "dist/cli.d.ts": "export {};\n",
    "dist/THIRD_PARTY_NOTICES.txt": "Synthetic notices.",
    "launcher/cli.cjs": `${SHEBANG}require("fixture");\n`,
    ...o.files,
  };
  return Object.entries(files).map(([file, content]) => ({
    path: file,
    // npm marks bin targets executable when it packs.
    mode: o.modes?.[file] ?? (file === "launcher/cli.cjs" ? 0o755 : 0o644),
    data: Buffer.from(content),
  }));
}

function compatEntries(o: { manifest?: Record<string, unknown>; cli?: string } = {}): Entry[] {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ ...compatPkg, ...o.manifest }),
    "README.md": "Synthetic readme.",
    LICENSE: "Synthetic license.",
    "cli.js": o.cli ?? `${SHEBANG}require("human-hindsight/launcher/cli.cjs").run(process);\n`,
  };
  return Object.entries(files).map(([file, content]) => ({
    path: file,
    mode: file === "cli.js" ? 0o755 : 0o644,
    data: Buffer.from(content),
  }));
}

type Syntax = (kind: "bundle" | "launcher", source: string) => string | undefined;
const parses: Syntax = () => undefined;
const problems = (entries: Entry[], o: { compat?: boolean; size?: number; syntax?: Syntax } = {}) =>
  packageProblems({
    entries,
    compressedSize: o.size ?? 1000,
    compat: o.compat ?? false,
    checkSyntax: o.syntax ?? parses,
  });

describe("published manifests", () => {
  it("installs one command through the launcher and exposes only the intended subpaths", () => {
    expect(pkg.bin).toEqual({ "human-hindsight": "launcher/cli.cjs" });
    expect(pkg.files).toEqual(["dist", "launcher/cli.cjs"]);
    expect(pkg.exports).toEqual({
      "./cli": "./dist/cli.js",
      "./launcher/cli.cjs": "./launcher/cli.cjs",
      "./package.json": "./package.json",
    });
    expect(compatPkg.bin).toEqual({ "cc-hindsight": "cli.js" });
    expect(compatPkg.files).toEqual(["cli.js", "README.md", "LICENSE"]);
  });

  it("pins the compatibility package to exactly this release", () => {
    expect(compatPkg.version).toBe(pkg.version);
    expect(compatPkg.dependencies).toEqual({ "human-hindsight": pkg.version });
    // An exact version, never a range.
    expect(compatPkg.dependencies["human-hindsight"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(compatPkg.engines).toEqual(pkg.engines);
  });

  it("keeps the launcher executable in the repository and the wrapper entering it", () => {
    expect(fs.statSync(path.join(root, "launcher/cli.cjs")).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(path.join(root, "compat/cc-hindsight/cli.js"), "utf8")).toContain(
      'require("human-hindsight/launcher/cli.cjs").run(process)',
    );
  });

  it("passes the package rules for both real manifests", () => {
    expect(problems(appEntries())).toEqual([]);
    expect(problems(compatEntries(), { compat: true })).toEqual([]);
  });
});

describe("package rules", () => {
  it.each([
    "src/private.ts",
    "test/fixture.json",
    "dist/cli.js.map",
    ".github/workflows/ci.yml",
    "launcher/extra.cjs",
  ])("rejects the development file %s", (file) => {
    expect(problems(appEntries({ files: { [file]: "Must stay in the repository." } }))).toEqual([
      `unexpected files in package: ${file}`,
    ]);
  });

  it("requires every runtime file", () => {
    const entries = appEntries().filter((entry) => entry.path !== "launcher/cli.cjs");
    expect(problems(entries)).toContain("required files missing from package: launcher/cli.cjs");
  });

  it.each([
    ["dependencies", { "build-tool": "1.0.0" }, "Release contains dependencies"],
    ["devDependencies", { typescript: "1.0.0" }, "Release contains devDependencies."],
    ["optionalDependencies", { native: "1.0.0" }, "Release contains optionalDependencies."],
    ["peerDependencies", { peer: "1.0.0" }, "Release contains peerDependencies."],
    ["bundledDependencies", ["build-tool"], "Release contains bundledDependencies."],
    ["scripts", { postinstall: "echo should-not-run" }, "Release contains scripts."],
  ])("rejects %s in the manifest", (field, value, message) => {
    expect(problems(appEntries({ manifest: { [field]: value } })).join("\n")).toContain(message);
  });

  it.each([["*"], ["^2.0.0"], ["0.0.1"]])("rejects the wrapper dependency %s", (range) => {
    const entries = compatEntries({ manifest: { dependencies: { "human-hindsight": range } } });
    expect(problems(entries, { compat: true })).toEqual([
      `The wrapper must depend on exactly human-hindsight ${compatPkg.version}.`,
    ]);
  });

  it("rejects a wrapper that skips the launcher", () => {
    const entries = compatEntries({ cli: `${SHEBANG}import("human-hindsight/cli");\n` });
    expect(problems(entries, { compat: true })).toEqual([
      "The wrapper must enter human-hindsight/launcher/cli.cjs.",
    ]);
  });

  it("requires the installed commands to be executable with a shebang", () => {
    expect(problems(appEntries({ modes: { "launcher/cli.cjs": 0o644 } }))).toEqual([
      "launcher/cli.cjs is not executable in the tarball.",
    ]);
    expect(problems(appEntries({ files: { "launcher/cli.cjs": "require('x');\n" } }))).toEqual([
      "launcher/cli.cjs lost its executable shebang.",
    ]);
  });

  it.each([
    [
      { bin: { "human-hindsight": "dist/cli.js" } },
      'bin must be {"human-hindsight":"launcher/cli.cjs"}.',
    ],
    [{ files: ["dist"] }, 'files must be ["dist", "launcher/cli.cjs"].'],
    [
      { exports: { ...pkg.exports, "./launcher/cli.cjs": undefined } },
      'exports["./launcher/cli.cjs"] must be ./launcher/cli.cjs.',
    ],
    [
      { exports: { ...pkg.exports, "./src": "./src/main.ts" } },
      "exports points at ./src/main.ts, which is not in the package.",
    ],
  ])("keeps bin, files, and exports consistent", (manifest, message) => {
    expect(problems(appEntries({ manifest }))).toContain(message);
  });

  it.each([
    ['console.log("missing shebang");\n', "The minified CLI lost its executable shebang."],
    [
      `${SHEBANG}//# sourceMappingURL=data:application/json;base64,e30=\n`,
      "Do not ship development source maps in the CLI.",
    ],
  ])("rejects an unusable or development bundle", (cli, message) => {
    expect(problems(appEntries({ files: { "dist/cli.js": cli } }))).toEqual([message]);
  });

  it("reports the syntax checks for the bundle and the launcher separately", () => {
    const syntax = (kind: string) => `SyntaxError: in the ${kind}`;
    expect(problems(appEntries(), { syntax })).toEqual([
      "dist/cli.js does not parse: SyntaxError: in the bundle",
      "launcher/cli.cjs does not parse on old Node: SyntaxError: in the launcher",
    ]);
  });

  it("enforces both size budgets at their boundaries", () => {
    const bundle = (bytes: number) => ({
      "dist/cli.js": `${SHEBANG}${"x".repeat(bytes - SHEBANG.length)}`,
    });
    expect(problems(appEntries({ files: bundle(BUNDLE_BUDGET - 1) }))).toEqual([]);
    expect(problems(appEntries({ files: bundle(BUNDLE_BUDGET) }))[0]).toContain(
      "uncompressed size budget",
    );
    expect(problems(appEntries(), { size: TARBALL_BUDGET - 1 })).toEqual([]);
    expect(problems(appEntries(), { size: TARBALL_BUDGET })[0]).toContain("compressed size budget");
  });
});

// A minimal ustar writer, enough to prove the reader sees paths and modes.
function tarball(files: { name: string; mode: number; data: string; pax?: string }[]): Buffer {
  const blocks: Buffer[] = [];
  const header = (name: string, mode: number, size: number, type: string) => {
    const block = Buffer.alloc(512);
    block.write(name.slice(0, 99), 0);
    block.write(`${mode.toString(8).padStart(6, "0")} \0`, 100);
    block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
    block.write(type, 156);
    block.write("ustar\0", 257);
    return block;
  };
  const body = (data: Buffer) =>
    Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
  for (const file of files) {
    if (file.pax) {
      const record = ` path=${file.pax}\n`;
      const line = `${record.length + String(record.length + 2).length}${record}`;
      blocks.push(header("PaxHeader", 0o644, line.length, "x"), body(Buffer.from(line)));
    }
    const data = Buffer.from(file.data);
    blocks.push(header(file.name, file.mode, data.length, "0"), body(data));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

describe("tarball reader", () => {
  it("reads paths without the package folder, modes, contents, and long pax names", () => {
    const long = `package/dist/${"n".repeat(120)}.txt`;
    const entries = readTarball(
      tarball([
        { name: "package/launcher/cli.cjs", mode: 0o755, data: "launcher" },
        { name: "package/README.md", mode: 0o644, data: "readme" },
        { name: "package/short-name", mode: 0o644, data: "long", pax: long },
      ]),
    );
    expect(entries.map((e) => [e.path, e.mode.toString(8), e.data.toString()])).toEqual([
      ["launcher/cli.cjs", "755", "launcher"],
      ["README.md", "644", "readme"],
      [long.replace("package/", ""), "644", "long"],
    ]);
  });
});
