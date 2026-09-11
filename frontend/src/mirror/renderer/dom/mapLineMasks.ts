import type { Affine } from "@/mirror/affine";

type LineMaskGroup = {
  mask: SVGElement | null;
  base: SVGRectElement | null;
  href: string;
  erasers: Map<string, { line: SVGPolylineElement; box: readonly number[] | null }>;
  pens: Map<string, readonly number[]>;
  regionSig: string;
};

export type LineMaskRecord = { linePolyline: SVGPolylineElement | null };

/** Per-renderer map-quill mask state. `recordFor` deliberately exposes only the stroke DOM seam. */
export function createMapLineMasks(defs: SVGElement, recordFor: (id: string) => LineMaskRecord | undefined) {
  const lineMaskGroups = new Map<string, LineMaskGroup>();
  const lineMaskOwners = new Map<string, string>();
  const mapStrokeLocals = new Map<string, Affine>();

  function pinnedStrokeLocal(id: string, local: Affine): Affine {
    const latched = mapStrokeLocals.get(id);
    if (latched !== undefined) return latched;
    const own: Affine = [local[0], local[1], local[2], local[3], local[4], local[5]];
    mapStrokeLocals.set(id, own);
    return own;
  }

  function lineMaskGroup(ownerId: string): LineMaskGroup {
    let group = lineMaskGroups.get(ownerId);
    if (!group) {
      group = { mask: null, base: null, href: `url(#mline-${ownerId})`, erasers: new Map(), pens: new Map(), regionSig: "" };
      lineMaskGroups.set(ownerId, group);
    }
    return group;
  }

  function ensureLineMaskEl(ownerId: string, group: LineMaskGroup): SVGElement {
    if (group.mask) return group.mask;
    const mask = document.createElementNS("http://www.w3.org/2000/svg", "mask");
    mask.setAttribute("id", `mline-${ownerId}`);
    mask.setAttribute("maskUnits", "userSpaceOnUse");
    mask.setAttribute("maskContentUnits", "userSpaceOnUse");
    const base = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    base.setAttribute("fill", "#ffffff");
    mask.appendChild(base);
    defs.appendChild(mask);
    group.mask = mask;
    group.base = base;
    group.regionSig = "";
    syncLineMaskRegion(group);
    return mask;
  }

  function syncLineMaskRegion(group: LineMaskGroup): void {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const box of group.pens.values()) {
      minX = Math.min(minX, box[0]); minY = Math.min(minY, box[1]);
      maxX = Math.max(maxX, box[2]); maxY = Math.max(maxY, box[3]);
    }
    if (!Number.isFinite(minX)) return;
    const sig = `${minX}|${minY}|${maxX}|${maxY}`;
    if (group.regionSig === sig || group.mask === null || group.base === null) return;
    group.regionSig = sig;
    const w = String(maxX - minX), h = String(maxY - minY), x = String(minX), y = String(minY);
    group.mask.setAttribute("x", x); group.mask.setAttribute("y", y);
    group.mask.setAttribute("width", w); group.mask.setAttribute("height", h);
    group.base.setAttribute("x", x); group.base.setAttribute("y", y);
    group.base.setAttribute("width", w); group.base.setAttribute("height", h);
  }

  function applyLineMask(group: LineMaskGroup, polyline: SVGPolylineElement, box: readonly number[]): void {
    let hit = false;
    for (const eraser of group.erasers.values()) {
      const cut = eraser.box;
      if (cut && cut[0] <= box[2] && cut[2] >= box[0] && cut[1] <= box[3] && cut[3] >= box[1]) { hit = true; break; }
    }
    if (!hit) polyline.removeAttribute("mask");
    else if (polyline.getAttribute("mask") !== group.href) polyline.setAttribute("mask", group.href);
  }

  function syncLineMaskPens(group: LineMaskGroup): void {
    for (const [penId, box] of group.pens) {
      const polyline = recordFor(penId)?.linePolyline;
      if (polyline) applyLineMask(group, polyline, box);
    }
  }

  function releaseLineMaskStroke(id: string): void {
    const ownerId = lineMaskOwners.get(id);
    if (ownerId === undefined) return;
    lineMaskOwners.delete(id);
    const group = lineMaskGroups.get(ownerId);
    if (!group) return;
    const eraser = group.erasers.get(id);
    if (eraser) { eraser.line.remove(); group.erasers.delete(id); syncLineMaskPens(group); }
    if (group.pens.delete(id)) { group.regionSig = ""; syncLineMaskRegion(group); }
    if (group.erasers.size === 0 && group.mask !== null) {
      group.mask.remove(); group.mask = null; group.base = null;
    }
    if (group.erasers.size === 0 && group.pens.size === 0) lineMaskGroups.delete(ownerId);
  }

  function updateStroke(id: string, ownerId: string | null, eraser: boolean, points: string, linePoints: number[], width: number): void {
    if (lineMaskOwners.get(id) !== (ownerId ?? undefined)) releaseLineMaskStroke(id);
    if (ownerId === null) return;
    const group = lineMaskGroup(ownerId);
    lineMaskOwners.set(id, ownerId);
    if (eraser) {
      let cut = group.erasers.get(id);
      if (!cut) {
        const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
        line.setAttribute("fill", "none"); line.setAttribute("stroke", "#000000");
        line.setAttribute("stroke-linejoin", "round"); line.setAttribute("stroke-linecap", "round");
        ensureLineMaskEl(ownerId, group).appendChild(line);
        cut = { line, box: null }; group.erasers.set(id, cut);
      }
      cut.line.setAttribute("points", points); cut.line.setAttribute("stroke-width", String(width));
      cut.box = strokeBox(linePoints, width); syncLineMaskPens(group);
      return;
    }
    const box = strokeBox(linePoints, width);
    if (box) { group.pens.set(id, box); syncLineMaskRegion(group); }
    else if (group.pens.delete(id)) { group.regionSig = ""; syncLineMaskRegion(group); }
    const own = group.pens.get(id);
    const polyline = recordFor(id)?.linePolyline;
    if (polyline && own) applyLineMask(group, polyline, own);
    else polyline?.removeAttribute("mask");
  }

  function dispose(): void {
    for (const group of lineMaskGroups.values()) group.mask?.remove();
    lineMaskGroups.clear(); lineMaskOwners.clear(); mapStrokeLocals.clear();
  }

  return { pinnedStrokeLocal, forgetStrokeLocal: (id: string) => mapStrokeLocals.delete(id), updateStroke, releaseLineMaskStroke, dispose };
}

function strokeBox(points: number[], width: number): number[] | null {
  if (points.length < 4) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i], y = points[i + 1];
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const pad = width / 2 + 1;
  return [minX - pad, minY - pad, maxX + pad, maxY + pad];
}
