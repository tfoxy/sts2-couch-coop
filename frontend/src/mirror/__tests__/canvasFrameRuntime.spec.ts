import { describe, expect, it } from "vitest";
import {
  compileDrawList,
  createDrawList,
  createQuadView,
  type CompiledRefreshResult,
  type DrawList,
  type ExecuteOptions,
  type ExecutorTexture,
  type RetainedRangeSubstitutionPlan,
  type StageProjection,
} from "@godot-scene-web/canvas";

import { buildDrawList } from "@/mirror/canvas/buildDrawList";
import { createPaintGuard } from "@/mirror/canvas/paintGuard";
import { captureWireDeltaGraph, type WireDeltaGraph } from "@/mirror/canvas/wireDeltaGraph";
import {
  createCanvasFramePresentationRuntime,
  createCanvasFrameRuntime,
} from "@/mirror/renderer/canvas/frameRuntime";
import {
  createCanvasPatchExecutionRuntime,
  createCanvasPatchRuntime,
} from "@/mirror/renderer/canvas/patchRuntime";
import { createMirrorState, type MirrorNode, type MirrorState } from "@/mirror/sceneTree";

const projection: StageProjection = {
  designWidth: 1920,
  designHeight: 1080,
  toClip: new Float32Array([1, 1, 0, 0]),
  toFramebuffer: new Float32Array([1, 0, 0, 1, 0, 0]),
  framebufferWidth: 1920,
  framebufferHeight: 1080,
};

describe("canvas frame runtime", () => {
  it("shares one compiled refresh between retained planning and final execution without changing the logical list", () => {
    const list = createDrawList<ExecutorTexture | null>();
    const compiled = compileDrawList(list);
    const quad = createQuadView();
    quad.w = quad.h = quad.srcW = quad.srcH = 8;
    const substitution = {} as RetainedRangeSubstitutionPlan;
    let preparedRefresh: CompiledRefreshResult | null = null;
    let executeOptions: ExecuteOptions | undefined;
    const runtime = createCanvasFrameRuntime({
      list,
      buildList: list as unknown as DrawList<string>,
      executor: {
        execute: (_list, _projection, options) => {
          executeOptions = options;
          return true;
        },
      },
      projection: () => projection,
      paintGuard: createPaintGuard<ExecutorTexture | null>(),
      paintSkipEnabled: false,
      isUnavailable: () => false,
      pixelEpoch: () => 0,
      inputEpoch: () => 0,
      textureReadyEpoch: () => "ready",
      now: () => 0,
      buildScene: buildDrawList,
      makeBuildOptions: () => ({ resetList: false }),
      prepareBuild: () => {},
      collectCaptureIds: () => {},
      emitBuildPrefix: (target) => target.pushQuad(quad, null),
      admitBuild: () => true,
      finalizeBuild: () => {},
      finalizeDerived: () => {},
      captureWireGraph: () => null,
      onBuildTiming: () => {},
      onPaintTiming: () => {},
      beforeDirectPaint: () => {},
      onPaintUnavailable: () => {},
      onPaintSkipped: () => {},
      onPainted: () => {},
      retained: {
        planBuild: () => {},
        prepare: (_list, _projection, refresh) => {
          preparedRefresh = refresh;
          return substitution;
        },
      },
    });

    expect(runtime.runBuild(createMirrorState())).toBe(true);
    expect(list.count).toBe(1);
    runtime.paint({ compiled });

    expect(preparedRefresh).not.toBeNull();
    expect(executeOptions?.compiledRefresh).toBe(preparedRefresh);
    expect(executeOptions?.substitutions).toBe(substitution);
    expect(list.count).toBe(1);
  });

  it("keeps a rejected presentation candidate out of finalization, overlay, paint, and chrome paths", () => {
    let admitted = true;
    let finalized = 0;
    let overlaySyncs = 0;
    let submissions = 0;
    let chromePatches = 0;
    const state = createMirrorState();
    const presentation = createCanvasFramePresentationRuntime({
      framePorts: {
        list: createDrawList<null>(),
        buildList: createDrawList<string>(),
        executor: { execute: () => { submissions++; return true; } },
        projection: () => projection,
        paintGuard: createPaintGuard<null>(),
        paintSkipEnabled: false,
        isUnavailable: () => false,
        inputEpoch: () => 0,
        textureReadyEpoch: () => "ready",
        now: () => 0,
        buildScene: buildDrawList,
        makeBuildOptions: () => ({}),
        prepareBuild: () => {},
        collectCaptureIds: () => {},
        emitBuildPrefix: () => {},
        admitBuild: () => admitted,
        finalizeBuild: () => { finalized++; },
        finalizeDerived: () => {},
        captureWireGraph: () => null,
        onBuildTiming: () => {},
      },
      basePixelEpoch: () => 0,
      state: () => state,
      disposed: () => false,
      syncOverlay: () => { overlaySyncs++; },
      beforeDirectPaint: () => {},
      onDirectPaintTiming: () => {},
      onPaintUnavailable: () => {},
      onPaintSkipped: () => {},
    });

    expect(presentation.buildAndPaint(state)).toBe(true);
    expect(finalized).toBe(1);
    expect(overlaySyncs).toBe(1);
    expect(submissions).toBe(1);

    admitted = false;
    expect(presentation.buildAndPaint(state)).toBe(false);
    expect(presentation.frame.listMatchesSnapshot).toBe(false);
    expect(finalized).toBe(1);
    expect(overlaySyncs).toBe(1);
    expect(submissions).toBe(1);
    expect(presentation.patchChrome(() => {
      chromePatches++;
      return true;
    })).toBe(false);
    expect(chromePatches).toBe(0);
    expect(submissions).toBe(1);
  });

  it("keeps the whole published snapshot when strict admission rejects a candidate", () => {
    let admission = true;
    let serial = 0;
    let unavailable = false;
    let unavailableCalls = 0;
    let submissions = 0;
    const runtime = createCanvasFrameRuntime({
      list: createDrawList<null>(),
      buildList: createDrawList<string>(),
      executor: { execute: () => { submissions++; return true; } },
      projection: () => projection,
      paintGuard: createPaintGuard<null>(),
      paintSkipEnabled: false,
      isUnavailable: () => unavailable,
      pixelEpoch: () => 0,
      inputEpoch: () => 0,
      textureReadyEpoch: () => "ready",
      now: () => 0,
      buildScene: (state, list, options) => {
        options?.captureGlobals?.out.set("captured", {
          g: [1, 0, 0, 1, ++serial, 0],
          drawn: [1, 0, 0, 1, serial, 0],
          parentTy: 0,
          modulate: [1, 1, 1, 1],
        });
        return buildDrawList(state, list, options);
      },
      makeBuildOptions: (_state, globals) => ({
        captureGlobals: { ids: new Set(["captured"]), out: globals },
      }),
      prepareBuild: () => {},
      collectCaptureIds: () => {},
      emitBuildPrefix: () => {},
      admitBuild: () => admission,
      finalizeBuild: () => {},
      finalizeDerived: () => {},
      captureWireGraph: () => null,
      onBuildTiming: () => {},
      onPaintTiming: () => {},
      beforeDirectPaint: () => {},
      onPaintUnavailable: () => { unavailableCalls++; },
      onPaintSkipped: () => {},
      onPainted: () => {},
    });
    const patches = createCanvasPatchRuntime({
      frame: runtime, inputEpoch: () => 0, textureReadyEpoch: () => "ready",
    });
    const state = createMirrorState();
    const original = {
      id: "card", parentId: null, name: "card", nodeType: "Control", transform: [1, 0, 0, 1, 0, 0],
      localRect: { x: 0, y: 0, width: 40, height: 30 }, visible: true, opacity: 1,
      fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffff" }, mouseFilter: 0,
    } as MirrorNode;
    state.nodes.set(original.id, original);
    state.orderedIds = [original.id];

    expect(runtime.runBuild(state)).toBe(true);
    const published = runtime.snapshot;
    expect(runtime.listMatchesSnapshot).toBe(true);
    expect(published?.capturedGlobals.get("captured")?.drawn[4]).toBe(1);
    expect(published?.scene.nodes.get(original.id)).toBe(original);

    const rejected = { ...original, opacity: 0.25 } as MirrorNode;
    state.nodes.set(rejected.id, rejected);
    state.revision++;
    admission = false;
    expect(runtime.runBuild(state)).toBe(false);
    expect(runtime.builds).toBe(2);
    expect(runtime.snapshot).toBe(published);
    expect(runtime.listMatchesSnapshot).toBe(false);
    expect(runtime.snapshot?.capturedGlobals.get("captured")?.drawn[4]).toBe(1);
    // The live state moved while strict admission declined its candidate; the
    // visible snapshot must retain the node facts that produced its pixels.
    expect(runtime.snapshot?.scene.nodes.get(original.id)).toBe(original);
    // The shared arena was reset for the rejected candidate, so neither a
    // direct publication nor patch admission may bless it as the old frame.
    expect(runtime.publishPatch(state, [])).toBeNull();
    expect(patches.admitWire()).toBeNull();
    runtime.paint();
    expect(unavailableCalls).toBe(1);
    expect(submissions).toBe(0);

    admission = true;
    expect(runtime.runBuild(state)).toBe(true);
    expect(runtime.listMatchesSnapshot).toBe(true);
    expect(patches.admitWire()).toBe(runtime.snapshot);
    runtime.paint();
    expect(submissions).toBe(1);

    unavailable = true;
    runtime.paint();
    expect(unavailableCalls).toBe(2);
    runtime.dispose();
    expect(runtime.listMatchesSnapshot).toBe(false);
  });

  it("admits and publishes patched frames through the same atomic snapshot", () => {
    let inputEpoch = 0;
    let textureEpoch = "ready";
    const runtime = createCanvasFrameRuntime({
      list: createDrawList<null>(),
      buildList: createDrawList<string>(),
      executor: { execute: () => true }, projection: () => projection,
      paintGuard: createPaintGuard<null>(), paintSkipEnabled: false,
      isUnavailable: () => false, pixelEpoch: () => 7,
      inputEpoch: () => inputEpoch, textureReadyEpoch: () => textureEpoch, now: () => 0,
      buildScene: buildDrawList, makeBuildOptions: () => ({}), prepareBuild: () => {},
      collectCaptureIds: () => {}, emitBuildPrefix: () => {}, admitBuild: () => true,
      finalizeBuild: () => {}, finalizeDerived: () => {}, captureWireGraph: () => "graph",
      onBuildTiming: () => {}, onPaintTiming: () => {}, beforeDirectPaint: () => {},
      onPaintUnavailable: () => {}, onPaintSkipped: () => {}, onPainted: () => {},
    });
    const patches = createCanvasPatchRuntime({
      frame: runtime, inputEpoch: () => inputEpoch, textureReadyEpoch: () => textureEpoch,
    });
    expect(patches.stats).toBe(patches.stats);
    const state = createMirrorState();
    state.revision = 4;

    expect(runtime.runBuild(state)).toBe(true);
    const full = runtime.snapshot!;
    expect(patches.admitAnimation(state)).toBe(full);

    // A failed admission neither mutates nor replaces the drawn snapshot.
    inputEpoch++;
    expect(patches.admitWire()).toBeNull();
    expect(runtime.snapshot).toBe(full);
    inputEpoch--;
    textureEpoch = "new-ready";
    expect(patches.admitWire()).toBeNull();
    expect(runtime.snapshot).toBe(full);
    textureEpoch = "ready";

    state.revision++;
    const patched = patches.publish(state)!;
    expect(patched).not.toBe(full);
    expect(patched).toMatchObject({
      build: full.build,
      paintOrder: full.paintOrder,
      hitEntries: full.hitEntries,
      stateRevision: 5,
      inputEpoch: 0,
      resourceEpoch: 7,
      textureReadyEpoch: "ready",
      buildEpoch: full.buildEpoch,
    });
    expect(patched.derived).not.toBe(full.derived);
    expect(runtime.snapshot).toBe(patched);
  });

  it("keeps the scene identity for an admitted nonstructural wire patch and replaces it for a full build", () => {
    const runtime = createCanvasFrameRuntime({
      list: createDrawList<null>(), buildList: createDrawList<string>(),
      executor: { execute: () => true }, projection: () => projection,
      paintGuard: createPaintGuard<null>(), paintSkipEnabled: false,
      isUnavailable: () => false, pixelEpoch: () => 0, inputEpoch: () => 0,
      textureReadyEpoch: () => "ready", now: () => 0, buildScene: buildDrawList,
      makeBuildOptions: () => ({}), prepareBuild: () => {}, collectCaptureIds: () => {}, emitBuildPrefix: () => {},
      admitBuild: () => true, finalizeBuild: () => {}, finalizeDerived: () => {}, captureWireGraph: () => null,
      onBuildTiming: () => {}, onPaintTiming: () => {}, beforeDirectPaint: () => {},
      onPaintUnavailable: () => {}, onPaintSkipped: () => {}, onPainted: () => {},
    });
    const state = createMirrorState();
    const first = {
      id: "card", parentId: null, name: "card", nodeType: "Control", transform: [1, 0, 0, 1, 0, 0],
      localRect: { x: 0, y: 0, width: 40, height: 30 }, visible: true, opacity: 1,
      fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffff" }, mouseFilter: 0,
    } as MirrorNode;
    state.nodes.set(first.id, first);
    state.orderedIds = [first.id];
    state.revision = 1;
    expect(runtime.runBuild(state)).toBe(true);
    const full = runtime.snapshot!;

    const changed = { ...first, opacity: 0.5 } as MirrorNode;
    state.nodes.set(changed.id, changed);
    state.changedIds.add(changed.id);
    state.revision++;
    const patched = runtime.publishPatch(state, state.changedIds)!;
    expect(patched.scene).toBe(full.scene);
    expect(patched.scene.nodes).toBe(full.scene.nodes);
    expect(patched.scene.nodes.get(changed.id)).toBe(changed);

    state.orderedIds = [changed.id, "other"];
    state.nodes.set("other", { ...first, id: "other" } as MirrorNode);
    state.revision++;
    expect(runtime.runBuild(state)).toBe(true);
    expect(runtime.snapshot!.scene).not.toBe(patched.scene);
    expect(runtime.snapshot!.scene.nodes).not.toBe(patched.scene.nodes);
  });

  it("defers patch and unchanged-wire late admission facts until their cheap gates pass", () => {
    const state = createMirrorState();
    const list = createDrawList<null>();
    let contextLost = false;
    let contextReads = 0;
    let throwSample = false;
    let sampleReads = 0;
    let textureReads = 0;
    let fxReads = 0;
    let spineReads = 0;
    let trailReads = 0;
    let noOpPresents = 0;
    const frame = createCanvasFrameRuntime<WireDeltaGraph>({
      list,
      buildList: list as unknown as DrawList<string>,
      executor: { execute: () => true },
      projection: () => projection,
      paintGuard: createPaintGuard<null>(),
      paintSkipEnabled: false,
      isUnavailable: () => false,
      pixelEpoch: () => 0,
      inputEpoch: () => 0,
      textureReadyEpoch: () => {
        textureReads++;
        return "ready";
      },
      now: () => 0,
      buildScene: buildDrawList,
      makeBuildOptions: () => ({}),
      prepareBuild: () => {},
      collectCaptureIds: () => {},
      emitBuildPrefix: () => {},
      admitBuild: () => true,
      finalizeBuild: () => {},
      finalizeDerived: () => {},
      captureWireGraph: (next, build) => captureWireDeltaGraph(next, build.ranges),
      onBuildTiming: () => {},
      onPaintTiming: () => {},
      beforeDirectPaint: () => {},
      onPaintUnavailable: () => {},
      onPaintSkipped: () => {},
      onPainted: () => {},
    });
    const patches = createCanvasPatchRuntime({
      frame,
      inputEpoch: () => 0,
      textureReadyEpoch: () => {
        textureReads++;
        return "ready";
      },
    });
    const execution = createCanvasPatchExecutionRuntime({
      patch: patches,
      frame,
      state: () => state,
      list,
      now: () => 0,
      contextLost: () => {
        contextReads++;
        return contextLost;
      },
      textureReadyEpoch: () => {
        textureReads++;
        return "ready";
      },
      fxDirty: () => {
        fxReads++;
        return false;
      },
      spineDirty: () => {
        spineReads++;
        return false;
      },
      trailDue: () => {
        trailReads++;
        return false;
      },
      transformOverrides: new Map(),
      alphaOverrides: new Map(),
      alphaApplied: new Map(),
      cosmeticOffsets: new Map(),
      localAnims: new Map(),
      frameSubstitutes: new Map(),
      opacitySampledIds: new Set(),
      sourceSampledIds: new Set(),
      frameSampleMask: () => {
        sampleReads++;
        if (throwSample) throw new Error("sample read before its admission gate");
        return 0;
      },
      intentNode: () => undefined,
      offsetPending: () => false,
      cosmeticVersion: () => 0,
      cosmeticVersionAtBuild: () => 0,
      trailLatchVersion: () => 0,
      trailLatchVersionAtBuild: () => 0,
      spreadDxOf: () => 0,
      resolveSource: () => ({ texture: null, srcX: Number.NaN, srcY: Number.NaN, srcW: Number.NaN, srcH: Number.NaN }),
      bankAppliedAlphas: () => {},
      invalidateInputCaches: () => {},
      notePatchTiming: () => {},
      syncOverlay: () => {},
      present: () => { noOpPresents++; },
    });
    const resetLateReads = () => {
      contextReads = 0;
      sampleReads = 0;
      textureReads = 0;
      fxReads = 0;
      spineReads = 0;
      trailReads = 0;
    };

    throwSample = true;
    expect(execution.tryPatchAndPaint(0)).toBe(false);
    expect(sampleReads).toBe(0);
    expect(textureReads).toBe(0);
    expect(fxReads).toBe(0);

    throwSample = false;
    expect(frame.runBuild(state)).toBe(true);
    resetLateReads();

    contextLost = true;
    throwSample = true;
    expect(execution.tryPatchAndPaint(0)).toBe(false);
    expect(contextReads).toBe(1);
    expect(sampleReads).toBe(0);
    expect(textureReads).toBe(0);
    expect(fxReads).toBe(0);
    expect(spineReads).toBe(0);
    expect(trailReads).toBe(0);

    contextLost = false;
    throwSample = false;
    resetLateReads();
    expect(execution.tryPatchAndPaint(0)).toBe(false);
    expect(sampleReads).toBe(1);
    expect(textureReads).toBe(0);
    expect(fxReads).toBe(0);
    expect(spineReads).toBe(0);
    expect(trailReads).toBe(0);

    resetLateReads();
    expect(execution.tryUnchangedWireNoop(state, false, 0)).toBe(true);
    expect(noOpPresents).toBe(1);

    const changed = createMirrorState();
    changed.changedIds.add("changed");
    resetLateReads();
    expect(execution.tryUnchangedWireNoop(changed, false, 0)).toBe(false);
    expect(contextReads).toBe(0);
    expect(textureReads).toBe(0);
    expect(fxReads).toBe(0);
    expect(spineReads).toBe(0);
    expect(trailReads).toBe(0);
  });

  it("owns unchanged-wire admission and only presents after atomic publication", () => {
    let inputEpoch = 0;
    const runtime = createCanvasFrameRuntime({
      list: createDrawList<null>(), buildList: createDrawList<string>(),
      executor: { execute: () => true }, projection: () => projection,
      paintGuard: createPaintGuard<null>(), paintSkipEnabled: false,
      isUnavailable: () => false, pixelEpoch: () => 0,
      inputEpoch: () => inputEpoch, textureReadyEpoch: () => "ready", now: () => 0,
      buildScene: buildDrawList, makeBuildOptions: () => ({}), prepareBuild: () => {},
      collectCaptureIds: () => {}, emitBuildPrefix: () => {}, admitBuild: () => true,
      finalizeBuild: () => {}, finalizeDerived: () => {}, captureWireGraph: () => null,
      onBuildTiming: () => {}, onPaintTiming: () => {}, beforeDirectPaint: () => {},
      onPaintUnavailable: () => {}, onPaintSkipped: () => {}, onPainted: () => {},
    });
    const patches = createCanvasPatchRuntime({ frame: runtime, inputEpoch: () => inputEpoch, textureReadyEpoch: () => "ready" });
    const state = createMirrorState();
    expect(runtime.runBuild(state)).toBe(true);
    let presentations = 0;
    const input = {
      state, structural: false, changedIds: 0, hasBuild: true, hasOrder: true, contextLost: false,
      transformOverrides: false, alphaOverrides: false, cosmeticOffsets: false, localAnimations: false,
      frameSubstitutes: false, offsetPending: false, cosmeticCurrent: 1, cosmeticAtBuild: 1,
      trailLatchCurrent: 1, trailLatchAtBuild: 1, textureCurrent: "ready", textureAtFrame: "ready",
      fxDirty: false, spineDirty: false, trailDue: false, present: () => { presentations++; },
    } as const;
    const before = runtime.snapshot!;
    state.revision++;
    expect(patches.tryUnchangedWireNoop(input)).toBe(true);
    expect(presentations).toBe(1);
    const published = runtime.snapshot!;
    expect(published).not.toBe(before);
    expect(published.stateRevision).toBe(state.revision);
    expect(published.scene).toBe(before.scene);
    expect(published.scene.nodes).toBe(before.scene.nodes);

    inputEpoch++;
    expect(patches.tryUnchangedWireNoop(input)).toBe(false);
    expect(presentations).toBe(1);
  });

  it("counts one command for an admitted overlapping source and opacity wire patch", () => {
    const wireState = (textureUrl: string, opacity: number, revision: number): MirrorState => {
      const next = createMirrorState();
      const card: MirrorNode = {
        id: "card",
        parentId: null,
        name: "card",
        nodeType: "Godot.TextureRect",
        transform: [1, 0, 0, 1, 0, 0],
        localRect: { x: 0, y: 0, width: 40, height: 30 },
        visible: true,
        opacity,
        textureUrl,
        textureRegion: { x: 0, y: 0, width: 40, height: 30 },
        mouseFilter: 0,
      } as MirrorNode;
      next.nodes.set(card.id, card);
      next.orderedIds = [card.id];
      next.revision = revision;
      return next;
    };
    let current = wireState("atlas-a.png", 1, 1);
    const list = createDrawList<null>();
    let contextLost = false;
    const frame = createCanvasFrameRuntime<WireDeltaGraph>({
      list,
      // The production bridge adapts this exact arena; this cast keeps the
      // test on the same list mutation surface without a texture bridge.
      buildList: list as unknown as DrawList<string>,
      executor: { execute: () => true },
      projection: () => projection,
      paintGuard: createPaintGuard<null>(),
      paintSkipEnabled: false,
      isUnavailable: () => false,
      pixelEpoch: () => 0,
      inputEpoch: () => 0,
      textureReadyEpoch: () => "ready",
      now: () => 0,
      buildScene: buildDrawList,
      makeBuildOptions: () => ({}),
      prepareBuild: () => {},
      collectCaptureIds: () => {},
      emitBuildPrefix: () => {},
      admitBuild: () => true,
      finalizeBuild: () => {},
      finalizeDerived: () => {},
      captureWireGraph: (state, build) => captureWireDeltaGraph(state, build.ranges),
      onBuildTiming: () => {},
      onPaintTiming: () => {},
      beforeDirectPaint: () => {},
      onPaintUnavailable: () => {},
      onPaintSkipped: () => {},
      onPainted: () => {},
    });
    const patches = createCanvasPatchRuntime({ frame, inputEpoch: () => 0, textureReadyEpoch: () => "ready" });
    const events: string[] = [];
    const execution = createCanvasPatchExecutionRuntime({
      patch: patches,
      frame,
      state: () => current,
      list,
      now: () => 0,
      contextLost: () => contextLost,
      textureReadyEpoch: () => "ready",
      fxDirty: () => false,
      spineDirty: () => false,
      trailDue: () => false,
      transformOverrides: new Map(),
      alphaOverrides: new Map(),
      alphaApplied: new Map(),
      cosmeticOffsets: new Map(),
      localAnims: new Map(),
      frameSubstitutes: new Map(),
      opacitySampledIds: new Set(),
      sourceSampledIds: new Set(),
      frameSampleMask: () => 0,
      intentNode: () => undefined,
      offsetPending: () => false,
      cosmeticVersion: () => 0,
      cosmeticVersionAtBuild: () => 0,
      trailLatchVersion: () => 0,
      trailLatchVersionAtBuild: () => 0,
      spreadDxOf: () => 0,
      resolveSource: () => ({ texture: {} as ExecutorTexture, srcX: 0, srcY: 0, srcW: 40, srcH: 30 }),
      bankAppliedAlphas: () => {},
      invalidateInputCaches: () => {},
      notePatchTiming: () => {},
      syncOverlay: () => events.push(`sync:${frame.snapshot?.stateRevision}`),
      present: () => events.push(`present:${frame.snapshot?.stateRevision}`),
    });

    expect(frame.runBuild(current)).toBe(true);
    const before = frame.snapshot;
    const changedCommands = frame.snapshot!.build.ranges.get("card")!.paintEnd - frame.snapshot!.build.ranges.get("card")!.start;
    expect(changedCommands).toBe(1);
    const next = wireState("atlas-b.png", 0.5, 2);
    next.orderedIds = current.orderedIds;
    next.changedIds.add("card");
    current = next;

    expect(execution.tryWireDeltaPatch(next, false, 0)).toBe(true);
    expect(frame.snapshot).not.toBe(before);
    expect(frame.snapshot?.stateRevision).toBe(2);
    expect(events).toEqual(["sync:2", "present:2"]);
    expect(execution.stats.wireDirectPatches).toBe(1);
    expect(execution.stats.wireChangedCommands).toBe(changedCommands);

    const inertBefore = frame.snapshot;
    const rejected = wireState("atlas-c.png", 0.25, 3);
    rejected.orderedIds = next.orderedIds;
    rejected.changedIds.add("card");
    current = rejected;
    contextLost = true;
    events.length = 0;
    expect(execution.tryWireDeltaPatch(rejected, false, 0)).toBe(false);
    expect(frame.snapshot).toBe(inertBefore);
    expect(events).toEqual([]);
  });
});
