import type { MirrorNode } from "@/mirror/sceneTree";
import { nodeTypeLeaf } from "@/mirror/sceneTree";
import { TOUCH_BLOCK_ATTR, type TouchBlockKind } from "@/mirror/renderer/interactionPolicy";
import {
  computeNodePath as computeSharedNodePath,
  resolveSceneInfo as resolveSharedSceneInfo,
  resolveTouchInfo as resolveSharedTouchInfo,
  type SceneInfo
} from "@/mirror/renderer/sceneIdentity";

export type { SceneInfo } from "@/mirror/renderer/sceneIdentity";

export interface SceneIdentityPorts {
  nodes(): ReadonlyMap<string, MirrorNode>;
  isHandRaisable(node: MirrorNode): boolean;
  stampTextScale(el: HTMLElement, scene: SceneInfo | null): void;
}

export interface SceneIdentityRuntime {
  computeNodePath(id: string): string;
  computeSceneInfo(id: string): SceneInfo | null;
  computeTouchInfo(id: string): { kind: "target"; id: string } | { kind: "block"; block: TouchBlockKind } | null;
  stampIdentityAttrs(el: HTMLElement, id: string, node: MirrorNode): void;
}

export function createSceneIdentity(ports: SceneIdentityPorts): SceneIdentityRuntime {
  function computeNodePath(id: string): string {
    return computeSharedNodePath(id, ports.nodes());
  }

  function computeSceneInfo(id: string): SceneInfo | null {
    return resolveSharedSceneInfo(id, ports.nodes());
  }

  function computeTouchInfo(id: string): { kind: "target"; id: string } | { kind: "block"; block: TouchBlockKind } | null {
    return resolveSharedTouchInfo(id, ports.nodes());
  }

  function stampIdentityAttrs(el: HTMLElement, id: string, node: MirrorNode): void {
    if (nodeTypeLeaf(node.nodeType) === "NCard") el.classList.add("mirror-card-liftable", "mirror-held-card");
    else el.classList.remove("mirror-card-liftable", "mirror-held-card");
    if (ports.isHandRaisable(node)) el.classList.add("mirror-hand-raisable");
    else el.classList.remove("mirror-hand-raisable");
    el.setAttribute("data-node-id", id);
    el.setAttribute("data-node-path", computeNodePath(id));
    const scene = computeSceneInfo(id);
    if (scene) {
      el.setAttribute("data-scene-file", scene.file);
      el.setAttribute("data-scene-node-path", scene.relPath);
      el.setAttribute("data-scene-root-id", scene.rootId);
    } else {
      el.removeAttribute("data-scene-file");
      el.removeAttribute("data-scene-node-path");
      el.removeAttribute("data-scene-root-id");
    }
    ports.stampTextScale(el, scene);
    const touch = computeTouchInfo(id);
    if (touch?.kind === "target") {
      el.setAttribute("data-touch-id", touch.id);
      el.removeAttribute("data-touch-block");
    } else if (touch?.kind === "block") {
      el.setAttribute("data-touch-block", TOUCH_BLOCK_ATTR[touch.block]);
      el.removeAttribute("data-touch-id");
    } else {
      el.removeAttribute("data-touch-id");
      el.removeAttribute("data-touch-block");
    }
    if (node.mouseFilter !== null) el.setAttribute("data-mouse-filter", String(node.mouseFilter));
    else el.removeAttribute("data-mouse-filter");
  }

  return { computeNodePath, computeSceneInfo, computeTouchInfo, stampIdentityAttrs };
}
