import { AUDIO_LANE_BLOCK_FRAMES, AUDIO_SAMPLE_RATE, type AudioFrame } from "./audioWire";
export interface JitterDecision { scheduleAt: number; dropped: number; reanchored: boolean; }
export class LaneJitterBuffer {
  private anchorDueUs: number | null = null;
  private anchorContext = 0;
  private nextIndex: number | null = null;
  private readonly blockSec = AUDIO_LANE_BLOCK_FRAMES / AUDIO_SAMPLE_RATE;
  constructor(private readonly targetMs = 60) {}
  /**
   * Numeric-µs core: no bigint, so an AudioWorkletProcessor (which gets `SinkLaneBlock.dueUs` as a plain
   * number off the wire, see audioSinkProtocol.ts) can run the same jitter logic as `accept` below.
   */
  acceptAtUs(blockIndex: number, dueUs: number, contextNow: number): JitterDecision {
    const target = contextNow + this.targetMs / 1000;
    let reanchored = false, dropped = 0;
    if (this.anchorDueUs === null || this.nextIndex === null || blockIndex < this.nextIndex || blockIndex - this.nextIndex > 32) {
      this.anchorDueUs = dueUs; this.anchorContext = target; this.nextIndex = blockIndex; reanchored = true;
    }
    let scheduleAt = this.anchorContext + (dueUs - this.anchorDueUs!) / 1e6;
    if (scheduleAt < contextNow - 0.005) {
      dropped = Math.max(0, blockIndex - this.nextIndex!);
      this.anchorDueUs = dueUs; this.anchorContext = target; this.nextIndex = blockIndex;
      scheduleAt = target; reanchored = true;
    }
    if (Math.abs(scheduleAt - target) > 0.015) { this.anchorDueUs = dueUs; this.anchorContext = target; scheduleAt = target; reanchored = true; }
    this.nextIndex = blockIndex + 1;
    return { scheduleAt: Math.max(contextNow, scheduleAt), dropped, reanchored };
  }
  /** Existing bigint-framed API, kept byte-for-byte compatible for current callers/tests. */
  accept(frame: AudioFrame, contextNow: number): JitterDecision {
    return this.acceptAtUs(frame.blockIndex, Number(frame.dueUs), contextNow);
  }
  reset(): void { this.anchorDueUs = null; this.nextIndex = null; }
}
