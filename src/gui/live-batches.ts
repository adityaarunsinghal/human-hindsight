import type { Lesson } from "../core/subagents.js";

export interface LiveAgreements {
  status: "running" | "interrupted";
  completedBatches: number;
  totalBatches: number;
  lessons: Lesson[];
}

export type BatchUpdate =
  | { kind: "begin"; total: number }
  | { kind: "batch"; index: number; lessons: Omit<Lesson, "id">[] }
  | { kind: "interrupted" | "complete" };

/** One worker has one parent reflection. Its private IPC stream is the only input. */
export class LiveBatches {
  revision = 0;
  private total = 0;
  private status: LiveAgreements["status"] = "running";
  private batches = new Map<number, Omit<Lesson, "id">[]>();

  update(event: BatchUpdate): void {
    if (event.kind === "begin") {
      this.total = event.total;
      this.status = "running";
      this.batches.clear();
    } else if (!this.total) return;
    else if (event.kind === "batch") this.batches.set(event.index, event.lessons);
    else if (event.kind === "complete") {
      this.total = 0;
      this.batches.clear();
    } else this.status = "interrupted";
    this.revision++;
  }

  snapshot(): LiveAgreements | undefined {
    if (!this.total) return undefined;
    return {
      status: this.status,
      completedBatches: this.batches.size,
      totalBatches: this.total,
      lessons: [...this.batches]
        .sort(([a], [b]) => a - b)
        .flatMap(([batch, lessons]) =>
          lessons.map((lesson, i) => ({ ...lesson, id: `live-${batch + 1}-${i + 1}` })),
        ),
    };
  }
}
