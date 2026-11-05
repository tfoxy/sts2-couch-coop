import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import type { RenderStreamClientOptions, RenderStreamStatus } from "@godot-scene-web/render-stream-client";

// MirrorApp's stream branch with a fake render-stream client (handoff-mirror-new-renderer.md §6, MIR-2): the switch
// pushes the server overlay and then gates the node-geometry scene off (`watch:false`), mounts the stage instead of
// MirrorView, never sends input, and falls back to the old renderer — watching again, saved choice kept — when the
// stream fails.

const fake = vi.hoisted(() => ({
  clients: [] as Array<{ options: RenderStreamClientOptions; connects: number; disposed: boolean }>,
  // The stage chunk's import (renderStreamStageLoader.ts): the real one unless a spec swaps it.
  stageImport: null as null | (() => Promise<unknown>)
}));
const realStageImport = () => import("@/mirror/RenderStreamStage.vue");
vi.mock("@/mirror/renderStreamStageLoader", () => ({
  importRenderStreamStage: () => (fake.stageImport ?? realStageImport)()
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
import MirrorView from "@/mirror/MirrorView.vue";
import { DEFAULT_REFRESH_RATE, mirrorSettings } from "@/mirror/mirrorSettings";
import {
  RENDER_STREAM_STAGE_LOAD_TIMEOUT_MS,
  renderStreamAvailability,
  renderStreamContext,
  retryRenderStream
} from "@/mirror/renderStreamAvailability";

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
  fake.stageImport = null;
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
    coreProblem: undefined, webgl2: undefined, pageLoopback: undefined, seatJoined: false,
    lanOffer: null, page: undefined });
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

  // The host's LoadingView step completes on `client-frame-presented`; MirrorView is unmounted under the stream, so
  // the stage's first drawn frame has to send it, for the attempt the join was answered with, on the host socket.
  it("completes the join on the stream's first drawn frame", async () => {
    canStream();
    mirrorSettings.renderer = "stream";
    app = mount(MirrorApp);
    await settle();
    const host = latest();
    host.emit(sessionMessage());
    await settle();
    await app.findAll('[data-testid="player-picker"] button')[1].trigger("click");
    await settle();
    host.emit(sessionMessage({ headlessMirrorPort: 14000, connectionAttemptId: "join-1" }));
    await settle();
    const seat = latest();
    seat.emit(seatSession({ renderStream: descriptor }));
    await settle();
    expect(mirrorSettings.runtimeRenderer).toBe("stream");
    expect(host.ofType("client-frame-presented")).toEqual([]);

    fail({ kind: "streaming", firstFrame: false });
    await settle();
    expect(host.ofType("client-frame-presented")).toEqual([]);
    fail({ kind: "streaming", firstFrame: true });
    await settle();
    expect(host.ofType("client-frame-presented")).toEqual([{ type: "client-frame-presented", attemptId: "join-1" }]);
    expect(seat.ofType("client-frame-presented")).toEqual([]);
  });

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

  // The choice rides the join: once the seat runs, the page follows that seat's renderer and asks for nothing.
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

  it("keeps a seat started without the stream on the old renderer, and asks the host for nothing", async () => {
    const { host, seat } = await joinNormalSeat();
    expect(renderStreamContext.seatJoined).toBe(true);
    mirrorSettings.renderer = "stream";
    await settle();
    expect(allSent().filter((m) => m.type === "set-renderer")).toHaveLength(0);
    expect(host.ofType("join")).toHaveLength(1);
    expect(seat.ofType("join")).toHaveLength(0);
    expect(mirrorSettings.runtimeRenderer).toBe("mirror");
    expect(renderStreamAvailability.value.reason).toBe("not-streaming");
  });

  it("draws a streaming seat even when the saved choice is off", async () => {
    canStream();
    app = mount(MirrorApp);
    await settle();
    latest().emit(sessionMessage());
    await settle();
    await app.findAll('[data-testid="player-picker"] button')[1].trigger("click");
    await settle();
    latest().emit(sessionMessage({ headlessMirrorPort: 14000 }));
    await settle();
    latest().emit(seatSession({ renderStream: descriptor }));
    await settle();
    expect(mirrorSettings.renderer).toBe("mirror");
    expect(mirrorSettings.runtimeRenderer).toBe("stream");
    expect(fake.clients).toHaveLength(1);
  });

  // CAR7b/CAR9: a LAN page reads the host's offer from its pre-join sessions, and the join asks for the stream only
  // when one of the offered carriers works on this page.
  async function joinFromLanPage(page: { https: boolean; secureContext: boolean; webTransport: boolean },
    offer: Record<string, boolean> | null): Promise<MockWebSocket> {
    canStream();
    Object.assign(renderStreamContext, { pageLoopback: false, page });
    mirrorSettings.renderer = "stream";
    app = mount(MirrorApp);
    await settle();
    const host = latest();
    host.emit(sessionMessage(offer ? { renderStreamLan: offer } : {}));
    await settle();
    await app.findAll('[data-testid="player-picker"] button')[1].trigger("click");
    await settle();
    return host;
  }

  it("on an https LAN page, reads the host's offer before the join and asks for the stream in it (CAR7b)", async () => {
    const host = await joinFromLanPage({ https: true, secureContext: true, webTransport: true },
      { webTransport: true, tls: true, ws: true });
    expect(renderStreamContext.lanOffer).toEqual({ webTransport: true, tls: true, ws: true });
    expect(host.ofType("join")[0]).toMatchObject({ renderer: "stream" });
  });

  it("on a LAN page of a host with no capture (no offer), asks for no streaming seat", async () => {
    const host = await joinFromLanPage({ https: true, secureContext: true, webTransport: true }, null);
    expect(renderStreamContext.lanOffer).toBeNull();
    expect(host.ofType("join")[0]).not.toHaveProperty("renderer");
  });

  it("on a plain-http LAN page, asks for the stream over the seat's plain ws (CAR9)", async () => {
    const host = await joinFromLanPage({ https: false, secureContext: false, webTransport: false },
      { webTransport: true, tls: false, ws: true });
    expect(host.ofType("join")[0]).toMatchObject({ renderer: "stream" });
  });

  it("on an https LAN page with no carrier it can open, says needs-proxy and asks for nothing", async () => {
    const host = await joinFromLanPage({ https: true, secureContext: true, webTransport: false },
      { webTransport: true, tls: false, ws: true });
    expect(renderStreamAvailability.value.reason).toBe("needs-proxy");
    expect(host.ofType("join")[0]).not.toHaveProperty("renderer");
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

// THE RENDERER AFTER A RE-JOIN (the field report "after a re-join with a desktop tab already present under the
// same name, the phone's renderer checkbox sent no set-renderer"). There is no mid-session request any more: a re-join
// reuses the live seat, which keeps the renderer it started with, and the page follows it either way.
describe("MirrorApp — the new-renderer checkbox after a re-join", () => {
  const descriptor = { url: "ws://127.0.0.1:13366/render-stream", resourceBase: "http://127.0.0.1:13366",
    token: "e".repeat(64), protocol: 13, presentation: [1920, 1080] };
  const seatSession = (over: Record<string, unknown> = {}) => sessionMessage({
    session: { joined: true, name: "Alice", status: "assigned", playerId: "p:1003", connectionCount: 1 },
    ...HEADLESS_FREEZES, ...over
  });

  async function pickAlice(): Promise<MockWebSocket> {
    Object.assign(renderStreamContext, { coreProblem: null, webgl2: true, pageLoopback: true, stopped: null,
      coreLoadFailed: false });
    app = mount(MirrorApp);
    await settle();
    const host = latest();
    host.emit(sessionMessage());
    await settle();
    await app.findAll('[data-testid="player-picker"] button')[1].trigger("click");
    await settle();
    return host;
  }

  it("follows the reused seat after a re-join, and asks the host for nothing", async () => {
    const host = await pickAlice();
    host.emit(sessionMessage({ headlessMirrorPort: 14000 }));
    await settle();
    const seat = latest();
    seat.emit(seatSession());
    await settle();
    expect(renderStreamContext.seatJoined).toBe(true);

    // The re-join: the seat socket drops, the page falls back to a fresh host socket and re-joins by the seat it was
    // granted. The host reuses that seat (a second device with the same name gets the same instance, not a new one),
    // so the page is joined again with no descriptor.
    seat.close();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await settle();
    const rejoined = latest();
    expect(rejoined).not.toBe(host);
    rejoined.emit(sessionMessage());
    await settle();
    expect(rejoined.ofType("join")[0]).toMatchObject({ playerId: "p:1003" });
    rejoined.emit(sessionMessage({ headlessMirrorPort: 14000 }));
    await settle();
    latest().emit(seatSession());
    await settle();
    expect(renderStreamContext.seatJoined).toBe(true);

    mirrorSettings.renderer = "stream";
    await settle();
    expect(allSent().filter((m) => m.type === "set-renderer")).toHaveLength(0);
    expect(mirrorSettings.runtimeRenderer).toBe("mirror");
  });

  it("draws the descriptor when the reused seat streams", async () => {
    const host = await pickAlice();
    host.emit(sessionMessage({ headlessMirrorPort: 14000 }));
    await settle();
    latest().emit(seatSession({ renderStream: descriptor }));
    await settle();
    expect(renderStreamAvailability.value).toMatchObject({ available: true, source: "session" });
    expect(renderStreamContext.seatJoined).toBe(true);

    mirrorSettings.renderer = "stream";
    await settle();
    // This viewer's seat is the streaming seat, so the page connects to it.
    expect(allSent().filter((m) => m.type === "set-renderer")).toHaveLength(0);
    expect(mirrorSettings.runtimeRenderer).toBe("stream");
    expect(fake.clients).toHaveLength(1);
  });
});

// The stage is a separate JS chunk. One that fails, or does not arrive in time (a flaky phone on the LAN), falls back
// to the old renderer exactly like a failed stream: the join's frame receipt is MirrorView's, so without the fallback
// the host's join would wait at "the browser is displaying the game" forever.
describe("MirrorApp — the stage chunk fails to load", () => {
  const descriptor = { url: "ws://127.0.0.1:13366/render-stream", resourceBase: "http://127.0.0.1:13366",
    token: "f".repeat(64), protocol: 13, presentation: [1920, 1080] };
  const seatSession = () => sessionMessage({
    session: { joined: true, name: "Alice", status: "assigned", playerId: "p:1003", connectionCount: 1 },
    ...HEADLESS_FREEZES, renderStream: descriptor
  });
  const sceneDelta = {
    type: "scene-delta", full: true, screenType: "run", screenInstanceId: "run:1",
    upserts: [{ id: "root", name: "Root", nodeType: "Control", visible: true }],
    removedIds: [], orderedIds: ["root"]
  };

  // The fallback mounts the real MirrorView, which watches its frame with a ResizeObserver jsdom does not have.
  beforeEach(() => {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  });
  afterEach(() => {
    delete (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver;
  });

  /** Join Alice's streaming seat; the host answers the join with attempt "join-1". */
  async function joinStreamingSeat(): Promise<{ host: MockWebSocket; seat: MockWebSocket }> {
    Object.assign(renderStreamContext, { coreProblem: null, webgl2: true, pageLoopback: true, stopped: null,
      coreLoadFailed: false });
    mirrorSettings.renderer = "stream";
    app = mount(MirrorApp);
    await settle();
    const host = latest();
    host.emit(sessionMessage());
    await settle();
    await app.findAll('[data-testid="player-picker"] button')[1].trigger("click");
    await settle();
    host.emit(sessionMessage({ headlessMirrorPort: 14000, connectionAttemptId: "join-1" }));
    await settle();
    const seat = latest();
    seat.emit(seatSession());
    await settle();
    return { host, seat };
  }

  const stageMounted = () => app!.find('[data-testid="render-stream-stage"]').exists();

  it("falls back to MirrorView with the stop reason set when the chunk rejects", async () => {
    fake.stageImport = () => Promise.reject(new Error("Failed to fetch dynamically imported module"));
    const { seat } = await joinStreamingSeat();

    expect(renderStreamContext.stopped).toBe("stage-load-failed: Failed to fetch dynamically imported module");
    expect(mirrorSettings.runtimeRenderer).toBe("mirror");
    expect(mirrorSettings.renderer).toBe("stream");
    expect(stageMounted()).toBe(false);
    expect(fake.clients).toHaveLength(0);

    seat.emit(sceneDelta);
    await settle();
    expect(app!.findComponent(MirrorView).exists()).toBe(true);
  });

  it("falls back after the timeout when the chunk never resolves", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fake.stageImport = () => new Promise(() => {});
      await joinStreamingSeat();
      expect(renderStreamContext.stopped).toBeNull();
      expect(mirrorSettings.runtimeRenderer).toBe("stream");

      vi.advanceTimersByTime(RENDER_STREAM_STAGE_LOAD_TIMEOUT_MS - 1);
      await settle();
      expect(renderStreamContext.stopped).toBeNull();

      vi.advanceTimersByTime(1);
      await settle();
      expect(renderStreamContext.stopped).toBe(
        `stage-load-failed: timed out after ${RENDER_STREAM_STAGE_LOAD_TIMEOUT_MS / 1000}s`);
      expect(mirrorSettings.runtimeRenderer).toBe("mirror");
      expect(stageMounted()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("completes the join from MirrorView's first frame for the join's attempt after the fallback", async () => {
    fake.stageImport = () => Promise.reject(new Error("chunk 404"));
    const { host, seat } = await joinStreamingSeat();
    seat.emit(sceneDelta);
    await settle();

    const view = app!.findComponent(MirrorView);
    expect(view.props("connectionAttemptId")).toBe("join-1");
    expect(host.ofType("client-frame-presented")).toEqual([]);
    // As in mirrorJoinUrl.spec.ts: jsdom does not paint, so the view's own presentation callback is driven directly
    // (the same callback its two-frame paint check ends in).
    view.props("onFirstSceneFramePresented")!("join-1");
    expect(host.ofType("client-frame-presented")).toEqual([{ type: "client-frame-presented", attemptId: "join-1" }]);
    expect(seat.ofType("client-frame-presented")).toEqual([]);
  });

  it("Try again imports the chunk afresh and mounts the stage", async () => {
    let imports = 0;
    fake.stageImport = () => {
      imports += 1;
      return imports === 1 ? Promise.reject(new Error("flaky")) : realStageImport();
    };
    await joinStreamingSeat();
    expect(imports).toBe(1);
    expect(renderStreamContext.stopped).toBe("stage-load-failed: flaky");
    expect(stageMounted()).toBe(false);

    retryRenderStream();
    await settle();

    expect(imports).toBe(2);
    expect(renderStreamContext.stopped).toBeNull();
    expect(mirrorSettings.runtimeRenderer).toBe("stream");
    expect(stageMounted()).toBe(true);
    expect(fake.clients).toHaveLength(1);
  });
});
