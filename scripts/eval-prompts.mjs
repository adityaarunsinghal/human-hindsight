import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "tsdown";

// Development-only command. The published CLI does not bundle this evaluator.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-prompt-eval-"));
try {
  await build({
    config: false,
    cwd: root,
    entry: ["src/eval/cli.ts"],
    outDir: scratch,
    platform: "node",
    format: "esm",
    fixedExtension: true,
    dts: false,
    deps: { alwaysBundle: [/.*/] },
    alias: {
      "jsonc-parser": path.join(root, "node_modules/jsonc-parser/lib/esm/main.js"),
    },
    outputOptions: { codeSplitting: false },
  });
  const { runEvaluationCli } = await import(pathToFileURL(path.join(scratch, "cli.mjs")).href);
  process.exitCode = await runEvaluationCli(process.argv.slice(2));
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
