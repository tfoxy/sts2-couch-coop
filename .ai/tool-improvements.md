# Tool improvements

Concrete missing/brittle tooling discovered while implementing specs. Not a wishlist — only gaps hit in practice.

## Maintenance process

After an improvement is implemented, delete the entry. If an entry is stale or not-applicable, delete it.

Before deleting an entry: verify the limitation is actually gone, and if the workaround changed SOURCE, replace
that workaround with the improved tool behaviour first — an entry deleted while its workaround still ships just
loses the reason the workaround is there.

## Mirror replay: no per-subtree DOM census for "why is element X missing?"

Discovered: round-6 WS-WEB, diagnosing the "energy orb missing on Silent" report.

`scripts/bench-mirror-replay.mjs --census` only reports AGGREGATE post-settle stats (offscreen-leaf %,
element-kind counts, drawImage-by-canvas, WebGL compile counts). To diagnose a specific missing scene element
you need the opposite: a focused dump of ONE scene-subtree — per-node `data-scene-file`/`data-scene-node-path`,
computed `backgroundImage`/`mixBlendMode`/`opacity`/`filter`, bounding box, resolved-vs-404 texture URLs, label
text, and particle-canvas count. I had to hand-roll this (a `[data-scene-file$="..."]` subtree walk + a
Playwright `route("**/res/**")` that serves extracted PNGs from disk so the live game is never touched).

Suggestion: add a `--subtree "<data-scene-file suffix>"` census mode to bench-mirror-replay (or a small standalone
`scripts/census-mirror-subtree.mjs`) that reuses the existing fake-WS replay + a disk `/res` asset route, and emits
the per-node census above. Reusable for any "element X renders wrong/missing" defect, not just the energy orb.

Also useful alongside it: a character-retarget transform for combat recordings (rewrite `<char>_*` asset/scene
paths + strip the per-character material delta) so a single Ironclad combat capture can stand in for a character
with no recording of its own — no live game needed to A/B a per-character rendering difference.

## No card-reward (or any view-scale screen) recording contains a hover tip — offline tip-anchor screenshot impossible

Found: WS-TIP (round 6) — verifying the reward HoverTip owner-follow composition.

- The WS-TIP fix's primary visual is "a tip glued to an ENLARGED off-centre card on the card-reward screen".
  None of the bench recordings pair a hover tip with a view-scale screen:
  `audit-cardreward-open.ndjson` has the card-reward group + cards but ZERO `NHoverTipSet`;
  the only tip-bearing recordings (`wscrisp-hovertip`, `wscrisp-deckdialog`, `r4fix-trash-tip`,
  `combat-2026-07-15T…`) are all combat/deck (no view-scale scene).
- `--replay --shot` replays a recording passively; the QA control channel is NOT mounted under `--replay`,
  so focus/hover cannot be synthesized to make a tip appear. So the tip-follow visual is not producible
  offline from the current recording set. (The enlarged cards render fine — see the render below — and the
  follow magnitude is proven numerically by `RewardTipComposeReplayProbe` over the real streamed card
  geometry in `audit-cardreward-open.ndjson`: side cards at c=610/1310 map to ±35 = 0.10·(c−960).)
- Gap → either (a) capture a card-reward recording WITH a keyword tip focused on a side card
  (`record-mirror-stream.mjs` while hovering a reward card), or (b) let `--replay` optionally inject a
  synthetic hover/focus (a `--replay-hover <id>` style hook) so tip-anchoring visuals can be shot offline.

Note: `--replay --shot` WITHOUT `--assets` still renders textured frames from the native AssetDiskCache
(`assetCache hits>0, writes=0`) and makes NO network call (the empty base URL fails `_parse_url`, so it never
touches the live bridge on :13337) — a safe way to render a recording's final frame offline.

## bench-mirror-replay `--pace=max` deadlocks: watch=0 client never acks, credit pump stalls at 3 messages

Found: occlusion-regime measurement experiment (backstop round, Aug-7) — reproduced independently against a
stock dev server with the stock script.

The bench client connects with `?watch=0`, so `watching=false` and `sendSceneAck` returns early
(`mirrorClient.ts:299`) — but the `--pace=max` credit pump only advances on a scene-ack, so delivery stalls
after 3 messages and the scene never renders. Workaround used: recorded pacing (drop `--pace=max`).
Fix direction: under `--pace=max`, either pump credits on delivery instead of on ack, or force `watch=1`
acks in the bench init script.

## No supported way to drive a REMOTE player's acquisition on a local-bridge fixture instance

Found: same round, while trying to prove the multiplayer-row potion ObtainedAnimation strand fix. All four
routes dead-end by design: `dev console potion` always targets LocalPlayer; a 2-seat rewards fixture only
populates p:1's overlay; `act claim-reward --player-id p:2` → `wrong_player` (`remoteOrchestration:
local-only-degraded`); authoring the fixture with a remote "me" is rejected by the loader. The only real route
is a second ENet peer, unsafe while a live host holds the ENet UDP port. Fix direction: a dev-console or
fixture hook that procures an item AS a named synthetic seat (spirectl bridge), so remote-row animations are
testable on one instance.

## `flock /tmp/sts2-dotnet-build.lock -c 'dotnet build …'` deadlocks: dotnet's persistent build servers inherit the lock fd

Found: WS-1 (headless VFX finish nudge, Aug-7), while sharing the build lock with a concurrent agent editing
`../spirectl`.

`flock FILE -c CMD` forks and lets the child inherit the locked descriptor. `dotnet build` leaves TWO kinds of
persistent server processes behind — `VBCSCompiler` (Roslyn compiler server) and `MSBuild.dll /nodemode:1
/nodeReuse:true` worker nodes — which are reparented to systemd when the build exits and keep that inherited
descriptor open **forever**. The lock is therefore never released, and every later flock-wrapped build blocks
indefinitely. Observed twice: one 15-minute stall held by a single orphaned `VBCSCompiler`, then a second stall
held by 11 orphaned MSBuild nodes. Both agents' builds were blocked while nothing was compiling.

Diagnosis: `fuser -v /tmp/sts2-dotnet-build.lock` — if anything other than `flock` (and its live child) holds
the file, that is the leak. Workaround used: `kill` the orphaned server PIDs (they are disposable; the next
build spawns fresh ones), which released the lock immediately.

Fix direction: whatever documents/uses this lock should specify `flock -o` (`--close`: closes the descriptor in
the child, so the build's server processes cannot inherit it, while the `flock` parent keeps holding it for the
command's lifetime). Belt and braces for anything long-lived: `dotnet build -nodeReuse:false
-p:UseSharedCompilation=false`.

## `act draw-map-stroke --points` takes an undiscoverable "TheMap content space" — no way to aim a stroke

Found: Tier-3 verification of the map-quill mirror rendering (Aug-7). `sts2 act draw-map-stroke` (and
`sts2 map draw-stroke`) document `--points` as "TheMap content space", and `sts2 map drawings` reads back in the
same space, but nothing in the CLI exposes what that space IS. There is no map/viewport transform in `sts2 state`
and no `--space` flag, so placing a stroke on a chosen part of the parchment is guesswork: my first stroke landed
entirely off-screen (content y 750-900 → stage y −924…−741). Workaround used: draw one throwaway stroke, read the
rendered `<polyline>` back out of the browser mirror's DOM, and least-squares the affine
(`stage_x = −188 + 1.1742·cx`, `stage_y = −1843.3 + 1.2251·cy` for that scroll position) before drawing the real
one — which is circular if the thing under test is the renderer itself.

Fix direction (../spirectl): have `sts2 map drawings --json` also return TheMap's current content→viewport
transform (scale + offset, or the four corners of the visible content rect), and/or let `draw-map-stroke` accept
`--space design` (1920x1080 stage coords) and convert server-side where the real transform is known.

## No observable for the map DrawingTools active tool (quill / eraser / none)

Found: same round, asserting that a browser tap on the enlarged DrawingTools panel actually reached the game.
`sts2 state` has no map-drawing section at all, and the mirror DOM's icon `opacity: 1` turned out to be a HOVER
highlight (a hover-only pointer probe raises it too), not selection — so there is no direct "which tool is armed"
read. Workaround used: infer it from the SIDE EFFECT — pressing a tool button also paints a 1-point stroke on the
map underneath with the *previously* armed tool, so the new stroke coming back as an eraser stroke (`isEraser` /
`data-line-erase`) after tapping Draw proves the eraser had been armed by the prior tap on Erase. That is indirect
and only works because of a quirk.

Fix direction (../spirectl): add the armed tool + per-player stroke count to `sts2 state` (or to
`sts2 map drawings --json`, which already knows the map screen is open).

## Repo browser QA has no working session-based driver: global `playwright-cli` chromium build is missing

Found: same round. The `playwright-cli` skill is the documented way to drive a page across steps, but the globally
installed `@playwright/cli` 0.1.11 wants `chromium-1223` while this machine only has `chromium-1217/1222` (the
frontend pins playwright 1.59.1), so `playwright-cli open` dies with "executable doesn't exist". Every live-mirror
QA agent then hand-rolls the same throwaway persistent driver (a node script over
`createRequire("<repo>/frontend/package.json")` + an HTTP control port) because one-shot scripts re-run the whole
join flow per measurement. Fix direction: check in a small `scripts/mirror-driver.mjs` (goto/resize/eval/shot/
tap/click/drag/hover over a localhost control port, using the frontend's own playwright), or pin playwright-cli to
a version whose chromium is already installed and say so in `docs/agents/qa-recipes.md`.

## The documented isolated-probe recipe (`--headless` + a `players: 2` fixture) segfaults the game on combat drive

Found: Tier-3 verification of the headless particle `finished` nudge (Aug-7). `docs/agents/qa-recipes.md` §2 says
the safe isolated probe while a live host is up is `--headless` plus a fixture with `players: 2` (host-local
seats, `SetUpNewSingleplayer`, no ENet). That environment reliably CRASHES: **5/5** runs died with a native
segfault (`kernel: SlayTheSpire2[<pid>]: segfault at 0 ... in memfd:doublemapper`, no managed trace in
`godot.log`) within ~0-2s of `sts2 act end-turn --player-id p:1` when a `sts2 dev scene tree` poll was in flight
and `sts2 state actions --player-id p:2` followed immediately. Reproduced identically with the feature under test
disabled (`COUCHCOOP_HEADLESS_PARTICLE_FINISH_NUDGE=0`), so it is not that fix; hand-scripted variants with
`sleep`s between the steps did NOT reproduce (0/3), so it is a race, not a fixed sequence.

The gap it exposes (a second, about `state actions` silently defaulting to the first seat, was closed on
2026-09-04: spirectl now reports `perspective{playerId,requestedPlayerId,scope,usesDefault,seatCount}` on every
`state actions` and warns `perspective_defaulted_multi_seat` when a multi-seat run is answered with no
`--player-id`):

1. **The recipe's stated reason for `players: 2` is wrong**, which pushes agents onto the crashing path for no
   benefit. The suspender under test is installed from `CouchCoopMod.Init`'s windowless branch
   (`IsHeadlessClient || IsHeadlessDisplay()`), i.e. by `--headless` alone — it is already installed before any
   fixture loads, and a 1-player fixture takes the same no-ENet single-player setup path
   (`Sts2FixtureLoader.CreateSinglePlayerRunContextAsync`). Fix direction: correct §2 to say "`--headless` with
   ANY host-local fixture (1 or 2 seats) — never `-fastmp host_standard`", and note that 2 host-local seats are
   currently unstable under scripted drive.
Repro/evidence in this checkout: `.sts2/qa/qa5-crashprobe-2seat-nudgeoff.txt`,
`.sts2/qa/qa5-crashprobe-2seat-nopoll.txt`, driver `.sts2/qa/qa5-drive-combat.py`, fixture
`.sts2/qa/qa5-vfx-combat.sts2.fixture.yaml`. Workaround used: the single-seat fixture
`.sts2/qa/qa5-vfx-combat-solo.sts2.fixture.yaml`, which drove 4 combat turns with no crash.

---

Found: QA round for the lobby QR host panel (Aug-8), while rewriting both live lobby probes.

1. **`dev scene node --properties` does not expose `mouseFilter`** — **the CLI half is FIXED (2026-09-04)**;
   this entry stays open only for the repo-local workaround it left behind. spirectl now returns
   `mouseFilter`, `focusMode` and `mouseDefaultCursorShape` (int, null on non-Controls) in the scene-node
   property payload, verified live on both the addressed node and its children. The original gap: the
   property existed only in spirectl's mirror scene WATCHER (`Sts2RuntimeSceneWatcher`), never in the dev
   scene PROVIDER, so any contract of the form "this overlay must not eat lobby clicks" was unassertable
   structurally — and the probes hid it, written as
   `assert(mouseFilter === undefined || mouseFilter === 2 || ...)`, which passed VACUOUSLY for months.
   **Remaining work here**: `scripts/probe-lobby-actions-remain-available.mjs` still asserts the filters with
   a source-regex over the C# (see its header comment and `evidence.source.note`) because the property was
   unavailable. Convert it to a LIVE assertion off `dev scene node --properties`, keep the regex as a
   secondary drift guard, and re-run `tests/scenarios/lobby-actions-remain-available.sts2.yaml` under the
   live lock to prove the conversion — then delete this item.

2. **A freshly restarted game silently pops fixture-created lobbies.** For several seconds after
   `game.deploy --restart`, the game is still finishing its own boot flow, which pushes the main menu and
   discards a lobby the fixture loader just built (measured: fixture lobby at 11:23:02, main menu at
   11:23:04). Downstream this surfaces only as `invalid_query_filter` "node path not found" on an unrelated
   node, which is a very long way from the cause. Workaround still in use: a `dev.delay: ms: 20000` step in
   all three live lobby scenarios plus a stability re-check that reloads the fixture.

   **2026-09-04: the requested tool now EXISTS but did not replace the sleep.** spirectl added
   `--wait-quiescent-ms` / `--quiescent-stable-samples` / `--require-quiescent` to `game launch` /
   `game deploy` / `game install-bridge`, and `waitQuiescentMs` as a `game.deploy` scenario-step key. On a
   real restart from this repo it reports `quiescence{quiescent:true, elapsedMs:1232, attempts:3,
   timedOut:false, status.screen.id:"main-menu"}` — i.e. it declares the game settled about a second after
   attach, which is INSIDE the window this entry is about. Replacing the `dev.delay` with
   `waitQuiescentMs: 20000` in `pc-lobby-qr-overlay.sts2.yaml` was then tried live: the deploy leg passed,
   the probe started (its `.sts2/artifacts/pc-lobby-qr-overlay/` directory was created) and produced no
   evidence file and no output for 21 minutes, until a 25-minute timeout killed it. The delay was restored.
   Cause not isolated (the run was killed before it could report, and the live lock passed to another agent
   before a clean re-run was possible), so it may be the early-quiescent verdict above or something else in
   the probe. **Next step**: re-run that scenario under the live lock with `--progress` and a longer budget,
   comparing a `dev.delay` run against a `waitQuiescentMs` run; if quiescence is genuinely early, the fix
   direction for ../spirectl is that the boot flow's own screen pushes should count as non-quiescent.

## Headless canvas-stage screenshots capture the DOM overlay and none of the stage's pixels

Found: round-4 WS-C (M3 card trails), trying to produce the RMSE gate for the canvas arm's ribbon.

Both `scripts/probe-card-trail-replay.mjs` and `scripts/bench-mirror-replay.mjs --shot` produce, on a
`?stage=canvas` page in headless Chromium on this box, a PNG containing only the DOM overlay (text) and
nothing the stage itself drew. It is not an empty stage: the same run's `__mirrorCanvasStats()` reported
492 executor quads in 5 batches at a 1920x1080 backing store with `contextLost: false`, and the paint dump
listed 396 `role=trail` commands with sane matrices and colours. Tried and did not help: `--disable-gpu`
(the bench's own SwiftShader arm), serving real asset bytes with `--res-root`, forcing the quads to opaque
white under `blend=mix`.

Why it matters: every numeric acceptance gate phrased as an RMSE between a canvas crop and a DOM crop is
unrunnable headless, and — worse — a blank canvas-arm crop is indistinguishable from a genuinely missing
decoration, so a run can "prove" a regression that is not there. The round-3 note that compositor-sensitive
evidence needs `--headed --gpu vulkan` turns out to cover plain screenshots too, which is not what a reader
of either script would expect.

Fix direction: find out whether this is a readback timing issue (screenshot after the compositor has
swapped a non-`preserveDrawingBuffer` context) or a headless-compositing one, and then either make the two
harnesses force a fresh paint immediately before capture or make them REFUSE a canvas-arm `--shot` outside
a headed run rather than writing a blank PNG. Either is better than the present silent blank.
