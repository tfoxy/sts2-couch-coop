// The mirror settings' web-storage seam, and nothing else.
//
// A LEAF module on purpose — it imports nothing. Two modules need to read the saved blob and they sit on opposite
// sides of an import edge: `mirrorSettings.ts` (which owns the store and imports `render/quality.ts`) and
// `render/quality.ts` itself, which resolves this device's tier from the viewer's saved `quality` choice. Keeping
// the key, the seam and the raw read here means quality.ts never imports the store it seeds, so there is no cycle
// and no question about which module's module-scope work runs first.

// VERSIONED on purpose: a future schema change bumps the suffix, which resets every viewer to the new defaults
// instead of trying to migrate values whose meaning moved. Old keys are simply orphaned (a few bytes).
export const MIRROR_SETTINGS_STORAGE_KEY = "couchcoop.mirrorSettings.v1";

/** The web-storage seam (injectable so tests can fake it; `null` means "this build has no storage"). */
export interface MirrorSettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

// localStorage where it exists. Access itself can THROW (Safari private mode, a sandboxed frame), so it is
// wrapped — a browser without storage degrades to RAM-only behavior.
export function defaultSettingsStorage(): MirrorSettingsStorage | null {
  try {
    return (globalThis as { localStorage?: MirrorSettingsStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** The saved blob as a plain record, or null when there is nothing readable there. Never throws. */
export function readSettingsRecord(storage: MirrorSettingsStorage | null): Record<string, unknown> | null {
  if (!storage) {
    return null;
  }
  let text: string | null = null;
  try {
    text = storage.getItem(MIRROR_SETTINGS_STORAGE_KEY);
  } catch {
    return null; // storage exists but reading threw (private mode / disabled cookies)
  }
  if (!text) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null; // not JSON at all — ignore it; the next panel change overwrites it
  }
}
