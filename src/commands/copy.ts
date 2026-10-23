import fs from "node:fs";
import { defineCommand } from "citty";
import { findEntry, parseOneshot } from "../core/library.js";
import { copyToClipboard } from "../ui/clipboard.js";
import { dim, green } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";
import { offerNext } from "./next.js";

export default defineCommand({
  meta: {
    name: "copy",
    description: "Copy a oneshot prompt to the clipboard",
  },
  args: {
    ...sharedArgs,
    slug: {
      type: "positional",
      description: "Library entry slug",
      required: true,
    },
  },
  async run({ args }) {
    const { home } = resolvePaths(args);
    const slug = String(args.slug);
    const entry = findEntry(home, slug);
    if (!entry) {
      console.error(`no library entry "${slug}" — try \`human-hindsight list\`.`);
      process.exitCode = 1;
      return;
    }

    let content: string;
    try {
      content = fs.readFileSync(entry.oneshotPath, "utf8");
    } catch {
      console.error(`entry "${slug}" has no oneshot file (${entry.oneshotPath}).`);
      process.exitCode = 1;
      return;
    }

    // The paste-able prompt is the body — provenance stays in the file.
    const { body } = parseOneshot(content);
    const words = body.split(/\s+/).filter(Boolean).length;
    const result = await copyToClipboard(body);

    if (result.ok) {
      console.log(green(`copied "${slug}" to the clipboard (${words} words, via ${result.tool})`));
      console.log(dim("paste it into a fresh session with your coding agent."));
      await offerNext("preferences", args);
    } else {
      console.error(`could not copy (${result.error}). Here is the prompt:`);
      console.log();
      console.log(body);
      process.exitCode = 1;
    }
  },
});
