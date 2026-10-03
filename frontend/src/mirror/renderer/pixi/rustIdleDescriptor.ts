/**
 * `rustIdleInRust`: the idle animations of one committed Rust scene, as the descriptor set the renderer evaluates
 * itself (GSW `RIA1`, `set_idle_anims` / `present_idle`).
 *
 * The retained patch path re-poses each local-animation root every frame: `sampleIdleAnim` gives its pre/post at
 * the loop phase, `retainedComposition.patch` turns that into a delta per root and a pose per command, and the
 * executor serializes the commands (a group member is re-placed by the GSW serializer, a text through its carrier
 * inset). This module captures, once, everything those steps read besides the clock, so the renderer reproduces
 * the same f64 poses at any `t`: the plan's curve and timing per animated root, the composition's root frames and
 * primitive chains, and the serializer's group members and text placements. Anything the descriptor cannot express
 * is a refusal, and the caller keeps its patch path.
 */
import type { IdleAnimPlan } from "@/mirror/canvas/idleAnim";
import type { LoopTiming } from "@/mirror/canvas/tweenLoop";
import type { RetainedIdlePlan } from "./retainedComposition";

/** `present_idle` result bits (GSW `renderer.rs`): 0 is a refusal. */
export const RUST_IDLE_PRESENTED = 1, RUST_IDLE_SKIP = 2, RUST_IDLE_PARTIAL = 4, RUST_IDLE_FULL = 8, RUST_IDLE_UNCHANGED = 16;
/** The executor's `presentIdle` when its submission lane is busy: nothing was attempted. */
export const RUST_IDLE_BUSY = -1;

/** The subset of a scene/2 snapshot this module reads. */
export interface IdleSceneSnapshot { revision: number; commands: readonly Record<string, unknown>[] }

export type RustIdleCurve = "rest" | "rotate" | "rock" | "bob" | "pivotPulse" | "pulseScale";
export interface RustIdleRootInput {
  curve: RustIdleCurve; amplitudeRad: number; amplitudePx: number; baselineUpPx: number; scaleFrom: number; scaleTo: number;
  pivotX: number; pivotY: number; originMs: number; phaseMs: number; periodMs: number;
  base: readonly number[]; wire: readonly number[] | null; outer: readonly number[]; spreadDx: number; inverse: readonly number[];
}
export interface RustIdleTargetInput {
  commandIndex: number; mode: "group" | "primitive" | "text"; chain: readonly { root: number; offset: number }[];
  parentWorld?: readonly number[]; reference: readonly number[]; inset?: readonly number[];
}
export interface RustIdleSetInput { baseRevision: number; roots: RustIdleRootInput[]; targets: RustIdleTargetInput[] }

/** What the GSW serializer exposes about a committed scene (`rustRetainedGroupMembers`, `rustRetainedTextPlacement`). */
export interface IdleSceneQueries<S> {
  groupMembers(scene: S, groupId: string): { parentWorld: number[]; members: { id: string; index: number; local: number[] }[] } | null;
  textPlacement(scene: S, id: string): { index: number; parentWorld: number[]; inset: number[] } | null;
}

/** An animated root's sampling inputs: the plan `sweepIdle` samples and the loop timing `loopPhase` reads. */
export interface IdleRootSpec { plan: IdleAnimPlan; timing: LoopTiming }

export type IdleDescriptorResult = { set: RustIdleSetInput; animated: number } | { refusal: string };

const PLACED = new Set(["quad", "ninePatch", "stillImage"]);
const TEXT = new Set(["rasterText", "glyphRun"]);

/** Whether a plan writes a paint alpha, which the descriptor cannot express (the frame stays on the patch path). */
export function idlePlanHasAlpha(plan: IdleAnimPlan): boolean {
  return (plan.kind === "glowPulse" || plan.kind === "pulseScaleFade") && (plan.alphaFrom !== 1 || plan.alphaTo !== 1);
}

function curveOf(plan: IdleAnimPlan): RustIdleCurve | null {
  switch (plan.kind) {
    case "rotate": return "rotate";
    case "rock": return "rock";
    case "bob": return "bob";
    case "pivotPulse": return "pivotPulse";
    case "pulseScaleFade": return "pulseScale";
    default: return null;
  }
}

/**
 * The descriptor set for `scene`, or why there is none. `specs` names every root the current frame animates (the
 * keys of the visual state's `localAnims`); a composition root it does not name sits at rest, exactly as `patch()`
 * poses a root with no anim. `toRustId` maps a composition primitive id to its scene command id.
 */
export function buildRustIdleSet<S extends IdleSceneSnapshot>(input: {
  plan: RetainedIdlePlan | null;
  specs: ReadonlyMap<string, IdleRootSpec>;
  scene: S;
  commandIndex(id: string): number | undefined;
  toRustId(id: string): string;
  queries: IdleSceneQueries<S>;
}): IdleDescriptorResult {
  const { plan, specs, scene, queries } = input;
  if (!plan) return { refusal: "composition-refused" };
  const rootIndex = new Map(plan.roots.map((root, index) => [root.id, index]));
  // `patch()` refuses an anim on a node the committed build gave no frame: the patch path rebuilds it.
  for (const id of specs.keys()) if (!rootIndex.has(id)) return { refusal: "anim-not-in-build" };
  const roots: RustIdleRootInput[] = [];
  let animated = 0;
  for (const root of plan.roots) {
    const spec = specs.get(root.id);
    const placement = { base: root.base, wire: root.wire, outer: root.outer, spreadDx: root.spreadDx, inverse: root.inverse };
    if (!spec) {
      roots.push({ curve: "rest", amplitudeRad: 0, amplitudePx: 0, baselineUpPx: 0, scaleFrom: 1, scaleTo: 1, pivotX: 0,
        pivotY: 0, originMs: 0, phaseMs: 0, periodMs: 1, ...placement });
      continue;
    }
    if (idlePlanHasAlpha(spec.plan)) return { refusal: "alpha-channel" };
    const curve = curveOf(spec.plan);
    if (!curve) return { refusal: `curve-${spec.plan.kind}` };
    if (!(spec.timing.periodMs > 0)) return { refusal: "loop-period" };
    animated++;
    roots.push({ curve, amplitudeRad: spec.plan.amplitudeRad, amplitudePx: spec.plan.amplitudePx,
      baselineUpPx: spec.plan.baselineUpPx, scaleFrom: spec.plan.scaleFrom, scaleTo: spec.plan.scaleTo,
      pivotX: spec.plan.pivotX, pivotY: spec.plan.pivotY, originMs: spec.timing.originMs, phaseMs: spec.timing.phaseMs,
      periodMs: spec.timing.periodMs, ...placement });
  }
  const targets: RustIdleTargetInput[] = [];
  const claimed = new Set<number>();
  const claim = (index: number) => { if (claimed.has(index)) return false; claimed.add(index); return true; };
  for (let index = 0; index < plan.roots.length; index++) {
    const group = plan.roots[index].group;
    if (!group) continue;
    // A moved group re-places every command the serializer placed through it.
    const members = queries.groupMembers(scene, group);
    if (!members) return { refusal: "group-members" };
    for (const member of members.members) {
      const command = scene.commands[member.index];
      if (!command || (!PLACED.has(String(command.kind)) && !TEXT.has(String(command.kind)))) return { refusal: "group-command-kind" };
      if (!claim(member.index)) return { refusal: "command-claimed-twice" };
      targets.push({ commandIndex: member.index, mode: "group", chain: [{ root: index, offset: 0 }],
        parentWorld: members.parentWorld, reference: member.local });
    }
  }
  for (const primitive of plan.primitives) {
    const id = input.toRustId(primitive.id);
    const commandIndex = input.commandIndex(id);
    const command = commandIndex === undefined ? undefined : scene.commands[commandIndex];
    // The executor refuses a patch naming a command it cannot re-place; so does the descriptor.
    if (commandIndex === undefined || !command) return { refusal: "unknown-command" };
    const kind = String(command.kind);
    if (!claim(commandIndex)) return { refusal: "command-claimed-twice" };
    if (PLACED.has(kind)) {
      targets.push({ commandIndex, mode: "primitive", chain: primitive.chain, reference: primitive.reference });
    } else if (TEXT.has(kind)) {
      const placement = queries.textPlacement(scene, id);
      if (!placement || placement.index !== commandIndex) return { refusal: "text-placement" };
      targets.push({ commandIndex, mode: "text", chain: primitive.chain, reference: primitive.reference,
        parentWorld: placement.parentWorld, inset: placement.inset });
    } else return { refusal: `command-kind-${kind}` };
  }
  return { set: { baseRevision: scene.revision, roots, targets }, animated };
}
