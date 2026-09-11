import { affineInverse, IDENTITY_AFFINE, type Affine } from "@/mirror/affine";
import { isCardTrailNode } from "@/mirror/cardTrail";
import {
  advanceCardFlight,
  buildCardFlightPoses,
  cardFlightGlobal6,
  cardFlightGlobal6Into,
  cardFlightPoseAt,
  cardFlightTiming,
  createCardFlight,
  type CardFlightPose,
} from "@/mirror/cardFlight";
import type { MirrorCardFlightHint } from "@/mirror/sceneTree";
import type {
  FlightAnimFailReason,
  FlightRetireReason,
  MirrorWalkStats,
} from "@/mirror/renderer/walkStats";
import {
  flightLogEnabled,
  IDENTITY_G6,
  TRAIL_MASS_FLIGHTS,
} from "@/mirror/renderer/dom/flightTrailPolicy";
import type { CardTrailController } from "@/mirror/renderer/dom/cardTrailController";
import type {
  ActiveCardFlight,
  RenderRecord,
} from "@/mirror/renderer/dom/recordModel";

type Placement = { transform: string | null };

export interface CardFlightControllerPorts {
  records: Map<string, RenderRecord>;
  children: () => Map<string, string[]>;
  trails: () => CardTrailController;
  now: () => number;
  schedule: () => void;
  stats: MirrorWalkStats;
  walkNow: () => number;
  spreadFactor: () => number;
  spreadDxAtGlobal: (record: RenderRecord, g6: readonly number[]) => number;
  placement: (record: RenderRecord, g6: number[]) => Placement;
  writeTransform: (
    record: RenderRecord,
    g6: number[],
    until: number,
    parentInv?: Affine,
  ) => number;
  markParticleDirty: () => void;
}

export interface CardFlightController {
  readonly activeCount: number;
  apply(flights: MirrorCardFlightHint[]): void;
  tick(now: number): number;
  onTrailActivity(): void;
  noteNodeStreamed(id: string, record: RenderRecord): void;
  addVfxId(id: string): void;
  removeRecord(record: RenderRecord): void;
  flightDietCovers(id: string): boolean;
  isFlightOwned(record: RenderRecord): boolean;
  hasRecord(record: RenderRecord): boolean;
  trailSurfaceBlendSuppressed(): boolean;
  noteTrailSurfaceStroke(id: string): void;
  drainDirty(to: Set<string>): void;
}

/** DOM-only card-flight runtime. It owns the live sets, while placement and the renderer's flat records stay in the walk. */
export function createCardFlightController(
  p: CardFlightControllerPorts,
): CardFlightController {
  const activeFlights = new Set<ActiveCardFlight>();
  const flightOwnedTrails = new Set<RenderRecord>();
  const flightOwnedStrokes = new Set<RenderRecord>();
  const cardFlightVfxIds = new Set<string>();
  const flightDietIds = new Set<string>();
  const trailSurfaceBlendIds = new Set<string>();
  const dirty = new Set<string>();
  let flightDietArmed = false;
  let surfaceBlendSuppressed = false;
  let batch: FlightBatchBase | null = null;
  const sampleG6: number[] = [0, 0, 0, 0, 0, 0];
  const samplePose = { x: 0, y: 0, rotation: 0, scale: 1 };
  const trailRootFrame: Affine = [1, 0, 0, 1, 0, 0];
  const strokeOnStage: Affine = [1, 0, 0, 1, 0, 0];

  interface FlightBatchBase {
    atMs: number;
    hints: number;
    unmatched: number;
    armed: number;
    discardArmed: number;
    cssStarted: number;
    steps: number;
    streamed: number;
    parseDrops: number;
    cssFailed: Record<FlightAnimFailReason, number>;
    retired: Record<FlightRetireReason, number>;
  }

  function beginBatch(atMs: number): void {
    if (!flightLogEnabled) return;
    const s = p.stats;
    batch = {
      atMs, hints: s.cardFlightHintsReceived, unmatched: s.flightHintUnmatched,
      armed: s.flightsArmed, discardArmed: s.discardFlightsArmed,
      cssStarted: s.flightCssAnimStarted, steps: s.flightSteps,
      streamed: s.flightNodesStreamed, parseDrops: s.cardFlightParseDrops,
      cssFailed: { ...s.flightCssAnimFailed }, retired: { ...s.flightRetired },
    };
  }
  function reportBatch(): void {
    const base = batch;
    batch = null;
    if (!base || typeof console === "undefined") return;
    const s = p.stats;
    const armed = s.flightsArmed - base.armed;
    const discard = s.discardFlightsArmed - base.discardArmed;
    const steps = s.flightSteps - base.steps;
    const seconds = Math.max(0, p.now() - base.atMs) / 1000;
    const fails = (Object.keys(s.flightCssAnimFailed) as FlightAnimFailReason[])
      .map((k) => [k, s.flightCssAnimFailed[k] - base.cssFailed[k]] as const)
      .filter(([, count]) => count > 0).map(([key, count]) => `${key} ${count}`);
    const retired = (Object.keys(s.flightRetired) as FlightRetireReason[])
      .map((key) => `${key} ${s.flightRetired[key] - base.retired[key]}`).join(" / ");
    const rate = armed > 0 && seconds > 0 ? (steps / armed / seconds).toFixed(1) : "n/a";
    console.info(
      `[mirror] flight batch: ${s.cardFlightHintsReceived - base.hints} hints → ${armed} armed ` +
      `(${armed - discard} shuffle / ${discard} discard, ${s.flightHintUnmatched - base.unmatched} unmatched, ${s.cardFlightParseDrops - base.parseDrops} parse-dropped) · ` +
      `css ${s.flightCssAnimStarted - base.cssStarted}/${armed}${fails.length > 0 ? ` (${fails.join(", ")})` : ""} · ` +
      `steps ${steps} over ${seconds.toFixed(2)}s (${rate}/s/flight) · streamed ${s.flightNodesStreamed - base.streamed} · retired ${retired}`,
    );
  }

  function failCss(reason: FlightAnimFailReason): false {
    p.stats.flightCssAnimFailed[reason]++;
    return false;
  }
  function failCssNull(reason: FlightAnimFailReason): null {
    p.stats.flightCssAnimFailed[reason]++;
    return null;
  }
  function keyframes(flight: ActiveCardFlight): {
    keyframes: Keyframe[];
    durationMs: number;
    startG6: number[];
    endG6: number[];
    endTransform: string;
  } | null {
    const record = flight.target;
    if (!record.lastNode) return null;
    const built = buildCardFlightPoses(flight.hint);
    if (built.poses.length < 2 || !(built.durationMs > 0))
      return failCssNull("degenerate");
    const frames: Keyframe[] = [];
    for (const sample of built.poses) {
      const { transform } = p.placement(record, sample.g6);
      if (transform == null) return failCssNull("boxless");
      frames.push({ offset: sample.offset, transform });
    }
    const timing = cardFlightTiming(flight.hint);
    const pose = cardFlightPoseAt(flight.hint, timing, timing.totalSeconds, 0);
    const endG6 = cardFlightGlobal6(flight.hint.basis, pose, pose.scale);
    const endTransform = p.placement(record, endG6).transform;
    if (endTransform == null) return failCssNull("boxless");
    const inv = record.cInv;
    flight.animParentInv = inv
      ? [inv[0], inv[1], inv[2], inv[3], inv[4], inv[5]]
      : null;
    flight.animSpreadFactor = p.spreadFactor();
    return {
      keyframes: frames,
      durationMs: built.durationMs,
      startG6: built.poses[0].g6,
      endG6,
      endTransform,
    };
  }
  function placementStale(flight: ActiveCardFlight): boolean {
    if (flight.animSpreadFactor !== p.spreadFactor()) return true;
    const baked = flight.animParentInv;
    const inv = flight.target.cInv;
    if (baked == null || inv == null) return baked != null || inv != null;
    for (let i = 0; i < 6; i++) if (baked[i] !== inv[i]) return true;
    return false;
  }
  function startCss(flight: ActiveCardFlight, now: number): boolean {
    const el = flight.target.el;
    if (!el) return failCss("noEl");
    if (!flight.target.lastNode) return failCss("noNode");
    if (typeof el.animate !== "function") return failCss("noWaapi");
    const built = keyframes(flight);
    if (!built) return false;
    flight.timing = cardFlightTiming(flight.hint);
    flight.animStartMs = now;
    flight.animSettled = false;
    const anim = el.animate(built.keyframes, {
      duration: built.durationMs,
      easing: "linear",
      fill: "forwards",
    });
    flight.anim = anim;
    flight.animEndTransform = built.endTransform;
    flight.animEndG6 = built.endG6;
    anim.onfinish = () => {
      if (flight.anim === anim) settleCss(flight);
    };
    p.writeTransform(flight.target, built.startG6, flight.pinUntil);
    p.stats.flightCssAnimStarted++;
    return true;
  }
  function stopCss(flight: ActiveCardFlight): void {
    // Write the true landed inline pose before cancelling `fill: forwards`: no unanimated frame may leak between them.
    const anim = flight.anim;
    if (!anim) return;
    flight.anim = null;
    if (!flight.animSettled) {
      flight.animSettled = true;
      if (
        flight.animEndG6 &&
        p.records.get(flight.targetId) === flight.target &&
        flight.target.el
      )
        p.writeTransform(flight.target, flight.animEndG6, flight.pinUntil);
    }
    anim.cancel();
  }
  function settleCss(flight: ActiveCardFlight): void {
    if (!flight.anim) return;
    stopCss(flight);
    retire(flight, "done");
    p.schedule();
  }
  function rebakeCss(flight: ActiveCardFlight): void {
    const el = flight.target.el;
    const at = Number(flight.anim?.currentTime ?? 0);
    flight.anim?.cancel();
    flight.anim = null;
    const built =
      el && typeof el.animate === "function" ? keyframes(flight) : null;
    if (!built) {
      flight.timing = null;
      flight.state = createCardFlight(flight.hint);
      flight.lastMs = p.now();
      advanceCardFlight(flight.state, flight.hint, at / 1000);
      return;
    }
    const anim = el!.animate(built.keyframes, {
      duration: built.durationMs,
      easing: "linear",
      fill: "forwards",
    });
    anim.currentTime = at;
    flight.anim = anim;
    flight.animEndTransform = built.endTransform;
    flight.animEndG6 = built.endG6;
    anim.onfinish = () => {
      if (flight.anim === anim) settleCss(flight);
    };
  }
  function collectStrokes(trailId: string, out: RenderRecord[]): void {
    for (const childId of p.children().get(trailId) ?? []) {
      const child = p.records.get(childId);
      if (child && child.trailPaths.length > 0)
        out.push(child);
      for (const grandchildId of p.children().get(childId) ?? []) {
        const grandchild = p.records.get(grandchildId);
        if (
          grandchild &&
          grandchild.trailPaths.length > 0
        )
          out.push(grandchild);
      }
    }
  }
  function step(flight: ActiveCardFlight, dt: number): boolean {
    const pose = advanceCardFlight(flight.state, flight.hint, dt);
    const x = p.writeTransform(
      flight.target,
      cardFlightGlobal6(flight.hint.basis, pose, pose.scale),
      flight.pinUntil,
    );
    writeTrailRoot(flight, pose);
    noteHead(flight, x, pose.y);
    return flight.state.phase === "done";
  }
  function stepCss(flight: ActiveCardFlight, now: number): boolean {
    const timing = flight.timing;
    if (!timing) return true;
    const elapsed = Math.min(
      (now - flight.animStartMs) / 1000,
      timing.totalSeconds,
    );
    if (
      flight.strokes.length > 0 ||
      flight.trail !== null
    ) {
      const pose = cardFlightPoseAt(
        flight.hint,
        timing,
        elapsed,
        flight.sampleRotation,
      );
      flight.sampleRotation = pose.rotation;
      samplePose.x = pose.x;
      samplePose.y = pose.y;
      samplePose.rotation = pose.rotation;
      samplePose.scale = pose.scale;
      writeTrailRoot(flight, samplePose);
      if (flight.strokes.length > 0) {
        const g6 = cardFlightGlobal6Into(
          sampleG6,
          flight.hint.basis,
          samplePose,
          pose.scale,
        );
        noteHead(flight, g6[4] + p.spreadDxAtGlobal(flight.target, g6), g6[5]);
      }
    }
    return (now - flight.animStartMs) / 1000 >= timing.totalSeconds;
  }
  function noteHead(flight: ActiveCardFlight, gx: number, gy: number): void {
    for (const stroke of flight.strokes) {
      if (stroke.trailPaths.length === 0) continue;
      const inv = stroke.trailInv ?? IDENTITY_AFFINE;
      const x = inv[0] * gx + inv[2] * gy + inv[4];
      const y = inv[1] * gx + inv[3] * gy + inv[5];
      if (Number.isFinite(x) && Number.isFinite(y))
        p.trails().pushPoint(stroke, x, y);
    }
  }
  // The root carries the whole comet. Strokes counter-pin through its inverse so their latched world frame stays fixed.
  function writeTrailRoot(
    flight: ActiveCardFlight,
    pose: CardFlightPose,
  ): void {
    const trail = flight.trail;
    if (
      !trail?.el ||
      flight.trailId == null ||
      p.records.get(flight.trailId) !== trail ||
      trail.lastNode?.transform == null
    )
      return;
    const root =
      flight.trailRootG6 ?? (flight.trailRootG6 = [0, 0, 0, 0, 0, 0]);
    cardFlightGlobal6Into(root, flight.hint.basis, pose, 1);
    const x = p.writeTransform(trail, root, flight.pinUntil);
    if (!flight.trailRootDriven) {
      flight.trailRootDriven = true;
      p.stats.trailRootDrives++;
    }
    if (flight.strokes.length === 0) return;
    trailRootFrame[0] = root[0];
    trailRootFrame[1] = root[1];
    trailRootFrame[2] = root[2];
    trailRootFrame[3] = root[3];
    trailRootFrame[4] = x;
    trailRootFrame[5] = root[5];
    const inv = affineInverse(trailRootFrame);
    if (!inv) return;
    for (const stroke of flight.strokes) {
      if (
        !stroke.el ||
        stroke.trailPaths.length === 0
      )
        continue;
      const frame = stroke.trailFrame ?? IDENTITY_G6;
      const stageX = p.writeTransform(
        stroke,
        frame as number[],
        flight.pinUntil,
        inv,
      );
      strokeOnStage[0] = frame[0];
      strokeOnStage[1] = frame[1];
      strokeOnStage[2] = frame[2];
      strokeOnStage[3] = frame[3];
      strokeOnStage[4] = stageX;
      strokeOnStage[5] = frame[5];
      p.trails().latchFrame(stroke, frame, strokeOnStage);
    }
  }
  function subtreeHasStroke(id: string, depth: number): boolean {
    const record = p.records.get(id);
    if (record && record.trailPaths.length > 0) return true;
    if (record?.lastNode && isCardTrailNode(record.lastNode)) return true;
    return (
      depth < 4 &&
      (p.children().get(id) ?? []).some((child) =>
        subtreeHasStroke(child, depth + 1),
      )
    );
  }
  function addSubtree(id: string, out: Set<string>, depth: number): void {
    out.add(id);
    if (depth < 4)
      for (const child of p.children().get(id) ?? [])
        addSubtree(child, out, depth + 1);
  }
  function collectDecor(rootId: string, out: Set<string>): void {
    for (const child of p.children().get(rootId) ?? [])
      if (!subtreeHasStroke(child, 0)) addSubtree(child, out, 0);
  }
  function refreshDiet(): void {
    // Edge-driven: a whole volley arms once after its hints are consumed, then only the threshold-crossing disarm restyles.
    const armed = activeFlights.size >= TRAIL_MASS_FLIGHTS;
    if (armed === flightDietArmed) return;
    flightDietArmed = armed;
    if (armed)
      for (const trail of flightOwnedTrails)
        collectDecor(trail.id, flightDietIds);
    if (flightDietIds.size === 0) return;
    for (const id of flightDietIds) dirty.add(id);
    if (!armed) flightDietIds.clear();
  }
  function refreshSurfaceBlend(): void {
    const want = p.trails().surfaceArmed();
    if (want === surfaceBlendSuppressed) return;
    surfaceBlendSuppressed = want;
    if (want) {
      for (const record of p.trails().active) {
        trailSurfaceBlendIds.add(record.id);
        dirty.add(record.id);
      }
      return;
    }
    for (const id of trailSurfaceBlendIds) dirty.add(id);
    trailSurfaceBlendIds.clear();
  }
  function retire(flight: ActiveCardFlight, reason: FlightRetireReason): void {
    if (!activeFlights.delete(flight)) return;
    p.stats.flightRetired[reason]++;
    stopCss(flight);
    if (flight.trail) {
      flightOwnedTrails.delete(flight.trail);
    }
    for (const stroke of flight.strokes) flightOwnedStrokes.delete(stroke);
    refreshDiet();
    if (activeFlights.size === 0) reportBatch();
  }

  return {
    get activeCount() {
      return activeFlights.size;
    },
    apply(flights) {
      if (flights.length === 0) return;
      if (activeFlights.size === 0) beginBatch(p.now());
      p.stats.cardFlightHintsReceived += flights.length;
      const now = p.now();
      for (const hint of flights) {
        const target = p.records.get(hint.targetId);
        if (!target || !target.lastNode) {
          p.stats.flightHintUnmatched++;
          continue;
        }
        const trail =
          hint.trailId != null ? (p.records.get(hint.trailId) ?? null) : null;
        const flight: ActiveCardFlight = {
          hint,
          targetId: hint.targetId,
          target,
          trailId: hint.trailId,
          trail,
          strokes: [],
          state: createCardFlight(hint),
          lastMs: now,
          pinUntil: now + hint.windowMs,
          trailRootG6: null,
          trailRootDriven: false,
          anim: null,
          timing: null,
          animStartMs: now,
          sampleRotation: 0,
          animEndTransform: null,
          animEndG6: null,
          animParentInv: null,
          animSpreadFactor: p.spreadFactor(),
          animSettled: false,
        };
        if (trail) {
          flightOwnedTrails.add(trail);
          collectStrokes(hint.trailId!, flight.strokes);
          for (const stroke of flight.strokes) flightOwnedStrokes.add(stroke);
        }
        activeFlights.add(flight);
        p.stats.flightsArmed++;
        if (hint.kind === "discard") p.stats.discardFlightsArmed++;
        p.stats.flightsPeak = Math.max(p.stats.flightsPeak, activeFlights.size);
        if (startCss(flight, now)) stepCss(flight, now);
        else step(flight, 0);
      }
      flights.length = 0;
      refreshDiet();
      if (activeFlights.size === 0) reportBatch();
      p.schedule();
    },
    tick(now) {
      if (activeFlights.size === 0) return Infinity;
      for (const flight of activeFlights) {
        p.stats.flightSteps++;
        if (p.records.get(flight.targetId) !== flight.target) {
          retire(flight, "noRecord");
          continue;
        }
        if (!flight.target.el) {
          retire(flight, "noEl");
          continue;
        }
        if (now >= flight.pinUntil) {
          retire(flight, "pinExpired");
          continue;
        }
        if (flight.anim && placementStale(flight)) rebakeCss(flight);
        if (flight.anim) {
          if (stepCss(flight, now)) settleCss(flight);
          continue;
        }
        const dt = (now - flight.lastMs) / 1000;
        flight.lastMs = now;
        if (step(flight, dt)) retire(flight, "done");
      }
      return activeFlights.size === 0 ? Infinity : now;
    },
    onTrailActivity() {
      refreshSurfaceBlend();
    },
    noteNodeStreamed(id, record) {
      if (
        cardFlightVfxIds.size !== 0 &&
        record.tweenTransformUntil <= p.walkNow() &&
        cardFlightVfxIds.has(id)
      )
        p.stats.flightNodesStreamed++;
    },
    addVfxId(id) {
      cardFlightVfxIds.add(id);
    },
    removeRecord(record) {
      // Keep the old no-flight fast path: it avoids perturbing the still-set generation for an ordinary teardown.
      if (activeFlights.size > 0) {
        for (const flight of activeFlights)
          if (flight.target === record || flight.trail === record)
            retire(flight, "noRecord");
        flightOwnedTrails.delete(record);
        flightOwnedStrokes.delete(record);
      }
      cardFlightVfxIds.delete(record.id);
      trailSurfaceBlendIds.delete(record.id);
    },
    flightDietCovers(id) {
      return flightDietIds.size !== 0 && flightDietIds.has(id);
    },
    isFlightOwned(record) {
      return flightOwnedStrokes.has(record);
    },
    hasRecord(record) {
      for (const flight of activeFlights)
        if (flight.target === record || flight.trail === record) return true;
      return false;
    },
    trailSurfaceBlendSuppressed() {
      return surfaceBlendSuppressed;
    },
    noteTrailSurfaceStroke(id) {
      if (surfaceBlendSuppressed) trailSurfaceBlendIds.add(id);
    },
    drainDirty(to) {
      for (const id of dirty) to.add(id);
      dirty.clear();
    },
  };
}
