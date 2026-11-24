import fs from "node:fs";
import path from "node:path";

/**
 * test/support/bundle-guard.ts: refuse to test against a stale GUI bundle.
 *
 * `src/gui/client.generated.ts` is produced by `npm run build` from
 * `src/gui/client.ts` and every local module it imports. It is not tracked,
 * so after a pull or an edit it can silently lag behind its sources, and GUI
 * tests would then exercise old client code. The vitest global setup
 * (`test/support/global-setup.ts`) calls {@link checkGuiBundle} once before
 * any test file runs and stops the run with one line when the bundle is
 * missing or older than any of its sources.
 *
 * The decision is the pure {@link bundleVerdict}; the file system is read
 * only by {@link guiBundleInputs}. Package imports (for example `marked`)
 * are not followed: they change only through `npm ci`, which is followed by
 * a build.
 */

export const GENERATED = "src/gui/client.generated.ts";
export const ENTRY = "src/gui/client.ts";
const REBUILD_HINT = "run `npm run build`";

export interface BundleInputs {
  /** Modification time of the generated file, or null when it is missing. */
  generatedMtimeMs: number | null;
  /** Every source the bundle is built from, with its modification time. */
  sources: { file: string; mtimeMs: number }[];
}

export type BundleVerdict = { ok: true } | { ok: false; message: string };

/** Pure: is the generated bundle present and at least as new as every source? */
export function bundleVerdict(inputs: BundleInputs): BundleVerdict {
  if (inputs.generatedMtimeMs === null) {
    return { ok: false, message: `${GENERATED} is missing: ${REBUILD_HINT}.` };
  }
  const generated = inputs.generatedMtimeMs;
  const newer = inputs.sources
    .filter((source) => source.mtimeMs > generated)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
  const newest = newer[0];
  if (!newest) return { ok: true };
  const more = newer.length > 1 ? ` and ${newer.length - 1} more` : "";
  return {
    ok: false,
    message: `${GENERATED} is older than ${newest.file}${more}: ${REBUILD_HINT}.`,
  };
}

/** `import x from "./a.js"`, `export { y } from "./b.js"`, with an optional `type`. */
const STATIC = /\b(?:import|export)\s+(type\s+)?[^;"']*?\bfrom\s*["'](\.{1,2}\/[^"']+)["']/g;
/** `import "./c.js"` and `import("./d.js")`. */
const BARE = /\bimport\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

/**
 * Pure: the relative module specifiers in one source text whose code reaches
 * the bundle. `import type` and `export type` are erased by the bundler, so
 * they are skipped.
 */
export function relativeImports(text: string): string[] {
  const found = [
    ...[...text.matchAll(STATIC)].filter((match) => !match[1]).map((match) => match[2]),
    ...[...text.matchAll(BARE)].map((match) => match[1]),
  ];
  return [...new Set(found.filter((value): value is string => Boolean(value)))];
}

function resolveModule(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base,
    `${base}.ts`,
    path.join(base, "index.ts"),
  ];
  return candidates.find((file) => fs.existsSync(file) && fs.statSync(file).isFile()) ?? null;
}

/** The entry module and every local module reachable from it, relative to `root`. */
export function bundleSources(root: string, entry = ENTRY): string[] {
  const seen = new Set<string>();
  const queue = [path.resolve(root, entry)];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    for (const specifier of relativeImports(fs.readFileSync(file, "utf8"))) {
      const resolved = resolveModule(file, specifier);
      if (resolved && path.resolve(resolved) !== path.resolve(root, GENERATED))
        queue.push(resolved);
    }
  }
  return [...seen].map((file) => path.relative(root, file)).sort();
}

/** Read the inputs for {@link bundleVerdict} from a checkout. */
function guiBundleInputs(root: string): BundleInputs {
  let generatedMtimeMs: number | null = null;
  try {
    generatedMtimeMs = fs.statSync(path.join(root, GENERATED)).mtimeMs;
  } catch {
    generatedMtimeMs = null;
  }
  return {
    generatedMtimeMs,
    sources: bundleSources(root).map((file) => ({
      file,
      mtimeMs: fs.statSync(path.join(root, file)).mtimeMs,
    })),
  };
}

/** Throws one line when the bundle cannot be trusted. */
export function checkGuiBundle(root: string): void {
  const verdict = bundleVerdict(guiBundleInputs(root));
  if (!verdict.ok) throw new Error(verdict.message);
}
