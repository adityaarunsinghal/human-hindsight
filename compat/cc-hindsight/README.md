# cc-hindsight has moved to Human Hindsight

Start the guided setup with the renamed command, or install it globally.

```bash
npx human-hindsight
npm install -g human-hindsight
```

This deprecated package keeps the `cc-hindsight` command working by forwarding
to the matching version of `human-hindsight`. Both commands need Node.js 22.13+
on Node 22, or 23.4+ on newer versions. They use the same launcher and pass
through arguments, input, signals, and exit codes.

Existing `~/.cc-hindsight` libraries and `CC_HINDSIGHT_HOME` remain supported.
The new command uses `~/.human-hindsight` for fresh installations and also
accepts `HUMAN_HINDSIGHT_HOME`. Your existing library stays in place. The next
distill can regenerate earlier results under the new model plan while preserving
hand-edited prompts, ratings, and preference reviews.

Both packages can be installed together: `human-hindsight` owns the new command
and this package owns the old one.

Source, documentation, and releases:
[Human Hindsight](https://github.com/adityaarunsinghal/human-hindsight).
