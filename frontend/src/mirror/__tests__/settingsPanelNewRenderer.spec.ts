import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";

vi.mock("@/composables/useSafeArea", () => ({ useSafeArea: () => ({ hasSafeArea: ref(true) }) }));

import SettingsPanel from "@/mirror/SettingsPanel.vue";
import {
  clearStoredMirrorSettings,
  mirrorSettings,
  MIRROR_SETTINGS_STORAGE_KEY,
  STREAM_RENDER_OVERRIDES,
  type MirrorSettings
} from "@/mirror/mirrorSettings";
import type { MirrorLatency } from "@/mirror/mirrorClient";
import { renderStreamContext, stopRenderStream } from "@/mirror/renderStreamAvailability";

// "Use new renderer (Beta)" in the panel (handoff-mirror-new-renderer.md §3 Q4, MIR-2's component checks): the
// checkbox is first, every row the stream does not support yet is disabled and SHOWS its forced value, the
// supported rows stay the viewer's, nothing but `renderer` is ever written, and every unavailability reason shows.

const latency: MirrorLatency = {
  lastMs: 20, p50: 20, p95: 30, count: 3, gameLastMs: 80, gameP50: 80, gameP95: 90, gameCount: 4
};

let wrapper: VueWrapper | null = null;
const mountPanel = () => (wrapper = mount(SettingsPanel, { props: { latency } }));
const el = <T extends Element = HTMLInputElement>(id: string) => wrapper!.get(`[data-testid="${id}"]`).element as unknown as T;

// The viewer's SAVED (and live) choices, deliberately the opposite of every forced value, so a forced value can only
// show up on screen through the overlay.
const VIEWER: Partial<MirrorSettings> = {
  quality: "low", shaderMode: "off", particleMode: "static", staticBgEnabled: true, stretchEnabled: true,
  raiseHeldCard: true, unfocusOnRelease: true, tapToFocus: true, confirmTap: true, raiseHandCards: true,
  uiScaling: true, backstopOcclusion: true, reproRecorder: true, tweenReplay: true, freezeParticles: true,
  freezeSpines: true, freezeDecor: true, audio: true, safeAreaPaddingEnabled: true, refreshRate: 40,
  latencyOverlay: true
};

// testid → how the row shows its value, for every FORCED row in Q4.
const FORCED_ROWS: Array<[string, keyof typeof STREAM_RENDER_OVERRIDES, "select" | "checkbox"]> = [
  ["mirror-quality", "quality", "select"],
  ["mirror-shader-mode", "shaderMode", "select"],
  ["mirror-particle-mode", "particleMode", "select"],
  ["mirror-static-bg", "staticBgEnabled", "checkbox"],
  ["mirror-stretch", "stretchEnabled", "checkbox"],
  ["mirror-raise-card", "raiseHeldCard", "checkbox"],
  ["mirror-unfocus", "unfocusOnRelease", "checkbox"],
  ["mirror-tap-focus", "tapToFocus", "checkbox"],
  ["mirror-confirm-tap", "confirmTap", "checkbox"],
  ["mirror-raise-hand", "raiseHandCards", "checkbox"],
  ["mirror-ui-scaling", "uiScaling", "checkbox"],
  ["mirror-backstop-occlusion", "backstopOcclusion", "checkbox"],
  ["mirror-repro-recorder", "reproRecorder", "checkbox"],
  ["mirror-tween-replay", "tweenReplay", "checkbox"],
  ["mirror-freeze-particles", "freezeParticles", "checkbox"],
  ["mirror-freeze-spines", "freezeSpines", "checkbox"],
  ["mirror-freeze-decor", "freezeDecor", "checkbox"]
];
const SUPPORTED_ROWS = ["mirror-audio", "mirror-safe-area-padding", "mirror-refresh-rate", "mirror-latency-overlay"];

function available(): void {
  renderStreamContext.coreProblem = null;
  renderStreamContext.webgl2 = true;
  renderStreamContext.pageLoopback = true;
  mirrorSettings.renderStreamUrl = "ws://127.0.0.1:14861/render-stream";
}

beforeEach(() => {
  localStorage.clear();
  Object.assign(mirrorSettings, VIEWER, {
    renderer: "mirror", runtimeRenderer: "mirror", renderStreamUrl: null, renderStreamProtocol: 12,
    stage: "dom", runtimeStage: "dom", panelOpen: true
  });
  Object.assign(renderStreamContext, {
    directView: false, sessionEndpoint: null, coreLoadFailed: false, stopped: null,
    coreProblem: null, webgl2: true, pageLoopback: true
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  clearStoredMirrorSettings();
  Object.assign(mirrorSettings, { renderer: "mirror", runtimeRenderer: "mirror", renderStreamUrl: null,
    renderStreamProtocol: 12, panelOpen: false, reproRecorder: false, latencyOverlay: false, audio: false });
  Object.assign(renderStreamContext, { coreProblem: undefined, webgl2: undefined, pageLoopback: undefined, stopped: null });
});

describe("SettingsPanel — Use new renderer (Beta)", () => {
  it("is the first control in This device, before Stage", () => {
    available();
    mountPanel();
    const group = wrapper!.findAll(".settings-group")[0];
    const controls = group.findAll("input, select").map((c) => c.attributes("data-testid"));
    expect(controls[0]).toBe("mirror-renderer");
    expect(controls[1]).toBe("mirror-stage");
    expect(group.get(".settings-item").text()).toContain("Use new renderer (Beta)");
  });

  it("while checked, disables every forced row and shows its forced value; supported rows stay the viewer's", async () => {
    available();
    mountPanel();
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    await nextTick();
    expect(mirrorSettings.runtimeRenderer).toBe("stream");

    for (const [testid, key, kind] of FORCED_ROWS) {
      const forced = STREAM_RENDER_OVERRIDES[key](12);
      if (kind === "select") {
        const select = el<HTMLSelectElement>(testid);
        expect(select.disabled, testid).toBe(true);
        expect(select.value, testid).toBe(forced);
      } else {
        const box = el(testid);
        expect(box.disabled, testid).toBe(true);
        expect(box.checked, testid).toBe(forced);
      }
    }
    // The Q4 values, spelled out once so a table edit is a visible spec edit.
    expect(el<HTMLSelectElement>("mirror-quality").value).toBe("high");
    expect(el<HTMLSelectElement>("mirror-shader-mode").value).toBe("dynamic");
    expect(el<HTMLSelectElement>("mirror-particle-mode").value).toBe("dynamic");
    // Stage: disabled on its SAVED value; Text rendering hidden.
    expect(el<HTMLSelectElement>("mirror-stage").disabled).toBe(true);
    expect(el<HTMLSelectElement>("mirror-stage").value).toBe("dom");
    expect(wrapper!.find('[data-testid="mirror-text-method"]').exists()).toBe(false);

    for (const testid of SUPPORTED_ROWS) {
      expect(el(testid).disabled, testid).toBe(false);
    }
    expect(el("mirror-audio").checked).toBe(true);
    expect(el("mirror-safe-area-padding").checked).toBe(true);
    expect(el("mirror-refresh-rate").value).toBe("40");
    expect(el("mirror-latency-overlay").checked).toBe(true);
    // Input-to-frame does not exist while view-only.
    expect(wrapper!.get('[data-testid="mirror-game-rtt"]').text()).toContain("—");
    expect(wrapper!.get('[data-testid="mirror-game-rtt"]').text()).not.toContain("80ms");
  });

  it("refuses writes to a forced row while the stream draws", async () => {
    available();
    mountPanel();
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    // A disabled control cannot be operated by a user; drive the binding the way a stray script would.
    await wrapper!.get('[data-testid="mirror-stretch"]').setValue(false);
    await wrapper!.get('[data-testid="mirror-quality"]').setValue("minimum");
    expect(mirrorSettings.stretchEnabled).toBe(true);
    expect(mirrorSettings.quality).toBe("low");
  });

  it("forces Particles off on a /11 stream, which carries no emitters", async () => {
    available();
    mirrorSettings.renderStreamProtocol = 11;
    mountPanel();
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    await nextTick();
    expect(el<HTMLSelectElement>("mirror-particle-mode").value).toBe("off");
  });

  it("un-checking restores every saved value, and storage holds only `renderer`", async () => {
    available();
    mountPanel();
    const before = Object.fromEntries(FORCED_ROWS.map(([, key]) => [key, mirrorSettings[key]]));
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    expect(JSON.parse(localStorage.getItem(MIRROR_SETTINGS_STORAGE_KEY) ?? "{}")).toEqual({ renderer: "stream" });

    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(false);
    await nextTick();
    expect(mirrorSettings.runtimeRenderer).toBe("mirror");
    expect(JSON.parse(localStorage.getItem(MIRROR_SETTINGS_STORAGE_KEY) ?? "{}")).toEqual({ renderer: "mirror" });
    for (const [testid, key, kind] of FORCED_ROWS) {
      expect(mirrorSettings[key], key).toBe(before[key]);
      const control = kind === "select" ? el<HTMLSelectElement>(testid) : el(testid);
      expect(control.disabled, testid).toBe(false);
    }
    expect(el<HTMLSelectElement>("mirror-quality").value).toBe("low");
    expect(el("mirror-stretch").checked).toBe(true);
    expect(el("mirror-freeze-decor").checked).toBe(true);
  });

  it.each([
    ["core-build", () => { renderStreamContext.coreProblem = "stale"; }, "The new renderer isn't built on this host."],
    ["core-build (load failed)", () => { renderStreamContext.coreLoadFailed = true; }, "The new renderer isn't built on this host."],
    ["no-webgl2", () => { renderStreamContext.webgl2 = false; }, "This browser can't run the new renderer."],
    ["host-view", () => { renderStreamContext.directView = true; }, "Not available when watching the host's own game."],
    ["needs-proxy", () => { mirrorSettings.renderStreamUrl = null; renderStreamContext.pageLoopback = false; },
      "Open the mirror on the host computer to try the new renderer."],
    ["not-streaming", () => { mirrorSettings.renderStreamUrl = null; },
      "This player's seat isn't streaming. It applies when the seat next starts."]
  ])("shows the %s reason and disables the checkbox", async (_name, arrange, text) => {
    available();
    arrange();
    mountPanel();
    await nextTick();
    expect(wrapper!.get('[data-testid="mirror-renderer-reason"]').text()).toBe(text);
    expect(el("mirror-renderer").disabled).toBe(true);
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    expect(mirrorSettings.renderer).toBe("mirror");
    expect(localStorage.getItem(MIRROR_SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it("keeps a saved choice visible and clearable on a seat that does not stream", async () => {
    mirrorSettings.renderer = "stream";
    mountPanel();
    await nextTick();
    expect(el("mirror-renderer").checked).toBe(true);
    expect(el("mirror-renderer").disabled).toBe(false);
    expect(wrapper!.get('[data-testid="mirror-renderer-reason"]').text()).toContain("isn't streaming");
    // Not streaming: the old renderer runs, so nothing is forced.
    expect(el("mirror-stretch").disabled).toBe(false);
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(false);
    expect(mirrorSettings.renderer).toBe("mirror");
  });

  it("says the stream stopped, falls back, and Try again resumes it", async () => {
    available();
    mountPanel();
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    expect(mirrorSettings.runtimeRenderer).toBe("stream");

    stopRenderStream("live-disconnected: socket closed");
    await nextTick();
    expect(mirrorSettings.runtimeRenderer).toBe("mirror");
    expect(mirrorSettings.renderer).toBe("stream");
    expect(wrapper!.get('[data-testid="mirror-renderer-stopped"]').text())
      .toContain("New renderer stopped: live-disconnected: socket closed");
    expect(el("mirror-stretch").disabled).toBe(false);

    await wrapper!.get('[data-testid="mirror-renderer-stopped"] button').trigger("click");
    expect(mirrorSettings.runtimeRenderer).toBe("stream");
    expect(wrapper!.find('[data-testid="mirror-renderer-stopped"]').exists()).toBe(false);
  });
});
