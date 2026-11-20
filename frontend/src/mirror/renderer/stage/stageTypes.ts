/** Semantic text consumed by the Rust stage's Bitmap and MSDF methods. */
export interface StageTextStyle {
  fontFamily?: string | readonly string[];
  fontSize?: number | string;
  fontStyle?: string;
  fontWeight?: string | number;
  fontVariant?: string;
  fontStretch?: string;
  fill?: string | number;
  letterSpacing?: number;
  align?: string;
  wordWrap?: boolean;
  breakWords?: boolean;
  leading?: number;
  lineHeight?: number;
  stroke?: { color?: string | number; width?: number };
  dropShadow?: { color?: string | number; alpha?: number; angle?: number; distance?: number; blur?: number };
}

export interface StageTextRun {
  readonly text: string;
  readonly color?: string;
}

/** One positioned text run at a draw-list painter boundary. */
export interface StageTextRecord {
  readonly key: string;
  readonly labelId?: string;
  readonly insertionIndex: number;
  readonly text: string;
  readonly runs?: readonly StageTextRun[];
  readonly transform: readonly number[];
  readonly style: StageTextStyle;
  readonly contentKey?: string | number;
  readonly resourceRevision?: string | number;
  readonly alpha?: number;
  readonly tint?: number;
  readonly blend?: number;
  readonly parentId?: string;
  readonly localTransform?: readonly number[];
}

export interface StageScenePlan {
  readonly primitives: readonly {
    readonly id: string;
    readonly index: number;
    readonly parentId?: string;
    readonly localTransform?: readonly number[];
  }[];
  readonly groups?: readonly {
    readonly id: string;
    readonly parentId?: string;
    readonly firstIndex: number;
    readonly endIndex: number;
    readonly transform: readonly number[];
    readonly alpha?: number;
    readonly renderGroup?: boolean;
    readonly cacheAsTexture?: boolean;
  }[];
}

interface StageSceneChange<TTexture> {
  readonly id: string;
  readonly transform?: readonly number[];
  readonly alpha?: number;
  readonly tint?: number;
  readonly source?: { readonly texture: TTexture | null; readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

export interface StageScenePatch<TTexture> {
  readonly groups?: readonly Omit<StageSceneChange<TTexture>, "source" | "tint">[];
  readonly primitives?: readonly StageSceneChange<TTexture>[];
}

export interface StageDrawListRendererStats {
  frames: number;
  completedFrames: number;
  objects: number;
  created: number;
  updated: number;
  destroyed: number;
  textures: number;
  frameTextures: number;
  gpuTextures: number;
  gpuTextureSlots: number;
  textureLoads: number;
  textureFailures: number;
  resourcePending: number;
  textRasterizations: number;
  textInvalidations: number;
  refusedEffects: number;
  refusedGlyphs: number;
  blockedPendingFrames: number;
  blockedRefusedFrames: number;
  sceneAdmissions: number;
  scenePatches: number;
  sceneChangedObjects: number;
  scenePreflightFailures: number;
  scenePresentationFailures: number;
  contextReady: boolean;
  presentationValid: boolean;
}
