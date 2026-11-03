These synthetic cases check failure modes in the digest, author, and consolidation
flows. `cases.json` includes human-authored reference outputs, deliberately wrong
outputs, and the transparent rules used to distinguish them. Reference outputs
are examples, not required wording.

Run the deterministic suite:

```bash
npx vitest run test/prompt-behavior.test.ts
```

List the cases without model calls:

```bash
node scripts/eval-prompts.mjs
```

Run an optional live evaluation through an installed coding CLI:

```bash
node scripts/eval-prompts.mjs --live --runner claude --out /tmp/hindsight-eval.json
node scripts/eval-prompts.mjs --live --runner codex --model <model> --case reject-deployment --out /tmp/hindsight-rejection.json
```

Live mode asks before spending; `--yes` is an explicit opt-in for automation and
is accepted only with `--live`. Only the synthetic inputs in this directory are
used. Results are checkpointed after every case and a prior output file is never
overwritten. Runner retries may add attempts. Normal tests use injected runners
and never invoke an installed agent CLI.

Re-score a saved run locally:

```bash
node scripts/eval-prompts.mjs --score /tmp/hindsight-eval.json
```

Every recorded case contains its ID, fixture/input hashes, exact prompt and hash,
prompt version, response, elapsed time, and check results. Run metadata records
the app version, runner, and requested model. A null requested model means the
CLI chose its configured model; the evaluator does not claim to know its exact
resolved version. Use explicit model names for controlled comparisons.

To compare a prompt change, run the same cases with the same explicit model before
and after the change, save separate files, and compare both the checks and raw
outputs. Re-scoring refuses changed fixture hashes so it cannot silently compare
different tasks.

Passing these rules is not an overall quality score. Regular expressions can
miss valid paraphrases or incomplete reasoning. Review the outputs for preserved
intent, negation and conditions, t=0 leakage, original voice, appropriate length,
unsupported standing rules, and missing secondary goals. The suite makes those
failure modes visible and preserves evidence; it does not supply an LLM judge or
claim that schema-valid prose is necessarily good.
