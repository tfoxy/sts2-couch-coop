/*
 * CouchCoop service worker — hand-written, zero build dependency.
 *
 * WHY A PLAIN FILE IN public/: Vite copies `public/**` to the dist root verbatim, so this lands at
 * `/sw.js` and gets root scope with no plugin, no manifest generation and no new dependency. The mod
 * serves it as-is: StaticSpaFileProvider falls any non-reserved path through to the static root and maps
 * `.js` to `text/javascript` (Server/StaticSpaFileProvider.cs), so no C# change is needed. It is a
 * CLASSIC worker (not `{type:"module"}`) because module service workers are still the narrower support
 * story on iOS WebKit, and the whole point of the secure origin is that it upgrades iPhone too.
 *
 * WHEN IT RUNS: only on a secure origin. The mod's default LAN URL is plain HTTP, which is not a secure
 * context, so `navigator.serviceWorker` is undefined there and `src/pwa/registerServiceWorker.ts` never
 * calls register(). Everything here is therefore inert on the default path by construction.
 *
 * ------------------------------------------------------------------------------------------------
 * SAFETY POSTURE (a service worker is the easiest way to make an app permanently unloadable)
 * ------------------------------------------------------------------------------------------------
 * 1. WE NEVER SERVE A CACHED APPLICATION DOCUMENT. Navigations are network-only, with the offline page
 *    as the failure branch. A corrupt/oldbuild index.html therefore cannot get pinned in front of the
 *    app: if the host answers at all, the player gets exactly what the host sent.
 * 2. NO respondWith FOR ANYTHING WE DON'T HANDLE. `classifyRequest` returns "bypass" for the large
 *    majority of traffic and the fetch handler then returns without calling `event.respondWith`, which
 *    hands the request back to the browser's own stack. The default failure mode is "behaves as if no
 *    service worker were installed".
 * 3. skipWaiting + clients.claim, DELIBERATELY. The usual argument against skipWaiting is that a page
 *    running old JS suddenly talks to a new worker. That risk is near zero here — we cache by URL
 *    passthrough, not by a versioned precache manifest, so a new worker serves the same bytes the old
 *    one would. The risk on the other side is severe: phone tabs are never closed, so without
 *    skipWaiting a broken worker would sit in "waiting" indefinitely and the fix could not ship. With
 *    skipWaiting, recovery is one reload.
 * 4. THREE ESCAPE HATCHES, in increasing order of blast radius:
 *      a. `?sw=off` on any page URL — the registrar unregisters every worker and deletes every
 *         `couchcoop-` cache (src/pwa/registerServiceWorker.ts). Reachable by typing into the URL bar,
 *         which is the only tool a stuck player has.
 *      b. postMessage `{type:"couchcoop-sw-reset"}` — same wipe, driven from a live page.
 *      c. Bump CACHE_FORMAT_VERSION below — renames every cache, and `activate` deletes any
 *         `couchcoop-` cache that is not one of the current names. A release with a bumped version is
 *         a guaranteed clean slate for every client that loads it.
 * 5. NEVER `/ws`. The WebSocket carries the entire game session. Upgrades don't go through `fetch` in
 *    the first place, but a plain GET to `/ws` is excluded explicitly so no future refactor can make
 *    the socket cacheable.
 *
 * ------------------------------------------------------------------------------------------------
 * CACHE VERSIONING AND EVICTION POLICY (and why)
 * ------------------------------------------------------------------------------------------------
 * The prize is `/res/`: the mirror pulls multiple megabytes of textures/fonts on every join, and the
 * server already declares them `Cache-Control: public, max-age=31536000, immutable`
 * (SpirectlAssetHttpAdapter.cs / CouchCoopBrowserServer.cs). So caching them is not a new staleness
 * contract — it is the one the origin already asserts. What a Cache Storage entry adds over the HTTP
 * cache is DURABILITY: the HTTP cache on a phone is evicted aggressively between sessions, which is
 * exactly why the second join is as slow as the first today.
 *
 * That durability is also the danger, so invalidation is layered:
 *
 *   (0) THE URL ITSELF — the real invalidator, and it is NOT in this file. Every asset url the page
 *       mints carries the host's game build (`?b=<assetCacheToken>`, frontend/src/join/assetVersion.ts),
 *       so a build change re-addresses every asset and nothing that caches by url can serve one build's
 *       bytes for another's. That has to be the mechanism, because the cache this worker owns is not the
 *       one that holds the bytes: THE HTTP CACHE IS. This worker only registers on a secure origin — the
 *       default LAN url is plain HTTP, where it never runs at all — and even where it does, deleting an
 *       entry here just sends the next fetch to a still-valid `immutable` HTTP response under the same
 *       url, which hands the stale bytes straight back. Everything below is therefore eviction, not
 *       correctness.
 *
 *   (i) BUILD STAMP — every successful navigation response is scanned for the hashed entry bundle Vite
 *       emits (`/app/index-<hash>.js`, see vite.config.ts `assetsDir: "app"`). That string changes on
 *       every frontend build, and in this repo the frontend build's outDir IS the installed mod
 *       directory — the SPA and the game code ship as one unit. So "the bundle hash changed" is a
 *       reliable proxy for "the mod was updated", and it drops the whole asset cache. Absence of the
 *       signal (no match in the HTML) never invalidates: a missing signal is not evidence of change.
 *       The reconcile is awaited before the document is returned so the page it produces can never race
 *       ahead and repopulate the cache we are about to delete.
 *
 *  (ii) HOST ASSET IDENTITY — the same token the urls carry, forwarded from the `session` envelope by
 *       the page (`couchcoop-asset-identity`). The host composes it from the same game build + cache
 *       generation it keys its OWN disk cache on, so the phone and the host evict together. Same
 *       discipline as the build stamp: a changed value drops the asset cache, and the first observation
 *       only records, because absence is not evidence of change.
 *
 *       What it buys, now that the url carries the build: the entries under the PREVIOUS build's urls
 *       are unreachable dead weight the moment the token moves, and this reclaims them at once instead
 *       of waiting for the FIFO budget to walk them out. Both game branches ship the same frontend
 *       bundle, so the build stamp cannot see that hop — which is why the two signals are separate.
 *
 * (iii) FORMAT VERSION — the manual override, for when the worker's own semantics change (or for an
 *       emergency wipe). Bumping it renames the caches; `activate` sweeps the orphans.
 *
 * There is deliberately NO time-based TTL. A TTL would contradict the origin's own `immutable` header
 * and would re-fetch megabytes on a schedule unrelated to whether anything actually changed. The two
 * signals above both fire on a real change and nothing else, which is what a TTL is a guess at.
 *
 * EVICTION is FIFO against a byte budget and an entry count, both soft caps:
 *   - `cache.keys()` is specified to return keys in INSERTION order, so dropping from the front is
 *     exact FIFO with no bookkeeping.
 *   - FIFO not LRU on purpose. True LRU needs a cache write on every read, i.e. a disk write per asset
 *     HIT — strictly more expensive than the occasional re-fetch a wrong eviction costs. And assets
 *     here arrive in per-scene bursts, so insertion order already tracks first-use recency well.
 *   - The budget is checked amortized (every TRIM_EVERY_PUTS entries or TRIM_EVERY_BYTES added) plus
 *     once on activate, so the O(n) walk never lands on the hot path.
 *   - A single oversized response is refused outright (MAX_ENTRY_BYTES) so one pathological asset can
 *     never evict the entire working set.
 */

const CACHE_FORMAT_VERSION = 1;
const CACHE_PREFIX = "couchcoop-";
/** Precached offline page + the build stamp. Tiny, long-lived, never swept by the budget. */
const SHELL_CACHE = `${CACHE_PREFIX}shell-v${CACHE_FORMAT_VERSION}`;
/** The bulk texture/bundle cache. This is the one the budget and the build stamp govern. */
const ASSET_CACHE = `${CACHE_PREFIX}assets-v${CACHE_FORMAT_VERSION}`;

const OFFLINE_URL = "/offline.html";
/** Synthetic in-cache key for the last-seen build stamp. Never requested over the network. */
const BUILD_STAMP_KEY = "/__couchcoop_sw__/build-stamp";
/** Synthetic in-cache key for the last-seen host asset identity. Never requested over the network. */
const ASSET_IDENTITY_KEY = "/__couchcoop_sw__/asset-identity";

/*
 * Cache-first prefixes. Strictly an allowlist — anything not listed is bypassed entirely.
 *   /res/    the game's own resources (textures, fonts, scenes). The multi-megabyte prize.
 *   /app/    Vite's hashed bundle output for THIS build (vite.config.ts sets `assetsDir: "app"`).
 *   /icons/  the manifest/home-screen icons, so an installed app has its art offline.
 * Deliberately ABSENT: /models/ and /spines — live game/session data.
 */
const CACHE_FIRST_PREFIXES = ["/res/", "/app/", "/icons/"];

/** Soft budget for ASSET_CACHE. ~64MB is a few full scene loads and a rounding error on a modern phone. */
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_ASSET_ENTRIES = 1200;
/** Refuse to store any single response bigger than this, so one asset can't evict the working set. */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
/** Amortization of the O(n) budget walk. */
const TRIM_EVERY_PUTS = 150;
const TRIM_EVERY_BYTES = 16 * 1024 * 1024;
/** Charged against the budget when a response carries no content-length, so unknown sizes still count. */
const ASSUMED_ENTRY_BYTES = 24 * 1024;

// ---------------------------------------------------------------------------------------------------
// Pure helpers. Kept free of `caches`/`fetch` so the spec can exercise the decisions directly
// (src/__tests__/pwaServiceWorker.spec.ts evaluates this file in a vm with a fake global scope).
// ---------------------------------------------------------------------------------------------------

/**
 * Pull the hashed entry-bundle URL out of an index.html. That string is our build identity.
 * Returns null when there is no match — callers MUST treat null as "no signal", never as "changed".
 */
function extractBuildStamp(html) {
  if (typeof html !== "string") return null;
  const match = /<script[^>]*\ssrc=["']([^"']*\/(?:app|assets)\/[^"']+\.js)["']/i.exec(html);
  return match ? match[1] : null;
}

/**
 * "navigate" | "asset" | "bypass". The single gate in front of every interception decision.
 * Anything uncertain resolves to "bypass" — see safety note 2.
 */
function classifyRequest(request, selfOrigin) {
  if (!request || request.method !== "GET") return "bypass";

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return "bypass";
  }
  // Cross-origin (a CDN, the offline page's port probe) is the browser's business, not ours; it would
  // also hand us opaque responses of unknowable size, which the byte budget cannot account for.
  if (url.origin !== selfOrigin) return "bypass";

  // A ranged request answers 206 Partial Content, which is not a valid cache entry.
  const range = request.headers && typeof request.headers.get === "function" ? request.headers.get("range") : null;
  if (range) return "bypass";

  // The game session socket. Never, under any circumstances.
  if (url.pathname === "/ws" || url.pathname.startsWith("/ws/")) return "bypass";

  if (request.mode === "navigate") return "navigate";

  return CACHE_FIRST_PREFIXES.some((prefix) => url.pathname.startsWith(prefix)) ? "asset" : "bypass";
}

/** Whether a response may be stored: a complete, same-origin, in-budget 200. */
function isCacheable(response, maxEntryBytes) {
  if (!response || response.status !== 200) return false;
  // "basic" is a same-origin fetch; "default" is a synthesized Response (tests). "opaque"/"error"/
  // "cors" are all either unreadable or not ours.
  if (response.type && response.type !== "basic" && response.type !== "default") return false;
  const declared = declaredBytes(response);
  return !(declared !== null && declared > maxEntryBytes);
}

/** content-length as a number, or null when absent/unparseable. */
function declaredBytes(response) {
  const raw = response && response.headers && typeof response.headers.get === "function"
    ? response.headers.get("content-length")
    : null;
  if (raw === null || raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Budget weight of a stored entry (content-length, or a flat assumption when unknown). */
function entryBytes(response) {
  const declared = declaredBytes(response);
  return declared === null ? ASSUMED_ENTRY_BYTES : declared;
}

/**
 * How many leading (= oldest) entries to drop to fit both caps. Pure: takes sizes in insertion order.
 * Returns 0 when already inside budget, and never more than `entries.length`.
 */
function planTrim(entries, caps) {
  let total = 0;
  for (const entry of entries) total += entry.bytes;

  let drop = 0;
  let remaining = entries.length;
  while (drop < entries.length && (remaining > caps.maxEntries || total > caps.maxBytes)) {
    total -= entries[drop].bytes;
    drop += 1;
    remaining -= 1;
  }
  return drop;
}

// ---------------------------------------------------------------------------------------------------
// Effectful paths
// ---------------------------------------------------------------------------------------------------

let bytesSinceTrim = 0;
let putsSinceTrim = 0;
let trimInFlight = null;

/** Amortized budget enforcement: account a put, and kick a (single-flight) trim when we've drifted. */
function noteAssetPut(bytes) {
  bytesSinceTrim += bytes;
  putsSinceTrim += 1;
  if (putsSinceTrim < TRIM_EVERY_PUTS && bytesSinceTrim < TRIM_EVERY_BYTES) return;
  putsSinceTrim = 0;
  bytesSinceTrim = 0;
  if (trimInFlight) return;
  trimInFlight = trimAssetCache()
    .catch(() => 0)
    .then((dropped) => {
      trimInFlight = null;
      return dropped;
    });
}

async function trimAssetCache() {
  const cache = await caches.open(ASSET_CACHE);
  const keys = await cache.keys();
  const entries = [];
  for (const key of keys) {
    // eslint-disable-next-line no-await-in-loop -- sequential is fine: trim is amortized off the hot path.
    const stored = await cache.match(key);
    entries.push({ key, bytes: entryBytes(stored) });
  }

  const drop = planTrim(entries, { maxEntries: MAX_ASSET_ENTRIES, maxBytes: MAX_ASSET_BYTES });
  for (let i = 0; i < drop; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- same.
    await cache.delete(entries[i].key);
  }
  return drop;
}

/**
 * Compare the build stamp in a freshly fetched document against the last one we saw, and drop the whole
 * asset cache when it moved. Returns true when it invalidated.
 */
async function reconcileBuildStamp(response) {
  const stamp = extractBuildStamp(await response.text());
  if (!stamp) return false;
  return reconcileStamp(BUILD_STAMP_KEY, stamp);
}

/**
 * Compare the host's asset identity against the last one we saw, and drop the whole asset cache when it
 * moved. Returns true when it invalidated.
 *
 * The value is the session envelope's `assetCacheToken`, forwarded from the page. The host composes it from
 * the game build and the cache generations it keys its own on-disk cache on, so "the host's bytes can have
 * changed" and "this phone's cached bytes are stale" stay one fact rather than two that drift apart.
 *
 * This is EVICTION, not correctness — the page puts the same token in every asset url it mints, so what this
 * drops is already unreachable by the time we get here. See note (0) in the header.
 */
async function reconcileAssetIdentity(identity) {
  if (typeof identity !== "string" || identity.length === 0) return false;
  return reconcileStamp(ASSET_IDENTITY_KEY, identity);
}

/**
 * The shared half of both invalidators: record the value, and drop the asset cache when it MOVED.
 *
 * The very first observation only RECORDS — there is nothing meaningful to invalidate then, and treating
 * "we've never seen one" as "it changed" would wipe the cache a returning player just filled.
 */
async function reconcileStamp(key, value) {
  const shell = await caches.open(SHELL_CACHE);
  const previous = await shell.match(key);
  const previousValue = previous ? await previous.text() : null;
  if (previousValue === value) return false;

  await shell.put(key, new Response(value, { headers: { "content-type": "text/plain" } }));
  if (previousValue === null) return false;

  await caches.delete(ASSET_CACHE);
  return true;
}

/**
 * Network-only, with the offline page as the failure branch.
 *
 * Note what this deliberately does NOT do: fall back to a cached copy of index.html. Every byte of game
 * state arrives over `/ws`, so a cached shell booting against a host that isn't there is strictly worse
 * than an honest error — it is precisely today's dead-home-screen-icon symptom (a spinner that never
 * resolves) with extra steps. The offline page explains it, offers Retry, and probes the neighbouring
 * ports the host may have walked to.
 */
async function handleNavigation(request) {
  let response;
  try {
    response = await fetch(request);
  } catch {
    const fallback = await offlineFallback();
    return fallback || Response.error();
  }

  if (response && response.ok) {
    try {
      // Clone BEFORE the body is handed to the page, and await: the document we are about to return
      // will start pulling assets immediately, so the wipe has to land first or it would delete the
      // very entries that load just repopulated.
      await reconcileBuildStamp(response.clone());
    } catch {
      // A stamp we couldn't read is a stamp we don't act on. Serving the document still works.
    }
  }
  return response;
}

async function offlineFallback() {
  try {
    const shell = await caches.open(SHELL_CACHE);
    // Returned as-is (200) rather than re-wrapped in a 503: a plain 200 is the one thing every UA is
    // guaranteed to render, and the page's whole job is to be readable at the worst possible moment.
    return (await shell.match(OFFLINE_URL)) || null;
  } catch {
    return null;
  }
}

/** Cache-first. A cache that is unavailable or throwing degrades to a plain network fetch. */
async function handleAsset(request) {
  let cache = null;
  try {
    cache = await caches.open(ASSET_CACHE);
    const hit = await cache.match(request);
    if (hit) return hit;
  } catch {
    cache = null;
  }

  // Outside the try on purpose: if the network fails we want the request to reject exactly as it would
  // with no worker installed, not to be retried a second time against a host we already know is down.
  const response = await fetch(request);

  if (cache && isCacheable(response, MAX_ENTRY_BYTES)) {
    try {
      await cache.put(request, response.clone());
      noteAssetPut(entryBytes(response));
    } catch {
      // Quota exceeded / clone failure: the player still gets the response, they just get it again next
      // time. Nudge the budget so a full disk resolves itself rather than failing every put forever.
      noteAssetPut(MAX_ASSET_BYTES);
    }
  }
  return response;
}

async function wipeCouchCoopCaches() {
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX)).map((name) => caches.delete(name)));
}

// ---------------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------------

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const shell = await caches.open(SHELL_CACHE);
        // `cache: "reload"` so a stale HTTP-cached copy of the offline page can't be what we pin.
        await shell.add(new Request(OFFLINE_URL, { cache: "reload" }));
      } catch {
        // A missing/unfetchable offline page must not brick installation — without it `offlineFallback`
        // returns null and the player sees the browser's own error page, i.e. exactly today's behaviour.
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        await trimAssetCache();
      } catch {
        // ditto
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  let kind;
  try {
    kind = classifyRequest(event.request, self.location.origin);
  } catch {
    // A bug in classification must not take the page down: no respondWith == no worker.
    return;
  }

  if (kind === "bypass") return;
  if (kind === "navigate") {
    event.respondWith(handleNavigation(event.request));
    return;
  }
  event.respondWith(handleAsset(event.request));
});

self.addEventListener("message", (event) => {
  const data = event && event.data;
  if (!data) return;

  // The host's asset identity, forwarded from the page's `session` envelope. A message rather than a fetch:
  // it costs no round trip, it carries no offline failure mode (no envelope means no change means no wipe),
  // and it arrives exactly when the page learns which host it is actually talking to.
  if (data.type === "couchcoop-asset-identity") {
    const work = reconcileAssetIdentity(data.value).catch(() => {});
    if (typeof event.waitUntil === "function") event.waitUntil(work);
    return;
  }

  if (data.type !== "couchcoop-sw-reset") return;
  const work = (async () => {
    try {
      await wipeCouchCoopCaches();
    } finally {
      await self.registration.unregister();
    }
  })();
  if (typeof event.waitUntil === "function") event.waitUntil(work);
});

// Test seam. Harmless in production (an object on the worker scope), and it is what lets the pure
// decisions above be unit tested without a browser or a build step.
self.__couchCoopSwInternals = {
  CACHE_FORMAT_VERSION,
  CACHE_PREFIX,
  SHELL_CACHE,
  ASSET_CACHE,
  OFFLINE_URL,
  BUILD_STAMP_KEY,
  ASSET_IDENTITY_KEY,
  CACHE_FIRST_PREFIXES,
  MAX_ASSET_BYTES,
  MAX_ASSET_ENTRIES,
  MAX_ENTRY_BYTES,
  extractBuildStamp,
  classifyRequest,
  isCacheable,
  entryBytes,
  planTrim,
  trimAssetCache,
  reconcileBuildStamp,
  reconcileAssetIdentity,
  handleNavigation,
  handleAsset
};
