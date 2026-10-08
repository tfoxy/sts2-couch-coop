// Which playback path a viewer runs: today's main-thread engine, the dedicated Worker transport, or the
// Worker + AudioWorklet mixer. Pure resolution logic; audioEngine.ts runs the chosen path.
import { isRemoteHosted } from "@/join/hostBase";

export type AudioPath = "main" | "worker" | "worklet";

/**
 * Auto-selection is on: a secure page runs the worklet path, everything else the main-thread engine.
 * Set false to pin every viewer to the main-thread engine; `?audioPath=` overrides either way.
 */
export const AUDIO_PATH_AUTO_DEFAULT = true;

export interface ResolveAudioPathInput {
  search: string;
  isSecureContext: boolean;
  hasWorker: boolean;
  hasWorklet: boolean;
  remoteHosted: boolean;
  autoDefault?: boolean;
}

export interface ResolveAudioPathResult {
  path: AudioPath;
  requested: AudioPath | "auto";
  reason: string;
}

function parseRequested(search: string): AudioPath | "auto" {
  const raw = new URLSearchParams(search).get("audioPath");
  return raw === "main" || raw === "worker" || raw === "worklet" ? raw : "auto";
}

/**
 * The path auto-selection would pick, before the feature-availability cascade in `concretize` runs. Only the
 * worklet takes cue scheduling off the main thread; the worker path still schedules there and did not beat
 * the main-thread engine in combat on a phone, so it stays an explicit `?audioPath=worker` opt-in.
 */
function autoTarget(input: ResolveAudioPathInput): AudioPath {
  if (input.remoteHosted) return "main";
  if (input.isSecureContext && input.hasWorklet && input.hasWorker) return "worklet";
  return "main";
}

/**
 * Degrades a desired path to what the environment can actually run: `worklet` needs a secure context
 * AND `AudioWorkletNode` AND a `Worker` (the worker still owns the sockets in worklet mode); short of
 * that it falls back to `worker`, which itself needs `Worker` support or falls all the way back to `main`.
 */
function concretize(target: AudioPath, requested: AudioPath | "auto", input: ResolveAudioPathInput): ResolveAudioPathResult {
  let path = target;
  if (path === "worklet" && !(input.isSecureContext && input.hasWorklet && input.hasWorker)) path = "worker";
  if (path === "worker" && !input.hasWorker) path = "main";
  const reason = path === target
    ? (requested === "auto" ? "auto" : "requested")
    : (requested === "auto" ? "auto-fallback" : "degraded");
  return { path, requested, reason };
}

export function resolveAudioPath(input: ResolveAudioPathInput): ResolveAudioPathResult {
  const requested = parseRequested(input.search);
  if (requested !== "auto") return concretize(requested, requested, input);
  const autoDefault = input.autoDefault ?? AUDIO_PATH_AUTO_DEFAULT;
  if (!autoDefault) return { path: "main", requested, reason: "auto-default-disabled" };
  return concretize(autoTarget(input), requested, input);
}

/** `?audioCoalesce=1..4` — how many lane blocks the transport may batch before posting. Anything else is 2. */
export function resolveAudioCoalesce(search: string): number {
  const raw = new URLSearchParams(search).get("audioCoalesce");
  if (raw === null) return 2;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : 2;
}

export interface AudioPathEnv {
  search: string;
  isSecureContext: boolean;
  hasWorker: boolean;
  hasWorklet: boolean;
  remoteHosted: boolean;
}

/** Builds a `resolveAudioPath` input from the live page. Safe outside a browser — returns the inert default. */
export function detectAudioPathEnv(): AudioPathEnv {
  const win = typeof window === "undefined" ? undefined : window;
  if (!win) return { search: "", isSecureContext: false, hasWorker: false, hasWorklet: false, remoteHosted: false };
  return {
    search: win.location?.search ?? "",
    isSecureContext: !!win.isSecureContext,
    hasWorker: typeof win.Worker === "function",
    hasWorklet: typeof win.AudioWorkletNode === "function",
    remoteHosted: isRemoteHosted()
  };
}
