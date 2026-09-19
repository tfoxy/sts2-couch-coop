---
name: touch-input-qa
description: Run and interpret the live touch/pointer harness (H1-H17) for mirror input work — inputCapture, pointerMap, raiseInverse, viewScaleInverse, confirmTap, hand raise, targeting drag, landing parity, reward focus, shop removal. Mandatory before landing any pointer-input change.
---

# Live pointer-input harness

The bugs in this area are **feedback loops**: the client sends a coordinate, the game re-poses the boxes, and the
next resolve sees different geometry. Unit tests and replayed recordings structurally cannot exercise that, which is
why these bugs have been fixed and re-broken across three rounds. The closed loop *is* the measurement.

Full reference: [docs/agents/touch-live-harness.md](../docs/agents/touch-live-harness.md). Read it before extending
the script.

## Running it

```bash
node scripts/validate-touch-live.mjs                        # full matrix, ~40 min
node scripts/validate-touch-live.mjs --keep                 # leave instance + vite up to iterate
node scripts/validate-touch-live.mjs --checks H1,H3 --combos mouse-1920
node scripts/validate-touch-live.mjs --checks H13 --query spreadAudit=1
node scripts/validate-touch-live.mjs --list                 # check + combo names
sts2 --instance touchqa game close                          # teardown after --keep
```

Defaults: `--game-port 13457`, `--vite-port 5199`, `--instance touchqa`,
`--out .sts2/artifacts/touch-harness`. With `--keep`, a second run is about a minute per combo.

**The harness never builds or deploys anything.** The mod must already be deployed — see the `couch-deploy` skill.

## Safety — this is non-negotiable

A past incident scripted blind input into a live game session.

- Talk **only** to the `touchqa` instance on its own port. The developer's game lives on `:13337`. Never target it,
  never `sts2 game close` without `--instance`, never load a fixture into it.
- An instance or dev server the harness **found** already running is left running on teardown, `--keep` or not.
- If a run dies because another agent's broad `pkill` killed the instance: **never answer with a broad `pkill` of
  your own.** Kill by exact process pattern, in its own Bash call.
- Artifacts land in git-ignored `.sts2/artifacts/touch-harness/`. Never commit them.

## Traps that produce a wrong verdict

- **`--game-port` is a preference, not an assignment.** `COUCHCOOP_PREFERRED_PORT` feeds a port *walk*; the browser
  server takes the next free port upward. Waiting on the requested port reads exactly like an infinite boot. The real
  port comes from the mod's own record via [scripts/lib/instance-port.mjs](../scripts/lib/instance-port.mjs), which
  ignores the file once the writing pid is gone.
- **The 2400-wide leg is not optional.** Widescreen stretch is on by default and the near-miss, spread and squeeze
  machinery only runs above design width 1920. A 16:9-only run proves nothing about any of it.
- **Run the complete H1-H17 set across every selected current combination.** The harness gates every selected
  combination.
- **A single verdict from this harness proves nothing — of either sign.** That is the round-of-2026-09-19
  finding, and it applies to more than H10: H3 inverted between the two stage-fit arms on a repeat run, and H1
  moved between combos run to run. Two consecutive runs per arm is the floor for any claim, and a check that
  disagrees with itself across runs is a broken check whatever the product does.
- **Check the instrument before you believe a failure.** `__mirrorInteractiveRects()` — which every sample point
  is computed from — composes hit boxes from a cached parent global and can serve one the scene has moved off.
  It is what made H1, H3 and H6 red at the same time. The harness now measures each rect against the box the
  browser drew and refuses to sample through a disagreement; a failure note that says "hit surface still
  disagreed with the game's pose" is the instrument talking, not the game.
- **`scripts/probe-hand-hitbox-live.mjs` is the oracle for any expectation about a card's edge.** It maps where
  the game actually accepts a pointer, by hovering (never pressing) a grid across and around a card, against an
  instance the harness left up with `--observe --keep`. Use it before changing what a check expects — H6 spent
  months asserting that the game focuses a card from 21px outside its hit box, which it has never done.
- **H11, H12 and H13 are three different questions.** H11 is landing parity (where cards are drawn vs where the game
  has them), H12 scores the *prediction* (where the client decided to send each card), H13 audits the wide-screen
  field on every node the canvas walks. A rest-time gate that does not score the prediction is vacuous. H12's seam
  must be **polled**, not read once, and `endpointDrawn` must come from the backend's own drawing path.
- **`COUCHCOOP_HEADLESS_IDLE_FPS=0`** or the idle suspender drops MaxFps to 8 under you.
- Confirm-button visibility is sampled **≥850 ms** after the tap.

## Reporting

Give the per-check table, the combos that ran, and the artifact directory. Compare against the baselines recorded in
the harness doc rather than against your own expectations. Any visual claim lists its image path.

## Stop conditions

3 failed instance launches, a wedged dev server you did not start, or a check whose expectation you cannot form from
the product's own state — stop and report, do not invent a threshold.
