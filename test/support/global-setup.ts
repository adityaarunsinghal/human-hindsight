import { checkGuiBundle } from "./bundle-guard.js";

/**
 * test/support/global-setup.ts: runs once before any test file.
 *
 * Stops the run when the generated GUI bundle is missing or older than its
 * sources (see `bundle-guard.ts`), so no GUI test passes against old code.
 */
export default function setup(): void {
  checkGuiBundle(process.cwd());
}
