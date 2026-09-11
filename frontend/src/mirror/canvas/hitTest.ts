// Canvas-specific hit-list construction and ordering. Scene/touch identity is
// shared with DOM in renderer/sceneIdentity; clipping remains canvas-owned.

import type { Affine } from "@/mirror/affine";
import { isHitTestExcluded, type TouchBlockKind } from "@/mirror/renderer/interactionPolicy";
import { pointInPlacedRect } from "@/mirror/raiseInverse";
import type { MirrorNode, MirrorRect } from "@/mirror/sceneTree";
import {
  resolveTouchInfo,
  sceneIdentityOf,
  type SceneTouchMemo,
  type TouchInfo
} from "@/mirror/renderer/sceneIdentity";

import type { ClipSpec } from "@/mirror/canvas/paintSpec";

export interface ClipScope {
  id: string;
  spec: ClipSpec;
}

export interface HitEntry {
  nodeId: string;
  order: number;
  mFinal: Affine;
  mGame: Affine;
  spreadDx: number;
  renderedWidth: number;
  spreadProp: boolean;
  localRect: MirrorRect;
  /** Canvas owns this order-sensitive clip chain. */
  clipScopeChain: readonly ClipScope[];
  paints: boolean;
  mouseVisible: boolean;
  touchOwnerId: string | null;
  touchBlock: TouchBlockKind | null;
  sceneFile: string | null;
  sceneRootId: string | null;
}

export const NO_CLIP_SCOPES: readonly ClipScope[] = Object.freeze([]);

export function isHitSurfaceCandidate(node: MirrorNode): boolean {
  return node.transform != null && node.localRect != null && !isHitTestExcluded(node);
}

export function isMouseVisible(node: MirrorNode): boolean {
  return node.mouseFilter === 0 || node.mouseFilter === 1;
}

/** Compatibility name for the optional per-build cache; the canvas build owns its reset. */
export type HitMemo = SceneTouchMemo;
export type { TouchInfo };
export {
  createSceneTouchMemo as createHitMemo,
  resolveSceneInfo,
  resolveTouchInfo,
  sceneIdentityOf
} from "@/mirror/renderer/sceneIdentity";

export interface HitEntryInput {
  node: MirrorNode;
  nodes: Map<string, MirrorNode>;
  memo?: HitMemo | null;
  order: number;
  mFinal: Affine;
  mGame: Affine;
  clipScopeChain: readonly ClipScope[];
  paints: boolean;
  hidden: boolean;
  spreadDx?: number;
  renderedWidth?: number;
  spreadProp?: boolean;
}

export function buildHitEntry(input: HitEntryInput): HitEntry | null {
  const node = input.node;
  if (input.hidden || !node.visible || !isHitSurfaceCandidate(node) || !node.localRect) return null;
  const memo = input.memo ?? null;
  const scene = sceneIdentityOf(node.id, input.nodes, memo);
  const touch = resolveTouchInfo(node.id, input.nodes, memo);
  return {
    nodeId: node.id,
    order: input.order,
    mFinal: input.mFinal,
    mGame: input.mGame,
    spreadDx: input.spreadDx ?? 0,
    renderedWidth: input.renderedWidth ?? 0,
    spreadProp: input.spreadProp ?? false,
    localRect: node.localRect,
    clipScopeChain: input.clipScopeChain,
    paints: input.paints,
    mouseVisible: isMouseVisible(node),
    touchOwnerId: touch?.kind === "target" ? touch.id : null,
    touchBlock: touch?.kind === "block" ? touch.block : null,
    sceneFile: scene?.file ?? null,
    sceneRootId: scene?.rootId ?? null
  };
}

/** Every surface under a design-space point, topmost first. */
export function hitStack(entries: readonly HitEntry[], designX: number, designY: number): HitEntry[] {
  const out: HitEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (pointInPlacedRect(entry.mFinal, entry.localRect, designX, designY) && insideClipChain(entry.clipScopeChain, designX, designY)) {
      out.push(entry);
    }
  }
  return out;
}

export function insideClipChain(chain: readonly ClipScope[], x: number, y: number): boolean {
  for (const scope of chain) {
    const s = scope.spec;
    if (x < s.x - s.outsetX || x > s.x + s.w + s.outsetX || y < s.y || y > s.y + s.h) return false;
  }
  return true;
}
