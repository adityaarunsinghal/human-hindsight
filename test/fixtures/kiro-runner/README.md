## kiro-runner fixtures

Output shapes of kiro-cli 3.5.0 used by `test/kiro-runner.test.ts`. They contain no private content.

- `stream-json-v2-engine-3.5.0.jsonl`: stdout of `kiro-cli chat --no-interactive --agent human-hindsight-distill --model claude-sonnet-5.5 --agent-engine v2 --output-format stream-json` for a one-line JSON answer, byte for byte.
- `stream-json-v3-engine-3.5.0.jsonl`: the same call on the v3 engine (no `--agent-engine`, with a `chat.agentEngine = "v3"` setting). Lines carrying the context breakdown, mode menus and command lists were removed because they list local file paths; the answer, thought, usage and run events are unchanged.
- `list-sessions-3.5.0.json`: the shape of `kiro-cli chat --list-sessions --format json`. The cwd is synthetic and the third session is invented to exercise the title check; the first two entries are real probe sessions, since deleted.
- `chat-help-3.5.0.txt`: the option lines of `kiro-cli chat --help` on 3.5.0 (descriptions dropped). The preflight requires only the flags of the model call that appear here.
