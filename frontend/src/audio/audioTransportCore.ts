// The audio Worker's transport (WP-A): both audio sockets, JSON parse, PCM decode, and every piece of
// engine bookkeeping that is not "make a sound now". What `mainEngine.ts` does on the main thread up to the
// point of creating a node, this does off it, and hands the result to a SINK as ready `SinkCommand`s —
// the main-thread `MainSink` ("post" mode, Float32 planar, wrapped as `{ kind: "sink", cmd }`) or the
// AudioWorklet mixer over a transferred port ("port" mode, Int16 "s16"). See audioSinkProtocol.ts.
//
// A plain class with injected sockets/fetch/post so vitest drives it with FakeSocket; the real Worker
// entry (audioTransport.worker.ts) only calls `installAudioTransportWorker(self)`.
//
// WHAT THE SINK MAY ASSUME (the contract WP-B's worklet matches):
//   * `load` precedes the first `play` of a key in the current sink; a later `play` of that key arrives
//     alone. A new `port` means a new sink, so the "loaded in sink" set is reset and keys load again.
//   * `play.gain` is the final linear gain (seat volumes already applied); `play.pitch` is the raw event
//     pitch — the sink clamps it to [0.25, 4] (non-finite -> 1) exactly as `playBuffer` does today.
//   * `take-start.pitch` is NOT clamped (today's take stream uses the raw pitch as playbackRate).
//   * Lane blocks may arrive batched (post mode coalescing); within a lane they are in arrival order.
//   * A lane block with the Silent flag never reaches the sink: pending blocks flush, then `lane-stop`.
//
// LANE COALESCING (post mode only). Lane blocks are held per lane and flushed together when any lane has
// `coalesce` blocks pending, on a First/Last flag, or 12 ms after the first block of a batch arrived. That
// 12 ms one-shot is a transport flush deadline (bounding how long a held block waits), not a poll: it reads
// no state and is armed only by an arriving block. Seat cues, control messages and take blocks are posted
// the moment they are handled and never wait on it. Port mode posts every lane block immediately.
import {
  sinkCommandTransferables,
  type AudioDiagEventWire, type AudioSinkPcmFormat, type MainToWorker, type SinkCommand, type SinkCueParams,
  type SinkLaneBlock, type SinkPcm, type SinkSourcePath, type WorkerToMain
} from "./audioSinkProtocol";
import { AudioFlags, type RenderInbound, type RenderOutbound, type SeatAudioEvent } from "./audioWire";
import { decodeAudioFrameView, joinS16, parseWavPcm16, s16ToF32Planar, type AudioFrameView, type WavPcm16 } from "./audioPcm";
import { applyVolumeSnapshot, DEFAULT_SEAT_VOLUMES, hasVolumeSnapshot, laneGain, sfxEventGain, type SeatVolumes } from "./audioGains";
import { openRenderLane, type RenderLaneHandle } from "./renderLane";
import { openSeatAudioLane, type SeatLaneHandle } from "./seatAudioLane";
import { TakeStore } from "./takeStore";
import { tmpSfxRoute } from "./audioRoutes";
import { AudioDiagBatcher } from "./audioDiagRing";

/** One-shot flush deadline for a held lane batch (see LANE COALESCING). */
export const LANE_COALESCE_DEADLINE_MS = 12;
/** The exported installer's name, kept as a runtime string so the emitted worker chunk can be checked for it. */
export const AUDIO_TRANSPORT_WORKER_ENTRY = "installAudioTransportWorker";

export interface AudioTransportDeps {
  WebSocketCtor: typeof WebSocket;
  fetcher: typeof fetch;
  postMain(msg: WorkerToMain, transfer?: Transferable[]): void;
  /** Overrides where `SinkCommand`s go. Default: wrapped to main in "post" mode, the transferred port in "port" mode. */
  postSink?(cmd: SinkCommand, transfer: Transferable[]): void;
  /** Page-aligned ms. Default: `performance.timeOrigin + performance.now() - init.mainTimeOrigin`. */
  now?(): number;
}

interface PortLike { postMessage(msg: unknown, transfer?: Transferable[]): void; close?(): void; }
type InitMessage = Extract<MainToWorker, { kind: "init" }>;
interface PendingCue { gain: number; pitch: number; seatTUs: number; order: number; seatConnId: number; }
interface TakeTrack { keyId: string; blocks: Int16Array[]; finished: boolean; ready: boolean; }
type LanesRequest = Extract<RenderInbound, { kind: "lanes" }>;

const TAKE_RATE = 48_000;

export class AudioTransportCore {
  private init: InitMessage | null = null;
  private port: PortLike | null = null;
  private epoch = 0;
  private running = false;
  private disposed = false;
  private seatUrl = "";
  private seat: SeatLaneHandle | null = null;
  private render: RenderLaneHandle | null = null;
  private volumes: SeatVolumes = { ...DEFAULT_SEAT_VOLUMES };
  private volumesKnown = false;
  private desiredLanes: LanesRequest = { kind: "lanes", music: true, ambience: true, loops: true };
  private store: TakeStore<WavPcm16> | null = null;
  private readonly loadedInSink = new Set<string>();
  private readonly tmpsfxResident = new Set<string>();
  private readonly pendingEvents = new Map<string, PendingCue[]>();
  private readonly takes = new Map<number, TakeTrack>();
  private readonly fallbackStarted = new Set<number>();
  private seatWork = new AbortController();
  private cacheFillAbort: AbortController | null = null;
  private cacheFillTimer: ReturnType<typeof setTimeout> | null = null;
  private laneBatch: SinkLaneBlock[] = [];
  private readonly lanePending = new Map<number, number>();
  private laneTimer: ReturnType<typeof setTimeout> | null = null;
  private hostBase = "";
  private assetToken = "";
  private diag: AudioDiagBatcher | null = null;
  private requestOrder = 0;
  private nextConnectionId = 0;
  readonly now: () => number;

  constructor(private readonly deps: AudioTransportDeps, private readonly onDispose?: () => void) {
    this.now = deps.now ?? (() => performance.timeOrigin + performance.now() -
      (this.init?.mainTimeOrigin ?? performance.timeOrigin));
  }

  handle(msg: MainToWorker): void {
    if (this.disposed) return;
    switch (msg.kind) {
      case "init": return this.onInit(msg);
      case "port":
        this.port?.close?.();
        this.port = msg.port as unknown as PortLike;
        this.loadedInSink.clear(); this.tmpsfxResident.clear();
        this.record("sink-port", { sampleRate: msg.sampleRate });
        return;
      case "start": return this.startSession(msg.epoch, msg.seatUrl);
      case "seat": return this.switchSeat(msg.epoch, msg.seatUrl);
      case "stop": return this.stopSession(msg.epoch);
      case "probe-clock": if (this.running) this.render?.probeClock(); return;
      case "asset-token": this.assetToken = msg.token; return;
      case "tmpsfx-resident": this.tmpsfxResident.add(msg.path); return;
      case "tmpsfx-failed": this.record("tmpsfx-failed", { resPath: msg.path }); return;
      case "dispose": return this.dispose();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.stopSession(this.epoch);
    this.disposed = true;
    this.diag?.flush(); this.diag?.dispose(); this.diag = null;
    this.port?.close?.(); this.port = null;
    this.onDispose?.();
  }

  /** Test/diagnostic view of the "already loaded in the sink" key set. */
  isLoadedInSink(key: string): boolean { return this.loadedInSink.has(key); }

  private onInit(msg: InitMessage): void {
    this.init = msg;
    this.hostBase = msg.hostBase;
    this.assetToken = msg.assetToken;
    if (msg.diag && !this.diag) this.diag = new AudioDiagBatcher(this.now, rows => this.flushDiag(rows));
    this.record("worker-installed", { entry: AUDIO_TRANSPORT_WORKER_ENTRY, sinkMode: msg.sinkMode, pcm: msg.pcm, coalesce: msg.coalesce });
    this.deps.postMain({ kind: "ready" });
  }

  private flushDiag(rows: AudioDiagEventWire[]): void { this.deps.postMain({ kind: "diag", events: rows }); }

  private record(type: string, fields: Record<string, unknown> = {}): void {
    this.diag?.record(type, { thread: "worker", ...fields });
  }

  private get markLane(): ((type: string, fields: Record<string, unknown>) => void) | undefined {
    return this.diag ? (type, fields) => this.record(type, fields) : undefined;
  }

  private resolveUrl = (route: string): string => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(route) || !this.hostBase) return route;
    return route.startsWith("/") ? this.hostBase + route : `${this.hostBase}/${route}`;
  };

  // --- sink output -------------------------------------------------------------------------------------

  private postSink(cmd: SinkCommand): void {
    const transfer = sinkCommandTransferables(cmd);
    let dest: string;
    if (this.deps.postSink) { dest = "sink"; this.deps.postSink(cmd, transfer); }
    else if (this.init?.sinkMode === "port") {
      if (!this.port) { this.record("worker-post-dropped", { kind: cmd.kind, reason: "no-port" }); return; }
      dest = "worklet"; this.port.postMessage(cmd, transfer);
    } else { dest = "main"; this.deps.postMain({ kind: "sink", cmd }, transfer); }
    if (this.diag && (cmd.kind !== "lane-blocks" || cmd.blocks.some(block => block.blockIndex % 16 === 0)))
      this.record("worker-post", { dest, kind: cmd.kind, ...("key" in cmd ? { keyId: cmd.key } : {}),
        ...("streamId" in cmd ? { streamId: cmd.streamId } : {}),
        ...(cmd.kind === "lane-blocks" ? { blocks: cmd.blocks.length } : {}) });
  }

  private get pcmFormat(): AudioSinkPcmFormat { return this.init?.pcm ?? "f32-planar"; }

  /** `owned`: the caller gives up `interleaved` (it may be transferred as-is); otherwise s16 is copied. */
  private sinkPcm(interleaved: Int16Array, channels: number, frames: number, owned: boolean): SinkPcm {
    if (this.pcmFormat === "s16") return { format: "s16", interleaved: owned ? interleaved : interleaved.slice(), channels, frames };
    return { format: "f32-planar", channels: s16ToF32Planar(interleaved, channels, frames), frames };
  }

  private playStored(keyId: string, take: WavPcm16, cue: SinkCueParams, sourcePath: SinkSourcePath): void {
    if (!this.loadedInSink.has(keyId)) {
      this.postSink({ kind: "load", epoch: this.epoch, key: keyId, rate: take.rate,
        pcm: this.sinkPcm(take.interleaved, take.channels, take.frames, false) });
      this.loadedInSink.add(keyId);
    }
    this.postSink({ kind: "play", epoch: this.epoch, key: keyId, sourcePath, postMs: this.now(), ...cue });
  }

  private postLaneGains(): void {
    this.postSink({ kind: "lane-gains", epoch: this.epoch, music: laneGain(this.volumes, "music"),
      ambience: laneGain(this.volumes, "ambience"), loops: laneGain(this.volumes, "loops") });
  }

  private computeDesiredLanes(): LanesRequest {
    const known = this.volumesKnown, v = this.volumes;
    return { kind: "lanes", music: known && laneGain(v, "music") > 0, ambience: known && laneGain(v, "ambience") > 0,
      loops: known && laneGain(v, "loops") > 0 };
  }

  private updateLaneGains(): void {
    this.postLaneGains();
    this.desiredLanes = this.computeDesiredLanes();
    this.render?.request(this.desiredLanes);
    this.record("lane-subscription", { ...this.desiredLanes });
  }

  // --- lane coalescing ---------------------------------------------------------------------------------

  private queueLaneBlock(block: SinkLaneBlock): void {
    const coalesce = this.init?.coalesce ?? 2;
    if (this.init?.sinkMode === "port" || coalesce <= 1) {
      this.postSink({ kind: "lane-blocks", epoch: this.epoch, blocks: [block], postMs: this.now() });
      return;
    }
    this.laneBatch.push(block);
    const pending = (this.lanePending.get(block.lane) ?? 0) + 1;
    this.lanePending.set(block.lane, pending);
    if (pending >= coalesce || (block.flags & (AudioFlags.First | AudioFlags.Last)) !== 0) this.flushLanes();
    else if (this.laneTimer === null) this.laneTimer = setTimeout(() => { this.laneTimer = null; this.flushLanes(); }, LANE_COALESCE_DEADLINE_MS);
  }

  private flushLanes(): void {
    if (this.laneTimer !== null) { clearTimeout(this.laneTimer); this.laneTimer = null; }
    if (!this.laneBatch.length) return;
    const blocks = this.laneBatch;
    this.laneBatch = []; this.lanePending.clear();
    this.postSink({ kind: "lane-blocks", epoch: this.epoch, blocks, postMs: this.now() });
  }

  private dropLanes(): void {
    if (this.laneTimer !== null) { clearTimeout(this.laneTimer); this.laneTimer = null; }
    this.laneBatch = []; this.lanePending.clear();
  }

  // --- session lifecycle -------------------------------------------------------------------------------

  private closeLanes(): void { this.seat?.close(); this.render?.close(); this.seat = this.render = null; }

  private resetSeatWork(): void {
    this.takes.clear(); this.pendingEvents.clear(); this.fallbackStarted.clear(); this.dropLanes();
  }

  private startSession(epoch: number, seatUrl: string): void {
    if (!this.init) return;
    this.epoch = epoch; this.seatUrl = seatUrl;
    if (this.seatWork.signal.aborted) this.seatWork = new AbortController();
    this.running = true; this.closeLanes(); this.resetSeatWork();
    const versionSuffix = (): string => this.assetToken ? `?b=${encodeURIComponent(this.assetToken)}` : "";
    this.store = new TakeStore<WavPcm16>(null, this.deps.fetcher, this.markLane, {
      decode: async bytes => parseWavPcm16(bytes), resolveUrl: this.resolveUrl, versionSuffix });
    this.loadedInSink.clear();
    this.cacheFillAbort = new AbortController();
    const currentStore = this.store;
    void this.store.warm(this.init.indexUrl).then(() => {
      if (this.running && currentStore === this.store) this.scheduleCacheFill();
    });
    this.desiredLanes = this.computeDesiredLanes();
    this.postLaneGains();
    this.openLanes();
  }

  private stopSession(epoch: number): void {
    this.epoch = epoch;
    this.running = false;
    if (this.cacheFillTimer !== null) clearTimeout(this.cacheFillTimer);
    this.cacheFillTimer = null;
    this.cacheFillAbort?.abort(); this.cacheFillAbort = null;
    this.seatWork.abort();
    this.closeLanes(); this.resetSeatWork();
  }

  private switchSeat(epoch: number, seatUrl: string): void {
    this.epoch = epoch;
    this.seatWork.abort(); this.seatWork = new AbortController();
    this.resetSeatWork(); this.loadedInSink.clear();
    this.seatUrl = seatUrl; this.volumes = { ...DEFAULT_SEAT_VOLUMES }; this.volumesKnown = false;
    if (this.running) { this.closeLanes(); this.openLanes(); this.updateLaneGains(); }
  }

  private scheduleCacheFill(): void {
    if (!this.running || this.cacheFillTimer !== null || !this.cacheFillAbort || this.cacheFillAbort.signal.aborted) return;
    const currentStore = this.store, signal = this.cacheFillAbort.signal;
    this.cacheFillTimer = setTimeout(() => {
      this.cacheFillTimer = null;
      if (this.running && currentStore === this.store && !signal.aborted) void currentStore?.fillHttpCache(signal);
    }, 0);
  }

  private openLanes(): void {
    const init = this.init;
    if (!init) return;
    const epoch = this.epoch;
    const seatConnectionId = ++this.nextConnectionId;
    const renderConnectionId = ++this.nextConnectionId;
    const mark = this.markLane;
    this.seat = openSeatAudioLane(this.seatUrl, (event, callbackOrder) => {
      if (epoch === this.epoch) void this.onSeatEvent(event, seatConnectionId, callbackOrder);
    }, this.deps.WebSocketCtor, mark, seatConnectionId);
    this.render = openRenderLane<AudioFrameView>(init.renderUrl,
      (frame, callbackOrder) => { if (epoch === this.epoch) this.onFrame(frame, renderConnectionId, callbackOrder); },
      (message, callbackOrder) => { if (epoch === this.epoch) this.onRenderMessage(message, renderConnectionId, callbackOrder); },
      this.deps.WebSocketCtor, () => {
        if (epoch === this.epoch) this.deps.postMain({ kind: "unavailable", epoch });
      }, mark, renderConnectionId, { decode: decodeAudioFrameView, now: this.now });
    this.render.request(this.desiredLanes);
  }

  // --- inbound -----------------------------------------------------------------------------------------

  private async onSeatEvent(event: SeatAudioEvent, connectionId: number, callbackOrder?: number): Promise<void> {
    const eventEpoch = this.epoch;
    const order = this.diag && (event.kind === "sfx" || event.kind === "tmpsfx") ? ++this.requestOrder : 0;
    if (this.diag) this.record("seat-event-received", { connectionId, callbackOrder, kind: event.kind,
      ...(order ? { requestOrder: order } : {}), ...("t" in event ? { seatTUs: event.t } : {}),
      ...("keyId" in event ? { keyId: event.keyId } : {}), ...("resPath" in event ? { resPath: event.resPath } : {}),
      ...("pitch" in event ? { pitch: event.pitch, volume: event.volume } : {}) });
    if (!this.running) return;
    if (event.kind === "volumes") {
      this.volumes = applyVolumeSnapshot(this.volumes, event); this.volumesKnown ||= hasVolumeSnapshot(event);
      this.updateLaneGains(); return;
    }
    if (event.kind === "loop") { this.updateLaneGains(); return; }
    if (!this.volumesKnown) return;
    const gain = sfxEventGain(this.volumes, event);
    if (gain <= 0) return;
    const cue: SinkCueParams = { gain, pitch: event.pitch, seatTUs: String(event.t), ...(order ? { order } : {}), seatConnId: connectionId };
    if (event.kind === "tmpsfx") {
      const path = event.resPath;
      const route = tmpSfxRoute(path, this.assetToken || null);
      if (!route) return;
      if (this.tmpsfxResident.has(path)) {
        this.postSink({ kind: "play", epoch: eventEpoch, key: path, sourcePath: "tmpsfx", postMs: this.now(), ...cue });
        return;
      }
      this.deps.postMain({ kind: "tmpsfx-decode", epoch: eventEpoch, path, url: this.resolveUrl(route), cue });
      this.record("worker-post", { dest: "main", kind: "tmpsfx-decode", resPath: path });
      return;
    }
    const cached = this.store?.peek(event.keyId);
    if (cached) { this.playStored(event.keyId, cached, cue, "cached"); return; }
    const take = await this.store?.get(event.keyId, this.seatWork.signal);
    if (eventEpoch !== this.epoch || !this.running) return;
    if (take) { this.playStored(event.keyId, take, cue, "http-take"); return; }
    const queued = this.pendingEvents.get(event.keyId) ?? [];
    queued.push({ gain, pitch: event.pitch, seatTUs: event.t, order, seatConnId: connectionId });
    this.pendingEvents.set(event.keyId, queued.slice(-4));
    this.render?.request({ kind: "play", keyId: event.keyId, key: event.key },
      this.diag ? { seatTUs: event.t, requestOrder: order } : undefined);
  }

  private shiftPending(keyId: string): PendingCue | undefined {
    const queued = this.pendingEvents.get(keyId) ?? [], params = queued.shift();
    if (queued.length) this.pendingEvents.set(keyId, queued); else this.pendingEvents.delete(keyId);
    return params;
  }

  private static cueOf(params: PendingCue): SinkCueParams {
    return { gain: params.gain, pitch: params.pitch, seatTUs: String(params.seatTUs),
      ...(params.order ? { order: params.order } : {}), seatConnId: params.seatConnId };
  }

  private onFrame(frame: AudioFrameView, connectionId: number, callbackOrder?: number): void {
    if (this.diag && (frame.kind !== 2 || frame.blockIndex % 16 === 0))
      this.record("pcm-frame-received", { connectionId, callbackOrder, kind: frame.kind, lane: frame.lane,
        streamId: frame.streamId, blockIndex: frame.blockIndex, dueUs: frame.dueUs.toString(),
        sentUs: frame.sentUs.toString(), frames: frame.frames, flags: frame.flags });
    if (!this.running) return;
    if (frame.kind === 2) {
      if (frame.flags & AudioFlags.Silent) {
        this.flushLanes();
        this.postSink({ kind: "lane-stop", epoch: this.epoch, lane: frame.lane });
        return;
      }
      // The frame's PCM is a view over the socket's own ArrayBuffer, which nothing reads after this
      // callback — so in s16 mode it is transferred as-is (zero copy, header bytes ride along).
      this.queueLaneBlock({ lane: frame.lane, streamId: frame.streamId, blockIndex: frame.blockIndex,
        dueUs: frame.dueUsNumber, flags: frame.flags, pcm: this.sinkPcm(frame.pcm, 2, frame.frames, true) });
      return;
    }
    const track = this.takes.get(frame.streamId);
    if (!track || this.fallbackStarted.has(frame.streamId)) return;
    track.blocks.push(frame.pcm);
    this.postSink({ kind: "take-block", epoch: this.epoch, streamId: frame.streamId, blockIndex: frame.blockIndex,
      flags: frame.flags, pcm: this.sinkPcm(frame.pcm, 2, frame.frames, false), postMs: this.now() });
    if (frame.flags & AudioFlags.Last) {
      track.finished = true;
      const interleaved = joinS16(track.blocks);
      track.blocks = [];
      const take: WavPcm16 = { rate: TAKE_RATE, channels: 2, frames: interleaved.length / 2, interleaved };
      this.store?.setBuffer(track.keyId, take);
      this.postSink({ kind: "load", epoch: this.epoch, key: track.keyId, rate: TAKE_RATE,
        pcm: this.sinkPcm(interleaved, 2, take.frames, false) });
      this.loadedInSink.add(track.keyId);
      if (track.ready) this.takes.delete(frame.streamId);
    }
  }

  private onRenderMessage(message: RenderOutbound, connectionId: number, callbackOrder?: number): void {
    if (this.diag) this.record("render-message-received", { connectionId, callbackOrder,
      kind: message.kind, ...("keyId" in message ? { keyId: message.keyId } : {}),
      ...("streamId" in message ? { streamId: message.streamId } : {}) });
    if (message.kind === "clock") {
      this.record("host-clock-sample", { clockSeq: message.seq ?? null, clientSendPerfMs: message.clientPerfMs ?? null,
        hostReceiveUs: message.hostUs, hostSendUs: message.sentUs, clientReceivePerfMs: this.now() });
    } else if (message.kind === "hello") {
      void this.store?.warm(this.init?.indexUrl); this.render?.request(this.desiredLanes);
    } else if (message.kind === "take-start") {
      const params = this.shiftPending(message.keyId);
      if (!params) return;
      this.takes.set(message.streamId, { keyId: message.keyId, blocks: [], finished: false, ready: false });
      this.postSink({ kind: "take-start", epoch: this.epoch, streamId: message.streamId, key: message.keyId,
        postMs: this.now(), ...AudioTransportCore.cueOf(params) });
    } else if (message.kind === "take-ready") {
      const track = this.takes.get(message.streamId);
      this.record("take-ready-received", { keyId: message.keyId, streamId: message.streamId, url: message.url,
        streamTracked: !!track, streamFrames: track?.blocks.length ?? 0,
        pendingCount: this.pendingEvents.get(message.keyId)?.length ?? 0, seatEpoch: this.epoch, running: this.running });
      if (this.store?.setUrl(message.keyId, this.resolveUrl(message.url))) this.scheduleCacheFill();
      if (track) { track.ready = true; if (track.finished) this.takes.delete(message.streamId); return; }
      const params = this.shiftPending(message.keyId);
      if (!params) { this.record("take-ready-no-pending", { keyId: message.keyId, streamId: message.streamId }); return; }
      this.fallbackStarted.add(message.streamId);
      const readyEpoch = this.epoch;
      void this.store?.get(message.keyId, this.seatWork.signal, "take-ready").then(take => {
        this.record("take-ready-get-result", { keyId: message.keyId, streamId: message.streamId,
          decoded: !!take, readyEpoch, seatEpoch: this.epoch, running: this.running });
        if (take && readyEpoch === this.epoch && this.running)
          this.playStored(message.keyId, take, AudioTransportCore.cueOf(params), "http-take");
      });
    } else if (message.kind === "unavailable") this.pendingEvents.delete(message.keyId);
  }
}

/** The slice of `DedicatedWorkerGlobalScope` the installer uses (the project's lib is DOM, not WebWorker). */
export interface AudioTransportWorkerScope {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", fn: (event: MessageEvent) => void): void;
  close?(): void;
  WebSocket?: typeof WebSocket;
  fetch?: typeof fetch;
}

/**
 * The worker's whole entry. An explicit exported call rather than top-level side effects: a side-effect-only
 * worker entry over aliased code has been tree-shaken to an empty chunk before (see the MSDF worker).
 * A handler that throws reports `fallback` so the page returns the viewer to the main-thread engine.
 */
export function installAudioTransportWorker(scope: AudioTransportWorkerScope,
  overrides: Partial<AudioTransportDeps> = {}): AudioTransportCore {
  const postMain = overrides.postMain ?? ((msg: WorkerToMain, transfer: Transferable[] = []) => scope.postMessage(msg, transfer));
  const core = new AudioTransportCore({
    WebSocketCtor: overrides.WebSocketCtor ?? scope.WebSocket ?? WebSocket,
    fetcher: overrides.fetcher ?? scope.fetch ?? fetch,
    postMain, postSink: overrides.postSink, now: overrides.now
  }, () => scope.close?.());
  scope.addEventListener("message", event => {
    try { core.handle(event.data as MainToWorker); }
    catch (error) {
      postMain({ kind: "fallback", reason: `${AUDIO_TRANSPORT_WORKER_ENTRY}: ${error instanceof Error ? error.message : String(error)}` });
    }
  });
  return core;
}
