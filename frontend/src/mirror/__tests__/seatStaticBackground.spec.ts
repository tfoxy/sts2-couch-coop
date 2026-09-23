import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";

import MirrorApp from "@/mirror/MirrorApp.vue";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { __setStillDecoderForTest } from "@/mirror/stillDecode";

// THE BACKGROUND THE HOST HAS IS THE BACKGROUND EVERY SEAT HAS (combat, ancient events, shops).
//
// A viewer redirected to a headless seat holds TWO sockets: the seat's (the view) and the host's (kept open, gated
// off, so the host does not release the seat). Both deliver `session` envelopes carrying a `staticBackground`
// descriptor. The seat's URL carries the seat's own probed frame/digest, which the host's `/bg/` route refuses to
// render — so a seat view that used it went blank on every event and shop. What is pinned here, over the real app
// and the real StaticBackground (only MirrorView is replaced, by a stub that renders its `underlay` slot):
//   * a seat view shows the HOST's URL, admitted only while it names the scene the seat has mounted;
//   * a mismatch shows nothing — never the seat's URL, never one minted from the seat's wire;
//   * host a room ahead keeps the admitted still until the seat moves on; seat ahead waits for the host;
//   * a `staticBg` flip reaches the gated host socket as a `staticBg`-ONLY settings message (the full payload
//     would apply the refresh-rate/freeze levers to the HOST's own game);
//   * direct view is unchanged: the host socket is the serving socket, wire fallback included.

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

  // Silent, as in surfaceBackdrop.spec.ts: this file never exercises the drop path, and a close event at unmount
  // would arm a reconnect timer nothing is left to clear.
  close() {
    this.readyState = 3;
  }

  emit(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  settingsSent(): Record<string, unknown>[] {
    return this.sent.filter((m) => m.type === "settings");
  }
}

const SEAT_PORT = 14000;
const NEOW = "res://scenes/events/background_scenes/neow.tscn";
const UNDERDOCKS = "res://scenes/backgrounds/underdocks/underdocks_background.tscn";
const SHOP = "res://scenes/rooms/merchant_room.tscn";

// The two descriptors for one scene differ only in the frame each process probed — which is exactly the part the
// host's route checks.
const HOST_NEOW = { scenePath: NEOW, url: "/bg/events/neow?frame=0,0,1920,1080&v=1" };
const SEAT_NEOW = { scenePath: NEOW, url: "/bg/events/neow?frame=7,7,1906,1066&v=1" };
const HOST_UNDERDOCKS = { scenePath: UNDERDOCKS, url: "/bg/underdocks?layers=aaaaaaaaaaaaaaaa&v=1" };
const SEAT_UNDERDOCKS = { scenePath: UNDERDOCKS, url: "/bg/underdocks?layers=bbbbbbbbbbbbbbbb&v=1" };
const HOST_SHOP = { scenePath: SHOP, url: "/bg/rooms/merchant_room?frame=290,20,1340,1040&v=2" };
const SEAT_SHOP = { scenePath: SHOP, url: "/bg/rooms/merchant_room?frame=291,21,1340,1040&v=2" };

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
    connectionAttemptId: "attempt-1",
    ...over
  };
}

function node(id: string, parentId: string | null, over: Record<string, unknown> = {}) {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Control",
    visible: true,
    localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } },
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
    ...over
  };
}

// A scene with no bg root at all — the Stage-B steady state, where the descriptor is the only source.
const PLAIN_FRAME = { type: "scene-delta", full: true, screenType: "run", upserts: [node("root", null)], orderedIds: ["root"] };
// The Neow screen WITH its backdrop root on the wire: enough for the wire fallback to mint `/bg/events/neow?v=1`.
const NEOW_WIRE_FRAME = {
  type: "scene-delta",
  full: true,
  screenType: "run",
  upserts: [
    node("eventroom", null, { name: "EventRoom" }),
    node("layout", "eventroom", { name: "AncientEventLayout" }),
    node("neowbg", "layout", { name: "NeowBackground", sceneFilePath: NEOW })
  ],
  orderedIds: ["eventroom", "layout", "neowbg"]
};

// Replaces MirrorView (which needs a real stage) with the one thing this file needs from it: the underlay slot,
// where MirrorApp mounts StaticBackground.
const MirrorViewStub = defineComponent({
  name: "MirrorView",
  inheritAttrs: false,
  setup(_, { slots }) {
    return () => h("div", { "data-testid": "mirror-view-stub" }, slots.underlay?.());
  }
});

let realWebSocket: unknown;
let app: ReturnType<typeof mount> | null = null;
let decoded: string[] = [];

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
  await nextTick();
};

const hostSocket = () => MockWebSocket.instances[0]!;
const seatSocket = () => MockWebSocket.instances.find((s) => s.url.includes(`:${SEAT_PORT}`))!;
const shownUrl = (): string | null => {
  const img = app!.find('[data-testid="mirror-static-bg-image"]');
  return img.exists() ? img.attributes("src") ?? null : null;
};

/** Mount → host session (with the redirect) → seat session + one frame. Ends on a live seat view. */
async function joinSeat(host: unknown, seat: unknown, frame: unknown = PLAIN_FRAME): Promise<void> {
  app = mount(MirrorApp, { global: { stubs: { MirrorView: MirrorViewStub } } });
  await settle();
  hostSocket().emit(sessionMessage({ staticBackground: host, headlessMirrorPort: SEAT_PORT }));
  await settle();
  seatSocket().emit(sessionMessage({ staticBackground: seat }));
  await settle();
  seatSocket().emit(frame);
  await settle();
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  sessionStorage.clear();
  localStorage.clear();
  MockWebSocket.instances = [];
  realWebSocket = globalThis.WebSocket;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  mirrorSettings.staticBgEnabled = true;
  decoded = [];
  __setStillDecoderForTest((url, ready) => {
    decoded.push(url);
    ready(true);
  });
});

afterEach(() => {
  app?.unmount();
  app = null;
  vi.useRealTimers();
  __setStillDecoderForTest(null);
  mirrorSettings.staticBgEnabled = true;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket;
  MockWebSocket.instances = [];
});

describe("MirrorApp seat view — the host's static background", () => {
  it.each([
    { name: "event", host: HOST_NEOW, seat: SEAT_NEOW },
    { name: "combat", host: HOST_UNDERDOCKS, seat: SEAT_UNDERDOCKS },
    { name: "shop", host: HOST_SHOP, seat: SEAT_SHOP }
  ])("$name: shows the HOST's URL, never the seat's", async ({ host, seat }) => {
    await joinSeat(host, seat);
    expect(shownUrl()).toBe(host.url);
    expect(decoded).toEqual([host.url]);
  });

  it("follows the host's later envelopes on the gated host socket", async () => {
    await joinSeat(HOST_SHOP, SEAT_SHOP);
    // The host re-publishes the same room under a new frame (it probed again).
    const republished = { scenePath: SHOP, url: "/bg/rooms/merchant_room?frame=300,20,1340,1040&v=2" };
    hostSocket().emit(sessionMessage({ staticBackground: republished }));
    await settle();
    expect(shownUrl()).toBe(republished.url);
    expect(decoded).not.toContain(SEAT_SHOP.url);
  });

  it("a scene mismatch shows nothing — not the seat's URL, not a wire-minted one — until the host catches up", async () => {
    // The seat is on Neow (and its wire carries the Neow backdrop root); the host still describes the last combat.
    await joinSeat(HOST_UNDERDOCKS, SEAT_NEOW, NEOW_WIRE_FRAME);
    expect(shownUrl()).toBeNull();
    expect(decoded).toEqual([]);

    hostSocket().emit(sessionMessage({ staticBackground: HOST_NEOW }));
    await settle();
    expect(shownUrl()).toBe(HOST_NEOW.url);
    expect(decoded).toEqual([HOST_NEOW.url]);
  });

  it("host a room ahead: keeps the admitted still until the seat itself moves on", async () => {
    await joinSeat(HOST_NEOW, SEAT_NEOW);
    expect(shownUrl()).toBe(HOST_NEOW.url);

    // The host's game has already entered the next room; this seat's has not.
    hostSocket().emit(sessionMessage({ staticBackground: HOST_UNDERDOCKS }));
    await settle();
    expect(shownUrl()).toBe(HOST_NEOW.url);
    expect(decoded).toEqual([HOST_NEOW.url]);

    // The seat arrives: the host's descriptor for that room, not the seat's.
    seatSocket().emit(sessionMessage({ staticBackground: SEAT_UNDERDOCKS }));
    await settle();
    expect(shownUrl()).toBe(HOST_UNDERDOCKS.url);
    expect(decoded).toEqual([HOST_NEOW.url, HOST_UNDERDOCKS.url]);
  });

  it("seat a room ahead: blank until the host describes the seat's room", async () => {
    await joinSeat(HOST_NEOW, SEAT_NEOW);
    seatSocket().emit(sessionMessage({ staticBackground: SEAT_SHOP }));
    await settle();
    expect(shownUrl()).toBeNull();

    hostSocket().emit(sessionMessage({ staticBackground: HOST_SHOP }));
    await settle();
    expect(shownUrl()).toBe(HOST_SHOP.url);
    expect(decoded).toEqual([HOST_NEOW.url, HOST_SHOP.url]);
  });
});

describe("MirrorApp seat view — the host socket's staticBg", () => {
  it("a flip while joined sends the host socket a staticBg-ONLY settings message", async () => {
    await joinSeat(HOST_NEOW, SEAT_NEOW);
    // Nothing to catch up at the redirect: the host socket's connect URL already said staticBg=1.
    expect(hostSocket().url).toContain("staticBg=1");
    expect(hostSocket().settingsSent()).toEqual([]);

    mirrorSettings.staticBgEnabled = false;
    await settle();
    const [off] = hostSocket().settingsSent();
    expect(hostSocket().settingsSent()).toHaveLength(1);
    // ONLY the staticBg field: refresh rate and freezes would act on the host's OWN game.
    expect(Object.keys(off!).sort()).toEqual(["requestId", "staticBg", "type"]);
    expect(off!.staticBg).toBe(false);
    // The seat socket still gets its full payload, as before.
    const seatSettings = seatSocket().settingsSent();
    expect(seatSettings[seatSettings.length - 1]).toMatchObject({ staticBg: false, refreshRate: expect.any(Number) });

    mirrorSettings.staticBgEnabled = true;
    await settle();
    expect(hostSocket().settingsSent().map((m) => m.staticBg)).toEqual([false, true]);
    expect(hostSocket().settingsSent().every((m) => Object.keys(m).length === 3)).toBe(true);
  });

  it("a flip made on the picker reaches the host socket at the redirect", async () => {
    app = mount(MirrorApp, { global: { stubs: { MirrorView: MirrorViewStub } } });
    await settle();
    hostSocket().emit(sessionMessage({ staticBackground: HOST_NEOW }));
    await settle();
    mirrorSettings.staticBgEnabled = false;
    await settle();
    // No settings channel on the picker: nothing goes to the host socket yet.
    expect(hostSocket().settingsSent()).toEqual([]);

    hostSocket().emit(sessionMessage({ staticBackground: HOST_NEOW, headlessMirrorPort: SEAT_PORT }));
    await settle();
    expect(hostSocket().settingsSent()).toEqual([
      expect.objectContaining({ type: "settings", staticBg: false })
    ]);
    expect(Object.keys(hostSocket().settingsSent()[0]!).sort()).toEqual(["requestId", "staticBg", "type"]);
  });
});

describe("MirrorApp direct view — unchanged", () => {
  async function directView(staticBackground: unknown, frame: unknown) {
    app = mount(MirrorApp, { global: { stubs: { MirrorView: MirrorViewStub } } });
    await settle();
    hostSocket().emit(sessionMessage({ staticBackground, directView: true }));
    await settle();
    hostSocket().emit(frame);
    await settle();
  }

  it("shows the host socket's own descriptor", async () => {
    await directView(HOST_NEOW, PLAIN_FRAME);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(shownUrl()).toBe(HOST_NEOW.url);
  });

  it("still falls back to the wire when the host sent no descriptor", async () => {
    await directView(null, NEOW_WIRE_FRAME);
    expect(shownUrl()).toBe("/bg/events/neow?v=1");
  });

  it("a flip goes out once, as the full payload on the one (host) socket", async () => {
    await directView(HOST_NEOW, PLAIN_FRAME);
    const before = hostSocket().settingsSent().length;
    mirrorSettings.staticBgEnabled = false;
    await settle();
    const after = hostSocket().settingsSent().slice(before);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ staticBg: false, refreshRate: expect.any(Number) });
  });
});
