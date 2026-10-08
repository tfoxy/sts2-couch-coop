// Bench page for WP-D's local Chromium audio-latency measurements. Imports the SAME `createAudioEngine`
// MirrorApp.vue uses (see src/mirror/MirrorApp.vue's `createAudioEngine({...})` call) so the bench exercises
// the real engine, not a reimplementation of it. Everything here is bench-only: it is never imported by the
// shipped app and is excluded from `npm run build`'s input (Vite's default build entry is index.html only —
// there is no build.rollupOptions.input in vite.config.ts that would pull this page in).
//
// `?audioPath=main|worker|worklet` selects the engine path (audioPath.ts); `resolvedPath()` reports the path the
// engine snapshot says it actually runs, so a worklet→worker fallback is visible in the report.
import { createAudioEngine, type AudioEngineHandle } from "@/audio/audioEngine";
import { detectAudioPathEnv, resolveAudioPath, type AudioPath } from "@/audio/audioPath";

interface BenchDiag { getDiag(): Record<string, unknown> | null; probeClock(): boolean; }
type DiagWindow = Window & {
  __couchCoopAudioDiag?: () => Record<string, unknown>;
  __couchCoopAudioDiagProbe?: () => boolean;
};

export interface ResolvedPathReport { requested: string; path: AudioPath | "unavailable"; supported: boolean; reason: string; }

export interface BenchApi extends BenchDiag {
  unlockAndStart(): Promise<{ ok: boolean }>;
  setBusy(spinMs: number, sceneDeltaEveryMs?: number): void;
  stopBusy(): void;
  getLongTasks(): Array<{ startTime: number; duration: number }>;
  resolvedPath(): ResolvedPathReport;
  stop(): void;
  dispose(): void;
}

declare global {
  interface Window { __bench?: BenchApi; __couchCoopHostBase?: string; }
}

const params = new URLSearchParams(location.search);
const hostBase = params.get("hostBase");
// Legitimate use of the app's own "remote-hosted" topology (see join/hostBase.ts): the bench page is served
// by the Vite dev origin while the fake audio host listens on a different port, so every /audio/take/* route
// TakeStore.ts builds via hostUrl() must resolve against the fake host's origin, not the page's own.
if (hostBase) window.__couchCoopHostBase = hostBase;
const wsBase = hostBase ? hostBase.replace(/^http/, "ws") : "";
const requested = (params.get("audioPath") as AudioPath | null) ?? "auto";

const env = detectAudioPathEnv();
const autoResolution = resolveAudioPath({ ...env, autoDefault: true });

let engine: AudioEngineHandle | null = null;
let reason = "ok";
if (!hostBase) {
  reason = "missing-hostBase-query-param";
} else {
  engine = createAudioEngine({
    seatUrl: `${wsBase}/ws?lane=audio`,
    renderUrl: `${wsBase}/audio`,
    indexUrl: `${hostBase}/audio/takes`,
    onUnavailable: () => { reason = "engine-reported-unavailable"; }
  });
}

const statusEl = document.getElementById("status");
const setStatus = (text: string): void => { if (statusEl) statusEl.textContent = text; };

async function unlockAndStart(): Promise<{ ok: boolean }> {
  if (!engine) { setStatus(`no-engine:${reason}`); return { ok: false }; }
  setStatus("unlocking");
  const ok = await engine.unlock();
  if (ok) { engine.start(); setStatus("running"); } else setStatus("unlock-failed");
  return { ok };
}
document.getElementById("unlock")?.addEventListener("click", () => { void unlockAndStart(); });

// ---- synthetic main-thread load (deliverable #2: a rAF loop that busy-spins B ms/frame, plus an optional
// periodic 10ms task standing in for scene-delta handling). This is injected CPU load for the bench itself —
// it has nothing to do with observing game state, so it is not the polling the project's "no polling" rule
// is about. ----
let spinMsPerFrame = 0;
let rafHandle = 0;
let sceneDeltaTimer: ReturnType<typeof setInterval> | null = null;

function busyFrame(): void {
  if (spinMsPerFrame > 0) {
    const until = performance.now() + spinMsPerFrame;
    while (performance.now() < until) { /* synthetic main-thread load */ }
  }
  rafHandle = requestAnimationFrame(busyFrame);
}
rafHandle = requestAnimationFrame(busyFrame);

const longTasks: Array<{ startTime: number; duration: number }> = [];
try {
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) longTasks.push({ startTime: entry.startTime, duration: entry.duration });
  }).observe({ type: "longtask", buffered: true });
} catch { /* longtask entries unsupported — reported as an empty list */ }

window.__bench = {
  unlockAndStart,
  setBusy(spinMs: number, sceneDeltaEveryMs = 0) {
    spinMsPerFrame = spinMs;
    if (sceneDeltaTimer) { clearInterval(sceneDeltaTimer); sceneDeltaTimer = null; }
    if (sceneDeltaEveryMs > 0) {
      sceneDeltaTimer = setInterval(() => {
        const until = performance.now() + 10;
        while (performance.now() < until) { /* synthetic scene-delta handling */ }
      }, sceneDeltaEveryMs);
    }
  },
  stopBusy() {
    spinMsPerFrame = 0;
    if (sceneDeltaTimer) { clearInterval(sceneDeltaTimer); sceneDeltaTimer = null; }
  },
  getDiag() { return (window as DiagWindow).__couchCoopAudioDiag?.() ?? null; },
  probeClock() { return (window as DiagWindow).__couchCoopAudioDiagProbe?.() ?? false; },
  getLongTasks() { return longTasks.slice(); },
  resolvedPath() {
    return {
      requested,
      // The engine's own snapshot names the path it actually runs (after any worklet→worker→main fallback).
      path: engine ? ((this.getDiag()?.audioPath as AudioPath | undefined) ?? autoResolution.path) : "unavailable",
      supported: !!engine,
      reason
    };
  },
  stop() { engine?.stop(); },
  dispose() {
    cancelAnimationFrame(rafHandle);
    if (sceneDeltaTimer) clearInterval(sceneDeltaTimer);
    engine?.dispose();
  }
};
setStatus(`ready:${reason}`);
