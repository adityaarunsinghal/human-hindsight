import { renderMarkdown } from "./markdown.js";
import type { GuiEntry } from "./server.js";

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const search = byId<HTMLInputElement>("search");
const domain = byId<HTMLSelectElement>("domain");
const sort = byId<HTMLSelectElement>("sort");
const list = byId("list");
const copy = byId<HTMLButtonElement>("copy");
const refresh = byId<HTMLButtonElement>("refresh");
const body = byId("body");
const source = byId<HTMLTextAreaElement>("source");
const previewButton = byId<HTMLButtonElement>("preview-mode");
const sourceButton = byId<HTMLButtonElement>("source-mode");
let entries: (GuiEntry & { searchText: string })[] = [];
let selected = "";
let mode: "preview" | "source" = "preview";
let copyTimer: ReturnType<typeof setTimeout> | undefined;
try {
  selected = decodeURIComponent(location.hash.slice(1));
} catch {
  /* Ignore malformed bookmarks. */
}

function textElement(tag: string, text: string, className?: string) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}
function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
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
function selectEntry(slug: string) {
  selected = slug;
  for (const button of list.children)
    button.setAttribute("aria-current", String((button as HTMLElement).dataset.slug === slug));
  const entry = entries.find((item) => item.slug === slug);
  clearTimeout(copyTimer);
  copy.textContent = "Copy prompt";
  copy.disabled = !entry?.body;
  previewButton.disabled = sourceButton.disabled = !entry;
  byId("copy-status").textContent = "";
  byId("metadata").replaceChildren();
  byId("title").textContent = entry
    ? entry.title
    : entries.length
      ? "No matching prompts"
      : "Your prompt library";
  source.value = entry?.body ?? "";
  body.replaceChildren(entry ? renderMarkdown(entry.body) : document.createDocumentFragment());
  setMode(mode);
  byId("empty").hidden = entries.length !== 0;
  byId("word-count").textContent = entry
    ? `${entry.body.split(/\s+/).filter(Boolean).length} words`
    : "";
  if (!entry) return;
  for (const value of entry.domains) byId("metadata").append(textElement("span", value, "tag"));
  const details = [
    dateLabel(entry.authoredAt),
    `${entry.sessions} ${entry.sessions === 1 ? "session" : "sessions"}`,
    `${entry.confidence} confidence`,
  ];
  if (entry.edited) details.push("Edited");
  if (entry.rating === "up") details.push("Liked");
  if (entry.rating === "down") details.push("Disliked");
  byId("metadata").append(textElement("span", details.filter(Boolean).join(" · ")));
  history.replaceState(null, "", `#${encodeURIComponent(slug)}`);
  byId("viewer").scrollTop = 0;
}
function render() {
  domain.title = domain.value || "All domains";
  sort.title = sort.selectedOptions[0]?.textContent || "";
  const terms = search.value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const visible = entries.filter(
    (entry) =>
      (!domain.value || entry.domains.includes(domain.value)) &&
      terms.every((term) => entry.searchText.includes(term)),
  );
  visible.sort(
    sort.value === "title"
      ? (a, b) => a.title.localeCompare(b.title) || a.slug.localeCompare(b.slug)
      : (a, b) => b.authoredAt.localeCompare(a.authoredAt) || a.slug.localeCompare(b.slug),
  );
  byId("count").textContent =
    visible.length === entries.length
      ? `${entries.length} ${entries.length === 1 ? "prompt" : "prompts"}`
      : `${visible.length} of ${entries.length} prompts`;
  byId("list-empty").hidden = visible.length !== 0 || entries.length === 0;
  list.replaceChildren(
    ...visible.map((entry) => {
      const button = textElement("button", "", "entry") as HTMLButtonElement;
      button.type = "button";
      button.dataset.slug = entry.slug;
      button.append(
        textElement("span", entry.title, "entry-title"),
        textElement(
          "span",
          entry.body
            .replace(/^#{1,6}\s+/gm, "")
            .replace(/[*`~]/g, "")
            .replace(/\s+/g, " ")
            .slice(0, 140),
          "entry-preview",
        ),
        textElement(
          "span",
          [entry.domains.join(", "), dateLabel(entry.authoredAt)].filter(Boolean).join(" · "),
          "entry-meta",
        ),
      );
      button.addEventListener("click", () => selectEntry(entry.slug));
      return button;
    }),
  );
  selectEntry(visible.some((entry) => entry.slug === selected) ? selected : visible[0]?.slug || "");
}
async function load() {
  refresh.disabled = true;
  byId("notice").hidden = true;
  try {
    const response = await fetch("/api/library", { cache: "no-store" });
    if (!response.ok) throw new Error("Library unavailable");
    const data = (await response.json()) as { entries: GuiEntry[]; skipped: number };
    if (!Array.isArray(data.entries)) throw new Error("Invalid library response");
    entries = data.entries.map((entry) => ({
      ...entry,
      searchText: [entry.title, entry.slug, entry.body, ...entry.domains]
        .join(" ")
        .toLocaleLowerCase(),
    }));
    const previous = domain.value;
    const domains = [...new Set(entries.flatMap((entry) => entry.domains))].sort((a, b) =>
      a.localeCompare(b),
    );
    domain.replaceChildren(
      ...["", ...domains].map((value) => {
        const option = textElement("option", value || "All domains") as HTMLOptionElement;
        option.value = value;
        return option;
      }),
    );
    if (domains.includes(previous)) domain.value = previous;
    byId("skipped").hidden = !data.skipped;
    byId("skipped").textContent =
      `${data.skipped} prompt file(s) could not be read. Run human-hindsight status for details.`;
    render();
  } catch {
    byId("notice").textContent =
      "Couldn't load the library. Check that the server is still running, then refresh.";
    byId("notice").hidden = false;
    if (!entries.length) byId("count").textContent = "Library unavailable";
  } finally {
    refresh.disabled = false;
  }
}
copy.addEventListener("click", async () => {
  const entry = entries.find((item) => item.slug === selected);
  if (!entry?.body) return;
  copy.disabled = true;
  try {
    await navigator.clipboard.writeText(entry.body);
    if (selected !== entry.slug) return;
    copy.textContent = "Copied";
    byId("copy-status").textContent = "Markdown copied. Ready to paste.";
    copyTimer = setTimeout(() => {
      copy.textContent = "Copy prompt";
    }, 1800);
  } catch {
    if (selected !== entry.slug) return;
    setMode("source");
    source.focus({ preventScroll: true });
    source.select();
    byId("copy-status").textContent =
      `Markdown selected. Press ${/Mac/.test(navigator.platform) ? "⌘C" : "Ctrl+C"} to copy.`;
  } finally {
    copy.disabled = !entries.find((item) => item.slug === selected)?.body;
  }
});
previewButton.addEventListener("click", () => setMode("preview"));
sourceButton.addEventListener("click", () => setMode("source"));
search.addEventListener("input", render);
domain.addEventListener("change", render);
sort.addEventListener("change", render);
refresh.addEventListener("click", load);
byId("clear").addEventListener("click", () => {
  search.value = "";
  domain.value = "";
  render();
  search.focus();
});
window.addEventListener("resize", () => {
  if (mode === "source") setMode(mode);
});
window.addEventListener("hashchange", () => {
  try {
    selected = decodeURIComponent(location.hash.slice(1));
    render();
  } catch {
    /* Ignore malformed bookmarks. */
  }
});
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
    render();
  }
});
void load();
