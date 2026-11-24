/**
 * What an option value must be, said once. The same rule judges a value
 * before any command runs (`findInputProblem`) and inside the command that
 * reads it, so a wrong value is an error everywhere and never a silent
 * default. The line it produces names the option, what it takes, and the
 * value given: `--concurrency takes a whole number of calls at a time, 1 or
 * more, not "0".`
 */
export interface ValueRule {
  accepts(value: string): boolean;
  /** What the option takes, as the end of "--name takes ...". */
  says: string;
}

/** A whole number from `min` to `max` (digits only: no sign, point, or exponent). */
export function wholeNumber(min: number, says: string, max = Number.MAX_SAFE_INTEGER): ValueRule {
  return {
    accepts(value) {
      const text = value.trim();
      if (!/^\d+$/.test(text)) return false;
      const n = Number(text);
      return Number.isSafeInteger(n) && n >= min && n <= max;
    },
    says,
  };
}

/** One of a fixed list of words, as typed. */
export function oneOf(values: readonly string[]): ValueRule {
  const says =
    values.length > 2
      ? `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`
      : values.join(" or ");
  return { accepts: (value) => values.includes(value), says };
}

/** The one line for a value the rule refuses, or nothing when it accepts it. */
export function valueProblem(
  rule: ValueRule,
  name: string,
  value: string,
  via = `--${name}`,
): string | undefined {
  return rule.accepts(value)
    ? undefined
    : `${via} takes ${rule.says}, not ${JSON.stringify(value)}.`;
}

/** The value, checked: a refused value throws its one line (see {@link valueProblem}). */
export function checkedValue(rule: ValueRule, name: string, value: string): string {
  const problem = valueProblem(rule, name, value);
  if (problem) throw new Error(problem);
  return value.trim();
}

/** A whole-number option as a number, or `fallback` when it was not given. Throws on a wrong value. */
export function wholeOption(
  rule: ValueRule,
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  return raw === undefined ? fallback : Number(checkedValue(rule, name, raw));
}
