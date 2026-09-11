import type { Affine } from "@/mirror/affine";
import { nodeStyle, type RenderItem } from "@/mirror/nodeStyles";
import { isHitTestExcluded } from "@/mirror/renderer/interactionPolicy";
import type { MirrorNode } from "@/mirror/sceneTree";
import type { MirrorShaderBinding } from "@/mirror/shaderAttributes";
import type { WalkCtx } from "./recordModel";

// --- low-level DOM helpers --------------------------------------------------------------------------------

// Set one CSS property: custom (`--x`) and kebab keys via setProperty, camelCase (incl. vendor like
// `webkitTextStroke`) via the typed setter so prefixes resolve correctly.
function setStyleProp(el: HTMLElement, key: string, value: string): void {
  if (key.startsWith("--") || key.includes("-")) {
    el.style.setProperty(key, value);
  } else {
    (el.style as unknown as Record<string, string>)[key] = value;
  }
}

function removeStyleProp(el: HTMLElement, key: string): void {
  if (key.startsWith("--") || key.includes("-")) {
    el.style.removeProperty(key);
  } else {
    (el.style as unknown as Record<string, string>)[key] = "";
  }
}

// Apply `next` to `el`, writing only properties whose value changed and removing properties that disappeared.
// `cache` is updated to mirror what is now on the element. Returns TRUE when the `transform` property was actually
// (re)written or dropped — the geometry-epoch cache's belt: a base-transform rewrite both moves the node's rendered
// box AND wipes any view-scale/tip scale composed onto that element by a post-walk pass, so the passes must re-run.
// (It catches every cause of a transform change — streamed transform, box origin, clip re-basing, atlas fit — not
// just the ones a per-node field compare enumerates.)
function applyStyleMap(el: HTMLElement, next: Record<string, string>, cache: Map<string, string>): boolean {
  let wroteTransform = false;
  let nextKeys = 0;
  for (const key in next) {
    nextKeys++;
    const value = next[key];
    if (cache.get(key) !== value) {
      setStyleProp(el, key, value);
      cache.set(key, value);
      if (key === "transform") {
        wroteTransform = true;
      }
    }
  }
  // The removal scan needs a SNAPSHOT of the keys (it deletes while iterating) — a fresh array per styled element
  // per walk, ~10MB per 25s combat replay. After the loop above the cache holds every key of `next` (it either
  // already did, or was just set), so `cache ⊇ next` and equal counts prove the key SETS match: nothing to remove.
  // Only an actually-disappeared key pays for the snapshot.
  if (cache.size !== nextKeys) {
    for (const key of [...cache.keys()]) {
      if (!(key in next)) {
        removeStyleProp(el, key);
        cache.delete(key);
        if (key === "transform") {
          wroteTransform = true;
        }
      }
    }
  }
  return wroteTransform;
}

// Does an UPSERTED node object differ from the previously-accounted one in a field that can change WHICH nodes the
// epoch-cached structures contain (rather than only where an existing one sits)? These always bump: they flip
// interactive-rect membership (mouseFilter / visible), move a whole subtree (parentId), or re-classify the node for
// the hit-test exclusions and the view-scale pre-filter (type / name / scene file). All are rare on the wire.
function geometryMembershipDiffers(prev: MirrorNode, next: MirrorNode): boolean {
  return (
    prev.visible !== next.visible ||
    prev.mouseFilter !== next.mouseFilter ||
    prev.parentId !== next.parentId ||
    prev.nodeType !== next.nodeType ||
    prev.name !== next.name ||
    prev.sceneFilePath !== next.sceneFilePath
  );
}

// Does an UPSERTED node object sit at a different PLACE than the previously-accounted one? Deliberately does NOT
// list the cosmetic fields (modulate / self-modulate / opacity / text / texture / region / shader params): skipping
// the whole-scene geometry passes on a cosmetic-only delta is the entire point of the epoch. Gated by
// `subtreeFeedsGeometry` at the call site — a decoration that moves under nothing interactive changes neither
// structure. (Everything geometric that is DERIVED rather than streamed — the spread shift, the baked CSS transform,
// the view-scale membership, the cached design global — is compared at its own write site in `visit`.)
function geometryBoxDiffers(prev: MirrorNode, next: MirrorNode): boolean {
  const pr = prev.localRect;
  const nr = next.localRect;
  if ((pr == null) !== (nr == null)) {
    return true;
  }
  if (pr != null && nr != null && (pr.x !== nr.x || pr.y !== nr.y || pr.width !== nr.width || pr.height !== nr.height)) {
    return true;
  }
  const pt = prev.transform;
  const nt = next.transform;
  if ((pt == null) !== (nt == null)) {
    return true;
  }
  if (pt != null && nt != null) {
    for (let i = 0; i < 6; i++) {
      if (pt[i] !== nt[i]) {
        return true;
      }
    }
  }
  return false;
}

// Is this node one of the boxes forEachInteractiveRect can yield? (Mouse-visible Stop/Pass Control with a box, not
// hit-test excluded.) Visibility is deliberately NOT part of it: a hidden candidate still COUNTS as one for the
// subtree probe below, since it can be revealed later — and the reveal is a membership change that bumps anyway.
function isInteractiveRectCandidate(n: MirrorNode): boolean {
  return (n.mouseFilter === 0 || n.mouseFilter === 1) && n.transform != null && n.localRect != null && !isHitTestExcluded(n);
}

// R10-PERF4 WS-2 — EFFECTS-DIRTY bits (see consumeEffectsDirty). `data-godot-shader*` / `data-godot-particle*`
// are exactly the markers gsw's two runtimes select on (`[data-godot-shader-webgl]` /
// `[data-godot-particle-runtime]`) and the attributes their reconcile re-reads per node, so an ACTUAL change to
// one is the only thing that can make their next reconcile see something new.
const FX_DIRTY_SHADER = 1;
const FX_DIRTY_PARTICLE = 2;
const SHADER_ATTR_PREFIX = "data-godot-shader";
const PARTICLE_ATTR_PREFIX = "data-godot-particle";

function fxDirtyBitFor(key: string): number {
  if (key.startsWith(SHADER_ATTR_PREFIX)) {
    return FX_DIRTY_SHADER;
  }
  return key.startsWith(PARTICLE_ATTR_PREFIX) ? FX_DIRTY_PARTICLE : 0;
}

// Returns the FX_DIRTY_* bits of the effect markers this pass actually WROTE (added, changed or removed) — never
// bits for a key that was already at its value, so a steady-state re-style reports nothing.
function applyAttrs(el: HTMLElement, next: Record<string, string | undefined>, cache: Map<string, string>): number {
  let fx = 0;
  for (const key in next) {
    const value = next[key];
    if (value == null) {
      continue;
    }
    if (cache.get(key) !== value) {
      el.setAttribute(key, value);
      cache.set(key, value);
      fx |= fxDirtyBitFor(key);
    }
  }
  for (const key of [...cache.keys()]) {
    if (next[key] == null) {
      el.removeAttribute(key);
      cache.delete(key);
      fx |= fxDirtyBitFor(key);
    }
  }
  return fx;
}

// Idempotently reflect a single attribute whose last-applied value is cached on the record (null = absent). Writes
// the DOM only when the value actually changed; returns the new cached value for the caller to store back. This is
// how the per-visit singleton attrs (data-node-type + the four data-spread-*) avoid an unconditional
// setAttribute/removeAttribute per node per walk.
function applyCachedAttr(el: HTMLElement, name: string, value: string | null, cached: string | null): string | null {
  if (value === cached) {
    return cached;
  }
  if (value == null) {
    el.removeAttribute(name);
  } else {
    el.setAttribute(name, value);
  }
  return value;
}

function affineEqual(a: Affine | null, b: Affine | null): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4] && a[5] === b[5];
}

// Field-for-field equality of two child WalkCtx objects — ALL fields, including the ones ctxUnchanged ignores
// (parentWidth, pinnedAncestor). Used for the Stage-2 ref-stability reuse: a node only keeps handing children the
// SAME childCtx object when nothing about it changed, so a reused object is always a byte-identical stand-in.
function sameWalkCtx(a: WalkCtx, b: WalkCtx): boolean {
  return (
    a.domParent === b.domParent &&
    a.tint.r === b.tint.r &&
    a.tint.g === b.tint.g &&
    a.tint.b === b.tint.b &&
    affineEqual(a.parentInv, b.parentInv) &&
    affineEqual(a.parentGlobal, b.parentGlobal) &&
    a.parentDx === b.parentDx &&
    a.deltaParentWidth === b.deltaParentWidth &&
    a.anchorDelta === b.anchorDelta &&
    a.parentDxProp === b.parentDxProp &&
    a.rideDx === b.rideDx &&
    a.parentWidth === b.parentWidth &&
    a.pinnedAncestor === b.pinnedAncestor &&
    a.containerChildAlign === b.containerChildAlign &&
    a.containerChildVertical === b.containerChildVertical &&
    a.inCardRewardScreen === b.inCardRewardScreen &&
    a.contentScope === b.contentScope &&
    // R10-PERF4 WS-3 (item 3): the REVEAL seam. Refusing to reuse the cached childCtx object across an
    // ancestor-hidden flip is what makes every descendant re-visit and build its deferred sub-layers.
    a.ancestorHidden === b.ancestorHidden
  );
}

// Compose a shader binding's style onto the base node style (ported from MirrorNodeView.mergedStyle): a WebGL
// shader feeds modulate itself (drop the tint filter), an HSV color-matrix composes before the modulate tint.
function mergedNodeStyle(item: RenderItem, shader: MirrorShaderBinding | null): Record<string, string> {
  const base = nodeStyle(item);
  if (!shader) {
    return base;
  }
  // Compose INTO the map nodeStyle just built rather than spreading a second one on top of it. `base` is
  // freshly allocated per call and nobody else holds it (nodeStyle's own callers take the return value), so the
  // mutation is unobservable — and `Object.assign` reproduces the spread's key ORDER exactly (base keys first,
  // then shader keys the base lacked), which is the order applyStyleMap/splitSelfStyle iterate in. The one thing
  // the spread gave for free is an un-merged `base.filter` to read AFTER merging: capture it first.
  const baseFilter = base.filter;
  Object.assign(base, shader.style);
  if (shader.attributes["data-godot-shader-webgl"]) {
    delete base.filter;
  } else if (baseFilter && shader.style.filter) {
    base.filter = `${shader.style.filter} ${baseFilter}`;
  }
  return base;
}


export { FX_DIRTY_SHADER, FX_DIRTY_PARTICLE, affineEqual, isInteractiveRectCandidate, applyStyleMap, mergedNodeStyle, applyCachedAttr, geometryMembershipDiffers, geometryBoxDiffers, applyAttrs, sameWalkCtx };
export { setStyleProp };
