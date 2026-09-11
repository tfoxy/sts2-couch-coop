// packed-geoclip.mjs — Couch's packed geoclip/1 codec. It accepts the upstream raw bake representation and
// emits the only Couch-published format, packed geoclip/1.
//
// WHY A PACKED OUTPUT. The upstream raw bake is intentionally external and carries every deforming slot as JSON
// (byrdonis idle_loop is a 4.0 MB manifest for 401 frames), and the page textures are the rig's WHOLE atlas pages
// — including the parts this animation never touches and, for the merchant, three entire pages no part references
// numbers. Couch's packed geoclip/1 changes exactly two things and nothing else:
//
//   1. VERTEX TRACKS GO BINARY. Each deforming slot's `verts` array becomes `vref: <record ordinal>` into a
//      side-car `verts.bin` of little-endian u16 pairs, quantised against a per-PART bounding box measured over
//      the whole clip. Colours, transforms and draw orders stay in JSON on purpose: they are short, they gzip
//      well, and a human debugging a bad frame can still read them.
//   2. PAGES BECOME PART SHEETS, WHEN THAT IS ACTUALLY CHEAPER. Every part's `srcRect` can be cropped out of its
//      raw-bake page and shelf-packed into `sheet-<k>.png` (<= 2048 square). The parts' `uvs` are already normalised to
//      `srcRect`, so they do not change — only `pageId` and `srcRect` move, and whatever the rig never used is
//      simply not copied. But a repack is not free (see PACKING ARMS), so it is a decision and not a law.
//
// THE QUANTISATION BOUND IS THE POINT. A u16 across a part's own bbox is worth `range / 65535` px, and a spine
// part's range is its own extent — tens to a few hundred pixels — so the error is 1/100th of a pixel or better.
// That is why the quant box is per PART and not per clip: one giant clip-wide box would spend the whole 16 bits
// on parts that never move. `packGeoclip` reports the measured worst-case bound so a caller can assert it rather
// than trust this paragraph.
//
// PACKING ARMS. `opts.repack` is "auto" (the default), "always" or "never", and what it optimises is DECODED
// TEXTURE AREA — the pixels a decode allocates and the GPU then holds — NOT file bytes. That choice is deliberate:
// a GPU-process OOM is this pipeline's established failure mode on a phone, and a PNG that is 8% smaller does not
// help with it. A shelf pack pays for its win in gutters, a 1px extrusion per crop, and the slack at the end of
// every shelf, so on a rig whose parts already tile their page it plans MORE area than the page it replaced.
// Hence `auto` PLANS FIRST — `planRepack` reads rect sizes, never pixels, so the number is free — and takes the
// repack only when the planned sheet area is strictly less than the REFERENCED page area. "Referenced" is not
// "pages.length === 1": a rig can declare four pages and point every part at one of them, and that rig has a
// large win available that a page-count test would throw away.
//
// PASSTHROUGH IS A BYTE COPY. The referenced pages are written out verbatim under `sheet-<k>.png`, renumbered
// 0..n-1 so the unreferenced ones can be dropped, with every `srcRect` and every uv left exactly where the baker
// put them. No decode/re-encode round trip: that would move the byte count for no reason and would cost the
// "byte-identical to page-<k>.png" claim, which is the cheapest possible proof that no decoder can tell.
//
// SAMPLING SAFETY, AND WHAT IT COSTS. The harness filters LINEAR with CLAMP_TO_EDGE, so a uv of exactly 0 or 1
// samples the texel just OUTSIDE the rect. A repack therefore writes each crop with a 1px EDGE EXTRUSION (its own
// border row/column replicated outward) and points the new `srcRect` at +1, inside that extrusion — a uv of 0 or
// 1 then samples a copy of the part's own edge — and leaves a 2px gutter beyond it so even a badly scaled sampler
// cannot reach a neighbour.
//
// That extrusion is a CHANGE, not a restoration. The upstream raw-bake pages do NOT carry a clean 1px pad around every rect:
// measured over distinct part rects, byrdonis has 23 of 378 same-page pairs overlapping outright (parts 0 and 4
// share two texel columns) and 19 more separated by under a pixel; the merchant has 31 of 903 overlapping and 39
// more under a pixel. So on a real bake the texel outside a rect is frequently a NEIGHBOURING PART, and clamping
// to a replicated edge instead is a genuinely different picture. Measured, it is a small part of the packed-vs-raw
// replay delta and not most of it: replaying byrdonis five ways up, a repacked sheet differs from a passthrough
// one by RMSE 2.8e-5, while BOTH differ from the raw clip by 1.9e-4 — that larger number is the vertex
// quantisation, which neither arm changes. Passthrough has neither extrusion nor gutter and inherits whatever
// edge behaviour the bake itself has. Which of the two shipped is recorded in `manifest.packing.extruded` rather
// than assumed, because that flag is the only way a later consumer — a mip chain, an atlas step, a downscaler —
// can tell whether the 1px guarantee holds for the sheet in front of it.
//
// COUCH PUBLISHED FORMAT (packed geoclip/1), restated as code contracts:
//   dir            manifest.json + sheet-<k>.png + verts.bin
//   meta.schema    "geoclip/1"; everything else in meta is carried over untouched
//   pages[]        the sheets, same {id, file, width, height} shape; ids are 0..n-1 under BOTH arms
//   parts[]        unchanged shape; pageId/srcRect point into the sheets; uvs UNCHANGED
//   packing        {mode:"repack"|"passthrough", extruded, sheetArea, sourceArea, referencedArea,
//                  consideredSheetArea} — which arm ran and the decoded-pixel arithmetic it ran on
//   frames[]       unchanged, except a deforming slot carries `vref: <int>` instead of `verts`
//   vertsBin       {file:"verts.bin", records, offsets:[byte offset per record], quant:{"<partId>":[minX,minY,maxX,maxY]}}
//   verts.bin      record i at offsets[i] is vertCount(part) x 2 u16 LE, interleaved x,y;
//                  dequant: x = minX + q * (maxX - minX) / 65535

import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { decodePng, encodePngRgba } from "./png.mjs";

/** Sheets are capped at 2048 square: the smallest MAX_TEXTURE_SIZE any target of this pipeline reports. */
export const SHEET_MAX = 2048;
/** Empty pixels between two packed blocks, on top of each block's own extrusion. */
export const GUTTER = 2;
/** Border replication around each crop, in px. The new srcRect starts inside it. */
export const EXTRUDE = 1;
/** Quantised vertex tracks are u16, so a part's range is divided into this many steps. */
export const QUANT_STEPS = 65535;

const SHEET_WIDTH_CANDIDATES = [64, 128, 256, 512, 1024, 2048];

// ---------------------------------------------------------------------------------------------------------
// vertex tracks
// ---------------------------------------------------------------------------------------------------------

/** Slot keys in a stable order. They are integer-like strings, so this is also the order JSON gives back. */
function slotKeys(frame) {
  const slots = frame && frame.slots ? frame.slots : {};
  return Object.keys(slots).sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** partId -> vertex count, from the part's own reference vertices (the length a frame's `verts` must match). */
export function vertCountsByPart(manifest) {
  const out = new Map();
  for (const part of manifest.parts ?? []) {
    const ref = Array.isArray(part.refVerts) ? part.refVerts : [];
    out.set(String(part.id), ref.length >> 1);
  }
  return out;
}

/**
 * Walk every frame and pick up the slots that will become records: those whose `verts` is present AND the right
 * length for their part. A wrong-length array is left alone (the player's tolerance rule already covers it and
 * silently re-encoding it would destroy the evidence), and so is a slot pointing at a part we do not know.
 *
 * @returns {{records: Array<{partKey:string, frame:number, slot:string, values:number[]}>, skipped: string[]}}
 */
export function collectVertRecords(manifest) {
  const counts = vertCountsByPart(manifest);
  const records = [];
  const skipped = [];
  const frames = Array.isArray(manifest.frames) ? manifest.frames : [];
  for (let f = 0; f < frames.length; f++) {
    const frame = frames[f];
    for (const key of slotKeys(frame)) {
      const slot = frame.slots[key];
      if (!slot || slot.part == null || !Array.isArray(slot.verts)) continue;
      const partKey = String(slot.part);
      const n = counts.get(partKey);
      if (n === undefined) {
        skipped.push(`frame ${f} slot ${key}: unknown part '${partKey}'`);
        continue;
      }
      if (slot.verts.length !== n * 2) {
        skipped.push(`frame ${f} slot ${key}: ${slot.verts.length >> 1} verts for a ${n}-vertex part`);
        continue;
      }
      records.push({ partKey, frame: f, slot: key, values: slot.verts });
    }
  }
  return { records, skipped };
}

/** The per-part quantisation boxes: [minX, minY, maxX, maxY] over every record of that part in the clip. */
export function measureQuantBoxes(records) {
  const quant = new Map();
  for (const rec of records) {
    let box = quant.get(rec.partKey);
    if (!box) quant.set(rec.partKey, (box = [Infinity, Infinity, -Infinity, -Infinity]));
    const v = rec.values;
    for (let i = 0; i < v.length; i += 2) {
      const x = Number(v[i]);
      const y = Number(v[i + 1]);
      if (x < box[0]) box[0] = x;
      if (x > box[2]) box[2] = x;
      if (y < box[1]) box[1] = y;
      if (y > box[3]) box[3] = y;
    }
  }
  return quant;
}

/**
 * A single value -> u16. A DEGENERATE range (every record puts this coordinate at the same place) encodes as 0,
 * which the dequant formula turns straight back into `lo` — so the encoder needs the special case and a decoder
 * written from the contract does not.
 */
function quantize(value, lo, hi) {
  const range = hi - lo;
  if (!(range > 0)) return 0;
  const q = Math.round(((Number(value) - lo) / range) * QUANT_STEPS);
  return q < 0 ? 0 : q > QUANT_STEPS ? QUANT_STEPS : q;
}

/** The contract's dequant, in one place so the tests and the packer's self-check cannot drift from each other. */
export function dequantize(q, lo, hi) {
  return lo + (q * (hi - lo)) / QUANT_STEPS;
}

/**
 * Encode the records into `verts.bin` bytes plus the manifest's `vertsBin` block.
 *
 * @returns {{bytes: Uint8Array, block: object, vrefs: Map<string, number>, maxError: number, worstPart: string|null}}
 *   `vrefs` is keyed "<frameIndex>/<slotKey>". `maxError` is the largest |original - dequantised| this encode
 *   actually produced, measured rather than predicted.
 */
export function encodeVertsBin(manifest, { file = "verts.bin" } = {}) {
  const { records, skipped } = collectVertRecords(manifest);
  const boxes = measureQuantBoxes(records);

  let total = 0;
  const offsets = [];
  for (const rec of records) {
    offsets.push(total);
    total += rec.values.length * 2;         // u16 per coordinate
  }

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  const vrefs = new Map();
  let maxError = 0;
  let worstPart = null;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const box = boxes.get(rec.partKey);
    let o = offsets[i];
    for (let k = 0; k < rec.values.length; k += 2) {
      const qx = quantize(rec.values[k], box[0], box[2]);
      const qy = quantize(rec.values[k + 1], box[1], box[3]);
      view.setUint16(o, qx, true); o += 2;
      view.setUint16(o, qy, true); o += 2;
      const ex = Math.abs(dequantize(qx, box[0], box[2]) - Number(rec.values[k]));
      const ey = Math.abs(dequantize(qy, box[1], box[3]) - Number(rec.values[k + 1]));
      const e = Math.max(ex, ey);
      if (e > maxError) { maxError = e; worstPart = rec.partKey; }
    }
    vrefs.set(`${rec.frame}/${rec.slot}`, i);
  }

  const quant = {};
  for (const [partKey, box] of [...boxes.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    quant[partKey] = box;
  }
  const block = { file, records: records.length, offsets, quant };
  const bound = [...boxes.values()].reduce(
    (m, b) => Math.max(m, (b[2] - b[0]) / QUANT_STEPS, (b[3] - b[1]) / QUANT_STEPS), 0);
  return { bytes, block, vrefs, maxError, worstPart, bound, skipped };
}

/**
 * packed geoclip/1 manifest + verts.bin bytes -> the raw-shaped clip the offline oracle renders: every `vref` becomes a plain
 * `verts` number array (plain, not typed — the player's dispatch is `Array.isArray`).
 *
 * Unresolvable references are REPORTED and left out rather than faked: a slot whose record is short, or whose
 * part is unknown, comes back with neither `verts` nor `vref`, which the player then draws through its xform /
 * refVerts fallback exactly as the tolerance rules say.
 */
export function decodePackedGeoclip(manifest, bytes, { onWarn = null } = {}) {
  const warn = (m) => { if (onWarn) onWarn(m); };
  const bin = manifest && manifest.vertsBin;
  const counts = vertCountsByPart(manifest);
  const quant = bin && bin.quant ? bin.quant : {};
  const offsets = bin && Array.isArray(bin.offsets) ? bin.offsets : [];
  const buf = bytes ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;

  const frames = (Array.isArray(manifest.frames) ? manifest.frames : []).map((frame, f) => {
    const slots = {};
    let touched = false;
    for (const key of Object.keys(frame.slots ?? {})) {
      const slot = frame.slots[key];
      if (!slot || !Number.isInteger(slot.vref)) { slots[key] = slot; continue; }
      touched = true;
      const { vref, ...rest } = slot;
      const partKey = String(slot.part);
      const n = counts.get(partKey);
      const box = quant[partKey];
      const at = offsets[vref];
      if (n === undefined || !Array.isArray(box) || box.length < 4 || !Number.isFinite(at) || !buf) {
        warn(`frame ${f} slot ${key}: vref ${vref} cannot be resolved (part '${partKey}')`);
        slots[key] = rest;
        continue;
      }
      if (at + n * 4 > buf.byteLength) {
        warn(`frame ${f} slot ${key}: vref ${vref} runs past the end of verts.bin`);
        slots[key] = rest;
        continue;
      }
      const verts = new Array(n * 2);
      for (let i = 0; i < n; i++) {
        verts[i * 2] = dequantize(buf.getUint16(at + i * 4, true), box[0], box[2]);
        verts[i * 2 + 1] = dequantize(buf.getUint16(at + i * 4 + 2, true), box[1], box[3]);
      }
      slots[key] = { ...rest, verts };
    }
    return touched ? { ...frame, slots } : frame;
  });

  return { ...manifest, frames };
}

// ---------------------------------------------------------------------------------------------------------
// part sheets
// ---------------------------------------------------------------------------------------------------------

/**
 * Shelf-pack blocks (crop + extrusion) into sheets of a fixed width, tallest first.
 *
 * Returns null when the width cannot hold the widest block, so the caller can just try the next candidate.
 * Sheets are trimmed to what they actually used, which is why a clip with three little parts gets a 100px sheet
 * and not a 2048px one full of nothing.
 */
export function shelfPack(items, { width, maxSize = SHEET_MAX, gutter = GUTTER, extrude = EXTRUDE } = {}) {
  const sorted = [...items].sort((a, b) =>
    (b.h - a.h) || (b.w - a.w) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const sheets = [];
  let sheet = null;
  let penX = 0;
  let shelfY = 0;
  let shelfH = 0;
  const newSheet = () => { sheet = { placements: [], width: 0, height: 0 }; sheets.push(sheet); penX = 0; shelfY = 0; shelfH = 0; };
  newSheet();
  for (const it of sorted) {
    const bw = it.w + extrude * 2;
    const bh = it.h + extrude * 2;
    if (bw > width || bh > maxSize) return null;
    if (penX !== 0 && penX + bw > width) { shelfY += shelfH + gutter; shelfH = 0; penX = 0; }
    if (shelfY + bh > maxSize) newSheet();
    const placement = { ...it, sheet: sheets.length - 1, x: penX, y: shelfY, blockW: bw, blockH: bh };
    sheet.placements.push(placement);
    sheet.width = Math.max(sheet.width, penX + bw);
    sheet.height = Math.max(sheet.height, shelfY + bh);
    penX += bw + gutter;
    shelfH = Math.max(shelfH, bh);
  }
  return sheets;
}

/** Try the candidate widths and keep the plan with the fewest sheets, then the least total sheet area. */
export function planSheets(items, opts = {}) {
  const maxSize = opts.maxSize ?? SHEET_MAX;
  const widths = [...new Set([...SHEET_WIDTH_CANDIDATES.filter((w) => w < maxSize), maxSize])];
  let best = null;
  for (const width of widths) {
    const sheets = shelfPack(items, { ...opts, width });
    if (!sheets) continue;
    const area = sheets.reduce((n, s) => n + s.width * s.height, 0);
    if (!best || sheets.length < best.sheets.length || (sheets.length === best.sheets.length && area < best.area)) {
      best = { sheets, area, width };
    }
  }
  if (!best) throw new Error(`a part's srcRect does not fit a ${opts.maxSize ?? SHEET_MAX}px sheet`);
  return best;
}

/** Read a rect out of a decoded page, clamping reads to the page edge so the rect's SIZE is always preserved. */
function cropFrom(page, x0, y0, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(page.height - 1, Math.max(0, y0 + y));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(page.width - 1, Math.max(0, x0 + x));
      const s = (sy * page.width + sx) * 4;
      const d = (y * w + x) * 4;
      out[d] = page.data[s];
      out[d + 1] = page.data[s + 1];
      out[d + 2] = page.data[s + 2];
      out[d + 3] = page.data[s + 3];
    }
  }
  return out;
}

/** Blit a crop into a sheet at (x+1, y+1) and replicate its border outward by one pixel. */
function blitWithExtrusion(sheet, sheetW, crop, w, h, x, y, extrude = EXTRUDE) {
  const put = (dx, dy, src, so) => {
    const d = (dy * sheetW + dx) * 4;
    sheet[d] = src[so];
    sheet[d + 1] = src[so + 1];
    sheet[d + 2] = src[so + 2];
    sheet[d + 3] = src[so + 3];
  };
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) put(x + extrude + cx, y + extrude + cy, crop, (cy * w + cx) * 4);
  }
  for (let e = 0; e < extrude; e++) {
    for (let cx = 0; cx < w; cx++) {
      put(x + extrude + cx, y + e, crop, cx * 4);                              // top
      put(x + extrude + cx, y + extrude + h + e, crop, ((h - 1) * w + cx) * 4); // bottom
    }
    for (let cy = 0; cy < h; cy++) {
      put(x + e, y + extrude + cy, crop, cy * w * 4);                           // left
      put(x + extrude + w + e, y + extrude + cy, crop, (cy * w + (w - 1)) * 4); // right
    }
  }
  for (let ey = 0; ey < extrude; ey++) {
    for (let ex = 0; ex < extrude; ex++) {
      put(x + ex, y + ey, crop, 0);
      put(x + extrude + w + ex, y + ey, crop, (w - 1) * 4);
      put(x + ex, y + extrude + h + ey, crop, (h - 1) * w * 4);
      put(x + extrude + w + ex, y + extrude + h + ey, crop, ((h - 1) * w + (w - 1)) * 4);
    }
  }
}

/**
 * The PLAN half of a repack: which distinct rects exist, and where a shelf pack would put them. It reads the
 * manifest and the page SIZES — no pixel is touched and no sheet is allocated — which is what makes `auto`
 * affordable: `packGeoclip` can price a repack and then decline to pay for it.
 *
 * Parts that share a rect on the same page (a mirrored pair of attachments, say) share ONE packed block: which
 * blocks exist is invisible to a player, so the dedupe costs nothing and the merchant's two identical 33x39
 * rects stop being copied twice.
 *
 * @param {object} manifest a geoclip/1 manifest
 * @param {Map<string, {width:number,height:number,data:Uint8Array}>} pages decoded page pixels by page id
 * @returns {{items: Map, rectByPart: Map<string,string>, plan: {sheets: object[], width: number, area: number},
 *   extrude: number}}
 */
export function planRepack(manifest, pages, opts = {}) {
  const extrude = opts.extrude ?? EXTRUDE;
  const items = new Map();
  const rectByPart = new Map();
  for (const part of manifest.parts ?? []) {
    const pageKey = String(part.pageId);
    const page = pages.get(pageKey);
    if (!page) throw new Error(`part '${part.id}' references unknown pageId '${part.pageId}'`);
    const sr = Array.isArray(part.srcRect) && part.srcRect.length >= 4
      ? part.srcRect.map(Number)
      : [0, 0, page.width, page.height];
    const rect = [Math.round(sr[0]), Math.round(sr[1]), Math.max(1, Math.round(sr[2])), Math.max(1, Math.round(sr[3]))];
    const key = `${pageKey}|${rect.join(",")}`;
    if (!items.has(key)) items.set(key, { key, pageKey, rect, w: rect[2], h: rect[3] });
    rectByPart.set(String(part.id), key);
  }

  // A clip with no parts is degenerate but not an error (an animation whose slots never resolved, say) — it packs
  // to zero sheets rather than to one zero-by-zero PNG that no decoder can read.
  const plan = items.size ? planSheets([...items.values()], { ...opts, extrude }) : { sheets: [], width: 0, area: 0 };
  return { items, rectByPart, plan, extrude };
}

/**
 * Repack every part's srcRect into sheets: the blit half. Pass `opts.plan` (a `planRepack` result) to reuse a plan
 * that has already been measured rather than shelf-packing the same rects twice.
 *
 * @param {object} manifest a geoclip/1 manifest
 * @param {Map<string, {width:number,height:number,data:Uint8Array}>} pages decoded page pixels by page id
 */
export function repackParts(manifest, pages, opts = {}) {
  const { rectByPart, plan, extrude } = opts.plan ?? planRepack(manifest, pages, opts);
  const placementByKey = new Map();
  const sheets = plan.sheets.map((s, index) => {
    const data = new Uint8Array(s.width * s.height * 4);   // transparent black; the gutters stay this way
    for (const p of s.placements) {
      const page = pages.get(p.pageKey);
      const crop = cropFrom(page, p.rect[0], p.rect[1], p.w, p.h);
      blitWithExtrusion(data, s.width, crop, p.w, p.h, p.x, p.y, extrude);
      placementByKey.set(p.key, { sheet: index, x: p.x + extrude, y: p.y + extrude, w: p.w, h: p.h });
    }
    return { id: index, file: `sheet-${index}.png`, width: s.width, height: s.height, data };
  });

  const parts = (manifest.parts ?? []).map((part) => {
    const at = placementByKey.get(rectByPart.get(String(part.id)));
    return { ...part, pageId: at.sheet, srcRect: [at.x, at.y, at.w, at.h] };
  });

  return { sheets, parts, blocks: placementByKey.size, sheetWidth: plan.width };
}

/**
 * The other arm: the page IS the sheet. Same `{sheets, parts, blocks, sheetWidth}` shape as `repackParts`, so
 * `packGeoclip` chooses between the two and nothing downstream has to know which ran.
 *
 * The ONLY thing that moves is the page numbering. Pages no part references are dropped (that part of the win is
 * free — it copies no pixels and loses none), the survivors are renumbered 0..n-1 to match their `sheet-<k>.png`
 * names, and `parts[].pageId` is remapped through the same table. Every `srcRect` and every uv is passed through
 * verbatim, so there is nothing here that can move a texel.
 *
 * `sheets[].bytes` carries the ORIGINAL file when `readPages` supplied one, which is how `packGeoclipDir` writes
 * a byte copy instead of re-encoding pixels it did not change. `width`/`height` are the DECODED size, because
 * that is the size every decoder in this pipeline folds `srcRect` against (both the harness and the frontend
 * player warn about a manifest that disagrees and then use the decoded number anyway).
 *
 * @param {object} manifest a geoclip/1 manifest
 * @param {Map<string, {width:number,height:number,data:Uint8Array,bytes?:Buffer}>} pages decoded pages by page id
 */
export function passthroughParts(manifest, pages) {
  const parts = manifest.parts ?? [];
  const referenced = new Set();
  const rects = new Set();
  for (const part of parts) {
    const pageKey = String(part.pageId);
    if (!pages.has(pageKey)) throw new Error(`part '${part.id}' references unknown pageId '${part.pageId}'`);
    referenced.add(pageKey);
    rects.add(`${pageKey}|${JSON.stringify(part.srcRect ?? null)}`);
  }

  const sheetIdByPage = new Map();
  const sheets = [];
  for (const page of manifest.pages ?? []) {
    const pageKey = String(page.id);
    if (!referenced.has(pageKey) || sheetIdByPage.has(pageKey)) continue;
    const img = pages.get(pageKey);
    const id = sheets.length;
    sheetIdByPage.set(pageKey, id);
    sheets.push({ id, file: `sheet-${id}.png`, width: img.width, height: img.height, data: img.data, bytes: img.bytes ?? null });
  }

  return {
    sheets,
    parts: parts.map((part) => ({ ...part, pageId: sheetIdByPage.get(String(part.pageId)) })),
    blocks: rects.size,
    sheetWidth: sheets.reduce((n, s) => Math.max(n, s.width), 0)
  };
}

// ---------------------------------------------------------------------------------------------------------
// pack
// ---------------------------------------------------------------------------------------------------------

/** The values `opts.repack` accepts. `auto` measures; the other two are overrides for a caller who knows better. */
export const REPACK_MODES = ["auto", "always", "never"];

/**
 * The pure half: an upstream raw bake + its decoded pages -> Couch's packed geoclip/1 manifest, sheet pixels and verts.bin.
 * Everything the input carried that this format does not speak for (a baker's `diagnostics` block, say) is passed
 * through untouched.
 */
export function packGeoclip(manifest, pages, opts = {}) {
  const schema = manifest?.meta?.schema;
  if (schema && String(schema) !== "geoclip/1") {
    throw new Error(`expected a geoclip/1 manifest, got '${schema}'`);
  }
  const mode = opts.repack ?? "auto";
  if (!REPACK_MODES.includes(mode)) {
    throw new Error(`repack must be one of ${REPACK_MODES.join("|")}, got '${mode}'`);
  }

  // The two areas the decision is made on, both in DECODED pixels. `sourceArea` is every page the manifest
  // declares (what a raw-bake consumer pays); `referencedArea` is only the pages some part points at, which is what a
  // passthrough would actually ship — dropping the rest is a win no repack is needed for.
  const referencedPages = new Set((manifest.parts ?? []).map((p) => String(p.pageId)));
  let sourceArea = 0;
  let referencedArea = 0;
  for (const [key, page] of pages) {
    sourceArea += page.width * page.height;
    if (referencedPages.has(key)) referencedArea += page.width * page.height;
  }

  // Plan before choosing. `never` skips even the plan: it is the escape hatch for a rig whose rects `planSheets`
  // would refuse (a part wider than the sheet cap throws), so it must not depend on planning succeeding.
  const planned = mode === "never" ? null : planRepack(manifest, pages, opts);
  const consideredSheetArea = planned ? planned.plan.area : null;
  const chosen = mode === "always" ? "repack"
    : mode === "never" ? "passthrough"
      : consideredSheetArea < referencedArea ? "repack" : "passthrough";

  const { sheets, parts, blocks, sheetWidth } = chosen === "repack"
    ? repackParts(manifest, pages, { ...opts, plan: planned })
    : passthroughParts(manifest, pages);
  const sheetArea = sheets.reduce((n, s) => n + s.width * s.height, 0);
  const packing = {
    mode: chosen,
    extruded: chosen === "repack" && (opts.extrude ?? EXTRUDE) > 0,
    sheetArea,
    sourceArea,
    referencedArea,
    consideredSheetArea
  };
  const verts = encodeVertsBin(manifest);

  const { meta, pages: _oldPages, parts: _oldParts, frames: _oldFrames, ...rest } = manifest;
  const frames = (Array.isArray(manifest.frames) ? manifest.frames : []).map((frame, f) => {
    const slots = {};
    for (const key of Object.keys(frame.slots ?? {})) {
      const slot = frame.slots[key];
      const vref = verts.vrefs.get(`${f}/${key}`);
      if (vref === undefined) { slots[key] = slot; continue; }
      const { verts: _dropped, ...withoutVerts } = slot;
      slots[key] = { ...withoutVerts, vref };
    }
    return { ...frame, slots };
  });

  const out = {
    meta: { ...meta, schema: "geoclip/1" },
    pages: sheets.map((s) => ({ id: s.id, file: s.file, width: s.width, height: s.height })),
    parts,
    packing,
    vertsBin: verts.block,
    frames,
    ...rest
  };

  return {
    manifest: out,
    sheets,
    verts,
    stats: {
      mode: chosen,
      parts: parts.length,
      blocks,
      sheets: sheets.length,
      sheetWidth,
      sheetArea,
      sourceArea,
      referencedArea,
      consideredSheetArea,
      records: verts.block.records,
      vertBytes: verts.bytes.length,
      quantBound: verts.bound,
      quantMaxError: verts.maxError,
      quantWorstPart: verts.worstPart,
      skipped: verts.skipped
    }
  };
}

/**
 * Decode every page a manifest declares, keyed by page id. The DECODED size wins, as in the player.
 *
 * The raw file rides along as `bytes` so a passthrough can copy it rather than re-encode pixels it did not touch:
 * a decode/re-encode round trip would move the byte count for no reason and would cost the "byte-identical to
 * page-<k>.png" claim that makes the passthrough arm cheap to test.
 */
export function readPages(dir, manifest) {
  const pages = new Map();
  for (const page of manifest.pages ?? []) {
    const bytes = readFileSync(resolve(dir, page.file));
    pages.set(String(page.id), { ...decodePng(bytes), bytes });
  }
  return pages;
}

const sizeOf = (buf) => ({ raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length });

/**
 * The io half: read an upstream raw-bake directory, write packed Couch geoclip/1, and report what every file cost before and
 * after (raw and gzipped — the wire pays the gzip number, the disk pays the raw one).
 */
export function packGeoclipDir(inDir, outDir, { pretty = false, ...opts } = {}) {
  const src = resolve(inDir);
  const dst = resolve(outDir);
  const manifest = JSON.parse(readFileSync(resolve(src, "manifest.json"), "utf8"));
  const pages = readPages(src, manifest);
  const packed = packGeoclip(manifest, pages, opts);

  mkdirSync(dst, { recursive: true });
  const files = [];
  const json = Buffer.from(
    (pretty ? JSON.stringify(packed.manifest, null, 2) : JSON.stringify(packed.manifest)) + "\n", "utf8");
  writeFileSync(resolve(dst, "manifest.json"), json);
  files.push({ file: "manifest.json", ...sizeOf(json) });
  for (const sheet of packed.sheets) {
    // A passthrough sheet IS the source page, so it is copied byte for byte — see readPages. A repacked sheet is
    // new pixels: adaptive row filtering, because these sheets are real texture and filter-none costs about twice
    // the bytes.
    const png = sheet.bytes ?? encodePngRgba(sheet.width, sheet.height, sheet.data, { filter: "adaptive" });
    writeFileSync(resolve(dst, sheet.file), png);
    files.push({ file: sheet.file, ...sizeOf(png) });
  }
  const bin = Buffer.from(packed.verts.bytes.buffer, packed.verts.bytes.byteOffset, packed.verts.bytes.length);
  writeFileSync(resolve(dst, packed.manifest.vertsBin.file), bin);
  files.push({ file: packed.manifest.vertsBin.file, ...sizeOf(bin) });

  const before = [
    { file: "manifest.json", ...sizeOf(readFileSync(resolve(src, "manifest.json"))) },
    ...(manifest.pages ?? []).map((p) => ({ file: p.file, ...sizeOf(readFileSync(resolve(src, p.file))) }))
  ];

  const total = (rows) => rows.reduce((a, r) => ({ raw: a.raw + r.raw, gzip: a.gzip + r.gzip }), { raw: 0, gzip: 0 });
  return {
    in: src,
    out: dst,
    manifest: packed.manifest,
    stats: packed.stats,
    before: { files: before, total: total(before) },
    after: { files, total: total(files) }
  };
}
