import { describe, expect, it } from "vitest";
import { createClock, createRandom, DEFAULT_START } from "./clock.js";

describe("createClock", () => {
  it("starts at the given time and moves only when told", () => {
    const clock = createClock();
    expect(clock.iso()).toBe(DEFAULT_START);
    clock.advance(1_500);
    expect(clock.now().toISOString()).toBe("2026-01-02T03:04:06.500Z");
    clock.set("2027-05-06T07:08:09.000Z");
    expect(clock.nowMs()).toBe(Date.parse("2027-05-06T07:08:09.000Z"));
  });

  it("sleep resolves at once, advances time, and records the request", async () => {
    const clock = createClock(0);
    const before = performance.now();
    await clock.sleep(60_000);
    await clock.sleep(5);
    expect(performance.now() - before).toBeLessThan(50);
    expect(clock.nowMs()).toBe(60_005);
    expect(clock.sleeps).toEqual([60_000, 5]);
  });

  it("returns a fresh Date each time", () => {
    const clock = createClock();
    const first = clock.now();
    first.setFullYear(2000);
    expect(clock.iso()).toBe(DEFAULT_START);
  });

  it.each([[-1], [Number.NaN]])("rejects moving by %s", (ms) => {
    expect(() => createClock().advance(ms)).toThrow(/forward/);
  });

  it("rejects an invalid start", () => {
    expect(() => createClock("not a date")).toThrow(/Invalid clock time/);
  });
});

describe("createRandom", () => {
  it("repeats the same sequence for the same seed and differs for another", () => {
    const a = createRandom(42);
    const b = createRandom(42);
    const c = createRandom(43);
    const seqA = [a.next(), a.next(), a.next()];
    expect([b.next(), b.next(), b.next()]).toEqual(seqA);
    expect(c.next()).not.toBe(seqA[0]);
    for (const value of seqA) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("gives integers in range, hex of the right length, and v4 UUIDs", () => {
    const random = createRandom(7);
    const ints = Array.from({ length: 200 }, () => random.int(3));
    expect(new Set(ints)).toEqual(new Set([0, 1, 2]));
    expect(random.hex(4)).toMatch(/^[0-9a-f]{8}$/);
    expect(random.uuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(createRandom(7).uuid()).toBe(createRandom(7).uuid());
  });

  it("rejects a non-positive bound", () => {
    expect(() => createRandom().int(0)).toThrow(/positive/);
  });
});
