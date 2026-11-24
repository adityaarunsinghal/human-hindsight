import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ManifestEntry, runExport } from "../src/commands/export.js";

/**
 * `--project` after an upgrade. A re-export keeps the project name an earlier
 * manifest recorded for each source, while discovery may now give the same
 * folder a new name (old `hindsight`, new `human-hindsight`). Either name
 * selects the session. Synthetic fixture history only.
 */

const CLAUDE_HOME = path.join(import.meta.dirname, "fixtures", "export-home");
const NO_KIRO = path.join(CLAUDE_HOME, "no-kiro-here");
const NO_CODEX = path.join(CLAUDE_HOME, "no-codex-here");

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const sink = () =>
  new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });

const manifest = (home: string): ManifestEntry[] =>
  JSON.parse(fs.readFileSync(path.join(home, "exports", "manifest.json"), "utf8"));

/** Export once, then rename every alpha row as an earlier release would have recorded it. */
function upgradedHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-export-project-"));
  homes.push(home);
  runExport({ ...base(home), output: sink() });
  const rows = manifest(home).map((row) =>
    row.project === "alpha" ? { ...row, project: "alpha-before-upgrade" } : row,
  );
  expect(rows.some((row) => row.project === "alpha-before-upgrade")).toBe(true);
  fs.writeFileSync(path.join(home, "exports", "manifest.json"), JSON.stringify(rows, null, 2));
  return home;
}

function base(home: string) {
  return { home, "claude-dir": CLAUDE_HOME, "kiro-dir": NO_KIRO, "codex-dir": NO_CODEX };
}

describe("export --project after an upgrade", () => {
  it.each([
    ["the name kept from the earlier manifest", "alpha-before-upgrade"],
    ["the name discovery gives it now", "alpha"],
  ])("selects a session by %s", (_label, project) => {
    const home = upgradedHome();
    const before = manifest(home).filter((row) => row.project === "alpha-before-upgrade");
    const stats = runExport({ ...base(home), project, output: sink() });
    expect(stats.exportedSessions).toBe(before.length);
    // The kept name survives either way, so preference ids and digests stay put.
    const after = manifest(home).filter((row) => row.project === "alpha-before-upgrade");
    expect(after.map((row) => row.source).sort()).toEqual(before.map((row) => row.source).sort());
  });

  it("a name that matches neither selects nothing", () => {
    const home = upgradedHome();
    const stats = runExport({ ...base(home), project: "unrelated-name", output: sink() });
    expect(stats.exportedSessions).toBe(0);
  });
});

describe("export output glyphs", () => {
  it("a non-UTF-8 locale gets ASCII in the terminal summary", () => {
    vi.stubEnv("LANG", "C");
    vi.stubEnv("LC_ALL", "");
    vi.stubEnv("LC_CTYPE", "");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-export-ascii-"));
    homes.push(home);
    let text = "";
    const output = new Writable({
      write(chunk, _encoding, done) {
        text += chunk.toString();
        done();
      },
    });
    runExport({ ...base(home), output, verbose: true });
    expect(text.length).toBeGreaterThan(0);
    expect([...text].filter((char) => char.charCodeAt(0) > 127)).toEqual([]);
  });
});
