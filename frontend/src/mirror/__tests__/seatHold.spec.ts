import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import MirrorApp from "@/mirror/MirrorApp.vue";
import { __resetComposerForTest } from "@/i18n";
import { RECONNECT_BASE_DELAY_MS } from "@/mirror/reconnectPolicy";

// HOLDING A SEAT THE DEVICE CANNOT REACH — and the rejection that already has copy.
//
// THE MEASURED DEFECT (2026-09-16, real moto g31, `iptables -I INPUT -s <phone> -p tcp --dport 13347:13417 -j
// DROP`). A phone whose join COMPLETES and which then cannot reach its seat port made the host kill and relaunch
// that seat every ~43 seconds, for ever: **32 full game-process launches from one phone** before the leg was
// stopped. The whole chain is in this file's subject — the browser's. The seat socket never opened, which ran the
// full `handleActiveClientDrop` teardown, whose `reconnectToHost` closes EVERY client including the HOST socket;
// the server Release()s on that close and kills the seat; the auto-rejoin then bought a fresh 20-60 s cold spawn
// onto a port the device still could not reach. The teardown also cleared `seatNotice` each time, which is why the
// phone's own diagnosis first appeared at 63.8 s and then flickered on the respawn period instead of standing
// still at ~20 s.
//
// The distinguishing fact is that this socket NEVER REACHED `connected`. A seat socket that opened and later died
// really is a view that was lost — the host has probably gone — and it keeps the teardown. Both are pinned here,
// because a fix that held every drop would strand a viewer whose host went away.

class MockWebSocket extends EventTarget {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  /** URL fragments (":14000") whose sockets ERROR instead of opening — this device's blocked path to its seat. */
  static blocked: string[] = [];
  readyState = MockWebSocket.OPEN;
  sent: unknown[] = [];
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);
    const refused = MockWebSocket.blocked.some((fragment) => url.includes(fragment));
    queueMicrotask(() => {
      if (!refused) {
        this.dispatchEvent(new Event("open"));
        return;
      }
      // What a dropped path really produces: the socket dies without ever having opened.
      this.readyState = 3;
      this.dispatchEvent(new Event("error"));
    });
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    if (this.readyState === 3) return;
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

const SEAT_PORT = 14000;
const NETWORK_DETAIL =
  "This player's game is running and answering on the host, but the device never reached it. Observed: assigned "
  + "port 13357; requests to this player's game from outside this computer: 0.";

function sessionMessage(over: Record<string, unknown> = {}) {
  return {
    type: "session",
    session: { name: null, status: "unassigned", joined: false, playerId: null, connectionCount: 0 },
    players: [
      { playerId: "p:1", name: "Hosty", isHost: true, isRunPlayer: true, connectionCount: 1, disconnected: false, isLocal: false, netId: null, isMirrorSeat: false, seatStatus: "ready", seatStatusReason: null, characterId: null },
      { playerId: "p:1003", name: "Alice", isHost: false, isRunPlayer: true, connectionCount: 0, disconnected: false, isLocal: false, netId: 1003, isMirrorSeat: true, seatStatus: "ready", seatStatusReason: null, characterId: null }
    ],
    screen: { kind: "run", type: "Run", title: "Run", mirrorMode: "mp-run" },
    hostName: "host",
    scrollAction: true,
    // The attempt this connection's receipts are about. Load-bearing for the `client-view-error` assertions:
    // `sendConnectionReceipt` drops anything with no attempt id, so a fixture without one would make "the
    // browser sent no transport-loss report" true for the wrong reason.
    connectionAttemptId: "attempt-1",
    ...over
  };
}

function noticeFrame(over: Record<string, unknown> = {}) {
  return { type: "seat-notice", cause: "network-path", detail: NETWORK_DETAIL, ...over };
}

describe("MirrorApp seat hold", () => {
  let realWebSocket: unknown;
  let app: ReturnType<typeof mount> | null = null;

  // Only the TIMER apis are faked: the socket lifecycle events ride a microtask, and faking those deadlocks this.
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();
  };

  const hostSocket = () => MockWebSocket.instances[0];
  const latest = () => MockWebSocket.instances[MockWebSocket.instances.length - 1];
  const heading = () => app!.find("h1").text();
  const notice = () => app!.find('[data-testid="mirror-seat-notice"]');
  const seatSockets = () => MockWebSocket.instances.filter((s) => s.url.includes(`:${SEAT_PORT}`));

  /** Mount → connect → session → tap Alice. Ends with a join in flight on the HOST socket. */
  async function tapASeat() {
    app = mount(MirrorApp);
    await settle();
    hostSocket().emit(sessionMessage());
    await settle();
    await app.findAll('[data-testid="player-picker"] button')[1].trigger("click");
    await settle();
    expect(heading()).toBe("Joining…");
  }

  beforeEach(() => {
    __resetComposerForTest();
    // A confirmed join stamps `?name=` (+ sessionStorage), which would auto-join the NEXT test before its picker.
    window.history.replaceState(null, "", "/");
    globalThis.sessionStorage?.clear();
    MockWebSocket.instances = [];
    MockWebSocket.blocked = [];
    realWebSocket = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    vi.useRealTimers();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket;
    __resetComposerForTest();
  });

  // THE REGRESSION, in one test: the host socket survives, no second join goes out, and the diagnosis stays up.
  // Each of those three is one link of the 43-second loop — closing the socket is what killed the seat, the
  // re-join is what bought the cold spawn, and the cleared notice is why the phone's screen flickered.
  it("keeps the host socket, the seat and the notice when the seat socket never opens", async () => {
    await tapASeat();
    // The host's verdict about the seat it is handing us. It arrives on the HOST socket, which is the only channel
    // a viewer who cannot reach their seat has left.
    hostSocket().emit(noticeFrame());
    await settle();

    MockWebSocket.blocked = [`:${SEAT_PORT}`];
    hostSocket().emit(sessionMessage({ headlessMirrorPort: SEAT_PORT }));
    await settle();

    // The seat socket was opened and died without ever connecting.
    expect(seatSockets()).toHaveLength(1);
    expect(latest().readyState).toBe(3);

    // 1. THE HOST SOCKET IS STILL OPEN. Closing it is what makes the server Release() and kill the seat process.
    expect(hostSocket().readyState).toBe(MockWebSocket.OPEN);
    // 2. NO SECOND JOIN. The one from the tap, and nothing since — no cold spawn is being paid for.
    expect(hostSocket().sentOfType("join")).toHaveLength(1);
    // 3. THE DIAGNOSIS STANDS. This is the message the teardown used to wipe on every cycle.
    expect(notice().exists()).toBe(true);
    expect(app!.find('[data-testid="mirror-seat-notice-detail"]').text()).toBe(NETWORK_DETAIL);
    // …under the ordinary transient word. The screen is honest: the view is not here and we are still trying.
    expect(heading()).toBe("Reconnecting…");
    expect(app!.find('[data-testid="mirror-spinner"]').exists()).toBe(true);
    // And no roster is offered: this device still holds its seat, so a row here could only double-join it.
    expect(app!.find('[data-testid="player-picker"]').exists()).toBe(false);
  });

  // THE FALSE WITNESS. `client-view-error` with `browser-transport-lost` is not a hint — the host's registry
  // takes the browser at its word and FAILS the row with "reload the browser and select the same player", which
  // is the wrong fix told to the wrong person for a device that never opened the socket at all. Worse, it
  // outranks the host's own four-cause verdict, which is the only thing here with the evidence to tell a blocked
  // path from a port another program owns.
  it("never claims a transport was lost when the seat socket never had one", async () => {
    await tapASeat();
    MockWebSocket.blocked = [`:${SEAT_PORT}`];
    hostSocket().emit(sessionMessage({ headlessMirrorPort: SEAT_PORT }));
    await settle();
    expect(hostSocket().sentOfType("client-view-error")).toHaveLength(0);

    // …and it stays silent across the retry ladder, which is where one wrong row would have become many.
    vi.advanceTimersByTime(RECONNECT_BASE_DELAY_MS);
    await settle();
    vi.advanceTimersByTime(RECONNECT_BASE_DELAY_MS * 2);
    await settle();
    expect(hostSocket().sentOfType("client-view-error")).toHaveLength(0);
  });

  // The other side of the same rule: a view socket that OPENED and then died really is a lost transport, which
  // is the case that string was written for, and the host is still told.
  it("still reports a transport that was genuinely lost", async () => {
    await tapASeat();
    hostSocket().emit(sessionMessage({ headlessMirrorPort: SEAT_PORT }));
    await settle();
    expect(heading()).toBe("Loading…");
    expect(hostSocket().sentOfType("client-view-error")).toHaveLength(0);

    latest().close();
    await settle();

    const reports = hostSocket().sentOfType("client-view-error");
    expect(reports).toHaveLength(1);
    expect(reports[0].code).toBe("browser-transport-lost");
  });

  it("retries the seat URL on the backoff ladder, opening no host connection of its own", async () => {
    await tapASeat();
    MockWebSocket.blocked = [`:${SEAT_PORT}`];
    hostSocket().emit(sessionMessage({ headlessMirrorPort: SEAT_PORT }));
    await settle();
    hostSocket().emit(noticeFrame());
    await settle();

    const beforeRetry = MockWebSocket.instances.length;
    vi.advanceTimersByTime(RECONNECT_BASE_DELAY_MS);
    await settle();

    // Exactly one new socket, and it points at the SEAT — not at the page origin, which is what the teardown path
    // reconnects to.
    expect(MockWebSocket.instances).toHaveLength(beforeRetry + 1);
    expect(latest().url).toContain(`:${SEAT_PORT}`);
    expect(seatSockets()).toHaveLength(2);
    // Nothing about the join was restarted, and the notice survived the retry too.
    expect(hostSocket().readyState).toBe(MockWebSocket.OPEN);
    expect(hostSocket().sentOfType("join")).toHaveLength(1);
    expect(notice().exists()).toBe(true);
  });

  it("takes the view back the moment the path clears, with no new join", async () => {
    await tapASeat();
    MockWebSocket.blocked = [`:${SEAT_PORT}`];
    hostSocket().emit(sessionMessage({ headlessMirrorPort: SEAT_PORT }));
    await settle();
    expect(heading()).toBe("Reconnecting…");

    // The rule came off / the device roamed onto the right network.
    MockWebSocket.blocked = [];
    vi.advanceTimersByTime(RECONNECT_BASE_DELAY_MS);
    await settle();

    // The seat is ours again and the screen goes back to waiting for its first frame — no re-join, no respawn.
    expect(heading()).toBe("Loading…");
    expect(latest().url).toContain(`:${SEAT_PORT}`);
    expect(hostSocket().sentOfType("join")).toHaveLength(1);
  });

  // THE OTHER HALF. A seat socket that OPENED and later died says something real about the seat — the host has
  // probably gone — so it keeps today's teardown: close everything, reconnect to the page's own origin, re-run the
  // join dance. Holding that one would strand a viewer on a port nothing serves any more.
  it("still falls back to the picker when a seat socket opens and THEN closes", async () => {
    await tapASeat();
    hostSocket().emit(sessionMessage({ headlessMirrorPort: SEAT_PORT }));
    await settle();
    expect(heading()).toBe("Loading…");
    const seat = latest();
    expect(seat.readyState).toBe(MockWebSocket.OPEN);

    seat.close();
    await settle();
    expect(heading()).toBe("Reconnecting…");

    vi.advanceTimersByTime(RECONNECT_BASE_DELAY_MS);
    await settle();

    // The host socket was closed with everything else, and the reconnect went to the page's ORIGIN, not the seat.
    expect(hostSocket().readyState).toBe(3);
    expect(latest().url).not.toContain(`:${SEAT_PORT}`);
    // …and the whole join dance re-runs from the fresh roster: the seat is auto-rejoined, which is a NEW join.
    latest().emit(sessionMessage());
    await settle();
    expect(heading()).toBe("Joining…");
    expect(latest().sentOfType("join")).toHaveLength(1);
  });

  // The host socket is the thing the hold depends on. With it gone there is no channel to be told anything on and
  // nothing keeping the seat alive, so a seat socket that never opens falls back exactly as it always did.
  it("does not hold a seat when the host socket has gone too", async () => {
    await tapASeat();
    MockWebSocket.blocked = [`:${SEAT_PORT}`];
    hostSocket().emit(sessionMessage({ headlessMirrorPort: SEAT_PORT }));
    // Kill the host socket in the same turn, before the seat's own failure is processed.
    hostSocket().close();
    await settle();

    vi.advanceTimersByTime(RECONNECT_BASE_DELAY_MS);
    await settle();
    expect(latest().url).not.toContain(`:${SEAT_PORT}`);
  });
});

// WI-3. The same three verdicts, arriving as the answer that ENDED the join rather than on the seat-notice
// channel. Before this they all collapsed into "spawn-failed" — "Couldn't start your game view — please try
// again" — while the sentence the player needed was already translated in all 14 catalogs.
describe("MirrorApp join rejection copy", () => {
  let realWebSocket: unknown;
  let app: ReturnType<typeof mount> | null = null;

  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();
  };

  const hostSocket = () => MockWebSocket.instances[0];
  const notice = () => app!.find('[data-testid="mirror-seat-notice"]');
  const joinMessage = () => app!.find('[data-testid="mirror-join-message"]');

  async function rejectAJoin(over: Record<string, unknown>) {
    app = mount(MirrorApp);
    await settle();
    hostSocket().emit(sessionMessage());
    await settle();
    await app.findAll('[data-testid="player-picker"] button')[1].trigger("click");
    await settle();
    hostSocket().emit(sessionMessage(over));
    await settle();
  }

  beforeEach(() => {
    __resetComposerForTest();
    window.history.replaceState(null, "", "/");
    globalThis.sessionStorage?.clear();
    MockWebSocket.instances = [];
    MockWebSocket.blocked = [];
    realWebSocket = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    vi.useRealTimers();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket;
    __resetComposerForTest();
  });

  it("gives a port conflict the fix that already exists, not 'please try again'", async () => {
    await rejectAJoin({
      joinRejection: "seat-port-taken",
      joinRejectionDetail: "Observed: assigned port 13357; owner: some-daemon (pid 4242)."
    });

    expect(app!.find('[data-testid="mirror-seat-notice-summary"]').text())
      .toBe("Another program on the host computer is using the port your game needs.");
    expect(app!.find('[data-testid="mirror-seat-notice-action"]').text())
      .toBe("Nothing to change on this device — ask whoever is hosting to restart Slay the Spire 2, then try again.");
    // The host's own English rides underneath, exactly as it does on the redirect path.
    expect(app!.find('[data-testid="mirror-seat-notice-detail"]').text())
      .toBe("Observed: assigned port 13357; owner: some-daemon (pid 4242).");
    // …and the vaguer line it replaces is NOT also on screen. Two answers to one question is the defect, doubled.
    expect(joinMessage().exists()).toBe(false);
    // The rejection is still terminal: the picker is back, so the viewer can tap again once the port is free.
    expect(app!.find('[data-testid="player-picker"]').exists()).toBe(true);
  });

  it("routes the other two named causes to their own copy", async () => {
    await rejectAJoin({ joinRejection: "seat-port-blocked", joinRejectionDetail: "The host cannot reach port 13357." });
    expect(app!.find('[data-testid="mirror-seat-notice-summary"]').text())
      .toBe("The host computer is blocking the port your game is served on.");

    app!.unmount();
    MockWebSocket.instances = [];
    await rejectAJoin({ joinRejection: "seat-network-path", joinRejectionDetail: "requests from outside: 0." });
    expect(app!.find('[data-testid="mirror-seat-notice-summary"]').text())
      .toBe("Your game is running on the host computer, but this device couldn't reach it.");
  });

  // The host's fourth named cause: this player's game is running and serving on the host, and the host cannot
  // get a status out of it — two processes on that machine, over its own loopback address. It deliberately
  // reuses the host-block copy rather than adding a fifth string set: from here the situation is identical
  // (nothing on this device is wrong, and only whoever is hosting can fix it), and the part that IS different
  // arrives as the host's own English detail underneath. What must never happen is the `spawn-failed` default,
  // which invites a retry that cannot work.
  it("sends a blocked control channel to the host-block copy, not to 'please try again'", async () => {
    await rejectAJoin({
      joinRejection: "seat-control-blocked",
      joinRejectionDetail:
        "This player's game joined the host's lobby and is serving on port 13357 … over this computer's own "
        + "loopback address (127.0.0.1)."
    });

    expect(app!.find('[data-testid="mirror-seat-notice-summary"]').text())
      .toBe("The host computer is blocking the port your game is served on.");
    expect(app!.find('[data-testid="mirror-seat-notice-action"]').text())
      .toBe(
        "Nothing to change on this device — ask whoever is hosting to allow Slay the Spire 2 through their "
        + "firewall or security software."
      );
    expect(app!.find('[data-testid="mirror-seat-notice-detail"]').text()).toContain("127.0.0.1");
    expect(joinMessage().exists()).toBe(false);
  });

  it("leaves every other code exactly as it was", async () => {
    await rejectAJoin({ joinRejection: "spawn-failed", joinRejectionDetail: "Join deadline expired." });
    expect(joinMessage().text()).toBe("Couldn't start your game view — please try again.");
    expect(notice().exists()).toBe(false);

    // Including a cause a future host names and this build has no copy for: silence beats guessing which of
    // several unrelated fixes to send a player to, and the existing default line still explains itself.
    app!.unmount();
    MockWebSocket.instances = [];
    await rejectAJoin({ joinRejection: "seat-something-new" });
    expect(notice().exists()).toBe(false);
    expect(joinMessage().text()).toBe("seat-something-new");
  });
});
