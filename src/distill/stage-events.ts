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

/** A progress sink that can be given its display after the stage has started. */
export interface HeldProgress extends StageProgressSink {
  /** Show the stage from here on: what it reported so far is passed on first. */
  show(display: StageProgressSink): void;
  /** Notes the stage reported while it had no display. */
  unseen(): string[];
}

/**
 * The sink of a stage that runs beside another one. Only one stage owns the
 * progress display at a time, so this one holds what it reports until `show`
 * hands it a display. A stage that ends unseen leaves its notes to be printed.
 */
export function heldProgress(): HeldProgress {
  let display: StageProgressSink | undefined;
  let started: [total: number, concurrency: number] | undefined;
  const items: StageItem[] = [];
  const notes: string[] = [];
  return {
    start(total, concurrency) {
      started = [total, concurrency];
      display?.start(total, concurrency);
    },
    running(id, label, project) {
      display?.running?.(id, label, project);
    },
    item(event) {
      if (display) display.item(event);
      else items.push(event);
    },
    note(line) {
      if (display) display.note(line);
      else notes.push(line);
    },
    detail(line) {
      display?.detail?.(line);
    },
    end() {
      display?.end();
    },
    show(next) {
      display = next;
      if (started) next.start(...started);
      for (const event of items.splice(0)) next.item(event);
      for (const line of notes.splice(0)) next.note(line);
    },
    unseen: () => notes,
  };
}
