// THE VISIT ID — this page's pre-WebSocket identity, read out of the document the host served us.
//
// The host embeds a per-response nonce in the SPA shell (`<meta name="couchcoop-visit" content="…">`,
// injected by VisitIdTag on a `Cache-Control: no-store` response) and records the `GET /` that carried it.
// Until the socket opens, that arrival is the ONLY trace of this device on the host: ConnectionRegistry rows
// begin at the WebSocket upgrade, so a phone that fetched the page and got no further left nothing at all.
// Sending this id back on `join` is what merges those arrivals into this connection's row instead of leaving
// a second, ownerless one — and carrying it on the seat's socket URL is what lets a seat say whether this
// device ever reached IT.
//
// NOT A COOKIE, DELIBERATELY. Cookies are not port-scoped (RFC 6265 §8.5), so one set by `<ip>:13337` rides
// to `<ip>:13357` and to every other service on every other port of that machine. Reading a meta tag means
// the value travels only when this code chooses to send it.
//
// NOT A CREDENTIAL. It selects nothing, authorises nothing, and the host validates its shape before storing
// it. A page with no tag (the vite dev server, an older host, a shell the host declined to rewrite) simply
// has none, and everything works exactly as it did before.

/** The `name` attribute the host injects. Kept in step with `VisitIdTag.MetaName`. */
export const VISIT_META_NAME = "couchcoop-visit";

/** 16 random bytes, lower-case hex — the exact shape the host mints and the only shape it accepts back. */
const VISIT_ID_PATTERN = /^[0-9a-f]{32}$/;

let cached: string | null | undefined;

/**
 * This page's visit id, or null when the document carries none.
 *
 * Memoised: the tag is static for the life of the document, and this is read on every join.
 */
export function readVisitId(doc: Document | undefined = typeof document === "undefined" ? undefined : document): string | null {
  if (cached !== undefined) return cached;
  cached = parseVisitId(doc);
  return cached;
}

/** Re-read the document. Tests only — a real page's tag never changes. */
export function resetVisitIdCache(): void {
  cached = undefined;
}

/** The uncached read, exported so a caller can parse a document it holds directly. */
export function parseVisitId(doc: Document | undefined): string | null {
  if (!doc) return null;
  let content: string | null = null;
  try {
    content = doc.querySelector(`meta[name="${VISIT_META_NAME}"]`)?.getAttribute("content") ?? null;
  } catch {
    // A document that cannot be queried is a document with no visit id. Never a thrown join.
    return null;
  }
  return content !== null && VISIT_ID_PATTERN.test(content) ? content : null;
}
