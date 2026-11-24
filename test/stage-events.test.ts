/** The sink of a stage that runs beside another one (`heldProgress`). */
import { describe, expect, it } from "vitest";
import { heldProgress, type StageProgressSink } from "../src/distill/stage-events.js";

/** A display that records what it is given, in order. */
function recorder(): StageProgressSink & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    start: (total, concurrency) => seen.push(`start ${total} ${concurrency}`),
    running: (id) => seen.push(`running ${id}`),
    item: (event) => seen.push(`${event.status} ${event.line}`),
    note: (line) => seen.push(`note ${line}`),
    detail: (line) => seen.push(`detail ${line}`),
    end: () => seen.push("end"),
  };
}

describe("heldProgress", () => {
  it("holds what a stage reports, then passes it on in order once a display is shown", () => {
    const held = heldProgress();
    held.start(3, 10);
    held.item({ id: "a", status: "done", line: "batch 1" });
    held.note("a reason to read");
    held.item({ id: "b", status: "failed", line: "batch 2" });
    const display = recorder();
    held.show(display);
    expect(display.seen).toEqual([
      "start 3 10",
      "done batch 1",
      "failed batch 2",
      "note a reason to read",
    ]);
    // From here on the stage reports straight to the display.
    held.running?.("c");
    held.item({ id: "c", status: "done", line: "batch 3" });
    held.detail?.("per call");
    held.end();
    expect(display.seen.slice(4)).toEqual(["running c", "done batch 3", "detail per call", "end"]);
    expect(held.unseen()).toEqual([]);
  });

  it("a stage that ends unseen leaves its notes, and nothing is written anywhere", () => {
    const held = heldProgress();
    held.start(1, 1);
    held.item({ id: "a", status: "failed", line: "batch 1" });
    held.note("stopped after a failure");
    held.end();
    expect(held.unseen()).toEqual(["stopped after a failure"]);
  });
});
