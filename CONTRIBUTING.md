# Contributing to human-hindsight

Thanks for helping. This codebase keeps a compact dependency tree, documents
what its extraction keeps and drops, and runs its tests only against synthetic
fixtures.

## Setup

```bash
git clone <repo> && cd human-hindsight
npm install
npm test                 # vitest run
npm run lint             # biome check .
npm run typecheck        # tsc --noEmit
npm run build            # tsdown → dist/
node dist/cli.js --help
```

Development/build tools require Node 22.18+ or Node 24.11+.
The published CLI supports Node 22.13+ on Node 22, or Node 23.4+ on newer releases.
OpenCode history uses Node's built-in SQLite, loaded only when that store is read.
CI runs biome → typecheck → tests → build → a packed-file-list assertion
(`scripts/check-pack.mjs`) on Ubuntu and macOS; all of it must stay green.
Supported platforms are macOS and Linux; Windows code paths exist but are
untested.

## Ground rules

- **Five runtime dependencies** (`citty`, `zod`, `@clack/prompts`, `smol-toml`, `jsonc-parser`): keep the
  tree auditable in one sitting. A new dependency needs to clearly reduce code
  or pay for itself in UX; when in doubt, hand-roll it or leave it out.
- **Tests never read real agent stores or write outside temp dirs.**
  Every test runs against synthetic fixtures under `test/fixtures/`. Because
  `--source` defaults to `auto` (read whichever backend stores exist), a test
  that only sets `--claude-dir` would silently pick up a dev's other stores;
  pin `source: "claude"` or point every other tool directory at a nonexistent
  path in fixture-scoped tests. `test/setup.ts` also isolates default tool paths.
- **No LLM calls outside `distill` / `preferences --consolidate`**, and never
  without the consent gate. Unit tests mock every agent runner's spawn layer;
  no unit test invokes real agent CLIs. The separate OpenCode integration script
  uses a loopback mock provider and temporary stores, with no paid requests.
- **Retention is opt-in.** Default preview, `--yes` alone, and `--dry-run`
  must not write. Apply only after `--apply` plus consent, preserve unrelated
  settings, and back up existing files with owner-only permissions.
- **Keep the GUI small and local.** Use the bundled vanilla assets and Node's
  built-in server. Serve only library data on loopback; don't render prompt
  content as HTML or expose filesystem/mutation endpoints. Check dropdowns in
  a real browser at narrow widths in both themes: one centered 12 × 8 px
  chevron, a 12 px right inset, and 36 px reserved right padding.
- **Preserve rename compatibility.** Keep `CC_HINDSIGHT_HOME`, existing
  `~/.cc-hindsight` libraries, and old `[cc-hindsight distill]` markers readable.
  Historical fixtures deliberately retain the former name.
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, …).

## The extraction fidelity contract

`src/core/extract.ts` implements eleven audited rules (R1–R11, each documented
where it is implemented) deciding what counts as human input in Claude Code
JSONL. Every
rule has a code comment citing the transcript shape it handles and a dedicated
regression fixture. This is the most safety-critical code in the repo: a bug
here silently corrupts everything downstream.

## Adding a fixture for a new transcript shape

Claude Code's JSONL format drifts. If you hit a session that exports wrongly
(human text dropped, machine text admitted), here's the drill:

1. **Find the offending line(s)** in the source file under
   `~/.claude/projects/…/*.jsonl`. Run `human-hindsight export --verbose`; every
   dropped piece is logged with its rule and a snippet.
2. **Synthesize a minimal fixture.** Copy the *shape*, not your data: replace
   every string with something generic ("do the thing", "/tmp/x.ts"). One JSON
   object per line, smallest possible entry count. Drop it in
   `test/fixtures/extract/` with a descriptive name (`r6-new-injection-tag.jsonl`).
3. **Write the failing test** in `test/extract.test.ts` asserting exactly what
   should come out (messages in order, drops recorded).
4. **Fix the rule** in `src/core/extract.ts`, keeping the rule comment accurate.
5. If you can't fix it, file the issue with the fixture attached. A shape
   report with a synthetic fixture is a valuable kind of bug report.

The same pattern applies to discovery (`test/fixtures/claude-home/`), export
dedupe (`test/fixtures/export-home/`), and anaphora
(`test/fixtures/anaphora-home/`). The kiro backend has its own fixture trees:
`test/fixtures/kiro-home/` (discovery + the session-level classify gate) and
`test/fixtures/kiro-extract/` (the K-rules); the drill is identical — copy the
`{version, kind, data}` line shape, not your data.

## Multi-backend architecture (the seam)

human-hindsight reads Claude Code, Codex, Kiro, and OpenCode through one seam:

- **`SessionSource`** (`src/sources/types.ts`) is the source-agnostic currency.
  Each backend's adapter (`src/sources/{claude,codex,kiro,opencode}/`) turns raw lines into the
  same `ExtractResult` + `TimelineEvent[]`; everything downstream (dedupe,
  anaphora, outcome, render, distill) consumes only those and never parses raw
  lines. Adding a backend = one new `sources/<name>/` adapter + a registry entry.
  Database sources implement `read(session)` and `dispose()`, with a stable
  `session.key` distinct from the physical database path. Store-level failures
  use `SourceReadError` so export aborts before replacing any existing artifacts.
- **The SessionSource law:** every message in `extract(lines).messages` MUST
  appear as a `human` `TimelineEvent` from `timeline(lines)` with identical
  `(timestamp, text)`, in file order. The dedupe key and the anaphora↔export
  index alignment both depend on it — a backend satisfies it by producing both
  texts from one shared per-entry function (claude: `humanEntryText`; kiro:
  `promptText`). Each backend has an extract↔timeline agreement test; keep it.
- **`AgentRunner`** (`src/runners/`) is the distill CLI seam. `shared.ts` holds
  the backend-agnostic spawn/error/retry primitives; `claude.ts`, `codex.ts`, `kiro.ts`, and `opencode.ts`
  each add their invocation specifics. The kiro runner layers two retries: a
  transient **empty-stdout backoff** (kiro's "having trouble responding" returns
  exit 0 + empty stdout — retry the *same* input, no corrective note) sits
  *below* the shared **corrective retry** (bad JSON → retry once *with* a
  corrective note). Don't collapse them: burning the corrective retry on a
  transport blip wastes it.

Codex fixtures live in `test/fixtures/codex-home/`. Preserve its
`{timestamp,type,payload}` shape, including paired `response_item`/`event_msg`
messages; a mirror must not become a second human turn. Discovery includes
archived rollouts, deduplicates session IDs, and excludes generated subagents
from export. Runner tests write synthetic final-message files through mocked
spawns, exercising the same cleanup path as real `codex exec` calls.

OpenCode tests synthesize SQLite and legacy JSON stores in temporary directories.
Keep v1/v2 extraction, migration duplicates, WAL reads, failure preservation, and
the extraction/timeline agreement covered. Its runner owns a private config and,
on POSIX, the CLI process group; cleanup requires both the session ID and exact
title/directory ownership. Never delete sessions by title alone.

For real CLI validation with a synthetic provider:

```bash
node scripts/smoke-opencode.mjs /absolute/path/to/opencode
```

CI pins one CLI from each supported family. The smoke verifies JSON output,
zero tool definitions, exclusion of ambient instructions/plugins/MCP, and
session cleanup. Recheck the pinned upstream schema when adding new record types.
The minimum-runtime job builds on Node 24, then uses `scripts/smoke-runtime.mjs`
to exercise installed tarballs on Node 22.13 without development dependencies.

## Prompt changes

The distill prompts live in `src/claude/prompts/`. The author prompt's realism
contract (the t=0 test, the effort budget, never-copy-AI-prose) is pinned by
`test/author.test.ts`. If you change the prompt, update the contract tests
deliberately in the same PR and bump the stage's `*_PROMPT_VERSION` constant so
provenance in `sources.json` stays honest.

## Release checklist (maintainers)

```bash
npm test && npm run lint && npm run typecheck && npm run build
npm pack --dry-run --json > pack.json
node scripts/check-pack.mjs pack.json   # dist/, package.json, npm-shrinkwrap.json, README, LICENSE; nothing else
node scripts/check-release.mjs
npm pack ./compat/cc-hindsight --dry-run --json --ignore-scripts > pack-compat.json
node scripts/check-pack.mjs pack-compat.json --compat
```

For a version bump, update the main package/shrinkwrap and
`compat/cc-hindsight/package.json` together, including the wrapper's exact
`human-hindsight` dependency. The release workflow verifies both identities,
publishes the new package first, then the deprecated wrapper, then creates the
GitHub release. Reruns skip versions already published from the same commit.

Each npm package needs a trusted publisher for
`adityaarunsinghal/human-hindsight`, workflow `release.yml`, with direct
`npm publish` allowed. New package names require a one-time authenticated
bootstrap before their trusted-publisher settings can be configured.

Runtime dependencies are exact-pinned and the transitive tree ships via
`npm-shrinkwrap.json`; after any dependency change, re-run `npm shrinkwrap`
and commit the result. CI actions are SHA-pinned; bump the SHA and the tag
comment together.
