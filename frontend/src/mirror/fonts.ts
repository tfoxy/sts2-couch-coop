import type { MirrorFont } from "@/mirror/sceneTree";

// Runtime @font-face registry for the live-tree MIRROR. The host serves game font binaries straight from
// its `/res/` route (auto format → raw .ttf/.otf bytes), so we just inject one `@font-face` per unique
// family→url the first time it appears, then reference it by `font-family`. Self-contained (no stateful
// client imports), and a no-op when there's no DOM (e.g. unit tests).
const injected = new Set<string>();
let styleEl: HTMLStyleElement | null = null;

/**
 * Register every face ONE NODE will ask for: its own, plus the three rich role faces.
 *
 * Shared because two very different paths need exactly this set and getting it wrong is invisible in a test but
 * obvious on screen. The DOM overlay calls it from `syncText` so an element's `font-family` can resolve; the
 * canvas rasterizer calls it BEFORE it asks whether the face is ready, and there the coupling is sharper than it
 * looks — `document.fonts.check` answers TRUE for a family with no `@font-face` rule at all (nothing to load, so
 * the fallback is "available"). Without this call first, a readiness gate would wave the label through and BAKE
 * the fallback typeface into a texture that is then reused for as long as the label says the same words.
 *
 * Role faces are declared with NO weight or style: Godot renders `[b]` by swapping to a different font FILE, and
 * a declared weight would invite the browser to synthesise against it.
 */
export function ensureNodeFonts(node: {
  font: MirrorFont | null;
  richBoldFont: MirrorFont | null;
  richItalicFont: MirrorFont | null;
  richBoldItalicFont: MirrorFont | null;
}): void {
  if (node.font) {
    ensureFontFace(node.font.family, node.font.url, node.font.weight, node.font.style);
  }
  if (node.richBoldFont) {
    ensureFontFace(node.richBoldFont.family, node.richBoldFont.url, null, null);
  }
  if (node.richItalicFont) {
    ensureFontFace(node.richItalicFont.family, node.richItalicFont.url, null, null);
  }
  if (node.richBoldItalicFont) {
    ensureFontFace(node.richBoldItalicFont.family, node.richBoldItalicFont.url, null, null);
  }
}

/**
 * FILED, NOT FIXED (R8): the dedup key is the FAMILY ALONE, so a family's second face is never injected.
 *
 * If one family ever arrives with two different URLs — a bold and a regular resolving to different `.ttf`s under
 * one `font-family` — the second `@font-face` is dropped on the floor, and `document.fonts.check` for a shorthand
 * naming that weight then answers against whichever face happened to get in first. Silent, and exactly the
 * bake-the-wrong-typeface class the canvas rasterizer's readiness gate exists to prevent.
 *
 * It is filed rather than fixed because a corpus census says the corpus does not contain it, and because this
 * function is SHARED: `ensureNodeFonts` is called by the DOM overlay's text sync as well as by the canvas text
 * seam, so changing it would move the `off` and `dom` arms of the text flip's parity table and force a full
 * re-capture of a premise that is currently still.
 *
 * THE CENSUS, across the four standard recordings (949 nodes carrying a font, 5 distinct families): exactly one
 * family arrives with more than one (weight, style, url) tuple — `kreon_regular`, as `weight: null` (381 nodes,
 * the role-face declaration) and `weight: "400"` (10 nodes) — and BOTH tuples name the same file. Zero families
 * carry two distinct URLs, so the drop can never fire on this corpus, and the two rules that could be written
 * here are equivalent besides (a `@font-face` with no `font-weight` descriptor is weight 400 by CSS's own
 * initial value).
 *
 * FIX WHEN that census stops holding: key the dedup on `family|weight|style|url` and inject one rule per tuple.
 * Land it in its OWN commit and re-capture the text table, because the premise moves.
 */
export function ensureFontFace(family: string, url: string, weight?: string | null, style?: string | null): void {
  if (!family || !url || injected.has(family)) {
    return;
  }
  if (typeof document === "undefined") {
    return;
  }
  injected.add(family);
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.dataset.mirrorFonts = "";
    document.head.appendChild(styleEl);
  }
  // Declare the face's true weight/style so the element can request them without faux synthesis (each
  // resolved .ttf is one weight/style, so family↔weight is 1:1).
  const weightDecl = weight ? `font-weight:${weight};` : "";
  const styleDecl = style ? `font-style:${style};` : "";
  styleEl.appendChild(
    document.createTextNode(
      `@font-face{font-family:"${cssEscape(family)}";src:url("${url}");${weightDecl}${styleDecl}font-display:swap;}`
    )
  );
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
