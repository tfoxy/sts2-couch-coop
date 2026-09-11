import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mount } from "@vue/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import MirrorApp from "@/mirror/MirrorApp.vue";

// R21 B5 — DON'T RASTERIZE A FULL-SCREEN GRADIENT NOBODY CAN SEE.
//
// `.game-surface` paints a 135deg linear-gradient (styles.css). It is the app's backdrop: the thing seen AROUND
// the content — behind the join panels, in the letterbox bars, while a scene is loading. It is also, whenever the
// mirror has a scene up, completely hidden: MirrorView's ROOT element `.mirror-frame` is
// `position: absolute; inset: 0; background: #000`, a direct child of the surface, and an absolutely positioned
// child resolves `inset: 0` against its containing block's PADDING box — so it covers the standalone safe-area
// padding too. Firefox's software WebRender re-rasterizes the covered gradient anyway: 1.60 ms of a 42.5 ms
// composite, every frame, in the Sep-03 near-idle-combat profile.
//
// WHAT THIS FILE PINS, because the optimization is only correct while all of it is true:
//   1. the cover really is opaque and full-bleed (the PREMISE — break it and the class becomes a visual bug);
//   2. the class goes on EXACTLY when the cover is mounted, and comes off with it;
//   3. every state where the gradient is genuinely visible still gets it — the mirror picker and the loading
//      gap before a scene exists;
// NOT backend-specific, and that is the point worth restating: the DOM stage has no opaque canvas, but it has the
// same opaque `.mirror-frame`. Both arms are covered.

const surfaceCss = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
const mirrorViewSource = readFileSync(join(process.cwd(), "src/mirror/MirrorView.vue"), "utf8");

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

  // Deliberately SILENT — no `close` event. MirrorApp's `onBeforeUnmount` clears its reconnect timer and only
  // THEN closes its sockets, so a close dispatched at teardown re-arms a timer nothing is left to clear; it fires
  // in whichever file vitest runs next, after that file's jsdom `window` is gone. This spec never exercises the
  // drop/reconnect path (its subject is a class on the surface), so the honest fix here is to not provoke it.
  // The drop path itself is covered, with fake timers, by mirrorReconnect.spec.ts.
  close() {
    this.readyState = 3;
  }

  emit(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}

// The host sitting on its MAIN MENU: nothing to join, so the stream gate opens on the "title-only" branch and the
// viewer is shown the host's own screen. The shortest honest route to a mounted scene — no seat, no redirect.
const MAIN_MENU_SESSION = {
  type: "session",
  session: { name: null, status: "unassigned", joined: false, playerId: null, connectionCount: 0 },
  players: [],
  screen: { kind: "menu", type: "Menu", title: "Menu", mirrorMode: "main-menu" },
  hostName: "host",
  scrollAction: true,
  rewardAction: true
};

const SCENE_DELTA = {
  type: "scene-delta",
  full: true,
  screenType: "menu",
  upserts: [
    {
      id: "root",
      parentId: null,
      name: "Root",
      nodeType: "Control",
      visible: true,
      localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } },
      transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } }
    }
  ],
  orderedIds: ["root"]
};

let realWebSocket: unknown;
let app: ReturnType<typeof mount> | null = null;

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
  await nextTick();
};

const latest = () => MockWebSocket.instances[MockWebSocket.instances.length - 1];

/** Mount the mirror and drive it all the way to a rendered scene. */
async function mountWithScene(search = ""): Promise<ReturnType<typeof mount>> {
  window.history.replaceState(null, "", `/${search}`);
  app = mount(MirrorApp);
  await settle();
  latest().emit(MAIN_MENU_SESSION);
  await settle();
  latest().emit(SCENE_DELTA);
  await settle();
  return app;
}

const surface = (wrapper: ReturnType<typeof mount>) => wrapper.get('[data-testid="mirror-surface"]');

// MirrorView fits the stage with one (jsdom has none). The mirror mounts for REAL here on purpose — a stub of it
// would let the class and the cover it claims to track drift apart, which is the entire risk this file exists for.
beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});
beforeEach(() => {
  window.history.replaceState(null, "", "/");
  sessionStorage.clear();
  localStorage.clear();
  MockWebSocket.instances = [];
  realWebSocket = globalThis.WebSocket;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
});

afterEach(() => {
  app?.unmount();
  app = null;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket;
  MockWebSocket.instances = [];
  sessionStorage.clear();
  localStorage.clear();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

// ---- 1. the premise ------------------------------------------------------------------------------------------

describe("the cover the optimization depends on", () => {
  // If `.mirror-frame` ever stops being an opaque full-bleed fill, dropping the gradient beneath it stops being
  // free and starts being a hole in the app. This is the one assertion that must fail LOUDLY in that commit.
  it("MirrorView's root is an opaque, full-bleed, inset-0 fill", () => {
    const rule = /\.mirror-frame\s*\{([^}]*)\}/.exec(mirrorViewSource);
    expect(rule).not.toBeNull();
    const body = rule![1];
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/inset:\s*0/);
    // Opaque, and opaque BLACK specifically: the mirror's letterbox bars are this colour, never the gradient.
    expect(body).toMatch(/background:\s*#000\b/);
  });

  it("the surface paints the gradient, and the covered rule is what cancels it", () => {
    expect(surfaceCss).toMatch(/\.game-surface\s*\{[^}]*background:\s*linear-gradient\(/);
    expect(surfaceCss).toMatch(/\.game-surface\.surface-covered\s*\{[^}]*background:\s*none/);
  });
});

// ---- 2. the class tracks the cover ---------------------------------------------------------------------------

describe("MirrorApp — the gradient is dropped exactly while it is covered", () => {
  it("drops it once a scene is mounted, and the cover is really there", async () => {
    const wrapper = await mountWithScene();

    // The cover exists AND is a direct child of the surface — `inset: 0` only spans the surface because the
    // surface is its containing block (`.mirror-surface { position: relative }`).
    expect(wrapper.find('[data-testid="mirror-surface"] > .mirror-frame').exists()).toBe(true);
    expect(surface(wrapper).classes()).toContain("surface-covered");
  });

  it("keeps it on the pre-join picker — no scene, no cover, nothing to hide behind", async () => {
    window.history.replaceState(null, "", "/");
    app = mount(MirrorApp);
    await settle();

    expect(app.find(".mirror-frame").exists()).toBe(false);
    expect(surface(app).classes()).not.toContain("surface-covered");
    // …and the picker really is what is on screen, so this is the state a viewer sees rather than a mount artifact.
    expect(app.find('[data-testid="mirror-status"]').exists()).toBe(true);
  });

  it("keeps it in the loading gap — a session has landed but no scene has", async () => {
    window.history.replaceState(null, "", "/");
    app = mount(MirrorApp);
    await settle();
    latest().emit(MAIN_MENU_SESSION);
    await settle();

    // The stream gate is open (this viewer WILL be shown the host's screen) but no node has arrived, so there is
    // no `.mirror-frame` yet and the gradient is the backdrop of the wait.
    expect(app.find(".mirror-frame").exists()).toBe(false);
    expect(surface(app).classes()).not.toContain("surface-covered");
  });

  it("puts it back when the scene goes away", async () => {
    const wrapper = await mountWithScene();
    expect(surface(wrapper).classes()).toContain("surface-covered");

    // The host leaves the main menu for a screen this viewer must PICK a seat on: the gate shuts, the picker
    // returns, and the cover unmounts with it.
    latest().emit({
      ...MAIN_MENU_SESSION,
      screen: { kind: "lobby", type: "lobby", title: "Character Select", mirrorMode: "mp-character-select" },
      players: [
        { playerId: "p:1", name: "Hosty", isHost: true, isRunPlayer: true, connectionCount: 1, disconnected: false, isLocal: false, netId: null, isMirrorSeat: false, seatStatus: "ready", seatStatusReason: null, characterId: null },
        {
          playerId: "p:2",
          name: "Alice",
          isHost: false,
          isRunPlayer: true,
          connectionCount: 0,
          disconnected: false,
          isLocal: false,
          netId: 2,
          isMirrorSeat: true,
          seatStatus: "ready",
          seatStatusReason: null,
          characterId: null
        }
      ]
    });
    await settle();

    expect(wrapper.find(".mirror-frame").exists()).toBe(false);
    expect(surface(wrapper).classes()).not.toContain("surface-covered");
  });
});
