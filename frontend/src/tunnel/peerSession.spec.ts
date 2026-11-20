import { describe, expect, it, vi } from "vitest";
import { createPeerSession } from "./peerSession";
import { createTunnelWebSocketCtor } from "./TunnelWebSocket";
import { createTunnelFetch } from "./tunnelFetch";
import { frame } from "./framing";
import { fakePair, tick } from "./__tests__/fakeChannel";

function peer() {
  let lose!: () => void;
  const channels: ReturnType<typeof fakePair>[] = [];
  return {
    closed: new Promise<void>(resolve => { lose = resolve; }),
    lose: () => lose(), close: vi.fn(() => lose()), channels,
    openChannel: vi.fn(async () => {
      const pair = fakePair(server => server.addEventListener("message", event => {
        const data = (event as MessageEvent).data;
        if (typeof data !== "string") return;
        const head = JSON.parse(data);
        server.send(JSON.stringify({ s: head.t === "ws" ? 101 : 200, h: [] }));
        if (head.t === "fetch") server.send(frame(2, new TextEncoder().encode("ok")));
      }));
      channels.push(pair);
      return pair.open("couch-tunnel/1");
    })
  };
}

describe("host peer session", () => {
  it("closes open sockets on peer loss and reconnects only on the next request", async () => {
    const first = peer(); const second = peer();
    const reconnect = vi.fn(async () => second);
    const session = createPeerSession(first, reconnect);
    const Socket = createTunnelWebSocketCtor(session.open);
    const socket = new Socket("wss://host/ws");
    await tick();
    expect(socket.readyState).toBe(Socket.OPEN);
    const closed = vi.fn(); socket.addEventListener("close", closed);
    first.lose(); await tick();
    expect(socket.readyState).toBe(Socket.CLOSED);
    expect(closed).toHaveBeenCalledOnce();
    expect(closed.mock.calls[0]![0]).toMatchObject({ code: 1006 });
    expect(reconnect).not.toHaveBeenCalled();
    const response = await createTunnelFetch(session.open)(new Request("https://host/res/a"));
    expect(await response.text()).toBe("ok");
    expect(reconnect).toHaveBeenCalledOnce();
    expect(session.closed).toBe(second.closed);
    session.close();
  });

  it("shares a pending peer between concurrent socket and fetch requests", async () => {
    const first = peer(); const second = peer();
    let connected!: (value: ReturnType<typeof peer>) => void;
    const reconnect = vi.fn(() => new Promise<ReturnType<typeof peer>>(resolve => { connected = resolve; }));
    const session = createPeerSession(first, reconnect);
    first.lose(); await tick();
    const Socket = createTunnelWebSocketCtor(session.open);
    const socket = new Socket("wss://host/ws");
    const fetch = createTunnelFetch(session.open)(new Request("https://host/res/a"));
    await tick(); expect(reconnect).toHaveBeenCalledOnce();
    connected(second);
    expect(await (await fetch).text()).toBe("ok");
    await tick(); expect(socket.readyState).toBe(Socket.OPEN);
    expect(second.openChannel).toHaveBeenCalledTimes(2);
    session.close(); await tick();
  });

  it("allows a later request to retry a failed reconnect", async () => {
    const first = peer(); const second = peer();
    const reconnect = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(second);
    const session = createPeerSession(first, reconnect);
    first.lose(); await tick();
    await expect(session.open("couch-tunnel/1")).rejects.toThrow("timeout");
    await session.open("couch-tunnel/1");
    expect(reconnect).toHaveBeenCalledTimes(2);
    session.close();
  });

  it("closes a channel that finishes opening after its peer dies", async () => {
    const first = peer(); const pair = fakePair(() => {});
    let opened!: (channel: RTCDataChannel) => void;
    first.openChannel.mockImplementationOnce(() => new Promise(resolve => { opened = resolve; }));
    const session = createPeerSession(first, vi.fn());
    const opening = session.open("couch-tunnel/1");
    first.lose(); await tick();
    opened(pair.client.asChannel());
    await expect(opening).rejects.toThrow("closed");
    expect(pair.client.readyState).toBe("closed");
    session.close();
  });

  it("closes a late reconnect after the session has stopped", async () => {
    const first = peer(); const second = peer();
    let connected!: (value: ReturnType<typeof peer>) => void;
    const session = createPeerSession(first, () => new Promise(resolve => { connected = resolve; }));
    first.lose(); await tick();
    const opening = session.open("couch-tunnel/1");
    await tick(); session.close(); connected(second);
    await expect(opening).rejects.toThrow("stopped");
    expect(second.close).toHaveBeenCalledOnce();
    await expect(session.open("couch-tunnel/1")).rejects.toThrow("stopped");
  });
});
