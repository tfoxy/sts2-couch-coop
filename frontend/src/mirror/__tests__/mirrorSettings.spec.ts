import { computed, isReactive } from "vue";
import { describe, expect, it } from "vitest";

import type { GpuInfo } from "@godot-scene-web/html";

import { resolveRenderQuality, type RenderQuality, type RenderQualityTier } from "@/render/quality";
import {
  clearStoredMirrorSettings,
  createMirrorSettings,
  DEFAULT_PARTICLE_MODE,
  DEFAULT_REFRESH_RATE,
  DEFAULT_SHADER_MODE,
  hasStoredMirrorSetting,
  MIRROR_SETTINGS_STORAGE_KEY,
  NEVER_PERSISTED_SETTING_KEYS,
  persistMirrorSetting,
  PERSISTED_SETTING_KEYS,
  readStoredMirrorSettings,
  REFRESH_RATE_MAX,
  REFRESH_RATE_MIN,
  SERVER_SETTING_KEYS,
  serverSettingsPayload,
  staticBgWireValue,
  type MirrorSettings,
  type MirrorSettingsStorage
} from "@/mirror/mirrorSettings";

// A full RenderQuality fixture — only the tier + the two enable flags matter now (the tier's ONLY contribution to
// the seed is the hard-off floor; everything else is a shared product default), the rest is filler.
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
    shaderFps: 30,
    particleFps: 30,
    maxTextureDim: 4096,
    maxTrailPoints: 0,
    staticShaderScale: 1,
    staticParticleScale: 1,
    source: "default",
    ...overrides
  };
}

// A RAM-backed MirrorSettingsStorage (the injectable seam) — these tests never touch the real localStorage, so a
// suite that runs in any order can't leak a saved preference into an unrelated spec.
function fakeStorage(seed?: Record<string, unknown>): MirrorSettingsStorage & { raw(): string | null } {
  let value: string | null = seed === undefined ? null : JSON.stringify(seed);
  return {
    getItem: (key) => (key === MIRROR_SETTINGS_STORAGE_KEY ? value : null),
    setItem: (key, next) => {
      if (key === MIRROR_SETTINGS_STORAGE_KEY) {
        value = next;
      }
    },
    removeItem: (key) => {
      if (key === MIRROR_SETTINGS_STORAGE_KEY) {
        value = null;
      }
    },
    raw: () => value
  };
}

// `storage: null` = the RAM-only behavior of a browser with no usable web storage (also the default here, so a
// case that doesn't mention storage is testing the URL/tier layers alone).
function build(
  q: RenderQuality = quality(),
  search = "",
  storage: MirrorSettingsStorage | null = null
): MirrorSettings {
  return createMirrorSettings(q, search, { storage });
}

describe("createMirrorSettings — unified effect defaults (mobile == desktop)", () => {
  it("defaults BOTH families to Static on a full-fidelity desktop tier", () => {
    const s = build();
    expect(s.shaderMode).toBe("static");
    expect(s.particleMode).toBe("static");
    expect(s.shaderMode).toBe(DEFAULT_SHADER_MODE);
    expect(s.particleMode).toBe(DEFAULT_PARTICLE_MODE);
    // Nothing is pinned until the viewer changes a mode in the panel.
    expect(s.effectModePinned).toBe(false);
  });

  it("gives every LIVE tier the same two defaults — the tier no longer seeds a mode", () => {
    // Including the tiers a phone auto-resolves to: `static` (weak mobile GPU) seeds particlesEnabled FALSE and
    // `min` seeds a 0.125 renderScale, and neither may leak into what the panel offers this viewer.
    const tiers: Partial<RenderQuality>[] = [
      { tier: "high", renderScale: 1 },
      { tier: "low", renderScale: 0.5 },
      { tier: "min", renderScale: 0.125 },
      { tier: "static", shadersStatic: true, particlesEnabled: false, renderScale: 0.25 }
    ];
    for (const overrides of tiers) {
      const s = build(quality(overrides));
      expect([overrides.tier, s.shaderMode, s.particleMode]).toEqual([overrides.tier, "static", "static"]);
    }
  });

  it("agrees with the REAL resolver for a mobile phone and a desktop (same two modes)", () => {
    const phone = resolveRenderQuality({
      search: "",
      gpu: { renderer: "Mali-G57 MC2", software: false, unavailable: false } as GpuInfo,
      mobile: true,
      hardwareConcurrency: 8,
      deviceMemory: 8
    });
    const desktop = resolveRenderQuality({
      search: "",
      gpu: { renderer: "NVIDIA GeForce RTX 4080", software: false, unavailable: false } as GpuInfo,
      hardwareConcurrency: 16,
      deviceMemory: 16
    });
    expect(phone.tier).toBe("static"); // the mobile tier whose particles used to be unreachable
    expect(desktop.tier).toBe("high");
    for (const q of [phone, desktop]) {
      const s = build(q);
      expect(s.shaderMode).toBe("static");
      expect(s.particleMode).toBe("static");
    }
  });

  it("floors BOTH modes to off in the hard-off lane (?debug / ?quality=off), saved value or not", () => {
    const off = quality({ tier: "off", shadersEnabled: false, particlesEnabled: false });
    const s = build(off);
    expect(s.shaderMode).toBe("off");
    expect(s.particleMode).toBe("off");
    // The floor outranks a saved preference too — the panel must not offer a mode that physically cannot run.
    const saved = build(off, "", fakeStorage({ shaderMode: "dynamic", particleMode: "dynamic" }));
    expect(saved.shaderMode).toBe("off");
    expect(saved.particleMode).toBe("off");
  });
});

describe("createMirrorSettings — URL overrides", () => {
  it("accepts only canonical ?shaders= modes", () => {
    expect(build(quality(), "?shaders=dynamic").shaderMode).toBe("dynamic");
    expect(build(quality(), "?shaders=dynamic-half").shaderMode).toBe("dynamic-half");
    expect(build(quality(), "?shaders=off").shaderMode).toBe("off");
    // An unrecognized or retired alias is no override at all → the default stands.
    expect(build(quality(), "?shaders=1").shaderMode).toBe("static");
    expect(build(quality(), "?shaders=half").shaderMode).toBe("static");
    expect(build(quality(), "?shaders=sideways").shaderMode).toBe("static");
  });

  it("accepts only canonical ?particles= modes", () => {
    expect(build(quality(), "?particles=dynamic").particleMode).toBe("dynamic");
    expect(build(quality(), "?particles=static").particleMode).toBe("static");
    expect(build(quality(), "?particles=off").particleMode).toBe("off");
    expect(build(quality(), "?particles=dynamic-quarter").particleMode).toBe("dynamic-quarter");
    expect(build(quality(), "?particles=quarter").particleMode).toBe("static");
    expect(build(quality(), "?particles=sideways").particleMode).toBe("static");
  });

  it("seeds the widescreen stretch ON unless the URL says ?stretch=off", () => {
    expect(build(quality(), "").stretchEnabled).toBe(true);
    expect(build(quality(), "").stretchEnabled).toBe(true);
    expect(build(quality(), "?stretch=off").stretchEnabled).toBe(false);
    // Only the strict "off" disables.
    expect(build(quality(), "?stretch=on").stretchEnabled).toBe(true);
  });

  it("seeds the readability scaling ON unless the URL says ?uiScale=off", () => {
    expect(build(quality(), "").uiScaling).toBe(true);
    expect(build(quality(), "?uiScale=on").uiScaling).toBe(true);
    expect(build(quality(), "?uiScale=off").uiScaling).toBe(false);
  });

  it("remembers the readability scaling, and the URL still wins for the session", () => {
    // The parity/escape-hatch switch is the viewer's, so a saved OFF has to survive a reload — and a shared
    // `?uiScale=off` debug link must not overwrite the phone's saved choice (the store-wide layering rule).
    expect(build(quality(), "", fakeStorage({ uiScaling: false })).uiScaling).toBe(false);
    expect(build(quality(), "?uiScale=on", fakeStorage({ uiScaling: false })).uiScaling).toBe(true);
  });

  it("seeds the held-card raise ON unless the URL says ?raiseCard=off", () => {
    expect(build(quality(), "").raiseHeldCard).toBe(true);
    expect(build(quality(), "?raiseCard=on").raiseHeldCard).toBe(true);
    expect(build(quality(), "?raiseCard=off").raiseHeldCard).toBe(false);
  });

  it("seeds the peek un-focus-on-release ON unless the URL says ?unfocus=off", () => {
    expect(build(quality(), "").unfocusOnRelease).toBe(true);
    expect(build(quality(), "?unfocus=on").unfocusOnRelease).toBe(true);
    expect(build(quality(), "?unfocus=off").unfocusOnRelease).toBe(false);
  });

  it("seeds the two-step tap-to-focus ON unless the URL says ?tapFocus=off", () => {
    expect(build(quality(), "").tapToFocus).toBe(true);
    expect(build(quality(), "?tapFocus=on").tapToFocus).toBe(true);
    expect(build(quality(), "?tapFocus=off").tapToFocus).toBe(false);
  });

  it("seeds Confirm tap ON unless the URL says ?confirmTap=off", () => {
    // Default ON alongside tap-to-focus: on the screens a tap cannot take back, the confirm button is the guard.
    expect(build(quality(), "").confirmTap).toBe(true);
    expect(build(quality(), "?confirmTap=on").confirmTap).toBe(true);
    expect(build(quality(), "?confirmTap=off").confirmTap).toBe(false);
  });

  it("seeds raise-hand cards OFF on every device, with saved and URL opt-ins preserved", () => {
    expect(build(quality(), "").raiseHandCards).toBe(false);
    expect(build(quality(), "?raiseHand=on").raiseHandCards).toBe(true);
    expect(build(quality(), "", fakeStorage({ raiseHandCards: true })).raiseHandCards).toBe(true);
    expect(build(quality(), "?raiseHand=off", fakeStorage({ raiseHandCards: true })).raiseHandCards).toBe(false);
  });

  it("seeds the static background ON unless the URL says ?staticBg=off", () => {
    expect(build(quality(), "").staticBgEnabled).toBe(true);
    expect(build(quality(), "?staticBg=on").staticBgEnabled).toBe(true);
    expect(build(quality(), "?staticBg=off").staticBgEnabled).toBe(false);
  });

  // A CAPABILITY, not a preference: the current browser drives the card-flight trail root from the flight hint.
  it("declares the current browser trail-drive capability", () => {
    expect(build(quality(), "").trailDriveCapable).toBe(true);
  });

  it("seeds the SERVER fields to the game's headless defaults", () => {
    const s = build();
    expect(s.refreshRate).toBe(DEFAULT_REFRESH_RATE);
    expect(s.freezeParticles).toBe(true);
    expect(s.freezeSpines).toBe(true);
    expect(s.freezeDecor).toBe(true);
    expect(s.tweenReplay).toBe(true);
    expect(s.panelOpen).toBe(false);
  });

  it("seeds the spine mode to STATIC (server-baked stills for every viewer)", () => {
    expect(build(quality(), "").spineMode).toBe("static");
  });

  it("returns a reactive store whose mutations propagate to derived state", () => {
    const s = build();
    expect(isReactive(s)).toBe(true);

    const derived = computed(() => s.refreshRate);
    expect(derived.value).toBe(DEFAULT_REFRESH_RATE);
    s.refreshRate = 8;
    expect(derived.value).toBe(8);

    const shaders = computed(() => s.shaderMode);
    s.shaderMode = "off";
    expect(shaders.value).toBe("off");
  });
});

// The layering the whole persistence feature is: built-in defaults < device tier seed < localStorage < URL query.
describe("createMirrorSettings — persistence layering", () => {
  it("a SAVED value beats the built-in default", () => {
    const storage = fakeStorage({
      shaderMode: "dynamic",
      particleMode: "off",
      stretchEnabled: false,
      raiseHeldCard: false,
      unfocusOnRelease: false,
      tapToFocus: false,
      confirmTap: false,
      backstopOcclusion: false,
      staticBgEnabled: false,
      latencyOverlay: true,
      refreshRate: 40,
      tweenReplay: false
    });
    const s = build(quality(), "", storage);
    expect(s.shaderMode).toBe("dynamic");
    expect(s.particleMode).toBe("off");
    expect(s.stretchEnabled).toBe(false);
    expect(s.raiseHeldCard).toBe(false);
    expect(s.unfocusOnRelease).toBe(false);
    expect(s.tapToFocus).toBe(false);
    expect(s.confirmTap).toBe(false);
    expect(s.backstopOcclusion).toBe(false);
    expect(s.staticBgEnabled).toBe(false);
    expect(s.latencyOverlay).toBe(true);
    expect(s.refreshRate).toBe(40);
    expect(s.tweenReplay).toBe(false);
  });

  it("the static background layers URL > saved > default (and a saved OFF persists)", () => {
    const storage = fakeStorage({ staticBgEnabled: false });
    expect(build(quality(), "", storage).staticBgEnabled).toBe(false);
    // A URL that says nothing must NOT overwrite the saved choice…
    expect(build(quality(), "", storage).staticBgEnabled).toBe(false);
    // …while an explicit flag wins for the session either way.
    expect(build(quality(), "?staticBg=on", storage).staticBgEnabled).toBe(true);
    expect(build(quality(), "?staticBg=off", fakeStorage({ staticBgEnabled: true })).staticBgEnabled).toBe(false);
    // The panel's own change is what persists (per-field write).
    persistMirrorSetting("staticBgEnabled", true, storage);
    expect(readStoredMirrorSettings(storage).staticBgEnabled).toBe(true);
  });

  it("a URL override beats the SAVED value — for this session only", () => {
    const storage = fakeStorage({ shaderMode: "off", particleMode: "off", stretchEnabled: true });
    const s = build(quality(), "?shaders=dynamic&particles=static&stretch=off", storage);
    expect(s.shaderMode).toBe("dynamic");
    expect(s.particleMode).toBe("static");
    expect(s.stretchEnabled).toBe(false);
    // …and nothing was written back: the saved preferences are exactly as they were. (Changing a setting in the
    // panel afterwards is what saves — see the SettingsPanel persistence spec.)
    expect(JSON.parse(storage.raw()!)).toEqual({ shaderMode: "off", particleMode: "off", stretchEnabled: true });
  });

  it("the tier floor beats both (hard-off lane), while a LIVE tier defers to them entirely", () => {
    const storage = fakeStorage({ shaderMode: "dynamic" });
    const offTier = quality({ tier: "off", shadersEnabled: false, particlesEnabled: false });
    expect(build(offTier, "?shaders=dynamic", storage).shaderMode).toBe("off");
    // The `static` tier is NOT a floor — a saved Dynamic survives it (this is the mobile clamp that was lifted).
    const staticTier = quality({ tier: "static", shadersStatic: true, particlesEnabled: false });
    expect(build(staticTier, "", fakeStorage({ particleMode: "dynamic" })).particleMode).toBe("dynamic");
  });

  it("a viewer with no saved settings (and no storage at all) gets the plain defaults", () => {
    for (const storage of [null, fakeStorage()]) {
      const s = build(quality(), "", storage);
      expect(s.shaderMode).toBe("static");
      expect(s.particleMode).toBe("static");
      expect(s.refreshRate).toBe(DEFAULT_REFRESH_RATE);
      expect(s.tweenReplay).toBe(true);
    }
  });

  it("`?latency` only ever turns the overlay ON; a saved choice decides when it is absent", () => {
    expect(build(quality(), "?latency=1").latencyOverlay).toBe(true);
    expect(build(quality(), "", fakeStorage({ latencyOverlay: true })).latencyOverlay).toBe(true);
    expect(build(quality(), "", fakeStorage({ latencyOverlay: false })).latencyOverlay).toBe(false);
    expect(build(quality(), "?latency=1", fakeStorage({ latencyOverlay: false })).latencyOverlay).toBe(true);
  });
});

describe("createMirrorSettings — the repro recorder (and the build that excludes it)", () => {
  // `reproUiEnabled` is buildFlags' `REPRO_UI_ENABLED`, injected here so both builds can be exercised from one
  // bundle. See the field in mirrorSettings.ts for why an excluded build must ignore a SAVED value.
  const shipped = (search = "", storage: MirrorSettingsStorage | null = null): MirrorSettings =>
    createMirrorSettings(quality(), search, { storage, reproUiEnabled: true });
  const excluded = (search = "", storage: MirrorSettingsStorage | null = null): MirrorSettings =>
    createMirrorSettings(quality(), search, { storage, reproUiEnabled: false });

  it("is OFF by default — a diagnostic nobody asked for costs a ring buffer and input listeners", () => {
    expect(shipped().reproRecorder).toBe(false);
  });

  it("reads `?repro` as a TRI-state, so a URL that says nothing cannot overwrite a saved choice", () => {
    expect(shipped("?repro=on").reproRecorder).toBe(true);
    expect(shipped("?repro").reproRecorder).toBe(true);
    expect(shipped("?repro=1").reproRecorder).toBe(true);
    expect(shipped("?repro=off").reproRecorder).toBe(false);
    // Absent: the saved value decides, either way.
    expect(shipped("", fakeStorage({ reproRecorder: true })).reproRecorder).toBe(true);
    expect(shipped("", fakeStorage({ reproRecorder: false })).reproRecorder).toBe(false);
    // Present: the URL wins for the session, over either saved value.
    expect(shipped("?repro=off", fakeStorage({ reproRecorder: true })).reproRecorder).toBe(false);
    expect(shipped("?repro=on", fakeStorage({ reproRecorder: false })).reproRecorder).toBe(true);
  });

  it("is SAVED, because reproducing a bug spans reloads", () => {
    expect(PERSISTED_SETTING_KEYS as readonly string[]).toContain("reproRecorder");
    const storage = fakeStorage();
    persistMirrorSetting("reproRecorder", true, storage);
    expect(readStoredMirrorSettings(storage)).toEqual({ reproRecorder: true });
    expect(hasStoredMirrorSetting("reproRecorder", storage)).toBe(true);
  });

  it("rejects a non-boolean stored value rather than coercing it", () => {
    expect(readStoredMirrorSettings(fakeStorage({ reproRecorder: "yes" }))).toEqual({});
    expect(shipped("", fakeStorage({ reproRecorder: "yes" })).reproRecorder).toBe(false);
  });

  it("IGNORES a stale saved `true` in a build that excluded the recorder's UI", () => {
    // The switch is not in that build's settings panel, so a viewer left recording by a value they set on a
    // previous build would have no way to see it, let alone stop it.
    expect(excluded("", fakeStorage({ reproRecorder: true })).reproRecorder).toBe(false);
    expect(excluded().reproRecorder).toBe(false);
  });

  it("still honours `?repro=on` in an excluded build — the support escape hatch", () => {
    expect(excluded("?repro=on", fakeStorage({ reproRecorder: false })).reproRecorder).toBe(true);
    expect(excluded("?repro=off", fakeStorage({ reproRecorder: true })).reproRecorder).toBe(false);
  });
});

describe("the persisted key set", () => {
  it("covers every field of the store exactly once, split between saved and never-saved", () => {
    const all = Object.keys(build()).sort();
    const covered = [...PERSISTED_SETTING_KEYS, ...NEVER_PERSISTED_SETTING_KEYS].sort();
    expect(covered).toEqual(all);
  });

  it("never saves host truth or momentary UI", () => {
    // The three freezes are re-seeded per connection from the instance that actually serves this viewer; the
    // panel anchor is a measured pixel of a layout that no longer exists; `spineMode` has no panel control.
    for (const key of [
      "freezeParticles",
      "freezeSpines",
      "freezeDecor",
      "panelOpen",
      "panelAnchorTop",
      "effectModePinned",
      "spineMode"
    ]) {
      expect(NEVER_PERSISTED_SETTING_KEYS as readonly string[]).toContain(key);
      expect(PERSISTED_SETTING_KEYS as readonly string[]).not.toContain(key);
    }
  });

  it("DOES save the two server-tied preferences (refresh rate + tween replay)", () => {
    // They ride the `settings` channel like the freezes, but they are the viewer's preference about their own
    // stream rather than a truth about the instance — MirrorApp pushes them AFTER the session seed.
    expect(PERSISTED_SETTING_KEYS as readonly string[]).toContain("refreshRate");
    expect(PERSISTED_SETTING_KEYS as readonly string[]).toContain("tweenReplay");
  });
});

describe("persistMirrorSetting / readStoredMirrorSettings", () => {
  it("writes ONE field at a time and merges with what is already saved", () => {
    const storage = fakeStorage();
    persistMirrorSetting("shaderMode", "dynamic", storage);
    persistMirrorSetting("refreshRate", 40, storage);
    expect(readStoredMirrorSettings(storage)).toEqual({ shaderMode: "dynamic", refreshRate: 40 });
    persistMirrorSetting("shaderMode", "off", storage);
    expect(readStoredMirrorSettings(storage)).toEqual({ shaderMode: "off", refreshRate: 40 });
  });

  it("prunes unknown and invalid values on every read and write", () => {
    const storage = fakeStorage({
      shaderMode: "sideways", // not an EffectMode
      particleMode: "static", // valid
      refreshRate: 9000, // outside the slider's range
      stretchEnabled: "yes", // not a boolean
      somethingElse: 1 // not ours at all
    });
    expect(readStoredMirrorSettings(storage)).toEqual({ particleMode: "static" });
    persistMirrorSetting("tweenReplay", false, storage);
    expect(JSON.parse(storage.raw()!)).toEqual({ particleMode: "static", tweenReplay: false });
  });

  it("accepts a refresh rate at the slider's edges and rejects anything beyond them", () => {
    const storage = fakeStorage();
    persistMirrorSetting("refreshRate", REFRESH_RATE_MIN, storage);
    expect(readStoredMirrorSettings(storage).refreshRate).toBe(REFRESH_RATE_MIN);
    persistMirrorSetting("refreshRate", REFRESH_RATE_MAX, storage);
    expect(readStoredMirrorSettings(storage).refreshRate).toBe(REFRESH_RATE_MAX);
    expect(readStoredMirrorSettings(fakeStorage({ refreshRate: 0 })).refreshRate).toBeUndefined();
    expect(readStoredMirrorSettings(fakeStorage({ refreshRate: 120 })).refreshRate).toBeUndefined();
  });

  it("survives junk, a non-object blob and a storage that throws", () => {
    const junk: MirrorSettingsStorage = { getItem: () => "not json at all", setItem: () => {} };
    expect(readStoredMirrorSettings(junk)).toEqual({});
    const array: MirrorSettingsStorage = { getItem: () => "[1,2,3]", setItem: () => {} };
    expect(readStoredMirrorSettings(array)).toEqual({});
    const hostile: MirrorSettingsStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      }
    };
    expect(readStoredMirrorSettings(hostile)).toEqual({});
    expect(() => persistMirrorSetting("tweenReplay", false, hostile)).not.toThrow();
    // A build with no storage at all is simply RAM-only, as this store used to be.
    expect(readStoredMirrorSettings(null)).toEqual({});
    expect(() => persistMirrorSetting("tweenReplay", false, null)).not.toThrow();
  });

  it("hasStoredMirrorSetting answers per field (MirrorApp's refresh-rate seed rule depends on it)", () => {
    const storage = fakeStorage();
    expect(hasStoredMirrorSetting("refreshRate", storage)).toBe(false);
    persistMirrorSetting("refreshRate", 30, storage);
    expect(hasStoredMirrorSetting("refreshRate", storage)).toBe(true);
    expect(hasStoredMirrorSetting("tweenReplay", storage)).toBe(false);
    expect(hasStoredMirrorSetting("refreshRate", null)).toBe(false);
  });

  it("clearStoredMirrorSettings forgets everything", () => {
    const storage = fakeStorage({ shaderMode: "dynamic", refreshRate: 40 });
    clearStoredMirrorSettings(storage);
    expect(readStoredMirrorSettings(storage)).toEqual({});
  });

  it("uses a VERSIONED storage key so a future schema change can reset cleanly", () => {
    expect(MIRROR_SETTINGS_STORAGE_KEY).toBe("couchcoop.mirrorSettings.v1");
    expect(MIRROR_SETTINGS_STORAGE_KEY).toMatch(/\.v\d+$/);
  });
});

describe("serverSettingsPayload", () => {
  it("extracts ONLY the server-side fields (no client render modes / UI state)", () => {
    const s = build(quality({ shadersEnabled: false }));
    s.refreshRate = 30;
    s.freezeParticles = false;
    s.panelOpen = true;

    const payload = serverSettingsPayload(s);
    expect(payload).toEqual({
      refreshRate: 30,
      freezeParticles: false,
      freezeSpines: true,
      freezeDecor: true,
      tweenReplay: true,
      staticBg: true,
      trailDrive: true
    });
    // Lockstep with the watch list: every payload key is fed by SERVER_SETTING_KEYS entries. Exactly TWO documented
    // exceptions to name identity — the staticBg* pair folds into the ONE wire field `staticBg` (staticBgWireValue),
    // so both a panel toggle and a fail-open transition wake the watch; and `trailDriveCapable` is sent under the
    // host's name for it, `trailDrive`.
    const expectedPayloadKeys = SERVER_SETTING_KEYS.map((key) => {
      if (key === "staticBgEnabled" || key === "staticBgFailed") return "staticBg";
      if (key === "trailDriveCapable") return "trailDrive";
      return key;
    });
    expect(Object.keys(payload).sort()).toEqual([...new Set(expectedPayloadKeys)].sort());
    expect(payload).not.toHaveProperty("shaderMode");
    expect(payload).not.toHaveProperty("particleMode");
    expect(payload).not.toHaveProperty("effectModePinned");
    expect(payload).not.toHaveProperty("panelOpen");
    // R9 items 10/11: the manual spine override + the latency-overlay toggle are CLIENT-only — they must never
    // reach the game's `settings` channel (nor trip the SERVER_SETTING_KEYS watch that sends it).
    expect(payload).not.toHaveProperty("spineMode");
    expect(payload).not.toHaveProperty("latencyOverlay");
    expect(SERVER_SETTING_KEYS as readonly string[]).not.toContain("spineMode");
    expect(SERVER_SETTING_KEYS as readonly string[]).not.toContain("latencyOverlay");
  });

  // Stage-B walk skip: the `staticBg` wire field is the viewer's setting FOLDED with the fail-open latch — a
  // client that cannot actually show the image must not claim it does, or the host keeps skipping a subtree this
  // viewer is not covering.
  it("carries staticBg = setting && !failed (the fail-open fold)", () => {
    const s = build();
    expect(staticBgWireValue(s)).toBe(true);
    expect(serverSettingsPayload(s).staticBg).toBe(true);

    s.staticBgFailed = true; // StaticBackground.vue's fetch/decode fail-open latch
    expect(staticBgWireValue(s)).toBe(false);
    expect(serverSettingsPayload(s).staticBg).toBe(false);

    s.staticBgFailed = false; // a later room's image decoded — re-arms the skip
    expect(serverSettingsPayload(s).staticBg).toBe(true);

    s.staticBgEnabled = false; // the panel toggle wins regardless of the latch
    expect(staticBgWireValue(s)).toBe(false);
    expect(serverSettingsPayload(s).staticBg).toBe(false);
  });

  it("both staticBg store keys ride the watch list (panel toggle AND fail-open each trigger a push)", () => {
    expect(SERVER_SETTING_KEYS as readonly string[]).toContain("staticBgEnabled");
    expect(SERVER_SETTING_KEYS as readonly string[]).toContain("staticBgFailed");
    // The latch is per-session state, never a saved preference.
    expect(NEVER_PERSISTED_SETTING_KEYS as readonly string[]).toContain("staticBgFailed");
    expect(PERSISTED_SETTING_KEYS as readonly string[]).not.toContain("staticBgFailed");
    // A fresh store always starts un-failed (a reload retries the image from scratch).
    expect(build().staticBgFailed).toBe(false);
  });

  // The capability rides the same `settings` channel under the host's name and is NEVER saved: it describes the
  // build that is running, not a choice the viewer made.
  it("carries trailDrive from trailDriveCapable, on the watch list and off the saved set", () => {
    const s = build();
    expect(serverSettingsPayload(s).trailDrive).toBe(true);

    expect(SERVER_SETTING_KEYS as readonly string[]).toContain("trailDriveCapable");
    expect(NEVER_PERSISTED_SETTING_KEYS as readonly string[]).toContain("trailDriveCapable");
    expect(PERSISTED_SETTING_KEYS as readonly string[]).not.toContain("trailDriveCapable");

    // A stale stored value cannot hold the current build's capability off.
    const storage = fakeStorage({ trailDriveCapable: false });
    expect(build(quality(), "", storage).trailDriveCapable).toBe(true);
    // (Cast because the stored type does not even admit the key — the runtime prune is asserted here so a future
    // widening of PERSISTED_SETTING_KEYS cannot quietly start honouring it.)
    expect((readStoredMirrorSettings(storage) as Record<string, unknown>).trailDriveCapable).toBeUndefined();
  });
});
