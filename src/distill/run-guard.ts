import type { Writable } from "node:stream";
import type { PinKey, PinSource } from "../core/run-session.js";
import type { TerminalHost } from "../ui/live.js";
import { reportRunInterrupt } from "./consent.js";
import { acquireWriterLock, WriterBusyError } from "./operations.js";

/**
 * distill/run-guard.ts: the writer lock and Ctrl-C for a command that makes
 * model calls after consent (`distill --retry-failed`, `preferences
 * --consolidate`, `suggest-subagents`).
 *
 * The command takes the data home's writer lock once the person approved the
 * plan. On Ctrl-C, in this order: the calls in flight are aborted, so their
 * CLI processes end (`interrupt`); one line says what is saved, with the
 * command that continues alone on the next line, and the stopping run prints
 * nothing more (`mute`); the runners get a short, bounded chance to remove the
 * sessions their CLI saved for this run ({@link INTERRUPT_CLEANUP_MS}); then
 * the lock is released and the process exits with 130, in one step, so no
 * other command can take the lock while the stopping run still records what
 * it was doing. A cleanup that hangs never holds the exit back for longer.
 */

/** How long Ctrl-C waits for the runners' session cleanup before exiting anyway. */
const INTERRUPT_CLEANUP_MS = 3_000;

export interface RunGuardOptions {
  home: string;
  /** The command holding the lock, named in other commands' refusals. */
  command: string;
  output: Writable;
  /** The command that continues the run, printed on Ctrl-C. */
  resume: string;
  /** Runner cleanup to attempt on Ctrl-C, such as the run session's `finalize`. */
  cleanup?: () => Promise<void>;
  /** Abort the calls in flight, such as the run session's `interrupt`. */
  interrupt?: () => void;
  /** What Ctrl-C says is saved, at the moment it arrives (see `reportRunInterrupt`). */
  saved?: () => string;
  /** The whole line before the command, when the usual one is not true (see `reportRunInterrupt`). */
  says?: string;
  /** Drop the stopping run's later output once the line is written. */
  mute?: () => void;
  host?: TerminalHost;
  exit?(code: number): void;
  cleanupMs?: number;
  /** Timer for the cleanup bound (tests pass one that fires at once). */
  timer?(ms: number, fire: () => void): void;
}

export interface RunGuard {
  /** Print this command on Ctrl-C from now on. */
  resume(command: string): void;
  /**
   * Stop answering Ctrl-C and release the lock. Safe to call more than once.
   * After Ctrl-C the lock stays held until the exit.
   */
  end(): void;
}

/** Resolve when `work` settles or after `ms`, whichever comes first. Never rejects. */
export function bounded(
  work: (() => Promise<void>) | undefined,
  ms: number,
  timer: (ms: number, fire: () => void) => void,
): Promise<void> {
  if (!work) return Promise.resolve();
  return new Promise<void>((resolve) => {
    timer(ms, resolve);
    Promise.resolve().then(work).then(resolve, resolve);
  });
}

const defaultTimer = (ms: number, fire: () => void) => {
  setTimeout(fire, ms).unref();
};

/**
 * Take the writer lock and answer Ctrl-C. When another command holds the
 * lock, returns its refusal line instead and changes nothing.
 */
export function guardRun(o: RunGuardOptions): RunGuard | { busy: string } {
  let writer: ReturnType<typeof acquireWriterLock>;
  try {
    writer = acquireWriterLock(o.home, o.command);
  } catch (error) {
    if (error instanceof WriterBusyError) return { busy: error.message };
    throw error;
  }
  let released = false;
  let interrupted = false;
  const release = () => {
    if (released) return;
    released = true;
    writer.release();
  };
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const host = o.host ?? (process as unknown as TerminalHost);
  // A second Ctrl-C while the run stops: leave at once. The exit ends every
  // child CLI (runners/shared.ts) and nothing of this run runs after it.
  const now = () => {
    release();
    exit(130);
  };
  const listen = (resume: string) =>
    reportRunInterrupt(o.output, resume, {
      host: o.host,
      onInterrupt: () => {
        interrupted = true;
        host.once("SIGINT", now);
        o.interrupt?.();
      },
      saved: o.saved,
      says: o.says,
      mute: o.mute,
      exit: (code) => {
        void bounded(o.cleanup, o.cleanupMs ?? INTERRUPT_CLEANUP_MS, o.timer ?? defaultTimer).then(
          () => {
            host.off("SIGINT", now);
            // The last thing before the exit: nothing of this run runs after it.
            release();
            exit(code);
          },
        );
      },
    });
  let stop = listen(o.resume);
  return {
    resume(command) {
      if (interrupted) return;
      stop();
      stop = listen(command);
    },
    end() {
      stop();
      // After Ctrl-C the lock is released only at the exit.
      if (!interrupted) release();
    },
  };
}

/** The command options that pin a run session, by the session's own key. */
const PIN_OPTIONS: readonly [string, PinKey][] = [
  ["runner", "runner"],
  ["model", "model"],
  ["cluster-model", "cluster"],
  ["author-model", "author"],
  ["propose-model", "propose"],
];

/**
 * Where each pinning value of a command came from, for the run session's
 * `pinSources`: a value in the options the person typed is a flag; a value
 * that only appears once the environment's defaults were applied came from
 * its variable. `typed` is the command's input before those defaults.
 */
export function pinSourcesFrom(
  typed: Readonly<Record<string, unknown>>,
  resolved: Readonly<Record<string, unknown>>,
): Partial<Record<PinKey, PinSource>> {
  const sources: Partial<Record<PinKey, PinSource>> = {};
  for (const [option, key] of PIN_OPTIONS) {
    if (typed[option] !== undefined) sources[key] = "flag";
    else if (resolved[option] !== undefined) sources[key] = "environment";
  }
  return sources;
}

/**
 * An output that can be silenced: once `mute` is called, writes are dropped
 * (their callbacks still run). Everything else, such as `isTTY` and
 * `columns`, reads through to the stream. After Ctrl-C the stopping run's
 * stages may still settle for a moment; their lines never reach the screen.
 */
export function mutableOutput<T extends Writable>(stream: T): { output: T; mute(): void } {
  let muted = false;
  const dropped = (...args: unknown[]) => {
    const done = args.find((arg) => typeof arg === "function") as (() => void) | undefined;
    if (done) queueMicrotask(done);
    return true;
  };
  const output = new Proxy(stream, {
    get(target, key) {
      if (key === "write" && muted) return dropped;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    output,
    mute: () => {
      muted = true;
    },
  };
}
