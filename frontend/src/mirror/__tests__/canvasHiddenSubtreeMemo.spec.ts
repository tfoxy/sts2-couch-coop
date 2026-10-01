// THE HIDDEN-SUBTREE MEMO is exact: a builder that replays recorded hidden subtrees produces the build a full walk
// produces — every command, every map in its insertion order, every stamp, every semantic call — on every change
// the memo has to notice. Each case here builds the same state twice, memo off and memo on (the memo persisting
// across builds), and compares the two outputs whole; the counters then say the memo actually answered.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { createDrawList, type DrawList } from "@godot-scene-web/canvas";

import type { Affine } from "@/mirror/affine";
import {
  buildDrawList,
  type AlphaOverride,
  type BuildDrawListOptions,
  type CapturedGlobal,
  type CosmeticOffset,
  type DrawListBuild,
  type LocalAnim
} from "@/mirror/canvas/buildDrawList";
import { createHiddenSubtreeMemo, type HiddenSubtreeMemo } from "@/mirror/canvas/hiddenSubtreeMemo";
import { createHitMemo, resolveSceneInfo } from "@/mirror/canvas/hitTest";
import { createPaintOrderCache, type PaintOrderCache } from "@/mirror/canvas/paintOrder";
import type { NodeClass, NodePaintInput } from "@/mirror/canvas/paintSpec";
import { scanEagerScrollIds, type EagerScrollLayoutEnv } from "@/mirror/eagerScrollLayout";
import { HAND_HOLDER_TYPE } from "@/mirror/raise/constants";
import {
  applySceneDelta,
  createMirrorState,
  nodeTypeLeaf,
  parseSceneDelta,
  type MirrorDelta,
  type MirrorNode,
  type MirrorState
} from "@/mirror/sceneTree";
import type { ViewScaleEnv } from "@/mirror/viewScaleLayout";

// --- fixtures --------------------------------------------------------------------------------------------------

function mkNode(id: string, parentId: string | null, over: Partial<MirrorNode> = {}): MirrorNode {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Godot.Control",
    showBehindParent: false,
    clipChildren: 0,
    clipContents: false,
    ninePatchMargins: null,
    font: null,
    richBoldFont: null,
    richItalicFont: null,
    richBoldItalicFont: null,
    richBoldFontSizePx: null,
    richItalicFontSizePx: null,
    richBoldItalicFontSizePx: null,
    richBoldFontSpacingPx: null,
    richItalicFontSpacingPx: null,
    richBoldItalicFontSpacingPx: null,
    textWrap: null,
    shadow: null,
    richText: false,
    shaderId: null,
    materialRef: null,
    shaderParams: null,
    textureStretchMode: null,
    textureFlipH: false,
    textureFlipV: false,
    particleSpec: null,
    particleEmitting: false,
    particleRestartEpoch: 0,
    spineSceneResPath: null,
    spineNodePath: null,
    spineAnimations: null,
    spineSkelResPath: null,
    sceneFilePath: null,
    mouseFilter: null,
    anchorLeft: null,
    anchorRight: null,
    anchorOwnerId: null,
    containerLayout: null,
    contentKey: null,
    spineCurrentAnim: null,
    spineSkin: null,
    spineMat: null,
    spinePaused: false,
    spineTrackTime: 0,
    spineLooping: true,
    pinnedLoopAnim: null,
    outline: null,
    transform: [1, 0, 0, 1, 0, 0],
    localRect: { x: 0, y: 0, width: 100, height: 100 },
    visible: true,
    focused: false,
    opacity: 1,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    pivotX: 0,
    pivotY: 0,
    zIndex: null,
    textureUrl: null,
    textureRegion: null,
    textureMargin: null,
    ninePatch: false,
    modulate: null,
    selfModulate: null,
    fillColor: null,
    range: null,
    text: null,
    intentFrames: null,
    linePoints: null,
    lineWidth: null,
    lineColor: null,
    ...over
  };
}

const fill = (a = 1) => ({ r: 0.5, g: 0.25, b: 1, a, html: "#8040ff" });

/** Producer pre-order over a parent → children structure, the way the wire's `orderedIds` is built. */
function flatten(roots: readonly string[], kids: ReadonlyMap<string, readonly string[]>): string[] {
  const out: string[] = [];
  const walk = (id: string): void => {
    out.push(id);
    for (const kid of kids.get(id) ?? []) walk(kid);
  };
  for (const root of roots) walk(root);
  return out;
}

function delta(upserts: MirrorNode[], removedIds: string[] = [], orderedIds: string[] | null = null, full = false): MirrorDelta {
  return { full, screenType: "combat", upserts, removedIds, orderedIds, orderPatch: null, hints: [], cardFlights: [] };
}

// --- the comparison ----------------------------------------------------------------------------------------------

const tokens = new WeakMap<object, string>();
let tokenSerial = 0;
/** Object IDENTITY as a comparable value: two builds that hand out different node objects must not compare equal. */
function tokenOf(value: object): string {
  let token = tokens.get(value);
  if (token === undefined) {
    token = `#${++tokenSerial}`;
    tokens.set(value, token);
  }
  return token;
}

function isMirrorNode(value: object): boolean {
  return "nodeType" in value && "parentId" in value && "localRect" in value;
}

/** Plain, order-preserving data: maps and sets become entry arrays, nodes and the node map become identities. */
function plain(value: unknown, state: MirrorState): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "function" ? "fn" : value;
  }
  if (value === state.nodes) return "state.nodes";
  if (value instanceof Map) return [...value].map(([k, v]) => [plain(k, state), plain(v, state)]);
  if (value instanceof Set) return [...value].map((v) => plain(v, state));
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  if (Array.isArray(value)) return value.map((v) => plain(v, state));
  if (isMirrorNode(value)) return tokenOf(value);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) out[key] = plain((value as Record<string, unknown>)[key], state);
  return out;
}

/** The command table; the payload buffers are compared byte for byte in `buildAll`. */
function listRows(list: DrawList<string>): unknown {
  const commands: unknown[] = [];
  for (let i = 0; i < list.count; i++) {
    commands.push([list.kindAt(i), list.textureAt(i), list.floatOffsetAt(i), list.intOffsetAt(i)]);
  }
  return { count: list.count, clipDepth: list.clipDepth, maxClipDepth: list.maxClipDepth, commands };
}

function sameBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

interface Run {
  build: DrawListBuild;
  list: DrawList<string>;
  /** The `captureGlobals` output, when the options asked for one. */
  capture: Map<string, CapturedGlobal> | null;
  /** Everything the build published, as plain data (null when the run was not collected). */
  data: unknown;
}

interface Builder {
  memo: HiddenSubtreeMemo | null;
  cache: PaintOrderCache | null;
  /** `compare: false` builds without collecting the plain data (`data` is then null). */
  run(state: MirrorState, options: BuildDrawListOptions, compare?: boolean): Run;
}

function mkBuilder(memo: HiddenSubtreeMemo | null, opts: { reuse?: boolean; verify?: boolean } = {}): Builder {
  const list = createDrawList<string>();
  const cache = opts.reuse ? createPaintOrderCache() : null;
  const hitMemo = createHitMemo();
  return {
    memo,
    cache,
    run(state, options, compare = true) {
      if (cache !== null) {
        if (state.sceneRewrite) cache.invalidateAll();
        cache.noteChanged(state, state.changedIds);
      }
      const semantic: unknown[] = [];
      const visited: unknown[] = [];
      const capture = options.captureGlobals
        ? { ids: options.captureGlobals.ids, out: new Map<string, CapturedGlobal>() }
        : null;
      const build = buildDrawList(state, list, {
        ...options,
        captureGlobals: capture,
        paintOrderCache: cache ?? undefined,
        structureReuse: opts.reuse === true,
        hitMemo,
        hiddenSubtreeMemo: memo,
        hiddenSubtreeMemoVerify: opts.verify === true,
        assert: true,
        semanticNode: compare
          ? (input: NodePaintInput, cls: NodeClass, start: number, end: number) =>
              semantic.push([cls, start, end, plain(input, state)])
          : undefined,
        onNode: compare ? (id: string, cls: NodeClass) => visited.push([id, cls]) : undefined
      });
      if (!compare) return { build, list, capture: capture?.out ?? null, data: null };
      const { order, ...rest } = build;
      const data = plain(
        {
          ...rest,
          order: { ids: order.ids, entries: order.entries, rootIds: order.rootIds },
          capture: capture?.out ?? null,
          list: listRows(list),
          semantic,
          visited
        },
        state
      );
      return { build, list, capture: capture?.out ?? null, data };
    }
  };
}

/** Build `state` on every builder and require all of them to equal the first (the memo-free reference). */
function buildAll(builders: readonly Builder[], state: MirrorState, options: BuildDrawListOptions = {}, compare = true): Run[] {
  const runs = builders.map((b) => b.run(state, options, compare));
  if (compare) {
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i].data).toStrictEqual(runs[0].data);
      expect(sameBytes(runs[i].list.floats, runs[0].list.floats)).toBe(true);
      expect(sameBytes(runs[i].list.ints, runs[0].list.ints)).toBe(true);
      expect(sameBytes(runs[i].list.colorMatrices, runs[0].list.colorMatrices)).toBe(true);
    }
  }
  state.changedIds.clear();
  state.sceneRewrite = false;
  return runs;
}

function stateOf(nodes: MirrorNode[], order: string[] = nodes.map((n) => n.id)): MirrorState {
  const state = createMirrorState();
  applySceneDelta(state, delta(nodes, [], order, true));
  return state;
}

function viewScaleEnvFor(state: MirrorState, on: () => boolean = () => true): ViewScaleEnv {
  return { enabled: on, sceneOf: (id) => resolveSceneInfo(id, state.nodes) };
}

// A hidden subtree with structure worth recording: nesting, a behind-parent child (so pre-order and paint order
// differ), a VISIBLE card-reward group under the hidden root (so a hidden subtree publishes a view-scale stamp),
// beside a visible painted sibling and an orphan root.
function scene(): MirrorNode[] {
  return [
    mkNode("root", null, { transform: [1, 0, 0, 1, 10, 20] }),
    mkNode("panel", "root", { fillColor: fill(), transform: [1, 0, 0, 1, 5, 5] }),
    mkNode("H", "root", { visible: false, transform: [2, 0, 0, 2, 30, 40], modulate: fill(0.5) }),
    mkNode("h1", "H", { fillColor: fill(), transform: [1, 0, 0, 1, 1, 2] }),
    mkNode("h1a", "h1", { fillColor: fill(), showBehindParent: true }),
    mkNode("h1b", "h1", { fillColor: fill(), zIndex: 3 }),
    mkNode("h1c", "h1", { fillColor: fill(), zIndex: -1 }),
    mkNode("h2", "H", { nodeType: "Test.NCardRewardSelectionScreen", localRect: { x: 0, y: 0, width: 400, height: 300 } }),
    mkNode("h2a", "h2", { fillColor: fill(), clipContents: true }),
    mkNode("tail", "root", { fillColor: fill(), transform: [1, 0, 0, 1, 50, 60] }),
    mkNode("orphan", "ghost", { fillColor: fill(), transform: [1, 0, 0, 1, 7, 7] }),
    mkNode("orphanKid", "orphan", { fillColor: fill() })
  ];
}

function replace(state: MirrorState, id: string, over: Partial<MirrorNode>, orderedIds: string[] | null = null): void {
  applySceneDelta(state, delta([{ ...state.nodes.get(id)!, ...over }], [], orderedIds));
}

// --- cases -------------------------------------------------------------------------------------------------------

describe("hidden-subtree memo", () => {
  const setup = () => {
    const state = stateOf(scene());
    const memo = createHiddenSubtreeMemo();
    const builders = [mkBuilder(null), mkBuilder(memo), mkBuilder(createHiddenSubtreeMemo(), { reuse: true })];
    const options: BuildDrawListOptions = { viewScaleEnv: viewScaleEnvFor(state) };
    return { state, memo, builders, options };
  };

  it("replays an unchanged rebuild, including a stamp published under the hidden root", () => {
    const { state, memo, builders, options } = setup();
    const [first] = buildAll(builders, state, options);
    expect(first.build.viewScaleStamps.has("h2")).toBe(true);
    expect([...first.build.nodePaintInputs.keys()].indexOf("h1")).toBeLessThan(
      [...first.build.nodePaintInputs.keys()].indexOf("h1a")
    );
    expect(memo.stats.recorded).toBe(2); // H and the orphan
    buildAll(builders, state, options);
    buildAll(builders, state, options);
    expect(memo.stats.hits).toBe(4);
    expect(memo.stats.replayedNodes).toBe(2 * (7 + 2));
    expect(memo.stats.misses).toBe(2); // the first build's two absent entries
    expect(memo.stats.entries).toBe(2);
  });

  it("misses when a descendant object is replaced, even with identical fields", () => {
    const { state, memo, builders, options } = setup();
    buildAll(builders, state, options);
    replace(state, "h1b", {});
    buildAll(builders, state, options);
    expect(memo.stats.missReasons.node).toBe(1);
    replace(state, "h1b", { zIndex: -5 });
    buildAll(builders, state, options);
    buildAll(builders, state, options);
    expect(memo.stats.hits).toBeGreaterThanOrEqual(2);
  });

  it("walks a subtree that an override, a local anim, a capture or a substitute reaches into", () => {
    const { state, memo, builders, options } = setup();
    buildAll(builders, state, options);
    const cases: BuildDrawListOptions[] = [
      { transformOverrides: new Map([["h1a", [1, 0, 0, 1, 99, 99]]]) },
      { alphaOverrides: new Map<string, AlphaOverride>([["h2a", { mod: 0.25, self: null }]]) },
      { localAnims: new Map<string, LocalAnim>([["h1", { pre: [1, 0, 0, 1, 3, 4], post: null }]]) },
      { captureGlobals: { ids: new Set(["h1c"]), out: new Map() } },
      { cosmeticOffsets: new Map<string, CosmeticOffset>([["h2", { dx: 4, dy: -3 }]]) },
      { frameSubstitutes: new Map([["h1", { ...state.nodes.get("h1")!, textureUrl: "/sub.png" }]]) },
      { renderWidthOverrides: new Map([["h1b", 333]]) },
      { skipRoots: new Set(["h1"]) }
    ];
    for (const extra of cases) {
      const before = memo.stats.missReasons.tainted ?? 0;
      buildAll(builders, state, { ...options, ...extra });
      expect(memo.stats.missReasons.tainted).toBe(before + 1);
      buildAll(builders, state, options); // and the untainted recording is still good afterwards
    }
    expect(memo.stats.hits).toBeGreaterThan(cases.length);
  });

  it("misses on an ancestor's identity, transform, alpha or cosmetic offset, and on a view-scale product above it", () => {
    const { state, memo, builders, options } = setup();
    buildAll(builders, state, options);
    replace(state, "root", {});
    buildAll(builders, state, options);
    expect(memo.stats.missReasons.ancestor).toBe(1);
    // Each change leaves H's recording unusable, so only the orphan beside it is replayed. (H's misses read
    // `context` until the backoff stops re-recording it; from then on they read `absent`.)
    const changes: Array<() => BuildDrawListOptions> = [
      () => (replace(state, "root", { transform: [1, 0, 0, 1, 11, 20] }), options),
      () => ({ ...options, alphaOverrides: new Map([["root", { mod: 0.5, self: null }]]) }),
      () => ({ ...options, transformOverrides: new Map([["root", [1, 0, 0, 1, 0, 0]]]) }),
      () => ({ ...options, cosmeticOffsets: new Map([["root", { dx: 0, dy: 12 }]]) }),
      () => (replace(state, "root", { nodeType: "Test.NTreasureRoomRelicHolder" }), options)
    ];
    for (const change of changes) {
      const hits = memo.stats.hits;
      buildAll(builders, state, change());
      expect(memo.stats.hits).toBe(hits + 1);
    }
    expect(memo.stats.missReasons.context).toBeGreaterThanOrEqual(2);
  });

  it("follows an ancestor's scene identity into a stamp published under the hidden root", () => {
    // The event options container is matched by its path below the ancestor's scene file, through the hidden root.
    const state = stateOf([
      mkNode("layout", null, { sceneFilePath: "res://scenes/events/default_event_layout.tscn" }),
      mkNode("H", "layout", { visible: false }),
      mkNode("OptionsContainer", "H", { localRect: { x: 0, y: 0, width: 400, height: 200 } })
    ]);
    const memo = createHiddenSubtreeMemo();
    const builders = [mkBuilder(null), mkBuilder(memo)];
    const options = { viewScaleEnv: viewScaleEnvFor(state) };
    const [first] = buildAll(builders, state, options);
    expect(first.build.viewScaleStamps.has("OptionsContainer")).toBe(true);
    buildAll(builders, state, options);
    expect(memo.stats.hits).toBe(1);
    replace(state, "layout", { sceneFilePath: "res://scenes/events/another_layout.tscn" });
    const [moved] = buildAll(builders, state, options);
    expect(moved.build.viewScaleStamps.size).toBe(0);
    expect(memo.stats.missReasons.ancestor).toBe(1);
  });

  it("misses when the paint order shifts before the root, and when the span's ids change", () => {
    const { state, memo, builders, options } = setup();
    buildAll(builders, state, options);
    const order = state.orderedIds.slice();
    order.splice(order.indexOf("panel") + 1, 0, "early");
    applySceneDelta(state, delta([mkNode("early", "root", { fillColor: fill() })], [], order));
    buildAll(builders, state, options);
    expect(memo.stats.missReasons.span).toBe(2); // H and the orphan after it
    buildAll(builders, state, options);
    // A reorder inside the span keeps its start and length but not its ids.
    replace(state, "h1b", { zIndex: -9 });
    buildAll(builders, state, options);
    buildAll(builders, state, options);
    expect(memo.stats.hits).toBeGreaterThanOrEqual(2);
  });

  it("misses on a view-scale environment change, in both directions", () => {
    const { state, memo, builders, options } = setup();
    let on = true;
    const env = viewScaleEnvFor(state, () => on);
    buildAll(builders, state, { ...options, viewScaleEnv: env });
    on = false;
    const [off] = buildAll(builders, state, { ...options, viewScaleEnv: env });
    expect(off.build.viewScaleStamps.size).toBe(0);
    on = true;
    buildAll(builders, state, { ...options, viewScaleEnv: env });
    buildAll(builders, state, { ...options, viewScaleEnv: env });
    expect(memo.stats.missReasons.env).toBe(4); // two roots, two flips
    expect(memo.stats.hits).toBe(2);
  });

  it("re-roots an orphan whose parent appears, and treats a skipped root as gone", () => {
    const { state, memo, builders, options } = setup();
    buildAll(builders, state, options);
    applySceneDelta(state, delta([mkNode("ghost", null, { transform: [1, 0, 0, 1, 3, 3] })], [],
      ["ghost", "orphan", "orphanKid", ...state.orderedIds.filter((id) => id !== "orphan" && id !== "orphanKid")]));
    buildAll(builders, state, options);
    buildAll(builders, state, { ...options, skipRoots: new Set(["H"]) });
    expect(memo.stats.entries).toBe(0);
    buildAll(builders, state, options);
    buildAll(builders, state, options);
    expect(memo.stats.hits).toBe(1);
  });

  it("refuses to record a hover-tip set or a latched map stroke, and walks it every build", () => {
    const nodes = scene();
    nodes.push(
      mkNode("tip", "H", { nodeType: "Test.NHoverTipSet" }),
      mkNode("tipKid", "tip", { fillColor: fill() }),
      mkNode("map_line_1", "h2", { linePoints: [0, 0, 10, 10], lineWidth: 2, lineColor: fill(), transform: [1, 0, 0, 1, 2, 2] })
    );
    const state = stateOf(nodes);
    const memo = createHiddenSubtreeMemo();
    const pins = () => {
      const latched = new Map<string, Affine>();
      return { pin: (id: string, local: Affine) => latched.get(id) ?? (latched.set(id, local), local) };
    };
    const builders = [mkBuilder(null), mkBuilder(memo)];
    const tipScaleEnv = { enabled: () => true, hitTestAt: () => null, ownerBoxOf: () => null };
    const pinA = pins();
    const pinB = pins();
    for (let i = 0; i < 3; i++) {
      // Each builder latches on its own source, so both are fed the same history.
      const runs = [builders[0].run(state, { tipScaleEnv, pinnedLocals: pinA }), builders[1].run(state, { tipScaleEnv, pinnedLocals: pinB })];
      expect(runs[1].data).toStrictEqual(runs[0].data);
    }
    expect(memo.stats.notRecorded.tip).toBeGreaterThanOrEqual(1);
    expect(memo.stats.hits).toBe(3 - 1); // the orphan only
    for (let i = 0; i < 3; i++) {
      const runs = [builders[0].run(state, { pinnedLocals: pinA }), builders[1].run(state, { pinnedLocals: pinB })];
      expect(runs[1].data).toStrictEqual(runs[0].data);
    }
    expect(memo.stats.notRecorded.pin).toBeGreaterThanOrEqual(1);
  });

  it("verify mode walks every validated root and finds no difference", () => {
    const state = stateOf(scene());
    const memo = createHiddenSubtreeMemo();
    const builders = [mkBuilder(null), mkBuilder(memo, { verify: true })];
    const viewScaleEnv = viewScaleEnvFor(state);
    for (let i = 0; i < 4; i++) buildAll(builders, state, { viewScaleEnv });
    expect(memo.stats.verified).toBe(6);
    expect(memo.stats.verifyMismatches).toBe(0);
    expect(memo.stats.replayedNodes).toBe(0);
  });

  it("sits out a widened stage and the hidden-walk diagnostic without dropping its entries", () => {
    const { state, memo, builders, options } = setup();
    buildAll(builders, state, options);
    buildAll(builders, state, { ...options, spreadFactor: 1.3125, spreadDxOut: new Map() });
    buildAll(builders, state, { ...options, hiddenWalkDiagnostic: () => {} });
    expect(memo.stats.bypassedBuilds).toBe(2);
    buildAll(builders, state, options);
    expect(memo.stats.hits).toBe(2);
  });

  it("stays exact through a randomized delta and option sequence", () => {
    let seed = 0x5eed1;
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
    const kinds = ["Godot.Control", "Godot.Control", "Godot.Control", "Test.NCardRewardSelectionScreen", "Test.NTreasureRoomRelicHolder"];

    const roots: string[] = [];
    const kids = new Map<string, string[]>();
    let serial = 0;
    const fresh = (parentId: string | null): MirrorNode => mkNode(`n${serial++}`, parentId, {
      visible: rand() > 0.25,
      showBehindParent: rand() < 0.15,
      zIndex: rand() < 0.1 ? Math.floor(rand() * 5) - 2 : null,
      fillColor: rand() < 0.6 ? fill(rand()) : null,
      modulate: rand() < 0.2 ? fill(rand()) : null,
      clipContents: rand() < 0.1,
      nodeType: pick(kinds),
      transform: rand() < 0.1 ? null : [1 + rand(), 0, 0, 1 + rand(), rand() * 200, rand() * 200]
    });
    const initial: MirrorNode[] = [];
    for (let i = 0; i < 48; i++) {
      const parent = initial.length === 0 || rand() < 0.1 ? null : pick(initial).id;
      const node = fresh(parent);
      initial.push(node);
      if (parent === null) roots.push(node.id);
      else kids.set(parent, [...(kids.get(parent) ?? []), node.id]);
    }
    const state = stateOf(initial, flatten(roots, kids));
    const live = () => [...state.nodes.keys()];
    const subtree = (id: string): Set<string> => {
      const out = new Set<string>([id]);
      for (const kid of kids.get(id) ?? []) for (const d of subtree(kid)) out.add(d);
      return out;
    };
    const detach = (id: string) => {
      const parentId = state.nodes.get(id)?.parentId ?? null;
      if (parentId === null || !kids.has(parentId)) {
        const at = roots.indexOf(id);
        if (at >= 0) roots.splice(at, 1);
      }
      for (const [p, list] of kids) if (list.includes(id)) kids.set(p, list.filter((k) => k !== id));
    };

    const memo = createHiddenSubtreeMemo();
    const verifyMemo = createHiddenSubtreeMemo();
    const captureMemo = createHiddenSubtreeMemo({ captures: true });
    const captureVerifyMemo = createHiddenSubtreeMemo({ captures: true });
    const builders = [mkBuilder(null), mkBuilder(memo), mkBuilder(createHiddenSubtreeMemo(), { reuse: true }),
      mkBuilder(verifyMemo, { verify: true }), mkBuilder(captureMemo),
      mkBuilder(createHiddenSubtreeMemo({ captures: true }), { reuse: true }), mkBuilder(captureVerifyMemo, { verify: true })];
    let viewScaleOn = true;
    const viewScaleEnv = viewScaleEnvFor(state, () => viewScaleOn);
    // One override array is mutated IN PLACE between builds, the way a sampler may reuse its output.
    const inPlace: number[] = [1, 0, 0, 1, 0, 0];
    let options: BuildDrawListOptions = { viewScaleEnv };

    for (let step = 0; step < 400; step++) {
      if (rand() < 0.1) inPlace[5] = rand() * 30;
      const roll = rand();
      const ids = live();
      if (roll < 0.25 && ids.length > 0) {
        const id = pick(ids);
        const node = state.nodes.get(id)!;
        const over: Partial<MirrorNode> = pick<Partial<MirrorNode>>([
          {},
          { visible: !node.visible },
          { transform: [1, 0, 0, 1, rand() * 100, rand() * 100] },
          { modulate: fill(rand()) },
          { zIndex: Math.floor(rand() * 5) - 2 },
          { showBehindParent: !node.showBehindParent }
        ]);
        applySceneDelta(state, delta([{ ...node, ...over }]));
      } else if (roll < 0.35) {
        const parent = ids.length > 0 && rand() < 0.9 ? pick(ids) : null;
        const node = fresh(parent);
        if (parent === null) roots.push(node.id);
        else kids.set(parent, [...(kids.get(parent) ?? []), node.id]);
        applySceneDelta(state, delta([node], [], flatten(roots, kids)));
      } else if (roll < 0.42 && ids.length > 4) {
        const id = pick(ids);
        // Half the removals leave the order alone, so the children become orphans held at the stage root.
        const keepOrder = rand() < 0.5;
        detach(id);
        const orphans = kids.get(id) ?? [];
        kids.delete(id);
        if (!keepOrder) roots.push(...orphans);
        applySceneDelta(state, delta([], [id], keepOrder ? null : flatten(roots, kids)));
        if (keepOrder) roots.push(...orphans);
      } else if (roll < 0.48 && ids.length > 2) {
        const id = pick(ids);
        const banned = subtree(id);
        const target = pick(ids.filter((c) => !banned.has(c)).concat([""]));
        detach(id);
        if (target === "") roots.push(id);
        else kids.set(target, [...(kids.get(target) ?? []), id]);
        applySceneDelta(state, delta([{ ...state.nodes.get(id)!, parentId: target === "" ? null : target }], [],
          flatten(roots, kids)));
      } else if (roll < 0.5) {
        applySceneDelta(state, delta(ids.map((id) => ({ ...state.nodes.get(id)! })), [], flatten(roots, kids), true));
      } else if (roll < 0.75) {
        const some = (n: number) => Array.from({ length: n }, () => pick(ids));
        inPlace[4] = rand() < 0.5 ? inPlace[4] : rand() * 50;
        const overrideIds = rand() < 0.5 ? some(2) : [];
        options = {
          viewScaleEnv,
          transformOverrides: new Map<string, readonly number[]>([
            ...overrideIds.map((id) => [id, [1, 0, 0, 1, rand() * 40, 0]] as [string, number[]]),
            ...(ids.length > 0 && rand() < 0.5 ? [[pick(ids), inPlace] as [string, number[]]] : [])
          ]),
          alphaOverrides: rand() < 0.3 ? new Map(some(2).map((id) => [id, { mod: rand(), self: null }])) : null,
          cosmeticOffsets: rand() < 0.3 ? new Map(some(1).map((id) => [id, { dx: rand() * 10, dy: rand() * 10 }])) : null,
          localAnims: rand() < 0.3 ? new Map(some(1).map((id) => [id, { pre: [1, 0, 0, 1, 0, rand() * 4], post: null }])) : null,
          captureGlobals: rand() < 0.3 ? { ids: new Set(some(2)), out: new Map() } : null,
          skipRoots: rand() < 0.2 ? new Set(some(1)) : null,
          renderWidthOverrides: rand() < 0.2 ? new Map(some(1).map((id) => [id, 50 + rand() * 50])) : null
        };
      } else if (roll < 0.8) {
        viewScaleOn = !viewScaleOn;
      }
      // …and the rest of the steps rebuild an unchanged state, which is where the memo answers.
      buildAll(builders, state, options);
    }
    expect(memo.stats.hits).toBeGreaterThan(50);
    expect(Object.keys(memo.stats.missReasons).length).toBeGreaterThan(3);
    expect(verifyMemo.stats.verified).toBeGreaterThan(50);
    expect(verifyMemo.stats.verifyMismatches).toBe(0);
    // Captures on: the same sequence, still exact, and capture membership changes are among its misses.
    expect(captureMemo.stats.hits).toBeGreaterThan(memo.stats.hits);
    expect(captureMemo.stats.missReasons.capture).toBeGreaterThan(0);
    expect(captureVerifyMemo.stats.verified).toBeGreaterThan(50);
    expect(captureVerifyMemo.stats.verifyMismatches).toBe(0);
  }, 120_000);
});

// --- captures recorded and replayed (`rustHiddenMemoCaptures`) -----------------------------------------------------

describe("hidden-subtree memo with captures", () => {
  const capturing = () => createHiddenSubtreeMemo({ captures: true });
  const setup = () => {
    const state = stateOf(scene());
    const memo = capturing();
    const builders = [mkBuilder(null), mkBuilder(memo), mkBuilder(capturing(), { reuse: true })];
    const options: BuildDrawListOptions = { viewScaleEnv: viewScaleEnvFor(state) };
    return { state, memo, builders, options };
  };
  const capturingIds = (...ids: string[]): BuildDrawListOptions =>
    ({ captureGlobals: { ids: new Set(ids), out: new Map() } });

  it("replays captures under a hidden root in the walk's order, at the root's position", () => {
    const { state, memo, builders, options } = setup();
    // `h1a` is a behind-parent child and `h1c` sorts ahead of `h1b`, so walk order is not paint order; `panel` and
    // `tail` bracket the hidden root, so a replay published anywhere but at the root would reorder the map.
    const withCaptures = {
      ...options, ...capturingIds("tail", "h1b", "h1a", "h1", "panel", "h1c", "h2a", "orphanKid")
    };
    const order = ["panel", "h1", "h1a", "h1c", "h1b", "h2a", "tail", "orphanKid"];
    for (let i = 0; i < 3; i++) {
      const runs = buildAll(builders, state, withCaptures);
      for (const run of runs) expect([...run.capture!.keys()]).toStrictEqual(order);
    }
    expect(memo.stats.missReasons).toStrictEqual({ absent: 2 });
    expect(memo.stats.hits).toBe(4);
    expect(memo.stats.replayedNodes).toBe(2 * (7 + 2));
  });

  it("misses when the capture ids inside the span change, and replays the new set afterwards", () => {
    const { memo, builders, state, options } = setup();
    const steps: Array<[BuildDrawListOptions, number]> = [
      [capturingIds("h1c"), 0],
      [capturingIds("h1c", "h2a"), 1], // one more inside H
      [{}, 2], // none at all
      [capturingIds("h1a"), 3], // one again
      [capturingIds("h1c"), 4], // the same count, a different id
      [capturingIds("panel", "tail", "orphanKid"), 6] // none inside H, one inside the orphan
    ];
    for (const [extra, misses] of steps) {
      buildAll(builders, state, { ...options, ...extra });
      expect(memo.stats.missReasons.capture ?? 0).toBe(misses);
      const hits = memo.stats.hits;
      buildAll(builders, state, { ...options, ...extra });
      expect(memo.stats.hits).toBe(hits + 2);
    }
    expect(memo.stats.missReasons.tainted).toBeUndefined();
  });

  it("misses when a captured value's context or node changes, and publishes the new value", () => {
    // Each change moves `h1c`'s captured value without touching which ids capture.
    const changes: Array<[string, (state: MirrorState, options: BuildDrawListOptions) => BuildDrawListOptions]> = [
      ["context", (_, options) => ({ ...options, alphaOverrides: new Map([["root", { mod: 0.5, self: null }]]) })],
      ["context", (_, options) => ({ ...options, cosmeticOffsets: new Map([["root", { dx: 0, dy: 12 }]]) })],
      ["context", (state, options) => (replace(state, "root", { transform: [1, 0, 0, 1, 11, 21] }), options)],
      ["node", (state, options) => (replace(state, "h1", { transform: [1, 0, 0, 1, 9, 9] }), options)]
    ];
    for (const [reason, change] of changes) {
      const { memo, builders, state, options } = setup();
      const withCapture = { ...options, ...capturingIds("h1c") };
      const valueOf = (runs: Run[]) => runs[1].capture!.get("h1c")!;
      const before = valueOf(buildAll(builders, state, withCapture));
      // A replay publishes the recorded value object itself.
      expect(valueOf(buildAll(builders, state, withCapture))).toBe(before);
      const after = valueOf(buildAll(builders, state, change(state, withCapture)));
      expect(memo.stats.missReasons[reason]).toBe(1);
      expect(after).not.toStrictEqual(before);
    }
  });

  it("verify mode compares captures: no difference, until a recorded value stops matching the walk", () => {
    const state = stateOf(scene());
    const memo = capturing();
    const builders = [mkBuilder(null), mkBuilder(memo, { verify: true })];
    const options = { viewScaleEnv: viewScaleEnvFor(state), ...capturingIds("h1", "h1c", "h2a", "orphanKid") };
    for (let i = 0; i < 4; i++) buildAll(builders, state, options);
    expect(memo.stats.verified).toBe(6);
    expect(memo.stats.verifyMismatches).toBe(0);
    expect(memo.stats.replayedNodes).toBe(0);
    // The last walk's value objects are the recording's; a consumer writing into one is what verify must catch.
    const [, verified] = buildAll(builders, state, options);
    (verified.capture!.get("h1c") as { parentTy: number }).parentTy += 1;
    buildAll(builders, state, options);
    expect(memo.stats.verifyMismatches).toBe(1);
  });

  it("taints on captures with the switch off, exactly as before", () => {
    const state = stateOf(scene());
    const memo = createHiddenSubtreeMemo({ captures: false });
    const builders = [mkBuilder(null), mkBuilder(memo)];
    const options = { viewScaleEnv: viewScaleEnvFor(state), ...capturingIds("h1c") };
    for (let i = 0; i < 3; i++) buildAll(builders, state, options);
    expect(memo.stats.missReasons).toStrictEqual({ absent: 1, tainted: 3 });
    expect(memo.stats.hits).toBe(2); // the orphan only
  });
});

// --- a recorded busy stream ---------------------------------------------------------------------------------------
//
// Replays the dense-VFX end-turn recording (`.sts2/bench/canvas-gpu-sep21/`, local and uncommitted; the PRIMARY
// checkout's when this runs in a worktree) delivery by delivery, building after each one with no memo, the memo
// with captures off and the memo with captures on, and logs the share of hidden-subtree nodes each replayed. Every
// build carries the live renderer's capture ids (see `streamCaptureIds`), which is what kept the captures-off memo
// walking the hidden map. Still optimistic otherwise: there are no client tweens, so nothing a sampler or a held
// card would taint is in play. Skipped when the file is absent.

const RECORDING_REL = ".sts2/bench/canvas-gpu-sep21/dense-vfx-endturn.ndjson";

function recordingPath(): string | null {
  const fromEnv = process.env.COUCHCOOP_HIDDEN_MEMO_RECORDING;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const candidates = [resolve(root, RECORDING_REL)];
  try {
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(resolve(root, ".git"), "utf8"))?.[1]?.trim();
    // A linked worktree's `.git` names `<primary>/.git/worktrees/<name>`.
    if (gitdir) candidates.push(resolve(gitdir, "../../..", RECORDING_REL));
  } catch {
    // The primary checkout itself: `.git` is a directory.
  }
  return candidates.find((path) => existsSync(path)) ?? null;
}

const RECORDING = recordingPath();
const COMPARE_EVERY = Math.max(1, Number(process.env.COUCHCOOP_HIDDEN_MEMO_COMPARE_EVERY ?? 8) || 8);

/**
 * The live renderer's capture ids minus the client-only ones (a held card, cosmetic offsets, open landings): the
 * eager-scroll containers from the renderer's own structure scan, and the hand holders. The scan does not test
 * visibility, so the map container is captured while its screen is hidden.
 */
function streamCaptureIds(state: MirrorState): Set<string> {
  const env: EagerScrollLayoutEnv = {
    orderedIds: () => state.orderedIds,
    nodeById: (id) => state.nodes.get(id),
    childIdsOf: () => undefined,
    typeLeafOf: (node) => nodeTypeLeaf(node.nodeType),
    streamedGlobalOf: () => null,
    hasHost: () => true,
    spreadDxOf: () => 0,
    renderedYOf: (_id, fallback) => fallback,
    ancestorHidden: () => false,
    transformPinned: () => false,
    drawingToolActive: () => false
  };
  const ids = new Set(scanEagerScrollIds(env).map((candidate) => candidate.id));
  for (const node of state.nodes.values()) if (nodeTypeLeaf(node.nodeType) === HAND_HOLDER_TYPE) ids.add(node.id);
  return ids;
}

describe("hidden-subtree memo on a recorded busy stream", () => {
  it.skipIf(RECORDING === null)("matches the full walk at every delivery, captures included, and reports hit rates", () => {
    const text = readFileSync(RECORDING!, "utf8");
    const state = createMirrorState();
    const memos = { capturesOff: createHiddenSubtreeMemo(), capturesOn: createHiddenSubtreeMemo({ captures: true }) };
    const builders = [mkBuilder(null), mkBuilder(memos.capturesOff, { reuse: true }),
      mkBuilder(memos.capturesOn, { reuse: true })];
    const viewScaleEnv = viewScaleEnvFor(state);
    let deliveries = 0;
    const options = (): BuildDrawListOptions => {
      const ids = streamCaptureIds(state);
      return { viewScaleEnv, captureGlobals: ids.size > 0 ? { ids, out: new Map() } : null };
    };
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      const envelope = JSON.parse(line) as { data?: unknown };
      if (typeof envelope.data !== "string") continue;
      const parsed = parseSceneDelta(JSON.parse(envelope.data));
      if (parsed === null) continue;
      applySceneDelta(state, parsed);
      deliveries++;
      // Every delivery is built (the memo sees the real sequence); every eighth is compared whole by default.
      buildAll(builders, state, options(), deliveries % COMPARE_EVERY === 0);
    }
    buildAll(builders, state, options());
    const rateOf = (s: HiddenSubtreeMemo["stats"]) =>
      s.replayedNodes / Math.max(1, s.replayedNodes + s.walkedHiddenNodes);
    for (const [name, { stats: s }] of Object.entries(memos)) {
      console.info(`[hidden-memo ${name}] deliveries=${deliveries} roots=${s.roots} hits=${s.hits} misses=${s.misses} ` +
        `replayedNodes=${s.replayedNodes} walkedHiddenNodes=${s.walkedHiddenNodes} nodeHitRate=${rateOf(s).toFixed(3)} ` +
        `replayedCaptures=${s.replayedCaptures} missReasons=${JSON.stringify(s.missReasons)} ` +
        `notRecorded=${JSON.stringify(s.notRecorded)} entries=${s.entries}`);
    }
    expect(deliveries).toBeGreaterThan(100);
    // The stream does capture under a hidden root, and with captures recorded the memo replays nearly all of it.
    expect(memos.capturesOn.stats.replayedCaptures).toBeGreaterThan(0);
    expect(rateOf(memos.capturesOn.stats)).toBeGreaterThanOrEqual(0.9);
  }, 300_000);
});
