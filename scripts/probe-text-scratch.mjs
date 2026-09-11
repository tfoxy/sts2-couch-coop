#!/usr/bin/env node
// NAME THE TERM: one headless bench that says WHICH arithmetic produces the canvas text rasterizer's fragments.
//
//   node scripts/probe-text-scratch.mjs
//   node scripts/probe-text-scratch.mjs --recording audit-shop-open --band 64 --out <dir>
//   node scripts/probe-text-scratch.mjs --url http://127.0.0.1:5256 --no-serve      (reuse a dev server)
//   node scripts/probe-text-scratch.mjs --selftest                                  (the verdict table, offline)
//
// ---------------------------------------------------------------------------------------------------------------
// WHAT THIS IS FOR
//
// Round 7 photographed a rendering defect and bisected it: a subset of small canvas labels come
// out as a MAGNIFIED FRAGMENT of their digits, and `?textScratchProbe` proved the scratch canvas is already wrong
// BEFORE the upload — so the rasterizer is the defect and the upload and the region write are exonerated. Six
// other mechanisms were closed the same way (digest collisions, the atlas packer, stale pages, font metrics, a
// deferred upload, the page's source rect).
//
// What round 7 could NOT do was say which term inside the rasterizer. That needs the sample to carry the
// arithmetic rather than just the picture, which is what `textSurfaces`' extended `scratchSamples` now does — and
// this script is the reader for it. It runs the bench HEADLESS (the defect reproduces headless, which is the
// finding that makes this cost no GPU slot), pulls `census.canvasStats.text.scratchSamples` out of the
// `BENCH_RESULT` line, writes every sample's PNG, measures each one's ink, and applies a PRE-COMMITTED
// discrimination table.
//
// ---------------------------------------------------------------------------------------------------------------
// THE DISCRIMINATION TABLE, WRITTEN BEFORE THE RUN
//
// Committed here rather than in a report so that reading the numbers cannot choose the branch. Applied per
// sample; the run's verdict is the branch its FRAGMENT samples land in.
//
//   1  postW disagrees with preW (>0.5px), and/or fontBefore != fontAfter, with memoWasSet true
//      => STALE MEASURE-VS-DRAW FONT. `ctx.font` resolves its face at ASSIGNMENT and the module memoizes the
//         assignment on a context SHARED with the layout's measurer, so a surface can be SIZED through one face
//         and DRAWN through another with no number disagreeing at measure time.
//         FIX SHAPE: memo honesty — never memoize a font whose face is not ready.
//
//   2  every measurement agrees (+-0.5px) but texW < ceil((laidOutW + padL + padR) * rasterScale), or the sample's
//      own ink runs to the surface's edge
//      => A GENUINELY SMALL INK BOX. An arithmetic term in `inkBoxOf` / `inkPadOf`.
//         FIX SHAPE: fix the NAMED term, with a spec pinned to this sample's exact numbers.
//
//   3  widths agree but (postAscent + postDescent) disagrees with (ascent + descent) by >0.5px
//      => the same stale resolution, showing in the VERTICAL metric instead of the horizontal one.
//         FIX SHAPE: as 1; the spec pins ascent/descent.
//
//   4  every field agrees and the sample still holds a fragment
//      => NOT a sizing-or-font mechanism (state carried across the resize). NO FIX THIS ROUND: file it with the
//         samples attached. The round-7 vertically-flipped label is the likeliest member and files as its own
//         defect, separate from the fragment population.
//
// ---------------------------------------------------------------------------------------------------------------
// WHAT `fontBefore`/`fontAfter` CAN AND CANNOT SAY. `ctx.font`'s getter serializes the string it was TOLD, not the
// face it RESOLVED — no browser exposes the latter. So those two fields witness a re-assignment, never a
// re-resolution, and the discriminating evidence for branch 1 is the WIDTHS. They are carried because a
// disagreement there would be decisive on its own, not because their agreement proves anything.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { PRIMARY_REPO_ROOT, RECOVERED_RESOURCE_ROOT, REPO_ROOT } from "./lib/repo-layout.mjs";

/** Recordings live in the PRIMARY checkout — a worktree's `.sts2/` is per-checkout and usually absent. */
const PRIMARY = PRIMARY_REPO_ROOT;
const PRIMARY_BENCH = resolve(PRIMARY, ".sts2/bench");

const HELP = `probe-text-scratch.mjs — name the term behind the canvas text rasterizer's fragments

  node scripts/probe-text-scratch.mjs [options]

  --recording <name>   bench recording (bare name resolves against the primary checkout's .sts2/bench).
                       Default: audit-shop-open — the screen the defect was photographed on.
  --band <n>           ?textScratchProbe=<n>, the sample SELECTION BAND in device px. Default 64, which admits
                       the ~28px broken siblings round 7's 24px band could not see. 1 = round 7's band verbatim.
  --out <dir>          where sample PNGs and the raw BENCH_RESULT are written.
  --url <origin>       dev server serving THE CODE UNDER TEST. Default http://127.0.0.1:5256.
  --port <n>           the port to START a dev server on (default 5256; ignored with --no-serve).
  --serve-port <n>     the bench's own recording server (default 5257).
  --no-serve           do not start a dev server; --url must already be serving this checkout.
  --res-root <dir>     real asset bytes for the paint (default the local extracted resource root).
  --keep               leave the dev server running.
  --dry-run            print the bench argv and stop.
  --selftest           run the verdict table's own pins and stop. No browser, no server.
  --help`;

// ---------------------------------------------------------------------------------------------------------------
// the verdict table, as a pure function
// ---------------------------------------------------------------------------------------------------------------

/** Everything here is a pixel tolerance; 0.5px is `metricsMismatch`'s own, kept identical on purpose. */
const TOL_PX = 0.5;

/**
 * A sample's INK, measured from the PNG rather than inferred.
 *
 * `touchesEdge` is the mechanical fragment detector, and it is sound because of a property the rasterizer
 * guarantees: `INK_MARGIN_PX` puts a 1px transparent skirt around every ink box, so a CORRECT raster's outermost
 * texels are empty on all four sides. Ink that reaches an edge has been clipped by the surface bound, which is
 * exactly what a magnified draw looks like from the outside.
 */
export function inkOfPng(path) {
  const r = spawnSync("identify", ["-format", "%@|%[fx:mean.a]|%w|%h", path], { encoding: "utf8" });
  if (r.status !== 0) {
    return null;
  }
  const [box, alpha, w, h] = String(r.stdout).trim().split("|");
  const m = /^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/.exec(box ?? "");
  if (!m) {
    return null;
  }
  const ink = { w: Number(m[1]), h: Number(m[2]), x: Number(m[3]), y: Number(m[4]) };
  const texW = Number(w);
  const texH = Number(h);
  return {
    ...ink,
    texW,
    texH,
    alphaMean: Number(alpha),
    touchesEdge: ink.x <= 0 || ink.y <= 0 || ink.x + ink.w >= texW || ink.y + ink.h >= texH
  };
}

/**
 * THE PRE-COMMITTED TABLE. Pure, so `--selftest` can pin it and so no run can quietly re-order the branches.
 *
 * `ink` is {@link inkOfPng}'s reading, or null when ImageMagick could not be asked — in which case branch 2's
 * second disjunct simply does not fire and the row says so.
 */
export function classifySample(s, ink) {
  const widthsAgree =
    Math.abs(s.postW - s.preW) <= TOL_PX && Math.abs(s.preW - s.laidOutW) <= TOL_PX;
  const fontsAgree = s.fontBefore === s.fontAfter;
  const verticalAgrees = Math.abs(s.postAscent + s.postDescent - (s.ascent + s.descent)) <= TOL_PX;
  // What the surface WOULD have been sized to from the caller's own laid-out width plus the module's stated pads,
  // versus what it WAS sized to. `ink.w` already carries the pads, so the comparison is against the box the
  // module derived rather than against a pad this script re-invents (which is the trap `inkPadOf` exists to shut).
  const sizedFor = Math.ceil(s.ink.w * s.rasterScale);
  const sizingHolds = sizedFor === s.texW;
  const inkEscapes = ink !== null && ink.touchesEdge;

  let branch;
  if (!widthsAgree || !fontsAgree) {
    branch = 1;
  } else if (!verticalAgrees) {
    branch = 3;
  } else if (!sizingHolds || inkEscapes) {
    branch = 2;
  } else {
    branch = 4;
  }
  return { branch, widthsAgree, fontsAgree, verticalAgrees, sizingHolds, sizedFor, inkEscapes };
}

const BRANCH_NAME = {
  1: "STALE MEASURE-VS-DRAW FONT (memo poisoning) -> C2 = memo honesty",
  2: "SMALL INK BOX (an inkBoxOf/inkPadOf term)   -> C2 = fix the named term",
  3: "STALE VERTICAL METRIC                       -> C2 = memo honesty, ascent/descent pinned",
  4: "NEITHER sizing NOR font                     -> NO FIX: file it, the re-table is blocked"
};

// ---------------------------------------------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const a = {
    recording: "audit-shop-open",
    band: 64,
    out: resolve(PRIMARY, ".sts2/artifacts/r8-text/probe"),
    url: "http://127.0.0.1:5256",
    port: 5256,
    servePort: 5257,
    serve: true,
    resRoot: RECOVERED_RESOURCE_ROOT,
    viewport: "1920x1080",
    keep: false,
    dryRun: false,
    selftest: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const [key, inline] = eq > 0 && arg.startsWith("--") ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, null];
    const val = () => inline ?? argv[++i];
    switch (key) {
      case "--recording": a.recording = val(); break;
      case "--band": a.band = Number(val()); break;
      case "--out": a.out = resolve(val()); break;
      case "--url": a.url = val(); break;
      case "--port": a.port = Number(val()); break;
      case "--serve-port": a.servePort = Number(val()); break;
      case "--no-serve": a.serve = false; break;
      case "--res-root": a.resRoot = val(); break;
      case "--viewport": a.viewport = val(); break;
      case "--keep": a.keep = true; break;
      case "--dry-run": a.dryRun = true; break;
      case "--selftest": a.selftest = true; break;
      case "--help": case "-h": a.help = true; break;
      default:
        if (arg.startsWith("-")) {
          console.error(`unknown option ${arg}`);
          process.exit(2);
        }
    }
  }
  return a;
}

function recordingPath(name) {
  if (isAbsolute(name)) return name;
  if (name.includes("/")) return resolve(REPO_ROOT, name);
  return resolve(PRIMARY_BENCH, name.endsWith(".ndjson") ? name : `${name}.ndjson`);
}

// ---------------------------------------------------------------------------------------------------------------
// the dev server
// ---------------------------------------------------------------------------------------------------------------

/**
 * A vite dev server serving THIS checkout, on a port this round owns.
 *
 * `COUCHCOOP_DEV_PROXY_TARGET` is pointed at a DEAD port deliberately: vite's default proxy target is the
 * developer's own live game on :13337, and a probe that needs no game must not be able to reach one. The bench
 * serves `/res` itself from `--res-root`, so nothing on the measured path wants the proxy.
 */
async function startDevServer(port) {
  const child = spawn("npx", ["vite", "--port", String(port), "--strictPort"], {
    cwd: resolve(REPO_ROOT, "frontend"),
    env: { ...process.env, COUCHCOOP_DEV_PROXY_TARGET: "http://127.0.0.1:9" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (b) => process.stderr.write(`  [vite] ${b}`));
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (Date.now() > deadline) {
      child.kill("SIGTERM");
      throw new Error(`dev server did not come up on :${port} within 60s`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return child;
}

// ---------------------------------------------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------------------------------------------

function benchArgv(a) {
  return [
    "scripts/bench-mirror-replay.mjs",
    "--url", a.url,
    "--serve-port", String(a.servePort),
    "--recording", recordingPath(a.recording),
    "--viewport", a.viewport,
    "--repeats", "1",
    // `--pace recorded` is the ONLY correct pace on a canvas arm (`max` deadlocks the credit pump); passed
    // explicitly so a reader of the log never has to know that.
    "--pace", "recorded",
    "--effects", "off",
    "--res-root", a.resRoot,
    "--census",
    "--query",
    `stage=canvas&textScratchProbe=${a.band}&paintDump=1`
  ];
}

function parseBenchResult(stdout) {
  for (const line of String(stdout).split("\n")) {
    const i = line.indexOf("BENCH_RESULT ");
    if (i >= 0) {
      try {
        return JSON.parse(line.slice(i + "BENCH_RESULT ".length));
      } catch (e) {
        throw new Error(`BENCH_RESULT line did not parse: ${e.message}`);
      }
    }
  }
  return null;
}

function n(v, places = 3) {
  return Number.isFinite(v) ? v.toFixed(places) : "?";
}

function report(samples, outDir, textStats) {
  console.log("");
  console.log(`  ${samples.length} scratch samples, written to ${outDir}`);
  if (textStats) {
    console.log(
      `  text census: surfaces ${textStats.surfaces}, uploads ${textStats.uploads}, paced ${textStats.paced}, ` +
        `fontsPending ${textStats.fontsPending}, metricsMismatch ${textStats.metricsMismatch}, ` +
        `digestCollisions ${textStats.digestCollisions}, declined ${textStats.declined}`
    );
  }
  console.log("");
  const rows = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const png = resolve(outDir, `sample-${String(i).padStart(2, "0")}.png`);
    const ink = inkOfPng(png);
    const v = classifySample(s, ink);
    rows.push({ i, s, ink, v, png });
  }

  console.log(
    "   #  texWxH  tex@page  scale  ink w,h        sized  laidOut   preW   postW  asc/desc  post a/d  memo  ink bbox        a-mean  edge  branch"
  );
  for (const { i, s, ink, v } of rows) {
    console.log(
      `  ${String(i).padStart(2)}  ${String(s.texW).padStart(3)}x${String(s.texH).padEnd(3)}` +
        `  ${String(s.texX).padStart(4)},${String(s.texY).padEnd(4)}` +
        `  ${n(s.rasterScale, 1).padStart(4)}` +
        `  ${n(s.ink.w, 2).padStart(6)},${n(s.ink.h, 2).padEnd(6)}` +
        `  ${String(v.sizedFor).padStart(4)}${v.sizingHolds ? " " : "!"}` +
        `  ${n(s.laidOutW, 2).padStart(6)}` +
        ` ${n(s.preW, 2).padStart(6)}` +
        ` ${n(s.postW, 2).padStart(6)}` +
        `  ${n(s.ascent, 1)}/${n(s.descent, 1)}` +
        `  ${n(s.postAscent, 1)}/${n(s.postDescent, 1)}` +
        `  ${s.memoWasSet ? "yes " : "no  "}` +
        `  ${ink ? `${ink.w}x${ink.h}+${ink.x}+${ink.y}`.padEnd(14) : "(no identify)"}` +
        `  ${ink ? n(ink.alphaMean, 3) : "  ?  "}` +
        `  ${ink ? (ink.touchesEdge ? "YES " : "no  ") : " ?  "}` +
        `  ${v.branch}`
    );
  }

  console.log("");
  console.log("  fonts seen:");
  for (const f of [...new Set(rows.map((r) => r.s.cssFont))]) {
    console.log(`    ${f}`);
  }

  // THE VERDICT, taken over the FRAGMENT population only. A run whose samples are all healthy has not tested the
  // table at all, and must say so rather than reporting branch 4 as a finding.
  const fragments = rows.filter((r) => r.ink !== null && r.ink.touchesEdge);
  console.log("");
  console.log(`  FRAGMENT POPULATION (ink reaching the surface bound): ${fragments.length}/${rows.length}`);
  if (fragments.length === 0) {
    console.log("  NO FRAGMENT IN THE SAMPLE — the table is untested by this run. Widen --band or change the");
    console.log("  recording; do NOT read branch 4 off healthy samples.");
    return rows;
  }
  const counts = new Map();
  for (const f of fragments) counts.set(f.v.branch, (counts.get(f.v.branch) ?? 0) + 1);
  for (const [branch, count] of [...counts].sort((a, b) => a[0] - b[0])) {
    console.log(`    branch ${branch}  x${count}  ${BRANCH_NAME[branch]}`);
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------
// selftest
// ---------------------------------------------------------------------------------------------------------------

function selftest() {
  const base = {
    texW: 22, texH: 22, texX: 0, texY: 0,
    ink: { dx: -1, dy: -1, w: 21.623, h: 21.5 },
    rasterScale: 1,
    cssFont: "20px Kreon",
    ascent: 20, descent: 5,
    laidOutW: 19.6, preW: 19.6, postW: 19.6,
    postAscent: 20, postDescent: 5,
    memoWasSet: true,
    fontBefore: "20px Kreon", fontAfter: "20px Kreon"
  };
  const healthy = { w: 19, h: 20, x: 1, y: 1, texW: 22, texH: 22, alphaMean: 0.2, touchesEdge: false };
  const clipped = { w: 22, h: 22, x: 0, y: 0, texW: 22, texH: 22, alphaMean: 0.4, touchesEdge: true };
  const checks = [
    ["all agree, ink inside -> 4", classifySample(base, healthy).branch, 4],
    ["postW disagrees -> 1", classifySample({ ...base, postW: 27.4 }, healthy).branch, 1],
    ["font re-assigned differently -> 1", classifySample({ ...base, fontAfter: "20px serif" }, healthy).branch, 1],
    ["vertical metric disagrees -> 3", classifySample({ ...base, postAscent: 16 }, healthy).branch, 3],
    ["widths agree but ink escapes -> 2", classifySample(base, clipped).branch, 2],
    ["widths agree but texW short -> 2", classifySample({ ...base, texW: 18 }, healthy).branch, 2],
    // PRECEDENCE, pinned: a font disagreement outranks a clipped picture, because a stale face EXPLAINS the
    // clipping and a small ink box does not explain the widths.
    ["font disagreement outranks a clip -> 1", classifySample({ ...base, postW: 27.4 }, clipped).branch, 1],
    // The tolerance is `metricsMismatch`'s own 0.5px, and it is INCLUSIVE at the boundary.
    ["0.5px is still agreement", classifySample({ ...base, postW: 20.1 }, healthy).branch, 4],
    // Round 7's own dump numbers: ceil(21.623 * 1) === 22, so the sizing arithmetic HOLDS for the failing labels.
    ["r7 shop price sizing holds", classifySample(base, healthy).sizingHolds, true],
    ["r7 shop price sized-for", classifySample(base, healthy).sizedFor, 22]
  ];
  let bad = 0;
  for (const [what, got, want] of checks) {
    if (got !== want) {
      console.error(`  FAIL ${what}: got ${got}, want ${want}`);
      bad++;
    }
  }
  if (bad > 0) {
    return 1;
  }
  console.log(`probe-text-scratch selftest: ${checks.length} pins on the discrimination table hold`);
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------------------

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log(HELP);
    return 0;
  }
  if (a.selftest) {
    return selftest();
  }
  const rec = recordingPath(a.recording);
  if (!existsSync(rec)) {
    console.error(`no such recording: ${rec}`);
    return 2;
  }
  const argv = benchArgv(a);
  if (a.dryRun) {
    const q = (s) => (/[^\w@%+=:,./-]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s);
    console.log(`  node ${argv.map(q).join(" ")}`);
    return 0;
  }
  mkdirSync(a.out, { recursive: true });

  let server = null;
  if (a.serve) {
    console.error(`  starting dev server on :${a.port} …`);
    server = await startDevServer(a.port);
    a.url = `http://127.0.0.1:${a.port}`;
  }
  try {
    console.error(`  bench: ${a.recording} band=${a.band} viewport=${a.viewport}`);
    const r = spawnSync("node", argv, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
    if (r.error) {
      throw new Error(`could not launch the bench: ${r.error.message}`);
    }
    if (r.status !== 0) {
      process.stderr.write(r.stderr ?? "");
      throw new Error(`bench exited ${r.status}`);
    }
    const result = parseBenchResult(r.stdout);
    if (result === null) {
      process.stdout.write(r.stdout ?? "");
      throw new Error("no BENCH_RESULT line in the bench output");
    }
    writeFileSync(resolve(a.out, "bench-result.json"), JSON.stringify(result, null, 2));
    const text = result.census?.canvasStats?.text ?? null;
    if (text === null) {
      throw new Error(
        "census.canvasStats.text is null — the canvas text runtime did not publish its census; this is a stage " +
          "failure, not an empty result."
      );
    }
    const samples = text.scratchSamples ?? [];
    for (let i = 0; i < samples.length; i++) {
      const url = samples[i].dataUrl ?? "";
      const comma = url.indexOf(",");
      if (comma < 0) continue;
      writeFileSync(resolve(a.out, `sample-${String(i).padStart(2, "0")}.png`), Buffer.from(url.slice(comma + 1), "base64"));
    }
    // The dataUrls are megabytes of base64 and the PNGs are on disk beside this; the ndjson is for a later reader.
    writeFileSync(
      resolve(a.out, "samples.ndjson"),
      samples.map((s, i) => JSON.stringify({ i, ...s, dataUrl: undefined })).join("\n") + "\n"
    );
    report(samples, a.out, text);
    return 0;
  } finally {
    if (server !== null && !a.keep) {
      server.kill("SIGTERM");
    } else if (server !== null) {
      console.error(`  dev server left running on :${a.port} (pid ${server.pid})`);
    }
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`probe-text-scratch: ${err.message}`);
    process.exit(1);
  }
);
