// WP-D latency bench runner. For each (audio path x busy level x page-origin context), drives the real
// bench page (bench.html/bench.ts, which runs the SAME createAudioEngine MirrorApp.vue uses) against a
// fresh fakeAudioHost instance, injects synthetic main-thread load, lets ~200 spaced cues and >=30s of
// continuous 3-lane PCM run, and writes one combined JSON + Markdown report.
//
// Run with `npm run bench:audio` (from frontend/). Env knobs (all optional):
//   AUDIO_BENCH_PATHS       comma list, default "main,worker,worklet" (worker/worklet report "unavailable"
//                           until a later WP wires them into createAudioEngine — see bench.ts's header)
//   AUDIO_BENCH_BUSY_MS     comma list of per-frame busy-spin durations, default "0,40,55,70"
//   AUDIO_BENCH_CONTEXTS    comma list of "secure,insecure", default "secure,insecure"
//   AUDIO_BENCH_CUE_COUNT   default 200
//   AUDIO_BENCH_OUT_DIR     default /tmp/claude-1000/audio-wpd-bench (never the repo — results are not
//                           committed, see CLAUDE.md's Artifact Policy)
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { startFakeAudioHost, type FakeAudioHostHandle } from "./fakeAudioHost";
import { analyzeRun, type DiagEvent, type RunStats } from "./analyze";
import { AUDIO_BENCH_DEV_ORIGIN, AUDIO_BENCH_INSECURE_ORIGIN } from "../../playwright.audio-bench.config";

const OUT_DIR = process.env.AUDIO_BENCH_OUT_DIR ?? "/tmp/claude-1000/audio-wpd-bench";
const PATHS = (process.env.AUDIO_BENCH_PATHS ?? "main,worker,worklet").split(",").map(s => s.trim());
const BUSY_LEVELS = (process.env.AUDIO_BENCH_BUSY_MS ?? "0,40,55,70").split(",").map(Number);
const CONTEXTS = (process.env.AUDIO_BENCH_CONTEXTS ?? "secure,insecure").split(",").map(s => s.trim()) as Array<"secure" | "insecure">;
const CUE_COUNT = Number(process.env.AUDIO_BENCH_CUE_COUNT ?? 200);
const CUE_GAP_MS: readonly [number, number] = [150, 300];
const POLL_MS = 1_500; // drains the page's 1024-entry diag ring well before it could wrap at the busiest observed rate

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

interface BenchWindow { __bench?: {
  unlockAndStart(): Promise<{ ok: boolean }>;
  setBusy(spinMs: number, sceneDeltaEveryMs?: number): void;
  stopBusy(): void;
  getDiag(): { events: DiagEvent[]; lostEvents: number; lastSeq: number; contextState: string } | null;
  probeClock(): boolean;
  getLongTasks(): Array<{ startTime: number; duration: number }>;
  resolvedPath(): { requested: string; path: string; supported: boolean; reason: string };
  dispose(): void;
}; }

interface RunReport {
  path: string; busyMs: number; context: "secure" | "insecure";
  isSecureContext: boolean | null;
  unavailable: boolean; reason?: string;
  stats?: RunStats;
}

const reports: RunReport[] = [];

async function drainDiag(page: Page, sink: Map<number, DiagEvent>): Promise<number> {
  const diag = await page.evaluate(() => (window as unknown as BenchWindow).__bench?.getDiag() ?? null);
  if (!diag) return 0;
  for (const event of diag.events) sink.set(event.seq, event);
  return diag.lostEvents;
}

async function runOne(page: Page, host: FakeAudioHostHandle, origin: string, path: string, busyMs: number,
  context: "secure" | "insecure"): Promise<RunReport> {
  const url = `${origin}/e2e/audio-bench/bench.html?hostBase=${encodeURIComponent(host.httpOrigin)}&audioPath=${path}&audioDiag=1`;
  await page.goto(url);
  await expect(page.locator("#unlock")).toBeVisible();
  const isSecureContext = await page.evaluate(() => window.isSecureContext);

  const resolved = await page.evaluate(() => (window as unknown as BenchWindow).__bench?.resolvedPath());
  if (!resolved?.supported) {
    return { path, busyMs, context, isSecureContext, unavailable: true, reason: resolved?.reason ?? "no-bench-api" };
  }

  // Click ONLY — bench.html's own click listener calls unlockAndStart() (exactly like MirrorApp.vue's
  // pointerdown handler). Calling unlockAndStart() again here as well as clicking races two concurrent
  // engine.unlock() calls against createAudioUnlock's shared `context` variable: whichever call's
  // `playPrelude`/`createContext`/`resume` interleaving loses treats itself as stale and closes ITS OWN
  // context, but the two calls can still leave audioEngine.ts's own `context` pointed at a context that
  // was never resumed — permanently "suspended". One trigger per gesture, full stop.
  await page.click("#unlock");
  try {
    await page.waitForFunction(() => (window as unknown as BenchWindow).__bench?.getDiag()?.contextState === "running", { timeout: 10_000 });
  } catch {
    return { path, busyMs, context, isSecureContext, unavailable: true, reason: "unlock-failed" };
  }
  await page.waitForFunction(() => {
    const diag = (window as unknown as BenchWindow).__bench?.getDiag();
    return !!diag?.events.some(e => e.type === "host-clock-sample");
  }, { timeout: 5_000 });

  const seen = new Map<number, DiagEvent>();
  let lostInPage = await drainDiag(page, seen);
  const calibrationCutoffSeq = Math.max(...seen.keys(), 0);

  await page.evaluate(ms => (window as unknown as BenchWindow).__bench!.setBusy(ms, 50), busyMs);

  const scheduleEstimateMs = 1_500 + CUE_COUNT * ((CUE_GAP_MS[0] + CUE_GAP_MS[1]) / 2);
  const runMs = Math.max(30_000, scheduleEstimateMs + 3_000);
  const deadline = Date.now() + runMs;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    lostInPage = Math.max(lostInPage, await drainDiag(page, seen));
    await page.evaluate(() => (window as unknown as BenchWindow).__bench!.probeClock());
  }

  await page.evaluate(() => (window as unknown as BenchWindow).__bench!.stopBusy());
  lostInPage = Math.max(lostInPage, await drainDiag(page, seen));
  const longTasks = await page.evaluate(() => (window as unknown as BenchWindow).__bench!.getLongTasks());
  await page.evaluate(() => (window as unknown as BenchWindow).__bench!.dispose());

  const events = [...seen.values()].sort((a, b) => a.seq - b.seq);
  const stats = analyzeRun(events, host.seatCueLog, host.laneBlockLog, longTasks, calibrationCutoffSeq, lostInPage);
  return { path, busyMs, context, isSecureContext, unavailable: false, stats };
}

for (const context of CONTEXTS) {
  test(`audio latency bench — ${context} context`, async ({ page }) => {
    test.setTimeout(10 * 60_000);
    const origin = context === "secure" ? AUDIO_BENCH_DEV_ORIGIN : AUDIO_BENCH_INSECURE_ORIGIN;
    for (const path of PATHS) {
      for (const busyMs of BUSY_LEVELS) {
        const host = await startFakeAudioHost({ cueCount: CUE_COUNT, cueGapMs: CUE_GAP_MS });
        try {
          const report = await runOne(page, host, origin, path, busyMs, context);
          reports.push(report);
        } finally {
          await host.close();
        }
      }
    }
  });
}

test.afterAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(reports, null, 2));
  writeFileSync(`${OUT_DIR}/report.md`, renderMarkdown(reports));
});

function renderMarkdown(rows: RunReport[]): string {
  const lines: string[] = ["# Audio bench baseline", "", `Generated ${new Date().toISOString()}`, ""];
  lines.push("| context | path | busy(ms) | secure? | status | cue p50 | cue p95 | cue max | lane p50 | lane p95 | drops | reanchors | longtask ms |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    if (r.unavailable || !r.stats) {
      lines.push(`| ${r.context} | ${r.path} | ${r.busyMs} | ${r.isSecureContext} | unavailable: ${r.reason} | - | - | - | - | - | - | - | - |`);
      continue;
    }
    const s = r.stats;
    const fmt = (v: number | null): string => v === null ? "-" : v.toFixed(1);
    lines.push(`| ${r.context} | ${r.path} | ${r.busyMs} | ${r.isSecureContext} | ok (${s.cuesMatched}/${s.cuesSent} cues) | ${fmt(s.cueLatencyMs.p50)} | ${fmt(s.cueLatencyMs.p95)} | ${fmt(s.cueLatencyMs.max)} | ${fmt(s.laneLagMs.p50)} | ${fmt(s.laneLagMs.p95)} | ${s.laneDrops} | ${s.laneReanchors} | ${s.longTaskTotalMs.toFixed(0)} |`);
  }
  lines.push("", "Full per-run detail (clock offsets, receipt-vs-schedule split, lane-lag growth, diag-ring loss) is in report.json.");
  return lines.join("\n");
}
