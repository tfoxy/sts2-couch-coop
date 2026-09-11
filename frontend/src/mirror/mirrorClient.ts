import {
  applySceneDelta,
  createMirrorState,
  parseSceneDelta,
  type MirrorState
} from "@/mirror/sceneTree";
import {
  HEADLESS_HOST_DISCONNECTED_REASON,
  parseBrowserEnvelopeValue,
  type BrowserSessionEnvelope
} from "@/protocol/browserEnvelope";
import type { MirrorActionMessage } from "@/mirror/mapNodeTap";
import { reproRecorder } from "@/mirror/reproRecorder";
import { hostWsUrl } from "@/join/hostBase";

// Standalone client for the live-tree MIRROR. Opens its own `/ws` connection and renders off `scene-delta`
// messages; it also parses the `session` envelope to drive the join screen — roster + run-vs-lobby — so the
// client needs only `session` + `scene-delta`. Maintains the
// RETAINED node map (applying deltas in place) and bumps `state.revision` so the renderer recomputes.

export type MirrorClientStatus = "connecting" | "connected" | "disconnected";

// Upstream raw-input replay this (controlling) client sends to the host. Pointer input is COORDINATE-ONLY: a
// design-space (1920x1080) `coordX/coordY` the game hit-tests natively (the mirror resolves it through the visual
// -anchor map — see inputCapture/pointerMap). Keyboard carries a browser `KeyboardEvent.code` in `key` (+
// comma-separated `modifiers`, `pressed`: down/up, omitted = a tap). Mirrors the host's BrowserInputRequestEnvelope
// (which still ALSO accepts `elementId`/offset for the spirectl CLI — the mirror client just never sends them).
export interface MirrorInputMessage {
  kind: "hover" | "click" | "key";
  button?: "left" | "right" | "middle" | "wheel-up" | "wheel-down";
  coordX?: number;
  coordY?: number;
  key?: string;
  modifiers?: string;
  pressed?: boolean;
  // R10 WS-E — COALESCED WHEEL TICKS. How many identical notches this ONE message stands for. The eager-scroll
  // wheel path folds every notch accumulated within an animation frame into a single send (the host injects one
  // queued input per game-thread turn, so a per-notch message stream arrives as a visible trickle). Only ever set
  // on a full `wheel-up`/`wheel-down` click, and OMITTED (not 1) for a single tick, so an un-coalesced wheel event
  // serialises byte-identically to the pre-feature wire. The host clamps 1..20.
  count?: number;
}

// The semantic action a mirror viewer uses to park a scrollable surface at an absolute offset.
export const SET_SCROLL_OFFSET_ACTION_ID = "set-scroll-offset";
export const SCROLL_ELEMENT_ID_ARG = "elementId";
export const SCROLL_OFFSET_ARG = "offsetY";

// The host's answer to one absolute-scroll send: the offset the game's own limits CLAMPED the request to. This is
// the fact a client leading the scroll locally cannot derive for itself — its own limit formula is an approximation
// of the game's, and the game's clamp is elastic where the client's is hard — so it is what the eager-scroll settle
// uses to tell "the game refused this travel" from "the game moved this surface itself".
//
// `requestId` is the id of the send it answers. The eager engine keeps the id of its LATEST send per surface and
// ignores anything else, so a throttled gesture's earlier acks (which are, by then, stale statements about a
// position the player has already scrolled past) can never steer the settle.
export interface MirrorScrollAck {
  requestId: string;
  // The clamped, authoritative offset — the container-local Y the game is now heading to.
  offsetY: number;
  // What we asked for, echoed. Equal to `offsetY` unless the game clamped; carried for diagnostics only.
  requestedY: number | null;
  // "map" | "grid" — which surface kind answered. Diagnostics only; the requestId already identifies the send.
  surface: string | null;
}

// Rolling round-trip latency, measured by a `ping`→`pong` echo. TWO buckets, from TWO ping variants sent on the
// same probe tick:
//   NETWORK RTT — the plain `{type:"ping"}` the host answers immediately from its send loop (real congestion).
//     Kept as the FLAT `lastMs`/`p50`/`p95`/`count` fields (backward-compatible with scripts/measure-latency.mjs
//     and the `?latency=1` overlay).
//   GAME end-to-end — the `{type:"ping", mainThread:true}` the server answers from the game's MAIN THREAD, so its
//     RTT folds in the game's per-frame processing delay (governed by the refresh rate). Reported in the `game*`
//     fields; stays empty (`gameCount` 0) until/unless the server answers main-thread pings.
// Populated only while a probe is running (`pingIntervalMs` > 0 or `setPingInterval` started it); otherwise it
// stays at zero samples.
export interface MirrorLatency {
  lastMs: number | null;
  p50: number | null;
  p95: number | null;
  count: number;
  gameLastMs: number | null;
  gameP50: number | null;
  gameP95: number | null;
  gameCount: number;
}

// A fresh zero-sample latency snapshot (both buckets empty). Exported so the app can seed its display ref.
export function emptyMirrorLatency(): MirrorLatency {
  return {
    lastMs: null,
    p50: null,
    p95: null,
    count: 0,
    gameLastMs: null,
    gameP50: null,
    gameP95: null,
    gameCount: 0
  };
}

// The SERVER-side settings the panel controls, sent over the `settings` control channel. Every optional field is
// a partial update: an omitted field leaves the server-side connection state unchanged. Client-only render toggles
// (shaders/particles) are NOT here — those apply purely in the browser and never touch the game.
export interface MirrorSettingsPayload {
  refreshRate?: number;
  freezeParticles?: boolean;
  freezeSpines?: boolean;
  freezeDecor?: boolean;
  tweenReplay?: boolean;
  // Stage-B walk skip: this viewer's EFFECTIVE "Static background" state (setting AND the image actually shows —
  // the fetch/decode fail-open folds in as false). Per-connection unanimity input on the host: the combat bg
  // subtree is skipped from the producer walk only while EVERY streaming mirror connection reports true. C# twin:
  // BrowserSettingsRequestEnvelope.StaticBg.
  staticBg?: boolean;
  // R14: this viewer's TRAIL-DRIVE capability (it places the card-flight trail root from the declarative flight
  // hint). It is a capability rather than a preference. C# twin: BrowserSettingsRequestEnvelope.TrailDrive.
  trailDrive?: boolean;
}

export interface MirrorClient {
  status: MirrorClientStatus;
  state: MirrorState;
  latency: MirrorLatency;
  // The latest `session` envelope from this connection (roster + screen kind + this viewer's assignment),
  // used by the shared join screen. Null until the first session arrives. The redirect-bearing join reply
  // (carrying `headlessMirrorPort`) also updates this, but by then the app has already redirected + joined.
  session: BrowserSessionEnvelope | null;
  // Send an upstream input message (no-op when the socket isn't open). Fire-and-forget: the host replies only
  // on error, which this receive-only client ignores.
  sendInput(message: MirrorInputMessage): void;
  // R11 WS-M — send a SEMANTIC action (`{type:"action"}`). The mirror
  // drives the game with raw input, with narrow exceptions for controls whose synthetic coordinate click is a
  // no-op: map points route through `select-map-node`, and reward-list rows through `claim-reward`. No viewer id is
  // sent: the host takes the acting seat from THIS connection (a joined seat's
  // socket is its own headless game; a direct-view socket is the host's game). Fire-and-forget — the host answers
  // with an `action-result` this client ignores (a refused vote simply doesn't travel, as a dead click didn't).
  //
  // R19 WP5: returns the `requestId` the send went out under, or null when the socket was not open. Every caller
  // but one throws it away; scroll authority needs it, because the absolute-scroll ack is only meaningful when it
  // can be matched to the send it answers (see MirrorScrollAck).
  sendAction(message: MirrorActionMessage): string | null;
  // Flow control: the renderer calls this after rendering a frame so the host releases the next (coalesced)
  // scene delta. This paces the stream to the device's real frame rate — the fix for the slow-client runaway.
  // No-op while the stream gate is off (nothing was rendered, so there is no frame to credit).
  sendSceneAck(): void;
  // WS-B STREAM GATE. Turn the host's `scene-delta` stream on/off for THIS connection without reconnecting.
  // OFF: the host sends nothing at all and this client applies nothing (a viewer sitting on the join picker must
  // not pull — or render — a multiplayer host's game in the background). ON: the host replies with a fresh FULL
  // keyframe. The INITIAL value rides the connect URL (`?watch=0`) because only that can suppress the host's
  // connect-time keyframe. Idempotent; a change made before the socket opens is flushed on open.
  sendWatch(on: boolean): void;
  // Whether this client currently wants the scene stream (the gate's live value).
  watching: boolean;
  // Send a co-op join request (name-choosing form). The host replies with a `session` message; if the server
  // spawned a headless game instance for this player, the session carries `headlessMirrorPort` and
  // `options.onHeadlessRedirect` fires so the app can reconnect to the player's own game view.
  // `playerId` (the picked seat's "p:{netId}") is sent only when the join came from a roster BUTTON; it lets the
  // host resolve the exact seat instead of matching the label, which is what makes a rejoin land on the right netId.
  sendJoin(name: string, playerId?: string): void;
  // Send a SERVER-side settings change (refresh rate / freeze toggles / tween-replay / FMOD) over the `settings`
  // control channel. Fire-and-forget; no-op when the socket isn't open. Only the JOINED (headless) connection
  // should be sent to — the caller gates on that so the shared host game is never mutated.
  sendSettings(payload: MirrorSettingsPayload): void;
  // Start/stop/reschedule the latency probe at runtime (ms; 0 = off). Used to run the ping→pong probe only while
  // the settings panel is open, without reconnecting. Clears and re-arms the ping timer.
  setPingInterval(intervalMs: number): void;
  close(): void;
}

const LATENCY_WINDOW = 50;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function connectMirrorClient(options: {
  // Explicit WebSocket URL. When provided, skips URL derivation from `location`; use this to reconnect to
  // a headless game instance on a different port after `onHeadlessRedirect` fires.
  url?: string;
  // Called after the connection status changes OR a delta is applied (state.revision bumped).
  onChange?: () => void;
  // Called after a `pong` updates the rolling latency (kept separate from `onChange` so the render path
  // isn't woken by latency probes).
  onLatency?: () => void;
  // Called when the host responds to a `join` request with a `session` carrying `headlessMirrorPort`.
  // The app should reconnect to `<same-host>:<port>/ws` (via buildHeadlessMirrorWebSocketUrl) to get the
  // player's own game view (served by the headless instance the host spawned for them).
  onHeadlessRedirect?: (port: number) => void;
  // Called when the join reply directs the viewer to WATCH THE HOST's own stream in place (no redirect):
  // a singleplayer run, or the host seat was selected. The app renders the current (host) stream directly.
  onDirectView?: () => void;
  // Called when the join reply rejects the requested name (`joinRejection` code). The app shows the picker
  // with a mapped message instead of redirecting. `detail` is the host's own fault text, present only for the
  // "join-failed" code (a throw inside the host's join handler), and rendered under the mapped line.
  onJoinRejected?: (reason: string, detail?: string | null) => void;
  // BACKSTOP for a join that fails in a way nobody converted into `joinRejection`. The host answers a faulted
  // message with an `action-result` error — a type this client otherwise ignores entirely (see sendAction) — so
  // before this existed a server-side throw during a join was delivered, dropped, and the picker spun on
  // "Joining…" forever. Fired ONLY while a join is in flight, so an unrelated refused action (e.g. a map-node
  // vote the game turned down) can never clear the form. The app treats it as that join failing.
  onActionError?: (message: string) => void;
  // R19 WP5 — the ABSOLUTE-SCROLL ack (see MirrorScrollAck). The one `action-result` this client reads for its
  // VALUE rather than for the fact that it failed. Fired only for a SUCCESSFUL `set-scroll-offset` result, i.e.
  // strictly after the join backstop above has had its look, so nothing about join failure changes.
  onScrollAck?: (ack: MirrorScrollAck) => void;
  // When > 0, send a `ping` this often (ms) and track the round-trip in `client.latency` (the `?latency=1` path).
  pingIntervalMs?: number;
  // WS-B stream gate: whether this connection starts WATCHING the host's scene stream. Defaults to true (the
  // pre-gate behavior). False appends `watch=0` to the derived URL, so the host sends no connect keyframe and no
  // deltas until `sendWatch(true)`. Ignored when an explicit `url` is supplied — that URL carries its own query.
  watch?: boolean;
  // Stage-B walk skip: whether this viewer shows the static combat background at connect time. The derived URL
  // always carries the canonical `staticBg=0|1` selector; later flips ride the `settings` control message.
  // Ignored when an explicit `url` is supplied — that URL carries its own query.
  staticBg?: boolean;
  // R14 trail drive: whether this viewer drives the card-flight trail root from its declarative flight hint. The
  // derived URL always carries the canonical `trailDrive=0|1` selector; later flips ride the settings payload.
  // Ignored when an explicit `url` is supplied — that URL carries its own query.
  trailDrive?: boolean;
  WebSocketCtor?: typeof WebSocket;
  location?: Pick<Location, "href" | "protocol">;
  reloadOnServerReload?: () => void;
  // Called INSTEAD of the page reload when a `server-reload` carries the headless-host-disconnected reason: the
  // server on the other end is a headless instance that is EXITING because its connection to the host game is
  // permanently gone. Reloading the page would only re-open this dying port, so the app can fall back to the
  // original host (picker + reconnect) instead. Without this handler the client reloads the page.
  onHostGone?: (reason: string) => void;
} = {}): MirrorClient {
  const sourceLocation = options.location ?? window.location;
  const WebSocketCtor = options.WebSocketCtor ?? WebSocket;
  const state = createMirrorState();
  const latency: MirrorLatency = emptyMirrorLatency();
  // The gate's desired value, and what the HOST currently believes (seeded from the connect URL) so a flip is
  // sent exactly once and a pre-open change is flushed on open.
  let watching = options.watch !== false;
  let hostWatching = watching;
  const client: MirrorClient = {
    status: "connecting",
    state,
    latency,
    session: null,
    watching,
    sendInput,
    sendAction,
    sendSceneAck,
    sendJoin,
    sendSettings,
    sendWatch,
    setPingInterval,
    close
  };
  const notify = () => options.onChange?.();
  const reloadOnServerReload = options.reloadOnServerReload ?? (() => globalThis.location.reload());

  const socket = new WebSocketCtor(
    options.url
      ?? buildMirrorWebSocketUrl(
        sourceLocation,
        watching,
        options.staticBg === true,
        options.trailDrive === true)
  );

  // REPRO RECORDER (reproRecorder.ts) — the OUTGOING tap. Every tap lives inside `connectMirrorClient`, which is
  // what makes this complete without any registration machinery: a session can run through several clients (the
  // host socket, a headless redirect, a reconnect ladder — see MirrorApp's `allClients`) and each one is tapped
  // as it is built.
  //
  // Wrapping the socket INSTANCE's `send` — rather than adding a call at each of the six send sites — is the only
  // version of this that cannot rot: a seventh send site added later is captured for free, and an own property
  // shadows the prototype method, so the test doubles injected through `WebSocketCtor` are wrapped exactly as a
  // real WebSocket is. The recorder early-outs on a boolean when it is not armed, which is the entire cost a
  // viewer who never turns it on pays here.
  const nativeSend = socket.send.bind(socket);
  socket.send = (data: Parameters<typeof nativeSend>[0]): void => {
    reproRecorder.tapWireOut(data);
    nativeSend(data);
  };
  reproRecorder.tapWsLifecycle("ctor");

  let joinSequence = 0;
  // Whether a `join` we sent is still unanswered. Gates the `action-result` backstop below so it only ever speaks
  // for a join. Set on send; cleared by whichever session directive resolves the join, by the backstop itself,
  // and on close (a dropped socket resets the whole dance app-side anyway).
  let joinPending = false;
  let inputSequence = 0;
  let settingsSequence = 0;
  let actionSequence = 0;
  // How many scene deltas have been APPLIED since the last `scene-ack` left this client — the flow-control
  // ledger sendSceneAck spends. See the comment on sendSceneAck for why it is counted this way.
  let deltasSinceAck = 0;

  // One rolling RTT bucket per ping variant. Each keeps its OWN single-outstanding guard: if a pong is slow we
  // must NOT keep firing that variant (queued pongs would inflate the very number we're measuring), and a stale
  // outstanding ping times out so the probe recovers. Buckets are independent so a slow game main-thread pong
  // never blocks the network probe (or vice-versa).
  interface LatencyBucket {
    samples: number[];
    outstanding: boolean;
    deadline: number;
  }
  const networkBucket: LatencyBucket = { samples: [], outstanding: false, deadline: 0 };
  const gameBucket: LatencyBucket = { samples: [], outstanding: false, deadline: 0 };
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  // Mutable probe interval (ms; 0 = off). Seeded from options; changed live via setPingInterval.
  let pingIntervalMs = options.pingIntervalMs ?? 0;
  const PING_TIMEOUT_MS = 2000;

  function recordRtt(bucket: LatencyBucket, mainThread: boolean, rtt: number): void {
    bucket.outstanding = false;
    if (!Number.isFinite(rtt) || rtt < 0) {
      return;
    }
    bucket.samples.push(rtt);
    if (bucket.samples.length > LATENCY_WINDOW) {
      bucket.samples.shift();
    }
    const sorted = [...bucket.samples].sort((a, b) => a - b);
    if (mainThread) {
      latency.gameLastMs = rtt;
      latency.gameP50 = percentile(sorted, 50);
      latency.gameP95 = percentile(sorted, 95);
      latency.gameCount = bucket.samples.length;
    } else {
      latency.lastMs = rtt;
      latency.p50 = percentile(sorted, 50);
      latency.p95 = percentile(sorted, 95);
      latency.count = bucket.samples.length;
    }
    options.onLatency?.();
  }

  // Send one probe of a variant (guarded by its own bucket's single-outstanding flag).
  function sendProbe(bucket: LatencyBucket, mainThread: boolean): void {
    if (socket.readyState !== WebSocketCtor.OPEN) {
      return;
    }
    const now = performance.now();
    if (bucket.outstanding && now < bucket.deadline) {
      return; // a previous ping of this variant is still in flight (and hasn't timed out) — don't pile on
    }
    bucket.outstanding = true;
    bucket.deadline = now + PING_TIMEOUT_MS;
    try {
      // The network variant is the bare `{type:"ping"}` the host answers immediately; the game variant adds
      // `mainThread:true` so the server round-trips it through the game's main thread.
      socket.send(JSON.stringify(mainThread ? { type: "ping", t0: now, mainThread: true } : { type: "ping", t0: now }));
    } catch {
      bucket.outstanding = false; // racing close — allow the next attempt
    }
  }

  function sendPing(): void {
    sendProbe(networkBucket, false);
    sendProbe(gameBucket, true);
  }

  function startPing(): void {
    if (pingTimer !== null || pingIntervalMs <= 0) {
      return;
    }
    sendPing();
    pingTimer = setInterval(sendPing, pingIntervalMs);
  }

  // Change the probe cadence live (0 = off). Clears any existing timer and re-arms if we're connected + on.
  function setPingInterval(intervalMs: number): void {
    pingIntervalMs = Math.max(0, intervalMs);
    stopPing();
    if (client.status === "connected" && pingIntervalMs > 0) {
      startPing();
    }
  }

  function stopPing(): void {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function sendInput(message: MirrorInputMessage): void {
    if (socket.readyState !== WebSocketCtor.OPEN) {
      return;
    }
    inputSequence += 1;
    try {
      socket.send(JSON.stringify({ type: "input", requestId: `input:${inputSequence}`, ...message }));
    } catch {
      // A racing close between the readyState check and send — drop it; input is best-effort.
    }
  }

  function sendAction(message: MirrorActionMessage): string | null {
    if (socket.readyState !== WebSocketCtor.OPEN) {
      return null;
    }
    actionSequence += 1;
    const requestId = `action:${actionSequence}`;
    try {
      socket.send(JSON.stringify({
        type: "action",
        requestId,
        semanticActionId: message.semanticActionId,
        // Omitted (not sent as an empty object) when there are no args, so the envelope stays minimal.
        ...(message.args && Object.keys(message.args).length ? { args: message.args } : {})
      }));
      return requestId;
    } catch {
      // A racing close between the readyState check and send — drop it; a tap is best-effort like any input.
      return null;
    }
  }

  // Flow control: the host holds ONE send credit, spends it on each coalesced delta, and gets it back from this
  // ack (CouchCoopWebSocketConnection.GrantSceneCredit). So exactly one ack per delta the host actually sent is
  // required — and, equally, is all that is required.
  //
  // The caller is "a frame was rendered", which is NOT the same thing: a render is also scheduled by a texture's
  // natural size resolving, an atlas region finishing its bake, the aspect/spread change, and the spine /
  // backstop-occlusion / static-bg setting watchers. Each of those used to send an ack granting a credit the host
  // was never holding — a pure ~0.32ms/send tax on a Moto G86, and the texture/atlas pair fire constantly during
  // a combat texture storm.
  //
  // The ledger is therefore "deltas applied SINCE THE LAST ACK", not "this render consumed a delta". That
  // distinction is what makes it stall-proof: whichever render happens to run next pays off the outstanding
  // delta, including the case where the delta was consumed by a reconcile that does not ack at all (the
  // mount-time one). Frames that consumed nothing new send nothing; the host's 500ms self-heal remains the
  // backstop it always was for a delta that never reaches a render.
  const SCENE_ACK = '{"type":"scene-ack"}';

  function sendSceneAck(): void {
    if (deltasSinceAck === 0 || !watching || socket.readyState !== WebSocketCtor.OPEN) {
      return;
    }
    deltasSinceAck = 0;
    try {
      socket.send(SCENE_ACK);
    } catch {
      // Racing close — drop it; the host's self-heal timeout re-grants credit if an ack is lost.
    }
  }

  function sendWatch(on: boolean): void {
    watching = on;
    client.watching = on;
    flushWatch();
  }

  function flushWatch(): void {
    if (socket.readyState !== WebSocketCtor.OPEN || hostWatching === watching) {
      return;
    }
    hostWatching = watching;
    try {
      socket.send(JSON.stringify({ type: "watch", on: watching }));
    } catch {
      // Racing close — drop it; a reconnect re-establishes the gate through the connect URL.
      hostWatching = !watching;
    }
  }

  function sendJoin(name: string, playerId?: string): void {
    if (socket.readyState !== WebSocketCtor.OPEN) {
      return;
    }
    joinSequence += 1;
    try {
      socket.send(JSON.stringify({
        type: "join",
        requestId: `join:${joinSequence}`,
        name: name.trim(),
        // Omitted (not null) when there is no picked seat, so a free-text join's bytes are exactly as before.
        ...(playerId ? { playerId } : {})
      }));
      joinPending = true;
    } catch {
      // Racing close — drop it.
    }
  }

  function sendSettings(payload: MirrorSettingsPayload): void {
    if (socket.readyState !== WebSocketCtor.OPEN) {
      return;
    }
    settingsSequence += 1;
    try {
      socket.send(JSON.stringify({ type: "settings", requestId: `settings:${settingsSequence}`, ...payload }));
    } catch {
      // Racing close — drop it; the panel re-sends on the next change.
    }
  }

  socket.addEventListener("open", () => {
    reproRecorder.tapWsLifecycle("open");
    client.status = "connected";
    // Flush a gate change made between construction and open (e.g. the first session already told us the host
    // isn't on a multiplayer screen while the socket was still connecting).
    flushWatch();
    notify();
    startPing();
  });

  socket.addEventListener("message", (event) => {
    const data = String((event as MessageEvent).data);
    // REPRO RECORDER — the INCOMING tap, deliberately the first statement after the string coercion: ABOVE the
    // JSON.parse (a malformed frame is evidence too) and ABOVE the `watching` gate below, so the stragglers a
    // gated viewer drops are in the file. "The client received it and ignored it" and "the host never sent it"
    // are different bugs, and this is the only place they can still be told apart.
    reproRecorder.tapWireIn(data);
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }

    // `pong` carries the client's `t0` back — compute RTT and skip the render path. `mainThread:true` echoes the
    // game-variant ping (answered from the game's main thread), so it lands in the game bucket; anything else is
    // the network variant.
    if (raw && typeof raw === "object" && (raw as { type?: unknown }).type === "pong") {
      const t0 = (raw as { t0?: unknown }).t0;
      if (typeof t0 === "number") {
        const mainThread = (raw as { mainThread?: unknown }).mainThread === true;
        recordRtt(mainThread ? gameBucket : networkBucket, mainThread, performance.now() - t0);
      }
      return;
    }

    if (raw && typeof raw === "object" && (raw as { type?: unknown }).type === "server-reload") {
      client.status = "disconnected";
      stopPing();
      notify();
      // A HEADLESS instance's last gasp before it exits (its host game connection is permanently gone) is NOT a
      // "the server is coming back, reload" — the port this socket points at is going away. Hand it to the app,
      // which falls back to the original host, instead of reloading the page against a dying instance.
      const reason = (raw as { reason?: unknown }).reason;
      if (reason === HEADLESS_HOST_DISCONNECTED_REASON && options.onHostGone) {
        options.onHostGone(reason);
        return;
      }
      setTimeout(reloadOnServerReload, 50);
      return;
    }

    // The `action-result` BACKSTOP. This client is otherwise deliberately deaf to action results, but the host's
    // receive loop answers ANY faulted message — a join included — with exactly this envelope, so a server-side
    // throw during a join used to vanish here and leave the picker spinning. While a join is outstanding, an
    // error-carrying result is that join failing. Placed ABOVE the `watching` gate on purpose: a viewer sitting on
    // the join picker has the scene stream turned OFF, which is precisely when this needs to fire.
    if (raw && typeof raw === "object" && (raw as { type?: unknown }).type === "action-result") {
      const code = (raw as { code?: unknown }).code;
      if (joinPending && typeof code === "string" && code.length > 0) {
        joinPending = false;
        const message = (raw as { message?: unknown }).message;
        options.onActionError?.(typeof message === "string" && message ? message : code);
        return;
      }
      // R19 WP5 — the ABSOLUTE-SCROLL ack. Deliberately BELOW the backstop, and reading only SUCCESSFUL results, so
      // the "a faulted message during a join is that join failing" rule keeps first refusal on every error-carrying
      // envelope exactly as it did before this existed.
      const ack = readScrollAck(raw);
      if (ack) {
        options.onScrollAck?.(ack);
      }
      return;
    }

    // `session` carries the roster + screen kind (for the shared join screen) and — on a join reply — one of
    // three mutually-exclusive directives: `directView` (watch the host stream in place), `headlessMirrorPort`
    // (redirect to this player's own headless game view), or `joinRejection` (name not servable → show picker +
    // message). Parse + surface the session first (so the form updates), then act on the directive in order.
    if (raw && typeof raw === "object" && (raw as { type?: unknown }).type === "session") {
      let parsed: BrowserSessionEnvelope | null = null;
      try {
        // The already-parsed value, NOT the string: `raw` above is this exact frame, and re-parsing it here
        // doubled the JSON cost of every session envelope for nothing.
        const envelope = parseBrowserEnvelopeValue(raw);
        if (envelope.type === "session") {
          parsed = envelope;
          client.session = envelope;
          notify();
        }
      } catch {
        // Malformed session — ignore; the form falls back to its placeholder.
      }

      if (parsed?.directView === true) {
        joinPending = false;
        options.onDirectView?.();
      } else if (typeof parsed?.headlessMirrorPort === "number") {
        joinPending = false;
        options.onHeadlessRedirect?.(parsed.headlessMirrorPort);
      } else if (typeof parsed?.joinRejection === "string") {
        joinPending = false;
        // A rejection is TERMINAL on its own — it is not cross-checked against `session.joined`. It used to be,
        // and that was the "the join screen spins forever" bug: the host derives `session` from the name→roster
        // assignment, which happily reports `joined: true` for a name it just refused to serve, so the guard
        // dropped the rejection, `pendingName` was never cleared, and the viewer waited on a seat that was never
        // coming. Newer hosts no longer send the contradictory pair, but the client must not depend on that —
        // the two directives above already take precedence, so nothing else can be swallowed here.
        options.onJoinRejected?.(parsed.joinRejection, parsed.joinRejectionDetail ?? null);
      }
      return;
    }

    // Stream gate: while off the host sends no scene-delta at all — drop any in-flight straggler rather than
    // parsing/applying it, so a gated viewer schedules NO mirror render work (and never acks a frame).
    if (!watching) {
      return;
    }

    let delta;
    try {
      delta = parseSceneDelta(raw);
    } catch {
      // A frame that is not a scene delta (session/error/anything a future host adds) — ignored.
      return;
    }

    if (delta) {
      applySceneDelta(state, delta);
      // The host spent a send credit on this delta; the next rendered frame owes it an ack (see sendSceneAck).
      deltasSinceAck += 1;
      notify();
    }
  });

  socket.addEventListener("close", () => {
    reproRecorder.tapWsLifecycle("close");
    client.status = "disconnected";
    joinPending = false;
    stopPing();
    notify();
  });

  socket.addEventListener("error", () => {
    client.status = "disconnected";
    stopPing();
    notify();
  });

  function close() {
    stopPing();
    socket.close();
  }

  return client;
}

// R19 WP5 — read an `action-result` as an ABSOLUTE-SCROLL ack, or null when it is not one.
//
// The wire shape is the host's ordinary action reply: the envelope echoes the `semanticActionId` we sent, and the
// spirectl result rides nested under `result.result` with the handler's answer in its `values` bag. Those values
// are a C# `Dictionary<string,string>`, so the offsets arrive as STRINGS and are parsed here — a non-finite or
// missing `offsetY` means "this result says nothing about a position" and the ack is refused rather than coerced,
// because the settle would otherwise glide the surface to zero.
//
// Exported for the unit tests; the client itself only calls it from the message loop.
export function readScrollAck(raw: unknown): MirrorScrollAck | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const envelope = raw as { requestId?: unknown; semanticActionId?: unknown; code?: unknown; result?: unknown };
  if (envelope.semanticActionId !== SET_SCROLL_OFFSET_ACTION_ID) {
    return null;
  }
  if (typeof envelope.requestId !== "string" || envelope.requestId.length === 0) {
    return null; // an ack that cannot be matched to its send is worse than no ack at all
  }
  if (typeof envelope.code === "string" && envelope.code.length > 0) {
    return null; // a refusal, not an answer
  }
  const outer = envelope.result;
  if (!outer || typeof outer !== "object") {
    return null;
  }
  const inner = (outer as { result?: unknown }).result;
  const values = (inner && typeof inner === "object" ? (inner as { values?: unknown }).values : null)
    ?? (outer as { values?: unknown }).values;
  if (!values || typeof values !== "object") {
    return null;
  }
  const bag = values as Record<string, unknown>;
  const offsetY = finiteWireNumber(bag[SCROLL_OFFSET_ARG]);
  if (offsetY === null) {
    return null;
  }
  const surface = bag["surface"];
  return {
    requestId: envelope.requestId,
    offsetY,
    requestedY: finiteWireNumber(bag["requestedY"]),
    surface: typeof surface === "string" ? surface : null
  };
}

// One value out of the result's string bag, or null. Deliberately NOT bare `Number(...)`: `Number("")` and
// `Number(null)` are both 0, a perfectly finite number that names the TOP of the content — so a truncated or
// absent value would read as a real answer and glide the surface all the way home.
function finiteWireNumber(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildMirrorWebSocketUrl(
  sourceLocation: Pick<Location, "href" | "protocol"> = window.location,
  watch = true,
  staticBg = false,
  trailDrive = false
): string {
  // Scheme + authority come from the HOST BASE, not the page: under the public-origin bootstrap the page
  // is https while the host is plain http, and a `wss:` derived from the page would have nothing
  // listening for it. In host-served mode `hostWsUrl` falls back to the page href, so this is unchanged.
  const wsUrl = new URL(hostWsUrl("/ws", sourceLocation.href));
  wsUrl.searchParams.set("watch", watch ? "1" : "0");
  wsUrl.searchParams.set("staticBg", staticBg ? "1" : "0");
  wsUrl.searchParams.set("cardFlight", "1");
  wsUrl.searchParams.set("handTween", "1");
  wsUrl.searchParams.set("trailDrive", trailDrive ? "1" : "0");
  return wsUrl.toString();
}

// After the host assigns a headless game instance, reconnect to it on the SAME host the browser loaded from
// (e.g. 192.168.1.123) — only the port changes. Deriving the host from `location` instead of hardcoding
// 127.0.0.1 is what makes mirror co-op work from a phone/other machine on the LAN, not just localhost.
export function buildHeadlessMirrorWebSocketUrl(
  port: number,
  sourceLocation: Pick<Location, "href" | "protocol"> = window.location,
  staticBg = false,
  trailDrive = false
): string {
  // Same host-base derivation as buildMirrorWebSocketUrl; only the PORT differs for a headless instance.
  // Deriving the authority from the host base (rather than `location`) is what keeps this pointing at the
  // game machine when the page itself came from the public origin.
  const wsUrl = new URL(hostWsUrl("/ws", sourceLocation.href));
  wsUrl.port = String(port);
  wsUrl.searchParams.set("watch", "1");
  wsUrl.searchParams.set("staticBg", staticBg ? "1" : "0");
  wsUrl.searchParams.set("cardFlight", "1");
  wsUrl.searchParams.set("handTween", "1");
  wsUrl.searchParams.set("trailDrive", trailDrive ? "1" : "0");
  return wsUrl.toString();
}
