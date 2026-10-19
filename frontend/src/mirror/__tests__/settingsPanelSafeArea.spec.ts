import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SettingsPanel from "@/mirror/SettingsPanel.vue";
import { mirrorSettings, MIRROR_SETTINGS_STORAGE_KEY, readStoredMirrorSettings } from "@/mirror/mirrorSettings";

const selector = '[data-testid="mirror-safe-area-padding"]';
const latency = {
  lastMs: null, p50: null, p95: null, count: 0,
  gameLastMs: null, gameP50: null, gameP95: null, gameCount: 0
};
let wrapper: VueWrapper | undefined;
let insets: [number, number, number, number];
let resize: () => void;
let visualViewport: EventTarget;
let orientation: EventTarget;
const observe = vi.fn();
const disconnect = vi.fn();

beforeEach(() => {
  insets = [0, 0, 0, 0];
  localStorage.clear();
  mirrorSettings.panelOpen = true;
  mirrorSettings.safeAreaPaddingEnabled = false;
  visualViewport = new EventTarget();
  orientation = new EventTarget();
  vi.stubGlobal("visualViewport", visualViewport);
  vi.stubGlobal("screen", { orientation });
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  const original = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    if (!(element instanceof HTMLElement) || !element.hasAttribute("data-safe-area-probe")) {
      return original(element, pseudo);
    }
    return {
      paddingTop: `${insets[0]}px`, paddingRight: `${insets[1]}px`,
      paddingBottom: `${insets[2]}px`, paddingLeft: `${insets[3]}px`
    } as CSSStyleDeclaration;
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  mirrorSettings.panelOpen = false;
  mirrorSettings.safeAreaPaddingEnabled = false;
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  observe.mockClear();
  disconnect.mockClear();
});

async function mountPanel() {
  wrapper = mount(SettingsPanel, { props: { latency } });
  await nextTick();
  return wrapper;
}

describe("safe-area padding control", () => {
  it("hides the row when all raw insets are zero, even if padding was selected", async () => {
    mirrorSettings.safeAreaPaddingEnabled = true;
    const panel = await mountPanel();
    expect(panel.find(selector).exists()).toBe(false);
    expect(mirrorSettings.safeAreaPaddingEnabled).toBe(true);
    expect(localStorage.getItem(MIRROR_SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it.each([0, 1, 2, 3])("shows the row for nonzero edge %i even with padding disabled", async (edge) => {
    insets[edge] = 0.5;
    const panel = await mountPanel();
    expect(panel.get(selector).element).toHaveProperty("checked", false);
    const safeRow = panel.get(selector).element.closest(".settings-item");
    const stretchRow = panel.get('[data-testid="mirror-stretch"]').element.closest(".settings-item");
    expect(safeRow?.nextElementSibling).toBe(stretchRow);
  });

  it("explains the choice without changing it", async () => {
    insets[2] = 21;
    const panel = await mountPanel();
    await panel.get('[data-testid="mirror-help-safeAreaPadding"]').trigger("click");
    expect(panel.get('[data-testid="mirror-help-bubble-safeAreaPadding"]').text()).toBe(
      "Keep the game clear of screen cutouts and the home indicator. Turn off to use more of the screen."
    );
    expect(mirrorSettings.safeAreaPaddingEnabled).toBe(false);
  });

  it("applies and persists just the choice; hiding and showing retains it", async () => {
    localStorage.setItem(MIRROR_SETTINGS_STORAGE_KEY, JSON.stringify({ stretchEnabled: false, audio: true }));
    insets[0] = 47;
    const panel = await mountPanel();
    await panel.get(selector).setValue(true);
    expect(mirrorSettings.safeAreaPaddingEnabled).toBe(true);
    expect(readStoredMirrorSettings()).toEqual({ stretchEnabled: false, audio: true, safeAreaPaddingEnabled: true });
    await panel.get(selector).setValue(false);
    expect(mirrorSettings.safeAreaPaddingEnabled).toBe(false);
    expect(panel.find(selector).exists()).toBe(true);
    const saved = localStorage.getItem(MIRROR_SETTINGS_STORAGE_KEY);
    insets = [0, 0, 0, 0];
    resize();
    await nextTick();
    expect(panel.find(selector).exists()).toBe(false);
    expect(localStorage.getItem(MIRROR_SETTINGS_STORAGE_KEY)).toBe(saved);
    insets[3] = 47;
    resize();
    await nextTick();
    expect(panel.get(selector).element).toHaveProperty("checked", false);
    expect(localStorage.getItem(MIRROR_SETTINGS_STORAGE_KEY)).toBe(saved);
  });

  it.each([
    "resize", "orientationchange", "pageshow", "visualViewport", "orientation",
    "fullscreenchange", "webkitfullscreenchange", "observer"
  ])("remeasures after %s", async (event) => {
    const panel = await mountPanel();
    const signal = () => {
      if (event === "observer") resize();
      else if (event === "visualViewport") visualViewport.dispatchEvent(new Event("resize"));
      else if (event === "orientation") orientation.dispatchEvent(new Event("change"));
      else if (event.includes("fullscreen")) document.dispatchEvent(new Event(event));
      else window.dispatchEvent(new Event(event));
    };
    insets[1] = 59;
    signal();
    await nextTick();
    expect(panel.find(selector).exists()).toBe(true);
    insets[1] = 0;
    signal();
    await nextTick();
    expect(panel.find(selector).exists()).toBe(false);
  });

  it("observes the probe's padded box and cleans up on unmount", async () => {
    await mountPanel();
    const probe = document.querySelector("[data-safe-area-probe]");
    expect(probe).not.toBeNull();
    expect(observe).toHaveBeenCalledWith(probe, { box: "border-box" });
    const windowRemove = vi.spyOn(window, "removeEventListener");
    const documentRemove = vi.spyOn(document, "removeEventListener");
    const viewportRemove = vi.spyOn(visualViewport, "removeEventListener");
    const orientationRemove = vi.spyOn(orientation, "removeEventListener");
    wrapper!.unmount();
    wrapper = undefined;
    expect(document.querySelector("[data-safe-area-probe]")).toBeNull();
    expect(disconnect).toHaveBeenCalledOnce();
    for (const name of ["resize", "orientationchange", "pageshow"]) {
      expect(windowRemove).toHaveBeenCalledWith(name, expect.any(Function));
    }
    for (const name of ["fullscreenchange", "webkitfullscreenchange"]) {
      expect(documentRemove).toHaveBeenCalledWith(name, expect.any(Function));
    }
    expect(viewportRemove).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(orientationRemove).toHaveBeenCalledWith("change", expect.any(Function));
  });
});
