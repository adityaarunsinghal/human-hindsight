import { describe, expect, it } from "vitest";
import {
  isPlanLabel,
  offersQualityChoice,
  parseQuality,
  planModels,
  type Quality,
  stepDown,
} from "../src/core/model-plan.js";
import type { ModelCatalog, RunnerName } from "../src/runners/types.js";

// Every id below is a synthetic shape taken from the design rules. "default"
// in an expectation means the role makes a call with no model argument.
const catalog = (ids: string[], defaultModel?: string): ModelCatalog => ({
  ids,
  defaultModel,
  source: ids.length ? "catalog" : "none",
});
const ALIASES: ModelCatalog = { ids: ["sonnet", "opus", "fable"], source: "aliases" };
const MIXED = [
  "claude-sonnet-5.5",
  "claude-opus-5",
  "claude-opus-4.8",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
];
const REGIONS = ["us.openai.gpt-6.2-sol", "global.openai.gpt-6.1-terra", "us.openai.gpt-6-astra"];
const BEDROCK = [
  "amazon-bedrock/global.anthropic.claude-opus-5",
  "amazon-bedrock/anthropic.claude-opus-4-5-20251101-v1:0",
  "amazon-bedrock/eu.anthropic.claude-sonnet-4-6",
];
const SAME_FAMILIES_TWO_REGIONS = [
  "us.anthropic.claude-sonnet-5",
  "us.anthropic.claude-opus-5",
  "global.anthropic.claude-sonnet-5.5",
  "global.anthropic.claude-opus-4.8",
];

type Row = [string, RunnerName, ModelCatalog, Quality, string, string];
const rows: Row[] = [
  ["Claude aliases, balanced", "claude", ALIASES, "balanced", "sonnet", "opus"],
  ["Claude aliases, best", "claude", ALIASES, "best", "opus", "fable"],
  [
    "Claude aliases without fable",
    "claude",
    { ids: ["sonnet", "opus"], source: "aliases" },
    "best",
    "opus",
    "opus",
  ],
  [
    "anthropic lane for OpenCode without a default",
    "opencode",
    catalog(MIXED),
    "balanced",
    "claude-sonnet-5.5",
    "claude-opus-5",
  ],
  [
    "opus 5 outranks opus 4.8",
    "opencode",
    catalog(MIXED),
    "best",
    "claude-opus-5",
    "claude-opus-5",
  ],
  [
    "openai lane for Codex without a default",
    "codex",
    catalog(MIXED),
    "balanced",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
  ],
  [
    "Kiro lane follows an OpenAI default",
    "kiro",
    catalog(MIXED, "gpt-5.6-sol"),
    "balanced",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
  ],
  [
    "Kiro lane follows an Anthropic default",
    "kiro",
    catalog(MIXED, "claude-opus-5"),
    "balanced",
    "claude-sonnet-5.5",
    "claude-opus-5",
  ],
  [
    "Kiro without a default prefers Anthropic",
    "kiro",
    catalog(MIXED),
    "balanced",
    "claude-sonnet-5.5",
    "claude-opus-5",
  ],
  [
    "OpenCode lane follows its default",
    "opencode",
    catalog(MIXED, "gpt-5.6-terra"),
    "balanced",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
  ],
  // us offers sol and astra; the configured astra is itself a candidate.
  [
    "regions, best, default in us",
    "codex",
    catalog(REGIONS, "us.openai.gpt-6.2-astra"),
    "best",
    "us.openai.gpt-6.2-sol",
    "us.openai.gpt-6.2-astra",
  ],
  [
    "regions, best, no default",
    "codex",
    catalog(REGIONS),
    "best",
    "us.openai.gpt-6.2-sol",
    "us.openai.gpt-6-astra",
  ],
  // No single prefix offers both light and heavy, so each role takes its own tier.
  [
    // The person chose the us. prefix: the only Terra is global., so reads use the CLI default.
    "regions, balanced, default in us never leaves us",
    "codex",
    catalog(REGIONS, "us.openai.gpt-6.2-astra"),
    "balanced",
    "default",
    "us.openai.gpt-6.2-sol",
  ],
  [
    "a default prefix offering one tier steps down within it",
    "codex",
    catalog(
      ["us.openai.gpt-6.2-sol", "global.openai.gpt-6.1-terra", "global.openai.gpt-6.2-astra"],
      "us.openai.gpt-6.2-sol",
    ),
    "best",
    "us.openai.gpt-6.2-sol",
    "us.openai.gpt-6.2-sol",
  ],
  [
    "a default prefix offering nothing uses the CLI default for both roles",
    "opencode",
    catalog(BEDROCK, "amazon-bedrock/apac.anthropic.claude-fable-5"),
    "balanced",
    "default",
    "default",
  ],
  [
    "a dated default is itself a candidate on its prefix",
    "opencode",
    catalog(BEDROCK, "amazon-bedrock/apac.anthropic.claude-sonnet-4-5-20250929"),
    "balanced",
    "amazon-bedrock/apac.anthropic.claude-sonnet-4-5-20250929",
    "amazon-bedrock/apac.anthropic.claude-sonnet-4-5-20250929",
  ],
  // A default without a prefix selects only ids without one, from its own vendor.
  [
    "a default without a prefix keeps Best on its vendor and shape",
    "kiro",
    catalog([...MIXED.slice(0, 3), ...REGIONS], "claude-sonnet-5.5"),
    "best",
    "claude-opus-5",
    "claude-opus-5",
  ],
  [
    "a default without a prefix keeps Balanced on its vendor and shape",
    "kiro",
    catalog(["claude-opus-5", ...REGIONS], "claude-opus-5"),
    "balanced",
    "default",
    "claude-opus-5",
  ],
  // A default with a prefix selects only ids with that same prefix, from its own vendor.
  [
    "a prefixed default keeps every role on its prefix and vendor",
    "kiro",
    catalog(
      ["us.anthropic.claude-opus-5", "claude-fable-5", "us.openai.gpt-6-astra"],
      "us.anthropic.claude-sonnet-5",
    ),
    "best",
    "us.anthropic.claude-opus-5",
    "us.anthropic.claude-opus-5",
  ],
  [
    "regions, balanced, no default",
    "codex",
    catalog(REGIONS),
    "balanced",
    "global.openai.gpt-6.1-terra",
    "us.openai.gpt-6.2-sol",
  ],
  [
    "one prefix offers both, no default: highest major wins",
    "kiro",
    catalog(SAME_FAMILIES_TWO_REGIONS),
    "balanced",
    "us.anthropic.claude-sonnet-5",
    "us.anthropic.claude-opus-5",
  ],
  [
    "one prefix offers both, default picks the prefix",
    "kiro",
    catalog(SAME_FAMILIES_TWO_REGIONS, "global.anthropic.claude-sonnet-5.5"),
    "balanced",
    "global.anthropic.claude-sonnet-5.5",
    "global.anthropic.claude-opus-4.8",
  ],
  [
    "Bedrock paths, dated ids skipped",
    "opencode",
    catalog(BEDROCK),
    "balanced",
    "amazon-bedrock/eu.anthropic.claude-sonnet-4-6",
    "amazon-bedrock/global.anthropic.claude-opus-5",
  ],
  [
    "Bedrock paths, best",
    "opencode",
    catalog(BEDROCK, "amazon-bedrock/eu.anthropic.claude-sonnet-4-6"),
    "best",
    "amazon-bedrock/eu.anthropic.claude-sonnet-4-6",
    "amazon-bedrock/eu.anthropic.claude-sonnet-4-6",
  ],
  [
    "a -mini variant is not the family",
    "codex",
    catalog(["gpt-5.7-sol-mini", "gpt-5.6-sol", "gpt-5.6-terra"]),
    "balanced",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
  ],
  [
    "a -1m variant is not the family",
    "kiro",
    catalog(["claude-opus-5-1m", "claude-opus-4.8", "claude-sonnet-5"]),
    "balanced",
    "claude-sonnet-5",
    "claude-opus-4.8",
  ],
  [
    "an endpoint revision is not a variant",
    "kiro",
    catalog(["us.anthropic.claude-opus-4-6-v1:0", "us.anthropic.claude-sonnet-4-6-v1:0"]),
    "balanced",
    "us.anthropic.claude-sonnet-4-6-v1:0",
    "us.anthropic.claude-opus-4-6-v1:0",
  ],
  // Undated ids rank above dated ones; a family listed only with dated ids uses the newest date.
  [
    "a family with only dated ids uses the newest date",
    "opencode",
    catalog([
      "anthropic/claude-sonnet-4-20250514",
      "anthropic/claude-sonnet-4-5-20250929",
      "anthropic/claude-opus-5-20260101",
      "anthropic/claude-opus-4-1",
    ]),
    "balanced",
    "anthropic/claude-sonnet-4-5-20250929",
    "anthropic/claude-opus-4-1",
  ],
  [
    "Bedrock paths with only dated ids",
    "opencode",
    catalog([
      "amazon-bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0",
      "amazon-bedrock/anthropic.claude-opus-4-5-20251101-v1:0",
    ]),
    "balanced",
    "amazon-bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0",
    "amazon-bedrock/anthropic.claude-opus-4-5-20251101-v1:0",
  ],
  [
    "a default of auto is ignored",
    "codex",
    catalog(["gpt-5.6-sol", "gpt-5.6-terra", "claude-sonnet-5.5"], "auto"),
    "balanced",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
  ],
  ["an empty catalog", "codex", catalog([]), "best", "default", "default"],
];

describe("planModels", () => {
  it.each(rows)("%s", (_name, runner, input, quality, bulk, major) => {
    const plan = planModels(runner, input, quality);
    expect([plan.roles.bulk.model ?? "default", plan.roles.major.model ?? "default"]).toEqual([
      bulk,
      major,
    ]);
    expect(plan.runner).toBe(runner);
    expect(plan.quality).toBe(quality);
    for (const role of Object.values(plan.roles)) {
      expect(isPlanLabel(role.model)).toBe(false);
      expect(role.display).toBe(role.model ?? role.display);
    }
  });

  it("records a step down from the requested tier with a reason", () => {
    const plan = planModels("claude", { ids: ["sonnet", "opus"], source: "aliases" }, "best");
    expect(plan.roles.major).toMatchObject({
      tier: "heavy",
      model: "opus",
      steppedDownFrom: "frontier",
    });
    expect(plan.roles.major.reason).toContain("opus");
    expect(plan.notes).toEqual([plan.roles.major.reason]);
    expect(plan.roles.bulk.steppedDownFrom).toBeUndefined();
  });

  it("names the configured default when nothing else fits, and never shows auto", () => {
    const known = planModels("codex", catalog([], "gpt-5.6-sol"), "balanced");
    expect(known.roles.bulk).toMatchObject({ tier: "default", display: "gpt-5.6-sol" });
    expect(known.roles.bulk.model).toBeUndefined();
    const auto = planModels("codex", catalog([], "auto"), "balanced");
    expect(auto.roles.major.display).toBe("CLI default");
  });

  it("with no model list, says once that the CLI default is used and offers no choice", () => {
    const empty = catalog([]);
    const plans = {
      fast: planModels("kiro", empty, "fast"),
      balanced: planModels("kiro", empty, "balanced"),
      best: planModels("kiro", empty, "best"),
    };
    for (const plan of Object.values(plans)) {
      expect(plan.notes).toHaveLength(1);
      expect(plan.notes[0]).toMatch(/did not list its models.*own default model/);
    }
    expect(offersQualityChoice(plans)).toBe(false);
    const listed = {
      fast: planModels("claude", ALIASES, "fast"),
      balanced: planModels("claude", ALIASES, "balanced"),
      best: planModels("claude", ALIASES, "best"),
    };
    expect(offersQualityChoice(listed)).toBe(true);
  });
});

describe("default prefix", () => {
  it("names the tier that was not offered under the default's prefix", () => {
    const plan = planModels("codex", catalog(REGIONS, "us.openai.gpt-6.2-astra"), "balanced");
    expect(plan.roles.bulk).toMatchObject({
      tier: "default",
      display: "us.openai.gpt-6.2-astra",
      steppedDownFrom: "light",
    });
    expect(plan.notes).toEqual([
      "No light model under the us.openai. prefix for session reads. Using us.openai.gpt-6.2-astra.",
    ]);
  });

  it("step-down never leaves the default's prefix", () => {
    const input = catalog(REGIONS, "us.openai.gpt-6.2-astra");
    const role = {
      tier: "heavy" as const,
      model: "us.openai.gpt-6.2-sol",
      display: "us.openai.gpt-6.2-sol",
    };
    expect(stepDown(role, input, "codex")).toMatchObject({
      tier: "default",
      display: "us.openai.gpt-6.2-astra",
    });
  });
});

describe("stepDown", () => {
  it("with a default without a prefix, never moves to a prefixed id or another vendor", () => {
    const input = catalog([...MIXED.slice(0, 3), ...REGIONS], "claude-sonnet-5.5");
    const role = { tier: "frontier" as const, model: "claude-fable-5", display: "claude-fable-5" };
    const heavy = stepDown(role, input, "kiro");
    expect(heavy?.model).toBe("claude-opus-5");
    const light = heavy && stepDown(heavy, input, "kiro");
    expect(light?.model).toBe("claude-sonnet-5.5");
  });

  it("walks frontier, heavy, light, then the CLI default, then stops", () => {
    let role = planModels("claude", ALIASES, "best").roles.major;
    const seen = [role.model];
    for (;;) {
      const next = stepDown(role, ALIASES, "claude");
      if (!next) break;
      expect(next.steppedDownFrom).toBe(role.tier);
      expect(next.reason).toContain(`${role.display} was unavailable`);
      seen.push(next.model);
      role = next;
    }
    expect(seen).toEqual(["fable", "opus", "sonnet", undefined]);
  });

  it("stays on the rejected model's prefix", () => {
    const input = catalog(SAME_FAMILIES_TWO_REGIONS);
    const role = {
      tier: "heavy" as const,
      model: "global.anthropic.claude-opus-4.8",
      display: "global.anthropic.claude-opus-4.8",
    };
    expect(stepDown(role, input, "kiro")?.model).toBe("global.anthropic.claude-sonnet-5.5");
  });

  it("marks a named CLI default", () => {
    const role = { tier: "light" as const, model: "gpt-5.6-terra", display: "gpt-5.6-terra" };
    const next = stepDown(role, catalog(["gpt-5.6-terra"], "gpt-5.6-sol"), "codex");
    expect(next).toMatchObject({ tier: "default", display: "gpt-5.6-sol" });
    expect(next?.reason).toBe("gpt-5.6-terra was unavailable. Using gpt-5.6-sol (CLI default).");
  });
});

describe("labels and quality", () => {
  it.each([
    ["balanced/bulk", true],
    ["best/major", true],
    ["Best/major", false],
    ["balanced", false],
    ["opus", false],
    [undefined, false],
  ] as const)("isPlanLabel(%s) is %s", (value, expected) => {
    expect(isPlanLabel(value)).toBe(expected);
  });

  it("parses quality and rejects unknown values", () => {
    expect(parseQuality(" Best ")).toBe("best");
    expect(parseQuality(undefined)).toBe("balanced");
    expect(parseQuality("FAST")).toBe("fast");
    expect(() => parseQuality("quick")).toThrow(
      /--quality fast, --quality balanced, or --quality best/,
    );
  });
});
