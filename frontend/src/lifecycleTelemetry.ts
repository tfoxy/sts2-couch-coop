// Harness-only lifecycle receipts. No meta tag means this module is inert in the shipped browser server.
// Callers pass enums, counters and dimensions only; there is deliberately no free-form message field.
type SocketRole = "host" | "seat";
type EventInput =
  | { kind: "lifecycle"; state: "load" | "pageshow" | "pagehide" }
  | { kind: "visibility"; state: "visible" | "hidden" }
  | { kind: "viewport"; width: number; height: number }
  | { kind: "orientation"; state: "portrait" | "landscape" }
  | { kind: "fullscreen"; active: boolean }
  | { kind: "ws-open"; role: SocketRole }
  | { kind: "ws-error"; role: SocketRole; category: "transport" }
  | { kind: "ws-close"; role: SocketRole; code?: number; clean?: boolean }
  | { kind: "error"; category: "runtime" | "exception" | "transport" | "render" }
  | { kind: "scene-received" | "render-begin" | "frame-presented" | "ack-sent"; ordinal: number };
type WireEvent = EventInput & { t: number };

interface Config { endpoint: string; nonce: string }
let config: Config | null = null;
let started = 0;
let queue: WireEvent[] = [];
let scheduled = false;
let sceneOrdinal = 0;
let checkpointStage = 0;

function readConfig(): Config | null {
  try {
    const raw = document.querySelector('meta[name="couchcoop-lifecycle"]')?.getAttribute("content");
    if (!raw) return null;
    const value = JSON.parse(atob(raw)) as Config;
    return typeof value.endpoint === "string"
      && /^\/[A-Za-z0-9/_-]+$/.test(value.endpoint)
      && /^[0-9a-f]{32}$/.test(value.nonce)
      ? value
      : null;
  } catch {
    return null;
  }
}

function flush(): void {
  scheduled = false;
  if (!config || queue.length === 0) return;
  const events = queue.splice(0, 32);
  void fetch(config.endpoint, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce: config.nonce, events }),
    keepalive: true
  }).catch(() => {});
}

/** Record one schema-bound event. No caller can pass a URL, name, payload, stack, token or arbitrary message. */
export function lifecycleEvent(event: EventInput): void {
  if (!config) return;
  queue.push({ ...event, t: Math.max(0, Math.round(performance.now() - started)) });
  if (queue.length >= 32) return flush();
  if (!scheduled) {
    scheduled = true;
    setTimeout(flush, 100);
  }
}

export function lifecycleSocketRole(explicitUrl: boolean): SocketRole {
  return explicitUrl ? "seat" : "host";
}

/** The nonce may ride to the two synthetic WebSockets for server-side ordinal correlation; it is never logged. */
export function lifecycleVisitNonce(): string | null {
  return config?.nonce ?? readConfig()?.nonce ?? null;
}

export function sceneCheckpoint(kind: "scene-received" | "render-begin" | "frame-presented" | "ack-sent"): void {
  const stage = kind === "scene-received" ? 1 : kind === "render-begin" ? 2 : kind === "frame-presented" ? 3 : 4;
  if (stage === 1) {
    sceneOrdinal++;
    checkpointStage = 1;
    lifecycleEvent({ kind, ordinal: sceneOrdinal });
    return;
  }
  if (sceneOrdinal > 0 && stage === checkpointStage + 1) {
    checkpointStage = stage;
    lifecycleEvent({ kind, ordinal: sceneOrdinal });
  }
}

export function installLifecycleTelemetry(): void {
  config = readConfig();
  if (!config) return;
  started = performance.now();
  lifecycleEvent({ kind: "lifecycle", state: "load" });
  const visibility = () => lifecycleEvent({
    kind: "visibility",
    state: document.visibilityState === "visible" ? "visible" : "hidden"
  });
  const viewport = () => lifecycleEvent({
    kind: "viewport",
    width: Math.max(1, Math.round(innerWidth)),
    height: Math.max(1, Math.round(innerHeight))
  });
  const orientation = () => lifecycleEvent({
    kind: "orientation",
    state: innerWidth >= innerHeight ? "landscape" : "portrait"
  });
  document.addEventListener("visibilitychange", visibility);
  addEventListener("pageshow", () => lifecycleEvent({ kind: "lifecycle", state: "pageshow" }));
  addEventListener("pagehide", () => {
    lifecycleEvent({ kind: "lifecycle", state: "pagehide" });
    flush();
  });
  addEventListener("error", () => lifecycleEvent({ kind: "error", category: "runtime" }));
  addEventListener("unhandledrejection", () => lifecycleEvent({ kind: "error", category: "exception" }));
  addEventListener("resize", () => { viewport(); orientation(); });
  addEventListener("orientationchange", orientation);
  document.addEventListener("fullscreenchange", () => lifecycleEvent({
    kind: "fullscreen",
    active: document.fullscreenElement !== null
  }));
  visibility();
  viewport();
  orientation();
  lifecycleEvent({ kind: "fullscreen", active: document.fullscreenElement !== null });
}
