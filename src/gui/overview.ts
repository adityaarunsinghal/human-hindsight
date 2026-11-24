import { domainPath } from "../core/domains.js";
import type { GeneralizedGap } from "../core/generalized.js";
import type { Lesson } from "../core/subagents.js";
import type { Highlight } from "./highlights.js";
import type { GuiPreference } from "./server.js";
import { countLabel } from "./subagents-view.js";

/*
 * How working agreements are presented, as plain functions with no DOM so the
 * server (highlights) and the page share one rule:
 *   - general agreements first, under a plain domain heading, best supported first;
 *   - agreements for one project next, under that project's name;
 *   - one-time notes last, tucked away, never among the highlights.
 */

/** What one preference contributes to the agreements made from it. */
export interface AgreementSource {
  /** Domain paths of the sessions it was seen in ("Software engineering > Testing"). */
  domains: readonly string[];
  /** Projects it belongs to or was seen in. */
  projects: readonly string[];
  /** Sessions with a verified quotation of it. */
  sessions: readonly string[];
}

/** general: holds in any project; project: makes sense in one project or tool; one-time: a single situation. */
export type AgreementKind = "general" | "project" | "one-time";

export interface AgreementFacts {
  id: string;
  title: string;
  kind: AgreementKind;
  /** The domain heading (general), the project name (project), or "" (one-time). */
  group: string;
  /** Distinct sessions with a verified quotation behind it. */
  sessions: number;
  /** Preferences it was made from. */
  preferences: number;
}

/** The heading for project agreements whose preferences name no project. */
export const NO_PROJECT = "Not tied to one project";
const OTHER = "Other";

const KIND: Record<Lesson["disposition"], AgreementKind> = {
  generalized: "general",
  contextual: "project",
  historical: "one-time",
};

/** The value seen most often; a tie goes to the alphabetically first, so a group never flips. */
function mostCommon(values: Iterable<string>): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

/**
 * A plain heading for a domain path. Every coding session sits under one broad
 * root ("Software engineering"), so the root alone would put nearly everything
 * in one group: the second level ("Testing", "Frontend") is the heading, and a
 * root with no deeper level is its own heading.
 */
function domainHeading(domain: string): string | undefined {
  const [root, second] = domainPath(domain);
  if (!root) return undefined;
  if (root.toLowerCase() === OTHER.toLowerCase()) return OTHER;
  return second ?? root;
}

export function agreementFacts(
  lesson: Pick<Lesson, "id" | "title" | "disposition" | "source_ids">,
  sources: ReadonlyMap<string, AgreementSource>,
): AgreementFacts {
  const ids = [...new Set(lesson.source_ids)];
  const known = ids.flatMap((id) => sources.get(id) ?? []);
  const kind = KIND[lesson.disposition];
  // Each preference votes once per heading or project, however many sessions it has.
  const group =
    kind === "general"
      ? (mostCommon(
          known.flatMap((source) => [
            ...new Set(source.domains.flatMap((domain) => domainHeading(domain) ?? [])),
          ]),
        ) ?? OTHER)
      : kind === "project"
        ? (mostCommon(known.flatMap((source) => [...new Set(source.projects)])) ?? NO_PROJECT)
        : "";
  return {
    id: lesson.id,
    title: lesson.title,
    kind,
    group,
    sessions: new Set(known.flatMap((source) => source.sessions)).size,
    preferences: ids.length,
  };
}

export interface AgreementGroup {
  label: string;
  items: AgreementFacts[];
}

export interface AgreementCounts {
  total: number;
  general: number;
  project: number;
  oneTime: number;
}

export interface OrganizedAgreements {
  general: AgreementGroup[];
  projects: AgreementGroup[];
  oneTime: AgreementFacts[];
  counts: AgreementCounts;
}

/** Best supported first: sessions, then preferences, then title and ID for a stable order. */
export function bySupport(a: AgreementFacts, b: AgreementFacts): number {
  return (
    b.sessions - a.sessions ||
    b.preferences - a.preferences ||
    a.title.localeCompare(b.title) ||
    a.id.localeCompare(b.id)
  );
}

function groups(items: AgreementFacts[], last: string): AgreementGroup[] {
  const byLabel = new Map<string, AgreementFacts[]>();
  for (const item of items) byLabel.set(item.group, [...(byLabel.get(item.group) ?? []), item]);
  return [...byLabel]
    .map(([label, members]) => ({ label, items: members.sort(bySupport) }))
    .sort(
      (a, b) =>
        Number(a.label === last) - Number(b.label === last) ||
        b.items.length - a.items.length ||
        a.label.localeCompare(b.label),
    );
}

export function organizeAgreements(facts: readonly AgreementFacts[]): OrganizedAgreements {
  const of = (kind: AgreementKind) => facts.filter((item) => item.kind === kind);
  const general = of("general");
  const project = of("project");
  const oneTime = of("one-time").sort(bySupport);
  return {
    general: groups(general, OTHER),
    projects: groups(project, NO_PROJECT),
    oneTime,
    counts: {
      total: facts.length,
      general: general.length,
      project: project.length,
      oneTime: oneTime.length,
    },
  };
}

/** "120 working agreements from 139 preferences: 62 general, 41 for specific projects, 17 one-time notes." */
export function agreementSummary(counts: AgreementCounts, preferences: number): string {
  const parts = [
    counts.general ? `${counts.general} general` : "",
    counts.project === 1
      ? "1 for a specific project"
      : counts.project
        ? `${counts.project} for specific projects`
        : "",
    counts.oneTime ? countLabel(counts.oneTime, "one-time note") : "",
  ].filter(Boolean);
  const from = preferences ? ` from ${countLabel(preferences, "preference")}` : "";
  return `${countLabel(counts.total, "working agreement")}${from}${parts.length ? `: ${parts.join(", ")}` : ""}.`;
}

/**
 * What a preference count means. A verified preference counts sessions with a
 * quotation; one from an earlier version counts the tasks it was recorded in.
 */
export function supportLabel(count: number, verified: boolean, form: "long" | "short"): string {
  const counted = countLabel(count, verified ? "session" : "task");
  if (form === "short") return counted;
  return verified ? `Seen in ${counted}` : `Found in ${counted}`;
}

function agreementReason(item: AgreementFacts): string {
  return item.sessions
    ? supportLabel(item.sessions, true, "long")
    : `From ${countLabel(item.preferences, "preference")}`;
}

/** The general agreements to read first, with the count that ranked them. Never a project or one-time one. */
export function agreementHighlights(organized: OrganizedAgreements, limit = 3): Highlight[] {
  return organized.general
    .flatMap((group) => group.items)
    .sort(bySupport)
    .slice(0, limit)
    .map((item) => ({ id: `agreement/${item.id}`, reason: agreementReason(item) }));
}

/**
 * One plain line when the saved set covers only part of the preferences; null
 * when it is complete. It names no batch count: batch sizes change.
 */
export function incompleteNotice(
  incomplete: Pick<GeneralizedGap, "summarized" | "total"> | null | undefined,
): string | null {
  if (!incomplete || incomplete.summarized >= incomplete.total) return null;
  const verb = incomplete.summarized === 1 || incomplete.total === 1 ? "is" : "are";
  return `${incomplete.summarized} of ${countLabel(incomplete.total, "preference")} ${verb} summarized so far. Run this to finish; finished work is reused:`;
}

/** The general agreements as Markdown for AGENTS.md or CLAUDE.md, under the same headings as the page. */
export function agreementsMarkdown(
  organized: OrganizedAgreements,
  lessons: readonly Lesson[],
): string {
  const byId = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const lines = ["# Working agreements", ""];
  for (const group of organized.general) {
    lines.push(`## ${group.label}`, "");
    for (const item of group.items) {
      const lesson = byId.get(item.id);
      if (!lesson) continue;
      const title = /[.!?]$/.test(lesson.title) ? lesson.title : `${lesson.title}.`;
      lines.push(`- **${title}** ${lesson.instruction.trim()}`);
      if (lesson.applies_when.trim()) lines.push(`  Applies when: ${lesson.applies_when.trim()}`);
      if (lesson.exceptions.trim()) lines.push(`  Exceptions: ${lesson.exceptions.trim()}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * A tab's overview, shown while nothing is selected: one sentence on what the
 * tab holds, up to three items to open first with the reason each was picked,
 * and the one action that pays off, then any sections that map the rest. It is
 * a labelled region, so a screen reader can jump to it. A highlight whose ID is
 * no longer in the list is skipped rather than shown as a broken link.
 */
export function overview(options: {
  label: string;
  description: string;
  highlights?: Highlight[];
  link(id: string): HTMLAnchorElement | undefined;
  guidance: string;
  highlightsUnavailable?: boolean;
  action?: HTMLElement;
  message?: HTMLElement | HTMLElement[];
  sections?: HTMLElement[];
}): HTMLElement {
  const root = document.createElement("section");
  root.className = "overview";
  root.setAttribute("aria-label", options.label);
  const intro = document.createElement("p");
  intro.className = "overview-summary";
  intro.textContent = options.description;
  root.append(intro);
  if (options.message) root.append(...[options.message].flat());
  const list = document.createElement("ul");
  list.className = "highlights";
  for (const highlight of options.highlights ?? []) {
    const link = options.link(highlight.id);
    if (!link) continue;
    list.append(
      highlightRow(
        link,
        highlight.stale ? `${highlight.reason} · out of date` : highlight.reason,
        highlight.stale,
      ),
    );
  }
  if (list.childElementCount) {
    const heading = document.createElement("h2");
    heading.textContent = "Start here";
    root.append(heading, list);
  } else if (options.highlightsUnavailable) {
    const status = document.createElement("p");
    status.className = "muted";
    status.textContent =
      "Suggestions of what to open first could not be loaded. Choose an item from the list instead.";
    root.append(status);
  }
  if (options.guidance) {
    const next = document.createElement("p");
    next.textContent = options.guidance;
    root.append(next);
  }
  if (options.action) root.append(options.action);
  root.append(...(options.sections ?? []));
  return root;
}

function highlightRow(link: HTMLElement, reason: string, stale?: boolean): HTMLLIElement {
  const row = document.createElement("li");
  const note = document.createElement("span");
  note.className = "muted";
  note.textContent = reason;
  row.append(link, note);
  if (stale) row.dataset.stale = "true";
  return row;
}

/**
 * The label the page shows on a prompt whose group had no session that reached
 * a result that could be verified: the same words as `OUTCOME_NOT_VERIFIED` in
 * `core/library.ts` (not imported, since the browser bundle carries no file
 * readers), starting with a capital.
 */
export const OUTCOME_NOT_VERIFIED_LABEL = "Outcome not verified";

/**
 * The Prompts guide's one sentence. When some prompts are not verified, it
 * says how many, in the same sentence.
 */
export function promptsGuideSentence(total: number, unverified: number): string {
  const base =
    "Each prompt rebuilds a task from your past coding sessions, with the instructions and decisions you gave, ready to paste into a new session";
  if (!unverified) return `${base}.`;
  const one = unverified === 1;
  return `${base}; ${unverified} of ${total} ${one ? "is" : "are"} marked ${OUTCOME_NOT_VERIFIED_LABEL.toLowerCase()}, because no session behind ${one ? "it" : "them"} was seen to reach a result.`;
}

/**
 * A general agreement's group comes from the sessions it was seen in, which is
 * not always what the agreement is about, so the page says so.
 */
export const GENERAL_GROUPING_NOTE = "Grouped by the kind of work where each was seen.";

/** Groups show this many items until opened; a group of one more than this shows them all. */
const GROUP_PREVIEW = 3;

let groupSequence = 0;

/**
 * One section of agreement groups: each group is its heading and count, its
 * best-supported few, and one button that shows the rest. `open` holds the
 * keys of opened groups so a re-render keeps them open.
 */
export function agreementGroups(options: {
  heading: string;
  /** One quiet line under the heading. */
  note?: string;
  key: string;
  groups: AgreementGroup[];
  link(id: string): HTMLAnchorElement | undefined;
  open: Set<string>;
}): HTMLElement {
  const section = document.createElement("section");
  section.className = "agreement-section";
  const heading = document.createElement("h2");
  heading.textContent = options.heading;
  const grid = document.createElement("div");
  grid.className = "agreement-groups";
  for (const group of options.groups) {
    const key = `${options.key}:${group.label}`;
    const block = document.createElement("section");
    block.className = "agreement-group";
    const title = document.createElement("h3");
    title.id = `agreement-group-${++groupSequence}`;
    title.append(group.label);
    const count = document.createElement("span");
    count.className = "muted group-count";
    count.textContent = countLabel(group.items.length, "agreement");
    title.append(" ", count);
    block.setAttribute("aria-labelledby", title.id);
    const list = document.createElement("ul");
    list.className = "highlights";
    list.id = `${title.id}-items`;
    const folds = group.items.length > GROUP_PREVIEW + 1;
    const rows = group.items.flatMap((item, index) => {
      const link = options.link(`agreement/${item.id}`);
      if (!link) return [];
      const row = highlightRow(link, agreementReason(item));
      if (folds && index >= GROUP_PREVIEW) row.dataset.more = "true";
      return [row];
    });
    list.append(...rows);
    block.append(title, list);
    if (folds) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "group-toggle";
      toggle.setAttribute("aria-controls", list.id);
      const show = (expanded: boolean) => {
        for (const row of rows) if (row.dataset.more) row.hidden = !expanded;
        toggle.setAttribute("aria-expanded", String(expanded));
        toggle.textContent = expanded ? "Show fewer" : `Show all ${group.items.length}`;
      };
      toggle.addEventListener("click", () => {
        const expanded = !options.open.has(key);
        if (expanded) options.open.add(key);
        else options.open.delete(key);
        show(expanded);
      });
      show(options.open.has(key));
      block.append(toggle);
    }
    grid.append(block);
  }
  section.append(heading);
  if (options.note) {
    const note = document.createElement("p");
    note.className = "muted section-note";
    note.textContent = options.note;
    section.append(note);
  }
  section.append(grid);
  return section;
}

/** One-time notes, behind one closed disclosure: kept for reference, never copied or highlighted. */
export function oneTimeNotes(options: {
  items: AgreementFacts[];
  link(id: string): HTMLAnchorElement | undefined;
  open: boolean;
  onToggle(open: boolean): void;
}): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = "file-block one-time-notes";
  details.open = options.open;
  const summary = document.createElement("summary");
  summary.textContent = countLabel(options.items.length, "one-time note");
  const body = document.createElement("div");
  const about = document.createElement("p");
  about.className = "muted";
  about.textContent =
    "Notes about a single situation or permission. They are kept for reference and are not part of the copied agreements.";
  const list = document.createElement("ul");
  list.className = "highlights";
  for (const item of options.items) {
    const link = options.link(`agreement/${item.id}`);
    if (link) list.append(highlightRow(link, agreementReason(item)));
  }
  body.append(about, list);
  details.append(summary, body);
  details.addEventListener("toggle", () => options.onToggle(details.open));
  return details;
}

/** Where an agreement belongs and how well it is supported, in words. */
export function agreementPlace(facts: AgreementFacts): string {
  const place =
    facts.kind === "general"
      ? `General · ${facts.group}`
      : facts.kind === "project"
        ? facts.group === NO_PROJECT
          ? "Specific to one project or tool"
          : `For ${facts.group}`
        : "One-time note";
  return `${place} · ${agreementReason(facts)}`;
}

function dayLabel(date: Date, withTime: boolean): string {
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

/**
 * The citation line for each quotation: the session's task and the day it was
 * said. Two quotations that would read the same also show the time, so they do
 * not look like duplicates.
 */
function citationLines(occurrences: readonly { title: string; timestamp?: string }[]): string[] {
  const dates = occurrences.map((occurrence) => {
    const said = occurrence.timestamp ? new Date(occurrence.timestamp) : undefined;
    return said && !Number.isNaN(said.getTime()) ? said : undefined;
  });
  const plain = occurrences.map((occurrence, index) => {
    const said = dates[index];
    return [occurrence.title, said ? dayLabel(said, false) : ""].filter(Boolean).join(" · ");
  });
  return plain.map((line, index) => {
    const said = dates[index];
    if (!said || plain.indexOf(line) === plain.lastIndexOf(line)) return line;
    return [occurrences[index]?.title, dayLabel(said, true)].filter(Boolean).join(" · ");
  });
}

export function agreementDetail(
  lesson: Lesson,
  candidates: ReadonlyMap<string, GuiPreference>,
  reviewLink: (id: string) => HTMLAnchorElement,
): HTMLElement {
  const root = document.createElement("article");
  root.className = "agreement";
  const instruction = document.createElement("p");
  instruction.textContent = lesson.instruction;
  root.append(instruction);
  const conditions = document.createElement("dl");
  for (const [label, text] of [
    ["Applies when", lesson.applies_when],
    ["Exceptions", lesson.exceptions],
  ] as const) {
    if (!text.trim()) continue;
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = text;
    conditions.append(term, description);
  }
  if (conditions.childElementCount) root.append(conditions);
  const heading = document.createElement("h2");
  const sourceIds = [...new Set(lesson.source_ids)];
  heading.textContent = `Made from ${countLabel(sourceIds.length, "preference")}`;
  root.append(heading);
  for (const id of sourceIds) {
    const preference = candidates.get(id);
    const details = document.createElement("details");
    details.className = "file-block agreement-evidence";
    const summary = document.createElement("summary");
    summary.textContent = preference?.text ?? "A preference no longer in the library";
    details.append(summary);
    const content = document.createElement("div");
    if (preference) {
      content.append(reviewLink(id));
      const lines = citationLines(preference.occurrences);
      preference.occurrences.forEach((occurrence, index) => {
        const citation = document.createElement("p");
        citation.className = "muted";
        // The session's task and when it was said; message IDs stay in the files.
        citation.textContent = lines[index] ?? "";
        content.append(citation);
        if (occurrence.quote) {
          const quote = document.createElement("blockquote");
          quote.className = "evidence source-quote";
          quote.textContent = occurrence.quote;
          content.append(quote);
        } else {
          const evidence = document.createElement("p");
          evidence.textContent = occurrence.evidence
            ? `Recorded evidence without a verified quotation. ${occurrence.evidence}`
            : "This source has no saved quotation.";
          content.append(evidence);
        }
      });
    } else {
      content.textContent = `This preference changed or left the library after the set was made. Saved ID ${id}`;
    }
    details.append(content);
    root.append(details);
  }
  return root;
}
