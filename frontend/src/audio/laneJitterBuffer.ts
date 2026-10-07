import { AUDIO_LANE_BLOCK_FRAMES, AUDIO_SAMPLE_RATE, type AudioFrame } from "./audioWire";
export interface JitterDecision { scheduleAt: number; dropped: number; reanchored: boolean; }
export class LaneJitterBuffer {
  private anchorDue: bigint | null = null;
  private anchorContext = 0;
  private nextIndex: number | null = null;
  private readonly blockSec = AUDIO_LANE_BLOCK_FRAMES / AUDIO_SAMPLE_RATE;
  constructor(private readonly targetMs = 60) {}
  accept(frame: AudioFrame, contextNow: number): JitterDecision {
    const target = contextNow + this.targetMs / 1000;
    const dueSec = Number(frame.dueUs) / 1e6;
    let reanchored = false, dropped = 0;
    if (this.anchorDue === null || this.nextIndex === null || frame.blockIndex < this.nextIndex || frame.blockIndex - this.nextIndex > 32) {
      this.anchorDue = frame.dueUs; this.anchorContext = target; this.nextIndex = frame.blockIndex; reanchored = true;
    }
    let scheduleAt = this.anchorContext + Number(frame.dueUs - this.anchorDue!) / 1e6;
    if (scheduleAt < contextNow - 0.005) {
      dropped = Math.max(0, frame.blockIndex - this.nextIndex!);
      this.anchorDue = frame.dueUs; this.anchorContext = target; this.nextIndex = frame.blockIndex;
      scheduleAt = target; reanchored = true;
    }
    if (Math.abs(scheduleAt - target) > 0.015) { this.anchorDue = frame.dueUs; this.anchorContext = target; scheduleAt = target; reanchored = true; }
    this.nextIndex = frame.blockIndex + 1;
    return { scheduleAt: Math.max(contextNow, scheduleAt), dropped, reanchored };
  }
  reset(): void { this.anchorDue = null; this.nextIndex = null; }
}
