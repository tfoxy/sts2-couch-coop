// Ambient module declarations for the shipped @spirectl/presentation renderer.
//
// During dev this package is consumed as a SOURCE link (Vite resolve.alias →
// ../../spirectl/presentation/web/src; see vite.config.ts), and it ships no
// built .d.ts in that checkout. Rather than have `vue-tsc` deep-type-check the library's
// own source under this app's stricter config (which is the library's concern, checked in
// its own repo), we declare the module boundary here — the honest equivalent of trusting a
// published package's shipped types. Keep these in sync with the entry points this app
// imports: only the surface couch-coop actually uses is declared. The mirror is the only
// consumer, and it imports `@spirectl/presentation/render` and nothing else.

declare module "@spirectl/presentation/render" {
  export interface PresentationActionBinding {
    path: string;
    action: Record<string, unknown>;
    disabled: boolean;
    // Present only when the catalog declares an `onPress.local` block: `apply` is a map of dotted
    // state path → resolved value the host writes client-side (device-local view changes); `sendToHost`
    // (default true) is whether the action must still be sent to the game. Absent ⇒ send, no local change.
    local?: { apply: Record<string, unknown>; sendToHost: boolean };
  }
  export type RootSceneResolver = (ctx: {
    state: unknown;
    catalog: unknown;
  }) => string | undefined;

  // The STS2 custom BBCode tag table (color aliases like [gold]/[red] + no-op effect tags). Pure data;
  // the mirror passes it to richTextLayeredHtml as `customTags`.
  export const DEFAULT_BBCODE_TAGS: Record<
    string,
    | { kind: "color"; value: string }
    | { kind: "style"; css: Record<string, string> }
    | {
        kind: "effect";
        perChar?: boolean;
        perWord?: boolean;
        className?: string;
      }
  >;

  // Global presentation font-size scale (1.08). The mirror drives `--godot-text-scale` to this and emits font
  // sizes as `calc(px * var(--godot-text-scale, 1))`.
  export const DEFAULT_TEXT_SCALE: number;

  // Decorative-animation vocabulary (web/src/render/animations.ts). The mirror
  // reproduces animators it froze game-side (energy/star orb spin `rotate`, enemy-intent `bob`) by applying a
  // single binding per node. Only the fields the mirror emits are declared here (path is unused by the
  // per-element apply but kept for shape-compatibility with the DOM-scan `applyAnimationBindings`).
  // `kind` is the animation vocabulary token. Known values the mirror emits or may receive:
  // `rotate` (orb spin), `bob` (enemy intent), `flameFlicker` (candle fire), `pivotPulse` (map point),
  // `rock` (a ±`amplitudeRad` rotation oscillation about `pivotX`/`pivotY`, `durationMs` = the FULL period) and
  // `glowPulse` (an `alphaFrom`→`alphaTo` opacity breathe).
  export interface PresentationAnimationBinding {
    path: string;
    kind: string;
    durationMs?: number;
    amplitudePx?: number;
    baselineUpPx?: number;
    // `rock`: peak rotation excursion in RADIANS (the sweep is ±this about the pivot).
    amplitudeRad?: number;
    // `glowPulse`: the opacity extrema of the breathe.
    alphaFrom?: number;
    alphaTo?: number;
    delayMs?: number;
    // `pivotPulse` (WS-E map-point pulse): the sweep's scale extrema, and the node's PIVOT expressed in the space
    // its baked `matrix()` maps INTO (bakedMatrix · pivotLocal, px). The pulse composes `scale:` + `translate:`
    // individual properties onto an element that already carries the baked matrix; the translate is what anchors
    // the scale at the pivot instead of at the matrix origin (see animations.ts PIVOT_PULSE). `pivotX`/`pivotY`
    // serve the same role for `rotate`/`rock` (the rotation's centre in that same baked space).
    scaleFrom?: number;
    scaleTo?: number;
    pivotX?: number;
    pivotY?: number;
    loop?: boolean;
  }
  // `compose` (bob only) drives the individual `translate:` property instead of the
  // `transform:` shorthand, so the animation composes with a baked matrix.
  export interface PresentationAnimationOptions {
    compose?: boolean;
  }
  // Inject the shared @keyframes once per document (idempotent); call before applyAnimationBinding.
  export function ensureAnimationStyles(root: ParentNode): void;
  // Apply one decorative animation directly to an element (per-element extract of applyAnimationBindings' loop
  // body). Returns true when a known kind was applied. The default keyframes use the `transform:` shorthand
  // (rotate spins about the element center), so the mirror applies the ROTATE case to a self-layer CHILD (local
  // space) whose parent carries the baked global matrix. `opts.compose` (bob only) uses the individual `translate:`
  // property keyframe, which COMPOSES with a baked `transform` matrix (a translation is origin-independent), so the
  // mirror bobs a leaf element directly. Compose is NOT valid for rotate (it would orbit).
  export function applyAnimationBinding(
    el: HTMLElement,
    binding: PresentationAnimationBinding,
    opts?: PresentationAnimationOptions,
  ): boolean;
  // DOM-scan apply (unused here; the mirror applies per-element): every binding whose `path` matches a node
  // under `root`.
  // Returns the set of paths that were animated. Same options as the per-element apply.
  export function applyAnimationBindings(
    root: ParentNode,
    bindings:
      | readonly PresentationAnimationBinding[]
      | Record<string, unknown>
      | null
      | undefined,
    opts?: PresentationAnimationOptions,
  ): Set<string>;

  // The play-zone line in 1080-design px (web/src/render/targeting.ts). The mirror reproduces the
  // game's "a dragged card is in the play zone" predicate (mouse Y above this line) from the held finger's Y, to
  // lift a touch-dragged card only while it's being played. `dragStartY` null = the shortcut start (loosens the zone).
  export function playZoneThreshold(
    viewportHeight: number,
    dragStartY: number | null,
  ): number;
}

declare module "@spirectl/presentation/spine" {
  export interface SpineDiagnostic {
    readonly code: string;
    readonly path: string;
    readonly message: string;
  }
  export type SpineResult<T> =
    | {
        readonly ok: true;
        readonly value: T;
        readonly diagnostics: readonly [];
      }
    | {
        readonly ok: false;
        readonly value: null;
        readonly diagnostics: readonly SpineDiagnostic[];
      };
  export interface SpinePlacement {
    readonly canvasWidth: number;
    readonly canvasHeight: number;
    readonly localX: number;
    readonly localY: number;
    readonly localWidth: number;
    readonly localHeight: number;
  }
  export interface RasterSpineFrame {
    readonly index: number;
    readonly offsetX: number;
    readonly offsetY: number;
    readonly width: number;
    readonly height: number;
    readonly durationMs: number;
    readonly startMs: number;
    readonly imageBytes: Uint8Array;
  }
  export interface RasterSpineClip extends SpinePlacement {
    readonly totalDurationMs: number;
    readonly frames: readonly RasterSpineFrame[];
  }
  export interface RasterSpineFrameSample {
    readonly frameIndex: number;
    readonly frame: RasterSpineFrame;
    readonly placement: SpinePlacement;
  }
  export interface SpineTextureSource {
    readonly uri: string;
    readonly mimeType?: string;
  }
  export interface GeoclipPlacement extends SpinePlacement {
    readonly fitScale: number;
  }
  export interface Geoclip {
    readonly fps: number;
    readonly durationMs: number;
    readonly frames: readonly unknown[];
    readonly pages: readonly {
      readonly id: string;
      readonly width: number;
      readonly height: number;
      readonly source: SpineTextureSource;
    }[];
    readonly vertexBin: { readonly source: SpineTextureSource } | null;
  }
  export interface GeoclipMesh {
    readonly drawOrder: number;
    readonly slotIndex: number;
    readonly partId: string;
    readonly texture: SpineTextureSource;
    readonly positions: Float32Array;
    readonly uvs: Float32Array;
    readonly indices: Uint32Array;
    readonly tint: readonly [number, number, number, number];
    readonly blendMode: number;
    readonly placement: GeoclipPlacement | null;
  }
  export interface GeoclipFrameSample {
    readonly frameIndex: number;
    readonly meshes: readonly GeoclipMesh[];
    readonly placement: GeoclipPlacement | null;
  }
  export interface RecoveringGeoclipPage {
    readonly id: string;
    readonly file: string;
    readonly width: number;
    readonly height: number;
  }
  export interface RecoveringGeoclipPart {
    readonly id: string;
    readonly pageId: string;
    readonly srcRect: readonly [number, number, number, number] | null;
    readonly indices: readonly number[];
    readonly uvs: readonly number[];
    readonly refVerts: Float32Array;
    readonly rigid: boolean;
    readonly blendMode: number;
  }
  export interface RecoveringGeoclipSlot {
    readonly part: string | null;
    readonly color: readonly [number, number, number, number] | null;
    readonly xform:
      | readonly [number, number, number, number, number, number]
      | null;
    readonly verts: Float32Array | null;
    readonly vref: number | null;
  }
  export interface RecoveringGeoclipFrame {
    readonly drawOrder: readonly number[] | null;
    readonly slots: ReadonlyMap<number, RecoveringGeoclipSlot>;
  }
  export interface RecoveringGeoclipVertexBin {
    readonly file: string;
    readonly records: number;
    readonly offsets: readonly number[];
    readonly quant: ReadonlyMap<
      string,
      readonly [number, number, number, number]
    >;
  }
  export interface RecoveringGeoclipPlacement {
    readonly canvasWidth: number;
    readonly canvasHeight: number;
    readonly localX: number;
    readonly localY: number;
    readonly localWidth: number;
    readonly localHeight: number;
    readonly fitScale: number;
  }
  export interface RecoveringGeoclip {
    readonly schema: string;
    readonly anim: string | null;
    readonly fps: number;
    readonly frameCount: number;
    readonly durationMs: number;
    readonly pages: readonly RecoveringGeoclipPage[];
    readonly parts: ReadonlyMap<string, RecoveringGeoclipPart>;
    readonly frames: readonly RecoveringGeoclipFrame[];
    readonly vertsBin: RecoveringGeoclipVertexBin | null;
    readonly placement: RecoveringGeoclipPlacement | null;
  }
  export interface RecoveringGeoclipMesh {
    readonly drawOrder: number;
    readonly slotIndex: number;
    readonly partId: string;
    readonly part: RecoveringGeoclipPart;
    readonly slot: RecoveringGeoclipSlot;
    readonly positions: Float32Array;
  }
  export interface RecoveringGeoclipFrameSample {
    readonly frameIndex: number;
    readonly meshes: readonly RecoveringGeoclipMesh[];
  }
  export interface GeoclipRecoveryReport<T> {
    readonly value: T | null;
    readonly diagnostics: readonly SpineDiagnostic[];
    readonly recovered: boolean;
  }
  export function parseRasterSpineClip(
    input: ArrayBuffer | Uint8Array,
  ): SpineResult<RasterSpineClip>;
  export function sampleRasterSpineClip(
    clip: RasterSpineClip,
    timeMs: number,
    loop?: boolean,
    skipLoopEndpoint?: boolean,
  ): SpineResult<RasterSpineFrameSample>;
  export function parseGeoclip(
    raw: unknown,
    resolve: (file: string) => SpineTextureSource,
  ): SpineResult<Geoclip>;
  export function applyGeoclipVerts(
    clip: Geoclip,
    input: ArrayBuffer | Uint8Array,
  ): SpineResult<Geoclip>;
  export function sampleGeoclip(
    clip: Geoclip,
    timeMs: number,
    loop?: boolean,
    skipLoopEndpoint?: boolean,
  ): SpineResult<GeoclipFrameSample>;
  export function recoverGeoclip(
    raw: unknown,
  ): GeoclipRecoveryReport<RecoveringGeoclip>;
  export function recoverGeoclipVerts(
    clip: RecoveringGeoclip,
    input: ArrayBuffer | Uint8Array,
  ): GeoclipRecoveryReport<RecoveringGeoclip>;
  export function recoveringGeoclipFrameIndexAt(
    clip: {
      readonly frames: readonly unknown[];
      readonly fps: number;
      readonly durationMs?: number;
    },
    timeMs: number,
    loop?: boolean,
    skipLoopEndpoint?: boolean,
  ): number;
  export function sampleRecoveringGeoclipFrame(
    clip: RecoveringGeoclip,
    frameIndex: number,
  ): RecoveringGeoclipFrameSample;
  export function applyGeoclipTransform(
    positions: Float32Array,
    transform: readonly [number, number, number, number, number, number] | null,
  ): Float32Array;
  export function foldGeoclipUvs(
    sourceUvs: ArrayLike<number>,
    sourceRect: readonly [number, number, number, number],
    pageWidth: number,
    pageHeight: number,
  ): Float32Array;
}
