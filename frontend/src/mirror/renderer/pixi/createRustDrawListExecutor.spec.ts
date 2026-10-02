import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { createClipRectView, createDrawList, createQuadView } from "@godot-scene-web/canvas";
import type { PixiScenePlan, PixiTextRecord } from "@godot-scene-web/canvas/pixi";
import type { ProducerExecutorEvent } from "./producerBuildReasons";
import { createRustDrawListExecutor } from "./createRustDrawListExecutor";
import { createCouchCanvasProfile } from "./couchCanvasProfile";
import { ensureFontFace } from "@/mirror/fonts";

const moduleUrl = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.history.replaceState({}, "", "/");
  delete (globalThis as Record<string, unknown>).__rustProjectionTest;
  delete (window as unknown as Record<string, unknown>).__mirrorRustStats;
  delete (window as unknown as Record<string, unknown>).__mirrorRustRollbackProbe;
});

describe("Rust execution phase diagnostic", () => {
  it("presents supported drawings after another drawing's texture fails", async () => {
    window.history.replaceState({}, "", "/?rustDiagnostics=1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" }));
    const admit = vi.fn(() => JSON.stringify({ accepted: true, revision: 1, unsupportedCommands: 0, resourcePending: 0 }));
    (globalThis as Record<string, unknown>).__rustProjectionTest = { engine: {
      backend: "WebGL2", resize: () => {}, dispose: () => {}, upload_rgba_batch: () => 0,
      admit_scene: admit, apply_patch: () => "{}",
      present: async () => JSON.stringify({ presented: true, revision: 1, draws: 1,
        resourcePending: 0, unsupportedCommands: 0 }),
    } };
    vi.stubEnv("VITE_RUST_PROTOTYPE_MODULE_URL", moduleUrl(
      "export default async function init(){return {}};export class RustRenderer{static async create(){return globalThis.__rustProjectionTest.engine}}",
    ));
    vi.stubEnv("VITE_RUST_SCENE_SERIALIZER_URL", moduleUrl(
      "export function encodeRustScene(input){const omitted=!input.resolveTexture('/lost.png');return {bytes:new Uint8Array([1]),scene:{version:2,revision:1,width:1,height:1,designWidth:1,designHeight:1,resources:[],commands:[{id:'supported',kind:'quad'}]},resources:[],textUploads:[],unsupportedCommands:omitted?1:0,omittedKinds:omitted?{unresolvedResource:1}:{}}};export function encodeRustPatch(){return null};export function encodeRustResources(){return new Uint8Array(0)}",
    ));
    const renderer = await createRustDrawListExecutor({ canvas: document.createElement("canvas"), width: 1,
      height: 1, designWidth: 1, designHeight: 1, onInvalidate: () => {} });
    try {
      const list = createDrawList<string>();
      const quad = createQuadView(); quad.w = quad.h = quad.srcW = quad.srcH = 1;
      list.pushQuad(quad, "/lost.png"); list.pushQuad(quad);
      expect(await renderer.render(list, [])).toBe(false);
      await vi.waitFor(() => expect(renderer.stats.textureFailures).toBe(1));
      expect(await renderer.render(list, [])).toBe(true);
      expect(admit).toHaveBeenCalledOnce();
      expect((window as unknown as { __mirrorRustStats: () => { omittedKinds: Record<string, number> } }).__mirrorRustStats()
        .omittedKinds).toMatchObject({ unresolvedResource: 1 });
    } finally { renderer.dispose(); }
  });

  it("presents supported content when the serializer omits two unsupported drawings", async () => {
    window.history.replaceState({}, "", "/?rustDiagnostics=1");
    const admit = vi.fn(() => JSON.stringify({ accepted: true, revision: 1, unsupportedCommands: 0, resourcePending: 0 }));
    (globalThis as Record<string, unknown>).__rustProjectionTest = { engine: {
      backend: "WebGL2", resize: () => {}, dispose: () => {}, upload_rgba_batch: () => 0,
      admit_scene: admit, apply_patch: () => "{}",
      present: async () => JSON.stringify({ presented: true, revision: 1, draws: 1,
        resourcePending: 0, unsupportedCommands: 0 }),
    } };
    vi.stubEnv("VITE_RUST_PROTOTYPE_MODULE_URL", moduleUrl(
      "export default async function init(){return {}};export class RustRenderer{static async create(){return globalThis.__rustProjectionTest.engine}}",
    ));
    vi.stubEnv("VITE_RUST_SCENE_SERIALIZER_URL", moduleUrl(
      "export function encodeRustScene(){return {bytes:new Uint8Array([1]),scene:{version:2,revision:1,width:1,height:1,designWidth:1,designHeight:1,resources:[],commands:[{id:'q',kind:'quad'}]},resources:[],textUploads:[],unsupportedCommands:2,omittedKinds:{polyline:2}}};export function encodeRustPatch(){return null};export function encodeRustResources(){return new Uint8Array(0)}",
    ));
    const renderer = await createRustDrawListExecutor({ canvas: document.createElement("canvas"), width: 1,
      height: 1, designWidth: 1, designHeight: 1, onInvalidate: () => {} });
    const list = createDrawList<string>();
    const quad = createQuadView(); quad.w = quad.h = quad.srcW = quad.srcH = 1; list.pushQuad(quad);
    expect(await renderer.render(list, [])).toBe(true);
    expect(admit).toHaveBeenCalledOnce();
    expect(renderer.stats.scenePreflightFailures).toBe(0);
    expect((window as unknown as { __mirrorRustStats: () => { omittedCommands: number; omittedKinds: Record<string, number> } }).__mirrorRustStats())
      .toMatchObject({ omittedCommands: 2, omittedKinds: { polyline: 2 } });
    renderer.dispose();
  });

  it("joins upload, admission and present to the full tuple and clears refusal identity", async () => {
    const calls: string[] = [];
    const profile = createCouchCanvasProfile(3, "profile-run");
    let identity = "";
    let releasePresent!: () => void;
    const gate = new Promise<void>(resolve => { releasePresent = resolve; });
    let presentCount = 0;
    (globalThis as Record<string, unknown>).__rustProjectionTest = { engine: {
      backend: "WebGL2", resize: () => {}, dispose: () => {},
      set_phase_identity: (run: string, renderer: string, id: number) => {
        identity = `${run}/${renderer}/${id}`; calls.push(`identity:${identity}`);
      },
      upload_rgba_batch: () => { calls.push(`upload:${identity}`); return 1; },
      admit_scene: () => { calls.push(`admit:${identity}`); return JSON.stringify({accepted:false,error:"refused",revision:1,resourcePending:0,unsupportedCommands:0}); },
      apply_patch: () => "{}", present: async () => {
        calls.push(`present:${identity}`);
        if (++presentCount === 1) await gate;
        return JSON.stringify({presented:true,revision:1,draws:1,resourcePending:0,unsupportedCommands:0});
      },
    } };
    vi.stubEnv("VITE_RUST_PROTOTYPE_MODULE_URL", moduleUrl(
      "export default async function init(){return {}};export class RustRenderer{static async create(){return globalThis.__rustProjectionTest.engine}}",
    ));
    vi.stubEnv("VITE_RUST_SCENE_SERIALIZER_URL", moduleUrl(
      "export function encodeRustScene(){return {bytes:new Uint8Array([1]),scene:{version:2,revision:1,resources:[],commands:[]},resources:[],textUploads:[{key:'one',width:1,height:1,pixels:new Uint8Array(4)}],unsupportedCommands:0}};export function encodeRustPatch(){return null};export function encodeRustResources(){return new Uint8Array([2])}",
    ));
    const renderer = await createRustDrawListExecutor({canvas:document.createElement("canvas"),width:1,height:1,
      designWidth:1,designHeight:1,onInvalidate:() => {},profile});
    const operation = profile.begin("full-build",1,1);
    const list = createDrawList<string>();
    const quad = createQuadView(); quad.w = quad.h = quad.srcW = quad.srcH = 1; list.pushQuad(quad);
    expect(await renderer.render(list,[],operation)).toBe(false);
    expect(calls).toEqual(["identity:profile-run/3/1","upload:profile-run/3/1","admit:profile-run/3/1","identity:profile-run/3/0"]);
    expect(profile.snapshot().events.some(event => event.eventType === "outcome" && event.outcome === "refused")).toBe(true);
    const presentOnly = profile.begin("present-only",1,1);
    const firstPresent = renderer.presentScene(undefined,presentOnly);
    await vi.waitFor(() => expect(calls).toContain("present:profile-run/3/2"));
    const nextPresent = profile.begin("present-only",1,1);
    const secondPresent = renderer.presentScene(undefined,nextPresent);
    expect(calls).not.toContain("identity:profile-run/3/3");
    releasePresent();
    await Promise.all([firstPresent,secondPresent]);
    expect(calls.slice(-3)).toEqual(["identity:profile-run/3/3","present:profile-run/3/3","identity:profile-run/3/0"]);
    const waits = profile.snapshot().events.filter(event => event.operationId === 2 && event.phase === "couch.present.wait");
    expect(waits.map(event => event.edge)).toEqual(["start","end"]);
    renderer.dispose();
  });
  it("rejects a requested phase capture when WASM glue has no matching hook", async () => {
    window.history.replaceState({}, "", "/?rustExecutionPhases=1");
    (globalThis as Record<string, unknown>).__rustProjectionTest = { engine: { backend: "webgl2" } };
    vi.stubEnv("VITE_RUST_PROTOTYPE_MODULE_URL", moduleUrl(
      "export default async function init(){return {}};export class RustRenderer{static async create(){return globalThis.__rustProjectionTest.engine}}",
    ));
    vi.stubEnv("VITE_RUST_SCENE_SERIALIZER_URL", moduleUrl("export function encodeRustScene(){}"));
    await expect(createRustDrawListExecutor({ canvas: document.createElement("canvas"), width: 1, height: 1,
      designWidth: 1, designHeight: 1, onInvalidate: () => {} }))
      .rejects.toThrow("requires matching WASM glue");
  });
});

describe("Rust image byte ownership", () => {
  it.skipIf(!process.env.COUCHCOOP_GSW_ROOT)("packs only a nonzero-offset view with the real RSR1 serializer", async () => {
    const source = new Uint8Array([201, 202, 10, 20, 30, 40, 203, 204]);
    const before = [...source];
    const view = new Uint8Array(source.buffer, 2, 4);
    const modulePath = `${process.env.COUCHCOOP_GSW_ROOT}/packages/canvas/src/rust-prototype-scene.ts`;
    const { encodeRustResources } = await vi.importActual<{
      encodeRustResources(items: readonly { key: string; width: number; height: number; pixels: Uint8Array }[]): Uint8Array;
    }>(modulePath);
    const packed = encodeRustResources([{ key: "offset", width: 1, height: 1, pixels: view }]);
    const data = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
    expect([...packed.subarray(0, 4)]).toEqual([82, 83, 82, 49]); // RSR1
    expect(data.getUint32(4, true)).toBe(1);
    expect(data.getUint32(8, true)).toBe(6);
    expect(data.getUint32(12, true)).toBe(1);
    expect(data.getUint32(16, true)).toBe(1);
    expect(data.getUint32(20, true)).toBe(4);
    expect(new TextDecoder().decode(packed.subarray(24, 30))).toBe("offset");
    expect([...packed.subarray(30)]).toEqual([10, 20, 30, 40]);
    expect([...source]).toEqual(before);
    expect(packed.buffer).not.toBe(source.buffer);
  });

  it.each([[false, false], [false, true], [true, false]])(
    "keeps bitmap, canvas and tinted text bytes through an upload retry (zero copy %s, ink readback %s)",
    async (zeroCopy, inkReadFrequently) => {
    const query = new URLSearchParams({ rustDiagnostics: "1", rustTextInkDiagnostics: "1" });
    if (zeroCopy) query.set("rustZeroCopyPixels", "1");
    if (inkReadFrequently) query.set("rustTextInkReadFrequently", "1");
    if (!zeroCopy && !inkReadFrequently) query.set("rustTextInkCorpus", "1");
    window.history.replaceState({}, "", `/?${query}`);
    if (!zeroCopy && !inkReadFrequently) ensureFontFace("Test", "/font.ttf", "400", "normal");
    const previousFonts = Object.getOwnPropertyDescriptor(document, "fonts");
    let fontReady = Boolean(zeroCopy || inkReadFrequently);
    let fontSetStatus = "loading", faceStatus = fontReady ? "loaded" : "unloaded", faceWeight = "400";
    Object.defineProperty(document, "fonts", { configurable: true, value: {
      get status() { return fontSetStatus; }, ready: Promise.resolve(), check: () => fontReady,
      load: async () => [{ family: "Test", style: "normal", weight: faceWeight,
        stretch: "normal", status: faceStatus }],
      forEach: (callback: (face: unknown) => void) => callback({ family: "Test", style: "normal",
        weight: faceWeight, stretch: "normal", status: faceStatus }),
    } });
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("__benchDocumentNonce", "ink-document-1");
    const inputBuffers = new Map<string, Uint8ClampedArray>();
    let textColor = [100, 100, 100, 255];
    let measureScale = 1;
    const uploaded: Array<Array<{ key: string; bytes: number[]; buffer: ArrayBufferLike; offset: number; length: number }>> = [];
    const inkCanvases = new WeakSet<HTMLCanvasElement>();
    const contextRequests: Array<{ canvas: HTMLCanvasElement; options: unknown }> = [];
    const base = (key: string) => key === "canvas" ? [12, 34, 56, 78]
      : key === "canvas-updated" ? [22, 33, 44, 55]
      : key === "bitmap" ? [91, 82, 73, 64] : textColor;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((function (this: HTMLCanvasElement, _kind: string, options?: unknown) {
      const canvas = this;
      contextRequests.push({ canvas, options });
      let source: (CanvasImageSource & { pixelKey?: string }) | null = null;
      return {
        getContextAttributes() { return { alpha: true, willReadFrequently: Boolean((options as { willReadFrequently?: boolean } | undefined)?.willReadFrequently) }; },
        clearRect() {}, drawImage(value: CanvasImageSource) { source = value as typeof source; },
        getImageData(_x: number, _y: number, width: number, height: number) {
          const key = source?.pixelKey ?? (source instanceof HTMLCanvasElement && inkCanvases.has(source) ? "text" : "unknown");
          const length = width * height * 4;
          const data = new Uint8ClampedArray(new ArrayBuffer(length + 5), 3, length);
          const color = base(key);
          for (let index = 0; index < length; index++) data[index] = color[index % 4];
          inputBuffers.set(key, data);
          return { data };
        },
        measureText(value: string) { return { width: value.length * 8 * measureScale, actualBoundingBoxAscent: 10,
          actualBoundingBoxDescent: 3, fontBoundingBoxAscent: 10, fontBoundingBoxDescent: 3 }; },
        fillText() { inkCanvases.add(canvas); }, strokeText() {},
      } as unknown as CanvasRenderingContext2D;
    }) as never);
    vi.stubGlobal("fetch", async (url: string) => url.includes("/font.ttf")
      ? { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }
      : { ok: true, status: 200, blob: async () => new Blob(["bitmap"]) });
    let bitmapClosed = 0;
    vi.stubGlobal("createImageBitmap", async () => ({ width: 1, height: 1, pixelKey: "bitmap", close() { bitmapClosed++; } }));
    let failUpload = true;
    (globalThis as Record<string, unknown>).__rustProjectionTest = {
      engine: {
        backend: "WebGL2", resize: () => {},
        upload_rgba_batch: () => { if (failUpload) { failUpload = false; throw new Error("upload failed"); } return 0; },
        admit_scene: () => JSON.stringify({ accepted: true, revision: 1, unsupportedCommands: 0, resourcePending: 0 }),
        apply_patch: () => { throw new Error("unexpected patch"); },
        present: async () => JSON.stringify({ presented: true, revision: 1, draws: 2, resourcePending: 0, unsupportedCommands: 0 }),
        dispose: () => {},
      },
      encode: (input: { drawList: ReturnType<typeof createDrawList<string>>; revision: number;
        resolveText(record: PixiTextRecord): { resource: { key: string; width: number; height: number }; pixels: Uint8Array } | null }) => {
        const text = input.resolveText({ key: "label", insertionIndex: 2, text: "T", runs: [{ text: "T", color: "#804020" }],
          transform: [1, 0, 0, 1, 0, 0],
          resourceRevision: '1:{"family":"Test","url":"/font.ttf","weight":"400","style":"normal"}',
          style: { fontFamily: "Test", fontSize: 16, fill: "#ffffff" }, tint: 0x8040ff } as PixiTextRecord);
        const resources = ["canvas", "bitmap"].map((key) => ({ key, width: 1, height: 1 }));
        return { bytes: new Uint8Array([input.revision]), scene: { version: 2, revision: input.revision,
          width: 1, height: 1, designWidth: 1, designHeight: 1, commands: [], resources: [...resources, text!.resource] },
          resources: [...resources, text!.resource],
          textUploads: [{ ...text!.resource, pixels: text!.pixels }], unsupportedCommands: 0 };
      },
      encodeResources: (items: Array<{ key: string; pixels: Uint8Array }>) => {
        uploaded.push(items.map(({ key, pixels }) => ({ key, bytes: [...pixels], buffer: pixels.buffer,
          offset: pixels.byteOffset, length: pixels.byteLength })));
        return new Uint8Array([1]);
      },
    };
    vi.stubEnv("VITE_RUST_PROTOTYPE_MODULE_URL", moduleUrl(
      "export default async function init(){return {}};export class RustRenderer{static async create(){return globalThis.__rustProjectionTest.engine}}",
    ));
    vi.stubEnv("VITE_RUST_SCENE_SERIALIZER_URL", moduleUrl(
      "export function encodeRustScene(input){return globalThis.__rustProjectionTest.encode(input)};export function encodeRustPatch(){return null};export function encodeRustResources(items){return globalThis.__rustProjectionTest.encodeResources(items)}",
    ));
    const renderer = await createRustDrawListExecutor({ canvas: document.createElement("canvas"), width: 1, height: 1,
      designWidth: 1, designHeight: 1, startupRendererInstance: 27, onInvalidate: () => {} });
    let source: HTMLCanvasElement | null = document.createElement("canvas"); source.width = source.height = 1;
    (source as HTMLCanvasElement & { pixelKey?: string }).pixelKey = "canvas";
    renderer.bindPixelTexture("canvas", source, 1);
    source = null;
    renderer.prefetch("bitmap");
    await vi.waitFor(() => expect(renderer.textureSize("bitmap")).toEqual({ width: 1, height: 1 }));
    expect(bitmapClosed).toBe(1);
    const list = createDrawList<string>();
    const quad = createQuadView(); quad.w = quad.h = quad.srcW = quad.srcH = 1;
    list.pushQuad(quad, "canvas"); list.pushQuad(quad, "bitmap");
    const text = { key: "label", insertionIndex: 2, text: "T", runs: [{ text: "T", color: "#804020" }],
      transform: [1, 0, 0, 1, 0, 0],
      resourceRevision: '1:{"family":"Test","url":"/font.ttf","weight":"400","style":"normal"}',
      style: { fontFamily: "Test", fontSize: 16, fill: "#ffffff" }, tint: 0x8040ff } as PixiTextRecord;
    const beforeRenderMs = performance.now();
    await expect(renderer.render(list, [text])).rejects.toThrow("upload failed");
    expect(await renderer.render(list, [text])).toBe(true);
    expect(uploaded).toHaveLength(2);
    expect(uploaded[1].map(({ key }) => key)).toEqual(["canvas", "bitmap", expect.stringMatching(/^text:label:/)]);
    expect(uploaded[1][0].bytes).toEqual([12, 34, 56, 78]);
    expect(uploaded[1][1].bytes).toEqual([91, 82, 73, 64]);
    expect(uploaded[1][2].bytes.slice(0, 4)).toEqual([50, 25, 100, 255]);
    expect([...inputBuffers.get("canvas")!]).toEqual([12, 34, 56, 78]);
    expect([...inputBuffers.get("bitmap")!]).toEqual([91, 82, 73, 64]);
    expect(new Set(uploaded[1].map(({ buffer }) => buffer)).size).toBe(3);
    for (const resource of uploaded[1]) {
      const input = inputBuffers.get(resource.key.startsWith("text:") ? "text" : resource.key)!;
      expect(resource.length).toBe(input.byteLength);
      expect(resource.offset).toBe(zeroCopy ? 3 : 0);
      expect(resource.buffer === input.buffer).toBe(zeroCopy);
    }
    const replacement = document.createElement("canvas"); replacement.width = replacement.height = 1;
    (replacement as HTMLCanvasElement & { pixelKey?: string }).pixelKey = "canvas-updated";
    renderer.bindPixelTexture("canvas", replacement, 1);
    expect(await renderer.render(list, [text])).toBe(true);
    expect(uploaded).toHaveLength(2);
    renderer.bindPixelTexture("canvas", replacement, 2);
    expect(await renderer.render(list, [text])).toBe(true);
    expect(uploaded[2].map(({ key, bytes }) => ({ key, bytes }))).toEqual([{ key: "canvas", bytes: [22, 33, 44, 55] }]);
    const inkRequests = contextRequests.filter(({ canvas }) => inkCanvases.has(canvas));
    expect(inkRequests).toHaveLength(1);
    expect(inkRequests[0].options).toEqual(inkReadFrequently ? { willReadFrequently: true } : undefined);
    const stats = (window as unknown as { __mirrorRustStats(): {
      zeroCopyPixels: boolean; textInkReadFrequently: boolean;
      textInkLastMissSubmission: { revision: number; cacheMisses: number; rasterCount: number;
        rasterBytes: number; readbackMs: number; rasters: Array<{
        width: number; height: number; rgbaBytes: number; readbackMs: number; failed: boolean }> };
      textInkDiagnosticEventLimit: number; textInkDiagnosticOverflow: boolean;
      textInkTimeOrigin: number; textInkDocumentNonce: string; textInkRendererInstance: number;
      textInkDiagnosticEvents: Array<{ recordKey: string; resourceKey: string; submissionRevision: number;
        sceneRevision: number; startMs: number; endMs: number; width: number; height: number; rgbaBytes: number; outcome: string;
        requestedInkWillReadFrequently: boolean; requestedScratchWillReadFrequently: boolean;
        inkContextAttributes: { willReadFrequently: boolean }; scratchContextAttributes: { willReadFrequently: boolean };
        inkDrawMs: number; scratchConversionMs: number; scratchDrawMs: number;
        getImageDataMs: number; pixelViewMs: number }>;
    } }).__mirrorRustStats();
    expect(stats.zeroCopyPixels).toBe(zeroCopy);
    expect(stats.textInkReadFrequently).toBe(inkReadFrequently);
    expect(stats.textInkLastMissSubmission.revision).toBe(1);
    expect(stats.textInkLastMissSubmission.cacheMisses).toBe(1);
    expect(stats.textInkLastMissSubmission.rasterCount).toBe(1);
    expect(stats.textInkLastMissSubmission.rasters).toHaveLength(1);
    const raster = stats.textInkLastMissSubmission.rasters[0];
    expect(raster.width).toBeGreaterThan(0);
    expect(raster.height).toBeGreaterThan(0);
    expect(raster.rgbaBytes).toBe(raster.width * raster.height * 4);
    expect(raster.readbackMs).toBeGreaterThanOrEqual(0);
    expect(raster.failed).toBe(false);
    expect(stats.textInkLastMissSubmission.rasterBytes).toBe(raster.rgbaBytes);
    expect(stats.textInkLastMissSubmission.readbackMs).toBe(raster.readbackMs);
    expect(stats.textInkDiagnosticOverflow).toBe(false);
    expect(stats.textInkTimeOrigin).toBe(performance.timeOrigin);
    expect(stats.textInkDocumentNonce).toBe("ink-document-1");
    expect(stats.textInkRendererInstance).toBe(27);
    expect(stats.textInkDiagnosticEventLimit).toBeGreaterThan(0);
    expect(stats.textInkDiagnosticEvents).toHaveLength(1);
    const event = stats.textInkDiagnosticEvents[0];
    expect(event.recordKey).toBe("label");
    expect(event.resourceKey).toBe(uploaded[1][2].key);
    expect(event.submissionRevision).toBe(1);
    expect(event.sceneRevision).toBe(1);
    expect(event.startMs).toBeGreaterThanOrEqual(beforeRenderMs);
    expect(event.endMs).toBeGreaterThanOrEqual(event.startMs);
    expect(event.endMs).toBeLessThanOrEqual(performance.now());
    expect({ width: event.width, height: event.height, rgbaBytes: event.rgbaBytes })
      .toEqual({ width: raster.width, height: raster.height, rgbaBytes: raster.rgbaBytes });
    expect(event.outcome).toBe("ready");
    expect(event.requestedInkWillReadFrequently).toBe(inkReadFrequently);
    expect(event.inkContextAttributes.willReadFrequently).toBe(inkReadFrequently);
    expect(event.requestedScratchWillReadFrequently).toBe(true);
    expect(event.scratchContextAttributes.willReadFrequently).toBe(true);
    for (const ms of [event.inkDrawMs, event.scratchConversionMs, event.scratchDrawMs,
      event.getImageDataMs, event.pixelViewMs]) expect(ms).toBeGreaterThanOrEqual(0);
    if (!zeroCopy && !inkReadFrequently) {
      const rasterizationsBeforeReplay = renderer.stats.textRasterizations;
      const corpusHook = (window as unknown as { __mirrorRustTextCorpus: {
        prepareFonts(corpus?: unknown): Promise<{ accepted: boolean; unresolved: number[] }>;
        snapshot(): Promise<{ id: string; count: number; preparedRows: Array<{ rgbaSha256: string; rgbaBytes: number }>;
          preparedFontManifest: { assets: Array<{ sha256: string }> };
          productionCssBeforePreparation: unknown; rows: Array<{ input: { record: PixiTextRecord;
          fontAsset: { url: string }; fontSetStatus: string; fontReady: boolean }; measurements: { runAdvances: number[] };
          diagnostic: { requestedInkWillReadFrequently: boolean }; rgbaSha256: string; rgbaBytes: number }> }>;
        replay(corpus: unknown, ink: boolean): Promise<{ sourceId: string; rows: Array<{ rgbaSha256: string;
          diagnostic: { requestedInkWillReadFrequently: boolean } }> }>;
        replayPhone(corpus: unknown, ink: boolean): Promise<{ schema: string; sourceId: string; id: string;
          count: number; zeroCopyPixels: boolean; rows: Array<{ inputSha256: string; rgbaSha256: string;
          observedFont: { matchingFaces: Array<{ status: string }> } }> }>;
        chunk(kind: string, id: string, index: number, offset: number, length: number): { base64: string };
        lastFontMismatch(): { rowIndex: number; recordKey: string; expected: { fontReady: boolean;
          matchingFaces: Array<{ family: string }> }; actual: { fontReady: boolean;
          matchingFaces: Array<{ family: string }> }; checks: { ready: boolean } } | null;
      } }).__mirrorRustTextCorpus;
      fontReady = true; faceStatus = "loaded";
      textColor = [101, 100, 101, 255];
      const preparation = await corpusHook.prepareFonts();
      expect(preparation).toMatchObject({ accepted: true, unresolved: [] });
      const corpus = await corpusHook.snapshot();
      expect(corpus.count).toBe(1);
      expect(corpus.rows[0].input.fontReady).toBe(false);
      expect(corpus.preparedRows).toHaveLength(1);
      expect(corpus.preparedFontManifest.assets).toHaveLength(1);
      expect(corpus.rows[0].input.fontSetStatus).toBe("loading");
      expect(corpus.rows[0].input.record.runs).toEqual([{ text: "T", color: "#804020" }]);
      expect(corpus.rows[0].input.fontAsset.url).toBe("/font.ttf");
      expect(corpus.rows[0].measurements.runAdvances).toEqual([8]);
      expect(corpus.rows[0].diagnostic.requestedInkWillReadFrequently).toBe(false);
      const encoded = corpusHook.chunk("capture", corpus.id, 0, 0, corpus.rows[0].rgbaBytes);
      expect([...Uint8Array.from(atob(encoded.base64), (character) => character.charCodeAt(0))].slice(0, 4))
        .toEqual([50, 25, 100, 255]);
      const preparedBytes = corpusHook.chunk("prepared", corpus.id, 0, 0, corpus.preparedRows[0].rgbaBytes);
      expect(preparedBytes.base64).not.toBe(encoded.base64);
      expect(corpusHook.chunk("capture", "wrong-id", 0, 0, 4)).toBeNull();
      await expect(corpusHook.replay({ ...corpus, id: "wrong-id" }, false))
        .rejects.toThrow("identity mismatch");
      fontSetStatus = "loaded";
      await expect(corpusHook.replay(corpus, false)).resolves.toMatchObject({ sourceId: corpus.id });
      fontReady = false;
      await expect(corpusHook.replay(corpus, false)).rejects.toThrow(/"fontReady":false/);
      expect(corpusHook.lastFontMismatch()).toEqual(expect.objectContaining({
        rowIndex: 0, recordKey: "label", checks: expect.objectContaining({ ready: false }),
        expected: expect.objectContaining({ fontReady: true,
          matchingFaces: [expect.objectContaining({ family: "Test" })] }),
        actual: expect.objectContaining({ fontReady: false,
          matchingFaces: [expect.objectContaining({ family: "Test" })] }),
      }));
      fontReady = true;
      const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.keys(value).sort()
            .map((key) => [key, stable((value as Record<string, unknown>)[key])])) : value;
      const digest = async (value: unknown) => [...new Uint8Array(await webcrypto.subtle.digest("SHA-256",
        new TextEncoder().encode(JSON.stringify(stable(value)))))]
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const resign = async (mutate: (changed: Record<string, unknown>) => void, inputChanged = false) => {
        const changed = JSON.parse(JSON.stringify(corpus)) as { id: string; rows: Array<{
          input: Record<string, unknown>; inputSha256: string }>;
          preparedRows: unknown; preparedFontManifest: unknown; productionCssBeforePreparation: unknown };
        mutate(changed as unknown as Record<string, unknown>);
        if (inputChanged) changed.rows[0].inputSha256 = await digest(changed.rows[0].input);
        changed.id = await digest({ rows: changed.rows, preparedRows: changed.preparedRows,
          preparedFontManifest: changed.preparedFontManifest,
          productionCssBeforePreparation: changed.productionCssBeforePreparation });
        return changed;
      };
      const changedAsset = await resign((changed) => {
        const input = (changed.rows as Array<{ input: Record<string, unknown> }>)[0].input;
        (input.fontAsset as Record<string, unknown>).url = "/other-font.ttf";
      }, true);
      await expect(corpusHook.replay(changedAsset, false)).rejects.toThrow("prepared input changed");
      const changedDescriptor = await resign((changed) => {
        (changed.rows as Array<{ input: Record<string, unknown> }>)[0].input.font = "italic 16px Test";
      }, true);
      await expect(corpusHook.replay(changedDescriptor, false)).rejects.toThrow("prepared input changed");
      const wrongBytes = await resign((changed) => {
        const manifest = changed.preparedFontManifest as { assets: Array<{ sha256: string }> };
        manifest.assets[0].sha256 = "0".repeat(64);
      });
      expect(await corpusHook.prepareFonts(wrongBytes)).toMatchObject({ accepted: false, unresolved: [0] });
      await expect(corpusHook.replayPhone(wrongBytes, false)).rejects.toThrow("imported fonts have not been prepared");
      await expect(corpusHook.prepareFonts({ ...corpus, schema: "rust-text-corpus/1" }))
        .rejects.toThrow("identity mismatch");
      const malformed = JSON.parse(JSON.stringify(corpus));
      malformed.rows[0].input.record.text = "changed";
      await expect(corpusHook.prepareFonts(malformed)).rejects.toThrow("identity mismatch");
      const missingAssociation = await resign((changed) => {
        const manifest = changed.preparedFontManifest as { assets: Array<{ registered: { cssRule: string } }> };
        manifest.assets[0].registered.cssRule = "@font-face{}";
      });
      expect(await corpusHook.prepareFonts(missingAssociation)).toMatchObject({ accepted: false, unresolved: [0] });
      faceStatus = "unloaded";
      expect(await corpusHook.prepareFonts(corpus)).toMatchObject({ accepted: false, unresolved: [0] });
      faceStatus = "loaded";
      expect(await corpusHook.prepareFonts(corpus)).toMatchObject({ accepted: true, unresolved: [] });
      fontReady = false;
      await expect(corpusHook.replayPhone(corpus, false)).rejects.toThrow("font unavailable");
      fontReady = true;
      textColor = [101, 100, 102, 255];
      const phoneOff = await corpusHook.replayPhone(corpus, false);
      const phoneOn = await corpusHook.replayPhone(corpus, true);
      expect(phoneOff).toMatchObject({ schema: "rust-text-corpus-phone-replay/1",
        sourceId: corpus.id, count: 1, zeroCopyPixels: false });
      expect(phoneOff.rows[0].rgbaSha256).not.toBe(corpus.preparedRows[0].rgbaSha256);
      expect(phoneOn.rows[0].rgbaSha256).toBe(phoneOff.rows[0].rgbaSha256);
      expect(phoneOff.rows[0].inputSha256).toBe(phoneOn.rows[0].inputSha256);
      expect(phoneOff.rows[0].observedFont.matchingFaces).toEqual([
        expect.objectContaining({ status: "loaded" }),
      ]);
      expect(corpusHook.chunk("phone-off", phoneOff.id, 0, 0, 4).base64)
        .toBe(corpusHook.chunk("phone-on", phoneOn.id, 0, 0, 4).base64);
      expect(corpusHook.chunk("phone-off", phoneOn.id, 0, 0, 4)).toBeNull();
      textColor = [101, 100, 101, 255];
      faceStatus = "unloaded";
      await expect(corpusHook.replayPhone(corpus, false)).rejects.toThrow("font unavailable");
      await expect(corpusHook.replay(corpus, false)).rejects.toThrow("font unavailable");
      faceStatus = "loaded";
      faceWeight = "700";
      await expect(corpusHook.replayPhone(corpus, false)).rejects.toThrow("font unavailable");
      await expect(corpusHook.replay(corpus, false)).rejects.toThrow("font unavailable");
      faceWeight = "400";
      measureScale = 2;
      await expect(corpusHook.replay(corpus, false)).rejects.toThrow("font metrics changed");
      measureScale = 1;
      textColor = [101, 100, 102, 255];
      await expect(corpusHook.replay(corpus, false)).rejects.toThrow("pixels changed");
      textColor = [101, 100, 101, 255];
      const replay = await corpusHook.replay(corpus, true);
      expect(replay.sourceId).toBe(corpus.id);
      expect(corpusHook.lastFontMismatch()).toBeNull();
      expect(replay.rows[0].rgbaSha256).toBe(corpus.preparedRows[0].rgbaSha256);
      expect(replay.rows[0].diagnostic.requestedInkWillReadFrequently).toBe(true);
      expect(renderer.stats.textRasterizations).toBe(rasterizationsBeforeReplay);
    }
    renderer.dispose();
    if (previousFonts) Object.defineProperty(document, "fonts", previousFonts);
    else delete (document as { fonts?: FontFaceSet }).fonts;
  });
});

describe("Rust scene viewport", () => {
  it("uses the widened design size after resize while retaining physical backing size", async () => {
    const resourceEvents: Array<{ name: string; detail: Record<string, unknown> }> = [];
    vi.stubGlobal("__benchDocumentNonce", "document-1");
    vi.stubGlobal("__benchStartupResourceEvent", (name: string, detail: Record<string, unknown>) =>
      resourceEvents.push({ name, detail }));
    const admitted: Array<{ width: number; height: number; designWidth: number; designHeight: number }> = [];
    const resized: Array<[number, number]> = [];
    let presentStarted = false;
    let releasePresent!: () => void;
    const presentGate = new Promise<void>((resolve) => { releasePresent = resolve; });
    (globalThis as Record<string, unknown>).__rustProjectionTest = {
      engine: {
        backend: "WebGL2",
        resize: (width: number, height: number) => resized.push([width, height]),
        upload_rgba_batch: () => 0,
        admit_scene: (bytes: Uint8Array) => {
          admitted.push(JSON.parse(new TextDecoder().decode(bytes)));
          return JSON.stringify({ accepted: true, revision: admitted.length, unsupportedCommands: 0, resourcePending: 0 });
        },
        apply_patch: () => { throw new Error("unexpected patch"); },
        present: async () => {
          if (!presentStarted) { presentStarted = true; await presentGate; }
          return JSON.stringify({ presented: true, revision: admitted.length, draws: 1, resourcePending: 0, unsupportedCommands: 0 });
        },
        dispose: () => {},
      },
      encode: (input: { width: number; height: number; designWidth: number; designHeight: number }) => ({
        bytes: new TextEncoder().encode(JSON.stringify({ width: input.width, height: input.height,
          designWidth: input.designWidth, designHeight: input.designHeight, resources: [] })),
        resources: [], textUploads: [], unsupportedCommands: 0,
      }),
    };
    vi.stubEnv("VITE_RUST_PROTOTYPE_MODULE_URL", moduleUrl(
      "export default async function init(){return {}};export class RustRenderer{static async create(){return globalThis.__rustProjectionTest.engine}}",
    ));
    vi.stubEnv("VITE_RUST_SCENE_SERIALIZER_URL", moduleUrl(
      "export function encodeRustScene(input){return globalThis.__rustProjectionTest.encode(input)};export function encodeRustPatch(){return null};export function encodeRustResources(){return new Uint8Array(0)}",
    ));
    const canvas = document.createElement("canvas");
    const renderer = await createRustDrawListExecutor({ canvas, width: 1748, height: 983,
      designWidth: 1920, designHeight: 1080, startupRendererInstance: 99, onInvalidate: () => {} });
    const list = createDrawList<string>();
    const quad = createQuadView(); quad.w = quad.h = quad.srcW = quad.srcH = 10;
    list.pushQuad(quad);
    const firstPresent = renderer.render(list);
    await vi.waitFor(() => expect(presentStarted).toBe(true));
    renderer.resize(2294, 983, 1, 2520, 1080);
    const resizedPresent = renderer.render(list);
    expect(resized).toEqual([]);
    releasePresent();
    expect(await firstPresent).toMatchObject({ presented: true, revision: 1, completedFrames: 1 });
    expect(await resizedPresent).toMatchObject({ presented: true, revision: 2, completedFrames: 2 });
    expect(resourceEvents.filter((event) => event.name === "present").map((event) => event.detail))
      .toMatchObject([
        { documentNonce: "document-1", rendererInstance: 99, backendRevision: 1, completedFrames: 1 },
        { documentNonce: "document-1", rendererInstance: 99, backendRevision: 2, completedFrames: 2 },
      ]);
    expect(admitted).toEqual([
      { width: 1748, height: 983, designWidth: 1920, designHeight: 1080, resources: [] },
      { width: 2294, height: 983, designWidth: 2520, designHeight: 1080, resources: [] },
    ]);
    expect(resized).toEqual([[2294, 983]]);
    renderer.dispose();
  });

  it("uses typed scene patches, defers full JSON on patch frames, and exposes rollback counters", async () => {
    window.history.replaceState({}, "", "/?rustDiagnostics=1");
    const patches: Array<[unknown, unknown]> = [];
    let presents = 0, acceptedRevision = 0, fullSceneEncodes = 0;
    const scene = (input: { width: number; height: number; designWidth: number; designHeight: number; revision: number }) => ({
      version: 2 as const, revision: input.revision, width: input.width, height: input.height,
      designWidth: input.designWidth, designHeight: input.designHeight, resources: [], commands: [],
    });
    (globalThis as Record<string, unknown>).__rustProjectionTest = {
      engine: {
        backend: "WebGL2", resize: () => {}, upload_rgba_batch: () => 0,
        admit_scene: (bytes: Uint8Array) => {
          acceptedRevision = JSON.parse(new TextDecoder().decode(bytes)).revision;
          return JSON.stringify({ accepted: true, revision: acceptedRevision, unsupportedCommands: 0, resourcePending: 0 });
        },
        apply_patch: (bytes: Uint8Array) => {
          try {
            const patch = JSON.parse(new TextDecoder().decode(bytes));
            if (patch.version === 1) {
              if (patch.baseRevision !== acceptedRevision) return JSON.stringify({ accepted: false, error: "stale base revision" });
              acceptedRevision = patch.revision;
            }
          } catch { acceptedRevision++; }
          return JSON.stringify({ accepted: true, revision: acceptedRevision, unsupportedCommands: 0, resourcePending: 0 });
        },
        present: async () => {
          presents++;
          return JSON.stringify({ presented: true, revision: acceptedRevision, draws: 1, resourcePending: 0, unsupportedCommands: 0,
            drawCalls: presents * 7, bufferCreations: 2, textureCreations: 3, uploadBytes: 99,
            completedPresents: presents, wasmCalls: presents * 4, instanceUploadBytes: presents * 64,
            incrementalPatches: presents - 1, geometryRebuilds: 1, maxSampledTextures: 16 });
        },
        dispose: () => {},
      },
      encode: (input: { width: number; height: number; designWidth: number; designHeight: number }) => {
        const typed = scene({ ...input, revision: presents + 1 });
        return { get bytes() { fullSceneEncodes++; return new TextEncoder().encode(JSON.stringify(typed)); },
          scene: typed, resources: typed.resources, textUploads: [], unsupportedCommands: 0 };
      },
      patch: (previous: unknown, next: unknown) => { patches.push([previous, next]); return new Uint8Array([1]); },
    };
    vi.stubEnv("VITE_RUST_PROTOTYPE_MODULE_URL", moduleUrl(
      "export default async function init(){return {}};export class RustRenderer{static async create(){return globalThis.__rustProjectionTest.engine}}",
    ));
    vi.stubEnv("VITE_RUST_SCENE_SERIALIZER_URL", moduleUrl(
      "export function encodeRustScene(input){return globalThis.__rustProjectionTest.encode(input)};export function encodeRustPatch(a,b){return globalThis.__rustProjectionTest.patch(a,b)};export function encodeRustResources(){return new Uint8Array(0)}",
    ));
    const renderer = await createRustDrawListExecutor({ canvas: document.createElement("canvas"), width: 100, height: 100,
      designWidth: 100, designHeight: 100, onInvalidate: () => {} });
    const list = createDrawList<string>();
    const quad = createQuadView(); quad.w = quad.h = quad.srcW = quad.srcH = 10; list.pushQuad(quad);
    const firstEvents: ProducerExecutorEvent[] = [], secondEvents: ProducerExecutorEvent[] = [];
    expect(await renderer.admitScene(list, [], {} as PixiScenePlan, (event) => firstEvents.push(event))).toMatchObject({ presented: true });
    expect(await renderer.admitScene(list, [], {} as PixiScenePlan, (event) => secondEvents.push(event))).toMatchObject({ presented: true });
    expect(firstEvents.map((event) => [event.stage, event.operationId, event.mode])).toEqual([
      ["encoded", 1, "full-scene"], ["api-attempt", 1, "full-scene"],
      ["api-accepted", 1, "full-scene"], ["presented", 1, "full-scene"],
    ]);
    expect(secondEvents.map((event) => [event.stage, event.operationId, event.mode])).toEqual([
      ["encoded", 2, "full-scene"], ["api-attempt", 2, "scene-patch"],
      ["api-accepted", 2, "scene-patch"], ["presented", 2, "scene-patch"],
    ]);
    expect(fullSceneEncodes).toBe(1);
    expect(patches).toHaveLength(1);
    expect((patches[0][0] as { version: number }).version).toBe(2);
    expect((patches[0][1] as { version: number }).version).toBe(2);
    const stats = (window as unknown as { __mirrorRustStats(): Record<string, unknown> }).__mirrorRustStats();
    expect(stats).toMatchObject({ rustDrawCalls: 14, rustAllocations: 5, rustUploadBytes: 99,
      rustCompletedPresents: 2, rustWasmCalls: 8, rustInstanceUploadBytes: 128,
      rustIncrementalPatches: 1, rustGeometryRebuilds: 1, rustMaxSampledTextures: 16 });
    expect(await (window as unknown as { __mirrorRustRollbackProbe(): Promise<unknown> }).__mirrorRustRollbackProbe()).toMatchObject({
      available: true, refused: true, resumedPresented: true, expectedRevision: 2, observedRevision: 2, committedRevision: 2,
    });
    renderer.dispose();
  });

  it("stages a direct retained update until its presentation succeeds", async () => {
    window.history.replaceState({}, "", "/?rustDiagnostics=1&rustPhaseTiming=1&rustExecutionPhases=1");
    let acceptedRevision = 0, pendingRevision: number | null = null, presentCount = 0;
    const phaseIds: number[] = [], retainedEvents: ProducerExecutorEvent[] = [];
    let failNextPresentation = false, rejectNextPatch = false, releasePatchPresent!: () => void;
    const patchPresentGate = new Promise<void>((resolve) => { releasePatchPresent = resolve; });
    const retainedInputs: unknown[] = [];
    const makeScene = (input: { width: number; height: number; designWidth: number; designHeight: number; revision: number }) => ({
      version: 2 as const, revision: input.revision, width: input.width, height: input.height,
      designWidth: input.designWidth, designHeight: input.designHeight, resources: [],
      commands: [{ id: "c0", kind: "quad", resource: null, m: [1, 0, 0, 1, 0, 0], w: 10, h: 10,
        src: [0, 0, 10, 10], color: [1, 1, 1, 1], blend: "mix", flipH: false, flipV: false, colorMatrix: null },
      { id: "tlabel", kind: "rasterText", resource: "text:label", m: [1, 0, 0, 1, 9, 9], w: 10, h: 10,
        src: [0, 0, 10, 10], color: [1, 1, 1, 1], blend: "mix", flipH: false, flipV: false, colorMatrix: null }],
    });
    (globalThis as Record<string, unknown>).__rustProjectionTest = {
      engine: {
        backend: "WebGL2", resize: () => {}, upload_rgba_batch: () => 0,
        set_phase_operation_id: (id: number) => { phaseIds.push(id); },
        admit_scene: (bytes: Uint8Array) => {
          const scene = JSON.parse(new TextDecoder().decode(bytes)); acceptedRevision = scene.revision;
          return JSON.stringify({ accepted: true, revision: acceptedRevision, unsupportedCommands: 0, resourcePending: 0 });
        },
        apply_patch: (bytes: Uint8Array) => {
          const patch = JSON.parse(new TextDecoder().decode(bytes));
          if (patch.baseRevision !== acceptedRevision) return JSON.stringify({ accepted: false, error: "stale base revision" });
          if (rejectNextPatch) { rejectNextPatch = false; return JSON.stringify({ accepted: false, revision: acceptedRevision, error: "preflight rejected" }); }
          pendingRevision = patch.revision;
          return JSON.stringify({ accepted: true, revision: pendingRevision, unsupportedCommands: 0, resourcePending: 0 });
        },
        present: async () => {
          presentCount++;
          if (presentCount === 2) await patchPresentGate;
          if (pendingRevision !== null) {
            if (failNextPresentation) { failNextPresentation = false; pendingRevision = null;
              return JSON.stringify({ presented: false, revision: acceptedRevision, error: "GPU validation failed", resourcePending: 0, unsupportedCommands: 0 }); }
            acceptedRevision = pendingRevision; pendingRevision = null;
          }
          return JSON.stringify({ presented: true, revision: acceptedRevision, draws: 1, resourcePending: 0, unsupportedCommands: 0 });
        },
        dispose: () => {},
      },
      encode: (input: { width: number; height: number; designWidth: number; designHeight: number }) => {
        const scene = makeScene({ ...input, revision: presentCount + 1 });
        return { get bytes() { return new TextEncoder().encode(JSON.stringify(scene)); }, scene,
          resources: [], textUploads: [], unsupportedCommands: 0 };
      },
      patch: () => null,
      retained: (base: ReturnType<typeof makeScene>, revision: number, updates: Array<{ id: string; command: Record<string, unknown>; localTransform?: readonly number[] }>, groups: unknown[]) => {
        retainedInputs.push({ baseRevision: base.revision, revision, updates, groups });
        const commands = base.commands.slice();
        const changedIndexes: number[] = [];
        for (const update of updates) {
          const index = commands.findIndex((command) => command.id === update.id);
          if (index < 0) return null;
          commands[index] = update.command as typeof commands[number];
          changedIndexes.push(index);
        }
        const scene = { ...base, revision, commands };
        return { bytes: new TextEncoder().encode(JSON.stringify({ version: 1, baseRevision: base.revision, revision,
          updates: updates.map(({ id, command }) => ({ id, command })) })), scene, changedIndexes };
      },
    };
    vi.stubEnv("VITE_RUST_PROTOTYPE_MODULE_URL", moduleUrl(
      "export default async function init(){return {}};export class RustRenderer{static async create(){return globalThis.__rustProjectionTest.engine}}",
    ));
    vi.stubEnv("VITE_RUST_SCENE_SERIALIZER_URL", moduleUrl(
      "export function encodeRustScene(input){return globalThis.__rustProjectionTest.encode(input)};export function encodeRustPatch(a,b){return globalThis.__rustProjectionTest.patch(a,b)};export function encodeRustRetainedPatch(a,b,c,d){return globalThis.__rustProjectionTest.retained(a,b,c,d)};export function encodeRustResources(){return new Uint8Array(0)}",
    ));
    const renderer = await createRustDrawListExecutor({ canvas: document.createElement("canvas"), width: 100, height: 100,
      designWidth: 100, designHeight: 100, onInvalidate: () => {} });
    const list = createDrawList<string>();
    const quad = createQuadView(); quad.w = quad.h = quad.srcW = quad.srcH = 10; list.pushQuad(quad);
    expect(await renderer.render(list)).toBe(true);
    const patchResult = renderer.patchScene({ primitives: [
      { id: "c0", transform: [1, 0, 0, 1, 7, 0] },
      { id: "text:label", transform: [1, 0, 0, 1, 18, 19] },
    ] }, (event) => retainedEvents.push(event));
    await vi.waitFor(() => expect(presentCount).toBe(2));
    const stats = (window as unknown as { __mirrorRustStats(): Record<string, unknown> }).__mirrorRustStats();
    expect(stats.committedRevision).toBe(1);
    expect(typeof stats.retainedPatchApplyMs).toBe("number");
    expect(typeof stats.sceneEncodeMs).toBe("number");
    expect(typeof stats.sceneDiffMs).toBe("number");
    releasePatchPresent();
    expect(await patchResult).toMatchObject({ presented: true, revision: 2 });
    expect(retainedEvents.map((event) => [event.stage, event.operationId, event.mode])).toEqual([
      ["encoded", 2, "scene-patch"], ["api-attempt", 2, "scene-patch"],
      ["api-accepted", 2, "scene-patch"], ["present-call", 2, "scene-patch"],
      ["presented", 2, "scene-patch"],
    ]);
    const presentOnlyEvents: ProducerExecutorEvent[] = [];
    expect(await renderer.presentScene((event) => presentOnlyEvents.push(event))).toMatchObject({ presented: true });
    expect(presentOnlyEvents.map((event) => [event.stage, event.operationId, event.mode])).toEqual([
      ["api-accepted", 0x80000000, "present-only"],
      ["present-call", 0x80000000, "present-only"],
      ["presented", 0x80000000, "present-only"],
    ]);
    expect(phaseIds).toEqual([1, 2, 0x80000000]);
    expect((window as unknown as { __mirrorRustStats(): Record<string, unknown> }).__mirrorRustStats().committedRevision).toBe(2);
    expect(retainedInputs).toHaveLength(1);
    expect(retainedInputs[0]).toMatchObject({ baseRevision: 1, revision: 2,
      updates: [
        { id: "c0", command: { m: [1, 0, 0, 1, 7, 0] } },
        { id: "tlabel", command: { m: [1, 0, 0, 1, 9, 9] }, localTransform: [1, 0, 0, 1, 18, 19] },
      ], groups: [] });
    failNextPresentation = true;
    expect(await renderer.patchScene({ primitives: [{ id: "c0", transform: [1, 0, 0, 1, 8, 0] }] })).toMatchObject({ presented: false });
    expect((window as unknown as { __mirrorRustStats(): Record<string, unknown> }).__mirrorRustStats().committedRevision).toBe(2);
    expect(await renderer.patchScene({ primitives: [{ id: "c0", transform: [1, 0, 0, 1, 9, 0] }] })).toMatchObject({ presented: true, revision: 4 });
    expect(retainedInputs.slice(1)).toMatchObject([
      { baseRevision: 2, revision: 3 }, { baseRevision: 2, revision: 4 },
    ]);
    rejectNextPatch = true;
    expect(await renderer.patchScene({ primitives: [{ id: "c0", transform: [1, 0, 0, 1, 10, 0] }] })).toMatchObject({ presented: false });
    expect((window as unknown as { __mirrorRustStats(): Record<string, unknown> }).__mirrorRustStats().committedRevision).toBe(4);
    expect(new Set(phaseIds).size).toBe(phaseIds.length);
    const encodedBeforeResizeFallback = retainedInputs.length;
    renderer.resize(200, 100, 1, 200, 100);
    expect(await renderer.patchScene({ primitives: [{ id: "c0", transform: [1, 0, 0, 1, 11, 0] }] }))
      .toMatchObject({ presented: false, reason: "retained patch requires full scene admission" });
    expect(retainedInputs).toHaveLength(encodedBeforeResizeFallback);
    expect((window as unknown as { __mirrorRustStats(): Record<string, unknown> }).__mirrorRustStats().committedRevision).toBe(4);
    renderer.dispose();
  });
});

// rustFast WP3 — the executor-side half: a style-string WeakMap cache, a prefetch-skip for a repeated texture, the
// GSW serializer's `fast` options + cached command index (feature-detected), and the wasm dedupe toggle.
describe("rustFast WP3 executor switches", () => {
  function mockInkContext(): void {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((function (this: HTMLCanvasElement) {
      return {
        getContextAttributes() { return { alpha: true }; },
        clearRect() {}, drawImage() {},
        getImageData(_x: number, _y: number, width: number, height: number) {
          return { data: new Uint8ClampedArray(Math.max(1, width) * Math.max(1, height) * 4) };
        },
        measureText(value: string) {
          return { width: value.length * 8, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3,
            fontBoundingBoxAscent: 10, fontBoundingBoxDescent: 3 };
        },
        fillText() {}, strokeText() {},
      } as unknown as CanvasRenderingContext2D;
    }) as never);
  }

  function stubEngineAndSerializer(serializerSource: string): void {
    vi.stubEnv("VITE_RUST_PROTOTYPE_MODULE_URL", moduleUrl(
      "export default async function init(){return {}};export class RustRenderer{static async create(){return globalThis.__rustProjectionTest.engine}}",
    ));
    vi.stubEnv("VITE_RUST_SCENE_SERIALIZER_URL", moduleUrl(serializerSource));
  }

  // rustOffsetPatch: a clip translation reaches the Rust wire as a `clipPush` replacement, through the real serializer.
  it("encodes a clip translation as a clipPush replacement and advertises it only when the serializer can", async () => {
    let acceptedRevision = 0;
    const patches: unknown[] = [];
    (globalThis as Record<string, unknown>).__rustProjectionTest = {
      engine: { backend: "WebGL2", resize: () => {}, dispose: () => {}, upload_rgba_batch: () => 0,
        admit_scene: (bytes: Uint8Array) => { acceptedRevision = JSON.parse(new TextDecoder().decode(bytes)).revision;
          return JSON.stringify({ accepted: true, revision: acceptedRevision, unsupportedCommands: 0, resourcePending: 0 }); },
        apply_patch: (bytes: Uint8Array) => { const patch = JSON.parse(new TextDecoder().decode(bytes)); patches.push(patch);
          acceptedRevision = patch.revision;
          return JSON.stringify({ accepted: true, revision: acceptedRevision, unsupportedCommands: 0, resourcePending: 0 }); },
        present: async () => JSON.stringify({ presented: true, revision: acceptedRevision, draws: 1, resourcePending: 0, unsupportedCommands: 0 }) },
    };
    vi.stubEnv("VITE_RUST_PROTOTYPE_MODULE_URL", moduleUrl(
      "export default async function init(){return {}};export class RustRenderer{static async create(){return globalThis.__rustProjectionTest.engine}}",
    ));
    const renderer = await createRustDrawListExecutor({ canvas: document.createElement("canvas"), width: 40, height: 40,
      designWidth: 40, designHeight: 40, onInvalidate: () => {} });
    expect(renderer.translatesClips).toBe(true);
    const list = createDrawList<string>();
    const clip = createClipRectView(); clip.x = 2; clip.y = 3; clip.w = 10; clip.h = 12; clip.cornerRadius = 1;
    list.pushClipRect(clip);
    const quad = createQuadView(); quad.w = quad.h = 4; list.pushQuad(quad);
    list.popClip();
    expect(await renderer.admitScene(list, [], { primitives: [{ id: "q", index: 1 }], groups: [] })).toMatchObject({ presented: true });
    expect(await renderer.patchScene({ primitives: [{ id: "q", transform: [1, 0, 0, 1, 5, -2] }],
      clips: [{ id: "clipper", index: 0, dx: 5, dy: -2, totalDx: 5, totalDy: -2 }] })).toMatchObject({ presented: true });
    const [patch] = patches as Array<{ updates: Array<{ id: string; command: Record<string, unknown> }> }>;
    expect(patch.updates.find((update) => update.id === "c0")!.command)
      .toEqual({ id: "c0", kind: "clipPush", rect: [7, 1, 10, 12], radius: 1, outset: 0 });
    // A second move places the clip at the admitted rect plus its total translation (never a running sum).
    expect(await renderer.patchScene({ primitives: [], clips: [{ id: "clipper", index: 0, dx: 1, dy: 1, totalDx: 6, totalDy: -1 }] }))
      .toMatchObject({ presented: true });
    expect((patches[1] as typeof patch).updates).toEqual([{ id: "c0",
      command: { id: "c0", kind: "clipPush", rect: [8, 2, 10, 12], radius: 1, outset: 0 } }]);
    // A clip index the scene does not hold is a full admission, never a guess.
    expect(await renderer.patchScene({ primitives: [], clips: [{ id: "clipper", index: 1, dx: 1, dy: 1, totalDx: 1, totalDy: 1 }] }))
      .toMatchObject({ presented: false, reason: "retained patch requires full scene admission" });
    renderer.dispose();

    // A serializer that refuses a clip replacement (one that predates the clip translation) is not advertised.
    stubEngineAndSerializer(
      "export function encodeRustScene(){return {bytes:new Uint8Array([1]),scene:{version:2,revision:1,width:1,height:1,designWidth:1,designHeight:1,resources:[],commands:[]},resources:[],textUploads:[],unsupportedCommands:0}};" +
      "export function encodeRustPatch(){return null};export function encodeRustResources(){return new Uint8Array(0)};" +
      "export function encodeRustRetainedPatch(){return null}",
    );
    const older = await createRustDrawListExecutor({ canvas: document.createElement("canvas"), width: 1, height: 1,
      designWidth: 1, designHeight: 1, onInvalidate: () => {} });
    expect(older.translatesClips).toBe(false);
    older.dispose();
  });

  it("reuses one JSON.stringify of a style object shared by two text records when textPrepCache is on", async () => {
    window.history.replaceState({}, "", "/?rustTextPrepCache=1&rustDiagnostics=1");
    mockInkContext();
    (globalThis as Record<string, unknown>).__rustProjectionTest = {
      engine: { backend: "WebGL2", resize: () => {}, dispose: () => {}, upload_rgba_batch: () => 0,
        admit_scene: () => JSON.stringify({ accepted: true, revision: 1, unsupportedCommands: 0, resourcePending: 0 }),
        apply_patch: () => "{}",
        present: async () => JSON.stringify({ presented: true, revision: 1, draws: 2, resourcePending: 0, unsupportedCommands: 0 }) },
      encode: (input: { texts: readonly PixiTextRecord[];
        resolveText: (record: PixiTextRecord) => { resource: { key: string; width: number; height: number }; pixels: Uint8Array } | null }) => {
        const results = input.texts.map((record) => input.resolveText(record)!);
        return { bytes: new Uint8Array([1]), scene: { version: 2, revision: 1, resources: [], commands: [] },
          resources: results.map((r) => r.resource),
          textUploads: results.map((r) => ({ ...r.resource, pixels: r.pixels })), unsupportedCommands: 0 };
      },
    };
    stubEngineAndSerializer(
      "export function encodeRustScene(input){return globalThis.__rustProjectionTest.encode(input)};export function encodeRustPatch(){return null};export function encodeRustResources(){return new Uint8Array([2])}",
    );
    const renderer = await createRustDrawListExecutor({ canvas: document.createElement("canvas"), width: 1, height: 1,
      designWidth: 1, designHeight: 1, onInvalidate: () => {} });
    const style = { fontFamily: "Test", fontSize: 16, fill: "#ffffff" };
    const textA = { key: "a", insertionIndex: 0, text: "Hi", transform: [1, 0, 0, 1, 0, 0],
      resourceRevision: "1:font", style } as PixiTextRecord;
    const textB = { key: "b", insertionIndex: 1, text: "Yo", transform: [1, 0, 0, 1, 0, 0],
      resourceRevision: "1:font", style } as PixiTextRecord; // the SAME style object reference as `textA`
    expect(await renderer.render(createDrawList<string>(), [textA, textB])).toBe(true);
    const stats = (window as unknown as { __mirrorRustStats(): { styleCacheHits: number; styleCacheMisses: number } })
      .__mirrorRustStats();
    expect(stats.styleCacheMisses).toBe(1);
    expect(stats.styleCacheHits).toBe(1);
    renderer.dispose();
  });

  it("never populates the style cache when textPrepCache is off", async () => {
    window.history.replaceState({}, "", "/?rustTextPrepCache=0&rustDiagnostics=1");
    mockInkContext();
    (globalThis as Record<string, unknown>).__rustProjectionTest = {
      engine: { backend: "WebGL2", resize: () => {}, dispose: () => {}, upload_rgba_batch: () => 0,
        admit_scene: () => JSON.stringify({ accepted: true, revision: 1, unsupportedCommands: 0, resourcePending: 0 }),
        apply_patch: () => "{}",
        present: async () => JSON.stringify({ presented: true, revision: 1, draws: 2, resourcePending: 0, unsupportedCommands: 0 }) },
      encode: (input: { texts: readonly PixiTextRecord[];
        resolveText: (record: PixiTextRecord) => { resource: { key: string; width: number; height: number }; pixels: Uint8Array } | null }) => {
        const results = input.texts.map((record) => input.resolveText(record)!);
        return { bytes: new Uint8Array([1]), scene: { version: 2, revision: 1, resources: [], commands: [] },
          resources: results.map((r) => r.resource),
          textUploads: results.map((r) => ({ ...r.resource, pixels: r.pixels })), unsupportedCommands: 0 };
      },
    };
    stubEngineAndSerializer(
      "export function encodeRustScene(input){return globalThis.__rustProjectionTest.encode(input)};export function encodeRustPatch(){return null};export function encodeRustResources(){return new Uint8Array([2])}",
    );
    const renderer = await createRustDrawListExecutor({ canvas: document.createElement("canvas"), width: 1, height: 1,
      designWidth: 1, designHeight: 1, onInvalidate: () => {} });
    const style = { fontFamily: "Test", fontSize: 16, fill: "#ffffff" };
    const textA = { key: "a", insertionIndex: 0, text: "Hi", transform: [1, 0, 0, 1, 0, 0],
      resourceRevision: "1:font", style } as PixiTextRecord;
    const textB = { key: "b", insertionIndex: 1, text: "Yo", transform: [1, 0, 0, 1, 0, 0],
      resourceRevision: "1:font", style } as PixiTextRecord;
    expect(await renderer.render(createDrawList<string>(), [textA, textB])).toBe(true);
    const stats = (window as unknown as { __mirrorRustStats(): { styleCacheHits: number; styleCacheMisses: number } })
      .__mirrorRustStats();
    expect(stats).toMatchObject({ styleCacheHits: 0, styleCacheMisses: 0 });
    renderer.dispose();
  });

  it.each([[true], [false]])("skips a redundant prefetch only when snapshotReuse is %s", async (on) => {
    window.history.replaceState({}, "", on ? "/?rustSnapshotReuse=1&rustDiagnostics=1" : "/?rustSnapshotReuse=0&rustDiagnostics=1");
    vi.stubGlobal("fetch", () => Promise.reject(new Error("blocked in test")));
    (globalThis as Record<string, unknown>).__rustProjectionTest = { engine: {
      backend: "WebGL2", resize: () => {}, dispose: () => {}, upload_rgba_batch: () => 0,
      admit_scene: () => JSON.stringify({ accepted: true, revision: 1, unsupportedCommands: 0, resourcePending: 0 }),
      apply_patch: () => "{}",
      present: async () => JSON.stringify({ presented: true, revision: 1, draws: 1, resourcePending: 0, unsupportedCommands: 0 }),
    } };
    stubEngineAndSerializer(
      "export function encodeRustScene(){return {bytes:new Uint8Array([1]),scene:{version:2,revision:1,resources:[],commands:[]},resources:[],textUploads:[],unsupportedCommands:0}};export function encodeRustPatch(){return null};export function encodeRustResources(){return new Uint8Array([2])}",
    );
    const renderer = await createRustDrawListExecutor({ canvas: document.createElement("canvas"), width: 1, height: 1,
      designWidth: 1, designHeight: 1, onInvalidate: () => {} });
    const list = createDrawList<string>();
    const quad = createQuadView(); quad.w = quad.h = quad.srcW = quad.srcH = 1;
    // [a, a, b, a] — a run of the SAME texture only skips the repeat, never a texture seen earlier in the scene.
    list.pushQuad(quad, "atlas-a"); list.pushQuad(quad, "atlas-a"); list.pushQuad(quad, "atlas-b"); list.pushQuad(quad, "atlas-a");
    void Promise.resolve(renderer.render(list)).catch(() => {});
    const stats = (window as unknown as { __mirrorRustStats(): { prefetchSkips: number } }).__mirrorRustStats();
    expect(stats.prefetchSkips).toBe(on ? 1 : 0);
    renderer.dispose();
  });

  it.each([[true], [false]])("passes fast:true to encodeRustScene and encodeRustPatch only when fastSerializer is %s", async (on) => {
    window.history.replaceState({}, "", on ? "/?rustFastSerializer=1" : "/?rustFastSerializer=0");
    let sceneFastFlag: boolean | undefined;
    let patchOptions: unknown;
    const scene = (revision: number) => ({ version: 2 as const, revision, width: 1, height: 1, designWidth: 1, designHeight: 1,
      resources: [], commands: [] });
    (globalThis as Record<string, unknown>).__rustProjectionTest = {
      engine: { backend: "WebGL2", resize: () => {}, dispose: () => {}, upload_rgba_batch: () => 0,
        admit_scene: () => JSON.stringify({ accepted: true, revision: 1, unsupportedCommands: 0, resourcePending: 0 }),
        apply_patch: () => JSON.stringify({ accepted: true, revision: 2, unsupportedCommands: 0, resourcePending: 0 }),
        present: async () => JSON.stringify({ presented: true, revision: 1, draws: 1, resourcePending: 0, unsupportedCommands: 0 }) },
      encode: (input: { revision: number; fast?: boolean }) => { sceneFastFlag = input.fast;
        const typed = scene(input.revision);
        return { bytes: new TextEncoder().encode(JSON.stringify(typed)), scene: typed, resources: [], textUploads: [], unsupportedCommands: 0 }; },
      patch: (_a: unknown, _b: unknown, _hint: unknown, options: unknown) => { patchOptions = options; return new Uint8Array([1]); },
    };
    stubEngineAndSerializer(
      "export function encodeRustScene(input){return globalThis.__rustProjectionTest.encode(input)};export function encodeRustPatch(a,b,c,d){return globalThis.__rustProjectionTest.patch(a,b,c,d)};export function encodeRustResources(){return new Uint8Array(0)}",
    );
    const renderer = await createRustDrawListExecutor({ canvas: document.createElement("canvas"), width: 1, height: 1,
      designWidth: 1, designHeight: 1, onInvalidate: () => {} });
    const list = createDrawList<string>();
    const quad = createQuadView(); quad.w = quad.h = quad.srcW = quad.srcH = 1; list.pushQuad(quad);
    expect(await renderer.render(list)).toBe(true); // full-scene admission — exercises encodeRustScene
    expect(await renderer.render(list)).toBe(true); // second build — committedTypedScene is set, exercises encodeRustPatch
    expect(sceneFastFlag).toBe(on ? true : undefined);
    expect(patchOptions).toEqual(on ? { fast: true } : undefined);
    renderer.dispose();
  });

  it("consults the serializer's cached command index for a retained patch when fastSerializer is on and the index is present", async () => {
    window.history.replaceState({}, "", "/?rustFastSerializer=1");
    let acceptedRevision = 0;
    const scene = (revision: number) => ({ version: 2 as const, revision, width: 1, height: 1, designWidth: 1, designHeight: 1,
      resources: [], commands: [
        { id: "c0", kind: "quad", resource: null, m: [1, 0, 0, 1, 0, 0], w: 1, h: 1, src: [0, 0, 1, 1],
          color: [1, 1, 1, 1], blend: "mix", flipH: false, flipV: false, colorMatrix: null },
        { id: "tlabel", kind: "rasterText", resource: "text:label", m: [1, 0, 0, 1, 0, 0], w: 1, h: 1, src: [0, 0, 1, 1],
          color: [1, 1, 1, 1], blend: "mix", flipH: false, flipV: false, colorMatrix: null },
      ] });
    const retainedCalls: Array<Array<{ id: string; command: { kind: string; resource: unknown }; localTransform?: readonly number[] }>> = [];
    (globalThis as Record<string, unknown>).__rustProjectionTest = {
      engine: { backend: "WebGL2", resize: () => {}, dispose: () => {}, upload_rgba_batch: () => 0,
        admit_scene: (bytes: Uint8Array) => { acceptedRevision = JSON.parse(new TextDecoder().decode(bytes)).revision;
          return JSON.stringify({ accepted: true, revision: acceptedRevision, unsupportedCommands: 0, resourcePending: 0 }); },
        apply_patch: () => JSON.stringify({ accepted: true, revision: acceptedRevision, unsupportedCommands: 0, resourcePending: 0 }),
        present: async () => JSON.stringify({ presented: true, revision: acceptedRevision, draws: 1, resourcePending: 0, unsupportedCommands: 0 }) },
      encode: (input: { revision: number }) => {
        const typed = scene(input.revision);
        return { bytes: new TextEncoder().encode(JSON.stringify(typed)), scene: typed, resources: [], textUploads: [], unsupportedCommands: 0 };
      },
      // DELIBERATELY SWAPPED relative to the commands' real array positions (c0 is really index 0, tlabel index 1).
      // `encodeRetainedPatch` treats "quad" and "rasterText" alike for its kind gate, so a swap does not refuse —
      // but it DOES change which command gets copied as the update base and whether the transform lands on `m`
      // or `localTransform` (rasterText-only). That difference is the observable proof the index was consulted.
      commandIndex: () => new Map([["c0", 1], ["tlabel", 0]]),
      retained: (base: unknown, revision: number, updates: typeof retainedCalls[number]) => {
        retainedCalls.push(updates);
        return { bytes: new Uint8Array([9]), scene: { ...(base as { commands: unknown[] }), revision }, changedIndexes: [] };
      },
    };
    stubEngineAndSerializer(
      "export function encodeRustScene(input){return globalThis.__rustProjectionTest.encode(input)};" +
      "export function encodeRustPatch(){return null};" +
      "export function encodeRustResources(){return new Uint8Array(0)};" +
      "export function encodeRustRetainedPatch(a,b,c,d){return globalThis.__rustProjectionTest.retained(a,b,c,d)};" +
      "export function rustSceneCommandIndex(scene){return globalThis.__rustProjectionTest.commandIndex(scene)}",
    );
    const renderer = await createRustDrawListExecutor({ canvas: document.createElement("canvas"), width: 1, height: 1,
      designWidth: 1, designHeight: 1, onInvalidate: () => {} });
    const list = createDrawList<string>();
    const quad = createQuadView(); quad.w = quad.h = quad.srcW = quad.srcH = 1; list.pushQuad(quad);
    expect(await renderer.render(list)).toBe(true);
    const result = await renderer.patchScene({ primitives: [{ id: "c0", transform: [1, 0, 0, 1, 5, 0] }] });
    expect(result).toMatchObject({ presented: true });
    expect(retainedCalls).toHaveLength(1);
    const [update] = retainedCalls[0];
    expect(update.id).toBe("c0");
    // Proof the SWAPPED index was consulted: "c0" resolved to commands[1] (the "tlabel"/rasterText command), not
    // its own real quad at commands[0] — a correct rebuild could never produce a rasterText base for "c0".
    expect(update.command.kind).toBe("rasterText");
    expect(update.command.resource).toBe("text:label");
    expect(update.localTransform).toEqual([1, 0, 0, 1, 5, 0]);
    renderer.dispose();
  });

  it("falls back to rebuilding its own command index when the serializer offers none", async () => {
    window.history.replaceState({}, "", "/?rustFastSerializer=1");
    let acceptedRevision = 0;
    const scene = (revision: number) => ({ version: 2 as const, revision, width: 1, height: 1, designWidth: 1, designHeight: 1,
      resources: [], commands: [
        { id: "c0", kind: "quad", resource: null, m: [1, 0, 0, 1, 0, 0], w: 1, h: 1, src: [0, 0, 1, 1],
          color: [1, 1, 1, 1], blend: "mix", flipH: false, flipV: false, colorMatrix: null },
      ] });
    const retainedCalls: unknown[] = [];
    (globalThis as Record<string, unknown>).__rustProjectionTest = {
      engine: { backend: "WebGL2", resize: () => {}, dispose: () => {}, upload_rgba_batch: () => 0,
        admit_scene: (bytes: Uint8Array) => { acceptedRevision = JSON.parse(new TextDecoder().decode(bytes)).revision;
          return JSON.stringify({ accepted: true, revision: acceptedRevision, unsupportedCommands: 0, resourcePending: 0 }); },
        apply_patch: () => JSON.stringify({ accepted: true, revision: acceptedRevision, unsupportedCommands: 0, resourcePending: 0 }),
        present: async () => JSON.stringify({ presented: true, revision: acceptedRevision, draws: 1, resourcePending: 0, unsupportedCommands: 0 }) },
      encode: (input: { revision: number }) => {
        const typed = scene(input.revision);
        return { bytes: new TextEncoder().encode(JSON.stringify(typed)), scene: typed, resources: [], textUploads: [], unsupportedCommands: 0 };
      },
      retained: (base: ReturnType<typeof scene>, revision: number,
        updates: Array<{ id: string; command: Record<string, unknown> }>) => {
        retainedCalls.push({ base, revision, updates });
        const commands = base.commands.slice();
        const changedIndexes: number[] = [];
        for (const update of updates) {
          const index = commands.findIndex((command) => command.id === update.id);
          commands[index] = update.command as typeof commands[number];
          changedIndexes.push(index);
        }
        return { bytes: new Uint8Array([9]), scene: { ...base, revision, commands }, changedIndexes };
      },
      // No `rustSceneCommandIndex` export at all — see the serializer module source below.
    };
    stubEngineAndSerializer(
      "export function encodeRustScene(input){return globalThis.__rustProjectionTest.encode(input)};" +
      "export function encodeRustPatch(){return null};" +
      "export function encodeRustResources(){return new Uint8Array(0)};" +
      "export function encodeRustRetainedPatch(a,b,c,d){return globalThis.__rustProjectionTest.retained(a,b,c,d)}",
    );
    const renderer = await createRustDrawListExecutor({ canvas: document.createElement("canvas"), width: 1, height: 1,
      designWidth: 1, designHeight: 1, onInvalidate: () => {} });
    const list = createDrawList<string>();
    const quad = createQuadView(); quad.w = quad.h = quad.srcW = quad.srcH = 1; list.pushQuad(quad);
    expect(await renderer.render(list)).toBe(true);
    const result = await renderer.patchScene({ primitives: [{ id: "c0", transform: [1, 0, 0, 1, 5, 0] }] });
    expect(result).toMatchObject({ presented: true });
    expect(retainedCalls).toHaveLength(1);
    renderer.dispose();
  });

  it.each([[true], [false]])("calls set_draw_state_dedupe once after create only when drawStateDedupe is %s", async (on) => {
    window.history.replaceState({}, "", on ? "/?rustDrawStateDedupe=1" : "/?rustDrawStateDedupe=0");
    const dedupeCalls: boolean[] = [];
    (globalThis as Record<string, unknown>).__rustProjectionTest = { engine: {
      backend: "WebGL2", resize: () => {}, dispose: () => {}, upload_rgba_batch: () => 0,
      admit_scene: () => JSON.stringify({ accepted: true, revision: 1, unsupportedCommands: 0, resourcePending: 0 }),
      apply_patch: () => "{}",
      present: async () => JSON.stringify({ presented: true, revision: 1, draws: 0, resourcePending: 0, unsupportedCommands: 0 }),
      set_draw_state_dedupe: (enabled: boolean) => dedupeCalls.push(enabled),
    } };
    stubEngineAndSerializer(
      "export function encodeRustScene(){return {bytes:new Uint8Array([1]),scene:{version:2,revision:1,resources:[],commands:[]},resources:[],textUploads:[],unsupportedCommands:0}};export function encodeRustPatch(){return null};export function encodeRustResources(){return new Uint8Array(0)}",
    );
    const renderer = await createRustDrawListExecutor({ canvas: document.createElement("canvas"), width: 1, height: 1,
      designWidth: 1, designHeight: 1, onInvalidate: () => {} });
    expect(dedupeCalls).toEqual(on ? [true] : []);
    renderer.dispose();
  });

  it("does not throw when set_draw_state_dedupe is absent from the glue, even with the flag on", async () => {
    window.history.replaceState({}, "", "/?rustDrawStateDedupe=1");
    (globalThis as Record<string, unknown>).__rustProjectionTest = { engine: {
      backend: "WebGL2", resize: () => {}, dispose: () => {}, upload_rgba_batch: () => 0,
      admit_scene: () => JSON.stringify({ accepted: true, revision: 1, unsupportedCommands: 0, resourcePending: 0 }),
      apply_patch: () => "{}",
      present: async () => JSON.stringify({ presented: true, revision: 1, draws: 0, resourcePending: 0, unsupportedCommands: 0 }),
      // deliberately no set_draw_state_dedupe — simulates a wasm glue build that predates it
    } };
    stubEngineAndSerializer(
      "export function encodeRustScene(){return {bytes:new Uint8Array([1]),scene:{version:2,revision:1,resources:[],commands:[]},resources:[],textUploads:[],unsupportedCommands:0}};export function encodeRustPatch(){return null};export function encodeRustResources(){return new Uint8Array(0)}",
    );
    const renderer = await createRustDrawListExecutor({ canvas: document.createElement("canvas"), width: 1, height: 1,
      designWidth: 1, designHeight: 1, onInvalidate: () => {} });
    renderer.dispose();
  });
});
