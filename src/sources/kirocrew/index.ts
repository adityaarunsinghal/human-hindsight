/**
 * sources/kirocrew/index.ts: Kiro Crew's own chat store as a SessionSource.
 *
 * Binds a Kiro Crew data directory (default `~/.kiro/crew`) to the discover,
 * extract (C1 to C7) and timeline functions in this folder. Lines are read from
 * `session.path` by the default reader; no custom `read` is needed.
 *
 * Classification is session level and comes from the file name alone, because
 * Kiro Crew names each transcript by what started it: `dashboard_chat-*` is a
 * chat a person typed in, while scheduled jobs, setup recovery and member
 * memory runs carry their own prefixes ({@link KIROCREW_AUTOMATION_PREFIXES}).
 * An archive snapshot (`<stem>__<stamp>.jsonl`) classifies by the stem before
 * `__`. An unknown prefix is interactive, the same recall-oriented default the
 * kiro source uses.
 */

import type { SessionInfo, SessionSource } from "../types.js";
import { discoverKirocrewSessions } from "./discover.js";
import { extractKirocrewMessages, kirocrewTimeline } from "./extract.js";

export {
  collectKirocrewSessions,
  discoverKirocrewSessions,
  KIROCREW_ARCHIVE_SUBDIR,
  KIROCREW_SESSIONS_SUBDIR,
  type KirocrewProjectInfo,
  type KirocrewSessionInfo,
  type KirocrewSessionMeta,
  kirocrewStoreExists,
} from "./discover.js";
export {
  extractKirocrewMessages,
  KIROCREW_USER_ENVELOPES,
  kirocrewTimeline,
} from "./extract.js";

/** File-name prefixes of chats a person typed in. */
export const KIROCREW_INTERACTIVE_PREFIXES: readonly string[] = ["dashboard_chat-"];

/** File-name prefixes of transcripts Kiro Crew started on its own. */
export const KIROCREW_AUTOMATION_PREFIXES: readonly string[] = [
  "cron_",
  "dashboard_cron",
  "dashboard_setup-recovery",
  "dashboard_member-mate",
];

/** The live-chat stem a file name stands for: archive snapshots drop their `__<stamp>` suffix. */
function liveStem(file: string): string {
  const base = file.replace(/\.jsonl$/, "");
  const cut = base.indexOf("__");
  return cut === -1 ? base : base.slice(0, cut);
}

/** Classify a Crew transcript by its file name (see the module comment). */
export function classifyKirocrewFile(file: string): "interactive" | "automation" {
  const stem = liveStem(file);
  if (KIROCREW_INTERACTIVE_PREFIXES.some((prefix) => stem.startsWith(prefix))) return "interactive";
  if (KIROCREW_AUTOMATION_PREFIXES.some((prefix) => stem.startsWith(prefix))) return "automation";
  return "interactive";
}

/** Construct the Kiro Crew source bound to a data directory. */
export function kirocrewSource(kirocrewDir: string): SessionSource {
  return {
    name: "kirocrew",
    discover: (opts) => discoverKirocrewSessions(kirocrewDir, opts),
    extract: extractKirocrewMessages,
    timeline: kirocrewTimeline,
    classify: (session: SessionInfo & { project: string }) => classifyKirocrewFile(session.file),
  };
}
