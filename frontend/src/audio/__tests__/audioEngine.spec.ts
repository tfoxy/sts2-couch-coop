import { describe, expect, it, vi } from "vitest";
import { createAudioEngine } from "../audioEngine";
import type { AudioContextLike } from "../audioUnlock";

class Param { value = 1; setTargetAtTime(value: number): void { this.value = value; } setValueAtTime(value: number): void { this.value = value; } linearRampToValueAtTime(value: number): void { this.value = value; } cancelScheduledValues(): void {} }
class Gain { gain = new Param(); connect(): void {} disconnect(): void {} }
class Buffer { channels: Float32Array[]; constructor(readonly length: number) { this.channels = [new Float32Array(length), new Float32Array(length)]; } getChannelData(channel: number): Float32Array { return this.channels[channel]; } }
class Source {
  playbackRate = new Param(); buffer: Buffer | null = null; onended: (() => void) | null = null;
  starts: number[] = []; stopped = false; connect(): void {} disconnect(): void {} start(at = 0): void { this.starts.push(at); } stop(): void { this.stopped = true; this.onended?.(); }
}
class ConstantSource extends Source { offset = new Param(); }
class FakeContext {
  state = "suspended"; currentTime = 12; destination = {} as AudioNode; sources: Source[] = []; gains: Gain[] = [];
  createBuffer(_channels: number, length: number): Buffer { return new Buffer(length); }
  createBufferSource(): Source { const source = new Source(); this.sources.push(source); return source; }
  createGain(): Gain { const gain = new Gain(); this.gains.push(gain); return gain; }
  createConstantSource(): ConstantSource { return new ConstantSource(); }
  async decodeAudioData(): Promise<Buffer> { return new Buffer(1); }
  async resume(): Promise<void> { this.state = "running"; }
  async suspend(): Promise<void> { this.state = "suspended"; }
  async close(): Promise<void> { this.state = "closed"; }
}
class FakeSocket {
  static CONNECTING = 0; static OPEN = 1;
  readyState = 0; binaryType = ""; sent: string[] = [];
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (event: MessageEvent) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  emit(type: string, data?: unknown): void {
    if (type === "open") this.readyState = 1;
    for (const fn of this.listeners.get(type) ?? []) fn({ data } as MessageEvent);
  }
}

function takeFrame(): ArrayBuffer {
  const bytes = new Uint8Array(36 + 8), d = new DataView(bytes.buffer);
  d.setUint32(0, 0x55414343, true); d.setUint8(4, 1); d.setUint8(5, 1); d.setUint8(6, 3); d.setUint8(7, 0);
  d.setUint32(8, 7, true); d.setUint32(12, 0, true); d.setUint16(16, 2, true);
  d.setBigUint64(20, 1_000_000n, true); d.setBigUint64(28, 1_001_000n, true);
  d.setInt16(36, 1000, true); d.setInt16(38, -1000, true); d.setInt16(40, 2000, true); d.setInt16(42, -2000, true);
  return bytes.buffer;
}

function laneFrame(): ArrayBuffer {
  const bytes = new Uint8Array(36 + 512 * 4), d = new DataView(bytes.buffer);
  d.setUint32(0, 0x55414343, true); d.setUint8(4, 1); d.setUint8(5, 2); d.setUint8(7, 1);
  d.setUint16(16, 512, true); d.setBigUint64(20, 1_000_000n, true);
  return bytes.buffer;
}

describe("audio engine cold take playback", () => {
  it.each([false, true])("suspends a deferred unlock after hide (visible before resolve: %s)", async (showBeforeResolve) => {
    const context = new FakeContext(), sockets: FakeSocket[] = [];
    const priorVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    let visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    let finishPrelude!: () => void;
    const prelude = new Promise<void>(resolve => { finishPrelude = resolve; });
    const Ctor = class extends FakeSocket { constructor(url: string) { super(url); sockets.push(this); } } as unknown as typeof WebSocket;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ schema: 1, bankset: "b", keys: [] })));
    const engine = createAudioEngine({ seatUrl: "ws://host/ws?seat=R&lane=audio", renderUrl: "ws://host/audio", indexUrl: "/audio/takes", WebSocketCtor: Ctor, fetcher,
      audioEnv: { createPrelude: () => ({ play: () => prelude, pause() {}, removeAttribute() {} } as unknown as HTMLAudioElement), createContext: () => context as unknown as AudioContextLike }
    });
    try {
      const unlocking = engine.unlock();
      visibility = "hidden";
      engine.stop();
      if (showBeforeResolve) visibility = "visible";
      finishPrelude();
      expect(await unlocking).toBe(true);
      expect(context.state).toBe("suspended");
      engine.start();
      expect(sockets).toHaveLength(0);
      expect(fetcher).not.toHaveBeenCalled();
      visibility = "visible";
      expect(await engine.unlock()).toBe(true);
      expect(context.state).toBe("running");
      engine.start();
      expect(sockets).toHaveLength(2);
    } finally {
      engine.dispose();
      if (priorVisibility) Object.defineProperty(document, "visibilityState", priorVisibility);
      else Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("plays incoming PCM immediately at event pitch and gain, then treats ready as cache metadata", async () => {
    const priorUrl = location.href;
    history.replaceState({}, "", "?audioDiag=1");
    const context = new FakeContext(), sockets: FakeSocket[] = [];
    const Ctor = class extends FakeSocket { constructor(url: string) { super(url); sockets.push(this); } } as unknown as typeof WebSocket;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ schema: 1, bankset: "b", takes: {} }), { status: 200 }));
    const engine = createAudioEngine({ seatUrl: "ws://host/ws?seat=R&lane=audio", renderUrl: "ws://host/audio", indexUrl: "http://host/audio/takes", WebSocketCtor: Ctor, fetcher,
      audioEnv: { createPrelude: () => ({ play: async () => {}, pause() {}, removeAttribute() {} } as unknown as HTMLAudioElement), createContext: () => context as unknown as AudioContextLike }
    });
    expect(await engine.unlock()).toBe(true); engine.start();
    const [seat, render] = sockets; seat.emit("open"); render.emit("open");
    seat.emit("message", JSON.stringify({ kind: "volumes", snapshot: true, master: 1, sfx: 1, bgm: 0, ambience: 0, godotMasterDb: 0, godotSfxDb: 0 }));
    const lane = render.sent.map(s => JSON.parse(s)).filter(m => m.kind === "lanes").at(-1);
    expect(lane).toEqual({ kind: "lanes", music: false, ambience: false, loops: true });
    seat.emit("message", JSON.stringify({ kind: "sfx", keyId: "ac148f6ddbd27aba877991055c5a5431", key: "event:/sfx/ui/clicks/ui_hover", t: 4_000_000_000_000, pitch: 1.5, volume: .5 }));
    await new Promise(resolve => setTimeout(resolve, 0));
    const play = render.sent.map(s => JSON.parse(s)).reverse().find(m => m.kind === "play");
    expect(play).toEqual({ kind: "play", keyId: "ac148f6ddbd27aba877991055c5a5431", key: "event:/sfx/ui/clicks/ui_hover" });
    if (!play) throw new Error("missing play request");
    render.emit("message", JSON.stringify({ kind: "take-start", keyId: play.keyId, streamId: 7 }));
    render.emit("message", takeFrame());
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0].playbackRate.value).toBe(1.5);
    expect(context.gains.some(g => g.gain.value === .5)).toBe(true);
    render.emit("message", JSON.stringify({ kind: "take-ready", keyId: play.keyId, streamId: 7, url: "/audio/takes/0123456789abcdef0123456789abcdef.wav" }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(context.sources).toHaveLength(1);
    expect(fetcher.mock.calls.some(([url, init]) => String(url).includes("0123456789abcdef0123456789abcdef.wav") && init?.cache === "force-cache")).toBe(true);
    const diagnostic = window.__couchCoopAudioDiag?.();
    const rows = diagnostic?.events as Array<Record<string, unknown>>;
    expect(rows.find(row => row.type === "source-scheduled" && row.lane === "take")).toMatchObject({
      sourcePath: "first-sight-stream", seatTUs: 4_000_000_000_000, keyId: play.keyId
    });
    expect(rows.every(row => typeof row.seq === "number")).toBe(true);
    expect(diagnostic?.performanceTimeOriginMs).toBeTypeOf("number");
    expect(window.__couchCoopAudioDiagProbe?.()).toBe(true);
    expect(render.sent.map(s => JSON.parse(s)).some(message => message.kind === "clock")).toBe(true);
    engine.setSeatUrl("ws://host/ws?seat=S&lane=audio");
    expect(context.sources[0].stopped).toBe(true);
    expect(sockets[2].url).toBe("ws://host/ws?seat=S&lane=audio");
    expect(sockets[3].url).toBe("ws://host/audio");
    sockets[2].emit("open"); sockets[3].emit("open");
    sockets[2].emit("message", JSON.stringify({ kind: "volumes", snapshot: true, master: 1, sfx: 1, bgm: 0, ambience: 0, godotMasterDb: 0, godotSfxDb: 0 }));
    seat.emit("message", JSON.stringify({ kind: "sfx", keyId: play.keyId, key: play.key, t: 1, pitch: 1, volume: 1 }));
    render.emit("message", laneFrame());
    await Promise.resolve();
    expect(sockets[3].sent.map(s => JSON.parse(s)).some(message => message.kind === "play")).toBe(false);
    expect(context.sources).toHaveLength(1);
    engine.stop();
    expect(await engine.unlock()).toBe(true);
    engine.start();
    expect(sockets[4].url).toBe("ws://host/ws?seat=S&lane=audio");
    engine.dispose();
    history.replaceState({}, "", priorUrl);
  });

  it("schedules a first-sight stream before its deferred WAV fetch and cancels the fetch on stop", async () => {
    const context = new FakeContext(), sockets: FakeSocket[] = [];
    const keyId = "ac148f6ddbd27aba877991055c5a5431";
    const Ctor = class extends FakeSocket { constructor(url: string) { super(url); sockets.push(this); } } as unknown as typeof WebSocket;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/audio/takes"
      ? new Response(JSON.stringify({ schema: 1, bankset: "b", keys: [] }))
      : new Response(new Uint8Array([1, 2, 3])));
    const engine = createAudioEngine({ seatUrl: "ws://host/ws?seat=R&lane=audio", renderUrl: "ws://host/audio", indexUrl: "/audio/takes", WebSocketCtor: Ctor, fetcher,
      audioEnv: { createPrelude: () => ({ play: async () => {}, pause() {}, removeAttribute() {} } as unknown as HTMLAudioElement), createContext: () => context as unknown as AudioContextLike }
    });
    await engine.unlock(); engine.start();
    const [seat, render] = sockets; seat.emit("open"); render.emit("open");
    seat.emit("message", JSON.stringify({ kind: "volumes", snapshot: true, master: 1, sfx: 1, bgm: 0, ambience: 0, godotMasterDb: 0, godotSfxDb: 0 }));
    seat.emit("message", JSON.stringify({ kind: "sfx", keyId, key: "event:/sfx/ui/clicks/ui_hover", t: 1, pitch: 1, volume: 1 }));
    await new Promise(resolve => setTimeout(resolve, 0));
    render.emit("message", JSON.stringify({ kind: "take-start", keyId, streamId: 7 }));
    render.emit("message", takeFrame());
    render.emit("message", JSON.stringify({ kind: "take-ready", keyId, streamId: 7, url: `/audio/take/1/b/${keyId}.wav` }));
    expect(context.sources).toHaveLength(1);
    expect(fetcher.mock.calls.map(([url]) => String(url))).not.toContain(`/audio/take/1/b/${keyId}.wav`);
    engine.stop();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetcher.mock.calls.map(([url]) => String(url))).not.toContain(`/audio/take/1/b/${keyId}.wav`);
    engine.dispose();
  });

  it("fetches and plays a ready-only take when the host already has its WAV", async () => {
    const context = new FakeContext(), sockets: FakeSocket[] = [];
    const keyId = "ac148f6ddbd27aba877991055c5a5431";
    const url = `/audio/take/1/b/${keyId}.wav`;
    const Ctor = class extends FakeSocket { constructor(socketUrl: string) { super(socketUrl); sockets.push(this); } } as unknown as typeof WebSocket;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/audio/takes"
      ? new Response(JSON.stringify({ schema: 1, bankset: "b", keys: [] }))
      : new Response(new Uint8Array([1, 2, 3])));
    const engine = createAudioEngine({ seatUrl: "ws://host/ws?seat=R&lane=audio", renderUrl: "ws://host/audio", indexUrl: "/audio/takes", WebSocketCtor: Ctor, fetcher,
      audioEnv: { createPrelude: () => ({ play: async () => {}, pause() {}, removeAttribute() {} } as unknown as HTMLAudioElement), createContext: () => context as unknown as AudioContextLike }
    });
    await engine.unlock(); engine.start();
    const [seat, render] = sockets; seat.emit("open"); render.emit("open");
    seat.emit("message", JSON.stringify({ kind: "volumes", snapshot: true, master: 1, sfx: 1, bgm: 0, ambience: 0, godotMasterDb: 0, godotSfxDb: 0 }));
    seat.emit("message", JSON.stringify({ kind: "sfx", keyId, key: "event:/sfx/ui/clicks/ui_hover", t: 1, pitch: .75, volume: .5 }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(render.sent.map(value => JSON.parse(value)).some(message => message.kind === "play" && message.keyId === keyId)).toBe(true);
    render.emit("message", JSON.stringify({ kind: "take-ready", keyId, streamId: 7, url }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetcher.mock.calls.map(([input]) => String(input))).toContain(url);
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0].playbackRate.value).toBe(.75);
    engine.dispose();
  });

  it("plays a ready-only take after reload with a receiver-sensitive browser fetch", async () => {
    const originalFetch = globalThis.fetch;
    const context = new FakeContext(), sockets: FakeSocket[] = [];
    const keyId = "ac148f6ddbd27aba877991055c5a5431";
    const url = `/audio/take/1/b/${keyId}.wav`;
    const fetcher = vi.fn(async function (this: unknown, input: RequestInfo | URL, _init?: RequestInit) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return String(input) === "/audio/takes"
        ? new Response(JSON.stringify({ schema: 1, bankset: "b", keys: [] }))
        : new Response(new Uint8Array([1, 2, 3]));
    });
    globalThis.fetch = fetcher as typeof fetch;
    const Ctor = class extends FakeSocket { constructor(socketUrl: string) { super(socketUrl); sockets.push(this); } } as unknown as typeof WebSocket;
    const engine = createAudioEngine({ seatUrl: "ws://host/ws?seat=R&lane=audio", renderUrl: "ws://host/audio", indexUrl: "/audio/takes", WebSocketCtor: Ctor,
      audioEnv: { createPrelude: () => ({ play: async () => {}, pause() {}, removeAttribute() {} } as unknown as HTMLAudioElement), createContext: () => context as unknown as AudioContextLike }
    });
    try {
      await engine.unlock(); engine.start();
      const [seat, render] = sockets; seat.emit("open"); render.emit("open");
      seat.emit("message", JSON.stringify({ kind: "volumes", snapshot: true, master: 1, sfx: 1, bgm: 0, ambience: 0, godotMasterDb: 0, godotSfxDb: 0 }));
      seat.emit("message", JSON.stringify({ kind: "sfx", keyId, key: "event:/sfx/ui/clicks/ui_hover", t: 1, pitch: 1, volume: 1 }));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(render.sent.map(value => JSON.parse(value)).some(message => message.kind === "play" && message.keyId === keyId)).toBe(true);
      render.emit("message", JSON.stringify({ kind: "take-ready", keyId, streamId: 7, url }));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(fetcher.mock.calls.map(([input]) => String(input))).toContain("/audio/takes");
      expect(fetcher.mock.calls.map(([input]) => String(input))).toContain(url);
      expect(context.sources).toHaveLength(1);
    } finally {
      engine.dispose();
      globalThis.fetch = originalFetch;
    }
  });

  it("records why a matching ready-only take cannot decode", async () => {
    const priorUrl = location.href;
    history.replaceState({}, "", "?audioDiag=1");
    const context = new FakeContext(), sockets: FakeSocket[] = [];
    context.decodeAudioData = vi.fn(async () => { throw new Error("invalid WAV"); });
    const keyId = "ac148f6ddbd27aba877991055c5a5431";
    const Ctor = class extends FakeSocket { constructor(socketUrl: string) { super(socketUrl); sockets.push(this); } } as unknown as typeof WebSocket;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/audio/takes"
      ? new Response(JSON.stringify({ schema: 1, bankset: "b", keys: [keyId] }))
      : new Response(new Uint8Array([1, 2, 3])));
    const engine = createAudioEngine({ seatUrl: "ws://host/ws?seat=R&lane=audio", renderUrl: "ws://host/audio", indexUrl: "/audio/takes", WebSocketCtor: Ctor, fetcher,
      audioEnv: { createPrelude: () => ({ play: async () => {}, pause() {}, removeAttribute() {} } as unknown as HTMLAudioElement), createContext: () => context as unknown as AudioContextLike }
    });
    await engine.unlock(); engine.start();
    const [seat, render] = sockets; seat.emit("open"); render.emit("open");
    seat.emit("message", JSON.stringify({ kind: "volumes", snapshot: true, master: 1, sfx: 1, bgm: 0, ambience: 0, godotMasterDb: 0, godotSfxDb: 0 }));
    seat.emit("message", JSON.stringify({ kind: "sfx", keyId, key: "event:/sfx/ui/clicks/ui_hover", t: 1, pitch: 1, volume: 1 }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(render.sent.map(value => JSON.parse(value)).some(message => message.kind === "play" && message.keyId === keyId)).toBe(true);
    render.emit("message", JSON.stringify({ kind: "take-ready", keyId, streamId: 7, url: `/audio/take/1/b/${keyId}.wav` }));
    await new Promise(resolve => setTimeout(resolve, 0));
    const events = window.__couchCoopAudioDiag?.().events as Array<Record<string, unknown>>;
    expect(events.find(event => event.type === "take-ready-received")).toMatchObject({ streamTracked: false, pendingCount: 1 });
    expect(events.find(event => event.type === "take-get-failed" && event.reason === "take-ready")).toMatchObject({ stage: "decode", error: "invalid WAV" });
    expect(events.find(event => event.type === "take-ready-get-result")).toMatchObject({ decoded: false, running: true });
    expect(context.sources).toHaveLength(0);
    engine.dispose();
    history.replaceState({}, "", priorUrl);
  });

  it("uses a warmed index take after reload without requesting a host render", async () => {
    const context = new FakeContext(), sockets: FakeSocket[] = [];
    const keyId = "ac148f6ddbd27aba877991055c5a5431";
    const Ctor = class extends FakeSocket { constructor(url: string) { super(url); sockets.push(this); } } as unknown as typeof WebSocket;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/audio/takes"
      ? new Response(JSON.stringify({ schema: 1, bankset: "warm-bank", keys: [keyId] }))
      : new Response(new Uint8Array([1, 2, 3])));
    const engine = createAudioEngine({ seatUrl: "ws://host/ws?seat=R&lane=audio", renderUrl: "ws://host/audio", indexUrl: "/audio/takes", WebSocketCtor: Ctor, fetcher,
      audioEnv: { createPrelude: () => ({ play: async () => {}, pause() {}, removeAttribute() {} } as unknown as HTMLAudioElement), createContext: () => context as unknown as AudioContextLike }
    });
    await engine.unlock(); engine.start();
    const [seat, render] = sockets; seat.emit("open"); render.emit("open");
    seat.emit("message", JSON.stringify({ kind: "volumes", snapshot: true, master: 1, sfx: 1, bgm: 1, ambience: 1, godotMasterDb: 0, godotSfxDb: 0 }));
    seat.emit("message", JSON.stringify({ kind: "sfx", keyId, key: "event:/sfx/ui/clicks/ui_hover", t: Date.now(), pitch: .8, volume: .5 }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0].playbackRate.value).toBe(.8);
    expect(render.sent.map(s => JSON.parse(s)).some(message => message.kind === "play")).toBe(false);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toContain(`/audio/take/1/warm-bank/${keyId}.wav`);
    engine.dispose();
  });

  it("fetches TmpSfx through the relative path and session-versioned host route", async () => {
    const context = new FakeContext(), sockets: FakeSocket[] = [];
    const Ctor = class extends FakeSocket { constructor(url: string) { super(url); sockets.push(this); } } as unknown as typeof WebSocket;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/audio/takes"
      ? new Response(JSON.stringify({ schema: 1, bankset: "b", keys: [] }))
      : new Response(new Uint8Array([1, 2, 3])));
    const { publishAssetVersion, __resetAssetVersionForTest } = await import("@/join/assetVersion");
    publishAssetVersion("tmp-build-9");
    const engine = createAudioEngine({ seatUrl: "ws://host/ws?seat=R&lane=audio", renderUrl: "ws://host/audio", indexUrl: "/audio/takes", WebSocketCtor: Ctor, fetcher,
      audioEnv: { createPrelude: () => ({ play: async () => {}, pause() {}, removeAttribute() {} } as unknown as HTMLAudioElement), createContext: () => context as unknown as AudioContextLike }
    });
    await engine.unlock(); engine.start();
    const [seat] = sockets; seat.emit("open");
    seat.emit("message", JSON.stringify({ kind: "volumes", snapshot: true, master: 0, sfx: 0, bgm: 0, ambience: 0, godotMasterDb: -6, godotSfxDb: -12 }));
    seat.emit("message", JSON.stringify({ kind: "tmpsfx", resPath: "res://debug_audio/card_deal.mp3", t: Date.now(), pitch: 1.2, volume: .5 }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetcher.mock.calls.map(([url]) => String(url))).not.toContain("/audio/tmpsfx/debug_audio%2Fcard_deal.mp3?b=tmp-build-9");
    expect(context.sources).toHaveLength(0);
    seat.emit("message", JSON.stringify({ kind: "volumes", snapshot: false, master: 1, sfx: 1 }));
    seat.emit("message", JSON.stringify({ kind: "tmpsfx", resPath: "res://debug_audio/card_deal.mp3", t: Date.now(), pitch: 1.2, volume: .5 }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetcher.mock.calls.map(([url]) => String(url))).toContain("/audio/tmpsfx/debug_audio%2Fcard_deal.mp3?b=tmp-build-9");
    expect(context.sources).toHaveLength(1);
    expect(context.gains.some(g => Math.abs(g.gain.value - 10 ** (-18 / 20) * .5) < 1e-8)).toBe(true);
    engine.dispose(); __resetAssetVersionForTest();
  });

  it("drops an old-seat TmpSfx fetch that resolves after a seat switch", async () => {
    const context = new FakeContext(), sockets: FakeSocket[] = [];
    let resolveFetch!: (response: Response) => void;
    const Ctor = class extends FakeSocket { constructor(url: string) { super(url); sockets.push(this); } } as unknown as typeof WebSocket;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/audio/takes"
      ? new Response(JSON.stringify({ schema: 1, bankset: "b", keys: [] }))
      : await new Promise<Response>(resolve => { resolveFetch = resolve; }));
    const engine = createAudioEngine({ seatUrl: "ws://host/ws?seat=R&lane=audio", renderUrl: "ws://host/audio", indexUrl: "/audio/takes", WebSocketCtor: Ctor, fetcher,
      audioEnv: { createPrelude: () => ({ play: async () => {}, pause() {}, removeAttribute() {} } as unknown as HTMLAudioElement), createContext: () => context as unknown as AudioContextLike }
    });
    await engine.unlock(); engine.start();
    const [seat] = sockets; seat.emit("open");
    seat.emit("message", JSON.stringify({ kind: "volumes", snapshot: true, master: 1, sfx: 1, bgm: 1, ambience: 1, godotMasterDb: 0, godotSfxDb: 0 }));
    seat.emit("message", JSON.stringify({ kind: "tmpsfx", resPath: "res://debug_audio/card_deal.mp3", t: 1, pitch: 1, volume: 1 }));
    await Promise.resolve();
    engine.setSeatUrl("ws://host/ws?seat=S&lane=audio");
    resolveFetch(new Response(new Uint8Array([1, 2, 3])));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(context.sources).toHaveLength(0);
    engine.dispose();
  });
});
