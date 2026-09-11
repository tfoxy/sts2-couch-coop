import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ReproBadge from "@/mirror/ReproBadge.vue";
import { __resetComposerForTest, createBrowserI18n } from "@/i18n";
import SettingsPanel from "@/mirror/SettingsPanel.vue";
import type { MirrorLatency } from "@/mirror/mirrorClient";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { reproRecorder } from "@/mirror/reproRecorder";

// The two controls a player actually touches while recording: the settings row that arms it, and the REC pill's
// MARKER/SAVE buttons. Both are pinned because both are pressed under pressure — mid-combat, one-handed, at the
// moment a bug appears — and a marker that silently didn't register turns a good recording into an unusable one.

const latency: MirrorLatency = {
  lastMs: null,
  p50: null,
  p95: null,
  count: 0,
  gameLastMs: null,
  gameP50: null,
  gameP95: null,
  gameCount: 0
};

beforeEach(() => {
  reproRecorder.__resetForTests();
});

afterEach(() => {
  reproRecorder.__resetForTests();
  mirrorSettings.panelOpen = false;
  mirrorSettings.reproRecorder = false;
  vi.restoreAllMocks();
  __resetComposerForTest();
});

describe("SettingsPanel — the repro-recorder row", () => {
  it("ships in this build, and toggling it writes the store", async () => {
    mirrorSettings.panelOpen = true;
    const wrapper = mount(SettingsPanel, { props: { latency } });
    const row = wrapper.get('[data-testid="mirror-repro-recorder"]');
    expect((row.element as HTMLInputElement).checked).toBe(false);
    await row.setValue(true);
    expect(mirrorSettings.reproRecorder).toBe(true);
    wrapper.unmount();
  });
});

describe("ReproBadge", () => {
  it("renders Chinese recorder actions and marker interpolation", async () => {
    createBrowserI18n("?lang=zh-Hans", { languages: ["en"] });
    reproRecorder.start();
    const wrapper = mount(ReproBadge);
    expect(wrapper.get('[data-testid="mirror-repro-marker"]').text()).toBe("标记");
    await wrapper.get('[data-testid="mirror-repro-marker"]').trigger("click");
    expect(wrapper.get('[data-testid="mirror-repro-readout"]').text()).toBe("标记 1 ✓");
    wrapper.unmount();
  });

  it("shows the REC readout, and MARKER numbers up with a confirmation the player can see", async () => {
    reproRecorder.start();
    const wrapper = mount(ReproBadge);
    expect(wrapper.get('[data-testid="mirror-repro-readout"]').text()).toContain("REC");

    await wrapper.get('[data-testid="mirror-repro-marker"]').trigger("click");
    expect(wrapper.get('[data-testid="mirror-repro-readout"]').text()).toBe("marker 1 ✓");
    await wrapper.get('[data-testid="mirror-repro-marker"]').trigger("click");
    expect(wrapper.get('[data-testid="mirror-repro-readout"]').text()).toBe("marker 2 ✓");
    expect(reproRecorder.stats().markers).toBe(2);
    wrapper.unmount();
  });

  it("SAVE writes the file and says how big it was", async () => {
    reproRecorder.start();
    reproRecorder.tapWireIn('{"type":"scene-delta"}');
    const save = vi.spyOn(reproRecorder, "save");
    const wrapper = mount(ReproBadge);
    await wrapper.get('[data-testid="mirror-repro-save"]').trigger("click");
    expect(save).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[data-testid="mirror-repro-readout"]').text()).toMatch(/^saved [\d.]+ MB ✓$/);
    wrapper.unmount();
  });

  it("stops polling the recorder when it is unmounted", () => {
    const clear = vi.spyOn(globalThis, "clearInterval");
    const wrapper = mount(ReproBadge);
    wrapper.unmount();
    expect(clear).toHaveBeenCalled();
  });
});
