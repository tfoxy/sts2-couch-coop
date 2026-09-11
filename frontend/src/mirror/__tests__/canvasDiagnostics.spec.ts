import { describe, expect, it } from "vitest";

import {
  canvasDrawListDump,
  canvasSnapshot,
  createCanvasDiagnostics,
  type CanvasDiagnosticPorts
} from "@/mirror/renderer/canvas/diagnostics";

describe("canvas diagnostics ownership", () => {
  it("removes only the real globals installed by its current owner", () => {
    const ports = (frames: number) => ({
      paintDumpEnabled: () => true,
      snapshotReady: () => false,
      snapshotPaint: () => undefined,
      snapshotDataUrl: () => "never",
      requestFrame: () => 0,
      dump: () => null,
      stats: () => ({ frames }),
      scrollProbe: () => null,
      trailProbe: () => null,
      raiseProbe: () => null,
      handPoses: () => ({}) as never,
      landingLog: () => ({}) as never,
      spreadAudit: () => ({}) as never
    } satisfies CanvasDiagnosticPorts);
    const first = createCanvasDiagnostics({}, ports(1));
    first.installCanvasGlobals();
    const second = createCanvasDiagnostics({}, ports(2));
    second.installCanvasGlobals();

    expect(first.removeOwner()).toBe(false);
    expect(
      (
        window as unknown as Record<string, () => { frames: number }>
      ).__mirrorCanvasStats(),
    ).toEqual({ frames: 2 });
    expect((window as unknown as Record<string, unknown>).__mirrorHandPoses).toBeTypeOf("function");
    expect((window as unknown as Record<string, unknown>).__mirrorLandingLog).toBeTypeOf("function");
    expect((window as unknown as Record<string, unknown>).__mirrorSpreadAudit).toBeTypeOf("function");

    expect(second.removeOwner()).toBe(true);
    expect(
      (window as unknown as Record<string, unknown>).__mirrorCanvasStats,
    ).toBeUndefined();
    expect((window as unknown as Record<string, unknown>).__mirrorHandPoses).toBeUndefined();
    expect((window as unknown as Record<string, unknown>).__mirrorLandingLog).toBeUndefined();
    expect((window as unknown as Record<string, unknown>).__mirrorSpreadAudit).toBeUndefined();
  });

  it("installs the canvas probes from observational ports and removes all of them together", async () => {
    const ports: CanvasDiagnosticPorts = {
      paintDumpEnabled: () => true,
      snapshotReady: () => false,
      snapshotPaint: () => { throw new Error("must not paint"); },
      snapshotDataUrl: () => "never",
      requestFrame: () => 0,
      dump: () => null,
      stats: () => ({ frames: 7 }),
      scrollProbe: () => ({ y: 3 }),
      trailProbe: () => null,
      raiseProbe: () => ({ lift: 0 }),
    };
    const diagnostics = createCanvasDiagnostics({}, ports);
    diagnostics.installCanvasGlobals();

    const globals = window as unknown as Record<string, () => unknown>;
    expect(globals.__mirrorCanvasStats()).toEqual({ frames: 7 });
    expect(globals.__mirrorDrawListDump()).toEqual([]);
    await expect(globals.__mirrorCanvasSnapshot()).resolves.toBeNull();
    expect(diagnostics.removeOwner()).toBe(true);
  });

  it("formats empty draw data without touching renderer state", () => {
    expect(canvasDrawListDump(null)).toEqual([]);
  });

  it("captures only after the explicitly supplied local paint port", async () => {
    const calls: string[] = [];
    const ports = {
      paintDumpEnabled: () => false,
      snapshotReady: () => true,
      requestFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
      snapshotPaint: () => calls.push("paint"),
      snapshotDataUrl: () => { calls.push("read"); return "data:image/png"; },
      dump: () => null,
      stats: () => null,
      scrollProbe: () => null,
      trailProbe: () => null,
      raiseProbe: () => null,
    } satisfies CanvasDiagnosticPorts;
    await expect(canvasSnapshot(ports)).resolves.toBe("data:image/png");
    expect(calls).toEqual(["paint", "read"]);
  });
});
