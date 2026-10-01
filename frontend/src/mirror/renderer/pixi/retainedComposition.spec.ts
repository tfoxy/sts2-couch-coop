import { describe, expect, it, vi } from "vitest";
import { createClipRectView, createDrawList, createNinePatchView, createPolylineView, createQuadView, createTexturedMeshView,
  type DrawList } from "@godot-scene-web/canvas";
import type { PixiTextRecord } from "@godot-scene-web/canvas/pixi";
import type { DrawListBuild, LocalAnimFrame } from "@/mirror/canvas/buildDrawList";
import type { PaintOrderEntry } from "@/mirror/canvas/paintOrder";
import type { HitEntry } from "@/mirror/canvas/hitTest";
import { createRetainedPixiComposition, type RetainedPixiComposition, type RetainedPixiCompositionOptions } from "./retainedComposition";

const identity = (): [number, number, number, number, number, number] => [1, 0, 0, 1, 0, 0];
const frame = (): LocalAnimFrame => ({ drawn: identity(), outer: identity(), base: identity(), wire: identity(), spreadDx: 0, spreadRebased: false });

function fixture(nested: boolean) {
  const list = createDrawList<string>();
  const q = createQuadView(); q.w = q.h = q.srcW = q.srcH = 10;
  list.pushQuad(q, "first.png"); list.pushQuad(q, "second.png");
  const root: PaintOrderEntry = { id: "root", order: 0, spanStart: 0, spanEnd: 2, depth: 0, parentId: null };
  const child: PaintOrderEntry = { id: "child", order: 1, spanStart: 1, spanEnd: 2, depth: 1, parentId: "root" };
  const hit = { nodeId: "child", order: 1, mFinal: identity(), mGame: identity() } as HitEntry;
  const build = {
    ranges: new Map([["root", { start: 0, paintEnd: 1 }], ["child", { start: 1, paintEnd: 2 }]]),
    order: { ids: ["root", "child"], entries: new Map([["root", root], ["child", child]]) },
    localAnimFrames: new Map(nested ? [["root", frame()], ["child", frame()]] : [["root", frame()]]),
    hitEntries: [hit], nodePaintInputs: new Map(),
  } as unknown as DrawListBuild;
  return { list, build, hit };
}

function siblingFixture(count: number, animated: readonly number[], breaks: readonly number[] = [], filtered: readonly number[] = []) {
  const list = createDrawList<string>();
  const ranges = new Map<string, { start: number; paintEnd: number }>();
  const entries = new Map<string, PaintOrderEntry>();
  const frames = new Map<string, LocalAnimFrame>();
  const hits: HitEntry[] = [];
  for (let index = 0; index < count; index++) {
    const id = `node${index}`;
    const q = createQuadView(); q.w = q.h = q.srcW = q.srcH = 10;
    if (breaks.includes(index)) q.blend = 1;
    if (filtered.includes(index)) { q.hasColorMatrix = true; q.colorMatrix[0] = 0.5; }
    list.pushQuad(q, `${id}.png`);
    ranges.set(id, { start: index, paintEnd: index + 1 });
    entries.set(id, { id, order: index, spanStart: index, spanEnd: index + 1, depth: 0, parentId: null });
    if (animated.includes(index)) {
      frames.set(id, frame());
      hits.push({ nodeId: id, order: index, mFinal: identity(), mGame: identity() } as HitEntry);
    }
  }
  const build = { ranges, order: { ids: [...entries.keys()], entries }, localAnimFrames: frames,
    hitEntries: hits, nodePaintInputs: new Map() } as unknown as DrawListBuild;
  return { list, build, hits };
}

describe.each([false, true])("retained Pixi composition (lazy patch index %s)", (lazyPatchIndex) => {
  const create = (list: DrawList<string>, build: DrawListBuild, texts: readonly PixiTextRecord[],
    owners: ReadonlyMap<string, string>, spread: ReadonlyMap<string, number>, options: RetainedPixiCompositionOptions = {}) =>
    createRetainedPixiComposition(list, build, texts, owners, spread, { ...options, lazyPatchIndex, strictInputs: true });

  it("moves an eligible subtree through a render group from an absolute reference past 120 steps", () => {
    const { list, build, hit } = fixture(false);
    const retained = create(list, build, [], new Map(), new Map());
    expect(retained.plan.groups).toHaveLength(1);
    for (let step = 1; step <= 179; step++) {
      const patch = retained.patch(new Map([["root", { pre: [1, 0, 0, 1, step, 0], post: null }]]))!;
      expect(patch.primitives).toHaveLength(0);
      expect(patch.groups[0].transform[4]).toBe(step);
      expect(patch.hits.find((entry) => entry.entry === hit)?.matrix[4]).toBe(step);
      retained.commit(patch);
    }
    const unchanged = retained.patch(new Map([["root", { pre: [1, 0, 0, 1, 179, 0], post: null }]]))!;
    expect(unchanged.groups).toHaveLength(0);
    expect(unchanged.hits).toHaveLength(0);
    const stopped = retained.patch(new Map())!;
    expect(stopped.groups[0].transform[4]).toBe(0);
    expect(stopped.hits[0].matrix[4]).toBe(0);
    retained.commit(stopped);
    const restarted = retained.patch(new Map([["root", { pre: [1, 0, 0, 1, 7, 0], post: null }]]))!;
    expect(restarted.groups[0].transform[4]).toBe(7);
    expect(restarted.hits[0].matrix[4]).toBe(7);
  });

  it("composes simultaneous ancestor and child animation roots in ancestry order", () => {
    const { list, build, hit } = fixture(true);
    list.patchQuadTransform(1, [1, 0, 0, 1, 10, 0]);
    hit.mFinal = [1, 0, 0, 1, 10, 0];
    const retained = create(list, build, [], new Map(), new Map());
    expect(retained.plan.groups).toHaveLength(0);
    const patch = retained.patch(new Map([
      ["child", { pre: [1, 0, 0, 1, 3, 0], post: null }],
      ["root", { pre: null, post: [2, 0, 0, 2, 0, 0] }],
    ]))!;
    expect(patch.primitives.find((item) => item.id === "root:quad:0")?.transform).toEqual([2, 0, 0, 2, 0, 0]);
    expect(patch.primitives.find((item) => item.id === "child:quad:0")?.transform).toEqual([2, 0, 0, 2, 26, 0]);
    expect(patch.hits[0].matrix).toEqual([2, 0, 0, 2, 26, 0]);
    retained.commit(patch);
    const sourcePose = retained.sourceTransform("child:quad:0", [1, 0, 0, 1, 14, 0],
      patch.primitives.find((item) => item.id === "child:quad:0")?.transform);
    expect(sourcePose).toEqual([2, 0, 0, 2, 34, 0]);
    retained.commit({ primitives: [{ id: "child:quad:0", transform: sourcePose! }], groups: [], hits: [],
      nodeMatrices: [], sourceReferences: [{ id: "child:quad:0", matrix: [1, 0, 0, 1, 14, 0] }],
      movedRoots: 0, rootPoses: new Map() });
    const stopped = retained.patch(new Map())!;
    expect(stopped.primitives.find((item) => item.id === "child:quad:0")?.transform).toEqual([1, 0, 0, 1, 14, 0]);
  });

  it("ranks singleton groups by affected static siblings, segment edge, and painter index", () => {
    const { list, build } = siblingFixture(18, [0, 3, 7, 10, 13, 17], [8, 14]);
    const retained = create(list, build, [], new Map(), new Map());
    // The two separators split ordinary sprite batches. Segment 0..7 has
    // five static sprites; 9..13 has three, and 15..17 has two.
    expect(retained.plan.groups.map((group) => group.id)).toEqual([
      "anim:node0", "anim:node7", "anim:node3", "anim:node13",
    ]);
    expect(retained.plan.groups.every((group) => group.renderGroup && group.endIndex === group.firstIndex + 1)).toBe(true);
  });

  it("keeps singleton group poses absolute across long simultaneous motion, retry, and source replacement", () => {
    const { list, build, hits } = siblingFixture(4, [0, 3]);
    const retained = create(list, build, [], new Map(), new Map());
    expect(retained.plan.groups.map((group) => group.id)).toEqual(["anim:node0", "anim:node3"]);
    for (let step = 1; step <= 179; step++) {
      const anims = new Map([
        ["node0", { pre: [1, 0, 0, 1, step, 0], post: null }],
        ["node3", { pre: [1, 0, 0, 1, -step, 0], post: null }],
      ]);
      const patch = retained.patch(anims)!;
      expect(patch.primitives).toHaveLength(0);
      expect(patch.groups.map((group) => group.transform[4])).toEqual([step, -step]);
      expect(patch.hits.find((hit) => hit.entry === hits[0])?.matrix[4]).toBe(step);
      if (step === 90) {
        // A failed presentation never commits the speculative pose.
        expect(retained.patch(anims)!.groups).toEqual(patch.groups);
      }
      retained.commit(patch);
    }
    expect(retained.sourceTransform("node0:quad:0", [1, 0, 0, 1, 6, 0])).toEqual([1, 0, 0, 1, 6, 0]);
    retained.commit({ primitives: [{ id: "node0:quad:0", transform: [1, 0, 0, 1, 6, 0] }], groups: [], hits: [], nodeMatrices: [],
      sourceReferences: [{ id: "node0:quad:0", matrix: [1, 0, 0, 1, 6, 0] }],
      movedRoots: 0, rootPoses: new Map() });
    expect(retained.logicalMatrix("node0:quad:0")).toEqual([1, 0, 0, 1, 185, 0]);
    const stopped = retained.patch(new Map())!;
    expect(stopped.groups.map((group) => group.transform[4])).toEqual([0, 0]);
    expect(stopped.hits.map((hit) => hit.matrix[4])).toEqual([0, 0]);
  });

  it("leaves filtered sprites and text-separated singletons on the primitive path", () => {
    const { list, build } = siblingFixture(3, [0, 2], [], [2]);
    const text = { key: "between", insertionIndex: 1, transform: identity(), text: "between", style: {} } as PixiTextRecord;
    const retained = create(list, build, [text], new Map(), new Map());
    expect(retained.plan.groups).toHaveLength(0);
  });

  it("does not group a singleton across a spread boundary", () => {
    const { list, build } = siblingFixture(2, [0]);
    const retained = create(list, build, [], new Map(), new Map([["node1", 42]]));
    expect(retained.plan.groups).toHaveLength(0);
  });

  it("does not group a singleton that owns text at its sprite insertion index", () => {
    const { list, build } = siblingFixture(2, [0]);
    const text = { key: "own", insertionIndex: 0, transform: identity(), text: "own", style: {} } as PixiTextRecord;
    const retained = create(list, build, [text], new Map([["own", "node0"]]), new Map());
    expect(retained.plan.groups).toHaveLength(0);
  });

  it("does not group a singleton with static siblings inside an enclosing clip", () => {
    const list = createDrawList<string>();
    const clip = createClipRectView(); clip.w = clip.h = 20;
    const q = createQuadView(); q.w = q.h = q.srcW = q.srcH = 10;
    list.pushClipRect(clip);
    list.pushQuad(q, "moving.png");
    list.pushQuad(q, "static.png");
    list.popClip();
    const ids = ["moving", "static"];
    const entries = new Map(ids.map((id, order) => [id, {
      id, order, spanStart: order, spanEnd: order + 1, depth: 0, parentId: null,
    } satisfies PaintOrderEntry]));
    const build = {
      ranges: new Map([["moving", { start: 1, paintEnd: 2 }], ["static", { start: 2, paintEnd: 3 }]]),
      order: { ids, entries }, localAnimFrames: new Map([["moving", frame()]]),
      hitEntries: [], nodePaintInputs: new Map(),
    } as unknown as DrawListBuild;
    const retained = create(list, build, [], new Map(), new Map());
    expect(retained.plan.groups).toHaveLength(0);
  });

  it("omits only static pixel caches while keeping animated, text, spread, hit, and wire paths", async () => {
    const list = createDrawList<string>();
    const ids = ["staticRoot", "staticA", "staticB", "moving", "movingChild"];
    const ranges = new Map<string, { start: number; paintEnd: number }>();
    for (const [index, id] of ids.entries()) {
      const q = createQuadView(); q.w = q.h = q.srcW = q.srcH = 10;
      list.pushQuad(q, `${id}.png`);
      ranges.set(id, { start: index, paintEnd: index + 1 });
    }
    const entries = new Map(ids.map((id, order) => [id, {
      id, order, spanStart: order, spanEnd: order === 0 ? 3 : order === 3 ? 5 : order + 1,
      depth: order === 0 || order === 3 ? 0 : 1,
      parentId: order === 0 || order === 3 ? null : order < 3 ? "staticRoot" : "moving",
    } satisfies PaintOrderEntry]));
    const staticHit = { nodeId: "staticA", order: 1, mFinal: identity(), mGame: identity() } as HitEntry;
    const movingHit = { nodeId: "movingChild", order: 4, mFinal: identity(), mGame: identity() } as HitEntry;
    const build = { ranges, order: { ids, entries }, localAnimFrames: new Map([["moving", frame()]]),
      hitEntries: [staticHit, movingHit], nodePaintInputs: new Map() } as unknown as DrawListBuild;
    const texts = [
      { key: "staticLabel", insertionIndex: 2, transform: identity(), text: "label", style: {} },
      { key: "movingLabel", insertionIndex: 4, transform: identity(), text: "move", style: {} },
    ] as PixiTextRecord[];
    const textOwners = new Map([["staticLabel", "staticB"], ["movingLabel", "movingChild"]]);
    const spread = new Map([["staticRoot", 8], ["staticA", 8], ["staticB", 8]]);
    const originalTexts = texts.map((text) => ({ ...text }));
    const original = create(list, build, originalTexts, textOwners, spread);
    const omittedTexts = texts.map((text) => ({ ...text }));
    const marks: string[] = [];
    const omitted = create(list, build, omittedTexts, textOwners, spread,
      { includeStaticPixelCaches: false, onStaticAdmission: (edge) => marks.push(edge) });
    expect(marks).toEqual(["start", "end"]);
    expect(original.plan.groups.map((group) => group.id)).toContain("static:staticRoot");
    expect(omitted.plan.groups.map((group) => group.id)).toEqual(["anim:moving"]);
    expect(omitted.plan.primitives.map(({ id, index }) => [id, index]))
      .toEqual(original.plan.primitives.map(({ id, index }) => [id, index]));
    expect(omitted.plan.primitives.every((primitive) => !("parentId" in primitive) ||
      (primitive as { parentId?: string }).parentId === "anim:moving")).toBe(true);
    expect(omittedTexts[0]).not.toHaveProperty("parentId");
    expect(omittedTexts[1]).toHaveProperty("parentId", "anim:moving");
    const anims = new Map([["moving", { pre: [1, 0, 0, 1, 7, 0], post: null }]]);
    const originalAnim = original.patch(anims)!;
    const omittedAnim = omitted.patch(anims)!;
    expect(omittedAnim).toEqual(originalAnim);
    omitted.commit(omittedAnim); original.commit(originalAnim);
    const originalWire = original.patchWireTransform("staticRoot", [1, 0, 0, 1, 5, 0])!;
    const omittedWire = omitted.patchWireTransform("staticRoot", [1, 0, 0, 1, 5, 0])!;
    expect(omittedWire).toEqual(originalWire);
    expect(omittedWire.hits.find((hit) => hit.entry === staticHit)?.matrix[4]).toBe(5);
    expect(omittedWire.primitives.map((primitive) => primitive.id)).toContain("text:staticLabel");
    if (process.env.COUCHCOOP_GSW_ROOT) {
      const modulePath = `${process.env.COUCHCOOP_GSW_ROOT}/packages/canvas/src/rust-prototype-scene.ts`;
      const { encodeRustScene } = await vi.importActual<{
        encodeRustScene(input: unknown): { scene: { commands: Record<string, unknown>[] } };
      }>(modulePath);
      const encode = (plan: typeof original.plan, records: PixiTextRecord[]) => encodeRustScene({
        drawList: list, revision: 1, width: 100, height: 100, designWidth: 100, designHeight: 100,
        resolveTexture: (texture: string) => ({ key: texture, width: 10, height: 10 }),
        texts: records, resolveText: (record: PixiTextRecord) => ({
          resource: { key: record.key, width: 10, height: 10 }, pixels: new Uint8Array(400),
          width: 10, height: 10, transform: record.transform,
        }), plan,
      }).scene.commands;
      expect(encode(omitted.plan, omittedTexts)).toEqual(encode(original.plan, originalTexts));
    }
  });
});

type Inputs = {
  list: DrawList<string>; build: DrawListBuild; texts: PixiTextRecord[];
  owners: Map<string, string>; spread: Map<string, number>; options?: RetainedPixiCompositionOptions;
};

const textRecord = (key: string, insertionIndex: number, transform = identity()) =>
  ({ key, insertionIndex, transform, text: key, style: {} }) as PixiTextRecord;

function staticFixture(includeStaticPixelCaches: boolean): Inputs {
  const list = createDrawList<string>();
  const ids = ["staticRoot", "staticA", "staticB", "moving", "movingChild"];
  const ranges = new Map<string, { start: number; paintEnd: number }>();
  for (const [index, id] of ids.entries()) {
    const q = createQuadView(); q.w = q.h = q.srcW = q.srcH = 10;
    list.pushQuad(q, `${id}.png`);
    ranges.set(id, { start: index, paintEnd: index + 1 });
  }
  const entries = new Map(ids.map((id, order) => [id, {
    id, order, spanStart: order, spanEnd: order === 0 ? 3 : order === 3 ? 5 : order + 1,
    depth: order === 0 || order === 3 ? 0 : 1,
    parentId: order === 0 || order === 3 ? null : order < 3 ? "staticRoot" : "moving",
  } satisfies PaintOrderEntry]));
  const hits = [
    { nodeId: "staticA", order: 1, mFinal: identity(), mGame: identity() } as HitEntry,
    { nodeId: "movingChild", order: 4, mFinal: identity(), mGame: identity() } as HitEntry,
  ];
  const build = { ranges, order: { ids, entries }, localAnimFrames: new Map([["moving", frame()]]),
    hitEntries: hits, nodePaintInputs: new Map() } as unknown as DrawListBuild;
  return { list, build, texts: [textRecord("staticLabel", 2), textRecord("movingLabel", 4)],
    owners: new Map([["staticLabel", "staticB"], ["movingLabel", "movingChild"]]),
    spread: new Map([["staticRoot", 8], ["staticA", 8], ["staticB", 8]]), options: { includeStaticPixelCaches } };
}

function clipFixture(): Inputs {
  const list = createDrawList<string>();
  const clip = createClipRectView(); clip.w = clip.h = 20;
  const q = createQuadView(); q.w = q.h = q.srcW = q.srcH = 10;
  list.pushClipRect(clip); list.pushQuad(q, "moving.png"); list.pushQuad(q, "static.png"); list.popClip();
  const ids = ["moving", "static"];
  const entries = new Map(ids.map((id, order) => [id, {
    id, order, spanStart: order, spanEnd: order + 1, depth: 0, parentId: null,
  } satisfies PaintOrderEntry]));
  const build = { ranges: new Map([["moving", { start: 1, paintEnd: 2 }], ["static", { start: 2, paintEnd: 3 }]]),
    order: { ids, entries }, localAnimFrames: new Map([["moving", frame()]]),
    hitEntries: [{ nodeId: "moving", order: 0, mFinal: identity(), mGame: identity() } as HitEntry],
    nodePaintInputs: new Map() } as unknown as DrawListBuild;
  return { list, build, texts: [], owners: new Map(), spread: new Map() };
}

/** Every reference kind (nine-patch, polyline, textured mesh, quad, text) under one animated panel. */
function mixedFixture(split: boolean): Inputs {
  const list = createDrawList<string>();
  const nine = createNinePatchView(); nine.w = nine.h = nine.srcW = nine.srcH = 30; nine.m.set([1, 0, 0, 1, 2, 3]);
  list.pushNinePatch(nine, "panel.png");
  const line = createPolylineView(); line.pointCount = 2; line.points.set([0, 0, 10, 10]);
  list.pushPolyline(line);
  const mesh = createTexturedMeshView(); mesh.m.set([1, 0, 0, 1, 7, 3]); mesh.vertexCount = 3; mesh.indexCount = 3;
  mesh.positions.set([0, 0, 1, 0, 0, 1]); mesh.uvs.set([0, 0, 1, 0, 0, 1]); mesh.indices.set([0, 1, 2]);
  list.pushTexturedMesh(mesh, "mesh.png");
  const sprite = createQuadView(); sprite.w = sprite.h = sprite.srcW = sprite.srcH = 10; sprite.m.set([0.5, 0, 0, 0.5, 20, 10]);
  list.pushQuad(sprite, "sprite.png");
  const loose = createQuadView(); loose.w = loose.h = loose.srcW = loose.srcH = 4;
  list.pushQuad(loose, "unowned.png");
  const other = createQuadView(); other.w = other.h = other.srcW = other.srcH = 12; other.m.set([1, 0, 0, 1, 100, 0]);
  list.pushQuad(other, "other.png");
  const ids = ["panel", "line", "mesh", "sprite", "other"];
  const entries = new Map<string, PaintOrderEntry>([
    ["panel", { id: "panel", order: 0, spanStart: 0, spanEnd: 4, depth: 0, parentId: null }],
    ["line", { id: "line", order: 1, spanStart: 1, spanEnd: 2, depth: 1, parentId: "panel" }],
    ["mesh", { id: "mesh", order: 2, spanStart: 2, spanEnd: 3, depth: 1, parentId: "panel" }],
    ["sprite", { id: "sprite", order: 3, spanStart: 3, spanEnd: 4, depth: 1, parentId: "panel" }],
    ["other", { id: "other", order: 4, spanStart: 4, spanEnd: 5, depth: 0, parentId: null }],
  ]);
  const ranges = new Map([["panel", { start: 0, paintEnd: 1 }], ["line", { start: 1, paintEnd: 2 }],
    ["mesh", { start: 2, paintEnd: 3 }], ["sprite", { start: 3, paintEnd: 4 }], ["other", { start: 5, paintEnd: 6 }]]);
  const frames = new Map([["panel", frame()], ["other", frame()]]);
  if (split) frames.set("sprite", frame());
  const hits = [
    { nodeId: "sprite", order: 3, mFinal: [0.5, 0, 0, 0.5, 20, 10], mGame: [0.5, 0, 0, 0.5, 20, 10] } as HitEntry,
    { nodeId: "other", order: 4, mFinal: [1, 0, 0, 1, 100, 0], mGame: identity() } as HitEntry,
  ];
  const nodePaintInputs = new Map(ids.map((id, index) => [id, { global: [1, 0, 0, 1, index, 0] }]));
  const build = { ranges, order: { ids, entries }, localAnimFrames: frames, hitEntries: hits,
    nodePaintInputs } as unknown as DrawListBuild;
  return { list, build, texts: [textRecord("meshLabel", 3, [1, 0, 0, 1, 2, 2]), textRecord("orphan", 6)],
    owners: new Map([["meshLabel", "mesh"]]), spread: split ? new Map([["line", 5]]) : new Map() };
}

const sibling = (count: number, animated: readonly number[], breaks: readonly number[] = [], filtered: readonly number[] = []) => {
  const { list, build } = siblingFixture(count, animated, breaks, filtered);
  return { list, build, texts: [] as PixiTextRecord[], owners: new Map<string, string>(), spread: new Map<string, number>() };
};

const equivalenceFixtures: Array<[string, () => Inputs]> = [
  ["one animated root", () => ({ ...fixture(false), texts: [], owners: new Map(), spread: new Map() })],
  ["nested animated roots", () => {
    const { list, build, hit } = fixture(true);
    list.patchQuadTransform(1, [1, 0, 0, 1, 10, 0]);
    hit.mFinal = [1, 0, 0, 1, 10, 0];
    return { list, build, texts: [], owners: new Map(), spread: new Map() };
  }],
  ["ranked singletons", () => sibling(18, [0, 3, 7, 10, 13, 17], [8, 14])],
  ["singleton pair", () => sibling(4, [0, 3])],
  ["filtered and text-separated", () => ({ ...sibling(3, [0, 2], [], [2]), texts: [textRecord("between", 1)] })],
  ["spread boundary", () => ({ ...sibling(2, [0]), spread: new Map([["node1", 42]]) })],
  ["owned text at the sprite", () => ({ ...sibling(2, [0]), texts: [textRecord("own", 0)], owners: new Map([["own", "node0"]]) })],
  ["enclosing clip", clipFixture],
  ["static pixel caches", () => staticFixture(true)],
  ["static pixel caches omitted", () => staticFixture(false)],
  ["mixed kinds in one group", () => mixedFixture(false)],
  ["mixed kinds across a spread split", () => mixedFixture(true)],
];

/** One fixed call sequence over every composition method; returns every answer in order. */
function exercise(retained: RetainedPixiComposition, inputs: Inputs): unknown[] {
  const out: unknown[] = [];
  const primitiveIds = [...retained.plan.primitives.map(({ id }) => id), ...inputs.texts.map(({ key }) => `text:${key}`), "missing"];
  const nodeIds = [...inputs.build.order.ids, "missing"];
  const read = () => {
    for (const id of primitiveIds) out.push(retained.logicalMatrix(id));
    for (const id of nodeIds) out.push(retained.logicalNodeMatrix(id, [1, 0, 0, 1, id.length, 2]));
    for (const id of primitiveIds) out.push(retained.sourceTransform(id, [1, 0, 0, 1, 3, 1]),
      retained.sourceTransform(id, [2, 0, 0, 2, 0, 0], [1, 0, 0, 1, 5, 5]));
  };
  read();
  const roots = [...inputs.build.localAnimFrames.keys()];
  for (let step = 1; step <= 6; step++) {
    const anims = new Map(roots.map((id, index) => [id, {
      pre: [1, 0, 0, 1, step * (index + 1), -step], post: index % 2 === 0 ? [1.25, 0, 0, 1.25, 0, 0] : null }]));
    const patch = retained.patch(anims);
    out.push(patch);
    // Step 3 stands in for a refused presentation: the speculative pose is never committed.
    if (patch && step !== 3) retained.commit(patch);
  }
  out.push(retained.patch(new Map([["not-animated", { pre: null, post: null }]])));
  read();
  for (const id of nodeIds) {
    const wire = retained.patchWireTransform(id, [1, 0, 0, 1, 4, -2]);
    out.push(wire);
    if (wire) retained.commit(wire);
  }
  retained.commit({ primitives: [{ id: primitiveIds[0], transform: [1, 0, 0, 1, 9, 9] }], groups: [], hits: [],
    nodeMatrices: [{ id: nodeIds[0], matrix: [1, 0, 0, 1, 1, 1] }],
    sourceReferences: [{ id: primitiveIds[0], matrix: [1, 0, 0, 1, 6, 0] }], movedRoots: 0, rootPoses: new Map() });
  read();
  const stopped = retained.patch(new Map());
  out.push(stopped);
  if (stopped) retained.commit(stopped);
  read();
  return out;
}

describe("lazy retained composition index", () => {
  it.each(equivalenceFixtures)("matches the eager composition for %s", (_name, make) => {
    const eagerInputs = make(), lazyInputs = make(), verifiedInputs = make();
    const create = (inputs: Inputs, options: RetainedPixiCompositionOptions) => createRetainedPixiComposition(
      inputs.list, inputs.build, inputs.texts, inputs.owners, inputs.spread, { ...inputs.options, ...options });
    let indexBuilds = 0;
    const mismatches: string[] = [];
    const eager = create(eagerInputs, {});
    const lazy = create(lazyInputs, { lazyPatchIndex: true, strictInputs: true, onPatchIndex: () => indexBuilds++ });
    const verified = create(verifiedInputs, { lazyPatchIndex: true,
      verify: { onMismatch: (method, detail) => mismatches.push(`${method}: ${detail}`) } });
    // The plan stays eager: same primitives, groups and parents, and the same parents stamped on the texts.
    expect(lazy.plan).toEqual(eager.plan);
    expect(verified.plan).toEqual(eager.plan);
    expect(lazyInputs.texts).toEqual(eagerInputs.texts);
    expect(verifiedInputs.texts).toEqual(eagerInputs.texts);
    expect(indexBuilds).toBe(0);
    const expected = exercise(eager, eagerInputs);
    expect(exercise(lazy, lazyInputs)).toEqual(expected);
    expect(exercise(verified, verifiedInputs)).toEqual(expected);
    expect(indexBuilds).toBe(1);
    expect(mismatches).toEqual([]);
  });

  it("refuses, or throws when strict, once its inputs moved before first use", () => {
    let generation = 1;
    const strictInputs = mixedFixture(false);
    const strict = createRetainedPixiComposition(strictInputs.list, strictInputs.build, strictInputs.texts,
      strictInputs.owners, strictInputs.spread, { lazyPatchIndex: true, strictInputs: true });
    strictInputs.list.reset();
    expect(() => strict.patch(new Map())).toThrow(/inputs changed before its patch index was built/);
    expect(() => strict.logicalMatrix("panel:ninePatch:0")).toThrow(/inputs changed/);

    const inputs = mixedFixture(false);
    const refusing = createRetainedPixiComposition(inputs.list, inputs.build, inputs.texts, inputs.owners, inputs.spread,
      { lazyPatchIndex: true, inputGeneration: () => generation });
    generation++;
    expect(refusing.patch(new Map())).toBeNull();
    expect(refusing.patchWireTransform("other", [1, 0, 0, 1, 1, 0])).toBeNull();
    expect(refusing.logicalMatrix("panel:ninePatch:0")).toBeUndefined();
    expect(refusing.sourceTransform("sprite:quad:0", identity())).toBeNull();
    expect(() => refusing.commit({ primitives: [], groups: [], hits: [], nodeMatrices: [], sourceReferences: [],
      movedRoots: 0, rootPoses: new Map() })).not.toThrow();
    // The stale state is permanent even if the counter returns to the admitted value.
    generation--;
    expect(refusing.patch(new Map())).toBeNull();

    const textInputs = mixedFixture(false);
    const textChecked = createRetainedPixiComposition(textInputs.list, textInputs.build, textInputs.texts,
      textInputs.owners, textInputs.spread, { lazyPatchIndex: true, strictInputs: true });
    textInputs.texts.length = 0;
    expect(() => textChecked.patch(new Map())).toThrow(/inputs changed/);
  });

  it("keeps a built index across a later producer reset, so an in-flight patch can still commit", () => {
    let generation = 1;
    const inputs = mixedFixture(false);
    const retained = createRetainedPixiComposition(inputs.list, inputs.build, inputs.texts, inputs.owners, inputs.spread,
      { lazyPatchIndex: true, strictInputs: true, inputGeneration: () => generation });
    const patch = retained.patch(new Map([["other", { pre: [1, 0, 0, 1, 5, 0], post: null }]]))!;
    expect(patch.hits.map(({ matrix }) => matrix[4])).toEqual([105]);
    generation++;
    inputs.list.reset();
    expect(() => retained.commit(patch)).not.toThrow();
    expect(retained.logicalMatrix("other:quad:0")).toEqual([1, 0, 0, 1, 105, 0]);
  });

  it("reports a verify mismatch and answers from the eager twin", () => {
    const inputs = mixedFixture(true);
    const reference = mixedFixture(true);
    const mismatches: string[] = [];
    const verified = createRetainedPixiComposition(inputs.list, inputs.build, inputs.texts, inputs.owners, inputs.spread,
      { lazyPatchIndex: true, verify: { onMismatch: (method, detail) => mismatches.push(`${method}: ${detail}`) } });
    const eager = createRetainedPixiComposition(reference.list, reference.build, reference.texts, reference.owners,
      reference.spread);
    const anims = new Map([["panel", { pre: [1, 0, 0, 1, 3, 0], post: null }]]);
    // Moving a command after admission is exactly what the lazy twin must notice; the eager twin read it earlier.
    inputs.list.patchQuadTransform(3, [1, 0, 0, 1, 50, 50]);
    expect(verified.patch(anims)).toEqual(eager.patch(anims));
    expect(mismatches).toEqual(["patch: lazy result differs from the eager result"]);
    const lateInputs = mixedFixture(true);
    const late = createRetainedPixiComposition(lateInputs.list, lateInputs.build, lateInputs.texts, lateInputs.owners,
      lateInputs.spread, { lazyPatchIndex: true, verify: { onMismatch: (method, detail) => mismatches.push(`${method}: ${detail}`) } });
    lateInputs.list.pushQuad(createQuadView(), "late.png");
    expect(late.patch(new Map())).not.toBeNull();
    expect(mismatches.at(-1)).toMatch(/^patch: retained composition inputs changed/);
  });
});
