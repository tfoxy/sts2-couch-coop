import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeRendererOfflineAttribution,
  partitionTidEvents,
} from './renderer-offline-attribution.mjs';

const marker = { startUs: 100, endUs: 200 };
const event = (name, tid, ts, dur, tdur, extra = {}) => ({
  ph: 'X', pid: 7, tid, name, ts, dur, ...(tdur === undefined ? {} : { tdur }), ...extra,
});
const sched = (tid, ts, dur, threadName = `worker-${tid}`) => ({
  pid: 7, tid, ts, dur, threadName,
});

test('clips wall spans to the marker and keeps clipped tdur separate from complete evidence', () => {
  const { spans } = partitionTidEvents([
    event('Decode Image', 10, 90, 30, 24),
    event('Decode Image', 10, 110, 20, 18),
    event('Decode Image', 10, 205, 10, 9),
  ], marker);

  assert.equal(spans.length, 2);
  assert.deepEqual(spans.map(s => [s.startNs, s.endNs, s.clipped]), [
    [100_000, 120_000, true],
    [110_000, 130_000, false],
  ]);
  assert.equal(spans[0].tdurNs, 24_000);
});

test('same-family nesting contributes wall union once while retaining inclusive span evidence', () => {
  const result = analyzeRendererOfflineAttribution({
    events: [
      event('V8.GC_SCAVENGER_BACKGROUND_SCAVENGE_PARALLEL', 10, 100, 60, 50),
      event('MinorGC', 10, 120, 20, 18),
    ],
    schedRows: [sched(10, 100_000, 60_000)],
    ...marker, rendererPid: 7, clockOffsetNs: 0, acceptedCpuNs: 60_000,
  });
  const gc = result.families.find(f => f.name === 'V8 GC');

  assert.equal(gc.count, 2);
  assert.equal(gc.unionWallMs, 0.06);
  assert.equal(gc.inclusiveTdurMs, 0.068);
  assert.equal(gc.scheduledCpuMs, 0.06);
  assert.equal(result.totals.residualCpuMs, 0);
});

test('cross-family overlap becomes an explicit ambiguous interval and is never double-assigned', () => {
  const result = analyzeRendererOfflineAttribution({
    events: [
      event('Decode Image', 10, 100, 70, 55),
      event('Layout', 10, 130, 60, 45),
    ],
    schedRows: [sched(10, 100_000, 90_000)],
    ...marker, rendererPid: 7, clockOffsetNs: 0, acceptedCpuNs: 90_000,
  });
  const cpuByFamily = Object.fromEntries(result.families.map(f => [f.name, f.scheduledCpuMs]));
  const overlap = result.overlapMatrix.find(row => row.pair === 'Image decode / Layout and paint');

  assert.equal(overlap.overlapMs, 0.04);
  assert.equal(cpuByFamily['Image decode'], 0.03);
  assert.equal(cpuByFamily['Ambiguous overlap'], 0.04);
  assert.equal(cpuByFamily['Layout and paint'], 0.02);
  assert.equal(result.totals.scheduledCpuMs, 0.09);
  assert.equal(result.totals.residualCpuMs, 0);
});

test('overlap matrix intersects family unions instead of double-counting nested same-family spans', () => {
  const result = analyzeRendererOfflineAttribution({
    events: [
      event('V8.GC_SCAVENGER_BACKGROUND_SCAVENGE_PARALLEL', 10, 100, 60, 50),
      event('MinorGC', 10, 110, 40, 35),
      event('Decode Image', 10, 120, 20, 15),
    ],
    schedRows: [sched(10, 100_000, 60_000)],
    ...marker, rendererPid: 7, clockOffsetNs: 0, acceptedCpuNs: 60_000,
  });
  const overlap = result.overlapMatrix.find(row => row.pair === 'Image decode / V8 GC');

  // Decode overlaps both trace events for 20 us apiece, but the GC family's
  // union is only 20 us over that interval.
  assert.equal(overlap.overlapMs, 0.02);
});

test('concurrent TIDs remain separate until process CPU is summed', () => {
  const result = analyzeRendererOfflineAttribution({
    events: [
      event('Decode Image', 10, 100, 20, 16),
      event('Decode Image', 11, 100, 20, 17),
    ],
    schedRows: [sched(10, 100_000, 20_000), sched(11, 100_000, 20_000)],
    ...marker, rendererPid: 7, clockOffsetNs: 0, acceptedCpuNs: 40_000,
  });
  const decode = result.families.find(f => f.name === 'Image decode');

  assert.deepEqual(decode.tids, [10, 11]);
  assert.equal(decode.unionWallMs, 0.04);
  assert.equal(decode.scheduledCpuMs, 0.04);
  assert.deepEqual(result.perTid.map(t => t.schedCpuMs), [0.02, 0.02]);
  assert.equal(result.totals.scheduledCpuMs, 0.04);
});

test('missing and invalid tdur are counted as unknown, never coerced into CPU evidence', () => {
  const result = analyzeRendererOfflineAttribution({
    events: [
      event('Decode Image', 10, 110, 10, undefined),
      event('Decode Image', 10, 130, 10, Number.NaN),
      event('Decode Image', 10, 150, 10, -1),
    ],
    schedRows: [sched(10, 100_000, 100_000)],
    ...marker, rendererPid: 7, clockOffsetNs: 0, acceptedCpuNs: 100_000,
  });
  const decode = result.families.find(f => f.name === 'Image decode');

  assert.equal(decode.count, 3);
  assert.equal(decode.missingTdur, 3);
  assert.equal(decode.inclusiveTdurMs, 0);
  assert.equal(decode.clippedTdurEstimateMs, 0);
});

test('scheduler-only profiler and unknown TIDs retain separate buckets in the process total', () => {
  const result = analyzeRendererOfflineAttribution({
    events: [event('Decode Image', 10, 100, 20, 15)],
    schedRows: [
      sched(10, 100_000, 20_000),
      sched(12, 120_000, 30_000, 'v8:ProfEvntProc'),
      sched(13, 150_000, 10_000, 'unknown-worker'),
    ],
    ...marker, rendererPid: 7, clockOffsetNs: 0, acceptedCpuNs: 60_000,
  });

  assert.equal(result.families.find(f => f.name === 'Image decode').scheduledCpuMs, 0.02);
  assert.equal(result.totals.profilerCpuMs, 0.03);
  assert.equal(result.totals.residualCpuMs, 0.01);
  assert.deepEqual(result.families.find(f => f.name === 'JS profiler worker (likely capture overhead)').tids, [12]);
  assert.equal(result.perTid.find(t => t.tid === 13).residualCpuMs, 0.01);
  assert.equal(result.totals.scheduledCpuMs, 0.06);
});

test('scheduler intersections use exact nanoseconds and reconcile to the accepted total', () => {
  const result = analyzeRendererOfflineAttribution({
    events: [event('Decode Image', 10, 110, 50, 40)],
    // Trace interval [110,160) us maps to [111000,161000) ns. Its two
    // scheduler intersections are 2 us and 11 us; the last slice is outside
    // the marker window. The first slice also starts before the marker.
    schedRows: [
      sched(10, 100_000, 13_000),
      sched(10, 150_000, 20_000),
      sched(10, 210_000, 10_000),
    ],
    ...marker, rendererPid: 7, clockOffsetNs: 1_000, acceptedCpuNs: 32_000,
  });
  const decode = result.families.find(f => f.name === 'Image decode');

  assert.equal(decode.scheduledCpuMs, 0.013);
  assert.equal(result.totals.residualCpuMs, 0.019);
  assert.equal(result.totals.scheduledCpuMs, 0.032);
});

test('bad clock or PID/TID ledgers fail closed', () => {
  const events = [event('Decode Image', 10, 110, 10, 8)];
  const base = {
    events, schedRows: [sched(10, 100_000, 100_000)], ...marker,
    rendererPid: 7, clockOffsetNs: 0, acceptedCpuNs: 100_000,
  };

  assert.throws(() => analyzeRendererOfflineAttribution({ ...base, rendererPid: Number.NaN }), /PID\/clock/);
  assert.throws(() => analyzeRendererOfflineAttribution({ ...base, clockOffsetNs: Number.MAX_SAFE_INTEGER }), /clock conversion/);
  assert.throws(() => analyzeRendererOfflineAttribution({ ...base, schedRows: [{ ...sched(11, 100_000, 100_000), pid: 8 }] }), /invalid renderer sched mapping/);
  assert.throws(() => analyzeRendererOfflineAttribution({ ...base, schedRows: [] }), /no Perfetto sched mapping/);
  assert.throws(() => analyzeRendererOfflineAttribution({ ...base, acceptedCpuNs: 98_000 }), /accepted renderer CPU mismatch/);
});
