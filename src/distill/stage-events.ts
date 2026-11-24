import type { Writable } from "node:stream";
import {
  type StageProgressOptions,
  startStageProgress as startScreenProgress,
} from "../ui/screen.js";
import type { Digest } from "./schemas.js";

/** The project and findings shown when a validated session read reaches its checkpoint. */
export interface SavedSessionRead {
  project: string;
  goal: string;
  outcome: Digest["outcome"];
  preference?: string;
}

export interface StageItem {
  status: "done" | "skipped" | "failed" | "blocked";
  line: string;
  /** Matches the id supplied when this item began. Cached items can finish immediately. */
  id?: string;
  /** Only present once the session read is available in the published checkpoint. */
  read?: SavedSessionRead;
}

export interface StageProgressSink {
  start(total: number, concurrency: number): void;
  running?(id: string, label?: string, project?: string): void;
  item(event: StageItem): void;
  /** A line the person should read whatever the mode: a reason, a stop, a warning. */
  note(line: string): void;
  /** Per-item or per-call detail, shown only under `--verbose`. */
  detail?(line: string): void;
  /** Available read results in the selected batch, including untouched reusable checkpoints. */
  savedReads?(): number;
  end(): void;
}

export interface CommandProgressOptions extends StageProgressOptions {
  /** Also show technical item labels and per-call detail lines. */
  verbose?: boolean;
}

/**
 * Project activity and saved reads belong to the ordinary reflection view.
 * Technical labels for other stages and diagnostic notes are opt-in.
 */
export function startStageProgress(
  out: Writable,
  label: string,
  o: CommandProgressOptions = {},
): StageProgressSink {
  const sink = startScreenProgress(out, label, o);
  return {
    ...sink,
    running(id, label, project) {
      if (project !== undefined || o.verbose) sink.running?.(id, label, project);
      if (o.verbose && project !== undefined && label) sink.note(`  Reading ${label}`);
    },
    detail(line) {
      if (o.verbose) sink.note(line);
    },
  };
}
