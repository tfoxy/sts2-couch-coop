# Live mirror pointer harness

Run `scripts/validate-touch-live.mjs` before landing any mirror pointer-input change, including
`inputCapture`, pointer mapping, raise/view-scale inverse mapping, confirm taps, or hand layout/raise rendering.
It drives an isolated game and a real browser through the browser-to-game feedback loop; a recording cannot prove
that loop.

## Run

```bash
node scripts/validate-touch-live.mjs
node scripts/validate-touch-live.mjs --stage canvas
node scripts/validate-touch-live.mjs --checks H3,H11 --combos mouse-2400
node scripts/validate-touch-live.mjs --list
```

The matrix is pointer `{mouse, touch}` × viewport `{1920×1080, 2400×1080}`: `mouse-1920`,
`mouse-2400`, `touch-1920`, and `touch-2400`. Every selected cell gates the exit status; do not treat a
failed cell as informational. The 2400-wide leg is required because widescreen spread and inverse-coordinate
paths do not run at 1920.

`--stage dom|canvas` selects the renderer backend when that option is available; the equivalent page selector is
`?stage=canvas` (DOM is the default). A cross-backend change should run the four-cell matrix for each backend it
can affect. `--checks` and `--combos` narrow a real closed-loop run—they do not make it observational.

Use `--keep` only for local iteration. `--observe --keep` brings up the first selected cell without gestures.
Artifacts go to `.sts2/artifacts/touch-harness/` and must not be committed.

## Safety

- The harness uses only its named instance (`touchqa` by default) and its walked browser port; never point it at
  the developer's game or use an unscoped game close.
- It loads fixtures and sends real input. It stops only the game and Vite server it started.
- It does not build or deploy. Deploy the mod first, and take the required live-QA lease before running it.

## Checks

| Check | Gate |
| --- | --- |
| H1 | A dwell focuses the card under the pointer, including fan seams and raised bands. |
| H2 | Focus remains stable for the dwell; it does not apply then disappear. |
| H3 | A targeting drag sends coordinates that converge to the pointer; saves arrow evidence. |
| H4 | A held card remains present, displayed, non-zero, and on stage throughout a drag. |
| H5 | The upper band of a raised card can begin a grab. |
| H6 | Edge, corner, and art-overhang input resolves to the intended nearby card. |
| H7 | A from-hand choice prompt suppresses the cosmetic hand raise. |
| H8 | Touch confirm controls inspect first and do not activate from their label overhang. |
| H9 | An off-grab-point drop back into the hand cancels and leaves hand interaction usable. |
| H10 | Adjacent-card focus handoff never overshoots its destination and returns. |
| H11 | Resting hand poses match the streamed game pose in untouched, focused, handoff, selected, and cancelled states. |
| H12 | The renderer's predicted hand landing matches the pose ultimately supplied by the game. |
| H13 | During hand motion, each widened-stage field claim is evaluated at the node's drawn pose. Run with `--query spreadAudit=1`. |
| H14 | Hold-to-raise enables on press, survives capture outside its control, and restores the saved setting on release. |
| H15 | After an exact five-to-four hand transition, a genuinely raised survivor keeps an independent board-empty point raw; its raised-only band resolves correctly, and its focused zero-lift grab leaves the fan then safely cancels back. |
| H16 | Reward-list focus follows the last press modality; the auto-focused row takes the one-tap path and puts exactly one plain left click on its native centre; the readiness that made it one-tap does not survive focus moving away. Asserted on the WIRE — a rewards fixture cannot claim a reward by any path, so whether that click CLAIMS belongs to a real reward screen (`dev console room Monster`, then `dev console win`). Row-removal index retention/clamping is covered by `rewardFocusCoordinator.spec.ts`, not here. |
| H17 | The shop card-removal service honours every Tap to focus / Confirm tap combination, opens a `remove` picker only through its permitted route, and stages one card without confirming the game dialog. Touch-only; runs on DOM and canvas. |

The report contains timelines, sent input envelopes, failed-frame geometry, and screenshot paths. Read the report
before changing thresholds or input rules; it separates browser-send failures from game-response failures.

## Fixtures and prerequisites

The harness needs `sts2` on `PATH`, root `sts2.local.yaml`, and an already deployed mod. It starts its own Vite
server and loads the committed touch, hand-choice, rest/reward, five-card, and shop-removal fixtures. H17 reloads
its shop fixture and page before every irreversible route, records the freshly loaded module bundle URL in its
report, and never presses the game's deck-picker confirm button. Run from the repository root or let the script locate it; for the full live setup and lease protocol, read
[qa-recipes.md](qa-recipes.md).
