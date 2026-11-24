import { onTestFinished } from "vitest";
import type { RunnerIo, SpawnOptions, SpawnResult } from "../../src/runners/shared.js";

/**
 * test/support/runner-io.ts: a scripted fake of `RunnerIo` (`which`, `spawn`).
 *
 * Runners are faked at the process boundary, so no test ever starts a real
 * agent CLI. Each script names a binary, an optional argument pattern, and
 * the result to return. The first matching script wins; a script with
 * `times` is used up after that many matches.
 *
 *   const io = fakeRunnerIo()
 *     .script("claude", { has: ["--help"] }, { stdout: "--output-format --json-schema" })
 *     .script("claude", { has: ["-p"], stdin: /file: a\.md/ }, { stdout: envelope({ ok: true }) });
 *   io.failOnUnscripted();        // the test fails if anything else is spawned
 *   await runner.run(..., { io });
 *   io.calls.map((c) => c.args);  // every spawn, in order, with its stdin
 *
 * `which` resolves every scripted binary to `/fake/bin/<name>` unless told
 * otherwise with {@link FakeRunnerIo.binary}; unknown binaries are not found.
 *
 * An unscripted spawn rejects (so the code under test sees a failure) and is
 * also kept in `unscripted`. The code under test may swallow that rejection,
 * which is why {@link FakeRunnerIo.failOnUnscripted} checks again when the
 * test ends.
 */

/** One argument matcher: an exact string or a pattern. */
export type ArgMatcher = string | RegExp;

export interface CallPattern {
  /** Every argument, in order, exactly this many. */
  args?: ArgMatcher[];
  /** Each matcher must match at least one argument, in any position. */
  has?: ArgMatcher[];
  /** None of these may match any argument. */
  lacks?: ArgMatcher[];
  /** Matched against the text written to stdin. */
  stdin?: ArgMatcher;
}

export interface SpawnCall {
  bin: string;
  args: string[];
  stdin: string;
  options: SpawnOptions;
}

export type ScriptedResult =
  | Partial<SpawnResult>
  | ((call: SpawnCall) => Partial<SpawnResult> | Promise<Partial<SpawnResult>>);

interface Script {
  bin: string;
  pattern: CallPattern;
  result: ScriptedResult;
  remaining: number;
}

export interface FakeRunnerIo extends RunnerIo {
  /** Add a script; chainable. */
  script(bin: string, pattern: CallPattern, result: ScriptedResult, times?: number): FakeRunnerIo;
  /** Set where `which` finds a binary; `null` makes it missing. Chainable. */
  binary(bin: string, resolved: string | null): FakeRunnerIo;
  /** Every spawn that matched a script, plus unscripted ones, in order. */
  readonly calls: SpawnCall[];
  /** Every `which` lookup, in order. */
  readonly lookups: string[];
  /** Spawns that matched no script. */
  readonly unscripted: SpawnCall[];
  /** Calls to one binary, optionally narrowed by a pattern. */
  callsOf(bin: string, pattern?: CallPattern): SpawnCall[];
  /** Throw when any spawn was unscripted. */
  assertNoUnscripted(): void;
  /** Register {@link FakeRunnerIo.assertNoUnscripted} to run when the current test ends. */
  failOnUnscripted(): FakeRunnerIo;
}

function matches(matcher: ArgMatcher, value: string): boolean {
  return typeof matcher === "string" ? matcher === value : matcher.test(value);
}

/** True when a call satisfies a pattern; exported so tests can filter `calls`. */
export function matchesPattern(pattern: CallPattern, args: string[], stdin = ""): boolean {
  if (pattern.args) {
    if (pattern.args.length !== args.length) return false;
    if (!pattern.args.every((matcher, index) => matches(matcher, args[index] ?? ""))) return false;
  }
  if (pattern.has && !pattern.has.every((matcher) => args.some((arg) => matches(matcher, arg))))
    return false;
  if (pattern.lacks?.some((matcher) => args.some((arg) => matches(matcher, arg)))) return false;
  if (pattern.stdin !== undefined && !matches(pattern.stdin, stdin)) return false;
  return true;
}

/** A completed process: exit 0, empty output, not killed. */
export function spawnResult(partial: Partial<SpawnResult> = {}): SpawnResult {
  return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, ...partial };
}

/** The `claude -p --output-format json` success envelope around a structured value. */
export function claudeEnvelope(value: unknown): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: value,
  });
}

export function fakeRunnerIo(): FakeRunnerIo {
  const scripts: Script[] = [];
  const resolved = new Map<string, string | null>();
  const calls: SpawnCall[] = [];
  const lookups: string[] = [];
  const unscripted: SpawnCall[] = [];

  const io: FakeRunnerIo = {
    calls,
    lookups,
    unscripted,
    script(bin, pattern, result, times = Number.POSITIVE_INFINITY) {
      scripts.push({ bin, pattern, result, remaining: times });
      return io;
    },
    binary(bin, path) {
      resolved.set(bin, path);
      return io;
    },
    which(bin) {
      lookups.push(bin);
      if (resolved.has(bin)) return resolved.get(bin) ?? null;
      return scripts.some((script) => script.bin === bin) ? `/fake/bin/${bin}` : null;
    },
    async spawn(bin, args, options) {
      const call: SpawnCall = { bin, args: [...args], stdin: options.input, options };
      calls.push(call);
      // Scripts are keyed by the bare name; `which` may have returned a path.
      const name = bin.split(/[\\/]/).pop() ?? bin;
      const script = scripts.find(
        (candidate) =>
          candidate.remaining > 0 &&
          (candidate.bin === bin || candidate.bin === name) &&
          matchesPattern(candidate.pattern, args, options.input),
      );
      if (!script) {
        unscripted.push(call);
        throw new Error(`Unscripted spawn: ${name} ${args.join(" ")}`);
      }
      script.remaining--;
      const result =
        typeof script.result === "function" ? await script.result(call) : script.result;
      return spawnResult(result);
    },
    callsOf(bin, pattern = {}) {
      return calls.filter(
        (call) =>
          (call.bin === bin || call.bin.split(/[\\/]/).pop() === bin) &&
          matchesPattern(pattern, call.args, call.stdin),
      );
    },
    assertNoUnscripted() {
      if (unscripted.length) {
        const list = unscripted.map((call) => `${call.bin} ${call.args.join(" ")}`).join("; ");
        throw new Error(`Unscripted command(s) spawned: ${list}`);
      }
    },
    failOnUnscripted() {
      onTestFinished(() => io.assertNoUnscripted());
      return io;
    },
  };
  return io;
}
