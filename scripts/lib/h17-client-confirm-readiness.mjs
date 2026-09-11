// Small, DOM-free predicates for H17's own chrome.  Keeping this apart from the live runner means the
// regression (an entering button had a non-zero box but was still beyond the viewport) is testable without
// launching a game or a browser.

const finiteBox = (box) =>
  box && [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 4 && box.height > 4;

const contains = (box, point) =>
  finiteBox(box) &&
  Number.isFinite(point?.x) &&
  Number.isFinite(point?.y) &&
  point.x >= box.x &&
  point.x <= box.x + box.width &&
  point.y >= box.y &&
  point.y <= box.y + box.height;

/**
 * Turn a page-side confirm snapshot into the two different facts the harness needs:
 * `visible` means the control is logically mounted (and is deliberately used for its exit wait), while
 * `tappable` additionally requires the intended centre to be inside both stage and viewport and to win the
 * browser hit-test.  An entering control is mounted before its 180px translate reaches the viewport.
 */
export function assessClientConfirm(raw) {
  const present = raw?.present === true;
  const box = finiteBox(raw?.box) ? raw.box : null;
  const visible = present && raw.display !== "none" && raw.visibility !== "hidden" && box !== null;
  const tapPoint = box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
  const viewport = raw?.viewport;
  const inViewport =
    tapPoint !== null &&
    Number.isFinite(viewport?.width) &&
    Number.isFinite(viewport?.height) &&
    tapPoint.x >= 0 &&
    tapPoint.x <= viewport.width &&
    tapPoint.y >= 0 &&
    tapPoint.y <= viewport.height;
  const inStage = tapPoint !== null && contains(raw?.stage, tapPoint);
  const tappable = visible && inViewport && inStage && raw?.hitTestMatches === true;
  return {
    present,
    visible,
    tappable,
    box,
    tapPoint,
    inViewport,
    inStage,
    hitTestMatches: raw?.hitTestMatches === true
  };
}

const pathname = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
};

const isMirrorAppModule = (url) => /(?:^|\/)MirrorApp\.vue$/.test(pathname(url));
const isViteRuntime = (url) => /\/@vite\/client$/.test(pathname(url));

/**
 * Pick the client module that was actually fetched for this document.  Vite dev mode exposes the direct SFC
 * module; production folds it into the page's non-Vite module entry, so that entry is the truthful fallback.
 */
export function selectMirrorModuleBundle({ scriptSrcs = [], resourceUrls = [] } = {}) {
  const fetched = new Set(resourceUrls.filter((url) => typeof url === "string"));
  const mirrorApp = resourceUrls.find((url) => typeof url === "string" && isMirrorAppModule(url));
  if (mirrorApp) return { kind: "mirror-app-module", url: mirrorApp };

  const entry = scriptSrcs.find((url) => typeof url === "string" && !isViteRuntime(url) && fetched.has(url));
  return entry ? { kind: "page-module-entry", url: entry } : null;
}
