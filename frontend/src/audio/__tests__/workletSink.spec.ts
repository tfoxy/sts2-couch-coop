import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkletSink, mapWorkletDiag } from "../workletSink";
import type { AudioDiagEventWire, MainToWorklet } from "../audioSinkProtocol";

interface FakePort { onmessage: ((event: { data: unknown }) => void) | null; posted: unknown[]; transfers: unknown[][]; closed: boolean;
  postMessage(msg: unknown, transfer?: unknown[]): void; close(): void; }
const fakePort = (): FakePort => ({
  onmessage: null, posted: [], transfers: [], closed: false,
  postMessage(msg, transfer) { this.posted.push(msg); this.transfers.push(transfer ?? []); },
  close() { this.closed = true; }
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("mixer.worklet entry", () => {
  it("registers couch-mixer, attaches the worker port, renders both inputs and always returns true", async () => {
    const registered = new Map<string, new (options?: unknown) => { port: FakePort; process(i: unknown, o: Float32Array[][]): boolean }>();
    vi.stubGlobal("AudioWorkletProcessor", class { port = fakePort(); });
    vi.stubGlobal("registerProcessor", (name: string, ctor: never) => { registered.set(name, ctor); });
    vi.stubGlobal("sampleRate", 48_000);
    vi.stubGlobal("currentFrame", 0);
    vi.resetModules();
    await import("../mixer.worklet");
    const Processor = registered.get("couch-mixer")!;
    expect(Processor).toBeTypeOf("function");
    const proc = new Processor({ processorOptions: { diag: true } });
    const workerPort = fakePort();
    proc.port.onmessage!({ data: { kind: "init", workerPort } satisfies Omit<MainToWorklet, "workerPort"> & { workerPort: unknown } });
    expect(proc.port.posted).toEqual([{ kind: "ready" }]);

    const pcm = { format: "s16" as const, interleaved: new Int16Array(512).fill(16_384), channels: 2, frames: 256 };
    workerPort.onmessage!({ data: { kind: "load", epoch: 1, key: "w", pcm, rate: 48_000 } });
    workerPort.onmessage!({ data: { kind: "play", epoch: 1, key: "w", sourcePath: "cached", postMs: 0, gain: 1, pitch: 1 } });
    workerPort.onmessage!({ data: { kind: "ready" } }); // not a SinkCommand: ignored
    // Main-decoded TmpSfx arrives on the node port.
    proc.port.onmessage!({ data: { kind: "load", epoch: 1, key: "res://t.mp3", rate: 48_000,
      pcm: { format: "f32-planar", channels: [new Float32Array(256).fill(0.25)], frames: 256 } } });
    proc.port.onmessage!({ data: { kind: "play", epoch: 1, key: "res://t.mp3", sourcePath: "tmpsfx", postMs: 0, gain: 1, pitch: 1 } });
    const left = new Float32Array(128), right = new Float32Array(128);
    expect(proc.process([], [[left, right]])).toBe(true);
    expect(left[0]).toBe(0.75);
    expect(right[127]).toBe(0.75);

    proc.port.onmessage!({ data: { kind: "fence", epoch: 2 } });
    for (let q = 1; q < 40; q++) { vi.stubGlobal("currentFrame", q * 128); expect(proc.process([], [[left, right]])).toBe(true); }
    const diag = proc.port.posted.find(m => (m as { kind: string }).kind === "diag") as { events: AudioDiagEventWire[] } | undefined;
    expect(diag?.events.some(e => e.type === "source-scheduled" && e.sourcePath === "decoded-tmpsfx")).toBe(true);
    expect(proc.process([], [])).toBe(true); // no output bus: still alive
  });
});

describe("createWorkletSink", () => {
  const ctxWith = (audioWorklet: unknown): AudioContext =>
    ({ audioWorklet, destination: {}, currentTime: 0 }) as unknown as AudioContext;

  it("rejects outside a secure context", async () => {
    vi.stubGlobal("isSecureContext", false);
    const addModule = vi.fn();
    await expect(createWorkletSink(ctxWith({ addModule }), { moduleUrl: "x.js" })).rejects.toThrow(/secure context/);
    expect(addModule).not.toHaveBeenCalled();
  });

  it("rejects when the context has no audioWorklet, or the module fails to load", async () => {
    vi.stubGlobal("isSecureContext", true);
    await expect(createWorkletSink(ctxWith(undefined), { moduleUrl: "x.js" })).rejects.toThrow(/unavailable/);
    const node = vi.fn();
    vi.stubGlobal("AudioWorkletNode", node);
    await expect(createWorkletSink(ctxWith({ addModule: () => Promise.reject(new Error("404")) }), { moduleUrl: "x.js" }))
      .rejects.toThrow("404");
    expect(node).not.toHaveBeenCalled();
  });

  it("creates the node, hands the worker port over, resolves ready, maps diag times and disposes", async () => {
    vi.stubGlobal("isSecureContext", true);
    const created: Array<{ name: string; options: AudioWorkletNodeOptions; port: FakePort; connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>; onprocessorerror: unknown }> = [];
    vi.stubGlobal("AudioWorkletNode", class {
      port = fakePort(); connect = vi.fn(); disconnect = vi.fn(); onprocessorerror: unknown = null;
      constructor(_ctx: unknown, readonly name: string, readonly options: AudioWorkletNodeOptions) { created.push(this as never); }
    });
    const addModule = vi.fn(() => Promise.resolve());
    const ctx = { audioWorklet: { addModule }, destination: { id: "dest" }, currentTime: 2,
      getOutputTimestamp: () => ({ contextTime: 1.9, performanceTime: 1_000 }) } as unknown as AudioContext;
    const sink = await createWorkletSink(ctx, { diag: true, moduleUrl: "mixer.js" });
    expect(addModule).toHaveBeenCalledWith("mixer.js");
    const node = created[0];
    expect(node.name).toBe("couch-mixer");
    expect(node.options).toMatchObject({ numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { diag: true } });
    expect(node.connect).toHaveBeenCalledWith(ctx.destination);
    const init = node.port.posted[0] as { kind: string; workerPort: MessagePort };
    expect(init.kind).toBe("init");
    expect(node.port.transfers[0]).toEqual([init.workerPort]);
    expect(sink.workerPort).toBeInstanceOf(MessagePort);
    expect(sink.workerPort).not.toBe(init.workerPort);

    node.port.onmessage!({ data: { kind: "ready" } });
    await expect(sink.ready).resolves.toBeUndefined();

    vi.spyOn(performance, "now").mockReturnValue(5_000);
    const received: AudioDiagEventWire[][] = [];
    sink.onDiag = events => { received.push(events); };
    node.port.onmessage!({ data: { kind: "diag", voices: 1, lanes: 0, events: [
      { seq: 1, type: "worklet-receipt", performanceMs: Number.NaN, contextTime: 1.5 },
      { seq: 2, type: "source-scheduled", performanceMs: Number.NaN, contextTime: 1.5, scheduledContextTime: 1.6 }
    ] } });
    expect(received[0][0].performanceMs).toBeCloseTo(4_500, 6);
    expect(received[0][1]).toMatchObject({ outputTimestamp: { contextTime: 1.9, performanceTime: 1_000 } });
    expect(received[0][1].scheduledOutputMs as number).toBeCloseTo(700, 6);

    sink.post({ kind: "fence", epoch: 3 });
    expect(node.port.posted[1]).toEqual({ kind: "fence", epoch: 3 });
    sink.dispose();
    expect(node.disconnect).toHaveBeenCalled();
    expect(node.port.closed).toBe(true);
    sink.post({ kind: "fence", epoch: 4 });
    expect(node.port.posted).toHaveLength(2);
    init.workerPort.close();
  });

  it("loads the Vite-compiled worklet URL by default", async () => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("AudioWorkletNode", class { port = fakePort(); connect = vi.fn(); disconnect = vi.fn(); });
    const addModule = vi.fn((_url: string) => Promise.resolve());
    const sink = await createWorkletSink(ctxWith({ addModule }));
    expect(addModule.mock.calls[0][0]).toMatch(/mixer\.worklet\.ts\?worker_file/);
    sink.dispose();
  });

  it("rejects ready on a processor error", async () => {
    vi.stubGlobal("isSecureContext", true);
    let errorHandler: (() => void) | null = null;
    vi.stubGlobal("AudioWorkletNode", class {
      port = fakePort(); connect = vi.fn(); disconnect = vi.fn();
      set onprocessorerror(fn: (() => void) | null) { if (fn) errorHandler = fn; }
    });
    const sink = await createWorkletSink(ctxWith({ addModule: () => Promise.resolve() }), { moduleUrl: "m.js" });
    errorHandler!();
    await expect(sink.ready).rejects.toThrow(/processor error/);
    sink.dispose();
  });

  it("mapWorkletDiag leaves rows without a scheduled time unstamped", () => {
    const events = mapWorkletDiag({ currentTime: 1 }, [{ seq: 1, type: "worklet-receipt", performanceMs: 0, contextTime: 0.25 }], 100);
    expect(events[0].performanceMs).toBe(-650);
    expect(events[0].outputTimestamp).toBeUndefined();
  });
});
