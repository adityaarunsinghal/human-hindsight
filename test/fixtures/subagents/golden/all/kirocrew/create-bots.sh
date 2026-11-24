#!/usr/bin/env sh
# human-hindsight suggested subagents · generated 2026-11-20
# Creates one Kiro Crew Bot per suggested role. Read it before running it.
# Then set each Bot's description and triggers from kirocrew/skills/<name>/SKILL.md.
set -eu
kirocrew agent create --name 'evidence-analyst' --display-name 'Evidence analyst' --kiro-agent kirocrew
kirocrew agent create --name 'release-engineer' --display-name 'Release engineer' --kiro-agent kirocrew
kirocrew agent create --name 'docs-editor' --display-name 'Docs editor' --kiro-agent kirocrew
