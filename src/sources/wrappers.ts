/**
 * sources/wrappers.ts: leading machine wrappers on a human-side piece (rules
 * R6 for Claude Code, K6 for kiro, C2 for Codex).
 *
 * Agent CLIs inject their own text into the same field that holds what the
 * person typed, as XML-like blocks at the start of the piece: reminders, task
 * notifications, shell input and output, IDE selections, hook output, steering
 * files, environment context. New harness versions add new tags without
 * notice, so a fixed list alone admits machine text as human text.
 *
 * The rule, applied repeatedly at the start of the piece:
 *   1. A complete leading block `<tag ...>...</tag>` (or `<tag/>`) is a machine
 *      wrapper when its tag is on the source's known list (case-sensitive), or
 *      when its name is all lowercase and contains `-` or `_`, the shape every
 *      harness tag seen so far has used.
 *   2. A piece that opens with a KNOWN tag that is never closed is machine text
 *      whole (a truncated injection), so nothing of it is kept.
 *   3. Anything else starts the person's words and stops the scan: PascalCase
 *      names such as `<Button>`, plain one-word HTML tags such as `<div>`, and
 *      an unclosed tag that is not on the known list.
 *   4. Text after the removed blocks is kept as the person's words.
 * Callers record every removed block as a Drop, so `export --verbose` shows it.
 *
 * Output wrappers (`rules.output`) hold whatever a program printed, and a
 * program can print the wrapper's own closing tag (`grep "</bash-stdout>"`).
 * For them two more rules apply:
 *   5. The block ends at the LAST closing tag of the same name in the piece,
 *      not the first, so printed closers stay inside the block.
 *   6. After an output block, text that still holds a closing tag of any
 *      output wrapper is inside a wrapper too (one wrapper's output printed the
 *      closer of a sibling), so the piece is cut through the last such closer.
 *      Only text outside every wrapper is kept.
 * Output tags count as known tags, so an unclosed one drops the whole piece.
 *
 * A source can narrow the rules for a harness that only ever writes complete
 * blocks from a fixed list: `shape: false` uses the exact list alone, and
 * `unclosedIsMachine: false` keeps a leading known tag that is never closed as
 * the person's words.
 *
 * Trade-off: a person who starts a message with a complete hyphenated custom
 * element (`<my-widget>...</my-widget> why is this blank?`) loses that element;
 * the prose after it is kept and the removal is visible in the drop list.
 * Admitting machine text silently is the worse failure for this tool.
 */

/** A complete wrapper at the start of a candidate human text block. */
export interface Wrapper {
  tag: string;
  body: string;
  raw: string;
}

/** How a source reads its leading wrappers; see the module comment. */
export interface WrapperRules {
  /** Tags whose body is arbitrary program output (rules 5 and 6). */
  output?: ReadonlySet<string>;
  /** Treat any lowercase tag with `-` or `_` as machine text (default true). */
  shape?: boolean;
  /** An unclosed known tag makes the whole piece machine text (default true). */
  unclosedIsMachine?: boolean;
}

/** What remains of a piece after its leading wrappers are removed. */
export interface LeadingWrappers {
  /** Complete machine blocks removed from the start, in order. */
  blocks: Wrapper[];
  /** The person's words: "" when nothing human remains. */
  text: string;
  /** The rest of the piece from an unclosed known tag on; `text` is then "". */
  unclosed?: string;
}

const NONE: ReadonlySet<string> = new Set();

// Only the outer harness tag needs parsing. Its body can contain source code,
// shell output or prose with arbitrary angle brackets.
const attributes = String.raw`(?:\s+[A-Za-z_:][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*\s*`;
const openingTag = new RegExp(`^<([A-Za-z][\\w-]*)${attributes}(/?)>`);

/** Lowercase letters and digits, with at least one `-` or `_` separator. */
const HARNESS_SHAPE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+$/;

/** True when a leading block with this tag name is machine text (rule 1 above). */
export function isMachineTag(tag: string, known: ReadonlySet<string>): boolean {
  return known.has(tag) || HARNESS_SHAPE.test(tag);
}

/** The last match of a global pattern in `text`, searching from `from`. */
function lastMatch(pattern: RegExp, text: string, from = 0): RegExpExecArray | null {
  pattern.lastIndex = from;
  let last: RegExpExecArray | null = null;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) last = match;
  return last;
}

type Read = { kind: "block"; block: Wrapper } | { kind: "unclosed" } | { kind: "human" };

function readWrapper(text: string, known: ReadonlySet<string>, rules: WrapperRules): Read {
  const output = rules.output ?? NONE;
  const opening = openingTag.exec(text);
  const tag = opening?.[1];
  if (!opening || !tag) return { kind: "human" };
  const knownTag = known.has(tag) || output.has(tag);
  if (!knownTag && (rules.shape === false || !HARNESS_SHAPE.test(tag))) return { kind: "human" };
  if (opening[2]) return { kind: "block", block: { tag, body: "", raw: opening[0] } };
  const block = (end: number, rawEnd: number): Read => ({
    kind: "block",
    block: { tag, body: text.slice(opening[0].length, end), raw: text.slice(0, rawEnd) },
  });

  // Tag names match `[A-Za-z][\w-]*`, so they need no escaping in a pattern.
  if (output.has(tag)) {
    // Rule 5: program output can print this very closer, so the last one ends it.
    const last = lastMatch(new RegExp(`</${tag}\\s*>`, "g"), text, opening[0].length);
    if (last) return block(last.index, last.index + last[0].length);
  } else {
    // Match this wrapper's closing tag, including nested copies of the same tag.
    const delimiters = new RegExp(`</${tag}\\s*>|<${tag}${attributes}(/?)>`, "g");
    delimiters.lastIndex = opening[0].length;
    let depth = 1;
    for (let match = delimiters.exec(text); match; match = delimiters.exec(text)) {
      if (match[0].startsWith("</")) depth--;
      else if (!match[1]) depth++;
      if (depth === 0) return block(match.index, delimiters.lastIndex);
    }
  }
  // Never closed: a known tag is a truncated injection; anything else may be
  // the person writing about a tag, so it stays.
  return knownTag && rules.unclosedIsMachine !== false ? { kind: "unclosed" } : { kind: "human" };
}

/**
 * Rule 6: after an output block, the rest of the piece up to the last closing
 * tag of any output wrapper is still wrapped output. Returns the length of that
 * stretch, or 0 when no closer is left.
 */
function outputRemnant(text: string, output: ReadonlySet<string>): number {
  if (!output.size || !text) return 0;
  const last = lastMatch(new RegExp(`</(${[...output].join("|")})\\s*>`, "g"), text);
  return last ? last.index + last[0].length : 0;
}

/** Remove the machine wrappers at the start of a piece (see the module comment). */
export function leadingWrappers(
  raw: string,
  known: ReadonlySet<string>,
  rules: WrapperRules = {},
): LeadingWrappers {
  const output = rules.output ?? NONE;
  const piece = raw.trim();
  const blocks: Wrapper[] = [];
  // Where the scan stands in `piece`, where the last block began, and whether
  // an output block has been removed from this piece (rule 6 then applies).
  let pos = 0;
  let lastStart = 0;
  let afterOutput = false;
  const skipSpace = () => {
    while (pos < piece.length && /\s/.test(piece.charAt(pos))) pos++;
  };
  for (;;) {
    const text = piece.slice(pos);
    if (text.startsWith("<")) {
      const read = readWrapper(text, known, rules);
      if (read.kind === "unclosed") return { blocks, text: "", unclosed: text };
      if (read.kind === "block") {
        blocks.push(read.block);
        afterOutput ||= output.has(read.block.tag);
        lastStart = pos;
        pos += read.block.raw.length;
        skipSpace();
        continue;
      }
    }
    const remnant = afterOutput ? outputRemnant(text, output) : 0;
    const block = blocks.at(-1);
    if (!remnant || !block) break;
    // The stretch is still wrapped output: extend the block before it, so its
    // drop record shows the whole run. `raw` then spans that block and the
    // stretch; `body` stays the block's own body.
    pos += remnant;
    block.raw = piece.slice(lastStart, pos);
    skipSpace();
  }
  return { blocks, text: piece.slice(pos) };
}
