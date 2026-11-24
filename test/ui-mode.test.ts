import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  canAnimate,
  canColor,
  canPrompt,
  decideTerminal,
  glyph,
  isInteractive,
  supportsUnicode,
} from "../src/ui/mode.js";

describe("terminal abilities", () => {
  const tty = { stdinIsTTY: true, stdoutIsTTY: true };
  // Named cases, each one a promise a person can observe.
  it.each([
    ["a full terminal", tty, {}, { color: true, animate: true, prompt: true, interactive: true }],
    [
      "stdin from /dev/null in a terminal still shows progress and color",
      { stdinIsTTY: false, stdoutIsTTY: true },
      {},
      { color: true, animate: true, prompt: false, interactive: false },
    ],
    [
      "a pipe gets neither color nor progress",
      { stdinIsTTY: true, stdoutIsTTY: false },
      {},
      { color: false, animate: false, prompt: false, interactive: false },
    ],
    [
      "FORCE_COLOR turns color on into a pipe",
      { stdinIsTTY: false, stdoutIsTTY: false },
      { FORCE_COLOR: "1" },
      { color: true, animate: false, prompt: false, interactive: false },
    ],
    [
      "FORCE_COLOR wins over NO_COLOR",
      tty,
      { FORCE_COLOR: "3", NO_COLOR: "1" },
      { color: true, animate: true, prompt: true, interactive: true },
    ],
    [
      "FORCE_COLOR=0 does not force",
      { stdinIsTTY: false, stdoutIsTTY: false },
      { FORCE_COLOR: "0" },
      { color: false, animate: false, prompt: false, interactive: false },
    ],
    [
      "empty FORCE_COLOR does not force",
      { stdinIsTTY: false, stdoutIsTTY: false },
      { FORCE_COLOR: "" },
      { color: false, animate: false, prompt: false, interactive: false },
    ],
    [
      "NO_COLOR keeps progress but removes color",
      tty,
      { NO_COLOR: "1" },
      { color: false, animate: true, prompt: true, interactive: true },
    ],
    [
      "empty NO_COLOR is unset",
      tty,
      { NO_COLOR: "" },
      { color: true, animate: true, prompt: true, interactive: true },
    ],
    [
      "TERM=dumb draws nothing but can answer a numbered question",
      tty,
      { TERM: "dumb" },
      { color: false, animate: false, prompt: true, interactive: false },
    ],
    [
      "CI never prompts",
      tty,
      { CI: "true" },
      { color: true, animate: true, prompt: false, interactive: false },
    ],
    [
      "CI=false is not CI",
      tty,
      { CI: "false" },
      { color: true, animate: true, prompt: true, interactive: true },
    ],
    [
      "plain mode uses numbered prompts and static lines",
      tty,
      { HUMAN_HINDSIGHT_PLAIN: "1" },
      { color: true, animate: false, prompt: true, interactive: false },
    ],
  ])("%s", (_name, streams, env, expected) => {
    expect(decideTerminal({ ...streams, env })).toEqual(expected);
  });

  // Every combination, checked against the rules as written in the design.
  const values = {
    stdinIsTTY: [false, true],
    stdoutIsTTY: [false, true],
    NO_COLOR: [undefined, "", "1"],
    FORCE_COLOR: [undefined, "", "0", "1"],
    TERM: [undefined, "xterm-256color", "dumb"],
    CI: [undefined, "", "0", "1"],
    HUMAN_HINDSIGHT_PLAIN: [undefined, "0", "1"],
  } as const;
  const combinations: {
    stdinIsTTY: boolean;
    stdoutIsTTY: boolean;
    env: Record<string, string | undefined>;
  }[] = [];
  for (const stdinIsTTY of values.stdinIsTTY)
    for (const stdoutIsTTY of values.stdoutIsTTY)
      for (const NO_COLOR of values.NO_COLOR)
        for (const FORCE_COLOR of values.FORCE_COLOR)
          for (const TERM of values.TERM)
            for (const CI of values.CI)
              for (const HUMAN_HINDSIGHT_PLAIN of values.HUMAN_HINDSIGHT_PLAIN)
                combinations.push({
                  stdinIsTTY,
                  stdoutIsTTY,
                  env: { NO_COLOR, FORCE_COLOR, TERM, CI, HUMAN_HINDSIGHT_PLAIN },
                });

  it(`answers all ${combinations.length} combinations by the stated rules`, () => {
    for (const facts of combinations) {
      const { env } = facts;
      const forced = env.FORCE_COLOR === "1";
      const noColor = env.NO_COLOR === "1";
      const dumb = env.TERM === "dumb";
      const ci = env.CI === "1";
      const plain = env.HUMAN_HINDSIGHT_PLAIN === "1";
      const got = decideTerminal(facts);
      const want = {
        color: forced || (facts.stdoutIsTTY && !noColor && !dumb),
        animate: facts.stdoutIsTTY && !dumb && !plain,
        prompt: facts.stdinIsTTY && facts.stdoutIsTTY && !ci,
        interactive: facts.stdinIsTTY && facts.stdoutIsTTY && !ci && !plain && !dumb,
      };
      expect(got, JSON.stringify(facts)).toEqual(want);
    }
  });

  it("reads the given streams, so stdin from /dev/null never hides progress", () => {
    const closed = Object.assign(new PassThrough(), { isTTY: false });
    const terminal = Object.assign(new PassThrough(), { isTTY: true });
    const io = { input: closed, output: terminal, env: { TERM: "xterm-256color" } };
    expect([canColor(io), canAnimate(io), canPrompt(io), isInteractive(io)]).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});

describe("Unicode glyphs", () => {
  it.each([
    ["a UTF-8 LANG", { LANG: "en_US.UTF-8" }, "linux", true],
    ["utf8 spelled without the dash", { LANG: "de_DE.utf8" }, "linux", true],
    ["C.UTF-8 in a container", { LC_ALL: "C.UTF-8" }, "linux", true],
    ["the C locale", { LANG: "C" }, "darwin", false],
    ["POSIX", { LANG: "POSIX" }, "linux", false],
    ["a Latin-1 locale", { LANG: "en_US.ISO-8859-1" }, "darwin", false],
    ["LC_ALL wins over LANG", { LC_ALL: "C", LANG: "en_US.UTF-8" }, "darwin", false],
    ["LC_CTYPE wins over LANG", { LC_CTYPE: "en_US.UTF-8", LANG: "C" }, "linux", true],
    ["LC_ALL wins over LC_CTYPE", { LC_ALL: "en_US.UTF-8", LC_CTYPE: "C" }, "linux", true],
    ["an empty LC_ALL is unset", { LC_ALL: "", LANG: "C" }, "darwin", false],
    ["no locale on macOS, whose terminals default to UTF-8", {}, "darwin", true],
    ["no locale on Linux, which means the C locale", {}, "linux", false],
    ["only empty values on Linux", { LC_ALL: "", LC_CTYPE: "", LANG: "" }, "linux", false],
  ] as const)("%s", (_name, env, platform, unicode) => {
    expect(supportsUnicode(env, platform)).toBe(unicode);
    expect(glyph("✓", "+", env, platform)).toBe(unicode ? "✓" : "+");
  });
});
