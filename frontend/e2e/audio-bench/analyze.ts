// Pure stats helpers for audioBench.spec.ts. No Playwright/Node I/O here on purpose, so the clock-mapping
// and percentile math can be read (and, if it ever matters enough, unit-tested) independently of the
// browser-driving code around it.
import type { SeatCueLogEntry, LaneBlockLogEntry } from "./fakeAudioHost";

export type DiagEvent = Record<string, unknown> & { seq: number; type: string; performanceMs: number };

/**
 * CLOCK ALIGNMENT. The fake host's `t`/`dueUs`/`sentUs` live in ITS OWN monotonic microsecond clock (an
 * arbitrary epoch — see fakeAudioHost.ts), and the page's diagnostic timestamps live in `performance.now()`
 * milliseconds (an arbitrary-but-different epoch). Comparing raw `Date.now()` on both sides would work only
 * by the two processes' wall clocks happening to agree, which is not a thing to depend on even on one
 * machine (NTP slew, VM clocksource warps). Instead this reuses the mechanism the product ALREADY ships for
 * exactly this purpose: `renderLane.ts`'s `clock` round trip, surfaced into the diag ring as
 * `host-clock-sample` events (`clockSeq, clientSendPerfMs, hostReceiveUs, hostSendUs, clientReceivePerfMs`).
 *
 * Per-sample offset estimate (NTP-style, assuming symmetric transport delay): the host's midpoint time
 * `(hostReceiveUs + hostSendUs) / 2` is assumed to have occurred at the page's
 * `clientSendPerfMs + rtt/2`. `offsetUs = hostMidUs - pageMidMs * 1000` lets any host timestamp be mapped
 * into the page's `performance.now()` domain: `pageMs = (hostUs - offsetUs) / 1000`.
 *
 * The median across samples is used rather than the mean so one slow round trip (GC pause, a probe that
 * happened to land mid busy-spin) does not skew the whole run's mapping.
 */
export function clockOffsetUs(samples: DiagEvent[]): number | null {
  const offsets: number[] = [];
  for (const sample of samples) {
    const clientSendPerfMs = sample.clientSendPerfMs, clientReceivePerfMs = sample.clientReceivePerfMs;
    const hostReceiveUs = sample.hostReceiveUs, hostSendUs = sample.hostSendUs;
    if (typeof clientSendPerfMs !== "number" || typeof clientReceivePerfMs !== "number" ||
        typeof hostReceiveUs !== "number" || typeof hostSendUs !== "number") continue;
    const rttMs = clientReceivePerfMs - clientSendPerfMs;
    const hostMidUs = (hostReceiveUs + hostSendUs) / 2;
    const pageMidMs = clientSendPerfMs + rttMs / 2;
    offsets.push(hostMidUs - pageMidMs * 1000);
  }
  if (offsets.length === 0) return null;
  offsets.sort((a, b) => a - b);
  return offsets[Math.floor(offsets.length / 2)];
}

export function hostUsToPageMs(hostUs: number, offsetUs: number): number {
  return (hostUs - offsetUs) / 1000;
}

export function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[idx];
}

export function summarize(values: number[]): { p50: number | null; p95: number | null; max: number | null; n: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.length ? sorted[sorted.length - 1] : null, n: sorted.length };
}

export interface RunStats {
  calibrationSamples: number;
  clockOffsetUs: number | null;
  cueLatencyMs: ReturnType<typeof summarize>;
  cueReceiptLatencyMs: ReturnType<typeof summarize>;
  laneLagMs: ReturnType<typeof summarize>;
  laneLagFirstThirdMs: number | null;
  laneLagLastThirdMs: number | null;
  laneDrops: number;
  laneReanchors: number;
  laneSamples: number;
  longTaskTotalMs: number;
  longTaskCount: number;
  diagEventsSeen: number;
  diagEventsLostInPage: number;
  cuesSent: number;
  cuesMatched: number;
}

/**
 * `calibrationCutoffSeq` splits the host-clock-sample events into the ones taken BEFORE synthetic load
 * started (used to compute the offset) and everything after (periodic `probeClock()` pulls taken DURING
 * load, which the caller may still want to inspect for drift, but which this function does not fold back
 * into the offset — a probe sent while the main thread is busy measures the busy delay on both legs of its
 * own round trip, so using it to recalibrate would hide the very thing the bench is trying to show).
 */
export function analyzeRun(
  events: DiagEvent[],
  seatCueLog: SeatCueLogEntry[],
  laneBlockLog: LaneBlockLogEntry[],
  longTasks: Array<{ startTime: number; duration: number }>,
  calibrationCutoffSeq: number,
  diagEventsLostInPage: number
): RunStats {
  const calibrationSamples = events.filter(e => e.type === "host-clock-sample" && e.seq <= calibrationCutoffSeq);
  const offsetUs = clockOffsetUs(calibrationSamples);

  const cueByT = new Map<number, SeatCueLogEntry>();
  for (const cue of seatCueLog) if (!cue.warmup) cueByT.set(Number(cue.sentUs), cue);

  const cueLatencies: number[] = [];
  const receiptLatencies: number[] = [];
  const laneLags: number[] = [];
  let laneDrops = 0, laneReanchors = 0, laneSamples = 0;
  const matchedT = new Set<number>();

  for (const event of events) {
    if (offsetUs === null) break;
    if (event.type === "source-scheduled" && event.lane === "sfx" && typeof event.seatTUs === "number") {
      const cue = cueByT.get(event.seatTUs);
      if (cue) { cueLatencies.push(event.performanceMs - hostUsToPageMs(event.seatTUs, offsetUs)); matchedT.add(event.seatTUs); }
    }
    if (event.type === "seat-event-received" && event.kind === "sfx" && typeof event.seatTUs === "number") {
      const cue = cueByT.get(event.seatTUs);
      if (cue) receiptLatencies.push(event.performanceMs - hostUsToPageMs(event.seatTUs, offsetUs));
    }
    if (event.type === "lane-source-scheduled" && typeof event.dueUs === "string") {
      laneSamples++;
      laneLags.push(event.performanceMs - hostUsToPageMs(Number(event.dueUs), offsetUs));
      if (typeof event.dropped === "number" && event.dropped > 0) laneDrops++;
      if (event.reanchored === true) laneReanchors++;
    }
  }

  const third = Math.floor(laneLags.length / 3) || 1;
  const laneLagFirstThirdMs = laneLags.length ? average(laneLags.slice(0, third)) : null;
  const laneLagLastThirdMs = laneLags.length ? average(laneLags.slice(-third)) : null;

  return {
    calibrationSamples: calibrationSamples.length,
    clockOffsetUs: offsetUs,
    cueLatencyMs: summarize(cueLatencies),
    cueReceiptLatencyMs: summarize(receiptLatencies),
    laneLagMs: summarize(laneLags),
    laneLagFirstThirdMs, laneLagLastThirdMs,
    laneDrops, laneReanchors, laneSamples,
    longTaskTotalMs: longTasks.reduce((sum, t) => sum + t.duration, 0),
    longTaskCount: longTasks.length,
    diagEventsSeen: events.length,
    diagEventsLostInPage,
    cuesSent: seatCueLog.filter(c => !c.warmup).length,
    cuesMatched: matchedT.size
  };
}

function average(values: number[]): number { return values.reduce((a, b) => a + b, 0) / values.length; }
