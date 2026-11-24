import { describe, expect, it } from "vitest";
import { MergeQueueEntrySchema } from "../index.js";

describe("Track 5 [B12.2] Refinery merge queue protocol contracts", () => {
  it("validates MergeQueueEntry fields and state enum", () => {
    const merging = MergeQueueEntrySchema.parse({
      task_id: "t-slice-1",
      space: "kiln",
      title: "Slice 1",
      state: "merging",
      position: 1,
      priority: "P1",
    });
    expect(merging.state).toBe("merging");
    expect(merging.position).toBe(1);

    const queued = MergeQueueEntrySchema.parse({
      task_id: "t-slice-2",
      space: "kiln",
      title: "Slice 2",
      state: "queued",
      position: 2,
      priority: "P2",
    });
    expect(queued.state).toBe("queued");

    expect(() =>
      MergeQueueEntrySchema.parse({
        task_id: "t-bad",
        space: "kiln",
        title: "Bad",
        state: "running",
        position: 0,
        priority: "P2",
      }),
    ).toThrow();
  });
});
