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
  /** GSW Rust renderer redraws only the damaged picture region and skips no-change presents. */
  damagePresent: boolean;
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
  damagePresent: "rustDamagePresent",
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
