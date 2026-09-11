import { godotEasingToCss } from "@godot-scene-web/html";
import type { Affine } from "@/mirror/affine";
import type { MirrorNode, MirrorState } from "@/mirror/sceneTree";
const PRIME_PIN_GRACE_MS = 250;
const HIDE_LATCH_GRACE_MS = 400;
const HIDE_LATCH_ALPHA_EPS = 0.01;
const HIDE_LATCH_RESTING_EPS = 0.02;
const HIDE_LATCH_HELD_RESTORE_MS = 150;
import {
  cancelParityWatch,
  handParityEnabled,
  HAND_PARITY_WATCH_MS,
  noteHandParity,
  notePostSettleSnap,
} from "./handParity";
import type { RenderRecord } from "./recordModel";

type Placement = {
  transform: string | null;
  transformOrigin?: string | null;
  spreadDx?: number;
  gShifted?: readonly number[];
};

export interface TweenControllerPorts {
  records: Map<string, RenderRecord>;
  nodeOf: (id: string) => MirrorNode | undefined;
  hasNode: (id: string) => boolean;
  childrenOf: (id: string) => readonly string[];
  walkNow: () => number;
  now: () => number;
  stage: HTMLElement;
  placement: (
    record: RenderRecord,
    g6: readonly number[],
    parentInv?: Affine,
  ) => Placement;
  liftEndpoint: (record: RenderRecord, endpoint: number[]) => Affine;
  cssLinear: (
    transform: string | undefined,
  ) => [number, number, number, number] | null;
  handHolderIds: Set<string>;
  applyHandRaise: () => void;
  applyViewScale: () => void;
  applyTipScale: () => void;
  noteDeadline: (at: number) => void;
  schedule: () => void;
  queueDeraster: (el: HTMLElement) => void;
  derasterNeeded: (record: RenderRecord) => boolean;
  markGeometryDirty: () => void;
  noteReparentDrop: () => void;
  noteHintRebased: () => void;
  beginTransformArmBatch: () => void;
  clearTransformArmBatch: () => void;
  noteArmedHand: (record: RenderRecord) => void;
  takeTransformArmBatch: () => {
    needsPrimeBarrier: boolean;
    raiseWrites: Array<() => void>;
  };
  noteLanding?: (
    record: RenderRecord,
    endpoint: readonly number[],
    placed: Placement,
    until: number,
  ) => void;
}

export interface TweenController {
  readonly activeCount: number;
  has(record: RenderRecord): boolean;
  forget(record: RenderRecord): void;
  clear(): void;
  composeTransition(record: RenderRecord): string;
  pin(
    record: RenderRecord,
    map: Record<string, string>,
  ): Record<string, string>;
  applyHints(state: MirrorState): void;
  tick(now: number): number;
  writeFlightTransform(
    record: RenderRecord,
    g6: number[],
    until: number,
    parentInv?: Affine,
  ): number;
}

/**
 * Declarative tween/pin runtime. The renderer retains flat records and the walk; this owns only live tween state.
 * In particular, a prime owns the channel until its deferred arm runs so streamed truth cannot paint in that gap.
 */
export function createTweenController(
  p: TweenControllerPorts,
): TweenController {
  const active = new Set<RenderRecord>();
  let pending: Array<(at: number) => void> = [];
  let armRaf = 0;
  let batch: { writes: Array<() => void> } | null = null;

  const composeTransition = (r: RenderRecord): string =>
    [r.tweenTransformTransition, r.tweenOpacityTransition, r.raiseTransition]
      .filter((part): part is string => !!part)
      .join(", ");

  function releaseTransform(r: RenderRecord): void {
    r.tweenTransform = null;
    r.tweenTransformOrigin = null;
    r.tweenTransformUntil = 0;
    r.tweenTransformTransition = null;
    r.tweenTransformEndG6 = null;
    r.tweenTransformParentId = undefined;
    r.tweenPreArmLinear = null;
    r.tweenPinStreamed = null;
    r.tweenPinCatchup = null;
    r.tweenPinCatchupOrigin = null;
    cancelParityWatch(r);
    if (r.el) r.el.style.transition = composeTransition(r);
    if (r.tweenOpacityUntil === 0 && r.tweenSelfOpacityUntil === 0)
      active.delete(r);
    p.markGeometryDirty();
  }

  function armTransform(
    r: RenderRecord,
    g6: readonly number[],
    transition: string,
    until: number,
    group: string | null,
  ): void {
    const el = r.el;
    if (!el || !r.lastNode) return;
    const placed = p.placement(r, g6);
    if (placed.transform == null) return;
    p.noteLanding?.(r, g6, placed, until);
    cancelParityWatch(r);
    if (r.tweenTransformUntil === 0) {
      r.tweenPreArmLinear = p.cssLinear(r.style.get("transform"));
      r.tweenPinStreamed = r.style.get("transform") ?? null;
    }
    r.tweenPinCatchup = null;
    r.tweenPinCatchupOrigin = null;
    r.tweenTransform = placed.transform;
    r.tweenTransformOrigin = placed.transformOrigin ?? null;
    r.tweenTransformUntil = until;
    r.tweenTransformTransition = transition;
    r.tweenTransformParentId = p.nodeOf(r.id)?.parentId ?? null;
    r.tweenTransformEndG6 = g6 as Affine;
    r.tweenTransformSettleEndG6 = null;
    r.tweenGroup = group;
    p.noteDeadline(until);
    p.markGeometryDirty();
    const write = () => {
      el.style.transition = composeTransition(r);
      el.style.transform = placed.transform!;
      r.style.set("transform", placed.transform!);
      if (placed.transformOrigin != null) {
        el.style.transformOrigin = placed.transformOrigin;
        r.style.set("transformOrigin", placed.transformOrigin);
      }
    };
    if (batch) {
      batch.writes.push(write);
      if (p.handHolderIds.has(r.id)) p.noteArmedHand(r);
    } else write();
    active.add(r);
  }

  function armOpacity(
    r: RenderRecord,
    value: string,
    transition: string,
    until: number,
    group: string | null,
    resting: number | null = null,
  ): void {
    if (!r.el) return;
    r.tweenOpacity = value;
    r.tweenOpacityUntil = until;
    r.tweenOpacityTransition = transition;
    r.tweenGroup = group ?? r.tweenGroup;
    r.hideLatchedUntil = 0;
    r.hideLatchRestingSig = resting;
    r.hideLatchHeldAt = 0;
    r.hideLatchStreamedOpacity = null;
    p.noteDeadline(until);
    r.el.style.transition = composeTransition(r);
    r.el.style.opacity = value;
    r.style.set("opacity", value);
    active.add(r);
  }

  function armSelfOpacity(
    r: RenderRecord,
    value: string,
    transition: string,
    until: number,
    group: string | null,
  ): void {
    r.tweenSelfOpacity = value;
    r.tweenSelfOpacityUntil = until;
    r.tweenSelfOpacityTransition = transition;
    r.tweenGroup = group ?? r.tweenGroup;
    p.noteDeadline(until);
    if (r.selfLayer) {
      r.selfLayer.style.transition = transition;
      r.selfLayer.style.opacity = value;
      r.selfLayerStyle.set("opacity", value);
    }
    active.add(r);
  }

  function primeTransform(r: RenderRecord, g6: readonly number[]): void {
    if (!r.el || !r.lastNode) return;
    const placed = p.placement(r, g6);
    if (placed.transform == null) return;
    cancelParityWatch(r);
    if (r.tweenTransformUntil === 0) {
      r.tweenPreArmLinear = p.cssLinear(placed.transform);
      r.tweenPinStreamed = placed.transform;
    }
    r.tweenPinCatchup = null;
    r.tweenPinCatchupOrigin = null;
    r.tweenTransformEndG6 = g6 as Affine;
    r.tweenTransformSettleEndG6 = null;
    r.tweenTransformParentId = p.nodeOf(r.id)?.parentId ?? null;
    r.raiseTransition = null;
    r.raiseTransitionUntil = 0;
    r.el.style.transition = "none";
    r.el.style.transform = placed.transform;
    r.style.set("transform", placed.transform);
    if (placed.transformOrigin != null) {
      r.el.style.transformOrigin = placed.transformOrigin;
      r.style.set("transformOrigin", placed.transformOrigin);
    }
    r.tweenTransform = placed.transform;
    r.tweenTransformOrigin = placed.transformOrigin ?? null;
    r.tweenTransformTransition = "";
    r.tweenTransformUntil = p.now() + PRIME_PIN_GRACE_MS;
    p.noteDeadline(r.tweenTransformUntil);
    active.add(r);
    p.markGeometryDirty();
  }

  function primeOpacity(r: RenderRecord, value: string): void {
    if (!r.el) return;
    r.el.style.transition = "none";
    r.el.style.opacity = value;
    r.style.set("opacity", value);
    r.tweenOpacity = value;
    r.tweenOpacityTransition = "";
    r.tweenOpacityUntil = p.now() + PRIME_PIN_GRACE_MS;
    p.noteDeadline(r.tweenOpacityUntil);
    active.add(r);
  }

  function primeSelfOpacity(r: RenderRecord, value: string): void {
    r.tweenSelfOpacity = value;
    r.tweenSelfOpacityTransition = "";
    r.tweenSelfOpacityUntil = p.now() + PRIME_PIN_GRACE_MS;
    p.noteDeadline(r.tweenSelfOpacityUntil);
    active.add(r);
    if (r.selfLayer) {
      r.selfLayer.style.transition = "none";
      r.selfLayer.style.opacity = value;
      r.selfLayerStyle.set("opacity", value);
    }
  }

  function pin(
    r: RenderRecord,
    map: Record<string, string>,
  ): Record<string, string> {
    const now = p.walkNow();
    if (handParityEnabled && r.parityWatchUntil !== 0)
      notePostSettleSnap(r, map.transform ?? null, now);
    if (
      r.tweenTransformUntil === 0 &&
      r.tweenOpacityUntil === 0 &&
      r.hideLatchedUntil === 0
    )
      return map;
    if (
      r.tweenTransformUntil > now &&
      r.tweenTransformParentId !== undefined &&
      r.tweenTransformParentId !== (p.nodeOf(r.id)?.parentId ?? null)
    ) {
      releaseTransform(r);
      p.noteReparentDrop();
    }
    if (r.tweenTransformUntil > now && r.tweenTransform) {
      if (map.transform != null) {
        if (r.tweenPinStreamed == null) r.tweenPinStreamed = map.transform;
        else if (r.tweenPinStreamed !== map.transform) {
          r.tweenPinStreamed = map.transform;
          r.tweenPinCatchup = map.transform;
          r.tweenPinCatchupOrigin = map.transformOrigin ?? null;
        }
      }
      map.transform = r.tweenTransform;
      if (r.tweenTransformOrigin != null)
        map.transformOrigin = r.tweenTransformOrigin;
    }
    if (r.tweenOpacityUntil > now && r.tweenOpacity != null)
      map.opacity = r.tweenOpacity;
    if (r.hideLatchedUntil !== 0 && "opacity" in map) {
      if (now >= r.hideLatchedUntil) r.hideLatchedUntil = 0;
      else {
        const incoming = Number(map.opacity);
        const sig = r.hideLatchRestingSig;
        if (incoming <= HIDE_LATCH_ALPHA_EPS) {
          r.hideLatchedUntil = 0;
          r.hideLatchHeldAt = 0;
        } else if (
          sig != null &&
          Math.abs(incoming - sig) <= HIDE_LATCH_RESTING_EPS
        ) {
          r.hideLatchStreamedOpacity = map.opacity;
          if (r.hideLatchHeldAt === 0) {
            r.hideLatchHeldAt = now;
            active.add(r);
            p.noteDeadline(now + HIDE_LATCH_HELD_RESTORE_MS);
            p.schedule();
          }
          map.opacity = "0";
        } else {
          r.hideLatchedUntil = 0;
          r.hideLatchHeldAt = 0;
        }
      }
    }
    return map;
  }

  function guard(id: string, r: RenderRecord): boolean {
    return p.records.get(id) === r;
  }
  function transformGuard(
    id: string,
    r: RenderRecord,
    parent: string | null,
  ): boolean {
    return (
      guard(id, r) && (p.nodeOf(id)?.parentId ?? null) === parent
    );
  }
  function runBatch(arms: Array<(at: number) => void>, at: number): boolean {
    batch = { writes: [] };
    p.beginTransformArmBatch();
    try {
      for (const arm of arms) arm(at);
      // Hand raise must resolve after every endpoint is owned but before endpoint DOM writes/barrier.
      p.applyHandRaise();
      const raise = p.takeTransformArmBatch();
      if (raise.needsPrimeBarrier) void p.stage.offsetWidth;
      for (const write of batch.writes) write();
      for (const write of raise.raiseWrites) write();
      return arms.length > 0;
    } finally {
      batch = null;
      p.clearTransformArmBatch();
    }
  }
  function runDeferred(): void {
    if (pending.length === 0) return;
    const arms = pending;
    pending = [];
    runBatch(arms, p.now());
    p.applyViewScale();
    p.applyTipScale();
    p.schedule();
  }
  function scheduleArms(arms: Array<(at: number) => void>): void {
    if (arms.length === 0) return;
    pending.push(...arms);
    if (armRaf !== 0 || typeof requestAnimationFrame !== "function") {
      if (armRaf === 0) runDeferred();
      return;
    }
    armRaf = requestAnimationFrame(() => {
      armRaf = 0;
      runDeferred();
    });
  }

  function applyHints(state: MirrorState): void {
    const hints = state.pendingHints;
    if (hints.length === 0) return;
    const primes: Array<() => void> = [];
    const arms: Array<(at: number) => void> = [];
    for (const hint of hints) {
      const hasTransform = hint.endTransform?.length === 6;
      const hasOpacity = hint.endOpacity != null;
      if (!hasTransform && !hasOpacity) continue;
      const target = p.records.get(hint.targetId);
      const node = target?.lastNode;
      if (!target || !node || hint.durationMs <= 0) continue;
      const duration = Math.max(0, hint.durationMs);
      const transition = `transform ${duration}ms ${godotEasingToCss(hint.ease ?? undefined, hint.trans ?? undefined)}`;
      const parentId = (p.nodeOf(hint.targetId) ?? node).parentId;
      const orphaned = parentId != null && !p.hasNode(parentId);
      const rebased = hint.parentIdAtArrival !== undefined && hint.parentIdAtArrival !== parentId;
      if (hasTransform && !orphaned && !rebased) {
        const end = p.liftEndpoint(target, hint.endTransform!);
        const start =
          hint.startTransform?.length === 6
            ? p.liftEndpoint(target, hint.startTransform)
            : null;
        if (start) primes.push(() => primeTransform(target, start));
        const generation = ++target.tweenTransformArmGeneration;
        arms.push((at) => {
          if (
            target.tweenTransformArmGeneration === generation &&
            transformGuard(hint.targetId, target, parentId)
          )
            armTransform(target, end, transition, at + duration, hint.group);
        });
      } else if (hasTransform) p.noteHintRebased();
      if (!hasOpacity) continue;
      const isSelf =
        hint.property === "self_modulate:a" ||
        hint.property === "self_modulate";
      const hasChildren = p.childrenOf(hint.targetId).length > 0;
      const modAlpha = node.modulate ? node.modulate.a : node.opacity;
      const selfAlpha = node.selfModulate ? node.selfModulate.a : 1;
      const opacityTransition = `opacity ${duration}ms ${godotEasingToCss(hint.ease ?? undefined, hint.trans ?? undefined)}`;
      if (isSelf && hasChildren) {
        if (hint.startOpacity != null)
          primes.push(() =>
            primeSelfOpacity(target, String(hint.startOpacity)),
          );
        arms.push((at) => {
          if (guard(hint.targetId, target))
            armSelfOpacity(
              target,
              String(hint.endOpacity),
              opacityTransition,
              at + duration,
              hint.group,
            );
        });
      } else if (target.el) {
        const leafSelf = hasChildren ? 1 : selfAlpha;
        const end = isSelf
          ? modAlpha * hint.endOpacity!
          : hint.endOpacity! * leafSelf;
        const start = isSelf
          ? modAlpha * (hint.startOpacity ?? 0)
          : (hint.startOpacity ?? 0) * leafSelf;
        if (hint.startOpacity != null)
          primes.push(() => primeOpacity(target, String(start)));
        const resting =
          end <= HIDE_LATCH_ALPHA_EPS
            ? modAlpha * leafSelf
            : null;
        arms.push((at) => {
          if (guard(hint.targetId, target))
            armOpacity(
              target,
              String(end),
              opacityTransition,
              at + duration,
              hint.group,
              resting,
            );
        });
      }
    }
    for (const prime of primes) prime();
    if (primes.length) {
      scheduleArms(arms);
      hints.length = 0;
      return;
    }
    if (runBatch(arms, p.now())) p.schedule();
    hints.length = 0;
  }

  function tick(now: number): number {
    if (active.size === 0) return Infinity;
    let next = Infinity;
    let settledHands = false;
    let endpoints: RenderRecord[] | null = null;
    for (const r of active) {
      let changed = false;
      if (r.tweenTransformUntil && now >= r.tweenTransformUntil) {
        const settled = r.tweenTransform;
        const endpoint = r.tweenTransformEndG6;
        const catchup = r.tweenPinCatchup;
        const origin = r.tweenPinCatchupOrigin;
        const applies = !!r.el && catchup != null && catchup !== settled;
        r.tweenPinStreamed = null;
        r.tweenPinCatchup = null;
        r.tweenPinCatchupOrigin = null;
        r.tweenTransform = null;
        r.tweenTransformOrigin = null;
        r.tweenTransformUntil = 0;
        r.tweenTransformTransition = null;
        r.tweenTransformEndG6 = null;
        if (applies && r.el) {
          r.el.style.transition = composeTransition(r);
          r.el.style.transform = catchup!;
          r.style.set("transform", catchup!);
          if (origin != null) {
            r.el.style.transformOrigin = origin;
            r.style.set("transformOrigin", origin);
          }
          settledHands ||= p.handHolderIds.has(r.id);
        } else if (p.handHolderIds.has(r.id) && endpoint) {
          r.tweenTransformSettleEndG6 = endpoint;
          (endpoints ??= []).push(r);
          settledHands = true;
        }
        if (handParityEnabled) {
          noteHandParity(r, now, settled, catchup);
          r.parityWatchTransform = r.style.get("transform") ?? null;
          r.parityWatchUntil = now + HAND_PARITY_WATCH_MS;
          r.parityWatchParentId = r.lastNode?.parentId ?? null;
        }
        if (r.el && p.derasterNeeded(r)) p.queueDeraster(r.el);
        r.tweenPreArmLinear = null;
        p.markGeometryDirty();
        changed = true;
      }
      if (r.tweenOpacityUntil && now >= r.tweenOpacityUntil) {
        if (
          r.hideLatchRestingSig != null &&
          r.tweenOpacity != null &&
          Number(r.tweenOpacity) <= HIDE_LATCH_ALPHA_EPS
        )
          r.hideLatchedUntil = now + HIDE_LATCH_GRACE_MS;
        r.tweenOpacity = null;
        r.tweenOpacityUntil = 0;
        r.tweenOpacityTransition = null;
        changed = true;
      }
      if (r.tweenSelfOpacityUntil && now >= r.tweenSelfOpacityUntil) {
        r.tweenSelfOpacity = null;
        r.tweenSelfOpacityUntil = 0;
        r.tweenSelfOpacityTransition = null;
        if (r.selfLayer) r.selfLayer.style.transition = "";
        changed = true;
      }
      if (
        r.hideLatchedUntil &&
        r.hideLatchHeldAt &&
        now - r.hideLatchHeldAt >= HIDE_LATCH_HELD_RESTORE_MS
      ) {
        r.hideLatchedUntil = 0;
        r.hideLatchHeldAt = 0;
        r.hideLatchRestingSig = null;
        const streamed = r.hideLatchStreamedOpacity;
        r.hideLatchStreamedOpacity = null;
        if (streamed != null && r.el) {
          r.el.style.opacity = streamed;
          r.style.set("opacity", streamed);
        }
      }
      if (changed && r.el) r.el.style.transition = composeTransition(r);
      if (
        !r.tweenTransformUntil &&
        !r.tweenOpacityUntil &&
        !r.tweenSelfOpacityUntil &&
        !r.hideLatchHeldAt
      ) {
        r.tweenGroup = null;
        active.delete(r);
        continue;
      }
      for (const due of [
        r.tweenTransformUntil,
        r.tweenOpacityUntil,
        r.tweenSelfOpacityUntil,
        r.hideLatchedUntil && r.hideLatchHeldAt
          ? r.hideLatchHeldAt + HIDE_LATCH_HELD_RESTORE_MS
          : 0,
      ])
        if (due && due < next) next = due;
    }
    if (settledHands) {
      p.applyHandRaise();
      for (const r of endpoints ?? []) r.tweenTransformSettleEndG6 = null;
    }
    return next;
  }

  function writeFlightTransform(
    r: RenderRecord,
    g6: number[],
    until: number,
    parentInv?: Affine,
  ): number {
    if (!r.el || !r.lastNode) return g6[4];
    const placed = p.placement(r, g6, parentInv);
    if (placed.transform == null) return g6[4];
    if (r.tweenTransformUntil === 0) {
      r.tweenPreArmLinear = p.cssLinear(r.style.get("transform"));
      r.tweenTransformTransition = "";
      r.el.style.transition = composeTransition(r);
      p.markGeometryDirty();
      cancelParityWatch(r);
    }
    r.tweenPinStreamed = null;
    r.tweenPinCatchup = null;
    r.tweenPinCatchupOrigin = null;
    r.tweenTransformParentId = undefined;
    r.tweenTransform = placed.transform;
    r.tweenTransformOrigin = placed.transformOrigin ?? null;
    r.tweenTransformUntil = until;
    r.tweenTransformEndG6 = g6 as Affine;
    p.noteDeadline(until);
    if (r.style.get("transform") !== placed.transform) {
      r.el.style.transform = placed.transform;
      r.style.set("transform", placed.transform);
    }
    if (
      placed.transformOrigin != null &&
      r.style.get("transformOrigin") !== placed.transformOrigin
    ) {
      r.el.style.transformOrigin = placed.transformOrigin;
      r.style.set("transformOrigin", placed.transformOrigin);
    }
    active.add(r);
    return g6[4] + (placed.spreadDx ?? 0);
  }

  return {
    get activeCount() {
      return active.size;
    },
    has: (r) => active.has(r),
    forget: (r) => active.delete(r),
    clear: () => active.clear(),
    composeTransition,
    pin,
    applyHints,
    tick,
    writeFlightTransform,
  };
}
