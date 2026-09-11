#!/usr/bin/env node
// P5 — CANVAS ATLAS / VRAM FOOTPRINT. Offline feasibility probe for the planned single-canvas mirror stage: how
// many distinct texture PAGES would one screen have to hold resident, and roughly how much RGBA memory is that?
//
//   node scripts/probe-canvas-atlas-vram.mjs [recording…]      (bare names resolve against .sts2/bench)
//
// METHOD. Replay each recording to its FINAL state through the real wire model, then group every node carrying a
// `textureRegion` (an AtlasTexture crop: `textureUrl` is the shared PAGE, the region is the sub-rect) by its page
// url. A page's size is bounded below by the extreme corner any node crops from it:
//
//     pageW >= max(region.x + region.width)     pageH >= max(region.y + region.height)
//
// and its RGBA cost by `pageW * pageH * 4` bytes. Nodes WITHOUT a region reference a whole standalone image; those
// are counted separately (their pixel size is not derivable from the wire at all).
//
// APPROXIMATIONS:
//   * LOWER BOUND, always. The true page is at least as large as the extreme crop and usually larger (unused
//     margin, power-of-two padding, regions no node on this screen happens to use). A real number needs an image
//     decode — deliberately out of scope for an offline, asset-free probe.
//   * Standalone (non-atlas) textures contribute NOTHING to the MB column. On screens where those dominate
//     (backgrounds, SDF inputs) the reported MB is a small fraction of the real residency.
//   * "resident" is taken as the FINAL-state tree. The `visible` columns narrow that to pages a
//     currently-painting, non-hidden node crops from; the `all` columns include hidden/dormant subtrees, which is
//     what a client that has already built the whole scene actually holds.

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import {
  REPO_ROOT,
  nodePaintsContent,
  printTable,
  replayRecording,
  resolveRecordings,
  shortName,
  walkResolved
} from "./lib/mirror-probe.mjs";

const HELP = `probe-canvas-atlas-vram.mjs — P5: atlas page count + lower-bound RGBA footprint

  node scripts/probe-canvas-atlas-vram.mjs [recording…]

  recording   NDJSON path, or a bare name resolved against .sts2/bench.
              Default: the standard probe set.
  --top N     how many pages to list per recording (default 5)
  --regions   size the RUNTIME ATLAS RE-PACKER: how many DISTINCT snapped crops each page over the
              re-packer's size predicate would hold. Adds two columns and a per-page count.
  --mp N      the re-packer's page-size predicate, in megapixels (default 6, its shipped value).
  --help`;

function parseArgs(argv) {
  const rest = [];
  let top = 5;
  let regions = false;
  let mp = 6;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(HELP);
      process.exit(0);
    } else if (arg === "--top") {
      top = Number(argv[++i]) || 5;
    } else if (arg === "--regions") {
      regions = true;
    } else if (arg === "--mp") {
      mp = Number(argv[++i]) || 6;
    } else {
      rest.push(arg);
    }
  }
  return { rest, top, regions, mp };
}

// THE RE-PACKER'S OWN CROP ALGEBRA, imported rather than restated: a sizing number computed from a second
// implementation of the snap would be sizing a module that does not exist. Node strips the types natively.
const { repackCrop } = await import(
  pathToFileURL(resolve(REPO_ROOT, "frontend/src/mirror/canvas/atlasRepack.ts")).href
);

function accumulate(pages, url, region) {
  let page = pages.get(url);
  if (!page) {
    page = { url, w: 0, h: 0, refs: 0, rects: [] };
    pages.set(url, page);
  }
  page.refs++;
  page.w = Math.max(page.w, region.x + region.width);
  page.h = Math.max(page.h, region.y + region.height);
  page.rects.push(region);
}

/**
 * How many DISTINCT region textures the re-packer would hold for each page, and the worst page's count — the
 * number that decides per-region textures vs a shelf packer (>= 24 on one page is the escalation).
 *
 * TWO WAYS THE LOWER BOUND SHOWS UP HERE, and both are stated in the output rather than smoothed over:
 *   * the crop is snapped against the lower-bound page size, which only matters at the page's far edge (a crop
 *     there is clamped to the bound instead of to the true page) — the COUNT is unaffected;
 *   * the size PREDICATE is applied to the lower bound too, so a page whose visible crops do not reach its true
 *     extent reads as "under the threshold" when the runtime, which knows the decoded size, would claim it. So
 *     the count is computed for every page and `over` says which side of the bound the page's lower bound fell.
 *     Combat's card sheet is exactly this case: 3779x767 of it is cropped, the real page is 4032x4032.
 */
function regionCensus(pages, thresholdPixels) {
  let worst = 0;
  let worstAny = 0;
  for (const page of pages.values()) {
    const keys = new Set();
    for (const r of page.rects) {
      if (!(r.width > 0 && r.height > 0)) {
        continue;
      }
      const c = repackCrop(page.w, page.h, { srcX: r.x, srcY: r.y, srcW: r.width, srcH: r.height });
      if (c.w * c.h * 4 > page.w * page.h) {
        continue; // a crop over a quarter of the page is refused; the page is uploaded whole
      }
      keys.add(`${c.x},${c.y},${c.w},${c.h}`);
    }
    page.regions = keys.size;
    page.over = page.w * page.h >= thresholdPixels;
    worstAny = Math.max(worstAny, keys.size);
    if (page.over) {
      worst = Math.max(worst, keys.size);
    }
  }
  return { worst, worstAny };
}

function mb(pages) {
  let bytes = 0;
  for (const p of pages.values()) {
    bytes += p.w * p.h * 4;
  }
  return bytes / (1024 * 1024);
}

async function analyze(recordingAbs, thresholdPixels) {
  const { state } = await replayRecording(recordingAbs);
  const allPages = new Map();
  const visPages = new Map();
  const allPlain = new Set();
  const visPlain = new Set();

  walkResolved(state, (v) => {
    const node = v.node;
    if (!node.textureUrl) {
      return;
    }
    const painting = !v.hidden && nodePaintsContent(node, v.ownOpacity);
    if (node.textureRegion) {
      accumulate(allPages, node.textureUrl, node.textureRegion);
      if (painting) {
        accumulate(visPages, node.textureUrl, node.textureRegion);
      }
    } else {
      allPlain.add(node.textureUrl);
      if (painting) {
        visPlain.add(node.textureUrl);
      }
    }
  });

  const allRegions = regionCensus(allPages, thresholdPixels);
  const visRegions = regionCensus(visPages, thresholdPixels);
  const top = [...allPages.values()].sort((a, b) => b.w * b.h - a.w * a.h);
  return {
    allPages: allPages.size,
    allMb: mb(allPages),
    allPlain: allPlain.size,
    visPages: visPages.size,
    visMb: mb(visPages),
    visPlain: visPlain.size,
    allRegions,
    visRegions,
    top
  };
}

async function main() {
  const { rest, top, regions, mp } = parseArgs(process.argv.slice(2));
  const thresholdPixels = Math.round(mp * 1_000_000);
  const recordings = resolveRecordings(rest);
  if (recordings.length === 0) {
    console.error("No recordings to analyze.");
    process.exit(2);
  }

  const rows = [];
  const details = [];
  for (const path of recordings) {
    const r = await analyze(path, thresholdPixels);
    rows.push({
      recording: shortName(path).replace(/\.ndjson$/, ""),
      allPages: r.allPages,
      allMb: r.allMb.toFixed(1),
      allPlain: r.allPlain,
      visPages: r.visPages,
      visMb: r.visMb.toFixed(1),
      visPlain: r.visPlain,
      allWorst: r.allRegions.worst,
      visWorst: r.visRegions.worst,
      anyWorst: r.allRegions.worstAny
    });
    details.push({ name: shortName(path).replace(/\.ndjson$/, ""), r });
  }

  console.log("\nP5 — atlas pages in the FINAL state; MB is a LOWER BOUND (max crop corner x 4 bytes/px)\n");
  printTable(
    [
      { key: "recording", label: "recording" },
      { key: "allPages", label: "pages(all)", align: "r" },
      { key: "allMb", label: "MB(all)", align: "r" },
      { key: "allPlain", label: "plain(all)", align: "r" },
      { key: "visPages", label: "pages(vis)", align: "r" },
      { key: "visMb", label: "MB(vis)", align: "r" },
      { key: "visPlain", label: "plain(vis)", align: "r" },
      // The re-packer sizing columns: the WORST single page's distinct-crop count, which is the number the
      // per-region-vs-shelf-packer decision is made on.
      ...(regions
        ? [
            { key: "allWorst", label: "rgn/page(all)", align: "r" },
            { key: "visWorst", label: "rgn/page(vis)", align: "r" },
            // Ignoring the predicate entirely: the worst page's count if EVERY page were re-packed. The bound
            // that survives the lower-bound caveat above.
            { key: "anyWorst", label: "rgn/page(any)", align: "r" }
          ]
        : [])
    ],
    rows
  );

  for (const { name, r } of details) {
    console.log(`\n${name} — top ${Math.min(top, r.top.length)} pages by lower-bound area:`);
    for (const page of r.top.slice(0, top)) {
      const sizeMb = ((page.w * page.h * 4) / (1024 * 1024)).toFixed(2);
      console.log(
        `    ${String(page.w).padStart(5)} x ${String(page.h).padStart(5)}  ${sizeMb.padStart(7)} MB  ` +
          `${String(page.refs).padStart(4)} refs  ` +
          // A trailing `-` marks a page whose LOWER BOUND is under the size predicate: the re-packer would only
          // claim it if its true decoded size clears 6 MP, which for a card sheet it does. See `regionCensus`.
          (regions ? `${String(page.regions).padStart(4)} rgn${page.over ? " " : "-"} ` : "") +
          `${shortName(page.url)}`
      );
    }
  }
  if (regions) {
    console.log(
      `\n  re-packer predicate: pages >= ${(thresholdPixels / 1_000_000).toFixed(1)} MP (applied to the LOWER BOUND,` +
        ` so a page marked "rgn-" would still be claimed at runtime if its decoded size clears it).` +
        `\n  rgn = distinct snapped crops one page would hold; >= 24 on ANY page is the shelf-packer escalation.`
    );
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
