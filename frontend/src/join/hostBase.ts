// WHERE THE GAME HOST LIVES — the single source of truth, for both ways this app can be loaded.
//
// Two topologies, one app:
//
//   HOST-SERVED (the default, and every path that existed before this file). The mod serves the SPA
//   itself, so the page origin IS the host: `http://192.168.1.5:13337/`, or the opt-in `local-ip.co`
//   HTTPS origin. Every route is origin-relative and nothing here changes behaviour.
//
//   REMOTE-HOSTED (the "web link" QR option). The page comes from a public HTTPS origin — normal DNS,
//   normal certificate — and reaches the host by literal IPv4 over plain HTTP, gated by the browser's
//   Local Network Access permission. The page origin and the host origin are DIFFERENT, so an
//   origin-relative `/res/…` would resolve against the public origin and 404.
//
// The bootstrap on the public origin sets `window.__couchCoopHostBase` BEFORE it injects the app bundle,
// so by the time any of this runs the answer is already known and constant for the lifetime of the page.
// See docs/agents/local-network-access.md for what the browser does and does not allow across that gap.
//
// THE SCHEME RULE, which is the one genuinely counter-intuitive part. In remote-hosted mode the PAGE is
// `https:` while the HOST is `http:`. A WebSocket URL derived from `location.protocol` would therefore
// come out `wss:` and fail — nothing is listening for TLS on the host's port. So the socket scheme is
// derived from the HOST BASE, never from the page. That was the pre-existing bug this module removes:
// `buildMirrorWebSocketUrl` and friends all read `sourceLocation.protocol`.

/** Set by the public-origin bootstrap before the app bundle loads. Absent in host-served mode. */
declare global {
  // eslint-disable-next-line no-var
  var __couchCoopHostBase: string | undefined;
}

/**
 * Normalise an authority (`192.168.1.5:13337`) or a full origin into an absolute origin string with no
 * trailing slash, or null when it cannot be one.
 *
 * A bare authority is assumed `http:` — that is what the QR carries and what the mod actually listens on;
 * a caller that means HTTPS passes the scheme explicitly.
 */
export function normalizeHostBase(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  return url.origin;
}

// MEMO for `hostBase`. It sits on the mirror's hottest path — `mirrorResourceUrl` runs it twice per call (once
// through `isRemoteHosted`, once for the prefix), and that is once per textured node per delta — while its answer
// is constant for the life of the page. What the memo removes is `normalizeHostBase`'s `new URL()` and the
// `location.origin` read; what it costs on a hit is one property read and one string compare.
//
// KEYED ON THE RAW GLOBAL rather than computed once, on purpose. The bootstrap sets `__couchCoopHostBase` before
// it injects the app bundle (see @/boot/bootstrap), but the boot bundle has its own module instance of this file
// and the specs set/delete the global between cases — so a one-shot cache could serve a stale answer to either.
// A changed global invalidates on the next call, which is also what keeps the resource-URL cache downstream honest.
//
// The host-served fallback (`location.origin`) IS cached unconditionally: a document's origin cannot change
// without discarding the JS context that holds this module.
let memoRaw: string | undefined;
let memoBase = "";
let memoValid = false;

/**
 * The origin every host request goes to. Falls back to the page's own origin, which is exactly right for
 * host-served mode and keeps every existing caller behaving identically.
 */
export function hostBase(): string {
  const raw = globalThis.__couchCoopHostBase;
  if (memoValid && raw === memoRaw) return memoBase;
  const injected = normalizeHostBase(raw);
  memoRaw = raw;
  memoValid = true;
  memoBase = injected ?? (typeof location === "undefined" ? "" : location.origin);
  return memoBase;
}

/** Whether the app is running against a host that is NOT its own origin. */
export function isRemoteHosted(): boolean {
  if (typeof location === "undefined") return false;
  return hostBase() !== location.origin;
}

/**
 * A URL on the host for a root-relative route (`/res/foo.png`, `/ws?watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0`).
 *
 * RETURNS THE ROUTE UNCHANGED IN HOST-SERVED MODE, on purpose. These strings are not only fetched — they
 * are cache keys, `Map` keys, dedupe keys and equality tests in the mirror's hot paths (reflow cache,
 * atlas residency, still cache, image prefetch). Prefixing them with `location.origin` would be
 * semantically identical and behaviourally identical to the network, while silently re-keying every one
 * of those caches. So the prefix is added ONLY when it is actually needed, and the default path stays
 * byte-for-byte what it was.
 *
 * Deliberately tolerant of an already-absolute input: several call sites pass values that may already
 * carry an origin (a URL echoed back by the host, a test seam), and re-basing those would corrupt them.
 */
export function hostUrl(route: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(route)) return route;
  if (!isRemoteHosted()) return route;
  const base = hostBase();
  if (!base) return route;
  return route.startsWith("/") ? base + route : `${base}/${route}`;
}

/**
 * A WebSocket URL on the host. Always absolute (a socket has no relative form), and `ws:`/`wss:` follows
 * the HOST's scheme — see the scheme rule at the top of this file.
 *
 * `pageHref` is the fallback base for host-served mode, where the host origin is the page origin; it is a
 * parameter rather than a `location` read so the URL builders stay unit-testable, which is how they were
 * already written.
 */
export function hostWsUrl(route: string, pageHref?: string): string {
  const base = isRemoteHosted() ? hostBase() : (pageHref ?? hostBase());
  const url = new URL(route, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
