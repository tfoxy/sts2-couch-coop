// WHICH STATIC BACKGROUND A SEAT VIEWER SHOWS — the host's, never the seat's own.
//
// Product rule: the background the host has is the background every seat has (combat, ancient events, shops).
// A viewer redirected to a headless seat holds two sockets, and both deliver a `session` envelope with a
// `staticBackground` descriptor. Only the HOST's URL is one the host's `/bg/` route will render: the seat's
// carries the seat's own probed frame/digest, which the host refuses (a blank stage for events and shops).
//
// The two descriptors play different parts:
//   * the SEAT's names WHICH scene this viewer's game has mounted (its scenePath). Its URL is never used.
//   * the HOST's supplies the picture, admitted only while it names that same scene.
//
// Co-op players move between rooms together, but the two envelopes arrive on separate sockets from separate
// processes, so either can be a room ahead for a moment:
//   * HOST AHEAD — the host already describes the next room while the seat still shows this one. Keep the last
//     host descriptor admitted for the seat's scene (the LATCH) until the seat itself moves on.
//   * SEAT AHEAD — the seat has mounted a scene the host has not described yet. Show nothing until it does; a
//     blank stage is correct, a picture the host did not publish is not.

import type { BrowserStaticBackgroundDescriptor } from "@/protocol/browserEnvelope";

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
  return a === b || (a !== null && b !== null && a.scenePath === b.scenePath && a.url === b.url);
}
