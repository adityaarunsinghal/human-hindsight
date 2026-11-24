import { describe, expect, it } from "vitest";
import {
  DEFAULT_INPUT_BUDGET,
  MIN_INPUT_BUDGET,
  middleCut,
  resolveInputBudget,
  resolveTimeoutMs,
  resolveTruncatePolicy,
} from "../src/core/budget.js";

describe("resolveInputBudget", () => {
  it("defaults when absent", () => {
    expect(resolveInputBudget(undefined)).toBe(DEFAULT_INPUT_BUDGET);
  });

  it("accepts a valid override, the floor included", () => {
    expect(resolveInputBudget("250000")).toBe(250_000);
    expect(resolveInputBudget(String(MIN_INPUT_BUDGET))).toBe(MIN_INPUT_BUDGET);
  });

  it.each([
    "abc",
    String(MIN_INPUT_BUDGET - 1),
    "-5",
    "2.5e5",
  ])("%j is an error naming the value, never the default", (raw) => {
    expect(() => resolveInputBudget(raw)).toThrow(
      `--input-budget takes a whole number of characters, ${MIN_INPUT_BUDGET} or more, not ${JSON.stringify(raw)}.`,
    );
  });
});

describe("resolveTruncatePolicy", () => {
  it("is 'never' when absent, and what was asked for otherwise", () => {
    expect(resolveTruncatePolicy(undefined)).toBe("never");
    expect(resolveTruncatePolicy("never")).toBe("never");
    expect(resolveTruncatePolicy("extreme")).toBe("extreme");
  });

  it("a misspelling is an error, not a quiet 'never'", () => {
    expect(() => resolveTruncatePolicy("nonsense")).toThrow(
      '--truncate takes never or extreme, not "nonsense".',
    );
  });
});

describe("resolveTimeoutMs", () => {
  it("converts seconds to ms; absent is the runner default", () => {
    expect(resolveTimeoutMs(undefined)).toBeUndefined();
    expect(resolveTimeoutMs("120")).toBe(120_000);
  });

  it.each(["0", "-3", "abc", "90s"])("%j is an error naming the value", (raw) => {
    expect(() => resolveTimeoutMs(raw)).toThrow(
      `--timeout takes a whole number of seconds, 1 or more, not ${JSON.stringify(raw)}.`,
    );
  });
});

describe("middleCut", () => {
  it("passes content through untouched when it fits", () => {
    expect(middleCut("hello", 100)).toEqual({ text: "hello", dropped: 0 });
  });

  it("cuts to exactly the budget with head+tail and an EXACT dropped-count", () => {
    const content = `HEAD${"x".repeat(100_000)}TAIL`;
    for (const budget of [1_000, 9_999, 10_000, 12_345]) {
      const { text, dropped } = middleCut(content, budget);
      expect(text.length).toBe(budget);
      expect(text.startsWith("HEAD")).toBe(true);
      expect(text.endsWith("TAIL")).toBe(true);
      // The reported dropped-count equals the bytes actually removed.
      const stated = Number(/truncated (\d+) characters/.exec(text)?.[1]);
      expect(stated).toBe(dropped);
      const markerLen =
        `\n\n[... human-hindsight truncated ${stated} characters from the middle of this session ...]\n\n`
          .length;
      expect(content.length - (budget - markerLen)).toBe(dropped);
    }
  });

  it("guards a budget smaller than the marker (returns exactly budget chars)", () => {
    const { text, dropped } = middleCut("z".repeat(1_000), 20);
    expect(text.length).toBe(20);
    expect(dropped).toBe(1_000);
  });
});
