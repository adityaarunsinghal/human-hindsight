import { spawn as nodeSpawn } from "node:child_process";
import type { Writable } from "node:stream";
import type { TerminalOutput } from "./mode.js";

/** The clipboard command for a platform (Wayland preferred over X11 on Linux). */
export function clipboardCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "pbcopy", args: [] };
  if (platform === "win32") return { cmd: "clip", args: [] };
  if (env.WAYLAND_DISPLAY) return { cmd: "wl-copy", args: [] };
  return { cmd: "xclip", args: ["-selection", "clipboard"] };
}

/** Minimal spawn surface the helper needs (injectable). */
export type ClipboardSpawn = (
  cmd: string,
  args: string[],
  input: string,
) => Promise<{ code: number | null; error?: string }>;

const defaultSpawn: ClipboardSpawn = (cmd, args, input) =>
  new Promise((resolve) => {
    const child = nodeSpawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    // A clipboard tool that HANGS (xclip holding the selection) must never
    // keep this process alive: unref the child and destroy stdin on settle,
    // so even when the copy times out upstream the event loop can drain.
    child.unref();
    let settled = false;
    const settle = (v: { code: number | null; error?: string }) => {
      if (settled) return;
      settled = true;
      child.stdin?.destroy();
      resolve(v);
    };
    child.on("error", (err) => settle({ code: null, error: err.message }));
    // `exit` as well as `close`: a clipboard tool that forks a helper holding the
    // pipe would otherwise keep this promise open (same trap as the runner spawn).
    child.on("close", (code) => settle({ code }));
    child.on("exit", (code) => settle({ code }));
    // The tool may exit before the text is fully written (ENOENT, no display),
    // which raises EPIPE on stdin; with no listener that is an uncaught throw.
    child.stdin?.on("error", () => {});
    // Once the block has flushed into the pipe, release the stdin handle too:
    // it is the one remaining ref'd handle when the tool hangs, and the data
    // already in the pipe stays readable by the tool regardless.
    child.stdin?.once("finish", () =>
      (child.stdin as unknown as { unref?: () => void })?.unref?.(),
    );
    child.stdin?.write(input);
    child.stdin?.end();
  });

/**
 * How long to wait for a clipboard tool before giving up.
 *
 * A clipboard tool can HANG rather than fail: `xclip` with no usable X display
 * holds the selection indefinitely instead of exiting. The copy offer is the last
 * thing a distill run does, so that turns a finished run into an apparent hang
 * long after all the work is saved. Copying is a convenience, so a short bound is
 * the right trade: the block is already printed on screen either way.
 */
const CLIPBOARD_TIMEOUT_MS = 5_000;

export interface ClipboardResult {
  ok: boolean;
  tool: string;
  error?: string;
  /** OSC 52 has no acknowledgement. The caller also prints the text for manual copying. */
  terminalAttempted?: boolean;
}

/** An SSH session: a clipboard tool found here belongs to the remote machine, not the person's. */
export function isSshSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SSH_TTY || env.SSH_CONNECTION || env.SSH_CLIENT);
}

/** The terminal clipboard request (OSC 52): the person's own terminal sets its clipboard. */
function terminalClipboardRequest(text: string): string {
  return `\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`;
}

/**
 * Copy text to the clipboard. Reports which way was used, or why not.
 *
 * Over SSH the local clipboard tool would copy on the remote machine and
 * report success for a clipboard the person cannot paste from, so it is never
 * used there. Instead, when stdout is a terminal, the terminal clipboard
 * request is sent; it has no acknowledgement, so the result says it was
 * attempted and the caller prints the text as well. Outside SSH the platform
 * tool is used, bounded by a timeout.
 */
export async function copyToClipboard(
  text: string,
  io: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    spawn?: ClipboardSpawn;
    timeoutMs?: number;
    output?: Writable;
  } = {},
): Promise<ClipboardResult> {
  const platform = io.platform ?? process.platform;
  const env = io.env ?? process.env;
  const output: TerminalOutput = io.output ?? process.stdout;
  const { cmd, args } = clipboardCommand(platform, env);
  const spawn = io.spawn ?? defaultSpawn;
  const timeoutMs = io.timeoutMs ?? CLIPBOARD_TIMEOUT_MS;

  if (isSshSession(env)) {
    const terminal =
      output.isTTY === true &&
      env.TERM !== "dumb" &&
      env.HUMAN_HINDSIGHT_PLAIN !== "1" &&
      (!env.CI || /^(0|false)$/i.test(env.CI));
    if (!terminal) {
      return {
        ok: false,
        tool: "OSC 52",
        error: "this SSH session has no terminal to pass a clipboard request to",
      };
    }
    output.write(terminalClipboardRequest(text));
    return {
      ok: false,
      tool: "OSC 52",
      terminalAttempted: true,
      error: "terminal clipboard request sent",
    };
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ code: null; error: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ code: null, error: `${cmd} timed out after ${timeoutMs}ms` }),
      timeoutMs,
    );
  });

  try {
    const result = await Promise.race([spawn(cmd, args, text), timeout]);
    if (result.code === 0) return { ok: true, tool: cmd };
    return {
      ok: false,
      tool: cmd,
      error: result.error ?? `${cmd} exited with code ${result.code}`,
    };
  } catch (error) {
    return { ok: false, tool: cmd, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
