import type { MirrorNode } from "@/mirror/sceneTree";

/** Compose a cover's own alpha through visible ancestor modulates. The caller supplies its budget and alpha rules. */
export function composeCoverAlpha(
  nodes: ReadonlyMap<string, MirrorNode>,
  node: MirrorNode,
  ownAlpha: (node: MirrorNode) => number,
  parentAlpha: (node: MirrorNode) => number,
  budget: number
): number {
  let alpha = ownAlpha(node);
  for (let parent = node.parentId != null ? nodes.get(node.parentId) : undefined; parent != null && budget-- > 0; parent = parent.parentId != null ? nodes.get(parent.parentId) : undefined) {
    if (!parent.visible) return 0;
    alpha *= parentAlpha(parent);
    if (alpha <= 0) return 0;
  }
  return alpha;
}
