import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const destination = path.resolve(process.argv[2] ?? ".release/packages");
fs.mkdirSync(destination, { recursive: true });
for (const name of ["human-hindsight", "cc-hindsight"]) {
  const output = execFileSync(
    "npm",
    [
      "pack",
      path.resolve(".release", name),
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      destination,
    ],
    { encoding: "utf8" },
  );
  const report = path.join(destination, `${name}.json`);
  fs.writeFileSync(report, output);
  execFileSync(
    process.execPath,
    ["scripts/check-pack.mjs", report, ...(name === "cc-hindsight" ? ["--compat"] : [])],
    { stdio: "inherit" },
  );
}
