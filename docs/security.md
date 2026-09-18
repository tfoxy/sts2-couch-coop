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
player comes from the served game process or the server-owned connection identity. Raw pointer and keyboard input
and ordinary client settings remain available.

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
