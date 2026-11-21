import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import handCoverScreens from "../../../../tests/fixtures/render-stream/hand-cover-screens.json";

import type {
  ExtensionFrame,
  ItemMeta,
  ItemQuery,
  OverrideTable,
  RenderStreamClient,
  RenderStreamClientOptions,
  RenderStreamEndpoint,
  RenderStreamStats,
  RenderStreamStatus
} from "@godot-scene-web/render-stream-client";

import RenderStreamStage from "@/mirror/RenderStreamStage.vue";
import MirrorConfirmButton from "@/mirror/MirrorConfirmButton.vue";
import { __resetConfirmTapForTest, __setConfirmSpritesForTest, confirmTap } from "@/mirror/confirmTap";
import type { MirrorInputMessage } from "@/mirror/mirrorClient";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { __resetHandRaiseUiForTest, handRaiseUi } from "@/mirror/handRaiseUi";
import { __resetStageFitForTest, activateDisplayLayout, setLayoutScale } from "@/mirror/stageFit";
import { clearStoredMirrorSettings } from "@/mirror/mirrorSettings";
import { RS_GROUP_HAND_ROOT, RS_GROUP_HAND_CONTAINER, RS_GROUP_HAND_COVER, RS_GROUP_HAND_HOLDER, RS_GROUP_SHOP_ITEM } from "@/stream-ext/groups";

vi.mock("@/mirror/atlasSprite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/atlasSprite")>();
  return {
    ...actual,
    resolveAtlasSprite: vi.fn(async () => ({
      pageUrl: "/test-hand.png",
      region: { x: 10, y: 20, width: 166, height: 121 },
      margin: { x: 2, y: 22, width: 4, height: 27 }
    }))
  };
});

// The stage's own lifecycle against a fake client: it connects on mount,
// shows the loading line until the first drawn frame, emits `failed` on a stop, disposes on unmount, and disposes
// after 60 s in a hidden tab, reconnecting as a fresh join when visible again.

const endpoint: RenderStreamEndpoint = { url: "ws://127.0.0.1:9/render-stream", resourceBase: "http://127.0.0.1:9",
  token: null, protocol: 16, presentation: [1920, 1080] };
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
    setStaticShaders: vi.fn(),
    setDamageRedraw: vi.fn(),
    setStaticParticles: vi.fn(),
    hints: () => [],
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
  __resetConfirmTapForTest();
  const sprite = { pageUrl: "/test-atlas.png", region: { x: 0, y: 0, width: 10, height: 10 }, margin: { x: 0, y: 0, width: 0, height: 0 } };
  __setConfirmSpritesForTest({ button: sprite, outline: sprite, tick: sprite });
  clients = [];
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  // The stage runs the extension modules on the viewer's saved choices; keep this suite's default mount a pure
  // client (every module off), so the "empty extension list" claim stays the baseline.
  mirrorSettings.streamStaticBg = false;
  mirrorSettings.streamShaderMode = "dynamic";
  mirrorSettings.streamParticleMode = "dynamic";
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
  describe("static stream visuals", () => {
    const background = {
      scenePath: "res://scenes/backgrounds/underdocks/underdocks_background.tscn",
      url: "/bg/underdocks?layers=host&v=1"
    };
    const descriptorId = "/bg/underdocks?layers=seat&v=1";
    const props = { staticBackground: background, staticBackgroundId: descriptorId };
    const image = () => wrapper!.get('[data-testid="stream-static-bg-image"]');
    const votes = () => wrapper!.emitted("static-bg-ready") ?? [];
    const underlay = () => wrapper!.get('[data-testid="render-stream-background-stage"]').element as HTMLElement;
    const expectDarkUnderlay = () => {
      expect(underlay().style.backgroundColor).toBe("rgb(24, 24, 24)");
      expect(underlay().style.visibility).toBe("");
    };

    it("keeps char-select dark through a pick, stale load and failed replacement", async () => {
      vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1920, 1080));
      mirrorSettings.streamStaticBg = true;
      const character = (id: string) => ({
        scenePath: `res://scenes/screens/char_select/char_select_bg_${id}.tscn`,
        url: `/bg/char-select/${id}?v=1`, id: `seat:42:${id}`
      });
      const first = character("silent");
      mountStage({ staticBackground: first, staticBackgroundId: first.id });
      await nextTick();
      expectDarkUnderlay();
      expect((image().element.parentElement as HTMLElement).style.visibility).toBe("hidden");
      await image().trigger("load");
      expect((image().element.parentElement as HTMLElement).style.visibility).toBe("");
      expect(votes().at(-1)).toEqual([first.id]);
      const stale = image();
      const pick = character("random_character");
      await wrapper!.setProps({ staticBackground: pick, staticBackgroundId: pick.id });
      expect(image().attributes("src")).toBe(pick.url);
      expectDarkUnderlay();
      expect((image().element.parentElement as HTMLElement).style.visibility).toBe("hidden");
      await stale.trigger("load");
      expect(votes().at(-1)).toEqual([""]);
      await image().trigger("error");
      expectDarkUnderlay();
      expect((image().element.parentElement as HTMLElement).style.visibility).toBe("hidden");
      expect(clients[0].options.transparentClear).toBe(true);
      expect(clients).toHaveLength(1);
    });

    it("leaves char-select unchanged when the stream static-background option is off", () => {
      mountStage({ staticBackground: { scenePath: "res://scenes/screens/char_select/char_select_bg_silent.tscn",
        url: "/bg/char-select/silent?v=1" }, staticBackgroundId: "seat:42:silent" });
      expect(wrapper!.find('[data-testid="stream-static-bg-image"]').exists()).toBe(false);
      expect(wrapper!.find('[data-testid="render-stream-background-stage"]').exists()).toBe(false);
      expect(clients[0].options.transparentClear).toBeUndefined();
    });

    it("keeps the default opaque canvas and mounts no underlay with both settings off", () => {
      mountStage(props);
      expect(clients[0].options.transparentClear).toBeUndefined();
      expect(clients[0].options.staticShaders).toBe(false);
      expect(clients[0].options.damageRedraw).toBe(false);
      expect(clients[0].options.staticParticles).toBe(false);
      expect(wrapper!.find('[data-testid="render-stream-background-stage"]').exists()).toBe(false);
      expect(votes()).toEqual([]);
    });

    it.each([
      { width: 1920, rect: new DOMRect(70, 25, 960, 540), scale: 0.5, imageLeft: -300 },
      { width: 2400, rect: new DOMRect(60, 27, 2280, 1026), scale: 0.95, imageLeft: -60 },
      { width: 3840, rect: new DOMRect(70, 25, 1920, 540), scale: 0.5, imageLeft: 660 }
    ])("fits the centered 2520px still to a $width presentation and its letterboxed canvas", async ({ width, rect, scale, imageLeft }) => {
      vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
      mirrorSettings.streamStaticBg = true;
      mountStage({ ...props, endpoint: { ...endpoint, presentation: [width, 1080] } });
      await nextTick();
      expect(clients[0].options.transparentClear).toBe(true);
      const stage = wrapper!.get('[data-testid="render-stream-background-stage"]').element as HTMLElement;
      expect(stage.style.left).toBe(`${rect.left}px`);
      expect(stage.style.top).toBe(`${rect.top}px`);
      expect(stage.style.width).toBe(`${width}px`);
      expect(stage.style.height).toBe("1080px");
      expect(stage.style.transform).toBe(`scale(${scale})`);
      expectDarkUnderlay();
      expect((image().element.parentElement as HTMLElement).style.visibility).toBe("hidden");
      const img = image().element as HTMLImageElement;
      expect(img.style.width).toBe("2520px");
      expect(img.style.height).toBe("1080px");
      expect(img.style.left).toBe("calc(50% - 1260px)");
      // Image center and both cropped edges follow the stream's design-to-page transform.
      expect(rect.left + (imageLeft + 1260) * scale).toBeCloseTo(rect.left + rect.width / 2);
      expect(imageLeft).toBe((width - 2520) / 2);
      expect(votes()).toEqual([]);
      await image().trigger("load");
      expect(votes()).toEqual([[descriptorId]]);
      expectDarkUnderlay();
      expect((image().element.parentElement as HTMLElement).style.visibility).toBe("");
    });

    it.each([
      { scenePath: "res://scenes/rooms/merchant_room.tscn", url: "/bg/rooms/merchant_room?v=2" },
      { scenePath: "res://scenes/events/background_scenes/neow.tscn", url: "/bg/events/neow?v=1" }
    ])("centres a loaded $scenePath still within dark margins at 3840px", async (staticBackground) => {
      vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 3840, 1080));
      mirrorSettings.streamStaticBg = true;
      mountStage({ ...props, staticBackground, endpoint: { ...endpoint, presentation: [3840, 1080] } });
      await nextTick();
      expectDarkUnderlay();
      await image().trigger("load");
      expect(votes()).toEqual([[descriptorId]]);
      expectDarkUnderlay();
      const img = image().element as HTMLImageElement;
      expect((img.parentElement as HTMLElement).style.visibility).toBe("");
      expect(img.style.left).toBe("calc(50% - 1260px)");
      const margin = (parseFloat(underlay().style.width) - parseFloat(img.style.width)) / 2;
      expect(margin).toBe(660);
    });

    it("keeps the loaded still when presentation width grows and shrinks", async () => {
      mirrorSettings.streamStaticBg = true;
      mountStage({ ...props, endpoint: { ...endpoint, presentation: [2400, 1080] } });
      await image().trigger("load");
      expect(votes()).toEqual([[descriptorId]]);
      await wrapper!.setProps({ endpoint: { ...endpoint, presentation: [3840, 1080] } });
      expect(votes().at(-1)).toEqual([descriptorId]);
      expect((image().element.parentElement as HTMLElement).style.visibility).toBe("");
      await wrapper!.setProps({ endpoint: { ...endpoint, presentation: [2400, 1080] } });
      expect(votes().at(-1)).toEqual([descriptorId]);
    });

    it.each([
      { width: 1920, page: new DOMRect(0, 0, 1920, 1080),
        capture: [[398.3, 54], [2126.3, 54], [2126.3, 1026], [398.3, 1026], [1283, 540]],
        expected: [[0, 0], [1920, 0], [1920, 1080], [0, 1080], [983, 540]] },
      { width: 2400, page: new DOMRect(60, 27, 2280, 1026),
        capture: [[182.3, 54], [2342.3, 54], [2342.3, 1026], [182.3, 1026], [1283, 540]],
        expected: [[60, 27], [2340, 27], [2340, 1053], [60, 1053], [1221.85, 540]] }
    ])("maps combat capture corners and its anchor to the live $width presentation within one pixel", async ({ width, page, capture, expected }) => {
      vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue(page);
      mirrorSettings.streamStaticBg = true;
      mountStage({ ...props, staticBackgroundFrame: "983,540,1",
        endpoint: { ...endpoint, presentation: [width, 1080] } });
      await nextTick();
      const img = image().element as HTMLImageElement;
      const stage = wrapper!.get('[data-testid="render-stream-background-stage"]').element as HTMLElement;
      const origin = img.style.transformOrigin.split(" ").map(parseFloat);
      const transform = /^translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)$/.exec(img.style.transform);
      expect(transform).not.toBeNull();
      const [, dx, dy, zoom] = transform!.map(Number);
      const pageScale = Number(/scale\(([^)]+)\)/.exec(stage.style.transform)![1]);
      // The descriptor's picture rect is 2520x1080, centered in the presentation.
      const pictureLeft = (parseFloat(stage.style.width) - parseFloat(img.style.width)) / 2;
      capture.forEach(([x, y], i) => {
        const actual = [parseFloat(stage.style.left) + (pictureLeft + origin[0] + dx + (x - origin[0]) * zoom) * pageScale,
          parseFloat(stage.style.top) + (origin[1] + dy + (y - origin[1]) * zoom) * pageScale];
        expect(Math.abs(actual[0] - expected[i][0])).toBeLessThanOrEqual(1);
        expect(Math.abs(actual[1] - expected[i][1])).toBeLessThanOrEqual(1);
      });
    });

    it("uses the probed scale and origin rather than applying a fixed combat zoom", async () => {
      mirrorSettings.streamStaticBg = true;
      mountStage({ ...props, staticBackgroundFrame: "990,550,0.9" });
      expect((image().element as HTMLImageElement).style.transform).toBe("translate(7px, 10px) scale(1)");
      await wrapper!.setProps({ staticBackgroundFrame: "983,540,1" });
      expect((image().element as HTMLImageElement).style.transform).toBe("translate(0px, 0px) scale(1.1111111111111112)");
      await wrapper!.setProps({ staticBackground: { scenePath: "res://scenes/rooms/merchant_room.tscn", url: "/bg/rooms/merchant_room?v=2" } });
      expect((image().element as HTMLImageElement).style.transform).toBe("");
    });

    it("keeps the underlay dark while loading, after a descriptor change or error, and ignores stale loads", async () => {
      vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1920, 1080));
      mirrorSettings.streamStaticBg = true;
      mountStage(props);
      await nextTick();
      expectDarkUnderlay();
      expect((image().element.parentElement as HTMLElement).style.visibility).toBe("hidden");
      await image().trigger("load");
      const stale = image();
      await wrapper!.setProps({ staticBackground: { ...background, url: "/bg/underdocks?layers=next&v=1" },
        staticBackgroundId: "/bg/underdocks?layers=next-seat&v=1" });
      expectDarkUnderlay();
      expect((image().element.parentElement as HTMLElement).style.visibility).toBe("hidden");
      expect(votes().at(-1)).toEqual([""]);
      await stale.trigger("load");
      expect(votes().at(-1)).toEqual([""]);
      await image().trigger("load");
      expect(votes().at(-1)).toEqual(["/bg/underdocks?layers=next-seat&v=1"]);
      expect(clients).toHaveLength(1); // a different still does not recreate a transparent client
      await image().trigger("error");
      expect(votes().at(-1)).toEqual([""]);
      expectDarkUnderlay();
      expect((image().element.parentElement as HTMLElement).style.visibility).toBe("hidden");
      await image().trigger("load");
      mirrorSettings.streamStaticBg = false;
      await flushPromises();
      expect(votes().at(-1)).toEqual([""]);
      expect(wrapper!.find('[data-testid="stream-static-bg-image"]').exists()).toBe(false);
      expect(clients).toHaveLength(2);
      expect(clients[1].options.transparentClear).toBeUndefined();
    });

    it("retracts for a new seat descriptor even if the admitted host image URL stays the same", async () => {
      mirrorSettings.streamStaticBg = true;
      mountStage(props);
      await image().trigger("load");
      const stale = image();
      await wrapper!.setProps({ staticBackgroundId: "/bg/underdocks?layers=new-seat&v=1" });
      expect(votes().at(-1)).toEqual([""]);
      await stale.trigger("load");
      expect(votes().at(-1)).toEqual([""]);
      await image().trigger("load");
      expect(votes().at(-1)).toEqual(["/bg/underdocks?layers=new-seat&v=1"]);
      expect(clients).toHaveLength(1);
    });

    it("keeps one alpha client and a dark underlay through missing descriptors without reporting readiness", async () => {
      vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1920, 1080));
      mirrorSettings.streamStaticBg = true;
      mountStage({ staticBackgroundId: descriptorId });
      await nextTick();
      expectDarkUnderlay();
      expect(clients[0].options.transparentClear).toBe(true);
      expect(wrapper!.find('[data-testid="stream-static-bg-image"]').exists()).toBe(false);
      expect(votes()).toEqual([]);
      await wrapper!.setProps(props);
      await image().trigger("load");
      expect(votes().at(-1)).toEqual([descriptorId]);
      await wrapper!.setProps({ staticBackground: null, staticBackgroundId: "" });
      expectDarkUnderlay();
      expect(votes().at(-1)).toEqual([""]);
      expect(wrapper!.find('[data-testid="stream-static-bg-image"]').exists()).toBe(false);
      expect(clients).toHaveLength(1);
    });

    it("creates with static shaders and toggles the live client without recreating it", async () => {
      mirrorSettings.streamShaderMode = "static";
      mountStage();
      const client = clients[0];
      expect(client.options.staticShaders).toBe(true);
      expect(client.options.damageRedraw).toBe(true);
      mirrorSettings.streamShaderMode = "dynamic";
      await nextTick();
      expect(client.setStaticShaders).toHaveBeenLastCalledWith(false);
      expect(client.setDamageRedraw).toHaveBeenLastCalledWith(false);
      mirrorSettings.streamShaderMode = "static";
      await nextTick();
      expect(client.setStaticShaders).toHaveBeenLastCalledWith(true);
      expect(client.setDamageRedraw).toHaveBeenLastCalledWith(true);
      expect(client.setStaticShaders).toHaveBeenCalledTimes(2);
      expect(client.setDamageRedraw).toHaveBeenCalledTimes(2);
      expect(client.disposed).toBe(false);
      expect(client.connects).toBe(1);
      expect(clients).toHaveLength(1);
    });

    it("creates with static particles and updates the live client without recreating it", async () => {
      mirrorSettings.streamParticleMode = "static";
      mountStage();
      expect(clients[0].options.staticParticles).toBe(true);
      mirrorSettings.streamParticleMode = "dynamic";
      await nextTick();
      expect(clients[0].setStaticParticles).toHaveBeenLastCalledWith(false);
      mirrorSettings.streamParticleMode = "static";
      await nextTick();
      expect(clients[0].setStaticParticles).toHaveBeenLastCalledWith(true);
      expect(clients).toHaveLength(1);
    });
  });

  describe("landscape chrome", () => {
    let resize: () => void;
    let canvasRect: DOMRect;
    const observed = new Set<Element>();
    const originalFullscreen = Object.getOwnPropertyDescriptor(document, "fullscreenEnabled");

    beforeEach(() => {
      canvasRect = new DOMRect(60, 27, 2280, 1026);
      observed.clear();
      vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(() => canvasRect);
      vi.stubGlobal("ResizeObserver", class {
        constructor(callback: () => void) { resize = callback; }
        observe(element: Element): void { observed.add(element); }
        unobserve(element: Element): void { observed.delete(element); }
        disconnect(): void { observed.clear(); }
      });
      Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
    });

    afterEach(() => {
      mirrorSettings.panelOpen = false;
      if (originalFullscreen) Object.defineProperty(document, "fullscreenEnabled", originalFullscreen);
      else delete (document as unknown as Record<string, unknown>).fullscreenEnabled;
      vi.unstubAllGlobals();
    });

    it("reports chrome readiness once the canvas has measurable geometry, even before chrome is enabled", async () => {
      canvasRect = new DOMRect();
      mountStage();
      await nextTick();
      expect(wrapper!.emitted("chrome-ready")).toBeUndefined();

      canvasRect = new DOMRect(0, 0, 1920, 1080);
      resize();
      await nextTick();
      expect(wrapper!.emitted("chrome-ready")).toEqual([[]]);
      expect(wrapper!.find(".render-stream-gear").exists()).toBe(false);

      resize();
      await nextTick();
      expect(wrapper!.emitted("chrome-ready")).toEqual([[]]);
    });

    it("uses the measured canvas for size/position and re-anchors an open panel on resize", async () => {
      mountStage({ endpoint: { ...endpoint, presentation: [2400, 1080] }, showChrome: true });
      await nextTick();
      const gear = () => wrapper!.get(".render-stream-gear").element as HTMLElement;
      const fullscreen = () => wrapper!.get(".render-stream-fullscreen").element as HTMLElement;
      expect(gear().style.left).toBe("1162px");
      expect(gear().style.top).toBe("27px");
      expect(gear().style.transform).toBe("scale(0.95)");
      expect(fullscreen().style.left).toBe("1249.4px");
      expect(fullscreen().style.transform).toBe("scale(0.95)");
      expect(wrapper!.get('[data-testid="mirror-settings-toggle"]').classes())
        .not.toContain("settings-gear-button--compact");
      expect(wrapper!.get('[data-testid="fullscreen-button"]').classes()).not.toContain("fullscreen-button--compact");
      const canvas = wrapper!.get("canvas").element;
      expect(observed.has(canvas)).toBe(true);

      mirrorSettings.panelOpen = true;
      await nextTick();
      expect(mirrorSettings.panelAnchorTop).toBe(109);
      canvasRect = new DOMRect(70, 35, 1200, 540);
      resize();
      await nextTick();
      expect(gear().style.left).toBe("650px");
      expect(gear().style.top).toBe("35px");
      expect(gear().style.transform).toBe("scale(0.5)");
      expect(mirrorSettings.panelAnchorTop).toBe(81);
      expect(mirrorSettings.panelOpen).toBe(true);

      // A new presentation replaces the canvas; observation follows the replacement too.
      await wrapper!.setProps({ endpoint: { ...endpoint, presentation: [2340, 1080] } });
      await nextTick();
      await nextTick();
      expect(observed.has(canvas)).toBe(false);
      expect(observed.has(wrapper!.get("canvas").element)).toBe(true);
    });

    it("blocks chrome presses from stream input while canvas presses still reach it", async () => {
      const sent: MirrorInputMessage[] = [];
      mountStage({ showChrome: true, sendInput: (m: MirrorInputMessage) => sent.push(m) });
      clients[0].clientToGame = vi.fn((x: number, y: number) => ({ point: { x, y }, item: null, drawn: { x, y } }));
      const bubbled = vi.fn();
      const frame = wrapper!.get('[data-testid="render-stream-stage"]').element;
      for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) frame.addEventListener(type, bubbled);
      const mouse = (element: Element, type: string, buttons: number) => {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 20, buttons });
        Object.defineProperty(event, "pointerType", { value: "mouse" });
        Object.defineProperty(event, "pointerId", { value: 1 });
        element.dispatchEvent(event);
      };
      for (const testId of ["mirror-settings-toggle", "fullscreen-button"]) {
        const button = wrapper!.get(`[data-testid="${testId}"]`).element;
        mouse(button, "pointerdown", 1);
        mouse(button, "pointermove", 1);
        mouse(button, "pointerup", 0);
        mouse(button, "pointercancel", 0);
      }
      expect(bubbled).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
      await wrapper!.get('[data-testid="mirror-settings-toggle"]').trigger("click");
      expect(mirrorSettings.panelOpen).toBe(true);
      expect(sent).toEqual([]);
      mouse(wrapper!.get("canvas").element, "pointerdown", 1);
      mouse(wrapper!.get("canvas").element, "pointerup", 0);
      expect(sent).toHaveLength(2);
    });
  });

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

  it("attaches the raise-hand and readability modules on the viewer's saved choices", () => {
    mirrorSettings.raiseHandCards = true;
    mirrorSettings.uiScaling = true;
    mountStage();
    expect((clients[0].options.extensions ?? []).map((e) => e.id))
      .toEqual(["couchcoop.raisedHand", "couchcoop.viewScale", "couchcoop.hoverTips", "couchcoop.textScale"]);
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

  it("disposes the installed extension watchers when client construction fails", async () => {
    const disposers: ReturnType<typeof vi.fn>[] = [];
    const requestRedraw = vi.fn();
    mountStage({
      sendInput: vi.fn(),
      createClient: (options: RenderStreamClientOptions) => {
        for (const extension of options.extensions ?? []) {
          extension.onSession?.({ sessionId: "s", streamId: "s", itemMeta: null, requestRedraw, mouseFilter: vi.fn(), pickOrder: vi.fn() });
          disposers.push(vi.spyOn(extension, "dispose"));
        }
        throw new Error("no renderer");
      }
    });
    expect(wrapper!.emitted("failed")).toEqual([["receiver-error: no renderer"]]);
    for (const dispose of disposers) expect(dispose).toHaveBeenCalledOnce();
    mirrorSettings.raiseHandCards = true;
    await nextTick();
    expect(requestRedraw).not.toHaveBeenCalled();
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

    it("asks once, then replaces the client with a different descriptor", async () => {
      mountStage();
      clients[0].emit(unauthorized);
      await nextTick();
      expect(wrapper!.emitted("refresh-endpoint")).toHaveLength(1);
      expect(wrapper!.emitted("failed")).toBeUndefined();
      expect(clients[0].disposed).toBe(false);
      expect(status().text()).toBe("Connecting…");

      await wrapper!.setProps({ endpoint: fresh });
      await nextTick();
      expect(clients[0].disposed).toBe(true);
      expect(clients[1].options.endpoint).toEqual(fresh);
      expect(clients[1].connects).toBe(1);
      expect(clients).toHaveLength(2);

      // Asked once: a second refusal before anything drew is a stop.
      clients[1].emit(unauthorized);
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
      await nextTick();
      clients[1].emit({ kind: "streaming", firstFrame: true });
      clients[1].emit(unauthorized);
      await nextTick();
      expect(wrapper!.emitted("refresh-endpoint")).toHaveLength(2);
      expect(wrapper!.emitted("failed")).toBeUndefined();
    });
  });

  describe("extension modules follow the settings and the presentation mid-session", () => {
    const ids = (c: Fake) => (c.options.extensions ?? []).map((e) => e.id);

    it("toggles every module without disposing, reconnecting or replacing the canvas", async () => {
      mountStage({ sendInput: vi.fn() });
      const original = clients[0];
      const canvas = original.options.canvas;
      expect(ids(original)).toEqual([
        "couchcoop.raisedHand", "couchcoop.viewScale", "couchcoop.heldCard", "couchcoop.hoverTips", "couchcoop.textScale", "couchcoop.confirmTap", "couchcoop.pointerTargets", "couchcoop.handRaiseChrome"
      ]);
      for (const key of ["raiseHandCards", "uiScaling", "raiseHeldCard", "confirmTap"] as const) {
        for (const enabled of [true, false, true]) {
          mirrorSettings[key] = enabled;
          await nextTick();
          await nextTick();
          expect(clients).toHaveLength(1);
          expect(original.disposed).toBe(false);
          expect(original.connects).toBe(1);
          expect(wrapper!.get('[data-testid="render-stream-canvas"]').element).toBe(canvas);
        }
      }
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
      expect(ids(clients[1])).toEqual(["couchcoop.viewScale", "couchcoop.hoverTips", "couchcoop.textScale"]);
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

  it.each([[1920, 1920], [2340, 2340], [1920, 2340]])("anchors the shared confirm for presentation %i at picture width %i", async (presentationWidth, width) => {
    let canvasRect = new DOMRect(60, 100, width / 2, 540);
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(() => canvasRect);
    mirrorSettings.confirmTap = true;
    const sent: MirrorInputMessage[] = [];
    mountStage({ endpoint: { ...endpoint, presentation: [presentationWidth, 1080] }, sendInput: (m: MirrorInputMessage) => sent.push(m) });
    const fake = clients[0];
    // The tap lands on a shop item's child (20 → 10); its oversized subtree must never size the confirm button.
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

    // A node-mirror selection belongs to its own button, even while the stream is mounted.
    confirmTap.targetId = "node-mirror-option";
    await nextTick();
    expect(wrapper!.find('[data-testid="mirror-confirm-button"]').exists()).toBe(false);
    confirmTap.targetId = null;

    const canvas = wrapper!.get('[data-testid="render-stream-canvas"]').element;
    for (const type of ["pointerdown", "pointerup"]) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 640, clientY: 360, button: 0 });
      Object.defineProperty(event, "pointerType", { value: "touch" });
      Object.defineProperty(event, "pointerId", { value: 1 });
      canvas.dispatchEvent(event);
    }
    await nextTick();
    const button = () => wrapper!.find('[data-testid="mirror-confirm-button"]');
    expect(button().exists()).toBe(true);
    const component = wrapper!.getComponent(MirrorConfirmButton);
    expect(component.props("state")?.targetId).toBe(10);
    expect(confirmTap.targetId).toBeNull(); // stream input never claims the node mirror's singleton
    expect(wrapper!.find('[data-testid="render-stream-confirm-button"]').exists()).toBe(false);
    expect(button().text()).toBe("");
    expect(button().findAll(".mirror-confirm-paint")).toHaveLength(4);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await nextTick();
    const buttonStyle = (button().element as HTMLElement).style;
    expect(buttonStyle.translate).toBe("0px 0");
    expect(buttonStyle.transition).toContain("translate 350ms");
    expect(buttonStyle.right).toBe("-40px");
    expect(buttonStyle.bottom).toBe("244px");
    expect(buttonStyle.width).toBe("200px");
    expect(buttonStyle.height).toBe("110px");
    expect(width - parseFloat(buttonStyle.right) - parseFloat(buttonStyle.width)).toBe(width - 160);
    expect(1080 - parseFloat(buttonStyle.bottom) - parseFloat(buttonStyle.height)).toBe(726);
    const layer = () => wrapper!.get('[data-testid="render-stream-confirm-stage"]').element as HTMLElement;
    expect(layer().style.left).toBe("60px");
    expect(layer().style.top).toBe("100px");
    expect(layer().style.width).toBe(`${width}px`);
    expect(layer().style.height).toBe("1080px");
    expect(layer().style.transform).toBe("scale(0.5)");

    // A rotation / letterbox resize moves the whole design stage, retaining the authored slot.
    canvasRect = new DOMRect(110, 20, width, 1080);
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    expect(layer().style.left).toBe("110px");
    expect(layer().style.top).toBe("20px");
    expect(layer().style.transform).toBe("scale(1)");
    expect(fake.presentationToCss).not.toHaveBeenCalled();
    Object.assign(component.props("state")!, { belowOverlay: true });
    await nextTick();
    expect(layer().style.zIndex).toBe("-1");
    expect((button().element as HTMLElement).style.pointerEvents).toBe("none");
    Object.assign(component.props("state")!, { belowOverlay: false });
    await nextTick();
    expect(layer().style.zIndex).toBe("1");
    expect(sent).toEqual([{ kind: "hover", coordX: 640, coordY: 360 }]); // the tap only focused

    // C3: the click a browser synthesizes after that tap lands on the button that just appeared under the finger. It
    // started on the canvas, so it commits nothing; a press on the button itself does.
    await button().trigger("pointerup");
    await button().trigger("click");
    expect(sent).toEqual([{ kind: "hover", coordX: 640, coordY: 360 }]);
    expect(button().exists()).toBe(true);
    await button().trigger("pointerdown");
    await button().trigger("pointercancel");
    await button().trigger("pointerup");
    expect(sent.filter((m) => m.kind === "click")).toHaveLength(0);
    await button().trigger("pointerdown");
    await button().trigger("pointerup");
    await button().trigger("click");
    expect(sent.filter((m) => m.kind === "click")).toHaveLength(1);
    expect(sent.at(-1)).toEqual({ kind: "click", button: "left", coordX: 640, coordY: 360 });
    expect(button().exists()).toBe(true); // retained for the shared exit slide
    expect((button().element as HTMLElement).style.translate).toBe("180px 0");
  });

  it("hands a changed descriptor to the client", async () => {
    mountStage();
    const next = { ...endpoint, url: "ws://127.0.0.1:10/render-stream" };
    await wrapper!.setProps({ endpoint: next });
    await nextTick();
    expect(clients[0].disposed).toBe(true);
    expect(clients[1].options.endpoint).toEqual(next);
  });

  // C2: the pointer channel (streamInput.ts) sends through `props.sendInput` read live, so a new access generation's
  // sender gets the pointer too. It used to be handed over by value, which pinned the first generation's sender.
  describe("pointer", () => {
    const mouse = (canvas: Element, type: string, x: number, y: number, buttons: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons });
      Object.defineProperty(event, "pointerType", { value: "mouse" });
      Object.defineProperty(event, "pointerId", { value: 1 });
      canvas.dispatchEvent(event);
    };

    it("passes the streamed widget policy to touch input", () => {
      const sent: MirrorInputMessage[] = [];
      mirrorSettings.tapToFocus = true;
      mountStage({ sendInput: (m: MirrorInputMessage) => sent.push(m) });
      const fake = clients[0];
      fake.clientToGame = vi.fn((x, y) => ({ point: { x, y }, item: 7, drawn: { x, y } }));
      const policy = fake.options.extensions!.find((e) => e.id === "couchcoop.pointerTargets")!;
      policy.beforeDraw!({ query: {
        parent: () => null,
        meta: () => ({ id: 7, node: true, class: "NCard", groups: [], meta: {} })
      } } as never);
      const canvas = wrapper!.get('[data-testid="render-stream-canvas"]').element;
      for (const type of ["pointerdown", "pointerup"]) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 640, clientY: 360 });
        Object.defineProperty(event, "pointerType", { value: "touch" });
        Object.defineProperty(event, "pointerId", { value: 1 });
        canvas.dispatchEvent(event);
      }
      expect(sent).toEqual([{ kind: "hover", coordX: 640, coordY: 360 }]);
    });

    it("survives an access-generation change: the new sender gets it, a press held from before is retired silently", async () => {
      const oldSend: MirrorInputMessage[] = [];
      const newSend: MirrorInputMessage[] = [];
      mountStage({ sendInput: (m: MirrorInputMessage) => oldSend.push(m), accessGeneration: 1 });
      clients[0].clientToGame = vi.fn((x: number, y: number) => ({ point: { x: x * 2, y: y * 2 }, item: null, drawn: { x, y } }));
      const canvas = wrapper!.get('[data-testid="render-stream-canvas"]').element;
      mouse(canvas, "pointerdown", 10, 20, 1);
      mouse(canvas, "pointerup", 10, 20, 0);
      expect(oldSend).toEqual([
        { kind: "click", button: "left", pressed: true, coordX: 20, coordY: 40 },
        { kind: "click", button: "left", pressed: false, coordX: 20, coordY: 40 }
      ]);
      mouse(canvas, "pointerdown", 30, 40, 1); // still held when the generation changes

      await wrapper!.setProps({ accessGeneration: 2, sendInput: (m: MirrorInputMessage) => newSend.push(m) });
      expect(oldSend).toHaveLength(3); // retired without a release into the old generation
      expect(newSend).toEqual([]);
      mouse(canvas, "pointerup", 30, 40, 0); // the fresh channel never saw that press: nothing is owed
      expect(newSend).toEqual([]);

      mouse(canvas, "pointerdown", 50, 60, 1);
      mouse(canvas, "pointerup", 50, 60, 0);
      expect(newSend).toEqual([
        { kind: "click", button: "left", pressed: true, coordX: 100, coordY: 120 },
        { kind: "click", button: "left", pressed: false, coordX: 100, coordY: 120 }
      ]);
      expect(oldSend).toHaveLength(3);
      expect(clients).toHaveLength(1); // the client itself is untouched
    });
  });

  // C1: the keyboard and gamepad ride the stream path too, through the same GSW captures + adapter as MirrorView
  // (keyPadInput.ts), created and disposed with the client.
  describe("keyboard and gamepad", () => {
    type PadFrame = { connected: boolean; mapping: string; buttons: number[]; axes: number[] };
    let pads: PadFrame[] = [];
    const padWith = (down: number[] = []): PadFrame => ({
      connected: true, mapping: "standard", axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, (_unused, i) => (down.includes(i) ? 1 : 0))
    });
    const key = (type: string, code: string) =>
      window.dispatchEvent(new KeyboardEvent(type, { code, key: code.replace(/^Key/, "").toLowerCase() }));
    const keys = (sent: MirrorInputMessage[]) =>
      sent.filter((m) => m.kind === "key").map((m) => `${m.key}:${m.pressed ? "down" : "up"}`);
    const padEdges = (sent: MirrorInputMessage[]) =>
      sent.filter((m) => m.kind === "pad").map((m) => `${m.input}:${m.pressed ? "down" : "up"}`);

    beforeEach(() => {
      pads = [];
      mirrorSettings.keyboard = true;
      mirrorSettings.gamepad = true;
      Object.defineProperty(navigator, "getGamepads", { configurable: true, value: () => pads });
    });

    afterEach(() => {
      delete (navigator as unknown as { getGamepads?: unknown }).getGamepads;
    });

    it("forwards key edges to sendInput, and stays deaf on a view-only stage", () => {
      const sent: MirrorInputMessage[] = [];
      mountStage({ sendInput: (m: MirrorInputMessage) => sent.push(m) });
      key("keydown", "KeyE");
      key("keydown", "ShiftLeft"); // not a code the host's key map names
      key("keyup", "KeyE");
      expect(sent).toEqual([
        { kind: "key", key: "KeyE", pressed: true },
        { kind: "key", key: "KeyE", pressed: false }
      ]);
      wrapper!.unmount();
      wrapper = null;

      mountStage();
      expect(() => key("keydown", "KeyE")).not.toThrow();
    });

    it("draws with input disabled, then enables input without replacing the client", async () => {
      vi.useFakeTimers();
      const sent: MirrorInputMessage[] = [];
      pads = [padWith()];
      mountStage({ sendInput: (m: MirrorInputMessage) => sent.push(m), inputEnabled: false });
      key("keydown", "KeyE");
      key("keyup", "KeyE");
      pads = [padWith([0])];
      await vi.advanceTimersByTimeAsync(50);
      expect(sent).toEqual([]);
      clients[0].emit({ kind: "streaming", firstFrame: true });
      expect(wrapper!.emitted("first-frame")).toHaveLength(1);
      await wrapper!.setProps({ inputEnabled: true });
      await vi.advanceTimersByTimeAsync(50);
      expect(sent).toEqual([]); // a pad held during the handover is neutralized
      key("keydown", "KeyE");
      key("keyup", "KeyE");
      expect(keys(sent)).toEqual(["KeyE:down", "KeyE:up"]);
      pads = [padWith()];
      await vi.advanceTimersByTimeAsync(50);
      pads = [padWith([0])];
      await vi.advanceTimersByTimeAsync(50);
      expect(padEdges(sent)).toEqual(["faceSouth:down"]);
      expect(clients).toHaveLength(1);
      expect(clients[0].disposed).toBe(false);
      await wrapper!.setProps({ inputEnabled: false });
      const count = sent.length;
      key("keydown", "KeyA");
      expect(sent).toHaveLength(count);
      expect(padEdges(sent)).toEqual(["faceSouth:down"]);
    });

    it("retires held keys silently on a presentation replacement", async () => {
      vi.useFakeTimers();
      const sent: MirrorInputMessage[] = [];
      mountStage({ sendInput: (m: MirrorInputMessage) => sent.push(m) });
      key("keydown", "KeyA");
      setVisibility("hidden");
      expect(keys(sent)).toEqual(["KeyA:down", "KeyA:up"]);
      await vi.advanceTimersByTimeAsync(60_000); // the hidden dispose
      setVisibility("visible");
      await nextTick();
      expect(clients).toHaveLength(2);
      sent.length = 0;

      key("keydown", "KeyD");
      await wrapper!.setProps({ endpoint: { ...endpoint, presentation: [2340, 1080] } });
      await nextTick();
      await nextTick();
      expect(clients).toHaveLength(3);
      expect(keys(sent)).toEqual(["KeyD:down"]);
      key("keyup", "KeyD"); // the new capture never latched it: no second release
      key("keydown", "KeyW");
      expect(keys(sent)).toEqual(["KeyD:down", "KeyW:down"]);

      wrapper!.unmount();
      wrapper = null;
      expect(keys(sent)).toEqual(["KeyD:down", "KeyW:down"]);
      key("keydown", "KeyE");
      expect(sent).toHaveLength(2);
    });

    it("releases what is held when a setting goes off, and listens again when it comes back", async () => {
      const sent: MirrorInputMessage[] = [];
      mountStage({ sendInput: (m: MirrorInputMessage) => sent.push(m) });
      key("keydown", "KeyE");
      mirrorSettings.keyboard = false;
      await nextTick();
      expect(keys(sent)).toEqual(["KeyE:down", "KeyE:up"]);
      key("keydown", "KeyE");
      expect(sent).toHaveLength(2);
      mirrorSettings.keyboard = true;
      await nextTick();
      key("keydown", "KeyE");
      expect(keys(sent)).toEqual(["KeyE:down", "KeyE:up", "KeyE:down"]);
    });

    it("sends pad edges, and a new access generation retires the pair silently and neutralizes a held pad", async () => {
      vi.useFakeTimers();
      const oldSend: MirrorInputMessage[] = [];
      const newSend: MirrorInputMessage[] = [];
      pads = [padWith()];
      mountStage({ sendInput: (m: MirrorInputMessage) => oldSend.push(m), accessGeneration: 1 });
      await vi.advanceTimersByTimeAsync(50);
      pads = [padWith([0])];
      await vi.advanceTimersByTimeAsync(50);
      key("keydown", "KeyA");
      expect(padEdges(oldSend)).toEqual(["faceSouth:down"]);
      expect(keys(oldSend)).toEqual(["KeyA:down"]);

      await wrapper!.setProps({ accessGeneration: 2, sendInput: (m: MirrorInputMessage) => newSend.push(m) });
      await vi.advanceTimersByTimeAsync(50);
      // Retired without a word (no release edges into either generation), and the button still held from before
      // the resume is not pressed into the resumed game.
      expect(oldSend).toHaveLength(2);
      expect(newSend).toEqual([]);
      pads = [padWith()];
      await vi.advanceTimersByTimeAsync(50);
      pads = [padWith([0])];
      await vi.advanceTimersByTimeAsync(50);
      expect(padEdges(newSend)).toEqual(["faceSouth:down"]);
      expect(clients).toHaveLength(1); // the client itself is untouched
    });
  });
});


describe("stream hand-raise button", () => {
  let now = 10_000;
  beforeEach(() => {
    __resetHandRaiseUiForTest();
    now = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(60, 27, 1170, 540));
    vi.stubGlobal("Image", class {
      decoding = "";
      src = "";
      decode() { return Promise.resolve(); }
      addEventListener() {}
      removeEventListener() {}
    });
  });
  afterEach(() => {
    __resetHandRaiseUiForTest();
    __resetStageFitForTest();
    clearStoredMirrorSettings();
    vi.unstubAllGlobals();
  });

  function pointer(type: string, id = 1) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      pointerId: { value: id }, pointerType: { value: "touch" }, isPrimary: { value: true }, button: { value: 0 }
    });
    wrapper!.get('[data-testid="mirror-hand-raise-button"]').element.dispatchEvent(event);
  }

  // Vue may write the filter through its WebKit alias.
  function stageFilter(stage: HTMLElement): string {
    return stage.style.filter || stage.style.getPropertyValue("-webkit-filter");
  }

  function handFrame(overlay?: keyof typeof handCoverScreens) {
    const fake = clients[0];
    const presence = fake.options.extensions!.find((e) => e.id === "couchcoop.handRaiseChrome")!;
    const raise = fake.options.extensions!.find((e) => e.id === "couchcoop.raisedHand")!;
    const rows: ItemMeta[] = [
      { id: 1, node: true, groups: [RS_GROUP_HAND_ROOT], meta: {} },
      { id: 2, node: true, groups: [RS_GROUP_HAND_CONTAINER], meta: {} },
      { id: 3, node: true, groups: [RS_GROUP_HAND_HOLDER], meta: {} }
    ];
    if (overlay) rows.push({ id: 90, node: true, groups: [RS_GROUP_HAND_COVER], meta: {}, path: overlay });
    for (const e of [presence, raise]) e.onItemMeta!({ form: "full", items: rows });
    let visible = true;
    let covered = false;
    let overlayVisible = true;
    const query: ItemQuery = {
      parent: (id) => id === 3 ? 2 : id === 2 ? 1 : null,
      children: () => new Uint32Array(),
      transform: (id) => [1, 0, 0, 1, 0, id === 3 ? 941 : 1000],
      rect: (id) => id === 90 ? { x: 0, y: 0, w: 300, h: 200 } : { x: 400, y: 900, w: 100, h: 120 },
      subtreeRect: () => null, visible: (id) => id === 90 ? overlayVisible : visible,
      meta: (id) => rows.find((row) => row.id === id) ?? null, hitTest: () => covered ? 99 : 3
    };
    const offsets = new Map<number, number>();
    const overrides: OverrideTable = {
      translate: (id, _x, y) => { offsets.set(id, y); },
      clear: (id) => { offsets.delete(id); },
      set: vi.fn(), scaleAbout: vi.fn(), setGlobal: vi.fn(), freeze: vi.fn(), clearAll: vi.fn(),
      get: () => null, effective: () => [1, 0, 0, 1, 0, 0], size: 0
    };
    const frame: ExtensionFrame = { seq: 1, now, query, overrides, requestRedraw: vi.fn() };
    return { presence, raise, frame, offsets, hide() { visible = false; }, cover(value: boolean) { covered = value; },
      hideOverlay() { overlayVisible = false; } };
  }

  // The seat's tagger tests read the same cases, so these roots must actually receive the cover group.
  it.each(Object.keys(handCoverScreens) as (keyof typeof handCoverScreens)[])("keeps hand chrome visible, dimmed and input-less under %s even when the holder centre is uncovered", async (overlay) => {
    const sent: MirrorInputMessage[] = [];
    mountStage({ sendInput: (m: MirrorInputMessage) => sent.push(m) });
    const h = handFrame(overlay);
    h.presence.beforeDraw!(h.frame);
    await flushPromises();
    const button = () => wrapper!.get('[data-testid="mirror-hand-raise-button"]');
    const stage = () => wrapper!.get('[data-testid="render-stream-hand-raise-stage"]').element as HTMLElement;
    expect(button().classes()).toContain("mirror-hand-raise--blocked");
    expect((button().element as HTMLElement).style.pointerEvents).toBe("none");
    expect(stage().style.zIndex).toBe("1");
    expect(stageFilter(stage())).toBe("brightness(0.15)");
    const chrome = wrapper!.get('[data-testid="mirror-hand-raise-chrome"]').element as HTMLElement;
    expect(stage().contains(chrome)).toBe(true);
    expect(chrome.style.visibility).toBe("");
    expect(chrome.style.display).toBe("");
    expect(chrome.style.pointerEvents).toBe("none");
    pointer("pointerdown");
    now += 100;
    pointer("pointerup");
    expect(mirrorSettings.raiseHandCards).toBe(false);
    expect(handRaiseUi.pressOverride).toBeNull();

    // The non-interactive chrome leaves the same canvas input path available at the HUD slot.
    clients[0].clientToGame = vi.fn((x: number, y: number) => ({ point: { x, y }, item: null, drawn: { x, y } }));
    for (const [type, buttons] of [["pointerdown", 1], ["pointerup", 0]] as const) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 1130, clientY: 542, buttons });
      Object.defineProperties(event, { pointerType: { value: "mouse" }, pointerId: { value: 1 } });
      wrapper!.get("canvas").element.dispatchEvent(event);
    }
    expect(sent.map(({ kind, pressed, coordX, coordY }) => [kind, pressed, coordX, coordY]))
      .toEqual([["click", true, 1130, 542], ["click", false, 1130, 542]]);
    h.hideOverlay();
    h.presence.beforeDraw!({ ...h.frame, seq: 2 });
    await nextTick();
    expect(button().classes()).not.toContain("mirror-hand-raise--blocked");
    expect(stage().style.zIndex).toBe("1");
    expect(stageFilter(stage())).toBe("");
    expect((button().element as HTMLElement).style.pointerEvents).toBe("auto");
    pointer("pointerdown");
    now += 100;
    pointer("pointerup");
    expect(mirrorSettings.raiseHandCards).toBe(true);
  });

  it.each([1920, 2340])("anchors the shared button to a %i-wide picture, and hides it without a visible combat hand", async (width) => {
    // A previous mirror can leave display-layout state behind; stream chrome remains in design pixels.
    activateDisplayLayout(true);
    setLayoutScale(0.4);
    mountStage({ endpoint: { ...endpoint, presentation: [width, 1080] }, sendInput: vi.fn() });
    expect(wrapper!.find('[data-testid="mirror-hand-raise-button"]').exists()).toBe(false);
    const h = handFrame();
    h.presence.beforeDraw!(h.frame);
    await flushPromises();
    const button = wrapper!.get('[data-testid="mirror-hand-raise-button"]').element as HTMLElement;
    const stage = wrapper!.get('[data-testid="render-stream-hand-raise-stage"]').element as HTMLElement;
    const chrome = wrapper!.get('[data-testid="mirror-hand-raise-chrome"]').element as HTMLElement;
    expect(stage.style.left).toBe("60px");
    expect(stage.style.top).toBe("27px");
    expect(stage.style.width).toBe("2340px");
    expect(stage.style.height).toBe("1080px");
    expect(stage.style.transform).toBe("scale(0.5)");
    expect(parseFloat(button.style.right)).toBeCloseTo(145 + 2 * 109 / 170);
    expect(parseFloat(button.style.bottom)).toBeCloseTo(7 + 5 * 109 / 148);
    expect(chrome.style.right).toBe(button.style.right);
    expect(chrome.style.bottom).toBe(button.style.bottom);
    expect(chrome.style.transform).toBe("");
    expect(stage.contains(chrome)).toBe(true);
    expect(button.style.pointerEvents).toBe("auto");
    expect(stage.style.zIndex).toBe("1");
    expect(stageFilter(stage)).toBe("");
    h.hide();
    h.presence.beforeDraw!({ ...h.frame, seq: 2 });
    await nextTick();
    expect(wrapper!.find('[data-testid="mirror-hand-raise-button"]').exists()).toBe(false);
  });

  it("blocks and dims the button under game overlays, cancelling a hold without saving", async () => {
    mountStage({ sendInput: vi.fn() });
    const h = handFrame();
    h.presence.beforeDraw!(h.frame);
    await flushPromises();
    pointer("pointerdown");
    expect(handRaiseUi.pressOverride).toBe(true);
    h.cover(true);
    h.presence.beforeDraw!({ ...h.frame, seq: 2 });
    await nextTick();
    const button = () => wrapper!.get('[data-testid="mirror-hand-raise-button"]');
    const stage = () => wrapper!.get('[data-testid="render-stream-hand-raise-stage"]').element as HTMLElement;
    expect(button().classes()).toContain("mirror-hand-raise--blocked");
    expect(stage().style.zIndex).toBe("1");
    expect(stageFilter(stage())).toBe("brightness(0.15)");
    expect(handRaiseUi.pressOverride).toBeNull();
    pointer("pointerup");
    pointer("pointerdown");
    now += 100;
    pointer("pointerup");
    expect(handRaiseUi.pressOverride).toBeNull();
    expect(mirrorSettings.raiseHandCards).toBe(false);
    h.cover(false);
    h.presence.beforeDraw!({ ...h.frame, seq: null });
    await nextTick();
    expect(stage().style.zIndex).toBe("1");
    expect(stageFilter(stage())).toBe("brightness(0.15)");
    h.presence.beforeDraw!({ ...h.frame, seq: 3 });
    await nextTick();
    expect(button().classes()).not.toContain("mirror-hand-raise--blocked");
    expect(stage().style.zIndex).toBe("1");
    expect(stageFilter(stage())).toBe("");
    expect((button().element as HTMLElement).style.pointerEvents).toBe("auto");
    pointer("pointerdown");
    now += 100;
    pointer("pointerup");
    expect(mirrorSettings.raiseHandCards).toBe(true);
    expect(clients).toHaveLength(1);
  });

  it.each([false, true])("tap at 400ms persists (the old renderer's threshold), a 401ms hold restores, and cancellation retires the override (saved=%s)", async (saved) => {
    mirrorSettings.raiseHandCards = saved;
    const sent: MirrorInputMessage[] = [];
    mountStage({ sendInput: (m: MirrorInputMessage) => sent.push(m) });
    const h = handFrame();
    h.presence.beforeDraw!(h.frame);
    await flushPromises();
    pointer("pointerdown");
    h.raise.beforeDraw!(h.frame);
    expect(h.offsets.get(3) ?? 0).toBe(saved ? 0 : -119);
    expect(mirrorSettings.raiseHandCards).toBe(saved);
    now += 400;
    pointer("pointerup");
    expect(mirrorSettings.raiseHandCards).toBe(!saved);
    expect(handRaiseUi.pressOverride).toBeNull();
    pointer("pointerdown");
    h.raise.beforeDraw!(h.frame);
    expect(h.offsets.get(3) ?? 0).toBe(saved ? -119 : 0);
    now += 401;
    pointer("pointerup");
    h.raise.beforeDraw!(h.frame);
    expect(h.offsets.get(3) ?? 0).toBe(saved ? 0 : -119);
    expect(mirrorSettings.raiseHandCards).toBe(!saved);
    pointer("pointerdown");
    pointer("pointercancel");
    expect(handRaiseUi.pressOverride).toBeNull();
    expect(mirrorSettings.raiseHandCards).toBe(!saved);
    pointer("pointerdown");
    await wrapper!.setProps({ inputEnabled: false });
    expect(handRaiseUi.pressOverride).toBeNull();
    expect(wrapper!.find('[data-testid="mirror-hand-raise-button"]').exists()).toBe(false);
    expect(sent).toEqual([]);
    expect(clients).toHaveLength(1);
    expect(clients[0].disposed).toBe(false);
  });
});

describe("presentation replacement", () => {
  it("waits for the current client's frame when input is enabled before it draws", async () => {
    const sent: MirrorInputMessage[] = [];
    mountStage({ presentationEpoch: 7, inputEnabled: false,
      sendInput: (m: MirrorInputMessage) => sent.push(m) });
    const press = () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyQ" }));
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyQ" }));
    };
    await wrapper!.setProps({ inputEnabled: true });
    press();
    expect(sent).toEqual([]);

    clients[0].emit({ kind: "streaming", firstFrame: true });
    press();
    expect(sent).toMatchObject([
      { kind: "key", key: "KeyQ", pressed: true, presentationEpoch: 7 },
      { kind: "key", key: "KeyQ", pressed: false, presentationEpoch: 7 }
    ]);
  });

  it("stamps displayed epochs and silently retires held input on replacement", async () => {
    const sent: MirrorInputMessage[] = [];
    mountStage({ presentationEpoch: 3, sendInput: (m: MirrorInputMessage) => sent.push(m) });
    const key = (type: string, code = "KeyE") => window.dispatchEvent(new KeyboardEvent(type, { code }));
    key("keydown");
    expect(sent).toEqual([]);
    clients[0].emit({ kind: "streaming", firstFrame: true });
    key("keydown");
    expect(sent).toMatchObject([{ kind: "key", key: "KeyE", pressed: true, presentationEpoch: 3 }]);
    sent.length = 0;
    await wrapper!.setProps({ presentationEpoch: 4 });
    await nextTick();
    key("keyup");
    expect(sent).toEqual([]);
    clients[1].emit({ kind: "streaming", firstFrame: true });
    key("keydown", "KeyQ");
    key("keyup", "KeyQ");
    expect(sent).toMatchObject([
      { kind: "key", key: "KeyQ", pressed: true, presentationEpoch: 4 },
      { kind: "key", key: "KeyQ", pressed: false, presentationEpoch: 4 }
    ]);
  });

  it("reports a first frame for each client and ignores retired status callbacks", async () => {
    mountStage({ presentationEpoch: 1 });
    clients[0].emit({ kind: "streaming", firstFrame: true });
    expect(wrapper!.emitted("first-frame")).toHaveLength(1);
    await wrapper!.setProps({ presentationEpoch: 2 });
    await nextTick();
    expect(clients).toHaveLength(2);
    clients[0].emit({ kind: "streaming", firstFrame: true });
    clients[0].emit({ kind: "ended" });
    expect(wrapper!.emitted("failed")).toBeUndefined();
    expect(wrapper!.emitted("first-frame")).toHaveLength(1);
    clients[1].emit({ kind: "streaming", firstFrame: true });
    expect(wrapper!.emitted("first-frame")).toHaveLength(2);
  });

  it("treats presentation and carrier changes as a new unauthorized descriptor", async () => {
    mountStage();
    clients[0].emit({ kind: "failed", reason: "live-connect-failed", detail: "unauthorized" });
    await wrapper!.setProps({ endpoint: { ...endpoint, webTransport: {
      url: "https://localhost:9/render-stream", certificateHashes: ["a".repeat(64)]
    } } });
    await nextTick();
    expect(clients).toHaveLength(2);
    expect(wrapper!.emitted("failed")).toBeUndefined();
    clients[1].emit({ kind: "streaming", firstFrame: true });
    clients[1].emit({ kind: "failed", reason: "live-connect-failed", detail: "unauthorized" });
    await wrapper!.setProps({ endpoint: { ...endpoint, presentation: [2340, 1080] } });
    await nextTick();
    expect(clients).toHaveLength(3);
    expect(wrapper!.emitted("failed")).toBeUndefined();
  });
});

describe("tunnel render-stream transport", () => {
  it("passes a transport for stream control, binary records and SW-prefixed resource reads", async () => {
    const base = `${location.origin}/~h/abcdefghijklmnopqrstuv`;
    let socket!: WebSocket;
    const sent: string[] = [];
    const close = vi.fn();
    const Socket = class {
      static OPEN = 1;
      readyState = 1;
      binaryType = "blob";
      onopen: WebSocket["onopen"] = null;
      onmessage: WebSocket["onmessage"] = null;
      onclose: WebSocket["onclose"] = null;
      onerror: WebSocket["onerror"] = null;
      constructor(readonly url: string, readonly protocols: string[]) { socket = this as unknown as WebSocket; }
      send(text: string) { sent.push(text); }
      close = close;
    } as unknown as typeof WebSocket;
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } }));
    globalThis.__couchCoopTunnel = { WebSocket: Socket, fetch: fetcher, closed: new Promise(() => {}) };
    try {
      mountStage();
      await nextTick();
      const factory = clients[0]!.options.transport;
      expect(factory).toBeTypeOf("function");
      const on = { open: vi.fn(), message: vi.fn(), close: vi.fn() };
      const transport = factory!({ ...endpoint, url: `${base.replace(/^http/, "ws")}/render-stream/seat`, resourceBase: base }, "grc/16", on);
      expect(socket.url).toBe(`${base.replace(/^http/, "ws")}/render-stream/seat`);
      socket.onopen?.call(socket, new Event("open"));
      expect(on.open).toHaveBeenCalledOnce();
      const binary = new Uint8Array([7]).buffer;
      socket.onmessage?.call(socket, new MessageEvent("message", { data: binary }));
      expect(on.message).toHaveBeenCalledWith(binary);
      transport.send("hello");
      expect(sent).toEqual(["hello"]);
      const signal = new AbortController().signal;
      const response = await transport.fetchResource("/res/card", { token: "pin", signal, stream: true });
      expect(fetcher).toHaveBeenCalledWith(`${base}/res/card`, { headers: { Authorization: "Bearer pin" }, signal, cache: "default", credentials: "omit" });
      expect(response.status).toBe(200);
      expect(response.stream).toBeInstanceOf(ReadableStream);
      expect(response.sizeHint).toBe(3);
      transport.close(1000, "done");
      expect(close).toHaveBeenCalledWith(1000, "done");
      socket.onclose?.call(socket, new CloseEvent("close", { code: 1006 }));
      expect(on.close).toHaveBeenCalledWith(1006, "");
    } finally { delete globalThis.__couchCoopTunnel; }
  });

  it("leaves direct transport selection unchanged without a tunnel", async () => {
    mountStage();
    await nextTick();
    expect(clients[0]!.options.transport).toBeUndefined();
  });
});
