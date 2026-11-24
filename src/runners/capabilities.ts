import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { AgentRunnerError, type RunnerIo, type SpawnOptions, type SpawnResult } from "./shared.js";
import type { ModelCatalog, RunnerName, SignInHint } from "./types.js";

/**
 * runners/capabilities.ts: what each coding CLI is, how to install and sign in
 * to it, and the metadata probes that never make a model call.
 *
 * Install and sign-in commands were each checked on 2026-11-23: the npm
 * packages exist on the public registry with the named binary, the Kiro
 * install URL serves its installer, `claude auth login` and
 * `opencode auth login` appear in those CLIs' own messages, Kiro's signed-out
 * error names `kiro-cli login`, and `codex login status` is a subcommand of
 * `codex login`.
 */
export const RUNNER_INFO = {
  claude: {
    displayName: "Claude Code",
    binary: "claude",
    installCommand: "npm install -g @anthropic-ai/claude-code",
    loginCommand: "claude auth login",
  },
  codex: {
    displayName: "Codex",
    binary: "codex",
    installCommand: "npm install -g @openai/codex",
    loginCommand: "codex login",
  },
  kiro: {
    displayName: "Kiro CLI",
    binary: "kiro-cli",
    installCommand: "curl -fsSL https://cli.kiro.dev/install | bash",
    loginCommand: "kiro-cli login",
  },
  opencode: {
    displayName: "OpenCode",
    binary: "opencode",
    installCommand: "npm install -g @opencode/cli",
    loginCommand: "opencode auth login",
  },
} satisfies Record<
  RunnerName,
  {
    displayName: string;
    binary: string;
    installCommand: string;
    loginCommand: string;
  }
>;

/** One shell line that installs a CLI and then signs in to it. */
export function installAndSignIn(name: RunnerName): string {
  const { installCommand, loginCommand } = RUNNER_INFO[name];
  return `${installCommand} && ${loginCommand}`;
}

export function missingBinaryHint(name: RunnerName): string {
  const { binary, installCommand, loginCommand } = RUNNER_INFO[name];
  const signIn =
    name === "opencode"
      ? `then add a provider with \`${loginCommand}\``
      : `then sign in with \`${loginCommand}\``;
  return `\`${binary}\` was not found on PATH. Install it with \`${installCommand}\`, ${signIn}. Scan and export work without it.`;
}

export async function requireBinary(name: RunnerName, io: RunnerIo): Promise<string> {
  const bin = await io.which(RUNNER_INFO[name].binary);
  if (!bin) throw new AgentRunnerError("missing-binary", missingBinaryHint(name));
  return bin;
}

// --- probes ------------------------------------------------------------------

export type ProbeKind = "version" | "help" | "sign-in" | "models";

/**
 * What a metadata command needs. None of them is ever given session text.
 *
 * - `local`: gives the same answer with networking unavailable to that process.
 * - `own-service`: answers with networking unavailable, but when a connection
 *   exists it may also contact the tool's own service (`kiro-cli whoami`).
 * - `network`: needs a provider, and may fail without one.
 *
 * The home screen and `doctor` run `local` and `own-service` probes, which is
 * why the home screen says only that it asks each tool for its version and
 * sign-in status, not that nothing reaches the network. A `network` probe
 * runs only while a run is being prepared, with a line saying so.
 */
export type ProbeScope = "local" | "own-service" | "network";

export interface ProbeSpec {
  args: readonly string[];
  scope: ProbeScope;
  timeoutMs: number;
}

/**
 * Help probes decide whether a CLI can run at all, so a slow cold start must not
 * drop a working CLI. `--version` only fills a table cell. Model lists may be
 * large (Codex prints about 1.5 MB) or remote.
 */
export const PROBE_TIMEOUT_MS: Record<ProbeKind, number> = {
  version: 5_000,
  help: 15_000,
  "sign-in": 10_000,
  models: 20_000,
};

const probe = (kind: ProbeKind, args: string[], scope: ProbeScope = "local"): ProbeSpec => ({
  args,
  scope,
  timeoutMs: PROBE_TIMEOUT_MS[kind],
});

/**
 * Every metadata command, with its scope. Each scope was verified on
 * 2026-11-23 (Claude Code 2.1.330, Codex 0.171.0, Kiro CLI 3.5.0, OpenCode
 * 1.18.15) by running the command under a macOS sandbox that denied that
 * process outbound IP traffic:
 *
 *   sandbox-exec -p '(version 1)(allow default)(deny network-outbound (remote ip))' <command>
 *
 * Every probe gave the same output as with networking, except two Kiro CLI
 * commands. `kiro-cli chat --list-models` failed after 14 s ("dispatch
 * failure"). `kiro-cli whoami` still exits 0 offline and names the sign-in
 * method, but online it prints one more line and answers sooner: it contacts
 * Kiro's service when it can, so its scope is `own-service`. Codex
 * and OpenCode read their model lists from local caches; the OpenCode runner
 * also sets OPENCODE_DISABLE_MODELS_FETCH. Claude's aliases need no process.
 * Claude's `--claude-help` fallback is local as well.
 */
export const PROBES: Record<RunnerName, Partial<Record<ProbeKind, ProbeSpec>>> = {
  claude: {
    version: probe("version", ["--version"]),
    help: probe("help", ["--help"]),
    "sign-in": probe("sign-in", ["auth", "status"]),
  },
  codex: {
    version: probe("version", ["--version"]),
    help: probe("help", ["exec", "--help"]),
    "sign-in": probe("sign-in", ["login", "status"]),
    models: probe("models", ["debug", "models"]),
  },
  kiro: {
    version: probe("version", ["--version"]),
    help: probe("help", ["chat", "--help"]),
    "sign-in": probe("sign-in", ["whoami"], "own-service"),
    models: probe("models", ["chat", "--list-models", "--format", "json"], "network"),
  },
  opencode: {
    version: probe("version", ["--version"]),
    help: probe("help", ["run", "--help"]),
    "sign-in": probe("sign-in", ["auth", "list"]),
    models: probe("models", ["models"]),
  },
};

/** Metadata probes never inherit the caller's project directory or read a prompt. */
export const LOCAL_PROBE: SpawnOptions = {
  input: "",
  timeoutMs: PROBE_TIMEOUT_MS.help,
  cwd: os.tmpdir(),
};

function spec(name: RunnerName, kind: ProbeKind): ProbeSpec {
  const found = PROBES[name][kind];
  if (!found) throw new Error(`${RUNNER_INFO[name].displayName} has no ${kind} probe.`);
  return found;
}

/** Spawn one probe; any failure, timeout, or signal is reported as no result. */
async function metadata(
  io: RunnerIo,
  name: RunnerName,
  kind: ProbeKind,
  options: Partial<SpawnOptions> = {},
): Promise<SpawnResult | undefined> {
  try {
    const { args, timeoutMs } = spec(name, kind);
    const bin = await requireBinary(name, io);
    const result = await io.spawn(bin, [...args], { ...LOCAL_PROBE, timeoutMs, ...options });
    return result.timedOut || result.signal ? undefined : result;
  } catch {
    return undefined;
  }
}

const VERSION = /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?)(?![\w.])/i;

/**
 * The version in a `--version` output. A launcher may print notices first, so a
 * line naming the binary, or a line that is only a version, wins over the
 * first number anywhere.
 */
export function versionNumber(text: string, binary?: string): string | undefined {
  const lines = stripVTControlCharacters(text)
    .split(/\r?\n/)
    .map((line) => line.trim());
  const own = lines.find(
    (line) =>
      VERSION.test(line) &&
      ((binary !== undefined && line.toLowerCase().startsWith(binary.toLowerCase())) ||
        /^v?\d+\.\d+/i.test(line)),
  );
  return (own ?? lines.find((line) => VERSION.test(line)))?.match(VERSION)?.[1];
}

/** `timeoutMs` is raised by callers whose decision depends on the answer. */
export async function readVersion(
  io: RunnerIo,
  name: RunnerName,
  timeoutMs = PROBE_TIMEOUT_MS.version,
): Promise<string | undefined> {
  const result = await metadata(io, name, "version", { timeoutMs });
  return result?.code === 0
    ? versionNumber(`${result.stdout}\n${result.stderr}`, RUNNER_INFO[name].binary)
    : undefined;
}

/** Flags advertised by a help text. */
function advertisedFlags(text: string): Set<string> {
  return new Set(stripVTControlCharacters(text).match(/--[\w-]+/g) ?? []);
}

/**
 * Fail before consent when the installed CLI lacks a flag the model call
 * passes. Returns every flag its help lists, for flags that are optional.
 */
export async function requireFlags(
  io: RunnerIo,
  bin: string,
  name: RunnerName,
  flags: readonly string[],
): Promise<Set<string>> {
  const { args, timeoutMs } = spec(name, "help");
  const help = await io.spawn(bin, [...args], { ...LOCAL_PROBE, timeoutMs });
  if (help.code !== 0 || help.signal || help.timedOut) {
    throw new AgentRunnerError(
      "cli-error",
      `Could not read ${RUNNER_INFO[name].binary} ${args.join(" ")}.`,
    );
  }
  const advertised = advertisedFlags(`${help.stdout}\n${help.stderr}`);
  const missing = flags.filter((flag) => !advertised.has(flag));
  if (missing.length) {
    throw new AgentRunnerError(
      "cli-error",
      `Update ${RUNNER_INFO[name].displayName}. The installed ${args[0]} command lacks ${missing.join(", ")}.`,
    );
  }
  return advertised;
}

// --- sign-in hints -------------------------------------------------------------

/** Environment variables that let a CLI work without its own sign-in. */
const CREDENTIAL_VARIABLES: Record<RunnerName, readonly string[]> = {
  claude: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
  ],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  kiro: ["KIRO_API_KEY"],
  opencode: [],
};

/** Claude Code's documented switches for serving models through a cloud provider. */
const CLAUDE_CLOUD_VARIABLES = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"] as const;

/** True when the environment sets Claude Code up for a cloud provider. */
export function claudeUsesCloudProvider(env: NodeJS.ProcessEnv): boolean {
  return CLAUDE_CLOUD_VARIABLES.some((key) => {
    const value = env[key]?.trim().toLowerCase();
    return !!value && value !== "0" && value !== "false";
  });
}

/**
 * The note shown with Claude Code's row when it serves models through a cloud
 * provider: the CLI, not Human Hindsight, turns a family name into a model there.
 */
export const CLAUDE_CLOUD_MODEL_NOTE =
  "Claude Code uses a cloud provider here, and the CLI itself resolves family names such as sonnet, which may be older than the newest model there. To choose, pass --model or set the model in Claude Code's own settings.";

/** True when credentials outside the CLI's own sign-in are configured. */
export function hasOutsideCredentials(name: RunnerName, env: NodeJS.ProcessEnv): boolean {
  return CREDENTIAL_VARIABLES[name].some((key) => Boolean(env[key]));
}

/**
 * A hint from the CLI's own status command, never the authority: it can say "not logged in"
 * while a custom provider makes the CLI work. `configured` says such a setup was
 * found; a negative status then becomes `unknown`.
 */
export async function readSignInHint(
  io: RunnerIo,
  name: RunnerName,
  options?: Partial<SpawnOptions>,
  configured = false,
): Promise<SignInHint> {
  const result = await metadata(io, name, "sign-in", options);
  if (!result) return { state: "unknown" };
  // A status command may print a user identity, address or credential path. Return only the hint.
  const text = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`).trim();
  const needs: SignInHint = configured
    ? { state: "unknown" }
    : { state: "needs-sign-in", fix: RUNNER_INFO[name].loginCommand };
  if (name === "opencode") {
    if (result.code !== 0) return { state: "unknown" };
    if (/\b[1-9]\d*\s+(?:credentials?|environment variables?)\b/i.test(text))
      return { state: "ready" };
    if (/\b(?:0 credentials?|no credentials)\b/i.test(text)) return needs;
    return { state: "unknown" };
  }
  const negative =
    /\b(?:not (?:logged|signed) in|not authenticated|unauthenticated|please (?:log ?in|sign ?in)|no credentials (?:configured|found))\b/i.test(
      text,
    ) || /"loggedIn"\s*:\s*false/.test(text);
  if (negative) return needs;
  const positive =
    /\b(?:logged in|signed in|authenticated as)\b/i.test(text) ||
    /"loggedIn"\s*:\s*true/.test(text);
  // whoami names the current identity on success; its output belongs to the CLI alone.
  if (result.code === 0 && (positive || (name === "kiro" && text.length > 0)))
    return { state: "ready" };
  return { state: "unknown" };
}

// --- Codex configuration -----------------------------------------------------

export interface CodexDefaults {
  model?: string;
  provider?: string;
}

function tomlString(raw: string): string | undefined {
  const value = raw.trim();
  const quoted = value.match(/^"((?:[^"\\]|\\.)*)"|^'([^']*)'/);
  if (!quoted) return undefined;
  return quoted[1] !== undefined ? quoted[1].replace(/\\(.)/g, "$1") : quoted[2];
}

/**
 * The default model and provider in a Codex `config.toml`: the top-level keys,
 * or the ones of the profile that a top-level `profile` selects. Only these
 * keys are read; nothing else in the file is kept or shown.
 */
export function parseCodexConfig(text: string): CodexDefaults {
  const top: Record<string, string> = {};
  const profiles = new Map<string, Record<string, string>>();
  let table: Record<string, string> | undefined = top;
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header?.[1]) {
      const profile = header[1].trim().match(/^profiles\.(?:"([^"]+)"|([\w-]+))$/);
      const name = profile?.[1] ?? profile?.[2];
      if (name) {
        table = profiles.get(name) ?? {};
        profiles.set(name, table);
      } else table = undefined;
      continue;
    }
    const pair = line.match(/^\s*(model|model_provider|profile)\s*=\s*(.+)$/);
    if (!pair?.[1] || !pair[2] || !table) continue;
    const value = tomlString(pair[2]);
    if (value) table[pair[1]] = value;
  }
  const selected = top.profile ? profiles.get(top.profile) : undefined;
  const model = selected?.model ?? top.model;
  const provider = selected?.model_provider ?? top.model_provider;
  return { ...(model ? { model } : {}), ...(provider ? { provider } : {}) };
}

/** Read the Codex config the CLI itself would load; never throws. */
export function codexDefaults(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (file: string) => string = (file) => fs.readFileSync(file, "utf8"),
): CodexDefaults {
  try {
    const root = env.CODEX_HOME || path.join(os.homedir(), ".codex");
    return parseCodexConfig(readFile(path.join(root, "config.toml")));
  } catch {
    return {};
  }
}

// --- model catalogs -------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Preserve catalog IDs verbatim, including any provider, region and version components. */
function catalogId(value: unknown): string | undefined {
  const item = record(value);
  const raw =
    typeof value === "string"
      ? value
      : (item?.slug ??
        item?.modelId ??
        item?.model_id ??
        item?.id ??
        item?.model ??
        item?.modelName ??
        item?.name);
  const id = typeof raw === "string" ? raw.trim() : "";
  // \p{Cc} is every control character; an id with one is not a real model id.
  return id && !/\s|\p{Cc}/u.test(id) ? id : undefined;
}

function parseJsonCatalog(text: string): ModelCatalog {
  try {
    const clean = stripVTControlCharacters(text);
    // Some launchers write a plain-text notice before the CLI's JSON.
    const start = clean.search(/^\s*[[{]/m);
    if (start < 0) return { ids: [], source: "none" };
    const parsed: unknown = JSON.parse(clean.slice(start));
    const root = record(parsed);
    const list = Array.isArray(parsed)
      ? parsed
      : (root?.models ?? root?.availableModels ?? root?.items ?? root?.data);
    let defaultModel = catalogId(
      root?.defaultModel ??
        root?.default_model ??
        root?.defaultModelId ??
        root?.currentModel ??
        root?.default,
    );
    const ids = new Set<string>();
    const add = (value: unknown, key?: string) => {
      const item = record(value);
      const id = key ? catalogId(item?.id ?? item?.slug ?? item?.modelId ?? key) : catalogId(value);
      if (!id) return;
      ids.add(id);
      if (
        !defaultModel &&
        (item?.isDefault === true || item?.is_default === true || item?.default === true)
      )
        defaultModel = id;
    };
    if (Array.isArray(list)) {
      for (const value of list) add(value);
    } else if (record(list)) {
      for (const [key, value] of Object.entries(list as Record<string, unknown>)) add(value, key);
    }
    if (!ids.size) return { ids: [], source: "none" };
    return { ids: [...ids], ...(defaultModel ? { defaultModel } : {}), source: "catalog" };
  } catch {
    return { ids: [], source: "none" };
  }
}

/**
 * The CLI's model list. `configuredModel` is the default from the CLI's own
 * configuration; it wins over a catalog's default because it is what the CLI
 * runs when no model is passed.
 */
export async function readCatalog(
  io: RunnerIo,
  name: RunnerName,
  options?: Partial<SpawnOptions>,
  configuredModel?: string,
): Promise<ModelCatalog> {
  if (name === "claude") return { ids: ["sonnet", "opus", "fable"], source: "aliases" };
  const fallback: ModelCatalog = {
    ids: [],
    ...(configuredModel ? { defaultModel: configuredModel } : {}),
    source: "none",
  };
  const result = await metadata(io, name, "models", options);
  if (result?.code !== 0) return fallback;
  let catalog: ModelCatalog;
  if (name === "opencode") {
    const lines = stripVTControlCharacters(result.stdout).split(/\r?\n/);
    const ids = [
      ...new Set(lines.map((s) => s.trim()).filter((s) => /^[\w.-]+\/[\w./:@+-]+$/.test(s))),
    ];
    catalog = ids.length ? { ids, source: "catalog" } : { ids: [], source: "none" };
  } else catalog = parseJsonCatalog(result.stdout);
  const defaultModel = configuredModel ?? catalog.defaultModel;
  return { ...catalog, ...(defaultModel ? { defaultModel } : {}) };
}
