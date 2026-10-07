import type { AudioContextLike } from "./audioUnlock";
export function outputLeadMs(context: AudioContextLike, now = performance.now()): number | null {
  if (!context.getOutputTimestamp) return null;
  const stamp = context.getOutputTimestamp();
  const predictedOutputMs = stamp.performanceTime + (context.currentTime - stamp.contextTime) * 1000;
  return predictedOutputMs - now;
}
export function needsContextRecreate(context: AudioContextLike): boolean {
  const lead = outputLeadMs(context);
  return lead !== null && lead > 60;
}

declare global { interface Window {
  __couchCoopAudioDiag?: () => Record<string, unknown>;
  __couchCoopAudioDiagProbe?: () => boolean;
} }
export function installAudioDiagnostics(enabled: boolean, get: () => Record<string, unknown>, probe: () => boolean,
  win = globalThis.window): void {
  if (enabled && win) {
    win.__couchCoopAudioDiag = get;
    win.__couchCoopAudioDiagProbe = probe;
  }
}
