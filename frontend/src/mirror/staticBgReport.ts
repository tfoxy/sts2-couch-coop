// `window.__mirrorStaticBg()` — static-background fetch/decode failures, as COUNTERS instead of inference.
//
// WHY THIS EXISTS. A room's baked picture can fail to fetch or decode, and what happens next is deliberately
// silent — which is exactly the problem. On combat the two states are 10 fx surfaces versus 32, and 80.3 MB of
// textures versus 108.8 MB, so a session that failed without anyone noticing produced numbers describing a scene
// nobody thought they were measuring. Round 6's phone matrix logged ~16 `/bg/` 404s per cell and the question
// "did it fire" could not be answered from any artifact it left.
//
// A failure never releases covered live scenery. Combat may walk a picture-only retry ladder; every family then
// keeps a valid same-target still or leaves the stage blank. These counters name that otherwise silent outcome.
//
// A REPORTER, NOT A RETRY. `/bg/` is a HOST route — `serve-res-root.mjs` serves `/res/**` only — so on a bench
// leg without the host there is nothing behind the URL and retrying it buys nothing but latency. The failure is
// environmental; what was missing was the ability to SEE it.
//
// Everything here is cumulative for the life of the page except `latched`, which is a live gauge. Counting
// transitions rather than sampling a boolean is the point: a background that failed and then recovered reads
// `latched: false` at settle and is indistinguishable from one that never failed — the same shape of blind spot
// as the canvas stage's post-settle `contextLost`.

export interface MirrorStaticBgReport {
  /** Decode attempts started (one per distinct target URL this page committed to). */
  attempts: number;
  /** Attempts that DECODED and were committed to screen. */
  decodes: number;
  /**
   * Attempts that failed to fetch or decode. Counts EVERY rung of the ladder, so a combat 404 that is rescued by
   * the digest-less retry still shows up here — that is the point: the qualified URL really did 404.
   */
  failures: number;
  /** Failures caused by the 6s watchdog rather than a decode result — a stalled fetch, not a missing file. */
  watchdogFires: number;
  /** Times `latched` went false -> true. Transitions, not a level. */
  latches: number;
  /** Times a later image decoded and cleared `latched`. */
  unlatches: number;
  /**
   * Live gauge: does this viewer have NO still on screen for the current target right now?
   *
   * The live subtree remains held either way. This reads false whenever the request or retry ladder left a valid
   * same-target still on screen.
   */
  latched: boolean;
  /** The most recent URL attempted, whatever became of it — the one field that names WHAT 404'd. */
  lastUrl: string | null;
  /** The most recent URL that FAILED, kept separately so a later success cannot erase the evidence. */
  lastFailedUrl: string | null;
}

const report: MirrorStaticBgReport = {
  attempts: 0,
  decodes: 0,
  failures: 0,
  watchdogFires: 0,
  latches: 0,
  unlatches: 0,
  latched: false,
  lastUrl: null,
  lastFailedUrl: null
};

export function noteStaticBgAttempt(url: string): void {
  report.attempts += 1;
  report.lastUrl = url;
}

export function noteStaticBgDecode(): void {
  report.decodes += 1;
}

/** `viaWatchdog` separates "the file is not there" from "the fetch never came back" — different defects. */
export function noteStaticBgFailure(viaWatchdog: boolean): void {
  report.failures += 1;
  if (viaWatchdog) {
    report.watchdogFires += 1;
  }
  report.lastFailedUrl = report.lastUrl;
}

/** The `latched` gauge's own transitions, reported by StaticBackground.vue as the ladder resolves. */
export function noteStaticBgLatch(latched: boolean): void {
  if (latched === report.latched) {
    return;
  }
  report.latched = latched;
  if (latched) {
    report.latches += 1;
  } else {
    report.unlatches += 1;
  }
}

export function staticBgReport(): MirrorStaticBgReport {
  return { ...report };
}

/** TEST-ONLY: zero the counters so one spec's transitions cannot be read by the next. */
export function __resetStaticBgReportForTest(): void {
  report.attempts = 0;
  report.decodes = 0;
  report.failures = 0;
  report.watchdogFires = 0;
  report.latches = 0;
  report.unlatches = 0;
  report.latched = false;
  report.lastUrl = null;
  report.lastFailedUrl = null;
}

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__mirrorStaticBg = staticBgReport;
}
