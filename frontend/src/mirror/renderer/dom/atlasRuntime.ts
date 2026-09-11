import { atlasPageSize, notifyAtlasRegionIds, whenAtlasSettled } from "@/mirror/atlasBaker";
import { decodeStill } from "@/mirror/stillDecode";

export const ATLAS_STICKY_CANVAS_REVERTS = 3;
const ATLAS_PAGE_CROP_MAX_PIXELS = 6_000_000;

/**
 * Choose the least expensive available placeholder. A page crop is safe only while
 * the decoded page stays below the card-atlas threshold; unknown pages stay on the
 * page path until their size is known, then the settle waiter schedules a restyle.
 */
export function atlasPlaceholderMechanism(url: string, tickBlits: boolean): "page" | "canvas" {
  if (tickBlits) return "canvas";
  const size = atlasPageSize(url);
  if (size === null) return "page";
  return size.width * size.height <= ATLAS_PAGE_CROP_MAX_PIXELS ? "page" : "canvas";
}

// A region is promoted only after decoding. Decode failures intentionally commit
// too: the browser's normal image failure path is preferable to holding a sprite.
export const decodedAtlasBlobs = new Set<string>();
const atlasBlobDecodeWaiters = new Map<string, Set<string>>();

export function requestAtlasBlobDecode(blobUrl: string, nodeId: string): void {
  if (decodedAtlasBlobs.has(blobUrl)) return;
  let ids = atlasBlobDecodeWaiters.get(blobUrl);
  if (ids !== undefined) {
    ids.add(nodeId);
    return;
  }
  ids = new Set([nodeId]);
  atlasBlobDecodeWaiters.set(blobUrl, ids);
  let sync = true;
  decodeStill(blobUrl, () => {
    decodedAtlasBlobs.add(blobUrl);
    atlasBlobDecodeWaiters.delete(blobUrl);
    if (!sync) notifyAtlasRegionIds(ids!);
  });
  sync = false;
}

// Hidden nodes can mount before a page's size is known. Wake those records once
// the page settles so oversized pages move to their canvas fallback before reveal.
const settledAtlasPages = new Set<string>();
const atlasPageSettleWaiters = new Map<string, Set<string>>();

export function requestAtlasPageSettle(url: string, nodeId: string): void {
  if (settledAtlasPages.has(url)) return;
  let ids = atlasPageSettleWaiters.get(url);
  if (ids !== undefined) {
    ids.add(nodeId);
    return;
  }
  ids = new Set([nodeId]);
  atlasPageSettleWaiters.set(url, ids);
  let sync = true;
  whenAtlasSettled(url, () => {
    settledAtlasPages.add(url);
    atlasPageSettleWaiters.delete(url);
    if (!sync) notifyAtlasRegionIds(ids!);
  });
  sync = false;
}

// Retaining one decoded image per intent strip avoids re-decoding a glyph when it
// returns to screen. Failure is harmless: the strip still renders normally.
const retainedIntentStripImages = new Map<string, HTMLImageElement>();

export function retainIntentStrip(blobUrl: string): void {
  if (retainedIntentStripImages.has(blobUrl) || typeof Image === "undefined") return;
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = blobUrl;
    retainedIntentStripImages.set(blobUrl, img);
  } catch {
    // Best-effort cache warmth only.
  }
}

export function __resetAtlasDecodeGateForTest(): void {
  decodedAtlasBlobs.clear();
  atlasBlobDecodeWaiters.clear();
  retainedIntentStripImages.clear();
  settledAtlasPages.clear();
  atlasPageSettleWaiters.clear();
}
