import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioTrack, OpenAudioTrackOptions } from "@godot-scene-web/render-stream-client/audio";
import { createStreamAudioEngine } from "../streamAudioEngine";
import type { AudioContextLike } from "../audioUnlock";
import { FakeContext, FakeSocket } from "./fakes";

function rig() {
  const context = new FakeContext();
  const sockets: FakeSocket[] = [];
  const Ctor = class extends FakeSocket { constructor(url: string) { super(url); sockets.push(this); } } as unknown as typeof WebSocket;
  const close = vi.fn();
  const openTrack = vi.fn((_options: OpenAudioTrackOptions) => ({ close } as unknown as AudioTrack));
  const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2])));
  const onUnavailable = vi.fn();
  const createContext = vi.fn(() => context as unknown as AudioContextLike);
  const audioEnv = { createContext, createPrelude: () => ({ play: async () => {}, pause() {}, removeAttribute() {} } as unknown as HTMLAudioElement) };
  const engine = createStreamAudioEngine({
    endpoint: { url: "ws://host/render-stream/R/ws", resourceBase: "http://host/render-stream/R",
      token: "a".repeat(64), viewToken: "b".repeat(64) },
    demandUrl: "ws://host/ws?seat=R&lane=stream-audio", WebSocketCtor: Ctor, audioEnv, openTrack,
    fetcher: fetcher as unknown as typeof fetch, onUnavailable
  });
  return { engine, context, sockets, openTrack, close, fetcher, onUnavailable, audioEnv, createContext };
}
afterEach(() => { vi.restoreAllMocks(); });

describe("GSW stream audio lifecycle", () => {
  it("waits for gesture and the host link before opening the separately credentialed track", async () => {
    const r = rig();
    r.engine.start();
    expect(r.createContext).not.toHaveBeenCalled();
    expect(r.sockets).toHaveLength(0);
    expect(await r.engine.unlock()).toBe(true);
    expect(r.sockets).toHaveLength(0);
    r.engine.start(); r.engine.start();
    expect(r.sockets.map(s => s.url)).toEqual(["ws://host/ws?seat=R&lane=stream-audio"]);
    expect(r.openTrack).not.toHaveBeenCalled();
    r.sockets[0].emit("message", '{"kind":"ready"}');
    r.sockets[0].emit("message", '{"kind":"ready"}');
    expect(r.openTrack).toHaveBeenCalledTimes(1);
    expect(r.openTrack.mock.calls[0][0]).toMatchObject({ credential: "a".repeat(64), context: r.context,
      url: "ws://host/render-stream/R/ws", workerUrl: expect.any(String), workletUrl: expect.any(String) });
    expect(r.fetcher).not.toHaveBeenCalled();
    r.engine.dispose();
  });

  it("closes both paths on hide and requires a new gesture before restarting", async () => {
    const r = rig();
    await r.engine.unlock(); r.engine.start();
    r.sockets[0].emit("message", '{"kind":"ready"}');
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    r.engine.stop();
    expect(r.close).toHaveBeenCalledTimes(1);
    expect(r.sockets[0].readyState).toBe(3);
    expect(r.context.state).toBe("suspended");
    expect(await r.engine.unlock()).toBe(false);
    vi.restoreAllMocks();
    r.engine.start();
    expect(r.sockets).toHaveLength(1);
    await r.engine.unlock(); r.engine.start();
    expect(r.sockets).toHaveLength(2);
    r.engine.dispose(); r.engine.dispose();
    expect(r.sockets[1].readyState).toBe(3);
    expect(r.context.state).toBe("closed");
  });

  it("does not resurrect a track after toggle-off while waiting for readiness", async () => {
    const r = rig();
    await r.engine.unlock(); r.engine.start();
    r.engine.dispose();
    r.sockets[0].emit("message", '{"kind":"ready"}');
    r.sockets[0].emit("close");
    expect(r.openTrack).not.toHaveBeenCalled();
    expect(r.onUnavailable).not.toHaveBeenCalled();
    expect(await r.engine.unlock()).toBe(false);
  });

  it("fences an unlock that finishes after the viewer hides", async () => {
    const r = rig();
    let finish!: () => void;
    r.audioEnv.createPrelude = () => ({ play: () => new Promise<void>(resolve => { finish = resolve; }), pause() {}, removeAttribute() {} } as unknown as HTMLAudioElement);
    const unlocking = r.engine.unlock();
    r.engine.stop(); finish();
    await unlocking;
    r.engine.start();
    expect(r.sockets).toHaveLength(0);
    expect(r.context.state).toBe("suspended");
    r.engine.dispose();
  });

  it.each(["close", "error"])("releases the track when the demand socket emits %s", async (event) => {
    const r = rig();
    await r.engine.unlock(); r.engine.start();
    r.sockets[0].emit("message", '{"kind":"ready"}');
    r.sockets[0].emit(event); r.sockets[0].emit(event);
    expect(r.close).toHaveBeenCalledTimes(1);
    expect(r.onUnavailable).toHaveBeenCalledTimes(1);
    expect(r.context.state).toBe("suspended");
    r.engine.dispose();
  });

  it("fetches sample resources under view auth and honors no-store", async () => {
    const r = rig();
    await r.engine.unlock(); r.engine.start();
    r.sockets[0].emit("message", '{"kind":"ready"}');
    const options = r.openTrack.mock.calls[0][0];
    const hash = "c".repeat(64);
    await options.fetchAsset!(hash, { store: false, cache: "no-store" });
    expect(r.fetcher).toHaveBeenCalledWith(`http://host/render-stream/R/resources/sha256/${hash}`, {
      cache: "no-store", credentials: "omit", headers: { Authorization: `Bearer ${"b".repeat(64)}` }
    });
    await expect(options.fetchAsset!("../bank", { store: true, cache: "default" })).rejects.toThrow("Invalid audio asset hash");
    expect(r.fetcher).toHaveBeenCalledTimes(1);
    options.onClose?.({ code: 1000, reason: "closed", detail: null, by: "transport", opened: true, willReconnect: false, reconnectInMs: null });
    expect(r.close).toHaveBeenCalledTimes(1);
    r.engine.dispose();
  });
});
