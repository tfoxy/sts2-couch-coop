// The bounded `?audioDiag=1` event ring the worker/worklet paths share with the snapshot shape
// `mainEngine.ts` exposes on `window.__couchCoopAudioDiag`: `seq`-numbered rows, oldest dropped past 1024,
// a `lostEvents` count. Rows recorded on another thread arrive already stamped with a page-aligned
// `performanceMs` and their own `seq`; `ingest` keeps that as `remoteSeq` and gives each row a page `seq`,
// so `seq` stays monotonic in ARRIVAL order. Order cross-thread rows by `performanceMs`, not `seq`.
import type { AudioDiagEventWire } from "./audioSinkProtocol";

export const AUDIO_DIAG_LIMIT = 1024;

export class AudioDiagRing {
  readonly events: Array<Record<string, unknown>> = [];
  private seq = 0;
  private lost = 0;
  constructor(readonly enabled: boolean, private readonly limit = AUDIO_DIAG_LIMIT) {}

  push(type: string, performanceMs: number, fields: Record<string, unknown>): void {
    if (!this.enabled) return;
    this.append({ seq: ++this.seq, type, performanceMs, ...fields });
  }

  ingest(rows: readonly AudioDiagEventWire[]): void {
    if (!this.enabled) return;
    for (const row of rows) this.append({ ...row, remoteSeq: row.seq, seq: ++this.seq });
  }

  get lastSeq(): number { return this.seq; }
  get firstSeq(): number { return (this.events[0]?.seq as number | undefined) ?? this.seq + 1; }
  get lostEvents(): number { return this.lost; }

  private append(row: Record<string, unknown>): void {
    this.events.push(row);
    if (this.events.length > this.limit) { this.events.shift(); this.lost++; }
  }
}

/**
 * Off-main-thread side: buffers rows and hands them to `flush` in batches — at `batch` rows, or on a
 * one-shot `delayMs` timer armed by the first row of a batch. Constructed only when diagnostics are on, so
 * a viewer without `?audioDiag=1` pays nothing.
 */
export class AudioDiagBatcher {
  private rows: AudioDiagEventWire[] = [];
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly now: () => number, private readonly flushRows: (rows: AudioDiagEventWire[]) => void,
    private readonly batch = 32, private readonly delayMs = 100) {}

  record(type: string, fields: Record<string, unknown>): void {
    this.rows.push({ seq: ++this.seq, type, performanceMs: this.now(), ...fields } as AudioDiagEventWire);
    if (this.rows.length >= this.batch) this.flush();
    else if (this.timer === null) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.delayMs);
  }

  flush(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (!this.rows.length) return;
    const rows = this.rows; this.rows = [];
    this.flushRows(rows);
  }

  dispose(): void { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; this.rows = []; }
}
