import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import MirrorApp from "@/mirror/MirrorApp.vue";
import SettingsPanel from "@/mirror/SettingsPanel.vue";
import type { MirrorLatency } from "@/mirror/mirrorClient";
import {
  createMirrorSettings,
  DEFAULT_REFRESH_RATE,
  mirrorSettings,
  persistMirrorSetting,
  seedServerSettingsFromSession
} from "@/mirror/mirrorSettings";
import type { RenderQuality, RenderQualityTier } from "@/render/quality";

// WS-2 (web half): the "Host performance" checkboxes must show what the game SERVING THIS CONNECTION actually has
// frozen, from the moment the viewer joins — including a direct-view viewer, whose game is the host's own windowed
// one, where the mod never installs the visual suspender and therefore NOTHING is frozen. They used to be hardcoded
// `true` and pushed as-is on join, so that viewer saw three ticked boxes over a game freezing nothing, and the push
// itself was the client asserting its own fiction at the host.
//
// The rule under test is an ORDER: seed from the connection's `session` FIRST, push (an echo, hence a no-op) second,
// and re-seed per CONNECTION so a host socket's "nothing frozen" never lands on the headless instance the viewer is
// redirected to.

const latency: MirrorLatency = {
  lastMs: 28,
  p50: 12,
  p95: 30,
  count: 7,
  gameLastMs: null,
  gameP50: null,
  gameP95: null,
  gameCount: 0
};

function quality(overrides: Partial<RenderQuality> = {}): RenderQuality {
  const tier: RenderQualityTier = "high";
  return {
    tier,
    shadersEnabled: true,
    shadersStatic: false,
    particlesEnabled: true,
    spineClipsEnabled: true,
    spineClipFps: 0,
    renderScale: 1,
    shaderFps: 0,
    particleFps: 30,
    maxTextureDim: 4096,
    maxTrailPoints: 0,
    staticShaderScale: 1,
    staticParticleScale: 1,
    source: "default",
    ...overrides
  };
}

describe("seedServerSettingsFromSession", () => {
  it("adopts a windowed host's all-false state over the client's headless-shaped defaults", () => {
    const settings = createMirrorSettings(quality());
    expect(settings.freezeParticles).toBe(true); // the fallback the panel used to be stuck on

    const seeded = seedServerSettingsFromSession(settings, {
      freezeParticles: false,
      freezeSpines: false,
      freezeDecor: false
    });

    expect(seeded).toBe(true);
    expect(settings.freezeParticles).toBe(false);
    expect(settings.freezeSpines).toBe(false);
    expect(settings.freezeDecor).toBe(false);
  });

  it("leaves the defaults alone when the host reports nothing (older host / no-Godot harness)", () => {
    const settings = createMirrorSettings(quality());

    expect(seedServerSettingsFromSession(settings, null)).toBe(false);
    expect(seedServerSettingsFromSession(settings, {})).toBe(false);
    expect(seedServerSettingsFromSession(settings, { freezeParticles: null })).toBe(false);
    expect(settings.freezeParticles).toBe(true);
    expect(settings.freezeSpines).toBe(true);
    expect(settings.freezeDecor).toBe(true);
  });

  it("seeds each lever independently (a host with one freeze switched off)", () => {
    const settings = createMirrorSettings(quality());

    expect(seedServerSettingsFromSession(settings, { freezeSpines: false })).toBe(true);
    expect(settings.freezeSpines).toBe(false);
    expect(settings.freezeParticles).toBe(true);
    expect(settings.freezeDecor).toBe(true);
  });
});

describe("SettingsPanel — Host performance copy", () => {
  beforeEach(() => {
    mirrorSettings.panelOpen = true;
  });
  afterEach(() => {
    mirrorSettings.panelOpen = false;
  });

  it("keeps the invisible-to-you note for a per-seat headless viewer", () => {
    const wrapper = mount(SettingsPanel, { props: { latency } });
    expect(wrapper.find('[data-testid="mirror-host-perf-note"]').text()).toBe(
      "Cuts headless-host CPU. Doesn't change what you see."
    );
  });

  it("warns a direct-view viewer that the freeze lands on the host's own screen", () => {
    const wrapper = mount(SettingsPanel, { props: { latency, directView: true } });
    const note = wrapper.find('[data-testid="mirror-host-perf-note"]').text();
    expect(note).toContain("host's own game");
    expect(note).not.toContain("Doesn't change what you see");
  });
});

// The WIRING, driven through the real component with a fake socket — the seed/push ORDER only exists in MirrorApp's
// callbacks, so neither pure test above can catch a regression in it.
describe("MirrorApp — Host performance seeding", () => {
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

  let realWebSocket: unknown;
  let app: ReturnType<typeof mount> | null = null;

  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();
  };
  const latest = () => MockWebSocket.instances[MockWebSocket.instances.length - 1];

  // A `session` envelope with the freeze truth of whichever instance is answering.
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
      scrollAction: true,      ...over
    };
  }

  // The host's OWN game: windowed, so the suspender was never installed and nothing is frozen.
  const HOST_FREEZES = { freezeParticles: false, freezeSpines: false, freezeDecor: false };
  // A spawned per-seat headless instance: the suspender IS installed, with its env defaults.
  const HEADLESS_FREEZES = { freezeParticles: true, freezeSpines: true, freezeDecor: true };

  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    globalThis.sessionStorage?.clear();
    globalThis.localStorage?.clear(); // R10 WS-A: a saved refresh rate changes the seed rule below
    MockWebSocket.instances = [];
    realWebSocket = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
    // The store is an app-wide singleton: start every drill from the shipped (headless-shaped) defaults so a
    // seeding failure shows up as a stale `true` rather than leaking the previous test's value.
    mirrorSettings.freezeParticles = true;
    mirrorSettings.freezeSpines = true;
    mirrorSettings.freezeDecor = true;
    mirrorSettings.refreshRate = DEFAULT_REFRESH_RATE;
    mirrorSettings.panelOpen = true;
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    mirrorSettings.panelOpen = false;
    mirrorSettings.freezeParticles = true;
    mirrorSettings.freezeSpines = true;
    mirrorSettings.freezeDecor = true;
    mirrorSettings.refreshRate = DEFAULT_REFRESH_RATE;
    globalThis.localStorage?.clear();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket;
  });

  // THE user report: watching the host's own game, the boxes claimed three freezes the host does not have.
  it("a direct-view viewer sees the HOST's real state (all unchecked) and pushes it back unchanged", async () => {
    app = mount(MirrorApp);
    await settle();

    // A singleplayer run: the app asks for direct view itself (one empty-name join).
    latest().emit(
      sessionMessage({
        screen: { kind: "run", type: "Run", title: "Run", mirrorMode: "singleplayer-run" },
        ...HOST_FREEZES
      })
    );
    await settle();
    expect(latest().sentOfType("join")).toHaveLength(1);

    latest().emit(
      sessionMessage({
        screen: { kind: "run", type: "Run", title: "Run", mirrorMode: "singleplayer-run" },
        directView: true,
        ...HOST_FREEZES
      })
    );
    await settle();

    expect(mirrorSettings.freezeParticles).toBe(false);
    expect(mirrorSettings.freezeSpines).toBe(false);
    expect(mirrorSettings.freezeDecor).toBe(false);

    // …and the checkboxes render that, rather than the store's fallback.
    const box = (id: string) => app!.find(`[data-testid="${id}"]`).element as HTMLInputElement;
    expect(box("mirror-freeze-particles").checked).toBe(false);
    expect(box("mirror-freeze-spines").checked).toBe(false);
    expect(box("mirror-freeze-decor").checked).toBe(false);
    // The copy tells the truth about WHOSE screen this freezes.
    expect(app.find('[data-testid="mirror-host-perf-note"]').text()).toContain("host's own game");

    // ANTI-STOMP: the one-shot push echoes the host's own values. Before the seed existed it sent all-true, which
    // asked the host's live game to freeze three things nobody had asked to freeze.
    const pushes = latest().sentOfType("settings");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ freezeParticles: false, freezeSpines: false, freezeDecor: false });
  });

  it("a viewer's toggle reaches the direct-view (host) socket", async () => {
    app = mount(MirrorApp);
    await settle();
    latest().emit(
      sessionMessage({
        screen: { kind: "run", type: "Run", title: "Run", mirrorMode: "singleplayer-run" },
        ...HOST_FREEZES
      })
    );
    await settle();
    latest().emit(
      sessionMessage({
        screen: { kind: "run", type: "Run", title: "Run", mirrorMode: "singleplayer-run" },
        directView: true,
        ...HOST_FREEZES
      })
    );
    await settle();

    await app.find('[data-testid="mirror-freeze-particles"]').setValue(true);
    await settle();

    const pushes = latest().sentOfType("settings");
    expect(pushes).toHaveLength(2); // the seeded echo, then the viewer's change
    expect(pushes[1]).toMatchObject({ freezeParticles: true, freezeSpines: false, freezeDecor: false });
  });

  // The other direction of the same rule: the host connection's "nothing frozen" must NOT follow the viewer onto
  // their own headless instance, which really is frozen — that would silently undo the CPU saver on every join.
  it("re-seeds from the per-seat headless instance after the redirect", async () => {
    app = mount(MirrorApp);
    await settle();
    latest().emit(sessionMessage(HOST_FREEZES));
    await settle();
    expect(mirrorSettings.freezeParticles).toBe(false); // the host connection's truth, pre-join

    const rows = app.findAll('[data-testid="player-picker"] button');
    await rows[1].trigger("click");
    await settle();
    latest().emit(sessionMessage({ headlessMirrorPort: 14000, ...HOST_FREEZES }));
    await settle();

    // Redirected: a NEW socket, whose instance reports its own (frozen) state.
    const headless = latest();
    expect(headless.url).toContain("14000");
    headless.emit(sessionMessage({ session: { joined: true, name: "Alice", status: "assigned", playerId: "p:1003", connectionCount: 1 }, ...HEADLESS_FREEZES }));
    await settle();

    expect(mirrorSettings.freezeParticles).toBe(true);
    expect(mirrorSettings.freezeSpines).toBe(true);
    expect(mirrorSettings.freezeDecor).toBe(true);

    const pushes = headless.sentOfType("settings");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ freezeParticles: true, freezeSpines: true, freezeDecor: true });
  });

  // A host that reports nothing at all (pre-field, or no Godot on its probing path) must not be read as
  // "everything off" — the client keeps its own defaults, which is exactly how it behaved before this round.
  it("keeps the client defaults when the host reports no freeze state", async () => {
    app = mount(MirrorApp);
    await settle();
    latest().emit(
      sessionMessage({ screen: { kind: "run", type: "Run", title: "Run", mirrorMode: "singleplayer-run" } })
    );
    await settle();
    latest().emit(
      sessionMessage({
        screen: { kind: "run", type: "Run", title: "Run", mirrorMode: "singleplayer-run" },
        directView: true
      })
    );
    await settle();

    expect(mirrorSettings.freezeParticles).toBe(true);
    expect(mirrorSettings.freezeSpines).toBe(true);
    expect(mirrorSettings.freezeDecor).toBe(true);
    expect(latest().sentOfType("settings")[0]).toMatchObject({
      freezeParticles: true,
      freezeSpines: true,
      freezeDecor: true
    });
  });

  // R10 WS-A: the SERVER-tied fields a viewer's saved preference DOES own. `refreshRate` and `tweenReplay` ride
  // the same `settings` channel as the freezes, but they are preferences about this viewer's own stream rather
  // than truths about the instance — so the order contract runs the other way: the envelope seed steps aside for
  // a saved value, and the push that follows carries it TO the host.
  async function directViewWith(refreshRate: number) {
    app = mount(MirrorApp);
    await settle();
    const sp = { kind: "run", type: "Run", title: "Run", mirrorMode: "singleplayer-run" };
    latest().emit(sessionMessage({ screen: sp, refreshRate, ...HOST_FREEZES }));
    await settle();
    latest().emit(sessionMessage({ screen: sp, directView: true, refreshRate, ...HOST_FREEZES }));
    await settle();
  }

  it("adopts the host's reported refresh rate when the viewer has never chosen one", async () => {
    await directViewWith(40);
    expect(mirrorSettings.refreshRate).toBe(40);
    expect(latest().sentOfType("settings")[0]).toMatchObject({ refreshRate: 40 });
  });

  it("keeps a SAVED refresh rate over the host's baseline, and pushes the saved value to the game", async () => {
    persistMirrorSetting("refreshRate", 12);
    mirrorSettings.refreshRate = 12; // what createMirrorSettings applies on a fresh load

    await directViewWith(40);

    expect(mirrorSettings.refreshRate).toBe(12);
    const pushes = latest().sentOfType("settings");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ refreshRate: 12 });
  });

  it("pushes a saved tween-replay preference too (no envelope field competes for it)", async () => {
    persistMirrorSetting("tweenReplay", false);
    mirrorSettings.tweenReplay = false;
    try {
      await directViewWith(24);
      expect(latest().sentOfType("settings")[0]).toMatchObject({ tweenReplay: false });
    } finally {
      mirrorSettings.tweenReplay = true;
    }
  });
});
