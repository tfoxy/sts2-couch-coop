import type { CanvasTextureCache } from "@godot-scene-web/canvas";
import {
  createGlyphBlockCache,
  type GlyphBlockCache,
} from "@/mirror/canvas/glyphBlocks";
import {
  createGlyphPassRegistry,
  type GlyphPassRegistry,
} from "@/mirror/canvas/glyphPass";
import {
  createGlyphFloorCensus,
  type OverlayRecord,
  type TextGlyphSource,
  type TextQuadSource,
  type TextSnap,
} from "@/mirror/canvas/paintSpec";
import {
  createColorValidator,
  parseSimpleRich,
  type ColorValidator,
} from "@/mirror/canvas/richSimple";
import {
  layoutText,
  rasterScaleFor,
  resolveTextSpec,
  scaleFromTransform,
  textDigest,
  type TextSpan,
  type TextSpec,
} from "@/mirror/canvas/textLayout";
import {
  createTextSurfaces,
  type TextSurfaceRegistry,
} from "@/mirror/canvas/textSurfaces";
import { ensureNodeFonts } from "@/mirror/fonts";
import type { MirrorState } from "@/mirror/sceneTree";
import {
  EMPTY_TEXT_SCALE_DECLS,
  resolveTextScaleClasses,
  resolveTextScaleDecls,
  textScaleEnabled,
  type TextScaleDecls,
} from "@/mirror/textScaleClasses";

type LabelSceneInfo = { file: string; relPath: string } | null;
type ResolvedLabel = {
  spec: TextSpec;
  spans: readonly TextSpan[] | undefined;
  scene: LabelSceneInfo;
} | null;
export interface CanvasTextStats {
  textQuadPeak: number;
  textGlyphPeak: number;
  richAccepted: number;
  richRefusals: ReadonlyMap<string, number>;
  glyphFloorRuns: number;
  glyphLayouts: number;
  glyphMeasureText: number;
}

/** Owns canvas-text policy, builder sources, diagnostics and cache clocks. */
export function createCanvasTextRuntime(options: {
  gl: WebGL2RenderingContext;
  designBox: () => { w: number; h: number };
  perDesignPx: () => number;
  onPixelsChanged: () => void;
}) {
  let texts: TextSurfaceRegistry | null = null;
  const glyphs: GlyphPassRegistry = createGlyphPassRegistry({
    gl: options.gl,
    designWidth: Math.max(1, options.designBox().w),
    designHeight: Math.max(1, options.designBox().h),
    metrics: (cssFont) => texts?.lineMetricsFor(cssFont) ?? null,
    onReady: options.onPixelsChanged,
  });
  const glyphBlocks: GlyphBlockCache | null =
    glyphs !== null
      ? createGlyphBlockCache()
      : null;
  let restPrev = new Map<string, string>(),
    restCur = new Map<string, string>();
  let wasRestPrev = new Set<string>(),
    wasRestCur = new Set<string>();
  let textQuadPeak = 0,
    textGlyphPeak = 0,
    labelEpoch = -1,
    labelId = "";
  let labelValue: ResolvedLabel = null;
  let richColorCtx: CanvasRenderingContext2D | null | undefined;
  const richRefusals = new Map<string, number>(),
    glyphLayoutStats = { layouts: 0, measureText: 0 },
    textDumpRows = new Map<string, string>();
  let richAccepted = 0,
    glyphFloorRuns = 0;
  const textSnap: TextSnap = {
    get perDesignPx() {
      return options.perDesignPx();
    },
    atRest(nodeId, tx, ty) {
      const packed = tx + "," + ty;
      restCur.set(nodeId, packed);
      const rest = restPrev.get(nodeId) === packed;
      if (rest) wasRestCur.add(nodeId);
      return rest;
    },
  };
  const color = (): ColorValidator => {
    if (richColorCtx === undefined)
      try {
        richColorCtx = document.createElement("canvas").getContext("2d");
      } catch {
        richColorCtx = null;
      }
    return createColorValidator(richColorCtx);
  };
  const declsFor = (scene: LabelSceneInfo): TextScaleDecls =>
    textScaleEnabled()
      ? resolveTextScaleDecls(scene?.file ?? null, scene?.relPath ?? null)
      : EMPTY_TEXT_SCALE_DECLS;
  const refuseRich = (reason: string): void => {
    richRefusals.set(reason, (richRefusals.get(reason) ?? 0) + 1);
  };
  function noteRow(
    nodeId: string,
    spec: TextSpec,
    lines: number,
    scene: LabelSceneInfo,
    enabled: boolean,
  ): void {
    if (!enabled) return;
    const scale = declsFor(scene).self["--godot-text-scale"] ?? "-";
    const ts =
      resolveTextScaleClasses(scene?.file ?? null, scene?.relPath ?? null)
        .slice()
        .sort()
        .join(",") || "-";
    const family = spec.family.replace(/\s+/g, "_") || "-";
    textDumpRows.set(
      nodeId,
      "T " +
        nodeId +
        " font=" +
        spec.fontPx.toFixed(2) +
        " lineHeight=" +
        spec.pitchPx.toFixed(2) +
        " family=" +
        family +
        " scale=" +
        scale +
        " ts=" +
        ts +
        " box=" +
        Math.round(spec.boxW) +
        "x" +
        Math.round(spec.boxH) +
        " lines=" +
        lines +
        " white=" +
        spec.whiteSpace,
    );
  }
  return {
    glyphs,
    glyphBlocks,
    get texts() {
      return texts;
    },
    get textSnap() {
      return textSnap;
    },
    textScaleFor(scene: LabelSceneInfo): number {
      return scaleFromTransform(declsFor(scene).text.transform);
    },
    attachSurfaces(
      config: Omit<
        Parameters<typeof createTextSurfaces>[0],
        "cache" | "pageDim" | "captureScratch" | "scratchMaxTexW"
      > & { cache: CanvasTextureCache },
    ): TextSurfaceRegistry | null {
      texts = createTextSurfaces({
        ...config,
      });
      return texts;
    },
    createSources(ports: {
      buildEpoch: () => number;
      state: () => MirrorState | null;
      resolveScene: (
        nodeId: string,
        nodes: MirrorState["nodes"],
      ) => LabelSceneInfo;
      imageSize: (url: string) => { width: number; height: number } | null;
      paintDumpEnabled: () => boolean;
    }): {
      glyphSource: TextGlyphSource | null;
      textSource: TextQuadSource | null;
      glyphFloorProbe:
        | ReturnType<typeof createGlyphFloorCensus>["probe"]
        | null;
    } {
      if (texts === null)
        return { glyphSource: null, textSource: null, glyphFloorProbe: null };
      const census = createGlyphFloorCensus({
        perDesignPx: options.perDesignPx,
        describe: (nodeId) => {
          const state = ports.state(),
            scene =
              state === null ? null : ports.resolveScene(nodeId, state.nodes);
          return scene === null
            ? nodeId
            : (scene.file ?? "?") + " " + (scene.relPath ?? nodeId);
        },
      });
      const floorProbe: typeof census.probe = {
        get perDesignPx() {
          return census.probe.perDesignPx;
        },
        below(nodeId, devicePpem) {
          census.probe.below(nodeId, devicePpem);
          glyphFloorRuns = census.runs;
        },
      };
      const resolve = (record: OverlayRecord): ResolvedLabel => {
        const epoch = ports.buildEpoch();
        if (labelEpoch === epoch && labelId === record.id) return labelValue;
        labelEpoch = epoch;
        labelId = record.id;
        const state = ports.state(),
          node = state?.nodes.get(record.id);
        if (!node || state === null) return (labelValue = null);
        ensureNodeFonts(node);
        const scene = ports.resolveScene(record.id, state.nodes),
          decls = declsFor(scene);
        let spec = resolveTextSpec(node, decls);
        if (spec === null) return (labelValue = null);
        let spans: readonly TextSpan[] | undefined;
        if (spec.refusal === "rich") {
          const parsed = parseSimpleRich(spec.text, { color: color() });
          if (!parsed.ok) {
            refuseRich(parsed.refusal);
            return (labelValue = null);
          }
          const plain = resolveTextSpec(
            {
              ...node,
              richText: false,
              text: { ...node.text!, text: parsed.value.text },
            },
            decls,
          );
          if (plain === null || plain.refusal !== null) {
            refuseRich("post-parse");
            return (labelValue = null);
          }
          spec =
            parsed.value.align === null
              ? plain
              : { ...plain, align: parsed.value.align };
          spans = parsed.value.spans.length ? parsed.value.spans : undefined;
          richAccepted++;
        }
        return (labelValue =
          spec.refusal === null ? { spec, spans, scene } : null);
      };
      const row = (
        id: string,
        spec: TextSpec,
        lines: number,
        scene: LabelSceneInfo,
      ): void => noteRow(id, spec, lines, scene, ports.paintDumpEnabled());
      const glyphSource: TextGlyphSource | null =
        glyphs === null
          ? null
          : {
              blockFor(record) {
                const resolved = resolve(record);
                if (resolved === null) return null;
                const font = ports.state()?.nodes.get(record.id)?.font ?? null;
                if (font === null) return null;
                const key =
                    glyphBlocks?.keyFor(
                      resolved.spec,
                      font.url,
                      resolved.spans,
                    ) ?? null,
                  held = key === null ? null : glyphBlocks!.get(key);
                if (held !== null) {
                  row(record.id, resolved.spec, held.lines, resolved.scene);
                  return held.block;
                }
                const deviceScale =
                  ((Math.hypot(record.transform[0], record.transform[1]) +
                    Math.hypot(record.transform[2], record.transform[3])) /
                    2) *
                  options.perDesignPx();
                const measure = texts!.measureFor(resolved.spec.cssFont);
                if (measure === null) return null;
                glyphLayoutStats.layouts++;
                const layout = layoutText(
                  resolved.spec,
                  (text) => {
                    glyphLayoutStats.measureText++;
                    return measure(text);
                  },
                  resolved.spans,
                );
                const block = glyphs!.blockFor(
                  resolved.spec,
                  layout,
                  font,
                  deviceScale,
                );
                if (block === null) return null;
                row(
                  record.id,
                  resolved.spec,
                  layout.lines.length,
                  resolved.scene,
                );
                return key === null
                  ? block
                  : glyphBlocks!.put(key, block, layout.lines.length).block;
              },
            };
      const textSource: TextQuadSource = {
        boxFor(record) {
          const resolved = resolve(record);
          if (resolved === null) return null;
          const scale = rasterScaleFor(
            record.transform,
            resolved.spec.blockScale * options.perDesignPx(),
            wasRestPrev.has(record.id),
          );
          const digest = textDigest(resolved.spec, scale, resolved.spans),
            hit = texts!.boxFor(digest);
          if (hit !== null) {
            row(record.id, resolved.spec, hit.lines, resolved.scene);
            return { digest, ...hit, blockScale: resolved.spec.blockScale };
          }
          const measure = texts!.measureFor(resolved.spec.cssFont);
          if (measure === null) return null;
          const raster = texts!.acquire(
            digest,
            resolved.spec,
            layoutText(resolved.spec, measure, resolved.spans),
            scale,
            resolved.spans,
          );
          if (raster === null) return null;
          row(record.id, resolved.spec, raster.lines, resolved.scene);
          return { digest, ...raster, blockScale: resolved.spec.blockScale };
        },
      };
      return {
        glyphSource,
        textSource,
        glyphFloorProbe: glyphSource === null ? null : floorProbe,
      };
    },
    beginBuild(): void {
      const outgoing = restPrev;
      restPrev = restCur;
      outgoing.clear();
      restCur = outgoing;
      const outgoingWas = wasRestPrev;
      wasRestPrev = wasRestCur;
      outgoingWas.clear();
      wasRestCur = outgoingWas;
      textDumpRows.clear();
    },
    endBuild(stats?: { textQuads: number; textGlyphLabels: number }): void {
      texts?.endBuild();
      glyphs?.endBuild();
      glyphBlocks?.endBuild();
      if (stats) {
        textQuadPeak = Math.max(textQuadPeak, stats.textQuads);
        textGlyphPeak = Math.max(textGlyphPeak, stats.textGlyphLabels);
      }
    },
    stats(): CanvasTextStats {
      return {
        textQuadPeak,
        textGlyphPeak,
        richAccepted,
        richRefusals,
        glyphFloorRuns,
        glyphLayouts: glyphLayoutStats.layouts,
        glyphMeasureText: glyphLayoutStats.measureText,
      };
    },
    dumpRows(): Iterable<string> {
      return textDumpRows.values();
    },
    invalidate(): void {
      texts?.invalidate();
      glyphs?.invalidate();
      glyphBlocks?.invalidate();
    },
    restore(): void {
      glyphs?.restore();
    },
    dispose(): void {
      texts?.dispose();
      glyphs?.dispose();
      texts = null;
    },
  };
}
