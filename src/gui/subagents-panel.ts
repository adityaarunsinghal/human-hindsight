import type { Lesson, Role, SuggestionArtifact } from "../core/subagents.js";
import { setIconButton } from "./icons.js";
import { renderMarkdown } from "./markdown.js";
import {
  coverageRoleRows,
  coverageRows,
  firstSource,
  knowledgeFile,
  lessonLookup,
  playbookPath,
  type RenderedFile,
  roleFiles,
  type SourceStatus,
  splitFrontmatter,
  TARGET_LABELS,
} from "./subagents-view.js";

/**
 * gui/subagents-panel.ts: the detail views of the Suggested subagents tab.
 *
 * Every value from the artifact is inserted as text, and rendered Markdown
 * goes through `renderMarkdown` (Marked, then DOMPurify into a fragment), the
 * same path as prompts. File blocks keep the original text for copying, like
 * the rest of the viewer. Nothing here fetches or writes anything; the export
 * link is a plain same-origin download.
 */

export interface PanelContext {
  /** A link to a preference in the Preferences tab, or null when it is not in the library. */
  preferenceLink(id: string, label: string): HTMLElement | null;
  /** Where a source preference stands now; only consulted when the suggestion is out of date. */
  sourceStatus?(id: string): SourceStatus;
}

function element(tag: string, text = "", className?: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function iconButton(name: "copy" | "eye" | "code", label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button";
  setIconButton(button, name, label);
  return button;
}

function copyShortcut(): string {
  return /Mac/.test(navigator.platform) ? "⌘C" : "Ctrl+C";
}

function selectContents(node: HTMLElement): void {
  node.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** A copyable command with a status line, matching the tip card's command row. */
export function commandRow(command: string): HTMLElement {
  const wrap = element("div", "", "command");
  const row = element("div", "", "command-row");
  const code = element("code", command);
  code.tabIndex = 0;
  const copy = iconButton("copy", "Copy command");
  const status = element("span", "", "muted command-status");
  status.setAttribute("role", "status");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(command);
      setIconButton(copy, "check", "Command copied");
      status.textContent = "Command copied. Run it in your terminal when ready.";
    } catch {
      selectContents(code);
      status.textContent = `Command selected. Press ${copyShortcut()} to copy.`;
    }
  });
  row.append(code, copy);
  wrap.append(row, status);
  return wrap;
}

/** A notice line followed by an optional copyable command. */
export function notice(text: string, command?: string): HTMLElement {
  const box = element("div", "", "notice");
  box.append(element("p", text));
  if (command) box.append(commandRow(command));
  return box;
}

/**
 * The tab's empty state: what it shows, and the command that creates it. A
 * library with no preferences yet needs its sessions read first, so it gets
 * the first-run command instead.
 */
export function renderIntro(command: string, firstRun?: string): HTMLElement {
  const intro = element("div", "", "subagents-intro");
  intro.append(
    element(
      "p",
      firstRun
        ? "Suggested subagents are specialist roles made from the preferences in your sessions, and none have been found yet. Run this in your terminal to read your sessions first, then choose Refresh:"
        : "Suggested subagents turn your preferences into specialist roles for recurring tasks. Run this in your terminal to make your first suggestion; it shows which model it will use and asks before starting. Then choose Refresh to explore and export the roles.",
    ),
    commandRow(firstRun ?? command),
  );
  return intro;
}

let fileSequence = 0;

/** A collapsed file with a copy control and, for Markdown, a Preview/Markdown toggle. */
function fileBlock(file: RenderedFile): HTMLDetailsElement {
  const index = ++fileSequence;
  const details = document.createElement("details");
  details.className = "file-block";
  const summary = document.createElement("summary");
  summary.append(element("span", file.path, "file-path"));
  const toolbar = element("div", "", "file-toolbar");
  const status = element("span", "", "muted file-status");
  status.setAttribute("role", "status");
  const source = element("pre", file.content, "file-source");
  source.tabIndex = 0;
  source.setAttribute("aria-label", `${file.path} source`);
  const copy = iconButton("copy", `Copy ${file.path}`);
  let showSource = () => {};
  if (file.path.endsWith(".md")) {
    const group = element("div", "", "view-mode");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", `${file.path} view`);
    const previewButton = iconButton("eye", "Preview");
    const sourceButton = iconButton("code", "Markdown");
    const preview = element("div", "", "markdown file-preview");
    const { frontmatter, body } = splitFrontmatter(file.content);
    if (frontmatter) preview.append(element("pre", `---\n${frontmatter}\n---`, "frontmatter"));
    preview.append(renderMarkdown(body, `file-${index}`));
    const setMode = (mode: "preview" | "source") => {
      preview.hidden = mode !== "preview";
      source.hidden = mode !== "source";
      previewButton.setAttribute("aria-pressed", String(mode === "preview"));
      sourceButton.setAttribute("aria-pressed", String(mode === "source"));
    };
    previewButton.addEventListener("click", () => setMode("preview"));
    sourceButton.addEventListener("click", () => setMode("source"));
    showSource = () => setMode("source");
    setMode("preview");
    group.append(previewButton, sourceButton);
    toolbar.append(group, status, copy);
    details.append(summary, toolbar, preview, source);
  } else {
    toolbar.append(status, copy);
    details.append(summary, toolbar, source);
  }
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(file.content);
      setIconButton(copy, "check", "Copied");
      status.textContent = "Copied. Ready to paste.";
    } catch {
      showSource();
      selectContents(source);
      status.textContent = `Selected. Press ${copyShortcut()} to copy.`;
    }
  });
  return details;
}

function labeled(label: string, value: string): HTMLElement {
  const paragraph = element("p");
  paragraph.append(element("strong", `${label}: `), document.createTextNode(value));
  return paragraph;
}

function lessonBlock(artifact: SuggestionArtifact, lesson: Lesson, ctx: PanelContext) {
  const block = element("section", "", "lesson");
  block.append(element("h3", lesson.title));
  // Marked where the export sits: what would be exported no longer matches the library.
  const statuses = ctx.sourceStatus
    ? [...new Set(lesson.source_ids)].map((id) => ctx.sourceStatus?.(id) ?? "current")
    : [];
  const dismissed = statuses.filter((status) => status === "dismissed").length;
  const missing = statuses.filter((status) => status === "missing").length;
  if (dismissed || missing) {
    const total = statuses.length;
    const some = (count: number, singular: string, plural: string) =>
      total === 1
        ? `its source preference ${singular}`
        : `${count} of its ${total} source preferences ${count === 1 ? singular : plural}`;
    block.dataset.changed = "true";
    block.append(
      element(
        "p",
        `Out of date: ${[
          dismissed ? some(dismissed, "was dismissed", "were dismissed") : "",
          missing
            ? some(missing, "is no longer in the library", "are no longer in the library")
            : "",
        ]
          .filter(Boolean)
          .join(", and ")}. An export made now still includes this preference.`,
        "lesson-changed",
      ),
    );
  }
  block.append(element("p", lesson.instruction));
  if (lesson.applies_when.trim()) block.append(labeled("Applies when", lesson.applies_when));
  if (lesson.exceptions.trim()) block.append(labeled("Exceptions", lesson.exceptions));
  const source = firstSource(artifact, lesson);
  if (source) {
    const line = element("p", "Made from: ", "muted lesson-source");
    const link = ctx.preferenceLink(source.id, source.text);
    line.append(link ?? element("span", source.text));
    if (!link) line.append(" (not in the current library)");
    if (source.more) line.append(` and ${source.more} more`);
    block.append(line);
  }
  return block;
}

function lessonList(
  artifact: SuggestionArtifact,
  ids: string[],
  ctx: PanelContext,
  empty: string,
): HTMLElement[] {
  const lessons = lessonLookup(artifact);
  const blocks = ids
    .map((id) => lessons.get(id))
    .filter((lesson): lesson is Lesson => Boolean(lesson))
    .map((lesson) => lessonBlock(artifact, lesson, ctx));
  return blocks.length ? blocks : [element("p", empty, "muted")];
}

function detail(...children: (HTMLElement | undefined)[]): HTMLElement {
  const root = element("div", "", "markdown subagent-detail");
  root.append(...children.filter((child): child is HTMLElement => Boolean(child)));
  return root;
}

export function renderRole(
  artifact: SuggestionArtifact,
  files: Record<string, string>,
  role: Role,
  ctx: PanelContext,
): HTMLElement {
  const fields = element("dl", "", "role-fields");
  for (const [label, value] of [
    ["Delegate when", role.delegate_when],
    ["Not for", role.not_for],
  ] as const) {
    fields.append(element("dt", label), element("dd", value));
  }
  let triggers: HTMLElement | undefined;
  if (role.triggers?.length) {
    triggers = element("ul", "", "chips");
    triggers.setAttribute("aria-label", "Trigger phrases");
    triggers.append(...role.triggers.map((trigger) => element("li", trigger)));
  }
  const fileNodes = roleFiles(files, role.name).flatMap((file) => [
    element("h3", TARGET_LABELS[file.target], "target-heading"),
    fileBlock(file),
  ]);
  return detail(
    element("p", role.description),
    fields,
    triggers,
    element("h2", `Preferences · ${role.lesson_ids.length}`),
    ...lessonList(artifact, role.lesson_ids, ctx, "No preferences."),
    element("h2", "Files"),
    ...fileNodes,
  );
}

export function renderShared(
  artifact: SuggestionArtifact,
  files: Record<string, string>,
  ctx: PanelContext,
): HTMLElement {
  const file = knowledgeFile(files, "knowledge/shared.md");
  return detail(
    element(
      "p",
      "Every specialist carries these preferences. The current request and the project's own instructions take precedence over them.",
    ),
    ...lessonList(artifact, artifact.shared, ctx, "No shared preferences in this suggestion."),
    file ? element("h2", "File") : undefined,
    file ? fileBlock(file) : undefined,
  );
}

export function renderPlaybooks(
  artifact: SuggestionArtifact,
  files: Record<string, string>,
  ctx: PanelContext,
): HTMLElement {
  if (!artifact.playbooks.length) return detail(element("p", "No playbooks in this suggestion."));
  return detail(
    element(
      "p",
      "A playbook is a step-by-step procedure for one recurring job, built from the preferences it lists.",
    ),
    ...artifact.playbooks.flatMap((playbook) => {
      const file = knowledgeFile(files, playbookPath(playbook.name));
      return [
        element("h2", playbook.name),
        element("p", playbook.purpose),
        ...lessonList(artifact, playbook.lesson_ids, ctx, "No preferences."),
        ...(file ? [fileBlock(file)] : []),
      ];
    }),
  );
}

function table(headings: [string, string], rows: [string, number][]): HTMLElement {
  const root = element("table", "", "coverage-table");
  const head = element("thead");
  const headRow = element("tr");
  headRow.append(element("th", headings[0]));
  const countHeading = element("th", headings[1]);
  countHeading.setAttribute("align", "right");
  headRow.append(countHeading);
  head.append(headRow);
  const body = element("tbody");
  for (const [label, value] of rows) {
    const row = element("tr");
    const count = element("td", String(value));
    count.setAttribute("align", "right");
    row.append(element("td", label), count);
    body.append(row);
  }
  root.append(head, body);
  return root;
}

export function renderCoverage(
  artifact: SuggestionArtifact,
  files: Record<string, string>,
  ctx: PanelContext,
  generated: string,
): HTMLElement {
  const selection =
    artifact.selection === "accepted"
      ? "the preferences accepted in review"
      : "every preference that was not dismissed";
  const setAside = artifact.set_aside.map((item) => {
    const row = element("li");
    row.append(element("span", item.reason));
    for (const id of item.source_ids) {
      const text = artifact.inputs.find((input) => input.id === id)?.text ?? id;
      const line = element("div", "", "muted");
      line.append(ctx.preferenceLink(id, text) ?? element("span", text));
      row.append(line);
    }
    return row;
  });
  const list = element("ul", "", "set-aside");
  list.append(...setAside);
  const file = knowledgeFile(files, "knowledge/coverage.json");
  return detail(
    element("p", `Made ${generated} with ${artifact.runner} from ${selection}.`),
    table(["Item", "Count"], coverageRows(artifact.coverage)),
    table(["Role", "Preferences"], coverageRoleRows(artifact)),
    setAside.length ? element("h2", "Preferences left out, and why") : undefined,
    setAside.length ? list : undefined,
    file ? element("h2", "File") : undefined,
    file ? fileBlock(file) : undefined,
  );
}
