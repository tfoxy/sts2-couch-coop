import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import SettingsPanel from "@/mirror/SettingsPanel.vue";
import { DEFAULT_REFRESH_RATE, mirrorSettings } from "@/mirror/mirrorSettings";
import type { MirrorLatency } from "@/mirror/mirrorClient";

// C6 opt-in lever: the refresh-rate quick-pick chips in the settings panel. They must (a) never change the
// default on their own — only on a tap — and (b) drive the SAME store field the slider + serverSettingsPayload
// already use, so no server-wiring change is needed. The store is an app-wide singleton, so reset it per test.

const latency: MirrorLatency = {
  p50: null,
  p95: null,
  gameP50: null,
  gameP95: null,
  gameCount: 0
} as MirrorLatency;

function mountPanel() {
  return mount(SettingsPanel, { props: { latency } });
}

describe("SettingsPanel refresh-rate presets (C6 opt-in lever)", () => {
  beforeEach(() => {
    mirrorSettings.refreshRate = DEFAULT_REFRESH_RATE;
    mirrorSettings.panelOpen = true;
  });
  afterEach(() => {
    mirrorSettings.refreshRate = DEFAULT_REFRESH_RATE;
    mirrorSettings.panelOpen = false;
  });

  it("renders 24/30/40/60 chips and marks the current rate active WITHOUT changing it on mount", () => {
    const wrapper = mountPanel();
    const chips = wrapper.findAll(".settings-preset");
    expect(chips.map((c) => c.text())).toEqual(["24", "30", "40", "60"]);
    // Mounting alone never moves the rate off the default (opt-in only).
    expect(mirrorSettings.refreshRate).toBe(DEFAULT_REFRESH_RATE);
    // The default chip (24) reflects as active; 30/40/60 are not.
    expect(chips[0].classes()).toContain("settings-preset-active");
    expect(chips[1].classes()).not.toContain("settings-preset-active");
    expect(chips[3].classes()).not.toContain("settings-preset-active");
  });

  it("sets the store's refreshRate (the field the server payload reads) when a chip is tapped", async () => {
    const wrapper = mountPanel();
    const chips = wrapper.findAll(".settings-preset");
    await chips[1].trigger("click"); // 30
    expect(mirrorSettings.refreshRate).toBe(30);
    expect(chips[1].classes()).toContain("settings-preset-active");
    expect(chips[0].classes()).not.toContain("settings-preset-active");

    await chips[2].trigger("click"); // 40
    expect(mirrorSettings.refreshRate).toBe(40);
  });

  // R9 item 9: the 60 chip. The value is a SERVER-pushed stream rate (serverSettingsPayload → the host's
  // Engine.MaxFps), and every other layer already allowed 60 — the slider's max, the session-seed clamp — so the
  // chip is the whole feature. It must sit INSIDE the slider's range, or the slider and the chip would disagree.
  it("pushes 60 through the same store field, within the slider's own 4..60 range", async () => {
    const wrapper = mountPanel();
    const chips = wrapper.findAll(".settings-preset");
    await chips[3].trigger("click"); // 60
    expect(mirrorSettings.refreshRate).toBe(60);
    expect(chips[3].classes()).toContain("settings-preset-active");

    const slider = wrapper.get('input[type="range"]');
    expect(slider.attributes("max")).toBe("60");
    expect(Number(slider.attributes("min"))).toBeLessThanOrEqual(60);
    expect((slider.element as HTMLInputElement).value).toBe("60");
  });
});
