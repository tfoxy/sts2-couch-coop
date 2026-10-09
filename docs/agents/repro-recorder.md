# The repro recorder — capture a mirror bug as a replayable file

**For the player:** turn one switch on, play until the bug happens, tap MARKER, tap SAVE, send us the file.

**For whoever gets the file:** `analyze-repro.mjs` says what the client sent and whether the game answered;
`replay-repro.mjs` puts the bug back on screen, on your machine, with no game and no phone.

## Why it exists

The mirror is a pure function of two inputs: the scene stream arriving over the websocket, and the viewer's own
pointer events. Both are timestamped on the same `performance.now()` origin. So a file carrying **both halves in
one ordered stream is deterministically replayable** — which is strictly better than a video, because a video
shows the symptom while this carries the cause.

---

## Recording (the player's half)

1. **Settings gear → "Repro recorder" → on.** A red **REC** pill appears at the top left. The setting is saved,
   so it survives reloads and reconnects — which matters, because a rare bug is found by playing, not by
   arranging to be recording at the right second.
2. **Play until the bug happens.** The recorder keeps a rolling window of roughly the **last 1–6 minutes** of
   combat in memory (32 MB). Nothing is uploaded, nothing is written to disk until you ask.
3. **Tap MARKER the moment you see it.** The pill flashes `marker 1 ✓`. Tap it again for a second occurrence —
   markers are numbered and the offline tools report each one separately. Marking *late* is fine (the tools look
   several seconds either side); marking is what makes the file usable at all.
4. **Tap SAVE.** The file downloads as `repro-<timestamp>.ndjson`. **Recording continues** — you can keep
   playing and save again.
5. Send us the file (or, on a phone, see the `adb` line below).

Two numbers on the pill: elapsed time, and how full the buffer is. Once it reads `100% ↺` the recorder is
dropping its oldest frames — normal, and exactly what a flight recorder does, but it means the file will start
mid-session. The header records how much was dropped, so nobody mistakes that for "the client did nothing".

### Getting the file off a phone

The download lands in the phone's Downloads folder. With the phone plugged in:

```bash
adb shell 'ls -t /sdcard/Download/repro-*.ndjson | head -1' | tr -d '\r' \
  | xargs -I{} adb pull {} .sts2/repro/
```

`.sts2/` is gitignored, so a recording dropped there can never be committed by accident. **Do not commit
recordings** — they are captured game payloads (see the Artifact Policy in `CLAUDE.md`).

### Desktop / console

Everything the pill does is also a function on `window`, so a devtools session needs no UI:

```js
__mirrorRepro.start();            // arm (the settings toggle does this)
__mirrorRepro.marker("card jumped");  // an optional note rides into the file
__mirrorRepro.save();             // → { name, bytes, lines }
__mirrorRepro.serialize();        // → the same ndjson as a string, no download (for automation)
__mirrorRepro.stats();            // { recording, lines, bytes, fill, droppedLines, markers, … }
__mirrorRepro.stop();
```

A headless harness (Playwright, CDP) cannot easily collect a download, so it takes the file with
`await page.evaluate(() => window.__mirrorRepro.serialize())` and writes the string itself. Recording continues
after either call.

### URL levers

| Param | Effect |
| --- | --- |
| `?repro=on` | arm for this session, whatever the saved setting says (and **even in a build that removed the switch** — see below) |
| `?repro=off` | disarm for this session; the saved setting is untouched |
| `?reproBufMb=64` | resize the ring for this session only (default 32; never persisted) |

---

## What is in the file

NDJSON, `format: "repro/1"`, written by `frontend/src/mirror/reproRecorder.ts`.

```
{"meta":{"format":"repro/1","recordedAt":…,"url":…,"ua":…,"moduleBundle":…,"viewport":{…},"dpr":…,
         "settings":{…},"designWidth":1920,"stageRect":{…},
         "bufCapBytes":…,"droppedLines":…,"droppedBytes":…,"markers":[…],"lines":…,"durationMs":…}}
{"t":0,"dir":"in","data":"<raw frame from the host, verbatim>"}
{"t":12.5,"dir":"out","data":"<raw frame this client sent>"}
{"t":16.3,"kind":"pointer","type":"down","x":1204,"y":900.5,"id":1,"pt":"touch","button":0,"buttons":1,"primary":true}
{"t":…,"kind":"wheel","x":…,"y":…,"dx":…,"dy":…,"mode":0}
{"t":…,"kind":"key","code":"KeyE","alt":false,"ctrl":false,"meta":false,"shift":false}
{"t":…,"kind":"marker","n":1,"note":"card jumped"}
{"t":…,"kind":"ws","ev":"open"}
{"t":…,"kind":"resize","w":…,"h":…,"dpr":…}
```

`t` is milliseconds since **the first line in the file** (3 decimals) — not since the recorder was armed, because
after a drop the armed instant is no longer in the file. Pointer `t` comes from the event's own `timeStamp`, so
it is immune to dispatch jitter.

`moduleBundle` is the URL/path of the `MirrorApp` module this browser actually executed. Include it when reporting
a replay mismatch: it distinguishes a stale emitted bundle or another worktree's dev server from a behaviour change
in the checkout used to replay the file.

**A repro file is also a valid passive recording.** Its `dir:"in"` lines are exactly what
`scripts/record-mirror-stream.mjs` writes, and every existing reader drops the rest, so you can feed one straight
to `scripts/replay-ws-server.mjs`, `scripts/bench-mirror-replay.mjs` or `frontend/bench/mirrorReplay.bench.ts`
with no conversion.

---

## Analysing it (no browser)

```bash
node scripts/analyze-repro.mjs .sts2/repro/repro-2026-08-27T09-12-00-000Z.ndjson
node scripts/analyze-repro.mjs <file> --window 8        # ±8s around each marker (default 5)
node scripts/analyze-repro.mjs <file> --marker 2        # one marker
node scripts/analyze-repro.mjs <file> --json out.json   # the same content, structurally
node scripts/analyze-repro.mjs --self-test              # synthetic recording + assertions
```

Per marker it prints three things, meant to be read against each other:

* **pointer** — the raw gesture, with move runs coalesced (`move x14 (1210,880) → (1290,905) over 233ms`), timed
  relative to the marker so "what was I doing just before I tapped" is the first thing you see.
* **sent** — every envelope this client sent, correlated with its reply by `requestId`, or — for an `input`,
  which is never answered by an id — with the frame that followed it. **A send the wire produced nothing after is
  flagged `⚠ UNANSWERED`.**
* **hand** — per `NHandCardHolder`: translation-Y and z-index over time, the fan's order and membership, which
  holder is on top (the mirror expresses card focus as a z-lift, so that *is* the focus timeline), and the
  declarative tween endpoints that armed each motion.

The scene tree is the mirror's own (`frontend/src/mirror/sceneTree.ts`, loaded through
`scripts/lib/mirror-probe.mjs`), so it cannot drift from what the browser built. It also reads the existing
`.sts2/bench/*.ndjson` passive recordings — minus the input half, which they never had.

---

## Replaying it (a real browser, no game)

### Quickest path: a dev server with no asset server behind it

```bash
# in one terminal: a dev server serving THE CHECKOUT YOU ARE DEBUGGING
cd frontend && npx vite --port 5211 --strictPort

# in another
node scripts/replay-repro.mjs .sts2/repro/foo.ndjson --url http://127.0.0.1:5211/ \
     --around-markers 1000,1000,100 --speed 0.5
```

This is enough for the pose/divergence work the tool was built for (the recorded wire carries the scene; nothing
here needs a live `/res` tree). A run that also wants real card art, spines or a GPU-backed canvas stage needs the
full recipe below.

### Full offline recipe (asset server + dev server, private loopback ports)

Never use `5219`/`5220` — see the live-game ports they are reserved for. Pick a private pair instead (the
examples below use `5311`/`5312`):

```bash
# 1. serve /res from the recovered project + a read-only production asset-cache fallback, so card art and
#    spines resolve without extracting or touching the live game install. Match --asset-cache-root to the
#    INSTALLED game's version — ~/.local/share/SlayTheSpire2/couch-coop/cache/<version>/assets, where
#    <version> is release_info.json's "version" field in the Steam install directory; the cache dir's own
#    .cache-identity.json confirms the match (mainAssemblyHash).
node scripts/serve-res-root.mjs --port 5311 \
     --asset-cache-root ~/.local/share/SlayTheSpire2/couch-coop/cache/<version>/assets

# 2. a dev server whose /res proxy points at step 1 (COUCHCOOP_DEV_PROXY_TARGET, not a CLI flag)
cd frontend && COUCHCOOP_DEV_PROXY_TARGET=http://127.0.0.1:5311 npx vite --port 5312 --strictPort

# 3. replay against it
node scripts/replay-repro.mjs .sts2/repro/foo.ndjson \
     --url "http://127.0.0.1:5312/?stage=canvas&rustProducerReasons=1" \
     --gpu vulkan --speed 0.5
```

**Never `npm run build`** to serve this — its `outDir` is the installed mod's `frontend/` dir, so building
overwrites the live install with whatever is on this branch. `npx vite` (dev mode) is the only server this recipe
ever runs. Kill both processes when done; nothing here needs to outlive the replay.

It replaces `window.WebSocket` before any page script, feeds the recorded inbound frames at their recorded
offsets, and dispatches the recorded gestures over CDP **on the same clock**. It never builds and never launches
a game. The page is loaded with `repro=off` appended so a replay cannot recursively record itself.

A recording made before the viewer ever joined carries no `session` envelope at all (most do not — the recorder
is armed mid-session, not at page load), and the mirror's own envelope parser rejects a bare
`{"type":"session","directView":true}` outright (it requires `hostName`, `scrollAction`, `screen`, `players` —
`protocol/browserEnvelope.ts`). The replay synthesizes a complete one instead (`scripts/lib/replay-session.mjs`'s
`replaySession`, the same helper `bench-mirror-replay.mjs` uses), reusing the recording's own host/screen/asset
fields when it has a real session to reuse them from.

**It also applies the recording's OWN settings, automatically, before navigating.** `meta.settingsAtArm` (or
`meta.settings` on an older file — see "A stray early tap" below for why arm-time is preferred) is mapped onto
`?param=` query values `mirrorSettings.ts` already reads (`raiseHand`, `stretch`, `quality`, …; see
`applyRecordingSettings` in `scripts/lib/repro-replay.mjs` for the full table), with the handful of PERSISTED
settings that have no URL lever (`refreshRate`, `tweenReplay`) seeded into the settings storage key instead. An
explicit `--url` query always wins over anything the recording had. Printed as `applied recording settings: …` —
read it before trusting a run: a replay under framework DEFAULTS (`raiseHandCards: false`, in particular) is a
different client than the one that made the recording, not a neutral baseline. This is also why
`bySource.local.count` on the card-target repro went from 5-9 to the phone-matching ~43 once wired up.

| Flag | Effect |
| --- | --- |
| `--around-markers [pre,post,step]` | screenshots + per-holder computed transform/z-index into `.sts2/artifacts/repro/<stem>/marker-<n>/` (`samples.ndjson` alongside). Default `1000,1000,100`. |
| `--freeze <ms>` | pump the timeline to `<ms>` and stop; pair with `--keep` and `--headed` to poke around in devtools |
| `--speed <f>` | scale the one shared timeline. **Use `--speed 0.5` or lower with `--around-markers`** — see the lag note below |
| `--marker <n>`, `--out <dir>`, `--headed`, `--keep` | as they read |
| `--gpu <backend>` | real GPU via Chromium's `--use-angle=<backend>` (e.g. `vulkan`). Without it headless Chromium reports SwiftShader software rendering, dropping the quality tier to very-low. Use for any run whose numbers should mean something about GPU-backed rendering. |
| `--diag-out <file>` | dump `window.__mirrorRendererDiagnostics()` (incl. `backend: "rust"\|"pixi"` — gate any measured cell on this) plus CDP `Performance.getMetrics` `TaskDuration`/`ScriptDuration` deltas **converted to ms** (the CDP call itself reports seconds — the file's own field names say `Ms` so nothing downstream has to remember that), narrowed to `--window` if given. `mkdir -p`s the parent directory. |
| `--window <a>:<b>` | ms on the RECORDING clock; narrows the `--diag-out` Performance deltas to this span (default: the whole replay) |
| `--as-seat` | join as a seat instead of watching as a direct-view spectator — see below |
| `--pre-tap <x>,<y>` | one synthetic tap, dispatched BEFORE the recorded clock starts — see "A stray early tap and client-local UI state" below |

### Seat mode (`--as-seat`)

A **spectator** (the default) watches the host's own stream in place. A **seat** gets its own redirected
connection — the shape a real joined player has, including a second WebSocket (`openSeatView`,
`buildHeadlessMirrorWebSocketUrl`) and a host socket that goes quiet once the redirect lands
(`c.sendWatch(false)`). The difference matters for input: a spectator's touches are still dispatched and can
still produce a local-only cosmetic lift (the held-card raise), but **only a seat's touches are actually
authorized to send real `input` wire envelopes** — a spectator watching someone else's run is not a player.

`--as-seat` reaches that shape WITHOUT hand-simulating a `join`/`headlessMirrorPort` exchange (most recordings,
armed mid-session, carry none to replay in the first place):

1. it sets `?name=<recorded name>` on the replay URL (read off the recording's own `meta.url`, or `ReplaySeat`),
   which arms `MirrorApp.vue`'s `?name=` auto-join (`autoJoinSent` → `submitJoin`);
2. the host socket's connect-time session is built with a JOINABLE `screen.mirrorMode` (`"mp-run"`) so the
   auto-join guard (`isNonJoinableMirrorMode`) doesn't refuse it;
3. the page carries a `<meta name="couchcoop-synthetic-seat" content="<port>">` tag — the SAME seam
   `CouchCoopBrowserServer.cs`'s `SyntheticSeatPort` and `iphone-webkit/iphone-burst.e2e.spec.ts` already use to
   exercise "a seat socket opens, the host socket stays open and quiet" without a real headless game process.
   `submitJoin` reads it and jumps straight to `openSeatView(port)`.

The fake WebSocket then tells the two resulting sockets apart purely by port (the only thing that differs
between a seat URL and the host's — `classifySeatSocketUrl` in `scripts/lib/repro-replay.mjs`): the HOST socket
answers `ping`/`join` only and never carries the recorded stream; the SEAT socket fetches the recorded frames
(once, shared — not re-fetched per socket) and delivers them exactly as spectator mode's one socket would.

**A recording made AFTER this round also tags each wire/lifecycle line by which connection it came from** —
`reproRecorder.ts`'s `sock: "host"|"seat"` field (`mirrorClient.ts`'s own `diagnosticSocketRole`, so the tag can
never disagree with what the client already calls the connection). `--as-seat` routes by it when present — the
seat socket gets only `sock:"seat"` lines — and falls back to "everything on the seat socket" for an older,
untagged file (`partitionInboundBySock` in `scripts/lib/repro-replay.mjs`), which is what every recording still
on disk as of this writing is.

**Gotcha this round hit and fixed:** the host socket's `_start()` must not emit `"open"` in the SAME tick as the
WebSocket constructor — a real WebSocket's open is always asynchronous, and `connectMirrorClient` attaches its
`addEventListener("open", …)` as the very next statement AFTER `new WebSocket(…)` returns. Emitting synchronously
fires to zero listeners and the page sits on "Connecting…" forever. One `await Promise.resolve()` is enough.

### A stray early tap and client-local UI state

`panelOpen` (whether the settings panel is expanded) is **never restored across a page load** — the app resets
it to closed on every fresh navigation, by design (`mirrorSettings.ts`'s "momentary UI" comment). A recording
armed mid-session, though, carries whatever `panelOpen` the player's SAME tab had from earlier in that session —
information no recording can carry, because it was never on the wire. If that first touch in the file is a tap
that toggles the gear button, a fresh replay (always starting closed) can end up in the OPPOSITE state from the
device that made the recording, and every later touch meant for the stage lands on the now-open settings panel
instead — producing a replay that delivers the scene stream correctly but sends suspiciously few (or zero) real
`input` envelopes, with no error anywhere.

`--pre-tap <x>,<y>` is the fix for an OLDER recording: one tap dispatched before the recorded clock starts, to
put that local toggle into the state the recording's own first gesture assumes it is already in. It never
appears in the divergence report and never touches the wire. A recording made AFTER this round carries
`meta.settingsAtArm` — a settings snapshot taken the MOMENT the recorder armed (`reproRecorder.ts`'s `start()`),
not just the save-time one (`meta.settings`, kept for back-compat) — which the replay now reads first for
exactly this reason. `--pre-tap` stays for a file with no `settingsAtArm` (every recording predating this
change), or for a toggle the arm-time snapshot still cannot represent.

The run ALSO watches, permanently, for a touch landing outside `.mirror-stage` — the signature of this exact
problem (that element's listeners are the ONLY way a touch reaches `inputCapture.ts`, so anything landing
elsewhere can never produce a `send()` call no matter how correct the rest of the replay is) — and warns with a
count and the first few target ids, rather than the old silent "0 input sent". Diagnosing WHICH coordinate (if
any) still needs `--pre-tap`, for a file with no usable arm-time snapshot: that warning IS the diagnostic now;
see the memory `replay-repro-session-and-seat-gaps` for the worked example that found `(359.7, 11.9)` (the
settings gear button) on the card-target repro.

At the end it prints a **divergence report**: what the recorded client sent versus what the replayed client sent,
matched per envelope shape (`input/hover`, `input/click left`, …) nearest-in-time. `NOT RE-SENT` means this
checkout did not produce a send the recording has — which is the first residual bug's exact question.

### What is and is not deterministic

Read this before believing a *negative* result.

* **Same checkout.** The file carries the wire and the gestures, not the client. Replaying yesterday's recording
  against today's build is a comparison, not a reproduction.
* **Canned responses.** Client sends are swallowed; nothing answers them. A flow that waits on an answer is
  satisfied only because the *recorded* answer arrives at its own recorded offset. So a replay whose client sends
  something the recording did not drifts from that point on — which is what the divergence report is for.
* **±1 frame.** rAF phase, layout and process scheduling all wobble by about a frame. The bugs being chased are
  tens of frames wide.
* **Two different "lag" numbers — read the completion one.** `schedule lag max` is how late THIS PROCESS issued
  a dispatch call against its own due time; it is not the number that matters and reads ~0ms by construction.
  `completion lag max`/`p95` is how late the PAGE finished HANDLING each dispatch (the CDP call's own ack) —
  this is the one the <100ms spec target is measured against, and reporting only the schedule number used to
  make a run that was 5.9s late on the page read as a clean 0ms.
  **A smaller `--speed` does not fix a bad completion-lag number on its own** — it gives a genuinely slow page
  more wall-clock room per gesture, which can mask the finding rather than explain it; a page that is still slow
  after `--speed 0.5` is a real cost to report, not a harness artifact to tune away.
* **Dispatches PIPELINE — within one gesture, not just across gestures.** Every `Input.dispatch*Event` call is
  sent immediately, in recorded order, with NOTHING awaited in between (not even its own gesture's previous
  call) — a single CDP session delivers and HANDLES commands in SEND order, not ACK order, so this keeps
  down→moves→up (and a key's rawKeyDown→keyUp) correct with zero round trips blocking the next send. An earlier
  version serialized same-kind dispatches on a chained promise (waiting for call N's ACK before sending call
  N+1) specifically to protect that ordering, and that chain was ITSELF most of `completion lag max`: a dense
  touchmove stream (recorded <10ms apart) queued behind the 16-34ms-per-call round trip and the wait ramped
  the longer the chain stayed busy (measured via `REPRO_CHAIN_DIAG=1`: ~2ms at the start of a long drag, ~1.8s
  by a few seconds in) — a backlog signature, not page cost. Pipelining dropped `completion lag max` on the
  card-target repro from ~1.8-2.1s to 73-173ms (p95 24-42ms). Every run also prints a `pointer order check`
  (CDP-assigned pointerId → down-first/release-last/non-decreasing timestamp) confirming pipelining never
  reorders anything; `REPRO_CHAIN_DIAG=1` prints the same per-kind ramp-or-flat breakdown if this regresses.
* **Gestures recorded before the keyframe are skipped, not dispatched.** The wire pump has nothing to show
  until `seedAtMs` lands, even though — on a recording armed mid-session, the common case — the real device was
  already showing a loaded scene throughout; the keyframe here is the recorder's OWN resync, not a cold load.
  Dispatching such a gesture anyway used to land it on whatever pre-scene chrome happens to occupy that screen
  point. The run also WAITS for the renderer to report ready (`window.__mirrorRendererDiagnostics().ready`)
  before starting the gesture clock, for the same reason applied to the gestures right after the keyframe too —
  and reports how long that took (`scene ready <n>ms after go`). The divergence report's replayed timestamps are
  shifted back by that wait so "recorded t" and "replayed t" stay comparable; `completion lag max` is where the
  wait's cost is visible instead.
* **Captures (screenshots) are serial with input dispatch**, so a slow one can push gestures late against the
  stream; they YIELD instead — a still already past the next capture point is skipped rather than delaying the
  gestures behind it, so the artifact set degrades before the reproduction does. Reported as `capture lag max`
  and how many stills were skipped.
* **Hover/scene-ack CADENCE is not 1:1 with the recording even when every gesture lands correctly.** Both are
  coalesced to one send per rendered frame, so a replay whose effective fps differs even slightly from the
  recording device's produces a different COUNT of hover sends for the identical touchmove stream — some
  dropped (fewer frames than the original), some extra (more frames). `--speed 0.5` narrows this a lot (more
  wall-clock time per recorded ms ≈ closer to 1 send per recorded sample) but will not usually reach an exact
  match; only `input` (not `hover` specifically) is worth diffing per-envelope for this reason — see the existing
  comment on the divergence report.
* **Pointer ids are the browser's.** CDP assigns its own; what is preserved is the identity mapping (one recorded
  finger = one CDP touch point), not the recorded number.
* **Gestures are non-blocking across each other, but ordered within one.** A touch up/cancel's multi-touch
  release fallback (two CDP calls for one recorded line) and a key's `rawKeyDown`+`keyUp` never interleave with a
  LATER gesture of the same kind — each is queued onto a small per-kind chain (`"pointer"`, `"key"`) rather than
  fired bare, so Chromium never sees a wire order that violates its own multi-touch bookkeeping. Two different
  kinds (a touch and a key, say) still run fully concurrently.
* **`?stage=canvas` draws no per-node DOM**, so the pose samples are empty there. Screenshots still work. The
  shipping default is the DOM stage, which is what a player's recording will have used.

---

## Removing it from a published build

A developer tool in an end user's settings panel is a support question waiting to happen, and an end user who
turns it on pays memory for a file they will never send anyone. So the UI is behind a **build-time** flag:

```bash
VITE_REPRO_UI=off npm run build     # (NB: `npm run build` DEPLOYS — see the frontend README)
```

With that set:

* the settings row and the REC pill are compiled out (the flag is a module constant in
  `frontend/src/mirror/buildFlags.ts`, so the branches fold away);
* a **stale saved `reproRecorder: true` is ignored** at layering time — a viewer with no switch to find must not
  be left recording by a value they set on a previous build;
* `?repro=on` **still arms it**, and the badge renders on that path so there is a SAVE button to press. That is
  deliberate: it is the support escape hatch (walk a player through appending one query param, get a recording,
  no rebuild) and it cannot happen by accident.

Anything other than the literal string `off` (case-insensitive) leaves the tool in — a build script that writes
`VITE_REPRO_UI=0` has made a mistake, and the safe direction for a mistake is "the diagnostic is present".

---

## Where the pieces live

| Path | What |
| --- | --- |
| `frontend/src/mirror/reproRecorder.ts` | the recorder: ring buffer, taps, serialization, save |
| `frontend/src/mirror/buildFlags.ts` | `VITE_REPRO_UI` |
| `frontend/src/mirror/ReproBadge.vue` | the REC pill (browser-space, outside the stage, so its own taps are never recorded) |
| `frontend/src/mirror/mirrorClient.ts` | the wire taps (the socket instance's `send` is wrapped; incoming is tapped above the JSON.parse and above the watch gate) |
| `frontend/src/mirror/MirrorView.vue` | the stage tap (capture-phase, passive, ahead of `inputCapture`) |
| `frontend/src/mirror/MirrorApp.vue` | arming, the meta snapshot, `window.__mirrorRepro` |
| `scripts/analyze-repro.mjs` | the offline report (`--self-test`) |
| `scripts/replay-repro.mjs` | the browser replay (CLI, Playwright, the in-page fake WebSocket) |
| `scripts/lib/repro-replay.mjs` | the replay's browser-free logic: parsing, keyframe seeding, `--as-seat`'s session/socket-routing decisions — unit tested by `scripts/test-replay-repro-session.mjs` and `scripts/test-replay-repro-seat.mjs` |
| `scripts/lib/replay-session.mjs` | `replaySession` — synthesizes a complete, valid session envelope (shared with `bench-mirror-replay.mjs`) |
