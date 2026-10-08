// The AudioWorklet mixer's DOM-free core (WP-B). `mixer.worklet.ts` wraps it in an AudioWorkletProcessor;
// the tests drive it directly with Float32Array outputs.
//
// It reproduces, sample-accurately, what `audioEngine.ts` builds out of WebAudio nodes on the main thread:
//
//   * one-shot cues (`play`)  ~ playBuffer: one AudioBufferSourceNode + GainNode per cue, started "now".
//   * take streams            ~ playTakeFrame: per-block sources chained back to back on a per-stream GainNode.
//   * lanes                   ~ StreamVoice + LaneJitterBuffer(60) on a per-lane bus GainNode.
//   * voice cap               ~ VoiceCap(4): per key, the oldest in-cap voice is stopped with a 10 ms fade.
//   * keep-alive              ~ keepAlive.ts' 1e-5 ConstantSourceNode while nothing is playing.
//
// TIME. Commands are handled between render quanta. "Now" for a command is `frameNow`, the first frame of
// the NEXT quantum to render (what `AudioContext.currentTime` reads on the main thread between quanta), so
// a `play` starts on the first frame of the next quantum: start latency <= 1 quantum. Scheduled starts are
// fractional frames; a source starting between two frames gets a sub-sample read offset, as an
// AudioBufferSourceNode does.
//
// ALLOCATION. `render()` allocates nothing: every voice, segment and gain buffer is preallocated, hot state
// lives in fields of those objects, and iteration is over index lists. The command path (`handle`) may
// allocate (it is called from a message handler, never from `process()`).
//
// EPOCHS. A command whose epoch is older than the newest seen is dropped (`isStaleEpoch`). A command whose
// epoch is NEWER than the newest seen acts as an implicit fence first: the worker's port and the main
// thread's `node.port` are separate channels with no ordering between them, so a new-epoch cue may arrive
// before the matching `fence` — it must neither be dropped nor allowed to coexist with old-epoch audio.
// Likewise `fence {epoch}` stops what is OLDER than its epoch rather than everything: the facade bumps the
// epoch and then fences, so in MainSink's single ordered channel "stop everything" and "stop older" are the
// same set; across the worklet's two channels only "stop older" spares a new-epoch cue that won the race.
import { AUDIO_SAMPLE_RATE, AudioFlags } from "./audioWire";
import { LaneJitterBuffer } from "./laneJitterBuffer";
import { isSinkCommand, isStaleEpoch, SINK_DIAG_SOURCE_PATH, type AudioDiagEventWire, type AudioDiagPayload, type SinkCommand,
  type SinkLaneBlock, type SinkPcm } from "./audioSinkProtocol";

export const MIXER_QUANTUM = 128;
export const MIXER_MAX_VOICES = 64;
export const MIXER_VOICES_PER_KEY = 4;
export const MIXER_MAX_SEGMENTS = 512;
/** VoiceCap's eviction fade (voiceCap.ts `stop(10)`), applied as setTargetAtTime(0, now, fadeMs/3000) + stop(now + fadeMs). */
export const MIXER_CAP_FADE_MS = 10;
/** playTakeFrame: blocks never start sooner than now + 5 ms. */
export const MIXER_TAKE_LEAD_S = 0.005;
/** playTakeFrame: a block whose predecessor ended before now + 1 ms is an underrun and fades in. */
export const MIXER_TAKE_UNDERRUN_S = 0.001;
/** Fade-in ramp after a take underrun or a lane drop/re-anchor (linearRampToValueAtTime over 5 ms). */
export const MIXER_RAMP_S = 0.005;
export const MIXER_LANE_TARGET_MS = 60;
/** updateLaneGains: setTargetAtTime(gain, now, 0.015). */
export const MIXER_LANE_GAIN_TAU_S = 0.015;
export const MIXER_KEEP_ALIVE_DC = 1e-5;
export const MIXER_DIAG_FLUSH_S = 0.1;
export const MIXER_DIAG_CAPACITY = 512;
/** Lane numbers as audioWire.ts' `AudioLane` assigns them, and the `lane-gains` bus each one rides. */
export const MIXER_LANE_BUS = { 1: "music", 2: "ambience", 3: "loops" } as const;

const INV_S16 = 1 / 32768;
const KIND_FREE = 0, KIND_VOICE = 1, KIND_TAKE = 2, KIND_LANE = 3;
const LANE_COUNT = 3;

/** A one-shot's playbackRate (playBuffer / MainSink): clamped to [0.25, 4], non-finite -> 1. */
export function clampPitch(pitch: number): number {
  return Number.isFinite(pitch) ? Math.max(0.25, Math.min(4, pitch)) : 1;
}

/**
 * A take stream's playbackRate: the RAW pitch, unclamped, as playTakeFrame / MainSink use it. Only a value
 * no AudioBufferSourceNode could play forward (non-finite, <= 0) becomes 1, so `nextAt` stays finite.
 */
export function takePitch(pitch: number): number {
  return Number.isFinite(pitch) && pitch > 0 ? pitch : 1;
}

/** Fractional frame for a context time, snapped to the integer when float noise is all that separates them. */
function frameAt(seconds: number, sampleRate: number): number {
  const frame = seconds * sampleRate;
  const rounded = Math.round(frame);
  return Math.abs(frame - rounded) < 1e-6 ? rounded : frame;
}

/** PCM a segment reads: interleaved s16 (stride `ch`) or planar f32 (`f32R` aliases `f32L` for mono). */
class PcmView {
  i16: Int16Array | null = null;
  f32L: Float32Array | null = null;
  f32R: Float32Array | null = null;
  ch = 2;
  frames = 0;
  /** Binds `pcm`; false when it carries no playable frames. */
  bind(pcm: SinkPcm): boolean {
    if (pcm.format === "s16") {
      const ch = pcm.channels | 0;
      if (ch < 1) return false;
      const frames = Math.min(pcm.frames | 0, Math.floor(pcm.interleaved.length / ch));
      if (frames <= 0) return false;
      this.i16 = pcm.interleaved; this.f32L = this.f32R = null; this.ch = ch; this.frames = frames;
      return true;
    }
    if (pcm.format === "f32-planar") {
      const left = pcm.channels[0];
      if (!left) return false;
      const right = pcm.channels[1] ?? left;
      const frames = Math.min(pcm.frames | 0, left.length, right.length);
      if (frames <= 0) return false;
      this.i16 = null; this.f32L = left; this.f32R = right; this.ch = pcm.channels.length; this.frames = frames;
      return true;
    }
    return false;
  }
  copyFrom(other: PcmView): void {
    this.i16 = other.i16; this.f32L = other.f32L; this.f32R = other.f32R; this.ch = other.ch; this.frames = other.frames;
  }
  clear(): void { this.i16 = null; this.f32L = this.f32R = null; this.frames = 0; }
}

interface StoredTake { pcm: PcmView; rate: number; }

/** One playing buffer — the analogue of one AudioBufferSourceNode. */
class Segment extends PcmView {
  active = false;
  strip = -1;
  /** Source frames advanced per output frame: sourceRate / contextRate x pitch. */
  step = 1;
  /** Requested start, in (fractional) output frames. */
  startFrame = 0;
  started = false;
  /** Effective start (ramp origin), in output frames. */
  t0 = 0;
  pos = 0;
  /** Linear fade-in length in output frames, 0 for none. */
  rampFrames = 0;
}

/** A gain stage — the analogue of the per-cue / per-stream / per-lane GainNode. */
class Strip {
  kind = KIND_FREE;
  epoch = 0;
  key = "";
  seq = 0;
  inCap = false;
  gain = 1;
  pitch = 1;
  fading = false;
  fadeStart = 0;
  stopFrame = Number.POSITIVE_INFINITY;
  env = 1;
  fadeK = 1;
  segCount = 0;
  // take stream
  streamId = -1;
  nextAt = 0;
  finished = false;
  stopped = false;
  // lane
  lane = 0;
  hasScheduled = false;
  readonly buf = new Float32Array(MIXER_QUANTUM);
  constructor(readonly index: number) {}
}

/** Preallocated diagnostic row; only the fields its `type` uses are emitted. */
class DiagSlot {
  seq = 0;
  type = "";
  contextTime = 0.5;
  kind = "";
  key = "";
  sourcePath = "";
  epoch = 0.5;
  postMs = 0.5;
  scheduledContextTime = 0.5;
  lane = 0.5;
  streamId = 0.5;
  blockIndex = 0.5;
  dueUs = 0.5;
  dropped = 0.5;
  reanchored = false;
  gain = 0.5;
  pitch = 0.5;
  frames = 0.5;
  seatTUs = "";
  order = 0.5;
  seatConnId = 0.5;
}

export interface MixerCoreOptions {
  sampleRate: number;
  /** Record worklet-receipt / source-scheduled rows. Off = zero diagnostic cost. */
  diag?: boolean;
  /** The context frame the first quantum will render (the worklet passes the global `currentFrame`). */
  startFrame?: number;
}

export interface MixerStats {
  /** Voices counted by the cap (VoiceCap.count()): in-cap one-shots + take streams. */
  capVoices: number;
  /** Live one-shot + take-stream voices, including ones fading out after eviction/fence. */
  voices: number;
  takeStreams: number;
  /** Lanes that exist (created by a block, not yet Silent/stopped/fenced). */
  lanes: number;
  /** Lane segments scheduled or playing (StreamVoice.activeCount summed). */
  laneSegments: number;
  segments: number;
  /** Whether the last rendered quantum carried the keep-alive DC. */
  keepAlive: boolean;
  droppedSegments: number;
  staleCommands: number;
  missingTakes: number;
}

export class MixerCore {
  readonly sampleRate: number;
  private readonly diagOn: boolean;
  private frameNow: number;
  private newestEpoch = Number.NEGATIVE_INFINITY;
  private seqCounter = 0;

  private readonly takes = new Map<string, StoredTake>();
  private readonly strips: Strip[] = [];
  private readonly laneStrips: Strip[] = [];
  private readonly jitter: LaneJitterBuffer[] = [];
  private readonly busTarget = new Float64Array(LANE_COUNT).fill(1);
  private readonly busCur = new Float64Array(LANE_COUNT).fill(1);
  private readonly busAlpha: number;
  private readonly takeByStream = new Map<number, number>();

  private readonly segments: Segment[] = [];
  private readonly freeSeg = new Int32Array(MIXER_MAX_SEGMENTS);
  private freeSegCount = 0;
  private readonly activeSeg = new Int32Array(MIXER_MAX_SEGMENTS);
  private activeSegCount = 0;

  private capCount = 0;
  private laneSegCount = 0;
  private lastKeepAlive = false;
  private droppedSegments = 0;
  private staleCommands = 0;
  private missingTakes = 0;

  private readonly rampFrames: number;
  private readonly capFadeFrames: number;
  private readonly capFadeK: number;

  private readonly diagRing: DiagSlot[] = [];
  private diagHead = 0;
  private diagCount = 0;
  private diagSeq = 0;
  private diagLost = 0;
  private diagFramesSinceFlush = 0;
  private readonly diagFlushFrames: number;

  constructor(options: MixerCoreOptions) {
    this.sampleRate = options.sampleRate;
    this.diagOn = !!options.diag;
    this.frameNow = options.startFrame ?? 0;
    for (let i = 0; i < MIXER_MAX_VOICES; i++) this.strips.push(new Strip(i));
    for (let l = 0; l < LANE_COUNT; l++) {
      const strip = new Strip(MIXER_MAX_VOICES + l);
      strip.lane = l + 1;
      this.strips.push(strip); this.laneStrips.push(strip);
      this.jitter.push(new LaneJitterBuffer(MIXER_LANE_TARGET_MS));
    }
    for (let i = 0; i < MIXER_MAX_SEGMENTS; i++) {
      this.segments.push(new Segment());
      this.freeSeg[i] = MIXER_MAX_SEGMENTS - 1 - i;
    }
    this.freeSegCount = MIXER_MAX_SEGMENTS;
    this.busAlpha = 1 - Math.exp(-1 / (MIXER_LANE_GAIN_TAU_S * this.sampleRate));
    this.rampFrames = MIXER_RAMP_S * this.sampleRate;
    this.capFadeFrames = Math.round(MIXER_CAP_FADE_MS / 1000 * this.sampleRate);
    this.capFadeK = Math.exp(-1 / (MIXER_CAP_FADE_MS / 3000 * this.sampleRate));
    this.diagFlushFrames = MIXER_DIAG_FLUSH_S * this.sampleRate;
    if (this.diagOn) for (let i = 0; i < MIXER_DIAG_CAPACITY; i++) this.diagRing.push(new DiagSlot());
  }

  /** Context time of the next quantum to render — what `audioEngine.ts` reads as `context.currentTime`. */
  get contextNow(): number { return this.frameNow / this.sampleRate; }

  // ---------------------------------------------------------------------------------------------------
  // Command path (message handler; may allocate).
  // ---------------------------------------------------------------------------------------------------

  handle(raw: unknown): void {
    if (!isSinkCommand(raw)) return;
    const cmd: SinkCommand = raw;
    // A `load` is never stale: takes survive fences, and the worker counts a posted load as resident.
    if (!Number.isFinite(cmd.epoch) || (cmd.kind !== "load" && isStaleEpoch(cmd.epoch, this.newestEpoch))) {
      this.staleCommands++; return;
    }
    if (cmd.epoch > this.newestEpoch) {
      this.fenceOlderThan(cmd.epoch);
      this.newestEpoch = cmd.epoch;
    }
    if (this.diagOn) this.recordReceipt(cmd);
    switch (cmd.kind) {
      case "load": this.load(cmd.key, cmd.pcm, cmd.rate); break;
      case "play": this.play(cmd); break;
      case "take-start": this.takeStart(cmd); break;
      case "take-block": this.takeBlock(cmd); break;
      case "lane-blocks": for (let i = 0; i < cmd.blocks.length; i++) this.laneBlock(cmd.blocks[i], cmd.epoch); break;
      case "lane-gains": this.laneGains(cmd.music, cmd.ambience, cmd.loops); break;
      case "lane-stop": { const strip = this.laneStrip(cmd.lane); if (strip) this.stopLane(strip); break; }
      case "fence": break; // the epoch bump above did the work
    }
  }

  hasTake(key: string): boolean { return this.takes.has(key); }

  private load(key: string, pcm: SinkPcm, rate: number): void {
    const view = new PcmView();
    if (!view.bind(pcm) || !(rate > 0)) return;
    this.takes.set(key, { pcm: view, rate });
  }

  private play(cmd: Extract<SinkCommand, { kind: "play" }>): void {
    if (!(cmd.gain > 0)) return; // playBuffer: `gainValue <= 0` never starts a voice
    const take = this.takes.get(cmd.key);
    if (!take) { this.missingTakes++; this.recordMiss(cmd.key, cmd.epoch); return; }
    const segIndex = this.allocSegment();
    if (segIndex < 0) return;
    const strip = this.allocVoiceStrip();
    strip.kind = KIND_VOICE; strip.epoch = cmd.epoch; strip.key = cmd.key; strip.gain = cmd.gain;
    strip.pitch = clampPitch(cmd.pitch);
    this.capAdd(strip);
    const seg = this.segments[segIndex];
    seg.copyFrom(take.pcm);
    seg.step = take.rate / this.sampleRate * strip.pitch;
    seg.startFrame = this.frameNow; seg.rampFrames = 0;
    this.attachSegment(segIndex, strip);
    if (this.diagOn) this.recordScheduled("source-scheduled", cmd.key,
      cmd.diagSourcePath ?? SINK_DIAG_SOURCE_PATH[cmd.sourcePath] ?? cmd.sourcePath, seg.startFrame, cmd.epoch,
      -1, -1, -1, Number.NaN, 0, false, cmd.gain, cmd.pitch, seg.frames, cmd.seatTUs, cmd.order, cmd.seatConnId);
  }

  private takeStart(cmd: Extract<SinkCommand, { kind: "take-start" }>): void {
    const existing = this.takeStrip(cmd.streamId);
    if (existing) this.freeStrip(existing);
    if (!(cmd.gain > 0)) return;
    const strip = this.allocVoiceStrip();
    strip.kind = KIND_TAKE; strip.epoch = cmd.epoch; strip.key = cmd.key; strip.gain = cmd.gain;
    strip.pitch = takePitch(cmd.pitch); strip.streamId = cmd.streamId;
    strip.nextAt = this.contextNow + MIXER_TAKE_LEAD_S; strip.finished = false; strip.stopped = false;
    this.capAdd(strip);
    if (this.takeByStream.size > 4 * MIXER_MAX_VOICES) this.sweepTakeMap();
    this.takeByStream.set(cmd.streamId, strip.index);
    if (this.diagOn) this.takeDiag.set(cmd.streamId, { seatTUs: cmd.seatTUs, order: cmd.order, seatConnId: cmd.seatConnId });
  }

  /** Correlation ids for a stream's per-block `source-scheduled` rows (diagnostics only). */
  private readonly takeDiag = new Map<number, { seatTUs?: string; order?: number; seatConnId?: number }>();

  private takeBlock(cmd: Extract<SinkCommand, { kind: "take-block" }>): void {
    const strip = this.takeStrip(cmd.streamId);
    if (!strip || strip.stopped) return;
    const now = this.contextNow;
    const startAt = Math.max(now + MIXER_TAKE_LEAD_S, strip.nextAt);
    const fadeIn = strip.nextAt < now + MIXER_TAKE_UNDERRUN_S;
    const segIndex = this.allocSegment();
    let frames = 0;
    if (segIndex >= 0) {
      const seg = this.segments[segIndex];
      if (seg.bind(cmd.pcm)) {
        frames = seg.frames;
        seg.step = AUDIO_SAMPLE_RATE / this.sampleRate * strip.pitch;
        seg.startFrame = frameAt(startAt, this.sampleRate);
        seg.rampFrames = fadeIn ? this.rampFrames : 0;
        this.attachSegment(segIndex, strip);
      } else this.releaseSegment(segIndex);
    } else {
      frames = cmd.pcm.frames;
    }
    strip.nextAt = startAt + frames / (AUDIO_SAMPLE_RATE * strip.pitch);
    if (cmd.flags & AudioFlags.Last) { strip.finished = true; }
    if (this.diagOn) {
      const ids = this.takeDiag.get(cmd.streamId);
      this.recordScheduled("source-scheduled", strip.key, "first-sight-stream", frameAt(startAt, this.sampleRate), cmd.epoch,
        -1, cmd.streamId, cmd.blockIndex, Number.NaN, 0, fadeIn, strip.gain, strip.pitch, frames,
        ids?.seatTUs, ids?.order, ids?.seatConnId);
      if (strip.finished) this.takeDiag.delete(cmd.streamId);
    }
  }

  private laneBlock(block: SinkLaneBlock, epoch: number): void {
    const strip = this.laneStrip(block.lane);
    if (!strip) return;
    if (block.flags & AudioFlags.Silent) { this.stopLane(strip); return; }
    const lane = strip.lane - 1;
    if (strip.kind !== KIND_LANE) {
      // New lane: its bus starts AT the current target (a fresh GainNode with gain.value set), no smoothing.
      strip.kind = KIND_LANE; strip.hasScheduled = false; strip.segCount = 0;
      this.busCur[lane] = this.busTarget[lane];
      this.jitter[lane].reset();
    }
    strip.epoch = epoch;
    const now = this.contextNow;
    const decision = this.jitter[lane].acceptAtUs(block.blockIndex, block.dueUs, now);
    const start = Math.max(now, decision.scheduleAt);
    const ramp = decision.dropped > 0 || (decision.reanchored && strip.hasScheduled);
    const segIndex = this.allocSegment();
    if (segIndex >= 0) {
      const seg = this.segments[segIndex];
      if (seg.bind(block.pcm)) {
        seg.step = AUDIO_SAMPLE_RATE / this.sampleRate;
        seg.startFrame = frameAt(start, this.sampleRate);
        seg.rampFrames = ramp ? this.rampFrames : 0;
        this.attachSegment(segIndex, strip);
      } else this.releaseSegment(segIndex);
    }
    strip.hasScheduled = true;
    if (this.diagOn && (block.blockIndex % 16 === 0 || decision.dropped > 0 || decision.reanchored))
      this.recordScheduled("lane-source-scheduled", "", "live-lane", frameAt(start, this.sampleRate), epoch,
        block.lane, block.streamId, block.blockIndex, block.dueUs, decision.dropped, decision.reanchored,
        Number.NaN, Number.NaN, block.pcm.frames, undefined, undefined, undefined);
  }

  private laneGains(music: number, ambience: number, loops: number): void {
    const sane = (v: number, fallback: number): number => Number.isFinite(v) && v >= 0 ? v : fallback;
    this.busTarget[0] = sane(music, this.busTarget[0]);
    this.busTarget[1] = sane(ambience, this.busTarget[1]);
    this.busTarget[2] = sane(loops, this.busTarget[2]);
  }

  private laneStrip(lane: number): Strip | null {
    return lane >= 1 && lane <= LANE_COUNT ? this.laneStrips[lane - 1] : null;
  }

  /** onFrame's Silent branch / StreamVoice.stop(): hard-stop every source, reset the jitter buffer, drop the lane. */
  private stopLane(strip: Strip): void {
    if (strip.kind !== KIND_LANE) return;
    this.freeStripSegments(strip);
    strip.kind = KIND_FREE; strip.hasScheduled = false;
    this.jitter[strip.lane - 1].reset();
  }

  private takeStrip(streamId: number): Strip | null {
    const index = this.takeByStream.get(streamId);
    if (index === undefined) return null;
    const strip = this.strips[index];
    if (strip.kind !== KIND_TAKE || strip.streamId !== streamId) { this.takeByStream.delete(streamId); return null; }
    return strip;
  }

  private sweepTakeMap(): void {
    for (const [streamId, index] of this.takeByStream) {
      const strip = this.strips[index];
      if (strip.kind !== KIND_TAKE || strip.streamId !== streamId) { this.takeByStream.delete(streamId); this.takeDiag.delete(streamId); }
    }
  }

  /** VoiceCap.add: while the key already has >= 4 in-cap voices, stop the oldest with the 10 ms fade. */
  private capAdd(strip: Strip): void {
    let count = 0;
    for (let i = 0; i < MIXER_MAX_VOICES; i++) { const s = this.strips[i]; if (s !== strip && s.inCap && s.key === strip.key) count++; }
    while (count >= MIXER_VOICES_PER_KEY) {
      let oldest: Strip | null = null;
      for (let i = 0; i < MIXER_MAX_VOICES; i++) {
        const s = this.strips[i];
        if (s !== strip && s.inCap && s.key === strip.key && (!oldest || s.seq < oldest.seq)) oldest = s;
      }
      if (!oldest) break;
      this.fadeStrip(oldest, MIXER_CAP_FADE_MS);
      count--;
    }
    strip.inCap = true; this.capCount++;
  }

  /** VoiceRecord.stop(fadeMs): setTargetAtTime(0, now, fadeMs/3000), sources stop at now + fadeMs; leaves the cap. */
  private fadeStrip(strip: Strip, fadeMs: number): void {
    if (strip.inCap) { strip.inCap = false; this.capCount--; }
    if (strip.fading && strip.stopFrame <= this.frameNow + fadeMs / 1000 * this.sampleRate) return;
    strip.fading = true; strip.fadeStart = this.frameNow; strip.env = 1;
    if (fadeMs === MIXER_CAP_FADE_MS) { strip.stopFrame = this.frameNow + this.capFadeFrames; strip.fadeK = this.capFadeK; }
    else { strip.stopFrame = this.frameNow + Math.round(fadeMs / 1000 * this.sampleRate); strip.fadeK = Math.exp(-1 / (fadeMs / 3000 * this.sampleRate)); }
    if (strip.kind === KIND_TAKE) strip.stopped = true;
  }

  /**
   * resetSeatPlayback for everything older than `epoch`: one-shots get VoiceCap.stopAll's 10 ms fade; take
   * streams and lanes stop hard (their sources get a bare `stop()`); loaded takes are kept.
   */
  private fenceOlderThan(epoch: number): void {
    for (let i = 0; i < this.strips.length; i++) {
      const strip = this.strips[i];
      if (strip.kind === KIND_FREE || strip.epoch >= epoch) continue;
      if (strip.kind === KIND_VOICE) this.fadeStrip(strip, MIXER_CAP_FADE_MS);
      else if (strip.kind === KIND_TAKE) this.freeStrip(strip);
      else this.stopLane(strip);
    }
  }

  private allocVoiceStrip(): Strip {
    let oldest: Strip | null = null;
    for (let i = 0; i < MIXER_MAX_VOICES; i++) {
      const s = this.strips[i];
      if (s.kind === KIND_FREE) { this.resetStrip(s); return s; }
      if (!oldest || s.seq < oldest.seq) oldest = s;
    }
    // Pool exhausted (64 live voices): steal the oldest outright.
    this.freeStrip(oldest!);
    this.resetStrip(oldest!);
    return oldest!;
  }

  private resetStrip(s: Strip): void {
    s.seq = ++this.seqCounter; s.inCap = false; s.fading = false; s.stopFrame = Number.POSITIVE_INFINITY;
    s.env = 1; s.fadeK = 1; s.segCount = 0; s.streamId = -1; s.finished = false; s.stopped = false; s.gain = 1; s.pitch = 1;
  }

  private allocSegment(): number {
    if (this.freeSegCount === 0) { this.droppedSegments++; return -1; }
    return this.freeSeg[--this.freeSegCount];
  }

  private releaseSegment(index: number): void {
    const seg = this.segments[index];
    seg.active = false; seg.strip = -1; seg.clear();
    this.freeSeg[this.freeSegCount++] = index;
  }

  private attachSegment(index: number, strip: Strip): void {
    const seg = this.segments[index];
    seg.active = true; seg.strip = strip.index; seg.started = false; seg.pos = 0; seg.t0 = seg.startFrame;
    this.activeSeg[this.activeSegCount++] = index;
    strip.segCount++;
    if (strip.kind === KIND_LANE) this.laneSegCount++;
  }

  // ---------------------------------------------------------------------------------------------------
  // Shared by both paths (allocation-free).
  // ---------------------------------------------------------------------------------------------------

  private detachActive(slot: number): void {
    const index = this.activeSeg[slot];
    const seg = this.segments[index];
    const strip = this.strips[seg.strip];
    strip.segCount--;
    if (strip.kind === KIND_LANE) this.laneSegCount--;
    this.activeSeg[slot] = this.activeSeg[--this.activeSegCount];
    this.releaseSegment(index);
  }

  private freeStripSegments(strip: Strip): void {
    for (let slot = this.activeSegCount - 1; slot >= 0; slot--) {
      if (this.segments[this.activeSeg[slot]].strip === strip.index) this.detachActive(slot);
    }
  }

  private freeStrip(strip: Strip): void {
    this.freeStripSegments(strip);
    if (strip.inCap) { strip.inCap = false; this.capCount--; }
    strip.kind = KIND_FREE; strip.fading = false; strip.stopFrame = Number.POSITIVE_INFINITY;
  }

  // ---------------------------------------------------------------------------------------------------
  // Render path. ALLOCATION-FREE.
  // ---------------------------------------------------------------------------------------------------

  /** Mixes `frames` frames starting at context frame `currentFrame` into `outL`/`outR` (overwritten). */
  render(outL: Float32Array, outR: Float32Array, frames: number, currentFrame: number): void {
    let offset = 0;
    while (offset < frames) {
      const n = frames - offset < MIXER_QUANTUM ? frames - offset : MIXER_QUANTUM;
      this.renderChunk(outL, outR, offset, n, currentFrame + offset);
      offset += n;
    }
  }

  private renderChunk(outL: Float32Array, outR: Float32Array, off: number, n: number, q0: number): void {
    this.frameNow = q0;
    for (let j = 0; j < n; j++) { outL[off + j] = 0; outR[off + j] = 0; }
    const keepAlive = this.capCount === 0 && this.laneSegCount === 0;
    const strips = this.strips;
    for (let i = 0; i < strips.length; i++) {
      const strip = strips[i];
      if (strip.kind !== KIND_FREE) this.fillStrip(strip, q0, n);
    }
    for (let slot = this.activeSegCount - 1; slot >= 0; slot--) {
      const seg = this.segments[this.activeSeg[slot]];
      if (this.mixSegment(seg, strips[seg.strip].buf, outL, outR, off, n, q0)) this.detachActive(slot);
    }
    const qEnd = q0 + n;
    for (let i = 0; i < MIXER_MAX_VOICES; i++) {
      const strip = strips[i];
      if (strip.kind === KIND_FREE) continue;
      if (qEnd >= strip.stopFrame) this.freeStrip(strip);
      else if (strip.segCount === 0 && (strip.kind === KIND_VOICE || strip.finished)) this.freeStrip(strip);
    }
    if (keepAlive) for (let j = 0; j < n; j++) { outL[off + j] += MIXER_KEEP_ALIVE_DC; outR[off + j] += MIXER_KEEP_ALIVE_DC; }
    this.lastKeepAlive = keepAlive;
    this.frameNow = qEnd;
    if (this.diagOn) this.diagFramesSinceFlush += n;
  }

  private fillStrip(strip: Strip, q0: number, n: number): void {
    const buf = strip.buf;
    if (strip.kind === KIND_LANE) {
      const lane = strip.lane - 1;
      const target = this.busTarget[lane], alpha = this.busAlpha;
      let cur = this.busCur[lane];
      for (let j = 0; j < n; j++) { cur += (target - cur) * alpha; buf[j] = cur; }
      this.busCur[lane] = cur;
      return;
    }
    const gain = strip.gain;
    if (!strip.fading) { for (let j = 0; j < n; j++) buf[j] = gain; return; }
    let env = strip.env;
    const k = strip.fadeK, fadeStart = strip.fadeStart, stopFrame = strip.stopFrame;
    for (let j = 0; j < n; j++) {
      const f = q0 + j;
      if (f >= stopFrame) buf[j] = 0;
      else if (f >= fadeStart) { buf[j] = gain * env; env *= k; }
      else buf[j] = gain;
    }
    strip.env = env;
  }

  /** Adds one segment's contribution; true when the segment has played out. */
  private mixSegment(seg: Segment, gainBuf: Float32Array, outL: Float32Array, outR: Float32Array,
    off: number, n: number, q0: number): boolean {
    let j = 0;
    if (!seg.started) {
      const first = Math.ceil(seg.startFrame - 1e-6);
      if (first >= q0 + n) return false;
      if (first < q0) { j = 0; seg.t0 = q0; seg.pos = 0; } // late: start now, from the top (AudioBufferSourceNode)
      else { j = first - q0; seg.t0 = seg.startFrame; seg.pos = (first - seg.startFrame) * seg.step; }
      seg.started = true;
    }
    const frames = seg.frames, step = seg.step, t0 = seg.t0, rampFrames = seg.rampFrames;
    let pos = seg.pos;
    const d = seg.i16;
    if (d !== null) {
      const ch = seg.ch, rOff = ch > 1 ? 1 : 0;
      for (; j < n; j++) {
        const i = Math.floor(pos);
        if (i >= frames) break;
        const frac = pos - i;
        const b0 = i * ch, b1 = i + 1 < frames ? b0 + ch : b0;
        const l0 = d[b0], r0 = d[b0 + rOff];
        let g = gainBuf[j] * INV_S16;
        if (rampFrames > 0) { const x = (q0 + j - t0) / rampFrames; if (x < 1) g *= x > 0 ? x : 0; }
        outL[off + j] += (l0 + (d[b1] - l0) * frac) * g;
        outR[off + j] += (r0 + (d[b1 + rOff] - r0) * frac) * g;
        pos += step;
      }
    } else {
      const left = seg.f32L!, right = seg.f32R!;
      for (; j < n; j++) {
        const i = Math.floor(pos);
        if (i >= frames) break;
        const frac = pos - i;
        const i1 = i + 1 < frames ? i + 1 : i;
        const l0 = left[i], r0 = right[i];
        let g = gainBuf[j];
        if (rampFrames > 0) { const x = (q0 + j - t0) / rampFrames; if (x < 1) g *= x > 0 ? x : 0; }
        outL[off + j] += (l0 + (left[i1] - l0) * frac) * g;
        outR[off + j] += (r0 + (right[i1] - r0) * frac) * g;
        pos += step;
      }
    }
    seg.pos = pos;
    return pos >= frames;
  }

  // ---------------------------------------------------------------------------------------------------
  // Stats + diagnostics.
  // ---------------------------------------------------------------------------------------------------

  stats(): MixerStats {
    let voices = 0, takeStreams = 0, lanes = 0;
    for (let i = 0; i < this.strips.length; i++) {
      const kind = this.strips[i].kind;
      if (kind === KIND_VOICE) voices++;
      else if (kind === KIND_TAKE) { voices++; takeStreams++; }
      else if (kind === KIND_LANE) lanes++;
    }
    return { capVoices: this.capCount, voices, takeStreams, lanes, laneSegments: this.laneSegCount,
      segments: this.activeSegCount, keepAlive: this.lastKeepAlive, droppedSegments: this.droppedSegments,
      staleCommands: this.staleCommands, missingTakes: this.missingTakes };
  }

  /** True once ~100 ms of audio has rendered since the last drain and there is something to send. */
  diagDue(): boolean {
    return this.diagOn && this.diagCount > 0 && this.diagFramesSinceFlush >= this.diagFlushFrames;
  }

  /** Builds the wire payload (allocates — call outside `render`). `performanceMs` is NaN; main maps it from contextTime. */
  drainDiag(): AudioDiagPayload & { lost: number } {
    const events: AudioDiagEventWire[] = [];
    const capacity = this.diagRing.length;
    for (let i = 0; i < this.diagCount; i++) {
      const s = this.diagRing[(this.diagHead - this.diagCount + i + capacity) % capacity];
      const ev: AudioDiagEventWire = { seq: s.seq, type: s.type, performanceMs: Number.NaN, contextTime: s.contextTime,
        epoch: s.epoch, source: "worklet" };
      if (s.type === "worklet-receipt") {
        ev.kind = s.kind;
        if (Number.isFinite(s.postMs)) ev.postMs = s.postMs;
        if (s.key) ev.keyId = s.key;
        if (s.streamId >= 0) ev.streamId = s.streamId;
        if (s.blockIndex >= 0) ev.blockIndex = s.blockIndex;
      } else if (s.type === "source-scheduled") {
        ev.lane = s.streamId >= 0 ? "take" : "sfx"; ev.keyId = s.key; ev.sourcePath = s.sourcePath;
        ev.scheduledContextTime = s.scheduledContextTime; ev.pitch = s.pitch; ev.gain = s.gain; ev.frames = s.frames;
        if (s.streamId >= 0) { ev.streamId = s.streamId; ev.blockIndex = s.blockIndex; ev.fadeIn = s.reanchored; }
        // Numeric like the main-thread sinks' rows, so one analyzer joins every path's cues.
        if (s.seatTUs) ev.seatTUs = Number(s.seatTUs);
        if (Number.isFinite(s.order) && s.order > 0) ev.requestOrder = s.order;
        if (Number.isFinite(s.seatConnId)) ev.seatConnectionId = s.seatConnId;
      } else if (s.type === "lane-source-scheduled") {
        ev.sourcePath = s.sourcePath; ev.lane = s.lane; ev.streamId = s.streamId; ev.blockIndex = s.blockIndex;
        ev.dueUs = String(s.dueUs); ev.scheduledContextTime = s.scheduledContextTime;
        ev.dropped = s.dropped; ev.reanchored = s.reanchored; ev.frames = s.frames;
      } else if (s.type === "take-missing") {
        ev.keyId = s.key;
      }
      events.push(ev);
    }
    this.diagCount = 0; this.diagFramesSinceFlush = 0;
    const lost = this.diagLost; this.diagLost = 0;
    return { events, voices: this.capCount, lanes: this.stats().lanes, lost };
  }

  private nextDiagSlot(type: string, epoch: number): DiagSlot {
    const capacity = this.diagRing.length;
    const slot = this.diagRing[this.diagHead];
    this.diagHead = (this.diagHead + 1) % capacity;
    if (this.diagCount < capacity) this.diagCount++; else this.diagLost++;
    slot.seq = ++this.diagSeq; slot.type = type; slot.contextTime = this.frameNow / this.sampleRate; slot.epoch = epoch;
    slot.kind = ""; slot.key = ""; slot.sourcePath = ""; slot.postMs = Number.NaN; slot.streamId = -1; slot.blockIndex = -1;
    slot.seatTUs = ""; slot.order = Number.NaN; slot.seatConnId = Number.NaN;
    return slot;
  }

  private recordReceipt(cmd: SinkCommand): void {
    // Lane blocks arrive ~94/s per lane; sample them 1 in 16 like the lane rows so they cannot flood the ring.
    if (cmd.kind === "lane-blocks" && (cmd.blocks.length === 0 || cmd.blocks[0].blockIndex % 16 !== 0)) return;
    const slot = this.nextDiagSlot("worklet-receipt", cmd.epoch);
    slot.kind = cmd.kind;
    if ("postMs" in cmd) slot.postMs = cmd.postMs;
    if ("key" in cmd) slot.key = cmd.key;
    if (cmd.kind === "take-start" || cmd.kind === "take-block") slot.streamId = cmd.streamId;
    if (cmd.kind === "take-block") slot.blockIndex = cmd.blockIndex;
    if (cmd.kind === "lane-blocks" && cmd.blocks.length) { slot.streamId = cmd.blocks[0].streamId; slot.blockIndex = cmd.blocks[0].blockIndex; }
  }

  private recordMiss(key: string, epoch: number): void {
    if (!this.diagOn) return;
    this.nextDiagSlot("take-missing", epoch).key = key;
  }

  private recordScheduled(type: string, key: string, sourcePath: string, startFrame: number, epoch: number,
    lane: number, streamId: number, blockIndex: number, dueUs: number, dropped: number, flag: boolean,
    gain: number, pitch: number, frames: number, seatTUs: string | undefined, order: number | undefined,
    seatConnId: number | undefined): void {
    const slot = this.nextDiagSlot(type, epoch);
    slot.key = key; slot.sourcePath = sourcePath; slot.scheduledContextTime = startFrame / this.sampleRate;
    slot.lane = lane; slot.streamId = streamId; slot.blockIndex = blockIndex; slot.dueUs = dueUs; slot.dropped = dropped;
    slot.reanchored = flag; slot.gain = gain; slot.pitch = pitch; slot.frames = frames;
    slot.seatTUs = seatTUs ?? ""; slot.order = order ?? Number.NaN; slot.seatConnId = seatConnId ?? Number.NaN;
  }
}
