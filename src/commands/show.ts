import fs from "node:fs";
import { defineCommand } from "citty";
import { findEntry, isOutcomeVerified, parseOneshot } from "../core/library.js";
import { renderMarkdownAnsi } from "../ui/markdown.js";
import { canColor, glyph, lineWidth } from "../ui/mode.js";
import { bold, dim } from "../ui/style.js";
import { fitLines } from "../ui/wrap.js";
import { promptNameArg, resolvePaths, sharedArgs, unknownPromptMessage } from "./_shared.js";
import { offerNext } from "./next.js";

export default defineCommand({
  meta: {
    name: "show",
  },
  args: {
    ...sharedArgs,
    name: promptNameArg,
    raw: {
      type: "boolean",
      description: "Print the prompt as plain Markdown, without styling or wrapping",
    },
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

    const { title, body } = parseOneshot(content);
    const s = entry.sources;
    const separator = ` ${glyph("·", "|")} `;
    const coverage =
      typeof s.input_coverage === "number" && s.input_coverage < 1
        ? `${separator}written from ${(s.input_coverage * 100).toFixed(1)}% of the source text`
        : "";
    console.log(bold(`# ${title ?? s.title ?? slug}`));
    const facts =
      `${s.members?.length ?? 0} ${s.members?.length === 1 ? "session" : "sessions"}${separator}${s.outcome_summary ?? "?"}${separator}` +
      `confidence ${s.confidence ?? "?"}${separator}written ${(s.authored_at ?? "").slice(0, 10)}` +
      (s.domains?.length ? `${separator}domain: ${s.domains.join(", ")}` : "") +
      coverage;
    const width = lineWidth();
    for (const line of fitLines([facts], width)) console.log(dim(line));
    // Said near the title, in plain words; --raw output is only the prompt's header and body.
    if (!args.raw && !isOutcomeVerified(s))
      console.log("Outcome not verified: none of its sessions was seen to reach a result.");
    console.log();
    // Raw Markdown for --raw and wherever styling is not allowed (`show x | pbcopy`,
    // NO_COLOR, TERM=dumb). Whether stdin is a terminal does not matter here.
    if (args.raw || !canColor()) {
      console.log(body);
    } else {
      console.log(renderMarkdownAnsi(body));
    }
    console.log();
    await offerNext("copy", { ...args, slug });
  },
});
