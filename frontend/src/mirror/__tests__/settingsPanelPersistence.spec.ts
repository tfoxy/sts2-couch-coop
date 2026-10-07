import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import SettingsPanel from "@/mirror/SettingsPanel.vue";
import {
  clearStoredMirrorSettings,
  effectiveMirrorRenderSettings,
  mirrorSettings,
  MIRROR_SETTINGS_STORAGE_KEY,
  readStoredMirrorSettings,
  serverSettingsPayload
} from "@/mirror/mirrorSettings";
import type { MirrorLatency } from "@/mirror/mirrorClient";
import { rendererComparisonViewRevision, rendererRuntimeStatus, setRendererRuntimeStatus } from "@/mirror/rendererComparison";
import { setComparisonStageBackend } from "@/mirror/rendererFactory";

// The WRITE half of the persistence feature (the read/layering half lives in mirrorSettings.spec): a change made
// in THIS panel is saved, and nothing else ever is. These mount against the app-wide singleton and the real jsdom
// localStorage, because the contract under test is precisely "operating a control writes storage".

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

function mountPanel(): VueWrapper {
  return mount(SettingsPanel, { props: { latency } });
}

function saved(): Record<string, unknown> {
  return readStoredMirrorSettings() as Record<string, unknown>;
}

beforeEach(() => {
  localStorage.clear();
  setComparisonStageBackend("dom");
  mirrorSettings.stage = "dom";
  mirrorSettings.textMethod = "bitmap";
  setRendererRuntimeStatus({ actualBackend: null, actualConfig: null, phase: "initializing", reason: null });
  mirrorSettings.panelOpen = true;
  mirrorSettings.quality = "auto";
  mirrorSettings.shaderMode = "static";
  mirrorSettings.particleMode = "dynamic-quarter";
  mirrorSettings.stretchEnabled = true;
  mirrorSettings.raiseHeldCard = true;
  mirrorSettings.unfocusOnRelease = true;
  mirrorSettings.tapToFocus = true;
  mirrorSettings.backstopOcclusion = true;
  mirrorSettings.staticBgEnabled = true;
  mirrorSettings.latencyOverlay = false;
  mirrorSettings.refreshRate = 24;
  mirrorSettings.tweenReplay = true;
  mirrorSettings.freezeParticles = true;
  mirrorSettings.freezeSpines = true;
  mirrorSettings.freezeDecor = true;
});

afterEach(() => {
  clearStoredMirrorSettings();
  localStorage.clear();
  mirrorSettings.panelOpen = false;
});

describe("SettingsPanel — saving a viewer's choices", () => {
  it("shows a canvas failure and retries the same stage without selecting DOM", async () => {
    mirrorSettings.stage = "canvas";
    mirrorSettings.runtimeStage = "canvas";
    setRendererRuntimeStatus({ requested: { ...rendererRuntimeStatus.requested, backend: "canvas" },
      actualBackend: "rust", actualConfig: null, phase: "failed", reason: "WebGL context lost" });
    const revision = rendererComparisonViewRevision.value;
    const wrapper = mountPanel();
    expect(wrapper.get('[data-testid="mirror-stage-failure"]').text()).toContain("WebGL context lost");
    await wrapper.get('[data-testid="mirror-stage-failure"] button').trigger("click");
    expect(mirrorSettings.runtimeStage).toBe("canvas");
    expect(saved()).toEqual({ stage: "canvas" });
    expect(rendererRuntimeStatus.phase).toBe("initializing");
    expect(rendererComparisonViewRevision.value).toBe(revision + 1);
    expect(wrapper.find('[data-testid="mirror-stage-failure"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("offers MSDF on Canvas and remounts after persisting the selection", async () => {
    const wrapper = mountPanel();
    expect(wrapper.find('[data-testid="mirror-text-method"]').exists()).toBe(false);
    await wrapper.get('[data-testid="mirror-stage"]').setValue("canvas");
    const method = wrapper.get('[data-testid="mirror-text-method"]');
    expect((method.element as HTMLSelectElement).value).toBe("bitmap");
    const revision = rendererComparisonViewRevision.value;
    await method.setValue("msdf");
    expect(mirrorSettings.textMethod).toBe("msdf");
    expect(rendererComparisonViewRevision.value).toBe(revision + 1);
    expect((method.element as HTMLSelectElement).value).toBe("msdf");
    expect(saved()).toEqual({ stage: "canvas", textMethod: "msdf" });
    await method.setValue("bitmap");
    expect(rendererComparisonViewRevision.value).toBe(revision + 2);
    expect(saved()).toEqual({ stage: "canvas", textMethod: "bitmap" });
    wrapper.unmount();
  });

  it("persists the public stage, forces Rust values, then restores the saved DOM choices and host payload", async () => {
    mirrorSettings.quality = "high";
    mirrorSettings.shaderMode = "dynamic";
    mirrorSettings.particleMode = "dynamic-half";
    mirrorSettings.staticBgEnabled = false;
    mirrorSettings.runtimeStage = "dom";
    mirrorSettings.stage = "dom";
    const wrapper = mountPanel();

    await wrapper.get('[data-testid="mirror-stage"]').setValue("canvas");
    expect(saved()).toEqual({ stage: "canvas" });
    expect(effectiveMirrorRenderSettings(mirrorSettings)).toMatchObject({
      quality: "very-low", shaderMode: "off", particleMode: "off", staticBgEnabled: true
    });
    expect((wrapper.get('[data-testid="mirror-quality"]').element as HTMLSelectElement).disabled).toBe(true);
    expect((wrapper.get('[data-testid="mirror-static-bg"]').element as HTMLInputElement).disabled).toBe(true);
    expect(serverSettingsPayload(mirrorSettings).staticBg).toBe(true);

    await wrapper.get('[data-testid="mirror-stage"]').setValue("dom");
    expect(saved()).toEqual({ stage: "dom" });
    expect(effectiveMirrorRenderSettings(mirrorSettings)).toMatchObject({
      quality: "high", shaderMode: "dynamic", particleMode: "dynamic-half", staticBgEnabled: false
    });
    expect((wrapper.get('[data-testid="mirror-quality"]').element as HTMLSelectElement).disabled).toBe(false);
    expect((wrapper.get('[data-testid="mirror-static-bg"]').element as HTMLInputElement).disabled).toBe(false);
    expect(serverSettingsPayload(mirrorSettings).staticBg).toBe(false);
    wrapper.unmount();
  });

  it("clears an incoming stage override without adding a stage query on panel changes", async () => {
    const priorUrl = window.location.href;
    try {
      window.history.replaceState(null, "", "/?stage=canvas&name=Ann#game");
      const wrapper = mountPanel();
      await wrapper.get('[data-testid="mirror-stage"]').setValue("canvas");
      expect(window.location.search).toBe("?name=Ann");
      expect(window.location.hash).toBe("#game");
      expect(saved()).toEqual({ stage: "canvas" });
      await wrapper.get('[data-testid="mirror-stage"]').setValue("dom");
      expect(window.location.search).toBe("?name=Ann");
      expect(saved()).toEqual({ stage: "dom" });
      wrapper.unmount();
    } finally {
      window.history.replaceState(null, "", priorUrl);
    }
  });

  it("saves a QUALITY rung together with the three rows it sets", async () => {
    // The quality row is the one control that writes more than its own field — and every one of those writes has
    // to be saved, or a reload would show the rung next to rows it does not imply.
    const wrapper = mountPanel();
    await wrapper.get('[data-testid="mirror-quality"]').setValue("high");
    expect(saved()).toEqual({
      quality: "high",
      shaderMode: "dynamic",
      particleMode: "dynamic",
      staticBgEnabled: false
    });
    expect([mirrorSettings.shaderMode, mirrorSettings.particleMode, mirrorSettings.staticBgEnabled]).toEqual([
      "dynamic",
      "dynamic",
      false
    ]);
    wrapper.unmount();
  });

  it("saves `auto` on its own — handing the device back to detection touches no row", async () => {
    const wrapper = mountPanel();
    await wrapper.get('[data-testid="mirror-quality"]').setValue("minimum");
    await wrapper.get('[data-testid="mirror-quality"]').setValue("auto");
    expect(saved()).toEqual({
      quality: "auto",
      // the rows the `minimum` pick wrote stay written — they are the viewer's now
      shaderMode: "off",
      particleMode: "off",
      staticBgEnabled: true
    });
    wrapper.unmount();
  });

  it("a row changed after a rung overrides just that row, and the rung stays picked", async () => {
    const wrapper = mountPanel();
    await wrapper.get('[data-testid="mirror-quality"]').setValue("very-low");
    await wrapper.get('[data-testid="mirror-particle-mode"]').setValue("dynamic-quarter");
    expect(saved()).toEqual({
      quality: "very-low",
      shaderMode: "static",
      particleMode: "dynamic-quarter",
      staticBgEnabled: true
    });
    wrapper.unmount();
  });

  it("saves an effect mode picked from either select", async () => {
    const wrapper = mountPanel();
    await wrapper.get('[data-testid="mirror-shader-mode"]').setValue("dynamic");
    expect(mirrorSettings.shaderMode).toBe("dynamic");
    expect(saved()).toEqual({ shaderMode: "dynamic" });

    await wrapper.get('[data-testid="mirror-particle-mode"]').setValue("off");
    expect(saved()).toEqual({ shaderMode: "dynamic", particleMode: "off" });
    wrapper.unmount();
  });

  it("saves each client-side checkbox the viewer flips", async () => {
    const wrapper = mountPanel();
    // The client toggles: static background, stretch, raise, un-focus, tap-to-focus, confirm-tap,
    // raise-hand, enlarge-small-UI, backstop. Addressed by test id where one exists, so a row added in the middle
    // can't silently re-point an index at a different setting — which has now happened TWICE (when raise-hand
    // landed, and again when the enlarge-small-UI row went in above backstop and this test started saving it
    // instead). Use ids for every row now that the audio preference is another client toggle.
    await wrapper.get('[data-testid="mirror-static-bg"]').setValue(false);
    await wrapper.get('[data-testid="mirror-stretch"]').setValue(false);
    await wrapper.get('[data-testid="mirror-confirm-tap"]').setValue(false);
    // Raise-hand is the one DEVICE-defaulted toggle: jsdom is not a coarse-pointer device, so it starts OFF and
    // the flip that changes anything (and therefore saves anything) is the one that turns it ON.
    await wrapper.get('[data-testid="mirror-raise-hand"]').setValue(true);
    await wrapper.get('[data-testid="mirror-ui-scaling"]').setValue(false);
    await wrapper.get('[data-testid="mirror-backstop-occlusion"]').setValue(false);
    expect(saved()).toEqual({
      staticBgEnabled: false,
      stretchEnabled: false,
      confirmTap: false,
      raiseHandCards: true,
      uiScaling: false,
      backstopOcclusion: false
    });
    expect(mirrorSettings.staticBgEnabled).toBe(false);
    expect(mirrorSettings.stretchEnabled).toBe(false);
    expect(mirrorSettings.confirmTap).toBe(false);
    expect(mirrorSettings.raiseHandCards).toBe(true);
    expect(mirrorSettings.uiScaling).toBe(false);
    expect(mirrorSettings.backstopOcclusion).toBe(false);
    wrapper.unmount();
  });

  it("saves the latency overlay toggle", async () => {
    const wrapper = mountPanel();
    await wrapper.get('[data-testid="mirror-latency-overlay"]').setValue(true);
    expect(saved()).toEqual({ latencyOverlay: true });
    wrapper.unmount();
  });

  it("saves the two SERVER-tied preferences: refresh rate (slider AND preset) and tween replay", async () => {
    const wrapper = mountPanel();
    await wrapper.get('input[type="range"]').setValue(37);
    expect(mirrorSettings.refreshRate).toBe(37);
    expect(saved()).toEqual({ refreshRate: 37 });

    // The quick-pick chips write through the same binding, not around it.
    await wrapper.findAll(".settings-preset")[3].trigger("click");
    expect(mirrorSettings.refreshRate).toBe(60);
    expect(saved()).toEqual({ refreshRate: 60 });

    // By test id, not by index: the index broke the moment a client-side row landed above this one (the repro
    // recorder), which is the same trap the client-checkbox test above already documents.
    await wrapper.get('[data-testid="mirror-tween-replay"]').setValue(false);
    expect(saved()).toEqual({ refreshRate: 60, tweenReplay: false });
    wrapper.unmount();
  });

  it("NEVER saves the host-performance freezes (they are the serving instance's truth, not a preference)", async () => {
    const wrapper = mountPanel();
    await wrapper.get('[data-testid="mirror-freeze-particles"]').setValue(false);
    await wrapper.get('[data-testid="mirror-freeze-spines"]').setValue(false);
    await wrapper.get('[data-testid="mirror-freeze-decor"]').setValue(false);
    // The store still changed (and MirrorApp forwards it to the game) — only storage stayed empty.
    expect(mirrorSettings.freezeParticles).toBe(false);
    expect(mirrorSettings.freezeSpines).toBe(false);
    expect(mirrorSettings.freezeDecor).toBe(false);
    expect(localStorage.getItem(MIRROR_SETTINGS_STORAGE_KEY)).toBeNull();
    wrapper.unmount();
  });

  it("saves nothing for a store change that did NOT come from the panel", async () => {
    // The paths that mutate the store from outside: the host's reported refresh rate, the per-connection freeze
    // seeding, the adaptive controller's pin. A `watch`-based implementation would have saved all three.
    const wrapper = mountPanel();
    mirrorSettings.refreshRate = 12; // as if seeded from the `session` envelope
    mirrorSettings.freezeSpines = false; // as if seeded from the serving instance
    mirrorSettings.effectModePinned = true;
    await wrapper.vm.$nextTick();
    expect(localStorage.getItem(MIRROR_SETTINGS_STORAGE_KEY)).toBeNull();
    wrapper.unmount();
  });

  it("merges across panel visits instead of overwriting the whole blob", async () => {
    const first = mountPanel();
    await first.get('[data-testid="mirror-shader-mode"]').setValue("off");
    first.unmount();

    const second = mountPanel();
    await second.get('[data-testid="mirror-latency-overlay"]').setValue(true);
    second.unmount();

    expect(saved()).toEqual({ shaderMode: "off", latencyOverlay: true });
  });
});
