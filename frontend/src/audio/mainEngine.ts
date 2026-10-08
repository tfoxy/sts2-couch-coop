import type { SeatAudioEvent, AudioFrame, RenderOutbound } from "./audioWire";
import type { AudioContextLike, AudioUnlockEnv, AudioUnlockHandle } from "./audioUnlock";
import { browserAudioEnv, createAudioUnlock } from "./audioUnlock";
import { applyVolumeSnapshot, DEFAULT_SEAT_VOLUMES, hasVolumeSnapshot, laneGain, sfxEventGain, type SeatVolumes } from "./audioGains";
import { openRenderLane, type RenderLaneHandle } from "./renderLane";
import { openSeatAudioLane, type SeatLaneHandle } from "./seatAudioLane";
import { TakeStore } from "./takeStore";
import { StreamVoice } from "./streamVoice";
import { VoiceCap, type VoiceRecord } from "./voiceCap";
import { createKeepAlive, type KeepAliveHandle } from "./keepAlive";
import { installAudioDiagnostics, outputLeadMs } from "./fastTrackProbe";
import { hostUrl } from "@/join/hostBase";
import { assetVersion } from "@/join/assetVersion";
import { tmpSfxUrl } from "./audioRoutes";

let nextAudioConnectionId = 0;

export interface AudioEngineOptions {
  seatUrl: string; renderUrl: string; indexUrl: string;
  fetcher?: typeof fetch; WebSocketCtor?: typeof WebSocket;
  audioEnv?: AudioUnlockEnv;
  onUnavailable?: () => void;
}
export interface AudioEngineHandle { unlock(): Promise<boolean>; start(): void; setSeatUrl(url: string): void; stop(): void; dispose(): void; }

/**
 * Seams the facade (audioEngine.ts) uses when it hands a viewer back to this engine after a worker/worklet
 * path failed: the already-unlocked context's unlocker (so no second context or prelude is created), and
 * the `audioPath`/fallback facts the diagnostics snapshot reports. Absent, this is today's engine exactly.
 */
export interface MainAudioEngineOptions extends AudioEngineOptions {
  unlocker?: AudioUnlockHandle;
  audioPath?: string;
  /** What `?audioPath=` asked for and why this path runs, for the diagnostics snapshot. */
  audioPathRequested?: string;
  audioPathReason?: string;
  fallback?: { from: string; reason: string };
}

/**
 * Per-tab audio lifecycle on the main thread — the `?audioPath=main` path, and the body every viewer ran
 * before the worker transport existed. No context, sockets or fetches are created until the viewer opts in
 * and unlocks.
 */
export function createMainAudioEngine(options: MainAudioEngineOptions): AudioEngineHandle {
  const unlocker = options.unlocker ?? createAudioUnlock(options.audioEnv ?? browserAudioEnv());
  const voices = new VoiceCap(4);
  const lanes = new Map<number, StreamVoice>();
  let seat: SeatLaneHandle | null = null, render: RenderLaneHandle | null = null;
  let context: AudioContextLike | null = null, store: TakeStore | null = null;
  let volumes: SeatVolumes = { ...DEFAULT_SEAT_VOLUMES };
  let volumesKnown = false;
  let running = false, disposed = false;
  let keepAlive: KeepAliveHandle | null = null;
  let cacheFillTimer: ReturnType<typeof setTimeout> | null = null;
  let cacheFillAbort: AbortController | null = null;
  let seatWorkAbort = new AbortController();
  let bankset = "";
  let desiredLanes = { kind: "lanes" as const, music: true, ambience: true, loops: true };
  const tmpsfx = new Map<string, AudioBuffer>();
  let currentSeatUrl = options.seatUrl;
  let seatEpoch = 0;
  const audioDiagnosticsEnabled = new URLSearchParams(globalThis.location?.search ?? "").get("audioDiag") === "1";
  const diagnosticEvents: Array<Record<string, unknown>> = [];
  let diagnosticSeq = 0;
  let diagnosticLost = 0;
  let requestOrder = 0;
  const recordDiagnostic = (type: string, fields: Record<string, unknown> = {}): void => {
    if (!audioDiagnosticsEnabled) return;
    const performanceMs = performance.now();
    const includeOutput = type === "source-scheduled" || type === "lane-source-scheduled" || type === "host-clock-sample";
    const output = includeOutput ? context?.getOutputTimestamp?.() ?? null : null;
    diagnosticEvents.push({ seq: ++diagnosticSeq, type, performanceMs, contextTime: context?.currentTime ?? null,
      ...(includeOutput ? { outputTimestamp: output ? { contextTime: output.contextTime, performanceTime: output.performanceTime } : null } : {}), ...fields });
    if (diagnosticEvents.length > 1024) { diagnosticEvents.shift(); diagnosticLost++; }
  };
  installAudioDiagnostics(audioDiagnosticsEnabled, () => {
    const output = context?.getOutputTimestamp?.() ?? null;
    return {
      running, contextState: context?.state ?? "closed", visible: typeof document === "undefined" || document.visibilityState === "visible",
      performanceMs: performance.now(), performanceTimeOriginMs: performance.timeOrigin, lastSeq: diagnosticSeq,
      firstSeq: diagnosticEvents[0]?.seq ?? diagnosticSeq + 1, lostEvents: diagnosticLost,
      voices: voices.count(), lanes: [...lanes.keys()], outputLeadMs: context ? outputLeadMs(context) : null,
      outputTimestamp: output ? { contextTime: output.contextTime, performanceTime: output.performanceTime } : null,
      events: diagnosticEvents.slice(), audioPath: options.audioPath ?? "main",
      audioPathRequested: options.audioPathRequested ?? null, audioPathReason: options.audioPathReason ?? null
    };
  }, () => {
    if (!running || !render) return false;
    render.probeClock(); return true;
  });
  if (options.fallback) recordDiagnostic("audio-path-fallback", { ...options.fallback, to: "main" });

  const closeLanes = (): void => { seat?.close(); render?.close(); seat = render = null; };
  const laneGainNodes = new Map<number, GainNode>();
  const updateLaneGains = (): void => {
    for (const [lane, node] of laneGainNodes) node.gain.setTargetAtTime(laneGain(volumes, lane === 1 ? "music" : lane === 2 ? "ambience" : "loops"), context!.currentTime, 0.015);
    desiredLanes = { kind: "lanes", music: volumesKnown && laneGain(volumes, "music") > 0, ambience: volumesKnown && laneGain(volumes, "ambience") > 0, loops: volumesKnown && laneGain(volumes, "loops") > 0 };
    render?.request(desiredLanes);
    recordDiagnostic("lane-subscription", { ...desiredLanes });
  };
  const playBuffer = (keyId: string, buffer: AudioBuffer, gainValue: number, pitch: number,
    sourcePath: string, seatTUs: number, order?: number, connectionId?: number): void => {
    if (!context || !running || gainValue <= 0) return;
    const gain = context.createGain(); gain.gain.value = gainValue; gain.connect(context.destination);
    const source = context.createBufferSource(); source.buffer = buffer; source.playbackRate.value = Number.isFinite(pitch) ? Math.max(.25, Math.min(4, pitch)) : 1; source.connect(gain);
    const record: VoiceRecord = { keyId, stop(fadeMs) {
      const now = context?.currentTime ?? 0; gain.gain.cancelScheduledValues(now); gain.gain.setTargetAtTime(0, now, fadeMs / 3000);
      try { source.stop(now + fadeMs / 1000); } catch { /* ended */ }
    } };
    voices.add(record); keepAlive?.update(); source.onended = () => { voices.remove(record); source.disconnect(); gain.disconnect(); keepAlive?.update(); };
    const scheduledContextTime = context.currentTime;
    source.start(); recordDiagnostic("source-scheduled", { lane: "sfx", keyId,
      ...(sourcePath.includes("tmpsfx") ? { resPath: keyId } : {}), sourcePath, seatTUs,
      scheduledContextTime, pitch, connectionId, ...(order ? { requestOrder: order } : {}) });
  };
  const onSeatEvent = async (event: SeatAudioEvent, connectionId: number, callbackOrder?: number): Promise<void> => {
    const eventEpoch = seatEpoch;
    const order = audioDiagnosticsEnabled && (event.kind === "sfx" || event.kind === "tmpsfx") ? ++requestOrder : 0;
    if (audioDiagnosticsEnabled) recordDiagnostic("seat-event-received", { connectionId, callbackOrder, kind: event.kind,
      ...(order ? { requestOrder: order } : {}), ...( "t" in event ? { seatTUs: event.t } : {}),
      ...("keyId" in event ? { keyId: event.keyId } : {}), ...("resPath" in event ? { resPath: event.resPath } : {}),
      ...("pitch" in event ? { pitch: event.pitch, volume: event.volume } : {}) });
    if (!context || !running) return;
    if (event.kind === "volumes") { volumes = applyVolumeSnapshot(volumes, event); volumesKnown ||= hasVolumeSnapshot(event); updateLaneGains(); return; }
    if (event.kind === "loop") { updateLaneGains(); return; }
    if (!volumesKnown) return;
    const gain = sfxEventGain(volumes, event);
    if (gain <= 0) return;
    if (event.kind === "tmpsfx") {
      const path = event.resPath;
      const url = tmpSfxUrl(path, assetVersion());
      if (!url) return;
      let buffer = tmpsfx.get(path);
      const decoded = buffer !== undefined;
      if (!buffer) {
        try {
          const response = await (options.fetcher ?? fetch).call(globalThis, url, { signal: seatWorkAbort.signal });
          if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 2 * 1024 * 1024) return;
          const data = await response.arrayBuffer();
          buffer = await context.decodeAudioData(data);
          if (eventEpoch !== seatEpoch || !running) return;
          tmpsfx.set(path, buffer);
        } catch { return; }
      }
      if (eventEpoch !== seatEpoch || !running) return;
      playBuffer(path, buffer, gain, event.pitch, decoded ? "decoded-tmpsfx" : "http-tmpsfx", event.t, order, connectionId); return;
    }
    if (event.kind === "sfx") {
      const decoded = store?.hasDecoded(event.keyId) ?? false;
      const buffer = await store?.get(event.keyId, seatWorkAbort.signal);
      if (eventEpoch !== seatEpoch || !running) return;
      if (buffer) { playBuffer(event.keyId, buffer, gain, event.pitch, decoded ? "decoded-cache" : "http-take", event.t, order, connectionId); return; }
      const queued = pendingEvents.get(event.keyId) ?? [];
      queued.push({ gain, pitch: event.pitch, seatTUs: event.t, requestOrder: order, seatConnectionId: connectionId }); pendingEvents.set(event.keyId, queued.slice(-4));
      render?.request({ kind: "play", keyId: event.keyId, key: event.key },
        audioDiagnosticsEnabled ? { seatTUs: event.t, requestOrder: order } : undefined);
    }
  };
  const onFrame = (frame: AudioFrame, connectionId: number, callbackOrder?: number): void => {
    if (audioDiagnosticsEnabled && (frame.kind !== 2 || frame.blockIndex % 16 === 0))
      recordDiagnostic("pcm-frame-received", { connectionId, callbackOrder, kind: frame.kind, lane: frame.lane,
        streamId: frame.streamId, blockIndex: frame.blockIndex, dueUs: frame.dueUs.toString(),
        sentUs: frame.sentUs.toString(), frames: frame.frames, flags: frame.flags });
    if (!context || !running) return;
    if (frame.kind === 2) {
      const lane = frame.lane;
      let voice = lanes.get(lane);
      if (!voice) {
        const gain = context.createGain(); gain.gain.value = laneGain(volumes, lane === 1 ? "music" : lane === 2 ? "ambience" : "loops"); gain.connect(context.destination);
        laneGainNodes.set(lane, gain);
        voice = new StreamVoice(context, gain, () => keepAlive?.update(), audioDiagnosticsEnabled
          ? (block, decision, scheduledContextTime) => {
            if (block.blockIndex % 16 !== 0 && !decision.dropped && !decision.reanchored) return;
            recordDiagnostic("lane-source-scheduled", { connectionId,
            sourcePath: "live-lane", lane: block.lane, streamId: block.streamId, blockIndex: block.blockIndex,
            dueUs: block.dueUs.toString(), sentUs: block.sentUs.toString(), scheduledContextTime,
            dropped: decision.dropped, reanchored: decision.reanchored
            });
          } : undefined);
        lanes.set(lane, voice);
      }
      if (!(frame.flags & 4)) voice.push(frame);
      else { voice.stop(); lanes.delete(lane); laneGainNodes.get(lane)?.disconnect(); laneGainNodes.delete(lane); }
      keepAlive?.update();
    } else {
      playTakeFrame(frame, connectionId);
    }
  };
  interface TakeStream { keyId: string; gain: number; pitch: number; seatTUs: number; requestOrder: number; seatConnectionId: number; frames: AudioFrame[]; gainNode: GainNode; sources: Set<AudioBufferSourceNode>; nextAt: number; voice: VoiceRecord; finished: boolean; ready: boolean; }
  const takeStreams = new Map<number, TakeStream>();
  const pendingEvents = new Map<string, Array<{ gain: number; pitch: number; seatTUs: number; requestOrder: number; seatConnectionId: number }>>();
  const fallbackStarted = new Set<number>();
  const playTakeFrame = (frame: AudioFrame, connectionId: number): void => {
    if (!context) return;
    const stream = takeStreams.get(frame.streamId);
    if (!stream || fallbackStarted.has(frame.streamId)) return;
    stream.frames.push(frame);
    const now = context.currentTime, startAt = Math.max(now + 0.005, stream.nextAt);
    const buffer = context.createBuffer(2, frame.frames, 48_000), left = buffer.getChannelData(0), right = buffer.getChannelData(1);
    for (let i = 0; i < frame.frames; i++) { left[i] = frame.pcm[i * 2] / 32768; right[i] = frame.pcm[i * 2 + 1] / 32768; }
    const source = context.createBufferSource(); source.buffer = buffer; source.playbackRate.value = stream.pitch;
    const blockGain = context.createGain();
    if (stream.nextAt < now + 0.001) { blockGain.gain.setValueAtTime(0, startAt); blockGain.gain.linearRampToValueAtTime(1, startAt + 0.005); }
    source.connect(blockGain); blockGain.connect(stream.gainNode); stream.sources.add(source);
    source.onended = () => {
      stream.sources.delete(source); source.disconnect(); blockGain.disconnect();
      if (stream.finished && stream.sources.size === 0) {
        voices.remove(stream.voice); stream.gainNode.disconnect(); if (stream.ready) takeStreams.delete(frame.streamId); keepAlive?.update();
      }
    };
    source.start(startAt); stream.nextAt = startAt + frame.frames / (48_000 * stream.pitch);
    recordDiagnostic("source-scheduled", { connectionId, lane: "take", sourcePath: "first-sight-stream", keyId: stream.keyId,
      seatTUs: stream.seatTUs, requestOrder: stream.requestOrder, seatConnectionId: stream.seatConnectionId,
      streamId: frame.streamId,
      blockIndex: frame.blockIndex, dueUs: frame.dueUs.toString(), sentUs: frame.sentUs.toString(),
      scheduledContextTime: startAt, pitch: stream.pitch, frames: frame.frames });
    if (frame.flags & 2) {
      stream.finished = true;
      const count = stream.frames.reduce((sum, block) => sum + block.frames, 0), pcm = new Int16Array(count * 2);
      let offset = 0; for (const block of stream.frames) { pcm.set(block.pcm, offset * 2); offset += block.frames; }
      const take = context.createBuffer(2, count, 48_000), l = take.getChannelData(0), r = take.getChannelData(1);
      for (let i = 0; i < count; i++) { l[i] = pcm[i * 2] / 32768; r[i] = pcm[i * 2 + 1] / 32768; }
      store?.setBuffer(stream.keyId, take);
    }
    keepAlive?.update();
  };
  const scheduleCacheFill = (): void => {
    if (!running || cacheFillTimer !== null || !cacheFillAbort || cacheFillAbort.signal.aborted) return;
    const currentStore = store, signal = cacheFillAbort.signal;
    cacheFillTimer = setTimeout(() => {
      cacheFillTimer = null;
      if (running && currentStore === store && !signal.aborted) void currentStore?.fillHttpCache(signal);
    }, 0);
  };
  const onRenderMessage = (message: RenderOutbound, connectionId: number, callbackOrder?: number): void => {
    if (audioDiagnosticsEnabled) recordDiagnostic("render-message-received", { connectionId, callbackOrder,
      kind: message.kind, ...( "keyId" in message ? { keyId: message.keyId } : {}),
      ...( "streamId" in message ? { streamId: message.streamId } : {}) });
    if (message.kind === "clock") recordDiagnostic("host-clock-sample", {
      clockSeq: message.seq ?? null, clientSendPerfMs: message.clientPerfMs ?? null,
      hostReceiveUs: message.hostUs, hostSendUs: message.sentUs,
      clientReceivePerfMs: performance.now()
    });
    else if (message.kind === "hello") { bankset = message.bankset; void store?.warm(options.indexUrl); render?.request(desiredLanes); }
    else if (message.kind === "take-start") {
      const queued = pendingEvents.get(message.keyId) ?? [], params = queued.shift();
      if (queued.length) pendingEvents.set(message.keyId, queued); else pendingEvents.delete(message.keyId);
      if (!params || !context) return;
      const gainNode = context.createGain(); gainNode.gain.value = params.gain; gainNode.connect(context.destination);
      const stream = { keyId: message.keyId, gain: params.gain, pitch: params.pitch, seatTUs: params.seatTUs,
        requestOrder: params.requestOrder, seatConnectionId: params.seatConnectionId,
        frames: [], gainNode, sources: new Set<AudioBufferSourceNode>(), nextAt: context.currentTime + 0.005,
        voice: undefined as unknown as VoiceRecord, finished: false, ready: false } satisfies TakeStream;
      const voice: VoiceRecord = { keyId: message.keyId, stop(fadeMs) {
        const now = context?.currentTime ?? 0; gainNode.gain.cancelScheduledValues(now); gainNode.gain.setTargetAtTime(0, now, fadeMs / 3000);
        for (const source of stream.sources) { try { source.stop(now + fadeMs / 1000); } catch { /* ended */ } }
      } };
      stream.voice = voice;
      voices.add(voice); keepAlive?.update(); takeStreams.set(message.streamId, stream);
    }
    else if (message.kind === "take-ready") {
      const stream = takeStreams.get(message.streamId);
      recordDiagnostic("take-ready-received", { keyId: message.keyId, streamId: message.streamId,
        url: message.url, streamTracked: !!stream, streamFrames: stream?.frames.length ?? 0,
        pendingCount: pendingEvents.get(message.keyId)?.length ?? 0, seatEpoch, running });
      if (store?.setUrl(message.keyId, hostUrl(message.url))) scheduleCacheFill();
      if (stream) { stream.ready = true; if (stream.finished && stream.sources.size === 0) takeStreams.delete(message.streamId); return; }
      const queued = pendingEvents.get(message.keyId) ?? [], params = queued.shift();
      if (queued.length) pendingEvents.set(message.keyId, queued); else pendingEvents.delete(message.keyId);
      if (!params) { recordDiagnostic("take-ready-no-pending", { keyId: message.keyId, streamId: message.streamId }); return; }
      fallbackStarted.add(message.streamId);
      const readyEpoch = seatEpoch;
      void store?.get(message.keyId, seatWorkAbort.signal, "take-ready").then(buffer => {
        recordDiagnostic("take-ready-get-result", { keyId: message.keyId, streamId: message.streamId,
          decoded: !!buffer, readyEpoch, seatEpoch, running });
        if (buffer && readyEpoch === seatEpoch && running)
          playBuffer(message.keyId, buffer, params.gain, params.pitch, "http-take", params.seatTUs,
            params.requestOrder, params.seatConnectionId);
      });
    } else if (message.kind === "unavailable") pendingEvents.delete(message.keyId);
  };

  const openLanes = (): void => {
    const epoch = seatEpoch;
    const seatConnectionId = ++nextAudioConnectionId;
    const renderConnectionId = ++nextAudioConnectionId;
    seat = openSeatAudioLane(currentSeatUrl, (event, callbackOrder) => {
      if (epoch === seatEpoch) void onSeatEvent(event, seatConnectionId, callbackOrder);
    }, options.WebSocketCtor, audioDiagnosticsEnabled ? recordDiagnostic : undefined, seatConnectionId);
    render = openRenderLane(options.renderUrl,
      (frame, callbackOrder) => { if (epoch === seatEpoch) onFrame(frame, renderConnectionId, callbackOrder); },
      (message, callbackOrder) => { if (epoch === seatEpoch) onRenderMessage(message, renderConnectionId, callbackOrder); },
      options.WebSocketCtor, () => {
        if (epoch === seatEpoch) { options.onUnavailable?.(); stop(); }
      }, audioDiagnosticsEnabled ? recordDiagnostic : undefined, renderConnectionId);
    render.request(desiredLanes);
  };
  const start = (): void => {
    if (disposed || !context || context.state !== "running" ||
        (typeof document !== "undefined" && document.visibilityState !== "visible")) return;
    seatEpoch++;
    if (seatWorkAbort.signal.aborted) seatWorkAbort = new AbortController();
    running = true; closeLanes(); lanes.clear(); laneGainNodes.clear();
    keepAlive?.dispose();
    keepAlive = createKeepAlive(context as unknown as AudioContext, () => voices.count() === 0 && [...lanes.values()].every(lane => lane.activeCount() === 0));
    store = new TakeStore(context, options.fetcher ?? fetch, recordDiagnostic);
    cacheFillAbort = new AbortController();
    const currentStore = store;
    void store.warm(options.indexUrl).then(() => {
      if (running && currentStore === store) scheduleCacheFill();
    });
    desiredLanes = { kind: "lanes", music: volumesKnown && laneGain(volumes, "music") > 0, ambience: volumesKnown && laneGain(volumes, "ambience") > 0, loops: volumesKnown && laneGain(volumes, "loops") > 0 };
    openLanes();
  };
  const stop = (): void => {
    seatEpoch++;
    running = false; keepAlive?.dispose(); keepAlive = null;
    if (cacheFillTimer !== null) clearTimeout(cacheFillTimer); cacheFillTimer = null;
    cacheFillAbort?.abort(); cacheFillAbort = null;
    seatWorkAbort.abort();
    closeLanes(); voices.stopAll();
    for (const lane of lanes.values()) lane.stop(); lanes.clear(); laneGainNodes.clear();
    for (const stream of takeStreams.values()) { for (const source of stream.sources) { try { source.stop(); } catch { /* ended */ } } stream.gainNode.disconnect(); }
    takeStreams.clear(); pendingEvents.clear(); fallbackStarted.clear();
    if (context?.state === "running") void context.suspend();
  };
  const resetSeatPlayback = (): void => {
    voices.stopAll();
    for (const stream of takeStreams.values()) {
      for (const source of stream.sources) { try { source.stop(); } catch { /* already ended */ } }
      stream.gainNode.disconnect();
    }
    takeStreams.clear(); pendingEvents.clear(); fallbackStarted.clear();
    for (const lane of lanes.values()) lane.stop();
    lanes.clear(); for (const node of laneGainNodes.values()) node.disconnect(); laneGainNodes.clear();
    keepAlive?.update();
  };
  return {
    async unlock() {
      const unlockEpoch = seatEpoch;
      const unlocked = await unlocker.unlock();
      context = unlocked;
      if (!unlocked) { options.onUnavailable?.(); return false; }
      if (unlockEpoch !== seatEpoch ||
          (typeof document !== "undefined" && document.visibilityState !== "visible")) {
        try { await unlocked.suspend(); } catch { /* a later gesture can retry */ }
      }
      recordDiagnostic("context-unlocked", { state: unlocked.state }); return true;
    }, start,
    setSeatUrl(url) {
      if (url === currentSeatUrl) return;
      seatEpoch++;
      seatWorkAbort.abort(); seatWorkAbort = new AbortController();
      resetSeatPlayback();
      currentSeatUrl = url; volumes = { ...DEFAULT_SEAT_VOLUMES }; volumesKnown = false;
      if (running && context?.state === "running") {
        closeLanes();
        openLanes();
        updateLaneGains();
      }
    },
    stop,
    dispose() { if (disposed) return; disposed = true; stop(); unlocker.dispose(); context = null; }
  };
}
