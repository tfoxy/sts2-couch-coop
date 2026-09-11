#!/usr/bin/env node
// Tier (ii): the before/after CPU number for the live-tree MIRROR combat hot path.
//
// Replays a recorded combat scene-delta stream (scripts/record-mirror-stream.mjs) into a REAL headless
// Chromium running the ACTUAL mirror page, and measures the main-thread cost via CDP Performance metrics.
// The WebSocket is faked in-page (no live game needed) so the SAME recording drives every run — the only
// variable is the code the dev server serves. That is the invariant that makes before/after comparable.
//
//   # 1. start a dev server that serves THE CODE UNDER TEST (this worktree):
//   cd <checkout>/frontend && npm run dev -- --port 5174
//   # 2. run the bench against it:
//   node scripts/bench-mirror-replay.mjs --url http://127.0.0.1:5174 --repeats 5
//   node scripts/bench-mirror-replay.mjs --url http://127.0.0.1:5174 --pace=max --repeats 3
//   COUCHCOOP_CPU_THROTTLE=6 node scripts/bench-mirror-replay.mjs --url http://127.0.0.1:5174 --repeats 3
//   node scripts/bench-mirror-replay.mjs --url http://127.0.0.1:5174 --hover-sweep --repeats 3
//
// IMPORTANT: the --url dev server must serve the checkout being measured. To compare branch A vs B, run one
// dev server per checkout (different ports) and point --url at each; NEVER re-record the stream between runs.
//
// Effects (WebGL shaders/particles) are OFF by default: headless Chromium uses SwiftShader, so those effects
// burn CPU that on real hardware is GPU work — measuring them here would be misleading. Pass --effects=on for
// a headed/GPU run where you want them included.

import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { startProcMemSampler, formatProcMem, procMemMb } from "./lib/proc-mem.mjs";
import { ACTIVE_TRACE_WINDOW, traceWindowForOptions, markerWindowOrError } from "./bench-trace-lifecycle.mjs";
import { resolveAssetRequest } from "./serve-res-root.mjs";
import { BENCH_ASSET_FAMILIES, isBenchAssetRoute } from "./lib/bench-asset-route.mjs";
import { effectiveConnectPageUrl, selectConnectBenchPageIndex } from "./lib/connect-bench-page.mjs";
import { computeCpuBlock } from "./lib/trace-cpu-block.mjs";
import { checkPresence } from "./lib/screenshot-presence.mjs";
import { buildGeometry, buildPerfReport, sameGeometry } from "./lib/perf-report-envelope.mjs";
import { requireReproHeader } from "./lib/repro-recording.mjs";
import { RECOVERED_RESOURCE_ROOT, REPO_ROOT } from "./lib/repo-layout.mjs";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

// ---------------------------------------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------------------------------------

// R10-PERF6 WS-P2 — where `--res-root` reads real game assets from (the same local extracted-resource root
// scripts/probe-particle-vfx-replay.mjs serves `/res/**` out of). See the flag's help text for why a PAINT
// bench is meaningless without it.
const DEFAULT_RES_ROOT = RECOVERED_RESOURCE_ROOT;

// --flight-liveness thresholds, DERIVED FROM THE MEASURED A/B rather than assumed — see the note below, which is
// the whole reason they are not the 120ms/30 a 60fps client would want.
//
// Measured on `.sts2/bench/r11-reshuffle-30.ndjson --window 5600:8900`, 3 repeats each, this harness:
//
//   replay working  (hints on the wire)   maxStillMs 162-243   median distinctPositions 9-10   flightsArmed 26
//   --drop-card-flights (stuck gate)      maxStillMs 1646-1649 median distinctPositions 2      flightsArmed 0
//
// WHY NOT 120ms. The sampler reads `getComputedStyle().transform`, which resolves a compositor-driven WAAPI
// animation at the MAIN THREAD's current animation time — so it advances once per main-thread frame, not once per
// display frame. This page (3,000 mirror nodes at 2100x900 on SwiftShader) runs its main thread at ~20fps, which
// puts a floor of ~50ms under every gap and a ceiling of ~10 on distinctPositions no matter how smooth the card
// actually is on screen. The metric is therefore a LOWER BOUND on a compositor flight's smoothness, and its
// thresholds have to be read against the environment's own frame period. What it still does, decisively, is
// separate "the client is replaying" from "the client is watching the wire": a factor of ~7 on stillness and ~5
// on distinct positions, with the defaults sitting in the middle of that gap.
//
// On a fast client (a real 60fps device, a lighter page) raise the bar with `--flight-still-ms 120` to get the
// assertion FL-DESIGN specified.
const FLIGHT_DEFAULT_MAX_STILL_MS = 600;
const FLIGHT_MIN_DISTINCT = 5;

// R15/WP-B — the port the connect-mode asset/recording server listens on when `--connect-cdp` is used without an
// explicit `--serve-port`. It is only ever bound on 127.0.0.1 (a phone reaches it through `adb reverse`).
const DEFAULT_SERVE_PORT = 8123;

// Browser callbacks passed directly to Playwright. Keep the marker window independent of renderer internals:
// the harness only resets its own observations and brackets the page clock for trace correlation.
function beginActiveMarkerWindowInPage(input) {
  if (Array.isArray(window.__benchLongTasks)) window.__benchLongTasks.length = 0;
  if (Array.isArray(window.__benchLoaf)) window.__benchLoaf.length = 0;
  if (Array.isArray(window.__benchTicks)) window.__benchTicks.length = 0;
  if (Array.isArray(window.__benchFrameGaps)) window.__benchFrameGaps.length = 0;
  if (Array.isArray(window.__benchSceneAckLatencies)) window.__benchSceneAckLatencies.length = 0;
  if (Array.isArray(window.__benchSceneAckPending)) window.__benchSceneAckPending.length = 0;
  if (input.marker) console.timeStamp(input.marker);
  return document.querySelectorAll(".mirror-node").length;
}

function endActiveMarkerWindowInPage(input) {
  if (input.marker) console.timeStamp(input.marker);
  return performance.now();
}

function idleMarkerWindowInPage(input) {
  if (input.label === "cc-idle-start" && Array.isArray(window.__benchFrameGaps)) window.__benchFrameGaps.length = 0;
  const at = performance.now();
  console.timeStamp(input.label);
  try { performance.mark(input.label); } catch { /* older engines */ }
  if (input.label === "cc-idle-end") window.__benchIdleFrameGaps = [...(window.__benchFrameGaps ?? [])];
  return at;
}

function parseArgs(argv) {
  const a = {
    url: process.env.COUCHCOOP_BENCH_URL ?? "http://127.0.0.1:5173",
    pace: "recorded",
    ackPacedMs: null,
    dropCardFlights: false,
    flightLiveness: false,
    flightStillMs: FLIGHT_DEFAULT_MAX_STILL_MS,
    repeats: 5,
    recording: process.env.COUCHCOOP_BENCH_RECORDING ?? null,
    effects: false,
    effectMode: null,
    headed: false,
    viewport: { width: 2100, height: 900 },
    dpr: null,
    procMem: false,
    traceGpu: false,
    hoverSweep: false,
    trace: null,
    layers: false,
    layerDetail: false,
    census: false,
    churnCensus: false,
    noReportShot: false,
    handParity: false,
    quality: "high",
    cull: false,
    idle: null,
    idleShots: null,
    idleShotGapMs: 600,
    animAudit: false,
    animAuditOut: null,
    query: null,
    resRoot: null,
    assetCacheRoot: null,
    gpu: "auto",
    revealBurst: false,
    revealShot: null,
    revealNode: "MapScreen",
    report: null,
    limitMs: null,
    window: null,
    // `--window auto` defers the bracket to the recording's own meta.derived.suggestedWindow, which cannot be
    // read until the recording is loaded (below) — so the flag only records the intent here.
    windowAuto: false,
    paintDump: null,
    hitGrid: null,
    hitGridStep: 96,
    raiseProbe: null,
    connectCdp: null,
    keepConnectedPage: false,
    servePort: DEFAULT_SERVE_PORT,
    reportScenario: null,
    reportLabel: null,
    reportEnvKind: "ci",
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const [key, inlineVal] = eq > 0 && arg.startsWith("--") ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, null];
    const val = () => inlineVal ?? argv[++i];
    switch (key) {
      case "--url": a.url = val(); break;
      case "--pace": a.pace = val(); break;
      case "--ack-paced": a.ackPacedMs = Number(val()); a.pace = "max"; break;
      case "--drop-card-flights": a.dropCardFlights = true; break;
      case "--flight-liveness": a.flightLiveness = true; break;
      case "--flight-still-ms": a.flightStillMs = Number(val()); a.flightLiveness = true; break;
      case "--repeats": a.repeats = Number(val()); break;
      case "--recording": a.recording = val(); break;
      case "--effects": a.effects = /^(on|1|true|yes)$/i.test(String(val())); break;
      // A mode implies effects ON: `--effect-mode static` with the runtimes off would be a cell that measures
      // nothing and labels itself "static".
      case "--effect-mode": a.effectMode = String(val()).toLowerCase(); a.effects = true; break;
      case "--headed": a.headed = true; break;
      case "--gpu": a.gpu = String(val()).toLowerCase(); break;
      case "--viewport": {
        const m = /^(\d+)x(\d+)$/i.exec(String(val()));
        if (m) a.viewport = { width: Number(m[1]), height: Number(m[2]) };
        break;
      }
      // R7 W1-I1e — the phone's deviceScaleFactor, so a host cell can be compared with a device cell at all.
      // A number, not a device preset: the round-6 phone matrix ran at dpr 3.4876, and rounding it to 3 would
      // change the backing-store area by 35%.
      case "--dpr": a.dpr = Number(val()); break;
      // R7 W1-I1d.
      case "--proc-mem": a.procMem = true; break;
      // R7 W1-I1g.
      case "--trace-gpu": a.traceGpu = true; break;
      case "--hover-sweep": a.hoverSweep = true; break;
      case "--trace": a.trace = val(); break;
      case "--layers": a.layers = true; break;
      case "--layer-detail": a.layers = true; a.layerDetail = true; break;
      case "--census": a.census = true; break;
      case "--churn-census": a.churnCensus = true; break;
      case "--no-report-shot": a.noReportShot = true; break;
      case "--hand-parity": a.handParity = true; break;
      case "--shot": a.shot = argv[++i]; break;
      case "--shot-force": a.shotForce = true; break;
      case "--dom-styles": a.domStyles = resolve(val()); break;
      case "--paint-dump": a.paintDump = resolve(val()); break;
      case "--hit-grid": a.hitGrid = resolve(val()); break;
      case "--raise-probe": a.raiseProbe = resolve(val()); break;
      case "--hit-grid-step": a.hitGridStep = Number(val()); break;
      case "--quality": a.quality = val(); break;
      case "--cull": a.cull = true; break;
      case "--idle": a.idle = Number(val()); break;
      case "--idle-shots": a.idleShots = resolve(val()); break;
      case "--idle-shot-gap": a.idleShotGapMs = Number(val()); break;
      case "--anim-audit": a.animAudit = true; break;
      case "--anim-audit-out": a.animAudit = true; a.animAuditOut = resolve(val()); break;
      case "--query": a.query = String(val()).replace(/^[?&]/, ""); break;
      case "--res-root": {
        // Bare `--res-root` means "the default resource root"; a following non-flag word is a custom root.
        const next = argv[i + 1];
        a.resRoot = inlineVal ?? (next != null && !next.startsWith("--") ? argv[++i] : DEFAULT_RES_ROOT);
        break;
      }
      case "--asset-cache-root": a.assetCacheRoot = resolve(val()); break;
      case "--report": a.report = resolve(val()); break;
      case "--limit-ms": a.limitMs = Number(val()); break;
      case "--window": {
        // <startMs>:<endMs> on the RECORDING's own clock (see the flag's help text), or the literal `auto`.
        const raw = String(val()).trim();
        if (raw.toLowerCase() === "auto") { a.windowAuto = true; a.window = null; break; }
        const m = /^(\d+):(\d+)$/.exec(raw);
        if (!m) { console.error("--window must be <startMs>:<endMs> (e.g. --window 8200:9600) or 'auto'"); a.help = true; break; }
        a.window = { startMs: Number(m[1]), endMs: Number(m[2]) };
        break;
      }
      case "--connect-cdp": a.connectCdp = String(val()); break;
      case "--keep-connected-page": a.keepConnectedPage = true; break;
      case "--serve-port": a.servePort = Number(val()); break;
      case "--report-scenario": a.reportScenario = String(val()); break;
      case "--report-label": a.reportLabel = String(val()); break;
      case "--report-env": a.reportEnvKind = String(val()); break;
      case "--reveal-burst": a.revealBurst = true; break;
      case "--reveal-shot": a.revealBurst = true; a.revealShot = resolve(val()); break;
      case "--reveal-node": a.revealNode = String(val()); break;
      case "--help": case "-h": a.help = true; break;
      default: console.error(`Unknown argument: ${arg}`); a.help = true;
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`bench-mirror-replay.mjs — replay a recorded mirror combat stream into headless Chromium + CDP metrics

  --url <origin>        dev server serving THE CODE UNDER TEST (default http://127.0.0.1:5173,
                        env COUCHCOOP_BENCH_URL). For this worktree:
                          cd frontend && npm run dev -- --port 5174   then   --url http://127.0.0.1:5174
  --pace <mode>         recorded (default; deliver at recorded timestamps, ignore acks) | max
                        (credit-gated: next scene-delta only after scene-ack — max consumption rate)
  --ack-paced <ms>      THE PHONE'S WIRE, headless. Implies --pace max, then holds each delivery until <ms>
                        AFTER the page's scene-ack instead of resuming the credit loop synchronously. Both
                        the recording and record-mirror-stream.mjs ack instantly by design, so a desktop
                        replay runs at ~29Hz and cannot expose anything that only breaks when deltas arrive
                        slowly. A phone's credit-gated socket coalesces to 4-8Hz; --ack-paced 150 reproduces
                        that shape. Do NOT also model server-side coalescing: the recording IS a coalesced
                        stream and re-coalescing it double-counts.
  --drop-card-flights   strip cardFlights[] from every delivery — the STUCK-PRODUCER-GATE wire, without
                        needing a poisoned host. The client then has no hint to replay, so the flight VFX
                        nodes move only as fast as their streamed transforms arrive. This is the "before"
                        leg of the flight-liveness A/B, and with --ack-paced it is the phone's actual
                        traced behaviour.
  --flight-liveness     sample every [data-node-type$="NCardFlyShuffleVfx"] element's computed transform at
                        30Hz for the whole replay and assert the cards never stall: per element, the largest
                        gap between two position changes WHILE IT WAS TRAVELLING (so the pre-launch park and
                        the post-landing hold, which are correct stillness, are not scored). A replayed
                        flight moves every sampled frame (~33ms gaps); an ack-gated streamed one plateaus for
                        130-570ms. Fails the run (exit 1) on maxStillMs >= --flight-still-ms (default
                        ${FLIGHT_DEFAULT_MAX_STILL_MS}) or a median distinctPositions below ${FLIGHT_MIN_DISTINCT}.
                        Costs a forced style recalc 30x/s, so it is opt-in and not something to leave on for a
                        CPU number.
                        R14: also arms a DISCARD-liveness gate (no separate flag) — the element selector above
                        only ever sees the shuffle flier, never the discard fly (which moves the real NCard), so
                        when the recording carries a discard-kind cardFlights[] hint this instead asserts
                        walkStats.discardFlightsArmed increased (>0) across the replay, reusing the counter
                        rather than sampling a second element. SKIPped under --drop-card-flights (nothing can
                        arm) or when the recording carries no discard hints; otherwise PASS/FAIL, same exit-1
                        contract as the shuffle gate above.
  --flight-still-ms <n> the --flight-liveness stall threshold (implies it). The default is derived from THIS
                        harness's measured replay-vs-stuck-gate A/B, and it is deliberately loose because the
                        sampler reads a compositor animation through the MAIN thread — see the constant's note.
                        On a 60fps client use 120, which is the number the round's design specified.
  --repeats <n>         measured repeats, fresh page each, report medians (default 5)
  --recording <path>    NDJSON recording (default: env COUCHCOOP_BENCH_RECORDING, else newest .sts2/bench/*.ndjson)
  --effects <on|off>    include WebGL shaders/particles (default off — SwiftShader fakes GPU cost as CPU).
                        ON means DYNAMIC: it is the worst case, not the shipping one (see --effect-mode).
  --effect-mode <m>     dynamic | static | half | quarter — the EFFECT QUALITY MODE both runtimes run in, and
                        it implies --effects on. This is the settings panel's own tri-state plus its two
                        reduced-resolution dynamic variants, driven through the levers the panel already reads
                        (?shaders=<m>&particles=<m>, quality.ts effectModeParam), so a bench cell and a viewer
                        who picked the same mode are running the same code.
                        WHY IT MATTERS FOR M2: the product default is STATIC on both families, where an effect
                        draws ONCE and the stage's steady-state upload cost is zero. '--effects on' alone runs
                        DYNAMIC, so a table built only from it prices a mode nobody ships. Run both.
                        'half'/'quarter' are dynamic-half / dynamic-quarter — gsw shrinks the effect's own
                        offscreen target (1/4, 1/16 the pixels); the STAGE keeps its size either way.
  --headed              launch a REAL (non-headless) chromium. THE COMPOSITOR AND THE GPU ARE THE POINT: with
                        --gpu vulkan this is the only arm that measures the driver, the compositor and the
                        vsync a viewer actually gets — headless chromium composites off-screen and, on this
                        box, still resolves WebGL to ANGLE/SwiftShader unless told otherwise. Needs a display
                        (DISPLAY / WAYLAND_DISPLAY, or wrap the command in xvfb-run).
                        Pair with --gpu vulkan; --headed alone still leaves the GL backend on 'auto'.
  --gpu <mode>          which GL the LAUNCHED browser gets. auto (default) = this harness's long-standing rule:
                        --disable-gpu with effects off, no flag with effects on. THE TRAP: "no flag" is not a
                        real GPU — headless chromium still resolves to ANGLE/SwiftShader, so an effects-ON run
                        left on 'auto' rasterises in software and its COLOURS are not the ones a viewer sees.
                        Pass 'vulkan' (--use-angle=vulkan) for the real adapter; any VISUAL gate on the canvas
                        stage with effects on must. 'swiftshader' pins the software path explicitly.
  --viewport <WxH>      viewport (default 2100x900 — widened stage >16:9, matching the baseline trace)
  --dpr <n>              devicePixelRatio for the LAUNCHED browser's context (default: the host's own, 1 here).
                        WHY A HOST MEMORY CELL NEEDS IT: every backing store on the page scales with dpr^2, so a
                        host run at 1 and the round-6 phone matrix at 3.4876 differ by ~12x in canvas bytes and
                        are not the same experiment. Pass the DEVICE's actual value, unrounded. REFUSED under
                        --connect-cdp, where the tab's DPR is the device's own (reported as config.devicePixelRatio).
  --proc-mem             sample /proc for the launched Chrome tree's VmRSS, bucketed by process TYPE
                        (browser / gpu / renderers / utility), every 500ms; report the settled reading and the
                        peak. THE REASON THIS EXISTS: the process Android's lowmemorykiller took in round 6 was
                        the GPU PROCESS, and every instrument this repo had pointed at a different one.
                        HONESTY LIMIT: VmRSS is a LOWER BOUND on GPU-process cost — driver and kernel
                        allocations largely are not resident in the process's own address space. Rising is
                        evidence; flat is not evidence of absence. See scripts/lib/proc-mem.mjs.
                        REFUSED under --connect-cdp (the processes are on the phone — use the .procs capture in
                        scripts/bench-phone-canvas-ab.sh).
  --trace-gpu           add the GPU categories analyze-gpu-trace.mjs needs for op-level detail
                        (toplevel,gpu,viz,benchmark,disabled-by-default-gpu.service,disabled-by-default-skia.gpu;
                        cc is already in the default set). Requires --trace or --report — on its own it would be
                        a silent no-op and the analyzer's "no op-level detail" would read as "the GPU was cheap".
                        MEMORY HAZARD: without --report the trace is buffered as ONE STREAM and written whole, so
                        these categories can make a 30s capture hundreds of MB. Prefer a short --limit-ms window,
                        or --report (which filters events on arrival and writes incrementally).
  --quality <tier>      mirror render tier in the page URL (default high; use 'static' for a phone-representative run)
  --cull                enable off-screen leaf culling (candidate C1) via ?cull=on (default off)
  --hover-sweep         drive ~60Hz mousemoves across the stage during replay (exercises input hover)
  --trace <file>        write a CDP timeline trace to .sts2/bench/traces/<file>
  --layers              snapshot compositor layer count + reasons after settle
  --layer-detail        --layers plus ONE LINE PER LAYER, in the compositor's own order (which is paint
                        order): size, Mpx, paintCount, drawsContent, the layer's compositingReasons and
                        the DOM element it resolves to (tag.class + the tail of its data-node-path).
                        The order is the point: an 'Overlap' layer exists because something composited was
                        painted BEFORE it, so the aggregate histogram alone can never say WHICH promoter
                        opened a cascade — only the ordered list can (see the R15/WS-2 finding that a
                        transform-family compositing reason makes a layer's overlap rect UNBOUNDED, so
                        every non-mergeable chunk painted after it is promoted regardless of geometry).
  --hand-parity         turn on the renderer's hand-card PARITY gauge (?handParity=1) and report, per node,
                        where the client's replayed tween ENDED versus where the game said the card should
                        be. A tween settle is the only moment the two can be compared: the client has just
                        finished the hint, and the producer has resumed streaming the real pose. Prints the
                        settle count, how many drifted, mean/max drift in design px and the worst offenders.
                        Drift SHOULD be zero — a non-zero max is the "cards jump when the transition ends"
                        defect, and a card that only ever appears with drift is one that got stranded.
  --shot <file>         post-settle full-page screenshot from repeat #1 (visual-parity evidence for A/B runs).
                        On ?stage=canvas this writes the STAGE's own pixels (via the paint-dump-gated
                        __mirrorCanvasSnapshot seam — add --query 'paintDump=1') and the page screenshot beside
                        it as <file>.overlay.png. Without the seam it REFUSES rather than write a blank PNG.
  --shot-force          write the page screenshot even when the canvas arm refused (stage pixels ABSENT)
  --dom-styles <file>   post-settle DOM STYLE dump from repeat #1: one line per stage element, prefixed
                        'V ' (visible ancestry) or 'H ' (it or an ancestor computes display:none), then
                        keyed by data-node-id (or tag.class), with its inline declaration serialized as
                        SORTED key:value pairs — a text-diffable parity oracle for an A/B run that
                        pixel-compares badly because of free-running spine/particle canvases. The V/H
                        prefix makes "the diff is confined to hidden-ancestry lines" mechanically checkable
                        (diff a.txt b.txt | grep "^[<>] V "  must come back empty).
  --paint-dump <file>   post-settle PAINT DUMP from repeat #1 — the canvas-vs-DOM parity gate's currency. One
                        line per painted thing, in paint order, in ONE format both backends can be asked for:
                          C <i> <nodeId> <kind> role=… m=<6 floats> wh=… src=… rgba=… blend=… tex=… clip=…
                          K <clipperId> rect=… radius=… outset=… scope=…      (a clip scope opening)
                          O <order> <nodeId> <kind> m=… wh=…                  (a Wave-2 overlay surface)
                        On ?stage=canvas the lines come STRAIGHT off the draw list (window.__mirrorDrawListDump,
                        canvasRenderer.ts). On the DOM stage they are DERIVED by walking .mirror-stage with the
                        same hidden-ancestry classifier --dom-styles uses: element order is paint order, the
                        global affine is composed down the offsetParent chain, texture identity comes off
                        background-image / <canvas> / <img>, blend off mix-blend-mode, and the clip scope off
                        the nearest overflow:hidden ancestor. Diff two dumps with
                        scripts/compare-paint-dumps.mjs. Run BOTH arms at the SAME --viewport; 1920x1080 is the
                        default gate (no re-layout in force on either backend). A wider pair is a legitimate run
                        — both backends spread out of the same module — but needs --any-viewport to compare.
  --hit-grid <file>     post-settle HIT-TEST GRID from repeat #1: every --hit-grid-step CSS px across the stage,
                        the renderer's own seams (touchStackAt / spreadPainterAt / mapNodeAt) are asked what is
                        under the point and the verdict is written as one line per sample. Works on BOTH
                        backends (both implement the seams), so the canvas arm can be diffed against the DOM
                        arm with scripts/compare-hit-grids.mjs. Same same-viewport rule as --paint-dump; a
                        WIDE pair is the run that proves the input inverse agrees with the painter.
  --hit-grid-step <px>  --hit-grid sample spacing in CSS px (default 96 => ~11x6 = 220 samples at 1920x1080).
  --raise-probe <file>  post-settle READABLE-HAND RAISE working from repeat #1, as JSON, in a shape BOTH stage
                        backends answer. On ?stage=canvas it is window.__mirrorRaiseProbe() (every term the
                        creature-HUD measurement used, which of them fell back, the parent's own scale, and
                        where the group is drawn); on the DOM stage it is DERIVED in-page from the cosmetic
                        translate those elements already carry, so the DOM backend needs no probe code of its
                        own. Run BOTH arms with --query raiseHand=on and diff the two files.
  --census              Stage-0 census after settle (no perf perturbation): offscreen-leaf %, element-kind
                        counts, the VISIBLE-vs-HIDDEN-ancestry element split (+ hidden subtree roots and the
                        renderer's dormant counters when present), drawImage-by-canvas, syncCanvasSize
                        forced-layout hazards (canvas clientW/H reads / webgl getContext / ResizeObserver),
                        and WebGL shader compile counts + wall.
                        For the shader/compile counts pass --effects=on on a real-GPU host (SwiftShader here).
  --no-report-shot     Skip the automatic report screenshot (Android WebView screenshots reset CDP metrics).
  --churn-census        PER-WALK element churn: over the measured window, the totals for the renderer's already
                        published createEl / adoptions / condemnedSwept / removedRecords counters, plus the
                        thing totals cannot say — the LARGEST single-walk createEl burst, the walkMs of THAT
                        walk, and the top 10 walks by createEl (index, mode, walkMs, time) so a reviewer can
                        see whether the cost is one spike or spread across the replay. The headline number for
                        a DOM-reuse round: a pool has to flatten the peak, not just the sum.
                        Samples on the renderer's own once-per-reconcile lastWalkMs write rather than polling
                        (a frame can carry several walks and a walk can miss a frame), so the per-walk split is
                        exact. UNLIKE --census/--layers/--reveal-burst this one runs INSIDE the measured window
                        — that is where the walks are — so it is not perturbation-free: ~10 subtractions and 9
                        preallocated typed-array stores per walk, no allocation and no DOM/style reads. Do not
                        A/B a --churn-census run's busy% against a run without it.
                        The keyframe build lands BEFORE the window opens (the readiness gate is >50 mirror
                        nodes) and is reported separately as firstBuild — it is page load, not churn.
  --idle <ms>           after the stream settles, hold an INSTRUMENTATION-FREE idle window (no input, no
                        evaluate, no screenshot, no CDP domain enable) bracketed by the trace markers
                        cc-idle-start / cc-idle-end. Combine with --trace: inside that window a page whose
                        idle animations are compositor-only must produce ZERO UpdateLayoutTree / Layerize /
                        Commit / PrePaint on the renderer main thread (see scripts/assert-idle-compositing.mjs).
  --idle-shots <prefix> two viewport screenshots <prefix>-a.png / <prefix>-b.png, taken in the still-idle TAIL
                        right AFTER cc-idle-end (a screenshot forces a compositor frame, so it must not land
                        inside the window whose frame count is asserted). Markers: cc-shot-a / cc-shot-b.
  --idle-shot-gap <ms>  gap between the two idle screenshots (default 600)
  --anim-audit          after settle, dump every element with a running CSS animation: identity (tag +
                        data-godot-* + class), animation-name, animated properties, resolved + raw @keyframes,
                        bounding rect, and for EACH ancestor up to .mirror-stage the computed filter /
                        mix-blend-mode / opacity / will-change / backdrop-filter / transform-style / contain
                        (+ a "suspicious" digest). Also probes the compositor layer tree for layers whose
                        compositingReasons name an active animation. JSON to stdout unless --anim-audit-out.
  --anim-audit-out <f>  write the --anim-audit JSON to <f> instead of stdout (implies --anim-audit)
  --query <k=v&…>       extra query parameters appended to the page URL (e.g. 'spineMode=off' to keep a
                        replay run off the live host's /spines still-render path)
  --res-root [dir]      serve '/res/**' from an extracted resource root on disk (default:
                        ${DEFAULT_RES_ROOT})
                        instead of letting it proxy to a game that isn't running. REQUIRED for any PAINT
                        measurement: with the proxy dead every atlas request 404s, so the page paints no
                        images at all and the trace records ~4 PaintImage events instead of ~3,600 — the
                        entire paint story is invisible and an A/B on it is meaningless. Costs CPU (real
                        decodes), so leave it OFF for script-wall comparisons to stay comparable with
                        every historical run.
  --asset-cache-root <dir>
                        optional SpirectlAssetBinaryCache.RootPath. Missing recovered resources and generated
                        ?format=png/json requests read its production SHA-256 blobs and paired .meta MIME;
                        this is read-only and never synthesizes a raster on a cache miss.
  --reveal-burst        AFTER everything else (measured window, census, shot, dom-styles — so no headline
                        number moves), inject a synthetic scene-delta that flips the closed MapScreen subtree
                        root to visible:true and MEASURE that reveal reconcile: wall time to the first walk,
                        that walk's ms, createEl count, and the element/mirror-node counts before vs after.
                        The canonical combat recording never opens the map, so this is the only way to price
                        the "open the map after combat" reveal a dormant/hatchery renderer must not regress.
                        Prints a REVEAL_BURST {json} line (also folded into BENCH_RESULT).
  --reveal-shot <file>  post-reveal screenshot (implies --reveal-burst) — the A/B visual gate for the reveal
  --reveal-node <sel>   which subtree the reveal flips: a wire node id, or a node NAME matched against the
                        recording's topmost hidden node of that name (default 'MapScreen')
  --report <file>       ALSO write the SHARED cross-repo perf envelope (schema perf-report/1 — the same shape
                        godot-scene-web's packages/perf-harness emits, so a unit-level win there can be checked
                        against this integration replay field-for-field). Traces EVERY repeat (categories
                        extended to carry ActivateLayerTree + image-decode detail) and maps this bench's
                        measurements onto the contract names: initialRenderMs, readyMs, frameCostMs,
                        contentUpdateHz (= the ActivateLayerTree rate — the honest content frame rate; swap
                        rate / DrawFrame is NEVER reported as fps), activationGapMs, blockedMs, decode{…},
                        rasterMs, layerCount, renderSurfaces, mainThreadCpuRatio. Pass --res-root: without it
                        every atlas 404s and the decode numbers describe a page that painted nothing.
  --limit-ms <n>        replay only the recording's first n ms (a real PREFIX of the session: keyframe + that
                        much stream). Needed for --report on a long recording: the trace buffer holds ~15s of
                        a cc.debug capture and then stops recording silently, which would cost the report
                        window its tail. Recorded in the envelope's params.
  --connect-cdp <ep>    ATTACH to an already-running browser at <ep> (e.g. http://127.0.0.1:9222) via
                        chromium.connectOverCDP instead of launching one — the PHONE leg (scripts/bench-phone.sh
                        wraps the adb forward/reverse hygiene). The bench then drives the browser's FIRST
                        context and the sole HTTP(S) page on --url's port: it never opens a page, because a
                        background tab on Android is throttled to no rAF at all and would report a page that
                        never rendered. Between repeats the tab is navigated to about:blank and back, which is
                        what re-reads the renderer's module-load lever consts (a query change is only ever
                        applied by a real navigation).
                        Degrades where a remote browser cannot be driven, and SAYS so rather than faking it:
                        no viewport control (the page's own innerWidth/innerHeight/devicePixelRatio are
                        recorded into config instead), no CPU throttling (COUCHCOOP_CPU_THROTTLE is refused
                        with a warning), Performance.getMetrics best-effort (busy%/Task/Script/Layout may come
                        back null — frameGaps, walkStats and the long tasks are page-side and are the phone
                        headline), --trace allowed but the device's trace buffer is small, screenshots and
                        --layers best-effort. Nothing passes --disable-gpu here: the attached browser was
                        launched by someone else, and on a phone the GPU is the point.
  --keep-connected-page
                        leave the attached page on the measured URL instead of parking it on about:blank.
                        Intended for a wrapper that immediately proves post-cell foreground scheduling and
                        then closes its own benchmark tab; do not use for unattended standalone captures.
  --serve-port <n>      connect mode only: the port of the tiny HTTP server this process spins up to hand the
                        recording (GET /recording) and, with --res-root, the game assets (GET /res/**) to the
                        remote page (default ${DEFAULT_SERVE_PORT}, CORS *). It is bound on 127.0.0.1 — a phone reaches it
                        through 'adb reverse tcp:<n> tcp:<n>'. The in-page fake socket is handed the ABSOLUTE
                        http://127.0.0.1:<n>/recording URL, which also dodges any service worker the mirror PWA
                        installed on the page's own origin. The desktop path is unchanged (context.route).
  --window <a>:<b>      measure ONLY [a,b] ms of the RECORDING's own clock (recorded pacing only). --limit-ms
                        can slice a prefix; only this can express "the middle 1.5s". A ~1s reshuffle inside a
                        20s recording is otherwise averaged away by whole-run medians — every metric bracketed
                        by the window (busy%, task/script/layout, tickMs, long tasks, and the walk-counter
                        DELTA reported as walkStatsWindow) then describes that burst alone. The bounds are
                        published by the in-page fake socket as it crosses them, so they are the recording's
                        timestamps, not harness wall time. The post-window probes (--census/--layers/--shot/
                        --dom-styles) still run after the WHOLE stream is delivered and settled, so they keep
                        describing the settled scene. 'nodes' becomes the count at the window's close.
  --window auto         take the bracket from the recording's own meta: derived.suggestedWindow [a,b], which a
                        GENERATED fixture (scripts/make-flight-fixture.mjs) publishes for the volley it built.
                        Errors out if the recording's meta carries no such field — a matrix cell must never
                        silently fall back to measuring the whole stream.
  --report-scenario <s> scenario name in the envelope (default: the recording's file stem)
  --report-label <l>    env.label in the envelope (e.g. the branch/arm being measured)
  --report-env <kind>   env.kind in the envelope (default 'ci')
  --help

  env COUCHCOOP_CPU_THROTTLE   CDP CPU throttle rate (e.g. 6 = phone-ish)
  env COUCHCOOP_BENCH_CHROME_ARGS
                        extra chromium launch args (space-separated), launch mode only. Dropping --disable-gpu
                        is NOT enough to get a GPU: a plain headless launch still reports the SwiftShader ANGLE
                        device. Pass --use-angle=vulkan here for a VISUAL evidence run (verified to report the
                        host's real adapter); leave it unset for CPU benchmarking, where SwiftShader's
                        determinism is what makes runs comparable.

Always measured, no flag: 'rAF tick ms' (medians.tickMs) — the duration of each requestAnimationFrame CALLBACK
inside the measured window, p50/p95/max. That is the mirror's own per-tick work (MirrorView's render rAF, the
renderer's animator, gsw's runtime loops, the adaptive-quality sampler), which is the number a device report
like "21ms per tick" is talking about. It is NOT frame time: a callback that queues a 40ms composite reports
only its own milliseconds, so read it beside busy% and, on a phone, beside a real trace.

Also always measured, no flag: 'frame gaps' (medians.frameGaps) — gaps between distinct scheduled rAF
timestamps. These are application callback opportunities, not proof that pixels were presented. p50/p95/max plus a
'vsyncMs' (the 20th-percentile gap snapped to the nearest of 16.7 / 11.1 / 8.3 / 33.3ms — the panel's period is
DETECTED, never assumed: the round's phone is 90Hz), 'dropped' (the frames the page owed the display and did not
deliver under a continuous-rAF assumption: sum of round(gap/vsync)-1) and 'droppedPct'. The phone matrix records
surface-attributed Perfetto presentation separately. CAVEAT: gaps only exist while rAF is SCHEDULED —
a page that stops animating produces none, and a backgrounded tab produces none at all. The run WARNs when the
frame record (frames + dropped) covers far less than windowSpan/vsyncMs, which is the honest starvation test: a
merely janky page still ACCOUNTS for its window (every dropped frame sits inside an observed gap), while a
sampler that was not being scheduled leaves the window's time missing entirely.

And, always on: 'flightCanvases' — a post-window census of the <canvas> elements (count + backing-store bytes,
w*h*4) INSIDE the flight/trail subtrees ([data-node-type$="NCardTrailVfx"], [data-node-type$="NCardFlyShuffleVfx"]),
plus the page's total canvas count, the '<img>' stand-ins gsw's surface swap put up ('imgs'), and the number of
DISTINCT particle spec strings under those roots ('distinctSpecs' — the ceiling on how many stills a volley can
need). One DOM read after the measured window closes, so it perturbs nothing. It is the instrument for the
canvas-attribution question: "this lever combo mounts no canvas" has to be MEASURED, never inferred from what a
lever is supposed to decline.

Prints a human table + a machine-readable "BENCH_RESULT {json}" line (medians across repeats).`);
  process.exit(0);
}

if (!["recorded", "max"].includes(args.pace)) {
  console.error(`--pace must be 'recorded' or 'max' (got '${args.pace}')`);
  process.exit(2);
}
if (!Number.isFinite(args.repeats) || args.repeats < 1) {
  console.error(`--repeats must be >= 1 (got '${args.repeats}')`);
  process.exit(2);
}
if (args.ackPacedMs !== null && (!Number.isFinite(args.ackPacedMs) || args.ackPacedMs < 0)) {
  console.error(`--ack-paced must be a non-negative number of ms (got '${args.ackPacedMs}')`);
  process.exit(2);
}
if (!Number.isFinite(args.flightStillMs) || args.flightStillMs <= 0) {
  console.error(`--flight-still-ms must be > 0 (got '${args.flightStillMs}')`);
  process.exit(2);
}
// The four words the page's own lever accepts (`quality.ts effectModeParam`), plus the two short spellings this
// harness prefers in a cell label. REJECTED rather than defaulted: a typo'd mode that silently ran DYNAMIC would
// put a number in the table under a heading nobody measured, which is the exact failure `--query` merging fixed.
const EFFECT_MODE_QUERY = {
  dynamic: "dynamic",
  static: "static",
  half: "dynamic-half",
  "dynamic-half": "dynamic-half",
  quarter: "dynamic-quarter",
  "dynamic-quarter": "dynamic-quarter"
};
if (args.effectMode !== null && !(args.effectMode in EFFECT_MODE_QUERY)) {
  console.error(
    `--effect-mode must be one of ${Object.keys(EFFECT_MODE_QUERY).join(" | ")} (got '${args.effectMode}'). ` +
      "Use --effects off to turn the runtimes off entirely."
  );
  process.exit(2);
}
if (args.headed && args.connectCdp) {
  console.error("--headed launches a browser; --connect-cdp attaches to one already running. Pick one.");
  process.exit(2);
}
if (args.idle !== null && (!Number.isFinite(args.idle) || args.idle < 0)) {
  console.error(`--idle must be a non-negative number of ms (got '${args.idle}')`);
  process.exit(2);
}
if (args.idleShots && !args.idle) {
  console.error("--idle-shots requires --idle <ms> (the shots are taken in the idle tail)");
  process.exit(2);
}
// Factored out (unchanged checks, same messages) so `--window auto` — whose bounds only exist once the recording's
// meta has been read, further down — is validated by exactly the same rules as an explicit bracket.
function checkWindowConstraints() {
  if (!args.window) return;
  if (args.window.endMs <= args.window.startMs) {
    console.error(`--window end must be > start (got ${args.window.startMs}:${args.window.endMs})`);
    process.exit(2);
  }
  // The window is expressed on the RECORDED stream's clock, which only `recorded` pacing replays. Under
  // `max` the deliveries are credit-gated and their timestamps mean "as fast as this page could take them",
  // so a recorded-time bracket would name a different part of the session on every run.
  if (args.pace !== "recorded") {
    console.error(
      "--window requires --pace recorded (the bounds are recorded-stream timestamps)" +
        (args.ackPacedMs !== null ? " — and --ack-paced is a pacing of the CREDIT loop, so it implies --pace max" : "")
    );
    process.exit(2);
  }
  if (args.limitMs && args.limitMs < args.window.endMs) {
    console.error(
      `--window ${args.window.startMs}:${args.window.endMs} extends past --limit-ms ${args.limitMs}; ` +
        "the stream ends before the window closes."
    );
    process.exit(2);
  }
}
checkWindowConstraints();
if (args.connectCdp && (!Number.isFinite(args.servePort) || args.servePort <= 0 || args.servePort > 65535)) {
  console.error(`--serve-port must be a TCP port (got '${args.servePort}')`);
  process.exit(2);
}

const CPU_THROTTLE = Number(process.env.COUCHCOOP_CPU_THROTTLE ?? "1");

// EXTRA CHROMIUM LAUNCH ARGS (space-separated), appended to whatever the launch below already passes. Launch mode
// only — connect mode attaches to a browser someone else started.
//
// WHY IT EXISTS. A screenshot of the ?stage=canvas arm is only worth looking at if it came off a real GPU, and a
// plain headless Chromium does NOT give you one: with --disable-gpu dropped it still resolves to
// "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)". Verified on this host —
// COUCHCOOP_BENCH_CHROME_ARGS=--use-angle=vulkan is what reports the actual adapter
// ("ANGLE (NVIDIA, Vulkan 1.4.329 (NVIDIA GeForce RTX 2060), NVIDIA)"). Use it for VISUAL evidence runs; leave it
// unset for CPU benchmarking, where SwiftShader's determinism is the point.
const EXTRA_CHROME_ARGS = (process.env.COUCHCOOP_BENCH_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean);

// ---------------------------------------------------------------------------------------------------------
// recording load
// ---------------------------------------------------------------------------------------------------------

function newestRecording() {
  const dir = resolve(REPO_ROOT, ".sts2/bench");
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".ndjson")).map((f) => resolve(dir, f));
    if (files.length === 0) return null;
    files.sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs);
    return files[0];
  } catch {
    return null;
  }
}

const recordingPath = args.recording ? resolve(REPO_ROOT, args.recording) : newestRecording();
if (!recordingPath) {
  console.error("No recording found. Set --recording / COUCHCOOP_BENCH_RECORDING, or record one with:\n" +
    "  node scripts/record-mirror-stream.mjs --out .sts2/bench/combat-baseline.ndjson");
  process.exit(2);
}

const recordingText = readFileSync(recordingPath, "utf8");
const recordingHeader = requireReproHeader(recordingText, recordingPath);
// Parse meta (line 1) + detect whether the recording already carries a directView session, so we only
// synthesize one when the stream lacks it (a passive mirror recording never has directView — see the
// server: directView is only granted in reply to a join).
//
// R14: the same pass counts DISCARD-kind `cardFlights[]` hints (see MirrorCardFlightHint.kind) — the
// hand→discard fly, which moves the real NCard rather than a throwaway shuffle-VFX shell. `--flight-liveness`'s
// element sampler only ever looks at `[data-node-type$="NCardFlyShuffleVfx"]`, so a discard-only recording (or a
// discard-only stretch of one) is invisible to it; this count is what gates the discard-liveness assertion below.
let recMeta = recordingHeader;
let hasRecordedDirectView = false;
let discardHintCount = 0;
{
  const lines = recordingText.split("\n").filter((l) => l.length > 0);
  for (let i = 0; i < lines.length; i++) {
    let obj;
    try { obj = JSON.parse(lines[i]); } catch { continue; }
    if (i === 0) continue;
    // Repro recordings (reproRecorder.ts, "repro/1") carry the client's OWN sends too; only the inbound half is
    // the host's stream, and only the inbound half is what the in-page fake socket will deliver.
    if (obj.dir === "out") continue;
    if (typeof obj.data !== "string") continue;
    if (obj.data.includes('"directView":true')) hasRecordedDirectView = true;
    // Cheap pre-filter (both substrings must be present) before paying a full JSON.parse — most messages
    // carry neither, and this loop already runs once per recording line.
    if (obj.data.includes('"cardFlights"') && obj.data.includes('"kind":"discard"')) {
      let msg;
      try { msg = JSON.parse(obj.data); } catch { continue; }
      if (msg && msg.type === "scene-delta" && Array.isArray(msg.cardFlights)) {
        for (const cf of msg.cardFlights) {
          if (cf && cf.kind === "discard") discardHintCount++;
        }
      }
    }
  }
}
const hasDiscardHints = discardHintCount > 0;

// --window auto: the bracket the RECORDING itself nominates. A generated flight fixture knows exactly when its
// volley starts and lands (scripts/make-flight-fixture.mjs writes `meta.derived.suggestedWindow = [a, b]`), so a
// matrix cell can say `--window auto` and measure the volley at every N without a per-N table of magic numbers.
// A recording that carries no such field is a hard error: silently measuring the whole stream instead would
// change what every number in the run means, which is exactly the failure a matrix must not paper over.
if (args.windowAuto) {
  const sw = recMeta?.derived?.suggestedWindow;
  const ok = Array.isArray(sw) && sw.length === 2 && sw.every((v) => Number.isFinite(Number(v)));
  if (!ok) {
    console.error(
      `--window auto: ${recordingPath} has no meta.derived.suggestedWindow [startMs, endMs]` +
        ` (meta.derived = ${JSON.stringify(recMeta?.derived ?? null)}).\n` +
        "  Generated fixtures publish it; a recorded stream does not — pass an explicit --window <a>:<b> there."
    );
    process.exit(2);
  }
  args.window = { startMs: Math.round(Number(sw[0])), endMs: Math.round(Number(sw[1])) };
  checkWindowConstraints();
}

// ---------------------------------------------------------------------------------------------------------
// reveal-burst synthesis (--reveal-burst) — OFFLINE, in the bench process
// ---------------------------------------------------------------------------------------------------------
//
// The canonical combat recording never OPENS the map: `MapScreen` sits in the stream as a `visible:false`
// subtree root for all 868 deltas. That closed subtree is the single biggest block of hidden DOM (the round's
// census: 1,922 stage elements), so "what does opening the map cost" is exactly the reveal a dormant/hatchery
// renderer must not regress — and there is no recorded frame that prices it.
//
// So synthesize one: take the node's LAST wire JSON across all messages (for MapScreen that is the keyframe
// entry — it is never re-upserted), flip `visible` to true, and ship it as a one-upsert `full:false` scene
// delta whose envelope fields (screenType / screenInstanceId) are copied verbatim from the
// recording's last delta. Two details make this parse EXACTLY like a real upsert in the client:
//   - the payload keeps its `name`, so `mergeNode` takes its `return upsert` (static-replace) branch — the same
//     branch a real re-add takes — instead of the volatile-merge one.
// The message is delivered through the fake WS's own `_deliver`, i.e. through the page's real `onmessage` →
// `parseSceneDelta` → `applySceneDelta` path. Nothing here bypasses the client's parser.

function buildRevealMessage(text, selector) {
  const lastWire = new Map(); // id -> most recent wire JSON for that id
  const parentOf = new Map(); // id -> parentId (last non-null seen)
  const nameOf = new Map();
  let envelope = null; // the last delta's envelope fields
  for (const line of text.split("\n")) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.dir === "out") continue; // a repro recording's outbound half — not the host's stream
    if (obj.meta || typeof obj.data !== "string") continue;
    if (!obj.data.includes('"type":"scene-delta"')) continue;
    let delta;
    try { delta = JSON.parse(obj.data); } catch { continue; }
    if (delta.type !== "scene-delta") continue;
    envelope = {
      screenType: delta.screenType,
      screenInstanceId: delta.screenInstanceId
    };
    for (const u of delta.upserts ?? []) {
      if (!u || typeof u.id !== "string") continue;
      lastWire.set(u.id, u);
      if (u.parentId != null) parentOf.set(u.id, String(u.parentId));
      if (u.name) nameOf.set(u.id, String(u.name));
    }
    for (const id of delta.removedIds ?? []) {
      lastWire.delete(String(id));
    }
  }
  if (lastWire.size === 0) return { error: "recording carries no scene-delta upserts" };

  // Subtree sizes (wire nodes), so the chosen root can be reported/ranked.
  const kids = new Map();
  for (const [id, p] of parentOf) {
    if (!lastWire.has(id) || !lastWire.has(p)) continue;
    let list = kids.get(p);
    if (!list) { list = []; kids.set(p, list); }
    list.push(id);
  }
  const subtreeSize = (id) => {
    let n = 0;
    const stack = [id];
    while (stack.length) {
      n++;
      for (const c of kids.get(stack.pop()) ?? []) stack.push(c);
    }
    return n;
  };
  const hasAncestorIn = (id, set) => {
    let cur = parentOf.get(id);
    while (cur) {
      if (set.has(cur)) return true;
      cur = parentOf.get(cur);
    }
    return false;
  };

  // Selector: an exact wire id, else the TOPMOST node with that name (ties → biggest subtree).
  let chosen = null;
  if (lastWire.has(selector)) {
    chosen = selector;
  } else {
    const wanted = String(selector).toLowerCase();
    const matches = new Set([...lastWire.keys()].filter((id) => (nameOf.get(id) ?? "").toLowerCase() === wanted));
    const tops = [...matches].filter((id) => !hasAncestorIn(id, matches));
    tops.sort((a, b) => subtreeSize(b) - subtreeSize(a));
    chosen = tops[0] ?? null;
  }
  if (!chosen) return { error: `no node matching '${selector}' in the recording (by id or name)` };

  const node = { ...lastWire.get(chosen) };
  const wasVisible = node.visible !== false;
  node.visible = true;
  const message = {
    full: false,
    screenType: envelope?.screenType ?? "",
    screenInstanceId: envelope?.screenInstanceId ?? "",
    upserts: [node],
    removedIds: [],
    type: "scene-delta"
  };
  return {
    raw: JSON.stringify(message),
    info: {
      selector,
      nodeId: chosen,
      name: nameOf.get(chosen) ?? null,
      nodeType: node.nodeType ?? null,
      parentId: node.parentId ?? null,
      wireSubtreeNodes: subtreeSize(chosen),
      wasVisible,
      screenType: message.screenType,
      bytes: JSON.stringify(message).length
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// in-page fake WebSocket (runs in the browser via addInitScript)
// ---------------------------------------------------------------------------------------------------------

// Serialized + injected BEFORE any page script, so mirrorClient's `new WebSocket(.../ws?watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0)` gets the
// fake. Delivers the recorded stream as MessageEvents carrying the RAW strings (so the client pays the real
// JSON.parse cost); answers join → directView session, ping → pong; honours scene-ack credit in `max` pacing.
function fakeWebSocketInit(config) {
  const OPEN = 1;
  const realFetch = window.fetch.bind(window);

  class BenchWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;

    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this._msgs = [];
      this._i = 0;
      this._credits = 1;
      // WATCH GATE — mirror the real host. The mirror app connects with `watch=0` (the pre-join stream gate,
      // see buildMirrorWebSocketUrl), so the host sends NO scene stream — not even the connect keyframe —
      // until the client sends `{"type":"watch","on":true}` after directView resolves. `max` pacing used to
      // ignore this and delivered the keyframe synchronously inside the open dispatch, BEFORE the app's watch
      // flip (a Vue pre-flush watcher, i.e. a microtask away); the client's own stream gate dropped it, and
      // unlike the real host the fake never re-keyframes — nothing ever rendered and the readiness wait at
      // the bottom of runOnce timed out. Recorded pacing is untouched: its timestamps already embed the real
      // session's gating, and replaying them unconditionally is what keeps historical numbers comparable.
      this._watchOn = !this.url.includes("watch=0");
      this._closed = false;
      window.__benchWs = this;
      if (this.url.includes("/ws")) {
        this._start();
      }
    }

    async _start() {
      let text = "";
      try {
        const res = await realFetch(config.recordingUrl);
        text = await res.text();
      } catch (e) {
        this._fail("recording fetch failed: " + e);
        return;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.meta) continue; // meta line
        // A repro recording (reproRecorder.ts, "repro/1") interleaves this client's OWN sends as `dir:"out"`.
        // Delivering them would feed the mirror its own input envelopes as if the host had said them.
        if (obj.dir === "out") continue;
        if (typeof obj.data !== "string") continue;
        if (obj.data.includes('"type":"server-reload"')) continue; // dev-reload signal — strip
        this._msgs.push({ t: typeof obj.t === "number" ? obj.t : 0, data: obj.data });
      }
      if (this._closed) return;
      this.readyState = OPEN;
      this._emit("open", new Event("open"));
      // A passive recording lacks a directView session, so the mirror stays on the join picker (showScene
      // needs joined||directView). Synthesize one up-front so a singleplayer-run mirror renders the scene.
      if (config.synthesizeDirectView) {
        this._deliver('{"type":"session","directView":true}');
      }
      if (config.pace === "max") this._pumpMax();
      else this._pumpRecorded();
    }

    _pumpRecorded() {
      const t0 = performance.now();
      // --window: the measured bracket is expressed on the RECORDING's clock, and this pump is the only thing
      // that knows it — `t0` is recorded-time zero, so recorded ms and elapsed ms are the same number here.
      // Publish the crossings for the harness to poll (mark 0 = before, 1 = inside, 2 = past), from BOTH a
      // timer and the delivery loop: a bound that falls in a gap between two recorded messages must still fire
      // on time, and a bound the timer misses under load must still be observed at the next delivery.
      const win = config.window;
      if (win) {
        window.__benchWindowMark = 0;
        window.__benchWindowAt = { startedAt: null, endedAt: null, startStreamMs: null, endStreamMs: null };
        const cross = (level, boundMs) => {
          if (this._closed || window.__benchWindowMark >= level) return;
          window.__benchWindowMark = level;
          const at = window.__benchWindowAt;
          if (level === 1) { at.startedAt = performance.now(); at.startStreamMs = boundMs; }
          else { at.endedAt = performance.now(); at.endStreamMs = boundMs; }
        };
        this._crossWindow = (streamMs) => {
          if (streamMs >= win.startMs) cross(1, streamMs);
          if (streamMs >= win.endMs) cross(2, streamMs);
        };
        setTimeout(() => this._crossWindow(win.startMs), win.startMs);
        setTimeout(() => this._crossWindow(win.endMs), win.endMs);
      }
      const tick = () => {
        if (this._closed) return;
        const now = performance.now() - t0;
        if (this._crossWindow) this._crossWindow(now);
        while (this._i < this._msgs.length && this._msgs[this._i].t <= now) {
          this._deliver(this._msgs[this._i].data);
          this._i++;
        }
        if (this._i < this._msgs.length) {
          const wait = Math.max(0, this._msgs[this._i].t - (performance.now() - t0));
          setTimeout(tick, wait);
        } else {
          window.__benchDone = true;
        }
      };
      tick();
    }

    _pumpMax() {
      // 1-credit flow control, mirroring the server: the FULL keyframe is delivered free (the real server
      // sends it outside the pump), then each subsequent scene-delta needs a credit that a scene-ack refills.
      // Scene-deltas additionally wait for the watch gate (_watchOn) — non-delta frames (session) flow freely,
      // exactly like the real host's session replies to a gated connection.
      window.__benchMaxDeltas = [];
      const step = () => {
        if (this._closed) return;
        while (this._i < this._msgs.length) {
          const data = this._msgs[this._i].data;
          const isDelta = data.includes('"type":"scene-delta"');
          if (isDelta && !this._watchOn) return; // gated — the watch-on handler in send() resumes the pump
          const isKeyframe = isDelta && data.includes('"full":true');
          if (isDelta && !isKeyframe && this._credits <= 0) return; // wait for a scene-ack
          this._i++;
          if (isDelta && !isKeyframe) {
            this._credits--;
            // Delivery timestamps → the offline max-consumption rate: every delivery below rode a scene-ack
            // from a RENDERED frame, so deliveries-per-second is the effective mirror rate this page sustains.
            window.__benchMaxDeltas.push(performance.now());
          }
          this._deliver(data);
        }
        window.__benchDone = true;
      };
      this._pumpStep = step;
      step();
    }

    _deliver(data) {
      // Keep this instrumentation inside the fake transport, rather than trying to infer an acknowledgement
      // from rAF cadence. A scene-ack means "the client presented a state at or after this delivery"; under
      // recorded pacing several deltas can coalesce before one ack, so each pending delivery records the first
      // acknowledgement that could have covered it. The arrays are reset with the normal measured-window
      // instruments below and capped so a pathological replay cannot grow the page heap forever.
      if (data.includes('"type":"scene-delta"')) {
        const pending = window.__benchSceneAckPending;
        if (Array.isArray(pending) && pending.length < 20_000) pending.push(performance.now());
      }
      // --drop-card-flights: reproduce a host whose producer gate is stuck (no `cardFlights[]` on the wire at
      // all) without needing a poisoned host. The `includes` pre-test keeps the reparse off the ~99% of
      // messages that carry no hint, so the cost is nil on every other delivery.
      if (config.dropCardFlights && data.includes('"cardFlights"')) {
        try {
          const obj = JSON.parse(data);
          delete obj.cardFlights;
          data = JSON.stringify(obj);
          window.__benchDroppedCardFlights = (window.__benchDroppedCardFlights ?? 0) + 1;
        } catch { /* not JSON — deliver it verbatim */ }
      }
      this._emit("message", new MessageEvent("message", { data }));
    }

    _emit(type, event) {
      const handler = this["on" + type];
      if (typeof handler === "function") {
        try { handler.call(this, event); } catch { /* listener threw — keep going */ }
      }
      this.dispatchEvent(event);
    }

    _fail(reason) {
      this.readyState = 3;
      window.__benchWsError = reason;
      this._emit("error", new Event("error"));
    }

    send(data) {
      let msg = null;
      try { msg = JSON.parse(data); } catch { return; }
      const type = msg && msg.type;
      if (type === "scene-ack") {
        const pending = window.__benchSceneAckPending;
        const latencies = window.__benchSceneAckLatencies;
        if (Array.isArray(pending) && Array.isArray(latencies) && pending.length > 0) {
          const now = performance.now();
          for (const deliveredAt of pending) {
            if (latencies.length >= 20_000) break;
            latencies.push(Math.round((now - deliveredAt) * 100) / 100);
          }
          pending.length = 0;
        }
        if (config.pace === "max") {
          this._credits++;
          // --ack-paced: hold the next delivery until N ms AFTER the ack instead of resuming synchronously.
          // That is the whole shape of a phone's credit-gated, coalesced socket: the credit exists, but the
          // bytes do not arrive until the next server tick. Everything else about `max` is unchanged.
          if (this._pumpStep) {
            if (config.ackPacedMs > 0) setTimeout(() => this._pumpStep(), config.ackPacedMs);
            else this._pumpStep();
          }
        }
        return;
      }
      if (type === "watch") {
        const was = this._watchOn;
        this._watchOn = msg.on === true;
        // Resume on a MACROTASK: the watch flip fires inside a Vue pre-flush watcher, BEFORE MirrorView
        // mounts — and the mount-time initial reconcile never acks. Deferring the keyframe past the current
        // flush lands it on the normal watched-state → scheduleRender → rendered-frame → scene-ack path
        // (the same "network round-trip later" shape as the real server), so the 1-credit flow can't deadlock
        // on a keyframe consumed by a reconcile that doesn't ack.
        if (!was && this._watchOn && config.pace === "max" && this._pumpStep) {
          setTimeout(() => this._pumpStep(), 0);
        }
        return;
      }
      if (type === "join") {
        // The mirror sends a join (empty name for a singleplayer-run direct view). Reply directView so the
        // client's join flow resolves exactly like the real server would for a solo run.
        this._deliver('{"type":"session","directView":true}');
        return;
      }
      if (type === "ping") {
        const echo = { type: "pong", t0: msg.t0 };
        if (msg.mainThread) echo.mainThread = true;
        this._deliver(JSON.stringify(echo));
        return;
      }
      // input / settings / anything else — swallow (never reaches a game).
    }

    close() {
      this._closed = true;
      this.readyState = 3;
      this._emit("close", new CloseEvent("close"));
    }

    addEventListener(type, listener, options) { super.addEventListener(type, listener, options); }
    removeEventListener(type, listener, options) { super.removeEventListener(type, listener, options); }
  }

  window.WebSocket = BenchWebSocket;
}

// ---------------------------------------------------------------------------------------------------------
// LONG-TASK instrumentation — always installed (a passive PerformanceObserver costs nothing until an entry
// fires). TaskDuration alone cannot distinguish "the same milliseconds spread over many small tasks" from
// "four 130ms janks", and it is the janks a phone user feels — so record every `longtask` entry (the API's own
// definition is >= 50ms) inside the measured window. Reset at the window's open, read at its close, alongside
// the two .mirror-node counts already taken there.
// ---------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------
// --flight-liveness — "did the cards actually keep moving?"
//
// The one question a CPU number cannot answer. A stuck producer gate makes a reshuffle cost LESS main-thread
// time (no hints parsed, no flights armed, no per-frame integration) while looking, on screen, like the cards
// are crawling — so busy%/tickMs both improve while the thing regresses. This samples the flight VFX elements'
// COMPUTED transform, which resolves the WAAPI animated value, so the compositor path is measured correctly
// rather than read off an inline style the animation is overriding.
//
// The metric is PER ELEMENT and scoped to ONE TRAVEL EPISODE: the largest gap between two position changes,
// counted only between its first move and its last, and only while the gap is short enough to still be the same
// flight. Everything else about a flight VFX element is legitimately still — it is parked at the pile before the
// hint lands, and it holds the landed pose until the producer's suppression window closes — and scoring those
// plateaus fails the healthy path.
//
// EPISODE_MS is what makes the number survive a full-length replay. A flight is bounded by the producer's
// suppression window (~3.6s), so a gap longer than this is not a stalled flight: it is two separate motion
// episodes on the same node — the flight itself, and then the producer's settle re-emit once its window closes.
// Measured without this bound, an `--ack-paced` run of the WHOLE recording reported ~20s "stalls" on the
// perfectly healthy arm, which is the settle re-emit and nothing else. The cost of the bound is that a freeze
// longer than one flight stops being visible in `maxStillMs` — but such a freeze also crushes
// `distinctPositions`, which is asserted separately and is the discriminator for the frozen-card variant.
// ---------------------------------------------------------------------------------------------------------

function flightLivenessInit() {
  const SEL = '[data-node-type$="NCardFlyShuffleVfx"]';
  const EPISODE_MS = 2000;
  const els = new Map(); // data-node-id -> { pos, lastMoveAt, maxGapMs, distinct }
  const state = { samples: 0, movedSamples: 0, peakElements: 0, sampleHz: 30 };
  window.__benchFlightLiveness = state;
  window.__benchFlightLivenessRead = () => {
    const per = [...els.entries()].map(([id, e]) => ({ id, maxGapMs: e.maxGapMs, distinct: e.distinct }));
    // Only elements that MOVED describe a flight; one that never moved was never given a pose to fly (it is a
    // pooled shell, or the recording's window ended before it launched) and cannot be stalled.
    const flew = per.filter((e) => e.distinct >= 2);
    const gaps = flew.map((e) => e.maxGapMs).sort((a, b) => a - b);
    const distincts = flew.map((e) => e.distinct).sort((a, b) => a - b);
    const med = (xs) => (xs.length === 0 ? null : xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2);
    return {
      ...state,
      elements: per.length,
      flights: flew.length,
      maxStillMs: gaps.length ? Math.round(gaps[gaps.length - 1] * 10) / 10 : null,
      medianStillMs: gaps.length ? Math.round(med(gaps) * 10) / 10 : null,
      medianDistinctPositions: med(distincts),
      minDistinctPositions: distincts.length ? distincts[0] : null,
      // The worst offenders, so a failure names the cards rather than just the number.
      worst: flew.sort((a, b) => b.maxGapMs - a.maxGapMs).slice(0, 5).map((e) => ({ ...e, maxGapMs: Math.round(e.maxGapMs * 10) / 10 }))
    };
  };
  const tick = () => {
    const now = performance.now();
    const nodes = document.querySelectorAll(SEL);
    if (nodes.length === 0) return;
    if (nodes.length > state.peakElements) state.peakElements = nodes.length;
    state.samples++;
    let moved = false;
    for (const el of nodes) {
      const id = el.getAttribute("data-node-id") || "?";
      const raw = getComputedStyle(el).transform;
      const m = /matrix\(([^)]+)\)/.exec(raw);
      const pos = m ? m[1].split(",").slice(4).join(",").trim() : raw;
      let e = els.get(id);
      if (!e) {
        e = { pos, lastMoveAt: null, maxGapMs: 0, distinct: 1 };
        els.set(id, e);
        continue; // the first observation is not a move — there is nothing to have moved FROM
      }
      if (e.pos === pos) continue;
      if (e.lastMoveAt !== null) {
        const gap = now - e.lastMoveAt;
        // Past EPISODE_MS this is a NEW episode, not a stall (see the note above) — so it starts a fresh
        // travel rather than being scored against the old one.
        if (gap <= EPISODE_MS && gap > e.maxGapMs) e.maxGapMs = gap;
      }
      e.pos = pos;
      e.lastMoveAt = now;
      e.distinct++;
      moved = true;
    }
    if (moved) state.movedSamples++;
  };
  setInterval(tick, 1000 / 30);
}

function longTaskInit() {
  window.__benchLongTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__benchLongTasks.push(Math.round(e.duration * 10) / 10);
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    /* engine without the longtask entry type — the summary just stays empty */
  }
  // LoAF (long ANIMATION frame, >=50ms): a rendering-aware sibling of longtask — it counts frames whose whole
  // update (script + style + layout + paint) ran long, including the ones assembled from several short tasks
  // that `longtask` never sees. Part of the shared report contract; stays empty on an engine without it.
  window.__benchLoaf = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__benchLoaf.push(Math.round(e.duration * 10) / 10);
      }
    }).observe({ type: "long-animation-frame", buffered: false });
  } catch {
    /* engine without long-animation-frame */
  }
}

// ---------------------------------------------------------------------------------------------------------
// rAF TICK sampler — always installed (one `performance.now()` pair + one push per animation-frame callback).
// `frameCostMs` (--report, from the trace) prices a whole top-level RunTask, which on a busy page fuses several
// callbacks and the surrounding event handling into one number. The phone-side complaint this exists for is
// per-TICK ("21ms per rAF tick"), so measure the callbacks the mirror actually registers — MirrorView's render
// rAF, the renderer's animator tick, gsw's two runtime loops, adaptiveQuality's sampler — one sample each.
//
// CAVEAT, and it is not a small one: this measures CALLBACK duration, not frame duration. A tick that hands the
// compositor a 40ms raster/composite job reports its own 3ms and nothing else. Read it beside `busyPct` (the
// whole main thread) and, on a device, beside a real trace — a low tickMs with a high busyPct means the cost is
// NOT in the mirror's callbacks.
// ---------------------------------------------------------------------------------------------------------

function tickSamplerInit() {
  // Bounded: a 35s replay is ~2k frames x ~5 callbacks; the cap only guards a pathological run's heap.
  const CAP = 200_000;
  // FRAME gaps ride the same wrapper (R15/WP-B). Every callback scheduled for one animation frame is invoked
  // with the SAME `t` — that is the spec's rendering timestamp, not a per-callback clock read — so deduping on
  // it records one gap per distinct scheduled rAF timestamp. CSS/compositor animation can present without a
  // page callback, and a page callback does not prove presentation. This is a passive application cadence probe,
  // with no extra observer and no second rAF in the loop competing for the same frames.
  const GAP_CAP = 20_000; // ~5.5 minutes at 60Hz; the cap only guards a pathological run's heap
  window.__benchTicks = [];
  window.__benchFrameGaps = [];
  window.__benchSceneAckPending = [];
  window.__benchSceneAckLatencies = [];
  let lastFrameT = null;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) =>
    raf((t) => {
      if (t !== lastFrameT) {
        if (lastFrameT !== null && window.__benchFrameGaps.length < GAP_CAP) {
          window.__benchFrameGaps.push(Math.round((t - lastFrameT) * 100) / 100);
        }
        lastFrameT = t;
      }
      const s = performance.now();
      try {
        cb(t);
      } finally {
        if (window.__benchTicks.length < CAP) {
          window.__benchTicks.push(Math.round((performance.now() - s) * 10) / 10);
        }
      }
    });
}

// {p50,p95,max} over the samples plus the two aggregates that give them scale: how many callbacks ran, and how
// much wall time they add up to (a p95 of 20ms over 40 ticks is a different page from one over 4,000).
function summarizeTicks(samples) {
  if (!Array.isArray(samples)) return null;
  return {
    ...distribution(samples, 2),
    count: samples.length,
    totalMs: round(samples.reduce((s, v) => s + v, 0), 1)
  };
}

// The display periods a frame gap is scored against. DETECTED, not assumed: the round's phone is a 90Hz panel
// (11.1ms), desktop Chrome here is 60Hz (16.7), a 120Hz device is 8.3, and a page pinned to half-rate by the
// compositor lands on 33.3. Snapping the observed p20 to the nearest of these is what makes `dropped` mean
// "frames this page owed the display and did not deliver" on every one of them.
const VSYNC_CANDIDATES_MS = [16.7, 11.1, 8.3, 33.3];

// FRAME cadence (see tickSamplerInit). p20 rather than p50 as the vsync estimate: in a window where the page
// drops a third of its frames the MEDIAN gap is already two periods, while the fastest fifth is still the panel.
function summarizeFrameGaps(gaps) {
  if (!Array.isArray(gaps)) return null;
  const frames = gaps.length;
  if (frames === 0) {
    return { frames: 0, p50: null, p95: null, max: null, vsyncMs: null, rawP20: null, dropped: 0, droppedPct: null };
  }
  const rawP20 = percentile(gaps, 0.2);
  let vsyncMs = VSYNC_CANDIDATES_MS[0];
  for (const c of VSYNC_CANDIDATES_MS) {
    if (Math.abs(c - rawP20) < Math.abs(vsyncMs - rawP20)) vsyncMs = c;
  }
  let dropped = 0;
  for (const g of gaps) dropped += Math.max(0, Math.round(g / vsyncMs) - 1);
  return {
    frames,
    ...distribution(gaps, 2),
    vsyncMs,
    rawP20: round(rawP20, 2),
    dropped,
    // Share of the frames the display COULD have shown in this window that never arrived: delivered = `frames`,
    // owed = frames + dropped.
    droppedPct: round((dropped / (frames + dropped)) * 100, 1)
  };
}

// Scene-delivery → first subsequent scene-ack latency, collected by fakeWebSocketInit. This is deliberately
// separate from frame gaps: an idle renderer can have perfect rAF cadence while an incoming delta still waits
// behind a long reconcile. Null means the window carried no scene deltas or the transport was not instrumented.
function summarizeSceneAckLatency(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return { count: 0, p50: null, p95: null, max: null };
  return { ...distribution(samples, 2), count: samples.length };
}

function summarizeLongTasks(durations) {
  if (!Array.isArray(durations)) return null;
  const sorted = [...durations].sort((a, b) => b - a);
  return {
    count: sorted.length, // the longtask API only reports >= 50ms
    ge100: sorted.filter((d) => d >= 100).length,
    maxMs: sorted.length ? sorted[0] : 0,
    totalMs: Math.round(sorted.reduce((s, d) => s + d, 0)),
    top: sorted.slice(0, 5)
  };
}

// ---------------------------------------------------------------------------------------------------------
// census instrumentation (Stage 0) — installed BEFORE any page script via addInitScript, gated on --census.
// Accumulates into window.__census; read after the measured window closes (like --layers) so it never perturbs
// the headline number. Counts, not timings, except the WebGL compile/link wall (its blocking cost is the point).
// ---------------------------------------------------------------------------------------------------------

function censusInit() {
  const c = {
    // #2 canvas-invalidation: drawImage calls bucketed by the canvas element's class list.
    drawImage: { total: 0, byClass: {} },
    // #5 syncCanvasSize forced-layout triggers: the reads/observers that force a synchronous layout in gsw.
    canvasClientRead: 0, // clientWidth/clientHeight reads on a <canvas> (the forced-layout hazard)
    getContextWebgl: 0, // WebGL context creations (each gsw self-layer → a syncCanvasSize at creation)
    resizeObserverNew: 0,
    resizeObserverCallback: 0,
    // #6 WebGL shader compiles: how many programs compile mid-run + the blocking getProgramParameter wall.
    compileShader: 0,
    linkProgram: 0,
    getProgramParameter: 0,
    compileWallMs: 0, // sum of time spent in compileShader/linkProgram/getProgramParameter (blocking cost)
  };
  window.__census = c;

  const wrap = (obj, name, fn) => {
    const orig = obj[name];
    if (typeof orig !== "function") return;
    obj[name] = function (...a) {
      return fn(orig, this, a);
    };
  };
  const timed = (orig, self, a, key) => {
    const t0 = performance.now();
    const r = orig.apply(self, a);
    c.compileWallMs += performance.now() - t0;
    c[key]++;
    return r;
  };

  for (const proto of [
    typeof WebGLRenderingContext !== "undefined" ? WebGLRenderingContext.prototype : null,
    typeof WebGL2RenderingContext !== "undefined" ? WebGL2RenderingContext.prototype : null,
  ]) {
    if (!proto) continue;
    wrap(proto, "compileShader", (o, s, a) => timed(o, s, a, "compileShader"));
    wrap(proto, "linkProgram", (o, s, a) => timed(o, s, a, "linkProgram"));
    wrap(proto, "getProgramParameter", (o, s, a) => timed(o, s, a, "getProgramParameter"));
  }

  if (typeof CanvasRenderingContext2D !== "undefined") {
    wrap(CanvasRenderingContext2D.prototype, "drawImage", (o, s, a) => {
      c.drawImage.total++;
      const cls = s.canvas && s.canvas.className ? String(s.canvas.className).split(/\s+/)[0] : "(none)";
      c.drawImage.byClass[cls] = (c.drawImage.byClass[cls] ?? 0) + 1;
      return o.apply(s, a);
    });
  }

  // getContext on a canvas: bucket webgl creations (#5 — each drives a syncCanvasSize at layer creation).
  wrap(HTMLCanvasElement.prototype, "getContext", (o, s, a) => {
    const type = String(a[0] ?? "");
    if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") c.getContextWebgl++;
    return o.apply(s, a);
  });

  // clientWidth/clientHeight read on a <canvas> forces a synchronous layout — the exact hazard the gsw
  // syncCanvasSize fix targets. Count them (source-agnostic; the trace/gsw counter attributes the caller).
  for (const prop of ["clientWidth", "clientHeight"]) {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    if (desc && desc.get) {
      Object.defineProperty(HTMLCanvasElement.prototype, prop, {
        configurable: true,
        get() {
          c.canvasClientRead++;
          return desc.get.call(this);
        },
      });
    }
  }

  if (typeof ResizeObserver !== "undefined") {
    const RO = ResizeObserver;
    window.ResizeObserver = class extends RO {
      constructor(cb) {
        c.resizeObserverNew++;
        super((entries, obs) => {
          c.resizeObserverCallback += entries.length;
          return cb(entries, obs);
        });
      }
    };
  }
}

// ---------------------------------------------------------------------------------------------------------
// per-walk churn census (--churn-census) — installed BEFORE any page script via addInitScript.
// ---------------------------------------------------------------------------------------------------------
//
// A DOM-reuse round is gated on ONE number: the largest `createEl` burst a single reconcile does. Start/end
// totals cannot produce it — they say how much got built, never how lumpy — and neither can rAF polling, since
// a frame can carry more than one walk and a walk can miss a frame entirely. So this samples PER WALK.
//
// THE SEAM is a PAIR of once-per-reconcile writes the renderer already makes: `mirrorWalkStats.walks++` at the
// top of doWalk (before the visit loop) opens the bracket, and `mirrorWalkStats.lastWalkMs = dur` closes it —
// the latter running after doWalk() has returned, with every counter for that walk already final, exactly once
// per reconcile (a nested fixup re-walk sits INSIDE doWalk, which the renderer times once on purpose).
//
// BOTH ends are needed, and the first version of this probe got it wrong by using only the close. `createEl`
// also climbs OUTSIDE any walk: the idle hatchery drains dormant builds on a debounce (hatchedBuilds /
// hatchDrains / hatchMs), which is a different mechanism with a different fix. Charging its work to whichever
// walk happened next produced a fake headline — on audit-cardreward-open that read as 1,887 createEl in a
// 5.4ms walk, i.e. 2.9us per element, which is not a thing a DOM build can do. The bracket makes the split
// explicit instead: `createEl` is what the walk itself constructed, `betweenCreateEl` is what landed between
// walks. Neither is discarded, and the peak is computed from the in-walk number alone.
//
// It must be an accessor ON THE LIVE STATS OBJECT, not a Proxy wrapped around `window.__mirrorWalkStats`: the
// renderer holds a direct module reference and never reads the counters back off `window`, so a wrapper would
// observe nothing at all. Hence the two-stage install — trap the `window.__mirrorWalkStats` assignment (the
// renderer publishes it once, at module init), then define the `lastWalkMs` accessor on the object handed over.
// The accessor stays enumerable + configurable so `cloneWalkStatsInPage`'s JSON round-trip still sees the field.
//
// PERTURBATION, STATED PLAINLY. --census / --layers / --reveal-burst all run after the measured window closes,
// so they are free by construction. This one cannot be: the walks it counts only happen inside the window.
// Per walk it costs one setter call, ~10 numeric subtractions and 9 stores into preallocated typed arrays — no
// allocation (overflow past CAP is counted, not grown) and no DOM or style reads (contrast --flight-liveness,
// which forces a style recalc 30x/s). At the ~30 walks/s these recordings replay at that is sub-microsecond per
// second of stream. It is still not nothing: do not fold a --churn-census run's busy% into an A/B against a run
// without it.
function churnCensusInit() {
  const CAP = 40000;
  const wIdx = new Int32Array(CAP); // mirrorWalkStats.walks as of this walk
  const wT = new Float64Array(CAP);
  const wMs = new Float64Array(CAP);
  const wCreate = new Int32Array(CAP);
  const wAdopt = new Int32Array(CAP);
  const wSwept = new Int32Array(CAP);
  const wRemoved = new Int32Array(CAP);
  const wBetween = new Int32Array(CAP); // createEl that landed BETWEEN this walk and the previous one
  const wMode = new Int8Array(CAP); // 0 full, 1 incremental, 2 update, -1 undetermined
  const wWin = new Int8Array(CAP); // 1 = inside the measured window
  let n = 0;
  let overflow = 0;
  let level = 0; // 0 = before the window, 1 = inside, 2 = past

  // Cumulative values as of the previous walk's CLOSE, and as of the current walk's OPEN. A counter that goes
  // DOWN means the renderer reset the stats in place (mirrorWalkStats.reset() zeroes them without reallocating),
  // so the current value IS the delta.
  let pWalks = 0, pCreate = 0, pAdopt = 0, pSwept = 0, pRemoved = 0, pFull = 0, pIncr = 0, pUpd = 0;
  let sCreate = 0, sAdopt = 0, sSwept = 0, sRemoved = 0, between = 0, open = false;
  const step = (cur, prev) => (cur >= prev ? cur - prev : cur);

  const rebase = (ws) => {
    pCreate = ws.createEl | 0;
    pAdopt = ws.adoptions | 0;
    pSwept = ws.condemnedSwept | 0;
    pRemoved = ws.removedRecords | 0;
    pFull = ws.fullWalks | 0;
    pIncr = ws.incrementalStructuralWalks | 0;
    pUpd = ws.updateWalks | 0;
  };

  // doWalk's `walks++`, i.e. the walk is about to visit. Everything the counters gained since the previous
  // walk CLOSED happened outside any reconcile — the idle hatchery, a reveal build, an async drain.
  const walkOpen = (ws, walks) => {
    if (walks <= pWalks) {
      // reset() writing 0, not a walk: re-baseline and record nothing.
      pWalks = walks;
      rebase(ws);
      open = false;
      return;
    }
    between = step(ws.createEl | 0, pCreate);
    sCreate = ws.createEl | 0;
    sAdopt = ws.adoptions | 0;
    sSwept = ws.condemnedSwept | 0;
    sRemoved = ws.removedRecords | 0;
    pWalks = walks;
    open = true;
  };

  const walkClose = (ws, dur) => {
    if (!open) return; // a reset()'s own `lastWalkMs = 0`, or a close with no matching open
    open = false;
    const dFull = step(ws.fullWalks | 0, pFull);
    const dIncr = step(ws.incrementalStructuralWalks | 0, pIncr);
    const dUpd = step(ws.updateWalks | 0, pUpd);
    if (n < CAP) {
      wIdx[n] = pWalks;
      wT[n] = performance.now();
      wMs[n] = dur;
      wCreate[n] = step(ws.createEl | 0, sCreate);
      wAdopt[n] = step(ws.adoptions | 0, sAdopt);
      wSwept[n] = step(ws.condemnedSwept | 0, sSwept);
      wRemoved[n] = step(ws.removedRecords | 0, sRemoved);
      wBetween[n] = between;
      wMode[n] = dFull > 0 ? 0 : dIncr > 0 ? 1 : dUpd > 0 ? 2 : -1;
      wWin[n] = level === 1 ? 1 : 0;
      n++;
    } else {
      overflow++;
    }
    rebase(ws);
  };

  const MODES = ["full", "incremental", "update"];
  const row = (i) => ({
    walk: wIdx[i],
    mode: wMode[i] >= 0 ? MODES[wMode[i]] : "?",
    createEl: wCreate[i],
    betweenCreateEl: wBetween[i],
    adoptions: wAdopt[i],
    condemnedSwept: wSwept[i],
    removedRecords: wRemoved[i],
    walkMs: Math.round(wMs[i] * 100) / 100,
    tMs: Math.round(wT[i]),
    inWindow: wWin[i] === 1
  });

  window.__benchChurnCensus = {
    // 1 = the measured window just opened, 2 = it just closed. Called by the harness at the SAME two points it
    // brackets walkStats/Performance.getMetrics with, so "in-window" here means exactly what it means there.
    mark(l) {
      level = l;
    },
    read() {
      const tot = { createEl: 0, betweenCreateEl: 0, adoptions: 0, condemnedSwept: 0, removedRecords: 0, walkMs: 0, walks: 0 };
      const all = { createEl: 0, betweenCreateEl: 0, adoptions: 0, condemnedSwept: 0, removedRecords: 0, walkMs: 0, walks: n };
      let peak = -1;
      let firstBuild = -1;
      for (let i = 0; i < n; i++) {
        all.createEl += wCreate[i];
        all.betweenCreateEl += wBetween[i];
        all.adoptions += wAdopt[i];
        all.condemnedSwept += wSwept[i];
        all.removedRecords += wRemoved[i];
        all.walkMs += wMs[i];
        if (wWin[i] === 1) {
          tot.walks++;
          tot.createEl += wCreate[i];
          tot.betweenCreateEl += wBetween[i];
          tot.adoptions += wAdopt[i];
          tot.condemnedSwept += wSwept[i];
          tot.removedRecords += wRemoved[i];
          tot.walkMs += wMs[i];
          if (peak < 0 || wCreate[i] > wCreate[peak]) peak = i;
        } else if (firstBuild < 0 || wCreate[i] > wCreate[firstBuild]) {
          firstBuild = i;
        }
      }
      tot.walkMs = Math.round(tot.walkMs * 10) / 10;
      all.walkMs = Math.round(all.walkMs * 10) / 10;
      // Top N by createEl, window-scoped, ties broken by the costlier walk — the "one spike or spread out?" view.
      const order = [];
      for (let i = 0; i < n; i++) if (wWin[i] === 1) order.push(i);
      order.sort((a, b) => wCreate[b] - wCreate[a] || wMs[b] - wMs[a]);
      return {
        totals: tot,
        allTotals: all,
        peak: peak >= 0 ? row(peak) : null,
        top: order.slice(0, 10).map(row),
        // The pre-window keyframe build: the whole scene constructed from nothing, before the readiness gate
        // (>50 mirror nodes) lets the window open. Reported so it is visible, kept out of the totals so it can
        // never be mistaken for churn.
        firstBuild: firstBuild >= 0 ? row(firstBuild) : null,
        sampledWalks: n,
        overflow,
        cap: CAP
      };
    }
  };

  // Stage 1: catch the renderer publishing the live stats object (mirrorRenderer.ts does this once at init).
  let statsObj;
  const install = (ws) => {
    if (!ws || typeof ws !== "object") return;
    const dWalks = Object.getOwnPropertyDescriptor(ws, "walks");
    const dMs = Object.getOwnPropertyDescriptor(ws, "lastWalkMs");
    // Already accessors: never double-wrap (a second addInitScript, or a page that re-publishes the object).
    if (!dWalks || !dMs || typeof dWalks.get === "function" || typeof dMs.get === "function") return;
    pWalks = ws.walks | 0;
    rebase(ws);
    let rawWalks = ws.walks;
    Object.defineProperty(ws, "walks", {
      configurable: true,
      enumerable: true,
      get() {
        return rawWalks;
      },
      set(v) {
        rawWalks = v;
        walkOpen(this, v | 0);
      }
    });
    let rawMs = ws.lastWalkMs;
    Object.defineProperty(ws, "lastWalkMs", {
      configurable: true,
      enumerable: true,
      get() {
        return rawMs;
      },
      set(v) {
        rawMs = v;
        walkClose(this, v);
      }
    });
  };
  Object.defineProperty(window, "__mirrorWalkStats", {
    configurable: true,
    enumerable: true,
    get() {
      return statsObj;
    },
    set(v) {
      statsObj = v;
      install(v);
    }
  });
}

// Post-settle DOM census (#3 offscreen, #4 element-kind), run in-page after the measured window closes. Pure
// reads; returns a plain object. Leaf = a .mirror-node with no .mirror-node descendant.
function domCensusInPage() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const MARGIN = 128; // matches the C1 cull margin — "fully outside" means beyond the viewport + margin
  const nodes = Array.from(document.querySelectorAll(".mirror-node"));
  let leaves = 0;
  let boxedLeaves = 0;
  let offscreenLeaves = 0;
  for (const n of nodes) {
    if (n.querySelector(".mirror-node")) continue; // interior
    leaves++;
    const r = n.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    boxedLeaves++;
    const outside = r.right < -MARGIN || r.left > vw + MARGIN || r.bottom < -MARGIN || r.top > vh + MARGIN;
    if (outside) offscreenLeaves++;
  }
  // #4 element-kind counts.
  const q = (sel) => document.querySelectorAll(sel).length;
  const blendEls = Array.from(document.querySelectorAll(".mirror-stage *")).filter(
    (e) => getComputedStyle(e).mixBlendMode !== "normal"
  );
  const blendLowOpacity = blendEls.filter((e) => Number(getComputedStyle(e).opacity) <= 0.02).length;
  return {
    viewport: { w: vw, h: vh, margin: MARGIN },
    mirrorNodes: nodes.length,
    totalElements: document.querySelectorAll(".mirror-stage *").length,
    leaves,
    boxedLeaves,
    offscreenLeaves,
    offscreenPct: boxedLeaves ? Math.round((offscreenLeaves / boxedLeaves) * 1000) / 10 : 0,
    ninePatchSlices: q(".mirror-np-slice"),
    canvases: q(".mirror-stage canvas"),
    // The DOM backend paints a modulate TINT as an SVG `filter: url(#mtint-N)` per node — a per-element filter
    // is a compositor render surface each, and the single-canvas backend premultiplies the same tint into the
    // quad instead. Counting them is how "the canvas stage really replaced that mechanism" becomes a number.
    tintFilterEls: Array.from(document.querySelectorAll(".mirror-stage [style*='filter']")).filter((e) =>
      (e.getAttribute("style") ?? "").includes("url(#mtint")
    ).length,
    blendEls: blendEls.length,
    blendLowOpacity,
  };
}

// TOP-N SURFACES (--census). `canvases: N` says how many exist; it does not say which ones own the memory, and
// the answer is never uniform — one full-stage effect canvas outweighs fifty per-card ones. Rank by BACKING
// STORE (width*height*4 bytes, the allocation the GPU process actually holds), and name each one by the scene
// node it belongs to via the mirror's own `data-scene-file` / `data-node-path` stamps, so a row is actionable
// ("this many MB is that node") instead of a size.
//
// Prefers the page's OWN `window.__mirrorTopSurfaces` (MirrorView installs it, so a phone can be asked the same
// question through a bare console eval) and falls back to this copy on a build that predates it. The two return
// the same row shape on purpose — a device reading and a bench reading have to be comparable.
function topSurfacesInPage(limit) {
  const helper = window.__mirrorTopSurfaces;
  if (typeof helper === "function") {
    try {
      const rows = helper(limit);
      if (Array.isArray(rows)) return { source: "page", rows };
    } catch { /* fall through to the bench's own copy */ }
  }
  const rows = Array.from(document.querySelectorAll("canvas")).map((c) => {
    const box = c.getBoundingClientRect();
    const owner = c.closest("[data-node-path]");
    const scene = c.closest("[data-scene-file]");
    return {
      w: c.width,
      h: c.height,
      bytes: c.width * c.height * 4,
      cssW: Math.round(box.width),
      cssH: Math.round(box.height),
      cls: String(c.className || "").split(/\s+/)[0] || "(none)",
      sceneFile: scene ? scene.getAttribute("data-scene-file") : null,
      nodePath: owner ? owner.getAttribute("data-node-path") : null
    };
  });
  rows.sort((a, b) => b.bytes - a.bytes);
  return { source: "bench", rows: rows.slice(0, Math.max(1, limit)) };
}

// FLIGHT-SCOPED CANVAS CENSUS (R15/WP-B, always on, read once after the measured window closes so it perturbs
// nothing). `--census`'s page-wide canvas count cannot answer the round's canvas-attribution question, which is
// specifically "how many canvases does a card's FLIGHT mount, and how much backing store do they hold" — 30 cards
// each carrying two particle emitters plus silhouettes is the multi-canvas load the gsw WebGPU decision hangs on.
//
// Roots are the two flight subtree types the renderer stamps (`data-node-type` carries the wire node type, whose
// tail is the class name): the trail VFX shell and the shuffle flier. A canvas is counted ONCE even when the two
// nest, and bytes are the BACKING STORE (width*height*4), not the CSS box — a quarter-scale canvas costs what it
// allocates. `pageTotal` is the whole document's canvas count, so a cell that moves `count` to 0 can still be
// checked for having merely relocated the canvases somewhere else.
function flightCanvasCensusInPage() {
  const roots = document.querySelectorAll(
    '[data-node-type$="NCardTrailVfx"], [data-node-type$="NCardFlyShuffleVfx"]'
  );
  const seen = new Set();
  let count = 0;
  let bytes = 0;
  // R17 — canvases still at the UNTOUCHED 300x150 default, i.e. ones nothing ever sized. Counted separately and
  // EXCLUDED from `bytes`, because otherwise this census reports the round's win as a loss. gsw mounts a
  // claimed-still surface without ever writing `canvas.width` or calling `getContext` (its suite spies on both):
  // the element is in the DOM, hidden, holding no drawing buffer at all. But `width`/`height` still READ as the
  // spec default, so the naive `w*h*4` prices that empty element at 180 KB — against ~34 KB for a real 92px
  // emitter canvas — and a cell that replaced six real canvases with six claimed ones would publish
  // "0.20 MB → 1.08 MB" for a change that allocated nothing. Measured on the two-wave N=3 fixture, where the
  // arithmetic matches to the byte in all three arms.
  //   A real canvas that HAPPENS to be 300x150 would be excluded too. That is the accepted cost of a proxy with
  // no false negatives in the direction that matters, and it is visible rather than silent: `defaultSized` is
  // reported, so a cell whose count moves unexpectedly can be checked by hand.
  let defaultSized = 0;
  const add = (c) => {
    if (seen.has(c)) return;
    seen.add(c);
    count++;
    const w = c.width | 0;
    const h = c.height | 0;
    if (w === 300 && h === 150) {
      defaultSized++;
      return;
    }
    bytes += w * h * 4;
  };
  for (const root of roots) {
    if (root.tagName === "CANVAS") add(root);
    for (const c of root.querySelectorAll("canvas")) add(c);
  }
  // WHICH RENDERER produced the effect pixels — gsw stamps `data-godot-effects-backend="webgpu"` on a canvas the
  // WebGPU backend configures; an effect canvas WITHOUT the stamp is WebGL (or 2d-blit). Counted page-wide so an
  // adoption claim ("this run rendered on WebGPU") is measured, never inferred from `effectsRenderer` semantics —
  // the gate can fall back silently (no adapter, device lost, context refused) and this is where that shows.
  let webgpu = 0;
  const all = document.querySelectorAll("canvas");
  for (const c of all) {
    if (c.getAttribute("data-godot-effects-backend") === "webgpu") webgpu++;
  }
  // R17 — the SWAP's own side of the same census. gsw stands a frozen surface's `<img>` in for its canvas
  // (`data-godot-shader-image`, the published DOM contract — the attribute name predates the mechanism being
  // generic), leaving the canvas hidden in place, so a cell that swaps reads as `count` falling and `imgs`
  // rising by the same amount. Counting them separately is what makes "the emitters became images" a
  // measurement rather than a story about a lever: `count` alone cannot distinguish a swapped surface from a
  // subtree that was never mounted, and `imgs` alone cannot distinguish a swap from a decorative sprite.
  let imgs = 0;
  // SPEC IDENTITY, the round's premise as a number. gsw shares ONE encoded still per distinct frame key, and
  // the constant half of that key is this attribute string verbatim (see gsw `particleStaticFrameKeyBase`), so
  // the count of DISTINCT spec strings under the flight roots is the ceiling on how many stills a volley can
  // ever need. The r13-reshuffle-30 wire recording says 2 across 70 emitter nodes (`BigSparks`/`LittleSparks`,
  // `particleRestartEpoch` 1 on every node, so the `_epoch` term does not split them); this is where that is
  // confirmed in a live DOM, where the geometry half of the key also applies.
  const specs = new Set();
  let specNodes = 0;
  for (const root of roots) {
    imgs += root.querySelectorAll("[data-godot-shader-image]").length;
    for (const el of root.querySelectorAll("[data-godot-particle-specs]")) {
      specNodes++;
      specs.add(el.getAttribute("data-godot-particle-specs"));
    }
  }
  return {
    count,
    bytes,
    defaultSized,
    imgs,
    specNodes,
    distinctSpecs: specs.size,
    pageTotal: all.length,
    pageWebgpu: webgpu,
    roots: roots.length
  };
}

// Hidden-ancestry scan of the `.mirror-stage` subtree — the round's primary DOM-diet metric, and the shared
// classifier behind both `--census` (the visible/hidden element split) and `--dom-styles` (the V/H line prefix,
// which is what makes "the A/B diff is confined to hidden-ancestry lines" mechanically checkable).
//
// An element is HIDDEN-ANCESTRY when it, or any ancestor up to the stage root, computes `display:none`. That is
// the population a dormant renderer stops building: `display:none` subtrees already cost no paint/composite, so
// the win shows up here (element count, style-recalc universe, heap) rather than in busy%.
//
// O(n): ONE getComputedStyle per element, hiddenness inherited top-down through an explicit pre-order DFS
// (document order, so the emitted style lines stay in the same order as the old querySelectorAll("*") dump).
// Ancestor `display:none` does NOT alter a descendant's COMPUTED display, so the per-element read is exact.
function hiddenAncestryInPage(opts) {
  const stage = document.querySelector(".mirror-stage");
  if (!stage) return null;
  const wantStyles = !!(opts && opts.styles);
  const lines = wantStyles ? [] : null;
  let elements = 0;
  let hiddenElements = 0;
  let mirrorNodes = 0;
  let hiddenMirrorNodes = 0;
  const roots = []; // topmost display:none elements (each hidden subtree is entered exactly once)

  const stageHidden = getComputedStyle(stage).display === "none";
  const stack = [];
  for (let i = stage.children.length - 1; i >= 0; i--) {
    stack.push({ el: stage.children[i], hidden: stageHidden, root: null });
  }
  while (stack.length > 0) {
    const frame = stack.pop();
    const el = frame.el;
    const selfNone = getComputedStyle(el).display === "none";
    const hidden = frame.hidden || selfNone;
    let root = frame.root;
    if (hidden && !frame.hidden) {
      root = {
        nodeId: el.getAttribute("data-node-id"),
        nodePath: el.getAttribute("data-node-path"),
        nodeType: el.getAttribute("data-node-type"),
        tag: el.tagName.toLowerCase(),
        elements: 0,
        mirrorNodes: 0
      };
      roots.push(root);
    }
    elements++;
    if (hidden) hiddenElements++;
    const isNode = el.classList.contains("mirror-node");
    if (isNode) {
      mirrorNodes++;
      if (hidden) hiddenMirrorNodes++;
    }
    if (root) {
      root.elements++;
      if (isNode) root.mirrorNodes++;
    }
    if (wantStyles) {
      const key = el.getAttribute("data-node-id") ?? `${el.tagName.toLowerCase()}.${el.getAttribute("class") ?? ""}`;
      const decl = el.style;
      const props = [];
      for (let i = 0; i < decl.length; i++) {
        const name = decl.item(i);
        props.push(`${name}:${decl.getPropertyValue(name)}`);
      }
      props.sort();
      lines.push(`${hidden ? "H" : "V"} ${key}|${props.join(";")}`);
    }
    for (let i = el.children.length - 1; i >= 0; i--) {
      stack.push({ el: el.children[i], hidden, root });
    }
  }

  roots.sort((a, b) => b.elements - a.elements);
  const ws = window.__mirrorWalkStats;
  return {
    // The whole `.mirror-stage *` population, split by ancestry. elements === the census's totalElements.
    elements,
    elementsHiddenAncestry: hiddenElements,
    elementsVisibleAncestry: elements - hiddenElements,
    hiddenPct: elements ? Math.round((hiddenElements / elements) * 1000) / 10 : 0,
    // Same split over the one-div-per-wire-node population.
    mirrorNodes,
    mirrorNodesHiddenAncestry: hiddenMirrorNodes,
    mirrorNodesVisibleAncestry: mirrorNodes - hiddenMirrorNodes,
    // How many distinct hidden subtrees exist (the dormancy candidates), + the biggest few by element count.
    hiddenSubtreeRoots: roots.length,
    hiddenSubtreeRootsTop: roots.slice(0, 8),
    // Renderer-side dormancy counters. Absent until the renderer workstream lands them — read defensively so
    // this stays a no-op on a baseline build, and surfaces the numbers automatically once it does.
    dormant: ws
      ? {
          dormantRoots: ws.dormantRoots ?? null,
          dormantSkippedBuilds: ws.dormantSkippedBuilds ?? null,
          revealBuilds: ws.revealBuilds ?? null,
          revealBuildMs: ws.revealBuildMs ?? null,
          createEl: ws.createEl ?? null
        }
      : null,
    styleLines: lines
  };
}

// ---------------------------------------------------------------------------------------------------------
// PAINT DUMP (--paint-dump) — the canvas-vs-DOM parity gate's currency. Post-settle, in-page.
// ---------------------------------------------------------------------------------------------------------
//
// TWO BACKENDS, ONE FORMAT. On `?stage=canvas` there is nothing to walk — the scene is one <canvas> — so the
// renderer hands its own draw list over through `window.__mirrorDrawListDump()` (canvasRenderer.ts), which is the
// authoritative record of what was painted and in what order. On the DOM stage the same record has to be
// RECONSTRUCTED from the elements, which is what everything below does. mirrorRenderer.ts is not touched: this is
// an observer, and it has to stay one or the gate would be comparing the canvas backend against a DOM backend
// that had been changed to make the comparison easy.
//
// THE THREE THINGS THE RECONSTRUCTION HAS TO GET RIGHT:
//
//   1. THE GLOBAL AFFINE. The mirror NESTS a node's element under its parent's, so a computed `matrix()` is a
//      LOCAL transform, not the design-space placement the draw list records. The composition is down the
//      offsetParent chain rather than the walk chain, because that is what the browser's own layout does: for an
//      absolutely-positioned element `offsetLeft/offsetTop` is the offset inside its containing block, and the
//      containing block IS `offsetParent` (a transformed ancestor establishes one, which is exactly the mirror's
//      shape). Pre-order guarantees the parent's global is already memoized when a child asks for it.
//   2. PAINT ORDER. Document order. The mirror's DOM is built in the producer's pre-order DFS and the stage sets
//      no z-index on nodes, so CSS stacking paints it in tree order — which is `mirrorRenderer.paintIndexOf`'s
//      own definition. It is NOT the canvas backend's z-sorted order; that is pre-registered divergence (a).
//   3. WHICH SUB-LAYER PAINTS WHAT. The DOM backend splits one node's paint across mirror-owned children
//      (`.mirror-atlas-region`, `.mirror-np-slice`, `.mirror-range-fill`, `.mirror-line`, the self layers) that
//      the draw list emits as commands on the NODE. Each is mapped back to the node id plus a ROLE, and the roles
//      are the same words `canvasRenderer.commandRole` uses, so the two dumps are comparable per node.
//
// WHAT THE DOM ARM CANNOT ANSWER: the SOURCE RECT. A CSS background expresses an atlas crop as
// `background-position` + `background-size` against an image whose intrinsic size is not exposed to a walk, so
// `src=?` is emitted and the comparer skips the field rather than guessing. The canvas arm's source rects are
// gated offline instead — `verify-canvas-drawlist.mjs` and canvasDrawList.spec.ts check them against
// `ninePatch.ninePatchAtlasQuads` and the region the wire carries.
function paintDumpInPage() {
  const stage = document.querySelector(".mirror-stage");
  if (!stage) return null;

  // THE DESIGN -> PAGE TRANSFORM, MEASURED. Both arms place the stage the same way — a `design.w x design.h` box,
  // flex-centred in the viewport, carrying `transform: scale(s)` about its centre — so a design-space coordinate in
  // any record below maps to a page pixel by one uniform scale and one offset. Any consumer that wants to cut a
  // rectangle out of the screenshot beside this dump needs that mapping, and a consumer that DERIVES it from the
  // viewport is one aspect ratio away from cropping the wrong pixels while reporting a number.
  //
  // So it is reported rather than derived: `offsetWidth/Height` is the stage's UN-transformed layout box (the
  // design box; `getBoundingClientRect` would already have the scale in it), the rect is where that box actually
  // landed on the page, and `devicePixelRatio` is the last multiplier between a CSS pixel and a screenshot one.
  // Consumers may use these measured values to validate crop geometry, so a letterboxed or high-DPI capture can
  // fail loudly rather than quietly.
  const stageRect = stage.getBoundingClientRect();
  const frame = {
    dpr: window.devicePixelRatio,
    stageBox: [stageRect.x, stageRect.y, stageRect.width, stageRect.height],
    designBox: [stage.offsetWidth, stage.offsetHeight]
  };

  // TEXT METRICS — the one section that is IDENTICAL code on both arms, because text is a DOM overlay on both.
  // Pre-registered divergence class (b) says text renders in the DOM on either backend, so the difference between
  // the arms ought to be antialiasing and nothing else. That claim is only checkable if the actual resolved
  // metrics are recorded: the computed font-size, the text-scale custom property feeding it, the `mirror-ts-*`
  // rules that were stamped, and how many LINES the label ended up on — a label that wraps on one backend and not
  // the other is a real fidelity bug and reads as a huge screenshot diff with no geometry difference behind it.
  /**
   * HOW MANY LINES THIS LABEL ACTUALLY RENDERED — one client rect per rendered line.
   *
   * THE BUG THIS REPLACES, and it made the field VACUOUS rather than merely noisy. It used to be
   * `round(div.scrollHeight / lineHeight)`, and `.mirror-text` is a FLEX CONTAINER stretched to the label's whole
   * box — so `scrollHeight` is the BOX's height, not the text's, and the expression reduced to
   * `round(boxHeight / lineHeight)` in every case. It never measured wrapping at all. Verified against the
   * canvas arm on the reward screen: all 12 disagreements were exactly that ratio, and three of them were
   * `white-space: pre` labels, which cannot wrap under any circumstances and were nonetheless reported as 2 lines.
   *
   * A Range over the inline content reports one rect per LINE BOX, which is the browser's own answer to the
   * question the field is asking. Falls back to the old expression only when there is no text node to range over.
   */
  function domLineCount(div, lineHeight) {
    const inner = div.firstElementChild ?? div;
    try {
      const range = document.createRange();
      range.selectNodeContents(inner);
      const rects = range.getClientRects();
      if (rects.length > 0) {
        // One rect per line box, but an inline run split by a nested element (a `[b]` span) yields several rects
        // on the SAME line — so count DISTINCT tops rather than rects, at a sub-pixel tolerance.
        const tops = [];
        for (const r of rects) {
          if (r.width === 0 && r.height === 0) continue;
          if (!tops.some((t) => Math.abs(t - r.top) < 1)) tops.push(r.top);
        }
        if (tops.length > 0) return tops.length;
      }
    } catch {
      // no Range in this context — fall through
    }
    return lineHeight > 0 ? Math.max(1, Math.round(inner.scrollHeight / lineHeight)) : 1;
  }

  function textLines() {
    const out = [];
    for (const div of document.querySelectorAll(".mirror-text")) {
      const owner = div.closest("[data-node-id]");
      const cs = getComputedStyle(div);
      const size = parseFloat(cs.fontSize) || 0;
      const lineHeight = parseFloat(cs.lineHeight) || size * 1.1 || 1;
      const scale = (getComputedStyle(owner ?? div).getPropertyValue("--godot-text-scale") || "").trim() || "-";
      const ts = owner
        ? Array.from(owner.classList)
            .filter((c) => c.startsWith("mirror-ts-"))
            .sort()
            .join(",") || "-"
        : "-";
      const family = (cs.fontFamily || "-").split(",")[0].replace(/["']/g, "").replace(/\s+/g, "_");
      out.push(
        `T ${owner ? owner.getAttribute("data-node-id") : "?"}` +
          ` font=${size.toFixed(2)} lineHeight=${lineHeight.toFixed(2)}` +
          ` family=${family} scale=${scale} ts=${ts}` +
          ` box=${div.clientWidth}x${div.clientHeight}` +
          ` lines=${domLineCount(div, lineHeight)}` +
          ` white=${cs.whiteSpace}`
      );
    }
    return out;
  }

  const readDump = window.__mirrorDrawListDump;
  if (typeof readDump === "function") {
    return { backend: "canvas", lines: readDump().concat(textLines()), ...frame };
  }

  const num = (v) => (Object.is(v, -0) || !Number.isFinite(v) ? "0.000" : v.toFixed(3));
  const IDENTITY = [1, 0, 0, 1, 0, 0];
  // a ∘ b, Godot Transform2D order [xx, xy, yx, yy, ox, oy].
  const mul = (a, b) => [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5]
  ];
  const translate = (x, y) => [1, 0, 0, 1, x, y];

  /** A computed `transform` string as a 2x3 affine, about the element's own transform-origin. */
  function localMatrix(cs) {
    const t = cs.transform;
    if (!t || t === "none") return IDENTITY;
    const m = /^matrix\(([^)]+)\)$/.exec(t);
    let a;
    if (m) {
      a = m[1].split(",").map(Number);
    } else {
      const m3 = /^matrix3d\(([^)]+)\)$/.exec(t);
      if (!m3) return IDENTITY;
      const v = m3[1].split(",").map(Number);
      // The 2D sub-matrix of a 3D one: columns 0 and 1, plus the translation.
      a = [v[0], v[1], v[4], v[5], v[12], v[13]];
    }
    if (a.length !== 6 || a.some((n) => !Number.isFinite(n))) return IDENTITY;
    const origin = (cs.transformOrigin || "0px 0px").split(" ").map(parseFloat);
    const ox = Number.isFinite(origin[0]) ? origin[0] : 0;
    const oy = Number.isFinite(origin[1]) ? origin[1] : 0;
    return mul(translate(ox, oy), mul(a, translate(-ox, -oy)));
  }

  const globals = new Map(); // element -> its design-space affine
  globals.set(stage, IDENTITY);

  function globalOf(el, cs) {
    const cached = globals.get(el);
    if (cached) return cached;
    const op = el.offsetParent;
    // An offsetParent outside the stage means the stage itself is the reference frame (it is `position:relative`,
    // so this only happens for a `position:fixed` descendant — CouchCoop chrome, never a scene node).
    const base = op && stage.contains(op) && op !== stage ? globals.get(op) ?? IDENTITY : IDENTITY;
    const dx = el.offsetLeft - (op && op !== stage ? op.scrollLeft : 0);
    const dy = el.offsetTop - (op && op !== stage ? op.scrollTop : 0);
    const g = mul(base, mul(translate(dx, dy), localMatrix(cs)));
    globals.set(el, g);
    return g;
  }

  /** The url inside a `background-image` / `src`, stripped of quotes and of the page origin. */
  function textureOf(el, cs) {
    if (el.tagName === "IMG" && el.src) return el.src;
    const bg = cs.backgroundImage;
    if (bg && bg !== "none") {
      const m = /url\((?:"|')?([^"')]+)(?:"|')?\)/.exec(bg);
      if (m) return m[1];
    }
    const bi = cs.borderImageSource;
    if (bi && bi !== "none") {
      const m = /url\((?:"|')?([^"')]+)(?:"|')?\)/.exec(bi);
      if (m) return m[1];
    }
    return null;
  }

  /** `rgba(r, g, b, a)` -> premultiplied 0..1, times the composed opacity, the way a draw list stores colour. */
  function premultiplied(color, opacity) {
    const m = /rgba?\(([^)]+)\)/.exec(color || "");
    if (!m) return null;
    const v = m[1].split(",").map((s) => parseFloat(s));
    if (v.length < 3) return null;
    const a = (v.length > 3 ? v[3] : 1) * opacity;
    return [(v[0] / 255) * a, (v[1] / 255) * a, (v[2] / 255) * a, a];
  }

  const BLEND_WORDS = { normal: "mix", "plus-lighter": "add", screen: "add", multiply: "mul", difference: "sub" };

  // Which mirror-owned sub-layer class maps to which draw-list role. The node's own element and the two self
  // layers carry the node's background, so they resolve by what they actually paint rather than by class.
  const ROLE_BY_CLASS = {
    "mirror-atlas-region": "tex",
    "mirror-atlas-page": "tex",
    "mirror-atlas-canvas": "tex",
    "mirror-intent-img": "tex",
    "mirror-np-slice": "tex",
    "mirror-range-fill": "range",
    "mirror-line": "line"
  };
  // Sub-layer classes that carry no paint of their own — a window/container the mirror wraps the real paint in.
  // They are walked THROUGH (their children still paint) but emit nothing, so a container's box cannot be read as
  // a command the other backend is missing.
  const PASS_THROUGH_CLASSES = ["mirror-intent-view", "mirror-intent-strip"];
  // `.mirror-intent-*` is deliberately NOT here: the intent strip is a plain atlas image the draw list paints as a
  // quad (one `tex` command per intent), so classifying it as a spine overlay would report every intent icon as a
  // canvas-only command and a DOM-only overlay at once. `.mirror-intent-img` is mapped to `tex` below instead.
  const OVERLAY_BY_CLASS = {
    "mirror-text": "text",
    "mirror-shader-self": "shader",
    "mirror-particle-self": "particles",
    "mirror-spine-canvas": "spine",
    "mirror-spine-img": "spine",
    "mirror-trail": "trail"
  };

  const lines = [];
  const overlaySeen = new Map(); // nodeId -> kind (one overlay record per node, like the draw list)
  const stats = { elements: 0, hidden: 0, painted: 0, clips: 0, unowned: 0 };
  let painted = 0;

  // Pre-order DFS, exactly the traversal `hiddenAncestryInPage` runs (document order, hiddenness inherited
  // top-down), plus the two frames the paint dump needs: the owning scene node id and the enclosing clip scope.
  const stack = [];
  const stageHidden = getComputedStyle(stage).display === "none";
  const ninePatched = new Set(); // node ids whose nine-patch bands have already been reported (see below)
  for (let i = stage.children.length - 1; i >= 0; i--) {
    stack.push({ el: stage.children[i], hidden: stageHidden, nodeId: null, type: "-", clip: "-", opacity: 1, inText: false });
  }
  while (stack.length > 0) {
    const frame = stack.pop();
    const el = frame.el;
    if (el.nodeType !== 1) continue;
    const cs = getComputedStyle(el);
    stats.elements++;
    const selfNone = cs.display === "none";
    const hidden = frame.hidden || selfNone || cs.visibility === "hidden";
    if (hidden) stats.hidden++;
    const g = globalOf(el, cs);
    const ownOpacity = parseFloat(cs.opacity);
    const opacity = frame.opacity * (Number.isFinite(ownOpacity) ? ownOpacity : 1);
    const nodeId = el.getAttribute("data-node-id") ?? frame.nodeId;
    const nodeType = el.getAttribute("data-node-type") ?? frame.type;

    // A clip scope: the DOM twin of a `clipPush`. Reported under the SCENE NODE that clips, which is the id the
    // draw list's `clipRanges` are keyed by, so the two arms name the same scope.
    let clip = frame.clip;
    // Only a SCENE NODE's own element opens a scope: the draw list's `clipRanges` are keyed by node id, and a
    // mirror-OWNED window (`.mirror-intent-view`) is chrome the draw list has no command for.
    const ownsNode = el.hasAttribute("data-node-id");
    const clipsHere =
      !hidden && ownsNode && (cs.overflow === "hidden" || cs.overflowX === "hidden" || cs.overflowY === "hidden");
    if (clipsHere) {
      const r = el.getBoundingClientRect();
      // The PADDING box, which is where CSS `overflow` actually clips — reported with the border widths beside it
      // because on a nine-patch element (`border-image` + `border-width`) the padding box is inset by the patch
      // margins, and the draw list clips to the node's RECT. That difference is real and the border is the
      // evidence for it, so both numbers are in the line rather than one derived number.
      const w = el.clientWidth || r.width;
      const h = el.clientHeight || r.height;
      const bl = parseFloat(cs.borderLeftWidth) || 0;
      const bt = parseFloat(cs.borderTopWidth) || 0;
      const br = parseFloat(cs.borderRightWidth) || 0;
      const bb = parseFloat(cs.borderBottomWidth) || 0;
      const radius = parseFloat(cs.borderTopLeftRadius) || 0;
      lines.push(
        `K ${nodeId} rect=${num(g[4] + bl)},${num(g[5] + bt)},${num(w)},${num(h)} radius=${num(radius)} outset=0.000` +
          ` border=${num(bl)},${num(bt)},${num(br)},${num(bb)} scope=${clip}`
      );
      stats.clips++;
      clip = nodeId;
    }

    if (!hidden && nodeId) {
      const classes = el.classList;
      let overlayKind = null;
      for (const key in OVERLAY_BY_CLASS) {
        if (classes.contains(key)) {
          overlayKind = OVERLAY_BY_CLASS[key];
          break;
        }
      }
      // gsw mounts its WebGL shader / particle runtimes on marked elements rather than on a mirror class.
      if (!overlayKind && (el.hasAttribute("data-godot-shader-webgl") || el.hasAttribute("data-godot-shader-image"))) {
        overlayKind = "shader";
      }
      if (!overlayKind && el.hasAttribute("data-godot-particle-runtime")) {
        overlayKind = "particles";
      }
      let passThrough = false;
      for (const key of PASS_THROUGH_CLASSES) {
        if (classes.contains(key)) {
          passThrough = true;
          break;
        }
      }
      // INSIDE a text overlay — the DESCENDANTS of `.mirror-text`, never `.mirror-text` itself (that element IS
      // the text overlay and still registers as one). gsw's rich text builds real elements for a bbcode `[img]`:
      // a card description's inline energy icon is a `<span>` with a background-image. Those pixels belong to the
      // TEXT surface, which is a DOM overlay on BOTH backends (class (b)), so they must not be read as quads the
      // canvas backend failed to emit. The subtree is still walked — its metrics are what the `T` records report.
      if (frame.inText) {
        for (let i = el.children.length - 1; i >= 0; i--) {
          stack.push({ el: el.children[i], hidden, nodeId, type: nodeType, clip, opacity, inText: true });
        }
        continue;
      }
      if (passThrough) {
        // walked through: its children carry the paint
      } else if (overlayKind) {
        // THE SAME ALPHA FLOOR THE BUILDER USES. `nodeStyles.nodePaintsContent` refuses anything at or under 0.02
        // effective opacity, so a faded-out label is not in the draw list's overlay records — while its DOM
        // element still exists, still has a box, and is neither `display:none` nor `visibility:hidden`. Without
        // this the gate reports every invisible label as a canvas MISS.
        if (opacity > 0.02 && !overlaySeen.has(nodeId)) {
          overlaySeen.set(nodeId, { kind: overlayKind, type: nodeType, g, w: el.offsetWidth, h: el.offsetHeight });
        }
      } else {
        let classRole = null;
        for (const key in ROLE_BY_CLASS) {
          if (classes.contains(key)) {
            classRole = ROLE_BY_CLASS[key];
            break;
          }
        }
        // A NINE-PATCH-over-atlas is NINE `.mirror-np-slice` spans in the DOM and ONE `DRAW_NINE_PATCH` command on
        // the canvas — the executor expands it, the browser cannot. The bands tile their parent's border box
        // exactly (ninePatch.ninePatchAtlasQuads is the shared decomposition), so the parent's placement IS the
        // command's, and the whole band set is reported once under the node rather than nine times.
        // A framed sub-layer whose ELEMENT is bigger than what is shown: the intent strip is one wide filmstrip
        // slid inside a narrow `.mirror-intent-view` window, so `offsetWidth` is the whole strip while the draw
        // list emits one quad the size of the WINDOW. The visible box is the parent's, on both counts.
        const isSlice = classes.contains("mirror-np-slice");
        const isFramed = classes.contains("mirror-intent-img");
        const box = (isSlice || isFramed) && el.parentElement ? el.parentElement : el;
        const boxCs = box === el ? cs : getComputedStyle(box);
        const boxG = box === el ? g : globalOf(box, boxCs);
        if (isSlice) {
          if (ninePatched.has(nodeId)) {
            for (let i = el.children.length - 1; i >= 0; i--) {
              stack.push({ el: el.children[i], hidden, nodeId, type: nodeType, clip, opacity, inText: false });
            }
            continue;
          }
          ninePatched.add(nodeId);
        }
        const w = box.offsetWidth || parseFloat(boxCs.width) || 0;
        const h = box.offsetHeight || parseFloat(boxCs.height) || 0;
        const blend = BLEND_WORDS[cs.mixBlendMode] ?? cs.mixBlendMode ?? "mix";
        const tex = textureOf(el, cs);
        const emit = (role, rgba, texture) => {
          if (!rgba || rgba[3] <= 0.001) return;
          lines.push(
            `C ${painted} ${nodeId} ${isSlice || cs.borderImageSource !== "none" ? "ninePatch" : "quad"}` +
              ` role=${role} type=${nodeType}` +
              ` m=${num(boxG[0])},${num(boxG[1])},${num(boxG[2])},${num(boxG[3])},${num(boxG[4])},${num(boxG[5])}` +
              ` wh=${num(w)},${num(h)}` +
              ` src=?` +
              // THE ASPECT-FIT TELL. Godot's `contain`/`cover` stretch modes are resolved by the BUILDER into the
              // fitted destination rect (`emitPlainTexture`), and by CSS into a `background-size` keyword over an
              // unchanged element box. So on those two the arms record different rectangles for the same picture,
              // and the comparer has to know which case it is looking at — this field is how it does.
              ` fit=${cs.backgroundSize === "contain" || cs.backgroundSize === "cover" ? cs.backgroundSize : "fill"}` +
              ` rgba=${num(rgba[0])},${num(rgba[1])},${num(rgba[2])},${num(rgba[3])}` +
              ` blend=${blend} flip=-- cm=${cs.filter && cs.filter !== "none" ? "1" : "0"}` +
              ` tex=${texture ?? "-"} clip=${clip}`
          );
          painted++;
          stats.painted++;
        };
        if (classRole === "line") {
          // The stroke's own svg: geometry lives in child <path>/<polyline> elements, so the record is the
          // placement + the composed stroke colour, which is what a `polyline` command carries too.
          const shape = el.querySelector("path, polyline, line");
          const scs = shape ? getComputedStyle(shape) : null;
          emit("line", premultiplied(scs ? scs.stroke : "rgba(255,255,255,1)", opacity), null);
        } else if (classRole === "range") {
          emit("range", premultiplied(cs.backgroundColor, opacity), null);
        } else if (classRole === "tex") {
          emit("tex", [opacity, opacity, opacity, opacity], tex);
        } else {
          // The node's own element (or a self layer): background-COLOR is the `fill_color` quad, background-IMAGE
          // (or a border-image) is the texture command, in that back-to-front order — `emitNodePaint`'s order.
          emit("fill", premultiplied(cs.backgroundColor, opacity), null);
          if (tex) emit("tex", [opacity, opacity, opacity, opacity], tex);
        }
      }
    }

    for (let i = el.children.length - 1; i >= 0; i--) {
      stack.push({
        el: el.children[i],
        hidden,
        nodeId,
        type: nodeType,
        clip,
        opacity,
        inText: frame.inText || el.classList.contains("mirror-text")
      });
    }
  }

  for (const [nodeId, rec] of overlaySeen) {
    const g = rec.g;
    lines.push(
      `O 0 ${nodeId} ${rec.kind} type=${rec.type}` +
        ` m=${num(g[0])},${num(g[1])},${num(g[2])},${num(g[3])},${num(g[4])},${num(g[5])}` +
        ` wh=${num(rec.w)},${num(rec.h)}`
    );
  }

  return { backend: "dom", lines: lines.concat(textLines()), stats, ...frame };
}

// ---------------------------------------------------------------------------------------------------------
// PRESENCE + GEOMETRY PROBE (--report) — post-settle, in-page. Backend-agnostic, ZERO new renderer code.
// ---------------------------------------------------------------------------------------------------------
//
// Feeds the shared perf-report/1 envelope's `env.geometry` and `metrics.presented` blocks. The pixel check
// itself (nonEmptyRatio / sampleHits) is a verbatim port of godot-scene-web's `checkPresence`
// (`scripts/lib/screenshot-presence.mjs`); this only picks WHERE to sample.
//
// Sample points come from `window.__mirrorHitProbe` — the same read-only seam `--hit-grid` uses, published by
// MirrorView on both stage backends. A grid point is kept ONLY where the renderer reports it painted a node
// (`painter.id` or a non-empty hit stack), so this is "sample the places content actually is", not a blind
// grid that could pass a blank region. Fallback for a bundle without the seam: painted scene-node element
// centres (DOM arm only — the canvas arm has no scene DOM, so a missing seam there fails the guard).
function presenceProbeInPage() {
  const stage = document.querySelector(".mirror-stage");
  if (!stage) return { error: "no .mirror-stage on the page" };
  const rect = stage.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return { error: "the .mirror-stage has a zero box" };

  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const dpr = window.devicePixelRatio;
  const designBox = { width: stage.offsetWidth, height: stage.offsetHeight };
  const stageRect = { width: rect.width, height: rect.height };
  const canvasStats = typeof window.__mirrorCanvasStats === "function" ? window.__mirrorCanvasStats() : null;
  const backend = canvasStats && canvasStats.backend === "canvas" ? "canvas" : "dom";

  const inViewport = (x, y) => x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height;
  const viewportArea = viewport.width * viewport.height;
  const points = [];

  if (backend === "dom") {
    // The DOM arm renders every scene node as a `.mirror-node` element. Presence points go at the centres
    // of the ATLAS-BACKED sprite leaves — elements carrying a `background-image` (the mirror paints every
    // Godot texture that way) or an <img>. These are opaque at their centre; text spans and bare
    // positioning divs are skipped because a glyph gap or a transparent wrapper would be a false miss on a
    // scene that rendered perfectly. Requiring EVERY point to hit is only honest with points chosen to be
    // on solid pixels.
    const scored = [];
    for (const el of stage.querySelectorAll(".mirror-node")) {
      if (el.querySelector(".mirror-node")) continue; // not a leaf
      // Most .mirror-node elements are mounted inside display:none / visibility:hidden screens (Settings,
      // Map, …) — they still carry a getBoundingClientRect box but paint nothing. `checkVisibility` walks
      // the ancestry for display / visibility / opacity:0 / content-visibility.
      if (
        typeof el.checkVisibility === "function" &&
        !el.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
          opacityProperty: true,
          visibilityProperty: true,
          contentVisibilityAuto: true,
        })
      ) {
        continue;
      }
      const b = el.getBoundingClientRect();
      const area = b.width * b.height;
      if (!(b.width >= 12) || !(b.height >= 12) || area < 400 || area > viewportArea * 0.5) continue;
      const cx = b.left + b.width / 2;
      const cy = b.top + b.height / 2;
      if (!inViewport(cx, cy)) continue;
      const cs = getComputedStyle(el);
      if (Number.parseFloat(cs.opacity) < 0.95) continue;
      const hasBgImage = cs.backgroundImage && cs.backgroundImage !== "none";
      const isImg = el.tagName === "IMG";
      if (!hasBgImage && !isImg) continue;
      // A background-image div that only draws a slice of its box places the sprite via `background-position`
      // / `background-size: cover|contain` — the CENTRE is still the safest opaque bet, and checkPresence
      // samples a small box around it.
      scored.push({ area, x: Math.round(cx), y: Math.round(cy) });
    }
    scored.sort((a, b) => b.area - a.area);
    for (const s of scored.slice(0, 20)) points.push({ x: s.x, y: s.y });
  } else {
    // The canvas arm has no scene DOM. `window.__mirrorHitProbe` (the seam --hit-grid uses) answers, per
    // viewport point, whether a node paints / hit-tests there — a real "content here" signal.
    const probe = window.__mirrorHitProbe;
    if (typeof probe === "function") {
      const cols = 11;
      const rows = 8;
      const cw = stage.clientWidth || rect.width;
      const ch = stage.clientHeight || rect.height;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = rect.left + ((c + 0.5) / cols) * rect.width;
          const y = rect.top + ((r + 0.5) / rows) * rect.height;
          if (!inViewport(x, y)) continue;
          const gx = ((x - rect.left) / rect.width) * cw;
          const gy = ((y - rect.top) / rect.height) * ch;
          try {
            const res = probe(x, y, rect.width, gx, gy);
            const painted = !!res?.painter?.id;
            const stacked = Array.isArray(res?.stack?.ids) && res.stack.ids.length > 0;
            if (painted || stacked) points.push({ x: Math.round(x), y: Math.round(y) });
          } catch {
            /* a probe throw at one point is not a presence failure — skip it */
          }
        }
      }
    }
  }

  return {
    viewport,
    dpr,
    designBox,
    stageRect,
    backend,
    hasHitProbe: typeof window.__mirrorHitProbe === "function",
    samplePoints: points,
  };
}

// ---------------------------------------------------------------------------------------------------------
// RAISE PROBE (--raise-probe) — post-settle, in-page. One shape, two backends, ZERO new DOM renderer code.
// ---------------------------------------------------------------------------------------------------------
//
// U3b: with the readable-hand mode on, the raised health bar and powers sit a little higher on the canvas stage
// than on the DOM one. Two mechanisms could produce that and a screenshot cannot tell them apart, so the two
// arms are compared on the WORKING rather than the picture — see `canvasRenderer.raiseProbe`.
//
// The canvas arm publishes `window.__mirrorRaiseProbe()`. The DOM arm publishes nothing and does not need to:
// its raise IS a cosmetic `translate` written on the group's own element, so its effective answer is readable
// off the DOM with no renderer change at all. The two identity attributes used here (`data-scene-node-path`,
// `data-node-id`) are stamped by the DOM backend for every element already.
function raiseProbeInPage() {
  if (typeof window.__mirrorRaiseProbe === "function") {
    return window.__mirrorRaiseProbe();
  }
  const groups = [];
  const holders = [];
  // The two creature HUD group names the mode moves, and the class the DOM stamps on everything it raises.
  const GROUP_PATHS = new Set(["HealthBar", "Intents"]);
  // THE FACTOR THE DOM'S SHIFT ACTUALLY GETS. CSS `translate` composes OUTSIDE the element's own matrix (used
  // transform = translate . transform), so the node's own scale never stretches its own lift — but every
  // ANCESTOR element's matrix does. That accumulated scale is the whole of mechanism (1): the canvas adds its
  // offset in global design space times the inherited VIEW-SCALE product only, so wherever these two differ the
  // two backends draw the same authored dy at different sizes.
  const ancestorScaleY = (el) => {
    let k = 1;
    for (let p = el.parentElement; p != null; p = p.parentElement) {
      if (p.classList.contains("mirror-stage")) break;
      const mm = /matrix\(([^)]*)\)/.exec(p.style.transform || "");
      if (mm) {
        const v = mm[1].split(",").map((x) => Number(x.trim()));
        if (v.length >= 6 && Number.isFinite(v[3])) k *= v[3];
      }
    }
    return k;
  };
  for (const el of document.querySelectorAll("[data-node-id]")) {
    const raisable = el.classList.contains("mirror-hand-raisable");
    if (!raisable) continue;
    // `translate` is the raise's own channel on this backend; "0px" / "" is the rest value.
    const t = el.style.translate || "";
    const dy = t === "" || t === "0px" ? 0 : Number((t.split(/\s+/)[1] ?? "0px").replace("px", "")) || 0;
    // The baked matrix is what the walk placed it at; `translate` composes on top in PARENT space.
    const m = /matrix\(([^)]*)\)/.exec(el.style.transform || "");
    const parts = m ? m[1].split(",").map((v) => Number(v.trim())) : null;
    const row = {
      id: el.getAttribute("data-node-id"),
      name: el.getAttribute("data-scene-node-path"),
      dy,
      bakedY: parts && parts.length >= 6 ? parts[5] : null,
      bakedScaleY: parts && parts.length >= 6 ? parts[3] : null,
      ancestorScaleY: ancestorScaleY(el)
    };
    if (GROUP_PATHS.has(row.name ?? "")) {
      groups.push(row);
    } else {
      holders.push(row);
    }
  }
  // R8 — THE DRAWN-HEIGHT SEAM, and the one thing above that is NOT comparable with the canvas arm. `bakedY` is
  // the element's own `matrix()` translate, i.e. PARENT space; the canvas publishes `drawnY` in DESIGN space, and
  // differencing those two is meaningless (the live run reported NOT COMPARABLE for exactly this reason).
  // `__mirrorHandRaise().creatureGroupRows` publishes the DOM's design-space twin of that term — the streamed
  // global m[5] plus the same `raiseDy` the raise pass wrote — over the same `creatureHudIds` population, keyed by
  // the same ids these rows carry. So the join is exact.
  //
  // DEFENSIVE BY CONSTRUCTION: a build without the seam leaves every field null, and the verdict degrades to the
  // NOT COMPARABLE it printed before rather than crashing or inventing a number.
  let raiseRows = null;
  let creatureRows = [];
  try {
    const dbg = typeof window.__mirrorHandRaise === "function" ? window.__mirrorHandRaise() : null;
    if (dbg && Array.isArray(dbg.creatureGroupRows)) raiseRows = new Map(dbg.creatureGroupRows.map((r) => [r.id, r]));
    // R9 — the per-creature ANCHOR terms, the twin of the canvas arm's `creatures[]`: the measurement's own
    // working plus where this backend drew the reticle, the state display and the first power row's bottom edge.
    // That last relationship IS the user's report ("the powers should sit directly above the target box"), so it
    // is carried on both arms rather than inferred from two heights that were measured differently.
    if (dbg && Array.isArray(dbg.creatures)) creatureRows = dbg.creatures;
  } catch {
    raiseRows = null;
  }
  for (const row of groups) {
    const r = raiseRows ? raiseRows.get(row.id) : null;
    row.streamedY = r && Number.isFinite(r.streamedY) ? r.streamedY : null;
    row.drawnY = r && Number.isFinite(r.drawnY) ? r.drawnY : null;
    // Report-only cross-check: the renderer's own record of the lift against the `translate` read off the element
    // above. They are two readings of one write, so a disagreement means the DOM row itself is not trustworthy.
    row.renderDy = r && Number.isFinite(r.dy) ? r.dy : null;
  }
  const stats = typeof window.__mirrorWalkStats === "object" ? window.__mirrorWalkStats : null;
  return {
    backend: "dom",
    // The DOM has no plan object to read a lift off; the raised holders' own dy is the observable.
    enabled: groups.length + holders.length > 0,
    liftPx: null,
    gates: stats && typeof stats.targetingArrows === "number" ? { targetingArrows: stats.targetingArrows } : null,
    viewScaleStamps: null,
    holders,
    groups,
    creatures: creatureRows
  };
}

// ---------------------------------------------------------------------------------------------------------
// HIT-TEST GRID (--hit-grid) — post-settle, in-page. Backend-agnostic by construction.
// ---------------------------------------------------------------------------------------------------------
//
// `?hitTest=both` cannot exist as a single-page lever: the canvas arm has NO scene DOM, so there is no
// `elementsFromPoint` path to run beside its own. The comparable thing is therefore a DUAL RUN — sample the same
// grid of viewport points through the RENDERER SEAMS on each backend and diff the two files. Both backends
// implement `touchStackAt` / `spreadPainterAt` / `mapNodeAt` against the same `MirrorRenderer` interface, so the
// probe below is identical code on both arms and any difference is a difference in the backends.
//
// The seams are reached through `window.__mirrorHitProbe`, which MirrorView publishes for exactly this kind of
// harness. Every call is a pure query — nothing is clicked, nothing is armed, no state moves.
function hitGridInPage(opts) {
  const probe = window.__mirrorHitProbe;
  const stage = document.querySelector(".mirror-stage");
  if (typeof probe !== "function" || !stage) return null;
  const rect = stage.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  const step = opts && opts.step > 0 ? opts.step : 96;
  const lines = [];
  let samples = 0;
  for (let y = Math.round(rect.top) + Math.round(step / 2); y < rect.bottom; y += step) {
    for (let x = Math.round(rect.left) + Math.round(step / 2); x < rect.right; x += step) {
      // Design-space coordinates, so the two arms name the same point even if the stage box differs by a pixel.
      // At 1920x1080 — the only viewport this gate runs at — design space IS the game's 1920-space on both
      // backends, so the same numbers are what `confirmTapAt` wants.
      const dx = ((x - rect.left) / rect.width) * (stage.clientWidth || rect.width);
      const dy = ((y - rect.top) / rect.height) * (stage.clientHeight || rect.height);
      let stackIds = [];
      let blocked = null;
      let painter = "-";
      let mapNode = "-";
      let confirm = "-";
      let cover = "-";
      try {
        const r = probe(x, y, rect.width, dx, dy);
        const s = r ? r.stack : null;
        if (s) {
          stackIds = Array.isArray(s.ids) ? s.ids : [];
          blocked = s.blocked ?? null;
        }
        const p = r ? r.painter : null;
        painter = p === undefined ? "undef" : p === null ? "null" : (p.id ?? "?");
        mapNode = (r ? r.mapNode : null) ?? "-";
        const c = r ? r.confirm : null;
        confirm = c ? `${c.kind}:${c.id}` : "-";
        cover = r && r.cover !== null && r.cover !== undefined ? String(r.cover) : "-";
      } catch (e) {
        stackIds = [`!${String(e && e.message ? e.message : e)}`];
        painter = "!err";
        mapNode = "!err";
        confirm = "!err";
      }
      lines.push(
        `P ${Math.round(dx)},${Math.round(dy)}` +
          ` top=${stackIds.length > 0 ? stackIds[0] : "-"}` +
          ` depth=${stackIds.length}` +
          ` blocked=${blocked === null ? "-" : String(blocked)}` +
          ` painter=${painter}` +
          ` map=${mapNode}` +
          ` confirm=${confirm}` +
          ` cover=${cover}` +
          ` stack=${stackIds.slice(0, 6).join(">") || "-"}`
      );
      samples++;
    }
  }
  return { lines, samples, step, stageBox: `${Math.round(rect.width)}x${Math.round(rect.height)}` };
}

// ---------------------------------------------------------------------------------------------------------
// reveal-burst measurement (--reveal-burst) — post-settle, in-page.
// ---------------------------------------------------------------------------------------------------------
//
// Delivers the synthetic reveal delta through the fake WS's `_deliver` (a real MessageEvent carrying the raw
// string), then measures the reconcile it causes. The client applies the delta SYNCHRONOUSLY in `onmessage`
// (mirrorClient: parseSceneDelta → applySceneDelta → notify) but RENDERS on a coalescing rAF (MirrorView's
// `scheduleRender`), so the reveal walk is one frame later — polling `__mirrorWalkStats.walks` for an increment
// is the seam that brackets it. Reported: the synchronous parse/apply cost, wall time until the walk was
// observed, that walk's own `lastWalkMs`, the settled walk/createEl totals, and the element counts before/after.
async function revealBurstInPage(payload) {
  const ws = window.__benchWs;
  if (!ws || typeof ws._deliver !== "function") return { error: "no bench WebSocket in page" };
  const stats = window.__mirrorWalkStats ?? null;
  const snap = () => ({
    walks: stats ? stats.walks : null,
    totalWalkMs: stats ? stats.totalWalkMs : null,
    lastWalkMs: stats ? stats.lastWalkMs : null,
    createEl: stats ? (stats.createEl ?? null) : null,
    revealBuilds: stats ? (stats.revealBuilds ?? null) : null,
    revealBuildMs: stats ? (stats.revealBuildMs ?? null) : null,
    // R10-PERF6 WS-P2: the staggered reveal's counters. They belong HERE and nowhere else — the run-level
    // walkStats in BENCH_RESULT are snapshotted before the reveal burst is injected, so reading the stagger
    // there always reports zero no matter what the reveal did (a false negative that cost this round an hour).
    revealStaggerHolds: stats ? (stats.revealStaggerHolds ?? null) : null,
    revealStaggerHeldNodes: stats ? (stats.revealStaggerHeldNodes ?? null) : null,
    revealStaggerBatches: stats ? (stats.revealStaggerBatches ?? null) : null,
    atlasWarmedRegions: stats ? (stats.atlasWarmedRegions ?? null) : null,
    // The BAKER's own state. A map that opens with hundreds of <canvas> sprites (and the layer explosion that
    // follows) has exactly two possible causes — the bakes had not finished, or the baker's slow-bake sticky
    // revert turned the whole div mechanism off for the session — and only this tells the two apart.
    bake: window.__mirrorAtlasBakeStats ? { ...window.__mirrorAtlasBakeStats } : null
  });
  const stage = document.querySelector(".mirror-stage");
  const rootSel = `[data-node-id="${payload.nodeId}"]`;
  const countEls = () => {
    const rootEl = stage ? stage.querySelector(rootSel) : null;
    return {
      elements: stage ? stage.querySelectorAll("*").length : 0,
      mirrorNodes: document.querySelectorAll(".mirror-node").length,
      rootFound: !!rootEl,
      rootDisplay: rootEl ? getComputedStyle(rootEl).display : null,
      rootSubtreeElements: rootEl ? rootEl.querySelectorAll("*").length + 1 : 0
    };
  };

  const errors = [];
  const onError = (e) => errors.push(String(e.message ?? e));
  window.addEventListener("error", onError);

  // Warm the frame loop. A settled headless page stops producing compositor frames, and the FIRST rAF after that
  // idleness can be scheduled hundreds of ms out — which would land entirely in `toFirstWalkMs` and swamp the
  // number it is supposed to report (how long the user waits for the reveal). Three back-to-back rAFs put the
  // loop back on a ~16ms cadence before the clock starts.
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => requestAnimationFrame(() => r()));
  }

  const before = { ...snap(), ...countEls() };
  const t0 = performance.now();
  ws._deliver(payload.raw);
  // Everything the client does synchronously in its message handler: JSON.parse + applySceneDelta + notify.
  const applyMs = performance.now() - t0;

  // Wait for the rAF-coalesced reconcile that the revision bump scheduled.
  let observedWalk = false;
  const deadline = t0 + (payload.timeoutMs ?? 5000);
  while (stats && performance.now() < deadline) {
    if (stats.walks !== before.walks) { observedWalk = true; break; }
    await new Promise((r) => requestAnimationFrame(() => r()));
  }
  const toFirstWalkMs = performance.now() - t0;
  const atFirstWalk = snap();

  // Settle: let follow-up work (texture/atlas re-styles the reveal triggered) land before the final counts.
  await new Promise((r) => setTimeout(r, payload.settleMs ?? 800));
  const settled = { ...snap(), ...countEls() };
  window.removeEventListener("error", onError);

  const d = (a, b) => (typeof a === "number" && typeof b === "number" ? Math.round((b - a) * 100) / 100 : null);
  return {
    nodeId: payload.nodeId,
    observedWalk,
    // The synchronous half (parse + apply into the retained map). Small by design — the walk is the cost.
    applyMs: Math.round(applyMs * 100) / 100,
    // Wall clock from delivering the message to observing the walk counter move (includes the rAF wait, so it
    // is bounded below by one frame — read it as user-perceived latency, not as walk cost).
    toFirstWalkMs: Math.round(toFirstWalkMs * 100) / 100,
    // The reveal walk itself: the gate metric.
    firstWalkMs: typeof atFirstWalk.lastWalkMs === "number" ? Math.round(atFirstWalk.lastWalkMs * 100) / 100 : null,
    walkMsAtFirstWalk: d(before.totalWalkMs, atFirstWalk.totalWalkMs),
    walksAtFirstWalk: d(before.walks, atFirstWalk.walks),
    createElAtFirstWalk: d(before.createEl, atFirstWalk.createEl),
    // …and everything the reveal cost including the follow-up settle.
    settleWalkMs: d(before.totalWalkMs, settled.totalWalkMs),
    settleWalks: d(before.walks, settled.walks),
    settleCreateEl: d(before.createEl, settled.createEl),
    revealBuilds: d(before.revealBuilds, settled.revealBuilds),
    revealBuildMs: d(before.revealBuildMs, settled.revealBuildMs),
    revealStaggerHolds: d(before.revealStaggerHolds, settled.revealStaggerHolds),
    revealStaggerHeldNodes: d(before.revealStaggerHeldNodes, settled.revealStaggerHeldNodes),
    revealStaggerBatches: d(before.revealStaggerBatches, settled.revealStaggerBatches),
    atlasWarmedRegions: d(before.atlasWarmedRegions, settled.atlasWarmedRegions),
    bakeBefore: before.bake,
    bakeAfter: settled.bake,
    before: {
      elements: before.elements,
      mirrorNodes: before.mirrorNodes,
      rootFound: before.rootFound,
      rootDisplay: before.rootDisplay,
      rootSubtreeElements: before.rootSubtreeElements
    },
    after: {
      elements: settled.elements,
      mirrorNodes: settled.mirrorNodes,
      rootFound: settled.rootFound,
      rootDisplay: settled.rootDisplay,
      rootSubtreeElements: settled.rootSubtreeElements
    },
    pageErrors: errors
  };
}

// ---------------------------------------------------------------------------------------------------------
// animation audit (--anim-audit) — post-settle, in-page. Answers "which running CSS animations exist, and what
// does each one's ANCESTOR CHAIN look like", because a transform/opacity animation that Chromium could otherwise
// run on the compositor is demoted by properties on an ANCESTOR (an SVG-reference `filter: url(#…)`, a blend
// mode, backdrop-filter, `contain`, `transform-style: preserve-3d`, …). Pure reads; runs after the measured
// window (and after the --idle window) so it never perturbs a number.
// ---------------------------------------------------------------------------------------------------------

function animAuditInPage() {
  const MAX_DEPTH = 40;
  const stage = document.querySelector(".mirror-stage");
  const trunc = (s, n = 200) => {
    const str = typeof s === "string" ? s : String(s ?? "");
    return str.length > n ? str.slice(0, n) + "…" : str;
  };
  const describe = (el) => {
    const data = {};
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith("data-")) data[attr.name] = trunc(attr.value, 160);
    }
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      class: trunc(typeof el.className === "string" ? el.className : String(el.className ?? ""), 200) || null,
      data,
      inlineStyle: trunc(el.getAttribute("style") ?? "", 400) || null
    };
  };
  // The properties that decide whether a transform/opacity animation can run on the compositor — read on the
  // element itself AND on every ancestor (an ancestor's filter/blend/containment demotes the whole subtree).
  const PROPS = [
    "filter", "backdropFilter", "mixBlendMode", "opacity", "willChange", "transformStyle", "contain",
    "isolation", "perspective", "clipPath", "maskImage", "overflow", "position", "zIndex", "display",
    "transform", "translate", "rotate", "scale", "animationName", "backfaceVisibility", "borderRadius"
  ];
  // Neutral (compositor-friendly) value per property; anything else is worth naming in `suspicious`.
  const NEUTRAL = {
    filter: "none", backdropFilter: "none", mixBlendMode: "normal", willChange: "auto",
    transformStyle: "flat", contain: "none", isolation: "auto", perspective: "none",
    clipPath: "none", maskImage: "none"
  };
  const styleOf = (el) => {
    const cs = getComputedStyle(el);
    const out = {};
    for (const p of PROPS) out[p] = trunc(cs[p] ?? "", 200);
    return out;
  };
  const suspicious = (s) => {
    const hits = [];
    for (const [key, neutral] of Object.entries(NEUTRAL)) {
      const v = s[key];
      if (v && v !== neutral) hits.push(`${key}: ${v}`);
    }
    const op = Number(s.opacity);
    if (Number.isFinite(op) && op < 1) hits.push(`opacity: ${s.opacity}`);
    return hits;
  };
  const chainOf = (el) => {
    const chain = [];
    let cur = el;
    let depth = 0;
    while (cur && depth < MAX_DEPTH) {
      const style = styleOf(cur);
      chain.push({ depth, self: depth === 0, ...describe(cur), style, suspicious: suspicious(style) });
      if (stage && cur === stage) break;
      cur = cur.parentElement;
      depth++;
    }
    return chain;
  };

  const animations = [];
  for (const anim of document.getAnimations()) {
    const effect = anim.effect;
    const target = effect && "target" in effect ? effect.target : null;
    if (!target || !(target instanceof Element)) continue;
    let keyframes = [];
    try { keyframes = effect.getKeyframes(); } catch { /* best effort */ }
    const props = new Set();
    for (const kf of keyframes) {
      for (const key of Object.keys(kf)) {
        if (!["offset", "computedOffset", "easing", "composite"].includes(key)) props.add(key);
      }
    }
    let timing = null;
    try { timing = effect.getComputedTiming(); } catch { /* best effort */ }
    const rect = target.getBoundingClientRect();
    animations.push({
      animationName: anim.animationName ?? anim.transitionProperty ?? null,
      animationId: anim.id || null,
      type: anim.constructor?.name ?? "Animation",
      playState: anim.playState,
      currentTimeMs: typeof anim.currentTime === "number" ? anim.currentTime : null,
      startTimeMs: typeof anim.startTime === "number" ? anim.startTime : null,
      durationMs: timing ? timing.duration : null,
      iterations: timing ? timing.iterations : null,
      animatedProperties: Array.from(props),
      keyframes: keyframes.map((kf) => {
        const copy = {};
        for (const [k, v] of Object.entries(kf)) copy[k] = typeof v === "string" ? trunc(v, 240) : v;
        return copy;
      }),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      element: describe(target),
      chain: chainOf(target)
    });
  }

  // Raw @keyframes text (NOT the resolved keyframes above): this is where a var()/calc() keyframe — which can
  // never be composited — is visible verbatim.
  const wanted = new Set(animations.map((a) => a.animationName).filter(Boolean));
  const cssKeyframes = {};
  for (const sheet of Array.from(document.styleSheets)) {
    let rules = null;
    try { rules = sheet.cssRules; } catch { continue; } // cross-origin sheet
    for (const rule of Array.from(rules ?? [])) {
      const isKeyframes = rule.constructor?.name === "CSSKeyframesRule" || rule.type === 7;
      if (isKeyframes && wanted.has(rule.name)) cssKeyframes[rule.name] = rule.cssText;
    }
  }
  const styleEl = document.getElementById("spirectl-presentation-animations");

  const byName = {};
  for (const a of animations) byName[a.animationName ?? "(unnamed)"] = (byName[a.animationName ?? "(unnamed)"] ?? 0) + 1;

  return {
    takenAt: new Date().toISOString(),
    // Captured AFTER the idle window: diffing tickWakeups against the walkStats the bench snapshots at the end
    // of the measured window says how many renderer-driven animation frames the idle window paid for (the JS
    // tick is what REQUESTS a main frame; a composited animation alone never does).
    walkStats: window.__mirrorWalkStats ? { ...window.__mirrorWalkStats } : null,
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    stageRect: stage ? (() => { const r = stage.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })() : null,
    counts: { animations: animations.length, byName },
    animations,
    cssKeyframes,
    presentationAnimationStyleCss: styleEl ? styleEl.textContent : null
  };
}

// Compositor-layer probe: which layers exist because of an ACTIVE animation (compositingReasons naming an
// animation — ActiveTransformAnimation / ActiveTranslateAnimation / ActiveOpacityAnimation / …), resolved back
// to the owning DOM element. This is the positive half of the evidence: a composited animation OWNS a layer for
// that reason; a demoted one does not. Runs after the measured + idle windows (LayerTree.enable itself nudges a
// compositor commit).
async function animationLayerProbe(cdp, page) {
  try {
    let latest = [];
    const onChange = (e) => { if (Array.isArray(e.layers)) latest = e.layers; };
    cdp.on("LayerTree.layerTreeDidChange", onChange);
    await cdp.send("DOM.enable").catch(() => {});
    await cdp.send("LayerTree.enable");
    await page.waitForTimeout(150);
    if (latest.length === 0) {
      await page.evaluate(() => {
        const d = document.createElement("div");
        d.style.cssText = "position:fixed;left:-9px;top:-9px;width:1px;height:1px;will-change:transform";
        document.body.appendChild(d);
        void d.offsetWidth;
        d.remove();
      });
      await page.waitForTimeout(200);
    }
    const out = [];
    const allReasons = {};
    for (const layer of latest) {
      let ids = [];
      try {
        const r = await cdp.send("LayerTree.compositingReasons", { layerId: layer.layerId });
        ids = r.compositingReasonIds ?? r.compositingReasons ?? [];
      } catch { /* per-layer best effort */ }
      for (const id of ids) allReasons[id] = (allReasons[id] ?? 0) + 1;
      const animReasons = ids.filter((r) => /animation/i.test(r));
      if (animReasons.length === 0) continue;
      let node = null;
      if (layer.backendNodeId) {
        try {
          const d = await cdp.send("DOM.describeNode", { backendNodeId: layer.backendNodeId });
          const attrs = {};
          const raw = d.node?.attributes ?? [];
          for (let i = 0; i + 1 < raw.length; i += 2) attrs[raw[i]] = raw[i + 1];
          node = { nodeName: d.node?.nodeName ?? null, attributes: attrs };
        } catch { /* best effort */ }
      }
      out.push({
        layerId: layer.layerId,
        backendNodeId: layer.backendNodeId ?? null,
        width: layer.width,
        height: layer.height,
        offsetX: layer.offsetX,
        offsetY: layer.offsetY,
        reasons: ids,
        animationReasons: animReasons,
        node
      });
    }
    if (typeof cdp.off === "function") cdp.off("LayerTree.layerTreeDidChange", onChange);
    await cdp.send("LayerTree.disable").catch(() => {});
    return { layerCount: latest.length, reasons: allReasons, animationLayers: out };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------------------------------------

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const round = (n, d = 2) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);
// Bytes -> mebibytes, passing null through. Memory in this harness is reported in MB everywhere it is reported
// at all; keeping the conversion in one place is what stops a byte number from being printed under an MB label.
const mb = (bytes) => (typeof bytes === "number" ? bytes / (1024 * 1024) : null);

// NEAREST-RANK percentile (index = ceil(p*n)-1): no interpolation, so every reported value is a value that was
// actually measured. Same definition as the C# side's PerfStats, so the two repos' reports are comparable.
function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(Math.max(Math.ceil(p * s.length) - 1, 0), s.length - 1)];
}
// Loop, not Math.max(...values): these arrays hold tens of thousands of trace samples and a spread that big
// blows the call stack (a 30s capture yields ~46k main-thread tasks alone).
function maxOf(values) {
  let m = null;
  for (const v of values) if (typeof v === "number" && (m === null || v > m)) m = v;
  return m;
}
function distribution(values, d = 2) {
  return {
    p50: round(percentile(values, 0.5), d),
    p95: round(percentile(values, 0.95), d),
    max: round(maxOf(values), d)
  };
}
// The {p50,p95,max} block whose members are each the MEDIAN of that member across repeats (the envelope's
// `metrics` block is "medians across repeats").
function medianDistribution(runs, path, d = 2) {
  const pick = (r, key) => path.split(".").reduce((o, k) => (o == null ? null : o[k]), r)?.[key];
  const at = (key) => median(runs.map((r) => pick(r, key)).filter((v) => typeof v === "number"));
  return { p50: round(at("p50"), d), p95: round(at("p95"), d), max: round(at("max"), d) };
}
// R7 W1-I1f. Rows from every repeat, deduped by (status, pathname) and summed — a route that 404s once per
// repeat is one row reading 3, not three rows reading 1. Sorted by count so the loudest failure is first.
function mergeResponseErrors(runs) {
  const merged = new Map();
  for (const r of runs) {
    for (const row of r?.responseErrors ?? []) {
      const key = `${row.status} ${row.pathname}`;
      const hit = merged.get(key);
      if (hit) hit.count += row.count;
      else merged.set(key, { ...row });
    }
  }
  return [...merged.values()].sort((a, b) => b.count - a.count);
}
function medianField(runs, path, d = 2) {
  const vals = runs.map((r) => path.split(".").reduce((o, k) => (o == null ? null : o[k]), r)).filter((v) => typeof v === "number");
  return vals.length ? round(median(vals), d) : null;
}

// ---------------------------------------------------------------------------------------------------------
// shared cross-repo perf envelope (--report): trace collection + metric derivation
// ---------------------------------------------------------------------------------------------------------
// The categories the CONTRACT metrics actually live in (measured on this box's Chrome, cross-checked with the
// godot-scene-web workstream):
//   disabled-by-default-devtools.timeline.frame  ActivateLayerTree (ph:"I") — the honest content frame rate.
//                                                DrawFrame/swap rate lives here too and is deliberately NOT
//                                                reported as fps: a swap can repeat the same picture.
//   disabled-by-default-cc.debug                 SoftwareImageDecodeCache::DecodeImageIfNecessary — where the
//                                                image-decode cost really shows up on a SwiftShader box (the
//                                                GPU-backed family is GpuImageDecodeCache::*; both matched).
//   cc / disabled-by-default-devtools.timeline   RasterTask, PaintImage (url attribution, CrRendererMain).
//   toplevel / devtools.timeline                 RunTask (per-task main-thread cost), TimeStamp (our markers).
// Only these two are ADDED to the bench's historical set (devtools.timeline, disabled-by-default-devtools.
// timeline, cc). `toplevel` and `benchmark` were tried and dropped on purpose: they contribute nothing the
// report reads (RunTask already rides disabled-by-default-devtools.timeline, PipelineReporter already rides
// the frame category) and together they roughly DOUBLE the event rate — which matters because the trace
// buffer is finite and the first symptom of overflow is a silently truncated tail.
const REPORT_EXTRA_CATEGORIES = ["disabled-by-default-devtools.timeline.frame", "disabled-by-default-cc.debug"];
// R7 W1-I1g — --trace-gpu. Quoted VERBATIM from analyze-gpu-trace.mjs's "Trace requirements" block (:30), which
// is the only consumer that needs them: `toplevel,cc,gpu,viz,benchmark,disabled-by-default-gpu.service,
// disabled-by-default-skia.gpu`. `cc` is already in the default set, so it is not repeated here.
const GPU_TRACE_CATEGORIES = [
  "toplevel",
  "gpu",
  "viz",
  "benchmark",
  "disabled-by-default-gpu.service",
  "disabled-by-default-skia.gpu"
];

const DECODE_NAME_RE = /(ImageDecode|Image Decode|Decode Image|DecodeImage|ImageDecodeCache|DecodeLazyPixelRef|Decode LazyPixelRef)/i;
const REPORT_MARK_START = "cc-report-start";
const REPORT_MARK_END = "cc-report-end";

// Keeps only the events the report needs, as `Tracing.dataCollected` batches arrive, so a 30s capture with
// cc.debug on costs a few MB of JS heap instead of the ~100MB the same trace occupies as a file.
//
// `keepCpuComplete` widens the keep-list to EVERY `ph:"X"` event that carries a numeric `tdur` — the set the
// cross-process `cpu` block (`computeCpuBlock`) needs to attribute CPU to the browser and GPU processes, not
// just the renderer. Zero-cost instants are still dropped, so the heap cost is bounded to tasks that actually
// spent CPU. `--report` runs turn this on; they also use a short `--limit-ms` so the window stays modest.
function createTraceCollector({ onKeep = null, keepCpuComplete = false } = {}) {
  const events = [];
  const threadNames = new Map(); // `${pid}:${tid}` -> name
  const processNames = new Map(); // pid -> name
  const onData = (payload) => {
    for (const e of payload.value ?? []) {
      if (e.ph === "M") {
        if (e.name === "thread_name") threadNames.set(`${e.pid}:${e.tid}`, e.args?.name ?? "");
        else if (e.name === "process_name") processNames.set(e.pid, e.args?.name ?? "");
        onKeep?.(e); // metadata keeps a filtered trace file openable
        continue;
      }
      const name = e.name;
      if (
        name === "RunTask" ||
        name === "ActivateLayerTree" ||
        name === "RasterTask" ||
        name === "PaintImage" ||
        name === "TimeStamp" ||
        name === "DrawFrame" ||
        name === "PipelineReporter" ||
        name === "CalculateRenderSurfaceLayerList" ||
        name.includes("Presentation") ||
        name.startsWith("RenderSurface") ||
        DECODE_NAME_RE.test(name) ||
        (keepCpuComplete && e.ph === "X" && typeof e.tdur === "number")
      ) {
        events.push(e);
        onKeep?.(e);
      }
    }
  };
  return { onData, events, threadNames, processNames };
}

// Derive the contract metrics from one repeat's collected events.
//   - the measured window is bracketed by our own TimeStamp markers, and the marker events identify the
//     renderer main thread EXACTLY (they were emitted from it), which is what makes per-thread attribution
//     honest on a page with several renderer processes' worth of threads in the trace.
//   - anything the trace does not actually carry is reported as null. Never a zero standing in for "unknown".
function computeTraceMetrics(collector, scope = ACTIVE_TRACE_WINDOW) {
  const { events, threadNames, processNames } = collector;
  const markerWindow = markerWindowOrError(events, scope);
  if (markerWindow.error) {
    // The overwhelmingly likely cause is trace-buffer overflow: Chrome stops recording when the buffer fills
    // and says nothing, so the run's TAIL simply is not in the trace — which, if it were silently accepted,
    // would read as "the page stopped updating". Fail the repeat's report instead.
    let first = null;
    let last = null;
    for (const e of events) {
      if (typeof e.ts !== "number") continue;
      if (first === null || e.ts < first) first = e.ts;
      if (last === null || e.ts > last) last = e.ts;
    }
    return {
      error:
        `${markerWindow.error} — almost certainly trace-buffer ` +
        `overflow: only ${round(((last ?? 0) - (first ?? 0)) / 1e6, 1)}s of events were recorded. Use a shorter recording ` +
        `for --report runs, or drop a category from REPORT_EXTRA_CATEGORIES.`
    };
  }

  const { start, end } = markerWindow;

  const pid = start.pid;
  const mainTid = start.tid;
  const t0 = start.ts;
  const t1 = end.ts;
  const windowMs = (t1 - t0) / 1000;
  const inWindow = (e) => e.pid === pid && e.ts >= t0 && e.ts <= t1;
  const us = (v) => v / 1000;

  // ---- main-thread task cost -------------------------------------------------------------------------
  const mainTasks = events.filter((e) => e.name === "RunTask" && e.tid === mainTid && inWindow(e) && e.dur > 0);
  const taskCostMs = mainTasks.map((e) => us(e.dur));
  const blockedMs = taskCostMs.reduce((s, d) => s + Math.max(0, d - 50), 0);
  const mainThreadBusyMs = taskCostMs.reduce((s, d) => s + d, 0);

  // tdur/dur over LONG main-thread tasks (>= 5 ms) separates COMPUTING from PARKED WAITING: a 500 ms
  // task with 20 ms of CPU is a stall (blocked on raster/decode/commit), not work. `null` when no
  // task qualified — never a placeholder number. Same rule as godot-scene-web `analyze.ts`; the
  // validator enforces `mainThreadCpuRatio === null <=> mainThreadCpuSamples === 0`.
  let mtLongCpuUs = 0;
  let mtLongWallUs = 0;
  let mainThreadCpuSamples = 0;
  for (const e of mainTasks) {
    if (
      e.dur >= 5000 &&
      typeof e.tdur === "number" &&
      Number.isFinite(e.tdur) &&
      e.tdur >= 0 &&
      e.tdur <= e.dur * 1.05 // drop the odd task whose ThreadTicks clock quantised above wall
    ) {
      mtLongCpuUs += e.tdur;
      mtLongWallUs += e.dur;
      mainThreadCpuSamples++;
    }
  }
  const mainThreadCpuRatio =
    mainThreadCpuSamples > 0 && mtLongWallUs > 0
      ? Math.min(1.5, round(mtLongCpuUs / mtLongWallUs, 4))
      : null;

  // ---- content update rate (ActivateLayerTree) -------------------------------------------------------
  const activations = events
    .filter((e) => e.name === "ActivateLayerTree" && inWindow(e))
    .map((e) => e.ts)
    .sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < activations.length; i++) gaps.push(us(activations[i] - activations[i - 1]));
  const activationSpanMs = activations.length >= 2 ? us(activations.at(-1) - activations[0]) : 0;
  const contentUpdateHz =
    activations.length >= 2 && activationSpanMs > 0 ? ((activations.length - 1) / activationSpanMs) * 1000 : null;

  // frameCostMs = main-thread cost PER CONTENT FRAME: the main-thread task time that fell between one
  // ActivateLayerTree and the next. The raw per-task distribution (`taskCostMs`) is kept alongside it, but it
  // is not the frame cost — its p50 is ~0.01ms because most main-thread tasks are trivial scheduler wakeups,
  // which would make a page that renders nothing look excellent.
  const frameCostMs = [];
  if (activations.length >= 2) {
    const sortedTasks = mainTasks.map((e) => ({ ts: e.ts, dur: e.dur })).sort((a, b) => a.ts - b.ts);
    let cursor = 0;
    for (let i = 1; i < activations.length; i++) {
      const from = activations[i - 1];
      const to = activations[i];
      let sum = 0;
      while (cursor < sortedTasks.length && sortedTasks[cursor].ts < from) cursor++;
      let scan = cursor;
      while (scan < sortedTasks.length && sortedTasks[scan].ts < to) {
        sum += us(sortedTasks[scan].dur);
        scan++;
      }
      frameCostMs.push(sum);
    }
  }

  // ---- raster + decode -------------------------------------------------------------------------------
  const rasterTasks = events.filter((e) => e.name === "RasterTask" && inWindow(e) && e.dur > 0);
  const rasterMs = rasterTasks.reduce((s, e) => s + us(e.dur), 0);
  // Per-thread raster intervals, so a decode can be attributed to "inside a raster task" (the decodes that
  // are ON the critical path of getting a tile drawn) versus a standalone decode task.
  const rasterByThread = new Map();
  for (const e of rasterTasks) {
    const key = e.tid;
    if (!rasterByThread.has(key)) rasterByThread.set(key, []);
    rasterByThread.get(key).push([e.ts, e.ts + e.dur]);
  }

  // The decode families NEST (DecodeImageIfNecessary wraps the decode task wraps `Decode Image`), so summing
  // everything that matches /decode/i triple-counts the same milliseconds. Pick ONE canonical family and name
  // it in the output: the cc image-decode CACHE entry point, which is where the cost shows up on this
  // software-raster box (`SoftwareImageDecodeCache::*`; a GPU-backed browser emits `GpuImageDecodeCache::*`).
  // Every other decode-ish event still rides `byName` for provenance.
  const CANONICAL_DECODE = [
    "SoftwareImageDecodeCache::DecodeImageIfNecessary",
    "GpuImageDecodeCache::DecodeImageIfNecessary",
    "ImageDecodeTask",
    "Decode Image"
  ];
  const allDecodeish = events.filter((e) => DECODE_NAME_RE.test(e.name) && inWindow(e));
  const decodeNames = {};
  for (const e of allDecodeish) {
    const entry = (decodeNames[e.name] ??= { count: 0, totalMs: 0 });
    entry.count++;
    if (e.dur > 0) entry.totalMs = round(entry.totalMs + us(e.dur), 1);
  }
  const decodeSource = CANONICAL_DECODE.find((n) => (decodeNames[n]?.count ?? 0) > 0) ?? null;
  // `decodes` = cache ENTRY POINTS. Overwhelmingly these are cache HITS: on a healthy combat replay this box
  // records ~6k of them totalling ~117ms — 0.019ms each, which is a map lookup, not a decode. They are still
  // worth reporting (they price the cache traffic), but every metric whose MEANING is "decode work" must be
  // computed over codec runs instead. That distinction is load-bearing for `inRasterCount`, see below.
  const decodes = decodeSource ? allDecodeish.filter((e) => e.name === decodeSource) : [];
  const decodeDurations = decodes.filter((e) => e.dur > 0).map((e) => us(e.dur));

  // The CODEC RUN: the innermost event that actually runs the image codec (`Decode Image`, nested several
  // levels inside the cache call). This is the real decode work — ~3ms each here, versus 0.019ms for a
  // lookup.  Fallback when a trace carries no codec events at all: cache entries that took >=1ms, which
  // cannot be bare hits. NEVER bare lookups (same rule as godot-scene-web's analyze.ts, so the two repos'
  // decode blocks mean the same thing).
  const CODEC_NAMES = ["Decode Image", "Decode LazyPixelRef", "SoftwareImageDecodeCacheUtils::DoDecodeImage - decode"];
  const codecName = CODEC_NAMES.find((n) => (decodeNames[n]?.count ?? 0) > 0) ?? null;
  const codecEvents = codecName ? allDecodeish.filter((e) => e.name === codecName) : [];
  const decodeWork = codecEvents.length > 0 ? codecEvents : decodes.filter((e) => (e.dur ?? 0) >= 1000);
  const codecSource = codecEvents.length > 0 ? codecName : decodeSource ? `${decodeSource} >=1ms` : null;
  const codecMs = decodeWork.reduce((s, e) => s + (e.dur > 0 ? us(e.dur) : 0), 0);

  // A codec run's own args carry only the image TYPE, so its identity comes from the cache call it is nested
  // inside (`args.key` — cc's per-size-variant cache key). Without an identity, redecode/distinct stay null.
  const cacheByThread = new Map();
  for (const e of decodes) {
    if (!(e.dur > 0)) continue;
    if (!cacheByThread.has(e.tid)) cacheByThread.set(e.tid, []);
    cacheByThread.get(e.tid).push(e);
  }
  for (const list of cacheByThread.values()) list.sort((a, b) => a.ts - b.ts);
  const ownKey = (e) =>
    e.args?.key ?? e.args?.pixelRefId ?? e.args?.data?.imageUrl ?? e.args?.data?.url ?? e.args?.imageUrl ?? e.args?.url ?? null;
  const enclosingKey = (e) => {
    const own = ownKey(e);
    if (own != null) return own;
    const list = cacheByThread.get(e.tid);
    if (!list) return null;
    // Innermost enclosing cache call (the list is small per thread; scan back from the last one that started
    // at or before this codec run).
    let best = null;
    for (const c of list) {
      if (c.ts > e.ts) break;
      if (c.ts + c.dur >= e.ts + (e.dur ?? 0)) best = c;
    }
    return best ? ownKey(best) : null;
  };

  const keyed = decodeWork.map((e) => ({ e, key: enclosingKey(e) })).filter((x) => x.key != null);
  // Contract fields must be finite. `0` here means "no repeated codec run of the same image was
  // observed" — a MEASURED zero, the healthy case — not "not measured" (which fails the repeat below
  // when the whole decode census came up empty).
  let distinctImages = 0;
  let redecodeCount = 0;
  let redecodeMs = 0;
  if (keyed.length > 0) {
    const seen = new Set();
    let re = 0;
    let reMs = 0;
    for (const { e, key } of keyed) {
      if (seen.has(key)) {
        // A REDECODE is a repeated codec RUN — the same image paid for twice. A repeated cache lookup is just
        // the cache doing its job and is not counted here.
        re++;
        reMs += e.dur > 0 ? us(e.dur) : 0;
      } else {
        seen.add(key);
      }
    }
    distinctImages = seen.size;
    redecodeCount = re;
    redecodeMs = round(reMs, 2);
  }

  // IN-RASTER: a codec run INSIDE a raster task — an image too big for the discardable decode cache, whose
  // decode is therefore re-paid on every raster, forever. That is a hard failure, not a slow number, so it is
  // computed over codec runs only: counting cache lookups here (4438 of them, 2.7ms total, all hits) would
  // fire the alarm on every healthy run and teach everyone to ignore it.
  const inRaster = decodeWork.filter((e) => {
    const spans = rasterByThread.get(e.tid);
    return spans ? spans.some(([a, b]) => e.ts >= a && e.ts <= b) : false;
  });
  const inRasterCount = inRaster.length;
  const inRasterMs = round(inRaster.reduce((s, e) => s + (e.dur > 0 ? us(e.dur) : 0), 0), 2);

  // PaintImage (CrRendererMain) is the only url-bearing paint record: how many DISTINCT images the page
  // actually painted in the window. It is reported next to the decode block as provenance — with --res-root
  // missing this collapses to a handful and every decode number below it is meaningless.
  const paints = events.filter((e) => e.name === "PaintImage" && inWindow(e));
  const paintUrls = new Set(paints.map((e) => e.args?.data?.url).filter(Boolean));
  // "small element, large source image" — the cause class the contract's `paint` block prices.
  let maxSourceMegapixels = 0;
  let maxSourceToPaintedRatio = 0;
  for (const e of paints) {
    const d = e.args?.data ?? {};
    const src = (d.srcWidth ?? 0) * (d.srcHeight ?? 0);
    const painted = (d.width ?? 0) * (d.height ?? 0);
    maxSourceMegapixels = Math.max(maxSourceMegapixels, src / 1e6);
    if (src > 0 && painted > 0) maxSourceToPaintedRatio = Math.max(maxSourceToPaintedRatio, src / painted);
  }

  // Which cc image-decode cache family is this Chrome using? Recorded so a zero decode reading can never be
  // mistaken for "this device does no decoding" (same rule as godot-scene-web `analyze.ts`).
  const decodeFamilies = new Set();
  for (const name of Object.keys(decodeNames)) {
    const m = /(Software|Gpu)ImageDecodeCache/.exec(name);
    if (m) decodeFamilies.add(m[1].toLowerCase());
  }
  const cacheFamily =
    decodeFamilies.size === 0 ? "unknown" : decodeFamilies.size > 1 ? "mixed" : [...decodeFamilies][0];
  const imageKey = decodes.some((e) => typeof e.args?.key === "string")
    ? "contentId"
    : decodes.some((e) => e.args?.pixelRefId != null) || decodeWork.some((e) => e.args?.pixelRefId != null)
      ? "pixelRefId"
      : keyed.length > 0
        ? "url"
        : null;

  // ---- cross-process CPU (contract `cpu` block) ------------------------------------------------------
  const cpu = computeCpuBlock(events, {
    startTs: t0,
    endTs: t1,
    windowMs,
    threadNames,
    processNames,
  });

  // ---- swaps + presented frames ----------------------------------------------------------------------
  // Deliberately SEPARATE from contentUpdateHz: a swap can present the very same picture again, so the swap
  // rate flatters a page that is drawing nothing new. It is reported as `swapRateHz`, never as fps.
  // DEDUPED by timestamp: DrawFrame is emitted twice per swap (the renderer compositor and the viz thread, at
  // the same ts). The pid filter already drops the viz copy on this box (it lives in the GPU process — 807
  // events, 807 distinct ts, one tid), but a capture that includes both processes would otherwise report
  // double the swap rate.
  const swaps = [
    ...new Set(events.filter((e) => e.name === "DrawFrame" && inWindow(e)).map((e) => e.ts))
  ].sort((a, b) => a - b);
  const swapSpanMs = swaps.length >= 2 ? us(swaps.at(-1) - swaps[0]) : 0;
  const swapRateHz = swaps.length >= 2 && swapSpanMs > 0 ? ((swaps.length - 1) / swapSpanMs) * 1000 : null;

  // A presented frame is one that made it all the way through the compositor pipeline to the screen. The
  // substage event is the precise record; PipelineReporter begins are the fallback when the substage category
  // is not in the capture. Whichever answered is named in `presentedSource` so the number is traceable.
  const presentationSubstage = events.filter(
    (e) => e.name === "SubmitCompositorFrameToPresentationCompositorFrame" && inWindow(e) && e.ph !== "e"
  ).length;
  const pipelineBegins = events.filter((e) => e.name === "PipelineReporter" && inWindow(e) && e.ph === "b").length;
  const presented = presentationSubstage > 0 ? presentationSubstage : pipelineBegins > 0 ? pipelineBegins : null;
  const presentedSource =
    presentationSubstage > 0
      ? "SubmitCompositorFrameToPresentationCompositorFrame"
      : pipelineBegins > 0
        ? "PipelineReporter(begin)"
        : null;

  // ---- render surfaces -------------------------------------------------------------------------------
  // cc's `RenderSurfaceReasonCount` instants carry a `{reason: count}` map (same shape godot-scene-web
  // `analyze.ts` reads): max-fold each reason across the page's renderer, then `renderSurfaces` is the SUM —
  // the number of separate compositor surfaces a blend/filter/opacity mistake in the scene inflates.
  // `CalculateRenderSurfaceLayerList` is the always-on cc event emitted every time the draw-property /
  // render-surface list is rebuilt; `renderSurfaceListPasses` counts them so a genuine `renderSurfaces: 0`
  // (a settled scene with no surface reasons — the mirror's normal case) is distinguishable from "the census
  // never ran". Zero passes in the whole trace => the field is UNMEASURED and the repeat fails.
  const surfaceReasons = {};
  let renderSurfaceListPasses = 0;
  for (const e of events) {
    if (e.pid !== pid) continue;
    if (e.name === "CalculateRenderSurfaceLayerList") {
      renderSurfaceListPasses++;
      continue;
    }
    if (e.name !== "RenderSurfaceReasonCount") continue;
    for (const src of [e.args, e.args?.data]) {
      if (!src || typeof src !== "object") continue;
      for (const [reason, count] of Object.entries(src)) {
        if (typeof count === "number" && Number.isFinite(count)) {
          surfaceReasons[reason] = Math.max(surfaceReasons[reason] ?? 0, count);
        }
      }
    }
  }
  const renderSurfaces = Object.values(surfaceReasons).reduce((sum, v) => sum + v, 0);
  const renderSurfacesScope = renderSurfaceListPasses > 0 ? "trace" : null;

  // A required observation that could not be MADE fails the repeat — it is never serialised as a
  // misleading zero. (`swapRateHz` is exempt: it is a "contrast only" number the contract lets be a
  // measured 0, and `swapCount` carries the real signal.)
  if (contentUpdateHz === null) {
    return { error: `only ${activations.length} ActivateLayerTree events in the window — the compositor was handed no new content; the replay measured a stalled page` };
  }
  if (renderSurfaceListPasses === 0) {
    return { error: "no CalculateRenderSurfaceLayerList events — the cc render-surface census never ran, so `renderSurfaces` is UNMEASURED (add the `cc` trace category)" };
  }
  if (decodes.length === 0) {
    return { error: `no ${CANONICAL_DECODE.join("/")} events matched (cacheFamily=${cacheFamily}) — image decode is UNMEASURED, not fast; re-check the decode-cache event names for this Chrome` };
  }
  if (cpu.byThread.length === 0) {
    return { error: "no RunTask/tdur events in the window across any process — the cross-process `cpu` block could not be built" };
  }

  return {
    windowMs: round(windowMs, 1),
    mainThread: threadNames.get(`${pid}:${mainTid}`) ?? null,
    frameCostMs: distribution(frameCostMs, 2),
    taskCostMs: distribution(taskCostMs, 2),
    mainThreadTasks: taskCostMs.length,
    blockedMs: round(blockedMs, 1),
    mainThreadBusyMs: round(mainThreadBusyMs, 1),
    mainThreadCpuRatio,
    mainThreadCpuSamples,
    contentUpdateHz: round(contentUpdateHz, 2),
    activationCount: activations.length,
    activationGapMs: {
      ...distribution(gaps, 2),
      over100msCount: gaps.filter((g) => g > 100).length,
      count: gaps.length,
    },
    swapRateHz: round(swapRateHz ?? 0, 2),
    swapCount: swaps.length,
    // The compositor-frames-that-reached-presentation count. This USED to be (mis)named `presented`;
    // the contract's `presented` is the screenshot presence guard, added in `runOnce`.
    presentedFrames: presented,
    presentedFramesSource: presentedSource,
    rasterMs: round(rasterMs, 1),
    rasterTasks: rasterTasks.length,
    decode: {
      // Cache ENTRY POINTS (mostly hits — see the comment above): the cache traffic, not decode work.
      source: decodeSource,
      count: decodes.length,
      totalMs: round(decodeDurations.reduce((s, d) => s + d, 0), 1),
      maxMs: round(maxOf(decodeDurations) ?? 0, 2),
      // Actual CODEC RUNS: the real decode work every "decode" metric below is computed over.
      codecSource,
      codecRuns: decodeWork.length,
      codecMs: round(codecMs, 1),
      codecMaxMs: round(maxOf(decodeWork.filter((e) => e.dur > 0).map((e) => us(e.dur))) ?? 0, 2),
      distinctImages,
      redecodeCount,
      redecodeMs,
      inRasterCount,
      inRasterMs,
      imageKey,
      cacheFamily,
      imagesExpected: true,
      byName: decodeNames
    },
    paint: {
      count: paints.length,
      distinctUrls: paintUrls.size,
      maxSourceMegapixels: round(maxSourceMegapixels, 3),
      maxSourceToPaintedRatio: round(maxSourceToPaintedRatio, 2),
    },
    renderSurfaces,
    renderSurfaceReasons: surfaceReasons,
    renderSurfaceListPasses,
    renderSurfacesScope,
    cpu
  };
}

// ---------------------------------------------------------------------------------------------------------
// walk-counter snapshots (--window)
// ---------------------------------------------------------------------------------------------------------
// `window.__mirrorWalkStats` is a LIVE object the renderer mutates in place (its identity is observable, so it
// is never reallocated). Snapshotting therefore means copying it out, and the shape is "numbers, plus one level
// of nested number maps" (fullWalkCauses).
function cloneWalkStatsInPage() {
  const ws = window.__mirrorWalkStats;
  if (!ws) return null;
  try {
    return JSON.parse(JSON.stringify(ws));
  } catch {
    return null;
  }
}

// after - before, numeric fields only, one level of nesting. Non-numeric fields are carried through from the
// closing snapshot unchanged (a mode string is not a rate), and a field that only exists on one side is skipped
// rather than guessed — the counter set differs across builds, which is exactly the case D4 adds fields in.
function diffWalkStats(before, after) {
  if (!after) return null;
  if (!before) return after;
  const out = {};
  for (const [k, v] of Object.entries(after)) {
    const prev = before[k];
    if (typeof v === "number" && typeof prev === "number") out[k] = round(v - prev, 3);
    else if (v && typeof v === "object" && !Array.isArray(v)) out[k] = diffWalkStats(prev ?? {}, v);
    else if (typeof v !== "number") out[k] = v;
  }
  return out;
}

// --churn-census across repeats. The TOTALS are medians (harness convention), but the PEAK is a MAX: a pool is
// judged on the worst reconcile a user can hit, and a median peak would quietly discard the repeat that actually
// janked. The top-10 table comes from the repeat that owns that max — evidence from one repeat, exactly like
// --layers / --dom-styles — so the table and the headline peak always describe the same run.
function summarizeChurn(runs) {
  const per = runs.map((r) => r.churnCensus).filter(Boolean);
  if (per.length === 0) return null;
  const med = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const worst = per.reduce((a, b) => ((b.peak?.createEl ?? -1) > (a.peak?.createEl ?? -1) ? b : a), per[0]);
  return {
    repeats: per.length,
    medians: {
      createEl: med(per.map((p) => p.totals.createEl)),
      betweenCreateEl: med(per.map((p) => p.totals.betweenCreateEl)),
      adoptions: med(per.map((p) => p.totals.adoptions)),
      condemnedSwept: med(per.map((p) => p.totals.condemnedSwept)),
      removedRecords: med(per.map((p) => p.totals.removedRecords)),
      walks: med(per.map((p) => p.totals.walks)),
      walkMs: round(med(per.map((p) => p.totals.walkMs)), 1)
    },
    peak: worst.peak,
    peakPerRepeat: per.map((p) => p.peak?.createEl ?? null),
    top: worst.top,
    firstBuild: worst.firstBuild,
    perRepeatTotals: per.map((p) => p.totals),
    overflow: per.reduce((s, p) => s + (p.overflow ?? 0), 0),
    sampledWalks: worst.sampledWalks
  };
}

// Start/stop tracing at the measurement markers, rather than around navigation. A cc.debug buffer is finite and
// Chrome silently drops its tail on overflow; a long replay followed by --idle otherwise creates a convincing
// looking trace that contains neither idle end nor the window it claims to measure.
function createMarkerScopedTrace(cdp, opts) {
  const scope = traceWindowForOptions(opts);
  let started = false;
  let tracePath = null;
  let collector = null;
  let rawTraceStream = null;
  let rawTraceCount = 0;
  let dataListener = null;

  const detachDataListener = () => {
    if (dataListener) cdp.off?.("Tracing.dataCollected", dataListener);
    dataListener = null;
  };
  const closeRawTrace = async () => {
    if (!rawTraceStream) return;
    rawTraceStream.write("\n]\n");
    await new Promise((res) => rawTraceStream.end(res));
    rawTraceStream = null;
  };

  const start = async () => {
    if (!scope || !cdp) return;
    if (started) throw new Error(`trace ${scope.phase} capture started twice`);
    const categories = ["devtools.timeline", "disabled-by-default-devtools.timeline", "cc"];
    if (scope.phase === "idle" || opts.animAudit) categories.push("blink.animations", "blink.user_timing");
    if (opts.traceGpu) categories.push(...GPU_TRACE_CATEGORIES);
    if (opts.report) categories.push(...REPORT_EXTRA_CATEGORIES);

    if (opts.report) {
      if (opts.trace) {
        const traceDir = resolve(REPO_ROOT, ".sts2/bench/traces");
        mkdirSync(traceDir, { recursive: true });
        tracePath = resolve(traceDir, opts.trace);
        rawTraceStream = createWriteStream(tracePath);
        rawTraceStream.write("[\n");
      }
      const writeEvent = (event) => {
        if (rawTraceStream) rawTraceStream.write((rawTraceCount++ ? ",\n" : "") + JSON.stringify(event));
      };
      collector = createTraceCollector({
        onKeep: opts.traceRawFull ? null : writeEvent,
        keepCpuComplete: true,
      });
      dataListener = (payload) => {
        if (opts.traceRawFull) for (const event of payload.value ?? []) writeEvent(event);
        collector.onData(payload);
      };
      cdp.on("Tracing.dataCollected", dataListener);
    }

    try {
      await cdp.send(
        "Tracing.start",
        opts.report
          ? { traceConfig: { recordMode: "recordAsMuchAsPossible", includedCategories: categories }, transferMode: "ReportEvents" }
          : { categories: categories.join(","), transferMode: "ReturnAsStream" }
      );
      started = true;
    } catch (error) {
      detachDataListener();
      await closeRawTrace();
      throw error;
    }
  };

  const stop = async () => {
    if (!started) return { tracePath: null, traceMetrics: null };
    const done = new Promise((res) => cdp.once("Tracing.tracingComplete", res));
    let complete;
    try {
      await cdp.send("Tracing.end");
      complete = await done;
    } catch (error) {
      detachDataListener();
      await closeRawTrace();
      started = false;
      throw error;
    }
    detachDataListener();
    let traceMetrics = null;
    let markerError = null;
    if (collector) {
      traceMetrics = computeTraceMetrics(collector, scope);
      if (traceMetrics.error) markerError = traceMetrics.error;
      if (rawTraceStream) {
        await closeRawTrace();
        console.error(`  trace -> ${tracePath} (${rawTraceCount} events; ${scope.startMarker} → ${scope.endMarker})`);
      }
    }
    if (complete?.stream) {
      const chunks = [];
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const read = await cdp.send("IO.read", { handle: complete.stream });
        chunks.push(read.data);
        if (read.eof) break;
      }
      await cdp.send("IO.close", { handle: complete.stream });
      const traceDir = resolve(REPO_ROOT, ".sts2/bench/traces");
      mkdirSync(traceDir, { recursive: true });
      tracePath = resolve(traceDir, opts.trace);
      const raw = chunks.join("");
      writeFileSync(tracePath, raw);
      try {
        const parsed = JSON.parse(raw);
        const events = Array.isArray(parsed) ? parsed : parsed.traceEvents;
        markerError = markerWindowOrError(events, scope).error ?? null;
      } catch {
        markerError = `trace ${scope.phase} artifact is not valid JSON`;
      }
    }
    started = false;
    if (markerError) {
      console.error(`  report trace: ${markerError}`);
      throw new Error(markerError);
    }
    return { tracePath, traceMetrics };
  };

  return { scope, start, stop, get started() { return started; } };
}

// ---------------------------------------------------------------------------------------------------------
// one measured run
// ---------------------------------------------------------------------------------------------------------

async function runOnce(context, pageUrl, opts) {
  // --connect-cdp: drive the browser's EXISTING active tab (opts.connectPage) instead of opening one, and blank
  // it first — a real navigation is the only thing that re-reads the renderer's module-load lever consts, and
  // going straight from one bench URL to the same bench URL is not guaranteed to be one.
  const page = opts.connectPage ?? (await context.newPage());
  if (opts.connectPage) {
    await page.goto("about:blank", { waitUntil: "domcontentloaded" });
  }

  // PAGE ERRORS. Until now an uncaught exception during the measured replay was invisible: the run either hung on
  // the readiness gate or reported degraded numbers with nothing saying why. That is fine for a perf A/B between
  // two known-good builds and useless as a correctness gate — which is exactly what a new RENDERER BACKEND needs
  // (a backend can paint a plausible-looking frame and still be throwing once per delta). Collected here, capped
  // so a per-frame thrower cannot fill memory, and reported in `delta.pageErrors` for the caller to gate on.
  const pageErrors = [];
  const PAGE_ERROR_CAP = 50;
  const notePageError = (text) => {
    if (pageErrors.length < PAGE_ERROR_CAP) pageErrors.push(String(text));
  };
  // R6 P6-F5 — PAGE WARNINGS from gsw's own runtime, which `pageErrors` cannot see: a shader that fails to
  // COMPILE is reported by gsw as a console.warn carrying the driver's info log, and this collector only ever
  // captured console.error. So the one line that names WHY a shader was refused was invisible to every bench run
  // that has ever been used to chase one. Same cap, and prefix-filtered to gsw's own tag so a page's ordinary
  // warning traffic does not drown it.
  const pageWarnings = [];
  const notePageWarning = (text) => {
    if (pageWarnings.length < PAGE_ERROR_CAP) pageWarnings.push(String(text));
  };
  page.on("pageerror", (error) => notePageError(error?.stack ?? error?.message ?? error));
  page.on("console", (message) => {
    if (message.type() === "error") notePageError(`console.error: ${message.text()}`);
    else if (message.type() === "warning" && message.text().startsWith("[gsw")) notePageWarning(message.text());
  });
  // R7 W1-I1b — RENDERER DEATH as a reported field instead of an exception that ends the matrix. Round 6's phone
  // matrix lost 14 of 16 combat cells this way: the first cell whose renderer died threw "Target crashed" out of
  // some post-settle `evaluate`, the rejection escaped the repeat loop, and every cell that had not run yet never
  // ran. A death is the most interesting result a stability bench can produce, so it is recorded and the run
  // finishes. Note the crash may be caused from OUTSIDE this renderer: killing the GPU process takes every
  // renderer's context with it, which is precisely round 7's mechanism.
  let pageCrashed = false;
  let pageCrashAt = null;
  page.on("crash", () => {
    pageCrashed = true;
    if (pageCrashAt === null) pageCrashAt = round(performance.now(), 0);
    notePageError("page crashed (renderer gone — see pageCrashed)");
  });
  // Every post-settle read goes through this instead of `page.evaluate` directly: on a page that is already gone
  // the answer is "unknown", which is null, not a thrown matrix-ending rejection. A throw from a LIVE page still
  // propagates — a broken probe must stay loud.
  const pageGone = () => pageCrashed || page.isClosed();
  const probePage = async (fn, arg) => {
    if (pageGone()) return null;
    try {
      return arg === undefined ? await page.evaluate(fn) : await page.evaluate(fn, arg);
    } catch (e) {
      if (pageGone() || /Target crashed|Target closed|has been closed/i.test(String(e?.message ?? e))) return null;
      throw e;
    }
  };
  // R7 W1-I1f — FAILED REQUESTS, which no bench run has ever reported. The phone logs carried 16 `/bg/` 404s per
  // cell and nobody could see them from a bench line; a fail-open latch that flips on a 404 is invisible until
  // the 404 itself is a number. Deduped by (status, pathname) with a count so a per-frame failure is one row,
  // and capped like the error collectors beside it. Query strings are dropped: cache-busting params would turn
  // one repeated failure into 500 distinct rows.
  const responseErrors = new Map();
  page.on("response", (response) => {
    const status = response.status();
    if (status < 400) return;
    let pathname = response.url();
    try {
      pathname = new URL(pathname).pathname;
    } catch { /* non-URL scheme — keep it whole */ }
    const key = `${status} ${pathname}`;
    const hit = responseErrors.get(key);
    if (hit) hit.count++;
    else if (responseErrors.size < PAGE_ERROR_CAP) responseErrors.set(key, { status, pathname, count: 1 });
  });
  // A remote/attached browser may refuse a raw CDP session or the Performance domain (Android's WebView shells
  // differ, and Chrome 151's per-tab CDP is broken — see the phone recipe). That is a DEGRADATION, not a failure:
  // frameGaps, walkStats and the long tasks are all page-side. The launched path is unchanged — anything that
  // throws there still throws.
  let cdp = null;
  try {
    cdp = await context.newCDPSession(page);
  } catch (e) {
    if (!opts.connect) throw e;
    console.error(`  connect: no CDP session for this page (${e}); busy%/Task/Script/Layout will be null`);
  }
  let metricsOk = false;
  if (cdp) {
    try {
      await cdp.send("Performance.enable");
      metricsOk = true;
    } catch (e) {
      if (!opts.connect) throw e;
      console.error(`  connect: Performance.enable failed (${e}); busy%/Task/Script/Layout will be null`);
    }
  }
  if (CPU_THROTTLE > 1 && !opts.connect) {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
  }

  // R7 W1-I1a — the same CDP round trip already carried five more numbers and threw them away. Four of them are
  // the RENDERER-side memory gauges (`JSHeapUsedSize`/`JSHeapTotalSize`/`Nodes`/`Documents`/`JSEventListeners`),
  // which is the currency round 7 needs: a cell that dies wants "was the heap climbing" answered from the run
  // that died, not from a re-run that might not die. Both early returns keep the SAME SHAPE as the success path
  // so callers can subtract fields without null-checking each one into existence.
  const NO_METRICS = {
    task: null,
    script: null,
    layout: null,
    recalcStyle: null,
    jsHeapUsed: null,
    jsHeapTotal: null,
    blinkNodes: null,
    documents: null,
    listeners: null
  };
  const getMetrics = async () => {
    if (!metricsOk) return { ...NO_METRICS };
    try {
      const { metrics } = await cdp.send("Performance.getMetrics");
      const get = (name) => metrics.find((m) => m.name === name)?.value ?? null;
      return {
        task: get("TaskDuration"),
        script: get("ScriptDuration"),
        layout: get("LayoutDuration"),
        recalcStyle: get("RecalcStyleDuration"),
        // Bytes. `Used` is what the collector would keep, `Total` what V8 has actually taken from the OS — the
        // second is the one that shows up in a process's RSS, so a report that quotes only `Used` understates
        // the renderer by whatever the heap is holding in reserve.
        jsHeapUsed: get("JSHeapUsedSize"),
        jsHeapTotal: get("JSHeapTotalSize"),
        // Blink's own DOM-node count for the whole renderer. NOT `nodesA`/`nodesB` beside it, which count
        // `.mirror-node` elements: different probe, different denominator, and conflating them would silently
        // re-scope every historical node number in the doc.
        blinkNodes: get("Nodes"),
        documents: get("Documents"),
        listeners: get("JSEventListeners")
      };
    } catch (e) {
      if (!opts.connect) throw e;
      metricsOk = false;
      console.error(`  connect: Performance.getMetrics failed (${e}); the Blink durations are null for this run`);
      return { ...NO_METRICS };
    }
  };

  const markerTrace = createMarkerScopedTrace(cdp, opts);
  let tracePath = null;
  let traceMetrics = null;

  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });

  // Connect mode only: PROVE the init scripts landed on this navigation before waiting two minutes for a mirror
  // tree that a page without the fake socket can never build. `__benchTicks` is installed by tickSamplerInit,
  // which runs on every document — its absence means addInitScript did not reach this target (a different
  // context, a page created outside it, an attach that lost the tab), and that is a hard error, not a slow run.
  if (opts.connect) {
    const applied = await page.evaluate(() => Array.isArray(window.__benchTicks));
    if (!applied) {
      throw new Error(
        `connect: init scripts did not apply to ${page.url()} — window.__benchTicks is missing. ` +
          "The attached tab is not the one this bench prepared (is the bench page the ACTIVE tab, and is it the " +
          "browser's first context?)."
      );
    }
  }

  // Wait for the keyframe to render. TWO backends can satisfy that now and they leave completely different
  // evidence behind: the DOM backend stamps `.mirror-node` per scene node (the original gate, untouched), while
  // the single-canvas backend (`?stage=canvas`) builds ONE canvas and would sit here for the full 120 s no matter
  // how well it was rendering. Its equivalent is its own painted-frame counter — a frame that really reached
  // `execute` carrying a scene's worth of quads — so the gate is the OR of the two.
  await page.waitForFunction(
    () => {
      if (document.querySelectorAll(".mirror-node").length > 50) {
        return true;
      }
      const readCanvasStats = window.__mirrorCanvasStats;
      if (typeof readCanvasStats !== "function") {
        return false;
      }
      const stats = readCanvasStats();
      return stats.frames > 0 && stats.quads > 50;
    },
    null,
    { timeout: 120_000 }
  );

  // initialRenderMs: navigation start -> the first rendered mirror tree (>50 .mirror-node elements). Read from
  // the PAGE's clock (performance.now() is ms since its time origin), so no harness/IPC latency rides on it.
  const initialRenderMs = opts.report ? await page.evaluate(() => performance.now()) : null;

  // --window: hold everything below until the recorded stream reaches the window's START. The fake socket
  // publishes the crossing (see _pumpRecorded); polling it costs one rAF-paced predicate on the page, and the
  // few ms of poll latency ride on BOTH ends of the bracket, so they cancel out of a before/after comparison.
  if (opts.window) {
    await page.waitForFunction(() => (window.__benchWindowMark ?? 0) >= 1, null, { timeout: 180_000 });
  }

  // The active trace starts immediately before the renderer-main opening marker, after all readiness work.
  // Its CDP setup latency is deliberately outside the historical wall/Performance.getMetrics bracket below.
  // An idle run deliberately does not start here: its trace is reserved for the later quiet interval.
  if (markerTrace.scope?.phase === "active") await markerTrace.start();
  const wallA = performance.now();
  const a = await getMetrics();
  const nodesA = await page.evaluate(beginActiveMarkerWindowInPage, {
    marker: markerTrace.scope?.phase === "active" ? REPORT_MARK_START : null
  });
  // Walk counters are CUMULATIVE since page load and `walkStats` below is read post-settle, so a windowed run
  // needs both ends to state what the window itself cost (C2 reads fullWalkCauses.bail over the shuffle).
  const walkStatsAtOpen = opts.window ? await page.evaluate(cloneWalkStatsInPage) : null;
  // Open the churn census's bracket at the same instant. Everything before this point is page load — above all
  // the keyframe build, which the readiness gate above has just waited for.
  if (opts.churnCensus) {
    await page.evaluate(() => window.__benchChurnCensus?.mark(1));
  }

  // Optional hover sweep: ~60Hz mousemoves across the stage while the stream replays.
  let sweepStop = false;
  let sweepCount = 0;
  const sweep = (async () => {
    if (!opts.hoverSweep || !cdp) return;
    const rect = await page.evaluate(() => {
      const s = document.querySelector(".mirror-stage");
      if (!s) return null;
      const r = s.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    if (!rect || rect.w <= 0) return;
    let k = 0;
    while (!sweepStop) {
      // A smooth lissajous path across the stage.
      const px = rect.x + rect.w * (0.5 + 0.45 * Math.sin(k * 0.11));
      const py = rect.y + rect.h * (0.5 + 0.4 * Math.sin(k * 0.07 + 1));
      try {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py });
        sweepCount++;
      } catch { /* page closing */ }
      k++;
      await new Promise((r) => setTimeout(r, 16));
    }
  })();

  // Wait until the fake WS finished delivering the stream, then settle — or, under --window, until the stream
  // crosses the window's END (`__benchDone` is still accepted there, so a window that outlives the recording
  // closes instead of hanging). The stream keeps running past a window's close; it is drained further down,
  // before the post-settle probes, so those still describe the settled scene.
  try {
    await page.waitForFunction(
      (windowed) => (windowed ? (window.__benchWindowMark ?? 0) >= 2 : false) || window.__benchDone === true,
      !!opts.window,
      { timeout: 180_000 }
    );
  } catch {
    const err = await probePage(() => window.__benchWsError ?? null);
    console.error(`  stream did not finish (fake WS error: ${err ?? "none"})`);
  }
  // The settle tail belongs to a whole-stream run: it is how "the recording is finished AND quiet" is defined.
  // A window closes on its own bound — adding 500ms of tail would measure 500ms that is not in the window.
  if (!opts.window) await page.waitForTimeout(500);
  sweepStop = true;
  await sweep;

  const wallB = performance.now();
  const b = await getMetrics();
  // readyMs: navigation start -> the whole recorded stream delivered AND settled (the same instant the
  // measured window closes). Page clock again, and the closing trace marker rides the same evaluate.
  const readyAtMarker = (opts.report || markerTrace.scope?.phase === "active")
    ? await probePage(endActiveMarkerWindowInPage, {
        marker: markerTrace.scope?.phase === "active" ? REPORT_MARK_END : null
      })
    : null;
  const readyMs = opts.report ? readyAtMarker : null;
  if (markerTrace.scope?.phase === "active") {
    const completed = await markerTrace.stop();
    tracePath = completed.tracePath;
    traceMetrics = completed.traceMetrics;
  }
  // Close the churn bracket BEFORE the reads below: every evaluate from here on is harness traffic, and a walk
  // one of them provokes is not part of what the recording cost.
  const churnCensus = opts.churnCensus
    ? await probePage(() => {
        window.__benchChurnCensus?.mark(2);
        return window.__benchChurnCensus?.read() ?? null;
      })
    : null;
  const walkStats = await probePage(() => window.__mirrorWalkStats ?? null);
  // The hand-card parity gauge, read at the same point as walkStats (after the replay has fully settled, so every
  // tween the recording contains has expired and reported). Structured-cloned out whole; the renderer already caps
  // the entry list and counts what it dropped, so this can't balloon.
  const handParity = opts.handParity
    ? await probePage(() => {
        const g = window.__mirrorHandParity;
        return g ? { ...g, entries: g.entries.slice() } : null;
      })
    : null;
  const nodesB = await probePage(() => document.querySelectorAll(".mirror-node").length);
  // --flight-liveness: read the sampler at the same point as walkStats. Its per-element state is scoped to each
  // card's own travel (see flightLivenessInit), so reading it here — with the window closed but the page still
  // holding whatever it holds — cannot pick up post-landing stillness.
  const flightLiveness = opts.flightLiveness
    ? await probePage(() => (typeof window.__benchFlightLivenessRead === "function" ? window.__benchFlightLivenessRead() : null))
    : null;
  const droppedCardFlights = (await probePage(() => window.__benchDroppedCardFlights ?? 0)) ?? 0;
  const longTasks = summarizeLongTasks(await probePage(() => window.__benchLongTasks ?? null));
  const loafCount = opts.report ? await probePage(() => (window.__benchLoaf ?? []).length) : null;
  // Both instruments were zeroed at the window's open, so this read is window-scoped in exactly the same way
  // the long-task summary above is.
  const tickMs = summarizeTicks(await probePage(() => window.__benchTicks ?? null));
  // FRAME cadence over the same bracket (see summarizeFrameGaps): the metric that survives --connect-cdp, where
  // the Blink durations above may be null.
  const frameGaps = summarizeFrameGaps(await probePage(() => window.__benchFrameGaps ?? null));
  const sceneAckLatency = summarizeSceneAckLatency(await probePage(() => window.__benchSceneAckLatencies ?? null));
  // Windowed runs: what the counters moved BY across the bracket (see walkStatsAtOpen). Never replaces the
  // cumulative `walkStats` field — consumers of that one (docs/mirror-combat-bench.md, probe scripts) read it
  // as "since page load" and must keep doing so.
  const walkStatsWindow = opts.window
    ? diffWalkStats(walkStatsAtOpen, await probePage(cloneWalkStatsInPage))
    : null;
  const windowInfo = opts.window
    ? {
        ...opts.window,
        // The page's own view of the bracket: when each bound was crossed on the page clock, and which
        // recorded-stream ms triggered it. `spanMs` is the honest window length; `wall` above is the same
        // span seen through the harness's poll latency.
        ...((await probePage(() => {
          const at = window.__benchWindowAt;
          if (!at || at.startedAt == null || at.endedAt == null) return { spanMs: null, streamMs: null };
          return {
            spanMs: Math.round((at.endedAt - at.startedAt) * 10) / 10,
            streamMs: [at.startStreamMs, at.endStreamMs]
          };
        })) ?? { spanMs: null, streamMs: null })
      }
    : null;

  // FLIGHT-SCOPED CANVAS CENSUS (see flightCanvasCensusInPage). Taken HERE — the measured window has closed, so
  // it cannot perturb a single number above, but the rest of the stream has not been drained yet, so the flight
  // subtrees the volley mounted are still on the page. Read it after the drain and a teardown-carrying fixture
  // would truthfully report zero canvases for a scene that had 60 of them a second earlier.
  let flightCanvases = null;
  try {
    flightCanvases = await probePage(flightCanvasCensusInPage);
  } catch (e) {
    console.error(`  flight canvas census failed: ${e}`);
  }
  // --connect-cdp: the viewport is whatever the attached tab already is (no browser.newContext here), so record
  // what the page ACTUALLY has rather than the --viewport the harness could not apply.
  const pageViewport = opts.connect
    ? await page
        .evaluate(() => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }))
        .catch(() => null)
    : null;

  // Offline max-consumption rate (--pace=max only; null otherwise): the fake WS timestamps each credit-gated
  // delta delivery, and every one of those rode a scene-ack from a rendered frame — so deliveries/second IS
  // the effective mirror rate this page can sustain, measured with zero producer in the loop.
  let maxPace = null;
  const maxDeltas = await probePage(() => window.__benchMaxDeltas ?? null);
  if (Array.isArray(maxDeltas) && maxDeltas.length >= 2) {
    const spanMs = maxDeltas[maxDeltas.length - 1] - maxDeltas[0];
    maxPace = {
      deltas: maxDeltas.length,
      spanMs: round(spanMs, 0),
      hz: spanMs > 0 ? round(((maxDeltas.length - 1) / spanMs) * 1000, 2) : null
    };
  }

  // --window closed on a bound in the MIDDLE of the stream, so the rest of it has not been delivered yet.
  // Drain it (and settle) before the post-window probes: --census/--layers/--shot/--dom-styles all describe the
  // SETTLED scene, and a half-replayed one would quietly change what they mean.
  if (opts.window) {
    try {
      await page.waitForFunction(() => window.__benchDone === true, null, { timeout: 180_000 });
    } catch {
      console.error("  stream did not finish after the measured window closed");
    }
    await page.waitForTimeout(500);
  }

  // ---- idle window (--idle) -------------------------------------------------------------------------------
  // Runs AFTER the measured window closes (like --layers/--census/--shot) so the headline numbers never move.
  // The window itself is deliberately EMPTY: no input, no page.evaluate, no screenshot, no CDP domain enable
  // between the two markers. That emptiness is what makes "zero UpdateLayoutTree/Layerize/Commit/PrePaint in the
  // window" a statement about the PAGE's idle animations rather than about the harness poking it.
  let idle = null;
  // R7 W1-I1b: the idle hold is an EVIDENCE block, and a dead page has no idle behaviour to describe. Skipping it
  // outright also saves the 4-8s hold on a cell that has already told us everything it is going to.
  if (opts.idle && !pageGone()) {
    const mark = (label) => page.evaluate(idleMarkerWindowInPage, { label });
    // THE CANVAS STAGE'S OWN IDLE RATE, taken as a DELTA across the window rather than as a post-settle total.
    // `--census` reads cumulative counters, so on a settled screen it cannot tell a stage that parked from one
    // that has been repainting for eight seconds — the totals are dominated by the replay that came before. Two
    // reads, one on each side of the markers, are what turn those counters into "frames per idle second". Both
    // are OUTSIDE [cc-idle-start, cc-idle-end], so the window itself stays instrumentation-free.
    const readStage = () =>
      page.evaluate(() => {
        // This timestamp and the counters are deliberately one page task. It
        // is outside the marker bracket, so it cannot perturb the quiet
        // interval while still pricing the exact counter-delta span.
        const sampledAtMs = performance.now();
        const read = window.__mirrorCanvasStats;
        if (typeof read !== "function") return { sampledAtMs, available: false, geometry:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,backing:null} };
        const s = read();
        return {
          sampledAtMs,
          geometry: {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,backing:s.backingStore},
          available: true,
          // Counters are meaningful only within one renderer lifetime. The
          // page-global seam can be replaced by a remount between these two
          // out-of-window reads, so carry its owner identity into the delta.
          instanceId: s.instance?.id ?? null,
          instanceCreatedAtMs: s.instance?.createdAtMs ?? null,
          instanceDisposed: s.instance?.disposed ?? null,
          frames: s.frames ?? 0,
          animFrames: s.animFrames ?? 0,
          fxUploads: s.fx ? s.fx.uploads : null,
          fxQuads: s.fx ? s.fx.quads : null,
          fxFps: s.fx ? s.fx.fps ?? null : null,
          // These are cumulative stage counters. Keep only the families whose
          // deltas answer the idle-cost question; executor quads/batches are
          // deliberately excluded because they are last-frame snapshots.
          glyphPass: s.textGlyphs?.pass
            ? {
                runs: s.textGlyphs.pass.runs ?? null,
                glyphs: s.textGlyphs.pass.glyphs ?? null
              }
            : null,
          schedule: s.schedule ?? null
        };
      });
    // Start tracing before the first counter sample, then take the samples as
    // tightly as possible around the marker-only interval. In particular do
    // not let CDP Tracing.start/Tracing.end latency get counted as stage work
    // and then divided by --idle.
    if (markerTrace.scope?.phase === "idle") await markerTrace.start();
    const stageBefore = await readStage();
    const markerStartAtMs = await mark("cc-idle-start");
    await page.waitForTimeout(opts.idle);
    const markerEndAtMs = await mark("cc-idle-end");
    const stageAfter = await readStage();
    if (markerTrace.scope?.phase === "idle") {
      const completed = await markerTrace.stop();
      tracePath = completed.tracePath;
      traceMetrics = completed.traceMetrics;
    }
    const markerWindowMs = markerEndAtMs - markerStartAtMs;
    const stageSampleWindowMs = stageAfter.sampledAtMs - stageBefore.sampledAtMs;
    idle = {
      windowMs: opts.idle,
      frameGaps: summarizeFrameGaps(await probePage(() => window.__benchIdleFrameGaps ?? null)),
      markerWindowMs: round(markerWindowMs, 3),
      // The trace owns the same markers when requested. Keep its clock beside
      // the page clock: a meaningful disagreement is a trace/marker problem,
      // never a reason to silently alter the stage rate denominator.
      traceMarkerWindowMs: traceMetrics?.windowMs ?? null,
      stageSampleWindowMs: round(stageSampleWindowMs, 3),
      stageSamples: { beforeAtMs: stageBefore.sampledAtMs, afterAtMs: stageAfter.sampledAtMs, beforeGeometry:stageBefore.geometry, afterGeometry:stageAfter.geometry },
      shots: null,
      stage: null,
      stageDeltas: null,
      stageMismatch: null
    };
    if (stageBefore.available && stageAfter.available) {
      if (stageBefore.instanceId !== stageAfter.instanceId) {
        // Never subtract counters from different renderer objects. Reporting
        // that made remount churn look like an idle paint rate — an invalid
        // measurement, not a slow stage.
        idle.stageMismatch = {
          before: { id: stageBefore.instanceId, createdAtMs: stageBefore.instanceCreatedAtMs, disposed: stageBefore.instanceDisposed },
          after: { id: stageAfter.instanceId, createdAtMs: stageAfter.instanceCreatedAtMs, disposed: stageAfter.instanceDisposed }
        };
      } else {
        const secs = stageSampleWindowMs > 0 ? stageSampleWindowMs / 1000 : null;
        const per = (a, b) => (a == null || b == null || secs === null ? null : round((b - a) / secs, 2));
        // Unlike executor.stats.quads/batches, these values are cumulative in
        // the renderer. Do not turn an absent family into zero: e.g. a canvas
        // stage with glyph batching disabled has no glyph-pass delta to report.
        const delta = (a, b) => (typeof a === "number" && typeof b === "number" ? b - a : null);
        const glyphPass =
          stageBefore.glyphPass && stageAfter.glyphPass
            ? {
                runs: delta(stageBefore.glyphPass.runs, stageAfter.glyphPass.runs),
                glyphs: delta(stageBefore.glyphPass.glyphs, stageAfter.glyphPass.glyphs)
              }
            : null;
        idle.stage = {
          instanceId: stageAfter.instanceId,
          sampleWindowMs: round(stageSampleWindowMs, 3),
          framesPerSec: per(stageBefore.frames, stageAfter.frames),
          animFramesPerSec: per(stageBefore.animFrames, stageAfter.animFrames),
          fxUploadsPerSec: per(stageBefore.fxUploads, stageAfter.fxUploads),
          fxQuads: stageAfter.fxQuads,
          fxFps: stageAfter.fxFps,
          rafs: stageBefore.schedule && stageAfter.schedule ? stageAfter.schedule.rafs - stageBefore.schedule.rafs : null,
          parks: stageBefore.schedule && stageAfter.schedule ? stageAfter.schedule.parks - stageBefore.schedule.parks : null,
          parkWakeups:
            stageBefore.schedule && stageAfter.schedule
              ? stageAfter.schedule.parkWakeups - stageBefore.schedule.parkWakeups
              : null
        };
        idle.stageDeltas = {
          // Same identity guard as idle.stage: these are valid only when both
          // snapshots came from exactly one renderer lifetime.
          instanceId: stageAfter.instanceId,
          sampleWindowMs: round(stageSampleWindowMs, 3),
          frames: delta(stageBefore.frames, stageAfter.frames),
          animFrames: delta(stageBefore.animFrames, stageAfter.animFrames),
          glyphPass
        };
      }
    }
    if (opts.idleShots) {
      // Motion evidence: two viewport screenshots in the still-idle TAIL (nothing has been interacted with).
      // They are NOT inside [cc-idle-start, cc-idle-end] because Page.captureScreenshot forces a frame, which
      // would show up in the very frame counts the gate asserts on.
      const a = `${opts.idleShots}-a.png`;
      const b = `${opts.idleShots}-b.png`;
      try {
        await mark("cc-shot-a");
        await page.screenshot({ path: a, fullPage: false });
        await page.waitForTimeout(opts.idleShotGapMs ?? 600);
        await mark("cc-shot-b");
        await page.screenshot({ path: b, fullPage: false });
        idle.shots = { a, b, gapMs: opts.idleShotGapMs ?? 600 };
      } catch (e) {
        console.error(`  idle screenshots failed: ${e}`);
      }
    }
  }

  // ---- animation audit (--anim-audit) ---------------------------------------------------------------------
  let animAudit = null;
  if (opts.animAudit) {
    try {
      animAudit = await page.evaluate(animAuditInPage);
      animAudit.layerProbe = await animationLayerProbe(cdp, page);
      animAudit.recording = recordingPath;
      animAudit.pageUrl = pageUrl;
      if (opts.animAuditOut) {
        mkdirSync(dirname(opts.animAuditOut), { recursive: true });
        writeFileSync(opts.animAuditOut, JSON.stringify(animAudit, null, 2));
      } else {
        console.log("ANIM_AUDIT " + JSON.stringify(animAudit));
      }
    } catch (e) {
      console.error(`  anim audit failed: ${e}`);
    }
  }

  // Enabled AFTER the measured window (wallB metrics already snapshotted) so LayerTree change streaming never
  // perturbs the headline Task number. On enable Chromium sends NO snapshot for a settled (static) tree, so
  // nudge exactly one trivial compositor commit to elicit the current layer set, then read compositingReasons
  // per layer into a histogram (what actually forces each composited layer: Canvas / Overlap / blend / etc).
  // R10-PERF6 WS-P2 — factored out of the --layers block so the reveal burst can take a SECOND reading of the
  // OPENED screen. The settled-combat reading cannot answer the map-open question at all: it is taken while the
  // map is still hidden, so both arms of an A/B report the same combat layer count no matter what opening the
  // map does to it.
  async function snapshotLayers() {
    try {
      let latest = [];
      const onChange = (e) => {
        if (Array.isArray(e.layers)) latest = e.layers;
      };
      cdp.on("LayerTree.layerTreeDidChange", onChange);
      await cdp.send("LayerTree.enable");
      await page.waitForTimeout(150);
      if (latest.length === 0) {
        await page.evaluate(() => {
          const d = document.createElement("div");
          d.style.cssText = "position:fixed;left:-9px;top:-9px;width:1px;height:1px;will-change:transform";
          document.body.appendChild(d);
          void d.offsetWidth;
          d.remove();
        });
        await page.waitForTimeout(200);
      }
      // `--layer-detail` also resolves each layer back to its DOM element. DOM.enable + a full getDocument are
      // required before DOM.resolveNode will accept the backendNodeIds LayerTree hands out, and both are only paid
      // for when the flag is on (they are not free, and this runs after the measured window either way).
      if (opts.layerDetail) {
        await cdp.send("DOM.enable").catch(() => {});
        await cdp.send("DOM.getDocument", { depth: -1 }).catch(() => {});
      }
      const reasons = {};
      const rows = [];
      for (const l of latest) {
        let ids = [];
        try {
          const r = await cdp.send("LayerTree.compositingReasons", { layerId: l.layerId });
          ids = r.compositingReasonIds ?? r.compositingReasons ?? [];
          for (const reason of ids) {
            reasons[reason] = (reasons[reason] ?? 0) + 1;
          }
        } catch { /* per-layer best effort */ }
        if (!opts.layerDetail) continue;
        let who = "-";
        if (l.backendNodeId) {
          try {
            const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: l.backendNodeId });
            const probe = await cdp.send("Runtime.callFunctionOn", {
              objectId: object.objectId,
              returnByValue: true,
              functionDeclaration: `function(){
                const p = this.getAttribute ? (this.getAttribute("data-node-path") || "") : "";
                const b = this.getBoundingClientRect ? this.getBoundingClientRect() : { width: 0, height: 0 };
                const cls = String(this.className || "").split(" ")[0];
                return this.tagName + "." + cls + " " + (p ? p.slice(-58) : "") + " box=" + Math.round(b.width) + "x" + Math.round(b.height);
              }`
            });
            who = probe.result.value;
          } catch { /* best effort — an unresolvable layer still gets its row */ }
        }
        rows.push({
          order: rows.length,
          width: Math.round(l.width),
          height: Math.round(l.height),
          mpx: Math.round((l.width * l.height) / 1e4) / 100,
          paintCount: l.paintCount ?? 0,
          drawsContent: !!l.drawsContent,
          reasons: ids,
          element: who
        });
      }
      await cdp.send("LayerTree.disable").catch(() => {});
      cdp.off?.("LayerTree.layerTreeDidChange", onChange);
      return {
        count: latest.length,
        reasons,
        drawing: latest.filter((l) => l.drawsContent).length,
        rows: opts.layerDetail ? rows : null
      };
    } catch {
      return null; // best effort
    }
  }

  // --report needs a layerCount, so it takes the same post-window snapshot --layers does.
  const layers = opts.layers || opts.report ? await snapshotLayers() : null;

  // Post-settle full-page screenshot (visual-parity evidence for A/B runs). After the measured window like
  // --layers/--census, so it never perturbs the headline numbers. The stream is fully delivered and settled,
  // so equal code ⇒ equal pixels (modulo free-running spine/intent canvases — compare with a tolerance).
  //
  // R5 T0 — THE CANVAS ARM DOES NOT SCREENSHOT. On a headless box `page.screenshot()` of `?stage=canvas` comes
  // back with the DOM overlay and none of the stage's own pixels, because the GL context carries no
  // `preserveDrawingBuffer` and a capture is always a later task than the paint that filled the buffer. Forcing
  // a repaint cannot fix that; the read has to happen INSIDE the painting task, which is what the renderer's
  // `__mirrorCanvasSnapshot()` seam does (paint-dump gated).
  //
  // So on that arm this writes the STAGE's own pixels to `--shot` and the page screenshot beside it as
  // `<shot>.overlay.png` (the DOM overlay: text, and whatever chrome the stage does not own). When the seam is
  // not reachable — no `?paintDump=1`, a lost context, an older bundle — it REFUSES rather than writing a blank
  // PNG that reads like a broken renderer. A refusal is a warning and a `shotRefused` reason in the report, not
  // an exit: the numbers of the run are still good. `--shot-force` writes the page screenshot anyway.
  let shotPath = null;
  let shotOverlayPath = null;
  let shotRefused = null;
  if (opts.shot) {
    // Which arm is this, and can it answer? Both questions in one evaluate so a page without the canvas backend
    // (the DOM arm, or a canvas arm whose context never came up) falls straight through to the old path.
    const arm = await page
      .evaluate(() => {
        const stats = typeof window.__mirrorCanvasStats === "function" ? window.__mirrorCanvasStats() : null;
        if (!stats || stats.backend !== "canvas") return null;
        return { seam: typeof window.__mirrorCanvasSnapshot === "function", contextLost: !!stats.contextLost };
      })
      .catch(() => null);
    if (arm === null) {
      try {
        await page.screenshot({ path: opts.shot, fullPage: false });
        shotPath = opts.shot;
      } catch (e) {
        console.error(`  screenshot failed: ${e}`);
      }
    } else {
      // The stage's own pixels, read inside the painting task. `dataUrl` is null when the seam declined (no
      // scene, lost context, a `toDataURL` the browser refused) — which is a refusal, never a blank frame.
      const dataUrl = arm.seam && !arm.contextLost
        ? await page.evaluate(() => window.__mirrorCanvasSnapshot()).catch(() => null)
        : null;
      if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/png;base64,")) {
        // `page.screenshot` creates the directory for itself; a raw write does not.
        mkdirSync(dirname(opts.shot), { recursive: true });
        writeFileSync(opts.shot, Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64"));
        shotPath = opts.shot;
        shotOverlayPath = opts.shot.replace(/\.png$/i, "") + ".overlay.png";
        try {
          await page.screenshot({ path: shotOverlayPath, fullPage: false });
        } catch {
          shotOverlayPath = null; // best effort — the stage pixels are the evidence
        }
        console.error(`  canvas snapshot -> ${shotPath}${shotOverlayPath ? `  (+ overlay ${shotOverlayPath})` : ""}`);
      } else {
        shotRefused = arm.contextLost
          ? "canvas context lost"
          : arm.seam
            ? "__mirrorCanvasSnapshot() declined (no scene, or toDataURL refused)"
            : "no __mirrorCanvasSnapshot() — add ?paintDump=1 to --query";
        console.error(
          `  --shot REFUSED on the canvas arm: ${shotRefused}.\n` +
            `    A page screenshot of this arm captures the DOM overlay and none of the stage; writing one would\n` +
            `    look like a renderer that drew nothing. Re-run with --query 'paintDump=1', or pass --shot-force.`
        );
        if (opts.shotForce) {
          try {
            await page.screenshot({ path: opts.shot, fullPage: false });
            shotPath = opts.shot;
            console.error(`  --shot-force: wrote the page screenshot anyway -> ${shotPath} (stage pixels ABSENT)`);
          } catch (e) {
            console.error(`  screenshot failed: ${e}`);
          }
        }
      }
    }
  }

  // Post-settle DOM style parity dump (see --dom-styles). Same placement as --shot: after the measured window.
  // Each line is prefixed `V ` / `H ` by the SHARED hidden-ancestry classifier (see hiddenAncestryInPage), so a
  // dormancy A/B can prove "the diff is confined to hidden-ancestry lines" with a grep instead of by eye. Both
  // sides of an A/B run the same script, so the prefix never breaks the comparison.
  if (opts.domStyles) {
    try {
      const scan = await page.evaluate(hiddenAncestryInPage, { styles: true });
      const dump = scan ? scan.styleLines.join("\n") : "";
      writeFileSync(opts.domStyles, dump);
      console.error(
        `  dom styles -> ${opts.domStyles}` +
          (scan ? `  (${scan.elementsVisibleAncestry} V / ${scan.elementsHiddenAncestry} H lines)` : "")
      );
    } catch (e) {
      console.error(`  dom-styles dump failed: ${e}`);
    }
  }

  // Post-settle PAINT DUMP (see --paint-dump). Same placement as --shot / --dom-styles: after the measured
  // window, on the settled scene, so it describes the same frame the screenshot does.
  if (opts.paintDump) {
    try {
      const dump = await page.evaluate(paintDumpInPage);
      if (!dump) {
        console.error("  paint-dump: no .mirror-stage — nothing dumped");
      } else {
        // A header line so a dump is self-describing (which backend, which recording, which viewport) and the
        // comparer can refuse a pair that was not taken under the same conditions.
        const n3 = (v) => (Number.isFinite(v) ? Number(v).toFixed(3) : "?");
        const header = [
          `# backend=${dump.backend}`,
          `# recording=${basename(recordingPath)}`,
          `# url=${pageUrl}`,
          `# viewport=${opts.viewport.width}x${opts.viewport.height}`,
          // The measured design -> page mapping. See `paintDumpInPage`: reported, never derived.
          `# dpr=${n3(dump.dpr)}`,
          `# stageBox=${(dump.stageBox ?? []).map(n3).join(",")}`,
          `# designBox=${(dump.designBox ?? []).map(n3).join(",")}`,
          `# lines=${dump.lines.length}`
        ];
        writeFileSync(opts.paintDump, header.concat(dump.lines).join("\n") + "\n");
        console.error(`  paint dump -> ${opts.paintDump}  (${dump.backend}, ${dump.lines.length} records)`);
      }
    } catch (e) {
      console.error(`  paint-dump failed: ${e}`);
    }
  }

  // Post-settle HIT-TEST GRID (see --hit-grid). After the paint dump so both describe the same settled frame.
  if (opts.hitGrid) {
    try {
      const grid = await page.evaluate(hitGridInPage, { step: opts.hitGridStep });
      if (!grid) {
        console.error("  hit-grid: no renderer hit probe on the page (is this a mirror view?)");
      } else {
        const header = [
          `# backend=${(await page.evaluate(() => (typeof window.__mirrorCanvasStats === "function" ? "canvas" : "dom")))}`,
          `# recording=${basename(recordingPath)}`,
          `# viewport=${opts.viewport.width}x${opts.viewport.height}`,
          `# stageBox=${grid.stageBox}`,
          `# step=${grid.step}`,
          `# samples=${grid.samples}`
        ];
        writeFileSync(opts.hitGrid, header.concat(grid.lines).join("\n") + "\n");
        console.error(`  hit grid -> ${opts.hitGrid}  (${grid.samples} samples, step ${grid.step})`);
      }
    } catch (e) {
      console.error(`  hit-grid failed: ${e}`);
    }
  }

  // Post-settle RAISE PROBE (see --raise-probe). Same settled frame as the two gates above.
  if (opts.raiseProbe) {
    try {
      const probe = await page.evaluate(raiseProbeInPage);
      writeFileSync(
        opts.raiseProbe,
        JSON.stringify(
          {
            recording: basename(recordingPath),
            viewport: `${opts.viewport.width}x${opts.viewport.height}`,
            ...probe
          },
          null,
          2
        ) + "\n"
      );
      console.error(
        `  raise probe -> ${opts.raiseProbe}  (${probe.backend}, ${probe.groups.length} HUD groups, ${probe.holders.length} holders)`
      );
    } catch (e) {
      console.error(`  raise-probe failed: ${e}`);
    }
  }

  let census = null;
  if (opts.census) {
    // After the measured window: read the in-page counters (installed by censusInit) + snapshot the DOM census
    // + the hidden-ancestry split (the dormancy round's A/B metric — one diff, same run).
    try {
      const counters = await page.evaluate(() => window.__census ?? null);
      // The gsw effect runtimes' own counters (MirrorView's `__mirrorShaderStats` seam). `boxReads` is the
      // one that matters here: it is EXACTLY the number of `clientWidth`/`clientHeight` reads the particle
      // runtime performed, i.e. the forced layouts it caused — a deterministic count of the work, not a
      // timing. The trace's forced-reflow number cannot resolve a change of a few dozen reads (repeated A/B
      // arms of the same code overlap), so an option that claims to remove them has to be checked here.
      const effectStats = await page.evaluate(() =>
        typeof window.__mirrorShaderStats === "function" ? window.__mirrorShaderStats() : null
      );
      // …and what gsw could NOT render. Every shader and particle is attempted generically and falls back to the
      // node's CSS/SVG paint when it fails, which is invisible by design — a shader that has never once run looks
      // exactly like a shader with nothing to do. `shaderResources.noteUnsupportedRender` counts gsw's own
      // (deduped) reports, so a screen's withheld effects are a row here instead of folklore. Read separately
      // from `__mirrorShaderStats` because it is installed at module scope, not from MirrorView's onMounted.
      const unsupported = await page.evaluate(() =>
        typeof window.__mirrorEffectUnsupported === "function" ? window.__mirrorEffectUnsupported() : null
      );
      if (effectStats && unsupported) {
        effectStats.unsupported = unsupported;
      }
      const dom = await page.evaluate(domCensusInPage);
      // Which canvases own the surface memory (see topSurfacesInPage). Ranked, not summed: `dom.canvases`
      // already carries the count.
      const topSurfaces = await page.evaluate(topSurfacesInPage, 10);
      const scan = await page.evaluate(hiddenAncestryInPage, { styles: false });
      if (scan) {
        delete scan.styleLines;
        // `dom.mirrorNodes` is the document-wide count and already reported; the scan's stage-scoped copy would
        // shadow it for no gain (the SPLIT fields are what this adds). `scan.elements` is kept deliberately: it
        // must equal `dom.totalElements`, which is a free consistency check on the classifier's traversal.
        delete scan.mirrorNodes;
        Object.assign(dom, scan);
      }
      // The single-canvas backend's own counters (`?stage=canvas`), null on the DOM stage. Read here rather than
      // in the measured window because it is a settled-scene description, like everything else in the census.
      const canvasStats = await page.evaluate(() =>
        typeof window.__mirrorCanvasStats === "function" ? window.__mirrorCanvasStats() : null
      );
      // R7 W1 — three page-side reporters that exist because their subjects are otherwise SILENT.
      //   glContext  every context loss/restore ON THE PAGE, not just the stage's (fix d). A killed GPU process
      //              takes every canvas at once, so a per-renderer counter describes a fraction of the event.
      //   staticBg   the fail-open latch as transitions (fix e). Combat is 10 fx surfaces vs 32 either side of
      //              it, so a session that latched unnoticed measured a scene nobody chose.
      //   prefetch   decoded atlas bytes held resident (fix b) — the number that was an estimate for a round.
      const glContext = await page.evaluate(() =>
        typeof window.__mirrorGlContextEvents === "function" ? window.__mirrorGlContextEvents() : null
      );
      const staticBg = await page.evaluate(() =>
        typeof window.__mirrorStaticBg === "function" ? window.__mirrorStaticBg() : null
      );
      const prefetch = await page.evaluate(() => {
        const p = window.__mirrorImagePrefetch;
        return p ? { ...p, list: p.list.length } : null;
      });
      census = { ...counters, effectStats, dom, topSurfaces, canvasStats, glContext, staticBg, prefetch };
    } catch { /* best effort */ }
  }

  // ---- reveal burst (--reveal-burst) ----------------------------------------------------------------------
  // LAST of the post-settle probes on purpose: it MUTATES the page (a whole hidden screen becomes visible), so it
  // must run after --shot / --dom-styles / --census / --layers / --idle, all of which describe the settled combat
  // scene. The measured window closed long before any of these, so the headline numbers are untouched either way.
  let revealBurst = null;
  if (opts.revealBurst && opts.revealPayload) {
    try {
      // Bracket the whole reveal (injection + walk + settle) with CDP metrics: the renderer's walk is only part
      // of the story — showing ~1.8k elements also makes Blink recalc style, lay them out and (mostly) PAINT +
      // composite them. Baseline attribution over this window: task ~398ms vs script 37 / recalcStyle 13 /
      // layout 5, i.e. the bulk of the reveal's wall time is non-script compositing work the walk never touches.
      const mBefore = await getMetrics();
      revealBurst = await page.evaluate(revealBurstInPage, opts.revealPayload);
      const mAfter = await getMetrics();
      if (revealBurst) {
        const dm = (k) =>
          mBefore[k] !== null && mAfter[k] !== null ? Math.round((mAfter[k] - mBefore[k]) * 1000) : null;
        revealBurst.blinkMs = {
          task: dm("task"),
          script: dm("script"),
          layout: dm("layout"),
          recalcStyle: dm("recalcStyle")
        };
        revealBurst.node = opts.revealInfo ?? null;
        // The layer count of the OPENED screen — the map-open gate (the Aug-11 phone trace counted 223 layers
        // created while opening the map). Taken after the reveal has settled, so it prices the map that is now
        // on screen rather than the combat that was.
        if (opts.layers) {
          revealBurst.layersAfterReveal = await snapshotLayers();
        }
        if (opts.revealShot) {
          try {
            await page.screenshot({ path: opts.revealShot, fullPage: false });
            revealBurst.shot = opts.revealShot;
          } catch (e) {
            console.error(`  reveal screenshot failed: ${e}`);
          }
        }
        console.log("REVEAL_BURST " + JSON.stringify(revealBurst));
      }
    } catch (e) {
      console.error(`  reveal burst failed: ${e}`);
    }
  }

  // A trace that reached here without closing is a harness lifecycle fault. Do not leave CDP tracing active, but
  // make the marker absence visible in the report rather than treating the unbounded artifact as evidence.
  if (markerTrace.started) {
    const completed = await markerTrace.stop();
    tracePath = completed.tracePath;
    traceMetrics = completed.traceMetrics;
  }

  // --report: the contract's post-window presence guard + geometry block, every repeat. Same placement as
  // --shot / --layers (after the measured window), so it never perturbs the headline numbers.
  let presented = null;
  let geometry = null;
  let reportDiscard = null;
  if (opts.report) {
    try {
      const probe = await page.evaluate(presenceProbeInPage).catch((e) => ({ error: String(e?.message ?? e) }));
      if (!probe || probe.error) {
        reportDiscard = `presence probe: ${probe?.error ?? "returned nothing"}`;
      } else {
        try {
          geometry = buildGeometry({
            viewport: probe.viewport,
            devicePixelRatio: probe.dpr,
            designBox: probe.designBox,
            stageRect: probe.stageRect,
            emulatedViewport: opts.connectPage ? null : `${opts.viewport.width}x${opts.viewport.height}`,
          });
        } catch (e) {
          reportDiscard = `geometry: ${e.message}`;
        }
        if (!reportDiscard && probe.samplePoints.length === 0) {
          reportDiscard = probe.hasHitProbe
            ? "the renderer reported no painted nodes anywhere on the stage — the scene did not render"
            : probe.backend === "canvas"
              ? "canvas arm without window.__mirrorHitProbe — cannot locate painted content for the presence guard"
              : "no painted scene-node elements on the stage for the presence guard";
        }
        if (!reportDiscard) {
          let pngBuffer = null;
          if (probe.backend === "canvas") {
            const dataUrl = await page
              .evaluate(() => (typeof window.__mirrorCanvasSnapshot === "function" ? window.__mirrorCanvasSnapshot() : null))
              .catch(() => null);
            if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/png;base64,")) {
              pngBuffer = Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
            } else {
              reportDiscard =
                "canvas arm: window.__mirrorCanvasSnapshot() unavailable — re-run --report with --query 'paintDump=1'";
            }
          } else {
            pngBuffer = await page.screenshot({ fullPage: false }).catch(() => null);
            if (!pngBuffer) reportDiscard = "page.screenshot() failed";
          }
          if (pngBuffer && !reportDiscard) {
            const shotDir = resolve(REPO_ROOT, ".sts2/bench/shots");
            mkdirSync(shotDir, { recursive: true });
            const shot = resolve(shotDir, `${opts.reportStem ?? "report"}-r${opts.repeatIndex ?? 0}.png`);
            writeFileSync(shot, pngBuffer);
            const res = checkPresence({
              pngBuffer,
              samplePoints: probe.samplePoints,
              devicePixelRatio: probe.dpr,
              cssViewport: probe.viewport,
            });
            presented = {
              nonEmptyRatio: res.nonEmptyRatio,
              sampleHits: res.sampleHits,
              sampleCount: res.sampleCount,
              screenshot: relative(REPO_ROOT, shot),
            };
            if (!res.ok) {
              reportDiscard =
                `presence guard: ${res.sampleHits}/${res.sampleCount} painted sample points were on screen ` +
                `(nonEmptyRatio ${res.nonEmptyRatio}); the replay measured a (partly) blank stage`;
            }
          }
        }
      }
    } catch (e) {
      reportDiscard = `presence capture threw: ${e?.message ?? e}`;
    }
  }

  const wall = (wallB - wallA) / 1000; // seconds
  const dTask = a.task !== null && b.task !== null ? b.task - a.task : null;
  const delta = {
    wall: round(wall, 3),
    taskDuration: round(dTask, 4),
    scriptDuration: round(a.script !== null && b.script !== null ? b.script - a.script : null, 4),
    layoutDuration: round(a.layout !== null && b.layout !== null ? b.layout - a.layout : null, 4),
    recalcStyleDuration:
      a.recalcStyle !== null && b.recalcStyle !== null ? round(b.recalcStyle - a.recalcStyle, 4) : null,
    busyPct: dTask !== null && wall > 0 ? round((dTask / wall) * 100, 1) : null,
    nodesA,
    nodesB,
    // R7 W1-I1a — the RENDERER-process gauges at both ends of the measured bracket. Reported as both ends plus
    // the growth rather than as a single number: a heap that is 400MB at the open and 400MB at the close is a
    // different finding from one that got there during the window, and only the pair distinguishes them. MB, not
    // bytes, because every other memory number in this round's ledger is in MB. `blinkNodes` is Blink's whole-
    // document node count and is deliberately NOT folded into `nodesA`/`nodesB` (`.mirror-node` elements).
    blinkMemory: {
      jsHeapUsedMbA: round(mb(a.jsHeapUsed), 1),
      jsHeapUsedMbB: round(mb(b.jsHeapUsed), 1),
      jsHeapGrowthMb: a.jsHeapUsed !== null && b.jsHeapUsed !== null ? round(mb(b.jsHeapUsed - a.jsHeapUsed), 1) : null,
      jsHeapTotalMbB: round(mb(b.jsHeapTotal), 1),
      blinkNodesA: a.blinkNodes,
      blinkNodesB: b.blinkNodes,
      documentsB: b.documents,
      listenersA: a.listeners,
      listenersB: b.listeners
    },
    longTasks,
    tickMs,
    frameGaps,
    sceneAckLatency,
    flightCanvases,
    pageViewport,
    window: windowInfo,
    walkStatsWindow,
    maxPace,
    sweepMoves: opts.hoverSweep ? sweepCount : null,
    layers,
    census,
    churnCensus,
    walkStats,
    handParity,
    flightLiveness,
    droppedCardFlights,
    idle,
    animAuditPath: opts.animAudit && opts.animAuditOut ? opts.animAuditOut : null,
    animAuditCounts: animAudit ? animAudit.counts : null,
    revealBurst,
    tracePath,
    pageErrors,
    pageErrorCount: pageErrors.length,
    pageWarnings,
    pageWarningCount: pageWarnings.length,
    // R7 W1-I1b. `pageCrashed` true means every field above it was read from a page that had already died, so
    // the ones that are null are UNKNOWN rather than zero — the distinction the round-6 matrix could not make.
    pageCrashed,
    pageCrashAtMs: pageCrashAt,
    crashReason: null,
    // R7 W1-I1f — deduped (status, pathname) rows with counts, in first-seen order.
    responseErrors: [...responseErrors.values()],
    // --report only: this repeat's contribution to the shared perf-report/1 envelope. A `__discard` reason
    // (set here or by the presence guard / trace analyser above) EXCLUDES the repeat from `runs` and lists it
    // in `failures` — a required observation that could not be made is never serialised as a misleading zero.
    report: opts.report ? buildRepeatReport() : null
  };

  function buildRepeatReport() {
    const traceError = traceMetrics?.error ?? null;
    const layerCount = layers?.count ? layers.count : null;
    const longTaskCount = longTasks?.count ?? null;
    const longAnimationFrames = typeof loafCount === "number" ? loafCount : null;

    let discard = reportDiscard || traceError || null;
    if (!discard && layerCount === null) {
      discard = "layerCount UNMEASURED — the LayerTree snapshot returned no tree (heavy CPU throttle?)";
    }
    if (!discard && longTaskCount === null) discard = "longTaskCount UNMEASURED (page-side long-task observer)";
    if (!discard && longAnimationFrames === null) {
      discard = "longAnimationFrames UNMEASURED (page-side long-animation-frame observer)";
    }
    if (!discard && !(round(initialRenderMs, 1) > 0)) discard = "initialRenderMs was not a positive number";
    if (!discard && !(round(readyMs, 1) > 0)) discard = "readyMs was not a positive number";
    if (!discard && !geometry) discard = "geometry block was not built";
    if (!discard && !presented) discard = "presence guard produced no result";

    return {
      initialRenderMs: round(initialRenderMs, 1),
      readyMs: round(readyMs, 1),
      longTaskCount,
      longAnimationFrames,
      // Page-side rAF-callback durations (see tickSamplerInit). Beside frameCostMs on purpose: that one is a
      // whole main-thread task from the trace, this one is the mirror's own callbacks.
      tickMs: tickMs ?? { p50: 0, p95: 0, max: 0, count: 0, totalMs: 0 },
      layerCount: layerCount ?? 0,
      // contract blocks
      geometry: geometry ?? null,
      presented: presented ?? null,
      // provenance kept as extensions
      shotOverlayPath,
      shotRefused,
      tracePath,
      traceScope: markerTrace.scope?.phase ?? null,
      ...(traceMetrics ?? {}),
      ...(discard ? { __discard: discard } : {})
    };
  }

  if (cdp) await cdp.detach().catch(() => {});
  // Connect mode NEVER closes the page: it is the operator's own tab (and on a phone, closing it ends the run).
  // The next repeat blanks it on the way in; the last one is blanked by the caller.
  if (!opts.connectPage) await page.close();
  return delta;
}

// ---------------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------------

// `?shaders=`/`?particles=` are ONE lever with five values on the page side (quality.ts `effectModeParam`), not a
// boolean plus a separate mode: `on` IS `dynamic`. So a mode simply writes the value the panel would have written,
// and `--effects on/off` keeps meaning exactly what it always did (dynamic / disposed).
const effectsQuery = args.effectMode
  ? `shaders=${EFFECT_MODE_QUERY[args.effectMode]}&particles=${EFFECT_MODE_QUERY[args.effectMode]}`
  : args.effects
    ? "shaders=on&particles=on"
    : "shaders=off&particles=off";

// Chromium flags for the LAUNCHED browser (connect mode never gets a say — see the --connect-cdp caveats).
//
// `auto` keeps the rule this harness has always had: effects off => --disable-gpu, because a software rasteriser
// is deterministic and no GPU work is being measured. What `auto` does NOT do is hand an effects-ON run a real
// GPU: headless chromium with no flag at all still lands on ANGLE/SwiftShader on this box
// (`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)`), which is why every
// round-1 canvas baseline is a software capture. `--gpu vulkan` is the mode that reaches the real adapter.
function launchArgs() {
  if (args.gpu === "vulkan") return ["--use-angle=vulkan"];
  if (args.gpu === "swiftshader") return ["--disable-gpu"];
  return args.effects ? [] : ["--disable-gpu"];
}
const cullQuery = args.cull ? "&cull=on" : "";
// The gauge is read at module load in the renderer, so it has to be in the URL the page is first navigated to —
// there is no way to switch it on afterwards, by design (off ⇒ one boolean read per settle and nothing else).
const handParityQuery = args.handParity ? "&handParity=1" : "";

// `--query` OVERRIDES the harness's own params rather than trailing after them, and that is a fix, not a
// preference. The mirror reads its levers with `URLSearchParams.get()`, which returns the FIRST occurrence of a
// key — so a cell asking for `particles=static` behind `--effects on` used to produce
// `…&particles=on&particles=static` and run in DYNAMIC mode, silently, while its label and its report both said
// static. Every number from such a cell is about a mode nobody selected. Merging by key makes the explicit
// request win and keeps the harness's defaults for everything it did not mention.
function buildPageQuery() {
  const params = new URLSearchParams(`quality=${encodeURIComponent(args.quality)}`);
  for (const part of [effectsQuery, cullQuery.replace(/^&/, ""), handParityQuery.replace(/^&/, "")]) {
    if (!part) continue;
    for (const [k, v] of new URLSearchParams(part)) params.set(k, v);
  }
  if (args.query) {
    for (const [k, v] of new URLSearchParams(args.query)) params.set(k, v);
  }
  return params.toString();
}

// `--url` may carry its own query (`http://127.0.0.1:5180/?stage=canvas`), which is the natural way to type a
// page lever and used to silently produce a malformed duplicate query. Its parameters are folded in with the
// same precedence `--query` has — the caller's word beats the harness's defaults — and its path is kept.
const requestedPageUrl = (() => {
  const [rawOrigin, rawQuery = ""] = args.url.split("?");
  const params = new URLSearchParams(buildPageQuery());
  for (const [k, v] of new URLSearchParams(rawQuery)) params.set(k, v);
  return `${rawOrigin.replace(/\/$/, "")}/?${params.toString()}`;
})();
let pageUrl = requestedPageUrl;

console.log(`bench-mirror-replay`);
console.log(`  url:        ${requestedPageUrl}`);
console.log(`  recording:  ${recordingPath}`);
console.log(`  meta:       ${recMeta.messages ?? "?"} msgs, ${recMeta.bytes ?? "?"} bytes, ${recMeta.durationMs ?? "?"}ms span`);
console.log(`  pace:       ${args.pace}   repeats: ${args.repeats}` +
  `   effects: ${args.effects ? (args.effectMode ? EFFECT_MODE_QUERY[args.effectMode] : "on (dynamic)") : "off"}` +
  `   viewport: ${args.viewport.width}x${args.viewport.height}${args.dpr ? `@dpr${args.dpr}` : ""}` +
  `   quality: ${args.quality}   cpuThrottle: ${CPU_THROTTLE}x` +
  `${args.hoverSweep ? "   hover-sweep" : ""}${args.census ? "   census" : ""}${args.procMem ? "   proc-mem" : ""}`);
console.log(`  directView: ${hasRecordedDirectView ? "in recording" : "SYNTHESIZED"}`);
console.log(
  `  gpu:        ${args.gpu}` +
    (args.connectCdp
      ? "  (connect mode: the attached browser's own)"
      : `  -> ${launchArgs().join(" ") || "(chromium default)"}   window: ${args.headed ? "HEADED (real compositor)" : "headless"}`)
);

// --connect-cdp: everything this mode cannot control, said ONCE and up front, so no number below is read as if
// the harness had set it. (The per-run degradations are reported by runOnce as they happen.)
const connectMode = !!args.connectCdp;
if (connectMode) {
  console.log(`  connect:    ${args.connectCdp}  (attached browser: existing context + sole HTTP(S) page on --url port, no page is opened)`);
  console.log(`  serve:      http://127.0.0.1:${args.servePort}/recording${args.resRoot ? ` + /res/** from ${args.resRoot}` : ""}${args.assetCacheRoot ? ` + cache ${args.assetCacheRoot}` : ""}`);
  console.log(`  NOTE:       --viewport is NOT applied in connect mode (the tab's own size is recorded instead)`);
  if (CPU_THROTTLE > 1) {
    console.error(
      `  WARN: COUCHCOOP_CPU_THROTTLE=${CPU_THROTTLE} is IGNORED in connect mode — this bench does not throttle a\n` +
        "        browser it did not launch (on a phone the device's own speed is the measurement)."
    );
  }
  if (args.trace || args.report) {
    console.error(
      "  WARN: tracing an attached browser is allowed but the device-side trace buffer is small; a long capture\n" +
        "        truncates SILENTLY. Keep --window tight (or use --limit-ms) and treat a missing tail as lost data."
    );
  }
  if (args.resRoot || args.assetCacheRoot) {
    console.error(
      "  NOTE: connect-mode /res/** requests reaching the bench server use the same recovered-root/cache resolver\n" +
        "        as launch-mode interception. The page's same-origin proxy still needs its own asset origin; check\n" +
        "        the served/missing count below before believing a paint number."
    );
  }
}

// Synthesize the reveal message up front (offline, from the same recording text the page replays) so a bad
// --reveal-node fails BEFORE the browser spends a run.
let reveal = null;
if (args.revealBurst) {
  reveal = buildRevealMessage(recordingText, args.revealNode);
  if (reveal.error) {
    console.error(`--reveal-burst: ${reveal.error}`);
    process.exit(2);
  }
  console.log(
    `  reveal:     ${reveal.info.name ?? "?"} (${reveal.info.nodeId}) — ${reveal.info.wireSubtreeNodes} wire nodes, ` +
      `visible ${reveal.info.wasVisible} → true, ${reveal.info.bytes}B upsert`
  );
  if (reveal.info.wasVisible) {
    console.error("  WARN: the chosen reveal node was ALREADY visible in the recording — the reveal is a no-op.");
  }
}

// --limit-ms: replay only the recording's first N ms (the keyframe plus that much of the stream). The messages
// are in delivery order with `t` as the offset, so this is a real PREFIX of a real session, not a resample.
// It exists for --report: the trace buffer holds ~15s of a cc.debug capture and then stops recording SILENTLY,
// so a 30s replay's report window would lose its tail. Recorded in params, so nobody reads a 12s number as 30s.
function sliceRecording(text, limitMs) {
  if (!limitMs) return { text, messages: null };
  const kept = [];
  let messages = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.meta) { kept.push(line); continue; }
    if (typeof obj.t === "number" && obj.t > limitMs) break;
    kept.push(line);
    messages++;
  }
  return { text: kept.join("\n") + "\n", messages };
}

const sliced = sliceRecording(recordingText, args.limitMs);
const replayText = sliced.text;
if (args.limitMs) {
  console.log(`  limit:      first ${args.limitMs}ms of the recording (${sliced.messages} messages replayed)`);
}
if (args.window) {
  console.log(
    `  window:     measuring recording ms ${args.window.startMs}..${args.window.endMs} ` +
      `(${args.window.endMs - args.window.startMs}ms of a ${recMeta.durationMs ?? "?"}ms stream); ` +
      "the whole stream still replays"
  );
}

let browser;
let context;
let browserVersion = null;
let connectPage = null;
if (connectMode) {
  // ATTACH. `connectOverCDP` speaks the BROWSER endpoint (Chrome 151 broke the per-tab one), and the browser it
  // reaches already has exactly one context with the tab the operator foregrounded in it. Both are reused as-is:
  // a new context would be a different profile, and a new page would be a BACKGROUND tab, which Android throttles
  // to no rAF at all — the run would report a page that never rendered.
  browser = await chromium.connectOverCDP(args.connectCdp);
  browserVersion = browser.version?.() ?? null;
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    console.error(`--connect-cdp ${args.connectCdp}: the attached browser has no context. Open a tab first.`);
    process.exit(2);
  }
  context = contexts[0];
  const pages = context.pages();
  if (pages.length === 0) {
    console.error(
      `--connect-cdp ${args.connectCdp}: the attached browser's first context has no page.\n` +
        "  Open (and FOREGROUND) the tab this bench should drive — connect mode never opens one, because a\n" +
        "  background tab on Android gets no animation frames and would measure a page that never rendered."
    );
    process.exit(2);
  }
  // WHICH page: creation order is neither foreground nor ownership. Android Chrome can canonicalize the intended
  // 127.0.0.1 tab to worky.local, but preserves its port. Require exactly one HTTP(S) tab on --url's port; a
  // chrome-native://newtab target, any user tab, or a stale duplicate is a hard refusal before page.goto can touch it.
  try {
    connectPage = pages[selectConnectBenchPageIndex(pages.map((p) => p.url()), args.url)];
    pageUrl = effectiveConnectPageUrl(requestedPageUrl, connectPage.url());
  } catch (error) {
    console.error(`--connect-cdp ${args.connectCdp}: ${error.message}`);
    process.exit(2);
  }
  await connectPage.bringToFront();
  console.error(`[bench] connect mode: driving ${connectPage.url()} (${pages.length} tabs; brought to front)`);
  if (pageUrl !== requestedPageUrl) {
    console.error(`[bench] connect mode: requested ${requestedPageUrl} -> effective ${pageUrl}`);
  }
  // R7 W1-I1e/I1d: both are LAUNCH-MODE instruments and connect mode must say so rather than report a number it
  // did not apply. The attached tab's devicePixelRatio is whatever the device gives it (and is reported as
  // `config.devicePixelRatio` from the page); its processes live on the phone, where `.procs`/`.lmk` from
  // scripts/bench-phone-canvas-ab.sh are the instrument, not this box's /proc.
  if (args.dpr !== null) {
    console.error("[bench] --dpr REFUSED in connect mode: the attached tab's DPR is the device's; see config.devicePixelRatio.");
    args.dpr = null;
  }
  if (args.procMem) {
    console.error("[bench] --proc-mem REFUSED in connect mode: the browser's processes are on the device — use the phone script's .procs capture.");
    args.procMem = false;
  }
} else {
  // Dropping --disable-gpu is NOT the same as getting a GPU: a plain headless launch still reports
  // "ANGLE (Google, Vulkan … SwiftShader Device …)". `--gpu vulkan` (launchArgs) is the explicit backend choice
  // that reaches the real adapter; COUCHCOOP_BENCH_CHROME_ARGS remains the free-form escape hatch on top.
  // `--headed` (see its help): a real window on a real compositor, which is the only arm whose frame cadence and
  // whose GPU are the ones a viewer gets. Everything else about the run is identical, so a headed/headless pair
  // is a clean A/B of exactly that.
  browser = await chromium.launch({ headless: !args.headed, args: [...launchArgs(), ...EXTRA_CHROME_ARGS] });
  browserVersion = browser.version?.() ?? null;
  // R7 W1-I1e: --dpr. A host cell at dpr 1 and a phone cell at dpr 3.4876 are not the same experiment — every
  // backing store on the page is (dpr^2) times the area, which is the whole quantity a memory round is chasing.
  // The context is the only place this can be set; a page cannot change its own devicePixelRatio.
  context = await browser.newContext({
    viewport: args.viewport,
    ...(args.dpr ? { deviceScaleFactor: args.dpr } : {})
  });
}

// Connect mode: the recording (and, with --res-root/--asset-cache-root, assets) come off a real HTTP server instead of a
// Playwright route. Two reasons it has to. Route interception on an attached page would push every asset request
// through the harness over USB, which perturbs exactly the frame cadence this leg exists to measure; and the
// mirror is a PWA, so a request to its OWN origin can be answered by a service worker the bench never sees. An
// ABSOLUTE cross-origin URL (http://127.0.0.1:<port>/recording, reached from the phone via `adb reverse`) has
// neither problem. Bound on loopback only — this never listens on a network interface.
let benchServer = null;
let recordingHits = 0;
let resHits = 0;
const resMisses = new Set();
const assetServingEnabled = !!args.resRoot || !!args.assetCacheRoot;
const assetResolverOptions = {
  root: args.resRoot ?? DEFAULT_RES_ROOT,
  assetCacheRoot: args.assetCacheRoot
};
function resolveBenchAsset(url) {
  const answer = resolveAssetRequest({ ...assetResolverOptions, url });
  if (answer.status === 200) resHits += 1;
  else resMisses.add(`${url.pathname}${url.search}`);
  return answer;
}
function assetBody(answer) {
  return answer.filePath ? readFileSync(answer.filePath) : answer.body ?? "";
}
if (connectMode) {
  benchServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (url.pathname === "/recording") {
      recordingHits += 1;
      res.writeHead(200, { ...cors, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end(replayText);
      return;
    }
    // The same read-only resolver handles the browser's resource, model, and spine families.
    // Connect mode must expose all three: unlike launch-mode interception, the phone's same-origin
    // Vite proxy reaches this server over adb reverse.
    if (assetServingEnabled && isBenchAssetRoute(url.pathname)) {
      const answer = resolveBenchAsset(url);
      res.writeHead(answer.status, { ...cors, "Content-Type": answer.contentType });
      res.end(assetBody(answer));
      return;
    }
    res.writeHead(404, cors);
    res.end("");
  });
  await new Promise((ok, fail) => {
    benchServer.once("error", fail);
    benchServer.listen(args.servePort, "127.0.0.1", ok);
  }).catch((e) => {
    console.error(`--serve-port ${args.servePort}: could not listen (${e}). Is another bench still running?`);
    process.exit(2);
  });
}

// Serve the recording to the in-page fake WS (launched mode; connect mode uses the HTTP server above).
if (!connectMode) {
  await context.route("**/__bench/recording", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: replayText })
  );
}
// REAL ASSET BYTES for a paint bench. The resolver uses recovered raw files/Shader extraction first, then the
// optional production cache for generated or missing resources. The dev server proxies `/res` to the
// live game; with no game up every atlas 404s and the page paints nothing, so paint/raster/layer numbers are
// pure fiction. Serving the extracted resource root makes the map's real atlas pages decode as they do live.
// Misses are counted, not silently swallowed — a fixture whose textures all 404 must be visible as such.
if (assetServingEnabled && !connectMode) {
  // Launch mode can route these three resolver-backed families locally. `/bg/**` is deliberately absent:
  // it belongs to Vite's explicit on-disk fixture middleware and must never be synthesized by this harness.
  for (const assetFamily of BENCH_ASSET_FAMILIES) {
    await context.route(`**/${assetFamily}/**`, (route) => {
      const answer = resolveBenchAsset(new URL(route.request().url()));
      route.fulfill({ status: answer.status, contentType: answer.contentType, body: assetBody(answer) });
    });
  }
}
// Where the in-page fake socket fetches the stream from. Launched mode keeps the relative path the context route
// answers; connect mode hands it the bench server's ABSOLUTE loopback URL (see the server above).
const recordingUrl = connectMode ? `http://127.0.0.1:${args.servePort}/recording` : "/__bench/recording";
await context.addInitScript(fakeWebSocketInit, {
  recordingUrl,
  pace: args.pace,
  ackPacedMs: args.ackPacedMs ?? 0,
  dropCardFlights: args.dropCardFlights,
  synthesizeDirectView: !hasRecordedDirectView,
  window: args.window
});
await context.addInitScript(longTaskInit);
await context.addInitScript(tickSamplerInit);
if (args.flightLiveness) {
  await context.addInitScript(flightLivenessInit);
}
if (args.census) {
  await context.addInitScript(censusInit);
}
if (args.churnCensus) {
  await context.addInitScript(churnCensusInit);
}

const opts = {
  hoverSweep: args.hoverSweep,
  shot: null,
  // Carried so the post-settle parity dumps can stamp the conditions they were taken under (see --paint-dump).
  viewport: args.viewport,
  trace: args.trace,
  traceGpu: args.traceGpu,
  layers: args.layers,
  layerDetail: args.layerDetail,
  census: args.census,
  churnCensus: args.churnCensus,
  handParity: args.handParity,
  flightLiveness: args.flightLiveness,
  idle: args.idle,
  idleShots: args.idleShots,
  idleShotGapMs: args.idleShotGapMs,
  animAudit: args.animAudit,
  animAuditOut: args.animAuditOut,
  window: args.window,
  report: !!args.report,
  // --connect-cdp: the flag runOnce degrades on, and the ONE page every repeat reuses.
  connect: connectMode,
  connectPage
};
// Set below once `reportStem` exists; runOnce writes `<reportStem>-r<i>.png` per repeat for the presence guard.
opts.reportStem = null;

// --report must ship real `artifacts.trace` / `artifacts.screenshot` paths, so it mints defaults for both when
// the run did not ask for them explicitly. Both are repeat-#1-only evidence, exactly like --trace/--shot.
// R7 W1-I1g: --trace-gpu widens a capture that has to exist. On its own it is a silent no-op, which is worse
// than an error — the run would look like it collected GPU detail and the analyzer would report none.
if (args.traceGpu && !args.trace && !args.report) {
  console.error("--trace-gpu needs a capture to widen: pass --trace <file> (or --report).");
  process.exit(2);
}
const reportStem = args.report ? basename(args.report).replace(/\.json$/i, "") : null;
opts.reportStem = reportStem;
const explicitTrace = !!args.trace;
opts.traceRawFull = explicitTrace;
if (args.report) {
  if (!args.trace) args.trace = `${reportStem}-trace.json`;
  if (!args.shot && !args.noReportShot) {
    const shotDir = resolve(REPO_ROOT, ".sts2/bench/shots");
    mkdirSync(shotDir, { recursive: true });
    args.shot = resolve(shotDir, `${reportStem}.png`);
  }
  if (!assetServingEnabled) {
    console.error(
      "  WARN: --report without --res-root or --asset-cache-root. Every atlas 404s, so the page paints almost\n" +
        "        nothing and the decode/raster/paint numbers in the envelope describe a blank page. Pass --res-root."
    );
  }
}

// Warmup page load (discarded) so the dev server's first-request transform / cold module graph doesn't
// inflate repeat #1 — keeps repeat-to-repeat spread tight.
// R7 W1-I1d — /proc sampler over the LAUNCHED browser's whole process tree, started before the warmup so the
// peak covers page load (where the atlas decode burst lands) and not just the measured replay. Playwright does
// not hand out the browser's pid, but it launches the browser as a child of THIS process, so the ancestry walk
// rooted at our own pid reaches exactly the tree we own and nothing else on a shared box.
const procMemSampler = args.procMem ? startProcMemSampler(process.pid, 500) : null;

process.stdout.write("warmup... ");
try {
  await runOnce(context, pageUrl, {
    hoverSweep: false,
    trace: null,
    layers: false,
    layerDetail: false,
    census: false,
    connect: connectMode,
    connectPage
  });
  process.stdout.write("done\n");
} catch (e) {
  process.stdout.write(`warmup failed: ${e}\n`);
}

// R7 W1-I1b — a repeat that dies outright still has to leave a record. `runOnce` already returns a partial delta
// when the RENDERER dies mid-replay (probePage), so the only way through here is a death somewhere the page-side
// guard cannot reach: navigation, context creation, a browser that went away entirely. The record is the delta's
// shape with every measurement null — never a zero, which a median would happily average in as a real reading —
// so the summary code below traverses it unchanged and the surviving repeats still produce medians.
const crashedRunRecord = (reason) => ({
  wall: null,
  taskDuration: null,
  scriptDuration: null,
  layoutDuration: null,
  recalcStyleDuration: null,
  busyPct: null,
  nodesA: null,
  nodesB: null,
  blinkMemory: null,
  longTasks: null,
  tickMs: null,
  frameGaps: null,
  flightCanvases: null,
  pageViewport: null,
  window: null,
  walkStatsWindow: null,
  maxPace: null,
  sweepMoves: null,
  layers: null,
  census: null,
  churnCensus: null,
  walkStats: null,
  handParity: null,
  flightLiveness: null,
  droppedCardFlights: 0,
  idle: null,
  animAuditPath: null,
  animAuditCounts: null,
  revealBurst: null,
  tracePath: null,
  pageErrors: [String(reason)],
  pageErrorCount: 1,
  pageWarnings: [],
  pageWarningCount: 0,
  pageCrashed: true,
  pageCrashAtMs: null,
  crashReason: String(reason),
  responseErrors: [],
  report: null
});

const runs = [];
for (let i = 0; i < args.repeats; i++) {
  process.stdout.write(`repeat ${i + 1}/${args.repeats}... `);
  // The idle window + animation audit are captured on repeat #1 only (like --trace/--shot): they are evidence,
  // not a per-repeat measurement, and the idle hold would otherwise multiply the run's wall time.
  let r;
  try {
    r = await runOnce(context, pageUrl, {
      ...opts,
      repeatIndex: i,
      trace: i === 0 ? args.trace : null,
      shot: i === 0 ? (args.shot ?? null) : null,
      domStyles: i === 0 ? (args.domStyles ?? null) : null,
      paintDump: i === 0 ? (args.paintDump ?? null) : null,
      hitGrid: i === 0 ? (args.hitGrid ?? null) : null,
      hitGridStep: args.hitGridStep,
      raiseProbe: i === 0 ? (args.raiseProbe ?? null) : null,
      idle: i === 0 ? args.idle : null,
      idleShots: i === 0 ? args.idleShots : null,
      animAudit: i === 0 ? args.animAudit : false,
      // Evidence, not a per-repeat measurement — and it mutates the page, so repeat #1 only (like --shot).
      revealBurst: i === 0 && !!reveal,
      revealPayload: i === 0 && reveal ? { raw: reveal.raw, nodeId: reveal.info.nodeId } : null,
      revealInfo: reveal ? reveal.info : null,
      revealShot: i === 0 ? (args.revealShot ?? null) : null
    });
  } catch (e) {
    // The whole point of I1b: this used to be an unhandled rejection that ended the process, taking every cell
    // the matrix had not reached yet with it. Now it is one bad repeat.
    const reason = e?.message ?? String(e);
    r = crashedRunRecord(reason);
    process.stdout.write(`REPEAT DIED: ${reason}\n`);
  }
  runs.push(r);
  if (!r.crashReason) {
    process.stdout.write(
      `busy ${r.busyPct ?? "?"}%  task ${r.taskDuration ?? "?"}s  script ${r.scriptDuration ?? "?"}s  wall ${r.wall}s` +
        (r.pageCrashed ? "  PAGE CRASHED" : "") +
        (r.maxPace ? `  maxRate ${r.maxPace.hz ?? "?"}Hz (${r.maxPace.deltas} deltas / ${r.maxPace.spanMs}ms)` : "") +
        "\n"
    );
  }
}

const procMem = procMemSampler ? procMemSampler.stop() : null;

// Leave the operator's tab quiet: the last repeat's page is still replaying a stream and holding the mirror's
// canvases, which on a phone keeps burning battery long after the bench has printed its numbers.
if (connectMode && connectPage && !args.keepConnectedPage) {
  await connectPage.goto("about:blank", { waitUntil: "domcontentloaded" }).catch(() => {});
}
// On a CONNECTED browser this only disconnects the harness — it never closes someone else's browser. Called
// either way so the Playwright transport is always shut down.
await browser.close();
if (benchServer) await new Promise((ok) => benchServer.close(ok));

if (connectMode) {
  console.log(
    `  serve:      ${recordingHits} recording request(s) served from http://127.0.0.1:${args.servePort}/recording` +
      (recordingHits === 0
        ? "  — NOTHING FETCHED IT: the page never reached the bench server (adb reverse missing? wrong port?)"
        : "")
  );
}
if (assetServingEnabled) {
  console.log(
    `  res-root:   ${resHits} asset requests served from ${args.resRoot ?? DEFAULT_RES_ROOT}${args.assetCacheRoot ? ` + cache ${args.assetCacheRoot}` : ""}` +
      (resMisses.size > 0 ? `, ${resMisses.size} MISSING (e.g. ${[...resMisses].slice(0, 3).join(", ")})` : "")
  );
}

// Medians across repeats.
const field = (k) => median(runs.map((r) => r[k]).filter((v) => typeof v === "number"));
const medians = {
  busyPct: round(field("busyPct"), 1),
  taskDuration: round(field("taskDuration"), 4),
  scriptDuration: round(field("scriptDuration"), 4),
  layoutDuration: round(field("layoutDuration"), 4),
  recalcStyleDuration: round(field("recalcStyleDuration"), 4),
  wall: round(field("wall"), 3),
  nodes: round(field("nodesB"), 0),
  sweepMoves: args.hoverSweep ? round(field("sweepMoves"), 0) : null,
  // --pace=max only (null at recorded pace): the effective mirror rate, see maxPace in runOnce.
  maxRateHz: round(median(runs.map((r) => r.maxPace?.hz).filter((v) => typeof v === "number")), 2),
  // rAF-CALLBACK durations, medians across repeats (see tickSamplerInit for what this does and does not see).
  tickMs: {
    ...medianDistribution(runs, "tickMs", 2),
    count: medianField(runs, "tickMs.count", 0),
    totalMs: medianField(runs, "tickMs.totalMs", 1)
  },
  // FRAME cadence, medians across repeats (see summarizeFrameGaps). Every member is the median of that member,
  // like tickMs above — `dropped` is therefore the typical repeat's dropped-frame count, not a total.
  frameGaps: {
    frames: medianField(runs, "frameGaps.frames", 0),
    ...medianDistribution(runs, "frameGaps", 2),
    vsyncMs: medianField(runs, "frameGaps.vsyncMs", 2),
    rawP20: medianField(runs, "frameGaps.rawP20", 2),
    dropped: medianField(runs, "frameGaps.dropped", 0),
    droppedPct: medianField(runs, "frameGaps.droppedPct", 1)
  },
  sceneAckLatency: {
    ...medianDistribution(runs, "sceneAckLatency", 2),
    count: medianField(runs, "sceneAckLatency.count", 0)
  }
};

const spread = (k) => {
  const vals = runs.map((r) => r[k]).filter((v) => typeof v === "number");
  if (vals.length < 2) return null;
  const lo = Math.min(...vals), hi = Math.max(...vals), mid = median(vals);
  return mid ? round(((hi - lo) / mid) * 100, 1) : null;
};

// --connect-cdp: the tab's REAL size, taken from the page (the harness could not set one). Falls back to the
// --viewport string only when no repeat managed to read it, and says which it is via `viewportSource`.
const connectViewport = runs.find((r) => r.pageViewport)?.pageViewport ?? null;

const result = {
  config: {
    url: pageUrl,
    requestedUrl: requestedPageUrl,
    effectiveUrl: pageUrl,
    pace: args.pace,
    repeats: args.repeats,
    effects: args.effects,
    viewport:
      connectMode && connectViewport
        ? `${connectViewport.w}x${connectViewport.h}`
        : `${args.viewport.width}x${args.viewport.height}`,
    // Non-null only in connect mode: what the attached tab actually is. A phone number that silently used the
    // desktop default would be unreadable, so the source is stated rather than implied.
    viewportSource: connectMode ? (connectViewport ? "page" : "unknown") : "harness",
    // Connect mode: what the attached tab actually reported. Launch mode: what --dpr asked for, null when the
    // run took the host's own (1 on this box) — so a cell can never be mistaken for a device-scale cell.
    devicePixelRatio: connectViewport ? connectViewport.dpr : (args.dpr ?? null),
    connectCdp: args.connectCdp ?? null,
    servePort: connectMode ? args.servePort : null,
    assetCacheRoot: args.assetCacheRoot ?? null,
    cpuThrottle: CPU_THROTTLE,
    // Connect mode cannot throttle a browser it did not launch; say so instead of reporting the env var as if
    // it had been applied.
    cpuThrottleApplied: connectMode ? false : CPU_THROTTLE > 1,
    hoverSweep: args.hoverSweep,
    traceScope: traceWindowForOptions(args)?.phase ?? null
  },
  recording: {
    path: recordingPath,
    messages: recMeta.messages ?? null,
    bytes: recMeta.bytes ?? null,
    durationMs: recMeta.durationMs ?? null,
    recordedAt: recMeta.recordedAt ?? null
  },
  // --window only (null otherwise): the bracket every median above describes, as the PAGE saw it.
  window: runs.find((r) => r.window)?.window ?? null,
  medians,
  // R7 W1-I1a — renderer-process gauges, medians across repeats, plus every repeat's own pair. The per-repeat
  // list is the point of the block: a leak across repeats is a RISING sequence, and a median hides it.
  blinkMemory: {
    jsHeapUsedMbA: medianField(runs, "blinkMemory.jsHeapUsedMbA", 1),
    jsHeapUsedMbB: medianField(runs, "blinkMemory.jsHeapUsedMbB", 1),
    jsHeapGrowthMb: medianField(runs, "blinkMemory.jsHeapGrowthMb", 1),
    jsHeapTotalMbB: medianField(runs, "blinkMemory.jsHeapTotalMbB", 1),
    blinkNodesB: medianField(runs, "blinkMemory.blinkNodesB", 0),
    documentsB: medianField(runs, "blinkMemory.documentsB", 0),
    listenersB: medianField(runs, "blinkMemory.listenersB", 0)
  },
  perRepeatBlinkMemory: runs.map((r) => r.blinkMemory ?? null),
  busyPctSpreadPct: spread("busyPct"),
  taskSpreadPct: spread("taskDuration"),
  walkStats: runs[runs.length - 1]?.walkStats ?? null,
  // --window only: the same counters as `walkStats`, but as a DELTA across the bracket.
  walkStatsWindow: runs[runs.length - 1]?.walkStatsWindow ?? null,
  // FLIGHT-SUBTREE CANVAS CENSUS, median across repeats (see flightCanvasCensusInPage). Near-deterministic for a
  // given lever set, which is the point: `count: 0` is the MEASURED zero-canvas cell, not an inferred one.
  flightCanvases: {
    count: medianField(runs, "flightCanvases.count", 0),
    bytes: medianField(runs, "flightCanvases.bytes", 0),
    // R17: the `<img>` stand-ins gsw swapped in, and the spec-identity ceiling on how many distinct stills a
    // volley can need (see flightCanvasCensusInPage). `count` + `imgs` is the surface population either way.
    imgs: medianField(runs, "flightCanvases.imgs", 0),
    // Canvases nothing ever sized — claimed-still mounts (see flightCanvasCensusInPage). Excluded from `bytes`.
    defaultSized: medianField(runs, "flightCanvases.defaultSized", 0),
    specNodes: medianField(runs, "flightCanvases.specNodes", 0),
    distinctSpecs: medianField(runs, "flightCanvases.distinctSpecs", 0),
    pageTotal: medianField(runs, "flightCanvases.pageTotal", 0),
    // Page-wide canvases the gsw WebGPU backend stamped — the MEASURED adoption gauge (0 on WebGL fallback).
    pageWebgpu: medianField(runs, "flightCanvases.pageWebgpu", 0),
    // Separates "the subtree mounted no canvas" from "the subtree was never mounted" — different findings.
    roots: medianField(runs, "flightCanvases.roots", 0)
  },
  perRepeatFlightCanvases: runs.map((r) => r.flightCanvases ?? null),
  // Per-repeat, plus the two walk-classification counters that decide them — the round's primary A/B metric.
  perRepeatLongTasks: runs.map((r) => r.longTasks),
  // Per-repeat frame cadence: `medians.frameGaps` is medians of medians, and a volley that janks on one repeat
  // out of three has to stay visible.
  perRepeatFrameGaps: runs.map((r) => r.frameGaps ?? null),
  // First acknowledgement after each delivered scene delta. See fakeWebSocketInit for coalescing semantics.
  perRepeatSceneAckLatency: runs.map((r) => r.sceneAckLatency ?? null),
  perRepeatWalks: runs.map((r) =>
    r.walkStats
      ? {
          walks: r.walkStats.walks,
          fullWalks: r.walkStats.fullWalks,
          bails: r.walkStats.bails,
          incremental: r.walkStats.incrementalStructuralWalks,
          update: r.walkStats.updateWalks,
          totalWalkMs: round(r.walkStats.totalWalkMs, 1),
          // R10-PERF3 WS-4 (read defensively — absent on older builds): what each full walk was FOR, plus the
          // targeted texture re-styles that replaced the per-texture-load full re-touch.
          styledNodes: r.walkStats.styledNodes ?? null,
          textureRestyles: r.walkStats.textureRestyles ?? null,
          fullWalkCauses: r.walkStats.fullWalkCauses ?? null
        }
      : null
  ),
  layers: runs.find((r) => r.layers)?.layers ?? null,
  census: runs.find((r) => r.census)?.census ?? null,
  churnCensus: args.churnCensus ? summarizeChurn(runs) : null,
  perRepeatFlightLiveness: args.flightLiveness ? runs.map((r) => r.flightLiveness) : null,
  droppedCardFlights: runs[runs.length - 1]?.droppedCardFlights ?? 0,
  idle: runs.find((r) => r.idle)?.idle ?? null,
  animAuditPath: runs.find((r) => r.animAuditPath)?.animAuditPath ?? null,
  animAuditCounts: runs.find((r) => r.animAuditCounts)?.animAuditCounts ?? null,
  revealBurst: runs.find((r) => r.revealBurst)?.revealBurst ?? null,
  tracePath: runs.find((r) => r.tracePath)?.tracePath ?? null,
  // R7 W1-I1b — which repeats died and how far in. An empty array is the ordinary healthy run, and is what makes
  // "this cell survived" a POSITIVE reading rather than the absence of a complaint.
  crashedRepeats: runs
    .map((r, i) =>
      r.pageCrashed ? { repeat: i + 1, atMs: r.pageCrashAtMs ?? null, reason: r.crashReason ?? "renderer crashed" } : null
    )
    .filter(Boolean),
  // R7 W1-I1f — failed requests summed across repeats, still deduped by (status, pathname).
  responseErrors: mergeResponseErrors(runs),
  // R7 W1-I1d — per-process VmRSS of the launched Chrome tree (null in connect mode and off without --proc-mem).
  // READ THE HONESTY LIMIT in scripts/lib/proc-mem.mjs before quoting `gpu`: VmRSS is a LOWER BOUND on what a GPU
  // process costs, because driver and kernel allocations largely are not resident in its own address space. A
  // rising number is evidence; a flat one is not evidence of absence.
  procMem: procMem
    ? {
        // THE SETTLED READING IS `lastLive`, not `last`. runOnce closes its page before the sampler stops, so
        // `last` is taken after the renderer has exited — the first version of this reported that and made a
        // 620MB renderer read as 66MB. `last` is kept only so the two can be told apart.
        lastLiveMb: procMem.lastLive
          ? {
              browser: procMemMb(procMem.lastLive.browser.bytes),
              gpu: procMemMb(procMem.lastLive.gpu.bytes),
              renderers: procMemMb(procMem.lastLive.renderers.bytes),
              utility: procMemMb(procMem.lastLive.utility.bytes),
              other: procMemMb(procMem.lastLive.other.bytes),
              total: procMemMb(procMem.lastLive.totalBytes)
            }
          : null,
        afterTeardownMb: procMem.last ? procMemMb(procMem.last.totalBytes) : null,
        // Per bucket, each taken independently: the GPU process and the renderers reach their worst moments at
        // different times (texture upload vs. atlas decode), so one shared peak would hide whichever came second.
        peakMb: {
          browser: procMemMb(procMem.peak.browser),
          gpu: procMemMb(procMem.peak.gpu),
          renderers: procMemMb(procMem.peak.renderers),
          utility: procMemMb(procMem.peak.utility),
          other: procMemMb(procMem.peak.other),
          total: procMemMb(procMem.peak.total)
        },
        rendererCount: procMem.lastLive?.renderers.count ?? null,
        samples: procMem.samples
      }
    : null,
  perRepeat: runs.map((r) => ({ busyPct: r.busyPct, taskDuration: r.taskDuration, wall: r.wall }))
};

console.log("");
console.log("=== medians ===");
if (result.window) {
  const w = result.window;
  console.log(
    `  window:              recording ${w.startMs}..${w.endMs}ms` +
      (w.spanMs != null ? `  (page saw ${w.spanMs}ms` : "  (span unknown") +
      (Array.isArray(w.streamMs) ? `, crossed at stream ${w.streamMs[0]}/${w.streamMs[1]}ms)` : ")") +
      "   every number below is THIS bracket, not the whole stream"
  );
}
console.log(`  busy%:               ${medians.busyPct}%  (spread ${result.busyPctSpreadPct ?? "?"}%)`);
console.log(`  TaskDuration:        ${medians.taskDuration}s`);
console.log(`  ScriptDuration:      ${medians.scriptDuration}s`);
console.log(`  LayoutDuration:      ${medians.layoutDuration}s`);
console.log(`  RecalcStyleDuration: ${medians.recalcStyleDuration ?? "n/a"}s`);
console.log(`  wall:                ${medians.wall}s`);
console.log(`  nodes:               ${medians.nodes}`);
{
  // R7 W1-I1a. RENDERER process only — the JS heap and Blink's own object counts. It is NOT the whole renderer
  // RSS and it is emphatically not the GPU process, which is where round 7's kills happened; --proc-mem is the
  // instrument for those. Printed here so a cell that dies still leaves its last heap reading in the log.
  const bm = result.blinkMemory;
  console.log(
    `  JS heap:             ${bm.jsHeapUsedMbA ?? "?"} -> ${bm.jsHeapUsedMbB ?? "?"}MB used ` +
      `(growth ${bm.jsHeapGrowthMb ?? "?"}MB, total ${bm.jsHeapTotalMbB ?? "?"}MB)`
  );
  console.log(
    `  blink objects:       ${bm.blinkNodesB ?? "?"} nodes, ${bm.documentsB ?? "?"} documents, ` +
      `${bm.listenersB ?? "?"} listeners` +
      (result.perRepeatBlinkMemory.length > 1
        ? `   per-repeat heap: ${result.perRepeatBlinkMemory.map((m) => m?.jsHeapUsedMbB ?? "?").join(" -> ")}MB`
        : "")
  );
}
if (args.hoverSweep) console.log(`  hover moves:         ${medians.sweepMoves}`);
console.log(`  walkStats:           ${result.walkStats ? JSON.stringify(result.walkStats) : "n/a"}`);
{
  const lt = result.perRepeatLongTasks.filter(Boolean);
  const medCount = median(lt.map((t) => t.count));
  const medTotal = median(lt.map((t) => t.totalMs));
  console.log(
    `  long tasks (>=50ms): median ${medCount ?? "?"} per run, ${medTotal ?? "?"}ms total` +
      `   per-repeat: ${lt.map((t) => `${t.count}/${t.ge100}≥100 max${t.maxMs}`).join("  |  ") || "n/a"}`
  );
  // rAF-callback duration. Deliberately printed next to the long tasks: a p95 here that is far BELOW the long
  // tasks' floor says the janks are not being assembled out of the mirror's own callbacks.
  const tk = medians.tickMs;
  if (tk && tk.count) {
    console.log(
      `  rAF tick ms:         p50 ${tk.p50 ?? "?"}  p95 ${tk.p95 ?? "?"}  max ${tk.max ?? "?"}` +
        `   (${tk.count} callbacks, ${tk.totalMs}ms total)   CALLBACK time, not frame time — see --help`
    );
  }
  // FRAME cadence — the closest thing here to what a person sees, and the one headline that survives connect
  // mode. Printed right under the callback line it is so easily confused with.
  const fg = medians.frameGaps;
  if (fg && fg.frames) {
    console.log(
      `  frame gaps ms:       p50 ${fg.p50 ?? "?"}  p95 ${fg.p95 ?? "?"}  max ${fg.max ?? "?"}` +
        `   vsync ${fg.vsyncMs ?? "?"}ms (raw p20 ${fg.rawP20 ?? "?"})` +
        `   ${fg.frames} frames, ${fg.dropped ?? "?"} dropped (${fg.droppedPct ?? "?"}%)`
    );
    // rAF only fires while the page is animating AND the tab is visible, so `frames` alone cannot tell a page
    // that DROPPED its frames from one that was never asked to draw any. The discriminator is whether the
    // observed gaps ACCOUNT for the window: a dropped frame still lands inside a gap and is counted in
    // `dropped`, so frames+dropped ~ windowSpan/vsync on a merely janky page, and falls far short only when the
    // sampler itself was starved — the BACKGROUNDED-tab symptom (which is why connect mode drives the ACTIVE
    // tab). Warning on `frames` alone would fire on every run this metric exists to describe.
    const spanMs = result.window?.spanMs ?? (medians.wall != null ? medians.wall * 1000 : null);
    if (spanMs && fg.vsyncMs) {
      const expected = spanMs / fg.vsyncMs;
      const accounted = (fg.frames ?? 0) + (fg.dropped ?? 0);
      if (accounted < expected * 0.5) {
        console.log(
          `  WARN: the frame record covers only ~${Math.round(accounted)} of the ~${Math.round(expected)} display frames a ` +
            `${Math.round(spanMs)}ms window holds at ${fg.vsyncMs}ms — rAF was NOT SCHEDULED for much of it ` +
            "(backgrounded tab? page idle with no animation?). These gaps describe the animating stretches only, " +
            "not the window's frame rate."
        );
      }
    }
  } else {
    console.log("  frame gaps ms:       n/a (no animation frames were sampled in the window)");
  }
  const ack = medians.sceneAckLatency;
  if (ack?.count) {
    console.log(
      `  scene ack ms:        p50 ${ack.p50 ?? "?"}  p95 ${ack.p95 ?? "?"}  max ${ack.max ?? "?"}` +
        `   (${ack.count} delivered delta(s), first subsequent ack)`
    );
  } else {
    console.log("  scene ack ms:        n/a (no scene delta was acknowledged in the measured window)");
  }
  const pw = result.perRepeatWalks.filter(Boolean);
  if (pw.length) {
    console.log(
      `  walk classification: per-repeat full/bail/incr/upd + ms: ` +
        pw.map((w) => `${w.fullWalks}/${w.bails}/${w.incremental}/${w.update} ${w.totalWalkMs}ms`).join("  |  ")
    );
    if (pw.some((w) => w.styledNodes != null)) {
      console.log(
        `  styled nodes:        per-repeat: ` +
          pw.map((w) => `${w.styledNodes ?? "?"} (tex re-styles ${w.textureRestyles ?? "?"})`).join("  |  ")
      );
    }
    if (pw.some((w) => w.fullWalkCauses)) {
      console.log(
        `  full-walk causes:    per-repeat: ` +
          pw
            .map((w) =>
              w.fullWalkCauses
                ? Object.entries(w.fullWalkCauses)
                    .filter(([, n]) => n > 0)
                    .map(([k, n]) => `${k}×${n}`)
                    .join(",") || "none"
                : "n/a"
            )
            .join("  |  ")
      );
    }
  }
  // --window: the same counters as a DELTA over the bracket, which is the only form that answers "what did the
  // shuffle cost" — the cumulative line above carries the whole page load with it.
  if (result.walkStatsWindow) {
    const w = result.walkStatsWindow;
    console.log(
      `  walks IN WINDOW:     walks ${w.walks ?? "?"} (full ${w.fullWalks ?? "?"}, bail ${w.bails ?? "?"}, ` +
        `incr ${w.incrementalStructuralWalks ?? "?"}, upd ${w.updateWalks ?? "?"})  ${w.totalWalkMs ?? "?"}ms` +
        (w.styledNodes != null ? `  styled ${w.styledNodes}` : "") +
        (w.createEl != null ? `  createEl ${w.createEl}` : "")
    );
    if (w.fullWalkCauses) {
      const causes = Object.entries(w.fullWalkCauses).filter(([, n]) => n > 0);
      console.log(`    full-walk causes:  ${causes.map(([k, n]) => `${k}×${n}`).join(",") || "none"}`);
    }
  }
}
{
  // FLIGHT-SUBTREE CANVASES, read once the window closed (see flightCanvasCensusInPage). MB is the backing
  // store, which is what the GPU process actually holds.
  const fc = result.flightCanvases;
  if (fc && fc.pageTotal != null) {
    console.log(
      `  flight canvases:     ${fc.count ?? "?"} in ${fc.roots ?? "?"} flight subtrees` +
        `   ${round((fc.bytes ?? 0) / (1024 * 1024), 2)}MB backing store   (page total ${fc.pageTotal ?? "?"} canvases)`
    );
  }
}
if (result.layers) {
  console.log(`  layers:              ${result.layers.count}${result.layers.drawing != null ? ` (${result.layers.drawing} drawing)` : ""}`);
  const rs = result.layers.reasons ? Object.entries(result.layers.reasons).sort((a, b) => b[1] - a[1]) : [];
  if (rs.length) console.log(`  layer reasons:       ${rs.map(([k, v]) => `${k}×${v}`).join(", ")}`);
  if (result.layers.rows) {
    console.log("  layer detail (compositor order = paint order):");
    console.log("    ord  size            Mpx paints draws  reasons                                  element");
    for (const r of result.layers.rows) {
      console.log(
        `    ${String(r.order).padStart(3)} ${String(r.width).padStart(5)}x${String(r.height).padEnd(5)}` +
        ` ${r.mpx.toFixed(2).padStart(7)} ${String(r.paintCount).padStart(5)} ${(r.drawsContent ? "yes" : "no").padEnd(6)}` +
        ` ${r.reasons.join("+").padEnd(40)} ${r.element}`
      );
    }
  }
}
if (args.handParity) {
  // One line per repeat's aggregate, then the worst offenders of the LAST repeat. Drift is measured at the settle
  // as (game's streamed pose − the endpoint the client's tween ended on), in design px, so 0.00 everywhere is the
  // pass condition: the card stops exactly where the game says it is and nothing jumps afterwards.
  const perRun = runs.map((r) => r.handParity).filter(Boolean);
  if (perRun.length === 0) {
    console.log("  hand parity:         n/a (gauge absent — is the page built with the ?handParity=1 support?)");
  } else {
    console.log(
      `  hand parity:         per-repeat settles/drifted/maxPx: ` +
        perRun.map((p) => `${p.settles}/${p.drifted}/${round(p.maxDriftPx, 2)}`).join("  |  ")
    );
    const last = perRun[perRun.length - 1];
    const settleEntries = last.entries.filter((e) => e.kind !== "post-settle");
    const drifted = settleEntries.filter((e) => e.streamed != null && e.streamed !== e.settled);
    const meanPx = drifted.length ? drifted.reduce((s, e) => s + e.distPx, 0) / drifted.length : 0;
    console.log(
      `    last repeat:       ${last.settles} settles, ${last.drifted} drifted (${last.settles ? round((last.drifted / last.settles) * 100, 1) : 0}%), ` +
        `mean ${round(meanPx, 2)}px, max ${round(last.maxDriftPx, 2)}px` +
        (last.dropped ? `, ${last.dropped} entries dropped past the cap` : "")
    );
    for (const e of drifted.sort((a, b) => b.distPx - a.distPx).slice(0, 12)) {
      console.log(
        `      ${round(e.distPx, 2).toString().padStart(8)}px  d=(${round(e.dx, 2)}, ${round(e.dy, 2)})` +
          `  ${(e.path || e.id).split("/").slice(-3).join("/")}`
      );
    }
    // THE POST-SETTLE HALF. A settle the producer never contradicted (it suppressed the node for the whole window)
    // scores 0 drift above no matter how wrong the endpoint was; the contradiction shows up as the FIRST streamed
    // pose after the window, which is the jump you actually see. `postSettles` counts the settles whose watch caught
    // such a pose at all, `snapped` how many of those disagreed with where the element was left.
    if (perRun.some((p) => p.postSettles != null)) {
      console.log(
        `    post-settle:       per-repeat watched/snapped/maxPx: ` +
          perRun.map((p) => `${p.postSettles ?? 0}/${p.snapped ?? 0}/${round(p.maxSnapPx ?? 0, 2)}`).join("  |  ")
      );
      const snaps = last.entries.filter((e) => e.kind === "post-settle");
      for (const e of snaps.sort((a, b) => b.distPx - a.distPx).slice(0, 12)) {
        console.log(
          `      ${round(e.distPx, 2).toString().padStart(8)}px  d=(${round(e.dx, 2)}, ${round(e.dy, 2)})  [post-settle]` +
            `  ${(e.path || e.id).split("/").slice(-3).join("/")}`
        );
      }
    }
  }
}
// --flight-liveness. Two numbers, one threshold each, printed beside the CPU medians on purpose: a stuck
// producer gate makes the shuffle CHEAPER on this page while making it worse on screen, so the busy% above is
// exactly the metric that would sign off on the regression.
let flightLivenessFailed = false;
if (args.flightLiveness) {
  const per = (result.perRepeatFlightLiveness ?? []).filter(Boolean);
  console.log("  flight liveness:");
  if (result.droppedCardFlights) {
    console.log(`    wire:              --drop-card-flights stripped cardFlights[] from ${result.droppedCardFlights} deliveries`);
  }
  if (args.ackPacedMs !== null) {
    console.log(`    wire:              --ack-paced ${args.ackPacedMs}ms after each scene-ack (credit-gated, --pace max)`);
    // Read this before believing a FAIL on an ack-paced run. Ack-pacing STRETCHES the recorded stream (8.8Hz
    // where it was recorded at ~29Hz) while the client's flight windows keep running on REAL time — so a
    // suppression window that covered the whole shuffle when it was recorded now expires while the stretched
    // stream is still mid-shuffle, and the cards correctly fall back to streamed poses at the wire's rate.
    // That is the pacing, not the client. Use --ack-paced to OBSERVE the streamed cadence; gate on
    // --pace recorded (optionally --window), where recorded time and wall time are the same clock.
    console.log("    note:              a stretched replay expires flight windows mid-shuffle — read the numbers,");
    console.log("                       don't gate on them here (gate with --pace recorded; see the bench doc)");
  }
  if (per.length === 0) {
    console.log("    n/a (sampler absent)");
    flightLivenessFailed = true;
  } else {
    for (const [i, f] of per.entries()) {
      console.log(
        `    repeat ${i + 1}:          ${f.flights} flights of ${f.elements} elements` +
          `   maxStill ${f.maxStillMs ?? "n/a"}ms (median ${f.medianStillMs ?? "n/a"}ms)` +
          `   distinct positions median ${f.medianDistinctPositions ?? "n/a"} / min ${f.minDistinctPositions ?? "n/a"}` +
          `   [${f.samples} samples, ${f.movedSamples} with motion, peak ${f.peakElements} els]`
      );
    }
    // Every repeat must pass: one stalled replay in three is still a stalled replay.
    for (const [i, f] of per.entries()) {
      const why = [];
      if (f.flights === 0) why.push("no flight VFX element ever moved (nothing to measure)");
      if (f.maxStillMs !== null && f.maxStillMs >= args.flightStillMs) {
        why.push(`maxStillMs ${f.maxStillMs} >= ${args.flightStillMs}`);
      }
      if (f.medianDistinctPositions !== null && f.medianDistinctPositions < FLIGHT_MIN_DISTINCT) {
        why.push(`median distinctPositions ${f.medianDistinctPositions} < ${FLIGHT_MIN_DISTINCT}`);
      }
      if (why.length) {
        flightLivenessFailed = true;
        console.log(`    FAIL repeat ${i + 1}:     ${why.join("; ")}`);
        for (const w of f.worst ?? []) {
          console.log(`      node ${w.id}: stalled ${w.maxGapMs}ms, ${w.distinct} distinct positions`);
        }
      }
    }
    if (!flightLivenessFailed) {
      console.log(`    PASS               every flight kept moving (maxStillMs < ${args.flightStillMs}ms on all repeats)`);
    }
  }
}
// R14 — discard-liveness gate. `--flight-liveness` samples ONLY `[data-node-type$="NCardFlyShuffleVfx"]`
// elements (see flightLivenessInit above), which is the shuffle flier — a throwaway node that pops out of
// existence at the far pile. A "discard" flight (the hand→discard fly a played card takes) moves the REAL
// `NCard` the player was holding instead, so it never touches that selector and a stuck discard producer gate
// would sail straight through the liveness assertion above while a card visibly freezes mid-play.
//
// Rather than add a second element sampler — which the round's brief explicitly rejects: an `NCard` is the
// same element the reconciler restyles every walk, so polling ITS computed transform 30x/s would perturb the
// very main-thread cost this bench measures — this reuses the counter the renderer already exposes for exactly
// this purpose: `walkStats.discardFlightsArmed` only increments when `applyCardFlights` arms a hint whose
// `kind === "discard"` (mirrorRenderer.ts), so "the card never moved" and "the card was never even armed" are
// the same failure from this counter's point of view, which is the stuck-producer-gate symptom this gate exists
// to catch. The gate is only MEANINGFUL when the recording actually carries a discard hint (the pre-scan above,
// `discardHintCount`) and only ACTIVE when `--flight-liveness` asked for liveness checking at all; it is
// necessarily blind under `--drop-card-flights` (no cardFlights[] reaches the client, so nothing can arm) —
// that arm exists to reproduce a stuck producer gate deliberately, and is covered by the existing liveness
// assertion above instead.
let discardGateFailed = false;
if (args.flightLiveness) {
  console.log("  discard flight gate:");
  if (args.dropCardFlights) {
    console.log("    SKIP               --drop-card-flights strips cardFlights[] from the wire — nothing can arm");
  } else if (!hasDiscardHints) {
    console.log("    SKIP               recording carries no discard-kind cardFlights[] hints");
  } else {
    // CUMULATIVE `walkStats.discardFlightsArmed`, not the windowed delta (`walkStatsWindow`). Every repeat is a
    // fresh page, so the counter's true "before" is always 0 — reading it at the point runOnce takes its "b"
    // snapshot (window CLOSE for a windowed run, full-settle otherwise) already IS "the increase across the
    // replay window" the round asked for, with no extra diffing needed.
    //
    // This is not just simpler: a windowed DELTA is actively wrong near the window's open edge. `applyCardFlights`
    // arms a hint during the next reconcile walk, not synchronously with delivery, but on a congested page a
    // delayed `tick()` can bundle "cross the window-open mark" and "deliver + walk + arm a hint recorded a few ms
    // before that mark" into the SAME synchronous turn — Playwright's `waitForFunction` (and this harness's
    // subsequent `walkStatsAtOpen` read) cannot observe the mark flip any earlier than that turn's end, so the
    // "before" snapshot already carries the arm and the delta reads 0. Measured on `r13-reshuffle-30.ndjson
    // --window 2950:7200` (whose 5 discard hints are recorded at t=2947.8, ~2ms before the window opens):
    // `walkStatsWindow.discardFlightsArmed` was 0 on 5/5 repeats while the cumulative counter correctly read 5.
    const armedPerRepeat = runs.map((r) => r.walkStats?.discardFlightsArmed ?? null);
    for (const [i, armed] of armedPerRepeat.entries()) {
      console.log(`    repeat ${i + 1}:          discardFlightsArmed ${armed ?? "n/a"} (cumulative since page load)`);
      if (!(armed > 0)) discardGateFailed = true;
    }
    if (discardGateFailed) {
      console.log(
        `    FAIL               discardFlightsArmed did not increase on every repeat` +
          ` (recording carries ${discardHintCount} discard hint(s))`
      );
    } else {
      console.log(
        `    PASS               discardFlightsArmed increased on every repeat` +
          ` (recording carries ${discardHintCount} discard hint(s))`
      );
    }
  }
}
if (args.churnCensus) {
  const ch = result.churnCensus;
  if (!ch) {
    console.log("  churn census:        n/a (no walks sampled — did the renderer publish __mirrorWalkStats?)");
  } else {
    const m = ch.medians;
    console.log(
      `  churn census:        createEl ${m.createEl}  adoptions ${m.adoptions}  condemnedSwept ${m.condemnedSwept}` +
        `  removedRecords ${m.removedRecords}   (${m.walks} walks, ${m.walkMs}ms — medians, in-window)`
    );
    console.log(
      `    outside walks:     ${m.betweenCreateEl} createEl built BETWEEN walks (idle hatchery / reveal drains) —` +
        ` not walk cost, not in the peak`
    );
    if (ch.peak) {
      const p = ch.peak;
      console.log(
        `    peak createEl:     ${p.createEl} in ONE walk` +
          `  (walk #${p.walk}, ${p.mode}, walkMs ${p.walkMs}, t=${p.tMs}ms)`
      );
    }
    console.log(`    per-repeat peaks:  ${ch.peakPerRepeat.map((v) => (v == null ? "?" : v)).join(" | ")}`);
    if (ch.firstBuild) {
      const f = ch.firstBuild;
      console.log(
        `    keyframe build:    ${f.createEl} createEl in walk #${f.walk} (${f.mode}, walkMs ${f.walkMs})` +
          `  — PRE-window page load, excluded from the totals above`
      );
    }
    if (ch.top && ch.top.length) {
      console.log("    top walks by createEl (worst repeat):");
      console.log("      walk  mode          createEl  betwn  adopt  swept  removed   walkMs     t(ms)");
      for (const r of ch.top) {
        console.log(
          `      ${String(r.walk).padStart(4)}  ${r.mode.padEnd(12)}  ${String(r.createEl).padStart(8)}` +
            ` ${String(r.betweenCreateEl).padStart(6)} ${String(r.adoptions).padStart(6)} ${String(r.condemnedSwept).padStart(6)}` +
            ` ${String(r.removedRecords).padStart(8)} ${r.walkMs.toFixed(2).padStart(8)} ${String(r.tMs).padStart(9)}`
        );
      }
    }
    if (ch.overflow) {
      console.log(`    NOTE: ${ch.overflow} walk(s) past the ${ch.cap ?? "?"}-sample cap were counted but not recorded`);
    }
    console.log("CHURN_CENSUS " + JSON.stringify(ch));
  }
}
if (result.census) {
  const cx = result.census;
  const d = cx.dom ?? {};
  console.log("  census (post-settle):");
  console.log(`    offscreen leaves:  ${d.offscreenLeaves ?? "?"}/${d.boxedLeaves ?? "?"} boxed (${d.offscreenPct ?? "?"}%) @ ${d.viewport ? d.viewport.w + "x" + d.viewport.h : "?"} +${d.viewport ? d.viewport.margin : "?"}px`);
  console.log(`    elements:          ${d.mirrorNodes ?? "?"} mirror-nodes, ${d.totalElements ?? "?"} els, ${d.ninePatchSlices ?? "?"} 9-patch slices, ${d.canvases ?? "?"} canvases, ${d.tintFilterEls ?? "?"} mtint filters`);
  if (cx.canvasStats) {
    const q = cx.canvasStats;
    console.log(
      `    canvas stage:      ${q.frames} frames (${q.animFrames} anim), ${q.commands} cmds, ${q.quads} quads, ` +
        `${q.batches} batches, ${q.textureBinds} binds, build p50 ${q.buildMsP50}ms, paint p50 ${q.paintMsP50}ms` +
        // THE THIRD PHASE. A frame here is build + overlay reconcile + GL execute, and the middle one used to be
        // invisible in every bench line we print — which is why "the DOM overlay dominates map scroll" stayed a
        // theory for a whole round. Printed beside its two siblings so the three can be read as a sum.
        (q.overlayMsP50 != null ? `, overlay p50 ${q.overlayMsP50}ms` : "") +
        // M3's two arm modes. A wakeup is either the next display frame (a tween wants one) or a slept deadline
        // (a spine clip's next frame, an effect surface's capped one) — this is which, and how many elapsed.
        (q.schedule ? `, arms ${q.schedule.rafs} raf / ${q.schedule.parks} park (${q.schedule.parkWakeups} woke)` : "")
    );
    console.log(
      `    canvas nodes:      ${q.canvasNodes} drawn / ${q.overlayNodes} overlay / ${q.skipped} skipped of ${q.nodes}` +
        `   overlay ${JSON.stringify(q.overlayCounts)}` +
        // THE HOIST RULE'S WORST BUILD, not its last one. A settled screen has no live effects on EITHER arm, so
        // `overlayCounts.withheld` read post-settle is the same number whether M2's wiring works or is dead;
        // the peak is what actually moves when the draw list starts painting the covered surfaces.
        (q.overlayWithheldPeak != null ? `   withheldPeak ${q.overlayWithheldPeak}` : "")
    );
    console.log(
      `    canvas textures:   ${q.textures.referenced} referenced, ${q.textures.resident} resident, ` +
        `${q.textures.pending} pending, ${q.textures.failed} failed, ${q.textures.deferredQuads} deferred quads, ` +
        `${Math.round((q.textures.bytes / 1048576) * 10) / 10}MB` +
        `, ${q.textures.uploadMs}ms upload (max ${q.textures.maxUploadMs}ms, worst build ` +
        `${q.textures.maxBuildUploadMs}ms)`
    );
    // THE RUNTIME ATLAS RE-PACKER. A missing diagnostic block is printed rather than skipped; `avoided` is the
    // claim — page bytes that were never uploaded because crops served every quad.
    if (q.textures.repack === null || q.textures.repack === undefined) {
      console.log(`    canvas repack:     not reported`);
    } else {
      const rp = q.textures.repack;
      console.log(
        `    canvas repack:     ${rp.regions} regions (${rp.resident} resident, ` +
          `${Math.round((rp.bytes / 1048576) * 10) / 10}MB of ${Math.round(rp.maxBytes / 1048576)}MB) over ` +
          `${rp.pages} pages, avoided ${Math.round((q.textures.pageBytesAvoided / 1048576) * 10) / 10}MB on ` +
          `${q.textures.repackServed} pages`
      );
      console.log(
        `    canvas repack cost:${rp.crops} crops (${Math.round(rp.cropMs * 10) / 10}ms), ` +
          `evicted ${rp.evicted}, declined ${rp.declined}, refusedPages ${rp.refusedPages}, ` +
          `pageFallbacks ${q.textures.pageFallbacks}, predicate ` +
          `${Math.round((rp.thresholdPixels / 1_000_000) * 10) / 10}MP`
      );
    }
    // EFFECT SURFACES. A missing diagnostic block is distinct from an active renderer that found no surfaces, so
    // it is printed rather than skipped.
    //
    // `uploadMs` IS SUBMIT TIME, NOT GPU TIME. `texImage2D(canvas)` records a pending copy and returns; a reader
    // who quotes these as the GPU's upload cost is off by roughly 30x. Labelled in the line so a number copied
    // out of a terminal carries its own caveat.
    if (q.fx === null) {
      console.log(`    canvas fx:         not reported`);
    } else if (q.fx) {
      const f = q.fx;
      console.log(
        `    canvas fx:         ${f.surfaces} surfaces, ${f.resident} resident, ${f.dirty} dirty, ` +
          `${Math.round((f.bytes / 1048576) * 10) / 10}MB of ${Math.round((f.paceBytes / 1048576) * 10) / 10}MB/build` +
          `  quads ${f.quads} now / ${f.maxQuads} max / ${f.totalQuads} total` +
          // The stage wakeup cap, not gsw's render rate. Zero means uncapped.
          (f.fps != null ? (f.fps > 0 ? `, wakeup cap ${f.fps}fps` : ", wakeup uncapped") : "")
      );
      console.log(
        `    canvas fx cost:    ${f.uploads} uploads (${f.uploadMs}ms submit, max ${f.maxUploadMs}ms, ` +
          `worst build ${f.maxBuildUploadMs}ms), cache ${f.cacheUploads} uploads / ${f.cacheRespecs} respecs, ` +
          `deferred ${f.deferred}, declined ${f.declined}, evicted ${f.evicted}, released ${f.released}, ` +
          `oversized ${f.oversized}, screenTexture ${f.screenTexture}`
      );
    }
    // SPINE STILLS AS QUADS. A missing diagnostic block is reported explicitly.
    //
    // `hoisted` is the row to read against `quads`: it counts creatures the game paints OVER that are STILL
    // riding the DOM overlay — a clip that has not decoded, a still the residency ceiling refused, or the one-build
    // decision lag. It measures how much of the depth defect remains rather than a pass/fail.
    if (q.spine === null) {
      console.log(`    canvas spine:      not reported`);
    } else if (q.spine) {
      const s = q.spine;
      console.log(
        `    canvas spine:      ${s.surfaces} clips, ${s.resident} resident, ` +
          `${Math.round((s.bytes / 1048576) * 10) / 10}MB of ${Math.round((s.paceBytes / 1048576) * 10) / 10}MB` +
          `  quads ${s.quads} now / ${s.maxQuads} max, still hoisted ${s.hoisted}` +
          `   ${s.uploads} uploads (${s.uploadMs}ms submit), paced ${s.paced}, ` +
          `refusedForBudget ${s.refusedForBudget}, declined ${s.declined}, evicted ${s.evicted}`
      );
    }
    // TIER-3 PATCHING, and the idle family it shares a decision with.
    //
    // A missing diagnostic block is reported explicitly. The two rows are meant to be read TOGETHER and against
    // each other:
    //
    //   `patch frames` vs `anim` — how many animated frames were answered without a walk at all.
    //   `idle rebuilds` vs `patched` — of the frames a local anim MOVED a pose on, how many still cost a build.
    //     `bailouts.localAnim` is the same number said from the other side. The transform counter records the
    //     patched portion directly.
    //   `bailouts` — every frame that rebuilt, under the reason it did. Printed non-zero-only so the interesting
    //     buckets are not buried in twenty zeroes; `source`, `localAnim` and `spread` are the R7 additions and
    //     each names a DIFFERENT missing capability, which is the entire point of having split them.
    //
    // `verify` is the gate arm's own row: `mismatches` is what must be 0, `stale`/`unstable` are the frames it
    // excluded and said why, `worstRel` is the largest float32 disagreement seen even below the threshold.
    if (q.patch === null || q.patch === undefined) {
      console.log(`    canvas tier3:      not reported`);
    } else {
      const p = q.patch;
      const bails = Object.entries(p.bailouts ?? {})
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k} ${n}`)
        .join(", ");
      console.log(
        `    canvas tier3:      mode ${p.mode}, ${p.frames} patched frames, ${p.quads} quads, ${p.nodes} nodes, ` +
          `chainMax ${p.chainMax}` +
          (q.patchMsP50 != null ? `, patch p50 ${q.patchMsP50}ms` : "")
      );
      if (p.transform) {
        const t = p.transform;
        console.log(
          `    canvas tier3 xform:${t.frames} frames, ${t.roots} roots, ${t.commands} cmds, ` +
            `${t.records} records, ${t.hits} hits, chainMax ${t.chainMax}`
        );
      } else {
        console.log(`    canvas tier3 xform:not reported`);
      }
      console.log(`    canvas tier3 bails:${bails || "(none)"}`);
      if (p.verify) {
        const v = p.verify;
        console.log(
          `    canvas tier3 verify:${v.frames} verified, MISMATCHES ${v.mismatches} over ${v.mismatchFrames} frames, ` +
            `stale ${v.stale}, unstable ${v.unstable}, worstRel ${v.worstRel}`
        );
        for (const sample of v.samples ?? []) {
          console.log(`                       ! ${sample}`);
        }
      }
    }
    if (q.idle === null || q.idle === undefined) {
      console.log(`    canvas idle:       not reported`);
    } else {
      const i = q.idle;
      console.log(
        `    canvas idle:       ${i.plans} plans (${i.transformLoops} transform / ${i.alphaLoops} alpha), ` +
          `${i.frames} sampled frames, ${i.rebuilds} moved, ${i.patched ?? 0} of those PATCHED, ` +
          `cap ${i.fpsCap}fps, invisible ${i.invisible}`
      );
    }
  }
  if (d.elementsHiddenAncestry != null) {
    console.log(
      `    ancestry split:    ${d.elementsVisibleAncestry} visible / ${d.elementsHiddenAncestry} hidden of ${d.elements} stage els (${d.hiddenPct}% hidden)` +
        `   mirror-nodes ${d.mirrorNodesVisibleAncestry} visible / ${d.mirrorNodesHiddenAncestry} hidden`
    );
    console.log(
      `    hidden subtrees:   ${d.hiddenSubtreeRoots} roots — top: ` +
        (d.hiddenSubtreeRootsTop ?? [])
          .slice(0, 5)
          .map((r) => `${(r.nodePath ?? r.nodeId ?? r.tag).split("/").at(-1)}×${r.elements}`)
          .join(", ")
    );
    if (d.dormant && Object.values(d.dormant).some((v) => v != null)) {
      console.log(
        `    dormancy:          roots ${d.dormant.dormantRoots ?? "n/a"}, skippedBuilds ${d.dormant.dormantSkippedBuilds ?? "n/a"}, ` +
          `revealBuilds ${d.dormant.revealBuilds ?? "n/a"}, revealBuildMs ${d.dormant.revealBuildMs ?? "n/a"}, createEl ${d.dormant.createEl ?? "n/a"}`
      );
    }
  }
  console.log(`    blend els:         ${d.blendEls ?? "?"} (${d.blendLowOpacity ?? "?"} at effective opacity <=0.02)`);
  console.log(`    drawImage:         ${cx.drawImage ? cx.drawImage.total : "?"} (by class: ${cx.drawImage ? JSON.stringify(cx.drawImage.byClass) : "?"})`);
  console.log(`    syncCanvas hazards: canvas clientW/H reads ${cx.canvasClientRead ?? "?"}, webgl getContext ${cx.getContextWebgl ?? "?"}, ResizeObserver new ${cx.resizeObserverNew ?? "?"} / cb ${cx.resizeObserverCallback ?? "?"}`);
  console.log(`    webgl compiles:    compileShader ${cx.compileShader ?? "?"}, linkProgram ${cx.linkProgram ?? "?"}, getProgramParameter ${cx.getProgramParameter ?? "?"}, wall ${cx.compileWallMs ? Math.round(cx.compileWallMs) : "?"}ms`);
  // The gsw runtimes' own counters. `boxReads` is the deterministic version of the trace's forced-reflow
  // number: the exact count of self-layer `clientWidth`/`clientHeight` reads the particle runtime performed.
  // 0 = every binding was sized from a ResizeObserver delivery (`particleObserverSizing`); one per binding
  // created = the create-time measure pass; more than that = something is re-reading per re-size.
  // R7 W1 (d)/(e)/(b) — three lines that are only interesting when they are not the boring answer, but two of
  // them print unconditionally anyway: "no context was lost" and "the background never failed" are FINDINGS in a
  // stability round, and a reporter that only speaks up on failure cannot be distinguished from one nobody wired.
  {
    const gl = result.census.glContext;
    if (gl) {
      console.log(
        `    gl contexts:       ${gl.losses} lost / ${gl.restores} restored` +
          (gl.creationErrors ? `, ${gl.creationErrors} creation errors` : "") +
          (gl.firstLossAtMs !== null ? `   first loss @${gl.firstLossAtMs}ms` : "") +
          (gl.losses > gl.restores ? "   *** SOMETHING DID NOT COME BACK ***" : "")
      );
      for (const e of gl.events.slice(0, 6)) console.log(`      ${e.atMs}ms  ${e.kind}  ${e.target}`);
    }
    // The stage's OWN transitions, beside the page-wide count: a stage that lost and rebuilt its context while
    // the page-wide counter agrees is the recovery path working, which is what the one surviving round-6 combat
    // cell was doing when nothing could see it.
    const cs = result.census.canvasStats;
    if (cs && typeof cs.contextLosses === "number") {
      console.log(
        `    stage context:     ${cs.contextLosses} lost / ${cs.contextRestores} restored   (contextLost now: ${cs.contextLost})`
      );
    }
    const bg = result.census.staticBg;
    if (bg) {
      console.log(
        `    staticBg:          ${bg.attempts} attempts, ${bg.decodes} decoded, ${bg.failures} failed ` +
          `(${bg.watchdogFires} watchdog), latch ${bg.latches} on / ${bg.unlatches} off, now ${bg.latched ? "LATCHED (live subtree)" : "holding"}`
      );
      if (bg.lastFailedUrl) console.log(`      last FAILED url:  ${bg.lastFailedUrl}`);
      else if (bg.lastUrl) console.log(`      last url:         ${bg.lastUrl}`);
    }
    const pf = result.census.prefetch;
    if (pf) {
      console.log(
        `    atlas prefetch:    ${pf.decodedPages}/${pf.list} pages decoded, ` +
          `${Math.round((pf.decodedBytes / 1048576) * 10) / 10}MB held resident, ${pf.failed} failed, ${Math.round(pf.ms)}ms` +
          `   (never evicted — see imagePrefetch decodedBytes)`
      );
    }
  }
  const fx = result.census.effectStats;
  if (fx) {
    const p = fx.particle;
    const s = fx.shader;
    console.log(`    effect runtimes:   particle ${p ? `boxReads ${p.boxReads}, draws ${p.draws}, cacheHits ${p.cacheHits}, parks ${p.dormantParks}/${p.dormantLive} live` : "(none)"}`);
    console.log(`                       shader   ${s ? `boxReads ${s.boxReads ?? "n/a"}, draws ${s.draws ?? "?"}` : "(none)"}`);
    // R7 W1-I1c — WHICH GPU BACKEND EACH RUNTIME ACTUALLY ADOPTED. `--census` has captured these since gsw
    // published them and the bench has never printed one, which is how round 6 ran sixteen phone cells at
    // `flightCanvases.pageWebgpu` 8-12 without anyone reading the number: WebGPU allocates a SWAPCHAIN per
    // canvas in the GPU process, and the GPU process is what round 7's device kills were killing.
    //   renderer            webgpu | webgl | pending | none  (see gsw particles/runtime.ts)
    //   webgpuFallbacks     times this runtime settled for WebGL after asking for auto/webgpu; the synchronous
    //                       "no navigator.gpu" decline counts, so a plain WebGL browser reads 1, not 0.
    //   webgpuFallbackReason  the FIRST decline's reason — the only field that says WHY a silent fallback
    //                       happened, and null on a runtime that never declined.
    //   webgpuDeviceLosses / webgpuErrors  device.lost resolutions and uncapturederror events on the page-wide
    //                       device. A non-zero loss beside renderer "webgl" IS the rebuild having happened;
    //                       a non-zero error means a frame was silently wrong.
    //   webgpuSubmits       queue.submit calls — one per drawing tick, whatever the binding count (the batching
    //                       win), so a number that scales with system count is that win being given back.
    const backendLine = (st) => {
      if (!st || typeof st.renderer !== "string") return null;
      const bits = [`renderer ${st.renderer}`];
      const add = (k, label) => {
        if (typeof st[k] === "number") bits.push(`${label} ${st[k]}`);
      };
      add("webgpuFallbacks", "fallbacks");
      if (st.webgpuFallbackReason) bits.push(`reason ${st.webgpuFallbackReason}`);
      add("webgpuDeviceLosses", "deviceLosses");
      add("webgpuErrors", "gpuErrors");
      add("webgpuSubmits", "submits");
      return bits.join(", ");
    };
    for (const [label, stats] of [["shader  ", s], ["particle", p]]) {
      const line = backendLine(stats);
      if (line) console.log(`    fx backend ${label}: ${line}`);
    }
    // WHAT GSW REFUSED TO RENDER (shaderResources.noteUnsupportedRender). Deduped by gsw per (kind, id, reason),
    // so these count CAUSES, not frames. Non-zero is not automatically a defect — `wind_sway` displaces VERTEX.x
    // and gsw's model is one quad with a fragment shader, so it is a standing model boundary rather than a bug —
    // but it must be a number rather than an assumption, and a NEW reason appearing is worth reading.
    const u = fx.unsupported;
    if (u) {
      const reasons = Object.entries(u.byReason ?? {})
        .map(([key, n]) => `${key} x${n}`)
        .join(", ");
      console.log(
        `    unsupported fx:    ${u.total}${u.total > 0 ? `  [${reasons}]  e.g. ${(u.ids ?? []).slice(0, 3).join(", ")}` : ""}`
      );
    }
    // STATIC-IMAGE SWAP + CANVAS counters, both families. These are gsw's own gauges and the discriminators for
    // "why is syncCanvasSize hot": a canvas that keeps being reallocated, a pinned binding re-synced per
    // reconcile, a static image reverted back to a live canvas, or an encode that never gets to defer. Printed
    // defensively — a field is only shown when the gsw build under test actually publishes it, so this line
    // stays correct on an older branch instead of printing a wall of "?".
    const COUNTER_KEYS = [
      "staticImageEncodes",
      "staticImageBusyDeferrals",
      "staticImageBusyForcedEncodes",
      "staticImageSwaps",
      "staticImageReverts",
      "staticImagesLive",
      "canvasReallocs",
      "pinnedCanvasSyncs",
      "syncRenders"
    ];
    const counterLine = (stats) => {
      if (!stats) return null;
      const parts = COUNTER_KEYS.filter((k) => typeof stats[k] === "number").map((k) => `${k} ${stats[k]}`);
      const byCause = stats.staticImageRevertsByCause;
      if (byCause && typeof byCause === "object") {
        const nz = Object.entries(byCause).filter(([, n]) => typeof n === "number" && n > 0);
        if (nz.length) parts.push(`revertsBy{${nz.map(([k, n]) => `${k}:${n}`).join(",")}}`);
      }
      return parts.length ? parts.join(", ") : null;
    };
    for (const [label, stats] of [["shader  ", s], ["particle", p]]) {
      const line = counterLine(stats);
      if (line) console.log(`    static-image ${label}: ${line}`);
    }
    // The one reading that is not self-explanatory, so state it rather than leave it to be rediscovered.
    const busy = (st) =>
      st && typeof st.staticImageBusyDeferrals === "number" && typeof st.staticImageBusyForcedEncodes === "number"
        ? { d: st.staticImageBusyDeferrals, f: st.staticImageBusyForcedEncodes }
        : null;
    const bs = busy(s);
    const bp = busy(p);
    if (bs || bp) {
      console.log(
        "      interpretation:  staticImageBusyForcedEncodes ~= staticImageBusyDeferrals means the busy " +
          "predicate is stuck ON (every deferral is force-encoded anyway); forced << deferrals means it works." +
          (bs ? `  shader ${bs.f}/${bs.d}` : "") +
          (bp ? `  particle ${bp.f}/${bp.d}` : "")
      );
    }
  }
  const ts = result.census.topSurfaces;
  if (ts && Array.isArray(ts.rows) && ts.rows.length) {
    // BACKING-STORE bytes, not CSS size: a ¼-scale 4000x2000 canvas costs what its backing store costs.
    const totalMb = ts.rows.reduce((sum, r) => sum + (r.bytes ?? 0), 0) / (1024 * 1024);
    console.log(`    top surfaces:      ${ts.rows.length} biggest canvases by backing store (${round(totalMb, 1)}MB in this list, source: ${ts.source})`);
    for (const r of ts.rows) {
      const where = r.nodePath ? String(r.nodePath).split("/").slice(-3).join("/") : "(unstamped)";
      console.log(
        `      ${(round((r.bytes ?? 0) / (1024 * 1024), 2) + "MB").padStart(9)}  ${String(r.w)}x${String(r.h)}`.padEnd(34) +
          ` css ${r.cssW}x${r.cssH}`.padEnd(18) +
          ` ${String(r.cls ?? "").slice(0, 24).padEnd(24)} ${where}` +
          (r.sceneFile ? `  [${String(r.sceneFile).split("/").at(-1)}]` : "")
      );
    }
  }
}
if (result.idle) {
  console.log(`  idle window:         ${result.idle.windowMs}ms (markers cc-idle-start/cc-idle-end; page marker ${result.idle.markerWindowMs ?? "n/a"}ms` +
    (result.idle.traceMarkerWindowMs != null ? `, trace marker ${result.idle.traceMarkerWindowMs}ms` : "") +
    (result.idle.stageSampleWindowMs != null ? `, stage samples ${result.idle.stageSampleWindowMs}ms` : "") + ")" +
    (result.idle.shots ? `   shots: ${result.idle.shots.a} + ${result.idle.shots.b} (${result.idle.shots.gapMs}ms apart)` : ""));
  // The canvas stage's own idle rate, as a DELTA across the window — the number that says whether the stage
  // PARKED. Cumulative census totals cannot answer it on a settled screen; see the read pair above.
  if (result.idle.stage) {
    const s = result.idle.stage;
    console.log(
      `  idle canvas stage:   ${s.framesPerSec} frames/s (${s.animFramesPerSec} anim), ` +
        `${s.fxUploadsPerSec ?? "n/a"} fx uploads/s, ${s.fxQuads ?? "n/a"} quads on screen` +
        (s.fxFps != null ? (s.fxFps > 0 ? `, wakeup cap ${s.fxFps}fps` : ", wakeup uncapped") : "") +
        (s.rafs != null ? `   arms ${s.rafs} raf / ${s.parks} park (${s.parkWakeups} woke)` : "") +
        (s.instanceId != null ? `   renderer #${s.instanceId}` : "")
    );
  }
  if (result.idle.stageDeltas) {
    const d = result.idle.stageDeltas;
    const n = (value) => value ?? "n/a";
    const glyphPass = d.glyphPass
      ? `glyph-pass Δruns ${n(d.glyphPass.runs)}, glyphs ${n(d.glyphPass.glyphs)}`
      : "glyph-pass n/a";
    console.log(
      `  idle canvas deltas:  Δframes ${n(d.frames)}, Δanim ${n(d.animFrames)} across ${d.sampleWindowMs}ms; ` +
        glyphPass
    );
  }
  if (result.idle.stageMismatch) {
    const mismatch = result.idle.stageMismatch;
    console.log(`  idle canvas stage:   REFUSED counter delta across renderer #${mismatch.before.id ?? "unknown"} → #${mismatch.after.id ?? "unknown"}`);
  }
}
if (result.animAuditCounts) {
  const names = Object.entries(result.animAuditCounts.byName ?? {}).sort((a, b) => b[1] - a[1]);
  console.log(`  anim audit:          ${result.animAuditCounts.animations} running animations` +
    (names.length ? ` — ${names.map(([k, v]) => `${k}×${v}`).join(", ")}` : ""));
  if (result.animAuditPath) console.log(`  anim audit json:     ${result.animAuditPath}`);
}
if (result.revealBurst) {
  const rb = result.revealBurst;
  const n = rb.node ?? {};
  console.log(`  reveal burst:        ${n.name ?? "?"} (${rb.nodeId}) visible:false → true, injected as a 1-upsert scene-delta`);
  console.log(
    `    reconcile:         apply ${rb.applyMs}ms (sync) + walk ${rb.firstWalkMs ?? "?"}ms` +
      `   observed after ${rb.toFirstWalkMs}ms (rAF-coalesced)   walks +${rb.walksAtFirstWalk ?? "?"}` +
      `   createEl +${rb.createElAtFirstWalk ?? "?"}`
  );
  console.log(
    `    incl. settle:      walkMs +${rb.settleWalkMs ?? "?"}   walks +${rb.settleWalks ?? "?"}   createEl +${rb.settleCreateEl ?? "?"}` +
      (rb.revealBuilds != null ? `   revealBuilds +${rb.revealBuilds} (${rb.revealBuildMs}ms)` : "")
  );
  if (rb.blinkMs) {
    console.log(
      `    blink (whole reveal window): task ${rb.blinkMs.task ?? "?"}ms  script ${rb.blinkMs.script ?? "?"}ms  ` +
        `recalcStyle ${rb.blinkMs.recalcStyle ?? "?"}ms  layout ${rb.blinkMs.layout ?? "?"}ms`
    );
  }
  console.log(
    `    stage elements:    ${rb.before.elements} → ${rb.after.elements}` +
      `   mirror-nodes ${rb.before.mirrorNodes} → ${rb.after.mirrorNodes}` +
      `   root display ${rb.before.rootDisplay ?? "absent"} → ${rb.after.rootDisplay ?? "absent"}` +
      ` (subtree ${rb.before.rootSubtreeElements} → ${rb.after.rootSubtreeElements} els)`
  );
  if (!rb.observedWalk) console.log(`    WARN: no walk observed after the injection — the reveal may not have applied.`);
  if (rb.pageErrors?.length) console.log(`    WARN: page errors during the reveal: ${rb.pageErrors.join(" | ")}`);
  if (rb.shot) console.log(`    reveal shot:       ${rb.shot}`);
}
if (result.tracePath) console.log(`  trace:               ${result.tracePath}`);
// PAGE ERRORS across every repeat. Printed unconditionally (zero included) so a run's correctness is a number in
// the output rather than something a reader has to notice the absence of, and surfaced in BENCH_RESULT for a
// caller that wants to gate on it.
{
  const allErrors = runs.flatMap((r) => r.pageErrors ?? []);
  result.pageErrorCount = allErrors.length;
  result.pageErrors = allErrors.slice(0, 20);
  console.log(`  page errors:         ${allErrors.length}`);
  for (const line of result.pageErrors) {
    console.log(`    ${line.split("\n")[0]}`);
  }
  // …and gsw's own warnings (R6 P6-F5). Printed only when there are any, because unlike an error these are
  // routine on a page with an unsupported effect — what they carry that nothing else does is the driver's
  // compile info log, which is the difference between "a shader failed" and knowing which line of it did.
  const allWarnings = runs.flatMap((r) => r.pageWarnings ?? []);
  result.pageWarningCount = allWarnings.length;
  result.pageWarnings = allWarnings.slice(0, 20);
  if (allWarnings.length > 0) {
    console.log(`  gsw warnings:        ${allWarnings.length}`);
    for (const line of result.pageWarnings) {
      console.log(`    ${line.split("\n")[0]}`);
    }
  }
}
// R7 W1-I1d — the per-process memory line, printed with its limit attached rather than as a bare number, because
// a `gpu` figure quoted without "lower bound" is exactly how round 6's device reading described the wrong process.
if (result.procMem) {
  const pm = result.procMem;
  console.log(`  proc VmRSS (live):   ${formatProcMem(procMem.lastLive)}`);
  console.log(
    `  proc VmRSS (peak):   browser ${pm.peakMb.browser}MB, gpu ${pm.peakMb.gpu}MB, renderers ${pm.peakMb.renderers}MB, ` +
      `utility ${pm.peakMb.utility}MB = ${pm.peakMb.total}MB total   (${pm.samples} samples @500ms)`
  );
  console.log(
    "                       VmRSS is a LOWER BOUND on GPU-process cost (driver/kernel allocations are not " +
      "resident); see scripts/lib/proc-mem.mjs"
  );
}
// R7 W1-I1b — printed unconditionally, zero included, for the same reason page errors are: "no repeat died" is a
// finding, and a stability round that only prints deaths cannot distinguish it from "nobody looked".
{
  const c = result.crashedRepeats;
  console.log(
    `  crashed repeats:     ${c.length}/${runs.length}` +
      (c.length ? `   ${c.map((x) => `#${x.repeat}${x.atMs != null ? ` @${x.atMs}ms` : ""}: ${x.reason}`).join("  |  ")}` : "")
  );
}
// R7 W1-I1f — failed requests. Printed only when non-zero: on a healthy run this is genuinely empty, and an
// always-on "0" line for a collector that has no other job would be noise. The counts are cross-repeat totals.
if (result.responseErrors.length) {
  const total = result.responseErrors.reduce((n, r) => n + r.count, 0);
  console.log(`  failed requests:     ${total} across ${result.responseErrors.length} distinct route(s)`);
  for (const row of result.responseErrors.slice(0, 12)) {
    console.log(`    ${row.status}  x${row.count}  ${row.pathname}`);
  }
}
if ((result.busyPctSpreadPct ?? 0) > 15) {
  console.log(`  WARN: busy% spread ${result.busyPctSpreadPct}% > 15% — investigate (cold dev-server transform? add a warmup / more repeats).`);
}
console.log("");
console.log("BENCH_RESULT " + JSON.stringify(result));

// ---------------------------------------------------------------------------------------------------------
// shared cross-repo envelope (--report)
// ---------------------------------------------------------------------------------------------------------
// The SAME schema godot-scene-web's packages/perf-harness emits (perf-report/1, profile "browser-render"), so a
// unit-level win measured there can be checked against this integration replay field-for-field. Coupling is the
// JSON SHAPE only: no build dependency, no cross-repo import. Every value below is mapped from a measurement
// this bench already takes; anything the trace did not carry stays null rather than being zero-filled.
if (args.report) {
  // Split the repeats: `__discard` (set by the presence guard, the geometry lock, or a trace analyser that
  // could not make a required observation) EXCLUDES a repeat from `runs` and lists it in `failures`. A
  // crashed repeat has no `report` object at all.
  const accepted = [];
  const failures = [];
  runs.forEach((r, i) => {
    if (!r.report) {
      if (r.crashReason) failures.push(`repeat ${i + 1}: crashed outright — ${r.crashReason}`);
      return;
    }
    if (r.report.__discard) {
      failures.push(`repeat ${i + 1}: ${r.report.__discard}`);
      return;
    }
    accepted.push(r.report);
  });
  if (accepted.length === 0) {
    console.error(
      `--report: no repeat produced a contract-valid measurement — nothing written.\n  ${failures.join("\n  ")}`,
    );
    process.exit(1);
  }
  // Geometry lock: every accepted repeat must have been measured at the same raster scale + stage as the
  // first, or the decode/raster numbers are not comparable across the run (godot-scene-web `sameGeometry`).
  const g0 = accepted[0].geometry;
  for (let i = 1; i < accepted.length; i++) {
    if (!sameGeometry(g0, accepted[i].geometry)) {
      failures.push(
        `repeat: geometry drifted from repeat 0 (fitScale ${g0.fitScale} vs ${accepted[i].geometry.fitScale}) — excluded`,
      );
      accepted.splice(i, 1);
      i--;
    }
  }
  if (accepted.length === 0) {
    console.error("--report: every repeat's geometry drifted from repeat 0 — nothing written.");
    process.exit(1);
  }

  // Playwright's `browser.version()` is a bare version string ("143.0.7295.0"), CDP's is "HeadlessChrome/143…".
  const chromeMajor = /(?:^|\/)(\d+)\./.exec(browserVersion ?? "")?.[1] ?? null;
  const envLabel =
    args.reportLabel || (chromeMajor ? `${process.platform}-chrome-${chromeMajor}` : `${process.platform}-chrome`);
  const traceArtifact =
    runs.map((r) => r.report?.tracePath).find(Boolean) ??
    relative(REPO_ROOT, resolve(REPO_ROOT, ".sts2/bench/traces", String(args.trace)));

  const envelope = buildPerfReport({
    runs: accepted,
    failures,
    scenario: args.reportScenario ?? `mirror-replay-${basename(recordingPath).replace(/\.ndjson$/i, "")}`,
    warmups: 1,
    env: {
      kind: args.reportEnvKind,
      label: envLabel,
      cpuThrottle: CPU_THROTTLE,
      device: null
    },
    artifacts: {
      trace: traceArtifact,
      screenshot: accepted[0].presented.screenshot
    },
    params: {
      url: pageUrl,
      requestedUrl: requestedPageUrl,
      recording: recordingPath,
      recordingMessages: sliced.messages ?? recMeta.messages ?? null,
      limitMs: args.limitMs ?? null,
      // --window: the measured bracket on the recording's clock. When set, EVERY metric above describes that
      // bracket, so a report without this field and one with it are not comparable numbers.
      windowMs: args.window ? [args.window.startMs, args.window.endMs] : null,
      // --census only: the gsw runtimes' own counters, snapshotted post-settle. Carried here rather than in
      // `metrics` because they are this repo's diagnostics, not part of the shared perf-report/1 metric set.
      censusEffectStats: result.census?.effectStats ?? null,
      censusTopSurfaces: result.census?.topSurfaces ?? null,
      // Renderer consumers need the canvas path's own counters to review a same-implementation run: the glyph
      // pass records uploads/reuploads, GL state bracket and errors, while the block cache records bytes and
      // layout work. Keep this an extension under `params` rather than inventing cross-repo perf metric names.
      censusCanvasStats: result.census?.canvasStats ?? null,
      censusGlContext: result.census?.glContext ?? null,
      // --proc-mem samples the launched Chrome process tree; Blink heap is read from the renderer process at
      // each repeat's measured-window endpoints.  Persist both so a terminal transcript is never the sole
      // memory evidence for a renderer decision.
      processMemory: {
        procMem: result.procMem ?? null,
        blinkMemory: result.blinkMemory ?? null,
        perRepeatBlinkMemory: result.perRepeatBlinkMemory ?? []
      },
      recordingBytes: recMeta.bytes ?? null,
      pace: args.pace,
      // The three R12 wire-realism levers. A run without them is a desktop-speed instant-ack replay, which is a
      // different wire from a phone's — so a report that omits them is not comparable with one that has them.
      ackPacedMs: args.ackPacedMs ?? null,
      dropCardFlights: args.dropCardFlights,
      flightStillMs: args.flightLiveness ? args.flightStillMs : null,
      flightLiveness: args.flightLiveness ? (result.perRepeatFlightLiveness ?? []).filter(Boolean) : null,
      quality: args.quality,
      effects: args.effects,
      viewport: `${args.viewport.width}x${args.viewport.height}`,
      cull: args.cull,
      hoverSweep: args.hoverSweep,
      resRoot: args.resRoot ?? null,
      assetCacheRoot: args.assetCacheRoot ?? null,
      resAssetsServed: assetServingEnabled ? resHits : null,
      resAssetsMissing: assetServingEnabled ? resMisses.size : null,
      // Provenance for anyone diffing these against another repo's numbers.
      tracedEveryRepeat: true,
      traceCategories: [...REPORT_EXTRA_CATEGORIES],
      // The cross-process `cpu` block is a LOWER BOUND (tdur inside traced tasks only). `metrics.cpu.cpuCoverage`
      // is the fraction of summed top-level wall that carried a tdur — read a low value as "unknown", not "idle".
      cpuCoverage: accepted.map((r) => r.cpu?.cpuCoverage ?? null),
      // The compositor-frames-that-reached-presentation count (see runs[].presentedFrames). NOT the contract's
      // `metrics.presented`, which is the screenshot presence guard — this one used to be (mis)named `presented`.
      presentedFrames: accepted.map((r) => r.presentedFrames ?? null),
      definitions: {
        initialRenderMs: "page clock at >50 .mirror-node elements (navigation start -> first rendered mirror tree)",
        readyMs: "page clock when the whole recorded stream is delivered and settled (the measured window's close)",
        windowMs: "cc-report-start -> cc-report-end, measured on the trace clock",
        contentUpdateHz: "ActivateLayerTree rate inside the window ((n-1)/span). NOT the swap rate.",
        swapRateHz: "DrawFrame rate, DEDUPED by timestamp; reported for contrast only — a swap can repeat the same picture. `swapCount` carries the raw count when the rate could not be derived.",
        presented: "the contract's SCREENSHOT PRESENCE GUARD — {nonEmptyRatio, sampleHits, sampleCount, screenshot} from a post-window capture. sampleHits < sampleCount fails the repeat.",
        presentedFrames: "compositor frames that reached presentation (params.presentedFrames per repeat; see runs[].presentedFramesSource). Provenance only.",
        "env.geometry": "viewport / dpr / orientation / fit + fitScale / stage (mirror design box) / fittedStage (post-letterbox) / grid (null — the mirror is one scene) / emulatedViewport (the Playwright-forced viewport). Locked identical across accepted repeats.",
        cpu: "CPU across EVERY traced process (renderer/browser/gpu/other), from RunTask tdur on maximal events. totalCpuMs is a LOWER BOUND; cpuCoverage says how complete it is.",
        frameCostMs: "per top-level RunTask duration on the renderer main thread inside the window",
        tickMs: "duration of each requestAnimationFrame CALLBACK inside the window, page-side. NOT frame time.",
        censusEffectStats: "--census: window.__mirrorShaderStats() per family.",
        censusTopSurfaces: "--census: the 10 biggest <canvas> elements by backing-store bytes.",
        censusCanvasStats: "--census: window.__mirrorCanvasStats() after settle — renderer-owned glyph/block-cache telemetry.",
        censusGlContext: "--census: renderer WebGL context-loss and error evidence after settle",
        processMemory: "--proc-mem: launched Chrome process-tree VmRSS plus renderer Blink heap at the measured-window endpoints.",
        blockedMs: "total blocking time: sum over main-thread tasks of max(0, dur-50ms)",
        mainThreadCpuRatio: "tdur/dur over LONG (>=5ms) main-thread RunTasks — computing vs parked-waiting. null <=> mainThreadCpuSamples 0.",
        decode: "count/totalMs/maxMs are cache ENTRY POINTS (mostly hits) — they price cache traffic, not decode work.",
        "decode.codecRuns": "the actual codec runs. Same rule as godot-scene-web's analyze.ts so both repos' decode blocks mean the same thing.",
        "decode.inRasterCount": "codec runs INSIDE a raster task — a hard failure, worst-cased across repeats.",
        "decode.redecodeCount": "repeated codec RUNS of the same image; repeated cache lookups are not counted.",
        renderSurfaces: "sum of cc's RenderSurfaceReasonCount reasons (max-folded); renderSurfaceListPasses distinguishes a measured 0 from 'the census never ran'.",
        longAnimationFrames: "PerformanceObserver long-animation-frame entries inside the window"
      }
    }
  });

  mkdirSync(dirname(args.report), { recursive: true });
  writeFileSync(args.report, JSON.stringify(envelope, null, 2) + "\n");
  console.log("");
  console.log(`PERF_REPORT ${args.report}`);
  console.log(JSON.stringify({ ...envelope, runs: `[${envelope.runs.length} runs]` }, null, 2));
}

// --flight-liveness (and its R14 discard-liveness sibling) are GATEs, not a report: a stalled replay must FAIL
// the run, or an arm that got faster by not animating at all would pass. Everything else has already been
// printed and written by here.
process.exit(flightLivenessFailed || discardGateFailed ? 1 : 0);
