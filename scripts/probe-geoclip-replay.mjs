#!/usr/bin/env node
// probe-geoclip-replay.mjs — play a packed Couch geoclip/1 artifact in scripts/geoclip-harness.html and
// screenshot chosen frames; optionally pixel-diff every frame against a directory of ground-truth PNGs.
//
// This is the only supported way to turn a geoclip bake into pictures. It owns its own `node:http` server (no
// vite, no dev server, no product code) and its own headless Chromium, so what it reports is a property of the
// ARTIFACT plus ~300 lines of harness — nothing else is in the loop.
//
//   # screenshot a few frames of an artifact
//   node scripts/probe-geoclip-replay.mjs \
//     --artifact /path/to/geoclip \
//     --canvas 512x512 --frames 0,4,7 \
//     --out /path/to/shots
//
//   # every frame, y-flipped, and diffed against a truth dir
//   node scripts/probe-geoclip-replay.mjs \
//     --artifact /path/to/geoclip --all \
//     --canvas 512x768 --fit '{"scaleX":1,"scaleY":-1,"offsetX":256,"offsetY":700}' \
//     --truth /path/to/truth --truth-pattern 'frame-%04d.png' \
//     --out /path/to/diff
//
// THE FIT IS THE WHOLE PLACEMENT CONTRACT. A geoclip's coordinates are skeleton-local; the canvas is whatever the
// caller asked for. `--fit` maps one to the other with four numbers:
//     canvasX = localX * scaleX + offsetX      canvasY = localY * scaleY + offsetY
// so a y-UP rig is placed with a NEGATIVE scaleY plus an offsetY that puts the rig's origin where its feet
// should be. Nothing else in this pipeline flips anything, which is deliberate: one place to get it wrong.
//
// FRAMES ARE PINNED, NEVER PLAYED. `seek(i)` draws exactly frame i and resolves after it is on the canvas; the
// screenshot happens after that. A prior round measured what live-animation screenshots cost — an RMSE noise
// floor you cannot then tell apart from a real regression — so there is no "play" mode here at all.
//
// EXIT CODES.  0 = the run completed (whatever the RMSE turned out to be — a diff is a measurement, not a gate).
//              1 = the harness could not render (no WebGL2, load failure, GL error, lost context).
//              2 = bad arguments / missing input.

import { createRequire } from "node:module";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("playwright");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_HTML = resolve(SCRIPT_DIR, "geoclip-harness.html");

// ---------------------------------------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------------------------------------

const DEFAULT_FIT = { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };

const HELP = `probe-geoclip-replay.mjs — play a geoclip artifact and screenshot / pixel-diff pinned frames

  --artifact <dir>        packed Couch geoclip/1 dir (manifest.json + sheet-*.png + verts.bin) [required]
  --out <dir>             where the frame PNGs (and diff evidence) are written               [required]
  --frames <spec>         which frames: '0,4,7', '0-7', '0-7:2', or a mix ('0,3-5')  (default: 0)
  --all                   every frame in the manifest
  --canvas <WxH>          drawing buffer / screenshot size in px (default 512x512)
  --fit <json>            {"scaleX":1,"scaleY":1,"offsetX":0,"offsetY":0}; canvasX = localX*scaleX + offsetX
  --bg <#rrggbb|#rrggbbaa|transparent>   clear colour (default #000000, opaque)
  --truth <dir>           ground-truth PNG frames to RMSE-diff each rendered frame against
  --truth-pattern <p>     truth filename pattern, %d / %0Nd is the frame index (default frame-%04d.png)
  --truth-offset <n>      truth index = frame index + n (default 0)
  --name-pattern <p>      output filename pattern (default frame-%04d.png — same shape, so an --out dir can
                          itself be used as a later run's --truth dir)
  --port <n>              http port for the harness + artifact (default 5217)
  --keep-open             leave the server and the browser running until Ctrl-C (prints the URL)
  --hud                   show the harness HUD. It OVERLAPS the canvas and will appear in screenshots.
  --headed                run Chromium headed (debugging only)
  --gl-args <csv>         override the Chromium GL flags (default: the measured software-GL set, see the source)
  --timeout <ms>          per-navigation / per-load budget (default 30000)
  --help

Prints a human table and a machine-readable GEOCLIP_REPLAY_RESULT {json} line.`;

function parseFrames(spec) {
  const out = [];
  for (const chunk of String(spec).split(",")) {
    const piece = chunk.trim();
    if (!piece) continue;
    const m = /^(\d+)\s*-\s*(\d+)(?:\s*:\s*(\d+))?$/.exec(piece);
    if (m) {
      const step = Math.max(1, Number(m[3] || 1));
      for (let i = Number(m[1]); i <= Number(m[2]); i += step) out.push(i);
      continue;
    }
    const n = Number(piece);
    if (!Number.isInteger(n) || n < 0) return null;
    out.push(n);
  }
  return out.length ? [...new Set(out)].sort((a, b) => a - b) : null;
}

function parseColor(raw) {
  if (raw === "transparent") return [0, 0, 0, 0];
  const m = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(String(raw));
  if (!m) return null;
  const h = m[1];
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return [...c, h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
}

/** `frame-%04d.png` + 7 -> `frame-0007.png`. Supports %d and %0Nd. */
export function expandPattern(pattern, index) {
  let seen = false;
  const out = String(pattern).replace(/%(0?)(\d*)d/g, (_all, zero, width) => {
    seen = true;
    const s = String(index);
    const w = width ? Number(width) : 0;
    return zero && w ? s.padStart(w, "0") : s;
  });
  if (!seen) throw new Error(`pattern '${pattern}' has no %d / %0Nd placeholder`);
  return out;
}

function parseArgs(argv) {
  const a = {
    artifact: null, out: null, frames: null, all: false,
    width: 512, height: 512,
    fit: { ...DEFAULT_FIT },
    bg: [0, 0, 0, 1],
    truth: null, truthPattern: "frame-%04d.png", truthOffset: 0,
    namePattern: "frame-%04d.png",
    port: 5217, keepOpen: false, hud: false, headed: false, timeout: 30000,
    // THESE FLAGS ARE LOAD-BEARING, measured on this box rather than copied:
    //
    //   with default flags   the WebGL2 context comes up on "ANGLE ... Vulkan ... SwiftShader", reports a
    //                        renderer string, and is LOST ~1s later — before a single frame is drawn. It does
    //                        not throw: every later gl call is a silent no-op, so the run would screenshot eight
    //                        black frames and report a clean sweep.
    //   --use-gl=angle --use-angle=swiftshader
    //                        pins the same SwiftShader backend through ANGLE's own path, and the context
    //                        survives (verified over three sequential pages, 2.5s each, readback per page).
    //   --enable-unsafe-swiftshader
    //                        recent Chromium refuses a software WebGL context outright without it.
    //
    // `--gl-args` exists so a box with a real GPU can ask for it without editing this file. The harness still
    // listens for `webglcontextlost` and the driver still refuses the run if it fires, because "the numbers
    // describe a canvas that drew nothing" is the one failure that looks like success.
    glArgs: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-lcd-text"],
    help: false, bad: false
  };
  const bad = (m) => { console.error(`geoclip-replay: ${m}`); a.bad = true; };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const next = () => (inline !== undefined ? inline : argv[++i]);
    switch (flag) {
      case "--artifact": a.artifact = resolve(next()); break;
      case "--out": a.out = resolve(next()); break;
      case "--frames": {
        const parsed = parseFrames(next());
        if (!parsed) { bad("--frames must be like '0,4,7' or '0-7' or '0-7:2'"); break; }
        a.frames = parsed;
        break;
      }
      case "--all": a.all = true; break;
      case "--canvas": {
        const m = /^(\d+)x(\d+)$/.exec(next());
        if (!m) { bad("--canvas must be WxH"); break; }
        a.width = Number(m[1]); a.height = Number(m[2]);
        break;
      }
      case "--fit": {
        const raw = next();
        try {
          const f = JSON.parse(raw);
          a.fit = { ...DEFAULT_FIT, ...f };
          for (const k of Object.keys(DEFAULT_FIT)) {
            if (!Number.isFinite(Number(a.fit[k]))) { bad(`--fit.${k} is not a number`); break; }
            a.fit[k] = Number(a.fit[k]);
          }
        } catch (e) { bad(`--fit must be JSON: ${e.message}`); }
        break;
      }
      case "--bg": {
        const c = parseColor(next());
        if (!c) { bad("--bg must be #rrggbb, #rrggbbaa or 'transparent'"); break; }
        a.bg = c;
        break;
      }
      case "--truth": a.truth = resolve(next()); break;
      case "--truth-pattern": a.truthPattern = next(); break;
      case "--truth-offset": a.truthOffset = Number(next()); break;
      case "--name-pattern": a.namePattern = next(); break;
      case "--port": a.port = Number(next()); break;
      case "--keep-open": a.keepOpen = true; break;
      case "--hud": a.hud = true; break;
      case "--headed": a.headed = true; break;
      case "--gl-args": a.glArgs = String(next()).split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--timeout": a.timeout = Number(next()); break;
      case "--help": case "-h": a.help = true; break;
      default: bad(`unknown argument '${argv[i]}'`);
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { console.log(HELP); process.exit(0); }
if (!args.artifact) { console.error("geoclip-replay: --artifact is required"); args.bad = true; }
if (!args.out) { console.error("geoclip-replay: --out is required"); args.bad = true; }
if (args.bad) { console.error(HELP); process.exit(2); }
if (!existsSync(join(args.artifact, "manifest.json"))) {
  console.error(`geoclip-replay: no manifest.json in ${args.artifact}`);
  process.exit(2);
}
if (args.truth && !existsSync(args.truth)) {
  console.error(`geoclip-replay: --truth directory does not exist: ${args.truth}`);
  process.exit(2);
}
try { expandPattern(args.namePattern, 0); expandPattern(args.truthPattern, 0); }
catch (e) { console.error(`geoclip-replay: ${e.message}`); process.exit(2); }

mkdirSync(args.out, { recursive: true });

// ---------------------------------------------------------------------------------------------------------
// static server — the harness page, the artifact, and (for eyeballing) the truth dir
// ---------------------------------------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp"
};

/** Resolve `rel` under `root`, refusing anything that escapes it. */
function safeJoin(root, rel) {
  const target = resolve(root, "." + (rel.startsWith("/") ? rel : "/" + rel));
  const inside = relative(root, target);
  if (inside.startsWith("..") || inside.startsWith(".." + sep)) return null;
  return target;
}

function serveFile(res, path) {
  let body;
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
    body = readFileSync(path);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(path).toLowerCase()] || "application/octet-stream",
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  });
  res.end(body);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = decodeURIComponent(url.pathname);
  if (path === "/" || path === "/geoclip-harness.html") return serveFile(res, HARNESS_HTML);
  if (path.startsWith("/artifact/")) {
    const f = safeJoin(args.artifact, path.slice("/artifact".length));
    return f ? serveFile(res, f) : res.writeHead(403).end("forbidden");
  }
  if (args.truth && path.startsWith("/truth/")) {
    const f = safeJoin(args.truth, path.slice("/truth".length));
    return f ? serveFile(res, f) : res.writeHead(403).end("forbidden");
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

// ---------------------------------------------------------------------------------------------------------
// ImageMagick
// ---------------------------------------------------------------------------------------------------------

function magick(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`${cmd} failed to launch: ${r.error.message}`);
  return r;
}

// `compare -metric RMSE a b null:` exits 0 (identical) or 1 (differ) with the real result on stderr; only exit 2
// is an actual ImageMagick error (unreadable file, geometry mismatch, ...).
function rmse(aPath, bPath) {
  const r = magick("compare", ["-metric", "RMSE", aPath, bPath, "null:"]);
  if (r.status !== 0 && r.status !== 1) {
    return { error: `compare exit ${r.status}: ${(r.stderr ?? "").trim()}` };
  }
  const m = /^([\d.eE+-]+)\s*\(([\d.eE+-]+)\)/.exec((r.stderr ?? "").trim());
  if (!m) return { error: `unparseable compare output: '${(r.stderr ?? "").trim()}'` };
  return { rmseAbs: Number(m[1]), rmse: Number(m[2]) };
}

// `-depth 8` on everything this writes: a Q16 ImageMagick emits 16-BIT PNGs by default, which every ordinary
// reader (including this repo's own decoder) then refuses. Evidence nobody can open is not evidence.
function labelStack(imgPath, text, dstPath) {
  const id = magick("identify", ["-format", "%wx%h", imgPath]);
  const w = Number((/^(\d+)x/.exec(id.stdout.trim()) || [])[1] || 200);
  const barPath = dstPath.replace(/\.png$/i, "-bar.png");
  magick("convert", ["-size", `${w}x22`, "-background", "#222", "-fill", "white", "-pointsize", "13",
    "-gravity", "center", `label:${text}`, "-depth", "8", barPath]);
  magick("convert", [barPath, imgPath, "-append", "-depth", "8", dstPath]);
  return dstPath;
}

/** ours | truth | ImageMagick's own difference image, labelled, side by side. */
function sideBySide(ourPath, truthPath, dstPath, index, metric) {
  const diffPath = dstPath.replace(/\.png$/i, "-delta.png");
  magick("compare", ["-metric", "RMSE", ourPath, truthPath, "-depth", "8", diffPath]);
  const tiles = [
    labelStack(ourPath, `harness  frame ${index}`, dstPath.replace(/\.png$/i, "-t0.png")),
    labelStack(truthPath, `truth  frame ${index}`, dstPath.replace(/\.png$/i, "-t1.png")),
    labelStack(diffPath, `delta  RMSE ${metric == null ? "?" : metric.toFixed(6)}`, dstPath.replace(/\.png$/i, "-t2.png"))
  ];
  magick("convert", [...tiles, "+append", "-depth", "8", dstPath]);
  return dstPath;
}

// ---------------------------------------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------------------------------------

let browser = null;
let closed = false;
async function shutdown() {
  if (closed) return;
  closed = true;
  if (browser) await browser.close().catch(() => {});
  await new Promise((r) => server.close(r));
}

// A refusal has to STOP the run, not annotate it: `process.exit` inside an async try would let every later
// statement keep executing against a dead harness and write screenshots nobody should trust.
class Fatal extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const die = (code, message) => { throw new Fatal(code, message); };

await new Promise((r) => server.listen(args.port, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${args.port}`;

let result = null;
let exitCode = 0;
try {
  browser = await chromium.launch({ headless: !args.headed, args: args.glArgs });
  const context = await browser.newContext({
    // The canvas is the whole viewport at DPR 1, so an element screenshot is exactly WxH device pixels and no
    // scaling ever happens between the drawing buffer and the file on disk.
    viewport: { width: args.width, height: args.height },
    deviceScaleFactor: 1
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e && e.message || e)));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  const pageUrl = `${ORIGIN}/geoclip-harness.html${args.hud ? "?hud=1" : ""}`;
  await page.goto(pageUrl, { waitUntil: "load", timeout: args.timeout });
  await page.waitForFunction(() => window.__geoclipReady === true, null, { timeout: args.timeout, polling: 100 });
  const bootError = await page.evaluate(() => window.__geoclipError || null);
  if (bootError) die(1, `the harness could not start: ${bootError}`);

  const env = await page.evaluate(() => window.__geoclip.env());

  await page.evaluate(
    ({ w, h, fit, bg }) => {
      window.__geoclip.resize(w, h);
      window.__geoclip.setFit(fit);
      window.__geoclip.setBackground(bg);
    },
    { w: args.width, h: args.height, fit: args.fit, bg: args.bg }
  );

  const summary = await page.evaluate(
    (url) => window.__geoclip.load(url).then((s) => s, (e) => ({ __error: String(e && e.message || e) })),
    `${ORIGIN}/artifact/manifest.json`
  );
  if (summary && summary.__error) die(1, `load failed: ${summary.__error}`);
  if (!summary.frames) die(1, "the manifest has no frames");

  const frames = args.all
    ? Array.from({ length: summary.frames }, (_, i) => i)
    : (args.frames ?? [0]);
  const outOfRange = frames.filter((i) => i >= summary.frames);
  if (outOfRange.length) die(2, `--frames asks for ${outOfRange.join(",")} but the clip has ${summary.frames} frames`);

  console.log("");
  console.log(`geoclip-replay  ${args.artifact}`);
  console.log(`  renderer   ${env.renderer}`);
  console.log(`  clip       ${summary.parts} parts, ${summary.frames} frames, ${summary.pages} page(s), ` +
    `${summary.triangles} triangles` + (summary.meta ? `  [${summary.meta.anim ?? "?"}]` : ""));
  console.log(`  schema     ${summary.schema ?? "?"}` +
    (summary.vertsDecoded ? `   ${summary.vertsDecoded} vertex record(s) decoded from verts.bin` : ""));
  console.log(`  canvas     ${args.width}x${args.height}   fit ` +
    `x*${args.fit.scaleX}+${args.fit.offsetX}  y*${args.fit.scaleY}+${args.fit.offsetY}`);
  console.log(`  frames     ${frames.length} (${frames.slice(0, 12).join(",")}${frames.length > 12 ? ",…" : ""})`);
  if (summary.warnings && summary.warnings.length) {
    console.log(`  WARNINGS   ${summary.warnings.length}`);
    for (const w of summary.warnings) console.log(`    ! ${w}`);
  }
  console.log("");

  const canvasEl = page.locator("#gl");
  const rows = [];
  let glErrors = 0;
  for (const index of frames) {
    const census = await page.evaluate((i) => window.__geoclip.seek(i), index);
    if (census.glError) glErrors++;
    if (census.contextLost != null) die(1, `WebGL context LOST during frame ${index}; every screenshot is void`);

    const outPath = join(args.out, expandPattern(args.namePattern, index));
    mkdirSync(dirname(outPath), { recursive: true });
    // `omitBackground` only when the caller actually asked for a transparent clear — it is what stops Chromium
    // compositing the canvas over an opaque page and handing back a fully-opaque PNG.
    await canvasEl.screenshot({ path: outPath, omitBackground: args.bg[3] < 1 });

    const row = {
      index,
      out: outPath,
      drawn: census.drawn,
      triangles: census.triangles,
      rigid: census.rigid,
      deforming: census.deforming,
      additive: census.additive,
      skipped: census.skipped,
      glError: census.glError
    };

    if (args.truth) {
      const truthPath = join(args.truth, expandPattern(args.truthPattern, index + args.truthOffset));
      row.truth = truthPath;
      if (!existsSync(truthPath)) {
        row.truthMissing = true;
      } else {
        const m = rmse(outPath, truthPath);
        if (m.error) { row.compareError = m.error; }
        else {
          row.rmse = m.rmse;
          row.rmseAbs = m.rmseAbs;
          row.sideBySide = sideBySide(outPath, truthPath, join(args.out, `sbs-${expandPattern("%04d", index)}.png`), index, m.rmse);
        }
      }
    }
    rows.push(row);
  }

  // Warnings raised while DRAWING (an unknown part id, a verts array of the wrong length) only exist after the
  // frames have run, so they are collected here rather than from the load summary.
  const runtimeWarnings = await page.evaluate(() => (window.__geoclip.stats()?.warnings ?? []));

  // ---- report ---------------------------------------------------------------------------------------------
  const head = args.truth
    ? "  frame | drawn | tris |  skipped (slot/null/part) |     RMSE |  side-by-side"
    : "  frame | drawn | tris |  skipped (slot/null/part) | screenshot";
  console.log(head);
  console.log("  " + "-".repeat(head.length - 2));
  for (const r of rows) {
    const sk = `${r.skipped.missingSlot}/${r.skipped.nullPart}/${r.skipped.unknownPart}`;
    const left = `  ${String(r.index).padStart(5)} | ${String(r.drawn).padStart(5)} | ${String(r.triangles).padStart(4)} | ` +
      `${sk.padStart(25)} | `;
    if (args.truth) {
      const metric = r.truthMissing ? "MISSING" : r.compareError ? "ERROR" : r.rmse.toFixed(6);
      console.log(left + `${metric.padStart(8)} | ${r.sideBySide ?? "-"}`);
    } else {
      console.log(left + r.out);
    }
  }

  const scored = rows.filter((r) => typeof r.rmse === "number");
  const meanRmse = scored.length ? scored.reduce((s, r) => s + r.rmse, 0) / scored.length : null;
  const maxRow = scored.length ? scored.reduce((a, b) => (b.rmse > a.rmse ? b : a)) : null;

  result = {
    schema: "geoclip-replay/1",
    when: new Date().toISOString(),
    artifact: args.artifact,
    truth: args.truth,
    truthPattern: args.truth ? args.truthPattern : null,
    truthOffset: args.truthOffset,
    out: args.out,
    canvas: { width: args.width, height: args.height },
    fit: args.fit,
    background: args.bg,
    env,
    clip: {
      parts: summary.parts, frames: summary.frames, pages: summary.pages,
      triangles: summary.triangles, meta: summary.meta ?? null,
      schema: summary.schema ?? null, vertsDecoded: summary.vertsDecoded ?? 0,
      warnings: runtimeWarnings.length ? runtimeWarnings : (summary.warnings ?? [])
    },
    glErrors,
    pageErrors: consoleErrors,
    meanRmse,
    maxRmse: maxRow ? maxRow.rmse : null,
    worstFrame: maxRow ? maxRow.index : null,
    frames: rows
  };
  const summaryPath = join(args.out, "summary.json");
  writeFileSync(summaryPath, JSON.stringify(result, null, 2) + "\n");

  console.log("");
  if (args.truth) {
    console.log(`  mean RMSE ${meanRmse == null ? "-" : meanRmse.toFixed(6)}` +
      (maxRow ? `   worst ${maxRow.rmse.toFixed(6)} @ frame ${maxRow.index}` : ""));
  }
  const newWarnings = runtimeWarnings.filter((w) => !(summary.warnings ?? []).includes(w));
  if (newWarnings.length) {
    console.log(`  ${newWarnings.length} warning(s) raised while drawing:`);
    for (const w of newWarnings) console.log(`    ! ${w}`);
  }
  if (glErrors) console.log(`  ${glErrors} frame(s) reported a GL error — treat the pictures as suspect`);
  if (consoleErrors.length) {
    console.log(`  ${consoleErrors.length} page error(s):`);
    for (const e of consoleErrors.slice(0, 5)) console.log(`    ! ${e}`);
  }
  console.log(`  summary   ${summaryPath}`);
  console.log("");
  console.log("GEOCLIP_REPLAY_RESULT " + JSON.stringify({
    artifact: result.artifact, out: result.out, canvas: result.canvas, fit: result.fit,
    schema: result.clip.schema, vertsDecoded: result.clip.vertsDecoded,
    frames: rows.map(({ skipped, ...r }) => ({ ...r, skipped })),
    meanRmse, maxRmse: result.maxRmse, glErrors, warnings: result.clip.warnings
  }));

  if (args.keepOpen) {
    console.log("");
    console.log(`--keep-open: harness at ${pageUrl}   artifact at ${ORIGIN}/artifact/manifest.json`);
    console.log("Ctrl-C (or SIGTERM) to stop.");
    // BOTH signals, and this is not belt-and-braces: Playwright installs its own SIGTERM handler that closes the
    // browser WITHOUT exiting the process, so a run waiting on SIGINT alone survives `timeout`/`kill` forever —
    // the http server keeps the event loop alive and the port stays claimed. Measured, not guessed.
    await new Promise((r) => {
      process.once("SIGINT", r);
      process.once("SIGTERM", r);
      process.once("SIGHUP", r);
    });
    console.log("");
  }
} catch (e) {
  if (e instanceof Fatal) {
    console.error(`geoclip-replay: ${e.message}`);
    exitCode = e.code;
  } else {
    console.error(`geoclip-replay: ${String(e && e.stack || e)}`);
    exitCode = 1;
  }
} finally {
  await shutdown();
}

process.exit(exitCode);
