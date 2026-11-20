import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SUPPORTED_BOOT_PROTOCOL,
  candidatesForPage,
  injectApp,
  parseBootManifest,
  probeHost,
  resolveHost,
  rememberResolvedHost,
  stripHostParam,
  webLinkBlockedByBrowser,
  type BootManifest
} from "@/boot/bootstrap";
import { HOST_STORE_KEY, readHosts, rememberHost } from "@/join/hostStore";

const MANIFEST: BootManifest = {
  entry: "/app/index-abc123.js",
  css: ["/app/index-def456.css"],
  buildId: "abc123",
  bootProtocol: 1,
  originAllowed: true,
  webOrigin: "https://sts2-couch.pages.dev"
};

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

afterEach(() => {
  localStorage.clear();
  delete (globalThis as { __couchCoopHostBase?: string }).__couchCoopHostBase;
});

describe("parseBootManifest", () => {
  it("accepts what the build actually emits", () => {
    expect(parseBootManifest({ ...MANIFEST })).toEqual(MANIFEST);
  });

  it("tolerates a missing css list", () => {
    expect(parseBootManifest({ entry: "/app/i.js", buildId: "x", bootProtocol: 1, originAllowed: true })?.css).toEqual([]);
  });

  it("requires an explicit originAllowed boolean", () => {
    expect(parseBootManifest({ entry: "/app/i.js", buildId: "x", bootProtocol: 1 })).toBeNull();
    expect(parseBootManifest({ entry: "/app/i.js", buildId: "x", bootProtocol: 1, originAllowed: "true" })).toBeNull();
  });

  it("reads an explicit originAllowed:false as refused", () => {
    expect(parseBootManifest({
      entry: "/app/i.js", buildId: "x", bootProtocol: 1, originAllowed: false, webOrigin: "https://a.example"
    })?.originAllowed).toBe(false);
  });

  // This decides which script the page is about to EXECUTE, so a captive portal answering 200 with HTML,
  // or some unrelated service on the remembered port, has to fail HERE rather than further down.
  it.each([
    ["a non-object", "<html>hello</html>"],
    ["null", null],
    ["a missing entry", { buildId: "x", bootProtocol: 1, originAllowed: true }],
    ["a non-string entry", { entry: 7, buildId: "x", bootProtocol: 1, originAllowed: true }],
    ["an entry that is not root-relative", { entry: "app/i.js", buildId: "x", bootProtocol: 1, originAllowed: true }],
    ["an absolute entry pointing elsewhere", { entry: "https://evil.example/x.js", buildId: "x", bootProtocol: 1, originAllowed: true }],
    ["a missing buildId", { entry: "/app/i.js", bootProtocol: 1, originAllowed: true }],
    ["a missing protocol", { entry: "/app/i.js", buildId: "x", originAllowed: true }],
    ["a non-numeric protocol", { entry: "/app/i.js", buildId: "x", bootProtocol: "1", originAllowed: true }],
    ["a wrong old protocol", { entry: "/app/i.js", buildId: "x", bootProtocol: 0, originAllowed: true }],
    ["a wrong newer protocol", { entry: "/app/i.js", buildId: "x", bootProtocol: 2, originAllowed: true }]
  ])("refuses %s", (_label, raw) => {
    expect(parseBootManifest(raw)).toBeNull();
  });

  it("drops css entries that are not root-relative rather than the whole manifest", () => {
    const parsed = parseBootManifest({
      entry: "/app/i.js",
      css: ["/app/a.css", "https://evil.example/b.css", 7],
      buildId: "x",
      bootProtocol: 1,
      originAllowed: true
    });
    expect(parsed?.css).toEqual(["/app/a.css"]);
  });
});

describe("probeHost", () => {
  it("returns the manifest when the host answers", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(MANIFEST));
    await expect(probeHost("http://192.168.1.5:13337", { fetch: fetchStub })).resolves.toEqual(MANIFEST);
    expect(fetchStub.mock.calls[0][0]).toBe("http://192.168.1.5:13337/app-boot.json");
  });

  // Every candidate is a guess — a remembered address since handed to a printer, a `.local` that does not
  // resolve. A failure has to be data, not an exception, or one dead entry takes the whole boot down.
  it.each([
    ["a rejected fetch", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a non-2xx", () => Promise.resolve(jsonResponse({}, false))],
    ["a body that is not JSON", () => Promise.resolve({ ok: true, json: async () => { throw new SyntaxError("nope"); } } as unknown as Response)],
    ["a body that is not a manifest", () => Promise.resolve(jsonResponse({ hello: "world" }))]
  ])("answers null for %s, never throws", async (_label, impl) => {
    await expect(probeHost("http://192.168.1.5:13337", { fetch: vi.fn(impl) })).resolves.toBeNull();
  });
});

describe("resolveHost", () => {
  it("takes the first candidate that answers, and does not probe past it", async () => {
    const fetchStub = vi.fn(async (url: string) =>
      url.startsWith("http://192.168.1.9") ? jsonResponse(MANIFEST) : jsonResponse({}, false));
    const outcome = await resolveHost(
      ["http://192.168.1.5:13337", "http://192.168.1.9:13337", "http://192.168.1.7:13337"],
      { fetch: fetchStub as unknown as typeof fetch }
    );
    expect(outcome).toEqual({ ok: true, origin: "http://192.168.1.9:13337", manifest: MANIFEST });
    // The third is never tried: probing is what triggers the permission prompt, so a needless request is
    // a needless prompt.
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it("reports every candidate it tried when none answer", async () => {
    const outcome = await resolveHost(["http://a.example", "http://b.example"], {
      fetch: vi.fn().mockResolvedValue(jsonResponse({}, false))
    });
    expect(outcome).toEqual({
      ok: false,
      failure: { kind: "unreachable", tried: ["http://a.example", "http://b.example"] }
    });
  });

  it("distinguishes 'nothing to try' from 'nothing answered'", async () => {
    await expect(resolveHost([], { fetch: vi.fn() })).resolves.toEqual({
      ok: false,
      failure: { kind: "no-candidates" }
    });
  });

  // THE REGRESSION THIS EXISTS FOR. HTTP answers a wildcard CORS grant, so a refused origin can fetch the
  // manifest and load the entire app — and then have its /ws upgrade 403'd, which a browser reports as an
  // indistinguishable connection error. Without this branch the player gets a permanent "Waiting for the
  // game…" and nothing to act on.
  it("refuses a host that will not accept this origin, BEFORE loading the app", async () => {
    const outcome = await resolveHost(["http://192.168.1.5:13337"], {
      fetch: vi.fn().mockResolvedValue(jsonResponse({
        ...MANIFEST, originAllowed: false, webOrigin: "https://sts2-couch.pages.dev"
      }))
    });
    expect(outcome).toEqual({
      ok: false,
      failure: {
        kind: "origin-refused",
        origin: "http://192.168.1.5:13337",
        webOrigin: "https://sts2-couch.pages.dev"
      }
    });
  });

  it("treats a host with a different boot protocol as not a host", async () => {
    const outcome = await resolveHost(["http://192.168.1.5:13337"], {
      fetch: vi.fn().mockResolvedValue(
        jsonResponse({ ...MANIFEST, bootProtocol: SUPPORTED_BOOT_PROTOCOL + 1 }))
    });
    expect(outcome).toEqual({
      ok: false,
      failure: { kind: "unreachable", tried: ["http://192.168.1.5:13337"] }
    });
  });
});

describe("candidatesForPage", () => {
  it("puts a freshly scanned ?h= ahead of everything remembered", () => {
    localStorage.setItem(HOST_STORE_KEY, JSON.stringify([
      { origin: "http://192.168.1.5:13337", lastSeenMs: 5 }
    ]));
    expect(candidatesForPage("https://sts2-couch.pages.dev/?h=192.168.1.9:13337", "worky.local:13337"))
      .toEqual([
        "http://192.168.1.9:13337",
        "http://192.168.1.5:13337",
        "http://worky.local:13337"
      ]);
  });

  it("falls back to the remembered list alone on a home-screen launch (no ?h=)", () => {
    localStorage.setItem(HOST_STORE_KEY, JSON.stringify([
      { origin: "http://192.168.1.5:13337", lastSeenMs: 5 }
    ]));
    expect(candidatesForPage("https://sts2-couch.pages.dev/")).toEqual(["http://192.168.1.5:13337"]);
  });

  it("has nothing to offer on a first visit with no QR", () => {
    expect(candidatesForPage("https://sts2-couch.pages.dev/")).toEqual([]);
  });
});

describe("webLinkBlockedByBrowser", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
  const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
  const ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36";
  const LAN = ["http://192.168.1.5:13337"];

  // Measured (docs/local-network-access.md): WebKit blocks every insecure private-IP
  // subresource of an https page, so this link can never work here however the network is set up.
  it("is true for an iPhone on the public origin", () => {
    expect(webLinkBlockedByBrowser({ pageProtocol: "https:", userAgent: IPHONE }, LAN)).toBe(true);
  });

  it("is true for an iPad, which reports a desktop UA and is only distinguishable by touch points", () => {
    expect(webLinkBlockedByBrowser({ pageProtocol: "https:", userAgent: IPAD, maxTouchPoints: 5 }, LAN))
      .toBe(true);
    expect(webLinkBlockedByBrowser({ pageProtocol: "https:", userAgent: IPAD, maxTouchPoints: 0 }, LAN))
      .toBe(false);
  });

  it("is false on Android, where the private-IP exemption is real", () => {
    expect(webLinkBlockedByBrowser({ pageProtocol: "https:", userAgent: ANDROID }, LAN)).toBe(false);
  });

  // The bootstrap also runs host-served over plain http, where there is no mixed content to block.
  it("is false when the PAGE is not https", () => {
    expect(webLinkBlockedByBrowser({ pageProtocol: "http:", userAgent: IPHONE }, LAN)).toBe(false);
  });

  // A remembered `local-ip.co` origin is https, so that candidate is reachable from an iPhone and the
  // player must not be told to go and scan something else.
  it("is false when any candidate is https, and when there are none at all", () => {
    expect(webLinkBlockedByBrowser(
      { pageProtocol: "https:", userAgent: IPHONE },
      ["http://192.168.1.5:13337", "https://192-168-1-5.local-ip.co:13338"]
    )).toBe(false);
    expect(webLinkBlockedByBrowser({ pageProtocol: "https:", userAgent: IPHONE }, [])).toBe(false);
  });

  it("is false when there is no user agent to read", () => {
    expect(webLinkBlockedByBrowser({ pageProtocol: "https:", userAgent: undefined }, LAN)).toBe(false);
  });
});

describe("rememberResolvedHost", () => {
  const origin = "http://192.168.1.5:13337";
  const fingerprint = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

  it("stores a scanned fingerprint before its parameters are stripped", () => {
    const href = `https://x.example/?h=192.168.1.5:13337&f=${fingerprint}`;
    rememberResolvedHost(origin, 1, href);
    expect(readHosts()).toEqual([{ origin, lastSeenMs: 1, fingerprint }]);
    expect(stripHostParam(href)).toBe("https://x.example/");
  });

  it("preserves remembered pins on return visits and recovery to another candidate", () => {
    rememberHost(origin, 1, undefined, fingerprint);
    rememberResolvedHost(origin, 2, "https://x.example/");
    expect(readHosts()[0]?.fingerprint).toBe(fingerprint);
    rememberResolvedHost(origin, 3, "https://x.example/?h=192.168.1.9:13337&f=" + "_".repeat(43));
    expect(readHosts()[0]?.fingerprint).toBe(fingerprint);
  });

  it("clears an old pin when a scan or manual address has no fingerprint", () => {
    rememberHost(origin, 1, undefined, fingerprint);
    rememberResolvedHost(origin, 2, "https://x.example/?h=192.168.1.5:13337");
    expect(readHosts()[0]?.fingerprint).toBeUndefined();
    rememberHost(origin, 3, undefined, fingerprint);
    rememberResolvedHost(origin, 4, null);
    expect(readHosts()[0]?.fingerprint).toBeUndefined();
  });
});

describe("stripHostParam", () => {
  // The installed PWA's start_url is a bare `/`. Keeping the running page consistent with that is what
  // stops a player who adds to home screen mid-session from pinning one particular DHCP lease.
  it("removes ?h= and leaves everything else", () => {
    expect(stripHostParam("https://x.example/?h=192.168.1.5:13337&debug=1"))
      .toBe("https://x.example/?debug=1");
  });

  it("strips f, including without h, and keeps unrelated query parameters and fragments", () => {
    expect(stripHostParam("https://x.example/?h=192.168.1.5:13337&f=pin&debug=1#part"))
      .toBe("https://x.example/?debug=1#part");
    expect(stripHostParam("https://x.example/?f=pin&debug=1"))
      .toBe("https://x.example/?debug=1");
  });

  it("answers null when there is nothing to strip, so the caller can skip the history write", () => {
    expect(stripHostParam("https://x.example/")).toBeNull();
    expect(stripHostParam("not a url")).toBeNull();
  });
});

describe("injectApp", () => {
  it("points the host base, the stylesheet and the entry module at the HOST origin", async () => {
    const doc = document.implementation.createHTMLDocument("t");
    const promise = injectApp("http://192.168.1.5:13337", MANIFEST, doc);

    const link = doc.head.querySelector("link[rel=stylesheet]") as HTMLLinkElement;
    const script = doc.head.querySelector("script") as HTMLScriptElement;
    expect(link.getAttribute("href")).toBe("http://192.168.1.5:13337/app/index-def456.css");
    expect(script.getAttribute("src")).toBe("http://192.168.1.5:13337/app/index-abc123.js");
    expect(script.type).toBe("module");
    // Must be set BEFORE the entry executes — the app reads it at module scope.
    expect((globalThis as { __couchCoopHostBase?: string }).__couchCoopHostBase)
      .toBe("http://192.168.1.5:13337");

    script.dispatchEvent(new Event("load"));
    await expect(promise).resolves.toBeUndefined();
  });

  // The boot chrome is only torn down on resolve, so a failed load has to reject — otherwise the player
  // is left staring at a blank page with no way back.
  it("rejects when the bundle fails to load", async () => {
    const doc = document.implementation.createHTMLDocument("t");
    const promise = injectApp("http://192.168.1.5:13337", MANIFEST, doc);
    (doc.head.querySelector("script") as HTMLScriptElement).dispatchEvent(new Event("error"));
    await expect(promise).rejects.toThrow(/failed to load/);
  });
});

describe("Website tunnel boot", () => {
  const origin = "http://192.168.1.5:13337";
  const fingerprint = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
  const href = `https://pages.example/?h=192.168.1.5:13337&f=${fingerprint}`;
  const prefix = "/~h/abcdefghijklmnopqrstuv/";

  function rig() {
    const order: string[] = [];
    const sw = new EventTarget() as ServiceWorkerContainer;
    Object.assign(sw, { controller: {}, ready: Promise.resolve({ active: {} }),
      register: vi.fn(async () => { order.push("worker"); return {}; }) });
    const peer = { openChannel: vi.fn(), close: vi.fn(), closed: new Promise<void>(() => {}) };
    const bridge = { prefix, tab: "abcdefghijklmnopqrstuv", ready: Promise.resolve(), stop: vi.fn() };
    const seams = {
      serviceWorker: sw, RTCPeerConnection: class {} as typeof RTCPeerConnection,
      openDirectPeer: vi.fn(async () => { order.push("peer"); return peer; }) as unknown as ReturnType<typeof vi.fn<typeof import("@godot-scene-web/direct-peer").openDirectPeer>>,
      createTunnelFetch: vi.fn(() => vi.fn(async (request: Request) => {
        order.push(new URL(request.url).pathname);
        return jsonResponse({ ...MANIFEST, tunnel: "couch-tunnel/1" });
      })),
      startServiceWorkerBridge: vi.fn(() => { order.push("bridge"); return bridge; }),
      fetch: vi.fn().mockResolvedValue(jsonResponse(MANIFEST)),
      injectApp: vi.fn(async (_base: string, _manifest: BootManifest) => { order.push("inject"); }),
      reload: vi.fn(), hardReload: false, storage: sessionStorage
    };
    return { seams, peer, bridge, order, sw };
  }

  afterEach(() => {
    delete globalThis.__couchCoopTunnel;
    sessionStorage.clear();
  });

  it("connects before probing and injects from the SW virtual base", async () => {
    const { seams, order } = rig();
    const { bootWebsite } = await import("@/boot/websiteBoot");
    expect((await bootWebsite([origin], href, seams))?.ok).toBe(true);
    expect(order).toEqual(["worker", "peer", "bridge", "/app-boot.json", "inject"]);
    expect(seams.fetch).not.toHaveBeenCalled();
    expect(seams.openDirectPeer).toHaveBeenCalledWith({ host: "192.168.1.5", port: 13337,
      fingerprint, RTCPeerConnection: seams.RTCPeerConnection });
    expect(seams.injectApp.mock.calls[0]?.[0]).toBe(`https://pages.example${prefix.slice(0, -1)}`);
    expect(globalThis.__couchCoopTunnel?.closed).toBeDefined();
  });

  it.each(["off", "no-pin", "no-rtc", "no-worker"])("uses direct HTTP for %s", async reason => {
    const { seams } = rig();
    if (reason === "no-rtc") seams.RTCPeerConnection = null as unknown as typeof RTCPeerConnection;
    if (reason === "no-worker") seams.serviceWorker = null as unknown as ServiceWorkerContainer;
    const url = reason === "off" ? href + "&tunnel=off" : reason === "no-pin" ? href.split("&f=")[0]! : href;
    const { bootWebsite } = await import("@/boot/websiteBoot");
    await bootWebsite([origin], url, seams);
    expect(seams.openDirectPeer).not.toHaveBeenCalled();
    expect(seams.fetch).toHaveBeenCalledOnce();
    expect(seams.injectApp.mock.calls[0]?.[0]).toBe(origin);
  });

  it("uses a remembered fingerprint on a return visit", async () => {
    rememberHost(origin, 1, undefined, fingerprint);
    const { seams } = rig();
    const { bootWebsite } = await import("@/boot/websiteBoot");
    await bootWebsite([origin], "https://pages.example/", seams);
    expect(seams.openDirectPeer).toHaveBeenCalledOnce();
    expect(seams.fetch).not.toHaveBeenCalled();
  });

  it("falls back when the peer times out", async () => {
    const { seams, bridge } = rig();
    seams.openDirectPeer.mockRejectedValue(new Error("timeout"));
    const { bootWebsite } = await import("@/boot/websiteBoot");
    await bootWebsite([origin], href, seams);
    expect(seams.fetch).toHaveBeenCalledOnce();
    expect(seams.injectApp.mock.calls[0]?.[0]).toBe(origin);
    expect(bridge.stop).not.toHaveBeenCalled();
  });

  it("keeps an unpinned scanned host ahead of a pinned remembered host", async () => {
    const remembered = "http://192.168.1.20:13337";
    rememberHost(remembered, 1, undefined, fingerprint);
    const { seams } = rig();
    const beforeInject = vi.fn();
    const url = href.split("&f=")[0]!;
    const { bootWebsite } = await import("@/boot/websiteBoot");
    const outcome = await bootWebsite(candidatesForPage(url), url, { ...seams, beforeInject });
    expect(outcome).toMatchObject({ ok: true, origin });
    expect(seams.fetch).toHaveBeenCalledExactlyOnceWith(`${origin}/app-boot.json`, expect.anything());
    expect(seams.injectApp).toHaveBeenCalledExactlyOnceWith(origin, MANIFEST);
    expect(beforeInject).toHaveBeenCalledExactlyOnceWith(outcome);
    expect(seams.openDirectPeer).not.toHaveBeenCalled();
  });

  it("tries a scanned host's direct fallback before a remembered host's tunnel", async () => {
    const remembered = "http://192.168.1.20:13337";
    rememberHost(remembered, 1, undefined, fingerprint);
    const { seams } = rig();
    seams.openDirectPeer.mockRejectedValueOnce(new Error("timeout"));
    const beforeInject = vi.fn();
    const { bootWebsite } = await import("@/boot/websiteBoot");
    const outcome = await bootWebsite(candidatesForPage(href), href, { ...seams, beforeInject });
    expect(outcome).toMatchObject({ ok: true, origin });
    expect(seams.fetch).toHaveBeenCalledExactlyOnceWith(`${origin}/app-boot.json`, expect.anything());
    expect(seams.injectApp).toHaveBeenCalledExactlyOnceWith(origin, MANIFEST);
    expect(beforeInject).toHaveBeenCalledExactlyOnceWith(outcome);
    expect(seams.openDirectPeer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ host: "192.168.1.5" }));
  });

  it("acquires worker control once when advancing to another candidate's tunnel", async () => {
    const remembered = "http://192.168.1.20:13337";
    rememberHost(remembered, 1, undefined, fingerprint);
    const { seams, sw, order } = rig();
    seams.openDirectPeer.mockRejectedValueOnce(new Error("timeout"));
    seams.fetch.mockRejectedValueOnce(new Error("unreachable"));
    const beforeInject = vi.fn();
    const { bootWebsite } = await import("@/boot/websiteBoot");
    const outcome = await bootWebsite(candidatesForPage(href), href, { ...seams, beforeInject });
    expect(outcome).toMatchObject({ ok: true, origin: remembered });
    expect(seams.fetch).toHaveBeenCalledExactlyOnceWith(`${origin}/app-boot.json`, expect.anything());
    expect(seams.openDirectPeer).toHaveBeenCalledTimes(2);
    expect(sw.register).toHaveBeenCalledOnce();
    expect(order.filter(event => event === "worker")).toHaveLength(1);
    expect(beforeInject).toHaveBeenCalledExactlyOnceWith(outcome);
  });

  it("stops at a candidate that refuses the page origin", async () => {
    rememberHost("http://192.168.1.20:13337", 1, undefined, fingerprint);
    const { seams } = rig();
    seams.fetch.mockResolvedValueOnce(jsonResponse({ ...MANIFEST, originAllowed: false }));
    const beforeInject = vi.fn();
    const url = href.split("&f=")[0]!;
    const { bootWebsite } = await import("@/boot/websiteBoot");
    expect(await bootWebsite(candidatesForPage(url), url, { ...seams, beforeInject })).toEqual({
      ok: false, failure: { kind: "origin-refused", origin, webOrigin: MANIFEST.webOrigin }
    });
    expect(seams.fetch).toHaveBeenCalledOnce();
    expect(seams.openDirectPeer).not.toHaveBeenCalled();
    expect(seams.injectApp).not.toHaveBeenCalled();
    expect(beforeInject).not.toHaveBeenCalled();
  });

  it("reports every unreachable candidate after their tunnel and direct attempts fail", async () => {
    rememberHost("http://192.168.1.20:13337", 1, undefined, fingerprint);
    const { seams, sw } = rig();
    seams.openDirectPeer.mockRejectedValue(new Error("timeout"));
    seams.fetch.mockRejectedValue(new Error("unreachable"));
    const candidates = candidatesForPage(href);
    const { bootWebsite } = await import("@/boot/websiteBoot");
    expect(await bootWebsite(candidates, href, seams)).toEqual({
      ok: false, failure: { kind: "unreachable", tried: candidates }
    });
    expect(seams.fetch.mock.calls.map(call => call[0])).toEqual(candidates.map(host => `${host}/app-boot.json`));
    expect(seams.openDirectPeer).toHaveBeenCalledTimes(2);
    expect(sw.register).toHaveBeenCalledOnce();
    expect(seams.injectApp).not.toHaveBeenCalled();
  });

  it("reports no candidates without probing or injecting", async () => {
    const { seams } = rig();
    const { bootWebsite } = await import("@/boot/websiteBoot");
    expect(await bootWebsite([], href, seams)).toEqual({ ok: false, failure: { kind: "no-candidates" } });
    expect(seams.fetch).not.toHaveBeenCalled();
    expect(seams.openDirectPeer).not.toHaveBeenCalled();
    expect(seams.injectApp).not.toHaveBeenCalled();
  });

  it.each(["manifest", "bridge", "bundle"])("cleans up and falls back after a %s failure", async failure => {
    const { seams, peer, bridge } = rig();
    if (failure === "manifest") seams.createTunnelFetch.mockReturnValue(vi.fn(async () => jsonResponse(MANIFEST)));
    if (failure === "bridge") bridge.ready = Promise.reject(new Error("bridge"));
    if (failure === "bundle") seams.injectApp.mockRejectedValueOnce(new Error("bundle"));
    const { bootWebsite } = await import("@/boot/websiteBoot");
    await bootWebsite([origin], href, seams);
    expect(peer.close).toHaveBeenCalledOnce();
    expect(bridge.stop).toHaveBeenCalledOnce();
    expect(seams.fetch).toHaveBeenCalledOnce();
    expect(globalThis.__couchCoopTunnel).toBeUndefined();
  });

  it("waits for clients.claim via controllerchange before opening the peer", async () => {
    const { seams, sw, order } = rig();
    Object.assign(sw, { controller: null });
    const { bootWebsite } = await import("@/boot/websiteBoot");
    const boot = bootWebsite([origin], href, seams);
    await Promise.resolve(); await Promise.resolve();
    expect(order).toEqual(["worker"]);
    Object.assign(sw, { controller: {} });
    sw.dispatchEvent(new Event("controllerchange"));
    await boot;
    expect(seams.openDirectPeer).toHaveBeenCalledOnce();
  });

  it("reloads an uncontrolled hard reload once, then falls back if still uncontrolled", async () => {
    const { seams, sw } = rig();
    Object.assign(sw, { controller: null });
    seams.hardReload = true;
    const { bootWebsite } = await import("@/boot/websiteBoot");
    expect(await bootWebsite([origin], href, seams)).toBeNull();
    expect(seams.reload).toHaveBeenCalledOnce();
    expect(seams.openDirectPeer).not.toHaveBeenCalled();
    await bootWebsite([origin], href, seams);
    expect(seams.reload).toHaveBeenCalledOnce();
    expect(seams.fetch).toHaveBeenCalledOnce();
  });
});
