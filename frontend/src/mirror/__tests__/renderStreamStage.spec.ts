import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import type {
  RenderStreamClient,
  RenderStreamClientOptions,
  RenderStreamEndpoint,
  RenderStreamStatus
} from "@godot-scene-web/render-stream-client";

import RenderStreamStage from "@/mirror/RenderStreamStage.vue";
import { mirrorSettings } from "@/mirror/mirrorSettings";

// The stage's own lifecycle (handoff-mirror-new-renderer.md §3 Q5) against a fake client: it connects on mount,
// shows the loading line until the first drawn frame, emits `failed` on a stop, disposes on unmount, and disposes
// after 60 s in a hidden tab, reconnecting as a fresh join when visible again.

const endpoint: RenderStreamEndpoint = { url: "ws://127.0.0.1:9/render-stream", resourceBase: "http://127.0.0.1:9",
  token: null, protocol: 12, presentation: [1920, 1080] };
const core = { glueUrl: "/g.js", wasmUrl: "/w.wasm", expectedTree: "0ccb21bb561c" };

interface Fake extends RenderStreamClient {
  options: RenderStreamClientOptions;
  connects: number;
  disposed: boolean;
  emit(status: RenderStreamStatus): void;
}

let clients: Fake[] = [];
function createClient(options: RenderStreamClientOptions): RenderStreamClient {
  const fake: Fake = {
    options, connects: 0, disposed: false,
    connect() { fake.connects += 1; },
    setEndpoint: vi.fn(),
    cssToPresentation: vi.fn(() => null),
    presentationToCss: vi.fn((r) => r),
    toGame: vi.fn(() => null),
    clientToGame: vi.fn(() => null),
    stats: () => ({ applied: 0, appliesPerSec: 0, creditRttMsP50: null, heapBytes: 0 }),
    dispose() { fake.disposed = true; },
    emit(status) { options.onStatus?.(status); }
  };
  clients.push(fake);
  return fake;
}

let wrapper: VueWrapper | null = null;
let visibility: DocumentVisibilityState = "visible";

function setVisibility(state: DocumentVisibilityState): void {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  clients = [];
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  // The stage runs the extension modules on the viewer's saved choices; keep this suite's default mount a pure
  // client (every module off), so the "empty extension list" claim stays the baseline.
  mirrorSettings.raiseHandCards = false;
  mirrorSettings.uiScaling = false;
  mirrorSettings.raiseHeldCard = false;
  mirrorSettings.confirmTap = false;
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const mountStage = (props: Record<string, unknown> = {}) =>
  (wrapper = mount(RenderStreamStage, { props: { endpoint, core, createClient, ...props } }));
const status = () => wrapper!.find('[data-testid="render-stream-status"]');

describe("RenderStreamStage", () => {
  it("mounts one view-only client on its 1920x1080 canvas and connects it", () => {
    mountStage();
    expect(clients).toHaveLength(1);
    const { options } = clients[0];
    expect(options.canvas).toBe(wrapper!.get('[data-testid="render-stream-canvas"]').element);
    expect(options.canvas.width).toBe(1920);
    expect(options.canvas.height).toBe(1080);
    expect(options.extensions).toEqual([]);
    expect(options.endpoint).toEqual(endpoint);
    expect(options.core).toEqual(core);
    expect(clients[0].connects).toBe(1);
  });

  it("attaches the raise-hand and view-scale modules on the viewer's saved choices", () => {
    mirrorSettings.raiseHandCards = true;
    mirrorSettings.uiScaling = true;
    mountStage();
    expect((clients[0].options.extensions ?? []).map((e) => e.id))
      .toEqual(["couchcoop.raisedHand", "couchcoop.viewScale"]);
  });

  it("attaches the held-card and confirm-tap modules on the viewer's saved choices", () => {
    mirrorSettings.raiseHeldCard = true;
    mirrorSettings.confirmTap = true;
    mountStage();
    expect((clients[0].options.extensions ?? []).map((e) => e.id))
      .toEqual(["couchcoop.heldCard", "couchcoop.confirmTap"]);
  });

  // PRES-A: a seat launched at the viewer's aspect describes a wider presentation; the canvas takes that backing size
  // and is letterboxed at that aspect, not at 16:9.
  it("sizes and letterboxes the canvas at a wide seat's presentation", () => {
    mountStage({ endpoint: { ...endpoint, presentation: [2340, 1080] } });
    const canvas = wrapper!.get('[data-testid="render-stream-canvas"]').element as HTMLCanvasElement;
    expect(canvas.width).toBe(2340);
    expect(canvas.height).toBe(1080);
    const box = wrapper!.get(".render-stream-box").element as HTMLElement;
    expect(Number(box.style.getPropertyValue("--render-stream-aspect"))).toBeCloseTo(2340 / 1080, 10);
  });

  it("shows the loading line until the first drawn frame, and Reconnecting… while backing off", async () => {
    mountStage();
    expect(status().text()).toBe("Connecting…");
    clients[0].emit({ kind: "streaming", firstFrame: false });
    await nextTick();
    expect(status().text()).toBe("Loading…");
    clients[0].emit({ kind: "streaming", firstFrame: true });
    await nextTick();
    expect(status().exists()).toBe(false);
    clients[0].emit({ kind: "reconnecting", attempt: 1, inMs: 1000 });
    await nextTick();
    expect(status().text()).toBe("Reconnecting…");
  });

  it("emits failed once with the reason and disposes the client", async () => {
    mountStage();
    clients[0].emit({ kind: "failed", reason: "host-error", detail: "capture stopped" });
    clients[0].emit({ kind: "ended" });
    await nextTick();
    expect(wrapper!.emitted("failed")).toEqual([["host-error: capture stopped"]]);
    expect(clients[0].disposed).toBe(true);
  });

  it("still falls back when the failed client's dispose throws", async () => {
    mountStage();
    clients[0].dispose = () => { throw new Error("null pointer passed to rust"); };
    expect(() => clients[0].emit({ kind: "failed", reason: "receiver-error", detail: "lost context" })).toThrow();
    await nextTick();
    expect(wrapper!.emitted("failed")).toEqual([["receiver-error: lost context"]]);
    expect(wrapper!.get('[data-testid="render-stream-stage"]').attributes("data-stream-phase")).toBe("failed");
  });

  it("treats an end record as a stop", async () => {
    mountStage();
    clients[0].emit({ kind: "ended" });
    await nextTick();
    expect(wrapper!.emitted("failed")).toEqual([["ended"]]);
  });

  it("disposes on unmount", () => {
    mountStage();
    wrapper!.unmount();
    wrapper = null;
    expect(clients[0].disposed).toBe(true);
  });

  it("disposes after 60 s hidden and rejoins fresh when visible; a short hide costs nothing", async () => {
    vi.useFakeTimers();
    mountStage();
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(59_000);
    setVisibility("visible");
    expect(clients).toHaveLength(1);
    expect(clients[0].disposed).toBe(false);

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clients[0].disposed).toBe(true);
    expect(wrapper!.get('[data-testid="render-stream-stage"]').attributes("data-stream-phase")).toBe("suspended");

    setVisibility("visible");
    await nextTick();
    expect(clients).toHaveLength(2);
    expect(clients[1].connects).toBe(1);
    // A NEW canvas: the disposed client lost the old one's WebGL context for good, and a client on it drew nothing
    // (MIR-4's real hidden page: the reconnect opened, then the stage stayed blank).
    expect(clients[1].options.canvas).not.toBe(clients[0].options.canvas);
    const canvases = wrapper!.findAll('[data-testid="render-stream-canvas"]');
    expect(canvases).toHaveLength(1);
    expect(canvases[0].element).toBe(clients[1].options.canvas);
  });

  describe("unauthorized: one ask for the seat's current descriptor", () => {
    const unauthorized: RenderStreamStatus = { kind: "failed", reason: "live-connect-failed", detail: "unauthorized" };
    const fresh = { ...endpoint, url: "ws://127.0.0.1:11/render-stream", token: "b".repeat(64) };

    it("asks once, then reconnects the same client with a different descriptor", async () => {
      mountStage();
      clients[0].emit(unauthorized);
      await nextTick();
      expect(wrapper!.emitted("refresh-endpoint")).toHaveLength(1);
      expect(wrapper!.emitted("failed")).toBeUndefined();
      expect(clients[0].disposed).toBe(false);
      expect(status().text()).toBe("Connecting…");

      await wrapper!.setProps({ endpoint: fresh });
      expect(clients[0].setEndpoint).toHaveBeenCalledWith(fresh);
      expect(clients[0].connects).toBe(2);
      expect(clients).toHaveLength(1);

      // Asked once: a second refusal before anything drew is a stop.
      clients[0].emit(unauthorized);
      await nextTick();
      expect(wrapper!.emitted("refresh-endpoint")).toHaveLength(1);
      expect(wrapper!.emitted("failed")).toEqual([["live-connect-failed: unauthorized"]]);
    });

    it("stops when the seat answers with the same descriptor", async () => {
      mountStage();
      clients[0].emit(unauthorized);
      await nextTick();
      await wrapper!.setProps({ endpoint: { ...endpoint } });
      expect(wrapper!.emitted("failed")).toEqual([["live-connect-failed: unauthorized"]]);
      expect(clients[0].connects).toBe(1);
      expect(clients[0].disposed).toBe(true);
    });

    it("stops when no descriptor arrives in time", async () => {
      vi.useFakeTimers();
      mountStage({ refreshTimeoutMs: 5_000 });
      clients[0].emit(unauthorized);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(wrapper!.emitted("failed")).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(wrapper!.emitted("failed")).toEqual([["live-connect-failed: unauthorized"]]);
    });

    it("asks again after a drawn frame", async () => {
      mountStage();
      clients[0].emit(unauthorized);
      await wrapper!.setProps({ endpoint: fresh });
      clients[0].emit({ kind: "streaming", firstFrame: true });
      clients[0].emit(unauthorized);
      await nextTick();
      expect(wrapper!.emitted("refresh-endpoint")).toHaveLength(2);
      expect(wrapper!.emitted("failed")).toBeUndefined();
    });
  });

  it("hands a changed descriptor to the client", async () => {
    mountStage();
    const next = { ...endpoint, url: "ws://127.0.0.1:10/render-stream" };
    await wrapper!.setProps({ endpoint: next });
    expect(clients[0].setEndpoint).toHaveBeenCalledWith(next);
  });
});
