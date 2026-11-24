import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { isPlanLabel, planModels } from "../src/core/model-plan.js";
import { makeClaudeRunner } from "../src/runners/claude.js";
import {
  type Candidate,
  createRunnerPool,
  orderCandidates,
  type PoolEvent,
} from "../src/runners/pool.js";
import { AgentRunnerError } from "../src/runners/shared.js";
import type { AgentRunner, ModelCatalog, RunnerName, RunOptions } from "../src/runners/types.js";
import { createClock } from "./support/clock.js";
import { claudeEnvelope, fakeRunnerIo } from "./support/runner-io.js";

// Fake runners at the AgentRunner boundary. Each records the model of every
// call it receives; afterEach asserts that no plan label ever reached one.
type Script = (opts: RunOptions<unknown>, call: number) => Promise<unknown>;
interface Fake extends AgentRunner {
  models: (string | undefined)[];
  finalized: number;
}
const fakes: Fake[] = [];

function fake(name: RunnerName, script: Script, cost?: string): Fake {
  const runner: Fake = {
    name,
    installHint: "",
    models: [],
    finalized: 0,
    run: async <T>(opts: RunOptions<T>) => {
      runner.models.push(opts.model);
      return (await script(opts as RunOptions<unknown>, runner.models.length)) as T;
    },
    costSummary: () => cost,
    finalize: async () => {
      runner.finalized++;
    },
  };
  fakes.push(runner);
  return runner;
}

const ALIASES: ModelCatalog = { ids: ["sonnet", "opus", "fable"], source: "aliases" };
const CODEX: ModelCatalog = { ids: ["gpt-5.6-terra", "gpt-5.6-sol"], source: "catalog" };
function candidate(
  runner: AgentRunner,
  catalog = runner.name === "claude" ? ALIASES : CODEX,
): Candidate {
  return {
    runner,
    catalog,
    plans: {
      balanced: planModels(runner.name, catalog, "balanced"),
      best: planModels(runner.name, catalog, "best"),
    },
  };
}

function failure(kind: string, message = `${kind} failure`): Error {
  return Object.assign(new Error(message), { kind });
}
const ok = async () => ({ ok: true });
const fail = (kind: string) => async () => {
  throw failure(kind);
};

function pool(
  runners: AgentRunner[],
  o: {
    pinned?: boolean;
    quality?: "balanced" | "best";
    disclosed?: boolean;
    pinHint?: string;
  } = {},
) {
  const events: PoolEvent[] = [];
  const clock = createClock();
  const randoms = [0, 0.999, 0.5, 0.25];
  let r = 0;
  const p = createRunnerPool({
    candidates: runners.map((runner) => candidate(runner)),
    pinned: o.pinned ?? false,
    pinHint: o.pinHint ?? (o.pinned ? "Remove --runner to allow another CLI." : undefined),
    quality: () => o.quality ?? "balanced",
    fallbackDisclosed: () => o.disclosed ?? true,
    onEvent: (event) => events.push(event),
    sleep: clock.sleep,
    random: () => randoms[r++ % randoms.length] as number,
  });
  return { pool: p, events, clock };
}

const call = (model = "balanced/bulk") => ({ prompt: "p", schema: z.unknown(), model });

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  for (const runner of fakes.splice(0)) {
    for (const model of runner.models) expect(isPlanLabel(model)).toBe(false);
  }
});

describe("createRunnerPool", () => {
  it("pinned: every ordinary failure gets its own call and keeps the CLI's own message", async () => {
    // Five sessions failing the same way, one call at a time, with --runner and --model.
    const errors = Array.from(
      { length: 5 },
      () => new AgentRunnerError("cli-error", "claude exited 1: Synthetic failure"),
    );
    const claude = fake("claude", (_o, n) => (n <= 5 ? Promise.reject(errors[n - 1]) : ok()));
    const { pool: p, events } = pool([claude], { pinned: true });
    for (const expected of errors) {
      await expect(p.run(call("explicit-model"))).rejects.toBe(expected);
      expect(expected.message).toBe("claude exited 1: Synthetic failure");
    }
    expect(claude.models).toEqual(Array(5).fill("explicit-model"));
    expect(events).toEqual([]);
    await expect(p.run(call("explicit-model"))).resolves.toEqual({ ok: true });
  });

  it("pinned: a failure that would have switched names the pin to remove", async () => {
    const claude = fake("claude", fail("model-unavailable"));
    const { pool: p } = pool([claude], { pinned: true });
    await expect(p.run(call("balanced/bulk"))).rejects.toThrow(
      "model-unavailable failure Remove --runner to allow another CLI.",
    );
    expect(claude.models).toEqual(["sonnet", undefined]);
    // Not a reason to end the run: the next call still reaches the CLI.
    await expect(p.run(call("balanced/bulk"))).rejects.toThrow();
    expect(claude.models).toHaveLength(3);
  });

  it("on the last CLI, ordinary failures never end the run", async () => {
    let n = 0;
    const claude = fake("claude", fail("cli-error"));
    const codex = fake("codex", () => (++n <= 2 ? Promise.reject(failure("cli-error")) : ok()));
    const { pool: p, events } = pool([claude, codex]);
    await expect(p.run(call())).rejects.toThrow();
    await expect(p.run(call())).rejects.toThrow(); // switches, then fails on codex
    await expect(p.run(call())).rejects.toThrow(); // second codex failure: no next CLI
    await expect(p.run(call())).resolves.toEqual({ ok: true });
    expect(events.map((e) => e.kind)).toEqual(["switch"]);
  });

  it("sign-in with no next CLI ends the run and later calls do not reach the CLI", async () => {
    const claude = fake("claude", fail("sign-in"));
    const { pool: p, events } = pool([claude], { pinned: true });
    await expect(p.run(call())).rejects.toThrow("Claude Code is not signed in.");
    await expect(p.run(call())).rejects.toThrow("Claude Code is not signed in.");
    expect(claude.models).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "exhausted", reason: "sign-in", runner: "claude" });
  });

  it("ten concurrent sign-in failures switch exactly once", async () => {
    const claude = fake("claude", fail("sign-in"));
    const codex = fake("codex", ok);
    const { pool: p, events } = pool([claude, codex]);
    const results = await Promise.all(Array.from({ length: 10 }, () => p.run(call())));
    expect(results).toHaveLength(10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "switch",
      runner: "claude",
      to: "codex",
      reason: "sign-in",
    });
    expect(events[0]?.line).toBe("Claude Code is not signed in. Continuing with Codex.");
    expect(claude.models).toHaveLength(10);
    expect(codex.models).toEqual(Array(10).fill("gpt-5.6-terra"));
  });

  it("a success that lands after a sibling switched is returned, not run again", async () => {
    const slow = deferred();
    const claude = fake("claude", (_o, n) =>
      n === 1 ? slow.promise : Promise.reject(failure("quota")),
    );
    const codex = fake("codex", async () => ({ from: "codex" }));
    const { pool: p, events } = pool([claude, codex]);
    const resolved: unknown[] = [];
    const first = p.run({ ...call(), onResolved: (r) => resolved.push(r) });
    await expect(p.run(call())).resolves.toEqual({ from: "codex" });
    expect(events.map((e) => e.kind)).toEqual(["switch"]);
    slow.resolve({ from: "claude" });
    await expect(first).resolves.toEqual({ from: "claude" });
    expect(claude.models).toEqual(["sonnet", "sonnet"]);
    expect(codex.models).toHaveLength(1);
    expect(resolved).toEqual([{ runner: "claude", model: "sonnet" }]);
    expect(p.used()).toEqual([
      { runner: "claude", calls: 2, models: ["sonnet"] },
      { runner: "codex", calls: 1, models: ["gpt-5.6-terra"] },
    ]);
  });

  it("counts only failures of calls that started after the last success", async () => {
    const gates = [deferred(), deferred()];
    let n = 0;
    const claude = fake("claude", () => {
      n++;
      if (n <= 2) return gates[n - 1]?.promise as Promise<unknown>;
      if (n === 3) return ok();
      return Promise.reject(failure("cli-error"));
    });
    const codex = fake("codex", ok);
    const { pool: p, events } = pool([claude, codex]);
    const early = [p.run(call()), p.run(call())];
    await p.run(call()); // a success after both started
    for (const gate of gates) gate.reject(failure("cli-error"));
    for (const item of early) await expect(item).rejects.toThrow();
    expect(events).toEqual([]);
    await expect(p.run(call())).rejects.toThrow(); // streak 1
    await expect(p.run(call())).resolves.toEqual({ ok: true }); // streak 2 switches
    expect(events.map((e) => [e.kind, e.reason])).toEqual([["switch", "cli-error"]]);
  });

  it("a success resets the streak", async () => {
    let n = 0;
    const claude = fake("claude", () => (++n % 2 ? Promise.reject(failure("cli-error")) : ok()));
    const { pool: p, events } = pool([claude, fake("codex", ok)]);
    for (let i = 0; i < 3; i++) {
      await expect(p.run(call())).rejects.toThrow();
      await p.run(call());
    }
    expect(events).toEqual([]);
  });

  it.each(["timeout", "validation"])("%s failures never switch", async (kind) => {
    const claude = fake("claude", fail(kind));
    const { pool: p, events } = pool([claude, fake("codex", ok)]);
    for (let i = 0; i < 4; i++) await expect(p.run(call())).rejects.toThrow(`${kind} failure`);
    expect(events).toEqual([]);
    expect(p.active()).toBe("claude");
  });

  it("retries a transient failure three times with jittered delays, then counts one failure", async () => {
    const claude = fake("claude", fail("transient"));
    const codex = fake("codex", ok);
    const { pool: p, events, clock } = pool([claude, codex]);
    await expect(p.run(call())).rejects.toThrow("transient failure");
    expect(claude.models).toHaveLength(4);
    expect(clock.sleeps).toHaveLength(3);
    clock.sleeps.forEach((ms, retry) => {
      expect(ms).toBeGreaterThanOrEqual(250 * 2 ** retry);
      expect(ms).toBeLessThan(750 * 2 ** retry);
    });
    expect(events).toEqual([]);
    await expect(p.run(call())).resolves.toEqual({ ok: true }); // second counted failure
    expect(events.map((e) => e.kind)).toEqual(["switch"]);
  });

  it("steps the major role down frontier, heavy, light, CLI default, then switches", async () => {
    const claude = fake("claude", fail("model-unavailable"));
    const codex = fake("codex", ok);
    const { pool: p, events } = pool([claude, codex], { quality: "best" });
    await expect(p.run(call("best/major"))).resolves.toEqual({ ok: true });
    expect(claude.models).toEqual(["fable", "opus", "sonnet", undefined]);
    expect(codex.models).toEqual(["gpt-5.6-sol"]);
    expect(events.map((e) => e.kind)).toEqual(["step-down", "step-down", "step-down", "switch"]);
    for (const event of events) {
      expect(event.reason).toBe("model-unavailable");
      expect(event.line).not.toBe("");
    }
    expect(events.slice(0, 3).map((e) => e.line)).toEqual([
      "Claude Code cannot use fable here (your provider refused it). Using opus for grouping and writing.",
      "Claude Code cannot use opus here (your provider refused it). Using sonnet for grouping and writing.",
      "Claude Code cannot use sonnet here (your provider refused it). Using the CLI default for grouping and writing.",
    ]);
    expect(p.used().find((u) => u.runner === "claude")?.models).toEqual([]);
  });

  it("concurrent model-unavailable failures step down once", async () => {
    const claude = fake("claude", (o) =>
      o.model === "opus" ? Promise.reject(failure("model-unavailable")) : ok(),
    );
    const { pool: p, events } = pool([claude], { pinned: true });
    await Promise.all(Array.from({ length: 5 }, () => p.run(call("balanced/major"))));
    expect(events.map((e) => e.kind)).toEqual(["step-down"]);
    expect(p.used()[0]?.models).toEqual(["sonnet"]);
  });

  it("an undisclosed fallback is not taken, and the end says the one thing to do", async () => {
    const claude = fake("claude", fail("sign-in"));
    const codex = fake("codex", ok);
    const { pool: p, events } = pool([claude, codex], { disclosed: false });
    // Later calls fail with the plain reason, never the CLI's own sign-in hint.
    await expect(p.run(call())).rejects.toThrow(/^Claude Code is not signed in\.$/);
    expect(codex.models).toEqual([]);
    expect(events[0]?.line).toBe(
      "Claude Code is not signed in. No other coding CLI is ready on this machine.\nRun: claude auth login",
    );
  });

  it.each([
    [
      "quota",
      false,
      "Claude Code has reached its usage limit. No other coding CLI is ready on this machine.",
    ],
    [
      "quota",
      true,
      "Claude Code has reached its usage limit. To allow another CLI, remove --runner.",
    ],
    ["sign-in", true, "Claude Code is not signed in.\nRun: claude auth login"],
  ] as const)("a run that cannot continue (%s, pinned %s) says so in plain words", async (reason, pinned, line) => {
    const claude = fake("claude", fail(reason));
    // A lone CLI offers no fallback; a pinned one names the flag to remove.
    const { pool: p, events } = pool([claude], {
      pinned,
      disclosed: false,
      pinHint: "To allow another CLI, remove --runner.",
    });
    await expect(p.run(call())).rejects.toThrow();
    expect(events.at(-1)?.line).toBe(line);
    expect(events.at(-1)?.line).not.toMatch(/consent plan|\/login|eligible/);
  });

  it("finalize is idempotent and only reaches runners that were used", async () => {
    const claude = fake("claude", ok, "3 credits");
    const codex = fake("codex", ok, "never shown");
    const { pool: p } = pool([claude, codex]);
    await p.run(call());
    await Promise.all([p.finalize(), p.finalize()]);
    await p.finalize();
    expect([claude.finalized, codex.finalized]).toEqual([1, 0]);
    await expect(p.run(call())).rejects.toThrow("This runner session has ended.");
  });

  it("merges the cost lines of used runners and lists only succeeded models", async () => {
    const claude = fake("claude", fail("sign-in"), "claude cost");
    const codex = fake(
      "codex",
      (o) => (o.model === "gpt-5.6-sol" ? Promise.reject(failure("validation")) : ok()),
      "codex cost",
    );
    const kiro = fake("kiro", ok, "kiro cost");
    const { pool: p } = pool([claude, codex, kiro]);
    await p.run(call("balanced/bulk"));
    await expect(p.run(call("balanced/major"))).rejects.toThrow();
    await expect(p.run(call("explicit-model"))).resolves.toEqual({ ok: true });
    expect(p.costSummary()).toBe("claude cost\ncodex cost");
    expect(p.used()).toEqual([
      { runner: "claude", calls: 1, models: [] },
      { runner: "codex", calls: 3, models: ["gpt-5.6-terra", "explicit-model"] },
    ]);
    expect(kiro.models).toEqual([]);
  });

  it("a model refused in the middle of a run steps that role down once, for this and later calls", async () => {
    // The captured envelope of a cloud provider refusing one model.
    const refused = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: 400,
      result: "API Error: 400 data retention mode 'none' is not available for this model",
    });
    const io = fakeRunnerIo()
      .failOnUnscripted()
      .script("claude", { has: ["-p", "opus"] }, { code: 1, stdout: refused })
      .script("claude", { has: ["-p"] }, { stdout: claudeEnvelope({ ok: true }) });
    const claude = makeClaudeRunner(io);
    const codex = fake("codex", ok);
    const { pool: p, events } = pool([claude, codex]);
    const capabilities = {
      jsonSchema: true,
      disableTools: "tools-empty" as const,
      noSessionPersistence: true,
      isolation: "safe-mode" as const,
    };
    const opts = { ...call("balanced/major"), capabilities };
    const models = () => io.calls.map((c) => c.args[c.args.indexOf("--model") + 1]);
    // The run is under way: reads already succeeded.
    await expect(p.run({ ...call("balanced/bulk"), capabilities })).resolves.toEqual({ ok: true });
    await expect(p.run(opts)).resolves.toEqual({ ok: true });
    expect(models()).toEqual(["sonnet", "opus", "sonnet"]);
    expect(events).toEqual([
      {
        kind: "step-down",
        runner: "claude",
        reason: "model-unavailable",
        line: "Claude Code cannot use opus here (your provider refused it). Using sonnet for grouping and writing.",
      },
    ]);
    await p.run(opts);
    expect(models()).toEqual(["sonnet", "opus", "sonnet", "sonnet"]);
    expect(p.roleFor("major").model).toBe("sonnet");
    expect(codex.models).toEqual([]);
  });

  it("two calls answered overloaded at once are retried on the same CLI, not switched", async () => {
    let claudeCalls = 0;
    const overloaded = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: 529,
      result: "API Error: 529 Overloaded",
    });
    const io = fakeRunnerIo()
      .failOnUnscripted()
      .script("claude", { has: ["-p"] }, () =>
        ++claudeCalls <= 2
          ? { code: 1, stdout: overloaded }
          : { stdout: claudeEnvelope({ ok: true }) },
      );
    const codex = fake("codex", ok);
    const { pool: p, events, clock } = pool([makeClaudeRunner(io), codex]);
    const capabilities = {
      jsonSchema: true,
      disableTools: "tools-empty" as const,
      noSessionPersistence: true,
      isolation: "safe-mode" as const,
    };
    const results = await Promise.allSettled([
      p.run({ ...call(), capabilities }),
      p.run({ ...call(), capabilities }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(clock.sleeps).toHaveLength(2);
    expect(events).toEqual([]);
    expect(codex.models).toEqual([]);
  });

  it("never has more calls in flight on a CLI than it declares, whatever the stage asks", async () => {
    let inFlight = 0;
    let most = 0;
    const gates: (() => void)[] = [];
    const limited: AgentRunner = {
      ...fake("opencode", async () => {
        most = Math.max(most, ++inFlight);
        await new Promise<void>((resolve) => gates.push(resolve));
        inFlight--;
        return { ok: true };
      }),
      maxConcurrency: 2,
    };
    const { pool: p } = pool([limited], { pinned: true });
    expect(p.adapter.maxConcurrency).toBe(2);
    const runs = Array.from({ length: 10 }, () => p.run(call("explicit-model")));
    for (let done = 0; done < 10; done++) {
      await new Promise((resolve) => setImmediate(resolve));
      expect(inFlight).toBeLessThanOrEqual(2);
      gates.shift()?.();
    }
    await expect(Promise.all(runs)).resolves.toHaveLength(10);
    expect(most).toBe(2);
    expect(p.used()[0]?.calls).toBe(10);
  });

  it("a CLI without a limit takes every call at once", async () => {
    let inFlight = 0;
    let most = 0;
    const open = fake("claude", async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight--;
      return { ok: true };
    });
    const { pool: p } = pool([open], { pinned: true });
    await Promise.all(Array.from({ length: 10 }, () => p.run(call("explicit-model"))));
    expect(most).toBe(10);
  });

  it("calls waiting for a slot move to the next CLI after a switch", async () => {
    const limited: AgentRunner = { ...fake("opencode", fail("sign-in")), maxConcurrency: 1 };
    const codex = fake("codex", ok);
    const { pool: p, events } = pool([limited, codex]);
    const results = await Promise.all(Array.from({ length: 4 }, () => p.run(call())));
    expect(results).toHaveLength(4);
    expect(events.map((e) => e.kind)).toEqual(["switch"]);
    expect(codex.models).toHaveLength(4);
  });

  it("the adapter follows the active runner", async () => {
    const claude = fake("claude", fail("missing-binary"));
    const { pool: p } = pool([claude, fake("codex", ok)]);
    expect(p.adapter.name).toBe("claude");
    await p.adapter.run(call());
    expect(p.adapter.name).toBe("codex");
  });
});

describe("orderCandidates", () => {
  it.each([
    [["claude", "codex", "kiro"], {}, undefined, ["claude", "codex", "kiro"]],
    [["claude", "codex", "kiro"], { kiro: 9, codex: 3 }, undefined, ["kiro", "claude", "codex"]],
    [["claude", "codex"], { kiro: 9 }, undefined, ["claude", "codex"]],
    [["claude", "codex"], { claude: 9 }, "codex", ["codex", "claude"]],
    [["claude"], {}, "opencode", ["claude"]],
  ] as const)("%j with share %j and explicit %s", (installed, share, explicit, expected) => {
    expect(orderCandidates([...installed], share, explicit)).toEqual(expected);
  });
});

describe("the step-down line in the command's own words", () => {
  it("names what the refused model was for", async () => {
    const claude = fake("claude", (o) =>
      o.model === "opus" ? Promise.reject(failure("model-unavailable")) : ok(),
    );
    const events: PoolEvent[] = [];
    const p = createRunnerPool({
      candidates: [candidate(claude)],
      pinned: true,
      quality: () => "balanced",
      onEvent: (event) => events.push(event),
      purposes: { bulk: "preference summaries", major: "choosing and writing roles" },
    });
    await p.run(call("balanced/major"));
    expect(events[0]?.line).toBe(
      "Claude Code cannot use opus here (your provider refused it). Using sonnet for choosing and writing roles.",
    );
  });
});
