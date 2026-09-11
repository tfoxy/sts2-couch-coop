// REMEMBERING WHERE THE GAME IS, so a home-screen icon survives a DHCP lease.
//
// This is the whole reason the public-origin mode is worth building. A PWA installed from
// `http://192.168.1.5:13337/` captures that origin in its `start_url` and is dead the moment the router
// hands the PC a different address — the icon is still there, it just goes nowhere, and the fix is
// "delete it and re-add it", which no one will work out. Installed from a STABLE public origin, the LAN
// address stops being part of the app's identity and becomes ordinary data: this store.
//
// A LIST, not a single value, because the realistic failure is not "the address changed" but "the address
// changed and the old one now belongs to something else". Probing several remembered candidates and
// taking whichever actually answers as a CouchCoop host recovers silently in the common case, and the
// recovery screen only has to appear when every candidate is genuinely dead.

import { normalizeHostBase } from "@/join/hostBase";

/** `localStorage` (not session): surviving the tab closing is the entire point. */
export const HOST_STORE_KEY = "couchCoop:hosts";

/** Remembering more than this is remembering other people's networks. */
export const MAX_REMEMBERED_HOSTS = 5;

export interface RememberedHost {
  /** Absolute origin, e.g. `http://192.168.1.5:13337`. Normalised through `normalizeHostBase`. */
  origin: string;
  /** Epoch ms of the last time this origin answered as a CouchCoop host. */
  lastSeenMs: number;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Private-mode Safari and a few embedded webviews throw on mere ACCESS, not just on write.
    return null;
  }
}

/**
 * Read the remembered hosts, most-recently-seen first.
 *
 * Every failure is an empty list, never a throw: a corrupt store must degrade to "ask the player to scan
 * again", which is recoverable, rather than taking the app down on boot, which is not.
 */
export function readHosts(storage: StorageLike | null = defaultStorage()): RememberedHost[] {
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(HOST_STORE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const hosts: RememberedHost[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const origin = normalizeHostBase((entry as { origin?: unknown }).origin as string | undefined);
    if (!origin || seen.has(origin)) continue;
    const rawLastSeen = (entry as { lastSeenMs?: unknown }).lastSeenMs;
    seen.add(origin);
    hosts.push({
      origin,
      lastSeenMs: typeof rawLastSeen === "number" && Number.isFinite(rawLastSeen) ? rawLastSeen : 0
    });
  }
  return hosts.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
}

/**
 * Record that `value` (an authority or a full origin) is a live host, and return the new list.
 *
 * Best-effort persistence: a store we cannot write costs the player one re-scan, which is much better
 * than an exception on the boot path.
 */
export function rememberHost(
  value: string | null | undefined,
  nowMs: number,
  storage: StorageLike | null = defaultStorage()
): RememberedHost[] {
  const origin = normalizeHostBase(value);
  if (!origin) return readHosts(storage);

  const rest = readHosts(storage).filter((host) => host.origin !== origin);
  const hosts = [{ origin, lastSeenMs: nowMs }, ...rest].slice(0, MAX_REMEMBERED_HOSTS);
  try {
    storage?.setItem(HOST_STORE_KEY, JSON.stringify(hosts));
  } catch {
    // Quota or a locked-down store; the in-memory answer is still correct for this session.
  }
  return hosts;
}

/**
 * The ordered candidates to try on boot: an explicit `?h=` first (the player just scanned it, so it is
 * the freshest possible evidence), then the remembered list, then the host's mDNS name if one is known.
 *
 * `.local` earns its place because Chrome exempts `.local` from mixed-content blocking exactly like a
 * private IP literal (docs/agents/local-network-access.md), so it costs nothing to try and rescues the
 * case where every remembered address has moved.
 */
export function hostCandidates(options: {
  fromUrl?: string | null;
  remembered?: RememberedHost[];
  mdnsHost?: string | null;
}): string[] {
  const candidates: string[] = [];
  const push = (value: string | null | undefined): void => {
    const origin = normalizeHostBase(value);
    if (origin && !candidates.includes(origin)) candidates.push(origin);
  };

  push(options.fromUrl);
  for (const host of options.remembered ?? []) push(host.origin);
  push(options.mdnsHost);
  return candidates;
}

/**
 * Pull the host out of a page URL's `?h=` parameter.
 *
 * `?h=` carries an AUTHORITY (`192.168.1.5:13337`), not a full URL, purely to keep the QR's payload short
 * — a denser code is a slower scan across a room, and the scheme is never anything but `http:` for a LAN
 * host. A full origin is still accepted, because someone will inevitably type one.
 */
export function hostFromUrl(href: string | null | undefined): string | null {
  if (typeof href !== "string") return null;
  try {
    return normalizeHostBase(new URL(href).searchParams.get("h"));
  } catch {
    return null;
  }
}
