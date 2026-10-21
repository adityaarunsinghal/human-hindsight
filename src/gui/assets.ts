/** Static assets ship inside the CLI bundle: no frontend build, CDN, or asset directory. */
export const GUI_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Prompt library · Human Hindsight</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="/app.css">
  <script src="/app.js" defer></script>
</head>
<body>
  <header class="topbar">
    <div class="brand">Human Hindsight <span> / Prompt library</span></div>
    <div class="top-actions"><span class="local">Local</span><button id="refresh" type="button">Refresh</button></div>
  </header>
  <main class="workspace">
    <aside class="sidebar" aria-label="Browse prompts">
      <div class="filters">
        <label for="search">Search prompts <kbd aria-hidden="true">/</kbd></label>
        <input id="search" type="search" placeholder="Title, text, or domain…" autocomplete="off" spellcheck="false">
        <div class="filter-row">
          <select id="domain" aria-label="Filter by domain"><option value="">All domains</option></select>
          <select id="sort" aria-label="Sort prompts"><option value="newest">Newest first</option><option value="title">Title A–Z</option></select>
        </div>
        <div id="count" class="muted" role="status">Loading library…</div>
      </div>
      <nav id="list" aria-label="Prompts"></nav>
      <div id="list-empty" class="list-empty" hidden>No matching prompts.<button id="clear" type="button">Clear filters</button></div>
    </aside>
    <section id="viewer" class="viewer" aria-label="Selected prompt">
      <div class="reader">
        <div class="reader-toolbar"><span id="word-count" class="muted"></span><button id="copy" class="primary" type="button" disabled>Copy prompt</button></div>
        <h1 id="title">Your prompt library</h1>
        <div id="metadata" class="metadata"></div>
        <p id="notice" class="notice" role="status" hidden></p>
        <div id="empty" class="empty" hidden>
          <h2>No prompts yet</h2>
          <p>Build your library in the terminal, then refresh this page.</p>
          <code>human-hindsight distill</code>
        </div>
        <pre id="body" tabindex="0" aria-label="Prompt text"></pre>
        <p id="copy-status" class="copy-status" role="status" aria-live="polite"></p>
        <p id="skipped" class="muted" hidden></p>
      </div>
    </section>
  </main>
  <noscript>This library viewer needs JavaScript enabled. You can also use human-hindsight list and show in your terminal.</noscript>
</body>
</html>`;

export const GUI_CSS = `
:root {
  color-scheme: light dark;
  --paper: #fff; --ink: #24312b; --muted: #718078; --line: #e2e8e3; --accent: #35644f; --soft: #f5f7f5;
  --chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='m1 1 5 5 5-5' fill='none' stroke='%23718078' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
}
* { box-sizing: border-box; }
body { margin: 0; color: var(--ink); background: var(--paper); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
button, input, select { font: inherit; }
button { cursor: pointer; color: var(--ink); background: var(--paper); border: 1px solid var(--line); border-radius: 7px; padding: 7px 12px; }
button:hover { background: var(--soft); }
button:disabled { opacity: .45; cursor: default; }
input:focus-visible, select:focus-visible, button:focus-visible, pre:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
[hidden] { display: none !important; }
.topbar { height: 65px; padding: 0 28px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); gap: 16px; }
.brand { font-weight: 650; letter-spacing: -.25px; }
.brand span { font-weight: 400; color: var(--muted); margin-left: 8px; }
.top-actions { display: flex; align-items: center; gap: 18px; }
.local { font-size: 12px; color: var(--muted); }
.local::before { content: ""; display: inline-block; width: 6px; height: 6px; background: #739d81; border-radius: 50%; margin-right: 7px; vertical-align: 1px; }
.workspace { display: grid; grid-template-columns: 330px minmax(0, 1fr); height: calc(100dvh - 65px); min-height: 300px; }
.sidebar { background: var(--soft); border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
.filters { padding: 24px 20px 14px; }
label { display: flex; align-items: center; justify-content: space-between; font-size: 12px; font-weight: 600; margin-bottom: 8px; }
kbd { color: var(--muted); font: 11px monospace; border: 1px solid var(--line); border-radius: 3px; padding: 0 5px; }
input { width: 100%; min-width: 0; padding: 10px 11px; color: var(--ink); border: 1px solid var(--line); border-radius: 7px; background: var(--paper); }
input::placeholder { color: #859087; }
.filter-row { display: flex; gap: 8px; margin: 10px 0 14px; }
select {
  appearance: none; -webkit-appearance: none;
  width: 50%; min-width: 0; border: 1px solid var(--line); border-radius: 6px; color: var(--ink);
  padding: 6px 36px 6px 9px; font-size: 12px; text-overflow: ellipsis; white-space: nowrap;
  background-color: var(--paper); background-image: var(--chevron);
  background-repeat: no-repeat; background-size: 12px 8px; background-position: right 12px center;
}
.muted { color: var(--muted); font-size: 12px; }
#list { overflow-y: auto; min-height: 0; padding: 0 10px 18px; }
.entry { width: 100%; display: block; text-align: left; padding: 15px 12px; border: 1px solid transparent; border-radius: 7px; background: transparent; margin-bottom: 3px; }
.entry:hover { background: #ebefeb; }
.entry[aria-current="true"] { background: var(--paper); border-color: #cbd9ce; box-shadow: 0 1px 3px #24312b06; }
.entry-title { display: block; font-size: 13px; font-weight: 600; margin-bottom: 5px; overflow-wrap: anywhere; }
.entry-preview { display: block; color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.entry-meta { display: block; color: var(--muted); font-size: 11px; margin-top: 8px; }
.list-empty { color: var(--muted); text-align: center; padding: 32px 16px; font-size: 13px; }
.list-empty button { display: block; margin: 12px auto; font-size: 12px; }
.viewer { overflow-y: auto; min-width: 0; }
.reader { max-width: 850px; margin: 0 auto; padding: 32px 48px 64px; }
.reader-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 32px; min-height: 35px; }
.primary { background: var(--accent); border-color: var(--accent); color: white; font-weight: 500; padding: 8px 15px; }
.primary:hover:not(:disabled) { background: #2b5341; }
h1 { font-size: 27px; line-height: 1.3; font-weight: 600; letter-spacing: -.7px; margin: 0 0 12px; overflow-wrap: anywhere; }
.metadata { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; font-size: 12px; color: var(--muted); margin-bottom: 28px; }
.tag { max-width: 100%; overflow-wrap: anywhere; background: var(--soft); border: 1px solid var(--line); border-radius: 4px; padding: 2px 7px; color: var(--muted); }
#body { font: inherit; font-size: 15px; line-height: 1.85; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; tab-size: 2; }
.copy-status { min-height: 20px; margin: 24px 0 0; color: var(--accent); font-size: 12px; }
.notice { color: #8b532d; background: #fff8f0; padding: 12px 15px; border-radius: 6px; }
.empty { margin-top: 64px; color: var(--muted); }
.empty h2 { font-size: 19px; font-weight: 500; color: var(--ink); margin-bottom: 8px; }
.empty code { display: inline-block; font-size: 13px; padding: 9px 12px; background: var(--soft); border: 1px solid var(--line); border-radius: 5px; margin-top: 8px; color: var(--ink); }
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #191f1b; --ink: #e0e8e2; --muted: #9caea2; --line: #354238; --accent: #9ac3a9; --soft: #222b25;
    --chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='m1 1 5 5 5-5' fill='none' stroke='%239caea2' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  }
  .entry:hover { background: #2b382f; }
  .entry[aria-current="true"] { border-color: #5e7966; }
  .primary { color: #182a1e; }
  .primary:hover:not(:disabled) { background: #b5d7c1; }
  .notice { color: #e3bd88; background: #392f24; }
}
@media (max-width: 760px) {
  .topbar { height: 57px; padding: 0 16px; }
  .brand span { display: none; }
  .top-actions { gap: 12px; }
  .workspace { height: auto; min-height: calc(100dvh - 57px); grid-template-columns: 1fr; }
  .sidebar { border-right: 0; border-bottom: 1px solid var(--line); }
  .filters { padding: 18px 16px 8px; }
  #list { max-height: 230px; padding: 0 8px 8px; }
  .entry { padding: 11px 10px; }
  .entry-preview { display: none; }
  .entry-meta { margin-top: 4px; }
  .reader { padding: 24px 22px 48px; }
  .reader-toolbar { margin-bottom: 24px; }
  h1 { font-size: 24px; }
  .viewer { overflow-y: visible; }
}
@media (max-width: 420px) {
  .filter-row { flex-direction: column; }
  select { width: 100%; }
}
`;

export const GUI_JS = String.raw`
"use strict";
const byId = (id) => document.getElementById(id);
const search = byId("search");
const domain = byId("domain");
const sort = byId("sort");
const list = byId("list");
const copy = byId("copy");
const refresh = byId("refresh");
const body = byId("body");
let entries = [];
let selected = "";
let copyTimer;
try { selected = decodeURIComponent(location.hash.slice(1)); } catch { /* Ignore a malformed bookmark. */ }

function textElement(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}
function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function selectEntry(slug) {
  selected = slug;
  for (const button of list.children) button.setAttribute("aria-current", String(button.dataset.slug === slug));
  const entry = entries.find((item) => item.slug === slug);
  clearTimeout(copyTimer);
  copy.textContent = "Copy prompt";
  copy.disabled = !entry || !entry.body;
  byId("copy-status").textContent = "";
  byId("metadata").replaceChildren();
  byId("title").textContent = entry ? entry.title : entries.length ? "No matching prompts" : "Your prompt library";
  body.textContent = entry ? entry.body : "";
  byId("empty").hidden = entries.length !== 0;
  byId("word-count").textContent = entry ? entry.body.split(/\s+/).filter(Boolean).length + " words" : "";
  if (!entry) return;
  for (const value of entry.domains) byId("metadata").append(textElement("span", value, "tag"));
  const details = [
    dateLabel(entry.authoredAt),
    entry.sessions + (entry.sessions === 1 ? " session" : " sessions"),
    entry.confidence + " confidence",
  ];
  if (entry.edited) details.push("Edited");
  if (entry.rating === "up") details.push("Liked");
  if (entry.rating === "down") details.push("Disliked");
  byId("metadata").append(textElement("span", details.filter(Boolean).join(" · ")));
  history.replaceState(null, "", "#" + encodeURIComponent(slug));
  byId("viewer").scrollTop = 0;
}
function render() {
  domain.title = domain.value || "All domains";
  sort.title = sort.selectedOptions[0]?.textContent || "";
  const terms = search.value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const visible = entries.filter((entry) =>
    (!domain.value || entry.domains.includes(domain.value)) && terms.every((term) => entry.searchText.includes(term))
  );
  visible.sort(sort.value === "title"
    ? (a, b) => a.title.localeCompare(b.title) || a.slug.localeCompare(b.slug)
    : (a, b) => b.authoredAt.localeCompare(a.authoredAt) || a.slug.localeCompare(b.slug));
  byId("count").textContent = visible.length === entries.length
    ? entries.length + (entries.length === 1 ? " prompt" : " prompts")
    : visible.length + " of " + entries.length + " prompts";
  byId("list-empty").hidden = visible.length !== 0 || entries.length === 0;
  const buttons = visible.map((entry) => {
    const button = textElement("button", "", "entry");
    button.type = "button";
    button.dataset.slug = entry.slug;
    button.append(
      textElement("span", entry.title, "entry-title"),
      textElement("span", entry.body.replace(/\s+/g, " ").slice(0, 140), "entry-preview"),
      textElement("span", [entry.domains.join(", "), dateLabel(entry.authoredAt)].filter(Boolean).join(" · "), "entry-meta")
    );
    button.addEventListener("click", () => selectEntry(entry.slug));
    return button;
  });
  list.replaceChildren(...buttons);
  selectEntry(visible.some((entry) => entry.slug === selected) ? selected : visible[0]?.slug || "");
}
async function load() {
  refresh.disabled = true;
  byId("notice").hidden = true;
  try {
    const response = await fetch("/api/library", { cache: "no-store" });
    if (!response.ok) throw new Error("Library unavailable");
    const data = await response.json();
    if (!Array.isArray(data.entries)) throw new Error("Invalid library response");
    entries = data.entries.map((entry) => ({
      ...entry,
      searchText: [entry.title, entry.slug, entry.body, ...entry.domains].join(" ").toLocaleLowerCase(),
    }));
    const previousDomain = domain.value;
    const domains = [...new Set(entries.flatMap((entry) => entry.domains))].sort((a, b) => a.localeCompare(b));
    domain.replaceChildren();
    for (const value of ["", ...domains]) {
      const option = textElement("option", value || "All domains");
      option.value = value;
      domain.append(option);
    }
    if (domains.includes(previousDomain)) domain.value = previousDomain;
    byId("skipped").hidden = !data.skipped;
    byId("skipped").textContent = data.skipped + " prompt file(s) could not be read. Run human-hindsight status for details.";
    render();
  } catch {
    byId("notice").textContent = "Couldn't load the library. Check that the server is still running, then refresh.";
    byId("notice").hidden = false;
    if (!entries.length) byId("count").textContent = "Library unavailable";
  } finally {
    refresh.disabled = false;
  }
}
copy.addEventListener("click", async () => {
  const entry = entries.find((item) => item.slug === selected);
  if (!entry || !entry.body) return;
  copy.disabled = true;
  try {
    await navigator.clipboard.writeText(entry.body);
    if (selected !== entry.slug) return;
    copy.textContent = "Copied";
    byId("copy-status").textContent = "Prompt copied. Ready to paste into a fresh session.";
    copyTimer = setTimeout(() => { copy.textContent = "Copy prompt"; }, 1800);
  } catch {
    if (selected !== entry.slug) return;
    body.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(body);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    byId("copy-status").textContent = "Prompt selected. Press " + (/Mac/.test(navigator.platform) ? "⌘C" : "Ctrl+C") + " to copy.";
  } finally {
    copy.disabled = !entries.find((item) => item.slug === selected)?.body;
  }
});
search.addEventListener("input", render);
domain.addEventListener("change", render);
sort.addEventListener("change", render);
refresh.addEventListener("click", load);
byId("clear").addEventListener("click", () => { search.value = ""; domain.value = ""; render(); search.focus(); });
window.addEventListener("hashchange", () => {
  try { selected = decodeURIComponent(location.hash.slice(1)); render(); } catch { /* Ignore malformed bookmarks. */ }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey &&
      !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    search.focus();
  }
  if (event.key === "Escape" && document.activeElement === search) { search.value = ""; render(); }
});
load();
`;
