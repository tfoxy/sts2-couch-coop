/**
 * `rustIdleInRust`: steady idle frames presented by the Rust renderer alone.
 *
 * On the patch path a frame whose only change is the passive loops (the intent bob, the orb spin) still samples
 * every loop, composes a retained patch, serializes it, has Rust parse it, and presents. Here the lane installs the
 * loops once per committed revision as descriptors (`rustIdleDescriptor.ts`) and each such frame is one synchronous
 * `present_idle(at)`: Rust samples the same curves at `at`, re-poses the same commands with the same f64
 * arithmetic, and presents through its patch machinery. Nothing is published per frame on the JS side.
 *
 * WHAT STAYS EXACT, AND HOW:
 * - Any frame the descriptors cannot express takes the patch path (`tryFrame` answers false, the reason counted):
 *   a tween, an opacity or source sample, an offset move, a landing, a changed override, a changed idle set, an
 *   alpha loop, an executor that is busy. The renderer's own guards (`blocked`) decide the frame-level part.
 * - The JS composition and the hit entries are NOT advanced per frame. Before anything reads them (the patch path
 *   planning a frame, a hit test, a build), `sync()` replays the last presented idle pose into the composition and
 *   publishes its hit poses: a tap lands where the frame on screen drew the node, computed on demand from the same
 *   plans at the drawn clock. The composition then filters its next patch against what Rust actually shows.
 * - The Rust scene revision does not move on an idle frame, so the patch path's next patch applies on top.
 *
 * ONE CALL SITE: the renderer's per-frame patch attempt asks `tryFrame(at)` first. Scheduling is untouched.
 */
import type { CanvasVisualState } from "@/mirror/renderer/canvas/visualState";
import { createIdleAnimSample, sampleIdleAnim } from "@/mirror/canvas/idleAnim";
import { loopPhaseAt } from "@/mirror/canvas/tweenLoop";
import type { LocalAnim } from "@/mirror/canvas/buildDrawList";
import type { HitEntry } from "@/mirror/canvas/hitTest";
import type { Affine } from "@/mirror/affine";
import type { RetainedIdlePlan, RetainedPixiComposition } from "./retainedComposition";
import { RUST_IDLE_BUSY, RUST_IDLE_FULL, RUST_IDLE_PARTIAL, RUST_IDLE_SKIP, RUST_IDLE_UNCHANGED, type IdleRootSpec } from "./rustIdleDescriptor";

/** The executor half (`createRustDrawListExecutor`). */
export interface RustIdleExecutor {
  readonly idleAnims: boolean;
  installIdle(plan: RetainedIdlePlan | null, specs: ReadonlyMap<string, IdleRootSpec>):
    { ok: true; targets: number; animated: number } | { ok: false; reason: string };
  presentIdle(tMs: number): number;
  verifyIdle?(patch: { primitives: unknown[]; groups: unknown[] }, tMs: number): { checked: number; mismatches: string[] };
  idlePoses?(tMs: number): Float64Array | null;
  readonly rustIdleStats?: unknown;
}

export interface RustIdleLanePorts {
  visual: Pick<CanvasVisualState, "localAnims" | "idleGeneration" | "idlePlan" | "loop">;
  composition(): RetainedPixiComposition | null;
  executor(): RustIdleExecutor | null;
  /** Bumped on every published build or patch: the committed scene an installed set was built against. */
  commitKey(): number;
  /** Why the renderer cannot hand this frame to Rust (a sample, offset, landing or override it must draw), or null. */
  blocked(): string | null;
  /** A frame of work starts / settles (the scheduler's patch accounting). */
  begin(): unknown;
  settle(submission: unknown, committed: boolean): void;
  /** `sync()` moved these hit entries: publish them as a patch would. */
  publishHits(hits: ReadonlyArray<{ entry: HitEntry; matrix: Affine }>): void;
  /** The composition could not replay a presented pose: only a full build is trustworthy now. */
  invalidate(reason: string): void;
  /** rustFastVerify: compare each presented frame's poses with the patch path's for the same clock. */
  verify?: boolean;
}

export interface RustIdleLaneStats {
  frames: number; partial: number; full: number; skipped: number; unchanged: number;
  /** The clock of the last frame Rust presented (the frame identity's clock while it is the newest frame). */
  lastPresentedAt: number | null;
  verifyRuns: number; verifyChecked: number; verifyMismatches: number; verifyFirstMismatch: string | null;
  installs: number; syncs: number; syncedHits: number;
  fallbacks: Record<string, number>;
  installRefusals: Record<string, number>;
}

export interface RustIdleLane {
  /**
   * Present this frame in Rust if it is a pure idle frame (true: committed on return; the caller publishes its frame
   * bookkeeping). False: the caller's patch path draws it.
   */
  tryFrame(at: number): boolean;
  /** Bring the composition and hit entries to the last pose Rust presented (cheap when already there). */
  sync(): void;
  /** A build or patch was published: the installed set and any unsynced pose belong to the previous picture. */
  committed(newComposition: boolean): void;
  stats(): RustIdleLaneStats;
}

const TRANSIENT_REFUSALS = new Set(["busy", "no-committed-scene", "engine-refused", "encode", "unsupported", "loop-missing"]);

export function createRustIdleLane(ports: RustIdleLanePorts): RustIdleLane {
  const counts: RustIdleLaneStats = { frames: 0, partial: 0, full: 0, skipped: 0, unchanged: 0, lastPresentedAt: null, verifyRuns: 0,
    verifyChecked: 0, verifyMismatches: 0, verifyFirstMismatch: null, installs: 0, syncs: 0,
    syncedHits: 0, fallbacks: {}, installRefusals: {} };
  const fallback = (reason: string) => { counts.fallbacks[reason] = (counts.fallbacks[reason] ?? 0) + 1; return false; };
  /** The installed descriptors: valid for one commit, idle generation and animated set. */
  let installed: { key: number; generation: number; specs: Map<string, IdleRootSpec> } | null = null;
  /** A structural refusal, kept until the composition, the idle generation or the animated set changes. */
  let refused: { composition: RetainedPixiComposition; generation: number; ids: string; reason: string } | null = null;
  /** The clock of the last idle frame Rust presented that the composition has not replayed yet. */
  let drawnAt: number | null = null;
  const sample = createIdleAnimSample();

  const sameSet = (specs: ReadonlyMap<string, IdleRootSpec>): boolean => {
    const anims = ports.visual.localAnims;
    if (anims.size !== specs.size) return false;
    for (const id of anims.keys()) if (!specs.has(id)) return false;
    return true;
  };

  function specsNow(): Map<string, IdleRootSpec> | string {
    const specs = new Map<string, IdleRootSpec>();
    for (const id of ports.visual.localAnims.keys()) {
      const plan = ports.visual.idlePlan(id);
      const timing = ports.visual.loop.loopTiming(id);
      if (!plan || !timing) return "loop-missing";
      specs.set(id, { plan, timing });
    }
    return specs;
  }

  function install(executor: RustIdleExecutor, composition: RetainedPixiComposition): string | null {
    const generation = ports.visual.idleGeneration;
    const ids = [...ports.visual.localAnims.keys()].join("\u0000");
    if (refused && refused.composition === composition && refused.generation === generation && refused.ids === ids)
      return refused.reason;
    refused = null;
    installed = null;
    const specs = specsNow();
    const result = typeof specs === "string" ? { ok: false as const, reason: specs }
      : executor.installIdle(composition.idlePlan(), specs);
    if (!result.ok) {
      counts.installRefusals[result.reason] = (counts.installRefusals[result.reason] ?? 0) + 1;
      // What the descriptor cannot express holds for this structure; an executor state (busy, nothing committed,
      // an engine refusal) is retried on the next frame.
      if (!TRANSIENT_REFUSALS.has(result.reason)) refused = { composition, generation, ids, reason: result.reason };
      return result.reason;
    }
    counts.installs++;
    installed = { key: ports.commitKey(), generation, specs: specs as Map<string, IdleRootSpec> };
    return null;
  }

  function tryFrame(at: number): boolean {
    const executor = ports.executor();
    const composition = ports.composition();
    if (!executor?.idleAnims || !composition) return fallback("unsupported");
    const blocked = ports.blocked();
    if (blocked) return fallback(blocked);
    if (ports.visual.localAnims.size === 0) return fallback("no-anim");
    if (!installed || installed.key !== ports.commitKey() || installed.generation !== ports.visual.idleGeneration) {
      // An unsynced pose belongs to the old install: replay it before the descriptors move on.
      sync();
      const refusal = install(executor, composition);
      if (refusal) return fallback(refusal);
    } else if (!sameSet(installed.specs)) return fallback("idle-set-changed");
    const submission = ports.begin();
    const code = executor.presentIdle(at);
    if (code === RUST_IDLE_BUSY || code === 0) {
      ports.settle(submission, false);
      if (code === 0) installed = null;
      return fallback(code === 0 ? "present-refused" : "executor-busy");
    }
    ports.settle(submission, true);
    drawnAt = at;
    counts.frames++;
    counts.lastPresentedAt = at;
    if (code & RUST_IDLE_PARTIAL) counts.partial++;
    else if (code & RUST_IDLE_SKIP) counts.skipped++;
    else if (code & RUST_IDLE_FULL) counts.full++;
    if (code & RUST_IDLE_UNCHANGED) counts.unchanged++;
    if (ports.verify && executor.verifyIdle) {
      // The patch path's poses for this very sample, unfiltered: every root at `at`, nothing committed.
      const patch = composition.patch(ports.visual.localAnims, undefined, { unfiltered: true });
      const result = patch ? executor.verifyIdle(patch, at) : { checked: 0, mismatches: ["composition refused the frame"] };
      counts.verifyRuns++;
      counts.verifyChecked += result.checked;
      counts.verifyMismatches += result.mismatches.length;
      counts.verifyFirstMismatch ??= result.mismatches[0] ?? null;
    }
    return true;
  }

  function sync(): void {
    if (drawnAt === null || !installed) { drawnAt = null; return; }
    const at = drawnAt;
    drawnAt = null;
    const composition = ports.composition();
    if (!composition) return;
    const anims = new Map<string, LocalAnim>();
    for (const [id, spec] of installed.specs) {
      // Exactly `sweepIdle`'s sample, at the clock Rust drew.
      sampleIdleAnim(spec.plan, loopPhaseAt(spec.timing, at), sample);
      anims.set(id, { pre: sample.hasPre ? [1, 0, 0, 1, sample.preX, sample.preY] : null,
        post: sample.hasPost ? sample.post.slice() : null });
    }
    const patch = composition.patch(anims);
    if (!patch) { installed = null; ports.invalidate("idle-sync-refused"); return; }
    composition.commit(patch);
    counts.syncs++;
    if (patch.hits.length) { counts.syncedHits += patch.hits.length; ports.publishHits(patch.hits); }
  }

  return {
    tryFrame,
    sync,
    committed(newComposition) {
      // A patch is planned after `sync()`, so the composition already holds every presented pose; a build replaces it.
      if (newComposition) { drawnAt = null; refused = null; }
      installed = null;
    },
    stats: () => ({ ...counts, fallbacks: { ...counts.fallbacks }, installRefusals: { ...counts.installRefusals } }),
  };
}
