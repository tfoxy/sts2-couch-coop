// Nested synchronous wall spans are leads only. They cannot be converted to
// scheduled CPU without a joined scheduler or validated thread-CPU source.
export function exclusivePhaseLeads(events) {
  const groups = new Map();
  for (const e of events) if (e.eventType === 'phase-edge' && e.clockDomain === 'performance.timeOrigin+now') {
    const key = `${e.runId}/${e.rendererInstanceId}/${e.operationId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const totals = new Map(), failures = [];
  for (const [key, rows] of groups) {
    const stack = [];
    for (const e of rows) {
      if (!/^(0|[1-9][0-9]*)$/.test(e.timestampUs ?? '')) { failures.push(`${key}: invalid timestamp`); break; }
      const at = BigInt(e.timestampUs);
      if (e.edge === 'start') { stack.push({phase:e.phase,at,childUs:0n}); continue; }
      const current = stack.pop();
      if (e.edge !== 'end' || !current || current.phase !== e.phase || at < current.at) {
        failures.push(`${key}: unbalanced or unordered phase`); break;
      }
      const inclusiveUs = at-current.at, exclusiveUs = inclusiveUs-current.childUs;
      if (exclusiveUs < 0n) { failures.push(`${key}: child wall exceeds parent`); break; }
      if (stack.length) stack[stack.length-1].childUs += inclusiveUs;
      const row = totals.get(e.phase) ?? {phase:e.phase,calls:0,inclusiveUs:0n,exclusiveUs:0n};
      row.calls++; row.inclusiveUs += inclusiveUs; row.exclusiveUs += exclusiveUs;
      totals.set(e.phase,row);
    }
    if (stack.length) failures.push(`${key}: open phase`);
  }
  return {unit:'ms wall, not CPU',operations:groups.size,failures,
    phases:[...totals.values()].map(row => ({phase:row.phase,calls:row.calls,
      inclusiveWallMs:Number(row.inclusiveUs)/1000,exclusiveWallMs:Number(row.exclusiveUs)/1000}))
      .sort((a,b) => b.exclusiveWallMs-a.exclusiveWallMs)};
}
