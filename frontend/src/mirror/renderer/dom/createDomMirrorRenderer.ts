// Imperative, delta-driven DOM reconciler for the live-tree MIRROR's hot path. Replaces the per-tick Vue
// re-render of the mirror stage (MirrorNodeView v-for over a freshly-rebuilt RenderItem tree) — which was
// O(total nodes) of VNode allocation + diff every ~60Hz frame — with a retained-mode renderer that mutates only
// the elements whose output actually changed.
//
// Two free incremental signals from the retained state make this O(changed-subtrees) per frame:
//   - `applySceneDelta` replaces ONLY upserted node objects, so `record.lastNode === node` (object identity)
//     means "this node is unchanged this tick".
//   - `state.orderedIds` is reassigned by REFERENCE only on structural deltas (full/add/remove/reorder), so
//     `state.orderedIds !== lastOrderedIds` means "the structure changed".
// On a volatile-only delta we walk, and as soon as a node's object identity AND its inherited context (parent
// opacity/tint/z/clip-inverse/dom-parent/hidden) both match the last applied values, we skip it AND its whole
// subtree without touching the DOM.
//
// The DOM model matches the old Vue renderer exactly: a mostly-FLAT list of `.mirror-node` elements under the
// stage (global transforms baked per node, effective z composed down the chain), with ONLY `clip_children`
// subtrees NESTED inside their clipper element (placed relative to it via the clip matrix inverse). Per-node
// styling/attributes/sub-layers reuse the same pure helpers the Vue components used (nodeStyle, textStyle,
// nodeShaderAttributes, nodeParticleAttributes, …) so their unit tests stay authoritative.
//
// Self-contained per the mirror decoupling rule: gsw + `@/mirror/*` only.

import { EFFECTS_SUSPENDED_ATTR } from "@godot-scene-web/html";
import { affineMul, cssLinear2x2, IDENTITY_AFFINE, type Affine } from "@/mirror/affine";
import {
  trailPhaseProbe,
  type TrailPhase,
  type TrailPhaseStroke
} from "@/mirror/cardTrail";
import { registerPressureSource } from "@/mirror/framePressure";
import {
  installHandPoseProbe,
} from "@/mirror/handPoseProbe";
import {
  createLandingLog,
  installLandingLogProbe,
  type LandingLogReport,
  type LandingProbe
} from "@/mirror/landingLog";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import {
  nodePlacementTransform,
  type RenderItem
} from "@/mirror/nodeStyles";
import {
  resetShaderDocCache,
} from "@/mirror/shaderAttributes";
import { designPx, layoutScale } from "@/mirror/stageFit";
import { createMapLineMasks } from "@/mirror/renderer/dom/mapLineMasks";
import { createSvgDefsRegistry } from "@/mirror/renderer/dom/svgDefsRegistry";
// THE SPREAD ALGEBRA lives in its own pure module so the canvas backend can place every node on the SAME squeeze
// field this walk does (see spreadLayout.ts's header). Aliased on import because this closure keeps thin wrappers
// of the same names that bind the live `spreadFactor`.
import {
  fieldDxAtGlobal,
  spreadDrawBox as spreadDrawBoxOf,
  type SpreadAffine,
  type SpreadBox
} from "@/mirror/spreadLayout";
import {
  resolveTextScaleClasses,
  syncTextScaleSheet,
  TEXT_SCALE_CLASS_PREFIX
} from "@/mirror/textScaleClasses";
// Geoclip playback. Statically imported so the type-checker and tests
// see one module graph; its top level does nothing but read a couple of query params, and with the flag off not
// one function below is ever called — no probe, no fetch, no GL context, no element.
import { renderQuality } from "@/render/quality";
import {
  nodeTypeLeaf,
  type MirrorNode,
  type MirrorState
} from "@/mirror/sceneTree";
import type {
  FullWalkCause,
  MirrorRenderer
} from "@/mirror/renderer/contracts";
import { domSpreadPainterAt, domTouchStackAt, mapPointElementIdAt } from "@/mirror/renderer/domHitProbes";
import { rewardFocusSnapshotFromScene } from "@/mirror/rewardFocusSnapshot";
import { isCombatPileContainer } from "@/mirror/renderer/interactionPolicy";
import {
  isCombatBackgroundScenePath,
  isCombatBackgroundSceneRoot,
  isStaticBackgroundSuppressibleRoot,
  staticBgTargetPathOf,
} from "@/mirror/renderer/staticBackgroundPolicy";
import {
  mirrorWalkStats,
  sampleBlendCensus,
} from "@/mirror/renderer/walkStats";
import {
  HAND_HOLDER_TYPE
} from "@/mirror/raise/constants";
import { isCreatureHudGroup } from "@/mirror/raise/creatureHud";
import { EMPTY_CHILDREN } from "@/mirror/raise/handRaisePlan";
import { createScaleController, type ScaleController } from "@/mirror/renderer/dom/scaleController";
import { createHandController } from "@/mirror/renderer/dom/handController";
import { createNodeController } from "@/mirror/renderer/dom/nodeController";
import { createNodeWalker, type NodeWalker } from "@/mirror/renderer/dom/nodeWalker";
import { createReconcileController, type ReconcileController } from "@/mirror/renderer/dom/reconcileController";

const STATIC_BG_HOLD_EXPIRED = -1;
const STATIC_BG_HOLD_MAX_MS = 8000;
import type { RenderRecord } from "@/mirror/renderer/dom/recordModel";
import { FX_DIRTY_SHADER, FX_DIRTY_PARTICLE } from "@/mirror/renderer/dom/style";
import { cancelParityWatch } from "@/mirror/renderer/dom/handParity";
import { createTickScheduler, type TickScheduler } from "@/mirror/renderer/dom/tickScheduler";
import { createIntentTimeline } from "@/mirror/renderer/dom/intentTimeline";
import { createSpineGeoclipTimeline, type SpineGeoclipTimeline } from "@/mirror/renderer/dom/spineGeoclipTimeline";
import { createSpineLayerController } from "@/mirror/renderer/dom/spineLayerController";
import { createDomSubLayers } from "@/mirror/renderer/dom/subLayers";
import { createCardTrailController, type CardTrailController } from "@/mirror/renderer/dom/cardTrailController";
import { createCardFlightController } from "@/mirror/renderer/dom/cardFlightController";
import { createTweenController, type TweenController } from "@/mirror/renderer/dom/tweenController";
import { createEffectsDirtiness } from "@/mirror/renderer/dom/effectsDirtiness";
import { createSceneIdentity } from "@/mirror/renderer/dom/sceneIdentity";
import { createStaticBackgroundRuntime } from "@/mirror/renderer/dom/staticBackgroundRuntime";
import { createAnimationRuntime } from "@/mirror/renderer/dom/animationRuntime";
import { createOcclusionRuntime, type OcclusionRuntime } from "@/mirror/renderer/dom/occlusionRuntime";
import { createInteractionController } from "@/mirror/renderer/dom/interactionController";
import { createDormancyLifecycle } from "@/mirror/renderer/dom/dormancyLifecycle";
import {
  computeAdoptKey as computeLifecycleAdoptKey,
  createElementLifecycle,
} from "@/mirror/renderer/dom/elementLifecycle";
// --- the reconciler ---------------------------------------------------------------------------------------

function createMirrorRenderer(stage: HTMLElement, defs: SVGElement): MirrorRenderer {
  const records = new Map<string, RenderRecord>();
  let tickScheduler: TickScheduler | null = null;
  function scheduleTick(): void {
    tickScheduler?.schedule();
  }
  let trails!: CardTrailController;
  /**
   * THE COMET'S PHASE (R5 T-DR5) — `window.__mirrorTrailProbe()`, the DOM half.
   *
   * A trail is a DECAYING record of motion: every point dies 800 ms after it was laid down, so two clients
   * stopped at "the same" recorded millisecond are not showing the same picture unless their histories are also
   * the same AGE. Nothing on either arm published an age, and the round-4 crop comparison duly put a canvas
   * ribbon at one phase of its decay beside a DOM ribbon at another and reported the difference as fidelity.
   *
   * The canvas backend installs the same name from the same pure function (`cardTrail.trailPhaseProbe`), so the
   * harness's cross-arm gate cannot be satisfied by two matching bugs. This one walks the render records; that
   * one walks its integrator's strokes; neither restates the measurement.
   */
  function trailProbe(): TrailPhase {
    const strokes: TrailPhaseStroke[] = [];
    for (const [id, record] of records) {
      if (record.trailPoints !== null) {
        strokes.push({ id, points: record.trailPoints });
      }
    }
    return trailPhaseProbe(strokes, performance.now());
  }

  if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).__mirrorTrailProbe = () => trailProbe();
  }
  // …and the HAND POSE seam, under the name the canvas backend installs from its own walk. A harness asks the page
  // where the hand is drawn without knowing (or caring) which stage answered — see handPoseProbe.ts.
  const handPoseOwner = {};
  installHandPoseProbe(() => handController.handPoses(), handPoseOwner);
  /**
   * …and the INTENDED-LANDING log, this arm's half of `landingLog.ts`. It answers a different question from the
   * seam above: not "is the hand drawn right, now" (a client rescued by the producer's settle re-emit passes that
   * at rest) but "did this backend pick the right place to send the card in the first place".
   */
  const landingLog = createLandingLog();
  const landingProbe: LandingProbe = {
    // INLINE, NOT COMPUTED — the one place this backend deliberately does not measure the painted frame. The walk
    // that adopts the producer's settled pose writes it as an inline transform while the arm's CSS transition may
    // still be running, so `getComputedStyle` here would report the interpolation on the way to the landing rather
    // than the landing. The canvas arm has no transition to be caught inside, and its `capturedGlobals.drawn` is
    // likewise the pose the build decided on — reading the committed value is what makes the two comparable.
    drawnGlobal: (id) => {
      const el = records.get(id)?.el;
      return el ? drawnGlobalOfElement(el, true) : null;
    },
    raiseDy: (id) => records.get(id)?.raiseDy ?? 0,
    channelLive: (id) => {
      const record = records.get(id);
      return record != null && (record.tweenTransformUntil > nowMs() || record.tweenPinCatchup != null);
    },
    streamedTransform: (id) => reconcileController.nodes().get(id)?.transform ?? null,
    // The same composition `handPoses` calls `mGame`: the producer's word, blind to every override. A node the
    // producer is suppressing ships none, and then where its parent is IS where the walk would draw it.
    streamedGlobal: (id) => {
      const record = records.get(id);
      const own = reconcileController.nodes().get(id)?.transform;
      if (!record) {
        return null;
      }
      return own != null ? liftEndpointToGlobal(record, own) : (record.cParentGlobal ?? null);
    }
  };
  /** A READ IS ALSO A TICK — rows close on walks, and a settled screen produces none. See the canvas twin. */
  function landingLogReport(): LandingLogReport {
    landingLog.tick(nowMs(), landingProbe);
    return {
      stage: "dom",
      spreadFactor: reconcileController.spreadFactor(),
      openCount: landingLog.openCount(),
      rows: landingLog.rows()
    };
  }
  installLandingLogProbe(landingLogReport, handPoseOwner);

  const svgDefs = createSvgDefsRegistry(defs);
  // Per-renderer state: ids are stream-local and cannot survive a stage replacement.
  const lineMasks = createMapLineMasks(defs, (id) => records.get(id));

  // Constructed once all late collaborators are wired. Every early consumer below is a lazy getter, so no
  // initialization-order placeholder can observe it before this assignment.
  let reconcileController!: ReconcileController;

  // ---- R10-PERF4 WS-2: effects-dirty bookkeeping (see consumeEffectsDirty) ---------------------------------
  //
  // Set by EVERY site that can change what gsw's runtime selectors would find (or what their per-node reconcile
  // would re-read): the effect-marker attribute writes in applyAttrs, the shaderSelf / particleSelf sub-layer
  // create+remove+attr sites, element teardown (removeEl) and adoption, the occlusion suspend/resume writes, and
  // — conservatively, one store each — every structural walk. Read+cleared by consumeEffectsDirty.
  const effectsDirtiness = createEffectsDirtiness(FX_DIRTY_SHADER, FX_DIRTY_PARTICLE);
  const markEffectsDirty = () => effectsDirtiness.markAll();
  const markEffectsDirtyBits = (bits: number) => effectsDirtiness.markBits(bits);
  const animationRuntime = createAnimationRuntime();
  const {
    anchorAnimations,
    clearPhaseAnchors,
    syncNinePatchSlices: syncNpSlices
  } = animationRuntime;
  const staticBgRuntime = createStaticBackgroundRuntime<RenderRecord>({
    nodes: () => reconcileController.nodes(),
    records: () => records,
    staticBgEnabled: () => mirrorSettings.staticBgEnabled,
    staticBgFailedOpen: () => mirrorSettings.staticBgFailedOpen,
    now: () => reconcileController.walkNow(),
    holdMaxMs: () => STATIC_BG_HOLD_MAX_MS,
    expiredDeadline: STATIC_BG_HOLD_EXPIRED,
    targetPath: staticBgTargetPathOf,
    isSuppressibleRoot: isStaticBackgroundSuppressibleRoot,
    isCombatPath: isCombatBackgroundScenePath,
    isCombatRoot: isCombatBackgroundSceneRoot,
    writeDisplay: writeRecordDisplay,
    markEffectsDirty,
    noteHoldExpiry: () => { mirrorWalkStats.staticBgHoldExpiries++; }
  });
  let sceneIdentity!: ReturnType<typeof createSceneIdentity>;
  let scaleController!: ScaleController;
  const interactionController = createInteractionController({
    nodes: () => reconcileController.nodes(),
    records: () => records,
    childIds: () => reconcileController.childIdsByParent(),
    orderedIds: () => reconcileController.orderedIds(),
    lastOrderedIds: () => reconcileController.lastOrderedIds(),
    geometryEpoch: () => reconcileController.geometryEpoch(),
    spreadFactor: () => reconcileController.spreadFactor(),
    raisedRectDy: () => raisedRectDy,
    handHitboxIds: () => handHitboxIds,
    computeNodePath: (id) => sceneIdentity.computeNodePath(id),
    computeSceneInfo: (id) => sceneIdentity.computeSceneInfo(id),
    computeTouchInfo: (id) => sceneIdentity.computeTouchInfo(id),
    // Construction is intentionally lazy: the scale controller needs interaction rects, while the interaction
    // controller's visual-owner query is delegated to that controller once both are live.
    resolveVisualOwnerId: (id) => scaleController.resolveVisualOwnerId(id),
    liftEndpointToGlobal,
    coverAbove: (id) => occlusionRuntime.coverAbove(id),
    setConfirmCoverWatch: (on) => occlusionRuntime.setConfirmCoverWatch(on),
    paintIndexOf: (id) => occlusionRuntime.paintIndexOf(id)
  });
  const {
    computeSceneInfo,
    isHandCard,
    handChoiceActive,
    mapDrawingToolActive,
    forEachInteractiveRect,
    ancestorChainHidden,
    hitTestShift,
    resolveVisualOwnerId,
    interactiveRects,
    endTurnBoxAt,
    eagerScrollTargets,
    applyLocalOffset,
    scrollRenderedY,
    isUnderNode,
    isCardTouchTarget,
    confirmTapTarget,
    confirmTapAt,
    coverAbove,
    setConfirmCoverWatch
  } = interactionController;
  scaleController = createScaleController({
    records: () => records,
    nodes: () => reconcileController.nodes(),
    childIds: () => reconcileController.childIdsByParent(),
    orderedIds: () => reconcileController.orderedIds(),
    spreadFactor: () => reconcileController.spreadFactor(),
    geometryEpoch: () => reconcileController.geometryEpoch(),
    geometryDirty: () => reconcileController.geometryDirty(),
    markGeometryDirty: () => reconcileController.markGeomDirty(),
    computeSceneInfo: (id) => computeSceneInfo(id),
    ancestorChainHidden,
    interactiveRects,
    forEachInteractiveRect: (cb) => forEachInteractiveRect(cb),
    liftEndpointToGlobal,
    spreadDxAtGlobal,
    syncTextScaleSheet,
  });
  sceneIdentity = createSceneIdentity({
    nodes: () => reconcileController.nodes(),
    isHandRaisable: (node) =>
      nodeTypeLeaf(node.nodeType) === HAND_HOLDER_TYPE || isCreatureHudGroup(reconcileController.nodes(), node),
    stampTextScale: (el, scene) => {
      for (let i = el.classList.length - 1; i >= 0; i--) {
        const cls = el.classList[i];
        if (cls.startsWith(TEXT_SCALE_CLASS_PREFIX)) el.classList.remove(cls);
      }
      for (const cls of resolveTextScaleClasses(scene?.file ?? null, scene?.relPath ?? null)) el.classList.add(cls);
    }
  });

  // Retained-record DOM mechanics stay in a leaf with getter ports. In particular cardFlights is initialized later,
  // so the controller resolves it only when an element is actually created rather than capturing a placeholder.
  let cardFlights!: ReturnType<typeof createCardFlightController>;
  const nodeController = createNodeController({
    stage,
    nodes: () => reconcileController.nodes(),
    records: () => records,
    childIds: () => reconcileController.childIdsByParent(),
    rootIds: () => reconcileController.rootIds(),
    computeSceneInfo: (id) => sceneIdentity.computeSceneInfo(id),
    stampIdentity: (el, id, node) => sceneIdentity.stampIdentityAttrs(el, id, node),
    cardFlights: () => cardFlights,
    ensureAnimSelf: animationRuntime.ensureAnimSelf,
    anchorAnimations,
    spreadFactor: () => reconcileController.spreadFactor(),
    markShaderDirty: () => effectsDirtiness.markShader(),
    markParticleDirty: () => effectsDirtiness.markParticle(),
    stats: mirrorWalkStats
  });
  const {
    syncShaderUvWindow,
  } = nodeController;

  // The hand controller deliberately receives callbacks, not a renderer-state bag: this reconciler replaces node
  // maps and collaborates during setup, while a held gesture can outlive a single walk.
  let handController!: ReturnType<typeof createHandController<RenderRecord>>;
  // The occlusion controller owns cover candidates, tiers, hysteresis and frozen canvases. It receives only narrow
  // renderer ports below, so the retained-record facade remains the sole owner of DOM and scene state.
  let occlusionRuntime!: OcclusionRuntime;
  // Spine's record facade is built before the playback timeline. Its explicit getter resolves the eventual live
  // timeline rather than capturing an initialization-time placeholder.
  let spineTimeline!: SpineGeoclipTimeline;
  const spineLayerController = createSpineLayerController({
    now: nowMs,
    schedule: scheduleTick,
    thaw: (canvas) => occlusionRuntime.thaw(canvas),
    timeline: () => spineTimeline
  });
  // Cache a node's rendered design global for local renderer consumers, bumping the epoch when it
  // actually moved. Compared by VALUE: `gNodeStretched` is a fresh array whenever the node carries a spread shift.
  // Can a node MOVING (or being revealed) at `id` change either epoch-cached structure? Only if the node itself, or
  // something under it, feeds one: an interactive-rect candidate, or a registered view-scale item. A parent carries
  // its descendants' globals, so the probe covers the whole subtree.
  //
  // THIS is what makes the epoch pay on a live screen: the constant per-frame traffic on an otherwise-idle screen is
  // animated DECORATION — a rotating background layer, a floating icon, an enemy-intent glyph holder — all
  // mouse-filter Ignore with no interactive descendant. They move every frame and change nothing either structure
  // reads. Parent-relative composition means the probe covers the whole subtree. Budgeted: a subtree too big to
  // prove clean cheaply is assumed to matter (a large subtree essentially always holds an interactive control
  // anyway), so the probe can never become the new hotspot.
  // --- STAGE-A "Static background" suppression --------------------------------------------------------------
  // While StaticBackground.vue CONFIRMS its host-rendered bg image (combat OR event backdrop) is shown (loaded +
  // decoded), the live bg subtree is display:none'd at its ROOT (root-only — the cascade hides the whole subtree). The
  // component owns BOTH engage conditions (setting ON via mirrorSettings.staticBgEnabled + image shown) and
  // reports them as ONE signal: the scenePath of the image currently displayed, or null (setting off / no image /
  // fetch error / unmount) — null clears every suppression, so the failure mode is always the live subtree
  // returning (fail-open). Direct display flips via writeRecordDisplay (the occlusion-gate idiom), because a
  // settled combat walks nothing; visit-time maintenance below keeps membership fresh for roots that (re)appear
  // mid-stream.
  //
  // A suppressed root ALSO declares dormancy to gsw (EFFECTS_SUSPENDED_ATTR) — `display:none` alone left every
  // shader/particle binding under it fully live. Both display writers stamp it through one helper; see
  // `applyRecordSuppression`.
  // Visit-time membership maintenance + this node's suppression answer (folded into `suppressed` in visit).
  // Fast path first: with no confirmed image, and for the overwhelming majority of nodes (no sceneFilePath),
  // this is one or two field reads.
  function staticBgSuppress(id: string, node: MirrorNode): boolean {
    return staticBgRuntime.suppress(id, node);
  }

  // Static-background build hold.
  // Ids currently HELD — folded into `visit`'s `hidden`, so the root is never built and its subtree is never even
  // recorded. Deliberately covers BOTH phases of the image's life: while it is still PENDING (the window the whole
  // change exists for) and while it is SHOWN (releasing on decode-success would build the very subtree the picture
  // replaces). Read as a SET by `childHasOrWillHaveEl` and the dormancy boundary, i.e. as "last walk's answer",
  // matching the contract those two already document.
  // Is `node` a bg scene ROOT (combat or event backdrop) whose host-rendered image we are waiting for (or already
  // showing)? Fast path first: for the overwhelming majority of nodes this is one boolean plus one field read, the
  // same cost class as `staticBgSuppress` above. The regex + parent-chain test is only ever reached by scene ROOTS.
  function staticBgHold(id: string, node: MirrorNode): boolean {
    return staticBgRuntime.hold(id, node);
  }

  // The component's confirmed-shown signal (see the MirrorRenderer interface doc). Applies immediately via
  // direct display flips — a settled scene reconciles nothing, so waiting for a walk would strand the flip.
  function setStaticBackgroundShown(scenePath: string | null): void {
    staticBgRuntime.setShown(scenePath);
  }

  // Pool/index ownership lives in a DOM leaf. The renderer deliberately supplies narrow
  // hooks for id-keyed passes rather than letting the lifecycle leaf reach back into this facade.
  const elementLifecycle = createElementLifecycle({
    records,
    nodes: () => reconcileController.nodes(),
    childIds: () => reconcileController.childIdsByParent(),
    heldCardId: () => handController.heldCardId(), heldCardEl: () => handController.heldCardEl(), heldGestureIds: () => handController.heldGestureIds(),
    thaw: (canvas) => occlusionRuntime.thaw(canvas),
    cancelParityWatch,
    removeFlight: (record) => cardFlights.removeRecord(record),
    deactivateTrail: (record) => trails.active.delete(record),
    releaseTrail: (record) => trails.release(record),
    releaseTrailFrame: (record) => trails.releaseFrame(record),
    forgetTween: (record) => tweens.forget(record),
    removeSpine: (record) => spineTimeline.remove(record),
    removeOcclusion: (id) => occlusionRuntime.removeRecord(id),
    forgetRaise: (id) => handController.forgetRecord(id),
    clearRaiseCosmetics: (record) => handController.clearCosmetics(record),
    dropViewScale: (id) => scaleController.dropViewScale(id),
    removeHoverTip: (id) => scaleController.removeHoverTip(id),
    adoptOcclusion: (from, to) => occlusionRuntime.adoptRecord(from, to),
    removeTargeting: (id) => handController.removeTargeting(id),
    stampIdentity: nodeController.stampIdentityAttrs,
    markGeomDirty: () => reconcileController.markGeomDirty(),
    markEffectsDirty,
    clearPromotion: (record) => spineTimeline.clearPromotion(record),
    unregisterElement: nodeController.unregisterElement,
    removeVisibleTooltip: (el) => handController.removeVisibleTooltip(el),
    setDormant: (record, dormant) => dormancy.setDormant(record, dormant),
    removeHandRaiseAnchor: (id) => handController.removeHandRaiseAnchor(id),
    forgetReveal: (id) => dormancy.forgetReveal(id),
    resetIntentElement: (record) => intentTimeline.resetElement(record),
    releaseLineMask: (id) => lineMasks.releaseLineMaskStroke(id),
    forgetStrokeLocal: (id) => lineMasks.forgetStrokeLocal(id),
    setSpineShownStill: spineLayerController.setShownStill,
    dropSeenSpineUrls: spineLayerController.dropSeenUrls,
    setSpineClip: spineLayerController.setClip,
    releaseGeoclip: (record) => spineTimeline.releaseGeoclip(record),
    onBeforeSweep: (record) => { handController.removeTargeting(record.id); handController.forgetRecord(record.id); },
    stats: mirrorWalkStats
  });
  // Dormancy is constructed before its late walker dependencies. Its callback deliberately resolves this binding
  // only when a hatch drains, after the complete walker has been wired below.
  let nodeWalker!: NodeWalker;
  const dormancy = createDormancyLifecycle({
    records,
    getNodes: () => reconcileController.nodes(),
    getChildIds: (id) => reconcileController.childIdsByParent().get(id),
    getLastOrderedIds: () => reconcileController.lastOrderedIds(),
    now: nowMs,
    visit: (...args) => nodeWalker.visit(...args),
    beginHatchSlice: (started, dirty) => {
      reconcileController.beginDormancyHatch(started, dirty);
    },
    finishHatchSlice: () => {
      reconcileController.finishDormancyHatch();
      }
  });

  // Intent glyph playback keeps its existing flat record fields and has its own live memberships. The narrow ports
  // let it arm the shared scheduler and the end-of-walk animation phase queue without reaching back into this file.
  const intentTimeline = createIntentTimeline({ now: nowMs, schedule: scheduleTick, anchorAnimations });
  // Spine raster/still/geoclip playback owns its live memberships separately from the record model. Every port is
  // a one-purpose live seam; it deliberately cannot reach renderer state wholesale.
  spineTimeline = createSpineGeoclipTimeline({
    now: nowMs,
    schedule: scheduleTick,
    noteCanvasRepaint: (canvas) => occlusionRuntime.noteCanvasRepaint(canvas),
    syncFrozenCanvasStyle: (canvas) => occlusionRuntime.syncFrozenStyle(canvas),
    setMechanism: spineLayerController.setMechanism,
    setShownStill: spineLayerController.setShownStill,
    applyRasterPlacement: (record, clip) => spineTimeline.applyPlacement(record, clip)
  });
  occlusionRuntime = createOcclusionRuntime({
    nodes: () => reconcileController.nodes(),
    records: () => records,
    childIdsByParent: () => reconcileController.childIdsByParent(),
    rootIds: () => reconcileController.rootIds(),
    orderedIds: () => reconcileController.orderedIds(),
    rootOwnerOf: nodeController.ownerOf,
    spreadFactor: () => reconcileController.spreadFactor(),
    walkNow: () => reconcileController.walkNow(),
    createElCount: () => mirrorWalkStats.createEl,
    liftEndpointToGlobal,
    writeDisplay: writeRecordDisplay,
    syncEffectsSuspend: syncEffectsSuspendAttr,
    syncAnimators: (gated, isUnderOccludedRoot) => syncOccludedAnimators(gated, isUnderOccludedRoot),
    animatorCounts: () => ({
      spine: spineTimeline.occludedCount,
      intent: intentTimeline.occludedCount,
      pausedStrip: intentTimeline.pausedStripCount
    })
  });

  // Declarative tween replay (Part C). Nodes with a live CSS-transition endpoint are held in `activeTweens`; the
  // animation loop EXPIRES them (clears the transition) once their epoch passes, so a later instant reposition (a
  // card hover) isn't smeared by a stale transition. Each arm publishes its `until` as a scheduler deadline (see
  // noteTweenDeadline), so a settle costs ONE wakeup instead of a per-frame poll; the set empties → the loop parks.
  // Constructed after the scheduler supplies its narrow deadline/deraster ports.
  let tweens: TweenController;
  // Hand-raise writes are staged by the tween controller's transform batch. This remains here because only the
  // readable-hand pass owns the translate channel; tweenController owns the endpoint/prime ordering around it.
  interface TransformArmBatch {
    raiseWrites: Array<() => void>;
    armedHandRecords: Set<RenderRecord>;
    needsPrimeBarrier: boolean;
  }
  let transformArmBatch: TransformArmBatch | null = null;

  handController = createHandController({
    stage,
    records: () => records,
    nodes: () => reconcileController.nodes(),
    childIds: () => reconcileController.childIdsByParent(),
    geometryEpoch: () => reconcileController.geometryEpoch(),
    markGeometryDirty: () => reconcileController.markGeomDirty(),
    now: nowMs,
    spreadFactor: () => reconcileController.spreadFactor(),
    interactiveRects,
    liftEndpointToGlobal,
    composeTweenTransition: (record) => tweens.composeTransition(record),
    collectSubtreeIds: (id, out) => elementLifecycle.collectSubtreeIds(id, out),
    isCombatPileContainer,
    coverAbove,
    recordHasFlight,
    drawnGlobalOfElement,
    drawnGlobalY,
    isArmedHand: (record) => transformArmBatch?.armedHandRecords.has(record) === true,
    queueRaisedArmWrite: (write) => transformArmBatch?.raiseWrites.push(write),
    noteRaisedArmPrime: () => { if (transformArmBatch) transformArmBatch.needsPrimeBarrier = true; },
    noteLandingGone: (id) => landingLog.noteGone(id),
  });
  const { handHolderIds, handHitboxIds, raisedRectDy } = handController;




  // The DOM card-flight runtime owns its own live identity sets. Placement remains a renderer port so records keep their existing flat shape.
  cardFlights = createCardFlightController({
    records,
    children: () => reconcileController.childIdsByParent(),
    trails: () => trails,
    now: nowMs,
    schedule: scheduleTick,
    stats: mirrorWalkStats,
    walkNow: () => reconcileController.walkNow(),
    spreadFactor: () => reconcileController.spreadFactor(),
    spreadDxAtGlobal: (record, g6) => record.lastNode ? spreadDxAtGlobal(record, record.lastNode, g6) : 0,
    placement: (record, g6) => record.lastNode ? nodeTransformForGlobal(record, record.lastNode, g6) : { transform: null },
    writeTransform: (record, g6, until, parentInv) => tweens.writeFlightTransform(record, g6, until, parentInv),
      markParticleDirty: () => effectsDirtiness.markParticle()
  });
  // ARMED-WORK PRESSURE, for gsw's static-surface encode pacing (see framePressure.ts). The frame-recency term
  // there is suppressed by the very block it exists to prevent — a 285 ms readback stops this loop, so a quarter
  // second later the mirror reads QUIET while the thread is still jammed. These three sets say what is armed
  // rather than what has run, which a block cannot fake.
  //
  // NARROW ON PURPOSE, and the exclusions are the load-bearing part. Only the BURST-shaped animators are here —
  // a flight retires when its card lands, a trail ages out 0.8 s after its last point, a tween expires at its
  // epoch — so this predicate cannot latch ON. `activeSpine` / `activeIntents` are excluded: an idle combat
  // screen animates both continuously, so counting them would make pressure PERMANENT, and gsw would then only
  // ever drain at its `busyMaxDeferMs` bound — i.e. it would re-introduce the standing live-canvas cost the whole
  // swap exists to remove. While they DO tick they call `noteMirrorFrame()` anyway, so the recency term already
  // covers them; what they do not need is immunity to jank, because they are not what jams the thread.
  const unregisterPressure = registerPressureSource(
    () => cardFlights.activeCount > 0 || trails.active.size > 0 || tweens.activeCount > 0
  );

  // --- the animation loop (WS-B: DEADLINE-SCHEDULED) ---------------------------------------------------------
  //
  // One renderer-owned loop drives all three time-driven animators (spine clip advance, enemy-intent glyph
  // cycling, declarative-tween expiry). It used to be a free-running rAF chain that re-entered at 60Hz and ran
  // all three gates every frame; a phone trace measured ~0.9ms of JS per frame with NOTHING due (plus a
  // copied tween-set iteration per frame). Now every animator publishes its next DUE time and the loop sleeps on a
  // `setTimeout` until the earliest of them — zero renderer JS in between — then wakes inside a
  // `requestAnimationFrame` so every visual mutation stays frame-aligned exactly as before. With nothing armed it
  // is fully parked: no timer, no rAF, no work.
  //
  // The three due clocks (`Infinity` = that source is not armed):
  //   • spineDueAt  — next spine clip-frame advance. Quantized to a SHARED period grid anchored at the
  //                   performance-clock origin (nextGridAfter), so N clips advance in ONE wakeup rather than N
  //                   staggered ones. The frame each clip shows is still computed from WALL-CLOCK at the wakeup
  //                   (frameIndexAt) — only the wakeup TIMES are quantized, so no clip's phase shifts.
  //   • intentDueAt — next enemy-intent glyph advance. Same fps source ⇒ the same grid ⇒ the same wakeup.
  //   • tweenDueAt  — earliest live tween-channel expiry / hide-latch held-restore deadline. EXACT (not gridded):
  //                   a settle must land on its own deadline.
  // Arming anything (a clip, a glyph, a tween) recomputes the minimum and REPLACES the pending timer when the new
  // deadline is earlier — see scheduleTick. Every reconcile ends with a scheduleTick() so a walk that armed or
  // retired work always leaves a correct deadline behind.
  //
  const scheduler = createTickScheduler({
    now: nowMs,
    animationPeriodMs: () => {
      const fps = renderQuality().spineClipFps;
      return fps > 0 ? 1000 / fps : 0;
    },
    hasActiveSpine: () => spineTimeline.activeCount > 0,
    hasActiveIntents: () => intentTimeline.activeCount > 0,
    hasActiveTweens: () => tweens.activeCount > 0,
    hasActiveTrails: () => trails.active.size > 0,
    hasActiveFlights: () => cardFlights.activeCount > 0,
    tickSpine: spineTimeline.tick,
    tickIntent: intentTimeline.tick,
    tickTweens: (now) => tweens.tick(now),
    tickTrails: (now) => trails.tick(now),
    tickFlights: cardFlights.tick
  });
  tickScheduler = scheduler;
  const { noteTweenDeadline, noteTrailDeadline, queueDeraster } = scheduler;
  tweens = createTweenController({
    records,
    nodeOf: (id) => reconcileController.nodes().get(id),
    hasNode: (id) => reconcileController.nodes().has(id),
    childrenOf: (id) => reconcileController.childIdsByParent().get(id) ?? EMPTY_CHILDREN,
    walkNow: () => reconcileController.walkNow(),
    now: nowMs,
    stage,
    placement: (record, g6, parentInv) =>
      record.lastNode
        ? nodeTransformForGlobal(record, record.lastNode, g6, parentInv)
        : { transform: null },
    liftEndpoint: liftEndpointToGlobal,
    cssLinear: cssLinear2x2,
    handHolderIds,
    applyHandRaise: () => handController.applyHandRaise(),
    applyViewScale: () => scaleController.applyViewScale(),
    applyTipScale: () => scaleController.applyTipScale(),
    noteDeadline: noteTweenDeadline,
    schedule: scheduleTick,
    queueDeraster,
    derasterNeeded: derasterNeededOnSettle,
    markGeometryDirty: () => reconcileController.markGeomDirty(),
    markGeomRebase: (id) => reconcileController.markGeomRebase(id),
    noteReparentDrop: () => {
      mirrorWalkStats.tweenReparentDropped++;
    },
    noteHintRebased: () => {
      mirrorWalkStats.hintTransformRebased++;
    },
    beginTransformArmBatch: () => {
      transformArmBatch = {
        raiseWrites: [],
        armedHandRecords: new Set(),
        needsPrimeBarrier: false,
      };
    },
    clearTransformArmBatch: () => {
      transformArmBatch = null;
    },
    noteArmedHand: (record) => {
      transformArmBatch?.armedHandRecords.add(record);
    },
    takeTransformArmBatch: () => {
      const current = transformArmBatch;
      return current ?? { needsPrimeBarrier: false, raiseWrites: [] };
    },
    noteLanding: (record, endpoint, placed, until) => {
      if (!handHolderIds.has(record.id) || !record.lastNode || !placed.gShifted)
        return;
      const live = reconcileController.nodes().get(record.id);
      landingLog.noteArm({
        id: record.id,
        name: record.lastNode.name,
        atMs: nowMs(),
        endpointGame: [...endpoint] as Affine,
        endpointDrawn: [...placed.gShifted] as Affine,
        spreadDxApplied: placed.spreadDx ?? 0,
        fieldMode: record.spreadFieldMode,
        durationMs: Math.max(0, until - nowMs()),
        parentId: live?.parentId ?? null,
        streamedAtArm: live?.transform ?? null,
      });
    },
  });
  trails = createCardTrailController({
    now: nowMs,
    noteDeadline: noteTrailDeadline,
    isFlightOwned: (id) => {
      const record = records.get(id);
      return record != null && cardFlights.isFlightOwned(record);
    },
    onActivity: () => {
      cardFlights.onTrailActivity();
    }
  });

  // R10-B1 SCALE GATE: is a deraster actually needed for this record's settled transform tween? The will-change
  // toggle exists to re-raster an element whose RASTERIZATION SCALE changed under it (a card zoom leaves the text
  // rasterized at the start scale — the blurry-text fix), and it costs a second Layerize+Commit echo per settle
  // group. A TRANSLATION-ONLY tween cannot change that scale, so comparing the element's 2×2 linear components
  // before the arm with the ones it settled at tells the two apart. Unknown/unparseable on either side ⇒ true
  // (deraster), so the fix's coverage can only ever be widened by a parse we don't model, never narrowed.
  // NOTE the compared strings are the record's OWN cached transform, i.e. the pre-view-scale base. A view-scale /
  // hover-tip compose that changes DURING a tween is not modelled here (it wasn't before either).
  const DERASTER_LINEAR_EPS = 1e-3;
  function derasterNeededOnSettle(record: RenderRecord): boolean {
    const before = record.tweenPreArmLinear;
    const after = cssLinear2x2(record.style.get("transform"));
    if (before == null || after == null) {
      return true;
    }
    for (let i = 0; i < 4; i++) {
      if (Math.abs(before[i] - after[i]) > DERASTER_LINEAR_EPS) {
        return true;
      }
    }
    return false;
  }

  function removeEl(record: RenderRecord): void {
    elementLifecycle.removeEl(record);
  }

  // The decorative-animation self-layer: a child that fills the node's element and carries a CSS animation in
  // LOCAL space, so the loop runs while the element keeps the baked global matrix. Created lazily — by createEl
  // for a path-keyed binding (orb spin / flame quad), and GROWN ON DEMAND by syncPinnedLoop when a producer-pinned
  // rotation/glow token arrives on a node that has none. Never appended here: updateSubLayers owns its slot among
  // the sub-layers.
  // ---- WS-E / R10-B2 pinned-loop replay ---------------------------------------------------------------------
  //
  // Replay a game animator the PRODUCER pinned to rest (`node.pinnedLoopAnim`), on the browser's own clock. The
  // producer folds these because they are per-frame sine sweeps that keep an otherwise-idle screen streaming; it
  // cannot simply freeze them (unlike the four garnish animators the decorative fold pins) because they carry
  // MEANING — the map pulse is how the game shows which nodes you may travel to; the top-bar icon rock/spin is how
  // it shows which screen the top bar has open; the proceed glow is what draws the eye to the only button.
  //
  // FIVE tokens, TWO routings (see animAttributes for the vocabulary and the producer constants):
  //   * `mapPointPulse` → `pivotPulse`, applied to the node's OWN element. Unchanged since WS-E; the reasoning
  //     below is specific to it.
  //   * `topBarDeckRock` / `topBarMapRock` / `topBarSpin` / `proceedGlow` → `rock` / `rotate` / `glowPulse`,
  //     applied to the record's animSelf CHILD:
  //       – a rotation cannot ride the element. CSS applies the individual `rotate:` OUTSIDE the baked matrix, so
  //         it would sweep the matrix's translation about the origin and ORBIT the icon across the screen.
  //       – the glow needs an opacity that MULTIPLIES the element's own: the producer pins `self_modulate:a` at
  //         0.75 into the streamed colour, so el keeps `modulate.a × 0.75` and the child sweeps 1 ↔ 1/3, giving
  //         back the game's exact 0.75 ↔ 0.25 against a live-streamed RGB. Blend mode and tint filter stay on el
  //         (they cascade), so only the alpha is reproduced.
  //     The node's PAINT moves inside that child (see `animSelfWrapsPaint` / updateSubLayers) — for an atlas
  //     sprite the paint is a <canvas> sub-layer, so without the nesting the loop would animate an empty box.
  //     THE ELEMENT ITSELF IS NEVER TOUCHED by these three, which is the point: the producer un-folded only the
  //     rotation/alpha and keeps streaming position + scale live, and that is exactly what fixed the WS-D
  //     mispositioning bug (a pre-layout transform frozen forever). A client-side write to the element's
  //     transform would reintroduce it.
  //
  // Why the pulse composes `scale:` + `translate:` (individual transform properties) instead of touching
  // `transform:` — the invariants this pass is written against:
  //   * WS-A geometry epoch: `record.style` is the reconciler's style cache and `"transform"` is the key every
  //     epoch-cached structure (interactive rects, the view-scale/tip stamps) is derived from. Writing an
  //     animation through it would bump the epoch on EVERY walk and defeat the O(delta) reconcile. So the two
  //     properties are set DIRECTLY on the element — applyStyleMap never sees them, never removes them, and never
  //     restarts the animation (the same escape hatch the remote-follower transition and the intent bob use).
  //   * The pulse must therefore stay COSMETIC: the geometry passes and the touch hit-test read the style map, so
  //     they see the node at rest. That matches the game, where the pulse is on the icon CONTAINER while the
  //     clickable button box (`NNormalMapPoint` itself, the node the mirror hit-tests) never scales.
  //   * A DOM-nested subtree inherits its parent element's transform, so scaling this element scales the icons
  //     with it — exactly as the game scales the icon container and lets its children ride along. This is also why the
  //     producer streams the icons re-based against the container's REAL (pulsing) global: their locals stay
  //     constant, so pinned-container x constant-icon composes back to the game's transform under the CSS pulse.
  //   * The `translate` companion is what anchors the scale at the node's PIVOT (see presentation's PIVOT_PULSE):
  //     CSS applies the individual properties OUTSIDE the baked matrix, so a bare `scale:` would multiply the
  //     matrix's translation and slide the node as it grows.
  //
  // The map pulse's pivot is the node's local-rect CENTRE lifted through the element's own matrix. Godot Controls
  // carry an authored `pivot_offset`, which for the map point's 56x56 icon container IS its centre (verified on
  // the live wire: the streamed transform's origin matches the centre-pivot algebra to <1e-4). The three top-bar
  // icons do NOT rotate about their centre, so their pivot is the authored `pivot_offset` from the scene file
  // (animation policy table), mapped into the animated child's own coordinate space — for an
  // atlas-sprite leaf that space is the texture REGION, not the node's rect.
  // Stop a pinned loop: the producer stopped naming it (the map node became untravelable, the screen closed, the
  // proceed button was focused/disabled), or the token became unknown. The animSelf child is
  // KEPT — an un-animated wrapper renders identically and re-parenting the paint on every start/stop would churn
  // the DOM — and any static binding the loop displaced goes back on.
  // --- spine clip playback ----------------------------------------------------------------------------------

  function nowMs(): number {
    return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : 0;
  }

  const domSubLayers = createDomSubLayers({
    syncShaderUvWindow,
    effects: {
      markShaderDirty: () => {
        effectsDirtiness.markShader();
      },
      markParticleDirty: () => {
        effectsDirtiness.markParticle();
      }
    },
    spineTimeline,
    intentTimeline,
    lineMasks,
    trails: {
      acquire: trails.acquire,
      release: trails.release,
      releaseFrame: trails.releaseFrame,
      syncBandOpacity: trails.syncBandOpacity,
      active: trails.active
    },
    frozen: {
      canvases: occlusionRuntime.canvases,
      thaw: occlusionRuntime.thaw,
      syncStyle: occlusionRuntime.syncFrozenStyle,
      noteRepaint: occlusionRuntime.noteCanvasRepaint
    },
    ninePatch: { sync: syncNpSlices },
    walk: { hatching: () => dormancy.isHatching(), now: () => reconcileController.walkNow() },
    updateSpineLayer: spineLayerController.updateLayer
  });

  reconcileController = createReconcileController({
    stage,
    records,
    nodeWalker: () => nodeWalker,
    nodeController,
    elementLifecycle,
    dormancy,
    cardFlights,
    tweens,
    handController,
    scaleController,
    occlusionRuntime,
    spineTimeline,
    staticBgRuntime,
    animationRuntime,
    svgDefs,
    landingLog,
    landingProbe,
    now: nowMs,
    scheduleTick,
    markEffectsDirty,
    resetShaderDocCache,
    removeEl,
    removeTargeting: handController.removeTargeting,
    forgetHandRecord: handController.forgetRecord,
    sampleBlendCensus,
    stats: mirrorWalkStats,
  });

  // The recursive retained-DOM policy is isolated from reconciliation classification and post-walk consumption.
  // All map-like inputs are getter ports because structural walks replace their backing maps.
  nodeWalker = createNodeWalker({
    records,
    nodes: () => reconcileController.nodes(),
    childIdsByParent: () => reconcileController.childIdsByParent(),
    subtreeDirty: () => reconcileController.subtreeDirty(),
    visited: () => reconcileController.visited(),
    textureDirtySelf: () => reconcileController.textureDirtySelf(),
    changedParents: () => reconcileController.changedParents(),
    orderDirtyParents: () => reconcileController.orderDirtyParents(),
    orphanRootIds: () => reconcileController.orphanRootIds(),
    walkNow: () => reconcileController.walkNow(),
    spreadFactor: () => reconcileController.spreadFactor(),
    markGeomDirty: () => reconcileController.markGeomDirty(),
    geomDirty: () => reconcileController.geometryDirty(),
    noteRevealBuilt: () => reconcileController.noteRevealBuilt(),
    anchorAnimations,
    markEffectsDirtyBits,
    spreadDrawBox,
    staticBgHeldIds: () => staticBgRuntime.heldIds,
    staticBgSuppressedRootIds: () => staticBgRuntime.suppressedRootIds,
    staticBgHold,
    staticBgSuppress,
    computeSceneInfo,
    resolveVisualOwnerId,
    hitTestShift,
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
    occlusionRuntime,
    updateSubLayers: (...args) => domSubLayers.update(...args),
    applyRecordSuppression,
    removeEl,
    computeAdoptKey: computeLifecycleAdoptKey,
  });

  // The endpoint tween seam also consumes this drawing-box classification, so it remains parent-owned.
  function spreadDrawBox(node: MirrorNode): SpreadBox | null {
    return spreadDrawBoxOf(node);
  }

  // (default) the endpoint already IS the global.
  function liftEndpointToGlobal(target: RenderRecord, endpoint: number[]): Affine {
    const g = endpoint as unknown as Affine;
    return affineMul(target.cParentGlobal ?? IDENTITY_AFFINE, g);
  }

  // WS-C — THE ENDPOINT'S OWN SPREAD SHIFT. A node that claims its place on the wide-screen squeeze field shifts by
  // a function of its own rendered X, so the shift belonging to a tween ENDPOINT is the field evaluated THERE, not
  // the one the walk derived from the node's current pose (which the producer then freezes for the hint's whole
  // window). Every other node keeps `record.spreadDx` verbatim: a rider, an
  // anchor-algebra Control, an owner-anchored floater and a remote follower all take their shift from something
  // other than their own X, and moving them along the field would be wrong.
  function spreadDxAtGlobal(record: RenderRecord, node: MirrorNode, g6: readonly number[]): number {
    // The RULE is `spreadLayout.fieldDxAtGlobal`, shared with the canvas backend's per-frame rebase — the two used
    // to spell the same three cases out separately. The record's walked shift remains the mode-0 / F=1 fallback.
    return fieldDxAtGlobal(
      record.spreadFieldMode,
      record.spreadDx,
      g6 as SpreadAffine,
      node,
      spreadDrawBox(node),
      reconcileController.spreadFactor(),
    );
  }

  // The CSS transform + transform-origin a node WOULD render with if its global Transform2D were `g6`, computed by
  // re-running the shared `nodeStyle` with the transform substituted. Reproduces the node's OWN formatting (plain
  // `matrix(...)` vs the atlas `matrix(...) scale(...)`), so applying one tween endpoint to a card's frame-art and
  // its text can't desync them. Returns nulls for a node with no transform-based box (rect-only / boxless), plus the
  // horizontal spread shift it applied (the flight replay feeds that same shifted X to its trail — see
  // `noteCardFlightTrailHead`).
  function nodeTransformForGlobal(
    record: RenderRecord,
    node: MirrorNode,
    g6: readonly number[],
    parentInvOverride?: Affine
  ): { transform: string | null; transformOrigin: string | null; spreadDx: number; gShifted: readonly number[] } {
    // Apply this node's horizontal SPREAD shift to the endpoint's x-translation, so a tween lands at the same
    // spread position the resting placement uses (`record.cInv` is the spread-shifted parent inverse). g6 is the
    // true 1920-space endpoint; the shift is evaluated at the ENDPOINT's own X for the two field-claiming modes and
    // is `record.spreadDx` for everything else. It is 0 whenever the spread is off or this node doesn't shift, and
    // the whole composition is then skipped → byte-identical.
    const spreadDx = spreadDxAtGlobal(record, node, g6);
    const gShifted = spreadDx === 0 ? g6 : [g6[0], g6[1], g6[2], g6[3], g6[4] + spreadDx, g6[5]];
    const item: RenderItem = {
      node,
      opacity: 1, // unused for the transform read below
      tintId: null,
      // The parent ELEMENT's inverse (so the endpoint is re-based like the live placement) — or the caller's, when
      // the parent element is itself being driven this frame and the cached inverse is a frame behind.
      parentInv: parentInvOverride ?? record.cInv,
      hasChildren: false,
      // This overwrites `transform` even when the node streamed none, so a rect-only node with a box
      // still resolves its endpoint through the placement branch.
      transformOverride: gShifted
    };
    // R11 C1: the placement-only seam (see `?flightPlacementSeam`). `nodePlacementTransform` returns null for
    // exactly the nodes `nodeStyle` emits no transform for — a rect-only / boxless one — so the null branch is the
    // same branch, not a new failure mode.
    mirrorWalkStats.flightPlacementSeamHits++;
    const placement = nodePlacementTransform(item);
    return {
      transform: placement?.transform ?? null,
      transformOrigin: placement?.transformOrigin ?? null,
      spreadDx,
      gShifted
    };
  }

  // Callers set their OWN flag and then call this; the attribute is only read/written on a real edge.
  function syncEffectsSuspendAttr(rec: RenderRecord): void {
    const el = rec.el;
    if (!el) {
      return;
    }
    const want = rec.occlusionSuspended ? "occluded" : rec.staticBgSuspended ? "static-bg" : null;
    if (want === el.getAttribute(EFFECTS_SUSPENDED_ATTR)) {
      return;
    }
    if (want === null) {
      el.removeAttribute(EFFECTS_SUSPENDED_ATTR);
    } else {
      // Scoped to the whole subtree via gsw's `closest()`, so ONE stamp on the suppressed root parks every shader
      // + particle runtime under it, frozen (never reset) and out of their rAF loops.
      el.setAttribute(EFFECTS_SUSPENDED_ATTR, want);
    }
    markEffectsDirty(); // WS-2: BOTH runtimes re-evaluate suspension only inside their reconcile
  }

  function setUiScaling(enabled: boolean): void {
    scaleController.setUiScaling(enabled);
  }

  // The ONE place a record element's `display` is written, and — because they must never disagree — the one place
  // the static-background subtree declares its dormancy to gsw. Both writers route through here: the walk's own
  // write in `visit`, and the out-of-walk `writeRecordDisplay` below. (The staggered-reveal drain also touches
  // `display`, but only ever to un-HOLD — `= ""`, gated on `!paintSuppressed` — so it can never contradict a
  // suppression this helper applied.)
  //
  // WHY the stamp lives here: `staticBgSuppress` used to feed `display` and nothing else, so a combat-bg subtree
  // could sit at `display:none` for a whole combat with every gsw binding still LIVE. gsw shrinks a canvas on a
  // 0×0 contentRect to a 1×1 backing store (so memory IS reclaimed), but the binding still does a full GL draw per
  // tick, still keeps the animation loop alive when its shader reads TIME, still forces a `getBoundingClientRect`
  // for a screen-space shader, and is never disposed — the 30s dormant sweep only reaches DORMANT bindings, and
  // nothing was declaring dormancy. EFFECTS_SUSPENDED_ATTR is the contract for exactly this, it is ancestor-scoped,
  // and it is already wired end to end, so one stamp on the suppressed root parks the whole subtree.
  //
  // Both call sites sit OUTSIDE the walk's `!hidden && !cull && selfDirty` style gate, and that is the point: a
  // settled combat re-styles nothing, so a stamp that only landed during a full re-style would never land at all.
  function applyRecordSuppression(rec: RenderRecord, el: HTMLElement, suppressed: boolean): void {
    rec.paintSuppressed = suppressed;
    el.style.display = suppressed || dormancy.isRevealHeld(rec.id) ? "none" : "";
    // Hot path: with no bg suppression anywhere (and nothing to take back), this is one size compare per node.
    if (staticBgRuntime.suppressedRootIds.size === 0 && !rec.staticBgSuspended) {
      return;
    }
    const bgSuppressed = staticBgRuntime.suppressedRootIds.has(rec.id);
    if (bgSuppressed === rec.staticBgSuspended) {
      return;
    }
    rec.staticBgSuspended = bgSuppressed;
    syncEffectsSuspendAttr(rec);
  }

  // The element's `display`, recomputed from the independent suppressors the renderer owns (own visibility,
  // the occlusion gate, the static-background root gate) — the same expression `visit` writes during the walk.
  function writeRecordDisplay(rec: RenderRecord): void {
    const el = rec.el;
    if (!el) {
      return;
    }
    const hidden = rec.lastNode != null && !rec.lastNode.visible;
    // R10-PERF6 WS-P2: this pass does NOT stage a reveal, deliberately. It was tried (the occlusion gate can be
    // the last writer to un-hide a screen) and measured to change nothing — `visit`'s edge already fires for
    // every reveal the bench can produce, including the cold-map one — so the second staging site was dropped
    // rather than shipped as a duplicate path that no test could distinguish.
    applyRecordSuppression(
      rec,
      el,
      hidden || rec.occluded || staticBgRuntime.suppressedRootIds.has(rec.id)
    );
  }

  // The runtime owns gated-root membership; this facade retains the timeline implementations.
  function syncOccludedAnimators(gated: boolean, isUnderOccludedRoot: (id: string) => boolean): void {
    let changed = spineTimeline.syncOcclusion(gated, isUnderOccludedRoot);
    changed = intentTimeline.syncOcclusion(nowMs(), gated, isUnderOccludedRoot) || changed;
    if (changed) scheduleTick();
  }

  function reconcile(
    state: MirrorState,
    options: { forceTextures?: boolean; reason?: FullWalkCause } = {}
  ): void {
    reconcileController.reconcile(state, options);
  }

  // R10-PERF3 WS-4: accept renderer-originated dirt from the texture cache (a natural size just landed for a url
  // these nodes styled provisionally against). Deliberately dumb — no `records` membership filter here, because a
  // record can appear or vanish between this call and the walk that consumes it; markDirty does the one filter that
  // matters (against the walk's OWN node map) and an id that survives nothing is simply never injected.
  function markTextureDirty(ids: Iterable<string>): void {
    reconcileController.markTextureDirty(ids);
  }

  function consumeEffectsDirty(): { shader: boolean; particle: boolean } {
    return effectsDirtiness.consume();
  }

  function setStretch(factor: number): void {
    reconcileController.setStretch(factor);
  }

  // The lift height for the current gesture (0 when nothing is lifted) — `raise/heldLift`, shared with the canvas
  // backend, bound to this backend's gesture state.
  /** Where this backend DREW a node, in design space: its streamed global plus whatever the raise pass moved it by. */
  function drawnGlobalY(id: string | null): number | null {
    if (id === null) {
      return null;
    }
    const record = records.get(id);
    const node = reconcileController.nodes().get(id);
    if (record == null || node?.transform == null) {
      return null;
    }
    return liftEndpointToGlobal(record, node.transform)[5] + (record.raiseDy ?? 0);
  }

  // --- the shared HAND POSE seam (handPoseProbe.ts) ---------------------------------------------------------
  //
  // WHAT THIS BACKEND HAS TO DO THAT THE CANVAS ONE DOES NOT: measure its own output. A canvas build knows the
  // matrix it drew each node with, because it computed it this frame. Here the drawn pose lives in the DOM — split
  // across a nested chain of elements, each carrying a PARENT-RELATIVE `matrix()` (the walk divides the parent's
  // global back out through `record.cInv`), plus the raise's own `translate` property, plus whatever the
  // compositor is currently interpolating. So the honest answer is to READ IT BACK: compose the chain from the
  // stage down to the holder's element and report the product.
  //
  // Reading rather than re-deriving is the whole point. A probe that recomputed "the pose the writer should have
  // written" would agree with the writer by construction and could never catch the writer being wrong — which is
  // the exact failure this seam exists to detect on the other stage.
  //
  // `getComputedStyle` FIRST, inline second: mid-transition the computed value is the pose actually on screen
  // while the inline value is already the endpoint. (In jsdom there are no transitions and the two agree, which is
  // what makes an offline spec's answer meaningful.)

  /** A CSS `matrix(a, b, c, d, e, f)` / `none` / `""` as an affine. Anything unparseable is the identity. */
  function cssMatrixToAffine(value: string | null | undefined): Affine {
    if (!value) {
      return IDENTITY_AFFINE;
    }
    const m = /matrix\(([^)]*)\)/.exec(value);
    if (!m) {
      return IDENTITY_AFFINE;
    }
    const parts = m[1].split(",").map((p) => Number(p));
    if (parts.length < 6 || parts.some((p) => !Number.isFinite(p))) {
      return IDENTITY_AFFINE;
    }
    return [parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]];
  }

  /** The first two lengths of a `translate` / `transform-origin` value, in px. Missing components read 0. */
  function cssPairPx(value: string | null | undefined): [number, number] {
    if (!value || value === "none" || value === "normal") {
      return [0, 0];
    }
    const parts = value.trim().split(/\s+/);
    const x = Number.parseFloat(parts[0] ?? "0");
    const y = Number.parseFloat(parts[1] ?? "0");
    return [Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0];
  }

  /**
   * ONE element's contribution, in its parent's coordinates: `T(origin) · Translate · Matrix · T(-origin)`.
   *
   * That composition order is CSS's own — the individual `translate` property applies BEFORE `transform`, and both
   * are taken about `transform-origin`. The renderer writes origin `0 0` for the placement transforms it bakes, in
   * which case the conjugation collapses; it is spelled out anyway because a node that does carry an origin (an
   * atlas sprite's scale, a view-scaled group) would otherwise be composed at the wrong pivot and the probe would
   * invent a drift nobody can see.
   */
  function elementLocalAffine(el: HTMLElement, preferInline = false): Affine {
    const cs = preferInline || typeof getComputedStyle !== "function" ? null : getComputedStyle(el);
    const matrix = cssMatrixToAffine(
      cs && cs.transform && cs.transform !== "none" ? cs.transform : el.style.transform
    );
    const [tx, ty] = cssPairPx((cs?.translate && cs.translate !== "none" ? cs.translate : el.style.translate) || "");
    const [ox, oy] = cssPairPx((cs?.transformOrigin || el.style.transformOrigin) ?? "");
    // T(tx, ty) · M, inline (a left translation only adds into the translation column).
    const inner: Affine = [matrix[0], matrix[1], matrix[2], matrix[3], matrix[4] + tx, matrix[5] + ty];
    if (ox === 0 && oy === 0) {
      return inner;
    }
    // T(o) · inner · T(-o)
    return [
      inner[0],
      inner[1],
      inner[2],
      inner[3],
      inner[4] + ox - (inner[0] * ox + inner[2] * oy),
      inner[5] + oy - (inner[1] * ox + inner[3] * oy)
    ];
  }

  /**
   * The DESIGN-space global an element is drawn at: every affine from the stage down to it, composed.
   *
   * `preferInline` reads the WRITTEN values instead of the computed ones — the pose the element is heading for
   * rather than the frame it is showing. The pose seam wants the frame (it is a measurement of the picture); the
   * landing log wants the destination, because a CSS transition left over from the arm would otherwise let it score
   * a settled landing against a mid-interpolation snapshot. See `landingProbe`.
   */
  function drawnGlobalOfElement(el: HTMLElement, preferInline = false): Affine {
    let acc: Affine = IDENTITY_AFFINE;
    let cur: HTMLElement | null = el;
    // The stage element itself carries the design→CSS scale, so the walk STOPS at it: everything above is the
    // page's own letterboxing, and the seam's contract is design space.
    while (cur !== null && cur !== stage) {
      acc = affineMul(elementLocalAffine(cur, preferInline), acc);
      cur = cur.parentElement;
    }
    // LAYOUT SPACE (stageFit.ts) → back to the DESIGN space this function's contract promises. On the
    // `?stageFit=display` arm every element in that chain carries a translation already multiplied by the fit
    // factor, and conjugation composes — the product of `S·Dᵢ·S⁻¹` is `S·(∏Dᵢ)·S⁻¹` — so the whole chain is undone
    // by dividing the composed TRANSLATION once, here. The linear part never carried the factor and is untouched.
    // Identity on the default arm, which is why every consumer (the pose seam, the landing log, the hand claim)
    // is unchanged there.
    return layoutScale() === 1
      ? acc
      : [acc[0], acc[1], acc[2], acc[3], designPx(acc[4]), designPx(acc[5])];
  }

  /** Is a card FLIGHT currently placing this record? (At most ~30 live at a reshuffle peak — a scan is right.) */
  function recordHasFlight(record: RenderRecord): boolean {
    return cardFlights.hasRecord(record);
  }

  function dispose(): void {
    tickScheduler?.dispose();
    tickScheduler = null;
    unregisterPressure(); // a disposed renderer's animator sets must stop answering gsw (framePressure.ts)
    // Cancel idle hatch work before record teardown, then release stagger holds before pooled elements detach.
    dormancy.dispose();
    intentTimeline.dispose();
    tweens.clear();
    handController.dispose();
    scaleController.dispose();
    occlusionRuntime.dispose();
    // R12: a disposed renderer holds nothing (MirrorView remounts with a fresh one, which re-derives the hold from
    // the wire on its first walk); leaving stale ids here would only mis-report the gauge.
    staticBgRuntime.dispose();
    reconcileController.beginDispose();
    // Collapse the teardown's per-record geometry bumps into ONE epoch step (removeEl bumps, and outside a walk every
    // bump counts — a 19k-node scene would otherwise spin the counter 19k times for a single state change).
    // Condemnation and the cross-walk park outlive a reconcile, so their owner must
    // drain them before the live-record sweep below.
    elementLifecycle.dispose();
    for (const record of records.values()) {
      removeEl(record);
    }
    reconcileController.finishDispose();
    records.clear();
    // Element lifecycle and every removeEl callback still need ownership lookup; clear the controller only now.
    nodeController.dispose();
    if (typeof window !== "undefined") {
      // The phase probe closes over `records`, which is now empty — but leaving a live function behind on a torn
      // down renderer would let a harness read a comet that no longer exists as "zero strokes", which is a
      // different answer from "there is no trail backend here".
      delete (window as unknown as Record<string, unknown>).__mirrorTrailProbe;
    }
    // The hand seam goes with it, and only if this renderer is still the one installed: MirrorView builds the
    // replacement backend BEFORE disposing the old one on a stage flip, so an unconditional delete would unhook
    // the live stage's probe and report "no hand" for a hand that is on screen.
    installHandPoseProbe(null, handPoseOwner);
    installLandingLogProbe(null, handPoseOwner);
    // Aug-25: the record sweep above already retired every promotion through removeEl (so the gauge is back at 0
    // by arithmetic) — this is the belt for a record that never reached the sweep, and it must run AFTER it.
    spineTimeline.dispose();
    mirrorWalkStats.spinePromotedNodes = 0;
    // removeEl retired each stroke's registration above; sweep anything a partially-built record left behind so no
    // <mask> outlives the renderer in the shared defs.
    lineMasks.dispose();
    trails.dispose();
    clearPhaseAnchors();
    interactionController.dispose();
  }

  return {
    reconcile,
    markTextureDirty,
    setStretch,
    setHeldCard: (...args) => handController.setHeldCard(...args),
    setRaiseHandCards: (enabled) => handController.setRaiseHandCards(enabled),
    setUiScaling,
    raiseInputStamps: () => handController.raiseInputStamps(),
    raisedHandVisualClaimAt: (clientX, clientY) => handController.raisedHandVisualClaimAt(clientX, clientY),
    raisedHandTouchTargetClaim: (touchTargetId) => handController.raisedHandTouchTargetClaim(touchTargetId),
    handPresent: () => handController.handPresent(),
    handRaiseUiLayer: () => handController.handRaiseUiLayer(),
    handPoses: () => handController.handPoses(),
    landingLog: landingLogReport,
    handRaiseDebug: () => handController.handRaiseDebug(),
    isCardTouchTarget,
    isHandCard,
    confirmTapTarget,
    confirmTapAt,
    coverAbove,
    rewardFocusSnapshot: () =>
      rewardFocusSnapshotFromScene(
        reconcileController.nodes(),
        reconcileController.orderedIds(),
        interactiveRects(),
        coverAbove
      ),
    setConfirmCoverWatch,
    handChoiceActive,
    mapDrawingToolActive,
    interactiveRects,
    viewScaleInputStamps: () => scaleController.inputStamps(),
    endTurnBoxAt,
    eagerScrollTargets,
    // M0 INPUT SEAMS. The three probes are the module-level DOM walks above, handed out unchanged — this backend's
    // answer to "what did you draw here" IS the element stack it drew. The two eager-scroll seams are closures,
    // because they address a node by id through the retained records.
    touchStackAt: domTouchStackAt,
    spreadPainterAt: domSpreadPainterAt,
    mapNodeAt: (clientX: number, clientY: number) => mapPointElementIdAt(clientX, clientY),
    applyLocalOffset,
    scrollRenderedY,
    isUnderNode,
    consumeEffectsDirty,
    setStaticBackgroundShown,
    __drainDormantHatchForTest: (budgetMs: number = dormancy.hatchBudgetMs) => dormancy.drainHatchForTest(budgetMs),
    __drainRevealStaggerForTest: (budgetNodes?: number) => dormancy.drainRevealForTest(budgetNodes),
    dispose
  };
}

export { createMirrorRenderer as createDomMirrorRenderer };
