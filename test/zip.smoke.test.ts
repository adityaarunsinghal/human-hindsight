/**
 * Smoke tier: starts a Python process to read an archive the zip writer made.
 * Kept out of the unit tier because it spawns a child process.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { zipStore } from "../src/core/zip.js";

const python = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;

describe("store-only zip, read by another implementation", () => {
  it.skipIf(!python)("is readable by Python's zipfile module", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-zip-"));
    try {
      const file = path.join(dir, "tree.zip");
      fs.writeFileSync(
        file,
        zipStore(
          new Map([
            ["README.md", "# Tree\n"],
            ["kirocrew/create-bots.sh", "#!/usr/bin/env sh\n"],
            ["ünïcode.md", "ü"],
          ]),
        ),
      );
      const script = [
        "import json, sys, zipfile",
        "z = zipfile.ZipFile(sys.argv[1])",
        "assert z.testzip() is None",
        "print(json.dumps({i.filename: [z.read(i).decode('utf-8'), i.external_attr >> 16] for i in z.infolist()}))",
      ].join("\n");
      const result = spawnSync("python3", ["-c", script, file], { encoding: "utf8" });
      expect(result.stderr).toBe("");
      // Contents, and the Unix mode another reader applies on extraction.
      expect(JSON.parse(result.stdout)).toEqual({
        "README.md": ["# Tree\n", 0o100600],
        "kirocrew/create-bots.sh": ["#!/usr/bin/env sh\n", 0o100700],
        "ünïcode.md": ["ü", 0o100600],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
