import {
  applyAnimationBinding,
  ensureAnimationStyles,
  type PresentationAnimationBinding
} from "@spirectl/presentation/render";
import { nodeAnimBinding } from "@/mirror/animAttributes";
import type { Affine } from "@/mirror/affine";
import { isCardTrailNode } from "@/mirror/cardTrail";
import { MIRROR_DESIGN_HEIGHT, MIRROR_DESIGN_WIDTH, nodeTypeLeaf, type MirrorNode } from "@/mirror/sceneTree";
import { isRemoteFollower } from "@/mirror/renderer/interactionPolicy";
import type { MirrorWalkStats } from "@/mirror/renderer/walkStats";
import { particleVisibleRect, particleVisibleRectAttr } from "@/mirror/particleVisibleRect";
import { isSpineSurfaceNode } from "@/mirror/creaturePlaceholder";
import { uvWindowAttr, visibleUvWindow } from "@/mirror/visibleWindow";
import { CARD_FLIGHT_VFX_TYPE, EMPTY_ELS } from "./flightTrailPolicy";
import type { RenderRecord, WalkCtx } from "./recordModel";
import type { SceneInfo } from "./sceneIdentity";
import { affineEqual } from "./style";

export interface NodeControllerPorts {
  stage: HTMLElement;
  nodes(): ReadonlyMap<string, MirrorNode>;
  records(): ReadonlyMap<string, RenderRecord>;
  childIds(): ReadonlyMap<string, string[]>;
  rootIds(): readonly string[];
  computeSceneInfo(id: string): SceneInfo | null;
  stampIdentity(el: HTMLElement, id: string, node: MirrorNode): void;
  cardFlights(): { addVfxId(id: string): void };
  ensureAnimSelf(record: RenderRecord): HTMLElement;
  anchorAnimations(el: HTMLElement, offsetMs: number): void;
  spreadFactor(): number;
  markShaderDirty(): void;
  markParticleDirty(): void;
  stats: MirrorWalkStats;
}

export interface TargetedReorderInput {
  rootsOrderDirty: boolean;
  orderDirtyParents: ReadonlySet<string>;
}

/**
 * Retained-record DOM mechanics shared by the renderer's full and incremental walks. The renderer owns traversal,
 * lifecycle teardown and all structural decisions; this leaf owns only record construction, element identity,
 * cached walk context, effect geometry stamps, and the order scratch needed to place existing elements.
 */
export interface NodeController {
  newRecord(id: string): RenderRecord;
  ownerOf(el: HTMLElement): RenderRecord | undefined;
  registerElement(el: HTMLElement, record: RenderRecord): void;
  unregisterElement(el: HTMLElement): void;
  stampIdentityAttrs(el: HTMLElement, id: string, node: MirrorNode): void;
  bobPhaseMs(binding: PresentationAnimationBinding, gNode: Affine): number;
  createEl(record: RenderRecord, id: string, node: MirrorNode, gNode: Affine, structuralOnly?: boolean): void;
  setCachedCtx(record: RenderRecord, ctx: WalkCtx): void;
  ctxUnchanged(record: RenderRecord, ctx: WalkCtx): boolean;
  pinTintChanged(record: RenderRecord, ctx: WalkCtx): boolean;
  pinRepairCtx(record: RenderRecord, ctx: WalkCtx): WalkCtx;
  ctxAffineOnlyChanged(record: RenderRecord, ctx: WalkCtx): boolean;
  syncShaderUvWindow(record: RenderRecord, node: MirrorNode, gNode: Affine): void;
  syncParticleVisibleRect(record: RenderRecord, node: MirrorNode, gNode: Affine, drawBox: { x: number; y: number } | null): void;
  placeEl(record: RenderRecord, ctx: WalkCtx, structural: boolean): void;
  beginFullOrder(): void;
  reconcileFullOrder(): void;
  clearFullOrder(): void;
  clearPendingReorders(): void;
  reorderChangedParents(input: TargetedReorderInput): { fixupNeeded: boolean };
  needsOwnEl(node: MirrorNode): boolean;
  dispose(): void;
}

/*
 * Controller invariants
 * ---------------------
 *
 * This is deliberately not a renderer facade. Traversal chooses whether a node is reachable, whether it produces
 * a grouping element, and whether a fast path may skip the node. This controller only maintains state once that
 * decision has been made. Keeping that boundary narrow matters because traversal owns the recursive walk's timing,
 * while a retained record can outlive several structural passes through adoption and parking.
 *
 * Collection ports are getters rather than captured maps. Scene state is replaced at reconcile boundaries, and an
 * eager capture would make ordering observe an old tree after the first replacement. The same rule applies to
 * late collaborators: cardFlights is initialized after the controller, but createEl invokes its getter only when
 * a flight VFX element is actually born. No initialization-order placeholder is therefore observable.
 *
 * Element ownership is one-way while a record is alive:
 *
 *   element -> record  is used by occlusion and targeted ordering;
 *   record  -> element is used by normal styling and lifecycle teardown.
 *
 * ElementLifecycle is the sole teardown chokepoint. It unregisters an element as part of removal, and the renderer
 * does not dispose this controller until lifecycle disposal and the final removeEl sweep have completed. Clearing
 * the weak map earlier would turn a legitimate detached element into a false full-walk fixup during cleanup.
 *
 * Identity stamping is intentionally separate from streamed attrs. It includes the id, scene path and touch owner,
 * all of which must be recomputed when a pooled shell adopts a new id. The normal construction path stamps once;
 * adoption calls the same operation through ElementLifecycle, preserving exactly the old stamp sequence.
 *
 * Decorative animation routing has three distinct cases:
 *
 *   - intent bob translates the outer element, where translate composes with its baked placement matrix;
 *   - rotations and flame flickers animate a local self layer, avoiding an origin-orbit of that placement matrix;
 *   - flame shader paint is a direct sibling and therefore records the binding for sub-layer maintenance to mirror.
 *
 * Bobs use global x as their stable row phase. A node built in a hidden hatch and later revealed must anchor to the
 * same document-timeline phase as a node built visibly, or identical intent rows phase-drift merely because their
 * dialogs had different visibility histories.
 *
 * Cached contexts are the incremental walk contract. `lastCtxRef` enables the cheap reference check in traversal;
 * the scalar fields provide the defensive field-by-field check when a parent rebuilt an equal context object. The
 * comparison intentionally excludes parentWidth from ctxUnchanged for historical skip-clean compatibility, but the
 * affine-only path includes it: width changes feed spread placement and are not an affine-only operation.
 *
 * A transform pin is allowed to ignore streamed ancestor geometry only. It cannot ignore a tint change, because a
 * Godot tween may animate position and modulate together. Pin repair therefore creates a fresh hybrid context:
 * current paint identity and tint, retained parent matrices and retained spread budget. It must be a fresh object;
 * mutating a shared context would make a subsequent reference check accept stale tint data.
 *
 * Shader and particle geometry are attributes rather than renderer-state fields because gsw consumes them from DOM:
 *
 *   - shader uv windows live on the shader self layer;
 *   - particle visible rects live on the outer particle runtime marker.
 *
 * They run on both ordinary and ancestor-affine paths. Both values depend on rendered global position, so skipping
 * them when an emitter rides a scrolling ancestor leaves stale effect canvases even though no streamed child node
 * changed. Particle rectangles stay quantized in the pure helper, which prevents a reconcile for every pixel move.
 *
 * Sub-layer construction necessarily precedes the particle stamp. A particle self mount is the predicate proving a
 * real gsw binding exists; stamping before it would mark gsw dirty for a hidden-deferred or dieted node that has no
 * consumer. The renderer keeps that call order around updateSubLayers, while this controller supplies only the stamp.
 *
 * Full and incremental ordering deliberately share `applyChildOrder`. The canonical sequence is:
 *
 *   optional shared ribbon canvas
 *   behind-parent children
 *   the parent's own paint sublayers
 *   ordinary children
 *
 * Full walks collect child elements in visit order. Incremental walks retain existing order for existing elements,
 * append only an element that was just created or reparented, and synchronously reorder the affected parent before
 * returning. That synchronous repair is required because sublayers choose their slot using behindCount; a newly
 * appended behind child otherwise leaves own paint transiently on the wrong side of that child.
 *
 * Targeted order uses current getter ports to recreate the same behind-first visit order as a full collection. The
 * stage is a special null owner: roots are already in producer order and do not receive a behind split. Parents
 * without a live element need no work. An unmapped connected parent is not guessed at; it requests the renderer's
 * defensive full-walk fixup, exactly as the pre-extraction implementation did.
 *
 * `needsOwnEl` is pure policy only. Whether a node with children receives a grouping element belongs to producesEl
 * in the renderer, and whether a hidden child is deferred belongs to dormancy. Keeping those decisions outside this
 * module prevents DOM mechanics from quietly taking over recursion or structural reachability.
 */

export function createNodeController(p: NodeControllerPorts): NodeController {
  let elToRecord = new WeakMap<HTMLElement, RenderRecord>();
  let orderedKids: Map<HTMLElement, HTMLElement[]> | null = null;
  const pendingReorderParents = new Set<HTMLElement>();

  // A record is intentionally initialized in one literal, rather than progressively assembled by the consumers that
  // own individual pieces of paint. The renderer is permitted to retain a no-element record, adopt a parked one,
  // and revisit it through a fast path; every one of those paths expects the same sentinel values from first sight.
  //
  // Grouping of the fields below mirrors their ownership, not an attempt to encode renderer policy here:
  //
  //   identity/context    are read by traversal and ElementLifecycle;
  //   placement/visibility are written by traversal but remain retained across a skip;
  //   style/attribute maps are the DOM dirty caches;
  //   self/sub-layer fields are maintained by the specialized paint leaves;
  //   animation/tween fields belong to their respective controller and are reset by lifecycle;
  //   texture/spine/trail fields retain asynchronous paint state until lifecycle retirement.
  //
  // Keeping the constructor here does not grant the controller authority to update those fields. It only provides
  // a complete blank record to the traversal that selected this id, exactly as the inline constructor did before
  // extraction. In particular it does not inspect nodes, child ids, dormancy, or any scene policy.
  //
  // `haveCtx` gates every cached context field so zero and null remain valid first-walk values. `childCtx` and
  // `lastCtxRef` begin null because traversal, not this module, decides when it is safe to reuse a child context.
  //
  // `dormant` means the record represents a node whose DOM was deliberately not built. It is distinct from an
  // invisible DOM element: dormant records have no element to order or stamp, but still preserve enough context to
  // be rebuilt when their visibility boundary opens. This controller never decides when to set the marker.
  //
  // `builtWhileHidden` is likewise only a retained fact. The renderer uses it to request a reveal-time animation
  // re-anchor; the initial false value prevents a normal visible construction from paying that path.
  //
  // Attribute singleton caches use null, not an empty string, because absence is meaningful for gsw runtime markers.
  // Style maps are per record: sharing even empty maps would let one node's first write suppress another's write.
  //
  // The sublayer arrays are empty rather than null because ordering can iterate a record before it paints anything.
  // This gives full ordering a uniform answer for transform-only grouping elements and paint-bearing elements alike.
  //
  // Async handles are all null/false at birth. Lifecycle owns their retirement and is allowed to call it for a
  // partially built record, so every field must be safe for a teardown that happens before any corresponding mount.
  //
  // Tween sentinels keep an inactive channel distinguishable from a real transition that happens to have duration
  // zero. The controller does not interpret those channels; it simply preserves their initialized shape.
  //
  // This literal is intentionally verbose. Adding a record field without assigning its blank value causes a type
  // error here, instead of a latent branch-dependent stale-state failure after element adoption or dormant rebuild.
  function newRecord(id: string): RenderRecord {
    return {
      id,
      el: null,
      lastNode: null,
      adoptKey: null,
      haveCtx: false,
      childCtx: null,
      lastCtxRef: null,
      cDomParent: null,
      cTintR: 0,
      cTintG: 0,
      cTintB: 0,
      cInv: null,
      cParentGlobal: null,
      cParentDx: 0,
      cDeltaParentWidth: 0,
      cAnchorDelta: 0,
      cParentDxProp: false,
      cRideDx: 0,
      cContainerChildAlign: null,
      cContainerChildVertical: false,
      cParentWidth: 0,
      cContentScope: null,
      cAncestorHidden: false,
      spreadDx: 0,
      spreadFieldMode: 0,
      spreadW: 0,
      raiseDy: 0,
      raiseTransition: null,
      behindCount: 0,
      dormant: false,
      builtWhileHidden: false,
      occluded: false,
      occlusionSuspended: false,
      staticBgSuspended: false,
      paintSuppressed: false,
      style: new Map(),
      attrs: new Map(),
      attrNodeType: null,
      attrSpreadDx: null,
      attrPaints: null,
      attrSpreadW: null,
      attrSpreadMode: null,
      selfLayer: null,
      selfLayerStyle: new Map(),
      subLayers: [],
      animSelf: null,
      animSelfStyle: new Map(),
      animSelfWrapsPaint: false,
      staticAnimBinding: null,
      pinnedLoopStash: null,
      pinnedLoopTarget: null,
      flameBinding: null,
      shaderSelfFlamed: false,
      pinnedLoopSig: null,
      shaderSelf: null,
      shaderSelfFit: null,
      shaderSelfTex: null,
      shaderSelfWindow: null,
      atlasCanvas: null,
      atlasKey: null,
      atlasPlacementKey: null,
      atlasPaint: "none",
      atlasRegionDiv: null,
      atlasPageCropSig: null,
      atlasCanvasReverts: 0,
      intentKey: null,
      intentStartMs: 0,
      intentShownFrame: -1,
      intentView: null,
      intentStrip: null,
      intentStripKey: null,
      intentStripPlacementKey: null,
      intentStripPaused: false,
      intentStripAnchorMs: 0,
      intentImg: null,
      intentImgKey: null,
      lineDiv: null,
      linePolyline: null,
      lineSig: null,
      trailDiv: null,
      trailPaths: [],
      trailGradient: null,
      trailStops: [],
      trailPoints: null,
      trailFrame: null,
      trailInv: null,
      trailProfile: null,
      trailD: "",
      atlasBlobKey: null,
      atlasBlobUrl: null,
      trailPaintedAtMs: 0,
      trailAgedPending: false,
      trailRepaintDeferred: false,
      trailGradTailSig: "",
      trailGradHeadSig: "",
      trailStopSigs: [],
      trailBandOpacitySig: null,
      trailBandsPainted: 0,
      trailStandingBboxArea: 0,
      particleSelf: null,
      particleRectAttr: null,
      spineLayer: null,
      spineImg: null,
      spineImgUrl: null,
      spinePromoted: false,
      spinePendingStillUrl: null,
      spineShownStill: null,
      spineStillUrlsSeen: null,
      spineDying: false,
      spineCanvas: null,
      spineCtx: null,
      spineAnim: null,
      spineSkin: null,
      spineMat: null,
      spineSkelPath: null,
      spineStill: false,
      spineStillT: null,
      spineRetried: false,
      spineSkelRetried: false,
      spineClip: null,
      spineLooping: true,
      spinePaused: false,
      spineSyncNode: null,
      spineSyncTrackMs: 0,
      spineSyncWallMs: 0,
      spineShownFrame: -1,
      spinePlacementKey: null,
      spineStillPainted: false,
      spineAnimatedShown: false,
      spineArtPainted: false,
      placeholderImg: null,
      placeholderKey: null,
      placeholderArmedMs: null,
      placeholderTimer: null,
      placeholderFailed: false,
      bakedStillImg: null,
      bakedStillKey: null,
      geoclipState: null,
      geoclipDisabled: false,
      npSlices: [],
      npSliceStyles: [],
      rangeFill: null,
      rangeWidth: null,
      textDiv: null,
      textStyleCache: new Map(),
      textInner: null,
      lastText: null,
      lastHtml: null,
      tweenTransform: null,
      tweenTransformOrigin: null,
      tweenTransformUntil: 0,
      tweenTransformTransition: null,
      tweenTransformArmGeneration: 0,
      raiseTransitionUntil: 0,
      raiseArmFromLocalY: null,
      tweenTransformSettleEndG6: null,
      tweenTransformEndG6: null,
      tweenPreArmLinear: null,
      tweenPinStreamed: null,
      tweenPinCatchup: null,
      tweenPinCatchupOrigin: null,
      tweenTransformParentId: undefined,
      parityWatchTransform: null,
      parityWatchUntil: 0,
      parityWatchParentId: null,
      tweenOpacity: null,
      tweenOpacityUntil: 0,
      tweenOpacityTransition: null,
      tweenSelfOpacity: null,
      tweenSelfOpacityUntil: 0,
      tweenSelfOpacityTransition: null,
      tweenGroup: null,
      hideLatchedUntil: 0,
      hideLatchRestingSig: null,
      hideLatchHeldAt: 0,
      hideLatchStreamedOpacity: null,
      gDesign: null
    };
  }

  function ownerOf(el: HTMLElement): RenderRecord | undefined {
    return elToRecord.get(el);
  }

  function registerElement(el: HTMLElement, record: RenderRecord): void {
    elToRecord.set(el, record);
  }

  function unregisterElement(el: HTMLElement): void {
    elToRecord.delete(el);
  }

  // Every attribute/class on a node's element that derives from its node id must be refreshed on adoption too.
  function stampIdentityAttrs(el: HTMLElement, id: string, node: MirrorNode): void {
    p.stampIdentity(el, id, node);
  }

  // Intent BOB phases from the baked global x so sibling intent leaves ripple and a hidden-hatched node re-anchors
  // to the same document-timeline phase when revealed.
  function bobPhaseMs(binding: PresentationAnimationBinding, gNode: Affine): number {
    const period = binding.durationMs || 2000;
    return ((((gNode[4] / MIRROR_DESIGN_WIDTH) * period) % period) + period) % period;
  }

  // The outer element carries the baked placement matrix. That makes animation routing non-interchangeable:
  // applying rotate to the outer element would rotate its translation around the stage origin, visibly orbiting an
  // icon instead of spinning it in place. Rotation and flame loops therefore target the local self layer, while bob
  // is an origin-independent translate and can compose on the outer element without moving its pivot.
  //
  // The self layer is not appended here. DomSubLayers owns its exact position among paint layers and children, which
  // is what preserves a show-behind-parent child below own paint. createEl establishes animation state only; the
  // traversal's normal sublayer call establishes DOM placement afterwards.
  //
  // Direct outer-element writes are intentional for bob and remote follower transitions. Those values are not part
  // of the normal style cache, so an ordinary streamed restyle cannot remove or restart a compositor animation. The
  // same separation protects geometry epoch accounting: geometry reads cached placement, not cosmetic channels.
  //
  // A flame binding is retained because shader paint is a direct sibling of the animated self layer. The later
  // sublayer operation mirrors that binding only if the shader mount exists, preserving the fallback path when a
  // shader is deferred, dieted, or unavailable.
  function createEl(record: RenderRecord, id: string, node: MirrorNode, gNode: Affine, structuralOnly = false): void {
    p.stats.createEl++;
    const el = document.createElement("div");
    el.className = "mirror-node";
    el.setAttribute("data-node-type", node.nodeType);
    stampIdentityAttrs(el, id, node);
    if (!structuralOnly && nodeTypeLeaf(node.nodeType) === CARD_FLIGHT_VFX_TYPE) p.cardFlights().addVfxId(id);

    let animBinding = structuralOnly ? null : nodeAnimBinding(p.computeSceneInfo(id)?.relPath ?? null, node.nodeType);
    if (animBinding) {
      ensureAnimationStyles(document);
      record.staticAnimBinding = animBinding;
      if (animBinding.kind === "bob") {
        applyAnimationBinding(el, animBinding, { compose: true });
        p.anchorAnimations(el, -bobPhaseMs(animBinding, gNode));
      } else {
        const animSelf = p.ensureAnimSelf(record);
        applyAnimationBinding(animSelf, animBinding);
        // A flame shader paints in a direct sibling of animSelf, so sub-layer maintenance applies this binding there.
        if (animBinding.kind === "flameFlicker") record.flameBinding = animBinding;
      }
    }
    // Remote followers stream fresh transforms but no tween hints; keep their direct transition out of the style cache.
    if (!structuralOnly && isRemoteFollower(node)) el.style.transition = "transform 80ms linear";
    record.el = el;
    registerElement(el, record);
  }

  function setCachedCtx(record: RenderRecord, ctx: WalkCtx): void {
    record.haveCtx = true;
    record.lastCtxRef = ctx;
    record.cDomParent = ctx.domParent;
    record.cTintR = ctx.tint.r;
    record.cTintG = ctx.tint.g;
    record.cTintB = ctx.tint.b;
    record.cInv = ctx.parentInv;
    record.cParentGlobal = ctx.parentGlobal;
    record.cParentDx = ctx.parentDx;
    record.cDeltaParentWidth = ctx.deltaParentWidth;
    record.cAnchorDelta = ctx.anchorDelta;
    record.cParentDxProp = ctx.parentDxProp;
    record.cRideDx = ctx.rideDx;
    record.cContainerChildAlign = ctx.containerChildAlign;
    record.cContainerChildVertical = ctx.containerChildVertical;
    record.cParentWidth = ctx.parentWidth;
    record.cContentScope = ctx.contentScope;
    record.cAncestorHidden = ctx.ancestorHidden;
  }

  function ctxUnchanged(record: RenderRecord, ctx: WalkCtx): boolean {
    return record.haveCtx &&
      record.cDomParent === ctx.domParent &&
      record.cTintR === ctx.tint.r && record.cTintG === ctx.tint.g && record.cTintB === ctx.tint.b &&
      affineEqual(record.cInv, ctx.parentInv) && affineEqual(record.cParentGlobal, ctx.parentGlobal) &&
      record.cParentDx === ctx.parentDx && record.cDeltaParentWidth === ctx.deltaParentWidth &&
      record.cAnchorDelta === ctx.anchorDelta && record.cParentDxProp === ctx.parentDxProp &&
      record.cRideDx === ctx.rideDx && record.cContainerChildAlign === ctx.containerChildAlign &&
      record.cContainerChildVertical === ctx.containerChildVertical &&
      record.cContentScope === ctx.contentScope &&
      record.cAncestorHidden === ctx.ancestorHidden;
  }

  function pinTintChanged(record: RenderRecord, ctx: WalkCtx): boolean {
    return record.cTintR !== ctx.tint.r || record.cTintG !== ctx.tint.g || record.cTintB !== ctx.tint.b;
  }

  // A pin tint repair takes fresh paint identity but deliberately retains the cached geometry and spread budget.
  function pinRepairCtx(record: RenderRecord, ctx: WalkCtx): WalkCtx {
    return {
      domParent: ctx.domParent,
      tint: ctx.tint,
      parentInv: record.cInv,
      parentGlobal: record.cParentGlobal ?? ctx.parentGlobal,
      parentDx: record.cParentDx,
      deltaParentWidth: record.cDeltaParentWidth,
      anchorDelta: record.cAnchorDelta,
      parentDxProp: record.cParentDxProp,
      rideDx: record.cRideDx,
      parentWidth: record.cParentWidth,
      pinnedAncestor: true,
      containerChildAlign: ctx.containerChildAlign,
      containerChildVertical: ctx.containerChildVertical,
      inCardRewardScreen: ctx.inCardRewardScreen,
      contentScope: ctx.contentScope,
      ancestorHidden: ctx.ancestorHidden
    };
  }

  // Strictly affine-only ancestor movement: all paint/context inputs match, while at least one parent matrix moved.
  function ctxAffineOnlyChanged(record: RenderRecord, ctx: WalkCtx): boolean {
    return record.haveCtx &&
      record.cDomParent === ctx.domParent &&
      record.cTintR === ctx.tint.r && record.cTintG === ctx.tint.g && record.cTintB === ctx.tint.b &&
      record.cParentDx === ctx.parentDx && record.cDeltaParentWidth === ctx.deltaParentWidth &&
      record.cAnchorDelta === ctx.anchorDelta && record.cParentDxProp === ctx.parentDxProp &&
      record.cRideDx === ctx.rideDx && record.cParentWidth === ctx.parentWidth &&
      record.cContainerChildAlign === ctx.containerChildAlign &&
      record.cContainerChildVertical === ctx.containerChildVertical &&
      record.cContentScope === ctx.contentScope &&
      record.cAncestorHidden === ctx.ancestorHidden &&
      !(affineEqual(record.cInv, ctx.parentInv) && affineEqual(record.cParentGlobal, ctx.parentGlobal));
  }

  // The shader window is a self-layer attribute because gsw renders that canvas; it must also run on affine fast paths.
  function syncShaderUvWindow(record: RenderRecord, node: MirrorNode, gNode: Affine): void {
    if (!record.shaderSelf) return;
    const win = visibleUvWindow(node, gNode, MIRROR_DESIGN_WIDTH * p.spreadFactor());
    const attr = win ? uvWindowAttr(win) : null;
    if (record.shaderSelfWindow === attr) return;
    if (attr) record.shaderSelf.setAttribute("data-godot-shader-uv-window", attr);
    else record.shaderSelf.removeAttribute("data-godot-shader-uv-window");
    record.shaderSelfWindow = attr;
    p.markShaderDirty();
  }

  // The particle window belongs on the outer runtime marker. Quantization lives in particleVisibleRect, avoiding
  // a gsw reconcile for every sub-16px move while preserving the sublayer-before-particle-stamp call order.
  function syncParticleVisibleRect(
    record: RenderRecord,
    node: MirrorNode,
    gNode: Affine,
    drawBox: { x: number; y: number } | null
  ): void {
    if (!record.particleSelf || !record.el) return;
    const rect = node.particleSpec && drawBox
      ? particleVisibleRect(gNode, drawBox, { width: MIRROR_DESIGN_WIDTH * p.spreadFactor(), height: MIRROR_DESIGN_HEIGHT })
      : null;
    const attr = rect ? particleVisibleRectAttr(rect) : null;
    if (record.particleRectAttr === attr) return;
    if (attr) record.el.setAttribute("data-godot-particle-visible-rect", attr);
    else record.el.removeAttribute("data-godot-particle-visible-rect");
    record.particleRectAttr = attr;
    p.markParticleDirty();
  }

  // Full walks collect visit order; incremental walks append only new/reparented elements, then repair just affected parents.
  function placeEl(record: RenderRecord, ctx: WalkCtx, structural: boolean): void {
    const el = record.el!;
    if (structural) {
      let kids = orderedKids!.get(ctx.domParent);
      if (!kids) orderedKids!.set(ctx.domParent, kids = []);
      kids.push(el);
    } else if (el.parentElement !== ctx.domParent) {
      ctx.domParent.appendChild(el);
      pendingReorderParents.add(ctx.domParent);
    }
  }

  // Keep the parent paint invariant: behind children, own sublayers, ordinary children.
  function applyChildOrder(parent: HTMLElement, kids: HTMLElement[], owner: RenderRecord | undefined): void {
    // Prefix-only insertion deliberately leaves non-mirror stage children after the mirror roots. MirrorView's slot
    // controls rely on that paint order; a static background opts out through its own negative z-index rather than
    // by becoming an untracked participant in this sequence.
    //
    // `behindCount` was computed by traversal from children that will actually have elements. It is not recalculated
    // here: doing so would duplicate dormancy and producesEl policy, and could disagree during a partial hatch.
    // The controller consumes the count as a placement fact and gives both full and targeted paths the same layout.
    const desired: HTMLElement[] = [];
    const behindCount = owner?.behindCount ?? 0;
    for (let i = 0; i < behindCount && i < kids.length; i++) desired.push(kids[i]);
    for (const layer of owner?.subLayers ?? EMPTY_ELS) desired.push(layer);
    for (let i = behindCount; i < kids.length; i++) desired.push(kids[i]);
    for (let i = 0; i < desired.length; i++) {
      const ref = parent.children[i] ?? null;
      if (ref !== desired[i]) parent.insertBefore(desired[i], ref);
    }
  }

  function desiredKidsInVisitOrder(ownerId: string | null): HTMLElement[] {
    const nodes = p.nodes();
    const records = p.records();
    const out: HTMLElement[] = [];
    if (ownerId === null) {
      for (const id of p.rootIds()) {
        if (!nodes.has(id)) continue;
        const el = records.get(id)?.el;
        if (el) out.push(el);
      }
      return out;
    }
    const ids = p.childIds().get(ownerId);
    if (!ids) return out;
    for (const behind of [true, false]) {
      for (const id of ids) {
        const node = nodes.get(id);
        const el = records.get(id)?.el;
        if (node && node.showBehindParent === behind && el) out.push(el);
      }
    }
    return out;
  }

  function beginFullOrder(): void {
    orderedKids = new Map();
  }

  function reconcileFullOrder(): void {
    if (!orderedKids) return;
    for (const [parent, kids] of orderedKids) applyChildOrder(parent, kids, ownerOf(parent));
  }

  function clearFullOrder(): void {
    orderedKids = null;
  }

  function clearPendingReorders(): void {
    pendingReorderParents.clear();
  }

  // Targeted incremental counterpart of full ordering. An unmapped connected parent requests the renderer's full-walk fixup.
  function reorderChangedParents(input: TargetedReorderInput): { fixupNeeded: boolean } {
    // One parent may be named by a structure diff and also by a just-appended child. The local set ensures that it is
    // rebuilt once, avoiding redundant DOM moves while still processing all independently affected parents.
    //
    // A removed parent may still occur in the diff. Its record no longer has an element, which is a normal no-op;
    // only a connected element with no owner is anomalous enough to request a conservative full reconstruction.
    let fixupNeeded = false;
    const done = new Set<HTMLElement>();
    const reorderOwner = (parent: HTMLElement): void => {
      if (done.has(parent)) return;
      done.add(parent);
      if (parent === p.stage) {
        applyChildOrder(parent, desiredKidsInVisitOrder(null), undefined);
        p.stats.reorderedParents++;
        return;
      }
      const owner = ownerOf(parent);
      if (!owner || owner.el !== parent) {
        if (parent.isConnected) fixupNeeded = true;
        return;
      }
      if (!p.nodes().has(owner.id)) return;
      applyChildOrder(parent, desiredKidsInVisitOrder(owner.id), owner);
      p.stats.reorderedParents++;
    };
    if (input.rootsOrderDirty) reorderOwner(p.stage);
    for (const id of input.orderDirtyParents) {
      const el = p.records().get(id)?.el;
      if (el) reorderOwner(el);
    }
    for (const el of pendingReorderParents) reorderOwner(el);
    return { fixupNeeded };
  }

  // A node with children may still need a grouping element; that traversal decision remains in mirrorRenderer.
  function needsOwnEl(node: MirrorNode): boolean {
    return node.localRect != null || node.text != null || node.clipChildren > 0 ||
      node.particleSpec != null || node.linePoints != null ||
      isCardTrailNode(node) || isSpineSurfaceNode(node);
  }

  // Disposal deliberately follows elementLifecycle plus the renderer's removeEl sweep, so teardown can still map owners.
  function dispose(): void {
    orderedKids = null;
    pendingReorderParents.clear();
    elToRecord = new WeakMap();
  }

  return {
    newRecord, ownerOf, registerElement, unregisterElement, stampIdentityAttrs, bobPhaseMs, createEl,
    setCachedCtx, ctxUnchanged, pinTintChanged, pinRepairCtx, ctxAffineOnlyChanged,
    syncShaderUvWindow, syncParticleVisibleRect, placeEl, beginFullOrder, reconcileFullOrder,
    clearFullOrder, clearPendingReorders, reorderChangedParents, needsOwnEl, dispose
  };
}
