import { describe, expect, it } from "vitest";
import { isSinkCommand, isStaleEpoch, sinkCommandTransferables, type SinkCommand } from "../audioSinkProtocol";

describe("audioSinkProtocol guards and helpers", () => {
  it("isSinkCommand accepts every SinkCommand kind and rejects lookalikes", () => {
    const fence: SinkCommand = { kind: "fence", epoch: 1 };
    expect(isSinkCommand(fence)).toBe(true);
    expect(isSinkCommand({ kind: "lane-gains", epoch: 1, music: 1, ambience: 1, loops: 1 })).toBe(true);
    expect(isSinkCommand({ kind: "ready" })).toBe(false);
    expect(isSinkCommand({ kind: "diag", events: [] })).toBe(false);
    expect(isSinkCommand(null)).toBe(false);
    expect(isSinkCommand("fence")).toBe(false);
    expect(isSinkCommand({})).toBe(false);
  });

  it("isStaleEpoch drops anything older than the newest epoch seen", () => {
    expect(isStaleEpoch(1, 2)).toBe(true);
    expect(isStaleEpoch(2, 2)).toBe(false);
    expect(isStaleEpoch(3, 2)).toBe(false);
  });

  it("sinkCommandTransferables collects the underlying buffers for load/take-block/lane-blocks, deduped", () => {
    const pcm = { format: "f32-planar" as const, channels: [new Float32Array(4), new Float32Array(4)], frames: 4 };
    const load: SinkCommand = { kind: "load", epoch: 1, key: "k", pcm, rate: 48_000 };
    expect(sinkCommandTransferables(load)).toEqual([pcm.channels[0].buffer, pcm.channels[1].buffer]);

    const interleaved = new Int16Array(8);
    const takeBlock: SinkCommand = {
      kind: "take-block", epoch: 1, streamId: 7, blockIndex: 0, flags: 0,
      pcm: { format: "s16", interleaved, channels: 2, frames: 4 }, postMs: 0
    };
    expect(sinkCommandTransferables(takeBlock)).toEqual([interleaved.buffer]);

    const sharedBuffer = new Float32Array(4);
    const laneBlocks: SinkCommand = {
      kind: "lane-blocks", epoch: 1, postMs: 0,
      blocks: [
        { lane: 1, streamId: 1, blockIndex: 0, dueUs: 0, flags: 0, pcm: { format: "f32-planar", channels: [sharedBuffer], frames: 4 } },
        { lane: 1, streamId: 1, blockIndex: 1, dueUs: 1, flags: 0, pcm: { format: "f32-planar", channels: [sharedBuffer], frames: 4 } }
      ]
    };
    expect(sinkCommandTransferables(laneBlocks)).toEqual([sharedBuffer.buffer]);

    const fence: SinkCommand = { kind: "fence", epoch: 1 };
    expect(sinkCommandTransferables(fence)).toEqual([]);
  });
});
