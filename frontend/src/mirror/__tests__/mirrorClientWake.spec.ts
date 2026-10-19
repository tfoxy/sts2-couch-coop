import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectMirrorClient, WAKE_PING_TIMEOUT_MS, type MirrorClient } from "@/mirror/mirrorClient";

class WakeSocket extends EventTarget {
  static OPEN = 1;
  static instances: WakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closeCalls = 0;
  emitClose = true;
  throwOnSend = false;

  constructor(_url: string) {
    super();
    WakeSocket.instances.push(this);
  }
  open(): void {
    this.readyState = WakeSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }
  send(data: string): void {
    if (this.throwOnSend) throw new Error("transport suspended");
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closeCalls++;
    this.readyState = 3;
    if (this.emitClose) this.dispatchEvent(new Event("close"));
  }
  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}

let visible = true;
const clients: MirrorClient[] = [];

function connect(pingIntervalMs = 0) {
  const changed = vi.fn();
  const client = connectMirrorClient({
    WebSocketCtor: WakeSocket as unknown as typeof WebSocket,
    location: { href: "http://host:13337/", protocol: "http:" },
    pingIntervalMs,
    onChange: changed
  });
  clients.push(client);
  const socket = WakeSocket.instances.at(-1)!;
  return { client, socket, changed };
}

function visibility(on: boolean): void {
  visible = on;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  visible = true;
  WakeSocket.instances = [];
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible ? "visible" : "hidden");
});

afterEach(() => {
  clients.splice(0).forEach(client => client.close());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("socket validation when a phone resumes", () => {
  it("uses one network ping for coalesced wake events, with no steady polling", () => {
    const { client, socket } = connect();
    socket.open();
    vi.advanceTimersByTime(60_000);
    expect(socket.sent).toEqual([]);

    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("online"));
    visibility(true);
    expect(socket.sent).toEqual([{ type: "ping", t0: -1 }]);
    socket.receive({ type: "pong", t0: -1 });
    vi.advanceTimersByTime(60_000);

    expect(client.status).toBe("connected");
    expect(socket.sent).toHaveLength(1);
    expect(client.latency.count).toBe(0);
    expect(client.latency.gameCount).toBe(0);
  });

  it("requires the matching network pong and publishes one drop even without onclose", () => {
    const { client, socket, changed } = connect();
    socket.open();
    changed.mockClear();
    socket.emitClose = false;
    window.dispatchEvent(new Event("online"));
    socket.receive({ type: "pong", t0: 0 });
    socket.receive({ type: "pong", t0: -2 });
    socket.receive({ type: "pong", t0: -1, mainThread: true });
    vi.advanceTimersByTime(WAKE_PING_TIMEOUT_MS - 1);
    expect(client.status).toBe("connected");
    vi.advanceTimersByTime(1);

    expect(client.status).toBe("disconnected");
    expect(socket.closeCalls).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);
    socket.dispatchEvent(new Event("close"));
    socket.dispatchEvent(new Event("error"));
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending deadline when hidden and rejects a stale reply on the next wake", () => {
    const { client, socket } = connect();
    socket.open();
    window.dispatchEvent(new Event("pageshow"));
    visibility(false);
    window.dispatchEvent(new Event("online"));
    vi.advanceTimersByTime(60_000);
    expect(client.status).toBe("connected");
    expect(socket.sent).toHaveLength(1);

    visibility(true);
    expect(socket.sent.at(-1)).toEqual({ type: "ping", t0: -2 });
    socket.receive({ type: "pong", t0: -1 });
    vi.advanceTimersByTime(WAKE_PING_TIMEOUT_MS);
    expect(client.status).toBe("disconnected");
  });

  it("cancels on pagehide and starts a fresh check on pageshow", () => {
    const { client, socket } = connect();
    socket.open();
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("pagehide"));
    vi.advanceTimersByTime(WAKE_PING_TIMEOUT_MS);
    expect(client.status).toBe("connected");
    window.dispatchEvent(new Event("pageshow"));
    socket.receive({ type: "pong", t0: -2 });
    vi.advanceTimersByTime(WAKE_PING_TIMEOUT_MS);
    expect(client.status).toBe("connected");
    expect(socket.sent).toHaveLength(2);
  });

  it("does not disturb an opening socket, and handles a failed wake send immediately", () => {
    const { client, socket, changed } = connect();
    window.dispatchEvent(new Event("online"));
    vi.advanceTimersByTime(WAKE_PING_TIMEOUT_MS);
    expect(client.status).toBe("connecting");
    socket.open();
    changed.mockClear();
    socket.throwOnSend = true;
    window.dispatchEvent(new Event("online"));
    expect(client.status).toBe("disconnected");
    expect(changed).toHaveBeenCalledTimes(1);
    expect(socket.closeCalls).toBe(1);
  });

  it.each(["close", "error", "server-reload"])("removes wake listeners and deadlines after %s", (ending) => {
    const { client, socket } = connect();
    socket.open();
    window.dispatchEvent(new Event("online"));
    if (ending === "close") client.close();
    else if (ending === "error") socket.dispatchEvent(new Event("error"));
    else socket.receive({ type: "server-reload", reason: "headless-host-disconnected" });
    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("online"));
    visibility(true);
    // A late open from a retired transport cannot revive the client or reinstall its probe.
    socket.open();
    expect(client.status).toBe("disconnected");
    expect(socket.sent).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(ending === "server-reload" ? 1 : 0);
  });

  it("keeps the optional latency probe separate from wake validation", () => {
    const { client, socket } = connect(1000);
    socket.open();
    const ordinaryPing = socket.sent[0];
    window.dispatchEvent(new Event("online"));
    socket.receive({ type: "pong", t0: ordinaryPing.t0 });
    socket.receive({ type: "pong", t0: -1 });
    expect(client.latency.count).toBe(1);
    expect(client.latency.gameCount).toBe(0);
    vi.advanceTimersByTime(WAKE_PING_TIMEOUT_MS);
    expect(client.status).toBe("connected");
  });
});
