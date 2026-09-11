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
});
afterEach(() => {
  mirrorSettings.panelOpen = false;
  __resetComposerForTest();
  mirrorSettings.latencyOverlay = false;
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
