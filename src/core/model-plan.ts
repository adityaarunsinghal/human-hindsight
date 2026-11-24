import type { ModelCatalog, RunnerName } from "../runners/types.js";

export type Quality = "balanced" | "best";
export type ModelRole = "bulk" | "major";
export type Tier = "light" | "heavy" | "frontier";
export type PlanLabel = `${Quality}/${ModelRole}`;

export interface ResolvedRole {
  tier: Tier | "default";
  /** Omitted when the CLI should select its configured default. */
  model?: string;
  display: string;
  steppedDownFrom?: Tier;
  reason?: string;
}

export interface RunnerModelPlan {
  runner: RunnerName;
  quality: Quality;
  roles: Record<ModelRole, ResolvedRole>;
  notes: string[];
}

export function parseQuality(raw?: string): Quality {
  const value = (raw ?? process.env.HUMAN_HINDSIGHT_QUALITY ?? "balanced").trim().toLowerCase();
  if (value === "balanced" || value === "best") return value;
  throw new Error(`Unknown quality "${value}". Choose --quality balanced or --quality best.`);
}

export function isPlanLabel(value: string | undefined): value is PlanLabel {
  return typeof value === "string" && /^(balanced|best)\/(bulk|major)$/.test(value);
}

export function planLabel(quality: Quality, role: ModelRole): PlanLabel {
  return `${quality}/${role}`;
}

const TIERS: readonly Tier[] = ["frontier", "heavy", "light"];
const FAMILIES: Record<Tier, readonly [string, string]> = {
  light: ["sonnet", "terra"],
  heavy: ["opus", "sol"],
  frontier: ["fable", "astra"],
};
const PLANS: Record<Quality, Record<ModelRole, Tier>> = {
  balanced: { bulk: "light", major: "heavy" },
  best: { bulk: "heavy", major: "frontier" },
};
/** Lane 0 is the Anthropic family set, lane 1 the OpenAI family set. */
type Lane = 0 | 1;
const VENDOR_WORDS = new Set(["claude", "anthropic", "gpt", "openai"]);

// Keep provider paths and routing qualifiers together. For example, the model
// part of "provider/region.openai.gpt-6.2-sol" starts at "gpt".
function parts(id: string): { route: string; name: string } {
  const lower = id.toLowerCase();
  const offset = lower.lastIndexOf("/") + 1;
  const base = lower.slice(offset);
  const dotted = base.search(/\.(?:gpt|claude|sonnet|terra|opus|sol|fable|astra)(?=$|[-_.\d])/);
  const start = dotted === -1 ? offset : offset + dotted + 1;
  return { route: lower.slice(0, start), name: lower.slice(start) };
}

function lane(name: string): Lane | undefined {
  const words = name.split(/[^a-z0-9]+/);
  if (words.some((word) => ["claude", "anthropic", "sonnet", "opus", "fable"].includes(word)))
    return 0;
  if (words.some((word) => ["gpt", "openai", "terra", "sol", "astra"].includes(word))) return 1;
  return undefined;
}

// Catalogs use both "family-5.10" and "5-10-family". The first version group
// excludes endpoint revisions such as "-v1:0".
function version(name: string): number[] {
  const group = name.match(/\d+(?:[._-]\d+)*/)?.[0];
  return group ? group.split(/[._-]/).map(Number) : [];
}

function compareVersion(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (b[i] ?? 0) - (a[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

interface Entry {
  id: string;
  route: string;
  tier: Tier;
  lane: Lane;
  version: number[];
  /** A dated snapshot ("-20251101"), as a number; undefined for an undated id. */
  date?: number;
}

const DATED = /(?:^|[-._@])(20\d{2})[-.]?(\d{2})[-.]?(\d{2})(?=$|[-._:@])/;

/**
 * A family member is a family word with only vendor words and version numbers
 * around it, plus an optional endpoint revision ("v1") and an optional date.
 * Variants with extra words ("gpt-5.7-sol-mini", "claude-opus-5-1m") are not
 * the family. A dated snapshot is a member that ranks below every undated one.
 */
function entry(id: string): Entry | undefined {
  const { route, name } = parts(id);
  const dated = name.match(DATED);
  const date = dated ? Number(`${dated[1]}${dated[2]}${dated[3]}`) : undefined;
  // The date is not part of the version: "4-5-20251101" is version 4.5.
  const undated = dated ? name.replace(DATED, "") : name;
  const words = name.split(/[^a-z0-9]+/).filter(Boolean);
  for (const tier of TIERS) {
    for (const [family, word] of FAMILIES[tier].entries()) {
      const at = words.indexOf(word);
      if (at < 0) continue;
      const before = words.slice(0, at).every((w) => VENDOR_WORDS.has(w) || /^\d+$/.test(w));
      const after = words.slice(at + 1).every((w) => /^\d+$/.test(w) || /^v\d+$/.test(w));
      if (!before || !after) return undefined;
      return { id, route, tier, lane: family as Lane, version: version(undated), date };
    }
  }
  return undefined;
}

/** The configured default, ignoring placeholders such as "auto". */
function configuredDefault(catalog: ModelCatalog): string | undefined {
  const value = catalog.defaultModel?.trim();
  if (!value || /^(auto|default)$/i.test(value) || isPlanLabel(value)) return undefined;
  return value;
}

interface Context {
  entries: Entry[];
  lane: Lane;
  defaultRoute?: string;
  /**
   * The default's provider or region prefix, "" for a default without one.
   * Every role stays on it: a default without a prefix selects only ids
   * without one.
   */
  fixedRoute?: string;
  defaultDisplay: string;
}

function context(runner: RunnerName, catalog: ModelCatalog): Context {
  const configured = configuredDefault(catalog);
  const ids = [...new Set([...catalog.ids, ...(configured ? [configured] : [])])];
  const own = configured ? parts(configured) : undefined;
  const ownLane = own ? lane(own.name) : undefined;
  // A configured default fixes the vendor family set and the prefix shape.
  const entries = ids.flatMap((id) => {
    const found = entry(id);
    if (!found) return [];
    if (own && found.route !== own.route) return [];
    if (ownLane !== undefined && found.lane !== ownLane) return [];
    return [found];
  });
  return {
    entries,
    // The lane follows the CLI's own default model; otherwise the CLI's usual lane.
    lane: ownLane ?? (runner === "codex" ? 1 : 0),
    defaultRoute: own?.route,
    fixedRoute: own?.route,
    defaultDisplay: configured ?? "CLI default",
  };
}

/** Best entry at one tier: preferred lane, then preferred route, then undated, then newest. */
function pick(ctx: Context, tier: Tier, route?: string, only?: string): Entry | undefined {
  return ctx.entries
    .filter((e) => e.tier === tier && (only === undefined || e.route === only))
    .sort(
      (a, b) =>
        Number(b.lane === ctx.lane) - Number(a.lane === ctx.lane) ||
        Number(b.route === route) - Number(a.route === route) ||
        // Undated ids first; among dated snapshots, the newest date.
        Number(a.date !== undefined) - Number(b.date !== undefined) ||
        (b.date ?? 0) - (a.date ?? 0) ||
        compareVersion(a.version, b.version) ||
        a.id.localeCompare(b.id),
    )[0];
}

function atOrBelow(ctx: Context, tier: Tier, route?: string, only?: string): ResolvedRole {
  for (const t of TIERS.slice(TIERS.indexOf(tier))) {
    const found = pick(ctx, t, route, only);
    if (found) return { tier: t, model: found.id, display: found.id };
  }
  return { tier: "default", display: ctx.defaultDisplay };
}

/**
 * One prefix for both roles when some prefix offers both requested tiers: the
 * default's prefix first, then the prefix with the newest major model.
 */
function sharedRoute(ctx: Context, tiers: Record<ModelRole, Tier>): string | undefined {
  const routes = [...new Set(ctx.entries.map((e) => e.route))].filter(
    (route) => pick(ctx, tiers.bulk, route, route) && pick(ctx, tiers.major, route, route),
  );
  if (ctx.defaultRoute !== undefined && routes.includes(ctx.defaultRoute)) return ctx.defaultRoute;
  const newest = (route: string, role: ModelRole) =>
    (pick(ctx, tiers[role], route, route) as Entry).version;
  return routes.sort(
    (a, b) =>
      compareVersion(newest(a, "major"), newest(b, "major")) ||
      compareVersion(newest(a, "bulk"), newest(b, "bulk")) ||
      a.localeCompare(b),
  )[0];
}

export function planModels(
  runner: RunnerName,
  catalog: ModelCatalog,
  quality: Quality,
): RunnerModelPlan {
  const ctx = context(runner, catalog);
  const tiers = PLANS[quality];
  // The person chose the default's prefix; only without one may roles mix prefixes.
  const shared = ctx.fixedRoute ?? sharedRoute(ctx, tiers);
  const notes: string[] = [];
  const resolve = (key: ModelRole): ResolvedRole => {
    const requested = tiers[key];
    const resolved =
      shared !== undefined
        ? atOrBelow(ctx, requested, shared, shared)
        : atOrBelow(ctx, requested, ctx.defaultRoute);
    if (resolved.tier === requested) return resolved;
    const purpose = key === "bulk" ? "session reads" : "grouping and writing";
    const where = ctx.fixedRoute
      ? `under the ${ctx.fixedRoute} prefix`
      : ctx.fixedRoute === ""
        ? `among ids like ${ctx.defaultDisplay}`
        : "in this CLI's catalog";
    const reason = `No ${requested} model ${where} for ${purpose}. Using ${resolved.display}.`;
    if (ctx.entries.length) notes.push(reason);
    return { ...resolved, steppedDownFrom: requested, reason };
  };
  const roles = { bulk: resolve("bulk"), major: resolve("major") };
  if (!ctx.entries.length) {
    const named = ctx.defaultDisplay === "CLI default" ? "" : ` (${ctx.defaultDisplay})`;
    notes.push(
      catalog.ids.length
        ? `No listed model matches a known family, so every step uses the CLI's own default model${named}.`
        : `This CLI did not list its models, so every step uses its own default model${named}.`,
    );
  }
  return { runner, quality, roles, notes };
}

/** True when Balanced and Best resolve to different models for some role. */
export function offersQualityChoice(plans: Record<Quality, RunnerModelPlan>): boolean {
  return (["bulk", "major"] as const).some(
    (key) => plans.balanced.roles[key].display !== plans.best.roles[key].display,
  );
}

/** Move below the rejected tier, on the same prefix when possible, ending with the CLI default. */
export function stepDown(
  role: ResolvedRole,
  catalog: ModelCatalog,
  runner: RunnerName,
): ResolvedRole | null {
  if (role.tier === "default") return null;
  const ctx = context(runner, catalog);
  const below = TIERS[TIERS.indexOf(role.tier) + 1];
  const route = role.model ? parts(role.model).route : ctx.defaultRoute;
  const next: ResolvedRole = below
    ? atOrBelow(ctx, below, route, ctx.fixedRoute)
    : { tier: "default", display: ctx.defaultDisplay };
  const defaultNote =
    next.tier === "default" && next.display !== "CLI default" ? " (CLI default)" : "";
  return {
    ...next,
    steppedDownFrom: role.tier,
    reason: `${role.display} was unavailable. Using ${next.display}${defaultNote}.`,
  };
}
