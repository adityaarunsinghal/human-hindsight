import type { Writable } from "node:stream";
import { defineCommand } from "citty";
import {
  environmentFixes,
  environmentSetupRows,
  readExportSessionShare,
  startEnvironment,
} from "../core/environment.js";
import {
  CLAUDE_CLOUD_MODEL_NOTE,
  claudeUsesCloudProvider,
  installAndSignIn,
} from "../runners/capabilities.js";
import { orderCandidates } from "../runners/pool.js";
import { makeRunner, parseRunnerList, RUNNER_INFO } from "../runners/registry.js";
import type { RunnerIo } from "../runners/shared.js";
import type { RunnerName } from "../runners/types.js";
import { heading, setupTable } from "../ui/screen.js";
import { sayThenRun, wrapText } from "../ui/wrap.js";
import { resolvePaths, sharedArgs } from "./_shared.js";
import { flowArgs } from "./next.js";

type DoctorArgs = Parameters<typeof resolvePaths>[0] & {
  source?: string;
  project?: string;
  runner?: string;
};

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function checkCommands(installed: RunnerName[], io?: RunnerIo) {
  return Promise.all(
    installed.map(async (name) => {
      try {
        await makeRunner(name, { io }).preflight?.();
        return { name, ok: true as const };
      } catch (error) {
        const reason = error instanceof Error ? oneLine(error.message) : "Capability check failed.";
        return { name, ok: false as const, reason };
      }
    }),
  );
}

/**
 * One fix: the sentence wraps, and the command it ends with ("... Run codex
 * login") goes alone on its own line, whole, so it can be copied.
 */
export function fixLines(fix: string, width: number): string[] {
  const match = /^(.*?[.,]) ([Rr]un) (.+)$/.exec(fix);
  if (!match) return wrapText(fix, width);
  const [, says = "", run = "", command = ""] = match;
  return sayThenRun(`${says} ${run}:`, command, width);
}

export async function runDoctor(
  input: DoctorArgs,
  deps: { output?: Writable; io?: RunnerIo; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const args = flowArgs(input);
  const paths = resolvePaths(args);
  const out = deps.output ?? process.stdout;
  const write = (line = "") => out.write(`${line}\n`);
  // With an order of several CLIs, the first is the one a run starts on.
  const named = parseRunnerList(args.runner);
  const mode = named === "auto" ? "auto" : (named[0] ?? "auto");
  const discovery = await startEnvironment(paths, {
    ...args,
    io: deps.io,
    env,
    command: "doctor",
  });
  try {
    const initial = discovery.snapshot();
    write(heading("Check my setup"));
    write(`Node ${process.versions.node} on ${process.platform} ${process.arch}`);
    // The folder is alone on its line so a long path can be copied whole.
    write(`Data home (${initial.dataHomeWritable ? "writable" : "not writable"}):`);
    write(`  ${initial.home}`);
    write();
    const installed = initial.rows.flatMap((row) =>
      row.installed && row.name !== "kirocrew" ? [row.name] : [],
    );
    const [checks] = await Promise.all([checkCommands(installed, deps.io), discovery.settled]);
    const snapshot = discovery.snapshot();
    const width = (out as NodeJS.WriteStream).columns || 80;
    // Read from the environment only; nothing is run to find it out. The note
    // belongs to Claude Code, so it sits under that row.
    const cloud = installed.includes("claude") && claudeUsesCloudProvider(env);
    const rows = environmentSetupRows(snapshot).map((row, i) =>
      cloud && snapshot.rows[i]?.name === "claude"
        ? { ...row, note: CLAUDE_CLOUD_MODEL_NOTE }
        : row,
    );
    for (const line of setupTable(rows, width)) write(line);
    const fixes = environmentFixes(snapshot);
    const available: RunnerName[] = [];
    for (const check of checks) {
      if (check.ok) available.push(check.name);
      else
        fixes.push(
          `${RUNNER_INFO[check.name].displayName} cannot run a reflection. ${check.reason}`,
        );
    }
    if (fixes.length) {
      write();
      for (const fix of fixes) for (const line of fixLines(fix, width)) write(line);
    }
    if (snapshot.totals?.sessions === 0) {
      const custom =
        "For a custom store, use --claude-dir, --codex-dir, --kiro-dir, --kirocrew-dir, or --opencode-dir.";
      for (const line of wrapText(custom, width)) write(line);
    }
    write();
    const share = readExportSessionShare(paths.home, args);
    const explicit = mode === "auto" ? undefined : mode;
    const choice = explicit ?? orderCandidates(available, share)[0];
    if (!choice) {
      write(
        "Export works without a compatible CLI. Resolve a setup issue above to reflect on your history.",
      );
    } else if (!available.includes(choice)) {
      const { displayName } = RUNNER_INFO[choice];
      write(
        `Reflection cannot use the selected ${displayName}. Remove --runner to select automatically.`,
      );
      if (!installed.includes(choice))
        write(`Install ${displayName} with ${installAndSignIn(choice)}`);
    } else {
      const count = share[choice] ?? 0;
      let reason = "it is the first ready CLI in the default order";
      if (explicit) reason = "you chose it with --runner";
      else if (count) {
        reason = `most of your exported sessions come from it (${count} ${count === 1 ? "session" : "sessions"})`;
      }
      for (const line of wrapText(
        `Reflection would use ${RUNNER_INFO[choice].displayName}: ${reason}. The sign-in column is a hint from each tool's own status command; reflection checks access after you approve its plan.`,
        width,
      )) {
        write(line);
      }
    }
    return available.length ? 0 : 1;
  } finally {
    discovery.close();
  }
}

export default defineCommand({
  meta: {
    name: "doctor",
    description: "Check local history, CLI versions, sign-in hints, and reflection setup",
  },
  args: { ...sharedArgs },
  async run({ args }) {
    process.exitCode = await runDoctor(args);
  },
});
