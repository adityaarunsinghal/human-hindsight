import type { Writable } from "node:stream";
import {
  type StageProgressOptions,
  startStageProgress as startScreenProgress,
} from "../ui/screen.js";

export interface StageItem {
  status: "done" | "skipped" | "failed" | "blocked";
  line: string;
  /** Matches the id supplied when this item began. Cached items can finish immediately. */
  id?: string;
}

export interface StageProgressSink {
  start(total: number, concurrency: number): void;
  running?(id: string, label?: string): void;
  item(event: StageItem): void;
  /** A line the person should read whatever the mode: a reason, a stop, a warning. */
  note(line: string): void;
  /** Per-item or per-call detail, shown only under `--verbose`. */
  detail?(line: string): void;
  end(): void;
}

export interface CommandProgressOptions extends StageProgressOptions {
  /** Show which items are running and the per-item detail lines. */
  verbose?: boolean;
}

/**
 * The progress display a command shows for one stage. A normal run shows one
 * plain line per stage (its count and timing) and a line for anything that
 * failed; which items are running and the per-item detail appear only under
 * `--verbose`.
 */
export function startStageProgress(
  out: Writable,
  label: string,
  o: CommandProgressOptions = {},
): StageProgressSink {
  const sink = startScreenProgress(out, label, o);
  if (o.verbose) return { ...sink, detail: (line) => sink.note(line) };
  return {
    start: sink.start,
    item: sink.item,
    note: sink.note,
    detail: () => {},
    end: sink.end,
  };
}
