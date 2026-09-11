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

`CouchCoopStaticBackgroundProvider` owns URL construction and cache identity. `StaticBackground.vue` must use
the streamed URL rather than reconstructing it.

## Cache and failure behavior

Rendered bytes are held in the managed asset cache whose schema comes from spirectl's asset-payload version.
The cache is bounded by the server's managed-cache quota; a cache failure must leave existing readable entries
available. A browser that cannot fetch or decode the background fails open to the live scene rather than showing
a blank stage.

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
