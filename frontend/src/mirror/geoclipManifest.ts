/**
 * Couch ships one geoclip wire format: packed `geoclip/1` manifests paired
 * with `verts.bin`. Presentation's reusable parser names that same packed
 * representation `geoclip/2`; this boundary is the single schema rename.
 */
export function asPresentationPackedGeoclip(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const document = raw as Record<string, unknown>;
  const meta = document.meta;
  const vertsBin = document.vertsBin;
  const frames = document.frames;
  if (
    !meta ||
    typeof meta !== "object" ||
    (meta as Record<string, unknown>).schema !== "geoclip/1" ||
    !vertsBin ||
    typeof vertsBin !== "object" ||
    typeof (vertsBin as Record<string, unknown>).file !== "string" ||
    !Array.isArray(frames)
  ) {
    return null;
  }
  for (const frame of frames) {
    const slots = frame && typeof frame === "object" ? (frame as Record<string, unknown>).slots : null;
    if (!slots || typeof slots !== "object") continue;
    if (
      Object.values(slots as Record<string, unknown>).some(
        (slot) => slot && typeof slot === "object" && "verts" in (slot as Record<string, unknown>)
      )
    ) {
      return null;
    }
  }
  return { ...document, meta: { ...(meta as Record<string, unknown>), schema: "geoclip/2" } };
}
