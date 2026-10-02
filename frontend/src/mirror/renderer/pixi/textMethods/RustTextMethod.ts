import type { PixiTextRecord } from "@godot-scene-web/canvas/pixi";
import type { TextInkRaster, CorpusRow } from "./types";

export interface RustTextResource { key: string; width: number; height: number; pixels: Uint8Array }
/** Carrier is extensible: a future method may return glyph instances rather than Bitmap pixels. */
export type BitmapTextCarrier = {
  resource: { key: string; width: number; height: number };
  pixels: Uint8Array;
  width: number;
  height: number;
  transform: readonly number[];
  alpha?: number;
};
export interface RustTextPrepareOptions {
  inkReadFrequently?: boolean;
  zeroCopyPixels?: boolean;
  replayEvents?: TextInkRaster[];
  corpusRow?: CorpusRow;
  freshCache?: boolean;
  /** Phase 4 carries the source font URL from PreparedTextRun; CSS family is not its identity. */
  fontSource?: { url: string; faceKey: string };
}
export interface RustTextMethod<Carrier> {
  readonly id: string;
  prepare(record: PixiTextRecord, options?: RustTextPrepareOptions): Carrier | null;
  resourceKeys(carrier: Carrier): readonly string[];
  uploads(carrier: Carrier, maxBytes: number): readonly RustTextResource[];
  stats(): Readonly<Record<string, number>>;
  dispose(): void;
}
