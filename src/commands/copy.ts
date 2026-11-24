import fs from "node:fs";
import { defineCommand } from "citty";
import { findEntry, parseOneshot } from "../core/library.js";
import { copyToClipboard } from "../ui/clipboard.js";
import { dim, green } from "../ui/style.js";
import { promptNameArg, resolvePaths, sharedArgs, unknownPromptMessage } from "./_shared.js";
import { offerNext } from "./next.js";

export default defineCommand({
  meta: {
    name: "copy",
  },
  args: {
    ...sharedArgs,
    name: promptNameArg,
  },
  async run({ args }) {
    const { home } = resolvePaths(args);
    const slug = String(args.name);
    const entry = findEntry(home, slug);
    if (!entry) {
      console.error(unknownPromptMessage(home, slug));
      process.exitCode = 1;
      return;
    }

    let content: string;
    try {
      content = fs.readFileSync(entry.oneshotPath, "utf8");
    } catch {
      console.error(`The prompt "${slug}" has no prompt file (${entry.oneshotPath}).`);
      process.exitCode = 1;
      return;
    }

    // Keep provenance in the file and put only the prompt body on the clipboard.
    const { body } = parseOneshot(content);
    const words = body.split(/\s+/).filter(Boolean).length;
    const result = await copyToClipboard(body);

    if (result.ok) {
      console.log(green(`copied "${slug}" to the clipboard (${words} words, via ${result.tool})`));
      console.log(dim("paste it into a fresh session with your coding agent."));
      await offerNext("preferences", args);
    } else if (result.terminalAttempted) {
      console.log("Sent a clipboard request to your terminal. You can also copy the prompt below.");
      console.log(body);
    } else {
      console.error(`could not copy (${result.error}). Here is the prompt:`);
      console.log();
      console.log(body);
      process.exitCode = 1;
    }
  },
});
