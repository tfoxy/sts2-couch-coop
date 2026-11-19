import { expect } from "vitest";
import type { OpenChannel } from "../framing";

export class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  binaryType = "blob";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: (string | ArrayBuffer)[] = [];
  peer!: FakeChannel;
  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (this.readyState !== "open") throw new Error("Closed channel");
    const copy = typeof data === "string" ? data : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer : data.slice(0);
    this.sent.push(copy);
    queueMicrotask(() => this.peer.dispatchEvent(new MessageEvent("message", { data: copy })));
  }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = this.peer.readyState = "closed";
    queueMicrotask(() => {
      this.dispatchEvent(new Event("close"));
      this.peer.dispatchEvent(new Event("close"));
    });
  }
  drain() { this.bufferedAmount = 0; this.dispatchEvent(new Event("bufferedamountlow")); }
  asChannel() { return this as unknown as RTCDataChannel; }
}

export const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
export function fakePair(host: (channel: FakeChannel) => void) {
  const client = new FakeChannel();
  const server = new FakeChannel();
  client.peer = server; server.peer = client;
  const open: OpenChannel = async label => { expect(label).toBe("couch-tunnel/1"); host(server); return client.asChannel(); };
  return { open, client, server };
}
