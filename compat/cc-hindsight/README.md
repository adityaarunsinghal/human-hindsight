# cc-hindsight has moved to Human Hindsight

Install or run the renamed app:

```bash
npx human-hindsight@latest gui
npm install -g human-hindsight
```

This deprecated package keeps the `cc-hindsight` command working by forwarding
to the matching version of `human-hindsight`. It contains no separate copy of
the application, and all arguments and exit codes pass through unchanged.

Existing `~/.cc-hindsight` libraries and `CC_HINDSIGHT_HOME` remain supported.
The new command uses `~/.human-hindsight` for fresh installations and also
accepts `HUMAN_HINDSIGHT_HOME`. You do not need to move or re-distill your data.

Both packages can be installed together: `human-hindsight` owns the new command
and this package owns the old one.

Source, documentation, and releases:
[Human Hindsight](https://github.com/adityaarunsinghal/human-hindsight).
