/*
 * CouchCoop service worker for the PUBLIC origin (the "web link" mode).
 *
 * Sibling of frontend/public/sw.js, which serves the host-served origins. They are deliberately separate
 * files rather than one shared worker, because the constraint below makes their fetch policies genuinely
 * different — merging them would mean one file whose every branch asks "which origin am I on".
 *
 * ---------------------------------------------------------------------------------------------------
 * THE CONSTRAINT (measured — docs/agents/local-network-access.md)
 * ---------------------------------------------------------------------------------------------------
 * A window on this origin may fetch `http://192.168.x.x/...`: a private-IP literal is exempt from
 * mixed-content blocking. A SERVICE WORKER may not. The same request from worker scope is hard-blocked:
 *
 *     Mixed Content: The page at '.../sw.js' was loaded over HTTPS, but requested an insecure resource
 *     'http://192.168.0.89:13337/...'. This request has been blocked; the content must be served over HTTPS.
 *
 * Two consequences, and the second is the trap:
 *
 *   1. This worker can never POPULATE a host-asset cache. Only a window can fetch those bytes.
 *
 *   2. `respondWith(fetch(request))` for a host URL BREAKS A REQUEST THE BROWSER WOULD HAVE SERVED. Once
 *      this worker controls the page, every `<img src="http://…">` the mirror creates passes through here
 *      — and taking ownership of one only to re-`fetch` it converts a working load into a network error.
 *      Nor can we decide "is it a miss?" first: `caches.match` is async, so by the time we know, we have
 *      already called respondWith and owe a response.
 *
 * So the rule below is absolute: DECIDE SYNCHRONOUSLY, FROM AN INDEX. Only call respondWith for a URL we
 * already know we hold; return without it for everything else, which hands the request back to the
 * browser's own stack untouched. That is the "bypass" default the sibling worker also relies on, and here
 * it is load-bearing rather than merely tidy.
 *
 * ---------------------------------------------------------------------------------------------------
 * WHAT IS AND IS NOT CACHED TODAY
 * ---------------------------------------------------------------------------------------------------
 * CACHED: this origin's own shell — the bootstrap document, boot.js, the manifest and the icons. All
 * same-origin, all fetchable from here, and together they are what makes an installed home-screen icon
 * open instantly instead of waiting on a CDN round trip.
 *
 * NOT CACHED YET: the host's game assets. The mechanism to serve them is below and correct, but nothing
 * populates it — that needs the WINDOW (or a dedicated worker, which does inherit the permission) to
 * `cache.put` each asset as it loads, which is a change to the mirror's asset hot path and wants a
 * measurement on a real phone before it lands. Until then remote-hosted mode leans on the HTTP cache,
 * exactly as the plain-LAN mode always has: the host already serves `/res/` as
 * `public, max-age=31536000, immutable`.
 *
 * ESCAPE HATCHES, same as the sibling worker: `?sw=off` on any URL (the registrar in @/boot/main skips
 * registration), a `couchcoop-sw-reset` message, or bumping CACHE_VERSION.
 */

const CACHE_VERSION = "v1";
const SHELL_CACHE = `couchcoop-boot-shell-${CACHE_VERSION}`;
const HOST_CACHE = `couchcoop-host-assets-${CACHE_VERSION}`;
const CACHE_PREFIX = "couchcoop-";

// The shell. Kept to what a cold home-screen launch genuinely needs — this is not a precache manifest and
// must not grow into one, because every entry is a file that can go stale behind a deploy.
const SHELL_URLS = ["/", "/boot.js", "/manifest.webmanifest", "/manifest.zh-Hans.webmanifest", "/manifest.de.webmanifest", "/manifest.es-419.webmanifest", "/manifest.fr.webmanifest", "/manifest.it.webmanifest", "/manifest.ja.webmanifest", "/manifest.ko.webmanifest", "/manifest.pl.webmanifest", "/manifest.pt-BR.webmanifest", "/manifest.ru.webmanifest", "/manifest.es-ES.webmanifest", "/manifest.th.webmanifest", "/manifest.tr.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

/**
 * Which host URLs we hold, readable SYNCHRONOUSLY. This is the whole design — see the header.
 * Rebuilt from storage on activate (the worker is killed and restarted constantly and must not forget
 * what it holds) and updated by `couchcoop-cached` messages from the window.
 */
const heldHostUrls = new Set();

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // `addAll` is atomic-ish: one failure rejects the lot, which is right for a shell — a half-cached
    // shell is worse than none, since the missing half would 404 offline instead of falling back.
    await cache.addAll(SHELL_URLS).catch(() => {
      // …but a failed install must not stop the worker existing; it just means no offline shell today.
    });
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(HOST_CACHE);
      for (const request of await cache.keys()) heldHostUrls.add(request.url);
    } catch {
      // No host cache yet; the index simply stays empty and every request bypasses.
    }
    // Sweep our own orphans from older CACHE_VERSIONs. Scoped by prefix so nothing else's storage is
    // ever touched.
    const names = await caches.keys();
    await Promise.all(names.map((name) =>
      name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE && name !== HOST_CACHE
        ? caches.delete(name)
        : Promise.resolve(false)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};

  if (data.type === "couchcoop-cached" && typeof data.url === "string") {
    heldHostUrls.add(data.url);
    return;
  }

  // Full wipe, for a page that has decided this worker is the problem.
  if (data.type === "couchcoop-sw-reset") {
    event.waitUntil((async () => {
      heldHostUrls.clear();
      const names = await caches.keys();
      await Promise.all(names.map((name) =>
        name.startsWith(CACHE_PREFIX) ? caches.delete(name) : Promise.resolve(false)));
      await self.registration.unregister();
    })());
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // The game socket. Never, under any circumstances — upgrades do not go through `fetch` in the first
  // place, but this is stated explicitly so no future refactor can make it cacheable.
  if (url.pathname === "/ws" || url.pathname.startsWith("/ws/")) return;

  if (url.origin === self.location.origin) {
    // Our own shell. Network-first for the DOCUMENT so a deploy is never pinned behind a cached page,
    // cache-first for the static rest.
    if (request.mode === "navigate") {
      event.respondWith(
        fetch(request).catch(async () => (await caches.match("/")) ?? Response.error())
      );
      return;
    }
    if (SHELL_URLS.includes(url.pathname)) {
      event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
    }
    return;
  }

  // A HOST url. Serve it ONLY if we already know we hold it; otherwise bypass entirely. See the header —
  // this synchronous check is the whole point, and `fetch` must never appear on this path.
  if (heldHostUrls.has(request.url)) {
    event.respondWith((async () => {
      const cache = await caches.open(HOST_CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;
      // The index disagreed with storage (an eviction we were not told about). We have already taken
      // ownership and cannot hand the request back, so re-fetching is the only option left — and from
      // worker scope that will fail for an http host. Drop the stale entry so the NEXT load bypasses
      // cleanly, which is the outcome that actually heals this.
      heldHostUrls.delete(request.url);
      return fetch(request);
    })());
  }
});
