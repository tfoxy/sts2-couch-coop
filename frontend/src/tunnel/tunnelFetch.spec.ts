import { describe, expect, it } from "vitest";
import { CHUNK_BYTES, decodeFrame, FETCH_BODY_LIMIT, frame } from "./framing";
import { createTunnelFetch } from "./tunnelFetch";
import { FakeChannel } from "./__tests__/fakeChannel";

import { fakePair, tick } from "./__tests__/fakeChannel";
function fetchHost(reply: (server: FakeChannel, head: Record<string, unknown>, body: Uint8Array) => void) {
  return fakePair(server => {
    let head: Record<string, unknown>;
    const chunks: Uint8Array[] = [];
    server.addEventListener("message", event => {
      const data = (event as MessageEvent).data;
      if (!head) { head = JSON.parse(data); return; }
      const part = decodeFrame(data);
      chunks.push(part.payload);
      if (part.fin) {
        const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
        reply(server, head, body);
      }
    });
  });
}
function answer(server: FakeChannel, body = "ok", status = 200) {
  server.send(JSON.stringify({ s: status, h: [["content-type", "text/plain"]], sp: null }));
  server.send(frame(2, new TextEncoder().encode(body), false)); server.send(frame(0)); server.close();
}
describe("tunnelFetch", () => {
  it("GET passes path, query, header pairs and Range", async () => {
    const pair = fetchHost((server, head, body) => {
      expect(head).toEqual({ v: 1, t: "fetch", m: "GET", p: "/res/a?x=1", h: [["range", "bytes=1-3"]], sp: [] });
      expect(body).toHaveLength(0); answer(server, "abc", 206);
    });
    const response = await createTunnelFetch(pair.open)(new Request("http://host/res/a?x=1", { headers: { Range: "bytes=1-3" } }));
    expect(response.status).toBe(206); expect(response.headers.get("content-type")).toBe("text/plain");
    expect(await response.text()).toBe("abc"); expect(pair.client.binaryType).toBe("arraybuffer");
  });
  it("POST streams a large upload into <=16 KiB continuation frames", async () => {
    const data = new Uint8Array(200000).fill(42);
    const pair = fetchHost((server, head, body) => { expect(head.m).toBe("POST"); expect(body).toEqual(data); answer(server); });
    const response = await createTunnelFetch(pair.open)(new Request("https://host/api", { method: "POST", body: data }));
    expect(await response.text()).toBe("ok");
    const frames = pair.client.sent.slice(1).map(decodeFrame);
    expect(frames[0].opcode).toBe(2); expect(frames.slice(1).every(f => f.opcode === 0)).toBe(true);
    expect(frames.every(f => f.payload.length <= CHUNK_BYTES)).toBe(true); expect(frames.at(-1)?.fin).toBe(true);
  });
  it("retains unread frames until the response consumer asks", async () => {
    const pair = fetchHost(server => answer(server, "queued"));
    const response = await createTunnelFetch(pair.open)(new Request("https://host/"));
    expect(response.bodyUsed).toBe(false); expect(await response.text()).toBe("queued");
  });
  it("retains a 5 MiB response delivered before the consumer starts reading", async () => {
    const pair = fetchHost(server => server.send(JSON.stringify({ s: 200, h: [] })));
    const response = await createTunnelFetch(pair.open)(new Request("https://host/large"));
    const chunk = new Uint8Array(CHUNK_BYTES).fill(42);
    for (let index = 0; index < 320; index++) pair.server.send(frame(index === 0 ? 2 : 0, chunk, false));
    await tick();
    expect(response.bodyUsed).toBe(false);
    expect(pair.client.readyState).toBe("open");
    pair.server.send(frame(0));
    await tick();
    const body = await response.arrayBuffer();
    expect(body.byteLength).toBe(5242880);
    expect(new Uint8Array(body).at(-1)).toBe(42);
  });
  it("waits for the send low-water event", async () => {
    const pair = fetchHost(server => answer(server)); pair.client.bufferedAmount = 100000;
    const pending = createTunnelFetch(pair.open)(new Request("https://host/"));
    await tick(); expect(pair.client.sent).toHaveLength(0); pair.client.drain();
    expect(await (await pending).text()).toBe("ok");
  });
  it("reports a client-side 413 for a streamed upload above 1 MiB", async () => {
    const pair = fakePair(() => {});
    const response = await createTunnelFetch(pair.open)(new Request("https://host/", { method: "POST", body: new Uint8Array(FETCH_BODY_LIMIT + 1) }));
    expect(response.status).toBe(413); expect(pair.client.readyState).toBe("closed");
  });
  it("preserves a host 413", async () => {
    const pair = fetchHost(server => answer(server, "too big", 413));
    const response = await createTunnelFetch(pair.open)(new Request("https://host/"));
    expect(response.status).toBe(413); expect(await response.text()).toBe("too big");
  });
  it("rejects close before headers and errors a body closed before FIN", async () => {
    const before = fetchHost(server => server.close());
    await expect(createTunnelFetch(before.open)(new Request("https://host/"))).rejects.toThrow("closed");
    const after = fetchHost(server => {
      server.send(JSON.stringify({ s: 200, h: [] })); server.send(frame(2, new Uint8Array([1]), false)); server.close();
    });
    const response = await createTunnelFetch(after.open)(new Request("https://host/"));
    await expect(response.arrayBuffer()).rejects.toThrow("closed");
  });
  it("aborts before opening, awaiting headers, and consuming the body", async () => {
    const pair = fakePair(() => {});
    const controller = new AbortController(); controller.abort();
    await expect(createTunnelFetch(pair.open)(new Request("https://host/", { signal: controller.signal }))).rejects.toMatchObject({ name: "AbortError" });
    expect(pair.client.sent).toHaveLength(0);
    const waiting = new AbortController();
    const pending = createTunnelFetch(pair.open)(new Request("https://host/", { signal: waiting.signal }));
    await tick(); waiting.abort(); await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(pair.client.readyState).toBe("closed");
    const bodyAbort = new AbortController();
    const live = fetchHost(server => server.send(JSON.stringify({ s: 200, h: [] })));
    const response = await createTunnelFetch(live.open)(new Request("https://host/", { signal: bodyAbort.signal }));
    const reading = response.text(); bodyAbort.abort(); await expect(reading).rejects.toMatchObject({ name: "AbortError" });
  });
  it("closes a channel that arrives after an aborted opener", async () => {
    const pair = fakePair(() => {}); let resolve!: (channel: RTCDataChannel) => void;
    const controller = new AbortController();
    const pending = createTunnelFetch(() => new Promise(r => { resolve = r; }))(new Request("https://host/", { signal: controller.signal }));
    controller.abort(); await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    resolve(pair.client.asChannel()); await tick(); expect(pair.client.readyState).toBe("closed");
  });
  it("handles null-body status codes and HEAD", async () => {
    for (const [method, status] of [["HEAD", 200], ["GET", 204], ["GET", 304]] as const) {
      const pair = fetchHost(server => { server.send(JSON.stringify({ s: status, h: [] })); server.send(frame(0)); });
      const response = await createTunnelFetch(pair.open)(new Request("https://host/", { method }));
      expect(response.body).toBeNull(); expect(response.status).toBe(status);
    }
  });
});
