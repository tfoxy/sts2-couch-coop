import { describe, expect, it } from "vitest";
import { connectMirrorClient } from "@/mirror/mirrorClient";
import { CHUNK_BYTES, decodeFrame, frame } from "./framing";
import { createTunnelWebSocketCtor } from "./TunnelWebSocket";
import { fakePair, tick } from "./__tests__/fakeChannel";

function wsHost(selected = "") {
  return fakePair(server => server.addEventListener("message", event => {
    const data = (event as MessageEvent).data;
    server.send(typeof data === "string" ? JSON.stringify({ s: 101, h: [], sp: selected }) : data);
  }));
}
function once<T extends Event = Event>(socket: WebSocket, type: string) {
  return new Promise<T>(resolve => socket.addEventListener(type, event => resolve(event as T), { once: true }));
}
describe("TunnelWebSocket", () => {
  it("opens with protocol and path+query, ignoring the URL scheme", async () => {
    const pair = wsHost("render.v1"); const Ctor = createTunnelWebSocketCtor(pair.open);
    const socket = new Ctor("https://host/ws/render?seat=1", ["render.v1"]);
    expect(socket.readyState).toBe(Ctor.CONNECTING); let opened = false; socket.onopen = () => { opened = true; };
    await once(socket, "open");
    expect(opened).toBe(true); expect(socket.readyState).toBe(Ctor.OPEN); expect(socket.protocol).toBe("render.v1");
    expect(JSON.parse(pair.client.sent[0] as string)).toEqual({ v: 1, t: "ws", m: "GET", p: "/ws/render?seat=1", h: [], sp: ["render.v1"] });
    socket.close(); await once(socket, "close");
  });
  it("round-trips text and binary buffers, views and blobs", async () => {
    const pair = wsHost(); const socket = new (createTunnelWebSocketCtor(pair.open))("ws://host/ws");
    await once(socket, "open"); socket.binaryType = "arraybuffer";
    for (const input of ["hello 🌎", new Uint8Array([0, 1, 2]).buffer, new Uint8Array([9, 3, 4, 9]).subarray(1, 3), new Blob([new Uint8Array([5, 6])])]) {
      const message = once<MessageEvent>(socket, "message"); socket.send(input); const { data } = await message;
      if (typeof input === "string") expect(data).toBe(input);
      else expect([...new Uint8Array(data)]).toEqual(input instanceof Blob ? [5, 6] : ArrayBuffer.isView(input) ? [3, 4] : [0, 1, 2]);
    }
    socket.binaryType = "blob"; const message = once<MessageEvent>(socket, "message"); socket.send(new Uint8Array([7]));
    expect((await message).data).toBeInstanceOf(Blob); socket.close(); await once(socket, "close");
  });
  it("fragments >16 KiB and reassembles UTF-8 across boundaries", async () => {
    const pair = wsHost(); const socket = new (createTunnelWebSocketCtor(pair.open))("wss://host/ws"); await once(socket, "open");
    const text = "a".repeat(CHUNK_BYTES - 1) + "🌎" + "b".repeat(30000);
    const message = once<MessageEvent>(socket, "message"); socket.send(text); expect((await message).data).toBe(text);
    const parts = pair.client.sent.slice(1).map(decodeFrame);
    expect(parts.map(p => p.opcode)).toEqual([1, 0, 0]); expect(parts.map(p => p.fin)).toEqual([false, false, true]);
    expect(parts.every(p => p.payload.length <= CHUNK_BYTES)).toBe(true); socket.close(); await once(socket, "close");
  });
  it("preserves host close codes including 1009 and reasons", async () => {
    for (const code of [1000, 1009, 4001]) {
      const pair = wsHost(); const socket = new (createTunnelWebSocketCtor(pair.open))("ws://host/ws"); await once(socket, "open");
      const closed = once<CloseEvent>(socket, "close");
      pair.server.send(frame(8, new Uint8Array([code >> 8, code & 255, ...new TextEncoder().encode("done")]))); pair.server.close();
      expect(await closed).toMatchObject({ code, reason: "done", wasClean: true }); expect(socket.readyState).toBe(socket.CLOSED);
    }
  });
  it("queues close after sends and validates close arguments", async () => {
    const pair = wsHost(); const socket = new (createTunnelWebSocketCtor(pair.open))("ws://host/ws");
    expect(() => socket.send("early")).toThrow(); await once(socket, "open");
    expect(() => socket.close(1009)).toThrow(); expect(() => socket.close(3000, "x".repeat(124))).toThrow();
    const closed = once<CloseEvent>(socket, "close"); socket.send("last"); socket.close(3001, "bye");
    expect(socket.readyState).toBe(socket.CLOSING); expect(await closed).toMatchObject({ code: 3001, reason: "bye" });
    expect(pair.client.sent.slice(1).map(decodeFrame).map(p => p.opcode)).toEqual([1, 8]);
  });
  it("emits error and abnormal close on channel failure or refused upgrade", async () => {
    const pair = wsHost(); const socket = new (createTunnelWebSocketCtor(pair.open))("ws://host/ws"); await once(socket, "open");
    let errors = 0; socket.onerror = () => { errors++; }; const closed = once<CloseEvent>(socket, "close");
    pair.client.dispatchEvent(new Event("error")); expect(await closed).toMatchObject({ code: 1006, wasClean: false }); expect(errors).toBe(1);
    const refused = fakePair(server => server.addEventListener("message", () => server.send(JSON.stringify({ s: 403, h: [] }))));
    const denied = new (createTunnelWebSocketCtor(refused.open))("ws://host/ws"); const error = once(denied, "error");
    await once(denied, "close"); await error; expect(denied.readyState).toBe(denied.CLOSED);
  });
  it("waits for low water and exposes queued bufferedAmount", async () => {
    const pair = wsHost(); const socket = new (createTunnelWebSocketCtor(pair.open))("ws://host/ws"); await once(socket, "open");
    pair.client.bufferedAmount = 100000; const message = once<MessageEvent>(socket, "message"); socket.send("wait");
    await tick(); expect(socket.bufferedAmount).toBe(100004); expect(pair.client.sent).toHaveLength(1);
    pair.client.drain(); expect((await message).data).toBe("wait"); expect(socket.bufferedAmount).toBe(0);
    socket.close(); await once(socket, "close");
  });
  it("drops in as connectMirrorClient's WebSocketCtor", async () => {
    const pair = wsHost();
    const client = connectMirrorClient({ WebSocketCtor: createTunnelWebSocketCtor(pair.open), location: { href: "https://host/", protocol: "https:" } });
    await tick(); expect(client.status).toBe("connected");
    pair.server.send(frame(1, new TextEncoder().encode(JSON.stringify({ type: "host-access", hostAccess: { allowed: true, reason: "allowed", generation: 0 } }))));
    pair.server.send(frame(1, new TextEncoder().encode(JSON.stringify({ type: "scene-delta", full: true, screenType: "run", upserts: [], removedIds: [], orderedIds: [] }))));
    await tick(); expect(client.state.screenType).toBe("run"); expect(client.state.revision).toBe(1); client.close(); await tick();
  });
});
