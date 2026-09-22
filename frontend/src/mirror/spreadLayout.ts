// THE WIDE-SCREEN SPREAD ALGEBRA — one copy, shared by both mirror backends.
//
// On a wider-than-16:9 stage the whole world is placed on ONE horizontal squeeze field: a game point at absolute
// game-x renders at `gameX·spreadFactor` (so `renderedX = gameX·designW/1920`), i.e. it shifts right by
// `dx = gameX·(spreadFactor − 1)`. THREE generic rules decide a node's shift while a widening budget is open
// (`ctx.deltaParentWidth > 0`):
//
//   • ANCHORED CONTROLS with a usable claim reproduce Godot's OWN resize instead (the HUD layout the game already
//     re-lays-out): shift by `anchorLeft·Δparent` (lifted by the parent x-basis) + widen the box by
//     `(anchorRight−anchorLeft)·Δparent` — a WIDTH override, never a transform scale, because children and images
//     must not stretch with it.
//   • POSITIONAL CLAIMERS — content that paints/anchors its own visual (a sprite/label/card/creature/arrow
//     segment/oversized bg, or a spine/particle point-anchor) — are placed on the field at their own CENTER and
//     CONSUME the budget, so the whole subtree rides that ONE shift RIGIDLY (no internal tearing; centre, not
//     origin, keeps a >1920-wide centre-covering bg centred).
//   • PASS-THROUGH GROUPS — a boxless positioner (children only, no own paint, non-widening) — take their own
//     origin field-shift for their (paintless) placement but PASS the budget through unconsumed, so each child
//     computes its OWN field claim.
//
// …plus the four narrower branches the generic rules get wrong on their own (a widened BoxContainer's children, an
// owner-anchored floater, a remote follower, and the scene-identity re-centres), each documented at its site.
//
// WHY IT LIVES HERE. It used to live inside `mirrorRenderer`'s DOM `visit`, closed over that walk's records and
// levers. The canvas backend (`canvas/buildDrawList.ts`) has to place every node on the SAME field or the two
// stages disagree about where the game is — a divergence that is invisible at 16:9 (where `spreadFactor === 1`
// makes every branch below a no-op) and up to ~600 design px wide at the 2520 cap. Two transcriptions of algebra
// this branchy could not stay in step, so there is exactly one, and it is a PURE function of plain data:
//
//   * no DOM, no `window`, no module-level mutable state — `computeSpread` writes into a caller-owned {@link
//     SpreadOut} and reads nothing else;
//   * the parts it CANNOT derive from geometry (scene identity, another node's already-walked shift,
//     a hit-test over the retained records) arrive through {@link SpreadEnv}, which each backend implements over
//     its own registries.
//
// The native `SpreadIndex` (the host's own twin, used for the server-side spread index) is the third
// implementation of these rules; each branch below names the native member it mirrors so the three stay matched.

import { isCardTrailNode, isCardTrailRootNode } from "@/mirror/cardTrail";
import { MIRROR_DESIGN_WIDTH, type MirrorNode } from "@/mirror/sceneTree";
import { isSpineSurfaceNode } from "@/mirror/creaturePlaceholder";

/** A 6-element Transform2D, in the wire's `[a, b, c, d, tx, ty]` order. Read-only here: nothing is mutated. */
export type SpreadAffine = readonly number[];

/** A node's LOCAL drawing box origin — all the field construction needs from it (the size comes off `localRect`). */
export interface SpreadBox {
  x: number;
  y: number;
}

/** The zero box the box-less paint kinds anchor at (a Line2D/trail/particle/spine anchor bakes its matrix at local (0,0)). */
export const SPREAD_ZERO_ORIGIN: SpreadBox = Object.freeze({ x: 0, y: 0 });

/**
 * The inherited spread context — the subset of a walk's per-node context the algebra reads.
 *
 * The DOM backend's `WalkCtx` is a superset of this (it also threads the DOM parent, tint, matrix inverses …); the
 * canvas walk threads exactly these fields and nothing else. Every one is 0/false/null when the stage is not
 * widened, which is what makes the whole module provably inert at 16:9.
 */
export interface SpreadCtx {
  /** The cumulative ABSOLUTE global-x shift already applied to this node's PARENT (design px). A node rides it verbatim unless its own branch moves it further. */
  parentDx: number;
  /** How much this node's PARENT widened (parent-local px) — the budget this node's anchor fractions scale against. */
  deltaParentWidth: number;
  /**
   * How much this node's immediate ANCHOR frame widened (the parent Control's own box). Equal to
   * `deltaParentWidth` down real anchored chains, but 0 under a zero-size pass-through group: a zero-size parent's
   * box never resizes, so its children's anchors are MEANINGLESS there (Godot would never move them).
   */
  anchorDelta: number;
  /**
   * The dx a RIGID (boxed Control) child of this node should take: a pass-through group's OWN field claim (≠
   * `parentDx`, which stays the inherited baseline for the floater override), or a consuming node's dx. The card's
   * EnergyIcon/Frame and a creature's Hitbox/Intents ride this so the whole entity moves as one — per-child
   * own-centre claims gave corner-placed parts a visibly different dx (the energy cost drifted ~25px off the card).
   */
  rideDx: number;
  /**
   * True when `parentDx` derives from the positional squeeze FIELD (a pass-through/positional ancestor) rather
   * than the anchor algebra. Riding descendants inherit it, so the input side inverts deep painted content (card
   * art) through the same field its holder claimed on rather than through a translation.
   */
  parentDxProp: boolean;
  /**
   * The parent's node-local WIDTH (design px; `MIRROR_DESIGN_WIDTH` at the root, inherited through boxless
   * groups). Lets the centre-fallbacks tell full-canvas background art (≈ parent width → centre it) from a small
   * left-fixed Control (a corner pile / HUD icon → leave it).
   */
  parentWidth: number;
  /** The PARENT's global Transform2D — the anchor algebra lifts a left claim by its x-basis. */
  parentGlobal: SpreadAffine;
  /**
   * The horizontal redistribution factor a child of a widened BoxContainer parent rides (0 begin / 0.5 centre / 1
   * end for an H-box; 0 for a V-box → ride the parent's own shift), or null when the parent is NOT a widened
   * BoxContainer. A real Godot BoxContainer IGNORES its children's anchors and re-lays out its packed row/column
   * when its box resizes, so a box child must NOT run the anchor algebra.
   */
  containerChildAlign: number | null;
  /**
   * True when that widened BoxContainer parent is VERTICAL: its alignment packs the other axis, but Godot lays each
   * child out across the box's full WIDTH (cross-axis fill), so a child whose own box already spans the container's
   * pre-widen width is full-frame background ART that re-centres instead of stranding left.
   */
  containerChildVertical: boolean;
}

/** Which field formula produced a node's `dx` — see {@link SpreadOut.fieldMode}. */
export type SpreadFieldMode = 0 | 1 | 2;

/** The algebra's whole answer for one node: its own shift/width, plus the context its children inherit. */
export interface SpreadOut {
  /** This node's applied ABSOLUTE horizontal shift, in design px. Added to the node's rendered global x. */
  dx: number;
  /**
   * WHICH field formula produced `dx`, for the tween seam to re-evaluate at an ENDPOINT: 0 = none (a rigid ride,
   * the anchor algebra, an owner/follower override — none of them a function of this node's own X, so an endpoint
   * keeps the walked shift), 1 = the ORIGIN field (a pass-through group), 2 = the CENTRE field (a positional
   * claimer). The boxed-control "ride" branch reports `spreadMode` but is deliberately 0: its dx is its holder's
   * claim, not its own.
   */
  fieldMode: SpreadFieldMode;
  /** Grow this node's painted box to this width (0 = no override). Anchor-algebra spans only. */
  renderWidthOverride: number;
  childDeltaParentWidth: number;
  childAnchorDelta: number;
  childParentDx: number;
  childRideDx: number;
  /** See {@link SpreadCtx.parentDxProp} — this node's OWN flavour (what the input side stamps for it). */
  spreadMode: boolean;
  /** …and the flavour its children inherit. */
  childParentDxProp: boolean;
  childContainerAlign: number | null;
  childContainerVertical: boolean;
}

/** A zeroed {@link SpreadOut} scratch. One per walk is enough: every field is consumed before the walk recurses. */
export function createSpreadOut(): SpreadOut {
  return {
    dx: 0,
    fieldMode: 0,
    renderWidthOverride: 0,
    childDeltaParentWidth: 0,
    childAnchorDelta: 0,
    childParentDx: 0,
    childRideDx: 0,
    spreadMode: false,
    childParentDxProp: false,
    childContainerAlign: null,
    childContainerVertical: false
  };
}

/**
 * Everything the algebra cannot read off a node's geometry, supplied by whichever backend is walking.
 *
 * Each member supplies a scene-identity answer, so this module keeps the algebra independent of backend-specific
 * scene resolution. An implementation that returns `false`/the fallback everywhere is a legal (if less accurate)
 * spread and never a crash.
 */
export interface SpreadEnv {
  /**
   * A full-canvas EVENT backdrop scene root, matched by scene identity. Re-centred on ½Δ and CONSUMING the budget,
   * so the backdrop art and its point-anchored flames/spine ride ONE rigid shift and stay matched.
   */
  isBackgroundSceneRoot(node: MirrorNode): boolean;
  /**
   * A card-PREVIEW container. The game lays its backdrop + preview card out in CONTAINER-LOCAL coords, so the
   * inner card must not take its own positional claim and drift off its backdrop — consume the budget instead.
   */
  isPreviewContainer(node: MirrorNode): boolean;
  /**
   * The scene-identity 0.5-claim EXCEPTIONS to the anchor algebra: small 0/0-anchored widgets the game
   * re-positions each frame against 0.5-anchored content (the map's drawing palette, the main menu's focus
   * ribbons). Without it they pin a fixed distance from the stage's LEFT edge and detach from what they mark.
   */
  forcesCenterClaim(id: string, node: MirrorNode): boolean;
  /**
   * The cumulative shift an OWNER-ANCHORED floater should ride — the shift of the control it is positioned from
   * (a HoverTip lives on a persistent, un-shifted container, so it inherits nothing down its own parent chain).
   * `fallbackDx` is the caller's `ctx.parentDx`, returned when the owner cannot be resolved.
   */
  ownerDx(ownerId: string, fallbackDx: number): number;
  /**
   * A REMOTE follower's shift (a teammate's co-op cursor / targeting indicator, drawn at a game-cursor position
   * THIS client never resolved): the shift of whatever content sits under its true game point. `null` for every
   * node that is not one — which is all of them but a handful in a co-op combat.
   */
  remoteFollowerDx(node: MirrorNode, gx: number, gy: number): number | null;
}

/**
 * THE FIELD. A game X shifts by `clamp(gameX, 0, 1920)·(spreadFactor − 1)`. Clamped to the viewport so
 * out-of-bounds content (a >1920-wide bg's off-screen edge) doesn't over-shift.
 */
export function fieldDxAtOriginX(gx: number, spreadFactor: number): number {
  const clamped = gx < 0 ? 0 : gx > MIRROR_DESIGN_WIDTH ? MIRROR_DESIGN_WIDTH : gx;
  return clamped * (spreadFactor - 1);
}

/**
 * The global X of a node's box CENTRE under the global `g` — its origin when it has no box at all. Uses `g`'s own
 * basis, so a transform that SCALES or rotates the node moves its centre accordingly.
 */
export function spreadCenterGx(g: SpreadAffine, node: MirrorNode, drawBox: SpreadBox | null): number {
  return drawBox
    ? g[4] + g[0] * (drawBox.x + (node.localRect?.width ?? 0) / 2) + g[2] * (drawBox.y + (node.localRect?.height ?? 0) / 2)
    : g[4];
}

/** The field evaluated at a node's box CENTRE (see {@link spreadCenterGx}). */
export function fieldDxAtCenter(
  g: SpreadAffine,
  node: MirrorNode,
  drawBox: SpreadBox | null,
  spreadFactor: number
): number {
  return fieldDxAtOriginX(spreadCenterGx(g, node, drawBox), spreadFactor);
}

/**
 * A node's LOCAL drawing box — `localRect`, or the zero box the box-less paint kinds anchor at. Twin of
 * `nodeStyles`' `placementBox`, which is what actually PLACES them, so the field sees the same box the painter
 * does. It also decides whether a walk re-bases this node's children against the node itself instead of passing
 * the parent frame through — so the two answers must agree node-for-node or a subtree would be shifted twice.
 *
 * The card-trail ROOT is listed for exactly that second reason (it paints nothing of its own): its placement
 * becomes the comet's transform carrier, the single node a flight replay drives. It remains unconditional, unlike
 * the stroke entry beside it: the root still has children to re-base, and a
 * root whose box disagreed with `placementBox` would double-apply its matrix to all of them.
 */
export function spreadDrawBox(node: MirrorNode): SpreadBox | null {
  return (
    node.localRect ??
    (node.particleSpec ||
    node.linePoints != null ||
    isCardTrailNode(node) ||
    isCardTrailRootNode(node) ||
    isSpineSurfaceNode(node)
      ? SPREAD_ZERO_ORIGIN
      : null)
  );
}

/**
 * The horizontal redistribution factor for a child of a widened BoxContainer, or null when `containerLayout` is
 * not a BoxContainer hint.
 *
 * A HORIZONTAL box re-packs its row so a child shifts by begin 0 / centre ½ / end 1 of the box's widening; a
 * VERTICAL box redistributes nothing horizontally (its alignment is the vertical packing), so its children just
 * ride the box's own shift → factor 0 (still INTERCEPTED, so a vbox child doesn't run the Godot-ignored anchor
 * algebra). Null → not a box (the child runs the normal spread branches). Mirrors the native
 * `SpreadIndex.ContainerHAlignFactor`.
 */
export function containerHAlignFactor(containerLayout: string | null): number | null {
  if (!containerLayout) {
    return null;
  }
  if (containerLayout.startsWith("vbox")) {
    return 0;
  }
  if (!containerLayout.startsWith("hbox")) {
    return null;
  }
  return containerLayout.endsWith("-center")
    ? 0.5
    : containerLayout.endsWith("-end")
      ? 1
      : 0; // -begin (or any unknown hbox suffix) packs from the left → no horizontal shift
}

/**
 * This node's own width becomes its children's "parent width"; a zero-size positioner passes its parent's (the
 * budget-granting frame's) width through, so a nested anchored child's claim frame stays intact.
 */
export function childParentWidth(node: MirrorNode, parentWidth: number): number {
  return node.localRect != null && node.localRect.width > 0 ? node.localRect.width : parentWidth;
}

/**
 * The spread context a WALK ROOT starts from: the root's parent is the VIEWPORT, which widens by exactly the extra
 * stage width the anchors budget against.
 */
export function rootSpreadCtx(spreadFactor: number, parentGlobal: SpreadAffine): SpreadCtx {
  const delta = spreadFactor === 1 ? 0 : (spreadFactor - 1) * MIRROR_DESIGN_WIDTH;
  return {
    parentDx: 0,
    deltaParentWidth: delta,
    anchorDelta: delta,
    rideDx: 0,
    parentDxProp: false,
    parentWidth: MIRROR_DESIGN_WIDTH,
    parentGlobal,
    containerChildAlign: null,
    containerChildVertical: false
  };
}

/**
 * WHERE ONE NODE LANDS ON THE SQUEEZE FIELD, and what its children inherit.
 *
 * Writes into the caller-owned `out` (one scratch per walk — the caller consumes every field before it recurses)
 * so a per-node build allocates nothing. `gNode` is the node's TRUE (unshifted, 1920-space) global; `drawBox` is
 * {@link spreadDrawBox} for it.
 *
 * `spreadFactor === 1` short-circuits the whole thing to "ride the parent rigidly", which at the root means dx 0
 * for every node — i.e. a 16:9 stage is provably untouched.
 */
export function computeSpread(
  id: string,
  node: MirrorNode,
  ctx: SpreadCtx,
  gNode: SpreadAffine,
  drawBox: SpreadBox | null,
  spreadFactor: number,
  env: SpreadEnv,
  out: SpreadOut
): void {
  let dx = ctx.parentDx; // default: ride the parent rigidly (a consumed subtree inherits its absolute shift)
  let renderWidthOverride = 0; // grow this node's painted box by its anchor-driven width delta (0 = no override)
  let childDeltaParentWidth = ctx.deltaParentWidth;
  let childAnchorDelta = ctx.anchorDelta;
  let childParentDx = ctx.parentDx; // what THIS node hands its children as their baseline shift
  let childRideDx = ctx.rideDx; // the dx a rigid (Control) child should ride — a group's own claim, see SpreadCtx
  // A default RIDER inherits its parent's flavour: deep painted content inside a claimed subtree (card art) must
  // report the same field its holder claimed on.
  let spreadMode = ctx.parentDxProp;
  let childParentDxProp = ctx.parentDxProp;
  // If THIS node is a widened BoxContainer, its children ride its OWN re-layout (a Godot BoxContainer ignores
  // child anchors) instead of running the anchor algebra — see the BOX CHILD branch. Resolved after the branch
  // below (needs childDeltaParentWidth to know the box widened); null for a non-box or a box that didn't widen.
  let childContainerAlign: number | null = null;
  let childContainerVertical = false;
  // Which field formula `dx` came from (see SpreadOut.fieldMode). Default 0 — only the two branches that read THIS
  // node's own rendered X claim one, and the two owner-anchored overrides below take it back.
  let fieldMode: SpreadFieldMode = 0;
  if (spreadFactor !== 1) {
    const anchored = node.anchorLeft != null && node.anchorRight != null;
    const leftClaim = anchored ? node.anchorLeft! : 0;
    const span = anchored ? node.anchorRight! - node.anchorLeft! : 0;
    // A node paints/anchors its OWN visual when it has a real (positive-width) box, or is a particle/spine
    // point-anchor. Everything else with children is a pure grouping positioner (boxless).
    const hasPaintBox = node.localRect != null && node.localRect.width > 0;
    const pointAnchor = node.particleSpec != null || isSpineSurfaceNode(node);
    const boxlessPositioner = !hasPaintBox && !pointAnchor;
    // The squeeze field itself lives in `fieldDxAtOriginX` / `fieldDxAtCenter` above (same clamp, same rate, same
    // centre construction), evaluated at `gNode` — this node's GLOBAL transform — by the two branches that claim it.
    if (ctx.deltaParentWidth > 0) {
      if (env.isBackgroundSceneRoot(node)) {
        // EVENT BACKGROUND SCENE ROOT (matched by scene identity, not geometry): re-centre this full-canvas bg on
        // the widened frame and CONSUME the budget so the whole packed bg scene — the backdrop art AND its
        // point-anchored flames — rides this ONE rigid shift, staying matched (a fixed-offset hack would desync
        // differently-placed flames). 0.5·Δ is the fullCanvas convention. Twin of SpreadIndex's bg-root branch.
        dx = ctx.parentDx + 0.5 * ctx.deltaParentWidth;
        renderWidthOverride = 0;
        childDeltaParentWidth = 0;
        childAnchorDelta = 0;
        childParentDx = dx;
        childRideDx = dx;
        spreadMode = false;
        childParentDxProp = false;
      } else if (env.isPreviewContainer(node)) {
        // CARD-PREVIEW CONTAINER (a sibling of the event-bg re-centre): a (0/1-anchored) container that re-renders
        // a focused card's linked preview. The game lays the backdrop + preview card out in CONTAINER-LOCAL
        // coords; at F≠1 the inner card would otherwise take its OWN positional centre claim and drift off its
        // backdrop. CONSUME the budget so backdrop + card ride the SAME rigid shift, preserving the preview's F=1
        // container-local layout. Placement is width-conditional (verified from real streams — not every preview
        // class is authored full-frame): a FULL-FRAME (≈parent-width) container re-centres on ½Δ (the fullCanvas
        // convention); a NARROWER preview rides its parent's shift instead of over-centering. Both keep the
        // CONSUME that fixes the drift. Twin of SpreadIndex's preview branch.
        const previewFullFrame = node.localRect != null && node.localRect.width >= ctx.parentWidth - 1;
        dx = previewFullFrame ? ctx.parentDx + 0.5 * ctx.deltaParentWidth : ctx.parentDx;
        renderWidthOverride = 0;
        childDeltaParentWidth = 0;
        childAnchorDelta = 0;
        childParentDx = dx;
        childRideDx = dx;
        spreadMode = false;
        childParentDxProp = false;
      } else if (ctx.containerChildAlign != null) {
        // BOX CHILD: this node's PARENT is a widened BoxContainer that re-lays out its packed row/column. A real
        // Godot BoxContainer IGNORES its children's anchors, so the child does NOT run the anchor algebra (which
        // would strand a 0/0 child like the card-reward "Skip" button LEFT); it rides the parent's shift plus the
        // container's alignment redistribution — begin 0 / centre ½ / end 1 of the parent's widening (a V-box
        // redistributes nothing horizontally → factor 0, so the child just rides the parent's own dx). Consume the
        // budget: the child's own subtree rides this ONE shift rigidly.
        // CROSS-AXIS EXCEPTION: a VERTICAL box also lays each child out across its full WIDTH (Godot cross-axis
        // fill), so a child whose own box already spans the container's pre-widen width is full-frame background
        // ART (the map parchment strip tiles) — it re-CENTRES on the widened box (0.5 claim, the fullCanvas
        // convention) instead of stranding left.
        const boxClaim =
          ctx.containerChildVertical && node.localRect != null && node.localRect.width >= ctx.parentWidth - 1
            ? 0.5
            : ctx.containerChildAlign;
        dx = ctx.parentDx + boxClaim * ctx.deltaParentWidth;
        childDeltaParentWidth = 0;
        childAnchorDelta = 0;
        childParentDx = dx;
        childRideDx = dx;
        spreadMode = false;
        childParentDxProp = false;
      } else if (boxlessPositioner && span <= 0.001) {
        // PASS-THROUGH GROUP: own origin field-shift, pass the budget through. Children see the SAME budget-granting
        // frame (parentDx/deltaParentWidth/parentWidth propagate; only the parent global advances to this gNode),
        // so each child measures its own absolute field claim — the group's own shift cancels for them. Its
        // ZERO-SIZE box gives descendants no anchor frame (anchorDelta 0); its own claim becomes their rideDx, so
        // boxed CONTROL children (the card's parts, a creature's Hitbox) ride the entity's ONE shift below.
        dx = fieldDxAtOriginX(gNode[4], spreadFactor);
        fieldMode = 1;
        childDeltaParentWidth = ctx.deltaParentWidth;
        childAnchorDelta = 0;
        childParentDx = ctx.parentDx;
        childRideDx = dx;
        spreadMode = true;
        childParentDxProp = ctx.parentDxProp;
      } else if (anchored && ctx.anchorDelta > 0) {
        // ANCHOR ALGEBRA: a Control whose anchors face a REAL resizing frame reproduces Godot's own resize (0/0
        // pins, 0/1 stretches, 1/1 hugs right, 0.5/0.5 re-centres). Its subtree rides its shift; a span node hands
        // its own widening down. EXCEPTION: a 0/0-anchored box that covers its WHOLE frame (the map parchment
        // tiles — 1920-wide art under a stretched map background) is background ART authored for the 1920 canvas,
        // not a left-pinned widget: it re-CENTRES on the widened frame like its 0.5-anchored siblings
        // (paths/rooms/legend all claim ½Δ), else it strands left and its exact painter inverse maps pointers into
        // content that actually renders elsewhere. The SCENE-IDENTITY exceptions (`env.forcesCenterClaim`) join it
        // for the same reason at a size the geometry test cannot see. Twin of SpreadIndex's centerClaim.
        const fullCanvas =
          leftClaim <= 0.001 && span <= 0.001 && node.localRect != null && node.localRect.width >= ctx.parentWidth - 1;
        const centerClaim = fullCanvas || env.forcesCenterClaim(id, node);
        dx = ctx.parentDx + ctx.parentGlobal[0] * (centerClaim ? 0.5 : leftClaim) * ctx.anchorDelta;
        const deltaW = span * ctx.anchorDelta;
        if (node.localRect != null && Math.abs(deltaW) > 0.01) {
          renderWidthOverride = node.localRect.width + deltaW;
        }
        childDeltaParentWidth = deltaW;
        childAnchorDelta = deltaW;
        childParentDx = dx;
        childRideDx = dx;
        spreadMode = false;
        childParentDxProp = false;
      } else if ((anchored || node.mouseFilter != null) && hasPaintBox) {
        // BOXED CONTROL under a ZERO anchor-frame: parent-relative UI (the card's EnergyIcon/Frame/labels, a
        // creature's Hitbox/HealthBar bar/Intents) — it rides its entity's ONE shift (the nearest pass-through
        // group's own claim). A per-child own-centre claim here gave corner-placed parts a visibly different dx
        // (the energy cost drifted ~25px off the card). Either Control marker suffices: anchors are always
        // streamed for Controls; mouseFilter is belt-and-suspenders.
        dx = ctx.rideDx;
        childDeltaParentWidth = 0;
        childAnchorDelta = 0;
        childParentDx = dx;
        childRideDx = dx;
        spreadMode = true;
        childParentDxProp = true;
      } else {
        // POSITIONAL CLAIMER: WORLD content placed at its own CENTRE on the field, CONSUMING the budget —
        // non-Control visuals (sprite arrow segments, world sprites, bg layers) and spine/particle anchors, which
        // the game positions in world space rather than relative to a parent rect.
        dx = fieldDxAtCenter(gNode, node, drawBox, spreadFactor);
        fieldMode = 2;
        childDeltaParentWidth = 0;
        childAnchorDelta = 0;
        childParentDx = dx;
        childRideDx = dx;
        spreadMode = true;
        childParentDxProp = true;
      }
    }
    // OWNER-ANCHORED FLOATER: a node positioned each frame from ANOTHER control's global rect (a HoverTip lives on
    // a persistent, un-shifted container) inherits no shift down its own parent chain, so it strands at the owner's
    // un-shifted native x while the owner moves. Its streamed transform already sits at the owner's NATIVE rect, so
    // the ONLY correction is the owner's cumulative shift — OVERRIDE the field/anchor result above. Children ride
    // via parentDx and the budget is consumed (no independent re-layout of the tooltip's subtree).
    if (node.anchorOwnerId != null) {
      dx = env.ownerDx(node.anchorOwnerId, ctx.parentDx);
      renderWidthOverride = 0;
      childDeltaParentWidth = 0;
      childAnchorDelta = 0;
      childParentDx = dx;
      childRideDx = dx;
      spreadMode = false;
      childParentDxProp = false;
      fieldMode = 0; // the OWNER's shift, not a function of this node's own X — an endpoint keeps it verbatim
    }
    // REMOTE FOLLOWER: a teammate's co-op cursor / targeting indicator, drawn at a game-cursor position THIS client
    // never resolved. Place it at the shift of the content under its true game point. It never widens and its
    // subtree rides the ONE shift rigidly. (A LOCAL follower needs no case — the game draws its segments at this
    // client's own game cursor, and the positional field maps them through the same map the input inverse uses.)
    const followerDx = env.remoteFollowerDx(node, gNode[4], gNode[5]);
    if (followerDx !== null) {
      dx = followerDx;
      renderWidthOverride = 0;
      childDeltaParentWidth = 0;
      childAnchorDelta = 0;
      childParentDx = dx;
      childRideDx = dx;
      spreadMode = false;
      childParentDxProp = false;
      fieldMode = 0; // the shift of the CONTENT under its game point, not this node's own field claim
    }
    // CONTAINER RE-LAYOUT signal for THIS node's children: when THIS node is a widened BoxContainer (it took the
    // anchor-algebra branch, so childDeltaParentWidth > 0), its children ride its OWN re-layout (a Godot
    // BoxContainer ignores child anchors) via the BOX CHILD branch above. The factor (0/0.5/1 for hbox
    // begin/centre/end; 0 for a vbox; null for a non-box) comes from the streamed containerLayout. Null when the
    // box didn't widen (a 0/0 box) or the node isn't a BoxContainer.
    if (childDeltaParentWidth > 0) {
      childContainerAlign = containerHAlignFactor(node.containerLayout);
      childContainerVertical = childContainerAlign != null && node.containerLayout?.startsWith("vbox") === true;
    }
  }
  out.dx = dx;
  out.fieldMode = fieldMode;
  out.renderWidthOverride = renderWidthOverride;
  out.childDeltaParentWidth = childDeltaParentWidth;
  out.childAnchorDelta = childAnchorDelta;
  out.childParentDx = childParentDx;
  out.childRideDx = childRideDx;
  out.spreadMode = spreadMode;
  out.childParentDxProp = childParentDxProp;
  out.childContainerAlign = childContainerAlign;
  out.childContainerVertical = childContainerVertical;
}

/**
 * THE FIELD CLAIM A NODE WOULD MAKE AT A GIVEN GLOBAL — the rule, once, for both backends.
 *
 * `computeSpread` measures a node's shift at its TRUE (streamed) global, because that is where the game has it.
 * Anything that MOVES the node client-side — a tween sample, a card flight, a replayed endpoint — needs the same
 * rule evaluated somewhere else, and the two stages used to spell it out separately: the DOM in its tween writer
 * (`mirrorRenderer.spreadDxAtGlobal`, at the ENDPOINT) and the canvas in {@link applyDrawnFieldRebase} (at the
 * DRAWN pose, every frame). Same three cases, two copies. This is the one copy; both call it.
 *
 * `walkedDx` is the answer for a node that does not claim the field for itself (mode 0) and at F = 1, where every
 * shift is 0 — which is what makes this provably inert at 16:9.
 */
/**
 * RE-EVALUATE A FIELD CLAIM AT THE POSE THE NODE IS ACTUALLY DRAWN AT.
 *
 * {@link computeSpread} measures the field at a node's TRUE (streamed) global, because that is where the game has
 * it. While something ANIMATES the node — a tween sample, a card flight, a client-side replay — the walk still
 * measures at the streamed pose, and on a widened stage that is the wrong place: the two field branches are
 * functions of the node's OWN rendered X, so the shift that belongs to a moved node is the field evaluated WHERE IT
 * MOVED TO. Worse, the producer suppresses a tweened node's streamed transforms for the window's whole length, so
 * the walked claim is not merely stale but FROZEN — a hand approach lands offset by `(endX − startX)·(F − 1)`, up
 * to ~600 design px at the 2520 cap, and then snaps when the settle re-emit lets the walk re-derive it. That snap
 * is the user-visible defect ("played cards move laggy and mispredict their landing, correcting when server deltas
 * arrive"), and it appears ONLY with the wide-screen stretch on, because at F = 1 every dx is 0.
 *
 * The DOM backend fixed this in its tween writer (`mirrorRenderer.spreadDxAtGlobal`); this is the same rule for a
 * backend that has no writer to put it in, applied to the walk's own answer instead. Kind for kind:
 *
 *   * mode 1 (a pass-through group's ORIGIN claim) → the field at the drawn origin;
 *   * mode 2 (a positional claimer's CENTRE claim) → the field at the drawn CENTRE, through the DRAWN basis, so a
 *     sample that also scales the node moves its centre with it;
 *   * mode 0 → UNTOUCHED. A rigid rider, an anchor-algebra Control, an owner-anchored floater and a remote follower
 *     all take their shift from something that is not their own X, and moving them along the field would be wrong.
 *
 * THE CHILD CLAIMS RIDE ALONG, BY EQUALITY. A field claimer hands its own `dx` down as the shift its boxed Control
 * children ride (`childRideDx`) and, in centre mode, as their inherited baseline (`childParentDx`) — so a card's
 * energy cost and frame art must move with the card or the entity tears in flight. Both are rewritten only where
 * they EQUALLED the walked `dx`: a pass-through group's `childParentDx` is deliberately its own PARENT's shift (its
 * children each claim the field for themselves), and that must not be dragged along by this.
 *
 * Pure and allocation-free: rewrites the caller's {@link SpreadOut} in place, reads nothing else, and returns
 * without touching a field when `spreadFactor === 1` or the node claimed no field — which is what makes it provably
 * inert at 16:9 and for every node that is not animating.
 */
/**
 * THE FIELD CLAIM A NODE WOULD MAKE AT A GIVEN GLOBAL — the rule, once, for both backends.
 *
 * {@link computeSpread} measures a node's shift at its TRUE (streamed) global, because that is where the game has
 * it. Anything that MOVES the node client-side — a tween sample, a card flight, a replayed endpoint — needs the
 * same rule evaluated somewhere else, and the two stages used to spell it out separately: the DOM in its tween
 * writer (`mirrorRenderer.spreadDxAtGlobal`, at the ENDPOINT) and the canvas in {@link applyDrawnFieldRebase} (at
 * the DRAWN pose, every frame). Same three cases, two copies. This is the one copy; both call it.
 *
 * `walkedDx` is the answer for a node that does not claim the field for itself (mode 0) and at F = 1, where every
 * shift is 0 — which is what makes this provably inert at 16:9.
 */
export function fieldDxAtGlobal(
  fieldMode: number,
  walkedDx: number,
  g: SpreadAffine,
  node: MirrorNode,
  drawBox: SpreadBox | null,
  spreadFactor: number
): number {
  if (spreadFactor === 1 || fieldMode === 0) {
    // Mode 0 takes its shift from something that is NOT this node's own X — a rigid rider, an anchor-algebra
    // Control, an owner-anchored floater, a remote follower — so moving it along the field would be wrong.
    return walkedDx;
  }
  return fieldMode === 1
    ? fieldDxAtOriginX(g[4], spreadFactor)
    : // CENTRE mode reads the pose's OWN basis, so a sample (or endpoint) that also scales the node moves its centre.
      fieldDxAtCenter(g, node, drawBox, spreadFactor);
}

export function applyDrawnFieldRebase(
  out: SpreadOut,
  node: MirrorNode,
  gDrawn: SpreadAffine,
  drawBox: SpreadBox | null,
  spreadFactor: number
): void {
  if (spreadFactor === 1 || out.fieldMode === 0) {
    return;
  }
  const walked = out.dx;
  const drawn = fieldDxAtGlobal(out.fieldMode, walked, gDrawn, node, drawBox, spreadFactor);
  if (drawn === walked) {
    return;
  }
  out.dx = drawn;
  if (out.childParentDx === walked) {
    out.childParentDx = drawn;
  }
  if (out.childRideDx === walked) {
    out.childRideDx = drawn;
  }
}
