import {
  createCanvasExecutor,
  createCanvasStage,
  createTextureCache,
  type CanvasExecutor,
  type CanvasStage,
  type CanvasTextureCache,
} from "@godot-scene-web/canvas";

import { stageBackingSize } from "@/mirror/canvas/stageBacking";

/** The class on the stage canvas; kept public for stylesheet and harness probes. */
export const CANVAS_STAGE_CLASS = "mirror-canvas-stage";

export class CanvasBackendUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanvasBackendUnavailable";
  }
}

export interface CanvasStageRuntimeOptions {
  stage: HTMLElement;
  host: HTMLElement;
  stagePixelRatio: () => number;
}

type CanvasExecutorOptions = Parameters<typeof createCanvasExecutor>[0];

export interface CanvasStageResize {
  backingW: number;
  backingH: number;
  snapped: boolean;
  perDesignPx: number;
  changed: boolean;
}

export interface CanvasStageRuntime {
  readonly canvas: HTMLCanvasElement;
  readonly gsStage: CanvasStage;
  readonly gl: WebGL2RenderingContext;
  readonly designBox: () => { w: number; h: number };
  stageScale(): number;
  resize(): CanvasStageResize;
  bindLifecycle(handlers: {
    onLost: () => void;
    onRestored: () => void;
    onResize: (resize: CanvasStageResize) => void;
  }): void;
  createExecutor(options: Pick<CanvasExecutorOptions, "glyphs">): { textures: CanvasTextureCache; executor: CanvasExecutor };
  readonly backingW: number;
  readonly backingH: number;
  readonly backingSnapped: boolean;
  readonly perDesignPx: number;
  readonly contextLosses: number;
  readonly contextRestores: number;
  dispose(): void;
}

/**
 * Renderer-specific resource work supplied to the browser-stage lifecycle.
 *
 * The stage owns the event ordering, backing metrics and drawing-buffer clear;
 * its caller owns the registries whose GL handles must be invalidated. None of
 * these callbacks is a scene-frame acknowledgement path.
 */
export interface CanvasStageLifecyclePorts {
  /** Runs while the context is still logically live, before the paint bank dies. */
  beforeContextLost(): void;
  /** Drops the banked picture after pre-loss clients have released their work. */
  invalidatePaintGuard(): void;
  /** Invalidates executor/cache/resource owners after the bank is gone. */
  afterContextLost(): void;
  /** Rebuilds resource owners after a new context exists. */
  contextRestored(gl: WebGL2RenderingContext): void;
  /** Invalidates resources coupled to a changed backing store. */
  backingChanged(resize: CanvasStageResize): void;
  /** Whether the shared command arena still describes a published frame. */
  hasDrawnFrame(): boolean;
  /** Local, no-ack repaint after a backing-store clear. */
  paintAfterResize(): void;
  /** A retained scene exists and can be rebuilt after context restoration. */
  hasState(): boolean;
  /** Local, no-ack full rebuild/presentation after restoration. */
  rebuildAfterRestore(): void;
}

export interface CanvasStageLifecycle {
  readonly contextLost: boolean;
  readonly backingW: number;
  readonly backingH: number;
  readonly backingSnapped: boolean;
  readonly perDesignPx: number;
  resize(): void;
  /** Clears the backing buffer and invalidates its pre-clear paint bank. */
  clear(): void;
}

/**
 * Owns the canvas element, WebGL stage, backing store and browser lifecycle.
 *
 * Resource owners must release executor/cache state before `dispose()` is called;
 * this runtime only destroys the stage after that ordering has completed. Context
 * callbacks are deliberately late-bound because browsers can notify while the
 * renderer's dependent registries are still being constructed.
 */
export function createCanvasStageRuntime(options: CanvasStageRuntimeOptions): CanvasStageRuntime {
  const { stage, host } = options;
  const canvas = stage.ownerDocument.createElement("canvas");
  canvas.className = CANVAS_STAGE_CLASS;
  canvas.style.position = "absolute";
  canvas.style.left = "0";
  canvas.style.top = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.pointerEvents = "none";
  host.insertBefore(canvas, host.firstChild);

  let onLost: (() => void) | null = null;
  let onRestored: (() => void) | null = null;
  let contextLosses = 0;
  let contextRestores = 0;
  const designBox = (): { w: number; h: number } => ({
    w: stage.clientWidth,
    h: stage.clientHeight,
  });
  const box = designBox();
  const maybeStage: CanvasStage | null = createCanvasStage({
    canvas,
    designWidth: Math.max(1, box.w),
    designHeight: Math.max(1, box.h),
    onContextLost: () => {
      contextLosses++;
      onLost?.();
    },
    onContextRestored: () => {
      contextRestores++;
      onRestored?.();
    },
  });
  if (maybeStage === null) {
    canvas.remove();
    throw new CanvasBackendUnavailable("WebGL2 context creation failed");
  }
  const gsStage: CanvasStage = maybeStage;
  const gl = gsStage.gl;
  let textures: CanvasTextureCache | null = null;
  let executor: CanvasExecutor | null = null;
  let backingW = 0;
  let backingH = 0;
  let backingSnapped = false;
  let perDesignPx = 1;
  let onResize: ((resize: CanvasStageResize) => void) | null = null;

  function resize(): CanvasStageResize {
    const design = designBox();
    if (design.w <= 0 || design.h <= 0) {
      return {
        backingW,
        backingH,
        snapped: backingSnapped,
        perDesignPx,
        changed: false,
      };
    }
    gsStage.setDesignSize(design.w, design.h);
    const sized = stageBackingSize({
      designW: design.w,
      designH: design.h,
      rect: host.getBoundingClientRect(),
      pixelRatio: options.stagePixelRatio(),
    });
    perDesignPx = sized.perDesignPx;
    const changed = sized.backingW !== backingW || sized.backingH !== backingH;
    if (changed) {
      backingW = sized.backingW;
      backingH = sized.backingH;
      backingSnapped = sized.snapped;
      gsStage.setStageSize(backingW, backingH);
      gsStage.applyViewport();
    }
    const result = {
      backingW,
      backingH,
      snapped: backingSnapped,
      perDesignPx,
      changed,
    };
    if (changed) onResize?.(result);
    return result;
  }

  // Preserve the old eager sizing and observe every layout box that can change
  // its answer. Duplicate targets are intentionally collapsed in legacy layout.
  resize();
  const observer =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => resize())
      : null;
  const observed = new Set<Element>([stage, host]);
  if (stage.parentElement) observed.add(stage.parentElement);
  for (const target of observed) observer?.observe(target);

  function destroyStage(): void {
    observer?.disconnect();
    executor?.dispose();
    textures?.dispose();
    executor = null;
    textures = null;
    gsStage.dispose();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    canvas.remove();
  }

  return {
    canvas,
    gsStage,
    gl,
    /**
     * The text runtime creates its stable glyph pass after GL exists, then this
     * stage owns executor/cache construction and warm-up. Disposal below keeps
     * their GL lifetime inseparable from the stage that created them.
     */
    createExecutor(options: Pick<CanvasExecutorOptions, "glyphs">): {
      textures: CanvasTextureCache;
      executor: CanvasExecutor;
    } {
      if (textures !== null || executor !== null) {
        throw new Error("canvas executor already created");
      }
      try {
        textures = createTextureCache(gl);
        executor = createCanvasExecutor({
          gl,
          white: textures.white(),
          glyphs: options.glyphs,
        });
        executor.warmUp();
        return { textures, executor };
      } catch (error) {
        executor?.dispose();
        textures?.dispose();
        executor = null;
        textures = null;
        // Match the original factory fallback: a failed executor leaves no
        // visible canvas, live observer, or GL allocation behind.
        gsStage.dispose();
        gl.getExtension("WEBGL_lose_context")?.loseContext();
        observer?.disconnect();
        canvas.remove();
        throw new CanvasBackendUnavailable(
          `draw-list executor unavailable (${(error as Error)?.message ?? error})`,
        );
      }
    },
    designBox,
    stageScale(): number {
      const designW = designBox().w;
      if (designW <= 0) return 1;
      const renderedW = host.getBoundingClientRect().width;
      return renderedW > 0 ? renderedW / designW : 1;
    },
    resize,
    bindLifecycle(handlers: {
      onLost: () => void;
      onRestored: () => void;
      onResize: (resize: CanvasStageResize) => void;
    }): void {
      onLost = handlers.onLost;
      onRestored = handlers.onRestored;
      onResize = handlers.onResize;
    },
    get backingW() {
      return backingW;
    },
    get backingH() {
      return backingH;
    },
    get backingSnapped() {
      return backingSnapped;
    },
    get perDesignPx() {
      return perDesignPx;
    },
    get contextLosses() {
      return contextLosses;
    },
    get contextRestores() {
      return contextRestores;
    },
    dispose(): void {
      // Frame ownership releases any compiled list before this call. The raw
      // executor/cache order is owned here so no caller can destroy GL first.
      destroyStage();
    },
  };
}

/**
 * Owns browser-facing stage lifecycle after all renderer resource ports exist.
 *
 * `createCanvasStageRuntime` must make the canvas and observe size eagerly so
 * construction failures clean up correctly. This companion is deliberately
 * installed later: only then can a context event invalidate every dependent
 * registry without an initialization-time partial teardown. It centralizes the
 * old resize/loss/restore sequence while leaving backend resource ownership in
 * the caller-provided ports.
 */
export function createCanvasStageLifecycle(
  stage: CanvasStageRuntime,
  ports: CanvasStageLifecyclePorts,
): CanvasStageLifecycle {
  let contextLost = false;
  let backingW = stage.backingW;
  let backingH = stage.backingH;
  let backingSnapped = stage.backingSnapped;
  let perDesignPx = stage.perDesignPx;

  function clear(): void {
    stage.gl.clearColor(0, 0, 0, 0);
    stage.gl.clear(stage.gl.COLOR_BUFFER_BIT);
    // A resize/loss clears the actual framebuffer independently of list or
    // projection identity. Never let a list comparison preserve a blank one.
    ports.invalidatePaintGuard();
  }

  function handleContextLost(): void {
    contextLost = true;
    // Keep the established order: local source selection is released first,
    // then the bank, then every GL-backed resource owner.
    ports.beforeContextLost();
    ports.invalidatePaintGuard();
    ports.afterContextLost();
  }

  function handleContextRestored(): void {
    contextLost = false;
    ports.invalidatePaintGuard();
    // Preserve the legacy mirror reset. The low-level stage keeps its own
    // backing metrics, so an unchanged browser box remains a no-op here and
    // the restore's later full rebuild is its first local presentation.
    backingW = 0;
    backingH = 0;
    stage.resize();
    ports.contextRestored(stage.gl);
    if (ports.hasState()) ports.rebuildAfterRestore();
  }

  stage.bindLifecycle({
    onLost: handleContextLost,
    onRestored: handleContextRestored,
    onResize: (resize) => {
      backingW = resize.backingW;
      backingH = resize.backingH;
      backingSnapped = resize.snapped;
      perDesignPx = resize.perDesignPx;
      ports.backingChanged(resize);
      clear();
      if (ports.hasDrawnFrame()) ports.paintAfterResize();
    },
  });
  // `createCanvasStageRuntime` sizes before this late-bound port exists. The
  // initial drawing buffer still needs the same transparent clear.
  clear();

  return {
    get contextLost() { return contextLost; },
    get backingW() { return backingW; },
    get backingH() { return backingH; },
    get backingSnapped() { return backingSnapped; },
    get perDesignPx() { return perDesignPx; },
    resize: () => { stage.resize(); },
    clear,
  };
}
