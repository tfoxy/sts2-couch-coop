# Security model

CouchCoop intentionally hosts a join page on the local network. Anyone who can reach that address can open the
client without a password, private link, or confirmation prompt. This keeps the existing couch co-op join flow,
but it also means an untrusted device on the same reachable network can join, send ordinary controls, and disrupt
play. Hosts should use a network whose participants they trust.

The browser boundary treats request paths, messages, semantic actions, and generated artifacts as untrusted. It
validates decoded resource paths before cache lookup or extraction, resolves filesystem links before serving a
file, and confines static and geoclip reads to their configured roots. `/res/{path}` accepts only an unprefixed,
validated `res://` path and only `raw` (default) or `?format=png`; unsupported formats and resource aliases are
rejected. Browser semantic actions are limited to the two actions used by the shipped client, and their acting
player comes from the served game process or the server-owned connection identity.

Browser access to the host's screen follows the host's persisted couch play mode. The default, **Off**, permits
only multiplayer lobbies and runs, with the native pause menu, Settings, and their submenus closed.
**SoloScreens** also permits single player lobbies and runs, including pause, Settings, and their submenus in
single player; multiplayer retains its menu restriction and the main menu remains blocked. **EveryScreen** permits
every host screen, including the main menu and multiplayer pause and Settings screens. Run summaries remain
accessible wherever their run is permitted. The mode is a local host preference, never sent to browsers or
settable by a browser message. CouchCoop's own host controls (the QR button, the pause-menu QR row, their dialog
and its mode select) are never streamed, and browser pointer, key and pad input is refused while one of its
dialogs is open, on those controls, and for the QR hotkey, so a blind tap cannot change the mode. Every mode suspends access during loading transitions and denies unreadable game
state. The server stops host scene transmission and rejects browser input, browser actions, and settings that
change the host process while blocked.
Queued work is invalidated on revocation, held injected controls are cancelled, and an allowed screen resumes with
a fresh snapshot. Browser watch flags and claimed player identities cannot override this policy.

Maps, decks, ordinary gameplay dialogs, and roster updates preserve permitted access. During known run loading, the
browser retains its last permitted view while input and scene transmission are suspended. Control returns only
after a fresh authorized snapshot is presented. Destinations outside the selected mode and unreadable state
clear the view and show an unavailable message; a separate monotonic scene-reset generation preserves that clear
across rapid updates.
A host playing through a browser must close a blocked native menu on the game machine. Separate player instances retain their own controls; shared assets,
seat audio, joining, and session coordination remain available. A frame whose transmission began before revocation
may finish arriving, and previously received frames cannot be erased from a client. This restriction does not add
passwords, kick controls, or protection against interference on permitted screens.

Access monitoring runs only while a browser requests the host view, including a temporarily blocked viewer.
Join-only and separate-player coordination connections do not keep it active. Without host watchers there are
no access-policy evaluations, subscriptions, or scheduled updates; small event-hook checks and bounded loading
bookkeeping remain. Watch requests never grant permission. Each connection also has a watch epoch so queued
input or scene work cannot survive its watch-off/on cycle while another viewer remains connected.

The join page itself is served with `Cache-Control: no-store` and carries a per-response **visit id** — 16 random
bytes, embedded in the document as `<meta name="couchcoop-visit">`. It is a diagnostic correlation id, not a
credential: it selects nothing, authorises nothing, is accepted back only in the exact minted shape, and is
deliberately not a cookie, because cookies are not port-scoped and one set by the host's port would be sent to
every other service on that machine. The `no-store` is what stops a cache handing several devices one id; the
long-lived caching of hashed application assets is unchanged.

The host keeps a bounded **arrival log** of HTTP requests that reached it — the join page, `/ws`, and refusals —
holding the time, remote address, requested path, outcome, visit id, and a coarse device label parsed from the
User-Agent. It exists because connection records previously began only at the WebSocket upgrade, so a device that
reached the host and failed earlier left no trace at all. It never records a player name: query strings are
discarded, which is where a name would ride. At most 128 entries are retained, repeats of the newest entry are
folded into it rather than added, user-agent parsing is memoised and budgeted per minute, log output is a token
bucket, and no per-address state is kept — so recording an arrival cannot be used to grow this process's memory
or CPU. Entries older than 30 minutes stop being matched and are dropped. The log is copied into a connection
report and written to the host's own log; it is not exposed on any route. It can only describe devices that
reached the host: one that never arrives produces no request and no entry.

On Windows only, and only after the host has already concluded that nothing has reached it in 90 seconds, the
mod runs **one `powershell.exe` query** to read this computer's own inbound firewall rules and the profile of
its active networks, so the resulting diagnostic can name a cause instead of listing two it cannot separate.
The script is a compile-time constant with nothing interpolated into it: the single runtime value it needs —
this process's own executable path — is passed in an environment variable, which PowerShell reads as data
rather than parsing as syntax, so no request, player name, or peer-controlled string can reach a command line.
It is read-only (`Get-NetFirewallRule`, `Get-NetFirewallApplicationFilter`, `Get-NetConnectionProfile`),
changes nothing, runs at most once per session, is capped at 12 seconds and killed if it overruns, and is
switched off entirely by `COUCHCOOP_FIREWALL_PROBE=off`. Its output is a sentence in the host's own connection
report; nothing acts on it. A host that never fails a connection never runs it.

Network work is bounded with message, header, handshake, connection, queue, and ping limits. Slow network writes
receive deadlines without disconnecting an otherwise idle player. Managed generated assets use coordinated
reservations, per-entry and total-cache limits, and a free-space reserve. Existing cache hits remain readable;
when a new generated artifact cannot be persisted, supported routes use their raster or in-memory fallback where
available.

Current limits:

| Boundary | Limit |
| --- | --- |
| Browser semantic actions | `SelectMapNode`, `SetScrollOffset` only |
| Refresh rate | 4–60 FPS |
| Inbound WebSocket message | 256 KiB; text only |
| Individual input envelope / pending queue | 4 KiB / 256 ordered events per connection |
| HTTP headers / TLS handshake | 32 KiB within 10 seconds / 15 seconds |
| Active HTTP handling | 128 total, 64 per address |
| Active WebSockets | At least 32; four per supported player when larger |
| Deferred main-thread ping callbacks | One per connection; 128 per process |
| Stalled network write | 30 seconds per transmission chunk |
| Managed cache / free-space reserve | 4 GiB / 2 GiB |
| Generated entry | 128 MiB |
| Retained HTTP arrivals | 128 entries, 30 minutes, 128-character paths |
| Host audio WebSocket inbound | Text only, 1 KiB/message; 64 messages/second with a burst of 128 |
| Seat audio WebSocket inbound | Text only, 1 KiB/message; hello and acknowledgement only |
| Audio outbound queue | 2 seconds/client; lane blocks are dropped before current sounds |
| SFX take | One-shot SFX bus only; at most 10 seconds, with a fade at the cap |
| SFX take memory cache | 64 MiB LRU; disk writes share the managed cache quota and free-space reserve |
| TmpSfx MP3 | Flat `res://debug_audio/*.mp3` only; 2 MiB/file, 8 MiB and 16 entries in memory |

Audio is opt-in for each browser viewer. The host serves only rendered PCM SFX takes and the small validated
TmpSfx MP3 resources. It never serves `.bank` data. Music and ambience are live streams and are never stored.
The private FMOD renderer uses `NOSOUND_NRT` and opens no output device. Rendering and its media clock stop
when the last relevant audio subscriber leaves.

The synthetic iPhone harness has a separate browser-lifecycle recorder for CI. It is absent during ordinary
hosting: the route and page configuration are created only when the harness receives an explicit, validated
diagnostics directory. A visit receives a fresh 128-bit nonce and a relative same-origin POST endpoint; the page
never learns the directory. The recorder accepts at most 16 KiB per request, 32 events per batch, 16 batches per
visit, four batches per second with a burst of eight, 256 live visits with a 30-minute expiry, and 1 MiB in the
single process JSONL file. Its schema permits only relative timing, lifecycle/visibility, viewport/orientation,
fullscreen, socket-role lifecycle, sanitized error categories, and ordinal scene/render/ack checkpoints. Unknown
fields and values are rejected. URLs, query values, names, scene payloads, error text/stacks, user agents, tokens,
and arbitrary messages have no accepted field and are never persisted.

Cache accounting includes old generated cache generations, staged files, metadata, and ASTC outputs. Shipped
assets and separately configured operator geoclips are excluded. Reservations are shared across processes;
unused capacity from small writes is reconciled periodically, so persistence can be refused conservatively near
the ceiling. Existing files are never evicted. Temporary storage pressure does not create a permanent geoclip
refusal receipt. The supported Spine retry selector is `retry=1`; material and paused-animation variants remain valid.

These controls reduce file disclosure, privileged browser commands, and unbounded memory or disk use. They do not
make the LAN service private, prevent all gameplay interference, or promise uninterrupted play during an active
network attack. Files and networks outside the configured service boundaries remain the operator's responsibility.

## New renderer over the LAN

Normal new-renderer traffic enters through CouchCoop's existing browser endpoint. The host resolves an opaque
seat route to a live player instance and forwards the permitted stream and resource requests over its authenticated
private seat connection. The capture listener binds to loopback by default; a browser does not need direct access
to a separate capture port. Direct capture exposure is reserved for explicit QA configuration.

- **Authorization.** CouchCoop validates the browser origin before forwarding. Route resolution uses server-owned
  seat state and rejects expired or unavailable seats; the routes cannot select arbitrary upstream addresses or
  paths. The capture still validates its per-arm token, delivered only over the authorized control connection to
  pages requesting the new renderer. Tokens are not placed in URLs or logs.
- **Resources.** Resource routes preserve bearer authentication, conditional requests, compression and private
  caching. The relay translates the capture's internal-origin CORS response into a grant for the original validated
  browser origin. Failed requests are not turned into reusable cached resources.
- **Input.** Rendering traffic and resources use the relay; gameplay input continues over the player's CouchCoop
  control socket. Input is tied to the presentation actually displayed and rejected when its presentation epoch
  is stale. A renderer transition cancels held input before changing the coordinate space.
- **Confidentiality.** The external transport matches the selected host endpoint: HTTPS uses secure WebSocket and
  HTTPS resource requests; HTTP uses unencrypted WebSocket and HTTP. The relay does not add encryption to an HTTP
  connection or bypass browser mixed-content and Local Network Access restrictions.
- **Failure isolation.** A refused or timed-out rendering request is handled as a request failure rather than proof
  that the player's game instance has failed. The browser can return to a restored old-renderer presentation.

The public Website bootstrap uses the selected host endpoint under the same browser restrictions as its control
connection; see [local-network-access.md](local-network-access.md).

## Direct-IP HTTPS trust

The optional **Direct address (HTTPS)** method uses a persistent local CA per host installation. It is
explicitly configured through the native host UI; a remembered preference does not create an authority.
Clients install and trust the public root through verified local transfer. There is no HTTP root-download
bootstrap and no browser certificate-error bypass. Root trust authorizes this host beyond the game URL;
the setup UI states that scope and provides removal and replacement instructions.

CA signing keys remain in protected per-user storage and never enter browser routes, frontend roots,
seat processes, exports or diagnostics. Only public DER certificates are exported; seats may receive
protected leaf credentials. IP SANs, independent hostname/IP readiness, and certificate selection preserve
identity validation. Address changes and leaf renewal retain the root; root expiry or invalidity requires
explicit replacement and trust installation on every client. See [setup and lifecycle](direct-ip-https.md).
