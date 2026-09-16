import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import MirrorApp from "@/mirror/MirrorApp.vue";
import { connectMirrorClient } from "@/mirror/mirrorClient";
import { __resetComposerForTest, createBrowserI18n } from "@/i18n";
import type { BrowserSeatNotice } from "@/protocol/browserEnvelope";

// The host's readiness verdict, on the phone.
//
// THE FAILURE THIS EXISTS FOR. With the path from a device to its seat port blocked (a device-scoped firewall
// rule, guest/AP isolation, a router that separates clients), the host's own LOOPBACK probe of that seat
// succeeds — so the join is answered as a SUCCESS, the app is redirected to a port it cannot open, and the screen
// reads "Loading…" for ever. The host names that cause precisely, four times a second, and before this told only
// itself: its panel, its log and its copyable report.
//
// Two halves are easy to get wrong, and both are gated here:
//   1. the notice arrives on the HOST socket — the one a redirected viewer keeps open (gated off, but open,
//      because closing it would Release() and kill the seat) — while the app's ACTIVE client is the seat socket
//      that, in this very case, never connects. A handler guarded on `activeClient` would be deaf here;
//   2. it is withdrawn when the cause clears, so an accusation about somebody's router cannot outlive it.

const NETWORK_DETAIL =
  "This player's game is running and answering on the host, but the device never reached it. The path from the "
  + "phone to port 13357 is blocked (firewall, guest/AP isolation, or the wrong address). Observed: assigned port "
  + "13357; requests to this player's game from outside this computer: 0.";

function noticeFrame(over: Record<string, unknown> = {}) {
  return { type: "seat-notice", cause: "network-path", detail: NETWORK_DETAIL, ...over };
}

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
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  emit(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}

describe("mirrorClient seat-notice routing", () => {
  afterEach(() => {
    MockWebSocket.instances = [];
  });

  function connectWithGateClosed() {
    MockWebSocket.instances = [];
    const seen: BrowserSeatNotice[] = [];
    const client = connectMirrorClient({
      // The state every viewer this speaks for is in: the scene stream on the host socket is OFF, either because
      // they are on the join picker or because their redirect turned it off. A handler placed below the gate
      // would be silent for exactly them.
      watch: false,
      onSeatNotice: (notice) => seen.push(notice),
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      location: { href: "http://localhost/", protocol: "http:" }
    });
    return { client, socket: MockWebSocket.instances[0], seen };
  }

  it("delivers a notice while the scene stream is turned OFF", () => {
    const { client, socket, seen } = connectWithGateClosed();
    expect(client.watching).toBe(false);
    expect(socket.url).toContain("watch=0");

    socket.emit(noticeFrame());

    expect(seen).toEqual([{ cause: "network-path", detail: NETWORK_DETAIL }]);
  });

  it("delivers a notice with NO join in flight", () => {
    // The difference from `join-progress`, and the whole point: this describes a seat, not a request. By the time
    // the host has anything to say the join has usually already been answered — successfully — and a filter on
    // the join in flight would drop precisely the messages that matter.
    const { socket, seen } = connectWithGateClosed();
    socket.emit(noticeFrame({ cause: "port-conflict" }));
    expect(seen).toHaveLength(1);
    expect(seen[0].cause).toBe("port-conflict");
  });

  it("drops a malformed notice without disturbing the client", () => {
    const { socket, seen } = connectWithGateClosed();
    socket.emit(noticeFrame({ cause: "who-knows" }));
    expect(seen).toEqual([]);

    // …and the next well-formed frame still lands: one junk frame does not poison the channel.
    socket.emit(noticeFrame());
    expect(seen).toHaveLength(1);
  });

});
// (A superseded connection is filtered by the APP, not here: this client has no notion of which socket is the
// host's. See "ignores a notice that did not come from the host socket" below.)

describe("MirrorApp seat notice", () => {
  let realWebSocket: unknown;
  let app: ReturnType<typeof mount> | null = null;

  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();
  };

  function sessionMessage(over: Record<string, unknown> = {}) {
    return {
      type: "session",
      session: { name: null, status: "unassigned", joined: false, playerId: null, connectionCount: 0 },
      players: [
        { playerId: "p:1", name: "Hosty", isHost: true, isRunPlayer: true, connectionCount: 1, disconnected: false, isLocal: false, netId: null, isMirrorSeat: false, seatStatus: "ready", seatStatusReason: null, characterId: null },
        { playerId: "p:1003", name: "Alice", isHost: false, isRunPlayer: true, connectionCount: 0, disconnected: false, isLocal: false, netId: 1003, isMirrorSeat: true, seatStatus: "ready", seatStatusReason: null, characterId: null }
      ],
      screen: { kind: "run", type: "Run", title: "Run", mirrorMode: "mp-run" },
      hostName: "host",
      scrollAction: true,
      ...over
    };
  }

  const hostSocket = () => MockWebSocket.instances[0];
  const latest = () => MockWebSocket.instances[MockWebSocket.instances.length - 1];
  const heading = () => app!.find("h1").text();
  const notice = () => app!.find('[data-testid="mirror-seat-notice"]');
  const summary = () => app!.find('[data-testid="mirror-seat-notice-summary"]').text();
  const action = () => app!.find('[data-testid="mirror-seat-notice-action"]').text();

  async function tapASeat(expectedHeading = "Joining…") {
    app = mount(MirrorApp);
    await settle();
    hostSocket().emit(sessionMessage());
    await settle();
    await app.findAll('[data-testid="player-picker"] button')[1].trigger("click");
    await settle();
    expect(heading()).toBe(expectedHeading);
  }

  // The real shape of the defect: the host answered the join with a port, the app redirected to the seat's own
  // socket, and that socket never connects. `joined` is set, the heading is "Loading…", and the host socket is
  // still open with its stream gated off — which is the only channel the host has left.
  async function redirectToAnUnreachableSeat() {
    await tapASeat();
    hostSocket().emit(sessionMessage({ headlessMirrorPort: 14000 }));
    await settle();
    expect(heading()).toBe("Loading…");
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(latest()).not.toBe(hostSocket());
  }

  beforeEach(() => {
    __resetComposerForTest();
    window.history.replaceState(null, "", "/");
    globalThis.sessionStorage?.clear();
    MockWebSocket.instances = [];
    realWebSocket = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    vi.useRealTimers();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket;
    __resetComposerForTest();
  });

  it("shows nothing while the host has named no cause", async () => {
    await tapASeat();
    expect(notice().exists()).toBe(false);
  });

  it("names the blocked path without accusing the game that is answering", async () => {
    await redirectToAnUnreachableSeat();
    hostSocket().emit(noticeFrame());
    await settle();

    expect(summary()).toBe("Your game is running on the host computer, but this device couldn't reach it.");
    expect(action()).toBe(
      "Join the same Wi-Fi as the host — not a guest network — turn off any VPN, and check the router isn't "
      + "keeping devices apart."
    );
    // The mistake this round exists to stop being repeated: the seat IS up and IS answering the host, so the
    // copy must not suggest the game failed to start or stopped responding.
    expect(summary()).toContain("is running");
    expect(`${summary()} ${action()}`).not.toMatch(/not responding|failed|couldn't start/i);
  });

  it("puts the host's own English under the localized copy", async () => {
    await redirectToAnUnreachableSeat();
    hostSocket().emit(noticeFrame());
    await settle();

    // Verbatim, and it is the same sentence the host's own panel shows in grey and its report quotes — which is
    // what stops a player and whoever is hosting for them from reading two different diagnoses.
    expect(app!.find('[data-testid="mirror-seat-notice-detail"]').text()).toBe(NETWORK_DETAIL);
  });

  it("sends nobody to their own settings for a fault on the host computer", async () => {
    await redirectToAnUnreachableSeat();

    hostSocket().emit(noticeFrame({ cause: "port-conflict", detail: "Another program is using port 13357." }));
    await settle();
    expect(summary()).toBe("Another program on the host computer is using the port your game needs.");
    expect(action()).toBe(
      "Nothing to change on this device — ask whoever is hosting to restart Slay the Spire 2, then try again."
    );

    hostSocket().emit(noticeFrame({ cause: "host-local-block", detail: "The host cannot reach port 13357." }));
    await settle();
    expect(summary()).toBe("The host computer is blocking the port your game is served on.");
    expect(action()).toBe(
      "Nothing to change on this device — ask whoever is hosting to allow Slay the Spire 2 through their "
      + "firewall or security software."
    );
  });

  it("reaches a viewer whose redirect already happened, on the socket the seat's own never replaced", async () => {
    await redirectToAnUnreachableSeat();
    // Nobody is joining any more (`pendingName` is cleared by the redirect) and this connection never asked for
    // the scene stream, so both of the gates the join-progress line sits behind are shut.
    expect(app!.find('[data-testid="mirror-join-progress"]').exists()).toBe(false);
    expect(hostSocket().sent.some((m: any) => m.type === "watch" && m.on === true)).toBe(false);

    hostSocket().emit(noticeFrame());
    await settle();
    expect(notice().exists()).toBe(true);
    // The heading is untouched: the transient word is the same one every other lifecycle state uses.
    expect(heading()).toBe("Loading…");
  });

  it("ignores a notice that did not come from the host socket", async () => {
    await redirectToAnUnreachableSeat();
    // Only the host runs a seat monitor, so in production this frame does not exist — but a seat socket is a
    // socket the viewer's own device opened to a game, and a message about somebody's seat must be attributable.
    latest().emit(noticeFrame());
    await settle();
    expect(notice().exists()).toBe(false);
  });

  it("withdraws the verdict when the host says the cause has cleared", async () => {
    await redirectToAnUnreachableSeat();
    hostSocket().emit(noticeFrame());
    await settle();
    expect(notice().exists()).toBe(true);

    // The device finally got through, or the rule was removed. A message that stays up once it has stopped being
    // true is worse than no message — it is the accusation this round exists to stop making wrongly.
    hostSocket().emit({ type: "seat-notice", cause: "none" });
    await settle();
    expect(notice().exists()).toBe(false);
  });

  it("clears the verdict when the viewer starts a fresh attempt", async () => {
    await tapASeat();
    hostSocket().emit(noticeFrame());
    await settle();
    expect(notice().exists()).toBe(true);

    hostSocket().emit(sessionMessage({ joinRejection: "no-free-instance" }));
    await settle();
    expect(notice().exists()).toBe(false);

    await app!.findAll('[data-testid="player-picker"] button')[1].trigger("click");
    await settle();
    expect(heading()).toBe("Joining…");
    expect(notice().exists()).toBe(false);
  });

  it("says nothing at all for a cause this build has no copy for", async () => {
    await redirectToAnUnreachableSeat();
    hostSocket().emit(noticeFrame({ cause: "still-starting" }));
    await settle();
    expect(notice().exists()).toBe(false);
  });

  it("localizes the verdict", async () => {
    createBrowserI18n("?lang=zh-Hans", { languages: ["en"] });
    await tapASeat("正在加入…");
    hostSocket().emit(noticeFrame());
    await settle();
    expect(summary()).toBe("你的游戏已在主机电脑上运行，但本设备无法连接到它。");
    expect(action()).toBe("请连接与主机相同的 Wi-Fi（不要用访客网络），关闭所有 VPN，并检查路由器是否隔离了设备之间的通信。");
  });
});
