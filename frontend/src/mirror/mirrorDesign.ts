import { MIRROR_DESIGN_HEIGHT, MIRROR_DESIGN_WIDTH, MIRROR_MAX_DESIGN_WIDTH } from "@/mirror/sceneTree";

/** The mirror stage's design box, shared with the streaming seat's presentation request. */
export function mirrorDesignSize(frameWidth: number, frameHeight: number, stretchEnabled: boolean): { w: number; h: number } {
  if (!stretchEnabled || frameWidth <= 0 || frameHeight <= 0) {
    return { w: MIRROR_DESIGN_WIDTH, h: MIRROR_DESIGN_HEIGHT };
  }
  const wanted = Math.round(frameWidth / frameHeight * MIRROR_DESIGN_HEIGHT);
  return { w: Math.min(MIRROR_MAX_DESIGN_WIDTH, Math.max(MIRROR_DESIGN_WIDTH, wanted)), h: MIRROR_DESIGN_HEIGHT };
}
