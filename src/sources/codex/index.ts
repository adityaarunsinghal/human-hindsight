import type { SessionSource } from "../types.js";
import { discoverCodexProjects, isCodexAutomation } from "./discover.js";
import { extractCodexMessages, extractCodexTimeline } from "./extract.js";

export function codexSource(codexDir: string): SessionSource {
  return {
    name: "codex",
    discover: (opts) => discoverCodexProjects(codexDir, opts),
    extract: extractCodexMessages,
    timeline: extractCodexTimeline,
    classify(session) {
      const meta = "meta" in session ? session.meta : undefined;
      if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
      return isCodexAutomation(meta as Record<string, unknown>) ? "automation" : "interactive";
    },
  };
}
