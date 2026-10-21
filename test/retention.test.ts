import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePaths } from "../src/commands/_shared.js";
import { resolveTarget } from "../src/commands/preferences.js";
import { type RetentionArgs, runRetention } from "../src/commands/retention.js";
import {
  applyRetentionPlan,
  LONG_RETENTION_DAYS,
  maximizeCodexHistory,
  planRetention,
} from "../src/core/retention.js";

let root: string;
let args: RetentionArgs;
let output: Writable;
let stdout: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cch-retention-"));
  args = {
    home: root,
    "claude-dir": path.join(root, "claude"),
    "codex-dir": path.join(root, "codex"),
    "kiro-dir": path.join(root, "kiro"),
  };
  stdout = "";
  output = new Writable({
    write(chunk, _encoding, done) {
      stdout += chunk.toString();
      done();
    },
  });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function config(tool: string, name: string, text: string): string {
  const dir = path.join(root, tool);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

describe("optional local retention", () => {
  it("previews without writing or opting in through --yes alone", async () => {
    const before = '{"cleanupPeriodDays":30,"model":"user-model"}\n';
    const file = config("claude", "settings.json", before);
    expect(await runRetention({ ...args, yes: true }, { output })).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["settings.json"]);
    expect(stdout).toContain("Preview only");
    expect(stdout).toContain(String(LONG_RETENTION_DAYS));
    expect(fs.existsSync(args["codex-dir"] ?? "")).toBe(false);
  });

  it("applies both supported tools with backups and preserves unrelated settings", async () => {
    const before =
      '{"cleanupPeriodDays":30,"desktopSessionCleanupPeriodDays":90,"model":"mine","env":{"TOKEN":"private-token"}}\n';
    const claude = config("claude", "settings.json", before);
    const toml =
      '# My model\nmodel = "mine"\n\n[history] # prompt history\npersistence = "none"\nmax_bytes = 4096\n\n[mcp_servers.local]\ncommand = "server"\n';
    const codex = config("codex", "config.toml", toml);
    expect(await runRetention({ ...args, apply: true, yes: true }, { output })).toBe(0);
    expect(JSON.parse(fs.readFileSync(claude, "utf8"))).toEqual({
      cleanupPeriodDays: LONG_RETENTION_DAYS,
      desktopSessionCleanupPeriodDays: 0,
      model: "mine",
      env: { TOKEN: "private-token" },
    });
    const after = fs.readFileSync(codex, "utf8");
    expect(after).toContain('# My model\nmodel = "mine"');
    expect(after).toContain("[history] # prompt history");
    expect(parseToml(after)).toEqual({
      model: "mine",
      history: { persistence: "save-all" },
      mcp_servers: { local: { command: "server" } },
    });
    for (const [file, original] of [
      [claude, before],
      [codex, toml],
    ]) {
      const backups = fs.readdirSync(path.dirname(file ?? "")).filter((f) => f.endsWith(".bak"));
      expect(backups).toHaveLength(1);
      const backup = path.join(path.dirname(file ?? ""), backups[0] ?? "");
      expect(fs.readFileSync(backup, "utf8")).toBe(original);
      expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
    }
    expect(stdout).not.toContain("private-token");
    expect(await runRetention({ ...args, apply: true, yes: true }, { output })).toBe(0);
    expect(fs.readdirSync(path.dirname(codex)).filter((f) => f.endsWith(".bak"))).toHaveLength(1);
  });

  it("dry-run wins over apply and yes, and a declined prompt writes nothing", async () => {
    const file = config("claude", "settings.json", "{}");
    expect(
      await runRetention({ ...args, apply: true, yes: true, "dry-run": true }, { output }),
    ).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe("{}");
    expect(
      await runRetention(
        { ...args, apply: true },
        {
          output,
          input: Readable.from(["n\n"]),
        },
      ),
    ).toBe(2);
    expect(fs.readFileSync(file, "utf8")).toBe("{}");
  });

  it("creates only an explicitly selected missing tool config with owner-only permissions", async () => {
    expect(
      await runRetention({ ...args, source: "codex", apply: true, yes: true }, { output }),
    ).toBe(0);
    const file = path.join(root, "codex/config.toml");
    expect(parseToml(fs.readFileSync(file, "utf8")).history).toEqual({ persistence: "save-all" });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(root, "claude"))).toBe(false);
  });

  it("refuses malformed TOML before changing any tool and never echoes parser source lines", async () => {
    const file = config("claude", "settings.json", "{}");
    config("codex", "config.toml", 'token = "private-secret');
    expect(await runRetention({ ...args, apply: true, yes: true }, { output })).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe("{}");
    expect(stdout).toContain("Invalid TOML");
    expect(stdout).not.toContain("private-secret");
  });

  it("refuses malformed Claude settings instead of replacing them", async () => {
    const file = config("claude", "settings.json", "{broken");
    expect(
      await runRetention({ ...args, source: "claude", apply: true, yes: true }, { output }),
    ).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe("{broken");
  });

  it("does not reduce an existing longer period or write already uncapped settings", async () => {
    const text = JSON.stringify({
      cleanupPeriodDays: LONG_RETENTION_DAYS + 1,
      desktopSessionCleanupPeriodDays: 0,
    });
    const file = config("claude", "settings.json", text);
    expect(await runRetention({ ...args, apply: true, yes: true }, { output })).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(text);
    expect(stdout).toContain("No changes needed");
  });

  it("preserves dotfile symlinks while updating their targets", async () => {
    const target = config("dotfiles", "claude.json", "{}");
    fs.mkdirSync(path.join(root, "claude"));
    const link = path.join(root, "claude/settings.json");
    fs.symlinkSync(target, link);
    expect(
      await runRetention({ ...args, source: "claude", apply: true, yes: true }, { output }),
    ).toBe(0);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, "utf8")).cleanupPeriodDays).toBe(LONG_RETENTION_DAYS);
  });

  it("refuses to overwrite edits made after the preview", () => {
    const file = config("claude", "settings.json", "{}");
    const plan = planRetention("claude", resolvePaths(args))[0];
    if (!plan) throw new Error("missing plan");
    fs.writeFileSync(file, '{"model":"new-choice"}');
    expect(() => applyRetentionPlan(plan)).toThrow("changed since the preview");
    expect(fs.readFileSync(file, "utf8")).toBe('{"model":"new-choice"}');
  });

  it("explains Kiro's persistence without fabricating configuration keys", async () => {
    config("kiro", "settings.json", '{"existing":true}');
    expect(
      await runRetention({ ...args, source: "kiro", apply: true, yes: true }, { output }),
    ).toBe(0);
    expect(stdout).toContain("/chat save <path>");
    expect(fs.readFileSync(path.join(root, "kiro/settings.json"), "utf8")).toBe(
      '{"existing":true}',
    );
  });
});

describe("Codex TOML edits", () => {
  it.each([
    'model="mine"\nhistory.persistence="none"\nhistory.max_bytes=1024\n',
    'history = { persistence = "none", max_bytes = 1024 }\nmodel = "mine"\n',
    '["history"]\n"persistence" = "none"\n"max_bytes" = 1024\n',
    'instructions = """\n[history]\nmax_bytes = 1024\n"""\n\n[history]\npersistence="none"\nmax_bytes=1024\n',
  ])("preserves all other values in valid TOML variants", (before) => {
    const original = parseToml(before);
    const result = maximizeCodexHistory(before);
    expect(parseToml(result.after)).toEqual({ ...original, history: { persistence: "save-all" } });
    expect(maximizeCodexHistory(result.after).after).toBe(result.after);
  });

  it("keeps large integers exact when uncommon TOML needs reformatting", () => {
    const before =
      'large = 9223372036854775807\nhistory = { persistence = "none", max_bytes = 0 }\n';
    const result = maximizeCodexHistory(before);
    expect(parseToml(result.after, { integersAsBigInt: "asNeeded" }).large).toBe(
      9223372036854775807n,
    );
  });
});

describe("Codex preferences destination", () => {
  it("infers AGENTS.md from the Codex source and accepts an explicit Codex target", () => {
    expect(resolveTarget(undefined, "codex")).toBe("agents");
    expect(resolveTarget("codex", "auto")).toBe("agents");
  });
});
