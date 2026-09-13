// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { beforeEach, describe, expect, it } from "vitest";

import {
  applyServiceWorkerPolicy,
  decideServiceWorkerAction,
  readServiceWorkerOverride,
  SERVICE_WORKER_URL
} from "@/pwa/registerServiceWorker";

/*
 * The service worker is a hand-written plain `.js` in public/ (no build step, no bundler entry), so it
 * cannot be imported. Instead it is evaluated in a `node:vm` context with a fake worker global scope —
 * which also means this spec fails loudly if the file stops parsing, and lets the cache-first /
 * offline-fallback / build-stamp-invalidation paths be exercised for real against a fake Cache Storage.
 *
 * Node's `Request` rejects relative URLs (a real worker resolves them against its own location), so the
 * context supplies a small Request shim; everything else is Node's own fetch-API globals.
 */

const SW_PATH = fileURLToPath(new URL("../../public/sw.js", import.meta.url));
const ORIGIN = "https://192-168-1-5.example.test:13337";

interface SwInternals {
  SHELL_CACHE: string;
  ASSET_CACHE: string;
  OFFLINE_URL: string;
  BUILD_STAMP_KEY: string;
  ASSET_IDENTITY_KEY: string;
  MAX_ENTRY_BYTES: number;
  extractBuildStamp(html: unknown): string | null;
  classifyRequest(request: unknown, origin: string): "navigate" | "asset" | "bypass";
  isCacheable(response: unknown, maxEntryBytes: number): boolean;
  planTrim(entries: { bytes: number }[], caps: { maxEntries: number; maxBytes: number }): number;
  trimAssetCache(): Promise<number>;
  reconcileBuildStamp(response: Response): Promise<boolean>;
  reconcileAssetIdentity(identity: unknown): Promise<boolean>;
  handleNavigation(request: unknown): Promise<Response>;
  handleAsset(request: unknown): Promise<Response>;
}

interface Snapshot {
  body: string;
  status: number;
  headers: Record<string, string>;
}

class FakeCache {
  // A Map is insertion-ordered, which is exactly the ordering guarantee the real Cache.keys() gives —
  // and the guarantee the FIFO trim relies on.
  readonly entries = new Map<string, Snapshot>();

  constructor(private readonly fetchImpl: (url: string) => Promise<Response>) {}

  private static keyOf(request: unknown): string {
    if (typeof request === "string") return new URL(request, ORIGIN).href;
    return new URL((request as { url: string }).url, ORIGIN).href;
  }

  async match(request: unknown): Promise<Response | undefined> {
    const snapshot = this.entries.get(FakeCache.keyOf(request));
    // Rebuild every time: a real Cache hands out a fresh Response, and reusing one would hit
    // "body already used" the second time it is read.
    return snapshot ? new Response(snapshot.body, { status: snapshot.status, headers: snapshot.headers }) : undefined;
  }

  async put(request: unknown, response: Response): Promise<void> {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    this.entries.set(FakeCache.keyOf(request), { body: await response.text(), status: response.status, headers });
  }

  async add(request: unknown): Promise<void> {
    const url = FakeCache.keyOf(request);
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`add() failed: ${response.status}`);
    await this.put(url, response);
  }

  async delete(request: unknown): Promise<boolean> {
    return this.entries.delete(FakeCache.keyOf(request));
  }

  async keys(): Promise<string[]> {
    return [...this.entries.keys()];
  }
}

class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>();

  constructor(private readonly fetchImpl: (url: string) => Promise<Response>) {}

  async open(name: string): Promise<FakeCache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache(this.fetchImpl);
      this.caches.set(name, cache);
    }
    return cache;
  }

  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
}

interface Harness {
  internals: SwInternals;
  storage: FakeCacheStorage;
  listeners: Map<string, ((event: unknown) => void)[]>;
  /** URL → response factory. A URL that is absent (or in `down`) fails like a dead host. */
  routes: Map<string, () => Response>;
  down: Set<string>;
  fetchCalls: string[];
  hostReachable: { value: boolean };
  makeRequest(url: string, init?: { method?: string; mode?: string; headers?: Record<string, string> }): unknown;
  dispatch(type: string, event: Record<string, unknown>): Promise<void>;
  skipWaitingCalls: number;
  claimCalls: number;
  unregisterCalls: number;
}

function createHarness(): Harness {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const routes = new Map<string, () => Response>();
  const down = new Set<string>();
  const fetchCalls: string[] = [];
  const hostReachable = { value: true };
  const counters = { skipWaiting: 0, claim: 0, unregister: 0 };

  const fetchImpl = async (input: unknown): Promise<Response> => {
    const url = typeof input === "string" ? new URL(input, ORIGIN).href : new URL((input as { url: string }).url).href;
    fetchCalls.push(url);
    if (!hostReachable.value || down.has(url)) throw new TypeError("Failed to fetch");
    const factory = routes.get(url);
    if (!factory) throw new TypeError("Failed to fetch");
    return factory();
  };

  const storage = new FakeCacheStorage(fetchImpl as (url: string) => Promise<Response>);

  class RequestShim {
    readonly url: string;
    readonly method: string;
    readonly mode: string;
    readonly headers: Headers;

    constructor(input: string | { url: string }, init?: { method?: string; mode?: string; headers?: HeadersInit }) {
      this.url = new URL(typeof input === "string" ? input : input.url, ORIGIN).href;
      this.method = init?.method ?? "GET";
      this.mode = init?.mode ?? "cors";
      this.headers = new Headers(init?.headers);
    }
  }

  const context: Record<string, unknown> = {
    console,
    URL,
    Headers,
    Response,
    Request: RequestShim,
    fetch: fetchImpl,
    caches: storage,
    location: new URL(ORIGIN),
    clients: {
      claim: async () => {
        counters.claim += 1;
      }
    },
    registration: {
      unregister: async () => {
        counters.unregister += 1;
        return true;
      }
    },
    skipWaiting: async () => {
      counters.skipWaiting += 1;
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      const bucket = listeners.get(type) ?? [];
      bucket.push(listener);
      listeners.set(type, bucket);
    }
  };
  context.self = context;

  vm.createContext(context);
  vm.runInContext(readFileSync(SW_PATH, "utf8"), context, { filename: SW_PATH });

  const dispatch = async (type: string, event: Record<string, unknown>): Promise<void> => {
    const waits: Promise<unknown>[] = [];
    const enriched = {
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
      ...event
    };
    for (const listener of listeners.get(type) ?? []) listener(enriched);
    await Promise.all(waits);
  };

  return {
    internals: context.__couchCoopSwInternals as SwInternals,
    storage,
    listeners,
    routes,
    down,
    fetchCalls,
    hostReachable,
    makeRequest: (url, init) => new RequestShim(url, init),
    dispatch,
    get skipWaitingCalls() {
      return counters.skipWaiting;
    },
    get claimCalls() {
      return counters.claim;
    },
    get unregisterCalls() {
      return counters.unregister;
    }
  } as Harness;
}

function html(bundle: string): string {
  return `<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest" /></head><body><div id="app"></div><script type="module" crossorigin src="${bundle}"></script></body></html>`;
}

function asset(body: string, bytes = body.length): Response {
  return new Response(body, { status: 200, headers: { "content-length": String(bytes), "content-type": "image/png" } });
}

describe("service worker: pure decisions", () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it("extracts the hashed entry bundle as the build stamp", () => {
    expect(h.internals.extractBuildStamp(html("/app/index-BQz1a9.js"))).toBe("/app/index-BQz1a9.js");
    expect(h.internals.extractBuildStamp("<script type='module' src='/app/main-9f.js'></script>")).toBe("/app/main-9f.js");
  });

  it("treats a missing stamp as no signal rather than as a change", () => {
    // Load-bearing: `reconcileBuildStamp` must never wipe the cache just because it could not parse.
    expect(h.internals.extractBuildStamp("<html><body>no scripts</body></html>")).toBeNull();
    expect(h.internals.extractBuildStamp("<script src='/src/main.ts'></script>")).toBeNull();
    expect(h.internals.extractBuildStamp(undefined)).toBeNull();
  });

  it("intercepts only navigations and allowlisted asset prefixes", () => {
    const classify = (url: string, init?: Parameters<Harness["makeRequest"]>[1]) =>
      h.internals.classifyRequest(h.makeRequest(url, init), ORIGIN);

    expect(classify("/", { mode: "navigate" })).toBe("navigate");
    expect(classify("/?name=Ann", { mode: "navigate" })).toBe("navigate");
    expect(classify("/res/images/packed/common_ui/cursor_default.png")).toBe("asset");
    expect(classify("/app/index-BQz1a9.js")).toBe("asset");
    expect(classify("/icons/icon-192.png")).toBe("asset");

    // Live game/session data must never be served from a cache.
    expect(classify("/catalog")).toBe("bypass");
    expect(classify("/models/cards/strike")).toBe("bypass");
    expect(classify("/model-res/x.png")).toBe("bypass");
    expect(classify("/spines")).toBe("bypass");
    expect(classify("/manifest.webmanifest")).toBe("bypass");
  });

  it("never touches the game socket, non-GET, ranged or cross-origin requests", () => {
    const classify = (url: string, init?: Parameters<Harness["makeRequest"]>[1]) =>
      h.internals.classifyRequest(h.makeRequest(url, init), ORIGIN);

    expect(classify("/ws")).toBe("bypass");
    expect(classify("/ws?watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0")).toBe("bypass");
    expect(classify("/ws/anything")).toBe("bypass");
    expect(classify("/res/x.png", { method: "POST" })).toBe("bypass");
    expect(classify("/res/x.png", { headers: { range: "bytes=0-99" } })).toBe("bypass");
    expect(classify("https://other.example/res/x.png")).toBe("bypass");
    expect(h.internals.classifyRequest(null, ORIGIN)).toBe("bypass");
  });

  it("stores only complete, same-origin, in-budget 200s", () => {
    const max = h.internals.MAX_ENTRY_BYTES;
    expect(h.internals.isCacheable(asset("ok"), max)).toBe(true);
    expect(h.internals.isCacheable(new Response("", { status: 404 }), max)).toBe(false);
    expect(h.internals.isCacheable(new Response("", { status: 206 }), max)).toBe(false);
    expect(h.internals.isCacheable(asset("huge", max + 1), max)).toBe(false);
    expect(h.internals.isCacheable({ status: 200, type: "opaque", headers: new Headers() }, max)).toBe(false);
    expect(h.internals.isCacheable(null, max)).toBe(false);
  });

  it("plans FIFO eviction against both the byte and the entry cap", () => {
    const { planTrim } = h.internals;
    const sized = (...bytes: number[]) => bytes.map((b) => ({ bytes: b }));

    expect(planTrim(sized(10, 10, 10), { maxEntries: 10, maxBytes: 100 })).toBe(0);
    // 40 bytes over a 25-byte cap: drop the two oldest (10 + 10) to land at 20.
    expect(planTrim(sized(10, 10, 10, 10), { maxEntries: 10, maxBytes: 25 })).toBe(2);
    expect(planTrim(sized(1, 1, 1, 1, 1), { maxEntries: 2, maxBytes: 1000 })).toBe(3);
    // Never asks for more than exists, even when a single entry alone busts the cap.
    expect(planTrim(sized(999), { maxEntries: 1, maxBytes: 1 })).toBe(1);
    expect(planTrim([], { maxEntries: 0, maxBytes: 0 })).toBe(0);
  });
});

describe("service worker: caching behaviour", () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
    h.routes.set(`${ORIGIN}/offline.html`, () => new Response("<h1>Can't find your game host</h1>", { status: 200 }));
    h.routes.set(`${ORIGIN}/res/a.png`, () => asset("A"));
    h.routes.set(`${ORIGIN}/`, () => new Response(html("/app/index-v1.js"), { status: 200, headers: { "content-type": "text/html" } }));
  });

  it("precaches the offline page on install and activates immediately", async () => {
    await h.dispatch("install", {});
    const shell = await h.storage.open(h.internals.SHELL_CACHE);
    expect(await shell.match("/offline.html")).toBeTruthy();
    expect(h.skipWaitingCalls).toBe(1);

    await h.dispatch("activate", {});
    expect(h.claimCalls).toBe(1);
  });

  it("serves an asset from the network once, then from the cache", async () => {
    const request = h.makeRequest("/res/a.png");
    expect(await (await h.internals.handleAsset(request)).text()).toBe("A");
    expect(h.fetchCalls).toEqual([`${ORIGIN}/res/a.png`]);

    // Second join: no network at all. This is the whole point of the workstream.
    h.hostReachable.value = false;
    expect(await (await h.internals.handleAsset(h.makeRequest("/res/a.png"))).text()).toBe("A");
    expect(h.fetchCalls).toHaveLength(1);
  });

  it("does not store a failed asset response", async () => {
    h.routes.set(`${ORIGIN}/res/missing.png`, () => new Response("nope", { status: 404 }));
    await h.internals.handleAsset(h.makeRequest("/res/missing.png"));
    const cache = await h.storage.open(h.internals.ASSET_CACHE);
    expect(await cache.keys()).toEqual([]);
  });

  it("records the build stamp on first sight without wiping anything", async () => {
    await h.internals.handleAsset(h.makeRequest("/res/a.png"));
    await h.internals.handleNavigation(h.makeRequest("/", { mode: "navigate" }));

    const assets = await h.storage.open(h.internals.ASSET_CACHE);
    expect(await assets.keys()).toHaveLength(1);
    const shell = await h.storage.open(h.internals.SHELL_CACHE);
    expect(await (await shell.match(h.internals.BUILD_STAMP_KEY))?.text()).toBe("/app/index-v1.js");
  });

  it("drops the whole asset cache when the deployed bundle hash changes", async () => {
    await h.internals.handleAsset(h.makeRequest("/res/a.png"));
    await h.internals.handleNavigation(h.makeRequest("/", { mode: "navigate" }));
    expect((await (await h.storage.open(h.internals.ASSET_CACHE)).keys())).toHaveLength(1);

    // A mod redeploy: same URL, new hashed entry bundle.
    h.routes.set(`${ORIGIN}/`, () => new Response(html("/app/index-v2.js"), { status: 200 }));
    await h.internals.handleNavigation(h.makeRequest("/", { mode: "navigate" }));

    expect((await (await h.storage.open(h.internals.ASSET_CACHE)).keys())).toEqual([]);
    const shell = await h.storage.open(h.internals.SHELL_CACHE);
    expect(await (await shell.match(h.internals.BUILD_STAMP_KEY))?.text()).toBe("/app/index-v2.js");
    // The offline page survives the wipe — it lives in the shell cache, not the asset cache.
    await h.dispatch("install", {});
    expect(await shell.match("/offline.html")).toBeTruthy();
  });

  it("keeps the cache when the same build is reloaded", async () => {
    await h.internals.handleAsset(h.makeRequest("/res/a.png"));
    await h.internals.handleNavigation(h.makeRequest("/", { mode: "navigate" }));
    await h.internals.handleNavigation(h.makeRequest("/", { mode: "navigate" }));
    expect((await (await h.storage.open(h.internals.ASSET_CACHE)).keys())).toHaveLength(1);
  });

  it("records the host's asset identity on first sight without wiping anything", async () => {
    await h.internals.handleAsset(h.makeRequest("/res/a.png"));

    await h.dispatch("message", { data: { type: "couchcoop-asset-identity", value: "cc-aaaa1111" } });

    expect((await (await h.storage.open(h.internals.ASSET_CACHE)).keys())).toHaveLength(1);
    const shell = await h.storage.open(h.internals.SHELL_CACHE);
    expect(await (await shell.match(h.internals.ASSET_IDENTITY_KEY))?.text()).toBe("cc-aaaa1111");
  });

  // The signal the bundle hash cannot give: the frontend is byte-identical across both game branches and
  // across a game update with no frontend rebuild, so the document alone says nothing changed.
  it("drops the whole asset cache when the host's asset identity moves", async () => {
    await h.internals.handleAsset(h.makeRequest("/res/a.png"));
    await h.dispatch("message", { data: { type: "couchcoop-asset-identity", value: "cc-aaaa1111" } });
    expect((await (await h.storage.open(h.internals.ASSET_CACHE)).keys())).toHaveLength(1);

    // Same phone, same frontend build, different host game build (or the other Steam branch).
    await h.dispatch("message", { data: { type: "couchcoop-asset-identity", value: "cc-bbbb2222" } });

    expect((await (await h.storage.open(h.internals.ASSET_CACHE)).keys())).toEqual([]);
    const shell = await h.storage.open(h.internals.SHELL_CACHE);
    expect(await (await shell.match(h.internals.ASSET_IDENTITY_KEY))?.text()).toBe("cc-bbbb2222");
  });

  it("keeps the cache when the same identity arrives again", async () => {
    await h.internals.handleAsset(h.makeRequest("/res/a.png"));
    await h.dispatch("message", { data: { type: "couchcoop-asset-identity", value: "cc-aaaa1111" } });
    await h.dispatch("message", { data: { type: "couchcoop-asset-identity", value: "cc-aaaa1111" } });

    expect((await (await h.storage.open(h.internals.ASSET_CACHE)).keys())).toHaveLength(1);
  });

  // Load-bearing, exactly as for the build stamp: a host too old to send a token, or a malformed message,
  // must not be read as "everything changed" and wipe a cache the player just filled.
  it("treats an absent or unusable identity as no signal rather than as a change", async () => {
    await h.internals.handleAsset(h.makeRequest("/res/a.png"));
    await h.dispatch("message", { data: { type: "couchcoop-asset-identity", value: "cc-aaaa1111" } });

    for (const value of [undefined, null, "", 42, {}]) {
      // eslint-disable-next-line no-await-in-loop -- ordering matters; each must leave the cache alone.
      expect(await h.internals.reconcileAssetIdentity(value)).toBe(false);
    }

    expect((await (await h.storage.open(h.internals.ASSET_CACHE)).keys())).toHaveLength(1);
    const shell = await h.storage.open(h.internals.SHELL_CACHE);
    expect(await (await shell.match(h.internals.ASSET_IDENTITY_KEY))?.text()).toBe("cc-aaaa1111");
  });

  it("never serves a cached application document — a dead host gets the offline page", async () => {
    await h.dispatch("install", {});
    // Prove a document was seen and NOT retained as a navigation fallback.
    await h.internals.handleNavigation(h.makeRequest("/", { mode: "navigate" }));

    h.hostReachable.value = false;
    const response = await h.internals.handleNavigation(h.makeRequest("/", { mode: "navigate" }));
    expect(await response.text()).toContain("Can't find your game host");
  });

  it("falls back to a network error when even the offline page is missing", async () => {
    h.hostReachable.value = false;
    const response = await h.internals.handleNavigation(h.makeRequest("/", { mode: "navigate" }));
    expect(response.type).toBe("error");
  });

  it("evicts oldest-first once the byte budget is blown", async () => {
    // Populated directly rather than through handleAsset so the amortized auto-trim counters stay put
    // and this measures `trimAssetCache` alone.
    const cache = await h.storage.open(h.internals.ASSET_CACHE);
    const big = 20 * 1024 * 1024;
    for (const name of ["a", "b", "c", "d"]) {
      // eslint-disable-next-line no-await-in-loop -- insertion order is the thing under test.
      await cache.put(`${ORIGIN}/res/${name}.bin`, new Response(name, { headers: { "content-length": String(big) } }));
    }
    expect(await cache.keys()).toHaveLength(4);

    await h.internals.trimAssetCache();
    // 4 × 20MB = 80MB against a 64MB cap → the oldest goes and 60MB remains.
    expect(await cache.keys()).toEqual([`${ORIGIN}/res/b.bin`, `${ORIGIN}/res/c.bin`, `${ORIGIN}/res/d.bin`]);
  });

  it("refuses to store a single oversized response", async () => {
    // One pathological asset must not be able to evict the entire working set.
    h.routes.set(`${ORIGIN}/res/huge.bin`, () => asset("x", h.internals.MAX_ENTRY_BYTES + 1));
    await h.internals.handleAsset(h.makeRequest("/res/huge.bin"));
    expect(await (await h.storage.open(h.internals.ASSET_CACHE)).keys()).toEqual([]);
  });

  it("wipes everything and unregisters on the reset message", async () => {
    await h.dispatch("install", {});
    await h.internals.handleAsset(h.makeRequest("/res/a.png"));
    expect((await h.storage.keys()).some((name) => name.startsWith("couchcoop-"))).toBe(true);

    await h.dispatch("message", { data: { type: "couchcoop-sw-reset" } });

    expect((await h.storage.keys()).some((name) => name.startsWith("couchcoop-"))).toBe(false);
    expect(h.unregisterCalls).toBe(1);
  });

  it("leaves bypassed requests to the browser (no respondWith)", async () => {
    const seen: unknown[] = [];
    const fetchListener = h.listeners.get("fetch")?.[0];
    expect(fetchListener).toBeTypeOf("function");

    fetchListener?.({ request: h.makeRequest("/ws"), respondWith: (p: unknown) => seen.push(p) });
    fetchListener?.({ request: h.makeRequest("/catalog"), respondWith: (p: unknown) => seen.push(p) });
    expect(seen).toHaveLength(0);

    fetchListener?.({ request: h.makeRequest("/res/a.png"), respondWith: (p: unknown) => seen.push(p) });
    expect(seen).toHaveLength(1);
    await seen[0];
  });
});

describe("service worker registration policy", () => {
  const base = { isSecureContext: true, hasServiceWorkerApi: true, isDev: false, override: null } as const;

  it("reads the ?sw= override", () => {
    expect(readServiceWorkerOverride("?sw=off")).toBe("off");
    expect(readServiceWorkerOverride("?sw=on")).toBe("on");
    expect(readServiceWorkerOverride("?sw=1")).toBe("on");
    expect(readServiceWorkerOverride("?sw=0")).toBe("off");
    expect(readServiceWorkerOverride("?sw=maybe")).toBeNull();
    expect(readServiceWorkerOverride("")).toBeNull();
  });

  it("registers only on a secure context with the API present", () => {
    expect(decideServiceWorkerAction(base)).toBe("register");
    // The mod's DEFAULT plain-HTTP LAN URL: nothing happens at all.
    expect(decideServiceWorkerAction({ ...base, isSecureContext: false })).toBe("skip");
    expect(decideServiceWorkerAction({ ...base, hasServiceWorkerApi: false })).toBe("skip");
  });

  it("tears down in dev unless explicitly opted in", () => {
    expect(decideServiceWorkerAction({ ...base, isDev: true })).toBe("unregister");
    expect(decideServiceWorkerAction({ ...base, isDev: true, override: "on" })).toBe("register");
  });

  it("honours ?sw=off unconditionally — it is the escape hatch", () => {
    expect(decideServiceWorkerAction({ ...base, override: "off" })).toBe("unregister");
    expect(decideServiceWorkerAction({ ...base, override: "off", isSecureContext: false })).toBe("unregister");
    expect(decideServiceWorkerAction({ ...base, override: "off", hasServiceWorkerApi: false })).toBe("unregister");
  });

  it("registers at the root scope", async () => {
    const calls: [string, unknown][] = [];
    const result = await applyServiceWorkerPolicy({
      ...base,
      serviceWorker: {
        register: (async (url: string, options: unknown) => {
          calls.push([url, options]);
          return {} as ServiceWorkerRegistration;
        }) as never,
        getRegistrations: (async () => []) as never
      }
    });
    expect(result.registered).toBe(true);
    expect(calls).toEqual([[SERVICE_WORKER_URL, { scope: "/" }]]);
  });

  it("survives a registration failure without throwing", async () => {
    const result = await applyServiceWorkerPolicy({
      ...base,
      serviceWorker: {
        register: (async () => {
          throw new Error("bad MIME type");
        }) as never,
        getRegistrations: (async () => []) as never
      }
    });
    expect(result.registered).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
  });

  it("?sw=off unregisters, deletes only our caches, reloads once, then terminates", async () => {
    let unregistered = 0;
    const names = new Set(["couchcoop-assets-v1", "couchcoop-shell-v1", "some-other-app"]);
    let reloads = 0;
    const env = () => ({
      ...base,
      override: "off" as const,
      serviceWorker: {
        register: (async () => ({})) as never,
        getRegistrations: (async () =>
          unregistered === 0
            ? [
                {
                  unregister: async () => {
                    unregistered += 1;
                    return true;
                  }
                }
              ]
            : []) as never
      },
      caches: {
        keys: async () => [...names],
        delete: async (name: string) => names.delete(name)
      },
      reload: () => {
        reloads += 1;
      }
    });

    const first = await applyServiceWorkerPolicy(env());
    expect(first.unregistered).toBe(1);
    expect(first.deletedCaches).toBe(2);
    expect([...names]).toEqual(["some-other-app"]);
    expect(reloads).toBe(1);

    // Second pass (the reload lands back on the same ?sw=off URL): nothing left to remove, so no
    // reload — which is what stops this being an infinite loop.
    const second = await applyServiceWorkerPolicy(env());
    expect(second.reloaded).toBe(false);
    expect(reloads).toBe(1);
  });
});
