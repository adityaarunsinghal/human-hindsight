import { domainPath } from "../core/domains.js";
import { icon } from "./icons.js";

export interface DomainNode {
  label: string;
  path: string;
  terminal: boolean;
  children: DomainNode[];
}

interface MutableDomainNode {
  label: string;
  terminal: boolean;
  children: Map<string, MutableDomainNode>;
}

const pathKey = (path: string) => path.toLowerCase();
const acronyms = new Set([
  "AI",
  "API",
  "CLI",
  "CSS",
  "HTML",
  "HTTP",
  "HTTPS",
  "JSON",
  "MCP",
  "QA",
  "SDK",
  "SQL",
  "UI",
  "UX",
  "XML",
  "YAML",
]);

/** Prefer readable casing while retaining short acronyms and names such as iOS. */
function labelRank(label: string): number {
  const lower = /\p{Ll}/u.test(label);
  const upper = /\p{Lu}/u.test(label);
  if (lower && upper) return 0;
  if (acronyms.has(label)) return 0;
  return lower ? 1 : upper ? 2 : 0;
}

function canonicalLabel(left: string, right: string): string {
  const rank = labelRank(left) - labelRank(right);
  if (rank) return rank < 0 ? left : right;
  return left < right ? left : right;
}

/** One node per case-insensitive sibling label, with complete canonical paths. */
export function buildDomainTree(domains: string[]): DomainNode[] {
  const roots = new Map<string, MutableDomainNode>();
  for (const domain of domains) {
    let siblings = roots;
    const parts = domainPath(domain);
    for (const [index, label] of parts.entries()) {
      const key = pathKey(label);
      let node = siblings.get(key);
      if (!node) {
        node = { label, terminal: false, children: new Map() };
        siblings.set(key, node);
      } else {
        node.label = canonicalLabel(node.label, label);
      }
      if (index === parts.length - 1) node.terminal = true;
      siblings = node.children;
    }
  }

  const finish = (siblings: Map<string, MutableDomainNode>, parent: string[]): DomainNode[] =>
    [...siblings.values()]
      .sort((left, right) =>
        left.label.localeCompare(right.label, undefined, { sensitivity: "base", numeric: true }),
      )
      .map((node) => {
        const parts = [...parent, node.label];
        return {
          label: node.label,
          path: parts.join(" > "),
          terminal: node.terminal,
          children: finish(node.children, parts),
        };
      });
  return finish(roots, []);
}

function flatten(tree: DomainNode[]): DomainNode[] {
  return tree.flatMap((node) => [node, ...flatten(node.children)]);
}

/** Keep selection meaningful after a refresh removes its most specific branch. */
export function resolveDomainSelection(tree: DomainNode[], selected: string): string {
  const byKey = new Map(flatten(tree).map((node) => [pathKey(node.path), node.path]));
  const requested = selected ? domainPath(selected) : [];
  while (requested.length) {
    const match = byKey.get(pathKey(requested.join(" > ")));
    if (match) return match;
    requested.pop();
  }
  return "";
}

export interface DomainContext {
  tree: DomainNode[];
  paths: string[];
  breadcrumb: string[];
  additional: number;
}

/** Describe shared ancestry without repeating a full path for every domain. */
export function summarizeDomainContext(domains: string[]): DomainContext {
  const tree = buildDomainTree(domains);
  const paths = flatten(tree)
    .filter((node) => node.terminal)
    .map((node) => node.path);
  const breadcrumb = paths[0]?.split(" > ") ?? [];
  for (const path of paths.slice(1)) {
    const parts = path.split(" > ");
    let shared = 0;
    while (
      shared < breadcrumb.length &&
      pathKey(breadcrumb[shared] ?? "") === pathKey(parts[shared] ?? "")
    )
      shared++;
    breadcrumb.length = shared;
  }
  const represented = paths.some((path) => path === breadcrumb.join(" > ")) ? 1 : 0;
  return { tree, paths, breadcrumb, additional: paths.length - represented };
}

interface Branch {
  button: HTMLButtonElement;
  children: HTMLUListElement;
  label: string;
}

interface TreeOptions {
  document: Document;
  expanded: Set<string>;
  selectButtons: Map<string, HTMLButtonElement>;
  toggleButtons: Map<string, HTMLButtonElement>;
  branches: Map<string, Branch>;
  onSelect: (path: string) => void;
}

let branchSequence = 0;

function chevron(expanded: boolean): SVGElement {
  const element = icon(expanded ? "chevron-down" : "chevron-right");
  element.classList.add("domain-chevron");
  element.setAttribute("aria-hidden", "true");
  return element;
}

function setExpanded(branch: Branch, expanded: boolean): void {
  branch.children.hidden = !expanded;
  branch.button.setAttribute("aria-expanded", String(expanded));
  branch.button.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${branch.label}`);
  branch.button.replaceChildren(chevron(expanded));
}

function domainButton(document: Document, label: string, path: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "domain-select";
  button.textContent = label;
  button.title = path || label;
  button.dataset.domainKey = pathKey(path);
  button.dataset.domainAction = "select";
  return button;
}

function renderTree(nodes: DomainNode[], options: TreeOptions): HTMLUListElement {
  const list = options.document.createElement("ul");
  list.className = "domain-tree";
  for (const node of nodes) {
    const key = pathKey(node.path);
    const item = options.document.createElement("li");
    item.className = "domain-node";
    const row = options.document.createElement("div");
    row.className = "domain-row";
    const select = domainButton(options.document, node.label, node.path);
    select.addEventListener("click", () => options.onSelect(node.path));
    options.selectButtons.set(key, select);

    if (node.children.length) {
      const children = renderTree(node.children, options);
      children.classList.add("domain-children");
      children.id = `domain-branch-${++branchSequence}`;
      const toggle = options.document.createElement("button");
      toggle.type = "button";
      toggle.className = "domain-toggle";
      toggle.dataset.domainKey = key;
      toggle.dataset.domainAction = "toggle";
      toggle.setAttribute("aria-controls", children.id);
      const branch: Branch = { button: toggle, children, label: node.label };
      setExpanded(branch, options.expanded.has(key));
      toggle.addEventListener("click", () => {
        const expanded = !options.expanded.has(key);
        if (expanded) options.expanded.add(key);
        else options.expanded.delete(key);
        setExpanded(branch, expanded);
      });
      options.toggleButtons.set(key, toggle);
      options.branches.set(key, branch);
      row.append(toggle, select);
      item.append(row, children);
    } else {
      const gutter = options.document.createElement("span");
      gutter.className = "domain-gutter";
      gutter.setAttribute("aria-hidden", "true");
      row.append(gutter, select);
      item.append(row);
    }
    list.append(item);
  }
  return list;
}

export interface DomainPicker {
  /** Returns the canonical selection, falling back to the nearest surviving parent. */
  update(domains: string[], selected: string): string;
  close(): void;
}

/**
 * A single popup with independent disclosure and selection controls. Native
 * buttons keep Tab, Enter, and Space behavior; no partial ARIA tree pattern.
 */
export function createDomainPicker(
  root: HTMLElement,
  onSelect: (path: string) => void,
): DomainPicker {
  const document = root.ownerDocument;
  const trigger = root.querySelector<HTMLButtonElement>("#domain");
  const label = root.querySelector<HTMLElement>("#domain-label");
  const menu = root.querySelector<HTMLElement>("#domain-menu");
  if (!trigger || !label || !menu) throw new Error("Domain picker markup is incomplete.");

  let signature = "";
  let selectedKey = "";
  let canonicalSelected = "";
  const expanded = new Set<string>();
  const selectButtons = new Map<string, HTMLButtonElement>();
  const toggleButtons = new Map<string, HTMLButtonElement>();
  const branches = new Map<string, Branch>();
  trigger.setAttribute("aria-controls", menu.id);
  trigger.setAttribute("aria-expanded", "false");
  menu.hidden = true;
  menu.setAttribute("role", "group");
  menu.setAttribute("aria-label", "Choose a domain");

  const close = (restoreFocus: boolean) => {
    const wasOpen = !menu.hidden;
    const ownsFocus = root.contains(document.activeElement);
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (wasOpen && restoreFocus && ownsFocus) trigger.focus({ preventScroll: true });
  };
  const visibleSelection = (key: string): HTMLButtonElement | undefined => {
    let current = key;
    for (;;) {
      const button = selectButtons.get(current);
      if (button && !button.closest("[hidden]")) return button;
      if (!current) return undefined;
      current = current.split(" > ").slice(0, -1).join(" > ");
    }
  };
  const open = () => {
    if (trigger.disabled) return;
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    visibleSelection(selectedKey)?.focus({ preventScroll: true });
  };
  trigger.addEventListener("click", () => {
    if (menu.hidden) open();
    else close(true);
  });
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      open();
    }
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!root.contains(event.target as Node)) close(false);
  });
  document.addEventListener("focusin", (event) => {
    if (!root.contains(event.target as Node)) close(false);
  });

  return {
    close: () => close(true),
    update(domains, selected) {
      const tree = buildDomainTree(domains);
      const nodes = flatten(tree);
      const byKey = new Map(nodes.map((node) => [pathKey(node.path), node]));
      canonicalSelected = resolveDomainSelection(tree, selected);
      const current = byKey.get(pathKey(canonicalSelected));
      const nextKey = pathKey(canonicalSelected);
      const nextSignature = JSON.stringify(tree);
      const expandSelection = nextKey !== selectedKey || signature === "";
      if (expandSelection && current) {
        const parts = current.path.split(" > ");
        for (let depth = 1; depth < parts.length; depth++) {
          expanded.add(pathKey(parts.slice(0, depth).join(" > ")));
        }
      }
      if (nextSignature !== signature) {
        const active = menu.contains(document.activeElement) ? document.activeElement : null;
        const focusedKey = active?.getAttribute("data-domain-key");
        const focusedAction = active?.getAttribute("data-domain-action");
        selectButtons.clear();
        toggleButtons.clear();
        branches.clear();
        for (const key of expanded) if (!byKey.has(key)) expanded.delete(key);
        const choose = (path: string) => {
          onSelect(path);
          close(true);
        };
        const all = domainButton(document, "All domains", "");
        all.classList.add("domain-all");
        all.addEventListener("click", () => choose(""));
        selectButtons.set("", all);
        menu.replaceChildren(
          all,
          renderTree(tree, {
            document,
            expanded,
            selectButtons,
            toggleButtons,
            branches,
            onSelect: choose,
          }),
        );
        signature = nextSignature;
        if (active && !menu.hidden) {
          const restored =
            focusedAction === "toggle"
              ? toggleButtons.get(focusedKey ?? "")
              : selectButtons.get(focusedKey ?? "");
          const target =
            restored && !restored.closest("[hidden]")
              ? restored
              : (visibleSelection(nextKey) ?? all);
          target.focus({ preventScroll: true });
        }
      } else if (expandSelection) {
        for (const [key, branch] of branches) setExpanded(branch, expanded.has(key));
      }
      selectedKey = nextKey;
      for (const [key, button] of selectButtons) {
        button.setAttribute("aria-current", String(key === selectedKey));
      }
      label.textContent = current?.label ?? "All domains";
      trigger.title = canonicalSelected || "All domains";
      trigger.setAttribute("aria-label", `Filter by domain: ${canonicalSelected || "All domains"}`);
      trigger.disabled = !tree.length;
      if (trigger.disabled) close(false);
      return canonicalSelected;
    },
  };
}

/** Shared ancestry is visible once; the full grouped hierarchy is optional. */
export function renderDomainContext(
  domains: string[],
  onSelect: (path: string) => void,
): HTMLElement {
  const context = summarizeDomainContext(domains);
  const root = document.createElement("div");
  root.className = "domain-context";
  if (!context.paths.length) {
    root.hidden = true;
    return root;
  }

  if (context.breadcrumb.length) {
    const breadcrumb = document.createElement("nav");
    breadcrumb.className = "domain-breadcrumb";
    breadcrumb.setAttribute("aria-label", "Shared domain path");
    for (const [index, part] of context.breadcrumb.entries()) {
      if (index) {
        const separator = icon("chevron-right");
        separator.classList.add("domain-separator");
        separator.setAttribute("aria-hidden", "true");
        breadcrumb.append(separator);
      }
      const path = context.breadcrumb.slice(0, index + 1).join(" > ");
      const button = domainButton(document, part, path);
      button.addEventListener("click", () => onSelect(path));
      breadcrumb.append(button);
    }
    root.append(breadcrumb);
  } else {
    const label = document.createElement("span");
    label.className = "domain-context-label";
    label.textContent = "Domains";
    root.append(label);
  }

  if (context.additional) {
    const details = document.createElement("details");
    details.className = "domain-context-more";
    const summary = document.createElement("summary");
    summary.className = "domain-context-summary";
    summary.setAttribute("aria-label", `Show all ${context.paths.length} domain paths`);
    const count = document.createElement("span");
    count.textContent = `+${context.additional}`;
    summary.append(count, chevron(false));
    const content = document.createElement("div");
    content.className = "domain-context-tree";
    content.append(
      renderTree(context.tree, {
        document,
        expanded: new Set(flatten(context.tree).map((node) => pathKey(node.path))),
        selectButtons: new Map(),
        toggleButtons: new Map(),
        branches: new Map(),
        onSelect: (path) => {
          onSelect(path);
          details.open = false;
        },
      }),
    );
    details.append(summary, content);
    details.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && details.open) {
        event.preventDefault();
        event.stopPropagation();
        details.open = false;
        summary.focus({ preventScroll: true });
      }
    });
    root.append(details);
  }
  return root;
}
