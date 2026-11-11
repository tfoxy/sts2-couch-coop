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
  latencyOverlay: true
};

// testid → how the row shows its value, for every FORCED row in Q4.
const FORCED_ROWS: Array<[string, keyof typeof STREAM_RENDER_OVERRIDES, "select" | "checkbox"]> = [
  ["mirror-quality", "quality", "select"],
  ["mirror-shader-mode", "shaderMode", "select"],
  ["mirror-particle-mode", "particleMode", "select"],
  ["mirror-static-bg", "staticBgEnabled", "checkbox"],
  ["mirror-backstop-occlusion", "backstopOcclusion", "checkbox"],
  ["mirror-repro-recorder", "reproRecorder", "checkbox"],
  ["mirror-tween-replay", "tweenReplay", "checkbox"],
  ["mirror-freeze-particles", "freezeParticles", "checkbox"],
  ["mirror-freeze-spines", "freezeSpines", "checkbox"],
  ["mirror-freeze-decor", "freezeDecor", "checkbox"]
];
// Widescreen stretch is supported since PRES-A: under the new renderer it sets the width the seat is launched at.
// Raise hand cards and Readability scaling are supported since TAG3: they run as render-stream extension modules.
// Tap to focus is supported since INP2: the input channel implements the touch two-step. Raise held card, Un-focus
// on release and Confirm tap are supported since the held-card / confirm-tap modules landed (the input channel's
// peek and confirm gestures).
const SUPPORTED_ROWS = ["mirror-audio", "mirror-safe-area-padding", "mirror-stretch", "mirror-refresh-rate",
  "mirror-latency-overlay", "mirror-raise-hand", "mirror-ui-scaling", "mirror-tap-focus",
  "mirror-raise-card", "mirror-unfocus", "mirror-confirm-tap"];

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
    directView: false, sessionEndpoint: null, rendererState: null, firstFrame: false, returningToMirror: false,
    coreLoadFailed: false, stopped: null,
    coreProblem: null, webgl2: true, pageLoopback: true
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  clearStoredMirrorSettings();
  Object.assign(mirrorSettings, { renderer: "mirror", runtimeRenderer: "mirror", renderStreamUrl: null,
    renderStreamProtocol: 12, panelOpen: false, reproRecorder: false, latencyOverlay: false, audio: false });
  Object.assign(renderStreamContext, { coreProblem: undefined, webgl2: undefined, pageLoopback: undefined, stopped: null,
    seatJoined: false, returningToMirror: false, sessionEndpoint: null, lanOffer: null, page: undefined });
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
    await wrapper!.get('[data-testid="mirror-static-bg"]').setValue(false);
    await wrapper!.get('[data-testid="mirror-quality"]').setValue("minimum");
    expect(mirrorSettings.staticBgEnabled).toBe(true);
    expect(mirrorSettings.quality).toBe("low");
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
      renderStreamContext.lanOffer = { webTransport: true, tls: false, ws: true };
      renderStreamContext.page = { https: true, secureContext: true, webTransport: false };
    }, "This page can't run the host's new-renderer stream. Open the host's HTTPS link in Chrome or Edge, or the mirror "
      + "on the host computer."],
    ["not-streaming (a LAN page on a host with no capture)", () => {
      mirrorSettings.renderStreamUrl = null;
      renderStreamContext.pageLoopback = false;
      renderStreamContext.page = { https: false, secureContext: false, webTransport: false };
    }, "This host isn't set up to stream the new renderer."]
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

  it("can be switched on from a plain-http LAN page once the host offers the stream (CAR9)", async () => {
    renderStreamContext.pageLoopback = false;
    renderStreamContext.page = { https: false, secureContext: false, webTransport: false };
    mountPanel();
    await nextTick();
    expect(el("mirror-renderer").disabled).toBe(true);
    renderStreamContext.lanOffer = { webTransport: true, tls: false, ws: true };
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
      resourceBase: "http://127.0.0.1:13366", token: "a".repeat(64), protocol: 13 });
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
      resourceBase: "http://127.0.0.1:13366", token: "a".repeat(64), protocol: 13 });
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
      resourceBase: "http://127.0.0.1:13366", token: "a".repeat(64), protocol: 13 });
    renderStreamContext.returningToMirror = true;
    mountPanel();
    expect(el("mirror-renderer").checked).toBe(false);
    expect(wrapper!.find('[data-testid="mirror-renderer-reason"]').exists()).toBe(false);
  });

  it.each(["arming", "armed", "failed"] as const)("hides shared-seat %s status and retry when the saved choice is mirror", (state) => {
    renderStreamContext.seatJoined = true;
    renderStreamContext.rendererState = { state, reason: "capture stopped" };
    renderStreamContext.sessionEndpoint = sessionRenderStreamEndpoint({ url: "ws://127.0.0.1:13366/render-stream",
      resourceBase: "http://127.0.0.1:13366", token: "a".repeat(64), protocol: 13 });
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
