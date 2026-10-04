/** Opt-in, bounded frame attribution. Times use the ordinary performance clock. */
export type FrameSource = "animation" | "reconcile" | "texture" | "refinement" | "local" | "clock";
export type FramePhase = "input" | "sample" | "prepare" | "patch" | "build" | "pixi" | "publish";

export interface FrameLifecycleRow {
  id: number;
  source: FrameSource;
  revision: number;
  offeredAt: number;
  admittedAt: number | null;
  completedAt: number | null;
  /** Browser presentation requires a separate content-surface trace join. */
  displayedAt: null;
  /** `applied`: a reconcile applied and acknowledged its delta without presenting (`rustSkipUndrawnWire`). */
  outcome: "offered" | "skipped" | "pending" | "completed" | "failed" | "applied";
  phaseMs: Partial<Record<FramePhase, number>>;
  completedDrawsBefore: number;
  completedDrawsAfter: number | null;
}

const LIMIT = 256;
const SAMPLE_EVERY = 16;

export function createFrameLifecycleDiagnostic(now: () => number) {
  let nextId = 0;
  let inFrame = false;
  let active: FrameLifecycleRow | null = null;
  const phaseStarts = new Map<FramePhase, number>();
  const rows: FrameLifecycleRow[] = [];
  const markNames = new Map<number, string[]>();
  const mark = (row: FrameLifecycleRow, phase: string) => {
    const name = `mirror-frame:${row.id}:${phase}`;
    performance.mark(name);
    markNames.get(row.id)!.push(name);
  };
  function begin(source: FrameSource, revision: number, completedDraws: number): void {
    phaseStarts.clear();
    inFrame = true;
    nextId++;
    active = nextId % SAMPLE_EVERY === 0 ? {
      id: nextId, source, revision, offeredAt: now(), admittedAt: null, completedAt: null,
      displayedAt: null, outcome: "offered", phaseMs: {}, completedDrawsBefore: completedDraws,
      completedDrawsAfter: null,
    } : null;
    if (!active) return;
    rows.push(active);
    markNames.set(active.id, []);
    if (rows.length > LIMIT) {
      const retired = rows.shift()!;
      for (const name of markNames.get(retired.id) ?? []) performance.clearMarks(name);
      markNames.delete(retired.id);
    }
    mark(active, "offered");
  }
  function admit(): void {
    if (!active) return;
    active.admittedAt = now();
    active.outcome = "pending";
    mark(active, "admitted");
  }
  function phase<T>(name: FramePhase, operation: () => T): T {
    if (!active) return operation();
    const start = now();
    mark(active, `${name}:start`);
    try { return operation(); }
    finally {
      active.phaseMs[name] = (active.phaseMs[name] ?? 0) + now() - start;
      mark(active, `${name}:end`);
    }
  }
  function startPhase(name: FramePhase): void {
    if (!active) return;
    phaseStarts.set(name, now());
    mark(active, `${name}:start`);
  }
  function endPhase(name: FramePhase): void {
    if (!active) return;
    const start = phaseStarts.get(name);
    if (start === undefined) return;
    phaseStarts.delete(name);
    active.phaseMs[name] = (active.phaseMs[name] ?? 0) + now() - start;
    mark(active, `${name}:end`);
  }
  function finish(outcome: "skipped" | "pending" | "completed" | "failed" | "applied", completedDraws: number): void {
    inFrame = false;
    phaseStarts.clear();
    if (!active) return;
    active.outcome = outcome;
    active.completedDrawsAfter = completedDraws;
    if (outcome === "completed") active.completedAt = now();
    mark(active, outcome);
    active = null;
  }
  return {
    begin, admit, phase, startPhase, endPhase, finish,
    get inFrame() { return inFrame; },
    report: () => ({ sampleEvery: SAMPLE_EVERY, offered: nextId, rows: rows.map((row) => ({
      ...row, phaseMs: { ...row.phaseMs },
    })) }),
  };
}
