// Keep the unit tier fast. Runs it once and fails when the whole run or any
// single test takes longer than its budget.
//
//   node scripts/check-test-budget.mjs
//
// Budgets (milliseconds), with their environment overrides:
//   HUMAN_HINDSIGHT_UNIT_BUDGET_MS   whole unit tier, wall clock   (default 10000)
//   HUMAN_HINDSIGHT_SLOW_TEST_MS     one test                      (default 500)
//   HUMAN_HINDSIGHT_BUDGET_WORKERS   test files run at once         (default 6, or fewer cores)
// The defaults are for a developer machine that is otherwise idle. CI sets
// looser values, because shared runners are slower and vary run to run; there
// the check exists to catch a test that waits on real time or a real disk.
//
// The measurement runs at most six test files at once. More workers than fast
// cores do not finish the tier sooner, and they stretch every single test's
// time several times over (measured on a machine with 6 fast and 12 slow
// cores: the same test took 105 ms alone, 216 ms at 6 workers, 1,139 ms at
// 18), which would make the single-test budget measure the machine.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const unitBudget = Number(process.env.HUMAN_HINDSIGHT_UNIT_BUDGET_MS ?? 10000);
const slowTest = Number(process.env.HUMAN_HINDSIGHT_SLOW_TEST_MS ?? 500);
const workers = Number(
  process.env.HUMAN_HINDSIGHT_BUDGET_WORKERS ?? Math.min(6, os.availableParallelism()),
);

// Tests allowed to exceed the single-test budget, each with its reason. They
// still count toward the whole-run budget.
const EXCEPTIONS = [
  {
    match: /^crash at every write /,
    limit: 10,
    reason: "replays the whole stage once per file write to prove recovery from any crash point",
  },
];

const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-budget-")), "unit.json");
const started = Date.now();
const run = spawnSync(
  "npx",
  [
    "vitest",
    "run",
    "--project",
    "unit",
    `--maxWorkers=${workers}`,
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  { stdio: ["ignore", "ignore", "inherit"] },
);
const wall = Date.now() - started;
if (run.status !== 0) {
  console.error("The unit tier failed; fix the tests before measuring them (npm test).");
  process.exit(run.status ?? 1);
}

const tests = JSON.parse(fs.readFileSync(report, "utf8")).testResults.flatMap((file) =>
  file.assertionResults.map((test) => ({
    file: path.relative(process.cwd(), file.name),
    name: test.fullName,
    ms: test.duration ?? 0,
  })),
);
tests.sort((a, b) => b.ms - a.ms);

const problems = [];
for (const test of tests) {
  if (test.ms <= slowTest) break;
  const exception = EXCEPTIONS.find((item) => item.match.test(test.name));
  if (exception && test.ms <= slowTest * exception.limit) continue;
  problems.push(`${Math.round(test.ms)} ms  ${test.file}  ${test.name}`);
}
if (wall > unitBudget) {
  problems.unshift(`The unit tier took ${wall} ms; its budget is ${unitBudget} ms.`);
}

console.log(
  `unit tier: ${tests.length} tests in ${wall} ms (budget ${unitBudget} ms), ${workers} files at a time.`,
);
console.log(
  `slowest: ${tests
    .slice(0, 3)
    .map((test) => `${Math.round(test.ms)} ms`)
    .join(", ")} (single-test budget ${slowTest} ms).`,
);
if (problems.length) {
  console.error(`\nOver budget (${problems.length}):`);
  for (const line of problems.slice(0, 25)) console.error(`  ${line}`);
  console.error(
    "\nA unit test should not wait on real time, a real disk flush, or a child process. " +
      "Inject the clock and the writer, or move the case to a *.smoke.test.ts file.",
  );
  process.exit(1);
}
