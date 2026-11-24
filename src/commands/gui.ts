import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { hostname, userInfo } from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import { defineCommand } from "citty";
import { checkedValue, oneOf, wholeNumber } from "../core/value-rule.js";
import { TABS, type Tab } from "../gui/landing.js";
import { type GuiServer, startGuiServer } from "../gui/server.js";
import { sessionFragment } from "../gui/session.js";
import { resolvePaths, sharedArgs } from "./_shared.js";

export const TAB_RULE = oneOf(TABS);
export const PORT_RULE = wholeNumber(0, "a whole number from 0 to 65535", 65535);

/** Over SSH the port is fixed, so one forwarding command keeps working across restarts. */
export const REMOTE_PORT = 4317;

/**
 * Remote means an SSH session: the browser runs on another machine. A Linux
 * machine without a display is not remote by itself; WSL in particular is a
 * local machine whose browser runs on the Windows side.
 */
export function isRemoteSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
}

export function isWsl(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

/** The browser launchers to try, in order. WSL hands the address to the Windows browser. */
export function browserCommands(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === "darwin") return ["open"];
  if (platform === "linux") return isWsl(env) ? ["wslview", "xdg-open"] : ["xdg-open"];
  return [];
}

/** The command to run on the laptop: forwards the same port on both ends. */
export function forwardCommand(
  port: number,
  env: NodeJS.ProcessEnv,
  host: { hostname(): string; login(): string | undefined } = {
    hostname,
    login: () => {
      try {
        return userInfo().username;
      } catch {
        // A minimal headless system may have no account entry for the process UID.
        return undefined;
      }
    },
  },
): string {
  const [, , serverIp, sshPort] = (env.SSH_CONNECTION ?? "").trim().split(/\s+/);
  const login = env.LOGNAME || env.USER || host.login();
  const destination = `${login ? `${login}@` : ""}${serverIp || host.hostname()}`;
  const hostArg = /^[\w.@:%-]+$/.test(destination)
    ? destination
    : `'${destination.replaceAll("'", "'\\''")}'`;
  const portArg = sshPort && /^\d+$/.test(sshPort) && sshPort !== "22" ? ` -p ${sshPort}` : "";
  return `ssh -N${portArg} -L 127.0.0.1:${port}:127.0.0.1:${port} -- ${hostArg}`;
}

/** The OS browser launcher, without an npm dependency or shell interpolation. */
function launch(command: string, file: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, [file], { timeout: 5_000 }, (err) => resolve(!err));
  });
}

async function openWith(commands: string[], file: string): Promise<boolean> {
  for (const command of commands) if (await launch(command, file)) return true;
  return false;
}

/** A page that sends the browser straight on to `address`, fragment included. */
export function redirectPage(address: string): string {
  const href = address
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    `<meta http-equiv="refresh" content="0;url=${href}">`,
    "<title>Human Hindsight</title></head>",
    `<body><a href="${href}">Open your library</a></body></html>`,
    "",
  ].join("\n");
}

/**
 * The address carries the session key, and a browser started with it as an
 * argument keeps it where every local user can read it (`ps`). The opener is
 * handed this owner-only file instead, which redirects to the address. It is
 * removed after the page's first authenticated request, or when the server
 * stops. Returns undefined when the data home cannot hold it.
 */
function writeRedirectFile(
  home: string,
  address: string,
): { file: string; remove(): void } | undefined {
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const file = path.join(home, `gui-open-${randomBytes(8).toString("hex")}.html`);
    // `wx` refuses to follow or reuse anything already at this name.
    fs.writeFileSync(file, redirectPage(address), { mode: 0o600, flag: "wx" });
    let removed = false;
    return {
      file,
      remove() {
        if (removed) return;
        removed = true;
        fs.rmSync(file, { force: true });
      },
    };
  } catch {
    return undefined;
  }
}

/** The name every opener file takes: `gui-open-` and 16 hex digits. */
const REDIRECT_FILE = /^gui-open-[0-9a-f]{16}\.html$/;

/**
 * Remove opener files an earlier server left in the data home when it was
 * killed before it could remove its own. Each only redirects to an address
 * whose session key died with that server. Nothing else is touched.
 */
function removeStaleRedirects(home: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(home);
  } catch {
    return;
  }
  for (const name of names) {
    if (!REDIRECT_FILE.test(name)) continue;
    try {
      fs.rmSync(path.join(home, name), { force: true });
    } catch {
      // Not a plain file (a folder by that name): leave it.
    }
  }
}

function isAddressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE";
}

export interface GuiSession extends GuiServer {
  /** The address to open: the base URL with the tab and the session key in its fragment. */
  address: string;
}

export async function runGui(
  args: { home?: string; port?: string; open?: boolean; tab?: string },
  deps: {
    output?: Writable;
    /**
     * Opens a local file in the browser (never the address itself, which
     * carries the session key). Resolves true only when the launcher reported success.
     */
    openBrowser?: (file: string) => Promise<boolean>;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    start?: typeof startGuiServer;
    host?: Parameters<typeof forwardCommand>[2];
  } = {},
): Promise<GuiSession> {
  if (args.tab !== undefined) checkedValue(TAB_RULE, "tab", args.tab);
  if (args.port !== undefined) checkedValue(PORT_RULE, "port", args.port);
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const start = deps.start ?? startGuiServer;
  const output = deps.output ?? process.stdout;
  const remote = isRemoteSession(env);
  const home = resolvePaths(args).home;
  removeStaleRedirects(home);
  // The redirect file, while the browser is on its way to the page.
  let redirect: ReturnType<typeof writeRedirectFile>;
  const onAuthenticated = () => redirect?.remove();
  let gui: GuiServer;
  if (args.port !== undefined) {
    gui = await start({ home, port: Number(args.port), onAuthenticated });
  } else if (remote) {
    try {
      gui = await start({ home, port: REMOTE_PORT, onAuthenticated });
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
      gui = await start({ home, port: 0, onAuthenticated });
      output.write(
        `Port ${REMOTE_PORT} is already in use, so the library uses port ${new URL(gui.url).port} instead.\n`,
      );
    }
  } else {
    gui = await start({ home, port: 0, onAuthenticated });
  }
  const stop = () => {
    void gui.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  gui.server.once("close", () => {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    redirect?.remove();
  });
  const address = `${gui.url}/#${sessionFragment((args.tab as Tab | undefined) ?? "", gui.token)}`;
  output.write(`human-hindsight library: ${address}\n`);
  if (remote) {
    output.write(
      `This is an SSH session, so open the library on your laptop.\n` +
        `1. In a second terminal on your laptop, forward the port:\n` +
        `   ${forwardCommand(Number(new URL(gui.url).port), env, deps.host)}\n` +
        `   (Use your usual SSH destination instead if you connect through an alias or a jump host.)\n` +
        `2. Open this address on your laptop:\n   ${address}\n`,
    );
  } else if (args.open !== false) {
    const opener = deps.openBrowser ?? ((file) => openWith(browserCommands(env, platform), file));
    redirect = writeRedirectFile(home, address);
    const opened = redirect ? await opener(redirect.file).catch(() => false) : false;
    // Nothing will load the page, so nothing will remove the file later.
    if (!opened) redirect?.remove();
    output.write(
      opened ? "Opened in your browser.\n" : "Open the address above in your browser.\n",
    );
  }
  output.write("Press Ctrl+C to stop.\n");
  return { ...gui, address };
}

export default defineCommand({
  meta: {
    name: "gui",
    description:
      "Browse reflections, preferences, prompts, and suggested subagents in your browser",
  },
  args: {
    ...sharedArgs,
    port: {
      type: "string",
      valueHint: "number",
      description: `Local port (${REMOTE_PORT} over SSH, otherwise automatic)`,
    },
    tab: {
      type: "string",
      valueHint: TABS.join("|"),
      description: "Open the prompts, preferences, or subagents overview",
    },
    open: {
      type: "boolean",
      default: true,
      description: "Open your browser (use --no-open to print the address only)",
    },
  },
  async run({ args }) {
    try {
      await runGui(args);
    } catch (err) {
      console.error(
        isAddressInUse(err)
          ? `Port ${args.port} is already in use. Choose another --port or use --port 0 for an available port.`
          : err instanceof Error
            ? err.message
            : "Could not start the GUI.",
      );
      process.exitCode = 1;
    }
  },
});
