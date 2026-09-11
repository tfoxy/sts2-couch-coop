// Compatibility façade for the imperative DOM mirror renderer. Keep this export surface stable for callers.

export type {
  CanvasHandRaiseChrome,
  FullWalkCause,
  HandRaiseUiLayer,
  InteractiveRect,
  MirrorRenderer,
  ReconcilePull,
  SpreadPainter,
  TouchStack
} from "@/mirror/renderer/contracts";
export { domSpreadPainterAt, domTouchStackAt, mapPointElementIdAt } from "@/mirror/renderer/domHitProbes";
export {
  HAND_CHOICE_NAMES,
  HAND_CHOICE_TYPES,
  PAINT_ANCHOR_EXCLUDED_NAMES,
  PAINT_ANCHOR_EXCLUDED_TYPES,
  PROCEED_BUTTON_SCENE_FILE_SUFFIX,
  REMOTE_FOLLOWER_TYPES,
  TOUCH_TARGET_TYPES,
  confirmTapEligible,
  isBlockingButtonType,
  isCombatPileContainer,
  isDecorativeOverlay,
  isEchoContainer,
  isHitTestExcluded,
  isScrollbarBlockType,
  nodeTypeLeaf,
  scrollbarBlockKind,
  type TouchBlockKind
} from "@/mirror/renderer/interactionPolicy";
export {
  isCombatBackgroundScenePath,
  isCombatBackgroundSceneRoot,
  isEventBackgroundSceneRoot,
  isRoomBackgroundSubtreeRoot,
  isStaticBackgroundSuppressibleRoot,
  spreadSceneIdentityEnv,
  staticBgCoversScenePath,
  staticBgTargetPathOf,
  tryParseEventBackgroundSceneId,
  tryParseRoomBackgroundSceneId,
  viewScaleOn,
  viewScaleSharedEnv
} from "@/mirror/renderer/staticBackgroundPolicy";
export {
  mirrorWalkStats,
  setStaticStillCountersGauge,
  setStaticStillGauge,
  type FlightAnimFailReason,
  type FlightRetireReason,
  type MirrorStaticStillCounters,
  type MirrorWalkStats
} from "@/mirror/renderer/walkStats";
export { isLineEraser, isMapStrokeNode } from "@/mirror/renderer/sharedFlightPolicy";
export { __resetAtlasDecodeGateForTest } from "@/mirror/renderer/dom/atlasRuntime";
export { __setFlightLogForTest } from "@/mirror/renderer/dom/flightTrailPolicy";
export { backstopCoverPath, __setCanvasSnapshotSourceForTest } from "@/mirror/renderer/dom/walkModel";
export { intentFrameIndex } from "@/mirror/renderer/intentPolicy";
export type { CanvasSnapshotSource } from "@/mirror/renderer/dom/walkModel";
export { TARGETING_TYPES } from "@/mirror/raise/constants";
export { CREATURE_HUD_NAMES, CREATURE_INTENT_GAP, CREATURE_POWER_ROW_H, CREATURE_POWER_TOP_FALLBACK, CREATURE_RETICLE_TOP_FALLBACK, CREATURE_SCENE_FILE_SUFFIX, HAND_CONTAINER_NAME, HAND_HOLDER_TYPE, HAND_RAISE_PX, HAND_RAISE_RAMP_END_Y, HAND_RAISE_RAMP_START_Y, HAND_ROOT_TYPE } from "@/mirror/raise/constants";
export { createDomMirrorRenderer as createMirrorRenderer } from "@/mirror/renderer/dom/createDomMirrorRenderer";
