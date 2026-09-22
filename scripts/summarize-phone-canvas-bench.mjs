#!/usr/bin/env node
// Summarize the four-cell phone DOM/canvas matrix and make every acceptance rule explicit. This is intentionally a
// gate, not a charting helper: missing evidence is a FAIL because a missing GPU CPU or scene-ack value cannot
// establish the performance claim it was meant to prove.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_ARMS = ["dom", "canvas", "canvas", "dom"];
const WORKLOAD_WEIGHTS = { idle: 0.1, discard: 0.3, reshuffle: 0.3, dense: 0.3 };

function usage() {
  console.log(`summarize-phone-canvas-bench.mjs

  node scripts/summarize-phone-canvas-bench.mjs --input <matrix-dir> [--out <summary.json>]
    --visual-quality <review.json>

Reads *.metrics.json written by analyze-phone-canvas-cell.mjs. It exits nonzero whenever an acceptance
gate is failed or evidence is missing. --allow-fail is for inspecting a deliberately failing result.

The required visual review JSON has schema ${VISUAL_QUALITY_SCHEMA}, pass/fail verdict and notes, and nonempty
imagePairs. Each pair names one canvas metric and one DOM metric from this --input matrix,
the SHA-256 of each metric and its derived ${"<label>"}.png capture, its workload, marker bounds, pass/fail
verdict, and reviewer notes. This records external human evidence; it is not an automatic pixel proof.`);
}

function parseArgs(argv) {
  const args = { input: null, out: null, staticBgStage: null, staticBgBehind: null, visualQuality: null, allowFail: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--help" || key === "-h") args.help = true;
    else if (key === "--allow-fail") args.allowFail = true;
    else if (key === "--input") args.input = argv[++i];
    else if (key === "--out") args.out = argv[++i];
    else if (key === "--visual-quality") args.visualQuality = argv[++i];
    else throw new Error(`unknown argument: ${key}`);
  }
  return args;
}

function metricFiles(dir) {
  const out = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith(".metrics.json")) out.push(child);
    }
  };
  visit(resolve(dir));
  return out.sort();
}

function loadMatrix(dir) {
  const files = metricFiles(dir);
  if (files.length === 0) throw new Error(`no *.metrics.json files under ${dir}`);
  return files.map((path) => ({ ...JSON.parse(readFileSync(path, "utf8")), path }));
}

function numberAt(value, path) {
  let current = value;
  for (const key of path.split(".")) current = current == null ? null : current[key];
  return typeof current === "number" && Number.isFinite(current) ? current : null;
}

function median(values) {
  if (values.some((x) => typeof x !== "number" || !Number.isFinite(x))) return null;
  const xs = [...values].sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const n = xs.length;
  return n % 2 ? xs[(n - 1) / 2] : (xs[n / 2 - 1] + xs[n / 2]) / 2;
}

function aggregate(rows, path) {
  const values = rows.map((row) => numberAt(row, path));
  return values.some((value) => value === null) ? null : median(values);
}

function weighted(byWorkload, path, workloads = Object.keys(WORKLOAD_WEIGHTS)) {
  let total = 0;
  let weight = 0;
  for (const workload of workloads) {
    const value = aggregate(byWorkload[workload] ?? [], path);
    const w = WORKLOAD_WEIGHTS[workload];
    if (value === null || w == null) return null;
    total += value * w;
    weight += w;
  }
  return weight > 0 ? +(total / weight).toFixed(3) : null;
}

function groupRows(rows) {
  const grouped = {};
  for (const row of rows) {
    const workload = row.cell?.workload?.id;
    const arm = row.cell?.arm;
    if (!workload || !arm) continue;
    (((grouped[workload] ??= {})[arm] ??= [])).push(row);
  }
  return grouped;
}

function gate(name, pass, detail, required = true) {
  return { name, status: pass === true ? "PASS" : pass === false ? "FAIL" : required ? "MISSING" : "SKIP", detail };
}

const VISUAL_QUALITY_SCHEMA = "phone-canvas-visual-quality-review/1";

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function expectedMarkers(row) {
  return row.phase === "idle"
    ? { before: "cc-idle-start", after: "cc-idle-end" }
    : { before: "cc-report-start", after: "cc-report-end" };
}

function rowArtifacts(row) {
  const metric = text(row?.path);
  const result = text(row?.cell?.artifacts?.result) ?? text(row?.resultPath);
  if (!metric || !result || !result.endsWith(".result.json")) return null;
  const image = `${result.slice(0, -".result.json".length)}.png`;
  try {
    if (![metric, result, image].every((path) => existsSync(path) && statSync(path).isFile() && statSync(path).size > 0)) return null;
    return { row, metric: resolve(metric), metricSha256: sha256(metric), image: resolve(image), imageSha256: sha256(image) };
  } catch {
    return null;
  }
}

function loadVisualQuality(path) {
  if (!path) return { kind: "missing" };
  const resolved = resolve(path);
  try {
    return { kind: "provided", path: resolved, review: JSON.parse(readFileSync(resolved, "utf8")) };
  } catch (error) {
    return { kind: "invalid", path: resolved, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * This validates an external human review manifest. It does not perform image
 * comparison and must never be presented as an automatic visual proof.
 */
function visualQualityGate(evidence, rows) {
  const name = "visual quality: externally reviewed scoped image pairs";
  if (!evidence || evidence.kind === "missing")
    return { gate: gate(name, null, "provide --visual-quality <review.json>"), metadata: null };
  if (evidence.kind !== "provided")
    return { gate: gate(name, false, `invalid review manifest: ${evidence.error ?? "unreadable"}`), metadata: { path: evidence.path ?? null, valid: false } };

  const review = evidence.review;
  const root = dirname(evidence.path);
  const notes = text(review?.notes);
  const verdict = review?.verdict;
  const problems = [];
  if (review?.schema !== VISUAL_QUALITY_SCHEMA) problems.push(`schema must be ${VISUAL_QUALITY_SCHEMA}`);
  if (!notes) problems.push("review notes are required");
  if (!Array.isArray(review?.imagePairs) || review.imagePairs.length === 0) problems.push("at least one reviewed image pair is required");
  if (verdict !== "pass" && verdict !== "fail") problems.push("review verdict must be pass or fail");

  const artifactsByMetric = new Map();
  for (const row of rows) {
    const artifacts = rowArtifacts(row);
    if (artifacts) artifactsByMetric.set(artifacts.metric, artifacts);
  }

  const imagePairs = [];
  const coveredWorkloads = new Set();
  for (const [index, pair] of (Array.isArray(review?.imagePairs) ? review.imagePairs : []).entries()) {
    const id = text(pair?.id);
    const pairNotes = text(pair?.notes);
    const pairVerdict = pair?.verdict;
    const workload = text(pair?.workload);
    const canvasMetric = text(pair?.canvas?.metric);
    const domMetric = text(pair?.dom?.metric);
    const canvas = canvasMetric ? artifactsByMetric.get(resolve(root, canvasMetric)) : null;
    const dom = domMetric ? artifactsByMetric.get(resolve(root, domMetric)) : null;
    if (!id) problems.push(`image pair ${index + 1} needs an id`);
    if (!pairNotes) problems.push(`image pair ${index + 1} needs notes`);
    if (pairVerdict !== "pass" && pairVerdict !== "fail") problems.push(`image pair ${index + 1} verdict must be pass or fail`);
    if (!workload || !Object.hasOwn(WORKLOAD_WEIGHTS, workload)) problems.push(`image pair ${index + 1} needs a known workload`);
    if (!canvas) problems.push(`image pair ${index + 1} canvas metric is absent from this matrix or lacks result/image artifacts`);
    if (!dom) problems.push(`image pair ${index + 1} DOM metric is absent from this matrix or lacks result/image artifacts`);
    if (canvas && canvas.row.cell?.arm !== "canvas") problems.push(`image pair ${index + 1} canvas metric is not a canvas arm`);
    if (dom && dom.row.cell?.arm !== "dom") problems.push(`image pair ${index + 1} DOM metric is not a DOM arm`);
    if (canvas && dom && canvas.row.cell?.workload?.id !== dom.row.cell?.workload?.id) problems.push(`image pair ${index + 1} canvas and DOM workloads differ`);
    if (canvas && workload !== canvas.row.cell?.workload?.id) problems.push(`image pair ${index + 1} workload does not match the canvas metric`);
    if (canvas && dom && canvas.image === dom.image) problems.push(`image pair ${index + 1} must use distinct canvas and DOM captures`);
    if (canvas && pair?.canvas?.metricSha256 !== canvas.metricSha256) problems.push(`image pair ${index + 1} canvas metric SHA-256 does not match`);
    if (dom && pair?.dom?.metricSha256 !== dom.metricSha256) problems.push(`image pair ${index + 1} DOM metric SHA-256 does not match`);
    if (canvas && pair?.canvas?.imageSha256 !== canvas.imageSha256) problems.push(`image pair ${index + 1} canvas image SHA-256 does not match`);
    if (dom && pair?.dom?.imageSha256 !== dom.imageSha256) problems.push(`image pair ${index + 1} DOM image SHA-256 does not match`);
    const marker = pair?.marker;
    const expected = canvas ? expectedMarkers(canvas.row) : null;
    if (!expected || marker?.before !== expected.before || marker?.after !== expected.after)
      problems.push(`image pair ${index + 1} marker bounds do not match the canvas phase`);
    if (canvas && dom && JSON.stringify(expectedMarkers(canvas.row)) !== JSON.stringify(expectedMarkers(dom.row)))
      problems.push(`image pair ${index + 1} canvas and DOM marker bounds differ`);
    if (canvas && dom && workload === canvas.row.cell?.workload?.id && canvas.row.cell?.workload?.id === dom.row.cell?.workload?.id)
      coveredWorkloads.add(workload);
    imagePairs.push({ id: id ?? null, workload: workload ?? null, verdict: pairVerdict ?? null, notes: pairNotes ?? null,
      canvas: canvas && { metric: canvas.metric, metricSha256: canvas.metricSha256, image: canvas.image, imageSha256: canvas.imageSha256 },
      dom: dom && { metric: dom.metric, metricSha256: dom.metricSha256, image: dom.image, imageSha256: dom.imageSha256 } });
  }
  if (verdict === "pass") {
    const missing = Object.keys(WORKLOAD_WEIGHTS).filter((workload) => !coveredWorkloads.has(workload));
    if (missing.length) problems.push(`passing review is missing workload coverage: ${missing.join(", ")}`);
  }
  const metadata = { path: evidence.path, schema: review?.schema ?? null, verdict: verdict ?? null,
    notes: notes ?? null, imagePairs, coveredWorkloads: [...coveredWorkloads].sort(), valid: problems.length === 0 };
  if (problems.length)
    return { gate: gate(name, false, `invalid review manifest: ${problems.join("; ")}`), metadata };
  const passed = verdict === "pass" && imagePairs.every((pair) => pair.verdict === "pass");
  return { gate: gate(name, passed,
    `externally authored review verdict ${verdict}; ${imagePairs.length} scoped image pair${imagePairs.length === 1 ? "" : "s"} (automatic pixel comparison is not claimed)`), metadata };
}

function atMost(candidate, reference, multiplier) {
  if (candidate === null || reference === null) return null;
  return candidate <= reference * multiplier;
}

function atLeast(candidate, reference, multiplier) {
  if (candidate === null || reference === null) return null;
  return candidate >= reference * multiplier;
}

function healthFailure(row) {
  const health = row.health;
  if (!health) return "missing cell health record";
  if (health.thermalThrottle !== false) return "missing/failed thermal evidence";
  const bad = ["lmk", "contextLoss", "processRestart", "assetFailure", "pageCrash", "thermalThrottle"].filter((key) => health[key] !== false);
  if (typeof health.benchExit !== "number") bad.push("missing bench exit status");
  else if (health.benchExit !== 0) bad.push(`bench exit ${health.benchExit}`);
  if (health.foregroundPre !== true) bad.push("missing/failed pre-cell foreground proof");
  if (health.foregroundPost !== true) bad.push("missing/failed post-cell foreground proof");
  if (bad.length) return bad.join(", ");
  return null;
}

function sameValue(values) {
  if (!values.length || values.some((value) => value == null)) return null;
  return new Set(values.map((value) => JSON.stringify(value))).size === 1;
}

function validateComparability(rows) {
  const gates = [];
  const byWorkload = groupRows(rows);
  for (const workload of Object.keys(WORKLOAD_WEIGHTS)) {
    const cells = Object.values(byWorkload[workload] ?? {}).flat();
    const recordings = cells.map((row) => row.cell?.workload?.recording ?? null);
    gates.push(gate(`recording invariant: ${workload}`, sameValue(recordings),
      sameValue(recordings) === null ? "recording path missing" : `${recordings[0] ?? "missing"}`));
  }
  const display = rows.map((row) => ({ viewport: row.display?.viewport ?? null, dpr: row.display?.devicePixelRatio ?? null }));
  gates.push(gate("display invariant: identical viewport and DPR", sameValue(display.filter((d) => d.viewport !== null && d.dpr !== null).length === display.length ? display : []),
    sameValue(display.filter((d) => d.viewport !== null && d.dpr !== null).length === display.length ? display : []) === null ? "viewport/DPR missing" : JSON.stringify(display[0])));
  const run = rows.map((row) => row.cell?.run ?? null);
  // The frozen-effect rung is spelled `very-low` since the quality ladder was renamed (it was `static`). BOTH
  // are accepted here so cells recorded before the rename still satisfy their own gate and stay comparable.
  const frozenQuality = (q) => q === "very-low" || q === "static";
  const staticRun = run.length && run.every((r) => r?.repeats === 1 && r.effects === "on" && r.effectMode === "static" && frozenQuality(r.quality));
  gates.push(gate("fidelity invariant: one repeat, static quality/effects", run.length ? staticRun : null,
    staticRun ? "all cells use repeats=1, effects=on/static, quality=very-low" : "missing or non-static run configuration"));
  for (const row of rows) {
    gates.push(gate(`metric contract: ${row.cell?.label ?? "unknown"}`, row.schema === "phone-canvas-cell-metrics/2",
      row.schema === "phone-canvas-cell-metrics/2" ? "surface-attributed presentation contract" : `requires phone-canvas-cell-metrics/2; got ${row.schema ?? "missing"}`));
    const arm = row.cell?.arm;
    const expected = arm === "dom" ? "stage=dom" : arm === "canvas" ? "stage=canvas&paintDump=1" : null;
    gates.push(gate(`query invariant: ${row.cell?.label ?? `${row.cell?.workload?.id ?? "?"}/${arm ?? "?"}`}`,
      expected === null ? null : row.cell?.query === expected,
      `expected ${expected ?? "unrecognized arm"}; got ${row.cell?.query ?? "missing"}`));
    const expectedPhase = row.cell?.workload?.id === "idle" ? "idle" : "active";
    const bounded = row.phase === expectedPhase && typeof row.traceWindow?.windowMs === "number" && row.traceWindow.windowMs > 0;
    gates.push(gate(`marker window: ${row.cell?.label ?? `${row.cell?.workload?.id ?? "?"}/${arm ?? "?"}`}`,
      bounded, bounded ? `${row.traceWindow.windowMs}ms ${row.phase}` : "missing or wrong marker-bounded trace window"));
    const submitted = row.submitted;
    gates.push(gate(`submitted DrawFrame cadence: ${row.cell?.label ?? `${row.cell?.workload?.id ?? "?"}/${arm ?? "?"}`}`,
      typeof submitted?.fps === "number" && submitted.fps > 0 && typeof submitted?.count === "number" && submitted.count > 2 && submitted?.source === "drawframe",
      submitted ? `${submitted.source ?? "missing source"}; ${submitted.fps ?? "missing"} fps; ${submitted.count ?? "missing"} frames` : "missing"));
    const actual = row.actualPresented;
    gates.push(gate(`actual presentation attribution: ${row.cell?.label ?? `${row.cell?.workload?.id ?? "?"}/${arm ?? "?"}`}`,
      typeof actual?.fps === "number" && actual.fps > 0 && typeof actual?.gapP95Ms === "number" && actual.gapP95Ms > 0 &&
        typeof actual?.count === "number" && actual.count > 2 && typeof actual?.surface === "string" &&
        /^(perfetto-frame-timeline-actual|surface-presentation-feedback)$/.test(actual?.provenance?.source ?? ""),
      actual ? `${actual.provenance?.source ?? "missing source"}; surface ${actual.surface ?? "missing"}; ${actual.fps ?? "missing"} fps; p95 ${actual.gapP95Ms ?? "missing"}ms` : "missing"));
  }
  return gates;
}

function stabilityGate(rows, label = "") {
  const allHealth = rows.map(healthFailure).filter(Boolean);
  return gate(`${label}stability: no LMK/context/process/asset failure`, allHealth.length === 0,
    allHealth.length ? allHealth.join("; ") : "all cell health records clear");
}

function validateOrder(rows) {
  const gates = [];
  const byWorkload = new Map();
  for (const row of rows) {
    const workload = row.cell?.workload?.id;
    if (!workload) continue;
    if (!byWorkload.has(workload)) byWorkload.set(workload, []);
    byWorkload.get(workload).push(row);
  }
  for (const [workload, cells] of byWorkload) {
    const ordered = [...cells].sort((a, b) => (a.cell?.sequence ?? Infinity) - (b.cell?.sequence ?? Infinity));
    const actual = ordered.map((row) => row.cell?.arm);
    const ok = actual.length === EXPECTED_ARMS.length && actual.every((arm, i) => arm === EXPECTED_ARMS[i]);
    gates.push(gate(`matrix order: ${workload}`, ok, `expected ${EXPECTED_ARMS.join(" → ")}; got ${actual.join(" → ") || "none"}`));
  }
  for (const workload of Object.keys(WORKLOAD_WEIGHTS)) {
    if (!byWorkload.has(workload)) gates.push(gate(`matrix order: ${workload}`, null, "workload missing"));
  }
  return gates;
}

function buildSummary(rows, visualQualityEvidence = null) {
  const gates = [...validateOrder(rows), ...validateComparability(rows), stabilityGate(rows)];
  const visualQuality = visualQualityGate(visualQualityEvidence, rows);
  gates.push(visualQuality.gate);
  const grouped = groupRows(rows);

  const idle = grouped.idle ?? {};
  const idleCanvas = idle.canvas ?? [];
  const idleDom = idle.dom ?? [];
  const idleFps = aggregate(idleCanvas, "actualPresented.fps");
  const idleRenderer = aggregate(idleCanvas, "cpu.rendererMainPct");
  const idleDomRenderer = aggregate(idleDom, "cpu.rendererMainPct");
  const idleGpu = aggregate(idleCanvas, "cpu.gpuProcessPct");
  const idleDomGpu = aggregate(idleDom, "cpu.gpuProcessPct");
  gates.push(gate("idle: canvas actual-presented fps ≥ 60", idleFps === null ? null : idleFps >= 60, `canvas ${idleFps ?? "missing"} fps`));
  gates.push(gate("idle: canvas renderer-main CPU ≥10% below DOM", atMost(idleRenderer, idleDomRenderer, 0.9), `canvas ${idleRenderer ?? "missing"}% vs DOM ${idleDomRenderer ?? "missing"}%`));
  gates.push(gate("idle: canvas GPU-process CPU ≥10% below DOM", atMost(idleGpu, idleDomGpu, 0.9), `canvas ${idleGpu ?? "missing"}% vs DOM ${idleDomGpu ?? "missing"}%`));

  const activeWorkloads = ["discard", "reshuffle", "dense"];
  for (const workload of activeWorkloads) {
    const canvas = grouped[workload]?.canvas ?? [];
    const dom = grouped[workload]?.dom ?? [];
    const canvasFps = aggregate(canvas, "actualPresented.fps");
    const domFps = aggregate(dom, "actualPresented.fps");
    const canvasActualP95 = aggregate(canvas, "actualPresented.gapP95Ms");
    const domActualP95 = aggregate(dom, "actualPresented.gapP95Ms");
    const canvasGap = aggregate(canvas, "frameGaps.p95");
    const domGap = aggregate(dom, "frameGaps.p95");
    const canvasAck = aggregate(canvas, "sceneAckLatency.p95");
    const domAck = aggregate(dom, "sceneAckLatency.p95");
    const canvasRenderer = aggregate(canvas, "cpu.rendererMainPct");
    const domRenderer = aggregate(dom, "cpu.rendererMainPct");
    const canvasGpu = aggregate(canvas, "cpu.gpuProcessPct");
    const domGpu = aggregate(dom, "cpu.gpuProcessPct");
    gates.push(gate(`${workload}: canvas actual-presented rate ≥95% of DOM`, atLeast(canvasFps, domFps, 0.95), `canvas ${canvasFps ?? "missing"} fps vs DOM ${domFps ?? "missing"} fps`));
    gates.push(gate(`${workload}: canvas rAF frame-gap p95 ≤105% of DOM`, atMost(canvasGap, domGap, 1.05), `canvas ${canvasGap ?? "missing"}ms vs DOM ${domGap ?? "missing"}ms`));
    gates.push(gate(`${workload}: canvas actual-presented gap p95 ≤105% of DOM`, atMost(canvasActualP95, domActualP95, 1.05), `canvas ${canvasActualP95 ?? "missing"}ms vs DOM ${domActualP95 ?? "missing"}ms`));
    gates.push(gate(`${workload}: canvas scene-ack p95 ≤105% of DOM`, atMost(canvasAck, domAck, 1.05), `canvas ${canvasAck ?? "missing"}ms vs DOM ${domAck ?? "missing"}ms`));
    gates.push(gate(`${workload}: canvas renderer-main CPU does not regress`, atMost(canvasRenderer, domRenderer, 1), `canvas ${canvasRenderer ?? "missing"}% vs DOM ${domRenderer ?? "missing"}%`));
    gates.push(gate(`${workload}: canvas GPU-process CPU does not regress`, atMost(canvasGpu, domGpu, 1), `canvas ${canvasGpu ?? "missing"}% vs DOM ${domGpu ?? "missing"}%`));
  }

  const activeCanvas = Object.fromEntries(activeWorkloads.map((workload) => [workload, grouped[workload]?.canvas ?? []]));
  const activeDom = Object.fromEntries(activeWorkloads.map((workload) => [workload, grouped[workload]?.dom ?? []]));
  const activeCanvasRenderer = weighted(activeCanvas, "cpu.rendererMainPct", activeWorkloads);
  const activeDomRenderer = weighted(activeDom, "cpu.rendererMainPct", activeWorkloads);
  const activeCanvasGpu = weighted(activeCanvas, "cpu.gpuProcessPct", activeWorkloads);
  const activeDomGpu = weighted(activeDom, "cpu.gpuProcessPct", activeWorkloads);
  gates.push(gate("active weighted: canvas renderer-main CPU ≥10% below DOM", atMost(activeCanvasRenderer, activeDomRenderer, 0.9), `canvas ${activeCanvasRenderer ?? "missing"}% vs DOM ${activeDomRenderer ?? "missing"}%`));
  gates.push(gate("active weighted: canvas GPU-process CPU ≥10% below DOM", atMost(activeCanvasGpu, activeDomGpu, 0.9), `canvas ${activeCanvasGpu ?? "missing"}% vs DOM ${activeDomGpu ?? "missing"}%`));

  for (const workload of Object.keys(WORKLOAD_WEIGHTS)) {
    const canvas = grouped[workload]?.canvas ?? [];
    const dom = grouped[workload]?.dom ?? [];
    // The acceptance limit is for the added GPU-process footprint. Renderer/browser RSS is recorded for
    // diagnosis, but must not make this GPU-memory gate pass or fail.
    const canvasMem = aggregate(canvas, "memoryMb.gpu");
    const domMem = aggregate(dom, "memoryMb.gpu");
    const allowance = domMem === null ? null : Math.max(domMem * 0.1, 64);
    gates.push(gate(`${workload}: canvas GPU memory within max(10%, 64MiB) of DOM`, canvasMem === null || domMem === null ? null : canvasMem <= domMem + allowance, `canvas GPU ${canvasMem ?? "missing"}MiB vs DOM GPU ${domMem ?? "missing"}MiB (allowance ${allowance ?? "missing"}MiB)`));
  }

  return {
    schema: "phone-canvas-bench-summary/2",
    expectedOrder: EXPECTED_ARMS,
    weights: WORKLOAD_WEIGHTS,
    cells: rows.length,
    visualQuality: visualQuality.metadata,
    gates,
    passed: gates.every((row) => row.status === "PASS"),
    aggregate: {
      idle: { fps: idleFps, rendererCpuPct: idleRenderer, gpuCpuPct: idleGpu },
      active: {
        canvasRendererCpuPct: activeCanvasRenderer,
        domRendererCpuPct: activeDomRenderer,
        canvasGpuCpuPct: activeCanvasGpu,
        domGpuCpuPct: activeDomGpu
      }
    }
  };
}

export { EXPECTED_ARMS, WORKLOAD_WEIGHTS, VISUAL_QUALITY_SCHEMA, buildSummary, groupRows, weighted };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  if (!args.input) {
    usage();
    process.exit(2);
  }
  const summary = buildSummary(loadMatrix(args.input), loadVisualQuality(args.visualQuality));
  const output = `${JSON.stringify(summary, null, 2)}\n`;
  if (args.out) writeFileSync(args.out, output);
  process.stdout.write(output);
  if (!summary.passed && !args.allowFail) process.exitCode = 1;
} catch (error) {
  console.error(`summarize-phone-canvas-bench: ${error?.stack ?? error}`);
  process.exitCode = 2;
}
