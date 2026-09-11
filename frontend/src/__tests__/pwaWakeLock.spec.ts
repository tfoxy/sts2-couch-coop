import { beforeEach, describe, expect, it } from "vitest";

import { installScreenWakeLock, type WakeLockApiLike, type WakeLockSentinelLike } from "@/pwa/wakeLock";

class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  private readonly listeners: (() => void)[] = [];

  addEventListener(_type: "release", listener: () => void): void {
    this.listeners.push(listener);
  }

  removeEventListener(_type: "release", listener: () => void): void {
    const at = this.listeners.indexOf(listener);
    if (at >= 0) this.listeners.splice(at, 1);
  }

  async release(): Promise<void> {
    this.markReleased();
  }

  /** Simulate the UA dropping the lock on its own (page hidden, battery saver). */
  markReleased(): void {
    if (this.released) return;
    this.released = true;
    for (const listener of [...this.listeners]) listener();
  }
}

class FakeTarget {
  readonly listeners = new Map<string, (() => void)[]>();

  addEventListener(type: string, listener: () => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: () => void): void {
    const bucket = this.listeners.get(type) ?? [];
    const at = bucket.indexOf(listener);
    if (at >= 0) bucket.splice(at, 1);
  }

  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  count(type: string): number {
    return (this.listeners.get(type) ?? []).length;
  }
}

class FakeDocument extends FakeTarget {
  visibilityState = "visible";
}

interface Harness {
  doc: FakeDocument;
  win: FakeTarget;
  api: WakeLockApiLike;
  sentinels: FakeSentinel[];
  requests: number;
  fail: { value: boolean };
}

function harness(): Harness {
  const doc = new FakeDocument();
  const win = new FakeTarget();
  const sentinels: FakeSentinel[] = [];
  const fail = { value: false };
  const state = { requests: 0 };

  const api: WakeLockApiLike = {
    request: async () => {
      state.requests += 1;
      if (fail.value) throw new DOMException("not allowed", "NotAllowedError");
      const sentinel = new FakeSentinel();
      sentinels.push(sentinel);
      return sentinel;
    }
  };

  return {
    doc,
    win,
    api,
    sentinels,
    fail,
    get requests() {
      return state.requests;
    }
  } as Harness;
}

describe("screen wake lock", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("is completely inert where the API is missing", () => {
    // This IS the plain-HTTP LAN path: `navigator.wakeLock` is undefined on an insecure origin.
    const handle = installScreenWakeLock({ wakeLock: undefined, document: h.doc, window: h.win });
    expect(handle.isSupported).toBe(false);
    expect(handle.isHeld()).toBe(false);
    expect(h.doc.count("visibilitychange")).toBe(0);
    expect(h.win.count("pagehide")).toBe(0);
    handle.dispose();
  });

  it("acquires on install when the document is visible", async () => {
    const handle = installScreenWakeLock({ wakeLock: h.api, document: h.doc, window: h.win });
    await handle.acquire();
    expect(handle.isHeld()).toBe(true);
    expect(h.requests).toBe(1);
    handle.dispose();
  });

  it("does not request from a hidden document", async () => {
    h.doc.visibilityState = "hidden";
    const handle = installScreenWakeLock({ wakeLock: h.api, document: h.doc, window: h.win });
    await handle.acquire();
    expect(h.requests).toBe(0);
    expect(handle.isHeld()).toBe(false);
    handle.dispose();
  });

  it("re-acquires when the page becomes visible again", async () => {
    const handle = installScreenWakeLock({ wakeLock: h.api, document: h.doc, window: h.win });
    await handle.acquire();
    expect(handle.isHeld()).toBe(true);

    // Backgrounding the tab: the UA releases the lock for us.
    h.doc.visibilityState = "hidden";
    h.sentinels[0].markReleased();
    h.doc.emit("visibilitychange");
    expect(handle.isHeld()).toBe(false);

    h.doc.visibilityState = "visible";
    h.doc.emit("visibilitychange");
    await Promise.resolve();
    await Promise.resolve();
    expect(h.requests).toBe(2);
    expect(handle.isHeld()).toBe(true);
    handle.dispose();
  });

  it("does not stack duplicate locks", async () => {
    const handle = installScreenWakeLock({ wakeLock: h.api, document: h.doc, window: h.win });
    await Promise.all([handle.acquire(), handle.acquire(), handle.acquire()]);
    await handle.acquire();
    expect(h.requests).toBe(1);
    handle.dispose();
  });

  it("retries once on the next user gesture after a rejection", async () => {
    h.fail.value = true;
    const handle = installScreenWakeLock({ wakeLock: h.api, document: h.doc, window: h.win });
    await handle.acquire();
    expect(handle.isHeld()).toBe(false);
    expect(h.doc.count("pointerdown")).toBe(1);

    h.fail.value = false;
    h.doc.emit("pointerdown");
    await Promise.resolve();
    await Promise.resolve();
    expect(handle.isHeld()).toBe(true);
    // One-shot: the retry listeners are gone, they don't fire on every subsequent tap.
    expect(h.doc.count("pointerdown")).toBe(0);
    expect(h.doc.count("keydown")).toBe(0);
    handle.dispose();
  });

  it("releases on pagehide", async () => {
    const handle = installScreenWakeLock({ wakeLock: h.api, document: h.doc, window: h.win });
    await handle.acquire();
    h.win.emit("pagehide");
    await Promise.resolve();
    expect(h.sentinels[0].released).toBe(true);
    expect(handle.isHeld()).toBe(false);
    handle.dispose();
  });

  it("releases and unhooks everything on dispose", async () => {
    const handle = installScreenWakeLock({ wakeLock: h.api, document: h.doc, window: h.win });
    await handle.acquire();
    handle.dispose();
    await Promise.resolve();

    expect(h.sentinels[0].released).toBe(true);
    expect(h.doc.count("visibilitychange")).toBe(0);
    expect(h.win.count("pagehide")).toBe(0);

    // Idempotent, and no further requests after teardown.
    handle.dispose();
    await handle.acquire();
    expect(h.requests).toBe(1);
  });
});
