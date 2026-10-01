import { CanvasProfileCollector, type CanvasProfileIdentity, type CanvasProfileEvent } from '@godot-scene-web/canvas';

/** Couch owns IDs and meaning; GSW owns the shared bounded event transport. */
export type ProfileKind = CanvasProfileIdentity['kind'];
export type ProfileOutcome = NonNullable<CanvasProfileEvent['outcome']>;
export type ProfileIdentity = CanvasProfileIdentity & { schema: 'canvas-profile/1' };
export function requireSingleProfileMode(canvasProfile: boolean, legacyExecutionPhases: boolean): void {
  if (canvasProfile && legacyExecutionPhases)
    throw new Error('canvasProfileRun and rustExecutionPhases use incompatible operation ID schemas');
}
export function createCouchCanvasProfile(instance: number, runId: string, capacity = 32768) {
  if (!runId) throw new Error('Invalid canvas profile run ID');
  const collector = new CanvasProfileCollector(capacity);
  let nextOperationId = 0;
  const begin = (kind: ProfileKind, sceneRevision?: number, buildId?: number): ProfileIdentity => {
    if (nextOperationId === 0xffffffff) throw new Error('canvas-profile operation ID exhausted');
    const operationId = ++nextOperationId;
    const identity: ProfileIdentity = { schema: 'canvas-profile/1', runId, rendererInstanceId: String(instance),
      operationId, kind, ...(sceneRevision === undefined ? {} : { sceneRevision }),
      ...(buildId === undefined ? {} : { buildId }) };
    collector.begin(identity);
    return identity;
  };
  return {
    begin,
    span<T>(identity: ProfileIdentity, phase: `couch.${string}`, run: () => T): T {
      return collector.span(identity, phase, run);
    },
    emit(identity: ProfileIdentity, data: Parameters<CanvasProfileCollector['emit']>[1]) { collector.emit(identity, data); },
    outcome(identity: ProfileIdentity, outcome: ProfileOutcome, reason?: string) {
      collector.emit(identity, { eventType: 'outcome', outcome,
        ...(['refused','superseded','failed'].includes(outcome) ? { reason: reason || 'reason unavailable' } : {}) });
    },
    counter(identity: ProfileIdentity, counters: Record<string, number>) {
      collector.emit(identity, { eventType: 'counter', counters });
    },
    snapshot() { return { ...collector.snapshot(), runId, rendererInstanceId: String(instance),
      allocatedOperations: nextOperationId, capacity }; },
  };
}
