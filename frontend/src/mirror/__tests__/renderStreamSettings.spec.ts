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
  canRequestStreamingSeat,
  computeRenderStreamAvailability,
  isLoopbackHttpPage,
  joinRendererRequest,
  parseSeatRestart,
  qaRenderStreamEndpoint,
  renderStreamAvailability,
  renderStreamContext,
  resolveRuntimeRenderer,
  sessionRenderStreamEndpoint,
  stopRenderStream,
  streamSeatAspect,
  syncRuntimeRenderer,
  type RenderStreamAvailabilityInputs,
  type RenderStreamSeatRestart
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
    expect(at("?rsProtocol=8").renderStreamProtocol).toBe(13);
    expect(at("").renderStreamProtocol).toBe(13);
    expect(at("?rsProtocol=12").renderStreamProtocol).toBe(12);
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

  it("leaves Widescreen stretch the viewer's: it sets the streaming seat's width (PRES-A)", () => {
    expect(Object.keys(STREAM_RENDER_OVERRIDES)).not.toContain("stretchEnabled");
    expect(Object.keys(STREAM_RENDER_OVERRIDES)).not.toContain("raiseHandCards");
    expect(Object.keys(STREAM_RENDER_OVERRIDES)).not.toContain("uiScaling");
    expect(Object.keys(STREAM_RENDER_OVERRIDES).sort()).toEqual([
      "backstopOcclusion", "confirmTap", "freezeDecor", "freezeParticles", "freezeSpines", "particleMode", "quality",
      "raiseHeldCard", "reproRecorder", "shaderMode", "staticBgEnabled", "tapToFocus", "tweenReplay",
      "unfocusOnRelease"
    ]);
  });

  it("asks for the seat at the stream box's aspect only with Widescreen stretch on (PRES-A)", () => {
    const box = (width: number, height: number) => () => ({ width, height });
    expect(streamSeatAspect({ stretchEnabled: true }, box(2340, 1080))).toBeCloseTo(2340 / 1080, 10);
    expect(streamSeatAspect({ stretchEnabled: true }, box(1080, 2340))).toBeCloseTo(1080 / 2340, 10);
    expect(streamSeatAspect({ stretchEnabled: false }, box(2340, 1080))).toBeUndefined();
    expect(streamSeatAspect({ stretchEnabled: true }, box(0, 0))).toBeUndefined();
    expect(streamSeatAspect({ stretchEnabled: true }, box(2340, 0))).toBeUndefined();
  });

  it("measures the mounted stream stage, else the window", () => {
    const stage = document.createElement("div");
    stage.dataset.testid = "render-stream-stage";
    stage.getBoundingClientRect = () => ({ width: 2520, height: 1080 }) as DOMRect;
    document.body.append(stage);
    try {
      expect(streamSeatAspect({ stretchEnabled: true })).toBeCloseTo(2520 / 1080, 10);
    } finally {
      stage.remove();
    }
    expect(streamSeatAspect({ stretchEnabled: true })).toBeCloseTo(window.innerWidth / window.innerHeight, 10);
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

  it("puts the host's answer to a mid-session restart in place of not-streaming (MIR-4)", () => {
    const withRestart = (state: RenderStreamSeatRestart["state"], over: Partial<RenderStreamAvailabilityInputs> = {}) =>
      computeRenderStreamAvailability({ ...base, seatRestart: { state, reason: null, detail: null }, ...over }).reason;
    expect(withRestart("restarting")).toBe("seat-restarting");
    expect(withRestart("pending")).toBe("seat-restart-pending");
    expect(withRestart("refused")).toBe("seat-restart-refused");
    expect(withRestart("failed")).toBe("seat-restart-failed");
    // Everything that outranks not-streaming outranks the restart too, and the seat's descriptor wins over a stale one.
    expect(withRestart("restarting", { pageLoopback: false })).toBe("needs-proxy");
    expect(withRestart("restarting", { directView: true })).toBe("host-view");
    const seat = sessionRenderStreamEndpoint({ url: "ws://127.0.0.1:1/render-stream", resourceBase: "http://127.0.0.1:1",
      token: "a".repeat(64), protocol: 12 });
    expect(computeRenderStreamAvailability({ ...base, sessionEndpoint: seat,
      seatRestart: { state: "restarting", reason: null, detail: null } })).toMatchObject({ available: true, source: "session" });
  });

  it("parses the host session's rendererSeat, refusing what it does not understand", () => {
    expect(parseSeatRestart({ state: "failed", reason: "capture-not-started", detail: "no hub" }))
      .toEqual({ state: "failed", reason: "capture-not-started", detail: "no hub" });
    expect(parseSeatRestart({ state: "pending" })).toEqual({ state: "pending", reason: null, detail: null });
    expect(parseSeatRestart(null)).toBeNull();
    expect(parseSeatRestart(undefined)).toBeNull();
    expect(parseSeatRestart({ state: "exploded" })).toBeNull();
    expect(parseSeatRestart("restarting")).toBeNull();
  });

  it("lets a joined seat that does not stream ask for a restart, and only then", () => {
    const at = (over: Partial<RenderStreamAvailabilityInputs>) => computeRenderStreamAvailability({ ...base, ...over });
    expect(canRequestStreamingSeat(at({}), true)).toBe(true);
    expect(canRequestStreamingSeat(at({}), false)).toBe(false);
    expect(canRequestStreamingSeat(at({ seatRestart: { state: "refused", reason: "another-seat-streaming", detail: null } }), true)).toBe(true);
    expect(canRequestStreamingSeat(at({ seatRestart: { state: "failed", reason: null, detail: null } }), true)).toBe(true);
    expect(canRequestStreamingSeat(at({ seatRestart: { state: "restarting", reason: null, detail: null } }), true)).toBe(false);
    expect(canRequestStreamingSeat(at({ seatRestart: { state: "pending", reason: null, detail: null } }), true)).toBe(false);
    expect(canRequestStreamingSeat(at({ pageLoopback: false }), true)).toBe(false);
    expect(canRequestStreamingSeat(at({ directView: true }), true)).toBe(false);
    expect(canRequestStreamingSeat(at({ webgl2: false }), true)).toBe(false);
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
