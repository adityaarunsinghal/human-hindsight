import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { atomicWriteFilePrivate } from "../core/fsutil.js";
import { SESSION_HEADER } from "./session.js";

/**
 * gui/handoff.ts: one port for the library view on a remote machine.
 *
 * A laptop reaches a remote machine's view through a forwarded port, so the
 * port has to stay the same from run to run. The view a reflection starts
 * outlives its run, though, and would still hold that port when the next
 * reflection starts. So that view records its port and session key in the
 * data home (owner-only, like everything there), and the next one asks it to
 * stop before taking the port. The key is what the request needs, so only this
 * person can stop it.
 */

interface Handoff {
  port: number;
  token: string;
}

const handoffFile = (home: string) => path.join(home, "runtime", "live-library.json");

export function isAddressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE";
}

function readHandoff(home: string): Handoff | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(handoffFile(home), "utf8")) as Partial<Handoff>;
    return typeof parsed.port === "number" && typeof parsed.token === "string"
      ? { port: parsed.port, token: parsed.token }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Record the running view. A failure only means the next run cannot take the port over. */
export function recordLiveLibrary(home: string, view: Handoff): void {
  try {
    atomicWriteFilePrivate(handoffFile(home), `${JSON.stringify(view)}\n`);
  } catch {
    // The view works without its record.
  }
}

/** Remove the record once its view has stopped, unless a newer view wrote its own. */
export function forgetLiveLibrary(home: string, token: string): void {
  try {
    if (readHandoff(home)?.token === token) fs.rmSync(handoffFile(home), { force: true });
  } catch {
    // A leftover record points at a closed port and is ignored by the next run.
  }
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (free: boolean) => {
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(300, () => done(false));
    socket.once("connect", () => done(false));
    socket.once("error", () => done(true));
  });
}

/**
 * Ask the view an earlier reflection left on `port` to stop, and wait briefly
 * for the port. Does nothing when the port is held by anything else: the
 * caller then uses another port and says so.
 */
export async function retireLiveLibrary(
  home: string,
  port: number,
  request: typeof fetch = fetch,
): Promise<void> {
  const previous = readHandoff(home);
  if (!previous || previous.port !== port) return;
  try {
    await request(`http://127.0.0.1:${port}/api/shutdown`, {
      method: "POST",
      headers: { [SESSION_HEADER]: previous.token },
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // Already gone, or not ours any more.
  }
  for (let i = 0; i < 20; i++) {
    if (await portIsFree(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
