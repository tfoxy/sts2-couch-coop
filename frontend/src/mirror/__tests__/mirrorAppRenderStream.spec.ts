import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import type { RenderStreamClientOptions, RenderStreamStatus } from "@godot-scene-web/render-stream-client";

// MirrorApp's stream branch with a fake render-stream client (handoff-mirror-new-renderer.md §6, MIR-2): the switch
// pushes the server overlay and then gates the node-geometry scene off (`watch:false`), mounts the stage instead of
// MirrorView, never sends input, and falls back to the old renderer — watching again, saved choice kept — when the
// stream fails.

const fake = vi.hoisted(() => ({
  clients: [] as Array<{ options: RenderStreamClientOptions; connects: number; disposed: boolean }>
}));

vi.mock("@godot-scene-web/render-stream-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@godot-scene-web/render-stream-client")>()),
  createRenderStreamClient: (options: RenderStreamClientOptions) => {
    const client = { options, connects: 0, disposed: false };
    fake.clients.push(client);
    return {
      connect: () => { client.connects += 1; },
      setEndpoint: () => {},
      stats: () => ({ applied: 0, appliesPerSec: 0, creditRttMsP50: null, heapBytes: 0 }),
      dispose: () => { client.disposed = true; }
    };
  }
}));
vi.mock("@/mirror/renderStreamCore", () => ({
  renderStreamCoreConfig: () => ({
    core: { glueUrl: "/app/render-stream/rs_gsw_wasm_client.js", wasmUrl: "/app/render-stream/rs_gsw_wasm_bg.wasm",
      expectedTree: "0ccb21bb561c" },
    problem: null
  })
}));

import MirrorApp from "@/mirror/MirrorApp.vue";
import { DEFAULT_REFRESH_RATE, mirrorSettings } from "@/mirror/mirrorSettings";
import { renderStreamAvailability, renderStreamContext } from "@/mirror/renderStreamAvailability";

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
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  emit(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  ofType(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
}

const HEADLESS_FREEZES = { freezeParticles: true, freezeSpines: true, freezeDecor: true };

function sessionMessage(over: Record<string, unknown> = {}) {
  const player = (playerId: string, name: string, isHost: boolean) => ({
    playerId, name, isHost, isRunPlayer: true, connectionCount: isHost ? 1 : 0, disconnected: false, isLocal: false,
    netId: isHost ? null : 1003, isMirrorSeat: !isHost, seatStatus: "ready", seatStatusReason: null, characterId: null
  });
  return {
    type: "session",
    session: { name: null, status: "unassigned", joined: false, playerId: null, connectionCount: 0 },
    players: [player("p:1", "Hosty", true), player("p:1003", "Alice", false)],
    screen: { kind: "run", type: "Run", title: "Run", mirrorMode: "mp-run" },
    hostName: "host",
    hostAccess: { allowed: true, reason: "allowed", generation: 0 },
    scrollAction: true,
    ...over
  };
}

let realWebSocket: unknown;
let app: ReturnType<typeof mount> | null = null;
// The stage is an async component (loaded on first use), so settling includes its dynamic import.
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
  await vi.dynamicImportSettled();
  await flushPromises();
};
const latest = () => MockWebSocket.instances[MockWebSocket.instances.length - 1];

function streamAvailable(): void {
  Object.assign(renderStreamContext, { coreProblem: null, webgl2: true, pageLoopback: true, stopped: null,
    coreLoadFailed: false });
  mirrorSettings.renderStreamUrl = "ws://127.0.0.1:14861/render-stream";
}

/** Mount, pick Alice's seat, follow the redirect, and let the seat's own instance report. Returns the seat socket. */
async function joinSeat(): Promise<MockWebSocket> {
  app = mount(MirrorApp);
  await settle();
  latest().emit(sessionMessage());
  await settle();
  await app.findAll('[data-testid="player-picker"] button')[1].trigger("click");
  await settle();
  latest().emit(sessionMessage({ headlessMirrorPort: 14000 }));
  await settle();
  const seat = latest();
  expect(seat.url).toContain("14000");
  seat.emit(sessionMessage({
    session: { joined: true, name: "Alice", status: "assigned", playerId: "p:1003", connectionCount: 1 },
    ...HEADLESS_FREEZES
  }));
  await settle();
  return seat;
}

const allSent = () => MockWebSocket.instances.flatMap((socket) => socket.sent);
const fail = (status: RenderStreamStatus) => fake.clients[fake.clients.length - 1].options.onStatus?.(status);

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  globalThis.sessionStorage?.clear();
  globalThis.localStorage?.clear();
  MockWebSocket.instances = [];
  fake.clients.length = 0;
  realWebSocket = globalThis.WebSocket;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
  // Widescreen stretch off unless a test turns it on: a streaming-seat request then carries no `aspect` (PRES-A).
  Object.assign(mirrorSettings, { renderer: "mirror", runtimeRenderer: "mirror", renderStreamUrl: null,
    renderStreamProtocol: 12, refreshRate: DEFAULT_REFRESH_RATE, ...HEADLESS_FREEZES, staticBgEnabled: true,
    stretchEnabled: false });
});

afterEach(() => {
  app?.unmount();
  app = null;
  Object.assign(mirrorSettings, { renderer: "mirror", runtimeRenderer: "mirror", renderStreamUrl: null,
    stretchEnabled: true });
  Object.assign(renderStreamContext, { directView: false, sessionEndpoint: null, coreLoadFailed: false, stopped: null,
    coreProblem: undefined, webgl2: undefined, pageLoopback: undefined, seatJoined: false, seatRestart: null });
  globalThis.localStorage?.clear();
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket;
});

describe("MirrorApp — the new renderer's stream branch", () => {
  it("switching on pushes the server overlay, then watch:false, then mounts the stage instead of MirrorView", async () => {
    const seat = await joinSeat();
    seat.sent.length = 0;

    streamAvailable();
    mirrorSettings.renderer = "stream";
    await settle();

    expect(mirrorSettings.runtimeRenderer).toBe("stream");
    const kinds = seat.sent.map((m) => m.type);
    expect(kinds).toEqual(["settings", "watch"]);
    expect(seat.sent[0]).toMatchObject({ freezeParticles: false, freezeSpines: false, freezeDecor: false, staticBg: false,
      refreshRate: DEFAULT_REFRESH_RATE });
    expect(seat.sent[1]).toEqual({ type: "watch", on: false });

    expect(app!.find('[data-testid="render-stream-stage"]').exists()).toBe(true);
    expect(app!.find(".mirror-frame").exists()).toBe(false);
    expect(fake.clients).toHaveLength(1);
    expect(fake.clients[0].connects).toBe(1);
    expect(fake.clients[0].options.endpoint).toMatchObject({ url: "ws://127.0.0.1:14861/render-stream", token: null });
    // The gear moves to the fixed browser-space chrome: no scaled DOM stage hosts it.
    expect(app!.find(".mirror-chrome-gear").exists()).toBe(true);
  });

  it("never sends input while the stream draws", async () => {
    streamAvailable();
    mirrorSettings.renderer = "stream";
    await joinSeat();
    expect(app!.find('[data-testid="render-stream-stage"]').exists()).toBe(true);

    const stage = app!.get('[data-testid="render-stream-stage"]');
    for (const type of ["pointerdown", "pointermove", "pointerup", "click", "wheel"]) {
      await stage.trigger(type);
    }
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await settle();
    const kinds = new Set(allSent().map((m) => m.type));
    expect(kinds.has("input")).toBe(false);
    expect(kinds.has("action")).toBe(false);
  });

  it("opens the seat socket gated when the stream is already on, and connects the stage once joined", async () => {
    streamAvailable();
    mirrorSettings.renderer = "stream";
    const seat = await joinSeat();
    expect(mirrorSettings.runtimeRenderer).toBe("stream");
    expect(new URL(seat.url).searchParams.get("watch")).toBe("0");
    expect(seat.ofType("watch").filter((m) => m.on === true)).toHaveLength(0);
    expect(seat.ofType("settings")[0]).toMatchObject({ freezeParticles: false, staticBg: false });
    expect(fake.clients).toHaveLength(1);
  });

  it("falls back to the old renderer on failed: watches again, restores the saved values, keeps the choice", async () => {
    streamAvailable();
    mirrorSettings.renderer = "stream";
    const seat = await joinSeat();
    seat.sent.length = 0;

    fail({ kind: "failed", reason: "host-error", detail: "capture stopped" });
    await settle();

    expect(mirrorSettings.runtimeRenderer).toBe("mirror");
    expect(mirrorSettings.renderer).toBe("stream");
    expect(renderStreamContext.stopped).toBe("host-error: capture stopped");
    expect(fake.clients[0].disposed).toBe(true);
    expect(app!.find('[data-testid="render-stream-stage"]').exists()).toBe(false);
    expect(seat.sent.map((m) => m.type)).toEqual(["settings", "watch"]);
    expect(seat.sent[0]).toMatchObject({ ...HEADLESS_FREEZES, staticBg: true });
    expect(seat.sent[1]).toEqual({ type: "watch", on: true });
  });

  it("pushes tween replay off under the stream and restores it after", async () => {
    mirrorSettings.tweenReplay = true;
    const seat = await joinSeat();
    seat.sent.length = 0;
    streamAvailable();
    mirrorSettings.renderer = "stream";
    await settle();
    expect(seat.ofType("settings")[0]).toMatchObject({ tweenReplay: false });
    fail({ kind: "failed", reason: "host-error", detail: "bye" });
    await settle();
    expect(seat.ofType("settings")[1]).toMatchObject({ tweenReplay: true });
    expect(mirrorSettings.tweenReplay).toBe(true);
  });

  it("stays on the old renderer when the saved choice is on but nothing streams", async () => {
    Object.assign(renderStreamContext, { coreProblem: null, webgl2: true, pageLoopback: true });
    mirrorSettings.renderer = "stream";
    const seat = await joinSeat();
    expect(mirrorSettings.runtimeRenderer).toBe("mirror");
    expect(seat.url).not.toContain("watch=0");
    expect(fake.clients).toHaveLength(0);
    expect(seat.ofType("settings")[0]).toMatchObject(HEADLESS_FREEZES);
  });
});

// MIR-3: the host launches and pairs the streaming seat. The join asks for it; the seat's own `session` carries the
// descriptor; the stage's `unauthorized` ask is a `session-refresh` on the seat socket; a descriptor that goes away
// while drawing stops the stream with a reason.
describe("MirrorApp — pairing with the host's streaming seat", () => {
  const SEAT_TOKEN = "c".repeat(64);
  const descriptor = { url: "ws://127.0.0.1:13366/render-stream", resourceBase: "http://127.0.0.1:13366",
    token: SEAT_TOKEN, protocol: 13, presentation: [1920, 1080] };
  const seatSession = (over: Record<string, unknown> = {}) => sessionMessage({
    session: { joined: true, name: "Alice", status: "assigned", playerId: "p:1003", connectionCount: 1 },
    ...HEADLESS_FREEZES, ...over
  });

  function canStream(): void {
    Object.assign(renderStreamContext, { coreProblem: null, webgl2: true, pageLoopback: true, stopped: null,
      coreLoadFailed: false });
  }

  async function joinStreamingSeat(): Promise<MockWebSocket> {
    canStream();
    mirrorSettings.renderer = "stream";
    app = mount(MirrorApp);
    await settle();
    latest().emit(sessionMessage());
    await settle();
    await app.findAll('[data-testid="player-picker"] button')[1].trigger("click");
    await settle();
    latest().emit(sessionMessage({ headlessMirrorPort: 14000 }));
    await settle();
    const seat = latest();
    seat.emit(seatSession({ renderStream: descriptor }));
    await settle();
    return seat;
  }

  it("asks the host for a streaming seat in the join, only when the viewer chose it and this page can draw it", async () => {
    canStream();
    mirrorSettings.renderer = "stream";
    app = mount(MirrorApp);
    await settle();
    const host = latest();
    host.emit(sessionMessage());
    await settle();
    await app.findAll('[data-testid="player-picker"] button')[1].trigger("click");
    await settle();
    expect(host.ofType("join")[0]).toMatchObject({ name: "Alice", playerId: "p:1003", renderer: "stream" });
  });

  // PRES-A: the request for a streaming seat carries the page's aspect while Widescreen stretch is on, so the host
  // launches the seat that wide; off, it carries none (1920x1080).
  describe("the seat's aspect", () => {
    const sizes = { innerWidth: Object.getOwnPropertyDescriptor(window, "innerWidth"),
      innerHeight: Object.getOwnPropertyDescriptor(window, "innerHeight") };
    beforeEach(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 2340 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 1080 });
    });
    afterEach(() => {
      for (const [key, descriptor] of Object.entries(sizes)) {
        if (descriptor) Object.defineProperty(window, key, descriptor);
        else delete (window as unknown as Record<string, unknown>)[key];
      }
    });

    async function pickAlice(): Promise<MockWebSocket> {
      canStream();
      mirrorSettings.renderer = "stream";
      app = mount(MirrorApp);
      await settle();
      const host = latest();
      host.emit(sessionMessage());
      await settle();
      await app.findAll('[data-testid="player-picker"] button')[1].trigger("click");
      await settle();
      return host;
    }

    it("rides the join with Widescreen stretch on", async () => {
      mirrorSettings.stretchEnabled = true;
      const host = await pickAlice();
      const join = host.ofType("join")[0];
      expect(join).toMatchObject({ renderer: "stream" });
      expect(join.aspect).toBeCloseTo(2340 / 1080, 10);
    });

    it("is absent from the join with Widescreen stretch off", async () => {
      const host = await pickAlice();
      expect(host.ofType("join")[0]).toMatchObject({ renderer: "stream" });
      expect(host.ofType("join")[0]).not.toHaveProperty("aspect");
    });

    it("rides set-renderer with Widescreen stretch on, and never the withdrawal", async () => {
      mirrorSettings.stretchEnabled = true;
      const { host } = await joinNormalSeat();
      // The old renderer's join asked for no streaming seat, so it carried no aspect either.
      expect(host.ofType("join")[0]).not.toHaveProperty("aspect");
      mirrorSettings.renderer = "stream";
      await settle();
      const request = host.ofType("set-renderer")[0];
      expect(request).toMatchObject({ type: "set-renderer", renderer: "stream" });
      expect(request.aspect).toBeCloseTo(2340 / 1080, 10);
      mirrorSettings.renderer = "mirror";
      await settle();
      expect(host.ofType("set-renderer").at(-1)).toEqual({ type: "set-renderer", renderer: "mirror" });
    });

    it("is absent from set-renderer with Widescreen stretch off", async () => {
      const { host } = await joinNormalSeat();
      mirrorSettings.renderer = "stream";
      await settle();
      expect(host.ofType("set-renderer")).toEqual([{ type: "set-renderer", renderer: "stream" }]);
    });

    it("is not re-sent when the window changes after the request (PRES-R)", async () => {
      mirrorSettings.stretchEnabled = true;
      const { host } = await joinNormalSeat();
      mirrorSettings.renderer = "stream";
      await settle();
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1080 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 2340 });
      window.dispatchEvent(new Event("resize"));
      await settle();
      expect(host.ofType("set-renderer")).toHaveLength(1);
    });
  });

  it("joins exactly as before with the old renderer", async () => {
    canStream();
    app = mount(MirrorApp);
    await settle();
    const host = latest();
    host.emit(sessionMessage());
    await settle();
    await app.findAll('[data-testid="player-picker"] button')[1].trigger("click");
    await settle();
    expect(host.ofType("join")[0]).not.toHaveProperty("renderer");
  });

  it("streams from the seat's own descriptor, token included", async () => {
    await joinStreamingSeat();
    expect(mirrorSettings.runtimeRenderer).toBe("stream");
    expect(fake.clients).toHaveLength(1);
    expect(fake.clients[0].options.endpoint).toMatchObject({ url: descriptor.url, token: SEAT_TOKEN, protocol: 13 });
  });

  it("answers the stage's unauthorized ask with a session-refresh on the seat socket", async () => {
    const seat = await joinStreamingSeat();
    seat.sent.length = 0;
    fail({ kind: "failed", reason: "live-connect-failed", detail: "unauthorized" });
    await settle();
    expect(seat.sent).toEqual([{ type: "session-refresh" }]);
    expect(mirrorSettings.runtimeRenderer).toBe("stream");

    seat.emit(seatSession({ renderStream: { ...descriptor, token: "d".repeat(64) } }));
    await settle();
    expect(mirrorSettings.runtimeRenderer).toBe("stream");
    expect(renderStreamContext.stopped).toBeNull();
  });

  // MIR-4: the checkbox switched on after the seat started asks the HOST socket to restart the seat as the streaming
  // seat; the host's answer rides its own session, and the restarted seat's descriptor switches the stream on.
  async function joinNormalSeat(): Promise<{ host: MockWebSocket; seat: MockWebSocket }> {
    canStream();
    app = mount(MirrorApp);
    await settle();
    const host = latest();
    host.emit(sessionMessage());
    await settle();
    await app.findAll('[data-testid="player-picker"] button')[1].trigger("click");
    await settle();
    host.emit(sessionMessage({ headlessMirrorPort: 14000 }));
    await settle();
    const seat = latest();
    seat.emit(seatSession());
    await settle();
    return { host, seat };
  }

  it("asks the host to restart the seat when switched on mid-session, and withdraws when switched off", async () => {
    const { host, seat } = await joinNormalSeat();
    expect(renderStreamContext.seatJoined).toBe(true);
    mirrorSettings.renderer = "stream";
    await settle();
    expect(host.ofType("set-renderer")).toEqual([{ type: "set-renderer", renderer: "stream" }]);
    expect(seat.ofType("set-renderer")).toHaveLength(0);
    expect(mirrorSettings.runtimeRenderer).toBe("mirror");

    host.emit(sessionMessage({ rendererSeat: { state: "pending" } }));
    await settle();
    expect(renderStreamContext.seatRestart).toEqual({ state: "pending", reason: null, detail: null });
    expect(renderStreamAvailability.value.reason).toBe("seat-restart-pending");

    mirrorSettings.renderer = "mirror";
    await settle();
    expect(host.ofType("set-renderer").at(-1)).toEqual({ type: "set-renderer", renderer: "mirror" });
    host.emit(sessionMessage());
    await settle();
    expect(renderStreamContext.seatRestart).toBeNull();
  });

  it("asks nothing when the page could not draw the stream, or the seat already streams", async () => {
    const { host } = await joinNormalSeat();
    renderStreamContext.pageLoopback = false;
    mirrorSettings.renderer = "stream";
    await settle();
    expect(host.ofType("set-renderer")).toHaveLength(0);
  });

  it("switches to the stream when the restarted seat's descriptor arrives, and a pre-join session keeps the wait", async () => {
    const { host, seat } = await joinNormalSeat();
    mirrorSettings.renderer = "stream";
    await settle();
    host.emit(sessionMessage({ rendererSeat: { state: "restarting" } }));
    await settle();
    expect(renderStreamAvailability.value.reason).toBe("seat-restarting");

    // The old seat is stopped and its socket drops: after the backoff the app opens a fresh host socket, whose first
    // sessions carry nothing about a seat it has not re-joined yet. The page keeps showing the restart meanwhile.
    seat.close();
    await settle();
    expect(renderStreamContext.seatRestart?.state).toBe("restarting");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await settle();
    const fresh = latest();
    expect(fresh).not.toBe(host);
    fresh.emit(sessionMessage());
    await settle();
    expect(renderStreamContext.seatRestart?.state).toBe("restarting");
    // The re-join (by the remembered seat) is answered with the restarted seat's port, and that seat streams.
    expect(fresh.ofType("join")[0]).toMatchObject({ playerId: "p:1003", renderer: "stream" });
    // The host finished first (MIR-4's live leg: the seat was ready before the browser re-joined), so its reply
    // carries nothing; until the restarted seat itself speaks, the page still says it is restarting.
    fresh.emit(sessionMessage({ headlessMirrorPort: 14000 }));
    await settle();
    expect(renderStreamContext.seatRestart?.state).toBe("restarting");
    const restarted = latest();
    restarted.emit(seatSession({ renderStream: descriptor }));
    await settle();
    expect(renderStreamAvailability.value.available).toBe(true);
    expect(mirrorSettings.runtimeRenderer).toBe("stream");
    expect(renderStreamContext.seatRestart).toBeNull();
  });

  it("stops with \"descriptor gone\" when the seat's session drops the descriptor while drawing", async () => {
    const seat = await joinStreamingSeat();
    seat.emit(seatSession());
    await settle();
    expect(renderStreamContext.stopped).toBe("descriptor gone");
    expect(mirrorSettings.runtimeRenderer).toBe("mirror");
    expect(mirrorSettings.renderer).toBe("stream");
    expect(fake.clients[0].disposed).toBe(true);
  });
});
