// Main-thread handle for the AudioWorklet mixer (WP-B): loads `mixer.worklet.ts`, creates the
// "couch-mixer" AudioWorkletNode, and hands the facade a MessagePort the audio Worker posts `SinkCommand`s
// down directly, so no per-cue or per-block work touches the main thread.
//
// DIAG TIME MAPPING. The worklet stamps rows with context time only (it has no `performance`). On arrival
// the main thread maps them:
//   * `performanceMs` — when the RENDER clock was at the row's `contextTime`:
//       performance.now() - (ctx.currentTime - contextTime) * 1000
//     i.e. "when the audio thread handled it", comparable with main/worker `performanceMs` stamps (each
//     side keeps its own `seq`; rows carry `source: "worklet"`).
//   * for rows with a `scheduledContextTime`, `outputTimestamp` ({contextTime, performanceTime} from
//     `ctx.getOutputTimestamp()`, the same shape audioEngine.ts records) and `scheduledOutputMs`:
//       stamp.performanceTime + (scheduledContextTime - stamp.contextTime) * 1000
//     i.e. when that first sample is predicted to leave the speaker.
import type { AudioDiagEventWire, AudioDiagPayload, MainToWorklet, WorkletToMain } from "./audioSinkProtocol";

export interface WorkletSinkHandle {
  workerPort: MessagePort;
  post(msg: MainToWorklet, transfer?: Transferable[]): void;
  dispose(): void;
  /** Receives worklet diag rows (when diag is on, see `WorkletSinkOptions.diag`), `performanceMs` already mapped. */
  onDiag?: ((events: AudioDiagEventWire[], payload: AudioDiagPayload) => void) | null;
  /** Resolves once the processor has attached the worker port; rejects on a processor error. */
  ready?: Promise<void>;
}

export interface WorkletSinkOptions {
  /** Record worklet diag rows. Default: the page's `?audioDiag=1`, the flag the facade's diag ring uses. */
  diag?: boolean;
  /** Test seam: the worklet module URL. Defaults to the Vite-compiled `mixer.worklet.ts`. */
  moduleUrl?: string;
}

function audioDiagRequested(): boolean {
  return new URLSearchParams(globalThis.location?.search ?? "").get("audioDiag") === "1";
}

async function mixerModuleUrl(): Promise<string> {
  // `?worker&url` makes Vite bundle the worklet (and mixerCore/laneJitterBuffer/audioWire) into one
  // compiled, import-free script and return its URL; `new URL("./mixer.worklet.ts", import.meta.url)`
  // would emit the raw .ts.
  return (await import("./mixer.worklet.ts?worker&url")).default;
}

export function mapWorkletDiag(ctx: Pick<AudioContext, "currentTime"> & { getOutputTimestamp?: () => AudioTimestamp },
  events: AudioDiagEventWire[], nowMs = performance.now()): AudioDiagEventWire[] {
  const stamp = ctx.getOutputTimestamp?.() ?? null;
  const contextNow = ctx.currentTime;
  for (const ev of events) {
    const contextTime = typeof ev.contextTime === "number" ? ev.contextTime : contextNow;
    ev.performanceMs = nowMs - (contextNow - contextTime) * 1000;
    if (typeof ev.scheduledContextTime === "number" && stamp &&
        typeof stamp.contextTime === "number" && typeof stamp.performanceTime === "number") {
      ev.outputTimestamp = { contextTime: stamp.contextTime, performanceTime: stamp.performanceTime };
      ev.scheduledOutputMs = stamp.performanceTime + (ev.scheduledContextTime - stamp.contextTime) * 1000;
    }
  }
  return events;
}

/**
 * Rejects — so the facade falls back to the worker->main-sink path — when the page is not a secure context
 * (`audioWorklet` is SecureContext-only), the context has no `audioWorklet`, or the module fails to load.
 */
export async function createWorkletSink(ctx: AudioContext, opts: WorkletSinkOptions = {}): Promise<WorkletSinkHandle> {
  if ((globalThis as { isSecureContext?: boolean }).isSecureContext !== true) throw new Error("worklet sink needs a secure context");
  if (!ctx.audioWorklet || typeof ctx.audioWorklet.addModule !== "function") throw new Error("AudioWorklet unavailable");
  const url = opts.moduleUrl ?? await mixerModuleUrl();
  await ctx.audioWorklet.addModule(url);
  const node = new AudioWorkletNode(ctx, "couch-mixer", {
    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    processorOptions: { diag: opts.diag ?? audioDiagRequested() }
  });
  node.connect(ctx.destination);
  const channel = new MessageChannel();
  let disposed = false;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => { /* observed by whoever awaits `ready`; never an unhandled rejection */ });
  const handle: WorkletSinkHandle = {
    workerPort: channel.port1,
    post(msg, transfer) { if (!disposed) node.port.postMessage(msg, transfer ?? []); },
    dispose() {
      if (disposed) return;
      disposed = true;
      node.port.onmessage = null;
      node.onprocessorerror = null;
      try { node.disconnect(); } catch { /* already disconnected */ }
      node.port.close();
      channel.port1.close(); // a no-op once port1 has been transferred to the worker
      rejectReady(new Error("worklet sink disposed"));
    },
    onDiag: null,
    ready
  };
  node.onprocessorerror = () => rejectReady(new Error("couch-mixer processor error"));
  node.port.onmessage = (event: MessageEvent<WorkletToMain>) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.kind === "ready") resolveReady();
    else if (msg.kind === "diag" && handle.onDiag) {
      const { kind: _kind, ...payload } = msg;
      handle.onDiag(mapWorkletDiag(ctx, payload.events), payload);
    }
  };
  const init: MainToWorklet = { kind: "init", workerPort: channel.port2 };
  node.port.postMessage(init, [channel.port2]);
  return handle;
}
