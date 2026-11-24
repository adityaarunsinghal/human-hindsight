/**
 * gui/landing.ts: which tab a first visit opens on, and where a tab reopens.
 * Browser-safe, no DOM.
 *
 * An address with a route always wins (`#preferences`, a bookmark). Without
 * one, a saved subagent suggestion opens the Subagents overview, also when it
 * is out of date (the overview says so); otherwise the Prompts overview opens.
 * A suggestion that could not be read does not count.
 */

export type Tab = "prompts" | "preferences" | "subagents";
export const TABS: readonly Tab[] = ["prompts", "preferences", "subagents"];

export function landingTab(route: string, suggestion: { saved: boolean }): Tab | null {
  if (route) return null;
  return suggestion.saved ? "subagents" : "prompts";
}

/** Where a person was in a tab: the open item and how far they had scrolled. */
export interface TabPlace {
  selected: string;
  viewerScroll: number;
  listScroll: number;
}

export const OVERVIEW_PLACE: TabPlace = { selected: "", viewerScroll: 0, listScroll: 0 };

/**
 * Choosing another tab returns to the place you left it. Choosing the tab you
 * are already on goes back to its overview.
 */
export function placeOnSwitch(current: Tab, next: Tab, saved: TabPlace): TabPlace {
  return current === next ? OVERVIEW_PLACE : saved;
}

/**
 * A width for a closed select that fits its longest label in a monospace
 * font: the label, the 9 px left padding, the 36 px arrow gutter, and borders.
 * Never narrower than nine characters, so a short list keeps the same control.
 */
export function selectWidth(labels: readonly string[]): string {
  const longest = Math.max(9, ...labels.map((label) => [...label].length));
  return `calc(${longest}ch + 47px)`;
}
