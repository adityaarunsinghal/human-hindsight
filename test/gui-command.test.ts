import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserCommands,
  forwardCommand,
  isRemoteSession,
  REMOTE_PORT,
  runGui,
} from "../src/commands/gui.js";
import { type GuiServer, startGuiServer } from "../src/gui/server.js";
import { splitFragment } from "../src/gui/session.js";
import { fakeOutput } from "./support/tty.js";

/**
 * The `gui` command's decisions: which port, whether to open a browser, and
 * what to print. The server start is injected, so no socket is opened.
 */

const TOKEN = "ab".repeat(32);
const HOME = "/synthetic/hindsight-home";
const SSH = { SSH_CONNECTION: "192.0.2.10 50000 198.51.100.7 22", LOGNAME: "sample-user" };
const host = { hostname: () => "synthetic-host", login: () => "fallback-user" };

/** A server start that records each port asked for and refuses the ones in `busy`. */
function fakeStart(busy: number[] = []) {
  const ports: number[] = [];
  const homes: string[] = [];
  /** What the server would call on the first request that carries the key. */
  const authenticated: (() => void)[] = [];
  const start = vi.fn(
    async (opts: {
      home: string;
      port?: number;
      onAuthenticated?: () => void;
    }): Promise<GuiServer> => {
      const port = opts.port ?? 0;
      ports.push(port);
      homes.push(opts.home);
      if (opts.onAuthenticated) authenticated.push(opts.onAuthenticated);
      if (busy.includes(port)) {
        throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
      }
      const server = new EventEmitter() as unknown as Server;
      let closed = false;
      return {
        server,
        url: `http://127.0.0.1:${port || 50123}`,
        token: TOKEN,
        async close() {
          if (!closed) server.emit("close");
          closed = true;
        },
      };
    },
  );
  return { start, ports, homes, authenticated };
}

const opened: GuiServer[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((gui) => gui.close()));
});

async function run(
  args: Parameters<typeof runGui>[0],
  deps: Partial<Parameters<typeof runGui>[1]> & { busy?: number[] } = {},
) {
  const out = fakeOutput();
  const fake = fakeStart(deps.busy);
  const openBrowser = deps.openBrowser ?? vi.fn(async () => true);
  const retired: [string, number][] = [];
  const gui = await runGui(
    { home: HOME, ...args },
    {
      env: {},
      platform: "darwin",
      host,
      retire: async (home, port) => void retired.push([home, port]),
      ...deps,
      output: out,
      openBrowser,
      start: fake.start,
    },
  );
  opened.push(gui);
  return { gui, text: out.text(), openBrowser, retired, ...fake };
}

describe("remote detection", () => {
  it.each([
    ["darwin", {}, false],
    ["darwin", { SSH_CONNECTION: "192.0.2.10 50000 198.51.100.7 22" }, true],
    ["darwin", { SSH_CLIENT: "192.0.2.10 50000 22" }, true],
    ["linux", { SSH_TTY: "/dev/pts/0", DISPLAY: ":0" }, true],
    // mosh 1.4.0, observed: mosh-server sets no MOSH_* variable, and its shell
    // keeps the SSH_* variables of the ssh login that started it.
    [
      "linux",
      { SSH_CONNECTION: "192.0.2.10 50000 198.51.100.7 22", NCURSES_NO_UTF8_ACS: "1" },
      true,
    ],
    // A Linux machine with no display has no browser to open: a session through
    // a terminal multiplexer or a web console carries no SSH variable.
    ["linux", {}, true],
    ["linux", { DISPLAY: "" }, true],
    ["linux", { DISPLAY: ":0" }, false],
    ["linux", { WAYLAND_DISPLAY: "wayland-0" }, false],
    // WSL hands the address to the Windows browser.
    ["linux", { WSL_DISTRO_NAME: "Ubuntu" }, false],
    ["linux", { WSL_INTEROP: "/run/WSL/1_interop" }, false],
    // A Mac without SSH variables has its own browser.
    ["darwin", { DISPLAY: "" }, false],
  ] as const)("on %s, %o is remote: %s", (platform, env, remote) => {
    expect(isRemoteSession(env, platform)).toBe(remote);
  });

  it.each([
    ["darwin", {}, ["open"]],
    ["linux", {}, ["xdg-open"]],
    ["linux", { WSL_DISTRO_NAME: "Ubuntu" }, ["wslview", "xdg-open"]],
    ["linux", { WSL_INTEROP: "/run/WSL/1_interop" }, ["wslview", "xdg-open"]],
    ["win32", {}, []],
  ] as const)("on %s with %o the browser is opened with %o", (platform, env, commands) => {
    expect(browserCommands(env, platform)).toEqual(commands);
  });
});

describe("forwarding command", () => {
  it.each([
    [SSH, "ssh -N -L 127.0.0.1:4317:127.0.0.1:4317 -- sample-user@198.51.100.7"],
    [
      { ...SSH, SSH_CONNECTION: "192.0.2.10 50000 198.51.100.7 2222" },
      "ssh -N -p 2222 -L 127.0.0.1:4317:127.0.0.1:4317 -- sample-user@198.51.100.7",
    ],
    [
      { SSH_TTY: "/dev/pts/0" },
      "ssh -N -L 127.0.0.1:4317:127.0.0.1:4317 -- fallback-user@synthetic-host",
    ],
    [
      { ...SSH, LOGNAME: "o'brien x" },
      "ssh -N -L 127.0.0.1:4317:127.0.0.1:4317 -- 'o'\\''brien x@198.51.100.7'",
    ],
  ])("%o gives %s", (env, command) => {
    expect(forwardCommand(4317, env, host)).toBe(command);
  });
});

const tmpDirs: string[] = [];
function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-gui-command-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

/** The session key on a browser's command line is readable by every local user (`ps`). */
describe("opening the browser keeps the session key off every command line", () => {
  it.each([
    ["darwin", {}],
    ["linux", { DISPLAY: ":0" }],
    ["linux", { WSL_DISTRO_NAME: "Ubuntu" }],
  ] as const)("on %s %o the opener gets an owner-only file in the data home", async (platform, env) => {
    const home = tmpHome();
    const { openBrowser, text, gui } = await run({ home, tab: "preferences" }, { env, platform });
    expect(openBrowser).toHaveBeenCalledTimes(1);
    const [target] = vi.mocked(openBrowser).mock.calls[0] as [string];
    expect(target).not.toContain(TOKEN);
    expect(path.dirname(target)).toBe(home);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    // The page sends the browser on to the same address the terminal shows.
    expect(fs.readFileSync(target, "utf8")).toContain(
      `url=${gui.address.replaceAll("&", "&amp;")}"`,
    );
    expect(gui.address).toBe(`http://127.0.0.1:50123/#preferences&token=${TOKEN}`);
    expect(text).toContain(`human-hindsight library: ${gui.address}\n`);
    expect(text).toContain("Opened in your browser.");
  });

  it("removes the file once the page has made its first authenticated request", async () => {
    const home = tmpHome();
    const { openBrowser, authenticated } = await run({ home });
    const [target] = vi.mocked(openBrowser).mock.calls[0] as [string];
    expect(fs.existsSync(target)).toBe(true);
    expect(authenticated).toHaveLength(1);
    authenticated[0]?.();
    expect(fs.existsSync(target)).toBe(false);
    authenticated[0]?.();
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("removes opener files a stopped server left behind, and nothing else", async () => {
    const home = tmpHome();
    const leftover = path.join(home, "gui-open-0123456789abcdef.html");
    fs.writeFileSync(leftover, "<!doctype html>", { mode: 0o600 });
    fs.writeFileSync(path.join(home, "gui-open-notes.txt"), "mine");
    const { openBrowser } = await run({ home });
    const [target] = vi.mocked(openBrowser).mock.calls[0] as [string];
    expect(fs.existsSync(leftover)).toBe(false);
    expect(fs.readdirSync(home).sort()).toEqual(
      [path.basename(target), "gui-open-notes.txt"].sort(),
    );
  });

  it("removes the file when the server stops before the page loaded", async () => {
    const home = tmpHome();
    const { openBrowser, gui } = await run({ home });
    const [target] = vi.mocked(openBrowser).mock.calls[0] as [string];
    await gui.close();
    expect(fs.existsSync(target)).toBe(false);
  });

  it("opens nothing and points at the printed address when the data home cannot hold the file", async () => {
    const home = path.join(tmpHome(), "a-file");
    fs.writeFileSync(home, "");
    const { openBrowser, text } = await run({ home });
    expect(openBrowser).not.toHaveBeenCalled();
    expect(text).toContain(`#token=${TOKEN}`);
    expect(text).toContain("Open the address above in your browser.");
  });

  it("over SSH writes no file and opens nothing", async () => {
    const home = tmpHome();
    const { openBrowser } = await run({ home }, { env: SSH });
    expect(openBrowser).not.toHaveBeenCalled();
    expect(fs.readdirSync(home)).toEqual([]);
  });
});

describe("gui command", () => {
  it("over SSH uses the fixed port, prints the exact forwarding command and laptop address, and opens nothing", async () => {
    const env = { ...SSH, SSH_CONNECTION: "192.0.2.10 50000 198.51.100.7 2222" };
    const { text, openBrowser, ports, gui, retired } = await run({}, { env });
    expect(ports).toEqual([REMOTE_PORT]);
    // A view an earlier reflection left on the port is asked to stop first.
    expect(retired).toEqual([[HOME, REMOTE_PORT]]);
    // The one line that makes every later address open with no command.
    expect(text).toContain(
      `   To skip this from now on, add this line under the host in ~/.ssh/config on your laptop:\n     LocalForward ${REMOTE_PORT} 127.0.0.1:${REMOTE_PORT}\n`,
    );
    expect(openBrowser).not.toHaveBeenCalled();
    const address = `http://127.0.0.1:${REMOTE_PORT}/#token=${TOKEN}`;
    expect(gui.address).toBe(address);
    expect(text).toContain(
      `   ssh -N -p 2222 -L 127.0.0.1:${REMOTE_PORT}:127.0.0.1:${REMOTE_PORT} -- sample-user@198.51.100.7\n`,
    );
    expect(text).toContain(`Open this address on your laptop:\n   ${address}\n`);
    expect(text).not.toContain("Opened in your browser");
  });

  it("over SSH with the fixed port taken, says so and forwards the port actually used", async () => {
    const { text, ports, openBrowser } = await run({}, { env: SSH, busy: [REMOTE_PORT] });
    expect(ports).toEqual([REMOTE_PORT, 0]);
    expect(text).toContain(
      `Port ${REMOTE_PORT} is already in use, so the library uses port 50123 instead.`,
    );
    expect(text).toContain("-L 127.0.0.1:50123:127.0.0.1:50123 --");
    // The configuration line is only for the fixed port.
    expect(text).not.toContain("LocalForward");
    expect(text).toContain(`http://127.0.0.1:50123/#token=${TOKEN}`);
    expect(text).not.toContain(`127.0.0.1:${REMOTE_PORT}:`);
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("a Linux machine with no display gets the same help as an SSH session", async () => {
    const { text, openBrowser, ports } = await run({}, { env: {}, platform: "linux" });
    expect(ports).toEqual([REMOTE_PORT]);
    expect(openBrowser).not.toHaveBeenCalled();
    expect(text).toContain("This is a remote machine, so open the library on your laptop.");
    expect(text).toContain(
      `   ssh -N -L 127.0.0.1:${REMOTE_PORT}:127.0.0.1:${REMOTE_PORT} -- fallback-user@synthetic-host\n`,
    );
  });

  it("an explicit port that is taken is an error, not a silent change", async () => {
    await expect(run({ port: "5000" }, { busy: [5000] })).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  });

  it("on WSL without a display tries the browser on an automatic port", async () => {
    const home = tmpHome();
    const { ports, openBrowser, text } = await run(
      { home },
      { env: { WSL_DISTRO_NAME: "Ubuntu" }, platform: "linux" },
    );
    expect(ports).toEqual([0]);
    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(path.dirname(String(vi.mocked(openBrowser).mock.calls[0]?.[0]))).toBe(home);
    expect(text).not.toContain("ssh");
    expect(text).toContain("Opened in your browser.");
  });

  it("never claims a browser opened when the launcher failed, and leaves no file behind", async () => {
    for (const openBrowser of [
      vi.fn(async () => false),
      vi.fn(async () => Promise.reject(new Error("no launcher"))),
    ]) {
      const home = tmpHome();
      const { text } = await run({ home }, { openBrowser });
      expect(text).not.toContain("Opened in your browser");
      expect(text).toContain("Open the address above in your browser.");
      expect(fs.readdirSync(home)).toEqual([]);
    }
  });

  it("--no-open prints the address only", async () => {
    const { text, openBrowser, homes } = await run({ open: false });
    expect(openBrowser).not.toHaveBeenCalled();
    expect(homes).toEqual([HOME]);
    expect(text).toBe(
      `human-hindsight library: http://127.0.0.1:50123/#token=${TOKEN}\nPress Ctrl+C to stop.\n`,
    );
  });

  it("--tab puts the tab before the key in the fragment", async () => {
    const { gui } = await run({ tab: "subagents", open: false });
    const fragment = new URL(gui.address).hash;
    expect(fragment).toBe(`#subagents&token=${TOKEN}`);
    expect(splitFragment(fragment)).toEqual({ token: TOKEN, route: "subagents" });
  });

  it.each([
    "",
    "subagent",
    "Prompts",
    "preferences/x",
  ])("rejects --tab %j before starting", async (tab) => {
    const fake = fakeStart();
    await expect(
      runGui({ home: HOME, tab }, { output: fakeOutput(), start: fake.start, env: {} }),
    ).rejects.toThrow(
      `--tab takes prompts, preferences, or subagents, not ${JSON.stringify(tab)}.`,
    );
    expect(fake.start).not.toHaveBeenCalled();
  });

  it.each(["", "-1", "12px", "1.5", "65536"])("rejects --port %j before starting", async (port) => {
    const fake = fakeStart();
    await expect(
      runGui({ home: HOME, port }, { output: fakeOutput(), start: fake.start, env: {} }),
    ).rejects.toThrow(`--port takes a whole number from 0 to 65535, not ${JSON.stringify(port)}.`);
    expect(fake.start).not.toHaveBeenCalled();
  });

  it("removes its signal listeners when the server closes", async () => {
    const before = ["SIGINT", "SIGTERM"].map((signal) => process.listenerCount(signal));
    const { gui } = await run({ open: false });
    expect(["SIGINT", "SIGTERM"].map((signal) => process.listenerCount(signal))).toEqual(
      before.map((count) => count + 1),
    );
    await gui.close();
    expect(["SIGINT", "SIGTERM"].map((signal) => process.listenerCount(signal))).toEqual(before);
  });

  it.each([-1, 65536, 1.5])("the server refuses port %s before listening", async (port) => {
    await expect(startGuiServer({ home: HOME, port })).rejects.toThrow("--port must be an integer");
  });
});
