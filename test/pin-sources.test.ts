import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunSessionOptions } from "../src/core/run-session.js";
import type { RunnerFn } from "../src/distill/pipeline.js";
import { pinSourcesFrom } from "../src/distill/run-guard.js";
import { type BuiltHome, homeBuilder } from "./support/home.js";

/**
 * A pin that came from an environment variable is named as that variable, not
 * as a flag: each command tells its run session where every pinning value came
 * from, before the environment's defaults are applied.
 */

const opened: RunSessionOptions[] = [];
vi.mock("../src/core/run-session.js", async (original) => {
  const actual = await original<typeof import("../src/core/run-session.js")>();
  return {
    ...actual,
    openRunSession: (options: RunSessionOptions) => {
      opened.push(options);
      return actual.openRunSession(options);
    },
  };
});
const { runPreferences } = await import("../src/commands/preferences.js");
const { runSuggestSubagents } = await import("../src/commands/suggest-subagents.js");

const homes: BuiltHome[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  opened.length = 0;
  while (homes.length) homes.pop()?.remove();
});
const sink = () =>
  new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
function home(): BuiltHome {
  const built = homeBuilder()
    .session({ project: "alpha", sessionId: "p-0001", messages: ["Keep the change small."] })
    .digest(0, { preferences: [{ text: "Keep changes small.", quote: "Keep the change small" }] })
    .task({ slug: "small-change-work", members: [0] })
    .library("small-change-work")
    .review("Keep changes small.", "accepted")
    .build();
  homes.push(built);
  return built;
}
const decline = async () => "declined" as const;
const unused = (async () => {
  throw new Error("declined runs make no call");
}) as RunnerFn;

describe("pinSourcesFrom", () => {
  it.each([
    [
      "typed flags",
      { runner: "codex", model: "m" },
      { runner: "codex", model: "m" },
      { runner: "flag", model: "flag" },
    ],
    [
      "values from variables",
      {},
      { runner: "kiro", "author-model": "a" },
      { runner: "environment", author: "environment" },
    ],
    [
      "a flag over a variable",
      { "cluster-model": "c" },
      { "cluster-model": "c", "propose-model": "p" },
      { cluster: "flag", propose: "environment" },
    ],
    ["nothing pinned", {}, {}, {}],
  ])("%s", (_name, typed, resolved, expected) => {
    expect(pinSourcesFrom(typed, resolved)).toEqual(expected);
  });
});

describe("commands pass where each pin came from", () => {
  it("preferences --consolidate names a model from HUMAN_HINDSIGHT_MODEL as the variable", async () => {
    vi.stubEnv("HUMAN_HINDSIGHT_MODEL", "env-model");
    await runPreferences(
      { home: home().dir, consolidate: true, runner: "claude" },
      { output: sink(), runner: unused, input: undefined },
    ).catch(() => undefined);
    expect(opened.at(-1)?.pinSources).toEqual({ runner: "flag", model: "environment" });
  });

  it("suggest-subagents names a runner from HUMAN_HINDSIGHT_RUNNER as the variable", async () => {
    vi.stubEnv("HUMAN_HINDSIGHT_RUNNER", "claude");
    await runSuggestSubagents(
      { home: home().dir, model: "typed-model" },
      { output: sink(), runner: unused, confirm: decline },
    );
    expect(opened.at(-1)?.pinSources).toEqual({ runner: "environment", model: "flag" });
  });
});
