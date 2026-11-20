// Optional bench seam. The callback is installed only by the untimed startup
// diagnostic and must never affect rendering if its recorder fails.
export function emitBusyStartupEvent(name: string, detail: Record<string, unknown> = {}): void {
  const callback = (window as unknown as { __benchBusyStartupEvent?:
    (name: string, detail: Record<string, unknown>) => void }).__benchBusyStartupEvent;
  if (!callback) return;
  try { callback(name, detail); } catch { /* diagnostic output cannot alter a frame */ }
}
