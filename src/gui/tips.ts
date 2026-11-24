import { PRIVACY_REMINDER, PUBLIC_REPOSITORY_URL } from "../core/privacy.js";
import type { GuiSnapshot } from "./server.js";
import { commandRow } from "./subagents-panel.js";

/** Said while the reflection that opened the page is still running. */
export const STILL_ARRIVING = {
  prompts: "Your prompts appear here as each one is written. This page updates on its own.",
  preferences:
    "These are the preferences found in the sessions read so far. Summaries arrive here as each batch finishes.",
};

export const guidance = {
  prompts: "Copy a prompt, paste it into a new session, and adjust it to the task at hand.",
  preferences:
    "Read what your sessions say about how you work. Copy a preference with its scope, or open its sources to see where it came from.",
  subagents:
    "Choose your coding tool, download its files as one zip, and add them to that tool's settings.",
};

interface Tip {
  title: string;
  text: string;
  cost?: string;
  command?: string;
  repository?: boolean;
}

/** Help stays closed until requested. Changing tabs selects the relevant starting topic. */
export function initTips(getCommands: () => GuiSnapshot["commands"] | null) {
  const panel = document.getElementById("tips") as HTMLDetailsElement;
  const topic = document.getElementById("tip-topic") as HTMLSelectElement;
  const text = document.getElementById("tip-text") as HTMLElement;
  const cost = document.getElementById("tip-cost") as HTMLElement;
  const command = document.getElementById("tip-command") as HTMLElement;
  let lastTab: keyof typeof guidance | undefined;

  function choices(): Record<string, Tip> {
    const commands = getCommands();
    return {
      prompts: { title: "Reuse a prompt", text: guidance.prompts },
      preferences: {
        title: "Read your reflection",
        text: guidance.preferences,
        command: commands?.preferences,
      },
      subagents: { title: "Export suggested subagents", text: guidance.subagents },
      evidence: {
        title: "Read the original evidence",
        text: "Expand the sources under a reflection to read the saved quotations. Open a preference to change its wording or scope.",
      },
      search: {
        title: "Search and filter the library",
        text: "Press / to search. Escape clears the search. Select a domain to include its descendants.",
      },
      consolidate: {
        title: "Consolidate similar preferences",
        text: "Merge overlapping wording into one saved block. The terminal asks before using a model. Choose Refresh afterward.",
        cost: "Uses subscription or credits",
        command: commands?.consolidate,
      },
      export: {
        title: "Export the latest history",
        text: "Copy your latest sessions into the library folder before building new prompts.",
        cost: "No model call",
        command: commands?.export,
      },
      reflect: {
        title: "Reflect on your history",
        text: "Find preferences and reusable prompts in your copied sessions. The terminal shows which model it will use and asks before starting.",
        cost: "Uses subscription or credits",
        command: commands?.reflect,
      },
      status: {
        title: "Check progress",
        text: "See completed stages, skipped files, and the suggested next step.",
        cost: "No model call",
        command: commands?.status,
      },
      privacy: { title: "Your history and privacy", text: PRIVACY_REMINDER, repository: true },
    };
  }

  function renderTopic() {
    const tip = choices()[topic.value];
    if (!tip) return;
    topic.title = tip.title;
    text.textContent = tip.text;
    if (tip.repository) {
      const link = document.createElement("a");
      link.href = PUBLIC_REPOSITORY_URL;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Project repository";
      text.append(" ", link);
    }
    command.replaceChildren(...(tip.command ? [commandRow(tip.command)] : []));
    cost.textContent = tip.cost ?? "";
    cost.hidden = !tip.cost;
  }

  topic.replaceChildren(...Object.entries(choices()).map(([id, tip]) => new Option(tip.title, id)));
  topic.addEventListener("change", renderTopic);
  document.addEventListener("pointerdown", (event) => {
    if (panel.open && event.target instanceof Node && !panel.contains(event.target))
      panel.open = false;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel.open) {
      panel.open = false;
      document.getElementById("tip-toggle")?.focus();
    }
  });
  renderTopic();
  return {
    refresh(tab: keyof typeof guidance) {
      if (tab !== lastTab && !panel.open) topic.value = tab;
      lastTab = tab;
      renderTopic();
    },
  };
}

/**
 * Another command for this home, from one the page was given: the same
 * `npx human-hindsight@latest <name> --home '...'` form, only the name differs.
 */
export function commandNamed(statusCommand: string, name: string): string {
  return statusCommand.replace(
    /^(npx human-hindsight@latest) status(?= )/,
    (_all, prefix) => `${prefix} ${name}`,
  );
}

/** The one line an earlier prompt carries, followed by the prune command. */
export function earlierPromptNotice(): string {
  return "This prompt is from an earlier grouping of your sessions. It is kept because it may be edited or rated. Run this to remove the earlier prompts you have not edited:";
}

/** The Prompts count line and its quiet second line about earlier prompts. */
export function promptCountLines(counts: {
  current: number;
  earlier: number;
  shownCurrent: number;
  shownEarlier: number;
  filtering: boolean;
}): [string, string] {
  const prompts = (n: number) => `${n} ${n === 1 ? "prompt" : "prompts"}`;
  const first = counts.filtering
    ? `${counts.shownCurrent} of ${prompts(counts.current)}`
    : prompts(counts.current);
  if (!counts.earlier) return [first, ""];
  const earlier = `${counts.earlier} earlier ${counts.earlier === 1 ? "prompt" : "prompts"}`;
  return [
    first,
    counts.filtering
      ? `${counts.shownEarlier} of ${earlier} match`
      : `${earlier} kept from before the last regrouping`,
  ];
}
