#!/usr/bin/env node
// Run both installed commands on chosen Node binaries, the way a person does:
// the command file is executed directly, so its `#!/usr/bin/env node` line finds
// the chosen Node first on PATH.
//
//   node scripts/smoke-node-versions.mjs <installed-prefix> refuse:<node> start:<node> ...
//
// refuse: exit code 1, nothing on stdout, and a short message whose first line
//         names the requirement and the version found. No stack trace.
// start:  `--version` prints the installed version and exits 0.
//
// Built-ins only and plain syntax, so this runs on Node 18 as well (CI runs it
// right after switching to Node 18).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [prefix, ...cases] = process.argv.slice(2);
if (!prefix || cases.length === 0) {
  console.error("usage: smoke-node-versions.mjs <installed-prefix> refuse:<node>|start:<node> ...");
  process.exit(1);
}
const installed = JSON.parse(
  fs.readFileSync(path.resolve(prefix, "node_modules/human-hindsight/package.json"), "utf8"),
);
for (const spec of cases) {
  const split = spec.indexOf(":");
  const expect = spec.slice(0, split);
  const node = spec.slice(split + 1);
  assert(expect === "refuse" || expect === "start", `Unknown expectation in ${spec}`);
  const version = spawnSync(node, ["-p", "process.versions.node"], { encoding: "utf8" });
  assert.equal(version.status, 0, `Cannot run ${node}`);
  const found = version.stdout.trim();
  const env = { ...process.env, PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH}` };
  for (const name of ["human-hindsight", "cc-hindsight"]) {
    const command = path.resolve(prefix, "node_modules/.bin", name);
    const result = spawnSync(command, ["--version"], { env, encoding: "utf8", timeout: 30000 });
    const label = `${name} on Node ${found}`;
    if (expect === "refuse") {
      assert.equal(result.status, 1, `${label}: exit ${result.status}\n${result.stderr}`);
      assert.equal(result.stdout, "", `${label}: wrote to stdout`);
      const lines = result.stderr.trimEnd().split("\n");
      assert.match(
        lines[0],
        new RegExp(
          `^Human Hindsight needs Node\\.js .+; you have ${found.replace(/\./g, "\\.")}\\.$`,
        ),
        label,
      );
      assert(!/SyntaxError|^\s+at /m.test(result.stderr), `${label}: printed a stack trace`);
      assert(lines.length <= 12, `${label}: message is ${lines.length} lines`);
      console.log(`${label}: refused with exit 1: ${lines[0]}`);
    } else {
      assert.equal(result.status, 0, `${label}: exit ${result.status}\n${result.stderr}`);
      assert.equal(result.stdout.trim(), installed.version, label);
      console.log(`${label}: started, --version printed ${installed.version}`);
    }
  }
}
