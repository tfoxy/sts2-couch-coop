import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import MirrorJoinPicker from "@/mirror/MirrorJoinPicker.vue";
import { __resetComposerForTest, createBrowserI18n } from "@/i18n";
import { computeMirrorLoadingState, mirrorLoadingLabel } from "@/mirror/loadingState";
import type { BrowserPlayerOption } from "@/protocol/browserEnvelope";
import type { MirrorJoinMode } from "@/join/joinModel";

// A stand-in for whatever the parent puts on the message surface. It used to be the escalated reconnect guidance
// ("the host must reload the saved run"), which is gone — the only notice left is a join REJECTION.
const REJECTION_MESSAGE = "That player can't be joined right now.";

afterEach(() => {
  Reflect.deleteProperty(navigator, "userAgent");
  __resetComposerForTest();
});

function player(over: Partial<BrowserPlayerOption> = {}): BrowserPlayerOption {
  return {
    playerId: "p:1002",
    name: "Alice",
    isHost: false,
    isRunPlayer: true,
    connectionCount: 1,
    disconnected: false,
    isLocal: true,
    netId: 1002,
    // Default a MIRROR SEAT, since that is what the picker's roster filter keeps; the filter test below overrides
    // with a genuine remote player (isMirrorSeat false), which the mirror view must never list.
    isMirrorSeat: true,
    seatStatus: "ready",
    seatStatusReason: null,
    characterId: null,
    ...over
  };
}

function mountPicker(over: {
  mode?: MirrorJoinMode;
  players?: BrowserPlayerOption[];
  message?: string | null;
  detail?: string | null;
  pendingJoinName?: string | null;
  screenTitle?: string | null;
  placeholder?: string | null;
  transient?: boolean;
} = {}) {
  return mount(MirrorJoinPicker, {
    props: {
      mode: over.mode ?? "picker",
      screenTitle: over.screenTitle === undefined ? "Combat" : over.screenTitle,
      players: over.players ?? [player()],
      pendingJoinName: over.pendingJoinName ?? null,
      prefillName: "",
      message: over.message ?? null,
      detail: over.detail ?? null,
      placeholder: over.placeholder ?? null,
      transient: over.transient ?? false
    }
  });
}

describe("MirrorJoinPicker", () => {
  it("picker-with-name renders BOTH the name form and the player picker", () => {
    const wrapper = mountPicker({ mode: "picker-with-name" });
    expect(wrapper.find('[data-testid="join-form"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="join-name-input"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="join-submit"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="player-picker"]').exists()).toBe(true);
  });

  it("picker renders the picker ONLY (no name field)", () => {
    const wrapper = mountPicker({ mode: "picker" });
    expect(wrapper.find('[data-testid="player-picker"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="join-form"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="join-name-input"]').exists()).toBe(false);
  });

  it("title-only renders the heading, no picker/form", () => {
    const wrapper = mountPicker({ mode: "title-only" });
    expect(wrapper.find('[data-testid="screen-title-only-view"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="player-picker"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="join-form"]').exists()).toBe(false);
  });

  // The host row is badged and NOTHING else: no "Watch host" (picking the host HANDLES that player — the host
  // machine drives it — so the copy described the wrong thing) and no highlight (see the claimable test below).
  it("badges the host row, with no secondary line and no highlight", () => {
    const wrapper = mountPicker({
      mode: "picker",
      players: [player({ playerId: "p:1", name: "Hosty", isHost: true, netId: 1, isMirrorSeat: false, connectionCount: 0 })]
    });
    expect(wrapper.find('[data-testid="host-badge"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="watch-host"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Watch host");
    const host = wrapper.find('[data-testid="player-picker"] button');
    expect(host.find('[data-testid="connection-count"]').exists()).toBe(false);
    // Never highlighted even with 0 controllers — the "claim me" emphasis belongs to the mirror seats.
    expect(host.classes()).not.toContain("claimable");
    expect(host.attributes("disabled")).toBeUndefined();
  });

  // ROSTER EMPHASIS: the accent goes to a ready seat nobody is on — the row a phone viewer is here to claim.
  it("highlights a ready seat with no controllers, and leaves a controlled seat plain", () => {
    const wrapper = mountPicker({
      mode: "picker",
      players: [
        player({ playerId: "p:1", name: "Hosty", isHost: true, netId: 1, isMirrorSeat: false }),
        player({ playerId: "p:1002", name: "Alice", netId: 1002, connectionCount: 0, disconnected: true }),
        player({ playerId: "p:1003", name: "Bob", netId: 1003, connectionCount: 1, disconnected: false })
      ]
    });
    const [host, free, taken] = wrapper.findAll('[data-testid="player-picker"] button');
    expect(host.classes()).not.toContain("claimable");
    expect(free.classes()).toContain("claimable");
    // …and the seat somebody is already on is plain AND undimmed: the old dim was the misleading signal.
    expect(taken.classes()).not.toContain("claimable");
    expect(taken.classes()).not.toContain("disconnected");
    expect(taken.classes()).not.toContain("seat-unavailable");
  });

  // CONTROLLER COUNT: words only at 2+. "0 controllers" read as a fault on a row that is perfectly joinable —
  // the claimable highlight already carries "nobody is on this seat" — and 1 is simply the normal state.
  it.each([[0], [1]])("shows the name ONLY on a seat with %i controllers", (connectionCount) => {
    const wrapper = mountPicker({
      mode: "picker",
      players: [player({ name: "Alice", playerId: "p:1002", netId: 1002, connectionCount, disconnected: connectionCount === 0 })]
    });
    const button = wrapper.find('[data-testid="player-picker"] button');
    expect(button.find('[data-testid="connection-count"]').exists()).toBe(false);
    expect(button.text()).not.toContain("controller");
    // The state is still on the element for tooling/e2e, just not spelled out in words.
    expect(button.attributes("data-connection-count")).toBe(String(connectionCount));
    expect(button.find(".player-name").text()).toContain("Alice");
  });

  it("spells out the count once 2+ devices share a seat", () => {
    const wrapper = mountPicker({
      mode: "picker",
      players: [player({ name: "Alice", playerId: "p:1002", netId: 1002, connectionCount: 3 })]
    });
    const count = wrapper.find('[data-testid="connection-count"]');
    expect(count.exists()).toBe(true);
    expect(count.text()).toBe("3 controllers");
  });

  it("emits join with the player's name when a picker button is clicked (host or remote)", async () => {
    const wrapper = mountPicker({
      mode: "picker",
      players: [
        player({ playerId: "p:1", name: "Hosty", isHost: true, netId: 1, isMirrorSeat: false }),
        player({ name: "Bob", playerId: "p:1003", netId: 1003 })
      ]
    });
    const buttons = wrapper.findAll('[data-testid="player-picker"] button');
    await buttons[0].trigger("click");
    await buttons[1].trigger("click");
    // The option's playerId rides along so the host can resolve the exact SEAT (a label like "Player 1003" is not
    // a reliable key); the host row carries its own id and is recognised server-side as "watch host".
    expect(wrapper.emitted("join")).toEqual([["Hosty", "p:1"], ["Bob", "p:1003"]]);
  });

  it("emits join with the typed name on form submit (Enter/submit)", async () => {
    const wrapper = mountPicker({ mode: "picker-with-name" });
    await wrapper.find('[data-testid="join-name-input"]').setValue("Newbie");
    await wrapper.find('[data-testid="join-form"]').trigger("submit");
    // A free-text submit carries NO playerId — there is no seat yet, so the host resolves it by name as before.
    expect(wrapper.emitted("join")).toEqual([["Newbie", undefined]]);
  });

  it("renders host + mirror seats only, hiding genuine remote players", () => {
    const wrapper = mountPicker({
      mode: "picker",
      players: [
        player({ playerId: "p:1", name: "Hosty", isHost: true, netId: 1, isMirrorSeat: false, isLocal: false }),
        player({ playerId: "p:1002", name: "Alice", netId: 1002, isMirrorSeat: true, isLocal: false }),
        player({ playerId: "p:1000", name: "Bob", netId: 1000, isMirrorSeat: false, isLocal: true })
      ]
    });
    const names = wrapper.findAll('[data-testid="player-picker"] .player-name').map((n) => n.text());
    expect(names.some((n) => n.includes("Hosty"))).toBe(true);
    // Kept despite isLocal:false — the seat, not the device's identity, is what the mirror roster keys on. This is
    // the rejoin case: a returning device has no local player yet.
    expect(names.some((n) => n.includes("Alice"))).toBe(true);
    // Dropped despite isLocal:true — the host cannot instance a mirror for a genuine remote player.
    expect(names.some((n) => n.includes("Bob"))).toBe(false);
    expect(wrapper.findAll('[data-testid="player-picker"] button')).toHaveLength(2);
  });

  // A ready seat nobody is on is the REJOIN row: highlighted, never dimmed, and tappable.
  it("keeps a seat with no controllers tappable (that IS the rejoin) and highlights it", async () => {
    const wrapper = mountPicker({
      mode: "picker",
      players: [player({ name: "Bob", playerId: "p:1003", netId: 1003, connectionCount: 0, disconnected: true })]
    });
    const button = wrapper.find('[data-testid="player-picker"] button');
    expect(button.classes()).toContain("claimable");
    expect(button.classes()).not.toContain("disconnected");
    expect(button.attributes("disabled")).toBeUndefined();
    await button.trigger("click");
    expect(wrapper.emitted("join")).toEqual([["Bob", "p:1003"]]);
  });

  // Both non-ready statuses render the SAME way — truly disabled with the server's reason — while staying separate
  // on the wire (different copy; only the zombie is auto-reaped host-side).
  it.each([
    ["stuck", "Cannot rejoin — host must restart the game", "host must restart the game"],
    ["offline", "Disconnected — the host must reload the saved run to let this seat rejoin", "reload the saved run"]
  ] as const)("renders a %s seat disabled with its reason and refuses the tap", async (status, reason, _expected) => {
    const wrapper = mountPicker({
      mode: "picker",
      players: [player({
        name: "Bob",
        playerId: "p:1003",
        netId: 1003,
        // A non-ready seat is never highlighted, whatever its controller count.
        connectionCount: 0,
        seatStatus: status,
        seatStatusReason: reason
      })]
    });
    const button = wrapper.find('[data-testid="player-picker"] button');
    expect(button.classes()).toContain("seat-unavailable");
    expect(button.classes()).not.toContain("claimable");
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.attributes("data-seat-status")).toBe(status);
    expect(wrapper.find('[data-testid="seat-status-reason"]').text()).toBe(
      status === "stuck" ? "This seat is stuck and cannot be joined right now." : "This player is offline and cannot be joined right now."
    );
    expect(wrapper.find('[data-testid="connection-count"]').exists()).toBe(false);
    await button.trigger("click");
    expect(wrapper.emitted("join")).toBeUndefined();
  });

  it("uses the mounted composition catalog for known Chinese seat statuses and leaves unknown status diagnostics verbatim", () => {
    createBrowserI18n("?lang=zh-Hans", { languages: ["en"] });
    const known = mountPicker({
      players: [player({ seatStatus: "offline", seatStatusReason: "Disconnected — host reset required" })]
    });
    expect(known.get('[data-testid="seat-status-reason"]').text()).toBe("该玩家已离线，目前无法加入。");
    known.unmount();

    const unknown = mountPicker({
      players: [player({ seatStatus: "vendor-paused" as unknown as BrowserPlayerOption["seatStatus"], seatStatusReason: "Vendor diagnostic: resume 42" })]
    });
    expect(unknown.get('[data-testid="seat-status-reason"]').text()).toBe("Vendor diagnostic: resume 42");
    unknown.unmount();
  });

  // A non-ready status on the HOST row is meaningless (the host is not a seat the mod instances) and must never
  // disable the one row that always works.
  it("never disables the host row over a seat status", () => {
    const wrapper = mountPicker({
      mode: "picker",
      players: [player({
        playerId: "p:1",
        name: "Hosty",
        isHost: true,
        netId: 1,
        isMirrorSeat: false,
        seatStatus: "offline"
      })]
    });
    const host = wrapper.find('[data-testid="player-picker"] button');
    expect(host.attributes("disabled")).toBeUndefined();
    expect(host.classes()).not.toContain("seat-unavailable");
  });

  it("renders the rejection message above the picker", () => {
    const wrapper = mountPicker({ mode: "picker", message: "That name is not from a session player." });
    const msg = wrapper.find('[data-testid="mirror-join-message"]');
    expect(msg.exists()).toBe(true);
    expect(msg.text()).toContain("not from a session player");
  });

  // WS-8: a dropped connection is title-only (no roster to show), so the message surface must render there too,
  // not only over the picker.
  it("renders the message in title-only mode too (the disconnected state)", () => {
    const wrapper = mountPicker({
      mode: "title-only",
      message: REJECTION_MESSAGE
    });
    expect(wrapper.find('[data-testid="screen-title-only-view"]').exists()).toBe(true);
    const msg = wrapper.find('[data-testid="mirror-join-message"]');
    expect(msg.exists()).toBe(true);
    expect(msg.text()).toContain("can't be joined");
  });

  // The SECOND line: the host's own words for a fault the friendly line can only gesture at. Every other
  // rejection code is self-describing, so this stays absent unless the parent supplies it.
  it("renders the server detail under the message when there is one", () => {
    const wrapper = mountPicker({
      mode: "picker",
      message: "Couldn't start your game view.",
      detail: "The given key 'MALLOC_ARENA_MAX' was not present in the dictionary."
    });
    const line = wrapper.find('[data-testid="mirror-join-detail"]');
    expect(line.exists()).toBe(true);
    expect(line.text()).toContain("MALLOC_ARENA_MAX");
  });

  it("renders no detail line without a detail, or without a message to hang it under", () => {
    expect(
      mountPicker({ mode: "picker", message: REJECTION_MESSAGE })
        .find('[data-testid="mirror-join-detail"]').exists()
    ).toBe(false);
    // A detail with no message would be an unexplained stack trace floating over the roster.
    expect(
      mountPicker({ mode: "picker", message: null, detail: "orphaned detail" })
        .find('[data-testid="mirror-join-detail"]').exists()
    ).toBe(false);
  });
});

// R9 item 8 — the pre-game LOADING states. The defect: `screenTitle || placeholder` meant a REMEMBERED screen
// name always outranked the lifecycle word, so a viewer waiting out a 20-60s cold headless spawn read "Run" and
// had no signal at all that anything was happening.
describe("MirrorJoinPicker — transient lifecycle states", () => {
  it("keeps the game's own screen title on a STEADY TITLE-ONLY screen (the placeholder stays a fallback)", () => {
    // R19 WP-2 moved the PICKER's steady heading (see the copy describe below); title-only is unchanged, because
    // on that screen the heading is the only thing there is.
    const steady = mountPicker({
      mode: "title-only",
      screenTitle: "Run",
      placeholder: "Waiting for the game…",
      transient: false
    });
    expect(steady.find("h1").text()).toBe("Run");
    // …and with no screen title yet, the fallback still shows.
    const noTitle = mountPicker({
      mode: "title-only",
      screenTitle: null,
      placeholder: "Waiting for the game…",
      transient: false
    });
    expect(noTitle.find("h1").text()).toBe("Waiting for the game…");
  });

  it.each(["picker", "title-only"] as const)(
    "lets a transient word outrank the stale screen title (%s mode)",
    (mode) => {
      const wrapper = mountPicker({ mode, screenTitle: "Run", placeholder: "Joining…", transient: true });
      expect(wrapper.find("h1").text()).toBe("Joining…");
    }
  );

  it("falls back to the screen title if a transient state somehow has no word", () => {
    const wrapper = mountPicker({ screenTitle: "Run", placeholder: null, transient: true });
    expect(wrapper.find("h1").text()).toBe("Run");
  });

  it.each(["picker", "title-only"] as const)("shows the spinner only while transient (%s mode)", (mode) => {
    const busy = mountPicker({ mode, placeholder: "Loading…", transient: true });
    const spinner = busy.find('[data-testid="mirror-spinner"]');
    expect(spinner.exists()).toBe(true);
    // A live-region-friendly busy marker, not a decorative div nobody can perceive.
    expect(spinner.attributes("role")).toBe("status");
    expect(mountPicker({ mode, transient: false }).find('[data-testid="mirror-spinner"]').exists()).toBe(false);
  });

  // A notice can arrive WITH a transient word: the word says what we're doing, the message says what happened.
  // Both surfaces must coexist.
  it("renders a notice alongside the transient word", () => {
    const wrapper = mountPicker({
      mode: "title-only",
      placeholder: "Reconnecting…",
      transient: true,
      message: REJECTION_MESSAGE
    });
    expect(wrapper.find("h1").text()).toBe("Reconnecting…");
    expect(wrapper.find('[data-testid="mirror-join-message"]').text()).toContain("can't be joined");
  });

  // The Android APK hint is GONE from every pre-game state (the native client is paused, so pointing phones at it
  // would advertise an app nobody maintains). The host still serves the route + envelope field for side-loading;
  // nothing renders it. Asserted on a phone-shaped navigator, which is the only UA that ever showed it.
  it.each(["picker", "picker-with-name", "title-only"] as const)(
    "never renders an Android APK hint on %s, even on an Android UA",
    (mode) => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36",
        configurable: true
      });
      const wrapper = mountPicker({ mode, transient: false });
      expect(wrapper.find('[data-testid="android-install-hint"]').exists()).toBe(false);
      expect(wrapper.text()).not.toContain("install the native app");
    }
  );

  // Both shapes render from ONE markup now (they used to be two <section>s with duplicated notice + hint blocks);
  // pin the per-mode DOM contract the e2e suites and the auto-player driver read.
  it("keeps each mode's testids and chrome after the markup dedupe", () => {
    const picker = mountPicker({ mode: "picker" });
    expect(picker.find('[data-testid="mirror-join-picker-view"]').exists()).toBe(true);
    expect(picker.find('[data-testid="screen-title-only-view"]').exists()).toBe(false);
    expect(picker.find('[data-testid="player-picker"]').exists()).toBe(true);
    // R19 WP-2: a STEADY picker carries neither the kicker nor the screen-title <h1> (see the copy describe).
    expect(picker.find(".surface-kicker").exists()).toBe(false);
    expect(picker.find("h1").exists()).toBe(false);
    expect(picker.find('[data-testid="runtime-screen"]').exists()).toBe(false);

    const titleOnly = mountPicker({ mode: "title-only" });
    expect(titleOnly.find('[data-testid="screen-title-only-view"]').classes()).toContain("title-only-view");
    expect(titleOnly.find('[data-testid="mirror-join-picker-view"]').exists()).toBe(false);
    expect(titleOnly.find('[data-testid="runtime-screen"]').exists()).toBe(true);
    expect(titleOnly.find(".surface-kicker").exists()).toBe(false);
  });
});

// The pure derivation behind the prop above.
describe("computeMirrorLoadingState", () => {
  const steady = {
    status: "connected",
    reconnectPhase: "steady",
    pendingName: null,
    hasView: false,
    sceneShowing: false
  } as const;

  it("is null on a steady picker — the screen title owns the heading there", () => {
    expect(computeMirrorLoadingState(steady)).toBeNull();
  });

  it("reports the first connect", () => {
    expect(computeMirrorLoadingState({ ...steady, status: "connecting" })).toBe("connecting");
    expect(mirrorLoadingLabel("connecting")).toBe("Connecting…");
  });

  it("reports a join in flight — including a cold headless spawn", () => {
    expect(computeMirrorLoadingState({ ...steady, pendingName: "Alice" })).toBe("joining");
    expect(mirrorLoadingLabel("joining")).toBe("Joining…");
  });

  it("reports the granted-view-but-no-frames gap, even while the new socket is still opening", () => {
    expect(computeMirrorLoadingState({ ...steady, hasView: true })).toBe("loading");
    expect(computeMirrorLoadingState({ ...steady, status: "connecting", hasView: true })).toBe("loading");
    // …and stops the moment the scene is up.
    expect(computeMirrorLoadingState({ ...steady, hasView: true, sceneShowing: true })).toBeNull();
    expect(mirrorLoadingLabel("loading")).toBe("Loading…");
  });

  it("reports a drop as 'reconnecting' only while there is no socket", () => {
    expect(computeMirrorLoadingState({ ...steady, reconnectPhase: "reconnecting", status: "disconnected" }))
      .toBe("reconnecting");
    expect(computeMirrorLoadingState({ ...steady, reconnectPhase: "lost", status: "connecting" }))
      .toBe("reconnecting");
    // Back on a live socket the picker is usable again, so the heading returns to the screen — the escalated
    // NOTICE (not the heading) is what still explains the situation.
    expect(computeMirrorLoadingState({ ...steady, reconnectPhase: "lost", status: "connected" })).toBeNull();
    expect(mirrorLoadingLabel("reconnecting")).toBe("Reconnecting…");
  });

  it("prefers the more advanced step when an auto-rejoin fires mid-reconnect", () => {
    expect(
      computeMirrorLoadingState({
        ...steady,
        reconnectPhase: "reconnecting",
        status: "disconnected",
        pendingName: "Alice"
      })
    ).toBe("joining");
  });

  it("has no label for a steady screen", () => {
    expect(mirrorLoadingLabel(null)).toBeNull();
  });
});
