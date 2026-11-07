# Local Network Access and mixed content: what browsers allow

The "Website" QR option serves a tiny bootstrap page from a public HTTPS origin (`sts2-couch.pages.dev`) and loads
the rest of the client from the mod's plain-HTTP server on the host's LAN address. Whether that works is decided
entirely by browser rules about an HTTPS page talking to `http://<private IP>:<port>`. This note records those rules
as the client relies on them. Nothing here is game-internal; it is all browser behaviour.

## Why the mode exists

The hostname HTTPS method (the `local-ip.co` secure origin, `SecureOriginProvider.cs`) needs public DNS to answer
for a **private** address. Routers with DNS-rebinding protection, and some DNS servers, refuse — the same class of
environment failure that makes the `.local` mDNS row unreliable. The Website mode takes DNS out of the path: a normal
public origin with a normal certificate, and the host addressed by its literal IPv4 address.

## The rules the client depends on

**Chromium (Chrome, Edge, desktop and Android):**

- An HTTPS page may load `http://<private IPv4 literal>` subresources — `fetch()`, module scripts and their relative
  imports, `import()`, images (a `crossorigin=anonymous` image can be drawn to a canvas without tainting it),
  stylesheets and their `url()`s. These are **not** upgraded to HTTPS because the host is an IP address; the console
  shows a mixed-content *warning*, not a block.
- All of it is gated by the **Local Network Access** permission: a public page reaching a private address prompts
  the user, and without the permission the same requests fail with "Permission was denied for this request to
  access the `local` address space" (WebSockets: `net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`). Only a window
  can prompt for it.
- **Plain `ws://` from an HTTPS page is version-dependent.** Some Chromium versions exempt a private-IP `ws://` like
  any other subresource; others throw synchronously in the `WebSocket` constructor ("An insecure WebSocket
  connection may not be initiated from a page loaded over HTTPS"), before any network request and regardless of
  the permission. Loopback (`ws://127.0.0.1`) and `wss://` always construct. On a browser that throws, the Website
  link boots the app and then cannot open the game socket.
- WebTransport and `wss://` from a public page to a private address are also in Local Network Access scope. The new
  renderer's stream additionally cannot serve the Website origin at all: its origin allow-list takes exact
  `scheme://host:port` entries, and the Website origin has no port. The host's own HTTPS link (Direct address
  (HTTPS) or the secure origin) is a private-address page, so no LNA check applies there and both carriers open.

**Service workers are the exception.** Inside a service worker the private-IP exemption does not apply: a worker's
`fetch()` of `http://<private IP>` is hard-blocked as mixed content. Two consequences shape
`frontend/pages/public/sw.js`:

1. The worker cannot populate a cache of host assets itself; only the window can fetch and `cache.put` them.
2. A worker that calls `respondWith(fetch(request))` for a host URL **breaks a request the browser would have served
   happily**. Because `caches.match` is asynchronous, "respond, then fall back on a miss" is not available either.
   So the worker decides **synchronously, from an in-memory index** of what it holds: a hit is served from the cache
   (a cache hit touches no network and is never mixed-content checked), and anything else returns without calling
   `respondWith`, which hands the request back to the browser untouched.

**WebKit (Safari, every browser on iPhone and iPad):** WebKit has **no** private-IP mixed-content exemption. An HTTPS
page's `fetch`, module script, image and `ws://` to `http://<private IP>` are all blocked outright ("This content was
blocked and must be served over HTTPS"), and there is no Local Network Access permission to grant. The Website link
therefore cannot reach a plain-HTTP LAN host from an iPhone or iPad on any network, and the bootstrap says so on iOS
(`boot.unreachableIos`) instead of reporting a generic "the game didn't answer". iPhones and iPads use the plain LAN
link, Direct address (HTTPS) or the secure origin.

## How the Website mode is built on these rules

```
  Cloudflare Pages  (public HTTPS, stable, deploy-once)
    /                     bootstrap page   — frontend/pages/index.html
    /boot.js              ~5KB             — src/boot/{main,bootstrap}.ts
    /manifest.webmanifest  start_url "/", scope "/", id "/"   <- the PWA identity lives HERE
    /icons/*, /sw.js, /_headers

         |  fetch  http://<ip>:<port>/app-boot.json     (this is what triggers the LNA prompt)
         |  <link> http://<ip>:<port>/app/index-<hash>.css
         |  <script type=module> http://<ip>:<port>/app/index-<hash>.js
         v
  The mod's browser server  (http://192.168.x.x:13337, transport unchanged)
    /app/*  the SPA bundle      /res/ /bg/ /spines/ /models/   assets
    /ws  ->  ws://192.168.x.x:13337/ws
```

**The public origin ships no application code.** It asks the host what to load and loads exactly that, so a player
several mod releases behind runs the client that shipped with their mod: there is no version skew to detect. The
boot manifest is served at `/app-boot.json` by the mod's browser server, which re-emits the frontend build's
`app-boot` artifact — a file with **no extension**, so STS2's mod-manifest scan of `mods/couchcoop/frontend/` skips
it (emitted by `vite.config.ts` `couchCoopBootManifest`, located by `StaticSpaFileProvider.BootManifestDiskName`).

What it depends on:

- **`base: "./"`** in `vite.config.ts`. The entry is injected with an absolute host URL and every chunk, stylesheet
  and asset below it resolves relative to the importing module, i.e. also on the host. An absolute `/app/…` base
  would resolve against the public origin and 404.
- **`@/join/hostBase`**, the one place that answers "where is the host". `hostWsUrl` derives the socket scheme from
  the HOST, never the page: the page is https while the host is plain http, so a page-derived `wss:` reaches nothing.
- **CORS plus an Origin check** in the mod. Every HTTP route answers `Access-Control-Allow-Origin: *`
  (`HttpResponseWriter.CorsAllowOrigin` explains why a wildcard is honest here), and `/ws` — the actual capability —
  is gated by `CouchCoopWebOrigin.IsAllowedWebSocketOrigin`. That check compares the host and ignores the **port**:
  a joined seat is redirected to its own instance on a different port while the page stays on the port it loaded
  from, so a port-sensitive comparison would refuse every seat.

The QR carries the LAN address as `?h=<ip>:<port>` and `start_url` stays a bare `/`, which is what makes an installed
icon survive a DHCP lease change: the address is data in `localStorage` (`@/join/hostStore`), not part of the app's
identity. `OfflineQrCode` strips every query key except `h`.

The bootstrap document's `<body>` must stay layout-neutral: the app mounts into `#app` in the bootstrap's document and
letterboxes a 1920x1080 stage against the viewport, so any layout on `<body>` (a centring flexbox, say) moves the
stage off screen and shows a black page with no error. All boot layout lives on `#boot`, removed once the app mounts.

## Rehearsing without deploying

```bash
cd frontend && npm run build:pages && npm run preview:pages &   # the bootstrap on 127.0.0.1:4173
cloudflared tunnel --url http://127.0.0.1:4173                  # -> https://<random>.trycloudflare.com
COUCHCOOP_WEB_ORIGIN=https://<random>.trycloudflare.com  <launch the game>
```

A quick tunnel is a genuinely public origin, which is all the permission requires, and `COUCHCOOP_WEB_ORIGIN`
repoints the QR with no rebuild.

To exercise only the mixed-content half, an https page served from this machine's LAN address (self-signed) against
a plain-http stand-in host is enough. **The host side must not be `127.0.0.1`:** loopback is potentially trustworthy,
so a loopback subresource of an https page is never mixed content in any engine and every check passes for the wrong
reason. `Content-Security-Policy: treat-as-public-address` on a document (or Chrome's
`--ip-address-space-overrides=<ip>:0=public`) makes Chrome treat it as public, which exercises the permission half
only. In automation, the CDP `Browser.grantPermissions` name is `localNetworkAccess`; setting the permission state
alone changes `navigator.permissions.query` without unblocking any request.

## Direct-IP HTTPS alternative

**Direct address (HTTPS)** serves the application and all host traffic over trusted HTTPS/WSS at the literal IPv4
address. It does not use the public Website bootstrap or rely on its mixed-content and LNA exceptions, and it avoids
the DNS-rebinding problems of hostname HTTPS. Its trade-off is manual client trust: a per-host local CA must be
transferred through an authenticated channel and explicitly trusted on each device. See
[direct-ip-https.md](direct-ip-https.md).
