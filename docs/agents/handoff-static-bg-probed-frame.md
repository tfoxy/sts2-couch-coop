# Handoff — frame-qualified static backgrounds ignore their probed frame

**Status: OPEN, unstarted (2026-09-23).** Found by the live QA of the seat host-authority round (`0eb8181a`,
`010a17c2`, spirectl `25d15b08`). That round made every seat show the host's still and fixed the shop still's
half-render shift; it did **not** make frame-qualified stills land where the game draws the scenery.

**Symptom, measured** (still vs the live host frame, best-match shift in design px over textured windows; the
live DOM elements in the same screenshots register at exactly 0,0, so the stage itself is aligned):

| Still | URL frame | Measured shift (still − live) | What a render at the *fallback* placement predicts |
| --- | --- | --- | --- |
| Neow `/bg/events/neow` | `105.6,99.4,0.890` | x 0, y −56…−60 in every window | spirectl's reference placement at 16:9 is (105.6, **40**, 0.89): Δy = −59.4, Δx = 0 |
| Shop `/bg/rooms/merchant_room` | `-10.0,20.0,1.010` | x +4…+10 on the left, −4…−8 on the right; y −20 at the top → −29 at the bottom | the identity frame (0, 0, 1.00): Δ = (+10, −20) at the origin, shrinking ~1% toward the far edges |

Both match their fallback to within the 4 px search step. Evidence (gitignored, main checkout):
`.sts2/qa/static-bg-seat-host/live/` — `browser-vs-host-registration.json`,
`leg1-neow-still-vs-live-shift-control.json`, `leg3-shop-still-vs-live-shift.json`, and the screenshot pairs
`leg1-neow-{browser,host-game}.png`, `leg3-shop-room-{browser,host-game}.png`.

---

## 1. Root cause — confirmed in code, not yet by a fixed render

The live game's asset provider **drops the frame**. In `../spirectl/bridge-mod/src/Spirectl.Sts2/`,
`Live/Sts2RuntimeFactory.cs` hands the runtime `Sts2EmbeddableAssetProvider`, and its `GetAsset`
(`Live/Sts2EmbeddableAssetProvider.cs`, the `new AssetExtractRequestSnapshot(...)` at ~line 49) forwards
`RenderWidth/RenderHeight/CompositionSelector/ImageQuality/ImageOpaque` but **not `EventBackgroundFrame`** (nor
`Timeout`). Every consumer downstream then does exactly what it documents for a missing frame:

- events: `TryResolveEventBackgroundFrame` → `TryParseFrameSpec(null)` → the reference `Resolve(1920,1080)`;
- the subtree lane (rooms): `?? new EventFrame(0f, 0f, 1f)` — identity.

The sibling `Embedding/BridgeEmbeddableAssetProvider.cs` **does** forward it, which is why nothing caught this:

- couch's route tests use a fake runtime and assert at the `EmbeddableAssetRequest` seam
  (`BrowserServerRouteTests`, "the probed frame reaches the render seam") — one hop before the drop;
- spirectl's threading tests (`Sts2CombatBackgroundLayerSelectionTests.BridgeEmbeddableAssetProvider…`) cover the
  bridge provider only;
- `bridge-tests` does not compile `Live/` at all (`.agents/memory/spirectl-bridge-tests-excludes-live-host.md`), so
  the live provider has no unit coverage.

The drop predates the public history (both files arrive in spirectl's initial release), so every frame-qualified
still ever served from a real game has been a fallback render.

## 2. The fix — spirectl

1. **One mapping, two callers.** Move the `EmbeddableAssetRequest → AssetExtractRequestSnapshot` construction into a
   Godot-free helper under `Embedding/` and call it from both providers, so a field added later cannot be forwarded
   by one and dropped by the other. Decide `Timeout` on purpose (forward it, or document why the live provider must
   not) — do not leave it dropped by accident.
2. **Pin it where it can run.** In `bridge-tests` (which compiles `Embedding/`): an explicit
   `EventBackgroundFrame` threading test beside the existing render-size/selector ones, plus a reflection test that
   every `EmbeddableAssetRequest` property with a same-named `AssetExtractRequestSnapshot` parameter is forwarded by
   the helper. Make it fail against today's live mapping before you fix it.
3. **Say which frame was used.** The render notes are identical for a probed and a reference frame today, which is
   what let this hide. Add a note that distinguishes them ("placed at the caller's probed frame" vs "no frame
   supplied: reference placement") so a support log or `/perf/bg.json` can tell them apart.

Traps: a fresh spirectl worktree silently skips `Live/` without `sts2.local.yaml` — copy it in and confirm
`ENABLE_STS2_LIVE_HOST` before trusting a green `scripts/validate.sh bridge-build`; run `bridge-tests` **alone**
(MSB3030 race). See the `spirectl + build tooling traps` topic index in project memory.

## 3. The fix — couch: move the cache namespaces again

Every frame-qualified JPEG rendered so far is a fallback render stored under an immutable URL — on hosts' disks
(`bg://events/…&frame=…&v=1`, `bg://rooms/…&frame=…&v=2`) and in browsers' year-long HTTP caches. The `b=` token is
the game build only, so a mod update does not move those URLs. Correct bytes need fresh keys **and** URLs:

- `CouchCoopStaticBackgroundProvider.KeyVersionFor`: events → `"2"`, rooms → `"3"`; combat stays `"1"` (combat
  never carries a frame, and its selector was always forwarded).
- The client's wire-minted fallbacks in `frontend/src/mirror/StaticBackground.vue` (`/bg/events/…?v=`,
  `/bg/rooms/…?v=`), and the pins in `StaticBackgroundProviderTests` / `staticBackground.spec.ts` that exist to keep
  the two sides equal.
- The route's 400 message and `host-render-cost-aug22.md`'s contract lines.

Land this **with** the spirectl fix, not before: a bump on its own just re-renders the same wrong bytes under a new
name.

## 4. Separate, optional: the frame-less reference placement

After §2 the probed frame is used whenever the URL carries one, which is every descriptor URL — including every seat
view, which now always shows the host's descriptor. The reference placement then matters only for **frame-less**
event URLs: the prerender sweep's bakes and a host viewer's wire fallback.

It is still wrong at 16:9 by exactly the Neow residual: `Sts2EventBackgroundFrameMath.Resolve` re-centres **x** for
the scale shrink (`positionX += width·½·(1−scale)`) but has no **y** counterpart, and `1080·½·(1−0.89) = 59.4`
is precisely `99.4 − 40`. Treat that as a hypothesis about spirectl's formula, to be confirmed against the live probe
at 16:9 **and** at least one other aspect, before changing it. `Resolve` also feeds the recon-still lane, whose
output is documented byte-identical, so a change there needs its own evidence and its own commit. It does not
block §2–§3.

## 5. Out of scope, noted so nobody re-discovers it

- **Combat framing is unmeasured, not known good.** The QA calibration on a combat still was inconclusive (dark,
  low-texture windows: `calib-combat-still-vs-live-shift.json`). Measure on a textured background before claiming
  anything either way.
- **Do not compensate anywhere else.** The client places the still correctly (a 2520×1080 image at
  `left: calc(50% - 1260px)`); the tracker's probe is correct (it measures what the game shows). Shifting the frame
  in the tracker or the image in CSS would only hide the drop.
- **Do not revert spirectl `25d15b08`.** Re-posing the subtree root after attach fixes a different, real bug (the
  (+1260, +540) centre-anchor shift). It is necessary once the frame arrives, not a cause of this residual.
- The `static-bg …` host log lines go to stderr only — zero hits in any `godot.log`. Worth fixing, not here.

## 6. Verification

- spirectl: `scripts/validate.sh bridge-build` (with `Live/` confirmed compiled), then `bridge-tests` alone; the new
  tests fail before the fix and pass after.
- couch: `dotnet run --project tests/CouchCoop.Mod.Tests -- static-bg`; `cd frontend && npx vue-tsc --noEmit &&
  npx vitest run` (**never `npm run build`** — it deploys).
- **Live, isolated only** (`live-game-qa` agent; the operator's game and install stay untouched). Reuse the Sep-23
  recipe — its private-namespace wrappers are under `.sts2/qa/static-bg-seat-host/live/logs/` and are how it stayed
  clear of another session's farm on UDP 33771 and the shared seat socket. A hosted run needs a real browser seat
  and a profile that opens on Neow; the shop leg is simplest as the singleplayer shop fixture with a direct view.
- **Pass:** on the same windows, the still-vs-live best shift is within the 4 px search step for Neow and the shop,
  the host log shows a fresh render (`static-bg-warm miss`) under the new version, and the render notes name the
  probed frame. List every screenshot and still behind the claim.

## 7. Commits

spirectl first, then couch; one squash commit each on `main`, Conventional Commits
([../commit-and-release.md](../commit-and-release.md)). The couch commit carries the player-facing trailer (the
changelog collector walks this repo only), e.g. *"Ancient event and shop backgrounds now line up with the scene
instead of sitting slightly too high."* Wrapped trailer lines are indented.
