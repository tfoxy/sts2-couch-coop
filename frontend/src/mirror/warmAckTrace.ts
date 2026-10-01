// Harness-only, opt-in observation. The caller checks presence before constructing an event.
export type WarmAckTraceEvent = { kind: string; revision?: number | null;
  clientId?: number | null; socketId?: number | null; activeClientId?: number | null;
  guard?: string; deltasSinceAck?: number; watching?: boolean; readyState?: number;
  result?: string; instance?: number | null; presentEpoch?: number | null;
  asyncSubmissionRevision?: number | null; asyncPresentedRevision?: number | null;
  asyncAwaitingAckRevision?: number | null; pullPending?: boolean | null };

type TraceGlobal = typeof globalThis & { __benchWarmAckTrace?: (event: WarmAckTraceEvent) => void };

export function warmAckTraceEnabled(): boolean {
  return typeof (globalThis as TraceGlobal).__benchWarmAckTrace === "function";
}

export function emitWarmAckTrace(event: WarmAckTraceEvent): void {
  const trace = (globalThis as TraceGlobal).__benchWarmAckTrace;
  if (typeof trace !== "function") return;
  try { trace(event); } catch { /* observation cannot alter rendering or flow control */ }
}
