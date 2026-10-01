// Shaping + aggregation for the shared `perf-report/1` envelope
// (godot-scene-web `docs/perf-report-contract.md`, profile `browser-render`).
//
// `perf-report/1` couples its three emitting repos by JSON SHAPE ONLY — the one
// shared code surface is `pnpm perf -- validate-report`. So this file
// re-implements the envelope rather than importing godot-scene-web's
// `report.ts`. The median / worst-case rules, the geometry block and the
// nullable-ratio invariant are all ports of
// `packages/perf-harness/src/{report,fit}.ts`; the cross-repo contract test
// (`scripts/test-perf-report-validate.mjs`) checks the output of THIS file
// against the real validator.

export const REPORT_SCHEMA = "perf-report/1";

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

/** Port of fit.ts `orientationOf`. */
export function orientationOf({ width, height }) {
  if (!(width > 0) || !(height > 0)) return "square";
  if (width > height) return "landscape";
  return width < height ? "portrait" : "square";
}

const roundTo = (v, digits) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/**
 * Build the contract `env.geometry` block from what the launched page reported.
 *
 * @param {object} reads
 * @param {{width:number,height:number}} reads.viewport      window.innerWidth/innerHeight, CSS px
 * @param {number} reads.devicePixelRatio                    window.devicePixelRatio
 * @param {{width:number,height:number}} reads.designBox     the mirror's un-transformed design box
 *        (`.mirror-stage` offsetWidth/offsetHeight — already includes the >16:9 widening)
 * @param {{width:number,height:number}} reads.stageRect     `.mirror-stage` getBoundingClientRect
 *        size (the design box AFTER the letterbox `transform: scale()`)
 * @param {string|null} reads.emulatedViewport               the forced viewport string, or null
 *        when the browser's own viewport was used (connect mode)
 * @returns {object} ReportGeometry
 */
export function buildGeometry({ viewport, devicePixelRatio, designBox, stageRect, emulatedViewport }) {
  for (const [name, size] of [
    ["viewport", viewport],
    ["designBox", designBox],
    ["stageRect", stageRect],
  ]) {
    if (!size || !(size.width > 0) || !(size.height > 0)) {
      throw new Error(`buildGeometry: ${name} must be a {width>0,height>0}, got ${JSON.stringify(size)}`);
    }
  }
  if (!(devicePixelRatio > 0)) {
    throw new Error(`buildGeometry: devicePixelRatio must be > 0, got ${devicePixelRatio}`);
  }

  const scaleX = stageRect.width / designBox.width;
  const scaleY = stageRect.height / designBox.height;
  if (Math.abs(scaleX - scaleY) > 1e-3) {
    throw new Error(
      `buildGeometry: stage is not uniformly scaled (x=${scaleX.toFixed(5)} y=${scaleY.toFixed(5)}) — ` +
        "the mirror letterbox should apply ONE scale; a non-uniform stage means the geometry read is wrong",
    );
  }

  let fitScale = roundTo((scaleX + scaleY) / 2, 6);
  const fit = Math.abs(fitScale - 1) > 1e-6;
  if (!fit) fitScale = 1; // validator: fit === false MUST carry fitScale exactly 1

  return {
    viewport: { width: viewport.width, height: viewport.height },
    devicePixelRatio,
    orientation: orientationOf(viewport),
    fit,
    fitScale,
    stage: { width: designBox.width, height: designBox.height },
    fittedStage: {
      width: roundTo(stageRect.width, 2),
      height: roundTo(stageRect.height, 2),
    },
    grid: null, // the mirror is one composited scene, not a cell grid
    emulatedViewport: emulatedViewport ?? null,
  };
}

/**
 * Port of fit.ts `sameGeometry` for two ReportGeometry blocks: SCALE and STAGE
 * only, deliberately not the viewport (browser chrome moves innerHeight between
 * repeats without changing the raster scale).
 */
export function sameGeometry(a, b, epsilon = 1e-3) {
  return (
    !!a &&
    !!b &&
    Math.abs(a.fitScale - b.fitScale) <= epsilon &&
    Math.abs(a.stage.width - b.stage.width) <= 1 &&
    Math.abs(a.stage.height - b.stage.height) <= 1
  );
}

// ---------------------------------------------------------------------------
// aggregation
// ---------------------------------------------------------------------------

export function medianOf(values) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// 4 SIGNIFICANT DIGITS, not decimal places — a fully parked main thread reads
// near 0.003 and a 2-decimal round would print it as 0 (== "not measured").
const sig4 = (v) => (v === null ? null : Number(v.toPrecision(4)));

const at = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** median of `path` across runs, to 4 sig-dig; throws if `required` and nothing was finite. */
function med(runs, path, { required = false } = {}) {
  const m = medianOf(runs.map((r) => at(r, path)));
  if (m === null && required) {
    throw new Error(`medianMetrics: required metric "${path}" was not finite in any accepted repeat`);
  }
  return sig4(m ?? 0);
}

const maxOf = (runs, path) => Math.max(...runs.map((r) => Number(at(r, path)) || 0));
const minOf = (runs, path) => Math.min(...runs.map((r) => Number(at(r, path)) || 0));

const BRIDGE_COUNTERS = [
  "pageDecodes", "pageDecodeFailed", "pageDecodeMs", "pageOwnedUploads",
  "pageElementUploads", "uploads", "uploadMs",
];

/** Build the only legal direct-canvas decode evidence. Never coerce bad samples to zero. */
export function canvasTextureBridgeWindow(before, after) {
  const id = before?.instance?.id;
  if (!Number.isInteger(id) || id <= 0 || after?.instance?.id !== id) return null;
  const sampleWindowMs = after.sampledAtMs - before.sampledAtMs;
  if (!Number.isFinite(sampleWindowMs) || sampleWindowMs <= 0) return null;
  const out = { source: "canvas.textureBridge.window", instanceId: id, sampleWindowMs };
  for (const field of BRIDGE_COUNTERS) {
    const a = before[field], b = after[field];
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
    out[field] = b - a;
  }
  return out;
}

function medianBridgeWindow(runs) {
  const windows = runs.map((r) => r.decode?.bridgeWindow);
  if (windows.some((w) => !w || w.source !== "canvas.textureBridge.window" || !Number.isInteger(w.instanceId) || w.instanceId <= 0 ||
    !Number.isFinite(w.sampleWindowMs) || w.sampleWindowMs <= 0 || BRIDGE_COUNTERS.some((field) => !Number.isFinite(w[field]) || w[field] < 0))) {
    throw new Error("medianMetrics: canvas-texture-bridge run has invalid bridgeWindow evidence");
  }
  const representative = windows[Math.floor(windows.length / 2)];
  const pick = (field) => sig4(medianOf(windows.map((w) => w[field])));
  return {
    source: "canvas.textureBridge.window",
    instanceId: representative.instanceId,
    sampleWindowMs: pick("sampleWindowMs"),
    pageDecodes: pick("pageDecodes"),
    pageDecodeFailed: Math.max(...windows.map((w) => w.pageDecodeFailed)),
    pageDecodeMs: pick("pageDecodeMs"),
    pageOwnedUploads: pick("pageOwnedUploads"),
    pageElementUploads: Math.max(...windows.map((w) => w.pageElementUploads)),
    uploads: pick("uploads"),
    uploadMs: pick("uploadMs"),
  };
}

function medStat(runs, path) {
  return {
    p50: med(runs, `${path}.p50`),
    p95: med(runs, `${path}.p95`),
    max: med(runs, `${path}.max`),
  };
}

/**
 * Median the cross-process `cpu` block. Port of report.ts `medianCpu`:
 * `byProcess` / `byThread` are medianed PER key over the repeats that carried
 * that key, not taken from one representative repeat.
 */
export function medianCpu(cpus) {
  const list = cpus.filter(Boolean);
  if (list.length === 0) return null;

  const processKeys = new Set();
  for (const c of list) for (const k of Object.keys(c.byProcess ?? {})) processKeys.add(k);
  const byProcess = {};
  for (const key of processKeys) {
    const present = list.map((c) => c.byProcess[key]).filter(Boolean);
    byProcess[key] = {
      cpuMs: sig4(medianOf(present.map((e) => e.cpuMs))),
      wallMs: sig4(medianOf(present.map((e) => e.wallMs))),
      coreRatio: sig4(medianOf(present.map((e) => e.coreRatio))),
      threads: Math.round(medianOf(present.map((e) => e.threads)) ?? 0),
      processes: Math.round(medianOf(present.map((e) => e.processes)) ?? 0),
    };
  }

  const rowKeys = new Map();
  for (const c of list) {
    for (const row of c.byThread ?? []) {
      rowKeys.set(`${row.process} ${row.thread}`, { process: row.process, thread: row.thread });
    }
  }
  const byThread = [...rowKeys.entries()]
    .map(([key, id]) => {
      const present = list
        .map((c) => (c.byThread ?? []).find((r) => `${r.process} ${r.thread}` === key))
        .filter(Boolean);
      return {
        ...id,
        cpuMs: sig4(medianOf(present.map((r) => r.cpuMs))),
        wallMs: sig4(medianOf(present.map((r) => r.wallMs))),
        coreRatio: sig4(medianOf(present.map((r) => r.coreRatio))),
        instances: Math.round(medianOf(present.map((r) => r.instances)) ?? 0),
      };
    })
    .sort((a, b) => b.cpuMs - a.cpuMs || b.wallMs - a.wallMs);

  return {
    windowMs: sig4(medianOf(list.map((c) => c.windowMs))),
    totalCpuMs: sig4(medianOf(list.map((c) => c.totalCpuMs))),
    totalCoreRatio: sig4(medianOf(list.map((c) => c.totalCoreRatio))),
    cpuCoverage: sig4(medianOf(list.map((c) => c.cpuCoverage))),
    byProcess,
    byThread,
  };
}

/**
 * Median across the accepted repeats, field by field. Worst-case (not median)
 * for the two failure signals: `decode.inRasterCount` / `decode.inRasterMs`
 * (max) and `presented.sampleHits` (min).
 */
export function medianMetrics(runs) {
  if (runs.length === 0) throw new Error("medianMetrics: no accepted repeats");
  const rep = runs[Math.floor(runs.length / 2)];

  // nullable ratio: drop the runs that measured nothing; if NONE measured it the
  // aggregate is null too, and the sample count is taken over the backing runs so
  // the `ratio === null <=> samples === 0` invariant survives aggregation.
  const measured = runs.filter((r) => typeof r.mainThreadCpuRatio === "number" && r.mainThreadCpuRatio !== null);
  const mainThreadCpuRatio = measured.length === 0 ? null : sig4(medianOf(measured.map((r) => r.mainThreadCpuRatio)));
  const mainThreadCpuSamples =
    measured.length === 0 ? 0 : sig4(medianOf(measured.map((r) => r.mainThreadCpuSamples)) ?? 0);

  const bridge = runs[0].decode?.provenance === "canvas-texture-bridge";
  if (runs.some((r) => (r.decode?.provenance === "canvas-texture-bridge") !== bridge)) {
    throw new Error("medianMetrics: cannot combine cc-trace and canvas-texture-bridge evidence");
  }
  const decodeUnmeasured = !bridge && runs.every((r) => r.decode?.provenance === "trace-unmeasured");
  const decode = bridge
    ? {
        count: 0, totalMs: 0, maxMs: 0, codecRuns: 0, codecMs: 0,
        distinctImages: 0, redecodeCount: 0, redecodeMs: 0, inRasterCount: 0, inRasterMs: 0,
        imageKey: "none", cacheFamily: "unknown", imagesExpected: true,
        provenance: "canvas-texture-bridge", source: "canvas.textureBridge.window", codecSource: null,
        bridgeWindow: medianBridgeWindow(runs),
      }
    : decodeUnmeasured
      ? {
          count: null, totalMs: null, maxMs: null, codecRuns: null, codecMs: null,
          distinctImages: null, redecodeCount: null, redecodeMs: null, inRasterCount: null, inRasterMs: null,
          imageKey: null, cacheFamily: rep.decode?.cacheFamily ?? "unknown", imagesExpected: true,
          provenance: "trace-unmeasured", source: null, codecSource: null,
          unmeasuredReason: rep.decode?.unmeasuredReason ?? "no canonical image-decode events in the marker window",
        }
      : {
      count: med(runs, "decode.count"), totalMs: med(runs, "decode.totalMs"), maxMs: med(runs, "decode.maxMs"),
      codecRuns: med(runs, "decode.codecRuns"), codecMs: med(runs, "decode.codecMs"),
      distinctImages: med(runs, "decode.distinctImages"), redecodeCount: med(runs, "decode.redecodeCount"),
      redecodeMs: med(runs, "decode.redecodeMs"), inRasterCount: maxOf(runs, "decode.inRasterCount"),
      inRasterMs: maxOf(runs, "decode.inRasterMs"), imageKey: rep.decode?.imageKey ?? null,
      cacheFamily: rep.decode?.cacheFamily ?? "unknown", imagesExpected: rep.decode?.imagesExpected ?? true,
      source: rep.decode?.source ?? null, codecSource: rep.decode?.codecSource ?? null,
    };
  return {
    initialRenderMs: med(runs, "initialRenderMs", { required: true }),
    readyMs: med(runs, "readyMs", { required: true }),
    windowMs: med(runs, "windowMs", { required: true }),
    contentUpdateHz: med(runs, "contentUpdateHz", { required: true }),
    swapRateHz: med(runs, "swapRateHz"),
    swapCount: med(runs, "swapCount"),
    activationCount: med(runs, "activationCount"),
    activationGapMs: {
      ...medStat(runs, "activationGapMs"),
      over100msCount: med(runs, "activationGapMs.over100msCount"),
      count: med(runs, "activationGapMs.count"),
    },
    frameCostMs: medStat(runs, "frameCostMs"),
    tickMs: {
      ...medStat(runs, "tickMs"),
      count: med(runs, "tickMs.count"),
      totalMs: med(runs, "tickMs.totalMs"),
    },
    blockedMs: med(runs, "blockedMs"),
    mainThreadBusyMs: med(runs, "mainThreadBusyMs"),
    mainThreadCpuRatio,
    mainThreadCpuSamples,
    longTaskCount: med(runs, "longTaskCount"),
    longAnimationFrames: med(runs, "longAnimationFrames"),
    rasterMs: med(runs, "rasterMs"),
    decode,
    paint: {
      count: med(runs, "paint.count"),
      distinctUrls: med(runs, "paint.distinctUrls"),
      maxSourceMegapixels: med(runs, "paint.maxSourceMegapixels"),
      maxSourceToPaintedRatio: med(runs, "paint.maxSourceToPaintedRatio"),
    },
    rasterTasks: med(runs, "rasterTasks"),
    renderSurfaces: med(runs, "renderSurfaces"),
    renderSurfaceReasons: rep.renderSurfaceReasons ?? {},
    renderSurfaceListPasses: med(runs, "renderSurfaceListPasses"),
    renderSurfacesScope: rep.renderSurfacesScope ?? null,
    layerCount: med(runs, "layerCount"),
    cpu: medianCpu(runs.map((r) => r.cpu)),
    presented: {
      nonEmptyRatio: med(runs, "presented.nonEmptyRatio"),
      // WORST CASE: the lowest hit count across repeats.
      sampleHits: minOf(runs, "presented.sampleHits"),
      sampleCount: rep.presented?.sampleCount ?? 0,
      screenshot: rep.presented?.screenshot ?? "",
    },
    // provenance for the compositor-frames-presented count that USED to be
    // (wrongly) called `presented`.
    presentedFrames: med(runs, "presentedFrames"),
    presentedFramesSource: rep.presentedFramesSource ?? null,
  };
}

// ---------------------------------------------------------------------------
// envelope
// ---------------------------------------------------------------------------

const CONTRACT_METRIC_KEYS = [
  "initialRenderMs",
  "readyMs",
  "windowMs",
  "contentUpdateHz",
  "swapRateHz",
  "activationCount",
  "activationGapMs",
  "frameCostMs",
  "blockedMs",
  "mainThreadBusyMs",
  "mainThreadCpuRatio",
  "mainThreadCpuSamples",
  "longTaskCount",
  "longAnimationFrames",
  "rasterMs",
  "decode",
  "paint",
  "renderSurfaces",
  "renderSurfaceListPasses",
  "layerCount",
  "cpu",
  "presented",
];

/**
 * Assemble the full `perf-report/1` envelope from the ACCEPTED per-repeat report
 * objects (each already carrying `cpu`, `geometry`, `presented`, and all the
 * trace-derived metric fields).
 *
 * @param {object} input
 * @param {object[]} input.runs       accepted per-repeat report objects (>= 1)
 * @param {string[]} input.failures   one descriptive line per discarded / crashed repeat
 * @param {object} input.env          { kind, label, cpuThrottle, device } — geometry is added here
 * @param {object} input.params
 * @param {object} input.artifacts    { trace, screenshot } — both must be string paths
 * @param {string} input.scenario
 * @param {number} input.warmups
 * @returns {object} the envelope, ready for `JSON.stringify` + `validate-report`
 */
export function buildPerfReport({ runs, failures = [], env, params, artifacts, scenario, warmups = 1 }) {
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new Error("buildPerfReport: need at least one accepted measured repeat");
  }
  if (!env || typeof env.label !== "string" || env.label.length === 0) {
    throw new Error("buildPerfReport: env.label must be a non-empty string");
  }
  if (typeof artifacts?.trace !== "string" || typeof artifacts?.screenshot !== "string") {
    throw new Error("buildPerfReport: artifacts.trace and artifacts.screenshot must be string paths");
  }

  // Geometry is LOCKED to repeat 0; the caller has already discarded any repeat
  // whose geometry drifted (sameGeometry), so every accepted run agrees.
  const geometry = runs[0].geometry;
  if (!geometry) throw new Error("buildPerfReport: runs[0] carries no geometry block");

  const metrics = medianMetrics(runs);

  // aggregate/per-run schema consistency: every contract metric key the
  // aggregate carries must exist on every per-repeat object too.
  const cleanRuns = runs.map((r) => {
    const { geometry: _g, __discard: _d, ...rest } = r;
    return rest;
  });
  for (const run of cleanRuns) {
    for (const key of CONTRACT_METRIC_KEYS) {
      if (!(key in run)) {
        throw new Error(`buildPerfReport: accepted repeat is missing contract metric "${key}"`);
      }
    }
  }

  const envelope = {
    schema: REPORT_SCHEMA,
    repo: "sts2-couch-coop",
    profile: "browser-render",
    scenario,
    env: { ...env, geometry },
    params,
    repeats: cleanRuns.length,
    warmups,
    metrics,
    runs: cleanRuns,
    artifacts: { ...artifacts },
  };
  if (failures.length > 0) envelope.failures = failures;
  return envelope;
}
