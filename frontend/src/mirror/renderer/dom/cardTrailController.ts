import { affineInverse, IDENTITY_AFFINE, type Affine } from "@/mirror/affine";
import { layoutScale } from "@/mirror/stageFit";

/**
 * LAYOUT SPACE for the comet ribbon (stageFit.ts) — and the ONE place in this change that scales a whole SVG USER
 * SPACE instead of individual lengths.
 *
 * The ribbon is a path `d` string plus `userSpaceOnUse` gradient endpoints, all authored in the node's local space
 * by `cardTrail.ts`'s pure geometry builder. That builder is shared with the canvas backend, so it must keep
 * answering in design space, and rewriting a path string per frame to scale it would be both slow and lossy.
 * Scaling the `<svg>` host's user space converts the path, the band widths and the gradient endpoints in one write.
 *
 * This is a scaled ancestor, which is the very thing the display arm exists to remove — deliberately accepted here:
 * a comet is a handful of `<path>`s inside one `<svg>`, against the ~1,300 promoted elements of the game tree, and
 * it lives under a second (`TRAIL_POINT_DURATION_MS`). If a trail is ever measured as a real layer cost on WebKit,
 * the fix is to teach the builder a scale, not to widen this exception.
 */
function applyTrailUserSpaceScale(svg: SVGElement | null): void {
  if (!svg) return;
  const s = layoutScale();
  const want = s === 1 ? "" : `scale(${s})`;
  if (svg.style.transform !== want) {
    svg.style.transform = want;
    svg.style.transformOrigin = s === 1 ? "" : "0 0";
  }
}
import {
  buildTrailRibbon,
  buildTrailStrip,
  createTrailPoints,
  expireTrailPoints,
  nextTrailExpiryMs,
  pushTrailPoint,
  trailProfile,
  TRAIL_POINT_DURATION_MS,
  type TrailStrip,
} from "@/mirror/cardTrail";
import { renderQuality } from "@/render/quality";
import {
  SVG_NS,
  takeTrailGradientId,
  trailBandOpacityTag,
  trailMassBands,
  trailSurfaceLifeMs,
  trailSurfaceNoblendAlpha,
  trailSurfaceStrokes,
  TRAIL_MASS_HOLD_MS,
  TRAIL_MASS_PAINT_MS,
  TRAIL_MASS_POINT_CAP,
  TRAIL_MASS_STROKES,
  TRAIL_REPAINT_MIN_MS,
  TRAIL_SURFACE_HOLD_MS,
  round4,
} from "@/mirror/renderer/dom/flightTrailPolicy";
import type { RenderRecord } from "@/mirror/renderer/dom/recordModel";
import { mirrorWalkStats } from "@/mirror/renderer/walkStats";

export interface TrailScaffold {
  div: HTMLElement;
  paths: SVGPathElement[];
  gradient: SVGLinearGradientElement;
  stops: SVGStopElement[];
  bandOpacitySig: string | null;
}

export interface CardTrailController {
  active: Set<RenderRecord>;
  acquire(bands: number): TrailScaffold;
  release(record: RenderRecord): void;
  releaseFrame(record: RenderRecord): void;
  latchFrame(
    record: RenderRecord,
    frame: readonly number[],
    onStage: readonly number[],
  ): void;
  syncBandOpacity(record: RenderRecord): void;
  noteSample(
    record: RenderRecord,
    nodeGlobal: Affine,
    designGlobal: Affine,
    parentGlobal: Affine,
    parentDx: number,
  ): void;
  pushPoint(record: RenderRecord, x: number, y: number): void;
  tick(now: number): number;
  surfaceArmed(): boolean;
  liveStrokeThresholdArmed(): boolean;
  massArmed(): boolean;
  stripFor(record: RenderRecord, name: string): TrailStrip | null;
  dispose(): void;
}

export function createCardTrailController(ports: {
  now(): number;
  noteDeadline(until: number): void;
  isFlightOwned(id: string): boolean;
  onActivity(): void;
}): CardTrailController {
  const active = new Set<RenderRecord>();
  const pool: TrailScaffold[] = [];
  const POOL_MAX = 64;
  let massHoldUntil = -1;
  let surfaceHoldUntil = -1;
  let surfaceArea = 0;

  function latchFrame(
    record: RenderRecord,
    frame: readonly number[],
    onStage: readonly number[],
  ): void {
    if (record.trailFrame !== null) return;
    record.trailFrame = [
      frame[0],
      frame[1],
      frame[2],
      frame[3],
      frame[4],
      frame[5],
    ];
    record.trailInv = affineInverse(onStage as Affine) ?? IDENTITY_AFFINE;
  }
  function releaseFrame(record: RenderRecord): void {
    record.trailFrame = null;
    record.trailInv = null;
  }
  function massArmed(): boolean {
    if (active.size >= TRAIL_MASS_STROKES) {
      massHoldUntil = ports.now() + TRAIL_MASS_HOLD_MS;
      return true;
    }
    if (massHoldUntil < 0) return false;
    if (ports.now() < massHoldUntil) return true;
    massHoldUntil = -1;
    return false;
  }
  function liveStrokeThresholdArmed(): boolean {
    if (active.size >= trailSurfaceStrokes) {
      surfaceHoldUntil = ports.now() + TRAIL_SURFACE_HOLD_MS;
      return true;
    }
    if (surfaceHoldUntil < 0) return false;
    if (ports.now() < surfaceHoldUntil) return true;
    surfaceHoldUntil = -1;
    return false;
  }
  function surfaceArmed(): boolean {
    return liveStrokeThresholdArmed();
  }
  function lifeMs(): number {
    return surfaceArmed()
      ? trailSurfaceLifeMs
      : TRAIL_POINT_DURATION_MS;
  }
  function pointBudget(): number {
    const tier = renderQuality().maxTrailPoints;
    if (!massArmed()) return tier;
    return tier > 0
      ? Math.min(tier, TRAIL_MASS_POINT_CAP)
      : TRAIL_MASS_POINT_CAP;
  }
  function repaintMs(): number {
    return massArmed() && TRAIL_MASS_PAINT_MS > TRAIL_REPAINT_MIN_MS
      ? TRAIL_MASS_PAINT_MS
      : TRAIL_REPAINT_MIN_MS;
  }
  function arm(
    record: RenderRecord,
    points: NonNullable<RenderRecord["trailPoints"]>,
    life: number,
  ): void {
    const due = nextTrailExpiryMs(points, life);
    if (due === Infinity) {
      active.delete(record);
      return;
    }
    active.add(record);
    if (active.size > mirrorWalkStats.trailStrokesPeak)
      mirrorWalkStats.trailStrokesPeak = active.size;
    ports.noteDeadline(due);
  }
  function noteArea(record: RenderRecord, area: number): void {
    if (area === record.trailStandingBboxArea) return;
    surfaceArea += area - record.trailStandingBboxArea;
    record.trailStandingBboxArea = area;
    if (surfaceArea > mirrorWalkStats.trailSurfaceAreaPeak)
      mirrorWalkStats.trailSurfaceAreaPeak = surfaceArea;
  }
  function blank(record: RenderRecord): void {
    if (record.trailD === "") return;
    record.trailD = "";
    record.trailBandsPainted = 0;
    for (const path of record.trailPaths) path.removeAttribute("d");
    noteArea(record, 0);
  }
  function syncStops(
    record: RenderRecord,
    gradient: SVGLinearGradientElement,
    stops: Array<{ offset: number; opacity: number }>,
  ): void {
    const els = record.trailStops;
    while (els.length > stops.length) els.pop()!.remove();
    while (els.length < stops.length) {
      const stop = document.createElementNS(SVG_NS, "stop");
      stop.setAttribute("stop-color", "#ffffff");
      gradient.appendChild(stop);
      els.push(stop);
    }
    const sigs = record.trailStopSigs;
    sigs.length = stops.length;
    for (let i = 0; i < stops.length; i++) {
      const offset = String(round4(stops[i].offset));
      const opacity = String(round4(stops[i].opacity));
      const sig = `${offset}|${opacity}`;
      if (sigs[i] === sig) continue;
      sigs[i] = sig;
      els[i].setAttribute("offset", offset);
      els[i].setAttribute("stop-opacity", opacity);
    }
  }
  function paint(record: RenderRecord, at = ports.now()): void {
    const {
      trailPaths: paths,
      trailGradient: gradient,
      trailPoints: points,
    } = record;
    if (paths.length === 0 || !gradient || !points) return;
    record.trailPaintedAtMs = at;
    const surface = surfaceArmed();
    mirrorWalkStats.trailPaints++;
    if (points.spawnMs.length > mirrorWalkStats.trailPointsPeak)
      mirrorWalkStats.trailPointsPeak = points.spawnMs.length;
    const mass = massArmed();
    if (mass) mirrorWalkStats.flightDietFrames++;
    const profile = record.trailProfile ?? trailProfile(null);
    const ribbon = buildTrailRibbon(
      points,
      profile,
      mass ? trailMassBands : undefined,
    );
    if (!ribbon) {
      blank(record);
      return;
    }
    if (surface) {
      for (const band of ribbon.bands)
        band.opacity = Math.min(1, band.opacity * trailSurfaceNoblendAlpha);
    }
    const opacityTag = trailBandOpacityTag(
      ribbon.bands,
      mass,
      surface,
    );
    const opacityChanged = record.trailBandOpacitySig !== opacityTag;
    if (
      record.trailBandsPainted !== ribbon.bands.length ||
      record.trailD !== ribbon.bands[0].d ||
      opacityChanged
    ) {
      record.trailD = ribbon.bands[0].d;
      record.trailBandOpacitySig = opacityTag;
      // The pooled scaffold may predate a fit change (a rotation mid-comet), so re-assert the user-space scale on
      // the frame the geometry is rewritten. Idempotent string compare inside; a no-op on the default arm.
      applyTrailUserSpaceScale(paths[0]?.ownerSVGElement ?? null);
      for (let i = 0; i < paths.length && i < ribbon.bands.length; i++) {
        paths[i].setAttribute("d", ribbon.bands[i].d);
        mirrorWalkStats.trailPathWrites++;
        if (opacityChanged)
          paths[i].setAttribute(
            "fill-opacity",
            String(round4(ribbon.bands[i].opacity)),
          );
      }
      for (
        let i = ribbon.bands.length;
        i < record.trailBandsPainted && i < paths.length;
        i++
      )
        paths[i].removeAttribute("d");
      record.trailBandsPainted = ribbon.bands.length;
      mirrorWalkStats.trailPathBboxAreaSum +=
        ribbon.bboxArea * ribbon.bands.length;
      noteArea(record, ribbon.bboxArea);
    }
    {
      const tail = `${ribbon.x1}|${ribbon.y1}`;
      if (record.trailGradTailSig !== tail) {
        record.trailGradTailSig = tail;
        gradient.setAttribute("x1", String(ribbon.x1));
        gradient.setAttribute("y1", String(ribbon.y1));
      }
      const head = `${ribbon.x2}|${ribbon.y2}`;
      if (record.trailGradHeadSig !== head) {
        record.trailGradHeadSig = head;
        gradient.setAttribute("x2", String(ribbon.x2));
        gradient.setAttribute("y2", String(ribbon.y2));
      }
    }
    if (!mass || record.trailStopSigs.length === 0)
      syncStops(record, gradient, ribbon.stops);
  }
  function pushPoint(record: RenderRecord, x: number, y: number): void {
    const points =
      record.trailPoints ?? (record.trailPoints = createTrailPoints());
    const now = ports.now();
    const life = lifeMs();
    const push = pushTrailPoint(points, x, y, now, {
      lifeMs: life,
      budget: pointBudget(),
      paintMinMs: massArmed() ? TRAIL_MASS_PAINT_MS : 0,
      paintedAtMs: record.trailPaintedAtMs,
    });
    if (push.teleported) mirrorWalkStats.trailTeleportCuts++;
    if (push.decimated) mirrorWalkStats.trailDecimations++;
    if (!push.changed) return;
    if (!push.paint) {
      record.trailAgedPending = true;
      arm(record, points, life);
      ports.onActivity();
      return;
    }
    record.trailAgedPending = false;
    record.trailRepaintDeferred = false;
    paint(record, now);
    arm(record, points, life);
    ports.onActivity();
  }
  function noteSample(
    record: RenderRecord,
    nodeGlobal: Affine,
    designGlobal: Affine,
    parentGlobal: Affine,
    parentDx: number,
  ): void {
    if (record.trailPaths.length === 0)
      return;
    latchFrame(record, designGlobal, nodeGlobal);
    if (ports.isFlightOwned(record.id)) return;
    const inv = record.trailInv ?? IDENTITY_AFFINE;
    const x =
      inv[0] * (parentGlobal[4] + parentDx) + inv[2] * parentGlobal[5] + inv[4];
    const y =
      inv[1] * (parentGlobal[4] + parentDx) + inv[3] * parentGlobal[5] + inv[5];
    if (Number.isFinite(x) && Number.isFinite(y)) pushPoint(record, x, y);
  }
  function tick(now: number): number {
    let next = Infinity;
    ports.onActivity();
    const life = lifeMs();
    for (const record of active) {
      const points = record.trailPoints;
      if (!points || record.trailPaths.length === 0) {
        active.delete(record);
        releaseFrame(record);
        continue;
      }
      if (expireTrailPoints(points, now, life)) record.trailAgedPending = true;
      const window = repaintMs();
      const defer =
        (massArmed() || !record.trailRepaintDeferred) &&
        now - record.trailPaintedAtMs < window;
      if (record.trailAgedPending && !defer) {
        record.trailAgedPending = false;
        record.trailRepaintDeferred = false;
        paint(record, now);
      } else if (record.trailAgedPending) record.trailRepaintDeferred = true;
      const due = nextTrailExpiryMs(points, life);
      if (due === Infinity && !record.trailAgedPending) {
        active.delete(record);
        releaseFrame(record);
      } else if (due < next) next = due;
      if (record.trailAgedPending)
        next = Math.min(next, record.trailPaintedAtMs + window);
    }
    return next;
  }
  function acquire(bands: number): TrailScaffold {
    mirrorWalkStats.trailScaffoldAcquires++;
    for (let i = pool.length - 1; i >= 0; i--)
      if (pool[i].paths.length === bands) {
        mirrorWalkStats.trailScaffoldReuses++;
        return pool.splice(i, 1)[0];
      }
    const div = document.createElement("div");
    div.className = "mirror-trail";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "1");
    svg.setAttribute("height", "1");
    svg.style.overflow = "visible";
    svg.style.display = "block";
    applyTrailUserSpaceScale(svg);
    const defs = document.createElementNS(SVG_NS, "defs");
    const gradient = document.createElementNS(SVG_NS, "linearGradient");
    gradient.setAttribute("id", `mtrail-${takeTrailGradientId()}`);
    gradient.setAttribute("gradientUnits", "userSpaceOnUse");
    defs.appendChild(gradient);
    svg.appendChild(defs);
    const paths: SVGPathElement[] = [];
    for (let i = 0; i < bands; i++) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("fill", `url(#${gradient.getAttribute("id")})`);
      path.setAttribute("stroke", "none");
      svg.appendChild(path);
      paths.push(path);
    }
    div.appendChild(svg);
    return { div, gradient, paths, stops: [], bandOpacitySig: null };
  }
  function release(record: RenderRecord): void {
    noteArea(record, 0);
    const div = record.trailDiv;
    if (!div) return;
    div.remove();
    if (
      !record.trailGradient ||
      active.has(record) ||
      pool.length >= POOL_MAX
    )
      return;
    for (const path of record.trailPaths) path.removeAttribute("d");
    pool.push({
      div,
      gradient: record.trailGradient,
      paths: record.trailPaths,
      stops: record.trailStops,
      bandOpacitySig: record.trailBandOpacitySig,
    });
  }
  function syncBandOpacity(record: RenderRecord): void {
    const profile = record.trailProfile;
    if (!profile) return;
    const bands = profile.bands.map((band) => ({
      opacity: band.alpha * profile.baseAlpha,
    }));
    const tag = trailBandOpacityTag(bands, false);
    if (record.trailBandOpacitySig === tag) return;
    record.trailBandOpacitySig = tag;
    for (let i = 0; i < record.trailPaths.length && i < bands.length; i++)
      record.trailPaths[i].setAttribute(
        "fill-opacity",
        String(round4(bands[i].opacity)),
      );
  }
  function stripFor(record: RenderRecord, name: string): TrailStrip | null {
    if (!record.trailPoints) return null;
    const surface = surfaceArmed();
    const profile = record.trailProfile ?? trailProfile(name);
    const mass = massArmed();
    return buildTrailStrip(
      record.trailPoints,
      profile,
      {
        textured: false,
        maxBands: mass ? trailMassBands : undefined,
        alphaScale: surface ? trailSurfaceNoblendAlpha : 1,
      },
    );
  }
  function dispose(): void {
    active.clear();
    pool.length = 0;
    massHoldUntil = -1;
    surfaceHoldUntil = -1;
    surfaceArea = 0;
  }
  return {
    active,
    acquire,
    release,
    releaseFrame,
    latchFrame,
    syncBandOpacity,
    noteSample,
    pushPoint,
    tick,
    surfaceArmed,
    liveStrokeThresholdArmed,
    massArmed,
    stripFor,
    dispose,
  };
}
