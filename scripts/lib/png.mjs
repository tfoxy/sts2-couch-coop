// Dependency-free PNG encode/decode for the geoclip harness family (make-geoclip-fixture.mjs writes page
// textures, selftest-geoclip.mjs samples screenshot pixels).
//
// The decoder is lifted from scripts/assert-idle-compositing.mjs, which already had to read Chromium screenshots
// without an npm dependency; this module exists so the two geoclip scripts share one copy instead of growing a
// third and a fourth. Scope is deliberately exactly what those callers need: 8-bit, non-interlaced, colour types
// 0/2/4/6 in, RGBA/RGB out. Anything else throws loudly rather than silently handing back garbage that a pixel
// assert would then "pass" against.

import { deflateSync, inflateSync } from "node:zlib";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buf) {
  let c;
  if (!crc32.table) {
    crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c;
    }
  }
  c = -1;
  for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * Row filtering. `none` writes filter byte 0 on every row — the original behaviour, kept as the DEFAULT so the
 * fixture generator's "same arguments => byte-identical output" contract keeps meaning what it meant.
 *
 * `adaptive` is the standard minimum-sum-of-absolute-differences heuristic (libpng's, PNG spec 12.8): try all five
 * filters on a row, keep the one whose signed bytes sum smallest. It exists for the packed geoclip/1 repacker, whose
 * sheets carry real photographic texture where filter 0 costs ~2x the bytes — a size claim measured with a
 * deliberately bad encoder is not a size claim. It is still fully deterministic: the choice is a pure function of
 * the row and its predecessor.
 */
function filteredRows(width, height, pixels, channels, mode) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  if (mode !== "adaptive") {
    for (let y = 0; y < height; y++) {
      raw[y * (stride + 1)] = 0;
      Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
    }
    return raw;
  }
  const bpp = channels;             // 8-bit only, so "bytes per pixel" is the channel count
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const up = row - stride;
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f <= 4; f++) {
      const out = cand[f];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const x = pixels[row + i];
        const a = i >= bpp ? pixels[row + i - bpp] : 0;
        const b = y > 0 ? pixels[up + i] : 0;
        const c = y > 0 && i >= bpp ? pixels[up + i - bpp] : 0;
        const v =
          f === 0 ? x
            : f === 1 ? x - a
              : f === 2 ? x - b
                : f === 3 ? x - ((a + b) >> 1)
                  : x - paeth(a, b, c);
        const byte = v & 0xff;
        out[i] = byte;
        score += byte < 128 ? byte : 256 - byte;
      }
      if (score < bestScore) { bestScore = score; best = f; }
    }
    raw[y * (stride + 1)] = best;
    cand[best].copy(raw, y * (stride + 1) + 1);
  }
  return raw;
}

function encode(width, height, pixels, channels, colorType, { filter = "none" } = {}) {
  const stride = width * channels;
  if (pixels.length < stride * height) {
    throw new Error(`pixel buffer too small: ${pixels.length} < ${stride * height}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;          // bit depth
  ihdr[9] = colorType;
  const raw = filteredRows(width, height, pixels, channels, filter);
  return Buffer.concat([
    PNG_MAGIC,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

/**
 * @param {Uint8Array} rgba width*height*4, straight (non-premultiplied) alpha.
 * @param {{filter?: "none"|"adaptive"}} [opts] row filtering; "none" (the default) is byte-for-byte what this
 *   module has always written.
 */
export function encodePngRgba(width, height, rgba, opts) {
  return encode(width, height, rgba, 4, 6, opts);
}

/** @param {Uint8Array} rgb width*height*3. */
export function encodePngRgb(width, height, rgb, opts) {
  return encode(width, height, rgb, 3, 2, opts);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decode an 8-bit, non-interlaced PNG (colour types 0/2/3/4/6) to RGBA.
 *
 * Colour type 3 (PALETTE) is in the list because ImageMagick writes one whenever the image happens to fit 256
 * colours — which every labelled evidence stack this repo produces does. Without it the tool that MAKES the
 * evidence cannot read it back.
 *
 * @returns {{width:number, height:number, data:Uint8Array}}
 */
export function decodePng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8;
  let head = null;
  let palette = null;
  let paletteAlpha = null;
  const idat = [];
  while (pos + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(pos);
    const type = buffer.toString("ascii", pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      head = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12]
      };
    } else if (type === "PLTE") palette = Buffer.from(data);
    else if (type === "tRNS") paletteAlpha = Buffer.from(data);
    else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (!head) throw new Error("PNG has no IHDR");
  if (head.bitDepth !== 8 || head.interlace !== 0) {
    throw new Error(`unsupported PNG (bitDepth ${head.bitDepth}, interlace ${head.interlace})`);
  }
  if (head.colorType === 3) {
    if (!palette) throw new Error("palette PNG has no PLTE chunk");
    return decodePalette(head, inflateSync(Buffer.concat(idat)), palette, paletteAlpha);
  }
  const channelsFor = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const channels = channelsFor[head.colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${head.colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const { width, height } = head;
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  let o = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[o++];
    for (let i = 0; i < stride; i++) {
      const x = raw[o + i];
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      cur[i] =
        filter === 0 ? x
          : filter === 1 ? (x + a) & 0xff
            : filter === 2 ? (x + b) & 0xff
              : filter === 3 ? (x + ((a + b) >> 1)) & 0xff
                : (x + paeth(a, b, c)) & 0xff;
    }
    o += stride;
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      if (channels === 1) { out[d] = out[d + 1] = out[d + 2] = cur[s]; out[d + 3] = 255; }
      else if (channels === 2) { out[d] = out[d + 1] = out[d + 2] = cur[s]; out[d + 3] = cur[s + 1]; }
      else if (channels === 3) { out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = 255; }
      else { out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = cur[s + 3]; }
    }
    const swap = prev; prev = cur; cur = swap;
  }
  return { width, height, data: out };
}

/** Colour type 3: one index byte per pixel, unfiltered against the previous row the same way. */
function decodePalette(head, raw, palette, paletteAlpha) {
  const { width, height } = head;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(width);
  let cur = new Uint8Array(width);
  let o = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[o++];
    for (let i = 0; i < width; i++) {
      const x = raw[o + i];
      const a = i >= 1 ? cur[i - 1] : 0;
      const b = prev[i];
      const c = i >= 1 ? prev[i - 1] : 0;
      cur[i] =
        filter === 0 ? x
          : filter === 1 ? (x + a) & 0xff
            : filter === 2 ? (x + b) & 0xff
              : filter === 3 ? (x + ((a + b) >> 1)) & 0xff
                : (x + paeth(a, b, c)) & 0xff;
    }
    o += width;
    for (let x = 0; x < width; x++) {
      const idx = cur[x];
      const d = (y * width + x) * 4;
      out[d] = palette[idx * 3];
      out[d + 1] = palette[idx * 3 + 1];
      out[d + 2] = palette[idx * 3 + 2];
      out[d + 3] = paletteAlpha && idx < paletteAlpha.length ? paletteAlpha[idx] : 255;
    }
    const swap = prev; prev = cur; cur = swap;
  }
  return { width, height, data: out };
}

/** Nearest-neighbour RGBA read at integer pixel (x, y); out-of-bounds reads clamp to the edge. */
export function pixelAt(img, x, y) {
  const px = Math.min(img.width - 1, Math.max(0, Math.round(x)));
  const py = Math.min(img.height - 1, Math.max(0, Math.round(y)));
  const o = (py * img.width + px) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
}
