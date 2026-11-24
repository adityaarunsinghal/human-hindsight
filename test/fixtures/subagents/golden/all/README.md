# Suggested subagents

This folder holds specialist roles suggested by human-hindsight from your own coding-agent sessions, rendered for Claude Code, Codex, Kiro CLI and Kiro Crew. Each role owns a set of lessons, written as an instruction with the conditions it applies under and its exceptions. Nothing here is installed; you decide which files to copy and where.

Generated 2026-11-20T15:30:00.000Z with the kiro runner (generalize sonnet-5.5, propose opus-5.5, author opus-5.5) from the preferences accepted in review.

- 14 inputs: 12 became lessons, 2 were set aside
- 9 lessons: 7 generalized, 1 contextual, 1 historical
- 3 roles, 2 shared lessons, 1 playbook

## Layout

- `HANDOFF.md`: a request you can paste to a coding agent to create these specialists.
- `knowledge/`: the lessons (`lessons.json`), shared agreements, playbooks, one file per role, and the coverage ledger.
- `claude/`, `codex/`, `kiro/`, `kirocrew/`: the same roles in each harness's format, when exported.

## Refreshing

Run `human-hindsight suggest-subagents` again after reviewing more preferences. The saved suggestion is marked stale when the reviewed set changes, and the GUI shows that. This folder is a copy and is not updated in place.
