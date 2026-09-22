import { describe, expect, it } from "vitest";

import type { GpuInfo } from "@godot-scene-web/html";

import { resolveRenderQuality, RENDER_QUALITY_TIERS, type RenderQuality } from "@/render/quality";
import {
  createMirrorSettings,
  DEFAULT_PARTICLE_MODE,
  DEFAULT_QUALITY_CHOICE,
  DEFAULT_SHADER_MODE,
  MIRROR_SETTINGS_STORAGE_KEY,
  readStoredMirrorSettings,
  type MirrorSettings,
  type MirrorSettingsStorage
} from "@/mirror/mirrorSettings";
import {
  applyQualityChoice,
  QUALITY_PRESET_KEYS,
  QUALITY_PRESETS
} from "@/mirror/qualityPreset";

// What a QUALITY rung does to the store: the three rows it implies, written AND saved, one field at a time.
//
// The device half of the same setting (the rung becoming this device's tier, and detection standing down) is
// quality.ts' business and is asserted in quality.spec.ts. What is pinned here is the PANEL half: the row values
// per rung, that `auto` touches no rows at all, and that nothing outside the preset's three fields is written.

const UNKNOWN_GPU: GpuInfo = { renderer: "", software: false, unavailable: false };

function fakeStorage(): MirrorSettingsStorage & { raw(): string | null } {
  let value: string | null = null;
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

function store(storage: MirrorSettingsStorage | null): MirrorSettings {
  const quality: RenderQuality = resolveRenderQuality({ search: "", gpu: UNKNOWN_GPU });
  return createMirrorSettings(quality, "", { storage });
}

describe("QUALITY_PRESETS — the table", () => {
  it("covers every rung of the ladder, and only rungs", () => {
    expect(Object.keys(QUALITY_PRESETS).sort()).toEqual([...RENDER_QUALITY_TIERS].sort());
  });

  it("gives each rung a DISTINCT row triple — a ladder with two identical steps is a lie to the player", () => {
    const seen = new Set(
      RENDER_QUALITY_TIERS.map((tier) => JSON.stringify(QUALITY_PRESETS[tier]))
    );
    expect(seen.size).toBe(RENDER_QUALITY_TIERS.length);
  });

  it("descends monotonically: the effect modes get cheaper and only High keeps live scenery", () => {
    // The two effect families always move together (one lever, one resolution axis), and the static-background
    // saving is on at every rung below High — see qualityPreset's header for why that one goes the other way.
    expect(RENDER_QUALITY_TIERS.map((tier) => QUALITY_PRESETS[tier].shaderMode)).toEqual([
      "dynamic",
      "dynamic-half",
      "dynamic-quarter",
      "static",
      "off"
    ]);
    for (const tier of RENDER_QUALITY_TIERS) {
      expect(QUALITY_PRESETS[tier].particleMode, tier).toBe(QUALITY_PRESETS[tier].shaderMode);
      expect(QUALITY_PRESETS[tier].staticBgEnabled, tier).toBe(tier !== "high");
    }
  });

  it("names the fields it writes as data", () => {
    for (const tier of RENDER_QUALITY_TIERS) {
      expect(Object.keys(QUALITY_PRESETS[tier]).sort()).toEqual([...QUALITY_PRESET_KEYS].sort());
    }
  });
});

describe("applyQualityChoice", () => {
  it("writes the rung's rows into the store", () => {
    const storage = fakeStorage();
    const settings = store(storage);
    applyQualityChoice(settings, "high", storage);
    expect(settings.quality).toBe("high");
    expect(settings.shaderMode).toBe("dynamic");
    expect(settings.particleMode).toBe("dynamic");
    expect(settings.staticBgEnabled).toBe(false);

    applyQualityChoice(settings, "minimum", storage);
    expect(settings.shaderMode).toBe("off");
    expect(settings.particleMode).toBe("off");
    expect(settings.staticBgEnabled).toBe(true);
  });

  it("SAVES the choice and each row it wrote, and nothing else", () => {
    const storage = fakeStorage();
    const settings = store(storage);
    applyQualityChoice(settings, "medium", storage);
    expect(readStoredMirrorSettings(storage)).toEqual({
      quality: "medium",
      shaderMode: "dynamic-half",
      particleMode: "dynamic-half",
      staticBgEnabled: true
    });
  });

  it("leaves every row alone for `auto`, saving only the choice", () => {
    // Detection is a guess about hardware; it must not reach in and change what a viewer is looking at. The
    // product defaults are device-independent precisely so that it can't.
    const storage = fakeStorage();
    const settings = store(storage);
    applyQualityChoice(settings, "auto", storage);
    expect(settings.quality).toBe("auto");
    expect(settings.shaderMode).toBe(DEFAULT_SHADER_MODE);
    expect(settings.particleMode).toBe(DEFAULT_PARTICLE_MODE);
    expect(settings.staticBgEnabled).toBe(true);
    expect(readStoredMirrorSettings(storage)).toEqual({ quality: "auto" });
  });

  it("returning to `auto` does NOT undo the rows a rung wrote — they are the viewer's now", () => {
    const storage = fakeStorage();
    const settings = store(storage);
    applyQualityChoice(settings, "high", storage);
    applyQualityChoice(settings, "auto", storage);
    expect(settings.shaderMode).toBe("dynamic");
    expect(settings.staticBgEnabled).toBe(false);
    expect(readStoredMirrorSettings(storage).quality).toBe("auto");
  });

  it("a row changed afterwards stands, and the picked quality stays put", () => {
    // "Changing quality overrides the others until they are changed": the rung is a starting point, and it is
    // also this device's TIER — so it does not silently become something else when one row moves off it.
    const storage = fakeStorage();
    const settings = store(storage);
    applyQualityChoice(settings, "very-low", storage);
    settings.particleMode = "dynamic";
    expect(settings.quality).toBe("very-low");
    expect(settings.shaderMode).toBe("static");
  });

  it("degrades to RAM-only where storage is refused (private mode)", () => {
    const settings = store(null);
    applyQualityChoice(settings, "low", null);
    expect(settings.quality).toBe("low");
    expect(settings.shaderMode).toBe("dynamic-quarter");
    expect(readStoredMirrorSettings(null)).toEqual({});
  });

  it("starts from `auto`, so an untouched device is the one auto-detection decides", () => {
    expect(store(fakeStorage()).quality).toBe(DEFAULT_QUALITY_CHOICE);
    expect(DEFAULT_QUALITY_CHOICE).toBe("auto");
  });
});
