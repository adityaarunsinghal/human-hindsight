import { createHash } from "node:crypto";
import type { SourceName } from "../sources/types.js";

/** Inputs that identify one generated artifact, independent of JSON key order. */
export interface StageLineage {
  version: 1;
  fingerprint: string;
  prompt_version: number;
  schema_hash: string;
  model: string | null;
  runner: SourceName | null;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

/** Stable hash for JSON-shaped stage inputs; array ordering stays significant. */
export function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

/** Match the original bytes of an exported transcript, before any truncation. */
export function contentFingerprint(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Cheap read-side freshness check for preference evidence, without an LLM call. */
export function digestSourceFingerprint(opts: {
  content: string;
  outcome?: unknown;
  project: string;
  sessionId: string;
  origin?: SourceName;
}): string {
  return fingerprint({
    content: opts.content,
    outcome: opts.outcome ?? null,
    project: opts.project,
    sessionId: opts.sessionId,
    origin: opts.origin ?? "claude",
  });
}

export function stageLineage(opts: {
  stage: "digest" | "cluster" | "author";
  promptVersion: number;
  schema: unknown;
  inputs: unknown;
  model?: string;
  runnerName?: SourceName;
}): StageLineage {
  const schemaHash = fingerprint(opts.schema);
  const identity = {
    version: 1 as const,
    prompt_version: opts.promptVersion,
    schema_hash: schemaHash,
    model: opts.model ?? null,
    runner: opts.runnerName ?? null,
  };
  return {
    ...identity,
    fingerprint: fingerprint({ stage: opts.stage, ...identity, inputs: opts.inputs }),
  };
}

/** Legacy or malformed metadata cannot establish that an artifact is current. */
export function sameLineage(value: unknown, current: StageLineage): boolean {
  if (typeof value !== "object" || value === null) return false;
  const previous = value as Partial<StageLineage>;
  return (
    previous.version === 1 &&
    previous.fingerprint === current.fingerprint &&
    previous.prompt_version === current.prompt_version &&
    previous.schema_hash === current.schema_hash &&
    previous.model === current.model &&
    previous.runner === current.runner
  );
}
