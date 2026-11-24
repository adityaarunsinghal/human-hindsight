import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DataHomeSource, ResolvedPaths } from "../commands/_shared.js";
import { installAndSignIn } from "../runners/capabilities.js";
import { makeRunner, RUNNER_INFO } from "../runners/registry.js";
import { defaultIo, type RunnerIo } from "../runners/shared.js";
import type { RunnerName, SignInHint } from "../runners/types.js";
import { SOURCE_PRODUCT_NAMES } from "../sources/labels.js";
import { parseSourceMode } from "../sources/registry.js";
import type { SourceName } from "../sources/types.js";
import type { SetupRow } from "../ui/screen.js";
import { counted } from "../ui/style.js";
import { type HistoryCounts, startHistoryCount } from "./environment-history.js";
import { readExportStats } from "./export-stats.js";

export { isEnvironmentWorker } from "./environment-history.js";

const tools = Object.keys(SOURCE_PRODUCT_NAMES) as SourceName[];
const runnerNames = Object.keys(RUNNER_INFO) as RunnerName[];

const runnerFor = (source: SourceName): RunnerName => (source === "kirocrew" ? "kiro" : source);

export function platformNotice(): string | undefined {
  if (process.platform === "win32")
    return "On Windows, run Human Hindsight in WSL for full support.";
  return undefined;
}

export async function installedRunnerNames(io: RunnerIo = defaultIo): Promise<RunnerName[]> {
  const matches = await Promise.all(
    runnerNames.map(async (name) => ((await io.which(RUNNER_INFO[name].binary)) ? name : null)),
  );
  return matches.filter((name): name is RunnerName => name !== null);
}

type SessionShare = Partial<Record<RunnerName, number>>;

function addToShare(share: SessionShare, origin: SourceName, count: number): void {
  const name = runnerFor(origin);
  share[name] = (share[name] ?? 0) + count;
}

export function runnerSessionShare(entries: readonly { origin?: SourceName }[]): SessionShare {
  const share: SessionShare = {};
  for (const entry of entries) {
    const origin = entry.origin ?? "claude";
    if (Object.hasOwn(SOURCE_PRODUCT_NAMES, origin)) addToShare(share, origin, 1);
  }
  return share;
}

interface HistoryScope {
  project?: string;
  source?: string;
}

/** Account for older exports without a stats file or an origin field. */
export function readExportSessionShare(home: string, scope: HistoryScope = {}): SessionShare {
  const mode = parseSourceMode(scope.source);
  const project = scope.project?.toLowerCase();
  const stats = readExportStats(home);
  const share: SessionShare = {};
  if (stats && (!project || stats.project?.toLowerCase() === project)) {
    for (const name of tools) {
      if ((mode === "auto" || mode === name) && stats.sessions_by_origin[name]) {
        addToShare(share, name, stats.sessions_by_origin[name] ?? 0);
      }
    }
    return share;
  }
  try {
    const manifest: unknown = JSON.parse(
      fs.readFileSync(path.join(home, "exports", "manifest.json"), "utf8"),
    );
    if (!Array.isArray(manifest)) return share;
    for (const entry of manifest) {
      if (!entry || typeof entry !== "object" || typeof entry.export !== "string") continue;
      const name = entry.origin ?? "claude";
      if (typeof name !== "string" || !Object.hasOwn(SOURCE_PRODUCT_NAMES, name)) continue;
      if (mode !== "auto" && mode !== name) continue;
      if (
        project &&
        (typeof entry.project !== "string" || !entry.project.toLowerCase().includes(project))
      ) {
        continue;
      }
      addToShare(share, name as SourceName, 1);
    }
  } catch {
    // No usable manifest yet. Candidate ordering falls back to the installed commands.
  }
  return share;
}

export interface EnvironmentRow {
  name: SourceName;
  tool: string;
  included: boolean;
  storePresent: boolean;
  history?: HistoryCounts;
  historyError?: string;
  installed: boolean;
  binary: string;
  version?: string;
  versionPending: boolean;
  signIn?: SignInHint;
  signInPending: boolean;
  /** The exact command to resolve this row's first outstanding issue. */
  fix?: string;
}

export interface EnvironmentSnapshot {
  home: string;
  dataHomeWritable: boolean;
  dataHomeFix?: string;
  rows: EnvironmentRow[];
  pending: string[];
  totals?: Omit<HistoryCounts, "exact">;
}

export interface EnvironmentDiscovery {
  snapshot(): EnvironmentSnapshot;
  subscribe(callback: () => void): () => void;
  settled: Promise<void>;
  close(): void;
}

function storeRoots(paths: ResolvedPaths): Record<SourceName, string[]> {
  return {
    claude: [path.join(paths.claudeDir, "projects")],
    codex: [path.join(paths.codexDir, "sessions"), path.join(paths.codexDir, "archived_sessions")],
    kiro: [path.join(paths.kiroDir, "sessions")],
    kirocrew: [path.join(paths.kirocrewDir, "sessions")],
    opencode:
      paths.opencodeDb === ":memory:"
        ? []
        : [paths.opencodeDb, path.join(paths.opencodeDir, "storage", "session")],
  };
}

function inspectStore(
  roots: string[],
  db: string,
): Pick<EnvironmentRow, "storePresent" | "historyError"> {
  for (const root of roots) {
    try {
      const stat = fs.statSync(root);
      if (root === db ? !stat.isFile() : !stat.isDirectory()) {
        return { storePresent: true, historyError: `Unexpected store type at ${root}` };
      }
      fs.accessSync(
        root,
        stat.isDirectory() ? fs.constants.R_OK | fs.constants.X_OK : fs.constants.R_OK,
      );
      return { storePresent: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return {
          storePresent: false,
          historyError: `Cannot access ${root} (${code ?? "unreadable"})`,
        };
      }
    }
  }
  return { storePresent: false };
}

/** A missing home can be created if its nearest existing parent is a writable directory. */
function writableHome(home: string): boolean {
  let candidate = path.resolve(home);
  for (;;) {
    try {
      if (!fs.statSync(candidate).isDirectory()) return false;
      fs.accessSync(candidate, fs.constants.W_OK | fs.constants.X_OK);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      // A dangling link cannot be replaced by mkdir.
      try {
        if (fs.lstatSync(candidate, { throwIfNoEntry: false })) return false;
      } catch {
        return false;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) return false;
      candidate = parent;
    }
  }
}

/**
 * The command that points at `dir` (a shell expression such as
 * `$HOME/.human-hindsight`), in the form that wins for how the data home was
 * chosen. `--home` beats the variable, so a folder chosen by the flag is
 * changed with the flag; one chosen by the variable, or the default, with the
 * variable. `command` is the command to run again with the flag (none for the
 * home screen).
 */
export function dataHomeFixFor(dir: string, chosenBy: DataHomeSource, command?: string): string {
  if (chosenBy === "flag")
    return ["human-hindsight", command, `--home "${dir}"`].filter(Boolean).join(" ");
  return `export HUMAN_HINDSIGHT_HOME="${dir}"`;
}

/** A writable folder to suggest instead of `home`, as a shell expression. */
function writableAlternative(home: string): string {
  const alternatives = [".human-hindsight", ".human-hindsight-data"];
  for (const name of alternatives) {
    const candidate = path.join(os.homedir(), name);
    if (candidate !== path.resolve(home) && writableHome(candidate)) return `$HOME/${name}`;
  }
  if (writableHome(path.join(process.cwd(), ".human-hindsight"))) return "$PWD/.human-hindsight";
  return "$(mktemp -d)";
}

const startCommands: Record<SourceName, string> = {
  claude: "claude",
  codex: "codex",
  kiro: "kiro-cli chat",
  kirocrew: "kirocrew",
  opencode: "opencode",
};

function rowFix(row: EnvironmentRow, project?: string): string | undefined {
  const runner = runnerFor(row.name);
  const info = RUNNER_INFO[runner];
  if (!row.installed) return installAndSignIn(runner);
  if (row.signIn?.state === "needs-sign-in") return row.signIn.fix ?? info.loginCommand;
  if (row.included && row.history?.exact && !row.history.sessions) {
    return project ? `human-hindsight scan --source ${row.name}` : startCommands[row.name];
  }
  return undefined;
}

function totals(rows: EnvironmentRow[]): EnvironmentSnapshot["totals"] {
  const counted: Omit<HistoryCounts, "exact"> = { sessions: 0, projects: 0, newSessions: 0 };
  for (const row of rows) {
    if (!row.included) continue;
    if (!row.history?.exact || row.historyError) return undefined;
    counted.sessions += row.history.sessions;
    counted.projects += row.history.projects;
    counted.newSessions += row.history.newSessions;
    if (row.history.newest && (!counted.newest || row.history.newest > counted.newest)) {
      counted.newest = row.history.newest;
    }
  }
  return counted;
}

function pendingFacts(rows: EnvironmentRow[]): string[] {
  const pending: string[] = [];
  if (rows.some((row) => row.included && !row.history && !row.historyError)) {
    pending.push("history counts");
  }
  if (
    rows.some((row) => row.name === "kiro" && row.history?.exact === false && !row.historyError)
  ) {
    pending.push("Kiro Crew runs in Kiro CLI history");
  }
  if (rows.some((row) => row.versionPending)) pending.push("command versions");
  if (rows.some((row) => row.signInPending)) pending.push("sign-in hints");
  return pending;
}

export interface EnvironmentOptions extends HistoryScope {
  newerThan?: Date;
  /** Every command probe goes through this runner. */
  io?: RunnerIo;
  /** The environment the CLIs see, for credential and config hints. */
  env?: NodeJS.ProcessEnv;
  /** The history counter; the default reads stores in a background thread. */
  countHistory?: typeof startHistoryCount;
  /** The command a fix that changes `--home` runs again (none: the home screen). */
  command?: string;
}

/**
 * Discover history stores, installed commands, versions and sign-in hints.
 * Only local probes run here (see PROBES in runners/capabilities.ts): versions
 * and sign-in status. Model lists are fetched while a run is being prepared.
 */
export async function startEnvironment(
  paths: ResolvedPaths,
  options: EnvironmentOptions = {},
): Promise<EnvironmentDiscovery> {
  const mode = parseSourceMode(options.source);
  const io = options.io ?? defaultIo;
  const countHistory = options.countHistory ?? startHistoryCount;
  const installed = await installedRunnerNames(io);
  const roots = storeRoots(paths);
  const dataHomeWritable = writableHome(paths.home);
  const dataHomeFix = dataHomeWritable
    ? undefined
    : dataHomeFixFor(
        writableAlternative(paths.home),
        paths.homeSource ?? "default",
        options.command,
      );
  let rows = tools.map((name): EnvironmentRow => {
    const runner = runnerFor(name);
    const included = mode === "auto" || mode === name;
    const store = inspectStore(roots[name], paths.opencodeDb);
    const hasCommand = installed.includes(runner);
    const history: HistoryCounts | undefined =
      included && !store.storePresent && !store.historyError
        ? { projects: 0, sessions: 0, newSessions: 0, exact: true }
        : undefined;
    return {
      name,
      tool: SOURCE_PRODUCT_NAMES[name],
      included,
      ...store,
      history,
      installed: hasCommand,
      binary: RUNNER_INFO[runner].binary,
      versionPending: hasCommand && name !== "kirocrew",
      signInPending: hasCommand && name !== "kirocrew",
    };
  });
  const listeners = new Set<() => void>();
  const controller = new AbortController();
  const update = (name: SourceName, patch: Partial<EnvironmentRow>) => {
    if (controller.signal.aborted) return;
    rows = rows.map((row) => (row.name === name ? { ...row, ...patch } : row));
    for (const listener of listeners) listener();
  };
  const probeIo: RunnerIo = {
    which: io.which.bind(io),
    spawn: (binary, args, opts) => io.spawn(binary, args, { ...opts, signal: controller.signal }),
  };
  const countNames = rows
    .filter((row) => row.included && row.storePresent && !row.historyError)
    .map((row) => row.name);

  // Give callers the presence-only snapshot before starting subprocesses or traversing history.
  const settled = new Promise<void>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(), { once: true });
    setImmediate(async () => {
      if (controller.signal.aborted) return;
      const tasks = [
        countHistory(
          { paths, names: countNames, project: options.project, newerThan: options.newerThan },
          (message) => update(message.name, message),
          controller.signal,
        ),
      ];
      for (const name of installed) {
        const runner = makeRunner(name, { io: probeIo, env: options.env });
        tasks.push(
          Promise.resolve()
            .then(() => runner.version?.())
            .catch(() => undefined)
            .then((version) => update(name, { version, versionPending: false })),
          Promise.resolve()
            .then(() => runner.signInHint?.())
            .catch(() => undefined)
            .then((hint) => {
              const signIn: SignInHint = hint ?? { state: "unknown" };
              update(name, { signIn, signInPending: false });
              if (name === "kiro") update("kirocrew", { signIn });
            }),
        );
      }
      await Promise.allSettled(tasks);
      resolve();
    });
  });
  return {
    snapshot() {
      return {
        rows: rows.map((row) => ({ ...row, fix: rowFix(row, options.project) })),
        home: paths.home,
        dataHomeWritable,
        dataHomeFix,
        pending: pendingFacts(rows),
        totals: totals(rows),
      };
    },
    subscribe(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    settled,
    close() {
      listeners.clear();
      controller.abort();
    },
  };
}

function historyText(row: EnvironmentRow): string {
  if (!row.included) return "outside selection";
  if (row.historyError) return "? unreadable";
  if (!row.history) return "counting";
  if (!row.history.sessions) return row.storePresent ? "empty store" : "no history yet";
  const sessions = counted(row.history.sessions, row.name === "kirocrew" ? "chat" : "session");
  // A count that is not exact yet ends in an ellipsis, never in wider words.
  return `${counted(row.history.projects, "project")} · ${sessions}${row.history.exact ? "" : "…"}`;
}

/** Room a version number takes once it lands, as wide as "2.1.207". */
const VERSION_ROOM = "0.000.0";

/**
 * The setup table's rows. A cell still being checked is never wider than it
 * will be once it settles: a pending version is the command name and an
 * ellipsis. For a frame that is redrawn (`live`), each row also carries the
 * text its cells are measured on (`reserve`): a command with room for its
 * version, and a sign-in cell as wide as "checking", so the live table keeps
 * its height while versions and sign-in land.
 */
export function environmentSetupRows(
  snapshot: EnvironmentSnapshot,
  o: { live?: boolean } = {},
): SetupRow[] {
  const wider = (a: string, b: string) => (b.length > a.length ? b : a);
  return snapshot.rows.map((row) => {
    const history = historyText(row);
    let command: string;
    let roomy: string;
    if (row.name === "kirocrew") command = roomy = "uses kiro-cli";
    else if (!row.installed) command = roomy = "! missing";
    else {
      if (row.version) command = `✓ ${row.binary} ${row.version}`;
      else command = row.versionPending ? `✓ ${row.binary}…` : `✓ ${row.binary} (version unknown)`;
      roomy = wider(command, `✓ ${row.binary} ${VERSION_ROOM}`);
    }
    let signIn: string | undefined;
    if (row.installed && row.name !== "kirocrew") {
      if (row.signInPending) signIn = "checking";
      else if (row.signIn?.state === "ready") signIn = "✓ ready";
      else if (row.signIn?.state === "needs-sign-in") signIn = `! run ${row.fix}`;
      else signIn = "? not verified";
    }
    const reserve = {
      history,
      command: roomy,
      signIn: signIn === undefined ? undefined : wider(signIn, "checking"),
    };
    return { tool: row.tool, history, command, signIn, ...(o.live ? { reserve } : {}) };
  });
}

export function environmentFixes(snapshot: EnvironmentSnapshot): string[] {
  const fixes: string[] = [];
  if (snapshot.dataHomeFix) {
    const description = snapshot.dataHomeFix.includes("mktemp")
      ? "Choose a temporary writable data home"
      : "Choose a writable data home";
    fixes.push(`${description}. Run ${snapshot.dataHomeFix}`);
  }
  const nothingFound = snapshot.rows.every(
    (row) =>
      !row.installed &&
      (!row.included ||
        (!row.historyError && (row.history?.exact ? !row.history.sessions : !row.storePresent))),
  );
  if (nothingFound) {
    const commands = runnerNames.map(
      (name) => `${RUNNER_INFO[name].displayName}: ${installAndSignIn(name)}`,
    );
    fixes.push(`No coding CLI or history was found. Install one. ${commands.join("; ")}`);
    return fixes;
  }
  for (const row of snapshot.rows) {
    if (!row.included) continue;
    if (row.historyError)
      fixes.push(`${row.tool} history could not be counted. ${row.historyError}`);
    if (!row.fix) continue;
    if (!row.installed) {
      if (row.history?.sessions || (!row.history && row.storePresent)) {
        fixes.push(
          `${row.tool} has a local history store. To distill through ${row.binary}, run ${row.fix}`,
        );
      }
    } else if (row.signIn?.state === "needs-sign-in" && row.name !== "kirocrew") {
      fixes.push(`${row.tool} suggests signing in. Run ${row.fix}`);
    } else if (
      row.history?.exact &&
      !row.history.sessions &&
      (row.name !== "kirocrew" || row.storePresent)
    ) {
      fixes.push(`${row.tool} has no history in this selection. Run ${row.fix}`);
    }
  }
  return fixes;
}
