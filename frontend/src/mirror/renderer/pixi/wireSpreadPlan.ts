import { affineMul, type Affine } from "@/mirror/affine";
import { REMOTE_FOLLOWER_TYPES } from "@/mirror/renderer/interactionPolicy";
import { nodeTypeLeaf, type MirrorNode } from "@/mirror/sceneTree";
import {
  applyDrawnFieldRebase,
  childParentWidth,
  computeSpread,
  createSpreadOut,
  rootSpreadCtx,
  spreadDrawBox,
  writeChildSpreadCtx,
  type SpreadCtx,
  type SpreadEnv
} from "@/mirror/spreadLayout";
import type { PaintOrder } from "@/mirror/canvas/paintOrder";
import type { HitEntry } from "@/mirror/canvas/hitTest";
import { pointInPlacedRect } from "@/mirror/raiseInverse";
import { isPureTranslation } from "./retainedComposition";

// `rustWireSpreadPatch` — A WIRE DELTA ON A WIDENED STAGE, AS A PER-NODE DRAWN DELTA.
//
// A build draws a node of a wire span at `mᵢ = T(O + sᵢ)·gᵢ`: `gᵢ` its true game global, `sᵢ = (dxᵢ, 0)` its spread
// shift and `O` the cosmetic offset inherited from above the span (no view-scale stamp sits in or above an admitted
// span, see `translatedSpan`). A streamed delta `D` moves every game global of the span, `g'ᵢ = D·gᵢ`, so a rebuild
// draws `T(O + s'ᵢ)·D·gᵢ`, which is the committed pose re-posed by
//
//     Dᵢ = T(O + s'ᵢ) · D · T(−O − sᵢ)
//
// That is exact for ANY `D` once `s'ᵢ` is the shift the build would give the node at its new pose. Rather than
// re-deriving that rule here, this re-walks the span through `computeSpread` itself, from the context the build
// handed the root: the root's ancestors are re-walked from the stage root first (they did not move). Every shift the
// re-walk produces at the COMMITTED poses is checked against what the committed build banked, so a context this
// cannot reconstruct (a tween rebase, a pinned local, an unmodelled branch) refuses instead of drawing a guess.
//
// The field's clamp at 0 and 1920 needs no refusal of its own: each node's `s'ᵢ` comes from the field function at the
// node's own new pose, not from an extrapolation of the root's, so a node that crosses the clamp gets the clamped
// value a rebuild gives it. (The field is continuous, so float noise near the clamp moves `s'ᵢ` by noise only.)
//
// What it refuses, besides an unreconstructable context:
// - an owner-anchored floater (`anchorOwnerId`) or a remote follower in the span: their shift is a registry lookup;
// - any shift change while the committed build resolved a floater against a node of the span (the floater, outside
//   the span, would keep the old answer);
// - a span hit that covers a point the committed build resolved a remote follower at (its shift is that hit's);
// - a clipper in a span whose shifts change (its clip and its children would move by different vectors);
// - a width change (an anchor-algebra widening is a box size no matrix patch can express).

/** What the planner reads from the committed build and scene. */
export interface WireSpreadInput {
  readonly rootId: string;
  /** The committed node map (the root's old local) and the incoming one (its new local); the rest is shared. */
  readonly before: ReadonlyMap<string, MirrorNode>;
  readonly after: ReadonlyMap<string, MirrorNode>;
  readonly order: Pick<PaintOrder, "entries" | "ids" | "childrenOf">;
  /** The root's game global as committed and as streamed now, and the game delta between them. */
  readonly gOld: Affine;
  readonly gNew: Affine;
  readonly delta: Affine;
  /** The root's committed DRAWN matrix (its node matrix), for the inherited offset `O`. */
  readonly drawnRoot: Affine | null;
  /**
   * `rustTweenRootPatch`: the root is drawn at an ABSOLUTE override pose (a tween sample), committed and now. The game
   * globals (`gOld` = `gNew`) do not move; the rendered ones do, every span node composing through the root's, and
   * each node's field claim is re-based at its rendered pose (`applyDrawnFieldRebase`), as the build does for a node
   * an override moves. `delta` is then the rendered delta `Δ = now·old⁻¹`.
   */
  readonly rendered?: { readonly old: Affine; readonly now: Affine };
  /** The delta the span's hits' `mGame` takes (the follower test): `delta` by default, the identity for a tween. */
  readonly gameDelta?: Affine;
  /** Prefix of every refusal reason (`wire-spread` by default; `tween-root` for the tween patch). */
  readonly tag?: string;
  readonly spreadFactor: number;
  /** The committed per-node spread shift (every node the build walked on a widened stage). */
  readonly dx: ReadonlyMap<string, number>;
  /** Owners the committed build resolved an `anchorOwnerId` floater against. */
  readonly ownerReads: ReadonlySet<string>;
  /**
   * The game points the committed build resolved a remote follower at, as (x, y, shift) triples. A follower takes the
   * shift of the painting, mouse-visible hit under its point, so a span hit that covers one, before or after the move,
   * refuses: the next build would resolve it differently. (Whether the CURRENT hits still give each recorded shift
   * is the caller's check, once per reconcile.)
   */
  readonly followerPoints: readonly number[];
  /** The span's committed hit entries, by node (the hits this patch would re-pose). */
  readonly hitsOf: (id: string) => readonly HitEntry[] | undefined;
  readonly clipRanges: ReadonlyMap<string, unknown>;
  readonly sceneEnv: Pick<SpreadEnv, "isBackgroundSceneRoot" | "isPreviewContainer" | "forcesCenterClaim">;
  /** Per reconcile: the child context and game global of each re-walked ancestor, shared across spans. */
  readonly ancestorCache: Map<string, AncestorFrame | null>;
}

export interface AncestorFrame {
  /** The context the node hands its children. */
  readonly ctx: SpreadCtx;
  /** The node's game global. */
  readonly g: Affine;
}

export interface WireSpreadPlan {
  /** The drawn delta for every node it differs from `delta` for; null when one delta serves the whole span. */
  readonly nodeDeltas: Map<string, Affine> | null;
  /** The drawn delta for nodes `nodeDeltas` does not list (`T(O)·D·T(−O)`, or `D` itself). */
  readonly uniform: Affine;
  /** Each span node's new spread shift, where it changed. */
  readonly dx: Map<string, number>;
  /** How many span nodes the re-walk visited (diagnostics). */
  readonly visited: number;
  /**
   * The span draws differently from a plain wire patch by `delta`, or a plain one would have been refused
   * (`translatedSpan`'s `wire-spread`): the patch is this switch's, and its shadow check reports to its family.
   */
  readonly reposed: boolean;
}

export interface WireSpreadRefusal {
  readonly reason: string;
  readonly id: string;
}

/** Shift agreement between the re-walk and the committed bank: both run the same arithmetic on the same inputs. */
const SHIFT_EPSILON = 1e-7;
const same = (a: number, b: number) => Math.abs(a - b) <= SHIFT_EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];
const OFFSET_NOISE = 1e-6;

/**
 * The per-node drawn deltas for one wire span, or why the span must rebuild. Allocation is proportional to the span
 * plus the root's (cached) ancestry.
 */
export function planWireSpread(input: WireSpreadInput): WireSpreadPlan | WireSpreadRefusal {
  const { rootId, after, delta, spreadFactor } = input;
  const tag = input.tag ?? "wire-spread";
  const rendered = input.rendered ?? null;
  const pure = isPureTranslation(delta);
  const span = input.order.entries.get(rootId);
  if (!span) return { reason: "wire-missing-span", id: rootId };
  // The inherited offset only matters when `D` has a linear part: a translation commutes with it.
  let ox = 0, oy = 0;
  if (!pure) {
    // An unwalked root drew nothing; its span has no pose to re-pose.
    const m = input.drawnRoot;
    if (m) {
      const g = rendered?.old ?? input.gOld;
      // The committed drawn linear IS the game linear in an admitted span (no stamp, anim or override): check it.
      for (let i = 0; i < 4; i++) if (!same(m[i], g[i])) return { reason: `${tag}-pose`, id: rootId };
      const s = spreadFactor === 1 ? 0 : input.dx.get(rootId) ?? 0;
      ox = m[4] - g[4] - s;
      oy = m[5] - g[5];
      // Patches compose the drawn matrix in float64 against a list stored in float32: sub-micro-pixel noise is no offset.
      if (Math.abs(ox) < OFFSET_NOISE) ox = 0;
      if (Math.abs(oy) < OFFSET_NOISE) oy = 0;
    }
    // `O` is the root's whole drawn offset (inherited, plus its own: it rides the root's parent, which did not move).
    // An owner BELOW the root needs nothing more: the build maps its offset `v` through its parent's drawn linear,
    // which the move turns into `L·v`, and `T(O + s')·D·T(−O − s)` applied to `T(O + v + s)·g` is exactly
    // `T(O + L·v + s')·D·g`.
  }
  const conjugate = (a: number, b: number): Affine => {
    // T(O + (a, 0)) · D · T(−O − (b, 0))
    const px = ox + b, py = oy;
    return [delta[0], delta[1], delta[2], delta[3],
      ox + a + delta[4] - (delta[0] * px + delta[2] * py), oy + delta[5] - (delta[1] * px + delta[3] * py)];
  };
  const uniform = pure || (ox === 0 && oy === 0) ? delta : conjugate(0, 0);
  if (spreadFactor === 1) return { nodeDeltas: null, uniform, dx: new Map(), visited: 0, reposed: uniform !== delta };
  // An unwalked root (a skipped or never-reached subtree) drew nothing a shift could move.
  const rootDx = input.dx.get(rootId);
  if (rootDx === undefined) return { nodeDeltas: null, uniform, dx: new Map(), visited: 0, reposed: uniform !== delta };
  const movesX = !pure || delta[4] !== 0;
  let legacy = false;

  for (let order = span.spanStart; order < span.spanEnd; order++) {
    const id = input.order.ids[order], node = after.get(id);
    if (!node) continue;
    if (node.anchorOwnerId != null) return { reason: `${tag}-floater`, id };
    if (REMOTE_FOLLOWER_TYPES.has(nodeTypeLeaf(node.nodeType))) return { reason: `${tag}-follower`, id };
  }

  const parentFrame = ancestorFrame(after.get(rootId)?.parentId ?? null, input, input.spreadFactor);
  if (typeof parentFrame === "string") return { reason: `${tag}-context`, id: parentFrame };

  const out = createSpreadOut();
  const dx = new Map<string, number>();
  const nodeDeltas = new Map<string, Affine>();
  const env = spanEnv(input.sceneEnv);
  let visited = 0;
  const stop: { refusal: WireSpreadRefusal | null } = { refusal: null };
  // `rOld`/`rNew`: the node's rendered global, the pose a moved node's field claim is re-based at (tween roots only;
  // a wire span draws at its game pose).
  const visit = (id: string, ctxOld: SpreadCtx, ctxNew: SpreadCtx, gOld: Affine, gNew: Affine, rOld: Affine | null,
    rNew: Affine | null): void => {
    const node = after.get(id);
    const banked = input.dx.get(id);
    if (!node || banked === undefined) return;
    visited++;
    const box = spreadDrawBox(node);
    computeSpread(id, node, ctxOld, gOld, box, spreadFactor, env, out);
    if (rOld) applyDrawnFieldRebase(out, node, rOld, box, spreadFactor);
    if (env.asked || !same(out.dx, banked)) { stop.refusal = { reason: `${tag}-context`, id }; return; }
    if ((movesX && out.fieldMode !== 0) || (!pure && banked !== 0)) legacy = true;
    const width = out.renderWidthOverride;
    const childOld = writeChildSpreadCtx(blankCtx(), gOld, childParentWidth(node, ctxOld.parentWidth), out);
    computeSpread(id, node, ctxNew, gNew, box, spreadFactor, env, out);
    if (rNew) applyDrawnFieldRebase(out, node, rNew, box, spreadFactor);
    if (env.asked) { stop.refusal = { reason: `${tag}-context`, id }; return; }
    if (out.renderWidthOverride !== width) { stop.refusal = { reason: `${tag}-width`, id }; return; }
    const next = out.dx;
    const childNew = writeChildSpreadCtx(blankCtx(), gNew, childParentWidth(node, ctxNew.parentWidth), out);
    if (next !== banked) {
      dx.set(id, next);
      nodeDeltas.set(id, pure ? [1, 0, 0, 1, delta[4] + next - banked, delta[5]] : conjugate(next, banked));
    } else if (!pure && banked !== 0) {
      // Unmoved on the field, but `D`'s linear part still turns about the shifted pose.
      nodeDeltas.set(id, conjugate(banked, banked));
    }
    for (const kid of input.order.childrenOf(id)) {
      if (stop.refusal) return;
      const own = after.get(kid)?.transform as Affine | null | undefined;
      const gameOld = own ? affineMul(gOld, own) : gOld;
      visit(kid, childOld, childNew, gameOld, rendered ? gameOld : own ? affineMul(gNew, own) : gNew,
        rOld && own ? affineMul(rOld, own) : rOld, rNew && own ? affineMul(rNew, own) : rNew);
    }
  };
  visit(rootId, parentFrame.ctx, parentFrame.ctx, input.gOld, input.gNew, rendered?.old ?? null, rendered?.now ?? null);
  if (stop.refusal) return stop.refusal;
  const followers = input.followerPoints;
  if (followers.length > 0) for (let order = span.spanStart; order < span.spanEnd; order++) {
    const id = input.order.ids[order];
    for (const hit of input.hitsOf(id) ?? []) {
      if (!hit.mouseVisible || !hit.paints) continue;
      const moved = affineMul(input.gameDelta ?? delta, hit.mGame);
      for (let i = 0; i < followers.length; i += 3)
        if (pointInPlacedRect(hit.mGame, hit.localRect, followers[i], followers[i + 1]) ||
          pointInPlacedRect(moved, hit.localRect, followers[i], followers[i + 1])) return { reason: `${tag}-follower-hit`, id };
    }
  }
  if (dx.size > 0) {
    for (const owner of input.ownerReads)
      if (nodesRelated(owner, rootId, after)) return { reason: `${tag}-owner`, id: owner };
    for (let order = span.spanStart; order < span.spanEnd; order++) {
      const id = input.order.ids[order];
      if (input.clipRanges.has(id)) return { reason: `${tag}-clip`, id };
    }
  }
  return { nodeDeltas: nodeDeltas.size ? nodeDeltas : null, uniform, dx, visited,
    reposed: legacy || nodeDeltas.size > 0 || uniform !== delta };
}

/**
 * The child context and game global of `id`, re-walked from the stage root and checked against the committed bank,
 * or the id whose re-walked shift disagreed. `null` id: the stage root's own context.
 */
function ancestorFrame(id: string | null, input: WireSpreadInput, spreadFactor: number): AncestorFrame | string {
  const nodes = input.after;
  const node = id === null ? undefined : nodes.get(id);
  if (id === null || !node) return { ctx: rootSpreadCtx(spreadFactor, IDENTITY), g: IDENTITY };
  const cached = input.ancestorCache.get(id);
  if (cached) return cached;
  if (cached === null) return id;
  const parent = ancestorFrame(node.parentId ?? null, input, spreadFactor);
  if (typeof parent === "string") { input.ancestorCache.set(id, null); return parent; }
  const own = node.transform as Affine | null | undefined;
  const g = own ? affineMul(parent.g, own) : parent.g;
  const banked = input.dx.get(id);
  // A floater or follower ancestor hands its children its own banked shift (the override consumes the budget).
  const out = createSpreadOut();
  computeSpread(id, node, parent.ctx, g, spreadDrawBox(node), spreadFactor, bankedEnv(input.sceneEnv, banked), out);
  if (banked === undefined || !same(out.dx, banked)) { input.ancestorCache.set(id, null); return id; }
  const frame = { ctx: writeChildSpreadCtx(blankCtx(), g, childParentWidth(node, parent.ctx.parentWidth), out), g };
  input.ancestorCache.set(id, frame);
  return frame;
}

function blankCtx(): SpreadCtx {
  return { parentDx: 0, deltaParentWidth: 0, anchorDelta: 0, rideDx: 0, parentDxProp: false, parentWidth: 0,
    parentGlobal: IDENTITY, containerChildAlign: null, containerChildVertical: false };
}

/** Span nodes never ask the registry (floaters and followers are refused first); an ask refuses the span. */
function spanEnv(scene: WireSpreadInput["sceneEnv"]): SpreadEnv & { asked: boolean } {
  const env = { ...scene, asked: false,
    ownerDx: (_owner: string, fallback: number) => { env.asked = true; return fallback; },
    remoteFollowerDx: (node: MirrorNode) => {
      if (!REMOTE_FOLLOWER_TYPES.has(nodeTypeLeaf(node.nodeType))) return null;
      env.asked = true;
      return 0;
    } };
  return env;
}

/** An ancestor that is a floater or follower answers with its own committed shift (checked against the bank). */
function bankedEnv(scene: WireSpreadInput["sceneEnv"], banked: number | undefined): SpreadEnv {
  return { ...scene,
    ownerDx: (_owner, fallback) => banked ?? fallback,
    remoteFollowerDx: (node) => REMOTE_FOLLOWER_TYPES.has(nodeTypeLeaf(node.nodeType)) ? banked ?? 0 : null };
}

/** Whether `a` is `b`, an ancestor of it, or a descendant of it. */
export function nodesRelated(a: string, b: string, nodes: ReadonlyMap<string, MirrorNode>): boolean {
  for (let id: string | null | undefined = a, steps = 0; id != null && steps <= nodes.size; id = nodes.get(id)?.parentId, steps++)
    if (id === b) return true;
  for (let id: string | null | undefined = b, steps = 0; id != null && steps <= nodes.size; id = nodes.get(id)?.parentId, steps++)
    if (id === a) return true;
  return false;
}
