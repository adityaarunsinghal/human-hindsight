/**
 * test/support/clock.ts: an injectable clock and a deterministic random source.
 *
 * Code under test that takes `now`, `sleep`, or `random` as arguments gets
 * these instead of the globals, so a test controls time and chance exactly
 * and never waits on a real timer.
 *
 *   const clock = createClock("2026-01-02T03:04:05.000Z");
 *   await clock.sleep(5_000);          // returns at once, time moved 5 s
 *   clock.now().toISOString();         // "2026-01-02T03:04:10.000Z"
 *   clock.sleeps;                      // [5000]
 *
 *   const random = createRandom(7);
 *   random.next();                     // same sequence for the same seed
 *   random.uuid();                     // a stable, well-formed v4 UUID
 */

export interface TestClock {
  /** Current time as a fresh Date. */
  now(): Date;
  /** Current time in epoch milliseconds. */
  nowMs(): number;
  /** Current time as an ISO string. */
  iso(): string;
  /** Move time forward (negative values are rejected). */
  advance(ms: number): void;
  /** Jump to an absolute time. */
  set(time: string | number | Date): void;
  /** Resolves immediately after advancing time by `ms`; records the request. */
  sleep(ms: number): Promise<void>;
  /** Every duration passed to {@link TestClock.sleep}, in order. */
  readonly sleeps: number[];
}

export const DEFAULT_START = "2026-01-02T03:04:05.000Z";

function toMs(time: string | number | Date): number {
  const ms = time instanceof Date ? time.getTime() : new Date(time).getTime();
  if (!Number.isFinite(ms)) throw new Error(`Invalid clock time: ${String(time)}`);
  return ms;
}

export function createClock(start: string | number | Date = DEFAULT_START): TestClock {
  let current = toMs(start);
  const sleeps: number[] = [];
  const advance = (ms: number) => {
    if (!(ms >= 0)) throw new Error(`A clock only moves forward (got ${ms})`);
    current += ms;
  };
  return {
    now: () => new Date(current),
    nowMs: () => current,
    iso: () => new Date(current).toISOString(),
    advance,
    set(time) {
      current = toMs(time);
    },
    async sleep(ms) {
      sleeps.push(ms);
      advance(ms);
    },
    sleeps,
  };
}

export interface TestRandom {
  /** A float in [0, 1), like Math.random. */
  next(): number;
  /** An integer in [0, max). */
  int(max: number): number;
  /** `n` bytes. */
  bytes(n: number): Buffer;
  /** `n` bytes as lowercase hex (2n characters). */
  hex(n: number): string;
  /** A well-formed version 4 UUID from the sequence. */
  uuid(): string;
}

/** mulberry32: small, fast, and good enough for tests. Same seed, same sequence. */
export function createRandom(seed = 1): TestRandom {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (max: number) => {
    if (!Number.isInteger(max) || max <= 0) throw new Error(`int() needs a positive integer`);
    return Math.floor(next() * max);
  };
  const bytes = (n: number) => Buffer.from(Array.from({ length: n }, () => int(256)));
  const hex = (n: number) => bytes(n).toString("hex");
  const uuid = () => {
    const b = bytes(16);
    b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
    b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
    const h = b.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  return { next, int, bytes, hex, uuid };
}
