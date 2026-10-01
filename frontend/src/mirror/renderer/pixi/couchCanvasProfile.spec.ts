import { describe, expect, it, vi } from 'vitest';
import { createCouchCanvasProfile, requireSingleProfileMode } from './couchCanvasProfile';

describe('canvas-profile consumer IDs and edges', () => {
  it('uses one monotonic ID for full builds, stopped builds, patches, and present-only calls', () => {
    const p = createCouchCanvasProfile(2, 'run');
    const ids = [p.begin('full-build', 5), p.begin('full-build', 5), p.begin('retained-patch', 5), p.begin('present-only', 5)];
    expect(ids.map(x => x.operationId)).toEqual([1, 2, 3, 4]);
    expect(ids.map(x => x.sceneRevision)).toEqual([5, 5, 5, 5]);
    p.outcome(ids[1], 'refused', 'pending font');
    p.outcome(ids[2], 'superseded');
    p.outcome(ids[3], 'completed');
    expect(p.snapshot().events.some(x => x.outcome === 'displayed')).toBe(false);
  });
  it('balances a failed synchronous span and reports bounded loss', () => {
    const p = createCouchCanvasProfile(1, 'run', 2), id = p.begin('full-build');
    expect(() => p.span(id, 'couch.build-draw-list', () => { throw new Error('failed'); })).toThrow('failed');
    p.outcome(id, 'failed');
    expect(p.snapshot()).toMatchObject({ droppedEvents: 1, openSpans: [] });
    expect(p.snapshot().events.map(x => x.edge)).toEqual(['start','end']);
    expect(p.snapshot().events.every(x => /^\d+$/.test(x.timestampUs))).toBe(true);
  });
  it('rejects invalid configuration and does not wrap the allocation counter', () => {
    expect(() => createCouchCanvasProfile(1, '')).toThrow();
    expect(() => createCouchCanvasProfile(1, 'run', 0)).toThrow();
  });
  it('rejects mixed legacy revision and monotonic operation ID diagnostics', () => {
    expect(() => requireSingleProfileMode(true, true)).toThrow(/incompatible operation ID/);
    expect(() => requireSingleProfileMode(true, false)).not.toThrow();
  });
});
