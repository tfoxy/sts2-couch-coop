import { afterEach, describe, expect, it, vi } from "vitest";

import { connectMirrorClient } from "@/mirror/mirrorClient";

// A capturing WebSocket mock: records every sent frame (as parsed JSON) and lets a test drive inbound messages.
class MockWebSocket extends EventTarget {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.OPEN;
  sent: unknown[] = [];
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  emit(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  sentOfType(type: string): Record<string, unknown>[] {
    return this.sent.filter((m): m is Record<string, unknown> => (m as { type?: unknown }).type === type);
  }
}

function connect() {
  MockWebSocket.instances = [];
  const client = connectMirrorClient({
    WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
    location: { href: "http://localhost/", protocol: "http:" }
  });
  return { client, socket: MockWebSocket.instances[0] };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("sendSettings", () => {
  it("emits a flat `settings` frame with a sequenced requestId", async () => {
    const { client, socket } = connect();
    await Promise.resolve();

    client.sendSettings({ refreshRate: 30, freezeParticles: false });
    client.sendSettings({ tweenReplay: false });

    const settings = socket.sentOfType("settings");
    expect(settings).toEqual([
      { type: "settings", requestId: "settings:1", refreshRate: 30, freezeParticles: false },
      { type: "settings", requestId: "settings:2", tweenReplay: false }
    ]);
  });

  it("no-ops when the socket is not open", async () => {
    const { client, socket } = connect();
    await Promise.resolve();
    socket.readyState = 3; // closing/closed

    client.sendSettings({ tweenReplay: false });
    expect(socket.sentOfType("settings")).toHaveLength(0);
  });

  it("forwards to a JOINED or DIRECT-VIEW connection (the MirrorApp gate)", async () => {
    const { client, socket } = connect();
    await Promise.resolve();

    // Mirrors MirrorApp's watch: forward the server settings when `joined` OR `directView` is true (the latter
    // is a host-watch / singleplayer viewer whose only observable settings channel is the shared host socket).
    const forward = (joined: boolean, directView: boolean) => {
      if (joined || directView) {
        client.sendSettings({ refreshRate: 12 });
      }
    };
    forward(false, false);
    expect(socket.sentOfType("settings")).toHaveLength(0);
    // Direct-view alone (not joined) now forwards, where it used to be silently dropped.
    forward(false, true);
    expect(socket.sentOfType("settings")).toEqual([
      { type: "settings", requestId: "settings:1", refreshRate: 12 }
    ]);
    forward(true, false);
    expect(socket.sentOfType("settings")).toHaveLength(2);
  });
});

describe("two-bucket latency", () => {
  it("buckets network pongs and game (mainThread) pongs into separate rolling windows", async () => {
    const { client, socket } = connect();
    await Promise.resolve();

    // A plain pong lands in the NETWORK bucket (the flat lastMs/p50/p95/count fields).
    socket.emit({ type: "pong", t0: performance.now() - 10 });
    expect(client.latency.count).toBe(1);
    expect(client.latency.lastMs).toBeGreaterThanOrEqual(0);
    expect(client.latency.p50).not.toBeNull();
    // The game bucket is untouched.
    expect(client.latency.gameCount).toBe(0);
    expect(client.latency.gameP50).toBeNull();

    // A `mainThread:true` pong lands in the GAME bucket, leaving the network bucket alone.
    socket.emit({ type: "pong", t0: performance.now() - 20, mainThread: true });
    expect(client.latency.gameCount).toBe(1);
    expect(client.latency.gameLastMs).toBeGreaterThanOrEqual(0);
    expect(client.latency.gameP95).not.toBeNull();
    expect(client.latency.count).toBe(1); // network unchanged
  });
});

describe("setPingInterval", () => {
  it("sends BOTH a network ping and a game (mainThread) ping per tick, and stops at 0", async () => {
    vi.useFakeTimers();
    const { client, socket } = connect();
    await Promise.resolve(); // flush the queued "open"

    client.setPingInterval(250);
    // Immediate probe on start: one plain ping + one mainThread ping.
    let pings = socket.sentOfType("ping");
    expect(pings).toHaveLength(2);
    expect(pings.some((p) => p.mainThread === true)).toBe(true);
    expect(pings.some((p) => p.mainThread === undefined)).toBe(true);

    // Clear both single-outstanding guards so the next tick can fire, then advance one interval.
    socket.emit({ type: "pong", t0: performance.now() });
    socket.emit({ type: "pong", t0: performance.now(), mainThread: true });
    vi.advanceTimersByTime(250);
    expect(socket.sentOfType("ping")).toHaveLength(4);

    // Turning it off clears the timer: no further pings even after clearing the guards + advancing.
    client.setPingInterval(0);
    socket.emit({ type: "pong", t0: performance.now() });
    socket.emit({ type: "pong", t0: performance.now(), mainThread: true });
    vi.advanceTimersByTime(1000);
    expect(socket.sentOfType("ping")).toHaveLength(4);

    client.close();
  });
});
