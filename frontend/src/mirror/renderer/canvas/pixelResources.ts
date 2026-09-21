import type {
  CanvasTextureCache,
  ExecutorTexture,
  QuadView,
} from "@godot-scene-web/canvas";

import { atlasDecodedSource } from "@/mirror/atlasBaker";
import {
  createAtlasRepack,
} from "@/mirror/canvas/atlasRepack";
import {
  TEXTURE_PACE_BYTES_DEFAULT,
  TEXTURE_PACE_COUNT_DEFAULT,
  TEXTURE_RESIDENT_BYTES_DEFAULT,
  TEXTURE_TINY_BYTES_DEFAULT,
  createTextureBridge,
  type TextureBridge,
} from "@/mirror/canvas/textureBridge";
import { handRaiseChromeMatrix } from "@/mirror/handRaiseChrome";
import type { CanvasHandRaiseChrome } from "@/mirror/renderer/contracts";
import { MIRROR_DESIGN_WIDTH } from "@/mirror/sceneTree";
import type { NodePaintInput, PaintSink } from "@/mirror/canvas/paintSpec";
import type { PaintScratch } from "@/mirror/canvas/paintSpec";
import type { TextSurfaceRegistry } from "@/mirror/canvas/textSurfaces";
import type { FxSurfaceRegistry } from "@/mirror/canvas/fxSurfaces";
import type { SpineSurfaceRegistry } from "@/mirror/canvas/spineSurfaces";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import {
  isStaticBackgroundSuppressibleRoot,
  staticBgTargetPathOf,
} from "@/mirror/renderer/staticBackgroundPolicy";
import type { MirrorState } from "@/mirror/sceneTree";

export interface PixelResourceOptions {
  cache: CanvasTextureCache;
  gl: WebGL2RenderingContext;
  /** The stage design width used by the in-list static-background prefix. */
  designWidth(): number;
  fx: FxSurfaceRegistry | null;
  spine: SpineSurfaceRegistry | null;
  text: TextSurfaceRegistry | null;
  /** A local repaint only. This callback must never acknowledge a scene frame. */
  onPixelsChanged(): void;
}

function maxTextureSize(gl: WebGL2RenderingContext): number {
  try {
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    return typeof max === "number" && Number.isFinite(max) && max > 0 ? max : 0;
  } catch {
    return 0;
  }
}

/**
 * Canvas-only image ownership: the bridge is the sole page/atlas resident
 * authority and all ready callbacks deliberately feed only local paint work.
 */
export function createPixelResources(options: PixelResourceOptions) {
  const { cache, gl } = options;
  const pace = { bytes: undefined, count: undefined };
  const paceTiny = undefined;
  const resident = TEXTURE_RESIDENT_BYTES_DEFAULT;
  const maxTextureDim = maxTextureSize(gl);
  // The static background is one more bridge client, not composer state. Its
  // readiness callback can only request a local repaint; it deliberately has
  // no route to scene acknowledgement.
  let staticBackground: ReturnType<typeof createCanvasStaticBackgroundResources> | null = null;
  const bridge: TextureBridge = createTextureBridge({
    cache,
    onResolved: (url) => {
      staticBackground?.noteResolved(url);
      options.onPixelsChanged();
    },
    onFailed: (url) => staticBackground?.noteFailed(url),
    onPaced: options.onPixelsChanged,
    paceBytes: pace.bytes,
    paceCount: pace.count,
    paceTinyBytes: paceTiny,
    decodedPageSource: atlasDecodedSource,
    maxTextureDim,
    fx: options.fx ?? undefined,
    spine: options.spine ?? undefined,
    text: options.text ?? undefined,
    repack: (host) => createAtlasRepack({ cache, host, maxTextureDim }),
    residentBytes: resident,
  });
  const configuredStaticBackground = createCanvasStaticBackgroundResources({
    bridge,
    designWidth: options.designWidth,
    onPixelsChanged: options.onPixelsChanged,
  });
  staticBackground = configuredStaticBackground;

  const chromeKey = "client://hand-raise";
  let chrome: CanvasHandRaiseChrome | null = null;
  let chromeHeld = false;
  let chromeRevision = -1;
  const chromeSource = {
    emit(
      input: NodePaintInput,
      scratch: PaintScratch,
      sink: PaintSink,
    ): number {
      if (chrome === null) return 0;
      let handle = cache.peek(chromeKey);
      if (!handle) {
        handle = cache.acquire(chromeKey, chrome.source);
        chromeHeld = true;
        chromeRevision = chrome.revision;
      } else if (chrome.revision !== chromeRevision) {
        handle = cache.update(chromeKey, chrome.source);
        chromeRevision = chrome.revision;
      }
      bridge.bindStageTexture(chromeKey, handle);
      const designWidth =
        input.renderWidthOverride && input.renderWidthOverride > 0
          ? input.renderWidthOverride
          : (input.node.localRect?.width ?? MIRROR_DESIGN_WIDTH);
      const view = scratch.quad;
      const m = handRaiseChromeMatrix(input.global, designWidth, chrome);
      for (let i = 0; i < 6; i++) view.m[i] = m[i];
      view.w = chrome.width;
      view.h = chrome.height;
      view.srcX = 0;
      view.srcY = 0;
      view.srcW = chrome.source.width;
      view.srcH = chrome.source.height;
      view.r = input.ownOpacity;
      view.g = input.ownOpacity;
      view.b = input.ownOpacity;
      view.a = input.ownOpacity;
      view.blend = 0;
      view.flipH = false;
      view.flipV = false;
      view.hasColorMatrix = false;
      sink.quad(view, chromeKey);
      return 1;
    },
  };

  return {
    bridge,
    /** Canvas-only static-background selection, suppression and residency. */
    staticBackground: configuredStaticBackground,
    pace,
    paceTiny,
    residentBytes: resident,
    maxTextureDim,
    repackEnabled: true,
    chromeSource,
    get chrome(): CanvasHandRaiseChrome | null {
      return chrome;
    },
    get chromeHeld(): boolean {
      return chromeHeld;
    },
    setChrome(next: CanvasHandRaiseChrome | null): void {
      chrome = next;
      if (next === null && chromeHeld) {
        cache.release(chromeKey);
        chromeHeld = false;
        chromeRevision = -1;
      }
    },
    /** The selected static source survives a lost GL context, its residency does not. */
    staticBackgroundContextLost(): void {
      configuredStaticBackground.contextLost();
    },
    /** Reset bridge residency after the shared cache has dropped dead GL handles. */
    contextLost(): void {
      chromeHeld = false;
      chromeRevision = -1;
      bridge.invalidate();
    },
    beginBuild(): void {
      bridge.beginStageTextureBuild();
    },
    endBuild(): void {
      bridge.endBuild();
    },
    /**
     * Commit background readiness only after the enclosing frame candidate was
     * admitted. A strict pending candidate still closes the bridge build, but
     * must not promote a source from a list that will never publish.
     */
    finalizeStaticBackgroundBuild(): void {
      // A paced bridge release can make the just-emitted background resident.
      // Keep this before snapshot publication, with the other resource census.
      configuredStaticBackground.noteBuildReady();
    },
    patchChrome(
      next: CanvasHandRaiseChrome,
      command: number,
      input: NodePaintInput | null,
      list: {
        patchQuadTransform(command: number, transform: readonly number[]): void;
      },
    ): boolean {
      if (command < 0 || input === null || !chromeHeld) return false;
      let handle: ExecutorTexture | undefined = cache.peek(chromeKey);
      if (!handle) return false;
      if (next.revision !== chromeRevision) {
        handle = cache.update(chromeKey, next.source);
        chromeRevision = next.revision;
      }
      bridge.bindStageTexture(chromeKey, handle);
      const designWidth =
        input.renderWidthOverride && input.renderWidthOverride > 0
          ? input.renderWidthOverride
          : (input.node.localRect?.width ?? MIRROR_DESIGN_WIDTH);
      list.patchQuadTransform(
        command,
        handRaiseChromeMatrix(input.global, designWidth, next),
      );
      chrome = next;
      return true;
    },
    dispose(): void {
      if (chromeHeld) cache.release(chromeKey);
      chromeHeld = false;
      bridge.dispose();
    },
  };
}

export const TEXTURE_PACE_DEFAULTS = {
  bytes: TEXTURE_PACE_BYTES_DEFAULT,
  count: TEXTURE_PACE_COUNT_DEFAULT,
  tiny: TEXTURE_TINY_BYTES_DEFAULT,
} as const;

/** Canvas-only static-picture state; DOM background state deliberately remains separate. */
export function createCanvasStaticBackgroundResources(options: {
  bridge: TextureBridge;
  designWidth(): number;
  onPixelsChanged(): void;
}) {
  let shown: string | null = null;
  let active: { scenePath: string; url: string } | null = null;
  let pending: { scenePath: string; url: string } | null = null;
  let ready = false;
  let command = -1;
  let preloadCommand = -1;
  let failures = 0;
  let readyCallback: ((ready: boolean) => void) | undefined;
  let readyCallbackUrl: string | null = null;
  const resolvedUrls = new Set<string>();
  const skipRoots = new Set<string>();
  const view: QuadView = {
    m: new Float32Array(6),
    w: 2520,
    h: 1080,
    srcX: 0,
    srcY: 0,
    srcW: 2520,
    srcH: 1080,
    r: 1,
    g: 1,
    b: 1,
    a: 1,
    blend: 0,
    flipH: false,
    flipV: false,
    hasColorMatrix: false,
    colorMatrix: new Float32Array(9),
  };
  const source = () => active ?? pending;
  const push = (
    buildList: { pushQuad(view: QuadView, texture: string): number },
    item: { scenePath: string; url: string },
    alpha: number,
  ) => {
    options.bridge.sizeOf(item.url);
    view.m[0] = 1;
    view.m[1] = 0;
    view.m[2] = 0;
    view.m[3] = 1;
    view.m[4] = (options.designWidth() - 2520) / 2;
    view.m[5] = 0;
    view.a = alpha;
    return buildList.pushQuad(view, item.url);
  };
  return {
    get skipRoots(): ReadonlySet<string> {
      return skipRoots;
    },
    get active() {
      return active;
    },
    get pending() {
      return pending;
    },
    get ready() {
      return ready;
    },
    get command() {
      return command;
    },
    get preloadCommand() {
      return preloadCommand;
    },
    get failures() {
      return failures;
    },
    noteResolved(url: string): void {
      if (url === active?.url || url === pending?.url) resolvedUrls.add(url);
    },
    noteFailed(url: string): void {
      if (pending?.url !== url) return;
      ready = false;
      failures++;
      if (readyCallbackUrl === url) readyCallback?.(false);
    },
    /** A lost GL context invalidates residency, but not the selected source. */
    contextLost(): void {
      ready = false;
      resolvedUrls.clear();
    },
    emit(buildList: {
      pushQuad(view: QuadView, texture: string): number;
    }): void {
      const item = source();
      command =
        item === null ? -1 : push(buildList, item, active === null ? 0 : 1);
      preloadCommand = -1;
      if (active !== null && pending !== null)
        preloadCommand = push(buildList, pending, 0);
      else if (active === null) preloadCommand = command;
    },
    noteBuildReady(): void {
      if (
        pending !== null &&
        preloadCommand >= 0 &&
        resolvedUrls.has(pending.url) &&
        options.bridge.isResident(pending.url)
      ) {
        active = pending;
        pending = null;
        ready = false;
        options.onPixelsChanged();
        return;
      }
      if (
        command < 0 ||
        active === null ||
        !options.bridge.isResident(active.url) ||
        ready
      )
        return;
      ready = true;
      if (readyCallbackUrl === active.url) readyCallback?.(true);
    },
    // Canvas twin of the DOM build hold. Image readiness is not consulted: every covered root stays out of the
    // draw list while the setting is on, including pending, failed, and timed-out stills.
    refresh(next: MirrorState, _at: number): void {
      skipRoots.clear();
      if (!mirrorSettings.staticBgEnabled) return;
      for (const node of next.nodes.values()) {
        if (
          staticBgTargetPathOf(node, next.nodes) === null ||
          !isStaticBackgroundSuppressibleRoot(node, next.nodes)
        )
          continue;
        skipRoots.add(node.id);
      }
    },
    setShown(scenePath: string | null): boolean {
      if (shown === scenePath) return false;
      shown = scenePath;
      return true;
    },
    setSource(
      next: { scenePath: string; url: string } | null,
      callback?: (ready: boolean) => void,
    ): boolean {
      const activeSame =
        next?.scenePath === active?.scenePath && next?.url === active?.url;
      const pendingSame =
        next?.scenePath === pending?.scenePath && next?.url === pending?.url;
      readyCallback = callback;
      readyCallbackUrl = next?.url ?? null;
      if (activeSame) {
        pending = null;
        ready = active !== null && options.bridge.isResident(active.url);
        if (ready) callback?.(true);
        return true;
      }
      if (pendingSame) return false;
      if (next === null) {
        active = null;
        pending = null;
      } else pending = next;
      ready = false;
      command = -1;
      preloadCommand = -1;
      return true;
    },
  };
}
