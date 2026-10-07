import { describe, expect, it, vi } from "vitest";
import { openRenderLane } from "../renderLane";

class FakeSocket {
  static CONNECTING = 0; static OPEN = 1;
  readyState = FakeSocket.CONNECTING; binaryType = "";
  sent: string[] = [];
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: MessageEvent) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  emit(type: string): void { if (type === "open") this.readyState = FakeSocket.OPEN; for (const fn of this.listeners.get(type) ?? []) fn({} as MessageEvent); }
}

describe("render audio lane admission", () => {
  it("queues desired lanes and bounded cold plays until the socket opens", () => {
    const sockets: FakeSocket[] = [];
    const Ctor = class extends FakeSocket { constructor(url: string) { super(url); sockets.push(this); } } as unknown as typeof WebSocket;
    const handle = openRenderLane("ws://host/audio", () => {}, () => {}, Ctor);
    handle.request({ kind: "lanes", music: true, ambience: true, loops: true });
    handle.request({ kind: "lanes", music: false, ambience: false, loops: false });
    for (let i = 0; i < 140; i++) handle.request({ kind: "play", keyId: String(i).padStart(32, "0"), key: "key" });
    sockets[0].emit("open");
    const sent = sockets[0].sent.map(value => JSON.parse(value));
    expect(sent[0]).toEqual({ kind: "lanes", music: false, ambience: false, loops: false });
    expect(sent.filter(message => message.kind !== "clock")).toHaveLength(128);
    expect(sent.filter(message => message.kind === "clock")).toHaveLength(8);
    expect(sent[127]).toEqual({ kind: "play", keyId: "00000000000000000000000000000139", key: "key" });
    handle.probeClock();
    expect(JSON.parse(sockets[0].sent.at(-1)!)).toMatchObject({ kind: "clock", seq: 9 });
    handle.close();
  });

  it("reports a host audio route failure once so the engine can stop dormant work", () => {
    const sockets: FakeSocket[] = [], unavailable = vi.fn();
    const Ctor = class extends FakeSocket { constructor(url: string) { super(url); sockets.push(this); } } as unknown as typeof WebSocket;
    const handle = openRenderLane("ws://host/audio", () => {}, () => {}, Ctor, unavailable);
    sockets[0].emit("error");
    expect(unavailable).toHaveBeenCalledOnce();
    handle.close();
  });
});
