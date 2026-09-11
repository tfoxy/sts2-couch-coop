// Shared offline-replay helpers for the CANVAS-STAGE FEASIBILITY PROBES (probe-canvas-*.mjs).
//
// These probes are pure ANALYSES over recorded mirror streams: no live game, no browser, no dev server. They
// replay a `.sts2/bench/*.ndjson` recording through the REAL wire model (frontend/src/mirror/sceneTree.ts) so the
// numbers they report describe the same retained tree the browser client builds, then answer questions the planned
// single-canvas renderer needs answered before it is written (draw-batch runs, atlas VRAM, text occlusion,
// animation concurrency).
//
// WHY A LOADER HOOK. sceneTree.ts used to have zero runtime imports (see compare-replay-final-state.mjs's note,
// now stale): it imports `@/join/hostBase` and `@/mirror/particleAttributes`, and the latter reaches
// `@/render/quality` → `@godot-scene-web/html`. Node cannot resolve either alias on its own. `registerHooks` (Node
// >= 22.15 / 23.5, synchronous, in-thread) maps `@/…` onto frontend/src and resolves
// `@godot-scene-web/*` through the sibling packages' `node` + `development` exports. tsx handles the .ts
// transform and extensionless imports. The two small remaining stubs are graph-bound imports whose code a replay
// never executes.

import { readFileSync } from "node:fs";
import { requireReproHeader } from "./repro-recording.mjs";
import { existsSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { defaultGodotSceneWebRoot, resolveGodotSceneWebSpecifier } from "./gsw-source-resolver.mjs";
import { defaultPresentationWebRoot, resolvePresentationSpecifier } from "./presentation-source-resolver.mjs";
import { PRIMARY_REPO_ROOT, REPO_ROOT } from "./repo-layout.mjs";

export { REPO_ROOT };
const FRONTEND_SRC = resolve(REPO_ROOT, "frontend/src");
const GSW_SOURCE_ROOT = defaultGodotSceneWebRoot(REPO_ROOT);
const PRESENTATION_SOURCE_ROOT = defaultPresentationWebRoot(REPO_ROOT);

// The recordings live in the PRIMARY checkout — a worktree's own `.sts2/` is empty (it is gitignored and
// per-checkout). Probes default to whichever of the two has them.
const PRIMARY_BENCH = resolve(PRIMARY_REPO_ROOT, ".sts2/bench");

export function benchDir() {
  const local = resolve(REPO_ROOT, ".sts2/bench");
  if (existsSync(local)) {
    return local;
  }
  return PRIMARY_BENCH;
}

// The standard probe set: one recording per screen family the canvas plan has to survive.
export const DEFAULT_RECORDINGS = [
  "combat-modern-2026-08-06.ndjson",
  "audit-cardreward-open.ndjson",
  "deckview-40-openclose.ndjson",
  "perf5-map-open.ndjson",
  "perf5-map-scroll.ndjson",
  "r13-reshuffle-30.ndjson",
  "probe-removal-used.ndjson",
  "audit-shop-open.ndjson"
];

/** Resolve the recording arguments (bare names resolve against the bench dir); default = DEFAULT_RECORDINGS. */
export function resolveRecordings(argv) {
  const names = argv.filter((a) => !a.startsWith("-"));
  const list = names.length > 0 ? names : DEFAULT_RECORDINGS;
  const out = [];
  for (const name of list) {
    const path = isAbsolute(name) ? name : name.includes("/") ? resolve(REPO_ROOT, name) : resolve(benchDir(), name);
    if (!existsSync(path)) {
      console.error(`  missing recording: ${path}`);
      // Do not silently publish a partial default set. Callers may still analyze the
      // recordings that exist, but their process must communicate incomplete coverage.
      process.exitCode = 1;
      continue;
    }
    out.push(path);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// module resolution
// ---------------------------------------------------------------------------------------------------------

let hooksInstalled = false;

async function installHooks() {
  if (hooksInstalled) {
    return;
  }
  // Register tsx FIRST. `registerHooks` installs after it, so its resolver sees aliases
  // before passing the selected .ts file to tsx's transformer and extensionless resolver.
  const frontendRequire = createRequire(resolve(REPO_ROOT, "frontend/package.json"));
  const tsxApi = await import(frontendRequire.resolve("tsx/esm/api"));
  tsxApi.register();
  hooksInstalled = true;
  registerHooks({
    resolve(spec, ctx, next) {
      if (spec.startsWith("@/")) {
        const base = resolve(FRONTEND_SRC, spec.slice(2));
        for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
          if (existsSync(candidate)) {
            return { url: pathToFileURL(candidate).href, shortCircuit: true };
          }
        }
      }
      if (spec.startsWith("@godot-scene-web/")) {
        const target = resolveGodotSceneWebSpecifier(spec, { sourceRoot: GSW_SOURCE_ROOT });
        return { url: pathToFileURL(target).href, shortCircuit: true };
      }
      if (spec.startsWith("@spirectl/presentation/")) {
        const target = resolvePresentationSpecifier(spec, { sourceRoot: PRESENTATION_SOURCE_ROOT });
        return { url: pathToFileURL(target).href, shortCircuit: true };
      }
      if (Object.hasOwn(STUB_SOURCES, spec)) {
        return { url: `mirror-probe-stub:${spec}`, shortCircuit: true };
      }
      return next(spec, ctx);
    },
    load(url, ctx, next) {
      if (url.startsWith("mirror-probe-stub:")) {
        const specifier = url.slice("mirror-probe-stub:".length);
        return { format: "module", shortCircuit: true, source: STUB_SOURCES[specifier] };
      }
      return next(url, ctx);
    }
  });
}

// Keep stubs separate by module. No @godot-scene-web export belongs here: probes load
// the renderer's real development sources now, so a missing source dependency is visible.
const STUB_SOURCES = {
  vue: `
export function ref(v) { return { value: v }; }
export function computed(fn) { return { get value() { return fn(); } }; }
export function reactive(v) { return v; }
export function shallowRef(v) { return { value: v }; }
export function shallowReactive(v) { return v; }
export function readonly(v) { return v; }
export function toRaw(v) { return v; }
export function markRaw(v) { return v; }
export function watch() { return () => {}; }
export function watchEffect() { return () => {}; }
export function nextTick() { return Promise.resolve(); }
export function onMounted() {}
export function onUnmounted() {}
export function onBeforeUnmount() {}
export function defineComponent(v) { return v; }
export default {};
`,
};

let sceneTreeModule = null;

/** The real wire model (frontend/src/mirror/sceneTree.ts), imported natively under Node. */
export async function loadSceneTree() {
  await installHooks();
  if (!sceneTreeModule) {
    sceneTreeModule = await import(pathToFileURL(resolve(FRONTEND_SRC, "mirror/sceneTree.ts")).href);
  }
  return sceneTreeModule;
}

// ---------------------------------------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------------------------------------

/**
 * Replay one NDJSON recording through parseSceneDelta/applySceneDelta.
 *
 * `onDelta(delta, t, state)` is invoked for every applied scene-delta with the envelope's own timestamp (ms since
 * the recording started), which is what the animation probe integrates its concurrency windows on.
 *
 * Returns { state, deltas, lastT, meta }.
 */
export async function replayRecording(recordingAbs, onDelta) {
  const { createMirrorState, parseSceneDelta, applySceneDelta } = await loadSceneTree();
  const state = createMirrorState();
  const text = readFileSync(recordingAbs, "utf8");
  requireReproHeader(text, recordingAbs);
  let deltas = 0;
  let lastT = 0;
  let meta = null;
  for (const line of text.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.meta) {
      meta = obj.meta;
      continue;
    }
    if (typeof obj?.data !== "string") {
      continue;
    }
    let raw;
    try {
      raw = JSON.parse(obj.data);
    } catch {
      continue;
    }
    const delta = parseSceneDelta(raw);
    if (!delta) {
      continue;
    }
    applySceneDelta(state, delta);
    deltas++;
    lastT = typeof obj.t === "number" ? obj.t : lastT;
    if (onDelta) {
      onDelta(delta, lastT, state);
    }
  }
  return { state, deltas, lastT, meta };
}

// ---------------------------------------------------------------------------------------------------------
// resolved-tree walk
// ---------------------------------------------------------------------------------------------------------

// The mirror's own composition rules, reproduced here so a probe can answer "what does this node look like on
// screen" without importing the renderer (13k lines, Vue + DOM). Each rule cites the site it mirrors:
//   * GLOBAL TRANSFORM — mirrorRenderer's `gStreamed`: a node with no transform inherits its parent's global; in
//     streamed matrices compose onto their parent's.
//   * HIDDEN — mirrorRenderer's `hidden`: the node's own `visible` flag (plus the ORPHAN hold, a node whose
//     parentId names a node the map does not hold — isOrphanNode).
//   * OPACITY — mirrorRenderer's `modAlpha`/`selfAlpha`: own painted alpha is `(modulate?.a ?? opacity) ×
//     (selfModulate?.a ?? 1)`; the `modulate.a` half CASCADES to children through the nested DOM, the
//     self-modulate half does not (it rides the node's own self-layer).

/** m · n, apply n first (frontend/src/mirror/affine.ts affineMul). */
function affineMul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5]
  ];
}

const IDENTITY = [1, 0, 0, 1, 0, 0];

/**
 * Walk the final state in PAINT ORDER (`state.orderedIds`, the producer's pre-order DFS) resolving each node's
 * global transform, cascaded opacity, hidden-ness and innermost clip ancestor.
 *
 * The callback receives `{ id, node, index, global, ownOpacity, cascadeOpacity, hidden, clipId, depth }`, where
 *   * `global`         — the node's global affine (6-tuple),
 *   * `ownOpacity`     — cascaded × modulate.a × self_modulate.a: the alpha the node's own paint lands at,
 *   * `cascadeOpacity` — what its CHILDREN inherit (cascaded × modulate.a),
 *   * `hidden`         — this node or any ancestor is `visible:false` (or an orphan root),
 *   * `clipId`         — the innermost ancestor (or self) that BOUNDS this node's paint: `clip_contents` on a
 *                        Control, or `clip_children` (Only/AndDraw) on a CanvasItem. null at the stage root.
 */
export function walkResolved(state, visit) {
  const nodes = state.nodes;
  const childIdsByParent = new Map();
  for (const id of state.orderedIds) {
    const node = nodes.get(id);
    if (!node) {
      continue;
    }
    if (node.parentId != null && nodes.has(node.parentId)) {
      let list = childIdsByParent.get(node.parentId);
      if (!list) {
        list = [];
        childIdsByParent.set(node.parentId, list);
      }
      list.push(id);
    }
  }

  let index = 0;
  const seen = new Set();
  const walk = (id, parentGlobal, cascade, ancestorHidden, clipId, depth) => {
    const node = nodes.get(id);
    if (!node || seen.has(id)) {
      return;
    }
    seen.add(id);
    const global = node.transform == null ? parentGlobal : affineMul(parentGlobal, node.transform);
    const orphan = node.parentId != null && !nodes.has(node.parentId);
    const hidden = ancestorHidden || node.visible === false || orphan;
    const modAlpha = node.modulate ? node.modulate.a : node.opacity;
    const selfAlpha = node.selfModulate ? node.selfModulate.a : 1;
    const cascadeOpacity = cascade * modAlpha;
    const ownOpacity = cascadeOpacity * selfAlpha;
    // A node that bounds its descendants becomes the clip owner for the subtree below it. `clip_contents` bounds a
    // Control to its RECTANGLE; `clip_children` (1 Only / 2 AndDraw) stencils descendants against this node's own
    // drawn alpha. Either way, the canvas builder would have to change its clip state to draw across the boundary.
    const clipsChildren = node.clipContents === true || node.clipChildren === 1 || node.clipChildren === 2;
    visit({ id, node, index: index++, global, ownOpacity, cascadeOpacity, hidden, clipId, depth });
    const childClip = clipsChildren ? id : clipId;
    const kids = childIdsByParent.get(id);
    if (kids) {
      for (const kid of kids) {
        walk(kid, global, cascadeOpacity, hidden, childClip, depth + 1);
      }
    }
  };

  for (const id of state.orderedIds) {
    const node = nodes.get(id);
    if (!node || seen.has(id)) {
      continue;
    }
    if (node.parentId != null && nodes.has(node.parentId)) {
      continue; // reached through its parent
    }
    walk(id, IDENTITY, 1, false, null, 0);
  }
}

// ---------------------------------------------------------------------------------------------------------
// paint classification
// ---------------------------------------------------------------------------------------------------------

// The HSV-adjust shaders the mirror renders as an SVG feColorMatrix instead of a WebGL canvas — verbatim from
// frontend/src/mirror/shaderResources.ts (`HSV_SHADER_IDS`). Restated rather than imported because that module
// pulls in Vue + the whole gsw stack, which cannot load under bare Node.
export const HSV_SHADER_IDS = ["res://shaders/hsv.gdshader", "uid://c66gb6g7tup3n"];

export function isHsvShaderNode(node) {
  return node.shaderId != null && HSV_SHADER_IDS.includes(node.shaderId);
}

/** frontend/src/mirror/shaderAttributes.ts `isWebglEligible` (== isWebglShaderNode / isShaderInputNode at the
 *  shaders-on tier the probes assume). */
export function isWebglShaderNode(node) {
  if (node.particleSpec) {
    return false;
  }
  if (!node.shaderId || isHsvShaderNode(node)) {
    return false;
  }
  if (!node.textureUrl && !node.fillColor) {
    return false;
  }
  if (node.textureRegion) {
    return false;
  }
  return true;
}

/** frontend/src/mirror/spineAttributes.ts `isSpineClipNode`, at the product-default `static` spine mode on a tier
 *  that is not `off` (the probes assume a full-quality device — see the doc's approximations). */
export function isSpineClipNode(node) {
  return node.spineSceneResPath != null && Boolean(node.spineCurrentAnim);
}

/**
 * frontend/src/mirror/nodeStyles.ts `nodePaintsContent`, with `renderQuality().shadersEnabled` pinned TRUE (the
 * high tier). `effectiveOpacity` is the node's own painted alpha.
 */
export function nodePaintsContent(node, effectiveOpacity) {
  if (effectiveOpacity <= 0.02) {
    return false;
  }
  if (node.text != null) {
    return true;
  }
  if (isSpineClipNode(node)) {
    return true;
  }
  if (isWebglShaderNode(node) || node.shaderId != null) {
    return true;
  }
  if (node.fillColor != null && node.fillColor.a > 0.02) {
    return true;
  }
  return node.textureUrl != null && node.clipChildren !== 1 && !isWebglShaderNode(node) && node.particleSpec == null;
}

/**
 * Which SOURCE a painting node's pixels come from, for batch-key purposes:
 *   "texture:<url>"  — a sprite/nine-patch/atlas crop off a page image (the batchable case),
 *   "text"           — a Label/RichTextLabel glyph run (its own atlas in any canvas renderer),
 *   "spine"          — a baked Spine clip frame (its own image per clip),
 *   "particles"      — a particle system (its own simulated sprite stream),
 *   "solid"          — a `fill_color` rect / a shader with no texture.
 * Precedence matches nodePaintsContent's own branch order, so a node maps to exactly one source.
 */
export function paintSource(node) {
  if (node.text != null) {
    return "text";
  }
  if (isSpineClipNode(node)) {
    return "spine";
  }
  if (node.particleSpec != null) {
    return "particles";
  }
  if (node.textureUrl != null && node.clipChildren !== 1 && !isWebglShaderNode(node)) {
    return `texture:${node.textureUrl}`;
  }
  if (isWebglShaderNode(node)) {
    return node.textureUrl != null ? `texture:${node.textureUrl}` : "solid";
  }
  return "solid";
}

/** The screen-space AABB of `localRect` under `global` (all four corners, so rotation/scale are handled). */
export function screenAabb(global, localRect) {
  if (!localRect) {
    return null;
  }
  const { x, y, width, height } = localRect;
  if (!(width > 0) || !(height > 0)) {
    return null;
  }
  const [a, b, c, d, e, f] = global;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [lx, ly] of [
    [x, y],
    [x + width, y],
    [x, y + height],
    [x + width, y + height]
  ]) {
    const px = a * lx + c * ly + e;
    const py = b * lx + d * ly + f;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  return Number.isFinite(minX) && Number.isFinite(minY) ? { minX, minY, maxX, maxY } : null;
}

export function aabbIntersects(p, q) {
  return p.minX < q.maxX && q.minX < p.maxX && p.minY < q.maxY && q.minY < p.maxY;
}

// ---------------------------------------------------------------------------------------------------------
// reporting helpers
// ---------------------------------------------------------------------------------------------------------

/** The scene FILE a node belongs to: the nearest ancestor (or self) carrying a `sceneFilePath`. */
export function sceneFileOf(node, nodes) {
  let cur = node;
  for (let i = 0; i < 64 && cur; i++) {
    if (cur.sceneFilePath) {
      return cur.sceneFilePath;
    }
    cur = cur.parentId == null ? null : nodes.get(cur.parentId);
  }
  return null;
}

export function shortName(path) {
  if (!path) {
    return "-";
  }
  return path.split("/").at(-1) ?? path;
}

/** Print a fixed-width table. `cols` is [{ key, label, align }]. */
export function printTable(cols, rows) {
  const widths = cols.map((c) => Math.max(c.label.length, ...rows.map((r) => String(r[c.key] ?? "").length)));
  const line = (cells) =>
    cells.map((cell, i) => (cols[i].align === "r" ? String(cell).padStart(widths[i]) : String(cell).padEnd(widths[i]))).join("  ");
  console.log(line(cols.map((c) => c.label)));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) {
    console.log(line(cols.map((c) => row[c.key] ?? "")));
  }
}

/** p-th percentile of a numeric sample (nearest-rank), 0 for an empty sample. */
export function percentile(sorted, p) {
  if (sorted.length === 0) {
    return 0;
  }
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}
