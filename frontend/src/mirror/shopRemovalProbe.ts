// Renderer-neutral, read-only shop-removal QA seam. Geometry comes from the backend's retained interactive-rect
// surface; this module deliberately never asks the DOM or a canvas draw list how something was rendered.

import type { InteractiveRect } from "@/mirror/renderer/contracts";
import {
  DECK_CARD_SELECT_SCREEN_TYPE,
  hasEffectivelyVisibleDeckCardSelectScreen,
} from "@/mirror/renderer/interactionPolicy";
import { nodeTypeLeaf, type MirrorNode } from "@/mirror/sceneTree";

export interface MirrorShopRemovalProbe {
  service: { id: string; hitboxId: string; gameCenter: { x: number; y: number } } | null;
  picker: {
    screenId: string;
    cards: Array<{ id: string; hitboxId: string; gameCenter: { x: number; y: number } }>;
  } | null;
}

function effectivelyVisible(nodes: ReadonlyMap<string, MirrorNode>, node: MirrorNode): boolean {
  for (let current: MirrorNode | undefined = node; current; current = current.parentId === null ? undefined : nodes.get(current.parentId)) {
    if (!current.visible) return false;
  }
  return true;
}

function isDescendantOf(nodes: ReadonlyMap<string, MirrorNode>, id: string, ancestorId: string): boolean {
  for (let current = nodes.get(id); current; current = current.parentId === null ? undefined : nodes.get(current.parentId)) {
    if (current.id === ancestorId) return true;
  }
  return false;
}

function gameCenter(rect: InteractiveRect): { x: number; y: number } {
  const x = rect.localRect.x + rect.localRect.width / 2;
  const y = rect.localRect.y + rect.localRect.height / 2;
  return {
    x: rect.transform[0] * x + rect.transform[2] * y + rect.transform[4],
    y: rect.transform[1] * x + rect.transform[3] * y + rect.transform[5],
  };
}

function rectFor(nodes: ReadonlyMap<string, MirrorNode>, rects: readonly InteractiveRect[], ownerId: string): InteractiveRect | null {
  // A card root is commonly a 0×0 anchor. Select the largest mouse-visible descendant surface, with the later
  // retained entry (paint order) winning a tie, rather than trusting whichever child happened to be visited first.
  let best: InteractiveRect | null = null;
  let bestArea = -1;
  for (const rect of rects) {
    const node = nodes.get(rect.id);
    if (!node || !effectivelyVisible(nodes, node) || !isDescendantOf(nodes, rect.id, ownerId)) continue;
    const area = Math.abs(rect.transform[0] * rect.transform[3] - rect.transform[1] * rect.transform[2]) * rect.localRect.width * rect.localRect.height;
    if (area >= bestArea) {
      best = rect;
      bestArea = area;
    }
  }
  return best;
}

function holderHitboxFor(nodes: ReadonlyMap<string, MirrorNode>, rects: readonly InteractiveRect[], card: MirrorNode): InteractiveRect | null {
  // The deck picker does not put its hit surface below NCard. Its 0×0 NCard and its 300×422
  // NCardHolderHitbox are siblings below the nearest NGridCardHolder, so the holder is the stable ownership
  // boundary. Other card scenes still use `rectFor` below as their descendant fallback.
  let holder: MirrorNode | null = null;
  for (let current: MirrorNode | undefined = card; current; current = current.parentId === null ? undefined : nodes.get(current.parentId)) {
    if (nodeTypeLeaf(current.nodeType) === "NGridCardHolder") {
      holder = current;
      break;
    }
  }
  if (!holder) return null;
  const directChildren = [...nodes.values()].filter((node) =>
    node.parentId === holder.id && effectivelyVisible(nodes, node),
  );
  const hitboxes = [
    ...directChildren.filter((node) => nodeTypeLeaf(node.nodeType) === "NCardHolderHitbox"),
    ...directChildren.filter((node) => node.name === "Hitbox" && nodeTypeLeaf(node.nodeType) !== "NCardHolderHitbox"),
  ];
  for (const hitbox of hitboxes) {
    const rect = rects.find((candidate) => candidate.id === hitbox.id);
    if (rect) return rect;
  }
  return null;
}

/** Builds the stable QA shape from retained scene identity plus mouse-visible interactive rectangles. */
export function mirrorShopRemovalProbe(
  nodes: ReadonlyMap<string, MirrorNode>,
  rects: readonly InteractiveRect[],
): MirrorShopRemovalProbe {
  let service: MirrorShopRemovalProbe["service"] = null;
  for (const node of nodes.values()) {
    if (nodeTypeLeaf(node.nodeType) !== "NMerchantCardRemoval" || !effectivelyVisible(nodes, node)) continue;
    const costVisible = [...nodes.values()].some((child) => child.parentId === node.id && child.name === "Cost" && effectivelyVisible(nodes, child));
    const hitbox = [...nodes.values()].find((child) => child.parentId === node.id && child.name === "Hitbox");
    const rect = hitbox && effectivelyVisible(nodes, hitbox) ? rects.find((candidate) => candidate.id === hitbox.id) ?? null : null;
    if (costVisible && rect) service = { id: node.id, hitboxId: rect.id, gameCenter: gameCenter(rect) };
  }

  if (!hasEffectivelyVisibleDeckCardSelectScreen(nodes)) return { service, picker: null };
  const screen = [...nodes.values()].find(
    (node) => nodeTypeLeaf(node.nodeType) === DECK_CARD_SELECT_SCREEN_TYPE && effectivelyVisible(nodes, node),
  );
  if (!screen) return { service, picker: null };
  const cards = [...nodes.values()].flatMap((node) => {
    if (nodeTypeLeaf(node.nodeType) !== "NCard" || !effectivelyVisible(nodes, node) || !isDescendantOf(nodes, node.id, screen.id)) return [];
    const rect = holderHitboxFor(nodes, rects, node) ?? rectFor(nodes, rects, node.id);
    return rect ? [{ id: node.id, hitboxId: rect.id, gameCenter: gameCenter(rect) }] : [];
  });
  return { service, picker: { screenId: screen.id, cards } };
}
