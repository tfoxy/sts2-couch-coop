import type { AudioContextLike } from "./audioUnlock";
import type { AudioFrame } from "./audioWire";
import { AUDIO_SAMPLE_RATE } from "./audioWire";
import { LaneJitterBuffer, type JitterDecision } from "./laneJitterBuffer";

export class StreamVoice {
  private readonly jitter = new LaneJitterBuffer(60);
  private readonly sources = new Set<AudioBufferSourceNode>();
  private hasScheduled = false;
  constructor(private readonly context: AudioContextLike, private readonly gain: GainNode,
    private readonly onActivity?: () => void,
    private readonly onScheduled?: (frame: AudioFrame, decision: JitterDecision, start: number) => void) {}
  push(frame: AudioFrame): void {
    const decision = this.jitter.accept(frame, this.context.currentTime);
    const start = Math.max(this.context.currentTime, decision.scheduleAt);
    const buffer = this.context.createBuffer(2, frame.frames, AUDIO_SAMPLE_RATE);
    const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
    for (let i = 0; i < frame.frames; i++) { left[i] = frame.pcm[i * 2] / 32768; right[i] = frame.pcm[i * 2 + 1] / 32768; }
    const source = this.context.createBufferSource(); source.buffer = buffer;
    const blockGain = this.context.createGain();
    if (decision.dropped > 0 || (decision.reanchored && this.hasScheduled)) {
      blockGain.gain.setValueAtTime(0, start);
      blockGain.gain.linearRampToValueAtTime(1, start + 0.005);
      source.disconnect(); source.connect(blockGain); blockGain.connect(this.gain);
    } else source.connect(this.gain);
    this.sources.add(source); this.onActivity?.();
    this.hasScheduled = true;
    source.onended = () => { this.sources.delete(source); source.disconnect(); blockGain.disconnect(); this.onActivity?.(); };
    source.start(start);
    this.onScheduled?.(frame, decision, start);
  }
  stop(): void { for (const source of this.sources) { try { source.stop(); } catch { /* already ended */ } source.disconnect(); } this.sources.clear(); this.jitter.reset(); this.hasScheduled = false; this.onActivity?.(); }
  activeCount(): number { return this.sources.size; }
}
