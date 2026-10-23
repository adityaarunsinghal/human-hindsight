import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flowArgs,
  type NextCommand,
  nextArguments,
  nextCommandText,
  offerNext,
} from "../src/commands/next.js";

afterEach(() => vi.unstubAllEnvs());
function sink() {
  let text = "";
  return {
    output: new Writable({
      write(chunk, _encoding, done) {
        text += chunk.toString();
        done();
      },
    }),
    text: () => text,
  };
}

describe("interactive next commands", () => {
  it("runs the suggested command only after y and retains selection", async () => {
    const output = sink();
    const run = vi.fn(async (_command: NextCommand, _args: string[]) => {});
    expect(
      await offerNext(
        "distill",
        {
          home: "/library with spaces",
          source: "opencode",
          "opencode-db": "/history/store.db",
          project: "dashboard",
          runner: "codex",
          model: "chosen-model",
        },
        { input: Readable.from(["y\n"]), output: output.output, interactive: true, run },
      ),
    ).toBe(true);
    expect(run).toHaveBeenCalledWith(
      "distill",
      expect.arrayContaining([
        "--home=/library with spaces",
        "--source=opencode",
        "--opencode-db=/history/store.db",
        "--project=dashboard",
        "--runner=codex",
        "--model=chosen-model",
      ]),
    );
    expect(output.text()).toContain("review the model-call plan");
    expect(output.text()).toContain("[y/N]");
    expect(run.mock.calls[0]?.[1]).not.toContain("--yes");
  });

  it.each(["n\n", "\n", ""])("declining or EOF does not run a command (%j)", async (answer) => {
    const output = sink();
    const run = vi.fn(async () => {});
    expect(
      await offerNext(
        "export",
        {},
        {
          input: Readable.from(answer ? [answer] : []),
          output: output.output,
          interactive: true,
          run,
        },
      ),
    ).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    { args: {}, interactive: false },
    { args: { "follow-up": false }, interactive: true },
    { args: { "dry-run": true }, interactive: true },
    { args: { yes: true }, interactive: true },
  ])("does not prompt scripts, dry runs, or opted-out callers: %j", async ({
    args,
    interactive,
  }) => {
    const output = sink();
    const run = vi.fn(async () => {});
    expect(await offerNext("gui", args, { output: output.output, interactive, run })).toBe(false);
    expect(output.text()).not.toContain("[y/N]");
    expect(run).not.toHaveBeenCalled();
  });

  it("never carries destructive or approval flags into another command", () => {
    const args = nextArguments("distill", {
      home: "/library",
      source: "claude",
      yes: true,
      fresh: true,
      force: true,
      apply: true,
      "dry-run": true,
      raw: true,
    });
    expect(args).not.toEqual(
      expect.arrayContaining(["--yes", "--fresh", "--force", "--apply", "--raw"]),
    );
    expect(args.some((value) => /--(?:yes|fresh|force|apply|raw|dry-run)(?:=|$)/.test(value))).toBe(
      false,
    );
  });

  it("forwards root-level settings and safely represents paths in the hint", () => {
    vi.stubEnv("HUMAN_HINDSIGHT_HOME", "/root-selected");
    vi.stubEnv("HUMAN_HINDSIGHT_MODEL", "from-root");
    vi.stubEnv("HUMAN_HINDSIGHT_FOLLOW_UP", "0");
    expect(flowArgs({}).model).toBe("from-root");
    expect(flowArgs({})["follow-up"]).toBe(false);
    expect(nextArguments("distill", {})).toContain("--home=/root-selected");
    expect(nextCommandText("gui", { home: "/a user's library" })).toContain(
      "'--home=/a user'\\''s library'",
    );
    expect(nextArguments("copy", { slug: "-unusual" }).slice(-2)).toEqual(["--", "-unusual"]);
  });
});
