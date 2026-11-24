import path from "node:path";
import type { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { flagEnvironments } from "../commands/_shared.js";
import { PROBES } from "../runners/capabilities.js";
import { classifyFailure } from "../runners/failures.js";
import {
  type Candidate,
  createRunnerPool,
  describeReason,
  orderCandidates,
  type PoolEvent,
} from "../runners/pool.js";
import { makeRunner, parseRunnerMode, RUNNER_INFO } from "../runners/registry.js";
import { AgentRunnerError, type RunnerIo } from "../runners/shared.js";
import type { AgentRunner, ModelCatalog, RunnerName } from "../runners/types.js";
import { writeAbove } from "../ui/live.js";
import { canColor } from "../ui/mode.js";
import { palette } from "../ui/style.js";
import { installedRunnerNames, readExportSessionShare } from "./environment.js";
import {
  isPlanLabel,
  type ModelRole,
  planLabel,
  planModels,
  QUALITIES,
  type Quality,
} from "./model-plan.js";

export type StageKey =
  | "digest"
  | "cluster"
  | "author"
  | "generalize"
  | "propose"
  | "roles"
  | "consolidate";

export interface SessionDescription {
  runnerLine: string;
  alsoReady: string[];
  pinned: boolean;
  plans: Record<Quality, { bulk: string; major: string; notes: string[] }>;
  /** False when every plan would make the same calls, so a choice would mean nothing. */
  qualityChoice?: boolean;
  /**
   * The CLI takes a reasoning effort for each call, so every plan sets its
   * own. False: its calls run at the CLI's own setting.
   */
  setsEffort?: boolean;
  /**
   * The most calls the selected CLI takes at once, when it has a limit of its
   * own. A stage runs at most this many at a time on it ("up to N at a time").
   */
  maxConcurrency?: number;
}

/** `line` on success says the check could not confirm readiness and the run continues. */
type CheckResult = { ok: true; line?: string } | { ok: false; line: string };
type RunnerFn = AgentRunner["run"];

export interface RunSession {
  readonly pinned: boolean;
  readonly identityRunner: RunnerName | null;
  readonly ledgerRunner: RunnerName;
  /** Eligible CLI choices from this discovery. Selecting one builds a pinned session locally. */
  readonly runnerChoices: readonly { name: RunnerName; select(): RunSession }[];
  quality: Quality;
  modelFor(stage: StageKey): string | undefined;
  displayModelFor(stage: StageKey, quality?: Quality): string;
  /** Supply the runner choices to the consent screen, including when using --yes. */
  describe(): SessionDescription;
  /**
   * Run once after consent, just before the first call. Sends one tiny
   * request to every distinct model the approved plan will call, and only
   * those: the stages given, or a command's whole plan ({@link PLAN_STAGES}).
   * A refused model is reported before any paid work, naming the flag or
   * variable that chose it.
   */
  liveCheck(stages?: CheckedStage | readonly StageKey[]): Promise<CheckResult>;
  readonly run: RunnerFn;
  readonly adapter: AgentRunner;
  summaryLines(): string[];
  /** Ctrl-C: abort the calls in flight (their CLI processes end) and start no new one. */
  interrupt(): void;
  finalize(): Promise<void>;
}

type ExplicitModels = Partial<Record<"model" | "cluster" | "author" | "propose", string>>;
/** A setting that pins the CLI: `--runner` or one of the explicit models. */
export type PinKey = "runner" | keyof ExplicitModels;
/** Whether a pinning value was typed as a flag or came from its environment variable. */
export type PinSource = "flag" | "environment";
export interface RunSessionOptions {
  home: string;
  runner?: string;
  quality: Quality;
  explicit: ExplicitModels;
  sessionShare?: Partial<Record<RunnerName, number>>;
  io?: RunnerIo;
  output: Writable;
  injectedRunner?: RunnerFn;
  injectedRunnerName?: RunnerName;
  /** Strict retries inherit stored settings and ignore ambient workflow defaults. */
  ignoreWorkflowDefaults?: boolean;
  /** Explain an inherited pin when it came from a saved operation. */
  pinHint?: string;
  /**
   * Where each pinning value came from, so a failure names what to change:
   * the flag or the environment variable. A value without an entry counts as
   * coming from its variable when it equals that variable, else as a flag.
   */
  pinSources?: Partial<Record<PinKey, PinSource>>;
  /** The environment the session reads its variables from (default: the process's). */
  env?: NodeJS.ProcessEnv;
  /** The wait between retries of a temporary failure (default: a real timer). */
  sleep?(ms: number): Promise<void>;
  /** Ready-made runners in priority order, used instead of local discovery. */
  runners?: AgentRunner[];
  /** What each model role does, in the command's words, for the step-down line. */
  purposes?: Record<ModelRole, string>;
}

const LIVE_CHECK_TIMEOUT_MS = 60_000;
/** A readiness check stopped by Ctrl-C: the caller is already stopping. */
const INTERRUPTED = "The run was interrupted.";
const SUBAGENT_MODEL_ENV = "HUMAN_HINDSIGHT_SUBAGENT_MODEL";
const FLAGS = {
  model: "--model",
  cluster: "--cluster-model",
  author: "--author-model",
  propose: "--propose-model",
} as const;
/** The environment variable each pinning flag can also come from. */
const PIN_VARIABLES: Partial<Record<PinKey, string>> = {
  runner: flagEnvironments.runner,
  model: flagEnvironments.model,
  cluster: flagEnvironments["cluster-model"],
  author: flagEnvironments["author-model"],
};
/** A command whose whole plan a readiness check covers. */
type CheckedStage = "digest" | "generalize" | "consolidate";
/**
 * The stages each command's run calls: distill reads, groups, writes, and
 * summarizes working preferences; suggest-subagents summarizes, chooses, and
 * writes roles; consolidation makes its one call.
 */
const PLAN_STAGES: Record<CheckedStage, readonly StageKey[]> = {
  digest: ["digest", "cluster", "author", "generalize"],
  generalize: ["generalize", "propose", "roles"],
  consolidate: ["consolidate"],
};
/** What each checked stage does, as the ready line says it. */
const STAGE_WORDS: Record<StageKey, string> = {
  digest: "reads sessions",
  cluster: "groups",
  author: "writes",
  generalize: "summarizes preferences",
  propose: "chooses roles",
  roles: "writes roles",
  consolidate: "merges preferences",
};
/** The words of the stages one model serves: "groups and writes". */
function stageWords(stages: readonly StageKey[]): string {
  const words = [...new Set(stages.map((stage) => STAGE_WORDS[stage]))];
  // Choosing and writing roles is one job in the plan's words, and so is
  // distill's closing summary of working preferences beside reading sessions.
  const drop = (word: string, beside: string) => {
    if (words.includes(word) && words.includes(beside)) words.splice(words.indexOf(word), 1);
  };
  drop("chooses roles", "writes roles");
  drop("summarizes preferences", "reads sessions");
  return words.join(" and ");
}
const STAGE_ROLE: Record<StageKey, ModelRole> = {
  digest: "bulk",
  generalize: "bulk",
  cluster: "major",
  author: "major",
  propose: "major",
  roles: "major",
  consolidate: "major",
};

function oneLine(error: unknown): string {
  return stripVTControlCharacters(error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim();
}

function checkedModel(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  const model = value.trim();
  if (!model || isPlanLabel(model.toLowerCase()))
    throw new Error(`Use a concrete CLI model for ${flag}, or select a model plan with --quality.`);
  return model;
}

interface Prepared extends Candidate {
  version?: string;
  catalog: ModelCatalog;
}

function prepared(runner: AgentRunner, catalog: ModelCatalog, version?: string): Prepared {
  return {
    runner,
    catalog,
    version,
    plans: Object.fromEntries(
      QUALITIES.map((quality) => [quality, planModels(runner.name, catalog, quality)]),
    ) as Candidate["plans"],
  };
}

async function prepareCandidates(
  o: RunSessionOptions,
  selected: RunnerName | undefined,
  pinned: boolean,
  pinHint: string,
): Promise<Prepared[]> {
  if (o.injectedRunner) {
    const name = o.injectedRunnerName ?? selected ?? "claude";
    return [
      prepared({ name, run: o.injectedRunner, installHint: "" }, { ids: [], source: "none" }),
    ];
  }
  const options = { io: o.io, scratchBase: path.join(o.home, "runner-scratch") };
  const supplied = new Map(o.runners?.map((runner) => [runner.name, runner]));
  const installed = o.runners ? [...supplied.keys()] : await installedRunnerNames(o.io);
  const build = (name: RunnerName) => supplied.get(name) ?? makeRunner(name, options);
  if (selected && !installed.includes(selected)) {
    throw new AgentRunnerError(
      "missing-binary",
      `${makeRunner(selected, options).installHint} ${pinHint}`,
    );
  }
  const order = orderCandidates(
    installed,
    o.sessionShare ?? readExportSessionShare(o.home),
    selected,
  );
  if (!order.length) {
    throw new AgentRunnerError(
      "missing-binary",
      `No agent CLI is installed. Run npx human-hindsight doctor for the install commands.${pinHint ? ` ${pinHint}` : ""}`,
    );
  }
  const names = pinned ? order.slice(0, 1) : order;
  // A model list that comes from the CLI's own service is the first thing here
  // that leaves the machine, so say it before it happens. No session text is in it.
  const remote = names.filter((name) => PROBES[name].models?.scope === "network");
  if (remote.length) {
    const list = remote.map((name) => RUNNER_INFO[name].displayName).join(" and ");
    writeAbove(
      o.output,
      `Asking ${list} which models it offers. This contacts its service; no session text is sent.`,
    );
  }
  const results = await Promise.allSettled(
    names.map(async (name) => {
      const runner = build(name);
      await runner.preflight?.();
      const [catalog, version] = await Promise.all([runner.listModels?.(), runner.version?.()]);
      return prepared(runner, catalog ?? { ids: [], source: "none" }, version);
    }),
  );
  const candidates: Prepared[] = [];
  const issues: string[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") candidates.push(result.value);
    else {
      const name = names[index] as RunnerName;
      issues.push(`${RUNNER_INFO[name].displayName}: ${oneLine(result.reason)}`);
    }
  }
  if (!candidates.length) throw new Error(`${issues.join(" ")}${pinHint ? ` ${pinHint}` : ""}`);
  for (const issue of issues) writeAbove(o.output, issue);
  return candidates;
}

/** Local discovery and capability checks. Model calls start only after command consent. */
export async function openRunSession(o: RunSessionOptions): Promise<RunSession> {
  const env = o.env ?? process.env;
  const mode = parseRunnerMode(o.runner);
  const selected = mode === "auto" ? undefined : mode;
  const explicit: ExplicitModels = {};
  // What to change to allow another CLI: flags to remove, variables to unset.
  const remove: string[] = [];
  const unset: string[] = [];
  let pins = 0;
  const pinnedBy = (key: PinKey, value: string | undefined, flag: string) => {
    pins++;
    const variable = PIN_VARIABLES[key];
    const fromVariable = !o.ignoreWorkflowDefaults && variable ? env[variable] : undefined;
    const source =
      o.pinSources?.[key] ??
      (fromVariable !== undefined && fromVariable.trim() === value?.trim()
        ? "environment"
        : "flag");
    if (source === "flag" || !variable) remove.push(flag);
    // Without the flag, a set variable still pins the run.
    if (variable && (source === "environment" || fromVariable)) unset.push(variable);
  };
  if (selected) pinnedBy("runner", o.runner, "--runner");
  for (const key of Object.keys(FLAGS) as (keyof ExplicitModels)[]) {
    const model = checkedModel(o.explicit[key], FLAGS[key]);
    if (model) {
      explicit[key] = model;
      pinnedBy(key, o.explicit[key], FLAGS[key]);
    }
  }
  const subagentModel = checkedModel(
    o.ignoreWorkflowDefaults ? undefined : env[SUBAGENT_MODEL_ENV] || undefined,
    SUBAGENT_MODEL_ENV,
  );
  if (subagentModel) unset.push(SUBAGENT_MODEL_ENV);
  const pinned = !!(pins || subagentModel || o.injectedRunner);
  const actions = [];
  if (remove.length) actions.push(`remove ${remove.join(" and ")}`);
  if (unset.length) actions.push(`unset ${[...new Set(unset)].join(" and ")}`);
  const pinHint =
    o.pinHint ??
    (actions.length
      ? `To allow another CLI, ${actions.join(" and ")}.`
      : o.injectedRunner
        ? "The supplied runner is fixed for this run."
        : "");

  const candidates = await prepareCandidates(o, selected, pinned, pinHint);
  return createSession(o, candidates, explicit, subagentModel, pinned, pinHint);
}

function createSession(
  o: RunSessionOptions,
  candidates: Prepared[],
  explicit: ExplicitModels,
  subagentModel: string | undefined,
  pinned: boolean,
  pinHint: string,
): RunSession {
  const env = o.env ?? process.env;
  const ink = palette(canColor({ output: o.output }));
  let quality = o.quality;
  let disclosed = false;
  let checked: Promise<CheckResult> | undefined;
  // Every switch and step-down, for the run summary.
  const changes: PoolEvent[] = [];
  // While the readiness check runs, a stop line is its result: the caller
  // prints it once, instead of the session printing it as well.
  let checking = 0;
  let stopLine: string | undefined;
  // After Ctrl-C a failed check is the interrupt, never a CLI failure.
  let interrupted = false;
  const pool = createRunnerPool({
    candidates,
    pinned,
    pinHint,
    quality: () => quality,
    injected: !!o.injectedRunner,
    fallbackDisclosed: () => disclosed,
    sleep: o.sleep,
    purposes: o.purposes,
    onEvent: (event) => {
      if (event.kind !== "exhausted") changes.push(event);
      else if (checking) {
        stopLine = event.line;
        return;
      }
      writeAbove(o.output, event.line);
    },
  });
  const active = (): Prepared =>
    candidates.find((item) => item.runner.name === pool.active()) as Prepared;
  function explicitFor(stage: StageKey): string | undefined {
    switch (stage) {
      case "cluster":
        return explicit.cluster ?? explicit.model;
      case "author":
        return explicit.author ?? explicit.model;
      case "generalize":
        return explicit.model ?? subagentModel;
      case "roles":
        return explicit.author ?? explicit.model ?? subagentModel;
      case "propose":
        return explicit.propose ?? explicit.model ?? subagentModel;
      default:
        return explicit.model;
    }
  }
  /** The flag or variable that chose a stage's model, when one did. */
  function chosenBy(stage: StageKey): string | undefined {
    const from = (key: keyof ExplicitModels) => {
      const variable = PIN_VARIABLES[key];
      const value = variable && !o.ignoreWorkflowDefaults ? env[variable] : undefined;
      const source =
        o.pinSources?.[key] ??
        (value !== undefined && value.trim() === explicit[key] ? "environment" : "flag");
      return source === "environment" && variable ? variable : FLAGS[key];
    };
    switch (stage) {
      case "cluster":
        return explicit.cluster ? from("cluster") : explicit.model ? from("model") : undefined;
      case "author":
        return explicit.author ? from("author") : explicit.model ? from("model") : undefined;
      case "generalize":
        return explicit.model ? from("model") : subagentModel ? SUBAGENT_MODEL_ENV : undefined;
      case "roles":
        return explicit.author
          ? from("author")
          : explicit.model
            ? from("model")
            : subagentModel
              ? SUBAGENT_MODEL_ENV
              : undefined;
      case "propose":
        return explicit.propose
          ? from("propose")
          : explicit.model
            ? from("model")
            : subagentModel
              ? SUBAGENT_MODEL_ENV
              : undefined;
      default:
        return explicit.model ? from("model") : undefined;
    }
  }
  const modelFor = (stage: StageKey) =>
    explicitFor(stage) ?? (o.injectedRunner ? undefined : planLabel(quality, STAGE_ROLE[stage]));
  const displayModelFor = (stage: StageKey, choice = quality) =>
    explicitFor(stage) ??
    (o.injectedRunner ? "CLI default" : pool.roleFor(STAGE_ROLE[stage], choice).display);

  function describe(): SessionDescription {
    const used = active();
    const start = candidates.indexOf(used);
    const info = RUNNER_INFO[used.runner.name];
    // The plan screens name each step's model, so a model chosen by flag needs
    // no note of its own; the notes say why the CLI's list gave what it gave.
    const describePlan = (choice: Quality) => {
      const notes = explicit.model || o.injectedRunner ? [] : [...used.plans[choice].notes];
      return {
        bulk: displayModelFor("digest", choice),
        major: displayModelFor("author", choice),
        notes,
      };
    };
    const alsoReady = pinned
      ? []
      : candidates.slice(start + 1).map((item) => RUNNER_INFO[item.runner.name].displayName);
    disclosed = alsoReady.length > 0;
    const plans = Object.fromEntries(
      QUALITIES.map((choice) => [choice, describePlan(choice)]),
    ) as SessionDescription["plans"];
    // A plan's effort goes with the models the plan chose, not with one the person named.
    const setsEffort =
      !o.injectedRunner && !explicit.model && used.runner.acceptsEffort?.() === true;
    return {
      runnerLine: used.version
        ? `${info.displayName} (${info.binary} ${used.version})`
        : info.displayName,
      alsoReady,
      pinned,
      plans,
      qualityChoice:
        setsEffort ||
        new Set(QUALITIES.map((choice) => `${plans[choice].bulk}\n${plans[choice].major}`)).size >
          1,
      setsEffort,
      ...(used.runner.maxConcurrency !== undefined
        ? { maxConcurrency: used.runner.maxConcurrency }
        : {}),
    };
  }

  type RoleCheck =
    | { ok: true; runner: RunnerName; answered?: string; line?: string }
    | { ok: false; line: string };

  // One model's readiness. The pool switches CLI only for failures that mean
  // the CLI cannot serve this run, and steps a refused model down. A slow or
  // malformed answer still shows the CLI responds, so the run continues on it
  // with a note. A plain CLI error, or a temporary failure that outlasted its
  // retries, is checked once more; two in a row on one CLI count as a CLI that
  // stopped working, so the check moves to the next disclosed CLI, which then
  // gets the same treatment.
  const unconfirmedSaid = new Set<string>();
  async function checkRole(stage: StageKey, announced: Set<RunnerName>): Promise<RoleCheck> {
    let counting = pool.active();
    let failures = 0;
    for (;;) {
      const runner = pool.active();
      // The call takes a few seconds; say what is happening, once per CLI.
      if (!announced.has(runner)) {
        announced.add(runner);
        writeAbove(
          o.output,
          ink.magenta(`Checking that ${RUNNER_INFO[runner].displayName} is ready.`),
        );
      }
      let answered: string | undefined;
      try {
        checking++;
        try {
          await pool.check({
            model: modelFor(stage),
            prompt: 'Return the JSON object {"ok":true}.',
            schema: z.object({ ok: z.literal(true) }),
            disableTools: true,
            timeoutMs: LIVE_CHECK_TIMEOUT_MS,
            onResolved: (resolved) => {
              answered = resolved.model;
            },
          });
        } finally {
          checking--;
        }
        return { ok: true, runner: pool.active(), answered };
      } catch (error) {
        if (interrupted) return { ok: false, line: INTERRUPTED };
        if (stopLine) return { ok: false, line: stopLine };
        // The error comes from the CLI that is active now, which may be a new one.
        const now = pool.active();
        const reason = classifyFailure(now, error);
        const flag = chosenBy(stage);
        if (reason === "model-unavailable" && flag) {
          return {
            ok: false,
            line: `${RUNNER_INFO[now].displayName} cannot use ${modelFor(stage)} (your provider refused it or does not offer it), chosen by ${flag}. No session text was sent; choose another model for ${flag}.`,
          };
        }
        if (reason === "timeout" || reason === "validation") {
          const name = RUNNER_INFO[now].displayName;
          const why =
            reason === "timeout"
              ? "the readiness check timed out"
              : "the readiness answer was not valid";
          const line = `Could not confirm that ${name} is ready (${why}). Continuing with ${name}.`;
          // Said once per CLI, however many of its models could not confirm.
          if (!unconfirmedSaid.has(line)) {
            unconfirmedSaid.add(line);
            writeAbove(o.output, line);
          }
          return { ok: true, runner: now, line };
        }
        const failed = {
          ok: false as const,
          line: `${RUNNER_INFO[now].displayName} is not ready: ${oneLine(error)}`,
        };
        if (reason !== "cli-error" && reason !== "transient") return failed;
        if (now !== counting) {
          counting = now;
          failures = 0;
        }
        if (++failures < 2) continue;
        // A check of the other model may have switched CLI meanwhile: check there.
        if (pool.active() !== now) continue;
        if (!pool.switchAfterFailures(reason)) return failed;
      }
    }
  }

  // Every distinct model the plan calls on the active CLI gets the tiny
  // request at once, so a refused writing model is found before the work
  // starts. After a switch, the new CLI's models are checked the same way.
  async function check(planned: readonly StageKey[]): Promise<CheckResult> {
    if (o.injectedRunner) return { ok: true };
    /** One stage per distinct model, with every planned stage that model serves. */
    const roles = (): { stage: StageKey; serves: StageKey[] }[] => {
      const byModel = new Map<string, { stage: StageKey; serves: StageKey[] }>();
      for (const stage of planned) {
        const model = displayModelFor(stage);
        const entry = byModel.get(model);
        if (entry) entry.serves.push(stage);
        else byModel.set(model, { stage, serves: [stage] });
      }
      return [...byModel.values()];
    };
    const announced = new Set<RunnerName>();
    const results = new Map<StageKey, RoleCheck & { ok: true }>();
    for (;;) {
      const runner = pool.active();
      // Each pass ends confirmed or after a switch, and each CLI is tried once.
      const pending = roles().filter((item) => results.get(item.stage)?.runner !== runner);
      if (!pending.length) break;
      const done = await Promise.all(pending.map((item) => checkRole(item.stage, announced)));
      for (const [index, result] of done.entries()) {
        if (!result.ok) return result;
        results.set((pending[index] as { stage: StageKey }).stage, result);
      }
    }
    const ready = RUNNER_INFO[pool.active()].displayName;
    const stages = roles();
    const checkedRoles = stages.map((item) => results.get(item.stage) as RoleCheck & { ok: true });
    const unconfirmed = checkedRoles.find((result) => result.line)?.line;
    const answers = checkedRoles.flatMap((result, index) => {
      const item = stages[index] as { stage: StageKey; serves: StageKey[] };
      return result.line
        ? []
        : [
            {
              model: result.answered ?? displayModelFor(item.stage),
              words: stageWords(item.serves),
              reported: result.answered,
            },
          ];
    });
    const models = new Set(answers.map((answer) => answer.model));
    if (answers.length && models.size === 1 && answers.length === stages.length) {
      const reported = answers[0]?.reported;
      writeAbove(
        o.output,
        ink.green(reported ? `${ready} is ready (${reported}).` : `${ready} is ready.`),
      );
    } else if (answers.length) {
      const parts = answers.map((answer) => `${answer.model} ${answer.words}`);
      writeAbove(o.output, `${ink.green(`${ready} is ready`)}: ${ink.yellow(parts.join(", "))}.`);
    }
    return unconfirmed ? { ok: true, line: unconfirmed } : { ok: true };
  }

  return {
    pinned,
    identityRunner: pinned ? pool.active() : null,
    runnerChoices:
      pinned || candidates.length < 2
        ? []
        : candidates.map((item) => ({
            name: item.runner.name,
            select: () =>
              createSession(
                o,
                [item],
                explicit,
                subagentModel,
                true,
                "Run npx human-hindsight reflect to choose another CLI.",
              ),
          })),
    get ledgerRunner() {
      return pool.active();
    },
    get quality() {
      return quality;
    },
    set quality(value) {
      quality = value;
    },
    modelFor,
    displayModelFor,
    describe,
    liveCheck: (stages = "digest") =>
      (checked ??= check(typeof stages === "string" ? PLAN_STAGES[stages] : stages)),
    run: pool.run,
    adapter: pool.adapter,
    summaryLines: () => {
      const lines = pool.used().map(({ runner, calls, models }) => {
        const detail = models.length ? ` (${models.join(", ")})` : "";
        return `${RUNNER_INFO[runner].displayName}: ${calls} CLI ${calls === 1 ? "call" : "calls"}${detail}.`;
      });
      for (const change of changes) {
        lines.push(
          change.kind === "switch" && change.to
            ? `Switched from ${RUNNER_INFO[change.runner].displayName} to ${RUNNER_INFO[change.to].displayName} (${describeReason(change.reason)}).`
            : change.line,
        );
      }
      const cost = pool.costSummary();
      if (cost) lines.push(...cost.split("\n"));
      return lines;
    },
    interrupt: () => {
      interrupted = true;
      pool.interrupt();
    },
    finalize: pool.finalize,
  };
}
