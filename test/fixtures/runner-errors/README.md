## runner-errors fixtures

Real error output of each coding CLI, reduced to the stable wording. `test/runner-failures.test.ts` feeds every case through the matching runner with a fake process runner and checks the failure class the runner reports.

How they were captured (2026-11-23, macOS, prompt `Reply with the single word ok`, from an empty temporary folder):

- unknown model: each CLI's one-shot command in the output mode its runner uses, with an invalid model name;
- signed out: the same command with `HOME` and the CLI's own config variable pointed at empty temporary folders.

What was changed from the raw capture: session, thread and request ids are synthetic; the invalid model name is `example-missing-model`; timestamps are fixed; Claude's result envelope keeps only the fields the runner reads; repeated reconnect lines from Codex are cut to the last one. The error wording itself is unchanged.

| File or case | CLI version | What it proves |
| --- | --- | --- |
| `claude-unknown-model` | Claude Code 2.1.330 | an unknown model is reported in the result envelope and as a stderr tag: `model-unavailable` |
| `claude-signed-out` | Claude Code 2.1.330 | a signed-out first-party install: `sign-in` |
| `claude-signed-out-cloud-credentials` | Claude Code 2.1.330 | a cloud-provider install whose credentials cannot be loaded: `sign-in` |
| `claude-model-refused-by-provider` | Claude Code 2.1.330 | a cloud-provider install that refuses one model (`--model fable`, and the full id) under the account's settings: typed status 400 plus "is not available for this model" in the result envelope: `model-unavailable`, so the role steps down. Any other 400 stays `cli-error` |
| `codex-unknown-model` | Codex 0.171.0 | an unknown model on a custom provider: `model-unavailable` |
| `codex-signed-out` | Codex 0.171.0 | no credentials: HTTP 401 in the final error event: `sign-in` |
| `kiro-unknown-model` | Kiro CLI 3.5.0 | an unknown model in the `runError` event: `model-unavailable` |
| `kiro-signed-out` | Kiro CLI 3.5.0 | `runError` with stage `auth`, and the same text on stderr: `sign-in` |
| `opencode-unknown-model`, `opencode-signed-out` | OpenCode 1.18.15 | OpenCode reports both as an opaque `UnknownError`, so both stay `cli-error` |
| `opencode-database-locked` | OpenCode 1.18.15 | ten runs at once: OpenCode's own local database refused work, `transient` (retried with backoff). Recorded from the runner's error message on a live run. The runner builds that message from a JSON error event when there is one, else from stderr; the color codes show it was terminal output, so stderr. Exit code and stdout were not recorded and are set to the usual failure exit and empty |
| `codex-exec-help-0.171.0.txt` | Codex 0.171.0 | the option lines of `codex exec --help`; the Codex preflight accepts it |

Rate limits, overload and server errors are read from typed fields where a CLI reports them (Claude's `api_error_status`, OpenCode's `statusCode`, provider error codes passed through by Codex), and from Codex's `unexpected status` wording, the shape captured in `codex-signed-out`. `test/runner-failures.test.ts` covers those cases with the captured envelopes and a changed status. No quota output has been captured; quota is read only from documented typed fields, never from text.

The option lines of `kiro-cli chat --help` for 3.5.0 live in `../kiro-runner/chat-help-3.5.0.txt`.
