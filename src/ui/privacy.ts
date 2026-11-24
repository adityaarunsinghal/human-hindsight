import type { Writable } from "node:stream";
import { PRIVACY_REMINDER, PUBLIC_REPOSITORY_URL } from "../core/privacy.js";
import { canAnimate, type TerminalOutput, terminalWidth } from "./mode.js";
import { wrapText } from "./wrap.js";

/**
 * The open-source notice. It always includes the destination for terminals
 * that ignore hyperlinks. On a terminal it wraps at word boundaries to the
 * width (the address stays whole); in a pipe it stays one line.
 */
export function terminalPrivacyReminder(output: Writable): string {
  // Hyperlink escapes need a drawing terminal; stdin is irrelevant here.
  const url = canAnimate({ output })
    ? `\u001b]8;;${PUBLIC_REPOSITORY_URL}\u001b\\${PUBLIC_REPOSITORY_URL}\u001b]8;;\u001b\\`
    : PUBLIC_REPOSITORY_URL;
  const text = PRIVACY_REMINDER.replace("fully open source", `fully open source (${url})`);
  const terminal = output as TerminalOutput;
  return terminal.isTTY ? wrapText(text, terminalWidth(terminal)).join("\n") : text;
}
