import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import MirrorApp from "@/mirror/MirrorApp.vue";
import { IOS_INSTALL_DISMISSED_STORAGE_KEY } from "@/join/joinModel";

// The WHOLE chromeless path, wired end to end at the one event it hangs off: the seat tap.
//
// Everything else in WS1/WS2 is unit-tested in isolation (the gate, the lock policy, the overlay component); what
// this file protects is the wiring, which is exactly what silently rots — a picker that stops emitting `join`
// through the seat-commit handler would leave every one of those unit tests green and the feature dead.

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

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  emit(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
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
  isRunPlayer: true,
  isHost: false,
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

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

function setUserAgent(value: string): void {
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value });
}

function setFullscreenEnabled(value: boolean): void {
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value });
}

// The seat-tap fullscreen entry is gated on a coarse pointer (it is a PHONE feature — see useFullscreen), and
// jsdom reports no media queries at all, so the whole path would be silently inert without this.
function pretendTouchDevice(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("pointer: coarse"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false
    })
  });
}

describe("MirrorApp — the seat tap is the chromeless trigger", () => {
  let realWebSocket: unknown;
  let realUserAgent: PropertyDescriptor | undefined;
  let realMatchMedia: PropertyDescriptor | undefined;
  let app: ReturnType<typeof mount> | null = null;
  let requestFullscreen: ReturnType<typeof vi.fn<() => Promise<void>>>;

  const settle = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();
  };
  const latest = (): MockWebSocket => MockWebSocket.instances[MockWebSocket.instances.length - 1];
  const seatRows = () => app!.findAll('[data-testid="player-picker"] button');

  async function mountWithRoster(): Promise<void> {
    app = mount(MirrorApp);
    await settle();
    latest().emit(sessionMessage());
    await settle();
  }

  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    globalThis.sessionStorage?.clear();
    globalThis.localStorage?.clear();
    MockWebSocket.instances = [];
    realWebSocket = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
    realUserAgent = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");
    realMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
    pretendTouchDevice();
    setFullscreenEnabled(true);
    setFullscreenElement(null);
    requestFullscreen = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = requestFullscreen;
  });

  function setFullscreenElement(element: Element | null): void {
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      writable: true,
      value: element
    });
  }

  afterEach(() => {
    app?.unmount();
    app = null;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket;
    if (realUserAgent) Object.defineProperty(window.navigator, "userAgent", realUserAgent);
    if (realMatchMedia) Object.defineProperty(window, "matchMedia", realMatchMedia);
    delete (document as unknown as Record<string, unknown>).fullscreenEnabled;
    delete (document as unknown as Record<string, unknown>).fullscreenElement;
    delete (document.documentElement as unknown as Record<string, unknown>).requestFullscreen;
    window.history.replaceState(null, "", "/");
    globalThis.localStorage?.clear();
    vi.restoreAllMocks();
  });

  // WS2: the tap IS the user activation `requestFullscreen()` demands. Asking anywhere else is asking for a
  // rejection.
  it("requests fullscreen from the seat tap, and still sends the join", async () => {
    setUserAgent(ANDROID_UA);
    await mountWithRoster();

    const seat = seatRows().find((row) => row.text().includes("Alice"))!;
    await seat.trigger("click");
    await settle();

    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    const joins = latest().sent.filter((message) => message.type === "join");
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({ name: "Alice", playerId: "p:1003" });
  });

  it("arms the iPhone install overlay on the tap — and nothing before it", async () => {
    setUserAgent(IPHONE_UA);
    await mountWithRoster();
    expect(app!.find('[data-testid="ios-install-overlay"]').exists()).toBe(false);

    await seatRows().find((row) => row.text().includes("Alice"))!.trigger("click");
    await settle();
    expect(app!.find('[data-testid="ios-install-overlay"]').exists()).toBe(true);
  });

  it("shows no overlay on Android — WS2's fullscreen path covers that platform", async () => {
    setUserAgent(ANDROID_UA);
    await mountWithRoster();
    await seatRows().find((row) => row.text().includes("Alice"))!.trigger("click");
    await settle();
    expect(app!.find('[data-testid="ios-install-overlay"]').exists()).toBe(false);
  });

  it("respects a previous dismissal on this device", async () => {
    setUserAgent(IPHONE_UA);
    globalThis.localStorage?.setItem(IOS_INSTALL_DISMISSED_STORAGE_KEY, "1");
    await mountWithRoster();
    await seatRows().find((row) => row.text().includes("Alice"))!.trigger("click");
    await settle();
    expect(app!.find('[data-testid="ios-install-overlay"]').exists()).toBe(false);
  });

  // An AUTO-join has no user gesture behind it, so fullscreen would only be refused — and an overlay would
  // appear over a screen the player never chose. `?name=` must therefore bypass the seat-commit handler.
  it("does not fire the chromeless path for a ?name= auto-join", async () => {
    setUserAgent(IPHONE_UA);
    window.history.replaceState(null, "", "/?name=Alice");
    app = mount(MirrorApp);
    await settle();
    latest().emit(sessionMessage());
    await settle();

    expect(latest().sent.filter((message) => message.type === "join")).toHaveLength(1);
    expect(requestFullscreen).not.toHaveBeenCalled();
    expect(app!.find('[data-testid="ios-install-overlay"]').exists()).toBe(false);
  });

  // The re-open pill (@/components/IosInstallButton.vue) shares FullscreenButton's slot and is mutually
  // exclusive with it by construction — one needs element fullscreen, the other its absence.
  it("shows the re-open pill instead of the fullscreen button on iPhone, and reopens the overlay past a permanent dismissal", async () => {
    setUserAgent(IPHONE_UA);
    setFullscreenEnabled(false); // iPhone Safari has no element Fullscreen API
    globalThis.localStorage?.setItem(IOS_INSTALL_DISMISSED_STORAGE_KEY, "1");
    await mountWithRoster();

    expect(app!.find('[data-testid="ios-install-button"]').exists()).toBe(true);
    expect(app!.find('[data-testid="fullscreen-button"]').exists()).toBe(false);
    // The permanent flag still suppresses the AUTO path (no overlay pre-tap).
    expect(app!.find('[data-testid="ios-install-overlay"]').exists()).toBe(false);

    await app!.get('[data-testid="ios-install-button"]').trigger("click");
    await settle();

    // The pill bypasses the flag, and a manual open shows the escape link immediately (no delay).
    expect(app!.find('[data-testid="ios-install-overlay"]').exists()).toBe(true);
    expect(app!.find('[data-testid="ios-install-stay"]').exists()).toBe(true);
  });

  it("shows the fullscreen button instead of the pill on Android", async () => {
    setUserAgent(ANDROID_UA);
    setFullscreenEnabled(true);
    await mountWithRoster();

    expect(app!.find('[data-testid="fullscreen-button"]').exists()).toBe(true);
    expect(app!.find('[data-testid="ios-install-button"]').exists()).toBe(false);
  });
});
