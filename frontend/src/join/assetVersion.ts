// WHICH GAME BUILD THE HOST'S ASSET BYTES CAME FROM — the `?b=` every asset URL carries.
//
// THE PROBLEM THIS SOLVES. `res://images/atlases/relic_atlas.png` names the same file on every build of Slay
// the Spire 2, and two builds render different pixels from it (the public-beta branch repacked several
// atlases). The host serves every asset as `public, max-age=31536000, immutable`, which is TRUE of the bytes
// but not of the URL: without a build qualifier the browser's HTTP cache pins one build's atlas under a URL
// the other build also asks for, for a year. A phone that joined a beta host then joins a stable one and
// paints the beta's relics.
//
// WHY THE URL AND NOT A CACHE WIPE. The service worker already drops its store when the host's
// `assetCacheToken` moves, and that is not enough on its own for two reasons. It only registers on a SECURE
// context, and the default LAN url is plain HTTP — so on the ordinary path there is no worker at all. And
// even where there is one, deleting the Cache Storage entry only sends the next fetch to the HTTP cache,
// which still holds the same `immutable` response under the same URL and hands the stale bytes straight back.
// A URL that names the build needs no wipe: every layer that caches by URL — the HTTP cache, Cache Storage,
// `force-cache`, `<img src>` dedupe, the mirror's own Map keys — invalidates itself, and the old entries age
// out as the dead weight they are.
//
// WHERE THE VALUE COMES FROM. The `session` envelope's `assetCacheToken`, which the host composes from the
// same identity it keys its OWN on-disk cache on (CouchCoopCacheRoot / AssetCacheToken.Compose), so host and
// client invalidate together rather than from two notions of "which build is this" that can drift apart.
// `mirrorClient` latches it here the moment that envelope is parsed.
//
// TIMING, AND THE ONE CONSUMER THAT RUNS EARLIER. The host sends `session` first, once, before the scene
// keyframe and before any delta — so everything the renderer mints is guaranteed to have the token. The idle
// atlas prefetch is the exception: it starts at component setup, before the socket is even open. It waits on
// `whenAssetVersion` rather than minting unqualified urls (see imagePrefetch.ts).
//
// NO TOKEN => NO SUFFIX, deliberately. An older host that sends no token, a unit test, SSR: all mint exactly
// the url they always did. That keeps `spineClipUrl`'s documented "absent selectors yield a byte-identical
// url" property true, and it means this file can only ever ADD invalidation, never break addressing.
//
// NOT COVERED, on purpose: the two cursor images in `@/browserCursor`. They are emitted as static
// `<link rel="preload">` hints in index.html, so a runtime token would desynchronise the preload from the
// fetch and cost a second download to fix a stale 32x32 cursor. That is a worse trade than the staleness.

/** Query parameter name. `b` for build — `v` is taken twice already (`/bg/` grammar, `/spines/` clip id). */
const PARAM = "b";

let version: string | null = null;
const waiters: Array<() => void> = [];

/**
 * Latch the host's asset-cache token. Idempotent, and null/empty is IGNORED rather than clearing.
 *
 * Forgetting is strictly worse than keeping the last real answer: every connection a page makes is the same
 * game build (the host, then the headless seat it redirects to), so a reconnect that happens to race an
 * envelope must not un-version every url the renderer is about to mint.
 */
export function publishAssetVersion(token: string | null | undefined): void {
  if (typeof token !== "string" || token.length === 0 || token === version) return;
  version = token;
  // Copied and cleared before running: a waiter that re-registers must not be run again in this pass, and a
  // throwing waiter must not strand the rest.
  const pending = waiters.splice(0, waiters.length);
  for (const waiter of pending) {
    try {
      waiter();
    } catch {
      // A waiter that fails is a prefetch that does not start, never a mirror that does not render.
    }
  }
}

/** The latched token, or null when this page has not learned one. */
export function assetVersion(): string | null {
  return version;
}

/**
 * The suffix to append to a host asset route: `""`, `"?b=…"` or `"&b=…"`.
 *
 * `hasQuery` says whether the route being built already carries a `?`. Callers pass a literal, because at
 * every call site it is a property of the route's own grammar rather than of the string in hand.
 */
export function assetVersionSuffix(hasQuery: boolean): string {
  if (version === null) return "";
  return `${hasQuery ? "&" : "?"}${PARAM}=${encodeURIComponent(version)}`;
}

/**
 * Run `fn` once a version is latched — immediately when one already is.
 *
 * For the idle prefetch, which is the only asset consumer that can run before the `session` envelope lands.
 */
export function whenAssetVersion(fn: () => void): void {
  if (version !== null) {
    fn();
    return;
  }
  waiters.push(fn);
}

export function __resetAssetVersionForTest(): void {
  version = null;
  waiters.length = 0;
}
