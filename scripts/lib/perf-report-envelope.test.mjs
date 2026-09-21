import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGeometry,
  buildPerfReport,
  canvasTextureBridgeWindow,
  medianCpu,
  medianMetrics,
  medianOf,
  orientationOf,
  sameGeometry,
} from "./perf-report-envelope.mjs";
import {
  syntheticArtifacts,
  syntheticEnv,
  syntheticParams,
  syntheticRun,
} from "./perf-report-envelope.fixture.mjs";

// --------------------------------------------------------------------------
// geometry
// --------------------------------------------------------------------------

test("buildGeometry: a fitted landscape stage", () => {
  const g = buildGeometry({
    viewport: { width: 2100, height: 900 },
    devicePixelRatio: 1,
    designBox: { width: 2100, height: 1080 },
    stageRect: { width: 1750, height: 900 },
    emulatedViewport: "2100x900",
  });
  assert.equal(g.orientation, "landscape");
  assert.equal(g.fit, true);
  assert.ok(Math.abs(g.fitScale - 1750 / 2100) < 1e-6);
  assert.deepEqual(g.stage, { width: 2100, height: 1080 });
  assert.equal(g.grid, null);
  assert.equal(g.emulatedViewport, "2100x900");
});

test("buildGeometry: fit === false carries fitScale exactly 1", () => {
  const g = buildGeometry({
    viewport: { width: 800, height: 1200 },
    devicePixelRatio: 2,
    designBox: { width: 1000, height: 1500 },
    stageRect: { width: 1000, height: 1500 },
    emulatedViewport: null,
  });
  assert.equal(g.fit, false);
  assert.equal(g.fitScale, 1);
  assert.equal(g.orientation, "portrait");
  assert.equal(g.emulatedViewport, null);
});

test("buildGeometry: rejects a non-uniformly-scaled stage", () => {
  assert.throws(
    () =>
      buildGeometry({
        viewport: { width: 2100, height: 900 },
        devicePixelRatio: 1,
        designBox: { width: 2100, height: 1080 },
        stageRect: { width: 1750, height: 700 }, // x-scale 0.833, y-scale 0.648
        emulatedViewport: "2100x900",
      }),
    /not uniformly scaled/,
  );
});

test("buildGeometry: rejects a zero dimension", () => {
  assert.throws(
    () =>
      buildGeometry({
        viewport: { width: 0, height: 900 },
        devicePixelRatio: 1,
        designBox: { width: 2100, height: 1080 },
        stageRect: { width: 2100, height: 1080 },
        emulatedViewport: null,
      }),
    /viewport must be/,
  );
});

test("orientationOf", () => {
  assert.equal(orientationOf({ width: 100, height: 50 }), "landscape");
  assert.equal(orientationOf({ width: 50, height: 100 }), "portrait");
  assert.equal(orientationOf({ width: 100, height: 100 }), "square");
});

test("sameGeometry compares scale + stage, ignores viewport", () => {
  const a = buildGeometry({
    viewport: { width: 2100, height: 900 },
    devicePixelRatio: 1,
    designBox: { width: 2100, height: 1080 },
    stageRect: { width: 1750, height: 900 },
    emulatedViewport: "2100x900",
  });
  const b = buildGeometry({
    viewport: { width: 2100, height: 851 }, // URL bar moved
    devicePixelRatio: 1,
    designBox: { width: 2100, height: 1080 },
    stageRect: { width: 1750, height: 900 },
    emulatedViewport: "2100x900",
  });
  assert.ok(sameGeometry(a, b));
  const c = { ...a, fitScale: a.fitScale * 1.5 };
  assert.ok(!sameGeometry(a, c));
});

// --------------------------------------------------------------------------
// aggregation
// --------------------------------------------------------------------------

test("medianOf ignores non-finite and returns null when empty", () => {
  assert.equal(medianOf([1, 2, 3]), 2);
  assert.equal(medianOf([1, 2, 3, 4]), 2.5);
  assert.equal(medianOf([NaN, null, undefined, 5]), 5);
  assert.equal(medianOf([]), null);
});

test("medianCpu medians byThread rows over the repeats that carried them", () => {
  const cpus = [
    {
      windowMs: 12000,
      totalCpuMs: 800,
      totalCoreRatio: 0.066,
      cpuCoverage: 0.97,
      byProcess: { renderer: { cpuMs: 600, wallMs: 700, coreRatio: 0.05, threads: 20, processes: 1 } },
      byThread: [{ process: "Renderer", thread: "CrRendererMain", cpuMs: 160, wallMs: 170, coreRatio: 0.013, instances: 1 }],
    },
    {
      windowMs: 12000,
      totalCpuMs: 820,
      totalCoreRatio: 0.068,
      cpuCoverage: 0.96,
      byProcess: { renderer: { cpuMs: 620, wallMs: 720, coreRatio: 0.051, threads: 20, processes: 1 } },
      byThread: [
        { process: "Renderer", thread: "CrRendererMain", cpuMs: 170, wallMs: 180, coreRatio: 0.014, instances: 1 },
        { process: "GPU Process", thread: "CrGpuMain", cpuMs: 30, wallMs: 60, coreRatio: 0.0025, instances: 1 },
      ],
    },
  ];
  const m = medianCpu(cpus);
  assert.equal(m.totalCpuMs, 810);
  const main = m.byThread.find((r) => r.thread === "CrRendererMain");
  assert.equal(main.cpuMs, 165);
  const gpu = m.byThread.find((r) => r.thread === "CrGpuMain");
  assert.equal(gpu.cpuMs, 30); // only one repeat carried it — its single reading
});

test("medianMetrics: worst-case for inRasterCount and presented.sampleHits", () => {
  const runs = [
    syntheticRun({ decode: { ...syntheticRun().decode, inRasterCount: 0, inRasterMs: 0 } }),
    syntheticRun({ decode: { ...syntheticRun().decode, inRasterCount: 3, inRasterMs: 12.4 } }),
    syntheticRun({ presented: { nonEmptyRatio: 0.7, sampleHits: 30, sampleCount: 32, screenshot: "x.png" } }),
  ];
  const m = medianMetrics(runs);
  assert.equal(m.decode.inRasterCount, 3, "max across repeats, not median");
  assert.equal(m.decode.inRasterMs, 12.4);
  assert.equal(m.presented.sampleHits, 30, "min across repeats");
});

test("medianMetrics: nullable ratio drops null repeats, keeps the invariant", () => {
  const runs = [
    syntheticRun({ mainThreadCpuRatio: null, mainThreadCpuSamples: 0 }),
    syntheticRun({ mainThreadCpuRatio: 0.004, mainThreadCpuSamples: 60 }),
    syntheticRun({ mainThreadCpuRatio: 0.006, mainThreadCpuSamples: 62 }),
  ];
  const m = medianMetrics(runs);
  assert.equal(m.mainThreadCpuRatio, 0.005);
  assert.equal(m.mainThreadCpuSamples, 61);

  const allNull = [
    syntheticRun({ mainThreadCpuRatio: null, mainThreadCpuSamples: 0 }),
    syntheticRun({ mainThreadCpuRatio: null, mainThreadCpuSamples: 0 }),
  ];
  const m2 = medianMetrics(allNull);
  assert.equal(m2.mainThreadCpuRatio, null);
  assert.equal(m2.mainThreadCpuSamples, 0);
});

test("medianMetrics: a required metric absent in every repeat throws (no misleading zero)", () => {
  const runs = [syntheticRun({ contentUpdateHz: null }), syntheticRun({ contentUpdateHz: undefined })];
  assert.throws(() => medianMetrics(runs), /contentUpdateHz/);
});

test("canvasTextureBridgeWindow: only one positive renderer lifetime can supply bridge evidence", () => {
  const before = { instance: { id: 7 }, sampledAtMs: 10, pageDecodes: 1, pageDecodeFailed: 0, pageDecodeMs: 2, pageOwnedUploads: 1, pageElementUploads: 0, uploads: 1, uploadMs: 1 };
  const after = { instance: { id: 7 }, sampledAtMs: 30, pageDecodes: 3, pageDecodeFailed: 1, pageDecodeMs: 6, pageOwnedUploads: 3, pageElementUploads: 0, uploads: 3, uploadMs: 4 };
  assert.deepEqual(canvasTextureBridgeWindow(before, after), {
    source: "canvas.textureBridge.window", instanceId: 7, sampleWindowMs: 20,
    pageDecodes: 2, pageDecodeFailed: 1, pageDecodeMs: 4, pageOwnedUploads: 2,
    pageElementUploads: 0, uploads: 2, uploadMs: 3,
  });
  assert.equal(canvasTextureBridgeWindow(before, { ...after, instance: { id: 8 } }), null);
  assert.equal(canvasTextureBridgeWindow(before, { ...after, pageDecodeMs: 1 }), null);
});

test("medianMetrics: bridge evidence keeps trace fields zero and aggregates bridge counters", () => {
  const bridge = (id, failed, elements) => syntheticRun({ decode: {
    count: 0, totalMs: 0, maxMs: 0, codecRuns: 0, codecMs: 0, distinctImages: 0, redecodeCount: 0,
    redecodeMs: 0, inRasterCount: 0, inRasterMs: 0, cacheFamily: "unknown", imagesExpected: true,
    provenance: "canvas-texture-bridge", source: "canvas.textureBridge.window", codecSource: null,
    bridgeWindow: { source: "canvas.textureBridge.window", instanceId: id, sampleWindowMs: 1000, pageDecodes: 2, pageDecodeFailed: failed, pageDecodeMs: 4, pageOwnedUploads: 2, pageElementUploads: elements, uploads: 2, uploadMs: 3 },
  }});
  const metrics = medianMetrics([bridge(7, 0, 0), bridge(8, 1, 2)]);
  assert.equal(metrics.decode.totalMs, 0);
  assert.equal(metrics.decode.provenance, "canvas-texture-bridge");
  assert.equal(metrics.decode.bridgeWindow.pageDecodeFailed, 1);
  assert.equal(metrics.decode.bridgeWindow.pageElementUploads, 2);
});

// --------------------------------------------------------------------------
// buildPerfReport
// --------------------------------------------------------------------------

test("buildPerfReport: 5 accepted repeats, no failures", () => {
  const runs = Array.from({ length: 5 }, () => syntheticRun());
  const report = buildPerfReport({
    runs,
    failures: [],
    env: syntheticEnv(),
    params: syntheticParams(),
    artifacts: syntheticArtifacts(),
    scenario: "mirror-replay-combat",
    warmups: 1,
  });
  assert.equal(report.schema, "perf-report/1");
  assert.equal(report.repo, "sts2-couch-coop");
  assert.equal(report.profile, "browser-render");
  assert.equal(report.repeats, 5);
  assert.equal(report.warmups, 1);
  assert.equal(report.runs.length, 5);
  assert.ok(!("failures" in report));
  assert.ok(report.env.geometry, "geometry attached to env");
  // per-run objects do not carry the geometry block (it lives on env)
  assert.ok(!("geometry" in report.runs[0]));
  assert.ok(!("__discard" in report.runs[0]));
  // params extensions preserved
  assert.ok("censusCanvasStats" in report.params);
  assert.ok("processMemory" in report.params);
});

test("buildPerfReport: failed repeats are excluded and listed", () => {
  const runs = Array.from({ length: 4 }, () => syntheticRun());
  const report = buildPerfReport({
    runs,
    failures: ["r3: presence guard failed — 28/32 sample centres on screen; run DISCARDED"],
    env: syntheticEnv(),
    params: syntheticParams(),
    artifacts: syntheticArtifacts(),
    scenario: "mirror-replay-combat",
  });
  assert.equal(report.repeats, 4);
  assert.equal(report.runs.length, 4);
  assert.deepEqual(report.failures, [
    "r3: presence guard failed — 28/32 sample centres on screen; run DISCARDED",
  ]);
});

test("buildPerfReport: every aggregate metric key is present on each per-repeat object", () => {
  const runs = Array.from({ length: 3 }, () => syntheticRun());
  const report = buildPerfReport({
    runs,
    env: syntheticEnv(),
    params: syntheticParams(),
    artifacts: syntheticArtifacts(),
    scenario: "s",
  });
  for (const key of Object.keys(report.metrics)) {
    for (const run of report.runs) {
      assert.ok(key in run, `per-repeat object missing metric "${key}"`);
    }
  }
});

test("buildPerfReport: rejects an empty accepted set and a null env.label", () => {
  assert.throws(
    () => buildPerfReport({ runs: [], env: syntheticEnv(), params: {}, artifacts: syntheticArtifacts(), scenario: "s" }),
    /at least one accepted/,
  );
  assert.throws(
    () =>
      buildPerfReport({
        runs: [syntheticRun()],
        env: syntheticEnv({ label: "" }),
        params: {},
        artifacts: syntheticArtifacts(),
        scenario: "s",
      }),
    /env\.label/,
  );
});

test("buildPerfReport: rejects non-string artifact paths", () => {
  assert.throws(
    () =>
      buildPerfReport({
        runs: [syntheticRun()],
        env: syntheticEnv(),
        params: {},
        artifacts: { trace: null, screenshot: "x.png" },
        scenario: "s",
      }),
    /artifacts\.trace and artifacts\.screenshot/,
  );
});
