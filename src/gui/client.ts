import { domainPath, matchesDomain } from "../core/domains.js";
import { createDomainPicker, renderDomainContext } from "./domains.js";
import { icon, setIconButton } from "./icons.js";
import { renderMarkdown } from "./markdown.js";
import type { GuiEntry, GuiPreference, GuiSnapshot } from "./server.js";
import { initTips } from "./tips.js";

type Tab = "prompts" | "preferences";
interface BrowseState {
  selected: string;
  query: string;
  domain: string;
  sort: string;
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
}

const ALL = "all";
const ACCEPTED = "accepted";
const SAVED = "consolidated";
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const search = byId<HTMLInputElement>("search");
const sort = byId<HTMLSelectElement>("sort");
const list = byId("list");
const copy = byId<HTMLButtonElement>("copy");
const allPreferences = byId<HTMLButtonElement>("all-preferences");
const acceptedPreferences = byId<HTMLButtonElement>("accepted-preferences");
const savedPreferences = byId<HTMLButtonElement>("saved-preferences");
const instructionProject = byId<HTMLSelectElement>("instruction-project");
const body = byId("body");
const source = byId<HTMLTextAreaElement>("source");
const previewButton = byId<HTMLButtonElement>("preview-mode");
const sourceButton = byId<HTMLButtonElement>("source-mode");
const tabs = {
  prompts: byId<HTMLButtonElement>("prompts-tab"),
  preferences: byId<HTMLButtonElement>("preferences-tab"),
};
const states: Record<Tab, BrowseState> = {
  prompts: { selected: "", query: "", domain: "", sort: "newest" },
  preferences: { selected: ALL, query: "", domain: "", sort: "frequency" },
};
let tab: Tab = "prompts";
let promptItems: BrowseItem[] = [];
let preferenceItems: BrowseItem[] = [];
let preferences: GuiPreference[] = [];
let preferencesMarkdown = "";
let acceptedMarkdown = "";
let projectInstructions: GuiSnapshot["projectInstructions"] = [];
let acceptedCount = 0;
let reviewToken = "";
let reviewsInvalid = false;
let reviewBusy = false;
let consolidation: GuiSnapshot["consolidation"] = null;
let consolidationInvalid = false;
let commands: GuiSnapshot["commands"] | null = null;
let mode: "preview" | "source" = "preview";
let copyTimer: ReturnType<typeof setTimeout> | undefined;
let selectionVersion = 0;
let renderedHash = "";
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
function taskCount(count: number) {
  return `${count} ${count === 1 ? "task" : "tasks"}`;
}
function items() {
  return tab === "prompts" ? promptItems : preferenceItems;
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
      title: "Preference candidates",
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
  return `#${nextTab}${id && !(nextTab === "preferences" && id === ALL) ? `/${encodeURIComponent(id)}` : ""}`;
}
function readRoute() {
  try {
    const hash = location.hash.slice(1);
    if (hash === "preferences" || hash.startsWith("preferences/")) {
      tab = "preferences";
      states.preferences.selected = decodeURIComponent(hash.slice("preferences/".length)) || ALL;
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
  render();
  byId("domain").focus({ preventScroll: true });
}
function syncControls() {
  const isPreferences = tab === "preferences";
  const noun = isPreferences ? "preferences" : "prompts";
  for (const key of ["prompts", "preferences"] as const) {
    tabs[key].setAttribute("aria-selected", String(tab === key));
    tabs[key].tabIndex = tab === key ? 0 : -1;
  }
  byId("browse-panel").setAttribute("aria-labelledby", `${tab}-tab`);
  byId("browser").setAttribute("aria-label", `Browse ${noun}`);
  byId("list").setAttribute("aria-label", isPreferences ? "Preferences" : "Prompts");
  byId("search-label").textContent = `Search ${noun}`;
  search.placeholder = isPreferences ? "Search preferences…" : "Search prompts…";
  search.value = states[tab].query;
  sort.setAttribute("aria-label", `Sort ${noun}`);
  const sorts = [
    ...(isPreferences ? [["frequency", "Frequent"]] : []),
    ["newest", "Newest"],
    ["title", "A–Z"],
  ];
  sort.replaceChildren(
    ...sorts.map(([value, label]) => {
      const option = textElement("option", label ?? "") as HTMLOptionElement;
      option.value = value ?? "";
      return option;
    }),
  );
  sort.value = states[tab].sort;
  syncDomainControls();
  allPreferences.hidden = !isPreferences;
  allPreferences.disabled = !preferences.length;
  allPreferences.textContent = "All";
  allPreferences.title = "View all candidates";
  acceptedPreferences.hidden = !isPreferences;
  acceptedPreferences.textContent = `Accepted · ${acceptedCount}`;
  acceptedPreferences.title = "Accepted instructions";
  savedPreferences.hidden = !isPreferences || !consolidation;
  savedPreferences.textContent = consolidation?.stale ? "Saved · outdated" : "Saved";
  savedPreferences.title = "Saved consolidation";
  byId("list-empty-text").textContent = `No matching ${noun}.`;
  byId("empty-title").textContent = isPreferences ? "No preferences yet" : "No prompts yet";
  byId("empty-text").textContent = isPreferences
    ? "Distill your sessions in the terminal, then reload this page to review preferences."
    : "Build your library in the terminal, then reload this page.";
  byId("empty-command").textContent = isPreferences ? "human-hindsight distill" : "human-hindsight";
  byId("viewer").setAttribute(
    "aria-label",
    isPreferences ? "Selected preference" : "Selected prompt",
  );
  byId("view-mode").setAttribute("aria-label", isPreferences ? "Preference view" : "Prompt view");
  body.setAttribute("aria-label", isPreferences ? "Rendered preference" : "Rendered prompt");
  document.title = `${isPreferences ? "Preferences" : "Prompts"} · Human Hindsight`;
}
function setMode(next: typeof mode) {
  mode = next;
  body.hidden = mode !== "preview";
  source.hidden = mode !== "source";
  previewButton.setAttribute("aria-pressed", String(mode === "preview"));
  sourceButton.setAttribute("aria-pressed", String(mode === "source"));
  if (mode === "source") {
    source.style.height = "0px";
    source.style.height = `${Math.max(260, source.scrollHeight + 2)}px`;
  }
}
function openItem(nextTab: Tab, id: string, clearFilters = false) {
  rememberControls();
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
        row.append(textElement("span", "Legacy result without per-rule source mapping.", "muted"));
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
        textElement("span", `Stated in ${taskCount(preference.count)}`, "muted"),
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
  return tab === "prompts"
    ? "Copy prompt"
    : states.preferences.selected === SAVED
      ? "Copy consolidated"
      : states.preferences.selected === ACCEPTED
        ? "Copy instructions"
        : states.preferences.selected === ALL
          ? "Review candidates first"
          : "Copy preference";
}
function canCopy(item = currentItem()) {
  if (!item?.body || reviewBusy) return false;
  if (item.preference) return item.preference.review.status === "accepted";
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
    review.stale ? "Evidence changed" : review.status,
    scope,
    reviewsInvalid ? "Reviews unavailable" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  byId("review-summary").title = [
    preference.verified
      ? `${preference.basis === "explicit" ? "Explicit instruction" : "Inferred preference"}. Open Source evidence to read the original quotation.`
      : "Legacy observation. Check its evidence before accepting.",
    reviewsInvalid ? "Saved reviews could not be read." : "",
  ].join(" ");
  const accept = byId<HTMLButtonElement>("accept-preference");
  accept.disabled = reviewBusy || reviewsInvalid || review.status === "accepted";
  setIconButton(
    accept,
    "check",
    review.status === "accepted" ? "Accepted preference" : "Accept preference",
  );
  byId<HTMLButtonElement>("dismiss-preference").disabled =
    reviewBusy || reviewsInvalid || review.status === "dismissed";
  byId<HTMLButtonElement>("edit-preference").disabled = reviewBusy || reviewsInvalid;
  const reset = byId<HTMLButtonElement>("reset-preference");
  reset.hidden = review.status === "pending" && !review.stale;
  reset.disabled = reviewBusy || reviewsInvalid;
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
function renderDetail() {
  selectionVersion++;
  const item = currentItem();
  clearTimeout(copyTimer);
  setIconButton(copy, "copy", copyLabel());
  copy.disabled = !canCopy(item);
  previewButton.disabled = sourceButton.disabled = !item;
  byId("copy-status").textContent = "";
  const metadata = byId("metadata");
  metadata.replaceChildren();
  byId("viewer").dataset.kind = item?.preference ? "preference" : "prompt";
  byId("title").textContent = item
    ? item.preference
      ? "Preference"
      : item.title
    : items().length
      ? `No matching ${tab}`
      : tab === "prompts"
        ? "Your prompt library"
        : "Your working preferences";
  source.value = item?.body ?? "";
  body.replaceChildren(
    item ? renderMarkdown(item.preview ?? item.body) : document.createDocumentFragment(),
  );
  setMode(mode);
  byId("empty").hidden = items().length !== 0 || Boolean(item);
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
      "The source preferences or their review status have changed. Review the current candidates and run consolidation again before copying this result as instructions.";
    consolidationNotice.hidden = false;
  } else if (item?.id === SAVED && !consolidation?.reviewed) {
    consolidationNotice.textContent =
      "This saved result has not been traced to accepted preferences. Review the candidates and run consolidation again to create an instruction block.";
    consolidationNotice.hidden = false;
  } else if (item?.id === ALL) {
    consolidationNotice.textContent =
      "Open a candidate to review it. Accepted preferences become your reusable instructions.";
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
        metadataDetails(more),
      );
      metadata.append(summary);
    } else if (item.preference) {
      const summary = textElement("div", "", "metadata-summary");
      summary.append(
        textElement(
          "span",
          `${item.preference.count} source${item.preference.count === 1 ? "" : "s"}`,
        ),
        metadataDetails([
          dateLabel(item.authoredAt),
          item.preference.verified
            ? item.preference.basis === "explicit"
              ? "Explicit instruction"
              : "Inferred preference"
            : "Legacy observation · unverified",
        ]),
      );
      metadata.append(summary);
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
        `${preferences.length} ${preferences.length === 1 ? "preference" : "preferences"}`,
        `${recurring} recurring`,
      );
    }
    if (details.length) metadata.append(textElement("span", details.filter(Boolean).join(" · ")));
  }
  renderReview(item);
  renderRelated(item);
  byId("viewer").scrollTop = 0;
}
function render(historyMode: "push" | "replace" = "replace") {
  const state = states[tab];
  sort.title = sort.selectedOptions[0]?.textContent || "";
  const terms = state.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const all = items();
  const visible = all.filter(
    (item) =>
      (!state.domain || item.domains.some((value) => matchesDomain(value, state.domain))) &&
      terms.every((term) => item.searchText.includes(term)),
  );
  visible.sort((a, b) => {
    if (state.sort === "title") return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
    return (
      (state.sort === "frequency" ? (b.preference?.count ?? 0) - (a.preference?.count ?? 0) : 0) ||
      b.authoredAt.localeCompare(a.authoredAt) ||
      a.id.localeCompare(b.id)
    );
  });
  const singular = tab === "prompts" ? "prompt" : "preference";
  byId("count").textContent =
    visible.length === all.length
      ? `${all.length} ${all.length === 1 ? singular : tab}`
      : `${visible.length} of ${all.length} ${tab}`;
  byId("list-empty").hidden = visible.length !== 0 || all.length === 0;
  const overview =
    tab === "preferences" &&
    preferences.length > 0 &&
    (!state.selected || state.selected === ALL) &&
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
  state.selected = accepted
    ? ACCEPTED
    : saved
      ? SAVED
      : overview
        ? ALL
        : visible.some((item) => item.id === state.selected)
          ? state.selected
          : visible[0]?.id || "";
  list.replaceChildren(
    ...visible.map((item) => {
      const button = textElement(
        "button",
        "",
        item.preference ? "entry preference-entry" : "entry",
      ) as HTMLButtonElement;
      button.type = "button";
      button.dataset.id = item.id;
      button.setAttribute("aria-current", String(item.id === state.selected));
      button.title = item.title;
      const meta = textElement("span", "", "entry-meta");
      if (item.preference) {
        const review = item.preference.review;
        const state = textElement("span", "", "entry-state");
        state.dataset.state = review.status;
        state.setAttribute("role", "img");
        state.setAttribute("aria-label", review.status);
        state.title = review.stale ? "Evidence changed" : review.status;
        meta.append(
          state,
          textElement(
            "span",
            review.scope === "global"
              ? "All projects"
              : review.scope === "project"
                ? review.project || "Project"
                : "This task",
            "entry-meta-label",
          ),
          textElement(
            "span",
            `${item.preference.count} source${item.preference.count === 1 ? "" : "s"}`,
            "entry-meta-tail",
          ),
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
              `${item.prompt.sessions} session${item.prompt.sessions === 1 ? "" : "s"}`,
              "entry-meta-tail",
            ),
          );
      }
      button.append(textElement("span", item.title, "entry-title"), meta);
      button.addEventListener("click", () => openItem(tab, item.id));
      return button;
    }),
  );
  renderDetail();
  const hash = route(tab, state.selected);
  if (location.hash !== hash) {
    if (historyMode === "push") history.pushState(null, "", hash);
    else history.replaceState(null, "", hash);
  }
  renderedHash = location.hash;
}
async function load(snapshot?: GuiSnapshot): Promise<boolean> {
  byId("notice").hidden = true;
  try {
    let data = snapshot;
    if (!data) {
      const response = await fetch("/api/library", { cache: "no-store" });
      if (!response.ok) throw new Error("Library unavailable");
      data = (await response.json()) as GuiSnapshot;
    }
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
    preferencesMarkdown = data.preferencesMarkdown;
    acceptedMarkdown = data.acceptedMarkdown;
    projectInstructions = data.projectInstructions;
    acceptedCount = data.acceptedCount;
    reviewToken = data.reviewToken;
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
      body: `- ${preference.review.text}`,
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
        ]),
      ]
        .join(" ")
        .toLocaleLowerCase(),
      preference,
    }));
    syncControls();
    tipsController.refresh();
    byId("skipped").hidden = !data.skipped;
    byId("skipped").textContent =
      `${data.skipped} prompt file(s) could not be read. Run human-hindsight status for details.`;
    render();
    return true;
  } catch {
    byId("notice").textContent =
      "Couldn't load the library. Check that the server is still running, then refresh.";
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
function switchTab(next: Tab) {
  if (next === tab) return;
  rememberControls();
  tab = next;
  syncControls();
  render("push");
}
for (const key of ["prompts", "preferences"] as const) {
  tabs[key].addEventListener("click", () => switchTab(key));
  tabs[key].addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? "prompts"
        : event.key === "End"
          ? "preferences"
          : key === "prompts"
            ? "preferences"
            : "prompts";
    switchTab(next);
    tabs[next].focus();
  });
}
function filterChanged() {
  rememberControls();
  render();
}
previewButton.addEventListener("click", () => setMode("preview"));
sourceButton.addEventListener("click", () => setMode("source"));
search.addEventListener("input", filterChanged);
sort.addEventListener("change", filterChanged);
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
    const response = await fetch("/api/preferences/review", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hindsight-Token": reviewToken,
      },
      body: JSON.stringify({
        id: preference.id,
        revision: preference.review.revision,
        status,
        text,
        scope,
        ...(project ? { project } : {}),
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    const snapshot = (await response.json()) as GuiSnapshot;
    reviewBusy = false;
    if (!(await load(snapshot))) {
      throw new Error("The review was saved. Refresh the library to display its current state.");
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
