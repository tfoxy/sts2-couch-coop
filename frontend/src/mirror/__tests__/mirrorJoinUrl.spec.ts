import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { nextTick } from "vue";

import MirrorApp from "@/mirror/MirrorApp.vue";
import MirrorView from "@/mirror/MirrorView.vue";
import { RECONNECT_BASE_DELAY_MS } from "@/mirror/reconnectPolicy";

// WS3 — the browser's join state lives in the page URL, and the page URL is NAVIGABLE.
//
// Three rules, all of them about a phone player being able to get back out of a seat:
//   1. a granted join PUSHES `?name=<seat>` (it used to replace, so Back skipped straight off the app);
//   2. a granted MULTIPLAYER direct view pushes `?name=` with NO VALUE — the host player's own browser, a state
//      the next load can re-take without the picker (a singleplayer/watch direct view still stamps nothing);
//   3. a Back/Forward that lands on a DIFFERENT join state reloads the page, because a reload is the only reset
//      consistent with every module's lazy `window.location` read.
// The reload itself is injected: jsdom refuses to redefine `location.reload` ([LegacyUnforgeable]).
//
// F3 adds a FOURTH rule, and it is about what the two `?name=` forms MEAN rather than about navigation: a VALUED
// param is a player waiting for a seat (no stream, no join, the waiting screen) while an EMPTY one is the host's
// own browser (stream the host, as before). The block at the bottom of this file drives it end to end.

class MockWebSocket extends EventTarget {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.OPEN;
  sent: Record<string, unknown>[] = [];
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
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
    return this.sent.filter((m) => m.type === type);
  }
}

const HOST_ROW = {
  playerId: "p:1",
  name: "Hosty",
  isHost: true,
  isRunPlayer: true,
  connectionCount: 1,
  disconnected: false,
  isLocal: false,
  netId: null,
  isMirrorSeat: false,
  seatStatus: "ready",
  seatStatusReason: null,
  characterId: null
};
const SEAT_ROW = {
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
  characterId: null
};

function sessionMessage(over: Record<string, unknown> = {}) {
  return {
    type: "session",
    session: { name: null, status: "unassigned", joined: false, playerId: null, connectionCount: 0 },
    players: [HOST_ROW, SEAT_ROW],
    screen: { kind: "run", type: "Run", title: "Run", mirrorMode: "mp-run" },
    hostName: "host",
    scrollAction: true,
    rewardAction: true,
    ...over
  };
}

const spRun = { kind: "run", type: "Run", title: "Run", mirrorMode: "singleplayer-run" };
// F3 screens. The two character selects share `kind: "lobby"` and differ only in `mirrorMode` — which is exactly
// why the `?name=` rules key off the mirror mode and never off `kind`.
const mainMenu = { kind: "menu", type: "Menu", title: "Menu", mirrorMode: "main-menu" };
const spCharSelect = { kind: "lobby", type: "lobby", title: "Character Select", mirrorMode: "sp-character-select" };
const mpCharSelect = { kind: "lobby", type: "lobby", title: "Character Select", mirrorMode: "mp-character-select" };

describe("MirrorApp — join state in the page URL", () => {
  let realWebSocket: unknown;
  let app: ReturnType<typeof mount> | null = null;
  let reloadPage: Mock<() => void>;

  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();
  };
  const latest = () => MockWebSocket.instances[MockWebSocket.instances.length - 1];
  const mountAt = (search: string, stubScene = false) => {
    window.history.replaceState(null, "", `/${search}`);
    app = mount(MirrorApp, { props: { reloadPage }, global: { stubs: { MirrorView: stubScene } } });
    return app;
  };
  // A Back/Forward press: the browser changes the URL WITHOUT adding an entry, then fires popstate.
  const navigateTo = (search: string) => {
    window.history.replaceState(null, "", `/${search}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  const rows = () => app!.findAll('[data-testid="player-picker"] button');
  // What the HOST currently believes about this viewer's stream gate. The INITIAL value rides the connect query
  // (`watch=0` = gated, which is how MirrorApp opens every host socket), and every later flip rides a
  // `{"type":"watch","on":bool}` message — so the last such message, or the query when there is none, is the
  // answer that is actually on the wire. This is the F3 enforcement point: the server never reads `?name=`, so
  // "a named seat pulls no bytes" is only true if this stays false.
  const watchOnTheWire = (ws = latest()): boolean => {
    const flips = ws.sentOfType("watch");
    if (flips.length > 0) return flips[flips.length - 1].on === true;
    return !/[?&]watch=0(&|$)/.test(ws.url);
  };
  // The waiting screen, through the real app. Its own root testid is overwritten by MirrorApp's `mirror-status`
  // fallthrough (as the picker's is), so the panel is identified by its CLASS — classes MERGE where attributes
  // are overridden — and its inner testids, which nothing overwrites.
  const waitingTitle = () => app!.find('[data-testid="mirror-host-waiting-title"]');
  const pickerIsUp = () =>
    app!.find(".mirror-join-picker").exists() || app!.find(".title-only-view").exists();

  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    globalThis.sessionStorage?.clear();
    MockWebSocket.instances = [];
    realWebSocket = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
    reloadPage = vi.fn(() => {});
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket;
    window.history.replaceState(null, "", "/");
  });

  it("reports a redirected view to the original host, and ignores receipts from an old attempt", async () => {
    mountAt("", true);
    await settle();
    const host = latest();
    host.emit(sessionMessage());
    await settle();
    await rows()[1].trigger("click");
    host.emit(sessionMessage({ headlessMirrorPort: 14000, connectionAttemptId: "join-1" }));
    await settle();
    const child = latest();
    child.emit({
      type: "scene-delta", full: true, screenType: "lobby", screenInstanceId: "lobby:1",
      upserts: [{ id: "root", name: "Root", nodeType: "Control", visible: true }],
      removedIds: [], orderedIds: ["root"]
    });
    await settle();
    const view = app!.findComponent(MirrorView);
    expect(view.props("connectionAttemptId")).toBe("join-1");
    expect(host.sentOfType("client-frame-presented")).toEqual([]);
    const present = view.props("onFirstSceneFramePresented")!;
    present("stale-attempt");
    expect(host.sentOfType("client-frame-presented")).toEqual([]);
    present("join-1");
    expect(host.sentOfType("client-frame-presented")).toEqual([
      { type: "client-frame-presented", attemptId: "join-1" }
    ]);
    expect(child.sentOfType("client-frame-presented")).toEqual([]);
    view.props("onSceneRenderError")!("join-1", new Error("decode failed"));
    expect(host.sentOfType("client-view-error")[0]).toMatchObject({
      attemptId: "join-1", detail: "Error: decode failed"
    });
    child.close();
    expect(host.sentOfType("client-view-error").at(-1)).toMatchObject({
      attemptId: "join-1", code: "browser-transport-lost"
    });
    present("join-1");
    expect(host.sentOfType("client-frame-presented")).toHaveLength(1);
  });

  it("pushes ?name=<seat> when the host grants the seat, so Back leaves it", async () => {
    mountAt("");
    await settle();
    latest().emit(sessionMessage());
    await settle();

    const before = window.history.length;
    await rows()[1].trigger("click"); // the seat row
    await settle();
    latest().emit(sessionMessage({ headlessMirrorPort: 14000 }));
    await settle();

    expect(window.location.search).toBe("?name=Alice");
    expect(window.history.length).toBe(before + 1); // a PUSH: there is now somewhere to go Back to
    expect(sessionStorage.getItem("couchCoop:lastPlayerName")).toBe("Alice");
  });

  it("reloads when Back removes the ?name= of a seat we hold", async () => {
    mountAt("");
    await settle();
    latest().emit(sessionMessage());
    await settle();
    await rows()[1].trigger("click");
    await settle();
    latest().emit(sessionMessage({ headlessMirrorPort: 14000 }));
    await settle();
    expect(window.location.search).toBe("?name=Alice");

    navigateTo("");
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  // The loop guard. A popstate that does not change the effective join state (a hash change or a
  // duplicate event) must NOT reload — a reload storm here would be indistinguishable from a crash loop.
  it("does not reload for a popstate that leaves the join state alone", async () => {
    mountAt("?name=Alice");
    await settle();
    latest().emit(sessionMessage());
    await settle();
    latest().emit(sessionMessage({ headlessMirrorPort: 14000 }));
    await settle();

    navigateTo("?name=Alice");
    navigateTo("?name=Alice");
    expect(reloadPage).not.toHaveBeenCalled();

    // …and Forward INTO a different seat is a change again.
    navigateTo("?name=Bob");
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  // The auto-join path re-stamps the very name it read out of the URL: that must not cost a history entry, or
  // every reload would bury the picker one Back press deeper.
  it("adds no history entry when the URL already names the auto-joined seat", async () => {
    mountAt("?name=Alice");
    await settle();
    const before = window.history.length;
    latest().emit(sessionMessage());
    await settle();
    expect(latest().sentOfType("join")[0]).toMatchObject({ name: "Alice" });

    latest().emit(sessionMessage({ headlessMirrorPort: 14000 }));
    await settle();

    expect(window.location.search).toBe("?name=Alice");
    expect(window.history.length).toBe(before);
  });

  it("pushes an EMPTY ?name= when a multiplayer direct view is granted (the [Host] row)", async () => {
    mountAt("");
    await settle();
    latest().emit(sessionMessage());
    await settle();

    const before = window.history.length;
    await rows()[0].trigger("click"); // the [Host] row
    await settle();
    expect(latest().sentOfType("join")[0]).toMatchObject({ name: "Hosty", playerId: "p:1" });

    latest().emit(sessionMessage({ directView: true }));
    await settle();

    expect(window.location.search).toBe("?name=");
    expect(window.history.length).toBe(before + 1);
    // The marker is NOT a seat name: it must never be remembered as one (that would auto-join a seat later).
    expect(sessionStorage.getItem("couchCoop:lastPlayerName")).toBeNull();
  });

  // A `?name=<host player>` link auto-joins and is answered with this same direct-view directive: the URL
  // already reloads to this view, and it may be a link somebody typed or shared. Canonicalizing it to the empty
  // marker would destroy that for no behavioral gain (and cost a history entry). Caught by e2e's
  // "smoke preserves join URL usability with query params", which is exactly this case.
  it("leaves an existing ?name=<value> alone when it is what produced the direct view", async () => {
    mountAt("?name=Hosty");
    await settle();
    latest().emit(sessionMessage());
    await settle();
    expect(latest().sentOfType("join")[0]).toMatchObject({ name: "Hosty" });

    const before = window.history.length;
    latest().emit(sessionMessage({ directView: true }));
    await settle();

    expect(window.location.search).toBe("?name=Hosty");
    expect(window.history.length).toBe(before);
    // …and Back out of it still reloads (the expected state is the seat-shaped URL we loaded with).
    navigateTo("");
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  // Unchanged behavior, and the reason the marker is gated on the screen: a solo run has no seat to return to
  // and no picker the viewer chose it from, so its (self-requested) direct view stamps nothing.
  it("stamps nothing for a singleplayer direct view", async () => {
    mountAt("");
    await settle();
    latest().emit(sessionMessage({ screen: spRun }));
    await settle();
    latest().emit(sessionMessage({ screen: spRun, directView: true }));
    await settle();

    expect(window.location.search).toBe("");
  });

  it("re-takes the host view on load from an empty ?name= once the multiplayer roster arrives", async () => {
    mountAt("?name=");
    await settle();
    // Nothing to act on before a session: no join, and certainly no seat auto-join (the param has no name).
    expect(latest().sentOfType("join")).toHaveLength(0);

    latest().emit(sessionMessage());
    await settle();

    const joins = latest().sentOfType("join");
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({ name: "Hosty", playerId: "p:1" });

    const before = window.history.length;
    latest().emit(sessionMessage({ directView: true }));
    await settle();
    // Already the right URL — the re-stamp is a no-op, so Back still goes to wherever the viewer came from.
    expect(window.location.search).toBe("?name=");
    expect(window.history.length).toBe(before);
  });

  it("waits for a multiplayer screen before acting on the empty ?name=", async () => {
    mountAt("?name=");
    await settle();
    latest().emit(
      sessionMessage({ players: [], screen: { kind: "menu", type: "Menu", title: "Menu", mirrorMode: "main-menu" } })
    );
    await settle();

    expect(latest().sentOfType("join")).toHaveLength(0);
    expect(window.location.search).toBe("?name="); // the marker survives — the host may still enter a lobby

    // …and it fires the moment a multiplayer roster does arrive.
    latest().emit(sessionMessage());
    await settle();
    expect(latest().sentOfType("join")[0]).toMatchObject({ name: "Hosty", playerId: "p:1" });
  });

  // F3 — REWRITTEN (this case used to assert the opposite: that the marker was dropped with a REPLACE and the
  // picker took over). A multiplayer roster with no host row is not proof that the session moved on under a stale
  // URL — far more often it is a roster that has not caught up with the lobby the host just entered. The empty
  // marker is the durable "I am the browser controlling the host", so a single host-less roster must not delete
  // it: deleting it cost the host player their own view for the rest of the session, recoverable only by knowing
  // to press "Control host". The retry costs nothing — on these screens the marker is already streaming the host.
  it("KEEPS the marker when a multiplayer roster has no host row, and takes the view when one appears", async () => {
    mountAt("?name=");
    await settle();
    const before = window.history.length;
    latest().emit(sessionMessage({ players: [SEAT_ROW] }));
    await settle();

    expect(latest().sentOfType("join")).toHaveLength(0);
    expect(window.location.search).toBe("?name="); // the marker survives a host-less roster
    expect(window.history.length).toBe(before);

    // …and it is still ARMED: the very next session that does carry a host row is acted on. A latch here would
    // have spent the one attempt on the incomplete roster.
    latest().emit(sessionMessage());
    await settle();
    const joins = latest().sentOfType("join");
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({ name: "Hosty", playerId: "p:1" });
  });

  it("reloads when Back leaves the host view", async () => {
    mountAt("?name=");
    await settle();
    latest().emit(sessionMessage());
    await settle();
    latest().emit(sessionMessage({ directView: true }));
    await settle();

    navigateTo("");
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  // ---- F3: `?name=<seat>` view rules + the waiting screen -----------------------------------------------------
  //
  // A URL that NAMES a seat is a player waiting for a game, not a spectator. On a host screen with no seat to give
  // — main menu, SINGLEPLAYER character select, singleplayer run — that viewer must: pull no scene bytes, send no
  // join the host could only refuse, and be told what it is waiting for. The picker is not an option there: it has
  // nothing on it to pick.

  for (const [label, screen] of [
    ["the main menu", mainMenu],
    ["a singleplayer character select", spCharSelect],
    ["a singleplayer run", spRun]
  ] as const) {
    it(`?name=<seat> on ${label} waits: no stream, no join, no picker`, async () => {
      mountAt("?name=Ann");
      await settle();
      latest().emit(sessionMessage({ screen, players: [] }));
      await settle();

      expect(waitingTitle().text()).toBe("Waiting for host to start game");
      expect(app!.find('[data-testid="mirror-host-waiting-sub"]').text()).toBe(
        "You'll join as Ann when the host starts a game."
      );
      expect(pickerIsUp()).toBe(false);
      expect(app!.find('[data-testid="player-picker"]').exists()).toBe(false);
      // NO join of any shape. The empty-name one matters as much as the named one: on a singleplayer run the app
      // otherwise sends `join ""` to request a direct view, and the server ANSWERS it — which would hand this
      // viewer the host's solo run through the gate's own directView arm.
      expect(latest().sentOfType("join")).toHaveLength(0);
      expect(watchOnTheWire()).toBe(false);
    });
  }

  // The waiting screen is the diag/e2e scripts' `mirror-status` element, exactly as the picker is: they wait for
  // that testid to disappear as the signal "this viewer now has a game", and a waiting viewer does not.
  it("carries data-testid=mirror-status like the picker it replaces", async () => {
    mountAt("?name=Ann");
    await settle();
    latest().emit(sessionMessage({ screen: mainMenu, players: [] }));
    await settle();

    const status = app!.find('[data-testid="mirror-status"]');
    expect(status.exists()).toBe(true);
    expect(status.classes()).toContain("mirror-host-waiting");
  });

  // The auto-join guard is a "not yet", never a "never": it sits ABOVE the one-shot latch, so the attempt is
  // still there to spend when the host reaches a screen that has seats.
  it("auto-joins exactly once when the host walks from the menu into a multiplayer lobby", async () => {
    mountAt("?name=Ann");
    await settle();
    latest().emit(sessionMessage({ screen: mainMenu, players: [] }));
    await settle();
    expect(latest().sentOfType("join")).toHaveLength(0);
    expect(waitingTitle().exists()).toBe(true);

    latest().emit(sessionMessage({ screen: mpCharSelect }));
    await settle();
    expect(latest().sentOfType("join")).toEqual([expect.objectContaining({ name: "Ann" })]);
    // The join is in flight, so the lifecycle word owns the screen again — the waiting copy would hide the fact
    // that something IS happening.
    expect(waitingTitle().exists()).toBe(false);

    // Further sessions on the same screen add nothing: one attempt, spent once it could succeed.
    latest().emit(sessionMessage({ screen: mpCharSelect }));
    latest().emit(sessionMessage({ screen: mpCharSelect }));
    await settle();
    expect(latest().sentOfType("join")).toHaveLength(1);
  });

  // "Control host" — from "I am a player waiting for a seat" (`?name=Ann`) to "I am the browser controlling the
  // host" (`?name=`), which is the state whose stream gate is OPEN on these screens. A PUSH so Back returns the
  // viewer to being a player, and a RELOAD because half this app's setup is URL-keyed and read exactly once.
  it("control host swaps the seat name for the empty marker and reloads", async () => {
    mountAt("?name=Ann");
    await settle();
    latest().emit(sessionMessage({ screen: mainMenu, players: [] }));
    await settle();

    const before = window.history.length;
    await app!.find('[data-testid="control-host"]').trigger("click");

    expect(window.location.search).toBe("?name=");
    expect(window.history.length).toBe(before + 1);
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  // The reason `urlSeatIntent` is kept in sync by ONE helper shared with the redirect path: a viewer that JOINED
  // (and so stamped `?name=Ann` from code, not from the address bar it loaded with) is still a seat viewer when
  // the run later ends under them. Without the shared update it would silently fall through to watching the
  // host's main menu — the exact thing the seat rules exist to prevent, arrived at from the other direction.
  it("a viewer that joined, then lost the run, waits on the host's menu instead of watching it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mountAt(""); // no param at load: the marker below is written by the JOIN, not by the URL we arrived on
    await settle();
    latest().emit(sessionMessage());
    await settle();
    await rows()[1].trigger("click"); // the seat row
    await settle();
    latest().emit(sessionMessage({ headlessMirrorPort: 14000 }));
    await settle();
    expect(window.location.search).toBe("?name=Alice");

    latest().close(); // the headless serving the seat exits — the run is over
    await settle();
    vi.advanceTimersByTime(RECONNECT_BASE_DELAY_MS);
    await settle();
    latest().emit(sessionMessage({ screen: mainMenu, players: [] })); // …and the host is back on the menu
    await settle();

    expect(waitingTitle().text()).toBe("Waiting for host to start game");
    expect(app!.find('[data-testid="mirror-host-waiting-sub"]').text()).toBe(
      "You'll join as Alice when the host starts a game."
    );
    expect(watchOnTheWire()).toBe(false);
  });

  // The COMPLEMENT, and the reason the two `?name=` forms cannot share one predicate: an EMPTY marker is not a
  // seat intent. It says "I am the host's own browser", so on a non-multiplayer screen it keeps doing exactly what
  // it did before F3 — stream the host's screen — and it is never shown the waiting copy.
  it("an EMPTY ?name= still streams the host on the main menu, joins nothing, and survives", async () => {
    mountAt("?name=");
    await settle();
    latest().emit(sessionMessage({ screen: mainMenu, players: [] }));
    await settle();

    expect(watchOnTheWire()).toBe(true);
    expect(latest().sentOfType("join")).toHaveLength(0);
    expect(waitingTitle().exists()).toBe(false);
    expect(window.location.search).toBe("?name="); // the marker is durable — the host may still enter a lobby
  });

  // The listener is per-app: an unmounted mirror must not keep reloading the page from under whatever mounted next.
  it("stops listening for popstate after unmount", async () => {
    mountAt("?name=Alice");
    await settle();
    app!.unmount();
    app = null;

    navigateTo("");
    expect(reloadPage).not.toHaveBeenCalled();
  });
});
