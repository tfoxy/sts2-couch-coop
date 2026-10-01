export type ProducerBuildSource = "wire" | "animation" | "resource" | "resize" | "recovery" | "startup" | "clock" | "local";

export type ProducerBuildObservation = {
  source: ProducerBuildSource;
  decline: string;
  sceneRevision: number;
  committedRevision: number | null;
  changedIds: number;
  sceneRewrite: boolean;
  sampledVisual: boolean;
  sizeChanged: boolean;
  fontChanged: boolean;
  textureCountChanged: boolean;
  resourcesPending: boolean;
  elapsedMs: number;
  windowPhase: number | null;
  sampleClock?: number | null;
  buildEpoch?: number;
  sizeEpoch?: number;
  fontEpoch?: number;
  textureEpoch?: number;
  resourceEpoch?: number;
  frameSampleMask?: number;
};

export type ProducerBuildOutcome = "committed" | "stopped-font-pending" | "stopped-spine-pending" |
  "stopped-texture-pending" | "stopped-resource-failed" | "refused" | "failed" |
  "superseded" | "disposed";
export type ProducerExecutorEvent = { stage: "texture-pending" | "texture-failed" | "encoded" |
  "api-attempt" | "api-accepted" | "api-refused" | "present-call" | "presented" | "present-refused";
  operationId?: number; mode?: "full-scene" | "scene-patch" | "present-only"; dependencyKeys?: readonly string[] };
type Dependency = { kind: "font" | "spine" | "texture"; id: string };
type BuildLedgerRow = ProducerBuildObservation & { buildId: number; state: "pending" | ProducerBuildOutcome;
  events: Array<Omit<ProducerExecutorEvent, "dependencyKeys"> & { dependencies?: Dependency[] }>;
  dependencies: Dependency[] };
type RetainedOperationOutcome = "committed" | "refused" | "failed" | "superseded" | "disposed";
type RetainedOperationRow = { submissionId: number; sceneRevision: number | null;
  mode: "scene-patch" | "present-only"; operationId: number | null;
  state: "pending" | RetainedOperationOutcome; events: ProducerExecutorEvent[] };

const MAX_BUILD_ROWS = 2048;
const MAX_RETAINED_ROWS = 2048;
const MAX_EVENTS_PER_BUILD = 12;
const MAX_DEPENDENCIES = 128;
function hashKey(key: string): string {
  let value = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { value ^= key.charCodeAt(i); value = Math.imul(value, 0x01000193); }
  return (value >>> 0).toString(16).padStart(8, "0");
}

type Bucket = { count: number; elapsedMs: number; firstSceneRevision: number; lastSceneRevision: number;
  firstCommittedRevision: number | null; lastCommittedRevision: number | null };

// Only aggregate stable engineering facts. "none-observed" does not claim that the output was unchanged.
export function createProducerBuildReasons(retainedPhases = false) {
  let total = 0;
  const nonBuild: Record<string, number> = {};
  const bySource: Record<string, Bucket> = {};
  const byDecline: Record<string, Bucket> = {};
  const byObservedInput: Record<string, Bucket> = {};
  const bySourceDecline: Record<string, Bucket> = {};
  const byWindowSourceDecline: Record<string, Bucket> = {};
  const ledger: BuildLedgerRow[] = [];
  const open = new Map<number, BuildLedgerRow>();
  const retainedRows: RetainedOperationRow[] = [];
  const openRetained = new Map<number, RetainedOperationRow>();
  let nextRetainedId = 0, retainedOverflow = false, retainedLateEvents = 0, retainedDuplicateFinalizations = 0;
  const dependencyKeyByHash = new Map<string, string>();
  let nextBuildId = 0, ledgerOverflow = false, duplicateFinalizations = 0, lateEvents = 0, lateTerminalCalls = 0;
  const dependencies = (kind: Dependency["kind"], keys: readonly string[]): Dependency[] => {
    if (keys.length > MAX_DEPENDENCIES) ledgerOverflow = true;
    return keys.slice(0, MAX_DEPENDENCIES).map((key) => {
      const id = hashKey(`${kind}:${key}`);
      const prior = dependencyKeyByHash.get(id);
      if (prior !== undefined && prior !== `${kind}:${key}`) ledgerOverflow = true;
      if (prior === undefined) {
        if (dependencyKeyByHash.size >= 1024) ledgerOverflow = true;
        else dependencyKeyByHash.set(id, `${kind}:${key}`);
      }
      return { kind, id };
    });
  };
  const bump = (table: Record<string, Bucket>, key: string, row: ProducerBuildObservation) => {
    const entry = table[key] ?? (table[key] = { count: 0, elapsedMs: 0,
      firstSceneRevision: row.sceneRevision, lastSceneRevision: row.sceneRevision,
      firstCommittedRevision: row.committedRevision, lastCommittedRevision: row.committedRevision });
    entry.count++;
    entry.elapsedMs += row.elapsedMs;
    entry.lastSceneRevision = row.sceneRevision;
    entry.lastCommittedRevision = row.committedRevision;
  };
  const inputClass = (row: ProducerBuildObservation) => row.sceneRewrite || row.changedIds > 0
    ? "wire-fields-observed" : row.sizeChanged ? "size-observed"
      : row.fontChanged || row.textureCountChanged || row.resourcesPending ? "resource-state-observed"
        : row.sampledVisual ? "sampled-visual-observed"
          : row.sceneRevision !== row.committedRevision ? "wire-revision-only"
            : row.source === "resource" ? "resource-wake-unverified"
              : row.source === "local" ? "local-input-unverified" : "none-observed";
  return {
    noteNonBuild(reason: string) { nonBuild[reason] = (nonBuild[reason] ?? 0) + 1; },
    startRetained(sceneRevision: number | null, mode: RetainedOperationRow["mode"]) {
      const submissionId = ++nextRetainedId;
      if (!retainedPhases) throw new Error("Retained phase ledger is disabled");
      if (retainedRows.length >= MAX_RETAINED_ROWS) { retainedOverflow = true; return submissionId; }
      const entry: RetainedOperationRow = { submissionId, sceneRevision, mode, operationId: null,
        state: "pending", events: [] };
      retainedRows.push(entry); openRetained.set(submissionId, entry);
      return submissionId;
    },
    retainedEvent(submissionId: number, event: ProducerExecutorEvent) {
      const entry = openRetained.get(submissionId);
      if (!entry) { retainedLateEvents++; return; }
      if (entry.events.length >= MAX_EVENTS_PER_BUILD || event.dependencyKeys) { retainedOverflow = true; return; }
      if (event.operationId !== undefined) {
        if (entry.operationId !== null && entry.operationId !== event.operationId) retainedOverflow = true;
        entry.operationId = event.operationId;
      }
      entry.events.push(event);
    },
    finishRetained(submissionId: number, outcome: RetainedOperationOutcome) {
      const entry = openRetained.get(submissionId);
      if (!entry) { retainedDuplicateFinalizations++; return false; }
      entry.state = outcome; openRetained.delete(submissionId); return true;
    },
    finishRetainedIfOpen(submissionId: number, outcome: RetainedOperationOutcome) {
      if (!openRetained.has(submissionId)) return false;
      return this.finishRetained(submissionId, outcome);
    },
    add(row: ProducerBuildObservation) {
      total++;
      bump(bySource, row.source, row);
      bump(byDecline, row.decline, row);
      bump(byObservedInput, inputClass(row), row);
      bump(bySourceDecline, `${row.source}:${row.decline}`, row);
      bump(byWindowSourceDecline, `${row.windowPhase ?? "unmarked"}:${row.source}:${row.decline}`, row);
      const buildId = ++nextBuildId;
      if (ledger.length >= MAX_BUILD_ROWS) { ledgerOverflow = true; return buildId; }
      const entry: BuildLedgerRow = { ...row, buildId, state: "pending", events: [], dependencies: [] };
      ledger.push(entry); open.set(buildId, entry);
      return buildId;
    },
    event(buildId: number, event: ProducerExecutorEvent) {
      const entry = open.get(buildId);
      if (!entry) { if (buildId <= nextBuildId) lateEvents++; else ledgerOverflow = true; return; }
      if (entry.events.length >= MAX_EVENTS_PER_BUILD) { ledgerOverflow = true; return; }
      const { dependencyKeys, ...rest } = event;
      entry.events.push({ ...rest, ...(dependencyKeys ? { dependencies: dependencies("texture", dependencyKeys) } : {}) });
    },
    finish(buildId: number, outcome: ProducerBuildOutcome, dependencyKind?: Dependency["kind"], keys: readonly string[] = []) {
      const entry = open.get(buildId);
      if (!entry) { duplicateFinalizations++; return false; }
      let textureEvent: (typeof entry.events)[number] | undefined;
      for (let i = entry.events.length - 1; i >= 0; i--) {
        if (entry.events[i].stage === "texture-pending" || entry.events[i].stage === "texture-failed") {
          textureEvent = entry.events[i]; break;
        }
      }
      // Report the first blocking barrier reached by this build. Earlier font or spine barriers
      // prevent executor texture preflight, so these are not a complete dependency inventory.
      entry.state = outcome === "refused" && textureEvent?.stage === "texture-pending" ? "stopped-texture-pending"
        : outcome === "refused" && textureEvent?.stage === "texture-failed" ? "stopped-resource-failed" : outcome;
      if (dependencyKind) entry.dependencies = dependencies(dependencyKind, keys);
      else if (textureEvent?.dependencies) entry.dependencies = textureEvent.dependencies;
      open.delete(buildId);
      return true;
    },
    finishIfOpen(buildId: number, outcome: ProducerBuildOutcome) {
      if (!open.has(buildId)) { lateTerminalCalls++; return false; }
      return this.finish(buildId, outcome);
    },
    disposeOpen() {
      for (const entry of open.values()) entry.state = "disposed";
      open.clear();
      for (const entry of openRetained.values()) entry.state = "disposed";
      openRetained.clear();
    },
    snapshot() {
      const copy = (table: Record<string, Bucket>) => Object.fromEntries(Object.entries(table).map(([key, value]) => [key, { ...value }]));
      return { total, nonBuild: { ...nonBuild }, bySource: copy(bySource), byDecline: copy(byDecline), byObservedInput: copy(byObservedInput),
        bySourceDecline: copy(bySourceDecline), byWindowSourceDecline: copy(byWindowSourceDecline),
        ...(retainedPhases ? { retainedOperations: { capacity: MAX_RETAINED_ROWS,
          starts: nextRetainedId, terminal: nextRetainedId - openRetained.size,
          openSubmissionIds: [...openRetained.keys()], overflow: retainedOverflow,
          lateEvents: retainedLateEvents, duplicateFinalizations: retainedDuplicateFinalizations,
          complete: !retainedOverflow && retainedLateEvents === 0 && retainedDuplicateFinalizations === 0 &&
            openRetained.size === 0 && nextRetainedId === retainedRows.length,
          rows: retainedRows.map((entry) => ({ ...entry, events: entry.events.map((event) => ({ ...event })) })) } } : {}),
        ledger: { capacity: MAX_BUILD_ROWS, snapshotAtMs: performance.now(), timeOrigin: performance.timeOrigin,
          overflow: ledgerOverflow, duplicateFinalizations, lateEvents, lateTerminalCalls,
          starts: nextBuildId, terminal: nextBuildId - open.size, openBuildIds: [...open.keys()],
          complete: !ledgerOverflow && duplicateFinalizations === 0 && lateEvents === 0 && lateTerminalCalls === 0 && open.size === 0 && nextBuildId === ledger.length,
          rows: ledger.map((entry) => ({ ...entry, events: entry.events.map((event) => ({ ...event,
            dependencies: event.dependencies?.map((dependency) => ({ ...dependency })) })),
            dependencies: entry.dependencies.map((dependency) => ({ ...dependency })) })) } };
    },
  };
}
