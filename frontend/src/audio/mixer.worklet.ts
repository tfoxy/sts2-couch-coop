// AudioWorkletGlobalScope entry for the CouchCoop mixer (WP-B). Loaded by `workletSink.ts` through Vite's
// `?worker&url`, which bundles this file and everything it imports into ONE self-contained script — a
// worklet module must not depend on chunks the worklet scope would have to fetch.
//
// Two command inputs feed the same `MixerCore`:
//   * `this.port` (main thread, `MainToWorklet`): `init { workerPort }`, `fence`, and main-decoded TmpSfx
//     `load`/`play`.
//   * the worker port handed over in `init` (the audio Worker, bare `SinkCommand`s).
// Output to main over `this.port` (`WorkletToMain`): `ready` once the worker port is attached, and `diag`
// batches at most every ~100 ms of rendered audio when the node was created with `processorOptions.diag`.
import { MixerCore } from "./mixerCore";
import { isSinkCommand, type MainToWorklet, type WorkletToMain } from "./audioSinkProtocol";

// AudioWorkletGlobalScope members. Declared locally (module scope, type-only) rather than adding the
// "AudioWorklet" lib to the app's tsconfig, which would leak worklet globals into every DOM file.
declare const sampleRate: number;
declare const currentFrame: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
}
declare function registerProcessor(name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor): void;

class CouchMixerProcessor extends AudioWorkletProcessor {
  private readonly core: MixerCore;
  private workerPort: MessagePort | null = null;
  /** Right-channel scratch for a mono output (never expected: the node asks for outputChannelCount [2]). */
  private readonly scratch = new Float32Array(128);

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    const diag = !!(options?.processorOptions as { diag?: boolean } | undefined)?.diag;
    this.core = new MixerCore({ sampleRate, diag, startFrame: currentFrame });
    this.port.onmessage = (event: MessageEvent<MainToWorklet>) => this.onMain(event.data);
  }

  private onMain(msg: MainToWorklet): void {
    if (msg && typeof msg === "object" && msg.kind === "init") {
      if (this.workerPort) this.workerPort.onmessage = null;
      this.workerPort = msg.workerPort ?? null;
      if (this.workerPort) this.workerPort.onmessage = (event: MessageEvent<unknown>) => this.core.handle(event.data);
      const ready: WorkletToMain = { kind: "ready" };
      this.port.postMessage(ready);
      return;
    }
    if (isSinkCommand(msg)) this.core.handle(msg);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (out && out.length > 0) {
      const left = out[0];
      const right = out.length > 1 ? out[1] : this.scratch;
      this.core.render(left, right, left.length, currentFrame);
    }
    if (this.core.diagDue()) {
      const msg: WorkletToMain = { kind: "diag", ...this.core.drainDiag() };
      this.port.postMessage(msg);
    }
    return true; // keep the processor (and the keep-alive DC) alive for the node's whole life
  }
}

registerProcessor("couch-mixer", CouchMixerProcessor);
