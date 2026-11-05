import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import type {
  RenderStreamClient,
  RenderStreamClientOptions,
  RenderStreamEndpoint,
  RenderStreamStats,
  RenderStreamStatus
} from "@godot-scene-web/render-stream-client";

import RenderStreamStage from "@/mirror/RenderStreamStage.vue";
import type { MirrorInputMessage } from "@/mirror/mirrorClient";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { RS_GROUP_SHOP_ITEM } from "@/stream-ext/groups";

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
  carrier: RenderStreamStats["carrier"];
  emit(status: RenderStreamStatus): void;
}

let clients: Fake[] = [];
function createClient(options: RenderStreamClientOptions): RenderStreamClient {
  const fake: Fake = {
    options, connects: 0, disposed: false, carrier: null,
    connect() { fake.connects += 1; },
    setEndpoint: vi.fn(),
    cssToPresentation: vi.fn(() => null),
    presentationToCss: vi.fn((r) => r),
    toGame: vi.fn(() => null),
    clientToGame: vi.fn(() => null),
    stats: () => ({ applied: 0, appliesPerSec: 0, creditRttMsP50: null, heapBytes: 0, carrier: fake.carrier }),
    recording: () => null,
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
    expect(options.carrier).toBe("auto");
    expect(clients[0].connects).toBe(1);
  });

  it("installs window.__renderStreamStats while mounted and removes it on unmount (CAR9 QA)", async () => {
    const seam = () => (window as unknown as { __renderStreamStats?: () => RenderStreamStats }).__renderStreamStats;
    mountStage();
    clients[0].carrier = "websocket";
    expect(seam()?.()).toMatchObject({ appliesPerSec: 0, carrier: "websocket" });
    wrapper!.unmount();
    wrapper = null;
    expect(seam()).toBeUndefined();
  });

  it("opens the carrier ?rsCarrier= forces for the session (CAR9 QA)", () => {
    mirrorSettings.renderStreamCarrier = "websocket";
    try {
      mountStage();
      expect(clients[0].options.carrier).toBe("websocket");
    } finally {
      mirrorSettings.renderStreamCarrier = "auto";
    }
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

  // The join's last step ("the browser displays the game") waits for this: once per mount, on the first drawn frame.
  it("emits first-frame once, on the first drawn frame only", async () => {
    mountStage();
    clients[0].emit({ kind: "streaming", firstFrame: false });
    await nextTick();
    expect(wrapper!.emitted("first-frame")).toBeUndefined();
    clients[0].emit({ kind: "streaming", firstFrame: true });
    clients[0].emit({ kind: "reconnecting", attempt: 1, inMs: 1000 });
    clients[0].emit({ kind: "streaming", firstFrame: true });
    await nextTick();
    expect(wrapper!.emitted("first-frame")).toHaveLength(1);
  });

  // CAR9: the carrier the client opened is on the stage's DOM, for QA, and only while a session streams.
  it("names the open carrier in data-stream-carrier while streaming", async () => {
    mountStage();
    const frame = () => wrapper!.get('[data-testid="render-stream-stage"]').attributes("data-stream-carrier");
    expect(frame()).toBeUndefined();
    clients[0].carrier = "webtransport";
    clients[0].emit({ kind: "streaming", firstFrame: false });
    await nextTick();
    expect(frame()).toBe("webtransport");
    clients[0].carrier = null;
    clients[0].emit({ kind: "reconnecting", attempt: 1, inMs: 1000 });
    await nextTick();
    expect(frame()).toBeUndefined();
    clients[0].carrier = "websocket";
    clients[0].emit({ kind: "streaming", firstFrame: true });
    await nextTick();
    expect(frame()).toBe("websocket");
    expect((wrapper!.vm as unknown as { stats(): RenderStreamStats }).stats().carrier).toBe("websocket");
    clients[0].emit({ kind: "failed", reason: "host-error", detail: "capture stopped" });
    await nextTick();
    expect(frame()).toBeUndefined();
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

  describe("extension modules follow the settings and the presentation mid-session", () => {
    const ids = (c: Fake) => (c.options.extensions ?? []).map((e) => e.id);

    it("toggling a module remounts a fresh client (fresh canvas) with the new list", async () => {
      mountStage();
      expect(ids(clients[0])).toEqual([]);
      mirrorSettings.raiseHandCards = true;
      await nextTick(); // the settings watch disposes the stale client
      await nextTick(); // the fresh canvas renders and the new client mounts on it
      expect(clients[0].disposed).toBe(true);
      expect(clients).toHaveLength(2);
      expect(ids(clients[1])).toEqual(["couchcoop.raisedHand"]);
      expect(clients[1].connects).toBe(1);
      expect(clients[1].options.canvas).not.toBe(clients[0].options.canvas);

      for (const key of ["uiScaling", "raiseHeldCard", "confirmTap"] as const) {
        mirrorSettings[key] = true;
        await nextTick();
        await nextTick();
      }
      expect(clients).toHaveLength(5);
      expect(ids(clients[4])).toEqual(["couchcoop.raisedHand", "couchcoop.viewScale", "couchcoop.heldCard", "couchcoop.confirmTap"]);
      expect(clients.slice(0, 4).every((c) => c.disposed)).toBe(true);
    });

    it("a setting the modules do not read never remounts", async () => {
      mountStage();
      mirrorSettings.tapToFocus = !mirrorSettings.tapToFocus;
      await nextTick();
      await nextTick();
      mirrorSettings.tapToFocus = !mirrorSettings.tapToFocus;
      expect(clients).toHaveLength(1);
      expect(clients[0].disposed).toBe(false);
    });

    it("a seat relaunched at a new presentation width remounts on the new descriptor", async () => {
      mirrorSettings.uiScaling = true;
      mountStage();
      const wide = { ...endpoint, url: "ws://127.0.0.1:12/render-stream", presentation: [2340, 1080] as [number, number] };
      await wrapper!.setProps({ endpoint: wide });
      await nextTick();
      expect(clients[0].disposed).toBe(true);
      expect(clients[0].setEndpoint).not.toHaveBeenCalled(); // the stale client is replaced, not re-pointed
      expect(clients).toHaveLength(2);
      expect(clients[1].options.endpoint).toEqual(wide);
      expect(clients[1].options.canvas.width).toBe(2340);
      expect(ids(clients[1])).toEqual(["couchcoop.viewScale"]);
    });

    it("a suspended stage remounts nothing, and builds from the current settings when it wakes", async () => {
      vi.useFakeTimers();
      mountStage();
      setVisibility("hidden");
      await vi.advanceTimersByTimeAsync(60_000);
      mirrorSettings.confirmTap = true;
      await nextTick();
      expect(clients).toHaveLength(1);
      setVisibility("visible");
      await nextTick();
      expect(clients).toHaveLength(2);
      expect(ids(clients[1])).toEqual(["couchcoop.confirmTap"]);
    });
  });

  it("re-anchors the confirm button when the layout changes (resize / rotation)", async () => {
    mirrorSettings.confirmTap = true;
    const sent: MirrorInputMessage[] = [];
    mountStage({ sendInput: (m: MirrorInputMessage) => sent.push(m) });
    const fake = clients[0];
    // The tap lands on a shop item's child (20 → 10), drawn at presentation rect (100, 200, 300×80).
    fake.clientToGame = vi.fn(() => ({ point: { x: 640, y: 360 }, item: 20, drawn: { x: 640, y: 360 } }));
    const confirm = (fake.options.extensions ?? []).find((e) => e.id === "couchcoop.confirmTap")!;
    const rect = { x: 100, y: 200, w: 300, h: 80 };
    confirm.onItemMeta!({ form: "full", items: [{ id: 10, node: true, groups: [RS_GROUP_SHOP_ITEM], meta: {}, path: "Item" }] });
    confirm.beforeDraw!({
      seq: 1, now: 0, overrides: null as never, requestRedraw: () => {},
      query: {
        parent: (id) => (id === 20 ? 10 : null), children: () => new Uint32Array(0), transform: () => null,
        rect: (id) => (id === 10 ? rect : null), subtreeRect: () => null, visible: () => true, meta: () => null,
        hitTest: () => null
      }
    });

    const canvas = wrapper!.get('[data-testid="render-stream-canvas"]').element;
    for (const type of ["pointerdown", "pointerup"]) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 640, clientY: 360, button: 0 });
      Object.defineProperty(event, "pointerType", { value: "touch" });
      Object.defineProperty(event, "pointerId", { value: 1 });
      canvas.dispatchEvent(event);
    }
    await nextTick();
    const button = () => wrapper!.find('[data-testid="render-stream-confirm-button"]');
    expect(button().exists()).toBe(true);
    expect((button().element as HTMLElement).style.left).toBe("100px");

    // The page reflows (a rotation): the same presentation rect now maps elsewhere on the page.
    vi.mocked(fake.presentationToCss).mockImplementation((r) => ({ ...r, x: r.x + 50 }));
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    expect((button().element as HTMLElement).style.left).toBe("150px");
    expect(sent).toEqual([{ kind: "hover", coordX: 640, coordY: 360 }]); // the tap only focused
  });

  it("hands a changed descriptor to the client", async () => {
    mountStage();
    const next = { ...endpoint, url: "ws://127.0.0.1:10/render-stream" };
    await wrapper!.setProps({ endpoint: next });
    expect(clients[0].setEndpoint).toHaveBeenCalledWith(next);
  });
});
