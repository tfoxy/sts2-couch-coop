import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import MirrorApp from "@/mirror/MirrorApp.vue";
import { __resetComposerForTest, createBrowserI18n } from "@/i18n";
import { reproRecorder } from "@/mirror/reproRecorder";

// A join that FAILS on the host must fail on the screen too.
//
// The defect these drills lock down: a throw inside the host's join handler was answered with an
// `action-result` — a message type the mirror client ignores entirely — so the failure was delivered, discarded,
// and the picker sat on "Joining…" forever with nothing in the host log either. That is exactly what a shipped
// `KeyNotFoundException` did on 2026-08-15. Three defences are exercised here, in the order they fire:
//   1. the host converts its own throw into `joinRejection: "join-failed"` + `joinRejectionDetail` (the channel
//      the client already treats as TERMINAL);
//   2. the client's `action-result` backstop, for a fault nobody remembered to convert;
//   3. a 90s client-side timeout, for a host that answers NOTHING at all.
// Only (1) needs the host to cooperate, which is why (2) and (3) exist.

class MockWebSocket extends EventTarget {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.OPEN;
  sent: unknown[] = [];
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

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
}

describe("MirrorApp join-failure drills", () => {
  let realWebSocket: unknown;
  let app: ReturnType<typeof mount> | null = null;

  // Socket "open" rides a microtask, so only the TIMER apis are faked (faking queueMicrotask deadlocks this).
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();
  };

  function sessionMessage(over: Record<string, unknown> = {}) {
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
          seatStatus: "ready",
          seatStatusReason: null,
          characterId: null
        }
      ],
      screen: { kind: "run", type: "Run", title: "Run", mirrorMode: "mp-run" },
      hostName: "host",
      scrollAction: true,
      rewardAction: true,
      ...over
    };
  }

  const latest = () => MockWebSocket.instances[MockWebSocket.instances.length - 1];
  const heading = () => app!.find("h1").text();
  /**
   * "The join is over and the viewer has their form back."
   *
   * R19 WP-2: a STEADY picker no longer renders the game's own screen name — that heading told the player
   * nothing about which control to use, and the <h1> is now reserved for the lifecycle words this file exists to
   * gate on ("Joining…", "Loading…", "Reconnecting…"). So the end of a join is asserted as the ABSENCE of both
   * the heading and the spinner, plus the roster being offered again — which is a stricter statement of the same
   * thing the old `heading() === "Run"` meant.
   */
  const expectFormIsBack = () => {
    expect(app!.find("h1").exists()).toBe(false);
    expect(app!.find('[data-testid="mirror-spinner"]').exists()).toBe(false);
    expect(picker().exists()).toBe(true);
  };
  const notice = () => app!.find('[data-testid="mirror-join-message"]');
  const detail = () => app!.find('[data-testid="mirror-join-detail"]');
  const picker = () => app!.find('[data-testid="player-picker"]');

  /** Mount → connect → roster → tap Alice. Ends MID-JOIN ("Joining…"), which is where every drill starts. */
  async function tapASeat(expectedHeading = "Joining…") {
    app = mount(MirrorApp);
    await settle();
    latest().emit(sessionMessage());
    await settle();
    const rows = app.findAll('[data-testid="player-picker"] button');
    await rows[1].trigger("click");
    await settle();
    expect(heading()).toBe(expectedHeading);
  }

  beforeEach(() => {
    __resetComposerForTest();
    window.history.replaceState(null, "", "/");
    globalThis.sessionStorage?.clear();
    MockWebSocket.instances = [];
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

  it("shows the friendly line AND the host's own words for a join-failed rejection", async () => {
    await tapASeat();

    latest().emit(
      sessionMessage({
        joinRejection: "join-failed",
        joinRejectionDetail: "The given key 'MALLOC_ARENA_MAX' was not present in the dictionary."
      })
    );
    await settle();

    expect(notice().text()).toBe("Couldn't start your game view.");
    expect(detail().text()).toBe("The given key 'MALLOC_ARENA_MAX' was not present in the dictionary.");
    // The join is OVER: the spinner comes down and the roster is offered again, so the viewer can retry without
    // reloading. This is the half that was missing — the spinner never came down.
    expectFormIsBack();
  });

  it("keeps the failed join retryable when later roster updates still assign the name", async () => {
    await tapASeat();
    const assigned = { name: "Alice", status: "joined", joined: true, playerId: "p:1003", connectionCount: 1 };
    latest().emit(sessionMessage({ session: assigned }));
    await settle();
    expect(heading()).toBe("Joining…");
    latest().emit(sessionMessage({ joinRejection: "spawn-failed", joinRejectionDetail: "Join deadline expired." }));
    await settle();
    latest().emit(sessionMessage({ session: assigned }));
    await settle();
    expectFormIsBack();
    expect(detail().text()).toBe("Join deadline expired.");
    expect(latest().sent.some((m: any) => m.type === "watch" && m.on === true)).toBe(false);
    await app!.findAll('[data-testid="player-picker"] button')[1].trigger("click");
    await settle();
    expect(heading()).toBe("Joining…");
  });

  it("puts the actually loaded MirrorApp module bundle in a repro header", async () => {
    app = mount(MirrorApp);
    await settle();

    reproRecorder.start();
    reproRecorder.tapWireIn('{"type":"scene-delta"}');
    const header = JSON.parse(reproRecorder.serialize().split("\n", 1)[0]) as { meta: { moduleBundle?: unknown } };

    // Do not pin the machine-specific file URL Vitest gives an SFC. The contract is the loaded module URL, and the
    // stable part of that URL is this component rather than a checkout path or a build hash.
    expect(header.meta.moduleBundle).toEqual(expect.any(String));
    expect(new URL(header.meta.moduleBundle as string).pathname).toMatch(/\/MirrorApp\.vue$/);
  });

  it("renders no detail line for the self-describing rejection codes", async () => {
    await tapASeat();

    latest().emit(sessionMessage({ joinRejection: "no-free-instance" }));
    await settle();

    expect(notice().text()).toBe("No free game slot is available right now.");
    expect(detail().exists()).toBe(false);
  });

  it("localizes known rejection codes in Chinese but keeps an unknown host code verbatim", async () => {
    createBrowserI18n("?lang=zh-Hans", { languages: ["en"] });
    await tapASeat("正在加入…");
    latest().emit(sessionMessage({ joinRejection: "no-free-instance" }));
    await settle();
    expect(notice().text()).toBe("目前没有可用的游戏席位。");

    const rows = app!.findAll('[data-testid="player-picker"] button');
    await rows[1].trigger("click");
    await settle();
    latest().emit(sessionMessage({ joinRejection: "vendor-limit-17" }));
    await settle();
    expect(notice().text()).toBe("vendor-limit-17");
  });

  it("clears a stale detail when the next rejection carries none", async () => {
    await tapASeat();
    latest().emit(sessionMessage({ joinRejection: "join-failed", joinRejectionDetail: "boom" }));
    await settle();
    expect(detail().text()).toBe("boom");

    const rows = app!.findAll('[data-testid="player-picker"] button');
    await rows[1].trigger("click");
    await settle();
    latest().emit(sessionMessage({ joinRejection: "seat-unavailable" }));
    await settle();

    expect(notice().text()).toBe("That player can't be joined right now.");
    expect(detail().exists()).toBe(false);
  });

  it("falls back to the action-result backstop for a fault nobody converted", async () => {
    // An older/unconverted host path: the fault arrives on the `action-result` channel instead. The viewer must
    // still get their form back, with the server's text — the difference in envelope is not their problem.
    await tapASeat();

    latest().emit({
      type: "action-result",
      requestId: "join:1",
      code: "invalid-action-message",
      message: "Object reference not set to an instance of an object."
    });
    await settle();

    expect(notice().text()).toBe("Couldn't start your game view.");
    expect(detail().text()).toBe("Object reference not set to an instance of an object.");
    expectFormIsBack();
  });

  it("leaves the screen alone for an action-result with no join in flight", async () => {
    // A refused map-node vote is an ordinary `action-result` error this app sends on purpose. It must not paint
    // a join failure over a picker nobody is using.
    app = mount(MirrorApp);
    await settle();
    latest().emit(sessionMessage());
    await settle();
    expectFormIsBack();

    latest().emit({ type: "action-result", requestId: "action:3", code: "disabled-action", message: "nope" });
    await settle();

    expect(notice().exists()).toBe(false);
    expectFormIsBack();
  });

  it("gives the form back after 90s of total silence from the host", async () => {
    await tapASeat();

    // 60s is the host's OWN spawn deadline (HeadlessClientManager.WaitForReadyAsync): a cold seat is still
    // legitimately starting here, and failing it would be the timeout inventing a problem.
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(heading()).toBe("Joining…");
    expect(notice().exists()).toBe(false);

    vi.advanceTimersByTime(30_001);
    await settle();

    expect(notice().text()).toBe("The host didn't answer — please try again.");
    expect(detail().exists()).toBe(false); // nothing to quote: the host said nothing at all
    expectFormIsBack();
  });

  it("never fires the timeout for a join the host granted late", async () => {
    await tapASeat();

    vi.advanceTimersByTime(59_000); // slow, but inside the host's own deadline
    await settle();
    latest().emit(sessionMessage({ headlessMirrorPort: 14000 }));
    await settle();
    expect(heading()).toBe("Loading…");

    // Well past 90s from the tap: the disarmed timer must not drag the viewer out of the seat they now hold.
    vi.advanceTimersByTime(120_000);
    await settle();
    expect(heading()).toBe("Loading…");
    expect(notice().exists()).toBe(false);
  });

  it("re-arms the timeout for each attempt rather than only the first", async () => {
    await tapASeat();
    latest().emit(sessionMessage({ joinRejection: "no-free-instance" }));
    await settle();

    const rows = app!.findAll('[data-testid="player-picker"] button');
    await rows[1].trigger("click");
    await settle();
    expect(heading()).toBe("Joining…");

    vi.advanceTimersByTime(90_001);
    await settle();
    expect(notice().text()).toBe("The host didn't answer — please try again.");
  });
});
