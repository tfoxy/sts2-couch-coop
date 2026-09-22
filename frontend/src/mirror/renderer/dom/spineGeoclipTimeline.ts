// The DOM spine timeline deliberately owns only live playback state.  RenderRecord remains the
// single retained state object: callers pass the live record, rather than a snapshot or sidecar.

import { renderQuality } from "@/render/quality";
import {
  createGeoclipNode,
  geoclipFrameIndexAt,
  geoclipPlacementFromManifest,
  probeGeoclip,
  uploadGeoclip,
} from "@/mirror/geoclipPlayer";
import type { MirrorNode } from "@/mirror/sceneTree";
import { pxCss } from "@/mirror/stageFit";
import { geoclipUrl } from "@/mirror/spineAttributes";
import { decodeStill } from "@/mirror/stillDecode";
import { frameIndexAt, type LoadedSpineClip } from "@/mirror/spineClip";
import type { GeoclipRecordState, RenderRecord } from "@/mirror/renderer/dom/recordModel";
import { mirrorWalkStats } from "@/mirror/renderer/walkStats";

const GEOCLIP_LIVE_CLASS = "mirror-geoclip-live";
const SPINE_PROMOTE_CLASS = "mirror-spine-promoted";
const SPINE_PROMOTE_EFFECT_SELECTOR =
  "canvas, .mirror-shader-self, .mirror-particle-self, [data-godot-shader-image]";

export interface SpineGeoclipTimelinePorts {
  now(): number;
  schedule(): void;
  noteCanvasRepaint(canvas: HTMLCanvasElement | null | undefined): void;
  syncFrozenCanvasStyle(canvas: HTMLCanvasElement | null | undefined): void;
  setMechanism(record: RenderRecord, mode: "canvas" | "img"): void;
  setShownStill(record: RenderRecord, clip: LoadedSpineClip | null): void;
  applyRasterPlacement(record: RenderRecord, clip: LoadedSpineClip): void;
  /** Spine pixels just committed on this record — see `RenderRecord.spineArtPainted`. */
  noteArtPainted(record: RenderRecord): void;
}

export interface SpineGeoclipTimeline {
  readonly activeCount: number;
  readonly occludedCount: number;
  readonly promotedCount: number;
  tick(now: number, gated: boolean): void;
  add(record: RenderRecord): void;
  remove(record: RenderRecord): void;
  registerStill(record: RenderRecord): void;
  noteDomShapeChanged(): void;
  clearPromotion(record: RenderRecord): void;
  refreshPromotion(record: RenderRecord): void;
  applyPromotionPass(): void;
  applyPlacement(record: RenderRecord, clip: LoadedSpineClip): void;
  advance(record: RenderRecord, now: number): void;
  armGeoclip(record: RenderRecord, node: MirrorNode): void;
  releaseGeoclip(record: RenderRecord): void;
  disableGeoclip(record: RenderRecord): void;
  syncOcclusion(gated: boolean, isUnderOccludedRoot: (id: string) => boolean): boolean;
  dispose(): void;
}

export function createSpineGeoclipTimeline(ports: SpineGeoclipTimelinePorts): SpineGeoclipTimeline {
  const activeSpine = new Set<RenderRecord>();
  const occludedSpine = new Set<RenderRecord>();
  const spineStillNodes = new Set<RenderRecord>();
  const scratch = new Array<RenderRecord>();
  let lastSpineTickMs = 0;
  let promoteDirty = false;
  let promotedCount = 0;

  function setPromoted(record: RenderRecord, promoted: boolean): void {
    if (record.spinePromoted === promoted) return;
    record.spinePromoted = promoted;
    promotedCount += promoted ? 1 : -1;
    record.el?.classList.toggle(SPINE_PROMOTE_CLASS, promoted);
  }

  function clearPromotion(record: RenderRecord): void {
    spineStillNodes.delete(record);
    setPromoted(record, false);
  }

  function refreshPromotion(record: RenderRecord): void {
    const el = record.el;
    if (el === null || record.spineImg === null) {
      clearPromotion(record);
      return;
    }
    setPromoted(record, el.querySelector(SPINE_PROMOTE_EFFECT_SELECTOR) !== null);
  }

  function applyPromotionPass(): void {
    if (!promoteDirty) return;
    promoteDirty = false;
    for (const record of spineStillNodes) refreshPromotion(record);
  }

  // LAYOUT SPACE (stageFit.ts): the CSS box and the node-local offset are lengths; the trailing `scale()` maps clip
  // px into that box and is dimensionless, so it stays. (The `<img>`'s intrinsic pixels are untouched either way.)
  function applyStillPlacement(img: HTMLImageElement, w: number, h: number, tx: number, ty: number, scale: number): void {
    img.style.width = pxCss(w);
    img.style.height = pxCss(h);
    img.style.transform = `translate(${pxCss(tx)}, ${pxCss(ty)}) scale(${scale})`;
  }

  function applyGatedStill(record: RenderRecord, clip: LoadedSpineClip, still: LoadedSpineClip["frames"][number], scale: number): void {
    const url = clip.stillUrl!;
    const w = Math.max(1, Math.round(still.width));
    const h = Math.max(1, Math.round(still.height));
    const tx = clip.localX + still.offsetX * scale;
    const ty = clip.localY + still.offsetY * scale;
    const key = `img|${w}x${h}|${tx},${ty},${scale}`;
    if (record.spineImg && record.spineImgUrl === url) {
      if (record.spinePendingStillUrl === url) record.spinePendingStillUrl = null;
      if (record.spinePlacementKey === key) return;
      record.spinePlacementKey = key;
      applyStillPlacement(record.spineImg, w, h, tx, ty, scale);
      return;
    }
    if (record.spinePendingStillUrl === url) return;
    record.spinePendingStillUrl = url;
    mirrorWalkStats.spineStillDecodes += 1;
    decodeStill(url, () => {
      if (record.spinePendingStillUrl !== url || record.spineClip !== clip || !record.spineLayer) {
        mirrorWalkStats.spineStillStale += 1;
        return;
      }
      record.spinePendingStillUrl = null;
      ports.setMechanism(record, "img");
      const img = record.spineImg;
      if (!img) return;
      record.spineImgUrl = url;
      img.src = url;
      record.spinePlacementKey = key;
      applyStillPlacement(img, w, h, tx, ty, scale);
      ports.setShownStill(record, clip);
      ports.noteArtPainted(record); // real pixels are on screen — retire any creature stand-in
      mirrorWalkStats.spineStillCommits += 1;
    });
  }

  function applyPlacement(record: RenderRecord, clip: LoadedSpineClip): void {
    if (!record.spineLayer) return;
    if (record.geoclipState) syncGeoclipPlacement(record, clip);
    const scale = clip.canvasWidth > 0 && clip.localWidth > 0 ? clip.localWidth / clip.canvasWidth : 1;
    const still = clip.frames.length === 1 ? clip.frames[0] : null;
    const asImg = still !== null && clip.stillUrl !== null;
    if (asImg) {
      applyGatedStill(record, clip, still, scale);
      return;
    }
    record.spinePendingStillUrl = null;
    ports.setMechanism(record, "canvas");
    const canvas = record.spineCanvas;
    if (!canvas) return;
    const w = Math.max(1, Math.round(clip.canvasWidth));
    const h = Math.max(1, Math.round(clip.canvasHeight));
    const key = `${w}x${h}|${clip.localX},${clip.localY},${scale}`;
    if (record.spinePlacementKey === key) return;
    record.spinePlacementKey = key;
    ports.noteCanvasRepaint(canvas);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    // `canvas.width/height` above are the BACKING STORE (resolution, unaffected); these three are the CSS box and
    // the node-local offset, which are lengths in layout space — see stageFit.ts.
    canvas.style.width = pxCss(w);
    canvas.style.height = pxCss(h);
    canvas.style.transform = `translate(${pxCss(clip.localX)}, ${pxCss(clip.localY)}) scale(${scale})`;
    ports.syncFrozenCanvasStyle(canvas);
    record.spineShownFrame = -1;
  }

  function advance(record: RenderRecord, now: number): void {
    if (record.geoclipState?.node) {
      drawGeoclip(record, now);
      return;
    }
    const clip = record.spineClip;
    const ctx = record.spineCtx;
    const canvas = record.spineCanvas;
    if (!clip || !ctx || !canvas) return;
    const playMs = record.spinePaused ? record.spineSyncTrackMs : record.spineSyncTrackMs + (now - record.spineSyncWallMs);
    const index = frameIndexAt(clip, playMs, record.spineLooping);
    if (index === record.spineShownFrame) return;
    record.spineShownFrame = index;
    const frame = clip.frames[index];
    if (!frame || !frame.bitmap) return;
    ports.noteCanvasRepaint(canvas);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frame.bitmap, frame.offsetX, frame.offsetY);
    ports.noteArtPainted(record); // ditto — a blitted frame retires the creature stand-in
  }

  function armGeoclip(record: RenderRecord, node: MirrorNode): void {
    if (record.geoclipDisabled) return;
    const manifestUrl = geoclipUrl(node, "manifest.json");
    if (!manifestUrl) return;
    const resolve = (file: string): string => geoclipUrl(node, file) ?? file;
    const state: GeoclipRecordState = { manifestUrl, clip: null, gpu: null, node: null, frame: -1 };
    record.geoclipState = state;
    void probeGeoclip(manifestUrl, resolve).then((clip) => {
      if (record.geoclipState !== state || record.geoclipDisabled) return;
      if (!clip) return;
      state.clip = clip;
      void uploadGeoclip(clip).then((gpu) => {
        if (record.geoclipState !== state || record.geoclipDisabled) return;
        if (!gpu) {
          disableGeoclip(record);
          return;
        }
        state.gpu = gpu;
        syncGeoclipPlacement(record, record.spineClip);
      });
    });
  }

  function syncGeoclipPlacement(record: RenderRecord, baked: LoadedSpineClip | null): void {
    const state = record.geoclipState;
    if (!state || !state.clip || !state.gpu || record.geoclipDisabled) return;
    const placement = geoclipPlacementFromManifest(state.clip) ?? (baked ? {
      canvasWidth: baked.canvasWidth, canvasHeight: baked.canvasHeight,
      localX: baked.localX, localY: baked.localY, localWidth: baked.localWidth
    } : null);
    if (!placement) return;
    if (state.node) {
      state.node.place(placement);
    } else {
      const el = record.el;
      if (!el) return;
      const mounted = createGeoclipNode(state.clip, state.gpu, placement);
      if (!mounted) {
        disableGeoclip(record);
        return;
      }
      state.node = mounted;
      state.frame = -1;
      el.appendChild(mounted.el);
      el.classList.add(GEOCLIP_LIVE_CLASS);
      ports.noteArtPainted(record); // geometry is mounted — retire the creature stand-in with it
      if (state.clip.frames.length > 1) {
        activeSpine.add(record);
        ports.schedule();
      }
    }
    drawGeoclip(record, ports.now());
  }

  function drawGeoclip(record: RenderRecord, now: number): void {
    const state = record.geoclipState;
    if (!state?.node || !state.clip) return;
    const playMs = record.spinePaused ? record.spineSyncTrackMs : record.spineSyncTrackMs + (now - record.spineSyncWallMs);
    const index = geoclipFrameIndexAt(state.clip, playMs, record.spineLooping);
    if (index === state.frame) return;
    state.frame = index;
    if (!state.node.draw(index)) disableGeoclip(record);
  }

  function releaseGeoclip(record: RenderRecord): void {
    const state = record.geoclipState;
    if (!state) return;
    record.geoclipState = null;
    state.node?.dispose();
    record.el?.classList.remove(GEOCLIP_LIVE_CLASS);
    if (state.node && (state.clip?.frames.length ?? 0) > 1 && (record.spineClip?.frames.length ?? 0) <= 1) activeSpine.delete(record);
  }

  function disableGeoclip(record: RenderRecord): void {
    record.geoclipDisabled = true;
    releaseGeoclip(record);
    record.spineShownFrame = -1;
    record.spinePlacementKey = null;
    if (record.spineClip) {
      ports.applyRasterPlacement(record, record.spineClip);
      advance(record, ports.now());
    }
  }

  function tick(now: number, gated: boolean): void {
    if (activeSpine.size === 0) return;
    if (gated) {
      const fps = renderQuality().spineClipFps;
      if (fps > 0 && now - lastSpineTickMs < 1000 / fps - 1) return;
    }
    lastSpineTickMs = now;
    for (const record of activeSpine) advance(record, now);
  }

  function syncOcclusion(gated: boolean, isUnderOccludedRoot: (id: string) => boolean): boolean {
    let changed = false;
    if (gated && activeSpine.size > 0) {
      scratch.length = 0;
      for (const record of activeSpine) if (isUnderOccludedRoot(record.id)) scratch.push(record);
      for (const record of scratch) {
        activeSpine.delete(record);
        occludedSpine.add(record);
        changed = true;
      }
    }
    if (occludedSpine.size > 0) {
      scratch.length = 0;
      for (const record of occludedSpine) if (!gated || !isUnderOccludedRoot(record.id)) scratch.push(record);
      const now = ports.now();
      for (const record of scratch) {
        occludedSpine.delete(record);
        activeSpine.add(record);
        advance(record, now);
        changed = true;
      }
    }
    return changed;
  }

  return {
    get activeCount() { return activeSpine.size; },
    get occludedCount() { return occludedSpine.size; },
    get promotedCount() { return promotedCount; },
    tick,
    add: (record) => activeSpine.add(record),
    remove: (record) => { activeSpine.delete(record); occludedSpine.delete(record); },
    registerStill: (record) => { spineStillNodes.add(record); promoteDirty = true; },
    noteDomShapeChanged: () => { promoteDirty = true; },
    clearPromotion,
    refreshPromotion,
    applyPromotionPass,
    applyPlacement,
    advance,
    armGeoclip,
    releaseGeoclip,
    disableGeoclip,
    syncOcclusion,
    dispose: () => {
      activeSpine.clear();
      occludedSpine.clear();
      spineStillNodes.clear();
      promoteDirty = false;
      promotedCount = 0;
    }
  };
}
