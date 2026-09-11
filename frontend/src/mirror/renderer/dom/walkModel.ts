import type { MirrorColor } from "@/mirror/sceneTree";
import type { RgbTint } from "./svgDefsRegistry";
export { intentFrameIndex } from "@/mirror/renderer/intentPolicy";

// The three reconcile walk shapes (see doWalk): `full` = today's structural path (un-pruned visit of everything +
// authoritative reorder of every parent — firstBuild / forceTextures / a bail); `incremental` = orderedIds changed
// but the delta is small, so keep dirty pruning + targeted reorder of only the parents whose child lists moved;
// `update` = volatile-only (orderedIds ref unchanged).
type WalkMode = "full" | "incremental" | "update";

// Bail-to-full thresholds for the incremental structural path (tunable). Rationale: the incremental walk's win is
// keeping the skip-clean pruning when a structural delta touches a handful of parents (damage numbers, a card
// draw); when a delta rewrites a large fraction of the scene (a screen swap that isn't a keyframe), the pruned walk
// visits most nodes anyway, so the diff + targeted-reorder overhead only adds failure surface — fall back to the
// battle-tested full path instead. The RATIOS govern big (production, ~19k node) scenes; the absolute MIN floors
// keep small scenes (menus, tests) on the incremental path where any single change would exceed the ratio — a
// full walk is cheap there either way, so staying incremental costs nothing and keeps one code path exercised.
// A wire KEYFRAME (state.sceneRewrite) always bails regardless of size: nothing would be pruned, and a keyframe
// may also replace scene-wide state that the full path re-establishes wholesale.
//
// The churn is measured from the INDEX DIFF, never from `state.changedIds` — that set counts volatile-only
// upserts (a card play is >200 changed ids on a ~679-node combat scene while adding/removing a handful of nodes),
// which is precisely the shape the pruning path is best at.
const BAIL_ORDER_CHURN_RATIO = 0.15;
const BAIL_MIN_ORDER_CHURN = 8;

// --- WS-C occlusion gating: tuning ---------------------------------------------------------------------------
//
// DETECTION IS DATA-DRIVEN (no scene-file allowlist). A "cover" is any node the walk sees that
//   (a) paints a FLAT FILL COLOUR of its own (`fillColor`, i.e. a Godot ColorRect/Panel-ish backdrop) and carries NO
//       shader — a shader repaints the node's pixels from a GPU program the client can't reason about (STS2's
//       `GameTransitionRect` is exactly this trap: a full-stage `#000000ff` ColorRect whose `fade_transition`
//       shader renders it fully TRANSPARENT at threshold 0, so a fill-only test would black out every screen);
//       a TEXTURE-painted backdrop is likewise never a cover — the client cannot prove a PNG has no alpha;
//   (b) spans the whole design-space stage rect once its own global transform + the wide-screen re-layout
//       (spreadDx / the anchored width stretch) are applied, axis-aligned and un-mirrored;
//   (c) has a composed alpha (every ancestor's modulate.a × its own modulate.a × self_modulate.a × fill alpha) of at
//       least COVER_MIN_ALPHA, with every ancestor visible.
// Everything strictly BELOW it in paint order is then gated. Two tiers, by how opaque the cover actually is:
//   • TIER 1 (hide) — composed alpha ≥ COVER_OPAQUE_ALPHA (a genuinely opaque cover: the content below contributes
//     ZERO pixels) AND the cover is a `mouse_filter = Stop` Control. The Stop requirement is not cosmetic: Godot
//     routes input to the topmost Stop Control under the cursor and stops there, so nothing below such a cover is
//     reachable IN THE GAME either — which is what makes it safe to drop the covered subtrees out of the browser's
//     hit-test z-stack along with their paint. Below-covers that are `Ignore`/`Pass` (STS2's treasure-room
//     background) stay at tier 2 even when fully opaque.
//   • TIER 2 (suspend) — anything else that qualifies: a translucent SCRIM (STS2's dialog backstops are
//     `#000000d9` = 0.851, the card-detail backstop 0.902). The content below still shows through, so it must keep
//     PAINTING; only its time-driven work stops. Visually undetectable on a still screen.
// If a candidate's opacity can't be proven (a texture, a shader, a rotated box, a partially-off-stage box) it is
// simply not a cover — the conservative direction is always "gate nothing".
const COVER_OPAQUE_ALPHA = 0.996; // ≥ this composed alpha ⇒ the cover is opaque (tier 1 eligible)
const COVER_MIN_ALPHA = 0.75; // below this a "cover" is just a flash/vignette — never gate behind it
const COVER_EDGE_EPS = 1; // design-px slack when testing full-stage coverage (rounded producer boxes)
// R10-PERF6 WS-B — THE BACKSTOP EXCEPTION (`?backstopOcclude=off` / the "Overlay backstops" panel toggle).
//
// The generic 0.75 floor was set from the SHAPE of STS2's scrims (`#000000d9` = 0.851 fill). Live, three of them
// also carry a `d9` MODULATE while their screen is open, so the composed alpha is 0.851 × 0.851 = 0.724 — just
// under the floor, and the gate never engaged where it matters most (opening the map over a live combat measured
// +10 busy points, Layerize 3 → 9 ms/commit). Lowering the GENERIC floor to 0.70 would newly gate behind things
// that are not screens at all (the hand's `#000000bf` = 0.749 SelectModeBackstop is one), so the exception is
// keyed by NAME instead: exactly the three nodes the game itself calls a backstop of a full-screen overlay, each
// matched on its own name AND its parent's, so `ModalContainer/Backstop`, `PauseMenu/Backstop`,
// `Hand/SelectModeBackstop`, `TreasureRoom/FightBackstop` and `InspectCardScreen/Backstop` are all excluded.
// Everything else about the cover test is unchanged (full-stage box, flat fill, no shader, no in-flight fade, the
// 3-walk hysteresis), and the tier decision is untouched — a `d9`-modulated backstop is translucent, so it can
// only ever reach TIER 2 (suspend, keep painting).
const BACKSTOP_COVER_MIN_ALPHA = 0.7;
// parent name → the backstop's own name. Both must match (a path SUFFIX of `…/<parent>/<name>`).
const BACKSTOP_COVER_PATHS = new Map<string, string>([
  ["MapScreen", "Backstop"],
  ["CapstoneScreenContainer", "CapstoneBackstop"],
  ["OverlayScreensContainer", "OverlayBackstop"]
]);

/**
 * The canonical `<parent>/<name>` path suffix of one of the game's own full-screen overlay backstops, or null when
 * this (name, parent name) pair is not one of them. Pure + exported so the table is unit-testable on its own.
 */
export function backstopCoverPath(
  name: string | null | undefined,
  parentName: string | null | undefined
): string | null {
  if (!name || !parentName) {
    return null;
  }
  return BACKSTOP_COVER_PATHS.get(parentName) === name ? `${parentName}/${name}` : null;
}

// R10-PERF6 WS-B, piece 2 — CANVAS DE-PROMOTION UNDER A TIER-2 COVER.
//
// Tier 2 keeps the covered content PAINTED (the scrim shows it through) and only stops its time-driven work. The
// occlusion-regime experiment measured what that leaves on the table: suspending the animators recovers ~0% of
// tier 1's compositing win, because the LAYER TREE is byte-identical to ungated. The whole win is the canvases —
// every `<canvas>` is an unconditionally promoted layer, and hiding just the 29 under a covered combat room
// recovered 99% of tier 1's DoUpdateLayers/commit win (8.40 → 4.25 ms) and 62 of its 79 layers.
//
// So once tier 2 engages, each canvas under it (which the suspend has just made STATIC) is snapshotted into an
// `<img>` of the same pixels, placed in the same slot with the same class + inline styles, and the canvas is
// `display:none`d. The compositor loses the layer; the viewer loses nothing. Everything is restored — element,
// styles, live canvas — the moment the cover lifts, the canvas is repainted, the record is torn down, or either
// switch flips. A canvas whose snapshot can't be produced (no `toBlob`, a WebGL context without
// `preserveDrawingBuffer`, a tainted or zero-sized surface) simply stays live: correctness over the win.
//
// The intent-glyph STRIP canvas is deliberately NOT a target: its paint is a `steps()` translate animation whose
// phase is anchored to the document timeline, so a still copy would have to reproduce that phase to be faithful —
// and a paused compositor animation keeps its layer anyway, so there is nothing to win.
const FREEZE_CANVAS_SELECTOR = "canvas.mirror-atlas-canvas, canvas.mirror-spine-canvas";
const FREEZE_IDLE_MS = 120; // let the reveal frame land before spending anything on snapshots
const FREEZE_SLICE = 4; // canvases snapshotted per drain slice
// A canvas that has been REPAINTED while frozen this many times stops being a target (a repaint under a cover is
// already unexpected — the animators are parked — so this only exists so a pathological one can't thrash).
const FREEZE_MAX_REFREEZES = 3;

// The snapshot step, isolated so vitest can stand in for it: jsdom has no canvas encoder and no blob decode, so a
// REAL snapshot can never complete there (exactly why atlasBaker has `__publishRegionBlobForTest`). Production
// encodes the canvas to a PNG blob and then WAITS for that blob to decode, so the `<img>` paints the instant it
// is swapped in — a snapshot that is merely "requested" would flash an empty box for a frame.
export type CanvasSnapshotSource = (canvas: HTMLCanvasElement, ready: (url: string | null) => void) => void;

function encodeCanvasSnapshot(canvas: HTMLCanvasElement, ready: (url: string | null) => void): void {
  if (
    typeof canvas.toBlob !== "function" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function" ||
    typeof Image === "undefined"
  ) {
    ready(null);
    return;
  }
  try {
    canvas.toBlob((blob) => {
      if (!blob) {
        ready(null); // a WebGL surface without preserveDrawingBuffer answers null/blank — leave it live
        return;
      }
      const url = URL.createObjectURL(blob);
      const settle = (ok: boolean): void => {
        if (ok) {
          ready(url);
        } else {
          URL.revokeObjectURL(url);
          ready(null);
        }
      };
      const probe = new Image();
      probe.src = url;
      if (typeof probe.decode === "function") {
        probe.decode().then(
          () => settle(true),
          () => settle(false)
        );
      } else if (probe.complete) {
        settle(true);
      } else {
        probe.onload = () => settle(true);
        probe.onerror = () => settle(false);
      }
    }, "image/png");
  } catch {
    ready(null); // a tainted canvas throws SecurityError
  }
}

let canvasSnapshotSource: CanvasSnapshotSource = encodeCanvasSnapshot;
/** TEST-ONLY: stand in for the (async, browser-only) canvas encode + decode. Pass null to restore production. */
export function __setCanvasSnapshotSourceForTest(source: CanvasSnapshotSource | null): void {
  canvasSnapshotSource = source ?? encodeCanvasSnapshot;
}
// HYSTERESIS. A dialog OPENS by fading its scrim in (and STS2 also replays that fade client-side as a declarative
// tween), so a cover's composed alpha crosses the threshold mid-transition and can wobble across it. Engaging on
// the first qualifying walk would flicker the gate (and, at tier 1, the picture) during every open. So a gated root
// must be wanted for OCCLUSION_ENGAGE_WALKS CONSECUTIVE walks before the gate engages, and a cover whose own
// opacity tween is still in flight never qualifies at all (its "open" hasn't settled). DISENGAGE is immediate and
// unconditional — a reveal must never lag the frame that uncovered the content. The counter is kept PER GATED ROOT,
// so a second cover opening over the first (deck dialog → card detail) only delays the roots it newly covers; the
// already-engaged ones are untouched.
const OCCLUSION_ENGAGE_WALKS = 3;
// Bounds for the per-pass ancestor climbs / sibling scans (a malformed or pathologically deep tree can never turn
// the pass into a hotspot; exceeding a budget just means "gate less").
const OCCLUSION_CHAIN_BUDGET = 64;
const OCCLUSION_SIBLING_BUDGET = 4096;
// Gate tiers, ranked so a numerically SMALLER value is the STRONGER gate (tier 1 ⊃ tier 2 in effect).
const OCC_HIDE = 1; // display:none + suspend  (doc tier 1)
const OCC_SUSPEND = 2; // suspend only          (doc tier 2)
type OcclusionTier = typeof OCC_HIDE | typeof OCC_SUSPEND;

// The targeting-arrow and card-tooltip identities moved to `@/mirror/raise/constants` with the rest of the policy
// the canvas backend shares; re-exported for this module's other consumers.
export { TARGETING_TYPES } from "@/mirror/raise/constants";

type Rgb = RgbTint;

const IDENTITY_RGB: Rgb = { r: 1, g: 1, b: 1 };

function rgbOf(color: MirrorColor | null): Rgb {
  return color ? { r: color.r, g: color.g, b: color.b } : IDENTITY_RGB;
}

function mul(a: Rgb, b: Rgb): Rgb {
  // Multiplying by the shared identity is a no-op → return the other operand's object (never mutated), so an
  // untinted node (the common case: rgbOf(null) === IDENTITY_RGB) allocates nothing per walk.
  if (a === IDENTITY_RGB) return b;
  if (b === IDENTITY_RGB) return a;
  return { r: a.r * b.r, g: a.g * b.g, b: a.b * b.b };
}

function isIdentity(c: Rgb): boolean {
  return Math.abs(c.r - 1) < 0.004 && Math.abs(c.g - 1) < 0.004 && Math.abs(c.b - 1) < 0.004;
}


export { mul, rgbOf, COVER_EDGE_EPS, isIdentity, BAIL_MIN_ORDER_CHURN, BAIL_ORDER_CHURN_RATIO, IDENTITY_RGB, BACKSTOP_COVER_MIN_ALPHA, COVER_OPAQUE_ALPHA, OCC_HIDE, OCC_SUSPEND, OCCLUSION_ENGAGE_WALKS, FREEZE_CANVAS_SELECTOR, FREEZE_IDLE_MS, FREEZE_SLICE, canvasSnapshotSource, FREEZE_MAX_REFREEZES, COVER_MIN_ALPHA, OCCLUSION_CHAIN_BUDGET, OCCLUSION_SIBLING_BUDGET };

export type { Rgb, OcclusionTier };
export type { WalkMode };
