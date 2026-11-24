import { describe, expect, it } from "vitest";
import { fromEarlierGrouping } from "../src/core/library.js";

/**
 * Which library entries were left behind when sessions were regrouped: the
 * entry's task is not in the current grouping, or it was written for another
 * grouping run. Without a grouping file, nothing is left behind.
 */

const grouping = {
  generation: "gen-2",
  tasks: [{ slug: "fix-build-step" }, { slug: "write-notes" }],
};
const entry = (slug: string, generation: string) => ({ slug, sources: { generation } });

describe("an entry from an earlier grouping", () => {
  it.each([
    ["a current task from this grouping", entry("fix-build-step", "gen-2"), grouping, false],
    ["a task the regrouping dropped", entry("fix-the-build", "gen-2"), grouping, true],
    [
      "a task with the same name from an older grouping",
      entry("write-notes", "gen-1"),
      grouping,
      true,
    ],
    ["no grouping file at all", entry("fix-the-build", "gen-1"), null, false],
  ] as const)("%s", (_label, value, current, expected) => {
    expect(fromEarlierGrouping(value, current)).toBe(expected);
  });

  it("keeps a prompt the person edited current while its task still exists", () => {
    // Later runs keep the edit on purpose, so it is the current prompt for that task.
    expect(fromEarlierGrouping(entry("write-notes", "gen-1"), grouping, { edited: true })).toBe(
      false,
    );
    // Once the task itself is gone, an edited prompt is left behind like any other.
    expect(fromEarlierGrouping(entry("fix-the-build", "gen-1"), grouping, { edited: true })).toBe(
      true,
    );
  });
});
