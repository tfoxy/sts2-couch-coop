import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildHeadlessMirrorWebSocketUrl, connectMirrorClient } from "@/mirror/mirrorClient";
import { resetVisitIdCache, VISIT_META_NAME } from "@/join/visitId";

// PROMOTION, NOT GHOSTS. The host records the `GET /` that served this page under a visit id it embedded in
// the document; sending that id back on `join` is what merges those arrivals into this connection's row
// instead of leaving a second, ownerless one. The seat gets the same id on its socket URL, so it can answer
// "did this device ever reach me?" for itself.

class MockWebSocket extends EventTarget {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.OPEN;
  sent: Record<string, unknown>[] = [];
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

const VISIT = "0123456789abcdef0123456789abcdef";
const location = { href: "http://host:13337/", protocol: "http:" };

function embedVisit(content: string): void {
  const meta = document.createElement("meta");
  meta.setAttribute("name", VISIT_META_NAME);
  meta.setAttribute("content", content);
  document.head.appendChild(meta);
  resetVisitIdCache();
}

function connect() {
  MockWebSocket.instances = [];
  const client = connectMirrorClient({
    WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
    location
  });
  return { client, socket: MockWebSocket.instances[0] };
}

beforeEach(() => {
  document.querySelector(`meta[name="${VISIT_META_NAME}"]`)?.remove();
  resetVisitIdCache();
});

afterEach(() => {
  document.querySelector(`meta[name="${VISIT_META_NAME}"]`)?.remove();
  resetVisitIdCache();
});

describe("visit id on the wire", () => {
  it("sends the page's visit id on join, beside the request id", () => {
    embedVisit(VISIT);
    const { client, socket } = connect();
    client.sendJoin("Player One", "p:1003");
    expect(socket.sent).toEqual([
      { type: "join", requestId: "join:1", name: "Player One", playerId: "p:1003", visit: VISIT }
    ]);
    client.close();
  });

  it("omits it entirely when the page has none, leaving the join byte-identical to before", () => {
    const { client, socket } = connect();
    client.sendJoin("Player One");
    expect(socket.sent).toEqual([{ type: "join", requestId: "join:1", name: "Player One" }]);
    expect(Object.keys(socket.sent[0])).not.toContain("visit");
    client.close();
  });

  it("never sends a value outside the minted shape", () => {
    embedVisit("not-a-visit-id");
    const { client, socket } = connect();
    client.sendJoin("Player One");
    expect(socket.sent[0]).not.toHaveProperty("visit");
    client.close();
  });

  it("carries the visit id to the seat on its socket URL", () => {
    embedVisit(VISIT);
    const url = new URL(buildHeadlessMirrorWebSocketUrl(13347, location, false, false));
    expect(url.searchParams.get("visit")).toBe(VISIT);
    // …and the rest of the connect contract is untouched.
    expect(url.searchParams.get("watch")).toBe("1");
    expect(url.searchParams.get("staticBg")).toBe("0");
  });

  it("leaves the seat URL unchanged when there is no visit id to carry", () => {
    expect(buildHeadlessMirrorWebSocketUrl(13347, location, false, false))
      .toBe("ws://host:13347/ws?watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0");
    expect(buildHeadlessMirrorWebSocketUrl(13347, location, false, false, null))
      .toBe("ws://host:13347/ws?watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0");
  });
});
