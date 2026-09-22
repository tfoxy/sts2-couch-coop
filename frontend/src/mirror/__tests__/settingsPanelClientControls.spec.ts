import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import SettingsPanel from "@/mirror/SettingsPanel.vue";
import LatencyOverlay from "@/mirror/LatencyOverlay.vue";
import { __resetComposerForTest, createBrowserI18n } from "@/i18n";
import { createMirrorSettings, mirrorSettings } from "@/mirror/mirrorSettings";
import type { MirrorLatency } from "@/mirror/mirrorClient";
import type { RenderQuality, RenderQualityTier } from "@/render/quality";

// The panel's CLIENT-ONLY controls (never in SERVER_SETTING_KEYS → never pushed to the game). The store is an
// app-wide singleton, so reset the fields per test.

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

function mountPanel() {
  return mount(SettingsPanel, { props: { latency } });
}

function quality(overrides: Partial<RenderQuality> = {}): RenderQuality {
  const tier: RenderQualityTier = "high";
  return {
    tier,
    shadersEnabled: true,
    shadersStatic: false,
    particlesEnabled: true,
    spineClipsEnabled: true,
    spineClipFps: 0,
    renderScale: 1,
    shaderFps: 0,
    particleFps: 30,
    maxTextureDim: 4096,
    maxTrailPoints: 0,
    staticShaderScale: 1,
    staticParticleScale: 1,
    source: "default",
    ...overrides
  };
}

beforeEach(() => {
  mirrorSettings.panelOpen = true;
  mirrorSettings.latencyOverlay = false;
  mirrorSettings.quality = "auto";
  mirrorSettings.shaderMode = "static";
  mirrorSettings.particleMode = "static";
  mirrorSettings.staticBgEnabled = true;
});
afterEach(() => {
  mirrorSettings.panelOpen = false;
  __resetComposerForTest();
  mirrorSettings.latencyOverlay = false;
  mirrorSettings.quality = "auto";
  localStorage.clear();
});

// THE QUALITY ROW's presentation: the ladder it offers, the rung it shows, and the detected rung printed in the
// Auto entry. What picking one WRITES is qualityPreset.spec.ts / settingsPanelPersistence.spec.ts.
describe("SettingsPanel — quality row", () => {
  it("offers Auto plus the five rungs, in ladder order, above the rows it drives", () => {
    const wrapper = mountPanel();
    const select = wrapper.get('[data-testid="mirror-quality"]');
    expect(select.findAll("option").map((o) => o.attributes("value"))).toEqual([
      "auto",
      "high",
      "medium",
      "low",
      "very-low",
      "minimum"
    ]);
    // First control in the group: the lever a player reaches for before the individual rows.
    const selects = wrapper.findAll(".settings-group select");
    expect(selects[0].attributes("data-testid")).toBe("mirror-quality");
  });

  it("labels each rung with the word the id and ?quality= use — and never the word Off", () => {
    const wrapper = mountPanel();
    const labels = wrapper.get('[data-testid="mirror-quality"]').findAll("option").map((o) => o.text());
    expect(labels.slice(1)).toEqual(["High", "Medium", "Low", "Very low", "Minimum"]);
    // The rename's whole point: a quality level is never presented to a player as "Off".
    expect(labels).not.toContain("Off");
  });

  it("prints the DETECTED rung in the Auto entry, so a viewer can see what they are overriding", () => {
    const wrapper = mountPanel();
    const auto = wrapper.get('[data-testid="mirror-quality"]').findAll("option")[0];
    expect(auto.text()).toMatch(/^Auto \((High|Medium|Low|Very low|Minimum)\)$/);
  });

  it("shows the viewer's current choice, including one they picked and then diverged from", async () => {
    const wrapper = mountPanel();
    const select = wrapper.get('[data-testid="mirror-quality"]');
    expect((select.element as HTMLSelectElement).value).toBe("auto");
    await select.setValue("medium");
    expect(mirrorSettings.quality).toBe("medium");
    await wrapper.get('[data-testid="mirror-shader-mode"]').setValue("off");
    expect((select.element as HTMLSelectElement).value).toBe("medium");
  });

  it("renders the row's Chinese chrome through the active composition locale", () => {
    createBrowserI18n("?lang=zh-Hans", { languages: ["en"] });
    const wrapper = mountPanel();
    expect(wrapper.text()).toContain("画质");
    const labels = wrapper.get('[data-testid="mirror-quality"]').findAll("option").map((o) => o.text());
    expect(labels).toContain("很低");
    expect(labels[0]).toMatch(/^自动（.+）$/);
  });
});

describe("SettingsPanel — latency overlay toggle (R9 item 11)", () => {
  it("seeds OFF (no ?latency) and flips the client-only store field when checked", async () => {
    expect(createMirrorSettings(quality(), "").latencyOverlay).toBe(false);
    expect(createMirrorSettings(quality(), "").latencyOverlay).toBe(false);
    // The `?latency=1` harness param seeds it ON so the checkbox reads truthfully for that session.
    expect(createMirrorSettings(quality(), "?latency=1").latencyOverlay).toBe(true);

    const wrapper = mountPanel();
    const box = wrapper.get('[data-testid="mirror-latency-overlay"]');
    expect((box.element as HTMLInputElement).checked).toBe(false);
    await box.setValue(true);
    expect(mirrorSettings.latencyOverlay).toBe(true);
  });

  it("lives in the Latency group next to the readout it duplicates", () => {
    const wrapper = mountPanel();
    const group = wrapper.get('[data-testid="mirror-settings-latency"]');
    expect(group.find('[data-testid="mirror-latency-overlay"]').exists()).toBe(true);
  });
});

// The overlay component itself is what the flag renders (MirrorApp's `latencyEnabled || settings.latencyOverlay`
// gate). Assert it renders the live numbers so a toggle-on shows something meaningful with the panel CLOSED.
describe("LatencyOverlay", () => {
  it("renders the live RTT readout it is toggled on to show", () => {
    const wrapper = mount(LatencyOverlay, { props: { latency } });
    expect(wrapper.get('[data-testid="latency-overlay"]').text()).toContain("p95 30ms");
    expect(wrapper.text()).toContain("n=7");
  });

  it("renders Chinese latency chrome through the active composition locale", () => {
    createBrowserI18n("?lang=zh-Hans", { languages: ["en"] });
    const wrapper = mount(LatencyOverlay, { props: { latency } });
    expect(wrapper.get('[data-testid="latency-overlay"]').text()).toContain("往返延迟");
    expect(wrapper.text()).toContain("p95 30ms");
  });
});

// The spine select is GONE: spines are server-baked stills for everyone (mirrorSettings' `spineMode` default), so
// the panel offers no choice and the four modes survive only as the dev `?spineMode=` override. Asserted rather
// than merely deleted, because "we removed a control" is exactly the kind of change a later refactor re-adds by
// accident while restoring "the effect selects".
describe("SettingsPanel — no spine control", () => {
  it("renders NO spine-mode select (spines are static for every viewer)", () => {
    const wrapper = mountPanel();
    expect(wrapper.find('[data-testid="mirror-spine-mode"]').exists()).toBe(false);
    // …while the two effect selects it used to sit between are untouched.
    expect(wrapper.find('[data-testid="mirror-shader-mode"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mirror-particle-mode"]').exists()).toBe(true);
  });

  it("leaves the store's spine mode at the static default (nothing in the panel can move it)", () => {
    expect(createMirrorSettings(quality(), "").spineMode).toBe("static");
  });
});
