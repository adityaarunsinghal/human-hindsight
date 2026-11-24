import fs from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import { defineCommand } from "citty";
import { atomicWriteFilePrivate } from "../core/fsutil.js";
import { findEntry } from "../core/library.js";
import { acquireWriterLock, WriterBusyError } from "../distill/operations.js";
import { glyph } from "../ui/mode.js";
import { green, hint } from "../ui/style.js";
import { promptNameArg, resolvePaths, sharedArgs, unknownPromptMessage } from "./_shared.js";
import { nextCommandText, offerNext } from "./next.js";

/**
 * commands/rate.ts: record a verdict on a saved prompt.
 *
 * `rating: up|down` + `rated_at` land in `sources.json` (declared optional in
 * its schema). `list` shows the badge; a rating is feedback for the user's
 * own curation; it never changes pipeline behavior.
 */

export interface RateArgs {
  home?: string;
  "claude-dir"?: string;
  slug?: string;
  rating?: string;
}

export interface RateDeps {
  output?: Writable;
}

/** Testable core of `rate`. Returns the process exit code. */
export function runRate(args: RateArgs, deps: RateDeps = {}): number {
  const { home } = resolvePaths(args);
  const out = deps.output ?? process.stdout;
  const write = (s: string) => out.write(`${s}\n`);

  const slug = String(args.slug ?? "");
  const rating = String(args.rating ?? "");
  if (rating !== "up" && rating !== "down") {
    write(`rating must be "up" or "down" (got "${rating}").`);
    return 1;
  }

  // The lock keeps a running distill from publishing between the read and the
  // write below, which would bring back the old prompt hash.
  let writer: ReturnType<typeof acquireWriterLock>;
  try {
    writer = acquireWriterLock(home, "rate");
  } catch (error) {
    if (!(error instanceof WriterBusyError)) throw error;
    write(error.message);
    return 1;
  }
  try {
    const entry = findEntry(home, slug);
    if (!entry) {
      write(unknownPromptMessage(home, slug));
      return 1;
    }
    // Change only the two rating fields of the file as it is, so every other
    // field keeps its exact bytes (the parsed copy fills in defaults).
    const file = path.join(entry.dir, "sources.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const sources = { ...raw, rating, rated_at: new Date().toISOString() };
    atomicWriteFilePrivate(file, `${JSON.stringify(sources, null, 2)}\n`);
  } finally {
    writer.release();
  }

  write(green(`${rating === "up" ? glyph("▲", "+") : glyph("▼", "-")} ${slug} rated ${rating}.`));
  write(hint(nextCommandText("list", args)));
  return 0;
}

export default defineCommand({
  meta: {
    name: "rate",
  },
  args: {
    ...sharedArgs,
    name: promptNameArg,
    rating: {
      type: "positional",
      description: "up or down",
      required: true,
    },
  },
  async run({ args }) {
    const code = runRate({ ...args, slug: args.name } as unknown as RateArgs);
    if (code !== 0) process.exitCode = code;
    else await offerNext("list", args, { hintPrinted: true });
  },
});
