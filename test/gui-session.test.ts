import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  chooseSessionKey,
  forgetSessionKey,
  KEY_ITEM,
  type KeyStorage,
  PLAIN_GUI_COMMAND,
  RESTART_COMMAND_ITEM,
  rememberRestartCommand,
  sessionApi,
  sessionHelp,
  sessionRecovery,
} from "../src/gui/session.js";
import { guiHarness, harnessFetch } from "./gui-harness.js";

/**
 * Where the page takes its session key from, decided without a browser: the
 * address fragment, then this tab's `sessionStorage`, injected here as a map.
 * A reload keeps working because the key is stored per tab; a refused key is
 * forgotten so the page can say how to get back in.
 */

const OLD = "a".repeat(64);
const NEW = "b".repeat(64);

function memoryStorage(items: Record<string, string> = {}) {
  const map = new Map(Object.entries(items));
  const storage: KeyStorage = {
    getItem: (name) => map.get(name) ?? null,
    setItem: (name, value) => void map.set(name, value),
    removeItem: (name) => void map.delete(name),
  };
  return { storage, map };
}

/** Storage the browser refuses to open (blocked site data): every call throws. */
const blocked: KeyStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("SecurityError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe("chooseSessionKey", () => {
  it.each([
    // [label, address fragment, stored key, chosen key, source, address to show, stored after]
    ["a key in the address is used and stored", `#token=${NEW}`, null, NEW, "address", "", NEW],
    [
      "the address wins over a stored key",
      `#preferences&token=${NEW}`,
      OLD,
      NEW,
      "address",
      "preferences",
      NEW,
    ],
    [
      "without one in the address, the stored key is used",
      "#preferences",
      OLD,
      OLD,
      "tab",
      null,
      OLD,
    ],
    ["a plain reload with no fragment uses the stored key", "", OLD, OLD, "tab", null, OLD],
    [
      "an empty key in the address is removed and the stored one used",
      "#token=",
      OLD,
      OLD,
      "tab",
      "",
      OLD,
    ],
    [
      "a new tab with no fragment and nothing stored has no key",
      "",
      null,
      null,
      "none",
      null,
      null,
    ],
  ] as const)("%s", (_label, hash, stored, token, source, strippedHash, after) => {
    const { storage, map } = memoryStorage(stored ? { [KEY_ITEM]: stored } : {});
    expect(chooseSessionKey(hash, storage)).toEqual({ token, source, strippedHash });
    expect(map.get(KEY_ITEM) ?? null).toBe(after);
  });

  it("still takes the key from the address when the tab has no usable storage", () => {
    expect(chooseSessionKey(`#token=${NEW}`, blocked)).toEqual({
      token: NEW,
      source: "address",
      strippedHash: "",
    });
    expect(chooseSessionKey(`#token=${NEW}`, null).token).toBe(NEW);
    expect(chooseSessionKey("", blocked)).toEqual({
      token: null,
      source: "none",
      strippedHash: null,
    });
  });
});

describe("forgetSessionKey", () => {
  it("clears a stored key the server refused", () => {
    const { storage, map } = memoryStorage({ [KEY_ITEM]: OLD });
    forgetSessionKey(storage, OLD);
    expect(map.has(KEY_ITEM)).toBe(false);
    // The next load in this tab has no key, so nothing is sent.
    expect(chooseSessionKey("", storage).token).toBeNull();
  });

  it("keeps a newer key when a request made with the old one is refused late", () => {
    const { storage, map } = memoryStorage({ [KEY_ITEM]: NEW });
    forgetSessionKey(storage, OLD);
    expect(map.get(KEY_ITEM)).toBe(NEW);
  });

  it("does not throw when the tab has no usable storage", () => {
    expect(() => forgetSessionKey(blocked, OLD)).not.toThrow();
    expect(() => forgetSessionKey(null, OLD)).not.toThrow();
  });
});

describe("sessionRecovery", () => {
  const stored = "npx human-hindsight@latest gui --home '/synthetic/home'";
  // [refused, saved command, text, command]
  it.each([
    [false, null, /^This page needs the address printed in your terminal/, PLAIN_GUI_COMMAND],
    [false, stored, /^This page needs the address/, stored],
    [
      true,
      stored,
      /^The library was restarted.*Open the new address printed in your terminal\./,
      stored,
    ],
    [true, null, /^The library was restarted/, PLAIN_GUI_COMMAND],
  ] as const)("refused %s, saved command %s", (refused, saved, text, command) => {
    const help = sessionHelp(refused, saved);
    expect(help.text).toMatch(text);
    expect(help.command).toBe(command);
    // Every command on the page has the same form.
    expect(help.command.startsWith("npx human-hindsight@latest gui")).toBe(true);
    // Without the saved command the page cannot know the folder, so it says how to add it.
    expect(help.text.includes("add --home")).toBe(saved === null);
  });

  it("reads the command this tab saved, and survives blocked storage", () => {
    const { storage } = memoryStorage();
    rememberRestartCommand(storage, stored);
    expect(sessionRecovery(true, storage)).toEqual(sessionHelp(true, stored));
    expect(sessionRecovery(false, memoryStorage().storage)).toEqual(sessionHelp(false, null));
    const { storage: saved } = memoryStorage({ [RESTART_COMMAND_ITEM]: stored });
    expect(sessionRecovery(false, saved).command).toBe(stored);
    expect(sessionRecovery(true, blocked).command).toBe(PLAIN_GUI_COMMAND);
  });
});

describe("sessionApi", () => {
  it("passes a refused key to the page, and only a refused one", async () => {
    const gui = guiHarness(path.join(os.tmpdir(), "hindsight-no-such-home"));
    const { fetchImpl } = harnessFetch(gui);
    const refused: string[] = [];
    const onRefused = (key: string) => void refused.push(key);
    await sessionApi(OLD, fetchImpl, onRefused).send("/api/library");
    expect(refused).toEqual([OLD]);
    await sessionApi(gui.token, fetchImpl, onRefused).send("/api/nothing-here");
    expect(refused).toEqual([OLD]);
  });
});
