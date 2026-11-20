// Room stills use the host's descriptor, admitted against the seat's mounted scene. The last admitted
// room still stays latched while the host moves ahead; a seat that moves first waits for the host.
// Character-select stills use the seat's own pick: the host renders any valid character id on request.

import type { BrowserStaticBackgroundDescriptor } from "@/protocol/browserEnvelope";
import { hostBase } from "@/join/hostBase";
import { tryParseCharacterSelectBackgroundSceneId } from "@/mirror/renderer/staticBackgroundPolicy";
import { tunnelRequestUrl } from "@/tunnel/hostTunnel";

/** Width of the host-rendered still in presentation design pixels. */
export const STATIC_BACKGROUND_WIDTH = 2520;

/** The mounted seat background, falling back to the route for older hosts. Empty means no vote. */
export function staticBackgroundIdentity(descriptor: BrowserStaticBackgroundDescriptor | null | undefined): string {
  if (!descriptor) return "";
  if (descriptor.id) return descriptor.id;
  const url = tunnelRequestUrl(descriptor.url, hostBase() || "http://background.invalid");
  return url.pathname + url.search;
}

// The last host descriptor admitted, and the seat scene it was admitted for.
export interface HostStaticBackgroundLatch {
  scenePath: string;
  descriptor: BrowserStaticBackgroundDescriptor;
}

export interface HostStaticBackgroundAdmission {
  descriptor: BrowserStaticBackgroundDescriptor | null;
  latch: HostStaticBackgroundLatch | null;
}

export function admitHostStaticBackground(
  seat: BrowserStaticBackgroundDescriptor | null | undefined,
  host: BrowserStaticBackgroundDescriptor | null | undefined,
  latch: HostStaticBackgroundLatch | null
): HostStaticBackgroundAdmission {
  const scenePath = seat?.scenePath ?? null;
  if (scenePath === null) {
    // The seat has no covered scene mounted: nothing to show, and nothing left to latch for.
    return { descriptor: null, latch: null };
  }
  // The host renders any valid character id; no host publication or room latch is needed.
  if (seat && tryParseCharacterSelectBackgroundSceneId(scenePath) !== null) {
    return { descriptor: seat, latch: null };
  }
  if (host && host.scenePath === scenePath) {
    return { descriptor: host, latch: { scenePath, descriptor: host } };
  }
  if (latch !== null && latch.scenePath === scenePath) {
    return { descriptor: latch.descriptor, latch };
  }
  return { descriptor: null, latch: null };
}

export function sameStaticBackground(
  a: BrowserStaticBackgroundDescriptor | null,
  b: BrowserStaticBackgroundDescriptor | null
): boolean {
  return a === b || (a !== null && b !== null && a.scenePath === b.scenePath && a.url === b.url && a.id === b.id);
}
