import fs from "node:fs";
import type { Readable, Writable } from "node:stream";
import { defineCommand } from "citty";
import { isEdited, readLibrary } from "../core/library.js";
import { askYesNoAnswer } from "../distill/consent.js";
import { acquireWriterLock, WriterBusyError, writerBusyReason } from "../distill/operations.js";
import { loadTasks } from "../distill/pipeline.js";
import type { TerminalHost } from "../ui/live.js";
import { dim, green, hint, yellow } from "../ui/style.js";
import { leftBehindEntries, resolvePaths, sharedArgs } from "./_shared.js";
import { type NextCommand, nextCommandText, offerNext } from "./next.js";

/**
 * commands/prune.ts: delete library entries left behind by a regrouping.
 *
 * A left-behind entry is what `status` flags: an entry whose slug is no longer
 * in the current tasks checkpoint, or whose generation doesn't match it (a later
 * grouping merged, renamed, or regenerated its task). Deletion is destructive,
 * so it is consent-gated ([y/N], `--yes` to skip) and hand-edited entries are
 * kept unless `--force`, the same protection `distill` gives them.
 */

export interface PruneArgs {
  home?: string;
  "claude-dir"?: string;
  yes?: boolean;
  force?: boolean;
  "dry-run"?: boolean;
}

export interface PruneDeps {
  input?: Readable;
  output?: Writable;
  /** Where Ctrl-C arrives (default `process`). */
  host?: TerminalHost;
  next?: (command: NextCommand) => void;
}

/**
 * Testable core of `prune`. Returns the process exit code (2 = declined).
 * Deletion holds the data home's writer lock from the listing to the last
 * removal, so a running distill's new grouping is never mistaken for a left
 * behind entry; while another command holds it, prune says which and stops.
 */
export async function runPrune(args: PruneArgs, deps: PruneDeps = {}): Promise<number> {
  const { home } = resolvePaths(args);
  const out = deps.output ?? process.stdout;
  const write = (s: string) => out.write(`${s}\n`);
  if (args["dry-run"]) {
    const busy = writerBusyReason(home);
    if (busy) {
      write(busy);
      return 1;
    }
    return pruneLocked(args, home, deps, write);
  }
  let writer: ReturnType<typeof acquireWriterLock>;
  try {
    writer = acquireWriterLock(home, "prune");
  } catch (error) {
    if (!(error instanceof WriterBusyError)) throw error;
    write(error.message);
    return 1;
  }
  try {
    return await pruneLocked(args, home, deps, write);
  } finally {
    writer.release();
  }
}

async function pruneLocked(
  args: PruneArgs,
  home: string,
  deps: PruneDeps,
  write: (s: string) => void,
): Promise<number> {
  const tasks = loadTasks(home);
  if (!tasks) {
    write(
      `No reflection checkpoint yet. Run ${nextCommandText("reflect", args)} before looking for left-behind entries.`,
    );
    write(hint(nextCommandText("status", args)));
    deps.next?.("status");
    return 1;
  }

  const orphans = leftBehindEntries(readLibrary(home), tasks);
  if (orphans.length === 0) {
    write(green("No library entries were left behind."));
    return 0;
  }

  // Hand-edited orphans are the user's work; keep them unless --force.
  const kept = args.force ? [] : orphans.filter((e) => isEdited(e));
  const removable = orphans.filter((e) => !kept.includes(e));

  write(
    `${orphans.length} librar${orphans.length === 1 ? "y entry was" : "y entries were"} left behind when sessions were regrouped:`,
  );
  for (const e of removable) {
    write(`  Remove ${e.slug}`);
  }
  for (const e of kept) {
    write(`  Keep ${e.slug} ${yellow("edited by hand (use --force to remove)")}`);
  }

  if (removable.length === 0) {
    write(dim("nothing removable without --force."));
    return 0;
  }

  if (args["dry-run"]) {
    write(
      dim(`dry-run: would remove ${removable.length} entr${removable.length === 1 ? "y" : "ies"}.`),
    );
    return 0;
  }

  if (!args.yes) {
    const answer = await askYesNoAnswer(
      `Remove ${removable.length} left-behind entr${removable.length === 1 ? "y" : "ies"}?`,
      { input: deps.input, output: deps.output, host: deps.host },
    );
    // Ctrl-C means one thing everywhere: one line, exit 130.
    if (answer === "interrupt") {
      write("Interrupted. Nothing removed.");
      return 130;
    }
    if (answer !== "yes") {
      write("Declined. Nothing removed.");
      return 2;
    }
  }

  for (const e of removable) {
    fs.rmSync(e.dir, { recursive: true, force: true });
    write(`  removed ${e.slug}`);
  }
  write(green(`${removable.length} entr${removable.length === 1 ? "y" : "ies"} pruned.`));
  write(hint(nextCommandText("list", args)));
  deps.next?.("list");
  return 0;
}

export default defineCommand({
  meta: {
    name: "prune",
  },
  args: {
    ...sharedArgs,
    yes: { type: "boolean", description: "Skip the confirmation prompt" },
    force: { type: "boolean", description: "Also remove entries you edited by hand" },
    "dry-run": { type: "boolean", description: "List what would be removed; remove nothing" },
  },
  async run({ args }) {
    let next: NextCommand | undefined;
    const code = await runPrune(args as unknown as PruneArgs, {
      next: (command) => {
        next = command;
      },
    });
    if (code !== 0) process.exitCode = code;
    if (next) await offerNext(next, args, { hintPrinted: true });
  },
});
