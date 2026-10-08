// Dedicated audio Worker entry. Nothing but the explicit installer call — see `installAudioTransportWorker`
// for why initialization must not be a side-effect-only import. Spawned by audioEngine.ts with Vite's
// literal `new Worker(new URL("./audioTransport.worker.ts", import.meta.url), { type: "module" })`.
import { installAudioTransportWorker, type AudioTransportWorkerScope } from "./audioTransportCore";

installAudioTransportWorker(self as unknown as AudioTransportWorkerScope);
