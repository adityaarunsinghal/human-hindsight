import { z } from "zod";
import { HISTORICAL_DATA_INSTRUCTION } from "../../core/preference-evidence.js";
import type { SuggestionInput } from "../../core/subagents.js";

/**
 * suggest-subagents stage A: generalize prompt builder.
 *
 * One call per window of preference candidates (the command sizes windows by
 * `--input-budget` over {@link renderGeneralizeInput} lines). Each input either
 * becomes part of a portable lesson or is set aside with a reason. Several
 * inputs that say the same thing merge into one lesson. The disposition keeps
 * project facts out of portable text: `generalized` lessons must read the same
 * in any project, `contextual` ones only make sense inside a named project or
 * tool, and `historical` ones record a one-time situation or permission.
 *
 * The response schema is structural only (types and the disposition enum).
 * Field bounds, coverage of the window's ids and project-name checks are rules
 * G1 to G3 in `core/subagent-checks.ts`, so a violation goes back to the model
 * as one targeted correction instead of a generic schema failure. Lessons carry
 * no id here; the command assigns final ids after every window has run.
 *
 * `GENERALIZE_PROMPT_VERSION` is saved in `suggestion.json` as
 * `prompt_versions.generalize` and must equal `SUGGEST_PROMPT_VERSIONS.generalize`
 * in `core/subagents.ts`. Bump both on any meaningful change to the prompt text.
 */
export const GENERALIZE_PROMPT_VERSION = 1;

export const GeneralizeLessonSchema = z.object({
  title: z.string(),
  instruction: z.string(),
  applies_when: z.string(),
  exceptions: z.string(),
  disposition: z.enum(["generalized", "contextual", "historical"]),
  source_ids: z.array(z.string()),
});
export type GeneralizedLesson = z.infer<typeof GeneralizeLessonSchema>;

export const GeneralizeSchema = z.object({
  lessons: z.array(GeneralizeLessonSchema),
  set_aside: z.array(z.object({ source_ids: z.array(z.string()), reason: z.string() })),
});
export type GeneralizeOutput = z.infer<typeof GeneralizeSchema>;

/** One input as the model sees it: a JSON line. Also the unit the window budget measures. */
export function renderGeneralizeInput(input: SuggestionInput): string {
  return JSON.stringify({
    id: input.id,
    text: input.text,
    count: input.count,
    scope: input.scope ?? "global",
    project: input.scope && input.scope !== "global" ? (input.project ?? "") : "",
    domain: input.domain ?? "",
    quote: input.quote ?? "",
  });
}

/** Build the stage A prompt for one window of inputs. */
export function buildGeneralizePrompt(inputs: SuggestionInput[], projects: string[]): string {
  return [
    "You are turning one person's working preferences into portable lessons for",
    "specialist coding agents.",
    HISTORICAL_DATA_INSTRUCTION,
    "Each input below is a preference candidate observed in their sessions: its id,",
    "its text, how many sessions it was seen in, its scope (global, project or task),",
    "the project it was seen in, a domain path, and one supporting quotation.",
    "",
    "Put every input into a lesson or set it aside:",
    "- Merge inputs that say the same thing into one lesson that lists all of their ids.",
    "- Each lesson has:",
    '  - "title": one line, at most 80 characters.',
    '  - "instruction": what to do, 40 to 900 characters, in plain imperative sentences.',
    '  - "applies_when": when the instruction applies, at most 300 characters.',
    '  - "exceptions": when not to apply it, at most 300 characters, or "" when there is',
    "    none. Write one whenever a reasonable reader would over-apply the rule.",
    '  - "disposition": "generalized" when it holds across projects and tools;',
    '    "contextual" when it only makes sense inside a named project or tool;',
    '    "historical" when it records a one-time situation, a permission, or a fact',
    "    that may no longer be true.",
    '  - "source_ids": the ids of the inputs it represents.',
    "- Keep generalized lessons free of project names, people, file paths and dates.",
    "  Contextual and historical lessons may name them.",
    "- Preserve conditions, exceptions and negation. Do not strengthen a preference",
    '  ("prefer") into a rule ("always").',
    "- Set aside an input that holds no reusable instruction, such as an acknowledgement",
    '  or a one-off file name, with a one-sentence "reason" of at most 500 characters.',
    "- Every input id appears exactly once across all lessons and set-asides. Use only",
    "  the ids listed below and copy them verbatim.",
    "",
    `Project names in this library (keep them out of generalized lessons): ${
      projects.length ? projects.join(", ") : "none recorded"
    }`,
    "",
    `=== INPUTS (${inputs.length}) ===`,
    ...inputs.map(renderGeneralizeInput),
    "=== END INPUTS ===",
  ].join("\n");
}
