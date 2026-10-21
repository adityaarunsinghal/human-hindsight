import { execFile } from "node:child_process";
import type { Writable } from "node:stream";
import { defineCommand } from "citty";
import { type GuiServer, startGuiServer } from "../gui/server.js";
import { resolvePaths, sharedArgs } from "./_shared.js";

/** The OS browser launcher, without an npm dependency or shell interpolation. */
function openBrowser(url: string): Promise<boolean> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (!command) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(command, [url], { timeout: 5_000 }, (err) => resolve(!err));
  });
}

export async function runGui(
  args: { home?: string; port?: string; open?: boolean },
  deps: { output?: Writable; openBrowser?: (url: string) => Promise<boolean> } = {},
): Promise<GuiServer> {
  if (args.port !== undefined && !/^\d+$/.test(args.port)) {
    throw new Error("--port must be an integer between 0 and 65535.");
  }
  const gui = await startGuiServer({
    home: resolvePaths(args).home,
    port: args.port === undefined ? 0 : Number(args.port),
  });
  const output = deps.output ?? process.stdout;
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
  });
  output.write(`human-hindsight library: ${gui.url}\nPress Ctrl+C to stop.\n`);
  if (args.open !== false) {
    const opened = await (deps.openBrowser ?? openBrowser)(gui.url).catch(() => false);
    if (!opened) output.write("Could not open a browser automatically; open the address above.\n");
  }
  return gui;
}

export default defineCommand({
  meta: {
    name: "gui",
    description: "Open a lightweight local browser for viewing and copying your prompt library",
  },
  args: {
    ...sharedArgs,
    port: { type: "string", description: "Local port (default: choose an available port)" },
    open: {
      type: "boolean",
      default: true,
      description: "Open your browser (use --no-open to print the URL only)",
    },
  },
  async run({ args }) {
    try {
      await runGui(args);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      console.error(
        code === "EADDRINUSE"
          ? `Port ${args.port} is already in use. Choose another --port or omit it for an available port.`
          : err instanceof Error
            ? err.message
            : "Could not start the GUI.",
      );
      process.exitCode = 1;
    }
  },
});
