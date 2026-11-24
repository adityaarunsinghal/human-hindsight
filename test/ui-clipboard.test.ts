import { describe, expect, it } from "vitest";
import { type ClipboardSpawn, copyToClipboard, isSshSession } from "../src/ui/clipboard.js";
import { fakeOutput } from "./support/tty.js";

const OSC52 = `\u001b]52;c;${Buffer.from("the prompt").toString("base64")}\u0007`;

function recordingSpawn(code = 0) {
  const calls: string[] = [];
  const spawn: ClipboardSpawn = async (cmd) => {
    calls.push(cmd);
    return { code };
  };
  return { calls, spawn };
}

describe("clipboard over SSH", () => {
  it.each([
    ["SSH_TTY", { SSH_TTY: "/dev/pts/1" }],
    ["SSH_CONNECTION", { SSH_CONNECTION: "192.0.2.1 50000 192.0.2.2 22" }],
    ["SSH_CLIENT", { SSH_CLIENT: "192.0.2.1 50000 22" }],
  ])("detects a session from %s", (_name, env) => {
    expect(isSshSession(env)).toBe(true);
  });

  it.each([
    ["macOS", "darwin", {}],
    ["Linux with a forwarded display", "linux", { DISPLAY: "localhost:10.0" }],
    ["Linux without a display", "linux", {}],
  ] as const)("sends the terminal request and never runs the remote clipboard tool on %s", async (_name, platform, extra) => {
    const out = fakeOutput({ isTTY: true });
    const { calls, spawn } = recordingSpawn(0);
    const result = await copyToClipboard("the prompt", {
      platform,
      env: { SSH_TTY: "/dev/pts/1", TERM: "xterm-256color", ...extra },
      spawn,
      output: out,
    });
    expect(calls).toEqual([]);
    expect(out.raw()).toBe(OSC52);
    // No acknowledgement exists, so this is never reported as copied.
    expect(result).toMatchObject({ ok: false, terminalAttempted: true, tool: "OSC 52" });
  });

  it.each([
    ["a pipe", { isTTY: false }, {}],
    ["TERM=dumb", { isTTY: true }, { TERM: "dumb" }],
    ["CI", { isTTY: true }, { CI: "true" }],
  ])("writes nothing and reports no copy into %s", async (_name, tty, extra) => {
    const out = fakeOutput(tty);
    const { calls, spawn } = recordingSpawn(0);
    const result = await copyToClipboard("the prompt", {
      platform: "darwin",
      env: { SSH_CONNECTION: "192.0.2.1 50000 192.0.2.2 22", ...extra },
      spawn,
      output: out,
    });
    expect(calls).toEqual([]);
    expect(out.raw()).toBe("");
    expect(result.ok).toBe(false);
    expect(result.terminalAttempted).toBeUndefined();
    expect(result.error).toMatch(/SSH/);
  });
});

describe("clipboard outside SSH", () => {
  it("uses the platform tool and reports it", async () => {
    const out = fakeOutput({ isTTY: true });
    const { calls, spawn } = recordingSpawn(0);
    const result = await copyToClipboard("the prompt", {
      platform: "darwin",
      env: {},
      spawn,
      output: out,
    });
    expect(calls).toEqual(["pbcopy"]);
    expect(result).toEqual({ ok: true, tool: "pbcopy" });
    expect(out.raw()).toBe("");
  });

  it("reports a failed tool without a terminal request", async () => {
    const out = fakeOutput({ isTTY: true });
    const { spawn } = recordingSpawn(1);
    const result = await copyToClipboard("the prompt", {
      platform: "linux",
      env: {},
      spawn,
      output: out,
    });
    expect(result).toEqual({ ok: false, tool: "xclip", error: "xclip exited with code 1" });
    expect(out.raw()).toBe("");
  });
});
