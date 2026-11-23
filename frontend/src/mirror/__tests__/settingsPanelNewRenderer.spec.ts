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
import { renderStreamContext, sessionRenderStreamEndpoint, stopRenderStream } from "@/mirror/renderStreamAvailability";

// "Use new renderer (Beta)" in the panel: the
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
  streamPacing: "fidelity", streamPacingFallback: false,
  streamFreezeSpines: false, streamShaderMode: "dynamic", streamParticleMode: "dynamic", streamStaticBg: false,
  latencyOverlay: true
};

// testid → how the row shows its value, for every FORCED row in Q4.
const FORCED_ROWS: Array<[string, keyof typeof STREAM_RENDER_OVERRIDES, "select" | "checkbox"]> = [
  ["mirror-quality", "quality", "select"],
  ["mirror-backstop-occlusion", "backstopOcclusion", "checkbox"],
  ["mirror-repro-recorder", "reproRecorder", "checkbox"],
  ["mirror-freeze-particles", "freezeParticles", "checkbox"]
];
// Widescreen stretch is supported since PRES-A: under the new renderer it sets the width the seat is launched at.
// Raise hand cards and Readability scaling are supported since TAG3: they run as render-stream extension modules.
// Tap to focus is supported since INP2: the input channel implements the touch two-step. Raise held card, Un-focus
// on release and Confirm tap are supported since the held-card / confirm-tap modules landed (the input channel's
// peek and confirm gestures).
const SUPPORTED_ROWS = ["mirror-audio", "mirror-safe-area-padding", "mirror-stretch", "mirror-refresh-rate",
  "mirror-latency-overlay", "mirror-raise-hand", "mirror-ui-scaling", "mirror-tap-focus",
  "mirror-raise-card", "mirror-unfocus", "mirror-confirm-tap", "mirror-shader-mode", "mirror-particle-mode",
  "mirror-static-bg", "mirror-freeze-spines", "mirror-freeze-decor", "mirror-tween-replay"];

function available(): void {
  renderStreamContext.coreProblem = null;
  renderStreamContext.webgl2 = true;
  renderStreamContext.pageLoopback = true;
  mirrorSettings.renderStreamUrl = "ws://127.0.0.1:14861/render-stream";
}

beforeEach(() => {
  localStorage.clear();
  Object.assign(mirrorSettings, VIEWER, {
    renderer: "mirror", runtimeRenderer: "mirror", renderStreamUrl: null, renderStreamProtocol: 16,
    stage: "dom", runtimeStage: "dom", panelOpen: true
  });
  Object.assign(renderStreamContext, {
    directView: false, hostSelfStream: false, sessionEndpoint: null, rendererState: null, firstFrame: false, returningToMirror: false,
    coreLoadFailed: false, stopped: null, hostUnavailableReason: null,
    coreProblem: null, webgl2: true, pageLoopback: true,
    lanOffer: { relay: true, webTransport: false, tls: false, ws: true }
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  clearStoredMirrorSettings();
  Object.assign(mirrorSettings, { renderer: "mirror", runtimeRenderer: "mirror", renderStreamUrl: null,
    renderStreamProtocol: 16, panelOpen: false, reproRecorder: false, latencyOverlay: false, audio: false });
  Object.assign(renderStreamContext, { coreProblem: undefined, webgl2: undefined, pageLoopback: undefined, stopped: null,
    seatJoined: false, hostUnavailableReason: null, returningToMirror: false, sessionEndpoint: null, lanOffer: null, page: undefined });
});

describe("SettingsPanel — Use new renderer (Beta)", () => {
  it("shows pacing only while the stream is active and persists a selection", async () => {
    available();
    mountPanel();
    expect(wrapper!.find('[data-testid="mirror-stream-pacing"]').exists()).toBe(false);
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    const select = wrapper!.get('[data-testid="mirror-stream-pacing"]');
    expect(el<HTMLSelectElement>("mirror-stream-pacing").value).toBe("fidelity");
    expect(select.findAll("option").map((option) => option.text())).toEqual(["Fidelity", "Balanced"]);
    await select.setValue("balanced");
    expect(mirrorSettings.streamPacing).toBe("balanced");
    expect(JSON.parse(localStorage.getItem(MIRROR_SETTINGS_STORAGE_KEY) ?? "{}")).toEqual({
      renderer: "stream", streamPacing: "balanced"
    });
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(false);
    expect(wrapper!.find('[data-testid="mirror-stream-pacing"]').exists()).toBe(false);
  });

  it("shows the pacing fallback note only for an active stream that fell back", async () => {
    available();
    mountPanel();
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    const note = () => wrapper!.find('[data-testid="mirror-stream-pacing-fallback"]');
    expect(note().exists()).toBe(false);
    mirrorSettings.streamPacingFallback = true;
    await nextTick();
    expect(note().text()).toBe("Switched back to Fidelity for this connection.");
    expect(localStorage.getItem(MIRROR_SETTINGS_STORAGE_KEY)).not.toContain("streamPacingFallback");
    mirrorSettings.streamPacingFallback = false;
    await nextTick();
    expect(note().exists()).toBe(false);
    mirrorSettings.streamPacingFallback = true;
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(false);
    expect(note().exists()).toBe(false);
  });

  it("explains balanced pacing in its help tip", async () => {
    available();
    mountPanel();
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    const row = wrapper!.get('[data-testid="mirror-stream-pacing"]').element.closest(".settings-item")!;
    const button = row.querySelector("button")!;
    button.click();
    await nextTick();
    expect(row.textContent).toContain("same machine or a local network");
    expect(row.textContent).toContain("On slower networks it switches back to Fidelity by itself.");
  });

  it("routes decor and tween rows to saved stream wishes", async () => {
    available();
    Object.assign(mirrorSettings, { streamClientDecor: true, streamClientTweens: true, freezeDecor: true, tweenReplay: true });
    mountPanel();
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    for (const id of ["mirror-freeze-decor", "mirror-tween-replay"]) {
      expect(el(id).disabled).toBe(false);
      expect(el(id).checked).toBe(true);
      await wrapper!.get(`[data-testid="${id}"]`).setValue(false);
    }
    expect(mirrorSettings).toMatchObject({ streamClientDecor: false, streamClientTweens: false, freezeDecor: true, tweenReplay: true });
    expect(JSON.parse(localStorage.getItem(MIRROR_SETTINGS_STORAGE_KEY) ?? "{}"))
      .toMatchObject({ streamClientDecor: false, streamClientTweens: false });
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(false);
    expect(el("mirror-freeze-decor").checked).toBe(true);
    expect(el("mirror-tween-replay").checked).toBe(true);
  });

  it("enables the checkbox for a self-streaming direct view without a seat offer", async () => {
    Object.assign(renderStreamContext, { directView: true, hostSelfStream: true, seatJoined: true,
      lanOffer: null, hostUnavailableReason: "no-capture" });
    mountPanel();
    expect(el("mirror-renderer").disabled).toBe(false);
    expect(wrapper!.text()).not.toContain("Not available when watching the host's own game.");
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    expect(mirrorSettings.renderer).toBe("stream");
    expect(wrapper!.text()).not.toContain("Applies when you join");
  });

  it("is the first control in This device, before Stage", () => {
    available();
    mountPanel();
    const group = wrapper!.findAll(".settings-group")[0];
    const controls = group.findAll("input, select").map((c) => c.attributes("data-testid"));
    expect(controls[0]).toBe("mirror-renderer");
    expect(controls[1]).toBe("mirror-stage");
    expect(group.get(".settings-item").text()).toContain("Use new renderer (Beta)");
  });

  it("is shown to viewers: no ancestor of the checkbox is hidden", () => {
    available();
    mountPanel();
    let node: HTMLElement | null = wrapper!.get('[data-testid="mirror-renderer"]').element as HTMLElement;
    for (; node; node = node.parentElement) expect(node.style.display).not.toBe("none");
  });

  it("while checked, disables every forced row and shows its forced value; supported rows stay the viewer's", async () => {
    available();
    mountPanel();
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    await nextTick();
    expect(mirrorSettings.runtimeRenderer).toBe("stream");

    for (const [testid, key, kind] of FORCED_ROWS) {
      const forced = STREAM_RENDER_OVERRIDES[key](16);
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
    expect(el("mirror-stretch").checked).toBe(true);
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
    await wrapper!.get('[data-testid="mirror-quality"]').setValue("minimum");
    expect(mirrorSettings.staticBgEnabled).toBe(true);
    expect(mirrorSettings.quality).toBe("low");
  });

  it("defaults stream lite rows off/dynamic despite the old lite defaults", async () => {
    available();
    // The old canvas stage must not disable the stream's independent controls.
    mirrorSettings.runtimeStage = "canvas";
    mountPanel();
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    expect(el("mirror-static-bg").checked).toBe(false);
    expect(el("mirror-freeze-spines").checked).toBe(false);
    expect(el<HTMLSelectElement>("mirror-particle-mode").value).toBe("dynamic");
    for (const id of ["mirror-static-bg", "mirror-freeze-spines", "mirror-shader-mode", "mirror-particle-mode"]) {
      expect(el(id).disabled).toBe(false);
    }
    for (const id of ["mirror-shader-mode", "mirror-particle-mode"]) {
      expect(el<HTMLSelectElement>(id).value).toBe("dynamic");
      expect(wrapper!.get(`[data-testid="${id}"]`).findAll("option").map(o => o.attributes("value")))
        .toEqual(["dynamic", "static"]);
    }
  });

  it("edits only stream keys, saves only page preferences and restores old rows on switch back", async () => {
    available();
    Object.assign(mirrorSettings, { freezeSpines: false, particleMode: "off", staticBgEnabled: false });
    mountPanel();
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    await wrapper!.get('[data-testid="mirror-freeze-spines"]').setValue(true);
    expect(mirrorSettings).toMatchObject({ streamFreezeSpines: true, streamParticleMode: "dynamic", streamStaticBg: false,
      freezeSpines: false, particleMode: "off", staticBgEnabled: false });
    await wrapper!.get('[data-testid="mirror-particle-mode"]').setValue("static");
    expect(mirrorSettings).toMatchObject({ streamFreezeSpines: true, streamParticleMode: "static", streamStaticBg: false,
      freezeSpines: false, particleMode: "off", staticBgEnabled: false });
    await wrapper!.get('[data-testid="mirror-static-bg"]').setValue(true);
    expect(mirrorSettings).toMatchObject({ streamFreezeSpines: true, streamParticleMode: "static", streamStaticBg: true,
      freezeSpines: false, particleMode: "off", staticBgEnabled: false });
    expect(JSON.parse(localStorage.getItem(MIRROR_SETTINGS_STORAGE_KEY) ?? "{}"))
      .toEqual({ renderer: "stream", streamParticleMode: "static", streamStaticBg: true });
    expect(el("mirror-freeze-particles").disabled).toBe(true);

    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(false);
    expect(el("mirror-freeze-spines").checked).toBe(false);
    expect(el("mirror-static-bg").checked).toBe(false);
    expect(el<HTMLSelectElement>("mirror-particle-mode").value).toBe("off");
    expect(wrapper!.get('[data-testid="mirror-particle-mode"]').findAll("option").map(o => o.attributes("value")))
      .toEqual(["dynamic", "dynamic-half", "dynamic-quarter", "static", "off"]);
    await wrapper!.get('[data-testid="mirror-freeze-spines"]').setValue(true);
    await wrapper!.get('[data-testid="mirror-particle-mode"]').setValue("dynamic-quarter");
    await wrapper!.get('[data-testid="mirror-static-bg"]').setValue(true);
    expect(mirrorSettings).toMatchObject({ freezeSpines: true, particleMode: "dynamic-quarter", staticBgEnabled: true,
      streamFreezeSpines: true, streamParticleMode: "static", streamStaticBg: true });
  });

  it("saves stream shaders independently, restores old shaders and keeps canvas shaders blocked", async () => {
    available();
    mirrorSettings.shaderMode = "off";
    localStorage.setItem(MIRROR_SETTINGS_STORAGE_KEY, JSON.stringify({ shaderMode: "off" }));
    mirrorSettings.runtimeStage = "canvas";
    mountPanel();
    expect(el<HTMLSelectElement>("mirror-shader-mode").disabled).toBe(true);
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    const shaders = wrapper!.get('[data-testid="mirror-shader-mode"]');
    expect(el<HTMLSelectElement>("mirror-shader-mode").disabled).toBe(false);
    expect(el<HTMLSelectElement>("mirror-shader-mode").value).toBe("dynamic");
    await shaders.setValue("static");
    expect(mirrorSettings.streamShaderMode).toBe("static");
    expect(mirrorSettings.shaderMode).toBe("off");
    expect(JSON.parse(localStorage.getItem(MIRROR_SETTINGS_STORAGE_KEY) ?? "{}"))
      .toEqual({ renderer: "stream", shaderMode: "off", streamShaderMode: "static" });
    await shaders.setValue("dynamic");
    expect(mirrorSettings.streamShaderMode).toBe("dynamic");
    await shaders.setValue("static");

    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(false);
    expect(el<HTMLSelectElement>("mirror-shader-mode").disabled).toBe(true);
    mirrorSettings.runtimeStage = "dom";
    await nextTick();
    expect(el<HTMLSelectElement>("mirror-shader-mode").value).toBe("off");
    await shaders.setValue("dynamic-half");
    expect(mirrorSettings.shaderMode).toBe("dynamic-half");
    expect(mirrorSettings.streamShaderMode).toBe("static");
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    expect(el<HTMLSelectElement>("mirror-shader-mode").value).toBe("static");
  });

  it("uses stream-specific help and describes visible freezes", async () => {
    available();
    mountPanel();
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    expect(wrapper!.get('[data-testid="mirror-host-perf-note"]').text()).toContain("still poses");
    for (const [id, text] of [["freezeSpines", "representative pose"], ["shaders", "Static holds them still"], ["particles", "Dynamic animates"],
      ["staticBg", "live room background"]]) {
      await wrapper!.get(`[data-testid="mirror-help-${id}"]`).trigger("click");
      expect(wrapper!.text()).toContain(text);
    }
  });

  // PRES-A: under the new renderer Widescreen stretch means "launch my seat at my aspect" (the request for a streaming
  // seat carries the page's aspect only while it is on), so it stays the viewer's: settable, and saved.
  it("keeps Widescreen stretch settable and saved while the stream draws", async () => {
    available();
    mountPanel();
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    expect(mirrorSettings.runtimeRenderer).toBe("stream");
    expect(el("mirror-stretch").disabled).toBe(false);
    await wrapper!.get('[data-testid="mirror-stretch"]').setValue(false);
    expect(mirrorSettings.stretchEnabled).toBe(false);
    expect(JSON.parse(localStorage.getItem(MIRROR_SETTINGS_STORAGE_KEY) ?? "{}"))
      .toEqual({ renderer: "stream", stretchEnabled: false });
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
    ["core-build (missing)", () => { renderStreamContext.coreProblem = "missing"; },
      "This dev build has no new renderer. On the host, run scripts/build-local-mod.sh to build it."],
    ["core-build (stale)", () => { renderStreamContext.coreProblem = "stale"; },
      "This dev build's new renderer is out of date. On the host, run scripts/build-local-mod.sh to rebuild it."],
    ["core-build (unverified)", () => { renderStreamContext.coreProblem = "unverified"; },
      "This dev build can't check which sources its new renderer came from. On the host, run scripts/build-local-mod.sh from a git checkout."],
    ["core-build (load failed)", () => { renderStreamContext.coreLoadFailed = true; }, "The new renderer couldn't load on this page."],
    ["core-build (stale outranks a load failure)", () => {
      renderStreamContext.coreProblem = "stale"; renderStreamContext.coreLoadFailed = true;
    }, "This dev build's new renderer is out of date. On the host, run scripts/build-local-mod.sh to rebuild it."],
    ["no-webgl2", () => { renderStreamContext.webgl2 = false; }, "This browser can't run the new renderer."],
    ["host-view", () => { renderStreamContext.directView = true; }, "Not available when watching the host's own game."],
    ["needs-proxy", () => {
      mirrorSettings.renderStreamUrl = null;
      renderStreamContext.pageLoopback = false;
      renderStreamContext.lanOffer = { relay: true, webTransport: false, tls: false, ws: true };
      renderStreamContext.page = { https: true, secureContext: true, webTransport: false };
    }, "This page can't run the host's new-renderer stream. Open the host's HTTPS link in Chrome or Edge, or the mirror "
      + "on the host computer."],
    ["host-update (an older host without relay capability)", () => {
      mirrorSettings.renderStreamUrl = null;
      renderStreamContext.pageLoopback = false;
      renderStreamContext.lanOffer = { webTransport: true, tls: false, ws: true };
      renderStreamContext.page = { https: false, secureContext: false, webTransport: false };
    }, "Update the host mod to use the new renderer."]
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

  it.each([
    ["no-matching-record", "The new renderer doesn't support this game version yet."],
    ["operator-record-mismatch", "The new renderer doesn't support this game version yet."],
    ["no-capture", "The new renderer isn't available on this computer."],
    ["os-unsupported", "The new renderer isn't available on this computer."],
    ["library-missing", "The new renderer isn't available on this computer."],
    ["library-validation", "The new renderer isn't available on this computer."],
    ["capture-invalid", "The new renderer is unavailable on this host."],
    ["calibration-invalid", "The new renderer is unavailable on this host."],
    ["calibration-missing", "The new renderer is unavailable on this host."],
    ["identity-unreadable", "The new renderer is unavailable on this host."],
    ["unknown", "The new renderer is unavailable on this host."],
    ["future-reason", "The new renderer is unavailable on this host."]
  ])("disables a loopback page's toggle and explains host refusal %s", async (reason, text) => {
    renderStreamContext.hostUnavailableReason = reason;
    mountPanel();
    expect(el("mirror-renderer").disabled).toBe(true);
    expect(wrapper!.get('[data-testid="mirror-renderer-reason"]').text()).toBe(text);
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    expect(mirrorSettings.renderer).toBe("mirror");
    expect(localStorage.getItem(MIRROR_SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it("explains the host refusal with a saved stream choice and a previous failed attempt", () => {
    mirrorSettings.renderer = "stream";
    renderStreamContext.hostUnavailableReason = "no-matching-record";
    renderStreamContext.stopped = "no-capture";
    mountPanel();
    expect(el("mirror-renderer").checked).toBe(true);
    expect(el("mirror-renderer").disabled).toBe(true);
    expect(wrapper!.find('[data-testid="mirror-renderer-stopped"]').exists()).toBe(false);
    expect(wrapper!.get('[data-testid="mirror-renderer-reason"]').text())
      .toBe("The new renderer doesn't support this game version yet.");
  });

  it("keeps a QA override usable when the host cannot stream", async () => {
    available();
    renderStreamContext.hostUnavailableReason = "no-capture";
    mountPanel();
    expect(el("mirror-renderer").disabled).toBe(false);
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    expect(mirrorSettings.runtimeRenderer).toBe("stream");
    expect(wrapper!.find('[data-testid="mirror-renderer-reason"]').exists()).toBe(false);
  });

  // The choice rides the join: before one, the checkbox can be switched on whenever the join would ask for the stream.
  it("can be switched on in the name form, before any seat exists, and says it applies on joining", async () => {
    mountPanel();
    await nextTick();
    expect(el("mirror-renderer").disabled).toBe(false);
    const applies = "Applies when you join: your player starts with the new renderer.";
    expect(wrapper!.get('[data-testid="mirror-renderer-reason"]').text()).toBe(applies);
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    expect(mirrorSettings.renderer).toBe("stream");
    expect(JSON.parse(localStorage.getItem(MIRROR_SETTINGS_STORAGE_KEY) ?? "{}")).toEqual({ renderer: "stream" });
    // Nothing to draw yet: the old renderer runs, so nothing is forced.
    expect(mirrorSettings.runtimeRenderer).toBe("mirror");
    expect(el("mirror-stretch").disabled).toBe(false);
    expect(wrapper!.get('[data-testid="mirror-renderer-reason"]').text()).toBe(applies);
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(false);
    expect(mirrorSettings.renderer).toBe("mirror");
  });

  it("can be switched on from a plain-http LAN page once the host offers the relay", async () => {
    renderStreamContext.lanOffer = null;
    renderStreamContext.pageLoopback = false;
    renderStreamContext.page = { https: false, secureContext: false, webTransport: false };
    mountPanel();
    await nextTick();
    expect(el("mirror-renderer").disabled).toBe(true);
    renderStreamContext.lanOffer = { relay: true, webTransport: false, tls: false, ws: true };
    await nextTick();
    expect(el("mirror-renderer").disabled).toBe(false);
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    expect(mirrorSettings.renderer).toBe("stream");
  });

  it("keeps a joined seat switchable and reflects the saved choice", async () => {
    renderStreamContext.seatJoined = true;
    mirrorSettings.renderer = "stream";
    mountPanel();
    expect(el("mirror-renderer").checked).toBe(true);
    expect(el("mirror-renderer").disabled).toBe(false);
    expect(wrapper!.find('[data-testid="mirror-renderer-reason"]').exists()).toBe(false);
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(false);
    expect(mirrorSettings.renderer).toBe("mirror");
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    expect(mirrorSettings.renderer).toBe("stream");
  });

  it("shows the saved choice even when the seat already streams, and can switch it off", async () => {
    renderStreamContext.seatJoined = true;
    renderStreamContext.sessionEndpoint = sessionRenderStreamEndpoint({ url: "ws://127.0.0.1:13366/render-stream",
      resourceBase: "http://127.0.0.1:13366", token: "a".repeat(64), protocol: 16 });
    mountPanel();
    expect(el("mirror-renderer").checked).toBe(false);
    expect(el("mirror-renderer").disabled).toBe(false);
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(true);
    await wrapper!.get('[data-testid="mirror-renderer"]').setValue(false);
    expect(mirrorSettings.renderer).toBe("mirror");
    expect(JSON.parse(localStorage.getItem(MIRROR_SETTINGS_STORAGE_KEY) ?? "{}")).toEqual({ renderer: "mirror" });
  });

  it("reports Switching until the stream draws its first frame", async () => {
    renderStreamContext.seatJoined = true;
    renderStreamContext.rendererState = { state: "arming" };
    mirrorSettings.renderer = "stream";
    mountPanel();
    expect(wrapper!.get('[data-testid="mirror-renderer-reason"]').text()).toBe("Switching…");
    renderStreamContext.rendererState = { state: "armed" };
    renderStreamContext.sessionEndpoint = sessionRenderStreamEndpoint({ url: "ws://127.0.0.1:13366/render-stream",
      resourceBase: "http://127.0.0.1:13366", token: "a".repeat(64), protocol: 16 });
    await nextTick();
    expect(wrapper!.get('[data-testid="mirror-renderer-reason"]').text()).toBe("Switching…");
    renderStreamContext.firstFrame = true;
    await nextTick();
    expect(wrapper!.find('[data-testid="mirror-renderer-reason"]').exists()).toBe(false);
  });

  it.each(["arming", "armed"] as const)("does not report Switching after returning to mirror while the seat stays %s", (state) => {
    renderStreamContext.seatJoined = true;
    renderStreamContext.rendererState = { state };
    renderStreamContext.sessionEndpoint = sessionRenderStreamEndpoint({ url: "ws://127.0.0.1:13366/render-stream",
      resourceBase: "http://127.0.0.1:13366", token: "a".repeat(64), protocol: 16 });
    renderStreamContext.returningToMirror = true;
    mountPanel();
    expect(el("mirror-renderer").checked).toBe(false);
    expect(wrapper!.find('[data-testid="mirror-renderer-reason"]').exists()).toBe(false);
  });

  it.each(["arming", "armed", "failed"] as const)("hides shared-seat %s status and retry when the saved choice is mirror", (state) => {
    renderStreamContext.seatJoined = true;
    renderStreamContext.rendererState = { state, reason: "capture stopped" };
    renderStreamContext.sessionEndpoint = sessionRenderStreamEndpoint({ url: "ws://127.0.0.1:13366/render-stream",
      resourceBase: "http://127.0.0.1:13366", token: "a".repeat(64), protocol: 16 });
    renderStreamContext.stopped = "capture stopped";
    mountPanel();
    expect(el("mirror-renderer").checked).toBe(false);
    expect(wrapper!.find('[data-testid="mirror-renderer-reason"]').exists()).toBe(false);
    expect(wrapper!.find('[data-testid="mirror-renderer-stopped"]').exists()).toBe(false);
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
