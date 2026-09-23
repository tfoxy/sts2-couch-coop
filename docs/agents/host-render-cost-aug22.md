# Static background service

This is the current operational reference for the host-rendered mirror background. It replaces archived
measurements and retired URL forms.

## Contract

- Combat: `/bg/{id}?layers={digest}&v=1`; `layers` is optional and only valid for combat.
- Event: `/bg/events/{id}?v=1`.
- Room: `/bg/rooms/{id}?frame={frame}&v=2`. Rooms have their own namespace (`RoomsKeyVersion`): the first shop
  stills were rendered shifted by half the render and are still held under the immutable v=1 URL.
- The URL names a specific variant, not an image format. The response `Content-Type` names the codec; callers
  must not append an image extension or infer one.
- Current URLs are immutable. A variant which is no longer current may use matching cached bytes or return a
  miss; it must never render a different image under the old URL.
- **A qualified variant is rendered at publish time, not on first fetch.** The tracker hands every publish that
  carries a `layers` digest or a `frame` spec to the server's warm callback
  (`CouchCoopBrowserServer.WarmPublishedStaticBackground`, log tag `static-bg-warm`), which renders it on a pool
  thread through the shared `CouchCoopAssetExtractionGate`. Without this the immutable-URL rule and the "only the
  current variant may render" rule combine into a permanent 404: the host keeps no `digest → layer paths`
  history, so a fetch that arrives one publish late can never be served. The warm is gated on at least one
  viewer having `staticBg` on — a streaming host viewer, or a seat viewer's gated host socket (see Seats below)
  — and unqualified variants are skipped (the prerender sweep bakes those).

`CouchCoopStaticBackgroundProvider` owns URL construction and cache identity. `StaticBackground.vue` must use
the streamed URL rather than reconstructing it — with one exception, below.

## Cache and failure behavior

Rendered bytes are held in the managed asset cache whose schema comes from spirectl's asset-payload version.
The cache is bounded by the server's managed-cache quota; a cache failure must leave existing readable entries
available.

Every family fails **closed** — a failure never restores the live scenery or changes the host wire. They differ
only in whether a second URL exists, and combat's is the exception to the "use the streamed URL" rule above.

| Family | A still that cannot be fetched or decoded |
| --- | --- |
| Combat | **The live subtree never returns.** The hold is unconditional while the setting is on. The client ladder is: the descriptor's qualified URL → the digest-less `/bg/{id}?v=1` derived from the same scene path (always renderable, and what the prerender sweep bakes; it may show a different layer variant, which is invisible at background scale) → the still already on screen if it is this same room's → nothing, showing `.mirror-stage`'s `#181818`. |
| Event, Room | **The live subtree never returns either** (fail-open was removed Sep-21). No second URL: their stills are qualified by a live-probed frame and the frame-less reference variant is visibly mis-placed, so the ladder is the descriptor's URL → the still already on screen if it is this same room's → nothing. |

Why fail closed: performance is the entire point of the setting, and a background subtree is the most expensive
thing the phone composites (~500 elements versus one `<img>`). Folding a failure onto the wire was also
self-sustaining — the fold re-armed a deferred probe that could publish a different variant and strand the next
URL too.

## Seats: every viewer shows the host's picture

The background the host has is the background every seat shows — combat, events and rooms alike. A browser that
joined as a player streams from its own headless seat, but the seat's descriptor is **never** displayed: its
`frame=`/digest was probed from the seat's tree, and the host's route renders only the host's current publish.

- **Client.** A redirected browser keeps its gated (`watch=0`) host socket, and the host keeps re-sending its
  `session` (with `staticBackground`) there. `MirrorApp` shows the HOST's descriptor, admitted only while its
  `scenePath` equals the one the seat's own session names (`hostStaticBackground.ts`); a host a room ahead keeps
  the last admitted one, a seat a room ahead shows nothing until the host catches up. `StaticBackground`'s
  `hostAuthoritative` mode never falls back to a wire-minted URL.
- **Host.** The tracker also probes on the game's own screen-changed event, so the host publishes with no host
  viewer streaming (the scene observer is far too expensive to run for this). A seat viewer's gated host socket
  declaring `staticBg` counts toward the warm gate — never toward walk-skip unanimity.
- **`staticBg` to the host socket is sent alone.** A `settings` message applies its refresh-rate and freeze levers
  to the process that receives it, so a seat viewer's full settings payload would throttle the host's game.

`X-Cache` reports the provider result. Treat it as diagnostic evidence, not a request to bypass the variant
contract. The normal route is safe to cache indefinitely because a changed payload changes its URL identity.

## Diagnose and measure

Use a live server only after taking the appropriate live-QA lease. The browser server exposes the current
background metrics at `/perf/bg.json`. The rendering comparison endpoint is intentionally opt-in:

```bash
COUCHCOOP_BG_BENCH=1 sts2 game launch
curl 'http://127.0.0.1:13337/perf/bg-render.json?id=underdocks&sizes=2520x1080&formats=jpg@0.9&repeats=3&warmups=1'
```

The benchmark is a host diagnostic, not a browser visual gate. Retain its JSON and the exact launch/configuration
when making a cost claim. For visual parity, capture the browser stage through the mirror benchmark and record the
resulting screenshot path.
