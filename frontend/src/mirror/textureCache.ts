// Decoded-texture warm cache for the live-tree MIRROR. Animating sprites (e.g. enemy intent icons) swap
// their `background-image` URL every animation frame; the first time a URL is shown the browser must fetch
// + decode it, leaving the box briefly blank → a visible flicker. Warming each URL through an Image() (with
// the /res/ route's immutable cache headers) means the bytes are fetched + decoded once, so subsequent
// frames of a looping animation swap instantly with no blank. Idempotent; a no-op without a DOM.
//
// Warming ALSO records each image's natural pixel size, which the nine-patch-over-atlas slicer needs to map
// a sprite sub-region's source slices onto the atlas page (the producer streams the region but not the page size).
// The two style paths that need a natural size style provisionally, then register the current node against the URL.
// When it resolves, MirrorView marks only those nodes dirty and schedules a normal coalesced render.
import { ref } from "vue";

const warmed = new Set<string>();
const sizes = new Map<string, { width: number; height: number }>();

// Component-local styles that read natural sizes subscribe to this signal. The mirror tree itself uses the targeted
// listener below, rather than turning a size resolution into a full reconcile.
export const textureSizeVersion = ref(0);

// url → the node ids that styled against it BEFORE its natural size was known. A url can be awaited by many nodes
// and a node can await many urls; entries are dropped when the url resolves. A dangling id (its node was removed
// before the load landed) is harmless: injecting an unknown id into the walk is a no-op by construction (see
// mirrorRenderer.markDirty, which skips ids absent from the node map).
const awaiting = new Map<string, Set<string>>();

// The node the renderer is currently styling — set around `visit`'s style block, null everywhere else, so a
// `naturalSize` call from outside a style pass (a tween-endpoint probe, a unit test) registers nothing.
let stylingNodeId: string | null = null;

export function setTextureStyleNode(nodeId: string | null): void {
  stylingNodeId = nodeId;
}

export type TextureSizeListener = (ids: ReadonlySet<string>) => void;

const listeners = new Set<TextureSizeListener>();

// Subscribe to targeted texture-size resolutions. Returns an unsubscribe. A Set (not a single slot) so two
// coexisting mirror views — or a test that mounts one while another is tearing down — can't silently steal it.
export function onTextureSizesResolved(listener: TextureSizeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function warmImage(url: string): void {
  if (!url || warmed.has(url) || typeof Image === "undefined") {
    return;
  }
  warmed.add(url);
  const img = new Image();
  img.decoding = "async";
  // BOTH handlers are removed once the load settles. A warm is a ONE-SHOT measurement, but the listeners used to
  // outlive it: they keep the Image (and themselves) alive, one per distinct texture url, for the whole session.
  // A census of a live phone session counted 381 live JS listeners where the page's own wiring is ~30 — the rest
  // was this, growing with every new sprite the session met. Nothing here is a fetch change: the browser's image
  // cache still holds the decoded texture, which is the whole point of the warm.
  const settle = (): void => {
    img.removeEventListener("load", onLoad);
    img.removeEventListener("error", settle);
  };
  const onLoad = (): void => {
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      recordNaturalSize(url, img.naturalWidth, img.naturalHeight);
    }
    settle();
  };
  img.addEventListener("load", onLoad);
  img.addEventListener("error", settle);
  img.src = url;
}

// Record a measured natural size and publish the targeted id set for nodes that styled provisionally against it.
function recordNaturalSize(url: string, width: number, height: number): void {
  sizes.set(url, { width, height });
  textureSizeVersion.value += 1;
  const ids = awaiting.get(url);
  if (ids === undefined) {
    return; // nobody styled against it before it loaded
  }
  awaiting.delete(url);
  for (const listener of listeners) {
    listener(ids);
  }
}

// The natural (intrinsic) pixel size of a warmed image, or null until it has loaded. A MISS while the renderer is
// styling a node registers that node against the url (see the header): the node is styling provisionally and must
// be re-styled — and it alone — once the size lands.
export function naturalSize(url: string): { width: number; height: number } | null {
  const size = sizes.get(url);
  if (size !== undefined) {
    return size;
  }
  if (stylingNodeId !== null) {
    let ids = awaiting.get(url);
    if (ids === undefined) {
      ids = new Set<string>();
      awaiting.set(url, ids);
    }
    ids.add(stylingNodeId);
  }
  return null;
}

// --- test seams (never called in production) -----------------------------------------------------------------

// Drive the exact code path the Image `load` handler drives (jsdom never loads an image).
export function __recordTextureSizeForTest(url: string, width: number, height: number): void {
  recordNaturalSize(url, width, height);
}

export function __textureWaitersForTest(url: string): string[] {
  return [...(awaiting.get(url) ?? [])];
}

export function __resetTextureCacheForTest(): void {
  warmed.clear();
  sizes.clear();
  awaiting.clear();
  stylingNodeId = null;
  textureSizeVersion.value = 0;
}
