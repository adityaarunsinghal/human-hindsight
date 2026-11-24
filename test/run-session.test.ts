import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPlanLabel } from "../src/core/model-plan.js";
import { openRunSession, type RunSessionOptions } from "../src/core/run-session.js";
import { renderPlan } from "../src/distill/consent.js";
import { AgentRunnerError } from "../src/runners/shared.js";
import type { AgentRunner, ModelCatalog, RunnerName, RunOptions } from "../src/runners/types.js";
import { fakeOutput } from "./support/tty.js";

// Prepared fake runners replace local discovery, so nothing here looks for or
// starts a real CLI.
interface Fake extends AgentRunner {
  models: (string | undefined)[];
  timeouts: (number | undefined)[];
}
const fakes: Fake[] = [];

function fake(
  name: RunnerName,
  catalog: ModelCatalog,
  script: (opts: RunOptions<unknown>) => Promise<unknown> = async () => ({ ok: true }),
): Fake {
  const runner: Fake = {
    name,
    installHint: "",
    models: [],
    timeouts: [],
    listModels: async () => catalog,
    version: async () => "1.2.3",
    run: async <T>(opts: RunOptions<T>) => {
      runner.models.push(opts.model);
      runner.timeouts.push(opts.timeoutMs);
      return (await script(opts as RunOptions<unknown>)) as T;
    },
  };
  fakes.push(runner);
  return runner;
}

const ALIASES: ModelCatalog = { ids: ["sonnet", "opus", "fable"], source: "aliases" };
const CODEX: ModelCatalog = { ids: ["gpt-5.6-terra", "gpt-5.6-sol"], source: "catalog" };
const NONE: ModelCatalog = { ids: [], source: "none" };
// Both roles resolve to one model, so the readiness check makes one call.
const ONE: ModelCatalog = { ids: ["sonnet"], source: "aliases" };
const ONE_CODEX: ModelCatalog = { ids: ["gpt-5.6-terra"], source: "catalog" };
const failing = (kind: string) => async () => {
  throw Object.assign(new Error(`${kind} failure`), { kind });
};

function open(runners: AgentRunner[], o: Partial<RunSessionOptions> = {}) {
  const output = fakeOutput();
  const session = openRunSession({
    home: "/nonexistent-home",
    quality: "balanced",
    explicit: {},
    sessionShare: {},
    output,
    runners,
    ...o,
  });
  return { session, output };
}

afterEach(() => {
  delete process.env.HUMAN_HINDSIGHT_SUBAGENT_MODEL;
  for (const runner of fakes.splice(0)) {
    for (const model of runner.models) expect(isPlanLabel(model)).toBe(false);
  }
});

describe("openRunSession pinning", () => {
  it("a menu choice uses the discovered catalog once and stays on that CLI when it exhausts its quota", async () => {
    const claude = fake("claude", ALIASES);
    const codex = fake("codex", ONE_CODEX, failing("quota"));
    const list = vi.spyOn(codex, "listModels");
    const unavailable = fake("opencode", NONE);
    unavailable.preflight = async () => {
      throw new Error("CLI lacks a required flag");
    };
    const automatic = await open([claude, codex, unavailable]).session;
    expect(automatic.runnerChoices.map(({ name }) => name)).toEqual(["claude", "codex"]);
    const chosen = automatic.runnerChoices[1]?.select();
    expect(chosen?.identityRunner).toBe("codex");
    expect(chosen?.describe()).toMatchObject({
      pinned: true,
      alsoReady: [],
      plans: { balanced: { bulk: "gpt-5.6-terra" } },
    });
    expect(codex.models).toEqual([]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(await chosen?.liveCheck()).toMatchObject({
      ok: false,
      line: expect.stringContaining("Run npx human-hindsight reflect to choose another CLI."),
    });
    expect(claude.models).toEqual([]);
    await chosen?.finalize();
  });
  it("an automatic session discloses the other ready CLIs and uses plan labels", async () => {
    const { session } = open([fake("claude", ALIASES), fake("codex", CODEX)]);
    const s = await session;
    expect(s.pinned).toBe(false);
    expect(s.identityRunner).toBeNull();
    expect(s.modelFor("digest")).toBe("balanced/bulk");
    expect(s.modelFor("author")).toBe("balanced/major");
    const d = s.describe();
    expect(d).toMatchObject({
      runnerLine: "Claude Code (claude 1.2.3)",
      alsoReady: ["Codex"],
      pinned: false,
      qualityChoice: true,
    });
    expect(d.plans.balanced).toMatchObject({ bulk: "sonnet", major: "opus" });
    expect(d.plans.best).toMatchObject({ bulk: "opus", major: "fable" });
  });

  it("--author-model alone pins the session", async () => {
    const claude = fake("claude", ALIASES);
    const codex = fake("codex", CODEX);
    const s = await open([claude, codex], { explicit: { author: "claude-opus-5" } }).session;
    expect(s.pinned).toBe(true);
    expect(s.identityRunner).toBe("claude");
    expect(s.modelFor("author")).toBe("claude-opus-5");
    expect(s.modelFor("digest")).toBe("balanced/bulk");
    expect(s.describe()).toMatchObject({ alsoReady: [], pinned: true });
    // The plan screen names the flag's model for the writing step.
    expect(s.displayModelFor("author")).toBe("claude-opus-5");
  });

  it("the subagent model environment variable pins the session", async () => {
    process.env.HUMAN_HINDSIGHT_SUBAGENT_MODEL = "gpt-5.6-sol";
    const s = await open([fake("claude", ALIASES), fake("codex", CODEX)]).session;
    expect(s.pinned).toBe(true);
    expect(s.modelFor("propose")).toBe("gpt-5.6-sol");
    expect(s.modelFor("digest")).toBe("balanced/bulk");
  });

  it("strict retries ignore the subagent model environment variable", async () => {
    process.env.HUMAN_HINDSIGHT_SUBAGENT_MODEL = "gpt-5.6-sol";
    const s = await open([fake("claude", ALIASES), fake("codex", CODEX)], {
      ignoreWorkflowDefaults: true,
    }).session;
    expect(s.pinned).toBe(false);
  });

  it.each([
    [{ model: "best/major" }, "--model"],
    [{ author: " Balanced/Bulk " }, "--author-model"],
  ])("rejects a plan label passed as an explicit model (%j)", async (explicit, flag) => {
    await expect(open([fake("claude", ALIASES)], { explicit }).session).rejects.toThrow(
      `Use a concrete CLI model for ${flag}`,
    );
  });

  it("an explicit model offers no quality choice", async () => {
    const s = await open([fake("claude", ALIASES)], { explicit: { model: "opus" } }).session;
    expect(s.describe()).toMatchObject({
      qualityChoice: false,
      plans: { balanced: { bulk: "opus" }, best: { major: "opus" } },
    });
  });

  it("with no model list, both plans name the CLI default and offer no choice", async () => {
    const s = await open([fake("kiro", NONE)]).session;
    const d = s.describe();
    expect(d.qualityChoice).toBe(false);
    for (const plan of Object.values(d.plans)) {
      expect(plan).toMatchObject({ bulk: "CLI default", major: "CLI default" });
      expect(plan.notes.join(" ")).toMatch(/own default model/);
    }
  });
});

describe("what pinned the run", () => {
  const hint = async (o: Partial<RunSessionOptions>) => {
    // A usage limit has no fix of its own, so the line names the setting to change.
    const s = await open([fake("claude", ALIASES, failing("quota")), fake("codex", CODEX)], o)
      .session;
    const result = await s.liveCheck();
    return result.ok ? "" : result.line.replace(/^Claude Code has reached its usage limit\. /, "");
  };

  it.each([
    ["a typed flag", { runner: "claude", env: {} }, "To allow another CLI, remove --runner."],
    [
      "a variable, recognized by its value",
      { runner: "claude", env: { HUMAN_HINDSIGHT_RUNNER: "claude" } },
      "To allow another CLI, unset HUMAN_HINDSIGHT_RUNNER.",
    ],
    [
      "a variable, as the command says",
      {
        explicit: { model: "sonnet" },
        pinSources: { model: "environment" },
        env: { HUMAN_HINDSIGHT_MODEL: "sonnet" },
      },
      "To allow another CLI, unset HUMAN_HINDSIGHT_MODEL.",
    ],
    [
      "a flag over a set variable",
      {
        runner: "claude",
        pinSources: { runner: "flag" },
        env: { HUMAN_HINDSIGHT_RUNNER: "claude" },
      },
      "To allow another CLI, remove --runner and unset HUMAN_HINDSIGHT_RUNNER.",
    ],
    [
      "a flag and a different variable",
      { runner: "claude", explicit: { author: "opus" }, env: { HUMAN_HINDSIGHT_RUNNER: "codex" } },
      "To allow another CLI, remove --runner and --author-model and unset HUMAN_HINDSIGHT_RUNNER.",
    ],
  ] as [string, Partial<RunSessionOptions>, string][])("%s", async (_name, o, expected) => {
    expect(await hint(o)).toBe(expected);
  });

  it("a strict retry never reads the variables", async () => {
    expect(
      await hint({
        runner: "claude",
        ignoreWorkflowDefaults: true,
        env: { HUMAN_HINDSIGHT_RUNNER: "claude" },
      }),
    ).toBe("To allow another CLI, remove --runner.");
  });
});

describe("calls at once", () => {
  it("the description carries the selected CLI's own limit", async () => {
    const limited = { ...fake("opencode", NONE), maxConcurrency: 2 };
    expect((await open([limited]).session).describe().maxConcurrency).toBe(2);
    expect((await open([fake("claude", ALIASES)]).session).describe()).not.toHaveProperty(
      "maxConcurrency",
    );
  });
});

describe("the reasoning effort a plan sets", () => {
  it("a CLI that takes an effort makes the plans differ, and the plan screen names each level", async () => {
    // No model list: every plan uses the CLI's default model, and still differs by effort.
    const takes = { ...fake("codex", NONE), acceptsEffort: () => true };
    const described = (await open([takes]).session).describe();
    expect(described.setsEffort).toBe(true);
    expect(described.qualityChoice).toBe(true);
    const same = {
      digest: "CLI default",
      cluster: "CLI default",
      author: "CLI default",
      generalize: "CLI default",
      reusable: 0,
      regenerating: 0,
    };
    const text = stripVTControlCharacters(
      renderPlan({
        sessions: 3,
        digests: 3,
        cluster: 1,
        authorEstimate: 2,
        session: described,
        quality: "balanced",
        choices: { fast: same, balanced: same, best: same },
      }),
    ).replace(/\s+/g, " ");
    expect(text).toContain(
      "1 Fast: the CLI's default model for every step, at low reasoning effort",
    );
    expect(text).toContain(
      "2 Balanced (selected): the CLI's default model for every step, at high reasoning effort",
    );
    expect(text).toContain(
      "3 Best: the CLI's default model for every step, at extra high reasoning effort",
    );
  });

  it("is not claimed for a CLI that takes none, or beside a model the person named", async () => {
    expect((await open([fake("claude", ALIASES)]).session).describe().setsEffort).toBe(false);
    const takes = { ...fake("codex", CODEX), acceptsEffort: () => true };
    const named = await open([takes], { runner: "codex", explicit: { model: "gpt-5.6-sol" } })
      .session;
    expect(named.describe().setsEffort).toBe(false);
  });

  it("every call of the approved plan carries the plan's level", async () => {
    const efforts: (string | undefined)[] = [];
    const takes: AgentRunner = {
      ...fake("codex", CODEX, async (opts) => {
        efforts.push(opts.effort);
        return { ok: true };
      }),
      acceptsEffort: () => true,
    };
    const session = await open([takes], { quality: "fast" }).session;
    session.describe();
    expect((await session.liveCheck(["digest", "author"])).ok).toBe(true);
    await session.run({
      prompt: "p",
      schema: { parse: (v: unknown) => v } as never,
      model: session.modelFor("digest"),
    });
    expect(efforts.length).toBeGreaterThan(1);
    expect(new Set(efforts)).toEqual(new Set(["low"]));
  });
});

describe("the plan screen for a CLI without a model list", () => {
  it("offers no Balanced or Best choice", async () => {
    const described = (await open([fake("opencode", NONE)]).session).describe();
    const same = {
      digest: "CLI default",
      cluster: "CLI default",
      author: "CLI default",
      generalize: "CLI default",
      reusable: 0,
      regenerating: 0,
    };
    const text = stripVTControlCharacters(
      renderPlan({
        sessions: 3,
        digests: 3,
        cluster: 1,
        authorEstimate: 2,
        session: described,
        quality: "balanced",
        choices: { fast: same, balanced: same, best: same },
      }),
    );
    expect(described.qualityChoice).toBe(false);
    expect(text).not.toMatch(/\b2\s+Best\b/);
  });
});

describe("model lists that need the network", () => {
  it("says so before asking a CLI whose model list comes from its service", async () => {
    const kiro = fake("kiro", NONE);
    let saidFirst = false;
    const { session, output } = open([kiro]);
    kiro.listModels = async () => {
      saidFirst = output.text().includes("Kiro CLI");
      return NONE;
    };
    await session;
    expect(saidFirst).toBe(true);
    expect(output.text()).toMatch(
      /Asking Kiro CLI which models it offers\. This contacts its service; no session text is sent\./,
    );
  });

  it("says nothing for CLIs that read their model list locally", async () => {
    const { session, output } = open([fake("claude", ALIASES), fake("codex", CODEX)]);
    await session;
    expect(output.text()).not.toMatch(/which models it offers/);
  });
});

describe("fallback disclosure", () => {
  it("falls back only after describe() disclosed the other CLI", async () => {
    const undisclosed = await open([
      fake("claude", ALIASES, failing("sign-in")),
      fake("codex", CODEX),
    ]).session;
    await expect(
      undisclosed.run({ prompt: "p", schema: {} as never, model: undisclosed.modelFor("digest") }),
    ).rejects.toThrow("Claude Code is not signed in.");

    const codex = fake("codex", CODEX);
    const { session, output } = open([fake("claude", ALIASES, failing("sign-in")), codex]);
    const s = await session;
    expect(s.describe().alsoReady).toEqual(["Codex"]);
    await s.run({ prompt: "p", schema: {} as never, model: s.modelFor("digest") });
    expect(codex.models).toEqual(["gpt-5.6-terra"]);
    expect(output.text()).toContain("Continuing with Codex.");
    expect(s.ledgerRunner).toBe("codex");
    // Every switch is listed in the run summary: from, to, and why.
    expect(s.summaryLines()).toEqual([
      "Claude Code: 1 CLI call.",
      "Codex: 1 CLI call (gpt-5.6-terra).",
      "Switched from Claude Code to Codex (not signed in).",
    ]);
  });

  it("lists a model step-down in the run summary", async () => {
    const claude = fake("claude", ALIASES, async (opts) => {
      if (opts.model === "opus")
        throw Object.assign(new Error("refused"), { kind: "model-unavailable" });
      return { ok: true };
    });
    const s = await open([claude]).session;
    await s.run({ prompt: "p", schema: {} as never, model: s.modelFor("author") });
    expect(s.summaryLines()).toEqual([
      "Claude Code: 2 CLI calls (sonnet).",
      "Claude Code cannot use opus here (your provider refused it). Using sonnet for grouping and writing.",
    ]);
  });
});

describe("liveCheck", () => {
  it("runs once however often it is asked", async () => {
    const claude = fake("claude", ONE);
    const s = await open([claude]).session;
    await expect(Promise.all([s.liveCheck(), s.liveCheck()])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
    await s.liveCheck();
    expect(claude.models).toEqual(["sonnet"]);
  });

  it("checks the reading and the writing model at once when they differ", async () => {
    let inFlight = 0;
    let most = 0;
    const claude = fake("claude", ALIASES, async (opts) => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight--;
      opts.onResolved?.({ runner: "claude", model: `${opts.model}-5` });
      return { ok: true };
    });
    const { session, output } = open([claude]);
    const s = await session;
    await expect(s.liveCheck()).resolves.toEqual({ ok: true });
    await s.liveCheck();
    expect([...claude.models].sort()).toEqual(["opus", "sonnet"]);
    expect(most).toBe(2);
    expect(claude.timeouts).toEqual([60_000, 60_000]);
    expect(output.text()).toBe(
      "Checking that Claude Code is ready.\nClaude Code is ready: sonnet-5 reads sessions, opus-5 groups and writes.\n",
    );
  });

  it("a one-model step checks only its own model and names no other role", async () => {
    const claude = fake("claude", ALIASES, async (opts) => {
      opts.onResolved?.({ runner: "claude", model: `${opts.model}-5` });
      return { ok: true };
    });
    const { session, output } = open([claude]);
    const s = await session;
    await expect(s.liveCheck("consolidate")).resolves.toEqual({ ok: true });
    expect(claude.models).toEqual([s.displayModelFor("consolidate")]);
    expect(output.text()).toBe(
      `Checking that Claude Code is ready.\nClaude Code is ready (${s.displayModelFor("consolidate")}-5).\n`,
    );
  });

  it("a refused writing model steps down during the check, before any work", async () => {
    const claude = fake("claude", ALIASES, async (opts) => {
      if (opts.model === "opus")
        throw Object.assign(new Error("refused"), { kind: "model-unavailable" });
      return { ok: true };
    });
    const codex = fake("codex", CODEX);
    const { session, output } = open([claude, codex]);
    const s = await session;
    s.describe();
    await expect(s.liveCheck()).resolves.toEqual({ ok: true });
    expect(claude.models.filter((model) => model === "opus")).toHaveLength(1);
    expect(codex.models).toEqual([]);
    expect(s.displayModelFor("author")).toBe("sonnet");
    expect(output.text()).toBe(
      [
        "Checking that Claude Code is ready.",
        "Claude Code cannot use opus here (your provider refused it). Using sonnet for grouping and writing.",
        "Claude Code is ready (sonnet).",
        "",
      ].join("\n"),
    );
  });

  it("a pinned run whose models are refused down to the default never switches", async () => {
    const claude = fake("claude", ALIASES, async () => {
      throw Object.assign(new Error("refused"), { kind: "model-unavailable" });
    });
    const codex = fake("codex", CODEX);
    const s = await open([claude, codex], { runner: "claude" }).session;
    const result = await s.liveCheck();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.line).toMatch(/refused To allow another CLI, remove --runner\.$/);
    expect(codex.models).toEqual([]);
  });

  it("says what it is doing, then names the model the CLI really answered with", async () => {
    // An alias such as "sonnet" is resolved by the CLI and its provider, so the
    // readiness answer is the first moment the real model name is known.
    let saidFirst = false;
    const { session, output } = open([
      fake("claude", ONE, async (opts) => {
        saidFirst = output.text().includes("Checking that Claude Code is ready.");
        opts.onResolved?.({ runner: "claude", model: "region.vendor.light-4-5" });
        return { ok: true };
      }),
    ]);
    await (await session).liveCheck();
    expect(saidFirst).toBe(true);
    expect(output.text()).toContain("Claude Code is ready (region.vendor.light-4-5).");
  });

  it("names the requested model when the CLI does not report one", async () => {
    const { session, output } = open([fake("claude", ONE)]);
    await (await session).liveCheck();
    expect(output.text()).toContain("Claude Code is ready (sonnet).");
    const two = open([fake("claude", ALIASES)]);
    await (await two.session).liveCheck();
    expect(two.output.text()).toContain(
      "Claude Code is ready: sonnet reads sessions, opus groups and writes.",
    );
  });

  it.each([
    "timeout",
    "validation",
  ])("a %s is reported as unconfirmed and the same CLI continues", async (kind) => {
    const claude = fake("claude", ALIASES, failing(kind));
    const codex = fake("codex", CODEX);
    const { session, output } = open([claude, codex]);
    const s = await session;
    s.describe();
    const result = await s.liveCheck();
    expect(result.ok).toBe(true);
    expect(output.text()).toMatch(/Could not confirm that Claude Code is ready/);
    expect(s.ledgerRunner).toBe("claude");
    expect(codex.models).toEqual([]);
  });

  it.each([
    "sign-in",
    "missing-binary",
    "quota",
  ])("%s switches to the disclosed CLI", async (kind) => {
    const codex = fake("codex", CODEX);
    const s = await open([fake("claude", ALIASES, failing(kind)), codex]).session;
    s.describe();
    await expect(s.liveCheck()).resolves.toEqual({ ok: true });
    expect(s.ledgerRunner).toBe("codex");
  });

  it("model-unavailable steps down, then switches, and the new CLI's models are checked", async () => {
    const claude = fake("claude", ONE, failing("model-unavailable"));
    const codex = fake("codex", CODEX);
    const s = await open([claude, codex]).session;
    s.describe();
    await expect(s.liveCheck()).resolves.toEqual({ ok: true });
    expect(claude.models).toEqual(["sonnet", undefined]);
    expect([...codex.models].sort()).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]);
    expect(s.ledgerRunner).toBe("codex");
  });

  const flaky = (failures: number) => {
    let n = 0;
    return async () => {
      if (++n <= failures)
        throw Object.assign(new Error("cli-error failure"), { kind: "cli-error" });
      return { ok: true };
    };
  };

  it("a plain CLI error is checked once more and a success continues on the same CLI", async () => {
    const claude = fake("claude", ONE, flaky(1));
    const codex = fake("codex", CODEX);
    const { session, output } = open([claude, codex]);
    const s = await session;
    s.describe();
    await expect(s.liveCheck()).resolves.toEqual({ ok: true });
    await s.liveCheck();
    expect(claude.models).toEqual(["sonnet", "sonnet"]);
    expect(codex.models).toEqual([]);
    expect(s.ledgerRunner).toBe("claude");
    // The second attempt is quiet: no second "Checking" line and no switch line.
    expect(output.text()).toBe(
      "Checking that Claude Code is ready.\nClaude Code is ready (sonnet).\n",
    );
  });

  it("two plain CLI errors switch once to the disclosed CLI and check there", async () => {
    const claude = fake("claude", ONE, flaky(9));
    const codex = fake("codex", CODEX);
    const { session, output } = open([claude, codex]);
    const s = await session;
    s.describe();
    await expect(s.liveCheck()).resolves.toEqual({ ok: true });
    expect(claude.models).toHaveLength(2);
    expect(codex.models).toEqual(["gpt-5.6-terra", "gpt-5.6-sol"]);
    expect(s.ledgerRunner).toBe("codex");
    expect(output.text()).toBe(
      [
        "Checking that Claude Code is ready.",
        "Claude Code failed twice in a row. Continuing with Codex.",
        "Checking that Codex is ready.",
        "Codex is ready: gpt-5.6-terra reads sessions, gpt-5.6-sol groups and writes.",
        "",
      ].join("\n"),
    );
  });

  it("after a sign-in switch, a plain error on the new CLI is still checked once more", async () => {
    const claude = fake("claude", ONE, failing("sign-in"));
    const codex = fake("codex", ONE_CODEX, flaky(1));
    const s = await open([claude, codex]).session;
    s.describe(); // the consent screen discloses Codex
    await expect(s.liveCheck()).resolves.toEqual({ ok: true });
    expect(codex.models).toEqual(["gpt-5.6-terra", "gpt-5.6-terra"]);
    expect(s.ledgerRunner).toBe("codex");
  });

  it("a temporary failure that outlasts its retries counts toward a switch", async () => {
    const claude = fake("claude", ONE, failing("transient"));
    const codex = fake("codex", ONE_CODEX);
    const s = await open([claude, codex], { sleep: async () => {} }).session;
    s.describe();
    await expect(s.liveCheck()).resolves.toEqual({ ok: true });
    // Two checks of four attempts each (one call and three retries).
    expect(claude.models).toHaveLength(8);
    expect(s.ledgerRunner).toBe("codex");
  });

  it("two plain CLI errors on the last CLI stop with its own message", async () => {
    const claude = fake("claude", ONE, flaky(9));
    const codex = fake("codex", ONE_CODEX, flaky(9));
    const s = await open([claude, codex]).session;
    s.describe();
    await expect(s.liveCheck()).resolves.toEqual({
      ok: false,
      line: "Codex is not ready: cli-error failure",
    });
    expect([claude.models.length, codex.models.length]).toEqual([2, 2]);
  });

  it.each([
    ["pinned", { runner: "claude" }, false],
    ["fallback not disclosed", {}, true],
  ] as const)("two plain CLI errors when %s stop without a switch", async (_name, extra, skipDescribe) => {
    const codex = fake("codex", CODEX);
    const s = await open([fake("claude", ONE, flaky(9)), codex], extra).session;
    if (!skipDescribe) s.describe();
    await expect(s.liveCheck()).resolves.toEqual({
      ok: false,
      line: "Claude Code is not ready: cli-error failure",
    });
    expect(s.ledgerRunner).toBe("claude");
    expect(codex.models).toEqual([]);
  });

  it("a pinned quota failure names the flag to remove, in one line", async () => {
    const { session, output } = open(
      [fake("claude", ALIASES, failing("quota")), fake("codex", CODEX)],
      { runner: "claude" },
    );
    const result = await (await session).liveCheck();
    expect(result).toEqual({
      ok: false,
      line: "Claude Code has reached its usage limit. To allow another CLI, remove --runner.",
    });
    // The check's caller prints the line; the session does not print it too.
    expect(output.text()).not.toContain("usage limit");
  });

  it("a signed-out CLI with no other ready: the line and the CLI's own sign-in command", async () => {
    const { session, output } = open([fake("claude", ALIASES, failing("sign-in"))]);
    const s = await session;
    s.describe();
    const result = await s.liveCheck();
    expect(result).toEqual({
      ok: false,
      line: "Claude Code is not signed in. No other coding CLI is ready on this machine.\nRun: claude auth login",
    });
    expect(output.text()).not.toMatch(/not signed in|\/login|readiness check/);
  });

  it("the check itself is bounded", async () => {
    const claude = fake("claude", ALIASES);
    const s = await open([claude]).session;
    await s.liveCheck();
    expect(claude.timeouts[0]).toBeGreaterThan(0);
  });
});

describe("the readiness check covers every model the plan calls", () => {
  const refuse = (refused: string) => async (opts: RunOptions<unknown>) => {
    if (opts.model === refused)
      throw new AgentRunnerError("model-unavailable", `unknown model ${refused}`);
    return { ok: true };
  };

  it.each([
    {
      name: "distill --author-model",
      explicit: { author: "writer-x" },
      stages: undefined,
      wants: ["sonnet", "opus", "writer-x"],
    },
    {
      name: "suggest-subagents --propose-model and --author-model",
      explicit: { propose: "chooser-y", author: "writer-x" },
      stages: ["generalize", "propose", "roles"] as const,
      wants: ["sonnet", "chooser-y", "writer-x"],
    },
    {
      name: "suggest-subagents --author-only, which only writes roles",
      explicit: { author: "writer-x" },
      stages: ["roles"] as const,
      wants: ["writer-x"],
    },
    {
      name: "a strict retry of reading calls only",
      explicit: {},
      stages: ["digest"] as const,
      wants: ["sonnet"],
    },
  ])("$name: each distinct model once, and no other", async ({ explicit, stages, wants }) => {
    const claude = fake("claude", ALIASES);
    const s = await open([claude], { explicit }).session;
    await expect(s.liveCheck(stages)).resolves.toEqual({ ok: true });
    expect([...claude.models].sort()).toEqual([...wants].sort());
  });

  it.each([
    { key: "author", flag: "--author-model", stages: undefined, env: {} },
    { key: "propose", flag: "--propose-model", stages: ["propose", "roles"] as const, env: {} },
    {
      key: "author",
      flag: "HUMAN_HINDSIGHT_AUTHOR_MODEL",
      stages: undefined,
      env: { HUMAN_HINDSIGHT_AUTHOR_MODEL: "writer-x" },
    },
  ])("a refused model chosen by $flag is reported before any work, naming it", async ({
    key,
    flag,
    stages,
    env,
  }) => {
    const claude = fake("claude", ALIASES, refuse("writer-x"));
    const s = await open([claude], { explicit: { [key]: "writer-x" }, env }).session;
    const result = await s.liveCheck(stages);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.line).toContain("writer-x");
    expect(result.line).toContain(`chosen by ${flag}`);
    expect(result.line).not.toContain("\n");
  });
});

describe("Ctrl-C during the readiness check", () => {
  // After Ctrl-C the pool refuses every call; that is the interrupt, not a CLI
  // that failed twice, so the run never reports a switch that did not happen.
  it("does not switch CLI or report a switch", async () => {
    let stop: () => void = () => {};
    const claude = fake("claude", ALIASES, async (opts) => {
      stop();
      await new Promise((_resolve, reject) => {
        const fail = () => reject(new Error("The operation was aborted"));
        if (opts.signal?.aborted) fail();
        else opts.signal?.addEventListener("abort", fail, { once: true });
      });
      return { ok: true };
    });
    const codex = fake("codex", CODEX);
    const { session, output } = open([claude, codex]);
    const s = await session;
    s.describe(); // the plan screen disclosed Codex as also ready
    stop = () => s.interrupt();
    const result = await s.liveCheck();
    expect(result.ok).toBe(false);
    expect(codex.models).toEqual([]);
    expect(s.ledgerRunner).toBe("claude");
    expect(s.summaryLines().join("\n")).not.toMatch(/Switched from/);
    expect(output.text()).not.toMatch(/Continuing with/);
  });
});
