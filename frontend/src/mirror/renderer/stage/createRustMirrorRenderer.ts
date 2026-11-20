import type { MirrorRenderer } from "@/mirror/renderer/contracts";
import { createStageMirrorRenderer } from "./createStageMirrorRenderer";
import { createRustDrawListExecutor } from "./createRustDrawListExecutor";

/** Reuses Couch's production scene producer, scheduler, resource gates, and interaction runtime. */
export function createRustMirrorRenderer(
  stage: HTMLElement,
  defs: SVGElement,
  canvasHost?: HTMLElement | null,
  onStatus?: (phase: "initializing" | "ready" | "failed", reason?: string) => void,
): MirrorRenderer {
  return createStageMirrorRenderer(stage, defs, canvasHost, onStatus, { createExecutor: createRustDrawListExecutor });
}
