// R20 — the ONE-AXIS CLIP table: scene identities whose `Control.clip_contents` must bound the VERTICAL axis only.
//
// Background. R19 WP-4 started honouring `Control.clip_contents` in the mirror, emitting `overflow: hidden` on the
// clipping Control's element. That is right for the axis the game actually uses it on, and wrong for the other axis
// as soon as THIS repo's readability transforms make a subtree wider than the container the game sized for it. The
// mirror enlarges several items for phone legibility (see viewScale.ts / textScaleClasses.ts); a clipper that is an
// ANCESTOR of an enlarged node then crops the enlargement, which the game never does.
//
// The live case (measured from `.sts2/bench/audit-mprun.ndjson`):
//   * `ancient_event_layout.tscn :: ContentContainer` is 1160x720 at design origin (380,320) → it bounds x 380…1540.
//   * Its `Content` / `Content/OptionsContainer` descendants are both 1000 wide at design x 460…1460, i.e. 80px
//     inside the container on each side at 1.0 — the game never crops them.
//   * viewScale.ts enlarges `ContentContainer/Content/OptionsContainer` by VIEW_SCALE_EVENT_OPTIONS (1.2) about its
//     bottom-CENTRE (pivot x 960), so the option rows span 360…1560 — 20px past the clipper on EACH side, and more
//     while an option is focused and grown further. That is the reported "options are cropped on the sides".
//   * The VERTICAL clip is WANTED and must not regress: it is what hides the options parked below the container
//     while the dialogue plays (the R19 WP-4 fix — see the ancient-event entries in viewScale.ts).
// Dropping the view scale is not a fix: 1160/1000 = 1.16 exactly touches the container walls, so any focus growth
// would still crop.
//
// WHY `clip-path`, not `overflow`. CSS cannot mix `hidden` on one axis with `visible` on the other: a box with
// `overflow-y: hidden; overflow-x: visible` computes the visible axis to `auto`, turning the element into a scroll
// container. `clip-path: inset(0 -Npx)` is the correct tool — it clips the vertical axis at the box edge and OUTSETS
// the horizontal one by N. (`clip-path` establishes a stacking context, which is a no-op here: every mirror node
// already carries a baked CSS transform and is therefore already a stacking context.)
//
// SCENE IDENTITY, not geometry: a 1160x720 clipping Control is indistinguishable from any other panel, and those
// must keep clipping both axes. The key is the (scene file, scene-relative node path) tuple mirrorRenderer's
// `computeSceneInfo` resolves and stamps as data-scene-file / data-scene-node-path — the same tuple viewScale.ts's
// ENTRIES and mirrorRenderer's isDrawingTools / isMenuReticle matchers key on.
//
// This module is PURE (no DOM, no query reads), like viewScale.ts. The consumer applies its result only while
// readability scaling is enabled; see nodeStyles.ts, which owns the `clip_contents` branch this feeds. There is no
// native C# twin:
// `MirrorProtocol.MirrorNode.ClipContents` rides the wire, but the native godot-client never applies it as a clip
// (its only use is `TextBuilder.ConfigureRich`, which switches Godot's RichTextLabel default OFF), so there is
// nothing on that side to keep in lockstep.

export interface ClipAxisEntry {
  /** Owning instanced scene, matched EXACTLY against `computeSceneInfo().file`. */
  file: string;
  /** Node path RELATIVE to that scene's root, matched EXACTLY against `computeSceneInfo().relPath`. */
  path: string;
  /**
   * How far past the box each HORIZONTAL edge may still paint, in design px. The vertical axis stays clipped at the
   * box edge.
   */
  outsetX: number;
}

// `ContentContainer` spans design x 380…1540, so an outset of 380 opens the horizontal clip window to exactly
// 0…1920 — the full design stage. That is 19x the measured 20px-per-side overflow, and it means the horizontal axis
// can no longer cut anything the game could put on screen: a focused option row would have to grow the already
// 1.2x-scaled 1200px block to 1920px (a further 1.6x) before it reached the window. The vertical clip is untouched,
// so the parked-options hide that R19 WP-4 landed still works.
export const CLIP_AXIS_ANCIENT_CONTENT_OUTSET = 380;

const ANCIENT_EVENT_LAYOUT = "res://scenes/events/ancient_event_layout.tscn";

export const CLIP_AXIS_ENTRIES: readonly ClipAxisEntry[] = [
  { file: ANCIENT_EVENT_LAYOUT, path: "ContentContainer", outsetX: CLIP_AXIS_ANCIENT_CONTENT_OUTSET }
];

/**
 * The NODE NAMES that could match an entry — a cheap pre-filter (one string-set probe per clipping node) so the
 * allocating `computeSceneInfo` walk only runs for the handful of nodes that could possibly match. Same role as
 * viewScale.ts's VIEW_SCALE_CANDIDATE_NAMES and the isDrawingTools / isMenuReticle name tests; derived from the
 * table so the two can never drift.
 */
export const CLIP_AXIS_CANDIDATE_NAMES: ReadonlySet<string> = new Set(
  CLIP_AXIS_ENTRIES.map((e) => e.path.slice(e.path.lastIndexOf("/") + 1))
);

/**
 * The horizontal outset for a node's scene identity, or null when this node's `clip_contents` should bound BOTH axes
 * (the default for every clipper). First-match-wins, like resolveViewScale.
 */
export function resolveClipAxisOutset(file: string | null, relPath: string | null): number | null {
  if (file == null || relPath == null) {
    return null;
  }
  for (const e of CLIP_AXIS_ENTRIES) {
    if (e.file === file && e.path === relPath) {
      return e.outsetX;
    }
  }
  return null;
}
