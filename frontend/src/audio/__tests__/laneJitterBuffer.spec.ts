import { describe, expect, it } from "vitest";
import { LaneJitterBuffer } from "../laneJitterBuffer";

describe("LaneJitterBuffer numeric-us core", () => {
  it("acceptAtUs agrees with the bigint-framed accept() given the same values", () => {
    const viaBigint = new LaneJitterBuffer();
    const viaNumeric = new LaneJitterBuffer();
    const frame = (blockIndex: number, dueUs: bigint) =>
      ({ blockIndex, dueUs, frames: 512, pcm: new Int16Array(1024), kind: 2 as const, lane: 1 as const, streamId: 1, flags: 0, sentUs: dueUs });
    const cases: Array<[number, bigint, number]> = [
      [0, 1_000_000n, 10], [1, 1_010_667n, 10.0107], [8, 1_200_000n, 10.3], [9, 1_210_667n, 10.3107]
    ];
    for (const [blockIndex, dueUs, now] of cases) {
      const a = viaBigint.accept(frame(blockIndex, dueUs), now);
      const b = viaNumeric.acceptAtUs(blockIndex, Number(dueUs), now);
      expect(b.scheduleAt).toBeCloseTo(a.scheduleAt);
      expect(b.dropped).toBe(a.dropped);
      expect(b.reanchored).toBe(a.reanchored);
    }
  });

  it("reanchors a late lane and recovers to the target within two blocks, without bigint", () => {
    const jitter = new LaneJitterBuffer();
    const first = jitter.acceptAtUs(0, 1_000_000, 10);
    expect(first.scheduleAt).toBeCloseTo(10.06);
    const normal = jitter.acceptAtUs(1, 1_010_667, 10.0107);
    expect(normal.reanchored).toBe(false);
    const late = jitter.acceptAtUs(8, 1_200_000, 10.3);
    expect(late.reanchored).toBe(true);
    expect(late.scheduleAt).toBeCloseTo(10.36);
    const recovered = jitter.acceptAtUs(9, 1_210_667, 10.3107);
    expect(recovered.scheduleAt).toBeCloseTo(10.3707);
    expect(recovered.reanchored).toBe(false);
  });

  it("reanchors when a block index jumps far ahead", () => {
    const jitter = new LaneJitterBuffer(60);
    jitter.acceptAtUs(0, 1_000_000, 10);
    const jumped = jitter.acceptAtUs(40, 5_000_000, 10.4);
    expect(jumped.reanchored).toBe(true);
    expect(jumped.scheduleAt).toBeCloseTo(10.46);
  });

  it("reset() forces the next block to reanchor", () => {
    const jitter = new LaneJitterBuffer(60);
    jitter.acceptAtUs(0, 1_000_000, 10);
    jitter.reset();
    const after = jitter.acceptAtUs(0, 1_000_000, 20);
    expect(after.reanchored).toBe(true);
    expect(after.scheduleAt).toBeCloseTo(20.06);
  });
});
