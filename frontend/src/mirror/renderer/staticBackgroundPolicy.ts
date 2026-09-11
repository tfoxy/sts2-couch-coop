// Shared spread/view-scale identities and static-background replacement policy.

import { CLIP_AXIS_CANDIDATE_NAMES, resolveClipAxisOutset } from "@/mirror/clipAxis";
import { nodeTypeLeaf, type MirrorNode } from "@/mirror/sceneTree";
import type { SpreadEnv } from "@/mirror/spreadLayout";
import { uiScalingEnabled } from "@/mirror/uiScaling";
import type { ViewScaleEnv } from "@/mirror/viewScaleLayout";

/** The viewer-facing readability setting applies to both stages. */
export function viewScaleOn(): boolean {
  return uiScalingEnabled();
}

// WS-3: the map screen's DRAWING-TOOLS palette (map_screen.tscn :: DrawingTools), matched by SCENE IDENTITY — the
// owning scene FILE plus the node's scene-relative path, exactly the (file, relPath) tuple the view-scale table keys
// on and the walk stamps as data-scene-file / data-scene-node-path. Identity rather than geometry/type: a 208×68
// 0/0-anchored NinePatchRect is indistinguishable from any ordinary bottom-left corner widget, and those must KEEP
// their corner on a widened stage. The NAME test is a cheap pre-filter (one string compare per anchored node) so the
// allocating scene-identity walk only runs for the handful of nodes that could match. Twin of SpreadIndex.IsDrawingTools.
const MAP_SCREEN_SCENE_FILE = "res://scenes/screens/map/map_screen.tscn";
const DRAWING_TOOLS_NAME = "DrawingTools";
function isDrawingTools(
  id: string,
  node: MirrorNode,
  sceneOf: (id: string) => { file: string; relPath: string } | null
): boolean {
  if (node.name !== DRAWING_TOOLS_NAME) {
    return false;
  }
  const scene = sceneOf(id);
  return scene != null && scene.file === MAP_SCREEN_SCENE_FILE && scene.relPath === DRAWING_TOOLS_NAME;
}

// R19 6b: the MAIN MENU's focus RIBBONS (main_menu.tscn :: ButtonReticleLeft / ButtonReticleRight), matched by the
// same SCENE IDENTITY shape isDrawingTools uses. They are 40x40 TextureRects anchored 0/0 as DIRECT children of the
// menu root, whose transform origins the game rewrites each frame to flank the focused option. Their sibling
// `MainMenuTextButtons` (the option column) is a 0.5/0.5 VBox, so on a widened stage the column claims half the extra
// width while the ribbons — too small for the fullCanvas seam (localRect.width >= parentWidth − 1 is false for 40px)
// — claim 0 and strand at a fixed distance from the stage's LEFT edge: at the 2520 cap they sit 300 design px away
// from the option they are marking. Force the same 0.5 claim so they ride the column's shift.
//
// SCENE IDENTITY, never geometry: a 40x40 0/0-anchored TextureRect is indistinguishable from any ordinary top-left
// corner widget, and those must KEEP their corner — that is the rule the fullCanvas comment documents. The NAME test
// is the same cheap pre-filter (one string compare per anchored node) so the allocating scene walk only runs for the
// handful of nodes that could match. Twin of SpreadIndex.IsMenuReticle.
const MAIN_MENU_SCENE_FILE = "res://scenes/screens/main_menu.tscn";
const MENU_RETICLE_NAMES = new Set(["ButtonReticleLeft", "ButtonReticleRight"]);
function isMenuReticle(
  id: string,
  node: MirrorNode,
  sceneOf: (id: string) => { file: string; relPath: string } | null
): boolean {
  if (node.name == null || !MENU_RETICLE_NAMES.has(node.name)) {
    return false;
  }
  const scene = sceneOf(id);
  // relPath === the name: the ribbons are direct children of the menu ROOT, so a same-named node nested deeper in
  // some other menu scene cannot match.
  return scene != null && scene.file === MAIN_MENU_SCENE_FILE && scene.relPath === node.name;
}

// R20: the ONE-AXIS clip resolve — the third user of the same SCENE IDENTITY shape isDrawingTools / isMenuReticle
// use. A handful of clipping Controls must bound only their VERTICAL axis, because a readability transform in this
// repo makes their subtree wider than the container the game sized for it (see clipAxis.ts for the table, the
// measurement, and why `clip-path` rather than `overflow`). Returns the horizontal outset in design px, or undefined
// for every other node — which is all of them but one today.
//
// TWO cheap gates before the allocating scene walk: the node must actually be a `clip_contents` clipper (a boolean
// field read; false for ~all nodes), and its NAME must be in the table's candidate set (one set probe). Only then is
// the full (file, relPath) identity resolved.
export function clipAxisOutsetFor(
  id: string,
  node: MirrorNode,
  sceneOf: (id: string) => { file: string; relPath: string } | null
): number | undefined {
  if (!node.clipContents || node.name == null || !CLIP_AXIS_CANDIDATE_NAMES.has(node.name)) {
    return undefined;
  }
  const scene = sceneOf(id);
  return resolveClipAxisOutset(scene?.file ?? null, scene?.relPath ?? null) ?? undefined;
}

// R3-Q4: the leaf node types of the full-frame card-PREVIEW containers (a focused card's linked-card preview, e.g.
// Infinite Blades → Shiv). The "Preview" subset of ECHO_CONTAINER — NARROWED to the three PREVIEW classes only, NOT
// the HoverTip/Inspect echoes (those float/zoom differently and must not re-center). Twin of
// SpreadIndex.PreviewContainerTypes.
const PREVIEW_CONTAINER_TYPES = new Set(["NCardPreviewContainer", "NGridCardPreviewContainer", "NMessyCardPreviewContainer"]);
function isPreviewContainer(node: MirrorNode): boolean {
  return PREVIEW_CONTAINER_TYPES.has(nodeTypeLeaf(node.nodeType));
}

// R10/R7: substrings that identify an EVENT background-scene root by its streamed `sceneFilePath` (twin of
// SpreadIndex.BackgroundSceneFilePatterns). STS2 mounts each event backdrop as a single packed scene directly under
// `res://scenes/events/background_scenes/<event>.tscn` (neow, darv, orobas, pael, tanx, vakuu, nonupeipe, tezcatara,
// roomfullofcheese, the_city — confirmed from real streams). Matching that DIRECTORY segment re-centers EVERY event
// backdrop (art + candle flames + neow's point-anchor SpineSprite) as ONE rigid ½Δ subtree. Combat/map/room backdrops
// live under the DIFFERENT `res://scenes/backgrounds/<name>/<name>_background.tscn` convention (none contain
// `events/background_scenes/`), so they are never re-centered here. The legacy "tezcatara" substring is retained
// (subsumed by the directory match) for belt-and-braces safety.
const EVENT_BG_SCENE_PATTERNS = ["events/background_scenes/", "tezcatara"];
function isBackgroundSceneRoot(node: MirrorNode): boolean {
  const path = node.sceneFilePath;
  if (!path) {
    return false;
  }
  const lower = path.toLowerCase();
  for (const pat of EVENT_BG_SCENE_PATTERNS) {
    if (lower.includes(pat)) {
      return true;
    }
  }
  return false;
}

/**
 * The SCENE-IDENTITY half of a {@link SpreadEnv} — the three spread branches that are decided by which `.tscn` a
 * node belongs to rather than by its geometry, with their URL levers folded in.
 *
 * Both backends build their env from this one call (`sceneOf` is each backend's own scene resolver over its own
 * node map), so the levers stay module-private here and the two stages can never disagree about which nodes take
 * the re-centre branches. The two REGISTRY answers — an owner-anchored floater's already-walked shift and a remote
 * follower's hit-test — are backend-specific and are supplied beside this.
 */
export function spreadSceneIdentityEnv(
  sceneOf: (id: string) => { file: string; relPath: string } | null
): Pick<SpreadEnv, "isBackgroundSceneRoot" | "isPreviewContainer" | "forcesCenterClaim"> {
  return {
    isBackgroundSceneRoot,
    isPreviewContainer,
    // WS-3 DRAWING-TOOLS and R19 6b MENU-RIBBON: two small
    // 0/0-anchored widgets the game re-positions each frame against 0.5-anchored content, matched by SCENE
    // IDENTITY (never geometry — an ordinary 0/0 corner widget must keep its corner). See isDrawingTools /
    // isMenuReticle for the measurement behind each. Twin of SpreadIndex's centerClaim.
    forcesCenterClaim: (id, node) => isDrawingTools(id, node, sceneOf) || isMenuReticle(id, node, sceneOf)
  };
}

/**
 * The shared half of a {@link ViewScaleEnv} — the readability setting plus a backend's scene resolver.
 *
 * Both backends build their env from this one call (`sceneOf` is each backend's own resolver over its own node
 * map — `computeSceneInfo` here, `hitTest.resolveSceneInfo` on the canvas side, which is the same ancestor walk
 * character for character), so the two stages can never disagree about which items are enlarged.
 *
 * METHODS, not snapshots: an env built once per renderer must re-read the viewer's current `uiScaling` setting on
 * every call. That is also what makes the master switch reach the CANVAS backend: it builds its env from this same
 * call, so disabling readability scaling empties its stamp map on the very next build.
 */
export function viewScaleSharedEnv(sceneOf: (id: string) => { file: string; relPath: string } | null): ViewScaleEnv {
  return {
    enabled: () => viewScaleOn(),
    sceneOf
  };
}

// STAGE-A "Static background": the COMBAT background scene-root convention —
// `res://scenes/backgrounds/<name>/<name>_background.tscn` (the directory name IS the file stem; the same grammar
// the server's CouchCoopStaticBackgroundProvider.TryParseBackgroundId parses, and deliberately DISJOINT from the
// event `events/background_scenes/` patterns above). The `\1` back-reference is what keeps the per-layer
// sub-scenes (`<name>_bg_NN_*.tscn` / `<name>_fg_*.tscn`, mounted one directory deeper) from matching.
const COMBAT_BG_SCENE_RE = /^res:\/\/scenes\/backgrounds\/([a-z0-9_]+)\/\1_background\.tscn$/;

// Path-only combat-convention test (no parent-chain check) — what the wrapped-combat release arms in BOTH
// backends ask about the CONFIRMED shown-path, whose node may not even be in the map anymore.
export function isCombatBackgroundScenePath(path: string): boolean {
  return COMBAT_BG_SCENE_RE.test(path);
}

// True when `node` is the live COMBAT background scene root: convention path + parent chain `BgContainer` under
// `CombatSceneContainer`. The chain requirement covers a plain CombatRoom AND EventRoom-WRAPPED combat, while
// excluding the MainMenu/RestSite/Merchant screens (they mount background scenes outside any CombatSceneContainer).
// Exported for the staticBackground spec (wire-fixture corpus assertions).
export function isCombatBackgroundSceneRoot(
  node: MirrorNode,
  nodesById: ReadonlyMap<string, MirrorNode>
): boolean {
  const path = node.sceneFilePath;
  if (!path || !COMBAT_BG_SCENE_RE.test(path)) {
    return false;
  }
  const parent = node.parentId != null ? nodesById.get(node.parentId) : undefined;
  if (!parent || parent.name !== "BgContainer") {
    return false;
  }
  const grandparent = parent.parentId != null ? nodesById.get(parent.parentId) : undefined;
  return grandparent != null && grandparent.name === "CombatSceneContainer";
}

// The STRICT event-backdrop convention — `res://scenes/events/background_scenes/<id>.tscn`, the twin of the
// server's BackgroundSceneFamilies.TryParseEventBackgroundId and exactly what the `/bg/events/<id>` grammar can
// serve. Deliberately NARROWER than EVENT_BG_SCENE_PATTERNS above: the loose substring family drives spread
// re-centering (where a nested sub-scene must ride along), while the still replaces exactly ONE published scene
// root, so only the parseable root may be suppressed/held. Exported for StaticBackground.vue's wire fallback.
const EVENT_BG_SCENE_STRICT_RE = /^res:\/\/scenes\/events\/background_scenes\/([a-z0-9_]+)\.tscn$/;
export function tryParseEventBackgroundSceneId(path: string | null | undefined): string | null {
  if (!path) {
    return null;
  }
  const match = EVENT_BG_SCENE_STRICT_RE.exec(path);
  return match ? match[1] : null;
}

// An event backdrop root the static-background setting may replace.
export function isEventBackgroundSceneRoot(node: MirrorNode): boolean {
  return tryParseEventBackgroundSceneId(node.sceneFilePath) !== null;
}

// The ROOMS family: screens whose backdrop is an INLINE subtree of the room
// scene rather than a mounted scene — the merchant shop's SceneContainer/BgContainer (spine + fire shader
// sprites + particles), with the interactive button/inventory OUTSIDE it. Twin of the committed C# table
// (BackgroundSceneFamilies.RoomBackgroundSubtrees); the two must not drift.

const ROOM_BG_SUBTREES: Record<string, string> = {
  "res://scenes/rooms/merchant_room.tscn": "SceneContainer/BgContainer"
};

export function tryParseRoomBackgroundSceneId(path: string | null | undefined): string | null {
  if (!path || ROOM_BG_SUBTREES[path] === undefined) {
    return null;
  }
  const match = /^res:\/\/scenes\/rooms\/([a-z0-9_]+)\.tscn$/.exec(path);
  return match ? match[1] : null;
}

// A room-backdrop SUBTREE root: the named container under `SceneContainer` whose grandparent is a table room's
// scene root. Chain-matched (never geometry): the BgContainer node itself carries no sceneFilePath.
export function isRoomBackgroundSubtreeRoot(
  node: MirrorNode,
  nodesById: ReadonlyMap<string, MirrorNode>
): boolean {
  return roomBackgroundTargetPathOf(node, nodesById) !== null;
}

function roomBackgroundTargetPathOf(
  node: MirrorNode,
  nodesById: ReadonlyMap<string, MirrorNode>
): string | null {
  if (node.name !== "BgContainer") {
    return null;
  }
  const parent = node.parentId != null ? nodesById.get(node.parentId) : undefined;
  if (!parent || parent.name !== "SceneContainer") {
    return null;
  }
  const grandparent = parent.parentId != null ? nodesById.get(parent.parentId) : undefined;
  const path = grandparent?.sceneFilePath;
  return path != null && ROOM_BG_SUBTREES[path] !== undefined ? path : null;
}

// The scene path a node's still would be PUBLISHED under — the identity every static-bg gate keys on. A combat
// or event root answers its own sceneFilePath; a room-backdrop subtree root answers its ROOM's scene path (the
// BgContainer node itself has none — the descriptor names the room). Null for everything else with no
// sceneFilePath. Exported for the canvas backend's skip walk.
export function staticBgTargetPathOf(
  node: MirrorNode,
  nodesById: ReadonlyMap<string, MirrorNode>
): string | null {
  const own = node.sceneFilePath;
  if (own != null) {
    return own;
  }
  return roomBackgroundTargetPathOf(node, nodesById);
}

// Whether the static-background feature covers a scene PATH — what StaticBackground.vue asks about a
// DESCRIPTOR, whose node may not be on the wire at all (the Stage-B steady state streams no bg root). Without
// this predicate includes every supported still family, including descriptors whose root is absent from the wire.
export function staticBgCoversScenePath(path: string): boolean {
  return (
    isCombatBackgroundScenePath(path) ||
    tryParseEventBackgroundSceneId(path) !== null ||
    tryParseRoomBackgroundSceneId(path) !== null
  );
}

// The whole family the "Static background" setting covers: the combat convention (parent-chain-scoped), the
// strict event-backdrop convention, and the room-backdrop subtree table. This is THE predicate for every
// static-bg gate on both render backends.
export function isStaticBackgroundSuppressibleRoot(
  node: MirrorNode,
  nodesById: ReadonlyMap<string, MirrorNode>
): boolean {
  return (
    isCombatBackgroundSceneRoot(node, nodesById) ||
    isEventBackgroundSceneRoot(node) ||
    isRoomBackgroundSubtreeRoot(node, nodesById)
  );
}
