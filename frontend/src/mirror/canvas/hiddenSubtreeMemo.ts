// HIDDEN-SUBTREE MEMO for the canvas walk (`rustHiddenMemo`, default off).
//
// An invisible or orphaned subtree paints nothing, crops nothing and answers no tap, but `buildDrawList` still
// walks every node in it, because the walk PUBLISHES things for hidden nodes that consumers read:
//
//   * `nodePaintInputs`   — one composed input per node, in the walk's PRE-order (the node before its children,
//                           behind-parent children included). Retained composition and the paint dump read them.
//   * `viewScaleStamps` / `viewScaleCandidates` — a visible descendant of a hidden root can still resolve a stamp
//                           (the input registry drops it later, on its own ancestor test). Also pre-order.
//   * `onNode` / `semanticNode` — one call per node, class `skip`, in PAINT order (behind children first), at an
//                           empty command interval `[list.count, list.count)`.
//   * `stats.skip`        — one per node.
//
// Nothing else leaves a hidden subtree: `classifyNode` answers `skip` for every hidden node, so there are no
// commands, overlay records, ranges or cover boxes; a hidden node opens no clip; `buildHitEntry` refuses a hidden
// node before it touches its memo. The publications that CAN happen under a hidden root are made impossible to
// record rather than replayed — see THE REFUSALS.
//
// THE MEMO. Each outermost hidden root (the first node on its path that is `visible:false` or orphaned) is a key.
// Its walk is recorded once; a later build replays the recording (the same input and stamp objects, in the same
// order) when every value the walk would read is provably the same:
//
//   1. the paint order holds the same ids in the root's span, at the same span start (so every `input.order` is
//      the same), and the order has no duplicate child entries anywhere (`orderIsDuplicateFree`), which is what
//      makes the span ids determine the subtree's child lists;
//   2. every node in the span is the SAME OBJECT the recording saw — `applySceneDelta` replaces a node's object on
//      every upsert and never mutates one after insertion, so identity covers every field;
//   3. every ancestor of the root is the same object (the scene-identity resolves climb through them) and the
//      root's parent is equally present or absent (the orphan test);
//   4. the walk context handed to the root is equal BY VALUE: parent globals, cascaded alpha and tint, inherited
//      cosmetic offset, parent drawn Y, both view-scale products, the card-reward flag, and the two moved flags;
//   5. the per-build environment is the same: node map, view-scale switch and env, tip-scale switch, the clip-axis
//      switch, whether local anims are tracked, and the pinned-local source.
//
// The incoming clip chain is not compared: under a hidden root it reaches only overlay records and hit entries,
// and a hidden node produces neither.
//
// THE TAINT SET. A per-id option (transform/alpha override, local anim, frame substitute, cosmetic offset, capture
// id, skip root, render-width override) can change any node in a subtree without changing a node object, so the
// inclusive ancestors of every such key are TAINTED for the build. A tainted root walks normally and is neither
// replayed nor recorded.
//
// THE REFUSALS. A recording is discarded when its walk latched a map-stroke local (stateful, per stream), entered
// the hover-tip branch (it asks the caller about nodes outside the subtree), banked a local-anim frame or a capture
// (both tainted, refused as a belt), classified a node as anything but `skip`, pushed a command, hit entry or
// overlay record, walked a frame substitute, or visited a different node sequence than the span. The whole memo
// sits out a build that spreads the stage, runs the hidden-walk diagnostic or the spread audit, or whose paint
// order has duplicate child entries.
//
// BOUNDED: an entry not visited in a build is dropped at the end of it. A root whose recording keeps failing (on
// anything but an environment flip) or keeps being refused stops recording for a doubling number of builds, up to
// `MAX_HOLD`; that decides only WHETHER to record, never what a build publishes.
//
// VERIFY (`rustFastVerify`): a validated root is walked anyway, and the walk's own publications are compared with
// the recording. The walked result is what the build uses.

import type { Affine } from "@/mirror/affine";
import type { PaintOrder, PaintOrderEntry } from "@/mirror/canvas/paintOrder";
import type { NodeClass, NodePaintInput } from "@/mirror/canvas/paintSpec";
import type { MirrorNode } from "@/mirror/sceneTree";
import type { ViewScaleStamp } from "@/mirror/viewScaleLayout";

export interface HiddenSubtreeMemoStats {
  /** Builds the memo took part in, and builds it sat out (spreading, diagnostics, duplicate order entries). */
  builds: number;
  bypassedBuilds: number;
  /** Outermost hidden roots met, and how each was answered. */
  roots: number;
  hits: number;
  misses: number;
  missReasons: Record<string, number>;
  /** Nodes published from a recording, and nodes under an outermost hidden root that were walked. */
  replayedNodes: number;
  walkedHiddenNodes: number;
  /** Recordings kept, and the reasons a walked root left no recording. */
  recorded: number;
  notRecorded: Record<string, number>;
  /** Validated roots walked anyway under verify, and how many of those walks differed from the recording. */
  verified: number;
  verifyMismatches: number;
  /** Live entries after the last build. */
  entries: number;
}

/** One renderer's memo. Opaque apart from its counters; `buildDrawList` drives it through `beginHiddenMemoBuild`. */
export interface HiddenSubtreeMemo {
  readonly stats: HiddenSubtreeMemoStats;
}

/** What the walk appends to while it records one outermost hidden root. Owned by `buildDrawList`'s walk. */
export interface HiddenMemoRecording {
  /** `nodePaintInputs` writes, in walk order. */
  inputIds: string[];
  inputs: NodePaintInput[];
  /** `viewScaleStamps` writes and `viewScaleCandidates` adds, in walk order. */
  stampIds: string[];
  stamps: ViewScaleStamp[];
  candidates: string[];
  /** `onNode` / `semanticNode` calls, in paint order: the id, and the index of its input in `inputs`. */
  emitIds: string[];
  emitIdx: number[];
  /** Set by the walk when this subtree did something a recording cannot reproduce. */
  refuse: string | null;
}

/** Where a replay publishes. Built once per build from the builder's own collections. */
export interface HiddenMemoSink {
  nodePaintInputs: Map<string, NodePaintInput>;
  viewScaleStamps: Map<string, ViewScaleStamp>;
  viewScaleCandidates: Set<string>;
  stats: { skip: number };
  onNode?: (id: string, cls: NodeClass) => void;
  semanticNode?: (input: NodePaintInput, cls: NodeClass, start: number, end: number) => void;
}

export interface HiddenMemoBuildInput {
  /** False sits the memo out for this build without touching its entries. */
  eligible: boolean;
  verify: boolean;
  order: PaintOrder;
  nodes: Map<string, MirrorNode>;
  viewScaling: boolean;
  viewScaleEnv: unknown;
  tipScaling: boolean;
  clipAxis: boolean;
  trackingLocalAnims: boolean;
  pinnedLocals: unknown;
  /** The per-id option key sets whose inclusive ancestors are tainted. */
  taintKeys: ReadonlyArray<Iterable<string> | null | undefined>;
  sink: HiddenMemoSink;
}

/** One build's view of the memo. `enter` answers `true` when it replayed the subtree. */
export interface HiddenMemoBuild {
  enter(
    id: string,
    node: MirrorNode,
    parentGame: Affine,
    parentFinal: Affine,
    cascadeAlpha: number,
    tintR: number,
    tintG: number,
    tintB: number,
    offX: number,
    offY: number,
    parentDrawTy: number,
    vsIn: Affine | null,
    vsHitIn: Affine | null,
    inCardReward: boolean,
    drawnMoved: boolean,
    animMoved: boolean,
    listCount: number,
    hitCount: number,
    overlayCount: number
  ): HiddenMemoRecording | null | true;
  finish(rec: HiddenMemoRecording, listCount: number, hitCount: number, overlayCount: number): void;
  end(): void;
}

interface RecordedSubtree {
  orderSerial: number;
  envEpoch: number;
  spanStart: number;
  spanLen: number;
  /** Paint-order ids of the span, which are also the `emitIds`, and the node object each was walked with. */
  ids: readonly string[];
  nodes: readonly MirrorNode[];
  ancestors: readonly (MirrorNode | undefined)[];
  ctx: Float64Array;
  inputIds: readonly string[];
  inputs: readonly NodePaintInput[];
  stampIds: readonly string[];
  stamps: readonly ViewScaleStamp[];
  candidates: readonly string[];
  emitIdx: readonly number[];
}

interface MemoEntry {
  seen: number;
  /** Consecutive builds this root was walked without a usable recording, and the build recording resumes at. */
  streak: number;
  holdUntil: number;
  data: RecordedSubtree | null;
}

interface ActiveRecording extends HiddenMemoRecording {
  rootId: string;
  spanStart: number;
  spanLen: number;
  ctx: Float64Array;
  ancestors: (MirrorNode | undefined)[];
  listCount: number;
  hitCount: number;
  overlayCount: number;
  verifyAgainst: RecordedSubtree | null;
}

interface InternalMemo extends HiddenSubtreeMemo {
  entries: Map<string, MemoEntry>;
  generation: number;
  lastOrder: PaintOrder | null;
  orderSerial: number;
  orderDuplicateFree: boolean;
  envEpoch: number;
  env: unknown[] | null;
}

// The packed walk context — see `packContext`.
const CTX_LEN = 37;
/** Longest backoff, in builds, for a root whose recordings keep failing. */
const MAX_HOLD = 16;

export function createHiddenSubtreeMemo(): HiddenSubtreeMemo {
  const memo: InternalMemo = {
    stats: {
      builds: 0,
      bypassedBuilds: 0,
      roots: 0,
      hits: 0,
      misses: 0,
      missReasons: {},
      replayedNodes: 0,
      walkedHiddenNodes: 0,
      recorded: 0,
      notRecorded: {},
      verified: 0,
      verifyMismatches: 0,
      entries: 0
    },
    entries: new Map(),
    generation: 0,
    lastOrder: null,
    orderSerial: 0,
    orderDuplicateFree: false,
    envEpoch: 0,
    env: null
  };
  return memo;
}

/**
 * Does every reachable child list hold each id once? Then the number of list entries the draw walk will descend
 * into equals the number of ids the paint order emitted, and a span's ids determine its subtree's child lists.
 */
export function orderIsDuplicateFree(order: PaintOrder): boolean {
  let entries = order.rootIds.length;
  for (const id of order.ids) entries += order.childrenOf(id).length;
  return entries === order.ids.length;
}

/** Start one build's use of `memo`, or null when it sits this build out. */
export function beginHiddenMemoBuild(memoIn: HiddenSubtreeMemo, input: HiddenMemoBuildInput): HiddenMemoBuild | null {
  const memo = memoIn as InternalMemo;
  const stats = memo.stats;
  const { order, nodes, sink, verify } = input;
  if (order !== memo.lastOrder) {
    memo.lastOrder = order;
    memo.orderSerial++;
    memo.orderDuplicateFree = orderIsDuplicateFree(order);
  }
  if (!input.eligible || !memo.orderDuplicateFree) {
    stats.bypassedBuilds++;
    return null;
  }
  stats.builds++;
  const generation = ++memo.generation;
  const orderSerial = memo.orderSerial;

  // Identity and switch values; any change starts a new epoch and every older recording misses on it.
  const env = [nodes, input.viewScaling, input.viewScaleEnv, input.tipScaling, input.clipAxis,
    input.trackingLocalAnims, input.pinnedLocals];
  if (memo.env === null || env.some((value, i) => value !== memo.env![i])) {
    memo.env = env;
    memo.envEpoch++;
  }
  const envEpoch = memo.envEpoch;

  const taint = new Set<string>();
  for (const keys of input.taintKeys) {
    if (keys == null) continue;
    for (const key of keys) {
      // Climb the walk's own parent rule (a parent counts while it is live), stopping at the first id already in.
      let cur: string | null = key;
      while (cur !== null && !taint.has(cur)) {
        taint.add(cur);
        const parentId: string | null | undefined = nodes.get(cur)?.parentId;
        cur = parentId != null && nodes.has(parentId) ? parentId : null;
      }
    }
  }

  const ctx = new Float64Array(CTX_LEN);
  const miss = (reason: string): void => {
    stats.misses++;
    stats.missReasons[reason] = (stats.missReasons[reason] ?? 0) + 1;
  };
  // A recording that failed validation or was refused: drop it, and after two in a row hold off recording this
  // root for a doubling number of builds.
  const failed = (entry: MemoEntry): void => {
    entry.data = null;
    entry.streak++;
    if (entry.streak >= 2) entry.holdUntil = generation + Math.min(1 << (entry.streak - 2), MAX_HOLD);
  };

  const validate = (data: RecordedSubtree, span: PaintOrderEntry,
    ancestors: readonly (MirrorNode | undefined)[]): string | null => {
    if (data.envEpoch !== envEpoch) return "env";
    if (span.spanStart !== data.spanStart || span.spanEnd - span.spanStart !== data.spanLen) return "span";
    for (let i = 0; i < CTX_LEN; i++) if (!Object.is(ctx[i], data.ctx[i])) return "context";
    if (ancestors.length !== data.ancestors.length) return "ancestor";
    for (let i = 0; i < ancestors.length; i++) if (ancestors[i] !== data.ancestors[i]) return "ancestor";
    const ids = order.ids;
    const sameOrder = data.orderSerial === orderSerial;
    for (let i = 0; i < data.spanLen; i++) {
      const id = ids[data.spanStart + i];
      if (!sameOrder && id !== data.ids[i]) return "ids";
      if (nodes.get(id) !== data.nodes[i]) return "node";
    }
    return null;
  };

  const replay = (data: RecordedSubtree, listCount: number): void => {
    const { nodePaintInputs, viewScaleStamps, viewScaleCandidates, onNode, semanticNode } = sink;
    for (let i = 0; i < data.inputIds.length; i++) nodePaintInputs.set(data.inputIds[i], data.inputs[i]);
    for (let i = 0; i < data.stampIds.length; i++) viewScaleStamps.set(data.stampIds[i], data.stamps[i]);
    for (const id of data.candidates) viewScaleCandidates.add(id);
    if (onNode !== undefined || semanticNode !== undefined) {
      for (let k = 0; k < data.ids.length; k++) {
        onNode?.(data.ids[k], "skip");
        semanticNode?.(data.inputs[data.emitIdx[k]], "skip", listCount, listCount);
      }
    }
    sink.stats.skip += data.ids.length;
  };

  return {
    enter(id, node, parentGame, parentFinal, cascadeAlpha, tintR, tintG, tintB, offX, offY, parentDrawTy, vsIn,
      vsHitIn, inCardReward, drawnMoved, animMoved, listCount, hitCount, overlayCount) {
      stats.roots++;
      const span = order.entries.get(id);
      const spanLen = span === undefined ? 0 : span.spanEnd - span.spanStart;
      let entry = memo.entries.get(id);
      if (entry === undefined) {
        entry = { seen: generation, streak: 0, holdUntil: 0, data: null };
        memo.entries.set(id, entry);
      }
      entry.seen = generation;
      if (taint.has(id) || span === undefined) {
        miss(span === undefined ? "unordered" : "tainted");
        stats.walkedHiddenNodes += spanLen;
        return null;
      }
      packContext(ctx, parentGame, parentFinal, cascadeAlpha, tintR, tintG, tintB, offX, offY, parentDrawTy, vsIn,
        vsHitIn, inCardReward, drawnMoved, animMoved);
      const ancestors = ancestorsOf(node, nodes);
      const data = entry.data;
      const reason = data === null ? "absent" : validate(data, span, ancestors);
      if (reason === null) {
        stats.hits++;
        entry.streak = 0;
        if (!verify) {
          replay(data!, listCount);
          stats.replayedNodes += spanLen;
          return true;
        }
        stats.verified++;
      } else {
        miss(reason);
        // An environment flip is the whole build's, not this root's churn: it drops the recording without
        // counting toward the backoff.
        if (reason === "env") entry.data = null;
        else if (data !== null) failed(entry);
      }
      stats.walkedHiddenNodes += spanLen;
      if (reason !== null && generation < entry.holdUntil) {
        stats.notRecorded.backoff = (stats.notRecorded.backoff ?? 0) + 1;
        return null;
      }
      const rec: ActiveRecording = {
        inputIds: [], inputs: [], stampIds: [], stamps: [], candidates: [], emitIds: [], emitIdx: [], refuse: null,
        rootId: id, spanStart: span.spanStart, spanLen, ctx: ctx.slice(), ancestors, listCount, hitCount,
        overlayCount, verifyAgainst: reason === null ? data : null
      };
      return rec;
    },

    finish(recIn, listCount, hitCount, overlayCount) {
      const rec = recIn as ActiveRecording;
      const entry = memo.entries.get(rec.rootId)!;
      let refuse = rec.refuse;
      if (refuse === null && (listCount !== rec.listCount || hitCount !== rec.hitCount || overlayCount !== rec.overlayCount)) {
        refuse = "published";
      }
      if (refuse === null && rec.emitIds.length !== rec.spanLen) refuse = "shape";
      for (let k = 0; refuse === null && k < rec.spanLen; k++) {
        if (order.ids[rec.spanStart + k] !== rec.emitIds[k]) refuse = "shape";
      }
      const nodesWalked = refuse === null ? rec.emitIdx.map((i) => rec.inputs[i].node) : [];
      for (let k = 0; refuse === null && k < nodesWalked.length; k++) {
        if (nodesWalked[k] !== nodes.get(rec.emitIds[k])) refuse = "substitute";
      }
      if (rec.verifyAgainst !== null && (refuse !== null || !sameRecording(rec, rec.verifyAgainst))) {
        stats.verifyMismatches++;
      }
      if (refuse !== null) {
        stats.notRecorded[refuse] = (stats.notRecorded[refuse] ?? 0) + 1;
        failed(entry);
        return;
      }
      entry.data = {
        orderSerial,
        envEpoch,
        spanStart: rec.spanStart,
        spanLen: rec.spanLen,
        ids: rec.emitIds,
        nodes: nodesWalked,
        ancestors: rec.ancestors,
        ctx: rec.ctx,
        inputIds: rec.inputIds,
        inputs: rec.inputs,
        stampIds: rec.stampIds,
        stamps: rec.stamps,
        candidates: rec.candidates,
        emitIdx: rec.emitIdx
      };
      if (rec.verifyAgainst === null) stats.recorded++;
    },

    end() {
      for (const [id, entry] of memo.entries) if (entry.seen !== generation) memo.entries.delete(id);
      stats.entries = memo.entries.size;
    }
  };
}

/**
 * The walk context a root is entered with, as one flat row: parent game and drawn globals, cascaded alpha and
 * tint, inherited cosmetic offset, parent drawn Y, both view-scale products (presence, then value) and whether
 * they are one object, and the three flags. Compared with `Object.is`, so NaN equals NaN and 0 is not -0.
 */
function packContext(
  out: Float64Array, parentGame: Affine, parentFinal: Affine, cascadeAlpha: number, tintR: number, tintG: number,
  tintB: number, offX: number, offY: number, parentDrawTy: number, vsIn: Affine | null, vsHitIn: Affine | null,
  inCardReward: boolean, drawnMoved: boolean, animMoved: boolean
): void {
  for (let i = 0; i < 6; i++) {
    out[i] = parentGame[i];
    out[6 + i] = parentFinal[i];
  }
  out[12] = cascadeAlpha;
  out[13] = tintR;
  out[14] = tintG;
  out[15] = tintB;
  out[16] = offX;
  out[17] = offY;
  out[18] = parentDrawTy;
  out[19] = vsIn === null ? 0 : 1;
  out[26] = vsHitIn === null ? 0 : 1;
  for (let i = 0; i < 6; i++) {
    out[20 + i] = vsIn === null ? 0 : vsIn[i];
    out[27 + i] = vsHitIn === null ? 0 : vsHitIn[i];
  }
  out[33] = vsIn === vsHitIn ? 1 : 0;
  out[34] = inCardReward ? 1 : 0;
  out[35] = drawnMoved ? 1 : 0;
  out[36] = animMoved ? 1 : 0;
}

/** The root's parent chain as the scene-identity resolves climb it: live ancestors, then an absent parent if any. */
function ancestorsOf(node: MirrorNode, nodes: Map<string, MirrorNode>): (MirrorNode | undefined)[] {
  const out: (MirrorNode | undefined)[] = [];
  let parentId = node.parentId;
  // Bounded by the map size: a root the paint order reached has a finite parent chain, this is only a belt.
  while (parentId != null && out.length <= nodes.size) {
    const parent = nodes.get(parentId);
    out.push(parent);
    if (parent === undefined) break;
    parentId = parent.parentId;
  }
  return out;
}

function sameRecording(walked: ActiveRecording, recorded: RecordedSubtree): boolean {
  return (
    sameValues(walked.inputIds, recorded.inputIds) &&
    walked.inputs.length === recorded.inputs.length &&
    walked.inputs.every((input, i) => sameShallow(input, recorded.inputs[i])) &&
    sameValues(walked.stampIds, recorded.stampIds) &&
    walked.stamps.length === recorded.stamps.length &&
    walked.stamps.every((stamp, i) => sameShallow(stamp, recorded.stamps[i])) &&
    sameValues(walked.candidates, recorded.candidates) &&
    sameValues(walked.emitIds, recorded.ids) &&
    sameValues(walked.emitIdx, recorded.emitIdx)
  );
}

function sameValues<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

/** Own fields equal by `Object.is`, one level of arrays and plain objects compared by value. */
function sameShallow(a: object, b: object): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const key of ka) {
    const va = (a as Record<string, unknown>)[key];
    const vb = (b as Record<string, unknown>)[key];
    if (Object.is(va, vb)) continue;
    if (Array.isArray(va) && Array.isArray(vb)) {
      if (!sameValues(va, vb)) return false;
      continue;
    }
    if (isPlainObject(va) && isPlainObject(vb)) {
      const ia = Object.keys(va);
      if (ia.length !== Object.keys(vb).length || !ia.every((k) => Object.is(va[k], vb[k]))) return false;
      continue;
    }
    return false;
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}
