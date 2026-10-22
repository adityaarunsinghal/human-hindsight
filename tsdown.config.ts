import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

export default defineConfig({
  // src/cli.ts starts with `#!/usr/bin/env node`; tsdown preserves the shebang
  // in dist/cli.js and marks the output executable.
  entry: ["src/cli.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  dts: true,
  clean: true,
  // package.json has "type": "module", so ESM output can use plain .js —
  // keeping the bin path ./dist/cli.js accurate.
  fixedExtension: false,
  deps: { alwaysBundle: [/.*/] },
  // jsonc-parser's UMD entry has dynamic requires; bundle its ESM entry instead.
  alias: {
    "jsonc-parser": fileURLToPath(
      new URL("./node_modules/jsonc-parser/lib/esm/main.js", import.meta.url),
    ),
  },
  outputOptions: { inlineDynamicImports: true },
});
