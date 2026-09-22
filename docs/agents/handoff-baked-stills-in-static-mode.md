# Handoff — serve the baked stills in STATIC mode too, not just OFF

**Ask (maintainer, 2026-09-22):** use the three committed effect stills for `static` shaders/particles as well,
so the client stops baking those effects itself.

**Status:** not started. The stills and the off-mode path shipped in
`feat(mirror): show baked stills when shaders or particles are off`; this extends their reach by one mode.

---

## 1. What "baking them client side" actually costs today

In `static` mode gsw renders one frozen frame per binding, and
`shaderResources.staticSurfacePolicy` then swaps each quiet canvas for an `<img>` — a GPU→CPU **readback** plus
a PNG encode, per surface. Nearly every tuned constant in
[shaderResources.ts](../../frontend/src/mirror/shaderResources.ts) exists to bound the damage that does, and the
measurements are in its comments:

- kicking all 72 fleet encodes at once parked the main thread for **736 ms**;
- a reshuffle trace caught single tasks of **285 ms and 1,163 ms**, 97% self-time inside native `toBlob`, for
  surfaces that cost 6-13 ms each when unloaded;
- the whole fleet is 72 canvases — 28 shader, 44 particle.

And the file names the biggest offender itself, in the `onInvalidate: "retry"` note:

> Our biggest frozen population is `card_ripple`, whose content key churns on `width`.

A committed still replaces *that* population with one decode. This is the win to go and measure.

## 2. The shape of the change

`bakedEffects.ts` currently answers only in `off`. Split it:

```ts
// identity + box + blend: mode-independent
function bakedStillEntryFor(node: MirrorNode): BakedStillEntry | null
// the paint decision: entry + this family's effective mode
export function bakedStillFor(node: MirrorNode): BakedStill | null
// the suppression decision, for the two binding gates below
export function bakedStillCoversNode(node: MirrorNode): boolean
```

`bakedStillFor` widens from `mode === "off"` to `mode === "off" || mode === "static"`. **`dynamic`,
`dynamic-half` and `dynamic-quarter` must keep the live path** — those modes exist to animate, and a still is
not a cheaper animation.

Then stop the live binding being built for a covered node, or you get the still *and* the canvas:

- **Ripple** — a new early return in `computeShaderAttributes`
  ([shaderAttributes.ts](../../frontend/src/mirror/shaderAttributes.ts), after the HSV branch and the
  `isWebglShaderNode` gate): return `null` when `bakedStillCoversNode(node)`. With no binding, `subLayers`
  builds no shader self-layer and gsw never selects the node.
- **Glows** — the same early return at the top of `nodeParticleAttributes`
  ([particleAttributes.ts:261](../../frontend/src/mirror/particleAttributes.ts#L261)), beside the existing
  hard-off gate and **before** the `specsJsonCache` lookup.

### Do NOT change `isWebglShaderNode`

It is tempting, and it is a trap. That predicate is what suppresses the node's raw `card_frame_sdf.exr` paint,
in **two** places — `nodeStyles.paintsTexture` and `canvas/paintSpec.ts:1449` — and its other suppression term
(`shadersOff && isShaderInputNode`) reads the **tier** flag, which is `true` in `static`. Make
`isWebglShaderNode` return false for a covered node and both stages start painting the bare SDF as a grey
rectangle under the still. Leave it alone: it keeps meaning "structurally a WebGL node", `paintsTexture` keeps
returning false, and the new gate only stops the binding.

### The cache trap

`shaderContentKey` ([shaderAttributes.ts](../../frontend/src/mirror/shaderAttributes.ts)) keys the L2 memo on,
among other things, `renderQuality().shadersEnabled` — the **tier** flag, which does not move when the panel
does. The moment `computeShaderAttributes` consults the effect mode, **the mode must join that key**, or a
viewer flipping Static → Dynamic gets a cached `null` and their shaders never come back. The same question does
not arise for particles only because the new gate sits ahead of `specsJsonCache`; keep it there.

`MirrorView`'s effect-mode watches already `scheduleRender(true, "effects")`, so the walk itself re-runs.

### What stays exactly as it is

The static-surface machinery must keep working for everything the stills do **not** cover — the screen-transition
overlay, the low-HP vignette, every other emitter. This round narrows its population; it does not retire it.
Leave `staticSurfacePolicy`, the pixel-ratio pins and the `canFreezeSurface` veto untouched, and **update the
`onInvalidate: "retry"` comment**, whose stated reason (`card_ripple` is the biggest churning population) this
round makes false. A comment that silently stops being true is worse than no comment.

## 3. What the viewer sees change

Almost nothing, and the two differences are worth stating before someone reports them as bugs:

- **The ripple's phase.** `card_ripple` reads `TIME`, so a frozen frame catches an arbitrary phase today and the
  still is a different arbitrary phase. Colour is unaffected (the still is neutral; the mirror's own
  `#mtint-` multiply colours it), and the `width`-driven opacity fade is unaffected.
- **Which particles.** A glow emitter is stochastic; static mode freezes one arbitrary draw and the still is a
  different arbitrary draw.

Both are equivalent-in-kind substitutions. Anything *else* that moves — colour, size, placement, brightness — is
a real defect, and the likeliest cause is a double-applied modulate or a missing `plus-lighter`. See
[../../frontend/src/assets/effects/README.md](../../frontend/src/assets/effects/README.md) for why those two
are the sharp edges.

## 4. Verification — this one is a measurement, not just a gate

Suites: `cd frontend && npx vue-tsc --noEmit && npx vitest run` (**never `npm run build`, it deploys**). Extend
`__tests__/bakedEffects.spec.ts` (static now yields a still; the three dynamic modes still do not) and
`__tests__/bakedEffectMount.spec.ts` (in static, the glow mounts a still and stamps **no**
`data-godot-particle-specs`; in dynamic, the reverse).

Then the number the round exists for. `mirrorWalkStats` already carries the counters
([renderer/walkStats.ts:78-109](../../frontend/src/mirror/renderer/walkStats.ts#L78)):
`staticStillCanvases`, `staticStillBakes`, `staticStillCacheHits/Misses`, `staticStillRetainedBytes`. On a
combat screen in `static`, before vs after, expect the ripple population to fall out of `staticStillCanvases`
and `staticStillBakes` entirely.

**A trap that cost time on the stills round:** the recordings under `.sts2/bench/*.ndjson` no longer replay.
They predate the `repro/1` first-line header, and adding one is not enough — they also fail
`bench-mirror-replay.mjs`'s ">50 `.mirror-node`" ready gate (120 s timeout, no useful error). Record a fresh one
with `scripts/record-mirror-stream.mjs` against a live instance before planning to bench.

Visual gate — the round is not done on DOM evidence (`.agents/memory/visual-fidelity-compare-loop.md`): the same
screen in `?shaders=static&particles=static` before and after, plus the game itself. **List the image paths in
the summary** ([../../CLAUDE.md](../../CLAUDE.md) "Reporting Visual Evidence").

## 5. Scope

DOM stage only, like the off-mode path. `?stage=canvas` still does not consult the stills, and
`bakedEffects.spec.ts` has a test that records that on purpose — if this round changes it, change the test's
comment too rather than deleting it.

## 6. Commit

One squash commit on `main`, with a `Changelog:` trailer only if a player would notice. They mostly will not —
`Changelog: none` is defensible here, or a line about lower-end devices settling faster.
