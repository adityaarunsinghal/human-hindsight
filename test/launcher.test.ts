import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };

// The launcher is CommonJS with old syntax so it parses on old Node. Requiring it
// here does not start the application: it only runs when it is the main module.
const launcher = createRequire(import.meta.url)("../launcher/cli.cjs") as {
  isSupportedNode(version: unknown): boolean;
  requirementLine(version: unknown): string;
  detectManagers(o: Probe): { manager: { id: string } }[];
  upgradeMessage(o: Probe & { version: string }): string;
  loadFailureLine(error: unknown): string;
  run(
    proc: FakeProcess,
    deps?: { load?(): Promise<unknown>; isFile?(f: string): boolean },
  ): Promise<void>;
};

interface Probe {
  env: Record<string, string | undefined>;
  platform: string;
  execPath: string;
  isFile(file: string): boolean;
}

interface FakeProcess {
  versions: { node: string };
  env: Record<string, string>;
  platform: string;
  execPath: string;
  stderr: { write(text: string): void };
  exitCode?: number;
}

describe("Node version decision", () => {
  it.each([
    ["18.20.2", false],
    ["22.12.0", false],
    ["22.13.0", true],
    ["23.3.0", false],
    ["23.4.0", true],
    ["24.0.0", true],
    ["24.0.0-rc.1", true],
    ["25.0.0-nightly20260101abcdef", true],
    ["24.16.0+build.7", true],
    ["21.99.0", false],
    ["100.0.0", true],
    ["v24.0.0", false],
    ["24.0", false],
    ["", false],
    ["garbage", false],
    [undefined, false],
  ])("%s supported: %s", (version, expected) => {
    expect(launcher.isSupportedNode(version)).toBe(expected);
  });
});

describe("requirement line", () => {
  // The rule `engines` states, in words. Every refused version gets the same exact rule.
  const RULE = "Node.js 22.13 or newer in the 22 line, or 23.4 or newer";
  it.each([
    "18.20.2",
    "20.18.1",
    "21.7.3",
    "22.12.0",
    "23.0.0",
    "23.3.0",
    "",
  ])("says exactly what is accepted for %j, in one line", (version) => {
    const line = launcher.requirementLine(version);
    expect(line).toBe(
      `Human Hindsight needs ${RULE}; you have ${version || "an unknown version"}.`,
    );
    expect(line).not.toContain("\n");
  });

  it("states the same versions as engines in package.json", () => {
    expect(pkg.engines.node).toBe("^22.13.0 || >=23.4.0");
    for (const [version, accepted] of [
      ["22.13.0", true],
      ["22.99.0", true],
      ["23.0.0", false],
      ["23.3.9", false],
      ["23.4.0", true],
      ["24.0.0", true],
    ] as const)
      expect(launcher.isSupportedNode(version), version).toBe(accepted);
  });
});

// A fake PATH: each case lists the executables present in /fake/bin.
function probe(
  commands: string[],
  o: { env?: Record<string, string>; execPath?: string; files?: string[] } = {},
): Probe {
  const files = new Set([...commands.map((name) => `/fake/bin/${name}`), ...(o.files ?? [])]);
  return {
    env: { PATH: "/fake/empty:/fake/bin/", HOME: "/fake/home", ...o.env },
    platform: "linux",
    execPath: o.execPath ?? "/usr/local/bin/node",
    isFile: (file) => files.has(file),
  };
}

const messageCases: [string, Probe][] = [
  ["none", probe([])],
  ["fnm", probe(["fnm"])],
  ["nvm-loaded", probe([], { env: { NVM_BIN: "/fake/home/.nvm/versions/node/v18.20.2/bin" } })],
  ["nvm-script", probe([], { files: ["/fake/home/.nvm/nvm.sh"] })],
  ["mise", probe(["mise"])],
  ["volta", probe(["volta"])],
  ["asdf", probe(["asdf"])],
  ["brew", probe(["brew"])],
  [
    // The manager that owns the running Node comes first; the others follow in order.
    "all-owned-by-asdf",
    probe(["fnm", "mise", "volta", "asdf", "brew"], {
      env: { NVM_BIN: "/fake/nvm/bin" },
      execPath: "/fake/home/.asdf/installs/nodejs/18.20.2/bin/node",
    }),
  ],
];

describe("upgrade message", () => {
  it.each(messageCases)("golden: %s", async (name, setup) => {
    const text = launcher.upgradeMessage({ version: "18.20.2", ...setup });
    await expect(text).toMatchFileSnapshot(`./golden/launcher/${name}.txt`);
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe(
      "Human Hindsight needs Node.js 22.13 or newer in the 22 line, or 23.4 or newer; you have 18.20.2.",
    );
    // One-off commands only: nothing that changes a global default.
    expect(text).not.toMatch(/--global|\bdefault\b.*alias|volta install|nvm alias|mise use/);
    expect(text).toContain("npx -y -p node@24 -p human-hindsight@latest human-hindsight");
    expect(lines.at(-1)).toContain("https://nodejs.org/en/download");
  });

  it("detects each manager on the fake PATH and orders the owner first", () => {
    const ids = (p: Probe) => launcher.detectManagers(p).map((entry) => entry.manager.id);
    expect(ids(probe([]))).toEqual([]);
    expect(ids(probe(["brew", "mise"]))).toEqual(["mise", "brew"]);
    expect(
      ids(probe(["brew", "mise"], { execPath: "/opt/homebrew/Cellar/node@18/18.20.2/bin/node" })),
    ).toEqual(["brew", "mise"]);
    expect(ids(probe([], { env: { ASDF_DIR: "/fake/asdf" } }))).toEqual(["asdf"]);
    expect(ids(probe([], { env: { NVM_DIR: "/fake/nvm" }, files: ["/fake/nvm/nvm.sh"] }))).toEqual([
      "nvm",
    ]);
    // A command outside PATH is not offered.
    expect(ids({ ...probe(["mise"]), env: { PATH: "/elsewhere" } })).toEqual([]);
  });

  it("finds Windows commands through PATHEXT", () => {
    const files = new Set(["C:\\tools\\volta.EXE"]);
    const found = launcher.detectManagers({
      env: { Path: "C:\\tools", PATHEXT: ".COM;.EXE" },
      platform: "win32",
      execPath: "C:\\node\\node.exe",
      isFile: (file) => files.has(file),
    });
    expect(found.map((entry) => entry.manager.id)).toEqual(["volta"]);
  });
});

describe("failed application load", () => {
  it.each([
    [
      Object.assign(
        new Error("Cannot find module '/x/dist/cli.js' imported from /x/launcher/cli.cjs"),
        {
          code: "ERR_MODULE_NOT_FOUND",
        },
      ),
      "Human Hindsight could not start: Cannot find module '/x/dist/cli.js' imported from /x/launcher/cli.cjs. Reinstall human-hindsight and try again.",
    ],
    [
      new SyntaxError("Unexpected token '.'\n    at compileSourceTextModule (node:internal)"),
      "Human Hindsight could not start: Unexpected token '.'.",
    ],
    ["a thrown string.", "Human Hindsight could not start: a thrown string."],
    [undefined, "Human Hindsight could not start: undefined."],
  ])("prints one line with the reason", (error, line) => {
    expect(launcher.loadFailureLine(error)).toBe(line);
    expect(launcher.loadFailureLine(error)).not.toContain("\n");
  });
});

describe("run", () => {
  function fakeProcess(version: string): FakeProcess & { text(): string } {
    let text = "";
    return {
      versions: { node: version },
      env: { PATH: "/fake/bin" },
      platform: "linux",
      execPath: "/fake/node",
      stderr: {
        write(chunk: string) {
          text += chunk;
        },
      },
      text: () => text,
    };
  }

  it("prints the message and exits 1 without loading the application on old Node", async () => {
    const proc = fakeProcess("18.20.2");
    let loaded = false;
    await launcher.run(proc, {
      load: async () => {
        loaded = true;
      },
      isFile: () => false,
    });
    expect(loaded).toBe(false);
    expect(proc.exitCode).toBe(1);
    expect(proc.text()).toMatch(
      /^Human Hindsight needs Node\.js 22\.13 or newer in the 22 line, or 23\.4 or newer; you have 18\.20\.2\.\n/,
    );
  });

  it("loads the application once on a supported Node and leaves the exit code alone", async () => {
    const proc = fakeProcess("24.0.0-rc.1");
    let loads = 0;
    await launcher.run(proc, {
      load: async () => {
        loads += 1;
      },
    });
    expect(loads).toBe(1);
    expect(proc.exitCode).toBeUndefined();
    expect(proc.text()).toBe("");
  });

  it("turns a failed load into one line and exit code 1", async () => {
    const proc = fakeProcess("24.0.0");
    await launcher.run(proc, {
      load: () => Promise.reject(new Error("bundle exploded\n    at stack frame")),
    });
    expect(proc.exitCode).toBe(1);
    expect(proc.text()).toBe("Human Hindsight could not start: bundle exploded.\n");
  });
});
