import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { makeOpenCodeRunner, parseOpenCodeOutput, runOpenCode } from "../src/runners/opencode.js";
import {
  configureOpenCode,
  OPENCODE_AGENT,
  providerConfig,
} from "../src/runners/opencode-config.js";
import { parseRunnerMode, resolveRunner } from "../src/runners/registry.js";
import {
  defaultIo,
  type RunnerIo,
  type SpawnOptions,
  type SpawnResult,
} from "../src/runners/shared.js";

const schema = z.object({ answer: z.string() });
const success: SpawnResult = { code: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
const answer = (value = '{"answer":"ready"}', sessionID = "ses_test") =>
  JSON.stringify({
    type: "text",
    sessionID,
    part: { id: "prt_1", messageID: "msg_1", text: value, time: { end: 1 } },
  });
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-opencode-runner-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function fake(major: 1 | 2, run: RunnerIo["spawn"]): RunnerIo {
  return {
    which: () => "/fake/opencode",
    async spawn(bin, args, opts) {
      if (args[0] === "--version")
        return { ...success, stdout: major === 1 ? "1.19.4\n" : "opencode v2.1.3\n" };
      if (args.includes("--help"))
        return {
          ...success,
          stdout: `--format --agent --title ${major === 1 ? "--pure" : "--standalone"}`,
        };
      return run(bin, args, opts);
    },
  };
}

describe("OpenCode runner", () => {
  it.each([
    1, 2,
  ] as const)("uses a private configuration, stdin, model passthrough, and no tools on v%i", async (major) => {
    let scratch = "";
    const io = fake(major, async (_bin, args, opts) => {
      scratch = opts.cwd ?? "";
      expect(args).toContain(major === 1 ? "--pure" : "--standalone");
      expect(args).toContain("provider/model");
      expect(args).not.toContain("--auto");
      expect(opts.processGroup).toBe(true);
      expect(opts.input).toContain("source content");
      expect(opts.input).toContain("Respond ONLY with JSON matching this schema");
      expect(opts.env?.PWD).toBe(scratch);
      expect(opts.env?.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
      expect(opts.env?.OPENCODE_CONFIG_CONTENT).toBeUndefined();
      const file = opts.env?.OPENCODE_CONFIG ?? "";
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(config.instructions).toEqual([]);
      if (major === 1) {
        expect(config.agent[OPENCODE_AGENT].permission).toEqual({ "*": "deny" });
        expect(config.tools).toEqual({ "*": false });
        expect(config.plugin).toEqual([]);
      } else {
        expect(config.agents[OPENCODE_AGENT].permissions).toEqual([
          { action: "*", resource: "*", effect: "deny" },
        ]);
        expect(config.plugins).toEqual([]);
      }
      return { ...success, stdout: answer() };
    });
    expect(
      await runOpenCode({ prompt: "source content", schema, model: "provider/model" }, io),
    ).toEqual({ answer: "ready" });
    expect(fs.existsSync(scratch)).toBe(false);
  });

  it("parses only final assistant text and deduplicates event replays", () => {
    const events = [
      {
        type: "text",
        sessionID: "ses_a",
        part: { id: "p0", messageID: "old", text: "Earlier prose" },
      },
      { type: "reasoning", part: { text: "private reasoning" } },
      { type: "tool_use", part: { state: { output: '{"answer":"wrong"}' } } },
      { type: "text", part: { id: "p1", messageID: "new", text: '{"answer":' } },
      { type: "text", part: { id: "p1", messageID: "new", text: '{"answer":' } },
      { type: "text", part: { partID: "p2", messageID: "new", text: '"right"}' } },
      { type: "step_finish", part: { id: "step", cost: 0.02 } },
      { type: "step_finish", part: { id: "step", cost: 0.02 } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    expect(parseOpenCodeOutput(`some wrapper progress\n${events}`)).toEqual({
      text: '{"answer":"right"}',
      error: "",
      sessions: ["ses_a"],
      cost: 0.02,
    });
  });

  it("validates JSON, retries once, and includes the corrective instruction", async () => {
    const inputs: string[] = [];
    const io = fake(2, async (_bin, _args, opts) => {
      inputs.push(opts.input);
      return {
        ...success,
        stdout: answer(inputs.length === 1 ? '{"answer":42}' : '```json\n{"answer":"fixed"}\n```'),
      };
    });
    expect(await runOpenCode({ prompt: "p", schema }, io)).toEqual({ answer: "fixed" });
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toContain("Your previous response could not be used");
  });

  it.each([
    [{ ...success, code: 1, stderr: "Please authenticate" }, "cli-error"],
    [
      { ...success, stdout: '{"type":"error","error":{"data":{"message":"Quota exhausted"}}}' },
      "cli-error",
    ],
    [{ ...success, timedOut: true }, "timeout"],
  ] as const)("does not retry process/provider failure %s", async (result, kind) => {
    let count = 0;
    await expect(
      runOpenCode(
        { prompt: "p", schema },
        fake(1, async () => {
          count++;
          return result;
        }),
      ),
    ).rejects.toMatchObject({ kind });
    expect(count).toBe(1);
  });

  it("fails unknown versions and missing binaries before a model call", async () => {
    await expect(
      runOpenCode(
        { prompt: "p", schema },
        {
          which: () => null,
          spawn: async () => {
            throw new Error("must not spawn");
          },
        },
      ),
    ).rejects.toMatchObject({ kind: "missing-binary" });
    await expect(
      runOpenCode(
        { prompt: "p", schema },
        {
          which: () => "/fake/opencode",
          spawn: async () => ({ ...success, stdout: "3.0.0" }),
        },
      ),
    ).rejects.toMatchObject({ kind: "cli-error" });
  });

  it("treats a spawn failure as fatal rather than retrying model validation", async () => {
    let calls = 0;
    await expect(
      runOpenCode(
        { prompt: "p", schema },
        fake(2, async () => {
          calls++;
          throw new Error("process could not start");
        }),
      ),
    ).rejects.toMatchObject({ kind: "cli-error" });
    expect(calls).toBe(1);
  });

  it("cleans up only IDs whose title and directory prove ownership", async () => {
    const data = path.join(root, "data/opencode");
    fs.mkdirSync(data, { recursive: true });
    vi.stubEnv("XDG_DATA_HOME", path.dirname(data));
    const db = new DatabaseSync(path.join(data, "opencode.db"));
    db.exec("CREATE TABLE session_v2(id TEXT, title TEXT, directory TEXT, parent_id TEXT)");
    const deleted: string[] = [];
    const io = fake(2, async (_bin, args, opts) => {
      if (args[0] === "session") {
        deleted.push(args[2] ?? "");
        return success;
      }
      const title = args[args.indexOf("--title") + 1] ?? "";
      db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, NULL)").run(
        "ses_owned",
        title,
        opts.cwd ?? "",
      );
      db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, NULL)").run("ses_other", title, root);
      return {
        ...success,
        stdout: `${answer('{"answer":"ok"}', "ses_owned")}\n{"type":"step_finish","sessionID":"ses_other"}`,
      };
    });
    try {
      expect(await runOpenCode({ prompt: "p", schema }, io)).toEqual({ answer: "ok" });
      expect(deleted).toEqual(["ses_owned"]);
    } finally {
      db.close();
    }
  });

  it("probes capabilities once across multiple stage calls", async () => {
    const io = fake(2, async () => ({ ...success, stdout: answer() }));
    const spawn = vi.spyOn(io, "spawn");
    const runner = makeOpenCodeRunner(io);
    try {
      await runner.run({ prompt: "a", schema });
      await runner.run({ prompt: "b", schema });
      expect(spawn.mock.calls.filter((call) => call[1][0] === "--version")).toHaveLength(1);
    } finally {
      await runner.finalize?.();
    }
    expect(parseRunnerMode("OPENCODE")).toBe("opencode");
    expect((await resolveRunner("auto", { preferSource: "opencode", io })).name).toBe("opencode");
  });
});

describe("OpenCode provider configuration", () => {
  it("preserves the different v1/v2 precedence of explicit files and config directories", () => {
    const normal = path.join(root, "normal/opencode");
    const custom = path.join(root, "custom");
    fs.mkdirSync(normal, { recursive: true });
    fs.mkdirSync(custom);
    fs.writeFileSync(path.join(normal, "opencode.json"), '{"model":"provider/global"}');
    fs.writeFileSync(path.join(custom, "opencode.json"), '{"model":"provider/custom"}');
    const file = path.join(root, "explicit.json");
    fs.writeFileSync(file, '{"model":"provider/explicit"}');
    const env = {
      XDG_CONFIG_HOME: path.dirname(normal),
      OPENCODE_CONFIG_DIR: custom,
      OPENCODE_CONFIG: file,
    };
    expect(providerConfig(1, env).model).toBe("provider/custom");
    expect(providerConfig(2, env).model).toBe("provider/explicit");
  });

  it("reads JSONC provider settings and resolves relative secret-file references without loading plugins", () => {
    const directory = path.join(root, "opencode");
    fs.mkdirSync(directory);
    fs.writeFileSync(
      path.join(directory, "opencode.jsonc"),
      `{
      // These credentials are resolved by OpenCode itself.
      "model": "local/test",
      "providers": {"local":{"apiKey":"{file:./token}","url":"http://127.0.0.1:1"}},
      "plugins": ["must-not-load"], "instructions": ["must-not-read"],
      "agents": {"build":{"system":"must-not-include"}},
    }`,
    );
    const config = providerConfig(2, { XDG_CONFIG_HOME: root });
    expect(config).toEqual({
      model: "local/test",
      providers: {
        local: { apiKey: `{file:${path.join(directory, "token")}}`, url: "http://127.0.0.1:1" },
      },
    });
    const env = configureOpenCode(path.join(root, "scratch"), 2, config);
    expect(env.OPENCODE_CONFIG_DIR).not.toBe(directory);
    expect(fs.readFileSync(path.join(directory, "opencode.jsonc"), "utf8")).toContain(
      "must-not-load",
    );
  });

  it("does not expose malformed config contents in errors", () => {
    expect(() =>
      providerConfig(2, {
        XDG_CONFIG_HOME: root,
        OPENCODE_CONFIG_CONTENT: '{"apiKey":"secret-value", broken',
      }),
    ).toThrow(/Invalid OpenCode JSONC/);
    try {
      providerConfig(2, { XDG_CONFIG_HOME: root, OPENCODE_CONFIG_CONTENT: '{"secret-value":' });
    } catch (error) {
      expect(String(error)).not.toContain("secret-value");
    }
  });
});

describe("owned process cleanup", () => {
  it("preserves UTF-8 characters split across process-output chunks", async () => {
    const code =
      "process.stdout.write(Buffer.from([0xe2])); setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac])), 30);";
    const result = await defaultIo.spawn(process.execPath, ["-e", code], {
      input: "",
      timeoutMs: 2000,
    });
    expect(result.stdout).toBe("€");
  });
  it("terminates an owned CLI and its descendant on timeout", async () => {
    const pidFile = path.join(root, "descendant.pid");
    const childCode = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const parentCode = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], {stdio:"ignore"}); setInterval(() => {}, 1000);`;
    const opts: SpawnOptions = { input: "", timeoutMs: 800, processGroup: true };
    const result = await defaultIo.spawn(process.execPath, ["-e", parentCode], opts);
    expect(result.timedOut).toBe(true);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    const dead = () => {
      try {
        process.kill(pid, 0);
        // Linux can retain an exited orphan briefly until init reaps it.
        return (
          process.platform === "linux" && /\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"))
        );
      } catch {
        return true;
      }
    };
    for (let n = 0; n < 20 && !dead(); n++) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(dead()).toBe(true);
  });
});
