# Architecture map (agent cheat sheet)

Current subsystem map for implementation and QA. Verify a load-bearing claim against current code before using
it as a contract. All paths are repo-relative unless prefixed `../`.

Configuration and diagnostics are owned where they are consumed. Product settings live in
`frontend/src/mirror/mirrorSettings.ts`; producer diagnostics and capability controls live in `../spirectl`.
This map records current contracts, not retired implementation alternatives.

## Browser contracts

- **Loader/hot reload:** published archives compile the loader with `CouchCoopEnableHotReload=false`: normal
  dynamic implementation loading remains, but the hot-reload protocol, discovery methods, and `hot-reload/`
  payload are absent. Local developer builds opt in with `true`; their spirectl shell protocol is v0 while the
  independent CouchCoop implementation contract remains exactly `1`.
  `src/CouchCoop.Mod.Loader/CouchCoopHotReloadProtocol.cs` rejects a local hot-reload artifact with a different
  expected contract; do not document or add compatibility versions without deliberately changing that boundary.
- **WebSocket:** the endpoint is `/ws`. Every connection carries the canonical `0`/`1` selectors
  `watch`, `staticBg`, `cardFlight`, `handTween`, and `trailDrive`, minted by
  `frontend/src/mirror/mirrorClient.ts`. `watch=0` suppresses the connect keyframe until the client sends a
  `watch` message. Recorders, e2e tools, and diagnostic clients must send the complete selector set. The page's
  retired view selector is not a WebSocket parameter.
- **Scene transforms:** scene data uses local transforms and local rectangles. Each renderer composes the parent
  chain; a client must not treat a child transform as stage-global or add a second global conversion.
- **Resources:** `/res/{path}` receives an unprefixed `res://` path. `raw` is the default and `?format=png` is
  the only alternate representation. There are no extension-based resource aliases; a `::` sub-resource is
  raw-only.
- **Spine clips:** `/spines/` bodies are `SPCL` v1 with encoded image-frame payloads and node-local placement. The sole
  retry selector is `retry=1`.
- **Geoclips:** `/geoclips/{scene}?node={path}&anim={name}&file={artifact}` is the browser form. Artifacts use
  `geoclip/1`; operator files are optional overrides, then the managed store under the branch cache's
  `geoclips/`. A failed probe falls back to the spine raster path rather than leaving a blank node.
- **Static backgrounds and cache:** combat URLs are `/bg/{id}?layers={digest}&v=1`; event and room backgrounds
  use `/bg/events/{id}?v=1` and `/bg/rooms/{id}?frame={frame}&v=1`. Their codec is named by `Content-Type`.
  Host caches live at `user://couch-coop/cache/<version>/` — one directory per GAME VERSION, each stamped with
  the build and cache generations that wrote it and emptied when either moves. At most two survive; the lowest
  version is retired, and a name that is not a version is reclaimed outright. Nothing consults the Steam branch,
  and an install that cannot state its version runs uncached rather than sharing one (`CouchCoopCacheRoot`). `SpirectlAssetBinaryCache.SchemaVersion` is a token component, not a path, and half of
  it is spirectl's asset-payload version; do not hand-bump that half.
- **Repros:** the browser flight recorder writes `repro/1` NDJSON. It records raw wire frames plus viewer input;
  `scripts/analyze-repro.mjs` and `scripts/replay-repro.mjs` are its consumers.

## Gesture / input
- Files: `src/CouchCoop.MirrorProtocol/Input/GestureMachine.cs` (1:1 twin `frontend/src/mirror/inputCapture.ts`),
  classification `src/CouchCoop.MirrorProtocol/Input/TouchTargetScan.cs` (web: `TOUCH_TARGET_TYPES` in
  `inputCapture.ts`), hand-choice `HandChoiceScan.cs`, wide-input `PointerField.cs` / `NearMiss.cs`,
  hit-scan `InteractiveRectScan.cs`. Native QA driver: `godot-client/src/Input/DemoInputPlayer.cs`.
- Mechanism: one classifier walks the wire scene tree to decide tap/drag/right-click/peek targets from a
  shared allowlist of node types; native and web run the *same* decision tree so touch semantics match
  pixel-for-pixel. Long-press uses a single armed deadline (`PeekMs`, hand cards) vs a longer right-click leg
  (non-hand cards) dispatched from `FirePeekIfDue`.
- Input classification is shared by the native and web implementations; do not introduce a client-specific
  alternate path.
- **Stage geometry.** `inputCapture` caches the stage's client rect. `InputCapture.invalidateStageRect()` is the
  exported seam; MirrorView calls it from `recomputeScale`, and the cache also self-heals on a design-width change.
- Tests: `tests/CouchCoop.MirrorProtocol.Tests/GestureMachineTests.cs`, `TouchTargetScanTests.cs`,
  `HandChoiceScanTests.cs`, `PointerFieldTests.cs`, `NearMissTests.cs`, `InteractiveRectScanTests.cs`,
  `EndTurnScanTests.cs` — run via `dotnet run --project tests/CouchCoop.MirrorProtocol.Tests`. Web:
  `frontend/src/mirror/__tests__/inputCapture.spec.ts` (or the top-level test dir if moved — `find frontend -iname
  'inputCapture.spec.ts'` to confirm).
- Web twin: `frontend/src/mirror/inputCapture.ts` (includes `computeTouchInfo`). POINTER only — the keyboard is its
  own upstream source (see "Keyboard input" below), as the pad is.

### Gamepad input (`kind: "pad"`)
- **Path.** Browser Gamepad API poll (`frontend/src/mirror/gamepadCapture.ts`) → the existing `input` WebSocket
  message with `kind: "pad"`, a device-neutral `input` token and the `pressed` edge
  (`src/CouchCoop.Mod/Protocol/BrowserActionEnvelope.cs`) → `BrowserInputExecutor.BuildPad`
  (`Protocol/BrowserInputExecutor.cs`) → spirectl `SemanticActionKind.ControllerInput` → the seat's input bus.
  The token vocabulary and its refusals live in spirectl (`../spirectl` →
  `bridge-mod/src/Spirectl.Sts2/Live/Sts2BrowserPadMap.cs`, injected by `Sts2ActionHandler.Input.cs`); couch
  forwards the token verbatim and keeps no copy of the table.
- **Why an action and not a synthetic joypad event.** The game's own controller layer already maps abstract
  controller inputs onto the actions its screens react to, honouring the player's rebinds — so naming the input
  and letting the game decide re-implements nothing, which is the same argument as "Real input, not semantic
  actions" below. (`ControllerInput` is an *input replay*, not a commit path: it presses what has focus, it does
  not reach into a screen and finish a choice.) A synthetic joypad event would instead have to be translated
  through the seat's `InputMap`, which is exactly what the next bullet erases.
- **Orthogonal to the seat's joypad isolation, by construction.** `Session/HeadlessJoypadInputMapIsolation.cs`
  strips a headless seat's joypad *bindings* so a controller plugged into the host machine cannot steer a seat;
  the injected action never consults those bindings, so browser pad input works with the strip fully in place and
  **that file needed no change**. Its test is `tests/CouchCoop.Mod.Tests/HeadlessJoypadInputMapIsolationTests.cs`
  (alone: `dotnet run --project tests/CouchCoop.Mod.Tests -- headless-input`).
- **Secure context only.** `navigator.getGamepads` is gated on a secure context, so the default plain-HTTP LAN QR
  cannot see a pad at all; the TLS listener (`Server/SecureBrowserListener.cs`) and the web-link origin
  (`Server/CouchCoopWebOrigin.cs`) are the two join paths where this works.
- **Queue.** Pad edges take the ordinary discrete-input path through `Server/InputCoalescer.cs`: they never
  coalesce (only hovers replace a trailing hover, only wheel clicks merge), so both edges of a press arrive, in
  order, exactly like a key press.
- Tests: `tests/CouchCoop.Mod.Tests/PadInputMappingTests.cs` (beside `InputMappingTests.cs`).
- Game internals — which of the game's action names a token resolves to, why that resolution is a candidate list,
  and the Steam-Input hole the engine-side isolation does not cover — are in
  `.sts2/research/gamepad-web-client-feasibility-sep21.md`, not here.

### Keyboard input (`kind: "key"`)
- **Path.** `frontend/src/mirror/keyboardCapture.ts` (window key events, no stage and no coordinate) → the same
  `input` WebSocket message with `kind: "key"`, a `KeyboardEvent.code`, optional `modifiers` and the `pressed`
  edge → `BrowserInputExecutor.BuildKey` → spirectl `SemanticActionKind.KeyInput` → a real `InputEventKey` on the
  seat's input bus. The game maps the physical key onto its own shortcut, **rebinds included**, so couch names no
  game action.
- **Edges, not taps.** A press sends `pressed:true` and a release `pressed:false`; browser auto-repeat is dropped,
  which matches the game (it ignores echo keys). The capture releases everything it holds on blur, a hidden tab,
  `pagehide`, the setting going off and dispose — and a release is never gated by the filters a press passes
  through, because a filtered release is a key stuck down in someone's run.
- **KNOWN LIMIT — the game window must hold focus.** The game only acts on a key while its own window is focused
  (`NGame.IsGameFocusedWindow()`), and it enforces that at *two* layers: the key→abstract-input translation, and
  again in the consumer that turns the input into a screen action. So a browser driving the **host's own game**
  from the same machine gets nothing from the keyboard while the browser holds focus — the mouse is unaffected,
  because pointer routing has no focus gate, which is exactly why this reads as "keys are broken, mouse is fine".
  Measured live 2026-09-22 (A/B/A on one instance, one build: focused → `A` opens the draw pile; unfocused →
  nothing; refocused → works).
  **A joined player is unaffected**: seats run `--headless`, and Godot's headless display server hard-returns
  "focused", so both gates pass — verified live on a headless instance. Naming the game's own abstract input
  instead of the key does **not** get past this (the second gate is in the consumer); only a Harmony patch of the
  gate would, and that was deliberately not taken — the same gate is the only thing keeping a *physical* pad at
  the host machine (which the OS does not window-gate on Linux) out of an unfocused game. The pad path has the
  same limit.
- **Which keys reach the wire.** spirectl's `Sts2BrowserKeyMap` owns the vocabulary and refuses what it cannot
  name; `keyboardCapture` carries a conservative mirror of it so an unmappable key costs no error envelope per
  edge. Ctrl/meta chords are never forwarded — they are the browser's and the OS's, and the game binds none.
- **Focus guard.** Only TEXT entry swallows a key (a text-ish `<input>`, a `<textarea>`, `contenteditable`), plus
  `Space`/`Enter` while a focusable control has focus. Treating *every* `<input>` as text entry is what made the
  keyboard dead for a whole session once a settings checkbox had been clicked: the stage's `pointerdown` calls
  `preventDefault()`, which suppresses the focus change that would otherwise have moved focus off it.
- **Lever.** `?keyboard=off` (default on, read live, never persisted) — the gamepad's shape, no panel control.
- **What a key actually does, measured** (2026-09-22, isolated instances): `A`/`S` open the draw/discard pile,
  `Escape` closes it, `E` ends the turn (round 1→2, the enemies acted, player HP 75→54). A **number key picks the
  card up** and a second press of the same key puts it back — that is the game's own two-step (the play it starts
  watches the same input as its cancel), so completing the play is the pointer's job, not the key's. Read `sts2
  state` with care here: a held card shows in neither `view.selectedCard` nor the hand count, so the pick-up is
  only visible as the holder RE-PARENTING (`CardHolderContainer` → `Hand`) in the scene stream.
- Tests: `frontend/src/mirror/__tests__/keyboardCapture.spec.ts`, the wire half in
  `tests/CouchCoop.Mod.Tests/InputMappingTests.cs`.
- Game internals — the shape of the translation, its gates, and the live evidence — are in
  `.sts2/research/keyboard-web-client-sep22.md`, not here.

## Real input, not semantic actions
- **The rule** (CLAUDE.md → Architecture Rules): a viewer's gesture becomes the same hover / press / release /
  key events a player at the keyboard produces, replayed at a resolved coordinate; the game's own widget
  decides what that means. Committing a player's choice through a spirectl semantic action needs the
  maintainer's explicit go-ahead for that specific case.
- **Why.** A semantic action is a *re-implementation* of what the game does when you click the thing. The
  re-implementation is a copy, and a copy drifts. It also only reproduces the paths whoever wrote it thought
  of — a widget that can REFUSE is the easy one to miss, because on the happy path the two look identical.
- **The case that set the rule (Sep 2026).** Reward rows were claimed with `claim-reward`. Take a potion with
  no free potion slot and the game declines it: the potion bar plays its refuse animation and, when a player
  clicks the row with a mouse, the row stays and the reward is still there to take later. Through the browser
  the row was retired anyway and the reward was destroyed — the bridge's direct commit dropped the row without
  ever asking whether the reward had been received. Two fixes: the bridge only retires a reward the game
  actually gave (`../spirectl` → `Sts2ActionHandler.RewardCommit.cs`), and the browser stops using the
  semantic action at all, so `NRewardButton` runs its own claim and its own refusal.
- **There is no "raw clicks can't press a hover-first widget" limit — that finding was falsified (Sep 2026).**
  The game's hover-first widgets only accept a press while they are focused, but Godot's Viewport focuses the
  control under the cursor *before* it delivers the press, so one ordinary full click at a resolved coordinate
  focuses and presses in the same frame: a live probe claimed reward rows cold, with no preceding hover and no
  press/release split, confirmed by resource deltas. The browser's two-step tap is a touch-UX choice (a phone
  has no hover, so the first tap shows what the second will commit), not a workaround for an input limit.
- **Do not measure reward activation on a rewards fixture.** A fixture-built reward set cannot be claimed by
  *any* path, and it fails looking exactly like input that never landed — that false negative is what produced
  the falsified finding above. Build a real reward screen instead: `sts2 --instance <n> dev console room
  Monster`, then `dev console win`. Full write-up in `.sts2/research/reward-real-input-probe-sep14.md`; summary
  in `.agents/memory/reward-button-focus-and-semantic-activation.md`.
- **Current semantic-action inventory in the browser client** — keep this list honest when it changes:
  | Action | Where | Status |
  | --- | --- | --- |
  | `claim-reward` | — | **removed** — reward rows are claimed by real input, so the game's own button runs its claim and its refusal |
  | `select-map-node` | `frontend/src/mirror/mapNodeTap.ts` | in use, awaiting the maintainer's call. Not a straight swap: it carries a travelable gate and injects the run-global map vote for synthetic host-local seats, which have no map screen of their own for raw input to land on |
  | `set-scroll-offset` | `frontend/src/mirror/MirrorApp.vue`, the eager-scroll absolute channel | in use, awaiting the maintainer's call. View state only — it moves a scroll container, it does not commit a player choice |
- Read-only spirectl surfaces — state reads, the scene stream, screenshots, inspection — are unaffected. This
  rule is about causing state changes.

## View scale
- Files: table `src/CouchCoop.MirrorProtocol/SceneModel/ViewScale.cs`, pure stamp index
  `ViewScaleStampIndex.cs`, native adapter `godot-client/src/Scene/ViewScaler.cs`, and web layout/input modules
  `frontend/src/mirror/{viewScaleLayout,viewScale,viewScaleInverse}.ts`.
- Matching scene identities receive a cosmetic scale stamp. The stamp index is rebuilt per drain and resolved in
  the single transform fold, with no cross-drain stamp memory. Nested stamps compose through the wire parent frame.
- Both web backends share `viewScaleLayout.ts`; the canvas draw-list carries the accumulated product instead of
  folding a scale into a global coordinate. Input is remapped against the corresponding stamped, rendered box.
  Hidden ancestry is excluded from the input registry, and a gesture freezes its claimed mapping on press.
- `mirrorSettings.uiScaling` is the viewer-facing readability setting for view scale, tip scale, text scale, and
  clip-axis outset. Changing it triggers a structural walk and restores or reapplies the stamped base transforms.
- Tests: `ViewScaleStampIndexTests.cs`, `ViewScaleStampReplayProbe.cs`, and web
  `viewScale.spec.ts`, `viewScaleInverse.spec.ts`, `viewScaleInputRegistry.spec.ts`, and `inputCapture.spec.ts`.

## HoverTip scale
- Files: `HoverTipScaleMath.cs`, `godot-client/src/Scene/HoverTipScaler.cs`, and web
  `hoverTipScaleMath.ts` / `tipScaleLayout.ts`.
- Tips scale and pivot from their visual owner. Both web stages use the same owner resolve and layout policy;
  the canvas folds the paint stamp into its draw-list product.
- Tip scaling is paint-only. The hit product excludes tip stamps, so tooltips do not alter the streamed hit
  surface of their children.
- Tests: `HoverTipScaleMathTests.cs`, `hoverTipScaleMath.spec.ts`, and `canvasTipScale.spec.ts`.
  `dumptips` reports the current owner boxes, spread displacement, and stamp.

## Wide-screen spread algebra
- Files: `src/CouchCoop.MirrorProtocol/SceneModel/SpreadIndex.cs` (anchor algebra + `ContainerHAlignFactor`),
  `PaintOrderTables.ClipRenderedAabb` (widened clip widths). Web twin: `visit()` in
  `frontend/src/mirror/mirrorRenderer.ts` (~L2100+, exact line drifts — grep `ParentDx` / `SpreadRecord`).
- Mechanism: when the mirror stage is wider than the game's native aspect (F≠1), containers redistribute the
  extra width; each node gets an absolute rendered `Dx`. Floaters and tips use their owner's `Dx`, not a second
  parent-chain addition. Full-width/background scene roots use a distinct scene-identity branch.
- **Identity-scoped centre claims:** a small 0/0-anchored widget the game
  positions relative to CENTRED content strands at a fixed distance from the stage's left edge, because it is too
  small for the `fullCanvas` seam (`localRect.width >= parentWidth - 1`). The fix is always a scene-identity match
  (scene FILE + scene-relative path, behind a cheap NAME pre-filter) forcing the 0.5 claim — NEVER a geometry rule,
  which would break every legitimate corner widget. Current members: `map_screen.tscn :: DrawingTools`,
  `main_menu.tscn :: ButtonReticleLeft/Right`.
- **`ContainerHAlignFactor` only knows BoxContainers** (`hbox-*` / `vbox-*` — the only `containerLayout` values the
  producer emits). A `FlowContainer`'s children therefore fall through to the plain anchor algebra. The MP lobby's player list is a
  `Godot.FlowContainer` (`character_select_screen.tscn :: RemotePlayerContainer/Container`, 518x354, anchors 0/1)
  with `containerLayout: null`, but it is NOT displaced — its parent `RemotePlayerContainer` is 0/0-anchored and
  hands the whole subtree a zero anchor budget, so every descendant takes the ride-rigidly branch instead.
- **The rendered box is the box.** An anchored span is laid out at `renderWidthOverride`, not at its
  streamed 1920-space `localRect.width`, so every read that asks "how wide is this element on screen" must use it:
  `ninePatch.ts`'s slice bands, `nodeStyles`' clip corner radius, and the plain nine-patch degenerate-margin test
  all took the streamed width and were fixed to take the rendered one (`nodeStyles.renderedWidth`). The native
  client was already correct here — `MirrorNodeView.EffectiveNode` hands every drawer a width-adjusted clone.
- Tests: `SpreadWalkTests.cs`, `SpreadMathTests.cs`. Web: `frontend/src/mirror/__tests__/mirrorRenderer.spec.ts`
  (floater/spread cases), `ninePatch.spec.ts` + `nodeStyles.spec.ts` (the rendered-width reads).
- Live capture: use a widened window (~2255×1080 or wider); desktop 16:9 verification is not sufficient.

## Crisp text (native Half render scale)
- Whole cards: `godot-client/src/Scene/CardLayer.cs` + `src/CouchCoop.MirrorProtocol/SceneModel/CardLayerPlanner.cs`
  (clip-contains relax under `CARDCLIP_RELAX`; reject order after relax: AncestorEffect/Blend/ZOrder →
  Invisible → UnknownBounds → Offscreen → MemberDynamic → Pass-B Occluded).
- Labels: `godot-client/src/Scene/TextOverlay.cs` + `src/CouchCoop.MirrorProtocol/SceneModel/TextOverlayPlanner.cs`
  (v3 clip relax, blocker-art tightening, tight single-line blocker extents).
- Debug envs: `TEXTOVL_DEBUG`, `CARDLAYER_DEBUG`, `TEXTRECTS` (reject histograms). `MemberDynamic` gates on
  `_unsettled` (a view's `TextureSettled`/similar flag). A texture that never resolves must not keep a card
  `_unsettled` forever; check `TextureStore` failure tracking
  before assuming a stuck reject is a clip bug.
- Tests: `CardLayerPlannerTests.cs`, `TextOverlayPlannerTests.cs`, `CrispTargetsProbe.cs`,
  `TextOverlayPlanProbe.cs`/`TextOverlayPlanBench.cs` (probes, not gating assertions — read before trusting
  their pass/fail as a contract).
- Live capture: QA `dumpcrisp` dumps per-card-root + per-text-candidate rejects, occlusion
  culprits, and unsettled/failed texture urls; QA `state` carries the aggregate reject histograms.

## Text metrics
- Files: `src/CouchCoop.MirrorProtocol/SceneModel/TextScale.cs` (font-size multiplier table, keyed by
  `SceneIdentity`, + wrap/line-spacing constants), `godot-client/src/Scene/TextBuilder.cs`
  (`ConfigureLabel`/`ConfigureRich`, `CenterRichVertically` deferred measure ≤2 retries,
  `GrowthCenterPlain` = box-top-anchored growth compensation — NEVER use raw `valign=Center` for
  growth-compensated labels, a documented HP-bar footgun). Web: `frontend/src/mirror/mirrorTextScale.css` (the
  documented values) + `textScaleClasses.ts` (the table both web backends read: resolved `mirror-ts-*` classes for
  the DOM, resolved DECLARATIONS for the canvas rasterizer).
- The readability master setting controls text scaling. The DOM toggles the generated
  `<style id=mirror-text-scale>` sheet, while the canvas resolves text declarations on the next build.
- Tests: `TextScaleTests.cs`. Web: `textScaleClasses.spec.ts`, `uiScalingSwitch.spec.ts` (U4, the sheet flip).

## Animated rich text (the game's bbcode effect tags)
- The game's wavy / shaky / bouncing tags reach the browser VERBATIM — the game leaves the markup in the label's
  string and skips the per-character transform instead — so the mirror both renders them and gates them itself.
- Ownership, and none of it is repo-local CSS: the three animated STS2 tags and their keyframes are
  `@spirectl/presentation`'s (`render/bbcodeTags.ts` + `render/richTextEffects.ts`), and Godot's own built-ins
  (`[rainbow]`, `[shake]`, …) are godot-scene-web's (`packages/html/src/base-css.ts`). This repo supplies the
  `ensureRichTextEffectStyles(document)` call at each rich-element mount (`renderer/dom/subLayers.ts`,
  `canvas/overlay.ts`) and one attribute on `.mirror-stage`.
- The gate is the game's **Settings → Text Effects**, streamed on the `session` envelope
  (`BrowserEnvelope.TextEffects` ← `CouchCoopGamePrefs`), adopted by `adoptGameTextEffects` and stamped as
  `data-spirectl-text-effects`. Adopted on EVERY envelope, NOT once per connection like the freezes beside it —
  it is game truth with no panel control, so there is no viewer edit for a re-read to stomp, and re-reading is
  what makes a mid-run toggle reach a phone already watching (the host re-sends a session envelope on a screen
  change — `ResendSessionsIfSceneScreenChanged`). It gates exactly the two tags the GAME gates; the shaky one and
  the built-ins keep animating with the setting off, because they do in the game too.
- DOM only. On `?stage=canvas` a custom effect tag passes through FLAT (`canvas/richSimple.ts`): the stage bakes
  rasters and cannot move one, and the effect displaces characters rather than changing them. gsw's built-in
  effects still refuse there (they sweep colour), so those labels keep a DOM overlay element and animate.
- Tests: `richTextEffects.spec.ts`, `canvasRichSimple.spec.ts`, `TextEffectsEnvelopeTests.cs`; the rules
  themselves in `spirectl/presentation/web/test/richTextEffects.test.ts` and gsw's `html.test.ts`.

## Spine clip pipeline
- Files: baked clips served at `/spines` (producer, `../spirectl`), keyed
  node→anim→skin→skeleton→policy→version (absent response = byte-identical to game). Native store:
  `godot-client/src/Scene/SpineClipStore.cs` (one-shot escalation: `&retry=1` on a collapsed result; loops wrap at
  `frames[last].StartMs`). Web: `frontend/src/mirror/spineClip.ts`.
- Still swaps decode a fresh bitmap before replacing the displayed one. `record.spineShownStill` retains the
  clip an `<img>` is displaying, independently of the requested clip, so cache eviction cannot invalidate it.
- A spine node with both a still and an effect surface receives `.mirror-spine-promoted` to avoid subtree paint
  culling on high-DPR browsers.
- Clip cache: two LRU pools hold decoded clips and encoded still bytes. Terminal animations release earlier
  clips for that creature; a plain DOM exit does not reclaim a living creature's clip.
- Tests: `SpineClipTests.cs`, `SpineWireFieldsTests.cs`, `spineClip.spec.ts`, `spineMount.spec.ts`, and
  `spinePaintCull.spec.ts`. `scripts/probe-spine-still-flicker.mjs` is the live blank-frame probe.
- Headless hosts freeze Spine and particle simulation; browser clients render from the baked representation,
  not a live per-frame spine stream.
- Producer-only diagnostics and capability controls remain owned by `../spirectl`: `SPIRECTL_SPINE_DEBUG`,
  `SPIRECTL_SPINE_CLIP_SKIN_UNION`, `SPIRECTL_SPINE_CLIP_DOWNSCALE`, and `SPIRECTL_SPINE_SETANIM_HOOK`.
  They do not create alternate browser wire contracts.

## Particles
- Files: `godot-client/src/Scene/Effects/ParticleAttachment.cs` and
  `frontend/src/mirror/particleAttributes.ts`; the web runtime is reconciled by its normalized spec signature,
  and `_epoch` re-triggers one-shot bursts.
- Coverage is selected from the shader contract, not inferred from texture alpha. Normalization supplies the
  required coverage, UV, erosion, and mask fields before the reusable web renderer consumes the spec.
- Headless hosts may freeze a one-shot while its producer state still appears active. The producer retires the
  burst at its natural end and the web renderer also expires the frozen one-shot after its active window, without
  caching a stale static frame. Looping emitters remain producer-owned.
- Tests: web `frontend/src/mirror/__tests__/particleAttributes.spec.ts`, `particleMount.spec.ts`; gsw
  `../godot-scene-web/packages/html/test/particles-coverage.test.ts`,
  `../godot-scene-web/packages/html/test/particles-oneshot-expiry.test.ts`; mod
  `tests/CouchCoop.Mod.Tests/HeadlessParticleFinishNudgeTests.cs`. Visual gate:
  `scripts/probe-particle-vfx-replay.mjs` (see qa-recipes §5). Wire probe for latched flags:
  `scripts/probe-mirror-spine-particles.mjs`.

## Transforms / tweens
- Files: `godot-client/src/Scene/SceneReconciler.cs` (`LocalXform` holds a node's local transform for
  already-placed views; composition remains local and has no global-transform fallback; diagnostic `TRANS_DEBUG`),
  `godot-client/src/Scene/Effects/TweenReplayer.cs` (replays the game's REAL streamed tween hints — this is
  NOT client-authored interpolation; lever `TWEEN_DEBUG`). Death-VFX composes a 2×
  supersampled `SubViewport` in the producer.
- **Godot easing → CSS timing function** lives in `../godot-scene-web/packages/html/src/easing.ts`
  (`godotEasingToCss`, consumed by `applyTweenHints`) — NOT in this repo. It is the single reason a replayed tween
  can have the right duration and still feel wrong: the polynomial/trig `trans` family
  (Sine/Quad/Cubic/Quart/Quint/Circ) fell through to the generic `ease-*` curves, and Godot's QuintOut has covered
  97% of the travel at the half-way point where CSS `ease-out` has covered 68% (max deviation 0.388 of the
  distance). The shop's 700ms Quint/Out open slide therefore looked ~2× slower in the mirror than in the game. Each
  family now maps to its Penner cubic-bezier fit, and an ABSENT `trans` maps to `linear` (Godot's
  `Tween::default_transition` is `TRANS_LINEAR`; a missing `ease` still selects the in-out column). Bounce/Spring
  have no cubic-bezier form and keep the `ease-*` fallback. A twin of the same function still lives in
  `../spirectl/presentation/web/src/render/interactivity.ts` (presentation's own renderer; NOT on the mirror path) —
  it has not been updated.
- **A HINT IS ONE-WAY: a producer cancel is NOT a client abort.** A producer cancellation
  (`CancelTweenSuppression`) collapses the node's suppression window and resumes streaming — that un-pins the
  PRODUCER. The client keeps replaying the endpoint until its own deadline, because there is no wire field that
  says "forget the hint I sent you". Two consequences, both load-bearing:
  - **Client (`pinTween`/`tickTweens`)** — while the pin overrides a streamed transform, the
    renderer stashes the value it overrode and APPLIES it at the settle (instantly, transition already cleared)
    instead of dropping it. It only replays a value that CHANGED since the arm: a suppressed node ships no
    transform at all, so its retained pre-tween matrix must never be mistaken for a fresh pose and replayed —
    that would teleport the node back to where the approach started. Without this, every delta that landed
    inside a pin was lost permanently.
  - **Producer** — a hand batch whose natural duration falls under the publish floor still publishes, at
    `MinHintMs`, whenever the holder's window is still open (`Sts2HandTweenMath.CorrectiveDurationMs` +
    `Sts2RuntimeSceneWatcher.HasOpenTransformWindow`). "Publish nothing and cancel" is only safe for a node
    nobody is pinned to.
  This preserves a re-focused card and settles it at the game's pose.
- **A tween endpoint is placed on the wide-screen field at the endpoint's own X.** On a wider-than-16:9 stage a node that claims its own place on the horizontal squeeze field
  shifts by a function of its own rendered X; the walk stores that shift per node (`record.spreadDx`) from the
  node's CURRENT pose, and the producer then freezes that pose for the hint's whole window. Composing an endpoint
  with the stored shift therefore landed a hand approach at `endX + startX·(F−1)` and SNAPPED at the settle
  re-emit. `spreadDxAtGlobal` re-evaluates the same field formulas (`fieldDxAtOriginX` / `fieldDxAtCenter`, shared
  verbatim with `computeSpread`) at the endpoint, for the two modes whose claim IS their own X —
  `record.spreadFieldMode` 1 (pass-through group) and 2 (positional claimer, centre-based, endpoint basis included).
  Everything else (riders, the anchor algebra, owner-anchored floaters, remote followers) is mode 0 and keeps the
  walked shift. F = 1 skips the whole composition and is byte-identical.
- **Focus-change teleports supersede same-frame re-targets of the same channel producer-side (see spirectl
  `Sts2HandTweenMath`).**
- **Hand-card parity gauge** (`?handParity=1`, off by default): every transform settle records where the client's
  replayed tween ended versus where the game says the node is, into `window.__mirrorHandParity` (id, path, dx/dy,
  drift px, capped with a dropped-count). `scripts/bench-mirror-replay.mjs --hand-parity` turns that into a
  per-repeat settles/drifted/maxPx line plus the worst offenders — the A/B instrument for "cards jump at the end
  of a transition". Drift should be 0.00.
  - **Post-settle snaps** (`postSettles`/`snapped`/`maxSnapPx`, same gauge object and entry cap, entries tagged
    `kind: "post-settle"`). The drift measure compares the endpoint against what the producer streamed WHILE the
    pin was up, so a node suppressed for the whole window scores 0 however wrong the endpoint was. Each settle
    therefore also arms a ~500ms watch, and the FIRST streamed transform to reach `pinTween` after it is compared
    against the value the element was left at — which is the jump you actually see. A genuine game-initiated move
    inside the watch counts too, so read it as a trend, not a verdict.
- Tests: web `frontend/src/mirror/__tests__/mirrorTween.spec.ts`, `viewScaleTweenStamp.spec.ts`;
  `../godot-scene-web/packages/html/test/easing.test.ts`; producer
  `../spirectl/bridge-mod/tests/Spirectl.BridgeMod.Tests/Sts2HandTweenMathTests.cs`.

## Producer / wire contracts
- Producer lives in `../spirectl` (`bridge-mod`), NOT this repo — this repo owns only the CouchCoop-specific
  DTOs/browser envelope on top of it (see CLAUDE.md architecture rules; do not add reusable-STS2 shims here).
  Node change classification: `src/CouchCoop.MirrorProtocol/SceneModel/NodeChangeFlags.cs`,
  `MirrorDelta.cs`. Scene-identity keying: `SceneIdentityCache.cs`. Static-bake pipeline (background
  flattening): `StaticBakePlanner.cs` / `BandResidencyMachine.cs`.
- Web parse/apply/reconcile: `frontend/src/mirror/mirrorRenderer.ts` (the reconciler — an incremental
  structural-walk + hover-memo engine, not a naive full re-walk every drain).
- Tests: `NodeChangeDifferTests.cs`, `SceneDeltaParseParityTests.cs`, `RecordingReplayTests.cs`,
  `RoundTripFixtureTests.cs`, `WireDefaultsTests.cs`, `BandFlattenPlannerTests.cs`, `BandOrderingExactTests.cs`,
  `StaticBakePlannerTests.cs`. Web: `frontend/src/mirror/__tests__/mirrorRendererIncremental.spec.ts`,
  `roundTripFixture.spec.ts`, `structureDiff.spec.ts`, `wireDefaults.spec.ts`.
- Perf: see `docs/mirror-combat-bench.md` (record/replay bench, already in this repo) before re-deriving a
  benchmark methodology from scratch.
- **Decorative-animator folds (why an "idle" screen is not a quiet screen).** Several always-mounted STS2 nodes
  run an INFINITE per-frame animator whose only output churns the wire. The producer folds each one ANALYTICALLY
  (divide the churning channel back out / substitute the loop's own rest value) and the client replays it, either
  from a static path table (`frontend/src/mirror/animAttributes.ts`'s `nodeAnimBinding` — orb spin, intent bob,
  flame flicker) or from a per-node `pinnedLoopAnim` token the producer names on the wire (`pinnedLoopBinding` —
  map pulse, the three top-bar icons, proceed glow, end-turn glow). Producer switches live in `../spirectl`
  (`SPIRECTL_DECOR_EMIT_SUPPRESS` master + `SPIRECTL_{TOPBAR,PROCEED,MAPPOINT,INTENT_BOB,INTENT_GLYPH,ORB_SPIN,
  ENDTURN_GLOW}_FOLD`). Do not pin one of these to a first-seen sample: a pre-layout pose can be frozen forever
  and an unbounded accumulator can strand at a random angle.
- **A replayed loop must not need a JS wakeup.** The enemy-intent glyph cycle runs on the compositor as an N-cell
  strip using `translate` and `steps(N)` (see `frontend/src/mirror/intentStrip.ts`). The `<img>` carries the same strip and `steps(N)`
  animation; the strip is composed and PNG-encoded in the ATLAS BAKE WORKER (a `strip` job = N cells of one page →
  one blob, `atlasBakeWorker.ts` / `bakeAtlasStripInWorker`) and memoised for the session on the whole set
  (`atlasStripKey`: animationName|fps, every cell's page+rect, the cell box), so a repeat intent is a pure cache
  hit. Worker-only by design — a multi-page set or worker failure falls back to the strip
  CANVAS, because the inline composition IS the mechanism the worker job replaces. After: 0/0/0/0 on the same idle
  window, with the cycle owned by `ActiveTranslateAnimation`. Gate: `scripts/assert-idle-compositing.mjs`.

## Wire invariant: `orderedIds ⊆ nodes the client holds`

- **The rule.** Every id in a scene delta's paint order must name a node the client actually has state for. Both
  clients pick a STRUCTURAL walk purely on "the order array reference changed" (`state.orderedIds !== lastOrderedIds`
  in `mirrorRenderer.reconcile`); an `update` walk never runs `rebuildStructure`. So if an id is already in the order
  when its node's FIRST upsert arrives, that upsert carries no order change, the node is merged into the retained map
  and **never placed in the tree** — invisible until something else happens to touch the order. A browser reload
  "fixed" it because a fresh keyframe carries node + order together.
- **How it was broken.** The producer registers a subtree born HIDDEN but prunes it from every incremental capture
  (`if (!full && !read.Visible) skipDepth = …`), so those ids rode `OrderedIds` with no upsert behind them. Two
  user-visible symptoms, one seam: treasure relics missing after the chest opens, and the targeting arrow's 19
  segments missing on the first select after a game restart (a restart re-keyframes at the MENU, so the run's
  hidden-at-birth nodes are never in a keyframe). It also silently disabled the compact order patch — `SceneOrderDiff`
  self-verification cannot reconstruct an order containing ids the structure index skips, so every structural send
  fell back to the full ~52KB array.
- **Three layers hold it:**
  1. producer — `OrderedIds` carries only ever-emitted nodes AND a node's first emit re-ships the order
     (`../spirectl` `Sts2RuntimeSceneWatcher`);
  2. host — `CouchCoopSceneObserver.BuildKeyframeContents` drops order ids the keyframe has no node for
     . Stubs are not an option: the host doesn't know a never-received id's
     parent, so a stub would enter as a nameless orphan root;
  3. client — a delta that INTRODUCES a node id without touching the order re-derives the structure
     (`sceneTree.applySceneDelta`).
- **Probe**: `node scripts/probe-keyframe-order-integrity.mjs .sts2/bench/*.ndjson` — offline, asserts the invariant
  on any recording and exits 1 on violation.
- Tests: `frontend/src/mirror/__tests__/mirrorLateNode.spec.ts`,
  `tests/CouchCoop.Mod.Tests/CouchCoopSceneObserverTests.cs` (keyframe self-consistency).

## Spine stills: paused tracks

- A still bake samples the MIDDLE of a clip (`Sts2SpineStillFrame.ChooseSampleTime`; last frame for die/defeat). That
  is a guess, and it is wrong for a track the game has explicitly PAUSED — the treasure chest's only clip is named
  `animation` (the lid opening) and a chest that has not been opened is held at its first frame, so a CLOSED chest
  rendered a half-open lid.
- The mirror pins `&t=<seconds>` (the streamed `spineTrackTime`) on a still url for a `spinePaused` node, and that
  time is part of the CLIP IDENTITY — which is also the re-fetch trigger, because opening the chest changes nothing
  else about the node (same anim/skin/mat/skel). Quantized to 2 decimals on BOTH sides (it is a cache key).
- Files: `frontend/src/mirror/spineAttributes.ts` (`spineStillTime`), `mirrorRenderer` clip identity,
  `CouchCoopSpineClipProvider.BuildSpineKey`/`FormatStillTime`, `CouchCoopBrowserServer.TryMintSpineClipKey`,
  `../spirectl` `Sts2SpineStillFrame` + `SpineClipRequest.StillTime`.
  Asset-cache invalidation is `SpirectlAssetBinaryCache.SchemaVersion`, derived from
  `SpirectlSts2Runtime.AssetPayloadVersion`; spirectl owns that version.

## Spine: never present a pose the game did not play

- **A one-shot is never guessed.** `Sts2SpineDefaults.PickDefaultAnimation` returns `null` when every candidate is
  a one-shot (`DefaultAnimationLoops` false). A node with no applied animation is not a clip node.
- **A finished lone one-shot RESTS at its end.** `Sts2SpineSchedule.ResolveScheduledAnim` reports a non-looping head
  with no queued `nextAnim`, past its duration, as PAUSED at `currentDurMsec` — which routes through the
  paused-still plumbing above with no client change and, because the pinned `&t=` is CONSTANT, mints one stable
  bake instead of one per tick. `currentDurMsec == 0` remains unpinned because its duration is unresolved.
- **Unanimated one-shot nodes remain blank.** A node with no applied animation and only one-shot clips must not
  receive an invented mid-animation still.

## Web mirror twin structure
- The whole live-tree mirror client lives under `frontend/src/mirror/` (Vue app `MirrorApp.vue`/`MirrorView.vue`,
  entry `mirrorClient.ts`). It is a from-scratch TS reimplementation that mirrors the native godot-client
  module-for-module (same file names appear in both "Files" lists above). When fixing one client, check whether
  the corresponding twin needs the same change.
- `frontend/src/mirror/nodeStyles.ts` / `sceneTree.ts` / `structureDiff.ts` are the DOM-side equivalents of the
  native `MirrorNodeView`/`SceneReconciler` pair.
- Ambient `@spirectl/*` type declarations consumed by the frontend are a HAND-MAINTAINED shim, not
  auto-generated — a new spirectl export needs a matching hand-added declaration or `vue-tsc` fails TS2305
  (check the shim file under `frontend/` if a spirectl type import goes red).

## Join state in the page URL (`?name=`)

- Written ONLY by the browser — the host never reads the param (`CouchCoopHttpRequest.Name` is dead code), which
  is what makes an EMPTY value usable as a client-side marker.
- THREE states, all of them in `frontend/src/join/joinModel.ts`: absent (`/`) = picker, empty (`/?name=`) = the
  host player's own browser (a multiplayer direct view), value (`/?name=Ann`) = **seat intent** — auto-join that
  seat, and until it is granted behave as a player waiting for a game, not a spectator (see the two rules below).
  `readUrlName` trims the empty form to null, so it CANNOT tell absent from empty — use `hasNameParam` /
  `readUrlNameState` (and `urlNameStateFor` for a value you are about to write).
- **Seat intent (`?name=<value>`).** Two consequences, both client-side because the host never sees the
  param: (1) the stream gate is SHUT until the seat is actually granted (`shouldWatchHostStream`'s `seatIntent`
  argument — see the watch-gate section); (2) on a screen the host says has no seat, MirrorApp renders
  `mirror/MirrorHostWaiting.vue` in the picker's place ("Waiting for host to start game" + "Control host"). The
  screen test is `isNonJoinableMirrorMode(mode)` — true for `main-menu | sp-character-select | singleplayer-run |
  unsupported`. MirrorApp holds the live answer in `urlSeatName` (a ref) + `urlSeatIntent`
  (derived), updated through ONE helper (`rememberUrlName`) shared by `setUrlNameParam` and the
  `onHeadlessRedirect` stamp — drift there = a viewer whose seat ended silently regains the host's stream.
- `maybeAutoJoin` waits for the FIRST `session` before firing (it used to fire on socket open, which is before
  anything is known about the host's screen) and re-checks the screen on every one, with the non-joinable guard
  ABOVE the `autoJoinSent` latch: the guard is "not yet", so the single attempt is still there to spend when the
  host reaches a multiplayer screen. `maybeRequestDirectView` is suppressed under seat intent — the `directView`
  grant it asks for is the gate's FIRST branch and would hand a waiting player the host's solo run.
- "Control host" (`onControlHost`) is the only writer of the empty marker on a NON-multiplayer screen: it pushes
  `?name=` and forces a reload rather than unwinding in place, because most of this app's setup is URL-keyed and
  read once. `onDirectView`'s stamp stays multiplayer-only.
- One writer for both clients: `writeUrlNameParam(value, "push"|"replace", {history, location})`. Everything
  PUSHES (a join is a navigation the player must be able to reverse); `replace` is only for silently dropping a
  marker nobody navigated to. Its equality guard is load-bearing — the auto-join path re-stamps the name it just
  read out of the URL.
- Callers: `rememberJoinedName` (mirror, on `onHeadlessRedirect`) and MirrorApp's `setUrlNameParam` for the
  host marker. The marker is stamped only when
  `isMultiplayerMirrorMode(mirrorMode)` AND no param is present — an existing `?name=<value>` that produced the
  direct view is left alone (it already reloads to the same view and may be a shared link; e2e `smoke.spec.ts`
  "preserves join URL usability with query params" is the regression gate).
- BACK/FORWARD is a full `location.reload()` (`MirrorApp.handlePopState`), fired only when the URL's param state
  differs from the one the page holds (`shouldReloadForUrlNameChange`) — that inequality IS the loop guard. A
  reload is the only reset consistent with every module's lazy `window.location` read; do not hot-unwind the
  joined socket instead. MirrorApp's ONLY prop, `reloadPage`, exists because jsdom cannot stub `location.reload`.
- On load, an empty `?name=` re-takes the host view itself (`maybeAutoHostView`, the twin of `maybeAutoJoin`):
  it waits for a multiplayer roster, then submits the [Host] row exactly as a tap would. A multiplayer roster with
  no host row keeps the marker and stays unlatched: the
  empty marker is the durable "I am the browser controlling the host", and a host-less roster is usually just one
  that has not caught up, so deleting it cost the host player their own view for the rest of the session.
- Tests: `frontend/src/join/__tests__/joinModel.spec.ts` (states, writer, reload matrix, `seatIntent` +
  `isNonJoinableMirrorMode`), `frontend/src/mirror/__tests__/mirrorJoinUrl.spec.ts` (the wiring, through the real
  component, including the seat-intent matrix), `frontend/src/mirror/__tests__/mirrorHostWaiting.spec.ts` (the
  waiting screen's copy + emits). Live:
  `scripts/probe-join-url-flow.mjs <host|seat|solo>` drives a real host and logs URL + `history.length` + screen
  state per step.

## A join must fail visibly

A join that goes wrong on the host has to reach the picker. It did not: the mirror client ignores
`action-result` outright (`mirrorClient.ts` — the host answers a semantic action with one and nothing reads it),
while the receive loop answers ANY faulted message with exactly that envelope. So a shipped
`KeyNotFoundException` inside the join handler was delivered, discarded, and the viewer watched "Joining…"
forever with nothing in `godot.log` either. Three independent defences now, deliberately layered because only
the first needs the host to cooperate:

1. **Server converts its own throw.** The mirror-join decision block (`CouchCoopWebSocketConnection`, from the
   headless-manager branch through the secure-port resolution) has its own `try/catch`, filtered on
   `!cancellationToken.IsCancellationRequested` so shutdown is not reported as a join failure. It logs
   host-side and sets `joinRejection = "join-failed"` + `JoinRejectionDetail = ex.Message` — the channel the
   client already treats as TERMINAL. `BrowserStateEnvelopeFactory` drops a detail with no rejection to hang it
   under, and the pre-existing "a refused join must not also report itself joined" guard covers the new code for
   free. The outer catch also now reports the INBOUND `requestId` instead of minting a fresh GUID.
2. **Client `action-result` backstop.** `onActionError` fires only while a join is outstanding (`joinPending`,
   set by `sendJoin`, cleared by whichever session directive resolves it and on close), so a refused map-node
   vote can never clear the form. Handled ABOVE the `watching` gate — a viewer on the picker has the scene
   stream OFF, which is exactly when this must work. This is the layer that makes the whole class of bug
   non-silent without anyone remembering to convert a new throw.

   **`action-result` has a second reader, and the ordering is load-bearing.** Scroll
   authority reads a successful `set-scroll-offset` result for the clamped offset it carries (`readScrollAck`).
   It is placed strictly BELOW this backstop and matches only results with no `code`, so the backstop keeps
   FIRST REFUSAL on every error-carrying envelope — which is the whole property above. Anything added here
   later must take the same position: this envelope's error path belongs to the join, and a reader that
   swallows one is the original bug returning. `scrollAuthorityClient.spec.ts` pins it with a scroll-shaped
   fault during a pending join.
3. **90s client timeout** (`JOIN_TIMEOUT_MS`, armed by a `watch` on `pendingName` so all six resolution paths
   disarm it). Clear of the host's own 60s spawn deadline (`HeadlessClientManager.WaitForReadyAsync`) so a cold
   seat that is merely slow is never failed; this only catches a host that answers nothing at all.

**A throwing launcher used to leave the slot bound.** `EnsureHeadlessAsync` sets `_sessionToSlot[sessionId]`
BEFORE `_launcher(slot)`, and only the null-RETURN path undid it — so after a throw the viewer's retry
short-circuited to `return SlotToPort(slot)` and was redirected to a port with nothing listening, which is worse
than the failure it retried. The launch is now wrapped so a throw unwinds identically, then rethrows.

**A seat's browser port is assigned, not preferred.** `SlotToPort(slot) = 13337 + slot*10` is what the host
hands the browser AND what it probes for readiness, so a seat that walked off that port served an address nobody
would ever ask for — the join burned the 75s deadline while the seat was healthy one port up. Four parts, all in
`Session/`:

| part | mechanism | files |
| --- | --- | --- |
| pre-spawn survey | before `_lock` (same rule as `MaxSlot`), each candidate seat port gets a loopback **connect** plus a test **bind**; either answer means occupied. A bind test alone is not enough — under `SO_REUSEADDR` a bind to `0.0.0.0:P` succeeds while a squatter on `127.0.0.1:P` still owns loopback. A probe that TIMES OUT reports free: dropped ≠ owned | `SeatPortAvailability.cs`, `HeadlessClientManager.SurveySeatPortsAsync` |
| skip, or fail fast | a brand-new player is routed to a slot whose port is free (`AllocateSlotForNewNameLocked`). A PINNED seat — a `targetNetId` rejoin, or a returning name whose claim is its identity in the host's run — cannot move, so it fails immediately with `seat-port-taken` instead of spawning | `HeadlessClientManager.cs` |
| the seat may not walk | `HeadlessSeatPortGuard.Bind` walks for a HOST and binds exactly for a SEAT, gated on `CouchCoopMod.IsHeadlessClient`. The host's walk is load-bearing (several instances per machine; `scripts/lib/instance-port.mjs` reads `BrowserPortFile`). A seat that cannot bind reports `couchcoop-seat-port-unavailable` and force-exits, `HeadlessSeatBuildGuard`-style | `HeadlessSeatPortGuard.cs`, `Server/HotReloadableBrowserServerHost.cs` |
| the backstop | the seat reports its REAL bound port on the authenticated heartbeat (`HeadlessConnectionStatus.BrowserPort`; `0` = not bound yet, never a disagreement). Any disagreement with `SlotToPort` fails with `seat-port-taken` rather than handing the browser a port nothing serves | `Connections/HeadlessConnectionControl.cs`, `HeadlessConnectionReporter.cs` |

Tests: `-- seats` and the default leg (`SeatPortTruthTests`), including the detection probe against a real
blackhole listener.

Tests: `BrowserServerRouteTests.AssertJoinFaultReachesTheViewerAsync` drives the whole thing over a real socket
with a throwing launcher (the manager's launcher delegate is the seam, and it is where the real bug lived) —
including the retry leg, which is what found the slot leak. Plus `AssertJoinRejectionDetailPlumbing` (wire
fields), `frontend/src/mirror/__tests__/joinFailure.spec.ts` (all three defences through the mounted app) and
the `mirrorClient` specs in `frontend/src/__tests__/mirror.spec.ts`.

**Real-browser repro:** `dotnet run --project tests/CouchCoop.Mod.Tests -- join-fault-harness <staticRoot> [port]`
serves the REAL browser server with a throwing launcher, so a browser pointed at it takes the whole path and
renders the failure. Point `<staticRoot>` at the DEPLOYED SPA (`<game>/mods/couchcoop/frontend`) to photograph
the shipped bundle. **Gotcha:** it must arm `CouchCoopHeadlessVisualSuspender._baselineMaxFps`/`_baselineCaptured`
by reflection first — otherwise every `session` build hops to the Godot main thread for the real MaxFps, and in a
runner with no native Godot that is a **SIGSEGV that kills the process silently on the first WebSocket** (exit
139, nothing logged). The suite only survives because `HostPerformanceEnvelopeTests` runs first and leaves those
statics set; any new standalone host of this server needs the same two lines.

## Mirror stream gate (`watch`)
- Product rule: a viewer must NOT have the host's game streamed (or rendered) behind the join picker while the
  host has multiplayer active — lobby, saved multiplayer game, or multiplayer run. It streams only once the
  viewer chose a seat (`joined`) or the host itself (`directView`), or when the host is off the multiplayer
  screens entirely.
- The decision is CLIENT-side and shared: `JoinModel.ShouldWatchHostStream` / `shouldWatchHostStream`
  (`frontend/src/join/joinModel.ts`) — the same predicate both clients use to decide whether to show the scene,
  so wire and screen can't disagree.
- **`seatIntent`** ("this page's URL names a seat"; see the `?name=` section) is required in
  both twins so neither client can forget it, and its POSITION is the contract: strictly BELOW `joined ||
  directView` (a granted view outranks a URL marker — the URL still names the seat after the host serves it, so an
  arm above these would black out every joined viewer) and ABOVE everything else (a title-only host screen must no
  longer open the gate for a viewer that named a seat). The native client has no page URL and passes
  `seatIntent: false` (`godot-client/src/App/ConnectionCoordinator.cs`, which is NOT in `CouchCoop.sln` — build
  `godot-client/CouchCoop.GodotClient.csproj` explicitly after touching this signature).
- Wire: the initial value rides the complete canonical connection query because only the query is known early
  enough to suppress the host's connect-time keyframe; later flips ride `{"type":"watch","on":bool}`.
  Tooling must send all five selectors, including `watch`.
- Host: `CouchCoopWebSocketConnection.SetSceneStreamingAsync` — OFF drops the coalescer (pending upserts AND
  `_lastSentOrder`; a patch diffed across a gap renders as a scrambled tree, not an obvious failure); ON re-runs
  the connect sequence in order (reset → open gate → register as streaming → FULL keyframe → release the pump).
- CPU: `CouchCoopBrowserServer._streamingMirrorConnectionCount` — not the connection count — drives the scene
  observer, so the producer's whole-tree walk stops while every viewer is on the picker. Conversely a GATED
  mirror keeps the (cheaper) STATE observer alive, because `RebroadcastSessionsIfRosterChanged` is the only
  source of `session` re-sends on a mirror-only host — without it the gate would latch shut. The streaming path
  additionally re-sends sessions on a screen change seen in the scene delta
  (`ResendSessionsIfSceneScreenChanged`), which is what closes the gate when the host ENTERS a multiplayer screen.
- Tests: `BrowserServerRouteTests.AssertSceneStreamGateAsync` (+ `AssertMirrorOnlyHostKeepsSessionsLiveAsync`),
  `SceneDeltaCoalescerTests.ResetDropsPendingAndOrderBaseline`, `JoinModelTests.ShouldWatchHostStreamGate` (incl.
  the `seatIntent` block), `frontend/src/mirror/__tests__/mirrorClientWatch.spec.ts`, and the seat-intent leg in
  `frontend/src/mirror/__tests__/mirrorJoinUrl.spec.ts` (asserts what is actually on the wire: the last
  `{"type":"watch"}` flip, or the connect query when there is none).

## Host transport

A normally-created multiplayer session is the game session, and couch seats ride alongside it.

- **`Session/DualNetHost.cs`** — `internal sealed class DualNetHost : SteamHost`. One `NetHostGameService`
  drives a Steam lobby AND a parallel ENet host at once. It must derive from `SteamHost` (not `NetHost`) —
  base it on the plain host type and the in-lobby **Invite** button stops appearing. Sends route by side
  membership (`ConnectedPeerIds`); an UNKNOWN peer goes to the ENet side, never Steam, because the Steam send
  path is fatal for a peer it does not know while the ENet one only logs.
  The inner ENet host gets a `SideHandler` shim so `StopHost` cannot fire `OnDisconnected` twice.
- **`Session/CouchCoopHostTransport.cs`** — statics (`HostNetId`, `EnetAvailable`, `SteamLobbyId`, `IsDual`) +
  `StartHostAsync`. Steam OK → dual host; Steam failure → silent fallback to a
  plain ENet host (logged EResult, no popup). A double failure is never swallowed.
- **`Patches/CouchCoopHostTransportPatch.cs`** — Harmony PREFIX on `NetHostGameService.StartSteamHost(int)`
  (a postfix is too late: by then a plain Steam-only host is already up).
- **Behaviour matrix**: Steam online → friends-only Steam lobby + side ENet host; Steam uninitialized →
  plain ENet; Steam init-but-offline → silent ENet fallback, and the QR dialog raises a
  "Steam offline" notice via `CouchCoopHostUiNotices`.
- Slot cap is REAL: `slotId` is serialized in 2 bits, so 4 players INCLUDING the host, shared between Steam
  remotes and couch seats (`CouchCoopLobbyParticipation.MayLaunchNewHeadless` carries the free-slot guard).
- **Tests**: `tests/CouchCoop.Mod.Tests/HostTransportCapacityTests.cs` (the `Priority.Last` ordering and the
  capacity decision, offline) and `tests/scenarios/steam-host-join.sts2.yaml` (the only automated seat join
  that takes the **Steam** branch — every other join test takes the ENet one, where `HostNetIdPatch` is inert
  because `hostNetId == 1`). The probe grades the branch from the `host-transport` log lines below and fails
  rather than degrade to ENet; see [qa-recipes.md](qa-recipes.md) §6 "A new game build".

### Headless seat launch contract (no CLI args)

`HeadlessClientManager.LaunchReal` spawns seats with `--headless` and NOTHING else. Everything travels in the
environment, and `Patches/CommandLineOverridePatch.cs` re-materializes `fastmp=join` + `clientId` INSIDE the
seat process (prefixes on `HasArg`, `TryGetValue` and `GetValue`), so the game drives its own join.

Verified live on a running seat (`/proc/<pid>/cmdline` is exactly `SlayTheSpire2 --headless`):

| env var | example | meaning |
| --- | --- | --- |
| `COUCHCOOP_HEADLESS_CLIENT` | `1` | turns the override table on; also selects the windowless mod branch |
| `COUCHCOOP_CLIENT_ID` | `1002` | the seat's netId (1000 + slot) |
| `COUCHCOOP_HOST_NETID` | `1` | host's real netId; `Patches/HostNetIdPatch.cs` rewrites `ENetClient.HostNetId` when this is not 1, or heartbeat replies would throw every 200ms |
| `COUCHCOOP_JOIN_HOST` | `127.0.0.1:33771` | explicit direct-connect host, honoured by any modded client |
| `COUCHCOOP_HEADLESS_SLOT` / `COUCHCOOP_PREFERRED_PORT` | `2` / `13357` | per-slot user dir + browser port |
| `COUCHCOOP_HOST_MOD_BUILD` | `1.0.0+<sha>` | the HOST's own mod build; a seat whose build differs reports and exits at mod init |

### When a seat gets no user dir of its own

`HeadlessUserDirSeeder.Prepare` repoints `XDG_DATA_HOME` (Linux) / `APPDATA` (Windows) at a per-slot directory.
On macOS Godot has no equivalent data-root variable, but it does resolve the custom `user://` under
`$HOME/Library/Application Support/SlayTheSpire2`. The launcher makes `HOME` the slot base and builds a
non-recursive fake-home farm: it links every other entry from the real home, retains real `Library` →
`Application Support` → `SlayTheSpire2` ancestors, and seeds that final private directory normally. This keeps
Steam reachable without turning a recursive walk into an ancestor cycle. CI proves the farm and stock Godot's
`HOME` behavior, but no full game session has yet run on a Mac; Steam, FMOD, or `getpwuid` consumers may still
escape `HOME`.

If this preparation fails, the launcher falls back to the host profile, passes the seat an explicit `--log-file`,
and raises `host-seat-profile-shared`. That warning is a genuine fallback on every platform, not the normal
macOS path.

`HeadlessHostWatchdog` also covers macOS now: `kill(pid, 0)` for host liveness and `Process.StartTime` for
PID-reuse identity, which is an absolute kernel timestamp there. **The Linux path still reads `/proc` and is
untouched** — `Process.StartTime` is reconstructed from boot time on Linux and is not comparable across
processes (`.agents/memory/cache-process-identity-linux.md`). Before this, a host crash on macOS left every seat
alive forever, windowless and with no Dock icon.

### A seat must not write into the player's Steam Cloud saves

The per-slot user dir isolates a seat's **local** writes. Steam Cloud storage has no equivalent seam: it is
addressed by (Steam account, app id), so it is the same store the player's own game uses, and a seat writing
into it writes over their saves from outside the slot sandbox. Measured on a live host: a seat pushed its stale
slot copies of every profile into the account's cloud store, including a quarantined `*.VAL.corrupt` file.

| lever | what it does | files |
| --- | --- | --- |
| `SeatCloudSaveIsolationPatch` | seat-only (`COUCHCOOP_HEADLESS_CLIENT=1`). Harmony-skips every mutating `SteamRemoteSaveStore` method — both `WriteFile` overloads and both `WriteFileAsync` twins, `DeleteFile`, `RenameFile`, `CreateDirectory`, `DeleteDirectory`, `DeleteTemporaryFiles`, `ForgetFile` — plus `NGame.DoCloudSync`, the seat's startup cloud reconcile. Reads are untouched (they are answered locally). `Install()` **returns** the targets it could not take; it no longer throws (see the guard below) | `Patches/SeatCloudSaveIsolationPatch.cs`, installed from `CouchCoopMod.Init` |
| `HeadlessSeatCloudIsolationGuard` — **fail closed** | any refusal is reported as `couchcoop-seat-cloud-isolation-failed` over the authenticated control channel and the seat is SIGKILLed (`HeadlessForceExit`), in `HeadlessSeatBuildGuard`'s shape. The patch's old `throw` refused nothing: mod init runs inside the loader's blanket `catch`, which logged and returned, leaving the seat joinable with every cloud write open. An installer that THROWS is also a refusal here — unknown means open | `Session/HeadlessSeatCloudIsolationGuard.cs` |
| it runs **first** | the guard is the first `Apply()`-shaped call in `CouchCoopMod.Init`, immediately after `EnsureMonoModCanPatch()` and ABOVE `CommandLineOverridePatch` (the one that lets a seat join at all). It used to be ninth, so a throw from any patch above it produced a seat that joined and played unprotected | `CouchCoopMod.cs` |
| the seat **declares** it, per heartbeat | `HeadlessConnectionStatus.CloudSaveIsolated` — non-nullable and defaulting to `false`, so "absent" is "not declared". A heartbeat without it fails the seat on arrival (`seat-cloud-isolation-unconfirmed`) instead of burning the 75s readiness deadline | `Connections/HeadlessConnectionControl.cs`, `Session/HeadlessConnectionReporter.cs`, `HeadlessClientManager.Connections.cs` |
| the seat says **hello** | the guard posts one status to the same authenticated endpoint the moment the guarantee holds — from mod init, with no runtime, subscription or heartbeat behind it. Phase `mod-init`, deliberately outside the join wait's redirect set (`Connecting` / `starting`), so contact can never be mistaken for readiness. The status sequence is now **process-wide**, so the hello cannot consume the number the reporter's first heartbeat would have used | `HeadlessConnectionReporter.ReportSeatHelloAsync`, `HeadlessSeatCloudIsolationGuard.SayHello` |
| no contact at all ⇒ killed at 35s | `COUCHCOOP_SEAT_CONTACT_TIMEOUT_SECONDS` (default `DefaultSeatContactTimeoutSeconds` = 35, same clamp band and parse rule as `COUCHCOOP_SEAT_READY_TIMEOUT_SECONDS`). **Which failure the silence is turns on host lobby membership** (`77b2f7e1`): a non-member ran none of our code and keeps `SeatCloudIsolationCode`, while a member can only have joined through `CommandLineOverridePatch` — which runs after the isolation guard — so its saves are provably covered and it is failed as `SeatSilentAfterJoinCode` instead. Survivable for a healthy seat **because of the hello**: the only work inside the window is game boot up to mod init, not the 20-30s asset preload a handheld runs past while healthy. **Measured 2026-09-17** (dev desktop, 12 threads): first contact at 4.1s / 4.3s idle and **9.9s with every core saturated**, which is what keeps the default at 35 rather than the 20 the hello makes plausible — grade a proposal against the loaded figure, and note that no handheld has reported one. Every seat's real figure is logged once — `seat first contact slot=N afterMs=…`, **stderr only, never in godot.log** — and qa-recipes §7 makes reading it a step. **This SHRINKS the exposure window, it does not close it**: an unmodded seat runs its own cloud sync inside those 35 seconds, and its process actually lives for the deadline **plus** the 5s graceful-shutdown deadline, because it has none of our code to answer the stop. The safety net for that case is the host-side pre-spawn profile backup in the row below | `HeadlessClientManager.cs`, `HeadlessClientManager.Connections.cs` |
| QA lever | `COUCHCOOP_FORCE_SEAT_ISOLATION_FAILURE=1` (exactly `1`) forces the guarantee to FAIL so a live leg can exercise the refusal without editing code. It forces the verdict only — the skips are installed first, so a lever left set refuses seats but cannot open a write path | `Patches/SeatCloudSaveIsolationPatch.cs` |
| run saves are never seeded | `HeadlessUserDirSeeder` skips `current_run.*` / `current_run_mp.*` (the `.save`, its `.backup`, and any quarantined derivative) **and prunes any a previous spawn already left in the slot** — the copy walk only adds and overwrites, so the prune is what clears the field. `settings.save`, `prefs.save`, `progress.save` and `saves/history/` seed exactly as before | `Session/HeadlessUserDirSeeder.cs` |
| the host backs its own profile up first | `HostProfileBackup.EnsureForThisHostOnce`, from the **top of `EnsureHeadlessAsync`, before `_lock`** — a whole profile copy under the lock the game's main thread takes on every screen change is the room-load freeze again, and this needs no slot (`HeadlessUserDirSeeder.ResolveHostUserDir`). Once per host process; the cost of hoisting is that a join which reuses or is refused can also pay it. Copies `default/` + `steam/` (minus run saves and `*.spirectl-backup-*`; a `*.VAL.corrupt` quarantine is **kept** — the recovery page says it is still the player's save, which is why this predicate is `HostProfileBackup.IsExcluded`, not the seeder's) to `couch-coop/save-backups/<utc stamp>/`, keeps 3, refuses over ~200 MB, and is total: every failure is logged and swallowed. **The only defence that survives a seat which never loads our code** (lane refusal, assembly conflict, the loader's blanket catch) — everything above runs inside the seat. Lives OUTSIDE `SeedCopyDirs` on purpose, so no seat seeds it and the save store never sees it. Gated on `CouchCoopMod.EngineAvailable`: `EnsureHeadlessAsync` is reachable from the suite, and without the latch a test run would copy the developer's live profile. Kill switch `COUCHCOOP_SAVE_BACKUPS=off`; tests `dotnet run --project tests/CouchCoop.Mod.Tests -- cache` | `Session/HostProfileBackup.cs`, `docs/save-recovery.md` |

**Why not launch the seat with Steam off.** The game has a first-party switch that leaves Steam uninitialised,
which would remove the cloud store entirely — but Steam **Workshop mod discovery is behind the same
initialisation**, so a seat launched that way loads only the install's `mods/` directory. On any machine whose
host runs a Workshop mod (CouchCoop's own Workshop build, or a subscribed content mod) the seat would run a
different mod set than the host it joins. Verified against the installed `sts2.dll` and against the host and
seat logs, which show two Workshop mods reached only through the Steam-gated path. The switch is therefore
unusable here.

The two halves are **ordered**: dropping run saves from the seed is only free because the patch removes the
seat's cloud sync. With a cloud store still attached, a save file the slot has no local copy of costs a remote
round trip that the rest of startup waits on — the stall the seeder was written to avoid. Tests: `-- cache`
(the seeder), `-- beta-targets` (the patch targets), and `-- connections` (the verdict, the lever, the copy, and
the host's reaction to a seat that refuses, never declares, or never speaks).

**What each defence covers.** The guard covers a seat *our code runs in* and cannot complete the isolation. The
per-heartbeat declaration covers a seat running *something else* (an older CouchCoop, a foreign copy) — the host
stops it on its first heartbeat. The contact deadline covers a seat running *nothing of ours at all*, and is the
only one of the three that is a race rather than a guarantee: it is honest mitigation, not protection.

### A seat must run the same copy of CouchCoop as its host

Two copies of this mod can be installed at once — the install's `mods/couchcoop` and a Steam Workshop
subscription — and **the game chooses between them per process**. Stable `v0.107.1` always keeps the local
copy; beta `v0.111.0` keeps the HIGHER version. So the host and the seats it spawns can disagree, and once did:
a whole beta QA session ran the published Workshop build in every seat while the host ran the working tree.
Three independent defences, none of which needs anyone to unsubscribe:

| where | mechanism | files |
| --- | --- | --- |
| deploy | a dev deploy stamps `9999.0.0+dev.<sha>` into the DEPLOYED manifest, so it cannot lose a version comparison, and writes `build-info.txt` beside it. The stale-file sweep now removes both, because `PreserveNewest` never replaces a newer stale manifest | `scripts/build-local-mod.sh`, `scripts/stamp-local-mod.sh` (self-test `scripts/test-stamp-local-mod.sh`) |
| seat seeding | the seeded profile's `mod_settings.mod_list` row for the copy the host is NOT running is written `is_enabled: false`, so the seat's choice is not a version comparison at all. Symmetric — a Workshop-running host disables the seat's local row. `PinSeatProfiles` runs inside successful `Prepare` calls, including the macOS fake-home path; a preparation fallback deliberately does not pin because it would be editing the host's own `settings.save` | `Session/HeadlessSeatModSelection.cs`, called from `HeadlessUserDirSeeder.Prepare` |
| seat runtime | the seat compares `COUCHCOOP_HOST_MOD_BUILD` with its own build at mod init and, on a difference, reports `couchcoop-build-mismatch` through the control channel and force-exits before any patch or join. The host surfaces it as the `seat-build-mismatch` issue, whose next action is "keep only one copy installed" | `Session/HeadlessSeatBuildGuard.cs`, `Connections/CouchCoopModBuildIdentity.cs`, `HeadlessClientManager.Connections.cs` |

The per-mod enable flag lives in `steam/<id>/settings.save` (and `default/<n>/settings.save`) under
`mod_settings.mod_list`, one `{id, source, is_enabled}` row per **(mod, source)** pair — `source` is
`mods_directory` or `steam_workshop`. The seeder does copy that file; what it cannot carry is the host's
*decision*, because the host rewrites the list from what it discovered after it has already chosen. Tests:
`-- seat-build` (also in `-- connections` and `-- cache`).

## Lobby QR host panel

The always-on QR overlay is gone. A game-styled button opens a dialog instead.

- **Files**: `HostUi/CouchCoopQrHostPanel.cs` (single injected root), `CouchCoopModalDialog.cs` (shared
  modal chrome), `CouchCoopQrDialog.cs`, `CouchCoopHostTransportAlertDialog.cs`, `HostTransportAlert.cs`,
  `CouchCoopQrHostSelect.cs`, `CouchCoopEventButton.cs` / `CouchCoopSkipButton.cs` (both
  `CouchCoopTextureButton` → `NButton`), `CouchCoopQrHotkeyHint.cs` (controller glyph),
  `CouchCoopQrHostPanelController.cs` (event-driven presence + gate) with `LobbyScreenRegistry.cs` and
  `LobbyEvaluationPlan.cs` (the pure gate),
  `CouchCoopLobbyHostGate.cs`, `QrHostOptions.cs`, `QrHoverTipCopy.cs` + `CouchCoopQrHoverTips.cs`
  (per-option hover-tip pair through the game's `NHoverTipSet`), `CouchCoopQrSelectionPreference.cs`
  (persisted pick, `qr-prefs.json`), `QrRaster.cs`, `CouchCoopStreamSkip.cs`.
- **Gate**: `ShouldShow(listenerBaseUri, state)` = browser server bound AND
  `state is { Run: null, CharacterSelect.Lobby.NetGameType: "host" }`. That single predicate covers BOTH
  `NCharacterSelectScreen` and `NMultiplayerLoadGameScreen`; a singleplayer/client lobby is refused.
- **Presence is pushed, not polled** (controller): screens arrive by `Patches/LobbyScreenMountPatch.cs`
  (Harmony on each screen's declared `_Ready`) into `LobbyScreenRegistry`, whose liveness is "not freed",
  never "in the tree". An evaluation is woken by `Sts2ScreenContext.SubscribeUpdated` (spirectl's read-only
  seam onto the game's active-screen event), by Godot's `visibility_changed` on each registered screen, and
  by a mount; it runs on a `CreateTimer` callback, so a signal raised mid-transition still installs from the
  same safe point the tick always did. The **0.25s chain survives only while a lobby screen is visible AND
  `Sts2ScreenContext.IsCurrent`** — it exists purely because `netGameType` flips live in the lobby — and
  parks otherwise. This replaced a chain that never parked: the game readies its character-select screen at
  main-menu **load** and never frees that node, so the registry was occupied for the whole session and the
  timer ran 4×/s through combat, the map and the menu. `lobby-screen-mounted` therefore fires **once**, at
  main-menu load, and entering the lobby reuses that node — absence of a mount line is not absence of a
  lobby.
- **A visible-but-not-current lobby keeps its panel.** Removal is keyed on visibility alone. The game's
  current-screen answer is whatever is on top, *including a modal over the lobby*, and CouchCoop's own open
  dialog is a child of the panel — "not current ⇒ remove" would close the player's dialog. Not-current only
  suppresses the state pull and the timer, and holds `HostTransportAlert`'s once-per-mount latch rather than
  re-arming it. Closing the modal raises the event, which re-evaluates.
- **Fallback**: if the active-screen event cannot be subscribed, or the current screen cannot be resolved,
  the evaluation degrades to the pre-existing rule — pull on visible, tick unconditionally — and logs
  `screen context unavailable` once. Nothing about screen detection may cost the lobby its QR button.
  The gate is `HostUi/LobbyEvaluationPlan.cs`, Godot-free and tested in `IdleHostCostTests`
  (`-- host-guards`); `Spirectl.Sts2.Live.Sts2ScreenContext` is pinned in
  `SpirectlEmbeddedAssemblyBoundaryTests`.
- **Node contract** (what the probes assert): `CouchCoopQrHostPanel` (FullRect, `Ignore`) →
  `CouchCoopQrButton` (rect **226,732 → 578,868**, design space, on BOTH lobby screens; label
  "Couch Co-Op QR Code") and `CouchCoopQrDialog` (hidden) → `CouchCoopQrDialogScrim` (`Stop`, closes),
  `CouchCoopQrDialogPanel` (1000×936 centred, `Stop`, does NOT close) → `CouchCoopQrDialogTitleLabel`,
  `CouchCoopQrDialogQrTexture` (`Stop`, does NOT close), `CouchCoopQrDialogUrlLabel`,
  `CouchCoopQrDialogCopyButton` (inside the URL row, right of the rendered address; hidden when there is
  no address), `CouchCoopQrDialogNoticeLabel` (hidden unless Steam-offline), `CouchCoopQrCloseButton`,
  `CouchCoopQrHostSelect` → `CouchCoopQrHostSelectCurrent` + `CouchCoopQrHostSelectList` (hidden) →
  `CouchCoopQrHostOption0..N`. Plus, since Aug-15, a sibling `CouchCoopHostTransportAlert` (hidden) →
  `…Scrim` / `…Panel` → `…TitleLabel`, `…BodyLabel`, `…DismissButton`.
  **These names are the contract** — `CouchCoopModalDialog` takes them as a `CouchCoopModalNames`
  parameter precisely so extracting the shared chrome could not rename the QR dialog's four.
- **Controller reach (`mega_top_panel`)**: a controller CANNOT focus the button — `InitCharacterButtons`
  pins each character button's top/bottom focus neighbour to ITSELF and rings left/right among those
  buttons alone, so no injected control is reachable, and controller mode warps the mouse off-screen so
  `IsFocused` (`_isHovered || _isControllerFocused`) never turns on. `CouchCoopQrHostPanel` therefore
  pushes `MegaInput.topPanel` → `OpenDialogFromHotkey` on install and removes it from the native
  `tree_exiting` signal (not `_ExitTree`, which is not dispatched into this assembly), the same
  push-on-show/remove-on-close shape `CouchCoopModalDialog` uses for cancel. **Why that action**: the
  hotkey manager dispatches to the LAST-pushed binding and marks the event handled, so the pick must be
  free on both lobby screens — between them they already take `cancel`/`pauseAndBack`/`back` (back +
  unready buttons), `select`/`accept` (embark/confirm), `viewDeckAndTabLeft` +
  `viewExhaustPileAndTabRight` (`NAscensionPanel`) and `viewMap` (`NInvitePlayersButton`, inside the
  remote-player container). `topPanel` is also controller-ONLY — no default key, and absent from the
  game's remappable-keyboard list — so it cannot swallow a key from a mouse-and-keyboard host. This is
  the Steam Deck / Game Mode fix; the button's own `Hotkeys` stays empty.
- **`CouchCoopQrHotkeyHint`**: child of `CouchCoopQrButton`, anchored below it → `Row` →
  `CouchCoopQrHotkeyGlyph` + `CouchCoopQrHotkeyLabel` (`couchcoop_qr_button_hotkey`). Visible only while
  `NControllerManager.Instance.IsUsingController`; the glyph comes from
  `NInputManager.GetHotkeyIcon` (which honours a rebind) and refreshes on `ControllerDetected` /
  `MouseDetected` / `InputRebound` — never on the 0.25s scan. The label node is deliberately not named
  `Label`: the probe's `rowLabelText` takes the first descendant with that name.
- **Shared modal (`CouchCoopModalDialog`)**: scrim + centred card + one `CouchCoopSkipButton` + cancel
  binding + focus parking. Subclasses supply the BODY (`InstallBody` / `ApplyBodyLayout` / `LayoutBody`)
  and the button's wording/size; `OnScrimPressed` returning true swallows a scrim click instead of
  closing (the QR dialog collapses its open option list first). The card is never a close surface.
- **Getting OUT of a modal on a pad** — three parts, each one measured failing on a Deck (the transport
  alert could not be dismissed at all: A, Y, Start and every direction left it up, and B left the lobby):
  - **Focus parking** (`CouchCoopModalFocusParking`, pure, `-- host-ui`): the card on a mouse (a `Panel`
    draws no focus visual, so nothing reads as pre-selected), the **dismiss button** whenever
    `NControllerManager.IsUsingController`. `ControllerDetected` / `MouseDetected` re-park a modal that is
    already up, so a host who picks up a pad mid-dialog is not stranded. Without this the select-action
    path from `a6665773` was dead in practice — `CouchCoopButtonActivation.Resolve` gates on `IsFocused`,
    and no CouchCoop button was controller-focusable anywhere. Every re-grab rule asks **"is focus
    anywhere inside this modal"** (`Node.IsAncestorOf` on the viewport's focus owner), never "is the
    dismiss button focused" — the second reading drags a player off a dialog row on the next 0.25s scan.
  - **Closed vertical focus chain inside the dialog** (`CouchCoopModalFocusChain`, pure, `-- host-ui`):
    the dialog declares its participating controls top-to-bottom via `CollectFocusChain`, the base appends
    the dismiss button, and up/down wrap end-to-end while left/right pin to the control itself. Godot's
    geometric neighbour search otherwise hands focus to a LOBBY control behind the scrim. A modal that
    declares nothing (the transport alert) reduces to the single self-pinned button it had before. The QR
    dialog declares the select's closed row plus the selectable option rows **while the list is expanded**,
    and re-pins from `RefreshFocusChain` on every expand, collapse, rebuild and selectability change —
    driven from where the rows are built, never from the scan, so the pinned paths cannot name a freed row.
  - **`ReassertWhileOpen`**, called from the panel's per-scan `Apply`: re-takes `cancel` +
    `pauseAndBack` (remove-then-push — the manager de-duplicates by delegate, so a bare re-push is a
    no-op) while a modal is visible. `NButton.OnEnable` re-pushes the lobby back button's
    `cancel`/`pauseAndBack`/`back` handlers on every enable, and the screen cycles that from its own
    visibility changes — so a modal that opens by ITSELF during lobby setup gets out-ranked, while one the
    player opens later does not. That is the whole difference between B on the alert (left the lobby) and
    B on the QR dialog (closed it). The same heartbeat re-parks controller focus, because that same late
    setup calls `Select()` on a character button and takes engine focus. `CouchCoopTextureButton` also
    `AcceptEvent()`s a select-driven activation so A on a dismiss button cannot ALSO fire the lobby's
    embark through `_UnhandledInput`. Both the binding and the signal hookups are dropped from the native
    `tree_exiting` signal, because the lobby can be torn down with a modal still open.
- **Options** (single select — the two link checkboxes are gone, their methods are rows now):
  `QrHostOptions.Build` orders advertised-override → per-ADAPTER triples (best IPv4 per NIC, adapters
  tier-sorted ethernet → wifi → other; inside each: plain ipv4 → `sts2-couch.pages.dev/?h=<ip>:<port>` →
  `https://<dashed-ip>.my.local-ip.co:<securePort>/`) → mDNS `<machine>.local` ALWAYS LAST (the
  self-check no longer reorders it, it only badges "didn't answer when tested"). Default = first
  ENABLED row; unavailable methods render disabled with their blocker and stay hoverable. Identity is
  `SelectionKey` (`method|adapterIp`), never Host — every web row shares the public host. The port is
  always the port each listener actually bound. The pick persists as `{method, host}` in
  `qr-prefs.json` (`CouchCoopQrSelectionPreference`).
- **Hover tips**: hovering/focusing any row (incl. the closed current row and disabled rows) shows a
  game-native tip PAIR — adapter pros/cons + method pros/cons (`QrHoverTipCopy`, average-gamer
  register, no protocol jargon; pinned by `QrHoverTipCopyTests`). Titles merge into the game's
  `static_hover_tips` loc table per show (`SetLanguage` wipes merges); descriptions are raw strings.
  The created `NHoverTipSet` parents under the GAME's tips container, so `CouchCoopQrHoverTips`
  stamps it `spirectl_stream_skip` synchronously — the mirror probe scans tip TEXT while a tip is
  held open to prove it.
- **The QR is ALWAYS the same size on screen** (`qrDialogExtent`, 592 design units — an exact size, not a
  budget). It used to be `modules * 4 * K` for the largest whole K that fit, so the plain LAN URL (37
  modules, K=4, 592) and the secure URL (41 modules, K=3, 492) rendered visibly differently and picking
  a secure row resized the code. The whole-number rule still holds — a fractional scale resamples the
  module grid and can make a code unscannable — but it moved into `QrRasterPlan`: every module gets
  `floor(592 / modules)` source pixels and the leftover becomes **centred white padding**, i.e. extra
  quiet zone, which is always legal. Result: 592 vs 574 in one fixed 592 box (3%) instead of 592 vs 492
  (17%). The canvas is 1:1 with the extent, so `QrRaster` writes a byte buffer for one
  `Image.CreateFromData` — the old per-pixel `Image.SetPixel` loop is why the raster had to stay tiny.
  Specs: `QrRasterTests` (both real URLs, uniform module pixels, lossless module round-trip, white-only
  padding, pathological degradation) and `CouchCoopQrLayoutContractTests`.
- **Steam-offline alert**: on entering the host lobby with `CouchCoopHostUiNotices.HostTransportNote` set,
  `CouchCoopHostTransportAlertDialog` pops with the note as its BODY (the QR dialog's tip line is
  invisible to a host who never opens that dialog). **Once per MOUNT**, decided by the pure
  `HostTransportAlert.Decide(state, mounted, note)` and latched in `_alertState` on the controller's scan
  — **no persistence of any kind**, so backing out to the menu and returning shows it again. The note is
  not latched until it is actually shown, so a transport that reports a beat late still gets its alert.
  Spec: `HostTransportAlertTests`.
- **Clicks are focus-gated**: the game's lobby buttons ignore a click until the pointer has entered them, so
  any scripted drive MUST `dev scene hover` first and then click AT THE RETURNED `hoverPosition`.
- **Mirror exclusion is a SAFETY control, not a bandwidth one**: mirror clients drive the host with real
  injected input, so a phone that can see the button can press it and open a dialog on the host's TV (the
  same reason both modals hang off this one root). The
  panel is stamped `spirectl_stream_skip` BEFORE `AddChild` (a later stamp races a keyframe); spirectl's
  scene WATCHER honours it (kill-switch `SPIRECTL_SCENE_WATCH_HONOR_STREAM_SKIP=0`). It is deliberately NOT
  honoured by the dev scene PROVIDER, so `sts2 dev scene ...` can still see and drive the dialog.
- **`_Ready` is not trusted**: Godot virtual dispatch into the mod assembly is unproven (no Godot source
  generators here), so the controller calls an idempotent `Install()` explicitly after `AddChild`, and
  hover/press flow through signal `Callable`s.

### Host connection status

The QR dialog owns a 420×936 companion card to the left of its unchanged centered card, separated
by 24 design units. It appears when a WebSocket client or retained issue exists. The old lobby activity
panel is no longer mounted; its internal narration remains available for diagnostics.

- `Connections/ConnectionRegistry.cs` owns immutable client/attempt snapshots for the process lifetime.
  **Keep `Connections/` outside hot-reload source globs.** Server generations share this BCL-facing API.
  Client identity is the original host WebSocket session ID; display names and parsed device labels do
  not identify a client. Redirected sockets report through their owned process generation.
- Normal progress has six stages: connecting, choosing a name, initializing, joining the host, loading
  the browser view, and complete. Direct views and existing games use four. Stage clocks are monotonic;
  closing the dialog does not affect them. A first-frame receipt alone cannot complete a native join.
- `HeadlessClientManager.Connections.cs` requires the live owned process, an authenticated fresh child
  heartbeat, a responding listener, and host-observed membership before redirecting. The configurable
  startup deadline remains 75 seconds. Browser presentation taking 30 seconds records an actionable
  warning while leaving the joined game running.
- `/internal/client-status` is a bounded POST on the existing raw TCP HTTP server, restricted to loopback
  and a per-process credential. Launch environment supplies `COUCHCOOP_HEADLESS_CONTROL_URL`,
  `COUCHCOOP_HEADLESS_CONTROL_TOKEN`, and `COUCHCOOP_HEADLESS_CONTROL_GENERATION`. Generations and increasing sequences
  reject delayed reports; the response can request shutdown. Credentials never appear in reports.
- **When that POST cannot get through, the same status crosses on DISK and the join still works.** Measured in
  the field 2026-09-18: a seat that had joined the lobby, bound its port and was idling healthily while every
  status POST was filtered by something on that computer (a proxy without a loopback bypass, a VPN, security
  software) — `d27ff12b` named the fault, this survives it. The seat writes
  `user://couch-coop/status-slot-N.json` **only after a POST has failed** (`Server/SeatStatusFile.cs`, written
  `.tmp`-then-`File.Move`, deleted on a clean stop or when the channel recovers), and the host reads it **only
  when it has heard nothing for two seconds** — never on a healthy session, which touches no disk at all. The
  record is HMAC-SHA256'd with the seat's own bearer token over the status text, the writer's pid and the
  generation, and **the token is never written**: a local process can replay one (the sequence rule refuses it)
  or delete one (a DoS indistinguishable from the silence this exists for), but cannot forge one. The host
  verifies MAC + pid + generation and then feeds it to the SAME `HeadlessConnectionControl.Observe` the route
  calls, tagged `HeadlessStatusChannel.File`, so every rule and refusal downstream is unchanged; it tracks the
  last sequence it took from the file so re-reads cannot refuse themselves onto the evidence counters. **Two
  seconds, not `Fresh()`'s ten** — ten is when a joined seat dies as `child-status-lost`, so reading only at
  that point would leave a seat the fallback is carrying one read from being killed. Every readiness verdict and
  silent-seat detail now ends with which channel delivered the last status (`DescribeControlChannel`), so a
  report separates "primary worked" / "fallback carried it" / "neither"; `seat-control-blocked` means BOTH
  failed and says so. The host→seat direction has no such fallback — a file-fed seat never receives the
  response's graceful `ShutdownRequested` and is killed after the five-second deadline, which is already what
  happens to any seat that cannot answer. QA lever: `COUCHCOOP_FORCE_SEAT_CONTROL_FAILURE` on the host, `1` =
  POST fails, `all` = POST and file both fail; exact match, inert otherwise.
- spirectl's multiplayer connection subscription observes native failures before dialog suppression.
  A failed child stops input and arms the five-second forced-exit backstop before notifying the host
  and browser and requesting quit. Parent cleanup captures logs and releases the peer before a seat
  can be reused. Healthy reconnect and mid-run detach still retain the existing game.
- `ReportHostIssue` raises a synthetic **Host service** row with no client attempt behind it, deduplicated by
  code. `isWarning: true` records it with the `Degraded` outcome — orange ⚠, not failure red — for a condition
  that is running under a limitation rather than stopped. Four codes exist: `host-service-failed` (no browser
  listener), `host-patch-failed` (Harmony hooks could not be installed, so no QR button and no seat joining),
  `host-seat-profile-shared` (warning: a per-seat Godot user-dir preparation failed, so every player on the
  machine shares one settings/save profile; macOS normally uses its fake-home farm, and the seat's *log* is
  still separate — see the seat launch contract), and
  `host-no-inbound-connections` (warning: see below). **A new code needs a
  `CouchCoopConnectionPanel.IssueKey` mapping and its catalog pair**: unmapped codes fall through to the join
  copy, which on a Host service row is a wrong sentence, not a missing one.
  `Connections/CouchCoopPatchHealth.cs` records patch outcomes and publishes the `patchHealth` fact into every
  report beside `hostOS`; off Linux, `CouchCoopHarmonyProbe` answers the question up front by detouring a
  throwaway method of our own before any real patch is attempted.
- `Connections/HostReachabilityWatch.cs` raises `host-no-inbound-connections` when the browser listener has
  accepted **nothing** for 90s. It exists for the macOS shape nothing else can see: the Local Network privacy
  permission and the application firewall both leave the host bound and listening while every phone times out —
  a blocked connection never reaches `accept`, so there is no failure to report and no row to raise. The clock
  starts in `CouchCoopHostUiServices.StartDiscoveryServices` (a HOST lobby is on screen), **never at the bind** —
  the listener is up from mod init and a bind-anchored clock would warn every solo player. Both accept loops
  (`CouchCoopBrowserServer`, `SecureBrowserListener`) call `NoteInboundConnection()` before admission, which
  cancels the warning or withdraws a standing one; `Disarm()` runs on host teardown. `COUCHCOOP_REACHABILITY_WARN_SECONDS`
  overrides the threshold (`0`/`off` disables; clamped to 15–3600). **The copy never accuses**: from inside the
  host "nobody has scanned yet" and "nothing can reach this port" are the same observation, so the row states the
  fact and names what to check only conditionally. Tests: `HostReachabilityWatchTests`
  (`-- network`, `-- connections`, and Connection.Tests `--patch-health`).
- A seat that loaded a different CouchCoop build than the host reports `couchcoop-build-mismatch` on that
  same channel at mod init, before any join, and exits. It is NOT folded into `native-join-rejected`: the
  host raises `seat-build-mismatch`, whose detail names the assembly file the seat loaded and whose next
  action is to keep only one copy of the mod installed. See the seat launch contract above.
- **Why a seat is not serving yet is ONE of four named causes, never one sentence.** `SeatReadinessVerdict`
  classifies from facts the host already holds — the seat's reported bound port vs the assigned one, the host's
  own loopback probe *and its failure reason* (exception type / socket error / elapsed ms), heartbeat freshness
  and phase, `ConnectedChildBrowserCount`, and the seat's own viewer-arrival count off the same heartbeat — into
  `seat-port-taken` (something else owns the port),
  `seat-port-blocked` (the seat IS listening where expected and this computer cannot reach it: an unscoped
  `iptables … --dport 13347:13417 -j DROP` sits above any `-i lo ACCEPT` and eats the host's own probe),
  **claimed only when a raw TCP connect could not complete either** — a failed HTTP probe alone also fits a
  listener that is bound but WEDGED, which completes the handshake from the kernel backlog and fails only the
  read, and telling that player to edit their firewall would be this round's own mistake repeated; a connect that
  was ACCEPTED (wedged) or REFUSED (nothing listening yet) is `startup-timeout` instead —
  `seat-network-path` (host can reach it, the device never did — this must not accuse the listener), **claimed
  only on the SEAT's own affirmative zero**: `ConnectedChildBrowserCount == 0` says no browser *finished*
  connecting, which fits a blocked path and a viewer who has not tapped the link yet equally, so the seat reports
  how much has reached its own listener (`HeadlessConnectionStatus.ViewerArrivalCount`, nullable — `null` is "has
  not said" and falls through, because this is the cause that blames something the player owns) — and
  `startup-timeout` (nothing is wrong yet), which also absorbs the near miss: a seat that HAS been reached with no
  browser attached is **deliberately not a fifth cause** (it is the normal state of every healthy join while the
  seat's page loads, the count is process-wide so it cannot name *this* device, and no single fix sits behind it);
  it says so in one English sentence and in the evidence tail instead. Each cause has its own `IssueKey` mapping
  and catalog pair. The technical
  **detail** stays English and carries the same evidence tail under every cause; the summary/action above it are
  localized. This replaces a single string ending in `child HTTP listener: not responding` that was measured
  byte-identical across two of these — and that contradicted itself, calling a listener unresponsive in the same
  sentence as `authenticated heartbeat fresh: True`. The network-path cause is only reachable from
  `MonitorConnectionAsync`, because the join returns as soon as the HOST can reach the seat.
- **…and that verdict reaches the PHONE, not just the panel.** For the network-path cause the host's own loopback
  probe of the seat *succeeds*, so the join is answered as a **success** and the browser is redirected to a port
  its device cannot open — the viewer then sits on "Loading…" for ever while the host names the cause four times
  a second and tells only itself. `MonitorConnectionAsync` hands each tick's verdict to the seat's
  `Session/SeatNoticeSpeaker.cs` and publishes the result to the sessions bound to that slot through
  `Connections/SeatNoticeHub.cs`; each `CouchCoopWebSocketConnection` subscribes itself by session id and sends
  `{type:"seat-notice", cause, detail}` (`BrowserSeatNoticeEnvelope`, tokens in `BrowserSeatNoticeCauses`, never
  the enum). The channel is the **host** socket a redirected viewer keeps open — `onHeadlessRedirect` only gates
  its stream off, because closing it triggers `Release()` and kills the seat — so the client handler sits above
  the `watching` gate and is **not** tied to a join in flight, and the app guards on `hostClient`, not
  `activeClient` (after the redirect the active client is the seat socket that, in this very case, never
  connects). Three rules: `StillStarting` maps to no token and is never announced (it is every healthy join for
  20-60 s); a cause that clears sends `none`, which WITHDRAWS, so an accusation cannot outlive it; and
  `SeatNoticeSpeaker.NetworkPathSettlingDelay` (20 s) holds the network cause back, because it can first hold
  before the browser has even been told which port to open. The hub debounces per **session**, so a viewer that
  drops and reconnects is told again rather than inheriting a record belonging to a socket that is gone. Copy in
  `frontend/src/mirror/loadingState.ts` (`seat.notice.*`, 14 catalogs) is the second-person twin of the host
  panel's `couchcoop_connection_error_seat_*`, and the English detail rides along verbatim so the two surfaces
  cannot drift.
- **Before the WebSocket there is a VISIT ID and an arrival ring.** `ConnectionRegistry` rows begin at the
  upgrade, so a device that fetched `/` and got no further left nothing at all. The SPA document is now served
  with a per-response nonce injected into its `<head>` (`Server/VisitIdTag.cs` →
  `<meta name="couchcoop-visit">`) on a **`Cache-Control: no-store`** response — without the `no-store` the HTTP
  cache hands several devices one id. Not a cookie, deliberately: cookies are not port-scoped (RFC 6265 §8.5), so
  one set by `:13337` would ride to `:13357` and to every other service on the machine. Every other static file
  keeps exactly the caching it had. `Connections/ConnectionArrivalLog.cs` records `{at, remote, path, outcome,
  visit, device label}` for the shell, `/ws` and refusals in a 128-entry ring (`MaximumRetainedArrivals`, the
  shape of `MaximumRetainedFailures`), folded into every report by `BuildReport`. **Bounded on purpose** — it
  sits on an unauthenticated LAN request path: repeats of the newest entry coalesce, user-agent parsing is
  memoised and budgeted, `godot.log` emission is a token bucket, and nothing is keyed by remote address. Never
  records a player name: the query string is dropped (`?name=` rides there, the reason `OfflineQrCode` strips it).
  The browser reads the tag back (`frontend/src/join/visitId.ts`) and sends it on `join`, which **promotes** the
  visit into that connection's row instead of leaving a second one; the seat's socket URL carries `?visit=`, so a
  seat's own log answers "did this device ever reach me?". Read API for the readiness verdict:
  `HasArrivedForVisit` / `Summarize(visitId)` (host) and `SummarizeViewerArrivals()` / `ViewerArrivalCount`
  (process-wide, loopback excluded — the host's own probe is not a device; an unreadable remote address counts AS
  one, so the number can only be too generous, never too accusing). A seat carries `ViewerArrivalCount` to the
  host on every heartbeat (`HeadlessConnectionReporter.ViewerArrivals`), which is what the network-path verdict
  above rests on. **Writing to `ConnectionArrivalLog.Shared` from a test process segfaults it** (exit 139): its
  default sink writes through the game's logger, which is not callable outside the game and does not throw.
  Reading it is safe; tests that record inject their own log action. Layered UNDER
  `HostReachabilityWatch`, which counts raw accepts: an empty ring says which of the two silences it is. Tests:
  `ConnectionArrivalLogTests` (Connection.Tests `--routes`), `visitId.spec.ts`, `mirrorClientVisit.spec.ts`.
  **Scope limit:** this closes "reached HTTP, failed later" only — a phone that never reaches the host makes no
  request and leaves no row.
- Browser `client-frame-presented` is bound to the granted attempt and emitted after successful rendering
  and two animation-frame callbacks while visible. DOM and canvas use the same receipt path. It is
  separate from `scene-ack`, which remains the scene stream's flow-control credit.
- Cleanly closed sockets disappear. Failed attempts remain under Recent issues until dismissed or
  hosting ends; at most 128 detailed issues are retained, with an overflow count. Reports preserve the
  first known cause, stable codes, stage timing, process cleanup, and separately labelled bounded host
  and client `godot.log` excerpts. Concurrent host errors are supporting evidence. Copied text is capped
  at 64 KiB of UTF-8 and normalizes user-directory prefixes and control credentials.
- The native list rows, detail area, Copy report, Dismiss issue, selector, and Close form one modal focus
  chain. Shoulder buttons page through focused details. Clipboard feedback verifies a readback before
  displaying Copied. New issues while closed add a count badge and a brief non-modal notice.
- The QR dialog remains accessible if the browser service fails. Its empty state explains the WebSocket
  boundary and basic network checks. Native strings are localized in all supported catalogs; diagnostic
  codes and copied report fields remain stable.

## Suites / build (quick index — full detail in qa-recipes.md)
- `dotnet run --project tests/CouchCoop.MirrorProtocol.Tests` and `dotnet run --project tests/CouchCoop.Mod.Tests`
  — custom `Exe` runners, NOT `dotnet test` (suites self-register in each `Program.cs`).
- `godot-client`: `dotnet build godot-client/CouchCoop.GodotClient.csproj` (Godot's CLI runs the LAST-BUILT
  assembly — always build immediately before running).
- `frontend`: `npx vue-tsc --noEmit && npx vitest run` — NEVER `npm run build` inside a worktree (its
  `vite build` outDir deploys straight to the installed mod dir).
- `../spirectl`: `scripts/validate.sh bridge-build` / `scripts/validate.sh bridge-tests` — run `bridge-tests`
  ALONE (a parallel MSBuild race, MSB3030, is a known flake when run alongside other spirectl validate legs).

## Reference repos
- **`../spirectl`** — reusable STS2 runtime/producer: generic scene watcher, semantic actions, asset
  extraction, fixtures/scenarios, render snapshots, screenshots/diff, the `sts2` CLI itself. Anything that is
  useful to ANY STS2 tool (not co-op-specific) belongs there, not here — see CLAUDE.md architecture rules.
  `scripts/validate.sh` is its test entrypoint; `docs/` there (`ai-tools.md`, `cli.md`, `testing.md`,
  `known-gaps.md`) covers the CLI surface in depth.
- **`../sts2-couch-coop-v1`** — the old mod, kept ONLY as a behavior oracle (edge cases, validation rules, UI
  lessons). Never copy its source wholesale (CLAUDE.md rule).
- **`../godot-4.5.1-stable`** — Godot engine SOURCE at the exact version this project embeds. Use it for
  engine-internal questions the docs don't answer precisely enough: `Control` anchor/layout math,
  `CanvasItem` draw order, `GPUParticles2D` semantics, etc. (There is also a `../godot-4.6.2` checkout on this
  machine for unrelated work — the project targets 4.5.1, don't cross-reference the wrong version.)
- **`../godot-docs-4.5`** — the Godot documentation repo, pinned to 4.5. Use for class/API reference lookups
  without a web fetch (there is also a `../godot-docs-4.6` checkout — same version-pinning caveat as above).
- **`.sts2/research/`** (this repo, git-ignored, per checkout) — write-ups of findings that CANNOT be
  committed: game code, scene structure, captured wire payloads, device measurements, plus the
  read-only probe scripts and raw data behind them. Start at its `INDEX.md`, which also points at the
  generated local trees the notes were derived from. Note a worktree gets its OWN empty `.sts2/` (a plain
  directory, not a symlink), so notes written there are invisible to everyone else — always read and write
  them at the real checkout path. Findings that DO belong in the repo go in `docs/agents/` instead, with
  the game *code* left behind. Resource paths and node names the mod needs to function may be committed —
  see CLAUDE.md → Artifact Policy for where the line actually sits. `../spirectl` keeps its own
  `.sts2/research/` under the same rule.

## Mirror settings panel (web)
- Files: store `frontend/src/mirror/mirrorSettings.ts` (defaults, the localStorage layer, the server payload),
  storage leaf `frontend/src/mirror/settingsStorage.ts` (key + seam + raw read, imported by BOTH the store and
  `render/quality.ts`, which is why it has no imports of its own), quality presets
  `frontend/src/mirror/qualityPreset.ts`, panel `frontend/src/mirror/SettingsPanel.vue`, per-row help
  `frontend/src/mirror/SettingsHelpTip.vue`, the toggle + fullscreen chrome
  `frontend/src/components/SettingsGearButton.vue` / `FullscreenButton.vue` (both take a `compact` prop for the
  browser-space picker placement), wiring `frontend/src/mirror/MirrorApp.vue`.
- Seeding order (one pass, in `createMirrorSettings`): built-in defaults < device tier floor < localStorage <
  URL query. URL wins for the SESSION and never writes back; only operating a control in the panel saves, and
  only that one field (`persistMirrorSetting`). Storage key is versioned: `couchcoop.mirrorSettings.v1`.
- Never persisted: `freeze*` (host truth, re-seeded per connection from the serving instance), `panelOpen` /
  `panelAnchorTop`, `effectModePinned`, `spineMode` (dev `?spineMode=` only). `PERSISTED_SETTING_KEYS` +
  `NEVER_PERSISTED_SETTING_KEYS` must together cover every store key — a spec asserts it.
- `refreshRate`/`tweenReplay` ARE persisted although they are server-tied: a saved value beats the `session`
  envelope's baseline and the one-shot push carries it to the game (MirrorApp's `refreshRateSeeded` rule).
- **THE QUALITY ROW** (`quality`, first in "This device") is both halves of one setting. It is persisted, and
  `quality.ts` reads that same saved value when resolving the tier — order there is `?debug` > `?quality=` >
  stored choice (`source: "stored"`) > auto-detect — so a picked rung takes the device out of detection AND out
  of the live adaptive downgrade controller (`isAdaptiveEligible` requires `source` auto/default). Picking a rung
  also writes the three rows it implies (`QUALITY_PRESETS`: shaders / particles / static background), each saved
  through the same per-field write; the rows stay individually editable and the rung stays put when one moves.
  `auto` (the default) writes no rows — detection is a guess about hardware and must not change what a viewer
  sees, which is what keeps the product defaults device-independent. The panel prints the detected rung in the
  Auto entry (`detectedRenderQualityTier()`), and `?quality=` seeds only the FIELD, never the preset (bench cells
  pair it with `?shaders=`/`?particles=`). Rows apply live; the tier's own levers (texture cap, spine clips,
  trail budget, frozen-effect backing scale, hard-off lane) are latched at module load and follow on the next
  page load.
- **THE LADDER IS `high | medium | low | very-low | minimum`** (renamed from `high | low | min | static | off`:
  ids, `?quality=` values and player-facing labels are now one monotone vocabulary, and no quality level is
  presented to a player as "Off"). `parseRenderQualityTier` still accepts the three old spellings that map
  cleanly — `min`→`low`, `static`→`very-low`, `off`→`minimum`. **`low` changed meaning**: it now names the rung
  the old `min` named, so an old `?quality=low` link or bench report is one rung off. The phone-canvas bench
  gates on the recorded string and accepts both `very-low` and `static` for exactly that reason.
- Effect mode defaults are device-independent: shaders `static`, particles `static`. The quality tier only owns the
  hard-off lane (`shadersHardOff`/`particlesHardOff` in
  `render/quality.ts`: the `minimum` tier from `?debug` / `?quality=minimum` / a software-WebGL phone). Everything
  else — marker stamping (`particleAttributes.ts`), runtime construction + effective mode (`shaderResources.ts`),
  render scale and fps caps (`MirrorView.applyShaderMode/applyParticleMode`) — follows the PANEL.
- Consequence to preserve: fps caps are 30 on every live tier, and the ½/¼ DYNAMIC modes are 0.5/0.25 on every
  device — the same panel selection behaves identically on a phone and a desktop.
- The one device-dependent scale is the FROZEN (`very-low`) backing store (`quality.ts` `staticShaderScale`/
  `staticParticleScale`, consumed by `MirrorView.scaleForMode(mode, family)`): mobile = 0.5 shaders / 0.25
  particles, desktop = 1. Frozen effects still redraw on scene deltas, so backing-store fill cost matters.
- Tests: `mirrorSettings.spec.ts` (layering + storage), `qualityPreset.spec.ts` (the rung→rows table and what a
  pick writes), `settingsPanelPersistence.spec.ts` (what a control writes), `settingsPanelClientControls.spec.ts`
  (the quality row's ladder + Auto label), `settingsPanelHelp.spec.ts` (tips), `effectClampLift.spec.ts`
  (panel-decides), `pickerChrome.spec.ts` (gear + fullscreen on the picker), `quality.spec.ts` (ladder, aliases,
  stored choice), `mirrorViewEffectModes.spec.ts`.

## Composited-layer count

A phone trace showed most composited layers existing only because of `Overlap`, and three fixes looked obvious.
All three were measured and all three are wrong. **Read `.sts2/research/overlap-layer-cascade-aug18.md` before
doing any layer-count work** — it carries the 18-arm lab and the per-animation costs. The short version:

- **Containment cannot work.** Any *transform-family* compositing reason (`will-change: transform`, a `transform`
  or `translate` animation) makes that layer's overlap rect **unbounded** — everything painted after it that
  cannot merge is promoted, however far away it is. `contain: paint`/`strict`, `isolation`, `content-visibility`,
  `opacity: .999`, `filter: blur(0)` all leave the count unchanged; two of them make it worse. Only *opacity*
  animations have a bounded overlap rect.
- **Do not infer "this element is animated" from "this element owns a big layer."** An `Overlap` layer is a
  squash bucket whose bounds are the union of everything it absorbed, so a zero-area or fully transparent element
  can report a huge layer while having no animation and no compositing reason of its own. Resolve
  `compositingReasons` per layer first — `bench-mirror-replay.mjs --layer-detail` prints them in paint order.
- **Raising promoters above their victims is the only mechanism that works, and `z-index` cannot do it here**:
  every mirror node carries a baked `transform`, so every node is a stacking context. The only implementation is
  reparenting to a stage-level overlay, which reorders real UI (intents over dragged cards) — a correctness
  regression, not a perf win.

Tooling: `scripts/bench-mirror-replay.mjs --layer-detail` gives one line per layer in compositor order (= paint
order) with size/Mpx/paints/draws/reasons/element. The aggregate `--layers` histogram structurally cannot tell you
*which* promoter opened a cascade; the ordered list can.

## Browser chrome cost (cursor, image warms, atlas bakes)

Three per-session costs that are invisible on a desktop and dominate a phone. All three were measured with
`scripts/probe-mirror-tap-census.mjs` (offline replay; a before/after is the same recording on two dev servers).

- **Game cursor (`frontend/src/browserCursor.ts`)** — the pressed state is an inline `cursor` on the ONE element
  under the pointer, never a class on `<html>`. A root-level toggle against the `.game-cursor *` rules invalidates
  every element's style twice per tap (measured: 133.96ms → 0.29ms of recalc PER TAP, ~5,600 elements, 4× CPU
  throttle). Every document-wide alternative costs the same — `cursor` is inherited and Blink does not propagate it
  independently — so the static universal rule is what stops the inherited change at the target and must stay.
  It also does not install at all on a coarse-pointer-only device (`coarseOnlyPointer`), which has no cursor.
  Valve: `?gameCursor=off` anywhere, `?gameCursor=on` to force it onto a touch device.
- **One-shot image handlers** — `textureCache.warmImage` and `atlasBaker.getAtlas` detach their `load`/`error`
  handlers on settle. They used to stay for the session (one per distinct texture url, each pinning its Image):
  61 of 115 live listeners on a single map replay, and a live phone session was censused at 381.
  Spec: `imageListenerHygiene.spec.ts`.
- **Atlas region bakes (`frontend/src/mirror/atlasBaker.ts`)** — the div/blob mechanism drains ONE region per task
  on the INLINE path, and the next is scheduled only once the previous SETTLED. A bake is async, so the old 3ms
  budget measured nothing and poured the queue into one task (3.1s blocked on a phone's map load, 53.3% of that
  screen's CPU). Each bake is timed end to end.
  Counters: `window.__mirrorAtlasBakeStats`. Specs: `atlasBakeBudget.spec.ts`, `atlasBakeQueue.spec.ts`.

  **Aug-14 — the encode moved into a WORKER POOL** (`atlasBakePool.ts` + `atlasBakeWorker.ts`). A phone session
  measured 4,502.6ms of bake wall against 385.3ms of main thread (91.4% off-thread) and still tripped the
  self-disable 3× — `convertToBlob` encodes as an IDLE TASK and a busy combat main thread starves it, so the
  switch was firing on the page being busy. Now:
  - **The worker owns the atlas.** It fetches + decodes the page itself and holds it as raw RGBA, so a job is
    `{key,url,region}` in and `{key,blob}` out and the main thread never pays the GPU→CPU readback. (The
    perf-harness's `worker-imagedata` arm — it beat inline encoding even at fan-out 1, 709ms vs 1,238ms.)
  - **Pool size**: `hardwareConcurrency` ≤2→1, 3-4→2, 5-7→3, ≥8→4, capped again by `navigator.deviceMemory`.
    Pool sizing is automatic and capped by `navigator.deviceMemory`.
  - **Residency is budgeted, not assumed** — the pages are big (card_atlas_0 4032×4072 = 62.6MB RGBA; ~136MB for
    the 9 pages one recorded session touched). A job prefers a worker that already holds its page; a second copy
    only starts once the page's cost is known AND fits the pool budget (16MB per GB of device memory, clamped to
    48-128MB); each worker LRU-evicts its own pages past `budget / poolSize`.
  - **Every failure degrades to the inline path** (no Worker, construction error, worker death, a page that will
    not load in a worker) — a region is never dropped.
  - **The self-disable criterion is MAIN-THREAD time** (`BAKE_SLOW_MS` 50ms of `syncMs`, ×3 in a 15s window) with
    a WALL BACKSTOP (`BAKE_STALL_MS` 2,000ms, ×3) that still catches a genuine GPU/idle-queue stall. Which one
    fired is in `disabledReason` / `syncTrips` / `stallTrips`. Specs: `atlasBakeWorkers.spec.ts`.

## Phone fullscreen and the opt-in secure origin

Two independent tracks. **Plain HTTP on the LAN stays the default and must keep working with no internet at
all** (LAN-only play is a hard requirement); everything secure-context is pure opt-in addition.

**Why the split.** A plain-HTTP origin is not a secure context, so Chrome only ever makes a *shortcut* and
every secure-context API is off. But iPhone never needed HTTPS for this: iOS Add-to-Home-Screen has never
required a secure context, and iOS 26 opens every added site as a web app by default. So the chromeless path
is free, and HTTPS buys the *extras* (service worker, wake lock, a real install prompt) on every phone.
An external HTTPS site reaching the mod via Chrome's Local Network Access was **rejected**: Safari has no
LNA and blocks mixed content outright, so it excludes the one platform that needs help.

- **Phone chrome (`composables/useFullscreen.ts`)** — the landscape lock hangs off `fullscreenchange`, not
  off the seat tap, so it rides EVERY entry path (the button included). State is MODULE-scope with a scope
  refcount, deliberately: `useFullscreen()` runs in up to four live scopes at once (three `FullscreenButton`
  mounts + the seat-tap caller), so per-instance "the player left on purpose" was broken by construction —
  one instance recorded the deliberate exit while another instance's handler armed the re-entry and dragged
  the player back in. Escape counts as deliberate. The automatic paths are gated on `(pointer: coarse)`; the
  explicit button is not. Valves: `?autoFullscreen=off`, `?orientationLock=off`.
- **Install/rotate guidance (`join/IosInstallOverlay.vue`, `components/IosInstallButton.vue`,
  `components/PortraitNagOverlay.vue`, `join/BrowserAdvisory.vue`)** — decisions live as pure predicates in
  `join/joinModel.ts` (`shouldShowIosInstallOverlay`, `showsOpenAsWebAppToggle`, `shouldRecommendBrowser`) and
  the components are thin renderers. The overlay fires AFTER the seat tap, not on first paint. The portrait nag
  infers rotation lock (no API exposes it) at 2.5s, adds the platform line at +4s, and never shows when the
  orientation lock took. The advisory is Samsung Internet only and never blocks joining.
  - **The overlay is a two-stage card** (`steps` → `confirm`), not a single screen with two exit buttons: the
    install path never needs to close it (the Share sheet opens ON TOP), so there is no "Got it" — the only
    action on `steps` is an escape link that ASKS ("Play in the tab anyway" → `confirm`), and `confirm` is the
    only stage that can actually leave (`Play in the tab`, or Escape again). The escape link is absent for
    `escapeDelayMs` (default 3000) after an AUTO open, so a reflex tap has nothing to land on; a MANUAL
    (pill) open shows it immediately.
  - **Dismissal is session-only by default** — an in-memory flag, not persisted — so the overlay returns on
    the next page load. The confirm step's "Don't show this again" checkbox is the ONLY remaining writer of
    `IOS_INSTALL_DISMISSED_STORAGE_KEY`.
  - **`components/IosInstallButton.vue`** fills the slot `FullscreenButton` leaves empty on iPhone (no element
    Fullscreen API there) — `shown = shouldShowIosInstallHint(env) && !readElementFullscreenSupported()`,
    mutually exclusive with `FullscreenButton` by construction. It is the manual recovery path, so it
    deliberately ignores BOTH dismissal signals; clicking it bumps a parent-owned `openRequest` tick the
    overlay watches.
  - **Dismissing plays a "genie" close**: the confirm card WAAPI-animates (translate + scale, computed by the
    pure `computeGenieTransform` in `joinModel.ts`) into the re-open pill's measured rect, then pulses the
    pill. Falls back to an instant close when there is no mounted pill,
    `prefers-reduced-motion`, or no `Element.animate` (jsdom).
  - **`?iosInstall=force`** (`isIosInstallForced` in `joinModel.ts`) forces the platform gates open — a
    canonical iPhone-26 tab, element fullscreen unsupported — and arms the overlay on load, so the whole flow
    is reproducible on any desktop/Android Chrome. Dismissal storage stays real under the lever.
- **Secure origin (`Server/SecureBrowserListener.cs`, `SecureOriginProvider.cs`,
  `SecureOriginCertificates.cs`)** — a TLS twin of the browser server on its own port (`PreferredPortOffset`
  = +1, chosen NOT to collide with the headless seat ports at base + 10×slot). Certificate comes from a
  third-party PUBLISHED-private-key wildcard service (`local-ip.co`: `192-168-1-5.my.local-ip.co` resolves
  publicly to `192.168.1.5`). That key is public by design — this is a secure CONTEXT, not a secure CHANNEL,
  and anyone on the LAN could MITM it. Acceptable for couch co-op, which is why it is opt-in.
  **`traefik.me` no longer publishes certs at all** — verify a provider empirically, never from its docs.
  The provider's published `chain.pem` was a stale Sectigo chain against a now-GlobalSign leaf, so
  intermediates are accepted only if they actually issue the leaf, else resolved from the leaf's AIA pointer.
  Everything is best-effort in the `MdnsResponder` style: no cert ⇒ no listener, and the HTTP path is
  untouched. Kill-switch `COUCHCOOP_SECURE_ORIGIN=0`; cache dir override `COUCHCOOP_SECURE_CERT_CACHE`
  (per-user app-data, NOT `.sts2/` — a shipped mod runs where no repo exists).
- **Every option is a ROW of the one select; there is never a second code.** One chokepoint — the
  selected row — feeds both the texture and the URL label, so the scanned code and the typed fallback
  cannot disagree. The checkbox era's mode plumbing (`QrCodeMode`, select dimming, offer state) is gone:
  the secure and web methods are per-adapter rows derived from each ROW's address, not from the
  machine-picked advertised IPv4. Preference file override: `COUCHCOOP_QR_PREFS`; the persisted shape is
  `{"selection":{"method","host"}}`.
- **Web link / Local Network Access (`Server/CouchCoopWebOrigin.cs`, `frontend/pages/`, `src/boot/`)** — the
  second answer to "how does a phone get a secure context", and the one that does not need public DNS to
  resolve a private address (the `local-ip.co` dependency that routers with rebinding protection refuse).
  The client is served from a public HTTPS origin and reaches this PC by literal IPv4 under the browser's
  Local Network Access permission. **Full detail, including what Chrome does and does not allow — measured,
  not inferred — is in `docs/agents/local-network-access.md`.** The two facts most likely to bite: the socket
  must stay `ws:` while the page is `https:` (scheme comes from `@/join/hostBase`, never `location`), and a
  service worker may serve cache HITS for host URLs but must never `respondWith(fetch(...))` one. Chrome/Edge
  only — WebKit has not implemented LNA, so iPhones keep the `local-ip.co` and plain-LAN paths.
- **`ICouchCoopStreamGeneration`** exists because `ICouchCoopHotGeneration.HandleClientAsync` takes a
  `TcpClient` and calls `GetStream()` itself, which is exactly wrong once TLS has already been negotiated.
  It is a SEPARATE interface in the server assembly, not a new method on the hot-reload contract, because
  that contract lives in `CouchCoop.Mod.Contracts` and is bound BY REFLECTION at load time — widening it
  breaks every previously built hot-reload logic assembly.
- **Service worker (`frontend/public/sw.js`)** — hand-written, no build plugin. Allowlist-only
  (`/res/`, `/app/`, `/icons/`); note `assetsDir: "app"`, so `/assets/` is NOT the bundle prefix. Missing
  asset-like paths receive an ordinary static 404 rather than the SPA shell. Anything unclassified is BYPASSED
  (no `respondWith`), so the default
  failure mode is "as if no worker existed". Navigations are **network-only** with the offline page as the
  failure branch — a cached shell booting against a dead host is just today's never-resolving spinner, since
  all state arrives over `/ws`. Invalidation is the `/app/index-<hash>.js` build stamp scraped from each
  navigation (the frontend outDir IS the installed mod dir, so a hash change means the mod was redeployed);
  FIFO eviction to 64MB/1200 entries. It deliberately does NOT reload on `controllerchange` — with
  `skipWaiting` that is the classic infinite reload loop. Valves: `?sw=off` (unregisters + wipes
  `couchcoop-` caches), `?sw=on` (keep it in dev, where it otherwise tears itself down).
- **Offline page port probe stays on the CURRENT scheme.** An https page probing `http://` would be blocked
  mixed content, so an offline secure origin can only discover other secure ports. Platform limit, not a bug.
- **Wake lock (`frontend/src/pwa/wakeLock.ts`)** — acquired while visible, re-acquired on `visibilitychange`, with a one-shot gesture retry on
  `NotAllowedError`. Needs a secure context, so it is another thing the opt-in origin buys.

## Headless seat memory

A seat measured **1374MB RSS** against the drawing host's 3140MB, and a third of it was texture pixels the
seat can never draw.

- **Root cause is Godot's dummy renderer, not our code.** `RendererDummy::TextureStorage::texture_2d_initialize`
  is `t->image = p_image->duplicate();` (godot-4.5.1-stable
  `servers/rendering/dummy/storage/texture_storage.h:82`) — under `--headless` every texture keeps a full CPU
  copy of its pixels until its RID is freed, where a real renderer uploads to the GPU and drops it. Measured:
  **1,491 live `Image` objects / 456MB** in the seat vs **262 / 227MB** in the host. The tell is the format
  mix — the seat held 170 images (~104MB) in DXT1/DXT5/BPTC, formats the host retained ~none of because they
  exist only to be handed to a GPU. Second tell: the shared 512x512 RGBA8 buffers carry `CowData` refcount 2 in
  the seat (game Image + the dummy's duplicate) and 1 in the host.
- **`HeadlessTextureImageEvictor`** releases them. `Texture2D.GetImage()` in headless returns the dummy's own
  retained copy BY REFERENCE (`texture_2d_get` hands back `t->image`), so `SetData(1, 1, false, L8, [0])` drops
  that buffer. Measured A/B on a `--headless` instance at the main menu: **1127.4MB -> 969.6MB** (152 images,
  159.2MB released), and **945.0MB** with the Phase-1 allocator tuning on top.
- **Enumeration is `ResourceLoader.ListDirectory` over `res://` + `GetCachedRef` per path**, NOT an ObjectDB id
  sweep. A Godot instance id is `slot | validator << 24 | is_ref_counted << 63` (`core/object/object.h`), so ids
  are huge and sparse and every Resource has bit 63 set — walking ids upward from 1 finds nothing. `GetCachedRef`
  returns only already-loaded resources, so the sweep never pulls a texture off disk. 6,997 texture paths in the
  shipped pack; discovery runs once, sliced 512/tick.
- **Only VRAM-compressed formats are evicted, and widening to RGBA8 was MEASURED AND REJECTED (Aug-15).**
  `ImageTexture` is never evicted at any phase: the dummy's `texture_2d_update` is a no-op, so a runtime texture
  could not be restored, whereas a `CompressedTexture2D` is still on disk. The RGBA8 tier looked like another
  ~332MB and is really worth **at most ~55MB**, because `Image::_duplicate` does `data = p_image.data` — a
  `Vector` assignment, i.e. a **CowData reference share, not a byte copy** (`core/io/image.cpp:4268` ->
  `_copy_internals_from`, :3152). So a buffer at refcount 2 is ONE allocation the game and the dummy both point
  at: evicting the dummy's side drops it to 1, frees **zero bytes**, and leaves `GetImage()` answering 1x1
  forever. On a live seat the histogram was `{1: 577, 2: 216}` — the 216 are the 512x512 RGBA8 tier (217MB), and
  the host holds the same tier at refcount 1, proving it is game-side retention present with or without a
  renderer. Only the 577 single-owner images (~55MB, ~49MB of it RGBA8) are dead weight, and nothing available
  in C# can tell the two apart at eviction time — there is no CowData-refcount API — so a format-only widening
  would strip both. ~5% of a 1051MB seat for a permanent-1x1 fidelity risk: not taken.
- **Companion guard, not optional.** `CachedSpirectlAssetHttpAdapter` refuses to EXTRACT on a headless client
  (disk-or-503, code `asset-extraction-unavailable`, mapped to 503 not 404). Without it an evicted texture
  extracts as a 1x1 and the write-through persists it into the asset cache the host SHARES — one stray direct
  fetch would poison a real key for everyone, permanently.
- Kill-switches: `COUCHCOOP_HEADLESS_TEXTURE_EVICT=0` (off) / `probe` (census only, releases nothing) / `force`
  (run outside a seat — measurement lever ONLY; never point it at an instance serving `/res`).
  `COUCHCOOP_HEADLESS_MEM_TUNING=0` drops `MALLOC_ARENA_MAX=2` + `DOTNET_GCConserveMemory=5` from the seat env
  (`HeadlessClientManager.SeatMemoryTuningEnvironment`, applied only where the launcher's env is silent).
- **`scripts/headless-memory-census.py <pid>`** attributes a LIVE process from outside — no ptrace attach, no
  pause. `--regions` (allocator split), `--chunks` (glibc fragmentation), `--images` (the `Image` inventory
  above). It walks glibc chunk chains and matches `CowData` buffers to their owning `Image` struct; the layout
  facts it depends on are in its docstring. Needs the target to be ptrace-readable: yama is `ptrace_scope=1`
  here, and it works on a Steam-launched game because Sentry/crashpad sets `PR_SET_PTRACER_ANY`. An
  `sts2 game launch` instance is reparented to systemd and is NOT readable — use the in-process
  `[couchcoop][memory] rss_mb=` line (`COUCHCOOP_HEADLESS_PROFILE=1`) for those.
- Godot's `Performance.MEMORY_STATIC` reports **0.0** in the shipped release template (tracking is
  `DEBUG_ENABLED`-only). Do not build a memory claim on it; use `rss_mb` or the census script.
- **Where a tuned seat's RSS actually sits** (live pair, Aug-15; seat 1051MB / PSS 933MB, host 3527MB):
  `--regions` gave the seat 409MB glibc main heap (the retained `Image` pixels live here), 303MB CLR/other
  anonymous, 204MB file-backed (196MB of it `Shared_Clean` — shared with the host, not a per-seat cost), 115MB
  JIT, 17MB thread arenas. **The Phase-1 allocator tuning is confirmed live**: 5 arena mappings / 16.7MB in the
  seat vs 65 / 420.8MB in the untuned host, with `MALLOC_ARENA_MAX=2` + `DOTNET_GCConserveMemory=5` readable in
  the seat's `/proc/<pid>/environ` and absent from the host's. `--regions` runs WITHOUT sudo (maps/smaps/pagemap
  need only `PTRACE_MODE_READ`); `--chunks`/`--images` read `/proc/<pid>/mem`, need `PTRACE_MODE_ATTACH`, and
  under `ptrace_scope=1` that means sudo.
