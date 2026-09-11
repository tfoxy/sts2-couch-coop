import { affineInverse, affineMul, nodeMatrix, IDENTITY_AFFINE, type Affine } from "@/mirror/affine";
import { isCardTrailNode } from "@/mirror/cardTrail";
import { ensureFontFace } from "@/mirror/fonts";
import { opensCardRewardScreen } from "@/mirror/viewScaleLayout";
import { nodePaintsContent, nodePlacementTransform, paintsAtlasCanvas, splitAnimStyle, splitSelfStyle, type RenderItem } from "@/mirror/nodeStyles";
import { nodeParticleAttributes } from "@/mirror/particleAttributes";
import { nodeShaderAttributes, type MirrorShaderBinding } from "@/mirror/shaderAttributes";
import { computeSpread as computeSpreadLayout, createSpreadOut, type SpreadBox, type SpreadEnv, type SpreadOut } from "@/mirror/spreadLayout";
import { nodeTypeLeaf, type MirrorNode } from "@/mirror/sceneTree";
import { isPaintAnchorExcluded, isRemoteFollower } from "@/mirror/renderer/interactionPolicy";
import { clipAxisOutsetFor, spreadSceneIdentityEnv } from "@/mirror/renderer/staticBackgroundPolicy";
import { forgetBlendNode, hasBlendNodes, mirrorWalkStats, noteBlendNode } from "@/mirror/renderer/walkStats";
import { setTextureStyleNode, warmImage } from "@/mirror/textureCache";
import { atlasPlaceholderMechanism } from "@/mirror/renderer/dom/atlasRuntime";
import { EMPTY_ATTRS, isMapStrokeNode, ZERO_ORIGIN } from "@/mirror/renderer/dom/flightTrailPolicy";
import { mul, rgbOf, isIdentity } from "@/mirror/renderer/dom/walkModel";
import type { Rgb } from "@/mirror/renderer/dom/walkModel";
import type { RenderRecord, WalkCtx } from "@/mirror/renderer/dom/recordModel";
import { applyAttrs, applyCachedAttr, applyStyleMap, geometryBoxDiffers, geometryMembershipDiffers, isInteractiveRectCandidate, mergedNodeStyle, sameWalkCtx, setStyleProp } from "@/mirror/renderer/dom/style";
import type { NodeController } from "@/mirror/renderer/dom/nodeController";
import type { ScaleController } from "@/mirror/renderer/dom/scaleController";
import type { HandController } from "@/mirror/renderer/dom/handController";
import type { DormancyLifecycle } from "@/mirror/renderer/dom/dormancyLifecycle";
import type { ElementLifecycle } from "@/mirror/renderer/dom/elementLifecycle";
import type { CardFlightController } from "@/mirror/renderer/dom/cardFlightController";
import type { CardTrailController } from "@/mirror/renderer/dom/cardTrailController";
import type { TweenController } from "@/mirror/renderer/dom/tweenController";
import type { AnimationRuntime } from "@/mirror/renderer/dom/animationRuntime";
import type { OcclusionRuntime } from "@/mirror/renderer/dom/occlusionRuntime";
import type { SceneIdentityRuntime } from "@/mirror/renderer/dom/sceneIdentity";

export interface NodeWalkerPorts {
  records: Map<string, RenderRecord>;
  nodes(): Map<string, MirrorNode>;
  childIdsByParent(): Map<string, string[]>;
  subtreeDirty(): Set<string> | null;
  visited(): Set<string> | null;
  textureDirtySelf(): Set<string> | null;
  changedParents(): ReadonlySet<string>;
  orderDirtyParents(): ReadonlySet<string>;
  orphanRootIds(): ReadonlySet<string> | null;
  walkNow(): number;
  spreadFactor(): number;
  markGeomDirty(): void;
  geomDirty(): boolean;
  noteRevealBuilt(): void;
  anchorAnimations(el: HTMLElement, offsetMs: number): void;
  markEffectsDirtyBits(bits: number): void;
  spreadDrawBox(node: MirrorNode): SpreadBox | null;
  staticBgHeldIds(): ReadonlySet<string>;
  staticBgSuppressedRootIds(): ReadonlySet<string>;
  staticBgHold(id: string, node: MirrorNode): boolean;
  staticBgSuppress(id: string, node: MirrorNode): boolean;
  computeSceneInfo(id: string): ReturnType<SceneIdentityRuntime["computeSceneInfo"]>;
  resolveVisualOwnerId(id: string): string;
  hitTestShift(x: number, y: number): number;
  nodeController: NodeController;
  scaleController: ScaleController;
  handController: HandController<RenderRecord>;
  dormancy: DormancyLifecycle;
  elementLifecycle: ElementLifecycle;
  cardFlights: CardFlightController;
  trails: CardTrailController;
  tweens: TweenController;
  animationRuntime: AnimationRuntime;
  lineMasks: { pinnedStrokeLocal(id: string, transform: Affine): Affine };
  svgDefs: { registerTint(tint: Rgb): string };
  occlusionRuntime: OcclusionRuntime;
  updateSubLayers(record: RenderRecord, node: MirrorNode, global: Affine, shader: MirrorShaderBinding | null, particle: { specsJson: string } | null, selfLayerPaint: Record<string, string> | null, hasChildren: boolean, deferHiddenLayers: boolean): void;
  applyRecordSuppression(record: RenderRecord, el: HTMLElement, suppressed: boolean): void;
  removeEl(record: RenderRecord): void;
  computeAdoptKey(node: MirrorNode, ctx: WalkCtx): string | null;
}

export interface NodeWalker { visit(id: string, ctx: WalkCtx, structural: boolean): void; }

/**
 * Per-node retained-DOM decision engine. The renderer owns structural classification and post-walk consumption;
 * this leaf owns only recursive policy and receives each live collaborator through an explicit narrow port.
 */
export function createNodeWalker(ports: NodeWalkerPorts): NodeWalker {
  const records = ports.records;
  const changedParents = ports.changedParents();
  const orderDirtyParents = ports.orderDirtyParents();
  const {
    nodeController,
    scaleController,
    handController,
    dormancy,
    elementLifecycle,
    cardFlights,
    trails,
    tweens,
    animationRuntime,
    lineMasks,
    svgDefs,
    occlusionRuntime
  } = ports;
  const {
    newRecord,
    createEl,
    setCachedCtx,
    ctxUnchanged,
    pinTintChanged,
    pinRepairCtx,
    ctxAffineOnlyChanged,
    syncShaderUvWindow,
    syncParticleVisibleRect,
    placeEl,
    needsOwnEl,
    bobPhaseMs
  } = nodeController;
  let nodes = ports.nodes();
  let childIdsByParent = ports.childIdsByParent();
  let subtreeDirty = ports.subtreeDirty();
  let visited = ports.visited();
  let textureDirtySelf = ports.textureDirtySelf();
  let orphanRootIds = ports.orphanRootIds();
  let walkNow = ports.walkNow();
  let spreadFactor = ports.spreadFactor();
  let geomDirty = ports.geomDirty();
  const staticBgRuntime = {
    heldIds: ports.staticBgHeldIds(),
    suppressedRootIds: ports.staticBgSuppressedRootIds()
  };
  const refreshWalk = (): void => {
    nodes = ports.nodes();
    childIdsByParent = ports.childIdsByParent();
    subtreeDirty = ports.subtreeDirty();
    visited = ports.visited();
    textureDirtySelf = ports.textureDirtySelf();
    orphanRootIds = ports.orphanRootIds();
    walkNow = ports.walkNow();
    spreadFactor = ports.spreadFactor();
    geomDirty = ports.geomDirty();
  };
  const markGeomDirty = (): void => {
    ports.markGeomDirty();
    geomDirty = true;
  };
  const computeSceneInfo = (id: string) => ports.computeSceneInfo(id);
  const resolveVisualOwnerId = (id: string) => ports.resolveVisualOwnerId(id);
  const hitTestShift = (x: number, y: number) => ports.hitTestShift(x, y);
  const staticBgHold = ports.staticBgHold;
  const staticBgSuppress = ports.staticBgSuppress;
  const applyRecordSuppression = ports.applyRecordSuppression;
  const removeEl = ports.removeEl;
  const computeLifecycleAdoptKey = ports.computeAdoptKey;
  const updateSubLayers = ports.updateSubLayers;
  const anchorAnimations = ports.anchorAnimations;
  const markEffectsDirtyBits = ports.markEffectsDirtyBits;
  const spreadDrawBox = ports.spreadDrawBox;

  const GEOM_PROBE_BUDGET = 96;
  const geomProbeStack: string[] = [];
  function subtreeFeedsGeometry(id: string): boolean {
    let budget = GEOM_PROBE_BUDGET;
    geomProbeStack.length = 0;
    geomProbeStack.push(id);
    while (geomProbeStack.length > 0) {
      if (budget-- <= 0) {
        return true; // too big to prove clean — assume the move matters
      }
      const cur = geomProbeStack.pop() as string;
      if (scaleController.hasViewScale(cur)) {
        return true;
      }
      const n = nodes.get(cur);
      if (n != null && isInteractiveRectCandidate(n)) {
        return true;
      }
      const kids = childIdsByParent.get(cur);
      if (kids) {
        for (const kid of kids) {
          geomProbeStack.push(kid);
        }
      }
    }
    return false;
  }

  function producesEl(node: MirrorNode, id: string): boolean {
    const kids = childIdsByParent.get(id);
    return needsOwnEl(node) || (kids != null && kids.length > 0);
  }

  // R10-PERF5 WS-1: `producesEl` answers "would this node WANT an element" — under dormancy that is no longer the
  // same question as "will one exist". A dormant child produces nothing, and counting it would inflate its parent's
  // `behindCount`, which is the index the sub-layers slot at (`updateSubLayers`' `lead`, `applyChildOrder`) — the
  // parent's own paint would land one slot too late and render BEHIND a behind-child that isn't there. So the count
  // asks the dormancy predicate too: the child keeps/gains an element unless it is effectively hidden with none
  // today. `parentHidesChildren` = the value of `ctx.ancestorHidden` this node hands its children (its own
  // `hidden` OR an already-hidden ancestor), so a hidden parent's VISIBLE children are correctly seen as dormant.
  // Evaluated before the children are visited, so `records.get(cid)?.el` is last walk's state — which is exactly
  // right: an el that exists survives (dormancy never tears down), and a reveal (visible, not hidden-by-parent)
  // is counted because this same walk is about to build it.
  // R10-PERF5 WS-3: inside a HATCH the answer flips back to `producesEl`. The hatchery's contract is that the whole
  // subtree ends up built — a child it can't reach in this slice becomes a queued marker and is built by the next
  // one — so a hidden behind-child WILL have an element, and asking "does it have one *today*" would under-count
  // exactly the case the WS-1 fix exists for: this node is being built BEFORE its children, so every one of them
  // still reads `el == null`, and its own paint would slot ahead of the behind-children about to appear. (An el-less
  // node still counts for nothing, and the transient over-count while a deferred child is outstanding is corrected
  // by the reorder that child's own build queues — see placeEl / reorderChangedParents.)
  // R10-PERF5 WS-4: on a FULL walk the "does it have one today" fallback inverts — an effectively-hidden child with
  // an element is about to LOSE it (reclaim), and this parent's behindCount is computed before that child is
  // visited. Counting it would leave the parent's own paint one slot too late for the rest of the walk (the exact
  // failure the WS-1 count fixed, in the opposite direction).
  function childHasOrWillHaveEl(cid: string, c: MirrorNode, parentHidesChildren: boolean, structural: boolean): boolean {
    if (!producesEl(c, cid)) {
      return false;
    }
    if (dormancy.isHatching()) {
      return true;
    }
    // R12 STATIC-BG BUILD HOLD: a held child produces no element however visible it is, so it must not be counted.
    // Reads the SET (last walk's answer) rather than re-asking the predicate, which keeps this O(1) and matches
    // this function's documented contract. Belt-and-braces in practice — a bg root is not `showBehindParent` — but
    // the failure it prevents (BgContainer's own paint slotting behind a child that isn't there) is silent.
    if (c.visible && !parentHidesChildren && !staticBgRuntime.heldIds.has(cid)) {
      return true;
    }
    if (structural) {
      return false; // effectively hidden on a full walk ⇒ no element, whether or not it has one right now
    }
    return records.get(cid)?.el != null;
  }

  // Whether a clean-but-dirty-descendant node may take the recurse-only fast path (skip its own restyle + childCtx
  // rebuild, just recurse the cached childCtx). Each exclusion maps to a per-visit side effect the fast path would
  // wrongly skip because it depends on OTHER records / mutable renderer state, not purely on this node + its ctx.
  function fastPathEligible(id: string, node: MirrorNode): boolean {
    // (1) a changed DIRECT child could flip this node's behindCount (recomputed only on the slow path).
    if (changedParents.has(id)) return false;
    // (5) a parent whose CHILD ORDER changed this incremental walk: its behindCount may have moved and its element
    //     is queued for the targeted reorder — it must take the slow (behindCount-recomputing) visit.
    if (orderDirtyParents.has(id)) return false;
    // (2) an owner-anchored floater's dx reads ANOTHER record's spreadDx — must recompute each walk.
    if (node.anchorOwnerId != null) return false;
    // (3) a remote follower's dx = hitTestShift(...) reads the other records' shifts every frame.
    if (isRemoteFollower(node)) return false;
    // (4) while a card is held every visit runs the held-card / targeting-arrow / tooltip tracking blocks; the
    //     simple, safe option is to disable the fast path entirely for the (transient) held-card interaction.
    if (handController.heldCardId() != null) return false;
    return true;
  }

  // R10-PERF6 WS-P1 — the ADDITIONAL exclusions for the ANCESTOR-AFFINE fast path (on top of `fastPathEligible`,
  // which it also requires). That path re-derives a node's PLACEMENT and nothing else, so every node kind whose
  // per-visit work is a function of its rendered global — or whose element carries renderer-owned state a restyle
  // re-asserts — must take the full visit instead:
  //   • no element (nothing to place) or a dormant marker (nothing built);
  //   • `builtWhileHidden` — the pending reveal re-anchor must run in the full visit;
  //   • a PINNED LOOP (`syncPinnedLoop` re-derives its pivot from the rendered matrix every visit — this is what
  //     keeps the travelable map points on the slow path);
  //   • a live tween/hide-latch pin (the element's transform/opacity are owned by the CSS transition, not by us);
  //   • a card trail or a map quill stroke (their geometry is re-sampled per visit from the rendered globals);
  //   • a HoverTip-set child, whose `gDesign` the tip-scale pass measures from this visit.
  // Scratch `RenderItem` for the ancestor-affine fast path's placement derivation (`nodePlacementTransform` only
  // READS it, and the string it returns is consumed before the next node is visited — the same discipline as
  // nodeStyles' placement scratch tuple). Keeps the path allocation-free on the hot map-scroll walk.
  let fastItem: RenderItem | null = null;

  function affineFastEligible(record: RenderRecord, node: MirrorNode): boolean {
    return (
      record.el != null &&
      !record.dormant &&
      !record.builtWhileHidden &&
      node.pinnedLoopAnim === null &&
      record.pinnedLoopSig === null &&
      record.tweenTransformUntil === 0 &&
      record.tweenOpacityUntil === 0 &&
      record.tweenSelfOpacityUntil === 0 &&
      record.hideLatchedUntil === 0 &&
      record.trailPaths.length === 0 &&
      node.linePoints == null &&
      !scaleController.hasTipChild(node.parentId)
    );
  }

  // R10-PERF6 WS-P1 — the WIDE-SCREEN SPREAD CLASSIFICATION. The algebra itself is `@/mirror/spreadLayout`, a pure
  // module shared with the canvas backend (see its header for the field, the branches, and why there is only one
  // copy). What stays here are the four bindings the walk owns and the module deliberately does not:
  //   * the live `spreadFactor` (MirrorView pushes it through setStretch, so it cannot be captured at module load);
  //   * card trails, for the box-less draw box;
  //   * the URL levers that switch the scene-identity re-centres on and off;
  //   * the two registry lookups — `records` for an owner-anchored floater's already-walked shift, `hitTestShift`
  //     for a remote follower — which is exactly why `fastPathEligible` refuses both kinds of node.
  // The wrappers below are name-for-name the functions that used to live here, so every call site reads the same.

  // The scene-identity + registry answers `computeSpread` cannot derive from geometry. Built ONCE per renderer:
  // every member closes over live state, so nothing here goes stale when a lever or a record changes.
  const spreadEnv: SpreadEnv = {
    // The three scene-identity branches, shared verbatim with the canvas backend (see spreadSceneIdentityEnv).
    ...spreadSceneIdentityEnv(computeSceneInfo),
    ownerDx: (ownerId, fallbackDx) => {
      const ownerRec = records.get(resolveVisualOwnerId(ownerId));
      return ownerRec != null ? ownerRec.spreadDx : fallbackDx;
    },
    // `hitTestShift` walks the interactive rects, so it is asked ONLY for the handful of nodes that are followers.
    remoteFollowerDx: (node, gx, gy) => (isRemoteFollower(node) ? hitTestShift(gx, gy) : null)
  };

  // One scratch — the walk consumes every field before it recurses, and nothing between the call and that
  // consumption re-enters `computeSpread`.
  const spreadOut: SpreadOut = createSpreadOut();

  function computeSpread(id: string, node: MirrorNode, ctx: WalkCtx, gNode: Affine, drawBox: SpreadBox | null): void {
    computeSpreadLayout(id, node, ctx, gNode, drawBox, spreadFactor, spreadEnv, spreadOut);
  }

  function visitNode(id: string, ctx: WalkCtx, structural: boolean): void {
    const node = nodes.get(id);
    if (!node) {
      return;
    }

    // The skip-clean gate runs FIRST, before any per-node derivation, so a skipped node pays only nodes.get +
    // records.get + ctx compare + subtreeDirty.has (the gNode/tint/alpha derivations below are unused by it and were
    // needlessly computed ahead of it before). ctxSame short-circuits on an OBJECT-identity pre-check (the parent
    // hands the SAME childCtx object down a clean subtree, see the ref-stability reuse below) before the field
    // compare; on a fields-match-but-ref-differs hit, re-cache the ref so the next walk's pre-check lands.
    let record = records.get(id);
    let ctxSame = false;
    if (record) {
      if (ctx === record.lastCtxRef) {
        ctxSame = true;
      } else if (ctxUnchanged(record, ctx)) {
        ctxSame = true;
        record.lastCtxRef = ctx;
      }
    }

    // Skip-clean (update passes only): same node object, same inherited context, AND nothing in this subtree
    // changed → leave the DOM untouched (and don't recurse). While an ANCESTOR is transform-tween-pinned, the
    // only thing that "changed" is that pinned ancestor's streamed transform — but this node rides the pinned
    // ELEMENT via the nested DOM, so re-basing it against the streamed transform would decouple it (the
    // TopBar-slide bug). Treat the inherited-context change as benign then and skip, as long as the node itself
    // isn't independently dirty (a fresh upsert / a subtree change still forces a real re-walk).
    // R10-PERF4 WS-3 (item 3) — hazard (a): the pin skip must NEVER swallow an ancestor-hidden FLIP. Its premise is
    // that the only thing that changed is the pinned ancestor's streamed transform (benign, the nested DOM carries
    // this node along) — but a reveal changes what this node must BUILD, not merely where it sits. A tooltip/dialog
    // revealed while an ancestor happens to own a transform tween would otherwise keep its sub-layers deferred for
    // as long as the pin lasts. Cheap: one boolean compare, and only on the `!ctxSame && pinnedAncestor` path.
    const skipForPin =
      ctx.pinnedAncestor &&
      !ctxSame &&
      record != null && record.haveCtx && record.cAncestorHidden === ctx.ancestorHidden;
    if (
      !structural &&
      record &&
      record.lastNode === node &&
      (ctxSame || skipForPin) &&
      !subtreeDirty!.has(id)
    ) {
      // R20 item 5 — PIN PAINT REPAIR. The pin is about to swallow an inherited TINT change,
      // which is NOT the "benign streamed transform" its premise licenses — it is a frame of the ancestor's fade, and
      // swallowing it parks the whole subtree at a stale brightness for as long as the pin lasts (and, when the fade
      // ends inside the pin window, forever after: nothing dirties this subtree again). Fall through into a real
      // visit, but on the hybrid context above, so the ONLY thing that can move is the paint.
      if (
        !ctxSame &&
        record.haveCtx &&
        record.cDomParent === ctx.domParent &&
        pinTintChanged(record, ctx)
      ) {
        mirrorWalkStats.pinPaintRepairs++;
        ctx = pinRepairCtx(record, ctx);
      } else {
        mirrorWalkStats.skippedSubtrees++;
        return;
      }
    }

    // R10-PERF3 WS-4: a texture THIS node styled provisionally against (nine-patch-over-atlas slices / the
    // degenerate-margin fallback — the only two natural-size readers, see nodeStyles) has just resolved its size.
    // The node object and its context are unchanged, so nothing else here would call it dirty: force its own
    // restyle and keep it off the recurse-only fast path. One null compare on every walk that has no such node.
    const texDirty = textureDirtySelf !== null && textureDirtySelf.has(id);

    // Recurse-only fast path (Stage 2): this node is itself clean (same object + same inherited context) but a
    // DESCENDANT is dirty (otherwise the skip gate above would have returned). Its own restyle / spread classification
    // / behindCount / childCtx are pure functions of (node, ctx, spreadFactor) — all unchanged here (a spreadFactor
    // change always arrives on a forceTextures STRUCTURAL walk, where this path is off) — so skip them all and just
    // recurse the CACHED childCtx into the children, refreshing only its time-dependent pinnedAncestor. Excluded
    // node kinds (see fastPathEligible) fall through to a full visit instead.
    if (
      !structural &&
      record &&
      record.lastNode === node &&
      ctxSame &&
      !texDirty &&
      record.childCtx !== null &&
      fastPathEligible(id, node)
    ) {
      mirrorWalkStats.fastPathVisits++;
      const cc = record.childCtx;
      cc.pinnedAncestor = ctx.pinnedAncestor || (record.tweenTransformUntil !== 0 && record.tweenTransformUntil > walkNow);
      const fastKids = childIdsByParent.get(id);
      if (fastKids) {
        for (const childId of fastKids) {
          const child = nodes.get(childId);
          if (child && child.showBehindParent) {
            visitNode(childId, cc, structural);
          }
        }
        for (const childId of fastKids) {
          const child = nodes.get(childId);
          if (child && !child.showBehindParent) {
            visitNode(childId, cc, structural);
          }
        }
      }
      return;
    }

    mirrorWalkStats.visits++;

    // This node's global Transform2D. The wire streams parent-relative matrices, so compose down the walk. A
    // transform-less node contributes no transform of its own → its global is the parent's (a pass-through group),
    // not the identity/origin.
    // MAP-QUILL PIN (see pinnedStrokeLocal): a stroke's local is the DrawViewport fit and never legitimately
    // changes, so latch it. Only reachable for a node that carries stroke geometry, so the extra test is one
    // already-hot property read for every other node in the scene.
    const localXf =
      node.linePoints != null && node.transform != null && isMapStrokeNode(node)
        ? lineMasks.pinnedStrokeLocal(id, node.transform as Affine)
        : (node.transform as Affine | null);
    // R14f — TRAIL FRAME LATCH (see latchTrailFrame). A synthesized ribbon holding a live point history is placed
    // at the space that history was authored in, NOT at whatever the wire's latest (root pose × stroke counter-
    // transform) pair composes to. Those two wire values have independent freeze windows, so their product sweeps
    // mid-flight — and every point already stored would sweep with it. `trailFrame` is null until the first sample
    // latches it and again as soon as the history drains, so an idle trail tracks the stream exactly as before.
    // One null read per node; only ever non-null on an `NCardTrail`.
    const gStreamed: Affine =
      node.transform == null ? ctx.parentGlobal : affineMul(ctx.parentGlobal, localXf as Affine);
    const gNode: Affine = record !== undefined && record.trailFrame !== null ? record.trailFrame : gStreamed;

    // Only this node's OWN visibility toggles its element's display; an ancestor's display:none cascades in CSS.
    // ORPHAN HOLD: a node whose parent isn't live was promoted to a stage root by
    // rebuildStructure, where its raw local transform would collapse it onto the design origin. Fold the hold into
    // this node's OWN `hidden` rather than into ctx.ancestorHidden — an orphan has no hidden ANCESTOR element for a
    // display:none to cascade from, so only the own-visibility write actually suppresses one that already built.
    // Everything else follows for free: the dormancy boundary keeps a fresh orphan out of the DOM entirely, the
    // reclaim tears down one that was built before it lost its parent, and children inherit `ancestorHidden` from
    // the `ctx.ancestorHidden || hidden` the child ctx is composed with.
    // The static-background hold is folded here for the
    // same reason — "the host-rendered picture of this room is what the viewer sees" has to be a BUILD decision, not
    // a paint one. The existing `staticBgSuppress` fold (into `suppressed`, below) is only consulted inside
    // `if (record.el)`, i.e. once createEl has already run for the root and its whole subtree; putting the answer in
    // `hidden` instead means the dormancy boundary never records the subtree at all, reclaim tears down one that was
    // built before the hold engaged, and every child inherits `ancestorHidden` → `deferHiddenLayers`, so not one
    // atlas canvas / gsw shader / particle / spine layer is allocated below it.
    // Evaluated unconditionally (not as the third disjunct) so set membership stays honest for an INVISIBLE bg root
    // too — the boundary below reads that set to keep the id out of the idle hatchery's queue.
    const staticBgHeld = staticBgHold(id, node);
    const hidden =
      !node.visible || (orphanRootIds !== null && orphanRootIds.has(id)) || staticBgHeld;
    // R10-PERF4 WS-3 (item 3): this node renders inside a display:none subtree, so its PURE-PAINT sub-layers (atlas
    // canvas / spine canvas / gsw markers) are deferred until a reveal. Note it keys off the ANCESTOR flag, not
    // `hidden`: a node hidden on its OWN already skips the whole paint block below.
    const deferHiddenLayers = ctx.ancestorHidden;
    // R10-PERF5 WS-1 — THE DORMANCY BOUNDARY. This node is effectively hidden AND has no element
    // today, so nothing it would build could be seen: skip the build and the whole subtree below it. Evaluated here,
    // against the record state as it stands BEFORE the create/adopt block, because both halves depend on it —
    // adoption is declined for a dormant add (never spend a pooled card element on an invisible tree), and the
    // early return lands after the record's math is refreshed. `record` is the pre-adopt lookup: a node with no
    // record at all is dormant by the same rule (it has no element either).
    // R10-PERF5 WS-4 — THE RECLAIM HALF. On a FULL walk the "has no element" clause is
    // dropped: an effectively-hidden node that DOES have one is dormant too, and the early return below tears the
    // element down first. Only on a full walk, because only a full walk owns the `visited` set + the post-walk
    // prune that destroys the records of the descendants this return orphans (see the switch block).
    const effectivelyHidden = hidden || ctx.ancestorHidden;
    const reclaim = structural && effectivelyHidden && record != null && record.el != null;
    const dormant = effectivelyHidden && (record == null || record.el == null || reclaim);
    const modAlpha = node.modulate ? node.modulate.a : node.opacity;
    const selfAlpha = node.selfModulate ? node.selfModulate.a : 1;
    const childTint = mul(ctx.tint, rgbOf(node.modulate));
    const ownTint = mul(childTint, rgbOf(node.selfModulate));

    // ---- Wide-screen re-layout (see MirrorView + MIRROR_MAX_DESIGN_WIDTH). On a wider-than-16:9 stage the whole
    // world is placed on ONE horizontal squeeze field: a game point at absolute game-x renders at `gameX·spreadFactor`
    // (so `renderedX = gameX·designW/1920`), i.e. it shifts right by `dx = gameX·(spreadFactor−1)`. THREE generic
    // rules decide a node's shift while a widening budget is open (`ctx.deltaParentWidth > 0`):
    //   • ANCHORED CONTROLS with a usable claim reproduce Godot's OWN resize instead (the HUD layout the game already
    //     re-lays-out): shift by `anchorLeft·Δparent` (lifted by the parent x-basis) + widen the box by
    //     `(anchorRight−anchorLeft)·Δparent` (via CSS width, never a transform scale — children/images don't stretch).
    //   • POSITIONAL CLAIMERS — content that paints/anchors its own visual (a sprite/label/card/creature/arrow
    //     segment/oversized bg, or a spine/particle point-anchor) — are placed on the field at their own CENTER and
    //     CONSUME the budget, so the whole subtree rides that ONE shift RIGIDLY (no internal tearing; center, not
    //     origin, keeps a >1920-wide center-covering bg centered).
    //   • PASS-THROUGH GROUPS — a boxless positioner (EnemyContainer/CardHolderContainer/BgContainer/NTargetManager/
    //     NTargetingArrow: children only, no own paint, non-widening) — take their own origin field-shift for their
    //     (paintless) element but PASS the budget through unconsumed, so each child computes its OWN field claim.
    // The shift is folded into a placement-only SHIFTED global; `childParentGlobal` (local-space composition +
    // tween-endpoint lifting) stays true 1920-space, so what we diff against the game is unchanged.
    // A Line2D joins the particle/spine "anchor at the transform origin" case: it has no localRect at all, and its
    // stroke svg is authored in NODE-LOCAL coordinates — so baking the matrix at local (0,0) makes SVG user space
    // and node-local space the same space, and the streamed points land verbatim.
    const drawBox = spreadDrawBox(node);
    computeSpread(id, node, ctx, gNode, drawBox);
    const dx = spreadOut.dx;
    const spreadFieldMode = spreadOut.fieldMode;
    const renderWidthOverride = spreadOut.renderWidthOverride;
    const childDeltaParentWidth = spreadOut.childDeltaParentWidth;
    const childAnchorDelta = spreadOut.childAnchorDelta;
    const childParentDx = spreadOut.childParentDx;
    const childRideDx = spreadOut.childRideDx;
    const spreadMode = spreadOut.spreadMode;
    const childParentDxProp = spreadOut.childParentDxProp;
    const childContainerAlign = spreadOut.childContainerAlign;
    const childContainerVertical = spreadOut.childContainerVertical;
    // Placement-only SHIFTED global — childParentGlobal stays the unshifted true global below.
    const gNodeStretched: Affine =
      dx === 0 ? gNode : [gNode[0], gNode[1], gNode[2], gNode[3], gNode[4] + dx, gNode[5]];

    // R10-PERF6 WS-P1 — THE ANCESTOR-AFFINE FAST PATH. This node's own object is unchanged and
    // every inherited field except the parent MATRICES is unchanged (ctxAffineOnlyChanged): it is riding an ancestor
    // that moved. A map scroll is exactly this — ONE wire upsert on the scroll container, ~4k descendants whose only
    // difference is where they sit — and on the pre-round walk every one of them re-ran nodeStyle + the shader/
    // particle attribute derivation + updateSubLayers + applyAttrs, then mostly discarded the identical result
    // (measured: ~410ms of an 826ms scroll on a phone).
    //
    // What an ancestor's matrix can actually change is enumerated and ALL of it is done here:
    //   • the SPREAD classification (already re-run above through the shared `computeSpread` — on a widened stage a
    //     node's field claim is a function of its own rendered X, so a rigid ride still moves `dx`),
    //   • the placement `transform` (through the same `nodePlacementTransform` seam `nodeStyle` emits it from),
    //   • the three `data-spread-*` attributes the input inverse reads,
    //   • the view-scale `gDesign` stamp + the two geometry-epoch bumps those depend on,
    //   • an oversized shader node's visible-UV window,
    //   • and the frame handed to the children (a FRESH childCtx object — mutating the cached one in place would
    //     make every child's `ctx === record.lastCtxRef` pre-check hit and silently skip the whole subtree).
    // Everything else it does NOT touch (paint/text/attrs/sub-layers/behindCount/child order/display) is a pure
    // function of the node object plus the ctx fields this path proved equal.
    if (
      !structural &&
      record &&
      record.lastNode === node &&
      !ctxSame &&
      !texDirty &&
      !ctx.pinnedAncestor &&
      !dormant &&
      ctxAffineOnlyChanged(record, ctx) &&
      fastPathEligible(id, node) &&
      affineFastEligible(record, node) &&
      // A widened anchored span's rendered WIDTH is a function of `localRect` + `ctx.anchorDelta` — both proven
      // equal above — so this can only differ on the first walk after the record was seeded. Cheap belt: if it
      // ever does, fall through to the full visit, which writes the CSS width too.
      renderWidthOverride === record.spreadW
    ) {
      mirrorWalkStats.affineFastPathVisits++;
      const el = record.el!;
      const fastKids = childIdsByParent.get(id);
      const fastHasChildren = fastKids != null && fastKids.length > 0;
      setCachedCtx(record, ctx);
      // The DERIVED wide-screen shift moved this node's rendered box (twin of the slow path's check below).
      if (!geomDirty && record.spreadDx !== dx && subtreeFeedsGeometry(id)) {
        markGeomDirty();
      }
      record.spreadDx = dx;
      record.spreadFieldMode = spreadFieldMode;
      record.spreadW = renderWidthOverride;

      // PLACEMENT. Built from exactly the item the slow path would hand `nodeStyle` (see the paint block below),
      // so the string is identical — including the atlas keep-aspect fit's `scale(...)` suffix. Written straight
      // through the style cache: an unchanged value (a rigid ride at 16:9) writes nothing at all.
      const substitute = node.transform != null ? gNodeStretched : null;
      const item =
        fastItem ??
        (fastItem = {
          node,
          opacity: 1,
          tintId: null,
          parentInv: null,
          hasChildren: false,
          renderWidthOverride: undefined,
          transformOverride: null,
          clipAxisOutsetX: undefined
        });
      item.node = node;
      item.opacity = modAlpha * selfAlpha;
      item.parentInv = ctx.parentInv;
      item.hasChildren = fastHasChildren;
      item.renderWidthOverride = renderWidthOverride || undefined;
      item.transformOverride = substitute;
      // A clip is not part of placement, but shares this scratch with the slow style path.
      item.clipAxisOutsetX = clipAxisOutsetFor(id, node, computeSceneInfo);
      const placement = nodePlacementTransform(item);
      if (placement !== null && record.style.get("transform") !== placement.transform) {
        cardFlights.noteNodeStreamed(id, record); // R12 WS-B — twin of the paint block's call
        setStyleProp(el, "transform", placement.transform);
        record.style.set("transform", placement.transform);
        // Same invalidation the slow path's applyStyleMap return value drives: the base transform moved (and any
        // view-scale / tip scale composed onto this element by a post-walk pass was just wiped).
        if (!geomDirty && subtreeFeedsGeometry(id)) {
          markGeomDirty();
        }
      }
      if (placement !== null && record.style.get("transformOrigin") !== placement.transformOrigin) {
        setStyleProp(el, "transformOrigin", placement.transformOrigin);
        record.style.set("transformOrigin", placement.transformOrigin);
      }

      // The input inverse's stamps (twin of the slow path's block below; `data-paints` is node-only, so it can't
      // have changed).
      record.attrSpreadDx = applyCachedAttr(el, "data-spread-dx", dx !== 0 ? String(dx) : null, record.attrSpreadDx);
      record.attrSpreadW = applyCachedAttr(
        el,
        "data-spread-w",
        renderWidthOverride ? `${node.localRect!.width},${renderWidthOverride}` : null,
        record.attrSpreadW
      );
      record.attrSpreadMode = applyCachedAttr(el, "data-spread-mode", spreadMode ? "prop" : null, record.attrSpreadMode);
      // The view-scale pass measures its stamp from this cached rendered global (and bumps the epoch when it moved).
      if (scaleController.hasViewScale(id)) {
        scaleController.cacheViewScaleGlobal(record, gNodeStretched);
      }
      // The one sub-layer write that depends on the rendered global (no-op unless this node has a shader layer).
      // The SHIFTED global — what actually places this element — so the window agrees with the slow path's
      // updateSubLayers(…, gNodeStretched, …) when the node carries a spread shift (valve OFF → old unshifted arg).
      syncShaderUvWindow(record, node, gNodeStretched);
      // …and its particle twin. An emitter riding a scrolling ancestor is precisely this path (the map's
      // point VFX), and its visible-rect budget moves with it even though nothing about the node did.
      syncParticleVisibleRect(record, node, gNodeStretched, drawBox);

      if (fastHasChildren) {
        const elCarriesTransformFast = node.transform != null && drawBox != null;
        let childParentInvFast: Affine | null;
        if (elCarriesTransformFast) {
          childParentInvFast =
            affineInverse(nodeMatrix(gNodeStretched, drawBox as { x: number; y: number })) ?? ctx.parentInv;
        } else {
          childParentInvFast = ctx.parentInv;
        }
        // ALWAYS a fresh object (never a mutated `record.childCtx`): the children's O(1) skip pre-check is
        // `ctx === record.lastCtxRef`, so re-handing them a mutated object would look UNCHANGED and skip the very
        // subtree this walk exists to move.
        const childCtx: WalkCtx = {
          domParent: el,
          tint: childTint,
          parentInv: childParentInvFast,
          parentGlobal: gNode,
          parentDx: childParentDx,
          deltaParentWidth: childDeltaParentWidth,
          anchorDelta: childAnchorDelta,
          parentDxProp: childParentDxProp,
          rideDx: childRideDx,
          parentWidth: node.localRect != null && node.localRect.width > 0 ? node.localRect.width : ctx.parentWidth,
          // No tween pin can be live here (affineFastEligible excludes one) and `ctx.pinnedAncestor` is false
          // (guarded above), so this is the same value the slow path would compose.
          pinnedAncestor: false,
          containerChildAlign: childContainerAlign,
          containerChildVertical: childContainerVertical,
          inCardRewardScreen: ctx.inCardRewardScreen || opensCardRewardScreen(nodeTypeLeaf(node.nodeType)),
          // `computeAdoptKey` is a pure function of the node + `ctx.contentScope`, both proven unchanged.
          contentScope: record.adoptKey,
          ancestorHidden: ctx.ancestorHidden || hidden
        };
        record.childCtx = childCtx;
        for (const childId of fastKids!) {
          const child = nodes.get(childId);
          if (child && child.showBehindParent) {
            visitNode(childId, childCtx, structural);
          }
        }
        for (const childId of fastKids!) {
          const child = nodes.get(childId);
          if (child && !child.showBehindParent) {
            visitNode(childId, childCtx, structural);
          }
        }
      }
      return;
    }

    if (structural) {
      visited!.add(id);
    }
    // This node's own paint needs refreshing when its data changed (object) or its inherited context changed;
    // if we're only descending to reach a dirty DESCENDANT, its own element is already current.
    let selfDirty = structural || !record || record.lastNode !== node || !ctxSame || texDirty;
    // GEOMETRY EPOCH — the upserted-node check. `record.lastNode` is still the PREVIOUSLY accounted object here (it's
    // overwritten two lines down), and every changed node is guaranteed to be visited (markDirty seeds subtreeDirty
    // with each changed id + its ancestors, and the skip gate requires `!subtreeDirty.has(id)`), so comparing here
    // sees every geometry move exactly once. Short-circuited by `geomDirty` — a structural walk bumps up front, so
    // this costs one boolean per node there.
    if (!geomDirty && (!record || record.lastNode !== node)) {
      const prevNode = record?.lastNode ?? null;
      if (
        prevNode === null || // a node with no accounted predecessor (only reachable on a structural walk, already dirty)
        geometryMembershipDiffers(prevNode, node) ||
        (geometryBoxDiffers(prevNode, node) &&
          (isInteractiveRectCandidate(prevNode) || subtreeFeedsGeometry(id)))
      ) {
        markGeomDirty();
      }
    }
    // This node's content-stable adopt key is null outside a pooled-card content scope.
    const adoptKey = computeLifecycleAdoptKey(node, ctx);
    if (!record) {
      // A node with no record is either genuinely new OR a pooled shell the game just re-instantiated under a
      // fresh Godot instance id. Try to claim the condemned record its predecessor left standing this walk — the
      // element (and every gsw shader binding keyed by it) then survives the recycle untouched.
      // R10-PERF5 WS-1: a DORMANT add never adopts. The pool holds real, styled elements (a card's whole subtree);
      // spending one on a subtree nobody can see would both waste it — the visible re-add that actually wanted it
      // gets nothing — and hand the invisible tree an element, which is precisely what dormancy exists to avoid.
      // A card that moves into a closed deck dialog therefore builds fresh on reveal: a missed reuse, never a bug.
      record = (dormant ? null : elementLifecycle.tryAdopt(id, node, adoptKey)) ?? newRecord(id);
      records.set(id, record);
    }
    if (adoptKey !== record.adoptKey) {
      elementLifecycle.setAdoptKey(record, adoptKey);
    }
    record.lastNode = node;
    setCachedCtx(record, ctx);
    // The DERIVED wide-screen shift: a re-layout that moves this node's rendered box (or widens it) moves its
    // interactive rect and any view-scale stamp measured from it, even when the streamed node is untouched.
    if (
      !geomDirty &&
      (record.spreadDx !== dx || record.spreadW !== renderWidthOverride) &&
      subtreeFeedsGeometry(id)
    ) {
      markGeomDirty();
    }
    record.spreadDx = dx;
    record.spreadFieldMode = spreadFieldMode;
    record.spreadW = renderWidthOverride;

    // R10-PERF5 WS-1 — THE DORMANCY EARLY RETURN. Everything above is bookkeeping the record must keep current even
    // while invisible (lastNode, the cached ctx incl. `cAncestorHidden`, the wide-screen spreadDx/spreadW, the
    // geometry-epoch comparisons); everything BELOW touches or creates DOM. So stop here: no createEl, no styling,
    // no sub-layers, and no recursion — the descendants of a dormant root get no records at all.
    //   • STEADY STATE is O(1): the record now carries the same node object and the same cached ctx, so the very
    //     next walk's skip-clean gate (top of `visit`) returns before any of this runs, exactly like any other
    //     clean subtree. A volatile update aimed at a dormant id costs O(depth) — markDirty seeds the ancestors,
    //     the walk descends and terminates here — and touches no DOM.
    //   • REVEAL is automatic: the visible flip changes the node object (or an ancestor's flip changes this ctx's
    //     `ancestorHidden`, which `ctxUnchanged` compares), so the skip gate cannot swallow it; the predicate then
    //     reads false and the createEl cascade below builds the whole subtree in one walk.
    //   • On a FULL walk `visited` was already stamped above, so the post-walk prune keeps the marker.
    //   • R10-PERF5 WS-3 — THE HATCHERY OVERRIDE. During an idle drain the boundary is crossed deliberately: this
    //     subtree is pre-built now, at idle, so the reveal that needs it doesn't have to build it. The popped ENTRY
    //     always builds (`id === hatchEntryId`) so a drain always makes progress — even with a 0ms budget, which
    //     degenerates to exactly one node per drain; everything DEEPER builds only while the budget holds, and the
    //     first child past the deadline goes back to being a marker (and therefore back into the queue) so the next
    //     drain resumes the DFS from precisely there. Nothing it builds can be seen: the entry is effectively hidden,
    //     so every descendant inherits `ancestorHidden` and the whole subtree sits under a `display:none`.
    //   • R10-PERF5 WS-4 — THE RECLAIM. `reclaim` means this node arrived at the boundary WITH an element (only
    //     possible on a full walk). Tear it down here, at the boundary, so the record demotes to an ordinary marker
    //     and everything below behaves exactly as if it had never been built: the DOM goes in ONE detach (the
    //     element carries its whole subtree with it), and the descendants' RECORDS — never visited, so never in
    //     `visited` — are destroyed by the post-walk prune, which runs them through `removeEl` individually and so
    //     leaves nobody holding a detached element. The two registries the boundary would otherwise have re-derived
    //     BELOW it are retired by hand (removeEl owns every other one, incl. the occlusion gate, the hover-tip set
    //     and both animator sets).
    if (dormant && !dormancy.canBuildDormant(id)) {
      // A node that reaches the boundary is EFFECTIVELY HIDDEN, so it can no longer be an active targeting arrow or
      // a surface readable-hand mode should move — and this is the last point its own visit reaches, so nothing
      // below can retire it. Unconditional (NOT inside the `reclaim` branch below): a node whose paint never
      // warranted an element of its own — a bare `NTargetingArrow` group, whose only visible content is its
      // children — takes the boundary with `record.el` already null, and a `reclaim`-only retire would strand it in
      // the set for as long as it stayed hidden. That is the whole targeting signal stuck on.
      handController.removeTargeting(id);
      handController.forgetRecord(id);
      if (reclaim) {
        if (scaleController.hasViewScaleItems()) {
          scaleController.dropViewScale(id); // the pass skips el-less/invisible entries anyway; don't leave it holding one
        }
        removeEl(record);
        // removeEl nulls `lastCtxRef` (it describes a dom parent that element no longer hangs on) — but a marker's
        // ctx REF is exactly what the hatchery re-enters `visit` with, and this ctx is still the live one (the
        // cached FIELDS setCachedCtx just wrote, incl. cDomParent, are untouched by removeEl). Put it back, or the
        // reclaimed subtree would be dropped from the queue on the next drain and never re-grow.
        record.lastCtxRef = ctx;
        mirrorWalkStats.reclaimedRoots++;
      }
      // R12 STATIC-BG BUILD HOLD. A HELD root must never enter the idle hatchery's queue: the hatchery pre-builds
      // dormant markers, which for this one means the ~27MB of bg canvases the hold exists to not build — a
      // regression that would only ever show up on a real phone, at idle, long after any bench had finished.
      dormancy.setDormant(record, true, /* queue */ !staticBgHeld);
      if (staticBgHeld) {
        mirrorWalkStats.staticBgHoldSkippedBuilds++;
        // …and a held root cannot be "suppressed": it has no element to write `display` on. Keep the membership
        // honest — the boundary is the only place that can, since the root is never visited past it — so
        // `applyRecordSuppression`'s `size === 0` fast bail stays free scene-wide and a recycled id can't inherit
        // a stale claim.
        if (staticBgRuntime.suppressedRootIds.size > 0) {
          // Membership is normally refreshed by staticBgRuntime.suppress; this dormant branch only retires a
          // record, so its next signal edge will re-evaluate the root before it can be displayed.
        }
      }
      mirrorWalkStats.dormantSkippedBuilds++;
      return;
    }

    const kids = childIdsByParent.get(id);
    const hasChildren = kids != null && kids.length > 0;
    const needsOwn = needsOwnEl(node);
    const needsEl = needsOwn || hasChildren;

    if (needsEl && !record.el) {
      // R10-PERF5 WS-1: this record was a dormant MARKER and is now building — a reveal. Counted here (rather than
      // at the visible flip) because this is the build the reveal actually costs, and because a marker can also be
      // revealed by an ANCESTOR's flip, which never touches this node's own wire data. `stampIdentityAttrs` runs
      // inside createEl, so the node re-acquires its identity/touch attributes on the same walk.
      // R10-PERF5 WS-3: a HATCH build is not a reveal and must never be counted as one — it happens at idle, under a
      // `display:none` ancestor, for a user who hasn't asked for anything. `revealBuildMs` is "how long was the frame
      // that opened the map"; charging idle pre-builds to it would erase the very number the hatchery exists to keep
      // flat. So the two live in separate series (`hatchedBuilds` / `hatchMs`), and `revealBuiltThisWalk` — the flag
      // that charges a whole reconcile to `revealBuildMs` — stays untouched by a drain.
      if (record.dormant) {
        dormancy.setDormant(record, false);
        if (dormancy.isHatching()) {
          mirrorWalkStats.hatchedBuilds++;
        } else {
          mirrorWalkStats.revealBuilds++;
          ports.noteRevealBuilt();
        }
      }
      createEl(record, id, node, gNodeStretched);
      // R10-PERF5 WS-3: born in the dark (always true under `hatching` — the entry is effectively hidden and every
      // descendant inherits it), so any decorative animation createEl just declared has nothing to anchor yet. The
      // hidden→visible flip below re-queues it.
      if (dormancy.isHatching() && (hidden || ctx.ancestorHidden)) {
        record.builtWhileHidden = true;
      }
      // A brand-new element must be fully styled even when the node OBJECT and ctx are unchanged — e.g. an
      // element-less leaf that just gained its first child via an INCREMENTAL structural delta without being
      // re-upserted itself (on the old code this case only ever arrived on a FULL walk, where selfDirty is
      // unconditionally true).
      selfDirty = true;
    } else if (!needsEl && record.el) {
      removeEl(record);
    } else if (record.dormant) {
      // R10-PERF5 WS-3: an ELEMENT-LESS node (no box, no paint, no children) that got past the boundary — hatched,
      // or revealed by a walk. It produces no DOM by NATURE, not by deferral, so it is not a subtree anyone is still
      // waiting to have built: clear the marker (and with it the queue entry) or the `dormantRoots` gauge would never
      // reach zero on a fully hatched scene, and the hatchery would re-pop the same id every drain forever.
      dormancy.setDormant(record, false);
    }

    // Node-type leaf (memoized), shared by the held-card lift, targeting/tooltip tracking, and the tip-scale pass.
    // Unconditional (not gated on record.el) so the held-card targeting tracker below keeps its exact prior behavior.
    const leaf = nodeTypeLeaf(node.nodeType);

    // Scale-controller membership is independent of the held-card lift: a tooltip enlarges whether or not a card
    // is held, and its direct children need their rendered global cached for the later paint-only pass.
    scaleController.registerHoverTip(id, leaf, node.visible);
    // Cache the rendered design global for a HoverTip-set DIRECT child so the scale controller can measure its design
    // AABB. The parent tip root was visited earlier this DFS, so it's already in the set; the size gate makes this
    // free unless a tooltip is currently on screen.
    scaleController.cacheTipChild(record, gNodeStretched);

    // #19 / WS-G2 track view-scale items. WHICH nodes resolve to an entry — the cheap root-file / node-name
    // pre-filter, the leaf-detected card-reward + treasure-relic branches, and the shadowing hazard baked into
    // the order of the two — is `viewScaleLayout.resolveViewScaleForNode`, shared with the canvas walk. What is
    // left here is this backend's own BOOKKEEPING: the registered-id map that drives the per-drain pass, its
    // geometry-epoch invalidation, and the cached design global the pass measures from.
    scaleController.registerViewScale(id, node, leaf, ctx.inCardRewardScreen, record, gNodeStretched);

    occlusionRuntime.updateCandidate(id, node);

    // Hand-only membership, translate ownership and tooltip priming live in the controller. It reads maps lazily
    // because this walk may have just replaced them, but traversal itself stays the renderer's concern.
    handController.registerNode(id, node, leaf, record);

    // Expose this node's ABSOLUTE horizontal re-layout shift on the DOM so the visual-anchor map (pointerMap) can
    // invert it: a pointer at design-x `f·designW` is over content rendered at `gameX + spreadDx`, so the game
    // coordinate under it is `f·designW − spreadDx`. The shift is cumulative (includes every ancestor's), so the
    // element the pointer lands on carries the full inverse. `data-paints` marks the node as a VISUALLY-PAINTING
    // anchor (only such nodes define the game↔stage correspondence; pointerMap walks the z-stack for the first).
    // `data-spread-w` carries the game-width,rendered-width pair a widened BACKDROP needs for its rect-pair map.
    // The spread attributes only matter on a widened stage (dx / renderWidthOverride are 0 at factor 1), so they
    // self-omit there; `data-paints` is cheap to stamp always and pointerMap ignores it on 16:9 anyway.
    if (record.el) {
      // Cached idempotent writes (see applyCachedAttr): in the common no-spread case (dx 0, no widen, not prop) all
      // four collapse to null === null and touch no DOM, instead of a removeAttribute per node per walk.
      record.attrSpreadDx = applyCachedAttr(record.el, "data-spread-dx", dx !== 0 ? String(dx) : null, record.attrSpreadDx);
      record.attrPaints = applyCachedAttr(
        record.el,
        "data-paints",
        nodePaintsContent(node, modAlpha * selfAlpha) && !isPaintAnchorExcluded(node) ? "1" : null,
        record.attrPaints
      );
      record.attrSpreadW = applyCachedAttr(
        record.el,
        "data-spread-w",
        renderWidthOverride ? `${node.localRect!.width},${renderWidthOverride}` : null,
        record.attrSpreadW
      );
      // Mark that this node's `dx` came from the positional squeeze field (a positional claimer or a pass-through
      // group) rather than the anchor algebra, so the input side inverts it via the field, not a fixed translation.
      record.attrSpreadMode = applyCachedAttr(record.el, "data-spread-mode", spreadMode ? "prop" : null, record.attrSpreadMode);
    }

    // `elCarriesTransform` is true exactly when nodeStyle bakes a CSS transform onto this element (it needs a box) —
    // which decides how children are re-based below. `drawBox` (the node's local drawing box; particle/spine anchor
    // at their transform origin) was computed above for the spread classification.
    const elCarriesTransform = node.transform != null && drawBox != null;

    // The frame this node hands its children (nested DOM): the inverse of THIS element's on-screen matrix, plus
    // this node's global (used to compose child globals in "local" space, and to lift tween endpoints).
    //   - box element (carries its transform): children re-base by inverse(nodeMatrix(gNodeStretched, box)) — the
    //     re-layout-SHIFTED matrix, so a riding subtree's descendants (which inherit the SAME absolute `parentDx`)
    //     end up byte-identical relative to this element (their common shift cancels), while `childParentGlobal`
    //     stays the UNSHIFTED true global.
    //   - transform-less / box-less group (element is identity): pass the parent frame straight through — the
    //     group adds no on-screen offset, but its transform (if any) still composes into the child GLOBALS.
    const childParentGlobal = gNode;
    let childParentInv: Affine | null;
    if (elCarriesTransform) {
      childParentInv = affineInverse(nodeMatrix(gNodeStretched, drawBox as { x: number; y: number })) ?? ctx.parentInv;
    } else {
      childParentInv = ctx.parentInv;
    }

    // A PURE container (exists only to group children — no own box/paint/text) is made non-interactive so its
    // (usually zero-box) element can never intercept a hit meant for a child; the child carries the touch id.
    const pureContainer = !needsOwn && hasChildren;

    if (record.el) {
      // WS-C: `record.occluded` (a TIER-1 gated subtree root — set by applyOcclusionPass at the END of the walk) is
      // folded in here so a covered root that re-styles mid-walk isn't un-hidden for a frame. The pass owns the
      // value; this write only has to agree with it.
      // R10-PERF6 WS-P2 STAGGERED REVEAL. `paintSuppressed` is this node's OWN answer (the suppressors);
      // the reveal hold is layered on top of it and owned by the release drain. A false←true edge on a node whose
      // ancestors are visible IS the reveal, and it is the only moment with everything the partition needs: the
      // node id, a live child index, and a walk that is about to style the subtree anyway.
      // STAGE-A static background: staticBgSuppress is the FOURTH suppressor (root-only; the display:none
      // cascades). It also maintains set membership, so a bg root walked in mid-stream engages immediately.
      const suppressed =
        hidden ||
        record.occluded ||
        staticBgSuppress(id, node);
      if (record.paintSuppressed && !suppressed && !ctx.ancestorHidden) {
        dormancy.stageReveal(id);
      }
      // Writes `display` AND — for a `staticBg`-suppressed root — the gsw effect-suspend stamp, through the SAME
      // helper the out-of-walk `writeRecordDisplay` uses, so the two can't drift (see applyRecordSuppression).
      applyRecordSuppression(record, record.el, suppressed);
      // A node going display:none cancels its hide-latch: the disappear it was covering has landed (cancel matrix —
      // display:none / removal), so a later re-show within the grace window isn't wrongly clamped to 0.
      if (hidden && record.hideLatchedUntil !== 0) {
        record.hideLatchedUntil = 0;
        record.hideLatchHeldAt = 0;
        record.hideLatchStreamedOpacity = null;
      }
      // Count DOM-producing behind-parent children up front — the sub-layers slot right after them (see
      // updateSubLayers / reconcileOrder). Kept current even on a dirty-descendant (clean-self) pass.
      // R10-PERF5 WS-1: `childHasOrWillHaveEl` rather than `producesEl` — a DORMANT behind-child contributes no
      // element, so counting it would push this node's sub-layers one slot too far and mis-order its own paint.
      let behindCount = 0;
      if (kids) {
        const childHidesUnder = ctx.ancestorHidden || hidden;
        for (const cid of kids) {
          const c = nodes.get(cid);
          if (c && c.showBehindParent && childHasOrWillHaveEl(cid, c, childHidesUnder, structural)) {
            behindCount++;
          }
        }
      }
      record.behindCount = behindCount;

      // R10-PERF5 WS-3 — RE-ANCHOR ON REVEAL. A CSS animation does not exist under `display:none`: the element the
      // hatchery built in the dark declared its keyframes, but `getAnimations()` had nothing to return, so the phase
      // anchor createEl queued was a no-op and the loop would start from zero (all in lockstep, every enemy intent
      // bobbing as one) the moment the subtree is shown. This is the hidden→visible flip, and the only place with
      // both the fresh global (the bob phase reads it) and a live element — so re-queue through the SAME seam
      // (`anchorAnimations` → the single end-of-walk `flushAnimPhaseAnchors`), never a parallel mechanism. A pinned
      // loop is re-armed by dropping its signature: `syncPinnedLoop` below then re-applies + re-anchors it on THIS
      // visit (it is the next statement, so nothing paints in between). Costs one boolean per visit; the flag is
      // only ever set by a hatch build, so this branch is unreachable without one.
      if (record.builtWhileHidden && !hidden && !ctx.ancestorHidden) {
        record.builtWhileHidden = false;
        const binding = record.staticAnimBinding;
        if (binding && binding.kind === "bob") {
          anchorAnimations(record.el, -bobPhaseMs(binding, gNodeStretched));
        }
        // Gated on the node STILL naming a token: nulling the signature is what makes syncPinnedLoop re-apply, but
        // the signature is also the flag that gets it CALLED at all — dropping it for a node whose token has since
        // gone away would strand the running loop with nobody left to stop it.
        if (node.pinnedLoopAnim !== null) {
          record.pinnedLoopSig = null;
        }
      }

      // WS-E / R10-B2: start/stop/re-anchor a producer-pinned loop animation for this node. Runs OUTSIDE the
      // `!hidden && !cull && selfDirty` style block so a node hidden while looping (or shown while not) still
      // settles correctly, and gated on a live token OR a running one so a clean re-visit costs one field compare.
      // Cheap: `pinnedLoopAnim` is null for every node but a travelable map point, an open screen's top-bar icon
      // and a pulsing proceed glow, and syncPinnedLoop's own signature check makes a repeat call a no-op (it must
      // NEVER restart a running sine). BEFORE the paint block on purpose: a rotation/glow token grows the animSelf
      // child, and the paint pass below is what moves the node's paint into it — same walk, no dropped frame.
      if (node.pinnedLoopAnim !== null || record.pinnedLoopSig !== null) {
        animationRuntime.syncPinnedLoop(
          record,
          node,
          hasChildren,
          affineMul(ctx.parentInv ?? IDENTITY_AFFINE, nodeMatrix(gNodeStretched, node.localRect ?? ZERO_ORIGIN))
        );
      }

      // A hidden node only needs its display toggled + its subtree propagated; skip invisible paint work.
      if (!hidden && selfDirty) {
        mirrorWalkStats.styledNodes++;
        // R10-PERF4 WS-4 (item 2) — BLEND CENSUS. A `mix-blend-mode` element forces the compositor to promote
        // everything painting above it, so a blend that is effectively INVISIBLE (alpha ~0) is pure layer tax. The
        // settle census only sees the final frame; these counters answer "how many exist at once MID-PLAY". Two
        // module calls per styled BLEND node (nothing at all for the ~99% that carry none), tracked against the
        // element's OWN opacity — exactly what the bench census reads — which for an INTERIOR node is `modAlpha`
        // alone (selfAlpha rides its self-layer; the blend stays outer — see splitSelfStyle).
        if (node.canvasBlendMode) {
          noteBlendNode(id, hasChildren ? modAlpha : modAlpha * selfAlpha);
        } else if (hasBlendNodes()) {
          forgetBlendNode(id); // a node can lose its blend mode between emissions
        }
        // R10-PERF3 WS-4: scope every `naturalSize` MISS made while styling this node (nodeStyle's degenerate
        // nine-patch check + updateSubLayers' atlas 9-slice) to this node id, so the load that resolves the size
        // can re-style exactly this node instead of the whole scene. Cleared at the end of the block — the two
        // module calls are the entire per-styled-node cost, and nothing in between can return or throw past them.
        setTextureStyleNode(id);
        cardFlights.noteNodeStreamed(id, record); // R12 WS-B — the degraded path, named (twin of the fast path's call)
        record.attrNodeType = applyCachedAttr(record.el, "data-node-type", node.nodeType, record.attrNodeType);
        const shader = nodeShaderAttributes(node, nodes);
        // Shared VFX ownership is ribbon-only; particle markers and their static gsw surfaces stay untouched.
        const particle = nodeParticleAttributes(node);
        let tintId: string | null = null;
        if (!isIdentity(ownTint)) {
          tintId = svgDefs.registerTint(ownTint);
        }
        // `nodeStyle` receives the composed global and rebases it through `parentInv` for this nested DOM element.
        // The one-field override avoids cloning the node on the normal hot path.
        const substitute = node.transform != null ? gNodeStretched : null;
        const styleNode = node;
        // R16 `noblend`: the STROKE hosts, which every other diet deliberately leaves blended — this is the one
        // that takes them, because on a phone each is its own compositor surface and that is the measured cost.
        // The id is banked as it is styled so the lift can restore exactly what the arm changed (see
        // refreshTrailSurfaceBlend); the leading flag test is the whole cost when the rung is not armed.
        const surfaceNoblend = cardFlights.trailSurfaceBlendSuppressed() && isCardTrailNode(node);
        if (surfaceNoblend) {
          cardFlights.noteTrailSurfaceStroke(id);
        }
        // Leaf element opacity = modulate.a × self_modulate.a (no cascade needed — a leaf has no children). An
        // interior node splits (below): its element opacity = modulate.a (cascades via CSS), self-layer = selfAlpha.
        const item: RenderItem = {
          node: styleNode,
          opacity: modAlpha * selfAlpha,
          tintId,
          parentInv: ctx.parentInv,
          hasChildren,
          renderWidthOverride: renderWidthOverride || undefined,
          transformOverride: substitute,
          // R11: the mass-flight VFX diet's `blend`/`particles` rungs stop the decorative branch of a flight-owned
          // trail from being its own compositor surface. `hide` folds into `suppressed` below instead.
          // R16: …and `noblend` does the same for the two strokes. Disjoint sets (see trailSurfaceBlendIds), so the
          // `||` can never be two diets fighting over one element.
          suppressBlend: cardFlights.flightDietCovers(id) || surfaceNoblend,
          // R20 one-axis clip (clipAxis.ts) — undefined for every node but a table-matched clipper, and the two
          // gates inside are the whole cost for the rest.
          clipAxisOutsetX: clipAxisOutsetFor(id, node, computeSceneInfo)
        };
        let selfLayerPaint: Record<string, string> | null = null;
        if (hasChildren) {
          // Interior node: its OWN paint (texture + tint filter + shader style + selfAlpha) moves to the
          // self-layer so it doesn't cascade onto the DOM-nested children; the element keeps placement +
          // modulate.a (which SHOULD cascade). Split the MERGED style — an HSV shader's feColorMatrix filter is
          // own-paint (a Godot material never affects children) and must ride to the self-layer with the tint.
          const { container, selfPaint } = splitSelfStyle(mergedNodeStyle(item, shader), modAlpha, selfAlpha);
          if (pureContainer) {
            container.pointerEvents = "none";
          }
          if (applyStyleMap(record.el, tweens.pin(record, container), record.style) && !geomDirty && subtreeFeedsGeometry(id)) {
            markGeomDirty(); // base transform rewritten (see applyStyleMap) — rects moved / a composed stamp was wiped
          }
          // Non-null marks the node INTERIOR for updateSubLayers (which wraps the paint sub-layers in the
          // self-layer even when this style map is empty).
          selfLayerPaint = selfPaint;
        } else if (record.animSelf) {
          // Animated leaf (energy/star orb): keep positioning + the cascading tint/blend on el, but move the node's
          // PAINT (texture background) onto the spinning self-layer child so the CSS animation rotates it in place.
          const { container, paint } = splitAnimStyle(mergedNodeStyle(item, shader));
          if (applyStyleMap(record.el, tweens.pin(record, container), record.style) && !geomDirty && subtreeFeedsGeometry(id)) {
            markGeomDirty();
          }
          applyStyleMap(record.animSelf, paint, record.animSelfStyle); // self-layer paint — never the node's placement
        } else {
          if (
            applyStyleMap(record.el, tweens.pin(record, mergedNodeStyle(item, shader)), record.style) &&
            !geomDirty &&
            subtreeFeedsGeometry(id)
          ) {
            markGeomDirty();
          }
        }
        // applyAttrs only READS `next`, so the copy is only needed when the particle keys are about to be written
        // into it (never mutate a shader binding's own attribute map). Without a particle, hand it the binding's
        // map — or the shared empty one — directly instead of allocating a (nearly always empty) object per styled
        // node.
        const attrs: Record<string, string | undefined> =
          particle
            ? { ...(shader?.attributes ?? {}) }
            : shader?.attributes ?? EMPTY_ATTRS;
        if (particle) {
          attrs["data-godot-particle-runtime"] = "1";
          attrs["data-godot-particle-specs"] = particle.specsJson;
        }
        // R10-PERF4 WS-3 (item 3): under a hidden ancestor, DON'T stamp the gsw shader/particle markers on a node
        // that carries none yet — they are exactly the selectors gsw's two runtimes query the stage for
        // (`[data-godot-shader-webgl]` / `[data-godot-particle-runtime]`), so deferring them keeps hundreds of
        // invisible nodes out of every gsw reconcile's querySelectorAll set as well as off the GPU. Gated on an
        // EMPTY attr cache so the "already stamped when the subtree went hidden" case still takes the normal path
        // (leaving the markers in place, and still able to update or remove them). On reveal the full restyle
        // stamps them for the first time, and applyAttrs' return value dirties the runtimes through the WS-2 seam
        // exactly as it does for a brand-new node.
        if (!deferHiddenLayers || record.attrs.size > 0) {
          // WS-2: only an ACTUAL marker write dirties a runtime — a re-style that reproduces the same attribute
          // values reports nothing, which is what makes the gate hold on a volatile-only frame.
          markEffectsDirtyBits(applyAttrs(record.el, attrs, record.attrs));
        }
        updateSubLayers(record, node, gNodeStretched, shader, particle, selfLayerPaint, hasChildren, deferHiddenLayers);
        // AFTER updateSubLayers, which owns `record.particleSelf` — the mount point this gates on. Twin of the
        // fast path's call; between them every visit that can move a particle node's rendered global restates
        // its visible-rect budget.
        syncParticleVisibleRect(record, node, gNodeStretched, drawBox);
        // CARD TRAIL: sample the head for this delta (the element was just built/kept above). Placed HERE rather
        // than inside updateSubLayers because this is the only scope that has the PARENT's global transform —
        // which is exactly the flying card's position, and therefore the trail's head (see cardTrail.ts).
        if (record.trailPaths.length > 0) {
          // WS-F: the PARENT's own applied shift (`record.spreadDx` of the visit parent — the walk is top-down, so
          // it was written this drain). NOT `ctx.parentDx`: a pass-through group hands its children the INHERITED
          // baseline rather than its own claim, so that field is not the parent's rendered displacement.
          const parentRec = node.parentId != null ? records.get(node.parentId) : undefined;
          trails.noteSample(
            record,
            gNodeStretched,
            // …and the DESIGN-space twin of that space, which is what the frame latch stores: `visit` re-derives
            // the on-stage shift from it every walk, so latching the shifted matrix would apply the shift twice.
            gNode,
            ctx.parentGlobal,
            parentRec?.spreadDx ?? 0
          );
        }
        if (node.font) {
          ensureFontFace(node.font.family, node.font.url, node.font.weight, node.font.style);
        }
        // A rich label's `[b]`/`[i]` spans render in a DIFFERENT font FILE (Godot swaps to the theme's bold_font
        // rather than synthesising), so each streamed role face needs its own @font-face before the
        // `--godot-rich-*-font-family` variables nodeStyles publishes can resolve. Weight/style are null: the file
        // IS the role, and declaring a weight would make the browser prefer/synthesise against it. `ensureFontFace`
        // is keyed by family and no-ops after the first call, so the order relative to other nodes that stream the
        // same family as their OWN font doesn't matter (same file, same single face either way).
        if (node.richBoldFont) {
          ensureFontFace(node.richBoldFont.family, node.richBoldFont.url, null, null);
        }
        if (node.richItalicFont) {
          ensureFontFace(node.richItalicFont.family, node.richItalicFont.url, null, null);
        }
        if (node.richBoldItalicFont) {
          ensureFontFace(node.richBoldItalicFont.family, node.richBoldItalicFont.url, null, null);
        }
        if (node.textureUrl && (!paintsAtlasCanvas(node) || atlasPlaceholderMechanism(node.textureUrl, false) === "page")) {
          // Atlas-canvas nodes used to SKIP the warm (a3d4ff2: the decode-once baker already holds the page, so
          // warmImage would redundantly decode it). STAGE-C item 1 re-enabled it for them: the page-crop
          // placeholder paints the PAGE itself as a CSS background — the warm primes the browser's own image
          // cache so the placeholder's first frame paints, and records the page's natural size for the crop
          // (regionBackgroundStyle's atlasSize, delivered late via onTextureSizesResolved). One Image per
          // distinct url per session.
          // Aug-19: the re-enable is now scoped to pages that CAN page-crop (the size gate — see the switch
          // block), so a3d4ff2's original argument comes back for exactly the pages it was about: a card atlas's
          // sprite mounts a canvas, nothing paints its url, and warming it would buy a redundant ~37MB decode.
          // (Nine-patch-over-atlas isn't a paintsAtlasCanvas node, so it still warms for its size.)
          warmImage(node.textureUrl);
        }
        setTextureStyleNode(null);
      }
      // Place this node's element under its parent (once). Its own children nest INSIDE it (below).
      placeEl(record, ctx, structural);
    }

    // Descend: children mount INSIDE this node's element (relative to childParentInv). Behind-parent children
    // first (they draw behind the node's own paint), then normal children — the within-element paint order.
    if (hasChildren) {
      const built: WalkCtx = {
        domParent: record.el ?? ctx.domParent,
        tint: childTint,
        parentInv: childParentInv,
        parentGlobal: childParentGlobal,
        // A pass-through group hands its children the INHERITED baseline (not its own field-shift), so each child
        // measures its own absolute claim in the budget-granting frame; a consuming node hands its own `dx`.
        parentDx: childParentDx,
        deltaParentWidth: childDeltaParentWidth,
        anchorDelta: childAnchorDelta,
        parentDxProp: childParentDxProp,
        rideDx: childRideDx,
        // This node's own width becomes its children's "parent width"; a zero-size positioner passes its parent's
        // (the budget-granting frame's) width through, so a nested anchored child's claim frame stays intact.
        parentWidth: node.localRect != null && node.localRect.width > 0 ? node.localRect.width : ctx.parentWidth,
        // Descendants ride this node too — flag them as pinned while THIS node owns an active transform tween
        // (or an ancestor already did), so a mid-tween re-walk doesn't re-base them off the streamed transform.
        // Gate on `!== 0` (never armed) so an un-tweened node skips the timestamp compare entirely; reuse walkNow.
        pinnedAncestor: ctx.pinnedAncestor || (record.tweenTransformUntil !== 0 && record.tweenTransformUntil > walkNow),
        // If THIS node is a widened BoxContainer, its children ride its re-layout (see the BOX CHILD branch).
        containerChildAlign: childContainerAlign,
        containerChildVertical: childContainerVertical,
        // R4-round4: descendants of the card-reward screen root are "in" it → an NCard among them is a reward card.
        inCardRewardScreen: ctx.inCardRewardScreen || opensCardRewardScreen(leaf),
        // R10-B3: this node's own adopt key becomes its children's scope prefix — so the chain extends only while
        // every link is nameable, and an auto-named node (adoptKey null) closes the scope for its whole subtree.
        contentScope: adoptKey,
        // A child renders inside a display:none subtree if this node or an ancestor is invisible.
        ancestorHidden: ctx.ancestorHidden || hidden
      };
      // Ref-stability (Stage 2): if the freshly-built childCtx is field-for-field identical to the one this node
      // handed its children last walk, REUSE the old object so each child's O(1) ctx-ref pre-check (ctx ===
      // lastCtxRef) keeps hitting down the whole clean subtree — one restyled ancestor must not cascade field
      // compares below it. Only adopt the new object when a field actually moved.
      const childCtx = record.childCtx !== null && sameWalkCtx(record.childCtx, built) ? record.childCtx : built;
      record.childCtx = childCtx;
      for (const childId of kids!) {
        const child = nodes.get(childId);
        if (child && child.showBehindParent) {
          visitNode(childId, childCtx, structural);
        }
      }
      for (const childId of kids!) {
        const child = nodes.get(childId);
        if (child && !child.showBehindParent) {
          visitNode(childId, childCtx, structural);
        }
      }
    }
  }
  function visit(id: string, ctx: WalkCtx, structural: boolean): void {
    refreshWalk();
    visitNode(id, ctx, structural);
  }

  return { visit };
}
