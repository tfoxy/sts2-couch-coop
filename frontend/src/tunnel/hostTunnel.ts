export interface HostTunnel {
  WebSocket: typeof WebSocket;
  fetch: typeof fetch;
  closed: Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __couchCoopTunnel: HostTunnel | undefined;
}

export function hostWebSocketCtor(): typeof WebSocket {
  return globalThis.__couchCoopTunnel?.WebSocket ?? WebSocket;
}

/** The tunnel protocol addresses host paths; the SW prefix belongs only to browser-facing URLs. */
export function tunnelRequestUrl(input: string | URL, base: string): URL {
  const url = new URL(input, `${base}/`);
  const prefix = new URL(base).pathname.replace(/\/$/, "");
  if (url.pathname.startsWith(`${prefix}/`)) url.pathname = url.pathname.slice(prefix.length);
  return url;
}
