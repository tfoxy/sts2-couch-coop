import { openDirectPeer } from "@godot-scene-web/direct-peer";
import { injectApp, probeHost, resolveHost, webKitPlatform, type BootOutcome, type BootPlatform, type BootSeams } from "./bootstrap";
import { fingerprintFromUrl, hostFromUrl, readHosts } from "@/join/hostStore";
import { createTunnelFetch, createTunnelWebSocketCtor, startServiceWorkerBridge } from "@/tunnel";
import { tunnelRequestUrl } from "@/tunnel/hostTunnel";
import { createPeerSession } from "@/tunnel/peerSession";
import { awaitServiceWorkerControl } from "./serviceWorkerControl";

export interface WebsiteBootSeams extends BootSeams {
  platform?: Pick<BootPlatform, "userAgent" | "maxTouchPoints">;
  openDirectPeer?: typeof openDirectPeer;
  createTunnelFetch?: typeof createTunnelFetch;
  startServiceWorkerBridge?: typeof startServiceWorkerBridge;
  serviceWorker?: ServiceWorkerContainer | null;
  RTCPeerConnection?: typeof RTCPeerConnection | null;
  injectApp?: typeof injectApp;
  beforeInject?: (outcome: Extract<BootOutcome, { ok: true }>) => void;
  reload?: () => void;
  hardReload?: boolean;
  storage?: Storage;
}

function fingerprintForHost(origin: string, href: string): string | null {
  return hostFromUrl(href) === origin ? fingerprintFromUrl(href)
    : readHosts().find(host => host.origin === origin)?.fingerprint ?? null;
}

export function canTunnel(candidates: readonly string[], href: string,
  rtc: typeof RTCPeerConnection | null = globalThis.RTCPeerConnection): boolean {
  return !!rtc && new URL(href).searchParams.get("tunnel") !== "off"
    && candidates.some(origin => fingerprintForHost(origin, href));
}

/** Preserve host priority: try both transports for each host before advancing. */
export async function bootWebsite(candidates: readonly string[], href: string,
  seams: WebsiteBootSeams = {}): Promise<BootOutcome | null> {
  const inject = seams.injectApp ?? injectApp;
  const rtc = seams.RTCPeerConnection === null ? undefined : seams.RTCPeerConnection ?? globalThis.RTCPeerConnection;
  const sw = seams.serviceWorker === undefined ? navigator.serviceWorker : seams.serviceWorker;
  const tunnelEnabled = canTunnel(candidates, href, rtc ?? null);
  const tunnelFirst = new URL(href).searchParams.get("tunnel") === "first"
    || webKitPlatform(seams.platform ?? navigator) !== null;
  let controlPromise: ReturnType<typeof awaitServiceWorkerControl> | undefined;
  for (const origin of candidates) {
    const fingerprint = tunnelEnabled ? fingerprintForHost(origin, href) : null;
    for (const transport of tunnelFirst ? ["tunnel", "direct"] : ["direct", "tunnel"]) {
      if (transport === "direct") {
        const outcome = await resolveHost([origin], seams);
        if (outcome.ok) {
          const previousBase = globalThis.__couchCoopHostBase;
          try {
            seams.beforeInject?.(outcome);
            await inject(outcome.origin, outcome.manifest);
            return outcome;
          } catch (error) {
            globalThis.__couchCoopHostBase = previousBase;
            if (tunnelFirst || !fingerprint || !sw) throw error;
          }
        } else if (outcome.failure.kind === "origin-refused") return outcome;
        continue;
      }
      if (!fingerprint || !sw) continue;
      let peer: Awaited<ReturnType<typeof openDirectPeer>> | undefined;
      let session: ReturnType<typeof createPeerSession> | undefined;
      let bridge: ReturnType<typeof startServiceWorkerBridge> | undefined;
      const previousBase = globalThis.__couchCoopHostBase;
      try {
        controlPromise ??= awaitServiceWorkerControl(sw, seams.reload ?? (() => location.reload()),
          seams.hardReload ?? performance.getEntriesByType("navigation").some(entry => (entry as PerformanceNavigationTiming).type === "reload"),
          seams.storage ?? sessionStorage);
        const control = await controlPromise;
        if (control === "reloading") return null;
        if (control !== "controlled") throw new Error("Service worker unavailable");
        const host = new URL(origin);
        const connect = () => (seams.openDirectPeer ?? openDirectPeer)({ host: host.hostname,
          port: Number(host.port || (host.protocol === "https:" ? 443 : 80)), fingerprint, RTCPeerConnection: rtc });
        peer = await connect();
        session = createPeerSession(peer, connect);
        const open = session.open;
        const tunnelFetch = (seams.createTunnelFetch ?? createTunnelFetch)(open);
        bridge = (seams.startServiceWorkerBridge ?? startServiceWorkerBridge)(tunnelFetch);
        await bridge.ready;
        const manifest = await probeHost(origin, { ...seams,
          fetch: (input, init) => tunnelFetch(new Request(input, init)) });
        if (manifest && !manifest.originAllowed) {
          bridge.stop();
          session.close();
          return { ok: false, failure: { kind: "origin-refused", origin, webOrigin: manifest.webOrigin } };
        }
        if (!manifest || manifest.tunnel !== "couch-tunnel/1") {
          throw new Error("Host tunnel unavailable");
        }
        const base = new URL(bridge.prefix, href).href.replace(/\/$/, "");
        const Socket = createTunnelWebSocketCtor(open);
        globalThis.__couchCoopTunnel = {
          WebSocket: class extends Socket {
            constructor(url: string | URL, protocols?: string | string[]) {
              super(tunnelRequestUrl(url, base), protocols);
            }
          },
          fetch: (input, init) => {
            const request = new Request(input, init);
            return tunnelFetch(new Request(tunnelRequestUrl(request.url, base), request));
          },
          get closed() { return session!.closed; }
        };
        const outcome = { ok: true as const, origin, manifest };
        seams.beforeInject?.(outcome);
        await inject(base, manifest);
        return outcome;
      } catch {
        bridge?.stop();
        if (session) session.close();
        else peer?.close();
        delete globalThis.__couchCoopTunnel;
        globalThis.__couchCoopHostBase = previousBase;
      }
    }
  }
  return { ok: false, failure: candidates.length
    ? { kind: "unreachable", tried: [...candidates] } : { kind: "no-candidates" } };
}
