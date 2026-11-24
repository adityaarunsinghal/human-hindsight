import { domainPath, matchesDomain } from "../core/domains.js";
import type { Lesson, Role } from "../core/subagents.js";
import type { SubagentTarget } from "../core/subagents-paths.js";
import { createDomainPicker, renderDomainContext } from "./domains.js";
import type { GuiHighlights } from "./highlights.js";
import { type IconName, icon, setIconButton } from "./icons.js";
import {
  landingTab,
  OVERVIEW_PLACE,
  placeOnSwitch,
  selectWidth,
  TABS,
  type Tab,
} from "./landing.js";
import { renderMarkdown } from "./markdown.js";
import {
  type AgreementFacts,
  agreementDetail,
  agreementGroups,
  agreementPlace,
  agreementSummary,
  agreementsMarkdown,
  bySupport,
  GENERAL_GROUPING_NOTE,
  incompleteNotice,
  NO_PROJECT,
  type OrganizedAgreements,
  OUTCOME_NOT_VERIFIED_LABEL,
  oneTimeNotes,
  organizeAgreements,
  overview,
  promptsGuideSentence,
  supportLabel,
} from "./overview.js";
import {
  latestReflection,
  lessonMarkdown,
  preferenceMarkdown,
  type Reflection,
} from "./reflection.js";
import type {
  GuiAgreements,
  GuiEntry,
  GuiPreference,
  GuiSnapshot,
  GuiSubagents,
} from "./server.js";
import {
  chooseSessionKey,
  forgetSessionKey,
  type KeyStorage,
  rememberRestartCommand,
  SessionError,
  sessionApi,
  sessionRecovery,
} from "./session.js";
import {
  commandRow,
  notice,
  type PanelContext,
  renderCoverage,
  renderIntro,
  renderPlaybooks,
  renderRole,
  renderShared,
} from "./subagents-panel.js";
import {
  changedAgreements,
  countLabel,
  exportFilename,
  exportHref,
  exportLabel,
  roleKey,
  roleSearchText,
  type SourceStatus,
  type SubagentView,
  staleSuggestionText,
  subagentsHash,
  subagentsKeyFromHash,
} from "./subagents-view.js";
import { commandNamed, earlierPromptNotice, guidance, initTips, promptCountLines } from "./tips.js";

// The session key arrives in the address fragment. Take it out of the address
// bar before anything else runs, so it is not bookmarked, shared, or kept in
// history, and keep it in this tab's sessionStorage so a reload keeps working.
// The rules live in session.ts.
function tabStorage(): KeyStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
const keyStorage = tabStorage();
let sessionToken = "";
/** True once the server refused a key this tab had: it was restarted. */
let keyRefused = false;
function keyWasRefused(token: string) {
  forgetSessionKey(keyStorage, token);
  if (token !== sessionToken) return;
  sessionToken = "";
  keyRefused = true;
}
let api = sessionApi(sessionToken, (input, init) => fetch(input, init), keyWasRefused);
/** Adopt a key from the address or this tab. True when the key changed. */
function adoptKey(): boolean {
  const { token, strippedHash } = chooseSessionKey(location.hash, keyStorage);
  if (strippedHash !== null) {
    history.replaceState(
      null,
      "",
      strippedHash ? `#${strippedHash}` : `${location.pathname}${location.search}`,
    );
  }
  if (!token || token === sessionToken) return false;
  sessionToken = token;
  keyRefused = false;
  api = sessionApi(token, (input, init) => fetch(input, init), keyWasRefused);
  return true;
}
adoptKey();
/** The recovery text on one line, for a status line. */
function refusalText(): string {
  const { text, command } = sessionRecovery(keyRefused, keyStorage);
  return `${text} ${command}`;
}
/** What to say when the library refuses this tab, with the command to run. */
function recoveryNotice(): HTMLElement[] {
  const { text, command } = sessionRecovery(keyRefused, keyStorage);
  return [textElement("p", text), commandRow(command)];
}
interface BrowseState {
  selected: string;
  query: string;
  domain: string;
  sort: string;
  /** Where the reader and the list were scrolled when the tab was left. */
  viewerScroll: number;
  listScroll: number;
}
interface BrowseItem {
  id: string;
  title: string;
  body: string;
  preview?: string;
  domains: string[];
  authoredAt: string;
  searchText: string;
  prompt?: GuiEntry;
  preference?: GuiPreference;
  reflection?: Reflection;
  agreement?: Lesson;
  facts?: AgreementFacts;
  role?: Role;
  view?: SubagentView;
  label?: string;
  tail?: string;
}

const ALL = "all";
const ACCEPTED = "accepted";
const SAVED = "consolidated";
const REFLECTION = "reflection";
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const search = byId<HTMLInputElement>("search");
const sort = byId<HTMLSelectElement>("sort");
const list = byId("list");
const copy = byId<HTMLButtonElement>("copy");
const overviewButton = byId<HTMLButtonElement>("overview-button");
const allPreferences = byId<HTMLButtonElement>("all-preferences");
const acceptedPreferences = byId<HTMLButtonElement>("accepted-preferences");
const savedPreferences = byId<HTMLButtonElement>("saved-preferences");
const instructionProject = byId<HTMLSelectElement>("instruction-project");
const body = byId("body");
const source = byId<HTMLTextAreaElement>("source");
const previewButton = byId<HTMLButtonElement>("preview-mode");
const sourceButton = byId<HTMLButtonElement>("source-mode");
const exportTarget = byId<HTMLSelectElement>("export-target");
const exportAll = byId<HTMLButtonElement>("export-all");
const exportStatus = byId("export-status");
const exportControls = [byId("export-target-label"), exportTarget, exportAll, exportStatus];
const tabs: Record<Tab, HTMLButtonElement> = {
  prompts: byId<HTMLButtonElement>("prompts-tab"),
  preferences: byId<HTMLButtonElement>("preferences-tab"),
  subagents: byId<HTMLButtonElement>("subagents-tab"),
};
const states: Record<Tab, BrowseState> = {
  prompts: { ...OVERVIEW_PLACE, query: "", domain: "", sort: "newest" },
  preferences: { ...OVERVIEW_PLACE, query: "", domain: "", sort: "frequency" },
  // Roles keep the order the suggestion gives them; the sort control is hidden.
  subagents: { ...OVERVIEW_PLACE, query: "", domain: "", sort: "newest" },
};
let tab: Tab = "prompts";
let promptItems: BrowseItem[] = [];
let preferenceItems: BrowseItem[] = [];
let preferences: GuiPreference[] = [];
let agreementItems: BrowseItem[] = [];
let reflectionItem: BrowseItem | undefined;
let agreements: GuiAgreements | null = null;
let organized: OrganizedAgreements = organizeAgreements([]);
/** Agreement groups the person opened, kept open across re-renders. */
const openGroups = new Set<string>();
let oneTimeOpen = false;
let catalogueOpen = false;
let openReflectionSources = "";
let listOneTimeOpen = false;
let listEarlierOpen = false;
let highlights: GuiHighlights | null = null;
let libraryLoaded = false;
let preferencesMarkdown = "";
let acceptedMarkdown = "";
let projectInstructions: GuiSnapshot["projectInstructions"] = [];
let acceptedCount = 0;
let reviewsInvalid = false;
let reviewBusy = false;
let consolidation: GuiSnapshot["consolidation"] = null;
let consolidationInvalid = false;
let commands: GuiSnapshot["commands"] | null = null;
let mode: "preview" | "source" = "preview";
let copyTimer: ReturnType<typeof setTimeout> | undefined;
let selectionVersion = 0;
let renderedHash = "";
// Read for the hashless landing page or the Subagents tab. A saved review invalidates the read.
let subagents: GuiSubagents | undefined;
let subagentItems: BrowseItem[] = [];
let subagentsRequest: Promise<GuiSubagents | undefined> | undefined;
let subagentsFailed = false;
let subagentsGeneration = 0;
const domainPicker = createDomainPicker(byId("domain-picker"), selectDomain);
const tipsController = initTips(() => commands);

function textElement(tag: string, text: string, className?: string) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}
function plainText(text: string) {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function browsingAgreements() {
  return (
    !states.preferences.selected ||
    states.preferences.selected === REFLECTION ||
    states.preferences.selected.startsWith("agreement/")
  );
}
function items() {
  if (tab === "prompts") return promptItems;
  if (tab === "subagents") return subagentItems;
  if (!browsingAgreements()) return preferenceItems;
  const catalogue = agreementItems.length ? agreementItems : preferenceItems;
  return reflectionItem ? [reflectionItem, ...catalogue] : catalogue;
}
function currentItem(): BrowseItem | undefined {
  if (tab === "preferences" && states[tab].selected === ACCEPTED) {
    const markdown = instructionProject.value
      ? (projectInstructions.find((entry) => entry.project === instructionProject.value)
          ?.markdown ?? "")
      : acceptedMarkdown;
    return {
      id: ACCEPTED,
      title: "Accepted instructions",
      body: markdown,
      preview: markdown
        ? markdown
            .replace(/^<!-- human-hindsight preferences[^\n]*-->\n?/gm, "")
            .replace(/^<!-- (?:stated|observed) in \d+[^\n]*-->\n?/gm, "")
            .trim()
        : "Accept preferences from the list to build your instruction block.",
      domains: [],
      authoredAt: "",
      searchText: "",
    };
  }
  if (tab === "preferences" && states[tab].selected === SAVED && consolidation) {
    return {
      id: SAVED,
      title: "Consolidated preferences",
      body: consolidation.markdown,
      preview: consolidation.texts.map((text) => `- ${text}`).join("\n"),
      domains: [],
      authoredAt: consolidation.generatedAt,
      searchText: "",
    };
  }
  if (tab === "preferences" && states[tab].selected === ALL && preferences.length) {
    return {
      id: ALL,
      title: "All preferences",
      body: preferencesMarkdown,
      // Generated provenance and frequency comments stay in the copyable source.
      preview: preferences.map((preference) => `- ${preference.text}`).join("\n"),
      domains: [],
      authoredAt: "",
      searchText: "",
    };
  }
  return items().find((item) => item.id === states[tab].selected);
}
function route(nextTab: Tab, id: string) {
  if (nextTab === "subagents") return subagentsHash(id);
  if (nextTab === "preferences" && id.startsWith("agreement/")) {
    return `#preferences/agreement/${encodeURIComponent(id.slice("agreement/".length))}`;
  }
  return `#${nextTab}${id ? `/${encodeURIComponent(id)}` : ""}`;
}
function readRoute() {
  try {
    const hash = location.hash.slice(1);
    const subagentKey = subagentsKeyFromHash(hash);
    if (subagentKey !== null) {
      tab = "subagents";
      states.subagents.selected = subagentKey;
    } else if (hash === "preferences" || hash.startsWith("preferences/")) {
      tab = "preferences";
      states.preferences.selected = decodeURIComponent(hash.slice("preferences/".length));
    } else {
      tab = "prompts";
      // Preserve bookmarks from the original prompt-only viewer.
      states.prompts.selected = decodeURIComponent(
        hash === "prompts"
          ? ""
          : hash.startsWith("prompts/")
            ? hash.slice("prompts/".length)
            : hash,
      );
    }
  } catch {
    /* Ignore malformed bookmarks. */
  }
}
function rememberControls() {
  Object.assign(states[tab], {
    query: search.value,
    sort: sort.value,
  });
}
function syncDomainControls() {
  states[tab].domain = domainPicker.update(
    items().flatMap((item) => item.domains),
    states[tab].domain,
  );
}
function selectDomain(path: string) {
  rememberControls();
  states[tab].domain = path;
  syncDomainControls();
  render("replace", true);
  byId("domain").focus({ preventScroll: true });
}
function syncControls() {
  const isPreferences = tab === "preferences";
  const isSubagents = tab === "subagents";
  const showingAgreements = browsingAgreements() && agreementItems.length > 0;
  const noun = isSubagents ? "roles" : isPreferences ? "preferences" : "prompts";
  for (const key of TABS) {
    tabs[key].setAttribute("aria-selected", String(tab === key));
    tabs[key].tabIndex = tab === key ? 0 : -1;
  }
  byId("browse-panel").setAttribute("aria-labelledby", `${tab}-tab`);
  byId("browser").setAttribute("aria-label", `Browse ${noun}`);
  byId("list").setAttribute(
    "aria-label",
    isSubagents ? "Suggested subagents" : isPreferences ? "Preferences" : "Prompts",
  );
  byId("search-label").textContent = `Search ${noun}`;
  search.placeholder = `Search ${noun}…`;
  // Roles have no domains, and keep the order the suggestion gives them.
  byId("filter-row").hidden = isSubagents;
  search.value = states[tab].query;
  sort.setAttribute("aria-label", `Sort ${noun}`);
  // Agreements all share the date they were made, so they have no Newest order.
  const frequencyLabel =
    showingAgreements || preferences.every((preference) => preference.verified)
      ? "Most sessions"
      : preferences.some((preference) => preference.verified)
        ? "Most frequent"
        : "Most tasks";
  const sorts: [string, string][] = [
    ...(isPreferences ? [["frequency", frequencyLabel] as [string, string]] : []),
    ...(showingAgreements ? [] : [["newest", "Newest"] as [string, string]]),
    ["title", "A to Z"],
  ];
  sort.replaceChildren(
    ...sorts.map(([value, label]) => {
      const option = textElement("option", label) as HTMLOptionElement;
      option.value = value;
      return option;
    }),
  );
  if (!sorts.some(([value]) => value === states[tab].sort)) states[tab].sort = sorts[0]?.[0] ?? "";
  sort.value = states[tab].sort;
  // Wide enough for the longest label of this list, at every width.
  sort.style.width = sort.style.flexBasis = selectWidth(sorts.map(([, label]) => label));
  syncDomainControls();
  allPreferences.hidden = !isPreferences;
  allPreferences.disabled = !preferences.length;
  allPreferences.textContent = "All preferences";
  allPreferences.title = "Every observation found in your sessions, with its sources and review";
  acceptedPreferences.hidden =
    !isPreferences || (!acceptedCount && states.preferences.selected !== ACCEPTED);
  acceptedPreferences.textContent = `Accepted · ${acceptedCount}`;
  acceptedPreferences.title =
    "Accepted instructions: the preferences you accepted, in your wording, ready to paste";
  savedPreferences.hidden = !isPreferences || !consolidation;
  savedPreferences.textContent = consolidation?.stale
    ? "Consolidated · out of date"
    : "Consolidated";
  savedPreferences.title = "A saved merge of similar preferences into one block";
  byId("list-empty-text").textContent = `No matching ${noun}.`;
  byId("viewer").setAttribute(
    "aria-label",
    isSubagents ? "Selected subagent" : isPreferences ? "Selected preference" : "Selected prompt",
  );
  byId("view-mode").setAttribute("aria-label", isPreferences ? "Preference view" : "Prompt view");
  body.setAttribute("aria-label", isPreferences ? "Rendered preference" : "Rendered prompt");
  document.title = `${isSubagents ? "Suggested subagents" : isPreferences ? "Preferences" : "Prompts"} · Human Hindsight`;
  tipsController.refresh(tab);
}
function setMode(next: typeof mode) {
  mode = next;
  const item = currentItem();
  const hasReader = tab !== "subagents" && item;
  // A preference's text is its heading, so only its Markdown source is ever shown.
  body.hidden =
    !hasReader ||
    mode !== "preview" ||
    Boolean(item?.preference || item?.agreement || item?.reflection);
  source.hidden = !hasReader || mode !== "source";
  if (item?.agreement || item?.reflection) byId("guide").hidden = mode !== "preview";
  previewButton.setAttribute("aria-pressed", String(mode === "preview"));
  sourceButton.setAttribute("aria-pressed", String(mode === "source"));
  if (!source.hidden) {
    source.style.height = "0px";
    source.style.height = `${Math.max(260, source.scrollHeight + 2)}px`;
  }
}
function openItem(nextTab: Tab, id: string, clearFilters = false) {
  rememberControls();
  if (nextTab !== tab || id !== states[tab].selected) mode = "preview";
  tab = nextTab;
  states[tab].selected = id;
  if (clearFilters) {
    states[tab].query = "";
    states[tab].domain = "";
  }
  syncControls();
  render("push");
  if (matchMedia("(max-width: 760px)").matches) byId("viewer").scrollIntoView({ block: "start" });
  byId("title").focus({ preventScroll: true });
}
function relatedLink(nextTab: Tab, id: string, label: string) {
  const link = textElement("a", label) as HTMLAnchorElement;
  link.href = route(nextTab, id);
  link.addEventListener("click", (event) => {
    if (event.button || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    // A related item must remain reachable even when its tab had active filters.
    openItem(nextTab, id, true);
  });
  return link;
}
function renderRelated(item: BrowseItem | undefined) {
  const related = byId<HTMLDetailsElement>("related");
  related.open = false;
  const relatedList = byId("related-list");
  relatedList.replaceChildren();
  if (item?.id === SAVED && consolidation) {
    byId("related-title").textContent = "Source evidence";
    for (const instruction of consolidation.items) {
      const row = document.createElement("li");
      row.append(textElement("strong", plainText(instruction.text)));
      for (const id of instruction.sourceIds) {
        const preference = preferences.find((value) => value.id === id);
        if (!preference) continue;
        const line = document.createElement("div");
        line.append(relatedLink("preferences", id, plainText(preference.review.text)));
        row.append(line);
      }
      if (!instruction.sourceIds.length) {
        row.append(
          textElement(
            "span",
            "Saved by an earlier version, without links to its sources.",
            "muted",
          ),
        );
      }
      relatedList.append(row);
    }
  } else if (item?.prompt) {
    byId("related-title").textContent = "Related preferences";
    for (const id of item.prompt.preferenceIds) {
      const preference = preferences.find((value) => value.id === id);
      if (!preference) continue;
      const row = document.createElement("li");
      row.append(
        relatedLink("preferences", id, plainText(preference.text)),
        textElement("span", supportLabel(preference.count, preference.verified, "long"), "muted"),
      );
      relatedList.append(row);
    }
  } else if (item?.preference) {
    byId("related-title").textContent = item.preference.verified
      ? "Source evidence"
      : "Source evidence · unverified";
    item.preference.occurrences.forEach((occurrence, index) => {
      const row = document.createElement("li");
      row.append(
        occurrence.available
          ? relatedLink("prompts", occurrence.slug, occurrence.title)
          : textElement("span", occurrence.title),
      );
      if (!occurrence.available && !occurrence.exportName)
        row.append(textElement("span", "Prompt file unavailable", "muted"));
      if (occurrence.quote) {
        row.append(
          textElement(
            "span",
            [occurrence.messageId, dateLabel(occurrence.timestamp ?? "")]
              .filter(Boolean)
              .join(" · "),
            "muted",
          ),
          textElement("blockquote", occurrence.quote, "evidence source-quote"),
        );
      } else if (occurrence.evidence.trim()) {
        const evidence = document.createElement("div");
        evidence.className = "evidence markdown";
        evidence.append(renderMarkdown(occurrence.evidence, `evidence-${index}`));
        row.append(evidence);
      }
      relatedList.append(row);
    });
  }
  byId("related-count").textContent = String(relatedList.childElementCount);
  related.hidden = !relatedList.childElementCount;
}
function copyLabel() {
  if (currentItem()?.reflection) return "Copy reflection";
  return tab === "prompts"
    ? "Copy prompt"
    : states.preferences.selected === SAVED
      ? "Copy consolidated"
      : states.preferences.selected === ACCEPTED
        ? "Copy instructions"
        : states.preferences.selected === ALL
          ? "Review preferences first"
          : "Copy preference";
}
function canCopy(item = currentItem()) {
  if (!item?.body || reviewBusy) return false;
  if (item.preference) return item.preference.review.status !== "dismissed";
  if (item.id === ALL) return false;
  if (item.id === SAVED) return consolidation?.reviewed === true && !consolidation.stale;
  return true;
}
function renderReview(item: BrowseItem | undefined) {
  const preference = item?.preference;
  byId("preference-review").hidden = !preference;
  byId("instruction-settings").hidden = item?.id !== ACCEPTED;
  byId("preference-editor").hidden = true;
  byId("review-status").textContent = "";
  if (!preference) return;
  const review = preference.review;
  const scope =
    review.scope === "global"
      ? "All projects"
      : review.scope === "project"
        ? review.project || "Choose a project"
        : "This task";
  byId("review-summary").textContent = [
    reviewStateLabel(review),
    scope,
    reviewsInvalid ? "Reviews unavailable" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  byId("review-summary").title = [
    preference.verified
      ? `${preference.basis === "explicit" ? "Explicit instruction" : "Inferred preference"}. Open Source evidence to read the original quotation.`
      : "Found by an earlier version without a verified quotation. Check its evidence before accepting.",
    reviewsInvalid ? "Saved reviews could not be read." : "",
  ].join(" ");
  const accept = byId<HTMLButtonElement>("accept-preference");
  accept.disabled = reviewBusy || reviewsInvalid || review.status === "accepted";
  labeledButton(accept, "check", review.status === "accepted" ? "Accepted" : "Accept");
  byId<HTMLButtonElement>("dismiss-preference").disabled =
    reviewBusy || reviewsInvalid || review.status === "dismissed";
  byId<HTMLButtonElement>("edit-preference").disabled = reviewBusy || reviewsInvalid;
  const reset = byId<HTMLButtonElement>("reset-preference");
  reset.hidden = review.status === "pending" && !review.stale;
  reset.disabled = reviewBusy || reviewsInvalid;
}
/** An icon with its words beside it, so the action is never shown by a glyph alone. */
function labeledButton(button: HTMLButtonElement, name: IconName, label: string) {
  button.replaceChildren(icon(name), textElement("span", label));
  button.removeAttribute("aria-label");
  button.title = label;
}
/** What a preference's review state is, in words. */
function reviewStateLabel(review: GuiPreference["review"]): string {
  if (review.stale) return "Evidence changed";
  return { accepted: "Accepted", dismissed: "Dismissed", pending: "To review" }[review.status];
}
function metadataDetails(lines: string[]): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = "entry-details";
  const summary = document.createElement("summary");
  summary.setAttribute("aria-label", "More details");
  summary.title = "More details";
  summary.append(icon("info"));
  const panel = document.createElement("div");
  panel.className = "entry-details-panel";
  for (const line of lines.filter(Boolean)) panel.append(textElement("p", line));
  details.append(summary, panel);
  return details;
}
/** Where a saved suggestion's source preference stands in the library now. */
function sourceStatus(id: string): SourceStatus {
  const preference = preferences.find((value) => value.id === id);
  if (!preference) return "missing";
  return preference.review.status === "dismissed" ? "dismissed" : "current";
}
const subagentPanel: PanelContext = {
  preferenceLink: (id, label) =>
    preferences.some((preference) => preference.id === id)
      ? relatedLink("preferences", id, plainText(label))
      : null,
  // Only an out-of-date suggestion can hold agreements whose sources changed.
  get sourceStatus() {
    return subagents?.stale ? sourceStatus : undefined;
  },
};
function syncExportLink() {
  const target = (exportTarget.value || "all") as SubagentTarget | "all";
  const label = exportTarget.selectedOptions[0]?.textContent ?? "All targets";
  exportTarget.title = label;
  exportAll.textContent = exportLabel(target);
  exportAll.title =
    target === "all"
      ? "Download every target as one zip"
      : `Download the ${label} files as one zip, with the shared knowledge`;
}
function guideLink(nextTab: Tab, all: BrowseItem[], id: string) {
  const item = all.find((entry) => entry.id === id);
  return item ? relatedLink(nextTab, id, item.title) : undefined;
}
/** Shown when a tab has nothing yet: the bare command runs the guided first run. */
function startHere(text: string): HTMLElement | undefined {
  return commands ? notice(text, commands.start) : undefined;
}
function promptsOverview() {
  const first = highlights?.prompts.find((rank) => promptItems.some((item) => item.id === rank.id));
  let action: HTMLElement | undefined;
  if (first) {
    const button = textElement(
      "button",
      "Copy the first prompt",
      "overview-action",
    ) as HTMLButtonElement;
    button.type = "button";
    button.addEventListener("click", () => {
      openItem("prompts", first.id, true);
      copy.click();
    });
    action = button;
  }
  return overview({
    label: "Prompts guide",
    description: promptsGuideSentence(
      promptItems.length,
      promptItems.filter((item) => item.prompt && !item.prompt.outcomeVerified).length,
    ),
    highlights: highlights?.prompts,
    highlightsUnavailable: !highlights && promptItems.length > 0,
    link: (id) => guideLink("prompts", promptItems, id),
    guidance: promptItems.length ? guidance.prompts : "",
    message: promptItems.length
      ? undefined
      : startHere(
          "There are no prompts yet. Run this in your terminal to read your sessions and build them, then choose Refresh:",
        ),
    action,
  });
}
function agreementsNotice() {
  if (!agreements) {
    return notice(
      "The saved preference summaries could not be loaded. Your observations are still available.",
    );
  }
  if (agreements.state === "damaged") {
    return notice(
      "The saved preference summaries could not be read. Run this to rebuild them.",
      commands?.reflect,
    );
  }
  if (agreements.stale) {
    return notice(
      "Your observations or reviews changed after these preferences were summarized. Some summaries may be out of date. Run this to refresh them.",
      commands?.reflect,
    );
  }
  return undefined;
}
/** The overview's notices: an unfinished set, then out of date or damaged. */
function agreementsMessages(): HTMLElement[] {
  const unfinished = incompleteNotice(agreements?.incomplete);
  const status = agreementsNotice();
  return [
    ...(unfinished ? [notice(unfinished, commands?.reflect)] : []),
    ...(status ? [status] : []),
  ];
}
/** The one action of the agreements overview: copy exactly the general agreements it lists. */
function overviewCopy(label: string, markdown: string, success: string, name: string): HTMLElement {
  const wrap = textElement("div", "", "overview-copy");
  const button = textElement("button", label, "overview-action") as HTMLButtonElement;
  button.type = "button";
  button.id = name;
  const status = textElement("p", "", "muted copy-status");
  status.setAttribute("role", "status");
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      status.textContent = success;
    } catch {
      // No clipboard: show the text selected, ready for the copy shortcut.
      let area = wrap.querySelector("textarea");
      if (!area) {
        area = document.createElement("textarea");
        area.readOnly = true;
        area.className = "copy-fallback";
        area.setAttribute("aria-label", `${label} as Markdown`);
        area.value = markdown;
        wrap.append(area);
      }
      area.focus({ preventScroll: true });
      area.select();
      status.textContent = `Markdown selected. Press ${/Mac/.test(navigator.platform) ? "⌘C" : "Ctrl+C"} to copy.`;
    }
  });
  wrap.append(button, status);
  return wrap;
}
function preferencesCatalogue() {
  const link = (id: string) => guideLink("preferences", agreementItems, id);
  const sections: HTMLElement[] = [];
  if (organized.general.length) {
    sections.push(
      agreementGroups({
        heading: "General preferences",
        note: GENERAL_GROUPING_NOTE,
        key: "general",
        groups: organized.general,
        link,
        open: openGroups,
      }),
    );
  }
  if (organized.projects.length) {
    sections.push(
      agreementGroups({
        heading: "For specific projects",
        key: "project",
        groups: organized.projects,
        link,
        open: openGroups,
      }),
    );
  }
  if (organized.oneTime.length) {
    sections.push(
      oneTimeNotes({
        items: organized.oneTime,
        link,
        open: oneTimeOpen,
        onToggle: (open) => {
          oneTimeOpen = open;
        },
      }),
    );
  }
  const details = document.createElement("details");
  details.className = "related preference-catalogue";
  details.open = catalogueOpen;
  details.append(
    textElement("summary", `Browse ${countLabel(organized.counts.total, "saved preference")}`),
    textElement("p", agreementSummary(organized.counts, agreements?.preferenceCount ?? 0), "muted"),
    ...sections,
  );
  if (organized.counts.general) {
    const count = countLabel(organized.counts.general, "general preference");
    details.append(
      overviewCopy(
        `Copy ${count} as Markdown`,
        agreementsMarkdown(
          organized,
          agreementItems.flatMap((item) => item.agreement ?? []),
        ),
        `Copied ${count}.`,
        "copy-agreements",
      ),
    );
  }
  details.addEventListener("toggle", () => {
    if (details.isConnected) catalogueOpen = details.open;
  });
  return details;
}
function reflectionSources(reflection: Reflection): HTMLDetailsElement {
  const detail = document.createElement("details");
  detail.className = "related reflection-sources";
  detail.open = openReflectionSources === reflection.preference.id;
  const groups = new Map<string, GuiPreference["occurrences"]>();
  for (const row of reflection.sources) {
    const id = row.exportName ?? row.slug;
    const group = groups.get(id) ?? [];
    group.push(row);
    groups.set(id, group);
  }
  const summary = document.createElement("summary");
  const verified = reflection.sources.every((row) => row.quote && row.exportName);
  summary.append(
    textElement(
      "span",
      verified
        ? groups.size === 1
          ? "Source conversation"
          : "Source conversations"
        : "Recorded evidence",
    ),
    textElement("span", `(${groups.size})`, "source-count"),
  );
  const list = document.createElement("ul");
  for (const rows of groups.values()) {
    const first = rows[0];
    if (!first) continue;
    const item = document.createElement("li");
    const date = dateLabel(first.timestamp ?? "");
    item.append(textElement("strong", [first.title, date].filter(Boolean).join(" · ")));
    for (const row of rows) {
      if (row.quote) item.append(textElement("blockquote", row.quote, "evidence source-quote"));
      else
        item.append(
          textElement("p", row.evidence || "This source has no saved quotation.", "evidence"),
        );
    }
    if (first.available) item.append(relatedLink("prompts", first.slug, "Open prompt"));
    list.append(item);
  }
  detail.append(summary, list);
  detail.addEventListener("toggle", () => {
    if (detail.isConnected) openReflectionSources = detail.open ? reflection.preference.id : "";
  });
  return detail;
}
function reflectionOverview(reflection: Reflection, showCatalogue: boolean): HTMLElement {
  const root = document.createElement("section");
  root.className = "overview reflection-overview";
  root.setAttribute("aria-label", showCatalogue ? "Preferences guide" : "Reflection");
  root.append(textElement("p", reflection.observation, "overview-summary"));
  if (reflection.sources.length) root.append(reflectionSources(reflection));
  const lesson = reflection.lesson;
  const preference = reflection.preference;
  const noun = lesson?.disposition === "historical" ? "One-time note" : "Preference";
  root.append(textElement("h2", noun, "preference-label"));
  const list = document.createElement("ul");
  list.className = "highlights";
  const row = document.createElement("li");
  row.append(
    relatedLink(
      "preferences",
      lesson ? `agreement/${lesson.id}` : preference.id,
      lesson?.title ?? plainText(preference.review.text),
    ),
    textElement("span", reflection.scope, "muted"),
  );
  list.append(row);
  root.append(
    list,
    overviewCopy(
      `Copy ${noun.toLowerCase()}`,
      reflection.markdown,
      `${noun} copied.`,
      "copy-reflection-preference",
    ),
  );
  if (showCatalogue) {
    root.append(...agreementsMessages());
    if (agreementItems.length) root.append(preferencesCatalogue());
  }
  return root;
}
function preferencesOverview() {
  if (reflectionItem?.reflection) return reflectionOverview(reflectionItem.reflection, true);
  return overview({
    label: "Preferences guide",
    description:
      preferences.length || agreementItems.length
        ? "There are no current observations to feature in a reflection. You can browse saved preferences and their sources."
        : "Your reflection will appear here when your sessions have been read.",
    link: () => undefined,
    guidance: "",
    message:
      preferences.length || agreementItems.length
        ? agreementsMessages()
        : startHere("Read your sessions in the terminal, then choose Refresh."),
    sections: agreementItems.length ? [preferencesCatalogue()] : [],
  });
}
/**
 * The export controls live in one place at a time: in the overview, where
 * they are its one action, and in the toolbar above every other view.
 */
function placeExportControls(inOverview: HTMLElement | null) {
  // Held by reference: a control inside a replaced overview is no longer found by its ID.
  (inOverview ?? byId("subagents-toolbar")).append(...exportControls);
}
function renderSubagentsDetail(item: BrowseItem | undefined) {
  clearTimeout(copyTimer);
  byId("copy-status").textContent = "";
  byId("consolidation-notice").hidden = true;
  byId("word-count").textContent = "";
  renderReview(undefined);
  renderRelated(undefined);
  setMode(mode);
  byId("viewer").dataset.kind = "subagent";
  const metadata = byId("metadata");
  metadata.replaceChildren();
  const artifact = subagents?.suggestion ?? null;
  const onOverview = !item?.role && !item?.view;
  byId("subagents-toolbar").hidden = !artifact || onOverview;
  if (!onOverview) placeExportControls(null);
  syncExportLink();
  const banners: HTMLElement[] = [];
  if (subagentsFailed) {
    banners.push(
      notice(
        "Couldn't load the suggested subagents. Check that npx human-hindsight gui is still running in your terminal, then choose Refresh.",
      ),
    );
  } else if (subagents?.error) {
    banners.push(
      notice(
        `The saved suggestion could not be read (${subagents.error}). Create a new one with:`,
        subagents.command,
      ),
    );
  } else if (subagents?.stale && artifact) {
    banners.push(
      notice(
        staleSuggestionText(changedAgreements(artifact, sourceStatus).size),
        subagents.command,
      ),
    );
  }
  const banner = byId("subagents-banner");
  banner.replaceChildren(...banners);
  banner.hidden = !banners.length;
  const view = byId("subagents-view");
  const title = byId("title");
  title.textContent = "Suggested subagents";
  if (!subagents || !artifact) {
    // A failed or unreadable read already says what to do in its banner.
    if (!subagents && !subagentsFailed)
      view.replaceChildren(textElement("p", "Loading suggested subagents…", "muted"));
    else if (subagents && !subagents.error)
      view.replaceChildren(
        renderIntro(subagents.command, preferences.length ? undefined : commands?.start),
      );
    else view.replaceChildren();
    byId("viewer").scrollTop = 0;
    return;
  }
  const files = subagents.files;
  const summary = (text: string) => metadata.append(textElement("span", text));
  if (item?.role) {
    title.textContent = item.role.display_name;
    summary(`${item.role.name} · ${countLabel(item.role.lesson_ids.length, "preference")}`);
    view.replaceChildren(renderRole(artifact, files, item.role, subagentPanel));
  } else if (item?.view === "shared") {
    title.textContent = "Shared preferences";
    summary(countLabel(artifact.shared.length, "preference"));
    view.replaceChildren(renderShared(artifact, files, subagentPanel));
  } else if (item?.view === "playbooks") {
    title.textContent = "Playbooks";
    summary(countLabel(artifact.playbooks.length, "playbook"));
    view.replaceChildren(renderPlaybooks(artifact, files, subagentPanel));
  } else if (item?.view === "coverage") {
    title.textContent = "Coverage";
    summary(countLabel(artifact.coverage.source_candidates, "preference"));
    view.replaceChildren(
      renderCoverage(artifact, files, subagentPanel, dateLabel(artifact.generated_at)),
    );
  } else {
    // The overview's one action is the export itself: the same select and button.
    const action = textElement("div", "", "overview-export");
    view.replaceChildren(
      overview({
        label: "Subagents guide",
        description: `${countLabel(artifact.roles.length, "suggested subagent")}, each a specialist role for one kind of recurring task, carrying the preferences that fit it.`,
        highlights: highlights?.subagents,
        highlightsUnavailable: !highlights,
        link: (id) => guideLink("subagents", subagentItems, id),
        guidance: guidance.subagents,
        action,
      }),
    );
    placeExportControls(action);
  }
  byId("viewer").scrollTop = 0;
}
function renderDetail() {
  const isSubagents = tab === "subagents";
  const item = currentItem();
  byId("reader-toolbar").hidden = isSubagents || !item;
  overviewButton.setAttribute("aria-current", String(!states[tab].selected));
  const guide = byId("guide");
  guide.hidden = isSubagents || Boolean(item && !item.agreement && !item.reflection);
  if (!guide.hidden) {
    if (item?.agreement) {
      const message = agreements?.stale ? agreementsNotice() : undefined;
      const detail = agreementDetail(
        item.agreement,
        new Map(preferences.map((pref) => [pref.id, pref])),
        (id) => relatedLink("preferences", id, "Open observation"),
      );
      guide.replaceChildren(...(message ? [message, detail] : [detail]));
    } else if (item?.reflection) {
      guide.replaceChildren(reflectionOverview(item.reflection, false));
    } else {
      guide.replaceChildren(tab === "prompts" ? promptsOverview() : preferencesOverview());
    }
  }
  // An earlier prompt says what it is, with the exact command that removes such prompts.
  const earlierNotice = byId("earlier-notice");
  const pruneCommand =
    !isSubagents && item?.prompt?.earlier && commands ? commandNamed(commands.status, "prune") : "";
  earlierNotice.replaceChildren(
    ...(pruneCommand ? [textElement("p", earlierPromptNotice()), commandRow(pruneCommand)] : []),
  );
  earlierNotice.hidden = !pruneCommand;
  byId("subagents-view").hidden = !isSubagents;
  if (!isSubagents) {
    byId("subagents-toolbar").hidden = true;
    byId("subagents-banner").hidden = true;
  }
  selectionVersion++;
  if (isSubagents) {
    renderSubagentsDetail(item);
    return;
  }
  clearTimeout(copyTimer);
  setIconButton(copy, "copy", copyLabel());
  copy.disabled = !canCopy(item);
  previewButton.disabled = sourceButton.disabled = !item;
  byId("copy-status").textContent = "";
  const metadata = byId("metadata");
  metadata.replaceChildren();
  byId("viewer").dataset.kind = item?.preference
    ? "preference"
    : item?.agreement
      ? "agreement"
      : "prompt";
  // A preference is its own heading; the reader below would only repeat it.
  byId("title").textContent = item
    ? item.title
    : tab === "prompts"
      ? "Your prompt library"
      : reflectionItem
        ? "Your latest reflection"
        : "Your preferences";
  byId("view-mode").hidden = Boolean(item?.preference);
  source.value = item?.body ?? "";
  if (item?.preference) mode = "preview";
  body.replaceChildren(
    item && !item.agreement && !item.reflection
      ? renderMarkdown(item.preview ?? item.body)
      : document.createDocumentFragment(),
  );
  setMode(mode);
  byId("word-count").textContent = item
    ? `${item.body.split(/\s+/).filter(Boolean).length} words`
    : "";
  allPreferences.setAttribute(
    "aria-current",
    String(tab === "preferences" && states.preferences.selected === ALL),
  );
  savedPreferences.setAttribute(
    "aria-current",
    String(tab === "preferences" && states.preferences.selected === SAVED),
  );
  acceptedPreferences.setAttribute(
    "aria-current",
    String(tab === "preferences" && states.preferences.selected === ACCEPTED),
  );
  const consolidationNotice = byId("consolidation-notice");
  consolidationNotice.hidden = true;
  if (tab === "preferences" && consolidationInvalid) {
    consolidationNotice.textContent =
      "The saved consolidation could not be read. Your observed preferences are still available. The optional consolidation command can create a new saved result.";
    consolidationNotice.hidden = false;
  } else if (item?.id === SAVED && consolidation?.stale) {
    consolidationNotice.textContent =
      "The source preferences or their review status have changed. Review the current preferences and run consolidation again before copying this result as instructions.";
    consolidationNotice.hidden = false;
  } else if (item?.id === SAVED && !consolidation?.reviewed) {
    consolidationNotice.textContent =
      "This saved result has not been traced to accepted preferences. Review the preferences and run consolidation again to create an instruction block.";
    consolidationNotice.hidden = false;
  } else if (item?.id === ALL) {
    consolidationNotice.textContent =
      "Open a preference to review it. Accepted preferences become your accepted instructions, ready to paste.";
    consolidationNotice.hidden = false;
  }
  if (item) {
    if (item.domains.length) metadata.append(renderDomainContext(item.domains, selectDomain));
    const details: string[] = [];
    if (item.prompt) {
      const prompt = item.prompt;
      const summary = textElement("div", "", "metadata-summary");
      const more = [dateLabel(item.authoredAt), `${prompt.confidence} confidence`];
      if (prompt.edited) more.push("Edited");
      if (prompt.rating === "up") more.push("Liked");
      if (prompt.rating === "down") more.push("Disliked");
      summary.append(
        textElement("span", `${prompt.sessions} ${prompt.sessions === 1 ? "session" : "sessions"}`),
        // Quiet, but in view: what this prompt was written from matters before it is pasted.
        ...(prompt.outcomeVerified
          ? []
          : [textElement("span", OUTCOME_NOT_VERIFIED_LABEL, "muted outcome-note")]),
        metadataDetails(more),
      );
      metadata.append(summary);
    } else if (item.preference) {
      const summary = textElement("div", "", "metadata-summary");
      summary.append(
        textElement("span", supportLabel(item.preference.count, item.preference.verified, "long")),
        metadataDetails([
          dateLabel(item.authoredAt),
          item.preference.verified
            ? item.preference.basis === "explicit"
              ? "Explicit instruction"
              : "Inferred preference"
            : "Earlier version · no verified quotation",
        ]),
      );
      metadata.append(summary);
    } else if (item.reflection) {
      metadata.append(textElement("span", "Reflection", "reflection-label"));
      details.push(
        supportLabel(
          item.reflection.preference.count,
          item.reflection.preference.verified,
          "short",
        ),
      );
    } else if (item.agreement) {
      metadata.append(textElement("span", "Preference", "preference-label"));
      if (item.facts) details.push(agreementPlace(item.facts));
    } else if (item.id === ACCEPTED) {
      details.push(instructionProject.value || "All projects");
    } else if (item.id === SAVED && consolidation) {
      details.push(
        `${consolidation.texts.length} instructions`,
        `From ${consolidation.sourcePreferenceIds.length} preferences`,
      );
    } else {
      const recurring = preferences.filter((preference) => preference.count > 1).length;
      details.push(
        countLabel(preferences.length, "preference"),
        `${recurring} seen in more than one session or task`,
      );
    }
    if (details.length) metadata.append(textElement("span", details.filter(Boolean).join(" · ")));
  }
  renderReview(item);
  renderRelated(item);
  byId("viewer").scrollTop = 0;
}
function updateHash(historyMode: "push" | "replace") {
  const hash = route(tab, states[tab].selected);
  if (location.hash !== hash) {
    if (historyMode === "push") history.pushState(null, "", hash);
    else history.replaceState(null, "", hash);
  }
  renderedHash = location.hash;
}
function subagentItemsFrom(data: GuiSubagents | undefined): BrowseItem[] {
  const artifact = data?.suggestion;
  if (!artifact) return [];
  const item = (fields: Partial<BrowseItem> & Pick<BrowseItem, "id" | "title">): BrowseItem => ({
    body: "",
    domains: [],
    authoredAt: "",
    searchText: "",
    ...fields,
  });
  return [
    ...artifact.roles.map((role) =>
      item({
        id: roleKey(role.name),
        title: role.display_name,
        searchText: roleSearchText(role),
        role,
        label: role.name,
        tail: countLabel(role.lesson_ids.length, "preference"),
      }),
    ),
    item({
      id: "shared",
      title: "Shared",
      view: "shared",
      label: "Every role",
      tail: countLabel(artifact.shared.length, "preference"),
    }),
    item({
      id: "playbooks",
      title: "Playbooks",
      view: "playbooks",
      tail: countLabel(artifact.playbooks.length, "playbook"),
    }),
    item({
      id: "coverage",
      title: "Coverage",
      view: "coverage",
      tail: countLabel(artifact.coverage.source_candidates, "preference"),
    }),
  ];
}
const readJson = <T>(path: string): Promise<T> => api.json<T>(path);
function loadSubagents(): Promise<GuiSubagents | undefined> {
  if (subagentsRequest) return subagentsRequest;
  const generation = subagentsGeneration;
  subagentsRequest = (async () => {
    let data: GuiSubagents | undefined;
    try {
      data = await readJson<GuiSubagents>("/api/subagents");
      if (typeof data.command !== "string" || !data.files || typeof data.files !== "object")
        throw new Error("Invalid suggested subagents response");
    } catch {
      data = undefined;
    }
    if (generation === subagentsGeneration) {
      subagents = data;
      subagentsFailed = !data;
      subagentItems = subagentItemsFrom(data);
      subagentsRequest = undefined;
    }
    return data;
  })();
  return subagentsRequest;
}
function entryButton(item: BrowseItem, selected: string): HTMLButtonElement {
  const button = textElement(
    "button",
    "",
    item.preference
      ? "entry preference-entry"
      : item.view === "shared"
        ? "entry entry-divider"
        : "entry",
  ) as HTMLButtonElement;
  button.type = "button";
  button.dataset.id = item.id;
  button.setAttribute("aria-current", String(item.id === selected));
  button.title = item.title;
  const meta = textElement("span", "", "entry-meta");
  if (item.reflection) {
    const pref = item.reflection.preference;
    meta.append(
      textElement("span", "Reflection", "entry-meta-label reflection-label"),
      textElement("span", supportLabel(pref.count, pref.verified, "short"), "entry-meta-tail"),
    );
  } else if (item.preference) {
    const review = item.preference.review;
    const words = reviewStateLabel(review);
    if (review.status !== "pending" || review.stale)
      meta.append(textElement("span", words, "entry-state-label"));
    meta.append(
      textElement(
        "span",
        review.scope === "global"
          ? "All projects"
          : review.scope === "project"
            ? review.project || "Project"
            : "This task",
        "entry-meta-label preference-label",
      ),
      textElement(
        "span",
        supportLabel(item.preference.count, item.preference.verified, "short"),
        "entry-meta-tail",
      ),
    );
  } else if (item.facts) {
    const support = item.facts.sessions
      ? supportLabel(item.facts.sessions, true, "short")
      : countLabel(item.facts.preferences, "preference");
    meta.append(
      textElement("span", "Preference", "entry-meta-label preference-label"),
      textElement("span", support, "entry-meta-tail"),
    );
  } else if (tab === "subagents") {
    meta.append(
      textElement("span", item.label ?? "", "entry-meta-label"),
      textElement("span", item.tail ?? "", "entry-meta-tail"),
    );
  } else {
    const label = textElement(
      "span",
      domainPath(item.domains[0] ?? "").at(-1) ?? "",
      "entry-meta-label",
    );
    label.title = item.domains[0] ?? "";
    meta.append(label);
    if (item.prompt)
      meta.append(
        textElement(
          "span",
          `${item.prompt.earlier ? "Earlier · " : ""}${item.prompt.outcomeVerified ? "" : `${OUTCOME_NOT_VERIFIED_LABEL} · `}${countLabel(item.prompt.sessions, "session")}`,
          "entry-meta-tail",
        ),
      );
  }
  button.append(textElement("span", item.title, "entry-title"), meta);
  button.addEventListener("click", () => openItem(tab, item.id));
  return button;
}
/**
 * The agreements list in the same shape as the overview: general groups, then
 * project groups, then the one-time notes behind one disclosure. The order
 * inside each group follows the sort control.
 */
function agreementList(
  visible: BrowseItem[],
  entries: HTMLButtonElement[],
  filtering: boolean,
): HTMLElement[] {
  const buttons = new Map(entries.map((entry) => [entry.dataset.id ?? "", entry]));
  const shown = organizeAgreements(visible.flatMap((item) => item.facts ?? []));
  const order = (items: AgreementFacts[]) =>
    states.preferences.sort === "title"
      ? [...items].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
      : [...items].sort(bySupport);
  const button = (facts: AgreementFacts) => buttons.get(`agreement/${facts.id}`) ?? [];
  const section = (title: string, groups: OrganizedAgreements["general"]) => {
    if (!groups.length) return [];
    return [
      textElement("p", title, "list-section"),
      ...groups.map((group) => {
        const wrap = textElement("div", "", "list-group");
        wrap.setAttribute("role", "group");
        wrap.setAttribute(
          "aria-label",
          `${group.label}, ${countLabel(group.items.length, "preference")}`,
        );
        const heading = textElement("p", group.label, "list-heading");
        heading.setAttribute("aria-hidden", "true");
        heading.append(textElement("span", String(group.items.length), "list-heading-count"));
        wrap.append(heading, ...order(group.items).flatMap(button));
        return wrap;
      }),
    ];
  };
  const reflection = buttons.get(REFLECTION);
  const nodes: HTMLElement[] = [
    ...(reflection ? [reflection] : []),
    ...section("General", shown.general),
    ...section("For specific projects", shown.projects),
  ];
  if (shown.oneTime.length) {
    const details = document.createElement("details");
    details.className = "list-one-time";
    const selectedHere = shown.oneTime.some(
      (item) => `agreement/${item.id}` === states.preferences.selected,
    );
    details.open = listOneTimeOpen || selectedHere || filtering;
    const summary = textElement("summary", countLabel(shown.oneTime.length, "one-time note"));
    details.append(summary, ...order(shown.oneTime).flatMap(button));
    details.addEventListener("toggle", () => {
      if (!filtering) listOneTimeOpen = details.open;
    });
    nodes.push(details);
  }
  return nodes;
}
function render(historyMode: "push" | "replace" = "replace", selectMatch = false) {
  const state = states[tab];
  if (!libraryLoaded) {
    // An explicit tab click or bookmark during loading takes precedence over the automatic tab.
    if (historyMode === "push") updateHash(historyMode);
    return;
  }
  if (tab === "subagents" && !subagents) {
    // Keep the requested selection and its address until the data arrives.
    if (!subagentsFailed && !subagentsRequest) {
      const generation = subagentsGeneration;
      void loadSubagents().then(() => {
        if (generation === subagentsGeneration && tab === "subagents") {
          syncControls();
          render();
        }
      });
    }
    list.replaceChildren();
    byId("count").textContent = subagentsFailed
      ? "Suggested subagents unavailable"
      : "Loading suggested subagents…";
    byId("list-empty").hidden = true;
    renderDetail();
    updateHash(historyMode);
    return;
  }
  sort.title = sort.selectedOptions[0]?.textContent || "";
  const terms = state.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const all = items();
  // Search narrows the roles; Shared, Playbooks and Coverage stay listed.
  const visible = all.filter(
    (item) =>
      item.view ||
      ((!state.domain || item.domains.some((value) => matchesDomain(value, state.domain))) &&
        terms.every((term) => item.searchText.includes(term))),
  );
  visible.sort((a, b) => {
    // A stable sort keeps the suggestion's role order.
    if (tab === "subagents") return 0;
    if (a.reflection || b.reflection)
      return Number(Boolean(b.reflection)) - Number(Boolean(a.reflection));
    if (state.sort === "title") return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
    return (
      (state.sort === "frequency"
        ? (b.facts?.sessions ?? b.preference?.count ?? 0) -
          (a.facts?.sessions ?? a.preference?.count ?? 0)
        : 0) ||
      b.authoredAt.localeCompare(a.authoredAt) ||
      a.id.localeCompare(b.id)
    );
  });
  if (tab === "subagents") {
    const roles = all.filter((item) => item.role).length;
    const shown = visible.filter((item) => item.role).length;
    byId("count").textContent = subagents?.error
      ? "Saved suggestion unreadable"
      : !roles
        ? "No suggestion yet"
        : shown === roles
          ? countLabel(roles, "role")
          : `${shown} of ${roles} roles`;
    byId("list-empty").hidden = shown !== 0 || roles === 0;
  } else {
    const filtering = visible.length !== all.length;
    let note = "";
    if (tab === "prompts") {
      // Prompts left behind by a regrouping are counted apart from the current ones.
      const earlier = (items: BrowseItem[]) => items.filter((item) => item.prompt?.earlier).length;
      const lines = promptCountLines({
        current: all.length - earlier(all),
        earlier: earlier(all),
        shownCurrent: visible.length - earlier(visible),
        shownEarlier: earlier(visible),
        filtering,
      });
      byId("count").textContent = lines[0];
      note = lines[1];
    } else {
      const total = all.filter((item) => !item.reflection).length;
      const shown = visible.filter((item) => !item.reflection).length;
      byId("count").textContent = [
        visible.some((item) => item.reflection) ? "1 reflection" : "",
        filtering
          ? `${shown} of ${countLabel(total, "preference")}`
          : countLabel(total, "preference"),
      ]
        .filter(Boolean)
        .join(" · ");
    }
    byId("count-note").textContent = note;
    byId("count-note").hidden = !note;
    byId("list-empty").hidden = visible.length !== 0 || all.length === 0;
  }
  const candidatesView =
    tab === "preferences" &&
    preferences.length > 0 &&
    state.selected === ALL &&
    terms.length === 0 &&
    !state.domain;
  const saved =
    tab === "preferences" &&
    consolidation &&
    state.selected === SAVED &&
    terms.length === 0 &&
    !state.domain;
  const accepted =
    tab === "preferences" && state.selected === ACCEPTED && terms.length === 0 && !state.domain;
  if (
    !accepted &&
    !saved &&
    !candidatesView &&
    !visible.some((item) => item.id === state.selected)
  ) {
    const emptyView = tab === "preferences" && !browsingAgreements() ? ALL : "";
    state.selected = selectMatch ? (visible[0]?.id ?? emptyView) : "";
  }
  const entries = visible.map((item) => entryButton(item, state.selected));
  if (tab === "preferences" && browsingAgreements() && agreementItems.length) {
    list.replaceChildren(...agreementList(visible, entries, terms.length > 0 || !!state.domain));
  } else if (tab === "prompts" && entries.some((_, index) => visible[index]?.prompt?.earlier)) {
    // Current prompts first; the earlier ones wait behind one closed disclosure.
    const earlier = entries.filter((_, index) => visible[index]?.prompt?.earlier);
    const details = document.createElement("details");
    details.className = "list-one-time list-earlier";
    const filtering = terms.length > 0 || Boolean(state.domain);
    details.open =
      listEarlierOpen || filtering || earlier.some((entry) => entry.dataset.id === state.selected);
    details.append(
      textElement(
        "summary",
        `${earlier.length} earlier ${earlier.length === 1 ? "prompt" : "prompts"}`,
      ),
      ...earlier,
    );
    details.addEventListener("toggle", () => {
      if (!filtering) listEarlierOpen = details.open;
    });
    list.replaceChildren(...entries.filter((entry) => !earlier.includes(entry)), details);
  } else {
    list.replaceChildren(...entries);
  }
  renderDetail();
  updateHash(historyMode);
}
async function load(snapshot?: GuiSnapshot): Promise<boolean> {
  byId("notice").hidden = true;
  // Reviews change the accepted set, so the suggestion's stale flag is re-read.
  subagentsGeneration++;
  subagentsRequest = undefined;
  subagents = undefined;
  subagentItems = [];
  subagentsFailed = false;
  try {
    if (!sessionToken) throw new SessionError(403);
    const chooseDefault = !libraryLoaded && !location.hash;
    const [data, ranked, savedAgreements] = await Promise.all([
      snapshot ?? readJson<GuiSnapshot>("/api/library"),
      readJson<GuiHighlights>("/api/highlights").catch(() => null),
      readJson<GuiAgreements>("/api/preferences/generalized").catch(() => null),
      tab === "subagents" ? loadSubagents() : undefined,
    ]);
    if (!Array.isArray(data.entries) || !Array.isArray(data.preferences))
      throw new Error("Invalid library response");
    promptItems = data.entries.map((entry) => ({
      id: entry.slug,
      title: entry.title,
      body: entry.body,
      domains: entry.domains,
      authoredAt: entry.authoredAt,
      searchText: [
        entry.title,
        entry.slug,
        entry.body,
        ...entry.domains,
        ...entry.domains.flatMap(domainPath),
      ]
        .join(" ")
        .toLocaleLowerCase(),
      prompt: entry,
    }));
    preferences = data.preferences;
    const candidates = new Map(preferences.map((pref) => [pref.id, pref]));
    highlights = ranked;
    agreements = savedAgreements;
    // `facts` lines up with `lessons`; an older answer without it gets plain facts.
    const factsById = new Map((agreements?.facts ?? []).map((facts) => [facts.id, facts]));
    const projectGroups = new Map(
      (agreements?.facts ?? [])
        .filter((facts) => facts.kind === "project" && facts.group !== NO_PROJECT)
        .map((facts) => [facts.id, facts.group]),
    );
    agreementItems = (agreements?.lessons ?? []).map((lesson) => {
      const facts: AgreementFacts = factsById.get(lesson.id) ?? {
        id: lesson.id,
        title: lesson.title,
        kind: "general",
        group: "Other",
        sessions: 0,
        preferences: new Set(lesson.source_ids).size,
      };
      const domains = [
        ...new Set(lesson.source_ids.flatMap((id) => candidates.get(id)?.domains ?? [])),
      ];
      return {
        id: `agreement/${lesson.id}`,
        title: lesson.title,
        body: lessonMarkdown(lesson, projectGroups.get(lesson.id)),
        domains,
        authoredAt: savedAgreements?.generatedAt ?? "",
        searchText: [
          lesson.title,
          lesson.instruction,
          lesson.applies_when,
          lesson.exceptions,
          facts.group,
          ...domains,
        ]
          .join(" ")
          .toLocaleLowerCase(),
        agreement: lesson,
        facts,
      };
    });
    organized = organizeAgreements(agreementItems.flatMap((item) => item.facts ?? []));
    preferencesMarkdown = data.preferencesMarkdown;
    acceptedMarkdown = data.acceptedMarkdown;
    projectInstructions = data.projectInstructions;
    acceptedCount = data.acceptedCount;
    reviewsInvalid = data.reviewsInvalid;
    const selectedProject = instructionProject.value;
    instructionProject.replaceChildren(
      ...[
        { project: "", label: "Global preferences only" },
        ...projectInstructions.map(({ project }) => ({ project, label: project })),
      ].map(({ project, label }) => {
        const option = textElement("option", label) as HTMLOptionElement;
        option.value = project;
        return option;
      }),
    );
    instructionProject.value = projectInstructions.some(
      (entry) => entry.project === selectedProject,
    )
      ? selectedProject
      : "";
    instructionProject.title = instructionProject.selectedOptions[0]?.textContent ?? "";
    consolidation = data.consolidation;
    consolidationInvalid = data.consolidationInvalid;
    commands = data.commands;
    preferenceItems = preferences.map((preference) => ({
      id: preference.id,
      title: plainText(preference.review.text),
      body: preferenceMarkdown(preference),
      preview: preference.review.text,
      domains: preference.domains,
      authoredAt: preference.lastAuthoredAt,
      searchText: [
        preference.text,
        preference.review.text,
        preference.review.scope,
        preference.review.status,
        ...preference.domains,
        ...preference.domains.flatMap(domainPath),
        ...preference.occurrences.flatMap((occurrence) => [
          occurrence.title,
          occurrence.slug,
          occurrence.evidence,
          occurrence.quote ?? "",
        ]),
      ]
        .join(" ")
        .toLocaleLowerCase(),
      preference,
    }));
    const reflection = !data.reviewsInvalid
      ? latestReflection(
          preferences,
          agreements && !agreements.stale ? agreements.lessons : [],
          projectGroups,
        )
      : undefined;
    reflectionItem = reflection
      ? {
          id: REFLECTION,
          title: plainText(reflection.preference.text),
          body: `# Your latest reflection\n\n${reflection.observation}`,
          domains: reflection.preference.domains,
          authoredAt: reflection.preference.lastAuthoredAt,
          searchText: [
            "reflection",
            reflection.observation,
            reflection.scope,
            ...reflection.preference.domains,
          ]
            .join(" ")
            .toLocaleLowerCase(),
          reflection,
        }
      : undefined;
    if (chooseDefault && !location.hash) {
      const hasPreferences = preferences.length > 0 || agreementItems.length > 0;
      const suggestion = hasPreferences ? undefined : await loadSubagents();
      tab =
        landingTab(location.hash, {
          preferences: hasPreferences,
          saved: Boolean(suggestion?.suggestion),
        }) ?? tab;
    }
    libraryLoaded = true;
    if (typeof data.commands?.gui === "string")
      rememberRestartCommand(keyStorage, data.commands.gui);
    syncControls();
    byId("skipped").hidden = !data.skipped;
    byId("skipped").textContent =
      `${countLabel(data.skipped, "prompt file")} could not be read. Run this for details: ${data.commands.status}`;
    render();
    return true;
  } catch (error) {
    byId("notice").replaceChildren(
      ...(error instanceof SessionError && error.refused
        ? recoveryNotice()
        : [
            textElement(
              "p",
              "Couldn't load the library. Check that npx human-hindsight gui is still running in your terminal, then choose Refresh.",
            ),
          ]),
    );
    byId("notice").hidden = false;
    if (!items().length) byId("count").textContent = "Library unavailable";
    return false;
  }
}
copy.addEventListener("click", async () => {
  const item = currentItem();
  if (!item || !canCopy(item)) return;
  const version = selectionVersion;
  copy.disabled = true;
  try {
    await navigator.clipboard.writeText(item.body);
    if (version !== selectionVersion) return;
    setIconButton(copy, "check", "Copied");
    byId("copy-status").textContent = "Markdown copied. Ready to paste.";
    copyTimer = setTimeout(() => {
      setIconButton(copy, "copy", copyLabel());
    }, 1800);
  } catch {
    if (version !== selectionVersion) return;
    setMode("source");
    source.focus({ preventScroll: true });
    source.select();
    byId("copy-status").textContent =
      `Markdown selected. Press ${/Mac/.test(navigator.platform) ? "⌘C" : "Ctrl+C"} to copy.`;
  } finally {
    if (version === selectionVersion) copy.disabled = !canCopy();
  }
});
/** How far the reader is scrolled: the panel on wide screens, the page on narrow ones. */
function readerScroll(): number {
  return matchMedia("(max-width: 760px)").matches ? window.scrollY : byId("viewer").scrollTop;
}
function restoreReaderScroll(top: number) {
  if (matchMedia("(max-width: 760px)").matches) window.scrollTo(0, top);
  else byId("viewer").scrollTop = top;
}
/**
 * Another tab opens where you left it: the same item, scrolled to the same
 * place. Choosing the tab you are on goes back to its overview.
 */
function switchTab(next: Tab) {
  if (next === tab && libraryLoaded && !states[next].selected && !subagentsFailed) return;
  rememberControls();
  Object.assign(states[tab], { viewerScroll: readerScroll(), listScroll: list.scrollTop });
  const place = placeOnSwitch(tab, next, states[next]);
  tab = next;
  Object.assign(states[tab], place);
  // Opening the tab again retries a failed read.
  if (next === "subagents" && subagentsFailed) subagentsFailed = false;
  syncControls();
  render("push");
  list.scrollTop = place.listScroll;
  restoreReaderScroll(place.viewerScroll);
}
for (const [index, key] of TABS.entries()) {
  // Activating a tab moves focus to its panel heading; arrow keys keep focus on the tabs.
  tabs[key].addEventListener("click", () => {
    switchTab(key);
    byId("title").focus({ preventScroll: true });
  });
  tabs[key].addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : TABS.length - 1;
    const next =
      (event.key === "Home"
        ? TABS[0]
        : event.key === "End"
          ? TABS.at(-1)
          : TABS[(index + step) % TABS.length]) ?? key;
    switchTab(next);
    tabs[next].focus();
  });
}
/**
 * The zip comes through the session API like every other request, so the key
 * stays in a header. The browser then saves it from a short-lived local URL.
 */
async function downloadExport() {
  const target = (exportTarget.value || "all") as SubagentTarget | "all";
  const generatedAt = subagents?.suggestion?.generated_at;
  if (!generatedAt) return;
  const status = exportStatus;
  exportAll.disabled = true;
  status.textContent = "Preparing the zip…";
  try {
    const response = await api.send(exportHref(target));
    if (!response.ok) throw new SessionError(response.status);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFilename(generatedAt, target);
    document.body.append(link);
    link.click();
    link.remove();
    // Give the browser time to start the download before the local URL goes away.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    status.textContent = `Downloaded ${link.download}.`;
  } catch (error) {
    status.textContent =
      error instanceof SessionError && error.refused
        ? refusalText()
        : "The zip could not be created. Check that the library is still running in your terminal.";
  } finally {
    exportAll.disabled = false;
  }
}
exportTarget.addEventListener("change", syncExportLink);
exportAll.addEventListener("click", () => void downloadExport());
syncExportLink();
function filterChanged() {
  rememberControls();
  if (!libraryLoaded) updateHash("replace");
  render("replace", true);
}
// Reads the library again in place, for example after a new run in the terminal.
byId("refresh").addEventListener("click", async () => {
  rememberControls();
  const routeBefore = location.hash;
  const scroll = { viewer: readerScroll(), list: list.scrollTop };
  const relatedOpen = byId<HTMLDetailsElement>("related").open;
  const draft = !byId("preference-editor").hidden
    ? {
        text: preferenceText.value,
        scope: preferenceScope.value,
        project: preferenceProject.value,
        revision: currentItem()?.preference?.review.revision,
      }
    : undefined;
  const status = byId("refresh-status");
  status.replaceChildren("Reading…");
  const read = await load();
  if (read && routeBefore === location.hash) {
    byId<HTMLDetailsElement>("related").open = relatedOpen;
    if (draft && currentItem()?.preference) {
      preferenceText.value = draft.text;
      preferenceScope.value = draft.scope;
      preferenceProject.value = draft.project;
      updateProjectField();
      byId("preference-editor").hidden = false;
      if (draft.revision !== currentItem()?.preference?.review.revision)
        byId("review-status").textContent =
          "The evidence changed. Check the sources before saving your edits.";
    }
    list.scrollTop = scroll.list;
    restoreReaderScroll(scroll.viewer);
  }
  // On a narrow screen only the time shows; the words stay for screen readers.
  status.replaceChildren(
    textElement(
      "span",
      read ? "Library read again at " : "Could not read the library ",
      "refresh-words",
    ),
    read
      ? new Date().toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        })
      : "(see below)",
  );
});
// The skip link moves focus to the open item's heading without touching the address.
byId("skip-link").addEventListener("click", (event) => {
  event.preventDefault();
  const title = byId("title");
  title.scrollIntoView({ block: "start" });
  title.focus({ preventScroll: true });
});
previewButton.addEventListener("click", () => setMode("preview"));
sourceButton.addEventListener("click", () => setMode("source"));
search.addEventListener("input", filterChanged);
sort.addEventListener("change", () => {
  rememberControls();
  render();
});
overviewButton.addEventListener("click", () => openItem(tab, "", true));
allPreferences.addEventListener("click", () => openItem("preferences", ALL, true));
acceptedPreferences.addEventListener("click", () => openItem("preferences", ACCEPTED, true));
savedPreferences.addEventListener("click", () => openItem("preferences", SAVED, true));
instructionProject.addEventListener("change", () => {
  instructionProject.title = instructionProject.selectedOptions[0]?.textContent ?? "";
  renderDetail();
});
const preferenceText = byId<HTMLTextAreaElement>("preference-text");
const preferenceScope = byId<HTMLSelectElement>("preference-scope");
const preferenceProject = byId<HTMLInputElement>("preference-project");
function updateProjectField() {
  byId("preference-project-field").hidden = preferenceScope.value !== "project";
  preferenceScope.title = preferenceScope.selectedOptions[0]?.textContent ?? "";
}
function editPreference() {
  const preference = currentItem()?.preference;
  if (!preference || reviewBusy) return;
  preferenceText.value = preference.review.text;
  preferenceScope.value = preference.review.scope;
  preferenceProject.value = preference.review.project ?? "";
  updateProjectField();
  byId("preference-editor").hidden = false;
  preferenceText.focus();
}
async function reviewPreference(status: GuiPreference["review"]["status"], edited = false) {
  const preference = currentItem()?.preference;
  if (!preference || reviewBusy || reviewsInvalid) return;
  const scope = edited ? preferenceScope.value : preference.review.scope;
  const project = edited ? preferenceProject.value.trim() : preference.review.project;
  const text = edited ? preferenceText.value.trim() : preference.review.text;
  if (status === "accepted" && (!text || (scope === "project" && !project))) {
    if (!edited) editPreference();
    byId("review-status").textContent = !text
      ? "Write the instruction before accepting it."
      : "Choose the project where this instruction applies.";
    return;
  }
  const editorOpen = !byId("preference-editor").hidden;
  reviewBusy = true;
  copy.disabled = true;
  for (const control of byId("preference-review").querySelectorAll<
    HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >("button, input, select, textarea")) {
    control.disabled = true;
  }
  byId("review-status").textContent = "Saving review…";
  let failure = "";
  try {
    const response = await api.send("/api/preferences/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: preference.id,
        revision: preference.review.revision,
        status,
        text,
        scope,
        ...(project ? { project } : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(response.status === 403 ? refusalText() : await response.text());
    }
    const snapshot = (await response.json()) as GuiSnapshot;
    reviewBusy = false;
    if (!(await load(snapshot))) {
      throw new Error("The review was saved. Choose Refresh to show its current state.");
    }
    if (currentItem()?.id === preference.id) {
      byId("review-status").textContent =
        status === "accepted"
          ? scope === "task"
            ? "Saved for this task."
            : "Saved to accepted instructions."
          : status === "dismissed"
            ? "Dismissed."
            : "Returned to review.";
    }
  } catch (error) {
    failure =
      error instanceof Error ? error.message : "Could not save the review. Please try again.";
  } finally {
    reviewBusy = false;
    for (const control of byId("preference-review").querySelectorAll<
      HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >("button, input, select, textarea")) {
      control.disabled = false;
    }
    if (currentItem()?.id === preference.id) {
      const statusText = byId("review-status").textContent;
      renderReview(currentItem());
      if (failure) byId("preference-editor").hidden = !editorOpen;
      byId("review-status").textContent = failure || statusText;
    }
    copy.disabled = !canCopy();
  }
}
byId("accept-preference").addEventListener("click", () => reviewPreference("accepted"));
byId("dismiss-preference").addEventListener("click", () => reviewPreference("dismissed"));
byId("reset-preference").addEventListener("click", () => reviewPreference("pending"));
byId("edit-preference").addEventListener("click", editPreference);
byId("save-preference").addEventListener("click", () => reviewPreference("accepted", true));
byId("cancel-preference").addEventListener("click", () => {
  byId("preference-editor").hidden = true;
  byId("edit-preference").focus();
});
preferenceScope.addEventListener("change", updateProjectField);
byId("clear").addEventListener("click", () => {
  search.value = "";
  states[tab].domain = "";
  syncDomainControls();
  filterChanged();
  search.focus();
});
window.addEventListener("resize", () => {
  if (mode === "source") setMode(mode);
});
function followLocation() {
  // Pasting the printed address into this tab changes only the fragment, so
  // the page stays loaded: take the key, and load the library if it had none.
  if (adoptKey()) {
    readRoute();
    void load();
    return;
  }
  if (location.hash === renderedHash) return;
  rememberControls();
  readRoute();
  states[tab].query = "";
  states[tab].domain = "";
  syncControls();
  render();
}
window.addEventListener("popstate", followLocation);
window.addEventListener("hashchange", followLocation);
document.addEventListener("keydown", (event) => {
  if (
    event.key === "/" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName ?? "")
  ) {
    event.preventDefault();
    search.focus();
  }
  if (event.key === "Escape" && document.activeElement === search) {
    search.value = "";
    filterChanged();
  }
  if (event.key === "Escape") {
    for (const details of document.querySelectorAll<HTMLDetailsElement>(
      ".entry-details[open], .domain-context-more[open]",
    )) {
      details.open = false;
      details.querySelector("summary")?.focus();
    }
  }
});
document.addEventListener("pointerdown", (event) => {
  for (const details of document.querySelectorAll<HTMLDetailsElement>(
    ".entry-details[open], .domain-context-more[open]",
  )) {
    if (event.target instanceof Node && !details.contains(event.target)) details.open = false;
  }
});
readRoute();
void load();
