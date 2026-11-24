import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The release workflow publishes only what was checked on the tagged commit
 * itself: CI runs in full on that commit, and the publishing job repeats the
 * runtime promise (`engines` and the launcher: Node 22.13 starts, Node 18 is
 * refused) on the very packages it is about to publish.
 */

const root = path.join(import.meta.dirname, "..");
const workflow = (name: string) =>
  fs.readFileSync(path.join(root, ".github", "workflows", name), "utf8");

/** The text of one top-level job, from its key to the next job key. */
function job(text: string, name: string): string {
  const jobs = text.slice(text.indexOf("\njobs:\n"));
  const start = jobs.search(new RegExp(`\\n  ${name}:\\n`));
  expect(start, `job ${name}`).toBeGreaterThan(0);
  const rest = jobs.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[\w-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("release workflow: nothing is published that was not checked", () => {
  const release = workflow("release.yml");
  const publish = job(release, "publish");
  const runsBeforePublish = (needle: RegExp | string) => {
    const at = typeof needle === "string" ? publish.indexOf(needle) : publish.search(needle);
    const publishAt = publish.indexOf("publish-package.mjs");
    expect(publishAt, "publish step").toBeGreaterThan(0);
    expect(at, String(needle)).toBeGreaterThan(0);
    expect(at, `${needle} runs before publishing`).toBeLessThan(publishAt);
  };

  it("runs all of CI on the tagged commit and publishes only after it passes", () => {
    expect(workflow("ci.yml")).toMatch(/\non:\n(?: {2}.*\n)*? {2}workflow_call:/);
    expect(job(release, "ci")).toContain("uses: ./.github/workflows/ci.yml");
    expect(publish).toMatch(/\n {4}needs: \[?ci\]?\n/);
  });

  it("runs both test tiers and every packaging check in the publishing job", () => {
    for (const step of [
      "npx biome ci .",
      "npx tsc --noEmit",
      "npm test",
      "npm run test:smoke",
      "npm run build",
      "npm run stage:release",
      "node scripts/pack-release.mjs",
      "node scripts/smoke-install.mjs",
    ])
      runsBeforePublish(step);
  });

  it("refuses Node 18 and starts both installed commands on Node 22.13.0 before publishing", () => {
    runsBeforePublish(/smoke-node-versions\.mjs[^\n]*refuse:/);
    runsBeforePublish(
      /node-version: "22\.13\.0"\n(?:.*\n)*?.*smoke-node-versions\.mjs[^\n]*start:/,
    );
    runsBeforePublish("smoke-runtime.mjs");
    // Publishing itself goes back to the build Node, whose npm supports trusted publishing.
    const publishAt = publish.indexOf("publish-package.mjs");
    const setups = [...publish.slice(0, publishAt).matchAll(/node-version(?:-file)?: (\S+)/g)];
    expect(setups.at(-1)?.[0]).toBe("node-version-file: .node-version");
  });

  it("pins every third-party action by commit in every workflow", () => {
    for (const name of fs.readdirSync(path.join(root, ".github", "workflows"))) {
      for (const [, action] of workflow(name).matchAll(/uses: (\S+)/g)) {
        if (action?.startsWith("./")) continue;
        expect(action, `${name}: ${action}`).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      }
    }
  });
});
