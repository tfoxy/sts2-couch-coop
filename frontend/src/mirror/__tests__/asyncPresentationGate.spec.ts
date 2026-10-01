import { describe, expect, it, vi } from "vitest";
import { createAsyncPresentationGate } from "@/mirror/renderer/pixi/asyncPresentationGate";

describe("async presentation commit gate", () => {
  it("commits a delayed success only while its ticket is current", async () => {
    const gate = createAsyncPresentationGate();
    const commit = vi.fn();
    const ticket = gate.begin(4);
    let resolve!: (presented: boolean) => void;
    const presentation = new Promise<boolean>((done) => { resolve = done; });
    const done = presentation.then((presented) => {
      if (presented && gate.current(ticket)) commit(ticket.revision);
    });
    expect(commit).not.toHaveBeenCalled();
    resolve(true);
    await done;
    expect(commit).toHaveBeenCalledWith(4);
  });

  it("keeps the previous picture for rejection, stale completion, and disposal", async () => {
    const gate = createAsyncPresentationGate();
    const commit = vi.fn();
    const failure = vi.fn();
    const rejected = gate.begin(7);
    await Promise.reject(new Error("surface validation failed")).catch((error) => {
      if (gate.current(rejected)) failure(error.message);
    });
    expect(failure).toHaveBeenCalledWith("surface validation failed");
    const old = gate.begin(8);
    const newer = gate.begin(9);
    const finish = (ticket: ReturnType<typeof gate.begin>, presented: boolean) => {
      if (presented && gate.current(ticket)) commit(ticket.revision);
    };
    finish(old, true);
    finish(newer, false);
    expect(commit).not.toHaveBeenCalled();
    const latest = gate.begin(10);
    gate.dispose();
    finish(latest, true);
    expect(commit).not.toHaveBeenCalled();
    expect(gate.current(latest)).toBe(false);
  });
});
