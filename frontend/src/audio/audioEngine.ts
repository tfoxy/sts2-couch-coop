// The per-tab audio engine MirrorApp creates. A facade over three playback paths, chosen once per engine by
// `resolveAudioPath` (audioPath.ts) — `main` unless `?audioPath=` asks otherwise while
// AUDIO_PATH_AUTO_DEFAULT is off:
//
//   main    — mainEngine.ts, today's engine, unchanged (sockets, decode and scheduling on the main thread).
//   worker  — a dedicated Worker (audioTransportCore.ts) owns both audio sockets, JSON parse, PCM decode
//             and all bookkeeping, and posts ready SinkCommands to a main-thread MainSink (mainSink.ts).
//   worklet — the same Worker, posting SinkCommands straight to the AudioWorklet mixer (workletSink.ts)
//             over a transferred MessagePort; the main thread is off the audio path entirely.
//
// Whatever the path, the rules mainEngine.ts keeps stay true here: no context, socket or fetch before the
// viewer unlocks (the Worker is spawned at unlock, and opens sockets only on `start`); hidden tabs do not
// start; a seat switch or stop silences everything immediately — the main thread fences the sink itself
// rather than waiting for the Worker to notice.
//
// FALLBACK. A Worker that cannot be constructed (e.g. the remote-hosted web-link page, where the script is
// cross-origin), that fails to load, or that reports `fallback` hands the viewer to mainEngine for the rest
// of the engine's life, reusing the already-unlocked context. A worklet sink that cannot be created at
// first unlock degrades to the worker path; one that cannot be recreated after a FAST-track context
// recreate falls back to main. Each records `audio-path-fallback`.
import { createMainAudioEngine, type AudioEngineHandle, type AudioEngineOptions } from "./mainEngine";
import { detectAudioPathEnv, resolveAudioCoalesce, resolveAudioPath, type AudioPath, type AudioPathEnv, type ResolveAudioPathResult } from "./audioPath";
import type { AudioDiagEventWire, AudioSinkMode, AudioSinkPcmFormat, MainToWorker, SinkCommand, WorkerToMain } from "./audioSinkProtocol";
import { browserAudioEnv, createAudioUnlock, type AudioContextLike } from "./audioUnlock";
import { installAudioDiagnostics, outputLeadMs } from "./fastTrackProbe";
import { MainSink } from "./mainSink";
import { createWorkletSink, type WorkletSinkHandle } from "./workletSink";
import { AudioDiagRing } from "./audioDiagRing";
import { hostBase, isRemoteHosted } from "@/join/hostBase";
import { assetVersion, whenAssetVersion } from "@/join/assetVersion";

export type { AudioEngineHandle, AudioEngineOptions } from "./mainEngine";

/** The slice of `Worker` the facade uses — a seam so specs can wire the transport core in-process. */
export interface AudioWorkerLike {
  postMessage(msg: MainToWorker, transfer?: Transferable[]): void;
  addEventListener(type: "message" | "error", fn: (event: MessageEvent) => void): void;
  terminate(): void;
}

export interface AudioEngineFacadeOptions extends AudioEngineOptions {
  /** Test seam: the environment `resolveAudioPath` reads. Default: the live page. */
  pathEnv?: AudioPathEnv;
  /** Test seam: spawns the transport Worker. Default: Vite's worker-URL form below. */
  createWorker?: () => AudioWorkerLike;
  /** Test seam: creates the worklet mixer sink. Default: workletSink.ts. */
  createWorkletSink?: (context: AudioContext) => Promise<WorkletSinkHandle>;
}

/** Vite's worker-URL form — it is what makes the worker its own emitted chunk. Must stay a literal. */
const defaultWorkerFactory = (): AudioWorkerLike =>
  new Worker(new URL("./audioTransport.worker.ts", import.meta.url), { type: "module" }) as unknown as AudioWorkerLike;

export function createAudioEngine(options: AudioEngineFacadeOptions): AudioEngineHandle {
  const env = options.pathEnv ?? detectAudioPathEnv();
  const resolved = resolveAudioPath(env);
  if (resolved.path === "main") return createMainAudioEngine({ ...options, audioPath: "main",
    audioPathRequested: resolved.requested, audioPathReason: resolved.reason });
  return createOffThreadAudioEngine(options, resolved, env);
}

type WorkletWithDiag = WorkletSinkHandle & { onDiag?: (events: AudioDiagEventWire[]) => void };

function createOffThreadAudioEngine(options: AudioEngineFacadeOptions, resolved: ResolveAudioPathResult,
  env: AudioPathEnv): AudioEngineHandle {
  const unlocker = createAudioUnlock(options.audioEnv ?? browserAudioEnv());
  const diagEnabled = new URLSearchParams(globalThis.location?.search ?? "").get("audioDiag") === "1";
  const ring = new AudioDiagRing(diagEnabled);
  let path: Exclude<AudioPath, "main"> = resolved.path === "worklet" ? "worklet" : "worker";
  let delegate: AudioEngineHandle | null = null;
  let worker: AudioWorkerLike | null = null;
  let initSent = false;
  let sinkMode: AudioSinkMode | null = null;
  let context: AudioContextLike | null = null;
  let mainSink: MainSink | null = null;
  let worklet: WorkletWithDiag | null = null;
  let epoch = 0;
  let running = false, disposed = false;
  let currentSeatUrl = options.seatUrl;
  let seatWork = new AbortController();
  let sentAssetToken = assetVersion() ?? "";
  const tmpsfx = new Map<string, AudioBuffer>();
  const hidden = (): boolean => typeof document !== "undefined" && document.visibilityState !== "visible";

  const record = (type: string, fields: Record<string, unknown> = {}): void => {
    if (!diagEnabled) return;
    const includeOutput = type === "source-scheduled" || type === "lane-source-scheduled" || type === "host-clock-sample";
    const output = includeOutput ? context?.getOutputTimestamp?.() ?? null : null;
    ring.push(type, performance.now(), { contextTime: context?.currentTime ?? null,
      ...(includeOutput ? { outputTimestamp: output ? { contextTime: output.contextTime, performanceTime: output.performanceTime } : null } : {}),
      ...fields });
  };
  installAudioDiagnostics(diagEnabled, () => {
    const output = context?.getOutputTimestamp?.() ?? null;
    return {
      running, contextState: context?.state ?? "closed", visible: !hidden(),
      performanceMs: performance.now(), performanceTimeOriginMs: performance.timeOrigin, lastSeq: ring.lastSeq,
      firstSeq: ring.firstSeq, lostEvents: ring.lostEvents,
      voices: mainSink?.voiceCount() ?? 0, lanes: mainSink?.laneKeys() ?? [], outputLeadMs: context ? outputLeadMs(context) : null,
      outputTimestamp: output ? { contextTime: output.contextTime, performanceTime: output.performanceTime } : null,
      events: ring.events.slice(), audioPath: path, audioPathRequested: resolved.requested, audioPathReason: resolved.reason,
      sinkMode
    };
  }, () => {
    if (!running || !worker) return false;
    post({ kind: "probe-clock" }); return true;
  });

  const post = (msg: MainToWorker, transfer: Transferable[] = []): void => { worker?.postMessage(msg, transfer); };

  const syncAssetToken = (): void => {
    const token = assetVersion() ?? "";
    if (!initSent || token === sentAssetToken) return;
    sentAssetToken = token; post({ kind: "asset-token", token });
  };
  if (assetVersion() === null) whenAssetVersion(syncAssetToken);

  const fenceSink = (): void => {
    mainSink?.fence(epoch);
    worklet?.post({ kind: "fence", epoch });
  };

  const teardownOffThread = (): void => {
    if (worker) { post({ kind: "dispose" }); worker.terminate(); worker = null; }
    mainSink?.dispose(); mainSink = null;
    worklet?.dispose(); worklet = null;
  };

  const switchToMain = (reason: string): AudioEngineHandle => {
    if (delegate) return delegate;
    const from = path, wasRunning = running;
    record("audio-path-fallback", { from, reason, to: "main" });
    running = false;
    teardownOffThread();
    delegate = createMainAudioEngine({ ...options, seatUrl: currentSeatUrl, unlocker, audioPath: "main", fallback: { from, reason },
      audioPathRequested: resolved.requested, audioPathReason: `fallback: ${reason}` });
    if (wasRunning && !disposed && context?.state === "running" && !hidden()) {
      const target = delegate;
      void target.unlock().then(ok => { if (ok && delegate === target && !disposed) target.start(); });
    }
    return delegate;
  };

  const onSinkCommand = (cmd: SinkCommand): void => {
    if (diagEnabled && "postMs" in cmd && (cmd.kind !== "lane-blocks" || cmd.blocks.some(block => block.blockIndex % 16 === 0))) {
      const receiptMs = performance.now();
      record("main-receipt", { kind: cmd.kind, postMs: cmd.postMs, waitMs: receiptMs - cmd.postMs,
        ...("key" in cmd ? { keyId: cmd.key } : {}), ...("streamId" in cmd ? { streamId: cmd.streamId } : {}) });
    }
    mainSink?.apply(cmd);
  };

  const decodeTmpSfx = async (msg: Extract<WorkerToMain, { kind: "tmpsfx-decode" }>): Promise<void> => {
    if (msg.epoch !== epoch || !running || !context) return;
    const ctx = context, signal = seatWork.signal;
    let buffer = tmpsfx.get(msg.path);
    const decoded = buffer !== undefined;
    if (!buffer) {
      try {
        const response = await (options.fetcher ?? fetch).call(globalThis, msg.url, { signal });
        if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 2 * 1024 * 1024) throw new Error("tmpsfx response");
        buffer = await ctx.decodeAudioData(await response.arrayBuffer());
        tmpsfx.set(msg.path, buffer);
      } catch {
        if (msg.epoch === epoch) post({ kind: "tmpsfx-failed", epoch: msg.epoch, path: msg.path });
        return;
      }
    }
    if (msg.epoch !== epoch || !running) return;
    const play: Extract<SinkCommand, { kind: "play" }> = { kind: "play", epoch: msg.epoch, key: msg.path, sourcePath: "tmpsfx",
      postMs: performance.now(), ...msg.cue };
    if (mainSink) {
      mainSink.loadBuffer(msg.path, buffer);
      mainSink.apply(play, decoded ? "decoded-tmpsfx" : "http-tmpsfx");
    } else if (worklet) {
      const channels: Float32Array[] = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice());
      worklet.post({ kind: "load", epoch: msg.epoch, key: msg.path, rate: buffer.sampleRate,
        pcm: { format: "f32-planar", channels, frames: buffer.length } }, channels.map(plane => plane.buffer as ArrayBuffer));
      worklet.post({ ...play, diagSourcePath: decoded ? "decoded-tmpsfx" : "http-tmpsfx" });
    } else return;
    post({ kind: "tmpsfx-resident", epoch: msg.epoch, path: msg.path });
  };

  const onWorkerMessage = (event: MessageEvent): void => {
    if (disposed || delegate) return;
    const msg = event.data as WorkerToMain;
    switch (msg.kind) {
      case "sink": return onSinkCommand(msg.cmd);
      case "diag": ring.ingest(msg.events); return;
      case "unavailable": if (msg.epoch === epoch) { options.onUnavailable?.(); handle.stop(); } return;
      case "fallback": switchToMain(msg.reason); return;
      case "tmpsfx-decode": void decodeTmpSfx(msg); return;
      case "ready": record("worker-ready"); return;
    }
  };

  const spawnWorker = (): boolean => {
    try { worker = (options.createWorker ?? defaultWorkerFactory)(); }
    catch (error) { record("worker-spawn-failed", { error: error instanceof Error ? error.message : String(error) }); return false; }
    worker.addEventListener("message", onWorkerMessage);
    worker.addEventListener("error", () => { if (!disposed) switchToMain("worker-error"); });
    return true;
  };

  const sendInit = (mode: AudioSinkMode, pcm: AudioSinkPcmFormat): void => {
    if (initSent) return;
    initSent = true; sinkMode = mode; sentAssetToken = assetVersion() ?? "";
    post({ kind: "init", mainTimeOrigin: performance.timeOrigin, diag: diagEnabled,
      hostBase: isRemoteHosted() ? hostBase() : "", assetToken: sentAssetToken,
      indexUrl: options.indexUrl, renderUrl: options.renderUrl, sinkMode: mode, pcm, coalesce: resolveAudioCoalesce(env.search) });
  };

  /** Creates (or, after a context recreate, rebuilds) the sink for `ctx`, then makes sure `init` went out. */
  const ensureSink = async (ctx: AudioContextLike, recreated: boolean): Promise<void> => {
    if (path === "worklet") {
      if (worklet && !recreated) return;
      if (worklet) { worklet.dispose(); worklet = null; }
      try {
        const sink = await (options.createWorkletSink ?? createWorkletSink)(ctx as unknown as AudioContext) as WorkletWithDiag;
        if (disposed || delegate || context !== ctx) { sink.dispose(); return; }
        worklet = sink;
        // `ready` rejects on a processor error (or our own dispose); only a live, current sink falls back.
        sink.ready?.catch(() => { if (worklet === sink && !disposed && !delegate) switchToMain("worklet-processor-error"); });
        if ("onDiag" in sink) sink.onDiag = events => ring.ingest(events);
        sendInit("port", "s16");
        const sampleRate = (ctx as unknown as { sampleRate?: number }).sampleRate ?? 48_000;
        post({ kind: "port", port: sink.workerPort, sampleRate }, [sink.workerPort]);
        return;
      } catch (error) {
        const reason = `worklet-sink: ${error instanceof Error ? error.message : String(error)}`;
        if (initSent) { switchToMain(reason); return; }
        record("audio-path-fallback", { from: "worklet", reason, to: "worker" });
        path = "worker";
      }
    }
    if (!mainSink) mainSink = new MainSink(ctx, { diag: diagEnabled ? record : undefined });
    else if (recreated) mainSink.setContext(ctx);
    sendInit("post", "f32-planar");
  };

  const handle: AudioEngineHandle = {
    async unlock() {
      if (delegate) return delegate.unlock();
      if (disposed) return false;
      const unlockEpoch = epoch;
      // Spawned before the prelude so the worker script loads in parallel; it opens nothing until `start`.
      if (!worker && !spawnWorker()) return switchToMain("worker-ctor").unlock();
      const prior = context;
      const unlocked = await unlocker.unlock();
      if (delegate) return (delegate as AudioEngineHandle).unlock();
      context = unlocked;
      if (!unlocked) { options.onUnavailable?.(); return false; }
      if (unlockEpoch !== epoch || hidden()) {
        try { await unlocked.suspend(); } catch { /* a later gesture can retry */ }
      }
      await ensureSink(unlocked, prior !== null && prior !== unlocked);
      if (delegate) return (delegate as AudioEngineHandle).unlock();
      record("context-unlocked", { state: unlocked.state }); return true;
    },
    start() {
      if (delegate) return delegate.start();
      if (disposed || !context || context.state !== "running" || hidden() || !worker || !initSent) return;
      epoch++;
      if (seatWork.signal.aborted) seatWork = new AbortController();
      running = true;
      fenceSink();
      mainSink?.startKeepAlive();
      syncAssetToken();
      post({ kind: "start", epoch, seatUrl: currentSeatUrl });
    },
    setSeatUrl(url) {
      if (delegate) return delegate.setSeatUrl(url);
      if (url === currentSeatUrl) return;
      epoch++;
      seatWork.abort(); seatWork = new AbortController();
      fenceSink();
      currentSeatUrl = url;
      syncAssetToken();
      post({ kind: "seat", epoch, seatUrl: url });
    },
    stop() {
      if (delegate) return delegate.stop();
      epoch++;
      running = false;
      fenceSink();
      mainSink?.stopKeepAlive();
      seatWork.abort();
      post({ kind: "stop", epoch });
      if (context?.state === "running") void context.suspend();
    },
    dispose() {
      if (disposed) return;
      if (delegate) { disposed = true; delegate.dispose(); context = null; return; }
      handle.stop();
      disposed = true;
      teardownOffThread();
      unlocker.dispose(); context = null;
    }
  };
  return handle;
}
