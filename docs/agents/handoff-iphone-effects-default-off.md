# Handoff — default shaders and particles to OFF on iPhone

**Ask (maintainer, 2026-09-22):** iPhones should start with Shaders and Particles **off**, because the way the
mirror does `static` shaders/particles crashes WebKit there.

**Status:** not started. This document is the whole brief; nothing has been written.

---

## 1. Why this is a seed and not a new product default

`mirrorSettings.ts` states, deliberately and at length, that the effect-mode product defaults are
**device-independent** — "a setting must mean the same thing on a phone and on a desktop". Do not change
`DEFAULT_SHADER_MODE` / `DEFAULT_PARTICLE_MODE`; that would make `static` mean one thing on an iPhone and
another everywhere else, which is the exact trap that comment exists to prevent.

The layering already has the right slot for this
([mirrorSettings.ts](../../frontend/src/mirror/mirrorSettings.ts), the header's "LAYERING" block):

```
1. built-in defaults        (device-INDEPENDENT — leave alone)
2. device tier seed         <- THIS ROUND. Today it holds only the hard-off floor.
3. localStorage             (the viewer's own panel choice — must still win)
4. URL query                (?shaders= / ?particles= — must still win)
```

So an iPhone viewer gets `off` on a first visit, can turn effects back on in the panel, and that choice
survives every later load. That is what "by default" has to mean here; a *floor* (the `minimum`-tier lane,
which the panel cannot lift) would take the choice away permanently and is the wrong tool unless the crash is
shown to be unconditional.

## 2. Where to change it

**`frontend/src/render/quality.ts`**

- Add an `ios?: boolean` signal beside `mobile` in `RenderQualitySignals`
  ([quality.ts:150](../../frontend/src/render/quality.ts#L150)) and populate it in `readSignals()`
  ([quality.ts:~560](../../frontend/src/render/quality.ts#L560)).
- **Reuse `isIosPlatform`** from [pwa/installPrompt.ts:73](../../frontend/src/pwa/installPrompt.ts#L73). It is
  already pure, already tested, and already handles the case a fresh regex will get wrong: **iPadOS 13+ reports
  a desktop `Macintosh` UA** and is only distinguishable by `navigator.maxTouchPoints > 1`. Note also that
  `navigator.userAgentData` is Chromium-only, so the UA-CH branch `readSignals` prefers for `mobile` is always
  `undefined` on Safari — the regex path is the one that runs on the devices this round is about.
  - `quality.ts` documents itself as importing almost nothing (it is resolved before everything else, and
    `settingsStorage` is a leaf specifically to avoid a cycle). `installPrompt.ts` imports only `vue` and
    registers its listeners *inside* `createInstallPromptController`, so importing one function from it is
    safe. If that still feels like too much surface for this file, extract `isIosPlatform` to a new leaf
    (`@/platform.ts`) and re-export it from `installPrompt.ts` — do **not** copy the predicate, or the
    iPad-masquerade rule will drift between two copies.
- Export a new predicate next to the hard-off pair
  ([quality.ts:269](../../frontend/src/render/quality.ts#L269)), e.g.
  `export function effectsSeedOff(quality: RenderQuality): boolean`. It must be a **seed**, so keep it
  separate from `shadersHardOff`/`particlesHardOff` rather than widening those — those two are read in a
  dozen places that mean "this can never run", and this is not that.
- Carry the answer on `RenderQuality` so it is memoized with the rest of the resolution.

**`frontend/src/mirror/mirrorSettings.ts`** — `createMirrorSettings`, exactly at
[lines 643-648](../../frontend/src/mirror/mirrorSettings.ts#L643):

```ts
shaderMode: shadersHardOff(quality)
  ? "off"
  : (effectModeOverride(search, "shaders") ?? saved.shaderMode ?? seededShaderMode(quality)),
```

…where `seededShaderMode` is `DEFAULT_SHADER_MODE` unless `effectsSeedOff(quality)`. Note the position: the
seed goes where the *constant* was, **below** `saved` and `effectModeOverride`, so layers 3 and 4 keep winning.

Then amend the "THE PRODUCT DEFAULTS" comment block
([mirrorSettings.ts:90](../../frontend/src/mirror/mirrorSettings.ts#L90)) and the layering header's line 2.
Both currently say the tier seeds nothing but the hard-off floor. Leaving them stale is how the next reader
concludes this seed is a bug.

## 3. Read this before you write the predicate: what the evidence does and does not say

`.agents/memory/webkit-scaled-ancestor-layer-blowup.md` ends with, verbatim:

> **How to apply:** Treat particles as the next allocator-instrumentation lead. Do not infer an iPhone fix,
> automatically test shaders, or patch renderer behavior from this result.

That memory measured, on a physical iPhone, that **18 particle canvases were 87% of a 439 MB LayerTree peak**,
and a local WebKit A-B-B-A flipping only `particles=static` → `particles=off` cut process-tree PSS peak from
~2396/2312 MB to ~1197/1184 MB — a separation far larger than replicate drift. What it explicitly did **not**
establish is that this is the iPhone allocator, that it ends the jetsam kill, or that **shaders** are implicated
at all (they were never measured).

So state the change honestly in the commit and the code comment: this is a **defensive default on the platform
that is being killed**, chosen because the cost of being wrong is one settings toggle and the cost of being
right is the client staying alive. It is not a proved fix.

Two consequences for the round:

- **Particles carry evidence; shaders are precautionary.** They can land together (the ask), but keep them as
  two independent terms in the predicate so a later measurement can re-enable one without unpicking the other.
- **Confirm on a physical device.** `.agents/memory/topic-iphone-webkit-sep18-21.md` indexes the whole arc, and
  `iphone-qa-access-and-relay` is how a device is reached at all (there is no owned iPhone; Safari is relayed
  over an SSH forward). A verdict from Linux WebKit is a lead, not a confirmation.

## 4. Interaction with the other open handoff

[handoff-baked-stills-in-static-mode.md](handoff-baked-stills-in-static-mode.md) removes the live static
surfaces for the card ripple and the two rarity glows. That makes `static` cheaper on iPhone but does **not**
make this round unnecessary: the 18 canvases measured on the device were a combat screen, where the bulk of the
particle fleet is everything *except* the rarity glows (those only mount on the card-reward picker). Land them
independently; if the stills round lands first, re-measure before assuming the seed is still needed — and if it
is not, the honest outcome is to drop this round rather than ship a seed nothing justifies.

## 5. Verification

- `cd frontend && npx vue-tsc --noEmit && npx vitest run` — **never `npm run build`, it deploys.**
- Extend `frontend/src/mirror/__tests__/` (the settings-store specs): an iPhone UA seeds `off`; an iPad-masquerade
  UA (`Macintosh` + `maxTouchPoints: 5`) seeds `off`; a Mac (`Macintosh`, `maxTouchPoints: 0`) does **not**;
  a saved `shaderMode` beats the seed; `?shaders=dynamic` beats both; the seed does not change what a
  `QUALITY_PRESETS` rung writes.
- A spec that the seed is *not* a floor: with the seed active, setting the panel to `static` and reloading with
  that value in storage still yields `static`.
- Device leg: relayed iPhone Safari, first visit shows Off/Off, and the panel can lift both.

## 6. Commit

One squash commit on `main`, Conventional Commits ([../commit-and-release.md](../commit-and-release.md)), with a
`Changelog:` trailer a player reads — something like *"iPhones now start with shaders and particles off, which
keeps Safari from running out of memory; both can be turned back on in settings."*
