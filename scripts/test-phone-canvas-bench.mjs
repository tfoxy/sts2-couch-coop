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

function retainedWindow({
  enabled = true,
  selected = 1,
  entries = 1,
  bytes = 4 * 1024 * 1024,
  peakBytes = 6 * 1024 * 1024,
  realHitsBefore = 10,
  realHitsAfter = 11,
  substitutedBefore = 100,
  substitutedAfter = 108,
  compositesBefore = 10,
  compositesAfter = 11,
} = {}) {
  const snapshot = (realHits, substitutedCommands, composites) => ({
    enabled,
    selected,
    execution: { substitutedCommands },
    cache: { entries, bytes, peakBytes, realHits, composites },
  });
  const before = snapshot(realHitsBefore, substitutedBefore, compositesBefore);
  const after = snapshot(realHitsAfter, substitutedAfter, compositesAfter);
  return { before, after, current: after };
}

function writeMatrix(dir, {
  canvasFps = 70,
  matrixArms = arms,
  controlName = "dom",
  candidateName = "canvas",
  controlQuery = "stage=dom",
  candidateQuery = "stage=canvas&paintDump=1",
  candidateTotalMemory = 3_000,
  controlTotalMemory = 1_000,
  retained = null,
  controlIdleFps = 80,
  controlActiveFps = 60,
} = {}) {
  mkdirSync(dir, { recursive: true });
  for (const workload of workloads) {
    for (const [i, arm] of matrixArms.entries()) {
      const isCanvas = arm === candidateName;
      const isDom = arm === controlName;
      const idle = workload === "idle";
      const metrics = {
        schema: "phone-canvas-cell-metrics/2",
        cell: {
          label: `${workload}-${i + 1}`,
          workload: { id: workload, recording: `/fixtures/${workload}.ndjson` }, arm, sequence: i + 1,
          run: { repeats: 1, effects: "on", effectMode: "static", quality: "static" },
          query: isCanvas ? candidateQuery : controlQuery,
          artifacts: { result: join(dir, `${workload}-${i + 1}.result.json`) }
        },
        phase: idle ? "idle" : "active",
        traceWindow: { windowMs: idle ? 5_000 : 3_500 },
        submitted: { source: "drawframe", count: 100, fps: isCanvas ? canvasFps : idle && isDom ? controlIdleFps : controlActiveFps },
        actualPresented: { count: 100, fps: isCanvas ? canvasFps : idle && isDom ? controlIdleFps : controlActiveFps, gapP50Ms: 16, gapP95Ms: 20, gapMaxMs: 25,
          surface: "ChromeSurface", provenance: { source: "perfetto-frame-timeline-actual", surface: "ChromeSurface", attributionKey: "layer_name", eventNames: ["ActualFrameTimelineSlice"] } },
        display: { viewport: "1220x2712", devicePixelRatio: 3.4876 },
        cpu: {
          rendererMainPct: isCanvas ? (idle ? 35 : 45) : isDom ? 50 : 60,
          gpuProcessPct: isCanvas ? (idle ? 50 : 55) : isDom ? 70 : 70
        },
        frameGaps: { p95: isCanvas ? 20 : 20 },
        sceneAckLatency: { p95: isCanvas ? 10 : 10 },
        // Deliberately make total RSS wildly different: only the GPU-process component is an acceptance gate.
        memoryMb: { gpu: isCanvas ? 540 : 500, total: isCanvas ? candidateTotalMemory : controlTotalMemory },
        retainedSubtrees: isCanvas ? retained : null,
        health: { benchExit: 0, lmk: false, contextLoss: false, processRestart: false, assetFailure: false, pageCrash: false, thermalThrottle: false, foregroundPre: true, foregroundPost: true, installOverlayAbsent: true }
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

function writeNamedVisualReview(dir, matrix, { verdict = "pass", pairVerdict = verdict } = {}) {
  mkdirSync(dir, { recursive: true });
  const manifest = join(dir, "review.json");
  writeFileSync(manifest, JSON.stringify({
    schema: VISUAL_QUALITY_SCHEMA,
    verdict,
    notes: "External reviewer compared the named control and candidate captures.",
    imagePairs: workloads.map((workload) => {
      const candidate = join(matrix, `${workload}-3.metrics.json`);
      const control = join(matrix, `${workload}-4.metrics.json`);
      const image = (metric) => JSON.parse(readFileSync(metric, "utf8")).cell.artifacts.result.replace(".result.json", ".png");
      return {
        id: `named-${workload}`,
        workload,
        candidate: { metric: relative(dir, candidate), metricSha256: sha256(candidate), imageSha256: sha256(image(candidate)) },
        control: { metric: relative(dir, control), metricSha256: sha256(control), imageSha256: sha256(image(control)) },
        marker: workload === "idle"
          ? { before: "cc-idle-start", after: "cc-idle-end" }
          : { before: "cc-report-start", after: "cc-report-end" },
        verdict: pairVerdict,
        notes: "Named arm images match visually."
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
  assert.match(runner, /CONTROL_QUERY="stage=dom"/);
  assert.match(runner, /CANDIDATE_QUERY="stage=canvas&paintDump=1"/);
  assert.match(runner, /--control-query\) CONTROL_QUERY="\$\{2#\\\?\}"/);
  assert.match(runner, /--candidate-query\) CANDIDATE_QUERY="\$\{2#\\\?\}"/);
  assert.match(runner, /ARMS="\$CONTROL_NAME,\$CANDIDATE_NAME,\$CANDIDATE_NAME,\$CONTROL_NAME"/);
  assert.match(runner, /phone-bench-install-overlay\.mjs" save-and-snooze/);
  assert.match(runner, /phone-bench-install-overlay\.mjs" restore/);
  assert.match(runner, /local entry_status=\$\?/);
  assert.match(runner, /if \[ "\$entry_status" -ne 0 \]; then exit "\$entry_status"; fi/);
  assert.match(runner, /if \[ "\$restore_failed" -ne 0 \]; then exit 1; fi/);
  assert.match(runner, /installOverlayAbsent:process\.env\.INSTALL_OVERLAY_ABSENT==="true"/);
  const overlayHelper = readFileSync(resolve("scripts/phone-bench-install-overlay.mjs"), "utf8");
  assert.match(overlayHelper, /url\.origin === expected\.origin/);
  assert.doesNotMatch(overlayHelper, /url\.port === expected\.port/);
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
  const retainedDiagnostic = { enabled: true, selected: 1, cache: { entries: 1, bytes: 1234, peakBytes: 5678 } };
  const markerRetained = {
    before: { ...retainedDiagnostic, cache: { ...retainedDiagnostic.cache, realHits: 2 } },
    after: { ...retainedDiagnostic, cache: { ...retainedDiagnostic.cache, realHits: 3 } },
    current: retainedDiagnostic,
  };
  const retainedMetric = buildMetrics(metricMeta, {
    ...metricResult,
    retainedSubtrees: markerRetained,
    census: { canvasStats: { retainedSubtrees: { cache: { bytes: 9999 } } } }
  }, metricWindow, metricTrace, ledger);
  assert.deepEqual(retainedMetric.retainedSubtrees, markerRetained);
  const censusOnlyRetainedMetric = buildMetrics(metricMeta, {
    ...metricResult,
    census: { canvasStats: { retainedSubtrees: retainedDiagnostic } }
  }, metricWindow, metricTrace, ledger);
  assert.deepEqual(censusOnlyRetainedMetric.retainedSubtrees, { before: null, after: null, current: retainedDiagnostic });
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
  assert.match(missingImageRun.stdout, /candidate metric is absent from this matrix or lacks result\/image artifacts/);

  const otherMatrix = join(root, "other-matrix");
  writeMatrix(otherMatrix);
  const wrongMatrixVisual = writeVisualReview(join(root, "visual-quality-wrong-matrix"), otherMatrix);
  const wrongMatrixRun = run(["--input", matrix], wrongMatrixVisual);
  assert.equal(wrongMatrixRun.status, 1, wrongMatrixRun.stderr);
  assert.match(wrongMatrixRun.stdout, /candidate metric is absent from this matrix/);

  const staleMatrix = join(root, "visual-quality-stale-matrix");
  writeMatrix(staleMatrix);
  const staleVisual = writeVisualReview(join(root, "visual-quality-stale"), staleMatrix);
  const staleMetric = join(staleMatrix, "idle-3.metrics.json");
  writeFileSync(staleMetric, `${readFileSync(staleMetric, "utf8")}\n`);
  const staleRun = run(["--input", staleMatrix], staleVisual);
  assert.equal(staleRun.status, 1, staleRun.stderr);
  assert.match(staleRun.stdout, /candidate metric SHA-256 does not match/);

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
  assert.deepEqual(summary.expectedOrder, arms);
  assert.equal(summary.comparison.defaultMode, true);
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

  const named = join(root, "named");
  const namedArms = ["cache-off", "cache-on", "cache-on", "cache-off"];
  const retained = retainedWindow();
  writeMatrix(named, {
    matrixArms: namedArms,
    controlName: "cache-off",
    candidateName: "cache-on",
    controlQuery: "stage=canvas&canvasSubtreeCache=off",
    candidateQuery: "stage=canvas&canvasSubtreeCache=on",
    candidateTotalMemory: 1_050,
    controlIdleFps: 70,
    retained,
  });
  const namedVisual = writeNamedVisualReview(join(root, "named-visual"), named);
  const namedOut = join(root, "named-summary.json");
  const namedRun = run(["--input", named, "--out", namedOut], namedVisual);
  assert.equal(namedRun.status, 0, `${namedRun.stderr}\n${namedRun.stdout}`);
  const namedSummary = JSON.parse(readFileSync(namedOut, "utf8"));
  assert.deepEqual(namedSummary.expectedOrder, namedArms);
  assert.deepEqual(namedSummary.comparison, {
    control: { name: "cache-off", query: "stage=canvas&canvasSubtreeCache=off" },
    candidate: { name: "cache-on", query: "stage=canvas&canvasSubtreeCache=on" },
    defaultMode: false,
    expectedOrder: namedArms,
    problems: [],
    valid: true,
  });
  assert.match(JSON.stringify(namedSummary.gates), /candidate FPS or present-p95 improves at least 5%/);
  assert.match(JSON.stringify(namedSummary.gates), /retained resident bytes ≤ 12 MiB/);
  assert.match(namedRun.stdout, /retained real-hit marker delta > 0[\s\S]*?"status": "PASS"/);
  assert.match(namedRun.stdout, /retained substituted-command marker delta > 0[\s\S]*?"status": "PASS"/);
  assert.match(namedRun.stdout, /retained composite marker delta > 0[\s\S]*?"status": "PASS"/);
  assert.match(namedRun.stdout, /idle: cache-on scene-ack p95 ≤105% of cache-off[\s\S]*?"status": "PASS"/);
  assert.ok(namedSummary.visualQuality.imagePairs.every((pair) => pair.candidate && pair.control));

  const selectorOff = join(root, "named-selector-off");
  writeMatrix(selectorOff, {
    matrixArms: namedArms,
    controlName: "cache-off",
    candidateName: "cache-on",
    controlQuery: "stage=canvas&canvasSubtreeCache=off",
    candidateQuery: "stage=canvas&canvasSubtreeCache=on",
    candidateTotalMemory: 1_050,
    controlIdleFps: 70,
    retained: retainedWindow({ enabled: false }),
  });
  const selectorOffRun = run(["--allow-fail", "--input", selectorOff], null);
  assert.equal(selectorOffRun.status, 0, selectorOffRun.stderr);
  assert.match(selectorOffRun.stdout, /retained cache enabled[\s\S]*?"status": "FAIL"/);

  const emptySelection = join(root, "named-empty-selection");
  writeMatrix(emptySelection, {
    matrixArms: namedArms,
    controlName: "cache-off",
    candidateName: "cache-on",
    controlQuery: "stage=canvas&canvasSubtreeCache=off",
    candidateQuery: "stage=canvas&canvasSubtreeCache=on",
    candidateTotalMemory: 1_050,
    controlIdleFps: 70,
    retained: retainedWindow({ selected: 0, entries: 0, bytes: 0, peakBytes: 0 }),
  });
  const emptySelectionRun = run(["--allow-fail", "--input", emptySelection], null);
  assert.equal(emptySelectionRun.status, 0, emptySelectionRun.stderr);
  assert.match(emptySelectionRun.stdout, /retained selection and live entries are nonempty[\s\S]*?"status": "FAIL"/);

  const zeroActivity = join(root, "named-zero-retained-activity");
  writeMatrix(zeroActivity, {
    matrixArms: namedArms,
    controlName: "cache-off",
    candidateName: "cache-on",
    controlQuery: "stage=canvas&canvasSubtreeCache=off",
    candidateQuery: "stage=canvas&canvasSubtreeCache=on",
    candidateTotalMemory: 1_050,
    controlIdleFps: 70,
    retained: retainedWindow({ realHitsAfter: 10, substitutedAfter: 100, compositesAfter: 10 }),
  });
  const zeroActivityRun = run(["--allow-fail", "--input", zeroActivity], null);
  assert.equal(zeroActivityRun.status, 0, zeroActivityRun.stderr);
  assert.match(zeroActivityRun.stdout, /retained real-hit marker delta > 0[\s\S]*?"status": "FAIL"/);
  assert.match(zeroActivityRun.stdout, /retained substituted-command marker delta > 0[\s\S]*?"status": "FAIL"/);
  assert.match(zeroActivityRun.stdout, /retained composite marker delta > 0[\s\S]*?"status": "FAIL"/);

  const missingRetainedWindow = join(root, "named-missing-retained-window");
  writeMatrix(missingRetainedWindow, {
    matrixArms: namedArms,
    controlName: "cache-off",
    candidateName: "cache-on",
    controlQuery: "stage=canvas&canvasSubtreeCache=off",
    candidateQuery: "stage=canvas&canvasSubtreeCache=on",
    candidateTotalMemory: 1_050,
    controlIdleFps: 70,
    retained: { before: null, after: null, current: retained.current },
  });
  const missingRetainedWindowRun = run(["--allow-fail", "--input", missingRetainedWindow], null);
  assert.equal(missingRetainedWindowRun.status, 0, missingRetainedWindowRun.stderr);
  assert.match(missingRetainedWindowRun.stdout, /retained real-hit marker delta > 0[\s\S]*?"status": "MISSING"/);

  const missingRetained = join(root, "named-missing-retained");
  writeMatrix(missingRetained, {
    matrixArms: namedArms,
    controlName: "cache-off",
    candidateName: "cache-on",
    controlQuery: "stage=canvas&canvasSubtreeCache=off",
    candidateQuery: "stage=canvas&canvasSubtreeCache=on",
    candidateTotalMemory: 1_050,
    controlIdleFps: 70,
  });
  const missingRetainedRun = run(["--allow-fail", "--input", missingRetained], null);
  assert.equal(missingRetainedRun.status, 0, missingRetainedRun.stderr);
  assert.match(missingRetainedRun.stdout, /retained resident bytes ≤ 12 MiB[\s\S]*?"status": "MISSING"/);

  const unstableNamed = join(root, "named-unstable-query");
  writeMatrix(unstableNamed, {
    matrixArms: namedArms,
    controlName: "cache-off",
    candidateName: "cache-on",
    controlQuery: "stage=canvas&canvasSubtreeCache=off",
    candidateQuery: "stage=canvas&canvasSubtreeCache=on",
    candidateTotalMemory: 1_050,
    controlIdleFps: 70,
    retained,
  });
  const unstablePath = join(unstableNamed, "dense-3.metrics.json");
  const unstable = JSON.parse(readFileSync(unstablePath, "utf8"));
  unstable.cell.query = "stage=canvas&canvasSubtreeCache=off";
  writeFileSync(unstablePath, JSON.stringify(unstable));
  const unstableRun = run(["--allow-fail", "--input", unstableNamed], null);
  assert.equal(unstableRun.status, 0, unstableRun.stderr);
  assert.match(unstableRun.stdout, /stable named ABBA arms and queries[\s\S]*?dense is not a control/);

  const noImprovement = join(root, "named-no-improvement");
  writeMatrix(noImprovement, {
    canvasFps: 60,
    matrixArms: namedArms,
    controlName: "cache-off",
    candidateName: "cache-on",
    controlQuery: "stage=canvas&canvasSubtreeCache=off",
    candidateQuery: "stage=canvas&canvasSubtreeCache=on",
    candidateTotalMemory: 1_050,
    controlIdleFps: 60,
    retained,
  });
  const noImprovementRun = run(["--allow-fail", "--input", noImprovement], null);
  assert.equal(noImprovementRun.status, 0, noImprovementRun.stderr);
  assert.match(noImprovementRun.stdout, /candidate FPS or present-p95 improves at least 5%[\s\S]*?"status": "FAIL"/);

  const presentImprovement = join(root, "named-present-improvement");
  writeMatrix(presentImprovement, {
    canvasFps: 60,
    matrixArms: namedArms,
    controlName: "cache-off",
    candidateName: "cache-on",
    controlQuery: "stage=canvas&canvasSubtreeCache=off",
    candidateQuery: "stage=canvas&canvasSubtreeCache=on",
    candidateTotalMemory: 1_050,
    controlIdleFps: 60,
    retained,
  });
  for (const workload of ["discard", "reshuffle", "dense"]) for (const sequence of [2, 3]) {
    const path = join(presentImprovement, `${workload}-${sequence}.metrics.json`);
    const metric = JSON.parse(readFileSync(path, "utf8"));
    metric.actualPresented.gapP95Ms = 19;
    writeFileSync(path, JSON.stringify(metric));
  }
  const presentVisual = writeNamedVisualReview(join(root, "named-present-visual"), presentImprovement);
  const presentRun = run(["--input", presentImprovement], presentVisual);
  assert.equal(presentRun.status, 0, `${presentRun.stderr}\n${presentRun.stdout}`);
  assert.match(presentRun.stdout, /candidate FPS or present-p95 improves at least 5%[\s\S]*?"status": "PASS"/);

  const idleRegression = join(root, "named-idle-regression");
  writeMatrix(idleRegression, {
    matrixArms: namedArms,
    controlName: "cache-off",
    candidateName: "cache-on",
    controlQuery: "stage=canvas&canvasSubtreeCache=off",
    candidateQuery: "stage=canvas&canvasSubtreeCache=on",
    candidateTotalMemory: 1_050,
    controlIdleFps: 70,
    retained,
  });
  for (const sequence of [2, 3]) {
    const path = join(idleRegression, `idle-${sequence}.metrics.json`);
    const metric = JSON.parse(readFileSync(path, "utf8"));
    metric.actualPresented.gapP95Ms = 22;
    metric.frameGaps.p95 = 22;
    metric.sceneAckLatency.p95 = 11;
    metric.cpu.rendererMainPct = 55;
    writeFileSync(path, JSON.stringify(metric));
  }
  const idleRegressionRun = run(["--allow-fail", "--input", idleRegression], null);
  assert.equal(idleRegressionRun.status, 0, idleRegressionRun.stderr);
  assert.match(idleRegressionRun.stdout, /idle: cache-on actual-presented gap p95 ≤105% of cache-off[\s\S]*?"status": "FAIL"/);
  assert.match(idleRegressionRun.stdout, /idle: cache-on scene-ack p95 ≤105% of cache-off[\s\S]*?"status": "FAIL"/);
  assert.match(idleRegressionRun.stdout, /idle: cache-on renderer-main CPU ≤105% of cache-off[\s\S]*?"status": "FAIL"/);

  const idleMissingAck = join(root, "named-idle-missing-ack");
  writeMatrix(idleMissingAck, {
    matrixArms: namedArms,
    controlName: "cache-off",
    candidateName: "cache-on",
    controlQuery: "stage=canvas&canvasSubtreeCache=off",
    candidateQuery: "stage=canvas&canvasSubtreeCache=on",
    candidateTotalMemory: 1_050,
    controlIdleFps: 70,
    retained,
  });
  for (const sequence of [2, 3]) {
    const path = join(idleMissingAck, `idle-${sequence}.metrics.json`);
    const metric = JSON.parse(readFileSync(path, "utf8"));
    delete metric.sceneAckLatency;
    writeFileSync(path, JSON.stringify(metric));
  }
  const idleMissingAckRun = run(["--allow-fail", "--input", idleMissingAck], null);
  assert.equal(idleMissingAckRun.status, 0, idleMissingAckRun.stderr);
  assert.match(idleMissingAckRun.stdout, /idle: cache-on scene-ack p95 ≤105% of cache-off[\s\S]*?"status": "MISSING"/);

  const overBudget = join(root, "named-over-budget");
  writeMatrix(overBudget, {
    matrixArms: namedArms,
    controlName: "cache-off",
    candidateName: "cache-on",
    controlQuery: "stage=canvas&canvasSubtreeCache=off",
    candidateQuery: "stage=canvas&canvasSubtreeCache=on",
    candidateTotalMemory: 1_200,
    controlIdleFps: 70,
    retained: retainedWindow({ bytes: 12 * 1024 * 1024 + 1, peakBytes: 16 * 1024 * 1024 + 1 }),
  });
  const overBudgetRun = run(["--allow-fail", "--input", overBudget], null);
  assert.equal(overBudgetRun.status, 0, overBudgetRun.stderr);
  assert.match(overBudgetRun.stdout, /retained resident bytes ≤ 12 MiB[\s\S]*?"status": "FAIL"/);
  assert.match(overBudgetRun.stdout, /Chrome process RSS within max\(10%, 64MiB\)[\s\S]*?"status": "FAIL"/);
  console.log("phone canvas benchmark summary tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
