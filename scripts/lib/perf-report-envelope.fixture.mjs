// Synthetic but REALISTIC per-repeat report objects + env/params/artifacts, for
// the perf-report-envelope unit test and the cross-repo validator smoke test.
// The numbers are plausible headless-replay values, not zeros.

export function syntheticGeometry(overrides = {}) {
  return {
    viewport: { width: 2100, height: 900 },
    devicePixelRatio: 1,
    orientation: "landscape",
    fit: true,
    fitScale: 1.09375,
    stage: { width: 2100, height: 1080 },
    fittedStage: { width: 2100, height: 1181.25 },
    grid: null,
    emulatedViewport: "2100x900",
    ...overrides,
  };
}

let seq = 0;

export function syntheticRun(overrides = {}) {
  const i = seq++;
  const jitter = (base, spread) => base + ((i % 5) - 2) * spread;
  return {
    initialRenderMs: jitter(420, 8),
    readyMs: jitter(9800, 40),
    windowMs: jitter(12000, 3),
    contentUpdateHz: jitter(46.2, 0.6),
    swapRateHz: jitter(58.1, 0.9),
    swapCount: jitter(690, 6),
    activationCount: jitter(552, 5),
    activationGapMs: { p50: 16.7, p95: 33.4, max: 128.2, over100msCount: 2, count: 551 },
    frameCostMs: { p50: 2.1, p95: 6.4, max: 41.8 },
    tickMs: { p50: 1.4, p95: 4.2, max: 22.1, count: 540, totalMs: 1180.2 },
    blockedMs: jitter(210.4, 12),
    mainThreadBusyMs: jitter(1490, 20),
    mainThreadCpuRatio: jitter(0.0031, 0.0002),
    mainThreadCpuSamples: jitter(58, 3),
    longTaskCount: jitter(41, 2),
    longAnimationFrames: jitter(37, 2),
    rasterMs: jitter(88.6, 4),
    decode: {
      source: "SoftwareImageDecodeCache::DecodeImageIfNecessary",
      count: jitter(63, 2),
      totalMs: jitter(117.4, 3),
      maxMs: 5.9,
      codecSource: "Decode Image",
      codecRuns: jitter(8, 1),
      codecMs: jitter(24.1, 1),
      codecMaxMs: 3.4,
      distinctImages: jitter(6, 0),
      redecodeCount: 0,
      redecodeMs: 0,
      inRasterCount: 0,
      inRasterMs: 0,
      imageKey: "contentId",
      cacheFamily: "software",
      imagesExpected: true,
      byName: {},
    },
    paint: {
      count: jitter(140, 3),
      distinctUrls: jitter(24, 1),
      maxSourceMegapixels: 2.72,
      maxSourceToPaintedRatio: 3.1,
    },
    rasterTasks: jitter(120, 5),
    renderSurfaces: 0,
    renderSurfaceReasons: {},
    renderSurfaceListPasses: jitter(180, 6),
    renderSurfacesScope: "trace",
    layerCount: jitter(6, 0),
    presentedFrames: jitter(1423, 12),
    presentedFramesSource: "SubmitCompositorFrameToPresentationCompositorFrame",
    presented: {
      nonEmptyRatio: jitter(0.734, 0.01),
      sampleHits: 32,
      sampleCount: 32,
      screenshot: `.sts2/bench/contract/report-r${i}.png`,
    },
    geometry: syntheticGeometry(),
    cpu: {
      windowMs: 12000,
      totalCpuMs: jitter(812.4, 20),
      totalCoreRatio: jitter(0.0677, 0.002),
      cpuCoverage: jitter(0.97, 0.01),
      byProcess: {
        renderer: { cpuMs: 649, wallMs: 721, coreRatio: 0.0541, threads: 22, processes: 1 },
        browser: { cpuMs: 128, wallMs: 190, coreRatio: 0.0107, threads: 14, processes: 1 },
        gpu: { cpuMs: 35.4, wallMs: 88, coreRatio: 0.00295, threads: 4, processes: 1 },
      },
      byThread: [
        { process: "Renderer", thread: "CrRendererMain", cpuMs: 164, wallMs: 175, coreRatio: 0.0137, instances: 1 },
        { process: "Browser", thread: "CrBrowserMain", cpuMs: 92, wallMs: 120, coreRatio: 0.0077, instances: 1 },
        { process: "GPU Process", thread: "CrGpuMain", cpuMs: 35.4, wallMs: 88, coreRatio: 0.00295, instances: 1 },
      ],
    },
    ...overrides,
  };
}

export function syntheticEnv(overrides = {}) {
  return {
    kind: "ci",
    label: "linux-chrome-148",
    cpuThrottle: 1,
    device: null,
    ...overrides,
  };
}

export function syntheticParams(overrides = {}) {
  return {
    url: "http://127.0.0.1:5199",
    recording: ".sts2/bench/combat-modern-2026-08-06.ndjson",
    pace: "recorded",
    quality: "high",
    effects: "off",
    viewport: "2100x900",
    censusCanvasStats: null,
    censusGlContext: null,
    processMemory: { procMem: null, blinkMemory: null, perRepeatBlinkMemory: [] },
    cpuCoverageByProcess: { renderer: 0.99, browser: 0.62, gpu: 0.41 },
    presentedFrames: 1423,
    ...overrides,
  };
}

export function syntheticArtifacts(overrides = {}) {
  return {
    trace: ".sts2/bench/contract/report-r0-trace.json",
    screenshot: ".sts2/bench/contract/report-r0.png",
    ...overrides,
  };
}
