/** Frame selection shared by DOM intent strips and the canvas intent painter. */
export function intentFrameIndex(elapsedMs: number, fps: number, count: number): number {
  if (count <= 1 || fps <= 0 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  const raw = Math.floor((elapsedMs / 1000) * fps);
  return ((raw % count) + count) % count;
}
