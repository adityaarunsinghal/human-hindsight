#!/usr/bin/env node
import type { Writable } from "node:stream";
import { parseArgs, runMain } from "citty";
import { sharedArgs } from "./commands/_shared.js";
import { isEnvironmentWorker, platformNotice } from "./core/environment.js";
import { installEpipeHandler } from "./ui/epipe.js";

// `human-hindsight list | head` closes our stdout mid-write. That's normal Unix
// life, not an error: exit quietly like cat/grep/ls do instead of dumping an
// EPIPE stack trace on the customer. stderr can close the same way.
installEpipeHandler(process.stdout as unknown as Writable);
installEpipeHandler(process.stderr as unknown as Writable);

if (!isEnvironmentWorker()) {
  const { main, forwardRootFlags } = await import("./main.js");
  const { createShowUsage, rejectUnknownInput } = await import("./commands/help.js");
  const rawArgs = forwardRootFlags(process.argv.slice(2));
  // Citty handles --help before running setup, including the help shown in plain mode.
  const { plain } = parseArgs(rawArgs, sharedArgs);
  if (plain !== undefined) process.env.HUMAN_HINDSIGHT_PLAIN = plain ? "1" : "0";
  const notice = platformNotice();
  if (notice) process.stderr.write(`${notice}\n`);
  // A mistyped command or flag is reported with the closest real one, and nothing runs.
  if (!(await rejectUnknownInput(main, rawArgs))) {
    await runMain(main, { rawArgs, showUsage: createShowUsage(main, rawArgs) });
  }
}
