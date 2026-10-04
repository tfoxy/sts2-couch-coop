/**
 * Producer CPU controls for the Rust stage, all on by default. `rustFast=0` turns the umbrella off; an
 * explicit `<switch>=0` turns one item off and `<switch>=1` turns it on without the umbrella. Each item is
 * designed to leave the submitted scene unchanged; `rustFastVerify=1` shadow-checks that at a CPU cost,
 * so it is never part of the umbrella.
 *
 * The Pixi backend ignores every Rust item. `ccPaintOrderReuse` predates this bundle and keeps applying
 * to both backends on its own.
 */
export interface RustFastFlags {
  omitStaticPixelCaches: boolean;
  lazyComposition: boolean;
  hiddenMemo: boolean;
  paintOrderReuse: boolean;
  fastSerializer: boolean;
  textPrepCache: boolean;
  fontCheckCache: boolean;
  snapshotReuse: boolean;
  drawStateDedupe: boolean;
  hiddenMemoCaptures: boolean;
  hiddenMemoSpread: boolean;
  heldOverridePatch: boolean;
  sceneIndex: boolean;
  raiseIndexCache: boolean;
  coalescedBuilds: boolean;
  offsetPatch: boolean;
  wireSpreadPatch: boolean;
  tweenRootPatch: boolean;
  textPatch: boolean;
  textEvict: boolean;
  idleScheduler: boolean;
  /** Passive idle demand books a display rAF only for the frame it is due in (the park timer reaches it). */
  idleDueFrame: boolean;
  /** GSW Rust renderer redraws only the damaged picture region and skips no-change presents. */
  damagePresent: boolean;
  /** Pure idle-loop frames are one `present_idle(t)` in the GSW Rust renderer instead of a patch (`rustIdleLane.ts`). */
  idleInRust: boolean;
  /**
   * A wire delta whose every changed node lies in a subtree the committed build drew nothing for (empty paint-order
   * span, no hit entries, no captured global depending on it) is applied to the committed state and acknowledged
   * without sampling a visual, a retained patch, a frame or a present (`planUndrawnWireSkip`; `reconcile` answers
   * "applied"). The scheduler's own ticks keep drawing animation at their own times.
   */
  skipUndrawnWire: boolean;
  verify: boolean;
}

export const RUST_FAST_SWITCHES = {
  omitStaticPixelCaches: "rustOmitStaticPixelCaches",
  lazyComposition: "rustLazyComposition",
  hiddenMemo: "rustHiddenMemo",
  paintOrderReuse: "ccPaintOrderReuse",
  fastSerializer: "rustFastSerializer",
  textPrepCache: "rustTextPrepCache",
  fontCheckCache: "rustFontCheckCache",
  snapshotReuse: "rustSnapshotReuse",
  drawStateDedupe: "rustDrawStateDedupe",
  hiddenMemoCaptures: "rustHiddenMemoCaptures",
  hiddenMemoSpread: "rustHiddenMemoSpread",
  heldOverridePatch: "rustHeldOverridePatch",
  sceneIndex: "rustSceneIndex",
  raiseIndexCache: "rustRaiseIndexCache",
  coalescedBuilds: "rustCoalescedBuilds",
  offsetPatch: "rustOffsetPatch",
  wireSpreadPatch: "rustWireSpreadPatch",
  tweenRootPatch: "rustTweenRootPatch",
  textPatch: "rustTextPatch",
  textEvict: "rustTextEvict",
  idleScheduler: "rustIdleScheduler",
  idleDueFrame: "rustIdleDueFrame",
  damagePresent: "rustDamagePresent",
  idleInRust: "rustIdleInRust",
  skipUndrawnWire: "rustSkipUndrawnWire",
} as const satisfies Record<Exclude<keyof RustFastFlags, "verify">, string>;

export function resolveRustFastFlags(query: URLSearchParams, backend: "pixi" | "rust"): RustFastFlags {
  const rust = backend === "rust";
  const umbrella = rust && query.get("rustFast") !== "0";
  const item = (name: string, applies: boolean) => {
    if (!applies) return false;
    const value = query.get(name);
    return value === "1" || (umbrella && value !== "0");
  };
  const flags = { verify: rust && query.get("rustFastVerify") === "1" } as RustFastFlags;
  for (const [key, name] of Object.entries(RUST_FAST_SWITCHES) as Array<[keyof typeof RUST_FAST_SWITCHES, string]>)
    flags[key] = item(name, rust || key === "paintOrderReuse");
  return flags;
}

export function rustFastFlagsFromLocation(backend: "pixi" | "rust"): RustFastFlags {
  return resolveRustFastFlags(new URLSearchParams(window.location.search), backend);
}

/**
 * `rustPresent=<mode>`: which present path the GSW Rust engine uses. Absent or unrecognized resolves to
 * "preserved-desync" (a preserved, desynchronized WebGL2 canvas: the only mode with a noise-clearing phone
 * GPU-process saving, −17.6%; made the default by the maintainer after a live look, Oct 3 — Chrome scales a
 * desynchronized canvas with a different filter, so edges are not pixel-identical to the other modes).
 * `direct` (one full-surface pass, no wgpu Surface), `surface` (the wgpu Surface path) and `preserved` stay
 * selectable for comparison. Kept outside the `rustFast` umbrella so `rustFast=0` does not change the present
 * path. Only the Rust backend reads it.
 */
export type RustPresentMode = "surface" | "direct" | "preserved" | "preserved-desync";
const RUST_PRESENT_MODES = new Set<RustPresentMode>(["surface", "direct", "preserved", "preserved-desync"]);

export function resolveRustPresentMode(query: URLSearchParams, backend: "pixi" | "rust"): RustPresentMode {
  if (backend !== "rust") return "surface";
  const value = query.get("rustPresent");
  return RUST_PRESENT_MODES.has(value as RustPresentMode) ? value as RustPresentMode : "preserved-desync";
}

export function rustPresentModeFromLocation(backend: "pixi" | "rust"): RustPresentMode {
  return resolveRustPresentMode(new URLSearchParams(window.location.search), backend);
}
