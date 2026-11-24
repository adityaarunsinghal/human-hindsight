import { fork } from "node:child_process";
import {
  forgetLiveLibrary,
  isAddressInUse,
  recordLiveLibrary,
  retireLiveLibrary,
} from "./handoff.js";
import { type BatchUpdate, LiveBatches } from "./live-batches.js";
import { sessionFragment } from "./session.js";

export const LIBRARY_WORKER = "--internal-live-library";
const AFTER_EXIT_MS = 30 * 60_000;

/** The launcher and npx can exit while the printed address still works. */
export interface LiveLibrary {
  address: string;
  update(event: BatchUpdate): void;
}

/** `port`: the one to use when it is free, so a forwarded port keeps working from run to run. */
export function startLiveLibrary(home: string, o: { port?: number } = {}): Promise<LiveLibrary> {
  return new Promise((resolve, reject) => {
    const child = fork(new URL(import.meta.url), [LIBRARY_WORKER, home, String(o.port ?? 0)], {
      detached: true,
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const fail = () => {
      clearTimeout(timer);
      child.kill();
      reject(new Error("Could not start the local library."));
    };
    const timer = setTimeout(fail, 5000);
    child.once("error", fail);
    child.once("exit", fail);
    child.once("message", (address) => {
      if (typeof address !== "string") return fail();
      clearTimeout(timer);
      child.off("exit", fail);
      child.unref();
      child.channel?.unref();
      resolve({
        address,
        update(event) {
          if (child.connected) child.send(event, () => {});
        },
      });
    });
  });
}

/** The worker learns when its CLI exits from the private IPC connection. */
export async function serveLiveLibrary(home: string, port = 0): Promise<void> {
  const { startGuiServer } = await import("./server.js");
  const liveBatches = new LiveBatches();
  const start = (wanted: number) =>
    startGuiServer({ home, liveBatches, port: wanted, handoff: true });
  // The view an earlier reflection left on this port stops first.
  if (port) await retireLiveLibrary(home, port);
  const gui = await start(port).catch((error: unknown) => {
    if (!port || !isAddressInUse(error)) throw error;
    return start(0);
  });
  recordLiveLibrary(home, { port: Number(new URL(gui.url).port), token: gui.token });
  gui.server.once("close", () => forgetLiveLibrary(home, gui.token));
  const stopLater = () => {
    liveBatches.update({ kind: "interrupted" });
    liveBatches.update({ kind: "finished" });
    setTimeout(() => void gui.close(), AFTER_EXIT_MS).unref();
  };
  if (!process.connected || !process.send) {
    await gui.close();
    return;
  }
  process.on("message", (message) => liveBatches.update(message as BatchUpdate));
  process.once("disconnect", stopLater);
  process.send(`${gui.url}/#${sessionFragment("preferences", gui.token)}`);
}
