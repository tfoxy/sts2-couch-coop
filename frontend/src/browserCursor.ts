import { hostUrl, isRemoteHosted } from "@/join/hostBase";

export const GAME_CURSOR_ROOT_CLASS = "game-cursor";
export const GAME_CURSOR_STYLE_ID = "game-cursor-style";
export const GAME_CURSOR_DEFAULT_URL = "/res/images/packed/common_ui/cursor_default.png";
export const GAME_CURSOR_PRESSED_URL = "/res/images/packed/common_ui/cursor_tilted.png";
// Hotspot (the click point) in the source PNG's own pixels. computeCursorCrop maps
// it through the trim+downscale into the processed bitmap's pixels.
export const GAME_CURSOR_HOTSPOT_X = 14;
export const GAME_CURSOR_HOTSPOT_Y = 5;
// Cap so the native `cursor: url(...)` bitmap stays within the size every browser
// renders at viewport edges without clipping. 32 is the universally safe maximum.
export const GAME_CURSOR_MAX_SIZE = 32;
// Alpha strictly greater than this counts as opaque. 0 keeps the antialiased fringe
// of the cursor outline (a higher threshold would clip the visible edge).
export const GAME_CURSOR_ALPHA_THRESHOLD = 0;

// The full `.game-cursor *` selector list, mirrored from the old styles.css rules so
// the injected cursor still overrides any component-level `cursor` declaration. It is
// written ONCE (when the two images finish processing) and never mutated again — see
// the pressed-state note below for why that matters.
const DEFAULT_SELECTOR = ".game-cursor, .game-cursor body, .game-cursor #app, .game-cursor *";

// THE PRESSED STATE IS PER-ELEMENT, NOT PER-DOCUMENT.
//
// It used to be a `game-cursor-pressed` class toggled on <html> with its own full
// `.game-cursor-pressed *` rule set. `cursor` is applied per element, so that made every
// pointerdown AND pointerup invalidate the style of every element in the document: on the
// mirror's map screen (3,667 elements) an Aug-11 phone trace measured ~594ms of style
// recalc per tap — 76% of a ~780ms tap INP.
//
// Every alternative that changes the cursor document-wide costs the same full recalc
// (measured in headless Chromium, 4,006 elements: root class + universal rules 10.8ms,
// root inline `cursor` with `* { cursor: inherit }` 8.8ms, root inline with no universal
// rule at all 5.2ms, CSSOM value swap 14.1ms) — `cursor` is inherited, and Blink does not
// propagate it independently. But the cursor is only ever VISIBLE at one point, so the
// pressed art only has to reach the element under the pointer: an inline `cursor` on that
// one element measured 0.0ms p50 / 0.1ms max, even when it had 3,999 descendants (the
// static universal rule above gives each descendant its own declaration, so the inherited
// change stops at the target). While the button is held the style follows the pointer, so
// a press-drag looks exactly as it did before.
const PRESSED_PRIORITY = "important";

export interface CursorCropResult {
  /** Non-transparent bounding box in source pixels. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Output bitmap size in pixels (post-downscale). */
  dw: number;
  dh: number;
  /** Downscale factor applied to the crop (<= 1; never upscales). */
  scale: number;
  /** Hotspot remapped into the output bitmap's pixels. */
  hotspotX: number;
  hotspotY: number;
}

/**
 * Trim a cursor bitmap to its non-transparent bounding box and fit it within
 * `maxSize`, remapping the hotspot. Pure (no canvas) so it is unit-testable.
 *
 * `img.data` is RGBA bytes of length `width * height * 4`. Returns `null` when the
 * bitmap is fully transparent (the caller falls back to the original image).
 */
export function computeCursorCrop(
  img: { data: ArrayLike<number>; width: number; height: number },
  origHotspotX: number,
  origHotspotY: number,
  maxSize = GAME_CURSOR_MAX_SIZE,
  alphaThreshold = GAME_CURSOR_ALPHA_THRESHOLD
): CursorCropResult | null {
  const { data, width, height } = img;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;

  const sw = maxX - minX + 1;
  const sh = maxY - minY + 1;
  const scale = Math.min(1, maxSize / Math.max(sw, sh));
  // `ceil` so a 1px-wide opaque sliver never collapses to a zero-size canvas.
  const dw = Math.max(1, Math.ceil(sw * scale));
  const dh = Math.max(1, Math.ceil(sh * scale));
  const hotspotX = Math.round((origHotspotX - minX) * scale);
  const hotspotY = Math.round((origHotspotY - minY) * scale);
  return {
    sx: minX,
    sy: minY,
    sw,
    sh,
    dw,
    dh,
    scale,
    // Clamp in case the original hotspot sat in the trimmed-away padding.
    hotspotX: Math.min(Math.max(hotspotX, 0), dw - 1),
    hotspotY: Math.min(Math.max(hotspotY, 0), dh - 1)
  };
}

export interface ProcessedCursor {
  dataUrl: string;
  hotspotX: number;
  hotspotY: number;
}

export type ProcessCursorImage = (url: string, hotspotX: number, hotspotY: number) => Promise<ProcessedCursor>;

function loadImage(img: HTMLImageElement): Promise<void> {
  if (typeof img.decode === "function") return img.decode();
  return new Promise((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("cursor image load failed"));
  });
}

/**
 * Load `url`, trim it to its visible pixels, downscale to <= GAME_CURSOR_MAX_SIZE,
 * and return it as a data URL with the remapped hotspot. The canvas must stay clean for
 * `toDataURL` to succeed — same-origin that is free, and cross-origin (the public-origin
 * bootstrap) it is bought with `crossOrigin` below plus the host's CORS headers. Any failure
 * (load error, missing 2d context, fully transparent) falls back to the original
 * URL + hotspot, which still works away from the viewport edges.
 */
async function processCursorImage(
  url: string,
  origHotspotX: number,
  origHotspotY: number,
  doc: Document = document
): Promise<ProcessedCursor> {
  const fallback: ProcessedCursor = { dataUrl: url, hotspotX: origHotspotX, hotspotY: origHotspotY };
  try {
    // CANVAS-BOUND (getImageData below), so cross-origin this needs CORS or the readback throws and the
    // cursor silently falls back to the uncropped image. Set only when remote-hosted: same-origin never
    // taints, and `crossOrigin` against a response without `Access-Control-Allow-Origin` would turn a
    // working request into a CORS failure — which is what the original comment here was guarding against.
    const img = new Image();
    if (isRemoteHosted()) {
      img.crossOrigin = "anonymous";
    }
    img.src = url;
    await loadImage(img);

    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (!width || !height) return fallback;

    const source = doc.createElement("canvas");
    source.width = width;
    source.height = height;
    const sourceCtx = source.getContext("2d");
    if (!sourceCtx) return fallback;
    sourceCtx.drawImage(img, 0, 0);
    const imageData = sourceCtx.getImageData(0, 0, width, height);

    const crop = computeCursorCrop(imageData, origHotspotX, origHotspotY);
    if (!crop) return fallback;

    // Render into a fixed GAME_CURSOR_MAX_SIZE square (power-of-two) buffer, with the
    // trimmed content anchored top-left so the hotspot stays correct. Hardware-cursor
    // compositors (e.g. gamescope/Wayland) clip a non-square cursor bitmap to a square
    // of its SHORTER side — a 24x32 arrow loses its bottom rows (the visible "missing
    // bottom-left"), while a near-square 30x32 barely changes. Squaring the buffer
    // sidesteps that, and the extra transparent padding is inert.
    const out = doc.createElement("canvas");
    out.width = GAME_CURSOR_MAX_SIZE;
    out.height = GAME_CURSOR_MAX_SIZE;
    const outCtx = out.getContext("2d");
    if (!outCtx) return fallback;
    // Only resample when actually shrinking; a 1:1 copy stays crisp.
    outCtx.imageSmoothingEnabled = crop.scale < 1;
    if (outCtx.imageSmoothingEnabled) outCtx.imageSmoothingQuality = "high";
    outCtx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.dw, crop.dh);

    return { dataUrl: out.toDataURL("image/png"), hotspotX: crop.hotspotX, hotspotY: crop.hotspotY };
  } catch {
    return fallback;
  }
}

export interface InstalledBrowserCursor {
  dispose(): void;
  /** false when the device has no pointer to decorate and nothing was installed (see coarseOnlyPointer). */
  readonly installed: boolean;
}

export interface BrowserCursorOptions {
  /** Injection seam for tests so they can bypass canvas/image decoding. */
  processImage?: ProcessCursorImage;
  /** Force installation past the pointer check for focused unit coverage. */
  force?: boolean;
}

type BrowserCursorWindow = Pick<Window, "addEventListener" | "removeEventListener"> &
  Partial<Pick<Window, "matchMedia">>;

/**
 * A device with a COARSE pointer and no fine one: a phone/tablet, where there is no on-screen
 * cursor at all, so every byte of this module is pure cost (a full-document style recalc when
 * the class lands, two 32×32 PNG decodes, and the per-press recalcs above — on the mirror the
 * single largest contributor to tap INP).
 *
 * Stated as "positively coarse-only" rather than "not fine" on purpose: a browser without
 * `matchMedia`, or one that answers false to everything (jsdom), is NOT a phone — it keeps the
 * cursor exactly as before. A touchscreen laptop reports BOTH, so it keeps it too.
 */
export function coarseOnlyPointer(targetWindow: BrowserCursorWindow = window): boolean {
  const mm = targetWindow.matchMedia;
  if (typeof mm !== "function") {
    return false;
  }
  try {
    return !mm.call(targetWindow, "(any-pointer: fine)").matches && mm.call(targetWindow, "(any-pointer: coarse)").matches;
  } catch {
    return false;
  }
}

const NOT_INSTALLED: InstalledBrowserCursor = { installed: false, dispose() {} };

export function installBrowserCursor(
  root: HTMLElement = document.documentElement,
  targetWindow: BrowserCursorWindow = window,
  options: BrowserCursorOptions = {}
): InstalledBrowserCursor {
  if (!options.force && coarseOnlyPointer(targetWindow)) {
    return NOT_INSTALLED;
  }
  const ownerDocument = root.ownerDocument;
  const process: ProcessCursorImage =
    options.processImage ?? ((url, hx, hy) => processCursorImage(url, hx, hy, ownerDocument));

  let disposed = false;
  let styleEl: HTMLStyleElement | undefined;
  let defaultCursor: ProcessedCursor | undefined;
  let pressedCursor: ProcessedCursor | undefined;

  const cursorRule = (selector: string, cursor: ProcessedCursor) =>
    `${selector} { cursor: url(${cursor.dataUrl}) ${cursor.hotspotX} ${cursor.hotspotY}, auto !important; }`;

  const renderStyle = () => {
    if (disposed) return;
    if (!styleEl) {
      styleEl = ownerDocument.createElement("style");
      styleEl.id = GAME_CURSOR_STYLE_ID;
      (ownerDocument.head ?? ownerDocument.documentElement).appendChild(styleEl);
    }
    const rules: string[] = [];
    if (defaultCursor) rules.push(cursorRule(DEFAULT_SELECTOR, defaultCursor));
    styleEl.textContent = rules.join("\n");
  };

  // The element currently wearing the pressed cursor (see the PRESSED_PRIORITY note): exactly one at a time,
  // moved as the pointer moves while the button is held. A detached element (the mirror reconciler removes
  // nodes constantly) is harmless — clearing its inline style is a no-op and the reference is dropped on release.
  let pressedEl: (Element & ElementCSSInlineStyle) | null = null;

  const stylable = (target: EventTarget | null): (Element & ElementCSSInlineStyle) | null =>
    target !== null && typeof (target as Partial<ElementCSSInlineStyle>).style === "object"
      ? (target as Element & ElementCSSInlineStyle)
      : null;

  const wear = (target: EventTarget | null): void => {
    const next = stylable(target);
    if (next === pressedEl) return;
    pressedEl?.style.removeProperty("cursor");
    pressedEl = null;
    if (!next || !pressedCursor) return;
    next.style.setProperty(
      "cursor",
      `url(${pressedCursor.dataUrl}) ${pressedCursor.hotspotX} ${pressedCursor.hotspotY}, auto`,
      PRESSED_PRIORITY
    );
    pressedEl = next;
  };

  const setPressed = (event: Event) => {
    wear(event.target);
    // Only listen for moves WHILE held — an idle desktop pays nothing for this.
    targetWindow.addEventListener("pointermove", trackPressed);
  };
  const trackPressed = (event: Event) => wear(event.target);
  const clearPressed = () => {
    targetWindow.removeEventListener("pointermove", trackPressed);
    wear(null);
  };

  root.classList.add(GAME_CURSOR_ROOT_CLASS);
  targetWindow.addEventListener("pointerdown", setPressed);
  targetWindow.addEventListener("pointerup", clearPressed);
  targetWindow.addEventListener("pointercancel", clearPressed);
  targetWindow.addEventListener("blur", clearPressed);

  void process(hostUrl(GAME_CURSOR_DEFAULT_URL), GAME_CURSOR_HOTSPOT_X, GAME_CURSOR_HOTSPOT_Y).then((cursor) => {
    defaultCursor = cursor;
    renderStyle();
  });
  void process(hostUrl(GAME_CURSOR_PRESSED_URL), GAME_CURSOR_HOTSPOT_X, GAME_CURSOR_HOTSPOT_Y).then((cursor) => {
    pressedCursor = cursor;
    renderStyle();
  });

  return {
    installed: true,
    dispose() {
      disposed = true;
      clearPressed();
      targetWindow.removeEventListener("pointerdown", setPressed);
      targetWindow.removeEventListener("pointerup", clearPressed);
      targetWindow.removeEventListener("pointercancel", clearPressed);
      targetWindow.removeEventListener("blur", clearPressed);
      styleEl?.remove();
      root.classList.remove(GAME_CURSOR_ROOT_CLASS);
    }
  };
}
