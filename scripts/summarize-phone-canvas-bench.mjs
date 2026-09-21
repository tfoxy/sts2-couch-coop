#!/usr/bin/env node
// Summarize the four-cell phone DOM/canvas matrix and make every acceptance rule explicit. This is intentionally a
// gate, not a charting helper: missing evidence is a FAIL because a missing GPU CPU or scene-ack value cannot
// establish the performance claim it was meant to prove.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_ARMS = ["dom", "canvas", "canvas", "dom"];
const DEFAULT_COMPARISON = Object.freeze({
  control: Object.freeze({ name: "dom", query: "stage=dom" }),
  candidate: Object.freeze({ name: "canvas", query: "stage=canvas&paintDump=1" }),
});
const RETAINED_RESIDENT_LIMIT_BYTES = 12 * 1024 * 1024;
const RETAINED_PEAK_LIMIT_BYTES = 16 * 1024 * 1024;
const WORKLOAD_WEIGHTS = { idle: 0.1, discard: 0.3, reshuffle: 0.3, dense: 0.3 };

function usage() {
  console.log(`summarize-phone-canvas-bench.mjs

  node scripts/summarize-phone-canvas-bench.mjs --input <matrix-dir> [--out <summary.json>]
    --visual-quality <review.json>

Reads *.metrics.json written by analyze-phone-canvas-cell.mjs. It exits nonzero whenever an acceptance
gate is failed or evidence is missing. --allow-fail is for inspecting a deliberately failing result.

The required visual review JSON has schema ${VISUAL_QUALITY_SCHEMA}, pass/fail verdict and notes, and nonempty
imagePairs. Each pair names one candidate metric and one control metric from this --input matrix
(the original canvas/DOM keys remain valid for the default comparison),
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

function allEvidence(rows, read, accept) {
  if (rows.length === 0) return null;
  const values = rows.map(read);
  if (values.some((value) => value === null || value === undefined)) return null;
  return values.every(accept);
}

function positiveMarkerDelta(rows, path) {
  return allEvidence(rows, (row) => {
    const before = numberAt(row, `retainedSubtrees.before.${path}`);
    const after = numberAt(row, `retainedSubtrees.after.${path}`);
    return before === null || after === null ? null : after - before;
  }, (delta) => delta > 0);
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

function inferComparison(rows) {
  const problems = [];
  let control = null;
  let candidate = null;
  for (const workload of Object.keys(WORKLOAD_WEIGHTS)) {
    const ordered = rows
      .filter((row) => row.cell?.workload?.id === workload)
      .sort((a, b) => (a.cell?.sequence ?? Infinity) - (b.cell?.sequence ?? Infinity));
    if (ordered.length !== 4 || ordered.some((row, index) => row.cell?.sequence !== index + 1)) {
      problems.push(`${workload} must contain sequences 1,2,3,4 exactly once`);
      continue;
    }
    const observed = ordered.map((row) => ({ name: text(row.cell?.arm), query: text(row.cell?.query) }));
    if (observed.some((arm) => !arm.name || !arm.query)) {
      problems.push(`${workload} has a missing arm name or query`);
      continue;
    }
    if (JSON.stringify(observed[0]) !== JSON.stringify(observed[3]) ||
        JSON.stringify(observed[1]) !== JSON.stringify(observed[2])) {
      problems.push(`${workload} is not a control → candidate → candidate → control ABBA`);
      continue;
    }
    if (observed[0].name === observed[1].name) {
      problems.push(`${workload} control and candidate names must differ`);
      continue;
    }
    control ??= observed[0];
    candidate ??= observed[1];
    if (JSON.stringify(control) !== JSON.stringify(observed[0]) ||
        JSON.stringify(candidate) !== JSON.stringify(observed[1])) {
      problems.push(`${workload} arm names/queries differ from the other workloads`);
    }
  }
  const defaultMode = JSON.stringify(control) === JSON.stringify(DEFAULT_COMPARISON.control) &&
    JSON.stringify(candidate) === JSON.stringify(DEFAULT_COMPARISON.candidate);
  return {
    control,
    candidate,
    defaultMode,
    expectedOrder: control && candidate ? [control.name, candidate.name, candidate.name, control.name] : [],
    problems,
    valid: control !== null && candidate !== null && problems.length === 0,
  };
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
function visualQualityGate(evidence, rows, comparison) {
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
    // Preserve the original DOM/canvas manifest while allowing named query
    // experiments to describe the same roles without lying about their stage.
    const candidateSpec = pair?.candidate ?? pair?.canvas;
    const controlSpec = pair?.control ?? pair?.dom;
    const candidateMetric = text(candidateSpec?.metric);
    const controlMetric = text(controlSpec?.metric);
    const candidate = candidateMetric ? artifactsByMetric.get(resolve(root, candidateMetric)) : null;
    const control = controlMetric ? artifactsByMetric.get(resolve(root, controlMetric)) : null;
    if (!id) problems.push(`image pair ${index + 1} needs an id`);
    if (!pairNotes) problems.push(`image pair ${index + 1} needs notes`);
    if (pairVerdict !== "pass" && pairVerdict !== "fail") problems.push(`image pair ${index + 1} verdict must be pass or fail`);
    if (!workload || !Object.hasOwn(WORKLOAD_WEIGHTS, workload)) problems.push(`image pair ${index + 1} needs a known workload`);
    if (!candidate) problems.push(`image pair ${index + 1} candidate metric is absent from this matrix or lacks result/image artifacts`);
    if (!control) problems.push(`image pair ${index + 1} control metric is absent from this matrix or lacks result/image artifacts`);
    if (candidate && candidate.row.cell?.arm !== comparison.candidate?.name) problems.push(`image pair ${index + 1} candidate metric is not a ${comparison.candidate?.name ?? "known candidate"} arm`);
    if (control && control.row.cell?.arm !== comparison.control?.name) problems.push(`image pair ${index + 1} control metric is not a ${comparison.control?.name ?? "known control"} arm`);
    if (candidate && control && candidate.row.cell?.workload?.id !== control.row.cell?.workload?.id) problems.push(`image pair ${index + 1} candidate and control workloads differ`);
    if (candidate && workload !== candidate.row.cell?.workload?.id) problems.push(`image pair ${index + 1} workload does not match the candidate metric`);
    if (candidate && control && candidate.image === control.image) problems.push(`image pair ${index + 1} must use distinct candidate and control captures`);
    if (candidate && candidateSpec?.metricSha256 !== candidate.metricSha256) problems.push(`image pair ${index + 1} candidate metric SHA-256 does not match`);
    if (control && controlSpec?.metricSha256 !== control.metricSha256) problems.push(`image pair ${index + 1} control metric SHA-256 does not match`);
    if (candidate && candidateSpec?.imageSha256 !== candidate.imageSha256) problems.push(`image pair ${index + 1} candidate image SHA-256 does not match`);
    if (control && controlSpec?.imageSha256 !== control.imageSha256) problems.push(`image pair ${index + 1} control image SHA-256 does not match`);
    const marker = pair?.marker;
    const expected = candidate ? expectedMarkers(candidate.row) : null;
    if (!expected || marker?.before !== expected.before || marker?.after !== expected.after)
      problems.push(`image pair ${index + 1} marker bounds do not match the candidate phase`);
    if (candidate && control && JSON.stringify(expectedMarkers(candidate.row)) !== JSON.stringify(expectedMarkers(control.row)))
      problems.push(`image pair ${index + 1} candidate and control marker bounds differ`);
    if (candidate && control && workload === candidate.row.cell?.workload?.id && candidate.row.cell?.workload?.id === control.row.cell?.workload?.id)
      coveredWorkloads.add(workload);
    const candidateArtifact = candidate && { metric: candidate.metric, metricSha256: candidate.metricSha256, image: candidate.image, imageSha256: candidate.imageSha256 };
    const controlArtifact = control && { metric: control.metric, metricSha256: control.metricSha256, image: control.image, imageSha256: control.imageSha256 };
    imagePairs.push(comparison.defaultMode
      ? { id: id ?? null, workload: workload ?? null, verdict: pairVerdict ?? null, notes: pairNotes ?? null,
          canvas: candidateArtifact, dom: controlArtifact }
      : { id: id ?? null, workload: workload ?? null, verdict: pairVerdict ?? null, notes: pairNotes ?? null,
          candidate: candidateArtifact, control: controlArtifact });
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
  if (health.installOverlayAbsent !== true) bad.push("Install overlay present or unmeasured at marker boundary");
  if (bad.length) return bad.join(", ");
  return null;
}

function sameValue(values) {
  if (!values.length || values.some((value) => value == null)) return null;
  return new Set(values.map((value) => JSON.stringify(value))).size === 1;
}

function validateComparability(rows, comparison) {
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
  const staticRun = run.length && run.every((r) => r?.repeats === 1 && r.effects === "on" && r.effectMode === "static" && r.quality === "static");
  gates.push(gate("fidelity invariant: one repeat, static quality/effects", run.length ? staticRun : null,
    staticRun ? "all cells use repeats=1, effects=on/static, quality=static" : "missing or non-static run configuration"));
  for (const row of rows) {
    gates.push(gate(`metric contract: ${row.cell?.label ?? "unknown"}`, row.schema === "phone-canvas-cell-metrics/2",
      row.schema === "phone-canvas-cell-metrics/2" ? "surface-attributed presentation contract" : `requires phone-canvas-cell-metrics/2; got ${row.schema ?? "missing"}`));
    const arm = row.cell?.arm;
    const expected = arm === comparison.control?.name
      ? comparison.control.query
      : arm === comparison.candidate?.name
        ? comparison.candidate.query
        : null;
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

function validateOrder(rows, comparison) {
  const gates = [];
  gates.push(gate("matrix contract: stable named ABBA arms and queries", comparison.valid,
    comparison.valid
      ? `${comparison.control.name} (${comparison.control.query}) → ${comparison.candidate.name} (${comparison.candidate.query}) → ${comparison.candidate.name} → ${comparison.control.name}`
      : comparison.problems.join("; ") || "matrix has no inferable comparison"));
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
    const expected = comparison.expectedOrder;
    const ok = expected.length === 4 && actual.length === expected.length && actual.every((arm, i) => arm === expected[i]);
    gates.push(gate(`matrix order: ${workload}`, ok, `expected ${expected.join(" → ") || "stable ABBA"}; got ${actual.join(" → ") || "none"}`));
  }
  for (const workload of Object.keys(WORKLOAD_WEIGHTS)) {
    if (!byWorkload.has(workload)) gates.push(gate(`matrix order: ${workload}`, null, "workload missing"));
  }
  return gates;
}

function buildSummary(rows, visualQualityEvidence = null) {
  const comparison = inferComparison(rows);
  const gates = [...validateOrder(rows, comparison), ...validateComparability(rows, comparison), stabilityGate(rows)];
  const visualQuality = visualQualityGate(visualQualityEvidence, rows, comparison);
  gates.push(visualQuality.gate);
  const grouped = groupRows(rows);

  const idle = grouped.idle ?? {};
  const candidateName = comparison.candidate?.name;
  const controlName = comparison.control?.name;
  const idleCandidate = candidateName ? idle[candidateName] ?? [] : [];
  const idleControl = controlName ? idle[controlName] ?? [] : [];
  const idleFps = aggregate(idleCandidate, "actualPresented.fps");
  const idleRenderer = aggregate(idleCandidate, "cpu.rendererMainPct");
  const idleControlRenderer = aggregate(idleControl, "cpu.rendererMainPct");
  const idleGpu = aggregate(idleCandidate, "cpu.gpuProcessPct");
  const idleControlGpu = aggregate(idleControl, "cpu.gpuProcessPct");
  const idlePresentP95 = aggregate(idleCandidate, "actualPresented.gapP95Ms");
  const idleControlPresentP95 = aggregate(idleControl, "actualPresented.gapP95Ms");
  const idleGap = aggregate(idleCandidate, "frameGaps.p95");
  const idleControlGap = aggregate(idleControl, "frameGaps.p95");
  const idleAck = aggregate(idleCandidate, "sceneAckLatency.p95");
  const idleControlAck = aggregate(idleControl, "sceneAckLatency.p95");
  const idleControlFps = aggregate(idleControl, "actualPresented.fps");
  if (comparison.defaultMode) {
    gates.push(gate("idle: canvas actual-presented fps ≥ 60", idleFps === null ? null : idleFps >= 60, `canvas ${idleFps ?? "missing"} fps`));
    gates.push(gate("idle: canvas renderer-main CPU ≥10% below DOM", atMost(idleRenderer, idleControlRenderer, 0.9), `canvas ${idleRenderer ?? "missing"}% vs DOM ${idleControlRenderer ?? "missing"}%`));
    gates.push(gate("idle: canvas GPU-process CPU ≥10% below DOM", atMost(idleGpu, idleControlGpu, 0.9), `canvas ${idleGpu ?? "missing"}% vs DOM ${idleControlGpu ?? "missing"}%`));
  } else {
    gates.push(gate(`idle: ${candidateName ?? "candidate"} actual-presented fps ≥ 60`, idleFps === null ? null : idleFps >= 60,
      `${candidateName ?? "candidate"} ${idleFps ?? "missing"} fps`));
    gates.push(gate(`idle: ${candidateName ?? "candidate"} actual-presented rate ≥95% of ${controlName ?? "control"}`,
      atLeast(idleFps, idleControlFps, 0.95), `${candidateName ?? "candidate"} ${idleFps ?? "missing"} fps vs ${controlName ?? "control"} ${idleControlFps ?? "missing"} fps`));
    gates.push(gate(`idle: ${candidateName ?? "candidate"} actual-presented gap p95 ≤105% of ${controlName ?? "control"}`,
      atMost(idlePresentP95, idleControlPresentP95, 1.05), `${candidateName ?? "candidate"} ${idlePresentP95 ?? "missing"}ms vs ${controlName ?? "control"} ${idleControlPresentP95 ?? "missing"}ms`));
    gates.push(gate(`idle: ${candidateName ?? "candidate"} rAF frame-gap p95 ≤105% of ${controlName ?? "control"}`,
      atMost(idleGap, idleControlGap, 1.05), `${candidateName ?? "candidate"} ${idleGap ?? "missing"}ms vs ${controlName ?? "control"} ${idleControlGap ?? "missing"}ms`));
    gates.push(gate(`idle: ${candidateName ?? "candidate"} scene-ack p95 ≤105% of ${controlName ?? "control"}`,
      atMost(idleAck, idleControlAck, 1.05), `${candidateName ?? "candidate"} ${idleAck ?? "missing"}ms vs ${controlName ?? "control"} ${idleControlAck ?? "missing"}ms`));
    gates.push(gate(`idle: ${candidateName ?? "candidate"} renderer-main CPU ≤105% of ${controlName ?? "control"}`,
      atMost(idleRenderer, idleControlRenderer, 1.05), `${candidateName ?? "candidate"} ${idleRenderer ?? "missing"}% vs ${controlName ?? "control"} ${idleControlRenderer ?? "missing"}%`));
    gates.push(gate(`idle: ${candidateName ?? "candidate"} GPU-process CPU ≥10% below ${controlName ?? "control"}`,
      atMost(idleGpu, idleControlGpu, 0.9), `${candidateName ?? "candidate"} ${idleGpu ?? "missing"}% vs ${controlName ?? "control"} ${idleControlGpu ?? "missing"}%`));
  }

  const activeWorkloads = ["discard", "reshuffle", "dense"];
  for (const workload of activeWorkloads) {
    const candidate = candidateName ? grouped[workload]?.[candidateName] ?? [] : [];
    const control = controlName ? grouped[workload]?.[controlName] ?? [] : [];
    const candidateFps = aggregate(candidate, "actualPresented.fps");
    const controlFps = aggregate(control, "actualPresented.fps");
    const candidateActualP95 = aggregate(candidate, "actualPresented.gapP95Ms");
    const controlActualP95 = aggregate(control, "actualPresented.gapP95Ms");
    const candidateGap = aggregate(candidate, "frameGaps.p95");
    const controlGap = aggregate(control, "frameGaps.p95");
    const candidateAck = aggregate(candidate, "sceneAckLatency.p95");
    const controlAck = aggregate(control, "sceneAckLatency.p95");
    const candidateRenderer = aggregate(candidate, "cpu.rendererMainPct");
    const controlRenderer = aggregate(control, "cpu.rendererMainPct");
    const candidateGpu = aggregate(candidate, "cpu.gpuProcessPct");
    const controlGpu = aggregate(control, "cpu.gpuProcessPct");
    const names = comparison.defaultMode ? { candidate: "canvas", control: "DOM" } : { candidate: candidateName ?? "candidate", control: controlName ?? "control" };
    gates.push(gate(`${workload}: ${names.candidate} actual-presented rate ≥95% of ${names.control}`, atLeast(candidateFps, controlFps, 0.95), `${names.candidate} ${candidateFps ?? "missing"} fps vs ${names.control} ${controlFps ?? "missing"} fps`));
    gates.push(gate(`${workload}: ${names.candidate} rAF frame-gap p95 ≤105% of ${names.control}`, atMost(candidateGap, controlGap, 1.05), `${names.candidate} ${candidateGap ?? "missing"}ms vs ${names.control} ${controlGap ?? "missing"}ms`));
    gates.push(gate(`${workload}: ${names.candidate} actual-presented gap p95 ≤105% of ${names.control}`, atMost(candidateActualP95, controlActualP95, 1.05), `${names.candidate} ${candidateActualP95 ?? "missing"}ms vs ${names.control} ${controlActualP95 ?? "missing"}ms`));
    gates.push(gate(`${workload}: ${names.candidate} scene-ack p95 ≤105% of ${names.control}`, atMost(candidateAck, controlAck, 1.05), `${names.candidate} ${candidateAck ?? "missing"}ms vs ${names.control} ${controlAck ?? "missing"}ms`));
    gates.push(gate(`${workload}: ${names.candidate} renderer-main CPU ${comparison.defaultMode ? "does not regress" : "≤105% of " + names.control}`,
      atMost(candidateRenderer, controlRenderer, comparison.defaultMode ? 1 : 1.05), `${names.candidate} ${candidateRenderer ?? "missing"}% vs ${names.control} ${controlRenderer ?? "missing"}%`));
    gates.push(gate(`${workload}: ${names.candidate} GPU-process CPU ${comparison.defaultMode ? "does not regress" : "≤105% of " + names.control}`,
      atMost(candidateGpu, controlGpu, comparison.defaultMode ? 1 : 1.05), `${names.candidate} ${candidateGpu ?? "missing"}% vs ${names.control} ${controlGpu ?? "missing"}%`));
  }

  const activeCandidate = Object.fromEntries(activeWorkloads.map((workload) => [workload, candidateName ? grouped[workload]?.[candidateName] ?? [] : []]));
  const activeControl = Object.fromEntries(activeWorkloads.map((workload) => [workload, controlName ? grouped[workload]?.[controlName] ?? [] : []]));
  const activeCandidateRenderer = weighted(activeCandidate, "cpu.rendererMainPct", activeWorkloads);
  const activeControlRenderer = weighted(activeControl, "cpu.rendererMainPct", activeWorkloads);
  const activeCandidateGpu = weighted(activeCandidate, "cpu.gpuProcessPct", activeWorkloads);
  const activeControlGpu = weighted(activeControl, "cpu.gpuProcessPct", activeWorkloads);
  const activeCandidateFps = weighted(activeCandidate, "actualPresented.fps", activeWorkloads);
  const activeControlFps = weighted(activeControl, "actualPresented.fps", activeWorkloads);
  const activeCandidatePresentP95 = weighted(activeCandidate, "actualPresented.gapP95Ms", activeWorkloads);
  const activeControlPresentP95 = weighted(activeControl, "actualPresented.gapP95Ms", activeWorkloads);
  if (comparison.defaultMode) {
    gates.push(gate("active weighted: canvas renderer-main CPU ≥10% below DOM", atMost(activeCandidateRenderer, activeControlRenderer, 0.9), `canvas ${activeCandidateRenderer ?? "missing"}% vs DOM ${activeControlRenderer ?? "missing"}%`));
    gates.push(gate("active weighted: canvas GPU-process CPU ≥10% below DOM", atMost(activeCandidateGpu, activeControlGpu, 0.9), `canvas ${activeCandidateGpu ?? "missing"}% vs DOM ${activeControlGpu ?? "missing"}%`));
  } else {
    const fpsImproved = atLeast(activeCandidateFps, activeControlFps, 1.05);
    const presentImproved = atMost(activeCandidatePresentP95, activeControlPresentP95, 0.95);
    const improvement = fpsImproved === null || presentImproved === null ? null : fpsImproved || presentImproved;
    gates.push(gate("active weighted: candidate FPS or present-p95 improves at least 5%", improvement,
      `${candidateName ?? "candidate"} ${activeCandidateFps ?? "missing"} fps / ${activeCandidatePresentP95 ?? "missing"}ms vs ${controlName ?? "control"} ${activeControlFps ?? "missing"} fps / ${activeControlPresentP95 ?? "missing"}ms`));
  }

  for (const workload of Object.keys(WORKLOAD_WEIGHTS)) {
    const candidate = candidateName ? grouped[workload]?.[candidateName] ?? [] : [];
    const control = controlName ? grouped[workload]?.[controlName] ?? [] : [];
    const memoryPath = comparison.defaultMode ? "memoryMb.gpu" : "memoryMb.total";
    const candidateMem = aggregate(candidate, memoryPath);
    const controlMem = aggregate(control, memoryPath);
    const allowance = controlMem === null ? null : Math.max(controlMem * 0.1, 64);
    const memoryLabel = comparison.defaultMode ? "GPU memory" : "Chrome process RSS";
    gates.push(gate(`${workload}: ${comparison.defaultMode ? "canvas" : candidateName ?? "candidate"} ${memoryLabel} within max(10%, 64MiB) of ${comparison.defaultMode ? "DOM" : controlName ?? "control"}`,
      candidateMem === null || controlMem === null ? null : candidateMem <= controlMem + allowance,
      `${candidateName ?? "candidate"} ${candidateMem ?? "missing"}MiB vs ${controlName ?? "control"} ${controlMem ?? "missing"}MiB (allowance ${allowance ?? "missing"}MiB)`));
    if (!comparison.defaultMode) {
      const resident = candidate.map((row) => numberAt(row, "retainedSubtrees.current.cache.bytes"));
      const peak = candidate.map((row) => numberAt(row, "retainedSubtrees.current.cache.peakBytes"));
      const residentMax = resident.length > 0 && resident.every((value) => value !== null) ? Math.max(...resident) : null;
      const peakMax = peak.length > 0 && peak.every((value) => value !== null) ? Math.max(...peak) : null;
      const retainedEnabled = allEvidence(candidate, (row) => row.retainedSubtrees?.current?.enabled, (enabled) => enabled === true);
      const retainedSelected = allEvidence(candidate, (row) => numberAt(row, "retainedSubtrees.current.selected"), (selected) => selected > 0);
      const retainedEntries = allEvidence(candidate, (row) => numberAt(row, "retainedSubtrees.current.cache.entries"), (entries) => entries > 0);
      const realHits = positiveMarkerDelta(candidate, "cache.realHits");
      const substitutions = positiveMarkerDelta(candidate, "execution.substitutedCommands");
      const composites = positiveMarkerDelta(candidate, "cache.composites");
      gates.push(gate(`${workload}: retained cache enabled`, retainedEnabled, "every candidate marker current.enabled must be true"));
      gates.push(gate(`${workload}: retained selection and live entries are nonempty`,
        retainedSelected === null || retainedEntries === null ? null : retainedSelected && retainedEntries,
        "every candidate cell must report current.selected > 0 and current.cache.entries > 0"));
      gates.push(gate(`${workload}: retained real-hit marker delta > 0`, realHits, "every candidate cell must increase cache.realHits between markers"));
      gates.push(gate(`${workload}: retained substituted-command marker delta > 0`, substitutions, "every candidate cell must increase execution.substitutedCommands between markers"));
      gates.push(gate(`${workload}: retained composite marker delta > 0`, composites, "every candidate cell must increase cache.composites between markers"));
      gates.push(gate(`${workload}: retained resident bytes ≤ 12 MiB`, residentMax === null ? null : residentMax <= RETAINED_RESIDENT_LIMIT_BYTES,
        `max ${residentMax ?? "missing"} bytes`));
      gates.push(gate(`${workload}: retained peak bytes ≤ 16 MiB`, peakMax === null ? null : peakMax <= RETAINED_PEAK_LIMIT_BYTES,
        `max ${peakMax ?? "missing"} bytes`));
    }
  }

  return {
    schema: "phone-canvas-bench-summary/2",
    comparison,
    expectedOrder: comparison.expectedOrder,
    weights: WORKLOAD_WEIGHTS,
    cells: rows.length,
    visualQuality: visualQuality.metadata,
    gates,
    passed: gates.every((row) => row.status === "PASS"),
    aggregate: {
      idle: { fps: idleFps, rendererCpuPct: idleRenderer, gpuCpuPct: idleGpu },
      active: {
        candidateFps: activeCandidateFps,
        controlFps: activeControlFps,
        candidatePresentP95Ms: activeCandidatePresentP95,
        controlPresentP95Ms: activeControlPresentP95,
        candidateRendererCpuPct: activeCandidateRenderer,
        controlRendererCpuPct: activeControlRenderer,
        candidateGpuCpuPct: activeCandidateGpu,
        controlGpuCpuPct: activeControlGpu,
        ...(comparison.defaultMode ? {
          canvasRendererCpuPct: activeCandidateRenderer,
          domRendererCpuPct: activeControlRenderer,
          canvasGpuCpuPct: activeCandidateGpu,
          domGpuCpuPct: activeControlGpu,
        } : {})
      }
    }
  };
}

export { EXPECTED_ARMS, DEFAULT_COMPARISON, WORKLOAD_WEIGHTS, VISUAL_QUALITY_SCHEMA, buildSummary, groupRows, inferComparison, weighted };

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
