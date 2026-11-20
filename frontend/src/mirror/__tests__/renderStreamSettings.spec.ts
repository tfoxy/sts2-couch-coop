import { afterEach, describe, expect, it } from "vitest";

import {
  createMirrorSettings,
  effectivePanelSetting,
  mirrorSettings,
  NEVER_PERSISTED_SETTING_KEYS,
  persistMirrorSetting,
  PERSISTED_SETTING_KEYS,
  readStoredMirrorSettings,
  serverSettingsPayload,
  seedServerSettingsFromSession,
  staticBgWireValue,
  STREAM_RENDER_OVERRIDES,
  type MirrorSettingsStorage
} from "@/mirror/mirrorSettings";
import {
  computeRenderStreamAvailability,
  isLoopbackHttpPage,
  seatRendererRequest,
  qaRenderStreamEndpoint,
  renderStreamAvailability,
  renderStreamChoosable,
  renderStreamContext,
  resolveRuntimeRenderer,
  retryRenderStream,
  sessionRenderStreamEndpoint,
  coreBuildCause,
  endpointCarrierUsable,
  lanCarrierUsable,
  parseLanOffer,
  stopRenderStream,
  streamSeatAspect,
  measureStreamBox,
  syncRuntimeRenderer,
  type RenderStreamAvailabilityInputs
} from "@/mirror/renderStreamAvailability";

// Unit checks: the `renderer` key persists and `runtimeRenderer` does
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
  Object.assign(renderStreamContext, { directView: false, hostSelfStream: false, sessionEndpoint: null, coreLoadFailed: false, stopped: null,
    coreProblem: undefined, webgl2: undefined, pageLoopback: undefined, lanOffer: null, page: undefined });
});

describe("mirrorSettings — the renderer keys", () => {
  it("persists `renderer` and never the live renderer or the QA endpoint", () => {
    expect(PERSISTED_SETTING_KEYS).toContain("renderer");
    for (const key of ["runtimeRenderer", "renderStreamUrl", "renderStreamProtocol", "renderStreamCarrier"] as const) {
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

  it("layers ?renderer= / ?renderStream= / ?rsCarrier= for the session and never writes them back", () => {
    const storage = memoryStorage({ renderer: "mirror" });
    const settings = createMirrorSettings(undefined,
      "?renderer=stream&renderStream=ws://127.0.0.1:14861/render-stream&rsCarrier=websocket", { storage });
    expect(settings.renderer).toBe("stream");
    expect(settings.renderStreamUrl).toBe("ws://127.0.0.1:14861/render-stream");
    expect(settings.renderStreamProtocol).toBe(16);
    expect(settings.renderStreamCarrier).toBe("websocket");
    expect(createMirrorSettings(undefined, "?rsCarrier=webtransport", { storage: null }).renderStreamCarrier).toBe("webtransport");
    expect(createMirrorSettings(undefined, "?rsCarrier=quic", { storage: null }).renderStreamCarrier).toBe("auto");
    expect(createMirrorSettings(undefined, "", { storage: null }).renderStreamCarrier).toBe("auto");
    // The live renderer is derived later (syncRuntimeRenderer), never from the URL directly.
    expect(settings.runtimeRenderer).toBe("mirror");
    expect(storage.raw()).toEqual({ renderer: "mirror" });
    // A panel change to another field still writes only that field.
    persistMirrorSetting("audio", true, storage);
    expect(storage.raw()).toEqual({ renderer: "mirror", audio: true });

    expect(createMirrorSettings(undefined, "?renderer=mirror", { storage: memoryStorage({ renderer: "stream" }) }).renderer)
      .toBe("mirror");
  });

  it("accepts only an absolute ws(s) QA endpoint and uses protocol 16", () => {
    const at = (search: string) => createMirrorSettings(undefined, search, { storage: null });
    expect(at("?renderStream=http://127.0.0.1:1/render-stream").renderStreamUrl).toBeNull();
    expect(at("?renderStream=/render-stream").renderStreamUrl).toBeNull();
    expect(at("?renderStream=wss://h.example:9/render-stream").renderStreamUrl).toBe("wss://h.example:9/render-stream");
    expect(at("").renderStreamProtocol).toBe(16);
  });

  it("preserves saved freezes under the stream while disabling static background and tween replay", () => {
    const settings = createMirrorSettings(undefined, "", { storage: null });
    Object.assign(settings, { refreshRate: 40, tweenReplay: true, freezeParticles: true, freezeSpines: true,
      freezeDecor: true, staticBgEnabled: true, runtimeStage: "canvas" });
    const old = serverSettingsPayload(settings);
    expect(old).toMatchObject({ freezeParticles: true, freezeSpines: true, freezeDecor: true, staticBg: true });

    settings.runtimeRenderer = "stream";
    expect(serverSettingsPayload(settings)).toEqual({
      refreshRate: 40, freezeParticles: true, freezeSpines: true, freezeDecor: true, tweenReplay: false,
      staticBg: false, trailDrive: true, streamFreezeSpines: false, streamStaticBgReady: "", streamStaticBg: false
    });
    expect(staticBgWireValue(settings)).toBe(false);
    // The store itself is untouched, so switching back sends the instance's own values again.
    expect(settings.freezeParticles).toBe(true);
    expect(settings.tweenReplay).toBe(true);
    settings.runtimeRenderer = "mirror";
    expect(serverSettingsPayload(settings)).toEqual(old);
  });

  it("sends loaded readiness only for the stream opt-in, independent of the old mirror vote", () => {
    const settings = createMirrorSettings(undefined, "", { storage: null });
    const id = "/bg/underdocks?layers=current&v=1";
    expect(serverSettingsPayload(settings, id)).not.toHaveProperty("streamStaticBgReady");
    settings.runtimeRenderer = "stream";
    expect(serverSettingsPayload(settings, id).streamStaticBgReady).toBe("");
    settings.streamStaticBg = true;
    expect(serverSettingsPayload(settings).streamStaticBgReady).toBe("");
    expect(serverSettingsPayload(settings, id)).toMatchObject({ streamStaticBgReady: id, staticBg: false });
    settings.streamStaticBg = false;
    expect(serverSettingsPayload(settings, id).streamStaticBgReady).toBe("");
  });

  it("leaves Widescreen stretch the viewer's: it sets the streaming seat's width (PRES-A)", () => {
    expect(Object.keys(STREAM_RENDER_OVERRIDES)).not.toContain("stretchEnabled");
    expect(Object.keys(STREAM_RENDER_OVERRIDES)).not.toContain("raiseHandCards");
    expect(Object.keys(STREAM_RENDER_OVERRIDES)).not.toContain("uiScaling");
    expect(Object.keys(STREAM_RENDER_OVERRIDES)).not.toContain("tapToFocus"); // INP2: the input channel two-steps
    expect(Object.keys(STREAM_RENDER_OVERRIDES)).not.toContain("raiseHeldCard"); // the held-card module
    expect(Object.keys(STREAM_RENDER_OVERRIDES)).not.toContain("unfocusOnRelease"); // the peek-release pair
    expect(Object.keys(STREAM_RENDER_OVERRIDES)).not.toContain("confirmTap"); // the confirm-tap module
    expect(Object.keys(STREAM_RENDER_OVERRIDES).sort()).toEqual([
      "backstopOcclusion", "freezeDecor", "freezeParticles", "quality",
      "reproRecorder", "tweenReplay"
    ]);
  });

  it("sends stream opt-ins while keeping old-renderer settings unchanged", () => {
    const storage = memoryStorage({ staticBgEnabled: true, shaderMode: "off", particleMode: "static" });
    const settings = createMirrorSettings(undefined, "", { storage });
    const oldPayload = serverSettingsPayload(settings);
    expect(settings).toMatchObject({ streamFreezeSpines: false, streamShaderMode: "dynamic", streamParticleMode: "dynamic", streamStaticBg: false });
    settings.runtimeRenderer = "stream";
    expect(effectivePanelSetting(settings, "staticBgEnabled")).toBe(false);
    expect(effectivePanelSetting(settings, "shaderMode")).toBe("dynamic");
    expect(effectivePanelSetting(settings, "particleMode")).toBe("dynamic");
    expect(effectivePanelSetting(settings, "freezeSpines")).toBe(false);
    const streamPayload = serverSettingsPayload(settings);
    Object.assign(settings, { streamShaderMode: "static", streamStaticBg: true, streamParticleMode: "static", streamFreezeSpines: true });
    expect(effectivePanelSetting(settings, "staticBgEnabled")).toBe(true);
    expect(effectivePanelSetting(settings, "particleMode")).toBe("static");
    expect(effectivePanelSetting(settings, "freezeSpines")).toBe(true);
    expect(serverSettingsPayload(settings)).toEqual({ ...streamPayload, streamFreezeSpines: true, streamStaticBg: true });
    expect(streamPayload).toHaveProperty("streamFreezeSpines", false);
    expect(streamPayload).not.toHaveProperty("streamShaderMode");
    expect(effectivePanelSetting(settings, "shaderMode")).toBe("static");
    expect(streamPayload).not.toHaveProperty("streamParticleMode");
    expect(streamPayload).toHaveProperty("streamStaticBg", false);
    settings.runtimeRenderer = "mirror";
    expect(serverSettingsPayload(settings)).toEqual(oldPayload);
    expect(effectivePanelSetting(settings, "shaderMode")).toBe(settings.shaderMode);
    expect(effectivePanelSetting(settings, "staticBgEnabled")).toBe(true);
    expect(effectivePanelSetting(settings, "particleMode")).toBe("static");
    expect(effectivePanelSetting(settings, "freezeSpines")).toBe(true);
  });

  it("re-seeds stream spine truth independently on each connection and ignores unknown values", () => {
    const settings = createMirrorSettings(undefined, "", { storage: null });
    expect(seedServerSettingsFromSession(settings, { streamFreezeSpines: null })).toBe(false);
    expect(settings.streamFreezeSpines).toBe(false);
    expect(seedServerSettingsFromSession(settings, { streamFreezeSpines: true })).toBe(true);
    expect(settings.streamFreezeSpines).toBe(true);
    expect(settings.freezeSpines).toBe(true);
    expect(seedServerSettingsFromSession(settings, {})).toBe(false);
    expect(settings.streamFreezeSpines).toBe(true);
    expect(seedServerSettingsFromSession(settings, { freezeSpines: false, streamFreezeSpines: false })).toBe(true);
    expect(settings.streamFreezeSpines).toBe(false);
    expect(settings.freezeSpines).toBe(false);
    expect(serverSettingsPayload(settings)).not.toHaveProperty("streamFreezeSpines");
  });

  it("restores page opt-ins but never restores or persists stream spine freeze", () => {
    const storage = memoryStorage({ streamFreezeSpines: true, streamParticleMode: "static", streamStaticBg: true });
    expect(createMirrorSettings(undefined, "", { storage }))
      .toMatchObject({ streamFreezeSpines: false, streamParticleMode: "static", streamStaticBg: true });
    expect(readStoredMirrorSettings(storage)).toEqual({ streamParticleMode: "static", streamStaticBg: true });
    expect(NEVER_PERSISTED_SETTING_KEYS).toContain("streamFreezeSpines");
    expect(PERSISTED_SETTING_KEYS).not.toContain("streamFreezeSpines");
    // A panel write also drops stale host-truth entries from the stored blob.
    persistMirrorSetting("streamStaticBg", false, storage);
    persistMirrorSetting("streamParticleMode", "dynamic", storage);
    expect(storage.raw()).toEqual({ streamParticleMode: "dynamic", streamStaticBg: false });
    expect(createMirrorSettings(undefined, "", { storage }))
      .toMatchObject({ streamFreezeSpines: false, streamShaderMode: "dynamic", streamParticleMode: "dynamic", streamStaticBg: false });
  });

  it.each(["off", "dynamic-half", "dynamic-quarter", true, null])("rejects invalid saved stream particle mode %s", (mode) => {
    const settings = createMirrorSettings(undefined, "", {
      storage: memoryStorage({ streamParticleMode: mode, streamStaticBg: "true" })
    });
    expect(settings).toMatchObject({ streamParticleMode: "dynamic", streamStaticBg: false });
  });

  it("asks for the mirror design aspect only with Widescreen stretch on", () => {
    const box = (width: number, height: number) => () => ({ width, height });
    expect(streamSeatAspect({ stretchEnabled: true, safeAreaPaddingEnabled: false }, box(2340, 1080))).toBeCloseTo(2340 / 1080, 10);
    expect(streamSeatAspect({ stretchEnabled: true, safeAreaPaddingEnabled: false }, box(1080, 2340))).toBeCloseTo(1920 / 1080, 10);
    expect(streamSeatAspect({ stretchEnabled: true, safeAreaPaddingEnabled: false }, box(4000, 1080))).toBeCloseTo(2520 / 1080, 10);
    expect(streamSeatAspect({ stretchEnabled: true, safeAreaPaddingEnabled: false }, box(932, 430))).toBeCloseTo(2341 / 1080, 10);
    expect(streamSeatAspect({ stretchEnabled: false, safeAreaPaddingEnabled: false }, box(2340, 1080))).toBeUndefined();
    expect(streamSeatAspect({ stretchEnabled: true, safeAreaPaddingEnabled: false }, box(0, 0))).toBeUndefined();
    expect(streamSeatAspect({ stretchEnabled: true, safeAreaPaddingEnabled: false }, box(2340, 0))).toBeUndefined();
  });

  it("measures the containing surface, else the window", () => {
    const stage = document.createElement("main");
    stage.className = "mirror-surface";
    stage.getBoundingClientRect = () => new DOMRect(0, 0, 2520, 1080);
    document.body.append(stage);
    try {
      expect(streamSeatAspect({ stretchEnabled: true, safeAreaPaddingEnabled: false })).toBeCloseTo(2520 / 1080, 10);
    } finally {
      stage.remove();
    }
    expect(streamSeatAspect({ stretchEnabled: true, safeAreaPaddingEnabled: false })).toBeCloseTo(1920 / 1080, 10);
  });

  it.each([false, true])("requests the mirror frame with current safe-area padding %s before the stage mounts", (safeAreaPaddingEnabled) => {
    const surface = document.createElement("main");
    surface.className = "mirror-surface";
    surface.style.padding = "0px 60px";
    surface.getBoundingClientRect = () => new DOMRect(0, 0, 2400, 1080);
    document.body.append(surface);
    try {
      const settings = { stretchEnabled: true, safeAreaPaddingEnabled };
      expect(streamSeatAspect(settings)).toBeCloseTo((safeAreaPaddingEnabled ? 2280 : 2400) / 1080, 10);
    } finally {
      surface.remove();
    }
  });

  it("uses current padding and all four insets even when a mounted stream frame has stale geometry", () => {
    const surface = document.createElement("main");
    surface.className = "mirror-surface";
    surface.style.padding = "5px 31px 21px 59px";
    surface.getBoundingClientRect = () => new DOMRect(0, 0, 2400, 1080);
    const stage = document.createElement("div");
    stage.dataset.testid = "render-stream-stage";
    stage.getBoundingClientRect = () => new DOMRect(0, 0, 2520, 1080);
    surface.append(stage);
    document.body.append(surface);
    try {
      const settings = { stretchEnabled: true, safeAreaPaddingEnabled: true };
      expect(measureStreamBox(settings)).toEqual({ width: 2310, height: 1054 });
      expect(streamSeatAspect(settings)).toBeCloseTo(Math.round(2310 / 1054 * 1080) / 1080, 10);
      settings.safeAreaPaddingEnabled = false;
      expect(measureStreamBox(settings)).toEqual({ width: 2400, height: 1080 });
      expect(streamSeatAspect(settings)).toBeCloseTo(2400 / 1080, 10);
      settings.stretchEnabled = false;
      expect(streamSeatAspect(settings)).toBeUndefined();
    } finally {
      surface.remove();
    }
  });

  it("leaves Shaders and Particles selectable for the stream", () => {
    expect(STREAM_RENDER_OVERRIDES).not.toHaveProperty("shaderMode");
    expect(STREAM_RENDER_OVERRIDES).not.toHaveProperty("particleMode");
  });
});

describe("renderStreamAvailability", () => {
  const qa = qaRenderStreamEndpoint({ renderStreamUrl: "ws://127.0.0.1:14861/render-stream", renderStreamProtocol: 16 });
  const base: RenderStreamAvailabilityInputs = {
    coreProblem: null, coreLoadFailed: false, webgl2: true, directView: false, qaEndpoint: null,
    sessionEndpoint: null, pageLoopback: true, lanOffer: { relay: true, webTransport: false, tls: false, ws: true }
  };

  it.each([8, 11, 12, 13, 14, 15, 17])("rejects a session descriptor with protocol %s", (protocol) => {
    expect(sessionRenderStreamEndpoint({ url: "ws://127.0.0.1:13366/render-stream",
      resourceBase: "http://127.0.0.1:13366", token: "a".repeat(64), protocol })).toBeNull();
  });

  it("derives the QA descriptor: the hub's origin, no token, 1920x1080", () => {
    expect(qa).toEqual({ url: "ws://127.0.0.1:14861/render-stream", resourceBase: "http://127.0.0.1:14861",
      token: null, protocol: 16, presentation: [1920, 1080] });
    expect(qaRenderStreamEndpoint({ renderStreamUrl: "wss://h.example/render-stream", renderStreamProtocol: 16 }))
      .toMatchObject({ resourceBase: "https://h.example", protocol: 16 });
    expect(qaRenderStreamEndpoint({ renderStreamUrl: null, renderStreamProtocol: 16 })).toBeNull();
  });

  it("applies the reasons in the design's precedence", () => {
    const reason = (over: Partial<RenderStreamAvailabilityInputs>) =>
      computeRenderStreamAvailability({ ...base, qaEndpoint: qa, ...over }).reason;
    expect(reason({ coreProblem: "stale", webgl2: false, directView: true })).toBe("core-build");
    expect(reason({ coreLoadFailed: true })).toBe("core-build");
    expect(reason({ webgl2: false, directView: true })).toBe("no-webgl2");
    expect(reason({ directView: true, hostSelfStream: false })).toBe("host-view");
    expect(reason({ directView: true, hostSelfStream: true })).toBeNull();
    // A LAN page on a host with no capture (no offer): its seat cannot stream either.
    expect(reason({ qaEndpoint: null, pageLoopback: false, lanOffer: null })).toBe("host-update");
    expect(reason({ qaEndpoint: null, pageLoopback: false, lanOffer: { webTransport: false, tls: false, ws: true },
      page: { https: true, secureContext: true, webTransport: true } })).toBe("host-update");
    expect(reason({ qaEndpoint: null })).toBe("not-streaming");
    expect(reason({})).toBeNull();
  });

  it("can be chosen exactly when the seat request would ask for the stream", () => {
    const saved = mirrorSettings.renderer;
    try {
      Object.assign(renderStreamContext, { coreProblem: null, webgl2: true, pageLoopback: false,
        page: { https: false, secureContext: false, webTransport: false } });
      mirrorSettings.renderer = "mirror";
      // A plain-http LAN page, before the host's offer arrives (or on a host with no capture): nothing to ask for.
      expect(renderStreamChoosable.value).toBe(false);
      renderStreamContext.lanOffer = { relay: true, webTransport: true, tls: false, ws: true };
      // The saved choice is off; the checkbox asks whether this page could request the stream.
      expect(renderStreamChoosable.value).toBe(true);
      renderStreamContext.directView = true;
      expect(renderStreamChoosable.value).toBe(false);
      renderStreamContext.hostSelfStream = true;
      renderStreamContext.lanOffer = null;
      expect(renderStreamChoosable.value).toBe(true);
      renderStreamContext.directView = false;
      renderStreamContext.webgl2 = false;
      expect(renderStreamChoosable.value).toBe(false);
    } finally {
      mirrorSettings.renderer = saved;
    }
  });

  it.each([
    ["http://127.0.0.1:13337", false, true],
    ["http://127.0.0.1:13337", true, false],
    ["https://host.example", true, true]
  ])("uses the host relay carrier independently of the seat offer (%s, https=%s)", (baseUrl, https, usable) => {
    globalThis.__couchCoopHostBase = baseUrl;
    try {
      const inputs = { ...base, directView: true, hostSelfStream: true, lanOffer: null,
        hostUnavailableReason: "no-capture", pageLoopback: false,
        page: { https, secureContext: https, webTransport: false } };
      expect(seatRendererRequest({ ...inputs, renderer: "stream" })).toBe(usable ? "stream" : undefined);
      expect(computeRenderStreamAvailability(inputs).reason).toBe(usable ? "not-streaming" : "needs-proxy");
      const endpoint = sessionRenderStreamEndpoint({ url: "/render-stream/host/ws", resourceBase: "/render-stream/host",
        token: "a".repeat(64), protocol: 16 });
      expect(computeRenderStreamAvailability({ ...inputs, sessionEndpoint: endpoint }).available).toBe(usable);
      expect(computeRenderStreamAvailability({ ...inputs, qaEndpoint: qa })).toMatchObject({ available: true, source: "qa-override" });
      expect(seatRendererRequest({ ...inputs, renderer: "stream", qaEndpoint: qa })).toBeUndefined();
    } finally {
      delete globalThis.__couchCoopHostBase;
    }
  });

  it("prefers the QA endpoint, then the seat's own descriptor", () => {
    const seat = sessionRenderStreamEndpoint({ url: "ws://127.0.0.1:1/render-stream", resourceBase: "http://127.0.0.1:1",
      token: "a".repeat(64), protocol: 16 });
    expect(seat).not.toBeNull();
    expect(computeRenderStreamAvailability({ ...base, qaEndpoint: qa, sessionEndpoint: seat })).toMatchObject({
      available: true, source: "qa-override", endpoint: qa });
    expect(computeRenderStreamAvailability({ ...base, sessionEndpoint: seat })).toMatchObject({
      available: true, source: "session", endpoint: seat });
  });

  it("treats an unusable envelope descriptor as not streaming", () => {
    expect(sessionRenderStreamEndpoint(null)).toBeNull();
    expect(sessionRenderStreamEndpoint({ url: "ws://x/render-stream", resourceBase: "", token: "short", protocol: 16 })).toBeNull();
    expect(sessionRenderStreamEndpoint({ url: "ws://x/render-stream", resourceBase: "", token: null, protocol: 9 })).toBeNull();
  });

  it("keeps the seat's WebTransport carrier, exactly as the seat serialises it (CAR7)", () => {
    // BrowserRenderStreamDto's JSON (C#, null members omitted): the client validates it and keeps `webTransport`, which
    // its `carrier: "auto"` default prefers on a secure-context page such as the host's own loopback http page.
    const hash = "c".repeat(64);
    const seat = sessionRenderStreamEndpoint(JSON.parse(JSON.stringify({ url: "ws://127.0.0.1:13366/render-stream",
      resourceBase: "http://127.0.0.1:13366", token: "a".repeat(64), protocol: 16, presentation: [1920, 1080],
      webTransport: { url: "https://127.0.0.1:13366/render-stream", certificateHashes: [hash] } })));
    expect(seat?.webTransport).toEqual({ url: "https://127.0.0.1:13366/render-stream", certificateHashes: [hash] });
    expect(computeRenderStreamAvailability({ ...base, sessionEndpoint: seat })).toMatchObject({ available: true, source: "session" });
    // A malformed carrier spoils the whole descriptor (the client never guesses), which the seat's own checks prevent.
    expect(sessionRenderStreamEndpoint({ url: "ws://127.0.0.1:1/render-stream", resourceBase: "http://127.0.0.1:1",
      token: null, protocol: 16, webTransport: null })).toBeNull();
    expect(sessionRenderStreamEndpoint({ url: "ws://127.0.0.1:1/render-stream", resourceBase: "http://127.0.0.1:1",
      token: null, protocol: 16, webTransport: { url: "http://127.0.0.1:1/render-stream" } })).toBeNull();
  });

  it("names why the core is unusable: the build's problem first, then a failed load", () => {
    expect(coreBuildCause(null, false)).toBeNull();
    expect(coreBuildCause("missing", false)).toBe("missing");
    expect(coreBuildCause("stale", true)).toBe("stale");
    expect(coreBuildCause("unverified", false)).toBe("unverified");
    expect(coreBuildCause(null, true)).toBe("load-failed");
  });

  // CAR7b: which LAN page can use which carrier. A page is (https?, secure context?, WebTransport?); the host offers
  // WebTransport (net module), wss (a host certificate naming the page's host), and plain ws only when it has no
  // certificate at all. CAR9: every page runs the client, a plain-http LAN page included (godot-scene-web hashes the
  // core without crypto.subtle there), so the carrier alone decides.
  describe("the LAN carrier matrix", () => {
    const pages = {
      httpsChrome: { https: true, secureContext: true, webTransport: true },
      httpsNoWt: { https: true, secureContext: true, webTransport: false },
      httpLan: { https: false, secureContext: false, webTransport: true }
    } as const;
    const offers = {
      wtTls: { webTransport: true, tls: true, ws: false },
      wtPlain: { webTransport: true, tls: false, ws: true },
      tlsOnly: { webTransport: false, tls: true, ws: false },
      plainOnly: { webTransport: false, tls: false, ws: true },
      // The host has a certificate, but for another host name (an IP page on a secure-origin host): no wss for this
      // page, and the hub refuses plain ws from the LAN.
      wtOtherCert: { webTransport: true, tls: false, ws: false },
      otherCert: { webTransport: false, tls: false, ws: false }
    } as const;
    // [page, offer, usable]
    const matrix: [keyof typeof pages, keyof typeof offers, boolean][] = [
      ["httpsChrome", "wtTls", true], ["httpsChrome", "wtPlain", true], ["httpsChrome", "tlsOnly", true],
      ["httpsChrome", "plainOnly", false], ["httpsChrome", "wtOtherCert", true], ["httpsChrome", "otherCert", false],
      ["httpsNoWt", "wtTls", true], ["httpsNoWt", "wtPlain", false], ["httpsNoWt", "tlsOnly", true],
      ["httpsNoWt", "plainOnly", false], ["httpsNoWt", "wtOtherCert", false], ["httpsNoWt", "otherCert", false],
      ["httpLan", "wtTls", true], ["httpLan", "wtPlain", true], ["httpLan", "tlsOnly", true], ["httpLan", "plainOnly", true],
      ["httpLan", "wtOtherCert", false], ["httpLan", "otherCert", false]
    ];
    it.each(matrix)("a %s page with a %s offer: a usable carrier=%s", (page, offer, usable) => {
      expect(lanCarrierUsable(offers[offer], pages[page])).toBe(usable);
      const at = computeRenderStreamAvailability({ ...base, pageLoopback: false, lanOffer: offers[offer], page: pages[page] });
      expect(at.reason).toBe("host-update");
      expect(seatRendererRequest({ renderer: "stream", coreProblem: null, coreLoadFailed: false, webgl2: true,
        pageLoopback: false, qaEndpoint: null, lanOffer: offers[offer], page: pages[page] })).toBeUndefined();
    });

    it("streams a plain-http LAN page over the seat's ws, never WebTransport (CAR9)", () => {
      const token = "a".repeat(64);
      const ws = sessionRenderStreamEndpoint({ url: "ws://192.168.1.77:13366/render-stream",
        resourceBase: "http://192.168.1.77:13366", token, protocol: 16 })!;
      expect(endpointCarrierUsable(ws, pages.httpLan)).toBe(true);
      expect(computeRenderStreamAvailability({ ...base, pageLoopback: false, sessionEndpoint: ws, page: pages.httpLan }))
        .toMatchObject({ available: true, source: "session", endpoint: ws });
      // WebTransport needs a secure context: a WebTransport member does not make a descriptor usable on an http page,
      // only its socket url does (the seat describes none for an http page anyway).
      const wtOnHttps = sessionRenderStreamEndpoint({ url: "wss://192.168.1.77:13366/render-stream",
        resourceBase: "https://192.168.1.77:13366", token, protocol: 16,
        webTransport: { url: "https://192.168.1.77:13366/render-stream", certificateHashes: ["c".repeat(64)] } })!;
      expect(endpointCarrierUsable({ ...wtOnHttps, url: "ws://192.168.1.77:13366/render-stream" },
        { https: true, secureContext: false, webTransport: true })).toBe(false);
      // The host's loopback http page IS a secure context.
      expect(computeRenderStreamAvailability({ ...base, sessionEndpoint: ws })).toMatchObject({ available: true });
    });

    it("says not-streaming, not needs-proxy, on a host with no capture (no offer), and asks for no streaming seat", () => {
      for (const page of Object.values(pages)) {
        expect(computeRenderStreamAvailability({ ...base, pageLoopback: false, lanOffer: null, page }).reason).toBe("host-update");
        expect(seatRendererRequest({ renderer: "stream", coreProblem: null, coreLoadFailed: false, webgl2: true,
          pageLoopback: false, qaEndpoint: null, lanOffer: null, page })).toBeUndefined();
      }
    });

    it("judges a seat's descriptor by what this page can open", () => {
      const token = "a".repeat(64);
      const wt = { url: "https://192.168.1.77:13366/render-stream", certificateHashes: ["c".repeat(64)] };
      const plainWithWt = sessionRenderStreamEndpoint({ url: "ws://192.168.1.77:13366/render-stream",
        resourceBase: "https://192.168.1.77:13366", token, protocol: 16, webTransport: wt })!;
      const wss = sessionRenderStreamEndpoint({ url: "wss://192.168.1.77:13366/render-stream",
        resourceBase: "https://192.168.1.77:13366", token, protocol: 16 })!;
      const ws = sessionRenderStreamEndpoint({ url: "ws://192.168.1.77:13366/render-stream",
        resourceBase: "http://192.168.1.77:13366", token, protocol: 16 })!;
      expect(endpointCarrierUsable(plainWithWt, pages.httpsChrome)).toBe(true);
      expect(endpointCarrierUsable(plainWithWt, pages.httpsNoWt)).toBe(false);
      expect(endpointCarrierUsable(wss, pages.httpsNoWt)).toBe(true);
      expect(endpointCarrierUsable(wss, pages.httpLan)).toBe(true);
      expect(endpointCarrierUsable(ws, pages.httpLan)).toBe(true);
      expect(endpointCarrierUsable(ws, pages.httpsChrome)).toBe(false);
      expect(computeRenderStreamAvailability({ ...base, pageLoopback: false, sessionEndpoint: plainWithWt,
        page: pages.httpsNoWt })).toMatchObject({ available: false, reason: "needs-proxy" });
      expect(computeRenderStreamAvailability({ ...base, pageLoopback: false, sessionEndpoint: plainWithWt,
        page: pages.httpsChrome })).toMatchObject({ available: true, source: "session" });
      // The host's own loopback page keeps working exactly as before (ws on loopback).
      const loop = sessionRenderStreamEndpoint({ url: "ws://127.0.0.1:13366/render-stream",
        resourceBase: "http://127.0.0.1:13366", token, protocol: 16 })!;
      expect(computeRenderStreamAvailability({ ...base, sessionEndpoint: loop })).toMatchObject({ available: true });
    });

    it("parses the host session's offer, refusing what it does not understand", () => {
      expect(parseLanOffer({ webTransport: true, tls: false, ws: false })).toEqual({ webTransport: true, tls: false, ws: false });
      expect(parseLanOffer({ webTransport: false, tls: false, ws: true })).toEqual({ webTransport: false, tls: false, ws: true });
      // A host from before CAR9 sends no `ws`: its `tls: false` meant plain ws.
      expect(parseLanOffer({ webTransport: true, tls: false })).toEqual({ webTransport: true, tls: false, ws: true });
      expect(parseLanOffer({ webTransport: true, tls: true })).toEqual({ webTransport: true, tls: true, ws: false });
      expect(parseLanOffer({ webTransport: true, tls: true, ws: "no" })).toBeNull();
      expect(parseLanOffer(null)).toBeNull();
      expect(parseLanOffer({ webTransport: "yes", tls: false })).toBeNull();
      expect(parseLanOffer({ tls: true })).toBeNull();
    });
  });

  it("asks the seat to stream only when the viewer chose it and this page can draw it", () => {
    const ask = { renderer: "stream" as const, coreProblem: null, coreLoadFailed: false, webgl2: true, pageLoopback: true,
      qaEndpoint: null, lanOffer: { relay: true, webTransport: false, tls: false, ws: true } };
    expect(seatRendererRequest(ask)).toBe("stream");
    expect(seatRendererRequest({ ...ask, renderer: "mirror" })).toBeUndefined();
    expect(seatRendererRequest({ ...ask, coreProblem: "missing" })).toBeUndefined();
    expect(seatRendererRequest({ ...ask, coreLoadFailed: true })).toBeUndefined();
    expect(seatRendererRequest({ ...ask, webgl2: false })).toBeUndefined();
    // A LAN or HTTPS page cannot reach a loopback hub: the seat would stream for nobody.
    expect(seatRendererRequest({ ...ask, pageLoopback: false, lanOffer: null })).toBeUndefined();
    // A QA endpoint brings its own hub.
    expect(seatRendererRequest({ ...ask, qaEndpoint: qa })).toBeUndefined();
  });

  it("knows a loopback http page", () => {
    expect(isLoopbackHttpPage({ protocol: "http:", hostname: "127.0.0.1" })).toBe(true);
    expect(isLoopbackHttpPage({ protocol: "http:", hostname: "localhost" })).toBe(true);
    expect(isLoopbackHttpPage({ protocol: "http:", hostname: "192.168.1.20" })).toBe(false);
    expect(isLoopbackHttpPage({ protocol: "https:", hostname: "127.0.0.1" })).toBe(false);
  });

  it("runs the stream for a QA endpoint only by the saved choice, when available, until it stops", () => {
    const yes = computeRenderStreamAvailability({ ...base, qaEndpoint: qa });
    const no = computeRenderStreamAvailability(base);
    expect(resolveRuntimeRenderer("stream", yes, null)).toBe("stream");
    expect(resolveRuntimeRenderer("mirror", yes, null)).toBe("mirror");
    expect(resolveRuntimeRenderer("stream", no, null)).toBe("mirror");
    expect(resolveRuntimeRenderer("stream", yes, "host-error: bye")).toBe("mirror");
  });

  it("runs a seat stream only when this page chose it, until it stops", () => {
    const seat = sessionRenderStreamEndpoint({ url: "ws://127.0.0.1:1/render-stream", resourceBase: "http://127.0.0.1:1",
      token: "a".repeat(64), protocol: 16 });
    const streaming = computeRenderStreamAvailability({ ...base, sessionEndpoint: seat });
    expect(resolveRuntimeRenderer("mirror", streaming, null)).toBe("mirror");
    expect(resolveRuntimeRenderer("stream", streaming, null)).toBe("stream");
    expect(resolveRuntimeRenderer("mirror", streaming, "live-connect-failed: never opened")).toBe("mirror");
    // A seat started without the stream: the old renderer, whatever was saved.
    expect(resolveRuntimeRenderer("stream", computeRenderStreamAvailability(base), null)).toBe("mirror");
  });

  it("promotes the live renderer when available, falls back on a stop, and keeps the saved choice", () => {
    const saved = { renderer: mirrorSettings.renderer, url: mirrorSettings.renderStreamUrl };
    try {
      Object.assign(renderStreamContext, { coreProblem: null, webgl2: true, pageLoopback: true });
      Object.assign(mirrorSettings, { renderer: "stream", renderStreamUrl: "ws://127.0.0.1:9/render-stream",
        renderStreamProtocol: 16 });
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

  it("stops on a core load timeout without holding the core unusable, so Try again loads it again", () => {
    const saved = { renderer: mirrorSettings.renderer, url: mirrorSettings.renderStreamUrl };
    try {
      Object.assign(renderStreamContext, { coreProblem: null, webgl2: true, pageLoopback: true });
      Object.assign(mirrorSettings, { renderer: "stream", renderStreamUrl: "ws://127.0.0.1:9/render-stream",
        renderStreamProtocol: 16 });
      syncRuntimeRenderer();

      stopRenderStream("core-load-failed: timeout after 30000 ms in wasm fetch + glue import");
      expect(renderStreamContext.coreLoadFailed).toBe(false);
      expect(mirrorSettings.runtimeRenderer).toBe("mirror");
      retryRenderStream();
      expect(renderStreamAvailability.value.available).toBe(true);
      expect(mirrorSettings.runtimeRenderer).toBe("stream");

      // Without the detail, or with any other one, a failed load still holds for the session.
      for (const reason of ["core-load-failed", "core-load-failed: stale core", "core-load-failed: timeouts"]) {
        renderStreamContext.coreLoadFailed = false;
        stopRenderStream(reason);
        expect(renderStreamContext.coreLoadFailed, reason).toBe(true);
      }
    } finally {
      Object.assign(mirrorSettings, { renderer: saved.renderer, renderStreamUrl: saved.url, runtimeRenderer: "mirror" });
      Object.assign(renderStreamContext, { coreLoadFailed: false, stopped: null });
    }
  });
});

describe("relay protocol2", () => {
  it("normalizes relay paths on the host before validating carriers, preserving resource prefixes", () => {
    const raw = { url: "/render-stream/seat-1/ws", resourceBase: "/render-stream/seat-1",
      token: null, protocol: 16, presentation: [2340, 1080] };
    const endpoint = sessionRenderStreamEndpoint(raw, "https://host.example");
    expect(endpoint).toMatchObject({ url: "wss://host.example/render-stream/seat-1/ws",
      resourceBase: "https://host.example/render-stream/seat-1", presentation: [2340, 1080] });
    expect(endpointCarrierUsable(endpoint!, { https: true, secureContext: true, webTransport: false })).toBe(true);
    expect(sessionRenderStreamEndpoint({ ...raw, resourceBase: "" }, "http://host.example"))
      .toMatchObject({ resourceBase: "http://host.example", url: "ws://host.example/render-stream/seat-1/ws" });
  });

  it("requires relay capability even on loopback, while keeping direct QA overrides usable", () => {
    const inputs: RenderStreamAvailabilityInputs = { coreProblem: null, coreLoadFailed: false,
      webgl2: true, directView: false, qaEndpoint: null, sessionEndpoint: null, pageLoopback: true };
    expect(computeRenderStreamAvailability(inputs).reason).toBe("host-update");
    expect(seatRendererRequest({ ...inputs, renderer: "stream" })).toBeUndefined();
    const qa = qaRenderStreamEndpoint({ renderStreamUrl: "ws://localhost:9/render-stream", renderStreamProtocol: 16 });
    expect(computeRenderStreamAvailability({ ...inputs, qaEndpoint: qa }).available).toBe(true);
    expect(parseLanOffer({ relay: true, webTransport: false, tls: false, ws: true })?.relay).toBe(true);
  });
});

it("keeps tunnel prefixes on host-relative stream descriptors and resources", () => {
  const base = "https://pages.example/~h/abcdefghijklmnopqrstuv";
  const endpoint = sessionRenderStreamEndpoint({ url: "/render-stream/host/ws", resourceBase: "/render-stream/host",
    token: null, protocol: 16 }, base);
  expect(endpoint?.url).toBe("wss://pages.example/~h/abcdefghijklmnopqrstuv/render-stream/host/ws");
  expect(endpoint?.resourceBase).toBe(`${base}/render-stream/host`);
  expect(sessionRenderStreamEndpoint({ url: "/render-stream/host/ws", resourceBase: "", token: null, protocol: 16 }, base)?.resourceBase)
    .toBe(base);
});
