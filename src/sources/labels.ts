/**
 * sources/labels.ts: the one map from a backend's `SourceName` to the product
 * name a person knows it by.
 *
 * `SourceName` values are short machine ids (`kiro`, `kirocrew`); people know
 * the tools as Kiro CLI and Kiro Crew. Every place that names a backend to a
 * person (the scan `Found` banner, the digest and cluster prompts) reads this
 * map, so a new backend is named in exactly one spot.
 */

import type { SourceName } from "./types.js";

/** Product name per backend. */
export const SOURCE_PRODUCT_NAMES: Readonly<Record<SourceName, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  kiro: "Kiro CLI",
  kirocrew: "Kiro Crew",
  opencode: "OpenCode",
};

/**
 * Human-facing name of a session's source backend. An absent origin is a
 * manifest written before the multi-backend seam, which only read Claude Code;
 * an unknown value read from an old or hand-edited manifest falls back the same way.
 */
export function sourceLabel(origin: SourceName | undefined): string {
  return SOURCE_PRODUCT_NAMES[origin ?? "claude"] ?? SOURCE_PRODUCT_NAMES.claude;
}
