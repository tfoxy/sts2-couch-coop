import { describe, expect, it } from "vitest";
import { AUDIO_PATH_AUTO_DEFAULT, detectAudioPathEnv, resolveAudioCoalesce, resolveAudioPath, type ResolveAudioPathInput } from "../audioPath";

const BASE: ResolveAudioPathInput = { search: "", isSecureContext: true, hasWorker: true, hasWorklet: true, remoteHosted: false };

describe("resolveAudioPath", () => {
  it("ships with auto on: a secure page gets the worklet, a plain-HTTP page the main-thread engine", () => {
    expect(AUDIO_PATH_AUTO_DEFAULT).toBe(true);
    expect(resolveAudioPath(BASE)).toMatchObject({ path: "worklet", requested: "auto", reason: "auto" });
    expect(resolveAudioPath({ ...BASE, isSecureContext: false })).toMatchObject({ path: "main", requested: "auto" });
  });

  it("pins every viewer to main when the auto default is switched off", () => {
    expect(resolveAudioPath({ ...BASE, autoDefault: false })).toMatchObject({ path: "main", reason: "auto-default-disabled" });
  });

  it("honours an explicit ?audioPath override when the environment can meet it", () => {
    expect(resolveAudioPath({ ...BASE, search: "?audioPath=worker" }).path).toBe("worker");
    expect(resolveAudioPath({ ...BASE, search: "?audioPath=worklet" }).path).toBe("worklet");
    expect(resolveAudioPath({ ...BASE, search: "?audioPath=main" }).path).toBe("main");
  });

  it("ignores an unknown ?audioPath value and treats it as auto", () => {
    expect(resolveAudioPath({ ...BASE, search: "?audioPath=bogus" }).requested).toBe("auto");
  });

  it("degrades a worklet request to worker when insecure or unavailable", () => {
    expect(resolveAudioPath({ ...BASE, search: "?audioPath=worklet", isSecureContext: false }).path).toBe("worker");
    expect(resolveAudioPath({ ...BASE, search: "?audioPath=worklet", hasWorklet: false }).path).toBe("worker");
  });

  it("degrades a worklet or worker request all the way to main without a Worker", () => {
    expect(resolveAudioPath({ ...BASE, search: "?audioPath=worklet", hasWorker: false }).path).toBe("main");
    expect(resolveAudioPath({ ...BASE, search: "?audioPath=worker", hasWorker: false }).path).toBe("main");
  });

  it("auto picks the worklet only when it can run, otherwise main; the worker path is opt-in", () => {
    expect(resolveAudioPath({ ...BASE, autoDefault: true }).path).toBe("worklet");
    expect(resolveAudioPath({ ...BASE, autoDefault: true, remoteHosted: true }).path).toBe("main");
    expect(resolveAudioPath({ ...BASE, autoDefault: true, hasWorklet: false }).path).toBe("main");
    expect(resolveAudioPath({ ...BASE, autoDefault: true, hasWorker: false }).path).toBe("main");
    expect(resolveAudioPath({ ...BASE, autoDefault: true, isSecureContext: false }).path).toBe("main");
  });

  it("clamps audioCoalesce to 1..4, defaulting invalid/out-of-range input to 2", () => {
    expect(resolveAudioCoalesce("")).toBe(2);
    expect(resolveAudioCoalesce("?audioCoalesce=1")).toBe(1);
    expect(resolveAudioCoalesce("?audioCoalesce=4")).toBe(4);
    expect(resolveAudioCoalesce("?audioCoalesce=9")).toBe(2);
    expect(resolveAudioCoalesce("?audioCoalesce=0")).toBe(2);
    expect(resolveAudioCoalesce("?audioCoalesce=nope")).toBe(2);
  });

  it("detects an environment shape without throwing under jsdom", () => {
    const env = detectAudioPathEnv();
    expect(typeof env.search).toBe("string");
    expect(typeof env.isSecureContext).toBe("boolean");
    expect(typeof env.hasWorker).toBe("boolean");
    expect(typeof env.hasWorklet).toBe("boolean");
    expect(typeof env.remoteHosted).toBe("boolean");
  });
});
