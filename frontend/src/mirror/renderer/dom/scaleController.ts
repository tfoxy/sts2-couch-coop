import {
  affineInverse,
  affineMul,
  affineCss,
  IDENTITY_AFFINE,
  nodeMatrix,
  type Affine,
} from "@/mirror/affine";
import {
  computeTipScaleStamp,
  resolveVisualOwnerId as resolveSharedVisualOwnerId,
  type TipScaleEnv,
} from "@/mirror/tipScaleLayout";
import { MIRROR_DESIGN_WIDTH, nodeTypeLeaf, type MirrorNode, type MirrorRect } from "@/mirror/sceneTree";
import {
  viewScaleOn,
  viewScaleSharedEnv,
} from "@/mirror/renderer/staticBackgroundPolicy";
import { tipScaleOn } from "@/mirror/renderer/sharedFeatureFlags";
import { scaleAffineTranslation } from "@/mirror/stageFit";
import type { RenderRecord } from "@/mirror/renderer/dom/recordModel";
import { mirrorWalkStats } from "@/mirror/renderer/walkStats";
import { setUiScalingEnabled, uiScalingEnabled } from "@/mirror/uiScaling";
import {
  buildViewScaleInputRegistry,
  computeViewScaleStamp,
  designAabbOf,
  resolveViewScaleForNode,
  viewScaleNominalBox,
  viewScaleStampMatrix,
  type ViewScaleRegistryEnv,
  type ViewScaleStampIndex,
} from "@/mirror/viewScaleLayout";
import type { ViewScaleResolved } from "@/mirror/viewScale";
import type { ViewScaleInputStamp } from "@/mirror/viewScaleInverse";
import type { InteractiveRect } from "@/mirror/renderer/contracts";

type SceneInfo = { file: string; rootId: string; relPath: string } | null;

export interface ScaleControllerPorts {
  records: () => ReadonlyMap<string, RenderRecord>;
  nodes: () => ReadonlyMap<string, MirrorNode>;
  childIds: () => ReadonlyMap<string, string[]>;
  orderedIds: () => string[];
  spreadFactor: () => number;
  geometryEpoch: () => number;
  geometryDirty: () => boolean;
  markGeometryDirty: () => void;
  computeSceneInfo: (id: string) => SceneInfo;
  ancestorChainHidden: (node: MirrorNode) => boolean;
  interactiveRects: () => InteractiveRect[];
  forEachInteractiveRect: (
    cb: (id: string, global: Affine, localRect: MirrorRect) => void,
  ) => void;
  liftEndpointToGlobal: (record: RenderRecord, endpoint: number[]) => Affine;
  spreadDxAtGlobal: (record: RenderRecord, node: MirrorNode, global: readonly number[]) => number;
  syncTextScaleSheet: () => void;
}

export interface ScaleController {
  hasViewScale(id: string): boolean;
  hasViewScaleItems(): boolean;
  hasTipChild(parentId: string | null | undefined): boolean;
  resolveVisualOwnerId(id: string): string;
  registerHoverTip(id: string, leaf: string, visible: boolean): void;
  cacheTipChild(record: RenderRecord, global: Affine): void;
  cacheViewScaleGlobal(record: RenderRecord, global: Affine): void;
  registerViewScale(
    id: string,
    node: MirrorNode,
    leaf: string,
    inCardRewardScreen: boolean,
    record: RenderRecord,
    global: Affine,
  ): void;
  dropViewScale(id: string): void;
  removeHoverTip(id: string): void;
  applyViewScale(): void;
  applyTipScale(): void;
  inputStamps(): ViewScaleInputStamp[];
  setUiScaling(enabled: boolean): void;
  dispose(): void;
}

// The scale sidecar owns DOM-only scale application. Its ports are deliberately getters: renderer reconciliation
// replaces the live node/order maps each drain, while pointer reads can happen between drains.
export function createScaleController(p: ScaleControllerPorts): ScaleController {
  const hoverTipSetIds = new Set<string>();
  const viewScaleIds = new Map<string, ViewScaleResolved>();
  const viewScaleStamps: ViewScaleStampIndex = new Map();
  let viewScaleInputStampsCache: ViewScaleInputStamp[] = [];
  let viewScaleInputStampsStale = false;
  let viewScalePassEpoch = -1;
  let tipScalePassEpoch = -1;

  const viewScaleEnv = viewScaleSharedEnv(p.computeSceneInfo);
  const viewScaleRegistryEnv: ViewScaleRegistryEnv = {
    parentIdOf: (id) => p.nodes().get(id)?.parentId,
    // The order array is re-pointed on structural deltas, so this must remain a getter rather than a captured value.
    get orderedIds() {
      return p.orderedIds();
    },
    ancestorChainHidden: (id) => {
      const node = p.records().get(id)?.lastNode;
      return node ? p.ancestorChainHidden(node) : false;
    },
    designWidth: MIRROR_DESIGN_WIDTH,
  };

  /**
   * The shared HoverTip policy receives this DOM backend's live answers through methods, so its owner resolve sees
   * the current spread, stamps, and interaction registry rather than construction-time snapshots.
   *
   * `gDesign` is cached only for tip children. Everything else (including the anchor owner) is reconstructed as the
   * walk does: parent global ∘ local, then that node's absolute spread shift. That makes the owner answer independent
   * of whether it happened to be visited in this drain.
   */
  const tipScaleEnv: TipScaleEnv = {
    designW: () => MIRROR_DESIGN_WIDTH * p.spreadFactor(),
    nodeOf: (id) => p.nodes().get(id),
    childIdsOf: (id) => p.childIds().get(id),
    drawnBoxOf: (id) => {
      const rec = p.records().get(id);
      const node = rec?.lastNode;
      if (!rec || !node || node.localRect == null) return null;
      if (rec.gDesign != null) return designAabbOf(rec.gDesign, node.localRect);
      const parentGlobal = rec.cParentGlobal ?? IDENTITY_AFFINE;
      const global = node.transform == null ? parentGlobal : affineMul(parentGlobal, node.transform as Affine);
      const shifted: Affine = rec.spreadDx
        ? [global[0], global[1], global[2], global[3], global[4] + rec.spreadDx, global[5]]
        : global;
      return designAabbOf(shifted, node.localRect);
    },
    typeLeafOf: (id) => {
      const node = p.nodes().get(id);
      return node ? nodeTypeLeaf(node.nodeType) : null;
    },
    sceneFileOf: (id) => p.computeSceneInfo(id)?.file ?? null,
    hitTestAt: (x, y, exclude) => {
      let hit: string | null = null;
      p.forEachInteractiveRect((id, global, localRect) => {
        if (id === exclude) return;
        const inv = affineInverse(nodeMatrix(global, localRect));
        if (!inv) return;
        const lx = inv[0] * x + inv[2] * y + inv[4];
        const ly = inv[1] * x + inv[3] * y + inv[5];
        if (lx >= 0 && lx <= localRect.width && ly >= 0 && ly <= localRect.height) hit = id;
      });
      return hit;
    },
    originOf: (id) => {
      const node = p.nodes().get(id);
      const rec = p.records().get(id);
      const global: Affine | null =
        rec != null && node?.transform != null
          ? p.liftEndpointToGlobal(rec, node.transform)
          : ((node?.transform as Affine | undefined) ?? null);
      return global == null ? null : { x: global[4], y: global[5] };
    },
    parentIdOf: (id) => p.nodes().get(id)?.parentId,
    stampOf: (id) => viewScaleStamps.get(id),
  };

  function hasViewScale(id: string): boolean {
    return viewScaleIds.has(id);
  }

  function hasViewScaleItems(): boolean {
    return viewScaleIds.size > 0;
  }

  function hasTipChild(parentId: string | null | undefined): boolean {
    return parentId != null && hoverTipSetIds.size > 0 && hoverTipSetIds.has(parentId);
  }

  function registerHoverTip(id: string, leaf: string, visible: boolean): void {
    if (tipScaleOn() && leaf === "NHoverTipSet") {
      if (visible) hoverTipSetIds.add(id);
      else hoverTipSetIds.delete(id);
    }
  }

  function cacheTipChild(record: RenderRecord, global: Affine): void {
    if (!hasTipChild(record.lastNode?.parentId)) return;
    setGDesign(record, global);
  }

  function cacheViewScaleGlobal(record: RenderRecord, global: Affine): void {
    setGDesign(record, global);
  }

  function registerViewScale(
    id: string,
    node: MirrorNode,
    leaf: string,
    inCardRewardScreen: boolean,
    record: RenderRecord,
    global: Affine,
  ): void {
    const resolved = resolveViewScaleForNode(id, node, leaf, inCardRewardScreen, viewScaleEnv);
    if (resolved) {
      if (!p.geometryDirty() && !sameViewScaleResolved(viewScaleIds.get(id), resolved)) {
        p.markGeometryDirty();
      }
      viewScaleIds.set(id, resolved);
      setGDesign(record, global);
    } else if (viewScaleIds.size > 0) {
      dropViewScale(id);
    }
  }

  function setGDesign(record: RenderRecord, global: Affine): void {
    if (!p.geometryDirty() && !affineEqual(record.gDesign, global)) p.markGeometryDirty();
    record.gDesign = global;
  }

  function dropViewScale(id: string): void {
    if (viewScaleIds.delete(id) && !p.geometryDirty()) p.markGeometryDirty();
  }

  // Per-drain visual pass. Its paired input registry remains derived from this pure stamp index, never from
  // cross-drain stamp state; a skipped epoch retains the still-valid previous build verbatim. Nothing this reads can
  // move without a geometry bump, and the direct transform write cannot be clobbered without one either.
  function applyViewScale(): void {
    if (viewScalePassEpoch === p.geometryEpoch()) {
      mirrorWalkStats.geomPassSkips++;
      return;
    }
    viewScalePassEpoch = p.geometryEpoch();
    mirrorWalkStats.geomPassRuns++;
    viewScaleStamps.clear();
    viewScaleInputStampsCache = [];
    viewScaleInputStampsStale = true;
    if (!viewScaleOn() || viewScaleIds.size === 0) return;

    const designW = MIRROR_DESIGN_WIDTH * p.spreadFactor();
    for (const [id, entry] of viewScaleIds) {
      const rec = p.records().get(id);
      const el = rec?.el;
      const node = rec?.lastNode;
      if (!rec || !el || !node || !node.visible || node.localRect == null || rec.gDesign == null) continue;
      // An ancestor-hidden node remains visually stamped so it is already correct on reveal; only the input registry
      // filters effective visibility.
      const base = rec.style.get("transform");
      if (base == null) continue;
      const factor = entry.scale;
      let box = designAabbOf(rec.gDesign, node.localRect);
      // A tween-owned GROUP is measured at its endpoint because that is the base transform this pass composes onto.
      // Measuring the streamed OPEN box while the base has already moved to a CLOSED endpoint mixes positions and
      // makes the clamp drag a closing shop panel back into view. Per-item entries keep their nominal-box fallback.
      const endG = entry.isGroup ? rec.tweenTransformEndG6 : null;
      if (endG != null) {
        const endDx = p.spreadDxAtGlobal(rec, node, endG);
        const endShifted: Affine = endDx === 0
          ? endG
          : [endG[0], endG[1], endG[2], endG[3], endG[4] + endDx, endG[5]];
        box = designAabbOf(endShifted, node.localRect);
      }
      if ((box.w <= 0 || box.h <= 0) && !entry.isGroup) {
        box = viewScaleNominalBox(rec.gDesign[4], rec.gDesign[5]);
      }
      const resolved = computeViewScaleStamp(box, entry, designW);
      if (resolved == null) continue;
      viewScaleStamps.set(id, {
        pivotX: resolved.pivotX,
        pivotY: resolved.pivotY,
        k: factor,
        offsetX: resolved.offsetX,
        offsetY: resolved.offsetY,
        box,
        spreadDx: rec.spreadDx,
        isGroup: entry.isGroup,
      });
      const parentGlobal = shiftedParentGlobal(rec);
      const parentInv = affineInverse(parentGlobal) ?? IDENTITY_AFFINE;
      const parentMatrix = affineMul(parentInv, affineMul(viewScaleStampMatrix(factor, resolved), parentGlobal));
      // LAYOUT SPACE (stageFit.ts): the stamp algebra above is design-space throughout (pivots, clamp offsets and
      // boxes all come off the wire), but `base` is the element's LAYOUT-space placement string, so the matrix
      // prepended to it has to be in that space too. Conjugating by the fit factor is exactly "translation × S,
      // linear part untouched" — the scale about the pivot is dimensionless and must not move.
      el.style.transform = `${affineCss(scaleAffineTranslation(parentMatrix))} ${base}`;
    }
  }

  function buildInputStamps(): ViewScaleInputStamp[] {
    // The shared fold owns game-space re-expression, nested-stamp composition, effective-visibility, and the neighbour
    // exemptions. This sidecar supplies only the epoch-cached DOM rectangles and its live tree/order registry.
    mirrorWalkStats.viewScaleRegistryBuilds++;
    return buildViewScaleInputRegistry(viewScaleStamps, p.interactiveRects(), viewScaleRegistryEnv);
  }

  function inputStamps(): ViewScaleInputStamp[] {
    if (viewScaleInputStampsStale) {
      viewScaleInputStampsStale = false;
      viewScaleInputStampsCache = viewScaleStamps.size === 0 ? [] : buildInputStamps();
    }
    return viewScaleInputStampsCache;
  }

  // Tooltip scale is paint-only. It uses the same geometry epoch as view scale, but retains an independent gate.
  // The pass writes transform outside the style cache so the cache stays the clean base; a later base-transform write
  // moves the geometry and forces this pass back through. Cosmetic alpha is deliberately not epoch-modelled: a fading
  // child can retain its prior scale until the next geometry change, while real tooltips appear/disappear by visibility.
  function applyTipScale(): void {
    if (!tipScaleOn() || hoverTipSetIds.size === 0) return;
    if (tipScalePassEpoch === p.geometryEpoch()) {
      mirrorWalkStats.geomPassSkips++;
      return;
    }
    tipScalePassEpoch = p.geometryEpoch();
    mirrorWalkStats.geomPassRuns++;
    for (const tipId of hoverTipSetIds) {
      const rec = p.records().get(tipId);
      const el = rec?.el;
      if (!rec || !el) continue;
      const base = rec.style.get("transform");
      if (base == null) continue;
      const stamp = computeTipScaleStamp(tipId, tipScaleEnv);
      if (stamp == null) continue;
      const parentGlobal = shiftedParentGlobal(rec);
      const parentInv = affineInverse(parentGlobal) ?? IDENTITY_AFFINE;
      const parentMatrix = affineMul(parentInv, affineMul(stamp.matrix, parentGlobal));
      // Direct write is intentional: the style cache retains the clean base, so composition never self-compounds.
      // Conjugated into layout space for the same reason the view-scale pass above is.
      el.style.transform = `${affineCss(scaleAffineTranslation(parentMatrix))} ${base}`;
    }
  }

  function shiftedParentGlobal(rec: RenderRecord): Affine {
    const raw = rec.cParentGlobal ?? IDENTITY_AFFINE;
    const parentId = rec.lastNode?.parentId;
    const parentDx = parentId != null ? p.records().get(parentId)?.spreadDx ?? 0 : 0;
    return parentDx ? [raw[0], raw[1], raw[2], raw[3], raw[4] + parentDx, raw[5]] : raw;
  }

  /**
   * Readability scaling must restore direct transform writes itself. `applyStyleMap` only writes a cache miss, so a
   * forced walk recomputing the same base cannot clean a previously composed scale. The text family is stylesheet
   * driven and synchronizes separately; both transform gates are invalidated in either direction for the forced walk.
   */
  function setUiScaling(enabled: boolean): void {
    if (enabled === uiScalingEnabled()) return;
    setUiScalingEnabled(enabled);
    p.syncTextScaleSheet();
    if (!enabled) restoreScaleStampedTransforms();
    viewScalePassEpoch = -1;
    tipScalePassEpoch = -1;
  }

  function restoreScaleStampedTransforms(): void {
    const restore = (id: string): void => {
      const rec = p.records().get(id);
      const base = rec?.style.get("transform");
      if (rec?.el && base != null) rec.el.style.transform = base;
    };
    for (const id of viewScaleStamps.keys()) restore(id);
    for (const id of hoverTipSetIds) restore(id);
    viewScaleStamps.clear();
    viewScaleInputStampsCache = [];
    viewScaleInputStampsStale = false;
  }

  function dispose(): void {
    hoverTipSetIds.clear();
    viewScaleIds.clear();
    viewScaleStamps.clear();
    viewScaleInputStampsCache = [];
    viewScaleInputStampsStale = false;
  }

  return {
    hasViewScale,
    hasViewScaleItems,
    hasTipChild,
    resolveVisualOwnerId: (id) => resolveSharedVisualOwnerId(id, tipScaleEnv),
    registerHoverTip,
    cacheTipChild,
    cacheViewScaleGlobal,
    registerViewScale,
    dropViewScale,
    removeHoverTip: (id) => hoverTipSetIds.delete(id),
    applyViewScale,
    applyTipScale,
    inputStamps,
    setUiScaling,
    dispose,
  };
}

function affineEqual(a: Affine | null | undefined, b: Affine): boolean {
  return (
    a != null &&
    a[0] === b[0] &&
    a[1] === b[1] &&
    a[2] === b[2] &&
    a[3] === b[3] &&
    a[4] === b[4] &&
    a[5] === b[5]
  );
}

function sameViewScaleResolved(a: ViewScaleResolved | undefined, b: ViewScaleResolved): boolean {
  return (
    a != null &&
    a.scale === b.scale &&
    a.isGroup === b.isGroup &&
    a.pivot === b.pivot &&
    a.translateX === b.translateX &&
    a.translateY === b.translateY &&
    a.noClamp === b.noClamp
  );
}
