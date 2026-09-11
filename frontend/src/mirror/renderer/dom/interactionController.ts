import type { ConfirmTapKind } from "@/mirror/confirmTap";
import {
  affineInverse,
  affineMul,
  IDENTITY_AFFINE,
  nodeMatrix,
  type Affine,
} from "@/mirror/affine";
import { type EagerScrollTarget } from "@/mirror/eagerScroll";
import {
  buildEagerScrollTargets,
  scanEagerScrollIds,
  type EagerScrollCandidate,
  type EagerScrollLayoutEnv,
} from "@/mirror/eagerScrollLayout";
import { pointInPlacedRect } from "@/mirror/raiseInverse";
import {
  MIRROR_DESIGN_WIDTH,
  nodeTypeLeaf,
  type MirrorNode,
  type MirrorRect,
} from "@/mirror/sceneTree";
import type { ConfirmTapHit, InteractiveRect } from "@/mirror/renderer/contracts";
import {
  CARD_TOUCH_TARGET_TYPES,
  DRAWING_TOOL_ARMED_TEXTURES,
  PROCEED_BUTTON_SCENE_FILE_SUFFIX,
  confirmTapEligible,
  hasEffectivelyVisibleDeckCardSelectScreen,
  hasEffectivelyVisibleCardGridSelection,
  isHitTestExcluded,
  type TouchBlockKind,
} from "@/mirror/renderer/interactionPolicy";
import {
  hasAncestorSceneFile as hasSharedAncestorSceneFile,
  hasEchoAncestor as hasSharedEchoAncestor,
  hasVisibleDirectChild,
  isHandCard as isSharedHandCard
} from "@/mirror/renderer/treeQueries";
import { HAND_CHOICE_NAMES, HAND_CHOICE_TYPES } from "@/mirror/raise/constants";
import {
  VIEW_SCALE_NOMINAL_CARD_H,
  VIEW_SCALE_NOMINAL_CARD_W,
} from "@/mirror/viewScaleLayout";
import type { RenderRecord } from "@/mirror/renderer/dom/recordModel";
import { mirrorWalkStats } from "@/mirror/renderer/walkStats";

// The renderer's retained-tree interaction sidecar. It deliberately owns no scene data: maps, order, transform
// space and geometry epoch arrive through getters because each is replaced as deltas reconcile. Its private caches
// therefore follow exactly the same lifetime as the old renderer-closure versions, while queries always read the
// live tree and records.
type SceneInfo = { file: string; rootId: string; relPath: string } | null;
type TouchInfo =
  | { kind: "target"; id: string }
  | { kind: "block"; block: TouchBlockKind }
  | null;

export interface InteractionControllerPorts {
  nodes: () => Map<string, MirrorNode>;
  records: () => Map<string, RenderRecord>;
  childIds: () => Map<string, string[]>;
  orderedIds: () => string[];
  lastOrderedIds: () => string[] | null;
  geometryEpoch: () => number;
  spreadFactor: () => number;
  raisedRectDy: () => ReadonlyMap<string, number>;
  handHitboxIds: () => ReadonlyMap<string, string>;
  computeNodePath: (id: string) => string;
  computeSceneInfo: (id: string) => SceneInfo;
  computeTouchInfo: (id: string) => TouchInfo;
  resolveVisualOwnerId: (id: string) => string;
  liftEndpointToGlobal: (record: RenderRecord, transform: number[]) => Affine;
  coverAbove: (id: string) => boolean;
  setConfirmCoverWatch: (on: boolean) => void;
  paintIndexOf: (id: string) => number;
}

export interface InteractionController {
  computeNodePath(id: string): string;
  computeSceneInfo(id: string): SceneInfo;
  computeTouchInfo(id: string): TouchInfo;
  resolveVisualOwnerId(id: string): string;
  isHandCard(id: string): boolean;
  countVisibleEventOptions(): number;
  handChoiceActive(): boolean;
  mapDrawingToolActive(): boolean;
  forEachInteractiveRect(cb: InteractiveRectCallback): void;
  ancestorChainHidden(node: MirrorNode): boolean;
  hitTestShift(px: number, py: number): number;
  interactiveRects(): InteractiveRect[];
  endTurnBoxAt(gameX: number, gameY: number): RectAabb | null;
  eagerScrollTargets(): EagerScrollTarget[];
  applyLocalOffset(nodeId: string, dy: number): void;
  scrollRenderedY(nodeId: string): number | null;
  isUnderNode(id: string, ancestorId: string): boolean;
  isCardTouchTarget(id: string): boolean;
  confirmTapTarget(id: string): ConfirmTapKind | null;
  confirmTapAt(
    gameX: number,
    gameY: number,
  ): ConfirmTapHit | null;
  coverAbove(id: string): boolean;
  setConfirmCoverWatch(on: boolean): void;
  paintIndexOf(id: string): number;
  dispose(): void;
}

type RectAabb = { minX: number; minY: number; maxX: number; maxY: number };
type InteractiveRectCallback = (
  id: string,
  global: Affine,
  localRect: MirrorRect,
  spreadDx: number,
  renderedWidth: number,
  raiseDy: number,
  raiseGoverned: boolean,
) => void;

const COMPOSE_CHAIN_GUARD = 256;

export function createInteractionController(
  ports: InteractionControllerPorts,
): InteractionController {
  // Public visible mouse-visible boxes are shared by inputCapture, the view-scale registry, and test seams. Cache
  // against the renderer's geometry epoch so the list and the hidden-ancestor walk are rebuilt only when a rect can
  // have moved; callers must treat the returned array as read-only.
  let interactiveRectsCache: InteractiveRect[] | null = null;
  let interactiveRectsEpoch = -1;
  // "Is the chain from this id upward hidden?" is pure for one geometry epoch. Memoizing it removes the former
  // O(N×depth) ancestor climb from every interactive candidate; the uncached walk remains the comparison baseline.
  const hiddenChainMemo = new Map<string, boolean>();
  let hiddenChainMemoEpoch = -1;
  // Scrollable membership changes only with order identity. Values are rebuilt every call because a live scroll can
  // move without a structural delta; effective visibility remains the shared builder's live responsibility.
  let eagerScrollIds: EagerScrollCandidate[] | null = null;
  let eagerScrollIdsOrder: string[] | null = null;

  const eagerScrollLayoutEnv: EagerScrollLayoutEnv = {
    orderedIds: ports.orderedIds,
    nodeById: (id) => ports.nodes().get(id),
    childIdsOf: (id) => ports.childIds().get(id),
    typeLeafOf: (node) => nodeTypeLeaf(node.nodeType),
    streamedGlobalOf: (id, node) => {
      const record = ports.records().get(id);
      return record && node.transform != null
        ? ports.liftEndpointToGlobal(record, node.transform)
        : null;
    },
    hasHost: (id) => ports.records().get(id)?.el != null,
    spreadDxOf: (id) => ports.records().get(id)?.spreadDx ?? 0,
    renderedYOf: (id, fallback) => {
      const record = ports.records().get(id);
      return record ? baseTranslateY(record, fallback) : fallback;
    },
    ancestorHidden: ancestorChainHidden,
    transformPinned: (id) => ports.records().get(id)?.tweenTransform != null,
    drawingToolActive: mapDrawingToolActive,
  };

  function computeNodePath(id: string): string {
    return ports.computeNodePath(id);
  }

  function computeSceneInfo(id: string): SceneInfo {
    return ports.computeSceneInfo(id);
  }

  function computeTouchInfo(id: string): TouchInfo {
    return ports.computeTouchInfo(id);
  }

  function resolveVisualOwnerId(id: string): string {
    return ports.resolveVisualOwnerId(id);
  }

  function isHandCard(id: string): boolean {
    return isSharedHandCard(ports.nodes(), id);
  }

  function countVisibleEventOptions(): number {
    const nodes = ports.nodes();
    let n = 0;
    for (const node of nodes.values()) {
      if (nodeTypeLeaf(node.nodeType) !== "NEventOptionButton" || !node.visible)
        continue;
      let hidden = false;
      for (
        let p = node.parentId ? nodes.get(node.parentId) : undefined;
        p;
        p = p.parentId ? nodes.get(p.parentId) : undefined
      ) {
        if (!p.visible) {
          hidden = true;
          break;
        }
      }
      if (!hidden && ++n > 1) break;
    }
    return n;
  }

  function handChoiceActive(): boolean {
    const nodes = ports.nodes();
    for (const node of nodes.values()) {
      if (
        (!HAND_CHOICE_TYPES.has(nodeTypeLeaf(node.nodeType)) &&
          !HAND_CHOICE_NAMES.has(node.name)) ||
        !node.visible
      )
        continue;
      let hidden = false;
      for (
        let p = node.parentId ? nodes.get(node.parentId) : undefined;
        p;
        p = p.parentId ? nodes.get(p.parentId) : undefined
      ) {
        if (!p.visible) {
          hidden = true;
          break;
        }
      }
      if (!hidden) return true;
    }
    return false;
  }

  function mapDrawingToolActive(): boolean {
    const nodes = ports.nodes();
    for (const node of nodes.values()) {
      const url = node.textureUrl;
      if (
        url === null ||
        !DRAWING_TOOL_ARMED_TEXTURES.some((suffix) => url.endsWith(suffix)) ||
        !node.visible
      )
        continue;
      let hidden = false;
      for (
        let p = node.parentId ? nodes.get(node.parentId) : undefined;
        p;
        p = p.parentId ? nodes.get(p.parentId) : undefined
      ) {
        if (!p.visible) {
          hidden = true;
          break;
        }
      }
      if (!hidden) return true;
    }
    return false;
  }

  function forEachInteractiveRect(cb: InteractiveRectCallback): void {
    const records = ports.records();
    const raisedRectDy = ports.raisedRectDy();
    const handHitboxIds = ports.handHitboxIds();
    for (const id of ports.orderedIds()) {
      const record = records.get(id);
      const node = record?.lastNode;
      if (
        !record ||
        !node ||
        !node.visible ||
        (node.mouseFilter !== 0 && node.mouseFilter !== 1) ||
        !node.transform ||
        !node.localRect
      ) {
        continue;
      }
      if (isHitTestExcluded(node) || ancestorChainHidden(node)) continue;
      const raiseDy = raisedRectDy.size === 0 ? 0 : (raisedRectDy.get(id) ?? 0);
      cb(
        id,
        ports.liftEndpointToGlobal(record, node.transform),
        node.localRect,
        record.spreadDx,
        record.spreadW,
        raiseDy,
        raisedRectDy.size > 0 && handHitboxIds.has(id),
      );
    }
  }

  function ancestorChainHidden(node: MirrorNode): boolean {
    const startId = node.parentId;
    if (startId == null) return false;
    const nodes = ports.nodes();
    const epoch = ports.geometryEpoch();
    if (hiddenChainMemoEpoch !== epoch) {
      hiddenChainMemo.clear();
      hiddenChainMemoEpoch = epoch;
    }
    const memoized = hiddenChainMemo.get(startId);
    if (memoized !== undefined) return memoized;
    const chain: string[] = [];
    let hidden = false;
    let curId: string | null = startId;
    while (curId != null) {
      const cached = hiddenChainMemo.get(curId);
      if (cached !== undefined) {
        hidden = cached;
        break;
      }
      const parent = nodes.get(curId);
      if (!parent) break;
      chain.push(curId);
      if (!parent.visible) {
        hidden = true;
        break;
      }
      curId = parent.parentId;
    }
    for (const id of chain) hiddenChainMemo.set(id, hidden);
    return hidden;
  }

  function hitTestShift(px: number, py: number): number {
    const clampedX =
      px < 0 ? 0 : px > MIRROR_DESIGN_WIDTH ? MIRROR_DESIGN_WIDTH : px;
    let dx = (ports.spreadFactor() - 1) * clampedX;
    forEachInteractiveRect((_id, global, localRect, spreadDx) => {
      const inv = affineInverse(nodeMatrix(global, localRect));
      if (!inv) return;
      const lx = inv[0] * px + inv[2] * py + inv[4];
      const ly = inv[1] * px + inv[3] * py + inv[5];
      if (lx >= 0 && lx <= localRect.width && ly >= 0 && ly <= localRect.height)
        dx = spreadDx;
    });
    return dx;
  }

  function interactiveRects(): InteractiveRect[] {
    const epoch = ports.geometryEpoch();
    if (interactiveRectsCache !== null && interactiveRectsEpoch === epoch) {
      return interactiveRectsCache;
    }
    const out: InteractiveRect[] = [];
    forEachInteractiveRect(
      (
        id,
        global,
        localRect,
        spreadDx,
        renderedWidth,
        raiseDy,
        raiseGoverned,
      ) =>
        out.push({
          id,
          transform: global,
          localRect,
          spreadDx,
          renderedWidth,
          raiseDy,
          raiseGoverned,
        }),
    );
    mirrorWalkStats.interactiveRectRebuilds++;
    interactiveRectsCache = out;
    interactiveRectsEpoch = epoch;
    return out;
  }

  function endTurnBoxAt(gameX: number, gameY: number): RectAabb | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let any = false;
    forEachInteractiveRect((id, global, localRect) => {
      const scene = computeSceneInfo(id);
      if (!scene || !scene.file.endsWith("end_turn_button.tscn")) return;
      const matrix = nodeMatrix(global, localRect);
      for (const [cx, cy] of [
        [0, 0],
        [localRect.width, 0],
        [0, localRect.height],
        [localRect.width, localRect.height],
      ]) {
        const px = matrix[0] * cx + matrix[2] * cy + matrix[4];
        const py = matrix[1] * cx + matrix[3] * cy + matrix[5];
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
      any = true;
    });
    return any &&
      gameX >= minX &&
      gameX <= maxX &&
      gameY >= minY &&
      gameY <= maxY
      ? { minX, minY, maxX, maxY }
      : null;
  }

  function eagerScrollTargets(): EagerScrollTarget[] {
    if (
      eagerScrollIdsOrder !== ports.lastOrderedIds() ||
      eagerScrollIds === null
    ) {
      eagerScrollIds = scanEagerScrollIds(eagerScrollLayoutEnv);
      eagerScrollIdsOrder = ports.lastOrderedIds();
    }
    const out = buildEagerScrollTargets(eagerScrollIds, eagerScrollLayoutEnv);
    // The shared snapshot is DOM-agnostic. Attach only the current record's element here: writing by id at apply
    // time means a local offset cannot land on an element that pooling has recycled for another node.
    const records = ports.records();
    for (const target of out) {
      target.el = records.get(target.id)?.el ?? null;
      if (target.bar) target.bar.el = records.get(target.bar.id)?.el ?? null;
    }
    return out;
  }

  function applyLocalOffset(nodeId: string, dy: number): void {
    const el = ports.records().get(nodeId)?.el;
    if (!el) return;
    const value = Math.abs(dy) < 0.01 ? "0px" : `0px ${dy.toFixed(2)}px`;
    if (el.style.translate !== value) el.style.translate = value;
  }

  function scrollRenderedY(nodeId: string): number | null {
    const record = ports.records().get(nodeId);
    if (!record) return null;
    const painted = baseTranslateY(record, Number.NaN);
    return Number.isFinite(painted) ? painted : null;
  }

  function isUnderNode(id: string, ancestorId: string): boolean {
    const nodes = ports.nodes();
    for (
      let cur: string | null | undefined = id;
      cur != null;
      cur = nodes.get(cur)?.parentId
    ) {
      if (cur === ancestorId) return true;
    }
    return false;
  }

  function isCardTouchTarget(id: string): boolean {
    return CARD_TOUCH_TARGET_TYPES.has(
      nodeTypeLeaf(ports.records().get(id)?.lastNode?.nodeType ?? ""),
    );
  }

  function confirmTapTarget(id: string): ConfirmTapKind | null {
    // Identifies irreversible choice widgets without making their ordinary touch surface different. The coordinate
    // half below supplies the true per-kind box for widgets whose game hit surface is absent from interactiveRects.
    if (
      hasEffectivelyVisibleCardGridSelection(ports.nodes()) ||
      hasEffectivelyVisibleDeckCardSelectScreen(ports.nodes())
    ) {
      return null;
    }
    return confirmTapEligible(
      ports.nodes().get(id),
      isHandCard,
      hasAncestorSceneFile,
      hasVisibleChild,
    );
  }

  function confirmTapAt(
    gameX: number,
    gameY: number,
  ): ConfirmTapHit | null {
    const nodes = ports.nodes();
    if (
      hasEffectivelyVisibleCardGridSelection(nodes) ||
      hasEffectivelyVisibleDeckCardSelectScreen(nodes)
    ) {
      return null;
    }
    let hit: ConfirmTapHit | null = null;
    let loneEventOption: boolean | null = null;
    for (const node of nodes.values()) {
      const kind = confirmTapEligible(
        node,
        isHandCard,
        hasAncestorSceneFile,
        hasVisibleChild,
      );
      if (kind === null || !node.visible || ancestorChainHidden(node)) continue;
      if (kind === "event") {
        // Proceed and a lone remaining event option are immediate presses, not choices, so no confirmation button.
        const scene = computeSceneInfo(node.id);
        if (scene && scene.file.endsWith(PROCEED_BUTTON_SCENE_FILE_SUFFIX))
          continue;
        if (loneEventOption === null)
          loneEventOption = countVisibleEventOptions() === 1;
        if (loneEventOption) continue;
      }
      // Echoes render a reward card elsewhere for inspection; only the real choice owns a confirmation target.
      if (kind === "reward" && hasEchoAncestor(node)) continue;
      const box = confirmHitBox(node, kind);
      if (
        box !== null &&
        pointInPlacedRect(box.transform, box.localRect, gameX, gameY)
      ) {
        if (
          hit === null ||
          ports.paintIndexOf(node.id) > ports.paintIndexOf(hit.id)
        ) {
          hit = {
            id: node.id,
            kind,
            ...(nodeTypeLeaf(node.nodeType) === "NMerchantCardRemoval" ? { retapActivates: true } : {})
          };
        }
      }
    }
    return hit;
  }

  function hasVisibleChild(id: string, name: string): boolean {
    return hasVisibleDirectChild(ports.nodes(), id, name);
  }

  function hasAncestorSceneFile(id: string, suffix: string): boolean {
    // Scene identity stops at the nearest instance root; this keeps walking to distinguish a reward card from the
    // same card scene embedded in a deck dialog. Bounded by scene depth and touch-time only.
    return hasSharedAncestorSceneFile(ports.nodes(), id, suffix);
  }

  function confirmHitBox(
    node: MirrorNode,
    kind: ConfirmTapKind,
  ): { transform: Affine; localRect: MirrorRect } | null {
    // TRUE hit-box registry: rest/event use their root box; shop prefers its clickable Hitbox child then falls back
    // to root; relic uses its root; reward cards use the nominal 240×338 centered at their zero-size NCard origin.
    // The ignored rest/event roots must be composed here because they are absent from interactiveRects.
    if (kind === "reward") {
      const global = trueGlobalOf(node);
      if (global === null) return null;
      return {
        transform: global,
        localRect: {
          x: -VIEW_SCALE_NOMINAL_CARD_W / 2,
          y: -VIEW_SCALE_NOMINAL_CARD_H / 2,
          width: VIEW_SCALE_NOMINAL_CARD_W,
          height: VIEW_SCALE_NOMINAL_CARD_H,
        },
      };
    }
    if (kind === "shop") {
      const nodes = ports.nodes();
      for (const kid of ports.childIds().get(node.id) ?? []) {
        const child = nodes.get(kid);
        if (child?.name === "Hitbox" && child.localRect) {
          const global = trueGlobalOf(child);
          if (global !== null)
            return { transform: global, localRect: child.localRect };
        }
      }
    }
    if (
      !node.localRect ||
      node.localRect.width <= 0 ||
      node.localRect.height <= 0
    )
      return null;
    const global = trueGlobalOf(node);
    return global === null
      ? null
      : { transform: global, localRect: node.localRect };
  }

  function trueGlobalOf(node: MirrorNode): Affine | null {
    if (node.transform == null) return null;
    // The retained walk's parent global wins because it includes renderer-only placement (pins and latched trails).
    // But a node-map orphan vetoes it first: an orphan record is parked at identity, which would incorrectly put an
    // active confirm target in the design corner. The complete node map then provides the fallback around dormancy.
    const composed = composedParentGlobalFromNodes(node);
    if (composed === null) return null;
    const parentGlobal =
      ports.records().get(node.id)?.cParentGlobal ?? composed;
    return affineMul(parentGlobal, node.transform as Affine);
  }

  function composedParentGlobalFromNodes(node: MirrorNode): Affine | null {
    // A root's parent frame is identity. A missing parent is instead an orphan: return null, never identity, so a
    // transient broken chain degrades to ordinary two-step tap rather than claiming the design corner. The guard is
    // a cycle bound, not a real-scene depth limit.
    if (node.parentId == null) return IDENTITY_AFFINE;
    const nodes = ports.nodes();
    const chain: MirrorNode[] = [];
    let curId: string | null = node.parentId;
    for (let guard = 0; curId != null; guard++) {
      if (guard >= COMPOSE_CHAIN_GUARD) return null;
      const cur = nodes.get(curId);
      if (!cur) return null;
      chain.push(cur);
      curId = cur.parentId;
    }
    let global: Affine = IDENTITY_AFFINE;
    for (let i = chain.length - 1; i >= 0; i--) {
      const transform = chain[i].transform;
      if (transform != null && transform.length === 6)
        global = affineMul(global, transform as Affine);
    }
    return global;
  }

  function hasEchoAncestor(node: MirrorNode): boolean {
    return hasSharedEchoAncestor(ports.nodes(), node);
  }

  function coverAbove(id: string): boolean {
    return ports.coverAbove(id);
  }
  function setConfirmCoverWatch(on: boolean): void {
    ports.setConfirmCoverWatch(on);
  }
  function paintIndexOf(id: string): number {
    return ports.paintIndexOf(id);
  }

  function dispose(): void {
    interactiveRectsCache = null;
    eagerScrollIds = null;
    eagerScrollIdsOrder = null;
    hiddenChainMemo.clear();
    hiddenChainMemoEpoch = -1;
  }

  return {
    computeNodePath,
    computeSceneInfo,
    computeTouchInfo,
    resolveVisualOwnerId,
    isHandCard,
    countVisibleEventOptions,
    handChoiceActive,
    mapDrawingToolActive,
    forEachInteractiveRect,
    ancestorChainHidden,
    hitTestShift,
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
    setConfirmCoverWatch,
    paintIndexOf,
    dispose,
  };
}

function baseTranslateY(record: RenderRecord, fallback: number): number {
  // Read the walk's stamp-free STYLE CACHE, never el.style.transform: view/tip scale passes prepend a stamp directly
  // to the element, while eager scroll must compose against the matrix Y the walk actually baked for this node.
  const transform = record.style.get("transform");
  if (!transform) return fallback;
  const open = transform.indexOf("matrix(");
  if (open < 0) return fallback;
  const close = transform.indexOf(")", open);
  if (close < 0) return fallback;
  const parts = transform.slice(open + 7, close).split(",");
  if (parts.length !== 6) return fallback;
  const f = Number(parts[5]);
  return Number.isFinite(f) ? f : fallback;
}
