import { describe, expect, it } from "vitest";
import { OVERVIEW_PLACE, placeOnSwitch, selectWidth, type TabPlace } from "../src/gui/landing.js";
import { commandNamed, earlierPromptNotice, promptCountLines } from "../src/gui/tips.js";

/** Tab places, the sort control's width, and the Prompts count lines. */

describe("switching tabs", () => {
  const left: TabPlace = {
    selected: "agreement/keep-changes-small",
    viewerScroll: 2000,
    listScroll: 340,
  };
  it.each([
    ["another tab returns to where you left it", "prompts", "preferences", left],
    ["the tab you are on goes back to its overview", "preferences", "preferences", OVERVIEW_PLACE],
  ] as const)("%s", (_label, current, next, expected) => {
    expect(placeOnSwitch(current, next, left)).toEqual(expected);
  });
});

describe("the sort control", () => {
  it.each([
    [["Most sessions", "Newest", "A to Z"], "calc(13ch + 47px)"],
    [["Most sessions", "A to Z"], "calc(13ch + 47px)"],
    // A short list keeps the same nine-character control.
    [["Newest", "A to Z"], "calc(9ch + 47px)"],
    [[], "calc(9ch + 47px)"],
  ])("fits %j", (labels, width) => {
    expect(selectWidth(labels)).toBe(width);
  });
});

describe("prompts left behind by a regrouping", () => {
  it.each([
    [
      { current: 19, earlier: 31, shownCurrent: 19, shownEarlier: 31, filtering: false },
      ["19 prompts", "31 earlier prompts kept from before the last regrouping"],
    ],
    [
      { current: 1, earlier: 1, shownCurrent: 1, shownEarlier: 1, filtering: false },
      ["1 prompt", "1 earlier prompt kept from before the last regrouping"],
    ],
    [
      { current: 19, earlier: 0, shownCurrent: 19, shownEarlier: 0, filtering: false },
      ["19 prompts", ""],
    ],
    [
      { current: 19, earlier: 31, shownCurrent: 3, shownEarlier: 2, filtering: true },
      ["3 of 19 prompts", "2 of 31 earlier prompts match"],
    ],
    [
      { current: 19, earlier: 31, shownCurrent: 0, shownEarlier: 0, filtering: true },
      ["0 of 19 prompts", "0 of 31 earlier prompts match"],
    ],
  ])("%o", (counts, lines) => {
    expect(promptCountLines(counts)).toEqual(lines);
  });

  it("names the prune command for this home, in the page's command form", () => {
    const status = "npx human-hindsight@latest status --home '/synthetic/it''s home'";
    expect(commandNamed(status, "prune")).toBe(
      "npx human-hindsight@latest prune --home '/synthetic/it''s home'",
    );
    expect(earlierPromptNotice()).toBe(
      "This prompt is from an earlier grouping of your sessions. It is kept because it may be edited or rated. Run this to remove the earlier prompts you have not edited:",
    );
  });
});
