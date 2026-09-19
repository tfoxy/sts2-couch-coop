import type { Affine } from "@/mirror/affine";
import { px } from "@/mirror/stageFit";

export { isLineEraser, isMapStrokeNode } from "@/mirror/renderer/sharedFlightPolicy";

const SVG_NS = "http://www.w3.org/2000/svg";
const EMPTY_ELS: HTMLElement[] = [];
const ZERO_ORIGIN = { x: 0, y: 0 } as const;
const EMPTY_ATTRS: Record<string, string | undefined> = Object.freeze({});

const DEFAULT_LINE_WIDTH = 4;
const LINE_ERASER_STROKE = "#a78a67";

const IDENTITY_G6: Affine = [1, 0, 0, 1, 0, 0];
const CARD_FLIGHT_VFX_TYPE = "NCardFlyShuffleVfx";

let flightLogEnabled =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("flightLog") === "1";
function __setFlightLogForTest(enabled: boolean): void {
  flightLogEnabled = enabled;
}

const TRAIL_REPAINT_MIN_MS = 8;
const TRAIL_MASS_STROKES = 12;
const TRAIL_MASS_FLIGHTS = 6;
const TRAIL_MASS_POINT_CAP = 16;
const TRAIL_MASS_HOLD_MS = 800;
const trailMassBands = 2;
const TRAIL_MASS_PAINT_MS = 1000 / 30;

const trailSurfaceStrokes = 6;
const trailSurfaceLifeMs = 400;
const trailSurfaceNoblendAlpha = 1.3;
const TRAIL_SURFACE_HOLD_MS = 800;

let nextTrailGradientId = 1;
function takeTrailGradientId(): number {
  return nextTrailGradientId++;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function trailBandOpacityTag(
  bands: readonly { opacity: number }[],
  compensated: boolean,
  boosted = false,
): string {
  let tag = boosted ? "b|" : "";
  tag += compensated ? `m${bands.length}|` : "";
  for (const band of bands) tag += `${round4(band.opacity)}|`;
  return tag;
}

// LAYOUT SPACE (stageFit.ts): these are SVG user-space coordinates, and the `<svg>` host is a zero-box wrapper with
// `overflow: visible` whose user space IS the node's local space — display px on the `?stageFit=display` arm. The
// factor is 1 on the default arm, so every emitted string stays byte-identical there.
function linePointsAttr(flat: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2)
    parts.push(`${px(flat[i])},${px(flat[i + 1])}`);
  return parts.join(" ");
}

function opaqueHtml(html: string | null | undefined): string | null {
  if (html == null || html.length === 0) return null;
  return html.length === 9 && html.charCodeAt(0) === 35
    ? html.slice(0, 7)
    : html;
}

export {
  CARD_FLIGHT_VFX_TYPE,
  DEFAULT_LINE_WIDTH,
  EMPTY_ATTRS,
  EMPTY_ELS,
  __setFlightLogForTest,
  flightLogEnabled,
  IDENTITY_G6,
  LINE_ERASER_STROKE,
  SVG_NS,
  TRAIL_MASS_FLIGHTS,
  TRAIL_MASS_HOLD_MS,
  TRAIL_MASS_PAINT_MS,
  TRAIL_MASS_POINT_CAP,
  TRAIL_MASS_STROKES,
  TRAIL_REPAINT_MIN_MS,
  TRAIL_SURFACE_HOLD_MS,
  ZERO_ORIGIN,
  linePointsAttr,
  opaqueHtml,
  round4,
  takeTrailGradientId,
  trailBandOpacityTag,
  trailMassBands,
  trailSurfaceLifeMs,
  trailSurfaceNoblendAlpha,
  trailSurfaceStrokes,
};
