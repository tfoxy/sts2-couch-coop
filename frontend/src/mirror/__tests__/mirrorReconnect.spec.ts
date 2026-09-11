import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import MirrorApp from "@/mirror/MirrorApp.vue";
import { connectMirrorClient } from "@/mirror/mirrorClient";
import {
  findAutoRejoinSeat,
  nextReconnectDelayMs,
  reconnectStateAfterDrop,
  reconnectStateAfterReconnect,
  reconnectStateAfterViewRestored,
  rejoinSeatIsBlocked,
  steadyReconnectState,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_ESCALATE_AFTER_ATTEMPTS,
  RECONNECT_MAX_DELAY_MS,
  type ReconnectState
} from "@/mirror/reconnectPolicy";
import { HEADLESS_HOST_DISCONNECTED_REASON, type BrowserPlayerOption } from "@/protocol/browserEnvelope";

// WS-8 (web half). A viewer's game view is served by a disposable HEADLESS instance; when that instance's own
// connection to the host game dies for good it now EXITS, after a last-gasp `server-reload` carrying
// HEADLESS_HOST_DISCONNECTED_REASON. The browser must NOT treat that as "the server is coming back, reload the
// page" (the port is going away) — it falls back to the original host and reconnects with the same backoff ladder
// the native client uses, so the seat is reclaimed automatically.
//
// NOTE the escalated "Lost the game connection — the host must reload the saved run" notice is GONE (it was wrong
// far more often than right: most escalations healed on their own). The PHASE machine below is unchanged, but no
// phase renders copy — a `lost` viewer sees the same "Reconnecting…" + spinner a `reconnecting` one does.
// Native twins: ConnectionCoordinator.OnSocketServerReload / ScheduleReconnect / TeardownAndReconnect.

class MockWebSocket extends EventTarget {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  // When false a new socket ERRORS instead of opening — a host that is genuinely gone (connection refused),
  // which is what the attempt ladder is counting.
  static autoOpen = true;
  readyState = MockWebSocket.OPEN;
  sent: unknown[] = [];
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);
    const opens = MockWebSocket.autoOpen;
    queueMicrotask(() => {
      if (opens) {
        this.dispatchEvent(new Event("open"));
        return;
      }
      this.readyState = 3;
      this.dispatchEvent(new Event("error"));
    });
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  // Faithful to the real WebSocket: closing an already-closed socket fires nothing. (The app closes every past
  // client on each reconnect, so a re-dispatching mock would invent extra drops.)
  close() {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  emit(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  sentOfType(type: string): Record<string, unknown>[] {
    return this.sent.filter((m): m is Record<string, unknown> => (m as { type?: unknown }).type === type);
  }
}

function connect(options: { onHostGone?: (reason: string) => void; reloadOnServerReload?: () => void } = {}) {
  MockWebSocket.instances = [];
  const client = connectMirrorClient({
    ...options,
    WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
    location: { href: "http://localhost/", protocol: "http:" }
  });
  return { client, socket: MockWebSocket.instances[0] };
}

function seat(over: Partial<BrowserPlayerOption> = {}): BrowserPlayerOption {
  return {
    playerId: "p:1003",
    name: "Alice",
    isHost: false,
    isRunPlayer: true,
    connectionCount: 0,
    disconnected: false,
    isLocal: false,
    netId: 1003,
    isMirrorSeat: true,
    seatStatus: "ready",
    seatStatusReason: null,
    characterId: null,
    ...over
  };
}

describe("mirror client — headless host-gone envelope", () => {
  afterEach(() => vi.useRealTimers());

  it("routes the headless last gasp to onHostGone instead of reloading the page", () => {
    vi.useFakeTimers();
    const onHostGone = vi.fn();
    const reloadOnServerReload = vi.fn();
    const { client, socket } = connect({ onHostGone, reloadOnServerReload });

    socket.emit({
      type: "server-reload",
      requestId: "server-reload",
      reason: HEADLESS_HOST_DISCONNECTED_REASON
    });
    vi.advanceTimersByTime(500);

    expect(onHostGone).toHaveBeenCalledWith(HEADLESS_HOST_DISCONNECTED_REASON);
    expect(reloadOnServerReload).not.toHaveBeenCalled();
    expect(client.status).toBe("disconnected");
  });

  it("still reloads for an ordinary server-reload (the hot-reload path is unchanged)", () => {
    vi.useFakeTimers();
    const onHostGone = vi.fn();
    const reloadOnServerReload = vi.fn();
    const { socket } = connect({ onHostGone, reloadOnServerReload });

    socket.emit({ type: "server-reload", requestId: "server-reload", reason: "server-reload" });
    vi.advanceTimersByTime(500);

    expect(reloadOnServerReload).toHaveBeenCalledTimes(1);
    expect(onHostGone).not.toHaveBeenCalled();
  });

  it("falls back to the reload when no onHostGone handler is wired (older consumer)", () => {
    vi.useFakeTimers();
    const reloadOnServerReload = vi.fn();
    const { socket } = connect({ reloadOnServerReload });

    socket.emit({ type: "server-reload", reason: HEADLESS_HOST_DISCONNECTED_REASON });
    vi.advanceTimersByTime(500);

    expect(reloadOnServerReload).toHaveBeenCalledTimes(1);
  });
});

describe("reconnect backoff ladder", () => {
  it("doubles up to the cap (1s → 2s → 4s → 8s → 10s), matching the native client", () => {
    let delay = RECONNECT_BASE_DELAY_MS;
    const ladder = [delay];
    for (let i = 0; i < 5; i++) {
      delay = nextReconnectDelayMs(delay);
      ladder.push(delay);
    }
    expect(ladder).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
    expect(RECONNECT_MAX_DELAY_MS).toBe(10000);
  });

  it("normalizes a nonsense previous delay back to the base step", () => {
    expect(nextReconnectDelayMs(0)).toBe(RECONNECT_BASE_DELAY_MS * 2);
    expect(nextReconnectDelayMs(Number.NaN)).toBe(RECONNECT_BASE_DELAY_MS * 2);
    expect(nextReconnectDelayMs(-5)).toBe(RECONNECT_BASE_DELAY_MS * 2);
  });
});

describe("auto-rejoin seat selection", () => {
  it("matches the remembered seat by playerId and requires it to be ready", () => {
    const players = [seat(), seat({ playerId: "p:1002", name: "Bob", netId: 1002 })];
    expect(findAutoRejoinSeat(players, { name: "whatever", playerId: "p:1003" })?.playerId).toBe("p:1003");
    // The label is NOT the key: an unnamed saved seat renders as a synthesized "Player 1003".
    expect(findAutoRejoinSeat(players, { name: "Player 1003", playerId: "p:1003" })?.name).toBe("Alice");
  });

  it("does not rejoin a seat the host has disabled (this is the mid-run state)", () => {
    const offline = [seat({ seatStatus: "offline", seatStatusReason: "Disconnected — the host must reload the saved run to let this seat rejoin" })];
    expect(findAutoRejoinSeat(offline, { name: "Alice", playerId: "p:1003" })).toBeNull();
    const stuck = [seat({ seatStatus: "stuck", seatStatusReason: "Cannot rejoin — host must restart the game" })];
    expect(findAutoRejoinSeat(stuck, { name: "Alice", playerId: "p:1003" })).toBeNull();
  });

  it("falls back to a name match for a `?name=` join, but only on a real mirror seat", () => {
    expect(findAutoRejoinSeat([seat()], { name: "Alice" })?.playerId).toBe("p:1003");
    expect(findAutoRejoinSeat([seat({ isMirrorSeat: false })], { name: "Alice" })).toBeNull();
  });

  it("never auto-claims the host row, and is a no-op with nothing remembered", () => {
    const host = [seat({ playerId: "p:1", name: "Hosty", isHost: true, netId: 1, isMirrorSeat: false })];
    expect(findAutoRejoinSeat(host, { name: "Hosty", playerId: "p:1" })).toBeNull();
    expect(findAutoRejoinSeat([seat()], null)).toBeNull();
  });

});

describe("rejoin seat blocked (escalation rule b input)", () => {
  it("is true for the two statuses the host refuses", () => {
    const target = { name: "Alice", playerId: "p:1003" };
    expect(rejoinSeatIsBlocked([seat({ seatStatus: "offline" })], target)).toBe(true);
    expect(rejoinSeatIsBlocked([seat({ seatStatus: "stuck" })], target)).toBe(true);
  });

  it("is false for a seat we can actually have back", () => {
    expect(rejoinSeatIsBlocked([seat()], { name: "Alice", playerId: "p:1003" })).toBe(false);
  });

  it("is false when the seat is simply not on this roster (a guess is not a diagnosis)", () => {
    expect(rejoinSeatIsBlocked([seat({ playerId: "p:1002", netId: 1002 })], { name: "x", playerId: "p:1003" }))
      .toBe(false);
    expect(rejoinSeatIsBlocked([], { name: "Alice", playerId: "p:1003" })).toBe(false);
    expect(rejoinSeatIsBlocked([seat()], null)).toBe(false);
  });

  it("never reads a status off the HOST row (meaningless there), and matches names like the rejoin does", () => {
    const host = [seat({ playerId: "p:1", name: "Hosty", isHost: true, netId: 1, seatStatus: "offline" })];
    expect(rejoinSeatIsBlocked(host, { name: "Hosty", playerId: "p:1" })).toBe(false);
    // `?name=` join (no playerId): the same mirror-seat-only name fallback findAutoRejoinSeat uses.
    expect(rejoinSeatIsBlocked([seat({ seatStatus: "offline" })], { name: "Alice" })).toBe(true);
    expect(rejoinSeatIsBlocked([seat({ seatStatus: "offline", isMirrorSeat: false })], { name: "Alice" }))
      .toBe(false);
  });
});

// R9 item 7 — the drop PHASE. Before this, every drop (including a 1s singleplayer blip) painted the full "the
// host must reload the saved run" guidance, and nothing ever took it back down.
describe("reconnect phase state machine", () => {
  const drop = (state: ReconnectState, hadView = true) => reconnectStateAfterDrop(state, hadView);

  it("starts steady and silent", () => {
    expect(steadyReconnectState()).toEqual({ phase: "steady", failedAttempts: 0, hadView: false });
  });

  it("treats the FIRST drop as transient: reconnecting, zero attempts", () => {
    const state = drop(steadyReconnectState());
    expect(state.phase).toBe("reconnecting");
    expect(state.failedAttempts).toBe(0);
  });

  it("counts the retries and escalates on the third failure (rule a)", () => {
    let state = drop(steadyReconnectState()); // the original loss
    const phases: string[] = [];
    for (let i = 0; i < RECONNECT_ESCALATE_AFTER_ATTEMPTS; i++) {
      state = drop(state); // one reconnect attempt that failed
      phases.push(state.phase);
    }
    expect(phases).toEqual(["reconnecting", "reconnecting", "lost"]);
    expect(state.failedAttempts).toBe(RECONNECT_ESCALATE_AFTER_ATTEMPTS);
  });

  it("never escalates for a device that never had a view (it has nothing to 'rejoin')", () => {
    let state = drop(steadyReconnectState(), false);
    for (let i = 0; i < 6; i++) {
      state = drop(state, false);
    }
    expect(state.phase).toBe("reconnecting");
  });

  it("remembers `hadView` across the chain (the app clears joined/directView on the first drop)", () => {
    let state = drop(steadyReconnectState(), true);
    for (let i = 0; i < RECONNECT_ESCALATE_AFTER_ATTEMPTS; i++) {
      state = drop(state, false); // every later call reports "no view" — the flag must survive
    }
    expect(state.phase).toBe("lost");
  });

  it("stays lost across further drops", () => {
    let state = drop(steadyReconnectState());
    for (let i = 0; i < RECONNECT_ESCALATE_AFTER_ATTEMPTS + 2; i++) {
      state = drop(state);
    }
    expect(state.phase).toBe("lost");
  });

  it("escalates at once when a SUCCESSFUL reconnect finds the seat refused (rule b)", () => {
    const reconnecting = drop(steadyReconnectState());
    const state = reconnectStateAfterReconnect(reconnecting, true);
    expect(state.phase).toBe("lost");
    // No attempt ladder needed: this is knowable from the roster the moment the socket is back.
    expect(state.failedAttempts).toBe(0);
  });

  it("stays quiet when the reconnect finds the seat ready, or the viewer never had one", () => {
    const reconnecting = drop(steadyReconnectState());
    expect(reconnectStateAfterReconnect(reconnecting, false)).toBe(reconnecting);
    const noView = drop(steadyReconnectState(), false);
    expect(reconnectStateAfterReconnect(noView, true).phase).toBe("reconnecting");
    // A steady viewer's blocked seat is the picker's own business (disabled row + the server's reason).
    expect(reconnectStateAfterReconnect(steadyReconnectState(), true).phase).toBe("steady");
  });

  it("clears phase and counter when a view is restored", () => {
    let state = drop(steadyReconnectState());
    for (let i = 0; i < RECONNECT_ESCALATE_AFTER_ATTEMPTS; i++) {
      state = drop(state);
    }
    expect(state.phase).toBe("lost");
    const restored = reconnectStateAfterViewRestored();
    expect(restored).toEqual(steadyReconnectState());
    // …and the next blip starts the ladder from scratch rather than re-escalating instantly.
    expect(drop(restored).phase).toBe("reconnecting");
  });
});

// The WIRING, driven through the real component: a drop drill on a mounted MirrorApp with a fake socket. The pure
// rules above can't catch the two defects that actually bit users — the message being written on every drop, and
// nothing ever clearing it — because both live in the app's callbacks, not in the policy.
describe("MirrorApp drop drills", () => {
  const ANDROID_UA =
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36";
  let realWebSocket: unknown;
  let app: ReturnType<typeof mount> | null = null;

  // The socket "open"/"error" events ride a microtask, so only the TIMER apis are faked (a faked queueMicrotask
  // would deadlock the settle helper below).
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();
  };

  function sessionMessage(over: Record<string, unknown> = {}, seatStatus: "ready" | "offline" | "stuck" = "ready") {
    return {
      type: "session",
      session: { name: null, status: "unassigned", joined: false, playerId: null, connectionCount: 0 },
      players: [
        { playerId: "p:1", name: "Hosty", isHost: true, isRunPlayer: true, connectionCount: 1, disconnected: false, isLocal: false, netId: null, isMirrorSeat: false, seatStatus: "ready", seatStatusReason: null, characterId: null },
        {
          playerId: "p:1003",
          name: "Alice",
          isHost: false,
          isRunPlayer: true,
          connectionCount: 0,
          disconnected: false,
          isLocal: false,
          netId: 1003,
          isMirrorSeat: true,
          seatStatus,
          seatStatusReason: seatStatus === "ready" ? null : "Disconnected — the host must reload the saved run",
          characterId: null
        }
      ],
      screen: { kind: "run", type: "Run", title: "Run", mirrorMode: "mp-run" },
      androidApkUrl: "/couchcoop-client.apk",
      hostName: "host",
      scrollAction: true,
      rewardAction: true,
      ...over
    };
  }

  const latest = () => MockWebSocket.instances[MockWebSocket.instances.length - 1];
  const heading = () => app!.find("h1").text();
  const notice = () => app!.find('[data-testid="mirror-join-message"]');
  const spinner = () => app!.find('[data-testid="mirror-spinner"]');

  /** Mount → connect → session → tap Alice → host redirects us to our own headless. Ends JOINED, no frames yet. */
  async function joinASeat() {
    app = mount(MirrorApp);
    await settle();
    latest().emit(sessionMessage());
    await settle();
    // Steady picker: no heading at all and no spinner. (R19 WP-2 dropped the game's own screen name from a
    // steady picker — the <h1> is now reserved for the lifecycle words asserted below. The Android APK hint that
    // used to sit here is gone too; the native client is paused, the host still serves the route, nothing
    // renders it.)
    expect(app.find("h1").exists()).toBe(false);
    expect(spinner().exists()).toBe(false);
    expect(app.find('[data-testid="android-install-hint"]').exists()).toBe(false);

    const rows = app.findAll('[data-testid="player-picker"] button');
    await rows[1].trigger("click");
    await settle();
    expect(heading()).toBe("Joining…");

    latest().emit(sessionMessage({ headlessMirrorPort: 14000 }));
    await settle();
    // Redirected to our own headless: the join is over ("Joining…" must not stick), the frames are what's left.
    expect(heading()).toBe("Loading…");
    expect(spinner().exists()).toBe(true);
    expect(notice().exists()).toBe(false);
    // …and no roster is offered while we wait: we already hold the seat, so a row here could only double-join.
    expect(app!.find('[data-testid="player-picker"]').exists()).toBe(false);
  }

  beforeEach(() => {
    // A confirmed join stamps `?name=` on the page URL (+ sessionStorage) so a reload auto-joins — which would
    // make the NEXT drill auto-join before it ever reaches its picker. Start every one from a clean address bar.
    window.history.replaceState(null, "", "/");
    globalThis.sessionStorage?.clear();
    MockWebSocket.instances = [];
    MockWebSocket.autoOpen = true;
    realWebSocket = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
    Object.defineProperty(navigator, "userAgent", { value: ANDROID_UA, configurable: true });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    vi.useRealTimers();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket;
    Reflect.deleteProperty(navigator, "userAgent");
  });

  it("shows Connecting… before the first socket opens", async () => {
    MockWebSocket.autoOpen = false; // hold the socket in its pre-open state
    app = mount(MirrorApp);
    expect(heading()).toBe("Connecting…");
    expect(spinner().exists()).toBe(true);
    expect(notice().exists()).toBe(false);
  });

  // THE regression: a transient blip used to paint "Lost the game connection — the host must reload the saved
  // run" and then leave it there forever, even though the seat came back on its own a second later.
  it("a transient blip shows ONLY Reconnecting…, then heals with no leftover copy", async () => {
    await joinASeat();

    latest().close(); // the headless serving our view goes away for a moment
    await settle();
    expect(heading()).toBe("Reconnecting…");
    expect(spinner().exists()).toBe(true);
    expect(notice().exists()).toBe(false);

    vi.advanceTimersByTime(RECONNECT_BASE_DELAY_MS); // the first ladder step reaches a healthy host
    await settle();
    latest().emit(sessionMessage()); // our seat is ready again → auto-rejoin, no tap
    await settle();
    expect(heading()).toBe("Joining…");
    expect(latest().sentOfType("join")).toHaveLength(1);

    latest().emit(sessionMessage({ headlessMirrorPort: 14001 }));
    await settle();
    expect(heading()).toBe("Loading…");
    expect(notice().exists()).toBe(false); // nothing scary was ever shown, and nothing lingers
  });

  it("stays on the plain Reconnecting… state however long the retries keep failing (rule a)", async () => {
    await joinASeat();

    MockWebSocket.autoOpen = false; // the host game is really gone
    latest().close();
    await settle();
    expect(notice().exists()).toBe(false);

    // 1s → 2s → 4s: three failed attempts, ~7s of trying — which escalates the PHASE to `lost`.
    for (const step of [1000, 2000, 4000]) {
      vi.advanceTimersByTime(step);
      await settle();
    }
    // THE CHANGE: an escalated phase says nothing extra. It used to paint "the host must reload the saved run",
    // which was usually a lie — the ladder below recovers on its own, with no host action at all.
    expect(notice().exists()).toBe(false);
    expect(heading()).toBe("Reconnecting…"); // still trying, and still saying only that
    expect(spinner().exists()).toBe(true);

    // The host comes back and reloads the run: the seat is offered again and the guidance must come down.
    MockWebSocket.autoOpen = true;
    vi.advanceTimersByTime(8000);
    await settle();
    latest().emit(sessionMessage());
    await settle();
    latest().emit(sessionMessage({ headlessMirrorPort: 14002 }));
    await settle();
    expect(heading()).toBe("Loading…");
    expect(notice().exists()).toBe(false);
  });

  it("says nothing extra when the reconnect works but the seat is refused — the ROW carries the localized known status", async () => {
    await joinASeat();

    latest().close();
    await settle();
    vi.advanceTimersByTime(RECONNECT_BASE_DELAY_MS);
    await settle();
    latest().emit(sessionMessage({}, "offline")); // host is up; the run has not been reloaded
    await settle();

    // No app-authored notice (rule b escalates the phase, but the phase renders no copy). The socket is healthy
    // and there's a roster to look at, so the screen goes back to the steady picker — no lifecycle heading, no
    // spinner…
    expect(notice().exists()).toBe(false);
    expect(app!.find("h1").exists()).toBe(false);
    expect(spinner().exists()).toBe(false);
    // …and the explanation that survives is the SERVER-authored one on the seat's own disabled row, which is
    // authoritative about that seat in a way a blanket connection message never was.
    const reason = app!.find('[data-testid="seat-status-reason"]');
    expect(reason.exists()).toBe(true);
    expect(reason.text()).toBe("This player is offline and cannot be joined right now.");
  });
});
