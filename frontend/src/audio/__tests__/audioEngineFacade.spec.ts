import { afterEach, describe, expect, it, vi } from "vitest";
import { createAudioEngine, type AudioEngineFacadeOptions, type AudioWorkerLike } from "../audioEngine";
import { createMainAudioEngine } from "../mainEngine";
import { installAudioTransportWorker, type AudioTransportCore } from "../audioTransportCore";
import type { MainToWorker, MainToWorklet } from "../audioSinkProtocol";
import type { AudioPathEnv } from "../audioPath";
import type { AudioContextLike } from "../audioUnlock";
import type { WorkletSinkHandle } from "../workletSink";
import { createFakeWorkerChannelPair, FakeContext, FakeSocket, type FakeWorkerChannel } from "./fakes";
import { laneFrame, settle, takeFrame, wav } from "./audioFrames";
import { AudioFlags } from "../audioWire";

const WARM = "ac148f6ddbd27aba877991055c5a5431";
const COLD = "0123456789abcdef0123456789abcdef";
const SNAPSHOT = { kind: "volumes", snapshot: true, master: 1, sfx: .9, bgm: .8, ambience: .5, godotMasterDb: 0, godotSfxDb: 0 };
const env = (search: string, extra: Partial<AudioPathEnv> = {}): AudioPathEnv =>
  ({ search, isSecureContext: true, hasWorker: true, hasWorklet: true, remoteHosted: false, ...extra });

function rig() {
  const context = new FakeContext();
  const sockets: FakeSocket[] = [];
  const Ctor = class extends FakeSocket { constructor(url: string) { super(url); sockets.push(this); } } as unknown as typeof WebSocket;
  const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/audio/takes"
    ? new Response(JSON.stringify({ schema: 1, bankset: "b", keys: [WARM] }))
    : new Response(wav([100, -100, 200, -200])));
  const base = {
    seatUrl: "ws://host/ws?seat=R&lane=audio", renderUrl: "ws://host/audio", indexUrl: "/audio/takes",
    WebSocketCtor: Ctor, fetcher: fetcher as unknown as typeof fetch,
    audioEnv: { createPrelude: () => ({ play: async () => {}, pause() {}, removeAttribute() {} } as unknown as HTMLAudioElement),
      createContext: () => context as unknown as AudioContextLike }
  };
  return { context, sockets, Ctor, fetcher, base };
}

/** A facade<->core pair wired through the fake postMessage channel instead of a real Worker thread. */
function inProcessWorker(Ctor: typeof WebSocket, fetcher: typeof fetch) {
  const state: { core: AudioTransportCore | null; toWorker: MainToWorker[]; terminated: boolean; main: FakeWorkerChannel | null } =
    { core: null, toWorker: [], terminated: false, main: null };
  const factory = (): AudioWorkerLike => {
    const [mainEnd, workerEnd] = createFakeWorkerChannelPair();
    state.main = mainEnd;
    state.core = installAudioTransportWorker({
      postMessage: (msg, transfer) => workerEnd.postMessage(msg, transfer),
      addEventListener: (_type, fn) => workerEnd.addEventListener("message", fn), close() {}
    }, { WebSocketCtor: Ctor, fetcher });
    return {
      postMessage: (msg, transfer) => { state.toWorker.push(msg); mainEnd.postMessage(msg, transfer); },
      addEventListener: (type, fn) => { if (type === "message") mainEnd.addEventListener("message", fn); },
      terminate: () => { state.terminated = true; }
    };
  };
  return { state, factory };
}

const priorUrl = location.href;
afterEach(() => { history.replaceState({}, "", priorUrl); });

describe("audio engine facade", () => {
  it("keeps today's engine when no path is requested", () => {
    const r = rig();
    const createWorker = vi.fn();
    const engine = createAudioEngine({ ...r.base, pathEnv: env(""), createWorker });
    engine.dispose();
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("falls back to the main engine for good when the Worker cannot be constructed", async () => {
    history.replaceState({}, "", "?audioDiag=1");
    const r = rig();
    const createWorker = vi.fn(() => { throw new DOMException("cross-origin", "SecurityError"); });
    const engine = createAudioEngine({ ...r.base, pathEnv: env("?audioPath=worker"), createWorker });
    expect(await engine.unlock()).toBe(true);
    engine.start();
    expect(r.sockets.map(s => s.url)).toEqual(["ws://host/ws?seat=R&lane=audio", "ws://host/audio"]);
    const snapshot = window.__couchCoopAudioDiag?.();
    expect(snapshot?.audioPath).toBe("main");
    expect((snapshot?.events as Array<Record<string, unknown>>).find(row => row.type === "audio-path-fallback"))
      .toMatchObject({ from: "worker", reason: "worker-ctor", to: "main" });
    expect(await engine.unlock()).toBe(true);
    expect(createWorker).toHaveBeenCalledTimes(1);
    engine.dispose();
  });

  it("degrades a rejecting worklet sink to the worker path and plays through MainSink", async () => {
    const r = rig();
    const worker = inProcessWorker(r.Ctor, r.fetcher as unknown as typeof fetch);
    const engine = createAudioEngine({ ...r.base, pathEnv: env("?audioPath=worklet"), createWorker: worker.factory });
    expect(r.sockets).toHaveLength(0);
    expect(await engine.unlock()).toBe(true);
    expect(r.sockets).toHaveLength(0);
    expect(r.fetcher).not.toHaveBeenCalled();
    expect(worker.state.toWorker[0]).toMatchObject({ kind: "init", sinkMode: "post", pcm: "f32-planar", coalesce: 2 });
    engine.start();
    await settle();
    const [seat, render] = r.sockets; seat.emit("open"); render.emit("open");
    seat.emit("message", JSON.stringify(SNAPSHOT));
    seat.emit("message", JSON.stringify({ kind: "sfx", keyId: WARM, key: "k", t: 1, pitch: .8, volume: .5 }));
    await settle(6);
    expect(r.context.sources).toHaveLength(1);
    expect(r.context.sources[0].playbackRate.value).toBe(.8);
    expect(r.context.sources[0].buffer!.getChannelData(0)[0]).toBeCloseTo(100 / 32768);
    engine.dispose();
    expect(worker.state.terminated).toBe(true);
  });

  it("fences the sink from the main thread on stop and seat switch, before the worker hears of it", async () => {
    const r = rig();
    const worker = inProcessWorker(r.Ctor, r.fetcher as unknown as typeof fetch);
    const engine = createAudioEngine({ ...r.base, pathEnv: env("?audioPath=worker"), createWorker: worker.factory });
    await engine.unlock(); engine.start(); await settle();
    const [seat, render] = r.sockets; seat.emit("open"); render.emit("open");
    seat.emit("message", JSON.stringify(SNAPSHOT));
    seat.emit("message", JSON.stringify({ kind: "sfx", keyId: WARM, key: "k", t: 1, pitch: 1, volume: 1 }));
    await settle(6);
    expect(r.context.sources).toHaveLength(1);
    engine.setSeatUrl("ws://host/ws?seat=S&lane=audio");
    expect(r.context.sources[0].stopped).toBe(true);
    expect(worker.state.toWorker.at(-1)).toEqual({ kind: "seat", epoch: 2, seatUrl: "ws://host/ws?seat=S&lane=audio" });
    await settle();
    expect(r.sockets.slice(2).map(s => s.url)).toEqual(["ws://host/ws?seat=S&lane=audio", "ws://host/audio"]);
    r.sockets[2].emit("open"); r.sockets[3].emit("open");
    r.sockets[2].emit("message", JSON.stringify(SNAPSHOT));
    r.sockets[2].emit("message", JSON.stringify({ kind: "sfx", keyId: WARM, key: "k", t: 2, pitch: 1, volume: 1 }));
    // Stop lands while that cue's sink commands are still queued to main: they are dropped as stale.
    engine.stop();
    await settle(6);
    expect(r.context.sources).toHaveLength(1);
    expect(r.context.state).toBe("suspended");
    expect(r.sockets[2].readyState).toBe(3);
    engine.dispose();
  });

  it("reports an unavailable render lane through onUnavailable and stops", async () => {
    const r = rig();
    const worker = inProcessWorker(r.Ctor, r.fetcher as unknown as typeof fetch);
    const onUnavailable = vi.fn();
    const engine = createAudioEngine({ ...r.base, onUnavailable, pathEnv: env("?audioPath=worker"), createWorker: worker.factory });
    await engine.unlock(); engine.start(); await settle();
    r.sockets[1].emit("close");
    await settle();
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(worker.state.toWorker.at(-1)).toMatchObject({ kind: "stop" });
    engine.dispose();
  });

  it("round-trips a TmpSfx through main-thread decode, then plays it resident", async () => {
    const r = rig();
    const decode = vi.spyOn(r.context, "decodeAudioData");
    const worker = inProcessWorker(r.Ctor, r.fetcher as unknown as typeof fetch);
    const engine = createAudioEngine({ ...r.base, pathEnv: env("?audioPath=worker"), createWorker: worker.factory });
    await engine.unlock(); engine.start(); await settle();
    const [seat, render] = r.sockets; seat.emit("open"); render.emit("open");
    seat.emit("message", JSON.stringify(SNAPSHOT));
    seat.emit("message", JSON.stringify({ kind: "tmpsfx", resPath: "res://debug_audio/card_deal.mp3", t: 1, pitch: 1.2, volume: .5 }));
    await settle(6);
    expect(r.fetcher.mock.calls.map(([u]) => String(u))).toContain("/audio/tmpsfx/debug_audio%2Fcard_deal.mp3");
    expect(r.context.sources).toHaveLength(1);
    expect(r.context.sources[0].playbackRate.value).toBe(1.2);
    expect(worker.state.toWorker.some(m => m.kind === "tmpsfx-resident")).toBe(true);
    seat.emit("message", JSON.stringify({ kind: "tmpsfx", resPath: "res://debug_audio/card_deal.mp3", t: 2, pitch: 1, volume: .5 }));
    await settle(6);
    expect(r.context.sources).toHaveLength(2);
    expect(decode).toHaveBeenCalledTimes(1);
    engine.dispose();
  });

  it("hands the worklet its port, fences it directly, and re-ports after a FAST context recreate", async () => {
    const r = rig();
    const worker = inProcessWorker(r.Ctor, r.fetcher as unknown as typeof fetch);
    const sinks: Array<{ posted: MainToWorklet[]; disposed: boolean; port: FakeWorkerChannel; onDiag?: unknown }> = [];
    const createWorkletSink = vi.fn(async () => {
      const [port] = createFakeWorkerChannelPair();
      const sink = { posted: [] as MainToWorklet[], disposed: false, port, onDiag: undefined as unknown };
      sinks.push(sink);
      return { workerPort: port as unknown as MessagePort, post: (msg: MainToWorklet) => { sink.posted.push(msg); },
        dispose: () => { sink.disposed = true; },
        get onDiag() { return sink.onDiag as never; }, set onDiag(fn: unknown) { sink.onDiag = fn; } } as WorkletSinkHandle;
    });
    let lead = 0;
    // A context whose predicted output lead the spec controls: > 60 ms makes the unlocker recreate it (FAST probe).
    const withLead = (context: FakeContext) => Object.assign(context, {
      getOutputTimestamp: () => ({ contextTime: context.currentTime, performanceTime: performance.now() + lead }) });
    const contexts = [withLead(r.context), withLead(new FakeContext())];
    let created = 0;
    const options: AudioEngineFacadeOptions = { ...r.base, pathEnv: env("?audioPath=worklet"), createWorker: worker.factory, createWorkletSink,
      audioEnv: { ...r.base.audioEnv, createContext: () => contexts[created++] as unknown as AudioContextLike } };
    const engine = createAudioEngine(options);
    await engine.unlock();
    expect(worker.state.toWorker.map(m => m.kind)).toEqual(["init", "port"]);
    expect(worker.state.toWorker[0]).toMatchObject({ sinkMode: "port", pcm: "s16" });
    expect(typeof sinks[0].onDiag).toBe("function");
    engine.start(); await settle();
    expect(sinks[0].posted).toEqual([{ kind: "fence", epoch: 1 }]);
    const [seat, render] = r.sockets; seat.emit("open"); render.emit("open");
    render.emit("message", laneFrame(1, 0));
    expect(sinks[0].port.sent.map(m => (m.data as { kind: string }).kind)).toContain("lane-blocks");
    engine.stop();
    expect(sinks[0].posted.at(-1)).toEqual({ kind: "fence", epoch: 2 });
    lead = 200;
    await engine.unlock();
    expect(created).toBe(2);
    expect(sinks).toHaveLength(2);
    expect(sinks[0].disposed).toBe(true);
    expect(worker.state.toWorker.filter(m => m.kind === "init")).toHaveLength(1);
    expect(worker.state.toWorker.filter(m => m.kind === "port")).toHaveLength(2);
    engine.dispose();
    expect(sinks[1].disposed).toBe(true);
  });

  it("falls back to the main engine when the worklet processor dies after loading", async () => {
    const r = rig();
    const worker = inProcessWorker(r.Ctor, r.fetcher as unknown as typeof fetch);
    let failProcessor: (error: Error) => void = () => {};
    const ready = new Promise<void>((_resolve, reject) => { failProcessor = reject; });
    ready.catch(() => {});
    const createWorkletSink = vi.fn(async () => {
      const [port] = createFakeWorkerChannelPair();
      return { workerPort: port as unknown as MessagePort, post: () => {}, dispose: () => {}, ready } as WorkletSinkHandle;
    });
    const engine = createAudioEngine({ ...r.base, pathEnv: env("?audioPath=worklet"), createWorker: worker.factory, createWorkletSink });
    await engine.unlock();
    engine.start(); await settle();
    const offThreadSockets = r.sockets.length;
    failProcessor(new Error("processor threw"));
    await settle(); await settle();
    // The worker is gone and the main engine opened its own seat and render sockets.
    expect(worker.state.terminated).toBe(true);
    expect(r.sockets.length).toBe(offThreadSockets + 2);
    engine.dispose();
  });

  it("merges worker diagnostics into the page snapshot with main-receipt waits", async () => {
    history.replaceState({}, "", "?audioDiag=1");
    const r = rig();
    const worker = inProcessWorker(r.Ctor, r.fetcher as unknown as typeof fetch);
    const engine = createAudioEngine({ ...r.base, pathEnv: env("?audioPath=worker"), createWorker: worker.factory });
    await engine.unlock(); engine.start(); await settle();
    const [seat, render] = r.sockets; seat.emit("open"); render.emit("open");
    seat.emit("message", JSON.stringify(SNAPSHOT));
    seat.emit("message", JSON.stringify({ kind: "sfx", keyId: WARM, key: "k", t: 4_000_000_000_000, pitch: 1, volume: 1 }));
    await settle(6);
    await new Promise(resolve => setTimeout(resolve, 130));
    const snapshot = window.__couchCoopAudioDiag!();
    expect(snapshot.audioPath).toBe("worker");
    expect(snapshot.sinkMode).toBe("post");
    const rows = snapshot.events as Array<Record<string, unknown>>;
    expect(rows.find(row => row.type === "seat-parse-complete" && row.kind === "sfx")).toMatchObject({ thread: "worker", seatTUs: 4_000_000_000_000 });
    expect(rows.find(row => row.type === "worker-post" && row.kind === "play")).toMatchObject({ thread: "worker", dest: "main" });
    const receipt = rows.find(row => row.type === "main-receipt" && row.kind === "play")!;
    expect(receipt.waitMs as number).toBeGreaterThanOrEqual(0);
    expect(rows.find(row => row.type === "source-scheduled")).toMatchObject({ lane: "sfx", keyId: WARM, seatTUs: 4_000_000_000_000 });
    expect(rows.every(row => typeof row.seq === "number")).toBe(true);
    expect(window.__couchCoopAudioDiagProbe?.()).toBe(true);
    await settle();
    expect(render.sent.map(s => JSON.parse(s)).filter(m => m.kind === "clock")).toHaveLength(9);
    engine.dispose();
  });
});

describe("audio path parity", () => {
  interface Scheduled { rate: number; start: number; frames: number }

  async function drive(main: boolean) {
    const r = rig();
    // The served WAV is 2 frames; make the main path's (fake) decode agree with the worker's real parse.
    r.context.decodeAudioData = async () => r.context.createBuffer(2, 2);
    const worker = inProcessWorker(r.Ctor, r.fetcher as unknown as typeof fetch);
    const engine = main
      ? createMainAudioEngine(r.base)
      : createAudioEngine({ ...r.base, pathEnv: env("?audioPath=worker"), createWorker: worker.factory });
    await engine.unlock(); engine.start(); await settle();
    const [seat, render] = r.sockets; seat.emit("open"); render.emit("open");
    seat.emit("message", JSON.stringify(SNAPSHOT));
    seat.emit("message", JSON.stringify({ kind: "sfx", keyId: WARM, key: "k", t: 1, pitch: .8, volume: .5 }));
    await settle(6);
    seat.emit("message", JSON.stringify({ kind: "sfx", keyId: COLD, key: "c", t: 2, pitch: 1.25, volume: .7 }));
    await settle(6);
    render.emit("message", JSON.stringify({ kind: "take-start", keyId: COLD, streamId: 7 }));
    await settle();
    render.emit("message", takeFrame(7, 0, AudioFlags.First));
    await settle();
    render.emit("message", takeFrame(7, 1, AudioFlags.Last));
    await settle();
    render.emit("message", laneFrame(1, 0));
    render.emit("message", laneFrame(1, 1));
    render.emit("message", laneFrame(2, 0, AudioFlags.First));
    await settle(6);
    seat.emit("message", JSON.stringify({ kind: "sfx", keyId: COLD, key: "c", t: 3, pitch: 2, volume: .7 }));
    await settle(6);
    const scheduled: Scheduled[] = r.context.sources.map(s => ({ rate: s.playbackRate.value, start: s.starts[0], frames: s.buffer?.length ?? 0 }));
    const gains = [...new Set(r.context.gains.map(g => g.gain.value))].sort();
    const playRequests = render.sent.map(s => JSON.parse(s)).filter(m => m.kind === "play").map(m => m.keyId);
    engine.dispose();
    return { scheduled, gains, playRequests };
  }

  it("schedules the same cues, takes and lanes on the main and worker paths", async () => {
    const main = await drive(true);
    const off = await drive(false);
    expect(off.playRequests).toEqual(main.playRequests);
    expect(off.gains).toEqual(main.gains);
    // Sfx and take sources match one for one; the worker path may merge a contiguous lane run.
    const nonLane = (list: Scheduled[]) => list.filter(s => s.frames !== 512 && s.frames !== 1024);
    expect(nonLane(off.scheduled)).toEqual(nonLane(main.scheduled));
    const lanes = (list: Scheduled[]) => list.filter(s => s.frames === 512 || s.frames === 1024);
    const mainLanes = lanes(main.scheduled), offLanes = lanes(off.scheduled);
    expect(offLanes.reduce((sum, s) => sum + s.frames, 0)).toBe(mainLanes.reduce((sum, s) => sum + s.frames, 0));
    expect(offLanes.map(s => s.start).sort()).toEqual([mainLanes[0].start, mainLanes[2].start].sort());
    expect(offLanes.map(s => s.start)[0]).toBeCloseTo(mainLanes[0].start, 9);
  });
});
