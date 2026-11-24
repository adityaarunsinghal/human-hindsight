# Human Hindsight guide

The [README](https://github.com/adityaarunsinghal/human-hindsight/blob/main/README.md) gets you through a first reflection. This page covers the choices behind it: how fast or thorough a run is, which coding CLI does the work, how to reach the browser view from another machine, and what to do when something does not go as expected.

## What a run does

```text
history → export → session reads ─┬─ grouping → prompts
                                  └─ preference summaries → subagents
```

Each step saves its results in your data home. A later run reuses whatever still matches and only does what is missing or changed, so stopping with Ctrl-C or reflecting on 25 sessions first costs nothing twice.

- `npx human-hindsight reflect` runs both branches.
- `npx human-hindsight reflect --no-prompts` reads sessions and summarizes preferences, and writes no prompts.
- `npx human-hindsight reflect --no-prompts --subagents` goes on to choose and write subagent roles on the same approval. **Suggest subagents** on the first screen does this when nothing has been read yet.

## Fast, Balanced, Best

One choice sets the models and how hard they are asked to reason.

| Plan | Session reads and preference summaries | Grouping, prompts, roles | Reasoning effort |
| --- | --- | --- | --- |
| Fast | lighter model | lighter model | low |
| Balanced (default) | lighter model | stronger model | high |
| Best | stronger model | most capable model | extra high |

- Models are picked by family and newest version from your CLI's own list: Sonnet, Opus and Fable on Claude Code; Terra, Sol and Astra on Codex. The plan shows them by their real names before anything is sent.
- The reasoning effort is set on Claude Code, Codex and Kiro CLI, where the installed version takes one. The plan screen states the level only when it will be sent. OpenCode names its effort levels per model, so its calls run at the model's own setting.
- A model your provider refuses steps down one tier, and the terminal says so in one line.
- A model you name yourself (`--model`, `--cluster-model`, `--author-model`) keeps the run on one CLI and runs at that CLI's own reasoning setting.
- Results are saved per plan. Switching plan reads your sessions again; switching back reuses what that plan saved.

Choose at the plan with `1`, `2` or `3`, or pass `--quality fast`, `--quality balanced` or `--quality best`.

## Which coding CLI runs it

When several CLIs are ready, the plan asks which one should run the reflection: `c` Claude Code, `x` Codex, `k` Kiro CLI, `o` OpenCode.

- Your choice is where the run starts. If that CLI is not signed in, is out of quota, or keeps failing, the run moves to the next ready CLI and says so in one line. The plan names every CLI it can move to before you approve.
- `--runner=codex` keeps a run on Codex. Nothing else is tried.
- `--runner=codex,claude` tries them in that order.
- `--runner=auto` uses every ready CLI, starting with the one that holds most of your history.
- Saved reads, groups and prompts are reused whichever CLI produced them, as long as the plan is the same. A run kept on one CLI with `--runner=<cli>` reuses only its own.

`npx human-hindsight doctor` shows which CLIs are installed and signed in, with one fix for each problem.

## Remote and headless machines

Over SSH, or on a Linux machine with no display, the browser view cannot open a browser where you are. It uses port 4317 and prints what to run on your laptop:

```text
ssh -N -L 127.0.0.1:4317:127.0.0.1:4317 -- you@devbox
```

To skip that step from then on, add one line under the host in `~/.ssh/config` on your laptop:

```text
Host devbox
  LocalForward 4317 127.0.0.1:4317
```

Every later link then opens as printed. The forward binds `127.0.0.1` on both ends, and every data request needs the session key in the link. Editors that forward ports for a remote terminal usually open the link directly.

If another program holds port 4317, another port is used and the printed command names it.

## Long sessions and large groups

A session longer than the size limit per call (400,000 characters) is never shortened unless you ask.

- By default it is left out. The plan names it before you approve, and the closing lines give the command that includes it.
- `--truncate=extreme` keeps the beginning and the end of each long session and drops the middle.
- `--input-budget <characters>` raises the limit when your models take more.
- A group of sessions too long to write as one prompt is written from the whole sessions that fit, starting with the ones that reached a result. `show <name>` says how much of the source text was used.

## Upgrading

- **From 2.1.0 to 2.1.2:** at the plan, Fast is `1`, Balanced `2` and Best `3`. A choice at the plan no longer keeps the run on that CLI; pass `--runner=<cli>` for that. Preference summaries are rebuilt once if your last run used a CLI chosen at the plan.
- **From 1.x:** the first reflection reads your sessions again once. Hand-edited prompts, ratings and preference reviews are kept. Prompts whose group no longer exists are kept and listed apart; `npx human-hindsight prune` removes them.
- `distill` still works as another name for `reflect`, and the `cc-hindsight` package still forwards to it.

## When something goes wrong

- **"Human Hindsight needs Node.js 22.13 or newer":** run it with a newer Node without changing your default, for example `npx -y -p node@24 -p human-hindsight@latest human-hindsight`.
- **No history found:** pass the folder, for example `--claude-dir <dir>`. `npx human-hindsight help --all` lists every folder option.
- **A CLI is installed but the run will not use it:** `npx human-hindsight doctor` gives the sign-in or install command.
- **"... is changing this library":** another command is writing. Wait for it, or remove the folder the message names if nothing is running.
- **Some sessions could not be read, or some prompts could not be written:** the rest is saved. The terminal prints the command that tries only those again.
- **A run was interrupted:** run the command the terminal printed. Finished reads, groups and prompts are reused.
- **Start over:** `npx human-hindsight reflect --fresh` discards saved reads and grouping after asking. `--force` replaces a prompt you edited by hand.
- **Menus do not draw well in your terminal:** add `--plain` for numbered prompts and static progress lines.

Exit codes: 0 done, 1 failed, 2 declined at a question, 130 interrupted.

Privacy and what reaches a model provider are covered in [SECURITY.md](https://github.com/adityaarunsinghal/human-hindsight/blob/main/SECURITY.md).
