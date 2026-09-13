import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildHeadlessMirrorWebSocketUrl,
  buildMirrorWebSocketUrl,
  connectMirrorClient
} from "@/mirror/mirrorClient";

// WS-B STREAM GATE (web client half). The host must send nothing to a viewer sitting on the join picker, and the
// client must neither ASK for it nor apply anything that slips through. The gate's INITIAL value rides the connect
// query (`watch=0`) because only that can suppress the host's connect-time keyframe; later flips ride a
// `{type:"watch",on}` control message. C#/native twin: MirrorSocket + ConnectionCoordinator.

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

function connect(watch?: boolean) {
  MockWebSocket.instances = [];
  const client = connectMirrorClient({
    watch,
    WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
    location: { href: "http://localhost/", protocol: "http:" }
  });
  return { client, socket: MockWebSocket.instances[0] };
}

// A minimal but real scene-delta keyframe (one node) the client would otherwise apply to its retained map.
const keyframe = {
  type: "scene-delta",
  full: true,
  screenType: "run",
  screenInstanceId: "screen:run:live",
  upserts: [{ id: "1", name: "Root", nodeType: "Control", visible: true }],
  removedIds: [],
  orderedIds: ["1"]
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("connection diagnostic receipts", () => {
  it("sends presentation on the original gated socket without granting scene credit", () => {
    const { client, socket } = connect(false);
    client.sendClientFramePresented("attempt-1");
    expect(socket.sentOfType("client-frame-presented")).toEqual([
      { type: "client-frame-presented", attemptId: "attempt-1" }
    ]);
    expect(socket.sentOfType("scene-ack")).toEqual([]);
    client.close();
    client.sendClientFramePresented("attempt-2");
    expect(socket.sentOfType("client-frame-presented")).toHaveLength(1);
  });

  it("bounds rendering error details and retains the attempt discriminator", () => {
    const { client, socket } = connect(false);
    client.sendClientViewError("attempt-1", new Error("x".repeat(3000)));
    const message = socket.sentOfType("client-view-error")[0];
    expect(message).toMatchObject({ attemptId: "attempt-1", code: "browser-render-failed" });
    expect((message.detail as string).length).toBe(2048);
    client.sendClientFramePresented("");
    client.sendClientFramePresented("x".repeat(129));
    expect(socket.sentOfType("client-frame-presented")).toEqual([]);
    client.close();
  });
});

describe("buildMirrorWebSocketUrl", () => {
  it("mints the complete canonical selector set", () => {
    const url = buildMirrorWebSocketUrl({ href: "http://host:13337/", protocol: "http:" });
    expect(url).toBe("ws://host:13337/ws?watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0");
    expect([...new URL(url).searchParams.entries()]).toEqual([
      ["watch", "1"],
      ["staticBg", "0"],
      ["cardFlight", "1"],
      ["handTween", "1"],
      ["trailDrive", "0"]
    ]);
  });

  it("adds `watch=0` when gated", () => {
    const url = buildMirrorWebSocketUrl({ href: "http://host:13337/", protocol: "http:" }, false);
    expect(new URL(url).searchParams.get("watch")).toBe("0");
    expect(new URL(url).searchParams.get("view")).toBeNull();
  });

  // Stage-B walk skip: the connect query tells the host from the first byte whether this viewer covers the static
  // combat background, so a sole fresh viewer's keyframe can omit the live subtree.
  it("sets `staticBg=1` when the viewer shows the static background", () => {
    const on = buildMirrorWebSocketUrl({ href: "http://host:13337/", protocol: "http:" }, true, true);
    expect(new URL(on).searchParams.get("staticBg")).toBe("1");
    expect(new URL(on).searchParams.get("view")).toBeNull();

    const off = buildMirrorWebSocketUrl({ href: "http://host:13337/", protocol: "http:" }, true, false);
    expect(new URL(off).searchParams.get("staticBg")).toBe("0");
    // The false state is explicit too: every current connection has the complete query.
    expect(buildMirrorWebSocketUrl({ href: "http://host:13337/", protocol: "http:" })).toBe(
      "ws://host:13337/ws?watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0"
    );
  });

  // R14 trail drive: the declaration rides the connect URL so the first flight after connect is already correct.
  it("sets `trailDrive=1` when the viewer drives the trail root", () => {
    const on = buildMirrorWebSocketUrl({ href: "http://host:13337/", protocol: "http:" }, true, false, true);
    expect(new URL(on).searchParams.get("trailDrive")).toBe("1");
    expect(new URL(on).searchParams.get("view")).toBeNull();

    const off = buildMirrorWebSocketUrl({ href: "http://host:13337/", protocol: "http:" }, true, false, false);
    expect(new URL(off).searchParams.get("trailDrive")).toBe("0");
    expect(off).toBe("ws://host:13337/ws?watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0");
  });
});

describe("buildHeadlessMirrorWebSocketUrl", () => {
  // The redirected connection carries the same complete selector set.
  it("mints the same complete selector set for a redirected client", () => {
    const base = buildHeadlessMirrorWebSocketUrl(13347, { href: "http://host:13337/", protocol: "http:" });
    expect(base).toBe("ws://host:13347/ws?watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0");
    const on = buildHeadlessMirrorWebSocketUrl(13347, { href: "http://host:13337/", protocol: "http:" }, true);
    expect(new URL(on).searchParams.get("staticBg")).toBe("1");
    expect(new URL(on).port).toBe("13347");
  });

  // R14: the redirected producer receives the declaration on its own socket.
  it("carries canonical trailDrive values onto the redirected socket", () => {
    const location = { href: "http://host:13337/", protocol: "http:" };
    expect(new URL(buildHeadlessMirrorWebSocketUrl(13347, location, true, true)).searchParams.get("trailDrive"))
      .toBe("1");
    expect(buildHeadlessMirrorWebSocketUrl(13347, location, false, false)).toBe("ws://host:13347/ws?watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0");
  });
});

describe("stream gate", () => {
  it("defaults to watching with explicit canonical selectors", async () => {
    const { client, socket } = connect();
    await Promise.resolve();
    expect(client.watching).toBe(true);
    expect(new URL(socket.url).searchParams.get("watch")).toBe("1");
    // Stage-B: with no staticBg option, the derived URL carries its explicit false selector.
    expect(new URL(socket.url).searchParams.get("staticBg")).toBe("0");
    // Every selector has a current, explicit false value when no option is supplied.
    expect(new URL(socket.url).searchParams.get("trailDrive")).toBe("0");
  });

  it("threads the staticBg option onto the derived connect URL", async () => {
    MockWebSocket.instances = [];
    connectMirrorClient({
      staticBg: true,
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      location: { href: "http://localhost/", protocol: "http:" }
    });
    const socket = MockWebSocket.instances[0];
    expect(new URL(socket.url).searchParams.get("staticBg")).toBe("1");
    expect(new URL(socket.url).searchParams.get("view")).toBeNull();
  });

  it("threads the trailDrive option onto the derived connect URL", async () => {
    MockWebSocket.instances = [];
    connectMirrorClient({
      trailDrive: true,
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      location: { href: "http://localhost/", protocol: "http:" }
    });
    const socket = MockWebSocket.instances[0];
    expect(new URL(socket.url).searchParams.get("trailDrive")).toBe("1");
    // …and it is independent of the staticBg declaration beside it.
    expect(new URL(socket.url).searchParams.get("staticBg")).toBe("0");
  });

  it("connects GATED when asked, and applies nothing that arrives while gated", async () => {
    const { client, socket } = connect(false);
    await Promise.resolve();

    expect(client.watching).toBe(false);
    expect(new URL(socket.url).searchParams.get("watch")).toBe("0");

    // An in-flight straggler from before the gate took effect must NOT be parsed/applied.
    const revisionBefore = client.state.revision;
    socket.emit(keyframe);
    expect(client.state.revision).toBe(revisionBefore); // no re-render scheduled
    expect(client.state.orderedIds).toHaveLength(0);
    expect(client.state.nodes.size).toBe(0);

    // ...and no ack is credited for a frame that was never rendered.
    client.sendSceneAck();
    expect(socket.sentOfType("scene-ack")).toHaveLength(0);
  });

  it("flips the gate both ways with exactly one control message per real change", async () => {
    const { client, socket } = connect(false);
    await Promise.resolve();

    client.sendWatch(true);
    client.sendWatch(true); // idempotent — no second frame
    expect(socket.sentOfType("watch")).toEqual([{ type: "watch", on: true }]);
    expect(client.watching).toBe(true);

    // Now deltas apply again, and the renderer's ack reaches the host.
    const revisionBefore = client.state.revision;
    socket.emit(keyframe);
    expect(client.state.revision).toBeGreaterThan(revisionBefore);
    expect(client.state.orderedIds).toEqual(["1"]);
    expect(client.state.nodes.size).toBe(1);
    client.sendSceneAck();
    expect(socket.sentOfType("scene-ack")).toHaveLength(1);

    client.sendWatch(false);
    expect(socket.sentOfType("watch")).toEqual([
      { type: "watch", on: true },
      { type: "watch", on: false }
    ]);
    expect(client.watching).toBe(false);
  });

  it("never sends a redundant `watch` that merely restates the connect query", async () => {
    const { client, socket } = connect(false);
    await Promise.resolve();

    client.sendWatch(false); // already the connect-query value
    expect(socket.sentOfType("watch")).toHaveLength(0);
    expect(client.watching).toBe(false);
  });

  // R11 WS-M — the mirror's one SEMANTIC-action send (a map-point tap → `select-map-node`). No viewer id (the
  // host reads the acting seat off the connection).
  it("sends a semantic action envelope with a per-connection request id", async () => {
    const { client, socket } = connect();
    await Promise.resolve();

    client.sendAction({ semanticActionId: "select-map-node", args: { elementId: "669410934510" } });
    client.sendAction({ semanticActionId: "select-map-node", args: { elementId: "42" } });
    expect(socket.sentOfType("action")).toEqual([
      { type: "action", requestId: "action:1", semanticActionId: "select-map-node", args: { elementId: "669410934510" } },
      { type: "action", requestId: "action:2", semanticActionId: "select-map-node", args: { elementId: "42" } }
    ]);
  });

  it("omits an empty args object and drops an action sent on a closed socket", async () => {
    const { client, socket } = connect();
    await Promise.resolve();

    client.sendAction({ semanticActionId: "back-from-map" });
    expect(socket.sentOfType("action")).toEqual([
      { type: "action", requestId: "action:1", semanticActionId: "back-from-map" }
    ]);

    socket.readyState = 3;
    client.sendAction({ semanticActionId: "select-map-node", args: { elementId: "42" } });
    expect(socket.sentOfType("action")).toHaveLength(1);
  });

  it("flushes a gate change made before the socket opened", async () => {
    MockWebSocket.instances = [];
    const client = connectMirrorClient({
      watch: false,
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      location: { href: "http://localhost/", protocol: "http:" }
    });
    const socket = MockWebSocket.instances[0];

    // The mock reports OPEN immediately but dispatches "open" on a microtask; force the pre-open path.
    socket.readyState = 0;
    client.sendWatch(true);
    expect(socket.sentOfType("watch")).toHaveLength(0);

    socket.readyState = MockWebSocket.OPEN;
    await Promise.resolve(); // the queued "open" now flushes the pending gate change
    expect(socket.sentOfType("watch")).toEqual([{ type: "watch", on: true }]);
  });
});

// SCENE-ACK FLOW CONTROL, client half. The host holds ONE send credit, spends it per coalesced delta and gets it
// back from this ack (CouchCoopWebSocketConnection.GrantSceneCredit → DrainSceneAsync). So the contract is
// one-ack-per-delta-the-host-sent: acking less would stall the stream until the host's 500ms self-heal, and acking
// more just re-grants a credit the host is not holding — which is what a per-RENDERED-FRAME ack did, because a
// render is also scheduled by texture sizes resolving, atlas bakes completing, and the spread/spine/occlusion/
// static-bg watchers (~0.32ms per send on a Moto G86, and the first two fire constantly in combat).
describe("scene-ack flow control", () => {
  // A non-keyframe delta, i.e. the thing the host actually spends its credit on.
  const update = {
    type: "scene-delta",
    full: false,
    screenType: "run",
    upserts: [{ id: "1", name: "Root", nodeType: "Control", visible: true }],
    removedIds: [],
    orderedIds: null
  };

  it("acks once per applied delta", async () => {
    const { client, socket } = connect();
    await Promise.resolve();

    socket.emit(keyframe);
    client.sendSceneAck();
    expect(socket.sentOfType("scene-ack")).toHaveLength(1);

    socket.emit(update);
    client.sendSceneAck();
    expect(socket.sentOfType("scene-ack")).toHaveLength(2);
  });

  it("sends nothing for a rendered frame that consumed no new delta", async () => {
    const { client, socket } = connect();
    await Promise.resolve();

    // A render before anything has arrived at all (the mount-time reconcile) owes the host nothing.
    client.sendSceneAck();
    expect(socket.sentOfType("scene-ack")).toHaveLength(0);

    socket.emit(keyframe);
    client.sendSceneAck();
    expect(socket.sentOfType("scene-ack")).toHaveLength(1);

    // The texture/atlas/settings renders: real frames, no new delta behind them, so no credit to hand back.
    client.sendSceneAck();
    client.sendSceneAck();
    expect(socket.sentOfType("scene-ack")).toHaveLength(1);

    // ...and the stream is NOT wedged by that: the next delta acks as usual.
    socket.emit(update);
    client.sendSceneAck();
    expect(socket.sentOfType("scene-ack")).toHaveLength(2);
  });

  it("acks ONCE for deltas coalesced into a single rendered frame", async () => {
    const { client, socket } = connect();
    await Promise.resolve();

    // The client coalesces renders, so a burst that lands between two frames is one ack — which is correct even
    // though the host spent a credit per delta, because it re-grants on any ack and only ever holds one.
    socket.emit(keyframe);
    socket.emit(update);
    socket.emit(update);
    client.sendSceneAck();
    expect(socket.sentOfType("scene-ack")).toHaveLength(1);
  });

  // The ledger is "deltas since the last ack", NOT "this render consumed a delta". That is what covers the case
  // the replay bench documents: the keyframe is applied and then consumed by MirrorView's mount-time reconcile,
  // which does not ack — so the ack has to be paid by whatever frame runs next, or the stream sits on the host's
  // self-heal timeout.
  it("still pays off a delta consumed by a render that happened before the ack call", async () => {
    const { client, socket } = connect();
    await Promise.resolve();

    socket.emit(keyframe);
    // ...an unrelated frame renders here (no delta of its own) and acks: the outstanding delta is what it pays.
    client.sendSceneAck();
    expect(socket.sentOfType("scene-ack")).toHaveLength(1);
  });

  it("drops the ack on a closed socket without losing the debt", async () => {
    const { client, socket } = connect();
    await Promise.resolve();

    socket.emit(keyframe);
    socket.readyState = 3;
    client.sendSceneAck();
    expect(socket.sentOfType("scene-ack")).toHaveLength(0);

    // The readyState gate runs BEFORE the ledger is cleared, so a frame rendered on a socket that is briefly not
    // OPEN does not silently swallow the credit the host is waiting on.
    socket.readyState = MockWebSocket.OPEN;
    client.sendSceneAck();
    expect(socket.sentOfType("scene-ack")).toHaveLength(1);
  });
});
