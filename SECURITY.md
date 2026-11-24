# Security and privacy

Human Hindsight reads coding sessions stored on your machine. You choose which history to export, whether any of it goes to a model, and which generated files to copy into your tools.

## What stays on this machine

`scan` and `export` read the history stores locally. `export` writes one Markdown file per session with the person's messages, decisions, and attachment markers. Next to them, `anaphora.json` can hold the assistant text, question, or proposed plan needed to understand a short reply such as "yes", and `outcomes.json` can hold the end of the assistant's last message. The manifest records source paths. OpenCode databases are opened read-only.

Exports, model results, review decisions, and checkpoints live in the data home: `~/.human-hindsight` by default, an existing `~/.cc-hindsight` when the newer folder is absent, or the folder named by `--home` or `HUMAN_HINDSIGHT_HOME`. On POSIX filesystems its folders are created owner-only (`0700`) and its files owner-only (`0600`). Anyone with access to your user account or your backups can still read them, and encryption at rest depends on your filesystem.

A credential, path, or private message pasted into a session can appear in an export or a derived result. Read the files before sharing them.

`retention` only previews changes to Claude Code and Codex history settings. Writing them needs `--apply` and a confirmation, or `--apply --yes`, and each existing configuration file is backed up first. `suggest-subagents --export DIR` writes only to the folder you name. Review role files before placing them where a coding tool loads them automatically.

## What reaches a model provider, and when

Four commands can call a model: `distill`, `distill --retry-failed`, `preferences --consolidate`, and `suggest-subagents`. Each shows a plan first, and session text is sent only after you press `s` at the plan's Start question or pass `--yes`. `--dry-run` prints the plan and calls nothing.

- **Before approval:** Human Hindsight sends nothing and opens no network connection of its own. The home screen and `doctor` only run your coding tools' own version and sign-in status commands; what those commands do is up to each tool (Kiro CLI's sign-in status, for one, can contact its service). Building a plan may ask a CLI which models it offers, which can contact that CLI's service, and the screen says so before it happens ("Asking Kiro CLI which models it offers. This contacts its service; no session text is sent."). No session text is sent then.
- **Approval:** the Start question takes one deliberate key, `s`, which no other question uses. Enter, a number, `y`, pasted text, and a key held down or repeated from an earlier menu never approve a plan; the question answers "Press s to start, or q to leave." `1` and `2` only choose between Balanced and Best. Keys typed before the question appears are thrown away, and it shows "Ignored keys typed ahead. Choose when you are ready." In plain mode the same letters are typed and entered. Input that is not a terminal declines; a script approves with `--yes`.
- **After approval:** just before the first model call, one tiny request for each model the approved plan will call checks that the CLI can reach its provider, and the plan says how many requests that is. When every result can be reused, nothing is sent at all. Then the stages run. Depending on the stage, the CLI receives exported messages, supporting excerpts, digests, your working preferences and their quotations, or draft roles.
- **Through whom:** only the CLIs named in the approved plan, each with its own sign-in and configured provider. The calls use your tokens with that provider. If the chosen CLI stops working, remaining work can move to another CLI the plan listed as ready, and a line announces the switch. `--runner`, or an explicit `--model`, `--cluster-model`, or `--author-model`, keeps the whole run on one CLI.
- **Stopping:** Ctrl-C stops the calls in flight and ends their processes, including any processes they started. An answer that arrives after Ctrl-C is discarded, and nothing is printed, written, or copied after the interrupt line. Finished work is kept, and the command exits with code 130.

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

## Remote use over SSH

Over SSH, `gui` uses port 4317 and prints a loopback port-forward command to run on your laptop, then the address to open there. The forward binds `127.0.0.1` on both ends, so the library is not exposed on either machine's network. Other local users on the remote machine can reach the port, which is why every data route requires the session key.

Over SSH, `copy` does not run a clipboard tool on the remote machine. It asks your own terminal to set the clipboard and prints the text as well.

## Packages and reporting

The main npm package contains a Node version launcher, the bundled application, and third-party license notices. The deprecated `cc-hindsight` wrapper depends on the matching version. Both published package manifests omit install hooks. The release workflow uses npm Trusted Publishing and requests provenance for each tarball.

Security fixes target the current released version. For a vulnerability or unexpected disclosure, use GitHub's private reporting form or contact the author directly. Include the Human Hindsight version, operating system, affected command, and the smallest synthetic example that demonstrates the issue. Omit personal transcripts, credentials, and source paths from a report. [Report a vulnerability](https://github.com/adityaarunsinghal/human-hindsight/security/advisories/new) · [Contact the author](https://adityasinghal.com)
