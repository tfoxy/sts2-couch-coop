import { lstatSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const IPHONE_HARNESS_ORIGIN = "http://127.0.0.1:23339";
export const IPHONE_ARTIFACT_ENV = "COUCHCOOP_IPHONE_ARTIFACT_DIR";
export const REAL_URL_ENV = "COUCHCOOP_E2E_REAL_URL";
export const REAL_GAME_ENV = "COUCHCOOP_ALLOW_REAL_GAME";
export const REAL_EVIDENCE_ENV = "COUCHCOOP_E2E_LOCAL_EVIDENCE";
export const INTERNAL_ARTIFACT_ENV = "COUCHCOOP_IPHONE_INTERNAL_ARTIFACT_DIR";

export interface Environment {
  [name: string]: string | undefined;
}

export interface IphoneRunPlan {
  kind: "hermetic" | "real";
  baseURL: string;
  evidenceEnabled: boolean;
}

export interface SocketLifecycle {
  role: "host" | "seat" | "other";
  queryKeys: string[];
  closed: boolean;
}

export interface SurvivalObservation {
  presented: boolean;
  responsiveSeconds: number;
  pageCrashed: boolean;
  pageErrorCategories: string[];
  sockets: SocketLifecycle[];
}

/**
 * Decide whether this invocation is hermetic or may observe a manually-running game.
 * A real-game run has two independent operator acknowledgements on purpose: a URL alone
 * must never turn an ordinary Playwright command into a live-game probe.
 */
export function resolveIphoneRunPlan(env: Environment): IphoneRunPlan {
  const hasRealUrl = Boolean(env[REAL_URL_ENV]);
  const allowedRealGame = env[REAL_GAME_ENV] === "1";

  if (hasRealUrl !== allowedRealGame) {
    throw new Error(`${REAL_URL_ENV} and ${REAL_GAME_ENV}=1 are both required for a real iPhone WebKit run.`);
  }

  if (!hasRealUrl) {
    return { kind: "hermetic", baseURL: IPHONE_HARNESS_ORIGIN, evidenceEnabled: false };
  }

  if (env.GITHUB_ACTIONS === "true") {
    throw new Error("Real iPhone WebKit mode is refused under GitHub Actions.");
  }

  const url = new URL(env[REAL_URL_ENV]!);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${REAL_URL_ENV} must be an http(s) URL.`);
  }

  return {
    kind: "real",
    baseURL: url.toString(),
    evidenceEnabled: env[REAL_EVIDENCE_ENV] === "1"
  };
}

/** Return query *names* only, bounded before reporting so live URLs never disclose values. */
export function boundedQueryKeyNames(value: string, maximum = 16): string[] {
  if (!Number.isInteger(maximum) || maximum < 1) {
    throw new Error("maximum must be a positive integer.");
  }

  const names = new Set<string>();
  for (const [name] of new URL(value).searchParams) {
    if (name.length <= 64 && /^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) names.add(name);
    if (names.size === maximum) break;
  }
  return [...names].sort();
}

export function socketLifecycle(url: string, hostOrigin: string): SocketLifecycle {
  const parsed = new URL(url);
  const host = new URL(hostOrigin);
  return {
    // `URL.origin` includes the scheme, so ws:// and http:// never compare equal even on the same authority.
    role: parsed.pathname !== "/ws" ? "other" : parsed.host === host.host ? "host" : "seat",
    queryKeys: boundedQueryKeyNames(url),
    closed: false
  };
}

export interface SharedIphoneSurvivalResult {
  presentations: number;
  acks: number;
  hostSocketOpen: boolean;
  seatSocketOpen: boolean;
  viewError: boolean;
  animationFrames: number;
  responsive: boolean;
  crash: boolean;
}

/**
 * The iPhone/harness item supplies this module. Keeping the import dynamic lets this narrowly scoped
 * Playwright item typecheck on its approved base, while failing closed once the shared validator is present.
 */
export async function validateSharedIphoneSurvival(result: SharedIphoneSurvivalResult): Promise<void> {
  const sharedModule = new URL("../../scripts/lib/iphone-survival-contract.mjs", import.meta.url);
  try {
    const loaded = await import(sharedModule.href) as {
      validateIphoneSurvival?: (value: SharedIphoneSurvivalResult) => { ok: boolean; failures: string[] };
    };
    if (typeof loaded.validateIphoneSurvival !== "function") {
      throw new Error("Shared iPhone survival contract has no validateIphoneSurvival export.");
    }
    const verdict = loaded.validateIphoneSurvival(result);
    if (!verdict.ok) throw new Error(`iPhone survival contract failed: ${verdict.failures.join("; ")}`);
  } catch (error) {
    const missingModule = error instanceof Error && (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND";
    if (!missingModule) throw error;
    // The approved base does not have the sibling-owned contract yet. Preserve its non-negotiable failures
    // locally, and let integration upgrade this call to the single shared validator without a copied contract.
    assertSurvival({
      presented: result.presentations >= 2,
      responsiveSeconds: result.responsive ? 10 : 0,
      pageCrashed: result.crash,
      pageErrorCategories: [],
      sockets: [
        { role: "host", queryKeys: [], closed: !result.hostSocketOpen },
        { role: "seat", queryKeys: [], closed: !result.seatSocketOpen }
      ]
    });
  }
}

/** A supplied artifact directory may only be a child of this invocation's private temp root. */
export function assertInternalArtifactPath(tempRoot: string, candidate: string): string {
  const root = resolve(tempRoot);
  const target = resolve(candidate);
  const pathFromRoot = relative(root, target);
  if (!pathFromRoot || pathFromRoot.startsWith("..") || pathFromRoot.includes("../")) {
    throw new Error(`${IPHONE_ARTIFACT_ENV} must be inside this iPhone WebKit invocation's temporary directory.`);
  }
  return target;
}

/**
 * The one repository destination CI may upload. It is intentionally not a general output-dir knob:
 * allowing a caller to choose a broader directory would let an artifact collector sweep in game data.
 */
export function resolveHermeticArtifactExport(repoRoot: string, candidate: string | undefined): string | null {
  if (!candidate) return null;
  const root = resolve(repoRoot);
  const allowed = join(root, ".ci-artifacts", "iphone-webkit");
  const target = resolve(candidate);
  if (target !== allowed) {
    throw new Error(`${IPHONE_ARTIFACT_ENV} may only be ${allowed}.`);
  }

  let current = root;
  for (const part of relative(root, target).split("/")) {
    if (!part) continue;
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`${IPHONE_ARTIFACT_ENV} rejects symlinked path components.`);
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return target;
}

/**
 * This is deliberately data-only. The sibling iPhone/harness item owns the shared validator at
 * scripts/lib/iphone-survival-contract.mjs; its adapter consumes this exact shape after integration.
 */
export function assertSurvival(observation: SurvivalObservation, options: { requireSeat?: boolean } = {}): void {
  if (observation.pageCrashed) throw new Error("iPhone WebKit page crashed.");
  if (!observation.presented) throw new Error("No first presented frame was observed.");
  if (observation.responsiveSeconds < 10) throw new Error("The page was not responsive for ten seconds.");
  const requireSeat = options.requireSeat !== false;
  if (observation.sockets.some((socket) => (socket.role === "host" || (requireSeat && socket.role === "seat")) && socket.closed)) {
    throw new Error("A required view WebSocket closed before the survival window completed.");
  }
  if (!observation.sockets.some((socket) => socket.role === "host" && !socket.closed)) {
    throw new Error("The required host WebSocket was not open for the survival window.");
  }
  if (requireSeat && !observation.sockets.some((socket) => socket.role === "seat" && !socket.closed)) {
    throw new Error("The required seat WebSocket was not open for the survival window.");
  }
}
