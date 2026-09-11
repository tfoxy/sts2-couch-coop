import { uiScalingEnabled } from "@/mirror/uiScaling";

/** Tip scaling is a viewer-facing readability setting, not a renderer fallback. */
export function tipScaleOn(): boolean { return uiScalingEnabled(); }
