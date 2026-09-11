import type { InteractiveRect, RewardFocusRow, RewardFocusSnapshot } from "@/mirror/renderer/contracts";
import { nodeTypeLeaf, type MirrorNode } from "@/mirror/sceneTree";

function effectivelyVisible(nodes: ReadonlyMap<string, MirrorNode>, node: MirrorNode): boolean {
  for (
    let current: MirrorNode | undefined = node;
    current !== undefined;
    current = current.parentId === null ? undefined : nodes.get(current.parentId)
  ) {
    if (!current.visible) return false;
  }
  return true;
}

function descendsFrom(nodes: ReadonlyMap<string, MirrorNode>, id: string, ancestorId: string): boolean {
  let current: string | null | undefined = id;
  let guard = 0;
  while (current !== null && current !== undefined && guard++ < 512) {
    if (current === ancestorId) return true;
    current = nodes.get(current)?.parentId;
  }
  return false;
}

function gameCenter(rect: InteractiveRect): { x: number; y: number } | null {
  const localX = rect.localRect.x + rect.localRect.width / 2;
  const localY = rect.localRect.y + rect.localRect.height / 2;
  const [a, b, c, d, tx, ty] = rect.transform;
  const x = a * localX + c * localY + tx;
  const y = b * localX + d * localY + ty;
  return Number.isFinite(x) && Number.isFinite(y) && rect.localRect.width > 0 && rect.localRect.height > 0
    ? { x, y }
    : null;
}

/**
 * Builds the reward-list facts from renderer-owned native geometry. DOM and canvas pass the same retained scene,
 * interactive rectangles, and cover-order answer, so neither backend needs a browser-layout approximation.
 */
export function rewardFocusSnapshotFromScene(
  nodes: ReadonlyMap<string, MirrorNode>,
  orderedIds: readonly string[],
  interactiveRects: readonly InteractiveRect[],
  coverAbove: (id: string) => boolean
): RewardFocusSnapshot {
  let screenId: string | null = null;
  for (const id of orderedIds) {
    const node = nodes.get(id);
    if (node && nodeTypeLeaf(node.nodeType) === "NRewardsScreen" && effectivelyVisible(nodes, node)) {
      screenId = id;
    }
  }
  if (screenId === null) return { screenId: null, rows: [] };

  const rows: RewardFocusRow[] = [];
  for (const id of orderedIds) {
    const node = nodes.get(id);
    if (
      node &&
      nodeTypeLeaf(node.nodeType) === "NRewardButton" &&
      effectivelyVisible(nodes, node) &&
      descendsFrom(nodes, id, screenId)
    ) {
      rows.push({ id, focused: node.focused, covered: coverAbove(id), gameCenter: null });
    }
  }

  // Prefer the conventional Hitbox descendant, then the row root itself, then any interactive descendant. The
  // chosen rectangle is always native game geometry; spread/raise are cosmetic and intentionally do not enter it.
  const best = new Map<string, { rank: number; point: { x: number; y: number } }>();
  for (const rect of interactiveRects) {
    const point = gameCenter(rect);
    const rectNode = nodes.get(rect.id);
    if (point === null || rectNode === undefined) continue;
    for (const row of rows) {
      if (!descendsFrom(nodes, rect.id, row.id)) continue;
      const rank = rectNode.name === "Hitbox" ? 0 : rect.id === row.id ? 1 : 2;
      if ((best.get(row.id)?.rank ?? Infinity) > rank) best.set(row.id, { rank, point });
      break;
    }
  }
  for (const row of rows) row.gameCenter = best.get(row.id)?.point ?? null;

  return { screenId, rows };
}
