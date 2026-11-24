/**
 * One port for the library view on a remote machine (`src/gui/handoff.ts`),
 * with real servers on loopback: the view a reflection left behind stops when
 * the next one asks with its session key, and nothing else can stop it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordLiveLibrary, retireLiveLibrary } from "../src/gui/handoff.js";
import { type GuiServer, startGuiServer } from "../src/gui/server.js";
import { SESSION_HEADER } from "../src/gui/session.js";

const dirs: string[] = [];
const servers: GuiServer[] = [];
function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-handoff-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((gui) => gui.close().catch(() => {})));
  while (dirs.length) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const record = (home: string) => path.join(home, "runtime", "live-library.json");
const closed = (gui: GuiServer) =>
  new Promise<void>((resolve) => gui.server.once("close", () => resolve()));
const post = (gui: GuiServer, token?: string) =>
  fetch(`${gui.url}/api/shutdown`, {
    method: "POST",
    headers: token ? { [SESSION_HEADER]: token } : {},
  });

describe("handing the port to the next view", () => {
  it("a recorded view stops when the next one asks, and its port is free again", async () => {
    const home = tmpHome();
    const first = await startGuiServer({ home, handoff: true });
    servers.push(first);
    const port = Number(new URL(first.url).port);
    recordLiveLibrary(home, { port, token: first.token });
    // Owner-only, like everything else in the data home.
    expect(fs.statSync(record(home)).mode & 0o777).toBe(0o600);
    const stopped = closed(first);
    await retireLiveLibrary(home, port);
    await stopped;
    // The same port serves the next view.
    const next = await startGuiServer({ home, handoff: true, port });
    servers.push(next);
    expect(new URL(next.url).port).toBe(String(port));
  });

  it("the request needs the view's own session key", async () => {
    const home = tmpHome();
    const gui = await startGuiServer({ home, handoff: true });
    servers.push(gui);
    expect((await post(gui)).status).toBe(403);
    expect((await post(gui, "0".repeat(64))).status).toBe(403);
    // Still serving.
    expect((await fetch(`${gui.url}/`)).status).toBe(200);
    const stopped = closed(gui);
    expect((await post(gui, gui.token)).status).toBe(204);
    await stopped;
  });

  it("a view opened with the gui command cannot be stopped this way", async () => {
    const home = tmpHome();
    const gui = await startGuiServer({ home });
    servers.push(gui);
    expect((await post(gui, gui.token)).status).toBe(405);
    expect((await fetch(`${gui.url}/`)).status).toBe(200);
  });

  it("does nothing for a port that another view, or another program, holds", async () => {
    const home = tmpHome();
    const gui = await startGuiServer({ home, handoff: true });
    servers.push(gui);
    const port = Number(new URL(gui.url).port);
    // No record at all, then a record of a different port.
    await retireLiveLibrary(home, port);
    recordLiveLibrary(home, { port: port + 1, token: gui.token });
    await retireLiveLibrary(home, port);
    expect((await fetch(`${gui.url}/`)).status).toBe(200);
  });
});
