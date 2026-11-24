import type { Readable, Writable } from "node:stream";

export interface PromptIo {
  input?: Readable;
  output?: Writable;
  /** The environment the decisions read. Defaults to `process.env`; tests pass their own. */
  env?: TerminalEnv;
}

export type TerminalOutput = Writable & { isTTY?: boolean; rows?: number; columns?: number };
export type TerminalInput = Readable & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(enabled: boolean): unknown;
};

export type TerminalEnv = Readonly<Record<string, string | undefined>>;

/** What is known about the streams and environment. Everything a decision needs, nothing else. */
export interface TerminalFacts {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  env: TerminalEnv;
}

/**
 * Four separate questions, answered separately, because a single "interactive"
 * answer made `export </dev/null` look hung and ignored FORCE_COLOR.
 * - color: may styled text be written to this output;
 * - animate: may a live region (spinner, progress, hyperlink escapes) be drawn;
 * - prompt: may a numbered line question be asked (plain terminals can answer one);
 * - interactive: may a single-key menu take over the terminal.
 */
export interface TerminalAbilities {
  color: boolean;
  animate: boolean;
  prompt: boolean;
  interactive: boolean;
}

/** An empty value counts as unset, as no-color.org and force-color.org specify. */
const isSet = (value: string | undefined): value is string => value !== undefined && value !== "";

export function isPlainMode(env: TerminalEnv = process.env): boolean {
  return env.HUMAN_HINDSIGHT_PLAIN === "1";
}

function isCi(env: TerminalEnv): boolean {
  const ci = env.CI;
  return isSet(ci) && !/^(0|false)$/i.test(ci);
}

/** Pure: the same facts always give the same answers. */
export function decideTerminal(facts: TerminalFacts): TerminalAbilities {
  const { env } = facts;
  const dumb = env.TERM === "dumb";
  const plain = isPlainMode(env);
  // FORCE_COLOR=0 is not a request to force; the ordinary rule then applies.
  const forced = isSet(env.FORCE_COLOR) && env.FORCE_COLOR !== "0";
  const color = forced || (facts.stdoutIsTTY && !isSet(env.NO_COLOR) && !dumb);
  // Progress belongs to the output. Where stdin comes from does not matter.
  const animate = facts.stdoutIsTTY && !dumb && !plain;
  const prompt = facts.stdinIsTTY && facts.stdoutIsTTY && !isCi(env);
  const interactive = prompt && !plain && !dumb;
  return { color, animate, prompt, interactive };
}

function abilities(io: PromptIo): TerminalAbilities {
  const input: TerminalInput = io.input ?? process.stdin;
  const output: TerminalOutput = io.output ?? process.stdout;
  return decideTerminal({
    stdinIsTTY: input.isTTY === true,
    stdoutIsTTY: output.isTTY === true,
    env: io.env ?? process.env,
  });
}

/** Styled text is allowed on this output. */
export function canColor(io: PromptIo = {}): boolean {
  return abilities(io).color;
}

/** A spinner, progress row, or other live redraw is allowed on this output. */
export function canAnimate(io: PromptIo = {}): boolean {
  return abilities(io).animate;
}

/** Plain terminals can still answer a numbered question. Pipes and CI cannot. */
export function canPrompt(io: PromptIo = {}): boolean {
  return abilities(io).prompt;
}

/** A single-key menu may take over the terminal: a prompt is allowed and the mode is not plain. */
export function isInteractive(io: PromptIo = {}): boolean {
  return abilities(io).interactive;
}

export function terminalWidth(out: TerminalOutput = process.stdout): number {
  return Math.max(1, Math.floor(out.columns || 80));
}

/** The terminal width of a stream, or undefined for a pipe or file (no line limit there). */
export function lineWidth(out: TerminalOutput = process.stdout): number | undefined {
  return out.isTTY ? terminalWidth(out) : undefined;
}

/**
 * Pure: may box-drawing and symbol glyphs be written? The first set of
 * `LC_ALL`, `LC_CTYPE`, `LANG` names the character set, as POSIX specifies.
 * With none set, macOS terminals still default to UTF-8 while a Linux console
 * or a bare container falls back to the C locale, which is ASCII.
 */
export function supportsUnicode(
  env: TerminalEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  if (!locale) return platform !== "linux";
  return /utf-?8/i.test(locale);
}

/** The Unicode glyph, or its ASCII stand-in when the locale cannot show it. */
export function glyph(
  unicode: string,
  ascii: string,
  env: TerminalEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return supportsUnicode(env, platform) ? unicode : ascii;
}
