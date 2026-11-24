import {
  isEdited,
  isOutcomeVerified,
  type LibraryEntry,
  OUTCOME_NOT_VERIFIED,
} from "../core/library.js";
import { glyph } from "./mode.js";
import {
  bold,
  dim,
  green,
  magenta,
  red,
  table,
  truncateVisible,
  visibleWidth,
  yellow,
} from "./style.js";
import { wrapText } from "./wrap.js";

/**
 * ui/library-table.ts: the library listing printed by `list`.
 *
 * The Name column is what a person types next (`show <name>`), so it is never
 * shortened. When the terminal is narrow, the other columns give way: Domain
 * goes first, then Confidence, Written, and Sessions, and Title is shortened
 * last. When even the name and a short title do not fit, each prompt becomes a
 * small block: the name on its own line, its facts wrapped under it.
 */

const CONFIDENCE_COLOR = { high: green, medium: yellow, low: red } as const;

/**
 * What to know about a prompt beyond its facts: the person edited or rated
 * it, or none of its sessions reached a result that could be verified. Empty
 * when none applies.
 */
function marks(entry: LibraryEntry): string {
  const parts: string[] = [];
  if (isEdited(entry)) parts.push(yellow(glyph("✎ edited", "edited")));
  if (entry.sources.rating === "up") parts.push(green(`${glyph("▲", "+")} rated up`));
  if (entry.sources.rating === "down") parts.push(red(`${glyph("▼", "-")} rated down`));
  if (!isOutcomeVerified(entry.sources)) parts.push(dim(OUTCOME_NOT_VERIFIED));
  return parts.join(", ");
}

interface Column {
  header: string;
  cell(entry: LibraryEntry): string;
  /** A column that may be shortened keeps at least this many columns. */
  shrinkTo?: number;
}

const GAP = 2;
const NAME: Column = { header: "Name", cell: (e) => bold(e.slug) };
const TITLE: Column = { header: "Title", cell: (e) => e.sources.title, shrinkTo: 12 };
const DOMAIN: Column = {
  header: "Domain",
  cell: (e) => magenta(e.sources.domains.join(", ")),
  shrinkTo: 12,
};
const SESSIONS: Column = { header: "Sessions", cell: (e) => String(e.sources.members.length) };
const CONFIDENCE: Column = {
  header: "Confidence",
  cell: (e) => (CONFIDENCE_COLOR[e.sources.confidence] ?? dim)(e.sources.confidence),
};
const WRITTEN: Column = { header: "Written", cell: (e) => dim(e.sources.authored_at.slice(0, 10)) };
const NOTES: Column = { header: "Notes", cell: marks };

/** The columns in display order; the ones named in `GIVE_WAY` leave first, in that order. */
const ALL = [NAME, TITLE, DOMAIN, SESSIONS, CONFIDENCE, WRITTEN, NOTES];
const GIVE_WAY = [DOMAIN, CONFIDENCE, WRITTEN, SESSIONS];

function widthOf(column: Column, entries: LibraryEntry[]): number {
  return Math.max(visibleWidth(column.header), ...entries.map((e) => visibleWidth(column.cell(e))));
}

/** The narrowest a set of columns can be: shrinkable ones at their floor, the rest whole. */
function narrowest(columns: Column[], entries: LibraryEntry[]): number {
  const cells = columns.map((c) => Math.min(widthOf(c, entries), c.shrinkTo ?? Infinity));
  return cells.reduce((sum, n) => sum + n, GAP * (columns.length - 1));
}

/** One prompt per block: the name whole, the rest wrapped beneath it. */
function stacked(entries: LibraryEntry[], width: number): string {
  const dot = ` ${glyph("·", "|")} `;
  return entries
    .flatMap((e) => {
      const sessions = e.sources.members.length;
      // A short fact never breaks across lines: its spaces do not wrap.
      const whole = (fact: string) => fact.replaceAll(" ", "\u00a0");
      const facts = [
        e.sources.title,
        whole(`${sessions} ${sessions === 1 ? "session" : "sessions"}`),
        e.sources.confidence,
        whole(`written ${e.sources.authored_at.slice(0, 10)}`),
        whole(marks(e)),
      ].filter(Boolean);
      return [bold(e.slug), ...wrapText(facts.join(dot), width, { indent: "  " }).map(dim)];
    })
    .join("\n");
}

/**
 * The library as a table that fits `width` columns, or the complete table
 * when no width applies (a pipe keeps every column whole for scripts).
 */
export function renderLibraryTable(entries: LibraryEntry[], width?: number): string {
  // The Notes column appears only when some prompt is edited, rated, or not
  // verified, so it is never empty.
  const all = ALL.filter((c) => c !== NOTES || entries.some((e) => marks(e) !== ""));
  if (width === undefined) {
    return table(
      entries.map((e) => all.map((c) => c.cell(e))),
      { header: all.map((c) => c.header), maxWidth: Number.POSITIVE_INFINITY },
    );
  }
  let columns = all;
  for (const leaving of GIVE_WAY) {
    if (narrowest(columns, entries) <= width) break;
    columns = columns.filter((c) => c !== leaving);
  }
  if (narrowest(columns, entries) > width) return stacked(entries, width);
  const widths = columns.map((c) => widthOf(c, entries));
  let total = widths.reduce((sum, n) => sum + n, GAP * (columns.length - 1));
  // Shorten the widest column that may still give way, one column at a time.
  while (total > width) {
    let widest = -1;
    for (const [i, column] of columns.entries()) {
      const floor = column.shrinkTo;
      if (floor === undefined || (widths[i] ?? 0) <= floor) continue;
      if (widest < 0 || (widths[i] ?? 0) > (widths[widest] ?? 0)) widest = i;
    }
    if (widest < 0) break;
    widths[widest] = (widths[widest] ?? 0) - 1;
    total--;
  }
  const row = (cells: string[]) =>
    cells
      .map((cell, i) => {
        const size = widths[i] ?? 0;
        const text = truncateVisible(cell, size);
        return text + " ".repeat(Math.max(0, size - visibleWidth(text)));
      })
      .join(" ".repeat(GAP))
      .trimEnd();
  const header = row(columns.map((c) => bold(c.header)));
  const divider = dim(widths.map((n) => "-".repeat(n)).join(" ".repeat(GAP)));
  return [header, divider, ...entries.map((e) => row(columns.map((c) => c.cell(e))))].join("\n");
}
