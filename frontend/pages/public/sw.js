/*
 * CouchCoop service worker for the PUBLIC origin (the "web link" mode).
 *
 * Sibling of frontend/public/sw.js, which serves the host-served origins. They are deliberately separate
 * files rather than one shared worker, because the constraint below makes their fetch policies genuinely
 * different — merging them would mean one file whose every branch asks "which origin am I on".
 *
 * ---------------------------------------------------------------------------------------------------
 * THE CONSTRAINT (measured — docs/local-network-access.md)
 * ---------------------------------------------------------------------------------------------------
 * A window on this origin may fetch `http://192.168.x.x/...`: a private-IP literal is exempt from
 * mixed-content blocking. A SERVICE WORKER may not. The same request from worker scope is hard-blocked:
 *
 *     Mixed Content: The page at '.../sw.js' was loaded over HTTPS, but requested an insecure resource
 *     'http://192.168.1.77:13337/...'. This request has been blocked; the content must be served over HTTPS.
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
 * already know we hold, or for a same-origin tunnel prefix owned by a window; return without it for
 * other requests, which hands them back to the
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

  if (data.type === "couchcoop-tunnel-register") {
    registerTunnel(event);
    return;
  }

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

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // This same-origin virtual path is answered by its window, never by a worker host fetch.
  const tunnel = url.origin === self.location.origin && /^\/~h\/([A-Za-z0-9_-]{22})\//.exec(url.pathname);
  if (tunnel) {
    event.respondWith(tunnelRequest(request, tunnel[1], url.pathname.slice(tunnel[0].length - 1) + url.search));
    return;
  }
  if (request.method !== "GET") return;

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

// Ports are ephemeral; an active window can re-register when this worker has restarted.
const tunnelTabs = new Map();
const tunnelDiscoveries = new Map();
let tunnelRequestId = 0;

function registerTunnel(event) {
  const tab = event.data.tab;
  const port = event.ports && event.ports[0];
  if (typeof tab !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(tab) || !port || !event.source?.id) return;
  const previous = tunnelTabs.get(tab);
  if (previous && previous.clientId !== event.source.id) { port.close(); return; }
  if (previous) {
    for (const pending of previous.requests.values()) pending.fail(new Error("Tunnel port replaced"));
    previous.port.close();
  }
  const entry = { port, clientId: event.source.id, requests: new Map() };
  tunnelTabs.set(tab, entry);
  port.onmessage = ({ data }) => {
    if (data.type === "unregister") {
      if (tunnelTabs.get(tab) === entry) tunnelTabs.delete(tab);
      for (const pending of entry.requests.values()) pending.fail(new Error("Tunnel window closed"));
      port.close();
      return;
    }
    entry.requests.get(data.id)?.message(data);
  };
  port.start();
  port.postMessage({ type: "registered", tab });
  tunnelDiscoveries.get(tab)?.resolve(entry);
}

async function findTunnel(tab) {
  if (tunnelTabs.has(tab)) return tunnelTabs.get(tab);
  if (tunnelDiscoveries.has(tab)) return tunnelDiscoveries.get(tab).promise;
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  const finish = entry => {
    clearTimeout(timer);
    tunnelDiscoveries.delete(tab);
    resolve(entry);
  };
  const timer = setTimeout(() => finish(null), 5000);
  tunnelDiscoveries.set(tab, { promise, resolve: finish });
  try {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (!windows.length) finish(null);
    for (const client of windows) client.postMessage({ type: "couchcoop-tunnel-discover", tab });
  } catch { finish(null); }
  return promise;
}

async function tunnelRequest(request, tab, path) {
  const entry = await findTunnel(tab);
  if (!entry) return Response.error();
  let body;
  if (request.body) {
    const reader = request.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 1024 * 1024) { await reader.cancel(); return new Response(null, { status: 413 }); }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      body = bytes.buffer;
    } finally { reader.releaseLock(); }
  }
  return new Promise((resolve, reject) => {
    const id = ++tunnelRequestId;
    const chunks = [];
    let controller;
    let demand = false;
    let ended = false;
    let responded = false;
    const cleanup = () => { entry.requests.delete(id); request.signal?.removeEventListener("abort", abort); };
    const cancel = () => { entry.port.postMessage({ type: "cancel", id }); cleanup(); };
    const fail = error => {
      if (responded) controller?.error(error); else reject(error);
      cancel();
    };
    const abort = () => fail(request.signal.reason);
    const flush = () => {
      if (demand && chunks.length) {
        demand = false;
        controller.enqueue(new Uint8Array(chunks.shift()));
        entry.port.postMessage({ type: "credit", id, count: 1 });
      }
      if (ended && !chunks.length && controller) { controller.close(); cleanup(); }
    };
    entry.requests.set(id, {
      fail,
      message(data) {
        if (data.type === "error") { fail(new Error(data.message)); return; }
        if (data.type === "response") {
          if (responded) { fail(new Error("Duplicate tunnel response")); return; }
          const noBody = request.method === "HEAD" || [204, 205, 304].includes(data.status);
          const stream = noBody ? null : new ReadableStream({
            start(value) { controller = value; },
            pull() { demand = true; flush(); },
            cancel
          }, { highWaterMark: 0 });
          try {
            const response = new Response(stream, { status: data.status, headers: data.headers });
            responded = true;
            resolve(response);
          } catch (error) { fail(error); }
        } else if (data.type === "chunk") {
          if (!responded || !controller || data.chunk.byteLength > 16384 || chunks.length >= 8) {
            fail(new Error("Invalid tunnel chunk or credit overflow")); return;
          }
          chunks.push(data.chunk);
          flush();
        } else if (data.type === "end") {
          if (!responded) { fail(new Error("Missing tunnel response")); return; }
          ended = true;
          if (controller) flush(); else cleanup();
        }
      }
    });
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) { abort(); return; }
    entry.port.postMessage({ type: "request", id, method: request.method, url: path, headers: [...request.headers], ...(body ? { body } : {}) }, body ? [body] : []);
  });
}
