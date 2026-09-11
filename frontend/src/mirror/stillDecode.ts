// Decode a single-frame spine still before swapping its live `<img>` source, so the existing frame remains visible
// until the replacement is paintable. Without `HTMLImageElement.decode`, or when a decode fails, this fails open:
// `ready` is still called and the normal element upload path proceeds.

/** The decode step, isolated so vitest can stand in for it (mirrors `CanvasSnapshotSource` in mirrorRenderer). */
export type StillDecoder = (url: string, ready: (ok: boolean) => void) => void;

function decodeStillImpl(url: string, ready: (ok: boolean) => void): void {
  if (typeof Image === "undefined") {
    ready(true); // no DOM image support at all — pass through synchronously
    return;
  }
  let probe: HTMLImageElement;
  try {
    probe = new Image();
  } catch {
    ready(true);
    return;
  }
  if (typeof probe.decode !== "function") {
    ready(true); // SYNCHRONOUS pass-through (jsdom): the caller commits inline, as it did before the gate
    return;
  }
  let settled = false;
  const settle = (ok: boolean): void => {
    if (settled) {
      return;
    }
    settled = true;
    probe.onload = null;
    probe.onerror = null;
    ready(ok);
  };
  // `async` on the PROBE: this decode is off the critical path by construction (nothing is waiting to paint it).
  // The live element is the one that gets `decoding = "sync"`, so its swap presents atomically.
  probe.decoding = "async";
  try {
    probe.src = url;
  } catch {
    ready(true);
    return;
  }
  try {
    probe.decode().then(
      () => settle(true),
      () => {
        // decode() rejects on a load failure (EncodingError) and in some engines on a detached/revoked blob.
        // Fall back to the load state: `complete` means the fetch finished either way, otherwise wait for it.
        if (probe.complete) {
          settle(probe.naturalWidth > 0);
          return;
        }
        probe.onload = () => settle(true);
        probe.onerror = () => settle(false);
      }
    );
  } catch {
    settle(true); // a throwing decode() is not a reason to hold a frame back
  }
}

let stillDecoder: StillDecoder = decodeStillImpl;

/**
 * Decode `url` into the browser's image cache and call `ready` when it is paintable. `ok` reports whether the
 * decode succeeded; callers commit the swap EITHER WAY (see the fail-open note above).
 */
export function decodeStill(url: string, ready: (ok: boolean) => void): void {
  stillDecoder(url, ready);
}

/** TEST-ONLY: stand in for the (async, browser-only) image decode. Pass null to restore production. */
export function __setStillDecoderForTest(decoder: StillDecoder | null): void {
  stillDecoder = decoder ?? decodeStillImpl;
}
