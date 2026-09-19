// The transport half of the client-vitals census: the throttle, and the two states in which it must send nothing.
//
// The throttle lives in the client rather than only at its caller because of what this feature is FOR. It runs on
// a page already short of memory, and each send costs a DOM census plus a JSON.stringify. A future caller that
// drove it from a frame callback would turn a diagnostic into a contributing cause, so the guard has to hold
// wherever it is called from.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectMirrorClient } from "@/mirror/mirrorClient";
import type { ClientVitalsSources } from "@/mirror/clientVitals";

const ATTEMPT = "attempt-1";

class MockWebSocket extends EventTarget {
  static instances: MockWebSocket[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  url: string;
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];

  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }
}

const vitalsSources: ClientVitalsSources = {
  requestedStage: () => "dom",
  activeStage: () => "dom",
  canvasResidency: () => null,
  atlasResidency: () => ({ bytes: 0, pages: 0, cap: 96 * 1024 * 1024 }),
  effectModes: () => ({ shaderMode: "static", particleMode: "static" }),
  doc: () => null,
  view: () => null
};

function connect() {
  const client = connectMirrorClient({
    url: "ws://host.invalid/ws",
    WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
    vitalsSources
  });
  return { client, socket: MockWebSocket.instances[MockWebSocket.instances.length - 1]! };
}

/** Every vitals receipt this socket has sent, parsed. */
function receipts(socket: MockWebSocket): Record<string, unknown>[] {
  return socket.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((message) => message.type === "client-vitals");
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.spyOn(performance, "now").mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendClientVitals", () => {
  it("sends a census carrying the attempt id", () => {
    const { client, socket } = connect();

    expect(client.sendClientVitals(ATTEMPT)).toBe(true);
    const [census] = receipts(socket);
    expect(census?.attemptId).toBe(ATTEMPT);
    expect(census?.stageActive).toBe("dom");
    expect(census?.canvases).toBe(0);
  });

  it("throttles to one census per 2s however often it is called", () => {
    const { client, socket } = connect();

    expect(client.sendClientVitals(ATTEMPT)).toBe(true);
    for (let i = 0; i < 100; i += 1) {
      vi.spyOn(performance, "now").mockReturnValue(i * 19);
      expect(client.sendClientVitals(ATTEMPT)).toBe(false);
    }
    expect(receipts(socket)).toHaveLength(1);

    vi.spyOn(performance, "now").mockReturnValue(2_000);
    expect(client.sendClientVitals(ATTEMPT)).toBe(true);
    expect(receipts(socket)).toHaveLength(2);
  });

  it("sends nothing on a socket that is not open", () => {
    const { client, socket } = connect();
    socket.close();

    expect(client.sendClientVitals(ATTEMPT)).toBe(false);
    expect(receipts(socket)).toHaveLength(0);
  });

  it("sends nothing without an attempt id", () => {
    // Not because the host addresses the census by attempt — it files it against the connection — but because no
    // attempt means nothing has been presented yet, and a census of an empty page is worse than no census: it
    // would sit in the report looking like a reading of the screen that died.
    const { client, socket } = connect();

    expect(client.sendClientVitals("")).toBe(false);
    expect(receipts(socket)).toHaveLength(0);
  });

  it("spends the throttle slot even when the send throws", () => {
    // A socket closing under us must not turn into a DOM census on every subsequent call.
    const { client, socket } = connect();
    socket.send = () => { throw new Error("racing close"); };

    expect(client.sendClientVitals(ATTEMPT)).toBe(false);
    vi.spyOn(performance, "now").mockReturnValue(1_999);
    expect(client.sendClientVitals(ATTEMPT)).toBe(false);
    expect(receipts(socket)).toHaveLength(0);
  });
});
