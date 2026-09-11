// Browser half of probe-geoclip-first-frame.mjs. It imports shipping Vite modules.
import { createGeoclipNode, geoclipPlacementFromManifest, probeGeoclip, uploadGeoclip } from "../frontend/src/mirror/geoclipPlayer";
import { loadSpineClip } from "../frontend/src/mirror/spineClip";

type RequestLog = { url: string; status: number; contentLength: number | null; bodyBytes: number | null; ms: number };
export type FirstFrameRequest = { lane: "geoclip" | "raster"; manifestUrl: string; fileUrlTemplate: string; spineUrl: string };

const afterTwoRaf = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

function assertFiniteObject(value: Record<string, number> | null, label: string): asserts value is Record<string, number> {
  if (value === null || Object.values(value).some((number) => !Number.isFinite(number))) throw new Error(`${label} contains a missing or non-finite number`);
}

function paintStats(canvas: HTMLCanvasElement) {
  const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
  let alphaPixels = 0;
  for (let index = 3; index < pixels.length; index += 4) if (pixels[index] !== 0) alphaPixels += 1;
  return { width: canvas.width, height: canvas.height, alphaPixels, totalPixels: canvas.width * canvas.height };
}

function webgl2Probe() {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl) return { available: false, renderer: null };
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  return { available: true, renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null };
}

function normalizeHarnessCanvas(canvas: HTMLCanvasElement) {
  // The player correctly places itself in MirrorView's transformed node parent.
  // This bare harness has no parent, so neutralize only that DOM placement.
  canvas.style.transform = "none";
  canvas.style.position = "static";
  canvas.style.left = "auto";
  canvas.style.top = "auto";
  const scale = Math.min(1, innerWidth / canvas.width, innerHeight / canvas.height);
  canvas.style.width = `${canvas.width * scale}px`;
  canvas.style.height = `${canvas.height * scale}px`;
  const rect = canvas.getBoundingClientRect();
  const visibleWidth = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
  const visibleHeight = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
  if (!(visibleWidth > 0 && visibleHeight > 0)) throw new Error("normalized canvas has no visible area in viewport");
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale, visibleWidth, visibleHeight };
}

function validateFrameZeroGeometry(clip: Exclude<Awaited<ReturnType<typeof probeGeoclip>>, null>) {
  let refVertexValues = 0;
  for (const part of clip.parts.values()) {
    if (part.refVerts.length < 6 || part.refVerts.length % 2 !== 0 || part.indices.length < 3 || part.indices.length % 3 !== 0) throw new Error(`part ${part.id} has incomplete geometry`);
    for (const value of part.refVerts) {
      if (!Number.isFinite(value)) throw new Error(`part ${part.id} has non-finite reference vertices`);
      refVertexValues += 1;
    }
    const vertexCount = part.refVerts.length / 2;
    for (const index of part.indices) if (!Number.isInteger(index) || index < 0 || index >= vertexCount) throw new Error(`part ${part.id} has invalid index`);
  }
  const frame = clip.frames[0];
  if (!frame) throw new Error("geoclip has no frame zero");
  let drawnSlots = 0;
  for (const slot of frame.slots.values()) {
    if (slot.part === null) continue;
    const part = clip.parts.get(slot.part);
    if (!part) throw new Error(`frame zero references missing part ${slot.part}`);
    if (slot.color && slot.color.some((value) => !Number.isFinite(value))) throw new Error(`slot ${slot.part} has non-finite colour`);
    if (slot.xform && (slot.xform.length < 6 || slot.xform.some((value) => !Number.isFinite(value)))) throw new Error(`slot ${slot.part} has non-finite affine transform`);
    if (slot.verts && (slot.verts.length !== part.refVerts.length || [...slot.verts].some((value) => !Number.isFinite(value)))) throw new Error(`slot ${slot.part} has invalid deform vertices`);
    drawnSlots += 1;
  }
  if (drawnSlots === 0) throw new Error("frame zero draws no parts");
  return { parts: clip.parts.size, refVertexValues, drawnSlots };
}

async function withNetwork<T>(work: () => Promise<T>) {
  const originalFetch = window.fetch.bind(window);
  const requests: RequestLog[] = [];
  const accounting: Promise<void>[] = [];
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const start = performance.now();
    const response = await originalFetch(input, init);
    const record: RequestLog = { url: typeof input === "string" ? input : input.toString(), status: response.status, contentLength: Number(response.headers.get("content-length")) || null, bodyBytes: null, ms: performance.now() - start };
    requests.push(record);
    // Do not await a clone here. A clone body can be large and decoding it before
    // the player sees Response serializes first-paint behind accounting work.
    accounting.push(response.clone().arrayBuffer().then((body) => { record.bodyBytes = body.byteLength; }, () => {}));
    return response;
  };
  try { return { value: await work(), requests, accounting }; } finally { window.fetch = originalFetch; }
}

export async function runFirstFrame(request: FirstFrameRequest) {
  document.body.replaceChildren();
  document.body.style.cssText = "margin:0;background:transparent;overflow:hidden";
  const start = performance.now();
  const phases: Record<string, number | null> = { geoclipProbeDurationMs: null, geoclipUploadDurationMs: null, geoclipDrawDurationMs: null, rasterDecodeDrawDurationMs: null, startToAfterTwoRafMs: null };
  let placement: Record<string, number> | null = null;
  let geometry: Record<string, number> | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let fallback: Record<string, unknown> | null = null;
  let viewport: Record<string, number> | null = null;
  const fileUrl = (file: string) => request.fileUrlTemplate.replace("{file}", encodeURIComponent(file));

  const presentRaster = async (reason: string | null) => {
    const phaseStart = performance.now();
    const loaded = await loadSpineClip(request.spineUrl);
    const frame = loaded.frames[0];
    if (!frame?.bitmap) throw new Error("raster frame was not decoded to a drawable bitmap");
    placement = { canvasWidth: loaded.canvasWidth, canvasHeight: loaded.canvasHeight, localX: loaded.localX, localY: loaded.localY, localWidth: loaded.localWidth, localHeight: loaded.localHeight };
    canvas = document.createElement("canvas");
    canvas.width = loaded.canvasWidth;
    canvas.height = loaded.canvasHeight;
    document.body.append(canvas);
    canvas.getContext("2d")!.drawImage(frame.bitmap, frame.offsetX, frame.offsetY, frame.width, frame.height);
    viewport = normalizeHarnessCanvas(canvas);
    phases.rasterDecodeDrawDurationMs = performance.now() - phaseStart;
    await afterTwoRaf();
    phases.startToAfterTwoRafMs = performance.now() - start;
    if (reason) fallback = { from: "geoclip", reason, totalAfterTwoRafMs: phases.startToAfterTwoRafMs };
  };

  const observed = await withNetwork(async () => {
    if (request.lane === "raster") return presentRaster(null);
    const probeStart = performance.now();
    const clip = await probeGeoclip(request.manifestUrl, fileUrl);
    phases.geoclipProbeDurationMs = performance.now() - probeStart;
    if (!clip) return presentRaster("probe-null");
    const manifestPlacement = geoclipPlacementFromManifest(clip);
    if (!manifestPlacement || !clip.placement) return presentRaster("manifest-placement-null");
    placement = { ...manifestPlacement, localHeight: clip.placement.localHeight };
    geometry = validateFrameZeroGeometry(clip);
    const uploadStart = performance.now();
    const gpu = await uploadGeoclip(clip);
    phases.geoclipUploadDurationMs = performance.now() - uploadStart;
    if (!gpu) return presentRaster("upload-null");
    const node = createGeoclipNode(clip, gpu, manifestPlacement);
    if (!node) return presentRaster("node-null");
    document.body.append(node.el);
    const drawStart = performance.now();
    if (!node.draw(0)) { node.dispose(); return presentRaster("draw-false"); }
    canvas = node.el;
    viewport = normalizeHarnessCanvas(canvas);
    phases.geoclipDrawDurationMs = performance.now() - drawStart;
    await afterTwoRaf();
    phases.startToAfterTwoRafMs = performance.now() - start;
  });

  assertFiniteObject(placement, "placement");
  await Promise.all(observed.accounting);
  if (!canvas || !viewport) throw new Error("no canvas was presented");
  const paint = paintStats(canvas);
  if (paint.alphaPixels === 0) throw new Error("presented canvas is fully transparent");
  const resourceTiming = performance.getEntriesByType("resource").filter((entry) => {
    const name = entry.name;
    return name.includes("/geoclips/") || name.includes("/spines/") || name.includes("/__artifact/");
  }).map((entry) => {
    const timing = entry as PerformanceResourceTiming;
    return { name: timing.name, transferSize: timing.transferSize || null, encodedBodySize: timing.encodedBodySize || null, decodedBodySize: timing.decodedBodySize || null };
  });
  return { schema: "geoclip-first-frame/1", lane: request.lane, presentedLane: fallback ? "raster-fallback" : request.lane, phases, placement, capturedGeometry: geometry, paint, viewport, fallback, requests: observed.requests, resourceTiming, backendProbe: { presentedCanvas: "2d", webgl2: webgl2Probe(), note: "the WebGL2 probe is a separate diagnostic context; do not infer the presentation backend or hardware acceleration from it" }, moduleUrl: import.meta.url, firstBrowserPresentedDefinition: "after draw plus exactly two requestAnimationFrame callbacks", caveat: "two-rAF is a browser presentation proxy, not compositor/display scanout proof" };
}

(window as Window & { __geoclipFirstFrameRun?: typeof runFirstFrame }).__geoclipFirstFrameRun = runFirstFrame;
