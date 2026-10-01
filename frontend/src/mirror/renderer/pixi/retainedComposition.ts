import { createNinePatchView, createQuadView, createTexturedMeshView, type DrawList } from "@godot-scene-web/canvas";
import type { PixiTextRecord } from "@godot-scene-web/canvas/pixi";
import { affineInverse, affineMul, type Affine } from "@/mirror/affine";
import { composeLocalAnimGlobal, type DrawListBuild, type LocalAnim } from "@/mirror/canvas/buildDrawList";
import type { HitEntry } from "@/mirror/canvas/hitTest";

type Pose = readonly number[];
type Primitive = { id: string; index: number; localTransform?: Pose };
type PrimitivePatch = { id: string; transform?: Pose; alpha?: number; source?: { texture: string | null; x: number; y: number; w: number; h: number } };
type GroupPatch = { id: string; transform: Pose };
type Reference = { id: string; owner: string; matrix: Affine };

export interface RetainedPixiPlan {
  primitives: Primitive[];
  groups: Array<{ id: string; firstIndex: number; endIndex: number; transform: Pose; renderGroup: boolean; cacheAsTexture?: boolean }>;
}

export interface RetainedPixiPatch {
  primitives: PrimitivePatch[];
  groups: GroupPatch[];
  hits: Array<{ entry: HitEntry; matrix: Affine; gameMatrix?: Affine }>;
  nodeMatrices: Array<{ id: string; matrix: Affine }>;
  sourceReferences: Array<{ id: string; matrix: Affine }>;
  movedRoots: number;
  rootPoses: ReadonlyMap<string, Affine>;
}

export interface RetainedPixiCompositionOptions {
  includeStaticPixelCaches?: boolean;
  onStaticAdmission?: (edge: "start" | "end") => void;
  /**
   * Build the patch index (owner references, hit references, committed poses) on first use instead of at
   * admission. The plan stays eager: admission serializes it, and it stamps the text parents the serializer reads.
   */
  lazyPatchIndex?: boolean;
  /** The producer's input generation. A lazy index refuses to build once the list, texts or hits moved on. */
  inputGeneration?: () => number;
  /** Throw on moved inputs instead of refusing the patch (tests and shadow verification). */
  strictInputs?: boolean;
  /** Called once when a lazy index is built. */
  onPatchIndex?: () => void;
  /** Shadow-check a lazy index against an eager twin. The twin's answers are returned. */
  verify?: { onMismatch(method: string, detail: string): void };
}

export interface RetainedPixiComposition {
  plan: RetainedPixiPlan;
  patch(anims: ReadonlyMap<string, LocalAnim>): RetainedPixiPatch | null;
  patchWireTransform(id: string, delta: Affine): RetainedPixiPatch | null;
  commit(patch: RetainedPixiPatch): void;
  logicalMatrix(id: string): Affine | undefined;
  logicalNodeMatrix(id: string, base: Affine): Affine;
  sourceTransform(id: string, referenceMatrix: Affine, sampledMatrix?: Pose): Affine | null;
}

/** A build-time index. Sampling visits animation spans, never the whole command list. */
export function createRetainedPixiComposition(
  list: DrawList<string>, build: DrawListBuild, texts: readonly PixiTextRecord[],
  textOwners: ReadonlyMap<string, string>, spreadDxByNode: ReadonlyMap<string, number>,
  options: RetainedPixiCompositionOptions = {},
): RetainedPixiComposition {
  if (options.lazyPatchIndex && options.verify)
    return createVerifiedComposition(list, build, texts, textOwners, spreadDxByNode, options, options.verify);
  const ownerByIndex = new Map<number, string>();
  const plan: RetainedPixiPlan = { primitives: [], groups: [] };
  const quad = createQuadView();
  const nine = createNinePatchView();
  const mesh = createTexturedMeshView();
  const owned = new Set<number>();
  // The scene build owns this full walk. The animation lane only visits the
  // indexed descendants of the small set of animated roots below.
  for (const [owner, range] of build.ranges) {
    for (let index = range.start; index < range.paintEnd; index++) {
      owned.add(index);
      ownerByIndex.set(index, owner);
      const kind = list.kindNameAt(index);
      if (kind === "quad" || kind === "ninePatch" || kind === "polyline" || kind === "texturedMesh")
        plan.primitives.push({ id: `${owner}:${kind}:${index - range.start}`, index });
    }
  }
  for (let index = 0; index < list.count; index++) {
    if (owned.has(index)) continue;
    const kind = list.kindNameAt(index);
    if (kind === "quad" || kind === "ninePatch" || kind === "polyline" || kind === "texturedMesh")
      plan.primitives.push({ id: `unowned:${index}`, index });
  }
  const roots = [...build.localAnimFrames].map(([id, frame]) => {
    const span = build.order.entries.get(id);
    const inverse = affineInverse(frame.drawn);
    return { id, frame, span, inverse };
  }).sort((a, b) => (a.span?.spanStart ?? 0) - (b.span?.spanStart ?? 0) || (b.span?.spanEnd ?? 0) - (a.span?.spanEnd ?? 0));
  const groupByRoot = new Map<string, string>();
  const singletonRoots: Array<{ id: string; index: number }> = [];
  const animatedOwners = new Set<string>();
  for (const root of roots) if (root.span)
    for (let order = root.span.spanStart; order < root.span.spanEnd; order++) animatedOwners.add(build.order.ids[order]);
  const addAnimGroup = (rootId: string, first: number, end: number) => {
    const id = `anim:${rootId}`;
    plan.groups.push({ id, firstIndex: first, endIndex: end, transform: [1, 0, 0, 1, 0, 0], renderGroup: true });
    groupByRoot.set(rootId, id);
    for (const primitive of plan.primitives) if (primitive.index >= first && primitive.index < end)
      (primitive as Primitive & { parentId?: string }).parentId = id;
    for (const text of texts) if (text.insertionIndex >= first && text.insertionIndex < end)
      (text as PixiTextRecord & { parentId?: string }).parentId = id;
  };
  for (const root of roots) {
    const span = root.span;
    if (!span || roots.some((other) => other !== root && other.span &&
      other.span.spanStart < span.spanEnd && span.spanStart < other.span.spanEnd)) continue;
    let first = Infinity, end = -Infinity, drawable = 0;
    const descendants = new Set<string>();
    let sameSpread = true;
    for (let order = span.spanStart; order < span.spanEnd; order++) {
      const id = build.order.ids[order]; descendants.add(id);
      if ((spreadDxByNode.get(id) ?? 0) !== root.frame.spreadDx) sameSpread = false;
      const range = build.ranges.get(id);
      if (range) { first = Math.min(first, range.start); end = Math.max(end, range.paintEnd); drawable += range.paintEnd - range.start; }
    }
    if (!sameSpread || drawable < 1 || !Number.isFinite(first)) continue;
    let safe = true;
    for (let index = first; index < end; index++) {
      const kind = list.kindNameAt(index);
      if (kind === "clipPush" || kind === "clipPop" || !owned.has(index) ||
        !descendants.has(ownerByIndex.get(index) ?? "")) { safe = false; break; }
    }
    let hasText = false;
    for (const text of texts) {
      const belongs = descendants.has(textOwners.get(text.key) ?? "");
      const inside = text.insertionIndex >= first && text.insertionIndex < end;
      if (inside) hasText = true;
      if (belongs !== inside) safe = false;
    }
    if (!safe) continue;
    if (drawable === 1 && end === first + 1 && !hasText) singletonRoots.push({ id: root.id, index: first });
    else if (drawable >= 2) addAnimGroup(root.id, first, end);
  }
  // A singleton group is useful only when its moving sprite would otherwise
  // invalidate a batch containing static siblings. Inspect admission indexes
  // once; warm samples use the selected group map above.
  const textBoundaries = new Set(texts.map((text) => text.insertionIndex));
  const groupedIndexes = new Set<number>();
  for (const group of plan.groups) for (let index = group.firstIndex; index < group.endIndex; index++) groupedIndexes.add(index);
  const segmentAt = new Map<number, { first: number; end: number; staticCount: number }>();
  let segment: { first: number; end: number; staticCount: number; spread: number } | null = null;
  let clipDepth = 0;
  const identityColor = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let index = 0; index < list.count; index++) {
    const owner = ownerByIndex.get(index);
    const kind = list.kindNameAt(index);
    if (kind === "clipPush") { clipDepth++; segment = null; continue; }
    if (kind === "clipPop") { clipDepth--; segment = null; continue; }
    let eligible = clipDepth === 0 && !!owner && !groupedIndexes.has(index) &&
      (kind === "quad" || kind === "ninePatch");
    if (eligible) {
      const view = kind === "quad" ? list.readQuad(index, quad) : list.readNinePatch(index, nine);
      eligible = view.blend === 0 && (!view.hasColorMatrix ||
        identityColor.every((value, component) => view.colorMatrix[component] === value));
    }
    const spread = owner ? spreadDxByNode.get(owner) ?? 0 : 0;
    if (!eligible || textBoundaries.has(index) || (segment && segment.spread !== spread)) segment = null;
    if (!eligible) continue;
    if (!segment) segment = { first: index, end: index, staticCount: 0, spread };
    segment.end = index + 1;
    const node = build.nodePaintInputs.get(owner!)?.node;
    if (!animatedOwners.has(owner!) && !node?.intentFrames && !node?.pinnedLoopAnim) segment.staticCount++;
    segmentAt.set(index, segment);
  }
  const rankedSingletons = singletonRoots.flatMap((root) => {
    const run = segmentAt.get(root.index);
    return run && run.staticCount > 0 ? [{ ...root, staticCount: run.staticCount,
      edge: Math.min(root.index - run.first, run.end - 1 - root.index) }] : [];
  }).sort((a, b) => b.staticCount - a.staticCount || a.edge - b.edge || a.index - b.index);
  // Four is a conservative safety bound, not a measured optimum.
  for (const root of rankedSingletons.slice(0, 4)) addAnimGroup(root.id, root.index, root.index + 1);
  // Pixel caches are reserved for small, stable, opaque normal-blend islands.
  // Resource or wire changes require admission; the adapter also refreshes a
  // cached island if a later primitive patch reaches one of its children.
  options.onStaticAdmission?.("start");
  try {
    if (options.includeStaticPixelCaches !== false) {
      const staticCandidates = [...build.order.entries.values()]
        .sort((a, b) => (b.spanEnd - b.spanStart) - (a.spanEnd - a.spanStart));
      for (const candidate of staticCandidates) {
        if (plan.groups.filter((group) => group.cacheAsTexture).length >= 4) break;
        if (roots.some((root) => root.span && root.span.spanStart < candidate.spanEnd && candidate.spanStart < root.span.spanEnd)) continue;
        let first = Infinity, end = -Infinity, drawables = 0, safe = true;
        const descendants = new Set<string>();
        for (let order = candidate.spanStart; order < candidate.spanEnd; order++) {
          const id = build.order.ids[order]; descendants.add(id);
          const node = build.nodePaintInputs.get(id)?.node;
          if (node?.intentFrames || node?.pinnedLoopAnim) safe = false;
          const range = build.ranges.get(id);
          if (range) { first = Math.min(first, range.start); end = Math.max(end, range.paintEnd); drawables += range.paintEnd - range.start; }
        }
        if (!safe || !Number.isFinite(first) ||
          plan.groups.some((group) => group.firstIndex < end && first < group.endIndex)) continue;
        const groupTexts = texts.filter((text) => text.insertionIndex >= first && text.insertionIndex < end);
        if (texts.some((text) => descendants.has(textOwners.get(text.key) ?? "") !==
          (text.insertionIndex >= first && text.insertionIndex < end)) ||
          groupTexts.some((text) => (text.alpha ?? 1) !== 1 || (text.blend ?? 0) !== 0) ||
          drawables + groupTexts.length < 3) continue;
        for (let index = first; index < end; index++) {
          const owner = ownerByIndex.get(index), kind = list.kindNameAt(index);
          if (!owner || !descendants.has(owner) || (kind !== "quad" && kind !== "ninePatch")) { safe = false; break; }
          const view = kind === "quad" ? list.readQuad(index, quad) : list.readNinePatch(index, nine);
          if (view.a !== 1 || view.blend !== 0) { safe = false; break; }
        }
        if (!safe) continue;
        const id = `static:${candidate.id}`;
        plan.groups.push({ id, firstIndex: first, endIndex: end, transform: [1, 0, 0, 1, 0, 0], renderGroup: false, cacheAsTexture: true });
        for (const primitive of plan.primitives) if (primitive.index >= first && primitive.index < end)
          (primitive as Primitive & { parentId?: string }).parentId = id;
        for (const text of groupTexts) (text as PixiTextRecord & { parentId?: string }).parentId = id;
      }
    }
  } finally {
    options.onStaticAdmission?.("end");
  }
  const lastRootPoses = new Map<string, Affine>();
  const wireNodeMatrices = new Map<string, Affine>();
  for (const root of roots) lastRootPoses.set(root.id, [1, 0, 0, 1, 0, 0]);

  // The patch index reads the command matrices, text transforms, text owners and hit poses this admission saw.
  // A lazy index is built on first use; the inputs it reads stay untouched until the producer's next build, and
  // the generation tripwire refuses (or, when strict, throws) if that build already started.
  const byOwner = new Map<string, Reference[]>();
  const ownerByPrimitive = new Map<string, string>();
  const hitsByOwner = new Map<string, HitEntry[]>();
  const hitReferences = new Map<HitEntry, Affine>();
  const lastPrimitive = new Map<string, Affine>();
  const lastHit = new Map<HitEntry, Affine>();
  const indexGeneration = options.inputGeneration?.();
  const indexCommands = list.count, indexTexts = texts.length;
  let indexState: "pending" | "built" | "stale" = "pending";
  function buildIndex(): void {
    for (const [owner, range] of build.ranges) {
      const references: Reference[] = [];
      for (let index = range.start; index < range.paintEnd; index++) {
        const kind = list.kindNameAt(index);
        const id = `${owner}:${kind}:${index - range.start}`;
        if (kind === "quad" || kind === "ninePatch") {
          const view = kind === "quad" ? list.readQuad(index, quad) : list.readNinePatch(index, nine);
          references.push({ id, owner, matrix: [...view.m] as Affine });
          ownerByPrimitive.set(id, owner);
        } else if (kind === "texturedMesh") {
          references.push({ id, owner, matrix: [...list.readTexturedMesh(index, mesh).m] as Affine });
          ownerByPrimitive.set(id, owner);
        } else if (kind === "polyline") {
          references.push({ id, owner, matrix: [1, 0, 0, 1, 0, 0] });
          ownerByPrimitive.set(id, owner);
        }
      }
      byOwner.set(owner, references);
    }
    for (const text of texts) {
      const owner = textOwners.get(text.key);
      if (!owner) continue;
      const references = byOwner.get(owner) ?? [];
      references.push({ id: `text:${text.key}`, owner, matrix: [...text.transform] as Affine });
      ownerByPrimitive.set(`text:${text.key}`, owner);
      byOwner.set(owner, references);
    }
    for (const hit of build.hitEntries) {
      const entries = hitsByOwner.get(hit.nodeId) ?? [];
      entries.push(hit);
      hitsByOwner.set(hit.nodeId, entries);
    }
    for (const hit of build.hitEntries) hitReferences.set(hit, [...hit.mFinal] as Affine);
    for (const refs of byOwner.values()) for (const ref of refs) lastPrimitive.set(ref.id, ref.matrix);
    for (const [hit, matrix] of hitReferences) lastHit.set(hit, matrix);
    indexState = "built";
  }
  function ensureIndex(): boolean {
    if (indexState === "built") return true;
    if (indexState === "pending" && options.inputGeneration?.() === indexGeneration &&
      list.count === indexCommands && texts.length === indexTexts) {
      buildIndex();
      options.onPatchIndex?.();
      return true;
    }
    indexState = "stale";
    if (options.strictInputs) throw new Error("retained composition inputs changed before its patch index was built");
    return false;
  }
  if (!options.lazyPatchIndex) buildIndex();

  function patch(anims: ReadonlyMap<string, LocalAnim>): RetainedPixiPatch | null {
    if (!ensureIndex()) return null;
    if ([...anims.keys()].some((id) => !build.localAnimFrames.has(id))) return null;
    const deltas: Array<{ start: number; end: number; delta: Affine; rootDx: number; vx: number; vy: number }> = [];
    const rootPoses = new Map<string, Affine>();
    for (const root of roots) {
      if (!root.span || !root.inverse || root.frame.spreadRebased) return null;
      const anim = anims.get(root.id);
      const raw = composeLocalAnimGlobal(root.frame.base, root.frame.wire, null, anim?.pre ?? null, anim?.post ?? null);
      const outer: Affine = [...root.frame.outer] as Affine;
      const draw = affineMul(outer, [raw[0], raw[1], raw[2], raw[3], raw[4] + root.frame.spreadDx, raw[5]]);
      const delta = affineMul(draw, root.inverse);
      rootPoses.set(root.id, delta);
      const vx = outer[0] - (delta[0] * outer[0] + delta[2] * outer[1]);
      const vy = outer[1] - (delta[1] * outer[0] + delta[3] * outer[1]);
      deltas.push({ start: root.span.spanStart, end: root.span.spanEnd, delta, rootDx: root.frame.spreadDx, vx, vy });
    }
    if (roots.every((root) => rootPoses.get(root.id)!.every((value, i) => value === lastRootPoses.get(root.id)![i])))
      return { primitives: [], groups: [], hits: [], nodeMatrices: [], sourceReferences: [], movedRoots: 0, rootPoses };
    const primitiveMap = new Map<string, PrimitivePatch>();
    const primitiveDeltas = new Map<string, Affine>();
    const hitMap = new Map<HitEntry, { entry: HitEntry; matrix: Affine }>();
    const hitDeltas = new Map<HitEntry, Affine>();
    const groups: GroupPatch[] = [];
    let movedRoots = 0;
    for (let rootIndex = 0; rootIndex < deltas.length; rootIndex++) {
      const { start, end, delta, rootDx, vx, vy } = deltas[rootIndex];
      const group = groupByRoot.get(roots[rootIndex].id);
      if (group) groups.push({ id: group, transform: delta });
      if (!delta.every((value, i) => Math.abs(value - [1, 0, 0, 1, 0, 0][i]) < 1e-9)) movedRoots++;
      // Nested animated roots compose in paint-order ancestry. The descendant
      // reference stays immutable across any number of presentation frames.
      for (let order = start; order < end; order++) {
        const owner = build.order.ids[order];
        const spread = spreadDxByNode.get(owner) ?? 0;
        const offset = spread - rootDx;
        const applied: Affine = offset === 0 || (vx === 0 && vy === 0) ? delta
          : [delta[0], delta[1], delta[2], delta[3], delta[4] + offset * vx, delta[5] + offset * vy];
        for (const ref of group ? [] : byOwner.get(owner) ?? []) {
          const previous = primitiveDeltas.get(ref.id);
          const combined = previous ? affineMul(previous, applied) : applied;
          primitiveDeltas.set(ref.id, combined);
          primitiveMap.set(ref.id, { id: ref.id, transform: affineMul(combined, ref.matrix) });
        }
        for (const entry of hitsByOwner.get(owner) ?? []) {
          const previous = hitDeltas.get(entry);
          const combined = previous ? affineMul(previous, applied) : applied;
          hitDeltas.set(entry, combined);
          hitMap.set(entry, { entry, matrix: affineMul(combined, hitReferences.get(entry)!) });
        }
      }
    }
    return {
      primitives: [...primitiveMap.values()].filter(({ id, transform }) =>
        !transform?.every((value, i) => value === lastPrimitive.get(id)?.[i])),
      groups: groups.filter(({ id, transform }) => {
        const rootId = id.slice("anim:".length);
        return !transform.every((value, i) => value === lastRootPoses.get(rootId)?.[i]);
      }),
      hits: [...hitMap.values()].filter(({ entry, matrix }) =>
        !matrix.every((value, i) => value === lastHit.get(entry)?.[i])),
      nodeMatrices: [], sourceReferences: [], movedRoots, rootPoses,
    };
  }
  function commit(result: RetainedPixiPatch): void {
    // A committed patch came from patch() or patchWireTransform(), so its index already exists.
    if (!ensureIndex()) return;
    for (const [id, matrix] of result.rootPoses) lastRootPoses.set(id, matrix);
    for (const { id, transform } of result.primitives) if (transform) lastPrimitive.set(id, [...transform] as Affine);
    for (const { entry, matrix } of result.hits) lastHit.set(entry, matrix);
    for (const { id, matrix } of result.nodeMatrices) wireNodeMatrices.set(id, matrix);
    for (const { id, matrix } of result.sourceReferences) {
      const owner = ownerByPrimitive.get(id);
      const ref = owner && byOwner.get(owner)?.find((item) => item.id === id);
      if (ref) ref.matrix = matrix;
    }
  }
  function patchWireTransform(id: string, delta: Affine): RetainedPixiPatch | null {
    if (!ensureIndex()) return null;
    const span = build.order.entries.get(id);
    if (!span) return null;
    // Disjoint wire roots can advance beside local animation. An overlapping
    // root would change the animation's immutable build-time reference.
    if (roots.some((root) => root.span && root.span.spanStart < span.spanEnd && span.spanStart < root.span.spanEnd)) return null;
    const primitives: PrimitivePatch[] = [];
    const hits: RetainedPixiPatch["hits"] = [];
    const nodeMatrices: RetainedPixiPatch["nodeMatrices"] = [];
    for (let order = span.spanStart; order < span.spanEnd; order++) {
      const owner = build.order.ids[order];
      const input = build.nodePaintInputs.get(owner);
      if (input) nodeMatrices.push({ id: owner, matrix: affineMul(delta, wireNodeMatrices.get(owner) ?? input.global) });
      for (const ref of byOwner.get(owner) ?? []) {
        const current = lastPrimitive.get(ref.id);
        if (current) primitives.push({ id: ref.id, transform: affineMul(delta, current) });
      }
      for (const entry of hitsByOwner.get(owner) ?? []) {
        const current = lastHit.get(entry);
        if (current) hits.push({ entry, matrix: affineMul(delta, current), gameMatrix: affineMul(delta, entry.mGame) });
      }
    }
    return { primitives, groups: [], hits, nodeMatrices, sourceReferences: [], movedRoots: 1, rootPoses: new Map() };
  }
  function logicalMatrix(id: string): Affine | undefined {
    if (!ensureIndex()) return undefined;
    const base = lastPrimitive.get(id);
    if (!base) return undefined;
    const owner = ownerByPrimitive.get(id);
    if (owner) for (const [rootId] of groupByRoot) {
      const span = build.order.entries.get(rootId), entry = build.order.entries.get(owner);
      if (span && entry && entry.order >= span.spanStart && entry.order < span.spanEnd)
        return affineMul(lastRootPoses.get(rootId)!, base);
    }
    return base;
  }
  function logicalNodeMatrix(id: string, base: Affine): Affine {
    const reference = wireNodeMatrices.get(id) ?? base;
    const entry = build.order.entries.get(id);
    if (!entry) return reference;
    let composed: Affine = [1, 0, 0, 1, 0, 0];
    for (const root of roots) {
      if (!root.span || entry.order < root.span.spanStart || entry.order >= root.span.spanEnd) continue;
      const delta = lastRootPoses.get(root.id)!;
      const outer = root.frame.outer;
      const vx = outer[0] - (delta[0] * outer[0] + delta[2] * outer[1]);
      const vy = outer[1] - (delta[1] * outer[0] + delta[3] * outer[1]);
      const s = (spreadDxByNode.get(id) ?? 0) - root.frame.spreadDx;
      composed = affineMul(composed, [delta[0], delta[1], delta[2], delta[3], delta[4] + s * vx, delta[5] + s * vy]);
    }
    return affineMul(composed, reference);
  }
  function sourceTransform(id: string, referenceMatrix: Affine, sampledMatrix?: Pose): Affine | null {
    if (!ensureIndex()) return null;
    const owner = ownerByPrimitive.get(id);
    const ref = owner && byOwner.get(owner)?.find((item) => item.id === id);
    if (!ref) return null;
    const entry = build.order.entries.get(owner!);
    for (const [rootId] of groupByRoot) {
      const span = build.order.entries.get(rootId);
      if (span && entry && entry.order >= span.spanStart && entry.order < span.spanEnd) return referenceMatrix;
    }
    const old = (sampledMatrix ?? lastPrimitive.get(id)) as Affine | undefined, inverse = affineInverse(ref.matrix);
    return old && inverse ? affineMul(affineMul(old, inverse), referenceMatrix) : null;
  }
  return { plan, patch, patchWireTransform, commit, logicalMatrix, logicalNodeMatrix, sourceTransform };
}

/**
 * A lazy composition paired with an eager twin over the same inputs. Both stamp identical text parents; every
 * answer comes from the twin, and any difference (or a lazy tripwire) is reported instead of thrown.
 */
function createVerifiedComposition(
  list: DrawList<string>, build: DrawListBuild, texts: readonly PixiTextRecord[],
  textOwners: ReadonlyMap<string, string>, spreadDxByNode: ReadonlyMap<string, number>,
  options: RetainedPixiCompositionOptions, verify: NonNullable<RetainedPixiCompositionOptions["verify"]>,
): RetainedPixiComposition {
  const lazy = createRetainedPixiComposition(list, build, texts, textOwners, spreadDxByNode,
    { ...options, verify: undefined, strictInputs: true });
  const eager = createRetainedPixiComposition(list, build, texts, textOwners, spreadDxByNode,
    { includeStaticPixelCaches: options.includeStaticPixelCaches });
  if (!sameValue(lazy.plan, eager.plan)) verify.onMismatch("plan", "lazy plan differs from the eager plan");
  const check = <T>(method: string, run: (composition: RetainedPixiComposition) => T): T => {
    const expected = run(eager);
    try {
      if (!sameValue(run(lazy), expected)) verify.onMismatch(method, "lazy result differs from the eager result");
    } catch (error) {
      verify.onMismatch(method, error instanceof Error ? error.message : String(error));
    }
    return expected;
  };
  return {
    plan: eager.plan,
    patch: (anims) => check("patch", (composition) => composition.patch(anims)),
    patchWireTransform: (id, delta) => check("patchWireTransform", (composition) => composition.patchWireTransform(id, delta)),
    commit(result) {
      eager.commit(result);
      try { lazy.commit(result); }
      catch (error) { verify.onMismatch("commit", error instanceof Error ? error.message : String(error)); }
    },
    logicalMatrix: (id) => check("logicalMatrix", (composition) => composition.logicalMatrix(id)),
    logicalNodeMatrix: (id, base) => check("logicalNodeMatrix", (composition) => composition.logicalNodeMatrix(id, base)),
    sourceTransform: (id, referenceMatrix, sampledMatrix) => check("sourceTransform",
      (composition) => composition.sourceTransform(id, referenceMatrix, sampledMatrix)),
  };
}

/** Structural equality; shared objects (hit entries) compare by identity first, numbers by `Object.is`. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
    for (const [key, value] of a) if (!b.has(key) || !sameValue(value, b.get(key))) return false;
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => sameValue(value, b[index]));
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key]));
}
