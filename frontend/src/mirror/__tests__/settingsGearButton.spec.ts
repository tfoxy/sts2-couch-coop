import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import SettingsGearButton from "@/components/SettingsGearButton.vue";
import SettingsPanel from "@/mirror/SettingsPanel.vue";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import type { MirrorLatency } from "@/mirror/mirrorClient";

// The settings TOGGLE moved out of the panel: the left-edge semicircle tab is gone, replaced by a gear button
// that is FullscreenButton's twin (same 80x80 design-px box, same opacity curve, inline SVG), mounted at the
// stage's exact horizontal centre in game and as browser-space chrome on the picker. The panel it opens is now a
// dropdown hanging from whichever gear was pressed.
//
// These cases pin the parts a live-QA screenshot can't: the testid every driver/spec uses, the open/close
// contract, the measured anchor, and the fact that the panel no longer renders a toggle of its own.

const latency: MirrorLatency = {
  lastMs: 28,
  p50: 12,
  p95: 30,
  count: 7,
  gameLastMs: null,
  gameP50: null,
  gameP95: null,
  gameCount: 0
};

beforeEach(() => {
  mirrorSettings.panelOpen = false;
  mirrorSettings.panelAnchorTop = 56;
});

afterEach(() => {
  mirrorSettings.panelOpen = false;
  mirrorSettings.panelAnchorTop = 56;
});

describe("SettingsGearButton", () => {
  it("keeps the toggle testid the drivers and specs address", () => {
    const wrapper = mount(SettingsGearButton);
    const button = wrapper.get('[data-testid="mirror-settings-toggle"]');
    expect(button.attributes("aria-label")).toBe("Settings");
    expect(button.attributes("aria-expanded")).toBe("false");
    // An inline SVG glyph, like FullscreenButton — never a text/emoji gear (it must stay crisp at any stage scale
    // and must not depend on a font the phone may not have).
    expect(button.find("svg").exists()).toBe(true);
    expect(button.text()).toBe("");
  });

  it("toggles the shared store both ways and reports it through aria-expanded", async () => {
    const wrapper = mount(SettingsGearButton);
    const button = wrapper.get('[data-testid="mirror-settings-toggle"]');

    await button.trigger("click");
    expect(mirrorSettings.panelOpen).toBe(true);
    expect(button.attributes("aria-expanded")).toBe("true");

    await button.trigger("click");
    expect(mirrorSettings.panelOpen).toBe(false);
  });

  it("writes its own measured bottom edge as the dropdown anchor", async () => {
    const wrapper = mount(SettingsGearButton, { attachTo: document.body });
    const button = wrapper.get('[data-testid="mirror-settings-toggle"]');
    // jsdom has no layout, so stub the rect the way a real 80px button under a scaled stage would report it.
    (button.element as HTMLElement).getBoundingClientRect = () =>
      ({ bottom: 104 }) as DOMRect;

    await button.trigger("click");
    expect(mirrorSettings.panelAnchorTop).toBe(110); // measured bottom + the 6px gap

    wrapper.unmount();
  });

  it("leaves the seeded anchor alone when it has no layout to measure (a 0 rect)", async () => {
    // The fallback matters: pinning the dropdown to y=6 whenever a rect reads 0 would put the panel over the top
    // of the screen in any environment that hasn't laid the button out yet.
    const wrapper = mount(SettingsGearButton);
    await wrapper.get('[data-testid="mirror-settings-toggle"]').trigger("click");
    expect(mirrorSettings.panelAnchorTop).toBe(56);
  });

  it("renders a smaller box in `compact` (browser-space) placement, same glyph", () => {
    const inStage = mount(SettingsGearButton);
    const compact = mount(SettingsGearButton, { props: { compact: true } });
    expect(inStage.get("button").classes()).not.toContain("settings-gear-button--compact");
    expect(compact.get("button").classes()).toContain("settings-gear-button--compact");
    expect(compact.find("svg").exists()).toBe(true);
  });
});

describe("SettingsPanel — the dropdown the gear opens", () => {
  it("renders NO toggle of its own (the semicircle tab is gone)", () => {
    mirrorSettings.panelOpen = true;
    const wrapper = mount(SettingsPanel, { props: { latency } });
    expect(wrapper.find('[data-testid="mirror-settings-toggle"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="mirror-settings-panel"]').exists()).toBe(true);
  });

  it("hangs from the store's anchor and caps its height to the room left below it", () => {
    mirrorSettings.panelOpen = true;
    mirrorSettings.panelAnchorTop = 110;
    const wrapper = mount(SettingsPanel, { props: { latency } });
    const panel = wrapper.get('[data-testid="mirror-settings-panel"]');
    expect((panel.element as HTMLElement).style.top).toBe("110px");
    expect((panel.element as HTMLElement).style.maxHeight).toBe("calc(100vh - 122px)");
  });

  it("renders nothing but the pass-through wrapper while closed", () => {
    mirrorSettings.panelOpen = false;
    const wrapper = mount(SettingsPanel, { props: { latency } });
    expect(wrapper.find('[data-testid="mirror-settings-panel"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="mirror-settings"]').exists()).toBe(true);
  });
});
