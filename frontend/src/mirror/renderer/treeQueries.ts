// Renderer-neutral ancestry and direct-child queries. These deliberately take the
// retained node map from their caller: neither backend owns that map for the other.

import { isEchoContainer, HAND_CARD_ANCESTOR_TYPES } from "@/mirror/renderer/interactionPolicy";
import { nodeTypeLeaf, type MirrorNode } from "@/mirror/sceneTree";

export function isHandCard(nodes: ReadonlyMap<string, MirrorNode>, id: string): boolean {
  for (let cur = nodes.get(id); cur; cur = cur.parentId != null ? nodes.get(cur.parentId) : undefined) {
    if (HAND_CARD_ANCESTOR_TYPES.has(nodeTypeLeaf(cur.nodeType))) return true;
  }
  return false;
}

/** Unlike scene identity, this deliberately walks beyond an instanced-scene root. */
export function hasAncestorSceneFile(
  nodes: ReadonlyMap<string, MirrorNode>,
  id: string,
  suffix: string
): boolean {
  for (let cur = nodes.get(id); cur; cur = cur.parentId != null ? nodes.get(cur.parentId) : undefined) {
    if (cur.sceneFilePath?.endsWith(suffix)) return true;
  }
  return false;
}

export function hasVisibleDirectChild(nodes: ReadonlyMap<string, MirrorNode>, id: string, name: string): boolean {
  for (const node of nodes.values()) {
    if (node.parentId === id && node.name === name) return node.visible;
  }
  return false;
}

/** Echoes are visual copies; start at the parent so the node itself stays independently classifiable. */
export function hasEchoAncestor(nodes: ReadonlyMap<string, MirrorNode>, node: MirrorNode): boolean {
  for (let parent = node.parentId != null ? nodes.get(node.parentId) : undefined; parent; ) {
    if (isEchoContainer(parent)) return true;
    parent = parent.parentId != null ? nodes.get(parent.parentId) : undefined;
  }
  return false;
}
