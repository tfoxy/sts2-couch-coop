// The DOM renderer's hand-only retained state. It owns the cosmetic translate channel for a locally held card,
// readable-hand membership and the inverse stamps that make that cosmetic move input-correct. Scene traversal,
// tween ownership and generic interaction stay outside behind small live getters: maps are replaced as deltas land.

import type { Affine } from "@/mirror/affine";
import type { HandPoseReport, HandPoseSample } from "@/mirror/handPoseProbe";
import type {
  HandRaiseUiLayer,
  InteractiveRect,
} from "@/mirror/renderer/contracts";
import {
  pointWithinPlacedRectMargin,
  type RaisedHandVisualClaim,
  type RaiseInputStamp,
} from "@/mirror/raiseInverse";
import { designPx, pxCss } from "@/mirror/stageFit";
import {
  CREATURE_HUD_NAMES,
  CREATURE_POWER_ROW_H,
  HAND_HOLDER_TYPE,
  HAND_RAISE_PX,
  HAND_ROOT_TYPE,
  TARGETING_TYPES,
  TOOLTIP_TYPE,
} from "@/mirror/raise/constants";
import {
  creatureHudMeasure,
  isCreatureHudGroup,
  type ChildrenOf,
} from "@/mirror/raise/creatureHud";
import {
  EMPTY_CHILDREN,
  EMPTY_HAND_RAISE_PLAN,
  holderInFan,
  isHandChoiceNode,
  planHandRaise,
  type HandRaisePlan,
  type RaiseSceneIndex,
} from "@/mirror/raise/handRaisePlan";
import {
  decideHeldLift,
  heldLiftPx,
  type HeldMode,
} from "@/mirror/raise/heldLift";
import { holderLocalY, type HolderPoseEnv } from "@/mirror/raise/holderLocalY";
import {
  nodeTypeLeaf,
  type MirrorNode,
} from "@/mirror/sceneTree";

export interface HandRecord {
  id: string;
  el: HTMLElement | null;
  lastNode: MirrorNode | null;
  cParentGlobal: Affine | null;
  spreadDx: number;
  spreadFieldMode: number;
  raiseDy: number;
  raiseTransition: string | null;
  raiseTransitionUntil: number;
  tweenTransformUntil: number;
  tweenTransformTransition: string | null;
  tweenTransformEndG6: Affine | null;
  tweenTransformSettleEndG6: Affine | null;
  tweenPinCatchup: unknown | null;
  style: Map<string, string>;
}

export interface HandControllerPorts<R extends HandRecord> {
  stage: HTMLElement;
  records: () => Map<string, R>;
  nodes: () => Map<string, MirrorNode>;
  childIds: () => Map<string, string[]>;
  geometryEpoch: () => number;
  markGeometryDirty: () => void;
  now: () => number;
  spreadFactor: () => number;
  interactiveRects: () => InteractiveRect[];
  liftEndpointToGlobal: (record: R, transform: number[]) => Affine;
  composeTweenTransition: (record: R) => string;
  collectSubtreeIds: (id: string, out: Set<string>) => void;
  isCombatPileContainer: (node: MirrorNode) => boolean;
  coverAbove: (id: string) => boolean;
  recordHasFlight: (record: R) => boolean;
  drawnGlobalOfElement: (el: HTMLElement) => Affine;
  drawnGlobalY: (id: string | null) => number | null;
  isArmedHand: (record: R) => boolean;
  queueRaisedArmWrite: (write: () => void) => void;
  noteRaisedArmPrime: () => void;
  noteLandingGone: (id: string) => void;
}

export interface HandController<R extends HandRecord> {
  readonly handHolderIds: Set<string>;
  readonly handHitboxIds: Map<string, string>;
  readonly raisedRectDy: Map<string, number>;
  heldCardId(): string | null;
  heldCardEl(): HTMLElement | null;
  heldGestureIds(): Set<string> | null;
  isHeld(id: string): boolean;
  isTargeting(id: string): boolean;
  registerNode(id: string, node: MirrorNode, leaf: string, record: R): void;
  removeTargeting(id: string): void;
  removeVisibleTooltip(el: HTMLElement): void;
  removeHandRaiseAnchor(id: string): void;
  forgetRecord(id: string): void;
  clearCosmetics(record: R): void;
  applyHeldLift(): void;
  applyHandRaise(): void;
  setHeldCard(
    id: string | null,
    gameX: number,
    gameY: number,
    mode?: HeldMode,
  ): void;
  setRaiseHandCards(enabled: boolean): void;
  raiseInputStamps(): RaiseInputStamp[];
  raisedHandVisualClaimAt(clientX: number, clientY: number): RaisedHandVisualClaim | null;
  raisedHandTouchTargetClaim(touchTargetId: string): RaisedHandVisualClaim | null;
  handPresent(): boolean;
  handRaiseUiLayer(): HandRaiseUiLayer;
  handRaiseDebug(): Record<string, unknown>;
  handPoses(): HandPoseReport;
  dispose(): void;
}

export function createHandController<R extends HandRecord>(
  p: HandControllerPorts<R>,
): HandController<R> {
  // Touch gesture state is deliberately retained outside an individual scene walk. In particular the element and
  // subtree snapshot are needed after a removed record has already left `records`: the pool must not recycle the
  // shell still owned by the finger. The live record wins once a re-created id exists.
  let heldCardId: string | null = null;
  let heldCardEl: HTMLElement | null = null;
  let heldGestureIds: Set<string> | null = null;
  let heldFingerY = 0;
  let heldMode: HeldMode = "drag";
  let heldLifted = false;
  let dragStartY: number | null = null;
  let heldEnteredPlayZone = false;
  const activeTargetingArrows = new Set<string>();

  // Readable-hand membership is maintained during the renderer's DFS, not rebuilt by scanning every pointer move.
  // The planner receives these live collections only when it applies a pass, so toggling the setting or starting a
  // local drag updates a settled scene immediately without waiting for producer traffic.
  let handRaiseEnabled = false;
  const handHolderIds = new Set<string>();
  const handHitboxIds = new Map<string, string>();
  let handRootId: string | null = null;
  const handChoiceMarkerIds = new Set<string>();
  const creatureHudIds = new Map<string, string>();
  const raisedRectDy = new Map<string, number>();
  const nextRaisedRectDy = new Map<string, number>();
  let lastHandLift = 0;
  let lastHandRaisePlan: HandRaisePlan = EMPTY_HAND_RAISE_PLAN;
  let raiseInputStampsCache: RaiseInputStamp[] | null = null;
  let raiseInputStampsEpoch = -1;
  // A tooltip is raised by the same cosmetic channel as the held card, but only after one rest paint. Its own rAF
  // belongs here so teardown cannot leave a callback from an old renderer writing into a new stage.
  const visibleTooltipEls = new Set<HTMLElement>();
  const handRaiseAnchorIds = new Set<string>();
  let tooltipRaf = 0;

  const childrenOf: ChildrenOf = (id) => p.childIds().get(id) ?? EMPTY_CHILDREN;
  const records = () => p.records();
  const nodes = () => p.nodes();

  function currentLiftPx(): number {
    return heldLiftPx(heldCardId != null, heldMode, heldLifted);
  }

  // LAYOUT SPACE (stageFit.ts): `translate` is a rendered offset on a layout-space box, and the lift/raise amounts
  // are design px off the raise planner. Converting inside the two string producers keeps every idempotence check
  // (`el.style.translate !== …`) comparing like with like, which is what stops a factor change from writing the
  // whole hand twice. Both are byte-identical on the default arm.
  function tooltipLiftTranslate(): string {
    const lift = currentLiftPx();
    return lift > 0 ? `0px ${pxCss(-lift)}` : "0px";
  }

  function flushTooltipLift(): void {
    const translate = tooltipLiftTranslate();
    for (const el of visibleTooltipEls) {
      if (el.style.translate !== translate) {
        el.style.translate = translate;
      }
    }
  }

  function tooltipLiftPending(): boolean {
    if (visibleTooltipEls.size === 0) {
      return false;
    }
    const translate = tooltipLiftTranslate();
    for (const el of visibleTooltipEls) {
      if (el.style.translate !== translate) {
        return true;
      }
    }
    return false;
  }

  // A fresh tip deliberately rests for one paint before it rises. Reusing a pending frame would let it skip that
  // paint and pop; the visit-time registration below cancels/re-arms in exactly that case. The no-op check matters
  // because held-card movement reasserts this on every pointer update, while style writes invalidate the element.
  function scheduleTooltipLift(): void {
    if (typeof requestAnimationFrame !== "function") {
      flushTooltipLift();
      return;
    }
    if (tooltipRaf || !tooltipLiftPending()) {
      return;
    }
    tooltipRaf = requestAnimationFrame(() => {
      tooltipRaf = 0;
      flushTooltipLift();
    });
  }

  /** Reassert a held lift after a re-created card or targeting edge; its decision is shared with canvas. */
  function applyHeldLift(): void {
    const record = heldCardId != null ? records().get(heldCardId) : undefined;
    const el = record?.el;
    if (el && nodeTypeLeaf(record.lastNode?.nodeType ?? "") === "NCard") {
      const decided = decideHeldLift({
        mode: heldMode,
        targeting: activeTargetingArrows.size > 0,
        fingerY: heldFingerY,
        dragStartY,
        lifted: heldLifted,
        enteredPlayZone: heldEnteredPlayZone,
      });
      heldLifted = decided.lifted;
      heldEnteredPlayZone = decided.enteredPlayZone;
      const translate = heldLifted ? `0px ${pxCss(-currentLiftPx())}` : "0px";
      if (el.style.translate !== translate) el.style.translate = translate;
    }
    scheduleTooltipLift();
  }

  function setHeldCard(
    id: string | null,
    _gameX: number,
    gameY: number,
    mode: HeldMode = "drag",
  ): void {
    heldFingerY = gameY;
    if (id !== heldCardId) {
      if (heldCardId != null) {
        const previous = records().get(heldCardId)?.el;
        if (previous) previous.style.translate = "0px";
      }
      heldCardId = id;
      heldCardEl = id === null ? null : (records().get(id)?.el ?? null);
      if (id === null) {
        heldGestureIds = null;
      } else {
        heldGestureIds = new Set<string>();
        p.collectSubtreeIds(id, heldGestureIds);
      }
      heldMode = mode;
      heldLifted = false;
      dragStartY = gameY;
      heldEnteredPlayZone = false;
      activeTargetingArrows.clear();
      for (const tip of visibleTooltipEls) tip.style.translate = "0px";
      visibleTooltipEls.clear();
    } else {
      heldMode = mode;
    }
    applyHeldLift();
    applyHandRaise();
  }

  function holderInFanHere(id: string): boolean {
    return holderInFan(nodes(), id);
  }

  // Endpoint ownership deliberately lasts until tween collection (including pending catch-up), not merely its
  // nominal deadline. Otherwise the still-painted endpoint and the ramp source disagree for one hand pass: the
  // holder can fall through the full lift for one frame before its producer pose catches up.
  function holderPoseEnv(record: R): HolderPoseEnv {
    return {
      nodes: nodes(),
      parentGlobalY: () => record.cParentGlobal?.[5] ?? null,
      liveEndpointY: () => {
        const pinned =
          record.tweenTransformUntil !== 0 || record.tweenPinCatchup != null;
        return pinned
          ? (record.tweenTransformEndG6?.[5] ?? null)
          : (record.tweenTransformSettleEndG6?.[5] ?? null);
      },
    };
  }

  function holderLocalYHere(id: string, record: R): number | null {
    return holderLocalY(holderPoseEnv(record), id);
  }

  // This object is rebuilt per pass but contains only live references. Copying the small registries would make a
  // pass see stale membership after an in-walk reparent or visibility flip.
  function raiseSceneIndex(): RaiseSceneIndex {
    return {
      nodes: nodes(),
      childrenOf,
      holders: handHolderIds,
      handRootId,
      handHitboxes: handHitboxIds,
      creatureGroups: creatureHudIds,
      targeting: activeTargetingArrows.size > 0,
      choicePrompt: handChoiceMarkerIds.size > 0,
      holderLocalY: (id) => {
        const record = records().get(id);
        return record ? holderLocalYHere(id, record) : null;
      },
    };
  }

  function raiseTranslate(dy: number): string {
    return dy === 0 ? "0px" : `0px ${pxCss(dy)}`;
  }
  function needsRaiseWrite(el: HTMLElement, dy: number): boolean {
    return (
      el.style.translate !== raiseTranslate(dy) &&
      !(dy === 0 && el.style.translate === "")
    );
  }
  function writeRaiseTranslate(el: HTMLElement, dy: number): void {
    if (needsRaiseWrite(el, dy)) el.style.translate = raiseTranslate(dy);
  }
  function tweenRaiseDeadline(record: R, transition: string | null): number {
    return transition != null && transition !== "translate 0s"
      ? record.tweenTransformUntil
      : 0;
  }

  // Both transform and translate are primed before either endpoint is committed. One renderer-owned barrier then
  // releases them, so a handoff cannot show transform from one clock and raise from another. This controller owns
  // only translate; tweenController remains the single owner of transform timing and the barrier itself.
  function dualPrimeRaisedArm(
    record: R,
    el: HTMLElement,
    dy: number,
    transition: string | null,
  ): void {
    const cs = window.getComputedStyle(el);
    const transform =
      cs.transform && cs.transform !== "none"
        ? cs.transform
        : el.style.transform;
    const translate =
      cs.translate && cs.translate !== "none"
        ? cs.translate
        : el.style.translate;
    const target = raiseTranslate(dy);
    const transformTransition = record.tweenTransformTransition;
    record.tweenTransformTransition = "transform 0s";
    record.raiseTransition = "translate 0s";
    el.style.transition = p.composeTweenTransition(record);
    el.style.transform = transform;
    record.style.set("transform", transform);
    el.style.translate = translate && translate !== "none" ? translate : target;
    record.tweenTransformTransition = transformTransition;
    record.raiseTransition = transition;
    record.raiseTransitionUntil = tweenRaiseDeadline(record, transition);
    p.noteRaisedArmPrime();
    p.queueRaisedArmWrite(() => {
      el.style.transition = p.composeTweenTransition(record);
      el.style.translate = target;
    });
  }

  function handRaiseTransition(record: R, liftChanged: boolean): string | null {
    if (liftChanged) {
      return null;
    }
    if (
      record.tweenTransformUntil <= p.now() ||
      !record.tweenTransformTransition
    ) {
      return "translate 0s";
    }
    return record.tweenTransformTransition.replace(/^transform\b/, "translate");
  }

  function applyHandRaise(): void {
    raiseInputStampsCache = null;
    lastHandRaisePlan = planHandRaise(raiseSceneIndex(), {
      enabled: handRaiseEnabled,
      heldCardId,
      heldMode,
    });
    const plan = lastHandRaisePlan;
    const liftChanged = plan.liftPx !== lastHandLift;
    lastHandLift = plan.liftPx;
    for (const id of handHolderIds) {
      const record = records().get(id);
      const el = record?.el;
      if (!record || !el) {
        continue;
      }
      const dy = plan.offsets.get(id)?.dy ?? 0;
      const needsWrite = needsRaiseWrite(el, dy);
      const transition =
        plan.liftPx > 0 ? handRaiseTransition(record, liftChanged) : null;
      const rearming =
        !needsWrite &&
        record.raiseTransition != null &&
        record.raiseTransitionUntil > p.now() &&
        record.tweenTransformUntil > p.now();
      if (p.isArmedHand(record) && (needsWrite || rearming)) {
        dualPrimeRaisedArm(record, el, dy, transition);
      } else if (needsWrite) {
        if (record.raiseTransition !== transition) {
          record.raiseTransition = transition;
          el.style.transition = p.composeTweenTransition(record);
        }
        el.style.translate = raiseTranslate(dy);
        record.raiseTransitionUntil = tweenRaiseDeadline(record, transition);
      }
      record.raiseDy = dy;
    }
    for (const id of creatureHudIds.keys()) {
      const record = records().get(id);
      if (!record?.el) {
        continue;
      }
      const dy = plan.offsets.get(id)?.dy ?? 0;
      writeRaiseTranslate(record.el, dy);
      record.raiseDy = dy;
    }
    for (const [id, dy] of plan.movedRectDy) nextRaisedRectDy.set(id, dy);
    if (!sameRaisedRectDy(nextRaisedRectDy)) {
      raisedRectDy.clear();
      for (const [id, dy] of nextRaisedRectDy) raisedRectDy.set(id, dy);
      p.markGeometryDirty();
    }
    nextRaisedRectDy.clear();
  }

  function sameRaisedRectDy(next: Map<string, number>): boolean {
    if (next.size !== raisedRectDy.size) {
      return false;
    }
    for (const [id, dy] of next) {
      if (raisedRectDy.get(id) !== dy) {
        return false;
      }
    }
    return true;
  }

  function registerNode(
    id: string,
    node: MirrorNode,
    leaf: string,
    record: R,
  ): void {
    if (
      heldCardId != null &&
      record.el &&
      id === heldCardId &&
      leaf === "NCard"
    ) {
      applyHeldLift();
    }
    if (TARGETING_TYPES.has(leaf)) {
      const before = activeTargetingArrows.size;
      if (node.visible) {
        activeTargetingArrows.add(id);
      } else {
        activeTargetingArrows.delete(id);
      }
      if (activeTargetingArrows.size !== before && heldCardId != null) {
        applyHeldLift();
      }
    }
    if (leaf === HAND_HOLDER_TYPE) {
      if (record.el) {
        handHolderIds.add(id);
      } else {
        handHolderIds.delete(id);
      }
    } else if (leaf === HAND_ROOT_TYPE) {
      handRootId = id;
    } else if (node.name === "Hitbox") {
      const holderId = node.parentId;
      if (
        holderId != null &&
        nodeTypeLeaf(nodes().get(holderId)?.nodeType ?? "") === HAND_HOLDER_TYPE
      ) {
        handHitboxIds.set(id, holderId);
      }
    }
    if (p.isCombatPileContainer(node)) {
      if (node.visible && record.el) {
        handRaiseAnchorIds.add(id);
      } else {
        handRaiseAnchorIds.delete(id);
      }
    }
    if (isHandChoiceNode(node, leaf)) {
      if (node.visible) {
        handChoiceMarkerIds.add(id);
      } else {
        handChoiceMarkerIds.delete(id);
      }
    }
    if (CREATURE_HUD_NAMES.has(node.name)) {
      const root = isCreatureHudGroup(nodes(), node) ? node.parentId : null;
      if (root != null && record.el) {
        creatureHudIds.set(id, root);
      } else {
        creatureHudIds.delete(id);
      }
    }
    if (heldCardId != null && leaf === TOOLTIP_TYPE && record.el) {
      if (node.visible) {
        if (!visibleTooltipEls.has(record.el)) {
          visibleTooltipEls.add(record.el);
          record.el.classList.add("mirror-card-liftable");
          record.el.style.translate = "0px";
          if (tooltipRaf) {
            if (typeof cancelAnimationFrame === "function")
              cancelAnimationFrame(tooltipRaf);
            tooltipRaf = 0;
          }
        }
        scheduleTooltipLift();
      } else {
        visibleTooltipEls.delete(record.el);
        record.el.style.translate = "0px";
      }
    }
  }

  function setRaiseHandCards(enabled: boolean): void {
    if (enabled === handRaiseEnabled) {
      return;
    }
    handRaiseEnabled = enabled;
    applyHandRaise();
  }

  function handPresent(): boolean {
    return handHolderIds.size > 0;
  }

  // The browser button follows a combat pile rather than a synthetic screen coordinate. A pile can be covered by a
  // higher scene layer, so report its actual DOM anchor and cover state; consumers decide whether to show chrome.
  function handRaiseUiLayer(): HandRaiseUiLayer {
    if (!handPresent())
      return {
        present: false,
        anchorId: null,
        domTarget: null,
        covered: false,
        backend: "dom",
      };
    for (const id of handRaiseAnchorIds) {
      const record = records().get(id);
      if (record?.el && record.lastNode?.visible) {
        return {
          present: true,
          anchorId: id,
          domTarget: record.el,
          covered: p.coverAbove(id),
          backend: "dom",
        };
      }
    }
    return {
      present: false,
      anchorId: null,
      domTarget: null,
      covered: false,
      backend: "dom",
    };
  }

  function creatureChildNamed(rootId: string, name: string): string | null {
    for (const id of childrenOf(rootId)) {
      if (nodes().get(id)?.name === name) {
        return id;
      }
    }
    return null;
  }

  // Report the plan that drew the current frame, never a newly derived plan. Recomputing here would make the seam
  // describe producer state that has already changed instead of the gates and offsets the viewer actually saw.
  function handRaiseDebug(): Record<string, unknown> {
    const gates = lastHandRaisePlan.gates;
    return {
      enabled: handRaiseEnabled,
      liftPx: lastHandRaisePlan.liftPx,
      maxLiftPx: HAND_RAISE_PX,
      targetingArrows: activeTargetingArrows.size,
      choicePrompt: gates.choicePrompt,
      dragging: gates.dragging,
      dimmed: gates.dimmed,
      handRootId,
      holders: [...handHolderIds].map((id) => {
        const record = records().get(id);
        const node = nodes().get(id);
        const parent =
          node?.parentId != null ? nodes().get(node.parentId) : undefined;
        return {
          id,
          name: node?.name ?? null,
          parentName: parent?.name ?? null,
          localY: record ? holderLocalYHere(id, record) : null,
          hasTransform: node?.transform != null,
          tweenEndY:
            record != null &&
            (record.tweenTransformUntil > p.now() ||
              record.tweenPinCatchup != null)
              ? (record.tweenTransformEndG6?.[5] ?? null)
              : null,
          dy: record?.raiseDy ?? null,
          translate: record?.el?.style.translate ?? null,
        };
      }),
      creatureGroups: creatureHudIds.size,
      creatureGroupRows: [...creatureHudIds].map(([id, rootId]) => {
        const record = records().get(id);
        const node = nodes().get(id);
        const streamedY =
          record && node?.transform != null
            ? p.liftEndpointToGlobal(record, node.transform)[5]
            : null;
        const dy = record?.raiseDy ?? 0;
        return {
          id,
          rootId,
          name: node?.name ?? null,
          dy,
          streamedY,
          drawnY: streamedY === null ? null : streamedY + dy,
        };
      }),
      creatures: [...new Set(creatureHudIds.values())].map((rootId) => {
        const measure = creatureHudMeasure(nodes(), childrenOf, rootId);
        const reticleY = p.drawnGlobalY(
          creatureChildNamed(rootId, "SelectionReticle"),
        );
        const displayY = p.drawnGlobalY(
          creatureChildNamed(rootId, "HealthBar"),
        );
        const powerBottomY =
          displayY === null
            ? null
            : displayY +
              (measure.powerTop - measure.displayTop) +
              CREATURE_POWER_ROW_H;
        return {
          rootId,
          ...measure,
          reticleDrawnY: reticleY,
          displayDrawnY: displayY,
          powerBottomY,
          powerGap:
            reticleY === null || powerBottomY === null
              ? null
              : reticleY - powerBottomY,
        };
      }),
      stamps: raiseInputStamps().length,
    };
  }

  // Stamps derive from the same rect cache that generic interaction uses and are cached against its geometry epoch.
  // Hand hitboxes are retained even at dy 0: the focused card is already game-raised and must still beat an
  // overlapping neighbour during claim arbitration. Input capture freezes this published list at press time; this
  // controller only invalidates it when the drawn moved-surface set actually changes.
  function raiseInputStamps(): RaiseInputStamp[] {
    if (
      raiseInputStampsCache !== null &&
      raiseInputStampsEpoch === p.geometryEpoch()
    )
      return raiseInputStampsCache;
    const out: RaiseInputStamp[] = [];
    if (raisedRectDy.size > 0) {
      const hand: Array<{ stamp: RaiseInputStamp; z: number; order: number }> =
        [];
      for (const rect of p.interactiveRects()) {
        const holderId = handHitboxIds.get(rect.id);
        if (holderId !== undefined) {
          const stamp: RaiseInputStamp = {
            transform: rect.transform,
            localRect: rect.localRect,
            spreadDx: rect.spreadDx,
            dy: rect.raiseDy,
            ownerId: holderId,
          };
          hand.push({
            stamp,
            z: nodes().get(holderId)?.zIndex ?? 0,
            order: hand.length,
          });
        } else if (rect.raiseDy !== 0) {
          out.push({
            transform: rect.transform,
            localRect: rect.localRect,
            spreadDx: rect.spreadDx,
            dy: rect.raiseDy,
          });
        }
      }
      // z lifts before wire sibling order changes; stable z+wire ordering is the visible order at focus onset.
      hand.sort((a, b) => a.z - b.z || a.order - b.order);
      for (const item of hand) out.push(item.stamp);
    }
    raiseInputStampsCache = out;
    raiseInputStampsEpoch = p.geometryEpoch();
    return out;
  }

  function currentHandHitboxContains(holderId: string, clientX: number, clientY: number): boolean {
    const stageRect = p.stage.getBoundingClientRect();
    // LAYOUT SPACE (stageFit.ts): the stage's own inline box is DISPLAY px on the `?stageFit=display` arm, so
    // reading it raw would make this ratio the identity and hand `pointWithinPlacedRectMargin` display px to test
    // against a WIRE `localRect`. `designPx` puts the measurement back where the wire lives; it is the identity on
    // the default arm, where the inline box already is the design box.
    const designWidth = designPx(Number.parseFloat(p.stage.style.width) || p.stage.clientWidth);
    const designHeight = designPx(Number.parseFloat(p.stage.style.height) || p.stage.clientHeight);
    if (stageRect.width <= 0 || stageRect.height <= 0 || designWidth <= 0 || designHeight <= 0) return false;
    const x = (clientX - stageRect.left) * designWidth / stageRect.width;
    const y = (clientY - stageRect.top) * designHeight / stageRect.height;
    for (const [hitboxId, ownerId] of handHitboxIds) {
      if (ownerId !== holderId) continue;
      const node = nodes().get(hitboxId);
      const el = records().get(hitboxId)?.el;
      if (!node?.localRect || !el) continue;
      if (pointWithinPlacedRectMargin(p.drawnGlobalOfElement(el), node.localRect, x, y)) return true;
    }
    return false;
  }

  /**
   * A painted descendant identifies a candidate owner, but glow/frame pixels alone are not a hand claim.  The
   * same holder's CURRENT rendered hitbox (plus the bounded art-overhang) must contain the raw stage pixel too.
   * That keeps a reflow's live footprint authoritative without accepting a card's broad glow.
   */
  function raisedHandVisualClaimAt(clientX: number, clientY: number): RaisedHandVisualClaim | null {
    if (raisedRectDy.size === 0 || typeof document === "undefined" || typeof document.elementsFromPoint !== "function") {
      return null;
    }
    for (const element of document.elementsFromPoint(clientX, clientY)) {
      if (!(element instanceof Element)) continue;
      const painted = element.closest<HTMLElement>("[data-node-id][data-paints]");
      const id = painted?.getAttribute("data-node-id");
      if (!id) continue;
      let current: string | null | undefined = id;
      let guard = 0;
      while (current != null && guard++ < 256) {
        if (handHolderIds.has(current) && holderInFanHere(current)) {
          if (currentHandHitboxContains(current, clientX, clientY)) return { ownerId: current };
          // A foreground glow/frame is not a claim, but it must not mask a lower painted hand card whose own
          // current footprint does contain this pixel.
          break;
        }
        current = nodes().get(current)?.parentId;
      }
    }
    return null;
  }

  /**
   * `touchStackAt` has already established this exact NCard as the top interactive target. Bridge that precise
   * provenance to its current in-fan holder without treating decorative glow pixels as a coordinate claim. The
   * input boundary admits only card-classified top touch targets, never arbitrary descendants.
   */
  function raisedHandTouchTargetClaim(touchTargetId: string): RaisedHandVisualClaim | null {
    if (raisedRectDy.size === 0) return null;
    let current: string | null | undefined = touchTargetId;
    let guard = 0;
    while (current != null && guard++ < 256) {
      if (!handHolderIds.has(current) || !holderInFanHere(current)) {
        current = nodes().get(current)?.parentId;
        continue;
      }
      for (const [hitboxId, ownerId] of handHitboxIds) {
        // A focused holder is already at the game's native Y, so it deliberately has no movedRectDy entry.
        // The hand remains visibly raised as a MODE because its neighbours are lifted; the exact top card target
        // still proves this holder's ownership through a subsequent touch-down.
        if (ownerId === current) return { ownerId: current };
      }
      return null;
    }
    return null;
  }

  // DOM measures rendered matrices rather than restating them; the canvas arm reports its calculated draw matrix.
  function handPoses(): HandPoseReport {
    const holders: HandPoseSample[] = [];
    for (const id of handHolderIds) {
      const record = records().get(id);
      const node = nodes().get(id);
      if (!record || !node) {
        continue;
      }
      const own = node.transform;
      const mGame =
        own != null
          ? p.liftEndpointToGlobal(record, own)
          : record.cParentGlobal;
      if (mGame == null) {
        continue;
      }
      const pinned =
        record.tweenTransformUntil > p.now() || record.tweenPinCatchup != null;
      let hitboxId: string | null = null;
      let cardId: string | null = null;
      let cardContentKey: string | null = null;
      for (const childId of childrenOf(id)) {
        const child = nodes().get(childId);
        if (child?.name === "Hitbox") {
          hitboxId = childId;
        } else if (child && nodeTypeLeaf(child.nodeType) === "NCard") {
          cardId = childId;
          cardContentKey = child.contentKey;
        }
      }
      holders.push({
        id,
        name: node.name,
        inFan: holderInFanHere(id),
        mGame,
        mDrawn: record.el ? p.drawnGlobalOfElement(record.el) : mGame,
        spreadDx: record.spreadDx,
        fieldMode: record.spreadFieldMode,
        raiseDy: record.raiseDy,
        zIndex: node.zIndex ?? 0,
        hitboxId,
        cardId,
        cardContentKey,
        endpoint: pinned ? record.tweenTransformEndG6 : null,
        channelLive: pinned || p.recordHasFlight(record),
      });
    }
    return {
      stage: "dom",
      atMs: p.now(),
      spreadFactor: p.spreadFactor(),
      handPresent: handPresent(),
      holders,
    };
  }

  function removeTargeting(id: string): void {
    activeTargetingArrows.delete(id);
  }
  function removeVisibleTooltip(el: HTMLElement): void {
    visibleTooltipEls.delete(el);
  }
  function removeHandRaiseAnchor(id: string): void {
    handRaiseAnchorIds.delete(id);
  }
  function forgetRecord(id: string): void {
    p.noteLandingGone(id);
    handHolderIds.delete(id);
    handHitboxIds.delete(id);
    handChoiceMarkerIds.delete(id);
    creatureHudIds.delete(id);
    raisedRectDy.delete(id);
    if (handRootId === id) handRootId = null;
  }

  // A parked/adopted shell must lose every hand-owned channel before it can represent another card. Leaving a
  // raised/held translate on a pooled shell would give its successor an offset that no membership pass owns.
  function clearCosmetics(record: R): void {
    if (record.el && record.el.style.translate !== "")
      record.el.style.translate = "";
    record.raiseDy = 0;
    record.raiseTransition = null;
    record.raiseTransitionUntil = 0;
  }

  function dispose(): void {
    if (tooltipRaf && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(tooltipRaf);
    }
    tooltipRaf = 0;
    activeTargetingArrows.clear();
    handHolderIds.clear();
    handRaiseAnchorIds.clear();
    handHitboxIds.clear();
    handChoiceMarkerIds.clear();
    creatureHudIds.clear();
    raisedRectDy.clear();
    nextRaisedRectDy.clear();
    handRootId = null;
    raiseInputStampsCache = null;
    visibleTooltipEls.clear();
  }

  return {
    handHolderIds,
    handHitboxIds,
    raisedRectDy,
    heldCardId: () => heldCardId,
    heldCardEl: () => heldCardEl,
    heldGestureIds: () => heldGestureIds,
    isHeld: (id) => heldCardId === id,
    isTargeting: (id) => activeTargetingArrows.has(id),
    registerNode,
    removeTargeting,
    removeVisibleTooltip,
    removeHandRaiseAnchor,
    forgetRecord,
    clearCosmetics,
    applyHeldLift,
    applyHandRaise,
    setHeldCard,
    setRaiseHandCards,
    raiseInputStamps,
    raisedHandVisualClaimAt,
    raisedHandTouchTargetClaim,
    handPresent,
    handRaiseUiLayer,
    handRaiseDebug,
    handPoses,
    dispose,
  };
}
