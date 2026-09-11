// Nine-patch slicing for an ATLAS sprite in the live-tree MIRROR. A Godot NinePatchRect whose texture is an
// AtlasTexture draws a region of a shared atlas PAGE, 9-sliced into its Control box (corners fixed at the
// patch margins, edges/center stretched). CSS `border-image` can't address an atlas sub-region, so the
// mirror paints 9 child spans, each a destination band of the box showing its source slice of the page.
//
// Pure math (no DOM), in two views of ONE decomposition. `ninePatchAtlasQuads` is the core: given the source
// region, patch margins, the destination box and the atlas PAGE size, it returns one src→dst blit per
// non-degenerate patch, in page px / design px. `ninePatchAtlasSlices` frames those same quads as the CSS the DOM
// path paints (band rect + the background-size/position that scales the page so the source slice fills the band).
// A canvas renderer takes the quads; nothing needs to re-derive the band algebra to get them.
//
// `box` is the element's RENDERED box, NOT its streamed 1920-space `localRect`. On a wider-than-16:9 stage the
// anchor algebra hands an anchored SPAN a `renderWidthOverride` and the element is laid out that much wider (see
// nodeStyles' `style.width`), so slicing from the 1920 width would put the right cap `deltaW` px short of the
// element's right edge and stop the stretched middle band early — the caller must pass the widened width.

import type { MirrorMargins, MirrorRect } from "@/mirror/sceneTree";

export interface NinePatchSlice {
  // Destination band rect within the Control box (px).
  left: number;
  top: number;
  width: number;
  height: number;
  // CSS background of the atlas page that frames this slice's source rect into the band.
  backgroundSizeWidth: number;
  backgroundSizeHeight: number;
  backgroundPositionX: number;
  backgroundPositionY: number;
}

// One patch of the 9-slice as a pure BLIT: copy `src` (a rect of the atlas PAGE, in page px) into `dst` (a band of
// the Control box, in design px relative to the box origin), stretching to fit. This is the numeric decomposition
// a canvas renderer wants — it maps 1:1 onto `drawImage(page, src.x, src.y, src.w, src.h, dst.x, dst.y, …)` — and
// it is the core the CSS `NinePatchSlice` below is derived from, so the two can never describe different geometry.
export interface NinePatchQuad {
  dst: { x: number; y: number; w: number; h: number };
  src: { x: number; y: number; w: number; h: number };
}

// The 9-slice decomposition, in page px / design px. Up to 9 quads (a zero patch margin drops its caps, a region or
// a box smaller than its margins drops the middle), in row-major order: top row left→right, then middle, then
// bottom. `page` is not part of the quad algebra at all — it is here for the same guard the CSS twin needs, since
// an atlas whose size hasn't been measured yet has nothing to sample from either way (see nodeStyles: the size
// lands asynchronously and re-styles the node).
export function ninePatchAtlasQuads(
  region: MirrorRect,
  margins: MirrorMargins,
  box: { width: number; height: number }, // the RENDERED box (see the header) — never the raw 1920-space localRect
  page: { width: number; height: number }
): NinePatchQuad[] {
  if (page.width <= 0 || page.height <= 0 || box.width <= 0 || box.height <= 0) {
    return [];
  }
  const { left, top, right, bottom } = margins;
  // [sourceStart, sourceSize] bands in atlas-page px.
  const cols = [
    { s: region.x, n: left },
    { s: region.x + left, n: Math.max(0, region.width - left - right) },
    { s: region.x + region.width - right, n: right }
  ];
  const rows = [
    { s: region.y, n: top },
    { s: region.y + top, n: Math.max(0, region.height - top - bottom) },
    { s: region.y + region.height - bottom, n: bottom }
  ];
  // [destStart, destSize] bands in the Control box.
  const dcols = [
    { d: 0, n: left },
    { d: left, n: Math.max(0, box.width - left - right) },
    { d: box.width - right, n: right }
  ];
  const drows = [
    { d: 0, n: top },
    { d: top, n: Math.max(0, box.height - top - bottom) },
    { d: box.height - bottom, n: bottom }
  ];

  const quads: NinePatchQuad[] = [];
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      const sc = cols[c];
      const sr = rows[r];
      const dc = dcols[c];
      const dr = drows[r];
      // A zero patch margin drops its caps; a region smaller than its margins drops the middle.
      if (sc.n <= 0 || sr.n <= 0 || dc.n <= 0 || dr.n <= 0) {
        continue;
      }
      quads.push({
        dst: { x: dc.d, y: dr.d, w: dc.n, h: dr.n },
        src: { x: sc.s, y: sr.s, w: sc.n, h: sr.n }
      });
    }
  }
  return quads;
}

// The CSS framing of the quads above: same bands, expressed as a background of the WHOLE atlas page scaled so the
// quad's source rect fills the band, then offset to bring the slice origin to 0. The geometry is not recomputed
// here — `dst.w / src.w` IS the `dc.n / sc.n` the band algebra produced, so the two views stay bit-identical.
export function ninePatchAtlasSlices(
  region: MirrorRect,
  margins: MirrorMargins,
  box: { width: number; height: number }, // the RENDERED box (see the header) — never the raw 1920-space localRect
  page: { width: number; height: number }
): NinePatchSlice[] {
  return ninePatchAtlasQuads(region, margins, box, page).map((quad) => {
    const scaleX = quad.dst.w / quad.src.w;
    const scaleY = quad.dst.h / quad.src.h;
    return {
      left: quad.dst.x,
      top: quad.dst.y,
      width: quad.dst.w,
      height: quad.dst.h,
      backgroundSizeWidth: page.width * scaleX,
      backgroundSizeHeight: page.height * scaleY,
      backgroundPositionX: -quad.src.x * scaleX,
      backgroundPositionY: -quad.src.y * scaleY
    };
  });
}
