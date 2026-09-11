/**
 * Canvas visual state and geometry policy.
 *
 * The DOM renderer lets CSS retain an endpoint on an element.  A canvas list is
 * rebuilt from data, so tween samples, decorative loops and intent-frame
 * substitutions must be retained explicitly until a streamed value takes them
 * back. This module owns that retained state plus the renderer-local geometry
 * policy (spread, readable stamps, landing diagnostics and global transforms);
 * its host supplies scene access and performs the build/paint/scheduling work.
 */
import type { Affine } from "@/mirror/affine";
import {
  createLandingLog,
  type LandingLogReport,
  type LandingProbe,
} from "@/mirror/landingLog";
import {
  createSpreadAudit,
  spreadAuditReport,
  type SpreadAudit,
} from "@/mirror/canvas/spreadAudit";
import { type HitEntry } from "@/mirror/canvas/hitTest";
import { type PaintOrder } from "@/mirror/canvas/paintOrder";
import { pointInPlacedRect } from "@/mirror/raiseInverse";
import {
  fieldDxAtGlobal,
  fieldDxAtOriginX,
  spreadDrawBox,
} from "@/mirror/spreadLayout";
import { designAabbOf, type ViewScaleEnv } from "@/mirror/viewScaleLayout";
import { viewScaleSharedEnv } from "@/mirror/renderer/staticBackgroundPolicy";
import { resolveSceneInfo } from "@/mirror/renderer/sceneIdentity";
import { intentFrameIndex } from "@/mirror/renderer/intentPolicy";
import { tipScaleOn } from "@/mirror/renderer/sharedFeatureFlags";
import { type MirrorNode, type MirrorState } from "@/mirror/sceneTree";
import { placementBox } from "@/mirror/nodeStyles";
import {
  planTweenHints,
  type TweenTargetFacts,
} from "@/mirror/canvas/tweenPlan";
import {
  ALPHA_OPACITY,
  ALPHA_SELF_OPACITY,
  SAMPLE_LOCAL_ANIM,
  SAMPLE_NONE,
  SAMPLE_OPACITY,
  SAMPLE_SELF_OPACITY,
  SAMPLE_SOURCE,
  SAMPLE_TRANSFORM,
  bobPhaseMs,
  createTweenLoop,
  loopSpecFromBinding,
  type SampleMask,
  type TweenLoop,
} from "@/mirror/canvas/tweenLoop";
import {
  createIdleAnimSample,
  resolveIdleAnim,
  sampleIdleAnim,
  type IdleAnimPlan,
} from "@/mirror/canvas/idleAnim";
import type {
  AlphaOverride,
  CanvasTipScaleEnv,
  CapturedGlobal,
  LocalAnim,
  PinnedLocalSource,
  SpreadRegistry,
} from "@/mirror/canvas/buildDrawList";

const IDLE_CANDIDATE_NAMES: ReadonlySet<string> = new Set([
  "IntentHolder",
  "Layer1",
  "Layer2",
  "Layer3",
]);

export interface CanvasVisualPorts {
  state(): MirrorState | null;
  nodeOf(id: string): MirrorNode | undefined;
  hasChildren(id: string): boolean;
  /** The last atomically published paint order; null before the first build. */
  paintOrder(): PaintOrder | null;
  /** The last atomically published hit list, in paint order. */
  hitEntries(): readonly HitEntry[];
  /** The build-captured raw/drawn globals from that same published frame. */
  capturedGlobal(id: string): CapturedGlobal | undefined;
  /** The cosmetic hand/hold raise applied on top of a captured drawn global. */
  cosmeticOffsetDy(id: string): number;
  effectivelyVisible(node: MirrorNode): boolean;
  isLandingTarget(id: string): boolean;
  onNodePresent(node: MirrorNode): void;
  onNodeRemoved(id: string): void;
  onRewrite(): void;
  onFlights(flights: MirrorState["pendingCardFlights"], at: number): void;
}

interface IdleEntry extends LocalAnim {
  node: MirrorNode;
  plan: IdleAnimPlan | null;
  pre: number[] | null;
  post: number[] | null;
  readonly preBuf: number[];
  readonly postBuf: number[];
}

interface IntentEntry {
  node: MirrorNode;
  spec: NonNullable<MirrorNode["intentFrames"]>;
  startMs: number;
  shownFrame: number;
}

export interface LandingArm {
  nodeId: string;
  end: readonly number[];
  durationMs: number;
  atMs: number;
}

export interface CanvasVisualState {
  readonly loop: TweenLoop;
  readonly transformOverrides: Map<string, number[]>;
  readonly alphaOverrides: Map<string, AlphaOverride>;
  /** Values that were actually baked into the current draw list. */
  readonly alphaApplied: Map<string, AlphaOverride>;
  readonly localAnims: ReadonlyMap<string, LocalAnim>;
  readonly frameSubstitutes: ReadonlyMap<string, MirrorNode>;
  readonly opacitySampledIds: ReadonlySet<string>;
  readonly sourceSampledIds: ReadonlySet<string>;
  readonly landingArms: readonly LandingArm[];
  /** Per-renderer map-stroke local latches; node ids are stream-local. */
  readonly mapStrokeLocals: ReadonlyMap<string, Affine>;
  readonly mapStrokePinReuses: number;
  /** Every node's absolute wide-stage displacement from the last full build. */
  readonly spreadDxByNode: Map<string, number>;
  /** The field branch which produced each retained spread displacement. */
  readonly spreadFieldModeByNode: Map<string, number>;
  readonly spreadRegistry: SpreadRegistry;
  readonly spreadAudit: SpreadAudit | null;
  readonly spreadFactor: number;
  readonly viewScaleEnv: ViewScaleEnv;
  readonly tipScaleEnv: CanvasTipScaleEnv;
  readonly pinnedLocals: PinnedLocalSource | null;
  readonly frameSampleMask: SampleMask;
  readonly activeAnimIds: ReadonlySet<string>;
  /** Set the current build's node map before its policy env is consulted. */
  prepareBuild(next: MirrorState): void;
  /** Drop retained owner shifts when the public wide-stage factor changes. */
  setStretch(factor: number): boolean;
  /** Global composition shared by visual samples, interaction and stage effects. */
  renderedGlobalInto(next: MirrorState | null, id: string, out: number[]): boolean;
  /** Override-blind global composition, for producer-authored positions. */
  streamedGlobalInto(next: MirrorState | null, id: string, out: number[]): boolean;
  /** Lift a local tween endpoint into the producer's streamed global space. */
  liftEndpoint(
    next: MirrorState,
    node: MirrorNode,
    endpoint: readonly number[] | null | undefined,
  ): readonly number[] | null;
  applyInputs(next: MirrorState, at: number): void;
  sample(at: number): void;
  advance(at: number): void;
  idleDeadline(at: number, fps: number, phaseDeadline: number): number;
  consumeLandingArms(): LandingArm[];
  /** Bank alpha overrides after a full build, never after an in-place patch. */
  bankAppliedAlphas(): void;
  /** Price pending hand-card endpoints only after the current build banked its field claims. */
  flushLandingArms(next: MirrorState): void;
  /** Score arms against the published painted frame. */
  settleLanding(at: number): void;
  /** Read also settles due rows, preserving the diagnostics seam's contract. */
  landingLogReport(): LandingLogReport;
  /** A diagnostic-only report; undefined when the audit was never armed. */
  spreadAuditReport(): ReturnType<typeof spreadAuditReport> | undefined;
  intentNode(id: string): MirrorNode | undefined;
  readonly idleStageNotBefore: number;
  noteIdleStageAdmission(at: number, minFrameMs: number): void;
  noteIdleStageSkippedEarly(): void;
  noteIdleStageMissingPassive(): void;
  idleLoopCount(channel: "transform" | "alpha"): number;
  stats(): {
    idleActive: number;
    idleFrames: number;
    idleRebuilds: number;
    idleInvisible: number;
    idlePlans: number;
    intentCycles: number;
    intentSwaps: number;
    reparentDrops: number;
    hintTransformRebased: number;
    idleStageAdmittedPassive: number;
    idleStageSkippedEarly: number;
    idleStageMissingPassive: number;
    idleStageAdmittedEarlySlack: number;
    idleStagePhaseResets: number;
    idleStageMinAdmittedGap: number;
    idleStageAdmittedGaps: readonly number[];
  };
}

export function createCanvasVisualState(
  ports: CanvasVisualPorts,
  options: {
    clockOriginMs: number;
    now(): number;
    spreadAuditEnabled: boolean;
    noteIdlePeriod(at: number): void;
  },
): CanvasVisualState {
  const transformOverrides = new Map<string, number[]>();
  const alphaOverrides = new Map<string, AlphaOverride>();
  const alphaApplied = new Map<string, AlphaOverride>();
  const localAnims = new Map<string, IdleEntry>();
  const opacitySampledIds = new Set<string>();
  const sourceSampledIds = new Set<string>();
  const frameSubstitutes = new Map<string, MirrorNode>();
  const idleEntries = new Map<string, IdleEntry>();
  const intentEntries = new Map<string, IntentEntry>();
  const transformParents = new Map<string, string | null>();
  const landingArms: LandingArm[] = [];
  // PER RENDERER: node ids are only unique within one stream, so a map-stroke
  // latch must never survive a remount. The source wire matrix is replaced on
  // static-bearing upserts, hence the first-sight copy below.
  const mapStrokeLocals = new Map<string, Affine>();
  let mapStrokePinReuses = 0;
  const pinnedLocals: PinnedLocalSource = {
        pin(id, local) {
          const latched = mapStrokeLocals.get(id);
          if (latched !== undefined) {
            mapStrokePinReuses++;
            return latched;
          }
          const own: Affine = [
            local[0],
            local[1],
            local[2],
            local[3],
            local[4],
            local[5],
          ];
          mapStrokeLocals.set(id, own);
          return own;
        },
      };
  const spreadDxByNode = new Map<string, number>();
  const spreadFieldModeByNode = new Map<string, number>();
  const spreadAudit: SpreadAudit | null = options.spreadAuditEnabled
    ? createSpreadAudit()
    : null;
  let spreadFactor = 1;
  // This is deliberately the map the CURRENT build is walking rather than
  // `state()`: runBuild receives its candidate before all consumers publish it.
  let viewScaleNodes: ReadonlyMap<string, MirrorNode> = new Map();
  const active = new Set<string>();
  const sampleTransform = [1, 0, 0, 1, 0, 0];
  const sampleAlphas = [1, 1];
  const streamedGlobal = [1, 0, 0, 1, 0, 0];
  const idleGlobal = [1, 0, 0, 1, 0, 0];
  const parentGlobalScratch: number[] = [1, 0, 0, 1, 0, 0];
  const globalChainScratch: MirrorNode[] = [];
  const tipOwnerScratch: number[] = [1, 0, 0, 1, 0, 0];
  const landingScratch: number[] = [0, 0, 0, 0, 0, 0];
  const idleSample = createIdleAnimSample();
  let frameSampleMask: SampleMask = SAMPLE_NONE;
  let idleActive = 0;
  let lastIdleFrameAt = 0;
  let idleFrames = 0;
  let idleRebuilds = 0;
  let idleInvisible = 0;
  let intentSwaps = 0;
  let reparentDrops = 0;
  let hintTransformRebased = 0;
  let idleStageNotBefore = 0;
  let idleStageAdmittedPassive = 0;
  let idleStageSkippedEarly = 0;
  let idleStageMissingPassive = 0;
  let idleStageAdmittedEarlySlack = 0;
  let idleStagePhaseResets = 0;
  let idleStageLastAdmittedAt = Number.NaN;
  let idleStageMinAdmittedGap = Number.POSITIVE_INFINITY;
  const idleStageAdmittedGaps: number[] = [];

  const modAlpha = (node: MirrorNode): number =>
    node.modulate?.a ?? node.opacity;
  const selfAlpha = (node: MirrorNode): number => node.selfModulate?.a ?? 1;
  const elementAlpha = (node: MirrorNode, interior: boolean): number =>
    modAlpha(node) * (interior ? 1 : selfAlpha(node));

  // The next build reads both owner/follower answers from the last published
  // frame. That one-frame registry is intentional: a candidate walk cannot
  // resolve an owner it has not reached yet.
  const spreadRegistry: SpreadRegistry = {
    ownerDx(ownerId, fallbackDx) {
      const resolved = resolveVisualOwner(ownerId);
      const dx = spreadDxByNode.get(resolved);
      return dx === undefined ? fallbackDx : dx;
    },
    followerShift(gx, gy) {
      let dx = fieldDxAtOriginX(gx, spreadFactor);
      for (const entry of ports.hitEntries()) {
        if (!entry.mouseVisible || !entry.paints) continue;
        if (pointInPlacedRect(entry.mGame, entry.localRect, gx, gy)) {
          dx = entry.spreadDx;
        }
      }
      return dx;
    },
  };

  // The build candidate reaches this map before the state is published. Keep
  // it separate from state() so the shared view-scale policy never resolves a
  // scene identity against the preceding wire map.
  const viewScaleEnv: ViewScaleEnv = viewScaleSharedEnv((id) =>
    resolveSceneInfo(id, viewScaleNodes),
  );

  const tipScaleEnv: CanvasTipScaleEnv = {
    enabled: () => tipScaleOn(),
    hitTestAt: (x, y, exclude) => {
      let hit: string | null = null;
      for (const entry of ports.hitEntries()) {
        if (
          entry.nodeId !== exclude &&
          entry.mouseVisible &&
          entry.paints &&
          pointInPlacedRect(entry.mFinal, entry.localRect, x, y)
        ) {
          hit = entry.nodeId;
        }
      }
      return hit;
    },
    ownerBoxOf: (ownerId) => {
      const node = ports.nodeOf(ownerId);
      if (
        !node ||
        node.localRect == null ||
        !streamedGlobalInto(ports.state(), ownerId, tipOwnerScratch)
      ) {
        return null;
      }
      const dx = spreadDxByNode.get(ownerId) ?? 0;
      if (dx !== 0) tipOwnerScratch[4] += dx;
      return designAabbOf(tipOwnerScratch, node.localRect);
    },
  };

  const landingLog = createLandingLog();
  const landingProbe: LandingProbe = {
    drawnGlobal: (id) => ports.capturedGlobal(id)?.drawn ?? null,
    raiseDy: (id) => ports.cosmeticOffsetDy(id),
    channelLive: (id) => loop.ownsTransform(id),
    streamedTransform: (id) => ports.state()?.nodes.get(id)?.transform ?? null,
    streamedGlobal: (id) => {
      const state = ports.state();
      if (state === null || !streamedGlobalInto(state, id, landingScratch)) {
        return null;
      }
      return [
        landingScratch[0],
        landingScratch[1],
        landingScratch[2],
        landingScratch[3],
        landingScratch[4],
        landingScratch[5],
      ];
    },
  };

  function resolveVisualOwner(ownerId: string): string {
    const owner = ports.nodeOf(ownerId);
    if (!owner) return ownerId;
    if (owner.localRect != null && owner.localRect.width > 0) return ownerId;
    const order = ports.paintOrder();
    if (order === null) return ownerId;
    const stack = [...order.childrenOf(ownerId)].reverse();
    while (stack.length > 0) {
      const id = stack.pop()!;
      const node = ports.nodeOf(id);
      if (!node) continue;
      if (node.visible && node.localRect != null && node.localRect.width > 0) {
        return id;
      }
      const children = order.childrenOf(id);
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
    return ownerId;
  }

  /** Compose a global pose; `withOverrides` is the only rendered-vs-streamed distinction. */
  function composeGlobalInto(
    next: MirrorState | null,
    id: string,
    withOverrides: boolean,
    out: number[],
  ): boolean {
    if (!next) return false;
    const nodes = next.nodes;
    const start = nodes.get(id);
    if (!start) return false;
    const chain = globalChainScratch;
    chain.length = 0;
    let cur: MirrorNode | undefined = start;
    let guard = 0;
    while (cur && guard++ < 256) {
      chain.push(cur);
      if (
        withOverrides && transformOverrides.has(cur.id)
      ) {
        break;
      }
      cur = cur.parentId != null ? nodes.get(cur.parentId) : undefined;
    }
    let a = 1;
    let b = 0;
    let c = 0;
    let d = 1;
    let e = 0;
    let f = 0;
    for (let i = chain.length - 1; i >= 0; i--) {
      const node = chain[i];
      const override = withOverrides ? transformOverrides.get(node.id) : undefined;
      const transform = override ?? node.transform;
      if (!transform || transform.length !== 6) continue;
      if (override !== undefined) {
        a = transform[0];
        b = transform[1];
        c = transform[2];
        d = transform[3];
        e = transform[4];
        f = transform[5];
        continue;
      }
      const na = a * transform[0] + c * transform[1];
      const nb = b * transform[0] + d * transform[1];
      const nc = a * transform[2] + c * transform[3];
      const nd = b * transform[2] + d * transform[3];
      const ne = a * transform[4] + c * transform[5] + e;
      const nf = b * transform[4] + d * transform[5] + f;
      a = na;
      b = nb;
      c = nc;
      d = nd;
      e = ne;
      f = nf;
    }
    out[0] = a;
    out[1] = b;
    out[2] = c;
    out[3] = d;
    out[4] = e;
    out[5] = f;
    return true;
  }

  function renderedGlobalInto(
    next: MirrorState | null,
    id: string,
    out: number[],
  ): boolean {
    return composeGlobalInto(next, id, true, out);
  }

  function streamedGlobalInto(
    next: MirrorState | null,
    id: string,
    out: number[],
  ): boolean {
    return composeGlobalInto(next, id, false, out);
  }

  function capturedOrWalkGlobal(next: MirrorState, id: string): Affine | null {
    return streamedGlobalInto(next, id, parentGlobalScratch)
      ? (parentGlobalScratch as Affine)
      : null;
  }

  function liftEndpoint(
    next: MirrorState,
    node: MirrorNode,
    endpoint: readonly number[] | null | undefined,
  ): readonly number[] | null {
    if (!endpoint || endpoint.length !== 6) return null;
    const parentGlobal =
      node.parentId != null ? capturedOrWalkGlobal(next, node.parentId) : null;
    if (!parentGlobal) return endpoint;
    const a = parentGlobal[0];
    const b = parentGlobal[1];
    const c = parentGlobal[2];
    const d = parentGlobal[3];
    const e = parentGlobal[4];
    const f = parentGlobal[5];
    const a2 = endpoint[0];
    const b2 = endpoint[1];
    const c2 = endpoint[2];
    const d2 = endpoint[3];
    const e2 = endpoint[4];
    const f2 = endpoint[5];
    return [
      a * a2 + c * b2,
      b * a2 + d * b2,
      a * c2 + c * d2,
      b * c2 + d * d2,
      a * e2 + c * f2 + e,
      b * e2 + d * f2 + f,
    ];
  }

  function bankAppliedAlphas(): void {
    for (const [id, override] of alphaOverrides) {
      const previous = alphaApplied.get(id);
      if (previous === undefined) {
        alphaApplied.set(id, { mod: override.mod, self: override.self });
      } else {
        previous.mod = override.mod;
        previous.self = override.self;
      }
    }
    if (alphaApplied.size !== alphaOverrides.size) {
      for (const id of alphaApplied.keys()) {
        if (!alphaOverrides.has(id)) alphaApplied.delete(id);
      }
    }
  }

  function flushLandingArms(next: MirrorState): void {
    for (const pending of landingArms.splice(0)) {
      const node = next.nodes.get(pending.nodeId);
      if (!node) continue;
      const mode = spreadFieldModeByNode.get(pending.nodeId) ?? -1;
      const walkedDx = spreadDxByNode.get(pending.nodeId) ?? 0;
      const dx =
        spreadFactor !== 1 && mode >= 0
          ? fieldDxAtGlobal(
              mode,
              walkedDx,
              pending.end,
              node,
              spreadDrawBox(node),
              spreadFactor,
            )
          : walkedDx;
      landingLog.noteArm({
        id: pending.nodeId,
        name: node.name,
        atMs: pending.atMs,
        endpointGame: [
          pending.end[0],
          pending.end[1],
          pending.end[2],
          pending.end[3],
          pending.end[4],
          pending.end[5],
        ],
        endpointDrawn: [
          pending.end[0],
          pending.end[1],
          pending.end[2],
          pending.end[3],
          pending.end[4] + dx,
          pending.end[5],
        ],
        spreadDxApplied: dx,
        fieldMode: mode,
        durationMs: pending.durationMs,
        parentId: node.parentId ?? null,
        streamedAtArm: node.transform,
      });
    }
  }

  function settleLanding(at: number): void {
    landingLog.tick(at, landingProbe);
  }

  function landingLogReport(): LandingLogReport {
    settleLanding(options.now());
    return {
      stage: "canvas",
      spreadFactor,
      openCount: landingLog.openCount(),
      rows: landingLog.rows(),
    };
  }

  const loop = createTweenLoop({
    clockOriginMs: options.clockOriginMs,
    loopDeadline: "caller",
    currentTransform: (id, out) => renderedGlobalInto(ports.state(), id, out),
    currentOpacity: (id, channel) => {
      const node = ports.nodeOf(id);
      return node === undefined
        ? null
        : channel === "selfOpacity"
          ? selfAlpha(node)
          : elementAlpha(node, ports.hasChildren(id));
    },
    canDriveTrailRoot: (id) => ports.nodeOf(id)?.transform?.length === 6,
  });

  function dropNode(id: string, at: number): void {
    loop.releaseNode(id);
    transformOverrides.delete(id);
    alphaOverrides.delete(id);
    localAnims.delete(id);
    if (idleEntries.delete(id)) loop.applyPinnedLoop(id, null, at);
    intentEntries.delete(id);
    frameSubstitutes.delete(id);
    transformParents.delete(id);
    active.delete(id);
    ports.onNodeRemoved(id);
    mapStrokeLocals.delete(id);
    landingLog.noteGone(id);
  }

  function refreshIdle(
    id: string,
    node: MirrorNode | undefined,
    next: MirrorState,
    at: number,
  ): void {
    const existing = idleEntries.get(id);
    const candidate =
      node !== undefined &&
      ((node.pinnedLoopAnim ?? "") !== "" ||
        IDLE_CANDIDATE_NAMES.has(node.name));
    if (!candidate || node === undefined) {
      if (existing !== undefined) dropIdle(id, at);
      return;
    }
    if (existing?.node === node) return;
    const box = placementBox(node);
    const scenePath =
      node.pinnedLoopAnim == null
        ? resolveSceneInfo(id, next.nodes)?.relPath ?? null
        : null;
    const resolved =
      box === null
        ? null
        : resolveIdleAnim(node, scenePath, box);
    if (resolved === null) {
      if (existing !== undefined) dropIdle(id, at);
      return;
    }
    const phaseMsOverride =
      resolved.plan.kind === "bob" &&
      streamedGlobalInto(next, id, idleGlobal)
        ? bobPhaseMs(resolved.binding.durationMs ?? 0, idleGlobal[4])
        : undefined;
    const spec = loopSpecFromBinding(resolved.binding, {
      visible: true,
      anchor: resolved.anchor,
      phaseMsOverride,
    });
    if (spec === null) return;
    if (existing === undefined) {
      idleEntries.set(id, {
        node,
        plan: resolved.plan,
        pre: null,
        post: null,
        preBuf: [1, 0, 0, 1, 0, 0],
        postBuf: [1, 0, 0, 1, 0, 0],
      });
    } else {
      existing.node = node;
      existing.plan = resolved.plan;
    }
    loop.applyPinnedLoop(id, spec, at);
  }

  function dropIdle(id: string, at: number): void {
    idleEntries.delete(id);
    localAnims.delete(id);
    loop.applyPinnedLoop(id, null, at);
  }

  function refreshIntent(
    id: string,
    node: MirrorNode | undefined,
    at: number,
  ): void {
    const spec = node?.intentFrames;
    if (
      node === undefined ||
      spec === null ||
      spec === undefined ||
      spec.frames.length <= 1 ||
      !(spec.fps > 0)
    ) {
      intentEntries.delete(id);
      frameSubstitutes.delete(id);
      return;
    }
    const prior = intentEntries.get(id);
    if (
      prior !== undefined &&
      prior.spec.animationName === spec.animationName
    ) {
      prior.node = node;
      prior.spec = spec;
      return;
    }
    intentEntries.set(id, { node, spec, startMs: at, shownFrame: -1 });
    frameSubstitutes.delete(id);
  }

  function tickIntents(at: number): void {
    for (const [id, entry] of intentEntries) {
      const index = intentFrameIndex(
        at - entry.startMs,
        entry.spec.fps,
        entry.spec.frames.length,
      );
      if (index === entry.shownFrame) continue;
      entry.shownFrame = index;
      intentSwaps++;
      const frame = entry.spec.frames[index];
      if (index === 0 || frame === undefined || !frame.url) {
        frameSubstitutes.delete(id);
      } else {
        frameSubstitutes.set(id, {
          ...entry.node,
          textureUrl: frame.url,
          textureRegion: frame.region,
          textureMargin: frame.margin,
        });
      }
      frameSampleMask |= SAMPLE_SOURCE;
      sourceSampledIds.add(id);
    }
  }

  function sweepTweens(at: number): void {
    active.clear();
    frameSampleMask = SAMPLE_NONE;
    opacitySampledIds.clear();
    sourceSampledIds.clear();
    for (const id of loop.activeIds()) {
      active.add(id);
      const mask = loop.sampleInto(id, sampleTransform, sampleAlphas, at);
      if (mask === SAMPLE_NONE) continue;
      frameSampleMask |= mask;
      if ((mask & SAMPLE_TRANSFORM) !== 0) {
        const previous = transformOverrides.get(id);
        if (previous === undefined)
          transformOverrides.set(id, sampleTransform.slice());
        else for (let i = 0; i < 6; i++) previous[i] = sampleTransform[i];
      }
      if ((mask & (SAMPLE_OPACITY | SAMPLE_SELF_OPACITY)) !== 0) {
        const override = alphaOverrides.get(id) ?? { mod: null, self: null };
        if ((mask & SAMPLE_OPACITY) !== 0) {
          override.mod = sampleAlphas[ALPHA_OPACITY];
          if (!ports.hasChildren(id)) override.self = 1;
        }
        if ((mask & SAMPLE_SELF_OPACITY) !== 0)
          override.self = sampleAlphas[ALPHA_SELF_OPACITY];
        alphaOverrides.set(id, override);
        opacitySampledIds.add(id);
      }
    }
  }

  function sweepIdle(at: number): void {
    localAnims.clear();
    let count = 0;
    const state = ports.state();
    for (const [id, entry] of idleEntries) {
      const node = state?.nodes.get(id);
      if (node === undefined || entry.plan === null) continue;
      if (!ports.effectivelyVisible(node)) {
        idleInvisible++;
        continue;
      }
      const phase = loop.loopPhase(id, at);
      if (phase < 0) continue;
      sampleIdleAnim(entry.plan, phase, idleSample);
      entry.pre = null;
      entry.post = null;
      if (idleSample.hasPre) {
        entry.preBuf[4] = idleSample.preX;
        entry.preBuf[5] = idleSample.preY;
        entry.pre = entry.preBuf;
      }
      if (idleSample.hasPost) {
        for (let i = 0; i < 6; i++) entry.postBuf[i] = idleSample.post[i];
        entry.post = entry.postBuf;
      }
      if (entry.pre !== null || entry.post !== null) {
        localAnims.set(id, entry);
        frameSampleMask |= SAMPLE_LOCAL_ANIM;
      }
      if (idleSample.alpha !== 1) {
        const override = alphaOverrides.get(id) ?? { mod: null, self: null };
        const base =
          opacitySampledIds.has(id) && override.self !== null
            ? override.self
            : (node.selfModulate?.a ?? 1);
        override.self = base * idleSample.alpha;
        alphaOverrides.set(id, override);
        opacitySampledIds.add(id);
        frameSampleMask |= SAMPLE_SELF_OPACITY;
      }
      count++;
    }
    idleActive = count;
    if (count > 0) {
      idleFrames++;
      options.noteIdlePeriod(at);
      if (localAnims.size > 0) idleRebuilds++;
      lastIdleFrameAt = at;
    }
  }

  function applyInputs(next: MirrorState, at: number): void {
    if (next.sceneRewrite) {
      loop.clearHideLatches();
      transformOverrides.clear();
      alphaOverrides.clear();
      active.clear();
      transformParents.clear();
      for (const id of idleEntries.keys()) loop.applyPinnedLoop(id, null, at);
      idleEntries.clear();
      localAnims.clear();
      intentEntries.clear();
      frameSubstitutes.clear();
      idleActive = 0;
      ports.onRewrite();
      landingLog.clear();
    }
    for (const id of next.changedIds) {
      const node = next.nodes.get(id);
      if (node === undefined) {
        dropNode(id, at);
        continue;
      }
      const parentAtArm = transformParents.get(id);
      if (parentAtArm !== undefined && parentAtArm !== node.parentId) {
        transformParents.delete(id);
        if (loop.releaseTransform(id)) {
          transformOverrides.delete(id);
          reparentDrops++;
        }
      }
      if (node.transform?.length === 6) {
        if (
          active.has(id) &&
          streamedGlobalInto(next, id, streamedGlobal)
        )
          loop.noteStreamedValue(id, "transform", streamedGlobal, at);
        if (!loop.ownsTransform(id)) transformOverrides.delete(id);
      }
      ports.onNodePresent(node);
      const interior = ports.hasChildren(id);
      const painted = loop.noteStreamedValue(
        id,
        "opacity",
        elementAlpha(node, interior),
        at,
      );
      const selfPainted = interior
        ? loop.noteStreamedValue(id, "selfOpacity", selfAlpha(node), at)
        : null;
      if (!active.has(id)) {
        const clampElement = painted !== elementAlpha(node, interior);
        const clampSelf =
          selfPainted !== null && selfPainted !== selfAlpha(node);
        if (!clampElement && !clampSelf) alphaOverrides.delete(id);
        else {
          const override = alphaOverrides.get(id) ?? { mod: null, self: null };
          if (clampElement) {
            override.mod = painted;
            if (!interior) override.self = 1;
          }
          if (clampSelf) override.self = selfPainted;
          alphaOverrides.set(id, override);
        }
      }
    }
    if (next.pendingHints.length > 0) {
      const planned = planTweenHints(next.pendingHints, (hint) =>
        targetFacts(next, hint),
      );
      loop.applyHints(planned, at);
      for (const hint of planned) {
        if (hint.channel === "transform" && hint.endTransform !== null) {
          transformParents.set(
            hint.nodeId,
            next.nodes.get(hint.nodeId)?.parentId ?? null,
          );
          if (ports.isLandingTarget(hint.nodeId))
            landingArms.push({
              nodeId: hint.nodeId,
              end: hint.endTransform,
              durationMs: hint.durationMs,
              atMs: at,
            });
        }
      }
      next.pendingHints.length = 0;
    }
    if (next.pendingCardFlights.length > 0) {
      ports.onFlights(next.pendingCardFlights, at);
      loop.applyFlights(next.pendingCardFlights, at);
      next.pendingCardFlights.length = 0;
    }
    for (const id of next.changedIds) {
      const node = next.nodes.get(id);
      refreshIdle(id, node, next, at);
      refreshIntent(id, node, at);
    }
  }

  function targetFacts(
    next: MirrorState,
    hint: Parameters<typeof planTweenHints>[0][number],
  ): TweenTargetFacts | null {
    const node = next.nodes.get(hint.targetId);
    if (node === undefined) {
      return null;
    }
    if (node.parentId !== null && !next.nodes.has(node.parentId)) {
      if (hint.endTransform) hintTransformRebased++;
      return null;
    }
    const rebased = hint.parentIdAtArrival !== undefined && hint.parentIdAtArrival !== node.parentId;
    if (rebased && hint.endTransform) hintTransformRebased++;
    return {
      hasChildren: ports.hasChildren(hint.targetId),
      modAlpha: modAlpha(node),
      selfAlpha: selfAlpha(node),
      endTransformGlobal: rebased
        ? null
        : liftEndpoint(next, node, hint.endTransform),
      startTransformGlobal: rebased
        ? null
        : liftEndpoint(next, node, hint.startTransform),
    };
  }

  function intentDeadline(at: number): number {
    let next = Number.POSITIVE_INFINITY;
    for (const entry of intentEntries.values()) {
      const frameMs = 1000 / entry.spec.fps;
      let deadline =
        entry.startMs +
        (Math.floor(Math.max(0, at - entry.startMs) / frameMs) + 1) * frameMs;
      if (deadline <= at) deadline += frameMs;
      next = Math.min(next, deadline);
    }
    return next;
  }

  return {
    loop,
    transformOverrides,
    alphaOverrides,
    alphaApplied,
    localAnims,
    frameSubstitutes,
    opacitySampledIds,
    sourceSampledIds,
    landingArms,
    mapStrokeLocals,
    get mapStrokePinReuses() {
      return mapStrokePinReuses;
    },
    spreadDxByNode,
    spreadFieldModeByNode,
    spreadRegistry,
    spreadAudit,
    get spreadFactor() {
      return spreadFactor;
    },
    viewScaleEnv,
    tipScaleEnv,
    pinnedLocals,
    get frameSampleMask() {
      return frameSampleMask;
    },
    get activeAnimIds() {
      return active;
    },
    prepareBuild(next) {
      viewScaleNodes = next.nodes;
    },
    setStretch(factor) {
      if (factor === spreadFactor) return false;
      spreadFactor = factor;
      spreadDxByNode.clear();
      return true;
    },
    renderedGlobalInto,
    streamedGlobalInto,
    liftEndpoint,
    applyInputs,
    sample(at) {
      sweepTweens(at);
      sweepIdle(at);
      tickIntents(at);
    },
    advance(at) {
      loop.advance(at);
    },
    idleDeadline(at, fps, phaseDeadline) {
      return Math.min(
        idleActive === 0
          ? Number.POSITIVE_INFINITY
          : fps >= 60 && phaseDeadline > 0
            ? phaseDeadline
            : lastIdleFrameAt + 1000 / fps,
        intentDeadline(at),
      );
    },
    consumeLandingArms() {
      return landingArms.splice(0);
    },
    bankAppliedAlphas,
    flushLandingArms,
    settleLanding,
    landingLogReport,
    spreadAuditReport() {
      return spreadAudit === null ? undefined : spreadAuditReport(spreadAudit);
    },
    intentNode(id) {
      return intentEntries.get(id)?.node;
    },
    get idleStageNotBefore() {
      return idleStageNotBefore;
    },
    noteIdleStageAdmission(at, minFrameMs) {
      if (idleStageNotBefore > 0 && at < idleStageNotBefore)
        idleStageAdmittedEarlySlack++;
      if (Number.isFinite(idleStageLastAdmittedAt)) {
        idleStageMinAdmittedGap = Math.min(
          idleStageMinAdmittedGap,
          Math.max(0, at - idleStageLastAdmittedAt),
        );
        if (idleStageAdmittedGaps.length >= 120) idleStageAdmittedGaps.shift();
        idleStageAdmittedGaps.push(Math.max(0, at - idleStageLastAdmittedAt));
      }
      idleStageLastAdmittedAt = at;
      idleStageAdmittedPassive++;
      const nextPhase = idleStageNotBefore + minFrameMs;
      if (idleStageNotBefore > 0 && at < nextPhase)
        idleStageNotBefore = nextPhase;
      else {
        if (idleStageNotBefore > 0) idleStagePhaseResets++;
        idleStageNotBefore = at + minFrameMs;
      }
    },
    noteIdleStageSkippedEarly() {
      idleStageSkippedEarly++;
    },
    noteIdleStageMissingPassive() {
      idleStageMissingPassive++;
    },
    idleLoopCount(channel) {
      let count = 0;
      for (const entry of idleEntries.values()) {
        const kind = entry.plan?.channel;
        if (
          kind !== undefined &&
          (channel === "transform"
            ? kind !== "alpha"
            : kind !== "pre" && kind !== "post")
        )
          count++;
      }
      return count;
    },
    stats() {
      return {
        idleActive,
        idleFrames,
        idleRebuilds,
        idleInvisible,
        idlePlans: idleEntries.size,
        intentCycles: intentEntries.size,
        intentSwaps,
        reparentDrops,
        hintTransformRebased,
        idleStageAdmittedPassive,
        idleStageSkippedEarly,
        idleStageMissingPassive,
        idleStageAdmittedEarlySlack,
        idleStagePhaseResets,
        idleStageMinAdmittedGap,
        idleStageAdmittedGaps,
      };
    },
  };
}
