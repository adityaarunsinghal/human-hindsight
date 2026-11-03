/** Static assets ship inside the CLI bundle: no frontend build, CDN, or asset directory. */
export const GUI_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Library · Human Hindsight</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="/app.css">
  <script src="/app.js" defer></script>
</head>
<body>
  <header class="topbar">
    <div class="brand">Human Hindsight <span> / Library</span></div>
    <div class="top-actions"><span class="local">Local</span><button id="show-tips" type="button" aria-controls="tips" hidden>Show tips</button><button id="refresh" type="button">Refresh</button></div>
  </header>
  <aside id="tips" class="tips" aria-label="Quick tips" hidden>
    <div class="tip-content">
      <div class="tip-heading"><span id="tip-number" class="muted"></span><strong id="tip-title"></strong><span id="tip-cost" class="tag" hidden></span></div>
      <p id="tip-text"></p>
      <div id="tip-command-row" class="tip-command-row" hidden><code id="tip-command" tabindex="0"></code><button id="copy-tip" type="button">Copy command</button></div>
      <span id="tip-status" class="muted" role="status"></span>
    </div>
    <div class="tip-controls">
      <button id="previous-tip" type="button" aria-label="Previous tip">←</button>
      <button id="next-tip" type="button" aria-label="Next tip">→</button>
      <button id="pause-tips" type="button" aria-pressed="false">Pause</button>
      <button id="hide-tips" type="button">Hide</button>
    </div>
  </aside>
  <main class="workspace">
    <aside id="browser" class="sidebar" aria-label="Browse prompts">
      <div class="library-tabs" role="tablist" aria-label="Library">
        <button id="prompts-tab" type="button" role="tab" aria-selected="true" aria-controls="browse-panel">Prompts</button>
        <button id="preferences-tab" type="button" role="tab" aria-selected="false" aria-controls="browse-panel" tabindex="-1">Preferences</button>
      </div>
      <div id="browse-panel" class="browse-panel" role="tabpanel" aria-labelledby="prompts-tab">
      <div class="filters">
        <label for="search"><span id="search-label">Search prompts</span> <kbd aria-hidden="true">/</kbd></label>
        <input id="search" type="search" placeholder="Title, text, or domain…" autocomplete="off" spellcheck="false">
        <div class="filter-row">
          <select id="domain" aria-label="Filter by domain"><option value="">All domains</option></select>
          <select id="sort" aria-label="Sort prompts"><option value="newest">Newest first</option><option value="title">Title A–Z</option></select>
        </div>
        <div id="domain-children" class="domain-children"></div>
        <div id="count" class="muted" role="status">Loading library…</div>
        <button id="all-preferences" class="all-preferences" type="button" aria-current="false" hidden disabled>View all preferences</button>
        <button id="saved-preferences" class="all-preferences" type="button" aria-current="false" hidden>Saved consolidation</button>
      </div>
      <nav id="list" aria-label="Prompts"></nav>
      <div id="list-empty" class="list-empty" hidden><span id="list-empty-text">No matching prompts.</span><button id="clear" type="button">Clear filters</button></div>
      </div>
    </aside>
    <section id="viewer" class="viewer" aria-label="Selected prompt">
      <div class="reader">
        <div class="reader-toolbar">
          <div id="view-mode" class="view-mode" role="group" aria-label="Prompt view">
            <button id="preview-mode" type="button" aria-pressed="true">Preview</button>
            <button id="source-mode" type="button" aria-pressed="false">Markdown</button>
          </div>
          <span id="word-count" class="muted"></span>
          <button id="copy" class="primary" type="button" disabled>Copy prompt</button>
        </div>
        <h1 id="title" tabindex="-1">Your prompt library</h1>
        <div id="metadata" class="metadata"></div>
        <p id="consolidation-notice" class="notice" hidden></p>
        <p id="notice" class="notice" role="status" hidden></p>
        <div id="empty" class="empty" hidden>
          <h2 id="empty-title">No prompts yet</h2>
          <p id="empty-text">Build your library in the terminal, then refresh this page.</p>
          <code id="empty-command">human-hindsight</code>
        </div>
        <article id="body" class="markdown" tabindex="0" aria-label="Rendered prompt"></article>
        <textarea id="source" aria-label="Original Markdown" readonly spellcheck="false" hidden></textarea>
        <p id="copy-status" class="copy-status" role="status" aria-live="polite"></p>
        <section id="related" class="related" aria-labelledby="related-title" hidden>
          <h2 id="related-title"></h2>
          <ul id="related-list"></ul>
        </section>
        <p id="skipped" class="muted" hidden></p>
      </div>
    </section>
  </main>
  <noscript>This library viewer needs JavaScript enabled. You can also use human-hindsight list, show, and preferences in your terminal.</noscript>
</body>
</html>`;

export const GUI_CSS = `
:root {
  color-scheme: light dark;
  --paper: #fff; --ink: #111; --muted: #666; --line: #dedede; --accent: #111; --soft: #f7f7f7;
  --mono: ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='m1 1 5 5 5-5' fill='none' stroke='%23666666' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
}
* { box-sizing: border-box; }
body { display: flex; flex-direction: column; height: 100dvh; margin: 0; color: var(--ink); background: var(--paper); font: 13px/1.6 var(--mono); font-variant-ligatures: none; -webkit-font-smoothing: antialiased; }
::selection { color: var(--paper); background: var(--ink); }
button, input, select { font: inherit; }
button { cursor: pointer; color: var(--ink); background: var(--paper); border: 1px solid var(--line); border-radius: 2px; padding: 7px 12px; }
button:hover { background: var(--soft); }
button:disabled { opacity: .45; cursor: default; }
input:focus-visible, select:focus-visible, button:focus-visible, article:focus-visible, textarea:focus-visible, pre:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
[hidden] { display: none !important; }
.topbar { height: 57px; flex-shrink: 0; padding: 0 24px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); gap: 16px; }
.brand { font-weight: 650; letter-spacing: -.35px; white-space: nowrap; }
.brand span { font-weight: 400; color: var(--muted); margin-left: 8px; }
.top-actions { display: flex; align-items: center; gap: 18px; }
.local { font-size: 12px; color: var(--muted); }
.local::before { content: ""; display: inline-block; width: 5px; height: 5px; background: var(--ink); margin-right: 7px; vertical-align: 1px; }
.tips { display: flex; flex-shrink: 0; gap: 16px 24px; padding: 14px 24px; border-bottom: 1px solid var(--line); background: var(--soft); }
.tip-content { flex: 1; min-width: 0; }
.tip-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
.tip-heading strong { font-size: 12px; }
.tip-heading .tag { font-size: 10px; }
.tip-content p { margin: 6px 0; color: var(--muted); font-size: 12px; }
.tip-content a { color: inherit; text-underline-offset: 3px; }
.tip-command-row { display: flex; align-items: center; gap: 12px; }
.tip-command-row code { min-width: 0; overflow-wrap: anywhere; font-size: 11px; }
.tip-command-row button { flex-shrink: 0; font-size: 11px; }
.tip-controls { display: flex; align-items: flex-start; gap: 6px; }
.tip-controls button { padding: 5px 8px; font-size: 11px; }
#tip-status:empty { display: none; }
.workspace { display: grid; grid-template-columns: 310px minmax(0, 1fr); flex: 1; min-height: 0; }
.sidebar { background: var(--soft); border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.library-tabs { display: flex; gap: 4px; padding: 16px 20px 0; }
.library-tabs button { flex: 1; min-width: 0; padding: 8px 6px; background: transparent; border-color: transparent; font-size: 12px; }
.library-tabs button[aria-selected="true"] { background: var(--paper); border-color: var(--line); font-weight: 600; }
.browse-panel { display: flex; flex-direction: column; min-height: 0; }
.filters { padding: 18px 20px 14px; }
.all-preferences { width: 100%; margin-top: 12px; text-align: left; font-size: 12px; }
.all-preferences[aria-current="true"] { border-color: var(--ink); font-weight: 600; }
label { display: flex; align-items: center; justify-content: space-between; font-size: 11px; font-weight: 500; margin-bottom: 8px; text-transform: uppercase; letter-spacing: .06em; }
kbd { color: var(--muted); font: 11px monospace; border: 1px solid var(--line); border-radius: 3px; padding: 0 5px; }
input { width: 100%; min-width: 0; padding: 10px 11px; color: var(--ink); border: 1px solid var(--line); border-radius: 2px; background: var(--paper); }
input::placeholder { color: var(--muted); }
.filter-row { display: flex; gap: 8px; margin: 10px 0 14px; }
select {
  appearance: none; -webkit-appearance: none;
  width: 50%; min-width: 0; border: 1px solid var(--line); border-radius: 2px; color: var(--ink);
  padding: 6px 36px 6px 9px; font-size: 11px; text-overflow: ellipsis; white-space: nowrap;
  background-color: var(--paper); background-image: var(--chevron);
  background-repeat: no-repeat; background-size: 12px 8px; background-position: right 12px center;
}
.domain-level { margin-bottom: 10px; }
.domain-level label { margin-bottom: 5px; font-size: 10px; }
.domain-level select { width: 100%; }
.muted { color: var(--muted); font-size: 12px; }
#list { overflow-y: auto; min-height: 0; padding: 0 10px 18px; }
.entry { width: 100%; display: block; text-align: left; padding: 15px 12px; border: 0; border-left: 2px solid transparent; border-radius: 0; background: transparent; margin-bottom: 2px; }
.entry:hover { background: var(--paper); }
.entry[aria-current="true"] { background: var(--paper); border-left-color: var(--ink); }
.entry-title { display: block; font-size: 13px; font-weight: 600; margin-bottom: 5px; overflow-wrap: anywhere; }
.preference-entry .entry-title { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.entry-preview { display: block; color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.entry-meta { display: block; color: var(--muted); font-size: 11px; margin-top: 8px; overflow-wrap: anywhere; }
.list-empty { color: var(--muted); text-align: center; padding: 32px 16px; font-size: 13px; }
.list-empty button { display: block; margin: 12px auto; font-size: 12px; }
.viewer { overflow-y: auto; min-width: 0; }
.reader { max-width: 900px; margin: 0 auto; padding: 28px 44px 64px; }
.reader-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 32px; min-height: 35px; }
.view-mode { display: inline-flex; gap: 0; }
.view-mode button { font-size: 11px; padding: 6px 9px; border-radius: 0; }
.view-mode button + button { border-left: 0; }
.view-mode button[aria-pressed="true"] { color: var(--paper); background: var(--ink); border-color: var(--ink); }
#word-count { flex: 1; text-align: right; font-size: 11px; white-space: nowrap; }
.primary { margin-left: auto; background: var(--ink); border-color: var(--ink); color: var(--paper); font-weight: 500; padding: 8px 12px; white-space: nowrap; font-size: 12px; }
.primary:hover:not(:disabled) { color: var(--ink); background: var(--paper); }
h1 { font-size: 23px; line-height: 1.4; font-weight: 600; letter-spacing: -.7px; margin: 0 0 12px; overflow-wrap: anywhere; }
.metadata { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; font-size: 12px; color: var(--muted); margin-bottom: 28px; }
.tag { max-width: 100%; overflow-wrap: anywhere; background: var(--soft); border: 1px solid var(--line); border-radius: 1px; padding: 2px 6px; color: var(--muted); }
#body { font: inherit; font-size: 14px; line-height: 1.8; overflow-wrap: anywhere; margin: 0; tab-size: 2; }
#source { display: block; width: 100%; min-height: 260px; resize: vertical; border: 1px solid var(--line); border-radius: 0; padding: 16px; color: var(--ink); background: var(--soft); font: 13px/1.8 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 2; }
.markdown > :first-child { margin-top: 0; }
.markdown p, .markdown ul, .markdown ol, .markdown blockquote, .markdown pre, .markdown table { margin: 0 0 1.3em; }
.markdown h1, .markdown h2, .markdown h3, .markdown h4, .markdown h5, .markdown h6 { font: 600 1.05em/1.5 var(--mono); letter-spacing: -.3px; margin: 1.8em 0 .75em; scroll-margin-top: 24px; }
.markdown h1 { font-size: 1.35em; }
.markdown h2 { font-size: 1.18em; border-bottom: 1px solid var(--line); padding-bottom: .4em; }
.markdown ul, .markdown ol { padding-left: 1.8em; }
.markdown li { padding-left: .25em; margin: .35em 0; }
.markdown li > ul, .markdown li > ol { margin: .35em 0; }
.markdown blockquote { border-left: 2px solid var(--ink); padding: .1em 0 .1em 1.2em; color: var(--muted); }
.markdown blockquote > :last-child { margin-bottom: 0; }
.markdown code { font: .93em var(--mono); background: var(--soft); padding: .12em .3em; border: 1px solid var(--line); }
.markdown pre { position: relative; background: var(--soft); border: 1px solid var(--line); padding: 16px; overflow-x: auto; white-space: pre; max-width: 100%; font: 12px/1.7 var(--mono); }
.markdown pre code { font: inherit; border: 0; padding: 0; background: transparent; }
.markdown pre[data-language]::before { content: attr(data-language); display: block; margin-bottom: 12px; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
.markdown a, .markdown a:visited { color: inherit; text-underline-offset: 3px; }
.markdown a[href]:hover { background: var(--soft); }
.markdown table { display: block; border-collapse: collapse; overflow-x: auto; max-width: 100%; font-size: 12px; }
.markdown th, .markdown td { border: 1px solid var(--line); padding: 8px 12px; text-align: left; }
.markdown th { font-weight: 600; background: var(--soft); }
.markdown td[align="right"], .markdown th[align="right"] { text-align: right; }
.markdown td[align="center"], .markdown th[align="center"] { text-align: center; }
.markdown input[type="checkbox"] { width: 13px; height: 13px; margin: 0 .5em 0 0; accent-color: var(--ink); }
.markdown hr { border: 0; border-top: 1px solid var(--line); margin: 2em 0; }
.attachment { color: var(--muted); }
.copy-status { min-height: 20px; margin: 24px 0 0; color: var(--accent); font-size: 12px; }
.related { margin-top: 32px; padding-top: 22px; border-top: 1px solid var(--line); }
.related h2 { margin: 0 0 16px; font-size: 13px; font-weight: 600; }
.related ul { list-style: none; padding: 0; margin: 0; }
.related li { margin-bottom: 20px; overflow-wrap: anywhere; }
.related a { color: var(--ink); text-underline-offset: 3px; }
.related a:hover { background: var(--soft); }
.related .muted { display: block; margin-top: 4px; font-size: 11px; }
.evidence { margin-top: 8px; padding-left: 12px; border-left: 2px solid var(--line); color: var(--muted); font-size: 12px; }
.evidence > :last-child { margin-bottom: 0; }
.notice { color: var(--ink); background: var(--soft); border: 1px solid var(--line); padding: 12px 15px; }
.empty { margin-top: 64px; color: var(--muted); }
.empty h2 { font-size: 19px; font-weight: 500; color: var(--ink); margin-bottom: 8px; }
.empty code { display: inline-block; font-size: 13px; padding: 9px 12px; background: var(--soft); border: 1px solid var(--line); border-radius: 5px; margin-top: 8px; color: var(--ink); }
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #0d0d0d; --ink: #eee; --muted: #aaa; --line: #333; --accent: #eee; --soft: #171717;
    --chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='m1 1 5 5 5-5' fill='none' stroke='%23aaaaaa' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  }
}
@media (max-width: 760px) {
  body { height: auto; min-height: 100dvh; }
  .topbar { height: 57px; padding: 0 16px; }
  .brand span { display: none; }
  .top-actions { gap: 12px; }
  .tips { flex-wrap: wrap; padding: 12px 16px; gap: 10px; }
  .tip-content { flex-basis: 100%; }
  .tip-command-row { align-items: flex-start; }
  .workspace { grid-template-columns: 1fr; }
  .sidebar { border-right: 0; border-bottom: 1px solid var(--line); }
  .library-tabs { padding: 12px 16px 0; }
  .filters { padding: 14px 16px 8px; }
  #list { max-height: 230px; padding: 0 8px 8px; }
  .entry { padding: 11px 10px; }
  .entry-preview { display: none; }
  .entry-meta { margin-top: 4px; }
  .reader { padding: 24px 22px 48px; }
  .reader-toolbar { margin-bottom: 24px; }
  h1 { font-size: 21px; }
  .viewer { overflow-y: visible; }
}
@media (max-width: 420px) {
  .local { display: none; }
  .filter-row { flex-direction: column; }
  select { width: 100%; }
  #word-count { display: none; }
}
`;

export { GUI_JS } from "./client.generated.js";
