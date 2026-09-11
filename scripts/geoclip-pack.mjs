#!/usr/bin/env node
// geoclip-pack.mjs — pack an upstream raw bake into Couch's packed geoclip/1: quantised binary vertex tracks plus repacked part
// sheets.
//
//   node scripts/geoclip-pack.mjs --in /path/to/bake --out /path/to/bake-packed
//   node scripts/geoclip-pack.mjs --in /path/to/bake --out /path/to/bake-packed --pretty
//   node scripts/geoclip-pack.mjs --in /path/to/bake --out /path/to/bake-packed --repack never
//
// The whole format lives in scripts/lib/packed-geoclip.mjs; this file is arguments, a size table and an exit code.
//
// WHAT THE TABLE IS FOR. "packed geoclip/1 is smaller" is the entire reason the schema exists, so the tool that produces
// it prints the receipt: every file in, every file out, raw AND gzipped, with the ratio. Raw is what the disk and
// the host's memory pay; gzip is what a phone on a hotel wifi pays, and the two do not move together — the JSON
// manifest gzips 6-8x while a PNG does not compress again at all.
//
// It also prints the MEASURED quantisation error (not the bound: the largest error this particular encode
// actually produced, in skeleton-local px), because the one way this format can silently lie is by being cheap
// and wrong.
//
// AND WHICH ARM RAN, WITH ITS BILL. `--repack auto` decides between shelf-packing the parts and copying the
// referenced pages through untouched, on DECODED TEXTURE AREA — the thing a GPU-process OOM is actually about.
// On some rigs that arm costs bytes to save area (byrdonis: the repack saves 25.4K of PNG and spends 136,725 px^2
// of decoded texture, so `auto` declines it). So the packing line always names the arm AND both numbers, in both
// directions: a tool that reported only the number its default happens to improve would be the whole bug.
//
// EXIT CODES.  0 = packed.  2 = bad arguments / missing input.  1 = the pack itself failed.

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { packGeoclipDir, QUANT_STEPS, REPACK_MODES } from "./lib/packed-geoclip.mjs";

const HELP = `geoclip-pack.mjs — pack an upstream raw bake into packed Couch geoclip/1

  --in <dir>     source artifact directory (manifest.json + page-*.png)        [required]
  --out <dir>    destination directory (manifest.json + sheet-*.png + verts.bin) [required]
  --repack <m>   auto (default) | always | never — how to treat the page textures.
                 auto shelf-packs the parts only when the planned sheet area BEATS the referenced
                 page area; otherwise the referenced pages are copied through byte for byte.
                 The arm optimises DECODED texture area, not file bytes; the packing line reports both.
  --pretty       pretty-print the output manifest (default: one line)
  --help

Prints a per-file size table (raw and gzip) and a machine-readable GEOCLIP_PACK_RESULT {json} line.`;

function parseArgs(argv) {
  const a = { in: null, out: null, repack: "auto", pretty: false, help: false, bad: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const next = () => (inline !== undefined ? inline : argv[++i]);
    switch (flag) {
      case "--in": a.in = resolve(next()); break;
      case "--out": a.out = resolve(next()); break;
      case "--repack": {
        const mode = next();
        if (REPACK_MODES.includes(mode)) a.repack = mode;
        else { console.error(`geoclip-pack: --repack must be ${REPACK_MODES.join("|")}, got '${mode}'`); a.bad = true; }
        break;
      }
      case "--pretty": a.pretty = true; break;
      case "--help": case "-h": a.help = true; break;
      default: console.error(`geoclip-pack: unknown argument '${argv[i]}'`); a.bad = true;
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { console.log(HELP); process.exit(0); }
if (!args.in) { console.error("geoclip-pack: --in is required"); args.bad = true; }
if (!args.out) { console.error("geoclip-pack: --out is required"); args.bad = true; }
if (args.bad) { console.error(HELP); process.exit(2); }
if (!existsSync(resolve(args.in, "manifest.json"))) {
  console.error(`geoclip-pack: no manifest.json in ${args.in}`);
  process.exit(2);
}

const kb = (n) => `${(n / 1024).toFixed(1)}K`;
const ratio = (after, before) => (before > 0 ? `${(after / before).toFixed(3)}x` : "-");

let report;
try {
  report = packGeoclipDir(args.in, args.out, { pretty: args.pretty, repack: args.repack });
} catch (e) {
  console.error(`geoclip-pack: ${String(e && e.stack || e)}`);
  process.exit(1);
}

const { stats, before, after } = report;
console.log("");
console.log(`geoclip-pack  ${report.in}`);
console.log(`  -> ${report.out}`);
console.log(`  clip       ${stats.parts} parts (${stats.blocks} distinct rects), ` +
  `${report.manifest.frames.length} frames, ${stats.records} vertex records`);
console.log(`  sheets     ${stats.sheets} x <=${stats.sheetWidth}px wide, ${stats.sheetArea} px^2 packed ` +
  `from ${stats.sourceArea} px^2 of pages (${(stats.sheetArea / Math.max(1, stats.sourceArea) * 100).toFixed(1)}%)`);
// The arm, and BOTH consequences of it. Decoded area is what the arm optimises (it is what a decode allocates and
// the GPU then holds); PNG bytes are what it costs, and on a rig whose parts already tile their page the two point
// in OPPOSITE directions — so printing only the flattering one would be the whole bug.
{
  const pageRaw = before.files.filter((f) => f.file !== "manifest.json").reduce((n, f) => n + f.raw, 0);
  const sheetRaw = after.files.filter((f) => /^sheet-\d+\.png$/.test(f.file)).reduce((n, f) => n + f.raw, 0);
  const signed = (n, unit = String) => `${n < 0 ? "-" : "+"}${unit(Math.abs(n))}`;
  const counterfactual = stats.mode === "passthrough" && stats.consideredSheetArea != null
    ? `; a repack would have planned ${stats.consideredSheetArea} px^2 ` +
      `(${signed(stats.consideredSheetArea - stats.referencedArea)} px^2)`
    : "";
  console.log(`  packing    ${stats.mode} (--repack ${args.repack}), ` +
    `${report.manifest.packing.extruded ? "1px extrusion" : "no extrusion"}: ` +
    `${stats.sheetArea} px^2 decoded vs ${stats.referencedArea} px^2 referenced ` +
    `(${signed(stats.sheetArea - stats.referencedArea)} px^2, ` +
    `${(stats.sheetArea / Math.max(1, stats.referencedArea) * 100).toFixed(1)}%), ` +
    `sheet PNGs ${kb(sheetRaw)} vs pages ${kb(pageRaw)} (${signed(sheetRaw - pageRaw, kb)})${counterfactual}`);
}
console.log(`  quant      ${QUANT_STEPS} steps per part bbox; bound ${stats.quantBound.toExponential(3)} px, ` +
  `worst measured ${stats.quantMaxError.toExponential(3)} px` +
  (stats.quantWorstPart == null ? "" : ` (part '${stats.quantWorstPart}')`));
for (const s of stats.skipped) console.log(`  ! left as JSON: ${s}`);
console.log("");

const rows = [
  ...before.files.map((f) => ({ side: "raw", ...f })),
  { rule: true },
  ...after.files.map((f) => ({ side: "packed", ...f }))
];
console.log("  side   | file            |      raw |     gzip");
console.log("  " + "-".repeat(49));
for (const r of rows) {
  if (r.rule) { console.log("  " + "-".repeat(49)); continue; }
  console.log(`  ${r.side.padEnd(6)} | ${String(r.file).padEnd(15)} | ${kb(r.raw).padStart(8)} | ${kb(r.gzip).padStart(8)}`);
}
console.log("  " + "-".repeat(49));
console.log(`  ${"raw".padEnd(6)} | TOTAL           | ${kb(before.total.raw).padStart(8)} | ${kb(before.total.gzip).padStart(8)}`);
console.log(`  ${"packed".padEnd(6)} | TOTAL           | ${kb(after.total.raw).padStart(8)} | ${kb(after.total.gzip).padStart(8)}`);
console.log(`  packed/raw                    | ${ratio(after.total.raw, before.total.raw).padStart(8)} | ` +
  `${ratio(after.total.gzip, before.total.gzip).padStart(8)}`);
console.log("");
console.log("GEOCLIP_PACK_RESULT " + JSON.stringify({
  schema: "geoclip-pack/1",
  in: report.in,
  out: report.out,
  stats: { ...stats, skipped: stats.skipped.length },
  before: { files: before.files, total: before.total },
  after: { files: after.files, total: after.total },
  ratio: {
    raw: before.total.raw ? after.total.raw / before.total.raw : null,
    gzip: before.total.gzip ? after.total.gzip / before.total.gzip : null
  }
}));
