import type { MirrorFont } from "@/mirror/sceneTree";

// Runtime @font-face registry for the live-tree MIRROR. The host serves game font binaries straight from
// its `/res/` route (auto format → raw .ttf/.otf bytes), so we just inject one `@font-face` per unique
// family→url the first time it appears, then reference it by `font-family`. Self-contained (no stateful
// client imports), and a no-op when there's no DOM (e.g. unit tests).
const injected = new Set<string>();
let styleEl: HTMLStyleElement | null = null;
// Bumped every time `ensureFontFace` actually injects a new `@font-face` rule — never on a dedup no-op. A
// font-readiness cache (rustTextPreparation's font-check cache) invalidates on this rather than polling: the
// only way `document.fonts.check` can flip an already-cached TRUE to false-worthy-of-recheck is a new face
// arriving for a family/weight it didn't know about, and every such arrival goes through this one function.
let fontInjectionVersion = 0;

/** See {@link fontInjectionVersion} above. Read-only outside this module. */
export function fontFaceInjectionVersion(): number {
  return fontInjectionVersion;
}
type FontRegistration = { family: string; url: string; weight: string | null; style: string | null;
  cssRule: string; attempts: Array<{ url: string; weight: string | null; style: string | null }>;
  loads: Array<{ font: string; text: string; loadedFaces: Array<{ family: string; weight: string; style: string;
    stretch: string; status: string }> }> };
const diagnosticRegistrations = new Map<string, FontRegistration>();
// Cached on `location.search` itself (R2-P3): this runs for every text node of every build via `semanticText` →
// `ensureNodeFonts`, and the search string only ever changes on a navigation, never between two calls in the same
// build. Exact by construction — a stale cache is impossible because the key IS the value being cached against.
//
// That cache only skips the `URLSearchParams` PARSE on an unchanged `search` — the native `Location.search`
// GETTER itself still runs on every call, and was measured at 22 ms of the Oct 2 phone trace at this call volume
// (`ensureNodeFonts` asked up to 8 times per node: up to 4 faces, this function asked twice per face). The getter
// cannot be skipped altogether without missing a live `history.pushState`/`replaceState` (neither fires an event
// this module could hook instead — see `fonts.spec.ts`'s "mid-test navigation" case), so `ensureNodeFonts` reads it
// ONCE per node instead and threads the answer into `ensureFontFaceImpl` for all of that node's faces.
let corpusDiagnosticCache: { search: string; enabled: boolean } | null = null;
const corpusDiagnosticEnabled = (): boolean => {
  if (typeof window === "undefined") return false;
  const search = window.location.search;
  if (corpusDiagnosticCache === null || corpusDiagnosticCache.search !== search) {
    corpusDiagnosticCache = { search, enabled: new URLSearchParams(search).get("rustTextInkCorpus") === "1" };
  }
  return corpusDiagnosticCache.enabled;
};

/** Diagnostic receipt for the CSS rule actually injected by this adapter. */
export function mirrorFontRegistration(family: string): FontRegistration | null {
  const row = diagnosticRegistrations.get(family);
  return row ? structuredClone(row) : null;
}

/** Keep the producer's existing FontFaceSet.load call observable in corpus diagnostics. */
export function loadMirrorFont(fonts: FontFaceSet, font: string, text: string,
  family: string): Promise<FontFace[]> {
  const result = fonts.load(font, text);
  if (!corpusDiagnosticEnabled()) return result;
  return result.then((faces) => {
    const row = diagnosticRegistrations.get(family);
    row?.loads.push({ font, text, loadedFaces: faces.map((face) => ({ family: face.family,
      weight: face.weight, style: face.style, stretch: face.stretch, status: face.status })) });
    return faces;
  });
}

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
  // Read ONCE per node rather than once per face: `corpusDiagnosticEnabled`'s cache already skips the
  // `URLSearchParams` parse on an unchanged `search`, but every call still touches the native
  // `Location.search` getter, and a node can carry up to four faces here — up to 8 touches (`ensureFontFaceImpl`
  // itself used to ask twice) measured as 22 ms of the Oct 2 phone trace at ~3,000 nodes/build.
  const diagEnabled = corpusDiagnosticEnabled();
  if (node.font) {
    ensureFontFaceImpl(node.font.family, node.font.url, node.font.weight, node.font.style, diagEnabled);
  }
  if (node.richBoldFont) {
    ensureFontFaceImpl(node.richBoldFont.family, node.richBoldFont.url, null, null, diagEnabled);
  }
  if (node.richItalicFont) {
    ensureFontFaceImpl(node.richItalicFont.family, node.richItalicFont.url, null, null, diagEnabled);
  }
  if (node.richBoldItalicFont) {
    ensureFontFaceImpl(node.richBoldItalicFont.family, node.richBoldItalicFont.url, null, null, diagEnabled);
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
  ensureFontFaceImpl(family, url, weight, style, corpusDiagnosticEnabled());
}

// The shared body, split out so `ensureNodeFonts` can read `corpusDiagnosticEnabled()` ONCE for up to four faces
// instead of once per face (see its own call site) — `ensureFontFace` above is still exactly one read per call
// for any other caller, unchanged.
function ensureFontFaceImpl(
  family: string,
  url: string,
  weight: string | null | undefined,
  style: string | null | undefined,
  diagEnabled: boolean
): void {
  if (diagEnabled) {
    const row = diagnosticRegistrations.get(family);
    row?.attempts.push({ url, weight: weight ?? null, style: style ?? null });
  }
  if (!family || !url || injected.has(family)) {
    return;
  }
  if (typeof document === "undefined") {
    return;
  }
  injected.add(family);
  fontInjectionVersion++;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.dataset.mirrorFonts = "";
    document.head.appendChild(styleEl);
  }
  // Declare the face's true weight/style so the element can request them without faux synthesis (each
  // resolved .ttf is one weight/style, so family↔weight is 1:1).
  const weightDecl = weight ? `font-weight:${weight};` : "";
  const styleDecl = style ? `font-style:${style};` : "";
  const cssRule = `@font-face{font-family:"${cssEscape(family)}";src:url("${url}");${weightDecl}${styleDecl}font-display:swap;}`;
  styleEl.appendChild(document.createTextNode(cssRule));
  if (diagEnabled) diagnosticRegistrations.set(family, { family, url,
    weight: weight ?? null, style: style ?? null, cssRule,
    attempts: [{ url, weight: weight ?? null, style: style ?? null }], loads: [] });
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
