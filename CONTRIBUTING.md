# Contributing to Human Hindsight

An extraction fix usually starts with a synthetic example of a message that was lost, duplicated, or wrongly attributed to a person. For a terminal or browser change, describe what you were trying to do and where it broke. Please report security issues privately. [Security policy](SECURITY.md)

## Setup

```sh
git clone https://github.com/adityaarunsinghal/human-hindsight.git
cd human-hindsight
npm ci
npm run build
node launcher/cli.cjs --help
```

Develop on macOS, Linux, or WSL.

**Node for building and for running are different.**

- **Building** uses the exact version in `.node-version`. The build tools need Node 22.18+ or 24.11+, and `node scripts/check-release.mjs` fails if `.node-version` drops below that. The pin is an exact version on purpose: some version managers read only exact versions.
- **Running** the installed command needs Node 22.13+ on the 22 line, or 23.4+ (the `engines` field). `launcher/cli.cjs` is the installed entry point. It checks the Node version before loading the bundled CLI and prints how to upgrade. The `cc-hindsight` wrapper enters the same launcher. Keep the launcher parseable on Node 18 so that message can print.

## Checks

```sh
npm run lint          # biome
npm run typecheck     # tsc --noEmit
npm test              # unit tier
npm run test:smoke    # smoke tier
npm run test:budget   # unit tier against its time budget
npm run build
```

CI runs `npx biome ci .`, which also fails on formatting. `npm run format` fixes formatting in place. Text a person reads (comments, test titles, printed lines) uses no em or en dash, and `test/source-text.test.ts` checks the tree for them; text sent to a model is left byte for byte. To see the stack of an unexpected failure, run the command with `HUMAN_HINDSIGHT_DEBUG=1`.

### Two test tiers

- **Unit (`npm test`):** in-process tests only. No child processes, sockets, real terminals, or sleeps. Inject the clock, environment, streams, and process runner, and use the helpers in `test/support/` (fake terminals, a scripted `RunnerIo`, a synthetic data home builder, a seeded clock, and text normalization for golden files; see `test/support/README.md`).
- **Smoke (`npm run test:smoke`):** files named `*.smoke.test.ts`. Anything that starts a process, drives a pseudo-terminal, or packs a tarball belongs here.
- **Budget (`npm run test:budget`):** runs the unit tier once and fails when the whole run, or any single test, takes longer than its budget. It runs at most six test files at once, so a single test's time does not grow with the number of cores. The defaults suit an idle developer machine and can be loosened with `HUMAN_HINDSIGHT_UNIT_BUDGET_MS` and `HUMAN_HINDSIGHT_SLOW_TEST_MS`. A unit test that is slow usually waits on real time or a real disk.

A bare `npx vitest run` runs both. Screens and help pages are compared with golden files under `test/golden/`, plus a few assertions on meaning.

### Synthetic data only

Every fixture is invented: no real names, emails, hostnames, account ids, tokens, home paths, or copied CLI output. `test/setup.ts` replaces `PATH` for every test with an empty folder plus system folders that hold no coding CLI, so a test can never start a real `claude`, `codex`, `kiro-cli`, or `opencode`. A test that needs one supplies a fake. When a case exercises one source, select it explicitly so `auto` cannot find a contributor's own stores. Model calls happen only in the separate, opt-in prompt evaluation (`node scripts/eval-prompts.mjs` lists its cases without calling a model).

The unit tests also refuse to run when `src/gui/client.generated.ts` is older than its sources; run `npm run build`.

## How the code is organized

| Area | Responsibility |
| --- | --- |
| `src/sources/` | Discover sessions, extract the person's turns, and build the timeline for Claude Code, Codex, Kiro CLI, Kiro Crew, and OpenCode. |
| `src/runners/` | Find each CLI, probe its capabilities, run isolated model calls and handle failures within the approved plan. |
| `src/core/` | Dedupe messages, attach evidence for short replies and outcomes, resolve model plans, and read and write local artifacts. |
| `src/distill/` | Inputs for reflection, prompt templates, response schemas, consent screens, checkpoints, reuse and recovery. The public command is `reflect` and `distill` is its compatibility alias. |
| `src/commands/` and `src/ui/` | Commands, the guided home screen, help, and terminal rendering. |
| `src/gui/` | The local browser view. |

### Add a source

A source implements `SessionSource` in `src/sources/types.ts`: `discover`, `extract`, `timeline`, and optionally `read`, `dispose`, and a session-level `classify`. Register it in `src/sources/registry.ts` and add its name to `SourceName`.

The rule every source keeps: each extracted human message appears as a human timeline event with the identical timestamp and text, in file order. Dedupe and the evidence for short replies depend on that alignment. Drops are observable, with a reason, and corrupt lines are counted, never thrown.

To fix an extraction bug:

1. Reduce the failing record to a minimal synthetic transcript that keeps the data types, ordering, event names, and nesting.
2. Add it under the source's folder in `test/fixtures/`. For a wrapper case, include both a machine wrapper and a human message that starts with a tag such as `<Button>`, and record which one survives.
3. Assert the exported messages in order and the drop reasons.
4. Fix the source or the shared rule (`src/sources/wrappers.ts` for leading machine blocks), and update the rule comment with the shape it now handles.

`npx human-hindsight export --verbose` lists every drop and can print snippets of the input, so share synthetic reproductions only.

### Add a runner

A runner implements `AgentRunner` in `src/runners/types.ts`: `run`, plus `preflight`, `version`, `signInHint`, `listModels`, and `finalize` where the CLI supports them. A CLI that can take only a few calls at once sets `maxConcurrency`; the pool queues the rest and the plan's pace line names the limit. Register it in `src/runners/registry.ts`, and add its local probes (version, help, sign-in, models) to `PROBES` in `src/runners/capabilities.ts`. Give each probe its scope: `local`, `own-service` (a status command that answers offline but contacts the tool's own service when it can, such as Kiro CLI's sign-in status), or `network`. The home screen and `doctor` run `local` and `own-service` probes only.

- `preflight`, probes, and plan screens never make a model call. A probe that contacts the CLI's service is announced on screen before it runs. The readiness check runs after consent, just before the first model call, once for each distinct model of the stages the plan will run, and not at all when everything is reused.
- Start the CLI through the shared spawn helper in `src/runners/shared.ts`. On POSIX every child gets a process group of its own, so Ctrl-C and timeouts end the CLI and anything it started, with SIGKILL when SIGTERM is ignored.
- Model choice comes only from the CLI's own model list. A plan label such as `balanced/bulk` never reaches a CLI.
- Name every CLI that may receive text in the plan. An interactive reflection asks the person to choose one when several are ready. Their choice pins that reflection to the selected CLI. An explicit `--runner` or `--model` also pins the run.
- Failures are classified from the CLI's typed error report first, then stderr. Each text rule cites a captured, sanitized fixture in `test/fixtures/runner-errors/`.
- Use the CLI's isolation controls. When a CLI saves the generated session, clean up only sessions the run can prove it created.
- Prompt templates and response schemas are shared across runners. A behavior change to a template bumps that stage's prompt version.

## Kiro storage formats

Kiro CLI keeps two stores under `~/.kiro/sessions/`, and the reader merges them.

- **Flat store** (`sessions/cli/`): per session, `<uuid>.jsonl` (one `{version, kind, data}` event per line), `<uuid>.json` (metadata including `cwd` and `parent_session_id`), `<uuid>.history` (present only where a person typed), and a `.lock` while active. Only `Prompt` events carry the person's text, in `content[].kind == "text"` blocks. `meta.additionalContext` is always machine text and never read. `Clear` and `Compaction` are context boundaries. Timestamps are unix seconds.
- **Per-session store** (`sessions/<workspace hash>/<session dir>/`): `messages.jsonl` (one `{id, timestamp, payload}` record per line; only `payload.type == "user"` is the person), `session.json` (including `workspacePaths`), plus `snapshots/` and `sub-executions/`, which are never read as sessions. A session present in both stores is read once, from this store.
- **Which sessions count:** there is no per-message human flag, so the decision is per session. A session started by Human Hindsight's own model calls is always excluded. A `.history` file means a person typed there. Otherwise a parent link (flat store only) or an automation first prompt excludes the session, and anything else is kept.
- **Kiro Crew** runs on top of Kiro CLI, so its chats also appear in the per-session store with injected context around the person's words. Those copies are excluded, and the count is reported. The person's side is read from Crew's own store, `~/.kiro/crew/sessions/` and `sessions/archive/`, one JSONL file per chat: `dashboard_chat-*` files are chats a person typed in, and other prefixes (scheduled jobs, setup) are automation. Only `role: "user"` records are the person, and messages typed while a role was working are kept.

The Kiro runner drives `kiro-cli chat --no-interactive` with a no-tools agent written into a private working directory, and the prompt on stdin. Empty output with exit code 0 is treated as a transient failure. After the run it deletes only the sessions saved under its own working directory whose title carries its marker.

## Commits

Use Conventional Commit subjects in plain words: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `style:`, `chore:`, or `ci:`. Keep a commit to one concern. Keep build output, local test homes, and tarballs out of commits.

## Prepare a release

Update `package.json`, `package-lock.json`, and `compat/cc-hindsight/package.json` together. The wrapper pins the main package's exact version. Keep old data homes, environment variable aliases, and markers for generated sessions readable. Note any upgrade or downgrade limit in the version's changelog section, and at release time add its date and comparison link.

```sh
npm run build
node scripts/check-release.mjs vX.Y.Z
npm run stage:release
node scripts/pack-release.mjs
node scripts/smoke-install.mjs
python3 scripts/smoke-flow.py
python3 scripts/smoke-terminal.py
python3 scripts/smoke-menu.py
node scripts/smoke-gui.mjs
```

`pack-release.mjs` checks each tarball itself: the exact file list, executable bins, manifests that agree with the contents, the wrapper's version pin, and that the launcher still parses on old Node. That last check runs the Node binary named by `HUMAN_HINDSIGHT_OLDEST_NODE`, which must be Node 18 or older. Locally the check is skipped with a note when the variable is unset; in CI it is required. `smoke-gui.mjs` needs Chrome.

Build after the final code change and restage after the final commit, so the package's `gitHead` matches the release commit. The workflows define the platform matrix: [CI workflow](.github/workflows/ci.yml). The release workflow runs the whole CI workflow first, and its publish job repeats both test tiers, the packaging checks, and the terminal and browser smokes on the packed tarballs before it publishes the main package, then the wrapper, and builds the GitHub release notes from this version's `CHANGELOG.md` section: [Release workflow](.github/workflows/release.yml). After publishing, run both package names through a fresh `npx`, by exact version and by `latest`.
