import { fork } from "node:child_process";
import { type BatchUpdate, LiveBatches } from "./live-batches.js";
import { sessionFragment } from "./session.js";

export const LIBRARY_WORKER = "--internal-live-library";
const AFTER_EXIT_MS = 30 * 60_000;

/** The launcher and npx can exit while the printed address still works. */
export interface LiveLibrary {
  address: string;
  update(event: BatchUpdate): void;
}

export function startLiveLibrary(home: string): Promise<LiveLibrary> {
  return new Promise((resolve, reject) => {
    const child = fork(new URL(import.meta.url), [LIBRARY_WORKER, home], {
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
export async function serveLiveLibrary(home: string): Promise<void> {
  const { startGuiServer } = await import("./server.js");
  const liveBatches = new LiveBatches();
  const gui = await startGuiServer({ home, liveBatches });
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
