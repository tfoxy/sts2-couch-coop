// rustIdleInRust parity: the Rust idle evaluator (`idleEvaluate`, GSW `idle.rs`) against the patch path it replaces
// — `sampleIdleAnim` at `loopPhaseAt`, `retainedComposition.patch`, and the GSW retained-patch serializer — over the
// same plans, roots and clocks, compared bit for bit. Every target mode is covered: a root group (several members,
// one with text), a ranked singleton group, a primitive root carrying a text through its carrier inset, nested roots
// with spread offsets, and a root at rest. A second pass re-installs after committed patches, whose text chains the
// serializer rewrites, and checks again.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createDrawList, createQuadView, type DrawList } from "@godot-scene-web/canvas";
import type { PixiTextRecord } from "@godot-scene-web/canvas/pixi";
import * as serializer from "@godot-scene-web/canvas/rust-prototype";
import type { RustTextCarrier } from "@godot-scene-web/canvas/rust-prototype";
import * as glue from "@couchcoop/rust-prototype-glue";
import type { DrawListBuild, LocalAnim, LocalAnimFrame } from "@/mirror/canvas/buildDrawList";
import { composeLocalAnimGlobal } from "@/mirror/canvas/buildDrawList";
import type { PaintOrderEntry } from "@/mirror/canvas/paintOrder";
import { createIdleAnimSample, idleAnimPlanFor, sampleIdleAnim, type IdleAnimPlan } from "@/mirror/canvas/idleAnim";
import { loopPhaseAt, type LoopTiming } from "@/mirror/canvas/tweenLoop";
import { affineMul, type Affine } from "@/mirror/affine";
import { createRetainedPixiComposition, type RetainedPixiComposition } from "./retainedComposition";
import { buildRustIdleSet, type IdleRootSpec, type RustIdleSetInput } from "./rustIdleDescriptor";

type Serializer = typeof serializer & {
  encodeRustIdleAnims?(set: RustIdleSetInput): Uint8Array | null;
  rustRetainedGroupMembers?: NonNullable<Parameters<typeof buildRustIdleSet>[0]["queries"]["groupMembers"]>;
  rustRetainedTextPlacement?: NonNullable<Parameters<typeof buildRustIdleSet>[0]["queries"]["textPlacement"]>;
};
const gsw = serializer as Serializer;
type Glue = { initSync(input: { module: BufferSource }): unknown; idleEvaluate?(bytes: Uint8Array, tMs: number): Float64Array };
const wasm = glue as unknown as Glue;
// Vitest runs from `frontend/`; the generated module sits beside the glue the alias resolves.
const wasmPath = resolve(process.cwd(), "../.sts2/rust-prototype-web/rust_prototype_bg.wasm");
// The glue and the serializer must both carry the idle module (a glue built from an older GSW does not).
const available = typeof wasm.idleEvaluate === "function" && typeof gsw.encodeRustIdleAnims === "function" &&
  existsSync(wasmPath);
if (available) wasm.initSync({ module: readFileSync(wasmPath) });

const binding = (kind: string, extra: Record<string, number> = {}) =>
  ({ kind, durationMs: 2000, ...extra }) as unknown as Parameters<typeof idleAnimPlanFor>[0];
const box = { x: 3, y: -4, width: 48, height: 40 };

interface Root { id: string; plan: IdleAnimPlan | null; timing: LoopTiming; frame: LocalAnimFrame }

function frameFor(base: Affine, wire: Affine | null, outer: Affine, spreadDx: number, plan: IdleAnimPlan | null,
  timing: LoopTiming, builtAt: number): LocalAnimFrame {
  // `drawn` is the pose the build wrote: the anim sampled at the build clock, exactly as the walk composes it.
  const anim = plan ? sampleAt(plan, timing, builtAt) : { pre: null, post: null };
  const raw = composeLocalAnimGlobal(base, wire, null, anim.pre, anim.post);
  const drawn = affineMul(outer, [raw[0], raw[1], raw[2], raw[3], raw[4] + spreadDx, raw[5]]);
  return { drawn, outer, base, wire, spreadDx, spreadRebased: false };
}

const sample = createIdleAnimSample();
function sampleAt(plan: IdleAnimPlan, timing: LoopTiming, at: number): LocalAnim {
  sampleIdleAnim(plan, loopPhaseAt(timing, at), sample);
  return { pre: sample.hasPre ? [1, 0, 0, 1, sample.preX, sample.preY] : null, post: sample.hasPost ? sample.post.slice() : null };
}

/** One scene with every target mode. Command order: holder, iconA, iconB | orb, staticA, staticB | label | outer, inner | still. */
function fixture() {
  const list = createDrawList<string>();
  const quad = (texture: string, m: Affine, size = 10) => {
    const q = createQuadView(); q.w = q.h = q.srcW = q.srcH = size; q.m.set(m); list.pushQuad(q, texture);
  };
  quad("holder.png", [1, 0, 0, 1, 0, 0]); quad("iconA.png", [1, 0, 0, 1, 12.5, 3]); quad("iconB.png", [0.5, 0, 0, 0.5, 24, 1]);
  quad("orb.png", [1, 0, 0, 1, 400, 30], 64); quad("staticA.png", [1, 0, 0, 1, 470, 30]); quad("staticB.png", [1, 0, 0, 1, 490, 30]);
  quad("label.png", [1.25, 0, 0, 1.25, 700, 80]);
  quad("outer.png", [1, 0, 0, 1, 900, 300]); quad("inner.png", [0.75, 0.1, -0.1, 0.75, 930, 310]);
  quad("still.png", [1, 0, 0, 1, 1200, 50]);
  const order: Array<[string, number, number, number, string | null]> = [
    ["holder", 0, 3, 0, null], ["iconA", 1, 2, 1, "holder"], ["iconB", 2, 3, 1, "holder"],
    ["orb", 3, 4, 0, null], ["staticA", 4, 5, 0, null], ["staticB", 5, 6, 0, null],
    ["label", 6, 7, 0, null], ["outer", 7, 9, 0, null], ["inner", 8, 9, 1, "outer"], ["still", 9, 10, 0, null],
  ];
  const entries = new Map<string, PaintOrderEntry>(order.map(([id, spanStart, spanEnd, depth, parentId], index) =>
    [id, { id, order: index, spanStart, spanEnd, depth, parentId } as PaintOrderEntry]));
  const ranges = new Map(order.map(([id], index) => [id, { start: index, paintEnd: index + 1 }]));
  const timing = (originMs: number, phaseMs: number, periodMs: number): LoopTiming => ({ originMs, phaseMs, periodMs });
  const builtAt = 5_432.1;
  const roots: Root[] = [
    { id: "holder", plan: idleAnimPlanFor(binding("bob", { amplitudePx: 10, baselineUpPx: 8 }), box), timing: timing(1_000.25, 701.3, 2000), frame: null! },
    { id: "orb", plan: idleAnimPlanFor(binding("rotate"), box, { x: 21.5, y: 19.25 }), timing: timing(0, 0, 7000), frame: null! },
    { id: "label", plan: idleAnimPlanFor(binding("pivotPulse", { scaleFrom: 0.95, scaleTo: 1.08 }), box), timing: timing(250, 1234.5, 1500), frame: null! },
    { id: "outer", plan: idleAnimPlanFor(binding("rock", { amplitudeRad: 0.12 }), box), timing: timing(3.75, 17, 2600), frame: null! },
    { id: "inner", plan: idleAnimPlanFor(binding("pulseScaleFade", { scaleFrom: 0.8, scaleTo: 1.3 }), box), timing: timing(99, 0, 1800), frame: null! },
    { id: "still", plan: null, timing: timing(0, 0, 1000), frame: null! },
  ];
  const placements: Record<string, [Affine, Affine | null, Affine, number]> = {
    holder: [[2.4, 0, 0, 2.4, 100.5, 220.25], [1, 0, 0, 1, 31.7, -12.9], [1, 0, 0, 1, 0.5, 0], 0],
    orb: [[2.4, 0, 0, 2.4, 300, 10], [1, 0, 0, 1, 5, 5], [1, 0, 0, 1, 0, 0], 0],
    label: [[1.1, 0.05, -0.05, 1.1, 640, 70], null, [1, 0, 0, 1, 0, -1.5], 0],
    outer: [[2, 0, 0, 2, 800, 260], [1, 0, 0, 1, 12, 7], [1.02, 0, 0, 1.02, -3, 0], 4],
    inner: [[2, 0.1, -0.1, 2, 830, 280], [0.9, 0, 0, 0.9, 6.5, 2.25], [1.02, 0, 0, 1.02, -3, 0], 7.5],
    still: [[1, 0, 0, 1, 1180, 40], [1, 0, 0, 1, 20, 10], [1, 0, 0, 1, 0, 0], 0],
  };
  for (const root of roots) {
    const [base, wire, outer, spreadDx] = placements[root.id];
    root.frame = frameFor(base, wire, outer, spreadDx, root.plan, root.timing, builtAt);
  }
  const build = { ranges, order: { ids: order.map(([id]) => id), entries }, hitEntries: [], nodePaintInputs: new Map(),
    localAnimFrames: new Map(roots.map((root) => [root.id, root.frame])) } as unknown as DrawListBuild;
  const texts = [
    { key: "dmg", insertionIndex: 2, transform: [0.9, 0, 0, 0.9, 40.25, 6.5], text: "12", style: {} },
    { key: "lbl", insertionIndex: 6, transform: [1.1, 0.05, -0.05, 1.1, 702.5, 99.75], text: "x2", style: {} },
  ] as unknown as PixiTextRecord[];
  const owners = new Map([["dmg", "iconB"], ["lbl", "label"]]);
  const spread = new Map([["outer", 4], ["inner", 7.5]]);
  return { list, build, texts, owners, spread, roots };
}

/** The executor's patch encoding (`encodeRetainedPatch`): a quad takes the pose as `m`, a text as `localTransform`. */
function patchPathMatrices(scene: serializer.RustSceneSnapshot, revision: number,
  patch: NonNullable<ReturnType<RetainedPixiComposition["patch"]>>) {
  const indexes = gsw.rustSceneCommandIndex(scene);
  const toRustId = (id: string) => id.startsWith("text:") ? `t${id.slice(5)}` : id;
  const updates = patch.primitives.map((change) => {
    const id = toRustId(change.id), old = scene.commands[indexes.get(id)!];
    return old.kind === "rasterText" || old.kind === "glyphRun"
      ? { id, command: { ...old }, localTransform: change.transform! }
      : { id, command: { ...old, m: [...change.transform!] } };
  });
  const encoded = gsw.encodeRustRetainedPatch(scene, revision, updates, patch.groups.map(({ id, transform }) => ({ id, transform })))!;
  expect(encoded).not.toBeNull();
  const parsed = JSON.parse(new TextDecoder().decode(encoded.bytes)) as { updates: Array<{ id: string; command: { m: number[] } }> };
  return { encoded, byIndex: new Map(parsed.updates.map((update) => [indexes.get(update.id)!, update.command.m])) };
}

describe.skipIf(!available)("rustIdleInRust parity (Rust idleEvaluate vs the retained patch path)", () => {
  it("evaluates every target's command matrix bit for bit, across clocks and committed patches", () => {
    const { list, build, texts, owners, spread, roots } = fixture();
    const composition = createRetainedPixiComposition(list as DrawList<string>, build, texts, owners, spread);
    // The fixture exercises each mode: the holder and the orb are groups, the label, outer and inner are primitives.
    expect(composition.plan.groups.map(({ id }) => id).sort()).toEqual(["anim:holder", "anim:orb"]);
    const carriers = new Map<string, RustTextCarrier>(texts.map((record) => [record.key, {
      resource: { key: `text:${record.key}`, width: 20, height: 12 }, pixels: new Uint8Array(20 * 12 * 4), width: 20, height: 12,
      // A raster carrier sits at its record's transform plus padding: the inset the serializer must carry along.
      transform: affineMul(record.transform as Affine, [1, 0, 0, 1, -1.5, -2.25]),
    }]));
    let scene = gsw.encodeRustScene({ drawList: list, revision: 1, width: 1280, height: 720, designWidth: 2520, designHeight: 1080,
      resolveTexture: (texture) => ({ key: texture, width: 64, height: 64 }), texts,
      resolveText: (record) => carriers.get(record.key) ?? null, plan: composition.plan }).scene;
    const specs = new Map<string, IdleRootSpec>(roots.filter((root) => root.plan)
      .map((root) => [root.id, { plan: root.plan!, timing: root.timing }]));
    const animsAt = (at: number) => new Map([...specs].map(([id, spec]) => [id, sampleAt(spec.plan, spec.timing, at)]));
    let revision = 1, checked = 0;
    for (const commitAt of [6_000, 7_777.7, 12_345.67]) {
      const built = buildRustIdleSet({ plan: composition.idlePlan(), specs, scene,
        commandIndex: (id) => gsw.rustSceneCommandIndex(scene).get(id), toRustId: (id) => id.startsWith("text:") ? `t${id.slice(5)}` : id,
        queries: { groupMembers: gsw.rustRetainedGroupMembers!, textPlacement: gsw.rustRetainedTextPlacement! } });
      if ("refusal" in built) throw new Error(built.refusal);
      expect(new Set(built.set.targets.map(({ mode }) => mode))).toEqual(new Set(["group", "primitive", "text"]));
      const bytes = gsw.encodeRustIdleAnims!(built.set)!;
      for (const at of [commitAt, commitAt + 16.6, commitAt + 333.3, commitAt + 1_000.01, commitAt + 4_321.9, 1e7 + 0.5]) {
        const poses = wasm.idleEvaluate!(bytes, at);
        const { byIndex } = patchPathMatrices(scene, revision + 1, composition.patch(animsAt(at), undefined, { unfiltered: true })!);
        expect(new Set(byIndex.keys())).toEqual(new Set(built.set.targets.map(({ commandIndex }) => commandIndex)));
        built.set.targets.forEach((target, i) => {
          expect([...poses.subarray(i * 6, i * 6 + 6)], `command ${target.commandIndex} at ${at}`).toEqual(byIndex.get(target.commandIndex));
          checked++;
        });
      }
      // Commit a patch-path frame (filtered, as production does) and carry its scene: the next install reads the
      // serializer's rewritten text chains and the composition's committed poses.
      const patch = composition.patch(animsAt(commitAt + 50))!;
      const { encoded } = patchPathMatrices(scene, ++revision, patch);
      composition.commit(patch);
      scene = encoded.scene;
    }
    expect(checked).toBe(3 * 6 * 10);
  });
});
