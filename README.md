# Human Hindsight

<p align="center">
  <img src="https://raw.githubusercontent.com/adityaarunsinghal/human-hindsight/v2.1.0/.github/assets/human-hindsight-banner.jpg" alt="Human Hindsight terminal with colorful session counts and arcs leading to the words “Codify your taste”" width="1280">
</p>

[![npm](https://img.shields.io/npm/v/human-hindsight?color=cb3837&logo=npm)](https://www.npmjs.com/package/human-hindsight)
[![CI](https://github.com/adityaarunsinghal/human-hindsight/actions/workflows/ci.yml/badge.svg)](https://github.com/adityaarunsinghal/human-hindsight/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/node/v/human-hindsight?logo=node.js&color=339933)](https://nodejs.org)
[![MIT license](https://img.shields.io/github/license/adityaarunsinghal/human-hindsight?color=blue)](https://github.com/adityaarunsinghal/human-hindsight/blob/main/LICENSE)
[![Local-first](https://img.shields.io/badge/local--first-privacy-brightgreen)](#privacy-and-setup)

**Understand how you work. Codify your taste.**

> We’ve used a lot of different technologies over months and years. Claude Code, Codex, Kiro CLI, Kiro Crew, OpenCode, Pi… the list goes on.
>
> You are the one piece of the puzzle that unites them all.
>
> This tool helps you understand yourself better, and then codify your taste. Your taste, your nudges, and your corrections are what make the work you do with your AI different from the work someone else does with theirs. Run `npx human-hindsight` on your machine to get the full overview.
>
> This tool is private and local. When you approve a reflection, it uses your own coding agent, so your usual inference provider receives the selected messages and the calls use your tokens there.
>
> If you spot problems, please [leave an issue](https://github.com/adityaarunsinghal/human-hindsight/issues). PRs are welcome!

```sh
npx human-hindsight
```


## Your first reflection

Choose **Reflect on my history**. If you have more than 25 eligible sessions, you can start with the latest 25 or use them all. If several coding tools are ready, choose which one will run the reflection. The plan names the tool, the models, the expected calls and the text your provider will receive. Press `s` to start.

As each session is read, the terminal names the project, what you were trying to do, how it ended and any preference the tool picked up. Once your prompts are saved, open the local link in the terminal. The **Preferences** tab fills in as the remaining batches finish.

- **Preferences** opens with an observation, where it applies, and the words behind it. Copy the guidance straight away, or edit or dismiss a preference.
- **Prompts** holds starting prompts for work you do again.
- **Subagents** holds specialist instructions you can read and export. To generate them, ask Human Hindsight to suggest roles and approve that plan.

For example, say you ask for a working install before the explanation in a tutorial, but want the exact option name first on a reference page. A preference you could give your next documentation agent is “Start tutorials with a working example. Lead reference entries with the option name.”

## Privacy and setup

Human Hindsight scans local history from Claude Code, Codex, Kiro CLI, Kiro Crew and OpenCode. Scanning and Markdown export stay on your machine. After you approve a model-call plan, the coding tool uses its usual sign-in and provider to process the selected text. Those calls use your tokens. Results are saved locally. Human Hindsight has no hosted account or telemetry. [Privacy details](https://github.com/adityaarunsinghal/human-hindsight/blob/main/SECURITY.md)

Use Node.js 22.13 or later in the 22 line, or 23.4 or later, on macOS, Linux or Windows through WSL. To run a reflection, sign in to Claude Code, Codex, Kiro CLI or OpenCode. You can export history without a signed-in tool.

## Useful commands

```sh
npx human-hindsight export              # Save your messages as local Markdown
npx human-hindsight reflect --dry-run   # Preview the plan for exported sessions
npx human-hindsight reflect --recent 25 # Reflect on the 25 latest eligible sessions
npx human-hindsight reflect --quality fast # Lighter model and low reasoning effort for a quicker run
npx human-hindsight reflect --no-prompts --subagents # Read, summarize, then suggest subagents in one run
npx human-hindsight gui                 # Open the local browser view
npx human-hindsight preferences         # Print the preferences you have accepted
npx human-hindsight suggest-subagents   # Plan and generate specialist roles
npx human-hindsight doctor              # Check for history and a signed-in coding tool
```

Fast, Balanced and Best, choosing a coding CLI, remote machines, long sessions and troubleshooting are covered in the [guide](https://github.com/adityaarunsinghal/human-hindsight/blob/main/GUIDE.md).

Upgrading from 2.0? Your library, hand-edited prompts, ratings and preference reviews carry forward. `distill` is an alias for `reflect`. Existing `cc-hindsight` scripts and data folders still work. [Release notes](https://github.com/adityaarunsinghal/human-hindsight/blob/main/CHANGELOG.md)

<p align="center">
  <img src="https://raw.githubusercontent.com/adityaarunsinghal/human-hindsight/main/.github/assets/demo.gif" alt="Human Hindsight reads two fictional coding sessions about a duplicate invoice and a retried refund, then opens the reusable prompt it wrote." width="800">
  <br><sub>A reflection on two fictional sessions in ledger-import and checkout-api.</sub>
</p>

Created by Aditya Singhal. [Selected Work](https://adityasinghal.com/#current) · [npm](https://www.npmjs.com/package/human-hindsight) · [Report an issue](https://github.com/adityaarunsinghal/human-hindsight/issues) · [Contribute](https://github.com/adityaarunsinghal/human-hindsight/blob/main/CONTRIBUTING.md) · [MIT license](https://github.com/adityaarunsinghal/human-hindsight/blob/main/LICENSE)
