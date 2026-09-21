#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { buildMetrics, markerWindow, parseAndroidChromeGpuPidsLedger, parseAndroidChromeRssLedger } from "./analyze-phone-canvas-cell.mjs";
import { buildSummary, VISUAL_QUALITY_SCHEMA } from "./summarize-phone-canvas-bench.mjs";

const root = mkdtempSync(join(tmpdir(), "phone-canvas-bench-"));
const arms = ["dom", "canvas", "canvas", "dom"];
const workloads = ["idle", "discard", "reshuffle", "dense"];

function writeMatrix(dir, { canvasFps = 70 } = {}) {
  mkdirSync(dir, { recursive: true });
  for (const workload of workloads) {
    for (const [i, arm] of arms.entries()) {
      const isCanvas = arm === "canvas";
      const isDom = arm === "dom";
      const idle = workload === "idle";
      const metrics = {
        schema: "phone-canvas-cell-metrics/2",
        cell: {
          label: `${workload}-${i + 1}`,
          workload: { id: workload, recording: `/fixtures/${workload}.ndjson` }, arm, sequence: i + 1,
          run: { repeats: 1, effects: "on", effectMode: "static", quality: "static" },
          query: isCanvas ? "stage=canvas&paintDump=1" : "stage=dom",
          artifacts: { result: join(dir, `${workload}-${i + 1}.result.json`) }
        },
        phase: idle ? "idle" : "active",
        traceWindow: { windowMs: idle ? 5_000 : 3_500 },
        submitted: { source: "drawframe", count: 100, fps: isCanvas ? canvasFps : idle && isDom ? 80 : 60 },
        actualPresented: { count: 100, fps: isCanvas ? canvasFps : idle && isDom ? 80 : 60, gapP50Ms: 16, gapP95Ms: 20, gapMaxMs: 25,
          surface: "ChromeSurface", provenance: { source: "perfetto-frame-timeline-actual", surface: "ChromeSurface", attributionKey: "layer_name", eventNames: ["ActualFrameTimelineSlice"] } },
        display: { viewport: "1220x2712", devicePixelRatio: 3.4876 },
        cpu: {
          rendererMainPct: isCanvas ? (idle ? 35 : 45) : isDom ? 50 : 60,
          gpuProcessPct: isCanvas ? (idle ? 50 : 55) : isDom ? 70 : 70
        },
        frameGaps: { p95: isCanvas ? 20 : 20 },
        sceneAckLatency: { p95: isCanvas ? 10 : 10 },
        // Deliberately make total RSS wildly different: only the GPU-process component is an acceptance gate.
        memoryMb: { gpu: isCanvas ? 540 : 500, total: isCanvas ? 3_000 : 1_000 },
        health: { benchExit: 0, lmk: false, contextLoss: false, processRestart: false, assetFailure: false, pageCrash: false, thermalThrottle: false, foregroundPre: true, foregroundPost: true }
      };
      writeFileSync(metrics.cell.artifacts.result, JSON.stringify({ label: metrics.cell.label }));
      writeFileSync(metrics.cell.artifacts.result.replace(".result.json", ".png"), Buffer.concat([onePixelPng, Buffer.from(metrics.cell.label)]));
      writeFileSync(join(dir, `${workload}-${i + 1}.metrics.json`), JSON.stringify(metrics));
    }
  }
}

function run(args, visualQuality = defaultVisualQuality) {
  const visualArgs = visualQuality ? ["--visual-quality", visualQuality] : [];
  return spawnSync(process.execPath, [resolve("scripts/summarize-phone-canvas-bench.mjs"), ...args, ...visualArgs], { encoding: "utf8" });
}

const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9aQAAAABJRU5ErkJggg==", "base64");
let defaultVisualQuality = null;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function metricPair(matrix, workload) {
  const canvas = join(matrix, `${workload}-3.metrics.json`);
  const dom = join(matrix, `${workload}-4.metrics.json`);
  const image = (metric) => JSON.parse(readFileSync(metric, "utf8")).cell.artifacts.result.replace(".result.json", ".png");
  return { canvas, dom, canvasImage: image(canvas), domImage: image(dom) };
}

function writeVisualReview(dir, matrix, { verdict = "pass", pairVerdict = verdict, workloadsToReview = workloads } = {}) {
  mkdirSync(dir, { recursive: true });
  const manifest = join(dir, "review.json");
  writeFileSync(manifest, JSON.stringify({
    schema: VISUAL_QUALITY_SCHEMA,
    verdict,
    notes: "External reviewer checked card-description alignment and clipping in these captures.",
    imagePairs: workloadsToReview.map((workload) => {
      const pair = metricPair(matrix, workload);
      return {
        id: `strict-card-description-${workload}`,
        workload,
        canvas: {
          metric: relative(dir, pair.canvas),
          metricSha256: sha256(pair.canvas),
          imageSha256: sha256(pair.canvasImage)
        },
        dom: {
          metric: relative(dir, pair.dom),
          metricSha256: sha256(pair.dom),
          imageSha256: sha256(pair.domImage)
        },
        marker: workload === "idle"
          ? { before: "cc-idle-start", after: "cc-idle-end" }
          : { before: "cc-report-start", after: "cc-report-end" },
        verdict: pairVerdict,
        notes: "Reviewer compared text position, wrapping, and clipping by eye."
      };
    })
  }));
  return manifest;
}

try {
  const runner = readFileSync(resolve("scripts/bench-phone-canvas-ab.sh"), "utf8");
  // `tab_ok` is a shell success flag (1), while `foreground_post` is deliberately the JSON-word boolean.
  // Keep this boundary explicit: a mismatch would make every healthy physical-device cell fail closed.
  assert.match(runner, /FOREGROUND_PRE="\$tab_ok" FOREGROUND_POST="\$foreground_post"/);
  assert.match(runner, /foregroundPre:process\.env\.FOREGROUND_PRE==="1", foregroundPost:process\.env\.FOREGROUND_POST==="true"/);
  assert.doesNotMatch(runner, /--proc-mem/);
  assert.match(runner, /canvas\) query="stage=canvas&paintDump=1"/);
  assert.match(runner, /set \+e\n\s*node "\$SCRIPT_DIR\/bench-mirror-replay\.mjs"[\s\S]*?bench_exit=\$\{PIPESTATUS\[0\]\}\n\s*set -e/,
    "a failing bench pipeline must still reach PIPESTATUS capture and finalization");
  assert.match(runner, /r\.pageCrashed===true \|\| \(r\.crashedRepeats\|\|\[\]\)\.some\(Boolean\)/,
    "ordinary page errors are not renderer crashes");
  assert.match(runner, /knownNonpaintingAssetErrors:JSON\.parse/);
  assert.match(runner, /GradientTexture2D_5newe[\s\S]*?GradientTexture2D_hcj65/,
    "only the two reviewed nonpainting routes are exempted");
  assert.doesNotMatch(runner, /pureCanvas|canvasRetained|canvasStaticBg|retainedForceDecline|RETAINED_DECLINE_PROBE|retained-marker-timing/);
  assert.match(runner, /COUCHCOOP_DEV_BG_FIXTURE must name the ignored external background-fixture directory/);
  assert.match(runner, /COUCHCOOP_DEV_ASSET_CACHE_ROOT must name the production asset-cache schema directory/);
  assert.match(runner, /required asset preflight failed/);
  assert.match(runner, /required static background preflight failed/);
  assert.match(runner, /assetCacheRoot: process\.env\.ASSET_CACHE_ROOT/);
  assert.match(runner, /fixtureDir: process\.env\.DEV_BG_FIXTURE/);
  assert.match(runner, /--asset-cache-root "\$ASSET_CACHE_ROOT"/);
  assert.match(runner, /--connect-cdp "http:\/\/127\.0\.0\.1:\$CDP_PORT" \\\n+      --keep-connected-page/,
    "the matrix must leave the measured page live until its post-cell rAF proof");
  assert.match(runner, /OUT_DIR="\$\(realpath -m "\$OUT_DIR"\)"/,
    "cell artifact paths must be absolute before Node loads the result JSON");
  assert.match(runner, /phone-bench-tab\.mjs" open --url "http:\/\/127\.0\.0\.1:\$DEV_PORT\/"/,
    "the pre-cell foreground proof must open a stable mirror route, before the arm-specific navigation");
  assert.doesNotMatch(runner, /\/json\/close\//,
    "the wrapper must not pre-close targets and erase phone-bench-tab's renderer-PID evidence");
  assert.match(runner, /phone-bench-tab\.mjs owns the whole stale-tab handoff/,
    "the phone tab tool is the sole pre-open cleanup and quiescence owner");
  assert.match(runner, /else\n\s*tab_status=\$\?\n\s*fi\n\s*if \[ "\$tab_status" -eq 3 \]; then[\s\S]*?exit 3/,
    "teardown-evidence failure must be fatal before a foreground retry can open unguarded");
  assert.match(runner, /--url "http:\/\/127\.0\.0\.1:\$DEV_PORT"[\s\S]*?"\$\{query_args\[@\]\}"/,
    "the replay keeps its per-arm query navigation after the mirror-only pre-cell proof");
  // Bash syntax validation does not parse the embedded Node programs.
  for (const match of runner.matchAll(/node -e '([\s\S]*?)\n\s*'/g)) new Function(match[1]);
  assert.match(runner, /MALI_PROFILE="\$\{MALI_PROFILE:-off\}"/);
  assert.match(runner, /MALI_PROFILE=on requires STREAMLINE_COUNTERS_FILE/);
  assert.match(runner, /MALI_PROFILE=on requires executable STREAMLINE_CLI/);
  assert.match(runner, /setsid env STREAMLINE_COUNTERS_FILE="\$STREAMLINE_COUNTERS_FILE" STREAMLINE_DURATION_SECONDS="\$STREAMLINE_DURATION_SECONDS"[\s\S]*?mise run android-webview-profile/,
    "the opt-in profile task receives the bounded counters and duration exactly");
  assert.match(runner, /STREAMLINE_APC_IN="\$profile_apc" STREAMLINE_TIMELINE_OUT="\$profile_timeline" STREAMLINE_CLI="\$STREAMLINE_CLI"[\s\S]*?mise run android-webview-profile-export/,
    "timeline export must use the caller-provided Streamline CLI");
  assert.match(runner, /global Mali hardware counters; not Chrome hardware attribution/);
  assert.match(runner, /profile metadata has no wrapper tracked PID/);
  assert.match(runner, /analyze-mali-capture\.mjs" "\$profile_apc" "\$profile_timeline" "\$trace" "\$phase" "\$metrics"/);

  const ledger = parseAndroidChromeRssLedger(`
    23302 391360 com.android.chrome
    23418 1550468 com.android.chrome:privileged_process0
    23419 102400 com.android.chrome:privileged_process1
    16060 845656 com.android.chrome:sandboxed_process0:org.chromium.content.app.SandboxedProcessService0:59
    16191 324888 com.android.chrome:sandboxed_process0:org.chromium.content.app.SandboxedProcessService0:61
    22532 30672 com.android.chrome_zygote
  `, "/tmp/cell.procs");
  assert.deepEqual(ledger && { gpu: ledger.gpu, renderers: ledger.renderers, total: ledger.total, gpuRows: ledger.gpuRows, rendererRows: ledger.rendererRows }, {
    gpu: 1614.129, renderers: 1143.109, total: 3169.379, gpuRows: 2, rendererRows: 2
  });
  assert.equal(ledger?.source, "android-ps-rss-settled");
  assert.equal(parseAndroidChromeRssLedger(""), null);
  assert.equal(parseAndroidChromeRssLedger("23418 1550468 com.android.chrome:sandboxed_process0"), null);
  assert.equal(parseAndroidChromeRssLedger("not a ps ledger"), null);
  assert.deepEqual(parseAndroidChromeGpuPidsLedger(`PID RSS NAME\n23418 1550468 com.android.chrome:privileged_process0\n23419 102400 com.android.chrome:privileged_process1\n`), [23418, 23419]);
  assert.equal(parseAndroidChromeGpuPidsLedger("23418 missing columns"), null);

  const metricMeta = { artifacts: { display: "/tmp/display" }, health: {} };
  const metricResult = { procMem: { peakMb: { gpu: 999, renderers: 888, total: 777 } }, config: {}, medians: {} };
  const metricWindow = { phase: "active", windowMs: 1_000 };
  const metricTrace = { threads: [], windowMs: 1_000, gpuProcess: { cpuMs: 0 }, presents: null, presentSource: null };
  const deviceMetric = buildMetrics(metricMeta, metricResult, metricWindow, metricTrace, ledger);
  assert.deepEqual(deviceMetric.memoryMb, { gpu: 1614.129, renderers: 1143.109, total: 3169.379 });
  assert.equal(deviceMetric.memory.source, "android-ps-rss-settled");
  assert.equal(buildMetrics(metricMeta, metricResult, metricWindow, metricTrace, null).memoryMb, null);
  assert.deepEqual(buildMetrics(metricMeta, metricResult, metricWindow, metricTrace).memoryMb, { gpu: 999, renderers: 888, total: 777 });
  const markerCpu = { cpuMs: 350, cpuPct: 35, source: "chrome-trace-marker-thread-ticks" };
  const cpuMetric = buildMetrics(metricMeta, metricResult, metricWindow, { ...metricTrace, threads: [{ label: "Renderer/CrRendererMain", cpuMs: 320 }] }, ledger, null, markerCpu);
  assert.equal(cpuMetric.cpu.rendererMainCpuMs, 350);
  assert.equal(cpuMetric.cpu.rendererMainRunTaskCpuMs, 320, "RunTask CPU remains diagnostic rather than replacing the marker thread clock");
  const schedMetric = buildMetrics(metricMeta, metricResult, metricWindow, metricTrace, ledger, null, null,
    { source: "perfetto-linux-ftrace-sched-switch", cpuMs: 225, cpuPct: 22.5, pids: [99] });
  assert.equal(schedMetric.cpu.gpuProcessCpuMs, 225);
  assert.equal(schedMetric.cpu.gpuProcessRunTaskCpuMs, 0, "Chrome RunTask GPU CPU remains diagnostic");
  const noMarkerCpu = buildMetrics(metricMeta, metricResult, metricWindow, metricTrace, ledger,
    { fps: 60, provenance: { source: "perfetto-frame-timeline-actual" } }, null);
  assert.equal(noMarkerCpu.actualPresented.fps, 60, "missing CPU evidence cannot discard valid presentation evidence");

  const idleWindow = markerWindow([
    { ts: 1_000 },
    { ts: 2_000, name: "TimeStamp", args: { data: { message: "cc-idle-start" } } },
    { ts: 7_000, name: "TimeStamp", args: { data: { message: "cc-idle-end" } } }
  ], "idle");
  assert.equal(idleWindow.windowMs, 5);
  assert.throws(() => markerWindow([{ ts: 1 }], "active"), /missing cc-report-start marker/);

  const matrix = join(root, "matrix");
  writeMatrix(matrix);
  defaultVisualQuality = writeVisualReview(join(root, "visual-quality-pass"), matrix);

  const defaultSummary = buildSummary([]);
  const missingVisualGate = defaultSummary.gates.find((row) => row.name.startsWith("visual quality:"));
  assert.equal(missingVisualGate?.status, "MISSING", "the buildSummary API must fail closed without review evidence");

  const missingVisualRun = run(["--input", matrix], null);
  assert.equal(missingVisualRun.status, 1, missingVisualRun.stderr);
  assert.match(missingVisualRun.stdout, /provide --visual-quality <review\.json>/);

  const invalidVisual = join(root, "visual-quality-invalid.json");
  writeFileSync(invalidVisual, "not json");
  const invalidVisualRun = run(["--input", matrix], invalidVisual);
  assert.equal(invalidVisualRun.status, 1, invalidVisualRun.stderr);
  assert.match(invalidVisualRun.stdout, /invalid review manifest/);

  const wrongSchemaVisual = writeVisualReview(join(root, "visual-quality-wrong-schema"), matrix);
  const wrongSchemaManifest = JSON.parse(readFileSync(wrongSchemaVisual, "utf8"));
  delete wrongSchemaManifest.schema;
  writeFileSync(wrongSchemaVisual, JSON.stringify(wrongSchemaManifest));
  const wrongSchemaRun = run(["--input", matrix], wrongSchemaVisual);
  assert.equal(wrongSchemaRun.status, 1, wrongSchemaRun.stderr);
  assert.match(wrongSchemaRun.stdout, /schema must be phone-canvas-visual-quality-review\/1/);

  const missingImageVisual = writeVisualReview(join(root, "visual-quality-missing-image"), matrix);
  const missingImageManifest = JSON.parse(readFileSync(missingImageVisual, "utf8"));
  const missingImageMetric = resolve(dirname(missingImageVisual), missingImageManifest.imagePairs[0].canvas.metric);
  const missingImagePath = JSON.parse(readFileSync(missingImageMetric, "utf8")).cell.artifacts.result.replace(".result.json", ".png");
  const missingImageBytes = readFileSync(missingImagePath);
  unlinkSync(missingImagePath);
  writeFileSync(missingImageVisual, JSON.stringify(missingImageManifest));
  const missingImageRun = run(["--input", matrix], missingImageVisual);
  writeFileSync(missingImagePath, missingImageBytes);
  assert.equal(missingImageRun.status, 1, missingImageRun.stderr);
  assert.match(missingImageRun.stdout, /canvas metric is absent from this matrix or lacks result\/image artifacts/);

  const otherMatrix = join(root, "other-matrix");
  writeMatrix(otherMatrix);
  const wrongMatrixVisual = writeVisualReview(join(root, "visual-quality-wrong-matrix"), otherMatrix);
  const wrongMatrixRun = run(["--input", matrix], wrongMatrixVisual);
  assert.equal(wrongMatrixRun.status, 1, wrongMatrixRun.stderr);
  assert.match(wrongMatrixRun.stdout, /canvas metric is absent from this matrix/);

  const staleMatrix = join(root, "visual-quality-stale-matrix");
  writeMatrix(staleMatrix);
  const staleVisual = writeVisualReview(join(root, "visual-quality-stale"), staleMatrix);
  const staleMetric = join(staleMatrix, "idle-3.metrics.json");
  writeFileSync(staleMetric, `${readFileSync(staleMetric, "utf8")}\n`);
  const staleRun = run(["--input", staleMatrix], staleVisual);
  assert.equal(staleRun.status, 1, staleRun.stderr);
  assert.match(staleRun.stdout, /canvas metric SHA-256 does not match/);

  const incompleteVisual = writeVisualReview(join(root, "visual-quality-incomplete"), matrix, { workloadsToReview: ["idle"] });
  const incompleteRun = run(["--input", matrix], incompleteVisual);
  assert.equal(incompleteRun.status, 1, incompleteRun.stderr);
  assert.match(incompleteRun.stdout, /passing review is missing workload coverage: discard, reshuffle, dense/);

  const failedVisual = writeVisualReview(join(root, "visual-quality-failed"), matrix, { verdict: "fail", workloadsToReview: ["idle"] });
  const failedVisualRun = run(["--input", matrix], failedVisual);
  assert.equal(failedVisualRun.status, 1, failedVisualRun.stderr);
  assert.match(failedVisualRun.stdout, /externally authored review verdict fail/);

  const out = join(root, "summary.json");
  const pass = run(["--input", matrix, "--out", out]);
  assert.equal(pass.status, 0, `${pass.stderr}\n${pass.stdout}`);
  const summary = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(summary.passed, true);
  assert.equal(summary.gates.filter((row) => row.status !== "PASS").length, 0);
  assert.equal(summary.aggregate.idle.fps, 70);
  assert.equal(summary.visualQuality.valid, true);
  assert.deepEqual(summary.visualQuality.coveredWorkloads, [...workloads].sort());
  assert.deepEqual(summary.visualQuality.imagePairs.map((pair) => pair.id), workloads.map((workload) => `strict-card-description-${workload}`));

  const oldEvidence = join(root, "old-evidence");
  writeMatrix(oldEvidence);
  const oldPath = join(oldEvidence, "idle-1.metrics.json");
  const oldCell = JSON.parse(readFileSync(oldPath, "utf8"));
  oldCell.schema = "phone-canvas-cell-metrics/1";
  oldCell.presented = oldCell.submitted;
  delete oldCell.submitted;
  delete oldCell.actualPresented;
  writeFileSync(oldPath, JSON.stringify(oldCell));
  const oldRun = run(["--allow-fail", "--input", oldEvidence]);
  assert.equal(oldRun.status, 0, oldRun.stderr);
  assert.match(oldRun.stdout, /requires phone-canvas-cell-metrics\/2/, "old DrawFrame-only evidence must be rejected for actual-presentation gates");

  const invalid = join(root, "invalid");
  writeMatrix(invalid);
  const invalidPath = join(invalid, "discard-1.metrics.json");
  const invalidCell = JSON.parse(readFileSync(invalidPath, "utf8"));
  invalidCell.display.devicePixelRatio = 2;
  invalidCell.health.foregroundPost = false;
  writeFileSync(invalidPath, JSON.stringify(invalidCell));
  const invalidRun = run(["--allow-fail", "--input", invalid]);
  assert.equal(invalidRun.status, 0, invalidRun.stderr);
  assert.match(invalidRun.stdout, /display invariant: identical viewport and DPR/);
  assert.match(invalidRun.stdout, /missing\/failed post-cell foreground proof/);

  const failing = join(root, "failing");
  writeMatrix(failing, { canvasFps: 30 });
  const fail = run(["--input", failing]);
  assert.equal(fail.status, 1, fail.stderr);
  const inspected = run(["--allow-fail", "--input", failing]);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.match(inspected.stdout, /idle: canvas actual-presented fps ≥ 60/);
  console.log("phone canvas benchmark summary tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
