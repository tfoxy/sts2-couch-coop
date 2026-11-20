import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import type { RenderStreamClientOptions, RenderStreamStatus } from "@godot-scene-web/render-stream-client";

// MirrorApp's stream branch with a fake render-stream client: the switch
// pushes settings and gates node-geometry admission (`watch:false`), retains a compatible mirror beneath the
// stage, and falls back to the old renderer — watching again, saved choice kept — when the stream fails.

const fake = vi.hoisted(() => ({
  clientFactory: null as null | ((options: RenderStreamClientOptions) => import("@godot-scene-web/render-stream-client").RenderStreamClient),
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
    if (fake.clientFactory) {
      const real = fake.clientFactory(options);
      return { ...real, dispose: () => { client.disposed = true; real.dispose(); } };
    }
    return {
      connect: () => { client.connects += 1; },
      setEndpoint: () => {},
      setStaticParticles: () => {},
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

import { resourceLifecycleClient } from "./resourceLifecycleClient";

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
    renderStreamLan: { relay: true, webTransport: false, tls: false, ws: true },
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
async function joinSeat(over: Record<string, unknown> = {}, redirect: Record<string, unknown> = {}): Promise<MockWebSocket> {
  app = mount(MirrorApp);
  await settle();
  latest().emit(sessionMessage());
  await settle();
  await app.findAll('[data-testid="player-picker"] button')[1].trigger("click");
  await settle();
  latest().emit(sessionMessage({ headlessMirrorPort: 14000, ...redirect }));
  await settle();
  const seat = latest();
  expect(seat.url).toContain("14000");
  expect(seat.ofType("renderer")).toEqual([]);
  seat.emit(sessionMessage({
    session: { joined: true, name: "Alice", status: "assigned", playerId: "p:1003", connectionCount: 1 },
    ...HEADLESS_FREEZES, rendererState: { state: "mirror" }, ...over
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
  fake.clientFactory = null;
  realWebSocket = globalThis.WebSocket;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
  // Widescreen stretch off unless a test turns it on: a streaming-seat request then carries no `aspect` (PRES-A).
  Object.assign(mirrorSettings, { renderer: "mirror", runtimeRenderer: "mirror", renderStreamUrl: null,
    renderStreamProtocol: 16, refreshRate: DEFAULT_REFRESH_RATE, ...HEADLESS_FREEZES, staticBgEnabled: true,
    stretchEnabled: false, streamFreezeSpines: false, streamStaticBg: false, streamParticleMode: "dynamic" });
});

afterEach(() => {
  delete globalThis.__couchCoopHostBase;
  app?.unmount();
  app = null;
  Object.assign(mirrorSettings, { renderer: "mirror", runtimeRenderer: "mirror", renderStreamUrl: null,
    stretchEnabled: true, panelOpen: false, streamFreezeSpines: false, streamStaticBg: false, streamParticleMode: "dynamic" });
  Object.assign(renderStreamContext, { directView: false, hostSelfStream: false, sessionEndpoint: null, rendererState: null, firstFrame: false, returningToMirror: false, coreLoadFailed: false, stopped: null,
    coreProblem: undefined, webgl2: undefined, pageLoopback: undefined, seatJoined: false,
    lanOffer: null, hostUnavailableReason: null, page: undefined });
  globalThis.localStorage?.clear();
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket;
});

describe("MirrorApp — the new renderer's stream branch", () => {
  it("declares and retracts stream still demand through the gated host socket after a seat redirect", async () => {
    streamAvailable();
    Object.assign(mirrorSettings, { renderer: "stream", streamStaticBg: true });
    await joinSeat({}, { hostAccess: { allowed: false, reason: "host-view-disabled", generation: 1 } });
    const host = MockWebSocket.instances[0];
    const settings = () => host.ofType("settings").map(({ type, requestId, ...payload }) => payload);
    expect(settings()).toEqual([{ staticBg: false, streamStaticBg: true }]);
    host.sent.length = 0;

    mirrorSettings.streamStaticBg = false;
    await settle();
    expect(settings()).toEqual([{ staticBg: false, streamStaticBg: false }]);
    host.sent.length = 0;
    mirrorSettings.renderer = "mirror";
    await settle();
    expect(settings()).toEqual([{ staticBg: true }]);
  });

  it.each([true, false])("declares and retracts host stream background demand once with host access %s", async (allowed) => {
    streamAvailable();
    Object.assign(mirrorSettings, { renderer: "stream", streamStaticBg: false });
    await joinSeat({}, { hostAccess: { allowed, reason: allowed ? "allowed" : "host-view-disabled", generation: 1 } });
    const host = MockWebSocket.instances[0];
    expect(host.ofType("settings")).toEqual([expect.objectContaining({ staticBg: false })]);
    expect(host.ofType("settings")[0]).not.toHaveProperty("streamStaticBg");
    host.sent.length = 0;
    mirrorSettings.streamStaticBg = true;
    await settle();
    expect(host.ofType("settings")).toEqual([
      expect.objectContaining({ staticBg: false, streamStaticBg: true })
    ]);
    host.sent.length = 0;

    mirrorSettings.streamStaticBg = false;
    await settle();
    expect(host.ofType("settings")).toEqual([
      expect.objectContaining({ staticBg: false, streamStaticBg: false })
    ]);
    host.emit(sessionMessage());
    await settle();
    expect(host.ofType("settings")).toHaveLength(1);
  });

  it("shows the seat's character-select pick independently of host updates", async () => {
    streamAvailable();
    Object.assign(mirrorSettings, { renderer: "stream", streamStaticBg: true });
    const character = (id: string) => ({
      scenePath: `res://scenes/screens/char_select/char_select_bg_${id}.tscn`,
      url: `/bg/char-select/${id}?v=1`, id: `seat:42:${id}`
    });
    const first = character("silent");
    const seat = await joinSeat({ staticBackground: first });
    const host = MockWebSocket.instances[0];
    const image = () => app!.get('[data-testid="stream-static-bg-image"]');
    expect(image().attributes("src")).toBe(first.url);
    await image().trigger("load");
    await settle();
    expect(seat.ofType("settings").at(-1)).toMatchObject({ streamStaticBgReady: first.id });

    host.emit(sessionMessage({ staticBackground: character("ironclad") }));
    await settle();
    expect(image().attributes("src")).toBe(first.url);
    const pick = character("random_character");
    seat.emit(sessionMessage({ staticBackground: pick }));
    await settle();
    expect(image().attributes("src")).toBe(pick.url);
    expect(seat.ofType("settings").at(-1)).toMatchObject({ streamStaticBgReady: "" });
    await image().trigger("error");
    await settle();
    expect((image().element.parentElement as HTMLElement).style.visibility).toBe("hidden");
    expect(app!.get('[data-testid="render-stream-background-stage"]').attributes("style"))
      .toContain("background-color: rgb(24, 24, 24)");

    seat.emit(sessionMessage({ staticBackground: null }));
    await settle();
    expect(app!.find('[data-testid="stream-static-bg-image"]').exists()).toBe(false);
  });

  it("sends the seat descriptor vote only after its host still loads and retracts it on change/error/off", async () => {
    streamAvailable();
    Object.assign(mirrorSettings, { renderer: "stream", streamStaticBg: true });
    const scenePath = "res://scenes/backgrounds/underdocks/underdocks_background.tscn";
    const hostBackground = { scenePath, url: "/bg/underdocks?layers=host&v=1" };
    const seatBackground = { scenePath, url: "/bg/underdocks?layers=seat&v=1", id: "room-1", combatFrame: "983,540,1" };
    const seat = await joinSeat({ staticBackground: seatBackground });
    const host = MockWebSocket.instances[0];
    host.emit(sessionMessage({ staticBackground: hostBackground }));
    await settle();
    const image = () => app!.get('[data-testid="stream-static-bg-image"]');
    const votes = () => seat.ofType("settings").map((s) => s.streamStaticBgReady);
    expect(image().attributes("src")).toBe(hostBackground.url);
    expect((image().element as HTMLImageElement).style.transform).toBe("translate(0px, 0px) scale(1.1111111111111112)");
    expect(votes().every((v) => v === "")).toBe(true);
    expect(seat.ofType("settings").at(-1)).toMatchObject({ streamStaticBg: true });
    expect(host.ofType("settings").at(-1)).toMatchObject({ type: "settings", staticBg: false, streamStaticBg: true });
    host.sent.length = 0;
    seat.sent.length = 0;
    await image().trigger("load");
    await settle();
    expect(votes()).toEqual([seatBackground.id]);
    expect(host.ofType("settings")).toEqual([]);

    // A repeat session is not a new descriptor and must not retract a loaded vote.
    seat.emit(sessionMessage({ staticBackground: { ...seatBackground } }));
    await settle();
    expect(votes()).toEqual([seatBackground.id]);

    host.emit(sessionMessage({ staticBackground: { ...hostBackground, url: "/bg/underdocks?layers=host-next&v=1" } }));
    await settle();
    expect(votes().at(-1)).toBe("");
    await image().trigger("load");
    await settle();
    expect(votes().at(-1)).toBe(seatBackground.id);
    await image().trigger("error");
    await settle();
    expect(votes().at(-1)).toBe("");
    await image().trigger("load");
    await settle();
    // Re-entering the same backdrop uses the same cached picture, but needs a fresh mounted-room vote.
    seat.emit(sessionMessage({ staticBackground: { ...seatBackground, id: "room-2" } }));
    await settle();
    expect(votes().at(-1)).toBe("");
    await image().trigger("load");
    await settle();
    expect(votes().at(-1)).toBe("room-2");
    mirrorSettings.streamStaticBg = false;
    await settle();
    expect(votes().at(-1)).toBe("");
    expect(host.ofType("settings").at(-1)).toMatchObject({ type: "settings", staticBg: false, streamStaticBg: false });
    expect(seat.ofType("settings").at(-1)).toMatchObject({ streamStaticBg: false });
    expect(app!.find('[data-testid="stream-static-bg-image"]').exists()).toBe(false);
  });

  it("sends particle demand to the seat and retracts it on toggle or renderer change", async () => {
    streamAvailable();
    Object.assign(mirrorSettings, { renderer: "stream", streamParticleMode: "static" });
    const seat = await joinSeat();
    const host = MockWebSocket.instances[0];
    expect(seat.ofType("settings").at(-1)).toMatchObject({ streamStaticParticles: true });
    expect(host.ofType("settings").every((s) => !("streamStaticParticles" in s))).toBe(true);

    seat.sent.length = 0;
    mirrorSettings.streamParticleMode = "dynamic";
    await settle();
    expect(seat.ofType("settings")).toHaveLength(1);
    expect(seat.ofType("settings")[0]).toMatchObject({ streamStaticParticles: false });
    mirrorSettings.streamParticleMode = "static";
    await settle();
    expect(seat.ofType("settings").at(-1)).toMatchObject({ streamStaticParticles: true });
    mirrorSettings.renderer = "mirror";
    await settle();
    expect(seat.ofType("settings").at(-1)).toMatchObject({ streamStaticParticles: false });
  });

  it.each(["mirror", "arming", "armed", "disarming"])("seeds stream spine truth while %s and forwards later viewer changes", async (state) => {
    streamAvailable();
    mirrorSettings.renderer = "stream";
    const seat = await joinSeat({ streamFreezeSpines: true, rendererState: { state } });
    expect(mirrorSettings.runtimeRenderer).toBe("stream");
    expect(mirrorSettings.streamFreezeSpines).toBe(true);
    expect(seat.ofType("settings")[0]).toMatchObject({ streamFreezeSpines: true, freezeSpines: true });

    seat.sent.length = 0;
    mirrorSettings.streamFreezeSpines = false;
    await settle();
    expect(seat.ofType("settings")).toHaveLength(1);
    expect(seat.ofType("settings")[0]).toMatchObject({ streamFreezeSpines: false, freezeSpines: true });

    seat.emit(sessionMessage({
      session: { joined: true, name: "Alice", status: "assigned", playerId: "p:1003", connectionCount: 1 },
      rendererState: { state: "mirror" }, streamFreezeSpines: true, ...HEADLESS_FREEZES
    }));
    await settle();
    expect(mirrorSettings.streamFreezeSpines).toBe(false);

    mirrorSettings.renderer = "mirror";
    await settle();
    expect(seat.ofType("settings").at(-1)).not.toHaveProperty("streamFreezeSpines");
  });

  it("switching on pushes the server overlay, then watch:false, then mounts the stage instead of MirrorView", async () => {
    const seat = await joinSeat();
    seat.sent.length = 0;

    streamAvailable();
    mirrorSettings.renderer = "stream";
    await settle();

    expect(mirrorSettings.runtimeRenderer).toBe("stream");
    const kinds = seat.sent.map((m) => m.type);
    expect(kinds).toEqual(["settings", "watch"]);
    expect(seat.sent[0]).toMatchObject({ freezeParticles: true, freezeSpines: true, freezeDecor: true, staticBg: false,
      refreshRate: DEFAULT_REFRESH_RATE });
    expect(seat.sent[1]).toEqual({ type: "watch", on: false });

    expect(app!.find('[data-testid="render-stream-stage"]').exists()).toBe(true);
    expect(app!.find(".mirror-frame").exists()).toBe(false);
    expect(fake.clients).toHaveLength(1);
    expect(fake.clients[0].connects).toBe(1);
    expect(fake.clients[0].options.endpoint).toMatchObject({ url: "ws://127.0.0.1:14861/render-stream", token: null });
    // jsdom has no canvas layout: the fixed pair stays until the stage can measure its controls.
    expect(app!.find(".render-stream-gear").exists()).toBe(false);
    expect(app!.find(".mirror-chrome-gear").exists()).toBe(true);
  });

  it.each([undefined, 7])("keeps QA stream input across descriptor-less sessions (epoch %s)", async (epoch) => {
    streamAvailable();
    mirrorSettings.renderer = "stream";
    const rendererState = epoch === undefined ? { state: "mirror" } : {
      state: "mirror", presentationEpoch: epoch, presentationReady: true,
      presentationWidth: 1920, presentationHeight: 1080
    };
    const seat = await joinSeat({ rendererState });
    fail({ kind: "streaming", firstFrame: true });
    await settle();
    const client = fake.clients.at(-1)!;
    const send = (window as unknown as { __mirrorSendInput: (msg: import("@/mirror/mirrorClient").MirrorInputMessage) => void }).__mirrorSendInput;
    const input = { kind: "click" as const, coordX: 100, coordY: 200,
      ...(epoch !== undefined ? { presentationEpoch: epoch } : {}) };
    for (let i = 0; i < 2; i += 1) {
      seat.emit(sessionMessage({ rendererState }));
      await settle();
      expect(renderStreamContext.firstFrame).toBe(true);
      send(input);
    }
    expect(fake.clients.at(-1)).toBe(client);
    expect(client.disposed).toBe(false);
    expect(seat.ofType("input")).toEqual([
      expect.objectContaining(input), expect.objectContaining(input)
    ]);
  });

  it("recovers QA stream input when the same presentation becomes ready again", async () => {
    streamAvailable();
    mirrorSettings.renderer = "stream";
    const rendererState = { state: "mirror", presentationEpoch: 7, presentationReady: true,
      presentationWidth: 1920, presentationHeight: 1080 };
    const seat = await joinSeat({ rendererState });
    fail({ kind: "streaming", firstFrame: true });
    await settle();
    const client = fake.clients.at(-1)!;
    const send = (window as unknown as { __mirrorSendInput: (msg: import("@/mirror/mirrorClient").MirrorInputMessage) => void }).__mirrorSendInput;
    const input = { kind: "click" as const, coordX: 100, coordY: 200, presentationEpoch: 7 };
    seat.emit(sessionMessage({ rendererState: { ...rendererState, presentationReady: false } }));
    await settle();
    send(input);
    expect(seat.ofType("input")).toEqual([]);
    seat.emit(sessionMessage({ rendererState }));
    await settle();
    expect(renderStreamContext.firstFrame).toBe(true);
    send(input);
    expect(seat.ofType("input")).toEqual([expect.objectContaining(input)]);
    expect(fake.clients.at(-1)).toBe(client);
  });

  it.each([undefined, 7])("waits for a hidden-tab replacement's own frame before sending Couch input (epoch %s)", async (epoch) => {
    streamAvailable();
    mirrorSettings.renderer = "stream";
    const keyboard = mirrorSettings.keyboard;
    mirrorSettings.keyboard = true;
    const rendererState = epoch === undefined ? { state: "mirror" } : {
      state: "mirror", presentationEpoch: epoch, presentationReady: true,
      presentationWidth: 1920, presentationHeight: 1080
    };
    let visibility: DocumentVisibilityState = "visible";
    const visibilitySpy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const press = () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyQ" }));
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyQ" }));
    };
    try {
      const seat = await joinSeat({ rendererState });
      fail({ kind: "streaming", firstFrame: true });
      await settle();
      press();
      expect(seat.ofType("input")).toMatchObject([
        { kind: "key", key: "KeyQ", pressed: true }, { kind: "key", key: "KeyQ", pressed: false }
      ]);
      const old = fake.clients.at(-1)!;
      const count = fake.clients.length;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(old.disposed).toBe(true);
      expect(renderStreamContext.firstFrame).toBe(false);
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
      expect(fake.clients).toHaveLength(count + 1);
      const replacement = fake.clients.at(-1)!;
      old.options.onStatus?.({ kind: "streaming", firstFrame: true });
      old.options.onStatus?.({ kind: "ended" });
      replacement.options.onStatus?.({ kind: "streaming", firstFrame: false });
      seat.emit(sessionMessage({ rendererState: { ...rendererState, presentationReady: false } }));
      await settle();
      seat.emit(sessionMessage({ rendererState }));
      await settle();
      seat.sent.length = 0;
      press();
      expect(seat.ofType("input")).toEqual([]);
      expect(renderStreamContext.firstFrame).toBe(false);
      expect(replacement.disposed).toBe(false);

      fail({ kind: "streaming", firstFrame: true });
      await settle();
      expect(renderStreamContext.firstFrame).toBe(true);
      press();
      expect(seat.ofType("input")).toMatchObject([
        { kind: "key", key: "KeyQ", pressed: true,
          ...(epoch !== undefined ? { presentationEpoch: epoch } : {}) },
        { kind: "key", key: "KeyQ", pressed: false,
          ...(epoch !== undefined ? { presentationEpoch: epoch } : {}) }
      ]);
      expect(fake.clients.at(-1)).toBe(replacement);
    } finally {
      mirrorSettings.keyboard = keyboard;
      vi.useRealTimers();
      visibilitySpy.mockRestore();
    }
  });

  it.each(["endpoint", "presentation"])("waits for a new QA frame after %s replacement", async (replacement) => {
    streamAvailable();
    mirrorSettings.renderer = "stream";
    const rendererState = { state: "mirror", presentationEpoch: 7, presentationReady: true,
      presentationWidth: 1920, presentationHeight: 1080 };
    const seat = await joinSeat({ rendererState });
    fail({ kind: "streaming", firstFrame: true });
    await settle();
    const old = fake.clients.at(-1)!;
    const epoch = replacement === "presentation" ? 8 : 7;
    if (replacement === "endpoint") mirrorSettings.renderStreamUrl = "ws://127.0.0.1:14862/render-stream";
    else seat.emit(sessionMessage({ rendererState: { ...rendererState, presentationEpoch: epoch } }));
    await settle();
    expect(renderStreamContext.firstFrame).toBe(false);
    old.options.onStatus?.({ kind: "streaming", firstFrame: true });
    await settle();
    expect(renderStreamContext.firstFrame).toBe(false);
    const send = (window as unknown as { __mirrorSendInput: (msg: import("@/mirror/mirrorClient").MirrorInputMessage) => void }).__mirrorSendInput;
    const input = { kind: "click" as const, coordX: 100, coordY: 200, presentationEpoch: epoch };
    send(input);
    expect(seat.ofType("input")).toEqual([]);
    fail({ kind: "streaming", firstFrame: true });
    await settle();
    send(input);
    expect(seat.ofType("input")).toEqual([expect.objectContaining(input)]);
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
    expect(kinds.has("renderer")).toBe(false);
  });

  it("opens the seat socket gated when the stream is already on, and connects the stage once joined", async () => {
    streamAvailable();
    mirrorSettings.renderer = "stream";
    const seat = await joinSeat();
    expect(mirrorSettings.runtimeRenderer).toBe("stream");
    expect(new URL(seat.url).searchParams.get("watch")).toBe("0");
    expect(seat.ofType("watch").filter((m) => m.on === true)).toHaveLength(0);
    expect(seat.ofType("settings")[0]).toMatchObject({ freezeParticles: true, staticBg: false });
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

// The page requests streaming on its seat socket; the seat's own `session` carries the descriptor; the stage's `unauthorized` ask is a `session-refresh` on the seat socket; a descriptor that goes away
// while drawing stops the stream with a reason.
describe("MirrorApp — pairing with the host's streaming seat", () => {
  const SEAT_TOKEN = "c".repeat(64);
  const descriptor = { url: "ws://127.0.0.1:13366/render-stream", resourceBase: "http://127.0.0.1:13366",
    token: SEAT_TOKEN, protocol: 16, presentation: [1920, 1080] };
  const seatSession = (over: Record<string, unknown> = {}) => sessionMessage({
    session: { joined: true, name: "Alice", status: "assigned", playerId: "p:1003", connectionCount: 1 },
    ...HEADLESS_FREEZES, rendererState: { state: over.renderStream ? "armed" : "mirror" }, ...over
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

  // The host's LoadingView step completes on `client-frame-presented`; MirrorView is held under the stream, so
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

  it("applies the saved choice once after the seat's first session, never on the host socket", async () => {
    canStream();
    mirrorSettings.renderer = "stream";
    const seat = await joinSeat();
    const host = MockWebSocket.instances[0];
    expect(host.ofType("join")[0]).toMatchObject({ name: "Alice", playerId: "p:1003" });
    expect(host.ofType("join")[0]).not.toHaveProperty("renderer");
    expect(host.ofType("join")[0]).not.toHaveProperty("aspect");
    expect(host.ofType("renderer")).toEqual([]);
    expect(seat.ofType("renderer")).toEqual([{ type: "renderer", rendererProtocol: 2, renderer: "stream" }]);

    seat.emit(seatSession());
    seat.emit(seatSession({ rendererState: { state: "arming" } }));
    seat.emit(seatSession());
    await settle();
    expect(seat.ofType("renderer")).toHaveLength(1);
  });

  it.each(["arming", "armed"])("requests this page's descriptor once when the shared seat is already %s", async (state) => {
    canStream();
    mirrorSettings.renderer = "stream";
    const rendererState = { state, presentationEpoch: 10, presentationReady: true,
      presentationWidth: 1920, presentationHeight: 1080, restoreComplete: true };
    const seat = await joinSeat({ rendererState });
    expect(seat.ofType("renderer")).toEqual([{ type: "renderer", rendererProtocol: 2, renderer: "stream" }]);
    for (let duplicate = 0; duplicate < 2; duplicate += 1) {
      seat.emit(seatSession({ rendererState }));
      await settle();
    }
    expect(seat.ofType("renderer")).toHaveLength(1);
    expect(renderStreamContext.stopped).toBeNull();
    expect(mirrorSettings.renderer).toBe("stream");
    expect(fake.clients).toHaveLength(0);
    seat.emit(seatSession({ rendererState, renderStream: descriptor }));
    await settle();
    expect(fake.clients).toHaveLength(1);
    expect(mirrorSettings.runtimeRenderer).toBe("stream");
  });

  it.each(["checkbox", "retry"])("waits for a new descriptor after a previous stream attempt (%s)", async (restart) => {
    const seat = await joinStreamingSeat();
    fail({ kind: "streaming", firstFrame: true });
    await settle();
    if (restart === "checkbox") mirrorSettings.renderer = "mirror";
    else fail({ kind: "ended" });
    await settle();
    const rendererState = { state: "armed", presentationEpoch: 10, presentationReady: true,
      presentationWidth: 1920, presentationHeight: 1080, restoreComplete: true };
    seat.sent.length = 0;
    // The previous attempt's descriptor is still in the latest session when the new request is sent.
    if (restart === "checkbox") mirrorSettings.renderer = "stream";
    else retryRenderStream();
    await settle();
    for (let duplicate = 0; duplicate < 2; duplicate += 1) {
      seat.emit(seatSession({ rendererState }));
      await settle();
    }
    expect(renderStreamContext.stopped).toBeNull();
    expect(seat.ofType("renderer")).toEqual([{ type: "renderer", rendererProtocol: 2, renderer: "stream" }]);
    seat.emit(seatSession({ rendererState, renderStream: descriptor }));
    await settle();
    expect(mirrorSettings.runtimeRenderer).toBe("stream");
    seat.emit(seatSession({ rendererState }));
    await settle();
    seat.emit(seatSession({ rendererState }));
    await settle();
    expect(renderStreamContext.stopped).toBe("descriptor gone");
    expect(seat.ofType("renderer").map(m => m.renderer)).toEqual(["stream", "mirror"]);
  });

  it("registers this page even when the first session already supplies a descriptor", async () => {
    const seat = await joinStreamingSeat();
    expect(seat.ofType("renderer")).toEqual([{ type: "renderer", rendererProtocol: 2, renderer: "stream" }]);
  });

  it("requests the saved stream once when capability arrives after admission", async () => {
    canStream();
    mirrorSettings.renderer = "stream";
    renderStreamContext.webgl2 = false;
    const seat = await joinSeat();
    expect(seat.ofType("renderer")).toEqual([{ type: "renderer", rendererProtocol: 2, renderer: "mirror" }]);
    renderStreamContext.webgl2 = true;
    await settle();
    seat.emit(seatSession({ rendererState: { state: "arming" } }));
    await settle();
    expect(seat.ofType("renderer").map(m => m.renderer)).toEqual(["mirror", "stream"]);
  });

  it("reconsiders an initially unsupported host when its relay offer arrives", async () => {
    canStream();
    mirrorSettings.renderer = "stream";
    app = mount(MirrorApp);
    await settle();
    const host = latest();
    host.emit(sessionMessage({ renderStreamLan: { webTransport: true, tls: false, ws: true } }));
    await settle();
    await app.findAll('[data-testid="player-picker"] button')[1].trigger("click");
    host.emit(sessionMessage({ headlessMirrorPort: 14000, renderStreamLan: null }));
    await settle();
    const seat = latest();
    seat.emit(seatSession());
    await settle();
    expect(renderStreamAvailability.value.reason).toBe("host-update");
    expect(mirrorSettings.renderer).toBe("stream");
    expect(seat.ofType("renderer").map(m => m.renderer)).toEqual(["mirror"]);
    host.emit(sessionMessage());
    await settle();
    host.emit(sessionMessage());
    await settle();
    expect(seat.ofType("renderer").map(m => m.renderer)).toEqual(["mirror", "stream"]);
    expect(host.ofType("renderer")).toEqual([]);
  });

  it("registers an explicit mirror choice only after control admission", async () => {
    canStream();
    const seat = await joinSeat({ hostAccess: { allowed: false, reason: "transitioning", generation: 0 } });
    expect(seat.ofType("renderer")).toEqual([]);
    seat.emit({ type: "host-access", hostAccess: { allowed: true, reason: "allowed", generation: 0 } });
    await settle();
    seat.emit(seatSession());
    await settle();
    expect(seat.ofType("renderer")).toEqual([{ type: "renderer", rendererProtocol: 2, renderer: "mirror" }]);
  });

  it.each(["arming", "disarming", "armed"])("keeps saved freeze preferences when %s reports effective false values", async (state) => {
    canStream();
    const seat = await joinSeat({ rendererState: { state }, freezeParticles: false, freezeSpines: false, freezeDecor: false });
    expect(mirrorSettings).toMatchObject(HEADLESS_FREEZES);
    expect(seat.ofType("settings").at(-1)).toMatchObject(HEADLESS_FREEZES);
  });

  it("does not seed effective freezes while failed teardown is still unrestored", async () => {
    canStream();
    const seat = await joinSeat({ rendererState: { state: "failed", restoreComplete: false },
      freezeParticles: false, freezeSpines: false, freezeDecor: false });
    expect(mirrorSettings).toMatchObject(HEADLESS_FREEZES);
    expect(seat.ofType("settings").at(-1)).toMatchObject(HEADLESS_FREEZES);
  });

  it("withdraws this page's demand when the first seat state is failed", async () => {
    canStream();
    mirrorSettings.renderer = "stream";
    const seat = await joinSeat({ rendererState: { state: "failed" } });
    expect(seat.ofType("renderer").at(-1)).toMatchObject({ renderer: "mirror", rendererProtocol: 2 });
    expect(renderStreamContext.stopped).not.toBeNull();
  });

  it.each(["webgl2", "core", "carrier"])("does not request streaming when this page cannot draw it (%s)", async (missing) => {
    canStream();
    if (missing === "webgl2") renderStreamContext.webgl2 = false;
    if (missing === "core") renderStreamContext.coreProblem = "missing";
    if (missing === "carrier") {
      renderStreamContext.pageLoopback = false;
      renderStreamContext.page = { https: true, secureContext: true, webTransport: false };
    }
    mirrorSettings.renderer = "stream";
    const seat = await joinSeat();
    expect(seat.ofType("renderer")).toEqual([{ type: "renderer", rendererProtocol: 2, renderer: "mirror" }]);
    mirrorSettings.renderer = "mirror";
    await settle();
    mirrorSettings.renderer = "stream";
    await settle();
    expect(seat.ofType("renderer").filter((message) => message.renderer === "stream")).toEqual([]);
    seat.emit(seatSession({ rendererState: { state: "failed", reason: "capture stopped" } }));
    await settle();
    retryRenderStream();
    await settle();
    expect(seat.ofType("renderer").filter((message) => message.renderer === "stream")).toEqual([]);
  });

  it("does not request a renderer for a direct host view without renderer state", async () => {
    canStream();
    mirrorSettings.renderer = "stream";
    app = mount(MirrorApp);
    await settle();
    const host = latest();
    host.emit(sessionMessage());
    await settle();
    await app.findAll('[data-testid="player-picker"] button')[0].trigger("click");
    await settle();
    host.emit(sessionMessage({ directView: true }));
    await settle();
    mirrorSettings.renderer = "mirror";
    await settle();
    mirrorSettings.renderer = "stream";
    await settle();
    expect(host.ofType("renderer")).toEqual([]);
    expect(renderStreamAvailability.value.reason).toBe("host-view");
  });

  it("requests and displays the host's own stream, fences its epochs, and unticks on the host socket", async () => {
    canStream();
    globalThis.__couchCoopHostBase = "http://127.0.0.1:13337";
    mirrorSettings.panelOpen = true;
    app = mount(MirrorApp);
    await settle();
    const host = latest();
    host.emit(sessionMessage());
    await settle();
    expect(host.ofType("renderer")).toEqual([]);
    await app.findAll('[data-testid="player-picker"] button')[0].trigger("click");
    await settle();
    const presentation = (epoch: number, state = "armed") => ({ state, presentationEpoch: epoch,
      presentationReady: true, presentationWidth: 1920, presentationHeight: 1080, restoreComplete: true });
    const hostView = (over: Record<string, unknown> = {}) => sessionMessage({ requestId: "session",
      renderStreamLan: undefined, renderStreamUnavailableReason: "no-capture", ...over });
    host.emit(hostView({ directView: true, requestId: host.ofType("join").at(-1)!.requestId,
      rendererState: presentation(7, "mirror") }));
    await settle();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(renderStreamContext).toMatchObject({ directView: true, hostSelfStream: true, seatJoined: true });
    expect(app.get('[data-testid="mirror-renderer"]').attributes("disabled")).toBeUndefined();
    host.sent.length = 0;
    await app.get('[data-testid="mirror-renderer"]').setValue(true);
    await settle();
    expect(host.ofType("renderer")).toEqual([{ type: "renderer", rendererProtocol: 2, renderer: "stream" }]);
    expect(host.ofType("watch").some(message => message.on === false)).toBe(false);
    const route = "/render-stream/" + "a".repeat(32);
    const renderStream = { ...descriptor, url: `${route}/ws`, resourceBase: route };
    host.emit(hostView({ rendererState: presentation(7), renderStream }));
    await settle();
    expect(renderStreamAvailability.value.reason).toBeNull();
    expect(renderStreamAvailability.value).toMatchObject({ available: true, source: "session" });
    expect(renderStreamContext.stopped).toBeNull();
    expect(fake.clients).toHaveLength(1);
    expect(fake.clients[0].options.endpoint).toMatchObject({ url: `ws://127.0.0.1:13337${route}/ws`,
      resourceBase: `http://127.0.0.1:13337${route}`, token: SEAT_TOKEN });
    expect(mirrorSettings.runtimeRenderer).toBe("stream");
    fail({ kind: "streaming", firstFrame: true });
    await settle();
    const stage = app.getComponent((await realStageImport()).default);
    expect(stage.props()).toMatchObject({ presentationEpoch: 7, inputEnabled: true });
    const oldSend = stage.props("sendInput")!;
    oldSend({ kind: "key", key: "KeyE", pressed: true, presentationEpoch: 7 });
    expect(host.ofType("input").at(-1)).toMatchObject({ presentationEpoch: 7 });
    host.sent.length = 0;
    host.emit(hostView({ rendererState: presentation(8), renderStream }));
    await settle();
    oldSend({ kind: "key", key: "KeyE", pressed: false, presentationEpoch: 7 });
    expect(host.ofType("input")).toEqual([]);
    expect(stage.props()).toMatchObject({ presentationEpoch: 8, inputEnabled: false });
    fail({ kind: "streaming", firstFrame: true });
    await settle();
    stage.props("sendInput")!({ kind: "key", key: "KeyE", pressed: true, presentationEpoch: 8 });
    expect(host.ofType("input").at(-1)).toMatchObject({ presentationEpoch: 8 });
    const beforeRevoke = stage.props("sendInput")!;
    host.sent.length = 0;
    host.emit(hostView({ hostAccess: { allowed: false, reason: "menu-open", generation: 1 } }));
    await settle();
    beforeRevoke({ kind: "key", key: "KeyE", pressed: false, presentationEpoch: 8 });
    expect(host.ofType("input")).toEqual([]);
    expect(host.ofType("watch").some(message => message.on === false)).toBe(false);
    host.emit(hostView({ hostAccess: { allowed: true, reason: "allowed", generation: 2 },
      rendererState: presentation(9), renderStream }));
    await settle();
    fail({ kind: "streaming", firstFrame: true });
    await settle();
    beforeRevoke({ kind: "key", key: "KeyE", pressed: false, presentationEpoch: 8 });
    expect(host.ofType("input")).toEqual([]);
    const resumedStage = app.getComponent((await realStageImport()).default);
    resumedStage.props("sendInput")!({ kind: "key", key: "KeyE", pressed: true, presentationEpoch: 9 });
    expect(host.ofType("input").at(-1)).toMatchObject({ presentationEpoch: 9 });
    await app.get('[data-testid="mirror-renderer"]').setValue(false);
    await settle();
    expect(host.ofType("renderer")).toEqual([{ type: "renderer", rendererProtocol: 2, renderer: "mirror" }]);
    expect(mirrorSettings.runtimeRenderer).toBe("mirror");
    expect(app.find('[data-testid="mirror-stream-shell"]').exists()).toBe(false);
    host.emit(hostView({ rendererState: presentation(10, "mirror"),
      hostAccess: { allowed: true, reason: "allowed", generation: 2 } }));
    await settle();
    expect(renderStreamContext.returningToMirror).toBe(false);
  });

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

    it("rides the renderer request with Widescreen stretch on", async () => {
      canStream();
      mirrorSettings.renderer = "stream";
      mirrorSettings.stretchEnabled = true;
      const seat = await joinSeat();
      expect(seat.ofType("renderer")[0].aspect).toBeCloseTo(2340 / 1080, 10);
    });

    it("is absent with Widescreen stretch off", async () => {
      canStream();
      mirrorSettings.renderer = "stream";
      const seat = await joinSeat();
      expect(seat.ofType("renderer")[0]).toEqual({ type: "renderer", rendererProtocol: 2, renderer: "stream" });
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
    expect(fake.clients[0].options.endpoint).toMatchObject({ url: descriptor.url, token: SEAT_TOKEN, protocol: 16 });
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

  it("requests each saved-choice change on the joined seat socket", async () => {
    const { host, seat } = await joinNormalSeat();
    expect(renderStreamContext.seatJoined).toBe(true);
    expect(seat.ofType("renderer")).toEqual([{ type: "renderer", rendererProtocol: 2, renderer: "mirror" }]);
    seat.sent.length = 0;
    mirrorSettings.renderer = "stream";
    await settle();
    expect(seat.ofType("renderer")).toEqual([{ type: "renderer", rendererProtocol: 2, renderer: "stream" }]);
    expect(host.ofType("join")).toHaveLength(1);
    expect(seat.ofType("join")).toHaveLength(0);
    expect(mirrorSettings.runtimeRenderer).toBe("mirror");
    expect(renderStreamAvailability.value.reason).toBe("not-streaming");
    expect(host.ofType("renderer")).toEqual([]);
    mirrorSettings.renderer = "mirror";
    await settle();
    expect(seat.ofType("renderer")).toEqual([
      { type: "renderer", rendererProtocol: 2, renderer: "stream" }, { type: "renderer", rendererProtocol: 2, renderer: "mirror" }
    ]);
  });

  it("ignores a shared seat descriptor when the saved choice is off", async () => {
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
    expect(mirrorSettings.runtimeRenderer).toBe("mirror");
    expect(fake.clients).toHaveLength(0);
    expect(app!.find('[data-testid="render-stream-stage"]').exists()).toBe(false);
    expect(latest().ofType("watch")).not.toContainEqual({ type: "watch", on: false });
  });

  it.each([true, false])("carries a host refusal into settings and suppresses saved stream requests (loopback=%s)", async (loopback) => {
    canStream();
    renderStreamContext.pageLoopback = loopback;
    mirrorSettings.renderer = "stream";
    mirrorSettings.panelOpen = true;
    app = mount(MirrorApp);
    await settle();
    const host = latest();
    const refusal = { renderStreamUnavailableReason: "no-matching-record" };
    host.emit(sessionMessage(refusal));
    await settle();
    expect(app!.get('[data-testid="mirror-renderer"]').attributes("disabled")).toBeDefined();
    expect(app!.get('[data-testid="mirror-renderer-reason"]').text())
      .toBe("The new renderer doesn't support this game version yet.");
    await app!.findAll('[data-testid="player-picker"] button')[1].trigger("click");
    await settle();
    host.emit(sessionMessage({ headlessMirrorPort: 14000, ...refusal }));
    await settle();
    const seat = latest();
    seat.emit(seatSession());
    await settle();
    expect(renderStreamContext.hostUnavailableReason).toBe("no-matching-record");
    expect(seat.ofType("renderer")).not.toContainEqual({ type: "renderer", rendererProtocol: 2, renderer: "stream" });
    expect(fake.clients).toHaveLength(0);
  });

  // A LAN page reads the host's offer from its pre-join sessions, and asks its seat for the stream only
  // when one of the offered carriers works on this page.
  async function joinFromLanPage(page: { https: boolean; secureContext: boolean; webTransport: boolean },
    offer: Record<string, boolean> | null): Promise<MockWebSocket> {
    canStream();
    Object.assign(renderStreamContext, { pageLoopback: false, page });
    mirrorSettings.renderer = "stream";
    app = mount(MirrorApp);
    await settle();
    const host = latest();
    host.emit(sessionMessage({ renderStreamLan: offer }));
    await settle();
    await app.findAll('[data-testid="player-picker"] button')[1].trigger("click");
    await settle();
    expect(host.ofType("renderer")).toEqual([]);
    host.emit(sessionMessage({ headlessMirrorPort: 14000, renderStreamLan: offer }));
    await settle();
    const seat = latest();
    seat.emit(seatSession());
    await settle();
    return seat;
  }

  it("on an https LAN page, reads the host's offer before the join and asks its seat for the stream", async () => {
    globalThis.__couchCoopHostBase = "https://relay.example";
    const seat = await joinFromLanPage({ https: true, secureContext: true, webTransport: true },
      { relay: true, webTransport: true, tls: true, ws: true });
    expect(renderStreamContext.lanOffer).toEqual({ relay: true, webTransport: true, tls: true, ws: true });
    expect(seat.ofType("renderer")).toEqual([{ type: "renderer", rendererProtocol: 2, renderer: "stream" }]);
  });

  it("on a LAN page of a host with no capture (no offer), asks for no streaming seat", async () => {
    const seat = await joinFromLanPage({ https: true, secureContext: true, webTransport: true }, null);
    expect(renderStreamContext.lanOffer).toBeNull();
    expect(seat.ofType("renderer")).toEqual([{ type: "renderer", rendererProtocol: 2, renderer: "mirror" }]);
  });

  it("on a plain-http LAN page, asks for the stream over the seat's plain ws (CAR9)", async () => {
    const seat = await joinFromLanPage({ https: false, secureContext: false, webTransport: false },
      { relay: true, webTransport: true, tls: false, ws: true });
    expect(seat.ofType("renderer")).toEqual([{ type: "renderer", rendererProtocol: 2, renderer: "stream" }]);
  });

  it("on an https LAN page with no carrier it can open, says needs-proxy and asks for nothing", async () => {
    const seat = await joinFromLanPage({ https: true, secureContext: true, webTransport: false },
      { relay: true, webTransport: true, tls: false, ws: true });
    expect(renderStreamAvailability.value.reason).toBe("needs-proxy");
    expect(seat.ofType("renderer")).toEqual([{ type: "renderer", rendererProtocol: 2, renderer: "mirror" }]);
  });

  it("falls back when the seat unexpectedly withdraws the descriptor with state mirror", async () => {
    const seat = await joinStreamingSeat();
    seat.emit(seatSession());
    await settle();
    expect(renderStreamContext.stopped).toBe("descriptor gone");
    expect(mirrorSettings.runtimeRenderer).toBe("mirror");
    expect(mirrorSettings.renderer).toBe("stream");
    expect(fake.clients[0].disposed).toBe(true);
    expect(seat.ofType("watch").at(-1)).toEqual({ type: "watch", on: true });
  });

  it("still reports an unexplained withdrawal", async () => {
    const seat = await joinStreamingSeat();
    seat.emit(seatSession({ rendererState: undefined }));
    await settle();
    expect(renderStreamContext.stopped).toBe("descriptor gone");
    expect(mirrorSettings.runtimeRenderer).toBe("mirror");
  });

  it("ignores a shared seat's failure and retry when this page chose mirror", async () => {
    canStream();
    const seat = await joinSeat({ renderStream: descriptor, rendererState: { state: "armed" } });
    expect(fake.clients).toHaveLength(0);
    seat.emit(seatSession({ rendererState: { state: "failed", reason: "capture stopped" } }));
    mirrorSettings.panelOpen = true;
    await settle();
    expect(renderStreamContext.stopped).toBeNull();
    expect(app!.find('[data-testid="mirror-renderer-stopped"]').exists()).toBe(false);
    retryRenderStream();
    await settle();
    expect(mirrorSettings.renderer).toBe("mirror");
    expect(seat.ofType("renderer")).toEqual([{ type: "renderer", rendererProtocol: 2, renderer: "mirror" }]);
    expect(seat.ofType("watch")).not.toContainEqual({ type: "watch", on: false });
  });

  it.each(["capture unavailable", undefined])("reports a failed arm (%s) and Try again re-sends the request", async (reason) => {
    canStream();
    mirrorSettings.renderer = "stream";
    const seat = await joinSeat();
    seat.emit(seatSession({ rendererState: { state: "arming" } }));
    await settle();
    expect(renderStreamContext.rendererState?.state).toBe("arming");
    seat.emit(seatSession({ rendererState: { state: "failed", ...(reason ? { reason } : {}) } }));
    await settle();
    mirrorSettings.panelOpen = true;
    await settle();
    expect(renderStreamContext.stopped).toBe(reason ?? "Could not start the new renderer.");
    expect(app!.get('[data-testid="mirror-renderer-stopped"]').text()).toContain(reason ?? "Could not start the new renderer.");
    expect(mirrorSettings.runtimeRenderer).toBe("mirror");
    await app!.get('[data-testid="mirror-renderer-stopped"] button').trigger("click");
    await settle();
    expect(renderStreamContext.stopped).toBeNull();
    expect(seat.ofType("renderer")).toEqual([
      { type: "renderer", rendererProtocol: 2, renderer: "stream" },
      { type: "renderer", rendererProtocol: 2, renderer: "mirror" },
      { type: "renderer", rendererProtocol: 2, renderer: "stream" }
    ]);
    mirrorSettings.panelOpen = false;
  });

});

// A reconnected seat socket applies the saved choice again, independently of the retired connection.
describe("MirrorApp — the new-renderer checkbox after a re-join", () => {
  const descriptor = { url: "ws://127.0.0.1:13366/render-stream", resourceBase: "http://127.0.0.1:13366",
    token: "e".repeat(64), protocol: 16, presentation: [1920, 1080] };
  const seatSession = (over: Record<string, unknown> = {}) => sessionMessage({
    session: { joined: true, name: "Alice", status: "assigned", playerId: "p:1003", connectionCount: 1 },
    ...HEADLESS_FREEZES, rendererState: { state: over.renderStream ? "armed" : "mirror" }, ...over
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

  it.each([
    "res://scenes/screens/char_select/char_select_bg_ironclad.tscn",
    "res://scenes/backgrounds/underdocks/underdocks_background.tscn"
  ])("retracts mirror watch on a fresh seat after rejoining with static background: %s", async (scenePath) => {
    Object.assign(mirrorSettings, { renderer: "stream", streamStaticBg: true });
    const host = await pickAlice();
    host.emit(sessionMessage({ headlessMirrorPort: 14000 }));
    await settle();
    const seat = latest();
    seat.emit(seatSession({ renderStream: descriptor }));
    await settle();
    fail({ kind: "streaming", firstFrame: true });
    await settle();
    expect(seat.ofType("watch")).toEqual([{ type: "watch", on: false }]);

    seat.close();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await settle();
    const rejoined = latest();
    rejoined.emit(sessionMessage());
    await settle();
    rejoined.emit(sessionMessage({ headlessMirrorPort: 14001 }));
    await settle();
    const replacement = latest();
    expect(new URL(replacement.url).searchParams.get("watch")).toBe("1");
    replacement.emit(seatSession());
    await settle();
    const staticBackground = { scenePath, id: "fresh-background", url: "/bg/fresh-background?v=1" };
    replacement.emit(seatSession({ renderStream: descriptor, staticBackground }));
    await settle();
    fail({ kind: "streaming", firstFrame: true });
    await settle();

    expect(replacement.ofType("settings")).toContainEqual(expect.objectContaining({ streamStaticBg: true }));
    // A lingering mirror watch vetoes the shared capture's background hide, even on this same socket.
    expect(replacement.ofType("watch")).toEqual([{ type: "watch", on: false }]);
    mirrorSettings.streamStaticBg = false;
    await settle();
    mirrorSettings.streamStaticBg = true;
    replacement.emit(seatSession({ renderStream: descriptor, staticBackground: { ...staticBackground, id: "next-pick" } }));
    await settle();
    expect(replacement.ofType("watch")).toEqual([{ type: "watch", on: false }]);
    expect(replacement.ofType("settings").at(-1)).toMatchObject({ streamStaticBg: true });
  });

  it.each(["mirror", "arming", "armed"])("applies the saved choice again after reconnecting to a reused %s seat", async (state) => {
    mirrorSettings.renderer = "stream";
    const host = await pickAlice();
    host.emit(sessionMessage({ headlessMirrorPort: 14000 }));
    await settle();
    const seat = latest();
    const pageId = new URL(seat.url).searchParams.get("rendererPage");
    expect(pageId).toMatch(/^[0-9a-f]{32}$/);
    expect(new URL(host.url).searchParams.has("rendererPage")).toBe(false);
    const presentation = { presentationEpoch: 9, presentationReady: true,
      presentationWidth: 1920, presentationHeight: 1080, restoreComplete: true };
    seat.emit(seatSession({ renderStream: descriptor, rendererState: { ...presentation, state: "armed" } }));
    await settle();
    expect(renderStreamContext.seatJoined).toBe(true);

    expect(seat.ofType("renderer")).toEqual([{ type: "renderer", rendererProtocol: 2, renderer: "stream" }]);

    expect(fake.clients).toHaveLength(1);
    fail({ kind: "streaming", firstFrame: true });
    await settle();

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
    expect(new URL(latest().url).searchParams.get("rendererPage")).toBe(pageId);
    expect(new URL(rejoined.url).searchParams.has("rendererPage")).toBe(false);
    const replacement = latest();
    const rendererState = { ...presentation, presentationEpoch: 10, state };
    replacement.emit(seatSession({ rendererState }));
    await settle();
    expect(renderStreamContext.seatJoined).toBe(true);

    expect(latest().ofType("renderer")).toEqual([{ type: "renderer", rendererProtocol: 2, renderer: "stream" }]);
    for (let duplicate = 0; duplicate < 2; duplicate += 1) {
      replacement.emit(seatSession({ rendererState }));
      await settle();
    }
    expect(replacement.ofType("renderer")).toHaveLength(1);
    expect(renderStreamContext.stopped).toBeNull();
    expect(rejoined.ofType("renderer")).toEqual([]);
    expect(mirrorSettings.runtimeRenderer).toBe("mirror");
    replacement.emit(seatSession({ renderStream: descriptor, rendererState: { ...rendererState, state: "armed" } }));
    await settle();
    expect(mirrorSettings.runtimeRenderer).toBe("stream");
    expect(renderStreamContext.stopped).toBeNull();
    replacement.emit(seatSession({ rendererState: { ...rendererState, state: "armed" } }));
    await settle();
    replacement.emit(seatSession({ rendererState: { ...rendererState, state: "armed" } }));
    await settle();
    expect(renderStreamContext.stopped).toBe("descriptor gone");
    expect(replacement.ofType("renderer").map(m => m.renderer)).toEqual(["stream", "mirror"]);
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
    // This viewer registers each explicit choice on the shared seat.
    expect(latest().ofType("renderer")).toEqual([
      { type: "renderer", rendererProtocol: 2, renderer: "mirror" },
      { type: "renderer", rendererProtocol: 2, renderer: "stream" }
    ]);
    expect(mirrorSettings.runtimeRenderer).toBe("stream");
    expect(fake.clients).toHaveLength(1);
  });
});

describe("MirrorApp — switching renderers with a mirror on screen", () => {
  const descriptor = { url: "ws://127.0.0.1:13366/render-stream", resourceBase: "http://127.0.0.1:13366",
    token: "a".repeat(64), protocol: 16, presentation: [1920, 1080] };
  const seatSession = (over: Record<string, unknown> = {}) => sessionMessage({
    session: { joined: true, name: "Alice", status: "assigned", playerId: "p:1003", connectionCount: 1 },
    ...HEADLESS_FREEZES, rendererState: { state: "armed" }, renderStream: descriptor, ...over
  });
  const sceneDelta = {
    type: "scene-delta", full: true, screenType: "run", screenInstanceId: "run:1",
    upserts: [{ id: "root", name: "Root", nodeType: "Control", visible: true }],
    removedIds: [], orderedIds: ["root"]
  };
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function showMirror(): Promise<MockWebSocket> {
    Object.assign(renderStreamContext, { coreProblem: null, webgl2: true, pageLoopback: true, stopped: null,
      coreLoadFailed: false });
    const seat = await joinSeat();
    seat.emit(sceneDelta);
    await settle();
    expect(app!.findComponent(MirrorView).exists()).toBe(true);
    expect(new URL(seat.url).searchParams.get("watch")).not.toBe("0");
    mirrorSettings.panelOpen = true;
    await settle();
    seat.sent.length = 0;
    return seat;
  }

  async function startStream(seat: MockWebSocket): Promise<void> {
    await app!.get('[data-testid="mirror-renderer"]').setValue(true);
    await settle();
    expect(seat.ofType("renderer")).toEqual([{ type: "renderer", rendererProtocol: 2, renderer: "stream" }]);
    seat.emit(seatSession({ renderStream: null, rendererState: { state: "arming" } }));
    await settle();
    expect(app!.get('[data-testid="mirror-renderer-reason"]').text()).toBe("Switching…");
    expect(app!.findComponent(MirrorView).exists()).toBe(true);
    seat.emit(seatSession());
    await settle();
  }

  it.each(["switch", "failed", "ended"] as const)("suspends only after the stream draws and restores on %s", async (ending) => {
    const seat = await showMirror();
    expect(app!.getComponent(MirrorView).props("contextSuspended")).toBe(false);
    await startStream(seat);
    const view = app!.getComponent(MirrorView);
    expect(view.props("contextSuspended")).toBe(false);
    fail({ kind: "streaming", firstFrame: false });
    await settle();
    expect(view.props("contextSuspended")).toBe(false);
    fail({ kind: "streaming", firstFrame: true });
    await settle();
    expect(view.props("contextSuspended")).toBe(true);
    expect(app!.get('[data-testid="mirror-scene-shell"]').classes()).toContain("mirror-scene-hidden");
    fail({ kind: "streaming", firstFrame: true });
    await settle();
    expect(view.props("contextSuspended")).toBe(true);
    if (ending === "switch") await app!.get('[data-testid="mirror-renderer"]').setValue(false);
    else if (ending === "failed") fail({ kind: "failed", reason: "connection", detail: "test disconnect" });
    else fail({ kind: "ended" });
    await settle();
    expect(app!.getComponent(MirrorView).props("contextSuspended")).toBe(false);
    expect(app!.get('[data-testid="mirror-scene-shell"]').classes()).not.toContain("mirror-scene-hidden");
  });

  it("requires an explicit displayed epoch on QA input and waits for the matching FULL", async () => {
    const seat = await showMirror();
    const presentation = (epoch: number) => ({ state: "mirror", presentationEpoch: epoch,
      presentationReady: true, presentationWidth: 1920, presentationHeight: 1080 });
    seat.emit(seatSession({ renderStream: null, rendererState: presentation(1) }));
    seat.emit({ ...sceneDelta, presentationEpoch: 1 });
    await settle();
    const send = (window as unknown as { __mirrorSendInput: (msg: import("@/mirror/mirrorClient").MirrorInputMessage) => void }).__mirrorSendInput;
    const input = { kind: "click" as const, coordX: 100, coordY: 200, pressed: true };
    send(input);
    expect(seat.ofType("input")).toEqual([]);
    send({ ...input, presentationEpoch: 1 });
    expect(seat.ofType("input")).toEqual([expect.objectContaining({ type: "input", ...input, presentationEpoch: 1 })]);
    seat.sent.length = 0;

    seat.emit(seatSession({ renderStream: null, rendererState: presentation(2) }));
    await settle();
    send({ ...input, presentationEpoch: 2 });
    expect(seat.ofType("input")).toEqual([]);
    seat.emit({ ...sceneDelta, presentationEpoch: 2 });
    await settle();
    send({ ...input, presentationEpoch: 1 });
    send(input);
    expect(seat.ofType("input")).toEqual([]);
    send({ ...input, presentationEpoch: 2 });
    expect(seat.ofType("input")).toEqual([expect.objectContaining({ type: "input", ...input, presentationEpoch: 2 })]);
  });

  it("stamps map and scroll actions with the displayed FULL epoch and retires old senders", async () => {
    const seat = await showMirror();
    const presentation = (epoch: number, ready = true) => ({ state: "mirror", presentationEpoch: epoch,
      presentationReady: ready, presentationWidth: 1920, presentationHeight: 1080 });
    const senders = () => app!.getComponent(MirrorView).props();
    const map = { semanticActionId: "select-map-node", args: { elementId: "42" } };
    seat.emit(seatSession({ renderStream: null, rendererState: presentation(1) }));
    seat.emit({ ...sceneDelta, presentationEpoch: 1 });
    await settle();
    const old = { ...senders() };
    old.sendAction!(map);
    expect(old.sendScroll!("scroll", -100)).toBe("action:2");
    expect(seat.ofType("action")).toEqual([
      { type: "action", requestId: "action:1", ...map, presentationEpoch: 1 },
      { type: "action", requestId: "action:2", semanticActionId: "set-scroll-offset",
        args: { elementId: "scroll", offsetY: -100 }, presentationEpoch: 1 }
    ]);
    seat.sent.length = 0;
    seat.emit(seatSession({ renderStream: null, rendererState: presentation(2, false) }));
    await settle();
    old.sendAction!(map);
    expect(old.sendScroll!("scroll", -200)).toBeNull();
    senders().sendAction!(map);
    expect(senders().sendScroll!("scroll", -200)).toBeNull();
    seat.emit(seatSession({ renderStream: null, rendererState: presentation(2) }));
    await settle();
    senders().sendAction!(map);
    expect(senders().sendScroll!("scroll", -200)).toBeNull();
    seat.emit({ ...sceneDelta, presentationEpoch: 1 });
    seat.emit({ ...sceneDelta, presentationEpoch: 2, full: false });
    await settle();
    senders().sendAction!(map);
    expect(seat.ofType("action")).toEqual([]);
    seat.emit({ ...sceneDelta, presentationEpoch: 2 });
    await settle();
    old.sendAction!(map);
    expect(old.sendScroll!("scroll", -200)).toBeNull();
    senders().sendAction!({ ...map, presentationEpoch: 1 });
    expect(seat.ofType("action")).toEqual([]);
    senders().sendAction!(map);
    expect(senders().sendScroll!("scroll", -200)).toBe("action:4");
    expect(seat.ofType("action").map(m => m.presentationEpoch)).toEqual([2, 2]);
    seat.sent.length = 0;
    mirrorSettings.renderer = "stream";
    await settle();
    senders().sendAction!(map);
    expect(senders().sendScroll!("scroll", -300)).toBeNull();
    expect(seat.ofType("action")).toEqual([]);
  });

  it("holds QA input until the stream has drawn its presentation", async () => {
    const seat = await showMirror();
    await app!.get('[data-testid="mirror-renderer"]').setValue(true);
    seat.emit(seatSession({ rendererState: { state: "armed", presentationEpoch: 2,
      presentationReady: true, presentationWidth: 1920, presentationHeight: 1080 } }));
    await settle();
    const send = (window as unknown as { __mirrorSendInput: (msg: import("@/mirror/mirrorClient").MirrorInputMessage) => void }).__mirrorSendInput;
    const input = { kind: "click" as const, coordX: 100, coordY: 200, presentationEpoch: 2 };
    send(input);
    expect(seat.ofType("input")).toEqual([]);
    fail({ kind: "streaming", firstFrame: true });
    await settle();
    send(input);
    expect(seat.ofType("input")).toEqual([expect.objectContaining({ type: "input", ...input })]);
  });

  it("holds scene and input admission through a wide stream and a ready 1920 return", async () => {
    const seat = await showMirror();
    const presentation = (epoch: number, ready: boolean, width: number) => ({
      state: "armed", presentationEpoch: epoch, presentationReady: ready,
      presentationWidth: width, presentationHeight: 1080
    });
    seat.emit(seatSession({ renderStream: null, rendererState: presentation(1, true, 1920) }));
    await settle();
    seat.emit({ ...sceneDelta, presentationEpoch: 1 });
    await settle();
    const view = app!.getComponent(MirrorView);
    const retainedState = view.props("state");
    const revision = retainedState.revision;
    const oldSend = view.props("sendInput")!;
    oldSend({ kind: "key", key: "KeyE", pressed: true });
    expect(seat.ofType("input").at(-1)).toMatchObject({ presentationEpoch: 1 });
    seat.sent.length = 0;

    // A FULL delivered synchronously by the request must already be fenced, before Vue renders the hold.
    const send = seat.send.bind(seat);
    const spy = vi.spyOn(seat, "send").mockImplementation((data: string) => {
      if (JSON.parse(data).type === "renderer" && JSON.parse(data).renderer === "stream") {
        seat.emit({ ...sceneDelta, presentationEpoch: 1 });
        oldSend({ kind: "key", key: "KeyE", pressed: false });
        expect(retainedState.revision).toBe(revision);
      }
      send(data);
    });
    await app!.get('[data-testid="mirror-renderer"]').setValue(true);
    spy.mockRestore();
    expect(view.props("sceneReady")).toBe(false);
    expect(seat.ofType("watch")).toEqual([{ type: "watch", on: false }]);
    expect(seat.ofType("input")).toEqual([]);
    seat.emit(seatSession({ renderStream: null, rendererState: presentation(2, false, 2340) }));
    seat.emit({ ...sceneDelta, presentationEpoch: 2 });
    await settle();
    expect(retainedState.revision).toBe(revision);
    expect(app!.getComponent(MirrorView).element).toBe(view.element);
    seat.emit(seatSession({ renderStream: { ...descriptor, presentation: [2340, 1080] },
      rendererState: presentation(2, true, 2340) }));
    await settle();
    expect(renderStreamContext.stopped).toBeNull();
    fail({ kind: "streaming", firstFrame: true });
    await settle();
    const stage = app!.getComponent((await realStageImport()).default);
    expect(app!.getComponent(MirrorView).element).toBe(view.element);
    expect(app!.get('[data-testid="mirror-scene-shell"]').classes()).toContain("mirror-scene-hidden");
    const streamSend = stage.props("sendInput")!;
    streamSend({ kind: "key", key: "KeyE", pressed: true });
    expect(seat.ofType("input").at(-1)).toMatchObject({ presentationEpoch: 2 });
    seat.sent.length = 0;

    await app!.get('[data-testid="mirror-renderer"]').setValue(false);
    expect(seat.ofType("renderer")).toEqual([{ type: "renderer", rendererProtocol: 2, renderer: "mirror" }]);
    expect(seat.ofType("watch")).toEqual([{ type: "watch", on: true }]);
    streamSend({ kind: "key", key: "KeyE", pressed: false });
    seat.emit(seatSession({ renderStream: null, rendererState: presentation(3, false, 1920) }));
    seat.emit({ ...sceneDelta, presentationEpoch: 3 });
    await settle();
    expect(app!.getComponent(MirrorView).props("sceneReady")).toBe(false);
    expect(retainedState.revision).toBe(revision);
    seat.emit(seatSession({ renderStream: null, rendererState: presentation(3, true, 1920) }));
    await settle();
    for (const frame of [{ ...sceneDelta, presentationEpoch: 1 },
      { ...sceneDelta, presentationEpoch: 3, full: false }]) seat.emit(frame);
    await settle();
    expect(app!.getComponent(MirrorView).props("sceneReady")).toBe(false);
    expect(seat.ofType("input")).toEqual([]);
    seat.emit({ ...sceneDelta, presentationEpoch: 3 });
    await settle();
    const restored = app!.getComponent(MirrorView);
    expect(restored.element).toBe(view.element);
    expect(app!.get('[data-testid="mirror-scene-shell"]').classes()).not.toContain("mirror-scene-hidden");
    expect(app!.get('[data-testid="mirror-scene-shell"]').attributes("inert")).toBeUndefined();
    expect(restored.props("sceneReady")).toBe(true);
    oldSend({ kind: "key", key: "KeyE", pressed: false });
    expect(seat.ofType("input")).toEqual([]);
    restored.props("sendInput")!({ kind: "key", key: "KeyE", pressed: true });
    expect(seat.ofType("input").at(-1)).toMatchObject({ presentationEpoch: 3 });
  });

  it.each(["arming", "disarming", "armed"])("does not fail a deliberate %s presentation rearm", async (state) => {
    const seat = await showMirror();
    await startStream(seat);
    fail({ kind: "streaming", firstFrame: true });
    await settle();
    const old = fake.clients[0];
    seat.emit(seatSession({ renderStream: null, rendererState: { state, presentationEpoch: 2,
      presentationReady: false, presentationWidth: 2340, presentationHeight: 1080 } }));
    await settle();
    old.options.onStatus?.({ kind: "ended" });
    expect(renderStreamContext.stopped).toBeNull();
    expect(app!.getComponent(MirrorView).props("sceneReady")).toBe(false);
    seat.emit(seatSession({ renderStream: { ...descriptor, presentation: [2340, 1080] },
      rendererState: { state: "armed", presentationEpoch: 2, presentationReady: true,
        presentationWidth: 2340, presentationHeight: 1080 } }));
    await settle();
    expect(fake.clients).toHaveLength(2);
    expect(app!.get('[data-testid="mirror-stream-shell"]').classes()).toContain("mirror-stream-pending");
    fail({ kind: "streaming", firstFrame: true });
    await settle();
    expect(renderStreamContext.firstFrame).toBe(true);
    expect(renderStreamContext.stopped).toBeNull();
    expect(seat.ofType("renderer").map(m => m.renderer)).toEqual(["stream"]);
  });

  it.each([false, true])("falls back once when a ready armed seat loses its descriptor after rearm=%s", async (rearm) => {
    const seat = await showMirror();
    await startStream(seat);
    fail({ kind: "streaming", firstFrame: true });
    await settle();
    const rendererState = { state: "armed", presentationEpoch: 2, presentationReady: true,
      presentationWidth: 2340, presentationHeight: 1080 };
    seat.sent.length = 0;
    if (rearm) {
      seat.emit(seatSession({ renderStream: null, rendererState: { ...rendererState, presentationReady: false } }));
      await settle();
      expect(renderStreamContext.stopped).toBeNull();
      expect(seat.ofType("renderer")).toEqual([]);
    }
    seat.emit(seatSession({ renderStream: null, rendererState }));
    await settle();
    seat.emit(seatSession({ renderStream: null, rendererState }));
    await settle();
    expect(renderStreamContext.stopped).toBe("descriptor gone");
    expect(mirrorSettings.renderer).toBe("stream");
    expect(mirrorSettings.runtimeRenderer).toBe("mirror");
    expect(seat.ofType("renderer")).toEqual([{ type: "renderer", rendererProtocol: 2, renderer: "mirror" }]);
    expect(seat.ofType("watch")).toEqual([{ type: "watch", on: true }]);
    expect(app!.getComponent(MirrorView).props("sceneReady")).toBe(false);
  });

  it.each([404, 410, 503])("keeps the stream and input alive after a resource GET returns %i", async (httpStatus) => {
    const seat = await showMirror();
    let lifecycle!: ReturnType<typeof resourceLifecycleClient>;
    fake.clientFactory = (options) => {
      lifecycle = resourceLifecycleClient(options);
      return lifecycle.client;
    };
    await startStream(seat);
    lifecycle.open();
    lifecycle.transaction(1, ["missing", "available"]);
    lifecycle.frame();
    await settle();
    expect(renderStreamContext.firstFrame).toBe(true);
    const stage = app!.getComponent((await realStageImport()).default);
    const canvas = stage.get("canvas").element;
    seat.sent.length = 0;

    lifecycle.complete("missing", httpStatus);
    lifecycle.complete("available", 200);
    await settle();
    if (httpStatus === 503) {
      // Temporary failures settle unavailable only after three retries at bounded backoff.
      for (const [attempt, delay] of [250, 500, 1000].entries()) {
        const failedAt = lifecycle.now;
        lifecycle.frameAt(failedAt + delay - 1);
        expect(lifecycle.transport.gets.filter((get) => get.path.endsWith("missing"))).toHaveLength(attempt + 1);
        expect(lifecycle.client.stats().resources).toMatchObject({ unavailable: 0, found: 0, temporary: 0 });
        lifecycle.frameAt(failedAt + delay);
        expect(lifecycle.transport.gets.filter((get) => get.path.endsWith("missing"))).toHaveLength(attempt + 2);
        lifecycle.complete("missing", httpStatus, attempt + 1);
        await settle();
      }
    }
    lifecycle.frame();
    lifecycle.transaction(2, []);
    lifecycle.frame();
    await settle();

    expect(app!.getComponent((await realStageImport()).default).get("canvas").element).toBe(canvas);
    expect(app!.getComponent(MirrorView).props("sceneReady")).toBe(false);
    expect(app!.get('[data-testid="mirror-scene-shell"]').classes()).toContain("mirror-scene-hidden");
    expect(mirrorSettings.runtimeRenderer).toBe("stream");
    expect(renderStreamContext.stopped).toBeNull();
    expect(fake.clients).toHaveLength(1);
    expect(fake.clients[0].disposed).toBe(false);
    expect(lifecycle.transport.closed).toBeNull();
    expect(lifecycle.calls).toContain("stage available");
    expect(lifecycle.calls).toContain("apply 2");
    expect(lifecycle.transport.acks()).toContain("applied 2");
    expect(lifecycle.client.stats().resources).toMatchObject({
      unavailable: 1, found: 1,
      missing: httpStatus === 503 ? 0 : 1,
      temporary: httpStatus === 503 ? 1 : 0,
      recent: [expect.objectContaining({ hash: "missing", kind: 0, seq: 1, status: httpStatus, count: 1 })]
    });
    // Missing payloads and exhausted temporary retries stay suppressed while the core names them.
    lifecycle.transaction(3, ["missing"]);
    lifecycle.frame();
    if (httpStatus === 503) lifecycle.frameAt(lifecycle.now + 10000);
    await settle();
    expect(lifecycle.transport.gets.filter((get) => get.path.endsWith("missing")))
      .toHaveLength(httpStatus === 503 ? 4 : 1);
    expect(lifecycle.client.stats().resources?.recent).toHaveLength(1);
    expect(lifecycle.transport.acks()).toContain("applied 3");
    expect(seat.ofType("renderer")).toEqual([]);
    expect(seat.ofType("watch")).toEqual([]);
    expect(stage.props("inputEnabled")).toBe(true);
    for (const [type, buttons] of [["pointerdown", 1], ["pointerup", 0]] as const) {
      const event = new MouseEvent(type, { bubbles: true, clientX: 10, clientY: 20, buttons });
      Object.defineProperties(event, { pointerType: { value: "mouse" }, pointerId: { value: 1 } });
      canvas.dispatchEvent(event);
    }
    expect(seat.ofType("input")).toHaveLength(2);
  });

  it.each(["arming", "armed", "failed"] as const)("keeps a saved-mirror page mounted and watching while a shared seat is %s", async (state) => {
    const seat = await showMirror();
    const mirror = app!.getComponent(MirrorView).element;
    seat.emit(seatSession({ rendererState: { state, ...(state === "failed" ? { reason: "capture stopped" } : {}) } }));
    await settle();
    expect(mirrorSettings.runtimeRenderer).toBe("mirror");
    expect(app!.getComponent(MirrorView).element).toBe(mirror);
    expect(app!.find('[data-testid="render-stream-stage"]').exists()).toBe(false);
    expect(fake.clients).toHaveLength(0);
    expect(seat.ofType("watch")).not.toContainEqual({ type: "watch", on: false });
    expect(seat.ofType("renderer")).toEqual([]);
    expect(renderStreamContext.stopped).toBeNull();
    expect(app!.find('[data-testid="mirror-renderer-reason"]').exists()).toBe(false);
    expect(app!.find('[data-testid="mirror-renderer-stopped"]').exists()).toBe(false);
  });

  it("shows the stage loading overlay when a streaming join has not mounted a mirror yet", async () => {
    Object.assign(renderStreamContext, { coreProblem: null, webgl2: true, pageLoopback: true, coreLoadFailed: false });
    mirrorSettings.renderer = "stream";
    const seat = await joinSeat();
    // Both messages arrive before Vue's next render. Having scene data is not the same as having a view on screen.
    seat.emit(seatSession());
    seat.emit(sceneDelta);
    await settle();
    expect(app!.findComponent(MirrorView).exists()).toBe(false);
    expect(app!.get('[data-testid="mirror-stream-shell"]').classes()).not.toContain("mirror-stream-pending");
    expect(app!.get('[data-testid="render-stream-status"]').text()).toBe("Connecting…");
  });

  it("holds the same mirror geometry without mirror demand until the hidden stage draws its first frame", async () => {
    const seat = await showMirror();
    const mirror = app!.getComponent(MirrorView).element;
    await startStream(seat);
    const shell = () => app!.get('[data-testid="mirror-stream-shell"]');
    expect(shell().classes()).toContain("mirror-stream-pending");
    expect(shell().attributes("aria-hidden")).toBe("true");
    expect(app!.find('[data-testid="render-stream-stage"]').exists()).toBe(true);
    expect(app!.getComponent(MirrorView).element).toBe(mirror);
    expect(seat.ofType("watch")).toEqual([{ type: "watch", on: false }]);
    expect(fake.clients).toHaveLength(1);
    fail({ kind: "streaming", firstFrame: false });
    await settle();
    expect(app!.getComponent(MirrorView).element).toBe(mirror);
    expect(shell().classes()).toContain("mirror-stream-pending");
    expect(seat.ofType("watch")).toEqual([{ type: "watch", on: false }]);

    fail({ kind: "streaming", firstFrame: true });
    await settle();
    expect(shell().classes()).not.toContain("mirror-stream-pending");
    expect(shell().attributes("aria-hidden")).toBeUndefined();
    expect(app!.getComponent(MirrorView).element).toBe(mirror);
    expect(app!.getComponent(MirrorView).props("sceneReady")).toBe(false);
    expect(app!.get('[data-testid="mirror-scene-shell"]').classes()).toContain("mirror-scene-hidden");
    expect(app!.get('[data-testid="mirror-scene-shell"]').attributes("aria-hidden")).toBe("true");
    expect(app!.get('[data-testid="mirror-scene-shell"]').attributes("inert")).toBeDefined();
    expect(seat.ofType("watch")).toEqual([{ type: "watch", on: false }]);
    expect(fake.clients).toHaveLength(1); // enabling input must keep the drawn client
    expect(fake.clients[0].disposed).toBe(false);
    expect(app!.find('[data-testid="mirror-renderer-reason"]').exists()).toBe(false);
    seat.emit(seatSession({ renderStream: { ...descriptor, token: "b".repeat(64) } }));
    await settle();
    expect(renderStreamContext.firstFrame).toBe(false);
    expect(app!.findComponent(MirrorView).exists()).toBe(true);
    expect(app!.getComponent(MirrorView).props("sceneReady")).toBe(false);
    expect(app!.get('[data-testid="mirror-renderer-reason"]').text()).toBe("Switching…");
  });

  it("keeps one pair and the open panel anchored through mirror, pending, stream and portrait", async () => {
    const portrait = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal("matchMedia", () => portrait);
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
    const canvasRect = vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 1920, 1080));
    try {
      const seat = await showMirror();
      mirrorSettings.panelOpen = false;
      await settle();
      const gear = app!.get('[data-testid="mirror-settings-toggle"]');
      vi.spyOn(gear.element, "getBoundingClientRect").mockReturnValue(new DOMRect(920, 0, 80, 80));
      await gear.trigger("click");
      const panel = () => app!.get('[data-testid="mirror-settings-panel"]');
      const checkPair = (placement: string, compact = false) => {
        expect(app!.findAll('[data-testid="mirror-settings-toggle"]')).toHaveLength(1);
        expect(app!.findAll('[data-testid="fullscreen-button"]')).toHaveLength(1);
        expect(app!.get(`${placement} [data-testid="mirror-settings-toggle"]`).classes()
          .includes("settings-gear-button--compact")).toBe(compact);
      };
      checkPair(".mirror-topbar-gear");
      expect(panel().attributes("style")).toContain("top: 86px");
      await startStream(seat);
      checkPair(".mirror-topbar-gear");
      expect(app!.find(".render-stream-gear").exists()).toBe(false);
      expect(panel().attributes("style")).toContain("top: 86px");

      fail({ kind: "streaming", firstFrame: true });
      await settle();
      checkPair(".render-stream-gear");
      expect(mirrorSettings.panelOpen).toBe(true);
      expect(panel().attributes("style")).toContain("top: 86px");

      // A smaller letterboxed picture carries both the controls and their open panel anchor with it.
      canvasRect.mockReturnValue(new DOMRect(60, 27, 1824, 1026));
      window.dispatchEvent(new Event("resize"));
      await settle();
      expect(panel().attributes("style")).toContain("top: 109px");
      const listener = portrait.addEventListener.mock.calls.find(([event]) => event === "change")![1];
      listener({ matches: true });
      await settle();
      checkPair(".mirror-chrome-gear", true);
      expect(app!.find(".render-stream-gear").exists()).toBe(false);
      expect(mirrorSettings.panelOpen).toBe(true);
    } finally {
      canvasRect.mockRestore();
      delete (document as unknown as Record<string, unknown>).fullscreenEnabled;
    }
  });

  it.each(["mirror", "stream"])("re-anchors the open %s panel under the fixed gear on portrait rotation", async (renderer) => {
    const portrait = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal("matchMedia", () => portrait);
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("settings-gear-button--compact")) return new DOMRect(500, 8, 44, 44);
      if (this instanceof HTMLCanvasElement) return new DOMRect(0, 0, 1920, 1080);
      return originalRect.call(this);
    });
    try {
      const seat = await showMirror();
      if (renderer === "stream") {
        await startStream(seat);
        fail({ kind: "streaming", firstFrame: true });
        await settle();
      }
      mirrorSettings.panelOpen = true;
      mirrorSettings.panelAnchorTop = 109;
      await settle();
      const listener = portrait.addEventListener.mock.calls.find(([event]) => event === "change")![1];
      listener({ matches: true });
      await settle();
      expect(app!.findAll('[data-testid="mirror-settings-toggle"]')).toHaveLength(1);
      expect(app!.get('.mirror-chrome-gear [data-testid="mirror-settings-toggle"]').classes())
        .toContain("settings-gear-button--compact");
      expect(mirrorSettings.panelOpen).toBe(true);
      expect(app!.get('[data-testid="mirror-settings-panel"]').attributes("style")).toContain("top: 58px");
    } finally {
      rect.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it.each(["failed", "ended"])("drops a stage that %s before its first frame and keeps the same mirror watching", async (kind) => {
    const seat = await showMirror();
    const mirror = app!.getComponent(MirrorView).element;
    await startStream(seat);
    fail(kind === "ended" ? { kind: "ended" } : { kind: "failed", reason: "host-error", detail: "capture stopped" });
    await settle();
    expect(app!.getComponent(MirrorView).element).toBe(mirror);
    expect(app!.find('[data-testid="render-stream-stage"]').exists()).toBe(false);
    expect(seat.ofType("watch")).toEqual([{ type: "watch", on: false }, { type: "watch", on: true }]);
    expect(renderStreamContext.stopped).toBe(kind === "ended" ? "ended" : "host-error: capture stopped");
    expect(app!.get('[data-testid="mirror-renderer-stopped"]').text()).toContain(renderStreamContext.stopped);
    expect(fake.clients[0].disposed).toBe(true);
  });

  it.each(["withdrawal", "checkbox", "failure"])("loads a fresh restored scene after %s", async (cause) => {
    const seat = await showMirror();
    const mirror = app!.getComponent(MirrorView).element;
    await startStream(seat);
    fail({ kind: "streaming", firstFrame: true });
    await settle();
    expect(app!.getComponent(MirrorView).element).toBe(mirror);
    expect(app!.get('[data-testid="mirror-scene-shell"]').classes()).toContain("mirror-scene-hidden");
    seat.sent.length = 0;
    if (cause === "failure") {
      fail({ kind: "ended" });
      await settle();
      expect(seat.ofType("renderer")).toEqual([{ type: "renderer", rendererProtocol: 2, renderer: "mirror" }]);
    } else if (cause === "checkbox") {
      await app!.get('[data-testid="mirror-renderer"]').setValue(false);
      expect(seat.ofType("renderer")).toEqual([{ type: "renderer", rendererProtocol: 2, renderer: "mirror" }]);
      // Mirror demand resumes immediately, while an in-flight armed session cannot reopen admission.
      seat.emit(seatSession({ rendererState: { state: "armed", restoreComplete: false } }));
      await settle();
      expect(seat.ofType("watch")).toEqual([{ type: "watch", on: true }]);
    }
    seat.emit(seatSession({ renderStream: null, rendererState: { state: "mirror", restoreComplete: false } }));
    await settle();
    expect(app!.findComponent(MirrorView).exists()).toBe(true);
    expect(app!.find('[data-testid="render-stream-stage"]').exists()).toBe(false);
    expect(app!.getComponent(MirrorView).props("sceneReady")).toBe(false);
    expect(seat.ofType("watch")).toEqual([{ type: "watch", on: true }]);
    // Even a full scene sent before restoration is a straggler, not this return's baseline.
    seat.emit(sceneDelta);
    await settle();
    expect(app!.findComponent(MirrorView).exists()).toBe(true);
    seat.emit(seatSession({ renderStream: null, rendererState: { state: "mirror", restoreComplete: true } }));
    await settle();
    expect(seat.ofType("watch")).toEqual([{ type: "watch", on: true }]);
    expect(app!.findComponent(MirrorView).exists()).toBe(true);
    expect(app!.getComponent(MirrorView).props("sceneReady")).toBe(false);
    seat.emit({ ...sceneDelta, full: false });
    await settle();
    expect(app!.findComponent(MirrorView).exists()).toBe(true);
    seat.emit(sceneDelta);
    await settle();
    expect(app!.findComponent(MirrorView).exists()).toBe(true);
    expect(app!.find('.mirror-join-stack').exists()).toBe(false);
    expect(renderStreamContext.stopped).toBe(cause === "failure" ? "ended" : cause === "withdrawal" ? "descriptor gone" : null);
    expect(fake.clients[0].disposed).toBe(true);
    if (cause === "checkbox") {
      const mirror = app!.getComponent(MirrorView).element;
      await app!.get('[data-testid="mirror-renderer"]').setValue(true);
      seat.emit(seatSession({ renderStream: { ...descriptor, token: "b".repeat(64) } }));
      await settle();
      expect(fake.clients).toHaveLength(2);
      expect(fake.clients[1].options.endpoint.token).toBe("b".repeat(64));
      expect(app!.get('[data-testid="mirror-stream-shell"]').classes()).toContain("mirror-stream-pending");
      expect(app!.getComponent(MirrorView).element).toBe(mirror);
    }
  });

  it("sends stream input when restarted before the returning mirror scene arrives", async () => {
    const seat = await showMirror();
    await startStream(seat);
    fail({ kind: "streaming", firstFrame: true });
    await settle();
    await app!.get('[data-testid="mirror-renderer"]').setValue(false);
    seat.emit(seatSession({ renderStream: null, rendererState: { state: "mirror", restoreComplete: false } }));
    await settle();
    expect(app!.findComponent(MirrorView).exists()).toBe(true);
    expect(app!.getComponent(MirrorView).props("sceneReady")).toBe(false);
    seat.sent.length = 0;

    await app!.get('[data-testid="mirror-renderer"]').setValue(true);
    seat.emit(seatSession({ renderStream: { ...descriptor, token: "b".repeat(64) },
      rendererState: { state: "armed", restoreComplete: false } }));
    await settle();
    fail({ kind: "streaming", firstFrame: true });
    await settle();
    expect(fake.clients).toHaveLength(2);
    const stage = app!.getComponent((await realStageImport()).default);
    expect(stage.props("inputEnabled")).toBe(true);
    stage.props("sendInput")!({ kind: "key", key: "KeyE", pressed: true });
    expect(seat.ofType("input")).toHaveLength(1);
    expect(seat.ofType("input")[0]).toMatchObject({ kind: "key", key: "KeyE", pressed: true });
  });

  it("keeps loading when a restarted stream is cancelled before its first frame", async () => {
    const seat = await showMirror();
    await startStream(seat);
    fail({ kind: "streaming", firstFrame: true });
    await settle();
    await app!.get('[data-testid="mirror-renderer"]').setValue(false);
    seat.emit(seatSession({ renderStream: null, rendererState: { state: "mirror", restoreComplete: false } }));
    await settle();
    expect(app!.findComponent(MirrorView).exists()).toBe(true);
    expect(app!.getComponent(MirrorView).props("sceneReady")).toBe(false);
    seat.sent.length = 0;

    await app!.get('[data-testid="mirror-renderer"]').setValue(true);
    seat.emit(seatSession({ renderStream: { ...descriptor, token: "b".repeat(64) },
      rendererState: { state: "armed", restoreComplete: false } }));
    await settle();
    expect(fake.clients).toHaveLength(2);
    expect(renderStreamContext.firstFrame).toBe(false);
    await app!.get('[data-testid="mirror-renderer"]').setValue(false);
    seat.emit(seatSession({ renderStream: null, rendererState: { state: "mirror", restoreComplete: false } }));
    await settle();
    expect(app!.findComponent(MirrorView).exists()).toBe(true);
    expect(app!.getComponent(MirrorView).props("sceneReady")).toBe(false);
    expect(seat.ofType("watch")).toEqual([{ type: "watch", on: false }, { type: "watch", on: true }]);

    seat.emit(seatSession({ renderStream: null, rendererState: { state: "mirror", restoreComplete: true } }));
    await settle();
    expect(seat.ofType("watch")).toEqual([{ type: "watch", on: false }, { type: "watch", on: true }]);
    expect(app!.findComponent(MirrorView).exists()).toBe(true);
    seat.emit(sceneDelta);
    await settle();
    expect(app!.findComponent(MirrorView).exists()).toBe(true);
  });

  it("keeps the mirror when the stage chunk fails before its first frame", async () => {
    const seat = await showMirror();
    const mirror = app!.getComponent(MirrorView).element;
    fake.stageImport = () => Promise.reject(new Error("chunk unavailable"));
    await startStream(seat);
    expect(app!.getComponent(MirrorView).element).toBe(mirror);
    expect(seat.ofType("watch")).toEqual([{ type: "watch", on: false }, { type: "watch", on: true }]);
    expect(renderStreamContext.stopped).toBe("stage-load-failed: chunk unavailable");
  });

  it("ignores a late stage chunk rejection after the checkbox is unticked", async () => {
    const seat = await showMirror();
    let reject!: (reason: Error) => void;
    fake.stageImport = () => new Promise((_resolve, fail) => { reject = fail; });
    await startStream(seat);
    await app!.get('[data-testid="mirror-renderer"]').setValue(false);
    await settle();
    reject(new Error("obsolete chunk"));
    await settle();
    expect(app!.findComponent(MirrorView).exists()).toBe(true);
    expect(renderStreamContext.stopped).toBeNull();
    expect(mirrorSettings.runtimeRenderer).toBe("mirror");
  });
});

// The stage is a separate JS chunk. One that fails, or does not arrive in time (a flaky phone on the LAN), falls back
// to the old renderer exactly like a failed stream: the join's frame receipt is MirrorView's, so without the fallback
// the host's join would wait at "the browser is displaying the game" forever.
describe("MirrorApp — the stage chunk fails to load", () => {
  const descriptor = { url: "ws://127.0.0.1:13366/render-stream", resourceBase: "http://127.0.0.1:13366",
    token: "f".repeat(64), protocol: 16, presentation: [1920, 1080] };
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

  it.each(["measured", "unmeasured"])("keeps one pair and the open panel while the streaming join's stage chunk loads (%s canvas)", async (layout) => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const originalFullscreen = Object.getOwnPropertyDescriptor(document, "fullscreenEnabled");
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
    const canvasRect = vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 1920, 1080));
    let resolveImport!: (module: Awaited<ReturnType<typeof realStageImport>>) => void;
    fake.stageImport = () => new Promise((resolve) => { resolveImport = resolve; });
    try {
      await joinStreamingSeat();
      expect(app!.findComponent(MirrorView).exists()).toBe(false);
      const checkPair = (placement: string) => {
        expect(app!.findAll('[data-testid="mirror-settings-toggle"]')).toHaveLength(1);
        expect(app!.findAll('[data-testid="fullscreen-button"]')).toHaveLength(1);
        expect(app!.find(`${placement}-gear [data-testid="mirror-settings-toggle"]`).exists()).toBe(true);
        expect(app!.find(`${placement}-fullscreen [data-testid="fullscreen-button"]`).exists()).toBe(true);
      };
      checkPair(".mirror-chrome");
      expect(stageMounted()).toBe(false);
      const gear = app!.get('[data-testid="mirror-settings-toggle"]');
      const gearRect = vi.spyOn(gear.element, "getBoundingClientRect")
        .mockReturnValue(new DOMRect(938, 8, 44, 44));
      await gear.trigger("click");
      const panel = () => app!.get('[data-testid="mirror-settings-panel"]');
      expect(mirrorSettings.panelOpen).toBe(true);
      expect(panel().attributes("style")).toContain("top: 58px");

      if (layout === "unmeasured") canvasRect.mockReturnValue(new DOMRect());
      resolveImport(await realStageImport());
      await settle();
      if (layout === "unmeasured") {
        expect(stageMounted()).toBe(true);
        checkPair(".mirror-chrome");
        expect(app!.find(".render-stream-gear").exists()).toBe(false);
        expect(mirrorSettings.panelOpen).toBe(true);
        expect(panel().attributes("style")).toContain("top: 58px");
        canvasRect.mockReturnValue(new DOMRect(0, 0, 1920, 1080));
        window.dispatchEvent(new Event("resize"));
        await settle();
      }
      checkPair(".render-stream");
      expect(stageMounted()).toBe(true);
      expect(mirrorSettings.panelOpen).toBe(true);
      expect(panel().attributes("style")).toContain("top: 86px");
      gearRect.mockRestore();
    } finally {
      canvasRect.mockRestore();
      if (originalFullscreen) Object.defineProperty(document, "fullscreenEnabled", originalFullscreen);
      else delete (document as unknown as Record<string, unknown>).fullscreenEnabled;
      vi.unstubAllGlobals();
    }
  });

  it("falls back to MirrorView with the stop reason set when the chunk rejects", async () => {
    fake.stageImport = () => Promise.reject(new Error("Failed to fetch dynamically imported module"));
    const { seat } = await joinStreamingSeat();

    expect(renderStreamContext.stopped).toBe("stage-load-failed: Failed to fetch dynamically imported module");
    expect(mirrorSettings.runtimeRenderer).toBe("mirror");
    expect(mirrorSettings.renderer).toBe("stream");
    expect(stageMounted()).toBe(false);
    expect(fake.clients).toHaveLength(0);

    seat.emit({ ...seatSession(), renderStream: null, rendererState: { state: "mirror", restoreComplete: true } });
    await settle();
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
    seat.emit({ ...seatSession(), renderStream: null, rendererState: { state: "mirror", restoreComplete: true } });
    await settle();
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
