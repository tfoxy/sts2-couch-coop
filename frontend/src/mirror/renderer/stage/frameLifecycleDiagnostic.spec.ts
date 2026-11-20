import { describe, expect, it, vi } from "vitest";
import { createFrameLifecycleDiagnostic } from "./frameLifecycleDiagnostic";

describe("frame lifecycle diagnostic", () => {
  it("keeps offered and completed draws distinct from displayed presentations", () => {
    let time = 0;
    const mark = vi.spyOn(performance, "mark").mockImplementation(() => ({}) as PerformanceMark);
    const diagnostic = createFrameLifecycleDiagnostic(() => time);
    for (let i = 0; i < 15; i++) { diagnostic.begin("animation", i, i); diagnostic.finish("skipped", i); }
    time = 20;
    diagnostic.begin("animation", 16, 10);
    time = 21;
    diagnostic.admit();
    diagnostic.phase("sample", () => { time = 23; });
    time = 25;
    diagnostic.finish("completed", 11);
    expect(diagnostic.report().rows).toEqual([expect.objectContaining({
      id: 16, offeredAt: 20, admittedAt: 21, completedAt: 25, displayedAt: null,
      completedDrawsBefore: 10, completedDrawsAfter: 11, outcome: "completed",
      phaseMs: { sample: 2 },
    })]);
    expect(mark).toHaveBeenCalledWith("mirror-frame:16:completed");
    mark.mockRestore();
  });
});
