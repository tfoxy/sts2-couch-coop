import type { PixiTextRecord } from "@godot-scene-web/canvas/pixi";

export type TextInkRaster = {
  recordKey: string; resourceKey: string; submissionRevision: number; sceneRevision: number | null;
  startMs: number; endMs: number | null;
  width: number; height: number; rgbaBytes: number; readbackMs: number; failed: boolean;
  requestedInkWillReadFrequently: boolean; inkContextAttributes: CanvasRenderingContext2DSettings | null;
  requestedScratchWillReadFrequently: boolean; scratchContextAttributes: CanvasRenderingContext2DSettings | null;
  inkDrawMs: number | null; scratchConversionMs: number | null; scratchDrawMs: number | null;
  getImageDataMs: number | null; pixelViewMs: number | null; outcome: string;
};
export type CorpusInput = { record: PixiTextRecord; font: string; fontReady: boolean; fontSetStatus: string | null;
  fontAsset: { family: string; url: string; weight: string | null; style: string | null } | null;
  fontFaces: { family: string; style: string; weight: string; stretch: string; status: string }[] };
type CorpusMeasurements = { width: number; actualBoundingBoxAscent: number; actualBoundingBoxDescent: number;
  fontBoundingBoxAscent: number; fontBoundingBoxDescent: number; runAdvances: number[] };
export type CorpusRow = { input: CorpusInput; measurements: CorpusMeasurements | null; diagnostic: TextInkRaster | null;
  width: number | null; height: number | null; rgba: Uint8Array | null };
