// The presence guard — the single most important check in the perf harness.
//
// The #1 failure mode of a rendering benchmark is measuring a BLANK PAGE and
// reporting excellent numbers: no content means no paint, no raster and no
// decode, which looks like a spectacular win. So every measured repeat ends
// with a screenshot that must prove the content is actually on screen; a repeat
// whose `sampleHits` is short of its `sampleCount` is reported as a FAILURE and
// never averaged in.
//
// This is a verbatim port of godot-scene-web
// `packages/perf-harness/src/presence.ts` `checkPresence`, so the `presented`
// block this produces means exactly what godot-scene-web's own scenarios report.
// The only deliberate difference: pixels come from this repo's dependency-free
// `scripts/lib/png.mjs` `decodePng` (always RGBA) instead of `sharp`, because the
// consumer frontend has no `sharp`. Point SELECTION is caller-supplied and
// mirror-specific — legitimate, exactly as each godot-scene-web scenario
// declares its own sample points.

import { decodePng } from "./png.mjs";

/**
 * @param {object} options
 * @param {Buffer|Uint8Array} options.pngBuffer     PNG bytes of the post-window screenshot
 * @param {{x:number,y:number}[]} options.samplePoints  expected content centres, in CSS px
 * @param {number} options.devicePixelRatio         fallback CSS->image scale
 * @param {{width:number,height:number}} [options.cssViewport]  the page's own viewport in CSS px;
 *        when given, the CSS->image scale is MEASURED from the screenshot (uniform, the SMALLER of
 *        the two axis ratios) instead of trusting devicePixelRatio — the phone fix, kept even at
 *        DPR 1 so an emulated `--dpr` run still scores honestly.
 * @param {[number,number,number]} [options.background]  page background rgb (default [0x10,0x10,0x14])
 * @param {number} [options.tolerance]   channel delta from background that counts as content (12)
 * @param {number} [options.sampleRadius] half-width in image px of the box sampled per point (2)
 * @returns {{nonEmptyRatio:number,sampleHits:number,sampleCount:number,ok:boolean,
 *            misses:{x:number,y:number}[],outsideViewport:number,
 *            imageSize:{width:number,height:number},scale:{x:number,y:number}}}
 */
export function checkPresence(options) {
  const {
    pngBuffer,
    samplePoints,
    devicePixelRatio,
    cssViewport,
    background = [0x10, 0x10, 0x14],
    tolerance = 12,
    sampleRadius = 2,
  } = options;

  const { width, height, data } = decodePng(
    Buffer.isBuffer(pngBuffer) ? pngBuffer : Buffer.from(pngBuffer),
  );
  const channels = 4; // decodePng always returns RGBA

  const isContent = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const offset = (y * width + x) * channels;
    return (
      Math.abs(data[offset] - background[0]) > tolerance ||
      Math.abs(data[offset + 1] - background[1]) > tolerance ||
      Math.abs(data[offset + 2] - background[2]) > tolerance
    );
  };

  let nonEmpty = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isContent(x, y)) nonEmpty++;
    }
  }

  const ratios = [];
  if (cssViewport && cssViewport.width > 0) ratios.push(width / cssViewport.width);
  if (cssViewport && cssViewport.height > 0) ratios.push(height / cssViewport.height);
  // One uniform scale, from the axis not carrying browser chrome — see presence.ts.
  const uniform = ratios.length > 0 ? Math.min(...ratios) : devicePixelRatio;
  const scale = { x: uniform, y: uniform };

  const misses = [];
  let hits = 0;
  let outsideViewport = 0;
  for (const point of samplePoints) {
    const px = Math.round(point.x * scale.x);
    const py = Math.round(point.y * scale.y);
    if (
      cssViewport
        ? point.x < 0 ||
          point.y < 0 ||
          point.x > cssViewport.width ||
          point.y > cssViewport.height
        : px < 0 || py < 0 || px >= width || py >= height
    ) {
      outsideViewport++;
    }
    let hit = false;
    for (let dy = -sampleRadius; dy <= sampleRadius && !hit; dy++) {
      for (let dx = -sampleRadius; dx <= sampleRadius && !hit; dx++) {
        if (isContent(px + dx, py + dy)) hit = true;
      }
    }
    if (hit) hits++;
    else misses.push(point);
  }

  return {
    nonEmptyRatio: Math.round((nonEmpty / (width * height)) * 10000) / 10000,
    sampleHits: hits,
    sampleCount: samplePoints.length,
    ok: hits === samplePoints.length && samplePoints.length > 0,
    misses: misses.slice(0, 10),
    outsideViewport,
    imageSize: { width, height },
    scale: {
      x: Math.round(scale.x * 10000) / 10000,
      y: Math.round(scale.y * 10000) / 10000,
    },
  };
}
