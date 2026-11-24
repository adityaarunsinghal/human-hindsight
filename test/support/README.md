# Test support

Small helpers shared by the tests. Each file starts with a header comment that explains its use, and each has its own test next to it (`test/support/*.test.ts`).

| File | What it gives a test |
| --- | --- |
| `tty.ts` | Fake terminal streams: `fakeOutput()` records every write and has settable `isTTY`, `columns`, `rows`; `fakeInput()` takes key bytes, can be ended, and records `setRawMode`. |
| `runner-io.ts` | A scripted fake of `RunnerIo` (`which`, `spawn`) with a call log and `failOnUnscripted()`. No test starts a real agent CLI. |
| `home.ts` | A builder for a synthetic data home: exports, digests, tasks, library entries, preference reviews, and a saved subagent suggestion. |
| `clock.ts` | An injectable clock whose `sleep` returns at once, and a seeded random source. |
| `text.ts` | Escape stripping and normalization of timestamps, UUIDs, generation ids, and temp paths. |
| `bundle-guard.ts`, `global-setup.ts` | Stops the test run when `src/gui/client.generated.ts` is missing or older than its sources. Fix: `npm run build`. |

## Golden files

Rendered screens and help pages are checked against plain-text golden files instead of byte-pinned strings:

```ts
import { goldenText } from "./support/text.js";

const text = goldenText(out.raw(), { roots: { [home]: "<HOME>" } });
await expect(text).toMatchFileSnapshot("../golden/<area>/<name>.txt");
expect(text).toContain("3 sessions"); // plus a few assertions on meaning
```

- Store golden files under `test/golden/<area>/<name>.txt`. The path is relative to the test file.
- Always compare stripped, normalized text (`goldenText`), never raw escapes. Escape sequences are asserted directly with `fakeOutput().escapes()`.
- Add a few assertions on meaning beside each golden file: a count, a model name, the absence of a label.
- To accept an intended change, run `npx vitest run -u <test file>` and review the diff of the golden file before committing it.
