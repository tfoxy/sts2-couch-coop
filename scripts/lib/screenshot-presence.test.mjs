import assert from "node:assert/strict";
import test from "node:test";

import { encodePngRgba } from "./png.mjs";
import { checkPresence } from "./screenshot-presence.mjs";

const BG = [0x10, 0x10, 0x14];

/** width*height RGBA filled with the page background. */
function blank(width, height) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = BG[0];
    rgba[i * 4 + 1] = BG[1];
    rgba[i * 4 + 2] = BG[2];
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/** paint an opaque white 9x9 block centred on (cx,cy) in image px. */
function paintBlock(rgba, width, height, cx, cy) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const d = (y * width + x) * 4;
      rgba[d] = rgba[d + 1] = rgba[d + 2] = 255;
      rgba[d + 3] = 255;
    }
  }
}

test("a fully-painted screenshot hits every sample point", () => {
  const w = 200;
  const h = 100;
  const rgba = new Uint8Array(w * h * 4).fill(255);
  const png = Buffer.from(encodePngRgba(w, h, rgba));
  const points = [
    { x: 20, y: 20 },
    { x: 100, y: 50 },
    { x: 180, y: 80 },
  ];
  const r = checkPresence({ pngBuffer: png, samplePoints: points, devicePixelRatio: 1 });
  assert.equal(r.sampleHits, 3);
  assert.equal(r.sampleCount, 3);
  assert.ok(r.ok);
  assert.ok(r.nonEmptyRatio > 0.99);
});

test("a pure-background screenshot is rejected (0 hits, not ok)", () => {
  const w = 200;
  const h = 100;
  const png = Buffer.from(encodePngRgba(w, h, blank(w, h)));
  const points = [
    { x: 20, y: 20 },
    { x: 100, y: 50 },
  ];
  const r = checkPresence({ pngBuffer: png, samplePoints: points, devicePixelRatio: 1 });
  assert.equal(r.sampleHits, 0);
  assert.equal(r.sampleCount, 2);
  assert.equal(r.ok, false);
  assert.equal(r.nonEmptyRatio, 0);
  assert.equal(r.misses.length, 2);
});

test("a partly-blank screenshot fails: sampleHits < sampleCount", () => {
  const w = 200;
  const h = 100;
  const rgba = blank(w, h);
  paintBlock(rgba, w, h, 20, 20);
  paintBlock(rgba, w, h, 100, 50);
  // third point (180,80) left blank
  const png = Buffer.from(encodePngRgba(w, h, rgba));
  const points = [
    { x: 20, y: 20 },
    { x: 100, y: 50 },
    { x: 180, y: 80 },
  ];
  const r = checkPresence({ pngBuffer: png, samplePoints: points, devicePixelRatio: 1 });
  assert.equal(r.sampleHits, 2);
  assert.equal(r.ok, false);
});

test("scale is measured from cssViewport, taking the narrower axis", () => {
  // image 600x900, viewport 300x300 CSS px: ratios x=2, y=3 -> uniform 2.
  // a point at CSS (150,150) maps to image (300,300).
  const w = 600;
  const h = 900;
  const rgba = blank(w, h);
  paintBlock(rgba, w, h, 300, 300);
  const png = Buffer.from(encodePngRgba(w, h, rgba));
  const r = checkPresence({
    pngBuffer: png,
    samplePoints: [{ x: 150, y: 150 }],
    devicePixelRatio: 3,
    cssViewport: { width: 300, height: 300 },
  });
  assert.equal(r.scale.x, 2);
  assert.equal(r.sampleHits, 1);
  assert.ok(r.ok);
});

test("points outside the css viewport are counted in outsideViewport", () => {
  const w = 200;
  const h = 100;
  const png = Buffer.from(encodePngRgba(w, h, blank(w, h)));
  const r = checkPresence({
    pngBuffer: png,
    samplePoints: [
      { x: 10, y: 10 },
      { x: 500, y: 10 },
    ],
    devicePixelRatio: 1,
    cssViewport: { width: 200, height: 100 },
  });
  assert.equal(r.outsideViewport, 1);
});

test("an empty sample set is never ok", () => {
  const png = Buffer.from(encodePngRgba(10, 10, new Uint8Array(10 * 10 * 4).fill(255)));
  const r = checkPresence({ pngBuffer: png, samplePoints: [], devicePixelRatio: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.sampleCount, 0);
});
