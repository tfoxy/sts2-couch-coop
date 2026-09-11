// DOM occlusion and frozen-canvas runtime.  The renderer supplies its retained maps and the narrow writers this
// runtime needs; keeping those ports one-way avoids coupling this policy back to the mirrorRenderer facade.

import { EFFECTS_SUSPENDED_ATTR } from "@godot-scene-web/html";
import { IDENTITY_AFFINE, type Affine } from "@/mirror/affine";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { MIRROR_DESIGN_HEIGHT, MIRROR_DESIGN_WIDTH, type MirrorNode } from "@/mirror/sceneTree";
import { mirrorWalkStats } from "@/mirror/renderer/walkStats";
import { composeCoverAlpha } from "@/mirror/renderer/coverAlpha";
import {
  BACKSTOP_COVER_MIN_ALPHA,
  COVER_EDGE_EPS,
  COVER_MIN_ALPHA,
  COVER_OPAQUE_ALPHA,
  FREEZE_CANVAS_SELECTOR,
  FREEZE_IDLE_MS,
  FREEZE_MAX_REFREEZES,
  FREEZE_SLICE,
  OCC_HIDE,
  OCC_SUSPEND,
  OCCLUSION_CHAIN_BUDGET,
  OCCLUSION_ENGAGE_WALKS,
  OCCLUSION_SIBLING_BUDGET,
  backstopCoverPath,
  canvasSnapshotSource,
  type OcclusionTier
} from "./walkModel";
import type { RenderRecord } from "./recordModel";

export interface OcclusionRuntimePorts {
  nodes: () => Map<string, MirrorNode>;
  records: () => Map<string, RenderRecord>;
  childIdsByParent: () => Map<string, string[]>;
  rootIds: () => string[];
  orderedIds: () => string[];
  rootOwnerOf: (el: HTMLElement) => RenderRecord | undefined;
  spreadFactor: () => number;
  walkNow: () => number;
  createElCount: () => number;
  liftEndpointToGlobal: (record: RenderRecord, endpoint: number[]) => Affine;
  writeDisplay: (record: RenderRecord) => void;
  syncEffectsSuspend: (record: RenderRecord) => void;
  syncAnimators: (gated: boolean, isUnderOccludedRoot: (id: string) => boolean) => void;
  animatorCounts: () => { spine: number; intent: number; pausedStrip: number };
}

export interface OcclusionRuntime {
  readonly canvases: Map<HTMLCanvasElement, { img: HTMLImageElement; url: string; display: string }>;
  beginWalk(): void;
  updateCandidate(id: string, node: MirrorNode): void;
  apply(): void;
  paintIndexOf(id: string): number;
  coverAbove(id: string): boolean;
  setConfirmCoverWatch(on: boolean): void;
  removeRecord(id: string): void;
  adoptRecord(oldId: string, newId: string): void;
  thaw(canvas: HTMLCanvasElement | null | undefined): void;
  thawAll(): void;
  syncFrozenStyle(canvas: HTMLCanvasElement | null | undefined): void;
  noteCanvasRepaint(canvas: HTMLCanvasElement | null | undefined): void;
  dispose(): void;
}

export function createOcclusionRuntime(ports: OcclusionRuntimePorts): OcclusionRuntime {
  const coverCandidateIds = new Set<string>();
  const coverAboveMemo = new Map<string, boolean>();
  let paintOrderIndexMemo: Map<string, number> | null = null;
  const occludedRootTiers = new Map<string, OcclusionTier>();
  const occlusionPending = new Map<string, number>();
  const occlusionDesired = new Map<string, OcclusionTier>();
  const occlusionUnderMemo = new Map<string, boolean>();
  const scratchIds: string[] = [];
  const underChain: string[] = [];

  const frozenCanvases = new Map<HTMLCanvasElement, { img: HTMLImageElement; url: string; display: string }>();
  const freezeQueue: HTMLCanvasElement[] = [];
  const freezeQueued = new Set<HTMLCanvasElement>();
  const freezeGaveUp = new WeakSet<HTMLCanvasElement>();
  const freezeRepaints = new WeakMap<HTMLCanvasElement, number>();
  let freezeFallbackCount = 0;
  let freezeTimer: number | null = null;
  let freezeScanDirty = false;
  let freezeScanCreateEl = -1;

  const nodes = () => ports.nodes();
  const records = () => ports.records();
  const canvasFreezeOn = (): boolean => mirrorSettings.backstopOcclusion;

  function beginWalk(): void {
    coverAboveMemo.clear();
    paintOrderIndexMemo = null;
  }

  function updateCandidate(id: string, node: MirrorNode): void {
    const cbox = node.localRect;
    if (
      cbox != null &&
      cbox.width >= MIRROR_DESIGN_WIDTH - COVER_EDGE_EPS &&
      cbox.height >= MIRROR_DESIGN_HEIGHT - COVER_EDGE_EPS &&
      node.visible &&
      node.fillColor != null &&
      node.fillColor.a >= coverMinAlpha(node) &&
      node.shaderId == null
    ) {
      coverCandidateIds.add(id);
    } else if (coverCandidateIds.size > 0) {
      coverCandidateIds.delete(id);
    }
  }

  function apply(): void {
    if (frozenCanvases.size > 0 && !canvasFreezeOn()) thawAll();
    occlusionDesired.clear();
    let backstopCovers = 0;
    for (const id of coverCandidateIds) {
      const rec = records().get(id);
      const node = rec?.lastNode;
      if (!rec || !node || !node.visible || rec.el == null) continue;
      if (rec.tweenOpacityUntil !== 0 && rec.tweenOpacityUntil > ports.walkNow()) continue;
      const alpha = coverComposedAlpha(node);
      const minAlpha = coverMinAlpha(node);
      if (alpha < minAlpha || !coverSpansStage(rec, node)) continue;
      if (minAlpha === BACKSTOP_COVER_MIN_ALPHA) backstopCovers++;
      collectCoveredRoots(id, alpha >= COVER_OPAQUE_ALPHA && node.mouseFilter === 0 ? OCC_HIDE : OCC_SUSPEND);
    }
    if (occlusionDesired.size > 1) {
      scratchIds.length = 0;
      for (const [id, tier] of occlusionDesired) if (hasOccludingAncestor(id, tier)) scratchIds.push(id);
      for (const id of scratchIds) occlusionDesired.delete(id);
    }

    for (const [id, tier] of occlusionDesired) {
      const applied = occludedRootTiers.get(id);
      if (applied === tier) {
        occlusionPending.delete(id);
      } else if (applied !== undefined && applied < tier) {
        setRoot(id, tier);
        occlusionPending.delete(id);
      } else {
        const n = (occlusionPending.get(id) ?? 0) + 1;
        if (n >= OCCLUSION_ENGAGE_WALKS) {
          setRoot(id, tier);
          occlusionPending.delete(id);
        } else {
          occlusionPending.set(id, n);
        }
      }
    }
    clearMissing(occludedRootTiers, occlusionDesired, clearRoot);
    clearMissing(occlusionPending, occlusionDesired, (id) => occlusionPending.delete(id));

    syncAnimators(occludedRootTiers.size > 0);
    let hidden = 0;
    for (const tier of occludedRootTiers.values()) if (tier === OCC_HIDE) hidden++;
    const animatorCounts = ports.animatorCounts();
    mirrorWalkStats.occludedRoots = occludedRootTiers.size;
    mirrorWalkStats.occlusionHiddenRoots = hidden;
    mirrorWalkStats.occlusionTier = occludedRootTiers.size === 0 ? 0 : hidden > 0 ? 1 : 2;
    mirrorWalkStats.occlusionSuspendedAnimators = animatorCounts.spine + animatorCounts.intent + animatorCounts.pausedStrip;
    mirrorWalkStats.occlusionBackstopCovers = backstopCovers;

    if (frozenCanvases.size > 0) sweepFrozenCanvases();
    if (canvasFreezeOn()) {
      if (freezeScanDirty || freezeScanCreateEl !== ports.createElCount()) {
        freezeScanDirty = false;
        freezeScanCreateEl = ports.createElCount();
        scanFreezeTargets();
      }
    } else if (freezeQueue.length > 0) {
      freezeQueue.length = 0;
      freezeQueued.clear();
    }
    mirrorWalkStats.occlusionFrozenCanvases = frozenCanvases.size;
    mirrorWalkStats.occlusionFrozenFallbacks = freezeFallbackCount;
  }

  function coverAbove(id: string): boolean {
    const memo = coverAboveMemo.get(id);
    if (memo !== undefined) return memo;
    const answer = computeCoverAbove(id);
    coverAboveMemo.set(id, answer);
    return answer;
  }

  function computeCoverAbove(id: string): boolean {
    if (coverCandidateIds.size === 0) return false;
    const targetIdx = paintIndexOf(id);
    if (targetIdx < 0) return false;
    for (const coverId of coverCandidateIds) {
      const rec = records().get(coverId);
      const node = rec?.lastNode;
      if (!rec || !node || !node.visible || rec.el == null || paintIndexOf(coverId) <= targetIdx) continue;
      if (coverComposedAlpha(node) >= BACKSTOP_COVER_MIN_ALPHA && coverSpansStage(rec, node)) return true;
    }
    return false;
  }

  function paintIndexOf(id: string): number {
    if (paintOrderIndexMemo === null) {
      paintOrderIndexMemo = new Map<string, number>();
      const order = ports.orderedIds();
      for (let i = 0; i < order.length; i++) paintOrderIndexMemo.set(order[i], i);
    }
    return paintOrderIndexMemo.get(id) ?? -1;
  }

  function coverMinAlpha(node: MirrorNode): number {
    if (!mirrorSettings.backstopOcclusion) return COVER_MIN_ALPHA;
    const parent = node.parentId != null ? nodes().get(node.parentId) : undefined;
    return backstopCoverPath(node.name, parent?.name ?? null) !== null ? BACKSTOP_COVER_MIN_ALPHA : COVER_MIN_ALPHA;
  }

  function coverComposedAlpha(node: MirrorNode): number {
    return composeCoverAlpha(
      nodes(),
      node,
      (n) => (n.modulate ? n.modulate.a : n.opacity) * (n.selfModulate ? n.selfModulate.a : 1) * (n.fillColor ? n.fillColor.a : 0),
      (n) => n.modulate ? n.modulate.a : n.opacity,
      OCCLUSION_CHAIN_BUDGET
    );
  }

  function coverSpansStage(rec: RenderRecord, node: MirrorNode): boolean {
    const lr = node.localRect;
    if (lr == null) return false;
    const g = node.transform == null ? rec.cParentGlobal ?? IDENTITY_AFFINE : ports.liftEndpointToGlobal(rec, node.transform);
    if (Math.abs(g[1]) > 1e-4 || Math.abs(g[2]) > 1e-4 || g[0] <= 0 || g[3] <= 0) return false;
    const w = (rec.spreadW > 0 ? rec.spreadW : lr.width) * g[0];
    const h = lr.height * g[3];
    const x0 = g[4] + g[0] * lr.x + rec.spreadDx;
    const y0 = g[5] + g[3] * lr.y;
    return x0 <= COVER_EDGE_EPS && y0 <= COVER_EDGE_EPS && x0 + w >= MIRROR_DESIGN_WIDTH * ports.spreadFactor() - COVER_EDGE_EPS && y0 + h >= MIRROR_DESIGN_HEIGHT - COVER_EDGE_EPS;
  }

  function collectCoveredRoots(backdropId: string, tier: OcclusionTier): void {
    let curId: string | null = backdropId;
    let budget = OCCLUSION_CHAIN_BUDGET;
    while (curId != null && budget-- > 0) {
      const cur = nodes().get(curId);
      if (!cur) return;
      const parentId = cur.parentId != null && nodes().has(cur.parentId) ? cur.parentId : null;
      const siblings = parentId != null ? ports.childIdsByParent().get(parentId) : ports.rootIds();
      if (siblings != null && siblings.length <= OCCLUSION_SIBLING_BUDGET) {
        const curBehind = parentId != null && cur.showBehindParent;
        let seenChain = false;
        for (const sid of siblings) {
          if (sid === curId) { seenChain = true; continue; }
          if (parentId != null) {
            const sibling = nodes().get(sid);
            if (!sibling) continue;
            const paintsBefore = curBehind ? sibling.showBehindParent && !seenChain : !seenChain || sibling.showBehindParent;
            if (!paintsBefore) continue;
          } else if (seenChain) {
            continue;
          }
          const prev = occlusionDesired.get(sid);
          if (prev === undefined || prev > tier) occlusionDesired.set(sid, tier);
        }
      }
      curId = parentId;
    }
  }

  function hasOccludingAncestor(id: string, tier: OcclusionTier): boolean {
    let budget = OCCLUSION_CHAIN_BUDGET;
    let cur = nodes().get(id);
    while (cur != null && budget-- > 0) {
      const pid = cur.parentId;
      if (pid == null) return false;
      const at = occlusionDesired.get(pid);
      if (at !== undefined && at <= tier) return true;
      cur = nodes().get(pid);
    }
    return false;
  }

  function setRoot(id: string, tier: OcclusionTier): void {
    const rec = records().get(id);
    if (!rec || !rec.el) return;
    occludedRootTiers.set(id, tier);
    freezeScanDirty = true;
    if (!rec.occlusionSuspended) {
      rec.occlusionSuspended = true;
      ports.syncEffectsSuspend(rec);
    }
    const hide = tier === OCC_HIDE;
    if (rec.occluded !== hide) {
      rec.occluded = hide;
      ports.writeDisplay(rec);
    }
  }

  function clearRoot(id: string): void {
    occludedRootTiers.delete(id);
    freezeScanDirty = true;
    const rec = records().get(id);
    if (!rec) return;
    if (rec.occlusionSuspended) {
      rec.occlusionSuspended = false;
      ports.syncEffectsSuspend(rec);
    }
    if (rec.occluded) {
      rec.occluded = false;
      ports.writeDisplay(rec);
    }
  }

  function isUnderOccludedRoot(id: string): boolean {
    const memo = occlusionUnderMemo.get(id);
    if (memo !== undefined) return memo;
    underChain.length = 0;
    let under = false;
    let curId: string | null = id;
    let budget = OCCLUSION_CHAIN_BUDGET;
    while (curId != null && budget-- > 0) {
      const cached = occlusionUnderMemo.get(curId);
      if (cached !== undefined) { under = cached; break; }
      underChain.push(curId);
      if (occludedRootTiers.has(curId)) { under = true; break; }
      curId = nodes().get(curId)?.parentId ?? null;
    }
    for (const cid of underChain) occlusionUnderMemo.set(cid, under);
    return under;
  }

  // The membership set can change on every pass. The animator port may ask the same ancestry again immediately,
  // so never let a verdict cached under the previous set survive either synchronization path.
  function syncAnimators(gated: boolean): void {
    occlusionUnderMemo.clear();
    ports.syncAnimators(gated, isUnderOccludedRoot);
  }

  function freezableNow(canvas: HTMLCanvasElement): boolean {
    if (!canvasFreezeOn() || !canvas.isConnected || canvas.width < 1 || canvas.height < 1) return false;
    const rootEl = canvas.closest(`[${EFFECTS_SUSPENDED_ATTR}]`);
    const owner = rootEl ? ports.rootOwnerOf(rootEl as HTMLElement) : undefined;
    return owner != null && occludedRootTiers.get(owner.id) === OCC_SUSPEND;
  }

  function scanFreezeTargets(): void {
    for (const [id, tier] of occludedRootTiers) {
      if (tier !== OCC_SUSPEND) continue;
      const el = records().get(id)?.el;
      if (!el) continue;
      for (const canvas of el.querySelectorAll<HTMLCanvasElement>(FREEZE_CANVAS_SELECTOR)) {
        if (frozenCanvases.has(canvas) || freezeQueued.has(canvas) || freezeGaveUp.has(canvas)) continue;
        freezeQueued.add(canvas);
        freezeQueue.push(canvas);
      }
    }
    if (freezeQueue.length > 0) scheduleFreezeDrain();
  }

  function scheduleFreezeDrain(): void {
    if (freezeTimer !== null || typeof setTimeout !== "function") return;
    freezeTimer = setTimeout(runFreezeDrain, FREEZE_IDLE_MS) as unknown as number;
  }

  function runFreezeDrain(): void {
    freezeTimer = null;
    if (!canvasFreezeOn()) { freezeQueue.length = 0; freezeQueued.clear(); return; }
    for (let n = 0; n < FREEZE_SLICE && freezeQueue.length > 0; n++) {
      const canvas = freezeQueue.shift()!;
      freezeQueued.delete(canvas);
      if (!freezableNow(canvas) || frozenCanvases.has(canvas)) continue;
      canvasSnapshotSource(canvas, (url) => onCanvasSnapshot(canvas, url));
    }
    if (freezeQueue.length > 0) scheduleFreezeDrain();
  }

  function onCanvasSnapshot(canvas: HTMLCanvasElement, url: string | null): void {
    if (url === null) {
      freezeGaveUp.add(canvas);
      freezeFallbackCount++;
      mirrorWalkStats.occlusionFrozenFallbacks = freezeFallbackCount;
      return;
    }
    const parent = canvas.parentNode;
    if (!parent || frozenCanvases.has(canvas) || !freezableNow(canvas)) { revokeSnapshotUrl(url); return; }
    const img = document.createElement("img");
    img.className = `${canvas.className} mirror-frozen-canvas`;
    img.style.cssText = canvas.style.cssText;
    img.decoding = "sync";
    img.setAttribute("aria-hidden", "true");
    img.src = url;
    parent.insertBefore(img, canvas.nextSibling);
    frozenCanvases.set(canvas, { img, url, display: canvas.style.display });
    canvas.style.display = "none";
    mirrorWalkStats.occlusionFrozenCanvases = frozenCanvases.size;
  }

  function revokeSnapshotUrl(url: string): void {
    if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
  }

  function thaw(canvas: HTMLCanvasElement | null | undefined): void {
    if (!canvas) return;
    const snap = frozenCanvases.get(canvas);
    if (!snap) return;
    frozenCanvases.delete(canvas);
    snap.img.remove();
    revokeSnapshotUrl(snap.url);
    canvas.style.display = snap.display;
    mirrorWalkStats.occlusionFrozenCanvases = frozenCanvases.size;
  }

  function thawAll(): void {
    for (const canvas of [...frozenCanvases.keys()]) thaw(canvas);
    freezeQueue.length = 0;
    freezeQueued.clear();
    if (freezeTimer !== null) { clearTimeout(freezeTimer); freezeTimer = null; }
  }

  function syncFrozenStyle(canvas: HTMLCanvasElement | null | undefined): void {
    if (!canvas || frozenCanvases.size === 0) return;
    const snap = frozenCanvases.get(canvas);
    if (!snap) return;
    const hidden = canvas.style.display;
    canvas.style.display = snap.display;
    snap.img.style.cssText = canvas.style.cssText;
    canvas.style.display = hidden;
  }

  function sweepFrozenCanvases(): void {
    for (const canvas of [...frozenCanvases.keys()]) if (!freezableNow(canvas)) thaw(canvas);
  }

  function noteCanvasRepaint(canvas: HTMLCanvasElement | null | undefined): void {
    if (!canvas || frozenCanvases.size === 0 || !frozenCanvases.has(canvas)) return;
    thaw(canvas);
    const seen = (freezeRepaints.get(canvas) ?? 0) + 1;
    freezeRepaints.set(canvas, seen);
    if (seen >= FREEZE_MAX_REFREEZES) { freezeGaveUp.add(canvas); return; }
    freezeScanDirty = true;
  }

  function setConfirmCoverWatch(_on: boolean): void {}
  function removeRecord(id: string): void {
    coverCandidateIds.delete(id);
    occludedRootTiers.delete(id);
    occlusionPending.delete(id);
  }
  function adoptRecord(oldId: string, newId: string): void {
    coverCandidateIds.delete(oldId);
    const tier = occludedRootTiers.get(oldId);
    if (tier !== undefined) { occludedRootTiers.delete(oldId); occludedRootTiers.set(newId, tier); }
    const pending = occlusionPending.get(oldId);
    if (pending !== undefined) { occlusionPending.delete(oldId); occlusionPending.set(newId, pending); }
  }
  function dispose(): void {
    coverCandidateIds.clear();
    coverAboveMemo.clear();
    paintOrderIndexMemo = null;
    occludedRootTiers.clear();
    occlusionPending.clear();
    occlusionDesired.clear();
    occlusionUnderMemo.clear();
    thawAll();
  }

  function copyKeys(map: Map<string, unknown>, out: string[]): void {
    out.length = 0;
    for (const id of map.keys()) out.push(id);
  }
  function clearMissing(source: Map<string, unknown>, wanted: Map<string, unknown>, clear: (id: string) => void): void {
    if (source.size === 0) return;
    copyKeys(source, scratchIds);
    for (const id of scratchIds) if (!wanted.has(id)) clear(id);
  }

  return {
    canvases: frozenCanvases,
    beginWalk,
    updateCandidate,
    apply,
    paintIndexOf,
    coverAbove,
    setConfirmCoverWatch,
    removeRecord,
    adoptRecord,
    thaw,
    thawAll,
    syncFrozenStyle,
    noteCanvasRepaint,
    dispose
  };
}
