import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function checkPackage(
  options: {
    manifest?: Record<string, unknown>;
    cli?: string;
    extraFiles?: Record<string, string>;
    compat?: boolean;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-pack-check-"));
  roots.push(root);
  const directory = path.join(root, "package");
  fs.mkdirSync(directory);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: options.compat ? "cc-hindsight" : "human-hindsight",
      version: "1.0.0",
      type: "module",
      ...(options.compat ? { dependencies: { "human-hindsight": "1.0.0" } } : {}),
      ...options.manifest,
    }),
    "README.md": "Synthetic package fixture.",
    LICENSE: "Synthetic license fixture.",
    ...(options.compat
      ? { "cli.js": '#!/usr/bin/env node\nimport "human-hindsight/cli";\n' }
      : {
          "dist/cli.js": options.cli ?? '#!/usr/bin/env node\nconsole.log("fixture");\n',
          "dist/THIRD_PARTY_NOTICES.txt": "Synthetic dependency notices.",
        }),
    ...options.extraFiles,
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const archive = path.join(root, "package.tgz");
  const packed = spawnSync("tar", ["-czf", archive, "-C", root, "package"], {
    encoding: "utf8",
  });
  if (packed.status !== 0) throw new Error(`Could not create synthetic tarball: ${packed.stderr}`);
  const report = path.join(root, "pack.json");
  fs.writeFileSync(
    report,
    JSON.stringify([
      {
        filename: "package.tgz",
        size: fs.statSync(archive).size,
        files: Object.keys(files).map((file) => ({ path: file })),
      },
    ]),
  );
  return spawnSync(
    process.execPath,
    [path.resolve("scripts/check-pack.mjs"), report, ...(options.compat ? ["--compat"] : [])],
    { encoding: "utf8" },
  );
}

describe("publishable package boundary", () => {
  it("accepts a runnable self-contained package and the thin compatibility wrapper", () => {
    expect(checkPackage().status).toBe(0);
    expect(checkPackage({ compat: true }).status).toBe(0);
  });

  it.each([
    "src/private.ts",
    "test/fixture.json",
    "dist/cli.js.map",
    ".github/workflows/ci.yml",
  ])("rejects the development file %s even when npm reports it in an otherwise valid tarball", (file) => {
    const result = checkPackage({ extraFiles: { [file]: "Must stay in GitHub." } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unexpected files in package");
  });

  it("rejects runtime dependency resolution for the main application", () => {
    const result = checkPackage({ manifest: { dependencies: { "build-tool": "1.0.0" } } });
    expect(result.status).not.toBe(0);
  });

  it.each([
    ["devDependencies", { typescript: "1.0.0" }],
    ["optionalDependencies", { native: "1.0.0" }],
    ["peerDependencies", { peer: "1.0.0" }],
    ["bundledDependencies", ["build-tool"]],
    ["scripts", { postinstall: "echo should-not-run" }],
  ])("rejects %s from the actual manifest", (field, value) => {
    const result = checkPackage({ manifest: { [field]: value } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Release contains ${field}`);
  });

  it("requires the compatibility wrapper to pin the matching application version", () => {
    const result = checkPackage({
      compat: true,
      manifest: { dependencies: { "human-hindsight": "*" } },
    });
    expect(result.status).not.toBe(0);
  });

  it.each([
    ['console.log("missing shebang");\n', "executable shebang"],
    ["#!/usr/bin/env node\nconst broken = ;\n", "SyntaxError"],
    [
      "#!/usr/bin/env node\n//# sourceMappingURL=data:application/json;base64,e30=\n",
      "development source maps",
    ],
  ])("rejects an unusable or development CLI bundle", (cli, error) => {
    const result = checkPackage({ cli });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(error);
  });

  it("enforces the compressed download budget across the whole tarball", () => {
    const result = checkPackage({
      extraFiles: { "README.md": randomBytes(300_000).toString("base64") },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("compressed size budget");
  });

  it("catches an oversized runtime even when repetitive source compresses well", () => {
    const result = checkPackage({
      cli: `#!/usr/bin/env node\n/*${"unminified padding ".repeat(30_000)}*/\nconsole.log("fixture");\n`,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("uncompressed size budget");
  });
});
