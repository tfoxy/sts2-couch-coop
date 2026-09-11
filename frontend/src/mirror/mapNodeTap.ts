// R11 WS-M — MAP TRAVEL FROM THE MIRROR.
//
// A coordinate click on a map point is accepted by the host and then IGNORED — the synthetic press/release pair
// never satisfies the focus handshake a map point requires — so tapping a node on the mirror could never travel.
// That is a pre-existing input-layer fact and is NOT what this module tries to fix. Instead a map-point tap is
// routed as the SEMANTIC action the game already exposes for exactly this — `select-map-node`, a per-seat
// map-travel VOTE — which the host executes against the live map screen, i.e. the same path a real click would
// have reached had it landed.
//
// ADDRESSING. The mirror renders SCENE NODES; it has no idea which row/column a point is, so it cannot build
// spirectl's "map-node:{row}:{col}" id. What it does know is the node's streamed id — which IS the live Godot
// `GetInstanceId()` — so the action carries `args.elementId` and the host resolves it back to the NMapPoint
// (see Sts2ActionHandler.ExecuteSelectMapNode). The element is read off the DOM the renderer already stamps:
// every node element carries `data-scene-file` + `data-scene-root-id`, and a map point is its own scene ROOT
// (`normal_map_point.tscn` / `ancient_map_point.tscn` / `boss_map_point.tscn`), so the root id under the finger IS
// the point's instance id.
//
// LEGALITY is the HOST's call, never this module's: a tap on a non-travelable node (or while travel is disabled, or
// on another player's turn) sends the action and the host refuses it — exactly like tapping it did nothing before.
// A map drawing tool is the one client-side exception: a tap is then a stroke, not a travel.
//
// Self-contained per the mirror decoupling rule: `@/mirror/*` only.

// The scene-file SUFFIX shared by every map-point scene (normal / ancient / boss). A suffix match (the
// endTurnBoxAt / proceed-button idiom) so a path move or a new point variant doesn't silently stop resolving.
export const MAP_POINT_SCENE_FILE_SUFFIX = "map_point.tscn";

// The semantic action id sent to the host. Kebab-case, matching the host's SemanticActionKind matcher.
export const SELECT_MAP_NODE_ACTION_ID = "select-map-node";

// WHERE THE ELEMENT LOOKUP LIVES (M0). "Which map point did you draw at this pixel" is a question about the
// rendered frame, so it is the RENDERER's to answer — `mirrorRenderer.mapNodeAt`, whose DOM backend is the exact
// z-stack walk that used to live here (mirrorRenderer.mapPointElementIdAt: top→bottom, matching
// MAP_POINT_SCENE_FILE_SUFFIX on `data-scene-file`, reading `data-scene-root-id`, stopping at a
// `data-touch-block` so a button drawn over the map keeps its own tap). This module keeps the whole DECISION —
// the kill switch, the armed drawing tool, the action envelope — and now takes the resolution as a collaborator,
// so it works against a canvas backend with no elements to walk.

// The upstream action message: the `{type:"action"}` envelope the host routes through BrowserActionExecutor.
export interface MirrorActionMessage {
  semanticActionId: string;
  args?: Record<string, unknown>;
}

export interface MapNodeTapRouter {
  // Route a TAP at a viewport point. Returns true when the tap was consumed as a `select-map-node` action (the
// caller must then NOT send its coordinate click), false when it isn't a map-point tap or
  // drawing tool is armed, in which case the caller's normal input path runs unchanged.
  (clientX: number, clientY: number): boolean;
}

export function createMapNodeTapRouter(options: {
  sendAction: (message: MirrorActionMessage) => void;
  // Whether a map drawing tool (quill/eraser) is armed — mirrorRenderer.mapDrawingToolActive. Absent = never armed
  // (an unwired engine behaves exactly as if no tool existed).
  drawingToolActive?: () => boolean;
  // The renderer's map-point resolution at a viewport point — mirrorRenderer.mapNodeAt. Absent ⇒ no tap can ever
  // be resolved, so every tap falls through to the ordinary coordinate click (an unwired router is inert).
  mapNodeAt?: (clientX: number, clientY: number) => string | null;
}): MapNodeTapRouter {
  return (clientX: number, clientY: number): boolean => {
    const elementId = options.mapNodeAt?.(clientX, clientY) ?? null;
    if (elementId === null) {
      return false;
    }
    // A tap with the quill/eraser armed is a DRAWING gesture — the game itself doesn't select points then, so
    // routing it as travel would both steal the stroke and travel behind the player's back.
    if (options.drawingToolActive?.() === true) {
      return false;
    }
    options.sendAction({ semanticActionId: SELECT_MAP_NODE_ACTION_ID, args: { elementId } });
    return true;
  };
}
