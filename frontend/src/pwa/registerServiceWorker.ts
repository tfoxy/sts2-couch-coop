/**
 * Service worker registration policy.
 *
 * The decision is a pure function (`decideServiceWorkerAction`) and the effects are a thin applier, so
 * the interesting part — "when do we put a service worker in front of this app?" — is unit testable
 * without a browser. See public/sw.js for the worker itself and for the cache policy rationale.
 */

export type ServiceWorkerAction = "register" | "unregister" | "skip";

/** The `?sw=` override, parsed out of a query string. `null` when absent/unrecognised. */
export type ServiceWorkerOverride = "on" | "off" | null;

export interface ServiceWorkerDecisionEnv {
  /** `window.isSecureContext`. HTTPS or localhost. */
  isSecureContext: boolean;
  /** Whether `navigator.serviceWorker` exists at all. */
  hasServiceWorkerApi: boolean;
  /** `import.meta.env.DEV` — true under `vite dev`. */
  isDev: boolean;
  /** The `?sw=` override. */
  override: ServiceWorkerOverride;
}

export function readServiceWorkerOverride(search: string): ServiceWorkerOverride {
  let value: string | null = null;
  try {
    value = new URLSearchParams(search).get("sw");
  } catch {
    return null;
  }
  if (value === "on" || value === "1") return "on";
  if (value === "off" || value === "0") return "off";
  return null;
}

/**
 * When to register, when to actively tear down, and when to do nothing.
 *
 * `?sw=off` wins over EVERYTHING, including the "no API here" case, because it is the escape hatch a
 * stuck player can actually reach: type it into the URL bar and every worker and cache of ours is gone.
 * It has to be unconditional or it isn't an escape hatch.
 *
 * Dev is "unregister", not "skip". A worker sitting in front of the Vite dev server is a classic source
 * of "why is my edit not showing up" — and merely skipping registration would leave a previously
 * registered one in place. `?sw=on` opts a dev session back in for testing the real thing.
 *
 * Everything else hinges on the secure context, which is the whole reason this workstream exists: the
 * mod's default LAN URL is plain HTTP, `navigator.serviceWorker` is undefined there, and this returns
 * "skip" with no side effects at all.
 */
export function decideServiceWorkerAction(env: ServiceWorkerDecisionEnv): ServiceWorkerAction {
  if (env.override === "off") return "unregister";
  if (!env.hasServiceWorkerApi || !env.isSecureContext) return "skip";
  if (env.isDev && env.override !== "on") return "unregister";
  return "register";
}

export interface ServiceWorkerApplyEnv extends ServiceWorkerDecisionEnv {
  serviceWorker?: Pick<ServiceWorkerContainer, "register" | "getRegistrations"> | undefined;
  caches?: Pick<CacheStorage, "keys" | "delete"> | undefined;
  /** Called only after a teardown that actually removed something. */
  reload?: () => void;
}

export interface ServiceWorkerApplyResult {
  action: ServiceWorkerAction;
  registered: boolean;
  unregistered: number;
  deletedCaches: number;
  reloaded: boolean;
  error?: unknown;
}

/** Cache-name prefix owned by this app; the teardown never touches anything else's storage. */
const CACHE_PREFIX = "couchcoop-";
/** Must match the file Vite copies from public/. Registered at the root so its scope is the whole app. */
export const SERVICE_WORKER_URL = "/sw.js";

export async function applyServiceWorkerPolicy(env: ServiceWorkerApplyEnv): Promise<ServiceWorkerApplyResult> {
  const action = decideServiceWorkerAction(env);
  const result: ServiceWorkerApplyResult = {
    action,
    registered: false,
    unregistered: 0,
    deletedCaches: 0,
    reloaded: false
  };
  if (action === "skip") return result;

  if (action === "register") {
    try {
      await env.serviceWorker?.register(SERVICE_WORKER_URL, { scope: "/" });
      result.registered = true;
    } catch (error) {
      // A failed registration is not a failed app: the SPA works fine uncached. Swallow it (a bad MIME
      // type, a 404 from an older deploy that predates sw.js, an enterprise policy) and carry on.
      result.error = error;
    }
    return result;
  }

  // --- teardown -------------------------------------------------------------------------------------
  try {
    const registrations = (await env.serviceWorker?.getRegistrations?.()) ?? [];
    for (const registration of registrations) {
      // eslint-disable-next-line no-await-in-loop -- a handful at most, and order doesn't matter.
      const done = await registration.unregister();
      if (done) result.unregistered += 1;
    }
  } catch (error) {
    result.error = error;
  }

  try {
    const names = (await env.caches?.keys()) ?? [];
    const ours = names.filter((name) => name.startsWith(CACHE_PREFIX));
    for (const name of ours) {
      // eslint-disable-next-line no-await-in-loop -- same.
      const done = await env.caches?.delete(name);
      if (done) result.deletedCaches += 1;
    }
  } catch (error) {
    result.error ??= error;
  }

  // Reload ONLY when something was actually removed. That is what makes `?sw=off` terminate: the second
  // pass finds no registrations and no caches of ours, removes nothing, and therefore does not reload.
  if (result.unregistered > 0 || result.deletedCaches > 0) {
    env.reload?.();
    result.reloaded = true;
  }
  return result;
}

/**
 * Wire the policy to the real browser. Fire-and-forget from main.ts.
 *
 * NOT DONE HERE, on purpose: reloading on `controllerchange`. The worker calls `skipWaiting()`, so with
 * a controllerchange-reload the first load after an update would reload itself, and any bug that makes
 * the worker re-activate becomes an infinite reload loop — the exact "permanently unloadable" failure
 * this whole design is trying to avoid. Assets are cache-first by URL, so an updated worker taking over
 * mid-session changes nothing the page can observe.
 */
export function installServiceWorker(): Promise<ServiceWorkerApplyResult> {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const win = typeof window === "undefined" ? undefined : window;
  return applyServiceWorkerPolicy({
    isSecureContext: Boolean(win?.isSecureContext),
    hasServiceWorkerApi: Boolean(nav && "serviceWorker" in nav),
    isDev: import.meta.env.DEV,
    override: readServiceWorkerOverride(win?.location.search ?? ""),
    serviceWorker: nav && "serviceWorker" in nav ? nav.serviceWorker : undefined,
    caches: typeof caches === "undefined" ? undefined : caches,
    reload: () => win?.location.reload()
  });
}
