import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import MirrorApp from "@/mirror/MirrorApp.vue";
import { connectMirrorClient } from "@/mirror/mirrorClient";
import { __resetComposerForTest, createBrowserI18n } from "@/i18n";
import type { BrowserJoinProgress } from "@/protocol/browserEnvelope";

// A slow join must stop looking like a dead one.
//
// Measured live 2026-09-15: for the whole 75s seat-spawn deadline the phone showed a bare "Joining…" spinner —
// and a SUCCESSFUL join showed the identical screen for its first 10-15s. A legitimate cold spawn takes 20-60s,
// so patience is sometimes the right answer and the player had no way to tell which case they were in. Most
// closed the tab, which is why the field report is "it hangs".
//
// The two halves gated here are the ones that were easy to get wrong:
//   1. the handler sits ABOVE the client's `watching` gate — a viewer on the join picker has the scene stream
//      turned OFF, which is precisely when this must fire;
//   2. progress is matched to the join IN FLIGHT, so a straggler about an abandoned attempt cannot re-animate a
//      screen that has moved on.

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

function progressFrame(over: Record<string, unknown> = {}) {
  return {
    type: "join-progress",
    requestId: "join:1",
    stage: "initializing",
    step: 3,
    stepTotal: 6,
    elapsedMs: 23_000,
    ...over
  };
}

describe("mirrorClient join-progress routing", () => {
  afterEach(() => {
    MockWebSocket.instances = [];
  });

  function connectWithGateClosed() {
    MockWebSocket.instances = [];
    const seen: BrowserJoinProgress[] = [];
    const client = connectMirrorClient({
      // The join-picker state: the scene stream is OFF, which is exactly the case a handler placed below the
      // gate would silently drop.
      watch: false,
      onJoinProgress: (progress) => seen.push(progress),
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      location: { href: "http://localhost/", protocol: "http:" }
    });
    return { client, socket: MockWebSocket.instances[0], seen };
  }

  it("delivers progress while the scene stream is turned OFF", () => {
    const { client, socket, seen } = connectWithGateClosed();
    expect(client.watching).toBe(false);
    expect(socket.url).toContain("watch=0");

    client.sendJoin("Alice", "p:1003");
    socket.emit(progressFrame());

    expect(seen).toEqual([{ requestId: "join:1", stage: "initializing", step: 3, stepTotal: 6, elapsedMs: 23_000 }]);
  });

  it("ignores progress for a request that is not the join in flight", () => {
    const { client, socket, seen } = connectWithGateClosed();
    client.sendJoin("Alice", "p:1003");

    // A straggler about a previous attempt (a retry after the join timeout, a seat the viewer walked away from).
    socket.emit(progressFrame({ requestId: "join:0" }));
    expect(seen).toEqual([]);

    // …and the live one still lands, so the filter is discriminating rather than simply deaf.
    socket.emit(progressFrame());
    expect(seen).toHaveLength(1);
  });

  it("ignores progress once the join has resolved, and after the socket closes", () => {
    const { client, socket, seen } = connectWithGateClosed();
    client.sendJoin("Alice", "p:1003");
    socket.emit({
      type: "session",
      session: { name: "Alice", status: "joined", joined: true, playerId: "p:1003", connectionCount: 1 },
      players: [],
      screen: { kind: "run", type: "Run", title: "Run", mirrorMode: "mp-run" },
      hostName: "host",
      scrollAction: true,
      headlessMirrorPort: 13401
    });

    socket.emit(progressFrame({ elapsedMs: 40_000 }));
    expect(seen).toEqual([]);

    socket.close();
    socket.emit(progressFrame());
    expect(seen).toEqual([]);
  });

  it("drops a malformed progress frame without disturbing the client", () => {
    const { client, socket, seen } = connectWithGateClosed();
    client.sendJoin("Alice", "p:1003");
    socket.emit(progressFrame({ stage: "who-knows" }));
    socket.emit(progressFrame({ elapsedMs: "23000" }));
    expect(seen).toEqual([]);

    // …and the next well-formed frame still lands: one junk frame does not poison the channel.
    socket.emit(progressFrame());
    expect(seen).toHaveLength(1);
  });
});

describe("MirrorApp join-progress line", () => {
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

  const latest = () => MockWebSocket.instances[MockWebSocket.instances.length - 1];
  const heading = () => app!.find("h1").text();
  const line = () => app!.find('[data-testid="mirror-join-progress"]');

  async function tapASeat(expectedHeading = "Joining…") {
    app = mount(MirrorApp);
    await settle();
    latest().emit(sessionMessage());
    await settle();
    await app.findAll('[data-testid="player-picker"] button')[1].trigger("click");
    await settle();
    expect(heading()).toBe(expectedHeading);
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

  it("shows nothing but the heading until the host says something", async () => {
    await tapASeat();
    expect(line().exists()).toBe(false);
  });

  it("renders what the host is doing, how far along, and that it can take a minute", async () => {
    await tapASeat();
    // The viewer is on the picker, so this connection never asked for the scene stream — the case a handler
    // below the `watching` gate would have dropped.
    expect(latest().sent.some((m: any) => m.type === "watch" && m.on === true)).toBe(false);

    latest().emit(progressFrame());
    await settle();

    expect(line().text()).toBe(
      "Starting this player's game — step 3 of 6, 23s so far. This can take up to a minute, so keep this page open."
    );
    // The heading is untouched: the transient word is the same one every other lifecycle state uses.
    expect(heading()).toBe("Joining…");
    expect(app!.find('[data-testid="mirror-spinner"]').exists()).toBe(true);
  });

  it("follows the host through its stages and elapsed time", async () => {
    await tapASeat();
    latest().emit(progressFrame({ stage: "joining", step: 4, elapsedMs: 41_800 }));
    await settle();
    expect(line().text()).toBe(
      "Connecting this player to the game — step 4 of 6, 41s so far. This can take up to a minute, so keep this page open."
    );
  });

  it("says nothing for a failed stage — the rejection about to land owns the screen", async () => {
    await tapASeat();
    latest().emit(progressFrame({ stage: "failed", step: 0 }));
    await settle();
    expect(line().exists()).toBe(false);
  });

  it("clears the line when the join resolves into a seat", async () => {
    await tapASeat();
    latest().emit(progressFrame());
    await settle();
    expect(line().exists()).toBe(true);

    latest().emit(sessionMessage({ headlessMirrorPort: 14000 }));
    await settle();

    expect(heading()).toBe("Loading…");
    expect(line().exists()).toBe(false);
  });

  it("clears the line when the join is rejected", async () => {
    await tapASeat();
    latest().emit(progressFrame());
    await settle();

    latest().emit(sessionMessage({ joinRejection: "no-free-instance" }));
    await settle();

    expect(line().exists()).toBe(false);
    expect(app!.find('[data-testid="mirror-join-message"]').text()).toBe("No free game slot is available right now.");
  });

  it("clears the line when the host answers nothing at all", async () => {
    await tapASeat();
    latest().emit(progressFrame());
    await settle();

    vi.advanceTimersByTime(90_001);
    await settle();

    expect(line().exists()).toBe(false);
    expect(app!.find('[data-testid="mirror-join-message"]').text()).toBe("The host didn't answer — please try again.");
  });

  it("starts a retry at zero instead of inheriting the last attempt's elapsed time", async () => {
    await tapASeat();
    latest().emit(progressFrame({ elapsedMs: 55_000 }));
    await settle();
    latest().emit(sessionMessage({ joinRejection: "no-free-instance" }));
    await settle();

    await app!.findAll('[data-testid="player-picker"] button')[1].trigger("click");
    await settle();

    expect(heading()).toBe("Joining…");
    expect(line().exists()).toBe(false);
  });

  it("localizes the line", async () => {
    createBrowserI18n("?lang=zh-Hans", { languages: ["en"] });
    await tapASeat("正在加入…");
    latest().emit(progressFrame());
    await settle();
    expect(line().text()).toBe("正在启动该玩家的游戏 — 第 3 / 6 步，已用时 23 秒。这可能需要长达一分钟，请保持此页面打开。");
  });
});
