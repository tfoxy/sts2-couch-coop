import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerSocketCtor, serveWorkerSockets } from "./workerSockets";
import { createFakeWorkerChannelPair } from "@/audio/__tests__/fakes";

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function rig() {
  const ends = createFakeWorkerChannelPair();
  const ports = ends.map(end => Object.assign(end, { start: vi.fn(), close: vi.fn() })) as unknown as [MessagePort, MessagePort];
  const sockets: WebSocket[] = [];
  const sent: unknown[] = [];
  const close = vi.fn();
  const Socket = class {
    static OPEN = 1;
    readyState = 1;
    binaryType = "blob";
    protocol = "test";
    onopen: WebSocket["onopen"] = null;
    onmessage: WebSocket["onmessage"] = null;
    onclose: WebSocket["onclose"] = null;
    onerror: WebSocket["onerror"] = null;
    constructor(readonly url: string) { sockets.push(this as unknown as WebSocket); }
    send(data: unknown) { sent.push(data); }
    close = close;
  } as unknown as typeof WebSocket;
  const stop = serveWorkerSockets(ports[0], Socket);
  const proxy = createWorkerSocketCtor(ports[1]);
  return { proxy, stop, sockets, sent, close };
}

afterEach(() => vi.restoreAllMocks());

describe("worker tunnel sockets", () => {
  it("relays concurrent sockets, binary records, sends, and peer close events", async () => {
    const r = rig();
    const seat = new r.proxy.WebSocket("wss://pages/~h/tab/ws?seat=route");
    const audio = new r.proxy.WebSocket("wss://pages/~h/tab/audio");
    audio.binaryType = "arraybuffer";
    expect(() => seat.send("early")).toThrow();
    await settle();
    expect(r.sockets.map(s => s.url)).toEqual([seat.url, audio.url]);
    for (const socket of r.sockets) socket.onopen?.call(socket, new Event("open"));
    await settle();
    expect(seat.readyState).toBe(r.proxy.WebSocket.OPEN);
    expect(seat.protocol).toBe("test");
    seat.send("hello");
    await settle();
    expect(r.sent).toEqual(["hello"]);
    const message = vi.fn();
    audio.addEventListener("message", message);
    const bytes = new Uint8Array([3, 4]).buffer;
    r.sockets[1]!.onmessage?.call(r.sockets[1]!, new MessageEvent("message", { data: bytes }));
    await settle();
    expect(message.mock.calls[0]![0].data).toBe(bytes);
    const closed = vi.fn();
    audio.addEventListener("close", closed);
    r.sockets[1]!.onclose?.call(r.sockets[1]!, new CloseEvent("close", { code: 1006 }));
    await settle();
    expect(audio.readyState).toBe(r.proxy.WebSocket.CLOSED);
    expect(closed).toHaveBeenCalledOnce();
    seat.close(1000, "done");
    await settle();
    expect(r.close).toHaveBeenCalledWith(1000, "done");
    r.proxy.dispose(); r.stop();
  });

  it("closes failed construction through the normal socket error and close events", async () => {
    const ends = createFakeWorkerChannelPair().map(end => Object.assign(end, { start() {}, close() {} })) as unknown as [MessagePort, MessagePort];
    const stop = serveWorkerSockets(ends[0], class { constructor() { throw new Error("unavailable"); } } as unknown as typeof WebSocket);
    const proxy = createWorkerSocketCtor(ends[1]);
    const socket = new proxy.WebSocket("wss://pages/ws");
    const error = vi.fn(), close = vi.fn();
    socket.onerror = error; socket.onclose = close;
    await settle();
    expect(error).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(socket.readyState).toBe(proxy.WebSocket.CLOSED);
    proxy.dispose(); stop();
  });

  it("releases window sockets on worker teardown", async () => {
    const r = rig();
    new r.proxy.WebSocket("wss://pages/audio");
    await settle();
    r.stop();
    expect(r.close).toHaveBeenCalledOnce();
    expect(r.sockets[0]!.onclose).toBeNull();
    r.proxy.dispose();
  });
});
