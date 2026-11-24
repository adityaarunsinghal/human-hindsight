/** When a saved result can stand in for a request (`reusableLineage`). */
import { describe, expect, it } from "vitest";
import { reusableLineage, sameLineage, stageLineage } from "../src/core/fingerprint.js";
import type { RunnerName } from "../src/runners/types.js";

const base = { stage: "digest" as const, promptVersion: 7, schema: { type: "object" } };
const lineage = (model: string | undefined, runnerName: RunnerName | null, inputs: unknown = "x") =>
  stageLineage({ ...base, model, runnerName, inputs });
/** The request as a run kept on `runner` would have recorded it. */
const asRunner =
  (model: string | undefined, inputs: unknown = "x") =>
  (runner: RunnerName) =>
    lineage(model, runner, inputs);

describe("reusableLineage", () => {
  it("a run free to use any CLI accepts what one CLI saved for the same plan and inputs", () => {
    const saved = lineage("balanced/bulk", "codex");
    const current = lineage("balanced/bulk", null);
    expect(sameLineage(saved, current)).toBe(false);
    expect(reusableLineage(saved, current, asRunner("balanced/bulk"))).toBe(true);
    // Its own saved result is accepted as always.
    expect(reusableLineage(current, current, asRunner("balanced/bulk"))).toBe(true);
  });

  it.each([
    [
      "another plan",
      lineage("best/bulk", "codex"),
      lineage("balanced/bulk", null),
      "balanced/bulk",
    ],
    [
      "other inputs",
      lineage("balanced/bulk", "codex", "y"),
      lineage("balanced/bulk", null),
      "balanced/bulk",
    ],
    // A model the person named is a request for that model on that CLI.
    ["a named model", lineage("gpt-5.6-sol", "codex"), lineage("gpt-5.6-sol", null), "gpt-5.6-sol"],
    ["no model at all", lineage(undefined, "codex"), lineage(undefined, null), undefined],
  ] as const)("refuses %s", (_name, saved, current, model) => {
    expect(reusableLineage(saved, current, asRunner(model))).toBe(false);
  });

  it("a run kept on one CLI accepts only its own results", () => {
    const kept = lineage("balanced/bulk", "claude");
    expect(
      reusableLineage(lineage("balanced/bulk", "codex"), kept, asRunner("balanced/bulk")),
    ).toBe(false);
    expect(reusableLineage(lineage("balanced/bulk", null), kept, asRunner("balanced/bulk"))).toBe(
      false,
    );
  });

  it("refuses records that are not a current lineage", () => {
    const current = lineage("balanced/bulk", null);
    for (const saved of [undefined, null, {}, { runner: "codex" }, { ...current, version: 0 }])
      expect(reusableLineage(saved, current, asRunner("balanced/bulk"))).toBe(false);
  });
});
