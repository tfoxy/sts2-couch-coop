#!/usr/bin/env node
// Offline analyzer for a Chrome/CDP timeline trace captured by bench-mirror-replay.mjs (`--trace <file>` →
// .sts2/bench/traces/<file>). Attributes the mirror page's CrRendererMain main-thread cost by category so the
// compositing wall (Layerize + Commit + PrePaint) and style/layout wall (UpdateLayoutTree + Layout) can be read
// and compared before/after WITHOUT re-running the game — it consumes a trace file, never the live host.
//
//   node scripts/analyze-mirror-trace.mjs <trace.json[.gz]> [--top 25] [--window B=2100-6300] [--json]
//
// What it reports:
//   * per-category SELF-time (dur minus the summed dur of nested children) on the renderer main thread,
//     grouped for the compositing / style-layout / script / gc walls, plus the top-N leaf symbols;
//   * FORCED REFLOWS (layout thrash): how many times, and for how many ms, JS synchronously provoked layout;
//   * per-commit compositing attribution: #Commit, #LayerTreeHost::DoUpdateLayers, and ms/commit for each of
//     Layerize / Commit / PrePaint;
//   * a long-task histogram: top-level RunTask buckets (<16, 16–50, 50–100, 100–200, >200 ms), counts + max;
//   * layer-ish signals if present (DoUpdateLayers count, RasterTask count).
// Every one of those metrics can be sliced into named phases of a beat with repeated `--window` flags.
//
// The self-time algorithm is the standard Chrome-trace nesting stack: X (complete) events on one thread are
// strictly nested or sequential, so sorting by (ts asc, dur desc) and maintaining a containment stack yields
// exact self-time. B/E (begin/end) pairs are folded into synthetic X events first.
//
// FORCED REFLOW definition (validated against a real capture — keep it exactly as written or the numbers move):
//   an `UpdateLayoutTree` or `Layout` event on the renderer main thread that has a `FunctionCall`,
//   `EvaluateScript` or `RunMicrotasks` ANCESTOR in that same containment stack, i.e. layout provoked from
//   inside JS rather than by the normal rendering lifecycle (a lifecycle layout hangs off RunTask/PrePaint).
//   Two details that ground truth depends on:
//     * the reported ms is the sum of each folded event's own `dur`, NOT its self-time. Self-time sums do not
//       reproduce what DevTools calls forced layout. `Layout` and `UpdateLayoutTree` never nest within each
//       other on this thread, so summing raw `dur` double-counts nothing.
//     * `--window` is start-INCLUSIVE / end-EXCLUSIVE on the folded event's `ts` (relative to trace start, =
//       the smallest positive `ts` in the whole trace). That is what makes contiguous windows partition cleanly.
//   Attribution ("who forced it") comes from the CPU-profile samples that land inside the forced-reflow spans:
//   the nearest enclosing script frame is the JS caller, the sample's own leaf is the DOM API that forced the
//   layout (`get clientWidth`, `getBoundingClientRect`, …). Needs a trace captured WITH js samples; the report
//   says so when there are none. Symbolication uses the bundle's .map when one can be found (see --source-map).

import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

function parseArgs(argv) {
  const a = { trace: null, top: 25, json: false, windows: [], sourceMap: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--top") a.top = Number(argv[++i]);
    else if (arg === "--window") a.windows.push(parseWindow(argv[++i], a.windows.length));
    else if (arg === "--source-map") a.sourceMap = argv[++i];
    else if (arg === "--json") a.json = true;
    else if (arg === "--help" || arg === "-h") a.help = true;
    else if (!a.trace) a.trace = arg;
  }
  return a;
}

// "--window B=2100-6300" (ms into the trace); the name is optional ("--window 2100-6300").
function parseWindow(spec, index) {
  const m = /^(?:([^=]+)=)?(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(spec ?? "");
  if (!m) {
    console.error(`bad --window "${spec}" — expected <name>=<startMs>-<endMs>, e.g. B=2100-6300`);
    process.exit(2);
  }
  const fromMs = Number(m[2]);
  const toMs = Number(m[3]);
  if (!(toMs > fromMs)) {
    console.error(`bad --window "${spec}" — end (${toMs}) must be greater than start (${fromMs})`);
    process.exit(2);
  }
  return { name: m[1] ?? `w${index + 1}`, fromMs, toMs };
}

const args = parseArgs(process.argv.slice(2));
if (!args.trace || args.help) {
  console.log(`analyze-mirror-trace.mjs — per-category attribution of a CDP timeline trace

  node scripts/analyze-mirror-trace.mjs <trace.json[.gz]> [--top N] [--window NAME=A-B] [--json]

  <trace.json[.gz]>   a trace written by bench-mirror-replay.mjs --trace <file>; .gz is gunzipped
  --top N             show the top-N leaf symbols by self-time (default 25)
  --window NAME=A-B   also report every metric for the window A..B ms into the trace (start-inclusive,
                      end-exclusive). Repeatable, e.g.
                        --window A=0-2100 --window B=2100-6300 --window C=6300-8000
  --source-map PATH   .js.map used to symbolicate the forced-reflow callers (default: auto-discovered
                      next to the deployed / built bundle named by the trace's CPU profile)
  --json              also print a machine-readable ANALYSIS_RESULT {json} line`);
  process.exit(args.trace ? 0 : 2);
}

// Category groupings — event names Chromium emits for each phase of the main-thread frame. NOTE: self-times are
// disjoint (a child's dur is subtracted from its parent), so summing the SELF-time of every event in a category
// double-counts nothing. `LayerTreeHost::DoUpdateLayers` + `UpdateLayer` are the bulk of the commit phase and are
// NESTED under `Commit` (verified in-trace), so they must be listed explicitly — otherwise the compositing wall
// misses ~3.5s and reads far too low. This is why an older DevTools reading called "Commit ~3.95s" (the commit
// SUBTREE total) while `Commit` self-time is only ~0.13s.
const CATEGORIES = {
  compositing: [
    "Layerize", "Commit", "LayerTreeHost::DoUpdateLayers", "UpdateLayer", "UpdateLayerTree",
    "PrePaint", "Paint", "CompositeLayers", "RasterizeAndRecordMain",
  ],
  styleLayout: ["UpdateLayoutTree", "Layout", "InvalidateLayout", "ScheduleStyleRecalculation", "ParseAuthorStyleSheet"],
  script: ["FunctionCall", "RunMicrotasks", "EvaluateScript", "v8.run", "V8.Execute", "MajorGC", "MinorGC", "GCEvent"],
};
// The compositing "commit + layerize + prepaint" self-time gate metric — the commit subtree (Commit self +
// DoUpdateLayers + UpdateLayer) plus Layerize and PrePaint, i.e. the doc's "Layerize + Commit + PrePaint".
const COMPOSITING_GATE = ["Layerize", "Commit", "LayerTreeHost::DoUpdateLayers", "UpdateLayer", "PrePaint"];
// Forced-reflow detection (see header): these events, under one of these ancestors.
const REFLOW_NAMES = new Set(["UpdateLayoutTree", "Layout"]);
const JS_ANCESTORS = new Set(["FunctionCall", "EvaluateScript", "RunMicrotasks"]);

const ms = (us) => Math.round((us / 1000) * 100) / 100;

function loadTrace(path) {
  const p = resolve(path);
  const buf = readFileSync(p);
  const text = (p.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8");
  const data = JSON.parse(text);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.traceEvents)) return data.traceEvents;
  throw new Error("unrecognized trace format (no traceEvents array)");
}

// Find the CrRendererMain thread that ran the mirror page: the renderer thread with the most timeline events.
function findRendererMain(events) {
  const nameByKey = new Map(); // "pid:tid" -> thread name
  for (const e of events) {
    if (e.cat === "__metadata" && e.name === "thread_name") {
      nameByKey.set(`${e.pid}:${e.tid}`, e.args?.name ?? "");
    }
  }
  // Count timeline events per renderer-main thread.
  const counts = new Map();
  for (const e of events) {
    const key = `${e.pid}:${e.tid}`;
    if (nameByKey.get(key) === "CrRendererMain") {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let best = null;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = key;
    }
  }
  return best;
}

// Fold B/E pairs on a thread into synthetic X events (dur = tsEnd - tsBegin).
function foldBeginEnd(threadEvents) {
  const out = [];
  const stack = [];
  for (const e of threadEvents) {
    if (e.ph === "X") {
      out.push({ name: e.name, ts: e.ts, dur: e.dur ?? 0 });
    } else if (e.ph === "B") {
      stack.push(e);
    } else if (e.ph === "E") {
      const b = stack.pop();
      if (b) out.push({ name: b.name, ts: b.ts, dur: e.ts - b.ts });
    }
  }
  return out;
}

// One containment-stack pass over the thread (see header) that annotates every event with its exact self-time,
// whether it is a JS-forced reflow, and which top-level RunTask it belongs to. Everything reported afterwards is
// a filter + fold over these records, so the whole-trace report and any `--window` slice share one definition.
function walkThread(xEvents) {
  const sorted = xEvents.slice().sort((a, b) => (a.ts - b.ts) || (b.dur - a.dur));
  const records = new Array(sorted.length);
  const tasks = []; // top-level RunTask events, in ts order
  const stack = [];
  let jsDepth = 0; // open FunctionCall/EvaluateScript/RunMicrotasks ancestors
  let taskDepth = 0;
  let openTask = -1; // index into `tasks` of the enclosing top-level RunTask
  const closeFrame = (f) => {
    records[f.index].self = f.dur - f.childDur;
    if (JS_ANCESTORS.has(f.name)) jsDepth--;
    if (f.name === "RunTask") {
      taskDepth--;
      if (taskDepth === 0) openTask = f.prevOpenTask;
    }
  };
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    while (stack.length && stack[stack.length - 1].end <= e.ts) closeFrame(stack.pop());
    if (stack.length) stack[stack.length - 1].childDur += e.dur;
    const rec = { name: e.name, ts: e.ts, dur: e.dur, self: e.dur, forced: REFLOW_NAMES.has(e.name) && jsDepth > 0, task: openTask };
    records[i] = rec;
    const frame = { name: e.name, end: e.ts + e.dur, dur: e.dur, childDur: 0, index: i, prevOpenTask: openTask };
    if (e.name === "RunTask") {
      if (taskDepth === 0) {
        openTask = tasks.length;
        tasks.push({ ts: e.ts, dur: e.dur });
        rec.task = openTask;
      }
      taskDepth++;
    }
    if (JS_ANCESTORS.has(e.name)) jsDepth++;
    stack.push(frame);
  }
  while (stack.length) closeFrame(stack.pop());
  return { records, tasks };
}

// Fold the annotated records into every reported metric, for one window (start-inclusive / end-exclusive on ts;
// -Infinity..Infinity = the whole trace).
function aggregate(records, tasks, fromUs = -Infinity, toUs = Infinity) {
  const self = new Map();
  const total = new Map();
  const count = new Map();
  const add = (map, name, v) => map.set(name, (map.get(name) ?? 0) + v);
  const forced = [];
  const forcedByTask = new Map(); // task index -> { count, us }
  for (const r of records) {
    if (r.ts < fromUs || r.ts >= toUs) continue;
    add(self, r.name, r.self);
    add(total, r.name, r.dur);
    add(count, r.name, 1);
    if (!r.forced) continue;
    forced.push(r);
    const slot = forcedByTask.get(r.task) ?? { count: 0, us: 0 };
    slot.count++;
    slot.us += r.dur; // raw dur, NOT self-time — see header
    forcedByTask.set(r.task, slot);
  }
  // Worst single task: the top-level RunTask holding the most forced reflows.
  let worstTask = null;
  for (const [taskIndex, slot] of forcedByTask) {
    const task = taskIndex >= 0 ? tasks[taskIndex] : null;
    if (!task) continue;
    if (!worstTask || slot.count > worstTask.reflows || (slot.count === worstTask.reflows && slot.us > worstTask.us)) {
      worstTask = { reflows: slot.count, us: slot.us, taskUs: task.dur, ts: task.ts };
    }
  }
  const reflow = {
    count: forced.length,
    us: forced.reduce((s, r) => s + r.dur, 0),
    byName: [...REFLOW_NAMES].map((name) => [name, forced.filter((r) => r.name === name).length]),
    spans: forced.map((r) => [r.ts, r.ts + r.dur]),
    worstTask,
  };
  const windowTasks = tasks.filter((t) => t.ts >= fromUs && t.ts < toUs);
  return { self, total, count, reflow, hist: longTaskHistogram(windowTasks) };
}

// Long-task histogram over the top-level RunTask events of a window.
function longTaskHistogram(tasks) {
  const buckets = { "<16": 0, "16-50": 0, "50-100": 0, "100-200": 0, ">200": 0 };
  let max = 0;
  let over16 = 0;
  for (const t of tasks) {
    const msDur = t.dur / 1000;
    if (msDur > max) max = msDur;
    if (msDur >= 16) over16++;
    if (msDur < 16) buckets["<16"]++;
    else if (msDur < 50) buckets["16-50"]++;
    else if (msDur < 100) buckets["50-100"]++;
    else if (msDur < 200) buckets["100-200"]++;
    else buckets[">200"]++;
  }
  return { totalTasks: tasks.length, over16, maxMs: max, buckets };
}

// ------------------------------------------------------------------- forced-reflow caller attribution (CPU profile)

// Chrome's sampling profiler rides along in the trace as one Profile + N ProfileChunk events per thread.
function extractProfile(events, pid, tid) {
  let p = null;
  for (const e of events) {
    if (e.name === "Profile" && e.pid === pid && e.tid === tid) {
      p = { id: e.id, nodes: new Map(), samples: [], deltas: [], startTime: e.args?.data?.startTime ?? 0 };
    } else if (e.name === "ProfileChunk" && p && e.id === p.id) {
      const cp = e.args?.data?.cpuProfile ?? {};
      for (const n of cp.nodes ?? []) p.nodes.set(n.id, n);
      for (const s of cp.samples ?? []) p.samples.push(s);
      for (const d of e.args?.data?.timeDeltas ?? []) p.deltas.push(d);
    }
  }
  if (!p || !p.samples.length) return null;
  p.parentOf = new Map();
  for (const [nid, n] of p.nodes) {
    if (n.parent != null) p.parentOf.set(nid, n.parent);
    for (const c of n.children ?? []) p.parentOf.set(c, nid);
  }
  // Absolute timestamp of each sample (startTime + running sum of the deltas).
  p.ts = new Array(p.samples.length);
  let t = p.startTime;
  for (let i = 0; i < p.samples.length; i++) {
    t += p.deltas[i] ?? 0;
    p.ts[i] = t;
  }
  return p;
}

// The script the page's own code came from: the most sampled http(s) .js URL in the profile.
function dominantScriptUrl(profile) {
  const hits = new Map();
  for (const [, n] of profile.nodes) {
    const url = n.callFrame?.url;
    if (url && /^https?:/.test(url) && url.split("?")[0].endsWith(".js")) hits.set(url, (hits.get(url) ?? 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [url, c] of hits) if (c > bestCount) { bestCount = c; best = url; }
  return best;
}

// This checkout plus, when it is a git worktree, the main checkout — `sts2.local.yaml` and `frontend/dist` are
// gitignored, so a worktree has neither and would otherwise never find the deployed bundle's source map.
function candidateRepoRoots() {
  const roots = [repoRoot];
  try {
    const dotGit = join(repoRoot, ".git");
    if (existsSync(dotGit) && statSync(dotGit).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
      const gitDir = m?.[1]?.trim(); // …/<main>/.git/worktrees/<name>
      const mainRoot = gitDir ? dirname(gitDir.replace(/\/worktrees\/[^/]+\/?$/, "")) : null;
      if (mainRoot && mainRoot !== repoRoot) roots.push(mainRoot);
    }
  } catch {
    // not a worktree pointer — this checkout is the only root
  }
  return roots;
}

// game.modsDir (or game.path + /mods) from sts2.local.yaml, so the deployed bundle's .map can be found without
// hardcoding a machine-specific path. Deliberately a 2-key scan, not a YAML dependency.
function modsDirFromLocalConfig(root) {
  const cfg = join(root, "sts2.local.yaml");
  if (!existsSync(cfg)) return null;
  let text;
  try {
    text = readFileSync(cfg, "utf8");
  } catch {
    return null;
  }
  const value = (key) => {
    const m = new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`, "m").exec(text);
    return m ? m[1].replace(/^["']|["']$/g, "") : null;
  };
  const modsDir = value("modsDir");
  if (modsDir) return modsDir;
  const gamePath = value("path");
  return gamePath ? join(gamePath, "mods") : null;
}

// A symbolicator for profile call frames: source-mapped when the bundle's .map is available, raw otherwise.
function makeSymbolicator(profile, explicitMapPath) {
  const scriptUrl = profile ? dominantScriptUrl(profile) : null;
  const bundle = scriptUrl ? basename(scriptUrl.split("?")[0]) : null;
  const roots = candidateRepoRoots();
  const candidates = [];
  if (explicitMapPath) candidates.push(resolve(explicitMapPath));
  else if (bundle) {
    for (const root of roots) {
      const modsDir = modsDirFromLocalConfig(root);
      if (modsDir) candidates.push(join(modsDir, "couchcoop", "frontend", "app", `${bundle}.map`));
      candidates.push(join(root, "frontend", "dist", "app", `${bundle}.map`));
    }
  }
  // source-map-js ships in the frontend's node_modules; without it (or without a .map) the report degrades to
  // raw minified frames rather than failing.
  let SourceMapConsumer = null;
  for (const root of roots) {
    try {
      ({ SourceMapConsumer } = createRequire(join(root, "frontend/"))("source-map-js"));
      break;
    } catch {
      // try the next checkout
    }
  }
  let smc = null;
  let mapPath = null;
  let mapNote = explicitMapPath
    ? `${explicitMapPath} not found — raw frames`
    : bundle ? `no .map found for ${bundle} — raw frames` : "no script frames in profile";
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    if (!SourceMapConsumer) {
      mapNote = `${c} found but source-map-js is not installed — raw frames`;
      break;
    }
    try {
      smc = new SourceMapConsumer(JSON.parse(readFileSync(c, "utf8")));
      mapPath = c;
      mapNote = c;
      break;
    } catch (err) {
      mapNote = `${c} unreadable (${err.message}) — raw frames`;
    }
  }
  const cache = new Map();
  const label = (nid) => {
    if (cache.has(nid)) return cache.get(nid);
    const n = profile?.nodes.get(nid);
    let out = "(unknown)";
    if (n) {
      const cf = n.callFrame ?? {};
      const fn = cf.functionName || "(anonymous)";
      const file = cf.url ? basename(cf.url.split("?")[0]) : null;
      if (smc && bundle && file === bundle && cf.lineNumber != null) {
        // V8 line/column are 0-based; source maps are 1-based on lines.
        const orig = smc.originalPositionFor({ line: cf.lineNumber + 1, column: cf.columnNumber ?? 0 });
        out = orig?.source
          ? `${orig.name || fn} — ${orig.source.replace(/^.*\/(src|node_modules)\//, "$1/")}:${orig.line}`
          : `${fn} @${file}:${cf.lineNumber}`;
      } else if (file) {
        out = `${fn} @${file}:${cf.lineNumber}`;
      } else {
        out = fn;
      }
    }
    cache.set(nid, out);
    return out;
  };
  return { label, mapPath, mapNote, bundle };
}

// Fold the CPU-profile samples that land inside the window's forced-reflow spans into (a) the JS caller — the
// nearest enclosing frame that has a script URL — and (b) the leaf frame, which is the DOM API that forced the
// layout. A sample's cost is the delta to the NEXT sample, clamped so one long idle gap can't dominate.
function attributeReflows(profile, spans, symbolicator, top) {
  if (!profile) return { available: false, reason: "trace has no CPU-profile samples (capture with js samples enabled)", sampledUs: 0, callers: [], leaves: [] };
  if (!spans.length) return { available: true, sampledUs: 0, callers: [], leaves: [] };
  // Merge before searching: `Layout`/`UpdateLayoutTree` are siblings here (never nested), but merging keeps the
  // binary search correct for any trace where they did overlap, and stops one sample being counted twice.
  const sorted = [];
  for (const s of spans.slice().sort((a, b) => a[0] - b[0])) {
    const last = sorted[sorted.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else sorted.push([s[0], s[1]]);
  }
  const spanAt = (t) => {
    let lo = 0;
    let hi = sorted.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid][1] <= t) lo = mid + 1;
      else if (sorted[mid][0] > t) hi = mid - 1;
      else return sorted[mid];
    }
    return null;
  };
  const callers = new Map();
  const leaves = new Map();
  let sampledUs = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const t = profile.ts[i];
    if (t < sorted[0][0] || t >= sorted[sorted.length - 1][1]) continue;
    const span = spanAt(t);
    if (!span) continue;
    // A sample owns the time until the NEXT sample, clamped to the end of the reflow it sits in (so JS that ran
    // after layout returned isn't charged to the reflow) and to 50 ms (so one idle gap can't dominate).
    const dur = Math.max(0, Math.min(profile.deltas[i + 1] ?? 0, span[1] - t, 50_000));
    if (!dur) continue;
    sampledUs += dur;
    const leaf = profile.samples[i];
    let js = leaf;
    let guard = 0;
    while (js != null && guard++ < 60) {
      const url = profile.nodes.get(js)?.callFrame?.url;
      if (url && /^https?:|^file:/.test(url)) break;
      js = profile.parentOf.get(js);
    }
    const callerLabel = symbolicator.label(js ?? leaf);
    const leafLabel = symbolicator.label(leaf);
    callers.set(callerLabel, (callers.get(callerLabel) ?? 0) + dur);
    leaves.set(leafLabel, (leaves.get(leafLabel) ?? 0) + dur);
  }
  const fold = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([name, us]) => ({ name, ms: ms(us) }));
  return { available: true, sampledUs, callers: fold(callers), leaves: fold(leaves) };
}

// ------------------------------------------------------------------------------------------------ report

const events = loadTrace(args.trace);
const mainKey = findRendererMain(events);
if (!mainKey) {
  console.error("No CrRendererMain thread found in the trace.");
  process.exit(1);
}
const [pidStr, tidStr] = mainKey.split(":");
const pid = Number(pidStr);
const tid = Number(tidStr);
// Trace start = the smallest positive ts in the WHOLE trace (all processes) — `--window` offsets are relative to
// it, which is the same origin DevTools shows.
let traceStartUs = Infinity;
for (const e of events) if (e.ts > 0 && e.ts < traceStartUs) traceStartUs = e.ts;
if (!Number.isFinite(traceStartUs)) traceStartUs = 0;
const threadEvents = events.filter((e) => e.pid === pid && e.tid === tid && (e.ph === "X" || e.ph === "B" || e.ph === "E"));
const xEvents = foldBeginEnd(threadEvents);
const { records, tasks } = walkThread(xEvents);
const profile = extractProfile(events, pid, tid);
const symbolicator = makeSymbolicator(profile, args.sourceMap);

const relMs = (ts) => Math.round((ts - traceStartUs) / 10) / 100;

function report(agg, top) {
  const catSelf = (names) => names.reduce((s, n) => s + (agg.self.get(n) ?? 0), 0);
  const commits = agg.count.get("Commit") ?? 0;
  return {
    compositingUs: catSelf(CATEGORIES.compositing),
    compositingGateUs: catSelf(COMPOSITING_GATE),
    styleLayoutUs: catSelf(CATEGORIES.styleLayout),
    scriptUs: catSelf(CATEGORIES.script),
    totalSelfUs: [...agg.self.values()].reduce((s, v) => s + v, 0),
    commits,
    doUpdateLayers: agg.count.get("LayerTreeHost::DoUpdateLayers") ?? agg.count.get("DoUpdateLayers") ?? 0,
    rasterTasks: agg.count.get("RasterTask") ?? 0,
    hist: agg.hist,
    reflow: agg.reflow,
    attribution: attributeReflows(profile, agg.reflow.spans, symbolicator, Math.min(top, 10)),
    topLeaves: [...agg.self.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([name, us]) => ({ name, selfMs: ms(us), count: agg.count.get(name) ?? 0 })),
  };
}

function printSections(agg, r, top) {
  console.log("=== main-thread self-time by category ===");
  console.log(`  compositing (Layerize+Commit+PrePaint+Paint+…):  ${ms(r.compositingUs)} ms`);
  console.log(`     └ GATE metric (Layerize+Commit+PrePaint):      ${ms(r.compositingGateUs)} ms`);
  console.log(`  style/layout (UpdateLayoutTree+Layout+…):         ${ms(r.styleLayoutUs)} ms`);
  console.log(`  script (FunctionCall+Microtasks+GC+…):            ${ms(r.scriptUs)} ms`);
  console.log(`  total self-time (all names):                      ${ms(r.totalSelfUs)} ms`);
  console.log("");
  console.log("=== forced reflows (layout thrash: UpdateLayoutTree/Layout under JS) ===");
  const byName = r.reflow.byName.map(([n, c]) => `${n} ${c}`).join(", ");
  console.log(`  forced reflows:                ${r.reflow.count}   (${byName})`);
  console.log(`  forced-reflow wall:            ${ms(r.reflow.us)} ms   (sum of each forced event's own dur; style/layout self is ${ms(r.styleLayoutUs)} ms)`);
  if (r.reflow.worstTask) {
    const w = r.reflow.worstTask;
    console.log(`  worst single task:             ${w.reflows} reflows / ${ms(w.us)} ms inside a ${ms(w.taskUs)} ms RunTask at +${relMs(w.ts)} ms`);
  } else {
    console.log("  worst single task:             (none)");
  }
  const at = r.attribution;
  if (!at.available) {
    console.log(`  attribution:                   unavailable — ${at.reason}`);
  } else if (!at.sampledUs) {
    console.log("  attribution:                   no CPU samples landed inside the forced reflows");
  } else {
    console.log(`  sampled inside reflows:        ${ms(at.sampledUs)} ms   (symbols: ${symbolicator.mapNote})`);
    console.log("  top JS callers (self-time inside forced reflows):");
    for (const c of at.callers) console.log(`    ${String(c.ms).padStart(9)} ms  ${c.name}`);
    console.log("  top forcing leaves (the DOM read/write that forced layout):");
    for (const l of at.leaves) console.log(`    ${String(l.ms).padStart(9)} ms  ${l.name}`);
  }
  console.log("");
  console.log("=== compositing per-commit ===");
  console.log(`  Commit events:                 ${r.commits}`);
  console.log(`  DoUpdateLayers events:         ${r.doUpdateLayers}`);
  console.log(`  RasterTask events:             ${r.rasterTasks}`);
  for (const name of ["Layerize", "Commit", "PrePaint", "Paint", "UpdateLayoutTree", "Layout"]) {
    const s = agg.self.get(name) ?? 0;
    const c = agg.count.get(name) ?? 0;
    const perCommit = r.commits ? ms(s) / r.commits : 0;
    console.log(`  ${name.padEnd(18)} self ${String(ms(s)).padStart(8)} ms  ×${String(c).padStart(5)}  (${Math.round(perCommit * 1000) / 1000} ms/commit)`);
  }
  console.log("");
  console.log("=== long-task histogram (top-level RunTask) ===");
  console.log(`  total tasks: ${r.hist.totalTasks}   >16ms: ${r.hist.over16}   max: ${Math.round(r.hist.maxMs)} ms`);
  console.log(`  <16: ${r.hist.buckets["<16"]}   16-50: ${r.hist.buckets["16-50"]}   50-100: ${r.hist.buckets["50-100"]}   100-200: ${r.hist.buckets["100-200"]}   >200: ${r.hist.buckets[">200"]}`);
  console.log("");
  console.log(`=== top ${top} leaf symbols by self-time ===`);
  for (const l of r.topLeaves) {
    console.log(`  ${String(l.selfMs).padStart(9)} ms  ×${String(l.count).padStart(6)}  ${l.name}`);
  }
}

function jsonFor(agg, r) {
  return {
    selfMs: {
      compositing: ms(r.compositingUs),
      compositingGate: ms(r.compositingGateUs),
      styleLayout: ms(r.styleLayoutUs),
      script: ms(r.scriptUs),
      total: ms(r.totalSelfUs),
    },
    forcedReflows: {
      count: r.reflow.count,
      ms: ms(r.reflow.us),
      byName: Object.fromEntries(r.reflow.byName),
      worstTask: r.reflow.worstTask
        ? { reflows: r.reflow.worstTask.reflows, ms: ms(r.reflow.worstTask.us), taskMs: ms(r.reflow.worstTask.taskUs), atMs: relMs(r.reflow.worstTask.ts) }
        : null,
      sampledMs: ms(r.attribution.sampledUs),
      sourceMap: symbolicator.mapPath,
      topCallers: r.attribution.callers,
      topLeafFrames: r.attribution.leaves,
    },
    perCommit: {
      commits: r.commits,
      doUpdateLayers: r.doUpdateLayers,
      rasterTasks: r.rasterTasks,
      layerizeMs: ms(agg.self.get("Layerize") ?? 0),
      commitMs: ms(agg.self.get("Commit") ?? 0),
      prePaintMs: ms(agg.self.get("PrePaint") ?? 0),
    },
    longTasks: r.hist,
    topLeaves: r.topLeaves,
  };
}

const wholeAgg = aggregate(records, tasks);
const whole = report(wholeAgg, args.top);

console.log(`trace: ${args.trace}`);
console.log(`renderer main: pid ${pid} tid ${tid}   (${xEvents.length} timeline events)`);
if (args.windows.length) {
  console.log(`windows: ${args.windows.map((w) => `${w.name}=${w.fromMs}-${w.toMs}ms`).join("  ")}   (relative to trace start ${traceStartUs} us)`);
}
console.log("");
printSections(wholeAgg, whole, args.top);

const windowResults = [];
for (const w of args.windows) {
  const agg = aggregate(records, tasks, traceStartUs + w.fromMs * 1000, traceStartUs + w.toMs * 1000);
  const r = report(agg, args.top);
  windowResults.push({ w, agg, r });
  console.log("");
  console.log(`################ window ${w.name}: ${w.fromMs}–${w.toMs} ms (${w.toMs - w.fromMs} ms) ################`);
  console.log("");
  printSections(agg, r, args.top);
}

if (args.json) {
  const result = {
    trace: args.trace,
    rendererMain: { pid, tid, events: xEvents.length },
    traceStartUs,
    ...jsonFor(wholeAgg, whole),
    windows: windowResults.map(({ w, agg, r }) => ({
      name: w.name,
      fromMs: w.fromMs,
      toMs: w.toMs,
      ...jsonFor(agg, r),
    })),
  };
  console.log("");
  console.log("ANALYSIS_RESULT " + JSON.stringify(result));
}
