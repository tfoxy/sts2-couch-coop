import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

const gate = vi.hoisted(() => ({
  resolve: vi.fn(),
  create: vi.fn()
}));

vi.mock("@/mirror/imagePrefetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/imagePrefetch")>();
  gate.create.mockImplementation(() => ({ resolve: gate.resolve }));
  return { ...actual, createMirrorImagePrefetchGate: gate.create };
});

import MirrorApp from "@/mirror/MirrorApp.vue";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { replaySession } from "../../../../scripts/lib/replay-session.mjs";

const NEOW = { scenePath: "res://scenes/events/background_scenes/neow.tscn", url: "/bg/events/neow?v=1" };
const OTHER_VIEW = { scenePath: "res://scenes/events/background_scenes/darv.tscn", url: "/bg/events/darv?v=1" };
// The seat's own descriptors for the same scenes: same scenePath, the SEAT's probed frame. A seat view shows the
// HOST's descriptor (the host's `/bg/` route does not render the seat's), so that is what resolves the gate too.
const SEAT_OTHER_VIEW = { ...OTHER_VIEW, url: "/bg/events/darv?frame=seat&v=1" };
const THIRD_VIEW = { scenePath: "res://scenes/events/background_scenes/tezcatara.tscn", url: "/bg/events/tezcatara?v=1" };
const SEAT_THIRD_VIEW = { ...THIRD_VIEW, url: "/bg/events/tezcatara?frame=seat&v=1" };

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = Socket.OPEN;
  sent: unknown[] = [];

  constructor(readonly url: string) {
    super();
    Socket.instances.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  emit(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
};

function session(staticBackground: typeof NEOW, extra: Record<string, unknown> = {}) {
  return { ...JSON.parse(replaySession([])), directView: false, staticBackground, ...extra };
}

describe("MirrorApp initial-view prefetch wiring", () => {
  let app: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    Socket.instances = [];
    gate.resolve.mockClear();
    gate.create.mockClear();
    mirrorSettings.staticBgEnabled = true;
    vi.stubGlobal("WebSocket", Socket);
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    vi.unstubAllGlobals();
  });

  it("resolves only active connected views across redirect, disconnect, and unmount", async () => {
    app = mount(MirrorApp, { global: { stubs: { MirrorView: true } } });
    await settle();
    const host = Socket.instances[0]!;

    host.emit(session(NEOW, { headlessMirrorPort: 14000 }));
    await settle();
    expect(gate.resolve).toHaveBeenCalledTimes(1);
    expect(gate.resolve).toHaveBeenLastCalledWith(NEOW, true);
    const seat = Socket.instances[1]!;

    // The redirect made `host` a gated side channel. Its sessions still arrive (they are where a seat view's
    // background comes from), but one alone never resolves the view: the seat has not said what it shows yet.
    host.emit(session(OTHER_VIEW));
    await settle();
    expect(gate.resolve).toHaveBeenCalledTimes(1);

    // The seat names its scene; the view that resolves is the HOST's descriptor for it, not the seat's.
    seat.emit(session(SEAT_OTHER_VIEW));
    await settle();
    expect(gate.resolve).toHaveBeenCalledTimes(2);
    expect(gate.resolve).toHaveBeenLastCalledWith(OTHER_VIEW, true);

    // Seat a room ahead of the host: its picture is still coming, so the view is not resolved on "no picture"…
    seat.emit(session(SEAT_THIRD_VIEW));
    await settle();
    expect(gate.resolve).toHaveBeenCalledTimes(2);
    // …until the host describes that room.
    host.emit(session(THIRD_VIEW));
    await settle();
    expect(gate.resolve).toHaveBeenCalledTimes(3);
    expect(gate.resolve).toHaveBeenLastCalledWith(THIRD_VIEW, true);

    seat.close();
    await settle();
    expect(gate.resolve).toHaveBeenCalledTimes(3);

    app.unmount();
    app = null;
    await settle();
    expect(gate.resolve).toHaveBeenCalledTimes(3);
  });
});
