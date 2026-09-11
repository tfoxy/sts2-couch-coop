import { onScopeDispose, shallowRef, type ShallowRef } from "vue";

// R19 WP-2 — ONE definition of "the viewport is portrait", shared by everything that branches on it.
//
// Two features ask the question and they must not be able to disagree: the "turn your phone sideways" nag
// (composables/usePortraitNag) and the portrait chrome placement (MirrorApp — the settings gear + fullscreen
// button stay browser-space chrome instead of shrinking into the letterboxed stage). Before this they would have
// been two media queries evaluated in two components, which is exactly how a nag ends up on screen while the
// chrome it is telling you to press has already moved.
//
// PORTRAIT = viewport height >= width. `(max-aspect-ratio: 1/1)` is width/height <= 1, i.e. the same set as CSS's
// `(orientation: portrait)` (a square counts as portrait in both), but stated as the ratio the callers actually
// reason about — a letterboxed 16:9 stage on a taller-than-wide viewport.
//
// STATE IS MODULE-SCOPE with a scope refcount, for the same reason `useFullscreen`'s is (see its header): the
// composable runs in several live effect scopes at once — MirrorApp for the chrome switch, PortraitNagOverlay for
// the nag — and per-instance media queries would mean N listeners, N answers and N chances for one of them to be
// stale. One query, one ref, listeners attached only while somebody holds it.

/** The viewport is portrait when its height is >= its width. */
export const PORTRAIT_VIEWPORT_QUERY = "(max-aspect-ratio: 1/1)";

/** The `MediaQueryList` slice used here — injectable, because jsdom's never changes. */
export interface ViewportMediaQuerySeam {
  matches: boolean;
  addEventListener?: (type: "change", listener: (event: { matches: boolean }) => void) => void;
  removeEventListener?: (type: "change", listener: (event: { matches: boolean }) => void) => void;
}

export interface PortraitViewportSeams {
  /** Defaults to `window.matchMedia`. `null` means "this environment has none" ⇒ never portrait. */
  matchMedia?: ((query: string) => ViewportMediaQuerySeam) | null;
}

export interface PortraitViewport {
  /** Reactive `matchMedia(PORTRAIT_VIEWPORT_QUERY).matches`. */
  isPortrait: ShallowRef<boolean>;
}

// ---- shared, document-global state ---------------------------------------------------------------------------

const isPortrait = shallowRef(false);
/** How many live effect scopes hold this composable; the DOM listener exists only while it is > 0. */
let scopeCount = 0;
/** Last injected seams (real callers pass none; specs pass a fake query). Reset when the count hits 0. */
let seams: PortraitViewportSeams = {};
let query: ViewportMediaQuerySeam | null = null;
let bound = false;

function onQueryChange(event: { matches: boolean }): void {
  isPortrait.value = event.matches === true;
}

function resolveMatchMedia(): ((query: string) => ViewportMediaQuerySeam) | null {
  if (seams.matchMedia !== undefined) return seams.matchMedia;
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? (q: string) => window.matchMedia(q) as ViewportMediaQuerySeam
    : null;
}

function unbind(): void {
  query?.removeEventListener?.("change", onQueryChange);
  query = null;
  bound = false;
}

function bind(): void {
  unbind();
  const matchMediaImpl = resolveMatchMedia();
  try {
    query = matchMediaImpl ? matchMediaImpl(PORTRAIT_VIEWPORT_QUERY) : null;
  } catch {
    query = null; // a matchMedia that throws (old jsdom, a locked-down embedder) reads as "not portrait"
  }
  query?.addEventListener?.("change", onQueryChange);
  bound = true;
  isPortrait.value = query?.matches === true;
}

/**
 * The shared portrait-viewport signal. Must be called from a component setup / effect scope so the listener is
 * cleaned up with its owner (same discipline as `useFullscreen`).
 */
export function usePortraitViewport(injected: PortraitViewportSeams = {}): PortraitViewport {
  // A caller that INJECTS a seam takes the query over (that is a spec driving the orientation by hand); a caller
  // that injects nothing keeps whatever is already bound, so a real component mounting alongside a spec's fake
  // cannot silently swap it back to the live window.
  if (injected.matchMedia !== undefined) {
    seams = injected;
    bind();
  } else if (!bound) {
    bind();
  }

  scopeCount += 1;
  onScopeDispose(() => {
    scopeCount -= 1;
    if (scopeCount > 0) return;
    unbind();
    seams = {};
  });

  return { isPortrait };
}

// ---- the placement decision -----------------------------------------------------------------------------------

/**
 * Whether the settings gear + fullscreen pair should render as FIXED browser chrome (the pre-game placement:
 * 44px, `position: fixed`, unaffected by the letterbox) rather than inside the scaled stage.
 *
 * A pure predicate rather than an inline computed, for the same reason the join-screen decisions live in
 * `join/joinModel.ts`: the interesting content is a three-input truth table, and a table is worth testing
 * directly instead of through a mounted component that also has to be handed a whole scene.
 *
 * The complement is the in-stage placement — the two are exhaustive and mutually exclusive by construction, so
 * there can never be two gears (two panels fighting over one `panelAnchorTop`) nor none at all.
 */
export function shouldUseFixedChrome(sceneShowing: boolean, isPortrait: boolean): boolean {
  // Pre-game the fixed placement is the ONLY one — there is no stage to put a button inside yet, and this is
  // the placement the whole feature is defined against ("keep it where the loading screen had it").
  if (!sceneShowing) return true;
  return isPortrait;
}
