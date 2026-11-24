import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { fixLines, runDoctor } from "../src/commands/doctor.js";
import { claudeUsesCloudProvider } from "../src/runners/capabilities.js";
import type { RunnerIo } from "../src/runners/shared.js";
import { goldenText } from "./support/text.js";

// The note about family names reads the injected environment only: no CLI runs to find it.
const HELP =
  "--output-format --json-schema --tools --safe-mode --system-prompt --strict-mcp-config " +
  "--mcp-config --settings --disable-slash-commands --no-chrome --no-session-persistence";
const tmp: string[] = [];
afterEach(() => {
  for (const dir of tmp.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

let lastHome = "";
async function doctor(env: NodeJS.ProcessEnv, columns?: number): Promise<string> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hh-doctor-"));
  tmp.push(home);
  lastHome = home;
  const io: RunnerIo = {
    which: (bin) => (bin === "claude" ? "/fake/bin/claude" : null),
    spawn: async (_bin, args) => ({
      code: 0,
      signal: null,
      stdout:
        args[0] === "--version"
          ? "9.9.9 (Claude Code)\n"
          : args[0] === "auth"
            ? "Logged in\n"
            : HELP,
      stderr: "",
      timedOut: false,
    }),
  };
  let text = "";
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        text += chunk.toString();
        done();
      },
    }),
    columns ? { columns } : {},
  );
  await runDoctor({ home, "claude-dir": home, source: "claude" }, { output, io, env });
  return text;
}

describe("doctor: Claude Code through a cloud provider", () => {
  it("says once, under Claude Code's own row, that family names are resolved by the CLI", async () => {
    const text = await doctor({ CLAUDE_CODE_USE_BEDROCK: "1" });
    const joined = text.replace(/\n│? +/g, " ");
    expect(joined.match(/family names/g)).toHaveLength(1);
    expect(joined).toMatch(/--model/);
    expect(joined).toMatch(/Claude Code's own settings/);
    const lines = text.split("\n");
    const row = lines.findIndex((line) => line.includes("Claude Code  "));
    expect(lines[row + 1]).toMatch(/^│ {14}Claude Code uses a cloud provider/);
  });

  it.each([80, 60])("keeps the table aligned at %i columns with the note", async (columns) => {
    const text = await doctor({ CLAUDE_CODE_USE_BEDROCK: "1" }, columns);
    // A folder alone on its line may be longer than the terminal; nothing else is.
    for (const line of text.split("\n").filter((l) => !l.includes(lastHome))) {
      expect(line.length, line).toBeLessThanOrEqual(columns);
    }
    const golden = goldenText(text, { roots: { [lastHome]: "<HOME>" } }).replace(
      /^Node .*$/m,
      "Node <version> on <platform>",
    );
    await expect(golden).toMatchFileSnapshot(`golden/doctor/cloud-note-${columns}.txt`);
  });

  it("puts the command of a fix alone on its own line", () => {
    expect(fixLines("Codex suggests signing in. Run codex login --device-auth", 30)).toEqual([
      "Codex suggests signing in.",
      "Run:",
      "  codex login --device-auth",
    ]);
  });

  it("says nothing for a first-party install", async () => {
    expect(await doctor({})).not.toMatch(/family names/);
  });

  it.each([
    [{ CLAUDE_CODE_USE_VERTEX: "true" }, true],
    [{ CLAUDE_CODE_USE_BEDROCK: "0" }, false],
    [{ CLAUDE_CODE_USE_BEDROCK: "false" }, false],
    [{ CLAUDE_CODE_USE_BEDROCK: "" }, false],
    [{}, false],
  ])("%j is a cloud provider setup: %s", (env, expected) => {
    expect(claudeUsesCloudProvider(env)).toBe(expected);
  });
});
