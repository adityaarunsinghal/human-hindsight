/**
 * A failure the person can fix, said in one plain line. The guard every
 * command runs under (`reportFailure` in `main.ts`) prints it on stderr with
 * exit code 1 and no debugging hint: nothing unexpected happened. Any other
 * error is a crash, and only then is `HUMAN_HINDSIGHT_DEBUG=1` suggested.
 */
export class PlainFailure extends Error {
  override name = "PlainFailure";
}

/** A file the tool writes that can no longer be read, and the command that writes it again. */
export function damagedFile(file: string, reason: string, rebuild: string): PlainFailure {
  return new PlainFailure(
    `${file} is damaged (${reason}). Run \`human-hindsight ${rebuild}\` again to rebuild it.`,
  );
}
