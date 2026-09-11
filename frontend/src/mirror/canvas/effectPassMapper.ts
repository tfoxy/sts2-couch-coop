// Maps mirror semantic effect state to GSW's DOM-free passes.  This module has
// no loader, canvas, timer, or DOM ownership: the canvas renderer supplies
// already-resident same-context texture handles and schedules retries.

import type { GodotResource, GodotVariant } from "@godot-scene-web/core";
import {
  BLEND_ADD,
  BLEND_MIX,
  BLEND_MUL,
  BLEND_SUB,
  type BlendMode,
  type ExecutorTexture,
} from "@godot-scene-web/canvas";
import type {
  HeadlessGodotParticlePass,
  HeadlessGodotShaderPass,
} from "@godot-scene-web/canvas-effects/webgl";

import { mirrorResourceUrl, type MirrorColor, type MirrorNode } from "@/mirror/sceneTree";
import { stretchModeToBackgroundSize, synthesizeMirrorShaderMaterial } from "@/mirror/shaderAttributes";
import { resolveShaderSource } from "@/mirror/shaderResources";

/** The sole texture admission point: all ready handles belong to the stage GL context. */
export type StageTextureResolution =
  | { readonly status: "ready"; readonly texture: ExecutorTexture; /** Changes whenever this source's resident GPU identity changes. */ readonly identity: string }
  | { readonly status: "pending" }
  | { readonly status: "unsupported"; readonly message: string };

export interface EffectPassTextures {
  /** Resolve an already-requested image or atlas texture. This must never allocate or decode synchronously. */
  resolve(url: string): StageTextureResolution;
  /** Resolve a stage-owned solid texture for a textureless shader base. */
  resolveSolid?(color: readonly [number, number, number, number]): StageTextureResolution;
  /** Resolve a stage-owned LUT generated from the producer-streamed particle gradient. */
  resolveLut?(
    stops: ReadonlyArray<{ readonly offset: number; readonly color: readonly [number, number, number, number] }>,
    interpolation: number,
  ): StageTextureResolution;
}

export interface EffectPassMapperOptions {
  readonly textures: EffectPassTextures;
  /** Called when an async source result changes admission; it does not paint or acknowledge a delta. */
  readonly onSettled?: () => void;
  /** Injection seam for tests; production uses shaderResources.resolveShaderSource. */
  readonly loadShaderSource?: (path?: string) => Promise<string | undefined>;
}

export interface ReadyShaderPass {
  readonly status: "ready";
  readonly kind: "shader";
  readonly nodeId: string;
  readonly resourceIdentity: string;
  readonly resourceVersion: string;
  readonly pass: HeadlessGodotShaderPass;
  /** A SCREEN_TEXTURE shader has to execute at its semantic painter index. */
  readonly screenDependent: boolean;
}

export interface ReadyParticlePass {
  readonly status: "ready";
  readonly kind: "particles";
  readonly nodeId: string;
  readonly resourceIdentity: string;
  readonly resourceVersion: string;
  readonly pass: HeadlessGodotParticlePass;
  readonly blend: BlendMode;
  /** The semantic emitter placement is supplied to the producer for each frame. */
  readonly origin: readonly [number, number];
}

export interface PendingEffectPass {
  readonly status: "pending";
  readonly nodeId: string;
  readonly kind: "shader" | "particles";
  readonly reason: "shader-source" | "texture" | "solid" | "lut";
  /** Exact stage resource still needed when {@link reason} is `texture`. */
  readonly sourceUrl?: string;
  readonly resourceIdentity: string;
  readonly resourceVersion: string;
}

export interface UnsupportedEffectPass {
  readonly status: "unsupported";
  readonly nodeId: string;
  readonly kind: "shader" | "particles";
  readonly message: string;
  readonly resourceIdentity: string;
  readonly resourceVersion: string;
}

export type EffectPass = ReadyShaderPass | ReadyParticlePass | PendingEffectPass | UnsupportedEffectPass;

export interface EffectPassMapper {
  map(node: MirrorNode, geometry?: EffectPassGeometry): EffectPass | null;
  /** Forget fetched text; useful after an asset origin changes or a full test reset. */
  clear(): void;
}

/** The semantic node box used to reproduce TextureRect contain/cover UV fitting. */
export interface EffectPassGeometry {
  readonly width: number;
  readonly height: number;
  /** The visible sub-box in node UVs. Full node is the default. */
  readonly uvWindow?: readonly [number, number, number, number];
}

type SourceState =
  | { readonly status: "pending" }
  | { readonly status: "ready"; readonly source: string }
  | { readonly status: "unsupported"; readonly message: string };

interface ResourceMaps {
  readonly paths: ReadonlyMap<string, string>;
  readonly variants: ReadonlyMap<string, GodotVariant>;
}

// The presentation shim intentionally keeps ParticleSpecConfig open-ended. The
// shared normalizer supplies these four fields; spelling the read-only subset
// here keeps this adapter honest without narrowing the producer's full spec.
interface MappedParticleConfig {
  readonly textureUrl?: string | null;
  readonly maskUrl?: string | null;
  readonly colorLut?: ReadonlyArray<{ readonly offset: number; readonly color: readonly [number, number, number, number] }>;
  readonly colorLutInterpolation?: number | null;
  readonly blendMode?: number | null;
}

function colorTuple(color: MirrorColor | null): [number, number, number, number] {
  return color ? [color.r, color.g, color.b, color.a] : [1, 1, 1, 1];
}

function combinedModulate(node: MirrorNode): [number, number, number, number] {
  const modulate = colorTuple(node.modulate);
  const self = colorTuple(node.selfModulate);
  return [
    modulate[0] * self[0],
    modulate[1] * self[1],
    modulate[2] * self[2],
    modulate[3] * self[3],
  ];
}

function resolutionIdentity(url: string, value: StageTextureResolution): string {
  return value.status === "ready" ? `${url}@${value.identity}` : url;
}

function fitFor(
  mode: "contain" | "cover" | "fill",
  geometry: EffectPassGeometry | undefined,
  texture: ExecutorTexture | undefined,
): readonly [number, number] | null {
  if (mode === "fill") return [1, 1];
  if (!geometry || !texture || geometry.width <= 0 || geometry.height <= 0 || texture.width <= 0 || texture.height <= 0) return null;
  const window = geometry.uvWindow ?? [0, 0, 1, 1];
  if (!window.every(Number.isFinite) || window[2] <= 0 || window[3] <= 0) return null;
  const boxWidth = geometry.width / window[2];
  const boxHeight = geometry.height / window[3];
  const scale = mode === "cover"
    ? Math.max(boxWidth / texture.width, boxHeight / texture.height)
    : Math.min(boxWidth / texture.width, boxHeight / texture.height);
  return [(texture.width * scale) / boxWidth, (texture.height * scale) / boxHeight];
}

/** The surrounding DrawList supports the four CanvasItem blend states. premul_alpha uses its mix equation. */
export function canvasBlendFromGodot(blend: string): BlendMode {
  switch (blend) {
    case "add": return BLEND_ADD;
    case "sub": return BLEND_SUB;
    case "mul": return BLEND_MUL;
    case "premul_alpha":
    case "mix":
    default: return BLEND_MIX;
  }
}

function canvasBlendFromParticle(value: unknown): BlendMode {
  return value === BLEND_ADD || value === BLEND_SUB || value === BLEND_MUL ? value : BLEND_MIX;
}

function canonical(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "number": return Number.isFinite(value) ? String(value) : `nonfinite:${String(value)}`;
    case "boolean": return value ? "true" : "false";
    case "string": return JSON.stringify(value);
    case "undefined": return "undefined";
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
    }
    default: return String(value);
  }
}

/** A compact deterministic label, with the canonical input retained only during construction. */
function version(prefix: string, value: unknown): string {
  const text = canonical(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}:${(hash >>> 0).toString(16)}:${text.length}`;
}

function resourceMaps(document: GodotResource): ResourceMaps {
  const paths = new Map<string, string>();
  for (const resource of document.extResources ?? []) {
    if (resource.id && resource.path) paths.set(resource.id, resource.path);
  }
  const variants = new Map<string, GodotVariant>();
  for (const [key, value] of Object.entries(document.properties ?? {})) {
    if (key.startsWith("shader_parameter/")) variants.set(key.slice("shader_parameter/".length), value);
  }
  return { paths, variants };
}

function numericVariant(value: GodotVariant | undefined): number | readonly number[] | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (!value || typeof value !== "object" || !("type" in value) || !("args" in value)) return undefined;
  const typed = value as { readonly type?: string; readonly args?: unknown[] };
  if (!Array.isArray(typed.args) || !typed.args.every((part) => typeof part === "number" && Number.isFinite(part))) return undefined;
  switch (typed.type) {
    case "Color":
    case "Vector4": return typed.args.length === 4 ? typed.args as number[] : undefined;
    case "Vector3": return typed.args.length === 3 ? typed.args as number[] : undefined;
    case "Vector2": return typed.args.length === 2 ? typed.args as number[] : undefined;
    default: return undefined;
  }
}

function usesScreenTexture(source: string): boolean {
  // Godot 4 screen samplers are the authoritative marker; the legacy built-in
  // spelling is retained for old material docs.
  return /\bhint_screen_texture\b|\bSCREEN_TEXTURE\b/.test(source);
}

function shaderVersion(node: MirrorNode, source: string, document: GodotResource, textureIds: readonly string[]): string {
  return version("shader", {
    shaderId: node.shaderId,
    materialRef: node.materialRef,
    source,
    document,
    texture: node.textureUrl,
    fill: node.fillColor,
    modulate: node.modulate,
    selfModulate: node.selfModulate,
    stretch: node.textureStretchMode,
    flips: [node.textureFlipH, node.textureFlipV],
    textureIds,
  });
}

function particleVersion(node: MirrorNode, textureIds: readonly string[]): string {
  return version("particles", {
    shaderId: node.shaderId,
    shaderParams: node.shaderParams,
    spec: node.particleSpec,
    textureIds,
  });
}

function resolution(
  output: { pending?: PendingEffectPass; unsupported?: UnsupportedEffectPass },
  input: StageTextureResolution,
  pending: PendingEffectPass,
  unsupported: (message: string) => UnsupportedEffectPass,
): ExecutorTexture | null {
  if (input.status === "ready") return input.texture;
  if (input.status === "pending") {
    output.pending = pending;
  } else {
    output.unsupported = unsupported(input.message);
  }
  return null;
}

/**
 * The mapper owns only asynchronous shader-text memoization. Texture lifecycle,
 * GL ownership, and retries remain with the stage's texture registry.
 */
export function createEffectPassMapper(options: EffectPassMapperOptions): EffectPassMapper {
  const sources = new Map<string, SourceState>();
  const load = options.loadShaderSource ?? resolveShaderSource;

  const sourceFor = (path: string): SourceState => {
    const known = sources.get(path);
    if (known) return known;
    sources.set(path, { status: "pending" });
    void load(path).then(
      (source) => {
        sources.set(path, source ? { status: "ready", source } : { status: "unsupported", message: `Shader source is unavailable: ${path}` });
        options.onSettled?.();
      },
      () => {
        sources.set(path, { status: "unsupported", message: `Shader source is unavailable: ${path}` });
        options.onSettled?.();
      },
    );
    return { status: "pending" };
  };

  const mapShader = (node: MirrorNode, geometry?: EffectPassGeometry): EffectPass => {
    const identity = `shader:${node.id}:${node.shaderId ?? ""}`;
    const provisional = version("shader-pending", { shaderId: node.shaderId, materialRef: node.materialRef, params: node.shaderParams, texture: node.textureUrl, fill: node.fillColor });
    if (!node.shaderId) return { status: "unsupported", kind: "shader", nodeId: node.id, message: "Shader node has no source path.", resourceIdentity: identity, resourceVersion: provisional };
    // DOM could crop this with CSS background positioning. A stage pass must not
    // sample the whole atlas page and pretend it is equivalent.
    if (node.textureRegion) return { status: "unsupported", kind: "shader", nodeId: node.id, message: "Atlas-region shader needs a region-owned stage texture.", resourceIdentity: identity, resourceVersion: provisional };
    const sourceState = sourceFor(node.shaderId);
    if (sourceState.status === "pending") return { status: "pending", kind: "shader", nodeId: node.id, reason: "shader-source", resourceIdentity: identity, resourceVersion: provisional };
    if (sourceState.status === "unsupported") return { status: "unsupported", kind: "shader", nodeId: node.id, message: sourceState.message, resourceIdentity: identity, resourceVersion: provisional };

    const document = synthesizeMirrorShaderMaterial(node);
    const maps = resourceMaps(document);
    const pending = (reason: PendingEffectPass["reason"], resourceVersion: string, sourceUrl?: string): PendingEffectPass => ({
      status: "pending", kind: "shader", nodeId: node.id, reason, resourceIdentity: identity, resourceVersion,
      ...(sourceUrl === undefined ? {} : { sourceUrl })
    });
    const unsupported = (message: string, resourceVersion: string): UnsupportedEffectPass => ({ status: "unsupported", kind: "shader", nodeId: node.id, message, resourceIdentity: identity, resourceVersion });
    const state: { pending?: PendingEffectPass; unsupported?: UnsupportedEffectPass } = {};
    const textureIds: string[] = [];
    let base: ExecutorTexture | undefined;
    if (node.textureUrl) {
      const baseResolution = options.textures.resolve(node.textureUrl);
      textureIds.push(resolutionIdentity(node.textureUrl, baseResolution));
      base = resolution(state, baseResolution, pending("texture", provisional, node.textureUrl), (message) => unsupported(`Base texture ${node.textureUrl}: ${message}`, provisional)) ?? undefined;
    } else if (node.fillColor) {
      if (!options.textures.resolveSolid) return unsupported("Textureless shader needs a stage-owned solid-color registry.", provisional);
      const solid = colorTuple(node.fillColor);
      const solidResolution = options.textures.resolveSolid(solid);
      textureIds.push(resolutionIdentity(`solid:${solid.join(",")}`, solidResolution));
      base = resolution(state, solidResolution, pending("solid", provisional), (message) => unsupported(`Solid shader base: ${message}`, provisional)) ?? undefined;
    }
    const samplers: Record<string, ExecutorTexture> = {};
    for (const [name, variant] of maps.variants) {
      if (!variant || typeof variant !== "object" || !("type" in variant) || (variant as { type?: string }).type !== "ExtResource") continue;
      const resourceId = (variant as { id?: string }).id;
      const path = resourceId ? maps.paths.get(resourceId) : undefined;
      if (!path) return unsupported(`Sampler ${name} has no stage-resolvable resource path.`, provisional);
      const url = mirrorResourceUrl(path);
      const samplerResolution = options.textures.resolve(url);
      textureIds.push(resolutionIdentity(url, samplerResolution));
      const texture = resolution(state, samplerResolution, pending("texture", provisional, url), (message) => unsupported(`Sampler ${name}: ${message}`, provisional));
      if (texture) samplers[name] = texture;
    }
    if (state.unsupported) return state.unsupported;
    if (state.pending) return state.pending;
    const fitMode = node.textureUrl ? stretchModeToBackgroundSize(node.textureStretchMode) : "fill";
    const uvFit = fitFor(fitMode as "contain" | "cover" | "fill", geometry, base);
    if (!uvFit) return unsupported("Shader contain/cover fit needs a finite semantic node box and ready texture dimensions.", provisional);
    const uniforms: Record<string, number | readonly number[]> = {};
    for (const [name, variant] of maps.variants) {
      const value = numericVariant(variant);
      if (value !== undefined) uniforms[name] = value;
    }
    const resourceVersion = shaderVersion(node, sourceState.source, document, textureIds);
    return {
      status: "ready",
      kind: "shader",
      nodeId: node.id,
      resourceIdentity: identity,
      resourceVersion,
      screenDependent: usesScreenTexture(sourceState.source),
      pass: {
        source: sourceState.source,
        ...(base ? { texture: base } : {}),
        ...(Object.keys(samplers).length ? { samplers } : {}),
        ...(Object.keys(uniforms).length ? { uniforms } : {}),
        modulate: combinedModulate(node),
        uvFit,
        ...(geometry?.uvWindow ? { uvWindow: geometry.uvWindow } : {}),
      },
    };
  };

  const mapParticles = (node: MirrorNode): EffectPass => {
    const identity = `particles:${node.id}`;
    const provisional = particleVersion(node, []);
    const config = node.particleSpec;
    if (!config) return { status: "unsupported", kind: "particles", nodeId: node.id, message: "Particle node has no normalized particle spec.", resourceIdentity: identity, resourceVersion: provisional };
    const fields = config as typeof config & MappedParticleConfig;
    const { originX, originY, boxOffsetX: _boxOffsetX, boxOffsetY: _boxOffsetY, textureUrl: _textureUrl, maskUrl: _maskUrl, ...renderConfig } = config;
    const pending = (reason: PendingEffectPass["reason"], sourceUrl?: string): PendingEffectPass => ({
      status: "pending", kind: "particles", nodeId: node.id, reason, resourceIdentity: identity, resourceVersion: provisional,
      ...(sourceUrl === undefined ? {} : { sourceUrl })
    });
    const unsupported = (message: string): UnsupportedEffectPass => ({ status: "unsupported", kind: "particles", nodeId: node.id, message, resourceIdentity: identity, resourceVersion: provisional });
    const state: { pending?: PendingEffectPass; unsupported?: UnsupportedEffectPass } = {};
    const textureIds: string[] = [];
    let spriteTexture: ExecutorTexture | undefined;
    if (fields.textureUrl) {
      const spriteResolution = options.textures.resolve(fields.textureUrl);
      textureIds.push(resolutionIdentity(fields.textureUrl, spriteResolution));
      spriteTexture = resolution(state, spriteResolution, pending("texture", fields.textureUrl), (message) => unsupported(`Particle sprite: ${message}`)) ?? undefined;
    }
    let maskTexture: ExecutorTexture | undefined;
    if (fields.maskUrl) {
      const maskResolution = options.textures.resolve(fields.maskUrl);
      textureIds.push(resolutionIdentity(fields.maskUrl, maskResolution));
      maskTexture = resolution(state, maskResolution, pending("texture", fields.maskUrl), (message) => unsupported(`Particle mask: ${message}`)) ?? undefined;
    }
    let lutTexture: ExecutorTexture | undefined;
    if (fields.colorLut?.length) {
      if (!options.textures.resolveLut) return unsupported("Particle color LUT needs a stage-owned LUT registry.");
      const lutKey = `lut:${canonical(fields.colorLut)}:${fields.colorLutInterpolation ?? 0}`;
      const lutResolution = options.textures.resolveLut(fields.colorLut, fields.colorLutInterpolation ?? 0);
      textureIds.push(resolutionIdentity(lutKey, lutResolution));
      lutTexture = resolution(state, lutResolution, pending("lut"), (message) => unsupported(`Particle color LUT: ${message}`)) ?? undefined;
    }
    if (state.unsupported) return state.unsupported;
    if (state.pending) return state.pending;
    const resourceVersion = particleVersion(node, textureIds);
    return {
      status: "ready",
      kind: "particles",
      nodeId: node.id,
      resourceIdentity: identity,
      resourceVersion,
      blend: canvasBlendFromParticle(fields.blendMode),
      origin: [originX, originY],
      pass: {
        config: renderConfig,
        ...(spriteTexture ? { spriteTexture } : {}),
        ...(maskTexture ? { maskTexture } : {}),
        ...(lutTexture ? { lutTexture } : {}),
      },
    };
  };

  return {
    map(node, geometry) {
      if (node.particleSpec) return mapParticles(node);
      if (node.shaderId) return mapShader(node, geometry);
      return null;
    },
    clear() {
      sources.clear();
    },
  };
}
