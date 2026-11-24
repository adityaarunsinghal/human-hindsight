# Create these specialists

Paste this file to a coding agent, together with the folder it sits in.

---

Please create the following 3 specialists for the harness I choose, from the files in this folder. Ask me which harness, and where the files should go, before writing anything. The files pin the model `opus-5.5`.

- `evidence-analyst` (Evidence analyst): Answers bounded questions from sources and measurements, with traceable numbers and explicit uncertainty.
- `release-engineer` (Release engineer): Plans and runs changes to stored data and deployed systems with dry runs, backups and a way back.
- `docs-editor` (Docs editor): Edits documents for other readers: plain register, defined terms, and numbers that trace to a source.

Every specialist follows the preferences in `knowledge/shared.md`. Its own lessons are in `knowledge/roles/<name>.md`.

## Claude Code

Copy `claude/agents/*.md` into the agents directory I choose (`~/.claude/agents/` for every project, or `.claude/agents/` in one repository). Add the block in `claude/CLAUDE.routing.md` to the matching `CLAUDE.md`. Keep `knowledge/` where the agent files can reach it, and update the path in each agent file if it moves.

## Codex

Copy `codex/agents/*.toml` into `~/.codex/agents/` (the `agents/` folder under `CODEX_HOME` when that is set). Each file is a Codex custom agent with `name`, `description` and `developer_instructions`, which Codex offers as a role when it spawns a subagent. The Codex files set no model, so each agent uses the session's model. Add the block in `codex/AGENTS.routing.md` to the matching `AGENTS.md`. Keep `knowledge/` where the agents can reach it, and update the path in each file if it moves.

## Kiro CLI

Copy `kiro/agents/*.json` into `~/.kiro/agents/` (or `.kiro/agents/` in one repository) and `kiro/steering/hindsight-routing.md` into the matching `steering/` directory.

## Kiro Crew

1. Run `kirocrew/create-bots.sh` to create one Bot per role.
2. For each Bot, open its editor and set the description and triggers from the frontmatter of the matching `kirocrew/skills/<name>/SKILL.md`.
3. Copy the `kirocrew/skills/` directories into `~/.kiro/crew/skills/`.
4. Copy `kirocrew/steering/hindsight-routing.md` into `~/.kiro/steering/`.

---

You decide where these files go. human-hindsight wrote nothing outside this folder.
