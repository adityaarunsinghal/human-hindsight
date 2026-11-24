import type { GeneralizeOutput } from "./prompts/generalize.js";
import type { ProposeOutput } from "./prompts/propose.js";

/**
 * distill/aliases.ts: short names for identifiers a model must hand back.
 *
 * A model asked to copy a 64-character hash, or an 80-character lesson id,
 * sometimes returns it mangled, and the call then fails its checks. So a call
 * shows each identifier under a short alias (`p1`, `p2`, ... for preference
 * candidates, `L1`, `L2`, ... for lessons) and every answer is translated
 * back to the real identifiers before anything is checkpointed or saved.
 *
 * Checks run on the answer as the model wrote it, against the aliases it was
 * shown, so a correction names only identifiers the model has seen and an
 * alias the call did not contain is still a check failure. Saved artifacts,
 * window reuse keys and prompt instructions are unchanged: only the identifier
 * values in the request differ.
 */

export interface Aliases {
  /** Real identifier to its alias. */
  readonly alias: ReadonlyMap<string, string>;
  /** Alias to its real identifier. */
  readonly real: ReadonlyMap<string, string>;
}

/** Number the identifiers in order: `${prefix}1`, `${prefix}2`, ... */
export function aliasesFor(ids: readonly string[], prefix: string): Aliases {
  const alias = new Map<string, string>();
  const real = new Map<string, string>();
  for (const id of ids) {
    if (alias.has(id)) continue;
    const name = `${prefix}${alias.size + 1}`;
    alias.set(id, name);
    real.set(name, id);
  }
  return { alias, real };
}

/** Replace each item's `id` with its alias. */
export function withAliases<T extends { id: string }>(items: readonly T[], aliases: Aliases): T[] {
  return items.map((item) => ({ ...item, id: aliases.alias.get(item.id) ?? item.id }));
}

/** Real identifiers for aliases; a name that is not an alias is kept as it is. */
export function realIds(ids: readonly string[], aliases: Aliases): string[] {
  return ids.map((id) => aliases.real.get(id) ?? id);
}

/** A generalize answer with real input ids in every `source_ids`. */
export function realGeneralize(value: GeneralizeOutput, aliases: Aliases): GeneralizeOutput {
  return {
    lessons: value.lessons.map((lesson) => ({
      ...lesson,
      source_ids: realIds(lesson.source_ids, aliases),
    })),
    set_aside: value.set_aside.map((item) => ({
      ...item,
      source_ids: realIds(item.source_ids, aliases),
    })),
  };
}

/** A propose answer with real lesson ids in roles, `shared` and playbooks. */
export function realProposal(value: ProposeOutput, aliases: Aliases): ProposeOutput {
  return {
    ...value,
    roles: value.roles.map((role) => ({ ...role, lesson_ids: realIds(role.lesson_ids, aliases) })),
    shared: realIds(value.shared, aliases),
    playbooks: value.playbooks.map((playbook) => ({
      ...playbook,
      lesson_ids: realIds(playbook.lesson_ids, aliases),
    })),
  };
}
