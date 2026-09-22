// DOM-only sublayer assembly. RenderRecord remains the retained owner of every element and cache.

import { SELF_LAYER_CLASS, regionBackgroundStyle } from "@godot-scene-web/html";
import { applyAnimationBinding, ensureRichTextEffectStyles } from "@spirectl/presentation/render";
import type { Affine } from "@/mirror/affine";
import {
  atlasPageSize,
  atlasRegionBlobUrl,
  atlasRegionKey,
  drawAtlasRegion,
  preloadAtlas,
} from "@/mirror/atlasBaker";
import { bakedStillFor } from "@/mirror/bakedEffects";
import { isCardTrailNode, trailProfile } from "@/mirror/cardTrail";
import {
  atlasCanvasPlacement,
  isNinePatchAtlas,
  ninePatchAtlasSlices,
  paintsAtlasCanvas,
  rangeFillStyle,
  richHtml,
  textStyle,
} from "@/mirror/nodeStyles";
import type { MirrorNode } from "@/mirror/sceneTree";
import type { MirrorShaderBinding } from "@/mirror/shaderAttributes";
import { px, pxCss } from "@/mirror/stageFit";
import { naturalSize, warmImage } from "@/mirror/textureCache";
import {
  ATLAS_STICKY_CANVAS_REVERTS,
  atlasPlaceholderMechanism,
  decodedAtlasBlobs,
  requestAtlasBlobDecode,
  requestAtlasPageSettle,
} from "@/mirror/renderer/dom/atlasRuntime";
import {
  DEFAULT_LINE_WIDTH,
  LINE_ERASER_STROKE,
  SVG_NS,
  isLineEraser,
  isMapStrokeNode,
  linePointsAttr,
  opaqueHtml,
} from "@/mirror/renderer/dom/flightTrailPolicy";
import type { IntentTimeline } from "@/mirror/renderer/dom/intentTimeline";
import type { RenderRecord } from "@/mirror/renderer/dom/recordModel";
import type { TrailScaffold } from "@/mirror/renderer/dom/cardTrailController";
import type { SpineGeoclipTimeline } from "@/mirror/renderer/dom/spineGeoclipTimeline";
import { applyStyleMap } from "@/mirror/renderer/dom/style";
import { mirrorWalkStats } from "@/mirror/renderer/walkStats";

export interface DomSubLayerPorts {
  syncShaderUvWindow(
    record: RenderRecord,
    node: MirrorNode,
    global: Affine,
  ): void;
  effects: { markShaderDirty(): void; markParticleDirty(): void };
  spineTimeline: Pick<SpineGeoclipTimeline, "noteDomShapeChanged">;
  intentTimeline: Pick<IntentTimeline, "update">;
  lineMasks: {
    updateStroke(
      id: string,
      owner: string | null,
      eraser: boolean,
      points: string,
      raw: number[],
      width: number,
    ): void;
    releaseLineMaskStroke(id: string): void;
  };
  trails: {
    acquire(bands: number): TrailScaffold;
    release(record: RenderRecord): void;
    releaseFrame(record: RenderRecord): void;
    syncBandOpacity(record: RenderRecord): void;
    active: Set<RenderRecord>;
  };
  frozen: {
    canvases: Map<HTMLCanvasElement, { img: HTMLImageElement }>;
    thaw(canvas: HTMLCanvasElement | null | undefined): void;
    syncStyle(canvas: HTMLCanvasElement | null | undefined): void;
    noteRepaint(canvas: HTMLCanvasElement | null | undefined): void;
  };
  ninePatch: {
    sync(record: RenderRecord, slices: Array<Record<string, string>>): void;
  };
  walk: { hatching(): boolean; now(): number };
  updateSpineLayer(
    record: RenderRecord,
    node: MirrorNode,
    deferHiddenLayers: boolean,
  ): void;
}

export interface DomSubLayers {
  update(
    record: RenderRecord,
    node: MirrorNode,
    global: Affine,
    shader: MirrorShaderBinding | null,
    particle: { specsJson: string } | null,
    selfLayerPaint: Record<string, string> | null,
    hasChildren: boolean,
    deferHiddenLayers: boolean,
  ): void;
}

export function createDomSubLayers(ports: DomSubLayerPorts): DomSubLayers {
  const {
    syncShaderUvWindow,
    effects,
    spineTimeline,
    intentTimeline,
    lineMasks,
    trails,
    frozen,
    ninePatch,
    walk,
    updateSpineLayer,
  } = ports;
  /**
   * Mount, place, or tear down this node's baked effect still — the `<img>` that stands in for a BOXLESS effect
   * (a rarity-glow emitter) while its family is OFF or STATIC. See `bakedEffects.ts` for which nodes qualify and
   * why.
   *
   * Idempotent, and keyed on (url, box) so a glow being re-styled for an unrelated reason — a card moving, a
   * modulate tween — rewrites no styles at all.
   */
  function syncBakedStill(record: RenderRecord, node: MirrorNode, deferHiddenLayers: boolean): void {
    const el = record.el;
    const still = el === null ? null : bakedStillFor(node);
    // `"localRect"` stills are painted as the element's own background by `nodeStyle`; only boxless ones mount here.
    const box = still !== null && still.box !== "localRect" ? still.box : null;
    if (still === null || box === null) {
      if (record.bakedStillImg !== null) {
        record.bakedStillImg.remove();
        record.bakedStillImg = null;
        record.bakedStillKey = null;
      }
      return;
    }
    if (deferHiddenLayers && record.bakedStillImg === null) {
      return;
    }

    let img = record.bakedStillImg;
    if (img === null) {
      img = document.createElement("img");
      img.className = "mirror-baked-still";
      img.decoding = "async";
      img.alt = "";
      img.src = still.url;
      record.bakedStillImg = img;
      record.bakedStillKey = null;
      el!.appendChild(img);
    }

    // LAYOUT SPACE (stageFit.ts): the box is already in the node's own local units, so the element's own matrix
    // supplies any scale the game put on the emitter (a rarity glow carries a 1.35 y-scale) and no `scale()`
    // belongs here — which is exactly why the bake pinned the node to identity.
    const key = `${still.url}|${box.x},${box.y},${box.width},${box.height}`;
    if (record.bakedStillKey !== key) {
      record.bakedStillKey = key;
      img.style.width = pxCss(box.width);
      img.style.height = pxCss(box.height);
      img.style.transform = `translate(${pxCss(box.x)}, ${pxCss(box.y)})`;
    }
  }

  function updateSubLayers(
    record: RenderRecord,
    node: MirrorNode,
    gNode: Affine,
    shader: MirrorShaderBinding | null,
    particle: { specsJson: string } | null,
    selfLayerPaint: Record<string, string> | null,
    hasChildren: boolean,
    // True when this node sits under a `display:none` ancestor. Defer creating pure-paint layers until they can
    // contribute pixels; existing layers still update and tear down normally.
    deferHiddenLayers: boolean,
  ): void {
    const el = record.el!;

    // NOTE: the self-paint layer (an INTERIOR node's own paint styling — tint filter, selfAlpha, backgrounds) is
    // created/updated in the ASSEMBLY block at the end of this function: it must WRAP the mirror-owned paint
    // sub-layers built below (atlas canvas / text / 9-slice / range fill / spine canvas), so the decision needs
    // to know which of those exist.

    // Shader self-layer (WebGL canvas mount point + base texture). Deferred under a hidden ancestor when it doesn't
    // exist yet: without the markers (also deferred, see visit) gsw never selects this node, so the mount point
    // would stand empty — and creating it would set `shaderNodesDirty` and drag gsw through a pointless reconcile.
    if (
      shader &&
      shader.attributes["data-godot-shader-webgl"] &&
      !(deferHiddenLayers && !record.shaderSelf)
    ) {
      if (!record.shaderSelf) {
        record.shaderSelf = document.createElement("div");
        record.shaderSelf.className = `${SELF_LAYER_CLASS} mirror-shader-self`;
        effects.markShaderDirty();
        spineTimeline.noteDomShapeChanged(); // an effect surface appeared
      }
      const fit = shader.selfLayerFit ?? "";
      if (record.shaderSelfFit !== fit) {
        record.shaderSelf.style.backgroundSize = fit;
        record.shaderSelfFit = fit;
        effects.markShaderDirty();
      }
      const tex = shader.textureUrl ?? null;
      if (record.shaderSelfTex !== tex) {
        if (tex) {
          record.shaderSelf.setAttribute("data-godot-shader-texture-url", tex);
        } else {
          record.shaderSelf.removeAttribute("data-godot-shader-texture-url");
        }
        record.shaderSelfTex = tex;
        effects.markShaderDirty();
      }
      syncShaderUvWindow(record, node, gNode);
      // Q1 flame loop: apply the scaleY+skew sine loop to the shader canvas layer too (ONCE). The stepped-fire
      // quad's visible paint is the WebGL/Static canvas gsw mounts INTO shaderSelf, so animSelf's transform never
      // reaches it — the loop must ride shaderSelf directly. gsw owns only the canvas + the layer's
      // background/filter (never its transform/animation), so this is safe; the guard stops a re-visit restarting
      // it. transform-origin bottom-center matches the flame base.
      if (record.flameBinding && !record.shaderSelfFlamed) {
        applyAnimationBinding(
          record.shaderSelf,
          record.flameBinding,
          undefined,
        );
        record.shaderSelfFlamed = true;
      }
    } else if (record.shaderSelf) {
      record.shaderSelf.remove();
      record.shaderSelf = null;
      record.shaderSelfFit = null;
      record.shaderSelfTex = null;
      record.shaderSelfFlamed = false; // a later shaderSelf rebuild re-applies the flame loop
      effects.markShaderDirty();
      spineTimeline.noteDomShapeChanged(); // an effect surface left
    }

    // R10-B1: a multi-frame enemy-intent glyph on the COMPOSITOR path paints through its own strip viewport
    // instead of the single-frame atlas canvas, so the two are mutually exclusive (otherwise both would paint).
    // Resolved before the atlas branch and consumed by the intent branch below.
    const intentSpec = node.intentFrames;
    const stepsIntent =
      intentSpec != null &&
      intentSpec.frames.length > 1 &&
      paintsAtlasCanvas(node);

    // Atlas-sprite paint: show the node's region out of a decode-once atlas (atlasBaker) instead of a CSS
    // `background-image: url(atlas)` crop of the whole PAGE (which re-decoded up to 16 MP per paint). Three
    // mechanisms, chosen per node on every walk (`record.atlasPaint` records which one is currently mounted):
    //   DIV (default steady state, R10-PERF4 WS-4) — a `background-image` element over the region's BAKED BLOB.
    //     Painted, not composited: this is what takes Canvas×38 down to single digits (and with it the Overlap
    //     promotions the canvases forced). Available only once the blob exists AND has decoded (Stage-C item 2:
    //     the swap is decode-gated, so a mechanism teardown can never leave blank frames while the blob rasters).
    //   PAGE (default placeholder, Stage-C item 1) — a `background-image` element page-cropping the atlas PAGE
    //     itself (gsw's regionBackgroundStyle) while the blob is unbaked/undecoded, the node has gone sticky, or
    //     the baker is suspended. Still no composited layer — the bake-suspended degraded state is all-div now
    //     instead of a canvas fleet.
    //   CANVAS (the tick-blit intent glyph) — the region
    //     drawn into a per-node <canvas>. Always available synchronously once the PAGE is decoded, and the only
    //     mechanism the per-frame intent blit can write to.
    // The element's own size/transform (the keep-aspect fit) is set by nodeStyle either way; the sprite element
    // (inset:0, 100%) fills it, or carries `atlasCanvasPlacement` when the node is INTERIOR — all mechanism-
    // agnostic, so a swap changes only WHAT paints, never WHERE.
    // R10-PERF4 WS-3 (item 3) — THE structural win: under a hidden ancestor, warm the atlas PAGE and stop. 710 of a
    // live scene's 734 atlas canvases were built inside closed dialogs / inactive screens. `preloadAtlas` is the
    // same decode-once request `drawAtlasRegion` would have made (idempotent, one per atlas url for the whole
    // session), so the reveal below is a synchronous `drawImage` — a deferral, never a cold fetch.
    const paintsAtlas = paintsAtlasCanvas(node) && !stepsIntent;
    if (paintsAtlas && deferHiddenLayers && record.atlasPaint === "none") {
      preloadAtlas(node.textureUrl!);
      // STAGE-C item 1: the reveal's placeholder is a page-crop div now, and the page URL doubles as its display
      // source — warm it through the browser's own image cache too (and measure its natural size for the crop),
      // so the reveal's first placeholder frame paints instead of waiting on a CSS background fetch.
      // …but ONLY for a page that will actually be page-cropped (Aug-19). A page over the size gate is never
      // painted as CSS, so this warm would fetch and decode a second ~37MB copy of it — through the browser's
      // image cache this time — for an element that will mount a canvas. `warmImage`'s other job (measuring the
      // natural size for the crop) is moot for the same reason: there is no crop.
      if (atlasPlaceholderMechanism(node.textureUrl!, false) === "page") {
        warmImage(node.textureUrl!);
      }
      // R10-PERF6 WS-P2: while the HATCHERY is pre-building this hidden element, also ask
      // for its region BLOB — with no waiter, so a landing bake never re-styles an invisible node. Gated on
      // `hatching` on purpose: that is the renderer's existing idle path (the hatch drain only runs after the
      // reconciles stop), so a live combat pays nothing, while the map that opens after it finds every region
      // already baked and mounts the layer-free div on its first painted frame. See the switch block.
      if (
        walk.hatching() &&
        node.textureRegion != null
      ) {
        if (
          atlasRegionBlobUrl(node.textureUrl!, node.textureRegion, null) ===
          null
        ) {
          mirrorWalkStats.atlasWarmedRegions++;
        }
      }
    } else if (paintsAtlas) {
      const region = node.textureRegion!;
      const url = node.textureUrl!;
      const key = atlasRegionKey(url, region);
      // MECHANISM CHOICE. The div needs a baked blob; asking for one registers this node for the targeted
      // re-style that swaps it in later (atlasBaker → MirrorView → markTextureDirty). Two nodes never take the
      // div: one whose per-frame intent blit owns a canvas, and one that has already thrashed (sticky — which
      // under Stage C stops the blob CHURN, not the div mechanism: the node settles on the page-crop div).
      const tickBlits = intentSpec != null && intentSpec.frames.length > 1;
      const sticky = record.atlasCanvasReverts >= ATLAS_STICKY_CANVAS_REVERTS;
      // Cache only completed blobs; a miss must keep registering this node for a targeted restyle.
      const memoed =
        record.atlasBlobKey === key
          ? record.atlasBlobUrl
          : null;
      let blobUrl =
        !tickBlits && !sticky
          ? (memoed ?? atlasRegionBlobUrl(url, region, node.id))
          : null;
      if (
        blobUrl !== null &&
        record.atlasBlobKey !== key
      ) {
        record.atlasBlobKey = key;
        record.atlasBlobUrl = blobUrl;
      }
      // STAGE-C item 2 — THE DECODE GATE, at the exact swap commit point. A baked-but-undecoded blob does not
      // count as available: the placeholder stays mounted and the resolve re-styles this node through the same
      // onAtlasRegionsReady chain a landing bake takes. A synchronous resolve (jsdom pass-through / already
      // decoded) is committed inline by the re-check.
      if (blobUrl !== null && !decodedAtlasBlobs.has(blobUrl)) {
        requestAtlasBlobDecode(blobUrl, node.id);
        if (!decodedAtlasBlobs.has(blobUrl)) {
          blobUrl = null;
        }
      }
      // The placeholder half is `placeholderMechanism` (the div valves, then the page's decoded SIZE — see the
      // switch block). A mechanism change REPLACES the sprite element, so it matters that this answer is stable:
      // it is, because a decoded bitmap's size never changes, so the only transition the size gate can produce is
      // the one-way unknown → known upgrade a later walk makes once the page lands.
      const mechanism: "div" | "page" | "canvas" =
        blobUrl !== null ? "div" : atlasPlaceholderMechanism(url, tickBlits);
      // …with ONE caveat the size gate cannot express on its own: "page" chosen because the size is UNKNOWN is a
      // guess, not an answer. Book the re-style that re-asks once the page settles, or a node that never walks
      // again (built hidden during the cold prefetch window) keeps the guess and paints the whole page at reveal.
      // Not folded into `placeholderMechanism`: its other caller (the hidden-ancestor page warm) has no node to
      // register and must not arm anything.
      if (mechanism === "page" && atlasPageSize(url) === null) {
        requestAtlasPageSettle(url, node.id);
      }
      if (record.atlasPaint !== mechanism) {
        // SWAP. Drop the outgoing element and reset the per-element caches — the incoming element is fresh and
        // carries neither the painted region nor the placement styles, so both are re-applied below.
        if (record.atlasPaint === "div" && mechanism !== "div") {
          record.atlasCanvasReverts += 1; // a region change outran its bake (see ATLAS_STICKY_CANVAS_REVERTS)
        }
        frozen.thaw(record.atlasCanvas); // WS-B: the outgoing canvas must not leave its stand-in behind
        record.atlasCanvas?.remove();
        record.atlasCanvas = null;
        record.atlasRegionDiv?.remove();
        record.atlasRegionDiv = null;
        record.atlasKey = null;
        record.atlasBlobKey = null;
        record.atlasBlobUrl = null;
        record.atlasPlacementKey = null;
        record.atlasPageCropSig = null;
        record.atlasPaint = mechanism;
        if (mechanism === "div") {
          record.atlasRegionDiv = document.createElement("div");
          record.atlasRegionDiv.className = "mirror-atlas-region";
        } else if (mechanism === "page") {
          record.atlasRegionDiv = document.createElement("div");
          record.atlasRegionDiv.className = "mirror-atlas-page";
        } else {
          record.atlasCanvas = document.createElement("canvas");
          record.atlasCanvas.className = "mirror-atlas-canvas";
        }
        // Not inserted here — added to `subEls` below so it sits in the correct sub-layer slot (after any
        // behind-parent children) rather than always at el.firstChild.
      }
      const sprite = (record.atlasRegionDiv ?? record.atlasCanvas)!;
      // INTERIOR atlas node: the container el keeps the pure localRect placement (children re-base against it),
      // so the sprite itself carries the region box + stretch/keep-aspect fit that a LEAF bakes into its el
      // transform (nodeStyle's atlas branch). Null placement (leaf, or no fit computable) → the class default
      // (inset:0 stretch over the fit-carrying el).
      const placement = hasChildren ? atlasCanvasPlacement(node) : null;
      const placementKey = placement
        ? `${placement.width}|${placement.height}|${placement.transform}`
        : null;
      if (record.atlasPlacementKey !== placementKey) {
        record.atlasPlacementKey = placementKey;
        if (placement) {
          sprite.style.inset = "0 auto auto 0";
          sprite.style.width = placement.width;
          sprite.style.height = placement.height;
          sprite.style.transform = placement.transform;
          sprite.style.transformOrigin = "0 0";
        } else {
          sprite.style.inset = "";
          sprite.style.width = "";
          sprite.style.height = "";
          sprite.style.transform = "";
          sprite.style.transformOrigin = "";
        }
        frozen.syncStyle(record.atlasCanvas); // WS-B: the still has to move with the box it stands in
      }
      if (mechanism === "page") {
        // PAGE-CROP placeholder paint. The sprite element's own CSS box is the REGION box in both placement cases
        // (a LEAF's element is region-sized with the fit baked into its transform; an INTERIOR node's sprite
        // carries atlasCanvasPlacement's region-sized box), so the crop is the plain fill mapping: gsw's
        // regionBackgroundStyle with box == region ⇒ scale 1, position −region.x/−region.y. The atlas PAGE size
        // arrives asynchronously (warmImage below → onTextureSizesResolved re-style); until then the auto-size
        // branch paints the identical crop at native page scale, so the late rewrite is a no-op by value — the
        // signature exists so a region change (the flicker-free cycler case) rewrites only these three props on a
        // STABLE element, never an element swap. `naturalSize` MISS registers this node for the targeted re-style
        // (the nine-patch-over-atlas idiom).
        const page = naturalSize(url);
        const cropSig = `${key}|${page ? `${page.width}x${page.height}` : "?"}`;
        if (record.atlasPageCropSig !== cropSig) {
          record.atlasPageCropSig = cropSig;
          record.atlasKey = key;
          // LAYOUT SPACE (stageFit.ts): gsw derives `backgroundSize`/`backgroundPosition` from `box / texture`, so
          // handing it the box in the space the div is actually laid out in (`inset: 0` of a display-px element)
          // scales the blown-up page and its offset together — which is what keeps the crop registered. `atlasSize`
          // stays the page's true natural size: it is source pixels, and the source never moves.
          const crop = regionBackgroundStyle(region, {
            atlasSize: page ?? undefined,
            box: { width: px(region.width), height: px(region.height) },
          });
          const div = record.atlasRegionDiv!;
          div.style.backgroundImage = `url("${url}")`;
          div.style.backgroundPosition = crop.backgroundPosition;
          div.style.backgroundSize = crop.backgroundSize;
        }
      } else if (record.atlasKey !== key) {
        record.atlasKey = key;
        if (mechanism === "div") {
          record.atlasRegionDiv!.style.backgroundImage = `url("${blobUrl}")`;
        } else {
          const canvas = record.atlasCanvas!;
          frozen.noteRepaint(canvas); // WS-B: a new region invalidates any still standing in for this canvas
          const w = Math.max(1, Math.round(region.width));
          const h = Math.max(1, Math.round(region.height));
          if (canvas.width !== w) canvas.width = w;
          if (canvas.height !== h) canvas.height = h;
          // CPU-BACKED: the blit source is a whole atlas page, so a GPU-backed target
          // would make `drawImage` upload that page as a texture — the exact cost the size gate exists to avoid.
          // `willReadFrequently` keeps the backing store on the CPU (atlasBakeWorker.ts uses it for the same
          // reason, one process over). NOTE the tick-blit intent glyph writes to THIS element too (advanceIntent),
          // and a canvas's context attributes are fixed by the FIRST getContext — so whichever of the two paths
          // draws first decides. That is why the option is only passed here, where the atlas sprite is painted:
          // no other canvas fleet's context is touched.
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (ctx) {
            ctx.clearRect(0, 0, w, h);
            // Redraw once the atlas finishes decoding (first use), but only if this canvas still wants this region.
            drawAtlasRegion(ctx, url, region, () => {
              if (record.atlasKey !== key || !record.atlasCanvas) return;
              frozen.noteRepaint(record.atlasCanvas); // WS-B: the atlas landed LATE — the still is now stale
              const c = record.atlasCanvas.getContext("2d", { willReadFrequently: true });
              if (c) {
                c.clearRect(
                  0,
                  0,
                  record.atlasCanvas.width,
                  record.atlasCanvas.height,
                );
                drawAtlasRegion(c, url, region, () => {});
              }
            });
          }
        }
      }
    } else if (record.atlasPaint !== "none") {
      record.atlasCanvas?.remove();
      record.atlasCanvas = null;
      record.atlasRegionDiv?.remove();
      record.atlasRegionDiv = null;
      record.atlasKey = null;
      record.atlasBlobKey = null;
      record.atlasBlobUrl = null;
      record.atlasPlacementKey = null;
      record.atlasPageCropSig = null;
      record.atlasPaint = "none";
    }

    // Owns tick/compositor choice, image upgrade and phase anchoring; the viewport remains in this record's
    // existing sub-layer slot below, so paint ordering is unchanged.
    intentTimeline.update(record, node, stepsIntent, hasChildren);

    // LINE2D STROKE PAINT — the map quill annotations. A `Line2D` streams no localRect, no texture rect and no text:
    // its ENTIRE appearance is points + width + colour, so it gets this sub-layer and nothing else paints it.
    //
    // GEOMETRY. `drawBox` is ZERO_ORIGIN for a line node, so the node's element bakes the streamed matrix at local
    // (0,0) — which makes the svg's user space IDENTICAL to the node's local space, i.e. the DrawViewport space the
    // producer streams the points in. The raw values therefore land as-is (the coordinate system is y-down, so no flip) and
    // the viewport's own x2 fit rides the node transform like any other node's. NEVER position or size the svg from
    // the points' bounding box: appending a point to a growing stroke would move that box's origin and the whole
    // stroke would visibly slide. Hence a 1px svg anchored at 0,0 with `overflow: visible` and NO viewBox.
    //
    // UPDATE COST. An actively-drawn stroke re-ships its whole array ~30x/s. Keying on the producer's own change
    // signature (`count|last|width|colour|eraser`) and writing only ATTRIBUTES on a STABLE element keeps that to a
    // few string writes per delta — an element rebuild per frame is exactly what this must not do.
    // A CARD TRAIL is never painted from wire geometry, even if a producer hands us some. The scoped producer
    // ships none, but an OLDER host — or one run with `SPIRECTL_SCENE_WATCH_LINE2D_GEOMETRY=all` — still does, and
    // stroking that raw point array is exactly the thick solid bar the synthesis replaces. Without this guard the
    // two would draw on top of each other.
    const linePoints = isCardTrailNode(node) ? null : node.linePoints;
    if (linePoints != null && !(deferHiddenLayers && !record.lineDiv)) {
      if (!record.lineDiv) {
        const div = document.createElement("div");
        div.className = "mirror-line";
        const svg = document.createElementNS(SVG_NS, "svg");
        // Inline (not CSS): an <svg>'s UA default is `overflow: hidden`, which would clip the stroke to the 1px box.
        svg.setAttribute("width", "1");
        svg.setAttribute("height", "1");
        svg.style.overflow = "visible";
        // An <svg> is inline-level by default, so inside the zero-box wrapper its BASELINE alignment adds one
        // line-box of downward offset (16 node-local px at the default font-size — ×2 under the map viewport fit,
        // Tier-3 measured the stroke 33 screen px low against the host frame). Block display pins it at exactly
        // the wrapper's (0,0), which is what makes SVG user space equal node-local space.
        svg.style.display = "block";
        const polyline = document.createElementNS(SVG_NS, "polyline");
        // Constant on both authored stroke scenes (map_line_draw.tscn / _erase.tscn) — hard-coded, never streamed.
        polyline.setAttribute("fill", "none");
        polyline.setAttribute("stroke-linejoin", "round");
        polyline.setAttribute("stroke-linecap", "round");
        svg.appendChild(polyline);
        div.appendChild(svg);
        record.lineDiv = div;
        record.linePolyline = polyline;
        record.lineSig = null;
      }
      // An eraser needs no wire field of its own: it is exactly the stroke whose shader is line_erase.gdshader
      // (blend_sub, drawn INSIDE the DrawViewport so it subtracts ink). Texturing the pen's chalk trail is a
      // known, deliberate fidelity gap — not attempted.
      const eraser = isLineEraser(node);
      const color = node.lineColor;
      const width = node.lineWidth ?? DEFAULT_LINE_WIDTH;
      const count = linePoints.length;
      const last =
        count >= 2 ? `${linePoints[count - 2]},${linePoints[count - 1]}` : "";
      // The owner whose mask this stroke joins: the player's MapDrawing element, i.e. the stroke's streamed parent
      // (SubViewport children are flattened onto their nearest CanvasItem ancestor, so every stroke a player draws
      // is a sibling there). Null leaves the stroke outside the mask group.
      const maskOwner =
        node.parentId != null && isMapStrokeNode(node)
          ? node.parentId
          : null;
      const sig = `${count}|${last}|${width}|${color ? color.html : ""}|${eraser ? 1 : 0}|${maskOwner ?? ""}`;
      if (record.lineSig !== sig) {
        record.lineSig = sig;
        const polyline = record.linePolyline!;
        // An EMPTY array is the producer's "stroke cleared" (undo / clear-all) instruction: blank the geometry but
        // KEEP the element — the same node is re-drawn into as soon as the player draws again.
        const pts = count >= 2 ? linePointsAttr(linePoints) : "";
        // A MASK-COMPOSITED eraser paints nothing of its own: its ink lives in the owner's <mask> as a black cut.
        polyline.setAttribute(
          "points",
          maskOwner !== null && eraser ? "" : pts,
        );
        polyline.setAttribute(
          "stroke",
          eraser ? LINE_ERASER_STROKE : (opaqueHtml(color?.html) ?? "#ffffff"),
        );
        // A stroke width is a LENGTH in the same SVG user space the points are in — see `linePointsAttr`.
        polyline.setAttribute("stroke-width", String(px(width)));
        // Alpha rides stroke-opacity, never the stroke colour, so the two can't multiply each other.
        polyline.setAttribute("stroke-opacity", String(color ? color.a : 1));
        if (eraser) {
          record.lineDiv!.setAttribute("data-line-erase", "");
        } else {
          record.lineDiv!.removeAttribute("data-line-erase");
        }

        // Mask bookkeeping. An owner CHANGE (a stroke reparented, or the switch flipped) drops the old
        // registration first, so a stroke is never counted under two MapDrawings.
        lineMasks.updateStroke(
          record.id,
          maskOwner,
          eraser,
          pts,
          linePoints,
          width,
        );
        if (maskOwner === null) polyline.removeAttribute("mask");
      }
    } else if (record.lineDiv) {
      lineMasks.releaseLineMaskStroke(record.id);
      record.lineDiv.remove();
      record.lineDiv = null;
      record.linePolyline = null;
      record.lineSig = null;
    }

    // CARD-TRAIL SYNTHESIS — the comet behind a flying card (see cardTrail.ts for the whole design and for why the
    // geometry is NOT on the wire). Only the ELEMENTS are built here, so the trail takes a deterministic slot in
    // paint order like every other mirror-owned paint; the point history and the ribbon itself are driven from
    // `visit` (which has the parent's global transform) and from the animation loop (which ages the tail out).
    //
    // Same zero-box wrapper + overflow-visible svg trick as the stroke above: `drawBox` is ZERO_ORIGIN for a trail
    // node, so SVG user space IS the node's local space, which for an `NCardTrail` is design/global space.
    if (
      isCardTrailNode(node) &&
      !(deferHiddenLayers && !record.trailDiv)
    ) {
      if (!record.trailDiv) {
        // The two authored profiles differ only by node name; the five per-character trail scenes share both
        // curves and both gradients and vary only in `modulate` (which streams).
        const profile = trailProfile(node.name);
        // R11 B2: a reshuffle builds and tears down 60 of these trees. Take one from the free list when there is
        // one (see acquireTrailScaffold) — they differ only in what is WRITTEN into them.
        const scaffold = trails.acquire(profile.bands.length);
        record.trailDiv = scaffold.div;
        record.trailPaths = scaffold.paths;
        record.trailGradient = scaffold.gradient;
        // The `<stop>` elements come back with the scaffold, but their SIGNATURES do not: the next paint must
        // re-state every one of them for the trail that has just acquired it.
        record.trailStops = scaffold.stops;
        record.trailStopSigs = [];
        record.trailD = "";
        record.trailBandsPainted = 0;
        record.trailGradTailSig = "";
        record.trailGradHeadSig = "";
        record.trailBandOpacitySig = scaffold.bandOpacitySig;
        record.trailProfile = profile;
        // The profile owns its constant band opacity, so write it when acquiring the scaffold.
        trails.syncBandOpacity(record);
      } else if (record.trailProfile !== trailProfile(node.name)) {
        // A pooled element adopted for a DIFFERENT trail (outer↔inner) must not keep the previous profile's band
        // widths — re-resolve and force the next paint to rewrite every band.
        record.trailProfile = trailProfile(node.name);
        record.trailD = "";
        trails.syncBandOpacity(record); // …including the other profile's constant band alphas
      }
    } else if (record.trailDiv) {
      trails.active.delete(record);
      trails.release(record); // R11 B2: detaches it and files it for the next trail (see the pool)
      record.trailDiv = null;
      record.trailPaths = [];
      record.trailGradient = null;
      record.trailStops = [];
      record.trailPoints = null;
      trails.releaseFrame(record); // ditto: no scaffold, no history, no latched space
      record.trailProfile = null;
      record.trailD = "";
    }

    // Particle self-layer (gsw mounts its <canvas> here; the spec rides the OUTER node's data-attrs). Deferred under
    // a hidden ancestor for the same reason as the shader mount point above — the specs attribute gsw keys off is
    // deferred too, so nothing would ever mount into it.
    if (
      particle &&
      !(deferHiddenLayers && !record.particleSelf)
    ) {
      if (!record.particleSelf) {
        record.particleSelf = document.createElement("div");
        record.particleSelf.className = `${SELF_LAYER_CLASS} mirror-particle-self`;
        effects.markParticleDirty();
        spineTimeline.noteDomShapeChanged(); // an effect surface appeared
      }
    } else if (record.particleSelf) {
      record.particleSelf.remove();
      record.particleSelf = null;
      effects.markParticleDirty();
      spineTimeline.noteDomShapeChanged(); // an effect surface left
    }

    // BAKED EFFECT STILL for a BOXLESS effect (bakedEffects.ts): the rarity-glow emitters, while particles are
    // OFF or STATIC. A `GPUParticles2D` streams no `localRect`, so `placementBox` gives it a zero box at its transform
    // origin — a background on the element would have nothing to paint into, and the still has to be its own
    // `<img>` sized and placed in NODE-LOCAL units, exactly like the creature stand-in.
    //
    // Deferred under a hidden ancestor for the same reason as the layers around it: an image decode and a
    // placement for pixels inside a `display:none` subtree, and a reveal re-dirties the node so this runs again.
    syncBakedStill(record, node, deferHiddenLayers);

    // Spine clip self-layer (mirror-managed; NOT a gsw self-layer, so no SELF_LAYER_CLASS — the renderer paints
    // + advances the frames itself off the live track-time signal).
    updateSpineLayer(record, node, deferHiddenLayers);

    // Nine-patch-over-atlas slice spans. R19 6c: laid out across the RENDERED box — `record.spreadW` is this
    // node's wide-screen `renderWidthOverride` (0 when it wasn't stretched), written by `visit` before this runs.
    ninePatch.sync(
      record,
      isNinePatchAtlas(node) ? ninePatchAtlasSlices(node, record.spreadW) : [],
    );

    // Range fill (progress/health bars).
    if (node.range) {
      if (!record.rangeFill) {
        record.rangeFill = document.createElement("div");
        record.rangeFill.className = "mirror-range-fill";
      }
      const width = rangeFillStyle(node).width;
      if (record.rangeWidth !== width) {
        record.rangeFill.style.width = width;
        record.rangeWidth = width;
      }
    } else if (record.rangeFill) {
      record.rangeFill.remove();
      record.rangeFill = null;
      record.rangeWidth = null;
    }

    // Text (rich → innerHTML; plain → textContent).
    if (node.text) {
      if (!record.textDiv) {
        record.textDiv = document.createElement("div");
        record.textDiv.className = "mirror-text";
      }
      applyStyleMap(record.textDiv, textStyle(node), record.textStyleCache);
      if (node.richText) {
        if (!record.textInner || record.textInner.tagName !== "DIV") {
          record.textInner?.remove();
          // The keyframes behind STS2's animated bbcode tags ([sine]/[jitter]/[thinky_dots]). Idempotent and
          // keyed by element id, so the cost is one lookup per rich label built; asking here rather than at boot
          // keeps a lobby that never renders a rich label from carrying the sheet at all.
          ensureRichTextEffectStyles(document);
          record.textInner = document.createElement("div");
          record.textInner.className =
            "godot-scene-node godot-type-RichTextLabel mirror-rich";
          record.textDiv.appendChild(record.textInner);
          record.lastHtml = null;
          record.lastText = null;
        }
        const html = richHtml(node);
        if (record.lastHtml !== html) {
          record.textInner.innerHTML = html;
          record.lastHtml = html;
        }
      } else {
        if (!record.textInner || record.textInner.tagName !== "SPAN") {
          record.textInner?.remove();
          record.textInner = document.createElement("span");
          record.textDiv.appendChild(record.textInner);
          record.lastText = null;
          record.lastHtml = null;
        }
        const text = node.text.text;
        if (record.lastText !== text) {
          record.textInner.textContent = text;
          record.lastText = text;
        }
      }
    } else if (record.textDiv) {
      record.textDiv.remove();
      record.textDiv = null;
      record.textInner = null;
      record.lastText = null;
      record.lastHtml = null;
      record.textStyleCache.clear();
    }

    // Position sub-elements in paint order: they sit AFTER any behind-parent children (which draw behind the
    // node's own paint) and BEFORE the normal children. The self-paint / anim / atlas layers are the node's own
    // background — keep them BACKMOST; the spine clip (character's body) is next so any co-located text/range
    // paints over it; text last.
    // The node's OWN mirror-rendered paint, in back-to-front order.
    const paintEls: HTMLElement[] = [];
    // The intent STRIP viewport stands exactly where the single-frame atlas canvas stands (they are mutually
    // exclusive — see `stepsIntent`), so it takes the same slot in paint order.
    if (record.intentView) {
      paintEls.push(record.intentView);
    } else if (record.atlasRegionDiv) {
      paintEls.push(record.atlasRegionDiv);
    } else if (record.atlasCanvas) {
      paintEls.push(record.atlasCanvas);
    }
    // The stroke's svg: after the node's own sprite paint (a Line2D has none, but the slot must be deterministic),
    // before the spine clip — the same "own background" band every other mirror-owned paint sits in.
    if (record.lineDiv) {
      paintEls.push(record.lineDiv);
    }
    // The synthesized card trail takes the same slot as the stroke svg (they are mutually exclusive — a node is
    // either a map stroke or an NCardTrail, never both).
    if (record.trailDiv) {
      paintEls.push(record.trailDiv);
    }
    // The baked effect still takes the slot the effect's own surface would have had: in the node's own background
    // band, in front of its sprite paint and behind the spine clip. It is mutually exclusive with the gsw canvas
    // it replaces (it only exists while that family is OFF, which is exactly when no canvas is mounted), so the
    // order only has to be deterministic.
    if (record.bakedStillImg) {
      paintEls.push(record.bakedStillImg);
    }
    if (record.spineLayer) {
      paintEls.push(record.spineLayer);
    }
    // The creature stand-in takes the slot immediately IN FRONT of the clip layer it substitutes for. The two are
    // never up at the same time (see creaturePlaceholder.ts), so the order only has to be deterministic — and on
    // the hard-off tier there is no clip layer at all, which is why this is its own slot rather than a swap.
    if (record.placeholderImg) {
      paintEls.push(record.placeholderImg);
    }
    for (const span of record.npSlices) {
      paintEls.push(span);
    }
    if (record.rangeFill) {
      paintEls.push(record.rangeFill);
    }
    if (record.textDiv) {
      paintEls.push(record.textDiv);
    }
    // R10-PERF6 WS-B: a FROZEN canvas keeps its slot (it is only `display:none`) and its stand-in `<img>` rides
    // immediately behind it, so every ordering pass — this one, applyChildOrder, the targeted reorder — carries
    // the pair together and the still lands exactly where the canvas painted. Costs nothing while nothing is
    // frozen, which is every walk outside an open overlay.
    if (frozen.canvases.size > 0) {
      for (let i = paintEls.length - 1; i >= 0; i--) {
        const snap = frozen.canvases.get(paintEls[i] as HTMLCanvasElement);
        if (snap) {
          paintEls.splice(i + 1, 0, snap.img);
        }
      }
    }

    // Self-paint layer (INTERIOR nodes: selfLayerPaint != null). The node's own tint filter / self_modulate alpha
    // / background paint must apply to ALL its own paint but NEVER cascade onto the DOM-nested children — so the
    // paint sub-layers nest INSIDE this layer (one group, exactly like the flat model's single element carrying
    // paint + filter + opacity), while scene children stay siblings of it. The wrapper exists whenever the node
    // has own paint styling OR paint sub-layers (a pure grouping wrapper costs nothing and keeps the DOM shape
    // stable when a tint/fade appears later). gsw-owned mounts (shader/particle canvases) stay direct children —
    // their runtimes anchor to the attribute-carrying element.
    const needSelfLayer =
      selfLayerPaint != null &&
      (paintEls.length > 0 || Object.keys(selfLayerPaint).length > 0);
    const subEls: HTMLElement[] = [];
    // The node's own paint GROUP: the self-layer wrapper if it needs one, else the bare paint sub-layers. Held
    // apart from `subEls` because a pinned rotation/glow loop nests the whole group inside animSelf (below).
    const paintGroup: HTMLElement[] = [];
    if (needSelfLayer) {
      if (!record.selfLayer) {
        record.selfLayer = document.createElement("div");
        record.selfLayer.className = "mirror-clip-self"; // NOT SELF_LAYER_CLASS: gsw runtimes query that class
      }
      // While a self_modulate fade owns this layer's opacity (item C), PIN it to the tween endpoint (mirror of
      // pinTween): the self-paint layer is where selfAlpha lives, so we write the pinned value + transition here
      // instead of the freshly-cascaded selfAlpha and never restart the fade. selfLayer is created lazily, so this
      // is the DURABLE home of the pin (armTweenSelfOpacity also writes it directly when the layer exists).
      if (
        record.tweenSelfOpacityUntil !== 0 &&
        record.tweenSelfOpacityUntil > walk.now() &&
        record.tweenSelfOpacity != null
      ) {
        selfLayerPaint!.opacity = record.tweenSelfOpacity;
        record.selfLayer.style.transition =
          record.tweenSelfOpacityTransition ?? "";
      }
      applyStyleMap(record.selfLayer, selfLayerPaint!, record.selfLayerStyle);
      for (let i = 0; i < paintEls.length; i++) {
        const ref = record.selfLayer.children[i] ?? null;
        if (ref !== paintEls[i]) {
          record.selfLayer.insertBefore(paintEls[i], ref);
        }
      }
      paintGroup.push(record.selfLayer);
    } else {
      if (record.selfLayer) {
        // Interior → leaf (or paint gone): drop the wrapper; any surviving paint els re-attach directly below.
        record.selfLayer.remove();
        record.selfLayer = null;
        record.selfLayerStyle.clear();
      }
      paintGroup.push(...paintEls);
    }
    // R10-B2: with a pinned rotation/glow loop on animSelf, the paint group nests INSIDE it (taking the group's own
    // backmost slot) so the loop actually moves/fades the pixels — an atlas-sprite node's paint is a <canvas>
    // sub-layer, which would otherwise be animSelf's untouched SIBLING. Unchanged (group and animSelf as siblings,
    // animSelf in FRONT) for the path-keyed bindings, whose paint rides animSelf as a CSS background instead.
    if (record.animSelf && record.animSelfWrapsPaint) {
      for (let i = 0; i < paintGroup.length; i++) {
        const ref = record.animSelf.children[i] ?? null;
        if (ref !== paintGroup[i]) {
          record.animSelf.insertBefore(paintGroup[i], ref);
        }
      }
      subEls.push(record.animSelf);
    } else {
      subEls.push(...paintGroup);
      if (record.animSelf) {
        subEls.push(record.animSelf);
      }
    }
    if (record.shaderSelf) {
      subEls.push(record.shaderSelf);
    }
    if (record.particleSelf) {
      subEls.push(record.particleSelf);
    }
    // Behind-parent children occupy [0, behindCount); the sub-layers follow. On UPDATE passes (where
    // reconcileOrder doesn't run) this keeps them correctly placed; on the STRUCTURAL pass reconcileOrder rebuilds
    // the full [behind, sub-layers, normal] order from record.subLayers.
    const lead = record.behindCount;
    for (let i = 0; i < subEls.length; i++) {
      const ref = el.children[lead + i] ?? null;
      if (ref !== subEls[i]) {
        el.insertBefore(subEls[i], ref);
      }
    }
    record.subLayers = subEls;
  }

  return { update: updateSubLayers };
}
