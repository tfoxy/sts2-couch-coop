// What a QUALITY rung means for the rows below it in the settings panel.
//
// The quality row is one lever over three that already existed (Shaders, Particles, Static background), plus the
// device levers no row expresses (which ride the tier itself — see mirrorSettings' QualityChoice). Picking a rung
// writes this table into the store and saves each field, exactly as if the viewer had set the three rows by hand;
// they stay individually editable afterwards, so a rung is a starting point and not a lock. That is the whole
// contract: "changing quality overrides the others until they are changed".
//
// WHY THESE THREE ROWS AND NOT MORE. They are the rows that trade fidelity for GPU cost on THIS device, which is
// what a quality ladder is. The others are deliberately out:
//   * widescreen stretch, the input rows (tap-to-focus, confirm tap, raise), Enlarge small UI — preferences about
//     layout and interaction, not cost. A quality pick that silently changed how a tap behaves would be a trap.
//   * Occlude under overlay backstops — a saving with no fidelity price (the scrim looks identical), so it should
//     be on at every rung rather than traded away at the top.
//   * refresh rate / tween replay — the SERVER stream group, about what the game sends this viewer rather than
//     what this device draws.
//
// THE ONE ROW THAT GOES THE OTHER WAY is Static background: every rung below High turns it ON (a host-rendered
// still instead of live scenery — the single largest GPU saving the mirror has), while High turns it OFF, because
// High means "draw the real thing".

import {
  persistMirrorSetting,
  type EffectMode,
  type MirrorSettings,
  type MirrorSettingsStorage,
  type QualityChoice
} from "@/mirror/mirrorSettings";
import type { RenderQualityTier } from "@/render/quality";

/** The rows one rung implies. Exactly the fields `applyQualityChoice` writes. */
export interface QualityPresetRows {
  shaderMode: EffectMode;
  particleMode: EffectMode;
  staticBgEnabled: boolean;
}

// Each rung's rows. The effect modes mirror the tier's own character: the live rungs pick the resolution axis
// (full / ½ / ¼ — the same values on every device, which is what makes a mode mean one thing), `very-low` freezes
// both families to a single real frame, and `minimum` turns the WebGL families off entirely (which is also the
// hard-off lane the tier clamps to on a software-WebGL phone, so the rung and the floor agree).
export const QUALITY_PRESETS: Record<RenderQualityTier, QualityPresetRows> = {
  high: { shaderMode: "dynamic", particleMode: "dynamic", staticBgEnabled: false },
  medium: { shaderMode: "dynamic-half", particleMode: "dynamic-half", staticBgEnabled: true },
  low: { shaderMode: "dynamic-quarter", particleMode: "dynamic-quarter", staticBgEnabled: true },
  "very-low": { shaderMode: "static", particleMode: "static", staticBgEnabled: true },
  minimum: { shaderMode: "off", particleMode: "off", staticBgEnabled: true }
};

/** The fields a preset writes, as data — so a test (and a reader) can see the set without inferring it. */
export const QUALITY_PRESET_KEYS = ["shaderMode", "particleMode", "staticBgEnabled"] as const;

export type QualityPresetKey = (typeof QUALITY_PRESET_KEYS)[number];

/**
 * Apply a quality choice the viewer just made in the panel: save it, and — for a rung — write and save the three
 * rows it implies.
 *
 * `auto` writes only the choice itself. It hands the DEVICE levers back to auto-detection (on the next load,
 * where the tier is resolved) and deliberately leaves the rows alone: detection is a guess about hardware, and a
 * guess must not reach in and change what a viewer is looking at. The product defaults are the same on every
 * device precisely so that it can't.
 *
 * Each field is persisted through `persistMirrorSetting`, one key at a time — the same per-field write the panel's
 * own bindings use, so nothing else in the saved blob can ride along behind this change.
 */
export function applyQualityChoice(
  settings: MirrorSettings,
  choice: QualityChoice,
  storage?: MirrorSettingsStorage | null
): void {
  // `persistMirrorSetting`'s storage argument defaults to localStorage, so `undefined` must keep meaning that
  // while an explicit `null` (a test's "no storage at all") is passed through.
  const persist = <K extends "quality" | QualityPresetKey>(key: K, value: MirrorSettings[K]): void => {
    if (storage === undefined) {
      persistMirrorSetting(key, value);
    } else {
      persistMirrorSetting(key, value, storage);
    }
  };
  settings.quality = choice;
  persist("quality", choice);
  if (choice === "auto") {
    return;
  }
  const rows = QUALITY_PRESETS[choice];
  settings.shaderMode = rows.shaderMode;
  persist("shaderMode", rows.shaderMode);
  settings.particleMode = rows.particleMode;
  persist("particleMode", rows.particleMode);
  settings.staticBgEnabled = rows.staticBgEnabled;
  persist("staticBgEnabled", rows.staticBgEnabled);
}
