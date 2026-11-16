import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAudioSeatWebSocketUrl, buildHeadlessMirrorWebSocketUrl, buildSeatMirrorWebSocketUrl, connectMirrorClient } from "@/mirror/mirrorClient";
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
      { type: "join", rendererProtocol: 2, requestId: "join:1", name: "Player One", playerId: "p:1003", visit: VISIT }
    ]);
    client.close();
  });

  it("omits the visit entirely when the page has none", () => {
    const { client, socket } = connect();
    client.sendJoin("Player One");
    expect(socket.sent).toEqual([{ type: "join", rendererProtocol: 2, requestId: "join:1", name: "Player One" }]);
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

  it("keeps a shared seat route on the host port with its token and canonical selectors", () => {
    embedVisit(VISIT);
    const url = new URL(buildSeatMirrorWebSocketUrl("/ws?seat=opaque-token", location, true, true));
    expect(url.origin).toBe("ws://host:13337");
    expect([...url.searchParams.entries()]).toEqual([
      ["seat", "opaque-token"], ["watch", "1"], ["staticBg", "1"],
      ["cardFlight", "1"], ["handTween", "1"], ["trailDrive", "1"], ["visit", VISIT], ["rendererPage", expect.stringMatching(/^[0-9a-f]{32}$/)]
    ]);
  });

  it("uses the host's HTTPS origin for a shared route on a remotely hosted page", () => {
    const previous = globalThis.__couchCoopHostBase;
    globalThis.__couchCoopHostBase = "https://lan-host:13337";
    try {
      const url = new URL(buildSeatMirrorWebSocketUrl(
        "/ws?seat=opaque-token",
        { href: "https://public.example/join", protocol: "https:" },
        false,
        false,
        null
      ));
      expect(url.origin).toBe("wss://lan-host:13337");
      expect(url.searchParams.get("seat")).toBe("opaque-token");
    } finally {
      globalThis.__couchCoopHostBase = previous;
    }
  });

  it("omits only the diagnostic visit when none is supplied", () => {
    const implicit = new URL(buildHeadlessMirrorWebSocketUrl(13347, location, false, false));
    const explicit = new URL(buildHeadlessMirrorWebSocketUrl(13347, location, false, false, null));
    expect(implicit.toString()).toBe(explicit.toString());
    expect(implicit.searchParams.has("visit")).toBe(false);
    expect(implicit.searchParams.get("rendererPage")).toMatch(/^[0-9a-f]{32}$/);
    implicit.searchParams.delete("rendererPage");
    expect(implicit.toString()).toBe("ws://host:13347/ws?watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0");
  });
});

describe("renderer page identity on seat control sockets", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("mints an independent id on HTTP LAN without randomUUID and retains it for replacement clients", () => {
    vi.stubGlobal("document", document.implementation.createHTMLDocument());
    embedVisit(VISIT);
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const firstUrl = buildSeatMirrorWebSocketUrl("/ws?seat=route", location);
    const pageId = new URL(firstUrl).searchParams.get("rendererPage");
    expect(pageId).toMatch(/^[0-9a-f]{32}$/);
    expect(pageId).not.toBe(VISIT);
    expect(new URL(buildSeatMirrorWebSocketUrl(13347, location)).searchParams.get("rendererPage")).toBe(pageId);
    const first = connectMirrorClient({ url: firstUrl, WebSocketCtor: MockWebSocket as unknown as typeof WebSocket });
    first.close();
    const replacement = connectMirrorClient({ url: buildSeatMirrorWebSocketUrl("/ws?seat=new-route", location),
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket });
    expect(new URL(MockWebSocket.instances.at(-1)!.url).searchParams.get("rendererPage")).toBe(pageId);
    replacement.close();
  });

  it("keeps separate documents independent even when they share diagnostic ids and storage", () => {
    const currentDocument = document;
    const original = new URL(buildSeatMirrorWebSocketUrl(13347, location)).searchParams.get("rendererPage");
    const otherDocument = document.implementation.createHTMLDocument();
    const copiedVisit = document.createElement("meta");
    copiedVisit.name = VISIT_META_NAME;
    copiedVisit.content = VISIT;
    otherDocument.head.appendChild(copiedVisit);
    vi.stubGlobal("document", otherDocument);
    const other = new URL(buildSeatMirrorWebSocketUrl(13347, location)).searchParams.get("rendererPage");
    expect(other).toMatch(/^[0-9a-f]{32}$/);
    expect(other).not.toBe(original);
    expect(new URL(buildSeatMirrorWebSocketUrl(13347, location)).searchParams.get("rendererPage")).toBe(other);
    vi.stubGlobal("document", currentDocument);
    expect(new URL(buildSeatMirrorWebSocketUrl(13347, location)).searchParams.get("rendererPage")).toBe(original);
  });

  it("does not claim a renderer page on the host coordination socket or audio lane", () => {
    const { client, socket } = connect();
    expect(new URL(socket.url).searchParams.has("rendererPage")).toBe(false);
    expect(new URL(buildAudioSeatWebSocketUrl("/ws?seat=route", location)).searchParams.has("rendererPage")).toBe(false);
    client.close();
  });
});
