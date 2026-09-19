// Geoclip playback for the live-tree MIRROR.
//
// WHAT A GEOCLIP IS. The other spine path streams a RASTER clip from `/spines/` — one baked image per frame,
// megabytes per animation. A "geoclip" is the same animation baked as GEOMETRY instead: per-part reference
// vertices and triangle indices once, then per frame either a 2x3 affine (a rigid part) or a full vertex array
// (a deforming one), plus a draw order, a per-slot tint, and the atlas pages the parts sample. Measured on two
// real rigs it is 2.2-4.2x smaller than the webp-q90 raster truth, and ~82x smaller for the SECOND animation of a
// rig that has already paid for its pages.
//
// THIS MODULE is a TypeScript port of `scripts/geoclip-harness.html` — the standalone WebGL2 player the bake was
// validated against — with the harness's tolerance rules kept verbatim, because those rules ARE the artifact
// contract. Couch reads one packed encoding: `geoclip/1` manifests reference
// packed sheets and `verts.bin`; deforming slots carry a `vref` record ordinal.
//
// ONE WEBGL CONTEXT, MANY CREATURES. A browser hands out ~8-16 WebGL contexts per page and a combat screen can
// hold more spine nodes than that, so every geoclip renders through ONE shared, off-DOM WebGL2 canvas and the
// result is blitted into each node's own 2D canvas. That also keeps the node's paint element exactly the kind of
// element the baked path already mounts — a `<canvas>` sized to the clip's shared canvas, carrying the same
// placement transform — so nothing above this module has to learn a new geometry.
//
// FAILURE IS ALWAYS A FALLBACK, NEVER A BLANK. Any failure at any stage (manifest 404, malformed JSON, no WebGL2,
// a page texture that will not load, a lost context, a GL error) resolves to `null`/`false`, and the caller's
// contract is to leave that node on the raster clip for the rest of the session. That contract carries the whole
// weight now that this IS the shipping path: every viewer takes it, so every one of those failure arms is a real
// creature on a real phone.
//
// THE ONE IMPORT. This module is otherwise standalone (it is a port of a dependency-free harness), and the bench
// seams below are the sole reason it reaches out: `mirrorWalkStats` is the single published counter surface both
// backends' harnesses already read, so a geoclip lane measured anywhere else would be invisible to them. Counters
// only — nothing here reads walk state back.
import { mirrorWalkStats } from "@/mirror/renderer/walkStats";
import { pxCss } from "@/mirror/stageFit";
import { asPresentationPackedGeoclip } from "@/mirror/geoclipManifest";
import {
  foldGeoclipUvs as foldSharedGeoclipUvs,
  recoverGeoclip,
  recoverGeoclipVerts,
  recoveringGeoclipFrameIndexAt,
  sampleRecoveringGeoclipFrame,
  type RecoveringGeoclip,
  type RecoveringGeoclipFrame,
  type RecoveringGeoclipPage,
  type RecoveringGeoclipPart,
  type RecoveringGeoclipPlacement,
  type RecoveringGeoclipSlot,
  type RecoveringGeoclipVertexBin,
} from "@spirectl/presentation/spine";

/** `performance.now` where it exists, `Date.now` otherwise — the bench seams' clock, and nothing else's. */
function nowMs(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

// ---- the artifact, decoded ----------------------------------------------------------------------------------

export interface GeoclipFit {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

export type GeoclipPage = RecoveringGeoclipPage;
export type GeoclipPart = RecoveringGeoclipPart;
export type GeoclipSlot = RecoveringGeoclipSlot;
export type GeoclipFrame = RecoveringGeoclipFrame;
export type GeoclipVertsBin = RecoveringGeoclipVertexBin;

/**
 * `meta.placement` — the bake's OWN skeleton-local -> canvas placement, stated rather than inferred (Phase 4, W1).
 *
 * The host computes it with the SAME `FrameFromBoundsFitted` the raster still renderer uses, on the skeleton
 * bounds read at the sampled pose, so these seven numbers are the raster path's `clipPlacement` for the same
 * identity — emitted directly instead of being recovered by inverting an image the client had to fetch first.
 * The current packed `geoclip/1` schema carries this placement directly.
 */
export type GeoclipManifestPlacement = RecoveringGeoclipPlacement;
export type GeoclipClip = Omit<RecoveringGeoclip, "pages" | "frames"> & {
  readonly pages: RecoveringGeoclipPage[];
  readonly frames: RecoveringGeoclipFrame[];
  readonly fileUrl: (file: string) => string;
};

function toCouchGeoclip(
  clip: RecoveringGeoclip,
  fileUrl: (file: string) => string,
): GeoclipClip {
  return { ...clip, schema: "geoclip/1", pages: [...clip.pages], frames: [...clip.frames], fileUrl };
}

/**
 * `meta.placement`, read on the module's tolerance rule: ABSENT is null, and so is MALFORMED or PARTIAL. It is
 * never fatal — a manifest whose placement cannot be trusted falls back to the baked-clip inversion, which is
 * exactly what every pre-Phase-4 manifest does.
 *
 * ALL SEVEN fields are required, because a partial one is indistinguishable from a producer that changed the
 * shape: half a placement would be applied as confidently as a whole one and land the creature somewhere
 * plausible-but-wrong, which is the hardest kind of failure to see. `canvasWidth`/`canvasHeight` must additionally
 * be POSITIVE — they are the geoclip element's own pixel resolution when it mounts from the manifest alone, and a
 * zero-sized canvas draws nothing at all.
 */

/**
 * The mount placement a clip can supply ON ITS OWN, or null when it carries none.
 *
 * The one funnel both backends build their manifest-sourced placement through, so the DOM arm and the canvas arm
 * cannot derive a different box from the same seven numbers.
 */
export function geoclipPlacementFromManifest(
  clip: GeoclipClip,
): GeoclipPlacement | null {
  const placement = clip.placement;
  if (!placement) {
    return null;
  }
  return {
    canvasWidth: placement.canvasWidth,
    canvasHeight: placement.canvasHeight,
    localX: placement.localX,
    localY: placement.localY,
    localWidth: placement.localWidth,
    fitScale: placement.fitScale,
  };
}

/**
 * Parse a geoclip manifest into the in-memory clip the renderer walks. Pure — no DOM, no fetch — so the whole
 * decode (including packed-vertex quantisation) is unit-testable.
 *
 * TOLERANCE, kept from the harness because the artifact contract says so: unknown fields at every level are
 * ignored, a missing `drawOrder` means ascending slot order, `part: null` means "explicitly hidden", and a missing
 * `color` means white. Throws when the document is not Couch's packed geoclip contract.
 *
 * `meta.placement` (Phase 4) is read on that same rule: absent OR malformed OR partial is null, never a throw.
 * A clip with no usable placement simply falls back to the baked-clip inversion.
 */
export function parseGeoclipManifest(
  raw: unknown,
  fileUrl: (file: string) => string,
): GeoclipClip {
  const presentationManifest = asPresentationPackedGeoclip(raw);
  if (!presentationManifest) {
    throw new Error("geoclip: expected packed geoclip/1 manifest with verts.bin");
  }
  const recovered = recoverGeoclip(presentationManifest);
  if (!recovered.value) {
    throw new Error(
      recovered.diagnostics[0]?.message ?? "geoclip: manifest is not usable",
    );
  }
  return toCouchGeoclip(recovered.value, fileUrl);
}

/**
 * Materialise every packed `vref` slot's positions from `verts.bin` so the renderer can draw it.
 *
 * Layout (little-endian): record `i` starts at `vertsBin.offsets[i]` and holds `vertCount(part) * 2` u16 values,
 * interleaved x,y. Dequantised against the part's own bbox, so the worst-case error is `range / 65535` — subpixel
 * for any real rig, which is exactly why the encoding is allowed to be lossy.
 *
 * A record that is out of range, truncated, or belongs to a part with no quantisation box is SKIPPED (the slot
 * falls back to its xform / reference pose) rather than throwing: one bad record must not cost the whole clip.
 */
export function applyGeoclipVerts(
  clip: GeoclipClip,
  buffer: ArrayBuffer,
): void {
  const recovered = recoverGeoclipVerts(clip, buffer);
  if (recovered.value) {
    Object.assign(clip, toCouchGeoclip(recovered.value, clip.fileUrl));
  }
  for (const item of recovered.diagnostics) {
    noteGeoclipWarning(item.message);
  }
  return;
}

/**
 * The frame to show at playback time `timeMs` — the geoclip twin of `frameIndexAt` in spineClip.ts, driven by the
 * SAME clock the baked path uses so a swap between the two never jumps.
 *
 * A geoclip's frames are uniformly spaced by construction (the baker steps the track time at a fixed fps), so
 * this is arithmetic rather than a search. `loop` wraps; otherwise a one-shot holds its LAST frame forever, which
 * is what an attack/hurt/die animation must do.
 *
 * The geoclip baker emits endpoint-inclusive samples over [0, duration]. A looping animation therefore uses the
 * manifest duration as its period: `periodFrames = round(durationMs / 1000 * fps)` (60 for a 61-frame 30fps clip).
 * When `durationMs` is absent or degenerate, recovery falls back to `count - 1`; its period remains clamped into
 * [1, count] so a malformed manifest can neither modulo by 0 nor address a frame that does not exist.
 *
 * The CLAMP path is UNCHANGED and must stay that way: a one-shot has to hold its true last frame (`count - 1`)
 * forever, which is precisely what the endpoint-inclusive bake exists to give it. The baker is deliberately left
 * alone — dropping its tail would truncate every one-shot by a frame and invalidate every artifact already baked.
 */
export function geoclipFrameIndexAt(
  clip: {
    readonly frames: readonly unknown[];
    fps: number;
    durationMs?: number;
  },
  timeMs: number,
  loop = true,
): number {
  return recoveringGeoclipFrameIndexAt(clip, timeMs, loop);
}

/**
 * The skeleton-local -> clip-canvas-pixel mapping. Two sources, in precedence order.
 *
 *   1. `placement.fitScale` — the BAKE's own factor, present only when it came from a manifest `meta.placement`
 *      (Phase 4, W1). Stated, not inferred, and it is what lets a geoclip mount with no baked clip at all.
 *   2. inverting the placement (`canvasWidth / localWidth`) — the original derivation, described below, and still
 *      what every pre-Phase-4 manifest gets.
 *
 * The two answers are the SAME NUMBER for a rig that has both, and that is not a coincidence to be trusted quietly: the
 * host mints `clipPlacement = (-NodePosition/fitScale, cellSize/fitScale)` from the same `FrameFromBoundsFitted`
 * the manifest's placement is emitted from, so `localWidth / canvasWidth == 1 / fitScale` and
 * `offsetX == -localX * fitScale == NodePosition.X` either way. `geoclipPlayer.spec` asserts that equivalence
 * directly, because a silent divergence there is a creature standing in the wrong place.
 *
 * The baked path mounts a canvas of `canvasWidth x canvasHeight` pixels and places it with
 * `translate(localX, localY) scale(s)`, `s = localWidth / canvasWidth` — i.e. canvas pixel `p` lands at node-local
 * `(localX, localY) + s * p`. A geoclip's vertices are in SKELETON-LOCAL space, which is the same space (Godot
 * units, y-down) the placement rect is expressed in, so inverting that placement is the whole mapping:
 *
 *     canvasX = (skelX - localX) / s ,  canvasY = (skelY - localY) / s
 *
 * WHY THIS IS AN INFERENCE AND NOT A READ. No geoclip manifest field states where the skeleton origin sits in the
 * bake's canvas — Phase 1 had to find the alignment with an IoU optimiser, and recorded that its per-frame bounds
 * cannot be used for it either (region quads inflate the bbox). The identification of skeleton-local with
 * node-local is what the two measured fits support: the rig whose truth was captured at native scale fitted at
 * 1.0096, and the rig captured at a 0.35x decoded-footprint downscale fitted at 0.3405 — that is `1/s` tracking
 * the bake's own downscale to within ~1% and ~3%, which is the optimiser's own error, not a different mapping.
 *
 * BELT: a missing placement is `localWidth = 0` on the baked wire, and 1/0 would put the clip at infinity. Fall
 * back to scale 1 for the same reason the baked path does — visibly wrong beats invisible.
 */
export function deriveGeoclipFit(placement: {
  canvasWidth: number;
  localX: number;
  localY: number;
  localWidth: number;
  /** The manifest's own `fitScale`, when this placement came from one. Absent => invert the rect (source 3). */
  fitScale?: number | null;
}): GeoclipFit {
  const declared = placement.fitScale;
  if (
    typeof declared === "number" &&
    Number.isFinite(declared) &&
    declared > 0
  ) {
    return {
      scaleX: declared,
      scaleY: declared,
      offsetX: -placement.localX * declared,
      offsetY: -placement.localY * declared,
    };
  }
  const scale =
    placement.canvasWidth > 0 && placement.localWidth > 0
      ? placement.localWidth / placement.canvasWidth
      : 1;
  const inverse = scale > 0 ? 1 / scale : 1;
  return {
    scaleX: inverse,
    scaleY: inverse,
    offsetX: -placement.localX * inverse,
    offsetY: -placement.localY * inverse,
  };
}

/**
 * A part's uvs folded from "normalised to my srcRect" into "normalised to the whole page", exactly as the harness
 * folds them at load: the sampler then needs one `texture()` and no per-fragment rect maths, so a frame that looks
 * wrong can never be the sampler's fault. The DECODED page size is passed in because it — not the manifest's
 * declared size — is what the sampler actually addresses.
 */
export function foldGeoclipUvs(
  part: GeoclipPart,
  pageWidth: number,
  pageHeight: number,
): Float32Array {
  const rect = part.srcRect ?? [0, 0, pageWidth, pageHeight];
  return foldSharedGeoclipUvs(part.uvs, rect, pageWidth, pageHeight);
}

// ---- probe + cache ------------------------------------------------------------------------------------------

// ONE probe per manifest url for the lifetime of the page, MISSES INCLUDED. A creature whose animation has no
// geoclip must cost exactly one 404 — not one per anim change, and not one per creature playing that anim.
const probes = new Map<string, Promise<GeoclipClip | null>>();

let loggedOnce = false;
let warnedOnce = false;

/** Report a geoclip failure at most once per session; the caller reverts that node to the baked path. */
export function noteGeoclipFailure(reason: string): void {
  if (loggedOnce || typeof console === "undefined") {
    return;
  }
  loggedOnce = true;
  console.info(
    `[mirror] geoclip playback unavailable (${reason}) — staying on the baked spine clip`,
  );
}

/**
 * Report a SURVIVABLE decode complaint once per session — a record the vertex blob could not supply, where the
 * slot falls back to its xform (or its reference pose) and everything else about the clip still plays. Kept off
 * `noteGeoclipFailure`'s latch on purpose: a skipped slot must not consume the one line a real, node-reverting
 * failure gets to print.
 */
function noteGeoclipWarning(reason: string): void {
  if (warnedOnce || typeof console === "undefined") {
    return;
  }
  warnedOnce = true;
  console.info(
    `[mirror] geoclip decode warning (${reason}) — that slot falls back to its rigid transform`,
  );
}

/**
 * Fetch + decode the geoclip for one manifest url, or null when there is none (or it is unusable). Cached per
 * url, resolved value included, so a repeated ask is free and a miss is never re-probed.
 */
export function probeGeoclip(
  manifestUrl: string,
  fileUrl: (file: string) => string,
): Promise<GeoclipClip | null> {
  const existing = probes.get(manifestUrl);
  if (existing) {
    return existing;
  }
  const startedMs = nowMs();
  const probe = loadGeoclip(manifestUrl, fileUrl).catch((error: unknown) => {
    noteGeoclipFailure(
      `${manifestUrl}: ${(error as Error)?.message ?? String(error)}`,
    );
    return null;
  });
  // A DETACHED subscription, not a link in the chain the caller gets: folding the timing in with `.then`/`.finally`
  // would put an extra microtask between the fetch settling and every consumer seeing it, for a counter nobody
  // waits on. Below the cache lookup on purpose — a cached ask paid no request and must add no ms.
  void probe.then(() => {
    mirrorWalkStats.geoclipProbeMs += nowMs() - startedMs;
  });
  probes.set(manifestUrl, probe);
  return probe;
}

async function loadGeoclip(
  manifestUrl: string,
  fileUrl: (file: string) => string,
): Promise<GeoclipClip | null> {
  const response = await fetch(manifestUrl, { cache: "no-store" });
  if (!response.ok) {
    return null; // the ordinary "this rig has no geoclip" answer — not a failure worth logging
  }
  const clip = parseGeoclipManifest(await response.json(), fileUrl);
  if (clip.frames.length === 0 || clip.parts.size === 0) {
    return null;
  }
  // packed geoclip/1 always emits a `vertsBin` block — possibly `records: 0` against a zero-byte verts.bin, when every
  // part of the rig turned out rigid — so its PRESENCE, not its record count, is what says "there is a blob".
  if (clip.vertsBin) {
    const binResponse = await fetch(fileUrl(clip.vertsBin.file), {
      cache: "no-store",
    });
    if (!binResponse.ok) {
      // A manifest that declares a blob it cannot serve is a BROKEN artifact, not an absent one — worth the one
      // log line, unlike an ordinary "this rig has no geoclip" 404 on the manifest itself.
      noteGeoclipFailure(
        `${clip.vertsBin.file} is declared but missing (${binResponse.status})`,
      );
      return null;
    }
    applyGeoclipVerts(clip, await binResponse.arrayBuffer());
  }
  return clip;
}

/** TEST-ONLY: forget every probe (and its cached miss), and every once-per-session log latch. */
export function __clearGeoclipProbesForTest(): void {
  probes.clear();
  loggedOnce = false;
  warnedOnce = false;
}

// ---- the shared WebGL2 renderer -----------------------------------------------------------------------------

const VERTEX_SHADER = `#version 300 es
in vec2 aPos;
in vec2 aUV;
uniform vec2 uRes;
uniform vec4 uFit;
out vec2 vUV;
void main() {
  vUV = aUV;
  vec2 c = vec2(aPos.x * uFit.x + uFit.z, aPos.y * uFit.y + uFit.w);
  vec2 n = (c / uRes) * 2.0 - 1.0;
  gl_Position = vec4(n.x, -n.y, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec4 uColor;
in vec2 vUV;
out vec4 outColor;
void main() {
  outColor = texture(uTex, vUV) * uColor;
}`;

interface SharedRenderer {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  uRes: WebGLUniformLocation;
  uFit: WebGLUniformLocation;
  uColor: WebGLUniformLocation;
  aPos: number;
  aUV: number;
  lost: boolean;
}

// undefined = never attempted; null = attempted and unavailable (never retried — a machine without WebGL2 will
// not grow it mid-session, and retrying would mean a context-creation attempt per creature per frame).
let shared: SharedRenderer | null | undefined;

function ensureRenderer(): SharedRenderer | null {
  if (shared !== undefined) {
    return shared && !shared.lost ? shared : null;
  }
  shared = null;
  if (typeof document === "undefined") {
    return null;
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      // Straight (non-premultiplied) alpha end to end, matching the harness the bake was validated against:
      // textures upload with UNPACK_PREMULTIPLY_ALPHA off and the fragment output is `texel * slotColor`.
      premultipliedAlpha: false,
      // The blit into each node's 2D canvas happens after the draw, outside the GL call that produced it.
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      noteGeoclipFailure("no webgl2 context");
      return null;
    }
    const program = linkProgram(gl);
    if (!program) {
      return null;
    }
    const uRes = gl.getUniformLocation(program, "uRes");
    const uFit = gl.getUniformLocation(program, "uFit");
    const uColor = gl.getUniformLocation(program, "uColor");
    if (!uRes || !uFit || !uColor) {
      noteGeoclipFailure("shader uniforms missing");
      return null;
    }
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "uTex"), 0);
    gl.disable(gl.DEPTH_TEST);
    // A baked mesh's winding is whatever the rig produced; painter's order is the only rule.
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    const renderer: SharedRenderer = {
      canvas,
      gl,
      program,
      uRes,
      uFit,
      uColor,
      aPos: gl.getAttribLocation(program, "aPos"),
      aUV: gl.getAttribLocation(program, "aUV"),
      lost: false,
    };
    // A LOST context does not throw — every later call is a silent no-op, so without this listener the mirror
    // would blit transparent frames forever and report a clean run.
    canvas.addEventListener(
      "webglcontextlost",
      (event) => {
        event.preventDefault();
        renderer.lost = true;
        noteGeoclipFailure("webgl context lost");
      },
      false,
    );
    shared = renderer;
    return renderer;
  } catch (error) {
    noteGeoclipFailure(
      `webgl2 setup: ${(error as Error)?.message ?? String(error)}`,
    );
    return null;
  }
}

function linkProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
  const compile = (type: number, source: string): WebGLShader | null => {
    const shader = gl.createShader(type);
    if (!shader) {
      return null;
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      noteGeoclipFailure(
        `shader: ${gl.getShaderInfoLog(shader) ?? "compile failed"}`,
      );
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = vertex ? compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER) : null;
  if (!vertex || !fragment) {
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    return null;
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    noteGeoclipFailure(
      `link: ${gl.getProgramInfoLog(program) ?? "link failed"}`,
    );
    return null;
  }
  return program;
}

interface GpuPage {
  texture: WebGLTexture;
  width: number;
  height: number;
}

interface GpuPart {
  page: GpuPage;
  posBuffer: WebGLBuffer;
  uvBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
  indexCount: number;
  indexType: number;
  refVerts: Float32Array;
  scratch: Float32Array;
  blendMode: number;
}

/** An uploaded clip: opaque above this module, and shared by every node playing the same animation. */
export interface GpuClip {
  parts: Map<string, GpuPart>;
}

// One upload per CLIP, shared by every node playing it (two of the same creature on screen pay once).
const uploads = new WeakMap<GeoclipClip, Promise<GpuClip | null>>();

/** Upload a clip's pages + static buffers, once. Resolves null when anything about it is unusable. */
export function uploadGeoclip(clip: GeoclipClip): Promise<GpuClip | null> {
  const existing = uploads.get(clip);
  if (existing) {
    return existing;
  }
  const startedMs = nowMs();
  const upload = uploadGeoclipOnce(clip).catch((error: unknown) => {
    noteGeoclipFailure(`upload: ${(error as Error)?.message ?? String(error)}`);
    return null;
  });
  // Detached, and below the cache lookup, for `probeGeoclip`'s reasons exactly — see the note there.
  void upload.then(() => {
    mirrorWalkStats.geoclipUploadMs += nowMs() - startedMs;
  });
  uploads.set(clip, upload);
  return upload;
}

async function uploadGeoclipOnce(clip: GeoclipClip): Promise<GpuClip | null> {
  const renderer = ensureRenderer();
  if (!renderer) {
    return null;
  }
  const { gl } = renderer;

  const images = await Promise.all(
    clip.pages.map((page) => loadImage(clip.fileUrl(page.file))),
  );
  const pages = new Map<string, GpuPage>();
  for (let i = 0; i < clip.pages.length; i++) {
    const image = images[i];
    if (!image) {
      return null; // a missing page means missing ink; the baked clip is the better answer
    }
    const texture = gl.createTexture();
    if (!texture) {
      return null;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    // LINEAR + CLAMP_TO_EDGE, no mips. Packed sheets carry a real 1px extrusion around each srcRect, so linear
    // sampling cannot bleed into a neighbour.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // The DECODED size wins over the manifest's declared one: it is what the sampler addresses.
    pages.set(clip.pages[i].id, {
      texture,
      width: image.naturalWidth,
      height: image.naturalHeight,
    });
  }

  const parts = new Map<string, GpuPart>();
  for (const part of clip.parts.values()) {
    const page = pages.get(part.pageId);
    if (!page) {
      continue; // an unknown pageId hides that part, exactly as the harness's tolerance rules do
    }
    const uvs = foldGeoclipUvs(part, page.width, page.height);
    const wide = part.refVerts.length >> 1 > 65535;
    const indices = wide
      ? Uint32Array.from(part.indices)
      : Uint16Array.from(part.indices);
    const posBuffer = gl.createBuffer();
    const uvBuffer = gl.createBuffer();
    const indexBuffer = gl.createBuffer();
    if (!posBuffer || !uvBuffer || !indexBuffer) {
      return null;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, part.refVerts.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    parts.set(part.id, {
      page,
      posBuffer,
      uvBuffer,
      indexBuffer,
      indexCount: indices.length,
      indexType: wide ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
      refVerts: part.refVerts,
      scratch: new Float32Array(part.refVerts.length),
      blendMode: part.blendMode,
    });
  }
  return parts.size > 0 ? { parts } : null;
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (typeof Image === "undefined") {
      resolve(null);
      return;
    }
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/**
 * The positions to draw for one slot: the deforming array when it is present AND the right length, else the
 * rigid affine applied to the reference pose, else the reference pose itself. A `verts` array of the wrong length
 * is discarded rather than drawn — the harness's rule, and the one that keeps a half-decoded v2 record from
 * exploding a creature across the screen.
 */
const WHITE: [number, number, number, number] = [1, 1, 1, 1];

/**
 * Draw one frame into the shared canvas's top-left `width x height` rect. Returns false if the renderer is gone.
 *
 * The shared canvas is only ever GROWN (never shrunk to fit a smaller creature): a resize reallocates the drawing
 * buffer, and alternating sizes across N creatures on one rAF would reallocate N times a frame. The viewport is
 * offset instead — GL's origin is bottom-left, so `y = height(canvas) - height(clip)` puts the clip's own canvas
 * space in the TOP-left, which is where the 2D blit reads it from.
 */
function drawFrameToShared(
  gpu: GpuClip,
  clip: GeoclipClip,
  frameIndex: number,
  fit: GeoclipFit,
  width: number,
  height: number,
): boolean {
  const renderer = ensureRenderer();
  if (!renderer || renderer.lost) {
    return false;
  }
  const { gl, canvas } = renderer;
  if (canvas.width < width || canvas.height < height) {
    canvas.width = Math.max(canvas.width, width);
    canvas.height = Math.max(canvas.height, height);
  }

  gl.viewport(0, canvas.height - height, width, height);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(0, canvas.height - height, width, height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.useProgram(renderer.program);
  gl.uniform2f(renderer.uRes, width, height);
  gl.uniform4f(renderer.uFit, fit.scaleX, fit.scaleY, fit.offsetX, fit.offsetY);
  gl.enable(gl.BLEND);

  for (const mesh of sampleRecoveringGeoclipFrame(clip, frameIndex).meshes) {
    const part = gpu.parts.get(mesh.partId);
    if (!part) {
      continue;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, part.posBuffer);
    part.scratch.set(mesh.positions);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, part.scratch);
    gl.enableVertexAttribArray(renderer.aPos);
    gl.vertexAttribPointer(renderer.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, part.uvBuffer);
    gl.enableVertexAttribArray(renderer.aUV);
    gl.vertexAttribPointer(renderer.aUV, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, part.indexBuffer);

    const color = mesh.slot.color ?? WHITE;
    gl.uniform4f(renderer.uColor, color[0], color[1], color[2], color[3]);
    // Per-part blend: the mode is a property of the ATTACHMENT, so it is set per draw rather than batched.
    // Alpha blends separately with (ONE, ONE_MINUS_SRC_ALPHA) so the canvas accumulates a sane coverage channel
    // over the transparent clear.
    if (part.blendMode === 1) {
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE);
    } else {
      gl.blendFuncSeparate(
        gl.SRC_ALPHA,
        gl.ONE_MINUS_SRC_ALPHA,
        gl.ONE,
        gl.ONE_MINUS_SRC_ALPHA,
      );
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, part.page.texture);
    gl.drawElements(gl.TRIANGLES, part.indexCount, part.indexType, 0);
  }
  gl.disable(gl.SCISSOR_TEST);
  return true;
}

// ---- the per-node handle ------------------------------------------------------------------------------------

export interface GeoclipPlacement {
  canvasWidth: number;
  canvasHeight: number;
  localX: number;
  localY: number;
  localWidth: number;
  /**
   * The bake's own fit factor, set ONLY when this placement was built from a manifest `meta.placement`
   * (`geoclipPlacementFromManifest`). Absent on a placement inverted from a baked raster clip, which is what
   * keeps the two sources from being mixed: a placement is taken from ONE of them, whole.
   */
  fitScale?: number | null;
}

export interface GeoclipNode {
  /** The element to mount in the node's box. Carries the baked path's own placement contract. */
  readonly el: HTMLCanvasElement;
  /** Re-size + re-place after the baked clip's placement changed. Idempotent. */
  place(placement: GeoclipPlacement): void;
  /** Paint frame `index`. False = this node must revert to the baked path permanently. */
  draw(index: number): boolean;
  dispose(): void;
}

/**
 * Build the paint element for ONE node playing `clip`. Returns null when nothing can render it — the caller
 * reverts that node to the baked path for the session.
 *
 * The element is a plain 2D canvas carrying `.mirror-spine-canvas`'s placement contract (see MirrorView.vue): the
 * internal resolution IS the baked clip's shared canvas, and the transform maps that canvas-pixel space into node
 * local. That is deliberate — it means the geoclip occupies exactly the box the baked clip occupied, and the two
 * are interchangeable without the walk above knowing which one is painting.
 */
export function createGeoclipNode(
  clip: GeoclipClip,
  gpu: GpuClip,
  placement: GeoclipPlacement,
): GeoclipNode | null {
  if (typeof document === "undefined") {
    return null;
  }
  const el = document.createElement("canvas");
  el.className = "mirror-geoclip-canvas";
  const ctx = el.getContext("2d");
  if (!ctx) {
    noteGeoclipFailure("no 2d context for the geoclip paint element");
    return null;
  }

  let width = 1;
  let height = 1;
  let fit: GeoclipFit = { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
  let placementKey = "";

  const place = (next: GeoclipPlacement): void => {
    const w = Math.max(1, Math.round(next.canvasWidth));
    const h = Math.max(1, Math.round(next.canvasHeight));
    const scale =
      next.canvasWidth > 0 && next.localWidth > 0
        ? next.localWidth / next.canvasWidth
        : 1;
    // `fitScale` is part of the key, not decoration: the same rect can arrive from the manifest (with one) and
    // from the baked clip (without), and those two answers differ in the FIT even where the box is identical.
    const key = `${w}x${h}|${next.localX},${next.localY},${scale}|${next.fitScale ?? ""}`;
    if (key === placementKey) {
      return;
    }
    placementKey = key;
    width = w;
    height = h;
    fit = deriveGeoclipFit(next);
    if (el.width !== w) {
      el.width = w;
    }
    if (el.height !== h) {
      el.height = h;
    }
    // LAYOUT SPACE (stageFit.ts): `el.width/height` above are the GL backing store (resolution); these are the CSS
    // box and the node-local offset, both lengths. The trailing `scale()` maps clip px into the box — dimensionless.
    el.style.width = pxCss(w);
    el.style.height = pxCss(h);
    el.style.transform = `translate(${pxCss(next.localX)}, ${pxCss(next.localY)}) scale(${scale})`;
  };
  place(placement);

  // THE SINGLE MOUNT FUNNEL. Both backends build their geoclip element here and both treat a null return as a
  // failure, so counting at the last point that cannot fail keeps the DOM arm and the canvas arm on one number
  // without either of them learning about walk stats. See `geoclipMounts`.
  mirrorWalkStats.geoclipMounts += 1;

  return {
    el,
    place,
    draw(index: number): boolean {
      if (!clip.frames[index]) {
        return true; // out of range this tick; the last painted frame stays up
      }
      if (!drawFrameToShared(gpu, clip, index, fit, width, height)) {
        return false;
      }
      const source = ensureRenderer()?.canvas;
      if (!source) {
        return false;
      }
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(source, 0, 0, width, height, 0, 0, width, height);
      return true;
    },
    dispose(): void {
      el.remove();
    },
  };
}
