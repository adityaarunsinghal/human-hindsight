import { spawnSync } from "node:child_process";
import fs from "node:fs";
import type { Writable } from "node:stream";
import { defineCommand } from "citty";
import { findEntry, isEdited } from "../core/library.js";
import { acquireWriterLock, WriterBusyError } from "../distill/operations.js";
import { glyph } from "../ui/mode.js";
import { dim, green, hint } from "../ui/style.js";
import { promptNameArg, resolvePaths, sharedArgs, unknownPromptMessage } from "./_shared.js";
import { nextCommandText, offerNext } from "./next.js";

/**
 * commands/edit.ts: open a saved prompt in the user's editor.
 *
 * The library is the user's, not the tool's: hand-tuning an authored prompt is
 * the expected workflow. Edits are detected by hash mismatch against the
 * `oneshot_hash` recorded at author time: an edited entry is badged in `list`
 * and never overwritten by a re-run of `distill` without `--force`.
 */

export interface EditArgs {
  home?: string;
  "claude-dir"?: string;
  slug?: string;
}

export interface EditDeps {
  /** Injectable editor launcher (default: $VISUAL/$EDITOR/vi via spawnSync). */
  launch?: (file: string) => number;
  output?: Writable;
}

function defaultLaunch(file: string): number {
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  // Support multi-word values like "code --wait" by splitting on whitespace;
  // no shell is involved, and the file path is passed as a discrete argument
  // (never interpolated), so paths with spaces or metacharacters are safe.
  const [cmd = "vi", ...editorArgs] = editor.split(/\s+/).filter(Boolean);
  const res = spawnSync(cmd, [...editorArgs, file], { stdio: "inherit" });
  return res.status ?? 1;
}

/** Testable core of `edit`. Returns the process exit code. */
export function runEdit(args: EditArgs, deps: EditDeps = {}): number {
  const { home } = resolvePaths(args);
  const out = deps.output ?? process.stdout;
  const write = (s: string) => out.write(`${s}\n`);
  const launch = deps.launch ?? defaultLaunch;

  const slug = String(args.slug ?? "");
  const entry = findEntry(home, slug);
  if (!entry) {
    write(unknownPromptMessage(home, slug));
    return 1;
  }
  if (!fs.existsSync(entry.oneshotPath)) {
    write(`The prompt "${slug}" has no prompt file (${entry.oneshotPath}).`);
    return 1;
  }

  // While the editor is open the lock keeps distill from publishing over the
  // file; while another command holds it, the editor does not open.
  let writer: ReturnType<typeof acquireWriterLock>;
  try {
    writer = acquireWriterLock(home, "edit");
  } catch (error) {
    if (!(error instanceof WriterBusyError)) throw error;
    write(error.message);
    return 1;
  }
  let status: number;
  try {
    status = launch(entry.oneshotPath);
  } finally {
    writer.release();
  }
  if (status !== 0) {
    write(`editor exited with status ${status}; file left as-is.`);
    return 1;
  }

  // Re-read to report whether the entry is now (or still) hand-edited.
  const fresh = findEntry(home, slug);
  if (fresh && isEdited(fresh)) {
    write(
      green(
        `${glyph("✎", "*")} ${slug} edited. Distill will keep your version (use --force to write it again).`,
      ),
    );
  } else {
    write(dim(`${slug} unchanged.`));
  }
  write(hint(nextCommandText("show", args)));
  return 0;
}

export default defineCommand({
  meta: {
    name: "edit",
  },
  args: {
    ...sharedArgs,
    name: promptNameArg,
  },
  async run({ args }) {
    const code = runEdit({ ...args, slug: args.name } as unknown as EditArgs);
    if (code !== 0) process.exitCode = code;
    else await offerNext("show", { ...args, slug: args.name }, { hintPrinted: true });
  },
});
