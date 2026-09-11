# Background cache and render resilience

Read [host-render-cost-aug22.md](host-render-cost-aug22.md) first for the current route grammar and benchmark
entrypoint. This companion records the invariants that protect the browser from a slow or changing host render.

- A background URL includes the current variant discriminator (`layers` for combat, `frame` for room backdrops)
  and `v=1`. Do not use file extensions or retired version values as aliases.
- Rendering is allowed only for the variant currently published by the scene tracker. A stale variant may serve
  its exact cached bytes but cannot trigger a new render.
- The response's `Content-Type` identifies the host-selected codec. Browser clients treat it as an image response,
  not as a promise about a filename suffix.
- Cache writes use the managed cache quota. Failure to persist a generated image must not evict a readable cache
  entry or make a permanent negative decision.
- The browser background is optional presentation. Fetch, decode, or host-render failure releases the live
  background subtree; it must not hide the stage.

For a host-cost investigation, retain `/perf/bg.json` and any opt-in `/perf/bg-render.json` output. For a visual
claim, retain the mirror benchmark screenshot and identify its image path in the report.
