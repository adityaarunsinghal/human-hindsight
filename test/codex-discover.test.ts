import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runExport } from "../src/commands/export.js";
import { runScan } from "../src/commands/scan.js";
import { renderStatus } from "../src/commands/status.js";
import { discoverCodexProjects } from "../src/sources/codex/discover.js";
import { codexSource } from "../src/sources/codex/index.js";
import { parseSourceMode, resolveSources } from "../src/sources/registry.js";

const fixtures = path.join(import.meta.dirname, "fixtures");
const codexDir = path.join(fixtures, "codex-home");
const tmp: string[] = [];
afterEach(() => {
  for (const dir of tmp.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Codex discovery and command integration", () => {
  it("groups active and archived rollouts by cwd and prefers an active duplicate", () => {
    const projects = discoverCodexProjects(codexDir);
    expect(projects.map((p) => p.shortName)).toEqual(["docs", "my-webapp"]);
    const sessions = projects.flatMap((p) => p.sessions);
    expect(sessions).toHaveLength(3);
    const active = sessions.find((s) => s.id?.startsWith("11111111"));
    expect(active?.path).toContain("/sessions/2026/10/20/");
    expect(active?.entryCount).toBe(22);
    expect(
      discoverCodexProjects(codexDir, { countEntries: false })
        .flatMap((p) => p.sessions)
        .every((s) => s.entryCount === 0),
    ).toBe(true);
  });

  it("supports auto discovery and missing stores without reading real homes", () => {
    expect(parseSourceMode("CODEX")).toBe("codex");
    const missing = path.join(fixtures, "no-store");
    expect(discoverCodexProjects(missing)).toEqual([]);
    const sources = resolveSources("auto", { claudeDir: missing, codexDir, kiroDir: missing });
    expect(sources.map((s) => s.name)).toEqual(["codex"]);
  });

  it("exports human sessions with stable IDs, origins, and downstream context", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cch-codex-export-"));
    tmp.push(home);
    const output = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const stats = runExport({ home, source: "codex", "codex-dir": codexDir, output });
    expect(stats.sessionsByOrigin).toEqual({ codex: 2 });
    expect(stats.automationSkipped).toBe(1);
    expect(stats.totalMessages).toBe(5);
    const manifest = JSON.parse(fs.readFileSync(path.join(home, "exports/manifest.json"), "utf8"));
    expect(manifest.map((e: { origin: string }) => e.origin)).toEqual(["codex", "codex"]);
    expect(stats.files).toContain("my-webapp-11111111.md");
    const exported = fs.readFileSync(path.join(home, "exports/my-webapp-11111111.md"), "utf8");
    expect(exported).toContain("Build a settings page.");
    expect(exported).not.toContain("Injected");
    expect(fs.existsSync(path.join(home, "exports/outcomes.json"))).toBe(true);
    const source = codexSource(codexDir);
    const sessions = source.discover().flatMap((p) => p.sessions);
    expect(
      sessions.filter((s) => source.classify?.({ ...s, project: "p" }) === "automation"),
    ).toHaveLength(1);
  });

  it("shows Codex-only scans and merged status inventories", () => {
    const logs: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts) => logs.push(parts.join(" ")));
    try {
      runScan({ source: "codex", "codex-dir": codexDir });
      expect(logs.join("\n")).toContain("2 projects, 3 sessions");
      expect(logs.join("\n")).toContain("retention");
    } finally {
      spy.mockRestore();
    }
    const missing = path.join(fixtures, "no-store");
    const status = renderStatus({
      home: missing,
      claudeDir: path.join(fixtures, "export-home"),
      codexDir,
      kiroDir: path.join(fixtures, "kiro-home"),
      source: "auto",
    });
    expect(status).toContain("(4 claude, 3 codex, 5 kiro)");
  });
});
