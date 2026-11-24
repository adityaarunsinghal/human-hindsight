# Security and privacy

Human Hindsight reads coding sessions stored on your machine. You choose which history to export, whether any of it goes to a model, and which generated files to copy into your tools.

## What stays on this machine

`npx human-hindsight scan` and `npx human-hindsight export` read the history stores locally. An export writes one Markdown file per session with the person's messages, decisions and attachment markers. Next to them, `anaphora.json` can hold the assistant text, question or proposed plan needed to understand a short reply such as "yes", and `outcomes.json` can hold the end of the assistant's last message. The manifest records source paths. OpenCode databases are opened read-only.

Exports, model results, review decisions, and checkpoints live in the data home: `~/.human-hindsight` by default, an existing `~/.cc-hindsight` when the newer folder is absent, or the folder named by `--home` or `HUMAN_HINDSIGHT_HOME`. On POSIX filesystems its folders are created owner-only (`0700`) and its files owner-only (`0600`). Anyone with access to your user account or your backups can still read them, and encryption at rest depends on your filesystem.

A credential, path, or private message pasted into a session can appear in an export or a derived result. Read the files before sharing them.

`npx human-hindsight retention` previews changes to Claude Code and Codex history settings. Writing them needs `--apply` and a confirmation, or `--apply --yes`, and each existing configuration file is backed up first. `npx human-hindsight suggest-subagents --export DIR` writes saved roles to the folder you name without a model call. Review role files before placing them where a coding tool loads them automatically.

## What reaches a model provider, and when

Reflection (including retries), preference consolidation and subagent generation can make model calls. Each shows a plan before sending text. To preview a reflection or subagent plan without making a model call, run `npx human-hindsight reflect --dry-run` or `npx human-hindsight suggest-subagents --dry-run`. `distill` is a compatibility alias for `reflect` and uses the same approval step.

- **Before approval**, Human Hindsight reads local history and runs the coding tools' own version and sign-in checks. A tool may contact its service to check sign-in or list models. No session text is sent during these checks. The first screen says so in one line.
- **At the plan**, choose a coding tool if several are ready for an interactive reflection. The plan identifies what the tool will send to its usual provider, which models it will use, and the reasoning effort the plan sets (low for Fast, high for Balanced, extra high for Best) on a CLI that takes one. Press `s` to approve. Choosing a tool or a plan, pressing Enter, and keys typed ahead do not approve it. In plain mode, type `s` and press Enter. A script can approve with `--yes`.
- **One approval can cover the subagent step.** `npx human-hindsight reflect --subagents`, and **Suggest subagents** on a machine with no saved reads, name that step and its calls on the reflection plan, so it runs on the same approval. Its own plan is still printed before its calls.
- **After approval**, one small request for each planned model checks that the CLI can reach its provider. Depending on the stage, the CLI then receives exported messages, supporting excerpts, session summaries, preferences with their quotations, or draft roles. A reflection with fully reusable results needs no model call.
- **Which CLIs can receive text.** Each CLI uses its own sign-in and configured provider, and the calls use your tokens with that provider. The CLI you choose at the plan is where the run starts. If it stops working (not signed in, out of quota, or failing repeatedly), the run moves to another ready CLI and says so in one line. Every CLI it can move to is named on the plan before you approve. To keep a run on one CLI, pass its name: `--runner=codex`. Several names separated by commas are tried in that order.
- **Sessions too long for one call** are never shortened unless you pass `--truncate=extreme`. By default a session over the size limit is left out, and a group too long to write is written from the whole sessions that fit. The plan names each session left out before you approve, and the closing lines name both.
- **Ctrl-C** stops the calls in flight and ends their processes, including any processes they started. Late answers are discarded, finished work is kept, and the command exits with code 130.

Human Hindsight has no hosted service, account system, or telemetry. Retention and billing of what you send are governed by the CLI and provider you use.

Commands that change the library take turns through a lock in the data home (`distill/writer.lock`). A command that meets the lock changes nothing and names the holder, its process, and the folder to remove if nothing is running. A run stopped with Ctrl-C holds the lock until it has finished writing. A lock whose process is gone is taken back at once; one recorded under another machine name is taken back only after it has gone a short while without an update, because its process cannot be checked from here.

Model steps run from private working directories, with the CLI's tools disabled and its own instructions and plugins kept out where the CLI allows it. Where a CLI saves the generated session, cleanup removes only the sessions that run created; an interrupted cleanup can leave some on disk. The history readers skip recognized Human Hindsight sessions so they never become input.

## The local browser view

`gui` serves the library on `127.0.0.1` only.

- Each start creates a new session key. The address carries it after `#`, so a browser never sends it to the server as part of a URL.
- To open your browser, `gui` writes a short redirect page into the data home, readable only by you, and passes the opener that file's path. The key never appears on a command line, where other users could see it in the process list. The file is removed once the page has loaded, when the viewer stops, or when opening fails.
- The page shell, which holds no library data, can be loaded by an ordinary top-level navigation. Every `/api` route needs the key in a request header, the expected `Host`, and a same-origin request. A request with no key, a wrong key, the key in the query string, another `Host`, or a cross-site `Origin` is refused.
- The page keeps the key for its own browser tab only (in `sessionStorage`), so a reload keeps working. After a restart the old key stops working, and the page says how to open the new address.
- Browser assets ship with the package. Markdown is sanitized, raw HTML is shown as text, and remote images are not fetched. Copy returns the original Markdown.
- The only change the page can make to your library is an explicit Accept, Edit, or Dismiss on a preference, for a known preference at its current revision. Like every command that changes the library, it waits its turn: while another command is changing the library, the review is refused and the reply names that command.

## Remote use

A machine reached over SSH, or a Linux machine with no display, is treated as remote. There the browser view uses port 4317 and the terminal prints a loopback port-forward command to run on your laptop, then the address to open there. The forward binds `127.0.0.1` on both ends, so the library is not exposed on either machine's network. Other local users on the remote machine can reach the port, which is why every data route requires the session key.

The view a reflection opens stays up for 30 minutes after the run. So that the next reflection can use the same port, that view records its port and session key in the data home, readable only by you, and stops when the next one asks with that key. Nothing else can stop it, and the view opened by `gui` has no such route.

Over SSH, `copy` does not run a clipboard tool on the remote machine. It asks your own terminal to set the clipboard and prints the text as well.

## Packages and reporting

The main npm package contains a Node version launcher, the bundled application, and third-party license notices. The deprecated `cc-hindsight` wrapper depends on the matching version. Both published package manifests omit install hooks. The release workflow uses npm Trusted Publishing and requests provenance for each tarball.

Security fixes target the current released version. For a vulnerability or unexpected disclosure, use GitHub's private reporting form or contact the author directly. Include the Human Hindsight version, operating system, affected command, and the smallest synthetic example that demonstrates the issue. Omit personal transcripts, credentials, and source paths from a report. [Report a vulnerability](https://github.com/adityaarunsinghal/human-hindsight/security/advisories/new) · [Contact the author](https://adityasinghal.com)
