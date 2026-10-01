import {
  DRAW_NINE_PATCH, DRAW_POLYLINE, DRAW_QUAD, DRAW_TEXTURED_MESH,
  createNinePatchView, createPolylineView, createQuadView, createTexturedMeshView,
  type DrawList,
} from "@godot-scene-web/canvas";

/** Lazy-diagnostic payload for actual emitted primitives, independent of the GPU executor. */
export function emittedPrimitiveRows(list: DrawList<string>, start: number, end: number): unknown[] {
  const out: unknown[] = [], q = createQuadView(), n = createNinePatchView(), l = createPolylineView(128), m = createTexturedMeshView(256, 768);
  for (let i = start; i < end; i++) {
    const kind = list.kindAt(i), texture = list.textureAt(i);
    if (kind === DRAW_QUAD) { list.readQuad(i, q); out.push({ kind:"quad", texture, m:[...q.m], wh:[q.w,q.h], src:[q.srcX,q.srcY,q.srcW,q.srcH], rgba:[q.r,q.g,q.b,q.a], blend:q.blend, flip:[q.flipH,q.flipV] }); }
    else if (kind === DRAW_NINE_PATCH) { list.readNinePatch(i, n); out.push({ kind:"nine", texture, m:[...n.m], wh:[n.w,n.h], src:[n.srcX,n.srcY,n.srcW,n.srcH], margins:[n.marginLeft,n.marginTop,n.marginRight,n.marginBottom], rgba:[n.r,n.g,n.b,n.a], blend:n.blend }); }
    else if (kind === DRAW_POLYLINE) { list.readPolyline(i, l); out.push({ kind:"line", points:Array.from(l.points.slice(0,l.pointCount*2)), width:l.width, rgba:[l.r,l.g,l.b,l.a] }); }
    else if (kind === DRAW_TEXTURED_MESH) { list.readTexturedMesh(i, m); out.push({ kind:"mesh", texture, m:[...m.m], positions:Array.from(m.positions.slice(0,m.vertexCount*2)), uvs:Array.from(m.uvs.slice(0,m.vertexCount*2)), indices:Array.from(m.indices.slice(0,m.indexCount)), rgba:[m.r,m.g,m.b,m.a], blend:m.blend }); }
  }
  return out;
}
