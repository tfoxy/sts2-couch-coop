import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import FullscreenButton from "@/components/FullscreenButton.vue";
import { shouldUseFixedChrome } from "@/composables/usePortraitViewport";
import MirrorApp from "@/mirror/MirrorApp.vue";

// R10 WS-A task 4: the pre-join picker carries BOTH browser-space controls — the settings gear on the exact
// centre line and the fullscreen button beside it — so a phone can go full-bleed before it joins. The button's
// own `isSupported` gate is what keeps it off browsers where it would do nothing (iOS Safari on iPhone, a
// sandboxed frame); on the picker there is no game UI to explain a dead control, which is why that gate matters
// more here than in the top bar.

class MockWebSocket extends EventTarget {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.OPEN;
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send(): void {}

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

function setFullscreenEnabled(value: boolean): void {
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value });
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
};

let realWebSocket: unknown;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  globalThis.sessionStorage?.clear();
  MockWebSocket.instances = [];
  realWebSocket = globalThis.WebSocket;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
  setFullscreenEnabled(true);
});

afterEach(() => {
  app?.unmount();
  app = null;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket;
  delete (document as unknown as Record<string, unknown>).fullscreenEnabled;
  delete (document as unknown as Record<string, unknown>).fullscreenElement;
  vi.restoreAllMocks();
});

describe("MirrorApp — pre-join picker chrome", () => {
  it("mounts the settings gear AND the fullscreen button, both compact", async () => {
    app = mount(MirrorApp);
    await settle();

    const gear = app.get('[data-testid="mirror-settings-toggle"]');
    const fullscreen = app.get('[data-testid="fullscreen-button"]');
    expect(gear.classes()).toContain("settings-gear-button--compact");
    expect(fullscreen.classes()).toContain("fullscreen-button--compact");
    // Placed as SIBLING chrome layers: the gear owns the centre line, fullscreen is offset to its right, so
    // adding (or dropping) the second button can never move the settings control off centre.
    expect(app.find(".mirror-chrome-gear").exists()).toBe(true);
    expect(app.find(".mirror-chrome-fullscreen").exists()).toBe(true);
    // …and it is BROWSER chrome, outside the letterboxed stage. That placement is the whole point in
    // portrait (it neither shrinks with --godot-scale nor rides the letterbox) and it is also why the pair
    // needs no pointer-event guard: inputCapture binds to the stage element, not the document.
    expect(app.find(".mirror-stage .mirror-chrome-gear").exists()).toBe(false);
  });

  it("renders NO fullscreen button where the Fullscreen API is unavailable (the gear stays)", async () => {
    setFullscreenEnabled(false);
    app = mount(MirrorApp);
    await settle();

    expect(app.find('[data-testid="mirror-settings-toggle"]').exists()).toBe(true);
    expect(app.find('[data-testid="fullscreen-button"]').exists()).toBe(false);
  });
});

// R19 WP-2a. The pair used to jump the instant the scene appeared: fixed 44px browser chrome pre-join, then
// 80 DESIGN px INSIDE the letterboxed stage, so on a phone it shrank with --godot-scale and moved with the
// letterbox. The fullscreen button is the worst case of that, because pressing it is also what rotates the
// phone — the control that gets you out of portrait must not be hard to hit while you are in it.
describe("shouldUseFixedChrome — where the gear + fullscreen pair lives", () => {
  it("uses the fixed placement pre-game whatever the orientation", () => {
    // There is no stage to put a button inside yet, and this is the placement the feature is defined
    // against: "keep it where the loading screen had it".
    expect(shouldUseFixedChrome(false, true)).toBe(true);
    expect(shouldUseFixedChrome(false, false)).toBe(true);
  });

  it("keeps the fixed placement in portrait once the game is up", () => {
    expect(shouldUseFixedChrome(true, true)).toBe(true);
  });

  it("hands the pair back to the stage in landscape", () => {
    // Landscape is where the in-stage placement is fine: the stage is wide, the buttons are legible, and
    // they sit with the game's own top bar.
    expect(shouldUseFixedChrome(true, false)).toBe(false);
  });

  it("is exhaustive and mutually exclusive with the in-stage placement", () => {
    // The in-stage pair is the literal complement in MirrorApp, so this is what rules out two gears (two
    // settings panels fighting over one panelAnchorTop) and rules out none at all.
    for (const scene of [true, false]) {
      for (const portrait of [true, false]) {
        const fixed = shouldUseFixedChrome(scene, portrait);
        const inStage = scene && !fixed;
        expect(fixed && inStage).toBe(false);
        expect(fixed || inStage).toBe(true);
      }
    }
  });
});

describe("FullscreenButton — compact placement", () => {
  it("shrinks to the gear's 44px chrome box, same glyph and behavior", async () => {
    setFullscreenEnabled(true);
    const inStage = mount(FullscreenButton);
    const compact = mount(FullscreenButton, { props: { compact: true } });

    expect(inStage.get("button").classes()).not.toContain("fullscreen-button--compact");
    expect(compact.get("button").classes()).toContain("fullscreen-button--compact");
    expect(compact.findAll("svg path")).toHaveLength(4);

    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = requestFullscreen;
    await compact.get('[data-testid="fullscreen-button"]').trigger("click");
    expect(requestFullscreen).toHaveBeenCalledTimes(1);

    inStage.unmount();
    compact.unmount();
    delete (document.documentElement as unknown as Record<string, unknown>).requestFullscreen;
  });

  it("stays hidden in compact form too when fullscreen is unsupported", () => {
    setFullscreenEnabled(false);
    const wrapper = mount(FullscreenButton, { props: { compact: true } });
    expect(wrapper.find('[data-testid="fullscreen-button"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
