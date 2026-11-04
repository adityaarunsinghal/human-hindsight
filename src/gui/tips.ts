import { PRIVACY_REMINDER, PUBLIC_REPOSITORY_URL } from "../core/privacy.js";
import { setIconButton } from "./icons.js";
import type { GuiSnapshot } from "./server.js";

interface Tip {
  title: string;
  text: string;
  cost?: string;
  command?: string;
  repository?: boolean;
}

/** Compact tips stay quiet while the user is reading or interacting with them. */
export function initTips(getCommands: () => GuiSnapshot["commands"] | null): {
  refresh(): void;
} {
  const byId = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T;
  const tips = byId("tips");
  const face = byId("tip-face");
  const toggle = byId<HTMLButtonElement>("tip-toggle");
  const details = byId("tip-details");
  const title = byId("tip-title");
  const number = byId("tip-number");
  const text = byId("tip-text");
  const cost = byId("tip-cost");
  const commandRow = byId("tip-command-row");
  const commandText = byId("tip-command");
  const status = byId("tip-status");
  const previous = byId<HTMLButtonElement>("previous-tip");
  const next = byId<HTMLButtonElement>("next-tip");
  const pause = byId<HTMLButtonElement>("pause-tips");
  const hide = byId<HTMLButtonElement>("hide-tips");
  const show = byId<HTMLButtonElement>("show-tips");
  const copy = byId<HTMLButtonElement>("copy-tip");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  let index = 0;
  let revision = 0;
  let paused = false;
  let enabled = true;
  let expanded = false;
  let animation: Animation | undefined;
  let displayedTip: Tip | undefined;
  try {
    enabled = localStorage.getItem("human-hindsight-tips") !== "hidden";
  } catch {
    // Browser storage is optional; the controls still work without it.
  }

  function availableTips(): Tip[] {
    const commands = getCommands();
    return [
      {
        title: "Your history, your control",
        text: PRIVACY_REMINDER,
        cost: "Open source",
        repository: true,
      },
      {
        title: "Carry your preferences forward",
        text: "Review candidates in Preferences, then copy Accepted instructions into CLAUDE.md or AGENTS.md.",
        cost: "No model call",
        command: commands?.preferences,
      },
      {
        title: "Consolidate similar preferences",
        text: "Merge overlapping wording into a saved block. The terminal asks before making model calls. Refresh the library afterward.",
        cost: "Optional · uses subscription or credits",
        command: commands?.consolidate,
      },
      {
        title: "Export your latest history",
        text: "Refresh your local session exports before distilling new prompts.",
        cost: "No model call",
        command: commands?.export,
      },
      {
        title: "Build prompts from your history",
        text: "Distill your exports with your coding agent. Review the call plan and spending consent in the terminal.",
        cost: "Uses subscription or credits",
        command: commands?.distill,
      },
      {
        title: "Check pipeline progress",
        text: "See completed stages, skipped files, and the suggested next step.",
        cost: "No model call",
        command: commands?.status,
      },
      {
        title: "Check the evidence first",
        text: "Expand a preference’s evidence to review its original quotation and scope before accepting it. Legacy observations are labeled.",
      },
      {
        title: "Copy the original Markdown",
        text: "Preview or inspect the Markdown, then copy the original source, including its lists and code.",
      },
      {
        title: "Explore the domain tree",
        text: "Expand a branch to see its subdomains. Select any domain to include all its descendants in one hierarchy.",
      },
      {
        title: "Search from the keyboard",
        text: "Press / to search and Escape to clear. Each tab remembers its own search, domain, and sort.",
      },
    ];
  }

  function cancelAnimation() {
    animation?.cancel();
    animation = undefined;
  }

  function renderDisclosure() {
    details.hidden = !expanded;
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("aria-controls", "tip-details");
    toggle.setAttribute(
      "aria-label",
      `${expanded ? "Hide" : "Show"} details for tip ${index + 1}: ${displayedTip?.title ?? ""}`,
    );
    toggle.title = expanded ? "Hide tip details" : "Show tip details";
    toggle.dataset.open = String(expanded);
    cost.hidden = !expanded || !displayedTip?.cost;
  }

  function renderContent() {
    const choices = availableTips();
    index %= choices.length;
    const tip = choices[index];
    if (!tip) return;
    displayedTip = tip;
    number.textContent = `Tip ${index + 1}/${choices.length}`;
    title.textContent = tip.title;
    if (tip.repository) {
      const [before, after] = tip.text.split("fully open source");
      const link = document.createElement("a");
      link.textContent = "fully open source";
      link.href = PUBLIC_REPOSITORY_URL;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      text.replaceChildren(
        document.createTextNode(before ?? ""),
        link,
        document.createTextNode(after ?? ""),
      );
    } else {
      text.textContent = tip.text;
    }
    cost.textContent = tip.cost ?? "";
    commandRow.hidden = !tip.command;
    commandText.textContent = tip.command ?? "";
    status.textContent = "";
    setIconButton(copy, "copy", "Copy command");
    copy.disabled = !tip.command;
    renderDisclosure();
  }

  function refresh() {
    revision++;
    cancelAnimation();
    tips.hidden = !enabled;
    show.hidden = enabled;
    renderContent();
  }

  async function step(amount: number) {
    const length = availableTips().length;
    index = (index + amount + length) % length;
    const currentRevision = ++revision;
    cancelAnimation();
    if (!enabled || reducedMotion.matches || typeof face.animate !== "function") {
      renderContent();
      return;
    }
    copy.disabled = true;
    try {
      animation = face.animate(
        [
          { transform: "translateY(0) rotateX(0)", opacity: 1 },
          { transform: "translateY(-45%) rotateX(30deg)", opacity: 0 },
        ],
        { duration: 100, easing: "ease-in", fill: "forwards" },
      );
      await animation.finished;
      if (revision !== currentRevision) return;
      cancelAnimation();
      renderContent();
      animation = face.animate(
        [
          { transform: "translateY(45%) rotateX(-30deg)", opacity: 0 },
          { transform: "translateY(0) rotateX(0)", opacity: 1 },
        ],
        { duration: 180, easing: "cubic-bezier(.2,.7,.2,1)" },
      );
      await animation.finished;
      if (revision === currentRevision) cancelAnimation();
    } catch {
      // Rapid stepping, hiding, refreshing, or changing motion settings cancels
      // an old transition. Only the latest request may settle the visible text.
      if (revision === currentRevision) {
        cancelAnimation();
        renderContent();
      }
    }
  }

  function setEnabled(value: boolean) {
    enabled = value;
    expanded = false;
    try {
      localStorage.setItem("human-hindsight-tips", value ? "visible" : "hidden");
    } catch {
      // Hiding tips does not depend on browser storage.
    }
    refresh();
    (value ? toggle : show).focus();
  }

  setIconButton(previous, "arrow-left", "Previous tip");
  setIconButton(next, "arrow-right", "Next tip");
  setIconButton(pause, "pause", "Pause automatic tips");
  setIconButton(hide, "close", "Hide tips");
  setIconButton(show, "info", "Show tips");
  show.setAttribute("aria-controls", "tips");
  pause.setAttribute("aria-pressed", "false");
  previous.addEventListener("click", () => void step(-1));
  next.addEventListener("click", () => void step(1));
  hide.addEventListener("click", () => setEnabled(false));
  show.addEventListener("click", () => setEnabled(true));
  toggle.addEventListener("click", () => {
    expanded = !expanded;
    refresh();
  });
  pause.addEventListener("click", () => {
    paused = !paused;
    setIconButton(
      pause,
      paused ? "play" : "pause",
      paused ? "Resume automatic tips" : "Pause automatic tips",
    );
    pause.setAttribute("aria-pressed", String(paused));
  });
  reducedMotion.addEventListener("change", refresh);

  copy.addEventListener("click", async () => {
    const command = displayedTip?.command;
    if (!command || copy.disabled) return;
    const currentRevision = revision;
    copy.disabled = true;
    try {
      await navigator.clipboard.writeText(command);
      if (revision !== currentRevision) return;
      setIconButton(copy, "check", "Command copied");
      status.textContent = "Command copied. Run it in your terminal when ready.";
    } catch {
      if (revision !== currentRevision) return;
      commandText.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(commandText);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      status.textContent = `Command selected. Press ${/Mac/.test(navigator.platform) ? "⌘C" : "Ctrl+C"} to copy.`;
    } finally {
      if (revision === currentRevision) copy.disabled = false;
    }
  });

  setInterval(() => {
    if (
      !enabled ||
      paused ||
      expanded ||
      tips.hidden ||
      animation ||
      document.visibilityState !== "visible" ||
      tips.matches(":hover") ||
      tips.contains(document.activeElement)
    )
      return;
    // The privacy reminder is the initial tip and remains available manually.
    const length = availableTips().length;
    void step(index === length - 1 ? 2 : 1);
  }, 14_000);

  refresh();
  return { refresh };
}
