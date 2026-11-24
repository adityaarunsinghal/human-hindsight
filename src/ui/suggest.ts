/**
 * ui/suggest.ts: "did you mean" for commands, flags, and prompt names. A
 * suggestion is offered only for a close match, so a word that resembles
 * nothing gets a pointer to help instead of a guess.
 */

/**
 * Edits between two names, where swapping two neighboring letters counts as
 * one edit (optimal string alignment): `--soruce` is one typo from `--source`,
 * not a tie with `--force`.
 */
export function editDistance(left: string, right: string): number {
  const rows: number[][] = [Array.from({ length: right.length + 1 }, (_, index) => index)];
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      const above = rows[i - 1] ?? [];
      let best = Math.min(
        (above[j] ?? Infinity) + 1,
        (current[j - 1] ?? Infinity) + 1,
        (above[j - 1] ?? Infinity) + Number(left[i - 1] !== right[j - 1]),
      );
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        best = Math.min(best, (rows[i - 2]?.[j - 2] ?? Infinity) + 1);
      }
      current.push(best);
    }
    rows.push(current);
  }
  return rows[left.length]?.[right.length] ?? Infinity;
}

/**
 * Close enough to be a typo: at most one edit for every three letters typed
 * (and always one), and fewer edits than half the word, so `frob` is not
 * taken for `show` and `frobnicate` not for `rate`.
 */
export function isCloseMatch(typed: string, distance: number): boolean {
  return distance <= Math.max(1, Math.floor(typed.length / 3)) && distance < typed.length / 2;
}

/** Every word of the typed name (three letters or more) appears in the candidate. */
function allWords(typed: string, candidate: string): boolean {
  const words = typed.split(/[-_\s]+/).filter((word) => word.length >= 3);
  return words.length > 1 && words.every((word) => candidate.includes(word));
}

/** The closest candidate when it is close, else nothing. Ties go to the first in sort order. */
export function closestMatch(typed: string, candidates: readonly string[]): string | undefined {
  return closestMatches(typed, candidates, 1)[0];
}

/**
 * Up to `limit` close candidates, nearest first. A candidate that contains
 * the typed text, or holds every word of it, also counts
 * as close: `landing` and `landing-polish` both find `landing-page-polish`.
 */
export function closestMatches(typed: string, candidates: readonly string[], limit = 3): string[] {
  const lower = typed.toLowerCase();
  return candidates
    .map((name) => {
      const other = name.toLowerCase();
      const contains = lower.length >= 3 && (other.includes(lower) || allWords(lower, other));
      return { name, distance: editDistance(lower, other), contains };
    })
    .filter((c) => c.contains || isCloseMatch(lower, c.distance))
    .sort(
      (a, b) =>
        Number(b.contains) - Number(a.contains) ||
        a.distance - b.distance ||
        a.name.localeCompare(b.name),
    )
    .slice(0, limit)
    .map((c) => c.name);
}
