import { describe, expect, it } from "vitest";

import {
  connectMirrorClient,
  readScrollAck,
  SCROLL_ELEMENT_ID_ARG,
  SCROLL_OFFSET_ARG,
  SET_SCROLL_OFFSET_ACTION_ID,
  type MirrorScrollAck
} from "@/mirror/mirrorClient";
import { parseBrowserEnvelope } from "@/protocol/browserEnvelope";

// The client protocol half of absolute scroll: the action it sends and the ack it reads back. The eager engine's own behaviour lives in eagerScroll.spec.ts; what is
// checked here is the wire between them, including the one thing this channel must not break — the join backstop,
// which is the only other reader of `action-result` and the reason a failed join is visible at all.

class MockWebSocket extends EventTarget {
  static instances: MockWebSocket[] = [];
  url: string;
  sent: string[] = [];

  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.dispatchEvent(new Event("close"));
  }

  emit(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}

// The host's own reply shape: the envelope echoes the semanticActionId, and the spirectl result rides nested under
// `result.result` with the handler's answer in `values` — a C# Dictionary<string,string>, so every number is a
// STRING on the wire.
function hostAck(requestId: string, offsetY: string, requestedY: string, surface = "grid"): Record<string, unknown> {
  return {
    type: "action-result",
    requestId,
    semanticActionId: SET_SCROLL_OFFSET_ACTION_ID,
    result: {
      success: true,
      result: {
        accepted: true,
        actionInstanceId: `action:set-scroll-offset:${requestId}`,
        message: "Set grid scroll offset to -1800.",
        provisional: false,
        values: { offsetY, requestedY, surface }
      }
    }
  };
}

describe("session envelope — the absolute-scroll contract", () => {
  function session(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      type: "session",
      requestId: "s",
      session: { name: null, status: "unassigned", joined: false, playerId: null, connectionCount: 0 },
      players: [],
      screen: { kind: "unsupported", type: null, title: null, mirrorMode: "unsupported" },
      hostName: "host",
      scrollAction: true,
      rewardAction: true,
      ...extra
    };
  }

  it("accepts explicit true semantic actions", () => {
    const parsed = parseBrowserEnvelope(JSON.stringify(session({ scrollAction: true })));
    expect(parsed.type === "session" && parsed.scrollAction).toBe(true);
  });

  it("requires explicit true semantic actions", () => {
    const absent = session({});
    delete absent.scrollAction;
    expect(() => parseBrowserEnvelope(JSON.stringify(absent))).toThrow("scrollAction");
    expect(() => parseBrowserEnvelope(JSON.stringify(session({ scrollAction: false })))).toThrow("scrollAction");
    expect(() => parseBrowserEnvelope(JSON.stringify(session({ scrollAction: "yes" })))).toThrow("scrollAction");
  });
});

describe("readScrollAck", () => {
  it("pulls the CLAMPED offset out of the host's result, parsing the string values", () => {
    expect(readScrollAck(hostAck("action:7", "-1800", "-2400"))).toEqual<MirrorScrollAck>({
      requestId: "action:7",
      offsetY: -1800,
      requestedY: -2400,
      surface: "grid"
    });
  });

  it("refuses anything that is not an answer about a position", () => {
    // A different action, a refusal, and a result whose values say nothing numeric. Coercing any of these would
    // hand the settle a target of zero and glide the surface to the top of the content.
    expect(readScrollAck({ ...hostAck("action:7", "-1800", "-2400"), semanticActionId: "select-map-node" })).toBeNull();
    expect(readScrollAck({ ...hostAck("action:7", "-1800", "-2400"), code: "disabled-action" })).toBeNull();
    expect(readScrollAck(hostAck("action:7", "", "-2400"))).toBeNull();
    expect(readScrollAck({ type: "action-result", semanticActionId: SET_SCROLL_OFFSET_ACTION_ID })).toBeNull();
    // An ack that cannot be matched to its send is worse than none at all.
    expect(readScrollAck({ ...hostAck("action:7", "-1800", "-2400"), requestId: "" })).toBeNull();
    expect(readScrollAck(null)).toBeNull();
  });

  it("reports a missing `requestedY` as null rather than inventing one", () => {
    const ack = readScrollAck(hostAck("action:7", "-1800", "nonsense"));
    expect(ack).toMatchObject({ offsetY: -1800, requestedY: null });
  });
});

describe("mirrorClient — the absolute-scroll channel", () => {
  function connect(onScrollAck?: (ack: MirrorScrollAck) => void, onActionError?: (m: string) => void) {
    MockWebSocket.instances = [];
    const client = connectMirrorClient({
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      location: { href: "http://localhost/", protocol: "http:" },
      onScrollAck,
      onActionError
    });
    return { client, socket: MockWebSocket.instances[0] };
  }

  it("sends the action and RETURNS the requestId it went out under", async () => {
    const { client, socket } = connect();
    await Promise.resolve();
    const requestId = client.sendAction({
      semanticActionId: SET_SCROLL_OFFSET_ACTION_ID,
      args: { [SCROLL_ELEMENT_ID_ARG]: "43704649279", [SCROLL_OFFSET_ARG]: -1800 }
    });
    expect(requestId).toBe("action:1");
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "action",
      requestId: "action:1",
      semanticActionId: "set-scroll-offset",
      args: { elementId: "43704649279", offsetY: -1800 }
    });
    // The id is what makes an ack matchable, so consecutive sends must never repeat one.
    expect(client.sendAction({ semanticActionId: SET_SCROLL_OFFSET_ACTION_ID })).toBe("action:2");
    client.close();
  });

  it("hands a successful result to onScrollAck", async () => {
    const acks: MirrorScrollAck[] = [];
    const { client, socket } = connect((ack) => acks.push(ack));
    await Promise.resolve();
    socket.emit(hostAck("action:1", "-1800", "-2400"));
    expect(acks).toEqual([{ requestId: "action:1", offsetY: -1800, requestedY: -2400, surface: "grid" }]);
    client.close();
  });

  it("does NOT regress the join backstop: a fault during a join is still that join failing", async () => {
    // The backstop keeps FIRST refusal on every error-carrying `action-result`. If the scroll reader had been put
    // above it — or had matched error results too — a server-side throw during a join would be swallowed here and
    // the picker would spin on "Joining…" forever, which is the exact bug the backstop exists for.
    const acks: MirrorScrollAck[] = [];
    const errors: string[] = [];
    const { client, socket } = connect(
      (ack) => acks.push(ack),
      (m) => errors.push(m)
    );
    await Promise.resolve();

    client.sendJoin("Alice");
    socket.emit({
      type: "action-result",
      requestId: "join:1",
      semanticActionId: SET_SCROLL_OFFSET_ACTION_ID,
      code: "invalid-action-message",
      message: "boom"
    });
    expect(errors).toEqual(["boom"]);
    expect(acks).toEqual([]);
    client.close();
  });

  it("leaves an unrelated action-result alone, join in flight or not", async () => {
    const acks: MirrorScrollAck[] = [];
    const errors: string[] = [];
    const { client, socket } = connect(
      (ack) => acks.push(ack),
      (m) => errors.push(m)
    );
    await Promise.resolve();
    // A refused map-node vote is an ordinary result this client sends on purpose.
    socket.emit({ type: "action-result", requestId: "action:3", semanticActionId: "select-map-node", code: "disabled-action" });
    expect(acks).toEqual([]);
    expect(errors).toEqual([]);
    client.close();
  });
});
