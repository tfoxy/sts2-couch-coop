// Wire contract between the main thread, the audio Worker, and the AudioWorklet mixer (WP-0).
//
// TYPES ONLY, plus two tiny runtime guards. This file must load unchanged in three different global
// scopes — Window, DedicatedWorkerGlobalScope, AudioWorkletGlobalScope — so it imports nothing that
// only exists in one of them. The `MessagePort`/`Transferable` type references below are fine: they
// come from the project's "DOM" lib and are type-only here, never a runtime global lookup.
//
// EPOCH / FENCE. Every `SinkCommand` carries `epoch: number`. A receiver tracks the newest epoch it has
// seen (bumped by a `fence` command or a `start`/`seat` control message) and drops anything older — the
// same "stale seat switch" guard `audioEngine.ts` already does with `seatEpoch`, just numeric so a
// worklet processor (no bigint, no Promises) can apply it too. Control-plane messages that are not tied
// to a seat session (`init`, `port`, `probe-clock`, `asset-token`, `dispose`) do not carry an epoch.
//
// SINK WRAPPING CHOICE. In "post" mode the worker reaches the main-thread sink through the ordinary
// worker->main message channel, which also carries non-sink control messages (`ready`, `diag`, …). In
// "port" mode the worker posts the SAME `SinkCommand` values straight down a transferred `MessagePort`
// to the worklet, with nothing else on that channel. Rather than duplicate every `SinkCommand` member
// into `WorkerToMain` (and have two shapes drift), `WorkerToMain` wraps them once as `{ kind: "sink", cmd
// }`; the worklet channel carries `SinkCommand` values unwrapped. `isSinkCommand` below narrows either
// side's raw message back to `SinkCommand` when a handler needs to tell the two apart.
//
// `seatTUs` IS A STRING. It is a correlation id for diagnostics only (see `audioEngine.ts`'s
// `recordDiagnostic` calls) — nothing schedules playback from it — so it is carried as an opaque string
// rather than implying it is safe to do float math on across a structured-clone boundary.

export type AudioSinkMode = "post" | "port";
export type AudioSinkPcmFormat = "f32-planar" | "s16";
export type SinkSourcePath = "cached" | "http-take" | "tmpsfx";

/** Decoded PCM payload carried on a `SinkCommand`. One of the two shapes the sink/worklet understands. */
export type SinkPcm =
  | { format: "f32-planar"; channels: Float32Array[]; frames: number }
  | { format: "s16"; interleaved: Int16Array; channels: number; frames: number };

/**
 * The parameters needed to start a voice, shared between a direct `play`/`take-start` command and the
 * `tmpsfx-decode` request that asks Main to decode a TmpSfx file the worker cannot decode itself.
 * Field names match `audioEngine.ts`'s existing diagnostic fields (`gain`, `pitch`, `seatTUs`,
 * `requestOrder` -> `order`, `seatConnectionId` -> `seatConnId`).
 */
export interface SinkCueParams {
  gain: number;
  pitch: number;
  seatTUs?: string;
  order?: number;
  seatConnId?: number;
}

/** One block inside a `lane-blocks` command. `lane` reuses the numbering `AudioLane` assigns in audioWire.ts. */
export interface SinkLaneBlock {
  lane: number;
  streamId: number;
  blockIndex: number;
  dueUs: number;
  flags: number;
  pcm: SinkPcm;
}

/**
 * Worker -> MainSink (wrapped in `WorkerToMain` as `{ kind: "sink", cmd }` in "post" mode) or
 * Worker -> worklet mixer (sent bare over the transferred port in "port" mode). Every member carries
 * `epoch`; see the EPOCH / FENCE note above.
 */
/** Diagnostics label each sink reports in `source-scheduled.sourcePath`, matching mainEngine's labels. */
export const SINK_DIAG_SOURCE_PATH: Readonly<Record<SinkSourcePath, string>> =
  { cached: "decoded-cache", "http-take": "http-take", tmpsfx: "decoded-tmpsfx" };

export type SinkCommand =
  | { kind: "load"; epoch: number; key: string; pcm: SinkPcm; rate: number }
  | ({ kind: "play"; epoch: number; key: string; sourcePath: SinkSourcePath; postMs: number;
      /** Diagnostics-only label override (main-decoded TmpSfx: first decode vs resident). */
      diagSourcePath?: string } & SinkCueParams)
  | ({ kind: "take-start"; epoch: number; streamId: number; key: string; postMs: number } & SinkCueParams)
  | { kind: "take-block"; epoch: number; streamId: number; blockIndex: number; flags: number; pcm: SinkPcm; postMs: number }
  | { kind: "lane-blocks"; epoch: number; blocks: SinkLaneBlock[]; postMs: number }
  | { kind: "lane-gains"; epoch: number; music: number; ambience: number; loops: number }
  | { kind: "lane-stop"; epoch: number; lane: number }
  | { kind: "fence"; epoch: number };

/** A diagnostic event as it crosses a postMessage boundary — the wire form of `audioEngine.ts`'s `recordDiagnostic` rows. */
export interface AudioDiagEventWire extends Record<string, unknown> {
  seq: number;
  type: string;
  performanceMs: number;
}

export interface AudioDiagPayload {
  events: AudioDiagEventWire[];
  voices?: number;
  lanes?: number;
  /** Rows the sender's bounded ring overwrote since its previous payload (the worklet's diag ring). */
  lost?: number;
}

/** Main -> Worker. */
export type MainToWorker =
  | {
      kind: "init"; mainTimeOrigin: number; diag: boolean; hostBase: string; assetToken: string;
      indexUrl: string; renderUrl: string; sinkMode: AudioSinkMode; pcm: AudioSinkPcmFormat; coalesce: number;
    }
  /** Transfers the worklet-bound port; receiving it resets the worker's "already loaded in sink" key set. */
  | { kind: "port"; port: MessagePort; sampleRate: number }
  | { kind: "start"; epoch: number; seatUrl: string }
  | { kind: "seat"; epoch: number; seatUrl: string }
  | { kind: "stop"; epoch: number }
  | { kind: "probe-clock" }
  | { kind: "asset-token"; token: string }
  | { kind: "tmpsfx-resident"; epoch: number; path: string }
  | { kind: "tmpsfx-failed"; epoch: number; path: string }
  | { kind: "dispose" };

/** Worker -> Main. */
export type WorkerToMain =
  | { kind: "ready" }
  | { kind: "unavailable"; epoch: number }
  | { kind: "fallback"; reason: string }
  | { kind: "tmpsfx-decode"; epoch: number; path: string; url: string; cue: SinkCueParams }
  | ({ kind: "diag" } & AudioDiagPayload)
  | { kind: "sink"; cmd: SinkCommand };

/** Main -> worklet mixer, over `node.port`. The `load`/`play` members are for main-decoded TmpSfx. */
export type MainToWorklet =
  | { kind: "init"; workerPort: MessagePort }
  | { kind: "fence"; epoch: number }
  | Extract<SinkCommand, { kind: "load" | "play" }>;

/** Worklet mixer -> Main. */
export type WorkletToMain =
  | ({ kind: "diag" } & AudioDiagPayload)
  | { kind: "ready" };

const SINK_COMMAND_KINDS: ReadonlySet<SinkCommand["kind"]> = new Set([
  "load", "play", "take-start", "take-block", "lane-blocks", "lane-gains", "lane-stop", "fence"
]);

/** Narrows a raw message on a channel that may carry either a wrapper and a `SinkCommand` (see the file header). */
export function isSinkCommand(value: unknown): value is SinkCommand {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" && SINK_COMMAND_KINDS.has(kind as SinkCommand["kind"]);
}

/** Whether `epoch` is older than the newest fence/epoch a receiver has observed — the stale-seat guard. */
export function isStaleEpoch(epoch: number, newestEpoch: number): boolean {
  return epoch < newestEpoch;
}

function pcmBuffers(pcm: SinkPcm, into: Set<ArrayBuffer>): void {
  if (pcm.format === "f32-planar") {
    for (const channel of pcm.channels) into.add(channel.buffer as ArrayBuffer);
  } else {
    into.add(pcm.interleaved.buffer as ArrayBuffer);
  }
}

/** Collects the underlying `ArrayBuffer`s a `SinkCommand` carries, deduped, for a transfer-list `postMessage`. */
export function sinkCommandTransferables(cmd: SinkCommand): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  if (cmd.kind === "load" || cmd.kind === "take-block") pcmBuffers(cmd.pcm, buffers);
  else if (cmd.kind === "lane-blocks") for (const block of cmd.blocks) pcmBuffers(block.pcm, buffers);
  return [...buffers];
}
