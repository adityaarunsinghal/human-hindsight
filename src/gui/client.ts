import { PRIVACY_REMINDER, PUBLIC_REPOSITORY_URL } from "../core/privacy.js";
import { renderMarkdown } from "./markdown.js";
import type { GuiEntry, GuiPreference, GuiSnapshot } from "./server.js";

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
const domain = byId<HTMLSelectElement>("domain");
const domainSelects = [domain];
for (let level = 2; level <= MAX_DOMAIN_DEPTH; level++) {
  const field = document.createElement("div");
  field.className = "domain-level";
  field.hidden = true;
  const label = document.createElement("label");
  label.htmlFor = `domain-${level}`;
  label.textContent = `Subdomain · level ${level}`;
  const select = document.createElement("select");
  select.id = label.htmlFor;
  select.setAttribute("aria-label", `Filter by subdomain level ${level}`);
  field.append(label, select);
  byId("domain-children").append(field);
  domainSelects.push(select);
}
const sort = byId<HTMLSelectElement>("sort");
const list = byId("list");
const copy = byId<HTMLButtonElement>("copy");
const refresh = byId<HTMLButtonElement>("refresh");
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
    domain: domainSelects.findLast((select) => select.value)?.value ?? "",
    sort: sort.value,
  });
}
function syncDomainControls() {
  const paths = items().flatMap((item) => item.domains.map(domainPath));
  const selected = states[tab].domain.split(" > ").filter(Boolean);
  let parent: string[] = [];
  for (const [level, select] of domainSelects.entries()) {
    const children = [
      ...new Map(
        paths
          .filter((path) =>
            parent.every((part, index) => path[index]?.toLowerCase() === part.toLowerCase()),
          )
          .map((path) => path[level])
          .filter((part): part is string => Boolean(part))
          .map((part) => [part.toLowerCase(), part]),
      ).values(),
    ].sort((a, b) => a.localeCompare(b));
    const visible = level === 0 || (parent.length === level && children.length > 0);
    if (level > 0 && select.parentElement) select.parentElement.hidden = !visible;
    select.replaceChildren(
      ...["", ...(visible ? children : [])].map((part) => {
        const option = textElement(
          "option",
          part || (level ? "All subdomains" : "All domains"),
        ) as HTMLOptionElement;
        option.value = part ? [...parent, part].join(" > ") : "";
        return option;
      }),
    );
    const part = children.find((value) => value.toLowerCase() === selected[level]?.toLowerCase());
    if (visible && part && parent.length === level) {
      parent = [...parent, part];
      select.value = parent.join(" > ");
    } else {
      select.value = "";
    }
    select.title = select.selectedOptions[0]?.textContent ?? "";
  }
  states[tab].domain = parent.join(" > ");
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
  search.placeholder = isPreferences ? "Text, evidence, or domain…" : "Title, text, or domain…";
  search.value = states[tab].query;
  sort.setAttribute("aria-label", `Sort ${noun}`);
  const sorts = [
    ...(isPreferences ? [["frequency", "Most frequent first"]] : []),
    ["newest", "Newest first"],
    ["title", isPreferences ? "Text A–Z" : "Title A–Z"],
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
  allPreferences.textContent = "View all candidates";
  acceptedPreferences.hidden = !isPreferences;
  acceptedPreferences.textContent = `Accepted instructions · ${acceptedCount}`;
  savedPreferences.hidden = !isPreferences || !consolidation;
  savedPreferences.textContent = consolidation?.stale
    ? "Saved consolidation · outdated"
    : "Saved consolidation";
  byId("list-empty-text").textContent = `No matching ${noun}.`;
  byId("empty-title").textContent = isPreferences ? "No preferences yet" : "No prompts yet";
  byId("empty-text").textContent = isPreferences
    ? "Preferences appear when distilled tasks include your working preferences. Distill more tasks in the terminal, then refresh."
    : "Build your library in the terminal, then refresh this page.";
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
  const related = byId("related");
  const relatedList = byId("related-list");
  relatedList.replaceChildren();
  if (item?.id === SAVED && consolidation) {
    byId("related-title").textContent = "Evidence for each consolidated instruction";
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
    byId("related-title").textContent = "Preferences from this prompt";
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
    byId("related-title").textContent = "Source evidence";
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
      ? "Every project"
      : review.scope === "project"
        ? `Project: ${review.project || "choose a project"}`
        : "This task only";
  byId("review-summary").textContent = [
    review.stale ? "Evidence changed; review again." : `${review.status}.`,
    `${scope}.`,
    preference.verified
      ? `${preference.basis === "explicit" ? "Explicit instruction" : "Inferred preference"}; original quotation below.`
      : "Legacy observation; check its evidence before accepting.",
    reviewsInvalid ? "Saved reviews could not be read." : "",
  ].join(" ");
  const accept = byId<HTMLButtonElement>("accept-preference");
  accept.disabled = reviewBusy || reviewsInvalid || review.status === "accepted";
  accept.textContent = review.status === "accepted" ? "Accepted" : "Accept";
  byId<HTMLButtonElement>("dismiss-preference").disabled =
    reviewBusy || reviewsInvalid || review.status === "dismissed";
  byId<HTMLButtonElement>("edit-preference").disabled = reviewBusy || reviewsInvalid;
  const reset = byId<HTMLButtonElement>("reset-preference");
  reset.hidden = review.status === "pending" && !review.stale;
  reset.disabled = reviewBusy || reviewsInvalid;
}
function renderDetail() {
  selectionVersion++;
  const item = currentItem();
  clearTimeout(copyTimer);
  copy.textContent = copyLabel();
  copy.disabled = !canCopy(item);
  previewButton.disabled = sourceButton.disabled = !item;
  byId("copy-status").textContent = "";
  const metadata = byId("metadata");
  metadata.replaceChildren();
  byId("title").textContent = item
    ? item.preference
      ? item.preference.review.status === "accepted"
        ? "Accepted preference"
        : "Preference candidate"
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
      "These are suggestions from your history. Open a candidate to check the evidence, choose its scope, and accept, edit, or dismiss it. Accepted instructions are available as a separate block.";
    consolidationNotice.hidden = false;
  }
  if (item) {
    for (const value of item.domains) metadata.append(textElement("span", value, "tag"));
    const details: string[] = [];
    if (item.prompt) {
      const prompt = item.prompt;
      details.push(
        dateLabel(item.authoredAt),
        `${prompt.sessions} ${prompt.sessions === 1 ? "session" : "sessions"}`,
        `${prompt.confidence} confidence`,
      );
      if (prompt.edited) details.push("Edited");
      if (prompt.rating === "up") details.push("Liked");
      if (prompt.rating === "down") details.push("Disliked");
    } else if (item.preference) {
      details.push(
        `${item.preference.count} source${item.preference.count === 1 ? "" : "s"}`,
        dateLabel(item.authoredAt),
      );
    } else if (item.id === ACCEPTED) {
      details.push(
        instructionProject.value ? `Project: ${instructionProject.value}` : "Global preferences",
        "Only accepted instructions",
      );
    } else if (item.id === SAVED && consolidation) {
      details.push(
        `${consolidation.texts.length} consolidated preferences`,
        dateLabel(consolidation.generatedAt),
        `From ${consolidation.sourcePreferenceIds.length} observed preferences`,
      );
    } else {
      const recurring = preferences.filter((preference) => preference.count > 1).length;
      details.push(
        `${preferences.length} ${preferences.length === 1 ? "preference" : "preferences"}`,
        `${recurring} recurring`,
        "Review before adding to CLAUDE.md or AGENTS.md",
      );
    }
    metadata.append(textElement("span", details.filter(Boolean).join(" · ")));
  }
  renderReview(item);
  renderRelated(item);
  byId("viewer").scrollTop = 0;
}
function render(historyMode: "push" | "replace" = "replace") {
  const state = states[tab];
  domain.title = domain.value || "All domains";
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
      const details = [
        ...(item.preference
          ? [
              item.preference.review.status,
              item.preference.review.scope,
              `${item.preference.count} source${item.preference.count === 1 ? "" : "s"}`,
            ]
          : []),
        item.domains.join(", "),
        dateLabel(item.authoredAt),
      ];
      button.append(
        textElement("span", item.title, "entry-title"),
        textElement(
          "span",
          plainText(item.preference?.occurrences[0]?.evidence ?? item.body).slice(0, 140),
          "entry-preview",
        ),
        textElement("span", details.filter(Boolean).join(" · "), "entry-meta"),
      );
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
  refresh.disabled = true;
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
    renderTip();
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
  } finally {
    refresh.disabled = false;
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
    copy.textContent = "Copied";
    byId("copy-status").textContent = "Markdown copied. Ready to paste.";
    copyTimer = setTimeout(() => {
      copy.textContent = copyLabel();
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
for (const [level, select] of domainSelects.entries()) {
  select.addEventListener("change", () => {
    states[tab].domain = select.value || domainSelects[level - 1]?.value || "";
    syncDomainControls();
    rememberControls();
    render();
  });
}
sort.addEventListener("change", filterChanged);
refresh.addEventListener("click", () => load());
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
            ? "Accepted for this task. It will stay out of standing instruction blocks."
            : "Accepted. Open Accepted instructions to copy the reviewed block."
          : status === "dismissed"
            ? "Dismissed. This candidate will stay out of instruction blocks."
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
});
interface Tip {
  title: string;
  text: string;
  cost?: string;
  command?: string;
  repository?: boolean;
}
const tips = byId("tips");
const showTips = byId<HTMLButtonElement>("show-tips");
const copyTip = byId<HTMLButtonElement>("copy-tip");
let tipIndex = 0;
let tipVersion = 0;
let tipsPaused = false;
let tipsEnabled = true;
try {
  tipsEnabled = localStorage.getItem("human-hindsight-tips") !== "hidden";
} catch {
  /* Tips still work when browser storage is unavailable. */
}
function availableTips(): Tip[] {
  return [
    {
      title: "Open source, with your history under your control",
      text: PRIVACY_REMINDER,
      cost: "Local-first",
      repository: true,
    },
    {
      title: "Carry your preferences into the next session",
      text: "Review candidates in Preferences, then copy Accepted instructions into CLAUDE.md or AGENTS.md.",
      cost: "No model call",
      command: commands?.preferences,
    },
    {
      title: "Optionally consolidate overlapping preferences",
      text: "One model call merges similar wording and saves the result in this library. The terminal asks before running. Refresh here afterward.",
      cost: "Optional · uses subscription/credits",
      command: commands?.consolidate,
    },
    {
      title: "Export your latest history",
      text: "Refresh the local session exports before distilling new prompts.",
      cost: "No model call",
      command: commands?.export,
    },
    {
      title: "Build more prompts and preferences",
      text: "Distill your exports using a local agent CLI. Review the terminal's cost and consent prompt before proceeding.",
      cost: "Uses subscription/credits",
      command: commands?.distill,
    },
    {
      title: "Check what is ready and what needs attention",
      text: "See pipeline progress, skipped files, and the next suggested step.",
      cost: "No model call",
      command: commands?.status,
    },
    {
      title: "Follow a preference back to its evidence",
      text: "Open a preference to check its original quotation and scope before accepting it. Legacy observations are labeled for review.",
    },
    {
      title: "The Markdown you see is the Markdown you copy",
      text: "Switch between Preview and Markdown at any time. Copy preserves the source, including lists and code.",
    },
    {
      title: "Start broad, then narrow your domain",
      text: "Choose a domain to include all its children. Optional subdomain filters let you refine the results up to five levels deep.",
    },
    {
      title: "Search without reaching for the mouse",
      text: "Press / to focus search and Escape to clear it. Each tab remembers its own search, domain, and sort.",
    },
  ];
}
function renderTip() {
  const choices = availableTips();
  const tip = choices[tipIndex % choices.length];
  if (!tip) return;
  tipVersion++;
  tips.hidden = !tipsEnabled;
  showTips.hidden = tipsEnabled;
  byId("tip-number").textContent = `Tip ${tipIndex + 1}/${choices.length}`;
  byId("tip-title").textContent = tip.title;
  if (tip.repository) {
    const [before, after] = tip.text.split("fully open source");
    const link = textElement("a", "fully open source") as HTMLAnchorElement;
    link.href = PUBLIC_REPOSITORY_URL;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    byId("tip-text").replaceChildren(
      document.createTextNode(before ?? ""),
      link,
      document.createTextNode(after ?? ""),
    );
  } else byId("tip-text").textContent = tip.text;
  byId("tip-cost").textContent = tip.cost ?? "";
  byId("tip-cost").hidden = !tip.cost;
  byId("tip-command-row").hidden = !tip.command;
  byId("tip-command").textContent = tip.command ?? "";
  byId("tip-status").textContent = "";
  copyTip.textContent = "Copy command";
  copyTip.disabled = !tip.command;
}
function stepTip(step: number) {
  tipIndex = (tipIndex + step + availableTips().length) % availableTips().length;
  renderTip();
}
function setTipsEnabled(enabled: boolean) {
  tipsEnabled = enabled;
  try {
    localStorage.setItem("human-hindsight-tips", enabled ? "visible" : "hidden");
  } catch {
    /* Hiding tips does not depend on browser storage. */
  }
  renderTip();
  (enabled ? byId("hide-tips") : showTips).focus();
}
byId("previous-tip").addEventListener("click", () => stepTip(-1));
byId("next-tip").addEventListener("click", () => stepTip(1));
byId("hide-tips").addEventListener("click", () => setTipsEnabled(false));
showTips.addEventListener("click", () => setTipsEnabled(true));
byId("pause-tips").addEventListener("click", () => {
  tipsPaused = !tipsPaused;
  byId("pause-tips").textContent = tipsPaused ? "Resume" : "Pause";
  byId("pause-tips").setAttribute("aria-pressed", String(tipsPaused));
});
copyTip.addEventListener("click", async () => {
  const command = availableTips()[tipIndex]?.command;
  if (!command) return;
  const version = tipVersion;
  copyTip.disabled = true;
  try {
    await navigator.clipboard.writeText(command);
    if (version !== tipVersion) return;
    copyTip.textContent = "Copied";
    byId("tip-status").textContent = "Command copied. Run it in your terminal when ready.";
  } catch {
    if (version !== tipVersion) return;
    const code = byId("tip-command");
    code.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    byId("tip-status").textContent =
      `Command selected. Press ${/Mac/.test(navigator.platform) ? "⌘C" : "Ctrl+C"} to copy.`;
  } finally {
    if (version === tipVersion) copyTip.disabled = false;
  }
});
setInterval(() => {
  if (
    tipsEnabled &&
    !tipsPaused &&
    document.visibilityState === "visible" &&
    !tips.matches(":hover") &&
    !tips.contains(document.activeElement)
  ) {
    const choices = availableTips()
      .map((_, index) => index)
      .filter((index) => index !== 0 && index !== tipIndex);
    tipIndex = choices[Math.floor(Math.random() * choices.length)] ?? 0;
    renderTip();
  }
}, 14_000);

readRoute();
void load();

import { domainPath, MAX_DOMAIN_DEPTH, matchesDomain } from "../core/domains.js";
