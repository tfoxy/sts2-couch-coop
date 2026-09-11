// Shared scene/touch identity walks. DOM applies the answers as attributes; the
// canvas backend keeps its own hit-list and clip ordering around these pure queries.

import {
  PROCEED_BUTTON_SCENE_FILE_SUFFIX,
  TOUCH_TARGET_TYPES,
  isMultiplayerPlayerStateSceneRoot,
  isVisibleDeckCardSelectCard,
  isVisibleCardGridSelectionCard,
  isBlockingButtonType,
  isDecorativeOverlay,
  isEchoContainer,
  isScrollbarBlockType,
  scrollbarBlockKind,
  type TouchBlockKind
} from "@/mirror/renderer/interactionPolicy";
import { nodeTypeLeaf, type MirrorNode } from "@/mirror/sceneTree";

export interface SceneInfo { file: string; rootId: string; relPath: string; }
export type SceneRootIdentity = Pick<SceneInfo, "file" | "rootId">;
export type TouchInfo = { kind: "target"; id: string } | { kind: "block"; block: TouchBlockKind };

export interface SceneTouchMemo {
  scene: Map<string, SceneRootIdentity | null>;
  touch: Map<string, TouchInfo | null>;
  reset(): void;
}

export function createSceneTouchMemo(): SceneTouchMemo {
  const scene = new Map<string, SceneRootIdentity | null>();
  const touch = new Map<string, TouchInfo | null>();
  return { scene, touch, reset: () => { scene.clear(); touch.clear(); } };
}

export function computeNodePath(id: string, nodes: ReadonlyMap<string, MirrorNode>): string {
  const parts: string[] = [];
  for (let cur = nodes.get(id); cur; cur = cur.parentId != null ? nodes.get(cur.parentId) : undefined) {
    if (cur.name) parts.unshift(cur.name);
  }
  return parts.join("/");
}

export function resolveSceneInfo(id: string, nodes: ReadonlyMap<string, MirrorNode>): SceneInfo | null {
  const names: string[] = [];
  for (let cur = nodes.get(id); cur; cur = cur.parentId != null ? nodes.get(cur.parentId) : undefined) {
    if (cur.sceneFilePath) return { file: cur.sceneFilePath, rootId: cur.id, relPath: names.join("/") };
    if (cur.name) names.unshift(cur.name);
  }
  return null;
}

export function sceneIdentityOf(
  id: string,
  nodes: ReadonlyMap<string, MirrorNode>,
  memo: SceneTouchMemo | null = null
): SceneRootIdentity | null {
  if (memo === null) {
    const scene = resolveSceneInfo(id, nodes);
    return scene ? { file: scene.file, rootId: scene.rootId } : null;
  }
  const hit = memo.scene.get(id);
  if (hit !== undefined) return hit;
  const chain: string[] = [];
  let answer: SceneRootIdentity | null = null;
  for (let cur = nodes.get(id); cur; cur = cur.parentId != null ? nodes.get(cur.parentId) : undefined) {
    const cached = memo.scene.get(cur.id);
    if (cached !== undefined) { answer = cached; break; }
    chain.push(cur.id);
    if (cur.sceneFilePath) { answer = { file: cur.sceneFilePath, rootId: cur.id }; break; }
  }
  for (const memoId of chain) memo.scene.set(memoId, answer);
  return answer;
}

export function countVisibleEventOptions(nodes: ReadonlyMap<string, MirrorNode>): number {
  let n = 0;
  for (const node of nodes.values()) {
    if (nodeTypeLeaf(node.nodeType) !== "NEventOptionButton" || !node.visible) continue;
    let hidden = false;
    for (let parent = node.parentId != null ? nodes.get(node.parentId) : undefined; parent; parent = parent.parentId != null ? nodes.get(parent.parentId) : undefined) {
      if (!parent.visible) { hidden = true; break; }
    }
    if (!hidden && ++n > 1) break;
  }
  return n;
}

export function resolveTouchInfo(
  id: string,
  nodes: ReadonlyMap<string, MirrorNode>,
  memo: SceneTouchMemo | null = null
): TouchInfo | null {
  if (memo !== null) {
    const hit = memo.touch.get(id);
    if (hit !== undefined) return hit;
  }
  const chain: string[] = memo === null ? EMPTY_CHAIN : [];
  let decorative = false;
  let targetId: string | null = null;
  let answer: TouchInfo | null | undefined;
  for (let cur = nodes.get(id); cur; cur = cur.parentId != null ? nodes.get(cur.parentId) : undefined) {
    if (memo !== null && targetId === null && !decorative) {
      const cached = memo.touch.get(cur.id);
      if (cached !== undefined) { answer = cached; break; }
      chain.push(cur.id);
    }
    if (isEchoContainer(cur)) { answer = null; break; }
    if (targetId !== null) continue;
    if (isDecorativeOverlay(cur)) decorative = true;
    const leaf = nodeTypeLeaf(cur.nodeType);
    if (TOUCH_TARGET_TYPES.has(leaf)) {
      const scene = sceneIdentityOf(cur.id, nodes, memo);
      if (scene?.file.endsWith(PROCEED_BUTTON_SCENE_FILE_SUFFIX)) { answer = { kind: "block", block: "button" }; break; }
      if (leaf === "NEventOptionButton" && countVisibleEventOptions(nodes) === 1) { answer = { kind: "block", block: "button" }; break; }
      targetId = cur.id;
    } else if (isMultiplayerPlayerStateSceneRoot(cur)) {
      // A remote player state is a scene-root fallback, not a type rule: its HP and ordinary descendants arm the
      // widget, but a nearer explicit target/block keeps its own interaction contract.
      targetId = cur.id;
    } else if (isScrollbarBlockType(cur.nodeType)) { answer = { kind: "block", block: scrollbarBlockKind(cur.nodeType) }; break; }
    else if (isBlockingButtonType(cur.nodeType)) { answer = { kind: "block", block: "button" }; break; }
  }
  if (answer === undefined) {
    if (targetId !== null && !decorative) {
      // Let the game-owned confirmation in a decision picker be the only confirmation. This must be decided AFTER
      // the complete ancestry walk so echo/decorative copies remain inert rather than becoming blocking surfaces.
      answer = isVisibleCardGridSelectionCard(targetId, nodes) || isVisibleDeckCardSelectCard(targetId, nodes)
        ? { kind: "block", block: "button" }
        : { kind: "target", id: targetId };
    } else {
      answer = null;
    }
  }
  if (memo !== null) for (const memoId of chain) memo.touch.set(memoId, answer);
  return answer;
}

const EMPTY_CHAIN: string[] = [];
