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

Cache accounting includes old generated cache generations, staged files, metadata, and ASTC outputs. Shipped
assets and separately configured operator geoclips are excluded. Reservations are shared across processes;
unused capacity from small writes is reconciled periodically, so persistence can be refused conservatively near
the ceiling. Existing files are never evicted. Temporary storage pressure does not create a permanent geoclip
refusal receipt. The supported Spine retry selector is `retry=1`; material and paused-animation variants remain valid.

These controls reduce file disclosure, privileged browser commands, and unbounded memory or disk use. They do not
make the LAN service private, prevent all gameplay interference, or promise uninterrupted play during an active
network attack. Files and networks outside the configured service boundaries remain the operator's responsibility.
