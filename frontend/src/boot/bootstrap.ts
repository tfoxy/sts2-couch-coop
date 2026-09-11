// THE BOOTSTRAP that runs on the public origin.
//
// This is the only code the public origin ships. It carries no application logic, no protocol knowledge
// and no game assets — it finds the host, asks the browser for permission to reach it, and then loads the
// app THE HOST ITSELF PUBLISHES. That is what makes version skew structurally impossible: a player whose
// mod is three releases old runs the client that shipped with their mod, so there is no compatibility
// banner to show and nothing for them to update before they can play.
//
// It is also the reason a home-screen icon survives a DHCP lease. The PWA's identity is this stable
// origin; the LAN address is ordinary data in `localStorage` (see @/join/hostStore), so an address change
// costs a re-scan at worst, never a re-install.
//
// WHAT THE BROWSER ALLOWS HERE is measured, not assumed — see docs/agents/local-network-access.md. The
// load-bearing facts: a private-IP literal is exempt from mixed-content blocking (so an https page may
// load `http://192.168.x.x` scripts, styles, images and open a `ws://` socket), and all of it is gated on
// a permission that only a WINDOW can prompt for.

import { normalizeHostBase } from "@/join/hostBase";
import { hostCandidates, hostFromUrl, readHosts, rememberHost } from "@/join/hostStore";

/** What the host publishes about the app bundle it wants loaded (vite.config.ts `couchCoopBootManifest`). */
export interface BootManifest {
  entry: string;
  css: string[];
  buildId: string;
  bootProtocol: number;
  /** Whether THIS page's origin may open the host's game socket. */
  originAllowed: boolean;
  /** The origin the host expects the client to be served from, so a refusal can name where to go. */
  webOrigin: string | null;
}

/** The newest boot protocol this bootstrap understands. */
export const SUPPORTED_BOOT_PROTOCOL = 1;

/** Long enough to cross a slow LAN, short enough that probing four dead candidates is not a minute. */
export const HOST_PROBE_TIMEOUT_MS = 4000;

/**
 * Validate a `/app-boot.json` body.
 *
 * Strict on purpose. This decides which script the page is about to EXECUTE, so "looks about right" is
 * not good enough: a captive-portal login page answering 200 with HTML, or an unrelated service on the
 * remembered port, must both fail here rather than further down.
 */
export function parseBootManifest(raw: unknown): BootManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const entry = value.entry;
  const buildId = value.buildId;
  const protocol = value.bootProtocol;
  if (typeof entry !== "string" || !entry.startsWith("/")) return null;
  if (typeof buildId !== "string" || buildId.length === 0) return null;
  if (protocol !== SUPPORTED_BOOT_PROTOCOL) return null;
  if (typeof value.originAllowed !== "boolean") return null;
  const css = Array.isArray(value.css)
    ? value.css.filter((href): href is string => typeof href === "string" && href.startsWith("/"))
    : [];
  return {
    entry,
    css,
    buildId,
    bootProtocol: protocol,
    originAllowed: value.originAllowed,
    webOrigin: typeof value.webOrigin === "string" ? value.webOrigin : null
  };
}

export type BootFailure =
  | { kind: "no-candidates" }
  | { kind: "unreachable"; tried: string[] }
  | { kind: "origin-refused"; origin: string; webOrigin: string | null };

export type BootOutcome =
  | { ok: true; origin: string; manifest: BootManifest }
  | { ok: false; failure: BootFailure };

export interface BootSeams {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Ask one candidate whether it is a CouchCoop host, and what it wants loaded.
 *
 * NEVER THROWS. Every candidate is a guess — a remembered address that has since been handed to a
 * printer, a `.local` name that does not resolve — so a failure is data, not an exception.
 */
export async function probeHost(
  origin: string,
  seams: BootSeams = {}
): Promise<BootManifest | null> {
  const doFetch = seams.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), seams.timeoutMs ?? HOST_PROBE_TIMEOUT_MS);
  try {
    const response = await doFetch(`${origin}/app-boot.json`, {
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal
    });
    if (!response.ok) return null;
    return parseBootManifest(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try every candidate in order and return the first that answers as a host.
 *
 * SEQUENTIAL, not parallel, and that is deliberate. These requests are what trigger the Local Network
 * Access prompt, and firing four at once produces a prompt with several requests already queued behind
 * it — of which the ones to dead addresses then fail anyway. One at a time means the prompt is about the
 * address we actually expect to use, and the common case (the freshest candidate answers) costs exactly
 * one request.
 */
export async function resolveHost(
  candidates: readonly string[],
  seams: BootSeams = {}
): Promise<BootOutcome> {
  if (candidates.length === 0) {
    return { ok: false, failure: { kind: "no-candidates" } };
  }

  for (const origin of candidates) {
    const manifest = await probeHost(origin, seams);
    if (!manifest) continue;
    // FAIL HERE, NOT LATER. HTTP answers a wildcard CORS grant, so a refused origin can fetch this
    // manifest and load the whole app before its `/ws` upgrade is 403'd — and a browser cannot read the
    // status of a failed WebSocket handshake, so the client would just retry forever behind a permanent
    // "Waiting for the game…". One accurate sentence now beats an unexplainable spinner later.
    if (!manifest.originAllowed) {
      return { ok: false, failure: { kind: "origin-refused", origin, webOrigin: manifest.webOrigin } };
    }
    return { ok: true, origin, manifest };
  }

  return { ok: false, failure: { kind: "unreachable", tried: [...candidates] } };
}

/**
 * The ordered candidates for THIS page load: a freshly scanned `?h=`, then what we remember, then the
 * host's `.local` name if one was ever recorded.
 */
export function candidatesForPage(href: string, mdnsHost?: string | null): string[] {
  return hostCandidates({
    fromUrl: hostFromUrl(href),
    remembered: readHosts(),
    mdnsHost
  });
}

/**
 * Inject the host's app: its CSS first, then the entry module.
 *
 * The URLs are ABSOLUTE on the host, which is what makes every chunk, stylesheet and asset BELOW the
 * entry resolve to the host too — the bundle is built with a relative base (`vite.config.ts`), so each
 * module resolves its imports against its own URL rather than against this document.
 */
export function injectApp(
  origin: string,
  manifest: BootManifest,
  doc: Document = document
): Promise<void> {
  // Set BEFORE the entry executes: the app reads it at module scope (see @/join/hostBase).
  (globalThis as { __couchCoopHostBase?: string }).__couchCoopHostBase = origin;

  for (const href of manifest.css) {
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = origin + href;
    doc.head.appendChild(link);
  }

  return new Promise<void>((resolve, reject) => {
    const script = doc.createElement("script");
    script.type = "module";
    script.src = origin + manifest.entry;
    // The app mounts synchronously at module scope, so `load` means "the app is on screen" and is the
    // right moment to take the boot chrome away — earlier would flash an empty page, later would leave
    // the spinner over a running game. `error` keeps the chrome up, which is the whole point of waiting.
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () => reject(new Error("the game's app bundle failed to load")));
    doc.head.appendChild(script);
  });
}

/**
 * Whether the Local Network Access permission is already granted, so a home-screen launch can connect
 * with no tap at all.
 *
 * "prompt" and "unsupported" are both NOT-granted here, and neither is an error: Chrome answers "prompt"
 * for a permission it has never been asked about, and browsers without the API (every current Safari)
 * throw. Both mean "show the button and let the player start it", which is also the right behaviour on a
 * browser that will never prompt because it never restricts.
 */
export async function isPermissionGranted(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query(
      { name: "local-network-access" } as unknown as PermissionDescriptor
    );
    return status.state === "granted";
  } catch {
    return false;
  }
}

/**
 * Record a host that answered, so the next launch finds it without a QR.
 */
export function rememberResolvedHost(origin: string, nowMs: number): void {
  rememberHost(origin, nowMs);
}

/**
 * Strip `?h=` from the address bar once it has been stored.
 *
 * The installed PWA's `start_url` is a bare `/`, and this keeps the RUNNING page consistent with that: a
 * player who adds to home screen mid-session, or shares the URL, should not pin one particular lease.
 * The stored list is the durable copy by then.
 */
export function stripHostParam(href: string): string | null {
  try {
    const url = new URL(href);
    if (!url.searchParams.has("h")) return null;
    url.searchParams.delete("h");
    return url.toString();
  } catch {
    return null;
  }
}

export { normalizeHostBase };
