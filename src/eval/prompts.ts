import { createHash } from "node:crypto";
import { z } from "zod";
import fixtures from "../../test/fixtures/prompt-evals/cases.json" with { type: "json" };
import { AUTHOR_PROMPT_VERSION, buildAuthorPrompt } from "../claude/prompts/author.js";
import { CLUSTER_PROMPT_VERSION } from "../claude/prompts/cluster.js";
import { buildDigestPrompt, DIGEST_PROMPT_VERSION } from "../claude/prompts/digest.js";
import {
  AuthorSchema,
  ClusterSchema,
  ConsolidateSchema,
  DigestResponseSchema,
  DigestSchema,
  PreferenceScopeSchema,
} from "../claude/schemas.js";
import { buildConsolidatePrompt, CONSOLIDATE_PROMPT_VERSION } from "../commands/preferences.js";
import { AnaphoraRecordSchema } from "../core/artifacts.js";
import { validateConsolidation } from "../core/consolidated-preferences.js";
import { exportMessages, validatePreferenceCandidates } from "../core/preference-evidence.js";
import type { AggregatedPreference } from "../core/preferences.js";
import type { RunnerFn } from "../distill/pipeline.js";

const OriginSchema = z.enum(["claude", "codex", "kiro", "opencode"]);
const RuleSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("matches"), pattern: z.string() }),
  z.object({ id: z.string(), kind: z.literal("avoids"), pattern: z.string() }),
  z.object({
    id: z.string(),
    kind: z.literal("words"),
    min: z.number().int().nonnegative(),
    max: z.number().int().positive(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("preference-count"),
    min: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("preference"),
    pattern: z.string(),
    scope: PreferenceScopeSchema,
  }),
  z.object({
    id: z.string(),
    kind: z.literal("outcome"),
    value: DigestSchema.shape.outcome,
  }),
  z.object({ id: z.string(), kind: z.literal("separate-sources") }),
]);

const common = {
  id: z.string(),
  title: z.string(),
  rules: z.array(RuleSchema),
  reference: z.unknown(),
  regressions: z.array(
    z.object({ label: z.string(), response: z.unknown(), fails: z.array(z.string()).min(1) }),
  ),
};
const EvaluationCaseSchema = z.discriminatedUnion("stage", [
  z.object({
    ...common,
    stage: z.literal("digest"),
    input: z.object({
      exportName: z.string(),
      content: z.string(),
      origin: OriginSchema.optional(),
      outcome: z
        .object({
          final_human_turns: z.array(z.string()),
          final_assistant_tail: z.string(),
          final_execution_status: z.string().optional(),
        })
        .optional(),
    }),
  }),
  z.object({
    ...common,
    stage: z.literal("author"),
    input: z.object({
      task: ClusterSchema.shape.tasks.element,
      members: z.array(
        z.object({
          exportName: z.string(),
          content: z.string(),
          digest: DigestSchema.optional(),
          anaphora: z.array(AnaphoraRecordSchema).optional(),
          origin: OriginSchema.optional(),
        }),
      ),
    }),
  }),
  z.object({
    ...common,
    stage: z.literal("consolidate"),
    input: z.array(
      z.object({
        id: z.string(),
        text: z.string(),
        scope: PreferenceScopeSchema,
        project: z.string().optional(),
      }),
    ),
  }),
]);

export type EvaluationCase = z.infer<typeof EvaluationCaseSchema>;
export const evaluationCases = z.array(EvaluationCaseSchema).parse(fixtures);
export const EVALUATION_VERSIONS = {
  rubric: 1,
  digest: DIGEST_PROMPT_VERSION,
  cluster: CLUSTER_PROMPT_VERSION,
  author: AUTHOR_PROMPT_VERSION,
  consolidate: CONSOLIDATE_PROMPT_VERSION,
};

export function evaluationHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function consolidationInputs(fixture: Extract<EvaluationCase, { stage: "consolidate" }>) {
  return fixture.input.map(
    (input): AggregatedPreference => ({
      ...input,
      count: 1,
      occurrences: [],
      lastAuthoredAt: "",
    }),
  );
}

/** Build exactly the production prompt and schema for each synthetic case. */
export function evaluationRequest(fixture: EvaluationCase): {
  prompt: string;
  schema: z.ZodType;
  version: number;
} {
  switch (fixture.stage) {
    case "digest":
      return {
        prompt: buildDigestPrompt(fixture.input),
        schema: DigestResponseSchema,
        version: DIGEST_PROMPT_VERSION,
      };
    case "author":
      return {
        prompt: buildAuthorPrompt(fixture.input),
        schema: AuthorSchema,
        version: AUTHOR_PROMPT_VERSION,
      };
    case "consolidate":
      return {
        prompt: buildConsolidatePrompt(consolidationInputs(fixture)),
        schema: ConsolidateSchema,
        version: CONSOLIDATE_PROMPT_VERSION,
      };
  }
}

export interface EvaluationCheck {
  id: string;
  passed: boolean;
  detail: string;
}

/**
 * These are transparent regression probes, not a semantic quality judge.
 * Regex checks are deliberately case-specific and may need human adjudication.
 */
export function scoreEvaluation(fixture: EvaluationCase, response: unknown): EvaluationCheck[] {
  const request = evaluationRequest(fixture);
  const parsed = request.schema.safeParse(response);
  const checks: EvaluationCheck[] = [
    {
      id: "schema",
      passed: parsed.success,
      detail: parsed.success ? "Matches the production response schema." : parsed.error.message,
    },
  ];
  if (!parsed.success) {
    return checks.concat(
      fixture.rules.map((rule) => ({
        id: rule.id,
        passed: false,
        detail: "Cannot evaluate: response does not match its schema.",
      })),
    );
  }

  let text = "";
  let preferences: { text: string; scope?: string; source_ids?: string[] }[] = [];
  let outcome: string | undefined;
  switch (fixture.stage) {
    case "digest": {
      const digest = DigestResponseSchema.parse(parsed.data);
      preferences = digest.preferences;
      outcome = digest.outcome;
      text = [digest.goal, digest.deliverable, ...preferences.map((p) => p.text)].join("\n");
      const problems = validatePreferenceCandidates(
        digest.preferences,
        exportMessages(fixture.input.exportName, fixture.input.content),
      );
      checks.push({
        id: "evidence",
        passed: !problems.length,
        detail: problems.join("; ") || "Every citation refers to verbatim supplied human text.",
      });
      break;
    }
    case "author": {
      const authored = AuthorSchema.parse(parsed.data);
      text = authored.oneshot_markdown;
      preferences = authored.preferences;
      checks.push(
        {
          id: "task-identity",
          passed: authored.slug === fixture.input.task.slug,
          detail: "The response must preserve the requested task identity.",
        },
        {
          id: "separate-preference-extraction",
          passed: authored.preferences.length === 0,
          detail: "Authoring must not invent new standing preferences.",
        },
      );
      break;
    }
    case "consolidate": {
      const consolidated = ConsolidateSchema.parse(parsed.data);
      preferences = consolidated.preferences;
      text = preferences.map((p) => p.text).join("\n");
      const problems = validateConsolidation(consolidationInputs(fixture), consolidated);
      checks.push({
        id: "source-coverage",
        passed: !problems.length,
        detail: problems.join("; ") || "Source IDs are complete, unique, and scope-compatible.",
      });
      break;
    }
  }

  for (const rule of fixture.rules) {
    let passed: boolean;
    let detail: string;
    switch (rule.kind) {
      case "matches":
      case "avoids": {
        const found = new RegExp(rule.pattern, "is").test(text);
        passed = rule.kind === "matches" ? found : !found;
        detail = `${rule.kind === "matches" ? "Must match" : "Must avoid"} /${rule.pattern}/is in generated text.`;
        break;
      }
      case "words": {
        const count = text.trim() ? text.trim().split(/\s+/).length : 0;
        passed = count >= rule.min && count <= rule.max;
        detail = `${count} words; expected ${rule.min}–${rule.max} for this fixture.`;
        break;
      }
      case "preference-count":
        passed = preferences.length >= rule.min && preferences.length <= rule.max;
        detail = `${preferences.length} preferences; expected ${rule.min}–${rule.max}.`;
        break;
      case "preference":
        passed = preferences.some(
          (preference) =>
            preference.scope === rule.scope && new RegExp(rule.pattern, "is").test(preference.text),
        );
        detail = `Requires a ${rule.scope} preference matching /${rule.pattern}/is.`;
        break;
      case "outcome":
        passed = outcome === rule.value;
        detail = `Outcome ${outcome ?? "(absent)"}; expected ${rule.value}.`;
        break;
      case "separate-sources":
        passed =
          preferences.length > 0 &&
          preferences.every((preference) => preference.source_ids?.length === 1);
        detail = "This fixture's distinct conditions/scopes must retain separate source groups.";
        break;
    }
    checks.push({ id: rule.id, passed, detail });
  }
  return checks;
}

export interface EvaluationResult {
  id: string;
  stage: EvaluationCase["stage"];
  fixture_hash: string;
  input_hash: string;
  prompt_hash: string;
  prompt_version: number;
  prompt: string;
  elapsed_ms: number;
  response?: unknown;
  error?: string;
  checks: EvaluationCheck[];
}

/** One stage call; backend corrective retries remain part of the runner contract. */
export async function runEvaluationCase(
  fixture: EvaluationCase,
  runner: RunnerFn,
  options: { model?: string; timeoutMs?: number } = {},
): Promise<EvaluationResult> {
  const request = evaluationRequest(fixture);
  const start = Date.now();
  const result: EvaluationResult = {
    id: fixture.id,
    stage: fixture.stage,
    fixture_hash: evaluationHash(fixture),
    input_hash: evaluationHash(fixture.input),
    prompt_hash: evaluationHash(request.prompt),
    prompt_version: request.version,
    prompt: request.prompt,
    elapsed_ms: 0,
    checks: [],
  };
  try {
    result.response = await runner({
      prompt: request.prompt,
      schema: request.schema,
      model: options.model,
      timeoutMs: options.timeoutMs,
    });
    result.checks = scoreEvaluation(fixture, result.response);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.checks = [{ id: "runner", passed: false, detail: result.error }];
  }
  result.elapsed_ms = Date.now() - start;
  return result;
}
