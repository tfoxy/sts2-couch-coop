// THE READABILITY-SCALING MASTER SWITCH — one boolean, in a leaf module everything can import.
//
// The mirror draws several things BIGGER than the game does so they read and tap on a phone, in four separate
// places that share nothing but this intent:
//
//   * `viewScale.ts`        — the enlarged widgets (rewards panel, card rewards, shop carpet, event options,
//                             map points / legend / drawing tools, combat piles, treasure relic, "View upgrades");
//   * `hoverTipScaleMath.ts`— the 1.2x HoverTip enlargement;
//   * `textScaleClasses.ts` — the per-label font-size / block-scale table;
//   * `clipAxis.ts`         — the one-axis clip outset, which exists ONLY so a clipper does not crop the three
//                             above; with them off, the mirror should clip exactly where the game does.
//
// `mirrorSettings.uiScaling` (the panel checkbox, `?uiScale=off`) turns all four off at once, so a viewer can
// compare the mirror against the real screen — or escape an enlargement that misplaces something.
//
// WHY ITS OWN MODULE. Each family keeps its own `?flag=off` bisect lever next to the code it gates, and each ANDs
// with this. The switch itself cannot live with any one of them: `nodeStyles` and `textScaleClasses` are imported
// BY `mirrorRenderer`, and `buildDrawList` reads it from the canvas side, so any other home is an import cycle.
// A leaf module with no imports of its own can be read from all of them.
//
// DEFAULT ON, and deliberately not seeded from the URL here: `mirrorSettings` owns the layering (query > saved >
// default) and pushes the answer in through `MirrorRenderer.setUiScaling`, so there is exactly one place that
// decides what a viewer gets and one value flowing outward. A renderer nobody has told behaves exactly as the
// mirror did before this existed.

let masterOn = true;

/** Is readability scaling in force at all? (each family also has its own query lever, which ANDs with this) */
export function uiScalingEnabled(): boolean {
  return masterOn;
}

/**
 * Set the viewer's master switch. Callers are `MirrorRenderer.setUiScaling` (both backends) and tests.
 *
 * Changing this does NOT repaint anything by itself: the canvas stage re-reads it on its next build, and the DOM
 * stage has to repair the transforms its scale passes wrote outside the style cache. Both are the renderer
 * method's job — see it, and MirrorView's forced structural walk.
 */
export function setUiScalingEnabled(on: boolean): void {
  masterOn = on;
}
