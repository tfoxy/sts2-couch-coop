// DOM implementations of renderer-owned point probes.

import { MAP_POINT_SCENE_FILE_SUFFIX } from "@/mirror/mapNodeTap";
import type { SpreadPainter, TouchStack } from "@/mirror/renderer/contracts";

// --- DOM-backend input probes (M0) -------------------------------------------------------------------------
//
// The three z-stack walks the input modules used to run inline, moved here unchanged. They are module-level (not
// closure) functions for two reasons: they read nothing but the DOM the walk stamped, and an unwired caller (a
// spec, a harness) still needs the DOM answer — `createMirrorRenderer` simply hands them out as its own methods,
// and the canvas backend supplies its own.

// The hover-first widgets under a touch point, TOPMOST first. The mirror renderer resolves which interactive
// widget each node belongs to (its root is often boxless, so a finger lands on a flat-DOM descendant) and
// stamps the widget's id as `data-touch-id` (hover-first) or `data-touch-block` (a plain button) on every
// descendant — see TOUCH_TARGET_TYPES below. We scan the z-stack top→bottom (overlays/flat siblings can shadow
// event.target) and collect the distinct `data-touch-id`s, STOPPING at a `data-touch-block` so a tap on a button
// over a hover-first widget (card-reward Skip over the cards) doesn't fall through to it. Returning the whole
// stack lets the tap logic tell a genuine re-tap (only the armed widget under the finger) from a tap on a widget
// OCCLUDED by the armed one (an enlarged hovered card covering its neighbour).
export function domTouchStackAt(clientX: number, clientY: number): TouchStack {
  if (typeof document === "undefined" || typeof document.elementsFromPoint !== "function") {
    return { ids: [], blocked: false, blockKind: null, topStamp: null };
  }
  const ids: string[] = [];
  let topStamp: TouchStack["topStamp"] = null;
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    if (!(el instanceof Element)) continue;
    const id = el.getAttribute("data-touch-id");
    if (id) {
      if (topStamp === null) topStamp = "other";
      if (!ids.includes(id)) ids.push(id);
      continue;
    }
    const block = el.getAttribute("data-touch-block");
    if (block !== null) {
      // R21: WHICH block — the renderer stamps a scrollbar's track "bar" and its handle "thumb", everything else
      // "1" (see TOUCH_BLOCK_ATTR). The scan still STOPS here whatever the kind; the value only says what
      // stopped it.
      const kind = block === "bar" ? "bar" : block === "thumb" ? "thumb" : "button";
      if (topStamp === null) topStamp = kind === "button" ? "other" : kind;
      return { ids, blocked: true, blockKind: kind, topStamp };
    }
  }
  return { ids, blocked: false, blockKind: null, topStamp };
}

// The topmost SPREAD PAINTER under a viewport point — the element whose rect-pair the wide-screen anchor map
// inverts. Walks the z-stack top→down, one decision per `data-node-id` owner (a sub-layer of an owner already
// judged is skipped — the same dedupe the old element hit-test used), skipping anything with no visible own paint
// (`data-paints`) and any full-frame BACKDROP: a width-stretched span (`data-spread-w`) or an element at least
// `backdropWidthPx` wide. A backdrop must NOT impose its (usually squeezed) map on the content painted ABOVE it —
// a re-centered vignette can't govern a card floating over it, and a 1920-wide turn banner can't govern the hand
// under it — so the walk keeps going for a more specific painter. The THRESHOLD is the caller's to choose (it is
// where the demotion policy lives); this only measures and compares. `undefined` ⇒ no hit test available here.
export function domSpreadPainterAt(
  clientX: number,
  clientY: number,
  backdropWidthPx: number
): SpreadPainter | null | undefined {
  if (typeof document === "undefined" || typeof document.elementsFromPoint !== "function") {
    return undefined;
  }
  let lastOwner: Element | null = null;
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const owner = el.closest("[data-node-id]");
    if (!owner || owner === lastOwner) {
      continue;
    }
    lastOwner = owner;
    if (!owner.hasAttribute("data-paints")) {
      continue; // no visible own paint → can't anchor the map (a transparent Stop overlay, a boxless group)
    }
    const widthPx = owner.getBoundingClientRect().width;
    if (owner.hasAttribute("data-spread-w") || widthPx >= backdropWidthPx) {
      continue;
    }
    // First non-backdrop painter decides. `dx` is its (or an ancestor's) cumulative absolute shift.
    const holder = owner.closest("[data-spread-dx]");
    return {
      dx: holder ? Number(holder.getAttribute("data-spread-dx")) || 0 : 0,
      prop: owner.getAttribute("data-spread-mode") === "prop",
      widthPx
    };
  }
  return null;
}

// The MAP POINT under a viewport point, as its scene-root node id (= the live Godot instance id the
// `select-map-node` action needs), or null when the point isn't over one. Walks the z-stack TOP→BOTTOM exactly
// like the touch-target scan above and STOPS at a `data-touch-block` element, so a plain button drawn over the map
// (the back button, the drawing palette) keeps its own tap instead of falling through to a point behind it.
// `doc` stays injectable: it is what lets a spec drive the walk with a fabricated stack.
export function mapPointElementIdAt(
  clientX: number,
  clientY: number,
  doc: Pick<Document, "elementsFromPoint"> | null =
    typeof document !== "undefined" ? document : null
): string | null {
  if (!doc || typeof doc.elementsFromPoint !== "function") {
    return null;
  }
  for (const element of doc.elementsFromPoint(clientX, clientY)) {
    if (!(element instanceof Element)) continue;
    const sceneFile = element.getAttribute("data-scene-file");
    if (sceneFile !== null && sceneFile.endsWith(MAP_POINT_SCENE_FILE_SUFFIX)) {
      const rootId = element.getAttribute("data-scene-root-id");
      if (rootId) {
        return rootId;
      }
    }
    if (element.getAttribute("data-touch-block") !== null) {
      return null; // a plain button blocks the fall-through to anything behind it
    }
  }
  return null;
}
