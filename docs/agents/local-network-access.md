# Local Network Access: measured browser behaviour

What a **public HTTPS page** is actually allowed to do to `http://<lan-ip>:<port>`, measured rather than
inferred. This is the foundation of the "web link" QR option (a public origin serving the SPA, talking to
the mod's plain-HTTP LAN server by raw IPv4), so every claim below has a probe behind it.

Nothing here is game-internal — it is all browser behaviour — so it lives in `docs/`, not
`.sts2/research/`.

## Why this mode exists

The `local-ip.co` secure origin (`SecureOriginProvider.cs`) needs public DNS to answer for a **private**
address. Routers with DNS-rebinding protection and some DNS servers refuse, which is the same class of
environment failure that makes the `.local` mDNS row unreliable. Local Network Access removes DNS from the
path entirely: normal public origin, normal cert, and the host addressed by literal IPv4.

## Measured, 2026-08-22

Rig: probe page on a `cloudflared` quick tunnel (`https://*.trycloudflare.com`, a genuinely public origin)
→ a stand-in host server on `192.168.0.89:13337`. Chromium **150.0.7871.128**, headless, with the LNA
permission pre-granted over CDP.

| Case | Result |
|---|---|
| `fetch()` JSON | **pass** |
| `new WebSocket("ws://192.168.0.89:13337/ws")` | **pass** |
| `<script type="module" src="http://…">` **+ its own relative import** | **pass** |
| `import("http://…/chunk.js")` | **pass** |
| `<img src="http://…">`, no CORS headers on the response | **pass** |
| cross-origin HTTP stylesheet, and `url()` inside it | **pass** |
| `<img crossorigin=anonymous>` → `drawImage` → `getImageData` → `toBlob` | **pass**, canvas NOT tainted |
| `fetch("http://<machine>.local:13337/…")` | **pass** |
| **`fetch()` of the host from inside a service worker** | **FAIL — hard block** |
| window → `cache.put()` of a host response | **pass** |
| service worker serving a **cache hit** for a host URL | **pass** |

### Mixed content is not the blocker in a window

Every mixed-content message in the window context is a **warning**, not a block, and one states the rule
outright:

> was loaded over HTTPS, but requested an insecure element 'http://192.168.0.89:13337/res/pixel.png'.
> **This request was not upgraded to HTTPS because its URL's host is an IP address.**

The private-IP-literal exemption is real and covers subresources — scripts, stylesheets, images — not just
`fetch()`. With the permission **missing**, the identical requests fail with:

```
Access to script at 'http://192.168.0.89:13337/app/index-probe.js' from origin 'https://…'
has been blocked by CORS policy: Permission was denied for this request to access the `local` address space.
```

and WebSockets fail with `net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS` — i.e. WebSockets **are** in
LNA scope in Chromium 150 and do get the mixed-content exemption. Grant the permission and every one of
them passes.

**The `ws://` row is version-dependent, and that is an open risk.** Re-measured 2026-09-17 on **Chromium
147.0.7727.15** (what Playwright 1.59 ships, i.e. roughly today's stable line rather than the 150 above,
which was a pre-release channel): `new WebSocket("ws://192.168.0.89:13337/ws")` from an https page
**throws synchronously** —

> Failed to construct 'WebSocket': An insecure WebSocket connection may not be initiated from a page loaded
> over HTTPS.

— and it is not the permission: the throw happens in Blink before any network request, it still throws
with `Browser.grantPermissions(origin, ["localNetworkAccess"])` in force, and the discriminating control
says plainly what rule is being applied:

| from the same https page, Chromium 147 | `new WebSocket(...)` |
|---|---|
| `ws://127.0.0.1:13337/ws` (loopback — potentially trustworthy) | **constructed** |
| `ws://192.168.0.89:13337/ws` (private IP literal) | **THREW** |
| `ws://example.com/ws` (public name) | **THREW** |
| `wss://192.168.0.89:13337/ws` | **constructed** |

So in 147 the private-IP-literal exemption covers subresources but **not** WebSockets; in 150 it covered
both. Everything else in the table above still passes on 147 — `fetch` of `/app-boot.json` succeeded there
with the permission state still reading `prompt`. The consequence for the product is specific: on a phone
whose Chrome predates the `ws:` exemption, the web link boots the app successfully and then cannot open
the game socket at all, which is a *different* failure from anything the bootstrap can report. Untested on
real Android Chrome, which is what would settle it.

### The service-worker exception, and the shape that works around it

Inside a service worker the exemption does **not** apply. The block is hard, and the wording differs from
the window's warning:

> The page at '…/sw.js' was loaded over HTTPS, but requested an insecure resource
> 'http://192.168.0.89:13337/…'. **This request has been blocked; the content must be served over HTTPS.**

Two consequences, the second of which is the trap:

1. A worker cannot populate the asset cache itself. The **window** must fetch and `cache.put`.
2. A worker that calls `respondWith(fetch(request))` for a host URL **breaks a request the browser would
   have made happily** — and because `caches.match` is async, "respondWith, then fall back to fetch on a
   miss" is not available: by the time you know it is a miss, you already own the response.

So the fetch handler must decide **synchronously**, from an in-memory index of what it holds:

```js
const cached = new Set();            // rebuilt from cache.keys() on activate, updated by postMessage

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (!cached.has(event.request.url)) return;          // MISS -> no respondWith, browser handles it
  event.respondWith(caches.open(CACHE).then((c) => c.match(event.request)));   // HIT -> no network
});
```

A cache hit touches no network, so it is never mixed-content checked — which is why durable asset caching
survives even though the worker may not fetch the host itself. `frontend/public/sw.js` already models the
"bypass = return without respondWith" half; what it gains for this mode is the synchronous index.

## Measured, 2026-09-17: WebKit refuses the whole mode

Rig: the same shape, minus cloudflared — a probe page served over **https from this machine's own LAN
address** with a self-signed cert (`ignoreHTTPSErrors`), against a stand-in host on
`http://192.168.0.89:13337`. Cert trust is irrelevant to a mixed-content check, which keys off the page's
scheme. **WebKit 26.4** (Playwright's engine build, `Version/26.4 Safari/605.1.15`), Chromium 147 as the
control.

| from an https page, by literal private IPv4 | WebKit 26.4 | Chromium 147 |
|---|---|---|
| `fetch("http://…/app-boot.json")` | **blocked** | pass |
| `<script type=module src="http://…">` | **blocked** | pass |
| `<img src="http://…">` | **blocked** | pass |
| `new WebSocket("ws://…")` | **blocked** | throws (see above) |
| `navigator.permissions.query({name:"local-network-access"})` | throws — no such permission | `prompt` |

Every WebKit leg fails the same way, and the message is a **block**, not the window warning Chromium
prints:

> [blocked] The page at https://192.168.0.89:14443/ requested insecure content from
> http://192.168.0.89:13337/app-boot.json. This content was blocked and must be served over HTTPS.

with the fetch additionally surfacing `Not allowed to request resource … due to access control checks`.

So the reason iOS is out is **stronger and simpler than "WebKit has not implemented LNA"**: WebKit has no
private-IP mixed-content exemption at all, so there is no permission to grant and nothing to gate. The web
link can never reach a plain-HTTP LAN host from an iPhone or iPad, on any network, however the firewall is
configured — which is why `frontend/src/boot/main.ts` says so on iOS instead of reporting the generic
"the game didn't answer" (`boot.unreachableIos`).

This is WebKit the engine, not iOS Safari the product. It is the right engine for the question — the
mixed-content checker is core WebCore, not an iOS shim — but a physical-device report remains the only
thing that covers real Safari; see [steam-free-macos-iphone.md](steam-free-macos-iphone.md) for what each
iPhone leg does and does not prove.

## How the mode is built on top of this

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

**The public origin ships no application code.** It asks the host what to load and loads exactly that, so
a player three mod releases behind runs the client that shipped with their mod. There is no version skew
to detect and no "please update" screen to write. The manifest is served at the URL `/app-boot.json` by
the mod's browser server, which re-emits the frontend build's artifact — a file named `app-boot` with
**no extension** (so STS2's mod-manifest scan of `mods/couchcoop/frontend/` skips it), emitted by
`vite.config.ts` `couchCoopBootManifest` and located by `StaticSpaFileProvider.BootManifestDiskName`.

Three things this depends on, each with a home:

- **`base: "./"`** in `vite.config.ts`. The entry is injected with an absolute host URL and every chunk,
  stylesheet and asset below it resolves relative to the importing module — i.e. also on the host. An
  absolute `/app/…` base would resolve against the PUBLIC origin and 404.
- **`@/join/hostBase`** — one place that answers "where is the host". Its `hostUrl` is a deliberate no-op
  in host-served mode, because those strings are cache keys in the mirror's hot paths, not just fetch
  targets. `hostWsUrl` derives the socket scheme from the HOST, never the page: the page is https while
  the host is plain http, so a page-derived `wss:` reaches nothing.
- **CORS + an Origin check** in the mod. Every HTTP route answers `Access-Control-Allow-Origin: *`
  (`HttpResponseWriter.CorsAllowOrigin` — see the remarks there for why a wildcard is honest here), and
  `/ws` — the actual capability — is gated by `CouchCoopWebOrigin.IsAllowedWebSocketOrigin`.

The QR carries the LAN address as `?h=<ip>:<port>` and `start_url` stays a bare `/`, which is what makes
an installed icon survive a DHCP lease: the address is data in `localStorage` (`@/join/hostStore`), not
part of the app's identity. `OfflineQrCode` strips every query key except `h` — a stray `?name=` must
never be broadcast to a room, but stripping `h` would produce a code that scans, opens the right site, and
cannot find the game.

### Two traps this cost real time to find

**The bootstrap document's `<body>` must stay layout-neutral.** The app mounts into `#app` in the
BOOTSTRAP's document and brings its own stylesheet, which letterboxes and scales a 1920x1080 stage against
the viewport. The bootstrap centred its own status text with `display:flex` on `<body>` — which then
flex-centred the app's stage, parking a 1920-wide element at `x=-570` in a 780-wide viewport. The symptom
is a **pure black screen with every asset loaded, every canvas sized, fonts ready and no error anywhere**;
the only way to see it is to read the stage's bounding rect. All boot layout now lives on `#boot`
(`position: fixed`, removed once the app mounts).

**The WebSocket origin check must ignore the PORT.** A joined seat is redirected to its own headless
instance on a different port while the page stays on the port it loaded from, so the browser sends
`Origin: http://worky.local:13337` to an instance whose `Host` is `worky.local:13357`. A port-sensitive
comparison refuses every headless seat on every topology — including the plain LAN one that has always
worked. Host-only comparison is also the honest boundary: every port in that range belongs to this mod,
and what the check defends against is an unrelated public site, which the host comparison already refuses.

## Rehearsing the whole thing without deploying

```bash
cd frontend && npm run build:pages && npm run preview:pages &   # the bootstrap on 127.0.0.1:4173
cloudflared tunnel --url http://127.0.0.1:4173                  # -> https://<random>.trycloudflare.com
COUCHCOOP_WEB_ORIGIN=https://<random>.trycloudflare.com  <launch the game>
```

A quick tunnel is a genuinely public origin, which is all the permission requires — and
`COUCHCOOP_WEB_ORIGIN` repoints the QR with no rebuild, which is exactly what that variable is for.

## Reproducing

```bash
# 1. a public HTTPS origin, no account and no deployment
cloudflared tunnel --url http://127.0.0.1:4173        # -> https://<random>.trycloudflare.com

# 2. drive it (raw CDP: Playwright still rejects the permission name, microsoft/playwright#37861)
#    Browser.grantPermissions with "localNetworkAccess" is what reaches the network service.
#    Browser.setPermission({name:"local-network-access"}) only moves navigator.permissions.query,
#    which reads "granted" while every request still fails — a genuinely misleading pair.
```

Without a tunnel, `Content-Security-Policy: treat-as-public-address` on the document makes Chrome classify
it as public, and `--ip-address-space-overrides=<ip>:0=public` does the same per-address on desktop. Note
the limit: a `http://127.0.0.1` document is not HTTPS, so that rig exercises the **permission** half only
and says nothing about mixed content. For the mixed-content half the page must genuinely be HTTPS.

### The cheaper rig, for the mixed-content half only

No tunnel and no account: two Node servers on **this machine's LAN address** — an https one (self-signed,
driven with `ignoreHTTPSErrors`) serving the probe page, and a plain-http one standing in for the mod —
then `playwright`'s `webkit` and `chromium` against it. That is the whole of the 2026-09-17 measurement
above, and it is enough for any question about *blocking*; it says nothing about the permission, which
needs a genuinely public origin.

**The one trap that fakes a pass: the host leg must not be `127.0.0.1`.** Loopback is
potentially-trustworthy, so an `http://127.0.0.1` subresource of an https page is not mixed content in any
engine and every probe passes for the wrong reason. Use the LAN address on both ends.

## Platform support

Chrome/Edge desktop and Android, with the `ws://` caveat measured above on Chromium 147. **Not iOS
Safari** — and as of 2026-09-17 that is measured rather than inferred: WebKit blocks *every* insecure
private-IP subresource of an https page outright, so there is no LNA permission to implement and nothing
a player can allow. iPhones and iPads keep the `local-ip.co` and plain-LAN paths; all QR options stay, and
the bootstrap tells an iOS visitor which ones they are.
