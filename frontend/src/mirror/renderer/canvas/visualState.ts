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
import { affineMulInto, IDENTITY_AFFINE, type Affine } from "@/mirror/affine";
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
import { matrix6Equal } from "@/mirror/canvas/matrixLerp";
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

/**
 * How close a settled tween pose must be to the node's composed wire pose for its override to be released
 * (`settlesAtComposedPose`): the two are built by different multiplications of the same matrices, so they may
 * differ in the last bits, and a thousandth of a design pixel is far below anything a frame can show.
 */
const SETTLE_BASIS_EPS = 1e-6;
const SETTLE_TRANSLATION_EPS_PX = 1e-3;

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
  /**
   * A transform ease is about to be armed on this node, and the loop does not already own its transform — so the
   * stage is still drawing the pose the ease will start from. The readable-hand lift is the other half of that
   * drawn position and has to leave the value conjugate to it: see `interactionRuntime.noteTransformArmPose`,
   * which is the only moment the shared pose read still answers where the card IS rather than where it is HEADED.
   */
  onTransformArm(id: string, at: number): void;
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

export interface LandingPresentation {
  publish(): void;
}

/** Open sampled changes by serial (`retainSourceSwaps`). */
export interface SampleMark {
  readonly sources: ReadonlyMap<string, number>;
  readonly opacity: ReadonlyMap<string, number>;
}

export interface CanvasVisualState {
  readonly loop: TweenLoop;
  readonly transformOverrides: Map<string, number[]>;
  readonly alphaOverrides: Map<string, AlphaOverride>;
  /** Values that were actually baked into the current draw list. */
  readonly alphaApplied: Map<string, AlphaOverride>;
  readonly localAnims: ReadonlyMap<string, LocalAnim>;
  readonly frameSubstitutes: ReadonlyMap<string, MirrorNode>;
  /** This sample's opacity changes (idle sampling reads it as "set this sample"). */
  readonly opacitySampledIds: ReadonlySet<string>;
  /**
   * The opacity changes a patch must draw: `opacitySampledIds` normally. With `retainSourceSwaps`, every change since
   * a committed frame last drew it (see `sourceSampledIds`).
   */
  readonly opacityPatchIds: ReadonlySet<string>;
  /**
   * Intent-frame swaps to draw. Normally this sample's swaps only. With `retainSourceSwaps` a swap stays here until
   * `settleSources` says a committed frame drew it: a frame that samples a swap and draws nothing (a yielding tick,
   * a patch that never presents) must not consume it.
   */
  readonly sourceSampledIds: ReadonlySet<string>;
  /** `retainSourceSwaps`: the open swaps and opacity changes by serial, captured when a frame starts drawing. */
  sampleMark(): SampleMark | null;
  /** `retainSourceSwaps`: a frame drawn from `mark` committed; what it drew is closed unless it changed again since. */
  settleSamples(mark: SampleMark | null): void;
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
  idleDeadline(at: number): number;
  /**
   * True when an idle-only tick would resample the exact instant the last one already handled. `pinned`
   * MUST be false for the caller's own real clock — a real `performance.now()` can be coarsened by the
   * browser (resistFingerprinting clamps) and repeat across two genuinely distinct display frames, where
   * treating that as stale would freeze the idle chain (it does not re-arm once stale) until unrelated input
   * woke it. Only a genuinely pinned diagnostic/bench clock makes a repeat mean "nothing changed".
   */
  isIdleSampleStale(at: number, pinned: boolean): boolean;
  /** Record that an idle-only tick at `at` genuinely attempted its contribution, never a mere sample, a yield
   *  or a carry. See the implementation for why this is NOT gated on the attempt's own success. */
  commitIdleSample(at: number): void;
  consumeLandingArms(): LandingArm[];
  /** Bank alpha overrides after a full build, never after an in-place patch. */
  bankAppliedAlphas(): void;
  /** Price pending hand-card endpoints only after the current build banked its field claims. */
  flushLandingArms(next: MirrorState): void;
  /** Score arms against the published painted frame. */
  settleLanding(at: number): void;
  /** Freeze one candidate's landing evidence before asynchronous presentation. */
  captureLandingPresentation(next: MirrorState, at: number,
    captured: ReadonlyMap<string, CapturedGlobal>, lifts: ReadonlyMap<string, { dy: number }>): LandingPresentation;
  collectLandingCaptureIds(out: Set<string>): void;
  readonly landingGeneration: number;
  hasOpenLanding(): boolean;
  /** Read also settles due rows, preserving the diagnostics seam's contract. */
  landingLogReport(): LandingLogReport;
  /** Read without ticking; asynchronous renderers settle only on publication. */
  passiveLandingLogReport(): LandingLogReport;
  /** A diagnostic-only report; undefined when the audit was never armed. */
  spreadAuditReport(): ReturnType<typeof spreadAuditReport> | undefined;
  intentNode(id: string): MirrorNode | undefined;
  /** How often an idle-only frame is actually admitted — a diagnostic, not a gate. */
  noteIdleStageAdmission(at: number): void;
  noteIdleStageMissingPassive(): void;
  idleLoopCount(channel: "transform" | "alpha"): number;
  /**
   * `rustIdleInRust`: bumped whenever the idle set or any idle loop's plan or timing may have changed (an entry
   * created, re-resolved or dropped, or the whole set cleared). Equal generations mean every `idlePlan` and loop
   * timing an installed descriptor read is still current.
   */
  readonly idleGeneration: number;
  /** `rustIdleInRust`: the plan `sweepIdle` samples for `id`, or null. */
  idlePlan(id: string): IdleAnimPlan | null;
  stats(): {
    idleActive: number;
    idleFrames: number;
    idleRebuilds: number;
    idleInvisible: number;
    idlePlans: number;
    intentCycles: number;
    intentSwaps: number;
    reparentDrops: number;
    /** Settled tweens whose override was released because the node already composes to the settled pose. */
    settledOverrideReleases: number;
    hintTransformRebased: number;
    idleStageAdmittedPassive: number;
    idleStageMissingPassive: number;
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
    /** Keep intent-frame swaps in `sourceSampledIds` until a committed frame drew them (see there). */
    retainSourceSwaps?: boolean;
  },
): CanvasVisualState {
  const transformOverrides = new Map<string, number[]>();
  const alphaOverrides = new Map<string, AlphaOverride>();
  const alphaApplied = new Map<string, AlphaOverride>();
  const localAnims = new Map<string, IdleEntry>();
  const opacitySampledIds = new Set<string>();
  const sourceSampledIds = new Set<string>();
  const retainSourceSwaps = options.retainSourceSwaps === true;
  /** `retainSourceSwaps`: each open swap's serial, so a settle never clears a swap made after its mark. */
  const sourceSwapSerials = new Map<string, number>();
  let sourceSwapSerial = 0;
  /** `retainSourceSwaps`: opacity changes no committed frame has drawn yet, by serial. */
  const opacityPending = new Set<string>();
  const opacitySerials = new Map<string, number>();
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
  // A renderer can be mounted over a retained scene whose wire-delta markers
  // were consumed by the previous view. Seed local loop/source registrations
  // from the whole scene once; later calls remain proportional to changedIds.
  let inputsSeeded = false;
  const sampleTransform = [1, 0, 0, 1, 0, 0];
  const sampleAlphas = [1, 1];
  const streamedGlobal = [1, 0, 0, 1, 0, 0];
  const idleGlobal = [1, 0, 0, 1, 0, 0];
  const parentGlobalScratch: number[] = [1, 0, 0, 1, 0, 0];
  const globalChainScratch: MirrorNode[] = [];
  const tipOwnerScratch: number[] = [1, 0, 0, 1, 0, 0];
  const landingScratch: number[] = [0, 0, 0, 0, 0, 0];
  const settleScratch: number[] = [1, 0, 0, 1, 0, 0];
  const settleComposed: Affine = [1, 0, 0, 1, 0, 0];
  let settledOverrideReleases = 0;
  const idleSample = createIdleAnimSample();
  let frameSampleMask: SampleMask = SAMPLE_NONE;
  let idleActive = 0;
  // NaN, not 0: a fake/replay clock can legitimately start at 0, and NaN is the only value nothing can equal,
  // so the very first idle sample at `at === 0` is never mistaken for "nothing changed since last time".
  let lastIdleFrameAt = Number.NaN;
  let idleFrames = 0;
  let idleRebuilds = 0;
  let idleInvisible = 0;
  let intentSwaps = 0;
  let reparentDrops = 0;
  let hintTransformRebased = 0;
  let idleStageAdmittedPassive = 0;
  let idleStageMissingPassive = 0;
  let idleStageLastAdmittedAt = Number.NaN;
  let idleStageMinAdmittedGap = Number.POSITIVE_INFINITY;
  let idleGeneration = 0;
  /** Ring buffer: avoids an O(n) `shift()` now that admission runs every display frame, not every ~33 ms. */
  const IDLE_STAGE_ADMITTED_GAP_WINDOW = 120;
  const idleStageAdmittedGaps: number[] = [];
  let idleStageAdmittedGapCursor = 0;

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
  const noLandingPublication: LandingPresentation = { publish() {} };
  let landingGeneration = 0;
  let lastRewriteRevision = -1;
  let lastRewriteOrder: readonly string[] | null = null;
  // Re-emits are detected by reference identity; a token preserves that identity
  // without leaving a mutable producer transform inside an async candidate.
  const streamedPoseTokens = new WeakMap<object, object>();
  const streamedPoseToken = (pose: unknown): unknown => {
    if (pose === null || typeof pose !== "object") return pose;
    let token = streamedPoseTokens.get(pose);
    if (!token) { token = {}; streamedPoseTokens.set(pose, token); }
    return token;
  };
  const landingProbe: LandingProbe = {
    drawnGlobal: (id) => ports.capturedGlobal(id)?.drawn ?? null,
    raiseDy: (id) => ports.cosmeticOffsetDy(id),
    channelLive: (id) => loop.ownsTransform(id),
    streamedTransform: (id) => streamedPoseToken(ports.state()?.nodes.get(id)?.transform ?? null),
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

  function priceLandingArms(next: MirrorState, pendingArms: readonly LandingArm[]) {
    const priced: Parameters<typeof landingLog.noteArm>[0][] = [];
    for (const pending of pendingArms) {
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
      priced.push({
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
        streamedAtArm: streamedPoseToken(node.transform),
      });
    }
    return priced;
  }

  function flushLandingArms(next: MirrorState): void {
    for (const arm of priceLandingArms(next, landingArms.splice(0))) landingLog.noteArm(arm);
  }

  function captureLandingPresentation(next: MirrorState, at: number,
    captured: ReadonlyMap<string, CapturedGlobal>, lifts: ReadonlyMap<string, { dy: number }>): LandingPresentation {
    if (landingLog.openCount() === 0 && landingArms.length === 0) return noLandingPublication;
    const candidateGeneration = landingGeneration;
    const pending = landingArms.slice();
    const arms = priceLandingArms(next, pending);
    const ids = new Set([...landingLog.openIds(), ...arms.map((arm) => arm.id)]);
    const drawn = new Map<string, Affine | null>();
    const raise = new Map<string, number>();
    const channel = new Map<string, boolean>();
    const streamed = new Map<string, unknown>();
    const game = new Map<string, Affine | null>();
    for (const id of ids) {
      const pose = captured.get(id)?.drawn;
      drawn.set(id, pose ? [...pose] as Affine : null);
      raise.set(id, lifts.get(id)?.dy ?? 0);
      channel.set(id, landingProbe.channelLive(id));
      streamed.set(id, streamedPoseToken(next.nodes.get(id)?.transform ?? null));
      game.set(id, streamedGlobalInto(next, id, landingScratch) ? [...landingScratch] as Affine : null);
    }
    const probe: LandingProbe = {
      drawnGlobal: (id) => drawn.get(id) ?? null,
      raiseDy: (id) => raise.get(id) ?? 0,
      channelLive: (id) => channel.get(id) ?? true,
      streamedTransform: (id) => streamed.get(id) ?? null,
      streamedGlobal: (id) => game.get(id) ?? null,
    };
    const removePending = () => {
      for (const arm of pending) {
        const index = landingArms.indexOf(arm);
        if (index >= 0) landingArms.splice(index, 1);
      }
    };
    return {
      publish() {
        if (landingGeneration !== candidateGeneration) return;
        removePending();
        for (const arm of arms) landingLog.noteArm(arm);
        landingLog.tick(at, probe);
      },
    };
  }

  function settleLanding(at: number): void {
    landingLog.tick(at, landingProbe);
  }

  function landingLogReport(): LandingLogReport {
    settleLanding(options.now());
    return passiveLandingLogReport();
  }

  function passiveLandingLogReport(): LandingLogReport {
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
    if (idleEntries.delete(id)) { idleGeneration++; loop.applyPinnedLoop(id, null, at); }
    intentEntries.delete(id);
    frameSubstitutes.delete(id);
    // A removed node has no swap left to draw (`retainSourceSwaps`); an open one would only force a build.
    if (retainSourceSwaps) { sourceSampledIds.delete(id); sourceSwapSerials.delete(id); opacityPending.delete(id); opacitySerials.delete(id); }
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
    idleGeneration++;
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
    idleGeneration++;
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
      if (retainSourceSwaps) sourceSwapSerials.set(id, ++sourceSwapSerial);
    }
    // Swaps no frame has drawn yet still need drawing.
    if (retainSourceSwaps && sourceSampledIds.size) frameSampleMask |= SAMPLE_SOURCE;
  }

  /**
   * Does a SETTLED transform sample put the node exactly where it composes without one — its streamed local under
   * its parent's rendered global (that parent's own held override included)?
   *
   * Then the override says nothing the wire does not, and holding it is not free: an override marks the node's
   * whole subtree as drawn-moved, so on a widened stage every field claim below it is re-derived from the drawn
   * pose, and an idle loop under it (the end-turn glow under a tweened-in end-turn button) can no longer be
   * re-posed by a retained patch. Nothing would ever release it either: an override is dropped when the node's
   * streamed transform changes, and a tween that settles where the wire already has the node gets no such delta.
   */
  function settlesAtComposedPose(id: string, settled: readonly number[]): boolean {
    const next = ports.state();
    const node = next?.nodes.get(id);
    if (!next || !node) return false;
    const own = node.transform?.length === 6 ? node.transform : null;
    let composed: readonly number[];
    if (node.parentId == null) composed = own ?? IDENTITY_AFFINE;
    else {
      if (!composeGlobalInto(next, node.parentId, true, settleScratch)) return false;
      composed = own === null ? settleScratch : affineMulInto(settleComposed, settleScratch as Affine, own as Affine);
    }
    for (let i = 0; i < 4; i++) if (Math.abs(composed[i] - settled[i]) > SETTLE_BASIS_EPS) return false;
    return Math.abs(composed[4] - settled[4]) <= SETTLE_TRANSLATION_EPS_PX &&
      Math.abs(composed[5] - settled[5]) <= SETTLE_TRANSLATION_EPS_PX;
  }

  function sweepTweens(at: number): void {
    active.clear();
    frameSampleMask = SAMPLE_NONE;
    opacitySampledIds.clear();
    if (!retainSourceSwaps) sourceSampledIds.clear();
    for (const id of loop.activeIds()) {
      active.add(id);
      const mask = loop.sampleInto(id, sampleTransform, sampleAlphas, at);
      if (mask === SAMPLE_NONE) continue;
      frameSampleMask |= mask;
      // The channel has just let go (this sample was its settle) and the node is already where it composes: draw
      // it from the wire from now on rather than holding a copy of the same pose. See `settlesAtComposedPose`.
      if ((mask & SAMPLE_TRANSFORM) !== 0 && !loop.ownsTransform(id) && settlesAtComposedPose(id, sampleTransform)) {
        if (transformOverrides.delete(id)) settledOverrideReleases++;
      } else if ((mask & SAMPLE_TRANSFORM) !== 0) {
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
      // `lastIdleFrameAt` is NOT set here: sampling happens even for a tick that only yields or carries this
      // frame (another build or patch already spent it, or an async submission still has it blocked) without
      // actually attempting idle's own contribution. See `commitIdleSample`, called once that attempt is
      // genuinely made — whether through the scheduler's own admittedTick, or a present made outside it (a
      // synchronous diagnostic-clock present, a wire reconcile) that this same instant must not be redrawn
      // for. A carried frame must keep being retried at the same pinned instant, not be mistaken for an
      // already-handled repeat.
    }
  }

  function applyInputs(next: MirrorState, at: number): void {
    const inputIds = inputsSeeded ? next.changedIds : [...next.nodes.keys()];
    inputsSeeded = true;
    if (next.sceneRewrite) {
      if (lastRewriteRevision !== next.revision || lastRewriteOrder !== next.orderedIds) {
        landingGeneration++;
        lastRewriteRevision = next.revision;
        lastRewriteOrder = next.orderedIds;
        landingArms.length = 0;
        landingLog.clear();
      }
      loop.clearHideLatches();
      transformOverrides.clear();
      alphaOverrides.clear();
      active.clear();
      transformParents.clear();
      for (const id of idleEntries.keys()) loop.applyPinnedLoop(id, null, at);
      idleGeneration++;
      idleEntries.clear();
      localAnims.clear();
      intentEntries.clear();
      frameSubstitutes.clear();
      sourceSampledIds.clear();
      sourceSwapSerials.clear();
      opacityPending.clear();
      opacitySerials.clear();
      idleActive = 0;
      ports.onRewrite();
    }
    for (const id of inputIds) {
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
      // A delayed scene packet can carry several endpoints for one holder after its streamed pose
      // has already moved beyond all of them. None is a useful destination in that case.
      const recentEndpoints = new Map<string, [readonly number[], readonly number[]]>();
      for (const hint of next.pendingHints) {
        const node = next.nodes.get(hint.targetId);
        if (!node || !hint.endTransform || hint.endTransform.length !== 6 ||
            hint.parentIdAtArrival !== node.parentId ||
            !matrix6Equal(hint.transformAtArrival ?? null, node.transform ?? null)) continue;
        const prior = recentEndpoints.get(hint.targetId);
        recentEndpoints.set(hint.targetId, [prior?.[1] ?? hint.endTransform, hint.endTransform]);
      }
      const passedEndpoints = new Set<string>();
      for (const [id, [previous, latest]] of recentEndpoints) {
        if (previous === latest) continue;
        const streamed = next.nodes.get(id)?.transform;
        if (!streamed) continue;
        const travelX = latest[4] - previous[4], travelY = latest[5] - previous[5];
        const length = Math.hypot(travelX, travelY);
        if (length <= 1.5) continue;
        const pastX = streamed[4] - latest[4], pastY = streamed[5] - latest[5];
        const along = (pastX * travelX + pastY * travelY) / length;
        const across = Math.abs(pastX * travelY - pastY * travelX) / length;
        if (along > 1.5 && across <= Math.max(12, along * 0.5)) passedEndpoints.add(id);
      }
      const planned = planTweenHints(next.pendingHints, (hint) =>
        targetFacts(next, hint, passedEndpoints),
      );
      // BEFORE the arm, and only for a node the loop is not already driving: the pose an un-owned node is drawn
      // at is the pose its ease will leave, and it stops being readable the instant the channel exists (see
      // `onTransformArm`). Planned hints rather than wire hints, so a refused or rebased one never reports an arm
      // that does not happen.
      for (const hint of planned) {
        if (hint.channel === "transform" && !loop.ownsTransform(hint.nodeId)) ports.onTransformArm(hint.nodeId, at);
      }
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
    for (const id of inputIds) {
      const node = next.nodes.get(id);
      refreshIdle(id, node, next, at);
      refreshIntent(id, node, at);
    }
  }

  function targetFacts(
    next: MirrorState,
    hint: Parameters<typeof planTweenHints>[0][number],
    passedEndpoints: ReadonlySet<string>,
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
    // A later delta can replace the target pose before one coalesced reconcile drains this hint.
    // Arming its older endpoint after that newer stream would leave a settled canvas override behind.
    const superseded = passedEndpoints.has(hint.targetId) ||
      (hint.transformAtArrival !== undefined &&
        !matrix6Equal(hint.transformAtArrival, node.transform ?? null));
    if (rebased && hint.endTransform) hintTransformRebased++;
    return {
      hasChildren: ports.hasChildren(hint.targetId),
      modAlpha: modAlpha(node),
      selfAlpha: selfAlpha(node),
      endTransformGlobal: rebased || superseded
        ? null
        : liftEndpoint(next, node, hint.endTransform),
      startTransformGlobal: rebased || superseded
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
    opacityPatchIds: retainSourceSwaps ? opacityPending : opacitySampledIds,
    sampleMark: () => retainSourceSwaps ? { sources: new Map(sourceSwapSerials), opacity: new Map(opacitySerials) } : null,
    settleSamples(mark) {
      if (!mark) return;
      for (const [id, serial] of mark.sources) {
        if (sourceSwapSerials.get(id) !== serial) continue;
        sourceSwapSerials.delete(id);
        sourceSampledIds.delete(id);
      }
      for (const [id, serial] of mark.opacity) {
        if (opacitySerials.get(id) !== serial) continue;
        opacitySerials.delete(id);
        opacityPending.delete(id);
      }
    },
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
      if (retainSourceSwaps) for (const id of opacitySampledIds) {
        opacityPending.add(id);
        opacitySerials.set(id, ++sourceSwapSerial);
      }
    },
    advance(at) {
      loop.advance(at);
    },
    // No authored cadence cap: an active idle loop is due every display frame, like DOM's compositor
    // animations. This must always book the next frame while active — a scheduling-level staleness check
    // here would compare a tick's own immediate re-arm against the sample it just took in the same tick,
    // which reads as "unchanged" under any pinned or test-mocked clock and would silently stop the chain
    // for good (nothing left to wake it). `isIdleSampleStale` below instead refuses to re-sample an instant
    // already ACCEPTED, at the point a NEW tick is admitted — never at the point this one re-arms itself —
    // and the scheduler does not even re-arm once it reports stale (see frameScheduler's admission check):
    // the chain goes fully quiet, and `__mirrorSetDiagnosticClock` re-arms explicitly once the clock moves.
    // `intentDeadline` can only ever push the deadline later than "now", so it is skipped whenever the idle
    // branch already answers "due now" — it cannot win that comparison.
    idleDeadline(at) {
      if (idleActive > 0) return at;
      return intentDeadline(at);
    },
    // Read-only: true when an idle-only tick would resample the exact instant the last tick already handled.
    // `pinned` must be false whenever the caller's own clock is the real one: a real `performance.now()` can
    // be coarsened by the browser (Tor/Firefox resistFingerprinting clamp to 16.67-100 ms resolution), so two
    // consecutive display frames reading the identical value is a real event, not just a pinned-clock one —
    // treating it as stale there would freeze the idle chain (it does not re-arm once stale) until unrelated
    // input woke it. Only a genuinely pinned diagnostic/bench clock (the caller's own `deterministicClock`,
    // say) makes `at` repeating a reliable "nothing changed" signal. `lastIdleFrameAt` only moves in
    // `commitIdleSample`, never here on a merely sampled frame, so a frame that only yielded or carried
    // (never actually attempted idle's contribution) keeps retrying at the same pinned instant instead of
    // being mistaken for an already-handled repeat.
    isIdleSampleStale(at, pinned) {
      return pinned && idleActive > 0 && at === lastIdleFrameAt;
    },
    // Called once an idle-only tick genuinely attempts its contribution for `at` (never on a tick that only
    // yielded or carried the frame to a later one) — see `isIdleSampleStale`. Committed before the attempt's
    // own result is known: a decline inside it can be for a reason that has nothing to do with idle (the
    // scene sits on a newer, not-yet-admitted revision, say), and that has its own resource-wake path to
    // retry it — not a per-display-frame idle loop, which would retry it forever under a pinned clock.
    commitIdleSample(at) {
      lastIdleFrameAt = at;
    },
    consumeLandingArms() {
      return landingArms.splice(0);
    },
    bankAppliedAlphas,
    flushLandingArms,
    settleLanding,
    captureLandingPresentation,
    get landingGeneration() { return landingGeneration; },
    collectLandingCaptureIds(out) {
      for (const id of landingLog.openIds()) out.add(id);
      for (const arm of landingArms) out.add(arm.nodeId);
    },
    hasOpenLanding: () => landingLog.openCount() > 0 || landingArms.length > 0,
    landingLogReport,
    passiveLandingLogReport,
    spreadAuditReport() {
      return spreadAudit === null ? undefined : spreadAuditReport(spreadAudit);
    },
    intentNode(id) {
      return intentEntries.get(id)?.node;
    },
    // No authored cadence cap: there is no admission gate left to drive (an idle-only frame is admitted
    // whenever it is booked). This diagnostic-only count of how often that actually happens — and how far
    // apart — still answers "are we really sampling every display frame now". A fixed-size ring avoids an
    // O(n) `shift()` on a buffer this now writes every display frame instead of every ~33 ms.
    noteIdleStageAdmission(at) {
      if (Number.isFinite(idleStageLastAdmittedAt)) {
        const gap = Math.max(0, at - idleStageLastAdmittedAt);
        idleStageMinAdmittedGap = Math.min(idleStageMinAdmittedGap, gap);
        if (idleStageAdmittedGaps.length < IDLE_STAGE_ADMITTED_GAP_WINDOW) {
          idleStageAdmittedGaps.push(gap);
        } else {
          idleStageAdmittedGaps[idleStageAdmittedGapCursor] = gap;
          idleStageAdmittedGapCursor = (idleStageAdmittedGapCursor + 1) % IDLE_STAGE_ADMITTED_GAP_WINDOW;
        }
      }
      idleStageLastAdmittedAt = at;
      idleStageAdmittedPassive++;
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
    get idleGeneration() {
      return idleGeneration;
    },
    idlePlan(id) {
      return idleEntries.get(id)?.plan ?? null;
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
        settledOverrideReleases,
        hintTransformRebased,
        idleStageAdmittedPassive,
        idleStageMissingPassive,
        idleStageMinAdmittedGap,
        idleStageAdmittedGaps,
      };
    },
  };
}
