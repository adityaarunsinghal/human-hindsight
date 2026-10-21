# cc-hindsight

> **The prompt you'd write if you knew then what you know now.**

[![npm](https://img.shields.io/npm/v/cc-hindsight?color=cb3837&logo=npm)](https://www.npmjs.com/package/cc-hindsight)
[![CI](https://github.com/adityaarunsinghal/cc-hindsight/actions/workflows/ci.yml/badge.svg)](https://github.com/adityaarunsinghal/cc-hindsight/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/cc-hindsight?logo=node.js&color=339933)](https://nodejs.org)
[![license](https://img.shields.io/github/license/adityaarunsinghal/cc-hindsight?color=blue)](LICENSE)
[![local-first](https://img.shields.io/badge/data-local--only-brightgreen)](#privacy--trust)

<p align="center">
  <img src="https://raw.githubusercontent.com/adityaarunsinghal/cc-hindsight/main/.github/assets/demo.gif" alt="cc-hindsight building a oneshot prompt library from coding-agent session history" width="800">
</p>

```bash
npx cc-hindsight
```

cc-hindsight mines your coding-agent session history (Claude Code, Codex, kiro-cli)
into two things you can use tomorrow morning:

1. **A oneshot prompt library.** For each real task you've done, the realistic
   ideal *first* prompt: everything you knew and wanted at t=0 but didn't say,
   written in your own voice.
2. **A distilled preference set.** The things you keep re-telling your agent
   ("diagnose before acting", "pin the versions", "be terse"), surfaced as a
   paste-ready `CLAUDE.md` or `AGENTS.md` block so every future session starts aligned.

## The t=0 problem

You get better results the more context you front-load into your first prompt,
yet we underspecify at t=0 and spend the session steering: correcting course,
restating preferences, answering questions the agent shouldn't have had to ask.

And the cost repeats every session. Your working preferences are stable facts
about how you like to work, yet you re-derive and re-type them project after
project instead of stating them once, upfront, where every future session reads
them from the first message.

All the evidence of what you *should* have said is already on disk. Claude Code
saves session JSONL under `~/.claude/projects/`; Codex keeps rollouts under
`~/.codex/sessions/` and `~/.codex/archived_sessions/`; kiro-cli keeps its
own store under `~/.kiro/sessions` (both the flat `cli/<uuid>.jsonl` layout and
the newer per-session `<hash>/sess_<uuid>/messages.jsonl` layout). Plenty of
tools read that data for
dashboards and transcripts. **Nobody closes the loop from history back to
better prompting.**

**Before** (what you actually typed at t=0):

> help me script blocking a device on my home router

**After** (what cc-hindsight distilled from how that session actually went):

> I want to automate my home router, starting with blocking a device. Get API
> access working first, and store any credentials securely instead of asking me
> to paste them in the clear. Anything that changes the network should be safe
> by default: show me what it'll do and let me confirm before it runs. Then
> prove it end-to-end on a real device. Research how others have done this
> first, and keep the setup written down so I can reproduce it.

The second prompt was knowable at t=0. You just hadn't written it yet.

## Quickstart

One command builds the whole library and shows it to you when it's done:

```bash
npx cc-hindsight distill    # offers to export first, then digest → cluster →
                            # author (asks before any runner call), then shows
                            # you the finished library
```

Prefer to drive each stage yourself? The pipeline is just three verbs:

```bash
npx cc-hindsight            # 1. scan: inventory your projects (read-only)
npx cc-hindsight export     # 2. export: human-only markdown per session
npx cc-hindsight distill    # 3. distill: digest → cluster → author (asks first)
```

Then browse and curate the results:

```bash
npx cc-hindsight list                # your library (✎ edited / ▲▼ rating badges)
npx cc-hindsight gui                 # browse, search, and copy in your browser
npx cc-hindsight show <slug>         # read a oneshot
npx cc-hindsight copy <slug>         # → clipboard, paste into a fresh session
npx cc-hindsight edit <slug>         # open in $EDITOR; your edits are protected
npx cc-hindsight rate <slug> up      # record a verdict (up|down)
npx cc-hindsight prune               # remove orphaned entries (asks first)
npx cc-hindsight preferences         # → CLAUDE.md block
npx cc-hindsight status              # pipeline funnel + orphan/skip flags
npx cc-hindsight retention           # optional: preview longer local retention
```

Requires Node ≥ 22 on macOS or Linux (Windows is untested and currently
unsupported). `scan` and `export` are fully deterministic: no LLM, no
network. `distill` uses your installed `claude`, `codex`, or `kiro-cli`,
with a consent prompt (or your explicit `--yes`).

### A small local library viewer

```bash
npx cc-hindsight gui                    # start locally and open your browser
npx cc-hindsight gui --no-open          # print the address without opening it
npx cc-hindsight gui --port 3210        # choose a port (default: any available port)
npx cc-hindsight gui --home /path/to/library-home
```

Search prompt titles and text, filter by domain, sort, and copy the prompt
body with one click. The viewer shows your existing library, including local
edits, ratings, and session counts. Use **Refresh** after changing files.
Light and dark appearance follow your system setting, and the layout works
on narrow screens. Press `/` to focus search.

The GUI uses Node's built-in HTTP server and bundled HTML/CSS/JavaScript:
no additional dependencies, frontend framework, database, or external assets.
It listens only on `127.0.0.1`, serves a read-only library API, and stops with
Ctrl+C. The GUI doesn't invoke an agent or modify your library.

### Multiple backends (Claude Code + Codex + kiro-cli)

Every command takes `--source claude|codex|kiro|auto` (default `auto`: read
whichever stores exist). Select the source after the subcommand. Directory
flags work before or after it:

| Source | Directory flag | Environment variable | Default |
|---|---|---|---|
| Claude Code | `--claude-dir` | `CLAUDE_CONFIG_DIR` | `~/.claude` |
| Codex | `--codex-dir` | `CODEX_HOME` | `~/.codex` |
| kiro-cli | `--kiro-dir` | `KIRO_CONFIG_DIR` | `~/.kiro` |

Multiple stores merge into one library; the manifest tags each session's
`origin` and the export summary breaks the count down. Codex discovery includes
active and archived rollouts from the CLI, IDE extension, and app, grouped by
their working directory. Mirrored user/assistant events are paired, injected
context and subagent sessions are excluded, and human decisions and images
survive extraction. The kiro backend
reads both on-disk store layouts (the flat v2 store and the newer v3 per-session
store), preferring the v3 copy when a session was migrated into both.

`distill --runner claude|codex|kiro|auto` chooses which CLI does the distilling,
independently of `--source`. `auto` prefers the CLI matching an explicit source,
then falls back in the order Claude → Codex → Kiro. Models are passed through
with `--model`; without it, the chosen CLI uses its configured default.

```bash
npx cc-hindsight export --source codex
npx cc-hindsight distill --source codex --runner codex
npx cc-hindsight distill --source claude --runner codex
npx cc-hindsight preferences --target codex  # AGENTS.md; alias of --target agents
```

`preferences --target claude|codex|kiro|agents` emits a `CLAUDE.md` block,
an `AGENTS.md` section, or a block for `~/.kiro/steering/`. An explicit Codex
source defaults to `AGENTS.md`. The Codex runner uses `codex exec` with a JSON
schema, a read-only sandbox, and ephemeral sessions; generated distill sessions
do not become new source history. Claude supports current `structured_output`
results as well as legacy `result` objects/strings and verbose event arrays.
It disables session persistence when the installed CLI advertises the flag.

### Optional: keep more local history

```bash
npx cc-hindsight retention                    # read-only preview
npx cc-hindsight retention --apply            # preview, then confirm
npx cc-hindsight retention --apply --yes      # explicit opt-in for scripting
npx cc-hindsight retention --source codex --apply
```

The default reviews existing tool directories. An explicit `--source` can
create that tool's settings file. `--yes` alone never applies changes, and
`--dry-run` always keeps the command read-only.

- **Claude Code:** raises `cleanupPeriodDays` to 365,000 days (about 1,000
  years), preserving an already longer value. Claude requires a positive whole
  number; `0` is invalid. If desktop cleanup is capped, sets
  `desktopSessionCleanupPeriodDays` to `0`, its supported no-age-limit value.
  An absent desktop setting already has no age limit.
- **Codex:** sets `[history] persistence = "save-all"` and removes
  `history.max_bytes`, leaving prompt history uncapped. This controls
  `history.jsonl`; full session rollouts are stored separately. Avoid
  `--ephemeral` for your own sessions you want to retain.
- **kiro-cli:** explains automatic persistence and `/chat save <path>` for
  additional copies. Its public settings reference does not document a
  retention-limit switch, so no configuration key is invented.

Applying creates owner-only backups next to existing configuration files, then
replaces each file atomically. Other settings are preserved; common Codex TOML
layouts retain comments, while unusual layouts may be reformatted after a
preview notice. Malformed configurations are left untouched.

Longer retention keeps prompt contents on disk longer and can use more space.
Restart running tools after applying settings. Project settings, profiles,
managed policy, and startup flags can override user defaults; this command
does not change those controls, remote retention, or telemetry. It cannot
recover already deleted history.

Setting references: [Claude retention](https://code.claude.com/docs/en/settings-reference#cleanupperioddays),
[Codex configuration](https://developers.openai.com/codex/config-reference),
and [Kiro conversation persistence](https://kiro.dev/docs/cli/chat/).

## Privacy & trust

For a tool that reads your entire conversation history, auditability is the
product:

- **Local-only.** Everything is read from your disk and written to your disk
  (`~/.cc-hindsight`). No server, no accounts, no telemetry. The only network
  traffic is through your chosen agent CLI during consented distillation or
  preference consolidation.
- **Four runtime dependencies.** [`citty`](https://github.com/unjs/citty)
  (zero-dependency CLI framework), [`zod`](https://zod.dev) (schema
  validation), and [`@clack/prompts`](https://github.com/bombshell-dev/clack)
  (progress spinners), plus [`smol-toml`](https://github.com/squirrelchat/smol-toml)
  for safely preserving Codex configuration values during optional retention
  edits. All four are
  exact-pinned, and the entire transitive tree ships locked via
  `npm-shrinkwrap.json`. The whole data path is small enough to audit in one
  sitting.
- **Consent-gated LLM use.** `distill` states the exact invocation count and
  waits for `[y/N]` before anything runs on your subscription/credits.
  `--dry-run` shows the full plan for free. If you decline, it exits without
  invoking anything (exit code 2).
- **Plain statement:** exports contain your raw prompts, including anything
  sensitive you ever pasted into a session (keys, internal names, that one
  angry message). They live in your home directory with your permissions, and
  nothing ships them anywhere. A `--redact` option is on the roadmap.

## How it works

```mermaid
flowchart TD
    A["~/.claude/projects/**/*.jsonl"] -->|"scan (read-only)"| B["inventory"]
    X["~/.codex/{sessions,archived_sessions}/**/rollout-*.jsonl"] --> B
    K["~/.kiro/sessions/"] --> B
    A -->|"export (deterministic)"| C["exports/*.md + manifest.json"]
    X --> C
    K --> C
    A -->|"anaphora + outcome evidence"| D["anaphora.json + outcomes.json"]
    X --> D
    K --> D
    C --> E
    D --> E
    subgraph distill ["distill: opt-in, consent-gated, resumable"]
        E["digest: 1 runner call / session"] --> F["cluster: 1 call"]
        F --> G["author: 1 call / task"]
    end
    G --> H["library/&lt;slug&gt;/ oneshot + provenance"]
    H --> I["list / show / copy / status"]
    H --> J["preferences → CLAUDE.md / AGENTS.md / Kiro steering"]
```

The extraction layer is a fidelity contract: eleven audited rules decide what
counts as human input (attachments typed while the agent was busy, recovered
slash commands, `[decision]` lines from option picks, `[image pasted]`
markers), with a regression fixture per rule. Fork/resume duplicates are
deduped globally. Short replies like "yes" and "option 2" get their antecedent
attached so the author stage knows what you approved. Sessions carry an
outcome classification, so a task where nothing ever succeeded gets skipped
instead of becoming a confident prompt that reproduces a failure path.

Authored oneshots pass a **"knowable at t=0" test**: they front-load intent,
constraints, preferences, and quality bars, while leaving out facts you only
discovered mid-session (paths, root causes, error messages). And they respect
an **effort budget**, staying around the length a motivated human would
actually type rather than ballooning into a 700-word spec.

Every distill stage checkpoints to disk after each unit of work: Ctrl-C loses
nothing, re-running resumes, `--fresh` resets deliberately, and `status` flags
library entries orphaned by re-clustering.

## How it compares

| Tool | Reads `~/.claude` | Output | Direction |
|---|---|---|---|
| ccusage | ✓ | usage/cost tables | backward (metrics) |
| sniffly | ✓ | analytics dashboard | backward (behavior) |
| claude-code-transcripts | ✓ | shareable HTML transcripts | backward (record) |
| cctrace / exporters | ✓ | markdown/XML exports | backward (archive) |
| **cc-hindsight** | ✓ | **oneshot prompt library + CLAUDE.md preferences** | **forward (better next session)** |

Closest kin is Simon Willison's `claude-code-transcripts`: same local-first
values, same belief that transcripts are undervalued artifacts. The difference
is the direction of gaze: it renders your sessions (backward, for others);
cc-hindsight distills them (forward, for you).

## FAQ

**Does my data leave my machine?**
The deterministic commands (`scan`, `export`, and `retention`) never touch the
network. `distill` and `preferences --consolidate` send content through your
chosen local agent CLI to its configured provider, using its authentication.

**What does distill cost?**
Whatever your chosen agent CLI costs you: it runs on your existing subscription or
API credits. The consent prompt states the exact invocation count up front
(one call per session digested, one to cluster, one per task authored), and
`--dry-run` prints the same plan without running anything. Checkpoints mean an
interrupted run isn't wasted money. Sessions too large for the input budget
(default 400k chars, `--input-budget`) are **refused before anything is
spent**. Re-run with `--truncate=extreme` to cut them (recorded in
provenance) or narrow the scope. Digest and author calls run 3 at a time by
default (`--concurrency`; `1` = sequential).

**Subscription or API?**
cc-hindsight shells out to `claude -p`, `codex exec`, or `kiro-cli chat`;
however your chosen CLI is authenticated is how calls are billed. `--model`
passes through without pinning a model version.

**Why is a session missing from my exports?**
Sessions with zero human messages are skipped naturally, `--min-messages`
filters thin ones, and fork/resume copies are deduped into their original
session. Note that dedupe is global across all projects: with `--project`, a
message duplicated by fork/resume is attributed to its earliest session even
when that session is outside the filter. Run `export --verbose` to see every
dropped piece with a reason. If genuine human input was dropped, that's a
bug: file an extraction-fidelity report.

**Can I regenerate everything from scratch?**
`cc-hindsight distill --fresh` clears the checkpoints (after confirming) and
re-runs. Old library entries from previous generations are flagged as orphans
in `status`.

## Roadmap

- Claude Code **plugin packaging** for existing marketplaces (for
  distribution, without standing up a separate marketplace)
- An in-session **skill variant** ("distill this session as we go")
- **Agent SDK** orchestration exploration
- **parentUuid-aware anaphora** (branch-correct antecedents on forked
  conversations)
- **`--redact` patterns** for exports
- An opt-in **community oneshot showcase**

## Development

```bash
npm install
npm test            # vitest: fixtures only, never reads your agent stores
npm run lint        # biome
npm run typecheck   # tsc --noEmit
npm run build       # tsdown → dist/
```

See [CONTRIBUTING.md](CONTRIBUTING.md), especially the guide to adding a
fixture when you hit an unhandled transcript shape.

## License

[MIT](LICENSE)

## Author

Built by [Aditya Singhal](https://adityasinghal.com). If cc-hindsight surfaces
a pattern you didn't know you had, [I'd love to hear about
it](https://github.com/adityaarunsinghal/cc-hindsight/issues).
