import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioTransportCore, LANE_COALESCE_DEADLINE_MS } from "../audioTransportCore";
import type { MainToWorker, SinkCommand, WorkerToMain } from "../audioSinkProtocol";
import { AudioFlags } from "../audioWire";
import { createFakeWorkerChannelPair, FakeSocket } from "./fakes";
import { audioFrame, laneFrame, settle, takeFrame, wav } from "./audioFrames";

const KEY = "ac148f6ddbd27aba877991055c5a5431";
const COLD = "0123456789abcdef0123456789abcdef";
const SNAPSHOT = { kind: "volumes", snapshot: true, master: 1, sfx: 1, bgm: 1, ambience: 1, godotMasterDb: 0, godotSfxDb: 0 };
const WAV = wav([1000, -1000, 2000, -2000, 3000, -3000]);

interface HarnessOptions {
  init?: Partial<Extract<MainToWorker, { kind: "init" }>>;
  indexKeys?: string[];
  fetch?: (url: string, init?: RequestInit) => Promise<Response> | undefined;
  start?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const sockets: FakeSocket[] = [];
  const Ctor = class extends FakeSocket { constructor(url: string) { super(url); sockets.push(this); } } as unknown as typeof WebSocket;
  const main: WorkerToMain[] = [];
  const transfers: Transferable[][] = [];
  const sink: SinkCommand[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const custom = options.fetch?.(url, init);
    if (custom) return custom;
    if (url === "/audio/takes") return new Response(JSON.stringify({ schema: 1, bankset: "b", keys: options.indexKeys ?? [] }));
    return new Response(WAV.slice(0));
  });
  const core = new AudioTransportCore({
    WebSocketCtor: Ctor, fetcher: fetcher as unknown as typeof fetch,
    postMain: (msg, transfer = []) => { main.push(msg); if (msg.kind === "sink") { sink.push(msg.cmd); transfers.push(transfer); } },
    now: () => 1_000
  });
  core.handle({ kind: "init", mainTimeOrigin: performance.timeOrigin, diag: false, hostBase: "", assetToken: "",
    indexUrl: "/audio/takes", renderUrl: "ws://host/audio", sinkMode: "post", pcm: "f32-planar", coalesce: 2, ...options.init });
  if (options.start !== false) {
    core.handle({ kind: "start", epoch: 1, seatUrl: "ws://host/ws?seat=R&lane=audio" });
    sockets[0].emit("open"); sockets[1].emit("open");
  }
  const seatEmit = (value: unknown): void => sockets[0].emit("message", JSON.stringify(value));
  const renderEmit = (value: unknown): void => sockets[1].emit("message", typeof value === "string" || value instanceof ArrayBuffer ? value : JSON.stringify(value));
  const sentToRender = () => sockets[1].sent.map(s => JSON.parse(s) as Record<string, unknown>);
  const kinds = () => sink.map(cmd => cmd.kind);
  const sfx = (keyId: string, extra: Record<string, unknown> = {}) => seatEmit({ kind: "sfx", keyId, key: "event:/sfx/x", t: 7, pitch: 1.25, volume: .5, ...extra });
  return { core, sockets, main, sink, transfers, fetcher, seatEmit, renderEmit, sentToRender, kinds, sfx };
}

afterEach(() => { vi.useRealTimers(); });

describe("audio transport core: seat cues", () => {
  it("loads then plays a key the first time, and only plays it after", async () => {
    const h = harness({ indexKeys: [KEY] });
    h.seatEmit(SNAPSHOT);
    h.sfx(KEY);
    await settle();
    const first = h.sink.filter(cmd => cmd.kind === "load" || cmd.kind === "play");
    expect(first.map(cmd => cmd.kind)).toEqual(["load", "play"]);
    const load = first[0] as Extract<SinkCommand, { kind: "load" }>;
    expect(load.key).toBe(KEY);
    expect(load.rate).toBe(48_000);
    expect(load.pcm.format).toBe("f32-planar");
    if (load.pcm.format !== "f32-planar") throw new Error("format");
    expect(load.pcm.frames).toBe(3);
    expect([...load.pcm.channels[0]]).toEqual([1000 / 32768, 2000 / 32768, 3000 / 32768]);
    expect([...load.pcm.channels[1]]).toEqual([-1000 / 32768, -2000 / 32768, -3000 / 32768]);
    expect(h.transfers[h.sink.indexOf(load)]).toEqual(load.pcm.channels.map(c => c.buffer));
    expect(first[1]).toMatchObject({ kind: "play", key: KEY, sourcePath: "http-take", gain: .5, pitch: 1.25, seatTUs: "7", epoch: 1 });
    expect(h.fetcher.mock.calls.map(([url]) => String(url))).toContain(`/audio/take/1/b/${KEY}.wav`);
    const before = h.sink.length;
    h.sfx(KEY, { pitch: .5 });
    // A cached cue is posted synchronously — no fetch, no microtask.
    expect(h.sink.slice(before)).toMatchObject([{ kind: "play", key: KEY, sourcePath: "cached", pitch: .5 }]);
    expect(h.sentToRender().some(m => m.kind === "play")).toBe(false);
  });

  it("drops cues until a volume snapshot arrives and derives the lane subscription from it", async () => {
    const h = harness({ indexKeys: [KEY] });
    h.sfx(KEY);
    h.seatEmit({ kind: "volumes", snapshot: false, master: 1, sfx: 1 });
    h.sfx(KEY);
    await settle();
    expect(h.kinds().filter(k => k === "play" || k === "load")).toEqual([]);
    expect(h.sentToRender().filter(m => m.kind === "lanes").at(-1)).toEqual({ kind: "lanes", music: false, ambience: false, loops: false });
    h.seatEmit({ ...SNAPSHOT, bgm: 0, ambience: .5 });
    expect(h.sentToRender().filter(m => m.kind === "lanes").at(-1)).toEqual({ kind: "lanes", music: false, ambience: true, loops: true });
    expect(h.sink.filter(cmd => cmd.kind === "lane-gains").at(-1)).toMatchObject({ music: 0, ambience: .25, loops: 1 });
    h.sfx(KEY);
    await settle();
    expect(h.kinds().filter(k => k === "play" || k === "load")).toEqual(["load", "play"]);
  });

  it("queues a cold key, requests a host render, and streams take blocks into a load", async () => {
    const h = harness();
    h.seatEmit(SNAPSHOT);
    h.sfx(COLD);
    await settle();
    expect(h.sentToRender().filter(m => m.kind === "play")).toEqual([{ kind: "play", keyId: COLD, key: "event:/sfx/x" }]);
    h.renderEmit({ kind: "take-start", keyId: COLD, streamId: 7 });
    expect(h.sink.at(-1)).toMatchObject({ kind: "take-start", streamId: 7, key: COLD, gain: .5, pitch: 1.25, seatTUs: "7" });
    h.renderEmit(takeFrame(7, 0, AudioFlags.First));
    h.renderEmit(takeFrame(7, 1, AudioFlags.Last, [5, 6, 7, 8]));
    const tail = h.sink.slice(-3);
    expect(tail.map(cmd => cmd.kind)).toEqual(["take-block", "take-block", "load"]);
    const load = tail[2] as Extract<SinkCommand, { kind: "load" }>;
    if (load.pcm.format !== "f32-planar") throw new Error("format");
    expect(load.pcm.frames).toBe(4);
    expect([...load.pcm.channels[0]].map(v => Math.round(v * 32768))).toEqual([1000, 2000, 5, 7]);
    expect(h.core.isLoadedInSink(COLD)).toBe(true);
    const before = h.sink.length;
    h.sfx(COLD);
    expect(h.sink.slice(before).map(cmd => cmd.kind)).toEqual(["play"]);
  });

  it("keeps at most four pending cues per cold key", async () => {
    const h = harness();
    h.seatEmit(SNAPSHOT);
    for (let i = 0; i < 6; i++) h.sfx(COLD, { t: i, pitch: 1 + i / 10 });
    await settle();
    for (let i = 0; i < 6; i++) h.renderEmit({ kind: "take-start", keyId: COLD, streamId: 10 + i });
    expect(h.sink.filter(cmd => cmd.kind === "take-start").map(cmd => (cmd as { seatTUs: string }).seatTUs)).toEqual(["2", "3", "4", "5"]);
  });

  it("plays a ready-only take over HTTP and fills the cache with its URL", async () => {
    const h = harness();
    h.seatEmit(SNAPSHOT);
    h.sfx(COLD);
    await settle();
    const url = `/audio/take/1/b/${COLD}.wav`;
    h.renderEmit({ kind: "take-ready", keyId: COLD, streamId: 9, url });
    await settle();
    expect(h.sink.filter(cmd => cmd.kind === "load" || cmd.kind === "play").map(cmd => cmd.kind)).toEqual(["load", "play"]);
    expect(h.sink.at(-1)).toMatchObject({ kind: "play", key: COLD, sourcePath: "http-take", pitch: 1.25 });
    expect(h.fetcher.mock.calls.filter(([u]) => String(u) === url).length).toBeGreaterThanOrEqual(1);
  });

  it("applies the init host base and asset token to take routes", async () => {
    const h = harness({ indexKeys: [KEY], init: { hostBase: "http://192.168.1.5:13337", assetToken: "build 9", indexUrl: "http://192.168.1.5:13337/audio/takes" },
      fetch: url => url.endsWith("/audio/takes") ? Promise.resolve(new Response(JSON.stringify({ schema: 1, bankset: "b", keys: [KEY] }))) : undefined });
    h.seatEmit(SNAPSHOT);
    h.sfx(KEY);
    await settle();
    expect(h.fetcher.mock.calls.map(([u]) => String(u))).toContain(`http://192.168.1.5:13337/audio/take/1/b/${KEY}.wav?b=build%209`);
  });

  it("asks main to decode a TmpSfx, then plays the resident buffer directly", async () => {
    const h = harness();
    h.core.handle({ kind: "asset-token", token: "tmp-build-9" });
    h.seatEmit({ ...SNAPSHOT, godotMasterDb: -6, godotSfxDb: -12 });
    h.seatEmit({ kind: "tmpsfx", resPath: "res://debug_audio/card_deal.mp3", t: 3, pitch: 1.2, volume: .5 });
    const request = h.main.find(m => m.kind === "tmpsfx-decode") as Extract<WorkerToMain, { kind: "tmpsfx-decode" }>;
    expect(request).toMatchObject({ epoch: 1, path: "res://debug_audio/card_deal.mp3",
      url: "/audio/tmpsfx/debug_audio%2Fcard_deal.mp3?b=tmp-build-9", cue: { pitch: 1.2, seatTUs: "3" } });
    expect(request.cue.gain).toBeCloseTo(10 ** (-18 / 20) * .5);
    h.core.handle({ kind: "tmpsfx-resident", epoch: 1, path: request.path });
    h.seatEmit({ kind: "tmpsfx", resPath: "res://debug_audio/card_deal.mp3", t: 4, pitch: 1, volume: 1 });
    expect(h.sink.at(-1)).toMatchObject({ kind: "play", key: request.path, sourcePath: "tmpsfx", seatTUs: "4" });
    expect(h.main.filter(m => m.kind === "tmpsfx-decode")).toHaveLength(1);
    h.seatEmit({ kind: "tmpsfx", resPath: "res://elsewhere/x.mp3", t: 5, pitch: 1, volume: 1 });
    expect(h.main.filter(m => m.kind === "tmpsfx-decode")).toHaveLength(1);
  });

  it("drops stale async work after a seat switch and after stop", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = harness({ indexKeys: [KEY], fetch: url => url.includes(KEY) ? gate.then(() => new Response(WAV.slice(0))) : undefined });
    h.seatEmit(SNAPSHOT);
    h.sfx(KEY);
    h.sfx(COLD);
    await settle();
    h.core.handle({ kind: "seat", epoch: 2, seatUrl: "ws://host/ws?seat=S&lane=audio" });
    expect(h.sockets[0].readyState).toBe(3);
    expect(h.sockets.map(s => s.url).slice(2)).toEqual(["ws://host/ws?seat=S&lane=audio", "ws://host/audio"]);
    // An old-socket take-start and the stale fetch both land after the switch: neither reaches the sink.
    h.renderEmit({ kind: "take-start", keyId: COLD, streamId: 7 });
    release();
    await settle();
    expect(h.kinds().filter(k => k !== "lane-gains")).toEqual([]);
    // The new seat starts without volumes: cues wait for its snapshot.
    h.sockets[2].emit("open"); h.sockets[3].emit("open");
    h.sockets[2].emit("message", JSON.stringify({ kind: "sfx", keyId: KEY, key: "k", t: 1, pitch: 1, volume: 1 }));
    await settle();
    expect(h.kinds().filter(k => k === "play")).toEqual([]);
    h.sockets[2].emit("message", JSON.stringify(SNAPSHOT));
    h.core.handle({ kind: "stop", epoch: 3 });
    expect(h.sockets[2].readyState).toBe(3);
    h.sockets[2].emit("message", JSON.stringify({ kind: "sfx", keyId: KEY, key: "k", t: 1, pitch: 1, volume: 1 }));
    await settle();
    expect(h.kinds().filter(k => k === "play")).toEqual([]);
  });

  it("reports an unavailable render lane with the epoch it was opened under", () => {
    const h = harness();
    h.sockets[1].emit("close");
    expect(h.main.at(-1)).toEqual({ kind: "unavailable", epoch: 1 });
  });

  it("sends clock probes on open with page-aligned client times and records nothing when diag is off", () => {
    const h = harness();
    const clocks = h.sentToRender().filter(m => m.kind === "clock");
    expect(clocks).toHaveLength(8);
    expect(clocks.every(m => m.clientPerfMs === 1_000)).toBe(true);
    h.core.handle({ kind: "probe-clock" });
    expect(h.sentToRender().filter(m => m.kind === "clock")).toHaveLength(9);
    expect(h.main.some(m => m.kind === "diag")).toBe(false);
  });

  it("opens no socket and fetches nothing before start", () => {
    const h = harness({ start: false });
    expect(h.sockets).toHaveLength(0);
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.main).toEqual([{ kind: "ready" }]);
  });
});

describe("audio transport core: lane coalescing", () => {
  const laneBatches = (sink: SinkCommand[]) => sink.filter(cmd => cmd.kind === "lane-blocks")
    .map(cmd => (cmd as Extract<SinkCommand, { kind: "lane-blocks" }>).blocks.map(b => `${b.lane}:${b.blockIndex}`));

  it("flushes when a lane reaches the coalesce count", () => {
    const h = harness();
    h.renderEmit(laneFrame(1, 0));
    expect(laneBatches(h.sink)).toEqual([]);
    h.renderEmit(laneFrame(2, 0));
    expect(laneBatches(h.sink)).toEqual([]);
    h.renderEmit(laneFrame(1, 1));
    expect(laneBatches(h.sink)).toEqual([["1:0", "2:0", "1:1"]]);
    const batch = h.sink.at(-1) as Extract<SinkCommand, { kind: "lane-blocks" }>;
    expect(batch.blocks[0].dueUs).toBe(1_000_000);
    expect(batch.blocks[2].dueUs).toBe(1_010_667);
    expect(batch.blocks[0].pcm.format).toBe("f32-planar");
    expect(h.transfers.at(-1)).toHaveLength(6);
  });

  it("honours ?audioCoalesce, flushes on First/Last immediately, and on the deadline otherwise", () => {
    vi.useFakeTimers();
    const h = harness({ init: { coalesce: 4 } });
    h.renderEmit(laneFrame(1, 0));
    h.renderEmit(laneFrame(1, 1));
    vi.advanceTimersByTime(LANE_COALESCE_DEADLINE_MS - 1);
    expect(laneBatches(h.sink)).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(laneBatches(h.sink)).toEqual([["1:0", "1:1"]]);
    h.renderEmit(laneFrame(3, 5, AudioFlags.First));
    expect(laneBatches(h.sink).at(-1)).toEqual(["3:5"]);
    h.renderEmit(laneFrame(3, 6));
    h.renderEmit(laneFrame(3, 7, AudioFlags.Last));
    expect(laneBatches(h.sink).at(-1)).toEqual(["3:6", "3:7"]);
    vi.advanceTimersByTime(50);
    expect(laneBatches(h.sink)).toHaveLength(3);
  });

  it("flushes pending blocks before a Silent stop and never delays seat cues or take blocks", async () => {
    const h = harness({ indexKeys: [KEY] });
    h.seatEmit(SNAPSHOT);
    h.sfx(KEY);
    await settle();
    h.renderEmit(laneFrame(1, 0));
    h.sfx(KEY);
    h.sfx(COLD);
    await settle();
    h.renderEmit({ kind: "take-start", keyId: COLD, streamId: 7 });
    h.renderEmit(takeFrame(7, 0, AudioFlags.First));
    // Lane block 1:0 is still held; the cue, take-start and take-block went straight out.
    expect(h.kinds().slice(-3)).toEqual(["play", "take-start", "take-block"]);
    expect(laneBatches(h.sink)).toEqual([]);
    h.renderEmit(laneFrame(1, 1, AudioFlags.Silent));
    expect(h.kinds().slice(-2)).toEqual(["lane-blocks", "lane-stop"]);
    expect(laneBatches(h.sink)).toEqual([["1:0"]]);
    expect(h.sink.at(-1)).toMatchObject({ kind: "lane-stop", lane: 1 });
  });

  it("posts each block immediately as s16 over the worklet port in port mode", () => {
    const [workerSide] = createFakeWorkerChannelPair();
    const h = harness({ init: { sinkMode: "port", pcm: "s16", coalesce: 2 }, start: false });
    h.core.handle({ kind: "port", port: workerSide as unknown as MessagePort, sampleRate: 48_000 });
    h.core.handle({ kind: "start", epoch: 1, seatUrl: "ws://host/ws?seat=R&lane=audio" });
    h.sockets[0].emit("open"); h.sockets[1].emit("open");
    const frame = laneFrame(1, 0);
    h.renderEmit(frame);
    const sent = workerSide.sent.filter(m => (m.data as SinkCommand).kind === "lane-blocks");
    expect(sent).toHaveLength(1);
    const cmd = sent[0].data as Extract<SinkCommand, { kind: "lane-blocks" }>;
    const pcm = cmd.blocks[0].pcm;
    if (pcm.format !== "s16") throw new Error("format");
    expect(pcm.channels).toBe(2);
    expect(pcm.frames).toBe(512);
    expect(pcm.interleaved[0]).toBe(100);
    // Zero copy: the socket's own buffer is what gets transferred.
    expect(pcm.interleaved.buffer).toBe(frame);
    expect(sent[0].transfer).toEqual([frame]);
    expect(h.sink).toEqual([]);
  });

  it("re-loads keys into a new sink after a port change", async () => {
    const [firstPort] = createFakeWorkerChannelPair();
    const [secondPort] = createFakeWorkerChannelPair();
    const h = harness({ indexKeys: [KEY], init: { sinkMode: "port", pcm: "s16" }, start: false });
    h.core.handle({ kind: "port", port: firstPort as unknown as MessagePort, sampleRate: 48_000 });
    h.core.handle({ kind: "start", epoch: 1, seatUrl: "ws://host/ws?seat=R&lane=audio" });
    h.sockets[0].emit("open"); h.sockets[1].emit("open");
    h.seatEmit(SNAPSHOT);
    h.sfx(KEY);
    await settle();
    h.sfx(KEY);
    const kindsOn = (port: typeof firstPort) => port.sent.map(m => (m.data as SinkCommand).kind).filter(k => k === "load" || k === "play");
    expect(kindsOn(firstPort)).toEqual(["load", "play", "play"]);
    const load = firstPort.sent.find(m => (m.data as SinkCommand).kind === "load")!.data as Extract<SinkCommand, { kind: "load" }>;
    expect(load.pcm).toMatchObject({ format: "s16", channels: 2, frames: 3 });
    h.core.handle({ kind: "port", port: secondPort as unknown as MessagePort, sampleRate: 48_000 });
    h.sfx(KEY);
    expect(kindsOn(secondPort)).toEqual(["load", "play"]);
  });

  it("records worker-thread diagnostics in batches only when diag is on", async () => {
    const h = harness({ indexKeys: [KEY], init: { diag: true } });
    h.seatEmit(SNAPSHOT);
    h.sfx(KEY);
    await settle();
    for (let i = 0; i < 40; i++) h.renderEmit(audioFrame({ kind: 2, lane: 1, blockIndex: i * 16 }));
    const batches = h.main.filter(m => m.kind === "diag") as Array<Extract<WorkerToMain, { kind: "diag" }>>;
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.every(b => b.events.length <= 32)).toBe(true);
    const rows = batches.flatMap(b => b.events);
    expect(rows.every(row => row.thread === "worker")).toBe(true);
    expect(rows.find(row => row.type === "worker-installed")).toMatchObject({ entry: "installAudioTransportWorker" });
    expect(rows.some(row => row.type === "seat-parse-complete")).toBe(true);
    expect(rows.some(row => row.type === "worker-post" && row.kind === "play" && row.dest === "main")).toBe(true);
    expect(rows.some(row => row.type === "pcm-frame-received")).toBe(true);
  });
});
