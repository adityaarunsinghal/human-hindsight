# Changelog

All notable changes to Human Hindsight (formerly cc-hindsight) are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.1] - 2026-11-24

- Interactive reflections print a private localhost link as soon as the prompts are saved. Open it to read your prompts while each finished batch adds its guidance and sources to **Preferences**. The link stays available for 30 minutes after the command exits. Use `npx human-hindsight gui` to reopen your library later.
- Preference summaries now group up to 100 observations per model call, within the input budget. The plan explains that this step uses preferences across your saved library. The terminal shows both observations and batches, and resuming a 2.1.0 run reuses matching completed batches.
- The runner and **Balanced / Best** choices have rounded, keyboard-selectable pills. Each stage’s result has a blank line separating it from the progress display.

## [2.1.0] - 2026-11-24

**Understand how you work. Codify your taste.**

- Start with `npx human-hindsight` and choose **Reflect on my history**. If several coding CLIs are ready, choose which one will run the reflection. Review the models, expected calls and text the tool will send to its usual provider. Press `s` to approve.
- As each session read finishes, the terminal shows the project, what you were trying to do, how it ended and an inferred preference when available. The run continues automatically, summarizing your preferences and writing prompts you can reuse.
- **Open my reflections** takes you to the Preferences overview in your local browser. Read the observation, where it applies and the passages behind it, then copy the guidance into your next session. Prompts and Subagents keep their own tabs. To generate specialist instructions, run `npx human-hindsight suggest-subagents` and approve its plan.

### Upgrading

- Use `npx human-hindsight reflect` for reflection. `distill` is an alias, including for scripts that set flags or retry a failed stage. The `preferences` and `suggest-subagents` commands keep their names.
- Existing libraries open in place, including `~/.cc-hindsight`. Hand-edited prompts, ratings and preference reviews carry forward. The version-matched `cc-hindsight` package still forwards the legacy command.
- `npx human-hindsight export` still writes your messages as local Markdown. You can export or browse a saved library without signing in to a coding CLI.

## [2.0.0] - 2026-11-24

### First run

- Running `human-hindsight` with no arguments opens a guided start. A card
  lists the coding tools found, with the history on disk, whether each command
  is installed, and a sign-in hint. It appears at once, says what is still
  being checked, and fills in as each check finishes without changing height;
  a version still being checked shows as the command name with an ellipsis. A
  privacy note follows, then a menu that follows your library's state: build
  the library, export only, show every project, or check your setup. The bare
  command also accepts `--dry-run`, `--yes`, `--no-follow-up`, and `--plain`.
- New `doctor` command: the data home, Node version, and for each tool its
  history, command, and sign-in status, with one exact fix per problem. It
  covers history from a desktop app or editor extension with no command
  installed, a command that looks signed out, and Claude Code set up with a
  cloud provider.
- With more than 25 eligible sessions, `distill` first offers your 25 most
  recent sessions or everything. `--recent N` chooses up front. Work from a
  shorter first run is reused when you do the rest.
- With input or output redirected, the bare command prints the setup summary
  and the next command instead of a menu.

### Quality and automatic fallback

- `--quality balanced|best` picks one model plan for any CLI, and
  `HUMAN_HINDSIGHT_QUALITY` sets the default. Balanced reads sessions with a
  Sonnet or Terra model and groups and writes with an Opus or Sol model. Best
  reads with Opus or Sol and groups and writes with Fable or Astra.
- Models come from each CLI's own model list: the newest version of each
  family, from the same vendor and prefix as the CLI's default model. Claude
  Code receives family names such as `sonnet`, which the CLI and its provider
  resolve; `--model` or Claude Code's own setting chooses an exact model.
- The plan screen and its Start question show the models of each plan,
  the CLI that runs, and the other CLIs that are ready if it stops working.
  Its Sending row says that the calls use your tokens with your provider.
- The readiness check runs just before the first model call. It sends one tiny
  request for each model the approved plan will call, the plan says how many,
  and it names the models that answered: "Claude Code is ready: sonnet reads
  sessions, opus groups and writes." When everything is reused, no call is made
  at all.
- A model the provider refuses steps down in one line ("Claude Code cannot use
  opus here (your provider refused it). Using sonnet for grouping and
  writing."). A CLI that is signed out, missing, out of quota, or failing
  repeatedly hands the remaining work to a ready CLI, also in one line. The run
  summary repeats every step-down and switch.
- `--runner`, or an explicit `--model`, `--cluster-model`, or `--author-model`,
  keeps the whole run on one CLI, and the plan says so. A plan name such as
  `balanced/bulk` is rejected as a `--model` value.
- Parallel stages run up to 10 calls at a time by default, and a CLI can take
  fewer: OpenCode takes 2, and the plan's pace line says so. Grouping runs one
  call at a time.

### Prompt library

- How a session ended is judged more fully. A closing report of finished work
  that you did not dispute counts as completed; open items, a pause, or a
  correction left unanswered count as partial; giving up, or an ending that
  says the work could not be done, counts as abandoned. Unclear is kept for
  sessions with no ending to judge, so fewer sessions are left unjudged.
- A group whose outcome could not be judged now gets a prompt, marked "outcome
  not verified" in the prompt file's header, in `list`, `show`, and `status`,
  and in the browser view. A group whose every session was abandoned still
  gets no prompt, and its preferences are kept. The run's closing summary says
  how many of each.
- The "Library:" sentence counts each prompt once: written, already up to
  date, kept because you edited it, or skipped. The detail for each group
  shows only under `--verbose`.
- `distill --force` replaces a prompt you edited by hand even when nothing else
  changed, from the saved result and with no model call.

### Sources

- Kiro Crew is a new source (`--source kirocrew`, `--kirocrew-dir`). It reads
  Crew's own chats and archives, including messages typed while a role was
  working, and skips scheduled jobs and setup runs. The copies of Crew runs in
  the Kiro CLI store are excluded so injected context stays out of your
  history, and `export` and `status` report how many.
- These are no longer kept as text you typed: tool output that happens to
  contain the wording of a rejected tool call, wrapper blocks a coding tool adds
  around a message, the instructions Kiro CLI wraps around a message typed
  while it works (the message itself is kept), editor context sent with a
  Codex request, and image markers that carry a file path.
- Text you typed that contains or starts with a tag, such as `<Button> is not
  rendering`, is kept.
- A shell command typed with `!` is kept as `[command] !...`, in Claude Code
  and in Codex, where its exit code and output are dropped.
- The instructions block Codex adds at the start of a message is removed,
  whether or not its heading names a folder.
- Replies without a timestamp are no longer merged with each other.
- A session that cannot be read keeps its earlier export instead of
  disappearing from it.
- Project and export file names stay the same across re-exports, after a
  filtered export (`--project` or `--source`) followed by a full one, and when
  a tool moves its sessions to a new store layout. A project folder that comes
  back never takes a name another folder now holds.
- `export` closes with what was exported ("Exported N sessions with M of your
  messages."), a count per tool, and one line saying what was left out and
  why.

### Working preferences and suggested subagents

- Every `distill` run ends by summarizing your working preferences, 20 at a
  time, into working agreements with their scope, exceptions, and quotations,
  saved in `library/preferences.generalized.json`. A partly summarized set is
  saved and shown, and the next run finishes it. `--no-generalize` skips this
  step, and a failure here never fails the prompt library.
- `status` and `preferences` give the same counts of preferences observed,
  waiting for review, and accepted. `preferences` writes the block to standard
  output and its notes to standard error, so `preferences > file.md` saves only
  the block. `preferences --target kirocrew` writes a Kiro steering block that
  Kiro Crew also reads.
- New `suggest-subagents` command: proposes specialist roles from your accepted
  preferences, or from every preference you have not dismissed when none are
  accepted, and writes instructions for each role. It uses the same plan
  screen and Start question as `distill`, ends with its own menu to open or export
  the roles, and never opens the browser by itself. `--export DIR --target
  claude|codex|kiro|kirocrew|knowledge|all` writes the saved roles as files
  with no model call, and `--pin-model` sets a model in the role files that
  support one. `--include-unreviewed`, `--window-size`, `--fresh-generalize`,
  and `--author-only` control the inputs and resuming.

### Browser view

- Prompts, Preferences, and Subagents each open on an overview that suggests up
  to three items to open first, with the reason each was picked.
  `gui --tab prompts|preferences|subagents` picks the starting tab.
- Preferences shows general working agreements first, grouped by the kind of
  work where each was seen, then project-specific agreements under their
  project, with one-time notes folded away. One button copies the general
  agreements as Markdown.
- Prompts left behind by a regrouping are listed apart from current ones and
  never suggested first. A prompt whose outcome was not verified is labeled,
  and is never suggested first while a verified one is available.
- Every data route requires the session key in a request header, the expected
  `Host`, and a same-origin request. The page keeps the key for its own tab, so
  a reload keeps working. The browser is opened through a private, owner-only
  file, so the key never appears on a command line.
- Over SSH, `gui` uses port 4317 and prints the port-forward command and the
  address to open on your laptop.

### Terminal

- Menus take arrow keys and Enter, or a number; the Start question is the
  exception (see Safety and privacy). `--plain` or
  `HUMAN_HINDSIGHT_PLAIN=1` gives numbered prompts and static progress lines,
  which is also what you get without a terminal.
- Progress lines show items done, failures, elapsed time, and an estimate from
  the observed pace. Each stage ends with one summary line. Without a drawing
  terminal, progress prints at most one line a second. `--verbose` on
  `distill` and `suggest-subagents` shows detail per session or role, and
  `status --verbose` shows internal bookkeeping.
- Ctrl-C during a run stops the calls in flight and ends their processes,
  says what was saved, and prints the command that continues on its own line.
  An answer that arrives afterwards is discarded, and nothing is printed,
  written, or copied after the interrupt line.
- Questions never take keys typed before they appear. The question shows
  "Ignored keys typed ahead. Choose when you are ready." and waits.
- `status` and the end of `distill` tell the same story about your
  preferences, with the review command on its own line.
- A command printed for you to run next keeps the choices of the run (quality,
  CLI, models, source, project), names a folder only when it is not the one
  you use by default, and never carries `--yes`.
- Exit codes are the same for every command: 0 done, 1 failed, 2 declined, 130
  interrupted.
- `list` keeps prompt names whole at any width, and marks prompts you edited or
  rated and those whose outcome was not verified.
- Terminals whose locale is not UTF-8 get ASCII symbols. Over SSH, `copy` asks
  your own terminal to set the clipboard and always prints the text too.

### Help

- `human-hindsight --help` is one short screen: where to start, the everyday
  commands, and where to go next. `help <command>` and `<command> --help` lead
  with examples, then common options. `help --all` lists every command and
  option.
- An unknown command or option is an error with the closest match as a
  suggestion, and nothing runs.
- A switch takes no value other than `=true` or `=false`, and a word no
  command takes is an error, so `--yes no` never runs as yes. A wrong value
  for `--source`, `--runner`, or `--quality`, or for their environment
  variables, is one plain line listing the accepted values. A wrong number is
  one line naming the option and the value given, never a silent default. An
  empty folder option is refused, and an empty folder variable counts as
  unset, so the data home is never the current folder by accident. A leading
  `--` is an error.
- A damaged `exports/manifest.json` is one line that names the file and says
  to run `export` again.
- An unexpected failure prints one line and how to see the details
  (`HUMAN_HINDSIGHT_DEBUG=1`).

### Safety and privacy

- Before a plan is approved, Human Hindsight sends nothing and opens no
  network connection of its own. The home screen and `doctor` only run each
  coding tool's own version and sign-in status commands. When building a plan
  asks a CLI for its models from its service, the screen says so first.
- Commands that change the library (`distill`, `export`, `prune`, `rate`,
  `edit`, `preferences --consolidate`, `suggest-subagents`, strict retry, and
  a review in the browser) take turns. While one runs, another stops without
  changing anything, names the command that holds the library, and says what
  to remove if nothing is running. A run stopped with Ctrl-C keeps the lock
  until it has finished writing. A lock whose process is gone is taken back at
  once, and one left under another machine name after a short wait.
- The question that starts model calls takes one deliberate key: `s`. Enter,
  a number, `y`, pasted text, a key held down or repeated from an earlier
  menu, and keys typed before the question appeared never start a run; the
  question answers "Press s to start, or q to leave." `1` and `2` only choose
  between Balanced and Best. In plain mode the same letters are typed and
  entered. `--yes` is unchanged.
- Declining a plan, and `--dry-run`, change nothing in the data home.
- On an unsupported Node, both `human-hindsight` and `cc-hindsight` stop before
  loading anything: "needs Node.js 22.13 or newer in the 22 line, or 23.4 or
  newer". They suggest a one-off command for each Node version manager found,
  then `npx` with Node 24. Pre-release Node builds are accepted.

### Upgrading from 1.x

- Your data home keeps working, including a `~/.cc-hindsight` folder. Results
  now record the model plan that produced them, so the first 2.0 `distill`
  regenerates earlier results once. The plan says how many. Hand-edited
  prompts, ratings, and preference reviews are kept.
- When the new grouping leaves out an earlier prompt, the run keeps it, says
  how many, and prints the `prune` command that removes them.
- A prompt you edited by hand is kept, including one edited while it was being
  written; `distill --force` replaces it.
- Groups that 1.x skipped because no session showed a result now get a prompt
  marked "outcome not verified".
- The 2.0 operation records carry new fields that 1.x cannot read. Keep a copy
  of your data home if you may go back to 1.x.
- OpenCode decision lines now quote the question, like the other sources, so
  re-exported OpenCode Markdown can differ.
- At every prompt an empty line takes the default and end of input declines,
  except the Start question, which only `s` answers. `--yes` never reads
  input. Unknown options, stray words, and wrong numbers are now errors.
- For contributors: `npm test` runs the unit tier only, `npm run test:smoke`
  runs tests that start a process, drive a terminal, or pack a tarball, and
  `npm run test:budget` checks the unit tier against its time budget. The
  release workflow runs the full checks before publishing.

## [1.8.5] - 2026-11-13

### Fixed

- Regrouping no longer crashes with a `data` argument error when an old task
  disappears or is renamed. Existing prompt files and edits are preserved;
  obsolete author operations are excluded from later retries.
- Resuming a saved grouping finishes interrupted operation bookkeeping without
  repeating successful model calls. Retry previews now explain when a saved
  task definition has changed.
- Clustering windows account for the complete prompt size, including changing
  count headers, so planned windows stay within the input budget.

### Added

- `distill --cluster-model=<model>` selects a model for clustering and merging
  independently of the digest and author model. It defaults to `--model`, can
  also be set with `HUMAN_HINDSIGHT_CLUSTER_MODEL`, and supports explicit
  cluster-only overrides during strict retries.
- `distill --cluster-batch-size=<n>` limits the number of digests per clustering
  call even when the full corpus fits the character budget. Window results are
  checkpointed and merged across batches. Omitting the flag keeps the existing
  grouping behavior.
- Consent previews show the selected stage models and estimated clustering
  window and merge calls. Suggested strict-retry commands retain relevant
  explicit model settings.
- Installed-command checks cover batching, separate stage models, regrouping,
  and cluster retries through both package names.

## [1.8.4] - 2026-11-11

### Added

- Strict `distill --retry-failed` recovery with
  `--retry-stage=all|digest|cluster|author`. Preview recorded failures,
  interruptions, resolved blockers, and local result repairs before consent.
  Successful operations and never-attempted work remain excluded.
- `distill --recover-tasks=slug-a,slug-b` for explicit author-only recovery of
  saved tasks from older runs without recorded failure history. Existing
  successful and manually edited prompts remain protected.
- Durable operation records, saved validated responses, and individual
  clustering checkpoints. Saved responses can be recovered without another
  model call; recovered clustering results await a normal run for adoption.

### Changed

- The shared model-call timeout is now 900 seconds. Clustering and preference
  consolidation retain their five-second-per-item scaling; explicit timeouts
  remain exact. The default input budget remains 400,000 characters.
- Retry previews and status distinguish recorded failures, interruptions,
  blockers, queued work, local repairs, and clustering results awaiting adoption.
  Strict recovery preserves the saved grouping and does not start downstream
  stages or automatically export more history.

## [1.8.3] - 2026-11-04

### Changed

- One expandable domain tree replaces cascading subdomain menus. Prompt details
  show shared ancestry once, with the full grouped hierarchy available on demand.
- Denser library rows emphasize titles and one short metadata line. Secondary
  prompt details and source evidence are collapsed by default.
- Compact icon controls replace wordy copy, preview, and preference-review
  buttons, with accessible labels and hover descriptions. Removed the redundant
  Local and Refresh controls; use the browser's reload after changing files.
- Tips fit in the header and flip between cards. Commands and explanations open
  on demand; rotation pauses during interaction and respects reduced motion.

### Fixed

- Preference domains come from their supporting evidence instead of every
  session in a linked prompt. Case variants share one hierarchy branch.
- The skip summary says no completed/partial outcomes, and clarifies that
  `unclear` means unverified rather than failed. Supported preferences remain
  available even when prompt authoring skips a task.

## [1.8.2] - 2026-11-03

### Fixed

- Short replies to proposed plans preserve rejection, conditional acceptance,
  and uncertainty instead of being described automatically as approval.
- Digest, grouping, and author checkpoints now fingerprint source content,
  outcome/context evidence, prompt/schema versions, runner/model selection, and
  grouping mode. Changed inputs refresh affected stages; missing prompt files
  are repaired. Manual edits, ratings, and annotations remain protected.
- Failed refreshes invalidate old preference evidence rather than allowing it
  to reappear through an older library entry.
- Consolidation requires complete, unique source-ID coverage. Empty output,
  unknown or omitted sources, incompatible scopes, explicit polarity conflicts,
  and dropped conditions are rejected with a bounded correction attempt.
  Invalid results preserve the last saved consolidation.
- `distill --yes` no longer adds optional consolidation or clipboard work.
  Consent planning counts digest reuse only when full lineage matches.

### Added

- Preference candidates are extracted during digesting, including failed,
  unfinished, and ungrouped sessions. Candidates carry global/project/task
  scope, explicit/inferred basis, and source-validated human quotations.
- Browser review with Accept, Edit wording or scope, Dismiss, and Review again.
  Accepted instructions can be copied globally or for a selected project.
  Reviews persist locally and changed evidence requires review again.
- `preferences` now exports accepted global rules by default. `--project`
  includes an exact project's accepted rules; `--include-unreviewed` explicitly
  requests draft observations. Legacy libraries remain readable as candidates.
- Version-2 consolidation artifacts retain per-rule source mappings and
  evidence. Older saved results remain readable and are marked for review.
- Claude preflight requires safe-mode isolation controls. Calls use private
  directories, an explicit system instruction, enforced tool/MCP denial,
  disabled hooks and skills, and no session persistence. Unsupported CLIs fail
  before a model call; organization-managed policy remains authoritative.
- Eleven synthetic behavioral evaluation cases with positive examples and
  deliberate regressions, an opt-in live evaluator, and offline scoring.

### Changed

- Digest, grouping, and author prompts are version 6. Historical content is
  explicitly treated as data. Authoring no longer assumes success, invents
  global preferences from one-time decisions, or pads simple tasks to a fixed
  word target.
- The GUI adds one narrow preference-review write endpoint protected by
  origin, session token, candidate identity/revision, and request size checks.
  It cannot execute agents or write arbitrary files.

## [1.8.1] - 2026-11-03

### Added

- A Preferences tab with Markdown preview/source, individual and combined
  copying, frequency sorting, searchable evidence, and links in both directions
  between preferences and their source prompts. Browser bookmarks and history
  work across both tabs.
- Hierarchical domain filters, from broad categories down to five levels.
  Existing flat domains are grouped locally without rewriting the library or
  invoking a model; new digests produce hierarchical paths.
- A rotating, pausable, hideable tips bar with copyable
  `npx human-hindsight@latest` commands. Its first tip explains local processing
  and links to the public source repository.
- Saved preference consolidation at `library/preferences.consolidated.json`,
  including the copyable Markdown and input metadata. The GUI can browse the
  last successful result and flags changed inputs; failed or declined model
  calls preserve earlier results.
- Immediate colorful progress feedback for terminal scans, exports, and model
  work, with elapsed time and export stages. Export and distill introduce the
  open-source/local-processing reminder and explain the chosen harness/provider
  boundary. Pipes remain free of animation.

### Changed

- Both the browser code and the self-contained CLI are now minified. The
  published application continues to have no npm dependencies or install
  scripts; tests, source, caches, and build tools remain outside the package.
  Removed the unused terminal UI dependency and its transitive packages.
- Expanded synthetic API, browser, terminal, domain, persistence, and packaging
  checks, including narrow light/dark dropdowns at every hierarchy level.

## [1.8.0] - 2026-10-22

### Fixed

- Removed the development shrinkwrap from published packages. The CLI now
  bundles its JavaScript dependencies and ships without npm dependencies or
  install scripts, preventing `npx gui` from downloading build tools and
  foreign-platform binaries. Development uses a repository-only package lock.
- Release checks now inspect actual tarball manifests and exercise
  registry-style `npx` installation with a fresh cache: one package for the
  app, two for the deprecated compatibility command.

### Added

- Safe Markdown preview for headings, lists, tables, code, quotes, tasks,
  and links, with a source view and exact Markdown copying in either mode.
  HTML remains inert and remote images do not load automatically.
- A minimal black-and-white GUI with system monospace typography, responsive
  layouts, and matching light/dark surfaces.
- Interactive command handoffs: scan offers export, export offers distill,
  and distillation offers the GUI. Library and status commands also offer
  their next useful action. Source, directory, project, runner, and model
  selections are retained. Offers default to No, honor `--no-follow-up`,
  and never bypass model-call consent or run automatically in scripts.

## [1.7.0] - 2026-10-22

### Added

- OpenCode as a history source and distillation engine, covering current 1.19
  and 2.1 release families. Includes SQLite and legacy JSON stores, archived
  sessions, question answers, attachment markers, compaction boundaries,
  execution status, and migration-copy deduplication.
- `--source opencode`, `--runner opencode`, `--opencode-dir`,
  `--opencode-db`, and `preferences --target opencode` for `AGENTS.md`.
  OpenCode prompts use the existing lightweight library GUI.
- A private OpenCode runner configuration with tools denied, provider/model
  settings read from JSONC, JSON answer validation, and one corrective retry.
  OpenCode 2 uses an owned private server. Generated sessions are excluded
  from exports and removed only after verifying ID/title/directory ownership.
- Advisory OpenCode retention guidance that distinguishes stored conversations
  from temporary tool-output cleanup without changing compaction settings.
- Synthetic SQLite fixtures and real CLI integration tests against a local
  mock provider, including tool isolation and generated-session cleanup.

### Changed

- Minimum Node version is now 22.13 on Node 22, or 23.4 on newer releases,
  for built-in SQLite without a database dependency.
- Added exact-pinned `jsonc-parser` for safe OpenCode configuration reading.
  Runtime dependencies remain small; no GUI dependency was added.
- Store-owned session loading supports multiple sessions per database.
  An unreadable, busy, unsupported, or incompletely migrated OpenCode database
  aborts export before rewriting its manifest or pruning earlier exports.
- Prompt versions now record OpenCode source legends and execution-status
  evidence. Existing libraries and resumable checkpoints remain usable.

## [1.6.0] - 2026-10-21

### Changed

- Renamed the npm package, primary CLI, GitHub repository, documentation, and
  GUI to **Human Hindsight** (`human-hindsight`).
- Added a deprecated `cc-hindsight` compatibility package that forwards
  arguments, stdin, output, exit codes, and signals to the matching new release.
- Fresh installations use `~/.human-hindsight`; existing `~/.cc-hindsight`
  libraries remain discoverable without moving or rewriting data.
  `HUMAN_HINDSIGHT_HOME` takes precedence over the retained `CC_HINDSIGHT_HOME`
  alias, and `--home` takes precedence over both.
- Preserved recognition of old distillation markers so historical generated
  Kiro sessions remain excluded from human exports.
- CI now validates and publishes both packages, with the main package first
  and the GitHub release after both publications succeed. A resumed workflow
  can finish a partial release without republishing a version.

## [1.5.0] - 2026-10-21

### Added

- Lightweight `cc-hindsight gui`: a local browser for searching, filtering,
  viewing, and copying prompt libraries. Uses Node HTTP and bundled vanilla
  HTML/CSS/JavaScript, with no new GUI dependencies; supports light/dark
  appearance, narrow screens, custom ports, and `--no-open`.
- Codex history source and distillation runner: `--source codex`, `--runner
  codex`, `--codex-dir` / `CODEX_HOME`, active and archived rollouts, stable
  session IDs, mirrored-message deduplication, context filtering, and
  `AGENTS.md` preferences. Codex runs use structured output, private scratch
  directories, a read-only sandbox, and ephemeral sessions.
- Optional `retention` command: preview long local history retention for
  Claude Code and Codex, then opt in with `--apply`. Existing settings receive
  private backups; unrelated values and existing longer retention are
  preserved. Kiro users receive documented persistence/save guidance.
- Exact-pinned `smol-toml` for safe Codex configuration parsing and edits.
- GitHub Releases are now created by the release workflow after npm publishing,
  using the version's changelog as release notes.

### Fixed

- Current Claude `structured_output` envelopes, error arrays, and nonzero
  process exits are handled alongside older result envelopes. Generated
  distillation sessions are not persisted when the CLI supports that flag.
- Current Claude question answers stored separately from the questions are
  recovered, and compaction boundaries reset antecedent context.

## [1.4.0] - 2026-08-29

### Added

- **Kiro v3 (per-session "Sol" store) support.** The kiro backend read only the
  flat v2 store (`sessions/cli/<uuid>.jsonl`, one `{version, kind, data}` object
  per line). The current kiro-cli writes a v3 store the backend never saw:
  `sessions/<workspaceHash>/<sessionDir>/messages.jsonl`, one
  `{id, timestamp, payload}` object per line, with a sibling `session.json`, a
  `snapshots/` tree, and subagent transcripts under `sub-executions/`. Every v3
  session was invisible to scan/status/export/distill. The backend now discovers
  both stores and, per session, sniffs the line format and dispatches: a v3
  `user` entry is the human turn (verbatim `content`, in-band ISO timestamp), an
  `assistant` `Say` entry is the antecedent, and everything else is machine.
  Human-vs-automation classification mirrors the v2 precedence (distill
  self-recognition, `.history` present, automation-marker first prompt, recall
  default), with `parentSessionId` treated as a human fork rather than an
  exclusion since v3 subagents live under `sub-executions/` and are never
  enumerated. A session that exists in both stores (its v3 dir is `cli_<uuid>`)
  is deduped to the v3 copy, and `countOrphanHistories` no longer mis-flags a v3
  session's `.history` as an orphan. A machine on the newer kiro-cli that has
  only the v3 store is detected by `--source auto`.

## [1.3.1] - 2026-08-11

### Fixed

- **`--home`, `--claude-dir` and `--kiro-dir` were ignored before the
  subcommand.** `--help` presents them as root options, but citty hands a
  subcommand only its own parsed args, so `cc-hindsight --home /tmp/scratch
  export` parsed `--home`, discarded it, and used the DEFAULT store. The failure
  was silent and it targeted exactly the flags that decide where data is read
  and written: in practice an `export` aimed at a scratch directory ran against
  the live store and pruned its stale exports. The root command now publishes
  those three flags into the environment before dispatching, riding the
  precedence `resolvePaths` already implements (flag > env > default), so a
  root-level flag beats the default while a subcommand-level flag still beats
  the root one, and a variable you set yourself is never overwritten.
  `--source` has no environment variable and cannot ride the same path, so its
  help text now says to pass it after the subcommand instead of implying a
  placement that is ignored.

## [1.3.0] - 2026-08-11

### Added

- **Windowed clustering for corpora that exceed the input budget.** The
  cluster stage previously sent one prompt over ALL digests and merely warned
  when that prompt exceeded `--input-budget`. Now it splits the corpus into
  deterministic windows whose prompts each fit the budget, clusters every
  window independently (same validation and corrective retry per window), and
  unifies cross-window duplicate tasks with one best-effort merge call over
  the task identities. A failed or partially invalid merge response degrades
  to the still-valid unmerged union with a note, never a lost run. Nothing
  changes for corpora that fit: a single call as before.

### Fixed

- **A windowed clustering merge could write an unusable task slug.** Every other
  cluster response passes `validateCluster` before anything is saved, but the
  merge call runs after per-window validation and its schema types the
  replacement slug as a plain string, so a response of `"Payments Work"` (or
  `"../../escaped"`) was applied verbatim. A task slug is also a path component
  (`library/<slug>/…`), so that reached the filesystem. Malformed replacement
  slugs are now skipped with a note, keeping the still-valid unmerged union.
  Relatedly, de-duplicating a colliding slug appended a sixth word to an
  already-5-word slug, which `validateCluster` rejects; the suffix now replaces
  the final word instead, so both the merge and cross-window collision paths
  stay within the 2-5 word rule. Only reachable on the windowed path.
- **A finished run could still refuse to exit.** Settling a spawn on child
  `exit` (v1.2.0) fixed the await-side hang, but the settled child's stdio
  streams were never destroyed. Whenever a grandchild inherited the pipes or
  the child was killed mid-write (a timed-out call), those streams stayed
  ref'd and held the event loop open after all work was done. Observed live:
  a finished `distill` lingered 20+ minutes holding exactly two orphaned
  child-stdio sockets; destroying them via an attached inspector made it exit
  immediately. The runner spawn now destroys the child's stdio on every settle
  path, and the clipboard spawn unrefs its child and stdin so a hanging
  clipboard tool can never hold the process either.
- **Preferences consolidation timed out on large stores.** Same defect family
  as the clustering timeout below: consolidation is a single call over EVERY
  aggregated preference but inherited the flat 5-minute default, and died at
  exactly 300000ms twice on a real 80+ preference store (which is also what
  triggered the lingering-exit hang above). The default now scales with the
  preference count (5 min base + 5s each); `preferences` gained a `--timeout`
  flag, and `distill --timeout` reaches the end-of-run cascade's call too.
- **Clustering timed out on large stores.** The cluster stage is a single call
  over ALL digests, but it inherited the flat 5-minute per-call default sized
  for one-session digest calls; at 84 digests the call reliably exceeded it and
  the run stopped at `✗ claude invocation timed out after 300000ms`. The
  cluster call's default timeout now scales with input size
  (5 min base + 5s per digest; 12 min at 84). An explicit `--timeout` still
  passes through unscaled, on the corrective retry too.

## [1.2.0] - 2026-08-02

### Fixed

- **A finished `distill` run could hang forever instead of exiting.** The spawn
  helper resolved on the child's `close` event, which fires when the stdio pipes
  close rather than when the child exits. A CLI that execs a wrapper or starts
  background helpers (one observed wrapper launches MCP servers) can exit while a
  grandchild still holds the inherited stdout, so the runner waited on that
  grandchild and the per-call timeout was powerless: its SIGTERM went to a process
  that had already gone. Observed on a real 87-session run, which sat idle for
  10+ minutes after its final output with all work already saved. Spawning now
  settles on whichever of `exit` or `close` arrives first, with a macrotask for
  buffered output to flush (verified lossless to 4MB).
- **The clipboard offer had no timeout.** `xclip` with no usable X display holds
  the selection indefinitely rather than failing, and the copy offer is the last
  thing a run does, so a finished run looked hung. Copying is now bounded
  (5s, `CLIPBOARD_TIMEOUT_MS`) and reports the timeout; the block is on screen
  regardless. Its spawn also settles on `exit` and tolerates EPIPE, matching the
  runner.
- **`distill` failed on every call when Claude Code verbose mode is on.** With
  `"verbose": true` in `settings.json` (or `--verbose`), `claude -p
  --output-format json` emits a JSON **array** of stream events terminated by
  the `type: "result"` event instead of a single result object. The runner read
  the array as an object, found no `result`, and failed every digest, cluster,
  and author call with `claude envelope missing a 'result' field` after burning
  its one corrective retry, so a whole distill run died at the clustering
  stage with no usable output. Both payload shapes are now accepted (the result
  event is located by its `type` field, whose key position is not stable).
  There is no `--no-verbose` flag to force the object shape, so tolerating the
  array is the only fix available to a caller.
- **Undiagnosable envelope errors.** A missing `result` now reports a snippet of
  the actual stdout; a verbose stream that ends without its terminal event says
  so explicitly instead of blaming a missing field.
- **Capability probe under-detected on wrapper distributions.** A distribution
  wrapper (observed in the wild: a `claude` that resolves credentials and model
  routing, then execs the native binary) documents only its own options in
  `--help` and forwards unknown flags through. Its help advertised neither
  `--json-schema` nor `--tools`, yet both work when passed, so the probe read
  `{jsonSchema: false, disableTools: "none"}` and silently degraded every
  distill stage to the prompt-embedded schema with tools disabled by
  instruction alone. When `--help` does not look like the native help (no
  `--output-format`), the probe now re-checks once via `--claude-help` and
  prefers that answer if it finds more. Verified against the real wrapper:
  the probe now reports `{jsonSchema: true, disableTools: "tools-empty"}`.
- **An answer typed without a trailing newline inverted consent.** readline
  discards a final line that arrives with no newline, so an answer terminated by
  EOF (`printf y |`, or Ctrl-D straight after the keystroke) resolved to `""` and
  was read as the prompt's default. Seen in the wild as
  `Proceed? [y/N] ydeclined; nothing was invoked.`: the `y` echoed and was then
  thrown away. This cut both ways, since a newline-less `n` against one of the
  default-Yes offers was read as yes. `ask()` now taps the raw bytes and falls
  back to their first line, so a newline-less answer is honored while a genuine
  no-input EOF still takes the default.
- **A fenced JSON reply wrapped in any prose defeated `stripFence`.** The pattern
  was anchored to the whole string, so a single `Here you go:` preamble or a
  `Hope that helps!` sign-off around an otherwise perfect ```json block left the
  fence in place, the parse failed, and the stage burned its one corrective
  retry. An uppercase ```JSON tag was captured into the body for the same reason.
  This is the last line of defense whenever the CLI cannot validate server-side
  (no `--json-schema`, and always for the kiro runner), and the live model does
  fence its output on that path even when told to answer with JSON only. Fence
  detection is now unanchored and case-insensitive, takes the first block when
  several are emitted, and still passes non-fenced text and unterminated fences
  through untouched so error snippets keep showing the real content.
- **R3 dropped every message typed while the agent was busy.** Claude Code writes
  a queued prompt's text in the attachment's `prompt` field; the extractor read
  `text`, found nothing, and recorded a drop. Because the fixture pinning R3 was
  hand-authored with `text`, the suite validated a shape no CLI emits and the
  loss was invisible. Measured on a real 286-session store: **673 → 920 messages
  exported (+247, a 36.7% increase)**, recovering all 253 human queued messages
  (~42.9k chars). Every follow-up typed mid-run ("its ok let it cook", "putting
  you back in plan mode") was being thrown away, so digests and authored oneshots
  were built from a corpus missing a third of its input. `text` is still read as a
  fallback.
- **Drop reports dumped raw JSON for attachments.** `entrySnippet` also only knew
  `text`, so every dropped attachment fell through to serializing the whole entry,
  making `export --verbose` unreadable (and camouflaging the bug above as machine
  noise). Attachments now report their `prompt`/`text`, or `<attachment type>`
  when they carry no human-readable payload.
- **K14: kiro dropped every mid-run steering message.** When the human types
  while kiro is working, the harness does not record a new `Prompt`: it wraps the
  words in a `[LIVE STEERING - New message from user]` envelope and appends that
  to the NEXT `ToolResults` entry. K1 admits only `Prompt` entries, and K6 dropped
  the envelope on its bracket marker, so the text was invisible either way.
  Measured on a real 306-session store: **312 to 411 messages exported (+99, a
  31.7% increase)**, recovering all 112 steering messages (~13.6k chars). These
  are the turns where the human corrects course mid-run ("i kinda need you to
  hurry up please", "git history, code and log.md never lie"), so they carry more
  signal per character than almost anything else in a session. Only the
  `<user_message>` body is admitted: the harness instructions around it stay out,
  and the 5630 `toolResult` blocks in those same content arrays are untouched.
  Recovery runs in both `extract` and `timeline`, so the SessionSource law holds
  (verified on the real store: 306 files, 485 messages, 0 violations).

### Added

- **SessionSource law test for the Claude backend** (`extract` ↔ `timeline`
  agreement across 11 fixtures). kiro has had one since the multi-backend seam
  landed; the Claude side did not, which is how a rule could halve the corpus
  without a single test failing. Also verified against the real store: 286
  sessions, 970 messages, 0 violations.
- **Systemic-failure breaker on the digest stage.** Five consecutive
  byte-identical failures now stop the stage instead of grinding through every
  remaining session. Per-session containment is right for a session-specific
  problem, but an unbroken streak of the same error is an environment problem (a
  reshaped CLI envelope, a revoked credential), and each failure also burns the
  runner's one corrective retry, so continuing buys the same error at two calls
  apiece. Measured on a 12-session live run where every call failed: 5 sessions
  attempted instead of 12, saving 14 doomed invocations, and the report names the
  environment as the likely cause rather than listing 12 identical errors.
  Anything already digested stays checkpointed, sessions that were never reached
  are reported as `not attempted` so the count is never silently short, and
  `--no-breaker` restores the attempt-everything behavior.

## [1.1.0] - 2026-07-17

### Added

- **kiro-cli backend.** cc-hindsight now mines kiro-cli session history
  (`~/.kiro/sessions/cli`) alongside Claude Code. New `--source
  claude|kiro|auto` (default `auto`: read whichever stores exist) and
  `--kiro-dir` / `KIRO_CONFIG_DIR` flags on every command; the export manifest
  tags each session's `origin` and a merged run breaks the count down
  (`9 claude + 3 kiro`).
- **Runner selection.** `distill --runner claude|kiro|auto` chooses which local
  CLI distills, orthogonal to `--source`; `auto` prefers the CLI matching the
  source, else whichever is installed (a kiro-only machine works out of the box).
  The kiro runner adds a bounded empty-stdout transport backoff beneath the
  existing corrective retry, and cleans up the sessions kiro auto-saves per run.
- **Preferences targets.** `preferences --target claude|kiro|agents` emits a
  `CLAUDE.md` block, a `~/.kiro/steering/` file, or a portable `AGENTS.md`
  section (default inferred from `--source`).
- **Source-aware distill prompts.** Digest/cluster/author prompts name each
  session's backend (neutral "coding-agent" for merged corpora) and only
  explain the `[decision]`/`[command]`/`[image pasted]` legend for sources
  that produce it; `DIGEST/CLUSTER/AUTHOR_PROMPT_VERSION` bumped (claude-origin
  prompt text unchanged).
- **Observability.** Non-text kiro Prompt blocks render the `[image pasted]`
  placeholder or an explicit drop (K11); Compaction-snapshot-only prompts are
  recorded as drops (K12); orphan kiro `.history` files (transcript deleted)
  are surfaced by `scan`/`status`; merged `--source auto` runs print a
  one-time notice with the `--source claude` escape; `status` breaks the
  discovered count down per source; the kiro runner reports total
  `Credits:` spent per distill run.
- **Colorful distill flow.** Each stage prints a banner (`── digest ───── 5
  session(s)`) with a bold label, dim rule, and cyan count for digest, cluster,
  author, and budget; per-item lines gain colored status glyphs (green `✔`,
  red `✗`, yellow `⤬`) and stage summaries turn green when nothing failed.
- **Preferences clipboard offer.** At the end of a `preferences` run,
  cc-hindsight offers to copy the rendered block to the clipboard (enter =
  yes; `--yes` copies without asking; silent in pipes) and prints paste
  guidance naming the target file (`CLAUDE.md`, kiro steering, or `AGENTS.md`).
- **Distill preferences cascade.** After a successful `distill`, a press-enter
  cascade offers to consolidate the freshly observed preferences (one runner
  call, cost named in the prompt) and then copy the result to the clipboard,
  closing the loop from history to a paste-ready guidance block.
- **Git-ref installs.** A `prepare` script builds `dist` on install, so
  `npx github:adityaarunsinghal/cc-hindsight#<ref>` works from any branch,
  tag, or commit; the build's output routes to stderr so `npm pack --json`
  capture stays parseable on every npm version (with `--ignore-scripts` kept
  where npm honors it).

### Changed

- The package description and keywords are de-branded to the coding-agent
  framing, naming both Claude Code and kiro-cli (new keywords `kiro`,
  `kiro-cli`, `agents`); the root `--help` and README intro follow suit.

- Internal refactor: extraction, discovery, and the runner moved behind a
  source-agnostic `SessionSource` / `AgentRunner` seam (`src/sources/`,
  `src/runners/`) with re-export shims at the old paths. Zero behavior change on
  the Claude Code path (export output byte-identical), verified against a golden
  reference.

## [1.0.2] - 2026-07-15

### Fixed

- The license badge in the README pointed at an npm registry endpoint that
  intermittently rendered "package not found"; it now reads the license GitHub
  detects, so it reliably shows MIT.

## [1.0.1] - 2026-07-15

### Added

- A demo GIF at the top of the README showing a real run.
- SECURITY policy, this changelog, a pull-request template, and an issue-template
  config that routes questions to Discussions.

### Changed

- Documentation reads in a plainer voice throughout.

## [1.0.0] - 2026-07-15

First public release.

### Added

- **One-command flow.** `distill` offers to run `export` first when nothing has
  been exported yet, and offers to show the finished library when it is done,
  so `npx cc-hindsight distill` can build and display a library end to end.
- **Parallel authoring.** The author stage runs calls concurrently through the
  same bounded worker pool as digest. A shared `--concurrency` flag (default 3)
  drives both stages; results stay in a deterministic order.
- Trusted-Publishing release workflow: tagged releases publish to npm over OIDC
  with a provenance attestation and no stored token.

### Changed

- `renderMarkdownAnsi` now honors its explicit `color` flag instead of letting
  Node's stream auto-detection strip styling in non-TTY contexts.
- The consent prompt tolerates an already-exhausted stdin instead of hanging on
  a second question.

### Pre-1.0 history

Earlier `0.1.x` releases built up the core: read-only `scan`, the deterministic
`export` with its audited extraction contract (rules R1 to R11) and cross-file
dedupe, the consent-gated three-stage `distill` pipeline (digest, cluster,
author), library browsing and curation (`list`, `show`, `copy`, `edit`, `rate`,
`prune`, `status`), the `preferences` CLAUDE.md aggregator, input budgets, and
hardened packaging.

[2.1.1]: https://github.com/adityaarunsinghal/human-hindsight/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/adityaarunsinghal/human-hindsight/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/adityaarunsinghal/human-hindsight/compare/v1.8.5...v2.0.0
[1.8.5]: https://github.com/adityaarunsinghal/human-hindsight/compare/v1.8.4...v1.8.5
[1.8.4]: https://github.com/adityaarunsinghal/human-hindsight/compare/v1.8.3...v1.8.4
[1.8.3]: https://github.com/adityaarunsinghal/human-hindsight/compare/v1.8.2...v1.8.3
[1.8.2]: https://github.com/adityaarunsinghal/human-hindsight/compare/v1.8.1...v1.8.2
[1.8.1]: https://github.com/adityaarunsinghal/human-hindsight/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/adityaarunsinghal/human-hindsight/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/adityaarunsinghal/human-hindsight/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/adityaarunsinghal/human-hindsight/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/adityaarunsinghal/human-hindsight/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/adityaarunsinghal/human-hindsight/releases/tag/v1.4.0
[1.3.1]: https://github.com/adityaarunsinghal/human-hindsight/releases/tag/v1.3.1
[1.3.0]: https://github.com/adityaarunsinghal/human-hindsight/releases/tag/v1.3.0
[1.2.0]: https://github.com/adityaarunsinghal/human-hindsight/releases/tag/v1.2.0
[1.1.0]: https://github.com/adityaarunsinghal/human-hindsight/releases/tag/v1.1.0
[1.0.2]: https://github.com/adityaarunsinghal/human-hindsight/releases/tag/v1.0.2
[1.0.1]: https://github.com/adityaarunsinghal/human-hindsight/releases/tag/v1.0.1
[1.0.0]: https://github.com/adityaarunsinghal/human-hindsight/releases/tag/v1.0.0
