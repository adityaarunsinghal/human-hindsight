import fs from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import { askYesNo } from "../claude/consent.js";
import { FILE_MODE } from "../core/fsutil.js";
import { parseRunnerMode, resolveRunner } from "../runners/registry.js";
import type { AgentRunner } from "../runners/types.js";
import {
  EVALUATION_VERSIONS,
  type EvaluationResult,
  evaluationCases,
  evaluationHash,
  runEvaluationCase,
  scoreEvaluation,
} from "./prompts.js";

const HELP = `Usage: node scripts/eval-prompts.mjs [options]

Default: list the synthetic cases. No model calls or files are created.

  --live                 Run cases through an installed agent CLI (asks first)
  --runner <name>        claude, codex, kiro, opencode, or auto (default auto)
  --model <name>         Model passed to that CLI; omitted means its configured default
  --case <id>            Run only this case; repeat for multiple cases
  --out <file>           New JSON result file (required with --live)
  --yes                 Explicit spending consent, only valid with --live
  --score <file>         Score a saved run locally, with no model calls
  --help                Show this help

Results contain exact prompts, outputs, fixture/input hashes, prompt versions,
requested model, and transparent regression checks. They do not measure overall
quality or replace human review of intent, tone, scope, and missing constraints.
`;

interface RecordedEvaluation {
  format_version: 1;
  created_at: string;
  tool_version: string;
  runner: string;
  requested_model: string | null;
  versions: typeof EVALUATION_VERSIONS;
  cases: EvaluationResult[];
}

const SavedRunSchema = z.object({
  format_version: z.literal(1),
  cases: z
    .array(
      z.object({
        id: z.string(),
        fixture_hash: z.string(),
        response: z.unknown().optional(),
        error: z.string().optional(),
      }),
    )
    .min(1, "The saved run contains no completed cases."),
});

export interface EvaluationCliDeps {
  input?: Readable;
  output?: Writable;
  resolve?: typeof resolveRunner;
}

function summarize(
  results: { id: string; checks: { id: string; passed: boolean; detail: string }[] }[],
  write: (line: string) => void,
): boolean {
  let passed = true;
  for (const result of results) {
    const failures = result.checks.filter((check) => !check.passed);
    if (failures.length) passed = false;
    write(
      `${failures.length ? "FAIL" : "PASS"} ${result.id}: ` +
        `${result.checks.length - failures.length}/${result.checks.length} regression checks`,
    );
    for (const failure of failures) write(`  ${failure.id}: ${failure.detail}`);
  }
  write(
    "These mechanical checks do not establish overall prompt quality. Review the saved outputs.",
  );
  return passed;
}

function save(file: string, record: RecordedEvaluation): void {
  const temporary = `${file}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      flag: "wx",
      mode: FILE_MODE,
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Development evaluator: zero model calls unless --live and spending consent both hold. */
export async function runEvaluationCli(
  argv: string[],
  deps: EvaluationCliDeps = {},
): Promise<number> {
  const output = deps.output ?? process.stdout;
  const write = (line: string) => output.write(`${line}\n`);
  let runner: AgentRunner | undefined;
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean" },
        live: { type: "boolean" },
        runner: { type: "string" },
        model: { type: "string" },
        case: { type: "string", multiple: true },
        out: { type: "string" },
        yes: { type: "boolean" },
        score: { type: "string" },
      },
    });
    if (values.help) {
      write(HELP);
      return 0;
    }
    if (values.yes && !values.live) throw new Error("--yes requires --live.");
    if (values.score && values.live) throw new Error("Choose --score or --live, not both.");
    if (values.score) {
      const recorded = SavedRunSchema.parse(JSON.parse(fs.readFileSync(values.score, "utf8")));
      const results = recorded.cases.map((result) => {
        const fixture = evaluationCases.find((candidate) => candidate.id === result.id);
        if (!fixture || evaluationHash(fixture) !== result.fixture_hash) {
          throw new Error(
            `Fixture ${result.id} has changed or is unavailable; use the matching checkout.`,
          );
        }
        return {
          id: result.id,
          checks: result.error
            ? [{ id: "runner", passed: false, detail: result.error }]
            : scoreEvaluation(fixture, result.response),
        };
      });
      return summarize(results, write) ? 0 : 1;
    }

    const selected = values.case
      ? evaluationCases.filter((fixture) => values.case?.includes(fixture.id))
      : evaluationCases;
    for (const id of values.case ?? []) {
      if (!selected.some((fixture) => fixture.id === id)) throw new Error(`Unknown case: ${id}`);
    }
    if (!values.live) {
      for (const fixture of selected) write(`${fixture.id} (${fixture.stage}): ${fixture.title}`);
      write("No model calls. Use --live --out <new-file> to run the synthetic cases with consent.");
      return 0;
    }
    if (!values.out) throw new Error("--live requires --out <new-file>.");
    const file = path.resolve(values.out);
    if (fs.existsSync(file)) throw new Error(`Result file already exists: ${file}`);

    runner = await (deps.resolve ?? resolveRunner)(parseRunnerMode(values.runner));
    await runner.preflight?.();
    write(
      `This will make ${selected.length} stage call(s) using ${runner.name} and ` +
        `${values.model ?? "its configured model"}, billed to your subscription/credits.`,
    );
    write(
      "Only synthetic fixtures are sent. Backend validation/transport retries may add attempts.",
    );
    const consent =
      values.yes || (await askYesNo("Run this evaluation?", { input: deps.input, output }));
    if (!consent) {
      write("Declined; no model call or result file was created.");
      return 2;
    }
    const record: RecordedEvaluation = {
      format_version: 1,
      created_at: new Date().toISOString(),
      tool_version: pkg.version,
      runner: runner.name,
      requested_model: values.model ?? null,
      versions: EVALUATION_VERSIONS,
      cases: [],
    };
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Reserve the output before spending; never overwrite a prior evaluation.
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, {
      flag: "wx",
      mode: FILE_MODE,
    });
    for (const fixture of selected) {
      write(`Running ${fixture.id}…`);
      const result = await runEvaluationCase(fixture, runner.run, { model: values.model });
      record.cases.push(result);
      save(file, record); // Preserve each paid result if a later case is interrupted.
    }
    write(`Saved ${file}`);
    return summarize(record.cases, write) ? 0 : 1;
  } catch (error) {
    write(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await runner?.finalize?.();
  }
}
