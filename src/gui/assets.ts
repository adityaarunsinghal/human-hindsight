import { iconMarkup } from "./icons.js";

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
    <div class="top-tips">
      <aside id="tips" class="tips" aria-label="Quick tips" hidden>
        <div class="tip-strip">
          <button id="tip-toggle" class="tip-toggle" type="button" aria-expanded="false" aria-controls="tip-details">
            ${iconMarkup("bulb")}
            <span id="tip-face" class="tip-face"><span id="tip-title"></span><span id="tip-number" class="tip-number"></span></span>
            <span class="tip-chevron">${iconMarkup("chevron-down")}</span>
          </button>
          <button id="next-tip" class="icon-button" type="button" aria-label="Next tip" title="Next tip">${iconMarkup("arrow-right")}</button>
        </div>
        <div id="tip-details" class="tip-details" hidden>
          <p id="tip-text"></p>
          <div id="tip-command-row" class="tip-command-row" hidden>
            <code id="tip-command" tabindex="0"></code>
            <button id="copy-tip" class="icon-button" type="button" aria-label="Copy command" title="Copy command">${iconMarkup("copy")}</button>
          </div>
          <div class="tip-footer">
            <span id="tip-cost" class="muted" hidden></span>
            <div class="tip-controls">
              <button id="previous-tip" class="icon-button" type="button" aria-label="Previous tip" title="Previous tip">${iconMarkup("arrow-left")}</button>
              <button id="pause-tips" class="icon-button" type="button" aria-label="Pause tips" title="Pause tips" aria-pressed="false">${iconMarkup("pause")}</button>
              <button id="hide-tips" class="icon-button" type="button" aria-label="Hide tips" title="Hide tips">${iconMarkup("close")}</button>
            </div>
          </div>
          <span id="tip-status" class="muted" role="status"></span>
        </div>
      </aside>
      <button id="show-tips" class="icon-button" type="button" aria-label="Show tips" title="Show tips" aria-controls="tips" hidden>${iconMarkup("bulb")}</button>
    </div>
  </header>
  <main class="workspace">
    <aside id="browser" class="sidebar" aria-label="Browse prompts">
      <div class="library-tabs" role="tablist" aria-label="Library">
        <button id="prompts-tab" type="button" role="tab" aria-selected="true" aria-controls="browse-panel">Prompts</button>
        <button id="preferences-tab" type="button" role="tab" aria-selected="false" aria-controls="browse-panel" tabindex="-1">Preferences</button>
      </div>
      <div id="browse-panel" class="browse-panel" role="tabpanel" aria-labelledby="prompts-tab">
      <div class="filters">
        <label for="search" class="sr-only"><span id="search-label">Search prompts</span></label>
        <div class="search-wrap">
          <input id="search" type="search" placeholder="Search prompts…" autocomplete="off" spellcheck="false">
          <kbd aria-hidden="true">/</kbd>
        </div>
        <div class="filter-row">
          <div id="domain-picker" class="domain-picker">
            <button id="domain" class="domain-trigger" type="button" aria-label="Filter by domain" aria-expanded="false" aria-controls="domain-menu"><span id="domain-label">All domains</span></button>
            <div id="domain-menu" class="domain-menu" hidden></div>
          </div>
          <select id="sort" aria-label="Sort prompts"><option value="newest">Newest first</option><option value="title">Title A–Z</option></select>
        </div>
        <div id="count" class="muted" role="status">Loading library…</div>
        <div class="preference-views">
          <button id="all-preferences" type="button" aria-current="false" hidden disabled>All</button>
          <button id="accepted-preferences" type="button" aria-current="false" hidden>Accepted</button>
          <button id="saved-preferences" type="button" aria-current="false" hidden>Saved</button>
        </div>
      </div>
      <nav id="list" aria-label="Prompts"></nav>
      <div id="list-empty" class="list-empty" hidden><span id="list-empty-text">No matching prompts.</span><button id="clear" type="button">Clear filters</button></div>
      </div>
    </aside>
    <section id="viewer" class="viewer" aria-label="Selected prompt">
      <div class="reader">
        <div class="reader-toolbar">
          <div id="view-mode" class="view-mode" role="group" aria-label="Prompt view">
            <button id="preview-mode" class="icon-button" type="button" aria-label="Preview" title="Preview" aria-pressed="true">${iconMarkup("eye")}</button>
            <button id="source-mode" class="icon-button" type="button" aria-label="Markdown" title="Markdown" aria-pressed="false">${iconMarkup("code")}</button>
          </div>
          <span id="word-count" class="muted"></span>
          <button id="copy" class="icon-button primary" type="button" aria-label="Copy prompt" title="Copy prompt" disabled>${iconMarkup("copy")}</button>
        </div>
        <h1 id="title" tabindex="-1">Your prompt library</h1>
        <div id="metadata" class="metadata"></div>
        <p id="consolidation-notice" class="notice" hidden></p>
        <p id="notice" class="notice" role="status" hidden></p>
        <section id="instruction-settings" class="review-settings" aria-label="Instruction scope" hidden>
          <label for="instruction-project">Instructions for</label>
          <select id="instruction-project"><option value="">Global preferences only</option></select>
          <p class="muted">Includes accepted global preferences.</p>
        </section>
        <div id="empty" class="empty" hidden>
          <h2 id="empty-title">No prompts yet</h2>
          <p id="empty-text">Build your library in the terminal, then reload this page.</p>
          <code id="empty-command">human-hindsight</code>
        </div>
        <article id="body" class="markdown" tabindex="0" aria-label="Rendered prompt"></article>
        <textarea id="source" aria-label="Original Markdown" readonly spellcheck="false" hidden></textarea>
        <section id="preference-review" class="preference-review" aria-label="Review preference" hidden>
          <div class="review-bar">
            <p id="review-summary" class="muted"></p>
            <div class="review-actions">
              <button id="accept-preference" class="icon-button" type="button" aria-label="Accept preference" title="Accept preference">${iconMarkup("check")}</button>
              <button id="edit-preference" class="icon-button" type="button" aria-label="Edit wording or scope" title="Edit wording or scope">${iconMarkup("edit")}</button>
              <button id="dismiss-preference" class="icon-button" type="button" aria-label="Dismiss preference" title="Dismiss preference">${iconMarkup("close")}</button>
              <button id="reset-preference" class="icon-button" type="button" aria-label="Review again" title="Review again" hidden>${iconMarkup("undo")}</button>
            </div>
          </div>
          <div id="preference-editor" hidden>
            <label for="preference-text">Instruction wording</label>
            <textarea id="preference-text" maxlength="8000" spellcheck="true"></textarea>
            <label for="preference-scope">Where it applies</label>
            <select id="preference-scope">
              <option value="global">Every project</option>
              <option value="project">One project</option>
              <option value="task">This task only</option>
            </select>
            <div id="preference-project-field" hidden>
              <label for="preference-project">Project</label>
              <input id="preference-project" type="text" maxlength="2000" autocomplete="off">
            </div>
            <div class="review-actions">
              <button id="save-preference" type="button">Save and accept</button>
              <button id="cancel-preference" type="button">Cancel</button>
            </div>
          </div>
          <p id="review-status" role="status" aria-live="polite"></p>
        </section>
        <p id="copy-status" class="copy-status" role="status" aria-live="polite"></p>
        <details id="related" class="related" hidden>
          <summary><span id="related-title"></span><span id="related-count" class="muted"></span></summary>
          <ul id="related-list"></ul>
        </details>
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
button:hover { background-color: var(--soft); }
button:disabled { opacity: .45; cursor: default; }
input:focus-visible, select:focus-visible, button:focus-visible, article:focus-visible, textarea:focus-visible, pre:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
[hidden] { display: none !important; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.icon { display: block; width: 18px; height: 18px; flex: none; }
.icon-button { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 34px; height: 34px; padding: 0; border-color: transparent; border-radius: 5px; background: transparent; color: var(--muted); }
.icon-button:hover { color: var(--ink); background: var(--soft); }
.topbar { height: 53px; flex-shrink: 0; padding: 0 24px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); gap: 32px; position: relative; z-index: 4; }
.brand { font-weight: 650; letter-spacing: -.35px; white-space: nowrap; }
.brand span { font-weight: 400; color: var(--muted); margin-left: 8px; }
.top-tips { display: flex; justify-content: flex-end; flex: 1; min-width: 0; max-width: 480px; }
.tips { position: relative; width: 100%; min-width: 0; }
.tip-strip { display: flex; align-items: center; height: 34px; background: var(--soft); border-radius: 6px; }
.tip-toggle { display: flex; flex: 1; align-items: center; gap: 9px; min-width: 0; height: 34px; padding: 0 9px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); text-align: left; overflow: hidden; perspective: 500px; }
.tip-toggle > .icon { width: 15px; height: 15px; }
.tip-face { display: flex; align-items: center; flex: 1; min-width: 0; gap: 12px; transform-origin: center center; }
#tip-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.tip-number { flex: none; font-size: 10px; opacity: .65; }
.tip-chevron .icon { width: 12px; height: 12px; }
.tip-toggle[aria-expanded="true"] .tip-chevron { transform: rotate(180deg); }
.tip-details { position: absolute; top: 42px; right: 0; width: min(430px, calc(100vw - 32px)); padding: 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); box-shadow: 0 10px 32px #00000012; }
.tip-details p { margin: 0 0 12px; font-size: 12px; }
.tip-details a { color: inherit; text-underline-offset: 3px; }
.tip-command-row { display: flex; align-items: flex-start; gap: 8px; padding: 8px; border-radius: 4px; background: var(--soft); }
.tip-command-row code { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 11px; padding: 5px 0; }
.tip-footer { display: flex; justify-content: space-between; gap: 8px; align-items: center; margin-top: 10px; }
.tip-footer .muted { font-size: 10px; }
.tip-controls { display: flex; align-items: center; margin-left: auto; gap: 2px; }
#tip-status:empty { display: none; }
.workspace { display: grid; grid-template-columns: 300px minmax(0, 1fr); flex: 1; min-height: 0; }
.sidebar { background: var(--soft); border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.library-tabs { display: flex; gap: 4px; padding: 12px 16px 0; }
.library-tabs button { flex: 1; min-width: 0; padding: 8px 6px; background: transparent; border-color: transparent; font-size: 12px; }
.library-tabs button[aria-selected="true"] { background: var(--paper); border-color: var(--line); font-weight: 600; }
.browse-panel { display: flex; flex-direction: column; min-height: 0; }
.filters { padding: 12px 16px 8px; }
.preference-views { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.preference-views:has(> :not([hidden])) { margin-bottom: 4px; }
.preference-views button { padding: 4px 7px; color: var(--muted); background: transparent; border-color: transparent; font-size: 11px; border-radius: 4px; }
.preference-views button[aria-current="true"] { background: var(--paper); border-color: var(--line); color: var(--ink); }
label { display: flex; align-items: center; justify-content: space-between; font-size: 11px; font-weight: 500; margin-bottom: 8px; text-transform: uppercase; letter-spacing: .06em; }
kbd { color: var(--muted); font: 11px monospace; border: 1px solid var(--line); border-radius: 3px; padding: 0 5px; }
input { width: 100%; min-width: 0; padding: 8px 10px; color: var(--ink); border: 1px solid var(--line); border-radius: 4px; background: var(--paper); }
input::placeholder { color: var(--muted); }
.search-wrap { position: relative; }
.search-wrap input { padding-right: 34px; font-size: 12px; }
.search-wrap kbd { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); pointer-events: none; }
.filter-row { display: flex; gap: 6px; margin: 8px 0; }
select, .domain-trigger {
  appearance: none; -webkit-appearance: none;
  width: 100%; min-width: 0; border: 1px solid var(--line); border-radius: 4px; color: var(--ink);
  padding: 6px 36px 6px 9px; font-size: 11px; text-overflow: ellipsis; white-space: nowrap;
  background-color: var(--paper); background-image: var(--chevron);
  background-repeat: no-repeat; background-size: 12px 8px; background-position: right 12px center;
}
#sort { flex: 0 0 112px; width: 112px; }
.domain-picker { position: relative; flex: 1; min-width: 0; }
.domain-trigger { display: block; text-align: left; overflow: hidden; }
.domain-trigger:hover { background-color: var(--soft); }
.domain-menu { position: absolute; z-index: 3; top: calc(100% + 6px); left: 0; width: 360px; max-width: calc(100vw - 32px); max-height: min(480px, 65vh); overflow: auto; padding: 7px; border: 1px solid var(--line); border-radius: 6px; background: var(--paper); box-shadow: 0 8px 28px #00000018; }
.domain-tree, .domain-children { list-style: none; padding: 0; margin: 0; }
.domain-children { margin-left: 12px; padding-left: 4px; border-left: 1px solid var(--line); }
.domain-row { display: flex; align-items: flex-start; min-width: 0; }
.domain-toggle, .domain-gutter { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 24px; width: 24px; height: 30px; padding: 0; border: 0; background: transparent; color: var(--muted); }
.domain-toggle .icon { width: 12px; height: 12px; }
.domain-select, .domain-all { flex: 1; min-width: 0; padding: 5px 7px; border: 0; border-radius: 3px; background: transparent; text-align: left; font-size: 11px; overflow-wrap: anywhere; }
.domain-all { width: 100%; margin-bottom: 4px; }
.domain-select[aria-current="true"], .domain-all[aria-current="true"] { background: var(--soft); font-weight: 600; }
.domain-context { display: flex; align-items: baseline; flex-wrap: wrap; min-width: 0; gap: 4px 10px; }
.domain-breadcrumb { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 5px; min-width: 0; }
.domain-breadcrumb button { flex: 0 1 auto; padding: 2px 0; border: 0; background: transparent; color: var(--muted); font-size: 11px; text-align: left; overflow-wrap: anywhere; }
.domain-breadcrumb button:hover { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
.domain-separator { width: 10px; height: 10px; align-self: center; color: var(--muted); opacity: .5; }
.domain-context-more { position: static; }
.domain-context-summary { display: flex; align-items: center; gap: 4px; cursor: pointer; list-style: none; color: var(--muted); font-size: 11px; white-space: nowrap; }
.domain-context-summary::-webkit-details-marker { display: none; }
.domain-context-summary .icon { width: 12px; height: 12px; }
.domain-context-more[open] > summary .domain-chevron { transform: rotate(90deg); }
.domain-context-tree { position: absolute; top: calc(100% + 8px); left: 0; z-index: 2; width: 340px; max-width: 100%; max-height: 380px; overflow: auto; padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--paper); box-shadow: 0 8px 28px #00000012; }
.muted { color: var(--muted); font-size: 12px; }
#count { font-size: 10px; }
#list { overflow-y: auto; min-height: 0; padding: 0 8px 14px; }
.entry { width: 100%; display: block; text-align: left; padding: 10px 10px; border: 0; border-left: 2px solid transparent; border-radius: 0; background: transparent; margin-bottom: 2px; }
.entry:hover { background: var(--paper); }
.entry[aria-current="true"] { background: var(--paper); border-left-color: var(--ink); }
.entry-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 12px; font-weight: 550; line-height: 1.55; overflow-wrap: anywhere; }
.entry-meta { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--muted); font-size: 10px; line-height: 1.6; margin-top: 4px; white-space: nowrap; }
.entry-meta-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.entry-meta-tail { flex: none; margin-left: auto; opacity: .8; }
.entry-state { flex: none; width: 6px; height: 6px; border-radius: 50%; border: 1px solid currentColor; }
.entry-state[data-state="accepted"] { background: currentColor; }
.entry-state[data-state="dismissed"] { border-radius: 0; height: 1px; }
.list-empty { color: var(--muted); text-align: center; padding: 32px 16px; font-size: 13px; }
.list-empty button { display: block; margin: 12px auto; font-size: 12px; }
.viewer { overflow-y: auto; min-width: 0; }
.reader { max-width: 940px; margin: 0 auto; padding: 22px 40px 48px; }
.reader-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; min-height: 34px; }
.view-mode { display: inline-flex; gap: 2px; }
.view-mode button[aria-pressed="true"] { color: var(--ink); background: var(--soft); }
#word-count { flex: 1; text-align: right; font-size: 11px; white-space: nowrap; }
.primary { margin-left: auto; background: var(--ink); border-color: var(--ink); color: var(--paper); }
.primary:hover:not(:disabled) { color: var(--ink); background: var(--paper); }
h1 { font-size: 23px; line-height: 1.4; font-weight: 600; letter-spacing: -.7px; margin: 0 0 12px; overflow-wrap: anywhere; }
.metadata { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; font-size: 11px; color: var(--muted); margin-bottom: 24px; position: relative; }
.metadata-summary { display: flex; align-items: center; gap: 6px; }
.entry-details { position: static; }
.entry-details > summary { cursor: pointer; list-style: none; padding: 4px; }
.entry-details > summary::-webkit-details-marker { display: none; }
.entry-details > summary .icon { width: 14px; height: 14px; }
.entry-details-panel { position: absolute; z-index: 2; top: 100%; right: 0; min-width: 200px; max-width: 100%; padding: 12px; background: var(--paper); border: 1px solid var(--line); border-radius: 5px; box-shadow: 0 8px 28px #00000012; }
.entry-details-panel p { margin: 0 0 4px; }
.entry-details-panel p:last-child { margin: 0; }
.viewer[data-kind="preference"] h1 { font-size: 15px; letter-spacing: -.3px; margin-bottom: 5px; }
#body { font: inherit; font-size: 14px; line-height: 1.8; overflow-wrap: anywhere; margin: 0; tab-size: 2; }
#source { display: block; width: 100%; min-height: 260px; resize: vertical; border: 1px solid var(--line); border-radius: 0; padding: 16px; color: var(--ink); background: var(--soft); font: 13px/1.8 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 2; }
.preference-review { margin: 16px 0 0; }
.review-bar { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 4px 12px; padding: 8px 0; }
#review-summary { margin: 0; font-size: 11px; }
.review-actions { display: flex; gap: 4px; align-items: center; }
.review-actions button { font-size: 11px; }
.review-settings { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin: 0 0 22px; }
.review-settings label { margin: 0; }
.review-settings p { flex-basis: 100%; font-size: 11px; margin: 0; }
.review-settings select { max-width: 300px; }
.review-settings select, #preference-scope { width: 100%; }
#preference-editor { margin-top: 10px; padding: 16px; border: 1px solid var(--line); border-radius: 5px; background: var(--soft); }
#preference-editor label { margin-top: 14px; }
#preference-text { width: 100%; min-height: 120px; resize: vertical; color: var(--ink); background: var(--paper); border: 1px solid var(--line); padding: 10px; font: inherit; }
#preference-editor .review-actions { margin-top: 14px; }
#review-status { color: var(--muted); font-size: 11px; margin: 4px 0; }
#review-status:empty { display: none; }
.source-quote { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0 0; }
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
.copy-status { margin: 10px 0 0; color: var(--accent); font-size: 11px; }
.copy-status:empty { display: none; }
.related { margin-top: 24px; padding-top: 14px; border-top: 1px solid var(--line); }
.related > summary { position: relative; display: flex; align-items: baseline; gap: 8px; padding-left: 22px; cursor: pointer; list-style: none; font-size: 11px; color: var(--muted); }
.related > summary::-webkit-details-marker { display: none; }
.related > summary::before { content: ""; position: absolute; left: 1px; top: 4px; width: 12px; height: 8px; background-image: var(--chevron); background-size: 12px 8px; transform: rotate(-90deg); }
.related[open] > summary::before { transform: rotate(0deg); }
.related[open] > summary { margin-bottom: 16px; }
#related-count { font-size: 10px; opacity: .7; }
.related ul { list-style: none; padding: 0; margin: 0; }
.related li { margin-bottom: 20px; overflow-wrap: anywhere; }
.related a { color: var(--ink); text-underline-offset: 3px; }
.related a:hover { background: var(--soft); }
.related li .muted { display: block; margin-top: 4px; font-size: 11px; }
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
  .topbar { height: 53px; padding: 0 16px; gap: 14px; }
  .brand span { display: none; }
  .tip-number { display: none; }
  .tip-toggle { gap: 6px; }
  .tip-details { right: 0; }
  .workspace { grid-template-columns: 1fr; }
  .sidebar { border-right: 0; border-bottom: 1px solid var(--line); }
  .library-tabs { padding: 12px 16px 0; }
  .filters { padding: 10px 16px 8px; }
  #list { max-height: 210px; padding: 0 8px 8px; }
  .entry { padding: 8px 10px; }
  .reader { padding: 18px 22px 40px; }
  .reader-toolbar { margin-bottom: 20px; }
  h1 { font-size: 21px; }
  .viewer { overflow-y: visible; }
  .domain-context-tree { max-height: 260px; }
}
@media (max-width: 420px) {
  .brand { font-size: 11px; }
  .tip-toggle > .icon { display: none; }
  .tip-toggle { padding-right: 4px; }
  .tip-chevron { display: none; }
  .tip-strip > .icon-button { width: 28px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; }
}
`;

export { GUI_JS } from "./client.generated.js";
