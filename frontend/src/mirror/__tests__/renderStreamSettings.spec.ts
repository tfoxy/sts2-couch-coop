import { afterEach, describe, expect, it } from "vitest";

import {
  createMirrorSettings,
  mirrorSettings,
  NEVER_PERSISTED_SETTING_KEYS,
  persistMirrorSetting,
  PERSISTED_SETTING_KEYS,
  readStoredMirrorSettings,
  serverSettingsPayload,
  staticBgWireValue,
  STREAM_RENDER_OVERRIDES,
  type MirrorSettingsStorage
} from "@/mirror/mirrorSettings";
import {
  computeRenderStreamAvailability,
  isLoopbackHttpPage,
  joinRendererRequest,
  qaRenderStreamEndpoint,
  renderStreamAvailability,
  renderStreamContext,
  resolveRuntimeRenderer,
  sessionRenderStreamEndpoint,
  stopRenderStream,
  syncRuntimeRenderer,
  type RenderStreamAvailabilityInputs
} from "@/mirror/renderStreamAvailability";

// MIR-2's unit checks (handoff-mirror-new-renderer.md §6): the `renderer` key persists and `runtimeRenderer` does
// not, the URL overrides never write back, the server payload overlay applies, and availability's precedence.

function memoryStorage(initial: Record<string, unknown> = {}): MirrorSettingsStorage & { raw(): Record<string, unknown> } {
  let blob = JSON.stringify(initial);
  return {
    getItem: () => blob,
    setItem: (_key: string, value: string) => { blob = value; },
    removeItem: () => { blob = "{}"; },
    raw: () => JSON.parse(blob) as Record<string, unknown>
  };
}

afterEach(() => {
  Object.assign(renderStreamContext, { directView: false, sessionEndpoint: null, coreLoadFailed: false, stopped: null,
    coreProblem: undefined, webgl2: undefined, pageLoopback: undefined });
});

describe("mirrorSettings — the renderer keys", () => {
  it("persists `renderer` and never the live renderer or the QA endpoint", () => {
    expect(PERSISTED_SETTING_KEYS).toContain("renderer");
    for (const key of ["runtimeRenderer", "renderStreamUrl", "renderStreamProtocol"] as const) {
      expect(NEVER_PERSISTED_SETTING_KEYS as readonly string[]).toContain(key);
      expect(PERSISTED_SETTING_KEYS as readonly string[]).not.toContain(key);
    }
    const storage = memoryStorage();
    persistMirrorSetting("renderer", "stream", storage);
    expect(storage.raw()).toEqual({ renderer: "stream" });
    expect(createMirrorSettings(undefined, "", { storage }).renderer).toBe("stream");
  });

  it("drops a corrupt saved renderer and defaults to the old one, live renderer included", () => {
    const settings = createMirrorSettings(undefined, "", { storage: memoryStorage({ renderer: "webgpu" }) });
    expect(settings.renderer).toBe("mirror");
    expect(settings.runtimeRenderer).toBe("mirror");
    expect(readStoredMirrorSettings(memoryStorage({ renderer: 7 }))).toEqual({});
  });

  it("layers ?renderer= / ?renderStream= / ?rsProtocol= for the session and never writes them back", () => {
    const storage = memoryStorage({ renderer: "mirror" });
    const settings = createMirrorSettings(undefined,
      "?renderer=stream&renderStream=ws://127.0.0.1:14861/render-stream&rsProtocol=11", { storage });
    expect(settings.renderer).toBe("stream");
    expect(settings.renderStreamUrl).toBe("ws://127.0.0.1:14861/render-stream");
    expect(settings.renderStreamProtocol).toBe(11);
    // The live renderer is derived later (syncRuntimeRenderer), never from the URL directly.
    expect(settings.runtimeRenderer).toBe("mirror");
    expect(storage.raw()).toEqual({ renderer: "mirror" });
    // A panel change to another field still writes only that field.
    persistMirrorSetting("audio", true, storage);
    expect(storage.raw()).toEqual({ renderer: "mirror", audio: true });

    expect(createMirrorSettings(undefined, "?renderer=mirror", { storage: memoryStorage({ renderer: "stream" }) }).renderer)
      .toBe("mirror");
  });

  it("accepts only an absolute ws(s) QA endpoint and a known protocol", () => {
    const at = (search: string) => createMirrorSettings(undefined, search, { storage: null });
    expect(at("?renderStream=http://127.0.0.1:1/render-stream").renderStreamUrl).toBeNull();
    expect(at("?renderStream=/render-stream").renderStreamUrl).toBeNull();
    expect(at("?renderStream=wss://h.example:9/render-stream").renderStreamUrl).toBe("wss://h.example:9/render-stream");
    expect(at("?rsProtocol=8").renderStreamProtocol).toBe(12);
    expect(at("").renderStreamProtocol).toBe(12);
  });

  it("overlays the server payload under the stream: freezes, static background and tween replay off, the rest as saved", () => {
    const settings = createMirrorSettings(undefined, "", { storage: null });
    Object.assign(settings, { refreshRate: 40, tweenReplay: true, freezeParticles: true, freezeSpines: true,
      freezeDecor: true, staticBgEnabled: true, runtimeStage: "canvas" });
    const old = serverSettingsPayload(settings);
    expect(old).toMatchObject({ freezeParticles: true, freezeSpines: true, freezeDecor: true, staticBg: true });

    settings.runtimeRenderer = "stream";
    expect(serverSettingsPayload(settings)).toEqual({
      refreshRate: 40, freezeParticles: false, freezeSpines: false, freezeDecor: false, tweenReplay: false,
      staticBg: false, trailDrive: true
    });
    expect(staticBgWireValue(settings)).toBe(false);
    // The store itself is untouched, so switching back sends the instance's own values again.
    expect(settings.freezeParticles).toBe(true);
    expect(settings.tweenReplay).toBe(true);
    settings.runtimeRenderer = "mirror";
    expect(serverSettingsPayload(settings)).toEqual(old);
  });

  it("forces Particles by protocol: dynamic at /12, off at /11", () => {
    expect(STREAM_RENDER_OVERRIDES.particleMode(12)).toBe("dynamic");
    expect(STREAM_RENDER_OVERRIDES.particleMode(11)).toBe("off");
  });
});

describe("renderStreamAvailability", () => {
  const qa = qaRenderStreamEndpoint({ renderStreamUrl: "ws://127.0.0.1:14861/render-stream", renderStreamProtocol: 12 });
  const base: RenderStreamAvailabilityInputs = {
    coreProblem: null, coreLoadFailed: false, webgl2: true, directView: false, qaEndpoint: null,
    sessionEndpoint: null, pageLoopback: true
  };

  it("derives the QA descriptor: the hub's origin, no token, 1920x1080", () => {
    expect(qa).toEqual({ url: "ws://127.0.0.1:14861/render-stream", resourceBase: "http://127.0.0.1:14861",
      token: null, protocol: 12, presentation: [1920, 1080] });
    expect(qaRenderStreamEndpoint({ renderStreamUrl: "wss://h.example/render-stream", renderStreamProtocol: 11 }))
      .toMatchObject({ resourceBase: "https://h.example", protocol: 11 });
    expect(qaRenderStreamEndpoint({ renderStreamUrl: null, renderStreamProtocol: 12 })).toBeNull();
  });

  it("applies the reasons in the design's precedence", () => {
    const reason = (over: Partial<RenderStreamAvailabilityInputs>) =>
      computeRenderStreamAvailability({ ...base, qaEndpoint: qa, ...over }).reason;
    expect(reason({ coreProblem: "stale", webgl2: false, directView: true })).toBe("core-build");
    expect(reason({ coreLoadFailed: true })).toBe("core-build");
    expect(reason({ webgl2: false, directView: true })).toBe("no-webgl2");
    expect(reason({ directView: true })).toBe("host-view");
    expect(reason({ qaEndpoint: null, pageLoopback: false })).toBe("needs-proxy");
    expect(reason({ qaEndpoint: null })).toBe("not-streaming");
    expect(reason({})).toBeNull();
  });

  it("prefers the QA endpoint, then the seat's own descriptor", () => {
    const seat = sessionRenderStreamEndpoint({ url: "ws://127.0.0.1:1/render-stream", resourceBase: "http://127.0.0.1:1",
      token: "a".repeat(64), protocol: 12 });
    expect(seat).not.toBeNull();
    expect(computeRenderStreamAvailability({ ...base, qaEndpoint: qa, sessionEndpoint: seat })).toMatchObject({
      available: true, source: "qa-override", endpoint: qa });
    expect(computeRenderStreamAvailability({ ...base, sessionEndpoint: seat })).toMatchObject({
      available: true, source: "session", endpoint: seat });
  });

  it("treats an unusable envelope descriptor as not streaming", () => {
    expect(sessionRenderStreamEndpoint(null)).toBeNull();
    expect(sessionRenderStreamEndpoint({ url: "ws://x/render-stream", resourceBase: "", token: "short", protocol: 12 })).toBeNull();
    expect(sessionRenderStreamEndpoint({ url: "ws://x/render-stream", resourceBase: "", token: null, protocol: 9 })).toBeNull();
  });

  it("asks the host for a streaming seat only when the viewer chose it and this page can draw it", () => {
    const ask = { renderer: "stream" as const, coreProblem: null, coreLoadFailed: false, webgl2: true, pageLoopback: true,
      qaEndpoint: null };
    expect(joinRendererRequest(ask)).toBe("stream");
    expect(joinRendererRequest({ ...ask, renderer: "mirror" })).toBeUndefined();
    expect(joinRendererRequest({ ...ask, coreProblem: "missing" })).toBeUndefined();
    expect(joinRendererRequest({ ...ask, coreLoadFailed: true })).toBeUndefined();
    expect(joinRendererRequest({ ...ask, webgl2: false })).toBeUndefined();
    // A LAN or HTTPS page cannot reach a loopback hub: the seat would stream for nobody.
    expect(joinRendererRequest({ ...ask, pageLoopback: false })).toBeUndefined();
    // A QA endpoint brings its own hub.
    expect(joinRendererRequest({ ...ask, qaEndpoint: qa })).toBeUndefined();
  });

  it("knows a loopback http page", () => {
    expect(isLoopbackHttpPage({ protocol: "http:", hostname: "127.0.0.1" })).toBe(true);
    expect(isLoopbackHttpPage({ protocol: "http:", hostname: "localhost" })).toBe(true);
    expect(isLoopbackHttpPage({ protocol: "http:", hostname: "192.168.1.20" })).toBe(false);
    expect(isLoopbackHttpPage({ protocol: "https:", hostname: "127.0.0.1" })).toBe(false);
  });

  it("runs the stream only for a saved choice, when available, until it stops", () => {
    const yes = computeRenderStreamAvailability({ ...base, qaEndpoint: qa });
    const no = computeRenderStreamAvailability(base);
    expect(resolveRuntimeRenderer("stream", yes, null)).toBe("stream");
    expect(resolveRuntimeRenderer("mirror", yes, null)).toBe("mirror");
    expect(resolveRuntimeRenderer("stream", no, null)).toBe("mirror");
    expect(resolveRuntimeRenderer("stream", yes, "host-error: bye")).toBe("mirror");
  });

  it("promotes the live renderer when available, falls back on a stop, and keeps the saved choice", () => {
    const saved = { renderer: mirrorSettings.renderer, url: mirrorSettings.renderStreamUrl };
    try {
      Object.assign(renderStreamContext, { coreProblem: null, webgl2: true, pageLoopback: true });
      Object.assign(mirrorSettings, { renderer: "stream", renderStreamUrl: "ws://127.0.0.1:9/render-stream",
        renderStreamProtocol: 12 });
      syncRuntimeRenderer();
      expect(mirrorSettings.runtimeRenderer).toBe("stream");

      stopRenderStream("core-load-failed: stale core");
      expect(renderStreamContext.coreLoadFailed).toBe(true);
      expect(renderStreamAvailability.value.reason).toBe("core-build");
      expect(mirrorSettings.renderer).toBe("stream");
      expect(mirrorSettings.runtimeRenderer).toBe("mirror");
    } finally {
      Object.assign(mirrorSettings, { renderer: saved.renderer, renderStreamUrl: saved.url, runtimeRenderer: "mirror" });
    }
  });
});
