import type { Writable } from "node:stream";
import { PRIVACY_REMINDER, PUBLIC_REPOSITORY_URL } from "../core/privacy.js";

/** OSC 8 makes the phrase clickable in terminals; plain output retains the URL. */
export function terminalPrivacyReminder(output: Writable): string {
  const linked =
    (output as Writable & { isTTY?: boolean }).isTTY && process.env.TERM !== "dumb"
      ? `\u001b]8;;${PUBLIC_REPOSITORY_URL}\u001b\\fully open source\u001b]8;;\u001b\\`
      : `fully open source (${PUBLIC_REPOSITORY_URL})`;
  return PRIVACY_REMINDER.replace("fully open source", linked);
}
