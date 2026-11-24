import type { Lesson } from "../core/subagents.js";
import type { GuiPreference } from "./server.js";
import { countLabel } from "./subagents-view.js";

/** A reading of the saved evidence. Opening the library never generates or saves a review. */
export interface Reflection {
  observation: string;
  preference: GuiPreference;
  lesson?: Lesson;
  sources: GuiPreference["occurrences"];
  scope: string;
  markdown: string;
}

/** Keep the conditions with the instruction when copying it into another session. */
function lessonScope(lesson: Lesson, project?: string): string {
  if (lesson.disposition === "historical") return "One-time note";
  if (lesson.disposition === "contextual")
    return project ? `For ${project}` : "For one project or tool";
  return "Across projects";
}

export function lessonMarkdown(lesson: Lesson, project?: string): string {
  return [
    `# ${lesson.title}`,
    lesson.instruction,
    `Scope: ${lessonScope(lesson, project)}`,
    lesson.applies_when && `Applies when: ${lesson.applies_when}`,
    lesson.exceptions && `Exceptions: ${lesson.exceptions}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function preferenceScope(preference: GuiPreference): string {
  const { project, scope } = preference.review;
  if (scope === "project") return project ? `For ${project}` : "For one project";
  if (scope === "task") return project ? `For this task in ${project}` : "For this task only";
  return "Across projects";
}

export function preferenceMarkdown(preference: GuiPreference): string {
  const text = `- ${preference.review.text}`;
  return preference.review.scope === "global"
    ? text
    : `${text}\n  Scope: ${preferenceScope(preference)}`;
}

/** Latest reusable observation first. A library of one-time notes keeps their task scope. */
export function latestReflection(
  preferences: readonly GuiPreference[],
  lessons: readonly Lesson[],
  projectsByLesson: ReadonlyMap<string, string>,
): Reflection | undefined {
  const current = new Map(preferences.map((preference) => [preference.id, preference]));
  const bySource = new Map<string, Lesson>();
  for (const lesson of lessons) {
    if (
      !lesson.source_ids.every((id) => {
        const source = current.get(id);
        return source && source.review.status !== "dismissed" && !source.review.stale;
      })
    )
      continue;
    for (const id of lesson.source_ids) bySource.set(id, lesson);
  }
  const [latest] = preferences
    .filter((pref) => pref.review.status !== "dismissed" && !pref.review.stale)
    .map((preference) => ({
      preference,
      reusable:
        bySource.get(preference.id)?.disposition !== "historical" &&
        preference.review.scope !== "task",
      seenAt:
        preference.occurrences.reduce(
          (last, source) => (source.timestamp && source.timestamp > last ? source.timestamp : last),
          "",
        ) || preference.lastAuthoredAt,
    }))
    .sort(
      (a, b) =>
        Number(b.reusable) - Number(a.reusable) ||
        b.seenAt.localeCompare(a.seenAt) ||
        b.preference.count - a.preference.count ||
        a.preference.id.localeCompare(b.preference.id),
    );
  if (!latest) return undefined;
  const { preference } = latest;
  const lesson = bySource.get(preference.id);
  const sourcePrefs = lesson
    ? [...new Set(lesson.source_ids)].flatMap((id) => current.get(id) ?? [])
    : [preference];
  const sourceRows = new Map<string, GuiPreference["occurrences"][number]>();
  for (const row of sourcePrefs.flatMap((pref) => pref.occurrences)) {
    sourceRows.set(
      JSON.stringify([row.exportName ?? row.slug, row.messageId, row.quote ?? row.evidence]),
      row,
    );
  }
  const sources = [...sourceRows.values()];
  const taskTitles = [
    ...new Set(preference.occurrences.filter((row) => row.available).map((row) => row.title)),
  ];
  const work = taskTitles
    .slice(0, 2)
    .map((title) => `“${title}”`)
    .join(" and ");
  const support = countLabel(preference.count, preference.verified ? "session" : "task");
  const lead = preference.verified
    ? `${preference.count === 1 ? "One session" : `${preference.count} sessions`}${work ? ` on ${work}` : " in your history"} ${preference.count === 1 ? "points" : "point"} to this preference.`
    : `Your earlier library recorded this preference in ${support}${work ? `, including ${work}` : ""}.`;
  // Digests keep the model's explanation alongside the original quotation. Show
  // the explanation when it adds context; leave the quotations in the disclosure.
  const explanation = [...preference.occurrences]
    .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))
    .find(
      (row) =>
        row.quote &&
        row.evidence.trim() &&
        row.evidence.trim() !== row.quote.trim() &&
        row.evidence.trim() !== preference.text.trim(),
    )?.evidence;
  const project = lesson ? projectsByLesson.get(lesson.id) : undefined;
  const scope = lesson
    ? [
        lessonScope(lesson, project),
        lesson.applies_when,
        lesson.exceptions && `Exceptions: ${lesson.exceptions}`,
      ]
        .filter(Boolean)
        .join(" · ")
    : preferenceScope(preference);
  return {
    observation: explanation?.trim() || `${lead} ${preference.text.trim()}`,
    preference,
    lesson,
    sources,
    scope,
    markdown: lesson ? lessonMarkdown(lesson, project) : preferenceMarkdown(preference),
  };
}
