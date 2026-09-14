# Static background service

This is the current operational reference for the host-rendered mirror background. It replaces archived
measurements and retired URL forms.

## Contract

- Combat: `/bg/{id}?layers={digest}&v=1`; `layers` is optional and only valid for combat.
- Event: `/bg/events/{id}?v=1`.
- Room: `/bg/rooms/{id}?frame={frame}&v=1`.
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
  streaming viewer having `staticBg` on, and unqualified variants are skipped (the prerender sweep bakes those).

`CouchCoopStaticBackgroundProvider` owns URL construction and cache identity. `StaticBackground.vue` must use
the streamed URL rather than reconstructing it — with one exception, below.

## Cache and failure behavior

Rendered bytes are held in the managed asset cache whose schema comes from spirectl's asset-payload version.
The cache is bounded by the server's managed-cache quota; a cache failure must leave existing readable entries
available.

Client failure behaviour is **split by family**, and combat is the exception to the "use the streamed URL" rule
above. Do not "fix" either half back to a single rule.

| Family | A still that cannot be fetched or decoded |
| --- | --- |
| Combat | **The live subtree never returns.** The hold is unconditional while the setting is on. The client ladder is: the descriptor's qualified URL → the digest-less `/bg/{id}?v=1` derived from the same scene path (always renderable, and what the prerender sweep bakes; it may show a different layer variant, which is invisible at background scale) → the still already on screen if it is this same room's → nothing, showing `.mirror-stage`'s `#181818`. |
| Event, Room | Unchanged fail-open. The client latches `staticBgFailedOpen`, which folds `staticBg:false` onto the wire, the host re-admits the subtree, and the live backdrop renders. Their stills are qualified by a live-probed frame and the frame-less reference variant is visibly mis-placed, so a wrong picture is worse than none. |

Why combat differs: performance is the entire point of the setting, and the combat background subtree is the
most expensive thing the phone composites (~500 elements versus one `<img>`). Folding a combat failure onto the
wire was also self-sustaining — the fold re-armed a deferred probe that could publish a different digest and
strand the next URL too.

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
