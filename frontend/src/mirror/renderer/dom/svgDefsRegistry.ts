import { hsvFilterDefs } from "@/mirror/shaderAttributes";

export interface RgbTint {
  r: number;
  g: number;
  b: number;
}

/** Per-renderer, grow-only SVG filter registry. */
export function createSvgDefsRegistry(defs: SVGElement) {
  const tintIds = new Set<string>();
  const hsvIds = new Set<string>();

  function makeFilter(id: string, values: string): SVGElement {
    const filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
    filter.setAttribute("id", id);
    filter.setAttribute("color-interpolation-filters", "sRGB");
    filter.setAttribute("x", "0");
    filter.setAttribute("y", "0");
    filter.setAttribute("width", "100%");
    filter.setAttribute("height", "100%");
    const matrix = document.createElementNS("http://www.w3.org/2000/svg", "feColorMatrix");
    matrix.setAttribute("type", "matrix");
    matrix.setAttribute("values", values);
    filter.appendChild(matrix);
    return filter;
  }

  function registerTint(tint: RgbTint): string {
    // Quantize to ~2 decimals so distinct-but-equal tints share one filter. This is also part of the filter id.
    const q = (value: number) => Math.round(Math.min(Math.max(value, 0), 4) * 50);
    const key = `${q(tint.r)}_${q(tint.g)}_${q(tint.b)}`;
    if (!tintIds.has(key)) {
      tintIds.add(key);
      defs.appendChild(makeFilter(`mtint-${key}`, `${tint.r} 0 0 0 0 0 ${tint.g} 0 0 0 0 0 ${tint.b} 0 0 0 0 0 1 0`));
    }
    return key;
  }

  function syncHsvDefs(): void {
    for (const { id, values } of hsvFilterDefs()) {
      if (!hsvIds.has(id)) {
        hsvIds.add(id);
        defs.appendChild(makeFilter(id, values));
      }
    }
  }

  return { makeFilter, registerTint, syncHsvDefs };
}
