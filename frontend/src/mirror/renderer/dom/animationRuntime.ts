import { applyAnimationBinding, ensureAnimationStyles } from "@spirectl/presentation/render";
import { pinnedLoopAnchorsToDocument, pinnedLoopBinding, pinnedLoopNodePivot, pinnedLoopRidesAnimSelf } from "@/mirror/animAttributes";
import { elementLocalPoint } from "@/mirror/nodeStyles";
import type { Affine } from "@/mirror/affine";
import type { MirrorNode } from "@/mirror/sceneTree";
import type { RenderRecord } from "@/mirror/renderer/dom/recordModel";
import { setStyleProp } from "@/mirror/renderer/dom/style";
import { px } from "@/mirror/stageFit";

export interface AnimationRuntime {
  anchorAnimations(target: HTMLElement, startTime: number): void;
  flushPhaseAnchors(): void;
  clearPhaseAnchors(): void;
  ensureAnimSelf(record: RenderRecord): HTMLElement;
  syncPinnedLoop(record: RenderRecord, node: MirrorNode, hasChildren: boolean, mSelf: Affine): void;
  clearPinnedLoop(record: RenderRecord): void;
  syncNinePatchSlices(record: RenderRecord, slices: Array<Record<string, string>>): void;
}

export function createAnimationRuntime(): AnimationRuntime {
  const phaseQueue: Array<{ target: HTMLElement; startTime: number }> = [];
  function applyAnchor(target: HTMLElement, startTime: number): void {
    if (typeof target.getAnimations !== "function") return;
    for (const animation of target.getAnimations()) animation.startTime = startTime;
  }
  function anchorAnimations(target: HTMLElement, startTime: number): void {
    phaseQueue.push({ target, startTime });
  }
  function flushPhaseAnchors(): void {
    for (const entry of phaseQueue) applyAnchor(entry.target, entry.startTime);
    phaseQueue.length = 0;
  }
  function ensureAnimSelf(record: RenderRecord): HTMLElement {
    if (!record.animSelf) {
      record.animSelf = document.createElement("div");
      record.animSelf.className = "mirror-anim-self";
      record.animSelf.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none";
    }
    return record.animSelf;
  }
  function clearAnimationOn(target: HTMLElement | null): void {
    if (!target) return;
    target.style.animation = "";
    target.style.removeProperty("scale");
    target.style.removeProperty("translate");
    target.style.removeProperty("rotate");
  }
  function clearPinnedLoop(record: RenderRecord): void {
    if (record.pinnedLoopSig === null) return;
    record.pinnedLoopSig = null;
    clearAnimationOn(record.pinnedLoopTarget ?? record.el);
    if (record.pinnedLoopTarget === record.animSelf) record.pinnedLoopTarget?.style.removeProperty("transform-origin");
    record.pinnedLoopTarget = null;
    const stash = record.pinnedLoopStash;
    if (!stash) return;
    record.pinnedLoopStash = null;
    ensureAnimationStyles(document);
    if (stash.kind === "bob") {
      if (record.el) applyAnimationBinding(record.el, stash, { compose: true });
    } else if (record.animSelf) {
      applyAnimationBinding(record.animSelf, stash);
    }
  }
  function syncPinnedLoop(record: RenderRecord, node: MirrorNode, hasChildren: boolean, mSelf: Affine): void {
    const el = record.el;
    if (!el) return;
    const token = node.pinnedLoopAnim;
    const lr = node.localRect;
    if (!token || !lr) return clearPinnedLoop(record);
    const nodePivot = pinnedLoopNodePivot(token);
    let pivot: { x: number; y: number } | null;
    // LAYOUT SPACE (stageFit.ts): a pivot becomes a `transform-origin` on a layout-space box, so it converts here
    // — BEFORE the signature below, which is what makes a fit change invalidate the cached pivot and rewrite it
    // rather than leaving a stale origin behind. `elementLocalPoint` and `mSelf` both stay design-space (the numeric
    // cores are shared with the canvas backend). Identity on the default arm.
    if (nodePivot) {
      const p0 = elementLocalPoint(node, hasChildren, nodePivot.x, nodePivot.y);
      pivot = { x: px(p0.x), y: px(p0.y) };
    } else if (pinnedLoopRidesAnimSelf(token)) pivot = null;
    else {
      const cx = lr.width / 2, cy = lr.height / 2;
      pivot = {
        x: px(mSelf[0] * cx + mSelf[2] * cy + mSelf[4]),
        y: px(mSelf[1] * cx + mSelf[3] * cy + mSelf[5])
      };
    }
    const sig = pivot ? `${token}|${Math.round(pivot.x * 100)}|${Math.round(pivot.y * 100)}` : token;
    if (record.pinnedLoopSig === sig) return;
    const binding = pinnedLoopBinding(token, record.id, pivot?.x ?? 0, pivot?.y ?? 0);
    if (!binding) return clearPinnedLoop(record);
    ensureAnimationStyles(document);
    if (record.staticAnimBinding && !record.pinnedLoopStash) {
      record.pinnedLoopStash = record.staticAnimBinding;
      clearAnimationOn(record.staticAnimBinding.kind === "bob" ? el : record.animSelf);
    }
    let target = el;
    if (pinnedLoopRidesAnimSelf(token)) {
      target = ensureAnimSelf(record);
      record.animSelfWrapsPaint = true;
    }
    if (record.pinnedLoopTarget && record.pinnedLoopTarget !== target) clearAnimationOn(record.pinnedLoopTarget);
    record.pinnedLoopSig = sig;
    record.pinnedLoopTarget = target;
    applyAnimationBinding(target, binding);
    if (pinnedLoopAnchorsToDocument(token)) anchorAnimations(target, -(binding.delayMs ?? 0));
  }
  function setSliceStyle(el: HTMLElement, style: Record<string, string>, cache: Map<string, string>): void {
    for (const key in style) {
      const value = style[key];
      if (cache.get(key) !== value) {
        setStyleProp(el, key, value);
        cache.set(key, value);
      }
    }
  }
  function syncNinePatchSlices(record: RenderRecord, slices: Array<Record<string, string>>): void {
    if (record.npSlices.length !== slices.length) {
      for (const span of record.npSlices) span.remove();
      record.npSlices = slices.map(() => {
        const span = document.createElement("span");
        span.className = "mirror-np-slice";
        return span;
      });
      record.npSliceStyles = slices.map(() => new Map<string, string>());
    }
    for (let i = 0; i < slices.length; i++) setSliceStyle(record.npSlices[i], slices[i], record.npSliceStyles[i]);
  }
  return { anchorAnimations, flushPhaseAnchors, clearPhaseAnchors: () => { phaseQueue.length = 0; }, ensureAnimSelf, syncPinnedLoop, clearPinnedLoop, syncNinePatchSlices };
}
