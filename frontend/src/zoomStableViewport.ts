import { observeBrowserZoom, type BrowserZoomWindow } from "@godot-scene-web/html";

// Page-side application of godot-scene-web's browser-zoom detector: make browser
// zoom APPLY to the game instead of being neutralized. The game scales to fit
// `.game-surface`, whose default `width/height: 100%` chain shrinks (in CSS px)
// when the browser zooms — gsw's ResizeObserver would refit `--godot-scale` and
// the game would stay the same physical size. At any zoom z ≠ 1 these CSS vars
// pin the surface to its 100%-zoom CSS size (`layout viewport · z`), so the
// browser's own CSS-px scaling renders it z× larger physically and `#app`
// (overflow: auto) pans the overflow. At z = 1 the vars are removed and the
// legacy pure-`%` layout is byte-for-byte back. Mobile pinch-zoom never reaches
// this module (visual-viewport zoom; the detector reads only the layout
// viewport) — the browser magnifies and pans natively.
export const ZOOM_STABLE_WIDTH_VAR = "--zoom-stable-width";
export const ZOOM_STABLE_HEIGHT_VAR = "--zoom-stable-height";

export interface InstalledZoomStableViewport {
  dispose(): void;
}

export interface ZoomStableViewportOptions {
  /** The pan scroll container recentred after a zoom change. Defaults to `#app`. */
  scroller?: () => HTMLElement | null;
}

export type ZoomStableWindow = BrowserZoomWindow & {
  document: Pick<Document, "getElementById"> & {
    documentElement: Pick<HTMLElement, "clientWidth" | "getBoundingClientRect">;
  };
};

export function installZoomStableViewport(
  root: HTMLElement = document.documentElement,
  targetWindow: ZoomStableWindow = window,
  options: ZoomStableViewportOptions = {}
): InstalledZoomStableViewport {
  const resolveScroller =
    options.scroller ?? (() => targetWindow.document.getElementById("app"));

  let lastZoom = 1;

  const clearVars = () => {
    root.style.removeProperty(ZOOM_STABLE_WIDTH_VAR);
    root.style.removeProperty(ZOOM_STABLE_HEIGHT_VAR);
  };

  const apply = (zoom: number) => {
    lastZoom = zoom;
    if (Math.abs(zoom - 1) < 0.005) {
      clearVars();
      return;
    }
    // Fractional rect, not the integer `clientWidth`: a ±0.5px rounding error
    // multiplied by z would nudge the surface off its 100%-zoom size and churn
    // `--godot-scale` refits on every zoom step.
    const viewport = targetWindow.document.documentElement.getBoundingClientRect();
    root.style.setProperty(ZOOM_STABLE_WIDTH_VAR, `${viewport.width * zoom}px`);
    root.style.setProperty(ZOOM_STABLE_HEIGHT_VAR, `${viewport.height * zoom}px`);
    // Land in the middle of the enlarged surface — without this, zooming in
    // dumps the player at the game's top-left corner.
    const scroller = resolveScroller();
    if (scroller) {
      scroller.scrollLeft = (scroller.scrollWidth - scroller.clientWidth) / 2;
      scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) / 2;
    }
  };

  // The detector only reports zoom CHANGES; while zoomed, a plain window resize
  // must still re-derive the surface size from the new layout viewport.
  const onResize = () => {
    if (Math.abs(lastZoom - 1) >= 0.005) {
      apply(lastZoom);
    }
  };

  const unsubscribeZoom = observeBrowserZoom(apply, targetWindow);
  targetWindow.addEventListener("resize", onResize);

  return {
    dispose() {
      unsubscribeZoom();
      targetWindow.removeEventListener("resize", onResize);
      clearVars();
    }
  };
}
