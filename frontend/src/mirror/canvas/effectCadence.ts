export interface EffectCadenceDecision { sample: boolean; delta: number; nextDueMs: number; }

/** Keep producer simulation at its configured cadence while the stage may present more often. */
export function createEffectCadence() {
  const entries = new Map<string, { signature: string; lastMs: number }>();
  return {
    decide(id: string, signature: string, nowMs: number, fps: number, staticMode: boolean): EffectCadenceDecision {
      const prior = entries.get(id);
      const forced = prior === undefined || prior.signature !== signature;
      if (staticMode) {
        if (forced) entries.set(id, { signature, lastMs: nowMs });
        return { sample: forced, delta: 0, nextDueMs: Number.POSITIVE_INFINITY };
      }
      const interval = fps > 0 ? 1000 / fps : 0;
      const due = prior ? prior.lastMs + interval : nowMs;
      if (forced || interval === 0 || nowMs >= due) {
        const delta = prior && !forced ? Math.max(0, nowMs - prior.lastMs) / 1000 : 0;
        entries.set(id, { signature, lastMs: nowMs });
        return { sample: true, delta, nextDueMs: interval === 0 ? nowMs : nowMs + interval };
      }
      return { sample: false, delta: 0, nextDueMs: due };
    },
    removeExcept(ids: ReadonlySet<string>): void { for (const id of entries.keys()) if (!ids.has(id)) entries.delete(id); },
    invalidate(id: string): void { entries.delete(id); },
    clear(): void { entries.clear(); }
  };
}
