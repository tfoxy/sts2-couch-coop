/** Couch chrome in page pixels, fitted to the stream canvas's measured presentation box. */
export function streamChromeGeometry(
  canvas: { left: number; top: number; width: number; height: number },
  presentationWidth: number
) {
  if (canvas.width <= 0 || canvas.height <= 0 || presentationWidth <= 0) return null;
  const scale = canvas.width / presentationWidth;
  const center = canvas.left + canvas.width / 2;
  const size = 80 * scale;
  return {
    scale,
    gear: { left: center - size / 2, top: canvas.top, width: size, height: size },
    fullscreen: { left: center + 52 * scale, top: canvas.top, width: size, height: size }
  };
}
