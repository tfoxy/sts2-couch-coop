// The main-thread sink for the worker transport's "post" mode (WP-A). Applies ready `SinkCommand`s with
// the same WebAudio node graph `mainEngine.ts` builds today — the only work left on the main thread per
// message is copying already-decoded Float32 planes into an AudioBuffer and starting a source.
//
// Semantics ported from mainEngine.ts, and the ones the worklet mixer (WP-B) matches:
//   * `play`: one-shot voice at `gain`, playbackRate = pitch clamped to [0.25, 4] (non-finite -> 1),
//     started now. VoiceCap(4) per key: a fifth voice of a key fades the OLDEST one out over 10 ms.
//   * `take-start`/`take-block`: a first-sight stream voice (counted in the same VoiceCap). Each block
//     starts at max(now + 5 ms, nextAt); nextAt advances by frames / (48 kHz * pitch); a block that
//     follows an underrun (nextAt < now + 1 ms) fades in over 5 ms. playbackRate = the raw pitch.
//   * `lane-blocks`: per-lane LaneJitterBuffer(60 ms) on context time; a re-anchor after the first block,
//     or a drop, fades the block in over 5 ms. A contiguous run inside one batch (no re-anchor, no drop,
//     starts abutting) is scheduled as ONE buffer + one source.
//   * `lane-gains`: existing lane gain nodes glide with setTargetAtTime(·, now, 15 ms); a lane created
//     later starts at the latest value.
//   * `fence` (and any command with an epoch older than the newest seen): stop every voice and lane —
//     today's `resetSeatPlayback`. Loaded buffers survive a fence.
import { isStaleEpoch, SINK_DIAG_SOURCE_PATH, type SinkCommand, type SinkCueParams, type SinkLaneBlock, type SinkPcm } from "./audioSinkProtocol";
import type { AudioContextLike } from "./audioUnlock";
import { AUDIO_SAMPLE_RATE } from "./audioWire";
import { createKeepAlive, shouldKeepAlive, type KeepAliveHandle } from "./keepAlive";
import { LaneJitterBuffer, type JitterDecision } from "./laneJitterBuffer";
import { VoiceCap, type VoiceRecord } from "./voiceCap";

type SinkDiag = (type: string, fields: Record<string, unknown>) => void;
export interface MainSinkOptions { diag?: SinkDiag; }

const TAKE_RATE = 48_000;


function laneName(lane: number): "music" | "ambience" | "loops" { return lane === 1 ? "music" : lane === 2 ? "ambience" : "loops"; }
const clampPitch = (pitch: number): number => Number.isFinite(pitch) ? Math.max(.25, Math.min(4, pitch)) : 1;
const diagSeatTUs = (cue: SinkCueParams): number | undefined => cue.seatTUs === undefined ? undefined : Number(cue.seatTUs);

/** Copies a `SinkPcm` into `buffer` starting at `offset` frames. */
function writePcm(buffer: AudioBuffer, pcm: SinkPcm, offset: number): void {
  const channels = buffer.numberOfChannels ?? 2;
  if (pcm.format === "f32-planar") {
    for (let c = 0; c < channels; c++) {
      const plane = pcm.channels[Math.min(c, pcm.channels.length - 1)];
      if (typeof buffer.copyToChannel === "function") buffer.copyToChannel(plane as Float32Array<ArrayBuffer>, c, offset);
      else buffer.getChannelData(c).set(plane, offset);
    }
    return;
  }
  for (let c = 0; c < channels; c++) {
    const out = buffer.getChannelData(c), source = Math.min(c, pcm.channels - 1);
    for (let i = 0; i < pcm.frames; i++) out[offset + i] = pcm.interleaved[i * pcm.channels + source] / 32768;
  }
}
const pcmChannels = (pcm: SinkPcm): number => pcm.format === "f32-planar" ? pcm.channels.length : pcm.channels;

interface SinkTakeStream {
  keyId: string; pitch: number; cue: SinkCueParams; gainNode: GainNode; sources: Set<AudioBufferSourceNode>;
  nextAt: number; voice: VoiceRecord; finished: boolean;
}

/** `StreamVoice` on numeric-µs blocks, with contiguous-run merging. */
class SinkLaneVoice {
  private readonly jitter = new LaneJitterBuffer(60);
  private readonly sources = new Set<AudioBufferSourceNode>();
  private hasScheduled = false;
  private static readonly BLOCK_TOLERANCE_SEC = 2e-6;
  constructor(private readonly context: AudioContextLike, private readonly gain: GainNode,
    private readonly onActivity: () => void,
    private readonly onScheduled?: (block: SinkLaneBlock, decision: JitterDecision, start: number) => void) {}

  push(blocks: readonly SinkLaneBlock[]): void {
    let run: { start: number; frames: number; fade: boolean; blocks: SinkLaneBlock[] } | null = null;
    for (const block of blocks) {
      const now = this.context.currentTime;
      const decision = this.jitter.acceptAtUs(block.blockIndex, block.dueUs, now);
      const start = Math.max(now, decision.scheduleAt);
      const fade = decision.dropped > 0 || (decision.reanchored && this.hasScheduled);
      this.hasScheduled = true;
      const abuts = run !== null && !decision.reanchored && decision.dropped === 0 &&
        Math.abs(start - (run.start + run.frames / AUDIO_SAMPLE_RATE)) < SinkLaneVoice.BLOCK_TOLERANCE_SEC;
      if (run && abuts) { run.blocks.push(block); run.frames += block.pcm.frames; }
      else {
        if (run) this.schedule(run);
        run = { start, frames: block.pcm.frames, fade, blocks: [block] };
      }
      this.onScheduled?.(block, decision, start);
    }
    if (run) this.schedule(run);
  }

  private schedule(run: { start: number; frames: number; fade: boolean; blocks: SinkLaneBlock[] }): void {
    const buffer = this.context.createBuffer(2, run.frames, AUDIO_SAMPLE_RATE);
    let offset = 0;
    for (const block of run.blocks) { writePcm(buffer, block.pcm, offset); offset += block.pcm.frames; }
    const source = this.context.createBufferSource(); source.buffer = buffer;
    const blockGain = this.context.createGain();
    if (run.fade) {
      blockGain.gain.setValueAtTime(0, run.start);
      blockGain.gain.linearRampToValueAtTime(1, run.start + 0.005);
      source.connect(blockGain); blockGain.connect(this.gain);
    } else source.connect(this.gain);
    this.sources.add(source); this.onActivity();
    source.onended = () => { this.sources.delete(source); source.disconnect(); blockGain.disconnect(); this.onActivity(); };
    source.start(run.start);
  }

  stop(): void {
    for (const source of this.sources) { try { source.stop(); } catch { /* already ended */ } source.disconnect(); }
    this.sources.clear(); this.jitter.reset(); this.hasScheduled = false; this.onActivity();
  }
  activeCount(): number { return this.sources.size; }
}

export class MainSink {
  private newestEpoch = 0;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly voices = new VoiceCap(4);
  private readonly lanes = new Map<number, SinkLaneVoice>();
  private readonly laneGainNodes = new Map<number, GainNode>();
  private laneGains = { music: 1, ambience: 1, loops: 1 };
  private readonly takes = new Map<number, SinkTakeStream>();
  private keepAlive: KeepAliveHandle | null = null;
  private readonly diag?: SinkDiag;

  constructor(private context: AudioContextLike, options: MainSinkOptions = {}) { this.diag = options.diag; }

  /** `diagSourcePath` overrides the `source-scheduled` row's sourcePath (main-decoded TmpSfx). */
  apply(cmd: SinkCommand, diagSourcePath?: string): void {
    // A `load` is never stale: buffers survive fences, and the worker counts a posted load as resident.
    if (cmd.kind !== "load" && isStaleEpoch(cmd.epoch, this.newestEpoch)) {
      this.diag?.("sink-stale-dropped", { kind: cmd.kind, epoch: cmd.epoch, newestEpoch: this.newestEpoch });
      return;
    }
    this.newestEpoch = Math.max(this.newestEpoch, cmd.epoch);
    switch (cmd.kind) {
      case "load": return this.load(cmd.key, cmd.pcm, cmd.rate);
      case "play": return this.play(cmd.key, cmd, diagSourcePath ?? cmd.diagSourcePath ?? SINK_DIAG_SOURCE_PATH[cmd.sourcePath] ?? cmd.sourcePath);
      case "take-start": return this.takeStart(cmd.streamId, cmd.key, cmd);
      case "take-block": return this.takeBlock(cmd.streamId, cmd.blockIndex, cmd.flags, cmd.pcm);
      case "lane-blocks": return this.laneBlocks(cmd.blocks);
      case "lane-gains": return this.setLaneGains(cmd);
      case "lane-stop": return this.laneStop(cmd.lane);
      case "fence": return this.reset();
    }
  }

  /** Stops every voice and lane and refuses anything older than `epoch` from now on. */
  fence(epoch: number): void {
    this.newestEpoch = Math.max(this.newestEpoch, epoch);
    this.reset();
  }

  /** Main-decoded buffers (TmpSfx) go straight in; the worker never sees their PCM. */
  loadBuffer(key: string, buffer: AudioBuffer): void { this.buffers.set(key, buffer); }
  hasBuffer(key: string): boolean { return this.buffers.has(key); }

  /**
   * The FAST-track probe closed and recreated the AudioContext. Voices on the old one are gone; loaded
   * AudioBuffers are context-independent and stay, so the worker's "loaded in sink" set stays true.
   */
  setContext(context: AudioContextLike): void {
    const keepAlive = this.keepAlive !== null;
    this.stopKeepAlive();
    this.reset();
    this.context = context;
    if (keepAlive) this.startKeepAlive();
  }

  startKeepAlive(): void {
    this.keepAlive?.dispose();
    this.keepAlive = createKeepAlive(this.context as unknown as AudioContext, () =>
      shouldKeepAlive({ voices: this.voices.count(), activeLanes: [...this.lanes.values()].filter(lane => lane.activeCount() > 0).length }));
  }
  stopKeepAlive(): void { this.keepAlive?.dispose(); this.keepAlive = null; }

  voiceCount(): number { return this.voices.count(); }
  laneKeys(): number[] { return [...this.lanes.keys()]; }

  dispose(): void { this.reset(); this.stopKeepAlive(); this.buffers.clear(); }

  private touch(): void { this.keepAlive?.update(); }

  private reset(): void {
    this.voices.stopAll();
    for (const stream of this.takes.values()) {
      for (const source of stream.sources) { try { source.stop(); } catch { /* already ended */ } }
      stream.gainNode.disconnect();
    }
    this.takes.clear();
    for (const lane of this.lanes.values()) lane.stop();
    this.lanes.clear(); for (const node of this.laneGainNodes.values()) node.disconnect(); this.laneGainNodes.clear();
    this.touch();
  }

  private load(key: string, pcm: SinkPcm, rate: number): void {
    const buffer = this.context.createBuffer(pcmChannels(pcm), pcm.frames, rate);
    writePcm(buffer, pcm, 0);
    this.buffers.set(key, buffer);
  }

  private play(keyId: string, cue: SinkCueParams, sourcePath: string): void {
    const buffer = this.buffers.get(keyId);
    if (!buffer) { this.diag?.("sink-play-missing", { keyId }); return; }
    if (!(cue.gain > 0)) return;
    const context = this.context;
    const gain = context.createGain(); gain.gain.value = cue.gain; gain.connect(context.destination);
    const source = context.createBufferSource(); source.buffer = buffer; source.playbackRate.value = clampPitch(cue.pitch); source.connect(gain);
    const record: VoiceRecord = { keyId, stop(fadeMs) {
      const now = context.currentTime; gain.gain.cancelScheduledValues(now); gain.gain.setTargetAtTime(0, now, fadeMs / 3000);
      try { source.stop(now + fadeMs / 1000); } catch { /* ended */ }
    } };
    this.voices.add(record); this.touch();
    source.onended = () => { this.voices.remove(record); source.disconnect(); gain.disconnect(); this.touch(); };
    const scheduledContextTime = context.currentTime;
    source.start();
    this.diag?.("source-scheduled", { lane: "sfx", keyId, ...(sourcePath.includes("tmpsfx") ? { resPath: keyId } : {}),
      sourcePath, seatTUs: diagSeatTUs(cue), scheduledContextTime, pitch: cue.pitch, connectionId: cue.seatConnId,
      ...(cue.order ? { requestOrder: cue.order } : {}) });
  }

  private takeStart(streamId: number, keyId: string, cue: SinkCueParams): void {
    const context = this.context;
    const gainNode = context.createGain(); gainNode.gain.value = cue.gain; gainNode.connect(context.destination);
    const stream: SinkTakeStream = { keyId, pitch: cue.pitch, cue, gainNode, sources: new Set(),
      nextAt: context.currentTime + 0.005, voice: undefined as unknown as VoiceRecord, finished: false };
    stream.voice = { keyId, stop(fadeMs) {
      const now = context.currentTime; gainNode.gain.cancelScheduledValues(now); gainNode.gain.setTargetAtTime(0, now, fadeMs / 3000);
      for (const source of stream.sources) { try { source.stop(now + fadeMs / 1000); } catch { /* ended */ } }
    } };
    this.voices.add(stream.voice); this.touch(); this.takes.set(streamId, stream);
  }

  private takeBlock(streamId: number, blockIndex: number, flags: number, pcm: SinkPcm): void {
    const stream = this.takes.get(streamId);
    if (!stream) return;
    const context = this.context;
    const now = context.currentTime, startAt = Math.max(now + 0.005, stream.nextAt);
    const buffer = context.createBuffer(2, pcm.frames, TAKE_RATE);
    writePcm(buffer, pcm, 0);
    const source = context.createBufferSource(); source.buffer = buffer; source.playbackRate.value = stream.pitch;
    const blockGain = context.createGain();
    if (stream.nextAt < now + 0.001) { blockGain.gain.setValueAtTime(0, startAt); blockGain.gain.linearRampToValueAtTime(1, startAt + 0.005); }
    source.connect(blockGain); blockGain.connect(stream.gainNode); stream.sources.add(source);
    source.onended = () => {
      stream.sources.delete(source); source.disconnect(); blockGain.disconnect();
      if (stream.finished && stream.sources.size === 0) {
        this.voices.remove(stream.voice); stream.gainNode.disconnect();
        if (this.takes.get(streamId) === stream) this.takes.delete(streamId);
        this.touch();
      }
    };
    source.start(startAt); stream.nextAt = startAt + pcm.frames / (TAKE_RATE * stream.pitch);
    this.diag?.("source-scheduled", { lane: "take", sourcePath: "first-sight-stream", keyId: stream.keyId,
      seatTUs: diagSeatTUs(stream.cue), requestOrder: stream.cue.order, seatConnectionId: stream.cue.seatConnId,
      streamId, blockIndex, scheduledContextTime: startAt, pitch: stream.pitch, frames: pcm.frames });
    if (flags & 2) stream.finished = true;
    this.touch();
  }

  private laneBlocks(blocks: readonly SinkLaneBlock[]): void {
    const byLane = new Map<number, SinkLaneBlock[]>();
    for (const block of blocks) { const list = byLane.get(block.lane); if (list) list.push(block); else byLane.set(block.lane, [block]); }
    for (const [lane, laneBlocks] of byLane) this.laneVoice(lane).push(laneBlocks);
    this.touch();
  }

  private laneVoice(lane: number): SinkLaneVoice {
    let voice = this.lanes.get(lane);
    if (voice) return voice;
    const gain = this.context.createGain(); gain.gain.value = this.laneGains[laneName(lane)]; gain.connect(this.context.destination);
    this.laneGainNodes.set(lane, gain);
    const diag = this.diag;
    voice = new SinkLaneVoice(this.context, gain, () => this.touch(), diag
      ? (block, decision, scheduledContextTime) => {
        if (block.blockIndex % 16 !== 0 && !decision.dropped && !decision.reanchored) return;
        diag("lane-source-scheduled", { sourcePath: "live-lane", lane: block.lane, streamId: block.streamId,
          blockIndex: block.blockIndex, dueUs: String(block.dueUs), scheduledContextTime,
          dropped: decision.dropped, reanchored: decision.reanchored });
      } : undefined);
    this.lanes.set(lane, voice);
    return voice;
  }

  private setLaneGains(gains: { music: number; ambience: number; loops: number }): void {
    this.laneGains = { music: gains.music, ambience: gains.ambience, loops: gains.loops };
    for (const [lane, node] of this.laneGainNodes) node.gain.setTargetAtTime(this.laneGains[laneName(lane)], this.context.currentTime, 0.015);
  }

  private laneStop(lane: number): void {
    this.lanes.get(lane)?.stop(); this.lanes.delete(lane);
    this.laneGainNodes.get(lane)?.disconnect(); this.laneGainNodes.delete(lane);
    this.touch();
  }
}
