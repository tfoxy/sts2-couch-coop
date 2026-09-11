// Enemy-intent playback is deliberately kept on the existing RenderRecord fields. The renderer owns records and
// structural ordering; this controller owns only the live animator memberships and the intent paint mechanisms.

import {
  atlasStripBlobUrl,
  atlasStripKey,
  drawAtlasRegion,
} from "@/mirror/atlasBaker";
import {
  ensureIntentStepsKeyframes,
  intentStepsAnimationCss,
  intentStepsPhaseMs,
  intentStripGeometry,
  type IntentStripGeometry,
} from "@/mirror/intentStrip";
import { atlasCanvasPlacement } from "@/mirror/nodeStyles";
import { renderQuality } from "@/render/quality";
import type { MirrorIntentFrames, MirrorNode } from "@/mirror/sceneTree";
import {
  decodedAtlasBlobs,
  requestAtlasBlobDecode,
  retainIntentStrip,
} from "@/mirror/renderer/dom/atlasRuntime";
import type { RenderRecord } from "@/mirror/renderer/dom/recordModel";
import { intentFrameIndex } from "@/mirror/renderer/intentPolicy";

export interface IntentTimelinePorts {
  now(): number;
  schedule(): void;
  anchorAnimations(target: HTMLElement, startTime: number): void;
}

export interface IntentTimeline {
  readonly activeCount: number;
  readonly occludedCount: number;
  readonly pausedStripCount: number;
  tick(now: number, gated: boolean): void;
  update(
    record: RenderRecord,
    node: MirrorNode,
    steps: boolean,
    hasChildren: boolean,
  ): void;
  syncOcclusion(
    now: number,
    gated: boolean,
    isUnderOccludedRoot: (id: string) => boolean,
  ): boolean;
  resetElement(record: RenderRecord): void;
  dispose(): void;
}

export function createIntentTimeline(
  ports: IntentTimelinePorts,
): IntentTimeline {
  const activeIntents = new Set<RenderRecord>();
  const occludedIntents = new Set<RenderRecord>();
  const steppedIntents = new Set<RenderRecord>();
  const pausedIntentStrips = new Set<RenderRecord>();
  const occlusionScratch = new Array<RenderRecord>();
  let lastIntentTickMs = 0;

  function advanceIntent(record: RenderRecord, wallNow: number): void {
    const spec = record.lastNode?.intentFrames;
    const canvas = record.atlasCanvas;
    if (!spec || spec.frames.length <= 1 || !canvas) return;
    const index = intentFrameIndex(
      wallNow - record.intentStartMs,
      spec.fps,
      spec.frames.length,
    );
    if (index === record.intentShownFrame) return;
    const frame = spec.frames[index];
    if (!frame.region || !frame.url) return;
    record.intentShownFrame = index;
    const region = {
      x: frame.region.x,
      y: frame.region.y,
      width: frame.region.width,
      height: frame.region.height,
    };
    const w = Math.max(1, Math.round(region.width));
    const h = Math.max(1, Math.round(region.height));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    drawAtlasRegion(ctx, frame.url, region, () => {
      if (record.intentShownFrame !== index || !record.atlasCanvas) return;
      const c = record.atlasCanvas.getContext("2d");
      if (c) {
        c.clearRect(0, 0, record.atlasCanvas.width, record.atlasCanvas.height);
        drawAtlasRegion(c, frame.url, region, () => {});
      }
    });
  }

  function tick(now: number, gated: boolean): void {
    if (activeIntents.size === 0) return;
    if (gated) {
      const fps = renderQuality().spineClipFps;
      if (fps > 0 && now - lastIntentTickMs < 1000 / fps - 1) return;
    }
    lastIntentTickMs = now;
    for (const record of activeIntents) advanceIntent(record, now);
  }

  function paintIntentStrip(
    record: RenderRecord,
    spec: MirrorIntentFrames,
    geo: IntentStripGeometry,
    key: string,
  ): void {
    const canvas = record.intentStrip;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const pending = new Set<string>();
    for (let i = 0; i < geo.count; i++) {
      const frame = spec.frames[i];
      const region = frame.region;
      if (!region || !frame.url) continue;
      const url = frame.url;
      const first = !pending.has(url);
      pending.add(url);
      ctx.save();
      ctx.translate(i * geo.cellW, 0);
      ctx.scale(geo.cellW / region.width, geo.cellH / region.height);
      drawAtlasRegion(ctx, url, region, () => {
        if (first && record.intentStripKey === key)
          paintIntentStrip(record, spec, geo, key);
      });
      ctx.restore();
    }
  }

  function syncIntentViewPlacement(
    record: RenderRecord,
    node: MirrorNode,
    hasChildren: boolean,
  ): void {
    const view = record.intentView;
    if (!view) return;
    const placement = hasChildren ? atlasCanvasPlacement(node) : null;
    const placementKey = placement
      ? `${placement.width}|${placement.height}|${placement.transform}`
      : null;
    if (record.intentStripPlacementKey === placementKey) return;
    record.intentStripPlacementKey = placementKey;
    if (placement) {
      view.style.inset = "0 auto auto 0";
      view.style.width = placement.width;
      view.style.height = placement.height;
      view.style.transform = placement.transform;
      view.style.transformOrigin = "0 0";
    } else {
      view.style.inset = "";
      view.style.width = "";
      view.style.height = "";
      view.style.transform = "";
      view.style.transformOrigin = "";
    }
  }

  function armIntentSteps(
    record: RenderRecord,
    el: HTMLElement,
    geo: IntentStripGeometry,
  ): void {
    el.style.width = `${geo.travelPx}px`;
    el.style.height = `${geo.dispH}px`;
    ensureIntentStepsKeyframes(geo.travelPx);
    const phase = intentStepsPhaseMs(
      ports.now(),
      record.intentStartMs,
      geo.durationMs,
    );
    el.style.animation = intentStepsAnimationCss(geo, phase);
    el.style.animationPlayState = record.intentStripPaused ? "paused" : "";
    record.intentStripAnchorMs = record.intentStartMs + phase;
    ports.anchorAnimations(el, record.intentStripAnchorMs);
  }

  function syncIntentStrip(
    record: RenderRecord,
    node: MirrorNode,
    spec: MirrorIntentFrames,
    hasChildren: boolean,
  ): boolean {
    const geo = intentStripGeometry(spec);
    if (!geo) return false;
    if (record.intentImg) {
      record.intentImg.remove();
      record.intentImg = null;
      record.intentImgKey = null;
    }
    if (!record.intentView) {
      record.intentView = document.createElement("div");
      record.intentView.className = "mirror-intent-view";
    }
    if (!record.intentStrip) {
      record.intentStrip = document.createElement("canvas");
      record.intentStrip.className = "mirror-intent-strip";
      record.intentView.appendChild(record.intentStrip);
      record.intentStripKey = null;
    }
    syncIntentViewPlacement(record, node, hasChildren);
    let key = `${spec.animationName}|${spec.fps}|${geo.cellW}x${geo.cellH}|${geo.dispW}x${geo.dispH}`;
    for (const frame of spec.frames) {
      const region = frame.region!;
      key += `|${frame.url}@${region.x},${region.y},${region.width},${region.height}`;
    }
    if (record.intentStripKey !== key) {
      record.intentStripKey = key;
      const canvas = record.intentStrip;
      const width = geo.cellW * geo.count;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== geo.cellH) canvas.height = geo.cellH;
      paintIntentStrip(record, spec, geo, key);
      armIntentSteps(record, canvas, geo);
    }
    steppedIntents.add(record);
    return true;
  }

  function intentStepsEl(record: RenderRecord): HTMLElement | null {
    return record.intentStrip ?? record.intentImg;
  }

  function teardownIntentStrip(record: RenderRecord): void {
    steppedIntents.delete(record);
    pausedIntentStrips.delete(record);
    record.intentView?.remove();
    record.intentView = null;
    record.intentStrip = null;
    record.intentStripKey = null;
    record.intentStripPlacementKey = null;
    record.intentStripPaused = false;
    record.intentImg = null;
    record.intentImgKey = null;
  }

  function setIntentStripPaused(record: RenderRecord, paused: boolean): void {
    if (record.intentStripPaused === paused) return;
    record.intentStripPaused = paused;
    const el = intentStepsEl(record);
    if (!el) return;
    el.style.animationPlayState = paused ? "paused" : "";
    if (!paused) ports.anchorAnimations(el, record.intentStripAnchorMs);
  }

  function intentStripImage(
    spec: MirrorIntentFrames,
    nodeId: string,
  ): { url: string; geo: IntentStripGeometry } | null {
    const geo = intentStripGeometry(spec);
    if (!geo) return null;
    const cells = spec.frames.map((frame) => ({
      url: frame.url,
      region: frame.region!,
    }));
    const key = atlasStripKey(
      `${spec.animationName}|${spec.fps}`,
      cells,
      geo.cellW,
      geo.cellH,
    );
    const url = atlasStripBlobUrl(
      { key, cells, cellW: geo.cellW, cellH: geo.cellH },
      nodeId,
    );
    if (url === null) return null;
    retainIntentStrip(url);
    if (!decodedAtlasBlobs.has(url)) {
      requestAtlasBlobDecode(url, nodeId);
      if (!decodedAtlasBlobs.has(url)) return null;
    }
    return { url, geo };
  }

  function syncIntentImg(
    record: RenderRecord,
    node: MirrorNode,
    stripUrl: string,
    geo: IntentStripGeometry,
    hasChildren: boolean,
  ): void {
    if (record.intentStrip) {
      record.intentStrip.remove();
      record.intentStrip = null;
      record.intentStripKey = null;
    }
    if (!record.intentView) {
      record.intentView = document.createElement("div");
      record.intentView.className = "mirror-intent-view";
    }
    if (!record.intentImg) {
      const img = document.createElement("img");
      img.className = "mirror-intent-img";
      img.decoding = "sync";
      record.intentView.appendChild(img);
      record.intentImg = img;
      record.intentImgKey = null;
    }
    syncIntentViewPlacement(record, node, hasChildren);
    const key = `${stripUrl}|${geo.travelPx}|${geo.dispH}|${geo.count}|${geo.durationMs}`;
    if (record.intentImgKey !== key) {
      record.intentImgKey = key;
      record.intentImg.src = stripUrl;
      armIntentSteps(record, record.intentImg, geo);
    }
    steppedIntents.add(record);
  }

  function update(
    record: RenderRecord,
    node: MirrorNode,
    steps: boolean,
    hasChildren: boolean,
  ): void {
    const spec = node.intentFrames;
    let steppedNow = false;
    if (steps) {
      const key = `${spec!.animationName}|${spec!.frames.length}`;
      if (record.intentKey !== key) {
        record.intentKey = key;
        record.intentStartMs = ports.now();
        record.intentShownFrame = -1;
      }
      const stripImage = intentStripImage(spec!, node.id);
      if (stripImage !== null) {
        syncIntentImg(
          record,
          node,
          stripImage.url,
          stripImage.geo,
          hasChildren,
        );
        steppedNow = true;
      } else {
        steppedNow = syncIntentStrip(record, node, spec!, hasChildren);
      }
      if (steppedNow) {
        activeIntents.delete(record);
        occludedIntents.delete(record);
      }
    }
    if (!steppedNow && record.intentView) teardownIntentStrip(record);
    if (!steppedNow) {
      if (spec && spec.frames.length > 1 && record.atlasCanvas) {
        const key = `${spec.animationName}|${spec.frames.length}`;
        if (record.intentKey !== key) {
          record.intentKey = key;
          record.intentStartMs = ports.now();
          record.intentShownFrame = -1;
        }
        activeIntents.add(record);
        ports.schedule();
        advanceIntent(record, ports.now());
      } else if (
        record.intentKey !== null ||
        activeIntents.has(record) ||
        occludedIntents.has(record)
      ) {
        activeIntents.delete(record);
        occludedIntents.delete(record);
        record.intentKey = null;
        record.intentShownFrame = -1;
      }
    }
  }

  function syncOcclusion(
    now: number,
    gated: boolean,
    isUnderOccludedRoot: (id: string) => boolean,
  ): boolean {
    let changed = false;
    if (gated && activeIntents.size > 0) {
      occlusionScratch.length = 0;
      for (const record of activeIntents) {
        if (isUnderOccludedRoot(record.id)) occlusionScratch.push(record);
      }
      for (const record of occlusionScratch) {
        activeIntents.delete(record);
        occludedIntents.add(record);
        changed = true;
      }
    }
    if (occludedIntents.size > 0) {
      occlusionScratch.length = 0;
      for (const record of occludedIntents) {
        if (!gated || !isUnderOccludedRoot(record.id))
          occlusionScratch.push(record);
      }
      for (const record of occlusionScratch) {
        occludedIntents.delete(record);
        activeIntents.add(record);
        advanceIntent(record, now);
        changed = true;
      }
    }
    if (steppedIntents.size > 0 && (gated || pausedIntentStrips.size > 0)) {
      for (const record of steppedIntents) {
        const park = gated && isUnderOccludedRoot(record.id);
        if (park === pausedIntentStrips.has(record)) continue;
        setIntentStripPaused(record, park);
        if (park) pausedIntentStrips.add(record);
        else pausedIntentStrips.delete(record);
      }
    }
    return changed;
  }

  function quiesce(record: RenderRecord): void {
    activeIntents.delete(record);
    occludedIntents.delete(record);
    steppedIntents.delete(record);
    pausedIntentStrips.delete(record);
  }

  function resetElement(record: RenderRecord): void {
    quiesce(record);
    record.intentKey = null;
    record.intentShownFrame = -1;
    record.intentView = null;
    record.intentStrip = null;
    record.intentStripKey = null;
    record.intentStripPlacementKey = null;
    record.intentStripPaused = false;
    record.intentStripAnchorMs = 0;
    record.intentImg = null;
    record.intentImgKey = null;
  }

  return {
    get activeCount() {
      return activeIntents.size;
    },
    get occludedCount() {
      return occludedIntents.size;
    },
    get pausedStripCount() {
      return pausedIntentStrips.size;
    },
    tick,
    update,
    syncOcclusion,
    resetElement,
    dispose() {
      activeIntents.clear();
      occludedIntents.clear();
      steppedIntents.clear();
      pausedIntentStrips.clear();
    },
  };
}
