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
import { renderStreamContext } from "@/mirror/renderStreamAvailability";

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
  Object.assign(mirrorSettings, { renderer: "mirror", runtimeRenderer: "mirror", renderStreamUrl: null,
    renderStreamProtocol: 12, refreshRate: DEFAULT_REFRESH_RATE, ...HEADLESS_FREEZES, staticBgEnabled: true });
});

afterEach(() => {
  app?.unmount();
  app = null;
  Object.assign(mirrorSettings, { renderer: "mirror", runtimeRenderer: "mirror", renderStreamUrl: null });
  Object.assign(renderStreamContext, { directView: false, sessionEndpoint: null, coreLoadFailed: false, stopped: null,
    coreProblem: undefined, webgl2: undefined, pageLoopback: undefined });
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
