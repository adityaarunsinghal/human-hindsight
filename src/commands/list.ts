import type { Writable } from "node:stream";
import { defineCommand } from "citty";
import { readLibrary } from "../core/library.js";
import { renderLibraryTable } from "../ui/library-table.js";
import type { TerminalOutput } from "../ui/mode.js";
import { green } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";
import { offerNext } from "./next.js";

/**
 * What `list` prints: the library table, fitted to the terminal (a pipe gets
 * every column whole), and the count. Returns the command to offer next.
 */
export function runList(
  args: { home?: string },
  output: Writable = process.stdout,
): "reflect" | "gui" {
  const write = (line = "") => output.write(`${line}\n`);
  const entries = readLibrary(resolvePaths(args).home);
  if (entries.length === 0) {
    write("Your library is empty. A reflection builds it from your exported sessions.");
    return "reflect";
  }
  const terminal = output as TerminalOutput;
  const width = terminal.isTTY ? Math.max(20, Math.floor(terminal.columns || 80)) : undefined;
  write(renderLibraryTable(entries, width));
  write();
  write(green(`${entries.length} ${entries.length === 1 ? "prompt" : "prompts"}`));
  return "gui";
}

export default defineCommand({
  meta: {
    name: "list",
  },
  args: { ...sharedArgs },
  async run({ args }) {
    await offerNext(runList(args), args);
  },
});
