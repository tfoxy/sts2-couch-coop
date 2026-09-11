// The DOM record lifecycle: teardown, content-key adoption and same-walk condemnation.
// Renderer runtime services enter through narrow ports, keeping this leaf one-way.
import type { MirrorNode } from "@/mirror/sceneTree";
import type { RenderRecord, WalkCtx } from "./recordModel";

export interface ElementLifecycleEnv {
  records: Map<string, RenderRecord>;
  nodes: () => ReadonlyMap<string, MirrorNode>;
  childIds: () => Map<string, string[]>;
  heldCardId: () => string | null;
  heldCardEl: () => HTMLElement | null;
  heldGestureIds: () => Set<string> | null;
  clearPromotion: (record: RenderRecord) => void;
  unregisterElement: (el: HTMLElement) => void;
  removeVisibleTooltip: (el: HTMLElement) => void;
  setDormant: (record: RenderRecord, dormant: boolean) => void;
  removeHandRaiseAnchor: (id: string) => void;
  forgetReveal: (id: string) => void;
  resetIntentElement: (record: RenderRecord) => void;
  releaseLineMask: (id: string) => void;
  forgetStrokeLocal: (id: string) => void;
  setSpineShownStill: (record: RenderRecord, clip: null) => void;
  dropSeenSpineUrls: (record: RenderRecord) => void;
  setSpineClip: (record: RenderRecord, clip: null) => void;
  releaseGeoclip: (record: RenderRecord) => void;
  thaw: (canvas: HTMLCanvasElement | null) => void;
  cancelParityWatch: (record: RenderRecord) => void;
  removeFlight: (record: RenderRecord) => void;
  deactivateTrail: (record: RenderRecord) => void;
  releaseTrail: (record: RenderRecord) => void;
  releaseTrailFrame: (record: RenderRecord) => void;
  forgetTween: (record: RenderRecord) => void;
  removeSpine: (record: RenderRecord) => void;
  removeOcclusion: (id: string) => void;
  forgetRaise: (id: string) => void;
  clearRaiseCosmetics: (record: RenderRecord) => void;
  dropViewScale: (id: string) => void;
  onBeforeSweep: (record: RenderRecord) => void;
  removeHoverTip: (id: string) => void;
  adoptOcclusion: (from: string, to: string) => void;
  removeTargeting: (id: string) => void;
  stampIdentity: (el: HTMLElement, id: string, node: MirrorNode) => void;
  markGeomDirty: () => void;
  markEffectsDirty: () => void;
  stats: {
    adoptions: number;
    removedRecords: number;
    condemnedSwept: number;
  };
}

export interface ElementLifecycle {
  readonly recordsByAdoptKey: ReadonlyMap<string, RenderRecord>;
  removeEl(record: RenderRecord): void;
  setAdoptKey(record: RenderRecord, key: string | null): void;
  dropAdoptKey(record: RenderRecord): void;
  condemnRecord(record: RenderRecord): boolean;
  sweepCondemned(): void;
  tryAdopt(id: string, node: MirrorNode, key: string | null): RenderRecord | null;
  collectSubtreeIds(id: string, out: Set<string>): void;
  dispose(): void;
}

export function isStableNodeName(name: string): boolean {
  if (name.length === 0 || name.charCodeAt(0) === 64) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 48 || c > 57) return true;
  }
  return false;
}

export function computeAdoptKey(node: MirrorNode, ctx: WalkCtx): string | null {
  if (node.contentKey !== null) return node.contentKey;
  return ctx.contentScope !== null && isStableNodeName(node.name) ? `${ctx.contentScope}/${node.name}` : null;
}

export function createElementLifecycle(env: ElementLifecycleEnv): ElementLifecycle {
  const recordsByAdoptKey = new Map<string, RenderRecord>();
  const condemned = new Map<string, RenderRecord>();

  function heldGestureOwns(record: RenderRecord): boolean {
    const heldId = env.heldCardId();
    if (heldId === null) return false;
    if (env.heldGestureIds()?.has(record.id)) return true;
    const el = record.el;
    const heldEl = env.records.get(heldId)?.el ?? env.heldCardEl();
    return el !== null && heldEl !== null && (heldEl === el || heldEl.contains(el));
  }

  function resetTrail(record: RenderRecord): void {
    env.releaseTrail(record);
    record.trailDiv = null; record.trailPaths = []; record.trailGradient = null; record.trailStops = [];
    record.trailPoints = null; env.releaseTrailFrame(record); record.trailProfile = null; record.trailD = "";
    record.trailPaintedAtMs = 0; record.trailAgedPending = false; record.trailRepaintDeferred = false;
    record.trailGradTailSig = ""; record.trailGradHeadSig = ""; record.trailStopSigs = [];
    record.trailBandOpacitySig = null; record.trailBandsPainted = 0; record.trailStandingBboxArea = 0;
  }

  function resetTimedState(record: RenderRecord): void {
    env.forgetTween(record);
    record.tweenTransform = null; record.tweenTransformOrigin = null; record.tweenTransformUntil = 0;
    record.tweenTransformTransition = null; record.tweenTransformEndG6 = null; record.tweenPreArmLinear = null;
    record.tweenPinStreamed = null; record.tweenPinCatchup = null; record.tweenPinCatchupOrigin = null;
    record.tweenTransformParentId = undefined; record.tweenOpacity = null; record.tweenOpacityUntil = 0;
    record.tweenOpacityTransition = null; record.tweenSelfOpacity = null; record.tweenSelfOpacityUntil = 0;
    record.tweenSelfOpacityTransition = null; record.tweenGroup = null; record.hideLatchedUntil = 0;
    record.hideLatchRestingSig = null; record.hideLatchHeldAt = 0; record.hideLatchStreamedOpacity = null;
  }

  function removeEl(record: RenderRecord): void {
    env.thaw(record.atlasCanvas);
    env.thaw(record.spineCanvas);
    env.clearPromotion(record);
    if (record.el) {
      env.unregisterElement(record.el);
      env.removeVisibleTooltip(record.el);
      record.el.remove();
      env.markEffectsDirty();
    }
    env.removeHoverTip(record.id);
    env.setDormant(record, false);
    record.builtWhileHidden = false;
    env.removeOcclusion(record.id);
    env.removeHandRaiseAnchor(record.id);
    record.occluded = false;
    record.occlusionSuspended = false;
    record.staticBgSuspended = false;
    env.forgetReveal(record.id);
    record.paintSuppressed = false;
    env.cancelParityWatch(record);
    record.el = null;
    record.style.clear();
    record.attrs.clear();
    record.attrNodeType = null;
    record.attrSpreadDx = null;
    record.attrPaints = null;
    record.attrSpreadW = null;
    record.attrSpreadMode = null;
    record.childCtx = null;
    record.lastCtxRef = null;
    record.behindCount = 0;
    record.subLayers = [];
    record.selfLayer = null;
    record.selfLayerStyle.clear();
    record.animSelf = null;
    record.animSelfStyle.clear();
    record.animSelfWrapsPaint = false;
    record.staticAnimBinding = null;
    record.flameBinding = null;
    record.shaderSelfFlamed = false;
    record.pinnedLoopSig = null;
    record.pinnedLoopTarget = null;
    record.pinnedLoopStash = null;
    record.shaderSelf = null;
    record.shaderSelfFit = null;
    record.shaderSelfTex = null;
    record.shaderSelfWindow = null;
    record.atlasCanvas = null;
    record.atlasKey = null;
    record.atlasBlobKey = null;
    record.atlasBlobUrl = null;
    record.atlasPlacementKey = null;
    record.atlasPaint = "none";
    record.atlasRegionDiv = null;
    record.atlasPageCropSig = null;
    env.resetIntentElement(record);
    env.releaseLineMask(record.id);
    env.forgetStrokeLocal(record.id);
    record.lineDiv = null;
    record.linePolyline = null;
    record.lineSig = null;
    env.deactivateTrail(record);
    env.removeFlight(record);
    resetTrail(record);
    record.particleSelf = null;
    record.particleRectAttr = null;
    env.removeSpine(record);
    record.spineLayer = null;
    record.spineImg = null;
    record.spineImgUrl = null;
    record.spinePendingStillUrl = null;
    env.setSpineShownStill(record, null);
    if (record.spineDying) env.dropSeenSpineUrls(record);
    record.spineStillUrlsSeen = null;
    record.spineDying = false;
    record.spineCanvas = null;
    record.spineCtx = null;
    record.spineAnim = null;
    record.spineSkin = null;
    record.spineMat = null;
    record.spineSkelPath = null;
    record.spineStill = false;
    record.spineStillT = null;
    record.spineRetried = false;
    record.spineSkelRetried = false;
    env.setSpineClip(record, null);
    record.spineLooping = true;
    record.spinePaused = false;
    record.spineSyncNode = null;
    record.spineShownFrame = -1;
    record.spinePlacementKey = null;
    record.spineStillPainted = false;
    record.spineAnimatedShown = false;
    env.releaseGeoclip(record);
    record.npSlices = [];
    record.npSliceStyles = [];
    record.rangeFill = null;
    record.rangeWidth = null;
    record.textDiv = null;
    record.textStyleCache.clear();
    record.textInner = null;
    record.lastText = null;
    record.lastHtml = null;
    resetTimedState(record);
    record.tweenTransformSettleEndG6 = null;
    record.gDesign = null;
    env.markGeomDirty();
  }

  function adoptRecord(record: RenderRecord, newId: string, node: MirrorNode): void {
    const oldId = record.id;
    if (oldId !== newId) {
      env.removeHoverTip(oldId);
      env.adoptOcclusion(oldId, newId);
      env.removeTargeting(oldId);
      env.forgetRaise(oldId);
      env.clearRaiseCosmetics(record);
      env.dropViewScale(oldId);
      record.id = newId;
    }
    record.lastNode = null;
    record.haveCtx = false;
    record.lastCtxRef = null;
    record.atlasCanvasReverts = 0;
    if (record.el) env.stampIdentity(record.el, newId, node);
    env.markGeomDirty();
    env.markEffectsDirty();
  }

  function setAdoptKey(record: RenderRecord, key: string | null): void {
    if (record.adoptKey === key) return;
    if (record.adoptKey !== null && recordsByAdoptKey.get(record.adoptKey) === record) recordsByAdoptKey.delete(record.adoptKey);
    record.adoptKey = key;
    if (key !== null) recordsByAdoptKey.set(key, record);
  }

  function dropAdoptKey(record: RenderRecord): void {
    if (record.adoptKey !== null && recordsByAdoptKey.get(record.adoptKey) === record) recordsByAdoptKey.delete(record.adoptKey);
    record.adoptKey = null;
  }

  function condemnRecord(record: RenderRecord): boolean {
    const key = record.adoptKey;
    if (key !== null) {
      if (recordsByAdoptKey.get(key) !== record || condemned.has(key)) return false;
      condemned.set(key, record);
      return true;
    }
    return false;
  }

  function sweepOne(record: RenderRecord): void {
    env.onBeforeSweep(record);
    dropAdoptKey(record);
    removeEl(record);
    env.stats.removedRecords++;
    env.stats.condemnedSwept++;
  }

  function sweepCondemned(): void {
    for (const record of condemned.values()) sweepOne(record);
    condemned.clear();
  }

  function adoptGuardsPass(candidate: RenderRecord, newId: string, node: MirrorNode): boolean {
    return !heldGestureOwns(candidate) && (candidate.id === newId || !env.nodes().has(candidate.id)) &&
      (candidate.lastNode === null || candidate.lastNode.nodeType === node.nodeType);
  }

  function tryAdopt(newId: string, node: MirrorNode, key: string | null): RenderRecord | null {
    if (key === null) return null;
    const candidate = condemned.get(key);
    if (!candidate || !adoptGuardsPass(candidate, newId, node)) return null;
    condemned.delete(key);
    adoptRecord(candidate, newId, node);
    env.stats.adoptions++;
    return candidate;
  }

  function collectSubtreeIds(rootId: string, out: Set<string>): void {
    out.add(rootId);
    for (const child of env.childIds().get(rootId) ?? []) collectSubtreeIds(child, out);
  }

  function dispose(): void {
    for (const record of condemned.values()) removeEl(record);
    condemned.clear();
    recordsByAdoptKey.clear();
  }

  return { recordsByAdoptKey, removeEl, setAdoptKey, dropAdoptKey, condemnRecord, sweepCondemned, tryAdopt, collectSubtreeIds, dispose };
}
