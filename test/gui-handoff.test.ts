/**
 * The library link a reflection prints, and the record its view leaves so the
 * next view on a remote machine can take the same port. The hand-off itself,
 * with real servers, is in gui-handoff.smoke.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { libraryLinkLines } from "../src/commands/distill.js";
import { forwardingLines, REMOTE_PORT } from "../src/commands/gui.js";
import { forgetLiveLibrary, recordLiveLibrary } from "../src/gui/handoff.js";

const dirs: string[] = [];
function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-handoff-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const record = (home: string) => path.join(home, "runtime", "live-library.json");

describe("the record a view leaves for the next one", () => {
  it("the record is removed with its own view, and never a newer view's", () => {
    const home = tmpHome();
    recordLiveLibrary(home, { port: 4317, token: "old" });
    recordLiveLibrary(home, { port: 4317, token: "new" });
    forgetLiveLibrary(home, "old");
    expect(JSON.parse(fs.readFileSync(record(home), "utf8"))).toEqual({ port: 4317, token: "new" });
    forgetLiveLibrary(home, "new");
    expect(fs.existsSync(record(home))).toBe(false);
  });
});

describe("the lines that hand over the library link", () => {
  const address = "http://127.0.0.1:4317/#preferences&token=k";
  it("say what is there now and what is still to come", () => {
    const lines = libraryLinkLines({
      address,
      preferences: true,
      arriving: ["summaries", "prompts"],
      width: 200,
      color: false,
    });
    expect(lines).toEqual([
      "Your reflections are open while this runs:",
      `  ${address}`,
      "  Your preferences are there now. Summaries and prompts arrive as they finish. The link works for 30 minutes after this run.",
    ]);
  });

  it("say only what is true when nothing more is coming", () => {
    const lines = libraryLinkLines({
      address,
      preferences: false,
      arriving: [],
      width: 200,
      color: false,
    });
    expect(lines).toEqual([
      "Your reflections are open:",
      `  ${address}`,
      "  Your prompts are there now. The link works for 30 minutes after this run.",
    ]);
  });

  it("on a remote machine give the forwarding command and the one line that replaces it", () => {
    const env = { SSH_CONNECTION: "192.0.2.10 50000 198.51.100.7 22", LOGNAME: "sample-user" };
    const lines = libraryLinkLines({
      address,
      preferences: true,
      arriving: ["prompts"],
      width: 200,
      color: false,
      forward: forwardingLines(REMOTE_PORT, env),
    });
    expect(lines.slice(3)).toEqual([
      "  This is a remote machine. On your laptop, forward the port first:",
      `    ssh -N -L 127.0.0.1:${REMOTE_PORT}:127.0.0.1:${REMOTE_PORT} -- sample-user@198.51.100.7`,
      "    (Use your usual SSH destination instead if you connect through an alias or a jump host.)",
      "    To skip this from now on, add this line under the host in ~/.ssh/config on your laptop:",
      `      LocalForward ${REMOTE_PORT} 127.0.0.1:${REMOTE_PORT}`,
    ]);
    // Another port gets the command only: the configuration line would not keep working.
    expect(forwardingLines(50123, env).join("\n")).not.toContain("LocalForward");
  });

  it("the address is a terminal link only where color is on", () => {
    const colored = libraryLinkLines({
      address,
      preferences: true,
      arriving: [],
      width: 200,
      color: true,
    });
    expect(colored[1]).toBe(`  \u001b]8;;${address}\u001b\\${address}\u001b]8;;\u001b\\`);
  });
});
