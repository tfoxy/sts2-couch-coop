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

  it("resolves only active connected sessions across redirect, disconnect, and unmount", async () => {
    app = mount(MirrorApp, { global: { stubs: { MirrorView: true } } });
    await settle();
    const host = Socket.instances[0]!;

    host.emit(session(NEOW, { headlessMirrorPort: 14000 }));
    await settle();
    expect(gate.resolve).toHaveBeenCalledTimes(1);
    expect(gate.resolve).toHaveBeenLastCalledWith(NEOW, true);
    const seat = Socket.instances[1]!;

    // The redirect has made `host` stale. Its later callback cannot resolve or release the held gate.
    host.emit(session(OTHER_VIEW));
    await settle();
    expect(gate.resolve).toHaveBeenCalledTimes(1);

    seat.emit(session(OTHER_VIEW));
    await settle();
    expect(gate.resolve).toHaveBeenCalledTimes(2);
    expect(gate.resolve).toHaveBeenLastCalledWith(OTHER_VIEW, true);

    seat.close();
    await settle();
    expect(gate.resolve).toHaveBeenCalledTimes(2);

    app.unmount();
    app = null;
    await settle();
    expect(gate.resolve).toHaveBeenCalledTimes(2);
  });
});
