// THE PAINT DUMP'S COMMAND LINES — one line per recorded draw-list command, in paint order.
//
// Extracted from `canvasRenderer.drawListDump` for ONE reason: the renderer's dump is a closure over a live GL
// stage, and the command the canvas text path records most of — a glyph run — cannot be put into
// that closure from a unit test (the glyph path needs a GL context, hb-gpu's wasm and a 2D measurer, none of
// which jsdom has). A pure function over a draw list can be handed one in three lines. That is not a cosmetic
// difference: the shipped dump threw on every glyph run for as long as the glyph path has been on, and no spec
// could reach it to say so.
//
// The renderer still owns everything ABOVE a command — the `O` overlay rows, the `T` text rows, the `#` header —
// and passes the two things this cannot derive: the node a command belongs to (`ranges`) and the role a quad
// plays (`roleOf`, which needs the build's trail-quad ids). Nothing here reads a window.
//
// FORMAT RULES, and they are the comparer's (`scripts/compare-paint-dumps.mjs` splits on spaces and reads `k=v`):
// no value may contain a space, and no number may be printed at full float width — everything is fixed to 3
// decimals so a float-formatting difference cannot masquerade as a geometry one.

import {
  DRAW_CLIP_POP,
  DRAW_CLIP_PUSH,
  DRAW_GLYPHS,
  DRAW_NINE_PATCH,
  DRAW_POLYLINE,
  createClipRectView,
  createGlyphsView,
  createNinePatchView,
  createPolylineView,
  createQuadView,
  type DrawList,
  type GlyphsView,
  type NinePatchView,
  type PolylineView,
  type QuadView
} from "@godot-scene-web/canvas";

import { nodeTypeLeaf, type MirrorNode } from "@/mirror/sceneTree";
import { TEXT_KEY_PREFIX } from "@/mirror/canvas/textSurfaces";

/** Verbatim `canvasRenderer`'s own table — a blend with no name here prints as its NUMBER, as it always has. */
const BLEND_NAMES = ["mix", "add", "sub", "mul"] as const;

/** A node's own paint span, as `DrawListBuild.ranges` records it. */
export interface DumpPaintRange {
  start: number;
  paintEnd: number;
}

export interface PaintDumpCommandInput {
  /** The built list, read back command by command. Texture handles are this app's string keys. */
  list: DrawList<string>;
  /** The scene the build walked — for each command's node TYPE. */
  nodes: ReadonlyMap<string, MirrorNode>;
  /** Node id -> the commands its OWN paint pushed. Disjoint by construction; see the renderer. */
  ranges: ReadonlyMap<string, DumpPaintRange>;
  /** Clipper node id -> the command index of its `clipPush`. */
  clipPushes: ReadonlyMap<string, number>;
  /** The renderer's `commandRole`; a glyph run and a polyline never ask it (their roles are fixed). */
  roleOf: (kind: number, texture: string | null, node: MirrorNode | undefined, seenFill: boolean) => string;
}

/**
 * Fixed to 3 decimals, and `-0` normalised — two arms must never differ only in a sign nobody can see.
 *
 * Exported because the renderer's own `O` and `T` rows have to print numbers the SAME way; two roundings in one
 * file would be a divergence class of their own.
 */
export function dumpNum(v: number): string {
  return Object.is(v, -0) ? "0.000" : v.toFixed(3);
}

const num = dumpNum;

/**
 * The `K` / `C` / `G` lines for one built list, in paint order.
 *
 * `C` is a quad or nine-patch or polyline, `K` opens a clip scope, and `G` is a GLYPH RUN — see
 * {@link glyphDumpLine} for why that one is not a `C`.
 */
export function dumpCommandLines(input: PaintDumpCommandInput): string[] {
  const { list, nodes, ranges, clipPushes, roleOf } = input;
  const lines: string[] = [];
  // Read-back scratch, allocated per CALL: this runs once per parity gate, never per frame, so the renderer
  // carries no diagnostic-only buffers for the whole session.
  const quadScratch: QuadView = createQuadView();
  const nineScratch: NinePatchView = createNinePatchView();
  const lineScratch: PolylineView = createPolylineView(64);
  const glyphScratch: GlyphsView = createGlyphsView(64);
  const clipScratch = createClipRectView();
  // Command index -> the node whose OWN paint pushed it. The builder's ranges are disjoint by construction
  // (verify-canvas-drawlist.mjs asserts exactly that), so one pass fills the whole array.
  const owner: (string | null)[] = new Array(list.count).fill(null);
  for (const [id, range] of ranges) {
    for (let i = range.start; i < range.paintEnd; i++) {
      owner[i] = id;
    }
  }
  // …and the clipper each command sits inside, from the same build's clip intervals. Reported as the clipper's
  // node id (the DOM's twin is the nearest `overflow:hidden` ancestor), so the two arms name the same scope.
  const clipStack: string[] = [];
  const clipOpenAt = new Map<number, string>();
  for (const [clipperId, push] of clipPushes) {
    clipOpenAt.set(push, clipperId);
  }
  const seenFill = new Set<string>();
  let painted = 0;

  /**
   * A texture key as the dump should carry it — and for a LABEL that is an ORDINAL, not the key.
   *
   * A `text://` key is the raster descriptor itself: the label's own words, its font, its colours, NUL-joined
   * (see `textLayout.textDigest`). Printing it verbatim would put the game's text into every dump file, and put
   * RAW NUL BYTES and embedded spaces into a format whose whole parsing rule is "split on spaces, `k=v`" — which
   * would silently truncate the field for every reader, this comparer included. Neither is acceptable in a file
   * a gate reads and an agent pastes.
   *
   * An ordinal keeps the only property the gate needs: IDENTITY. Two quads sampling the same raster print the
   * same `#n`, two different rasters print different ones, and the numbering is per-dump and first-appearance,
   * so it is stable for a given build and carries nothing else. What a label SAYS is not a thing a paint-parity
   * gate has ever compared — the `T` records carry its metrics, and its pixels are the screenshot's business.
   */
  const textOrdinals = new Map<string, number>();
  const dumpTexture = (texture: string | null): string => {
    if (texture === null) {
      return "-";
    }
    if (!texture.startsWith(TEXT_KEY_PREFIX)) {
      return texture;
    }
    let ordinal = textOrdinals.get(texture);
    if (ordinal === undefined) {
      ordinal = textOrdinals.size;
      textOrdinals.set(texture, ordinal);
    }
    return `${TEXT_KEY_PREFIX}#${ordinal}`;
  };

  for (let i = 0; i < list.count; i++) {
    const kind = list.kindAt(i);
    if (kind === DRAW_CLIP_PUSH) {
      const clipperId = clipOpenAt.get(i) ?? "?";
      list.readClipRect(i, clipScratch);
      lines.push(
        `K ${clipperId} rect=${num(clipScratch.x)},${num(clipScratch.y)},${num(clipScratch.w)},${num(clipScratch.h)}` +
          ` radius=${num(clipScratch.cornerRadius)} outset=${num(clipScratch.outsetX)}` +
          ` scope=${clipStack.length > 0 ? clipStack[clipStack.length - 1] : "-"}`
      );
      clipStack.push(clipperId);
      continue;
    }
    if (kind === DRAW_CLIP_POP) {
      clipStack.pop();
      continue;
    }
    const nodeId = owner[i] ?? "?";
    const node = nodes.get(nodeId);
    const type = nodeTypeLeaf(node?.nodeType ?? "") || "-";
    const texture = list.textureAt(i);
    const scope = clipStack.length > 0 ? clipStack[clipStack.length - 1] : "-";
    if (kind === DRAW_POLYLINE) {
      list.readPolyline(i, lineScratch);
      const n = lineScratch.pointCount;
      // First and last point only: a 400-point map stroke would otherwise dominate the dump, and the endpoints
      // plus the count are what a placement error moves.
      const p0 = n > 0 ? `${num(lineScratch.points[0])},${num(lineScratch.points[1])}` : "-";
      const p1 = n > 0 ? `${num(lineScratch.points[(n - 1) * 2])},${num(lineScratch.points[(n - 1) * 2 + 1])}` : "-";
      lines.push(
        `C ${painted} ${nodeId} line role=line type=${type} pts=${n} p0=${p0} p1=${p1}` +
          ` width=${num(lineScratch.width)}` +
          ` rgba=${num(lineScratch.r)},${num(lineScratch.g)},${num(lineScratch.b)},${num(lineScratch.a)}` +
          ` blend=mix clip=${scope}`
      );
      painted++;
      continue;
    }
    // A GLYPH RUN, WHICH USED TO REACH `readQuad` AND THROW. gsw's `requireKind` refuses to read a `glyphs`
    // command as a quad — correctly, its payload is not a quad payload — so the fallthrough below turned every
    // `--paint-dump` on the shipped text path into an exception, leaving no way to get a
    // dump at all. It gets its own line rather than a `C` for the same reason `O` rows exist: the DOM arm has no
    // command for a label, so a `C` here would key as an unmatched canvas quad on every word on screen.
    if (kind === DRAW_GLYPHS) {
      list.readGlyphs(i, glyphScratch);
      lines.push(glyphDumpLine(painted, nodeId, type, glyphScratch, scope));
      painted++;
      continue;
    }
    const view = kind === DRAW_NINE_PATCH ? list.readNinePatch(i, nineScratch) : list.readQuad(i, quadScratch);
    const role = roleOf(kind, texture, node, seenFill.has(nodeId));
    if (role === "fill") {
      seenFill.add(nodeId);
    }
    const m = view.m;
    const margins =
      kind === DRAW_NINE_PATCH
        ? ` margins=${num(nineScratch.marginLeft)},${num(nineScratch.marginTop)},` +
          `${num(nineScratch.marginRight)},${num(nineScratch.marginBottom)}`
        : "";
    lines.push(
      `C ${painted} ${nodeId} ${kind === DRAW_NINE_PATCH ? "ninePatch" : "quad"} role=${role} type=${type}` +
        ` m=${num(m[0])},${num(m[1])},${num(m[2])},${num(m[3])},${num(m[4])},${num(m[5])}` +
        ` wh=${num(view.w)},${num(view.h)}` +
        ` src=${num(view.srcX)},${num(view.srcY)},${num(view.srcW)},${num(view.srcH)}` +
        ` rgba=${num(view.r)},${num(view.g)},${num(view.b)},${num(view.a)}` +
        ` blend=${BLEND_NAMES[view.blend] ?? String(view.blend)}` +
        ` flip=${view.flipH ? "H" : "-"}${view.flipV ? "V" : "-"}` +
        ` cm=${view.hasColorMatrix ? "1" : "0"}` +
        margins +
        ` tex=${dumpTexture(texture)} clip=${scope}`
    );
    painted++;
  }
  return lines;
}

/**
 * ONE GLYPH RUN, as a `G` line — every field {@link GlyphsView} carries that a reader could act on.
 *
 * ```
 * G <paint> <nodeId> glyphs role=glyph type=<Type> m=<6> ppem=<n> count=<n> pen0=<x,y> pen1=<x,y> rgba=<4> spread=<n> clip=<id>
 * ```
 *
 * `<paint>` SHARES THE `C` COUNTER, because it is a paint rank and a glyph run really is painted between the
 * quads either side of it. The comparer ranks by a command's POSITION in the parsed `C` list rather than by this
 * number (`rankIndex`, not `index`), so the gaps a run leaves in the `C` indices change no verdict — they are
 * visible only in the diagnostics, where "index 7 is missing" is the true statement.
 *
 * `pen0`/`pen1` ARE NOT `p0`/`p1`, and the difference is why they are spelled differently. A polyline's endpoints
 * are DESIGN-space points; these are the run's first and last PEN positions in the run's own LOCAL space, before
 * `m` is applied — that is where `GlyphsView.positions` lives, and folding `m` in here would print a number the
 * shaper never produced. Reusing `p0` for the two meanings is exactly the mistake the `tscale` row in
 * `drawListDump` was added to undo, and it cost a round there.
 *
 * `rgba` is PREMULTIPLIED, as the view states — the same convention the `C` lines print, so an alpha comparison
 * needs no per-kind special case. `spread` is the outward dilation in DESIGN units: an outlined label is two runs
 * with the same `pen*` and different `spread`, so a reader that sees one without the other is looking at a label
 * drawn without its outline.
 */
export function glyphDumpLine(
  painted: number,
  nodeId: string,
  type: string,
  view: GlyphsView,
  scope: string
): string {
  const m = view.m;
  const n = view.glyphCount;
  const pen0 = n > 0 ? `${num(view.positions[0])},${num(view.positions[1])}` : "-";
  const pen1 = n > 0 ? `${num(view.positions[(n - 1) * 2])},${num(view.positions[(n - 1) * 2 + 1])}` : "-";
  return (
    `G ${painted} ${nodeId} glyphs role=glyph type=${type}` +
    ` m=${num(m[0])},${num(m[1])},${num(m[2])},${num(m[3])},${num(m[4])},${num(m[5])}` +
    ` ppem=${num(view.pixelsPerEm)} count=${n} pen0=${pen0} pen1=${pen1}` +
    ` rgba=${num(view.r)},${num(view.g)},${num(view.b)},${num(view.a)}` +
    ` spread=${num(view.spreadPx)} clip=${scope}`
  );
}
