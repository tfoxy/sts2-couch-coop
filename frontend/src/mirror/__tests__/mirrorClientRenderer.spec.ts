import { describe, expect, it } from "vitest";

import { connectMirrorClient } from "@/mirror/mirrorClient";

class MockWebSocket extends EventTarget {
  static OPEN = 1;
  static latest: MockWebSocket;
  readyState = MockWebSocket.OPEN;
  sent: Record<string, unknown>[] = [];

  constructor(_url: string) {
    super();
    MockWebSocket.latest = this;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

function connect() {
  const client = connectMirrorClient({
    WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
    location: { href: "http://host:13337/", protocol: "http:" }
  });
  return { client, socket: MockWebSocket.latest };
}

describe("mirrorClient — renderer requests", () => {
  it("sends stream and mirror requests separately from the join", () => {
    const { client, socket } = connect();
    client.sendJoin(" Alice ", "p:1003");
    client.sendRenderer("stream", 2340 / 1080);
    client.sendRenderer("mirror", 2340 / 1080);
    expect(socket.sent).toEqual([
      { type: "join", requestId: "join:1", name: "Alice", playerId: "p:1003" },
      { type: "renderer", renderer: "stream", aspect: 2340 / 1080 },
      { type: "renderer", renderer: "mirror" }
    ]);
    client.close();
  });

  it.each([undefined, NaN, Infinity, -Infinity, 0, -1])("omits an unusable aspect (%s)", (aspect) => {
    const { client, socket } = connect();
    client.sendRenderer("stream", aspect);
    expect(socket.sent).toEqual([{ type: "renderer", renderer: "stream" }]);
    client.close();
  });

  it("drops requests while the socket is not open", () => {
    const { client, socket } = connect();
    socket.readyState = 0;
    client.sendRenderer("stream");
    client.close();
    client.sendRenderer("mirror");
    expect(socket.sent).toEqual([]);
  });
});
