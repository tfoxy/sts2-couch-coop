#!/usr/bin/env node
// Offline analyzer for a Chrome/CDP trace that makes the GPU PROCESS first-class — the companion to
// scripts/analyze-mirror-trace.mjs (which only attributes the renderer main thread). Use this one when the
// renderer main thread is no longer the bottleneck and the question is "what is the compositor / GPU doing?".
//
//   node scripts/analyze-gpu-trace.mjs <trace.json[.gz]> [options]
//
// It answers four questions the main-thread analyzer cannot:
//   1. WHO SATURATES — per-thread busy (wall) and CPU (tdur) for every process/thread over a window, so you can
//      see whether the renderer main thread, the renderer compositor, VizCompositorThread, CompositorGpuThread
//      or CrGpuMain is the one that is pinned.
//   2. WHAT THE GPU SIDE SPENDS IT ON — self-time per op on GPU-process threads, bucketed into upload/decode,
//      raster playback, skia prepare/execute, flush/swap, clear and scheduler overhead (buckets are name-matched;
//      the report always also prints the top UNBUCKETED ops so nothing hides behind the taxonomy).
//   3. MAIN-THREAD-BLOCKED-ON-GPU — top-level renderer-main tasks whose WALL time hugely exceeds their CPU time
//      (tdur). Chrome charges the wait to the task, so a 2000 ms task with 100 ms of CPU is a *stall*, not work.
//      For each stall the report shows what every other thread was doing inside the same span.
//   3b. RENDER-SURFACE CENSUS — how many compositor RENDER SURFACES (offscreen passes) the page costs per frame
//      and WHY (cc's `RenderSurfaceReasonCount`: blend mode / filter / backdrop scope / clip axis alignment / …).
//      Each render surface is an allocate + clear + draw + resolve on the GPU, so this is usually the first number
//      to look at when the GPU threads are pinned but raster is idle.
//   4. PRESENTED FRAMES + PER-FRAME COMPOSITE COST — presented-frame cadence from whichever marker the trace
//      carries (see --present-source), the worst presented gaps with per-gap attribution, and draw-ops-per-frame
//      (TextureOp / FillRectOp / Clear per present) which is the direct read-out of "how many compositor quads
//      does this page cost to composite".
//
// Trace requirements
//   * Thread busy + stalls: any devtools/CDP trace (needs `toplevel` or devtools.timeline events with `tdur`).
//   * GPU op detail (question 2) needs the trace to have been captured with the GPU categories:
//       toplevel,cc,gpu,viz,benchmark,disabled-by-default-gpu.service,disabled-by-default-skia.gpu
//     A plain `devtools.timeline` capture has GPU-process threads with nothing but `RunTask` on them; the report
//     says so explicitly (`no op-level detail`) instead of pretending the ops are missing because they are cheap.
//
// Memory: the trace is STREAM-parsed (brace scanner over a gunzip/read stream) into flat typed arrays, so the
// 437 MB desktop capture costs ~150 MB of heap instead of ~6 GB. .gz input is decompressed on the fly.

import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------------------------- args

function parseArgs(argv) {
  const a = {
    trace: null, from: null, to: null, fromUs: null, toUs: null, top: 12, threads: null, stalls: 5, gaps: 5,
    stallWallMs: 100, stallCpuRatio: 0.5, presentSource: "auto", presentSurface: null, op: null, json: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--from") a.from = Number(argv[++i]);
    else if (arg === "--to") a.to = Number(argv[++i]);
    else if (arg === "--from-us") a.fromUs = Number(argv[++i]);
    else if (arg === "--to-us") a.toUs = Number(argv[++i]);
    else if (arg === "--top") a.top = Number(argv[++i]);
    else if (arg === "--threads") a.threads = argv[++i];
    else if (arg === "--stalls") a.stalls = Number(argv[++i]);
    else if (arg === "--gaps") a.gaps = Number(argv[++i]);
    else if (arg === "--stall-wall-ms") a.stallWallMs = Number(argv[++i]);
    else if (arg === "--stall-cpu-ratio") a.stallCpuRatio = Number(argv[++i]);
    else if (arg === "--present-source") a.presentSource = argv[++i];
    else if (arg === "--present-surface") a.presentSurface = argv[++i];
    else if (arg === "--op") a.op = argv[++i];
    else if (arg === "--json") a.json = true;
    else if (arg === "--help" || arg === "-h") a.help = true;
    else if (!a.trace) a.trace = arg;
  }
  const relativeWindow = a.from !== null || a.to !== null;
  const absoluteWindow = a.fromUs !== null || a.toUs !== null;
  if (relativeWindow && absoluteWindow) throw new Error("--from/--to cannot be combined with --from-us/--to-us");
  if (absoluteWindow && (a.fromUs === null || a.toUs === null || !Number.isFinite(a.fromUs) || !Number.isFinite(a.toUs) || a.toUs <= a.fromUs)) {
    throw new Error("--from-us and --to-us must be finite absolute microseconds with --to-us > --from-us");
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (!args.trace || args.help) {
  console.log(`analyze-gpu-trace.mjs — GPU-process / compositing attribution for a Chrome trace

  node scripts/analyze-gpu-trace.mjs <trace.json[.gz]> [options]

  <trace.json[.gz]>       a CDP trace; .gz is streamed through gunzip
  --from <ms>             window start, ms into the trace (default: trace start)
  --to <ms>               window end, ms into the trace (default: trace end)
  --from-us <us>          absolute trace timestamp window start (requires --to-us)
  --to-us <us>            absolute trace timestamp window end (requires --from-us)
  --top N                 top-N ops per thread / per bucket (default 12)
  --threads <regex>       only report threads whose "Process/Thread" name matches (default: all)
  --stalls N              show N worst main-thread-blocked-on-GPU tasks (default 5, 0 = off)
  --stall-wall-ms <ms>    minimum wall time for a task to count as a stall candidate (default 100)
  --stall-cpu-ratio <r>   a candidate is a STALL when cpu/wall <= r (default 0.5)
  --gaps N                show N worst presented-frame gaps with attribution (default 5, 0 = off)
  --present-source <s>    auto | drawframe | swapbuffers | presentation | none (default auto)
  --present-surface <id>  exact target surface/layer id for actual presentation feedback (required for actual metrics)
  --op <regex>            extra section: per-thread totals for ops matching this regex
  --json                  also print a machine-readable ANALYSIS_RESULT {json} line
  --help                  this text

Examples
  # phone GPU capture, whole trace
  node scripts/analyze-gpu-trace.mjs .sts2/artifacts/r4-phone/C-gpu-combat-phone.json.gz
  # just the scroll window of a devtools trace, no GPU op detail available
  node scripts/analyze-gpu-trace.mjs .sts2/artifacts/r4-phone/B4-mapscroll-phone.json.gz --from 19500 --to 29000
  # where did image upload time go?
  node scripts/analyze-gpu-trace.mjs <trace> --op 'UploadImage|DecodeImage|RasterCHROMIUM'`);
  process.exit(args.help ? 0 : 2);   // an explicit --help is not an error; a missing trace is
}

// ---------------------------------------------------------------------------------------------- ingest

// Growable flat storage. One entry per retained event (ph X and ph I).
class Store {
  constructor() {
    this.n = 0;
    this.cap = 1 << 16;
    this.ts = new Float64Array(this.cap);
    this.dur = new Float64Array(this.cap);
    this.tdur = new Float64Array(this.cap);
    this.thread = new Int32Array(this.cap);
    this.name = new Int32Array(this.cap);
    this.instant = new Uint8Array(this.cap);
  }
  grow() {
    const cap = this.cap * 2;
    const f = (old) => { const next = new old.constructor(cap); next.set(old); return next; };
    this.ts = f(this.ts); this.dur = f(this.dur); this.tdur = f(this.tdur);
    this.thread = f(this.thread); this.name = f(this.name); this.instant = f(this.instant);
    this.cap = cap;
  }
  push(ts, dur, tdur, thread, name, instant) {
    if (this.n === this.cap) this.grow();
    const i = this.n++;
    this.ts[i] = ts; this.dur[i] = dur; this.tdur[i] = tdur;
    this.thread[i] = thread; this.name[i] = name; this.instant[i] = instant;
  }
}

const store = new Store();
const nameIds = new Map();
const names = [];
const internName = (s) => {
  let id = nameIds.get(s);
  if (id === undefined) { id = names.length; names.push(s); nameIds.set(s, id); }
  return id;
};
const threadIds = new Map();      // "pid:tid" -> index
const threadKeys = [];            // index -> "pid:tid"
const threadPid = [];
const internThread = (pid, tid) => {
  const key = `${pid}:${tid}`;
  let id = threadIds.get(key);
  if (id === undefined) { id = threadKeys.length; threadKeys.push(key); threadPid.push(pid); threadIds.set(key, id); }
  return id;
};
const threadNameByKey = new Map();
const procNameByPid = new Map();
const surfaceSamples = [];   // {ts, reason, count} from cc's RenderSurfaceReasonCount instants

// Stream the file and hand each ARRAY-ELEMENT JSON object (as text) to `onObject`. It tracks container nesting
// and string state rather than trusting newlines, so it works for both trace shapes Chrome/CDP writes:
//   [{...},{...}]                       (bare array)
//   {"traceEvents":[{...}],"metadata":…} (wrapper object — the metadata block is NOT an array element, so it is
//                                         skipped for free, and the 222 MB wrapper object is never materialised)
function streamObjects(path, onObject) {
  return new Promise((res, rej) => {
    const p = resolve(path);
    let stream = createReadStream(p, { highWaterMark: 1 << 22 });
    if (p.endsWith(".gz")) stream = stream.pipe(createGunzip());
    // Incremental scan state. `pos` is the index in `buf` we have already consumed — the buffer is trimmed after
    // every chunk so it never holds more than the object currently in progress (rescanning the prefix would both
    // corrupt `depth` and make the scan quadratic).
    let buf = "";
    let pos = 0;
    let nest = 0;              // container nesting depth
    let inArray = [false];     // inArray[d] = is the container opened at depth d an array?
    let start = -1;            // start index of the array-element object being captured
    let captureNest = -1;
    let inStr = false;
    let esc = false;
    stream.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const len = buf.length;
      for (; pos < len; pos++) {
        const c = buf.charCodeAt(pos);
        if (inStr) {
          if (esc) esc = false;
          else if (c === 92) esc = true;          // backslash
          else if (c === 34) inStr = false;       // "
          continue;
        }
        if (c === 34) { inStr = true; continue; }
        if (c === 123) {                                                      // {
          if (start < 0 && nest > 0 && inArray[nest - 1]) { start = pos; captureNest = nest; }
          inArray[nest++] = false;
          continue;
        }
        if (c === 91) { inArray[nest++] = true; continue; }                    // [
        if (c === 125 || c === 93) {                                           // } or ]
          nest--;
          if (c === 125 && start >= 0 && nest === captureNest) { onObject(buf.slice(start, pos + 1)); start = -1; captureNest = -1; }
          continue;
        }
      }
      // Keep only the tail we still need (an object in progress, or nothing).
      const keepFrom = start >= 0 ? start : buf.length;
      if (keepFrom > 0) {
        buf = buf.slice(keepFrom);
        pos -= keepFrom;
        if (start >= 0) start -= keepFrom;
      }
    });
    stream.on("error", rej);
    stream.on("end", () => res());
  });
}

// Retain only what the report needs: X (complete) events, I (instant) events — presented-frame markers live
// there — and the __metadata thread/process names. Everything else (async b/e/n, counters, object events) is
// rejected by a cheap substring test BEFORE JSON.parse, which is what keeps the 437 MB desktop trace tractable.
let scanned = 0;
let retained = 0;
await streamObjects(args.trace, (text) => {
  scanned++;
  const isX = text.includes('"ph":"X"');
  const isI = !isX && text.includes('"ph":"I"');
  const isMeta = !isX && !isI && text.includes('"cat":"__metadata"');
  if (!isX && !isI && !isMeta) return;
  let e;
  try { e = JSON.parse(text); } catch { return; }
  if (isMeta) {
    if (e.name === "thread_name") threadNameByKey.set(`${e.pid}:${e.tid}`, e.args?.name ?? "");
    else if (e.name === "process_name") procNameByPid.set(e.pid, e.args?.name ?? "");
    return;
  }
  if (typeof e.ts !== "number" || typeof e.name !== "string") return;
  // cc emits one instant per REASON per draw, each with a single {reason: count} arg — keep them verbatim, they
  // are the render-surface census and they are far too cheap to sample any other way.
  if (e.name === "RenderSurfaceReasonCount" && e.args) {
    for (const [reason, count] of Object.entries(e.args)) {
      if (typeof count === "number") surfaceSamples.push({ ts: e.ts, reason, count });
    }
  }
  const th = internThread(e.pid, e.tid);
  store.push(e.ts, typeof e.dur === "number" ? e.dur : 0, typeof e.tdur === "number" ? e.tdur : -1,
    th, internName(e.name), isI ? 1 : 0);
  retained++;
});

if (!store.n) {
  console.error("No usable events found in the trace.");
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------- window

let traceMin = Infinity;
let traceMax = -Infinity;
for (let i = 0; i < store.n; i++) {
  const t = store.ts[i];
  if (t < traceMin) traceMin = t;
  const end = t + store.dur[i];
  if (end > traceMax) traceMax = end;
}
const winFrom = args.fromUs ?? (args.from != null ? traceMin + args.from * 1000 : traceMin);
const winTo = args.toUs ?? (args.to != null ? traceMin + args.to * 1000 : traceMax);
const winUs = Math.max(1, winTo - winFrom);
const winMs = winUs / 1000;

const ms = (us) => Math.round((us / 1000) * 100) / 100;
const pctOf = (us) => `${((us / winUs) * 100).toFixed(1)}%`;
const pct = (arr, p) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
const overlapUs = (ts, dur) => Math.max(0, Math.min(ts + dur, winTo) - Math.max(ts, winFrom));

// Index events per thread (only those intersecting the window).
const perThread = new Map(); // threadIdx -> number[] of event indices
for (let i = 0; i < store.n; i++) {
  const ts = store.ts[i];
  const end = ts + store.dur[i];
  if (end < winFrom || ts > winTo) continue;
  const t = store.thread[i];
  let list = perThread.get(t);
  if (!list) { list = []; perThread.set(t, list); }
  list.push(i);
}

const threadLabel = (t) => {
  const key = threadKeys[t];
  const [pid] = key.split(":");
  const proc = procNameByPid.get(Number(pid)) ?? "?";
  const name = threadNameByKey.get(key) || key.split(":")[1];
  return `${proc}/${name}`;
};
const threadFilter = args.threads ? new RegExp(args.threads, "i") : null;

// ------------------------------------------------------------------------------- per-thread busy + self-time

// Sorting an index list into (ts asc, dur desc) gives strict containment order for Chrome X events.
function sortIdx(list) {
  return list.slice().sort((a, b) => (store.ts[a] - store.ts[b]) || (store.dur[b] - store.dur[a]));
}

// wall-busy = union of MAXIMAL (top-level) events, clamped to the window; cpu = their tdur, scaled by the
// clamped fraction when an event straddles the window edge. Nested children are excluded (their time is already
// inside the parent), which is what makes this a true "is this thread pinned?" number.
function threadBusy(sorted) {
  let wall = 0;
  let cpu = 0;
  let cpuKnown = 0;
  let topCount = 0;
  let curEnd = -Infinity;
  for (const i of sorted) {
    if (store.instant[i]) continue;
    const ts = store.ts[i];
    const dur = store.dur[i];
    if (ts < curEnd) continue;            // nested inside a maximal event
    curEnd = ts + dur;
    topCount++;
    const ov = overlapUs(ts, dur);
    wall += ov;
    if (store.tdur[i] >= 0 && dur > 0) { cpu += store.tdur[i] * (ov / dur); cpuKnown += ov; }
  }
  const cpuCoverage = wall ? cpuKnown / wall : 1;
  // A partial tdur trace cannot establish a CPU total. Zero-wall instant-only
  // threads are harmless and have complete (empty) CPU coverage.
  return { wall, cpu, cpuKnown, cpuCoverage, cpuAvailable: cpuKnown >= wall - 1e-9, topCount };
}

// Exact self-time per op name on one thread (containment stack), counting only events that START in the window.
function selfByName(sorted) {
  const self = new Map();
  const total = new Map();
  const count = new Map();
  const stack = [];
  const add = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v);
  const finish = (f) => { if (f.inWin) add(self, f.name, f.dur - f.childDur); };
  for (const i of sorted) {
    if (store.instant[i]) continue;
    const ts = store.ts[i];
    const dur = store.dur[i];
    while (stack.length && stack[stack.length - 1].end <= ts) finish(stack.pop());
    if (stack.length) stack[stack.length - 1].childDur += dur;
    const inWin = ts >= winFrom && ts <= winTo;
    stack.push({ name: names[store.name[i]], end: ts + dur, dur, childDur: 0, inWin });
    if (inWin) { add(total, names[store.name[i]], dur); add(count, names[store.name[i]], 1); }
  }
  while (stack.length) finish(stack.pop());
  return { self, total, count };
}

const threadStats = [];
for (const [t, list] of perThread) {
  const sorted = sortIdx(list);
  const busy = threadBusy(sorted);
  threadStats.push({ t, label: threadLabel(t), key: threadKeys[t], events: list.length, sorted, ...busy });
}
threadStats.sort((a, b) => b.wall - a.wall);

// ---------------------------------------------------------------------------------------------- GPU buckets

// Name → role buckets for GPU-process work. Order matters (first match wins). Everything that matches nothing
// lands in `other` and is printed explicitly so the taxonomy can never hide a cost.
const GPU_BUCKETS = [
  ["upload/decode", /UploadImage|DecodeImage|Decode LazyPixelRef|Decode Image|ImageUploadTask|ImageDecodeTask|createBackendTexture|TexImage|texSubImage/i],
  ["raster playback", /RasterCHROMIUM|GpuRasterBuffer::Playback|RasterizerTaskImpl|RasterTask|PaintOpBuffer/i],
  ["skia prepare", /onPrepareDraws|onPrePrepareDraws|OpsTask::onPrepare|OpsTask::onPrePrepare|onCombineIfPossible|addDrawOp|drawFilledQuad|drawTextureSet|drawEdgeAAQuad|drawPaint/i],
  ["skia execute", /OpsTask::onExecute|executeFlushInfo|GrDrawingManager::flush|flushSurfaces|FlushGpuTasks|FlushOutputSurface|DrawRenderPass|FinishPaintRenderPass/i],
  ["texture lifetime", /GrGLTexture::onRelease|BeginAccessImages|EndAccessImages|TextureLayer::PushPropertiesTo|SharedImage/i],
  ["clear/fill", /SurfaceFillContext::clear|clearAll|^Clear$/i],
  ["present/swap", /SwapBuffers|ScheduleOverlays|SurfaceControlTransaction|presentation_feedback|CheckPendingPresentationCallbacks|OnTransactionAck|Extend_VSync/i],
  ["scheduler/ipc", /Scheduler::|ThreadControllerImpl::RunTask|^RunTask$|GpuChannel|CommandBuffer|SyncToken|mojo|SimpleWatcher|EpollEvent|Graphics\.Pipeline/i],
];
const bucketOf = (name) => {
  for (const [b, re] of GPU_BUCKETS) if (re.test(name)) return b;
  return "other";
};

const GPU_THREAD_RE = /GPU Process\//i;
const gpuThreads = threadStats.filter((s) => GPU_THREAD_RE.test(s.label));
const gpuBusy = gpuThreads.reduce((a, s) => a + s.wall, 0);
const gpuCpu = gpuThreads.reduce((a, s) => a + s.cpu, 0);
const gpuCpuAvailable = gpuThreads.length > 0 && gpuThreads.every((s) => s.cpuAvailable);

// ---------------------------------------------------------------------------------------------- renderer main

const mainStat = threadStats.filter((s) => /CrRendererMain/.test(s.label))
  .sort((a, b) => b.events - a.events)[0] ?? null;
const compositorStat = threadStats.filter((s) => /Renderer\/Compositor/.test(s.label))
  .sort((a, b) => b.events - a.events)[0] ?? null;

// Top-level tasks on a thread (maximal events), for stall detection.
function topLevelTasks(sorted) {
  const out = [];
  let curEnd = -Infinity;
  for (const i of sorted) {
    if (store.instant[i]) continue;
    const ts = store.ts[i];
    const dur = store.dur[i];
    if (ts < curEnd) continue;
    curEnd = ts + dur;
    if (ts + dur < winFrom || ts > winTo) continue;
    out.push({ i, ts, dur, tdur: store.tdur[i], name: names[store.name[i]] });
  }
  return out;
}

// What every other thread did inside [ts, ts+dur] — the "who was busy while main was parked" view.
function concurrentBusy(ts, dur) {
  const from = ts;
  const to = ts + dur;
  const rows = [];
  for (const s of threadStats) {
    let wall = 0;
    let cpu = 0;
    let curEnd = -Infinity;
    for (const i of s.sorted) {
      if (store.instant[i]) continue;
      const ets = store.ts[i];
      const edur = store.dur[i];
      if (ets >= curEnd) curEnd = ets + edur; else continue;
      const ov = Math.max(0, Math.min(ets + edur, to) - Math.max(ets, from));
      if (ov <= 0) continue;
      wall += ov;
      if (store.tdur[i] >= 0 && edur > 0) cpu += store.tdur[i] * (ov / edur);
    }
    if (wall > 0) rows.push({ label: s.label, wall, cpu });
  }
  rows.sort((a, b) => b.wall - a.wall);
  return rows;
}

// Top ops (self-time) inside an arbitrary span on a set of threads.
function opsInSpan(threads, from, to, topN) {
  const agg = new Map();
  for (const s of threads) {
    const stack = [];
    const finish = (f) => {
      if (f.ts >= from && f.ts <= to) agg.set(f.name, (agg.get(f.name) ?? 0) + (f.dur - f.childDur));
    };
    for (const i of s.sorted) {
      if (store.instant[i]) continue;
      const ts = store.ts[i];
      const dur = store.dur[i];
      while (stack.length && stack[stack.length - 1].end <= ts) finish(stack.pop());
      if (stack.length) stack[stack.length - 1].childDur += dur;
      stack.push({ name: names[store.name[i]], ts, end: ts + dur, dur, childDur: 0 });
    }
    while (stack.length) finish(stack.pop());
  }
  return [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
}

const stalls = [];
if (mainStat && args.stalls > 0) {
  for (const t of topLevelTasks(mainStat.sorted)) {
    if (t.dur / 1000 < args.stallWallMs) continue;
    const cpu = t.tdur >= 0 ? t.tdur : null;
    const ratio = cpu != null && t.dur > 0 ? cpu / t.dur : null;
    if (ratio == null || ratio > args.stallCpuRatio) continue;
    stalls.push({ ...t, cpu, ratio });
  }
  stalls.sort((a, b) => (b.dur - b.cpu) - (a.dur - a.cpu));
}

// ---------------------------------------------------------------------------------------------- presents

// Submission markers. They are useful historical diagnostics, but never establish actual display presentation.
const PRESENT_SOURCES = [
  ["drawframe", (n) => n === "DrawFrame"],
  ["swapbuffers", (n) => n === "SkiaOutputSurfaceImplOnGpu::SwapBuffers"],
];
let presentSource = null;
let presentTs = [];
const wanted = args.presentSource === "auto" ? PRESENT_SOURCES : PRESENT_SOURCES.filter(([k]) => k === args.presentSource);
if (args.presentSource !== "none") {
  for (const [key, pred] of wanted) {
    const list = [];
    for (let i = 0; i < store.n; i++) {
      const ts = store.ts[i];
      if (ts < winFrom || ts > winTo) continue;
      if (pred(names[store.name[i]])) list.push(ts);
    }
    if (list.length > 2) { presentSource = key; presentTs = list.sort((a, b) => a - b); break; }
  }
}
const presentGaps = [];
for (let i = 1; i < presentTs.length; i++) presentGaps.push({ from: presentTs[i - 1], to: presentTs[i], gap: presentTs[i] - presentTs[i - 1] });
const gapVals = presentGaps.map((g) => g.gap);
const actualPresents = null; // Chrome JSON DrawFrame/feedback has no proven SurfaceFlinger display linkage.

// Per-present composite cost: count of the big skia draw ops per presented frame.
const perFrameOps = {};
if (presentTs.length > 1) {
  for (const opName of ["TextureOp", "FillRectOp", "Clear", "RasterTask", "GpuImageDecodeCache::UploadImage"]) {
    let n = 0;
    for (const s of gpuThreads.length ? gpuThreads : threadStats) {
      for (const i of s.sorted) if (names[store.name[i]] === opName && store.ts[i] >= winFrom && store.ts[i] <= winTo) n++;
    }
    if (n) perFrameOps[opName] = { count: n, perPresent: +(n / (presentTs.length - 1)).toFixed(1) };
  }
}

// ---------------------------------------------------------------------------------------------- report

console.log(`trace:        ${args.trace}`);
console.log(`events:       ${retained} retained of ${scanned} scanned objects`);
console.log(`trace span:   ${ms(traceMax - traceMin)} ms`);
console.log(`window:       ${ms(winFrom - traceMin)} .. ${ms(winTo - traceMin)} ms  (${winMs.toFixed(1)} ms)`);
console.log(`submission src: ${presentSource ?? "none found"}`);
console.log(`actual present: ${actualPresents ? `${actualPresents.provenance.source} on ${actualPresents.provenance.surface}` : "none (requires attributed feedback)"}`);
console.log("");

console.log("=== thread busy over the window (wall = union of top-level events, cpu = tdur) ===");
console.log(`  ${"process/thread".padEnd(38)} ${"events".padStart(8)} ${"wall ms".padStart(10)} ${"%win".padStart(7)} ${"cpu ms".padStart(10)} ${"%win".padStart(7)}`);
const shownThreads = threadStats.filter((s) => !threadFilter || threadFilter.test(s.label));
for (const s of shownThreads.slice(0, 24)) {
  const cpuTxt = s.cpuAvailable ? `${String(ms(s.cpu)).padStart(10)} ${pctOf(s.cpu).padStart(7)}` : `${"n/a".padStart(10)} ${"".padStart(7)}`;
  console.log(`  ${s.label.padEnd(38)} ${String(s.events).padStart(8)} ${String(ms(s.wall)).padStart(10)} ${pctOf(s.wall).padStart(7)} ${cpuTxt}`);
}
console.log("");
console.log(`  GPU process, SUM over its threads: wall ${ms(gpuBusy)} ms (${pctOf(gpuBusy)})   cpu ${gpuCpuAvailable ? `${ms(gpuCpu)} ms (${pctOf(gpuCpu)})` : "unavailable (tdur coverage)"}`);
console.log(`  (a sum over threads that run in PARALLEL — it can exceed 100%; the per-thread rows above are the`);
console.log(`   saturation signal, and the busiest single GPU thread is the one that caps the presented rate)`);
console.log("");

// --- render-surface census ------------------------------------------------------------------------------
const winSurfaces = surfaceSamples.filter((s) => s.ts >= winFrom && s.ts <= winTo);
console.log("=== render-surface census (cc RenderSurfaceReasonCount) ===");
if (!winSurfaces.length) {
  console.log("  (not in this trace — needs the `cc` category)");
} else {
  const byReason = new Map();
  for (const s of winSurfaces) {
    const cur = byReason.get(s.reason) ?? [];
    cur.push(s.count);
    byReason.set(s.reason, cur);
  }
  const rows = [...byReason.entries()].map(([reason, counts]) => ({
    reason, samples: counts.length, p50: pct(counts, 0.5), max: Math.max(...counts),
  })).sort((a, b) => b.p50 - a.p50);
  console.log(`  ${"reason".padEnd(26)} ${"per-frame p50".padStart(14)} ${"max".padStart(7)} ${"samples".padStart(9)}`);
  for (const r of rows) {
    console.log(`  ${r.reason.padEnd(26)} ${String(r.p50).padStart(14)} ${String(r.max).padStart(7)} ${String(r.samples).padStart(9)}`);
  }
  console.log("  (each non-root surface = one offscreen render pass per frame it is drawn: allocate + clear + draw + resolve)");
}
console.log("");

console.log("=== GPU-process op attribution (self-time, bucketed) ===");
if (!gpuThreads.length) {
  console.log("  (no GPU-process threads in this trace)");
} else {
  for (const s of gpuThreads) {
    const { self, count } = selfByName(s.sorted);
    const distinct = [...self.keys()];
    const onlyRunTask = distinct.every((n) => /^(RunTask|GPUTask|ThreadControllerImpl::RunTask)$/.test(n));
    console.log(`  ${s.label}  —  wall ${ms(s.wall)} ms (${pctOf(s.wall)}), ${distinct.length} distinct ops`);
    if (onlyRunTask) {
      console.log("    no op-level detail on this thread (trace lacks the gpu/viz/skia.gpu categories) — only RunTask wall time is knowable");
    }
    const buckets = new Map();
    for (const [name, us] of self) {
      const b = bucketOf(name);
      const cur = buckets.get(b) ?? { us: 0, ops: [] };
      cur.us += us;
      cur.ops.push([name, us]);
      buckets.set(b, cur);
    }
    for (const [b, v] of [...buckets.entries()].sort((x, y) => y[1].us - x[1].us)) {
      const share = s.wall ? ((v.us / s.wall) * 100).toFixed(1) : "0.0";
      console.log(`    ${b.padEnd(16)} ${String(ms(v.us)).padStart(9)} ms  (${share}% of thread wall)`);
      if (b === "other") {
        for (const [name, us] of v.ops.sort((x, y) => y[1] - x[1]).slice(0, args.top)) {
          console.log(`        ${String(ms(us)).padStart(9)} ms  ×${String(count.get(name) ?? 0).padStart(6)}  ${name.slice(0, 96)}`);
        }
      }
    }
    console.log(`    top ops by self-time:`);
    for (const [name, us] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, args.top)) {
      console.log(`        ${String(ms(us)).padStart(9)} ms  ×${String(count.get(name) ?? 0).padStart(6)}  [${bucketOf(name)}] ${name.slice(0, 88)}`);
    }
    console.log("");
  }
}

if (mainStat) {
  console.log(`=== renderer main (${mainStat.label} ${mainStat.key}) self-time ===`);
  const { self, count } = selfByName(mainStat.sorted);
  for (const [name, us] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, args.top)) {
    console.log(`  ${String(ms(us)).padStart(9)} ms  ×${String(count.get(name) ?? 0).padStart(6)}  ${name.slice(0, 88)}`);
  }
  const gate = ["Layerize", "Commit", "LayerTreeHost::DoUpdateLayers", "UpdateLayer", "PrePaint"]
    .reduce((a, n) => a + (self.get(n) ?? 0), 0);
  const wait = ["LayerTreeHost::WaitForCommitCompletion"].reduce((a, n) => a + (self.get(n) ?? 0), 0);
  console.log(`  ── compositing gate (Layerize+Commit+DoUpdateLayers+UpdateLayer+PrePaint): ${ms(gate)} ms (${pctOf(gate)} of window)`);
  console.log(`  ── WaitForCommitCompletion (main parked on the impl thread):               ${ms(wait)} ms (${pctOf(wait)} of window)`);
  console.log("");
}
if (compositorStat) {
  console.log(`=== renderer compositor (${compositorStat.label} ${compositorStat.key}) self-time ===`);
  const { self, count } = selfByName(compositorStat.sorted);
  for (const [name, us] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, args.top)) {
    console.log(`  ${String(ms(us)).padStart(9)} ms  ×${String(count.get(name) ?? 0).padStart(6)}  ${name.slice(0, 88)}`);
  }
  console.log("");
}

if (args.stalls > 0) {
  console.log(`=== main-thread stalls (top-level tasks >= ${args.stallWallMs} ms wall with cpu/wall <= ${args.stallCpuRatio}) ===`);
  if (!mainStat) console.log("  (no CrRendererMain thread found)");
  else if (!stalls.length) console.log("  none — every long main-thread task in this window was really computing");
  else {
    console.log(`  ${stalls.length} stall(s); total parked time ${ms(stalls.reduce((a, s) => a + (s.dur - s.cpu), 0))} ms`);
    for (const s of stalls.slice(0, args.stalls)) {
      console.log(`  @${ms(s.ts - traceMin)} ms  wall ${ms(s.dur)} ms  cpu ${ms(s.cpu)} ms  (${(s.ratio * 100).toFixed(1)}% cpu)  [${s.name}]`);
      for (const row of concurrentBusy(s.ts, s.dur).slice(0, 6)) {
        console.log(`      ${row.label.padEnd(38)} wall ${String(ms(row.wall)).padStart(9)} ms  (${((row.wall / s.dur) * 100).toFixed(0)}% of the stall)  cpu ${ms(row.cpu)} ms`);
      }
      const gpuOps = gpuThreads.length ? opsInSpan(gpuThreads, s.ts, s.ts + s.dur, 6) : [];
      if (gpuOps.length) {
        console.log(`      GPU ops in span: ${gpuOps.map(([n, us]) => `${n.slice(0, 46)} ${ms(us)}ms`).join(", ")}`);
      }
    }
  }
  console.log("");
}

if (presentSource && args.gaps > 0) {
  console.log(`=== submitted frames (source: ${presentSource}; not actual presentation) ===`);
  console.log(`  submissions ${presentTs.length}   fps ${(presentTs.length / (winMs / 1000)).toFixed(1)}   gap p50 ${ms(pct(gapVals, 0.5))} ms   p90 ${ms(pct(gapVals, 0.9))} ms   max ${ms(Math.max(0, ...gapVals))} ms`);
  const over = (x) => gapVals.filter((g) => g / 1000 > x).length;
  console.log(`  gaps >33ms: ${over(33)}   >50ms: ${over(50)}   >100ms: ${over(100)}   >200ms: ${over(200)}`);
  if (Object.keys(perFrameOps).length) {
    console.log(`  op EVENTS per composited frame: ${Object.entries(perFrameOps).map(([n, v]) => `${n} ${v.perPresent} (×${v.count})`).join(", ")}`);
    console.log(`  (summed over ALL GPU threads — skia records the same op on the Viz prePrepare side AND again on`);
    console.log(`   the GPU prepare/execute side, so this is an event count, not a count of unique quads; for the`);
    console.log(`   per-thread truth read the op tables above)`);
  }
  // Classify every long gap so "the worst gaps are all GPU stalls" is a counted claim, not an impression.
  const classifyGap = (g) => {
    const rows = concurrentBusy(g.from, g.gap);
    const mainRow = rows.find((r) => /CrRendererMain/.test(r.label)) ?? { wall: 0, cpu: 0 };
    const gpuWall = rows.filter((r) => GPU_THREAD_RE.test(r.label)).reduce((a, r) => Math.max(a, r.wall), 0);
    const mainWallFrac = mainRow.wall / g.gap;
    const mainCpuFrac = mainRow.cpu / g.gap;
    const gpuFrac = gpuWall / g.gap;
    let cls;
    if (mainCpuFrac > 0.5) cls = "main-cpu";                                  // the main thread really was computing
    else if (mainWallFrac > 0.7 && mainCpuFrac < 0.2) cls = "main-parked";    // parked in a blocking GPU call
    else if (gpuFrac > 0.7) cls = "gpu-only";                                 // GPU busy, main thread idle/short
    else cls = "mixed";
    return { rows, mainRow, gpuWall, cls };
  };
  const longGaps = presentGaps.filter((g) => g.gap / 1000 > 100);
  if (longGaps.length) {
    const tally = new Map();
    for (const g of longGaps) { const { cls } = classifyGap(g); tally.set(cls, (tally.get(cls) ?? 0) + 1); }
    console.log(`  cause of the ${longGaps.length} gaps >100ms: ${[...tally.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(", ")}`);
    console.log(`    main-cpu = main thread was computing | main-parked = main wall≈gap but ~no cpu (blocked in a GPU call)`);
    console.log(`    gpu-only = a GPU thread was busy >70% of the gap while the main thread was idle | mixed = neither`);
  }
  console.log(`  worst ${args.gaps} gaps:`);
  for (const g of [...presentGaps].sort((a, b) => b.gap - a.gap).slice(0, args.gaps)) {
    const { rows, mainRow, gpuWall, cls } = classifyGap(g);
    console.log(`    @${ms(g.from - traceMin)} ms  gap ${ms(g.gap)} ms  [${cls}]   mainWall ${ms(mainRow.wall)} ms / cpu ${ms(mainRow.cpu)} ms   busiest gpu thread ${ms(gpuWall)} ms (${((gpuWall / g.gap) * 100).toFixed(0)}%)`);
    console.log(`        ${rows.slice(0, 4).map((r) => `${r.label} ${ms(r.wall)}ms`).join(" | ")}`);
  }
  console.log("");
}

if (args.op) {
  const re = new RegExp(args.op, "i");
  console.log(`=== ops matching /${args.op}/i ===`);
  let any = false;
  for (const s of shownThreads) {
    const { self, total, count } = selfByName(s.sorted);
    const hits = [...self.entries()].filter(([n]) => re.test(n)).sort((a, b) => b[1] - a[1]);
    if (!hits.length) continue;
    any = true;
    console.log(`  ${s.label}`);
    for (const [name, us] of hits.slice(0, args.top)) {
      console.log(`      self ${String(ms(us)).padStart(9)} ms  total ${String(ms(total.get(name) ?? 0)).padStart(9)} ms  ×${String(count.get(name) ?? 0).padStart(6)}  ${name.slice(0, 80)}`);
    }
  }
  if (!any) console.log("  (no matches)");
  console.log("");
}

if (args.json) {
  const result = {
    trace: args.trace,
    windowMs: +winMs.toFixed(1),
    // Historical renderer submission cadence. It is deliberately distinct from actual presentation.
    presentSource,
    threads: shownThreads.map((s) => ({ label: s.label, key: s.key, events: s.events, wallMs: ms(s.wall), wallPct: +((s.wall / winUs) * 100).toFixed(1), cpuMs: s.cpuAvailable ? ms(s.cpu) : null, cpuCoverage: +s.cpuCoverage.toFixed(6) })),
    gpuProcess: gpuThreads.length ? { wallMs: ms(gpuBusy), wallPct: +((gpuBusy / winUs) * 100).toFixed(1), cpuMs: gpuCpuAvailable ? ms(gpuCpu) : null, cpuCoverage: +(gpuThreads.reduce((sum, row) => sum + row.cpuKnown, 0) / Math.max(gpuBusy, 1)).toFixed(6), threads: gpuThreads.map((s) => s.label) } : null,
    // Android WebView can host GPU threads inside its browser/application process. This is neither a
    // dedicated GPU-process CPU total nor hardware GPU utilization, so keep it separately attributed.
    webviewGpuThreads: (() => {
      const rows = threadStats.filter((s) => /\/(Chrome_InProcGpuThread|VizWebView)$/.test(s.label));
      if (!rows.length) return null;
      const cpu = rows.reduce((sum, row) => sum + row.cpu, 0);
      const cpuAvailable = rows.every((row) => row.cpuAvailable);
      return { cpuMs: cpuAvailable ? ms(cpu) : null, cpuPct: cpuAvailable ? +((cpu / winUs) * 100).toFixed(1) : null,
        cpuCoverage: +(rows.reduce((sum, row) => sum + row.cpuKnown, 0) / Math.max(rows.reduce((sum, row) => sum + row.wall, 0), 1)).toFixed(6),
        threads: rows.map((s) => ({ label: s.label, key: s.key, cpuCoverage: +s.cpuCoverage.toFixed(6) })) };
    })(),
    renderSurfaces: (() => {
      const win = surfaceSamples.filter((s) => s.ts >= winFrom && s.ts <= winTo);
      if (!win.length) return null;
      const byReason = new Map();
      for (const s of win) { const cur = byReason.get(s.reason) ?? []; cur.push(s.count); byReason.set(s.reason, cur); }
      return Object.fromEntries([...byReason.entries()].map(([r, c]) => [r, { p50: pct(c, 0.5), max: Math.max(...c), samples: c.length }]));
    })(),
    stalls: stalls.slice(0, args.stalls).map((s) => ({ atMs: ms(s.ts - traceMin), wallMs: ms(s.dur), cpuMs: ms(s.cpu), cpuRatio: +s.ratio.toFixed(3) })),
    submitted: presentSource ? {
      count: presentTs.length,
      fps: +(presentTs.length / (winMs / 1000)).toFixed(1),
      gapP50Ms: ms(pct(gapVals, 0.5)), gapP90Ms: ms(pct(gapVals, 0.9)), gapMaxMs: ms(Math.max(0, ...gapVals)),
      perFrameOps,
    } : null,
    actualPresents,
  };
  console.log("ANALYSIS_RESULT " + JSON.stringify(result));
}
