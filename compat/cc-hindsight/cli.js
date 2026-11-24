#!/usr/bin/env node

// Enter the same version guard before Node parses the application bundle. The
// application then runs in this process, so arguments, standard streams,
// signals, and the exit code pass straight through.
require("human-hindsight/launcher/cli.cjs").run(process);
